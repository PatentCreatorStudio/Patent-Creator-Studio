// Runs one phase on one of four engines and turns each CLI's stream into one
// shape of event for the screen. The app spawns the person's own, unmodified
// `claude` and `codex` binaries. It never reads or relays a Claude.ai or
// ChatGPT login; subscription modes use whatever login the person made in
// those tools. API-key modes pass the key to that one child process only.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { childEnv, launchable, isElevated } from './env.js';
import { SERVER_ENV } from './gates.js';

export const ENGINES = {
  'claude-sub': { label: 'Claude Code (Claude subscription)', cli: 'claude', key: null },
  'claude-key': { label: 'Claude Code (Anthropic API key)', cli: 'claude', key: 'anthropic' },
  'codex-sub': { label: 'Codex (ChatGPT subscription)', cli: 'codex', key: null },
  'codex-key': { label: 'Codex (OpenAI API key)', cli: 'codex', key: 'openai' },
};

const SERVER_NAME = 'patent-creator';

// Tools the drafting run may use without asking. Everything runs inside the
// invention folder; Bash is needed for git history mining and the package
// strip script the skill requires.
// Write and Edit are NOT here: they are allowed only inside the folder, by a
// path rule built per run (see buildCommand). A bare 'Write' would allow any path.
const CLAUDE_TOOLS = [
  `mcp__${SERVER_NAME}__*`,
  'Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'ToolSearch', 'Skill',
];

