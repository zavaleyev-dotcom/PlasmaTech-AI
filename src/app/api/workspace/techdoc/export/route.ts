import {
  parseTechnicalProcessDocument, parseDocumentType, parseExportFormat, exportTechDoc,
} from '@/services/workspace/techdoc-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 2_000_000;

/** Local-only, same-origin check - this route generates a file from client-supplied document
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
 *  process name contained - `filename` is already sanitized by buildExportFilename, this is
 *  defense in depth against header injection via a crafted process name. */
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
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return json({ error: 'Документ слишком большой для экспорта.' }, 413); }
    chunks.push(value);
  }

  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json({ error: 'Неверный формат запроса (ожидался JSON).' }, 400); }

  if (input === null || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Неверный формат запроса.' }, 400);
  const body = input as Record<string, unknown>;

  try {
    const documentType = parseDocumentType(body.documentType);
    const format = parseExportFormat(body.format);
    const document = parseTechnicalProcessDocument(body.document);
    const { buffer, filename, contentType } = await exportTechDoc(document, documentType, format);
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
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Не удалось сформировать файл.' }, 400);
  }
}
