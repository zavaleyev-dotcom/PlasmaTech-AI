import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { listZipEntries, readZipEntryText } from './helpers/zip-reader';
import {
  DOCUMENT_TYPES, EXPORT_FORMATS, buildDocumentViewModel, buildExportFilename, sanitizeFilenameSegment,
  exportTechDoc, parseTechnicalProcessDocument, parseDocumentType, parseExportFormat,
} from '../src/services/workspace/techdoc-export';
import {
  createDocumentFromPreset, updateStep, createQualityCheck, toggleStepEnabled, addMagnetron, updateMagnetron, updateGasLine,
  buildTechnologicalCard, buildRouteCard, buildBriefRecipe,
  type TechnicalProcessDocument,
} from '../src/services/workspace/techdoc-assistant';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

function sampleDoc(): TechnicalProcessDocument {
  let doc = createDocumentFromPreset('magnetron-pvd');
  doc = { ...doc, general: { ...doc.general, processName: 'AlTiN_PVD', equipment: 'Установка X', purpose: 'Износостойкое покрытие', documentVersion: 'v1' } };
  doc = { ...doc, steps: updateStep(doc.steps, 6, {
    temperatureC: 350, pressureMbar: 0.005, durationMin: 60,
    gasUsage: [{ gas: 'Ar', flowSccm: 40 }], powerW: 3000, substrateBiasV: -80, notes: 'примечание к этапу',
  }) };
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Толщина покрытия'), method: 'Калотест', criterion: '>= 2 мкм', result: '2.3 мкм', status: 'pass' }] };
  doc = { ...doc, safety: { ...doc.safety, hazards: ['Высокое напряжение'], ppe: ['Очки'], interlocks: [] } };
  return doc;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

// ---------- all 8 document type x format combinations produce real, structurally valid files ----------

for (const documentType of DOCUMENT_TYPES) {
  test(`exportTechDoc: ${documentType} DOCX is a real, non-empty OpenXML/ZIP file containing the process name in Cyrillic-safe text`, async () => {
    const { buffer, filename, contentType } = await exportTechDoc(sampleDoc(), documentType, 'docx');
    assert.ok(buffer.length > 0);
    assert.equal(contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(filename.endsWith('.docx'));
    assert.equal(buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'a .docx must be a real ZIP container');
    const entries = listZipEntries(buffer);
    assert.ok(entries.includes('[Content_Types].xml'));
    assert.ok(entries.includes('word/document.xml'));
    const xml = readZipEntryText(buffer, 'word/document.xml');
    assert.ok(xml.includes('AlTiN_PVD'));
  });

  test(`exportTechDoc: ${documentType} PDF is a real, non-empty PDF with a correct signature and extractable Cyrillic text`, async () => {
    const { buffer, filename, contentType } = await exportTechDoc(sampleDoc(), documentType, 'pdf');
    assert.ok(buffer.length > 0);
    assert.equal(contentType, 'application/pdf');
    assert.ok(filename.endsWith('.pdf'));
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    const text = await extractPdfText(buffer);
    assert.ok(text.includes('AlTiN_PVD'));
  });
}

// ---------- disabled steps excluded (recipe), blank fields stay blank ----------

test('recipe view model excludes disabled steps entirely, and only shows real, entered parameters', () => {
  let doc = sampleDoc();
  doc = { ...doc, steps: toggleStepEnabled(doc.steps, 1) }; // disable "Загрузка"
  const viewModel = buildDocumentViewModel(doc, 'recipe');
  const text = viewModel.sections[0].paragraphs.join('\n');
  assert.ok(!text.includes('Загрузка'));
  assert.ok(text.includes('Основное покрытие'));
  assert.ok(text.includes('T: 350'));
});

function blankPecvdDoc(): TechnicalProcessDocument {
  // untouched preset (every parameter genuinely absent), only the required process name set
  const doc = createDocumentFromPreset('pecvd');
  return { ...doc, general: { ...doc.general, processName: 'Blank PECVD' } };
}

test('blank optional fields render as "не задано" (prose) or "—" (table cells), never invented', () => {
  const doc = blankPecvdDoc();
  const instructionVm = buildDocumentViewModel(doc, 'instruction');
  const allProse = instructionVm.sections.flatMap(s => s.paragraphs).join('\n');
  assert.ok(allProse.includes('не задано'));
  assert.ok(!allProse.includes('undefined'));
  assert.ok(!allProse.includes('NaN'));

  const cardVm = buildDocumentViewModel(doc, 'technologicalCard');
  const allCells = cardVm.tables[0].rows.flat().join('|');
  assert.ok(allCells.includes('—'));
  assert.ok(!allCells.includes('undefined'));
});

test('instruction completeness (Codex regression): document-level sources (magnetrons/arc/ICP/ion) and the gas system actually appear in the exported instruction, not just per-step free text', () => {
  let doc = sampleDoc();
  doc = { ...doc, sources: addMagnetron(doc.sources) };
  doc = { ...doc, sources: updateMagnetron(doc.sources, doc.sources.magnetrons[0].id, { material: 'Ti', powerW: 3000, mode: 'DC' }) };
  doc = { ...doc, sources: { ...doc.sources, icpRf: { enabled: true, powerW: 500, biasV: -80 } } };
  doc = { ...doc, gasSystem: updateGasLine(doc.gasSystem, doc.gasSystem[0].id, { gas: 'Ar', flow: 40, enabled: true }) };
  const vm = buildDocumentViewModel(doc, 'instruction');
  const allText = vm.sections.map(s => s.paragraphs.join(' ')).join('\n');
  assert.ok(allText.includes('Ti'), 'magnetron material must appear in the exported instruction');
  assert.ok(allText.includes('3000'), 'magnetron power must appear in the exported instruction');
  assert.ok(allText.includes('-80'), 'ICP/RF bias must appear in the exported instruction');
  assert.ok(allText.includes('Ar'), 'configured gas must appear in the exported instruction');
});

// ---------- quality checks ----------

test('quality checks: instruction view model includes a table only when checks exist, with "—" for unset fields', () => {
  const withoutChecks = buildDocumentViewModel(blankPecvdDoc(), 'instruction');
  assert.equal(withoutChecks.tables.length, 0);
  assert.ok(withoutChecks.sections.find(s => s.heading.startsWith('8.'))!.paragraphs[0] === 'не задано');

  let doc = blankPecvdDoc();
  doc = { ...doc, qualityChecks: [createQualityCheck('Адгезия')] }; // no method/criterion/result/status entered
  const withChecks = buildDocumentViewModel(doc, 'instruction');
  assert.equal(withChecks.tables.length, 1);
  assert.deepEqual(withChecks.tables[0].columns, ['Параметр', 'Метод', 'Критерий', 'Единица', 'Результат', 'Статус']);
  assert.deepEqual(withChecks.tables[0].rows[0], ['Адгезия', 'не задано', 'не задано', 'не задано', 'не задано', 'не задано']);
});

// ---------- traceability ----------

test('traceability is carried into every document type, with the numbered heading reserved for the instruction', () => {
  const doc = sampleDoc();
  const instructionVm = buildDocumentViewModel(doc, 'instruction');
  assert.equal(instructionVm.traceabilityHeading, '10. Traceability / версия документа');
  assert.equal(instructionVm.traceability.version, String(doc.traceability.version));
  assert.equal(instructionVm.traceability.createdAt, doc.traceability.createdAt);
  assert.ok(instructionVm.traceability.source.includes('magnetron-pvd'));

  const recipeVm = buildDocumentViewModel(doc, 'recipe');
  assert.equal(recipeVm.traceabilityHeading, 'Traceability');
  assert.equal(recipeVm.traceability.version, instructionVm.traceability.version);
});

// ---------- preview/export consistency (item 16): both read the SAME underlying data ----------

test('preview/export consistency: the technological-card and route-card view models are built from the exact same rows the on-screen preview renders', () => {
  const doc = sampleDoc();
  const previewTechCard = buildTechnologicalCard(doc);
  const exportTechCard = buildDocumentViewModel(doc, 'technologicalCard').tables[0].rows;
  assert.deepEqual(exportTechCard, previewTechCard.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sourcePower, r.bias, r.control, r.note]));

  const previewRouteCard = buildRouteCard(doc);
  const exportRouteCard = buildDocumentViewModel(doc, 'routeCard').tables[0].rows;
  assert.deepEqual(exportRouteCard, previewRouteCard.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output, r.control, r.note]));
});

