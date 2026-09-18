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
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/providers/deterministic';
import { chunkConsistencyChecker } from '../src/services/rag/hybrid';
import { ConsistencyCache } from '../src/services/rag/consistency-cache';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(fn: (root: string, indexFile: string, textStore: TextStore, embeddingStore: EmbeddingStore) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'consistency-cache-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textStore = new TextStore(path.join(temp, 'text', 'index.sqlite'), 'test');
  const embeddingStore = new EmbeddingStore(path.join(temp, 'embeddings', 'index.sqlite'), 'test');
  try { await fn(root, path.join(temp, 'metadata.json'), textStore, embeddingStore); }
  finally { textStore.close(); embeddingStore.close(); await rm(temp, { recursive: true, force: true }); }
}

// ---------- lifecycle: cold / warm / hit accounting ----------

test('ConsistencyCache starts cold and reports empty diagnostics before any load', () => {
  const cache = new ConsistencyCache();
  const diag = cache.diagnostics();
  assert.equal(diag.status, 'cold');
  assert.equal(diag.entries, 0);
  assert.equal(diag.hitCount, 0);
  assert.equal(diag.reloadCount, 0);
});

test('ConsistencyCache becomes ready after a load and reuses entries on a subsequent call without reloading (warm hit)', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness cache warm test ${data.toString()}.` }] }) });
  const cache = new ConsistencyCache();
  const checker1 = cache.checker(textStore);
  assert.ok(checker1);
  assert.equal(cache.diagnostics().status, 'ready');
  assert.equal(cache.diagnostics().entries, 2);
  assert.equal(cache.diagnostics().reloadCount, 1);
  assert.equal(cache.diagnostics().hitCount, 1);

  const checker2 = cache.checker(textStore);
  assert.ok(checker2);
  assert.equal(cache.diagnostics().reloadCount, 1, 'a second call with nothing changed must be a hit, not a reload');
  assert.equal(cache.diagnostics().hitCount, 2);
}));

// ---------- correctness: cached checker must match the direct/reference point-lookup checker exactly ----------

test('ConsistencyCache.checker() agrees with the direct chunkConsistencyChecker on every real chunk, a wrong documentId, a stale hash, and an orphan', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness reference comparison test ${data.toString()}.` }] }) });
  const rows = textStore.db.prepare('SELECT id, documentId, text FROM chunks ORDER BY id').all() as { id: string; documentId: string; text: string }[];
  assert.equal(rows.length, 2);

  const reference = chunkConsistencyChecker(textStore);
  const cache = new ConsistencyCache();
  const cached = cache.checker(textStore)!;

  const cases: [string, string, string][] = [
    [rows[0].id, rows[0].documentId, sha256(rows[0].text)], // genuinely consistent
    [rows[0].id, 'some-other-document-id', sha256(rows[0].text)], // wrong documentId
    [rows[0].id, rows[0].documentId, 'stale-hash-does-not-match'], // stale hash
    ['chunk-id-that-does-not-exist', rows[0].documentId, sha256(rows[0].text)], // orphan
    [rows[1].id, rows[1].documentId, sha256(rows[1].text)], // second genuinely consistent chunk
  ];
  for (const [chunkId, documentId, contentHash] of cases) {
    assert.equal(cached(chunkId, documentId, contentHash), reference(chunkId, documentId, contentHash),
      `cached and reference checkers disagree for (${chunkId}, ${documentId}, ${contentHash})`);
  }
}));

