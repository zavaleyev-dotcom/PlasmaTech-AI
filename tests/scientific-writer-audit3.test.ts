import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { titlesEquivalent } from '../src/services/workspace/scientific-markdown';
import { buildScientificDocumentViewModel, exportScientificDocument, type ScientificExportRequest } from '../src/services/workspace/scientific-writer-export';
import { checkNoAddedSignificanceClaims } from '../src/services/workspace/scientific-writer';
import { CITATION_STYLES, buildBibliography, type Reference } from '../src/services/workspace/references';
import { listMarkerIndent } from '../src/services/workspace/document-export';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxXml = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml');
const docxPlain = (buffer: Buffer) => docxXml(buffer).replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const request = (text: string, overrides: Partial<ScientificExportRequest> = {}): ScientificExportRequest => ({
  documentType: 'article', title: 'T', generatedByAI: true, sections: [{ heading: '', text }],
  providedFields: [], missingFields: [], warnings: [], ...overrides,
});

// =====================================================================================
// 1. Letter case of scientific designations is never normalized in titles
// =====================================================================================

test('titles: case-only differences are NOT equivalent - mPa/MPa, Co/CO, K/k, kV/KV, with or without a number', () => {
  const pairs: [string, string][] = [
    ['Pressure in mPa', 'Pressure in MPa'], ['Co coatings', 'CO coatings'], ['Co coatings', 'co coatings'],
    ['Temperature in K', 'Temperature in k'], ['Voltage in kV', 'Voltage in KV'], ['Hardness in GPa', 'Hardness in gpa'],
    ['TiN films', 'TIN films'], ['Effect at 5 mV', 'Effect at 5 MV'], ['PVD of Ni', 'PVD of NI'],
    ['Effect of Bias', 'Effect of bias'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(titlesEquivalent(a, b), false, `${a} vs ${b}`);
    assert.equal(titlesEquivalent(b, a), false, `${b} vs ${a}`);
  }
});

test('titles: real duplicates (same text, different Markdown/space/dash/quote/trailing-punctuation presentation) are still equal', () => {
  const pairs: [string, string][] = [
    ['Pressure in MPa', 'Pressure in MPa'], ['**Pressure in MPa**', 'Pressure in MPa'], ['# Pressure in MPa.', 'Pressure in MPa'],
    ['Pressure   in MPa', 'Pressure in MPa'], ['Co–Cr coatings', 'Co-Cr coatings'], ['“Co” coatings', '"Co" coatings'],
    ['Effect at *−50 V*', 'Effect at -50 V'],
  ];
  for (const [a, b] of pairs) assert.equal(titlesEquivalent(a, b), true, `${a} vs ${b}`);
});

test('export: mPa vs MPa and Co vs CO titles are BOTH kept in DOCX and PDF; an exact duplicate is removed', async () => {
  for (const [user, generated] of [['Pressure in mPa', 'Pressure in MPa'], ['Co coatings', 'CO coatings']]) {
    const req = request(`**Title:** ${generated}\n\n## Intro\n\nBody.`, { title: user });
    const vm = buildScientificDocumentViewModel(req);
    assert.equal(vm.title, user);
    assert.ok(vm.sections[0].paragraphs.join('\n').includes(generated), `${generated} stays in the body`);
    const docx = docxPlain((await exportScientificDocument(req, 'docx')).buffer);
    const pdf = await pdfText((await exportScientificDocument(req, 'pdf')).buffer);
    for (const text of [docx, pdf]) assert.ok(text.includes(user) && text.includes(generated), `${user} / ${generated}`);
  }
  const dup = request('**Title:** **Pressure in MPa**\n\n## Intro\n\nBody.', { title: 'Pressure in MPa' });
  assert.ok(!buildScientificDocumentViewModel(dup).sections[0].paragraphs.join('\n').includes('Pressure in MPa'));
  const docx = docxPlain((await exportScientificDocument(dup, 'docx')).buffer);
  assert.equal(docx.split('Pressure in MPa').length - 1, 1, 'the duplicate appears exactly once');
});

// =====================================================================================
// 2. TAB inside inline code
// =====================================================================================

test('PDF: a real TAB inside inline code never produces a NUL byte; other characters are untouched', async () => {
  const { buffer } = await exportScientificDocument(request('Inline `a\tb` and `x**y**z` and **bold text** end.'), 'pdf');
  const text = await pdfText(buffer);
  assert.ok(!text.includes('\u0000'), 'no NUL byte');
  const line = text.split('\n').find(l => l.includes('Inline')) ?? '';
  assert.match(line, /Inline a\s+b and x\*\*y\*\*z/);
  assert.ok(buffer.toString('latin1').includes('%PDF-'));
});

test('PDF: a TAB in plain text, in a code block and in a list item is also safe', async () => {
  const { buffer } = await exportScientificDocument(request('Plain\ttext.\n\n```\n\tindented\tcode\n```\n\n- item\twith tab'), 'pdf');
  const text = await pdfText(buffer);
  assert.ok(!text.includes('\u0000'));
  assert.ok(/Plain\s+text/.test(text) && /indented\s+code/.test(text) && /item\s+with tab/.test(text));
});

test('DOCX: a TAB inside inline code and in text is a real Word tab (no regression, no raw tab character in the text node)', async () => {
  const { buffer } = await exportScientificDocument(request('Inline `a\tb` end.\n\nPlain\ttext.'), 'docx');
  const xml = docxXml(buffer);
  assert.ok(xml.includes('<w:tab/>'));
  assert.ok(!xml.includes('\t'), 'no raw TAB character left inside the XML');
  const text = docxPlain(buffer);
  assert.ok(text.includes('a\tb') && text.includes('Plain\ttext.'));
  assert.ok(xml.includes('Courier New'));
});

// =====================================================================================
// 3. Russian reliability wording
// =====================================================================================

test('significance (RU): all reliability forms are detected when added - достоверен, достоверна, достоверно, достоверные, достоверный, достоверность', () => {
  const source = 'Покрытие улучшило свойства.';
  const cases: [string, string][] = [
    ['Результат достоверен.', 'достоверен'], ['Эффект достоверна.', 'достоверна'], ['Улучшение достоверно.', 'достоверно'],
    ['Получены достоверные данные.', 'достоверные'], ['Получен достоверный результат.', 'достоверный'], ['Достоверность результата высока.', 'достоверность'],
    ['РЕЗУЛЬТАТ ДОСТОВЕРЕН.', 'достоверен'], ['Достоверны оба результата.', 'достоверны'],
  ];
  for (const [output, word] of cases) assert.deepEqual(checkNoAddedSignificanceClaims(source, output).added, [word], output);
});

test('significance: explicitly negated reliability/significance is not an asserted claim (RU and EN)', () => {
  const source = 'Покрытие улучшило свойства.';
  for (const output of [
    'Достоверность не оценивалась.', 'Достоверность результата не определена.', 'Достоверность не подтверждена.',
    'Результат не достоверен.', 'Нет данных о достоверности.', 'Без оценки достоверности.', 'Статистическая значимость не проверялась.',
    'Различие не является статистически значимым.', 'Недостаточно достоверно.', 'Различие недостоверно.',
  ]) assert.equal(checkNoAddedSignificanceClaims(source, output).ok, true, output);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'The change was not significant.').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'Significance was not assessed.').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It did not change significantly.').ok, true);
});

