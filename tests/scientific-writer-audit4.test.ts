import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { parseInline, parseMarkdown, runsToPlainText } from '../src/services/workspace/scientific-markdown';
import { exportScientificDocument, type ScientificExportRequest } from '../src/services/workspace/scientific-writer-export';
import { checkNoAddedSignificanceClaims } from '../src/services/workspace/scientific-writer';
import { handleGenerate } from '../src/services/workspace/scientific-writer-handler';
import type { WriterProvider } from '../src/services/workspace/scientific-writer-provider';

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
// 1. Negation must scope the marker itself, not any word elsewhere in the clause
// =====================================================================================

const SOURCE = 'Покрытие повысило твёрдость.';

test('significance: a negation of ANOTHER action does not hide an added reliability claim', () => {
  const outputs: [string, string][] = [
    ['Без нагрева покрытие достоверно повысило твёрдость.', 'достоверно'],
    ['Достоверное улучшение получено без нагрева.', 'достоверное'],
    ['Результат достоверен без нагрева.', 'достоверен'],
    ['Нагрев не применяли — результат достоверен.', 'достоверен'],
    ['Нагрев не применяли – результат достоверен.', 'достоверен'],
    ['Нагрев не применяли - результат достоверен.', 'достоверен'],
    ['Нагрев не применяли, результат достоверен.', 'достоверен'],
    ['Нагрев не применяли; результат достоверен.', 'достоверен'],
    ['Нагрев не применяли. Результат достоверен.', 'достоверен'],
    ['Нагрев не применяли и результат достоверен.', 'достоверен'],
    ['Образец не нагревали, но эффект достоверен.', 'достоверен'],
  ];
  for (const [output, word] of outputs) assert.deepEqual(checkNoAddedSignificanceClaims(SOURCE, output).added, [word], output);
});

test('significance: "не только достоверен" / "not only significant" assert the claim (emphasis, not negation)', () => {
  for (const output of ['Результат не только достоверен, но и воспроизводим.', 'Результат не просто достоверен.', 'Эффект не лишь достоверный.']) {
    assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, false, output);
  }
  for (const output of ['The effect was not only significant but reproducible.', 'It was not just significant.', 'Not only significant.']) {
    assert.equal(checkNoAddedSignificanceClaims('It improved.', output).ok, false, output);
  }
});

test('significance (EN): another negation in the clause does not hide the claim', () => {
  for (const output of [
    'The coating significantly improved without heating.', 'Without heating, the coating significantly improved.',
    'No heating was applied and the effect was significant.', 'The change was significant, not marginal.',
  ]) assert.equal(checkNoAddedSignificanceClaims('The coating improved.', output).ok, false, output);
});

test('significance: genuine negated statements are still NOT claims (marker directly negated, or a negated assessment verb follows)', () => {
  const ok = [
    'Достоверность не оценивалась.', 'Достоверность результата не определена.', 'Достоверность не подтверждена.', 'Достоверность не проверялась.',
    'Результат не достоверен.', 'Результат не является достоверным.', 'Результат не может считаться достоверным.'.replace('может считаться', 'является'),
    'Статистическая значимость не проверялась.', 'Различие не является статистически значимым.', 'Недостаточно достоверно.',
    'Нет данных о достоверности.', 'Без оценки достоверности.', 'Нет достоверного различия.', 'Различие недостоверно.',
  ];
  for (const output of ok) assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, true, output);
  for (const output of ['The change was not significant.', 'Significance was not assessed.', 'It did not change significantly.', 'No significant difference was found.', 'There is no evidence of significance.', 'It wasn\'t significant.']) {
    assert.equal(checkNoAddedSignificanceClaims('It changed.', output).ok, true, output);
  }
});

test('significance: when the scope is unclear the check prefers a warning (documented false positive)', () => {
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It cannot really be considered significant.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims(SOURCE, 'Результат не может быть назван достоверным.').ok, false, 'negator three words before the marker: not provably its scope, so a warning');
});

