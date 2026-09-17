import { createHash } from 'node:crypto';
import type { TextChunk, TextPage } from './types';
export const wordCount = (text: string) => text.match(/\S+/gu)?.length ?? 0;
/** Sentence boundaries first; extremely long sentences alone fall back to word boundaries. */
export function chunkPages(documentId: string, pages: TextPage[], targetWords = 1200, overlapWords = 150): TextChunk[] {
  if (targetWords < 20 || overlapWords < 0 || overlapWords >= targetWords / 2) throw new Error('Invalid chunk parameters');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const units: { text: string; words: number; page: number }[] = [];
  for (const page of pages) for (const sentence of segmenter.segment(page.text)) {
    const words = sentence.segment.trim().split(/\s+/u).filter(Boolean);
    for (let i = 0; i < words.length; i += targetWords) {
      const part = words.slice(i, i + targetWords);
      units.push({ text: part.join(' '), words: part.length, page: page.page });
    }
  }
  const chunks: TextChunk[] = [];
  for (let start = 0; start < units.length;) {
    let end = start; let size = 0;
    while (end < units.length && (size === 0 || size + units[end].words <= Math.ceil(targetWords * 1.25))) {
      size += units[end++].words;
      if (size >= targetWords) break;
    }
    const selected = units.slice(start, end); const text = selected.map(s => s.text).join(' ');
    const ordinal = chunks.length;
    chunks.push({ id: createHash('sha256').update(`${documentId}:${ordinal}:${text}`).digest('hex'), documentId, ordinal, pageStart: selected[0].page, pageEnd: selected.at(-1)!.page, text, wordCount: size });
    if (end === units.length) break;
    let next = end; let overlap = 0;
    while (next > start + 1 && overlap + units[next - 1].words <= overlapWords) overlap += units[--next].words;
    start = next;
  }
  return chunks;
}
