import 'server-only';
import { openTextStore } from '@/services/library-text';
import type { TextStore } from '@/services/library-text/store';
import { computeEmbeddingOverview, getEmbeddingProvider, openEmbeddingStore } from '@/services/embeddings';
import type { EmbeddingOverview, EmbeddingProvider } from '@/services/embeddings/types';
import type { EmbeddingStore } from '@/services/embeddings/store';
import { buildContext } from './context';
import { validateAnswerGrounding } from './citations';
import { getAnswerProvider } from './providers';
import type { AnswerProvider } from './providers/types';
import { chunkConsistencyChecker, hybridRetrieve } from './hybrid';
import type { VectorCache } from '@/services/embeddings/cache';
import type { ConsistencyCache } from './consistency-cache';
import type { AnswerResult, FusedChunk, GroundingRejectionReason, RagContext, RagDiagnostics, RagResult, RagStatus, RetrievalDiagnostics, RetrievalMode, RetrievedChunk } from './types';
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
  /** Injected for tests. `undefined` means "use the real getEmbeddingProvider() auto-
   *  detection"; explicit `null` forces "no embedding provider configured" even if one
   *  would otherwise be auto-detected. */
  embeddingProvider?: EmbeddingProvider | null;
  /** Injected for tests; defaults to the real on-disk store via openEmbeddingStore(). Only
   *  ever called when an embeddingProvider is configured. */
  openEmbeddingStore?: () => Promise<EmbeddingStore>;
  /** STRICTLY OPT-IN, purely a performance layer (see hybrid.ts's HybridRetrieveOptions doc
   *  comment): undefined means no cache at all - askLibrary never defaults this to the
   *  shared process-wide singleton itself, precisely so every existing/future test that
   *  doesn't mention caching keeps working unmodified. The real production entry point (the
   *  Next.js route handler, src/app/api/library/ask/route.ts) is the one place that
   *  explicitly passes the shared singleton - that is the only place caching actually
   *  activates for real users. */
  vectorCache?: VectorCache;
  /** Same strictly opt-in contract as vectorCache above, for the chunk-consistency cache
   *  (rag/consistency-cache.ts). Used both for the embedding-overview computation and for
   *  every semantic query in this request. */
  consistencyCache?: ConsistencyCache;
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

function baseResult(question: string, limit: number, mode: RetrievalMode, status: RagStatus, answer: AnswerResult): RagResult {
  return { question, limit, mode, status, chunks: [], citations: [], answer };
}

function withDiagnostics(result: RagResult, diagnostics: RagDiagnostics, options: AskLibraryOptions): RagResult {
  const include = options.includeDiagnostics ?? process.env.NODE_ENV === 'development';
  return include ? { ...result, diagnostics } : result;
}

function baseDiagnostics(chunks: readonly RetrievedChunk[], context: RagContext | null, retrieval: RetrievalDiagnostics, generationMs: number, answerRejectedReason: GroundingRejectionReason | null): RagDiagnostics {
  return {
    chunksFound: chunks.length,
    documentsUsed: [...new Set(chunks.map(c => c.documentId))],
    scores: chunks.map(c => ({ chunkId: c.chunkId, score: c.score })),
    contextChars: context?.block.length ?? 0,
    contextTruncated: context?.truncated ?? false,
    retrievalMs: retrieval.totalMs, generationMs, answerRejectedReason, retrieval,
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

/** Opens the embedding provider/store, if configured, without ever letting a failure here
 *  propagate: hybridRetrieve() treats a null provider/store as "semantic unavailable" and
 *  degrades to lexical-only, with the reason recorded in diagnostics - the same safe-
 *  degradation contract as every other optional piece of this pipeline. */
async function openEmbeddingContext(options: AskLibraryOptions, textStore: TextStore): Promise<{ provider: EmbeddingProvider | null; store: EmbeddingStore | null; overview: EmbeddingOverview | null }> {
  const provider = options.embeddingProvider !== undefined ? options.embeddingProvider : getEmbeddingProvider();
  if (!provider) return { provider: null, store: null, overview: null };
  try {
    const open = options.openEmbeddingStore ?? openEmbeddingStore;
    const store = await open();
    const isConsistent = options.consistencyCache?.checker(textStore) ?? chunkConsistencyChecker(textStore);
    const overview = computeEmbeddingOverview(store, provider, textStore.chunkCount(), isConsistent);
    return { provider, store, overview };
  } catch (error) {
    console.error('[rag] failed to open embedding store', error);
    return { provider, store: null, overview: null };
  }
}

/** Retrieval (hybridRetrieve: lexical FTS5 and/or semantic vector search, rank-fused) ->
 *  context -> generation, kept as separate steps so the retrieval layer can evolve (e.g.
 *  adding embeddings, as it now has) without touching context building, prompting,
 *  citation validation or the answer-provider abstraction. */
export async function askLibrary(input: unknown, options: AskLibraryOptions = {}): Promise<RagResult> {
  const { question, limit, mode: requestedMode } = parseAskInput(input);
  const openStore = options.openStore ?? openTextStore;
  let store: TextStore;
  try { store = await openStore(); }
  catch { return baseResult(question, limit, requestedMode, 'unavailable', emptyAnswer(false, UNAVAILABLE_MESSAGE)); }
  let embeddingStore: EmbeddingStore | null = null;
  try {
    const embedding = await openEmbeddingContext(options, store);
    embeddingStore = embedding.store;
    let chunks: FusedChunk[];
    let retrieval: RetrievalDiagnostics;
    try {
      const result = await hybridRetrieve({
        textStore: store, mode: requestedMode, question, limit,
        embeddingProvider: embedding.provider, embeddingStore: embedding.store, embeddingOverview: embedding.overview,
        vectorCache: options.vectorCache, consistencyCache: options.consistencyCache,
      });
      chunks = result.chunks; retrieval = result.diagnostics;
    } catch (error) {
      console.error('[rag] retrieval failed', error);
      return baseResult(question, limit, requestedMode, 'index_error', emptyAnswer(false, INDEX_ERROR_MESSAGE));
    }
    if (!chunks.length) {
      const result: RagResult = { question, limit, mode: retrieval.mode, status: 'insufficient_evidence', chunks: [], citations: [], answer: emptyAnswer(true, null) };
      return withDiagnostics(result, baseDiagnostics([], null, retrieval, 0, null), options);
    }
    const build = options.buildContext ?? buildContext;
    const context = build(chunks);
    if (!context.citations.length) {
      // Budget enforcement (context.ts) left no source with any surviving evidence text -
      // there is nothing a provider could possibly ground an answer in, so this is reported
      // (and short-circuited) the same way as an empty retrieval, without spending a call.
      const result: RagResult = { question, limit, mode: retrieval.mode, status: 'insufficient_evidence', chunks, citations: [], answer: emptyAnswer(true, null) };
      return withDiagnostics(result, baseDiagnostics(chunks, context, retrieval, 0, null), options);
    }
    const provider = options.provider ?? getAnswerProvider();
    const generationStart = Date.now();
    const { answer, status, rejectedReason } = await generateAnswer(question, context, provider);
    const generationMs = Date.now() - generationStart;
    const result: RagResult = { question, limit, mode: retrieval.mode, status, chunks, citations: context.citations, answer };
    return withDiagnostics(result, baseDiagnostics(chunks, context, retrieval, generationMs, rejectedReason), options);
  } finally { store.close(); embeddingStore?.close(); }
}
