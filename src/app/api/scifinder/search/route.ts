import { NextResponse } from 'next/server';
import { searchPublications } from '@/services/scientific-search';
import { ScientificSearchError } from '@/services/scientific-search/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    // Bound reads even when Content-Length is missing or dishonest.
    const reader = request.body?.getReader();
    if (!reader) throw new ScientificSearchError('INVALID_QUERY', 'Пустой поисковый запрос.', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new ScientificSearchError('QUERY_TOO_LARGE', 'Поисковый запрос слишком большой.', 413);
      }
      chunks.push(value);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ScientificSearchError('INVALID_JSON', 'Неверный формат поискового запроса.', 400);
    }
    return NextResponse.json(await searchPublications(input), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = error instanceof ScientificSearchError ? error :
      new ScientificSearchError('INTERNAL_ERROR', 'Не удалось выполнить поиск. Попробуйте ещё раз.', 500, true);
    return NextResponse.json({
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
  }
}
