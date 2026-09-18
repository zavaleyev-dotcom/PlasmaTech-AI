import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { validateEmbeddingVector } from './vector';
import type { EmbeddingFingerprint, EmbeddingProgress, EmbeddingRecord } from './types';

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Decodes a stored vector BLOB, but only if it is genuinely well-formed for its OWN
 *  declared dimension: real binary data (not a string/number/anything else a corrupted or
 *  hand-crafted row could hold), and EXACTLY `expectedDimension * 4` bytes - one 32-bit
 *  float per dimension, no fewer (truncated) and no more (trailing garbage silently
 *  ignored). Anything else is corruption and is never partially decoded: this returns a
 *  deliberately empty vector, which validateEmbeddingVector's length check downstream is
 *  guaranteed to reject regardless of what the caller's OWN expected dimension is. */
function toFloat32Array(blob: unknown, expectedDimension: number): Float32Array {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== expectedDimension * 4) return new Float32Array(0);
  // Copy into a freshly-aligned buffer: a BLOB read back from node:sqlite is not guaranteed
  // to start at a 4-byte-aligned offset, which Float32Array's view constructor requires.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, expectedDimension);
}

/** A full stored row, vector included (already converted to a Float32Array, NOT yet
 *  validated - see vector.ts; a corrupted BLOB can still deserialize into a Float32Array
 *  full of garbage, which is exactly why every caller must run it through
 *  validateEmbeddingVector before trusting it). */
export interface EmbeddingRow {
  chunkId: string; documentId: string; contentHash: string;
  providerId: string; model: string; dimension: number; vector: Float32Array;
}

/** A store fully separate from the existing FTS5 text index (src/services/library-text) -
 *  its own SQLite file, its own schema, opened independently. Mirrors that store's
 *  claim()/progress() resumable-job pattern so CLI and any future UI trigger see one job,
 *  the same way library-text's TextStore already does. */
