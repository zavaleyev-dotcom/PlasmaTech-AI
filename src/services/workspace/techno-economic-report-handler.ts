/** The request handler of the Techno-Economic report export. It lives here (not in route.ts, which may only export the HTTP methods) so a test can inject a
 *  failing renderer and check that an internal failure never reaches the user in detail. */

import 'server-only';
import { prepareTeaReport, renderTeaReport, parseExportFormat, CONTENT_TYPE } from './techno-economic-report-export';
import { ReportInputError } from './techno-economic-report';
import { parseTeaReportRequest } from './techno-economic-report-parse';

type Renderer = typeof renderTeaReport;

const MAX_BODY_BYTES = 1_000_000;

/** Local-only, same-origin check - this route generates a file from client-supplied data and must never be reachable cross-origin or from a remote host
 *  (the same predicate every local API route of the project uses, kept in miniature so this module stays independent of the others). */
function isLocalJsonRequest(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  const origin = request.headers.get('origin');
  const sameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`;
  return sameOrigin && request.headers.get('sec-fetch-site') !== 'cross-site' && !!request.headers.get('content-type')?.startsWith('application/json');
}

const INTERNAL_ERROR = 'Не удалось сформировать файл из-за внутренней ошибки. Повторите попытку; если ошибка повторяется, обратитесь к администратору.';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

/** A header value that cannot carry CRLF/control characters whatever the project title contained. */
function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function handleTeaExport(request: Request, render: Renderer = renderTeaReport): Promise<Response> {
  if (!isLocalJsonRequest(request)) return json({ error: 'Недопустимый локальный запрос.' }, 403);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: 'Пустое тело запроса.' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return json({ error: 'Данные слишком велики для экспорта.' }, 413); }
    chunks.push(value);
  }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return json({ error: 'Неверный формат запроса (ожидался JSON).' }, 400); }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Неверный формат запроса.' }, 400);
  const body = input as Record<string, unknown>;

  // 1) the user's input: unusable data is a 400 with the message of the validation (safe, written for the user)
  let prepared: ReturnType<typeof prepareTeaReport>;
  let format: ReturnType<typeof parseExportFormat>;
  try {
    format = parseExportFormat(body.format);
    prepared = prepareTeaReport(parseTeaReportRequest(body.report));
  } catch (error) {
    if (error instanceof ReportInputError) return json({ error: error.message }, 400);
    console.error('[techno-economic-export] preparing the report failed:', error);
    return json({ error: INTERNAL_ERROR }, 500);
  }

  // 2) rendering: whatever fails here is OUR error (a missing font file, a library fault), never the user's - the details (paths, stack) stay in the server log
  try {
    const buffer = await render(prepared.viewModel, format);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': CONTENT_TYPE[format],
        'Content-Disposition': contentDisposition(prepared.filenameBase(format)),
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[techno-economic-export] rendering failed:', error);
    return json({ error: INTERNAL_ERROR }, 500);
  }
}
