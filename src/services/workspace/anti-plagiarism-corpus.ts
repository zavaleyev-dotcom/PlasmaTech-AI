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
  validateSimilarityInput, segmentSentences, segmentParagraphs, containmentScore, classifyMatch,
  pickBestSourceSentence, findSelfRepeats, dedupMatches, sortMatches, computeCoveredFraction,
  MAX_SEGMENTS_SENTENCES, MAX_SEGMENTS_PARAGRAPHS, MIN_SEGMENT_WORDS, CANDIDATES_PER_SEGMENT, MAX_REPORTED_MATCHES,
  SCOPE_DISCLAIMER,
  type SimilarityMatch, type SimilarityReport, type SimilarityScope,
} from './anti-plagiarism';

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

function matchesAgainstCandidates(segment: string, candidates: RetrievedChunk[]): SimilarityMatch[] {
  const found: SimilarityMatch[] = [];
  for (const chunk of candidates) {
    const score = containmentScore(segment, chunk.text);
    const type = classifyMatch(segment, chunk.text, score);
    if (!type) continue;
    found.push({
      type, inputSpan: segment, sourceSpan: pickBestSourceSentence(chunk.text, segment),
      documentId: chunk.documentId, documentTitle: chunk.title || chunk.filename, relativePath: chunk.relativePath,
      chunkId: chunk.chunkId, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, score,
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
    if (corpusSize.chunks === 0) {
      return {
        matches: [],
        scope: {
          corpusSize, corpusEmpty: true, documentsChecked: 0, chunksChecked: 0,
          sentencesChecked: 0, paragraphsChecked: 0, exactMatches: 0, nearExactMatches: 0, similarMatches: 0, selfRepeats: 0,
          coveredFraction: 0,
        },
        disclaimer: SCOPE_DISCLAIMER,
      };
    }

    const sentences = segmentSentences(inputText).slice(0, MAX_SEGMENTS_SENTENCES);
    const paragraphs = segmentParagraphs(inputText).slice(0, MAX_SEGMENTS_PARAGRAPHS);

    const seenDocumentIds = new Set<string>();
    const seenChunkIds = new Set<string>();
    const rawMatches: SimilarityMatch[] = [];

    for (const sentence of sentences) {
      if (wordCount(sentence) < MIN_SEGMENT_WORDS) continue;
      const { chunks } = retrieveChunks(store, sentence, CANDIDATES_PER_SEGMENT);
      for (const chunk of chunks) { seenDocumentIds.add(chunk.documentId); seenChunkIds.add(chunk.chunkId); }
      rawMatches.push(...matchesAgainstCandidates(sentence, chunks));
    }
    for (const paragraph of paragraphs) {
      if (wordCount(paragraph) < MIN_SEGMENT_WORDS) continue;
      const { chunks } = retrieveChunks(store, paragraph, CANDIDATES_PER_SEGMENT);
      for (const chunk of chunks) { seenDocumentIds.add(chunk.documentId); seenChunkIds.add(chunk.chunkId); }
      rawMatches.push(...matchesAgainstCandidates(paragraph, chunks));
    }

    const selfRepeats = findSelfRepeats(sentences);
    const deduped = dedupMatches([...rawMatches, ...selfRepeats]);
    const sorted = sortMatches(deduped);
    const reported = sorted.slice(0, MAX_REPORTED_MATCHES);

    const scope: SimilarityScope = {
      corpusSize, corpusEmpty: false,
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
