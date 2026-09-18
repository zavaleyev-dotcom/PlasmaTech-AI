import { NextResponse } from 'next/server';
import { isLocalJsonLibraryRequest, isLocalLibraryRequest } from '@/services/local-library/http';
import { SEMANTIC_INDEX_SAMPLE_TIERS, getSemanticIndexInfo, startSemanticIndex, stopSemanticIndex } from '@/services/rag/semantic-index';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!isLocalLibraryRequest(request)) return json({ error: 'Доступ только с локального компьютера.' }, 403);
  try { return json(await getSemanticIndexInfo()); }
  catch { return json({ error: 'Не удалось получить статус семантического индекса.' }, 503); }
}

export async function POST(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'Неверный формат запроса.' }, 400); }
  const data = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const sampleSize = data.sampleSize;
  if (typeof sampleSize !== 'number' || !SEMANTIC_INDEX_SAMPLE_TIERS.includes(sampleSize as never)) {
    return json({ error: `Допустимый объём индексирования: ${SEMANTIC_INDEX_SAMPLE_TIERS.join(', ')} фрагментов.` }, 400);
  }
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
