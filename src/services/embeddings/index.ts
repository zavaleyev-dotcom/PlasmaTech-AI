import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { libraryConfig } from '@/services/local-library';
import type { TextStore } from '@/services/library-text/store';
import { EmbeddingStore } from './store';
import { validateEmbeddingVector } from './vector';
import { DEFAULT_EMBEDDING_BATCH_SIZE } from './types';
import type { EmbeddingOverview, EmbeddingProgress, EmbeddingProvider, EmbeddingRecord } from './types';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function embeddingsConfig() {
  const config = await libraryConfig();
  return { ...config, databaseFile: path.join(path.dirname(config.indexFile), 'embeddings', 'index.sqlite'), rootId: sha256(config.root) };
}

export async function openEmbeddingStore() {
  const c = await embeddingsConfig();
  return new EmbeddingStore(c.databaseFile, c.rootId);
}

export interface RunEmbeddingIndexOptions {
  /** Read-only: only ever SELECTs from the `chunks` table - never writes to the text index. */
  textStore: TextStore;
  embeddingStore: EmbeddingStore;
  provider: EmbeddingProvider;
  /** Caps the TOTAL number of chunks processed in this run. Intentionally required to be
   *  passed explicitly by the one caller that runs without it in this codebase (there is
   *  none yet - see scripts/index-embeddings.ts, which only ever passes a bounded sample). */
  sample?: number;
  batchSize?: number;
}

interface ChunkRow { rowid: number; id: string; documentId: string; text: string }

/** After a storage-layer exception, never assume nothing (or everything) was written -
 *  ask the store what is actually there for each attempted record, so `embedded`/`failed`
 *  reflect reality regardless of whether the failure happened before, during, or after some
 *  of the batch was durably persisted (upsertBatch is one transaction and should make this
 *  all-or-nothing, but this check does not rely on that assumption holding).
 *
 *  A fingerprint match alone is NOT proof of a successful (repair) write: if the write
 *  actually rolled back, what `recordFor` returns is whatever was there BEFORE the attempt -
 *  which, for a repair of a previously-corrupted record, is that same corrupted record. Its
 *  contentHash/providerId/model/dimension can still match `record` by pure coincidence (nothing
 *  about a rollback changes those columns), so this only ever counts a chunk as genuinely
 *  stored after confirming ALL of: the fingerprint, that the stored vector itself is valid
 *  (validateEmbeddingVector - catches a leftover corrupted vector immediately), that the
 *  chunk it claims to belong to still exists, that the chunk's current real documentId
 *  matches, and that the chunk's current real text still hashes to the stored contentHash. */
function countActuallyStored(embeddingStore: EmbeddingStore, textStore: TextStore, records: readonly EmbeddingRecord[]): number {
  let stored = 0;
  for (const record of records) {
    const existing = embeddingStore.recordFor(record.chunkId);
    if (!existing) continue;
    if (existing.contentHash !== record.contentHash || existing.providerId !== record.providerId
      || existing.model !== record.model || existing.dimension !== record.dimension) continue;
    if (!validateEmbeddingVector(existing.vector, record.dimension).valid) continue; // rollback left a corrupted/partial vector in place
    const chunkRow = textStore.db.prepare('SELECT documentId, text FROM chunks WHERE id=?').get(record.chunkId) as { documentId: string; text: string } | undefined;
    if (!chunkRow) continue; // the chunk it claims to belong to no longer exists
    if (chunkRow.documentId !== existing.documentId) continue; // document relation broken
    if (sha256(chunkRow.text) !== existing.contentHash) continue; // stale relative to the chunk's real current content
    stored++;
  }
  return stored;
}

/** Incremental, resumable embedding indexer over the text index's `chunks` table.
 *
 * - Reads chunks in small batches via a rowid cursor (`WHERE rowid > ? ORDER BY rowid LIMIT
 *   ?`), never loading the whole library into memory at once.
 * - Reuses a chunk's existing embedding only when its content hash, document id, provider
 *   id, model and dimension all still match AND the stored vector itself still passes
 *   validateEmbeddingVector - a fingerprint match alone is not enough; a corrupted stored
 *   vector is treated exactly like a missing one and gets re-embedded, not silently reused.
 * - Provider-call failures and storage-write failures are handled, counted, and reported
 *   separately (see below) - one is never mistaken for the other.
 * - A returned vector that fails validateEmbeddingVector (wrong length, NaN/Infinity
 *   element, zero norm, wrong type) is never stored - it is counted as `failed`.
 * - `stopRequested` is polled the same way runTextIndex (library-text) already does, so a
 *   run can be interrupted and later resumed from where it left off.
 * - Orphan cleanup (removing embeddings for chunks that no longer exist) only ever runs
 *   after a full (non-sample) pass that completed without being cancelled OR erroring - the
 *   same rule runTextIndex already applies to its own metadata-removal step. */
