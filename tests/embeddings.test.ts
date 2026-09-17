import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex, computeEmbeddingOverview } from '../src/services/embeddings';
import { DeterministicEmbeddingProvider, deterministicVector } from '../src/services/embeddings/providers/deterministic';
import { OpenAIEmbeddingProvider } from '../src/services/embeddings/providers/openai';
import { getEmbeddingProvider } from '../src/services/embeddings/providers';
import type { EmbeddingProvider, EmbeddingRecord } from '../src/services/embeddings/types';

async function fixture(fn: (root: string, indexFile: string, textStore: TextStore, embeddingStore: EmbeddingStore) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'embeddings-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textStore = new TextStore(path.join(temp, 'text', 'index.sqlite'), 'test');
  const embeddingStore = new EmbeddingStore(path.join(temp, 'embeddings', 'index.sqlite'), 'test');
  try { await fn(root, path.join(temp, 'metadata.json'), textStore, embeddingStore); }
  finally { textStore.close(); embeddingStore.close(); await rm(temp, { recursive: true, force: true }); }
}

// Spreading a class instance ({...provider}) only copies its own fields (id/model/
// dimension), never its prototype methods (configured/embedQuery/embedDocuments) - this
// explicitly delegates every method instead, so a wrapped test provider genuinely satisfies
// the EmbeddingProvider contract rather than accidentally working only because
// runEmbeddingIndex happens not to call the methods a spread would have dropped.
function wrapProvider(base: EmbeddingProvider, embedDocuments: EmbeddingProvider['embedDocuments']): EmbeddingProvider {
  return {
    id: base.id, model: base.model, dimension: base.dimension, outboundDataDescription: base.outboundDataDescription,
    configured: () => base.configured(),
    embedQuery: text => base.embedQuery(text),
    embedDocuments,
  };
}

function fixedRecord(overrides: Partial<EmbeddingRecord> = {}): EmbeddingRecord {
  return {
    chunkId: 'chunk-1', documentId: 'doc-1', contentHash: 'hash-1', providerId: 'deterministic',
    model: 'deterministic-8d', dimension: 8, vector: deterministicVector('text', 8),
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

// ---------- EmbeddingProvider: deterministic ----------

test('DeterministicEmbeddingProvider is deterministic, unit-length, and distinguishes different texts', async () => {
  const provider = new DeterministicEmbeddingProvider({ dimension: 32 });
  const a1 = await provider.embedQuery('titanium nitride coating');
  const a2 = await provider.embedQuery('titanium nitride coating');
  const b = await provider.embedQuery('completely different text');
  assert.deepEqual([...a1], [...a2], 'same text must always produce the same vector');
  assert.notDeepEqual([...a1], [...b]);
  assert.equal(a1.length, 32);
  const norm = Math.sqrt([...a1].reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, `vector is not unit-length: norm=${norm}`);
  const docs = await provider.embedDocuments(['one', 'two']);
  assert.equal(docs.length, 2);
  assert.deepEqual([...docs[0]], [...(await provider.embedQuery('one'))]);
});

test('DeterministicEmbeddingProvider models a provider failure, an empty vector, and a wrong-dimension vector on demand', async () => {
  const failing = new DeterministicEmbeddingProvider({ dimension: 8, failOn: t => t === 'boom' });
  await assert.rejects(failing.embedQuery('boom'));
  await assert.rejects(failing.embedDocuments(['ok', 'boom']));

  const emptyOn = new DeterministicEmbeddingProvider({ dimension: 8, emptyVectorOn: t => t === 'empty' });
  assert.equal((await emptyOn.embedQuery('empty')).length, 0);
  assert.equal((await emptyOn.embedQuery('fine')).length, 8);

  const wrongDim = new DeterministicEmbeddingProvider({ dimension: 8, wrongDimensionOn: t => t === 'wrong' });
  assert.equal((await wrongDim.embedQuery('wrong')).length, 9);
  assert.equal((await wrongDim.embedQuery('fine')).length, 8);
});

// ---------- EmbeddingProvider: OpenAI (Content-Type + transport error normalization) ----------

function embeddingsBody(vectors: number[][]): string {
  return JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index })) });
}