test('significance: a negator in ANOTHER clause does not hide an asserted claim', () => {
  assert.equal(checkNoAddedSignificanceClaims('Свойства улучшились.', 'Результат достоверен, но не оценивался подробно.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('Свойства улучшились.', 'Не оценивалось. Результат достоверен.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'No data were lost. The change was significant.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It improved significantly (p < 0.05).').ok, false, 'p-values are never negatable');
});

test('significance: earlier behaviour is preserved (source already has the wording; EN markers; no match inside longer words)', () => {
  assert.equal(checkNoAddedSignificanceClaims('Результат достоверен.', 'Результат достоверно улучшился.').ok, true);
  assert.deepEqual(checkNoAddedSignificanceClaims('It improved.', 'It improved significantly.').added, ['significantly']);
  assert.equal(checkNoAddedSignificanceClaims('Покрытие улучшило свойства.', 'Покрытие улучшило свойства.').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('x', 'Insignificantly small changes.').ok, true);
});

// =====================================================================================
// 4. APA keeps the access date when there is neither DOI nor URL
// =====================================================================================

const DATE = '15 March 2027';
const FULL: Reference = { id: 'w', type: 'website', authors: ['Smith J.'], title: 'Data repository', year: 2024, doi: '10.1234/data', url: 'https://example.test/p', accessDate: DATE };

test('website: the access date is kept in APA, IEEE and GOST-style when there is no DOI and no URL', () => {
  const ref: Reference = { id: 'w', type: 'website', authors: ['Smith J.'], title: 'Data repository', accessDate: DATE };
  const [apa, ieee, gost] = CITATION_STYLES.map(style => buildBibliography([ref], style).entries[0].text);
  assert.equal(apa, `Smith J. Data repository. Retrieved ${DATE}.`);
  assert.ok(ieee.includes(`(accessed ${DATE}).`));
  assert.ok(gost.includes(`(дата обращения: ${DATE})`));
  for (const text of [apa, ieee, gost]) assert.ok(!/doi|https?:|10\.\d{4}/i.test(text), `nothing invented: ${text}`);
});

