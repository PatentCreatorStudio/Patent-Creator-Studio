// App settings live in plain JSON. API keys never do: they are encrypted with the
// operating system keychain (Electron safeStorage) and decrypted only at the
// moment one child process needs one.
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEY_NAMES = ['anthropic', 'openai', 'serpapi', 'epoKey', 'epoSecret', 'uspto'];

function dir() {
  const d = app.getPath('userData');
  mkdirSync(d, { recursive: true });
  return d;
}
const settingsFile = () => path.join(dir(), 'settings.json');
const keysFile = () => path.join(dir(), 'keys.bin.json');

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

function readKeys() {
  try {
    return JSON.parse(readFileSync(keysFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function keyStatus() {
  const k = readKeys();
  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
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
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The key could not be saved because secure storage is unavailable. Check your computer’s keychain settings.');
  }
  const k = readKeys();
  if (!value) delete k[name];
  else k[name] = safeStorage.encryptString(value.trim()).toString('base64');
  writeFileSync(keysFile(), JSON.stringify(k), { mode: 0o600 });
  return keyStatus();
}

export function getKey(name) {
  const k = readKeys();
  if (!k[name]) return null;
  return safeStorage.decryptString(Buffer.from(k[name], 'base64'));
}

export function ensureWorkspace(settings) {
  if (!existsSync(settings.workspace)) mkdirSync(settings.workspace, { recursive: true });
  return settings.workspace;
}
