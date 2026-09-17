import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { libraryConfig, loadIndex } from '../local-library';
import { discoverPdfs, readLibraryPdf, safeLibraryFile } from '../local-library/files';
import { chunkPages, wordCount } from './chunk';
import { ExtractionError, TextReader } from './extract';
import { TextStore } from './store';
import type { TextDocument, TextMetadata, TextPage, TextProgress } from './types';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const extractionVersion = 1;
export async function textConfig() {
  const config = await libraryConfig();
  return { ...config, databaseFile: path.join(path.dirname(config.indexFile), 'text', 'index.sqlite'), rootId: hash(config.root) };
}
export async function openTextStore() { const c = await textConfig(); return new TextStore(c.databaseFile, c.rootId); }
export async function runTextIndex(options: {
  root: string; indexFile: string; store: TextStore; sample?: number;
  extract?: (data: Buffer, signal: AbortSignal) => Promise<{ pages: TextPage[]; pageCount: number }>;
}) {
  const { root, indexFile, store } = options;
  const progress: TextProgress = { running: true, cancelled: false, stopRequested: false, pid: process.pid, total: 0, processed: 0, reused: 0, extracted: 0, errors: 0, skipped: 0, chunks: store.stats().chunks, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  store.claim(progress);
  const aborter = new AbortController();
  const timer = setInterval(() => { if (store.progress()?.stopRequested) { progress.stopRequested = true; aborter.abort(); } }, 300);
  const persist = () => { progress.stopRequested ||= store.progress()?.stopRequested ?? false; store.setProgress(progress); };
  try {
    const discovery = await discoverPdfs(root);
    const library = await loadIndex(root, indexFile);
    const metadata = new Map(library.records.map(r => [r.relativePath, r]));
    const files = options.sample ? discovery.files.slice(0, options.sample) : discovery.files;
    progress.total = files.length; persist();
    let cursor = 0;
    async function lane() {
      const reader = new TextReader();
      try {
        while (cursor < files.length && !aborter.signal.aborted && !progress.stopRequested) {
          const relativePath = files[cursor++]; const known = metadata.get(relativePath);
          const id = hash(`${root}\0${relativePath}`);
          const meta: TextMetadata = { id, relativePath, filename: path.basename(relativePath), title: known?.title ?? path.basename(relativePath, path.extname(relativePath)), doi: known?.doi ?? null, authors: known?.authors ?? [], year: known?.year ?? null, sourceFolder: path.posix.dirname(relativePath) };
          let doc: TextDocument = { ...meta, text: '', pageCount: null, characterCount: 0, wordCount: 0, status: 'error', error: null, extractedAt: new Date().toISOString(), modifiedDate: '', fileSize: 0, hash: null, version: extractionVersion };
          let pages: TextPage[] = [];
          try {
            const file = await safeLibraryFile(root, relativePath); const before = await stat(file);
            doc.modifiedDate = before.mtime.toISOString(); doc.fileSize = before.size;
            const prior = store.prior(relativePath);
            if (prior && prior.modifiedDate === doc.modifiedDate && prior.fileSize === doc.fileSize && prior.version === extractionVersion && prior.status !== 'error') {
              store.updateMetadata(id, meta); progress.reused++; progress.processed++; persist(); continue;
            }
            if (before.size > 128 * 1024 * 1024) throw new ExtractionError('PDF больше 128 МБ; безопасное извлечение отложено.', true);
            const bytes = await readLibraryPdf(root, relativePath); doc.hash = hash(bytes);
            const result = await (options.extract ? options.extract(bytes, aborter.signal) : reader.read(bytes, aborter.signal));
            aborter.signal.throwIfAborted();
            const after = await stat(await safeLibraryFile(root, relativePath));
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ExtractionError('PDF изменился во время извлечения; повторите обновление.');
            pages = result.pages; const text = pages.map(p => p.text).join('\n\n');
            doc = { ...doc, text, pageCount: result.pageCount, characterCount: text.length, wordCount: wordCount(text), status: /[\p{L}\p{N}]/u.test(text) ? 'success' : 'no_text', error: /[\p{L}\p{N}]/u.test(text) ? null : 'Нет текстового слоя; для этого PDF потребуется OCR на отдельном этапе.' };
          } catch (e) {
            if (aborter.signal.aborted) break;
            doc.status = e instanceof ExtractionError && e.limited ? 'skipped' : 'error';
            doc.error = e instanceof ExtractionError ? e.message : 'Не удалось безопасно прочитать PDF внутри библиотеки.';
          }
          // Storage failure must stop the run, not be mistaken for a broken source PDF.
          const chunks = doc.status === 'success' ? chunkPages(id, pages) : [];
          store.replace(doc, chunks);
          progress.processed++;
          if (doc.status === 'success') progress.extracted++;
          else if (doc.status === 'error') progress.errors++;
          else progress.skipped++;
          progress.chunks = store.chunkCount(); persist();
        }
      } finally { reader.close(); }
    }
    // Only two PDF buffers/parsers at a time; full library text never loaded into memory.
    const lanes = await Promise.allSettled([lane(), lane()].map(p => p.catch(error => { aborter.abort(); throw error; })));
    const failed = lanes.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    progress.cancelled = aborter.signal.aborted || progress.stopRequested;
    if (!progress.cancelled && !options.sample) {
      const found = new Set(discovery.files);
      for (const prior of store.records()) if (!found.has(prior.relativePath) && !discovery.errors.some(e => e.relativePath === '.' || prior.relativePath.startsWith(`${e.relativePath}/`))) store.remove(prior.id);
    }
    if (discovery.errors.length) progress.error = `Недоступных каталогов: ${discovery.errors.length}. Их прежние записи сохранены.`;
  } catch { progress.error = 'Текстовое индексирование прервано. Уже сохранённые документы доступны; проверьте доступ к библиотеке и свободное место.'; }
  finally { clearInterval(timer); progress.running = false; progress.finishedAt = new Date().toISOString(); progress.chunks = store.chunkCount(); persist(); }
  return store.overview();
}
export async function startTextIndex() {
  const config = await textConfig(); const store = new TextStore(config.databaseFile, config.rootId);
  const current = store.overview().progress;
  if (current?.running) { store.close(); return; }
  // claim() executes before the first await in runTextIndex.
  void runTextIndex({ ...config, store }).catch(() => {}).finally(() => store.close());
}
