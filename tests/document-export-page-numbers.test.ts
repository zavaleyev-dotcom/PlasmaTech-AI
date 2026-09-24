import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { renderGenericPdf, type GenericDocumentViewModel } from '../src/services/workspace/document-export';

async function extractPages(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try { return await parser.getText(); } finally { await parser.destroy(); }
}

function multipageViewModel(paragraphCount: number): GenericDocumentViewModel {
  const longParagraph = 'Текст раздела для проверки многостраничного экспорта PDF - достаточно длинный, чтобы гарантированно занять место на странице и вынудить документ перейти на следующую страницу после нескольких повторений. '.repeat(3);
  return {
    title: 'Многостраничный тестовый документ',
    metadata: [{ label: 'Тип', value: 'Тест' }],
    sections: [{ heading: 'Раздел с большим количеством текста', paragraphs: Array.from({ length: paragraphCount }, () => longParagraph) }],
    tables: [],
    traceability: [],
    traceabilityHeading: 'Traceability',
    footer: 'Тестовый футер.',
  };
}

// ---------- F16 (LOW): page numbers must actually appear in the real generated PDF, on every
// page, not just be attempted after the document was already finalized ----------

test('F16 PDF: a genuinely multipage document has real page numbers 1..N present on every page', async () => {
  const buffer = await renderGenericPdf(multipageViewModel(40));
  const result = await extractPages(buffer);
  assert.ok(result.total >= 3, `expected a genuinely multipage PDF to verify against, got ${result.total} page(s)`);
  for (let i = 1; i <= result.total; i++) {
    const pageText = result.getPageText(i);
    assert.ok(pageText.includes(`Страница ${i} из ${result.total}`), `page ${i} of ${result.total} must contain its own page-number stamp, got: ${JSON.stringify(pageText.slice(-200))}`);
  }
});

test('F16 PDF: page numbers do not overlap/corrupt the body text or footer - both remain fully extractable', async () => {
  const buffer = await renderGenericPdf(multipageViewModel(40));
  const result = await extractPages(buffer);
  assert.ok(result.text.includes('Раздел с большим количеством текста'));
  assert.ok(result.text.includes('Тестовый футер.'));
});

test('F16 PDF: a single-page document still gets a correct "Страница 1 из 1" stamp', async () => {
  const buffer = await renderGenericPdf(multipageViewModel(1));
  const result = await extractPages(buffer);
  assert.equal(result.total, 1);
  assert.ok(result.getPageText(1).includes('Страница 1 из 1'));
});

test('F16 PDF: page numbering works identically when a formatting profile changes margins/font size', async () => {
  const { FORMATTING_PROFILES } = await import('../src/services/workspace/references');
  const buffer = await renderGenericPdf(multipageViewModel(40), { formatting: FORMATTING_PROFILES.thesis_report });
  const result = await extractPages(buffer);
  assert.ok(result.total >= 2);
  for (let i = 1; i <= result.total; i++) {
    assert.ok(result.getPageText(i).includes(`Страница ${i} из ${result.total}`));
  }
});
