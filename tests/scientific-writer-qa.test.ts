import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import {
  checkPreservation, checkNoInventedNumbers, checkNoAddedSignificanceClaims, buildSafetyWarnings,
  buildSystemPrompt, buildGenerationPrompt, buildEvidenceReport, TRANSLATION_GLOSSARY,
  type ScientificWriterInput,
} from '../src/services/workspace/scientific-writer';
import { parseMarkdown, parseInline, runsToPlainText } from '../src/services/workspace/scientific-markdown';
import { buildScientificDocumentViewModel, exportScientificDocument, type ScientificExportRequest } from '../src/services/workspace/scientific-writer-export';
import { REFERENCE_TYPES, CITATION_STYLES, buildBibliography, type Reference } from '../src/services/workspace/references';
import { handleGenerate } from '../src/services/workspace/scientific-writer-handler';
import type { WriterProvider } from '../src/services/workspace/scientific-writer-provider';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');

// =====================================================================================
// Defect 1 - DOCX/PDF export: Markdown becomes real structure, title is not duplicated,
// service information is separated from the article text
// =====================================================================================

const TITLE = 'Magnetron deposition of AlTiN coating on high-speed steel';
const GENERATED = `**Title:** ${TITLE}

**Abstract:** Coatings were deposited at a substrate bias of −150 V; thickness was 0.9 µm and hardness 3.1 GPa.

**1. Introduction**

Diamond-like carbon (DLC) coatings are *widely* used. Расчёт 5*3.

**2.1 Deposition**

- Substrate: HSS at 400 °C
- Pressure: 1e-3 Pa

1. First step
2) Second step`;

function generatedRequest(overrides: Partial<ScientificExportRequest> = {}): ScientificExportRequest {
  return {
    documentType: 'article', title: TITLE, generatedByAI: true, sections: [{ heading: '', text: GENERATED }],
    providedFields: ['Название/тема'], missingFields: ['Выводы'], warnings: ['Тестовое предупреждение'], ...overrides,
  };
}

test('markdown parser: headings, bold-only heading lines, lists, inline bold/italic; unknown syntax stays verbatim', () => {
  const blocks = parseMarkdown('## Methods\n\n**1. Introduction**\n\n**Abstract:**\n\n**2.1 Sub**\n\nText with **bold** and *italic* and 5*3 and a*b*c.\n\n- one\n- two\n\n3. three\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---');
  const headings = blocks.filter(b => b.kind === 'heading');
  assert.deepEqual(headings.map(h => [runsToPlainText(h.runs), h.level]), [['Methods', 1], ['1. Introduction', 1], ['Abstract', 1], ['2.1 Sub', 2]]);
  const paragraph = blocks.find(b => b.kind === 'paragraph');
  assert.ok(paragraph && paragraph.kind === 'paragraph');
  assert.equal(runsToPlainText(paragraph.runs), 'Text with bold and italic and 5*3 and a*b*c.');
  assert.deepEqual(paragraph.runs.filter(r => r.bold).map(r => r.text), ['bold']);
  assert.deepEqual(paragraph.runs.filter(r => r.italic).map(r => r.text), ['italic']);
  const lists = blocks.filter(b => b.kind === 'list');
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[1].kind === 'list' && lists[1].items.map(i => i.marker), ['3.'], 'numbered items keep their own numbers');
  const table = blocks.filter(b => b.kind === 'paragraph').map(b => b.kind === 'paragraph' ? runsToPlainText(b.runs) : '').join('\n');
  assert.ok(table.includes('| a | b |') && table.includes('| 1 | 2 |'), 'table rows are kept as text, never dropped');
  assert.ok(!JSON.stringify(blocks).includes('---|---') === false, 'table separator row is kept too');
});

