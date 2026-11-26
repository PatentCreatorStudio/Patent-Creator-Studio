import { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, appendFileSync, mkdirSync, lstatSync, renameSync } from 'node:fs';
import { detectAll, streamCommand, loginShellPath, childEnv, pyprojectVersion, compareVersions, processesRunningFrom, pythonToolsVersion, pythonVersion, pyprojectMinPython, toolsStatusReady, toolsPython } from './env.js';
import { loadSettings, saveSettings, keyStatus, setKey, getKey, ensureWorkspace, migrateMacKeys } from './settings.js';
import * as projects from './projects.js';
import { PHASES, SECOND_OPINION, phaseById, statusProtocol, questionsFile, parseStatus, parseDecision, LAYOUT } from './workflow.js';
import * as campaign from './campaign.js';
import { ENGINES, runEngine } from './engines.js';
import * as gates from './gates.js';
import { writeInside, removeInside } from './safe-write.js';
import { writeDocxCopies } from './docx-copies.js';
import { writeDrawingsPdf, DRAWINGS_PDF } from './drawings-pdf.js';
import { saveGitHistory } from './git-history.js';
import { saveMaterialText } from './material-text.js';
import * as installers from './installers.js';
import { createUpdater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The studio lives inside the Patent Creator repo; the skill, agents and plugin
// manifest are read from there. A packaged build carries them as resources.
const REPO_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'patent-creator') : path.resolve(here, '..', '..');
const PATENT_SEARCH_TOOLS = /^(?:mcp__[\w-]+__)?(?:search_epo_patents|search_patents_google|search_patents_bigquery|search_patents_by_(?:cpc|ipc)_bigquery)$/;
const SKILL_FILE = path.join(REPO_ROOT, 'skills', 'patent-application-creator', 'SKILL.md');
const INDEX_HTML = path.join(here, '..', 'ui', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

let win;
let envCache = null;
let updateCache = null;
let updateCheck = null;
let updateCheckedAt = 0;
let updateRelease = null;
let setupOperations = 0;
const loginRequests = new Map();
const updater = createUpdater({
  app,
  getRelease: async () => {
    const update = await checkUpdates(true);
    if (update.error) throw new Error(update.error);
    if (!update.newer || !updateRelease) throw new Error('There is no newer version to install.');
    return updateRelease;
  },
  isBusy: () => ops.size > 0 || fixRounds.size > 0,
  onProgress: (progress) => send('updates:progress', progress),
});

async function checkUpdates(force = false) {
  if (updateCheck) return updateCheck;
  if (!force && updateCache && Date.now() - updateCheckedAt < 60 * 60 * 1000) return updateCache;
  updateCheck = (async () => {
    try {
      const response = await fetch('https://api.github.com/repos/PatentCreatorStudio/Patent-Creator-Studio/releases?per_page=10', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Patent-Creator-Studio' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Could not check releases.');
      const releases = await response.json();
      const newest = releases.filter((r) => !r.draft && /^v?\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(r.tag_name))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
      const newer = !!newest && compareVersions(newest.tag_name, app.getVersion()) > 0;
      updateRelease = newer ? newest : null;
      updateCache = { newer, ...(newer ? { version: newest.tag_name.replace(/^v/, ''), url: newest.html_url } : {}) };
    } catch {
      updateCache = { ...updateCache, error: 'Could not check for a newer version.' };
    } finally {
      updateCheckedAt = Date.now();
    }
    return updateCache;
  })();
  try {
    return await updateCheck;
  } finally {
    updateCheck = null;
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// The version of the patent tools this app carries and installs. An installed
// copy older than this is updated from Setup before anything runs on it.
const BUNDLED_TOOLS_VERSION = pyprojectVersion(path.join(REPO_ROOT, 'pyproject.toml'));
const MIN_TOOLS_PYTHON = pyprojectMinPython(path.join(REPO_ROOT, 'pyproject.toml'));

async function env(force = false) {
  if (!envCache || force) envCache = await detectAll({ ...loadSettings(), bundledToolsVersion: BUNDLED_TOOLS_VERSION });
  return envCache;
}

function pcPath() {
  const t = envCache?.patentCreator;
  if (!t?.path) throw new Error('Patent tools are missing. Install them in Setup.');
  // Old tools would check the draft with old rules, so nothing runs on them.
  if (t.outdated) {
    throw new Error(
      t.canUpdate
        ? `The patent tools on this computer are out of date (${t.version || 'an older version'}; this app needs ${t.neededVersion}). Open Setup and select Update.`
        : `The patent tools on this computer are a development copy at ${t.version || 'an older version'}; this app needs ${t.neededVersion}. Update that copy, then select Check again in Setup.`
    );
  }
  return t.path;
}

// Search keys saved in the app reach the patent tools through the environment
// of the one process that runs them, never a file or a command line.
function searchEnv() {
  const out = {};
  for (const [name, envName] of Object.entries({ serpapi: 'SERPAPI_API_KEY', epoKey: 'EPO_OPS_KEY', epoSecret: 'EPO_OPS_SECRET', uspto: 'USPTO_API_KEY' })) {
    const value = getKey(name);
    if (value) out[envName] = value;
  }
  const project = loadSettings().googleCloudProject;
  if (project) out.GOOGLE_CLOUD_PROJECT = project;
  return out;
}

function syncGateEnv() {
  gates.setExtraEnv(searchEnv());
}

function skillText() {
  if (!existsSync(SKILL_FILE)) throw new Error(`Campaign instructions are missing (${SKILL_FILE}). Reinstall Patent Creator Studio.`);
  return readFileSync(SKILL_FILE, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
}

function family(engine) {
  return ENGINES[engine]?.cli;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'Patent Creator Studio',
    backgroundColor: '#17181b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // On the first start after installing or updating, macOS checks the new
  // app and file reads stall meanwhile; seen live on a Mac, every load of the
  // app's page hung for about 100 seconds and a load already waiting never
  // recovered. So the window first shows a message that needs no file, then
  // keeps starting the real page load again every few seconds until one
  // finishes. It also reloads the page if its process ever dies.
  const waiting = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Patent Creator Studio</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#17181b;color:#e8e6e1;font:15px -apple-system,'Segoe UI',sans-serif"><div style="max-width:420px;text-align:center;line-height:1.5"><p style="font-size:18px;margin:0 0 8px">Opening Patent Creator Studio…</p><p style="margin:0;color:#9a9893">The first start after installing or updating can take a minute or two while your computer checks the app.</p></div>`)}`;
  let pageLoaded = false;
  const loadPage = () => win.loadFile(INDEX_HTML).catch(() => {});
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL().startsWith('file:')) pageLoaded = true;
  });
  win.webContents.on('render-process-gone', () => {
    pageLoaded = false;
    if (!win.isDestroyed()) loadPage();
  });
  const watchdog = setInterval(() => {
    if (pageLoaded || win.isDestroyed()) return clearInterval(watchdog);
    loadPage();
  }, 6000);
  win.loadURL(waiting).catch(() => {}).finally(() => {
    if (!pageLoaded && !win.isDestroyed()) loadPage();
  });
  // The window only ever shows the app's own page. Web links open in the
  // browser; anything else (a file the AI wrote, for instance) is refused, so
  // no document but ours can reach the app's bridge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.split('#')[0] === INDEX_URL) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  // Right-click: Copy for selected text anywhere, and Cut/Paste in text boxes.
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText.trim()) items.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    else items.push({ role: 'selectAll' });
    if (p.linkURL && /^https?:\/\//.test(p.linkURL)) items.unshift({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function view(p) {
  const fresh = projects.loadProject(p.id) || p;
  const op = ops.get(fresh.id);
  const steps = campaign.evaluate(fresh, op?.phaseId || null);
  return {
    ...fresh,
    steps,
    next: campaign.nextStep(fresh, steps),
    readiness: campaign.readiness(fresh, steps),
    files: projects.listFiles(fresh),
    // What is happening for this invention right now, if anything.
    running: op?.phaseId || null,
    busy: op ? { phaseId: op.phaseId, stage: op.stage } : null,
    fixing: fixRounds.get(fresh.id)?.status || null,
  };
}

function findProject(id) {
  const s = loadSettings();
  const p = projects.listProjects(s.workspace).find((x) => x.id === id);
  if (!p) throw new Error('The invention folder was not found. Check its location in Settings.');
  return p;
}

// ---- one owner per invention ---------------------------------------------
//
// From the first check before a step to the last check after it, exactly one
// operation owns an invention. Nothing else may run on it, and Stop always
// reaches whatever is running.

const ops = new Map(); // projectId -> { phaseId, stage, cancelled, stop }

function begin(projectId, phaseId, stage) {
  if (updater.isInstalling()) throw new Error('The app is updating. Wait for it to restart.');
  if (ops.has(projectId)) throw new Error('This invention is busy. Wait for the current work to finish.');
  const op = { phaseId, stage, cancelled: false, stop: null };
  ops.set(projectId, op);
  return op;
}
function setStage(projectId, op, stage) {
  op.stage = stage;
  send('project:changed', view({ id: projectId }));
}
function release(projectId) {
  ops.delete(projectId);
}

// The app's own checks, run on their own (the buttons under "The app's checks").
async function checksOnly(projectId, fn) {
  await env();
  findProject(projectId);
  begin(projectId, null, 'checks');
  try {
    await fn();
  } finally {
    release(projectId);
  }
  return view({ id: projectId });
}

// ---- running a step ------------------------------------------------------

// Told to every AI run: where its work goes. A save anywhere else is refused.
function folderRule(folder) {
  return `The invention folder is ${folder} and it is your working directory. Save every file inside it, using paths relative to it exactly as given (for example ${LAYOUT.sweep}). Never rewrite or shorten the folder path. A save outside this folder is refused.`;
}

// What an AI tool reports when the internet, not the work, failed. Only the
// tool's own failure output is matched, never the AI's prose.
const NET_DROP = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ENETDOWN|Can't reach the API|stream disconnected|error sending request|fetch failed|Connection error|socket hang up/i;
const MAX_DROP_RETRIES = 3;

// Resolves true once the AI service answers over HTTPS again (any reply
// counts; a name that merely resolves does not). Waits 20 seconds before each
// check, for up to an hour. Each check gives up after 10 seconds, so Stop ends
// the wait within about 10 seconds.
async function waitForNetwork(host, op, limitMs = 60 * 60 * 1000) {
  const until = Date.now() + limitMs;
  while (!op.cancelled && Date.now() < until) {
    for (let i = 0; i < 10 && !op.cancelled; i++) await new Promise((r) => setTimeout(r, 2000));
    if (op.cancelled) break;
    try {
      await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      return !op.cancelled;
    } catch {}
  }
  return false;
}

const fixRounds = new Map(); // projectId -> { cancelled, status }

// A fingerprint of everything a step can be judged against: the inventor's
// answers and dates, and every file the campaign stamps.
function filesNow(projectId) {
  const p = projects.loadProject(projectId);
  return JSON.stringify([campaign.basisNow(p), projects.fingerprint(p, projects.DRAFT_SET), projects.fingerprint(p, [LAYOUT.noGo, LAYOUT.packageDir])]);
}
const MAX_FIX_ROUNDS = 3;

// Starts a step and resolves with its final state once it has finished.
async function runAndWait(projectId, phaseId) {
  await runPhase(projectId, phaseId, { fromFixRound: true });
  while (ops.has(projectId)) await new Promise((r) => setTimeout(r, 3000));
  return projects.loadProject(projectId).phases?.[phaseId]?.state;
}

// One button for "the second AI found problems": steps 6, 7 and 8 again,
// round after round, until the review passes, a step needs the inventor,
// recommends stopping or fails, or MAX_FIX_ROUNDS rounds have run. While it
// runs, steps cannot be started by hand.
function startFixRound(projectId) {
  if (updater.isInstalling()) throw new Error('The app is updating. Wait for it to restart.');
  findProject(projectId);
  if (fixRounds.has(projectId) || ops.has(projectId)) throw new Error('This invention is busy. Wait for the current work to finish.');
  const fr = { cancelled: false, status: 'Starting the fix round…' };
  fixRounds.set(projectId, fr);
  fixRound(projectId, fr);
  return { started: true };
}

async function fixRound(projectId, fr) {
  const changed = () => send('project:changed', view({ id: projectId }));
  let outcome = '';
  try {
    for (let round = 1; round <= MAX_FIX_ROUNDS && !outcome; round++) {
      for (const phaseId of ['verify', 'package', 'redteam']) {
        if (fr.cancelled) {
          outcome = 'Fix round stopped.';
          break;
        }
        const ph = phaseById(phaseId);
        fr.status = `Fix round ${round} of up to ${MAX_FIX_ROUNDS}: step ${ph.n}, ${ph.title}.`;
        changed();
        const st = await runAndWait(projectId, phaseId);
        if (fr.cancelled) outcome = 'Fix round stopped.';
        else if (st === 'no-go') outcome = campaign.overruled(projects.loadProject(projectId).stamps?.decision)
          ? "Fix round stopped: the AI reports it can't finish the draft from your material. Read its summary."
          : 'Fix round finished: the app recommends not filing.';
        else if (st !== 'done' && st !== 'done-unconfirmed') outcome = st === 'needs-input' ? 'Fix round paused: a step needs your answers.' : 'Fix round stopped: a step did not finish. Read its summary.';
        if (outcome) break;
      }
      if (outcome) break;
      const r = view({ id: projectId }).readiness;
      if (r.level === 'review') outcome = 'Fix round finished: ready for professional review.';
      else if (!r.fixRound) outcome = 'Fix round finished. Read what is still open above.';
      else if (round === MAX_FIX_ROUNDS) outcome = `The second AI still found problems after ${MAX_FIX_ROUNDS} rounds. Read its reports, then select Fix and review again to keep going.`;
    }
  } catch (err) {
    outcome = `Fix round stopped: ${err.message}`;
  } finally {
    fixRounds.delete(projectId);
    send('run:event', { projectId, phaseId: 'redteam', ev: { kind: /ready|recommends/.test(outcome) ? 'gate' : 'warn', text: outcome } });
    changed();
  }
}

async function runPhase(projectId, phaseId, { engine: engineOverride, reply, fresh, fromFixRound } = {}) {
  const settings = loadSettings();
  const e = await env();
  if (fromFixRound && fixRounds.get(projectId)?.cancelled) throw new Error('Fix round stopped.');
  const p = findProject(projectId);
  const phase = phaseById(phaseId);
  if (!phase) throw new Error('This step is unavailable. Reopen the invention.');
  if (ops.has(projectId)) throw new Error('This invention is busy. Wait for the current work to finish.');
  if (fixRounds.has(projectId) && !fromFixRound) throw new Error('A fix round is running. Stop it first.');

  const step = campaign.evaluate(p)[phaseId];
  if (step.locked) throw new Error(step.locked);

  const prev = p.phases?.[phaseId];
  // A reply to a second opinion belongs to the AI that made the first
  // recommendation, even if the screen's engine selection has changed.
  let decisionReview = phaseId === 'decision' && reply ? prev?.decisionReview : null;
  const firstEngine = decisionReview?.firstEngine;
  const retryRequested = decisionReview?.verdict === 'unavailable' && /^(?:ready|retry|try again|it['’]s ready)[.!]?$/i.test(reply.trim());
  const reviewCurrent = decisionReviewCurrent(p, decisionReview);
  const retrySecondOpinion = retryRequested && reviewCurrent && parseDecision(projects.readFile(p, LAYOUT.decision)) === 'GO' && !projects.linksIn(p, ['03-decision']).length;
  if (decisionReview && !reviewCurrent && !retryRequested) {
    throw new Error('The facts or decision reports changed while step 3 was waiting. Select Run again for a new recommendation and second opinion.');
  }
  if (retryRequested && !retrySecondOpinion) decisionReview = null;
  const engine = firstEngine || engineOverride || defaultEngine(p, phase, settings);
  const def = ENGINES[engine];
  if (!def) throw new Error('This AI choice is unavailable. Choose an AI in Settings.');
  const cliPath = e[def.cli]?.path;
  const name = (fam) => (fam === 'claude' ? 'Claude' : 'Codex');
  if (!cliPath && !retrySecondOpinion) throw new Error(`${def.cli === 'claude' ? 'Claude Code' : 'Codex'} is missing. Install it in Setup.`);
  // One AI writes the whole draft; the other attacks it. The first run of
  // step 4 picks the writer for good: once an AI has written any of a draft,
  // the app can no longer show that every word of it was replaced, so that AI
  // can never be this invention's independent attacker.
  if (phase.writes === 'draft' && p.writer && family(engine) !== p.writer) {
    throw new Error(`This draft uses ${name(p.writer)}. Select ${name(p.writer)} for steps 4 to 7.`);
  }
  if (phase.role === 'review' && family(engine) === p.writer) {
    throw new Error(`${name(p.writer)} wrote this draft. Select ${name(p.writer === 'claude' ? 'codex' : 'claude')} for the second AI review.`);
  }
  const key = def.key ? getKey(def.key) : null;
  const pc = pcPath();

  const startedAt = new Date().toISOString();
  const logFile = projects.runLogPath(p, phaseId, startedAt);
  const run = { at: startedAt, engine, log: path.basename(logFile), reply: !!reply };
  // A reply continues the same search, so it starts from what the run it
  // continues had already found. A fresh start begins again from zero. Kept
  // on the running record so a run the app closed on still carries it.
  if (phaseId === 'sweep') Object.assign(run, { patentSearches: reply && !fresh ? prev?.runs?.at(-1)?.patentSearches || 0 : 0, fresh: !!fresh });
  const op = begin(projectId, phaseId, 'checks-before'); // nothing awaited since the ops.has check above
  // What this run starts from. The stamp it leaves is held to these, so an
  // answer changed or an earlier step rerun while it works shows as out of date.
  op.basis = campaign.basisNow(p);
  op.decisionReview = decisionReview || null;
  if (decisionReview && /^continue[.!]?$/i.test(reply.trim())) op.decisionReview.continuedByInventor = true;
  // An earlier no-go report is moved aside (kept, renamed), so the only
  // report that can stand for this run is one this run writes.
  if (phaseId === 'verify' && !reply) {
    const noGoPath = path.join(p.folder, LAYOUT.noGo);
    try {
      if (lstatSync(noGoPath).isFile()) renameSync(noGoPath, path.join(p.folder, LAYOUT.noGo.replace(/\.md$/, `-earlier-${Date.now()}.md`)));
      else removeInside(p.folder, LAYOUT.noGo);
    } catch {}
  }
  op.afterAt = phase.after ? p.stamps?.[phase.after]?.at ?? null : null;
  projects.update(projectId, (rec) => {
    // A new run replaces the step's earlier result, whatever happens next.
    if (rec.stamps) delete rec.stamps[phaseId];
    else rec.stamps = {};
    if (phaseId === 'claims' && !rec.writer) rec.writer = family(engine);
    rec.phases = { ...(rec.phases || {}), [phaseId]: { ...(prev || {}), ...(phaseId === 'decision' ? { decisionReview: op.decisionReview } : {}), state: 'running', current: run } };
  });
  send('project:changed', view(p));

  execute({ op, projectId, phase, engine, cliPath, key, pc, settings, reply, fresh, prev, run, logFile, retrySecondOpinion }).catch((err) => {
    send('run:event', { projectId, phaseId, ev: { kind: 'error', text: `The app could not finish: ${err.message}. Restart the app before trying again.` } });
  });
  return { started: true, engine };
}

function decisionReviewCurrent(p, review) {
  return !!review && review.afterAt === p.stamps?.sweep?.at
    && JSON.stringify(review.basis) === JSON.stringify(campaign.basisNow(p))
    && review.decisionHash === projects.fileHash(p, LAYOUT.decision)
    && (!review.hash || review.hash === projects.fileHash(p, LAYOUT.secondOpinion));
}

function otherEngine(fam, preferred) {
  const other = fam === 'claude' ? 'codex' : 'claude';
  const usable = (engine) => {
    const def = ENGINES[engine];
    return def && envCache?.[def.cli]?.installed && (def.key ? !!getKey(def.key) : envCache?.[def.cli]?.loggedIn);
  };
  if (family(preferred) === other && usable(preferred)) return preferred;
  return usable(`${other}-sub`) ? `${other}-sub` : usable(`${other}-key`) ? `${other}-key` : `${other}-sub`;
}

function defaultEngine(p, phase, settings) {
  const other = (fam) => otherEngine(fam, settings.reviewEngine);
  const same = (fam) => otherEngine(fam === 'claude' ? 'codex' : 'claude');
  if (phase.role === 'review') return other(p.writer || (family(settings.reviewEngine) === 'claude' ? 'codex' : 'claude'));
  if (phase.writes === 'draft' && phase.id !== 'claims' && p.writer && family(settings.draftEngine) !== p.writer) return same(p.writer);
  return settings.draftEngine;
}

function decisionReplyTask(review, reply) {
  if (!review) return '';
  const stop = /^stop[.!]?$/i.test(reply.trim());
  return `\n\nThis is the inventor's reply to the step 3 second opinion. Read the latest answers in ${LAYOUT.answers}.
${review.verdict === 'DISAGREE' ? `Read ${LAYOUT.secondOpinion} and rewrite ${LAYOUT.decision}, weighing its independent searches and concerns against the inventor's answers. Do not edit or delete the second opinion. The app will not run that cross-check again for this reply.` : `The other AI was unavailable. An explicit "continue" reply accepts proceeding on one AI's recommendation; record that choice in ${LAYOUT.decision}. Otherwise the app will try to obtain the second opinion again if you recommend GO.`}
${stop ? `The inventor chose stop. Write DECISION: NO-GO in ${LAYOUT.decision} with the evidence and alternatives, then end with STATUS: no-go.` : 'Reapply the worth-it screen. If you still recommend GO after a disagreement, explain why and record the inventor\'s choice to proceed despite it. If more inventor evidence is needed, ask for it; do not assume it exists.'}`;
}

// This run shares the decision operation and Stop handle, but never shares
// the first AI's conversation. A failed process cannot supply an agreement.
async function secondOpinion({ op, projectId, p, engine: firstEngine, pc, settings, logFile, say }) {
  setStage(projectId, op, 'second-opinion');
  const available = await env(true);
  if (op.cancelled) throw new Error('Step stopped. Select Run again to restart.');
  const engine = otherEngine(family(firstEngine), settings.reviewEngine);
  const def = ENGINES[engine];
  const key = def.key ? getKey(def.key) : null;
  const context = { firstEngine, secondEngine: engine, basis: op.basis, afterAt: op.afterAt, continuedByInventor: op.decisionReview?.continuedByInventor === true };
  if (!available[def.cli]?.path || (def.key ? !key : !available[def.cli]?.loggedIn)) return { ...context, verdict: 'unavailable' };

  removeInside(p.folder, LAYOUT.secondOpinion);
  // Every report and draft file the campaign judges must stay as it was.
  // The only permitted change is the second opinion's own report.
  const protectedFiles = () => projects.fingerprint(p, [LAYOUT.intake, LAYOUT.audit, LAYOUT.candidates, LAYOUT.sweep, LAYOUT.decision, LAYOUT.answers, ...projects.DRAFT_SET, LAYOUT.verification, LAYOUT.noGo, LAYOUT.examiner, LAYOUT.packageReview, LAYOUT.packageDir]);
  const before = protectedFiles();
  let finalEv = null;
  let result;
  let failed = null;
  say('gate', `${def.cli === 'claude' ? 'Claude' : 'Codex'} is searching independently and checking whether filing is worth the money.`);
  try {
    const handle = runEngine({ engine, cliPath: available[def.cli].path, pcPath: pc, repoRoot: REPO_ROOT, appDataDir: app.getPath('userData'), cwd: p.folder, systemText: `${skillText()}\n\n${statusProtocol(SECOND_OPINION)}\n\n${folderRule(p.folder)}\n\nThis run is: ${SECOND_OPINION.skillPhase}.`, prompt: SECOND_OPINION.task, resumeId: null, settings, key, serverEnv: searchEnv(), readDirs: (p.intake?.materials || []).filter((m) => m && existsSync(m)) }, (ev) => {
      if (ev.kind === 'final') finalEv = ev;
      projects.appendRunLog(logFile, { t: Date.now(), stage: 'second-opinion', engine, ...ev });
      send('run:event', { projectId, phaseId: 'decision', ev });
    });
    op.stop = handle.stop;
    result = await handle.done;
  } catch (err) {
    say('error', err.message || 'The second AI stopped with an error.');
    failed = 'the review could not finish; read the run details';
  } finally {
    op.stop = null;
    if (protectedFiles() !== before) throw new Error('The second AI changed files outside its second-opinion report. Review the changed files and run step 3 again.');
  }
  if (op.cancelled) throw new Error('Step stopped during the second opinion. Select Run again to restart.');
  if (!failed && (result.signal || result.code !== 0)) failed = 'the review stopped with an error; read the run details';
  if (!failed && (!finalEv || finalEv.ok === false)) failed = 'the AI returned no completed result';
  if (!failed && parseStatus(finalEv.text).status !== 'done') failed = 'the AI did not confirm that its opinion was complete';
  if (failed) return { ...context, verdict: 'unavailable', failed };
  const firstLine = (projects.readFile(p, LAYOUT.secondOpinion) || '').split(/\r?\n/)[0];
  const verdict = firstLine === 'SECOND OPINION: AGREE' ? 'AGREE' : firstLine === 'SECOND OPINION: DISAGREE' ? 'DISAGREE' : null;
  if (!verdict || projects.linksIn(p, ['03-decision']).length) return { ...context, verdict: 'unavailable', failed: 'the AI did not save a valid second-opinion report' };
  return { ...context, verdict, hash: projects.fileHash(p, LAYOUT.secondOpinion), sessionId: result.sessionId, costUsd: finalEv.costUsd ?? null };
}

function secondOpinionQuestion(p, review) {
  const question = review.verdict === 'DISAGREE'
    ? `The two AIs disagree about whether filing is worth the money. Read ${LAYOUT.decision} and ${LAYOUT.secondOpinion}.\n\nReply "continue" to draft anyway, "stop" to end with a not-worth-filing result, or answer the concerns and evidence requested in the second opinion. The first AI will weigh your reply and rewrite its recommendation.`
    : review.failed
      ? `The second AI started but did not finish (${review.failed}). Check Setup or its usage limit, then reply "ready" to try it again, "continue" to proceed on one AI's recommendation, or "stop" to end with a not-worth-filing result.`
      : `A second AI is needed to check the recommendation before drafting. Open Setup to install or sign in to ${family(review.secondEngine) === 'claude' ? 'Claude' : 'Codex'}, or add its API key in Settings, then reply "ready" to try again. You may instead reply "continue" to proceed on one AI's recommendation, or "stop" to end with a not-worth-filing result.`;
  writeInside(p.folder, questionsFile('decision'), question + '\n');
  return question;
}

async function execute({ op, projectId, phase, engine, cliPath, key, pc, settings, reply, fresh, prev, run, logFile, retrySecondOpinion = false }) {
  const phaseId = phase.id;
  const say = (kind, text) => {
    const ev = { kind, text };
    projects.appendRunLog(logFile, { t: Date.now(), ...ev });
    send('run:event', { projectId, phaseId, ev });
  };
  let p = projects.loadProject(projectId);
  let finalEv = null;
  const toolErrors = [];
  const refusedWrites = [];
  // Step 2 counts only if a patent database answered at least one search.
  // Web pages are a first screen, never the search itself.
  const patentCalls = new Set();
  let patentSearches = run.patentSearches || 0;
  const countPatentSearch = (ev) => {
    if (ev.kind === 'tool' && PATENT_SEARCH_TOOLS.test(ev.name || '')) patentCalls.add(ev.id);
    if (ev.kind !== 'toolResult' || !patentCalls.delete(ev.id)) return;
    if (ev.ok !== false && !/"error"\s*:/.test(String(ev.text || '').slice(0, 300))) patentSearches++;
  };
  let drops = 0;
  let res = { code: retrySecondOpinion ? 0 : -1 };
  let searchReady = null;
  let resumeId = null;
  let appError = null;

  try {
    const qFile = questionsFile(phaseId);
    if (reply && !fresh) {
      // Save the answer before any check can stop the step. Keep a review
      // recovery question until its retry succeeds or replaces the question.
      const qs = projects.readFile(p, qFile) || prev?.runs?.[prev.runs.length - 1]?.summary || '';
      const entry = `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (step: ${phase.title})\n\n### Questions\n\n${qs.trim()}\n\n### The inventor's answers\n\n${reply.trim()}\n`;
      writeInside(p.folder, LAYOUT.answers, entry, { append: true });
      if (!retrySecondOpinion) removeInside(p.folder, qFile);
    }
    syncGateEnv();
    if (phase.gatesBefore) {
      say('gate', 'Running draft checks before the AI starts…');
      await recordDraftGates(projectId, () => op.cancelled);
      if (op.cancelled) throw Object.assign(new Error('Step stopped. Select Run again to restart.'), { stopped: true });
      say('gate', gateLine(projects.loadProject(projectId).gates.draft.summary));
    }
    if (phase.needsSearch) {
      const st = await gates.searchStatus(pc).catch((err) => ({ ready: false, error: err.message }));
      searchReady = !!st.ready;
      if (op.cancelled) throw Object.assign(new Error('Step stopped. Select Run again to restart.'), { stopped: true });
      if (!st.ready) throw new Error(`Patent search is off (${gates.searchReasons(st).join('; ')}). Add a Google Patents (SerpApi) key or free EPO keys in Settings, then run this step again.`);
      say('gate', `Patent search is on: ${st.sources.join(', ')}.`);
    }

    if (!retrySecondOpinion) {
      resumeId = reply && !fresh && (!prev?.decisionReview || op.decisionReview) && prev?.lastSession?.engine === engine ? prev.lastSession.sessionId : null;
      const replyTask = decisionReplyTask(op.decisionReview, reply);
      const prompt = (reply
        ? resumeId
          ? `The inventor answered your questions (also saved in ${LAYOUT.answers}):\n\n${reply}\n\nContinue the same phase. Remember the STATUS line at the end.`
          : `${phase.task}\n\nThe inventor has answered your earlier questions; the answers are in ${LAYOUT.answers} (latest at the bottom). Use them.`
        : phase.task) + replyTask;
      // A draft made against a NO-GO is the inventor's decision; the AI drafts
      // the strongest honest version and says so, without re-arguing it.
      // The recommendation belongs to whichever AI ran step 3; a different AI
      // reading it must not call it its own.
      const decidedBy = ENGINES[p.stamps?.decision?.engine]?.cli;
      const whose = (decidedBy
        ? `The step 3 recommendation was made by ${decidedBy === 'codex' ? 'Codex' : 'Claude'}.`
        : 'The AI that made the step 3 recommendation is not recorded; do not guess its identity.')
        + ' Refer to it as "the step 3 recommendation", not "my recommendation".';
      const against = phase.requiresGo && campaign.overruled(p.stamps?.decision)
        ? `\n\nThe inventor chose to file against the NO-GO recommendation in ${LAYOUT.decision} (recorded in ${LAYOUT.answers}). ${whose} That decision is theirs. Do not re-argue it or refuse the work. Build on the narrowest supported ground in ${LAYOUT.sweep} and ${LAYOUT.decision}, keep the claims honest about the prior art found, and where a report summarises the campaign, state plainly that it was drafted against the step 3 recommendation. The inventor has already accepted the worth-it risks: obviousness exposure, competitors working around the claims, infringement that is hard to detect, and cost. Never stop with STATUS: no-go for any of those. This overrides the skill's worth-it stop rules for this run. In drafting and fix steps, address findings as far as the inventor's material allows (add features already described in that material to the specification, narrow claims to them; never invent disclosure) and state the risk that remains. Step 7 still must not edit the working draft; step 8 reports findings and proposed fixes only, preserving honest MUST-FIX and FAIL verdicts for attacks that still land. A later step may stop with STATUS: no-go only when the draft cannot honestly be finished from the inventor's material even after supported fixes, for example when no claim can be supported. Ask about a blocking invention fact only the inventor can supply before treating the gap as a no-go. Explain any such stop in the step's summary and, for step 6, in ${LAYOUT.noGo}; explain the material gap and attempted fixes, not why filing is poor value.`
        : '';
      const systemText = `${skillText()}\n\n${statusProtocol(phase)}\n\n${folderRule(p.folder)}\n\nThis run is: ${phase.skillPhase}.${against}`;

      if (op.cancelled) throw Object.assign(new Error('Step stopped. Select Run again to restart.'), { stopped: true });
      const materials = (p.intake?.materials || []).filter((m) => m && existsSync(m));
      // History mining reads git history the app saves itself, so the AI needs
      // no shell for it (Claude Code has none on Windows).
      if (phaseId === 'mining') {
        for (const line of await saveGitHistory(p.folder, materials, LAYOUT.gitHistoryDir)) say('gate', line);
      }
      // PDF and Word material gets text copies every AI can read (Claude Code
      // needs Poppler for PDFs, which most Windows computers lack).
      for (const line of await saveMaterialText(p.folder, materials, LAYOUT.materialText, toolsPython(pc))) say('gate', line);
      // An internet drop is not the inventor's problem: the app keeps hold of
      // the step, waits for the connection, and continues the same
      // conversation (this attempt's own, never an older one).
      const freshPrompt = (reply ? `${phase.task}\n\nThe inventor has answered your earlier questions; the answers are in ${LAYOUT.answers} (latest at the bottom). Use them.` : phase.task) + replyTask;
      const host = family(engine) === 'claude' ? 'api.anthropic.com' : 'chatgpt.com';
      let promptNow = prompt;
      let resumeNow = resumeId;
      for (;;) {
        finalEv = null;
        toolErrors.length = 0;
        patentCalls.clear(); // tool ids restart with each process
        const handle = runEngine(
          { engine, cliPath, pcPath: pc, repoRoot: REPO_ROOT, appDataDir: app.getPath('userData'), cwd: p.folder, systemText, prompt: promptNow, resumeId: resumeNow, settings, key, serverEnv: searchEnv(), readDirs: materials },
          (ev) => {
            if (ev.kind === 'final') finalEv = ev;
            if (ev.kind === 'error') toolErrors.push(String(ev.text || '').slice(0, 2000));
            countPatentSearch(ev);
            if (ev.kind === 'toolResult' && ev.ok === false && /requested permissions to write/i.test(ev.text || '')) refusedWrites.push(String(ev.text).match(/write to (.+?), but/)?.[1] || '');
            projects.appendRunLog(logFile, { t: Date.now(), ...ev });
            send('run:event', { projectId, phaseId, ev });
          }
        );
        op.stop = handle.stop;
        setStage(projectId, op, 'ai');
        res = await handle.done;
        op.stop = null;
        const failed = res.code !== 0 || !finalEv || finalEv.ok === false;
        const failText = [finalEv && finalEv.ok === false ? finalEv.text : '', ...toolErrors].join('\n');
        if (!failed || op.cancelled || res.signal || !NET_DROP.test(failText)) break;
        if (drops >= MAX_DROP_RETRIES) {
          op.netFailed = true;
          break;
        }
        drops++;
        run.drops = drops;
        say('warn', 'The internet connection dropped. The step continues by itself when the connection is back.');
        setStage(projectId, op, 'waiting-network');
        const before = filesNow(projectId);
        if (!(await waitForNetwork(host, op))) {
          if (op.cancelled) break;
          op.netFailed = true;
          break;
        }
        // Work done before the drop judged the files as they were then. If they
        // changed while the app waited, it cannot be continued honestly.
        if (filesNow(projectId) !== before) throw new Error('Your files changed while the app waited for the internet. Run this step again.');
        say('gate', 'Connection is back. Continuing the step.');
        resumeNow = res.sessionId || null;
        promptNow = resumeNow ? 'The internet connection dropped and has come back. Continue the same phase from where you stopped. Check which files you already changed before redoing anything. Remember the STATUS line at the end.' : freshPrompt;
      }
    } else {
      say('gate', 'Retrying the second AI review of the saved filing recommendation.');
    }
    setStage(projectId, op, 'checks-after');
  } catch (err) {
    appError = err;
    if (!err.stopped) say('error', err.message);
  }

  // ---- what actually happened --------------------------------------------
  p = projects.loadProject(projectId);
  const st = retrySecondOpinion
    ? { status: 'done', reason: 'Retrying the second AI review of the saved filing recommendation.' }
    : finalEv ? parseStatus(finalEv.text) : { status: 'error', reason: 'The AI returned no result. Run this step again.' };
  let state = st.status;
  // The process's own exit wins over anything the AI wrote before it.
  if (appError) {
    state = 'error';
    st.reason = appError.message;
  } else if (res.code !== 0 || res.signal || op.cancelled || (finalEv && finalEv.ok === false)) {
    state = 'error';
    st.reason = op.netFailed && !op.cancelled ? 'The internet connection kept dropping. Select Run again when it is steady.' : res.signal || op.cancelled ? 'Step stopped. Select Run again to restart.' : finalEv && finalEv.ok === false ? `The AI reported an error (${finalEv.subtype || 'error'}). Read the run details.` : `The AI stopped with an error (code ${res.code}). Read the run details.`;
  } else {
    // The Word copies are the app's job, made from the Markdown copies the AI
    // assembled, before anything asks whether the package is complete.
    let docxError = null;
    if (phaseId === 'package') projects.update(projectId, (rec) => (delete rec.docx, delete rec.drawings));
    if (phaseId === 'package' && (st.status === 'done' || st.status === 'unknown')) {
      try {
        const made = await writeDocxCopies(p.folder, LAYOUT.filingDir);
        projects.update(projectId, (rec) => (rec.docx = made));
        p = projects.loadProject(projectId);
        say('gate', `Created Word copies: ${Object.keys(made).join(', ')}.`);
      } catch (err) {
        docxError = `Could not make the Word copies: ${err.message}${/EBUSY|EPERM/.test(err.code || '') ? ' Close the file if it is open in Word, then run this step again.' : ''}`;
        say('error', docxError);
      }
      if (!docxError) {
        try {
          const made = await writeDrawingsPdf(p.folder, LAYOUT.figures, LAYOUT.filingDir);
          projects.update(projectId, (rec) => (rec.drawings = made));
          p = projects.loadProject(projectId);
          say('gate', `Created ${DRAWINGS_PDF} from the drawings.`);
        } catch (err) {
          docxError = `Could not make the drawings PDF: ${err.message}${/EBUSY|EPERM/.test(err.code || '') ? ' Close the PDF if it is open, then run this step again.' : ''}`;
          say('error', docxError);
        }
      }
    }
    const gone = campaign.missingDeliverables(p, phase);
    if (docxError) {
      state = 'error';
      st.reason = docxError;
    }
    // A no-go needs its report, written by THIS run: an old one cannot stand in.
    // The app moved any earlier report aside when this run started, so a
    // report here was written by this run. Its hash is taken now, before the
    // checks that follow, and the stamp must match it.
    const noGoPath = path.join(p.folder, LAYOUT.noGo);
    let noGoReal = false;
    try {
      noGoReal = lstatSync(noGoPath).isFile();
    } catch {}
    if (state === 'no-go' && phaseId === 'verify') op.noGo = noGoReal ? projects.fingerprint(p, [LAYOUT.noGo]) : null;
    if (state === 'no-go' && phaseId === 'verify' && !noGoReal) {
      state = 'error';
      st.reason = `The AI recommended stopping but did not save its reasons (${LAYOUT.noGo}). Run step 6 again.`;
    }
    if (state === 'unknown') state = gone.length ? 'error' : 'done-unconfirmed';
    // A save the app refused because it pointed outside the invention folder
    // is the AI's mistake, not a setting the inventor can change.
    const outside = refusedWrites.filter((w) => w && !path.resolve(w).startsWith(path.resolve(p.folder) + path.sep));
    if (outside.length && state !== 'done' && state !== 'done-unconfirmed') {
      state = 'error';
      st.reason = 'The AI tried to save its work outside this invention\'s folder, which the app does not allow. Run this step again.';
    }
    if (phaseId === 'sweep' && (state === 'done' || state === 'done-unconfirmed') && !patentSearches) {
      state = 'error';
      st.reason = 'The search finished without a single working patent database search, so it cannot count. Run step 2 again.';
    }
    if ((state === 'done' || state === 'done-unconfirmed') && gone.length) {
      state = 'error';
      st.reason = `Required files or content are missing: ${gone.join('; ')}. Run this step again.`;
    }
    // "I need you" with no question written down is still a question: the
    // AI's own summary is shown as the thing to answer.
  }

  if (phaseId === 'decision') {
    try {
      if (op.decisionReview?.hash && (projects.linksIn(p, ['03-decision']).length || op.decisionReview.hash !== projects.fileHash(p, LAYOUT.secondOpinion))) throw new Error('The second opinion changed while the first AI reconsidered its recommendation. Run step 3 again.');
      const decision = parseDecision(projects.readFile(p, LAYOUT.decision));
      if (op.decisionReview && /^stop[.!]?$/i.test(reply.trim()) && state !== 'error' && (decision !== 'NO-GO' || !['done', 'no-go'].includes(state))) throw new Error('You chose to stop, but the AI did not write a completed NO-GO report. Run step 3 again.');
      if (state === 'done-unconfirmed' && decision === 'GO') throw new Error('The AI did not confirm its filing recommendation was complete. Run step 3 again before getting a second opinion.');
      if (state === 'done' && decision === 'GO') {
        if (op.decisionReview?.verdict === 'DISAGREE') {
          op.secondOpinion = 'DISAGREE-overridden';
          op.secondOpinionHash = op.decisionReview.hash;
        } else if (!retrySecondOpinion && op.decisionReview?.verdict === 'unavailable' && op.decisionReview.continuedByInventor) {
          op.secondOpinion = 'skipped-by-inventor';
        } else {
          op.decisionReview = await secondOpinion({ op, projectId, p, engine, pc, settings, logFile, say });
          if (op.decisionReview.verdict === 'AGREE') {
            op.secondOpinion = 'AGREE';
            op.secondOpinionHash = op.decisionReview.hash;
            say('gate', 'The second AI agrees with going ahead.');
            if (retrySecondOpinion) st.reason = 'The second AI agrees with going ahead.';
          } else {
            state = 'needs-input';
            st.reason = secondOpinionQuestion(p, op.decisionReview);
            say('warn', st.reason);
          }
        }
      }
      if (op.cancelled) throw new Error('Step stopped. Select Run again to restart.');
    } catch (err) {
      state = 'error';
      st.reason = err.message;
      say('error', err.message);
    }
  }

  const record = {
    ...run,
    endedAt: new Date().toISOString(),
    status: state,
    reason: st.reason,
    summary: finalEv ? summaryFrom(finalEv.text) : '',
    sessionId: res.sessionId,
    costUsd: finalEv?.costUsd ?? null,
    ms: Date.now() - Date.parse(run.at), // wall clock, including the app's own checks
    exitCode: res.code,
    ...(phaseId === 'sweep' ? { patentSearches } : {}),
    ...(phaseId === 'decision' ? { secondOpinion: op.secondOpinion || op.decisionReview?.verdict || null, secondOpinionEngine: op.decisionReview?.secondEngine, secondOpinionCostUsd: op.decisionReview?.costUsd ?? null } : {}),
  };
  const lostConversation = !op.netFailed && !drops && !!resumeId && state === 'error' && !finalEv && !res.signal && !op.cancelled && !appError;

  try {
    if (phase.gatesAfter && state !== 'error') {
      if (phaseId === 'verify') {
        say('gate', 'Running draft checks after the AI changes…');
        await recordDraftGates(projectId);
        say('gate', gateLine(projects.loadProject(projectId).gates.draft.summary));
      }
      if (phaseId === 'package') {
        // Packaging must not touch the draft. If it did not, the examiner
        // checks from step 6 still describe it and are left alone, so the
        // record the package README points at stays the current one.
        const now = projects.loadProject(projectId);
        const draftUntouched = now.gates?.draft?.fingerprint === projects.fingerprint(now, projects.DRAFT_SET);
        say('gate', draftUntouched ? 'Checking the assembled package…' : 'The draft changed during assembly. Rerunning draft checks, then checking the package…');
        if (!draftUntouched) await recordDraftGates(projectId);
        await recordPackageGate(projectId);
        const pg = projects.loadProject(projectId).gates.package;
        say(pg.error ? 'error' : 'gate', pg.error ? `Package check failed: ${pg.error}. Run step 7 again.` : pg.result?.summary || 'Package check finished.');
      }
    }
  } catch (err) {
    say('error', `Check failed: ${err.message}. Run this step again.`);
  }

  // Keep questions while waiting for answers, including the recovery
  // question when a second-opinion retry fails or is stopped.
  if (state !== 'needs-input' && !(retrySecondOpinion && state === 'error')) removeInside(p.folder, questionsFile(phaseId));

  projects.update(projectId, (rec) => {
    // A no-go report replaced while the checks ran is not the one judged.
    if (state === 'no-go' && phaseId === 'verify' && op.noGo !== projects.fingerprint(rec, [LAYOUT.noGo])) {
      state = 'error';
      record.status = 'error';
      record.reason = 'The no-go report changed after the AI finished. Run step 6 again.';
    }
    const ph = rec.phases?.[phaseId] || {};
    if (op.decisionReview && !(retrySecondOpinion && state === 'error')) op.decisionReview.decisionHash = projects.fileHash(rec, LAYOUT.decision);
    rec.phases = {
      ...(rec.phases || {}),
      [phaseId]: { ...ph, ...(phaseId === 'decision' ? { decisionReview: op.decisionReview } : {}), state, current: null, lastSession: res.sessionId ? { engine, sessionId: res.sessionId } : ph.lastSession, runs: [...(ph.runs || []), record].slice(-30) },
    };
    // The stamp is taken last, after the app's own checks, from the files as
    // they are at this moment.
    if (campaign.isFinished(state)) rec.stamps = { ...(rec.stamps || {}), [phaseId]: campaign.makeStamp(rec, phase, { state, engine, family: family(engine), at: record.endedAt, searchReady, basis: op.basis, afterAt: op.afterAt, secondOpinion: op.secondOpinion, secondOpinionHash: op.secondOpinionHash }) };
  });
  release(projectId);
  send('run:end', { projectId, phaseId, record });
  send('project:changed', view({ id: projectId }));

  // A conversation that cannot be picked up again (the AI tool lost it) is
  // not the inventor's problem: start the step fresh with their answers.
  if (lostConversation) {
    send('run:event', { projectId, phaseId, ev: { kind: 'warn', text: 'Could not resume the AI conversation. Restarting this step with your saved answers.' } });
    runPhase(projectId, phaseId, { engine, reply, fresh: true }).catch((err) => send('run:event', { projectId, phaseId, ev: { kind: 'error', text: err.message } }));
  }
}

async function recordDraftGates(projectId, stopped = () => false) {
  syncGateEnv();
  const p = projects.loadProject(projectId);
  // Fingerprint before and after: if the draft changed while it was being
  // checked, the result describes neither version and never counts.
  const fp = projects.fingerprint(p, projects.DRAFT_SET);
  const g = await gates.runDraftGates(pcPath(), p.folder, stopped);
  if (stopped()) return; // a stopped check is not a result
  g.fingerprint = fp === projects.fingerprint(p, projects.DRAFT_SET) ? fp : 'changed-during-check';
  projects.update(projectId, (rec) => (rec.gates = { ...(rec.gates || {}), draft: g }));
}

async function recordPackageGate(projectId) {
  syncGateEnv();
  const p = projects.loadProject(projectId);
  const fp = projects.fingerprint(p, [LAYOUT.packageDir]);
  const g = await gates.runPackageGate(pcPath(), p.folder);
  // Fingerprint taken before and after; a package that changed while being
  // checked is recorded as unmatched, so it never counts.
  g.fingerprint = fp === projects.fingerprint(p, [LAYOUT.packageDir]) ? fp : 'changed-during-check';
  projects.update(projectId, (rec) => (rec.gates = { ...(rec.gates || {}), package: g }));
}

function summaryFrom(text) {
  const lines = String(text || '').trim().split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\**STATUS:/i.test(l.trim()));
  const body = (idx >= 0 ? lines.slice(0, idx) : lines).join('\n').trim();
  const paras = body.split(/\n\s*\n/);
  return paras[paras.length - 1].slice(0, 1200);
}

function gateLine(s) {
  if (!s) return 'Checks finished.';
  const n = (v, err) => (err ? 'could not run' : v ?? 'no count');
  return `Draft checks: ${s.claimCount ?? '?'} claims · critical claim problems: ${n(s.claimsCritical, s.claimsError)} · claim references ${s.antecedentRan ? 'checked' : 'not checked'} · critical description problems: ${n(s.specCritical, s.specError)} · critical format problems: ${n(s.formalitiesCritical, s.formalitiesError)}`;
}

// ---- IPC -----------------------------------------------------------------

// Only the app's own page may call in.
function handle(channel, fn) {
  const setupWork = ['setup:install', 'setup:installTool', 'setup:login'].includes(channel);
  ipcMain.handle(channel, async (e, ...args) => {
    if (!e.senderFrame || e.senderFrame.url.split('#')[0] !== INDEX_URL) return { ok: false, error: 'This request came from outside the app. Open Patent Creator Studio to continue.' };
    if (setupWork && updater.isInstalling()) return { ok: false, error: 'The app is updating. Wait for it to restart.' };
    if (setupWork) setupOperations++;
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      if (setupWork) setupOperations--;
    }
  });
}

handle('env:get', (force) => env(force));
handle('updates:check', (force) => checkUpdates(!!force));
handle('updates:install', () => setupOperations
  ? { installed: false, reason: 'Finish setting up your tools before updating the app.' }
  : updater.install());
handle('settings:get', () => ({ ...loadSettings(), keys: keyStatus(), engines: ENGINES, repoRoot: REPO_ROOT }));
handle('settings:set', async (patch) => {
  const allowed = ['draftEngine', 'reviewEngine', 'claudeModel', 'codexModel', 'codexEffort', 'workspace', 'googleCloudProject'];
  const before = loadSettings();
  const saved = saveSettings(Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k))));
  if (saved.googleCloudProject !== before.googleCloudProject) await gates.disconnect();
  return saved;
});
handle('settings:setKey', async (name, value) => {
  const r = setKey(name, value);
  if (['serpapi', 'epoKey', 'epoSecret', 'uspto'].includes(name)) await gates.disconnect();
  return r;
});
handle('phases:list', () => PHASES);

