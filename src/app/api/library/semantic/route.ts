import { NextResponse } from 'next/server';
import { isLocalJsonLibraryRequest, isLocalLibraryRequest, readBoundedBody } from '@/services/local-library/http';
import { SEMANTIC_INDEX_SAMPLE_TIERS, getSemanticIndexInfo, startSemanticIndex, stopSemanticIndex } from '@/services/rag/semantic-index';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!isLocalLibraryRequest(request)) return json({ error: 'Доступ только с локального компьютера.' }, 403);
  try { return json(await getSemanticIndexInfo()); }
  catch { return json({ error: 'Не удалось получить статус семантического индекса.' }, 503); }
}

/** The whole request is `{"sampleSize": 200|2000|10000, "confirmExternal": true|false}` - well under 100 bytes. 1 KiB leaves room for whitespace and nothing else. */
const MAX_BODY_BYTES = 1024;
const ALLOWED_FIELDS: readonly string[] = ['sampleSize', 'confirmExternal'];

export async function POST(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  // Bounded BEFORE any JSON parsing and before anything is opened or started - also for streamed bodies that carry no (or a dishonest) Content-Length.
  const read = await readBoundedBody(request, MAX_BODY_BYTES);
  if (!read.ok) return read.reason === 'too_large' ? json({ error: 'Запрос слишком большой.' }, 413) : json({ error: 'Пустое тело запроса.' }, 400);
  let body: unknown;
  try { body = JSON.parse(read.text); } catch { return json({ error: 'Неверный формат запроса.' }, 400); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Неверный формат запроса.' }, 400);
  const data = body as Record<string, unknown>;
  if (Object.keys(data).some(key => !ALLOWED_FIELDS.includes(key))) return json({ error: 'Неверный формат запроса: неизвестные поля.' }, 400);
  const sampleSize = data.sampleSize;
  if (typeof sampleSize !== 'number' || !SEMANTIC_INDEX_SAMPLE_TIERS.includes(sampleSize as never)) {
    return json({ error: `Допустимый объём индексирования: ${SEMANTIC_INDEX_SAMPLE_TIERS.join(', ')} фрагментов.` }, 400);
  }
  if (data.confirmExternal !== undefined && typeof data.confirmExternal !== 'boolean') return json({ error: 'Неверный формат запроса.' }, 400);
  const confirmExternal = data.confirmExternal === true;
  try {
    const result = await startSemanticIndex({ sampleSize, confirmExternal });
    if (!result.ok) {
      const status = result.reason === 'already_running' ? 409 : result.reason === 'confirmation_required' ? 400 : result.reason === 'not_configured' ? 409 : 400;
      return json({ error: result.message, reason: result.reason }, status);
    }
    return json({ started: true }, 202);
  } catch { return json({ error: 'Не удалось запустить индексирование.' }, 503); }
}

export async function DELETE(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  try { return json(await stopSemanticIndex()); }
  catch { return json({ error: 'Не удалось остановить индексирование.' }, 503); }
}
