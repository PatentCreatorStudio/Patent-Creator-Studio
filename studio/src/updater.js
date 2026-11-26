import path from 'node:path';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const exec = promisify(execFile);
const BUSY = 'Finish or stop the running step first.';

function selectAsset(release, platform, arch) {
  return release.assets?.find(({ name = '' }) => {
    if (platform === 'darwin' && arch === 'arm64') return name.endsWith('-arm64-mac.zip');
    if (platform === 'darwin' && arch === 'x64') return name.endsWith('-mac.zip') && !name.includes('arm64');
    return platform === 'win32' && name.includes('Setup') && name.endsWith('.exe');
  });
}

async function downloadAsset(asset, destination, progress) {
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1].toLowerCase();
  if (!digest) throw new Error('This release has no SHA-256 checksum. Use the download link.');
  if (!asset.browser_download_url?.startsWith('https://')) throw new Error('This release has no secure download link.');
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 30_000);
  };
  const hash = createHash('sha256');
  let received = 0;
  let lastPercent = -1;
  touch();
  try {
    const response = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'Patent-Creator-Studio' }, signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error('Download unavailable.');
    const total = Number(asset.size) || Number(response.headers.get('content-length')) || 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        touch();
        hash.update(chunk);
        received += chunk.length;
        const percent = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          progress({ stage: 'downloading', percent });
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
  } catch (err) {
    if (err.code === 'ENOSPC') throw new Error('There is not enough free space to download the update.');
    if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) throw new Error('The update could not be saved in the temporary folder.');
    throw new Error('The download did not finish. Check your internet connection and try again.');
  } finally {
    clearTimeout(timer);
  }
  if (hash.digest('hex') !== digest) throw new Error('The download did not match the release checksum. Try again.');
  progress({ stage: 'downloading', percent: 100 });
}

async function macBundle(app) {
  const exe = app.getPath('exe');
  if (exe.includes('/AppTranslocation/')) throw new Error('Move Patent Creator Studio to Applications and open it there before updating.');
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1];
  if (!bundle) throw new Error('The installed app could not be found. Use the download link.');
  try {
    if (!(await lstat(bundle)).isDirectory()) throw new Error('Not a bundle.');
    await access(bundle, constants.W_OK | constants.X_OK);
    await access(path.dirname(bundle), constants.W_OK | constants.X_OK);
  } catch {
    throw new Error('This app cannot be replaced in its current folder. Move it to a folder you can write to, then try again.');
  }
  return bundle;
}