test('preview/export consistency: the recipe view model is built from the exact same lines the on-screen preview renders', () => {
  const doc = sampleDoc();
  const previewLines = buildBriefRecipe(doc).split('\n').slice(1);
  const exportLines = buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs;
  assert.deepEqual(exportLines, previewLines);
});

test('buildDocumentViewModel is deterministic - the same document produces a deep-equal view model on every call', () => {
  const doc = sampleDoc();
  assert.deepEqual(buildDocumentViewModel(doc, 'instruction'), buildDocumentViewModel(doc, 'instruction'));
  assert.deepEqual(buildDocumentViewModel(doc, 'technologicalCard'), buildDocumentViewModel(doc, 'technologicalCard'));
});

// ---------- filename: pattern, sanitization, Cyrillic preservation, path traversal, header injection ----------

test('buildExportFilename: follows <process-name>_<document-type>_<version>.<ext> and preserves Cyrillic', () => {
  const doc = sampleDoc();
  assert.equal(buildExportFilename(doc, 'technologicalCard', 'docx'), `AlTiN_PVD_technology-card_v${doc.traceability.version}.docx`);
  assert.equal(buildExportFilename(doc, 'recipe', 'pdf'), `AlTiN_PVD_recipe_v${doc.traceability.version}.pdf`);
  const cyrillicDoc = { ...doc, general: { ...doc.general, processName: 'АлТиН_нитрид' } };
  assert.ok(buildExportFilename(cyrillicDoc, 'instruction', 'docx').includes('нитрид'));
});

