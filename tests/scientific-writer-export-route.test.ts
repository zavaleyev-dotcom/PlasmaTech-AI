import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as exportPOST } from '../src/app/api/workspace/scientific-writer/export/route';
import { handleExport } from '../src/services/workspace/scientific-writer-export';

const validRequest = {
  documentType: 'article',
  title: 'Magnetron deposition of AlTiN coating on high-speed steel',
  generatedByAI: false,
  sections: [
    { heading: 'Abstract', text: 'Substrate: HSS. Coating: AlTiN. Temperature: 400 °C. Time: 60 min. Thickness: 2.5 µm.' },
  ],
  providedFields: ['Основные результаты'],
  missingFields: [],
  warnings: [],
};

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/workspace/scientific-writer/export', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------- local-only / content-type ----------

test('rejects non-local requests and requests without a JSON content-type', async () => {
  const crossOrigin = await exportPOST(new Request('http://evil.example/api/workspace/scientific-writer/export', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }));
  assert.equal(crossOrigin.status, 403);
  const missingContentType = await exportPOST(new Request('http://localhost/api/workspace/scientific-writer/export', { method: 'POST', headers: { host: 'localhost' } }));
  assert.equal(missingContentType.status, 403);
});

// ---------- malformed request ----------

test('rejects malformed JSON with a 400, not a crash', async () => {
  const response = await exportPOST(postRequest('not json at all'));
  assert.equal(response.status, 400);
});

test('rejects a non-object body', async () => {
  const response = await exportPOST(postRequest([1, 2, 3]));
  assert.equal(response.status, 400);
});

// ---------- invalid format / document type ----------

test('handleExport: rejects an invalid format', async () => {
  const { status, body } = await handleExport(validRequest, 'xlsx');
  assert.equal(status, 400);
  assert.ok(typeof body?.error === 'string');
});

test('handleExport: rejects an invalid document type', async () => {
  const { status } = await handleExport({ ...validRequest, documentType: 'bogus' }, 'docx');
  assert.equal(status, 400);
});

// ---------- F10: a render-layer failure (font/filesystem/renderer bug) never leaks its message ----------

test('handleExport: a failure inside the actual DOCX/PDF render step never forwards its raw message (e.g. a font/filesystem path)', async () => {
  const throwingExport = async () => { throw new Error("ENOENT: no such file or directory, open '/Volumes/123-All/GitHub/PlasmaTech-AI/node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf'"); };
  const { status, body } = await handleExport(validRequest, 'docx', throwingExport);
  assert.equal(status, 500);
  assert.equal(body?.error, 'Не удалось сформировать файл.');
  assert.ok(!String(body?.error).includes('/node_modules/'), 'a real filesystem path must never reach the client');
});

// ---------- oversized payload ----------

test('rejects an oversized raw request body before ever parsing JSON', async () => {
  const response = await exportPOST(postRequest('a'.repeat(500_001)));
  assert.equal(response.status, 413);
});

test('handleExport: rejects an oversized section text', async () => {
  const { status } = await handleExport({ ...validRequest, sections: [{ heading: 'S', text: 'a'.repeat(20_001) }] }, 'docx');
  assert.equal(status, 400);
});

// ---------- empty result ----------

test('handleExport: rejects an empty result (no sections)', async () => {
  const { status, body } = await handleExport({ ...validRequest, sections: [] }, 'docx');
  assert.equal(status, 400);
  assert.ok((body?.error as string).includes('Нет данных для экспорта'));
});

// ---------- safe filename / path traversal / header injection ----------

test('a path-traversal attempt in the title never escapes the generated filename or Content-Disposition header', async () => {
  const response = await exportPOST(postRequest({ request: { ...validRequest, title: '../../../etc/passwd' }, format: 'docx' }));
  assert.equal(response.status, 200);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  assert.ok(!disposition.includes('..'));
  assert.ok(!disposition.includes('/etc/'));
});

test('a title containing CRLF/quotes never injects a second header or breaks Content-Disposition', async () => {
  const response = await exportPOST(postRequest({ request: { ...validRequest, title: 'Evil"\r\nX-Injected: yes\r\nTitle' }, format: 'pdf' }));
  assert.equal(response.status, 200);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  assert.ok(disposition.length > 0);
  assert.ok(!disposition.includes('\r') && !disposition.includes('\n'));
  assert.equal(response.headers.get('X-Injected'), null, 'no second header must have been smuggled in');
});

// ---------- success end to end ----------

test('a valid request returns 200 with correct headers and real DOCX/PDF bytes', async () => {
  const docxResponse = await exportPOST(postRequest({ request: validRequest, format: 'docx' }));
  assert.equal(docxResponse.status, 200);
  assert.equal(docxResponse.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docxResponse.headers.get('X-Content-Type-Options'), 'nosniff');
  const docxBytes = new Uint8Array(await docxResponse.arrayBuffer());
  assert.equal(Buffer.from(docxBytes.subarray(0, 4)).toString('latin1'), 'PK\x03\x04');

  const pdfResponse = await exportPOST(postRequest({ request: validRequest, format: 'pdf' }));
  assert.equal(pdfResponse.status, 200);
  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
  assert.equal(Buffer.from(pdfBytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});
