import { handleExport } from '@/services/workspace/scientific-writer-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 500_000;

/** Local-only, same-origin check - this route generates a file from client-supplied result
 *  data and must never be reachable cross-origin or from a remote host. Mirrors the same
 *  predicate every other local API route in this project uses (see
 *  src/services/local-library/http.ts), duplicated here in miniature so this workspace module
 *  stays independent of the Library feature's files. */
function isLocalJsonRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  const sameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`;
  return sameOrigin && request.headers.get('sec-fetch-site') !== 'cross-site'
    && !!request.headers.get('content-type')?.startsWith('application/json');
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

/** Builds a header value that cannot carry CRLF/control characters regardless of what the
 *  title contained - `filename` is already sanitized by buildExportFilename, this is defense
 *  in depth against header injection via a crafted title. */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return json({ error: 'Неверный формат запроса.' }, 400);
  const body = raw as Record<string, unknown>;

  const result = await handleExport(body.request, body.format);
  if (!result.file) return json(result.body, result.status);
  const { buffer, filename, contentType } = result.file;
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
