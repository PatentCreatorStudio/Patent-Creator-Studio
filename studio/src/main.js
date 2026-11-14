import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, existsSync, appendFileSync, mkdirSync, lstatSync, renameSync } from 'node:fs';
import { detectAll, streamCommand, loginShellPath, childEnv } from './env.js';
import { loadSettings, saveSettings, keyStatus, setKey, getKey, ensureWorkspace } from './settings.js';
import * as projects from './projects.js';
import { PHASES, phaseById, statusProtocol, questionsFile, parseStatus, LAYOUT } from './workflow.js';
import * as campaign from './campaign.js';
import { ENGINES, runEngine } from './engines.js';
import * as gates from './gates.js';
import { writeInside, removeInside } from './safe-write.js';
import { writeDocxCopies } from './docx-copies.js';
import { writeDrawingsPdf, DRAWINGS_PDF } from './drawings-pdf.js';
import { saveGitHistory } from './git-history.js';
import * as installers from './installers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The studio lives inside the Patent Creator repo; the skill, agents and plugin
// manifest are read from there. A packaged build carries them as resources.
const REPO_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'patent-creator') : path.resolve(here, '..', '..');
const SKILL_FILE = path.join(REPO_ROOT, 'skills', 'patent-application-creator', 'SKILL.md');
const INDEX_HTML = path.join(here, '..', 'ui', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_HTML).href;

let win;
let envCache = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function env(force = false) {
  if (!envCache || force) envCache = await detectAll(loadSettings());
  return envCache;
}

function pcPath() {
  const p = envCache?.patentCreator?.path;
  if (!p) throw new Error('Patent tools are missing. Install them in Setup.');
  return p;
}

// Search keys saved in the app reach the patent tools through the environment
// of the one process that runs them, never a file or a command line.
function searchEnv() {
  const out = {};
  const serp = getKey('serpapi');
  if (serp) out.SERPAPI_API_KEY = serp;
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
    backgroundColor: '#f6f3ee',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(INDEX_HTML);
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

async function runPhase(projectId, phaseId, { engine: engineOverride, reply, fresh } = {}) {
  const settings = loadSettings();
  const e = await env();
  const p = findProject(projectId);
  const phase = phaseById(phaseId);
  if (!phase) throw new Error('This step is unavailable. Reopen the invention.');
  if (ops.has(projectId)) throw new Error('This invention is busy. Wait for the current work to finish.');

  const step = campaign.evaluate(p)[phaseId];
  if (step.locked) throw new Error(step.locked);

  const engine = engineOverride || defaultEngine(p, phase, settings);
  const def = ENGINES[engine];
  if (!def) throw new Error('This AI choice is unavailable. Choose an AI in Settings.');
  const cliPath = e[def.cli]?.path;
  const name = (fam) => (fam === 'claude' ? 'Claude' : 'Codex');
  if (!cliPath) throw new Error(`${def.cli === 'claude' ? 'Claude Code' : 'Codex'} is missing. Install it in Setup.`);
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

  const prev = p.phases?.[phaseId];
  const startedAt = new Date().toISOString();
  const logFile = projects.runLogPath(p, phaseId, startedAt);
  const run = { at: startedAt, engine, log: path.basename(logFile), reply: !!reply };
  const op = begin(projectId, phaseId, 'checks-before'); // nothing awaited since the ops.has check above
  // What this run starts from. The stamp it leaves is held to these, so an
  // answer changed or an earlier step rerun while it works shows as out of date.
  op.basis = campaign.basisNow(p);
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
    rec.phases = { ...(rec.phases || {}), [phaseId]: { ...(prev || {}), state: 'running', current: run } };
  });
  send('project:changed', view(p));

  execute({ op, projectId, phase, engine, cliPath, key, pc, settings, reply, fresh, prev, run, logFile }).catch((err) => {
    send('run:event', { projectId, phaseId, ev: { kind: 'error', text: `The app could not finish: ${err.message}. Restart the app before trying again.` } });
  });
  return { started: true, engine };
}

function defaultEngine(p, phase, settings) {
  const other = (fam) => (fam === 'claude' ? (getKey('openai') && !envCache?.codex?.loggedIn ? 'codex-key' : 'codex-sub') : getKey('anthropic') && !envCache?.claude?.loggedIn ? 'claude-key' : 'claude-sub');
  const same = (fam) => other(fam === 'claude' ? 'codex' : 'claude');
  if (phase.role === 'review') return p.writer && family(settings.reviewEngine) === p.writer ? other(p.writer) : settings.reviewEngine;
  if (phase.writes === 'draft' && phase.id !== 'claims' && p.writer && family(settings.draftEngine) !== p.writer) return same(p.writer);
  return settings.draftEngine;
}

