// Publishes the committed source (git HEAD) to the beta testers' repo as one
// new commit, with no personal email and no AI trailers, and tags it so that
// repo's own release workflow builds the Mac and Windows installers there.
//
//   node studio/scripts/export-beta.cjs v0.1.0-beta.6
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BETA = 'PatentCreatorStudio/Patent-Creator-Studio-Beta';
const AUTHOR = { name: 'RobThePCGuy', email: '10876982+RobThePCGuy@users.noreply.github.com' };
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag || '')) throw new Error('Give a tag like v0.1.0-beta.6');

const repo = path.resolve(__dirname, '..', '..');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pcs-beta-'));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
};

execFileSync('git', ['clone', '-q', `https://github.com/${BETA}.git`, work], { stdio: 'inherit' });
// The first export replaces GitHub's starter commit so the history begins clean.
const first = !git(work, 'tag', '--list');
if (first) git(work, 'checkout', '-q', '--orphan', 'clean');
for (const name of fs.readdirSync(work)) if (name !== '.git') fs.rmSync(path.join(work, name), { recursive: true, force: true });
const tar = path.join(os.tmpdir(), `pcs-beta-${process.pid}.tar`);
git(repo, 'archive', '--format=tar', '-o', tar, 'HEAD');
execFileSync('tar', ['-xf', tar, '-C', work]);
fs.rmSync(tar);
// Visitors to the beta repo come for the app, so its front page is the app's
// own page. The patent tools' guide stays readable in the public repo.
fs.copyFileSync(path.join(work, 'studio', 'LANDING.md'), path.join(work, 'README.md'));

execFileSync('git', ['-C', work, 'add', '-A'], { env });
execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m',
  `Patent Creator Studio ${tag}\n\nBuilt on Claude Patent Creator. Its full history and contributor credit\nlive at https://github.com/RobThePCGuy/Claude-Patent-Creator.`], { env });
execFileSync('git', ['-C', work, 'tag', tag], { env });
execFileSync('git', ['-C', work, 'push', '-q', ...(first ? ['--force'] : []), 'origin', 'HEAD:main', tag], { stdio: 'inherit' });
console.log(`Pushed ${tag} to ${BETA}: ${git(work, 'rev-parse', '--short', 'HEAD')}`);
fs.rmSync(work, { recursive: true, force: true });
