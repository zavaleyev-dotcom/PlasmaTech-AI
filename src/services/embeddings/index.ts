import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { libraryConfig } from '@/services/local-library';
import type { TextStore } from '@/services/library-text/store';
import { EmbeddingStore } from './store';
import { DEFAULT_EMBEDDING_BATCH_SIZE } from './types';
import type { EmbeddingOverview, EmbeddingProgress, EmbeddingProvider } from './types';

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

/** Incremental, resumable embedding indexer over the text index's `chunks` table.
 *
 * - Reads chunks in small batches via a rowid cursor (`WHERE rowid > ? ORDER BY rowid LIMIT
 *   ?`), never loading the whole library into memory at once.
 * - Reuses a chunk's existing embedding when its content hash, provider id, model and
 *   dimension all still match (see EmbeddingStore.fingerprint) - only a changed chunk gets
 *   re-embedded.
 * - A provider call failure fails only the chunks in that one batch (`failed`), and the run
 *   continues with the next batch rather than aborting entirely.
 * - A returned vector that is empty or the wrong length is never stored - it is counted as
 *   `failed` too, so a misbehaving provider can never silently corrupt the store.
 * - `stopRequested` is polled the same way runTextIndex (library-text) already does, so a
 *   run can be interrupted and later resumed from where it left off.
 * - Orphan cleanup (removing embeddings for chunks that no longer exist) only ever runs
 *   after a full (non-sample) pass that completed without being cancelled - the same rule
 *   runTextIndex already applies to its own metadata-removal step. */
export async function runEmbeddingIndex(options: RunEmbeddingIndexOptions): Promise<EmbeddingProgress> {
  const { textStore, embeddingStore, provider, sample, batchSize = DEFAULT_EMBEDDING_BATCH_SIZE } = options;
  const progress: EmbeddingProgress = {
    running: true, cancelled: false, stopRequested: false, pid: process.pid,
    total: 0, processed: 0, reused: 0, embedded: 0, failed: 0, skipped: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null,
  };
  embeddingStore.claim(progress);
  const aborter = new AbortController();
  const timer = setInterval(() => { if (embeddingStore.progress()?.stopRequested) { progress.stopRequested = true; aborter.abort(); } }, 300);
  const persist = () => { progress.stopRequested ||= embeddingStore.progress()?.stopRequested ?? false; embeddingStore.setProgress(progress); };
  const seenChunkIds = new Set<string>();
  try {
    let cursorRowid = 0;
    while (!aborter.signal.aborted && !progress.stopRequested) {
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
        const contentHash = sha256(row.text);
        const existing = embeddingStore.fingerprint(row.id);
        if (existing && existing.contentHash === contentHash && existing.providerId === provider.id && existing.model === provider.model && existing.dimension === provider.dimension) {
          progress.reused++; progress.processed++;
        } else {
          toEmbed.push({ id: row.id, documentId: row.documentId, text: row.text, contentHash });
        }
      }
      persist();
      if (toEmbed.length && !aborter.signal.aborted && !progress.stopRequested) {
        try {
          const vectors = await provider.embedDocuments(toEmbed.map(c => c.text));
          const now = new Date().toISOString();
          for (let i = 0; i < toEmbed.length; i++) {
            const vector = vectors[i];
            const chunk = toEmbed[i];
            if (!vector || vector.length !== provider.dimension) { progress.failed++; progress.processed++; continue; }
            embeddingStore.upsert({
              chunkId: chunk.id, documentId: chunk.documentId, contentHash: chunk.contentHash,
              providerId: provider.id, model: provider.model, dimension: provider.dimension,
              vector, createdAt: now, updatedAt: now,
            });
            progress.embedded++; progress.processed++;
          }
        } catch (error) {
          // One failing batch must not abort the whole run, and must not leak provider
          // internals into stored progress state - only a count, logged server-side.
          console.error('[embeddings] batch embedding failed', error);
          progress.failed += toEmbed.length; progress.processed += toEmbed.length;
        }
        persist();
      }
      if (rows.length < take) break; // reached the end of the chunks table
    }
    progress.cancelled = aborter.signal.aborted || progress.stopRequested;
    if (!progress.cancelled && sample === undefined) {
      for (const chunkId of embeddingStore.chunkIds()) if (!seenChunkIds.has(chunkId)) embeddingStore.remove(chunkId);
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
 *  same TextStore the indexer itself reads from (`SELECT count(*) FROM chunks`). */
export function computeEmbeddingOverview(embeddingStore: EmbeddingStore, provider: EmbeddingProvider | null, totalCurrentChunks: number): EmbeddingOverview {
  const progress = embeddingStore.overviewProgress();
  if (progress?.running) {
    return { status: 'rebuilding', progress, stats: { totalChunks: totalCurrentChunks, embeddedChunks: 0, staleChunks: 0, providerId: provider?.id ?? null, model: provider?.model ?? null, dimension: provider?.dimension ?? null } };
  }
  if (!provider) {
    return { status: 'not_configured', progress, stats: { totalChunks: totalCurrentChunks, embeddedChunks: 0, staleChunks: embeddingStore.totalCount(), providerId: null, model: null, dimension: null } };
  }
  const total = embeddingStore.totalCount();
  const current = embeddingStore.currentCount(provider.id, provider.model, provider.dimension);
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
export { getEmbeddingProvider, DeterministicEmbeddingProvider, OpenAIEmbeddingProvider } from './providers';
export { DEFAULT_EMBEDDING_BATCH_SIZE, MAX_SAMPLE_SIZE } from './types';
export type * from './types';
