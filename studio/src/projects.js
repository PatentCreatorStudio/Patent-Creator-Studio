// One folder per invention, plain files inside. The AI can write anywhere in
// that folder, so nothing the app trusts lives there: the folder holds only a
// marker (project.json with id and title). The app's own records (intake,
// step history, check results, fingerprints) live in the app's data folder,
// where no AI run can reach them.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LAYOUT } from './workflow.js';
import { writeInside } from './safe-write.js';

const MARKER = 'project.json';
let RECORDS_DIR = null;

export function init(recordsDir) {
  RECORDS_DIR = recordsDir;
  mkdirSync(RECORDS_DIR, { recursive: true });
}

function slug(s) {
  return String(s || 'invention').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'invention';
}

const recFile = (id) => path.join(RECORDS_DIR, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.json`);

function readRecord(id) {
  try {
    return JSON.parse(readFileSync(recFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function saveProject(p) {
  p.updatedAt = new Date().toISOString();
  writeFileSync(recFile(p.id), JSON.stringify(p, null, 2));
  // Never write through a link an AI run may have put in place of the marker.
  writeInside(p.folder, MARKER, JSON.stringify({ id: p.id, title: p.title, app: 'Patent Creator Studio', note: 'Manage this invention in Patent Creator Studio.' }, null, 2));
  return p;
}

// Every change to a record goes through here: read the latest copy, change it,
// write it, all in one go. Nothing holds a copy across a wait and writes it
// back over somebody else's change.
export function update(id, fn) {
  const p = readRecord(id);
  if (!p) throw new Error('The invention record was not found. Reopen the invention from the sidebar.');
  fn(p);
  return saveProject(p);
}

export function listProjects(workspace) {
  if (!existsSync(workspace)) return [];
  const out = [];
  for (const name of readdirSync(workspace)) {
    const dir = path.join(workspace, name);
    let marker;
    try {
      marker = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8'));
    } catch {
      continue;
    }
    if (!marker?.id) continue;
    let rec = readRecord(marker.id);
    if (!rec) {
      // A folder from elsewhere (copied in, or made by an older build): start a
      // clean record. Nothing from the folder is taken on trust.
      // The inventor's own answers (intake, dates) are carried over; step and
      // check history is not, because the folder is writable by AI runs.
      rec = { id: marker.id, title: marker.title || name, createdAt: marker.createdAt || new Date().toISOString(), intake: marker.intake || { title: marker.title || name }, dates: marker.dates, phases: {}, stamps: {}, folder: dir };
      saveProject(rec);
    } else if (rec.folder !== dir) {
      rec.folder = dir;
      saveProject(rec);
    }
    out.push(rec);
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function loadProject(id) {
  return readRecord(id);
}

export function createProject(workspace, intake) {
  mkdirSync(workspace, { recursive: true });
  const base = path.join(workspace, slug(intake.title));
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  mkdirSync(dir, { recursive: true });
  const p = { id: randomUUID(), title: intake.title || 'Untitled invention', createdAt: new Date().toISOString(), intake, phases: {}, stamps: {}, folder: dir };
  writeIntake(p);
  return saveProject(p);
}

export function writeIntake(p) {
  const i = p.intake;
  const lines = [
    `# ${i.title || 'Untitled invention'}`,
    '',
    '_Saved from your answers. Use Edit your answers in Patent Creator Studio to make changes._',
    '',
    "## In the inventor's words",
    '',
    i.description || '(not given)',
    '',
    '## The problem it solves',
    '',
    i.problem || '(not given)',
    '',
    '## How it works (what makes it different)',
    '',
    i.how || '(not given)',
    '',
    '## Inventors',
    '',
    ...(i.inventors?.length ? i.inventors.map((n) => `- ${n.name}${n.residence ? ` (${n.residence})` : ''}`) : ['- (not given)']),
    '',
    '## Files to read',
    '',
    ...(i.materials?.length ? i.materials.map((m) => `- ${m}`) : ['- (none added)']),
    '',
    '## Public disclosure and sales reported by the inventor',
    '',
    `- Shown, published, demoed, sold or offered for sale: ${i.disclosed || 'not answered'}`,
    i.disclosureNotes ? `- Details: ${i.disclosureNotes}` : '- Details: (none)',
    i.publicLinks ? `- Public links to check: ${i.publicLinks}` : '- Public links to check: (none given)',
    '',
    '## Filing goal',
    '',
    `- Target: ${i.target || 'US provisional application'}`,
    `- Filing fee category reported by the inventor: ${i.entity || 'not sure'}`,
    i.correspondence ? `- Mailing address: ${i.correspondence}` : '- Mailing address: (not given)',
    '',
    "## How the inventor developed the idea",
    '',
    i.conception || '(none yet)',
    '',
  ];
  writeInside(p.folder, LAYOUT.intake, lines.join('\n'));
}

