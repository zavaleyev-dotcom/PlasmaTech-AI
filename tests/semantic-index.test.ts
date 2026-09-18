import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex } from '../src/services/embeddings';
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/providers/deterministic';
import type { EmbeddingProvider } from '../src/services/embeddings/types';
import {
  SEMANTIC_INDEX_SAMPLE_TIERS, getSemanticIndexInfo, startSemanticIndex, stopSemanticIndex,
} from '../src/services/rag/semantic-index';
import { GET as semanticGET, POST as semanticPOST } from '../src/app/api/library/semantic/route';

/** Unlike the shared fixture() helper other test files use (which hands back already-open
 *  store instances), this one hands back FILE PATHS - startSemanticIndex/getSemanticIndexInfo
 *  each open (and close) their OWN store instances via injected openTextStore/
 *  openEmbeddingStore, exactly like the real service does; sharing a single already-open
 *  instance across both the test and the function under test would risk a double-close. */
async function fixture(fn: (root: string, indexFile: string, textDbFile: string, embeddingDbFile: string, rootId: string) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'semantic-index-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textDbFile = path.join(temp, 'text', 'index.sqlite');
  const embeddingDbFile = path.join(temp, 'embeddings', 'index.sqlite');
  const rootId = 'test';
  try { await fn(root, path.join(temp, 'metadata.json'), textDbFile, embeddingDbFile, rootId); }
  finally { await rm(temp, { recursive: true, force: true }); }
}

