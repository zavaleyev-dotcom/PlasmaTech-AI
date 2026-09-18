import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex, computeEmbeddingOverview } from '../src/services/embeddings';
import { semanticSearch } from '../src/services/embeddings/search';
import { DeterministicEmbeddingProvider, deterministicVector } from '../src/services/embeddings/providers/deterministic';
import { OpenAIEmbeddingProvider } from '../src/services/embeddings/providers/openai';
import { getEmbeddingProvider } from '../src/services/embeddings/providers';
import { validateEmbeddingVector } from '../src/services/embeddings/vector';
import type { EmbeddingProvider, EmbeddingRecord } from '../src/services/embeddings/types';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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

// ---------- OpenAIEmbeddingProvider: match vectors to inputs by data[].index, never by array position ----------

function embeddingsBodyWithIndices(pairs: { embedding: number[]; index: number }[]): string {
  return JSON.stringify({ data: pairs.map(p => ({ embedding: p.embedding, index: p.index })) });
}

test('OpenAIEmbeddingProvider matches vectors to inputs by data[].index even when the response is reordered', async () => {
  // Deliberately out of order: the vector for input[1] arrives first in the array.
  const body = embeddingsBodyWithIndices([{ embedding: [0, 1], index: 1 }, { embedding: [1, 0], index: 0 }]);
  const provider = new OpenAIEmbeddingProvider(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  const [v0, v1] = await provider.embedDocuments(['first', 'second']);
  assert.deepEqual([...v0], [1, 0], 'input[0] must get the vector whose index is 0, regardless of array position');
  assert.deepEqual([...v1], [0, 1]);
});

test('OpenAIEmbeddingProvider rejects a response with a duplicate index', async () => {
  const body = embeddingsBodyWithIndices([{ embedding: [1, 0], index: 0 }, { embedding: [0, 1], index: 0 }]);
  const provider = new OpenAIEmbeddingProvider(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedDocuments(['a', 'b']));
});

test('OpenAIEmbeddingProvider rejects a response missing one of the expected indices', async () => {
  const body = embeddingsBodyWithIndices([{ embedding: [1, 0], index: 0 }, { embedding: [0, 1], index: 0 }]); // both claim index 0; index 1 never appears
  const provider = new OpenAIEmbeddingProvider(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedDocuments(['a', 'b']));
});

test('OpenAIEmbeddingProvider rejects a response with an out-of-range index', async () => {
  const body = embeddingsBodyWithIndices([{ embedding: [1, 0], index: 0 }, { embedding: [0, 1], index: 5 }]);
  const provider = new OpenAIEmbeddingProvider(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedDocuments(['a', 'b']));
});

test('OpenAIEmbeddingProvider accepts a normal, in-order response keyed by index', async () => {
  const body = embeddingsBodyWithIndices([{ embedding: [1, 0], index: 0 }, { embedding: [0, 1], index: 1 }]);
  const provider = new OpenAIEmbeddingProvider(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  const [v0, v1] = await provider.embedDocuments(['a', 'b']);
  assert.deepEqual([...v0], [1, 0]);
  assert.deepEqual([...v1], [0, 1]);
});

// ---------- OpenAIEmbeddingProvider (Codex regression): raw validation BEFORE Float32
// coercion, and a second validateEmbeddingVector pass AFTER conversion ----------

// Unlike embeddingsBody()/embeddingsBodyWithIndices(), this allows deliberately malformed
// raw "embedding" elements (strings, null, ...) that a real upstream bug or MITM could send -
// Float32Array.from() would otherwise coerce them (Number("2")->2, Number(null)->0) into
// numbers that look perfectly legitimate downstream.
function rawEmbeddingsBody(embeddings: readonly unknown[][]): string {
  return JSON.stringify({ data: embeddings.map((embedding, index) => ({ embedding, index })) });
}

test('OpenAIEmbeddingProvider rejects a raw string element ("2") and a raw null element BEFORE Float32Array coercion, instead of silently turning them into the numbers 2 and 0', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([['2', null]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedQuery('x'), /недопустим/);
});

test('OpenAIEmbeddingProvider rejects a raw string element mixed with a genuine number ("1", 2)', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([['1', 2]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedQuery('x'), /недопустим/);
});

test('OpenAIEmbeddingProvider rejects a raw null element even when it appears first (null, 1)', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([[null, 1]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedQuery('x'), /недопустим/);
});

test('OpenAIEmbeddingProvider still accepts a normal, all-numeric raw vector', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([[0.6, 0.8]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  const vector = await provider.embedQuery('x');
  assert.equal(vector.length, 2);
  assert.ok(Math.abs(vector[0] - 0.6) < 1e-6 && Math.abs(vector[1] - 0.8) < 1e-6);
});

test('OpenAIEmbeddingProvider re-validates AFTER Float32 conversion: a magnitude beyond float32 range (1e40) becomes Infinity and is rejected', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([[1e40, 1]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedQuery('x'), /математически некорректный/);
});

test('OpenAIEmbeddingProvider re-validates AFTER Float32 conversion: a magnitude far below float32 precision (1e-50) rounds to 0 and is rejected as a zero vector', async () => {
  const provider = new OpenAIEmbeddingProvider(async () => new Response(rawEmbeddingsBody([[1e-50, 0]]), { status: 200, headers: { 'content-type': 'application/json' } }), 'k', 'm', 2);
  await assert.rejects(provider.embedQuery('x'), /математически некорректный/);
});

// ---------- EmbeddingStore (Codex regression): strict vector BLOB size/type checking ----------

test('EmbeddingStore treats a stored vector BLOB as corrupted unless its byte length is EXACTLY its own declared dimension x 4 - truncated, padded with extra bytes, and wrong-typed all reject; an exact match is accepted', async () => {
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    // dimension=2 means exactly 8 bytes (2 x float32) are expected.
    store.db.exec("INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES ('truncated','d','h','p','m',2,x'01020304050607','t','t')"); // 7 bytes
    store.db.exec("INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES ('padded','d','h','p','m',2,x'010203040506070809','t','t')"); // 9 bytes
    store.db.exec("INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES ('wrongtype','d','h','p','m',2,'not-a-blob-at-all','t','t')"); // TEXT, not a BLOB
    const goodVector = Float32Array.from([3, 4]);
    store.db.prepare("INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES ('good','d','h','p','m',2,?,'t','t')")
      .run(Buffer.from(goodVector.buffer, goodVector.byteOffset, goodVector.byteLength));

    const byId = new Map(store.currentRows('p', 'm', 2).map(r => [r.chunkId, r]));
    assert.equal(byId.get('truncated')!.vector.length, 0, 'a truncated BLOB (7 of 8 bytes) must never be partially decoded');
    assert.equal(byId.get('padded')!.vector.length, 0, 'trailing extra bytes (9 of 8) must also be treated as corruption, never silently ignored');
    assert.equal(byId.get('wrongtype')!.vector.length, 0, 'a non-binary stored value must never be reinterpreted as a vector');
    assert.deepEqual([...byId.get('good')!.vector], [3, 4]);

    assert.equal(validateEmbeddingVector(byId.get('truncated')!.vector, 2).valid, false);
    assert.equal(validateEmbeddingVector(byId.get('padded')!.vector, 2).valid, false);
    assert.equal(validateEmbeddingVector(byId.get('wrongtype')!.vector, 2).valid, false);
    assert.equal(validateEmbeddingVector(byId.get('good')!.vector, 2).valid, true);
  } finally { store.close(); }
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
  const [stored] = embeddingStore.currentRows(record.providerId, record.model, record.dimension);
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
  embeddingStore.setProgress({ running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 2, processed: 1, reused: 0, embedded: 1, failed: 0, skipped: 0, orphanRemoved: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  assert.equal(computeEmbeddingOverview(embeddingStore, provider, textStore.chunkCount()).status, 'rebuilding');
}));

test('runEmbeddingIndex resumes after a previous process died leaving a stale running flag with a dead PID', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating study document.' }] }) });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
  embeddingStore.setProgress({ running: true, cancelled: false, stopRequested: false, pid: dead, total: 1, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0, orphanRemoved: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
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

// ---------- reuse must never trust a matching fingerprint alone ----------

test('runEmbeddingIndex never reuses a stored embedding whose vector is corrupted, even when its fingerprint matches exactly', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Chunk text for corrupted-vector reuse test.' }] }) });
  const chunkRow = textStore.db.prepare('SELECT id, documentId, text FROM chunks').get() as { id: string; documentId: string; text: string };
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const now = new Date().toISOString();
  const realHash = sha256(chunkRow.text);
  const corrupted = Float32Array.from([NaN, 1, 1, 1, 1, 1, 1, 1]); // fingerprint-perfect, vector corrupted
  embeddingStore.upsert({ chunkId: chunkRow.id, documentId: chunkRow.documentId, contentHash: realHash, providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: corrupted, createdAt: now, updatedAt: now });
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(progress.reused, 0, 'a corrupted stored vector must never be reused despite a perfectly matching fingerprint');
  assert.equal(progress.embedded, 1);
  const record = embeddingStore.recordFor(chunkRow.id)!;
  assert.equal(Number.isNaN(record.vector[0]), false, 'the corrupted vector must have been overwritten by a real one');
}));

test('runEmbeddingIndex never reuses a stored embedding whose documentId does not match the chunk\'s real current documentId', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Chunk text for wrong-documentId reuse test.' }] }) });
  const chunkRow = textStore.db.prepare('SELECT id, documentId, text FROM chunks').get() as { id: string; documentId: string; text: string };
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const now = new Date().toISOString();
  const realHash = sha256(chunkRow.text);
  embeddingStore.upsert({ chunkId: chunkRow.id, documentId: 'wrong-document-id', contentHash: realHash, providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: await provider.embedQuery('x'), createdAt: now, updatedAt: now });
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider });
  assert.equal(progress.reused, 0, 'a documentId mismatch must force re-embedding, never reuse');
  assert.equal(progress.embedded, 1);
  assert.equal(embeddingStore.recordFor(chunkRow.id)!.documentId, chunkRow.documentId, 'the corrected record must carry the real documentId');
}));

