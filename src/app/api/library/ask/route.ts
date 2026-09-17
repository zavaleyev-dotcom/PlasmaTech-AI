import { NextResponse } from 'next/server';
import { isLocalLibraryRequest } from '@/services/local-library/http';
import { askLibrary } from '@/services/rag/service';
import { RagValidationError } from '@/services/rag/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const MAX_BODY_BYTES = 8192;
export async function POST(request: Request) {
  if (!isLocalLibraryRequest(request) || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  try {
    // Bound reads even when Content-Length is missing or dishonest.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Введите вопрос.' }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return json({ error: 'Запрос слишком большой.' }, 413); }
      chunks.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json({ error: 'Неверный формат запроса.' }, 400); }
    return json(await askLibrary(input));
  } catch (error) {
    if (error instanceof RagValidationError) return json({ error: error.message }, 400);
    return json({ error: 'Не удалось обработать вопрос.' }, 503);
  }
}
