// Puts the tools on a computer that has none of them, using each maker's own
// official installer, so nobody has to open a terminal. Every installer here
// installs into the person's home folder and needs no administrator rights.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { streamCommand, childEnv, launchable } from './env.js';

const IS_WIN = process.platform === 'win32';
const HOME = os.homedir();
export const LOCAL_BIN = path.join(HOME, '.local', 'bin');

const OFFICIAL = {
  claude: { label: 'Claude Code', sh: 'https://claude.ai/install.sh', shell: 'bash', ps: 'https://claude.ai/install.ps1' },
  codex: { label: 'Codex', sh: 'https://chatgpt.com/codex/install.sh', shell: 'sh', ps: 'https://chatgpt.com/codex/install.ps1' },
  uv: { label: 'the Python manager (uv)', sh: 'https://astral.sh/uv/install.sh', shell: 'sh', ps: 'https://astral.sh/uv/install.ps1' },
};

export async function runOfficialInstaller(name, { onLine, env = {} } = {}) {
  const o = OFFICIAL[name];
  const e = childEnv(env);
  // Windows PowerShell 5.1 runs the installer. If the app was started from a
  // PowerShell 7 window it inherits 7's module list and cannot load its own
  // security module; without the variable, 5.1 rebuilds its default list.
  if (IS_WIN) for (const k of Object.keys(e)) if (k.toLowerCase() === 'psmodulepath') delete e[k];
  if (IS_WIN) return streamCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; try { $s = irm '${o.ps}'; iex $s } catch { Write-Error $_; exit 1 }`], { onLine, env: e });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'patent-creator-install-'));
  const script = path.join(dir, 'install.sh');
  try {
    // Download first so a failed transfer cannot look like a finished install.
    const download = await streamCommand('curl', ['-fsSL', '-o', script, o.sh], { onLine, env: e });
    if (!download.ok) throw new Error(`Could not download the ${o.label} installer. Check your internet connection, then select Install again.`);
    return await streamCommand(o.shell, [script], { onLine, env: e });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function installTool(name, onLine) {
  const r = await runOfficialInstaller(name, { onLine });
  if (!r.ok) throw new Error(`Installing ${OFFICIAL[name].label} failed (code ${r.code}). Read the setup log for the cause.`);
}

// uv lives in the app's own folder, so it never touches the person's setup.
export function uvPath(toolsDir) {
  return path.join(toolsDir, IS_WIN ? 'uv.exe' : 'uv');
}
export async function ensureUv(toolsDir, onLine) {
  const uv = uvPath(toolsDir);
  if (existsSync(uv)) return uv;
  const r = await runOfficialInstaller('uv', { onLine, env: { UV_UNMANAGED_INSTALL: toolsDir, UV_NO_MODIFY_PATH: '1', INSTALLER_NO_MODIFY_PATH: '1' } });
  if (!r.ok || !existsSync(uv)) throw new Error('Could not download the Python installer. Check your internet connection before retrying.');
  return uv;
}

// Sign-in runs the tool's own login. Codex finishes in the browser by itself.
// Claude's page shows a code at the end; the person pastes it in the app and
// `send` passes it on. Resolves when the tool exits.
const logins = new Map();
export function startLogin(name, cliPath, { onLine, onUrl }) {
  if (logins.has(name)) throw new Error('Sign-in is already open. Finish it in your browser.');
  const args = name === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
  const l = launchable(cliPath, args);
  const child = spawn(l.cmd, l.args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const login = { child, cancelled: false, timer: null };
  logins.set(name, login);
  let sent = false;
  const feed = (buf) => {
    for (const l of String(buf).split(/\r?\n|\r/)) {
      if (!l.trim()) continue;
      if (login.cancelled) return;
      onLine?.(l);
      const m = !sent && l.match(/https:\/\/\S+/);
      if (m && /oauth|authorize/i.test(m[0])) ((sent = true), onUrl?.(m[0]));
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(login.timer);
      if (logins.get(name) === login) logins.delete(name);
      resolve({ ...result, cancelled: login.cancelled });
    };
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => finish({ ok: code === 0, code }));
  });
}
export function sendLoginCode(name, code) {
  const login = logins.get(name);
  if (!login || login.cancelled) throw new Error('Sign-in has closed. Select Sign in again.');
  login.child.stdin.write(String(code).trim() + '\n');
}
export function cancelLogin(name) {
  const login = logins.get(name);
  if (!login || login.cancelled) return;
  login.cancelled = true;
  login.child.kill();
  // A stuck sign-in must still let the person try again.
  login.timer = setTimeout(() => login.child.kill('SIGKILL'), 2000);
  login.timer.unref();
}
export function cancelLogins() {
  for (const name of logins.keys()) cancelLogin(name);
}
