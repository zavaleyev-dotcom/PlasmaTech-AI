import 'server-only';
import { validateEmbeddingVector } from './vector';
import type { EmbeddingStore } from './store';

/**
 * An OPTIONAL, process-local, in-memory cache of already-decoded, already-validated
 * embedding vectors for one (rootId, providerId, model, dimension) combination.
 *
 * Why this exists: semanticSearch's SQLite path (store.currentRows()) re-reads and
 * re-decodes every matching BLOB, and re-runs validateEmbeddingVector on every row, on
 * EVERY query - the dominant cost at 10k+ vectors (see the benchmark in
 * docs/architecture.md). This cache holds the already-validated Float32Array + precomputed
 * norm for each currently-usable row exactly once, and is reused across many queries within
 * the same long-lived server process, until the underlying store changes.
 *
 * Correctness comes first:
 *   - only rows that pass validateEmbeddingVector are ever cached (never a corrupted vector);
 *   - only rows that pass the caller's `isConsistent` check AT LOAD TIME are cached (never an
 *     orphan/mismatched-document/stale-hash row);
 *   - the cache key includes rootId/providerId/model/dimension, so it can never serve vectors
 *     for the wrong library, provider, model, or dimension;
 *   - EmbeddingStore.dataVersion() (a durable counter bumped by every upsertBatch/remove,
 *     including from a completely different process) is checked on every access - if it has
 *     moved since the cache was built, the cache transparently reloads before returning
 *     anything, so a re-embedded chunk's OLD vector can never be served;
 *   - EVEN WITHOUT a data-version change, the caller's `isConsistent` check is re-run for
 *     every cached entry on every query (cheap: a single indexed point lookup per entry,
 *     unlike a vector BLOB decode) - this is what catches a chunk whose TEXT changed without
 *     yet being re-embedded (no embeddings-store write happened, so dataVersion is
 *     unchanged, but the chunk is now genuinely stale and must never be served);
 *   - a failure anywhere in loading (a thrown exception from the store) is caught and turns
 *     into `getOrLoad` returning null, never a thrown error - callers (search.ts) always fall
 *     back to the direct SQLite path in that case. The cache is a pure performance layer:
 *     nothing about API/RAG behavior depends on it being present, warm, or even working.
 *
 * What is NOT cached: chunk/document TEXT is never stored here - only chunkId, documentId,
 * contentHash (needed to re-run the consistency check without a second round-trip to the
 * embeddings table), the vector, and its precomputed norm.
 */

export type VectorCacheStatus = 'cold' | 'loading' | 'ready' | 'stale' | 'invalid' | 'disabled';

export interface VectorCacheEntry {
  chunkId: string;
  documentId: string;
  contentHash: string;
  vector: Float32Array;
  norm: number;
}

export interface VectorCacheDiagnostics {
  status: VectorCacheStatus;
  /** null before the cache has ever loaded anything. */
  key: string | null;
  entries: number;
  approxMiB: number;
  loadMs: number | null;
  hitCount: number;
  /** Times a caller asked for cached entries but a (re)load was required first - includes
   *  the very first load, a key change, and a data-version-triggered reload. */
  reloadCount: number;
  /** Times getOrLoad returned null (disabled, or the load itself failed) and the caller had
   *  to use the direct SQLite path instead. */
  fallbackCount: number;
  invalidationReason: string | null;
  lastLoadSkippedInvalid: number;
  lastLoadSkippedInconsistent: number;
}

type ConsistencyChecker = (chunkId: string, documentId: string, contentHash: string) => boolean;

function approxBytesPerEntry(dimension: number): number {
  // Float32Array data + rough JS object/string overhead (two ~64-char hex ids + a hash),
  // deliberately generous rather than exact - this is a diagnostic estimate, not an
  // accounting figure anything depends on for correctness.
  return dimension * 4 + 220;
}

export class VectorCache {
  private status: VectorCacheStatus = 'cold';
  private entries: VectorCacheEntry[] = [];
  private key: string | null = null;
  private builtForDataVersion: number | null = null;
  private loadMs: number | null = null;
  private hitCount = 0;
  private reloadCount = 0;
  private fallbackCount = 0;
  private invalidationReason: string | null = null;
  private lastLoadSkippedInvalid = 0;
  private lastLoadSkippedInconsistent = 0;
  private disabled = false;

  /** Turns the cache off for the rest of this instance's lifetime - getOrLoad always
   *  returns null afterwards (safe fallback to SQLite). Intended for an explicit opt-out
   *  (env var), not for normal error handling (load failures already degrade to null on
   *  their own without needing this). */
  disable(reason: string) {
    this.disabled = true;
    this.status = 'disabled';
    this.invalidationReason = reason;
    this.entries = [];
  }