handle('projects:list', () => {
  const s = loadSettings();
  ensureWorkspace(s);
  return projects.listProjects(s.workspace).map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt, readiness: campaign.readiness(p), running: ops.has(p.id) }));
});
handle('projects:create', (intake) => view(projects.createProject(ensureWorkspace(loadSettings()), intake)));
handle('projects:get', (id) => view(findProject(id)));
handle('projects:updateIntake', (id, intake) => {
  findProject(id);
  const p = projects.update(id, (rec) => {
    rec.intake = intake;
    rec.title = intake.title || rec.title;
  });
  projects.writeIntake(p);
  return view(p);
});
handle('projects:setDates', (id, dates) => {
  const p = findProject(id);
  const clean = {};
  for (const k of ['firstDisclosure', 'provisionalFiled']) if (k in dates) clean[k] = /^\d{4}-\d{2}-\d{2}$/.test(dates[k] || '') ? dates[k] : null;
  return view(projects.update(id, (rec) => (rec.dates = { ...(rec.dates || {}), ...clean })));
});
handle('projects:readFile', (id, rel) => projects.readFile(findProject(id), rel));
handle('projects:fileData', (id, rel) => {
  // Images are handed over as data, so the page never loads a file URL.
  const full = projects.safePath(findProject(id), rel);
  const ext = path.extname(full).slice(1).toLowerCase();
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
  if (!types[ext]) throw new Error('This file is not a supported image. Open it from the invention folder.');
  return `data:${types[ext]};base64,${readFileSync(full).toString('base64')}`;
});
handle('projects:openFolder', (id, rel) => {
  const p = findProject(id);
  if (!rel) return shell.openPath(p.folder);
  const full = projects.safePath(p, rel);
  // Show the file in Finder/Explorer rather than running it.
  shell.showItemInFolder(full);
  return '';
});
handle('projects:openFile', (id, rel) => {
  const full = projects.safePath(findProject(id), rel);
  if (!/\.(pdf|docx|md|txt|svg|png|jpe?g)$/i.test(full)) throw new Error('This file type cannot open here. Open it from the invention folder.');
  return shell.openPath(full);
});
handle('projects:runLog', (id, name) => projects.readRunLog(findProject(id), name));

