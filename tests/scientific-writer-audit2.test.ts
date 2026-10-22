import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { parseMarkdown, parseInline, runsToPlainText, titlesEquivalent } from '../src/services/workspace/scientific-markdown';
import { buildScientificDocumentViewModel, exportScientificDocument, type ScientificExportRequest } from '../src/services/workspace/scientific-writer-export';
import { checkNoAddedSignificanceClaims } from '../src/services/workspace/scientific-writer';
import { CITATION_STYLES, buildBibliography, type Reference } from '../src/services/workspace/references';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxXml = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml');
const docxPlain = (buffer: Buffer) => docxXml(buffer).replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const request = (text: string, overrides: Partial<ScientificExportRequest> = {}): ScientificExportRequest => ({
  documentType: 'article', title: 'Constants', generatedByAI: true, sections: [{ heading: '', text }],
  providedFields: [], missingFields: [], warnings: [], ...overrides,
});

// =====================================================================================
// 1. Code and mathematical expressions are never interpreted as Markdown
// =====================================================================================

test('code: a fenced block is kept character-for-character (power = 2**3**2, # comments, indentation, tabs, blank lines)', () => {
  const code = '# a comment, not a heading\npower = 2**3**2\n    indented = *x* * *y*\n\tTabbed\n\n- not a list\n**not bold**';
  const blocks = parseMarkdown(`Before\n\n\`\`\`python\n${code}\n\`\`\`\n\nAfter`);
  assert.deepEqual(blocks.map(b => b.kind), ['paragraph', 'code', 'paragraph']);
  const block = blocks[1];
  assert.ok(block.kind === 'code');
  assert.equal(block.text, code);
  assert.equal(block.lang, 'python');
});

test('code: ~~~ fences, a longer closing fence, a fence with no language, and an UNCLOSED fence (kept to the end)', () => {
  assert.equal((parseMarkdown('~~~\na**b**c\n~~~')[0] as { text: string }).text, 'a**b**c');
  assert.equal((parseMarkdown('````\n```\ninner\n```\n````')[0] as { text: string }).text, '```\ninner\n```');
  const unclosed = parseMarkdown('```\nx = 2**3**2\n# still code');
  assert.equal(unclosed.length, 1);
  assert.equal((unclosed[0] as { text: string }).text, 'x = 2**3**2\n# still code');
  assert.deepEqual(parseMarkdown('```\n```').map(b => (b as { text: string }).text), ['']);
});

test('code: a "# comment" inside a fence is never the document title or a heading', () => {
  const vm = buildScientificDocumentViewModel(request('```\n# Constant\npower = 2**3**2\n```\n\n## Next\n\nText', { title: undefined }));
  assert.equal(vm.title, 'Научная статья', 'no title was extracted from code');
  assert.ok(vm.sections[0].blocks?.[0].kind === 'code');
});

test('inline code: backtick spans are literal; double backticks, unmatched backticks and surrounding emphasis work', () => {
  const runs = parseInline('Use `a**b**c` and ``x ` y`` and **bold** and `unclosed');
  assert.deepEqual(runs.filter(r => r.code).map(r => r.text), ['a**b**c', 'x ` y']);
  assert.equal(runsToPlainText(runs), 'Use a**b**c and x ` y and bold and `unclosed');
  assert.deepEqual(runs.filter(r => r.bold).map(r => r.text), ['bold']);
});

test('arithmetic outside code is literal too: 2**3**2 and a*b*c are never emphasis (intra-word delimiters)', () => {
  assert.equal(runsToPlainText(parseInline('power = 2**3**2 and a*b*c')), 'power = 2**3**2 and a*b*c');
  assert.deepEqual(parseInline('power = 2**3**2').filter(r => r.bold || r.italic), []);
  const real = parseInline('**Abstract:** and (**bold**) and *italic*.');
  assert.deepEqual(real.filter(r => r.bold).map(r => r.text), ['Abstract:', 'bold']);
  assert.deepEqual(real.filter(r => r.italic).map(r => r.text), ['italic']);
});