export class EmbeddingStore {
  readonly db: DatabaseSync;
  /** The library identity this store was opened for - also used as part of an in-memory
   *  vector cache's key (see embeddings/cache.ts) so a cache can never be reused across two
   *  different libraries even if they happened to share a provider/model/dimension. */
  readonly rootId: string;

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
    this.rootId = rootId;
  }

  /** A durable (persisted in the store's own `settings` table, not merely in-memory) counter
   *  bumped by every write (upsertBatch/remove). This is the ONLY thing an in-memory vector
   *  cache (embeddings/cache.ts) trusts to decide "is my loaded snapshot still current" -
   *  durable rather than per-instance in-memory because a fresh EmbeddingStore instance is
   *  opened per request (see rag/service.ts) while indexing itself typically runs as a
   *  separate process (scripts/index-embeddings.ts) - an in-memory-only counter would never
   *  observe writes made by that other process. Absent entirely (never written yet) reads
   *  as 0, so a brand-new store and a cache that has never loaded anything both start there. */
  dataVersion(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='dataVersion'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private bumpDataVersion() {
    this.db.prepare("INSERT INTO settings (key,value) VALUES ('dataVersion','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
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
   *  none. This alone is NOT sufficient to decide reuse - see recordFor(), which also
   *  returns the vector so its integrity can be validated (a stored row can have a
   *  perfectly matching fingerprint and still hold a corrupted vector). */
  fingerprint(chunkId: string): EmbeddingFingerprint | null {
    const row = this.db.prepare('SELECT contentHash, providerId, model, dimension FROM embeddings WHERE chunkId=?').get(chunkId) as EmbeddingFingerprint | undefined;
    return row ?? null;
  }

  /** The full stored row for one chunk, vector included - the caller (runEmbeddingIndex)
   *  validates the vector itself (validateEmbeddingVector) before ever treating it as
   *  reusable: a fingerprint match alone never implies a usable vector. */
  recordFor(chunkId: string): EmbeddingRow | null {
    const row = this.db.prepare('SELECT chunkId, documentId, contentHash, providerId, model, dimension, vector FROM embeddings WHERE chunkId=?').get(chunkId) as
      { chunkId: string; documentId: string; contentHash: string; providerId: string; model: string; dimension: number; vector: Uint8Array } | undefined;
    return row ? { ...row, vector: toFloat32Array(row.vector, row.dimension) } : null;
  }

  /** Writes every record in one atomic transaction: either all of them end up durably
   *  stored, or (on any single failure) none of them do - a partial, half-written batch
   *  never persists. Callers that need to know exactly what survived a failed write should
   *  re-check with fingerprint()/recordFor() rather than assume based on transaction
   *  semantics alone (see runEmbeddingIndex, index.ts, which does exactly that). */
  upsertBatch(records: readonly EmbeddingRecord[]) {
    if (!records.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.db.prepare(`INSERT INTO embeddings (chunkId,documentId,contentHash,providerId,model,dimension,vector,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chunkId) DO UPDATE SET documentId=excluded.documentId, contentHash=excluded.contentHash, providerId=excluded.providerId,
          model=excluded.model, dimension=excluded.dimension, vector=excluded.vector, updatedAt=excluded.updatedAt`);
      for (const record of records) {
        statement.run(record.chunkId, record.documentId, record.contentHash, record.providerId, record.model, record.dimension,
          toBuffer(record.vector), record.createdAt, record.updatedAt);
      }
      this.bumpDataVersion();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  upsert(record: EmbeddingRecord) { this.upsertBatch([record]); }

  remove(chunkId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM embeddings WHERE chunkId=?').run(chunkId);
      this.bumpDataVersion();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Every chunkId currently stored - used by the indexer to find orphans (embeddings for
   *  chunks that no longer exist in the text index) without loading any vectors. */
  chunkIds(): string[] {
    return (this.db.prepare('SELECT chunkId FROM embeddings').all() as { chunkId: string }[]).map(r => r.chunkId);
  }

  totalCount(): number {
    return Number(this.db.prepare('SELECT count(*) n FROM embeddings').get()!.n);
  }

  /** Naive row count matching provider/model/dimension - does NOT validate vector
   *  integrity or chunk/document/hash consistency (see validCount() for that). Kept for
   *  cheap, approximate diagnostics only. */
  currentCount(providerId: string, model: string, dimension: number): number {
    return Number(this.db.prepare('SELECT count(*) n FROM embeddings WHERE providerId=? AND model=? AND dimension=?').get(providerId, model, dimension)!.n);
  }

  /** All rows matching provider/model/dimension, vectors included but NOT yet validated -
   *  see search.ts and validCount(), which both run every row through
   *  validateEmbeddingVector (and, where available, a chunk/document/hash consistency
   *  check) before treating any of them as usable. */
  currentRows(providerId: string, model: string, dimension: number): EmbeddingRow[] {
    const rows = this.db.prepare('SELECT chunkId, documentId, contentHash, providerId, model, dimension, vector FROM embeddings WHERE providerId=? AND model=? AND dimension=?').all(providerId, model, dimension) as
      { chunkId: string; documentId: string; contentHash: string; providerId: string; model: string; dimension: number; vector: Uint8Array }[];
    return rows.map(r => ({ ...r, vector: toFloat32Array(r.vector, r.dimension) }));
  }

  /** The count that actually matters for coverage/status: rows matching provider/model/
   *  dimension whose vector passes validateEmbeddingVector AND (when `isConsistent` is
   *  given) whose chunk/document/contentHash relationship is still genuinely current. A
   *  row that fails either check is neither "valid" nor silently "current" - it is exactly
   *  as absent as if it were never written. */
  validCount(providerId: string, model: string, dimension: number, isConsistent?: (chunkId: string, documentId: string, contentHash: string) => boolean): { valid: number; total: number } {
    const rows = this.currentRows(providerId, model, dimension);
    let valid = 0;
    for (const row of rows) {
      if (!validateEmbeddingVector(row.vector, dimension).valid) continue;
      if (isConsistent && !isConsistent(row.chunkId, row.documentId, row.contentHash)) continue;
      valid++;
    }
    return { valid, total: rows.length };
  }
}