handle('run:start', (id, phaseId, opts) => runPhase(id, phaseId, opts || {}));
handle('run:fixRound', (id) => startFixRound(id));
// File anyway: the inventor overrules a NO-GO at step 3. Kept on step 3's own
// record (a new step 3 result clears it) and written into the answers file.
handle('decision:overrule', (id) => {
  const p = findProject(id);
  if (ops.has(id) || fixRounds.has(id)) throw new Error('This invention is busy. Wait for the current work to finish.');
  const st = p.stamps?.decision;
  if (campaign.evaluate(p).decision.status !== 'no-go' || st?.decision !== 'NO-GO') throw new Error('File anyway is only for a step 3 result that recommends not filing.');
  const at = new Date().toISOString();
  writeInside(p.folder, LAYOUT.answers, `\n## ${at.slice(0, 16).replace('T', ' ')} (step: Is it worth filing?)\n\n### The inventor's decision\n\nThe AI recommended not filing (${LAYOUT.decision}). I have read its reasons and I choose to file anyway. This is my decision.\n`, { append: true });
  const updated = projects.update(id, (rec) => (rec.stamps.decision.overruledByInventor = { at, decisionHash: projects.fileHash(p, LAYOUT.decision) }));
  return view(updated);
});
handle('run:stop', (id) => {
  const fr = fixRounds.get(id);
  if (fr) fr.cancelled = true;
  const op = ops.get(id);
  if (!op) return !!fr;
  // Before the AI starts this stops the step from starting; while it runs it
  // ends the AI's process. The app's closing checks are short and finish.
  op.cancelled = true;
  op.stop?.();
  // The app's own checks are stopped by hanging up on the patent tools; the
  // check in flight fails at once and no further one starts.
  if (!['ai', 'second-opinion', 'waiting-network'].includes(op.stage)) gates.disconnect();
  return true;
});

