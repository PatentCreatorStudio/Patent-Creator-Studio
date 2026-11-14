// The drawings go to the patent office as one PDF. The app makes it itself,
// mechanically, from the figure files the checks vouched for, so no AI needs a
// shell for it and the PDF is exactly those figures. Chromium renders each
// figure as an image (scripts inside an SVG never run) and embeds the fonts.
import { BrowserWindow } from 'electron';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeInside } from './safe-write.js';

export const DRAWINGS_PDF = 'drawings.pdf';
const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

// Figure files in page order: FIG. 2 before FIG. 10.
export function figureFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  return names
    .filter((n) => TYPES[path.extname(n).toLowerCase()])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

// One hash over every figure's name and bytes, to tell a current PDF from a stale one.
export function figuresHash(dir) {
  const h = createHash('sha256');
  for (const n of figureFiles(dir)) h.update(n + '\0').update(readFileSync(path.join(dir, n))).update('\0');
  return h.digest('hex');
}

// Writes <filingRel>/drawings.pdf from <figuresRel>/, inside the invention
// folder only. Returns the figures hash it was made from. Throws in plain words.
export async function writeDrawingsPdf(folder, figuresRel, filingRel) {
  const dir = path.join(folder, figuresRel);
  const names = figureFiles(dir);
  if (!names.length) throw new Error(`No drawings (.svg or .png) are in ${figuresRel}/. Run step 5 again.`);
  const before = figuresHash(dir);
  const pages = names.map((n) => {
    const full = path.join(dir, n);
    if (!lstatSync(full).isFile()) throw new Error(`The drawing ${n} is a link. Replace it with a file copy.`);
    const data = readFileSync(full).toString('base64');
    return `<div class="page"><img alt="" src="data:${TYPES[path.extname(n).toLowerCase()]};base64,${data}"></div>`;
  });
  // 37 CFR 1.84(g) margins: top and left 2.5 cm, right 1.5 cm, bottom 1.0 cm.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: letter; margin: 2.5cm 1.5cm 1cm 2.5cm; }
    html, body { margin: 0; background: #fff; }
    .page { width: 100%; height: calc(11in - 3.5cm); display: flex; align-items: center; justify-content: center; break-after: page; }
    .page:last-child { break-after: auto; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
  </style></head><body>${pages.join('')}</body></html>`;
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    const pdf = await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, preferCSSPageSize: true });
    if (figuresHash(dir) !== before) throw new Error('A drawing changed while the PDF was made. Run step 7 again.');
    writeInside(folder, path.join(filingRel, DRAWINGS_PDF), pdf);
  } finally {
    win.destroy();
  }
  return before;
}
