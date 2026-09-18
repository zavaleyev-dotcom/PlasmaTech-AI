import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex } from '../src/services/embeddings';
import { semanticSearch } from '../src/services/embeddings/search';
import { VectorCache } from '../src/services/embeddings/cache';
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/providers/deterministic';
import { chunkConsistencyChecker } from '../src/services/rag/hybrid';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(fn: (root: string, indexFile: string, textStore: TextStore, embeddingStore: EmbeddingStore) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vector-cache-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textStore = new TextStore(path.join(temp, 'text', 'index.sqlite'), 'test');
  const embeddingStore = new EmbeddingStore(path.join(temp, 'embeddings', 'index.sqlite'), 'test');
  try { await fn(root, path.join(temp, 'metadata.json'), textStore, embeddingStore); }
  finally { textStore.close(); embeddingStore.close(); await rm(temp, { recursive: true, force: true }); }
}

// ---------- lifecycle: cold / warm / hit accounting ----------

test('VectorCache starts cold and reports empty diagnostics before any load', () => {
  const cache = new VectorCache();
  const diag = cache.diagnostics();
  assert.equal(diag.status, 'cold');
  assert.equal(diag.entries, 0);
  assert.equal(diag.hitCount, 0);
  assert.equal(diag.reloadCount, 0);
  assert.equal(diag.key, null);
});

test('VectorCache becomes ready after a load and reuses entries on a subsequent call without reloading (warm hit)', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness cache warm test ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const cache = new VectorCache();
  const checker = chunkConsistencyChecker(textStore);

  const first = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, checker);
  assert.equal(first?.length, 2);
  assert.equal(cache.diagnostics().status, 'ready');
  assert.equal(cache.diagnostics().reloadCount, 1);
  assert.equal(cache.diagnostics().hitCount, 1);

  const second = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, checker);
  assert.equal(second?.length, 2);
  assert.equal(cache.diagnostics().reloadCount, 1, 'a second call with nothing changed must be a hit, not a reload');
  assert.equal(cache.diagnostics().hitCount, 2);
}));

// ---------- model/provider/dimension separation ----------

