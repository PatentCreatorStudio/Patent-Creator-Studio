// Copies the committed patent tools (git HEAD) into .stage/patent-creator for
// the installer. Packing from git, not from the folder, keeps notes, keys and
// other uncommitted files on the builder's machine out of every installer.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const studio = path.resolve(__dirname, '..');
const repo = path.resolve(studio, '..');
const stage = path.join(studio, '.stage');
const out = path.join(stage, 'patent-creator');
const tar = path.join(stage, 'head.tar');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tar, 'HEAD'], { stdio: 'inherit' });
execFileSync('tar', ['-xf', tar, '-C', out], { stdio: 'inherit' });
fs.rmSync(tar);

const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
if (dirty) console.warn('Note: uncommitted changes are not in this build:\n' + dirty);
