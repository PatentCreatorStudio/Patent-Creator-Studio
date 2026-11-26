// Finds the tools the person already has: Claude Code, Codex, the patent-creator
// Python install, and Graphviz. A GUI-launched app on macOS gets a bare PATH, so
// the login shell's PATH is read once and merged with the usual install spots.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 20000, env: opts.env ?? childEnv(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err?.message });
    });
  });
}

// One lookup at a time: the window opens while this runs, and every caller
// that needs PATH (setup checks, installers, runs) waits on the same promise.
let pathLookup = null;
export function loginShellPath() {
  if (cachedPath) return Promise.resolve(cachedPath);
  pathLookup ??= lookUpShellPath().finally(() => (pathLookup = null));
  return pathLookup;
}
async function lookUpShellPath() {
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

// ---- Which version of the patent tools is installed ----------------------
// The app ships its own copy of the patent tools and installs that copy, so
// the version it needs is the version of the copy it carries. An installed
// copy older than that is out of date, and the app offers to update it.

// [project].version from a pyproject.toml.
export function pyprojectVersion(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const section = text.match(/^\[project\][^\n]*\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m);
  const m = section && section[1].match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : null;
}

// The lowest Python a pyproject.toml accepts (requires-python = ">=3.10").
export function pyprojectMinPython(file) {
  try {
    const m = readFileSync(file, 'utf8').match(/^requires-python\s*=\s*["']\s*>=\s*(\d+\.\d+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// "3.12" for a Python interpreter, or null if it does not answer.
export async function pythonVersion(py) {
  const r = await run(py, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { cwd: HOME, timeout: 30000 });
  const m = r.ok && r.stdout.trim().match(/^(\d+\.\d+)$/);
  return m ? m[1] : null;
}

// Compares Python package versions: release numbers first, and a pre-release
// (0.3.0rc1, 0.3.0b2, 0.3.0.dev1) before its final release. -1, 0 or 1.
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v || '').trim().toLowerCase().match(/^v?(\d+(?:\.\d+)*)(?:[-_.]?(dev|alpha|a|beta|b|rc|c|preview|pre)[-_.]?(\d*))?/);
    if (!m) return null;
    const rank = { dev: 0, a: 1, alpha: 1, b: 2, beta: 2, c: 3, rc: 3, pre: 3, preview: 3 };
    return { nums: m[1].split('.').map(Number), pre: m[2] ? [rank[m[2]], Number(m[3] || 0)] : [9, 0] };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  return Math.sign(x.pre[0] - y.pre[0] || x.pre[1] - y.pre[1]);
}

// The Python that runs the installed patent tools: the interpreter the
// patent-creator launcher itself names. A pip or uv launcher records it as a
// "#!" line, at the top of the script on Mac and Linux and inside the .exe
// on Windows. A Python merely sitting in the same folder is not proof (a
// shared bin folder can hold a launcher from one install and a Python from
// another), so only the recorded interpreter counts, and it must belong to a
// virtual environment (pyvenv.cfg beside its folder) for the app to update it.
export function toolsPython(pcPath) {
  if (!pcPath) return null;
  let file = pcPath;
  try {
    file = realpathSync(pcPath);
  } catch {}
  let text = '';
  try {
    if (statSync(file).size > 64 * 1024 * 1024) return null;
    text = readFileSync(file).toString('utf8'); // pip and uv write the interpreter path as UTF-8
  } catch {
    return null;
  }
  // Two forms: "#!/path/to/python", and, when that path has spaces, pip's
  // shell launcher: #!/bin/sh then '''exec' "/path with spaces/python" "$0" "$@".
  const lines = [
    ...text.matchAll(/#!\s*"?([^"\r\n]*?python[0-9.]*(?:w)?(?:\.exe)?)"?\s*(?:\r?\n|$)/gi),
    ...text.matchAll(/exec'\s+"([^"\r\n]*?python[0-9.]*(?:w)?(?:\.exe)?)"/gi),
  ];
  for (let i = lines.length - 1; i >= 0; i--) {
    const py = lines[i][1].trim();
    if (!py || /^\/usr\/bin\/env\b/.test(py) || !existsSync(py)) continue;
    const venv = path.dirname(path.dirname(py));
    if (existsSync(path.join(venv, 'pyvenv.cfg'))) return py;
  }
  return null;
}

// Asks the installed tools for their own version. Runs isolated (-I) from the
// home folder, so a copy of the tools in the current folder cannot answer in
// the installed copy's place. Old copies (before 0.3.0) report 0.2.0.
const VERSION_PROBE = [
  'import json, importlib.metadata as md',
  'd = md.distribution("claude-patent-creator")',
  'u = d.read_text("direct_url.json")',
  'editable = bool(u and json.loads(u).get("dir_info", {}).get("editable"))',
  'try:',
  '    import mcp_server; v = mcp_server.__version__',
  'except Exception:',
  '    v = d.version',
  'print(json.dumps({"version": v, "editable": editable}))',
].join('\n');

// Windows: programs running from inside a folder (another Studio window, or
// Claude Code using the tools). Windows lets a running program be renamed but
// not replaced, so the app asks Windows directly before updating. Returns
// null when Windows cannot be asked.
export async function processesRunningFrom(folder) {
  if (!IS_WIN) return [];
  const prefix = path.resolve(folder).replace(/'/g, "''") + '\\';
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 });
  if (!r.ok) return null;
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function pythonToolsVersion(py) {
  const r = await run(py, ['-I', '-c', VERSION_PROBE], { cwd: HOME, timeout: 30000 });
  try {
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    if (j.version) return { version: String(j.version), editable: !!j.editable, python: py };
  } catch {}
  return null;
}

export async function installedToolsVersion(pcPath) {
  const py = toolsPython(pcPath);
  if (py) {
    const r = await run(py, ['-I', '-c', VERSION_PROBE], { cwd: HOME, timeout: 30000 });
    try {
      const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      if (j.version) return { version: String(j.version), editable: !!j.editable, python: py };
    } catch {}
  }
  // No virtual environment the app can see into: ask the command itself.
  // Copies before 0.3.0 have no --version and answer with a usage error, so
  // only a successful run that prints a real version number counts.
  const r = await run(pcPath, ['--version'], { cwd: HOME, timeout: 30000 });
  const m = r.ok && r.stdout.match(/^patent-creator\s+(\d[\w.+-]*)\s*$/m);
  return { version: m ? m[1] : null, editable: false, python: py };
}

// Whether a given patent-creator install reports its rulebook search ready.
export async function toolsStatusReady(pcPath) {
  const r = await run(pcPath, ['status'], { timeout: 60000 });
  return /Status:\s*Ready/i.test(r.stdout + r.stderr);
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
    const needed = settings.bundledToolsVersion || null;
    jobs.push(
      installedToolsVersion(pc).then((v) => {
        const t = out.patentCreator;
        t.version = v.version;
        t.editable = v.editable;
        t.python = v.python;
        t.neededVersion = needed;
        // Older than the copy this app carries: the app's checks and the AI
        // would run on old code. A developer's linked copy is never replaced.
        t.outdated = !!(needed && (!v.version || compareVersions(v.version, needed) < 0));
        // The app updates a copy in place only inside a virtual environment it
        // can identify. Anything else gets the app's own copy installed in its
        // usual folder instead (see setup:install).
        t.canUpdate = t.outdated && !v.editable;
        t.inPlace = !!v.python;
      })
    );
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
