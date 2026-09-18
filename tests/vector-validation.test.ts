import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEmbeddingVector, cosineSimilarity, topK } from '../src/services/embeddings/vector';

test('validateEmbeddingVector rejects NaN, Infinity, and -Infinity elements', () => {
  assert.equal(validateEmbeddingVector(Float32Array.from([1, NaN, 1]), 3).valid, false);
  assert.equal(validateEmbeddingVector(Float32Array.from([1, Infinity, 1]), 3).valid, false);
  assert.equal(validateEmbeddingVector(Float32Array.from([1, -Infinity, 1]), 3).valid, false);
});

test('validateEmbeddingVector rejects an all-zero vector as a zero-norm error', () => {
  const result = validateEmbeddingVector(new Float32Array(4), 4);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, 'zero-norm');
});

test('validateEmbeddingVector rejects string, null, and undefined elements', () => {
  assert.equal(validateEmbeddingVector([1, 'x', 1], 3).valid, false);
  assert.equal(validateEmbeddingVector([1, null, 1], 3).valid, false);
  assert.equal(validateEmbeddingVector([1, undefined, 1], 3).valid, false);
});

test('validateEmbeddingVector rejects a vector whose actual length does not match the expected dimension', () => {
  const tooShort = validateEmbeddingVector(Float32Array.from([1, 2]), 3);
  const tooLong = validateEmbeddingVector(Float32Array.from([1, 2, 3, 4]), 3);
  assert.equal(tooShort.valid, false); if (!tooShort.valid) assert.equal(tooShort.reason, 'dimension-mismatch');
  assert.equal(tooLong.valid, false); if (!tooLong.valid) assert.equal(tooLong.reason, 'dimension-mismatch');
});

test('validateEmbeddingVector rejects non-array-like values outright (malformed provider/storage output)', () => {
  assert.equal(validateEmbeddingVector('not a vector', 3).valid, false);
  assert.equal(validateEmbeddingVector(null, 3).valid, false);
  assert.equal(validateEmbeddingVector(undefined, 3).valid, false);
  assert.equal(validateEmbeddingVector(42, 3).valid, false);
  assert.equal(validateEmbeddingVector({ 0: 1, 1: 2, length: 2 }, 2).valid, false); // array-like object, not a real array
});

test('validateEmbeddingVector accepts a well-formed, finite, non-zero vector of the expected length and reports its norm', () => {
  const result = validateEmbeddingVector(Float32Array.from([3, 4]), 2);
  assert.equal(result.valid, true);
  if (result.valid) assert.ok(Math.abs(result.norm - 5) < 1e-6);
});

test('cosineSimilarity rejects mismatched vector lengths instead of silently truncating (regression: dimension=2, actual length=1 must never yield similarity=1)', () => {
  const twoDim = Float32Array.from([1, 0]);
  const oneDim = Float32Array.from([1]);
  assert.throws(() => cosineSimilarity(twoDim, 1, oneDim, 1));
});

test('cosineSimilarity always returns a finite number, never NaN or Infinity', () => {
  const a = Float32Array.from([1, 0]); const b = Float32Array.from([0, 1]);
  assert.ok(Number.isFinite(cosineSimilarity(a, 1, b, 1)));
  const same = Float32Array.from([1, 0]);
  assert.ok(Number.isFinite(cosineSimilarity(same, 1, same, 1)));
});

test('topK matches a full sort for correctness while only examining a bounded working set', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: i, score: Math.sin(i * 7.31) }));
  const viaTopK = topK(items, 10, (a, b) => b.score - a.score);
  const viaFullSort = [...items].sort((a, b) => b.score - a.score).slice(0, 10);
  assert.deepEqual(viaTopK.map(i => i.id), viaFullSort.map(i => i.id));
});

test('topK returns everything, sorted, when there are fewer items than k', () => {
  const items = [{ id: 'a', score: 1 }, { id: 'b', score: 3 }, { id: 'c', score: 2 }];
  assert.deepEqual(topK(items, 10, (a, b) => b.score - a.score).map(i => i.id), ['b', 'c', 'a']);
});