test('sanitizeFilenameSegment: strips slashes, backslashes, colons, control characters, and path traversal sequences', () => {
  assert.ok(!sanitizeFilenameSegment('a/b\\c:d*e?f"g<h>i|j', 'x').match(/[\\/:*?"<>|]/));
  assert.ok(!sanitizeFilenameSegment('../../etc/passwd', 'x').includes('..'));
  assert.ok(!/[\x00-\x1f\x7f]/.test(sanitizeFilenameSegment('name\r\nEvil-Header: 1', 'x')));
  assert.equal(sanitizeFilenameSegment('   ', 'fallback'), 'fallback');
  assert.ok(sanitizeFilenameSegment('a'.repeat(500), 'x').length <= 60);
});

test('no header injection: a process name containing CRLF and quotes never reaches the Content-Disposition header raw', async () => {
  const doc = { ...sampleDoc(), general: { ...sampleDoc().general, processName: 'Evil"\r\nX-Injected: yes\r\nName' } };
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, documentType: 'recipe', format: 'docx' }),
  }));
  assert.equal(response.status, 200);
  // The header must stay a single, well-formed value - no raw CRLF that could start a second
  // header line. The literal words from the process name surviving as inert filename TEXT
  // (no colon-newline forming an actual extra header) is fine and expected.
  const disposition = response.headers.get('Content-Disposition') ?? '';
  assert.ok(disposition.length > 0);
  assert.ok(!disposition.includes('\r') && !disposition.includes('\n'));
  assert.equal(response.headers.get('X-Injected'), null, 'no second header must have been smuggled in');
});

// ---------- server-side re-validation of untrusted input ----------

