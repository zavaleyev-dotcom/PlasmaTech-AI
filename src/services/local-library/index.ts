import 'server-only';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { discoverPdfs, readLibraryPdf, safeLibraryFile } from './files';
import { inferDocumentType } from './filter';
import { PdfReader, type PdfMetadata } from './pdf';
import type { IndexProgress, LibraryIndex, LibraryRecord } from './types';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function libraryConfig() {
  if (!process.env.SCIENTIFIC_LIBRARY_PATH) throw new Error('Укажите SCIENTIFIC_LIBRARY_PATH в .env.local и перезапустите сервер.');
  const root = await realpath(process.env.SCIENTIFIC_LIBRARY_PATH);
  if (!(await stat(root)).isDirectory()) throw new Error('Корень библиотеки не является каталогом.');
  const indexDirectory = path.join(await realpath(process.cwd()), '.local-data', 'scientific-library');
  const relative = path.relative(root, indexDirectory);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Индекс должен находиться вне исходной библиотеки.');
  return { root, indexFile: path.join(indexDirectory, 'index.json') };
}
export async function loadIndex(root: string, indexFile: string): Promise<LibraryIndex> {
  try {
    const data: LibraryIndex = JSON.parse(await readFile(indexFile, 'utf8'));
    if (data.version === 1 && data.rootId === hash(root) && Array.isArray(data.records)) return data;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не удалось прочитать индекс. Исходные PDF не затронуты.'); }
  return { version: 1, rootId: hash(root), indexedAt: null, records: [], errors: [] };
}
export async function scanLibrary(root: string, previous: LibraryIndex, progress?: IndexProgress,
  extract?: (data: Buffer) => Promise<PdfMetadata>): Promise<LibraryIndex> {
  const discovery = await discoverPdfs(root);
  const indexedAt = new Date().toISOString();
  const old = new Map(previous.records.map(r => [r.relativePath, r]));
  const records: LibraryRecord[] = [];
  if (progress) { progress.discovered = discovery.files.length; progress.processed = 0; }
  let cursor = 0;
  async function lane() {
    const reader = new PdfReader();
    try {
      while (cursor < discovery.files.length) {
        const relativePath = discovery.files[cursor++];
        const prior = old.get(relativePath);
        let record: LibraryRecord = {
          id: hash(`${root}\0${relativePath}`), filename: path.basename(relativePath), title: path.basename(relativePath, path.extname(relativePath)),
          authors: [], year: null, doi: null, documentType: inferDocumentType(relativePath),
          sourceFolder: path.posix.dirname(relativePath), relativePath, absolutePath: path.join(root, relativePath),
          fileSize: 0, modifiedDate: '', indexedAt, metadataSource: 'filename', error: null,
        };
        try {
          const file = await safeLibraryFile(root, relativePath);
          const info = await stat(file);
          record.fileSize = info.size; record.modifiedDate = info.mtime.toISOString();
          if (prior && !prior.error && prior.fileSize === info.size && prior.modifiedDate === record.modifiedDate) record = { ...prior, documentType: record.documentType };
          else {
            const data = await readLibraryPdf(root, relativePath);
            const metadata = await (extract ? extract(data) : reader.read(data));
            const after = await stat(await safeLibraryFile(root, relativePath));
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Файл изменился во время чтения; повторите индексирование.');
            record = { ...record, ...metadata, title: metadata.title || record.title, metadataSource: metadata.title ? 'pdf' : 'filename' };
          }
        } catch (e) {
          // Keep a filename-only record, never invent bibliographic metadata.
          const message = e instanceof Error ? e.message : '';
          record.error = /^(Не удалось прочитать PDF|Превышено время|Ошибка процесса|PDF больше|Файл изменился)/.test(message) ? message : 'Файл недоступен для безопасного чтения.';
        }
        records.push(record); if (progress) progress.processed++;
      }
    } finally { reader.close(); }
  }
  await Promise.all([lane(), lane()]);
  // An unreadable directory is not evidence that its files were deleted.
  for (const prior of previous.records) if (!records.some(r => r.relativePath === prior.relativePath) && discovery.errors.some(e => e.relativePath === '.' || prior.relativePath.startsWith(`${e.relativePath}/`))) records.push(prior);
  records.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { version: 1, rootId: hash(root), indexedAt, records, errors: [...discovery.errors, ...records.filter(r => r.error).map(r => ({ relativePath: r.relativePath, message: r.error! }))] };
}
export async function saveIndex(indexFile: string, index: LibraryIndex) {
  await mkdir(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  const temp = `${indexFile}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(index), { mode: 0o600 });
  await rename(temp, indexFile);
}
const state = globalThis as typeof globalThis & { libraryProgress?: IndexProgress };
export function getProgress(): IndexProgress { return state.libraryProgress ??= { running: false, processed: 0, discovered: 0, error: null }; }
export async function startIndexing() {
  const progress = getProgress();
  if (progress.running) return;
  const { root, indexFile } = await libraryConfig();
  // Re-check after awaiting config so simultaneous requests cannot start two scans.
  if (progress.running) return;
  Object.assign(progress, { running: true, processed: 0, discovered: 0, error: null });
  void (async () => {
    try { await saveIndex(indexFile, await scanLibrary(root, await loadIndex(root, indexFile), progress)); }
    catch { progress.error = 'Индексирование не завершено. Проверьте доступность библиотеки и каталога индекса; предыдущий индекс сохранён.'; }
    finally { progress.running = false; }
  })();
}
