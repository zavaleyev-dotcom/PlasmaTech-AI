import 'server-only';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { ContentHit, TextChunk, TextDocument, TextOverview, TextProgress, TextStats } from './types';

/** Above this SUM of individual per-term corpus-wide match counts, search() ranks by natural
 *  rowid order instead of bm25() (see search() below for the measured reasoning). Chosen from
 *  real-corpus measurement (docs/architecture.md): a single term with ~23-25k matches (out of
 *  ~55k total chunks) still ranks in well under 150ms, while combinations summing to ~40k+
 *  measured in the 300ms+ range - this sits safely below that. */
const RANK_CANDIDATE_BUDGET = 25_000;

/** Hard ceiling on how deep search() will ever attempt bm25-ranked pagination - beyond this,
 *  ranking degrades to rowid order the same way an overly broad query does (see
 *  `rankingDegraded` above). Reaching row `offset+20` in bm25 order costs roughly
 *  proportional to `offset` regardless of query selectivity (bm25 order is not index-backed),
 *  measured in the multiple-second range at offset=10000 on this corpus; RAG retrieval
 *  (rag/retrieve.ts) never requests anything beyond offset=0, so this only ever bounds the
 *  standalone lexical-search API/UI's own pagination depth. */
const MAX_SEARCH_OFFSET = 500;

export class TextStore {
  readonly db: DatabaseSync;
  /** The library identity this store was opened for - also used as part of a process-local
   *  consistency cache's key (see rag/consistency-cache.ts) so a cache can never be reused
   *  across two different libraries. */
  readonly rootId: string;
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
    this.rootId = rootId;
  }
  close() { this.db.close(); }

  /** Durable (persisted in `settings`, not merely in-memory) counter bumped by every write
   *  to the `chunks` table (replace()/remove()) - the ONLY thing a process-local consistency
   *  cache (rag/consistency-cache.ts) trusts to decide "is my snapshot of chunk text still
   *  current". Durable rather than in-memory because indexing typically runs as a separate
   *  process (scripts/index-library-text.ts) from whatever serves API requests. Reads as 0
   *  if never written (a brand-new store and a cache that never loaded both start there). */
  dataVersion(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='dataVersion'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private bumpDataVersion() {
    this.db.prepare("INSERT INTO settings (key,value) VALUES ('dataVersion','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();
  }
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
      this.bumpDataVersion();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  remove(id: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM documents WHERE id=?').run(id); // cascades to chunks
      this.bumpDataVersion();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
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
  search(query: string, offset = 0): { total: number; hits: ContentHit[]; rankingDegraded: boolean } {
    if (query.length > 500) throw new Error('Запрос длиннее 500 символов.');
    // Quotes express phrases; all other input is literal Unicode words, never FTS syntax.
    const rawTerms = [...query.matchAll(/"([^"]+)"|([\p{L}\p{N}_-]+)/gu)].map(m => m[1] ?? m[2]).filter(t => /[\p{L}\p{N}]/u.test(t));
    // A repeated token (accidental or pasted noise) adds nothing to selectivity but doubles
    // the work of finding/scoring it - drop duplicates before building the query at all.
    const terms = [...new Set(rawTerms)];
    if (!terms.length || terms.length > 30) return { hits: [], total: 0, rankingDegraded: false };
    const match = terms.map(t => `"${t.replaceAll('"', '""')}"`).join(' AND ');
    const total = Number(this.db.prepare('SELECT count(*) n FROM content_search WHERE content_search MATCH ?').get(match)!.n);

    // Safe candidate budget: measured against the real corpus, bm25()/snippet() ranking cost
    // is proportional to the SUM of every individual term's OWN corpus-wide match count, not
    // to the final AND-intersection size ("total" above) - a query ANDing several
    // individually common terms can cost 10x+ more to RANK than its actual (possibly tiny)
    // result set would suggest, because SQLite FTS5 has no efficient top-k-by-bm25
    // short-circuit: it must score every row any involved term matches before it can sort.
    // Each term's own frequency is itself cheap to check (a plain count(*) MATCH, a few ms
    // even for the single most frequent term in the whole corpus) - reusing `total` when
    // there is only one term avoids a redundant second query for the overwhelmingly common
    // single-keyword case.
    let candidateBudget = terms.length === 1 ? total : 0;
    if (terms.length > 1) {
      for (const term of terms) {
        const single = `"${term.replaceAll('"', '""')}"`;
        candidateBudget += Number(this.db.prepare('SELECT count(*) n FROM content_search WHERE content_search MATCH ?').get(single)!.n);
        if (candidateBudget > RANK_CANDIDATE_BUDGET) break;
      }
    }
    const cappedOffset = Math.max(0, Math.min(MAX_SEARCH_OFFSET, offset));
    // Deep pagination has the SAME root cause even for an otherwise cheap term: bm25 order is
    // not index-backed, so reaching row `offset+20` in ranked order still costs roughly
    // proportional to `offset` regardless of how selective the query itself is (measured:
    // the same single moderately-common term went from ~100ms at offset=0 to multiple
    // seconds at offset=10000). A shallower cap (below) already bounds the worst case; this
    // flag additionally prefers the fast fallback once still-deep pagination meets a
    // non-trivial candidate set, rather than assuming a small `total` always stays cheap.
    const deepOffset = cappedOffset > 0 && total > 1000;
    const rankingDegraded = candidateBudget > RANK_CANDIDATE_BUDGET || deepOffset;

    // Degraded path: natural rowid order instead of bm25 - proven, by measurement, to stay in
    // the low single-digit milliseconds regardless of how many rows match (no bm25/snippet
    // ranking cost scales with candidate count in this ordering), at the cost of NOT
    // returning true relevance-ranked results. Never hidden: callers get `rankingDegraded`
    // explicit in the result rather than a silently-reordered "top" result.
    const orderBy = rankingDegraded ? 'content_search.rowid' : 'bm25(content_search), c.id';
    const rows = this.db.prepare(`SELECT d.metadata, c.id chunkId,c.pageStart,c.pageEnd,snippet(content_search,0,'','',' … ',48) snippet FROM content_search JOIN chunks c ON c.rowid=content_search.rowid JOIN documents d ON d.id=c.documentId WHERE content_search MATCH ? ORDER BY ${orderBy} LIMIT 20 OFFSET ?`).all(match, cappedOffset);
    const hits = rows.map(({ metadata, ...row }) => ({ ...JSON.parse(metadata as string), ...row })) as ContentHit[];
    return { total, hits, rankingDegraded };
  }
}
