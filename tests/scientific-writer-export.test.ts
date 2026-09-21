import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { listZipEntries, readZipEntryText } from './helpers/zip-reader';
import {
  DOCUMENT_TYPES, buildScientificDocumentViewModel, buildExportFilename, validateExportRequest,
  parseExportRequest, parseExportFormat, exportScientificDocument,
  type ScientificExportRequest, type DocumentType,
} from '../src/services/workspace/scientific-writer-export';

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

// A single, fixed, artificial set of facts - used across every test in this file, per the
// task's own example. Nothing beyond these facts is ever asserted as a "real experimental
// result" - this is fabricated test data, never presented as a real publication.
const ALTIN_FACTS = {
  substrate: 'HSS (high-speed steel)',
  coating: 'AlTiN',
  temperature: '400 °C',
  time: '60 min',
  thickness: '2.5 µm',
};

function altinRequest(documentType: DocumentType, overrides: Partial<ScientificExportRequest> = {}): ScientificExportRequest {
  return {
    documentType,
    title: 'Magnetron deposition of AlTiN coating on high-speed steel',
    generatedByAI: false,
    sections: [
      { heading: 'Title', text: 'Magnetron deposition of AlTiN coating on high-speed steel' },
      { heading: 'Abstract', text: `Substrate: ${ALTIN_FACTS.substrate}. Coating: ${ALTIN_FACTS.coating}. Substrate temperature: ${ALTIN_FACTS.temperature}. Deposition time: ${ALTIN_FACTS.time}. Coating thickness: ${ALTIN_FACTS.thickness}.` },
      { heading: 'Keywords', text: 'AlTiN, PVD, magnetron, HSS' },
      { heading: 'Introduction', text: 'Недостаточно данных' },
      { heading: 'Materials and Methods', text: `Substrate material: ${ALTIN_FACTS.substrate}. Deposition performed via magnetron PVD at substrate temperature ${ALTIN_FACTS.temperature} for ${ALTIN_FACTS.time}.` },
      { heading: 'Results', text: `Coating thickness measured at ${ALTIN_FACTS.thickness}.` },
      { heading: 'Discussion', text: 'Недостаточно данных' },
      { heading: 'Conclusion', text: 'Недостаточно данных' },
    ],
    providedFields: ['Название/тема', 'Основные результаты'],
    missingFields: ['Выводы'],
    warnings: [],
    ...overrides,
  };
}

// ---------- all 6 document types x both formats: real file generation + structural checks ----------

