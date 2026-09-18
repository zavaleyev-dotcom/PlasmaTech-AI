import { NextResponse } from 'next/server';
import { isLocalJsonLibraryRequest } from '@/services/local-library/http';
import { askLibrary } from '@/services/rag/service';
import { processVectorCache } from '@/services/embeddings/cache';
import { processConsistencyCache } from '@/services/rag/consistency-cache';
import { RagValidationError } from '@/services/rag/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const MAX_BODY_BYTES = 8192;
export async function POST(request: Request) {
  if (!isLocalJsonLibraryRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
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
    // The shared, process-wide caches (embeddings/cache.ts, rag/consistency-cache.ts) are
    // only ever wired in HERE - the one real production entry point, never inside
    // askLibrary's own defaults - so that every test calling askLibrary() directly (which
    // never mentions caching) keeps behaving exactly as it did before these caches existed.
    // Purely a performance layer either way.
    return json(await askLibrary(input, { vectorCache: processVectorCache, consistencyCache: processConsistencyCache }));
  } catch (error) {
    if (error instanceof RagValidationError) return json({ error: error.message }, 400);
    return json({ error: 'Не удалось обработать вопрос.' }, 503);
  }
}
