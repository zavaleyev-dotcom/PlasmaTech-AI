import type { EmbeddingStore } from './store';

export interface SemanticHit {
  chunkId: string;
  documentId: string;
  /** Cosine similarity in [-1, 1] (1 = identical direction). Not a calibrated probability. */
  score: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0; let normA = 0; let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
 * to hold all matching vectors at once; the benchmark measures this at the tested sample
 * size rather than assuming it scales to the full library.
 */
export function semanticSearch(store: EmbeddingStore, providerId: string, model: string, dimension: number, queryVector: Float32Array, limit: number): SemanticHit[] {
  if (queryVector.length !== dimension) throw new Error('Query vector dimension does not match the embedding index dimension.');
  const vectors = store.currentVectors(providerId, model, dimension);
  const scored = vectors.map(v => ({ chunkId: v.chunkId, documentId: v.documentId, score: cosineSimilarity(queryVector, v.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
