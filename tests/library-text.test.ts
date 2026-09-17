import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink, readFile, truncate } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { TextReader } from '../src/services/library-text/extract';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex, textConfig } from '../src/services/library-text';
import { chunkPages } from '../src/services/library-text/chunk';
import { textPdf } from './fixtures/pdf';
import { GET as pdfGET } from '../src/app/api/library/pdf/route';
async function fixture(fn: (root: string, indexFile: string, store: TextStore) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'text-index-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const store = new TextStore(path.join(temp, 'private', 'index.sqlite'), 'test');
  try { await fn(root, path.join(temp, 'metadata.json'), store); }
  finally { store.close(); await rm(temp, { recursive: true, force: true }); }
}
test('full PDF extraction includes pages beyond first two with reliable page numbers', async () => {
  const reader = new TextReader();
  try {
    const result = await reader.read(textPdf(['First coating page.', 'Second plasma page.', 'Third vacuum page.']));
    assert.equal(result.pageCount, 3);
    assert.deepEqual(result.pages.map(p => p.page), [1, 2, 3]);
    assert.match(result.pages[2].text, /Third vacuum/);
    await assert.rejects(reader.read(Buffer.from('broken PDF')));
  } finally { reader.close(); }
});
test('chunks preserve sentences, page ranges, overlap, stable IDs and all words', () => {
  const sentence = (n: number) => `Sentence${n} contains these ten words about plasma coating technology today.`;
  const pages = [1, 2].map(page => ({ page, text: Array.from({ length: 150 }, (_, i) => sentence(page * 1000 + i)).join(' ') }));
  const chunks = chunkPages('doc', pages);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(c => c.wordCount <= 1500 && c.text.endsWith('.')));
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1].text.split(' '); const next = chunks[i].text.split(' ');
    let overlap = 0;
    for (let n = 1; n <= 180; n++) if (previous.slice(-n).join(' ') === next.slice(0, n).join(' ')) overlap = n;
    assert.ok(overlap >= 120 && overlap <= 180, `overlap=${overlap}`);
  }
  for (const page of pages) for (const word of page.text.split(' ')) assert.ok(chunks.some(c => c.text.includes(word)));
  assert.deepEqual(chunkPages('doc', pages), chunks);
  assert.notEqual(chunkPages('other', pages)[0].id, chunks[0].id);
  assert.equal(chunks[0].pageStart, 1); assert.equal(chunks.at(-1)!.pageEnd, 2);
  assert.deepEqual(chunkPages('empty', [{ page: 1, text: '' }]), []);
  assert.throws(() => chunkPages('doc', pages, 100, 60));
});
test('incremental index persists text; unchanged PDF not reprocessed; modified and new PDF processed; deleted removed', () => fixture(async (root, indexFile, store) => {
  let calls = 0;
  const extract = async () => { calls++; return { pageCount: 3, pages: [{ page: 3, text: 'Vacuum plasma coating. Diamond like carbon.' }] }; };
  const first = path.join(root, 'one.pdf'); await writeFile(first, 'original');
  const original = await readFile(first);
  await runTextIndex({ root, indexFile, store, extract }); assert.equal(calls, 1);
  const firstHit = store.search('"diamond like carbon"').hits[0]; assert.equal(firstHit.pageStart, 3);
  assert.match(store.db.prepare('SELECT text FROM documents').get()!.text as string, /Vacuum/);
  await runTextIndex({ root, indexFile, store, extract }); assert.equal(calls, 1);
  assert.equal(store.progress()!.reused, 1); assert.equal(store.search('coating').hits[0].chunkId, firstHit.chunkId);
  assert.deepEqual(await readFile(first), original);
  await writeFile(first, 'changed larger'); await writeFile(path.join(root, 'two.pdf'), 'new');
  await runTextIndex({ root, indexFile, store, extract }); assert.equal(calls, 3); assert.equal(store.stats().documents, 2);
  await rm(first); await runTextIndex({ root, indexFile, store, extract });
  assert.equal(store.stats().documents, 1); assert.equal(store.search('coating').total, 1);
  assert.equal(store.records()[0].relativePath, 'two.pdf');
}));
test('damaged and image-only PDFs do not stop extraction of other files', () => fixture(async (root, indexFile, store) => {
  await writeFile(path.join(root, 'broken.pdf'), 'broken');
  await writeFile(path.join(root, 'empty.pdf'), textPdf(['']));
  await writeFile(path.join(root, 'good.pdf'), textPdf(['A good coating paper.']));
  await runTextIndex({ root, indexFile, store });
  assert.equal(store.stats().documents, 3); assert.equal(store.stats().successful, 1);
  assert.equal(store.stats().errors, 1); assert.equal(store.stats().skipped, 1);
  assert.equal(store.search('coating').total, 1);
}));
test('lexical search handles phrases, Cyrillic, punctuation and untrusted search syntax safely', () => fixture(async (root, indexFile, store) => {
  await writeFile(path.join(root, 'a.pdf'), 'test');
  await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Вакуумное покрытие. Diamond like carbon deposition. <script>alert(1)</script>' }] }) });
  assert.equal(store.search('"diamond like carbon"').total, 1);
  assert.equal(store.search('diamond deposition').total, 1);
  assert.equal(store.search('вакуумное покрытие').total, 1);
  assert.equal(store.search('"carbon like diamond"').total, 0);
  for (const q of ['"', '*', 'x OR 1=1', "';DROP TABLE documents;--"]) assert.doesNotThrow(() => store.search(q));
  assert.equal(store.stats().documents, 1); assert.throws(() => store.search('x'.repeat(501)));
}));
test('cancellation preserves completed documents, allows resume and excludes aborted documents', () => fixture(async (root, indexFile, store) => {
  for (let i = 0; i < 4; i++) await writeFile(path.join(root, `${i}.pdf`), 'test');
  let calls = 0;
  await runTextIndex({ root, indexFile, store, extract: async (_, signal) => {
    calls++;
    if (calls >= 2) {
      store.requestStop();
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
    }
    return { pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] };
  } });
  assert.equal(store.progress()!.cancelled, true);
  assert.equal(store.stats().errors, 0);
  await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }) });
  assert.equal(store.stats().successful, 4); assert.equal(store.progress()!.running, false);
}));
test('outside-root symlinks are excluded; PDF endpoint rejects paths and remote requests', () => fixture(async (root, indexFile, store) => {
  await symlink('/etc/passwd', path.join(root, 'outside.pdf'));
  await runTextIndex({ root, indexFile, store }); assert.equal(store.stats().documents, 0);
  assert.equal((await pdfGET(new Request('http://localhost/api/library/pdf?id=../../etc/passwd', { headers: { host: 'localhost' } }))).status, 400);
  assert.equal((await pdfGET(new Request('http://evil.example/api/library/pdf?id=' + 'a'.repeat(64), { headers: { host: 'evil.example' } }))).status, 403);
}));
test('failed re-extraction removes stale searchable chunks; sample run never sweeps other documents', () => fixture(async (root, indexFile, store) => {
  await writeFile(path.join(root, 'one.pdf'), 'one'); await writeFile(path.join(root, 'two.pdf'), 'two');
  const extract = async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Unique previous plasma text.' }] });
  await runTextIndex({ root, indexFile, store, extract }); assert.equal(store.search('plasma').total, 2);
  await writeFile(path.join(root, 'one.pdf'), 'changed PDF');
  await runTextIndex({ root, indexFile, store, sample: 1, extract: async () => { throw new Error('broken'); } });
  assert.equal(store.stats().documents, 2); assert.equal(store.stats().errors, 1);
  assert.equal(store.search('plasma').total, 1); assert.equal(store.search('plasma').hits[0].filename, 'two.pdf');
}));
test('text processing leaves existing metadata index byte-for-byte unchanged', () => fixture(async (root, indexFile, store) => {
  const metadata = JSON.stringify({ version: 1, rootId: 'different-root', records: [], errors: [], indexedAt: null });
  await writeFile(indexFile, metadata); await writeFile(path.join(root, 'example.pdf'), 'fixture');
  await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Content.' }] }) });
  assert.equal(await readFile(indexFile, 'utf8'), metadata);
}));
test('PDF larger than 128 MB is recorded as skipped without ever being read or extracted', () => fixture(async (root, indexFile, store) => {
  const big = path.join(root, 'huge.pdf');
  await writeFile(big, ''); await truncate(big, 128 * 1024 * 1024 + 1);
  await writeFile(path.join(root, 'small.pdf'), 'small');
  let calls = 0;
  const extract = async () => { calls++; return { pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }; };
  await runTextIndex({ root, indexFile, store, extract });
  assert.equal(calls, 1, 'extract must only run for the file under the limit');
  assert.equal(store.stats().documents, 2); assert.equal(store.stats().skipped, 1);
  const huge = store.records().find(r => r.relativePath === 'huge.pdf')!;
  const doc = store.db.prepare('SELECT status, error, text FROM documents WHERE id=?').get(huge.id) as { status: string; error: string; text: string };
  assert.equal(doc.status, 'skipped'); assert.match(doc.error, /128 МБ/); assert.equal(doc.text, '');
}));
test('a second text-index run is rejected while one is already in progress, and resumes once it finishes', () => fixture(async (root, indexFile, store) => {
  await writeFile(path.join(root, 'one.pdf'), 'one');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // claim() runs synchronously before the first await inside runTextIndex, so by the time
  // this call returns a pending promise the "running" state is already committed to SQLite.
  const first = runTextIndex({ root, indexFile, store, extract: async () => { await gate; return { pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }; } });
  await assert.rejects(
    runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'x' }] }) }),
    /уже запущено/,
  );
  release();
  await first;
  assert.equal(store.progress()!.running, false);
  assert.equal(store.stats().successful, 1);
  // Now that the first run finished, a new run must be allowed again.
  await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }) });
  assert.equal(store.progress()!.running, false);
}));
test('a run resumes after a previous process died leaving a stale running flag with a dead PID', () => fixture(async (root, indexFile, store) => {
  await writeFile(path.join(root, 'one.pdf'), 'one');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
  store.setProgress({
    running: true, cancelled: false, stopRequested: false, pid: dead,
    total: 1, processed: 0, reused: 0, extracted: 0, errors: 0, skipped: 0, chunks: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
  });
  const overview = store.overview();
  assert.equal(overview.progress?.running, false);
  assert.match(overview.progress?.error ?? '', /остановлен/);
  await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }) });
  assert.equal(store.stats().successful, 1);
  assert.equal(store.progress()!.running, false);
  assert.equal(store.progress()!.error, null);
}));
test('repeated replace cycles reprocess every iteration and keep the FTS index consistent with chunks', () => fixture(async (root, indexFile, store) => {
  const file = path.join(root, 'one.pdf');
  // The incremental index only skips reprocessing when BOTH fileSize and modifiedDate match
  // the prior run (src/services/library-text/index.ts). Giving every revision a strictly
  // different byte length forces fileSize to always differ, so each iteration is guaranteed
  // to be reprocessed regardless of filesystem mtime resolution or timing.
  for (let i = 0; i < 5; i++) {
    await writeFile(file, `revision content marker ${i} ${'x'.repeat(i * 8 + 1)}`);
    await runTextIndex({ root, indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: `Plasma coating revision ${i}.` }] }) });
    assert.equal(store.progress()!.reused, 0, `iteration ${i} must be reprocessed, not reused`);
    const current = store.db.prepare('SELECT text FROM documents WHERE relativePath=?').get('one.pdf') as { text: string };
    assert.match(current.text, new RegExp(`revision ${i}\\.`), `document text must reflect iteration ${i} right after it runs`);
  }
  assert.equal(store.stats().documents, 1);

  // The plain 'integrity-check' command only verifies that the FTS shadow structures are
  // internally well-formed; it does NOT compare them against the external content table, so
  // it cannot prove FTS/chunks consistency. Passing rank=1 additionally re-derives the index
  // from the CURRENT `chunks` rows and fails if they disagree - this is the documented fts5
  // mechanism for checking an external-content table against its content table.
  const integrityCheck = () => store.db.prepare("INSERT INTO content_search(content_search, rank) VALUES('integrity-check', 1)").run();
  assert.doesNotThrow(integrityCheck, 'FTS index must match current chunks after five replace cycles');

  // Direct MATCH against content_search (no join to chunks/documents): the current revision
  // must resolve to exactly the live chunk rowid, and each superseded revision's text must be
  // genuinely purged from the raw FTS postings, not merely filtered out by a later join.
  const rawMatch = (term: string) => (store.db.prepare('SELECT rowid FROM content_search WHERE content_search MATCH ?').all(`"${term}"`) as { rowid: number }[]).map(r => r.rowid);
  const currentChunk = store.db.prepare('SELECT rowid FROM chunks').get() as { rowid: number };
  assert.deepEqual(rawMatch('revision 4'), [currentChunk.rowid]);
  for (let i = 0; i < 4; i++) assert.deepEqual(rawMatch(`revision ${i}`), [], `stale posting for revision ${i} must not remain in the raw FTS index`);
  assert.equal(store.search('coating').total, 1);
  assert.match(store.search('coating').hits[0].snippet, /revision 4/);
  const orphanChunks = store.db.prepare('SELECT count(*) n FROM chunks WHERE documentId NOT IN (SELECT id FROM documents)').get()!.n as number;
  assert.equal(orphanChunks, 0);

  // Prove the rank=1 check is not vacuous: an artificial posting for a rowid that does not
  // exist in chunks (a stale/orphaned FTS entry) must make the same check fail. This mirrors
  // exactly the kind of desync a broken delete trigger would leave behind.
  store.db.prepare('INSERT INTO content_search(rowid, text) VALUES (?, ?)').run(999_999_999, 'orphaned stale posting');
  assert.throws(integrityCheck, 'a desynced FTS entry must be detected by integrity-check(rank=1)');
}));
test('PDF endpoint streams partial content and returns 416 for out-of-range or malformed Range requests', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'text-range-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const cwd = path.join(temp, 'cwd'); await mkdir(cwd);
  const previousCwd = process.cwd();
  const previousPath = process.env.SCIENTIFIC_LIBRARY_PATH;
  process.env.SCIENTIFIC_LIBRARY_PATH = root;
  process.chdir(cwd);
  let store: TextStore | undefined;
  try {
    await writeFile(path.join(root, 'sample.pdf'), 'sample pdf bytes for a range request test');
    const config = await textConfig();
    store = new TextStore(config.databaseFile, config.rootId);
    await runTextIndex({ root: config.root, indexFile: config.indexFile, store, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: 'Coating text.' }] }) });
    const id = store.records()[0].id;
    const ok = await pdfGET(new Request(`http://localhost/api/library/pdf?id=${id}`, { headers: { host: 'localhost', range: 'bytes=0-4' } }));
    assert.equal(ok.status, 206);
    const malformed = await pdfGET(new Request(`http://localhost/api/library/pdf?id=${id}`, { headers: { host: 'localhost', range: 'bytes=abc-def' } }));
    assert.equal(malformed.status, 416);
    const outOfRange = await pdfGET(new Request(`http://localhost/api/library/pdf?id=${id}`, { headers: { host: 'localhost', range: 'bytes=999999-999999' } }));
    assert.equal(outOfRange.status, 416);
    assert.match(outOfRange.headers.get('content-range') ?? '', /^bytes \*\/\d+$/);
  } finally {
    store?.close();
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.SCIENTIFIC_LIBRARY_PATH; else process.env.SCIENTIFIC_LIBRARY_PATH = previousPath;
    await rm(temp, { recursive: true, force: true });
  }
});
