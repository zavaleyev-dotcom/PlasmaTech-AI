import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { listZipEntries, readZipEntryText } from './helpers/zip-reader';
import {
  buildScientificDocumentViewModel, exportScientificDocument, parseExportRequest,
  type ScientificExportRequest,
} from '../src/services/workspace/scientific-writer-export';
import type { Reference } from '../src/services/workspace/references';

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

// Synthetic test-only references (item 13) - never used as real bibliographic evidence.
const SYNTHETIC_REFERENCES: Reference[] = [
  { id: 'ref-1', type: 'journal_article', authors: ['Тестов Т.Т.'], title: 'Синтетическая тестовая статья об AlTiN', containerTitle: 'Тестовый журнал', year: 2021, volume: '5', issue: '2', pages: '10-20', doi: '10.1234/synthetic.0001' },
  { id: 'ref-2', type: 'website', authors: [], title: 'Synthetic web source (test data only)', url: 'https://example.test/source' },
];

function baseRequest(overrides: Partial<ScientificExportRequest> = {}): ScientificExportRequest {
  return {
    documentType: 'article',
    title: 'Magnetron deposition of AlTiN coating on high-speed steel',
    generatedByAI: false,
    sections: [
      { heading: 'Abstract', text: 'Coating: AlTiN. Substrate temperature: 400 °C. Deposition time: 60 min. Thickness: 2.5 µm.' },
    ],
    providedFields: ['Основные результаты'],
    missingFields: [],
    warnings: [],
    ...overrides,
  };
}

// ---------- no references = no bibliography section (item 11/12) ----------

test('buildScientificDocumentViewModel: no references means no "Список источников" section at all', () => {
  const viewModel = buildScientificDocumentViewModel(baseRequest());
  assert.equal(viewModel.sections.some(s => s.heading === 'Список источников'), false);
});

test('buildScientificDocumentViewModel: references without a chosen citation style still produce no bibliography section', () => {
  const viewModel = buildScientificDocumentViewModel(baseRequest({ references: SYNTHETIC_REFERENCES }));
  assert.equal(viewModel.sections.some(s => s.heading === 'Список источников'), false);
});

// ---------- bibliography section present + correctly numbered per style ----------

test('buildScientificDocumentViewModel: IEEE style produces a numbered "Список источников" section from real references only', () => {
  const viewModel = buildScientificDocumentViewModel(baseRequest({ references: SYNTHETIC_REFERENCES, citationStyle: 'ieee' }));
  const section = viewModel.sections.find(s => s.heading === 'Список источников');
  assert.ok(section);
  assert.equal(section!.paragraphs.length, 2);
  assert.ok(section!.paragraphs[0].startsWith('[1]'));
  assert.ok(section!.paragraphs[1].startsWith('[2]'));
  assert.ok(section!.paragraphs[0].includes('Тестов Т.Т.'));
  assert.ok(section!.paragraphs[0].includes('10.1234/synthetic.0001'));
  assert.ok(!/undefined/i.test(section!.paragraphs.join(' ')));
});

test('buildScientificDocumentViewModel: GOST-style numbering and metadata label the style honestly as simplified/non-certified', () => {
  const viewModel = buildScientificDocumentViewModel(baseRequest({ references: SYNTHETIC_REFERENCES, citationStyle: 'gost' }));
  const section = viewModel.sections.find(s => s.heading === 'Список источников');
  assert.ok(section!.paragraphs[0].startsWith('1.'));
  const styleMeta = viewModel.metadata.find(m => m.label === 'Стиль оформления ссылок');
  assert.ok(styleMeta?.value.includes('GOST-style'));
  assert.ok(styleMeta?.value.toLocaleLowerCase().includes('не заявлен'));
});

test('buildScientificDocumentViewModel: profile label is included in metadata when a profile is chosen', () => {
  const viewModel = buildScientificDocumentViewModel(baseRequest({ profileId: 'thesis_report' }));
  assert.ok(viewModel.metadata.some(m => m.label === 'Профиль оформления' && m.value === 'Thesis / Report'));
});

test('buildScientificDocumentViewModel: reference-list integrity errors/warnings are surfaced in traceability', () => {
  const badRefs: Reference[] = [
    { id: 'x1', type: 'journal_article', authors: ['A'], title: 'T', doi: 'bad-doi' },
  ];
  const viewModel = buildScientificDocumentViewModel(baseRequest({ references: badRefs, citationStyle: 'apa' }));
  const errorMeta = viewModel.traceability.find(t => t.label.includes('ошибки'));
  assert.ok(errorMeta?.value.includes('Некорректный формат DOI'));
});

// ---------- real DOCX/PDF file generation with references ----------

test('exportScientificDocument: DOCX export with references contains the formatted bibliography, Cyrillic, and the real DOI', async () => {
  const { buffer } = await exportScientificDocument(baseRequest({ references: SYNTHETIC_REFERENCES, citationStyle: 'apa' }), 'docx');
  const entries = listZipEntries(buffer);
  assert.ok(entries.includes('word/document.xml'));
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(xml.includes('Тестов'));
  assert.ok(xml.includes('10.1234/synthetic.0001'));
  assert.ok(xml.includes('Список источников'));
});

test('exportScientificDocument: PDF export with references contains the formatted bibliography and real DOI as extractable text', async () => {
  const { buffer } = await exportScientificDocument(baseRequest({ references: SYNTHETIC_REFERENCES, citationStyle: 'ieee' }), 'pdf');
  const text = await extractPdfText(buffer);
  assert.ok(text.includes('10.1234/synthetic.0001'));
  assert.ok(text.includes('Список источников'));
});

test('exportScientificDocument: with no references, the exported DOCX/PDF contains no bibliography heading and no invented DOI', async () => {
  const docx = await exportScientificDocument(baseRequest(), 'docx');
  const xml = readZipEntryText(docx.buffer, 'word/document.xml');
  assert.ok(!xml.includes('Список источников'));
  assert.ok(!/\b10\.\d{4,9}\/\S+/.test(xml));
});

// ---------- server-side parsing of the new fields (untrusted JSON) ----------

test('parseExportRequest: parses real references/citationStyle/profileId and rejects invalid ones', () => {
  const parsed = parseExportRequest({
    documentType: 'article',
    sections: [{ heading: 'S', text: 't' }],
    references: [{ id: 'a', type: 'book', authors: ['X'], title: 'T' }],
    citationStyle: 'ieee',
    profileId: 'conference_paper',
  });
  assert.equal(parsed.references?.length, 1);
  assert.equal(parsed.citationStyle, 'ieee');
  assert.equal(parsed.profileId, 'conference_paper');

  assert.throws(() => parseExportRequest({ documentType: 'article', sections: [], citationStyle: 'bogus' }), /Стиль оформления ссылок/);
  assert.throws(() => parseExportRequest({ documentType: 'article', sections: [], profileId: 'bogus' }), /Профиль оформления/);
  assert.throws(() => parseExportRequest({ documentType: 'article', sections: [], references: [{ id: 'a', type: 'bogus' }] }), /Источник\[0\]/);
});

test('parseExportRequest: an oversized references array is rejected before parsing each entry', () => {
  const tooMany = { documentType: 'article', sections: [], references: Array.from({ length: 201 }, () => ({ id: 'a', type: 'book', authors: [] })) };
  assert.throws(() => parseExportRequest(tooMany), /Источники/);
});
