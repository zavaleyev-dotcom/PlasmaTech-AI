import type { EmbeddingOverview, EmbeddingProvider } from '@/services/embeddings/types';
import type { EmbeddingStore } from '@/services/embeddings/store';
import { semanticSearch } from '@/services/embeddings/search';
import type { TextStore } from '@/services/library-text/store';
import { hydrateChunk } from './hydrate';
import { retrieveChunks } from './retrieve';
import { RRF_K, RRF_LEXICAL_WEIGHT, RRF_SEMANTIC_WEIGHT } from './types';
import type { FusedChunk, RetrievalDiagnostics, RetrievalMode, RetrievedChunk } from './types';

/** Rank-based fusion (weighted Reciprocal Rank Fusion), never a direct sum of BM25 and
 *  cosine similarity - those live on incomparable scales. Each list contributes
 *  weight/(RRF_K+rank) for a chunk at that rank; a chunk found by both lists gets both
 *  contributions added. Deduplicates by chunkId, is fully deterministic for a given pair of
 *  input orderings, and breaks ties by chunkId so the final order never depends on object
 *  identity or Map iteration order. Exported standalone so fusion behavior is testable
 *  without any store, provider, or network call. */
export function fuseRankings(lexical: readonly RetrievedChunk[], semantic: readonly RetrievedChunk[], limit: number): FusedChunk[] {
  const byId = new Map<string, FusedChunk>();
  lexical.forEach((chunk, i) => {
    const rank = i + 1;
    byId.set(chunk.chunkId, {
      ...chunk, lexicalRank: rank, semanticRank: null, lexicalScore: chunk.score, semanticScore: null,
      fusedRank: 0, foundBy: 'lexical', score: RRF_LEXICAL_WEIGHT / (RRF_K + rank),
    });
  });
  semantic.forEach((chunk, i) => {
    const rank = i + 1;
    const contribution = RRF_SEMANTIC_WEIGHT / (RRF_K + rank);
    const existing = byId.get(chunk.chunkId);
    if (existing) byId.set(chunk.chunkId, { ...existing, semanticRank: rank, semanticScore: chunk.score, foundBy: 'both', score: existing.score + contribution });
    else byId.set(chunk.chunkId, { ...chunk, lexicalRank: null, semanticRank: rank, lexicalScore: null, semanticScore: chunk.score, fusedRank: 0, foundBy: 'semantic', score: contribution });
  });
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
  ranked.forEach((chunk, i) => { chunk.fusedRank = i + 1; });
  return ranked.slice(0, limit);
}

export interface HybridRetrieveOptions {
  textStore: TextStore;
  mode: RetrievalMode;
  question: string;
  limit: number;
  /** null/undefined (either) means semantic search is unavailable; hybrid/semantic then
   *  safely degrade to lexical-only, with the reason recorded in diagnostics.fallbackReason -
   *  never a crash. */
  embeddingProvider?: EmbeddingProvider | null;
  embeddingStore?: EmbeddingStore | null;
  /** Precomputed once by the caller (askLibrary/service.ts) so diagnostics can report
   *  embedding coverage/staleness without an extra query per retrieval call. */
  embeddingOverview?: EmbeddingOverview | null;
}

export interface HybridRetrieveResult {
  mode: RetrievalMode;
  chunks: FusedChunk[];
  diagnostics: RetrievalDiagnostics;
}

async function computeSemanticChunks(textStore: TextStore, provider: EmbeddingProvider, store: EmbeddingStore, question: string, limit: number): Promise<{ chunks: RetrievedChunk[]; ms: number; error: string | null }> {
  const start = Date.now();
  try {
    const queryVector = await provider.embedQuery(question);
    const hits = semanticSearch(store, provider.id, provider.model, provider.dimension, queryVector, limit);
    const chunks = hits.map(hit => hydrateChunk(textStore, hit.chunkId, hit.documentId, hit.score)).filter((c): c is RetrievedChunk => c !== null);
    return { chunks, ms: Date.now() - start, error: null };
  } catch (error) {
    // Never let a raw provider/store error (which may embed a URL, key, or stack detail)
    console.error('[rag] semantic search failed', error);
    return { chunks: [], ms: Date.now() - start, error: 'Семантический поиск временно недоступен.' };
  }
}

