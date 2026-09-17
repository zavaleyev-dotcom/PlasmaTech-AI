import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { TextPage } from './types';
export class ExtractionError extends Error { constructor(message: string, public limited = false) { super(message); } }
export class TextReader {
  private child?: ChildProcess;
  private count = 0;
  async read(data: Buffer, signal?: AbortSignal): Promise<{ pages: TextPage[]; pageCount: number }> {
    signal?.throwIfAborted();
    if (++this.count % 20 === 0) this.close();
    const child = this.child ??= spawn(process.execPath, ['--max-old-space-size=512', path.join(process.cwd(), 'scripts/library-text-worker.mjs')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); child.removeAllListeners('error'); signal?.removeEventListener('abort', abort); };
      const failure = (error: Error) => { cleanup(); this.close(); reject(error); };
      const abort = () => failure(new DOMException('Остановлено пользователем', 'AbortError'));
      const timer = setTimeout(() => failure(new ExtractionError('Превышено время извлечения текста (90 секунд).', true)), 90_000);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('exit', () => failure(new ExtractionError('Процесс извлечения завершился: возможно превышение памяти.')));
      child.once('error', () => failure(new ExtractionError('Не удалось запустить локальный PDF-процесс.')));
      child.once('message', (result: { pages: TextPage[]; pageCount: number; error?: string; limited?: boolean }) => {
        cleanup(); if (result.error) reject(new ExtractionError(result.error, result.limited)); else resolve(result);
      });
      child.send({ data }, error => { if (error) failure(new ExtractionError('Ошибка передачи PDF локальному процессу.')); });
    });
  }
  close() { this.child?.kill(); this.child = undefined; }
}
