/** Pure (no server-only, no I/O) parser for the small Markdown subset that AI-generated
 *  scientific drafts actually use, so DOCX/PDF export can turn it into real document structure
 *  instead of leaving "**Abstract:**" and "## Methods" as literal text.
 *
 *  Supported: "#"-"######" headings; a line that is ONLY a bold span ("**1. Introduction**",
 *  "**Abstract:**") as a heading; **bold** and *italic* inline; "-", "*", "•" bullets and
 *  "1." / "1)" numbered items (their numbers are kept exactly as written); "---" rules are
 *  dropped (a separator, not content).
 *
 *  Everything else is kept VERBATIM as paragraph text - tables, code, links, HTML, stray or
 *  unbalanced asterisks, "5*3". The parser never rewrites, reorders or removes anything that
 *  carries content; it only strips the marker characters of the constructs it understands. */

export interface InlineRun { text: string; bold?: boolean; italic?: boolean }
export interface ListItem { marker: string; runs: InlineRun[] }

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; mdLevel: number; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; items: ListItem[] }
  /** A leading "**Title:** …" / "**Название:** …" line - reported so the exporter can use it as
   *  the document title instead of repeating it in the body. */
  | { kind: 'title-label'; text: string };

const INLINE_RE = /\*\*([^*\n]+?)\*\*|(?<![\p{L}\p{N}*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\p{L}\p{N}*])/gu;

export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index) });
    runs.push(match[1] !== undefined ? { text: match[1], bold: true } : { text: match[2], italic: true });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length > 0 ? runs : [{ text }];
}

export function runsToPlainText(runs: InlineRun[]): string { return runs.map(r => r.text).join(''); }

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const BOLD_LINE_RE = /^\*\*([^*]+?)\*\*\s*:?\s*$/u;
const TITLE_LABEL_RE = /^\*\*(?:Title|Название|Заголовок)\s*:?\s*\*\*\s*:?\s*(.+)$/iu;
const LIST_RE = /^[ \t]*(?:([-*•])|(\d{1,3}[.)]))\s+(.+)$/u;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)*)[.)]?\s/u;

function boldLineHeadingLevel(inner: string): 1 | 2 | 3 | null {
  const text = inner.trim().replace(/:$/, '').trim();
  if (!text || text.length > 120 || /[.!?]$/.test(text)) return null;
  const numbered = NUMBERED_HEADING_RE.exec(text);
  if (!numbered) return 1;
  return Math.min(3, numbered[1].split('.').length) as 1 | 2 | 3;
}

function mdLevelToDocLevel(mdLevel: number): 1 | 2 | 3 {
  return mdLevel <= 2 ? 1 : mdLevel === 3 ? 2 : 3;
}

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] | null = null;
  let firstContentLine = true;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.length > 0) blocks.push({ kind: 'list', items: list });
    list = null;
  };
  const flushAll = () => { flushParagraph(); flushList(); };

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') { flushAll(); continue; }
    const wasFirst = firstContentLine;
    firstContentLine = false;

    if (RULE_RE.test(line)) { flushAll(); continue; }

    const label = wasFirst ? TITLE_LABEL_RE.exec(line.trim()) : null;
    if (label) { flushAll(); blocks.push({ kind: 'title-label', text: runsToPlainText(parseInline(label[1])).trim() }); continue; }

    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      flushAll();
      const mdLevel = heading[1].length;
      blocks.push({ kind: 'heading', level: mdLevelToDocLevel(mdLevel), mdLevel, runs: parseInline(heading[2]) });
      continue;
    }

    const boldOnly = BOLD_LINE_RE.exec(line.trim());
    const boldLevel = boldOnly ? boldLineHeadingLevel(boldOnly[1]) : null;
    if (boldOnly && boldLevel) {
      flushAll();
      blocks.push({ kind: 'heading', level: boldLevel, mdLevel: 0, runs: [{ text: boldOnly[1].trim().replace(/:$/, '').trim() }] });
      continue;
    }

    const item = LIST_RE.exec(line);
    if (item) {
      flushParagraph();
      list = list ?? [];
      list.push({ marker: item[1] ? '•' : item[2], runs: parseInline(item[3]) });
      continue;
    }

    // Indented continuation of the previous list item.
    if (list && /^\s+\S/.test(rawLine)) {
      const last = list[list.length - 1];
      last.runs = [...last.runs, ...parseInline(` ${line.trim()}`)];
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }
  flushAll();
  return blocks;
}

/** Plain-text rendering of blocks (markers stripped, structure kept as lines) - the fallback
 *  `paragraphs` view of a section for consumers that do not render rich blocks. */
export function blocksToPlainParagraphs(blocks: MdBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') out.push(runsToPlainText(block.runs));
    else if (block.kind === 'paragraph') out.push(runsToPlainText(block.runs));
    else if (block.kind === 'title-label') out.push(block.text);
    else out.push(block.items.map(i => `${i.marker} ${runsToPlainText(i.runs)}`).join('\n'));
  }
  return out;
}

/** Comparison form for "is this the same title": case, punctuation, markup and spacing
 *  insensitive, Unicode-normalized. */
export function normalizeForCompare(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[*_#`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