for (const documentType of DOCUMENT_TYPES) {
  test(`exportScientificDocument: ${documentType} DOCX is a real, non-empty OpenXML/ZIP file with Cyrillic-safe text`, async () => {
    const { buffer, filename, contentType } = await exportScientificDocument(altinRequest(documentType), 'docx');
    assert.ok(buffer.length > 0);
    assert.equal(contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(filename.endsWith('.docx'));
    assert.equal(buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04', 'a .docx must be a real ZIP container');
    const entries = listZipEntries(buffer);
    assert.ok(entries.includes('[Content_Types].xml'));
    assert.ok(entries.includes('word/document.xml'));
    const xml = readZipEntryText(buffer, 'word/document.xml');
    assert.ok(xml.includes('AlTiN'));
  });

  test(`exportScientificDocument: ${documentType} PDF is a real, non-empty PDF with a correct signature and extractable text`, async () => {
    const { buffer, filename, contentType } = await exportScientificDocument(altinRequest(documentType), 'pdf');
    assert.ok(buffer.length > 0);
    assert.equal(contentType, 'application/pdf');
    assert.ok(filename.endsWith('.pdf'));
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
    const text = await extractPdfText(buffer);
    assert.ok(text.includes('AlTiN'));
  });
}

// ---------- preservation of scientific values (item 6/14) ----------

test('DOCX export preserves 400 °C, 60 min, and 2.5 µm exactly, in both the XML and extractable content', async () => {
  const { buffer } = await exportScientificDocument(altinRequest('article'), 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  for (const token of ['400', '60', '2.5', 'AlTiN', 'HSS']) assert.ok(xml.includes(token), `expected DOCX to contain: ${token}`);
});

test('PDF export preserves 400 °C, 60 min, and 2.5 µm exactly, in extractable text', async () => {
  const { buffer } = await exportScientificDocument(altinRequest('article'), 'pdf');
  const text = await extractPdfText(buffer);
  for (const token of ['400', '60', '2.5', 'AlTiN', 'HSS']) assert.ok(text.includes(token), `expected PDF to contain: ${token}`);
});

test('Cyrillic and Unicode text survive DOCX/PDF export unaltered', async () => {
  const request = altinRequest('technical_report', { sections: [
    { heading: 'Общие сведения', text: 'Покрытие AlTiN нанесено методом магнетронного распыления на подложку из быстрорежущей стали (HSS).' },
  ] });
  const docx = await exportScientificDocument(request, 'docx');
  const xml = readZipEntryText(docx.buffer, 'word/document.xml');
  assert.ok(xml.includes('быстрорежущей стали'));
  const pdf = await exportScientificDocument(request, 'pdf');
  const text = await extractPdfText(pdf.buffer);
  assert.ok(text.includes('AlTiN'));
});

// ---------- missing data stays honest (item 4) ----------

test('a section reported as "Недостаточно данных" is exported verbatim, never silently filled in', async () => {
  const { buffer } = await exportScientificDocument(altinRequest('article'), 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(xml.includes('Недостаточно') || xml.includes('&#1053;&#1077;&#1076;'), 'expected the missing-data placeholder to appear literally');
});

// ---------- no invented references/DOI (item 7) ----------

test('no invented references/DOI/authors/journals: the exported document never contains a bibliography section or DOI unless the request itself provided one', async () => {
  const { buffer } = await exportScientificDocument(altinRequest('article'), 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(!/\b10\.\d{4,9}\/\S+/.test(xml), 'must never contain a DOI pattern that was not in the request');
  assert.ok(!/references|bibliography|литература/i.test(xml));
});

// ---------- view model / filename / validation (pure logic) ----------

test('buildScientificDocumentViewModel: marks AI-generated vs local-scaffold origin honestly, and carries provided/missing/warnings through to traceability', () => {
  const aiRequest = altinRequest('article', { generatedByAI: true, warnings: ['Обнаружены числа, не подтверждённые пользователем: 9999.'] });
  const viewModel = buildScientificDocumentViewModel(aiRequest);
  assert.ok(viewModel.metadata.some(m => m.value.includes('сгенерировано ИИ')));
  assert.ok(viewModel.traceability.some(t => t.value.includes('9999')));

  const scaffoldRequest = altinRequest('article', { generatedByAI: false });
  const scaffoldViewModel = buildScientificDocumentViewModel(scaffoldRequest);
  assert.ok(scaffoldViewModel.metadata.some(m => m.value.includes('локальная структура')));
});

test('buildExportFilename: sanitizes the title and uses the correct per-type segment', () => {
  const request = altinRequest('conference_abstract', { title: 'Some/Weird\\Title:With*Bad?Chars' });
  const filename = buildExportFilename(request, 'pdf');
  assert.ok(!/[\\/:*?"<>|]/.test(filename));
  assert.ok(filename.endsWith('conference-abstract.pdf'));
});

test('buildExportFilename: path traversal in the title cannot escape the filename', () => {
  const request = altinRequest('article', { title: '../../../etc/passwd' });
  const filename = buildExportFilename(request, 'docx');
  assert.ok(!filename.includes('..'));
  assert.ok(!filename.includes('/'));
});

test('validateExportRequest: rejects an empty result (no sections, or every section says "Недостаточно данных")', () => {
  assert.throws(() => validateExportRequest(altinRequest('article', { sections: [] })), /Нет данных для экспорта/);
  assert.throws(() => validateExportRequest(altinRequest('article', { sections: [
    { heading: 'Title', text: 'Недостаточно данных' }, { heading: 'Abstract', text: 'Недостаточно данных' },
  ] })), /Нет данных для экспорта/);
  assert.doesNotThrow(() => validateExportRequest(altinRequest('article')));
});

// ---------- server-side parsing of untrusted JSON ----------

test('parseExportRequest: rejects an invalid document type', () => {
  assert.throws(() => parseExportRequest({ documentType: 'bogus', sections: [] }), /Тип документа/);
});

test('parseExportRequest: rejects an oversized sections array and an oversized section text', () => {
  const tooManySections = { documentType: 'article', sections: Array.from({ length: 21 }, (_, i) => ({ heading: `S${i}`, text: 'x' })) };
  assert.throws(() => parseExportRequest(tooManySections), /Разделы/);
  const tooLongText = { documentType: 'article', sections: [{ heading: 'S', text: 'a'.repeat(20_001) }] };
  assert.throws(() => parseExportRequest(tooLongText), /слишком длинный/);
});

test('parseExportRequest: never spreads untrusted properties into the request (prototype-pollution safe)', () => {
  const raw = JSON.parse('{"documentType":"article","sections":[{"heading":"S","text":"t"}],"__proto__":{"polluted":true}}');
  const request = parseExportRequest(raw);
  assert.equal((request as unknown as { polluted?: boolean }).polluted, undefined);
  assert.equal(({} as unknown as { polluted?: boolean }).polluted, undefined, 'global Object.prototype must stay clean');
});

test('parseExportFormat: rejects an unsupported format', () => {
  assert.throws(() => parseExportFormat('xlsx'), /Формат файла/);
  assert.equal(parseExportFormat('docx'), 'docx');
  assert.equal(parseExportFormat('pdf'), 'pdf');
});