test('the full export pipeline rejects a missing/empty process name (structural parsing accepts it, but validateDocument catches it before anything renders)', async () => {
  const parsed = parseTechnicalProcessDocument({ general: { processName: '' } });
  assert.equal(parsed.general.processName, '');
  await assert.rejects(() => exportTechDoc(parsed, 'recipe', 'docx'), /Название процесса/);

  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: { general: { processName: '' } }, documentType: 'recipe', format: 'docx' }),
  }));
  assert.equal(response.status, 400);
});

test('parseTechnicalProcessDocument: rejects unexpectedly long user text instead of accepting it unbounded', () => {
  const raw = { general: { processName: 'X', purpose: 'a'.repeat(6000) } };
  assert.throws(() => parseTechnicalProcessDocument(raw), /слишком длинный/);
});

test('parseTechnicalProcessDocument: rejects an oversized steps array rather than processing it', () => {
  const raw = { general: { processName: 'X' }, steps: Array.from({ length: 500 }, (_, i) => ({ name: `s${i}`, type: 'loading' })) };
  assert.throws(() => parseTechnicalProcessDocument(raw), /слишком много элементов/);
});

test('parseTechnicalProcessDocument: never spreads untrusted properties - a prototype-pollution attempt is silently dropped', () => {
  const raw = JSON.parse('{"general":{"processName":"X","__proto__":{"polluted":true}},"polluted":true}');
  const doc = parseTechnicalProcessDocument(raw);
  assert.equal((doc as unknown as { polluted?: boolean }).polluted, undefined);
  assert.equal(({} as unknown as { polluted?: boolean }).polluted, undefined, 'global Object.prototype must stay clean');
});

test('parseTechnicalProcessDocument: rejects a malformed step (wrong types) with a clear message, not a crash', () => {
  assert.throws(() => parseTechnicalProcessDocument({ general: { processName: 'X' }, steps: [{ name: 123, type: 'loading' }] }), /название/);
  assert.throws(() => parseTechnicalProcessDocument({ general: { processName: 'X' }, steps: [{ name: 'ok', type: 'not-a-real-type' }] }), /тип этапа/);
});

test('parseDocumentType / parseExportFormat: reject any value outside the supported enums', () => {
  assert.throws(() => parseDocumentType('bogus'), /Вид документа/);
  assert.throws(() => parseExportFormat('xlsx'), /Формат файла/);
  for (const documentType of DOCUMENT_TYPES) assert.equal(parseDocumentType(documentType), documentType);
  for (const format of EXPORT_FORMATS) assert.equal(parseExportFormat(format), format);
});

// ---------- export API route: security and error handling ----------

test('the /api/workspace/techdoc/export route rejects non-local requests and requests without a JSON content-type', async () => {
  const crossOrigin = await exportPOST(new Request('http://evil.example/api/workspace/techdoc/export', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }));
  assert.equal(crossOrigin.status, 403);
  const missingContentType = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', { method: 'POST', headers: { host: 'localhost' } }));
  assert.equal(missingContentType.status, 403);
});

test('the export route rejects malformed JSON with a 400, not a crash', async () => {
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: 'not json at all',
  }));
  assert.equal(response.status, 400);
});

test('the export route rejects an unsupported format and an invalid document type before rendering anything', async () => {
  const doc = sampleDoc();
  const badFormat = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, documentType: 'instruction', format: 'xlsx' }),
  }));
  assert.equal(badFormat.status, 400);

  const badType = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, documentType: 'summary', format: 'docx' }),
  }));
  assert.equal(badType.status, 400);
});

test('the export route rejects an oversized request body before ever parsing JSON', async () => {
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: 'a'.repeat(2_000_001),
  }));
  assert.equal(response.status, 413);
});

test('the export route succeeds end-to-end for a valid request, returning correct headers and real file bytes', async () => {
  const doc = sampleDoc();
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: doc, documentType: 'routeCard', format: 'pdf' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.ok(response.headers.get('Content-Disposition')!.includes('route-card'));
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length > 0);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});