handle('gates:draft', (id) => checksOnly(id, () => recordDraftGates(id)));
handle('gates:package', (id) => checksOnly(id, () => recordPackageGate(id)));
handle('gates:search', async () => {
  await env();
  syncGateEnv();
  return gates.searchStatus(pcPath());
});
handle('law:search', async (query) => {
  await env();
  syncGateEnv();
  return gates.callTool(pcPath(), 'search_patent_law', { query: String(query).slice(0, 500), top_k: 6 });
});

handle('setup:install', async () => {
  // Installs the patent-creator package this app carries, then runs its own
  // non-interactive setup (the rulebook index, which lives outside the
  // package folder and survives every reinstall). Python comes from uv
  // (downloaded into the app's own folder), so the computer's own Python, or
  // the lack of one, never matters.
  await loginShellPath();
  // The same home folder the tool detection reads, so install and detection agree.
  const home = os.homedir();
  const isWin = process.platform === 'win32';
  const log = (l) => send('setup:line', l);
  const bin = (venv, name) => path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? `${name}.exe` : name);
  const pyOk = async (py) => {
    const v = await pythonVersion(py);
    return !!v && (!MIN_TOOLS_PYTHON || compareVersions(v, MIN_TOOLS_PYTHON) >= 0);
  };

  // 1. Never replace a developer's linked (editable) copy. An old one is
  //    theirs to update; a current one only gets its rulebook prepared.
  const found = (await env(true)).patentCreator;
  if (found?.editable && found.outdated) throw new Error('These patent tools are a development copy linked to a source folder. Update that folder instead.');

  // 2. Where to install. The copy the app found is updated where it is when
  //    it sits in a virtual environment the app can identify and its Python
  //    is new enough for the version being installed. Anything else (a system
  //    or pipx install, a stale saved path, a Python too old) gets the app's
  //    usual folder instead, and the app switches to that copy.
  let venv;
  let vpy;
  let pc;
  let target = null; // what is installed at the chosen place, if anything
  if (found?.installed && found.inPlace && (await pyOk(found.python))) {
    vpy = found.python;
    venv = path.dirname(path.dirname(vpy));
    pc = found.path;
    target = found;
  } else {
    venv = path.join(home, 'patent-creator-venv');
    vpy = bin(venv, 'python');
    pc = bin(venv, 'patent-creator');
    if (existsSync(vpy)) target = await pythonToolsVersion(vpy);
    if (target?.editable && compareVersions(target.version, BUNDLED_TOOLS_VERSION) < 0) {
      throw new Error(`The patent tools in ${venv} are a development copy linked to a source folder. Update that folder instead.`);
    }
  }
  // The usual folder is rebuilt with a current Python when the one there is
  // too old for this version (installs from before August 2026 allowed 3.9).
  const rebuildPython = existsSync(vpy) && !target?.editable && !(await pyOk(vpy));
  if (rebuildPython && vpy !== bin(venv, 'python')) throw new Error('The patent tools folder has a Python that is too old. Select Install again.');

  // 3. Nothing may be running on the tools while they are replaced.
  if (ops.size || fixRounds.size) throw new Error('A step is running. Let it finish or stop it, then update the patent tools.');
  // The app's own checks hold the tools open; close them first.
  await gates.disconnect();
  // Windows will not replace a program another window is running (another
  // Studio, or Claude Code using the tools), and a half-finished replacement
  // leaves a broken install, so the update waits until nothing runs from it.
  if (isWin && existsSync(venv)) {
    const running = await processesRunningFrom(venv);
    if (running?.length) {
      throw new Error(`The patent tools are open in another program (${running.length === 1 ? 'one program' : `${running.length} programs`}: another Patent Creator Studio window, or Claude Code). Close it, then select Update again.`);
    }
  }

  // 4. A copy that is current or newer, or any linked copy, is kept; only
  //    setup runs.
  // A missing launcher means the install is damaged, so it is reinstalled;
  // a linked copy is repaired from its own source folder, never replaced.
  if (target?.editable && !existsSync(pc)) throw new Error(`The development copy in ${venv} is missing its patent-creator command. Reinstall it from its source folder.`);
  const keepPackage = !rebuildPython && existsSync(pc) && !!(target?.version && (target.editable || compareVersions(target.version, BUNDLED_TOOLS_VERSION) >= 0));
  log('▸ Downloading the Python installer');
  const uv = await installers.ensureUv(path.join(app.getPath('userData'), 'tools'), log);
  const steps = [];
  if (!existsSync(vpy) || rebuildPython) steps.push([uv, ['venv', '--clear', '--python', '3.12', venv], rebuildPython ? 'Replacing the old Python in the patent tools folder (graphics card support downloads again, which can take several minutes)' : 'Installing Python in the patent tools folder']);
  // uv makes Python without pip, and setup uses pip to swap in the PyTorch
  // build for the graphics card; without it the rulebook builds on the CPU.
  steps.push([uv, ['pip', 'install', '--python', vpy, 'pip'], 'Preparing Python for graphics card support']);
  // --reinstall-package replaces an older copy even when pip would call it satisfied.
  if (!keepPackage) steps.push([uv, ['pip', 'install', '--python', vpy, '--reinstall-package', 'claude-patent-creator', REPO_ROOT], found?.outdated ? `Updating the patent tools to ${BUNDLED_TOOLS_VERSION} (a minute or two)` : 'Installing the patent tools (a minute or two)']);
  steps.push([pc, ['setup', '--non-interactive'], found?.ready ? 'Checking the patent rulebook search' : 'Preparing the patent rulebook search (5 to 45 minutes)']);
  for (const [cmd, args, label] of steps) {
    log(`▸ ${label}`);
    const r = await streamCommand(cmd, args, { onLine: log, env: childEnv() });
    if (r.ok) continue;
    // The tools' own setup ends by registering itself with Claude Code. This
    // app hands the tools to each AI on every run, so that last part is not
    // needed: what counts is that the rulebook index is built.
    // Asks the install just made, not whatever a saved path points at.
    if (args[0] === 'setup' && (await toolsStatusReady(pc))) {
      log('▸ Rulebook search is ready.');
      continue;
    }
    throw new Error(`${label} failed (code ${r.code}). Read the setup log for the cause.`);
  }
  // The tools' own setup ends with advice for people using them in a terminal
  // (restart Claude Code, install the plugin). This app connects them itself.
  log('▸ Done. Any steps above about Claude Code or a terminal are for people using the tools without this app. There is nothing more to do here.');
  // A saved path to some other copy would keep the app on that copy.
  const saved = loadSettings().patentCreatorPath;
  if (saved && path.resolve(saved) !== path.resolve(pc)) saveSettings({ patentCreatorPath: pc });
  envCache = null;
  return env(true);
});
handle('setup:installTool', async (name) => {
  if (!['claude', 'codex'].includes(name)) throw new Error('This tool is unavailable. Reopen Setup.');
  await installers.installTool(name, (l) => send('setup:line', l));
  envCache = null;
  const after = await env(true);
  if (!after[name]?.installed) throw new Error(`The installer finished, but ${name === 'claude' ? 'Claude Code' : 'Codex'} was not found. Read the setup log, then select Install again.`);
  return after;
});
handle('setup:login', async (name) => {
  if (!['claude', 'codex'].includes(name)) throw new Error('This tool is unavailable. Reopen Setup.');
  if (loginRequests.has(name)) throw new Error('Sign-in is already open. Finish it in your browser.');
  const request = { cancelled: false };
  loginRequests.set(name, request);
  try {
    const e = await env(true);
    if (request.cancelled) return { cancelled: true };
    const cli = e[name]?.path;
    if (!cli) throw new Error('The AI tool is missing. Install it in Setup.');
    const r = await installers.startLogin(name, cli, {
      onLine: (l) => send('setup:line', l),
      onUrl: (url) => {
        shell.openExternal(url);
        send('setup:login', { name, url, needsCode: name === 'claude' });
      },
    });
    if (request.cancelled || r.cancelled) return { cancelled: true };
    envCache = null;
    const after = await env(true);
    if (request.cancelled) return { cancelled: true };
    if (!after[name]?.loggedIn) throw new Error(r.ok ? 'Sign-in could not be confirmed. Select Sign in again.' : 'Sign-in did not finish. Select Sign in again.');
    return after;
  } catch (err) {
    if (request.cancelled) return { cancelled: true };
    throw err;
  } finally {
    loginRequests.delete(name);
    send('setup:login', { name, needsCode: false });
  }
});
handle('setup:cancelLogin', (name) => {
  if (!['claude', 'codex'].includes(name)) throw new Error('This tool is unavailable. Reopen Setup.');
  const request = loginRequests.get(name);
  if (request) request.cancelled = true;
  installers.cancelLogin(name);
});
handle('setup:loginCode', (name, code) => installers.sendLoginCode(name, code));
handle('shell:openExternal', (url) => /^https?:\/\//.test(url) && shell.openExternal(url));
handle('dialog:pickMaterial', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:pickWorkspace', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  try {
    migrateMacKeys();
  } catch {
    // Settings shows any keys that still need pasting again.
  }
  projects.init(path.join(app.getPath('userData'), 'records'));
  // A step that was running when the app last closed did not finish.
  try {
    for (const p of projects.listProjects(loadSettings().workspace)) {
      let changed = false;
      for (const [id, ph] of Object.entries(p.phases || {})) {
        if (ph.state === 'running') {
          p.phases[id] = { ...ph, state: 'error', current: null, runs: [...(ph.runs || []), { ...(ph.current || {}), endedAt: new Date().toISOString(), status: 'error', reason: 'The app closed before this step finished. Select Run again.' }] };
          changed = true;
        }
      }
      if (changed) projects.update(p.id, (rec) => (rec.phases = p.phases));
    }
  } catch {}
  // Show the window first. Reading the login shell's PATH can take seconds
  // (it runs the person's shell profile), and the window waited on it before.
  createWindow();
  await loginShellPath();
  env().catch(() => {});
  checkUpdates();
});
app.on('window-all-closed', async () => {
  for (const op of ops.values()) op.stop?.();
  installers.cancelLogins();
  await gates.disconnect();
  app.quit();
});
