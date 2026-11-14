// Finds the tools the person already has: Claude Code, Codex, the patent-creator
// Python install, and Graphviz. A GUI-launched app on macOS gets a bare PATH, so
// the login shell's PATH is read once and merged with the usual install spots.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
let cachedPath = null;

// Windows cannot start a .cmd file directly (Node refuses with EINVAL), and
// going through cmd.exe would mangle prompt text containing % & " characters.
// npm's .cmd shims only run `node <script>`, so that script is run with Node
// instead, arguments untouched. Anything else passes through unchanged.
export function launchable(cmd, args = []) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(cmd || '')) return { cmd, args };
  let text = '';
  try {
    text = readFileSync(cmd, 'utf8');
  } catch {}
  const m = text.match(/"%dp0%\\([^"]+\.(?:c|m)?js)"/i);
  if (!m) throw new Error(`${path.basename(cmd)} is a Windows script the app cannot start. Reinstall the tool from Setup.`);
  const dir = path.dirname(cmd);
  const script = path.join(dir, m[1]);
  const localNode = path.join(dir, 'node.exe');
  let node = existsSync(localNode) ? localNode : null;
  if (!node) {
    for (const d of (cachedPath || process.env.PATH || '').split(path.delimiter)) {
      const n = d && path.join(d, 'node.exe');
      if (n && existsSync(n)) {
        node = n;
        break;
      }
    }
  }
  if (!node) throw new Error(`${path.basename(cmd)} needs Node.js, which was not found. Reinstall the tool from Setup.`);
  return { cmd: node, args: [script, ...args] };
}

// True when this Windows process holds an administrator token (High
// integrity), which decides which Codex sandbox can start commands.
let elevated = null;
export function isElevated() {
  if (!IS_WIN) return false;
  if (elevated === null) {
    try {
      elevated = /S-1-16-12288|S-1-16-16384/.test(execFileSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true }));
    } catch {
      elevated = false;
    }
  }
  return elevated;
}

function run(cmd0, args0, opts = {}) {
  return new Promise((resolve) => {
    let cmd, args;
    try {
      ({ cmd, args } = launchable(cmd0, args0));
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: '', error: e.message });
    }
    execFile(cmd, args, { timeout: opts.timeout ?? 20000, env: opts.env ?? childEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err?.message });
    });
  });
}

export async function loginShellPath() {
  if (cachedPath) return cachedPath;
  const extra = IS_WIN
    ? [path.join(HOME, '.local', 'bin')]
    : [path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.join(HOME, '.npm-global/bin')];
  let shellPath = '';
  if (!IS_WIN) {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = await run(shell, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 8000, env: process.env });
    const m = r.stdout.match(/__P__(.*)__P__/s);
    if (m) shellPath = m[1];
  }
  const parts = [...shellPath.split(path.delimiter), ...(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean);
  cachedPath = [...new Set(parts)].join(path.delimiter);
  return cachedPath;
}

export function childEnv(extra = {}) {
  return { ...process.env, PATH: cachedPath || process.env.PATH, ...extra };
}

export async function which(name) {
  const p = await loginShellPath();
  for (const dir of p.split(path.delimiter)) {
    for (const ext of IS_WIN ? ['.exe', '.cmd', ''] : ['']) {
      const full = path.join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function venvCandidates() {
  const bin = IS_WIN ? 'Scripts' : 'bin';
  const exe = IS_WIN ? 'patent-creator.exe' : 'patent-creator';
  return [
    path.join(HOME, 'patent-creator-venv', bin, exe),
    path.join(HOME, '.venvs', 'patent-creator', bin, exe),
  ];
}

export async function findPatentCreator(overridePath) {
  if (overridePath && existsSync(overridePath)) return overridePath;
  for (const c of venvCandidates()) if (existsSync(c)) return c;
  return which('patent-creator');
}

export async function detectAll(settings = {}) {
  await loginShellPath();
  const [claude, codex, pc, dot, python] = await Promise.all([
    which('claude'),
    which('codex'),
    findPatentCreator(settings.patentCreatorPath),
    which('dot'),
    which(IS_WIN ? 'py' : 'python3'),
  ]);

  const out = {
    claude: { path: claude, installed: !!claude },
    codex: { path: codex, installed: !!codex },
    patentCreator: { path: pc, installed: !!pc },
    graphviz: { path: dot, installed: !!dot },
    python: { path: python, installed: !!python },
  };

  const jobs = [];
  if (claude) {
    jobs.push(run(claude, ['--version']).then((r) => (out.claude.version = r.stdout.trim())));
    jobs.push(
      run(claude, ['auth', 'status']).then((r) => {
        try {
          const j = JSON.parse(r.stdout);
          out.claude.loggedIn = !!j.loggedIn;
          out.claude.authMethod = j.authMethod || null; // e.g. "claude.ai" (subscription) or api key
        } catch {
          out.claude.loggedIn = false;
        }
      })
    );
  }
  if (codex) {
    jobs.push(run(codex, ['--version']).then((r) => (out.codex.version = r.stdout.trim())));
    jobs.push(
      run(codex, ['login', 'status']).then((r) => {
        const text = (r.stdout + r.stderr).trim();
        out.codex.loginText = text;
        out.codex.loggedIn = r.ok && /logged in/i.test(text);
        out.codex.chatgpt = /chatgpt/i.test(text);
      })
    );
  }
  if (pc) {
    jobs.push(
      run(pc, ['status'], { timeout: 60000 }).then((r) => {
        const text = r.stdout + r.stderr;
        out.patentCreator.statusText = text.trim();
        out.patentCreator.ready = /Status:\s*Ready/i.test(text);
        const chunks = text.match(/Chunks:\s*([\d,]+)/);
        if (chunks) out.patentCreator.chunks = chunks[1];
      })
    );
  }
  await Promise.all(jobs);
  return out;
}

// Streams a long-running setup command (install, index build) to the screen.
export function streamCommand(cmd0, args0, { onLine, cwd, env } = {}) {
  return new Promise((resolve) => {
    let cmd, args;
    try {
      ({ cmd, args } = launchable(cmd0, args0));
    } catch (e) {
      return resolve({ ok: false, code: -1, error: e.message });
    }
    const child = spawn(cmd, args, { cwd, env: env || childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (buf) => String(buf).split(/\r?\n|\r/).forEach((l) => l.trim() && onLine?.(l));
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => resolve({ ok: false, code: -1, error: e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}
