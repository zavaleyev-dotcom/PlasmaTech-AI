import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex, computeEmbeddingOverview } from '../src/services/embeddings';
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/providers/deterministic';
import type { EmbeddingProvider } from '../src/services/embeddings/types';
import { retrieveChunks } from '../src/services/rag/retrieve';
import { fuseRankings, hybridRetrieve } from '../src/services/rag/hybrid';
import type { RetrievedChunk } from '../src/services/rag/types';

async function fixture(fn: (root: string, indexFile: string, textStore: TextStore, embeddingStore: EmbeddingStore) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hybrid-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textStore = new TextStore(path.join(temp, 'text', 'index.sqlite'), 'test');
  const embeddingStore = new EmbeddingStore(path.join(temp, 'embeddings', 'index.sqlite'), 'test');
  try { await fn(root, path.join(temp, 'metadata.json'), textStore, embeddingStore); }
  finally { textStore.close(); embeddingStore.close(); await rm(temp, { recursive: true, force: true }); }
}

function fixedChunk(chunkId: string, score: number): RetrievedChunk {
  return { chunkId, documentId: `doc-${chunkId}`, relativePath: 'f.pdf', filename: 'f.pdf', title: 'T', authors: [], doi: null, year: null, sourceFolder: '.', pageStart: 1, pageEnd: 1, text: 'x', snippet: 'x', score };
}

function trackEmbedQuery(provider: EmbeddingProvider): { provider: EmbeddingProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: {
      id: provider.id, model: provider.model, dimension: provider.dimension, outboundDataDescription: provider.outboundDataDescription,
      configured: () => provider.configured(),
      embedDocuments: texts => provider.embedDocuments(texts),
      embedQuery: text => { calls++; return provider.embedQuery(text); },
    },
    calls: () => calls,
  };
}

// ---------- fuseRankings: centralized, pure, deterministic fusion ----------

test('fuseRankings marks a lexical-only result with no semantic rank/score', () => {
  const fused = fuseRankings([fixedChunk('a', 0.9)], [], 10);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].foundBy, 'lexical');
  assert.equal(fused[0].lexicalRank, 1); assert.equal(fused[0].semanticRank, null);
  assert.equal(fused[0].lexicalScore, 0.9); assert.equal(fused[0].semanticScore, null);
  assert.equal(fused[0].fusedRank, 1);
});

test('fuseRankings marks a semantic-only result with no lexical rank/score', () => {
  const fused = fuseRankings([], [fixedChunk('a', 0.5)], 10);
  assert.equal(fused[0].foundBy, 'semantic');
  assert.equal(fused[0].lexicalRank, null); assert.equal(fused[0].semanticRank, 1);
  assert.equal(fused[0].lexicalScore, null); assert.equal(fused[0].semanticScore, 0.5);
});

test('fuseRankings merges a chunk found by both lists into one deduplicated entry with a higher combined score', () => {
  const fused = fuseRankings([fixedChunk('a', 0.9), fixedChunk('b', 0.5)], [fixedChunk('a', 0.7)], 10);
  assert.equal(fused.length, 2, 'chunk "a" must be deduplicated, not duplicated');
  const a = fused.find(c => c.chunkId === 'a')!;
  const b = fused.find(c => c.chunkId === 'b')!;
  assert.equal(a.foundBy, 'both');
  assert.equal(a.lexicalRank, 1); assert.equal(a.semanticRank, 1);
  assert.ok(a.score > b.score, 'a chunk found by both lists must outrank one found by only one');
});

test('fuseRankings is fully deterministic for the same inputs', () => {
  const lexical = [fixedChunk('a', 1), fixedChunk('b', 0.5)];
  const semantic = [fixedChunk('c', 0.9)];
  const first = fuseRankings(lexical, semantic, 10);
  const second = fuseRankings(lexical, semantic, 10);
  assert.deepEqual(first.map(c => c.chunkId), second.map(c => c.chunkId));
  assert.deepEqual(first.map(c => c.score), second.map(c => c.score));
});

test('fuseRankings breaks ties between equal fused scores deterministically by chunkId', () => {
  // Both at rank 1 of their own single-item list -> identical RRF contribution (equal weights).
  const fused = fuseRankings([fixedChunk('b', 1)], [fixedChunk('a', 1)], 10);
  assert.deepEqual(fused.map(c => c.chunkId), ['a', 'b']);
});

test('fuseRankings truncates to the requested limit after fusing', () => {
  const lexical = [fixedChunk('a', 1), fixedChunk('b', 1), fixedChunk('c', 1)];
  const fused = fuseRankings(lexical, [], 2);
  assert.equal(fused.length, 2);
  assert.deepEqual(fused.map(c => c.fusedRank), [1, 2]);
});

// ---------- semanticSearch: brute-force cosine similarity ----------

test('semanticSearch finds the closest vector by cosine similarity', async () => {
  const { semanticSearch } = await import('../src/services/embeddings/search');
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
    const now = new Date().toISOString();
    for (const [id, text] of [['a', 'alpha text'], ['b', 'beta text']] as const) {
      const vector = await provider.embedQuery(text);
      store.upsert({ chunkId: id, documentId: `doc-${id}`, contentHash: 'h', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector, createdAt: now, updatedAt: now });
    }
    const query = await provider.embedQuery('alpha text'); // identical to a's own embedded text
    const hits = semanticSearch(store, provider.id, provider.model, provider.dimension, query, 5);
    assert.equal(hits[0].chunkId, 'a');
    assert.ok(Math.abs(hits[0].score - 1) < 1e-5, `expected cosine similarity ~1, got ${hits[0].score}`);
  } finally { store.close(); }
});

