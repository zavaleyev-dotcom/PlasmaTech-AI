/** Layout rules for the technological card in DOCX/PDF - pure and dependency-free, so the document model
 *  (which decides what goes where) and the export (which builds the tables) share one set of numbers
 *  without touching the general renderer.
 *
 *  WHY THESE NUMBERS (measured on the real PDF renderer: A4 landscape, 56 pt margins, DejaVu Sans 8 pt):
 *   - usable page area 729.9 x 483.3 pt; one text line is 9.31 pt, so a page holds about 49 lines
 *     (less the repeated header row);
 *   - DejaVu Sans is wide: mixed Latin/Cyrillic text averages ~6.4 pt per character (e.g. 21.9
 *     characters per line in a 140 pt cell), and CAPITAL Cyrillic needs up to ~7.2 pt;
 *   - the renderer moves a row to the next page only if it fits there; a row taller than a whole page
 *     overflows and its continuation has no header and no step context.
 *  So two limits are used, both far below the ~49-line hazard:
 *   - CARD_CELL_LINE_BUDGET (16 lines = 149 pt = 31% of the page, estimated with the TYPICAL width): a
 *     card cell longer than this moves to a detail table. It keeps four ordinary assignments (~13-16
 *     lines) inline as before and moves five (~20 lines) out;
 *   - CARD_ROW_LINE_LIMIT (25 lines = 233 pt, estimated with the WORST-CASE width, i.e. never an
 *     under-estimate): a table row taller than this is split into continuation rows. That is the
 *     safety net for a single enormous value, which no table layout can otherwise keep on one page. */

/** Usable width of a landscape A4 PDF page (841.9 pt minus the renderer's 56 pt side margins). */
export const PDF_LANDSCAPE_CONTENT_WIDTH_PT = 729.9;
/** Usable width of a portrait A4 PDF page (595.3 pt minus the renderer's 56 pt side margins) - for tables of portrait documents. */
export const PDF_PORTRAIT_CONTENT_WIDTH_PT = 483.3;
/** The renderer lays text out 6 pt narrower than its column (3 pt padding on each side). */
export const CELL_PADDING_PT = 6;
export const TYPICAL_CHAR_PT = 6.4;
export const WORST_CHAR_PT = 7.2;
export const CARD_CELL_LINE_BUDGET = 16;
export const CARD_ROW_LINE_LIMIT = 25;

/** Relative column widths of the card, of its coating-layer table and of the two detail tables (each with a variant that has a
 *  "Слой" column after the step name). Card columns: № | Операция | Время | Темп. | Давление | Газы | Источники | Bias |
 *  Прочие параметры | Описание. */
export const CARD_COLUMN_WEIGHTS = [3, 11, 5, 6, 8, 17, 26, 5, 10, 9] as const;
export const CARD_GAS_COLUMN = 5;
export const CARD_SOURCE_COLUMN = 6;
/** № эт. | Этап | Слой | Материал | Толщина | Время | Темп. | Давл. | Bias | Вращ. / расст. | Источники | Газы */
export const LAYER_TABLE_WEIGHTS = [4, 12, 4, 8, 7, 6, 6, 6, 5, 8, 17, 17] as const;
export const LAYER_SOURCE_COLUMN = 10;
export const LAYER_GAS_COLUMN = 11;
export const SOURCE_DETAIL_WEIGHTS = [5, 9, 13, 14, 10, 20, 14, 15] as const;
export const GAS_DETAIL_WEIGHTS = [6, 16, 12, 16, 10, 16, 24] as const;
export const SOURCE_DETAIL_LAYER_WEIGHTS = [5, 9, 4, 12, 14, 10, 19, 13, 14] as const;
export const GAS_DETAIL_LAYER_WEIGHTS = [6, 16, 4, 12, 16, 10, 16, 24] as const;

export function columnWidthPt(weights: readonly number[], index: number, totalWidthPt: number = PDF_LANDSCAPE_CONTENT_WIDTH_PT): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  return Math.max(1, totalWidthPt * weights[index] / total - CELL_PADDING_PT);
}

/** Number of text lines `text` needs in a column `widthPt` wide, simulating word wrap at `charPt` per
 *  character (a word longer than a line is broken, as the renderer does). Every whitespace character
 *  (space, TAB, ...) occupies one character cell; CRLF, a lone CR and LF each start one new line. Empty text is one line. */