// An absolute folder in Claude Code's permission-rule form: `//` + the path.
// On Windows Claude matches C:\Users\x as /c/Users/x, so the rule must too.
function ruleRoot(dir) {
  const full = path.resolve(dir);
  if (process.platform !== 'win32') return '/' + full;
  const m = full.match(/^([A-Za-z]):[\\/]?(.*)$/);
  return m ? `//${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/$/, '') : '/' + full.replace(/\\/g, '/');
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

// Codex reads personal instructions (AGENTS.md) from its home folder. Each run
// gets an app-owned home so a patent run behaves the same on every machine.
// Subscription mode links the person's own login file into it (Codex itself
// reads and refreshes it; the app never opens it). Key mode gets no login file.
function codexHome(appDataDir, withLogin) {
  const home = path.join(appDataDir, withLogin ? 'codex-home' : 'codex-home-key');
  mkdirSync(home, { recursive: true });
  const link = path.join(home, 'auth.json');
  if (withLogin) {
    const real = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    let ok = false;
    try {
      ok = lstatSync(link).isSymbolicLink();
    } catch {}
    if (!ok && existsSync(real)) {
      try {
        if (existsSync(link)) unlinkSync(link);
        symlinkSync(real, link);
      } catch {
        return null; // cannot link (e.g. Windows without symlink rights): use the normal home
      }
    }
  }
  return home;
}

export function buildCommand({ engine, appDataDir, cliPath, pcPath, repoRoot, cwd, systemText, prompt, resumeId, settings, key, serverEnv = {}, readDirs = [] }) {
  const def = ENGINES[engine];
  if (!def) throw new Error(`AI choice unavailable: ${engine}. Choose an AI in Settings.`);
  const env = childEnv();

  if (def.cli === 'claude') {
    // The server's search keys travel in the environment (Claude starts the
    // server with its own environment), never in this config.
    Object.assign(env, serverEnv);
    const mcpConfig = JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: pcPath, args: ['serve'], env: SERVER_ENV } } });
    // Shell commands run in Claude Code's sandbox: they can write only inside
    // the invention folder and reach only GitHub (for history mining). File
    // edits are approved only by a path rule for the folder; anything else is
    // unapproved, and a headless run refuses unapproved actions. Inventor
    // material is readable, not writable.
    const sandbox = {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ['github.com', '*.github.com', '*.githubusercontent.com'] },
      },
      permissions: {
        // An Edit rule covers every file-editing tool, Write included.
        allow: [`Edit(${ruleRoot(cwd)}/**)`, ...readDirs.map((d) => `Read(${ruleRoot(d)}/**)`)],
      },
    };
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      '--permission-mode', 'default',
      '--settings', JSON.stringify(sandbox),
      // Claude Code has no shell sandbox on native Windows: its docs say
      // commands there run unsandboxed. So on Windows Claude gets no shell at
      // all, denied here rather than trusted to the sandbox setting. Nothing
      // in a run needs one: the app saves git history and makes the PDFs.
      ...(process.platform === 'win32'
        ? ['--allowedTools', ...CLAUDE_TOOLS.filter((t) => t !== 'Bash'), '--disallowedTools', 'Bash', 'PowerShell']
        : ['--allowedTools', ...CLAUDE_TOOLS]),
      '--append-system-prompt', systemText,
    ];
    if (repoRoot) args.push('--plugin-dir', repoRoot);
    if (settings.claudeModel) args.push('--model', settings.claudeModel);
    if (resumeId) args.push('--resume', resumeId);
    if (def.key) {
      if (!key) throw new Error('No Anthropic API key is saved. Add one in Settings.');
      // --bare reads ONLY this key: no keychain login, no personal hooks.
      args.push('--bare');
      env.ANTHROPIC_API_KEY = key;
    } else {
      // The person's own login. Skip their personal hooks and plugins so the
      // run is the same on every machine; the patent plugin comes from --plugin-dir.
      args.push('--setting-sources', 'project');
      delete env.ANTHROPIC_API_KEY;
    }
    // Personal CLAUDE.md files and auto-memory are not part of a patent run.
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    return { cmd: cliPath, args, env, stdin: null };
  }

  // Codex
  const mcp = (k, v) => ['-c', `mcp_servers.${SERVER_NAME}.${k}=${v}`];
  const base = [
    '--json', '--skip-git-repo-check', '--ignore-user-config',
    // Set by config, not -s/-C, because `exec resume` accepts only -c. The
    // process is spawned with cwd = the invention folder. Material folders the
    // inventor added are readable under workspace-write without --add-dir.
    '-c', 'sandbox_mode="workspace-write"',
    // Without a Windows sandbox named, Codex refuses every command on Windows
    // ("blocked by policy"). The unelevated sandbox cannot start commands from
    // an administrator process (CreateProcessAsUserW: Access is denied).
    ...(process.platform === 'win32' ? ['-c', `windows.sandbox="${isElevated() ? 'elevated' : 'unelevated'}"`] : []),
    ...mcp('command', tomlString(pcPath)),
    ...mcp('args', '["serve"]'),
    ...mcp('env', `{ PATENT_ENABLE_ANTECEDENT_CHECK = "1", PYTHONIOENCODING = "utf-8" }`),
    // Search keys are passed through from this process's environment by name.
    ...mcp('env_vars', JSON.stringify(Object.keys(serverEnv))),
    ...mcp('default_tools_approval_mode', '"approve"'),
    ...mcp('startup_timeout_sec', '180'),
    ...mcp('tool_timeout_sec', '900'),
    '-c', 'web_search="live"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', `model_reasoning_effort=${tomlString(settings.codexEffort || 'high')}`,
  ];
  if (settings.codexModel) base.push('-m', settings.codexModel);
  if (def.key) {
    if (!key) throw new Error('No OpenAI API key is saved. Add one in Settings.');
    env.CODEX_API_KEY = key;
  } else {
    delete env.CODEX_API_KEY;
  }
  Object.assign(env, serverEnv);
  if (appDataDir) {
    const home = codexHome(appDataDir, !def.key);
    if (home) env.CODEX_HOME = home;
  }
  const full = `${systemText}\n\n---\n\n${prompt}`;
  const args = resumeId ? ['exec', 'resume', ...base, resumeId, '-'] : ['exec', ...base, '-'];
  return { cmd: cliPath, args, env, stdin: resumeId ? prompt : full };
}

// ---- stream normalizers -------------------------------------------------

function short(v, n = 600) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
}

// What a person wants to see for a tool call: the file, the search, the
// command, not the whole JSON payload.
function toolInput(input) {
  if (!input || typeof input !== 'object') return short(input, 200);
  const pick = input.file_path || input.path || input.query || input.q || input.url || input.command || input.pattern || input.description || input.prompt;
  return pick ? short(String(pick).replace(/\s+/g, ' '), 200) : short(input, 200);
}

function toolLabel(name) {
  return String(name || '').replace(/^mcp__[^_]+(?:-[^_]+)*__/, '').replace(/^mcp__patent-creator__/, '');
}

export function normalizeClaude(ev) {
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    out.push({ kind: 'session', sessionId: ev.session_id, model: ev.model, apiKeySource: ev.apiKeySource, mcp: ev.mcp_servers });
  } else if (ev.type === 'assistant') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'text', text: b.text, sub: !!ev.parent_tool_use_id });
      if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id, name: toolLabel(b.name), input: toolInput(b.input), sub: !!ev.parent_tool_use_id });
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'tool_result') {
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : b.content;
        out.push({ kind: 'toolResult', id: b.tool_use_id, ok: !b.is_error, text: short(text, 400) });
      }
    }
  } else if (ev.type === 'result') {
    out.push({ kind: 'final', text: ev.result || '', ok: !ev.is_error, sessionId: ev.session_id, turns: ev.num_turns, ms: ev.duration_ms, costUsd: ev.total_cost_usd, subtype: ev.subtype });
  } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status !== 'allowed') {
    out.push({ kind: 'warn', text: `Usage limit: ${ev.rate_limit_info?.status} (${ev.rate_limit_info?.rateLimitType || 'limit'})` });
  }
  return out;
}

export function normalizeCodex(ev, state) {
  const out = [];
  if (ev.type === 'thread.started') out.push({ kind: 'session', sessionId: ev.thread_id });
  else if (ev.type === 'item.started' || ev.type === 'item.completed') {
    const it = ev.item || {};
    const done = ev.type === 'item.completed';
    if (it.type === 'agent_message' && done) {
      state.lastMessage = it.text;
      out.push({ kind: 'text', text: it.text });
    } else if (it.type === 'reasoning' && done && it.text) out.push({ kind: 'think', text: short(it.text, 400) });
    else if (it.type === 'command_execution') {
      if (!done) out.push({ kind: 'tool', id: it.id, name: 'shell', input: short(it.command, 300) });
      else out.push({ kind: 'toolResult', id: it.id, ok: it.exit_code === 0, text: short(it.aggregated_output, 400) });
    } else if (it.type === 'mcp_tool_call') {
      if (!done) out.push({ kind: 'tool', id: it.id, name: it.tool, input: toolInput(it.arguments) });
      else out.push({ kind: 'toolResult', id: it.id, ok: !it.error, text: short(it.error || it.result?.structured_content || it.result?.content?.map?.((c) => c.text).join('\n'), 400) });
    } else if (it.type === 'web_search') {
      if (!done) out.push({ kind: 'tool', id: it.id, name: 'web search', input: short(it.query || it.action || '', 200) });
    } else if (it.type === 'file_change' && done) {
      out.push({ kind: 'files', text: (it.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n') });
    } else if (it.type === 'todo_list' && done) {
      out.push({ kind: 'think', text: (it.items || []).map((t) => `${t.completed ? '✓' : '·'} ${t.text}`).join('\n') });
    } else if (it.type === 'error') out.push({ kind: 'warn', text: it.message });
  } else if (ev.type === 'turn.completed') {
    out.push({ kind: 'final', text: state.lastMessage || '', ok: true, sessionId: state.sessionId, usage: ev.usage });
  } else if (ev.type === 'turn.failed') {
    out.push({ kind: 'error', text: ev.error?.message || 'Codex could not finish. Run this step again.' });
  } else if (ev.type === 'error') {
    out.push({ kind: /reconnecting/i.test(ev.message || '') ? 'warn' : 'error', text: ev.message });
  }
  return out;
}

// ---- runner --------------------------------------------------------------

export function runEngine(opts, onEvent) {
  const built = buildCommand(opts);
  const { env, stdin } = built;
  const { cmd, args } = launchable(built.cmd, built.args);
  const isClaude = ENGINES[opts.engine].cli === 'claude';
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env,
    stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  if (stdin != null) {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const state = { sessionId: opts.resumeId || null, lastMessage: '', sawFinal: false, stderr: '' };
  let buf = '';
  // Any secret this run was given is masked before an event is logged or shown,
  // even if a command the AI ran printed it.
  const secrets = [opts.key, ...Object.values(opts.serverEnv || {})].filter((s) => typeof s === 'string' && s.length >= 8);
  const redact = (v) => {
    if (typeof v === 'string') return secrets.reduce((acc, sec) => acc.split(sec).join('[hidden key]'), v);
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
    return v;
  };
  const emit = (raw) => {
    const e = redact(raw);
    if (e.kind === 'session' && e.sessionId) state.sessionId = e.sessionId;
    if (e.kind === 'final') state.sawFinal = true;
    onEvent(e);
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        emit({ kind: 'log', text: line });
        continue;
      }
      const events = isClaude ? normalizeClaude(ev) : normalizeCodex(ev, state);
      events.forEach(emit);
    }
  });
  child.stderr.on('data', (d) => {
    state.stderr = (state.stderr + d).slice(-4000);
  });

  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      emit({ kind: 'error', text: `Could not start the AI: ${e.message}. Check its installation in Setup.` });
      resolve({ code: -1, ...state });
    });
    child.on('close', (code, signal) => {
      if (code !== 0 || signal) {
        const tail = state.stderr.trim().split('\n').slice(-6).join('\n');
        emit({ kind: 'error', text: signal ? `Stopped (${signal}).` : `The ${isClaude ? 'Claude' : 'Codex'} run failed (code ${code}). Read the run details.${tail ? '\n' + tail : ''}` });
      }
      resolve({ code, signal, ...state });
    });
  });

  const stop = () => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      child.kill();
    }
  };
  return { done, stop, pid: child.pid };
}