const CODE_TEXT = '## Constants\n\nThe constant is defined below.\n\n```python\n# power of two\npower = 2**3**2\n    if power > 100:\n\tprint(`x`)\n```\n\nInline: `a**b**c`.';

test('DOCX: the code block is monospaced, literal, indentation/tab preserved; no Markdown damage', async () => {
  const { buffer } = await exportScientificDocument(request(CODE_TEXT), 'docx');
  const xml = docxXml(buffer);
  const text = docxPlain(buffer);
  assert.ok(text.includes('power = 2**3**2'), 'power = 2**3**2 is literal');
  assert.ok(!text.includes('power = 232'));
  assert.ok(text.includes('# power of two'), 'a code comment stays a comment');
  assert.ok(text.includes('    if power > 100:'), 'leading spaces preserved');
  assert.ok(xml.includes('xml:space="preserve"'));
  assert.ok(xml.includes('<w:tab/>'), 'a tab is a real Word tab');
  assert.ok(text.includes('print(`x`)'), 'backticks inside a fenced block are kept');
  assert.ok(xml.includes('Courier New'));
  assert.ok(text.includes('a**b**c'), 'inline code literal');
  assert.equal((xml.match(/w:val="Heading1"/g) ?? []).length, 2, 'only "## Constants" and the service-information heading are headings - the "# power of two" code comment is not');
});

test('PDF: the code block text is literal (power = 2**3**2) and the comment is not a heading', async () => {
  const { buffer } = await exportScientificDocument(request(CODE_TEXT), 'pdf');
  const text = await pdfText(buffer);
  assert.ok(text.includes('power = 2**3**2'));
  assert.ok(!text.includes('power = 232'));
  assert.ok(text.includes('# power of two'));
  assert.ok(text.includes('if power > 100:'));
  assert.ok(text.includes('a**b**c'));
});

test('the exact audit example survives both formats: "# Constant\\npower = 2**3**2"', async () => {
  for (const format of ['docx', 'pdf'] as const) {
    const { buffer } = await exportScientificDocument(request('# Constant\npower = 2**3**2', { title: undefined }), format);
    const text = format === 'docx' ? docxPlain(buffer) : await pdfText(buffer);
    assert.ok(text.includes('power = 2**3**2'), `${format}: literal expression`);
  }
});

// =====================================================================================
// 2. Titles that differ in a scientifically meaningful way are never merged
// =====================================================================================

test('titlesEquivalent: signs, decimals and units are significant; only presentation is ignored', () => {
  assert.equal(titlesEquivalent('Effect at −50 V', 'Effect at +50 V'), false);
  assert.equal(titlesEquivalent('Effect at -50 V', 'Effect at +50 V'), false);
  assert.equal(titlesEquivalent('Effect at 50 V', 'Effect at +50 V'), false);
  assert.equal(titlesEquivalent('Effect at 0.5 V', 'Effect at 05 V'), false);
  assert.equal(titlesEquivalent('Effect at 0.5 V', 'Effect at 0,5 V'), false, 'when in doubt, keep');
  assert.equal(titlesEquivalent('Effect at 0.5 V', 'Effect at 5 V'), false);
  assert.equal(titlesEquivalent('Effect at 50 mV', 'Effect at 50 V'), false);
  assert.equal(titlesEquivalent('Hardness 5 mPa', 'Hardness 5 MPa'), false, 'mPa vs MPa differ by case only - must stay different');
  assert.equal(titlesEquivalent('Effect at 50 mV', 'EFFECT AT 50 mV'), true);
  assert.equal(titlesEquivalent('Effect at 50 mV', 'EFFECT AT 50 MV'), false);
  assert.equal(titlesEquivalent('Cr-N coatings', 'Cr-N coatings at 5 K'), false);
});