test('significance: a source that only NEGATED the wording does not excuse the output asserting it', () => {
  assert.equal(checkNoAddedSignificanceClaims('Достоверность не оценивалась.', 'Результат достоверен.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('The difference was not significant.', 'The difference was significant.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('Достоверность не оценивалась.', 'Достоверность не оценивалась.').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('Результат достоверен.', 'Результат достоверно улучшился.').ok, true, 'asserted in the source: not an addition');
  assert.equal(checkNoAddedSignificanceClaims('The difference was not significant.', 'The difference was not significant.').ok, true);
});

test('significance through the real generate handler: the audit example now returns a warning', async () => {
  const stub = (text: string): WriterProvider => ({ id: 'stub', configured: () => true, generate: async () => ({ text }) });
  const raw = { documentType: 'article', mode: 'edit', targetLanguage: 'ru', sourceText: SOURCE };
  const flagged = await handleGenerate(raw, stub('Без нагрева покрытие достоверно повысило твёрдость.'));
  assert.equal(flagged.status, 200);
  assert.ok((flagged.body.warnings as string[]).some(w => w.includes('значимости') && w.includes('достоверно')), JSON.stringify(flagged.body.warnings));
  const clean = await handleGenerate(raw, stub('Покрытие повысило твёрдость; достоверность не оценивалась.'));
  assert.ok(!(clean.body.warnings as string[]).some(w => w.includes('значимости')));
});

test('significance: a negated verb in a JOINED predicate does not negate the marker ("достоверен и не проверялся")', () => {
  const outputs: [string, string][] = [
    ['Результат достоверен и не проверялся повторно.', 'достоверен'],
    ['Результат достоверен, но не проверялся повторно.', 'достоверен'],
    ['Результат достоверен, а не проверялся.', 'достоверен'],
    ['Результат достоверен или не оценивался.', 'достоверен'],
    ['Результат достоверен, хотя не оценивался.', 'достоверен'],
  ];
  for (const [output, word] of outputs) assert.deepEqual(checkNoAddedSignificanceClaims(SOURCE, output).added, [word], output);
  for (const output of [
    'The effect was significant and was not tested again.', 'The effect is significant but not assessed.', 'The effect is significant and not assessed.',
    'The effect was significant while it was not checked.',
  ]) assert.equal(checkNoAddedSignificanceClaims('The effect appeared.', output).ok, false, output);
});

test('significance: "не менее" / "no less" AFFIRM the marker (at least as reliable), like "не только"', () => {
  for (const output of ['Результат не менее достоверен.', 'Результат не меньше достоверен.', 'Результат не хуже достоверен.', 'Не менее достоверное улучшение.']) {
    assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, false, output);
  }
  for (const output of ['The result is no less significant.', 'The result is not less significant.', 'The result is not worse, significant.'.replace(', ', ' ')]) {
    assert.equal(checkNoAddedSignificanceClaims('It improved.', output).ok, false, output);
  }
});

test('significance: double negation is an assertion ("не может не быть достоверным"), and ambiguity prefers a warning', () => {
  for (const output of ['Результат не может не быть достоверным.', 'Результат не мог не быть достоверным.']) assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, false, output);
  assert.equal(checkNoAddedSignificanceClaims('It improved.', 'It cannot but be significant, and it was not nothing.').ok, false);
});

test('significance: the previously correct negations are still not claims (regression guard for the two fixes above)', () => {
  for (const output of [
    'Достоверность не оценивалась.', 'Результат не является достоверным.', 'Достоверность результата не определена.', 'Достоверность не подтверждена.',
    'Результат не достоверен.', 'Различие не является статистически значимым.', 'Статистическая значимость не проверялась.', 'Нет данных о достоверности.',
    'Без оценки достоверности.', 'Недостаточно достоверно.', 'Различие недостоверно.',
  ]) assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, true, output);
  for (const output of ['The change was not significant.', 'Significance was not assessed.', 'It did not change significantly.', 'No significant difference was found.']) {
    assert.equal(checkNoAddedSignificanceClaims('It changed.', output).ok, true, output);
  }
  for (const output of ['Без нагрева покрытие достоверно повысило твёрдость.', 'Результат не только достоверен, но и воспроизводим.', 'Нагрев не применяли — результат достоверен.']) {
    assert.equal(checkNoAddedSignificanceClaims(SOURCE, output).ok, false, output);
  }
  assert.equal(checkNoAddedSignificanceClaims('Достоверность не оценивалась.', 'Результат достоверен.').ok, false, 'a negated source does not excuse an assertion');
  assert.equal(checkNoAddedSignificanceClaims('Достоверность не оценивалась.', 'Достоверность не оценивалась.').ok, true);
});