test('semanticSearch returns nothing when the store has no vectors for the given provider/model/dimension', async () => {
  const { semanticSearch } = await import('../src/services/embeddings/search');
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    assert.deepEqual(semanticSearch(store, 'deterministic', 'deterministic-8d', 8, new Float32Array(8), 5), []);
  } finally { store.close(); }
});

test('semanticSearch throws on a query vector dimension mismatch instead of silently comparing incompatible vectors', async () => {
  const { semanticSearch } = await import('../src/services/embeddings/search');
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    assert.throws(() => semanticSearch(store, 'deterministic', 'deterministic-8d', 8, new Float32Array(4), 5));
  } finally { store.close(); }
});

// ---------- hybridRetrieve: integration, safe degradation, diagnostics ----------

test('hybridRetrieve falls back to lexical-only when no embedding provider is configured, with a clear fallback reason', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness result for the fallback test.' }] }) });
  const result = await hybridRetrieve({ textStore, mode: 'hybrid', question: 'coating hardness result fallback test', limit: 8, embeddingProvider: null, embeddingStore: null });
  assert.equal(result.mode, 'lexical');
  assert.match(result.diagnostics.fallbackReason ?? '', /не настроен/);
  assert.ok(result.chunks.length >= 1);
  assert.equal(result.chunks[0].foundBy, 'lexical');
}));

test('hybridRetrieve falls back to lexical-only when the embedding index is configured but empty', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness result for the empty-index test.' }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const result = await hybridRetrieve({ textStore, mode: 'semantic', question: 'coating hardness result empty-index test', limit: 8, embeddingProvider: provider, embeddingStore });
  assert.equal(result.mode, 'lexical');
  assert.match(result.diagnostics.fallbackReason ?? '', /пуст/);
}));

test('hybridRetrieve in lexical mode never calls the embedding provider, even if one is fully configured and populated', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness lexical-only mode test.' }] }) });
  const real = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider: real });
  const { provider: spying, calls } = trackEmbedQuery(real);
  const result = await hybridRetrieve({ textStore, mode: 'lexical', question: 'coating hardness lexical-only mode test', limit: 8, embeddingProvider: spying, embeddingStore });
  assert.equal(result.mode, 'lexical');
  assert.equal(calls(), 0, 'embedQuery must never be called in lexical mode');
  assert.equal(result.diagnostics.fallbackReason, null);
}));

test('hybridRetrieve in semantic mode returns a result via vectors even when lexical extraction would find nothing', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  const chunkText = 'Coating hardness measured at twenty four gigapascals for the semantic plumbing test.';
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: chunkText }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  // A question made only of short stopwords: extractSearchTerms (retrieve.ts) reduces it to
  // nothing, so lexical retrieval alone returns zero candidates. embedQuery() embeds the raw
  // question string regardless of that extraction. NOTE: with the deterministic provider
  // this demonstrates the retrieval PLUMBING works mode-independently, not that the match is
  // semantically meaningful - the deterministic provider has no notion of meaning at all;
  // with only one vector in the store, brute-force search returns it regardless of how
  // (ir)relevant its cosine similarity to the query actually is.
  const stopwordOnlyQuestion = 'что и как это';
  assert.equal(retrieveChunks(textStore, stopwordOnlyQuestion, 8).length, 0, 'sanity check: lexical really finds nothing for this question');
  const result = await hybridRetrieve({ textStore, mode: 'semantic', question: stopwordOnlyQuestion, limit: 8, embeddingProvider: provider, embeddingStore });
  assert.equal(result.mode, 'semantic');
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].foundBy, 'semantic');
  assert.equal(result.diagnostics.fallbackReason, null);
}));

test('hybridRetrieve in hybrid mode combines lexical and semantic candidates with correct provenance', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deposition study ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const result = await hybridRetrieve({ textStore, mode: 'hybrid', question: 'coating hardness deposition study', limit: 8, embeddingProvider: provider, embeddingStore });
  assert.equal(result.mode, 'hybrid');
  assert.ok(result.chunks.length >= 1);
  assert.ok(result.chunks.every(c => ['both', 'lexical', 'semantic'].includes(c.foundBy)));
  assert.ok(result.chunks.some(c => c.foundBy === 'both'), 'with only two small chunks, both should be found by both methods');
  assert.equal(result.diagnostics.ftsCandidates, 2);
  assert.equal(result.diagnostics.semanticCandidates, 2);
}));

test('hybridRetrieve reports partial embedding coverage in diagnostics when only some chunks are embedded', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deposition study ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider, sample: 1 });
  const overview = computeEmbeddingOverview(embeddingStore, provider, textStore.chunkCount());
  assert.equal(overview.status, 'partial');
  const result = await hybridRetrieve({ textStore, mode: 'hybrid', question: 'coating hardness deposition study', limit: 8, embeddingProvider: provider, embeddingStore, embeddingOverview: overview });
  assert.equal(result.diagnostics.embeddingCoverage, 0.5);
}));