// ---------- progress accounting: skipped, and processed never exceeding total ----------

test('runEmbeddingIndex counts an empty/whitespace-only chunk as skipped, never sends it to the provider, and keeps processed = reused+embedded+failed+skipped', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Real chunk content for the skip test.' }] }) });
  // chunkPages() never actually produces an empty/whitespace-only chunk in normal operation
  // (every chunk is built from at least one real word) - this directly inserts a synthetic
  // one to exercise runEmbeddingIndex's own defensive skip path regardless of that.
  const documentId = textStore.records()[0].id;
  textStore.db.prepare('INSERT INTO chunks (id, documentId, ordinal, pageStart, pageEnd, text, wordCount) VALUES (?,?,?,?,?,?,?)')
    .run('synthetic-empty-chunk', documentId, 99, 1, 1, '   ', 0);
  const real = new DeterministicEmbeddingProvider({ dimension: 8 });
  let providerCalls = 0;
  const counting = wrapProvider(real, async texts => { providerCalls += texts.length; return real.embedDocuments(texts); });
  const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider: counting });
  assert.equal(progress.total, 2);
  assert.equal(progress.skipped, 1);
  assert.equal(progress.embedded, 1);
  assert.equal(providerCalls, 1, 'the empty chunk must never be sent to the provider');
  assert.equal(progress.processed, progress.reused + progress.embedded + progress.failed + progress.skipped);
  assert.ok(progress.processed <= progress.total, `processed (${progress.processed}) must never exceed total (${progress.total})`);
}));