test('OpenAIEmbeddingProvider is unconfigured without an API key and never sends anything', () => {
  const provider = new OpenAIEmbeddingProvider(async () => { throw new Error('must not fetch'); }, undefined);
  assert.equal(provider.configured(), false);
});

test('OpenAIEmbeddingProvider accepts 200 + valid JSON + application/json', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(embeddingsBody([[0.1, 0.2, 0.3]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'test-key', 'test-model', 3);
  const [vector] = await provider.embedDocuments(['x']);
  // Float32Array loses some precision vs the JS numbers that went in - compare with a
  // tolerance appropriate for 32-bit floats, not exact equality.
  [0.1, 0.2, 0.3].forEach((expected, i) => assert.ok(Math.abs(vector[i] - expected) < 1e-6, `index ${i}: ${vector[i]} vs ${expected}`));
});

test('OpenAIEmbeddingProvider rejects text/html and text/plain content-type even with a valid JSON body', async () => {
  const html = new OpenAIEmbeddingProvider(async () => new Response(embeddingsBody([[0.1, 0.2]]), { status: 200, headers: { 'content-type': 'text/html' } }), 'test-key', 'm', 2);
  await assert.rejects(html.embedQuery('x'));
  const plain = new OpenAIEmbeddingProvider(async () => new Response(embeddingsBody([[0.1, 0.2]]), { status: 200 }), 'test-key', 'm', 2);
  await assert.rejects(plain.embedQuery('x'));
});

test('OpenAIEmbeddingProvider rejects malformed JSON, a non-2xx response, and a malformed/mismatched result, without leaking the key or body', async () => {
  const malformedJson = new OpenAIEmbeddingProvider(async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }), 'test-key', 'm', 2);
  await assert.rejects(malformedJson.embedQuery('x'));

  const nonOk = new OpenAIEmbeddingProvider(async () => new Response(JSON.stringify({ error: { message: 'sk-secret-leak' } }), { status: 401, headers: { 'content-type': 'application/json' } }), 'sk-should-not-appear', 'm', 2);
  await assert.rejects(nonOk.embedQuery('x'), (error: Error) => {
    assert.ok(!error.message.includes('sk-secret-leak'));
    assert.ok(!error.message.includes('sk-should-not-appear'));
    return true;
  });

  // Malformed result: fewer vectors than requested inputs.
  const shortData = new OpenAIEmbeddingProvider(async () => new Response(embeddingsBody([[0.1, 0.2]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'test-key', 'm', 2);
  await assert.rejects(shortData.embedDocuments(['x', 'y']));

  // Malformed result: "embedding" is not an array.
  const badShape = new OpenAIEmbeddingProvider(async () => new Response(JSON.stringify({ data: [{ embedding: 'not-an-array', index: 0 }] }), { status: 200, headers: { 'content-type': 'application/json' } }), 'test-key', 'm', 2);
  await assert.rejects(badShape.embedQuery('x'));
});

test('OpenAIEmbeddingProvider normalizes timeouts and network failures without leaking transport details', async () => {
  const timeout = new OpenAIEmbeddingProvider(async () => { throw new DOMException('aborted', 'TimeoutError'); }, 'test-key', 'm', 2);
  await assert.rejects(timeout.embedQuery('x'), /не ответил вовремя/);

  const network = new OpenAIEmbeddingProvider(async () => { throw new TypeError('fetch failed: ENOTFOUND api.openai.com'); }, 'test-key', 'm', 2);
  await assert.rejects(network.embedQuery('x'), (error: Error) => {
    assert.ok(!error.message.includes('ENOTFOUND'));
    assert.ok(!error.message.includes('api.openai.com'));
    return true;
  });
});

test('getEmbeddingProvider never auto-selects OpenAI just because OPENAI_API_KEY is set - it requires an explicit EMBEDDING_PROVIDER', () => {
  const previousProvider = process.env.EMBEDDING_PROVIDER;
  const previousKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.EMBEDDING_PROVIDER;
    process.env.OPENAI_API_KEY = 'sk-present-but-must-not-trigger-embeddings';
    assert.equal(getEmbeddingProvider(), null, 'an API key alone (used by the RAG answer provider) must never enable external embedding indexing');

    process.env.EMBEDDING_PROVIDER = 'openai';
    assert.ok(getEmbeddingProvider() !== null);

    delete process.env.OPENAI_API_KEY;
    assert.equal(getEmbeddingProvider(), null, 'EMBEDDING_PROVIDER=openai without a key must still be unconfigured');
  } finally {
    if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

// ---------- EmbeddingStore ----------

test('EmbeddingStore upserts and reads back a record with the vector bytes preserved exactly', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  const record = fixedRecord();
  embeddingStore.upsert(record);
  assert.equal(embeddingStore.totalCount(), 1);
  const fingerprint = embeddingStore.fingerprint(record.chunkId);
  // node:sqlite returns row objects with a null prototype - compare own properties, not
  // prototype identity, by spreading into a plain object first.
  assert.deepEqual({ ...fingerprint }, { contentHash: record.contentHash, providerId: record.providerId, model: record.model, dimension: record.dimension });
  const [stored] = embeddingStore.currentVectors(record.providerId, record.model, record.dimension);
  assert.deepEqual([...stored.vector], [...record.vector]);
  embeddingStore.remove(record.chunkId);
  assert.equal(embeddingStore.totalCount(), 0);
}));

test('EmbeddingStore rejects opening with a rootId that does not match a previously stored one (corrupted/foreign store)', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'embeddings-corrupt-test-')));
  try {
    const file = path.join(temp, 'index.sqlite');
    const first = new EmbeddingStore(file, 'root-a');
    first.close();
    assert.throws(() => new EmbeddingStore(file, 'root-b'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

// ---------- runEmbeddingIndex: incremental behavior ----------

test('runEmbeddingIndex embeds new chunks and reuses them unchanged on the next run', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  let calls = 0;
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const counting = wrapProvider(provider, async texts => { calls += texts.length; return provider.embedDocuments(texts); });
  const first = await runEmbeddingIndex({ textStore, embeddingStore, provider: counting });
  assert.equal(first.embedded, 2); assert.equal(first.reused, 0); assert.equal(calls, 2);
  const second = await runEmbeddingIndex({ textStore, embeddingStore, provider: counting });
  assert.equal(second.reused, 2); assert.equal(second.embedded, 0);
  assert.equal(calls, 2, 'unchanged chunks must not be re-sent to the provider');
}));

test('runEmbeddingIndex re-embeds only a chunk whose text actually changed', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  const extract = async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: data.toString().startsWith('b-changed') ? 'Completely rewritten content for b.' : `Coating study document ${data.toString()}.` }] });
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  await writeFile(path.join(root, 'b.pdf'), 'b-changed'); // different size/mtime -> library-text reprocesses only this file
  await runTextIndex({ root, indexFile, store: textStore, extract });
  const second = await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(second.embedded, 1, `expected exactly one re-embedded chunk, got processed=${second.processed} reused=${second.reused} embedded=${second.embedded}`);
  assert.equal(second.reused, 1);
}));

