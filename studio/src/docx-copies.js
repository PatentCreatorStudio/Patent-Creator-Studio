// The US patent office takes the description, claims and abstract as Word
// (.docx) files; other formats cost a surcharge on non-provisional filings.
// The app makes these itself, mechanically, from the Markdown filing copies
// the package step wrote, so the Word text is exactly the checked text.
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';
import { writeInside, removeInside } from './safe-write.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Text with formatting marks removed and every character kept: code spans
// stay literal (x**2 stays x**2) and escapes resolve to the character.
function plain(src) {
  const walk = (tokens) =>
    tokens
      .map((t) => {
        if (t.type === 'codespan') return t.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (t.tokens?.length) return walk(t.tokens);
        if (t.type === 'escape') return t.text;
        if (t.type === 'br') return ' ';
        return t.raw;
      })
      .join('');
  return walk(Lexer.lexInline(src));
}

const NUMBERED = /^\s*\d+[.)]\s/;

function paragraphs(md) {
  const out = [];
  const font = { font: 'Times New Roman', size: 24 };
  const spacing = { line: 360, after: 120 };
  for (const block of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    const h = lines[0].match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      // Heading text is kept exactly as written ("5 mW" must stay "5 mW").
      out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing, children: [new TextRun({ ...font, bold: true, text: plain(h[1]) })] }));
      lines.shift();
    }
    // A numbered claim always starts its own paragraph; an indented line (a
    // claim element) keeps its own line; other lines join into one paragraph.
    let cur = null;
    const flush = () => cur && out.push(new Paragraph({ spacing, indent: cur.indent ? { left: 720 } : undefined, children: [new TextRun({ ...font, text: cur.text })] }));
    for (const l of lines) {
      const numbered = NUMBERED.test(l);
      const indented = !numbered && /^\s{2,}\S/.test(l);
      const text = plain(l.trim());
      if (indented || numbered || !cur) {
        flush();
        cur = { text, indent: indented };
      } else cur.text += ' ' + text;
    }
    flush();
  }
  return out;
}

// The three documents the patent office takes as Word files, by the names the
// package step is told to use.
export const DOCX_SOURCES = [
  ['claims', /^claims?\.md$/i],
  ['description', /^(specification|description)\.md$/i],
  ['abstract', /^abstract\.md$/i],
];

// Rewrites every Word copy from its Markdown source, inside the invention
// folder only. Returns { name.docx: sha of the Markdown it was made from }.
// Throws with a plain reason; a source that changes while it is converted is
// refused rather than paired with Word text it no longer matches.
export async function writeDocxCopies(folder, filingRel) {
  const dir = path.join(folder, filingRel);
  const names = readdirSync(dir);
  const made = {};
  for (const [word, re] of DOCX_SOURCES) {
    const name = names.find((n) => re.test(n));
    if (!name) throw new Error(`The ${word} source file (.md) is missing. Run step 7 again.`);
    const src = path.join(dir, name);
    if (!lstatSync(src).isFile()) throw new Error(`The ${word} source is a link. Replace it with a file copy.`);
    const outRel = path.join(filingRel, name.replace(/\.md$/i, '.docx'));
    removeInside(folder, outRel);
    const md = readFileSync(src, 'utf8');
    const doc = new Document({
      sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: paragraphs(md) }],
    });
    const buf = await Packer.toBuffer(doc);
    if (sha(readFileSync(src, 'utf8')) !== sha(md)) throw new Error(`The ${word} source changed during conversion. Run step 7 again.`);
    writeInside(folder, outRel, buf);
    made[path.basename(outRel)] = sha(md);
  }
  return made;
}

// Plain words for each Word copy that is missing or no longer made from its
// Markdown source as it is now. `pairs` is what writeDocxCopies returned.
// Never throws: a file that cannot be read counts as a problem.
export function docxProblems(dir, pairs = {}) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {}
  const out = [];
  for (const [word, re] of DOCX_SOURCES) {
    const name = names.find((n) => re.test(n));
    if (!name) {
      out.push(`the ${word} source file (.md)`);
      continue;
    }
    const docx = name.replace(/\.md$/i, '.docx');
    let ok = false;
    try {
      ok = names.includes(docx) && lstatSync(path.join(dir, docx)).isFile() && pairs[docx] === sha(readFileSync(path.join(dir, name), 'utf8'));
    } catch {}
    if (!ok) out.push(`a current Word copy of the ${word} (run step 7 to create it)`);
  }
  return out;
}