// ---------- provider errors vs. storage errors: never conflated ----------

test('runEmbeddingIndex separates a storage failure from a provider failure: processed never exceeds total, embedded reflects what is really stored, and the run stops without further provider calls', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Storage failure test chunk ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  let providerCallCount = 0;
  const countingProvider = wrapProvider(provider, async texts => { providerCallCount++; return provider.embedDocuments(texts); });
  // A store whose writes always fail, but whose every OTHER method (fingerprint/recordFor/
  // chunkIds/progress/...) genuinely delegates to the real store - so runEmbeddingIndex's
  // post-failure verification (countActuallyStored) checks REAL state, not a mock's guess.
  const faultyStore = new Proxy(embeddingStore, {
    get(target, prop, receiver) {
      if (prop === 'upsertBatch') return () => { throw new Error('disk full'); };
      return Reflect.get(target, prop, receiver);
    },
  }) as EmbeddingStore;
  const progress = await runEmbeddingIndex({ textStore, embeddingStore: faultyStore, provider: countingProvider, batchSize: 2 });
  assert.equal(progress.total, 2);
  assert.ok(progress.processed <= progress.total, `processed (${progress.processed}) must never exceed total (${progress.total})`);
  assert.equal(progress.processed, 2);
  assert.equal(progress.embedded, 0, 'nothing was actually committed - verified against the real store, not assumed');
  assert.equal(progress.failed, 2);
  assert.equal(embeddingStore.totalCount(), 0, 'the real underlying store confirms nothing was written');
  assert.match(progress.error ?? '', /хранилищ/i, 'a storage-specific message, never a provider-shaped one');
  assert.equal(providerCallCount, 1, 'the provider must be called exactly once for the one batch, then the run must stop rather than making further pointless calls once storage is known to be broken');
}));

