/** Semantic embeddings over the local library, kept as a store fully separate from the
 *  existing SQLite FTS5 text index (src/services/library-text) - this module only ever
 *  READS chunks/documents from that store; it never writes to it or changes its schema. */

/** A provider turns text into fixed-dimension vectors. Deliberately narrow and
 *  vendor-agnostic so an external API, a local model, or a deterministic test double can
 *  each implement it without any other part of this module knowing which one is active. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  /** Whether this provider has everything it needs (e.g. an API key) to be called at all. */
  configured(): boolean;
  /** One vector per input text, in the same order. Throws only for a technical failure
   *  (network, timeout, bad response) - never returns a mismatched-length array. */
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  /** A single query vector, using the same vector space as embedDocuments(). */
  embedQuery(text: string): Promise<Float32Array>;
  /** Human-readable, factual description of what leaves this machine when this provider is
   *  used (e.g. "chunk text, over HTTPS, to api.openai.com" vs "nothing - stays local"). Not
   *  used for any decision in code; exists so the app and this module's callers can always
   *  show/tell the truth about outbound data, per the local-first privacy requirement. */
  readonly outboundDataDescription: string;
}

export interface EmbeddingRecord {
  chunkId: string;
  documentId: string;
  contentHash: string;
  providerId: string;
  model: string;
  dimension: number;
  vector: Float32Array;
  createdAt: string;
  updatedAt: string;
}

/** Everything needed to decide whether a stored embedding is still usable, without needing
 *  the vector itself. An embedding is current only if ALL four match the chunk's current
 *  text hash and the currently configured provider/model/dimension - a provider or model
 *  change never lets an old vector be silently reused as if it were compatible. */
export interface EmbeddingFingerprint {
  contentHash: string;
  providerId: string;
  model: string;
  dimension: number;
}

export type EmbeddingIndexStatus =
  | 'not_configured' // no EmbeddingProvider configured (no EMBEDDING_PROVIDER env var / no key)
  | 'empty'          // provider configured, but the embedding store has zero rows
  | 'partial'        // some, but not all, current chunks have a current embedding
  | 'ready'          // every current chunk has a current embedding
  | 'stale'          // coverage is complete-ish but some rows don't match the current fingerprint
  | 'rebuilding'      // an indexing run is currently in progress
  | 'error';         // the embedding store could not be opened/read

export interface EmbeddingProgress {
  running: boolean;
  cancelled: boolean;
  stopRequested: boolean;
  pid: number;
  total: number;
  processed: number;
  reused: number;
  embedded: number;
  failed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface EmbeddingStats {
  totalChunks: number;
  embeddedChunks: number;
  staleChunks: number;
  providerId: string | null;
  model: string | null;
  dimension: number | null;
}

export interface EmbeddingOverview {
  status: EmbeddingIndexStatus;
  progress: EmbeddingProgress | null;
  stats: EmbeddingStats;
}

/** Default/limits for incremental embedding indexing. Kept small and centralized: this
 *  stage intentionally never runs unattended over the whole library (see runEmbeddingIndex
 *  and scripts/index-embeddings.ts, which only ever accept a bounded --sample). */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
/** Hard ceiling on a single sample run, enforced by the CLI script - not by
 *  runEmbeddingIndex() itself, which stays a general-purpose, resumable incremental indexer
 *  that MAY later be run over the full library once that is explicitly approved. */
export const MAX_SAMPLE_SIZE = 300;
