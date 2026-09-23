import { getWriterProvider } from '@/services/workspace/scientific-writer-provider';
import { handleGenerate } from '@/services/workspace/scientific-writer-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 300_000;

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

  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json({ error: 'Неверный формат запроса (ожидался JSON).' }, 400); }

  const { status, body } = await handleGenerate(raw, getWriterProvider());
  return json(body, status);
}
