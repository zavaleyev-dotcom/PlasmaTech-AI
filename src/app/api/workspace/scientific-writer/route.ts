import {
  validateInput, buildEvidenceReport, buildGenerationPrompt, checkPreservation, summarizeChanges, buildSafetyWarnings,
  WRITER_MODES, type ScientificWriterInput, type WriterMode,
} from '@/services/workspace/scientific-writer';
import { getWriterProvider, WriterProviderError, type WriterProvider } from '@/services/workspace/scientific-writer-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 300_000;
const REWRITE_LIKE_MODES: readonly WriterMode[] = ['rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'];

/** Local-only, same-origin check - mirrors the same predicate every other local API route in
 *  this project uses (see src/services/local-library/http.ts), duplicated here in miniature so
 *  this workspace module stays independent of the Library feature's files. */
function isLocalJsonRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  const sameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`;
  return sameOrigin && request.headers.get('sec-fetch-site') !== 'cross-site'
    && !!request.headers.get('content-type')?.startsWith('application/json');
}

function isLocalRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  return (!origin || origin === `http://${host}` || origin === `https://${host}`) && request.headers.get('sec-fetch-site') !== 'cross-site';
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!isLocalRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  const provider = getWriterProvider();
  return json({ configured: provider.configured(), providerId: provider.id });
}

export interface GenerateResponse { status: number; body: Record<string, unknown> }

/** The whole "given a parsed request body and a provider, produce a response" pipeline as one
 *  pure(ish), dependency-injectable async function - the real POST handler calls it with the
 *  real getWriterProvider(); tests call it with a stub WriterProvider to exercise every
 *  provider outcome (timeout/401/429/5xx/malformed/empty/success) without ever needing a real
 *  network call or a real API key. Mirrors the same DI pattern askLibrary() already uses for
 *  its AnswerProvider (src/services/rag/service.ts). */
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
    // Never forward the raw provider response or a stack trace - only our own safe message
    // strings, tagged with `error.kind` so the client can distinguish a transient outage
    // ('unavailable', worth retrying) from a non-transient failure ('error', e.g. bad
    // credentials or a malformed/empty response - retrying the same request won't help).
    const kind = error instanceof WriterProviderError ? error.kind : 'error';
    const message = error instanceof Error ? error.message : 'Не удалось сформировать текст.';
    return { status: kind === 'not_configured' ? 503 : 502, body: { error: message, code: kind } };
  }
}

export async function POST(request: Request) {
  if (!isLocalJsonRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);

  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Пустое тело запроса.' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return json({ error: 'Запрос слишком большой.' }, 413); }
    chunks.push(value);
  }

  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json({ error: 'Неверный формат запроса (ожидался JSON).' }, 400); }

  const { status, body } = await handleGenerate(raw, getWriterProvider());
  return json(body, status);
}

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
