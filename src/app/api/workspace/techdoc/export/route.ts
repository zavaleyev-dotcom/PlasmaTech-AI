import { validateDocument } from '@/services/workspace/techdoc-assistant';
import { UnsupportedSchemaVersionError } from '@/services/workspace/techdoc-schema';
import { MigrationIntegrityError } from '@/services/workspace/techdoc-migrate';
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

/** The message of an input-validation failure, or a fixed sentence when the exception is not a plain hand-authored Error. */
function userInputMessage(error: unknown): string {
  const authored = error instanceof UnsupportedSchemaVersionError || error instanceof MigrationIntegrityError || (error instanceof Error && error.constructor === Error);
  return authored && error instanceof Error && error.message.length > 0 && error.message.length <= 500 ? error.message : 'Некорректные данные документа.';
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

  // 1) The user's input: parsing and validation throw hand-authored Russian messages about the data the user sent. Those are 4xx and are shown, but only when they really are
  //    such a message (a plain Error or one of the two documented migration errors, of moderate length) - a TypeError or any other bug-shaped exception is never forwarded.
  let documentType: ReturnType<typeof parseDocumentType>;
  let format: ReturnType<typeof parseExportFormat>;
  let document: ReturnType<typeof parseTechnicalProcessDocument>;
  try {
    documentType = parseDocumentType(body.documentType);
    format = parseExportFormat(body.format);
    document = parseTechnicalProcessDocument(body.document);
    validateDocument(document);
  } catch (error) {
    return json({ error: userInputMessage(error) }, 400);
  }

  // 2) The rendering: whatever fails from here on is an internal failure, not the user's mistake. HTTP 500 with one neutral sentence; the exception (which may carry
  //    file paths, a stack or library internals) is logged on the server only and never reaches the client.
  try {
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
    console.error('[techdoc-export] render failed', error);
    return json({ error: 'Не удалось сформировать файл из-за внутренней ошибки. Попробуйте ещё раз.' }, 500);
  }
}
