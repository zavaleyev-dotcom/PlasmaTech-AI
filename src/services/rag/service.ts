import 'server-only';
import { openTextStore } from '@/services/library-text';
import type { TextStore } from '@/services/library-text/store';
import { buildContext } from './context';
import { hasOnlyKnownCitations } from './citations';
import { INSUFFICIENT_DATA_ANSWER } from './prompt';
import { getAnswerProvider } from './providers';
import type { AnswerProvider } from './providers/types';
import { retrieveChunks } from './retrieve';
import type { AnswerResult, RagContext, RagDiagnostics, RagResult } from './types';
import { parseAskInput } from './validation';

export interface AskLibraryOptions {
  /** Injected for tests; defaults to the real on-disk store via openTextStore(). */
  openStore?: () => Promise<TextStore>;
  /** Injected for tests; defaults to getAnswerProvider() (env-based auto-detection). */
  provider?: AnswerProvider;
  /** Force-include diagnostics regardless of NODE_ENV (tests use this instead of the env var). */
  includeDiagnostics?: boolean;
}

function unavailableResult(question: string, limit: number): RagResult {
  return {
    question, limit, chunks: [], citations: [],
    answer: {
      text: '', configured: false,
      error: 'Локальный текстовый индекс недоступен. Проверьте SCIENTIFIC_LIBRARY_PATH и запустите индексирование в разделе «Моя библиотека».',
    },
  };
}

function insufficientDataResult(question: string, limit: number): RagResult {
  return { question, limit, chunks: [], citations: [], answer: { text: INSUFFICIENT_DATA_ANSWER, configured: true, error: null } };
}

function withDiagnostics(result: RagResult, diagnostics: RagDiagnostics, options: AskLibraryOptions): RagResult {
  const include = options.includeDiagnostics ?? process.env.NODE_ENV === 'development';
  return include ? { ...result, diagnostics } : result;
}

async function generateAnswer(question: string, context: RagContext, provider: AnswerProvider): Promise<AnswerResult> {
  if (!provider.configured()) return { text: '', configured: false, error: null };
  let raw: string;
  try { raw = await provider.generate({ question, context }); }
  catch (error) {
    return { text: '', configured: true, error: error instanceof Error ? error.message : 'Не удалось получить ответ от модели.' };
  }
  // Never let a generated answer reference a source outside what was actually retrieved.
  if (!hasOnlyKnownCitations(raw, context.citations)) {
    return { text: '', configured: true, error: 'Ответ модели ссылался на источник, отсутствующий в результатах поиска, и был отклонён.' };
  }
  return { text: raw, configured: true, error: null };
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
  catch { return unavailableResult(question, limit); }
  try {
    const retrievalStart = Date.now();
    const chunks = retrieveChunks(store, question, limit);
    const retrievalMs = Date.now() - retrievalStart;
    if (!chunks.length) {
      return withDiagnostics(insufficientDataResult(question, limit), {
        chunksFound: 0, documentsUsed: [], scores: [], contextChars: 0, contextTruncated: false, retrievalMs, generationMs: 0,
      }, options);
    }
    const context = buildContext(chunks);
    const provider = options.provider ?? getAnswerProvider();
    const generationStart = Date.now();
    const answer = await generateAnswer(question, context, provider);
    const generationMs = Date.now() - generationStart;
    const result: RagResult = { question, limit, chunks, citations: context.citations, answer };
    return withDiagnostics(result, {
      chunksFound: chunks.length,
      documentsUsed: [...new Set(chunks.map(c => c.documentId))],
      scores: chunks.map(c => ({ chunkId: c.chunkId, score: c.score })),
      contextChars: context.block.length,
      contextTruncated: context.truncated,
      retrievalMs, generationMs,
    }, options);
  } finally { store.close(); }
}
