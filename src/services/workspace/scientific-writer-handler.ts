/** The testable request/response pipeline for the Scientific Writer generation API route, kept
 *  OUT of route.ts (F01): a Next.js App Router `route.ts` module may only export the handful of
 *  names Next itself recognizes (GET/POST/.../config/...) - any other named export (like a
 *  helper a test imports directly) fails Next's own generated route-type check under the
 *  webpack production build (`next build --webpack`), even though it is silently accepted by
 *  the Turbopack dev/build path. Moving handleGenerate here, with route.ts reduced to a thin
 *  request/response adapter that imports (not re-exports) it, fixes that class of error
 *  architecturally rather than for this one route. */

import 'server-only';
import {
  validateInput, buildEvidenceReport, buildGenerationPrompt, checkPreservation, summarizeChanges, buildSafetyWarnings,
  WRITER_MODES, type ScientificWriterInput, type WriterMode,
} from './scientific-writer';
import { WriterProviderError, type WriterProvider } from './scientific-writer-provider';

const REWRITE_LIKE_MODES: readonly WriterMode[] = ['rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'];
const MAX_SHORT = 500;
const MAX_LONG = 20_000;

function asOptionalString(value: unknown, label: string, maxLen: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label}: ожидается строка.`);
  if (value.length > maxLen) throw new Error(`${label}: текст слишком длинный (максимум ${maxLen} символов).`);
  return value;
}

/** Rebuilds a ScientificWriterInput from arbitrary, untrusted JSON - every field is read by
 *  name and type/length checked here; nothing is ever spread wholesale from the request body. */
function parseInput(raw: Record<string, unknown>): ScientificWriterInput {
  if (typeof raw.documentType !== 'string') throw new Error('Тип документа: обязательное поле.');
  if (typeof raw.mode !== 'string' || !WRITER_MODES.includes(raw.mode as WriterMode)) throw new Error('Режим работы: недопустимое значение.');
  if (typeof raw.targetLanguage !== 'string') throw new Error('Целевой язык: обязательное поле.');
  return {
    documentType: raw.documentType as ScientificWriterInput['documentType'],
    mode: raw.mode as WriterMode,
    targetLanguage: raw.targetLanguage as ScientificWriterInput['targetLanguage'],
    title: asOptionalString(raw.title, 'Название/тема', MAX_SHORT),
    researchField: asOptionalString(raw.researchField, 'Область исследования', MAX_SHORT),
    goal: asOptionalString(raw.goal, 'Цель', MAX_LONG),
    researchObject: asOptionalString(raw.researchObject, 'Объект исследования', MAX_LONG),
    methods: asOptionalString(raw.methods, 'Методы', MAX_LONG),
    results: asOptionalString(raw.results, 'Основные результаты', MAX_LONG),
    conclusions: asOptionalString(raw.conclusions, 'Выводы', MAX_LONG),
    keywords: asOptionalString(raw.keywords, 'Ключевые слова', MAX_SHORT),
    sourceText: asOptionalString(raw.sourceText, 'Исходный текст', MAX_LONG),
    additionalRequirements: asOptionalString(raw.additionalRequirements, 'Дополнительные требования', MAX_LONG),
  };
}

export interface GenerateResponse { status: number; body: Record<string, unknown> }

/** The whole "given a parsed request body and a provider, produce a response" pipeline as one
 *  pure(ish), dependency-injectable async function - the real POST handler calls it with the
 *  real getWriterProvider(); tests call it with a stub WriterProvider to exercise every
 *  provider outcome (timeout/401/429/5xx/malformed/empty/success) without ever needing a real
 *  network call or a real API key. Mirrors the same DI pattern askLibrary() already uses for
 *  its AnswerProvider (src/services/rag/service.ts).
 *
 *  F10: only a `WriterProviderError`'s own message (always hand-authored in
 *  scientific-writer-provider.ts, safe to show) ever reaches the client. Any other exception -
 *  including an arbitrary Error thrown by a misbehaving/injected provider, or an unexpected bug
 *  elsewhere in this pipeline - is logged server-side with full detail and answered with one
 *  fixed, neutral message; its `.message`/stack is never forwarded. */
export async function handleGenerate(raw: unknown, provider: WriterProvider): Promise<GenerateResponse> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: { error: 'Неверный формат запроса.' } };

  let input: ScientificWriterInput;
  try {
    input = parseInput(raw as Record<string, unknown>);
    validateInput(input);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : 'Некорректные данные.', code: 'invalid_request' } };
  }

  const evidence = buildEvidenceReport(input);
  if (!provider.configured()) return { status: 503, body: { error: 'Генерация текста не настроена: добавьте OPENAI_API_KEY.', code: 'not_configured' } };

  try {
    const prompt = buildGenerationPrompt(input, evidence);
    const result = await provider.generate(prompt);
    const isRewriteLike = REWRITE_LIKE_MODES.includes(input.mode);
    const preservation = isRewriteLike && input.sourceText ? checkPreservation(input.sourceText, result.text) : null;
    const changes = isRewriteLike && input.sourceText ? summarizeChanges(input.sourceText, result.text) : null;
    const warnings = buildSafetyWarnings(input, result.text, preservation);
    return { status: 200, body: { generatedText: result.text, evidence, preservation, changes, warnings, providerId: provider.id } };
  } catch (error) {
    if (error instanceof WriterProviderError) {
      // Tagged with `error.kind` so the client can distinguish a transient outage
      // ('unavailable', worth retrying) from a non-transient failure ('error', e.g. bad
      // credentials or a malformed/empty response - retrying the same request won't help).
      return { status: error.kind === 'not_configured' ? 503 : 502, body: { error: error.message, code: error.kind } };
    }
    console.error('[scientific-writer] internal error:', error);
    return { status: 502, body: { error: 'Не удалось сформировать текст.', code: 'error' } };
  }
}
