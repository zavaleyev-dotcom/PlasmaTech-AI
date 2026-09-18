/** First-stage RAG over the local FTS5 text index. No embeddings, no vector store yet. */

/** A single retrieved chunk, enriched with the metadata needed for a citation. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  relativePath: string;
  filename: string;
  title: string;
  authors: string[];
  doi: string | null;
  year: number | null;
  sourceFolder: string;
  pageStart: number;
  pageEnd: number;
  /** Full chunk text (untrusted PDF content) used to build the model context. */
  text: string;
  /** Short FTS5 snippet, safe to render directly in "Показать найденные фрагменты". */
  snippet: string;
  /** Relative relevance score (reciprocal-rank based); not a calibrated probability. */
  score: number;
}

/** What a citation exposes to the UI; never includes raw chunk/document text. */
export interface Citation {
  index: number;
  chunkId: string;
  documentId: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  filename: string;
  relativePath: string;
  pageStart: number;
  pageEnd: number;
}

/** The bounded, JSON-serialized prompt block built from retrieved chunks, plus the citation
 *  list a source only ever joins once its own evidence text actually made it into `block`
 *  (see context.ts) - `citations` is therefore always exactly "what the model can truthfully
 *  cite", never a superset of it. */
export interface RagContext {
  block: string;
  citations: Citation[];
  /** True if anything was left out or cut short: a whole chunk, a metadata field, or content. */
  truncated: boolean;
}

/** One self-contained statement plus the sources that support it. Only ever constructed by
 *  validateAnswerGrounding() (citations.ts) from an already-checked AnswerProviderOutput -
 *  the UI/service layer builds any [n] marker FROM citationIds, never from provider prose. */
export interface AnswerClaim {
  text: string;
  citationIds: number[];
}

export interface AnswerResult {
  /** Populated only when status is 'answered'; empty for every other status. */
  claims: AnswerClaim[];
  configured: boolean;
  error: string | null;
}

/** Why a structured provider answer was rejected before ever reaching the user - see
 *  citations.ts. This is a citation-integrity/evidence-sufficiency verdict, never a claim
 *  that an *accepted* answer is factually true. */
export type GroundingRejectionReason = 'malformed-response' | 'malformed-citations' | 'unknown-citation' | 'missing-citations';

/** The overall outcome of one askLibrary() call - lets the API/UI tell apart a technical
 *  failure (unavailable/index_error) from a legitimate "nothing confident to say"
 *  (insufficient_evidence) instead of collapsing every failure into the same message. */
export type RagStatus =
  | 'answered'               // provider configured, chunks found, answer passed grounding validation
  | 'insufficient_evidence'  // retrieval ran successfully but found nothing, OR the provider's
                             // answer failed grounding validation despite chunks being found
  | 'not_configured'         // chunks found, but no answer provider is configured
  | 'generation_error'       // chunks found, provider configured, but generate() failed (network/timeout/bad response)
  | 'unavailable'            // the local text index/config could not even be opened
  | 'index_error';           // the index opened, but retrieval itself raised an unexpected error

export type RetrievalMode = 'lexical' | 'semantic' | 'hybrid';
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = 'hybrid';

/** Centralized, independently-testable fusion parameters for HybridRetriever (hybrid.ts).
 *  Rank-based (Reciprocal Rank Fusion), not a sum of BM25 and cosine similarity: the two
 *  scores live on incomparable scales, so only their RANK within each list is fused. */
export const RRF_K = 60;
export const RRF_LEXICAL_WEIGHT = 1;
export const RRF_SEMANTIC_WEIGHT = 1;

export type ChunkOrigin = 'lexical' | 'semantic' | 'both';

/** A retrieved chunk enriched with per-method provenance. `score` (inherited from
 *  RetrievedChunk) is the FUSED reciprocal-rank score used for final ordering;
 *  lexicalScore/semanticScore preserve each method's own original score for diagnostics. */
export interface FusedChunk extends RetrievedChunk {
  lexicalRank: number | null;
  semanticRank: number | null;
  fusedRank: number;
  lexicalScore: number | null;
  semanticScore: number | null;
  foundBy: ChunkOrigin;
}