test('website matrix: every combination of year / DOI / URL / access date keeps exactly the provided fields in all three styles', () => {
  let combos = 0;
  for (const year of [undefined, 2024]) for (const doi of [undefined, '10.1234/data']) for (const url of [undefined, 'https://example.test/p']) for (const accessDate of [undefined, DATE]) {
    combos++;
    const ref: Reference = { ...FULL, year, doi, url, accessDate };
    for (const style of CITATION_STYLES) {
      const text = buildBibliography([ref], style).entries[0].text;
      const label = `${style} year=${year} doi=${doi} url=${url} date=${accessDate}: ${text}`;
      assert.ok(text.includes('Data repository') && text.includes('Smith J.'), label);
      assert.equal(text.includes('2024'), year !== undefined, label);
      assert.equal(text.includes('10.1234/data'), doi !== undefined, label);
      assert.equal(text.includes('example.test/p'), url !== undefined, label);
      assert.equal(text.includes(DATE), accessDate !== undefined, label);
      assert.ok(!/undefined|null|NaN|\.\.|, ,/.test(text), label);
    }
  }
  assert.equal(combos, 16);
});

test('journal articles are untouched by the website changes (exact strings)', () => {
  const journal: Reference = { id: 'j', type: 'journal_article', authors: ['Smith J.'], title: 'T', containerTitle: 'J', year: 2020, volume: '1', issue: '2', pages: '3-4', doi: '10.1/x', url: 'https://e.test', accessDate: DATE };
  assert.equal(buildBibliography([journal], 'apa').entries[0].text, 'Smith J. (2020). T. J, 1(2), 3-4. https://doi.org/10.1/x');
  assert.equal(buildBibliography([journal], 'ieee').entries[0].text, '[1] Smith J., "T," J, vol. 1, no. 2, pp. 3-4, 2020, doi: 10.1/x.');
  assert.equal(buildBibliography([journal], 'gost').entries[0].text, '1. Smith J. T // J. – 2020. – Т./№ 1(2). – С. 3-4. – DOI: 10.1/x.');
});

test('DOCX and PDF export keep a website source that has only an access date', async () => {
  const references: Reference[] = [{ id: 'w', type: 'website', authors: ['Smith J.'], title: 'Data repository', accessDate: DATE }];
  for (const citationStyle of CITATION_STYLES) {
    const req = request('## Intro\n\nBody.', { references, citationStyle });
    const docx = docxPlain((await exportScientificDocument(req, 'docx')).buffer);
    const pdf = await pdfText((await exportScientificDocument(req, 'pdf')).buffer);
    for (const text of [docx, pdf]) assert.ok(text.includes(DATE) && text.includes('Data repository'), `${citationStyle}`);
  }
});

// =====================================================================================
// 5. PDF numbered lists with 3-digit markers
// =====================================================================================

test('listMarkerIndent: widens with the widest marker, never below the default', () => {
  assert.equal(listMarkerIndent([6]), 16);
  assert.equal(listMarkerIndent([]), 16);
  assert.ok(listMarkerIndent([20]) >= 26, 'a marker 20 pt wide needs a wider column');
  assert.equal(listMarkerIndent([6, 12.2, 9]), 19);
});

test('PDF: items numbered 99, 100 and 101 keep their markers on the same line as their text (previously "100."/"101." vanished or overlapped)', async () => {
  const list = [99, 100, 101, 1000].map(n => `${n}. Item number ${n}`).join('\n');
  const text = await pdfText((await exportScientificDocument(request(list), 'pdf')).buffer);
  for (const n of [99, 100, 101, 1000]) assert.ok(new RegExp(`${n}\\.\\s+Item number ${n}`).test(text), `marker ${n}. stays with its text: ${JSON.stringify(text.slice(0, 200))}`);
});

test('PDF: a long numbered list (1..101) exports with every marker present', async () => {
  const list = Array.from({ length: 101 }, (_, i) => `${i + 1}. Item number ${i + 1}`).join('\n');
  const text = await pdfText((await exportScientificDocument(request(list), 'pdf')).buffer);
  for (const n of [1, 9, 10, 99, 100, 101]) assert.ok(new RegExp(`(^|\\n)${n}\\.\\s+Item number ${n}(\\n|$)`).test(text), `item ${n}`);
});

test('DOCX: a list with 3-digit markers widens its marker column (tab stop and indent) and short lists keep the old layout', async () => {
  const wide = docxXml((await exportScientificDocument(request('99. a\n100. b\n101. c'), 'docx')).buffer);
  const narrow = docxXml((await exportScientificDocument(request('1. a\n2. b\n3. c'), 'docx')).buffer);
  const tab = (xml: string) => Number(/w:tab w:val="left" w:pos="(\d+)"/.exec(xml)?.[1]);
  assert.equal(tab(narrow), 567, 'ordinary lists are unchanged');
  assert.ok(tab(wide) > 567, `3-digit markers need a wider column (got ${tab(wide)})`);
  assert.ok(docxPlain(Buffer.from(await exportScientificDocument(request('99. a\n100. b'), 'docx').then(r => r.buffer))).includes('100.\tb'));
});