export function estimateLines(text: string, widthPt: number, charPt: number): number {
  const capacity = Math.max(1, Math.floor(widthPt / charPt));
  let lines = 0;
  // the PDF boundary turns CRLF and a lone CR into LF (pdfText in document-export.ts): count them the same way
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let used = 0;
    let count = 1;
    for (const token of paragraph.match(/\s+|\S+/g) ?? []) {
      if (/^\s/.test(token)) {
        // a run of blanks that does not fit hangs at the line end and wraps; a very long run takes whole lines
        if (used + token.length <= capacity) used += token.length;
        else { count += Math.floor((used + token.length) / capacity); used = 0; }
      } else if (token.length > capacity) {
        if (used > 0) count += 1;
        count += Math.ceil(token.length / capacity) - 1;
        used = token.length % capacity || capacity;
      } else if (used + token.length <= capacity) used += token.length;
      else { count += 1; used = token.length; }
    }
    lines += count;
  }
  return lines;
}

/** Cuts `text` into CONTIGUOUS substrings that each need at most `maxLines` lines (worst-case width).
 *  Nothing is removed, added, trimmed or normalised: `chunkText(t, ...).join('') === t` for every text,
 *  including blanks, TABs, blank lines and words longer than a piece. A piece ends after a whitespace
 *  character when one is available in the last third of the piece, otherwise it is cut at the limit
 *  (inside a long word); it never splits a surrogate pair, a CR LF pair or a character from its
 *  combining mark. */
export function chunkText(text: string, widthPt: number, charPt: number, maxLines: number): string[] {
  if (text === '') return [''];
  const fits = (from: number, to: number) => estimateLines(text.slice(from, to), widthPt, charPt) <= maxLines;
  const safeCut = (at: number) => {
    let cut = at;
    // never between a surrogate pair, CR and LF, or a base character and its combining mark
    while (cut > 0 && cut < text.length && (/[\uDC00-\uDFFF]/.test(text[cut]) || (text[cut] === '\n' && text[cut - 1] === '\r') || /\p{M}/u.test(text[cut]))) cut -= 1;
    return cut;
  };
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (fits(start, text.length)) { pieces.push(text.slice(start)); break; }
    // largest end that still fits (the estimate grows with the text, so a binary search finds it)
    let low = start + 1;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(start, mid)) low = mid; else high = mid - 1;
    }
    let end = low;
    const blank = text.slice(start, end).search(/\s(?=\S*$)/); // last whitespace inside the piece
    if (blank >= 0 && start + blank + 1 > start + (end - start) * 2 / 3) end = start + blank + 1;
    let cut = safeCut(end);
    if (cut <= start) cut = Math.min(text.length, start + Math.max(1, end - start)); // a lone unbreakable unit: progress anyway
    pieces.push(text.slice(start, cut));
    start = cut;
  }
  return pieces;
}

/** "[k/n] " is pure decoration: exactly this prefix (and the single space after it) is added to each piece
 *  and nothing else. */
export const CHUNK_MARKER_RE = /^\[\d+\/\d+\] /;

/** The original value from the cells of a split row, in order: drop the marker prefix of each piece and
 *  concatenate with NOTHING in between (the pieces are contiguous substrings of the original). */
export function joinChunkCells(cells: readonly string[]): string {
  return cells.map(cell => cell.replace(CHUNK_MARKER_RE, '')).join('');
}

export const CONTINUATION_CELL = '(см. выше)';

/** Safety net: a row that could be taller than CARD_ROW_LINE_LIMIT is split into several rows. Every
 *  continuation row repeats the `identityColumns` (step number, step name, source / line) verbatim;
 *  each over-long cell is cut into pieces marked "[k/n]", and the other cells of a continuation row say
 *  "(см. выше)" - never a copy of a value, never an empty cell that could read as "no value". Rows that
 *  are not too tall are returned untouched. */
export function splitTallRows(rows: string[][], weights: readonly number[], identityColumns: readonly number[], totalWidthPt: number = PDF_LANDSCAPE_CONTENT_WIDTH_PT): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    const lines = row.map((cell, i) => estimateLines(cell, columnWidthPt(weights, i, totalWidthPt), WORST_CHAR_PT));
    const tall = lines.map((n, i) => (n > CARD_ROW_LINE_LIMIT ? i : -1)).filter(i => i >= 0);
    if (tall.length === 0) { out.push(row); continue; }
    const chunks = new Map(tall.map(i => [i, chunkText(row[i], columnWidthPt(weights, i, totalWidthPt), WORST_CHAR_PT, CARD_ROW_LINE_LIMIT - 1)]));
    const count = Math.max(...[...chunks.values()].map(c => c.length));
    for (let r = 0; r < count; r++) {
      out.push(row.map((cell, i) => {
        const pieces = chunks.get(i);
        if (pieces) return r < pieces.length ? `[${r + 1}/${pieces.length}] ${pieces[r]}` : CONTINUATION_CELL;
        if (identityColumns.includes(i)) return cell;
        return r === 0 ? cell : CONTINUATION_CELL;
      }));
    }
  }
  return out;
}