test('semanticSearch with a consistency cache produces IDENTICAL hits to semanticSearch with the direct (uncached) checker', () => fixture(async (root, indexFile, textStore, embeddingStore) => {
  for (let i = 0; i < 8; i++) await writeFile(path.join(root, `${i}.pdf`), String(i));
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deposition batch comparison document ${data.toString()} unique filler ${data.toString()}${data.toString()}.` }] }) });
  const provider = new DeterministicEmbeddingProvider({ dimension: 16 });
  await runEmbeddingIndex({ textStore, embeddingStore, provider });
  const query = await provider.embedQuery('coating hardness deposition batch comparison document 3');

  const direct = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, query, 8, chunkConsistencyChecker(textStore));
  const cache = new ConsistencyCache();
  const cachedResult = semanticSearch(embeddingStore, provider.id, provider.model, provider.dimension, query, 8, cache.checker(textStore)!);

  assert.deepEqual(cachedResult.hits, direct.hits, 'the cached consistency path must return byte-for-byte the same ranked hits as the direct per-row point-lookup path');
  assert.equal(cachedResult.candidateCount, direct.candidateCount);
}));

// ---------- incremental correctness: changed and deleted chunks must invalidate the cache ----------

test('ConsistencyCache (Codex scenario): a chunk\'s content changes (new chunk id) - the OLD chunk id must never be reported consistent again', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  let currentText = 'Original coating hardness content before the change.';
  const extract = async () => ({ pageCount: 1, pages: [{ page: 1, text: currentText }] });
  await runTextIndex({ root, indexFile, store: textStore, extract });
  const oldChunkRow = textStore.db.prepare('SELECT id, documentId FROM chunks').get() as { id: string; documentId: string };

  const cache = new ConsistencyCache();
  const checker1 = cache.checker(textStore)!;
  assert.equal(checker1(oldChunkRow.id, oldChunkRow.documentId, sha256(currentText)), true);
  assert.equal(cache.diagnostics().reloadCount, 1);

  currentText = 'Completely different content - a brand new chunk id, the old one is gone.';
  await writeFile(path.join(root, 'a.pdf'), 'a-changed');
  await runTextIndex({ root, indexFile, store: textStore, extract });
  const newChunkRow = textStore.db.prepare('SELECT id, documentId FROM chunks').get() as { id: string; documentId: string };
  assert.notEqual(newChunkRow.id, oldChunkRow.id);

  const checker2 = cache.checker(textStore)!;
  assert.equal(cache.diagnostics().reloadCount, 2, 'the data-version bump from replace() must force a reload');
  assert.equal(checker2(oldChunkRow.id, oldChunkRow.documentId, sha256('Original coating hardness content before the change.')), false, 'the OLD chunk id must never be reported consistent again - it no longer exists');
  assert.equal(checker2(newChunkRow.id, newChunkRow.documentId, sha256(currentText)), true, 'the NEW chunk id must be correctly recognized as consistent');
}));

test('ConsistencyCache (Codex scenario): a deleted document\'s chunks must never be reported consistent again', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a'); await writeFile(path.join(root, 'b.pdf'), 'b');
  await runTextIndex({ root, indexFile, store: textStore, extract: async (data: Buffer) => ({ pageCount: 1, pages: [{ page: 1, text: `Coating hardness deletion test ${data.toString()}.` }] }) });
  const rows = textStore.db.prepare('SELECT id, documentId, text FROM chunks ORDER BY id').all() as { id: string; documentId: string; text: string }[];
  const [toDelete, toKeep] = rows;

  const cache = new ConsistencyCache();
  const checker1 = cache.checker(textStore)!;
  assert.equal(checker1(toDelete.id, toDelete.documentId, sha256(toDelete.text)), true);
  assert.equal(cache.diagnostics().entries, 2);

  textStore.remove(toDelete.documentId);

  const checker2 = cache.checker(textStore)!;
  assert.equal(cache.diagnostics().reloadCount, 2, 'remove() must bump dataVersion and force a reload');
  assert.equal(cache.diagnostics().entries, 1);
  assert.equal(checker2(toDelete.id, toDelete.documentId, sha256(toDelete.text)), false, 'the deleted chunk must never be reported consistent again');
  assert.equal(checker2(toKeep.id, toKeep.documentId, sha256(toKeep.text)), true, 'the surviving chunk must still be recognized correctly');
}));

// ---------- cache load failure -> safe fallback ----------

test('a consistency-cache load failure never breaks anything - checker() returns null and the caller falls back to the direct checker', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness cache-failure fallback test.' }] }) });

  const faultyTextStore = new Proxy(textStore, {
    get(target, prop, receiver) {
      if (prop === 'db') {
        return new Proxy(target.db, {
          get(dbTarget, dbProp, dbReceiver) {
            if (dbProp === 'prepare') return () => { throw new Error('simulated SQLite failure during cache load'); };
            return Reflect.get(dbTarget, dbProp, dbReceiver);
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TextStore;

  const cache = new ConsistencyCache();
  const result = cache.checker(faultyTextStore);
  assert.equal(result, null, 'a load failure must return null, never throw');
  assert.equal(cache.diagnostics().status, 'invalid');
  assert.ok(cache.diagnostics().invalidationReason?.includes('simulated SQLite failure'));
  assert.equal(cache.diagnostics().fallbackCount, 1);

  // The real caller-side contract: fall back to the direct, uncached checker against the
  // REAL (non-faulty) textStore, which must work correctly.
  const fallbackChecker = result ?? chunkConsistencyChecker(textStore);
  const row = textStore.db.prepare('SELECT id, documentId, text FROM chunks').get() as { id: string; documentId: string; text: string };
  assert.equal(fallbackChecker(row.id, row.documentId, sha256(row.text)), true);
}));

test('RAG_CONSISTENCY_CACHE=off disables the cache - checker() always returns null', () => fixture(async (root, indexFile, textStore) => {
  await writeFile(path.join(root, 'a.pdf'), 'a');
  await runTextIndex({ root, indexFile, store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating hardness disabled-cache test.' }] }) });
  const previous = process.env.RAG_CONSISTENCY_CACHE;
  try {
    process.env.RAG_CONSISTENCY_CACHE = 'off';
    const cache = new ConsistencyCache();
    assert.equal(cache.checker(textStore), null);
    assert.equal(cache.diagnostics().status, 'disabled');
  } finally {
    if (previous === undefined) delete process.env.RAG_CONSISTENCY_CACHE; else process.env.RAG_CONSISTENCY_CACHE = previous;
  }
}));
