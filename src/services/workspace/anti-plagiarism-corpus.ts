/** Server-only orchestration: runs the pure similarity pipeline (anti-plagiarism.ts) against
 *  the EXISTING local library text/FTS index, read-only. Reuses the project's own lexical
 *  retrieval (src/services/rag/retrieve.ts) for bounded candidate lookup - the exact same
 *  FTS5 index already built for "Спросить библиотеку", no new index, no schema change, no
 *  embeddings, no OPENAI_API_KEY. Every store call here is read-only (search/stats/records);
 *  nothing in this file ever writes to the library. */

import 'server-only';
import type { TextStore } from '@/services/library-text/store';
import { openTextStore } from '@/services/library-text';
import { retrieveChunks } from '@/services/rag/retrieve';
import type { RetrievedChunk } from '@/services/rag/types';
import {
  validateSimilarityInput, normalizeText, segmentSentences, segmentParagraphs, containmentScore, classifyMatch,
  pickBestSourceSentence, findSelfRepeats, dedupMatches, sortMatches, computeCoveredFraction,
  MAX_SEGMENTS_SENTENCES, MAX_SEGMENTS_PARAGRAPHS, MIN_SEGMENT_WORDS, CANDIDATES_PER_SEGMENT, MAX_REPORTED_MATCHES,
  SCOPE_DISCLAIMER,
  type SimilarityMatch, type SimilarityReport, type SimilarityScope,
} from './anti-plagiarism';

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

interface SegmentPosition { start: number; end: number }

/** F15: resolves each segment's REAL occurrence position within the normalized input text, in
 *  the same left-to-right order segmentSentences()/segmentParagraphs() themselves already
 *  produce them - a single forward-only cursor is enough (and correct) because of that
 *  ordering guarantee, so the SAME sentence/paragraph repeated later in the input resolves to
 *  its OWN later position, never the same first occurrence a plain indexOf() would keep
 *  finding. Position `null` (segment not locatable from the cursor onward, e.g. a Unicode
 *  normalization edge case) means the resulting match simply carries no position - never a
 *  guessed/wrong one - and computeCoveredFraction falls back to its own best-effort search. */
function resolveSegmentPositions(normalizedInput: string, segments: readonly string[]): (SegmentPosition | null)[] {
  let cursor = 0;
  return segments.map(segment => {
    const normalizedSegment = normalizeText(segment).toLocaleLowerCase();
    if (!normalizedSegment) return null;
    let start = normalizedInput.indexOf(normalizedSegment, cursor);
    if (start === -1) start = normalizedInput.indexOf(normalizedSegment); // defensive fallback only
    if (start === -1) return null;
    const end = start + normalizedSegment.length;
    cursor = end;
    return { start, end };
  });
}

function matchesAgainstCandidates(segment: string, candidates: RetrievedChunk[], position: SegmentPosition | null): SimilarityMatch[] {
  const found: SimilarityMatch[] = [];
  for (const chunk of candidates) {
    const score = containmentScore(segment, chunk.text);
    const type = classifyMatch(segment, chunk.text, score);
    if (!type) continue;
    found.push({
      type, inputSpan: segment, sourceSpan: pickBestSourceSentence(chunk.text, segment),
      documentId: chunk.documentId, documentTitle: chunk.title || chunk.filename, relativePath: chunk.relativePath,
      chunkId: chunk.chunkId, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, score,
      ...(position ? { inputStart: position.start, inputEnd: position.end } : {}),
    });
  }
  return found;
}

export interface CheckSimilarityOptions {
  /** Injected for tests; defaults to the real on-disk store via openTextStore(). */
  openStore?: () => Promise<TextStore>;
}

/** Runs the whole read-only pipeline: validate -> segment -> bounded FTS candidate retrieval
 *  per segment -> local containment scoring -> classify -> dedup -> honest scope report. Never
 *  touches OPENAI_API_KEY, never writes to the store, never performs unbounded work (segment
 *  counts and per-segment candidate counts are both capped by named constants). */
export async function checkSimilarity(inputText: string, options: CheckSimilarityOptions = {}): Promise<SimilarityReport> {
  validateSimilarityInput(inputText);
  const openStore = options.openStore ?? openTextStore;
  const store = await openStore();
  try {
    const corpusStats = store.stats();
    const corpusSize = { documents: corpusStats.documents, chunks: corpusStats.chunks };
    const corpusEmpty = corpusSize.chunks === 0;

    const sentences = segmentSentences(inputText).slice(0, MAX_SEGMENTS_SENTENCES);
    const paragraphs = segmentParagraphs(inputText).slice(0, MAX_SEGMENTS_PARAGRAPHS);

    // F14: self-repeat analysis looks only at the pasted text itself and must run regardless
    // of whether an external corpus exists - an empty corpus means zero EXTERNAL matches, it
    // says nothing about whether the user repeated a sentence within their own text.
    const selfRepeats = findSelfRepeats(sentences);

    // F15: resolve each sentence's/paragraph's real occurrence position ONCE, up front, in
    // their own natural document order - independent cursors, since sentences and paragraphs
    // are two separate (nested) segmentations of the same text.
    const normalizedInputForPositions = normalizeText(inputText).toLocaleLowerCase();
    const sentencePositions = resolveSegmentPositions(normalizedInputForPositions, sentences);
    const paragraphPositions = resolveSegmentPositions(normalizedInputForPositions, paragraphs);

    const seenDocumentIds = new Set<string>();
    const seenChunkIds = new Set<string>();
    const rawMatches: SimilarityMatch[] = [];

    if (!corpusEmpty) {
      for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];
        if (wordCount(sentence) < MIN_SEGMENT_WORDS) continue;
        const { chunks } = retrieveChunks(store, sentence, CANDIDATES_PER_SEGMENT);
        for (const chunk of chunks) { seenDocumentIds.add(chunk.documentId); seenChunkIds.add(chunk.chunkId); }
        rawMatches.push(...matchesAgainstCandidates(sentence, chunks, sentencePositions[i]));
      }
      for (let i = 0; i < paragraphs.length; i++) {
        const paragraph = paragraphs[i];
        if (wordCount(paragraph) < MIN_SEGMENT_WORDS) continue;
        const { chunks } = retrieveChunks(store, paragraph, CANDIDATES_PER_SEGMENT);
        for (const chunk of chunks) { seenDocumentIds.add(chunk.documentId); seenChunkIds.add(chunk.chunkId); }
        rawMatches.push(...matchesAgainstCandidates(paragraph, chunks, paragraphPositions[i]));
      }
    }

    const deduped = dedupMatches([...rawMatches, ...selfRepeats]);
    const sorted = sortMatches(deduped);
    const reported = sorted.slice(0, MAX_REPORTED_MATCHES);

    const scope: SimilarityScope = {
      corpusSize, corpusEmpty,
      documentsChecked: seenDocumentIds.size, chunksChecked: seenChunkIds.size,
      sentencesChecked: sentences.length, paragraphsChecked: paragraphs.length,
      exactMatches: deduped.filter(m => m.type === 'exact').length,
      nearExactMatches: deduped.filter(m => m.type === 'near_exact').length,
      similarMatches: deduped.filter(m => m.type === 'similar').length,
      selfRepeats: deduped.filter(m => m.type === 'self_repeat').length,
      coveredFraction: computeCoveredFraction(deduped, inputText),
    };

    return { matches: reported, scope, disclaimer: SCOPE_DISCLAIMER };
  } finally {
    store.close();
  }
}