test('significance through the real generate handler: both reported sentences now return a warning', async () => {
  const stub = (text: string): WriterProvider => ({ id: 'stub', configured: () => true, generate: async () => ({ text }) });
  const raw = { documentType: 'article', mode: 'edit', targetLanguage: 'ru', sourceText: SOURCE };
  for (const text of ['Результат достоверен и не проверялся повторно.', 'Результат не менее достоверен.']) {
    const result = await handleGenerate(raw, stub(text));
    assert.equal(result.status, 200);
    assert.ok((result.body.warnings as string[]).some(w => w.includes('значимости') && w.includes('достоверен')), `${text}: ${JSON.stringify(result.body.warnings)}`);
  }
  const clean = await handleGenerate(raw, stub('Покрытие повысило твёрдость; достоверность не оценивалась.'));
  assert.ok(!(clean.body.warnings as string[]).some(w => w.includes('значимости')));
});

// =====================================================================================
// 2. Arithmetic with spaces stays literal
// =====================================================================================

test('emphasis: "2 ** 3 ** 2" and every other ambiguous *, ** / letters / digits / spaces / brackets combination stays literal', () => {
  const literal = [
    'power = 2 ** 3 ** 2', 'power = 2**3**2', 'x ** y', 'x ** y ** z', '5 * 3 ** 2', 'a * b * c', 'a*b*c', '2*3*4', '2 * 3 * 4',
    '(a)*(b)*(c)', '[a]*[b]*[c]', '{a}*{b}*{c}', 'f(x)*g(x)*h(x)', '(1+2)*(3+4)*(5+6)', '** spaced **', '* spaced *', 'x **2** y', 'x *5* y',
    '2 **3** 2', '10 ** -3 ** 2', 'a **b ** c', 'a ** b** c', 'p<0.05* and q<0.01**', 'x*', '**', '***', 'a ** ', '** a', '2 ^ 3 ** 2 ** 1',
  ];
  for (const text of literal) {
    const runs = parseInline(text);
    assert.equal(runsToPlainText(runs), text, `text preserved: ${text}`);
    assert.deepEqual(runs.filter(r => r.bold || r.italic), [], `no emphasis: ${text}`);
  }
});

test('emphasis: ordinary Markdown emphasis still works', () => {
  const cases: [string, string[], string[]][] = [
    ['**Abstract:** text', ['Abstract:'], []], ['a **b** c', ['b'], []], ['**bold** and **bold2**', ['bold', 'bold2'], []],
    ['(**bold**)', ['bold'], []], ['**bold**.', ['bold'], []], ['**50 V** applied', ['50 V'], []], ['*italic* word', [], ['italic']],
    ['word *italic*.', [], ['italic']], ['(*italic*)', [], ['italic']], ['Use **real bold** then 2 ** 8 ** 2 ok', ['real bold'], []],
    ['*italic* and **bold** and 5 * 3 ** 2', ['bold'], ['italic']],
  ];
  for (const [text, bold, italic] of cases) {
    const runs = parseInline(text);
    assert.deepEqual(runs.filter(r => r.bold).map(r => r.text), bold, text);
    assert.deepEqual(runs.filter(r => r.italic).map(r => r.text), italic, text);
  }
});

test('markdown: a spaced or purely numeric bold line is a paragraph, never a heading; real bold-line headings still work', () => {
  assert.deepEqual(parseMarkdown('** 3 **\n\n**100**\n\n**1. Introduction**\n\n**Abstract:**').map(b => b.kind), ['paragraph', 'paragraph', 'heading', 'heading']);
  const paragraph = parseMarkdown('** 3 **')[0];
  assert.ok(paragraph.kind === 'paragraph' && runsToPlainText(paragraph.runs) === '** 3 **');
});

const ARITHMETIC = 'Constants.\n\npower = 2 ** 3 ** 2\n\nProduct (a)*(b)*(c) and 5 * 3 ** 2 and 2**3**2.\n\n**Abstract:** *real* emphasis.';

test('DOCX export: spaced arithmetic is literal; real bold/italic still rendered', async () => {
  const { buffer } = await exportScientificDocument(request(ARITHMETIC), 'docx');
  const text = docxPlain(buffer);
  assert.ok(text.includes('power = 2 ** 3 ** 2'), 'power = 2 ** 3 ** 2');
  assert.ok(!text.includes('power = 2  3  2') && !text.includes('power = 2 3 2'));
  assert.ok(text.includes('(a)*(b)*(c)') && text.includes('5 * 3 ** 2') && text.includes('2**3**2'));
  assert.ok(text.includes('Abstract: real emphasis.'));
  const xml = docxXml(buffer);
  assert.ok(xml.includes('<w:b/>') && xml.includes('<w:i/>'));
});