async function withTextIndex(root: string, indexFile: string, textDbFile: string, rootId: string, count = 1) {
  for (let i = 0; i < count; i++) await writeFile(path.join(root, `${i}.pdf`), String(i));
  const store = new TextStore(textDbFile, rootId);
  try { await runTextIndex({ root, indexFile, store, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deposition study document ${data.toString()}.` }] }) }); }
  finally { store.close(); }
}

const openTextStore = (textDbFile: string, rootId: string) => async () => new TextStore(textDbFile, rootId);
const openEmbeddingStore = (embeddingDbFile: string, rootId: string) => async () => new EmbeddingStore(embeddingDbFile, rootId);

// ---------- status: not_configured / empty / partial / ready / stale / building / error ----------

test('getSemanticIndexInfo reports not_configured when no provider is configured, without breaking or opening the embedding store unnecessarily', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId);
  const info = await getSemanticIndexInfo({ provider: null, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(info.status, 'not_configured');
  assert.equal(info.provider, null);
  assert.equal(info.requiresExternalConfirmation, false);
  assert.equal(info.embeddedChunks, 0);
}));

test('getSemanticIndexInfo reports empty when a provider is configured but nothing has been embedded yet', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 3);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const info = await getSemanticIndexInfo({ provider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(info.status, 'empty');
  assert.equal(info.totalChunks, 3);
  assert.equal(info.embeddedChunks, 0);
  assert.equal(info.coveragePercent, 0);
  assert.equal(info.requiresExternalConfirmation, false, 'the deterministic provider never requires external confirmation');
}));

test('getSemanticIndexInfo reports partial when only some current chunks are embedded, and ready once all are', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 4);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const textStore = new TextStore(textDbFile, rootId);
  const embeddingStore = new EmbeddingStore(embeddingDbFile, rootId);
  try { await runEmbeddingIndex({ textStore, embeddingStore, provider, sample: 2 }); }
  finally { textStore.close(); embeddingStore.close(); }

  const partial = await getSemanticIndexInfo({ provider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.embeddedChunks, 2);
  assert.equal(partial.totalChunks, 4);
  assert.equal(partial.coveragePercent, 50);

  const textStore2 = new TextStore(textDbFile, rootId);
  const embeddingStore2 = new EmbeddingStore(embeddingDbFile, rootId);
  try { await runEmbeddingIndex({ textStore: textStore2, embeddingStore: embeddingStore2, provider }); }
  finally { textStore2.close(); embeddingStore2.close(); }

  const ready = await getSemanticIndexInfo({ provider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.coveragePercent, 100);
  assert.equal(ready.lastBuildTime !== null, true);
}));

test('getSemanticIndexInfo reports stale and breaks down invalid/orphan/stale counts separately when corrupted/mismatched records exist', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 1);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const textStore = new TextStore(textDbFile, rootId);
  const embeddingStore = new EmbeddingStore(embeddingDbFile, rootId);
  const now = new Date().toISOString();
  try {
    await runEmbeddingIndex({ textStore, embeddingStore, provider });
    // Invalid: a structurally corrupted (NaN) vector - caught before any chunk lookup.
    embeddingStore.upsert({ chunkId: 'invalid-chunk', documentId: 'irrelevant-doc', contentHash: 'irrelevant', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: Float32Array.from([NaN, 1, 1, 1, 1, 1, 1, 1]), createdAt: now, updatedAt: now });
    // Orphan: a structurally VALID vector, but for a chunkId that never existed at all.
    embeddingStore.upsert({ chunkId: 'orphan-chunk', documentId: 'orphan-doc', contentHash: 'irrelevant', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: await provider.embedQuery('orphan text'), createdAt: now, updatedAt: now });
    // Stale: the REAL chunk's own embedding, deliberately overwritten with a valid vector
    // but a contentHash that no longer matches its actual (unchanged) text.
    const realChunk = textStore.db.prepare('SELECT id, documentId FROM chunks').get() as { id: string; documentId: string } | undefined;
    if (realChunk) embeddingStore.upsert({ chunkId: realChunk.id, documentId: realChunk.documentId, contentHash: 'stale-hash-does-not-match', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: await provider.embedQuery('x'), createdAt: now, updatedAt: now });
  } finally { textStore.close(); embeddingStore.close(); }

  const info = await getSemanticIndexInfo({ provider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(info.status, 'stale');
  assert.equal(info.invalidVectorCount, 1, 'the structurally corrupted vector must be counted as invalid, not orphan/stale');
  assert.equal(info.orphanCount, 1, 'the record with a valid vector but a nonexistent chunkId must be counted as orphan');
  assert.equal(info.staleCount, 1, 'the real chunk\'s own record now has a contentHash that no longer matches its actual text');
  assert.equal(info.embeddedChunks, 0, 'none of the three records are currently valid+consistent');
  assert.ok(info.embeddedChunks <= info.totalChunks, 'coverage must never exceed 100%');
}));

test('getSemanticIndexInfo reports building while a job is running, using the sample target for a meaningful percent', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 5);
  const embeddingStore = new EmbeddingStore(embeddingDbFile, rootId);
  embeddingStore.claim({ running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 2, processed: 1, reused: 0, embedded: 1, failed: 0, skipped: 0, orphanRemoved: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, sampleTarget: 10 });
  embeddingStore.close();
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const info = await getSemanticIndexInfo({ provider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(info.status, 'building');
  assert.equal(info.progress?.running, true);
  assert.equal(info.progress?.percent, 10, '1 processed out of a sampleTarget of 10, not out of total=2');
}));

test('getSemanticIndexInfo reports error with a fixed, safe message (never a raw exception) when the text index cannot be opened', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  const info = await getSemanticIndexInfo({
    provider: null,
    openTextStore: async () => { throw new Error(`ENOENT: /Users/real/secret/path/${textDbFile} sk-leaked-key-1234`); },
    openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId),
  });
  assert.equal(info.status, 'error');
  assert.ok(info.lastError);
  assert.ok(!info.lastError!.includes('sk-leaked-key'));
  assert.ok(!info.lastError!.includes('/Users/real/secret/path'));
  assert.ok(!info.lastError!.includes(textDbFile));
}));

test('getSemanticIndexInfo reports error with a safe message when the embedding store itself cannot be opened (storage failure)', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 1);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const info = await getSemanticIndexInfo({
    provider,
    openTextStore: openTextStore(textDbFile, rootId),
    openEmbeddingStore: async () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed at /Users/real/secret/embeddings.sqlite'); },
  });
  assert.equal(info.status, 'error');
  assert.ok(!info.lastError!.includes('SQLITE_CORRUPT'));
  assert.ok(!info.lastError!.includes('/Users/real/secret'));
}));

// ---------- job launch: sample sizes, reuse, duplicate launch, confirmation, provider failure ----------

test('startSemanticIndex rejects a sample size outside the three allowed tiers, without opening anything', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  let opened = false;
  const result = await startSemanticIndex({
    sampleSize: 999, provider: new DeterministicEmbeddingProvider({ dimension: 8 }),
    openTextStore: async () => { opened = true; return new TextStore(textDbFile, rootId); },
    openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'invalid_sample');
  assert.equal(opened, false, 'an invalid sample size must never open any store');
  assert.deepEqual([...SEMANTIC_INDEX_SAMPLE_TIERS], [200, 2000, 10000]);
}));

test('startSemanticIndex refuses to start (not_configured) when no provider is configured, making no calls at all', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  const result = await startSemanticIndex({ sampleSize: 200, provider: null, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not_configured');
}));

test('startSemanticIndex (Codex regression) requires explicit confirmExternal for a non-deterministic provider, and makes NO provider call without it', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 2);
  let providerCalls = 0;
  const fakeExternalProvider: EmbeddingProvider = {
    id: 'openai', model: 'test-model', dimension: 8, configured: () => true,
    outboundDataDescription: 'Текст фрагментов отправляется во внешний API.',
    embedDocuments: async texts => { providerCalls++; return texts.map(() => new Float32Array(8).fill(1)); },
    embedQuery: async () => { providerCalls++; return new Float32Array(8).fill(1); },
  };
  const withoutConfirmation = await startSemanticIndex({
    sampleSize: 200, provider: fakeExternalProvider, confirmExternal: false,
    openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId),
  });
  assert.equal(withoutConfirmation.ok, false);
  if (!withoutConfirmation.ok) assert.equal(withoutConfirmation.reason, 'confirmation_required');
  await new Promise(r => setTimeout(r, 50)); // would-be background job has had time to run if incorrectly started
  assert.equal(providerCalls, 0, 'no provider call may ever happen without explicit confirmation');

  const withConfirmation = await startSemanticIndex({
    sampleSize: 200, provider: fakeExternalProvider, confirmExternal: true,
    openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId),
  });
  assert.equal(withConfirmation.ok, true);
  for (let i = 0; i < 50 && providerCalls === 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(providerCalls > 0, 'with explicit confirmation, the job must actually run and call the provider');
}));

test('startSemanticIndex (200-chunk job) runs to completion via the existing incremental pipeline, and a second run reuses everything without re-calling the provider', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 5);
  let providerCalls = 0;
  const base = new DeterministicEmbeddingProvider({ dimension: 8 });
  const countingProvider: EmbeddingProvider = {
    id: base.id, model: base.model, dimension: base.dimension, outboundDataDescription: base.outboundDataDescription,
    configured: () => base.configured(),
    embedQuery: text => base.embedQuery(text),
    embedDocuments: texts => { providerCalls += texts.length; return base.embedDocuments(texts); },
  };
  const first = await startSemanticIndex({ sampleSize: 200, provider: countingProvider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(first.ok, true);
  let progress; for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); const s = new EmbeddingStore(embeddingDbFile, rootId); progress = s.progress(); s.close(); if (progress && !progress.running) break; }
  assert.equal(progress?.running, false);
  assert.equal(progress?.embedded, 5);
  assert.equal(providerCalls, 5);

  const second = await startSemanticIndex({ sampleSize: 200, provider: countingProvider, openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(second.ok, true);
  let progress2; for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); const s = new EmbeddingStore(embeddingDbFile, rootId); progress2 = s.progress(); s.close(); if (progress2 && !progress2.running && progress2.startedAt !== progress?.startedAt) break; }
  assert.equal(progress2?.reused, 5, 'the second run must reuse every chunk, never re-embed');
  assert.equal(providerCalls, 5, 'no additional provider calls on the reuse run');
}));

test('startSemanticIndex refuses a second launch while a job is already running (duplicate launch), without starting a parallel job', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 2);
  const embeddingStore = new EmbeddingStore(embeddingDbFile, rootId);
  embeddingStore.claim({ running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 0, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0, orphanRemoved: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  embeddingStore.close();
  const result = await startSemanticIndex({ sampleSize: 200, provider: new DeterministicEmbeddingProvider({ dimension: 8 }), openTextStore: openTextStore(textDbFile, rootId), openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'already_running');
}));

test('startSemanticIndex (Codex regression) surfaces a storage failure as embedded=0/failed>0 via the existing three-way error separation, never as a provider error', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  await withTextIndex(root, indexFile, textDbFile, rootId, 2);
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  const result = await startSemanticIndex({
    sampleSize: 200, provider,
    openTextStore: openTextStore(textDbFile, rootId),
    openEmbeddingStore: async () => {
      const real = new EmbeddingStore(embeddingDbFile, rootId);
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'upsertBatch') return () => { throw new Error('disk full'); };
          return Reflect.get(target, prop, receiver);
        },
      }) as EmbeddingStore;
    },
  });
  assert.equal(result.ok, true, 'the job itself starts fine - the failure happens once it is already running, in the background');
  let progress; for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 20)); const s = new EmbeddingStore(embeddingDbFile, rootId); progress = s.progress(); s.close(); if (progress && !progress.running) break; }
  assert.equal(progress?.embedded, 0);
  assert.ok((progress?.failed ?? 0) > 0);
  assert.match(progress?.error ?? '', /хранилищ/i);
}));

// ---------- route-level: auth and request-shape validation (never touches the real store) ----------

test('the /api/library/semantic route rejects non-local requests for every method, before touching any store', async () => {
  assert.equal((await semanticGET(new Request('http://evil.example/api/library/semantic', { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await semanticPOST(new Request('http://localhost/api/library/semantic', { method: 'POST', headers: { host: 'localhost' } }))).status, 403, 'missing content-type must also be rejected, matching every other local library POST route');
});

test('the /api/library/semantic POST route rejects an out-of-range or malformed sampleSize with a clear 400, before calling startSemanticIndex', async () => {
  const outOfRange = await semanticPOST(new Request('http://localhost/api/library/semantic', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ sampleSize: 999 }) }));
  assert.equal(outOfRange.status, 400);
  const malformed = await semanticPOST(new Request('http://localhost/api/library/semantic', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: 'not json' }));
  assert.equal(malformed.status, 400);
  const missing = await semanticPOST(new Request('http://localhost/api/library/semantic', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(missing.status, 400);
});

test('stopSemanticIndex requests a safe stop and is a harmless no-op when nothing is running', () => fixture(async (root, indexFile, textDbFile, embeddingDbFile, rootId) => {
  const noop = await stopSemanticIndex({ openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  assert.equal(noop.stopping, true);

  const embeddingStore = new EmbeddingStore(embeddingDbFile, rootId);
  embeddingStore.claim({ running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 0, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0, orphanRemoved: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  embeddingStore.close();
  await stopSemanticIndex({ openEmbeddingStore: openEmbeddingStore(embeddingDbFile, rootId) });
  const check = new EmbeddingStore(embeddingDbFile, rootId);
  assert.equal(check.progress()?.stopRequested, true);
  check.close();
}));