test('titlesEquivalent: genuinely identical titles with different Markdown/whitespace/dash/quote presentation ARE equal', () => {
  assert.equal(titlesEquivalent('**Effect at −50 V**', 'Effect at -50 V'), true);
  assert.equal(titlesEquivalent('Effect at −50 V', 'Effect at −50 V'.replace('−50 V', '-50   V')), true);
  assert.equal(titlesEquivalent('# Effect at 5 V.', 'Effect at 5 V'), true);
  assert.equal(titlesEquivalent('Effect of "AlTiN" at 5 V', 'Effect of “AlTiN” at 5 V'), true);
  assert.equal(titlesEquivalent('Effect at 5 V', 'effect at 5 V'), true);
  assert.equal(titlesEquivalent('Effect at *5 V*', 'Effect at 5 V'), true);
  assert.equal(titlesEquivalent('', ''), true);
});

function titleRequest(userTitle: string | undefined, generatedTitle: string): ScientificExportRequest {
  return request(`**Title:** ${generatedTitle}\n\n**1. Introduction**\n\nBody text.`, { title: userTitle });
}

test('separateTitle (via the view model): "−50 V" and "+50 V" titles are BOTH kept; the body title is not dropped', () => {
  const vm = buildScientificDocumentViewModel(titleRequest('Effect at −50 V', 'Effect at +50 V'));
  assert.equal(vm.title, 'Effect at −50 V');
  assert.ok(vm.sections[0].paragraphs.join('\n').includes('Effect at +50 V'), 'the +50 V title is still in the document');
  for (const [a, b] of [['Effect at 0.5 V', 'Effect at 05 V'], ['Effect at 5 mV', 'Effect at 5 V'], ['Effect at 5 mPa', 'Effect at 5 MPa']]) {
    assert.ok(buildScientificDocumentViewModel(titleRequest(a, b)).sections[0].paragraphs.join('\n').includes(b), `${a} vs ${b}`);
  }
});

test('separateTitle: the SAME title in different Markdown presentation is shown once (deduplicated)', () => {
  const vm = buildScientificDocumentViewModel(titleRequest('Effect at −50 V', '**Effect at -50 V**'));
  assert.equal(vm.title, 'Effect at −50 V');
  assert.ok(!vm.sections[0].paragraphs.join('\n').includes('Effect at -50 V'));
  const heading = buildScientificDocumentViewModel(request('# Effect at −50 V\n\n## Introduction\n\nText.', { title: 'Effect at −50 V' }));
  assert.ok(!heading.sections[0].paragraphs.includes('Effect at −50 V'));
});

test('DOCX of the audit example keeps both the −50 V and +50 V titles', async () => {
  const { buffer } = await exportScientificDocument(titleRequest('Effect at −50 V', 'Effect at +50 V'), 'docx');
  const text = docxPlain(buffer);
  assert.ok(text.includes('Effect at −50 V') && text.includes('Effect at +50 V'));
});

// =====================================================================================
// 3. Added-significance check understands Russian word boundaries
// =====================================================================================

test('significance (RU): достоверно / достоверный / достоверность are detected when added, any case, any position', () => {
  const source = 'Покрытие улучшило свойства.';
  const cases: [string, string][] = [
    ['Покрытие достоверно улучшило свойства.', 'достоверно'],
    ['Достоверно улучшило свойства.', 'достоверно'],
    ['Получен достоверный результат.', 'достоверный'],
    ['Достоверность результата высока.', 'достоверность'],
    ['ДОСТОВЕРНО лучше.', 'достоверно'],
    ['Покрытие (достоверно) лучше.', 'достоверно'],
    ['Результат — достоверный, и всё.', 'достоверный'],
    ['Свойства лучше, достоверность 95%.', 'достоверность'],
    ['Покрытие лучше: достоверно.', 'достоверно'],
  ];
  for (const [output, word] of cases) {
    const result = checkNoAddedSignificanceClaims(source, output);
    assert.equal(result.ok, false, output);
    assert.deepEqual(result.added, [word], output);
  }
});

