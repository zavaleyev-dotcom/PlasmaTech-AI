import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { renderGenericPdf, renderGenericDocx, pdfText, type GenericDocumentViewModel } from '../src/services/workspace/document-export';
import { exportScientificDocument, type ScientificExportRequest } from '../src/services/workspace/scientific-writer-export';
import { readZipEntryText } from './helpers/zip-reader';

// PDFKit cannot draw TAB, CR or control characters (a missing-glyph box, a NUL byte in the extracted text). The PDF
// boundary prepares a DISPLAY text; the model, DOCX and Markdown parser keep the original characters.

const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|\r/;
const SCI = 'TiN, 5 µm, 1e-3 Pa, 2**3**2, ≤ ±α·β, Ar/N2 = 3:1';

async function pdfText_(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).pages.map((p: { text: string }) => p.text).join('\n'); } finally { await parser.destroy(); }
}
const model = (over: Partial<GenericDocumentViewModel>): GenericDocumentViewModel => ({
  title: 'Заголовок\tс TAB', metadata: [{ label: 'Поле\t1', value: 'a\tb\r\nc' }], sections: [], tables: [],
  traceability: [{ label: 'Версия', value: 'x\ty' }], traceabilityHeading: 'Traceability', footer: 'Футер\tтест', ...over,
});

test('pdfText: TAB -> 4 spaces, CRLF and lone CR -> LF, control characters -> U+FFFD; everything else is untouched', () => {
  assert.equal(pdfText('a\tb'), 'a    b');
  assert.equal(pdfText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(pdfText('a\u0000b\u0007c\u000Bd\u001Be\u007Ff'), 'a�b�c�d�e�f');
  assert.equal(pdfText(SCI), SCI, 'scientific notation, units, Cyrillic, operators are not altered');
  assert.equal(pdfText(' двойной  пробел \n\n'), ' двойной  пробел \n\n', 'blanks and LF survive');
  assert.ok(!BAD.test(pdfText('x\t\r\n\u0000\r')));
});

test('PDF paragraphs, title, metadata, traceability and footer: no NUL, no CR, no missing-glyph source; the text is readable', async () => {
  const text = await pdfText_(await renderGenericPdf(model({ sections: [{ heading: 'Раздел\tA', paragraphs: [`Первая\tстрока\r\nвторая строка\rтретья ${SCI}`, 'x\u0000y'] }] })));
  assert.ok(!BAD.test(text), JSON.stringify(text.match(BAD)));
  assert.ok(text.includes('Первая') && text.includes('вторая строка') && text.includes('третья'));
  assert.ok(text.replace(/\s+/g, ' ').includes('TiN, 5 ') && text.includes('1e-3 Pa') && text.includes('2**3**2') && text.includes('≤ ±α·β'));
  assert.ok(text.includes('Заголовок') && text.includes('Футер') && text.includes('Версия'));
  assert.ok(text.includes('x�y'), 'a stray control character is shown as a visible replacement mark, not a missing glyph');
});

test('PDF tables: short and long tables with TAB / CRLF / CR in headers and cells - no NUL, no CR, same text for measuring and drawing (rows stay on pages)', async () => {
  const cell = (i: number) => `значение\t${i}\r\nвторая\rстрока ${SCI}`;
  const short = model({ tables: [{ heading: 'Короткая\tтаблица', columns: ['Кол\t1', 'Кол\r\n2'], rows: [[cell(1), 'b\tc']] }] });
  const rows = Array.from({ length: 60 }, (_, i) => [cell(i), `\t${i}\t`, 'x']);
  const long = model({ tables: [{ heading: 'Длинная', columns: ['А\tа', 'Б', 'В'], rows }] });
  for (const vm of [short, long]) {
    const text = await pdfText_(await renderGenericPdf(vm));
    assert.ok(!BAD.test(text), JSON.stringify(text.match(BAD)));
    assert.ok(text.includes('значение') && text.includes('1e-3 Pa') && text.includes('2**3**2'));
  }
  const text = await pdfText_(await renderGenericPdf(long));
  for (let i = 0; i < 60; i++) assert.ok(text.includes(`значение ${i}`) || text.replace(/\s+/g, ' ').includes(`значение ${i}`), `row ${i} present`);
  const pages = (await new PDFParse({ data: await renderGenericPdf(long) }).getText()).pages.length;
  assert.ok(pages >= 2, 'the long table continues on further pages');
  // a TAB in a cell is measured as the 4 spaces it is drawn as: a single-line tabbed cell does not get a second line
  const tabbed = await pdfText_(await renderGenericPdf(model({ tables: [{ heading: 'T', columns: ['A', 'B'], rows: [['a\tb', 'c']] }] })));
  assert.ok(/a\s+b/.test(tabbed));
});

test('DOCX and the data are unchanged by the PDF display text: the original TAB / CRLF text is still in the model and in the DOCX XML', async () => {
  const vm = model({ sections: [{ heading: 'Р', paragraphs: ['a\tb'] }] });
  await renderGenericPdf(vm);
  assert.equal(vm.sections[0].paragraphs[0], 'a\tb', 'rendering to PDF does not mutate the view model');
  assert.equal(vm.metadata[0].value, 'a\tb\r\nc');
  const xml = readZipEntryText(await renderGenericDocx(vm), 'word/document.xml');
  assert.ok(xml.includes('a\tb') || xml.includes('<w:tab/>'), 'DOCX keeps the TAB');
});

const sw = (generatedByAI: boolean, text: string): ScientificExportRequest => ({
  documentType: 'technical_report', generatedByAI, title: 'Отчёт', providedFields: [], missingFields: [], warnings: [],
  sections: [{ heading: 'Результаты', text }],
} as ScientificExportRequest);

test('Scientific Writer PDF, plain-text branch (local scaffold): TAB / CRLF / CR do not leave NUL or missing glyphs, science text intact', async () => {
  const { buffer } = await exportScientificDocument(sw(false, `Покрытие:\tTiN\r\nТолщина: 5 µm\rДавление: 1e-3 Pa\r\n\r\nФормула: 2**3**2`), 'pdf');
  const text = await pdfText_(buffer);
  assert.ok(!BAD.test(text), JSON.stringify(text.match(BAD)));
  assert.ok(text.includes('TiN') && text.includes('1e-3 Pa') && text.includes('2**3**2') && text.replace(/\s+/g, ' ').includes('5 µm') || text.includes('5 μm'));
});

test('Scientific Writer PDF, Markdown branch (AI sections): paragraphs, code block, list and bold runs with TAB / CRLF are clean', async () => {
  const md = ['## Метод', '', `Абзац с\tTAB и **жирным\tтекстом** ${SCI}.`, '', '- пункт\tодин', '- пункт два', '', '```', 'x = 1\ty = 2\r', 'z = 2**3**2\t# степень', '```', '', '| А | Б |', '| --- | --- |', '| 1\tTiN | 5 µm |'].join('\r\n');
  const { buffer } = await exportScientificDocument(sw(true, md), 'pdf');
  const text = await pdfText_(buffer);
  assert.ok(!BAD.test(text), JSON.stringify(text.match(BAD)));
  for (const part of ['Абзац', 'жирным', 'пункт', 'x = 1', 'z = 2**3**2', 'TiN', '1e-3 Pa']) assert.ok(text.includes(part), part);
});