test('markdown parser: a bold SENTENCE is a paragraph, not a heading; a labelled lead-in keeps its text', () => {
  const blocks = parseMarkdown('**Note: results are preliminary.**\n\n**Abstract:** AlTiN was studied.');
  assert.ok(blocks.every(b => b.kind === 'paragraph'));
  const second = blocks[1];
  assert.ok(second.kind === 'paragraph');
  assert.equal(runsToPlainText(second.runs), 'Abstract: AlTiN was studied.');
  assert.deepEqual(parseInline('no markup here'), [{ text: 'no markup here' }]);
  assert.equal(runsToPlainText(parseInline('2 ** 3 and * alone *')), '2 ** 3 and * alone *');
});

test('view model (generated): no markers left, title used once, no type prefix, service info in the appendix', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest());
  assert.equal(vm.title, TITLE, 'document title is the title itself, not "Научная статья: ..."');
  assert.equal(vm.metadataPlacement, 'appendix');
  assert.ok(!vm.metadata.some(m => m.label === 'Тема'), 'the title is not repeated as a service-info row');
  const body = vm.sections.flatMap(s => s.paragraphs).join('\n');
  assert.ok(!body.includes('**'), 'no Markdown markers in the body');
  assert.equal(body.split(TITLE).length - 1, 0, 'the body does not repeat the title that is already the document title');
  assert.equal(vm.sections[0].heading, '', 'the single AI section has no extra type-label heading');
  assert.ok(vm.sections[0].blocks?.some(b => b.kind === 'heading'));
  assert.ok(body.includes('−150 V') && body.includes('0.9 µm') && body.includes('3.1 GPa') && body.includes('1e-3 Pa') && body.includes('5*3'), 'every scientific value survives');
});

test('view model: a body title that DIFFERS from the user title is kept, never silently dropped', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest({ title: 'A different working title' }));
  assert.equal(vm.title, 'A different working title');
  assert.ok(vm.sections[0].paragraphs.join('\n').includes(TITLE));
});

test('view model: with no user title, the generated title becomes the document title (once)', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest({ title: undefined }));
  assert.equal(vm.title, TITLE);
  assert.ok(!vm.sections[0].paragraphs.join('\n').includes(TITLE));
  const md = buildScientificDocumentViewModel(generatedRequest({ title: undefined, sections: [{ heading: '', text: `# ${TITLE}\n\n## Abstract\n\nText.` }] }));
  assert.equal(md.title, TITLE);
});

test('view model: a "# Abstract" document without "##" sections is NOT mistaken for having a title', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest({ title: undefined, sections: [{ heading: '', text: '# Abstract\n\nText.\n\n# Methods\n\nMore.' }] }));
  assert.equal(vm.title, 'Научная статья');
  assert.ok(vm.sections[0].paragraphs.includes('Abstract'));
});

test('local scaffold (non-AI) text is never parsed as Markdown: user data with asterisks is kept literally', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest({
    generatedByAI: false, sections: [{ heading: 'Results', text: 'Результаты: **не жирный** 5*3 *x*' }],
  }));
  assert.equal(vm.sections[0].blocks, undefined);
  assert.deepEqual(vm.sections[0].paragraphs, ['Результаты: **не жирный** 5*3 *x*']);
});