test('VectorCache never serves entries from a different provider, model, or dimension - a key change always triggers a fresh load', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  // The embeddings table's primary key is chunkId alone (one current embedding per chunk),
  // so two DIFFERENT chunks are used here to hold two DIFFERENT providers' fingerprints
  // simultaneously - this is what genuinely exercises the cache's key-based isolation.
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness key separation test ${data.toString()}.` }] }) });
  const rows = textStore.db.prepare('SELECT id, documentId, text FROM chunks ORDER BY id').all() as { id: string; documentId: string; text: string }[];
  const [chunk1, chunk2] = rows;
  const providerA = new DeterministicEmbeddingProvider({ dimension: 8 });
  const providerB = new DeterministicEmbeddingProvider({ dimension: 16 }); // different dimension -> different model string too
  const now = new Date().toISOString();
  embeddingStore.upsert({ chunkId: chunk1.id, documentId: chunk1.documentId, contentHash: sha256(chunk1.text), providerId: providerA.id, model: providerA.model, dimension: providerA.dimension, vector: await providerA.embedQuery(chunk1.text), createdAt: now, updatedAt: now });
  embeddingStore.upsert({ chunkId: chunk2.id, documentId: chunk2.documentId, contentHash: sha256(chunk2.text), providerId: providerB.id, model: providerB.model, dimension: providerB.dimension, vector: await providerB.embedQuery(chunk2.text), createdAt: now, updatedAt: now });
  const checker = chunkConsistencyChecker(textStore);
  const cache = new VectorCache();

  const entriesA = cache.getOrLoad(embeddingStore, providerA.id, providerA.model, providerA.dimension, checker);
  assert.equal(entriesA?.length, 1);
  assert.equal(entriesA?.[0].chunkId, chunk1.id);
  assert.equal(entriesA?.[0].vector.length, 8);
  assert.equal(cache.diagnostics().reloadCount, 1);

  const entriesB = cache.getOrLoad(embeddingStore, providerB.id, providerB.model, providerB.dimension, checker);
  assert.equal(entriesB?.length, 1);
  assert.equal(entriesB?.[0].chunkId, chunk2.id);
  assert.equal(entriesB?.[0].vector.length, 16, 'must never serve the 8-dimensional entries under a 16-dimensional key');
  assert.equal(cache.diagnostics().reloadCount, 2, 'a different key must always force a reload, never reuse the wrong provider/model/dimension');

  // Switching back to A must reload again (the cache holds only ONE key's entries at a time).
  const entriesAAgain = cache.getOrLoad(embeddingStore, providerA.id, providerA.model, providerA.dimension, checker);
  assert.equal(entriesAAgain?.[0].vector.length, 8);
  assert.equal(cache.diagnostics().reloadCount, 3);
}));

// ---------- corrupted / stale records are excluded at load time ----------

test('VectorCache never loads a corrupted (NaN) vector, even when its fingerprint matches exactly', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness corrupted exclusion test ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const rows = textStore.db.prepare('SELECT id, documentId, text FROM chunks').all() as { id: string; documentId: string; text: string }[];
  const [good, bad] = rows;
  const now = new Date().toISOString();
  // Overwrite one of the two real, valid, just-embedded records with a corrupted vector.
  embeddingStore.upsert({ chunkId: bad.id, documentId: bad.documentId, contentHash: sha256(bad.text), providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: Float32Array.from([NaN, 1, 1, 1, 1, 1, 1, 1]), createdAt: now, updatedAt: now });

  const cache = new VectorCache();
  const entries = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, chunkConsistencyChecker(textStore));
  assert.equal(entries?.length, 1, 'the corrupted record must never enter the cache');
  assert.equal(entries?.[0].chunkId, good.id);
  assert.equal(cache.diagnostics().lastLoadSkippedInvalid, 1);
}));

test('VectorCache never loads a stale record (contentHash no longer matches the chunk\'s current text) or an orphan (chunk no longer exists)', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness stale exclusion test.' }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const now = new Date().toISOString();
  // A stale record: fingerprint claims a contentHash that does not match the real chunk's text.
  embeddingStore.upsert({ chunkId: 'stale-chunk', documentId: 'stale-doc', contentHash: 'wrong-hash', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: await provider.embedQuery('irrelevant'), createdAt: now, updatedAt: now });
  // An orphan: no chunk with this id exists at all.
  embeddingStore.upsert({ chunkId: 'orphan-chunk', documentId: 'orphan-doc', contentHash: 'irrelevant', providerId: provider.id, model: provider.model, dimension: provider.dimension, vector: await provider.embedQuery('also irrelevant'), createdAt: now, updatedAt: now });

  const cache = new VectorCache();
  const entries = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, chunkConsistencyChecker(textStore));
  assert.equal(entries?.length, 1, 'only the one genuinely valid+consistent record must be cached');
  assert.ok(entries?.every(e => e.chunkId !== 'stale-chunk' && e.chunkId !== 'orphan-chunk'));
  assert.equal(cache.diagnostics().lastLoadSkippedInconsistent, 2);
}));

// ---------- incremental correctness: a changed+re-embedded chunk must invalidate the cache ----------

test('VectorCache (Codex scenario): after the cache is built, one chunk\'s content changes and is re-embedded - the OLD vector must never be served again', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  // Chunk ids in this system are content-derived (sha256 of documentId:ordinal:text - see
  // chunk.ts), so a genuine content change necessarily produces a NEW chunkId; the OLD
  // chunkId's embedding becomes a real orphan. This is the actual mechanism by which "a
  // chunk changed and was re-embedded" manifests here - the required guarantee (the old
  // vector can never be served again) holds via orphan exclusion, not in-place mutation.
  await writeFile(path.join(root, 'a.pdf'), 'a');
  let currentText = 'Original coating hardness content before the change.';
  const extract = async () => ({ pageCount: 1, pages: [{ page: 1, text: currentText }] });
  await runTextIndex({ root, indexFile, store: textStore, extract });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });

  const checker = chunkConsistencyChecker(textStore);
  const cache = new VectorCache();
  const oldChunkRow = textStore.db.prepare('SELECT id FROM chunks').get() as { id: string };
  const firstLoad = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, checker);
  assert.equal(firstLoad?.length, 1);
  assert.equal(firstLoad?.[0].chunkId, oldChunkRow.id);
  assert.equal(cache.diagnostics().reloadCount, 1);

  // The chunk's content changes; library-text reprocesses it into a NEW chunk (new id), and
  // the new chunk gets embedded (a real embeddings-store write, which bumps dataVersion).
  currentText = 'Completely different content after the change - a brand new chunk id.';
  await writeFile(path.join(root, 'a.pdf'), 'a-changed'); // different size/mtime -> reprocessed
  await runTextIndex({ root, indexFile, store: textStore, extract });
  await runEmbeddingIndex({ textStore, embeddingStore, provider }); // full run -> also removes the orphan

  const newChunkRow = textStore.db.prepare('SELECT id FROM chunks').get() as { id: string };
  assert.notEqual(newChunkRow.id, oldChunkRow.id, 'sanity check: the content change really produced a new chunk id');

  const reloaded = cache.getOrLoad(embeddingStore, provider.id, provider.model, provider.dimension, checker);
  assert.equal(cache.diagnostics().reloadCount, 2, 'the data-version bump from re-embedding must force a reload');
  assert.ok(!reloaded!.some(e => e.chunkId === oldChunkRow.id), 'the OLD chunk id must never be served again - it no longer represents any real, current content');
  assert.equal(reloaded?.length, 1);
  assert.equal(reloaded?.[0].chunkId, newChunkRow.id);

  // End-to-end through semanticSearch: the old chunk id must be entirely gone from the
  // ranking, and the new content must be found via its own, correctly-cached vector.
  const newTextQuery = await provider.embedQuery(currentText);
  const outcomeNew = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, newTextQuery, 5, checker, cache);
  assert.equal(outcomeNew.hits[0]?.chunkId, newChunkRow.id);
  assert.ok(outcomeNew.hits[0].score > 0.999);
  assert.ok(!outcomeNew.hits.some(h => h.chunkId === oldChunkRow.id));
}));

// ---------- correctness: cached path must match the direct SQLite/full-sort path exactly ----------

test('semanticSearch with a cache produces IDENTICAL hits to semanticSearch without a cache, for the same store/query', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  for (let i = 0; i < 12; i++) await writeFile(path.join(root, `${i}.pdf`), String(i));
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deposition study document number ${data.toString()} with unique filler text ${data.toString()}${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 16 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const checker = chunkConsistencyChecker(textStore);
  const query = await provider.embedQuery('coating hardness deposition study document number 5');

  const withoutCache = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, query, 8, checker);
  const cache = new VectorCache();
  const withCache = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, query, 8, checker, cache);

  assert.deepEqual(withCache.hits, withoutCache.hits, 'the cached path must return byte-for-byte the same ranked hits as the direct SQLite/full-sort path');
  assert.equal(withCache.candidateCount, withoutCache.candidateCount);
}));

// ---------- cache load failure -> safe fallback to the direct SQLite path ----------

test('a transient cache-load failure never breaks the search - semanticSearch falls back to the direct SQLite path within the same call', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness fallback test ${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });

  let currentRowsCalls = 0;
  const flakyOnce = new Proxy(embeddingStore, {
    get(target, prop, receiver) {
      if (prop === 'currentRows') {
        return (...args: Parameters<EmbeddingStore['currentRows']>) => {
          currentRowsCalls++;
          if (currentRowsCalls === 1) throw new Error('transient SQLite busy error');
          return target.currentRows(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as EmbeddingStore;

  const cache = new VectorCache();
  const query = await provider.embedQuery('anything');
  const outcome = semanticSearch(flakyOnce, provider.id, provider.model, provider.dimension, query, 8, chunkConsistencyChecker(textStore), cache);
  assert.equal(outcome.candidateCount, 2, 'the direct SQLite fallback within the same call must still return the correct real results');
  assert.equal(cache.diagnostics().status, 'invalid');
  assert.ok(cache.diagnostics().invalidationReason?.includes('transient SQLite busy error'));
  assert.equal(cache.diagnostics().fallbackCount, 1);
}));

test('EMBEDDING_VECTOR_CACHE=off disables the cache - getOrLoad always returns null, semanticSearch still works via the direct path', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness disabled-cache test.' }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 8 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const previous = process.env.EMBEDDING_VECTOR_CACHE;
  try {
    process.env.EMBEDDING_VECTOR_CACHE = 'off';
    const cache = new VectorCache();
    const query = await provider.embedQuery('anything');
    const outcome = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, query, 8, chunkConsistencyChecker(textStore), cache);
    assert.equal(outcome.candidateCount, 1);
    assert.equal(cache.diagnostics().status, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_VECTOR_CACHE; else process.env.EMBEDDING_VECTOR_CACHE = previous;
  }
}));