test('runEmbeddingIndex (Codex regression): repairing an old CORRUPTED record must never be counted as embedded if the repair write rolls back - the record must remain marked invalid, never "successfully restored" by a matching fingerprint alone', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Chunk text for repair-rollback accounting regression test.' }] }) });
  const chunkRow = textStore.db.prepare('SELECT id, documentId, text FROM chunks').get() as { id: string; documentId: string; text: string };
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const now = new Date().toISOString();
  const realHash = sha256(chunkRow.text);
  // A pre-existing OLD corrupted record: fingerprint-perfect (matches exactly what a repair
  // attempt would try to write), but the vector itself is corrupted (NaN).
  const corrupted = Float32Array.from([NaN, 1, 1, 1, 1, 1, 1, 1]);
  embeddingStore.upsert({ chunkId: chunkRow.id, documentId: chunkRow.documentId, contentHash: realHash, providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: corrupted, createdAt: now, updatedAt: now });

  // runEmbeddingIndex correctly refuses to reuse this corrupted record and attempts to
  // repair it (re-embed + re-store) - but the storage write itself fails and rolls back,
  // leaving the OLD corrupted record untouched.
  const faultyStore = new Proxy(embeddingStore, {
    get(target, prop, receiver) {
      if (prop === 'upsertBatch') return () => { throw new Error('disk full during repair'); };
      return Reflect.get(target, prop, receiver);
    },
  }) as EmbeddingStore;

  const progress = await runEmbeddingIndex({ textStore, embeddingStore: faultyStore, provider });
  assert.equal(progress.embedded, 0, 'a rolled-back repair must never be counted as embedded, even though the old record\'s fingerprint matches exactly');
  assert.equal(progress.failed, 1);
  assert.ok(progress.processed <= progress.total, `processed (${progress.processed}) must never exceed total (${progress.total})`);

  const stillThere = embeddingStore.recordFor(chunkRow.id)!;
  assert.equal(Number.isNaN(stillThere.vector[0]), true, 'the record must remain the OLD corrupted vector - never marked as successfully repaired');
  assert.equal(validateEmbeddingVector(stillThere.vector, provider.dimension).valid, false, 'it must still read back as invalid/corrupt, not silently upgraded to valid');
}));

// ---------- corrupted-store tests: a damaged record is skipped/diagnosed, never crashes the whole search ----------

test('semanticSearch safely skips a truncated/corrupted BLOB that cannot represent the expected dimension, without crashing', async () => {
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    // Bypasses upsertBatch's normal Float32Array serialization entirely - a raw, truncated
    // 2-byte BLOB where 32 bytes (8 x float32) are expected, simulating real on-disk damage.
    store.db.exec("INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES ('c1','d1','h1','deterministic','deterministic-8d',8,x'0102','t','t')");
    const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
    const query = await provider.embedQuery('anything');
    const outcome = semanticSearch(store, provider.id, provider.model, provider.dimension, query, 5);
    assert.deepEqual(outcome.hits, []);
    assert.equal(outcome.invalidVectorCount, 1);
  } finally { store.close(); }
});

test('semanticSearch safely skips a stored row whose recorded dimension does not match the actual vector length, without crashing', async () => {
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
    const now = new Date().toISOString();
    // The `dimension` column claims 8, but only 2 float32 values (8 bytes) are actually stored.
    store.upsert({ chunkId: 'c1', documentId: 'd1', contentHash: 'h1', providerId: provider.id, model: provider.model, dimension: 8, vector: Float32Array.from([1, 0]), createdAt: now, updatedAt: now });
    const query = await provider.embedQuery('anything');
    const outcome = semanticSearch(store, provider.id, provider.model, 8, query, 5);
    assert.deepEqual(outcome.hits, []);
    assert.equal(outcome.invalidVectorCount, 1);
  } finally { store.close(); }
});

test('semanticSearch safely skips a stored vector containing NaN/Infinity, without crashing, while still ranking the other valid candidates', async () => {
  const store = new EmbeddingStore(':memory:', 'root');
  try {
    const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
    const now = new Date().toISOString();
    const good = await provider.embedQuery('good chunk text');
    store.upsert({ chunkId: 'good', documentId: 'd-good', contentHash: 'h', providerId: provider.id, model: provider.model, dimension: 8, vector: good, createdAt: now, updatedAt: now });
    store.upsert({ chunkId: 'nan', documentId: 'd-nan', contentHash: 'h', providerId: provider.id, model: provider.model, dimension: 8, vector: Float32Array.from([NaN, 1, 1, 1, 1, 1, 1, 1]), createdAt: now, updatedAt: now });
    store.upsert({ chunkId: 'inf', documentId: 'd-inf', contentHash: 'h', providerId: provider.id, model: provider.model, dimension: 8, vector: Float32Array.from([Infinity, 1, 1, 1, 1, 1, 1, 1]), createdAt: now, updatedAt: now });
    const outcome = semanticSearch(store, provider.id, provider.model, 8, await provider.embedQuery('good chunk text'), 5);
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0].chunkId, 'good');
    assert.equal(outcome.invalidVectorCount, 2);
  } finally { store.close(); }
});
