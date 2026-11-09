import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { EmbeddingStore } from '../src/services/embeddings/store';
import { runEmbeddingIndex } from '../src/services/embeddings';
import { DeterministicEmbeddingProvider } from '../src/services/embeddings/providers/deterministic';
import { hybridRetrieve, incompatibleIndexReason } from '../src/services/rag/hybrid';
import { askLibrary } from '../src/services/rag/service';
import { semanticCoverageWarning } from '../src/services/rag/prompt';

const TOPICS = ['магнетронное распыление титана', 'фильтрованная вакуумная дуга углерода', 'плазмохимическое осаждение нитрида кремния', 'атомно-слоевое осаждение оксида алюминия'];

interface Fx { textStore: TextStore; embeddingStore: EmbeddingStore; textFile: string; embFile: string }
async function fixture(fn: (fx: Fx) => Promise<void>): Promise<void> {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ds-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textFile = path.join(temp, 'text', 'index.sqlite'); const embFile = path.join(temp, 'embeddings', 'index.sqlite');
  const textStore = new TextStore(textFile, 'test'); const embeddingStore = new EmbeddingStore(embFile, 'test');
  try {
    for (let i = 0; i < TOPICS.length; i++) await writeFile(path.join(root, `d${i}.pdf`), `d${i}`);
    let n = 0;
    await runTextIndex({ root, indexFile: path.join(temp, 'metadata.json'), store: textStore, extract: async () => { const i = n++ % TOPICS.length; return { pageCount: 1, pages: [{ page: 1, text: `Синтетический документ про ${TOPICS[i]} с уникальным словом тест${i}.` }] }; } });
    assert.equal(textStore.overview().stats.chunks, 4, 'fixture: 4 chunks');
    await fn({ textStore, embeddingStore, textFile, embFile });
  } finally { textStore.close(); embeddingStore.close(); await rm(temp, { recursive: true, force: true }); }
}
const det = (dimension = 16) => new DeterministicEmbeddingProvider({ dimension });
const stub = { id: 'stub', configured: () => true, generate: async () => ({ claims: [] }) };
const ask = (fx: Fx, mode: 'semantic' | 'hybrid' | 'lexical', provider: DeterministicEmbeddingProvider | null, includeDiagnostics = false) =>
  askLibrary({ question: 'осаждение нитрида кремния', mode, limit: 4 }, {
    openStore: async () => new TextStore(fx.textFile, 'test'), openEmbeddingStore: async () => new EmbeddingStore(fx.embFile, 'test'),
    provider: stub, embeddingProvider: provider, includeDiagnostics,
  });
/** Makes `n` of the stored vectors unreadable (a damaged blob). */
const corrupt = (fx: Fx, n: number): void => { fx.embeddingStore.db.exec(`UPDATE embeddings SET vector = x'00010203' WHERE chunkId IN (SELECT chunkId FROM embeddings LIMIT ${n})`); };

// ---------- D-S1 ----------
test('D-S1: an EMPTY index keeps the "empty" reason (nothing stored at all)', () => fixture(async fx => {
  for (const mode of ['semantic', 'hybrid'] as const) {
    const r = await hybridRetrieve({ textStore: fx.textStore, mode, question: 'осаждение нитрида кремния', limit: 4, embeddingProvider: det(), embeddingStore: fx.embeddingStore });
    assert.equal(r.mode, 'lexical');
    assert.match(r.diagnostics.fallbackReason ?? '', /пуст/);
    assert.ok(r.chunks.length >= 1, 'lexical fallback still answers');
  }
}));

test('D-S1: an INCOMPATIBLE index (16-d vectors, provider now 32-d) is not called empty; it is explained, kept untouched, and lexical still works', () => fixture(async fx => {
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det(16) });
  assert.equal(fx.embeddingStore.totalCount(), 4);
  const other = det(32);
  for (const mode of ['semantic', 'hybrid'] as const) {
    const r = await hybridRetrieve({ textStore: fx.textStore, mode, question: 'осаждение нитрида кремния', limit: 4, embeddingProvider: other, embeddingStore: fx.embeddingStore });
    assert.equal(r.mode, 'lexical', 'safe fallback');
    const reason = r.diagnostics.fallbackReason ?? '';
    assert.doesNotMatch(reason, /пуст/, 'not "empty"');
    assert.match(reason, /несовместим/); assert.match(reason, /4 векторов/); assert.match(reason, /deterministic-32d/); assert.match(reason, /не удалён и не изменён/);
    assert.ok(r.chunks.length >= 1);
  }
  assert.equal(fx.embeddingStore.totalCount(), 4, 'old vectors are not deleted');
  assert.equal(fx.embeddingStore.currentCount('deterministic', 'deterministic-16d', 16), 4, 'and not converted or re-indexed');
  assert.ok(!/sk-|api[_-]?key|Bearer/i.test(incompatibleIndexReason(4, other)), 'no secrets in the message');
}));

