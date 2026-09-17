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
}

export interface RagResult {
  question: string;
  limit: number;
  status: RagStatus;
  chunks: RetrievedChunk[];
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