/** Development-only retrieval diagnostics (see RagDiagnostics.retrieval). */
export interface RetrievalDiagnostics {
  /** The mode actually used, which may differ from what was requested if semantic search
   *  was unavailable and hybrid/semantic safely degraded to lexical-only (see fallbackReason). */
  mode: RetrievalMode;
  ftsCandidates: number;
  semanticCandidates: number;
  fusedCandidates: number;
  ftsMs: number;
  semanticMs: number;
  totalMs: number;
  embeddingProviderId: string | null;
  embeddingModel: string | null;
  /** Fraction (0..1) of the library's current chunks that have a current, VALID, and
   *  chunk/document/hash-consistent embedding (see EmbeddingStore.validCount), or null if
   *  unknown/not configured. Orphaned, corrupted, and mismatched rows are never counted as
   *  covered, even if they are still physically present in the embedding store. */
  embeddingCoverage: number | null;
  /** Store-wide rows that do not currently count as valid coverage (wrong provider/model/
   *  dimension, a corrupted vector, or an orphaned/mismatched/stale chunk relationship). */
  staleEmbeddingsCount: number | null;
  /** Stored rows for this provider/model/dimension whose vector failed validateEmbeddingVector
   *  during THIS query - excluded before ranking, never a candidate. */
  invalidVectorCount: number;
  /** Stored rows with a structurally valid vector that were excluded during THIS query
   *  because their chunk no longer exists, points at a different document, or their content
   *  hash no longer matches the chunk's current text (orphaned/mismatched/stale). */
  inconsistentCandidateCount: number;
  fallbackReason: string | null;
  /** Diagnostics for the optional process-local vector cache (embeddings/cache.ts) - purely
   *  informational: null whenever no cache was used for this call (disabled, or explicitly
   *  opted out via `vectorCache: null`). Never shown to an end user - dev-diagnostics only,
   *  gated the same way as the rest of RetrievalDiagnostics (see rag/service.ts). */
  cacheStatus: 'cold' | 'loading' | 'ready' | 'stale' | 'invalid' | 'disabled' | null;
  cacheEntries: number | null;
  cacheApproxMiB: number | null;
  cacheLoadMs: number | null;
  cacheHitCount: number | null;
  cacheFallbackCount: number | null;
  cacheInvalidationReason: string | null;
  /** Diagnostics for the optional process-local chunk-consistency cache
   *  (rag/consistency-cache.ts) - same never-shown-to-users, dev-diagnostics-only contract
   *  as the vector-cache fields above. Null whenever no consistency cache was used. */
  consistencyCacheStatus: 'cold' | 'loading' | 'ready' | 'stale' | 'invalid' | 'disabled' | null;
  consistencyCacheEntries: number | null;
  consistencyCacheLoadMs: number | null;
  consistencyCacheHitCount: number | null;
  consistencyCacheFallbackCount: number | null;
}

export interface RagDiagnostics {
  chunksFound: number;
  documentsUsed: string[];
  scores: { chunkId: string; score: number }[];
  contextChars: number;
  contextTruncated: boolean;
  retrievalMs: number;
  generationMs: number;
  /** Set only when status is 'insufficient_evidence' because a provider answer was rejected. */
  answerRejectedReason: GroundingRejectionReason | null;
  retrieval: RetrievalDiagnostics;
}

export interface RagResult {
  question: string;
  limit: number;
  /** The retrieval mode actually used (see RetrievalDiagnostics.mode for why it may differ
   *  from what was requested). Always present, not just in development, since it is exactly
   *  what the user chose (or what it safely degraded to) - never a hidden implementation detail. */
  mode: RetrievalMode;
  status: RagStatus;
  /** Always FusedChunk[] in practice (askLibrary always retrieves via hybridRetrieve, even
   *  in 'lexical'/'semantic' mode) - carries per-method provenance (lexicalRank/
   *  semanticRank/foundBy/...) for development diagnostics, on top of the plain
   *  RetrievedChunk fields every existing consumer already relies on. */
  chunks: FusedChunk[];
  citations: Citation[];
  answer: AnswerResult;
  /** Only populated outside production (see askLibrary in service.ts). */
  diagnostics?: RagDiagnostics;
}

export const DEFAULT_RETRIEVAL_LIMIT = 8;
/** Matches TextStore.search()'s own fixed page size (LIMIT 20): a single search() call
 *  per term is always enough, so retrieval never needs to page through results. */
export const MAX_RETRIEVAL_LIMIT = 20;
export const MAX_QUESTION_LENGTH = 2000;
/** Upper bound on the assembled prompt block sent to the answer provider. This is a hard
 *  cap: buildContext() never returns a block longer than this, regardless of metadata size. */
export const MAX_CONTEXT_CHARS = 6000;
/** Upper bound on a single chunk's CONTENT contribution to the context block. */
export const MAX_CHUNK_CHARS_IN_CONTEXT = 1600;
/** Upper bound on each individual untrusted metadata field (title, one author, DOI,
 *  filename, ...) so oversized/adversarial PDF metadata alone can never dominate the budget. */
export const MAX_METADATA_FIELD_CHARS = 300;

export class RagValidationError extends Error {}
