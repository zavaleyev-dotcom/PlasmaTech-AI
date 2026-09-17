import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { ContentHit, TextChunk, TextDocument, TextOverview, TextProgress, TextStats } from './types';
export class TextStore {
  readonly db: DatabaseSync;
  constructor(file: string, rootId: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, relativePath TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, text TEXT NOT NULL, pageCount INTEGER, characterCount INTEGER NOT NULL, wordCount INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, extractedAt TEXT NOT NULL, modifiedDate TEXT NOT NULL, fileSize INTEGER NOT NULL, hash TEXT, version INTEGER NOT NULL, textBytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, pageStart INTEGER NOT NULL, pageEnd INTEGER NOT NULL, text TEXT NOT NULL, wordCount INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chunk_document ON chunks(documentId);
      CREATE VIRTUAL TABLE IF NOT EXISTS content_search USING fts5(text, content='chunks', content_rowid='rowid', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS chunk_insert AFTER INSERT ON chunks BEGIN INSERT INTO content_search(rowid,text) VALUES(new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunk_delete AFTER DELETE ON chunks BEGIN INSERT INTO content_search(content_search,rowid,text) VALUES('delete',old.rowid,old.text); END;`);
    const root = this.db.prepare('SELECT value FROM settings WHERE key=?').get('root');
    if (root && root.value !== rootId) { this.close(); throw new Error('Текстовый индекс относится к другой библиотеке.'); }
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('root', rootId);
  }
  close() { this.db.close(); }
  progress(): TextProgress | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='progress'").get();
    return row ? JSON.parse(row.value as string) : null;
  }
  setProgress(progress: TextProgress) { this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('progress',?)").run(JSON.stringify(progress)); }
  claim(progress: TextProgress) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.progress();
      if (prior?.running) {
        let alive = false; try { process.kill(prior.pid, 0); alive = true; } catch { /* stale run can resume */ }
        if (alive) throw new Error('Индексирование уже запущено.');
      }
      this.setProgress(progress); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  requestStop() { const p = this.progress(); if (p?.running) this.setProgress({ ...p, stopRequested: true }); }
  prior(relativePath: string) {
    return this.db.prepare('SELECT id,modifiedDate,fileSize,status,version FROM documents WHERE relativePath=?').get(relativePath);
  }
  records() { return this.db.prepare('SELECT id,relativePath FROM documents').all() as { id: string; relativePath: string }[]; }
  metadata(id: string) { const row = this.db.prepare('SELECT metadata FROM documents WHERE id=?').get(id); return row ? JSON.parse(row.metadata as string) as ContentHit : null; }
  updateMetadata(id: string, metadata: unknown) { this.db.prepare('UPDATE documents SET metadata=? WHERE id=?').run(JSON.stringify(metadata), id); }
  replace(doc: TextDocument, chunks: TextChunk[]) {
    const { text, pageCount, characterCount, wordCount, status, error, extractedAt, modifiedDate, fileSize, hash, version, ...metadata } = doc;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM documents WHERE id=?').run(doc.id);
      this.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(doc.id, doc.relativePath, JSON.stringify(metadata), text, pageCount, characterCount, wordCount, status, error, extractedAt, modifiedDate, fileSize, hash, version, Buffer.byteLength(text));
      const statement = this.db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?)');
      for (const chunk of chunks) statement.run(chunk.id, chunk.documentId, chunk.ordinal, chunk.pageStart, chunk.pageEnd, chunk.text, chunk.wordCount);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  remove(id: string) { this.db.prepare('DELETE FROM documents WHERE id=?').run(id); }
  chunkCount() { return Number(this.db.prepare('SELECT count(*) n FROM chunks').get()!.n); }
  stats(): TextStats {
    const row = this.db.prepare("SELECT count(*) documents, coalesce(sum(status='success'),0) successful, coalesce(sum(status='error'),0) errors, coalesce(sum(status IN ('skipped','no_text')),0) skipped, coalesce(sum(characterCount),0) characters, coalesce(sum(wordCount),0) words, coalesce(sum(textBytes),0) textBytes FROM documents").get()!;
    return { ...row, chunks: this.db.prepare('SELECT count(*) n FROM chunks').get()!.n } as unknown as TextStats;
  }
  overview(): TextOverview {
    const progress = this.progress();
    if (progress?.running) { try { process.kill(progress.pid, 0); } catch { progress.running = false; progress.error = 'Предыдущий процесс остановлен. Запустите обновление для продолжения.'; } }
    return { progress, stats: this.stats(), errors: this.db.prepare("SELECT relativePath,json_extract(metadata,'$.filename') filename,status,error FROM documents WHERE status!='success' ORDER BY relativePath").all() as unknown as TextOverview['errors'] };
  }
  search(query: string, offset = 0) {
    if (query.length > 500) throw new Error('Запрос длиннее 500 символов.');
    // Quotes express phrases; all other input is literal Unicode words, never FTS syntax.
    const terms = [...query.matchAll(/"([^"]+)"|([\p{L}\p{N}_-]+)/gu)].map(m => m[1] ?? m[2]).filter(t => /[\p{L}\p{N}]/u.test(t));
    if (!terms.length || terms.length > 30) return { hits: [] as ContentHit[], total: 0 };
    const match = terms.map(t => `"${t.replaceAll('"', '""')}"`).join(' AND ');
    const total = Number(this.db.prepare('SELECT count(*) n FROM content_search WHERE content_search MATCH ?').get(match)!.n);
    const rows = this.db.prepare("SELECT d.metadata, c.id chunkId,c.pageStart,c.pageEnd,snippet(content_search,0,'','',' … ',48) snippet FROM content_search JOIN chunks c ON c.rowid=content_search.rowid JOIN documents d ON d.id=c.documentId WHERE content_search MATCH ? ORDER BY bm25(content_search),c.id LIMIT 20 OFFSET ?").all(match, Math.max(0, Math.min(10000, offset)));
    const hits = rows.map(({ metadata, ...row }) => ({ ...JSON.parse(metadata as string), ...row })) as ContentHit[];
    return { total, hits };
  }
}