test('D-S1: a different model name (same dimension) is also reported as incompatible', () => fixture(async fx => {
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det(16) });
  const renamed = { ...det(16), id: 'deterministic' as const, model: 'other-model', dimension: 16, configured: () => true, embedDocuments: async () => [], embedQuery: async () => new Float32Array(16), outboundDataDescription: '' };
  const r = await hybridRetrieve({ textStore: fx.textStore, mode: 'hybrid', question: 'осаждение нитрида кремния', limit: 4, embeddingProvider: renamed as never, embeddingStore: fx.embeddingStore });
  assert.match(r.diagnostics.fallbackReason ?? '', /несовместим/);
}));

// ---------- D-S2 ----------
test('D-S2: full coverage -> no warning, any environment; lexical -> never a warning', () => fixture(async fx => {
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det() });
  for (const mode of ['semantic', 'hybrid', 'lexical'] as const) {
    const r = await ask(fx, mode, det());
    assert.equal(r.semanticWarning, undefined, mode);
    assert.equal(r.diagnostics, undefined, 'production-like: no diagnostics block');
  }
}));

test('D-S2: 4 chunks, 2 vectors damaged (50%) -> semantic/hybrid still search the valid ones, the user gets the warning, diagnostics off', () => fixture(async fx => {
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det() });
  corrupt(fx, 2);
  for (const mode of ['semantic', 'hybrid'] as const) {
    const r = await ask(fx, mode, det());
    assert.equal(r.mode, mode, 'really ran semantic/hybrid, not a hidden fallback');
    assert.equal(r.semanticWarning, semanticCoverageWarning(0.5));
    assert.match(r.semanticWarning!, /Семантический индекс содержит не все документы/); assert.match(r.semanticWarning!, /50%/); assert.match(r.semanticWarning!, /неполными/);
    assert.ok(r.chunks.length >= 1);
    assert.equal(r.diagnostics, undefined, 'the warning does not depend on the diagnostics block');
  }
  assert.equal(semanticCoverageWarning(0.999).includes('99%'), true, 'never rounds an incomplete index up to 100%');
  const lexical = await ask(fx, 'lexical', det());
  assert.equal(lexical.semanticWarning, undefined, 'lexical search is unchanged and never warns');
  assert.ok(lexical.chunks.length >= 1);
}));

test('D-S2: coverage recovered 2/4 -> 4/4: the warning disappears; a corrupted index FILE degrades safely without a warning claiming coverage', () => fixture(async fx => {
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det() });
  corrupt(fx, 2);
  assert.ok((await ask(fx, 'hybrid', det())).semanticWarning);
  await runEmbeddingIndex({ textStore: fx.textStore, embeddingStore: fx.embeddingStore, provider: det() });   // rebuild of the damaged rows (explicit user action)
  const healed = await ask(fx, 'hybrid', det());
  assert.equal(healed.semanticWarning, undefined);
  const r = await askLibrary({ question: 'осаждение нитрида кремния', mode: 'hybrid', limit: 4 }, {
    openStore: async () => new TextStore(fx.textFile, 'test'), openEmbeddingStore: async () => { throw new Error('file is not a database'); }, provider: stub, embeddingProvider: det(),
  });
  assert.equal(r.mode, 'lexical'); assert.equal(r.semanticWarning, undefined); assert.ok(r.chunks.length >= 1);
}));

test('D-S2: the warning is part of the normal screen (not the diagnostics block) and nothing starts indexing', () => {
  const ui = readFileSync(path.join(__dirname, '../src/components/local-library/ask.tsx'), 'utf8');
  assert.match(ui, /\{result\.semanticWarning && <p role="status"[^>]*>\{result\.semanticWarning\}<\/p>\}/);
  assert.ok(ui.indexOf('result.semanticWarning') < ui.indexOf('result.diagnostics &&'), 'shown above and independent of the dev-only diagnostics details');
  const service = readFileSync(path.join(__dirname, '../src/services/rag/service.ts'), 'utf8');
  assert.ok(!/runEmbeddingIndex|startSemanticIndex/.test(service), 'asking never starts an indexing run');
});