test('significance (RU): also статистически значимо; and "недостоверно" (the opposite claim) is not a match', () => {
  assert.equal(checkNoAddedSignificanceClaims('Свойства улучшились.', 'Свойства статистически значимо улучшились.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('Свойства улучшились.', 'Свойства Статистически Значимые.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('Свойства улучшились.', 'Различие недостоверно.').ok, true);
});

test('significance: no false warning when the wording was already in the source (any form, any case)', () => {
  assert.equal(checkNoAddedSignificanceClaims('Эффект достоверен? Достоверно улучшилось.', 'Эффект достоверно улучшился.').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('Результат достоверный.', 'Покрытие достоверно улучшило свойства.').ok, true, 'same stem in the source: not an addition');
  assert.equal(checkNoAddedSignificanceClaims('The effect was significant (p < 0.05).', 'The effect was significant, p < 0.05.').ok, true, 'source already claims significance');
  assert.equal(checkNoAddedSignificanceClaims('The effect was significant.', 'The effect was significant (p < 0.05).').ok, false, 'a NEW p-value is still a new claim');
  assert.equal(checkNoAddedSignificanceClaims('Покрытие улучшило свойства.', 'Покрытие улучшило свойства.').ok, true);
});

test('significance (EN) still works with Unicode-aware boundaries: significantly / statistically / p-value; not inside other words', () => {
  assert.deepEqual(checkNoAddedSignificanceClaims('It improved.', 'It improved significantly.').added, ['significantly']);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It improved statistically (p < 0.05).').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It improved (p=0.01).').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'Insignificantly small, discussion of apparent changes.').ok, true, 'no match inside longer words');
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It improved, see step 5.').ok, true);
});

// =====================================================================================
// 4. Web sources keep DOI, year and access date in every style
// =====================================================================================

const WEB: Reference = { id: 'r', type: 'website', authors: ['Smith J.'], title: 'Data repository', year: 2024, doi: '10.1234/data' };
const web = (extra: Partial<Reference>): string[] => CITATION_STYLES.map(style => buildBibliography([{ ...WEB, ...extra }], style).entries[0].text);

test('website, DOI without URL, with year (the audit example): IEEE keeps DOI and year, GOST keeps DOI', () => {
  const [apa, ieee, gost] = web({});
  assert.equal(apa, 'Smith J. (2024). Data repository. https://doi.org/10.1234/data');
  assert.equal(ieee, '[1] Smith J., "Data repository." 2024. doi: 10.1234/data.');
  assert.equal(gost, '1. Smith J. Data repository [Электронный ресурс]. – 2024. – DOI: 10.1234/data.');
});

test('website, URL without DOI: URL kept in every style, no DOI invented', () => {
  const [apa, ieee, gost] = web({ doi: undefined, url: 'https://example.test/p' });
  assert.equal(apa, 'Smith J. (2024). Data repository. https://example.test/p');
  assert.equal(ieee, '[1] Smith J., "Data repository." 2024. https://example.test/p.');
  assert.equal(gost, '1. Smith J. Data repository [Электронный ресурс]. – 2024. – URL: https://example.test/p.');
  for (const text of [apa, ieee, gost]) assert.ok(!/doi/i.test(text));
});

test('website, DOI and URL together: BOTH are kept in every style', () => {
  const [apa, ieee, gost] = web({ url: 'https://example.test/p' });
  assert.equal(apa, 'Smith J. (2024). Data repository. https://example.test/p https://doi.org/10.1234/data');
  assert.equal(ieee, '[1] Smith J., "Data repository." 2024. https://example.test/p. doi: 10.1234/data.');
  assert.equal(gost, '1. Smith J. Data repository [Электронный ресурс]. – 2024. – URL: https://example.test/p. – DOI: 10.1234/data.');
});

test('website, no year: no year is invented in any style', () => {
  for (const text of web({ year: undefined })) assert.ok(!/\b20\d\d\b/.test(text) && !/б\.г\.|n\.d\./.test(text), text);
  const [, ieee, gost] = web({ year: undefined });
  assert.equal(ieee, '[1] Smith J., "Data repository." doi: 10.1234/data.');
  assert.equal(gost, '1. Smith J. Data repository [Электронный ресурс]. – DOI: 10.1234/data.');
});

