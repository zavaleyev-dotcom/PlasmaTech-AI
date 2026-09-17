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

/** The bounded, delimited prompt block built from retrieved chunks, plus its citation list. */
export interface RagContext {
  block: string;
  citations: Citation[];
  /** True if some retrieved chunks were dropped to respect the context size cap. */
  truncated: boolean;
}

export interface AnswerResult {
  /** Empty when not configured, when the provider failed, or when citations could not be verified. */
  text: string;
  configured: boolean;
  error: string | null;
}

export interface RagDiagnostics {
  chunksFound: number;
  documentsUsed: string[];
  scores: { chunkId: string; score: number }[];
  contextChars: number;
  contextTruncated: boolean;
  retrievalMs: number;
  generationMs: number;
}

export interface RagResult {
  question: string;
  limit: number;
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
/** Upper bound on the assembled prompt block sent to the answer provider. */
export const MAX_CONTEXT_CHARS = 6000;
/** Upper bound on a single chunk's contribution to the context block. */
export const MAX_CHUNK_CHARS_IN_CONTEXT = 1600;

export class RagValidationError extends Error {}