test('runEmbeddingIndex removes embeddings for chunks that no longer exist, only after a full (non-sample) pass', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(embeddingStore.totalCount(), 2);
  await rm(path.join(root, 'b.pdf'));
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  assert.equal(textStore.chunkCount(), 1);
  // A sample run must NOT clean up orphans even though b's chunk is now gone.
  await runEmbeddingIndex({ textStore, embeddingStore, provider, sample: 1 });
  assert.equal(embeddingStore.totalCount(), 2, 'a sample run must never sweep orphans');
  // A full run must.
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(embeddingStore.totalCount(), 1, 'a full run must remove the orphaned embedding');
}));

test('computeEmbeddingOverview reports stale when the store only has embeddings from a different model or provider', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating study document.' }] }) });
  const providerA = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider: providerA });
  const readyOverview = computeEmbeddingOverview(embeddingStore, providerA, textStore.chunkCount());
  assert.equal(readyOverview.status, 'ready');

  // Same provider id, different dimension -> a different model string -> stale.
  const providerDifferentDimension = new DeterministicEmbeddingProvider({ dimension: 16 });
  const staleByDimension = computeEmbeddingOverview(embeddingStore, providerDifferentDimension, textStore.chunkCount());
  assert.equal(staleByDimension.status, 'stale');
  assert.equal(staleByDimension.stats.embeddedChunks, 0);
  assert.equal(staleByDimension.stats.staleChunks, 1);

  // A different provider id entirely -> also stale.
  // wrapProvider() returns a plain object (unlike a class instance, spreading IT is safe:
  // all its properties, methods included, are its own enumerable properties).
  const providerB = { ...wrapProvider(providerA, texts => providerA.embedDocuments(texts)), id: 'other-provider' };
  const staleByProvider = computeEmbeddingOverview(embeddingStore, providerB, textStore.chunkCount());
  assert.equal(staleByProvider.status, 'stale');
}));

