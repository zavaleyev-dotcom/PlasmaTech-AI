import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes, realpath, truncate } from 'node:fs/promises';
import { discoverPdfs, libraryRelativePath, readLibraryPdf, safeLibraryFile } from '../src/services/local-library/files';
import { libraryConfig, loadIndex, saveIndex, scanLibrary } from '../src/services/local-library';
import { filterLibrary, inferDocumentType } from '../src/services/local-library/filter';
import { PdfReader } from '../src/services/local-library/pdf';
import { GET, POST } from '../src/app/api/library/route';
async function fixture(run: (root: string, indexFile: string) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'library-test-'));
  const folder = path.join(temp, 'papers'); await mkdir(folder); const root = await realpath(folder);
  try { await run(root, path.join(temp, 'index', 'index.json')); } finally { await rm(temp, { recursive: true, force: true }); }
}
const metadata = { title: 'Coating research', authors: ['Ada Lovelace'], year: 2020, doi: '10.1234/test' };
// Minimal, local-only PDF fixture with a correct xref table; no user PDFs modified.
function pdfFixture() {
  const text = 'BT /F1 12 Tf 50 700 Td (doi: 10.1234/TEST.2024) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Title (Coating experiment) /Author (Ada Lovelace) /CreationDate (D:20240101) >>'];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}
