import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { searchPublications } from '@/services/scientific-search';
import { ScientificSearchError } from '@/services/scientific-search/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Anonymous per-browser context that continuation tokens are bound to. The app has no user
// accounts, so this random id (no personal data) is what stops one client replaying another's
// token. httpOnly + SameSite=Strict + scoped to this API; Secure whenever the request is HTTPS.
const CLIENT_COOKIE = 'sf_ctx';
const CLIENT_ID_PATTERN = /^[0-9a-f-]{36}$/;

function readClientId(request: Request): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name === CLIENT_COOKIE && CLIENT_ID_PATTERN.test(value)) return value;
  }
  return undefined;
}

export async function POST(request: Request) {
  const existingClientId = readClientId(request);
  const clientId = existingClientId ?? randomUUID();
  const respond = (body: unknown, status: number) => {
    const response = NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!existingClientId) {
      const https = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
      response.cookies.set(CLIENT_COOKIE, clientId, { httpOnly: true, sameSite: 'strict', secure: https, path: '/api/scifinder' });
    }
    return response;
  };
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
    return respond(await searchPublications(input, { clientId }), 200);
  } catch (error) {
    const failure = error instanceof ScientificSearchError ? error :
      new ScientificSearchError('INTERNAL_ERROR', 'Не удалось выполнить поиск. Попробуйте ещё раз.', 500, true);
    return respond({ error: { code: failure.code, message: failure.message, retryable: failure.retryable } }, failure.status);
  }
}