export async function runEmbeddingIndex(options: RunEmbeddingIndexOptions): Promise<EmbeddingProgress> {
  const { textStore, embeddingStore, provider, sample, batchSize = DEFAULT_EMBEDDING_BATCH_SIZE } = options;
  const progress: EmbeddingProgress = {
    running: true, cancelled: false, stopRequested: false, pid: process.pid,
    total: 0, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0, orphanRemoved: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
    ...(sample !== undefined ? { sampleTarget: sample } : {}),
  };
  embeddingStore.claim(progress);
  const aborter = new AbortController();
  const timer = setInterval(() => { if (embeddingStore.progress()?.stopRequested) { progress.stopRequested = true; aborter.abort(); } }, 300);
  const persist = () => { progress.stopRequested ||= embeddingStore.progress()?.stopRequested ?? false; embeddingStore.setProgress(progress); };
  const seenChunkIds = new Set<string>();
  let storageUnavailable = false;
  try {
    let cursorRowid = 0;
    while (!aborter.signal.aborted && !progress.stopRequested && !storageUnavailable) {
      const remaining = sample !== undefined ? sample - progress.total : batchSize;
      if (sample !== undefined && remaining <= 0) break;
      const take = sample !== undefined ? Math.min(batchSize, remaining) : batchSize;
      const rows = textStore.db.prepare('SELECT rowid, id, documentId, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?').all(cursorRowid, take) as unknown as ChunkRow[];
      if (!rows.length) break;
      cursorRowid = rows[rows.length - 1].rowid;
      progress.total += rows.length; persist();

      const toEmbed: { id: string; documentId: string; text: string; contentHash: string }[] = [];
      for (const row of rows) {
        seenChunkIds.add(row.id);
        // An empty/whitespace-only chunk has nothing to embed - skip it outright rather
        // than send blank text to the provider or store a meaningless vector for it.
        if (!row.text.trim()) { progress.skipped++; progress.processed++; continue; }
        const contentHash = sha256(row.text);
        const existing = embeddingStore.recordFor(row.id);
        const fingerprintMatches = !!existing && existing.contentHash === contentHash && existing.documentId === row.documentId
          && existing.providerId === provider.id && existing.model === provider.model && existing.dimension === provider.dimension;
        // A fingerprint match is not enough on its own: a stored vector can be corrupted
        // (bad BLOB, wrong actual length, NaN/Infinity) despite matching metadata exactly -
        // that must never be silently reused.
        const storedVectorValid = fingerprintMatches && validateEmbeddingVector(existing.vector, provider.dimension).valid;
        if (storedVectorValid) { progress.reused++; progress.processed++; }
        else toEmbed.push({ id: row.id, documentId: row.documentId, text: row.text, contentHash });
      }
      persist();

      if (toEmbed.length && !aborter.signal.aborted && !progress.stopRequested) {
        // Step 1: the provider call, handled and counted entirely separately from storage.
        let vectors: Float32Array[];
        try {
          vectors = await provider.embedDocuments(toEmbed.map(c => c.text));
        } catch (error) {
          console.error('[embeddings] provider call failed', error);
          progress.failed += toEmbed.length; progress.processed += toEmbed.length;
          persist();
          continue; // the provider itself might recover on the next batch of chunks
        }

        // Step 2: validate every returned vector before it is ever considered for storage.
        // Never trust the provider's own reported success - re-check independently.
        const now = new Date().toISOString();
        const validRecords: EmbeddingRecord[] = [];
        for (let i = 0; i < toEmbed.length; i++) {
          const chunk = toEmbed[i];
          const validation = validateEmbeddingVector(vectors[i], provider.dimension);
          if (!validation.valid) { progress.failed++; progress.processed++; continue; }
          validRecords.push({
            chunkId: chunk.id, documentId: chunk.documentId, contentHash: chunk.contentHash,
            providerId: provider.id, model: provider.model, dimension: provider.dimension,
            vector: validation.vector, createdAt: now, updatedAt: now,
          });
        }

        // Step 3: the storage write, in its own transaction, handled and counted entirely
        // separately from the provider call above - a storage failure is never mistaken
        // for (or reported as) a provider failure, and vice versa.
        if (validRecords.length) {
          try {
            embeddingStore.upsertBatch(validRecords);
            progress.embedded += validRecords.length; progress.processed += validRecords.length;
          } catch (error) {
            console.error('[embeddings] storage write failed', error);
            // Never assume the transaction rolled back cleanly - verify what is actually
            // there so embedded/failed reflect reality, not an assumption about atomicity.
            const actuallyStored = countActuallyStored(embeddingStore, textStore, validRecords);
            progress.embedded += actuallyStored;
            progress.failed += validRecords.length - actuallyStored;
            progress.processed += validRecords.length;
            progress.error = 'Хранилище эмбеддингов недоступно для записи. Индексирование остановлено.';
            storageUnavailable = true; // no point making further provider calls this run
          }
        }
        persist();
      }
      if (rows.length < take) break; // reached the end of the chunks table
    }
    progress.cancelled = aborter.signal.aborted || progress.stopRequested;
    if (!progress.cancelled && !progress.error && sample === undefined) {
      for (const chunkId of embeddingStore.chunkIds()) if (!seenChunkIds.has(chunkId)) { embeddingStore.remove(chunkId); progress.orphanRemoved++; }
    }
  } catch (error) {
    console.error('[embeddings] indexing run failed', error);
    progress.error = 'Индексирование эмбеддингов прервано. Уже сохранённые векторы доступны.';
  } finally {
    clearInterval(timer); progress.running = false; progress.finishedAt = new Date().toISOString(); persist();
  }
  return progress;
}