  private cacheKey(rootId: string, providerId: string, model: string, dimension: number): string {
    return `${rootId}::${providerId}::${model}::${dimension}`;
  }

  /** Diagnostic-only: reports whether the cache would consider itself stale right now,
   *  WITHOUT triggering a reload - used purely for surfacing an observable 'stale' status;
   *  every actual search always goes through getOrLoad, which self-heals transparently. */
  checkFreshness(store: EmbeddingStore, providerId: string, model: string, dimension: number): void {
    if (this.disabled || this.status === 'cold') return;
    const key = this.cacheKey(store.rootId, providerId, model, dimension);
    if (this.key !== null && key !== this.key) return; // a different key entirely; not "stale", just not this one
    if (this.status === 'ready' && store.dataVersion() !== this.builtForDataVersion) {
      this.status = 'stale';
      this.invalidationReason = 'embedding store changed since the cache was built';
    }
  }

  /**
   * Returns the currently-usable cached entries for this exact (rootId, providerId, model,
   * dimension), transparently (re)loading from `store` first if the cache is cold, keyed to
   * a different combination, or the store's dataVersion has moved since the last load.
   * Returns null (never throws) if the cache is disabled or the load itself fails - callers
   * must treat null as "use the direct SQLite path", not as an error.
   */
  getOrLoad(
    store: EmbeddingStore, providerId: string, model: string, dimension: number,
    isConsistent?: ConsistencyChecker,
  ): readonly VectorCacheEntry[] | null {
    if (process.env.EMBEDDING_VECTOR_CACHE === 'off') { this.disable('EMBEDDING_VECTOR_CACHE=off'); }
    if (this.disabled) { this.fallbackCount++; return null; }

    // The freshness check itself (rootId/dataVersion) is included in the SAME try/catch as
    // the load - both are SQLite calls, and the "never throws" contract must hold for the
    // whole operation, not just the load half of it.
    try {
      const key = this.cacheKey(store.rootId, providerId, model, dimension);
      const currentVersion = store.dataVersion();
      if (this.status === 'ready' && this.key === key && this.builtForDataVersion === currentVersion) {
        this.hitCount++;
        return this.entries;
      }

      this.status = 'loading';
      this.reloadCount++;
      const start = Date.now();
      const rows = store.currentRows(providerId, model, dimension);
      const next: VectorCacheEntry[] = [];
      let skippedInvalid = 0;
      let skippedInconsistent = 0;
      for (const row of rows) {
        const validation = validateEmbeddingVector(row.vector, dimension);
        if (!validation.valid) { skippedInvalid++; continue; }
        if (isConsistent && !isConsistent(row.chunkId, row.documentId, row.contentHash)) { skippedInconsistent++; continue; }
        next.push({ chunkId: row.chunkId, documentId: row.documentId, contentHash: row.contentHash, vector: validation.vector, norm: validation.norm });
      }
      this.entries = next;
      this.key = key;
      this.builtForDataVersion = currentVersion;
      this.loadMs = Date.now() - start;
      this.lastLoadSkippedInvalid = skippedInvalid;
      this.lastLoadSkippedInconsistent = skippedInconsistent;
      this.status = 'ready';
      this.invalidationReason = null;
      this.hitCount++;
      return this.entries;
    } catch (error) {
      this.status = 'invalid';
      this.entries = [];
      this.invalidationReason = error instanceof Error ? error.message : 'unknown cache load failure';
      this.fallbackCount++;
      return null;
    }
  }

  diagnostics(): VectorCacheDiagnostics {
    const approxMiB = this.entries.length > 0
      ? Math.round((this.entries.length * approxBytesPerEntry(this.entries[0].vector.length) / 1024 / 1024) * 100) / 100
      : 0;
    return {
      status: this.status, key: this.key, entries: this.entries.length, approxMiB,
      loadMs: this.loadMs, hitCount: this.hitCount, reloadCount: this.reloadCount, fallbackCount: this.fallbackCount,
      invalidationReason: this.invalidationReason,
      lastLoadSkippedInvalid: this.lastLoadSkippedInvalid, lastLoadSkippedInconsistent: this.lastLoadSkippedInconsistent,
    };
  }
}

/** One shared cache per running server process (see the class doc comment for why a
 *  per-request instance would be useless: rag/service.ts opens a fresh EmbeddingStore per
 *  request, but the cache must persist across requests to pay off). Tests never use this -
 *  they construct their own `new VectorCache()` so different tests' stores/keys can never
 *  collide, and so a fresh cache always starts cold regardless of test execution order. */
export const processVectorCache = new VectorCache();