test('PDF export: spaced arithmetic is literal in the extracted text', async () => {
  const text = await pdfText((await exportScientificDocument(request(ARITHMETIC), 'pdf')).buffer);
  assert.ok(text.includes('power = 2 ** 3 ** 2'), text);
  assert.ok(!/power = 2 3 2/.test(text));
  assert.ok(text.includes('(a)*(b)*(c)') && text.includes('5 * 3 ** 2') && text.includes('2**3**2'));
  assert.ok(text.includes('Abstract: real emphasis.'));
});

test('the exact audit example survives both formats: "power = 2 ** 3 ** 2"', async () => {
  for (const format of ['docx', 'pdf'] as const) {
    const { buffer } = await exportScientificDocument(request('power = 2 ** 3 ** 2', { title: undefined }), format);
    const text = format === 'docx' ? docxPlain(buffer) : await pdfText(buffer);
    assert.ok(text.includes('power = 2 ** 3 ** 2'), format);
  }
});

// =====================================================================================
// 3. Numbered lists with 4+ digit markers
// =====================================================================================

const MARKERS = ['99.', '100.', '101.', '1000.', '1001.'];
const LIST = MARKERS.map(m => `${m} Item ${m.slice(0, -1)}`).join('\n');

test('markdown: 99, 100, 101, 1000 and 1001 form ONE list with their own markers; bullets and ordinary numbering are unaffected', () => {
  const blocks = parseMarkdown(LIST);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].kind === 'list');
  assert.deepEqual(blocks[0].kind === 'list' && blocks[0].items.map(i => i.marker), MARKERS);
  assert.deepEqual(blocks[0].kind === 'list' && blocks[0].items.map(i => runsToPlainText(i.runs)), ['Item 99', 'Item 100', 'Item 101', 'Item 1000', 'Item 1001']);
  const mixed = parseMarkdown('- a\n- b\n\n1. one\n2) two\n\n10000. big');
  assert.deepEqual(mixed.map(b => b.kind === 'list' ? b.items.map(i => i.marker).join(',') : b.kind), ['•,•', '1.,2)', '10000.']);
  const notList = parseMarkdown('1.2 mm was measured.\n\n3.14 is pi.\n\n1000.5 is a number.');
  assert.ok(notList.every(b => b.kind === 'paragraph'), 'decimal numbers are not list markers');
});

test('DOCX: the 5-item list is one aligned list - same indent and tab stop for every item, wider than for short lists', async () => {
  const wide = docxXml((await exportScientificDocument(request(LIST), 'docx')).buffer);
  const narrow = docxXml((await exportScientificDocument(request('1. a\n2. b'), 'docx')).buffer);
  const threeDigit = docxXml((await exportScientificDocument(request('99. a\n100. b\n101. c'), 'docx')).buffer);
  const indents = [...wide.matchAll(/<w:ind w:left="(\d+)" w:hanging="(\d+)"\/>/g)].map(m => `${m[1]}/${m[2]}`);
  assert.equal(indents.length, 5);
  assert.equal(new Set(indents).size, 1, `all five items share one indent: ${indents}`);
  const tab = (xml: string) => Number(/w:tab w:val="left" w:pos="(\d+)"/.exec(xml)?.[1]);
  assert.equal(tab(narrow), 567);
  assert.ok(tab(wide) > tab(threeDigit), `4-digit markers need more room than 3-digit (${tab(wide)} vs ${tab(threeDigit)})`);
  const text = docxPlain(Buffer.from((await exportScientificDocument(request(LIST), 'docx')).buffer));
  for (const m of MARKERS) assert.ok(text.includes(`${m}\tItem ${m.slice(0, -1)}`), m);
});

test('PDF: markers 99, 100, 101, 1000 and 1001 each stay on one line with their text', async () => {
  const text = await pdfText((await exportScientificDocument(request(LIST), 'pdf')).buffer);
  for (const m of MARKERS) assert.ok(new RegExp(`(^|\\n)${m.replace('.', '\\.')}\\s+Item ${m.slice(0, -1)}(\\n|$)`).test(text), `${m}: ${JSON.stringify(text.slice(0, 160))}`);
});
