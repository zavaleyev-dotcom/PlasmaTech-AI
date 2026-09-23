import test from 'node:test';
import assert from 'node:assert/strict';
import { readZipEntryText } from './helpers/zip-reader';
import { renderGenericDocx, type GenericDocumentViewModel } from '../src/services/workspace/document-export';

function viewModelWithParagraph(paragraph: string): GenericDocumentViewModel {
  return {
    title: 'Multiline test document',
    metadata: [{ label: 'Тип', value: 'Тест' }],
    sections: [{ heading: 'Раздел', paragraphs: [paragraph] }],
    tables: [],
    traceability: [],
    traceabilityHeading: 'Traceability',
    footer: 'Тестовый футер.',
  };
}

// ---------- F12 (MEDIUM): a single "\n" inside one paragraph must become a real Word line
// break (<w:br/>), not vanish inside one TextRun's text (which Word never renders as a break) ----------

test('F12 DOCX: a single "\\n" inside a paragraph produces a real <w:br/> element in the OpenXML, not a literal newline character inside one run', async () => {
  const buffer = await renderGenericDocx(viewModelWithParagraph('Первая строка.\nВторая строка.'));
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(xml.includes('<w:br/>'), 'the "\\n" must become a real OpenXML line-break element');
  assert.ok(!xml.includes('Первая строка.\nВторая строка.'), 'the raw "\\n" character must never survive as literal text inside a single run');
  assert.ok(xml.includes('Первая строка.') && xml.includes('Вторая строка.'), 'both lines must still be present as real, extractable text');
});

test('F12 DOCX: multiple "\\n" characters produce one <w:br/> per break, in the correct line order', async () => {
  const buffer = await renderGenericDocx(viewModelWithParagraph('Строка А.\nСтрока Б.\nСтрока В.'));
  const xml = readZipEntryText(buffer, 'word/document.xml');
  const breakCount = (xml.match(/<w:br\/>/g) ?? []).length;
  assert.equal(breakCount, 2, 'three lines need exactly two breaks between them');
  const posA = xml.indexOf('Строка А.');
  const posB = xml.indexOf('Строка Б.');
  const posV = xml.indexOf('Строка В.');
  assert.ok(posA > -1 && posB > posA && posV > posB, 'line order must be preserved');
});

test('F12 DOCX: a paragraph with no "\\n" at all renders exactly as before (single TextRun, no spurious breaks)', async () => {
  const buffer = await renderGenericDocx(viewModelWithParagraph('Обычный однострочный текст без разрывов.'));
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(!xml.includes('<w:br/>'), 'a single-line paragraph must never get an unwanted line-break element');
  assert.ok(xml.includes('Обычный однострочный текст без разрывов.'));
});

test('F12 DOCX: Cyrillic/Unicode text on either side of a line break is preserved exactly', async () => {
  const buffer = await renderGenericDocx(viewModelWithParagraph('Температура: 400°C, µm, — тире.\nВторая строка с юникодом: №, §, ±5%.'));
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(xml.includes('Температура: 400°C, µm, — тире.'));
  assert.ok(xml.includes('Вторая строка с юникодом: №, §, ±5%.'));
});
