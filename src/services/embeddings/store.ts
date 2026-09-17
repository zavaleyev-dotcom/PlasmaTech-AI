import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { EmbeddingFingerprint, EmbeddingProgress, EmbeddingRecord } from './types';

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function toFloat32Array(blob: Uint8Array): Float32Array {
  // Copy into a freshly-aligned buffer: a BLOB read back from node:sqlite is not guaranteed
  // to start at a 4-byte-aligned offset, which Float32Array's view constructor requires.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** A store fully separate from the existing FTS5 text index (src/services/library-text) -
 *  its own SQLite file, its own schema, opened independently. Mirrors that store's
 *  claim()/progress() resumable-job pattern so CLI and any future UI trigger see one job,
 *  the same way library-text's TextStore already does. */
export class EmbeddingStore {
  readonly db: DatabaseSync;

  constructor(file: string, rootId: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (
        chunkId TEXT PRIMARY KEY, documentId TEXT NOT NULL, contentHash TEXT NOT NULL,
        providerId TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL,
        vector BLOB NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS embeddings_document ON embeddings(documentId);`);
    const root = this.db.prepare('SELECT value FROM settings WHERE key=?').get('root');
    if (root && root.value !== rootId) { this.close(); throw new Error('Индекс эмбеддингов относится к другой библиотеке.'); }
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('root', rootId);
  }

  close() { this.db.close(); }

  progress(): EmbeddingProgress | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='progress'").get();
    return row ? JSON.parse(row.value as string) : null;
  }

  setProgress(progress: EmbeddingProgress) { this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('progress',?)").run(JSON.stringify(progress)); }

  claim(progress: EmbeddingProgress) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.progress();
      if (prior?.running) {
        let alive = false; try { process.kill(prior.pid, 0); alive = true; } catch { /* stale run can resume */ }
        if (alive) throw new Error('Индексирование эмбеддингов уже запущено.');
      }
      this.setProgress(progress); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  requestStop() { const p = this.progress(); if (p?.running) this.setProgress({ ...p, stopRequested: true }); }

  overviewProgress(): EmbeddingProgress | null {
    const progress = this.progress();
    if (progress?.running) { try { process.kill(progress.pid, 0); } catch { progress.running = false; progress.error = 'Предыдущий процесс остановлен. Запустите индексирование снова для продолжения.'; } }
    return progress;
  }

  /** The fingerprint of the currently stored embedding for one chunk, or null if there is
   *  none. Comparing this to the chunk's current {contentHash, providerId, model, dimension}
   *  is the entire reuse decision - see runEmbeddingIndex (index.ts). */
  fingerprint(chunkId: string): EmbeddingFingerprint | null {
    const row = this.db.prepare('SELECT contentHash, providerId, model, dimension FROM embeddings WHERE chunkId=?').get(chunkId) as EmbeddingFingerprint | undefined;
    return row ?? null;
  }

  upsert(record: EmbeddingRecord) {
    this.db.prepare(`INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chunkId) DO UPDATE SET documentId=excluded.documentId, contentHash=excluded.contentHash, providerId=excluded.providerId,
        model=excluded.model, dimension=excluded.dimension, vector=excluded.vector, updatedAt=excluded.updatedAt`)
      .run(record.chunkId, record.documentId, record.contentHash, record.providerId, record.model, record.dimension,
        toBuffer(record.vector), record.createdAt, record.updatedAt);
  }

  remove(chunkId: string) { this.db.prepare('DELETE FROM embeddings WHERE chunkId=?').run(chunkId); }

  /** Every chunkId currently stored - used by the indexer to find orphans (embeddings for
   *  chunks that no longer exist in the text index) without loading any vectors. */
  chunkIds(): string[] {
    return (this.db.prepare('SELECT chunkId FROM embeddings').all() as { chunkId: string }[]).map(r => r.chunkId);
  }

  totalCount(): number {
    return Number(this.db.prepare('SELECT count(*) n FROM embeddings').get()!.n);
  }

  /** Rows matching the given provider/model/dimension - the ones a semantic search or a
   *  coverage/staleness computation may actually use "as current". Anything else in the
   *  store is a stale leftover from a previous provider/model and is never silently treated
   *  as compatible. */
  currentCount(providerId: string, model: string, dimension: number): number {
    return Number(this.db.prepare('SELECT count(*) n FROM embeddings WHERE providerId=? AND model=? AND dimension=?').get(providerId, model, dimension)!.n);
  }

  /** All vectors matching the given provider/model/dimension, for brute-force semantic
   *  search (see search.ts). Loaded fully into memory - see docs/architecture.md and the
   *  benchmark for the measured cost of this at the tested sample size; this is a
   *  deliberate, documented simplification for this stage, not a hidden limitation. */
  currentVectors(providerId: string, model: string, dimension: number): { chunkId: string; documentId: string; vector: Float32Array }[] {
    const rows = this.db.prepare('SELECT chunkId, documentId, vector FROM embeddings WHERE providerId=? AND model=? AND dimension=?').all(providerId, model, dimension) as { chunkId: string; documentId: string; vector: Uint8Array }[];
    return rows.map(r => ({ chunkId: r.chunkId, documentId: r.documentId, vector: toFloat32Array(r.vector) }));
  }
}
