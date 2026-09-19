import {
  validateInput, buildEvidenceReport, buildGenerationPrompt, checkPreservation, summarizeChanges,
  WRITER_MODES, type ScientificWriterInput, type WriterMode,
} from '@/services/workspace/scientific-writer';
import { getWriterProvider } from '@/services/workspace/scientific-writer-provider';

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

  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json({ error: 'Неверный формат запроса (ожидался JSON).' }, 400); }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Неверный формат запроса.' }, 400);
  const raw = body as Record<string, unknown>;

  let input: ScientificWriterInput;
  try {
    input = parseInput(raw);
    validateInput(input);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Некорректные данные.' }, 400);
  }

  const evidence = buildEvidenceReport(input);
  const provider = getWriterProvider();
  if (!provider.configured()) return json({ error: 'Генерация текста не настроена: добавьте OPENAI_API_KEY.', code: 'not_configured' }, 503);

  try {
    const prompt = buildGenerationPrompt(input, evidence);
    const result = await provider.generate(prompt);
    const isRewriteLike = REWRITE_LIKE_MODES.includes(input.mode);
    const preservation = isRewriteLike && input.sourceText ? checkPreservation(input.sourceText, result.text) : null;
    const changes = isRewriteLike && input.sourceText ? summarizeChanges(input.sourceText, result.text) : null;
    return json({ generatedText: result.text, evidence, preservation, changes, providerId: provider.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Не удалось сформировать текст.' }, 502);
  }
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
