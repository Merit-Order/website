// The comparison section of the feature sheet, read from the copy scripts/sync-docs.mjs pulled from the main repo,
// so the Compare page always shows the main repo's table, notes and date.
import md from '../content/docs/docs/feature-sheet.md?raw';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Inline markdown: code, links, bold, italics. Enough for the feature sheet. */
export function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${h.startsWith("#") ? "/docs/feature-sheet/" + h : h}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

const section = md.split(/^## How it compares\s*$/m)[1].split(/^## /m)[0];
const lines = section.split('\n');

export const intro = inline(section.trim().split(/\n\n/)[0].replace(/\n/g, ' '));
export const checkedOn = (intro.match(/Checked on ([^.]+? \d{4})/) || [])[1] || '';

const tableLines = lines.filter((l) => l.startsWith('|'));
const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
export const header = cells(tableLines[0]);
export const rows = tableLines.slice(2).map(cells);

// Paragraphs between the table and the notes (Martian), the numbered notes, and the closing paragraphs and lists.
const afterTable = section.slice(section.lastIndexOf(tableLines[tableLines.length - 1]) + tableLines[tableLines.length - 1].length);
const [beforeNotes, notesAndRest] = afterTable.split(/\*\*Notes\*\*/);
export const aside = beforeNotes.trim().split(/\n\n/).filter(Boolean).map((p) => inline(p.replace(/\n/g, ' ')));

const noteBlock = notesAndRest.split(/\n\*\*What this shows\.\*\*/)[0];
export const notes = noteBlock.split(/\n(?=\d+\. )/).map((n) => n.trim()).filter((n) => /^\d+\. /.test(n))
  .map((n) => ({ n: Number(n.match(/^(\d+)/)[1]), html: inline(n.replace(/^\d+\.\s+/, '').replace(/\s*\n\s*/g, ' ')) }));

/** The rest of the section as blocks: paragraphs and bullet lists, bold lead-ins kept. */
export const closing = ('**What this shows.**' + (notesAndRest.split(/\n\*\*What this shows\.\*\*/)[1] || ''))
  .trim().split(/\n\n+/).map((block) => {
    if (/^- /.test(block)) {
      return { list: block.split(/\n(?=- )/).map((li) => inline(li.replace(/^- /, '').replace(/\s*\n\s*/g, ' '))) };
    }
    return { p: inline(block.replace(/\n/g, ' ')) };
  });

/** A cell: ✓ / ✗ / partial, with note references "(1)" turned into links to the notes. */
export function cell(text) {
  return inline(text).replace(/\((\d+)\)/g, '<a class="fn" href="#note-$1" aria-label="note $1">($1)</a>');
}
