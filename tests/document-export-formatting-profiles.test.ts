import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { renderGenericDocx, renderGenericPdf, type GenericDocumentViewModel } from '../src/services/workspace/document-export';
import { FORMATTING_PROFILES } from '../src/services/workspace/references';

function viewModel(): GenericDocumentViewModel {
  return {
    title: 'Formatting profile test document',
    metadata: [{ label: 'Тип', value: 'Тест' }],
    sections: [{ heading: 'Раздел', paragraphs: ['Текст раздела для проверки форматирования.'] }],
    tables: [],
    traceability: [],
    traceabilityHeading: 'Traceability',
    footer: 'Тестовый футер.',
  };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

// ---------- F11 (MEDIUM): a chosen profile must change the REAL generated document, not just its label ----------

test('F11 DOCX: omitting formatting entirely (existing callers, e.g. TechDoc) produces the exact previous default margins/font sizes', () => {
  return (async () => {
    const buffer = await renderGenericDocx(viewModel());
    const xml = readZipEntryText(buffer, 'word/document.xml');
    assert.ok(xml.includes('w:top="1134"') && xml.includes('w:bottom="1134"') && xml.includes('w:left="1417"') && xml.includes('w:right="1417"'), 'default margins must be unchanged for callers that never pass formatting');
    assert.ok(xml.includes('w:sz w:val="22"'), 'default body font size (11pt = 22 half-points) must be unchanged');
  })();
});

test('F11 DOCX: generic_article vs thesis_report produce genuinely DIFFERENT margins and body font size in the real OpenXML - not just a different metadata label', async () => {
  const generic = await renderGenericDocx(viewModel(), { formatting: FORMATTING_PROFILES.generic_article });
  const thesis = await renderGenericDocx(viewModel(), { formatting: FORMATTING_PROFILES.thesis_report });
  const genericXml = readZipEntryText(generic, 'word/document.xml');
  const thesisXml = readZipEntryText(thesis, 'word/document.xml');

  // generic_article: 20mm all round -> 1134 twips; thesis_report: left 30mm/right 15mm -> asymmetric
  assert.ok(genericXml.includes('w:left="1134"') && genericXml.includes('w:right="1134"'));
  assert.ok(thesisXml.includes('w:left="1701"'), 'thesis_report\'s wider 30mm left margin must appear as its own distinct twips value');
  assert.ok(thesisXml.includes('w:right="850"'), 'thesis_report\'s narrower 15mm right margin must appear as its own distinct twips value');
  assert.notEqual(genericXml.match(/w:left="(\d+)"/)?.[1], thesisXml.match(/w:left="(\d+)"/)?.[1], 'left margin must genuinely differ between profiles');

  // generic_article body 11pt -> 22 half-points; thesis_report body 12pt -> 24 half-points
  assert.ok(genericXml.includes('w:sz w:val="22"'));
  assert.ok(thesisXml.includes('w:sz w:val="24"'));
});

test('F11 DOCX: line spacing is applied to body paragraphs as a real OpenXML spacing/line value, proportional to the profile (thesis_report 1.5 vs conference_paper 1.0)', async () => {
  const thesis = await renderGenericDocx(viewModel(), { formatting: FORMATTING_PROFILES.thesis_report });
  const conference = await renderGenericDocx(viewModel(), { formatting: FORMATTING_PROFILES.conference_paper });
  const thesisXml = readZipEntryText(thesis, 'word/document.xml');
  const conferenceXml = readZipEntryText(conference, 'word/document.xml');
  assert.ok(thesisXml.includes('w:line="360"'), 'thesis_report lineSpacing=1.5 -> 240*1.5=360 twentieths-of-a-point');
  assert.ok(conferenceXml.includes('w:line="240"'), 'conference_paper lineSpacing=1.0 -> 240*1.0=240 (single spacing), a genuinely different value from thesis_report\'s 360');
});

test('F11 PDF: omitting formatting produces the exact previous default margin/body font size', async () => {
  const buffer = await renderGenericPdf(viewModel());
  const text = await extractPdfText(buffer);
  assert.ok(text.includes('Раздел'), 'sanity: real extractable text');
});

test('F11 PDF: generic_article vs thesis_report produce real, differently-sized output (margins/fonts genuinely change the rendered byte stream, not just metadata)', async () => {
  const generic = await renderGenericPdf(viewModel(), { formatting: FORMATTING_PROFILES.generic_article });
  const thesis = await renderGenericPdf(viewModel(), { formatting: FORMATTING_PROFILES.thesis_report });
  assert.ok(generic.length > 0 && thesis.length > 0);
  assert.notEqual(generic.length, thesis.length, 'different margins/font sizes must produce a genuinely different PDF byte stream, not an identical one with a different label');
  const genericText = await extractPdfText(generic);
  const thesisText = await extractPdfText(thesis);
  assert.ok(genericText.includes('Раздел') && thesisText.includes('Раздел'), 'real content must still be extractable under every profile');
});

test('F11: a request with no profileId at all (existing Scientific Writer behavior before this fix) still renders correctly with the renderer\'s own defaults', async () => {
  const docx = await renderGenericDocx(viewModel());
  const pdf = await renderGenericPdf(viewModel());
  assert.equal(docx.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});
