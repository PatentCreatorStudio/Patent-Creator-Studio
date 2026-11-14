// History mining (skill Phase 1-H) reads a material repository's git history.
// The app saves that history itself into the invention folder, so the AI reads
// a file instead of running git: Claude Code has no shell sandbox on Windows,
// and a read-only file works the same for every AI on every system.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { which, childEnv } from './env.js';
import { writeInside } from './safe-write.js';

const CAP = 24 * 1024 * 1024; // per repository; larger histories are cut with a note

// The repository is the inventor's material, not trusted code: its own config
// must not make git run programs (external diff, text conversion, fsmonitor).
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager'];

function git(gitPath, args) {
  return new Promise((resolve) => {
    execFile(gitPath, [...SAFE, ...args], { env: childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }), maxBuffer: CAP + 1024 * 1024, timeout: 120000, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || ''), err: err?.message, big: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
    });
  });
}

// Returns plain lines for the run log. Never throws: no history is not an error.
export async function saveGitHistory(folder, materials, outRel) {
  const lines = [];
  const dirs = materials.filter((m) => {
    try {
      return statSync(m).isDirectory();
    } catch {
      return false;
    }
  });
  if (!dirs.length) return lines;
  const gitPath = await which('git');
  if (!gitPath) return ['Git is not installed, so no code history was saved. History mining is skipped.'];
  const seen = new Set();
  for (const d of dirs) {
    const top = await git(gitPath, ['-C', d, 'rev-parse', '--show-toplevel']);
    if (!top.ok) continue;
    const root = path.resolve(top.out.trim());
    if (seen.has(root)) continue;
    seen.add(root);
    const log = await git(gitPath, ['-C', root, 'log', '--no-color', '--no-ext-diff', '--no-textconv', '--date=iso-strict', '--stat', '--patch', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B']);
    let text = log.out;
    if (!log.ok && !log.big) {
      lines.push(`Could not read the history of ${root}: ${log.err}`);
      continue;
    }
    if (log.big || text.length > CAP) text = text.slice(0, CAP) + '\n\n[History cut at 24 MB by the app. The newest commits are above.]\n';
    const name = `${path.basename(root).replace(/[^\w.-]+/g, '-') || 'repo'}.log`;
    writeInside(folder, path.join(outRel, name), `# Git history of ${root}\n# Saved by the app, newest first, read-only material.\n\n${text}`);
    lines.push(`Saved the code history of ${path.basename(root)} to ${outRel}/${name}.`);
  }
  return lines;
}
