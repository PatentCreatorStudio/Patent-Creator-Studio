// Writes a file inside an invention folder without following a link an AI run
// may have planted there (a link could point at the app's own records).
import { writeFileSync, appendFileSync, mkdirSync, lstatSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function writeInside(folder, rel, data, { append = false } = {}) {
  const root = realpathSync(folder);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error('The file could not be saved outside the invention folder. Run the step again.');
  mkdirSync(path.dirname(full), { recursive: true });
  const parent = realpathSync(path.dirname(full));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('The destination is a linked folder. Replace it with a folder inside the invention.');
  try {
    if (!lstatSync(full).isFile()) unlinkSync(full);
  } catch {}
  (append ? appendFileSync : writeFileSync)(full, data);
}

// Removes a file the same careful way: only a real file inside the folder,
// never the thing a link points at.
export function removeInside(folder, rel) {
  const root = realpathSync(folder);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return;
  try {
    const parent = realpathSync(path.dirname(full));
    if (parent !== root && !parent.startsWith(root + path.sep)) return;
    unlinkSync(full); // unlink removes a link itself, not its target
  } catch {}
}
