/** Pure (no server-only, no I/O) parser for the small Markdown subset that AI-generated
 *  scientific drafts actually use, so DOCX/PDF export can turn it into real document structure
 *  instead of leaving "**Abstract:**" and "## Methods" as literal text.
 *
 *  Supported: fenced code blocks (``` or ~~~) and `inline code`, kept character-for-character
 *  (nothing inside code is ever interpreted as Markdown); "#"-"######" headings; a line that is ONLY a bold span ("**1. Introduction**",
 *  "**Abstract:**") as a heading; **bold** and *italic* inline; "-", "*", "•" bullets and
 *  "1." / "1)" numbered items (their numbers are kept exactly as written); "---" rules are
 *  dropped (a separator, not content).
 *
 *  Everything else is kept VERBATIM as paragraph text - tables, code, links, HTML, stray or
 *  unbalanced asterisks, "5*3". The parser never rewrites, reorders or removes anything that
 *  carries content; it only strips the marker characters of the constructs it understands. */

export interface InlineRun { text: string; bold?: boolean; italic?: boolean; code?: boolean }
export interface ListItem { marker: string; runs: InlineRun[] }

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; mdLevel: number; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; items: ListItem[] }
  /** A fenced code block: `text` is the exact content between the fences (newlines, spaces and
   *  tabs untouched). */
  | { kind: 'code'; text: string; lang?: string }
  /** A leading "**Title:** …" / "**Название:** …" line - reported so the exporter can use it as
   *  the document title instead of repeating it in the body. */
  | { kind: 'title-label'; text: string };

// Bold/italic delimiters must not touch a letter, digit or another "*" on the outside: that
// keeps "2**3**2" and "a*b*c" (arithmetic, not emphasis) literal - when in doubt, keep the text.
const INLINE_RE = /(?<![\p{L}\p{N}*])\*\*([^*\n]+?)\*\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\p{L}\p{N}*])/gu;

function parseEmphasis(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: text.slice(last, index) });
    runs.push(match[1] !== undefined ? { text: match[1], bold: true } : { text: match[2], italic: true });
    last = index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Splits `text` into code spans (a run of N backticks, content, the SAME run of N backticks -
 *  CommonMark's rule, so ``a`b`` works) and the text between them. An unmatched backtick run
 *  is ordinary text. Code content is never touched. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    let n = 0;
    while (text[i + n] === '`') n++;
    let close = -1;
    for (let j = i + n; j < text.length; j++) {
      if (text[j] !== '`') continue;
      let m = 0;
      while (text[j + m] === '`') m++;
      if (m === n) { close = j; break; }
      j += m - 1;
    }
    if (close === -1) { i += n; continue; }
    if (i > plainStart) runs.push(...parseEmphasis(text.slice(plainStart, i)));
    runs.push({ text: text.slice(i + n, close), code: true });
    i = close + n;
    plainStart = i;
  }
  if (plainStart < text.length) runs.push(...parseEmphasis(text.slice(plainStart)));
  return runs.length > 0 ? runs : [{ text }];
}

export function runsToPlainText(runs: InlineRun[]): string { return runs.map(r => r.text).join(''); }

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/u;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/u;
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

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') { flushAll(); continue; }
    const wasFirst = firstContentLine;
    firstContentLine = false;

    // Fenced code: everything up to the matching closing fence (or the end of the text) is
    // taken verbatim - no heading, list, emphasis or rule detection happens inside it.
    const fence = FENCE_OPEN_RE.exec(rawLine);
    if (fence) {
      flushAll();
      const marker = fence[2];
      const body: string[] = [];
      let next = index + 1;
      for (; next < lines.length; next++) {
        const closing = FENCE_CLOSE_RE.exec(lines[next]);
        if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) break;
        body.push(lines[next]);
      }
      blocks.push({ kind: 'code', text: body.join('\n'), ...(fence[3].trim() ? { lang: fence[3].trim() } : {}) });
      index = next;
      continue;
    }

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
    else if (block.kind === 'code') out.push(block.text);
    else out.push(block.items.map(i => `${i.marker} ${runsToPlainText(i.runs)}`).join('\n'));
  }
  return out;
}

// A number with its unit ("−50 V", "5 mPa"): the part of a title whose letter case can carry
// meaning (mPa vs MPa, mV vs MV, K vs k).
const QUANTITY_RE = /[+\-\u2212]?\d[\d.,]*\s*[\p{L}°%µμ]+/gu;

/** Only presentation is normalized: Markdown emphasis markers, Unicode dashes/minus to "-",
 *  curly quotes, runs of whitespace (incl. no-break/thin spaces) and trailing ".:;". Digits,
 *  signs ("+"/"-"), decimal separators, units and every other character are kept exactly, so
 *  "−50 V" and "+50 V", "0.5" and "05", "0,5" and "0.5", "5 mV" and "5 V" stay different. */
function canonicalTitle(text: string): string {
  return runsToPlainText(parseInline(text)).replace(/^#+\s*/, '').normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ').trim().replace(/[.:;]+$/, '').trim();
}

/** True only when two titles are the same title written with different presentation. Used to
 *  decide whether a title in the body may be dropped as a duplicate of the document title -
 *  so any doubt must answer false (the title is then kept, never lost). Letter-case
 *  differences count as presentation only when every number+unit in the two titles is
 *  case-identical. */
export function titlesEquivalent(a: string, b: string): boolean {
  const left = canonicalTitle(a);
  const right = canonicalTitle(b);
  if (left === right) return true;
  if (left.toLocaleLowerCase() !== right.toLocaleLowerCase()) return false;
  return JSON.stringify(left.match(QUANTITY_RE) ?? []) === JSON.stringify(right.match(QUANTITY_RE) ?? []);
}