// ---- safe paths ------------------------------------------------------------

// Resolves a path the screen asked for and refuses anything that leaves the
// invention folder, including through a symlink the AI may have planted.
export function safePath(p, rel) {
  const root = realpathSync(p.folder);
  const full = path.resolve(root, String(rel || ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('This file is outside the invention folder. Select a file inside it.');
  if (existsSync(full)) {
    const real = realpathSync(full);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('This file links outside the invention folder. Replace the link with a file copy.');
    return real;
  }
  return full;
}

export function readFile(p, rel) {
  const full = safePath(p, rel);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null;
}

export function listFiles(p) {
  const out = [];
  const walk = (d, rel = '') => {
    for (const name of readdirSync(d)) {
      if (name.startsWith('.') || (!rel && name === MARKER)) continue;
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, r);
      else out.push({ path: r, size: st.size, mtime: st.mtime.toISOString() });
    }
  };
  if (existsSync(p.folder)) walk(p.folder);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Run logs live in the app's data folder too, so a run cannot rewrite history.
export function runLogPath(p, phaseId, startedAt) {
  const d = path.join(RECORDS_DIR, 'runs', p.id);
  mkdirSync(d, { recursive: true });
  return path.join(d, `${phaseId}-${startedAt.replace(/[:.]/g, '-')}.jsonl`);
}

export function readRunLog(p, name) {
  const base = path.basename(String(name || ''));
  if (!/^[a-z]+-[0-9TZ-]+\.jsonl$/.test(base)) throw new Error('This run log could not be opened. Reopen the step.');
  const file = path.join(RECORDS_DIR, 'runs', p.id, base);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { kind: 'log', text: l };
      }
    });
}

export function appendRunLog(file, ev) {
  appendFileSync(file, JSON.stringify(ev) + '\n');
}

// ---- fingerprints ------------------------------------------------------------

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function fileHash(p, rel) {
  const full = path.join(p.folder, rel);
  try {
    if (lstatSync(full).isSymbolicLink()) return 'symlink';
    return sha(readFileSync(full));
  } catch {
    return null;
  }
}

// One fingerprint over a set of files and folders: every path and every byte.
// Adding, removing or editing any file inside changes it.
export function fingerprint(p, rels, { exclude = [] } = {}) {
  const entries = [];
  const add = (rel) => {
    if (exclude.includes(rel)) return;
    const full = path.join(p.folder, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      entries.push(`${rel}\0missing`);
      return;
    }
    if (st.isSymbolicLink()) entries.push(`${rel}\0symlink`);
    else if (st.isDirectory()) for (const n of readdirSync(full).sort()) add(`${rel}/${n}`);
    else entries.push(`${rel}\0${sha(readFileSync(full))}`);
  };
  rels.forEach(add);
  return sha(entries.join('\n'));
}

// Links inside the checked files would let content change behind an unchanged
// fingerprint, so any link there blocks readiness outright.
export function linksIn(p, rels) {
  const found = [];
  const walk = (rel) => {
    const full = path.join(p.folder, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) found.push(rel);
    else if (st.isDirectory()) for (const n of readdirSync(full)) walk(`${rel}/${n}`);
  };
  rels.forEach(walk);
  return found;
}

export const DRAFT_SET = [LAYOUT.claims, LAYOUT.spec, LAYOUT.abstract, LAYOUT.figures];
export const REVIEW_SET = [...DRAFT_SET, LAYOUT.packageDir];