test('computeEmbeddingOverview reports not_configured, empty, partial and rebuilding correctly', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  assert.equal(computeEmbeddingOverview(embeddingStore, null, 0).status, 'not_configured');
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  assert.equal(computeEmbeddingOverview(embeddingStore, provider, 5).status, 'empty');
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  await runEmbeddingIndex({ textStore, embeddingStore, provider, sample: 1 });
  assert.equal(computeEmbeddingOverview(embeddingStore, provider, textStore.chunkCount()).status, 'partial');
  embeddingStore.setProgress({ running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 2, processed: 1, reused: 0, embedded: 1, failed: 0, skipped: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  assert.equal(computeEmbeddingOverview(embeddingStore, provider, textStore.chunkCount()).status, 'rebuilding');
}));

test('runEmbeddingIndex resumes after a previous process died leaving a stale running flag with a dead PID', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating study document.' }] }) });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
  embeddingStore.setProgress({ running: true, cancelled: false, stopRequested: false, pid: dead, total: 1, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  assert.equal(embeddingStore.overviewProgress()?.running, false);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(progress.embedded, 1);
  assert.equal(embeddingStore.progress()!.running, false);
}));

test('runEmbeddingIndex counts a failing batch as failed without aborting the whole run', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b'); await writeFile(path.join(root, 'c.pdf'), 'c');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  const real = new DeterministicEmbeddingProvider({ dimension: 8 });
  let batchNumber = 0;
  const flaky = wrapProvider(real, async texts => { batchNumber++; if (batchNumber === 1) throw new Error('upstream boom'); return real.embedDocuments(texts); });
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider: flaky, batchSize: 1 });
  assert.equal(progress.failed, 1);
  assert.equal(progress.embedded, 2);
  assert.equal(progress.total, 3);
  assert.equal(progress.error, null, 'a per-batch failure must not surface as a fatal run error');
}));

test('runEmbeddingIndex never stores a returned vector with an empty length or the wrong dimension', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  // Chunk "a"'s text triggers an empty vector; chunk "b" embeds normally.
  const provider = wrapProvider(
    new DeterministicEmbeddingProvider({ dimension: 8 }),
    async texts => texts.map(t => (t.includes('document a') ? new Float32Array(0) : deterministicVector(t, 8))),
  );
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(progress.failed, 1);
  assert.equal(progress.embedded, 1);
  assert.equal(embeddingStore.totalCount(), 1);
}));

test('runEmbeddingIndex can be interrupted mid-run and later resumes to completion', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  for (let i = 0; i < 4; i++) await writeFile(path.join(root, `${i}.pdf`), String(i));
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating study document ${data.toString()}.` }] }) });
  const real = new DeterministicEmbeddingProvider({ dimension: 8 });
  let batchCount = 0;
  const stoppingAfterOne = wrapProvider(real, async texts => { batchCount++; if (batchCount === 2) embeddingStore.requestStop(); return real.embedDocuments(texts); });
  const first = await runEmbeddingIndex({ textStore, embeddingStore, provider: stoppingAfterOne, batchSize: 1 });
  assert.equal(first.cancelled, true);
  assert.ok(first.embedded >= 1 && first.embedded < 4, `expected a partial run, got embedded=${first.embedded}`);
  const second = await runEmbeddingIndex({ textStore, embeddingStore, provider: real, batchSize: 1 });
  assert.equal(second.cancelled, false);
  assert.equal(embeddingStore.totalCount(), 4);
}));
