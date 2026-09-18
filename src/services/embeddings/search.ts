import type { EmbeddingStore } from './store';
import { cosineSimilarity, topK, validateEmbeddingVector } from './vector';

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
 */
export function semanticSearch(
  store: EmbeddingStore, providerId: string, model: string, dimension: number,
  queryVector: Float32Array, limit: number,
  isConsistent?: (chunkId: string, documentId: string, contentHash: string) => boolean,
): SemanticSearchOutcome {
  const queryValidation = validateEmbeddingVector(queryVector, dimension);
  if (!queryValidation.valid) throw new Error(`Invalid query vector (${queryValidation.reason}).`);

  const rows = store.currentRows(providerId, model, dimension);
  let invalidVectorCount = 0;
  let inconsistentCount = 0;
  const candidates: { chunkId: string; documentId: string; vector: Float32Array; norm: number }[] = [];
  for (const row of rows) {
    const validation = validateEmbeddingVector(row.vector, dimension);
    if (!validation.valid) { invalidVectorCount++; continue; }
    if (isConsistent && !isConsistent(row.chunkId, row.documentId, row.contentHash)) { inconsistentCount++; continue; }
    candidates.push({ chunkId: row.chunkId, documentId: row.documentId, vector: validation.vector, norm: validation.norm });
  }

  const scored = candidates.map(c => ({
    chunkId: c.chunkId, documentId: c.documentId,
    score: cosineSimilarity(queryValidation.vector, queryValidation.norm, c.vector, c.norm),
  }));
  const hits = topK(scored, limit, (a, b) => b.score - a.score);
  return { hits, candidateCount: candidates.length, invalidVectorCount, inconsistentCount };
}
