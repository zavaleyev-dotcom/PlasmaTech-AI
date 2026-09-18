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

/** Every counter below has one unambiguous meaning and `processed` is always exactly
 *  `reused + embedded + failed + skipped` once a run finishes (each chunk in `total`
 *  contributes to exactly one of the four, exactly once - see runEmbeddingIndex, index.ts).
 *  `orphanRemoved` is separate from all four: it counts embeddings deleted because their
 *  chunk no longer exists at all, which only ever happens after a full (non-sample) pass. */
export interface EmbeddingProgress {
  running: boolean;
  cancelled: boolean;
  stopRequested: boolean;
  pid: number;
  /** Chunks discovered so far in this run (grows as the rowid cursor advances). */
  total: number;
  /** Always reused + embedded + failed + skipped; never exceeds `total`. */
  processed: number;
  /** Had a matching, valid, still-consistent stored embedding - not re-embedded. */
  reused: number;
  /** A new (or corrected/re-embedded) vector was validated and durably stored. */
  embedded: number;
  /** The provider call failed, the returned vector failed validation, or the storage
   *  write failed for this chunk - see runEmbeddingIndex's three separately-handled steps. */
  failed: number;
  /** The chunk's text was empty/whitespace-only - intentionally never sent to the provider. */
  skipped: number;
  /** Embeddings deleted because their chunk no longer exists in the text index at all
   *  (distinct from a chunk that still exists but changed - that is `embedded`, not this). */
  orphanRemoved: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** The `sample` this run was called with, if any - set once at the start of a sample run
   *  and never changed. `total` alone cannot answer "how much of the requested job is done"
   *  while a sample run is still in its first batch (it only reflects chunks discovered SO
   *  FAR, which starts at 0 and grows toward `sample` as the cursor advances) - a caller that
   *  wants a meaningful progress percentage during a bounded run needs the actual target, not
   *  just what has been read yet. Optional and absent for a full (non-sample) run, and for
   *  every progress object that existed before this field was added (old persisted JSON in an
   *  existing embedding store still deserializes fine as `undefined` here). */
  sampleTarget?: number;
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
