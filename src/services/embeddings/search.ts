import type { EmbeddingStore } from './store';
import { cosineSimilarity, topK, validateEmbeddingVector } from './vector';
import type { VectorCache } from './cache';

export interface SemanticHit {
  chunkId: string;
  documentId: string;
  /** Cosine similarity in [-1, 1] (1 = identical direction). Not a calibrated probability. */
  score: number;
}

export interface SemanticSearchOutcome {
  hits: SemanticHit[];
  /** How many stored rows (for this provider/model/dimension) had a valid vector AND
   *  passed the consistency check, before top-K selection - i.e. how many were genuinely
   *  eligible to be ranked at all. */
  candidateCount: number;
  /** Stored rows whose vector failed validateEmbeddingVector (corrupted BLOB, wrong
   *  dimension, NaN/Infinity element, zero norm, ...) - never ranked, never candidates. */
  invalidVectorCount: number;
  /** Stored rows with a structurally valid vector that were excluded by the consistency
   *  check (orphaned chunk, mismatched document link, or a stale content hash) - see
   *  hybrid.ts's chunkConsistencyChecker. 0 when no consistency check was supplied. */
  inconsistentCount: number;
}

/**
 * Brute-force cosine-similarity search: no native extension, no separate vector database,
 * no additional system dependency - every vector matching the given provider/model/dimension
 * is loaded from the embedding store and compared against the query vector directly in JS.
 *
 * This is a deliberate, documented choice for this stage (see docs/architecture.md and the
 * benchmark script): it is the only vector-search approach that runs identically on the
 * target machines (Mac Intel and Windows) without compiling or shipping a native module or
 * running a separate server. Its cost is O(n) per query in both time and the memory needed
 * to hold all matching vectors at once; the benchmark measures this at increasing sample
 * sizes rather than assuming it scales to the full library.
 *
 * Every candidate is validated (validateEmbeddingVector) and, if `isConsistent` is supplied,
 * checked against it BEFORE ranking/top-K selection - a corrupted, orphaned, or stale row
 * can never occupy a top-K slot and push out a genuinely valid result; top-K only ever
 * chooses among rows that already passed both checks. Ranking itself uses a bounded
 * top-K selection (vector.ts's topK) instead of sorting every candidate, since only the
 * best `limit` are ever needed.
 *
 * `cache` (optional, see embeddings/cache.ts) skips re-reading and re-decoding every BLOB
 * from SQLite on every call - the dominant cost at scale - by reusing already-validated
 * vectors held in process memory. When supplied, `isConsistent` is STILL re-run against
 * every cached candidate on every call (a cheap per-entry check, unlike a vector decode): a
 * cache hit only ever skips the expensive I/O/decode/validate step, never the correctness
 * check that catches a chunk whose text changed since the vector was cached. If the cache is
 * absent, disabled, or its own load fails, this transparently falls back to the exact same
 * direct-SQLite behavior as before caching existed - a caller that never passes `cache` sees
 * byte-for-byte identical behavior to the pre-cache implementation.
 */
export function semanticSearch(
  store: EmbeddingStore, providerId: string, model: string, dimension: number,
  queryVector: Float32Array, limit: number,
  isConsistent?: (chunkId: string, documentId: string, contentHash: string) => boolean,
  cache?: VectorCache,
): SemanticSearchOutcome {
  const queryValidation = validateEmbeddingVector(queryVector, dimension);
  if (!queryValidation.valid) throw new Error(`Invalid query vector (${queryValidation.reason}).`);

  let invalidVectorCount = 0;
  let inconsistentCount = 0;
  const candidates: { chunkId: string; documentId: string; vector: Float32Array; norm: number }[] = [];

  const cached = cache?.getOrLoad(store, providerId, model, dimension, isConsistent) ?? null;
  if (cached) {
    // Every entry already passed validateEmbeddingVector at cache-load time (guaranteed by
    // the cache's own contract) - never re-validated here. isConsistent is re-checked per
    // entry regardless, since the underlying chunk can drift without any embeddings-store
    // write (which is the only thing that would have triggered a cache reload).
    for (const entry of cached) {
      if (isConsistent && !isConsistent(entry.chunkId, entry.documentId, entry.contentHash)) { inconsistentCount++; continue; }
      candidates.push({ chunkId: entry.chunkId, documentId: entry.documentId, vector: entry.vector, norm: entry.norm });
    }
  } else {
    const rows = store.currentRows(providerId, model, dimension);
    for (const row of rows) {
      const validation = validateEmbeddingVector(row.vector, dimension);
      if (!validation.valid) { invalidVectorCount++; continue; }
      if (isConsistent && !isConsistent(row.chunkId, row.documentId, row.contentHash)) { inconsistentCount++; continue; }
      candidates.push({ chunkId: row.chunkId, documentId: row.documentId, vector: validation.vector, norm: validation.norm });
    }
  }

  const scored = candidates.map(c => ({
    chunkId: c.chunkId, documentId: c.documentId,
    score: cosineSimilarity(queryValidation.vector, queryValidation.norm, c.vector, c.norm),
  }));
  const hits = topK(scored, limit, (a, b) => b.score - a.score);
  return { hits, candidateCount: candidates.length, invalidVectorCount, inconsistentCount };
}
