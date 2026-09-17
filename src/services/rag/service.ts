import 'server-only';
import { openTextStore } from '@/services/library-text';
import type { TextStore } from '@/services/library-text/store';
import { buildContext } from './context';
import { validateAnswerGrounding } from './citations';
import { getAnswerProvider } from './providers';
import type { AnswerProvider } from './providers/types';
import { retrieveChunks } from './retrieve';
import type { AnswerResult, GroundingRejectionReason, RagContext, RagDiagnostics, RagResult, RagStatus, RetrievedChunk } from './types';
import { parseAskInput } from './validation';

export interface AskLibraryOptions {
  /** Injected for tests; defaults to the real on-disk store via openTextStore(). */
  openStore?: () => Promise<TextStore>;
  /** Injected for tests; defaults to getAnswerProvider() (env-based auto-detection). */
  provider?: AnswerProvider;
  /** Force-include diagnostics regardless of NODE_ENV (tests use this instead of the env var). */
  includeDiagnostics?: boolean;
  /** Injected for tests, e.g. to force a tiny context budget end-to-end; defaults to the
   *  real buildContext() with its default size limits. */
  buildContext?: typeof buildContext;
}

/** Fixed, generic message for every answer-provider failure. Deliberately never built from
 *  the caught error: no upstream response body, malformed-JSON detail, stack trace, URL or
 *  API key can reach the client through this string, regardless of what any current or
 *  future AnswerProvider implementation throws. The real error is only ever logged server-side. */
const GENERATION_ERROR_MESSAGE = 'Не удалось получить ответ от модели. Показаны найденные источники.';

/** Fixed, generic message for a retrieval-layer technical failure (e.g. a genuine SQLite/FTS
 *  error), as opposed to a legitimate empty result. Never built from the caught error either. */
const INDEX_ERROR_MESSAGE = 'Внутренняя ошибка локального текстового индекса. Обновите индекс в разделе «Моя библиотека» или повторите позже.';

const UNAVAILABLE_MESSAGE = 'Локальный текстовый индекс недоступен. Проверьте SCIENTIFIC_LIBRARY_PATH и запустите индексирование в разделе «Моя библиотека».';

function emptyAnswer(configured: boolean, error: string | null): AnswerResult {
  return { claims: [], configured, error };
}

function baseResult(question: string, limit: number, status: RagStatus, answer: AnswerResult): RagResult {
  return { question, limit, status, chunks: [], citations: [], answer };
}

function withDiagnostics(result: RagResult, diagnostics: RagDiagnostics, options: AskLibraryOptions): RagResult {
  const include = options.includeDiagnostics ?? process.env.NODE_ENV === 'development';
  return include ? { ...result, diagnostics } : result;
}

function baseDiagnostics(chunks: readonly RetrievedChunk[], context: RagContext | null, retrievalMs: number, generationMs: number, answerRejectedReason: GroundingRejectionReason | null): RagDiagnostics {
  return {
    chunksFound: chunks.length,
    documentsUsed: [...new Set(chunks.map(c => c.documentId))],
    scores: chunks.map(c => ({ chunkId: c.chunkId, score: c.score })),
    contextChars: context?.block.length ?? 0,
    contextTruncated: context?.truncated ?? false,
    retrievalMs, generationMs, answerRejectedReason,
  };
}

interface GeneratedAnswer { answer: AnswerResult; status: RagStatus; rejectedReason: GroundingRejectionReason | null }

/** Runs the provider and validates its structured output against the actual retrieved
 *  sources. Three independently-checkable outcomes, never conflated:
 *    - the provider call itself fails technically (network/timeout/bad response) -> 'generation_error'
 *    - the provider responds, but the answer is not grounded in RagContext.citations
 *      (missing/unknown/malformed citationIds, on any claim) -> 'insufficient_evidence'
 *    - every claim is grounded -> 'answered', with claim text already stripped of any
 *      self-authored bracket sequence that could be mistaken for a citation marker
 *      (validateAnswerGrounding/citations.ts) - the caller (API/UI) builds the displayed
 *      [n] markers itself, from citationIds, never from provider prose. */
async function generateAnswer(question: string, context: RagContext, provider: AnswerProvider): Promise<GeneratedAnswer> {
  if (!provider.configured()) return { answer: emptyAnswer(false, null), status: 'not_configured', rejectedReason: null };
  let output: Awaited<ReturnType<AnswerProvider['generate']>>;
  try { output = await provider.generate({ question, context }); }
  catch (error) {
    console.error('[rag] answer provider failed', error);
    return { answer: emptyAnswer(true, GENERATION_ERROR_MESSAGE), status: 'generation_error', rejectedReason: null };
  }
  const grounding = validateAnswerGrounding(output, context.citations);
  if (!grounding.valid) {
    return { answer: emptyAnswer(true, null), status: 'insufficient_evidence', rejectedReason: grounding.reason };
  }
  return { answer: { claims: grounding.claims, configured: true, error: null }, status: 'answered', rejectedReason: null };
}

/** Retrieval -> context -> generation, kept as separate steps (retrieveChunks / buildContext
 *  / generateAnswer) so a future embeddings-based retrieval provider can replace only the
 *  first step without touching context building, prompting, citation validation or the
 *  answer-provider abstraction. */
export async function askLibrary(input: unknown, options: AskLibraryOptions = {}): Promise<RagResult> {
  const { question, limit } = parseAskInput(input);
  const openStore = options.openStore ?? openTextStore;
  let store: TextStore;
  try { store = await openStore(); }
  catch { return baseResult(question, limit, 'unavailable', emptyAnswer(false, UNAVAILABLE_MESSAGE)); }
  try {
    let chunks: RetrievedChunk[];
    const retrievalStart = Date.now();
    try { chunks = retrieveChunks(store, question, limit); }
    catch (error) {
      console.error('[rag] retrieval failed', error);
      return baseResult(question, limit, 'index_error', emptyAnswer(false, INDEX_ERROR_MESSAGE));
    }
    const retrievalMs = Date.now() - retrievalStart;
    if (!chunks.length) {
      const result: RagResult = { question, limit, status: 'insufficient_evidence', chunks: [], citations: [], answer: emptyAnswer(true, null) };
      return withDiagnostics(result, baseDiagnostics([], null, retrievalMs, 0, null), options);
    }
    const build = options.buildContext ?? buildContext;
    const context = build(chunks);
    if (!context.citations.length) {
      // Budget enforcement (context.ts) left no source with any surviving evidence text -
      // there is nothing a provider could possibly ground an answer in, so this is reported
      // (and short-circuited) the same way as an empty retrieval, without spending a call.
      const result: RagResult = { question, limit, status: 'insufficient_evidence', chunks, citations: [], answer: emptyAnswer(true, null) };
      return withDiagnostics(result, baseDiagnostics(chunks, context, retrievalMs, 0, null), options);
    }
    const provider = options.provider ?? getAnswerProvider();
    const generationStart = Date.now();
    const { answer, status, rejectedReason } = await generateAnswer(question, context, provider);
    const generationMs = Date.now() - generationStart;
    const result: RagResult = { question, limit, status, chunks, citations: context.citations, answer };
    return withDiagnostics(result, baseDiagnostics(chunks, context, retrievalMs, generationMs, rejectedReason), options);
  } finally { store.close(); }
}