test('recursive PDF discovery, relative paths and folder types', () => fixture(async root => {
  await mkdir(path.join(root, 'Articles', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'Articles/nested/paper.PDF'), 'fixture');
  await writeFile(path.join(root, 'ignored.txt'), 'fixture');
  const result = await discoverPdfs(root);
  assert.deepEqual(result.files, ['Articles/nested/paper.PDF']);
  assert.equal(libraryRelativePath(root, path.join(root, result.files[0])), result.files[0]);
  assert.equal(inferDocumentType(result.files[0]), 'Articles');
  assert.equal(inferDocumentType('Articles/Books/title.pdf'), 'Book');
  assert.equal(inferDocumentType('My patents/title.pdf'), 'Patent');
  assert.equal(inferDocumentType('misc/title.pdf'), 'Other');
}));
test('reject traversal, absolute paths, sibling-prefix paths and symlinks', () => fixture(async root => {
  await assert.rejects(safeLibraryFile(root, '../secret.pdf'));
  await assert.rejects(safeLibraryFile(root, '/etc/passwd'));
  await assert.rejects(safeLibraryFile(root, '..\\secret.pdf'));
  assert.throws(() => libraryRelativePath(root, `${root}-other/file.pdf`));
  await symlink(os.tmpdir(), path.join(root, 'escape'));
  await symlink('/etc/passwd', path.join(root, 'linked.pdf'));
  await assert.rejects(readLibraryPdf(root, 'linked.pdf'));
  await assert.rejects(safeLibraryFile(root, 'escape/anything.pdf'));
  assert.deepEqual((await discoverPdfs(root)).files, []);
}));
test('real PDF metadata parser extracts title, author, DOI without guessing publication year', async () => {
  const reader = new PdfReader();
  try {
    const actual = await reader.read(pdfFixture());
    assert.equal(actual.title, 'Coating experiment');
    assert.deepEqual(actual.authors, ['Ada Lovelace']);
    assert.equal(actual.doi, '10.1234/test.2024');
    assert.equal(actual.year, null);
  } finally { reader.close(); }
});
test('damaged PDF does not abort scan; filename fallback and per-file errors retained', () => fixture(async (root, indexFile) => {
  await writeFile(path.join(root, 'broken.pdf'), 'not a PDF');
  await writeFile(path.join(root, 'good.pdf'), pdfFixture());
  const result = await scanLibrary(root, await loadIndex(root, indexFile));
  assert.equal(result.records.length, 2);
  assert.equal(result.errors.length, 1);
  const broken = result.records.find(r => r.filename === 'broken.pdf')!;
  assert.ok(broken.error); assert.equal(broken.title, 'broken'); assert.equal(broken.doi, null);
  assert.equal(result.records.find(r => r.filename === 'good.pdf')!.title, 'Coating experiment');
}));
test('incremental refresh adds, updates, retains unchanged and removes missing index entries', () => fixture(async (root, indexFile) => {
  let calls = 0;
  const extract = async () => { calls++; return metadata; };
  await writeFile(path.join(root, 'one.pdf'), 'original');
  let index = await scanLibrary(root, await loadIndex(root, indexFile), undefined, extract);
  const id = index.records[0].id;
  await saveIndex(indexFile, index); index = await loadIndex(root, indexFile);
  index = await scanLibrary(root, index, undefined, extract); assert.equal(calls, 1);
  await writeFile(path.join(root, 'two.pdf'), 'new');
  await writeFile(path.join(root, 'one.pdf'), 'modified larger');
  await utimes(path.join(root, 'one.pdf'), new Date(), new Date(Date.now() + 2000));
  index = await scanLibrary(root, index, undefined, extract); assert.equal(calls, 3);
  assert.equal(index.records.find(r => r.filename === 'one.pdf')!.id, id);
  await rm(path.join(root, 'one.pdf'));
  index = await scanLibrary(root, index, undefined, extract);
  assert.deepEqual(index.records.map(r => r.filename), ['two.pdf']);
}));
test('unreadable PDF error is isolated and retried on next refresh', () => fixture(async (root, indexFile) => {
  await writeFile(path.join(root, 'test.pdf'), 'fixture');
  const failed = await scanLibrary(root, await loadIndex(root, indexFile), undefined, async () => { throw new Error('EACCES'); });
  assert.equal(failed.errors.length, 1);
  const recovered = await scanLibrary(root, failed, undefined, async () => metadata);
  assert.equal(recovered.errors.length, 0);
}));
test('library search across title, author, DOI, filename; filters and sorting', () => fixture(async (root, indexFile) => {
  await mkdir(path.join(root, 'Books')); await writeFile(path.join(root, 'Books/example.pdf'), 'fixture');
  const { records } = await scanLibrary(root, await loadIndex(root, indexFile), undefined, async () => metadata);
  for (const search of ['coating', 'LOVELACE', '10.1234/TEST', 'example.pdf']) assert.equal(filterLibrary(records, { search }).length, 1);
  assert.equal(filterLibrary(records, { documentType: 'Book', sourceFolder: 'Books', year: '2020' }).length, 1);
  assert.equal(filterLibrary(records, { year: '2021' }).length, 0);
  assert.equal(filterLibrary(records, { sourceFolder: 'Articles' }).length, 0);
  const sample = [records[0], { ...records[0], id: 'second', title: 'A', year: null, modifiedDate: '2100-01-01' }];
  assert.equal(filterLibrary(sample, { sort: 'title' })[0].id, 'second');
  assert.equal(filterLibrary(sample, { sort: 'modified' })[0].id, 'second');
  assert.equal(filterLibrary(sample, { sort: 'year' })[0].year, 2020);
}));
test('library API rejects remote hosts and cross-origin refreshes', async () => {
  assert.equal((await GET(new Request('http://evil.example/api/library', { headers: { host: 'evil.example' } }))).status, 403);
  assert.equal((await POST(new Request('http://localhost:3000/api/library', { method: 'POST', headers: { host: 'localhost:3000', origin: 'https://evil.example', 'content-type': 'application/json' } }))).status, 403);
});
test('PDF larger than 128 MB is not read but stays in the index with an error', () => fixture(async (root, indexFile) => {
  const big = path.join(root, 'huge.pdf');
  await writeFile(big, ''); await truncate(big, 128 * 1024 * 1024 + 1);
  const result = await scanLibrary(root, await loadIndex(root, indexFile));
  assert.equal(result.records.length, 1);
  assert.match(result.records[0].error ?? '', /128 МБ/);
  assert.equal(result.records[0].title, 'huge');
}));
test('libraryConfig rejects a missing path, a non-directory path, and an index directory nested inside the library root', async () => {
  const previous = process.env.SCIENTIFIC_LIBRARY_PATH;
  try {
    delete process.env.SCIENTIFIC_LIBRARY_PATH;
    await assert.rejects(libraryConfig(), /SCIENTIFIC_LIBRARY_PATH/);
    const temp = await mkdtemp(path.join(os.tmpdir(), 'library-config-test-'));
    try {
      const file = path.join(temp, 'not-a-directory');
      await writeFile(file, 'x');
      process.env.SCIENTIFIC_LIBRARY_PATH = file;
      await assert.rejects(libraryConfig(), /каталогом/);
    } finally { await rm(temp, { recursive: true, force: true }); }
    // The index directory lives under process.cwd(); pointing the library root at cwd
    // itself nests the index inside the library it would scan.
    process.env.SCIENTIFIC_LIBRARY_PATH = await realpath(process.cwd());
    await assert.rejects(libraryConfig(), /вне исходной библиотеки/);
  } finally {
    if (previous === undefined) delete process.env.SCIENTIFIC_LIBRARY_PATH; else process.env.SCIENTIFIC_LIBRARY_PATH = previous;
  }
});