test('website, access date: kept with a URL, with a DOI only, with both, and with neither', () => {
  const date = '2026-01-01';
  const withUrl = web({ doi: undefined, url: 'https://example.test/p', accessDate: date });
  assert.ok(withUrl[0].includes(`Retrieved ${date}, from https://example.test/p`));
  assert.ok(withUrl[1].includes(`https://example.test/p (accessed ${date}).`));
  assert.ok(withUrl[2].includes(`URL: https://example.test/p (дата обращения: ${date}).`));
  const withDoi = web({ accessDate: date });
  assert.ok(withDoi[0].includes(`Retrieved ${date}, from https://doi.org/10.1234/data`));
  assert.ok(withDoi[1].includes('doi: 10.1234/data.') && withDoi[1].includes(`(accessed ${date}).`));
  assert.ok(withDoi[2].includes(`DOI: 10.1234/data (дата обращения: ${date}).`));
  const both = web({ url: 'https://example.test/p', accessDate: date });
  assert.ok(both[0].includes(`Retrieved ${date}, from https://example.test/p`) && both[0].includes('https://doi.org/10.1234/data'));
  assert.ok(both[1].includes(`(accessed ${date}).`) && both[1].includes('doi: 10.1234/data.'));
  assert.ok(both[2].includes(`(дата обращения: ${date})`) && both[2].includes('DOI: 10.1234/data.') && !both[2].includes(`DOI: 10.1234/data (дата`));
  const neither = web({ doi: undefined, accessDate: date });
  assert.ok(neither[1].includes(`(accessed ${date}).`) && neither[2].includes(`(дата обращения: ${date})`), 'a date is never dropped');
});

test('website: container and sparse data stay clean (no undefined/null/doubled punctuation)', () => {
  for (const extra of [{ containerTitle: 'Site Name' }, { authors: [], year: undefined, doi: undefined }, { year: undefined, doi: undefined, url: 'https://e.test', accessDate: '2026-01-01' }]) {
    for (const text of web(extra as Partial<Reference>)) assert.ok(!/undefined|null|NaN|\.\.|, ,/.test(text), text);
  }
});

test('journal articles are unchanged by the website fix', () => {
  const journal: Reference = { id: 'j', type: 'journal_article', authors: ['Smith J.'], title: 'T', containerTitle: 'J', year: 2020, volume: '1', issue: '2', pages: '3-4', doi: '10.1/x', url: 'https://e.test' };
  assert.equal(buildBibliography([journal], 'apa').entries[0].text, 'Smith J. (2020). T. J, 1(2), 3-4. https://doi.org/10.1/x');
  assert.equal(buildBibliography([journal], 'ieee').entries[0].text, '[1] Smith J., "T," J, vol. 1, no. 2, pp. 3-4, 2020, doi: 10.1/x.');
  assert.equal(buildBibliography([journal], 'gost').entries[0].text, '1. Smith J. T // J. – 2020. – Т./№ 1(2). – С. 3-4. – DOI: 10.1/x.');
});

test('DOCX and PDF export keep the web source with DOI, URL, year and access date', async () => {
  const references: Reference[] = [{ ...WEB, url: 'https://example.test/p', accessDate: '2026-01-01' }];
  for (const citationStyle of CITATION_STYLES) {
    const base = request('## Intro\n\nBody.', { references, citationStyle });
    const docx = docxPlain((await exportScientificDocument(base, 'docx')).buffer);
    const pdf = await pdfText((await exportScientificDocument(base, 'pdf')).buffer);
    for (const text of [docx, pdf]) {
      assert.ok(text.includes('2024'), `${citationStyle}: year`);
      assert.ok(text.includes('10.1234/data'), `${citationStyle}: DOI`);
      assert.ok(text.includes('example.test/p'), `${citationStyle}: URL`);
      assert.ok(text.includes('2026-01-01'), `${citationStyle}: access date`);
    }
  }
});