test('DOCX export of a generated draft: real headings/bold/lists, no "**", title once, service info after a page break', async () => {
  const { buffer } = await exportScientificDocument(generatedRequest(), 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  const text = docxPlain(buffer);
  assert.ok(!text.includes('**'), 'no Markdown markers remain');
  assert.equal(text.split(TITLE).length - 1, 1, 'the title appears exactly once');
  assert.ok((xml.match(/w:val="Heading1"/g) ?? []).length >= 2, 'section headings are real Heading 1 paragraphs');
  assert.ok(xml.includes('w:val="Heading2"'), 'sub-headings are Heading 2');
  assert.ok(xml.includes('w:val="Title"'));
  assert.ok(xml.includes('<w:b/>') && xml.includes('<w:i/>'), 'bold and italic runs exist');
  assert.ok(xml.includes('pageBreakBefore'), 'service information starts on its own page');
  assert.ok(text.indexOf('Служебная информация') > text.indexOf('Second step'), 'service information comes AFTER the article body');
  assert.ok(text.indexOf('Тип документа') > text.indexOf('Служебная информация'));
  for (const token of ['−150 V', '0.9 µm', '3.1 GPa', '400 °C', '1e-3 Pa', 'Diamond-like carbon (DLC)', 'Расчёт', '5*3']) assert.ok(text.includes(token), `DOCX keeps ${token}`);
  assert.ok(!text.slice(0, text.indexOf('Служебная информация')).includes('Тип документа'), 'no service metadata above the article text');
});

test('PDF export of a generated draft: no "**", real structure, µ − Cyrillic and scientific units extractable', async () => {
  const { buffer } = await exportScientificDocument(generatedRequest(), 'pdf');
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  const text = await pdfText(buffer);
  assert.ok(!text.includes('**'));
  assert.ok(text.indexOf('1. Introduction') >= 0 && text.indexOf('Abstract:') >= 0);
  assert.ok(text.indexOf('Служебная информация') > text.indexOf('Second step'), 'service information after the article');
  assert.match(text, /−150 V/);
  assert.match(text, /0\.9 [µμ]m/, 'µm (U+00B5 or U+03BC after PDF extraction normalisation)');
  assert.ok(text.includes('3.1 GPa') && text.includes('400 °C') && text.includes('Расчёт'));
});

test('export: Russian text with bold, "−" and units survives both formats', async () => {
  const request = generatedRequest({ title: 'Алмазоподобные покрытия', sections: [{ heading: '', text: '**1. Введение**\n\nНапряжение смещения составляло −150 В, толщина 0.9 мкм, твёрдость 3.1 ГПа.' }] });
  assert.ok(docxPlain((await exportScientificDocument(request, 'docx')).buffer).includes('−150 В, толщина 0.9 мкм, твёрдость 3.1 ГПа'));
  const pdf = await pdfText((await exportScientificDocument(request, 'pdf')).buffer);
  assert.ok(pdf.includes('−150 В') && pdf.includes('0.9 мкм') && pdf.includes('3.1 ГПа'));
});

test('export: an old client that still sends the document-type label as the only section heading gets no duplicate heading', () => {
  const vm = buildScientificDocumentViewModel(generatedRequest({ sections: [{ heading: 'Научная статья', text: GENERATED }] }));
  assert.equal(vm.sections[0].heading, '');
});

// =====================================================================================
// Defect 2 - preservation of numbers/units: equivalent notations match, real changes do not
// =====================================================================================

const preserved = (source: string, output: string, mode?: ScientificWriterInput['mode']) => checkPreservation(source, output, mode);

test('preservation: translated unit notation is the same quantity (V/В, µm/мкм, GPa/ГПа), including Greek mu and Cyrillic look-alikes', () => {
  assert.equal(preserved('Substrate bias was −150 V.', 'Напряжение смещения составляло −150 В.', 'translate_en_ru').ok, true);
  assert.equal(preserved('Thickness 0.9 µm.', 'Толщина 0.9 мкм.', 'translate_en_ru').ok, true);
  assert.equal(preserved('Thickness 0.9 μm.', 'Толщина 0.9 мкм.', 'translate_en_ru').ok, true);
  assert.equal(preserved('Hardness 3.1 GPa.', 'Твёрдость 3.1 ГПа.', 'translate_en_ru').ok, true);
  assert.equal(preserved('Давление 5 Па, 2 МПа, 10 нм, 3 мм, 4 мин.', 'Pressure 5 Pa, 2 MPa, 10 nm, 3 mm, 4 min.', 'translate_ru_en').ok, true);
  assert.equal(preserved('Температура 400 °С.', 'Temperature 400 °C.').ok, true, 'Cyrillic С in °С');
});

test('preservation: ranges and lists that share one unit compare equal however the unit is repeated', () => {
  assert.equal(preserved('Bias from -50 to -100 V.', 'Bias from −50 V to −100 V.').ok, true);
  assert.equal(preserved('Bias -50 and -100 V were used.', 'Applied −50 V and −100 V.').ok, true);
  assert.equal(preserved('Ra decreased from 1.2 to 1.1 µm.', 'Ra decreased from 1.2 µm to 1.1 µm.').ok, true);
  assert.equal(preserved('Values -50, -100, -150 V.', 'Values −50 V, −100 V, −150 V.').ok, true);
  assert.equal(preserved('Bias of 50-100 V.', 'Bias of 50 to 100 V.').ok, true, 'a range dash is not a minus sign');
  assert.equal(preserved('Ra 1.2–1.1 µm.', 'Ra 1.2 to 1.1 µm.').ok, true);
  assert.equal(preserved('Table 2, 5 µm.', 'Table 2. 5 µm.').ok, true, 'a number that only inherited a unit survives a punctuation change');
});

test('preservation: decimal separator, minus variants and whitespace variants', () => {
  assert.equal(preserved('Value 2,5 mm.', 'Value 2.5 mm.').ok, true);
  assert.equal(preserved('Bias -50 V.', 'Bias −50 V.').ok, true);
  assert.equal(preserved('Bias -50 V.', 'Bias −50 V.').ok, true);
  assert.equal(preserved('Bias -50 V.', 'Bias −50 V.').ok, true);
  assert.equal(preserved('Pressure 1e-3 Pa.', 'Pressure 1.0e-3 Pa.').ok, true);
});

test('preservation (protection NOT weakened): real changes are still detected', () => {
  const cases: [string, string][] = [
    ['Thickness 5 µm.', 'Thickness 15 nm.'], ['Temperature 10 °C.', 'Temperature 10 K.'], ['Pressure 1e-3 Pa.', 'Pressure 9e-3 Pa.'],
    ['Bias −150 V.', 'Bias 150 V.'], ['Bias −150 V.', 'Bias −130 V.'], ['Hardness 3.1 GPa.', 'Hardness 3.1 MPa.'],
    ['Thickness 0.9 µm.', 'Thickness 0.9 nm.'], ['Thickness 0.9 µm.', 'Thickness 0.9 мкм и 9 нм.'.replace('0.9 мкм', '0.8 мкм')],
    ['Bias from -50 to -100 V.', 'Bias from −50 V to −90 V.'], ['Bias of 50-100 V.', 'Bias of 50 to 90 V.'],
    ['Ra from 1.2 to 1.1 µm.', 'Ra from 1.2 µm to 1.3 µm.'], ['Hardness 3.1 GPa.', 'Hardness is high.'],
    ['Thickness 5 µm.', 'Thickness 5 mm.'],
  ];
  for (const [source, output] of cases) assert.equal(preserved(source, output).ok, false, `${source} -> ${output}`);
  assert.equal(preserved('Hardness 3.1 GPa.', 'Твёрдость 3.1 МПа.', 'translate_en_ru').ok, false, 'a translation that changes GPa to МПа is still caught');
  assert.equal(preserved('Bias −150 V.', 'Напряжение −150 В и ещё 30 В.', 'translate_en_ru').ok, true, 'extra numbers in the output are not a loss (invented numbers have their own check)');
});

test('preservation: an explicit unit in the source cannot be satisfied by a different unit on the same value', () => {
  const result = preserved('Layer of 15 GPa.', 'Layer of 15 min.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingNumbers, ['15 GPa']);
});

test('preservation (translation): ordinary English words are not "lost protected terms", acronyms still are', () => {
  const source = 'PVD at low pressure and plasma temperature of 400 °C.';
  assert.equal(preserved(source, 'PVD при низком давлении и температуре плазмы 400 °C.', 'translate_en_ru').ok, true);
  const dropped = preserved(source, 'Осаждение при низком давлении и температуре плазмы 400 °C.', 'translate_en_ru');
  assert.equal(dropped.ok, false);
  assert.deepEqual(dropped.missingTerms, ['PVD']);
  assert.equal(preserved(source, 'PVD at low pressure and 400 °C.', 'rewrite').ok, false, 'in rewrite mode the English words are still protected');
});

test('invented-number check understands equivalent notation (no false "not confirmed by user" for translated units/ranges)', () => {
  const input: ScientificWriterInput = { documentType: 'article', mode: 'translate_en_ru', targetLanguage: 'ru', sourceText: 'Bias was −150 V, thickness 0.9 µm, hardness 3.1 GPa, from -50 to -100 V.' };
  assert.equal(checkNoInventedNumbers(input, 'Смещение −150 В, толщина 0.9 мкм, твёрдость 3.1 ГПа, от −50 до −100 В.').ok, true);
  assert.equal(checkNoInventedNumbers(input, 'Смещение −150 В, толщина 0.9 мкм, твёрдость 4.1 ГПа.').ok, false);
});

test('preservation through the real generate handler: faithful EN->RU output raises no warnings; a changed value does', async () => {
  const stub = (text: string): WriterProvider => ({ id: 'stub', configured: () => true, generate: async () => ({ text }) });
  const request = { documentType: 'article', mode: 'translate_en_ru', targetLanguage: 'ru', sourceText: 'Substrate bias was −150 V; thickness was 0.9 µm; hardness was 3.1 GPa.' };
  const ok = await handleGenerate(request, stub('Напряжение смещения составляло −150 В; толщина составляла 0.9 мкм; твёрдость составляла 3.1 ГПа.'));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.warnings, []);
  assert.equal((ok.body.preservation as { ok: boolean }).ok, true);
  const bad = await handleGenerate(request, stub('Напряжение смещения составляло −150 В; толщина составляла 0.9 мкм; твёрдость составляла 3.7 ГПа.'));
  assert.ok((bad.body.warnings as string[]).some(w => w.includes('3.1 GPa')));
});

// =====================================================================================
// Defects 3 + 4 - provider instructions (instructions only: model behaviour is not tested)
// =====================================================================================

test('translation prompts: translate every sentence fully, keep negations/quantities/materials, never replace content by "Недостаточно данных"', () => {
  for (const mode of ['translate_en_ru', 'translate_ru_en'] as const) {
    const prompt = buildSystemPrompt(mode, mode === 'translate_en_ru' ? 'ru' : 'en');
    assert.ok(!prompt.includes('вместо того, чтобы придумывать содержание'), `${mode}: the drafting placeholder rule must not apply to translation`);
    assert.match(prompt, /Фразу "Недостаточно данных" в этом режиме НЕ используй/);
    assert.match(prompt, /No experimental data on adhesion strength or wear rate were provided/);
    assert.match(prompt, /Переводи ВСЕ предложения полностью/);
    assert.match(prompt, /отрицания и ограничения/);
    assert.match(prompt, /числовые значения со знаком/);
    assert.match(prompt, /не заменяй конкретное утверждение общей фразой/);
  }
});

test('translation prompts: domain terminology glossary (DLC -> алмазоподобные углеродные покрытия) and unit notation', () => {
  const prompt = buildSystemPrompt('translate_en_ru', 'ru');
  assert.ok(prompt.includes('diamond-like carbon (DLC) coatings = алмазоподобные углеродные покрытия (DLC)'));
  assert.ok(!/покрытия, подобные алмазу/i.test(prompt));
  for (const [en, ru] of TRANSLATION_GLOSSARY) assert.ok(prompt.includes(`${en} = ${ru}`), en);
  assert.match(prompt, /V ↔ В, µm ↔ мкм, GPa ↔ ГПа/);
  assert.match(buildSystemPrompt('translate_ru_en', 'en'), /алмазоподобные углеродные покрытия/);
});

test('rewrite/edit prompts: no invented significance, no strengthened conclusions, no new results, keep the source meaning', () => {
  for (const mode of ['rewrite', 'edit'] as const) {
    const prompt = buildSystemPrompt(mode, 'en');
    assert.match(prompt, /Не добавляй утверждений о статистической значимости/);
    assert.ok(prompt.includes('"significantly"'));
    assert.match(prompt, /Не усиливай и не ослабляй выводы/);
    assert.match(prompt, /Не вводи новые результаты/);
    assert.match(prompt, /сохраняй степень уверенности/);
    assert.match(prompt, /Фразу "Недостаточно данных" в этом режиме НЕ используй/);
  }
});

test('draft prompt keeps the "Недостаточно данных" placeholder, the no-significance rule and a heading format the exporter understands', () => {
  const prompt = buildSystemPrompt('draft', 'en');
  assert.match(prompt, /Для разделов без данных напиши "Недостаточно данных"/);
  assert.match(prompt, /вместо того, чтобы придумывать содержание/);
  assert.match(prompt, /Не утверждай статистическую значимость/);
  assert.match(prompt, /"# Название"/);
  const input: ScientificWriterInput = { documentType: 'article', mode: 'draft', targetLanguage: 'en', title: 'T' };
  assert.ok(buildGenerationPrompt(input, buildEvidenceReport(input)).system.includes('Недостаточно данных'));
});

test('added-significance check: flags "significantly" that the source never used; silent when the source had it', () => {
  assert.deepEqual(checkNoAddedSignificanceClaims('Hardness increased from 20 to 25 GPa.', 'Hardness increased significantly from 20 to 25 GPa.').added, ['significantly']);
  assert.equal(checkNoAddedSignificanceClaims('The difference was significant (p < 0.05).', 'The difference was significant (p < 0.05).').ok, true);
  assert.equal(checkNoAddedSignificanceClaims('Твёрдость выросла.', 'Твёрдость выросла статистически значимо.').ok, false);
  assert.equal(checkNoAddedSignificanceClaims('Твёрдость выросла.', 'Твёрдость выросла.').ok, true);
});

test('safety warnings: rewrite/edit adds the significance warning; translation does not apply it', () => {
  const base = { documentType: 'article', targetLanguage: 'en', sourceText: 'Hardness increased from 20 to 25 GPa.' } as const;
  const output = 'Hardness increased significantly from 20 to 25 GPa.';
  for (const mode of ['rewrite', 'edit'] as const) {
    const input: ScientificWriterInput = { ...base, mode };
    const warnings = buildSafetyWarnings(input, output, checkPreservation(base.sourceText, output, mode));
    assert.ok(warnings.some(w => w.includes('значимости') && w.includes('significantly')), mode);
  }
  const translate: ScientificWriterInput = { ...base, mode: 'translate_ru_en' };
  assert.ok(!buildSafetyWarnings(translate, output, null).some(w => w.includes('значимости')));
});

// =====================================================================================
// Additional check - bibliography formatting differs by source type
// =====================================================================================

const SAMPLE = { authors: ['Smith J.', 'Doe A.'], title: 'Sample title', containerTitle: 'Container Name', year: 2020, volume: '12', issue: '3', pages: '45-67', doi: '10.1234/abc.1' };
const refOf = (type: Reference['type'], extra: Partial<Reference> = {}): Reference => ({ id: type, type, ...SAMPLE, ...extra });
const render = (type: Reference['type'], style: (typeof CITATION_STYLES)[number], extra: Partial<Reference> = {}) => buildBibliography([refOf(type, extra)], style).entries[0].text;

test('references: the seven types are no longer formatted identically in any style', () => {
  for (const style of CITATION_STYLES) {
    const texts = REFERENCE_TYPES.map(type => render(type, style, type === 'website' ? { doi: undefined, url: 'https://example.test/p', accessDate: '2026-01-01' } : {}));
    // Before the fix all six non-web types were byte-identical (1 distinct string + website = 2).
    // Journal/conference (and, in APA/GOST, book/report) legitimately share a layout.
    assert.ok(new Set(texts).size >= 5, `${style}: only ${new Set(texts).size} distinct layouts for 7 types`);
    for (const other of ['book_chapter', 'thesis', 'website', 'book'] as const) assert.notEqual(render('journal_article', style), render(other, style, other === 'website' ? { url: 'https://example.test/p' } : {}), `${style}: journal vs ${other}`);
  }
});

test('references (APA): journal keeps volume/issue/pages; book/report have none; chapter uses "In ... (pp.)"; thesis is labelled; website shows the access date', () => {
  assert.equal(render('journal_article', 'apa'), 'Smith J. & Doe A. (2020). Sample title. Container Name, 12(3), 45-67. https://doi.org/10.1234/abc.1');
  assert.equal(render('book', 'apa'), 'Smith J. & Doe A. (2020). Sample title. Container Name. https://doi.org/10.1234/abc.1');
  assert.equal(render('report', 'apa'), 'Smith J. & Doe A. (2020). Sample title. Container Name. https://doi.org/10.1234/abc.1');
  assert.equal(render('book_chapter', 'apa'), 'Smith J. & Doe A. (2020). Sample title. In Container Name (pp. 45-67). https://doi.org/10.1234/abc.1');
  assert.equal(render('thesis', 'apa'), 'Smith J. & Doe A. (2020). Sample title [Dissertation, Container Name]. https://doi.org/10.1234/abc.1');
  assert.equal(render('website', 'apa', { doi: undefined, url: 'https://example.test/p', accessDate: '2026-01-01', volume: undefined, issue: undefined, pages: undefined }),
    'Smith J. & Doe A. (2020). Sample title. Container Name. Retrieved 2026-01-01, from https://example.test/p');
  assert.ok(!render('book', 'apa').includes('12(3)') && !render('book', 'apa').includes('45-67'));
});

test('references (IEEE): conference "in Proc.", chapter "in", book without quotes, thesis, report, website accessed date', () => {
  assert.equal(render('journal_article', 'ieee'), '[1] Smith J. and Doe A., "Sample title," Container Name, vol. 12, no. 3, pp. 45-67, 2020, doi: 10.1234/abc.1.');
  assert.equal(render('conference_paper', 'ieee'), '[1] Smith J. and Doe A., "Sample title," in Proc. Container Name, 2020, pp. 45-67, doi: 10.1234/abc.1.');
  assert.equal(render('book_chapter', 'ieee'), '[1] Smith J. and Doe A., "Sample title," in Container Name, pp. 45-67, 2020, doi: 10.1234/abc.1.');
  assert.equal(render('book', 'ieee'), '[1] Smith J. and Doe A., Sample title. Container Name, 2020, doi: 10.1234/abc.1.');
  assert.ok(render('thesis', 'ieee').includes('Dissertation, Container Name, 2020'));
  assert.ok(render('report', 'ieee').includes('Container Name, Rep., 2020'));
  assert.ok(render('website', 'ieee', { doi: undefined, url: 'https://example.test/p', accessDate: '2026-01-01' }).includes('(accessed 2026-01-01)'));
});

test('references (GOST-style): "//" only for components of a larger work; book/report/thesis use "– Publisher, year"; website gets the access date', () => {
  assert.ok(render('journal_article', 'gost').includes('// Container Name.'));
  assert.ok(render('conference_paper', 'gost').includes('// Container Name.'));
  assert.ok(render('book_chapter', 'gost').includes('// Container Name.'));
  for (const type of ['book', 'report', 'thesis'] as const) assert.ok(!render(type, 'gost').includes('//'), `${type} must not use "//"`);
  assert.ok(render('book', 'gost').includes('Sample title. – Container Name, 2020.'));
  assert.ok(render('thesis', 'gost').includes('Sample title : дис. – Container Name, 2020.'));
  assert.ok(render('website', 'gost', { doi: undefined, url: 'https://example.test/p', accessDate: '2026-01-01' }).includes('(дата обращения: 2026-01-01)'));
  assert.ok(!render('book', 'gost').includes('Т./№'), 'a book has no volume/issue');
});

test('references: no doubled period after author initials, no invented fields when data is missing', () => {
  for (const style of CITATION_STYLES) assert.ok(!/\.\./.test(render('journal_article', style)), `${style}: no ".."`);
  const sparse: Reference = { id: 'x', type: 'book', authors: [], title: 'Only a title' };
  for (const style of CITATION_STYLES) {
    const text = buildBibliography([sparse], style).entries[0].text;
    assert.ok(text.includes('Only a title'));
    assert.ok(!/undefined|null|NaN/.test(text), `${style}: ${text}`);
  }
  assert.ok(!buildBibliography([{ ...sparse, type: 'website', url: 'https://example.test' }], 'apa').entries[0].text.includes('Retrieved'));
});
