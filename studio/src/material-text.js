// PDF and Word files in the inventor's material, made readable for every AI.
// Claude Code reads a PDF by rendering pages with Poppler, which most Windows
// computers lack, and no AI here can open a .docx without a shell. So the app
// writes a text copy of each one (and page images where a page has no text,
// as in a scan) using the PDF library the patent tools already install. The
// AI reads the copies; the originals stay read-only and untouched.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv } from './env.js';
import { writeInside } from './safe-write.js';

const EXTS = /\.(pdf|docx)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache']);
const MAX_FILES = 400;
const MAX_BYTES = 200 * 1024 * 1024;

const SCRIPT = String.raw`
import json, os, sys, zipfile
jobs = json.load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2]
res = []
def docx_text(p):
    from xml.etree import ElementTree as ET
    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(p) as z:
        info = z.getinfo("word/document.xml")
        if info.file_size > 64 * 1024 * 1024:
            raise ValueError("document.xml is too large")
        data = z.read(info)
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ValueError("the document declares XML entities, which are not read")
    root = ET.fromstring(data)
    lines = []
    for p in root.iter(W + "p"):
        parts = []
        for el in p.iter():
            if el.tag == W + "t" and el.text:
                parts.append(el.text)
            elif el.tag == W + "tab":
                parts.append("\t")
            elif el.tag in (W + "br", W + "cr"):
                parts.append("\n")
        lines.append("".join(parts))
    return "\n".join(lines)
for j in jobs:
    r = {"id": j["id"], "ok": False, "images": []}
    try:
        if j["src"].lower().endswith(".docx"):
            r["text"] = docx_text(j["src"])
            r["pages"] = None
        else:
            import pymupdf
            doc = pymupdf.open(j["src"])
            if doc.needs_pass:
                raise ValueError("the PDF is password-protected")
            parts = []
            for i, page in enumerate(doc):
                t = page.get_text("text")
                parts.append(f"\n\n--- Page {i + 1} ---\n\n{t}")
                if len(t.strip()) < 25 and len(r["images"]) < 30:
                    name = f'{j["id"]}-p{i + 1}.png'
                    page.get_pixmap(dpi=110).save(os.path.join(out, name))
                    r["images"].append(name)
            r["text"] = "".join(parts)
            r["pages"] = doc.page_count
        r["ok"] = True
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"[:300]
    res.append(r)
print(json.dumps(res))
`;

function walk(root, found) {
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (EXTS.test(root) && st.size <= MAX_BYTES) found.push({ src: root, size: st.size, mtime: st.mtimeMs });
    return;
  }
  if (!st.isDirectory()) return;
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (found.length >= MAX_FILES) return;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory() && (SKIP_DIRS.has(d.name) || d.name.startsWith('.'))) continue;
    walk(path.join(root, d.name), found);
  }
}

const slug = (s) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(-120);

// Returns plain lines for the run log. Never throws: unreadable files are
// listed in the index with the reason, and the step goes on.
export async function saveMaterialText(folder, materials, outRel, python) {
  const found = [];
  for (const m of materials) walk(m, found);
  if (!found.length) return [];
  if (!python || !existsSync(python)) return ['PDF and Word files in your material could not be converted: the patent tools are not installed. Open Setup.'];

  const manifestRel = path.join(outRel, 'manifest.json');
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(path.join(folder, manifestRel), 'utf8'));
  } catch {}
  const items = found.map((f) => {
    const base = materials.find((m) => f.src === m || f.src.startsWith(m + path.sep)) || path.dirname(f.src);
    const rel = path.relative(path.dirname(base), f.src);
    return { ...f, rel, id: slug(rel) };
  });
  const todo = items.filter((f) => {
    const old = manifest[f.src];
    return !(old && old.size === f.size && old.mtime === f.mtime && existsSync(path.join(folder, outRel, `${f.id}.txt`)));
  });

  const lines = [];
  if (todo.length) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pcs-text-'));
    try {
      const jobsFile = path.join(tmp, 'jobs.json');
      writeInside(tmp, 'jobs.json', JSON.stringify(todo.map(({ src, id }) => ({ src, id }))));
      const r = await new Promise((resolve) => {
        execFile(python, ['-I', '-c', SCRIPT, jobsFile, tmp], { cwd: tmp, env: childEnv({ PYTHONIOENCODING: 'utf-8' }), maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
      });
      let results = [];
      try {
        results = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      } catch {
        lines.push(`PDF and Word files could not be converted: ${(r.stderr || r.err?.message || 'no answer').trim().split(/\r?\n/).pop()}`);
      }
      for (const res of results) {
        const it = todo.find((t) => t.id === res.id);
        if (!it) continue;
        if (res.ok) {
          const head = `# Text copy of ${it.src}\n# Made by the app from the inventor's material (read-only). ${res.pages ? `${res.pages} pages.` : 'Word document.'}${res.images.length ? ` Pages with no text are saved as images: ${res.images.join(', ')}.` : ''}\n`;
          writeInside(folder, path.join(outRel, `${it.id}.txt`), head + res.text);
          for (const img of res.images) writeInside(folder, path.join(outRel, img), readFileSync(path.join(tmp, img)));
          manifest[it.src] = { size: it.size, mtime: it.mtime, id: it.id, pages: res.pages, images: res.images };
        } else {
          manifest[it.src] = { size: it.size, mtime: it.mtime, id: it.id, error: res.error };
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const rows = items.map((it) => {
    const m = manifest[it.src] || {};
    return m.error ? `- ${it.src}: could not be read (${m.error})` : `- ${it.src} -> ${it.id}.txt${m.images?.length ? ` (+ ${m.images.length} page image${m.images.length > 1 ? 's' : ''})` : ''}`;
  });
  writeInside(folder, manifestRel, JSON.stringify(manifest, null, 1));
  writeInside(folder, path.join(outRel, 'index.md'), `# Readable copies of PDF and Word material\n\nThe app made these text copies so any AI can read them. Read the copy instead of the original.\n\n${rows.join('\n')}\n`);
  const bad = items.filter((it) => manifest[it.src]?.error).length;
  lines.push(`Made readable copies of ${items.length - bad} PDF and Word file${items.length - bad === 1 ? '' : 's'} in ${outRel.replace(/\\/g, '/')}/${bad ? `; ${bad} could not be read (listed in index.md)` : ''}.`);
  if (found.length >= MAX_FILES) lines.push(`Only the first ${MAX_FILES} PDF and Word files were converted.`);
  return lines;
}