/**
 * Three modes:
 *   - 'lexical'  - FTS5 only (retrieveChunks(), unchanged from the pre-embeddings stage).
 *   - 'semantic' - vector search only.
 *   - 'hybrid'   - both, fused by rank (fuseRankings above). Default.
 *
 * Safe degradation: if the embedding provider/store is missing, empty, or the semantic
 * search call itself fails, 'hybrid' and 'semantic' both fall back to lexical-only rather
 * than throwing or returning nothing - diagnostics.fallbackReason always explains why, and
 * the result's `mode` reports what was ACTUALLY used, never silently pretending the request
 * was honored as asked.
 *
 * Returns FusedChunk[], which is structurally a RetrievedChunk[] (buildContext/citations in
 * context.ts/citations.ts accept it completely unchanged) - swapping in this retrieval layer
 * never touches context building, grounding validation, or the answer-provider abstraction.
 */
export async function hybridRetrieve(options: HybridRetrieveOptions): Promise<HybridRetrieveResult> {
  const { textStore, mode: requestedMode, question, limit, embeddingProvider, embeddingStore, embeddingOverview } = options;
  const totalStart = Date.now();

  const semanticReady = !!(embeddingProvider && embeddingStore
    && embeddingStore.currentCount(embeddingProvider.id, embeddingProvider.model, embeddingProvider.dimension) > 0);

  let fallbackReason: string | null = null;
  if (requestedMode !== 'lexical' && !semanticReady) {
    fallbackReason = !embeddingProvider ? 'Семантический провайдер не настроен.'
      : !embeddingStore ? 'Индекс эмбеддингов недоступен.'
      : 'Индекс эмбеддингов пуст. Постройте его в разделе «Моя библиотека».';
  }

  let lexicalChunks: RetrievedChunk[] = [];
  let ftsMs = 0;
  const needsLexicalNow = requestedMode === 'lexical' || requestedMode === 'hybrid' || fallbackReason !== null;
  if (needsLexicalNow) {
    const start = Date.now();
    lexicalChunks = retrieveChunks(textStore, question, limit);
    ftsMs = Date.now() - start;
  }

  let semanticChunks: RetrievedChunk[] = [];
  let semanticMs = 0;
  if ((requestedMode === 'semantic' || requestedMode === 'hybrid') && semanticReady && embeddingProvider && embeddingStore) {
    const result = await computeSemanticChunks(textStore, embeddingProvider, embeddingStore, question, limit);
    semanticChunks = result.chunks; semanticMs = result.ms;
    if (result.error) {
      fallbackReason = result.error;
      if (requestedMode === 'semantic' && !lexicalChunks.length) {
        const start = Date.now();
        lexicalChunks = retrieveChunks(textStore, question, limit);
        ftsMs += Date.now() - start;
      }
    }
  }

  const effectiveMode: RetrievalMode = requestedMode !== 'lexical' && semanticChunks.length === 0 && fallbackReason ? 'lexical' : requestedMode;
  let fused: FusedChunk[];
  if (effectiveMode === 'lexical') fused = fuseRankings(lexicalChunks, [], limit);
  else if (effectiveMode === 'semantic') fused = fuseRankings([], semanticChunks, limit);
  else fused = fuseRankings(lexicalChunks, semanticChunks, limit);

  const totalMs = Date.now() - totalStart;
  const diagnostics: RetrievalDiagnostics = {
    mode: effectiveMode, ftsCandidates: lexicalChunks.length, semanticCandidates: semanticChunks.length,
    fusedCandidates: fused.length, ftsMs, semanticMs, totalMs,
    embeddingProviderId: embeddingProvider?.id ?? null, embeddingModel: embeddingProvider?.model ?? null,
    embeddingCoverage: embeddingOverview && embeddingOverview.stats.totalChunks > 0 ? embeddingOverview.stats.embeddedChunks / embeddingOverview.stats.totalChunks : null,
    staleEmbeddingsCount: embeddingOverview?.stats.staleChunks ?? null,
    fallbackReason,
  };
  return { mode: effectiveMode, chunks: fused, diagnostics };
}
