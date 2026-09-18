/**
 * Single source of truth for "is this a usable embedding vector", applied at every boundary
 * this module touches a vector: right after a provider call, before writing to the store,
 * when reading a stored vector back, right before cosine similarity, and when deciding
 * whether an existing stored vector may be reused. A vector that fails any of these checks
 * is never used as-is - callers treat it as corrupted/stale (see store.ts, search.ts,
 * index.ts), never as a value that happens to produce a technically-computable result.
 */

export interface VectorValidationOk { valid: true; vector: Float32Array; norm: number }
export type VectorInvalidReason = 'not-array-like' | 'dimension-mismatch' | 'non-finite-element' | 'zero-norm';
export interface VectorValidationError { valid: false; reason: VectorInvalidReason }
export type VectorValidationResult = VectorValidationOk | VectorValidationError;

/**
 * Validates a candidate vector against the dimension it is supposed to have. Rejects:
 * anything that isn't a Float32Array or a plain array (so a malformed/string/null/object
 * value can never reach further use); an actual length different from `expectedDimension`
 * (never trusts a stored/reported `dimension` field on its own - see cosineSimilarity below,
 * which also never trusts it); any element that is not a finite number (catches NaN,
 * +/-Infinity, strings, null, undefined, objects - Number.isFinite is false for all of
 * these); and an all-zero (or otherwise zero-norm) vector, which cannot be normalized and
 * cannot participate in a meaningful cosine similarity.
 */
export function validateEmbeddingVector(candidate: unknown, expectedDimension: number): VectorValidationResult {
  if (!(candidate instanceof Float32Array) && !Array.isArray(candidate)) return { valid: false, reason: 'not-array-like' };
  const length = candidate.length;
  if (length !== expectedDimension) return { valid: false, reason: 'dimension-mismatch' };
  let sumSquares = 0;
  for (let i = 0; i < length; i++) {
    const value = candidate[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) return { valid: false, reason: 'non-finite-element' };
    sumSquares += value * value;
  }
  if (!Number.isFinite(sumSquares)) return { valid: false, reason: 'non-finite-element' };
  const norm = Math.sqrt(sumSquares);
  if (!(norm > 0)) return { valid: false, reason: 'zero-norm' };
  // Reuse the same Float32Array instance when the input already is one - never copy a
  // vector that does not need copying.
  const vector = candidate instanceof Float32Array ? candidate : Float32Array.from(candidate as number[]);
  return { valid: true, vector, norm };
}

/**
 * Strict cosine similarity between two ALREADY-VALIDATED vectors. Takes each vector's
 * precomputed norm (from validateEmbeddingVector) instead of recomputing it here - the
 * query vector's norm in particular would otherwise be recomputed on every single
 * comparison during a search, which is pure waste since it never changes across them.
 *
 * Never truncates to the shorter length (the historical bug this replaces): a length
 * mismatch is a caller error - both inputs must already share `expectedDimension` from
 * validateEmbeddingVector - and throws rather than silently comparing incompatible vectors
 * or fabricating a plausible-looking score. The result is always a finite number.
 */
export function cosineSimilarity(a: Float32Array, normA: number, b: Float32Array, normB: number): number {
  if (a.length !== b.length) throw new Error('Cannot compute cosine similarity between vectors of different lengths.');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const denom = normA * normB;
  const score = denom === 0 ? 0 : dot / denom;
  return Number.isFinite(score) ? score : 0;
}

/**
 * Bounded top-K selection: avoids a full O(n log n) sort of every candidate when only the
 * best `k` are ever needed. Maintains a sorted array of at most `k` items, inserting each
 * new candidate only if it beats the current worst kept item - O(n·k) with a binary search
 * per insertion, which is the appropriate trade-off when k is small (a handful to a few
 * dozen) and n can be large, without introducing a heap library or other dependency.
 */
export function topK<T>(items: readonly T[], k: number, compare: (a: T, b: T) => number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return [...items].sort(compare);
  const best: T[] = [];
  for (const item of items) {
    if (best.length < k) {
      best.push(item);
      if (best.length === k) best.sort(compare);
      continue;
    }
    if (compare(item, best[best.length - 1]) >= 0) continue; // not better than the current worst kept item
    let lo = 0; let hi = best.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (compare(item, best[mid]) < 0) hi = mid; else lo = mid + 1; }
    best.splice(lo, 0, item);
    best.pop();
  }
  return best;
}
