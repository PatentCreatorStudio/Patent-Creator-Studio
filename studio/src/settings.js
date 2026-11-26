// App settings live in plain JSON. API keys never do. On Windows and Linux they
// are encrypted with the operating system's key store (Electron safeStorage).
// On a Mac, while the app has no Apple Developer ID, the keychain treats every
// update as a new app and asks for the Mac password before it can read the keys
// again; so on a Mac keys live in a private file (owner read/write only, the way
// Codex keeps its login) and carry across updates with no prompt. Keys are read
// only at the moment one child process needs one.
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEY_NAMES = ['anthropic', 'openai', 'serpapi', 'epoKey', 'epoSecret', 'uspto'];

function dir() {
  const d = app.getPath('userData');
  mkdirSync(d, { recursive: true });
  return d;
}
const settingsFile = () => path.join(dir(), 'settings.json');
const keysFile = () => path.join(dir(), 'keys.bin.json'); // safeStorage-encrypted (Windows, Linux; old Mac builds)
const plainKeysFile = () => path.join(dir(), 'keys.json'); // Mac: private file, mode 600
const MAC = process.platform === 'darwin';

const DEFAULTS = {
  workspace: path.join(os.homedir(), 'Documents', 'Patent Studio'),
  draftEngine: 'claude-sub', // claude-sub | claude-key | codex-sub | codex-key
  reviewEngine: 'codex-sub', // the red team runs on a different mind by default
  claudeModel: 'opus',
  codexModel: '',
  codexEffort: 'high',
  patentCreatorPath: '',
  googleCloudProject: '',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// A missing file is empty; any other read or parse failure is an error, so a
// file that exists but can't be read is never mistaken for "no keys" and deleted.
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
}
// Write to a temporary file, then rename over the target, so a crash mid-write
// leaves the old file whole.
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
// Everyday reads stay forgiving so a damaged file shows as "no key" in Settings
// instead of breaking the screen; only migration treats a read failure as fatal.
function readKeys() {
  try {
    return readJson(MAC ? plainKeysFile() : keysFile());
  } catch {
    return {};
  }
}
const writeKeys = (k) => writeJsonAtomic(MAC ? plainKeysFile() : keysFile(), k);
// Mac keys that could not be moved (the person declined the password prompt).
// They are never retried, so the prompt never repeats; Settings asks for them to
// be pasted again, and saving or removing a key retires its old entry.
const declinedFile = () => path.join(dir(), 'keys.unmoved.json');

// Mac keys saved by builds before beta 12 are keychain-encrypted. Move them to
// the private file once. macOS may ask for the password this one last time.
export function migrateMacKeys() {
  if (!MAC) return { moved: 0, left: 0 };
  if (existsSync(plainKeysFile())) chmodSync(plainKeysFile(), 0o600);
  if (!existsSync(keysFile())) return { moved: 0, left: 0 };
  const old = readJson(keysFile());
  const plain = readJson(plainKeysFile());
  const declined = readJson(declinedFile());
  let moved = 0;
  for (const name of Object.keys(old)) {
    if (!KEY_NAMES.includes(name) || plain[name] || declined[name]) continue;
    try {
      plain[name] = safeStorage.decryptString(Buffer.from(old[name], 'base64'));
      moved++;
    } catch {
      declined[name] = old[name];
    }
  }
  if (moved) writeKeys(plain);
  if (Object.keys(declined).length) writeJsonAtomic(declinedFile(), declined);
  rmSync(keysFile(), { force: true });
  return { moved, left: Object.keys(declined).length };
}

function retireOldKey(name) {
  if (!MAC || !existsSync(declinedFile())) return;
  const declined = readJson(declinedFile());
  if (!(name in declined)) return;
  delete declined[name];
  if (Object.keys(declined).length) writeJsonAtomic(declinedFile(), declined);
  else rmSync(declinedFile(), { force: true });
}

export function keyStatus() {
  const k = readKeys();
  return {
    storage: MAC ? 'file' : 'keychain',
    encryptionAvailable: MAC ? true : safeStorage.isEncryptionAvailable(),
    unmigrated: MAC && existsSync(declinedFile()),
    anthropic: !!k.anthropic,
    openai: !!k.openai,
    serpapi: !!k.serpapi,
    epoKey: !!k.epoKey,
    epoSecret: !!k.epoSecret,
    uspto: !!k.uspto,
  };
}

export function setKey(name, value) {
  if (!KEY_NAMES.includes(name)) throw new Error(`Key type unavailable: ${name}. Use a key field in Settings.`);
  const k = readKeys();
  if (!value) delete k[name];
  else if (MAC) k[name] = value.trim();
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The key could not be saved because secure storage is unavailable. Check your computer’s key storage settings.');
    k[name] = safeStorage.encryptString(value.trim()).toString('base64');
  }
  writeKeys(k);
  retireOldKey(name);
  return keyStatus();
}

export function getKey(name) {
  const k = readKeys();
  if (!k[name]) return null;
  return MAC ? k[name] : safeStorage.decryptString(Buffer.from(k[name], 'base64'));
}

export function ensureWorkspace(settings) {
  if (!existsSync(settings.workspace)) mkdirSync(settings.workspace, { recursive: true });
  return settings.workspace;
}
