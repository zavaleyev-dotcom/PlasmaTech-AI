import { createHash } from 'node:crypto';
import type { TextStore } from '@/services/library-text/store';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * An OPTIONAL, process-local cache that replaces up to thousands of individual per-chunk
 * SQLite point lookups (one per semantic-search candidate, on EVERY query - measured as the
 * single largest cost in the whole semantic retrieval path once vector decoding was already
 * cached, see docs/architecture.md's "Этап 5"/"Этап 6") with a single batched read plus O(1)
 * in-memory lookups thereafter.
 *
 * Why re-hashing chunk text on every check is provably safe to avoid:
 *   - a chunk's `id` is `sha256(documentId:ordinal:text)` (see library-text/chunk.ts) - the
 *     text is baked INTO the identity of the row;
 *   - `chunks.text` is never UPDATEd in place anywhere in this codebase - a row is only ever
 *     INSERTed (TextStore.replace()) or DELETEd (replace()/remove(), cascading) - so for any
 *     chunkId that still exists, its `text` is, up to a SHA-256 collision, GUARANTEED to be
 *     whatever it always was;
 *   - therefore `sha256(text)` for a given still-existing chunkId never changes and can be
 *     computed ONCE and reused across every subsequent query, not just within one query;
 *   - a "changed" chunk does not mutate an existing row - it deletes the old one and inserts
 *     a brand-new row under a brand-new id (see the Codex-scenario test in
 *     tests/vector-cache.test.ts from the previous round) - which this cache picks up
 *     correctly via TextStore.dataVersion() (bumped by both replace() and remove()).
 *
 * Correctness guarantees, unchanged from the direct per-call checker
 * (hybrid.ts's chunkConsistencyChecker), never weakened for speed:
 *   - chunk existence (orphan detection);
 *   - the chunk's REAL current documentId matches what the embedding claims;
 *   - the chunk's REAL current content hash matches what the embedding claims (computed from
 *     live chunk text - see above for why "computed once, reused" is equivalent to
 *     "recomputed every time" here, not a weaker check).
 *
 * A failure anywhere in loading is caught and turns into `checker()` returning null, never a
 * thrown error - callers (hybrid.ts) always fall back to the direct, uncached
 * chunkConsistencyChecker in that case. Purely a performance layer: nothing about API/RAG
 * behavior depends on this cache being present, warm, or even working.
 */

export type ConsistencyCacheStatus = 'cold' | 'loading' | 'ready' | 'stale' | 'invalid' | 'disabled';

interface ConsistencyEntry { documentId: string; contentHash: string }

export interface ConsistencyCacheDiagnostics {
  status: ConsistencyCacheStatus;
  key: string | null;
  entries: number;
  approxMiB: number;
  loadMs: number | null;
  hitCount: number;
  reloadCount: number;
  fallbackCount: number;
  invalidationReason: string | null;
}

export type ChunkConsistencyChecker = (chunkId: string, documentId: string, contentHash: string) => boolean;

function approxBytesPerEntry(): number {
  // Two ~64-char hex ids (chunkId as the Map key, documentId as the value) plus a ~64-char
  // hex contentHash and JS object/Map overhead - a deliberately generous diagnostic estimate,
  // not an accounting figure anything depends on for correctness.
  return 260;
}

export class ConsistencyCache {
  private status: ConsistencyCacheStatus = 'cold';
  private map: Map<string, ConsistencyEntry> = new Map();
  private key: string | null = null;
  private builtForDataVersion: number | null = null;
  private loadMs: number | null = null;
  private hitCount = 0;
  private reloadCount = 0;
  private fallbackCount = 0;
  private invalidationReason: string | null = null;
  private disabled = false;

  disable(reason: string) {
    this.disabled = true;
    this.status = 'disabled';
    this.invalidationReason = reason;
    this.map = new Map();
  }

  /** Diagnostic-only: reports whether the cache would consider itself stale right now,
   *  WITHOUT triggering a reload - checker() always self-heals transparently regardless. */
  checkFreshness(textStore: TextStore): void {
    if (this.disabled || this.status === 'cold') return;
    if (this.key !== null && this.key !== textStore.rootId) return; // a different library entirely
    if (this.status === 'ready' && textStore.dataVersion() !== this.builtForDataVersion) {
      this.status = 'stale';
      this.invalidationReason = 'text index changed since the cache was built';
    }
  }

  /**
   * Returns a checker function with the SAME shape as hybrid.ts's chunkConsistencyChecker -
   * a drop-in replacement for every existing caller - transparently (re)loading the whole
   * `chunks` table (id/documentId/text, hashed once) first if the cache is cold, keyed to a
   * different library, or the store's dataVersion has moved since the last load. Returns
   * null (never throws) if disabled or the load itself fails.
   */
  checker(textStore: TextStore): ChunkConsistencyChecker | null {
    if (process.env.RAG_CONSISTENCY_CACHE === 'off') this.disable('RAG_CONSISTENCY_CACHE=off');
    if (this.disabled) { this.fallbackCount++; return null; }

    // The freshness check itself (rootId/dataVersion) is included in the SAME try/catch as
    // the load - both are SQLite calls, and the "never throws" contract must hold for the
    // whole operation, not just the load half of it.
    try {
      const key = textStore.rootId;
      const currentVersion = textStore.dataVersion();
      if (!(this.status === 'ready' && this.key === key && this.builtForDataVersion === currentVersion)) {
        this.status = 'loading';
        this.reloadCount++;
        const start = Date.now();
        const rows = textStore.db.prepare('SELECT id, documentId, text FROM chunks').all() as { id: string; documentId: string; text: string }[];
        const next = new Map<string, ConsistencyEntry>();
        for (const row of rows) next.set(row.id, { documentId: row.documentId, contentHash: sha256(row.text) });
        this.map = next;
        this.key = key;
        this.builtForDataVersion = currentVersion;
        this.loadMs = Date.now() - start;
        this.status = 'ready';
        this.invalidationReason = null;
      }
    } catch (error) {
      this.status = 'invalid';
      this.map = new Map();
      this.invalidationReason = error instanceof Error ? error.message : 'unknown consistency-cache load failure';
      this.fallbackCount++;
      return null;
    }
    this.hitCount++;
    const map = this.map;
    return (chunkId, documentId, contentHash) => {
      const entry = map.get(chunkId);
      if (!entry) return false; // orphan: the chunk no longer exists at all
      if (entry.documentId !== documentId) return false; // document link does not match reality
      return entry.contentHash === contentHash; // stale if the (immutable, per above) text no longer matches
    };
  }

  diagnostics(): ConsistencyCacheDiagnostics {
    return {
      status: this.status, key: this.key, entries: this.map.size,
      approxMiB: Math.round((this.map.size * approxBytesPerEntry() / 1024 / 1024) * 100) / 100,
      loadMs: this.loadMs, hitCount: this.hitCount, reloadCount: this.reloadCount, fallbackCount: this.fallbackCount,
      invalidationReason: this.invalidationReason,
    };
  }
}

/** One shared cache per running server process - see the class doc comment for why a
 *  per-request instance would be useless (a fresh TextStore is typically opened per request,
 *  but the cache must persist across requests to pay off). Tests never use this - they
 *  construct their own `new ConsistencyCache()` so different tests' stores/keys can never
 *  collide (mirrors embeddings/cache.ts's processVectorCache exactly, and for the same
 *  reason: a cache keyed only by rootId, not store-instance identity, would otherwise
 *  silently collide between two independent tests that happen to share a rootId string). */
export const processConsistencyCache = new ConsistencyCache();