/** Combines local embedding-store facts with the text index's current chunk count into the
 *  single EmbeddingIndexStatus the UI/API needs. `totalCurrentChunks` should come from the
 *  same TextStore the indexer itself reads from (`SELECT count(*) FROM chunks`).
 *
 * `isConsistent`, when supplied (see rag/hybrid.ts's chunkConsistencyChecker), makes
 * `embeddedChunks`/coverage count ONLY rows that are genuinely usable right now: a valid
 * vector (validateEmbeddingVector) for a chunk that still exists, still belongs to the same
 * document, and whose content hash still matches the chunk's current text. Without it,
 * this falls back to a naive provider/model/dimension row count (cheaper, but blind to
 * orphaned/corrupted/mismatched rows) - callers that can provide the checker should. */
export function computeEmbeddingOverview(
  embeddingStore: EmbeddingStore, provider: EmbeddingProvider | null, totalCurrentChunks: number,
  isConsistent?: (chunkId: string, documentId: string, contentHash: string) => boolean,
): EmbeddingOverview {
  const progress = embeddingStore.overviewProgress();
  if (progress?.running) {
    return { status: 'rebuilding', progress, stats: { totalChunks: totalCurrentChunks, embeddedChunks: 0, staleChunks: 0, providerId: provider?.id ?? null, model: provider?.model ?? null, dimension: provider?.dimension ?? null } };
  }
  if (!provider) {
    return { status: 'not_configured', progress, stats: { totalChunks: totalCurrentChunks, embeddedChunks: 0, staleChunks: embeddingStore.totalCount(), providerId: null, model: null, dimension: null } };
  }
  const total = embeddingStore.totalCount();
  const { valid: current } = embeddingStore.validCount(provider.id, provider.model, provider.dimension, isConsistent);
  const stale = total - current;
  const stats = { totalChunks: totalCurrentChunks, embeddedChunks: current, staleChunks: stale, providerId: provider.id, model: provider.model, dimension: provider.dimension };
  let status: EmbeddingOverview['status'];
  if (total === 0) status = 'empty';
  else if (current === 0) status = 'stale';
  else if (current < totalCurrentChunks) status = 'partial';
  else if (stale > 0) status = 'stale';
  else status = 'ready';
  return { status, progress, stats };
}

export { EmbeddingStore } from './store';
export type { EmbeddingRow } from './store';
export { validateEmbeddingVector, cosineSimilarity, topK } from './vector';
export { getEmbeddingProvider, DeterministicEmbeddingProvider, OpenAIEmbeddingProvider } from './providers';
export { DEFAULT_EMBEDDING_BATCH_SIZE, MAX_SAMPLE_SIZE } from './types';
export type * from './types';
