import 'server-only';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
export interface PdfMetadata { title: string | null; authors: string[]; year: number | null; doi: string | null }
/** One isolated parser per scan lane. A corrupt/slow PDF cannot block the scan. */
export class PdfReader {
  private child?: ChildProcess;
  async read(data: Buffer): Promise<PdfMetadata> {
    const child = this.child ??= spawn(process.execPath, ['--max-old-space-size=384', path.join(process.cwd(), 'scripts/library-pdf-worker.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    });
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('error', fail); child.removeListener('exit', exited); };
      const fail = () => { cleanup(); this.close(); reject(new Error('Ошибка процесса чтения PDF.')); };
      const exited = () => fail();
      const message = (result: PdfMetadata & { error?: string }) => {
        cleanup(); if (result.error) reject(new Error(result.error)); else resolve(result);
      };
      const timer = setTimeout(() => { cleanup(); this.close(); reject(new Error('Превышено время чтения PDF (20 секунд).')); }, 20_000);
      child.once('message', message); child.once('error', fail); child.once('exit', exited);
      child.send({ data }, error => { if (error) fail(); });
    });
  }
  close() { this.child?.kill(); this.child = undefined; }
}