async function execute({ op, projectId, phase, engine, cliPath, key, pc, settings, reply, fresh, prev, run, logFile }) {
  const phaseId = phase.id;
  const say = (kind, text) => {
    const ev = { kind, text };
    projects.appendRunLog(logFile, { t: Date.now(), ...ev });
    send('run:event', { projectId, phaseId, ev });
  };
  let p = projects.loadProject(projectId);
  let finalEv = null;
  let res = { code: -1 };
  let searchReady = null;
  let resumeId = null;
  let appError = null;

  try {
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
      say(st.ready ? 'gate' : 'warn', st.ready ? 'Patent search is on.' : 'Patent search is unavailable. Add a search key in Settings, then run step 2 again.');
    }

    const qFile = questionsFile(phaseId);
    if (reply && !fresh) {
      // Every answer the inventor gives is kept on disk, so later steps (and a
      // fresh run on a different AI) see it too. The answered questions are
      // filed with the answers and their own file is cleared by the app.
      const qs = projects.readFile(p, qFile) || prev?.runs?.[prev.runs.length - 1]?.summary || '';
      const entry = `\n## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (step: ${phase.title})\n\n### Questions\n\n${qs.trim()}\n\n### The inventor's answers\n\n${reply.trim()}\n`;
      writeInside(p.folder, LAYOUT.answers, entry, { append: true });
      removeInside(p.folder, qFile);
    }
    resumeId = reply && !fresh && prev?.lastSession?.engine === engine ? prev.lastSession.sessionId : null;
    const prompt = reply
      ? resumeId
        ? `The inventor answered your questions (also saved in ${LAYOUT.answers}):\n\n${reply}\n\nContinue the same phase. Remember the STATUS line at the end.`
        : `${phase.task}\n\nThe inventor has answered your earlier questions; the answers are in ${LAYOUT.answers} (latest at the bottom). Use them.`
      : phase.task;
    const systemText = `${skillText()}\n\n${statusProtocol(phase)}\n\nThis run is: ${phase.skillPhase}.`;

    if (op.cancelled) throw Object.assign(new Error('Step stopped. Select Run again to restart.'), { stopped: true });
    const materials = (p.intake?.materials || []).filter((m) => m && existsSync(m));
    // History mining reads git history the app saves itself, so the AI needs
    // no shell for it (Claude Code has none on Windows).
    if (phaseId === 'mining') {
      for (const line of await saveGitHistory(p.folder, materials, LAYOUT.gitHistoryDir)) say('gate', line);
    }
    const handle = runEngine(
      { engine, cliPath, pcPath: pc, repoRoot: REPO_ROOT, appDataDir: app.getPath('userData'), cwd: p.folder, systemText, prompt, resumeId, settings, key, serverEnv: searchEnv(), readDirs: materials },
      (ev) => {
        if (ev.kind === 'final') finalEv = ev;
        projects.appendRunLog(logFile, { t: Date.now(), ...ev });
        send('run:event', { projectId, phaseId, ev });
      }
    );
    op.stop = handle.stop;
    setStage(projectId, op, 'ai');
    res = await handle.done;
    op.stop = null;
    setStage(projectId, op, 'checks-after');
  } catch (err) {
    appError = err;
    if (!err.stopped) say('error', err.message);
  }

  // ---- what actually happened --------------------------------------------
  p = projects.loadProject(projectId);
  const st = finalEv ? parseStatus(finalEv.text) : { status: 'error', reason: 'The AI returned no result. Run this step again.' };
  let state = st.status;
  // The process's own exit wins over anything the AI wrote before it.
  if (appError) {
    state = 'error';
    st.reason = appError.message;
  } else if (res.code !== 0 || res.signal || op.cancelled || (finalEv && finalEv.ok === false)) {
    state = 'error';
    st.reason = res.signal || op.cancelled ? 'Step stopped. Select Run again to restart.' : finalEv && finalEv.ok === false ? `The AI reported an error (${finalEv.subtype || 'error'}). Read the run details.` : `The AI stopped with an error (code ${res.code}). Read the run details.`;
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
    if ((state === 'done' || state === 'done-unconfirmed') && gone.length) {
      state = 'error';
      st.reason = `Required files or content are missing: ${gone.join('; ')}. Run this step again.`;
    }
    // "I need you" with no question written down is still a question: the
    // AI's own summary is shown as the thing to answer.
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
  };
  const lostConversation = !!resumeId && state === 'error' && !finalEv && !res.signal && !op.cancelled && !appError;

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

  // A question file belongs to a step that is waiting. Once the step ends any
  // other way, a leftover one would only confuse.
  if (state !== 'needs-input') removeInside(p.folder, questionsFile(phaseId));

  projects.update(projectId, (rec) => {
    // A no-go report replaced while the checks ran is not the one judged.
    if (state === 'no-go' && phaseId === 'verify' && op.noGo !== projects.fingerprint(rec, [LAYOUT.noGo])) {
      state = 'error';
      record.status = 'error';
      record.reason = 'The no-go report changed after the AI finished. Run step 6 again.';
    }
    const ph = rec.phases?.[phaseId] || {};
    rec.phases = {
      ...(rec.phases || {}),
      [phaseId]: { ...ph, state, current: null, lastSession: res.sessionId ? { engine, sessionId: res.sessionId } : ph.lastSession, runs: [...(ph.runs || []), record].slice(-30) },
    };
    // The stamp is taken last, after the app's own checks, from the files as
    // they are at this moment.
    if (campaign.isFinished(state)) rec.stamps = { ...(rec.stamps || {}), [phaseId]: campaign.makeStamp(rec, phase, { state, engine, family: family(engine), at: record.endedAt, searchReady, basis: op.basis, afterAt: op.afterAt }) };
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
  ipcMain.handle(channel, async (e, ...args) => {
    if (!e.senderFrame || e.senderFrame.url.split('#')[0] !== INDEX_URL) return { ok: false, error: 'This request came from outside the app. Open Patent Creator Studio to continue.' };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

handle('env:get', (force) => env(force));
handle('settings:get', () => ({ ...loadSettings(), keys: keyStatus(), engines: ENGINES, repoRoot: REPO_ROOT }));
handle('settings:set', (patch) => {
  const allowed = ['draftEngine', 'reviewEngine', 'claudeModel', 'codexModel', 'codexEffort', 'workspace'];
  return saveSettings(Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k))));
});
handle('settings:setKey', (name, value) => {
  const r = setKey(name, value);
  if (name === 'serpapi') gates.disconnect();
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
handle('run:stop', (id) => {
  const op = ops.get(id);
  if (!op) return false;
  // Before the AI starts this stops the step from starting; while it runs it
  // ends the AI's process. The app's closing checks are short and finish.
  op.cancelled = true;
  op.stop?.();
  // The app's own checks are stopped by hanging up on the patent tools; the
  // check in flight fails at once and no further one starts.
  if (op.stage !== 'ai') gates.disconnect();
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
  // Installs the existing patent-creator package from this repo into the
  // README's venv, then runs its own non-interactive setup. Python comes from
  // uv (downloaded into the app's own folder), so the computer's own Python,
  // or the lack of one, never matters.
  await loginShellPath();
  const home = app.getPath('home');
  const venv = path.join(home, 'patent-creator-venv');
  const isWin = process.platform === 'win32';
  const log = (l) => send('setup:line', l);
  const vpy = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  const pc = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'patent-creator.exe' : 'patent-creator');
  log('▸ Downloading the Python installer');
  const uv = await installers.ensureUv(path.join(app.getPath('userData'), 'tools'), log);
  const steps = [];
  if (!existsSync(vpy)) steps.push([uv, ['venv', '--python', '3.12', venv], 'Installing Python in the patent tools folder']);
  // uv makes Python without pip, and setup uses pip to swap in the PyTorch
  // build for the graphics card; without it the rulebook builds on the CPU.
  steps.push([uv, ['pip', 'install', '--python', vpy, 'pip'], 'Preparing Python for graphics card support']);
  steps.push([uv, ['pip', 'install', '--python', vpy, REPO_ROOT], 'Installing the patent tools (a minute or two)']);
  steps.push([pc, ['setup', '--non-interactive'], 'Preparing the patent rulebook search (5 to 45 minutes)']);
  for (const [cmd, args, label] of steps) {
    log(`▸ ${label}`);
    const r = await streamCommand(cmd, args, { onLine: log, env: childEnv() });
    if (r.ok) continue;
    // The tools' own setup ends by registering itself with Claude Code. This
    // app hands the tools to each AI on every run, so that last part is not
    // needed: what counts is that the rulebook index is built.
    if (args[0] === 'setup') {
      envCache = null;
      const now = await env(true);
      if (now.patentCreator?.ready) {
        log('▸ Rulebook search is ready.');
        continue;
      }
    }
    throw new Error(`${label} failed (code ${r.code}). Read the setup log for the cause.`);
  }
  envCache = null;
  return env(true);
});
handle('setup:installTool', async (name) => {
  if (!['claude', 'codex'].includes(name)) throw new Error('This tool is unavailable. Reopen Setup.');
  await installers.installTool(name, (l) => send('setup:line', l));
  envCache = null;
  return env(true);
});
handle('setup:login', async (name) => {
  if (!['claude', 'codex'].includes(name)) throw new Error('This tool is unavailable. Reopen Setup.');
  const e = await env(true);
  const cli = e[name]?.path;
  if (!cli) throw new Error('The AI tool is missing. Install it in Setup.');
  const r = await installers.startLogin(name, cli, {
    onLine: (l) => send('setup:line', l),
    onUrl: (url) => {
      shell.openExternal(url);
      send('setup:login', { name, url, needsCode: name === 'claude' });
    },
  });
  envCache = null;
  const after = await env(true);
  if (!after[name]?.loggedIn) throw new Error(r.ok ? 'Sign-in could not be confirmed. Select Sign in again.' : 'Sign-in did not finish. Select Sign in again.');
  return after;
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
  await loginShellPath();
  createWindow();
  env().catch(() => {});
});
app.on('window-all-closed', async () => {
  for (const op of ops.values()) op.stop?.();
  installers.cancelLogins();
  await gates.disconnect();
  app.quit();
});