async function bundleValue(bundle, key) {
  const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

// All paths are arguments, never shell source. The staged app and backup are
// on the installed app's volume, so neither rename needs a cross-volume copy.
const MAC_INSTALL_SCRIPT = `#!/bin/sh
pid="$1"
bundle="$2"
replacement="$3"
backup="$4"
stage="$5"
temp="$6"
exec >>"$temp/install.log" 2>&1
old_moved=0
new_moved=0
rollback() {
  trap - EXIT HUP INT TERM
  if [ "$old_moved" = 1 ]; then
    if [ "$new_moved" = 1 ]; then
      /bin/mv "$bundle" "$replacement" || exit 1
    fi
    /bin/mv "$backup" "$bundle" || exit 1
  fi
  /usr/bin/open "$bundle"
  # Keep install.log and any unrecoverable backup for diagnosis.
  /bin/rm -rf "$stage"
  exit 1
}
trap rollback EXIT HUP INT TERM
while kill -0 "$pid" 2>/dev/null; do /bin/sleep 1; done
[ ! -e "$backup" ] && [ ! -L "$backup" ] || exit 1
/bin/mv "$bundle" "$backup" || exit 1
old_moved=1
/bin/mv "$replacement" "$bundle" || exit 1
new_moved=1
/usr/bin/xattr -dr com.apple.quarantine "$bundle" || exit 1
/usr/bin/open "$bundle" || exit 1
trap - EXIT HUP INT TERM
/bin/rm -rf "$backup" "$stage" "$temp"
`;

async function spawnDetached(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', cwd: path.dirname(command) });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function createUpdater({ app, getRelease, isBusy, onProgress }) {
  let installing = false;
  return {
    isInstalling: () => installing,
    async install() {
      if (isBusy()) return { installed: false, reason: BUSY };
      if (installing) return { installed: false, reason: 'An update is already in progress.' };
      installing = true; // Held across awaits; main.js also refuses new work.
      let temp;
      let stage;
      let handedOff = false;
      try {
        if (!app.isPackaged) throw new Error('This development copy cannot update itself. Use the download link.');
        if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Self-update is not available on this system. Use the download link.');
        const bundle = process.platform === 'darwin' ? await macBundle(app) : null;
        const release = await getRelease();
        const asset = selectAsset(release, process.platform, process.arch);
        if (!asset) throw new Error('This release has no installer for this computer. Use the download link.');
        const version = release.tag_name.replace(/^v/, '');
        onProgress({ stage: 'downloading', percent: 0, version });
        temp = await mkdtemp(path.join(app.getPath('temp'), 'patent-studio-update-'));
        const download = path.join(temp, bundle ? 'update.zip' : 'Setup.exe');
        await downloadAsset(asset, download, (event) => onProgress({ ...event, version }));
        if (isBusy()) throw new Error(BUSY);
        onProgress({ stage: 'installing', version });
        if (bundle) {
          const extracted = path.join(temp, 'extracted');
          await mkdir(extracted);
          try {
            await exec('/usr/bin/ditto', ['-x', '-k', download, extracted]);
          } catch {
            throw new Error('The update could not be unpacked. Check free space and try again.');
          }
          const apps = (await readdir(extracted, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
          if (apps.length !== 1) throw new Error('The download does not contain one app to install.');
          const replacement = path.join(extracted, apps[0].name);
          let identifier, currentIdentifier, downloadedVersion;
          try {
            [identifier, currentIdentifier, downloadedVersion] = await Promise.all([
              bundleValue(replacement, 'CFBundleIdentifier'), bundleValue(bundle, 'CFBundleIdentifier'),
              bundleValue(replacement, 'CFBundleShortVersionString'),
            ]);
          } catch {
            throw new Error('The downloaded app could not be verified. Use the download link.');
          }
          if (!identifier || identifier !== currentIdentifier) throw new Error('The download is for a different app. Use the download link.');
          if (downloadedVersion !== version) throw new Error('The downloaded app version does not match this release. Use the download link.');
          // Copy before quitting: a full disk or denied write leaves this app open.
          try {
            stage = await mkdtemp(path.join(path.dirname(bundle), '.patent-studio-update-'));
            await exec('/usr/bin/ditto', [replacement, path.join(stage, 'replacement.app')]);
          } catch {
            throw new Error('The update could not be prepared beside this app. Check folder permissions and free space, then try again.');
          }
          if (isBusy()) throw new Error(BUSY);
          const script = path.join(temp, 'install.sh');
          await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
          await spawnDetached('/bin/sh', [script, String(process.pid), bundle, path.join(stage, 'replacement.app'), `${bundle}.backup-${randomUUID()}`, stage, temp]);
        } else {
          // electron-builder's per-user oneClick NSIS installer accepts these
          // flags: silent update, preserving shortcuts, then launch the app.
          await spawnDetached(download, ['/S', '--updated', '--force-run']);
        }
        handedOff = true; // The helper/installer owns these files after this point.
        app.quit();
        return { installed: true };
      } catch (err) {
        const reason = err.code ? 'The update could not be started. Check free space and folder permissions, then try again.' : err.message;
        onProgress({ stage: 'error', reason });
        return { installed: false, reason };
      } finally {
        if (!handedOff) {
          await Promise.all([temp, stage].filter(Boolean).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
          installing = false;
        }
      }
    },
  };
}
