import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import PDFDocument from 'pdfkit';
import { readZipEntryText } from './helpers/zip-reader';
import {
  createBlankDocument, addStep, updateStep, addSource, updateSource, addGas, updateGas, updateLayer, setCoatingMode, stepUnits,
  buildTechnologicalCard, hasLongList, type TechnicalProcessDocument, type ProcessStep,
} from '../src/services/workspace/techdoc-assistant';
import {
  estimateLines, chunkText, splitTallRows, columnWidthPt, CARD_GAS_COLUMN, CARD_COLUMN_WEIGHTS, CARD_CELL_LINE_BUDGET, CARD_ROW_LINE_LIMIT, CHUNK_MARKER_RE,
  WORST_CHAR_PT, TYPICAL_CHAR_PT, CONTINUATION_CELL, joinChunkCells,
} from '../src/services/workspace/techdoc-card-layout';
import { buildDocumentViewModel, exportTechDoc } from '../src/services/workspace/techdoc-export';
import { pdfText as displayText } from '../src/services/workspace/document-export';

async function pdfPages(buffer: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.pages.map((page: { text: string }) => page.text.replace(/μ/g, 'µ').replace(/([–/])\s+(?=[\dа-яa-z])/gi, '$1').replace(/\s+/g, ' '));
  } finally { await parser.destroy(); }
}
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const flat = (text: string) => text.replace(/\s+/g, ' ');

const phrase = (tag: string, length: number) => `${tag} газовая смесь высокой чистоты марки А для плазменной обработки `.repeat(Math.ceil(length / 40)).slice(0, length).trim();

/** Cards: 1 = loading, 2 = adhesion underlayer (30 min) carrying `gases` / `materials`. Values are TEST DATA. */
function docWith(configure: (steps: ProcessStep[]) => ProcessStep[]): TechnicalProcessDocument {
  let steps = updateStep(addStep(addStep([], 'loading'), 'adhesion_underlayer'), 2, { durationMin: 30 });
  steps = configure(steps);
  return { ...createBlankDocument(), general: { processName: 'Long' }, steps };
}
function gasDoc(names: string[]): TechnicalProcessDocument {
  return docWith(steps => {
    names.forEach((name, i) => { steps = updateGas(addGas(steps, { order: 2 }), { order: 2 }, `gas-${i + 1}`, { gas: name, flowSccm: 10 * (i + 1), startMin: i, durationMin: 10 }); });
    return steps;
  });
}
function materialDoc(materials: string[]): TechnicalProcessDocument {
  return docWith(steps => {
    materials.forEach((m, i) => { steps = updateSource(addSource(steps, { order: 2 }, 'magnetron'), { order: 2 }, `magnetron-${i + 1}`, { material: m, powerW: 100 * (i + 1), startMin: i, durationMin: 10 }); });
    return steps;
  });
}
const step = (doc: TechnicalProcessDocument, order: number) => doc.steps.find(s => s.order === order)!;
const unitOf = (doc: TechnicalProcessDocument, order: number) => stepUnits(step(doc, order))[0];
const longNames = [1, 2, 3, 4].map(i => phrase(`L${i}`, 285));
const GAS_NAME_WIDTH = columnWidthPt([6, 16, 12, 16, 10, 16, 24], 3); // the gas-name column of the gas detail table

// =====================================================================================
// Content-size rule: when a source / gas list moves out of the card cell into a detail table
// =====================================================================================

test('size rule: four SHORT gas lines stay inline - one table, the full text in the card cell, no note', () => {
  const doc = gasDoc(['Ar', 'N2', 'C2H2', 'O2']);
  assert.equal(hasLongList(unitOf(doc, 2), 'gases'), false);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 1);
  assert.equal(vm.tables[0].rows.find(r => r[0] === '2')![5], buildTechnologicalCard(doc).find(r => r.number === 2)!.gases);
  assert.ok(!vm.sections.flatMap(s => s.paragraphs).join(' ').includes('слишком велик'));
});

test('size rule (audit case): four gas lines of ~285 characters get a detail table, one record per row, each with step number and name', () => {
  const doc = gasDoc(longNames);
  assert.ok(longNames[0].length >= 280);
  assert.equal(hasLongList(unitOf(doc, 2), 'gases'), true, 'four items, but too much text for a cell');
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 2);
  const gasTable = vm.tables[1];
  assert.equal(gasTable.heading, 'Этап №2 «Адгезионный подслой»: газовые линии');
  assert.equal(gasTable.rows.length, 4);
  gasTable.rows.forEach((row, i) => {
    assert.deepEqual([row[0], row[1], row[2], row[3]], ['2', 'Адгезионный подслой', `Линия gas-${i + 1}`, longNames[i]], 'full gas name, nothing cut');
    assert.deepEqual(row.slice(4), ['ВКЛ', `${10 * (i + 1)} sccm`, `${i}–${i + 10} мин`]);
  });
  assert.ok(vm.sections.flatMap(s => s.paragraphs).join(' ').includes('слишком велик'));
});

test('size rule: long materials of sources are detected the same way as long gas names (four magnetrons)', () => {
  const doc = materialDoc([1, 2, 3, 4].map(i => phrase(`M${i}`, 200)));
  assert.equal(hasLongList(unitOf(doc, 2), 'sources'), true);
  const table = buildDocumentViewModel(doc, 'technologicalCard').tables.find(t => t.heading.endsWith(': источники'))!;
  assert.equal(table.rows.length, 4);
  table.rows.forEach((row, i) => assert.deepEqual([row[0], row[1], row[2], row[3], row[5], row[6]], ['2', 'Адгезионный подслой', `Магнетрон magnetron-${i + 1}`, phrase(`M${i + 1}`, 200), `мощность — ${100 * (i + 1)} Вт`, `${i}–${i + 10} мин`]));
  const short = materialDoc(['Ti', 'Cr', 'Zr', 'Al']);
  assert.equal(hasLongList(unitOf(short, 2), 'sources'), false);
});

test('size rule: five ordinary gas lines move to a table', () => {
  const five = gasDoc(['Ar', 'N2', 'C2H2', 'O2', 'He']);
  assert.equal(hasLongList(unitOf(five, 2), 'gases'), true);
  assert.equal(buildDocumentViewModel(five, 'technologicalCard').tables[1].rows.length, 5);
});

/** Cards: 2 = adhesion with 25 magnetrons (Target-i, 100*i W), one OFF arc source and 12 gas lines; 3 = coating (single layer) with 12 gas lines (long names) and one magnetron. */
function bigDoc(longGasNames = false): TechnicalProcessDocument {
  const names = ['Ar', 'N2', 'C2H2', 'O2', 'He', 'H2', 'Kr', 'Xe', 'CH4', 'NH3', 'Ne', 'SiH4'];
  const gasName = (i: number) => longGasNames ? phrase(`G${i + 1}`, 285) : names[i];
  let steps = updateStep(addStep(addStep(addStep([], 'loading'), 'adhesion_underlayer'), 'multilayer_coating'), 2, { durationMin: 30, temperatureC: 350, pressurePa: 0.5 });
  for (let i = 1; i <= 25; i++) steps = updateSource(addSource(steps, { order: 2 }, 'magnetron'), { order: 2 }, `magnetron-${i}`, { material: `Target-${i}`, powerW: 100 * i, startMin: i % 5, durationMin: 10 });
  steps = updateSource(addSource(steps, { order: 2 }, 'arc'), { order: 2 }, 'arc-1', { material: 'Cr', filtered: true, currentA: 80, startMin: 5, durationMin: 10, enabled: false });
  for (let i = 1; i <= 12; i++) steps = updateGas(addGas(steps, { order: 2 }), { order: 2 }, `gas-${i}`, { gas: gasName(i - 1), flowSccm: 5 * i, startMin: i, durationMin: 10 });
  steps = setCoatingMode(steps, 3, 'single');
  const layer = { order: 3, layerId: 'layer-1' };
  steps = updateLayer(steps, 3, 'layer-1', { durationMin: 60, material: 'TiN' });
  for (let i = 1; i <= 12; i++) steps = updateGas(addGas(steps, layer), layer, `gas-${i}`, { gas: gasName(i - 1), flowSccm: 5 * i, startMin: 0, durationMin: 10 });
  steps = updateSource(addSource(steps, layer, 'magnetron'), layer, 'magnetron-1', { material: 'Ti', powerW: 1234, startMin: 0, durationMin: 60 });
  return { ...createBlankDocument(), general: { processName: 'Big' }, steps };
}

test('long lists: a card whose lists do not fit a cell gets its own detail table - one item per row - and a pointer in the card row; a coating layer gets its own tables', () => {
  const doc = bigDoc();
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.deepEqual(vm.tables.map(t => t.heading), [
    'Технологическая карта',
    'Этап №2 «Адгезионный подслой»: источники', 'Этап №2 «Адгезионный подслой»: газовые линии',
    'Этап №3 «Многослойное покрытие»: слои покрытия', 'Этап №3 «Многослойное покрытие», слой 1: газовые линии',
  ], 'the single magnetron of the layer is short, so only its gas lines move out');
  const [main, sources2, gas2, layers3, gas3] = vm.tables;
  const row2 = main.rows.find(r => r[0] === '2')!;
  assert.ok(row2[6].includes('источников: 26 (включено 25) - полный перечень в таблице «Этап №2 «Адгезионный подслой»: источники» ниже'));
  assert.ok(row2[5].includes('газовых линий: 12 (включено 12) - полный перечень в таблице «Этап №2 «Адгезионный подслой»: газовые линии» ниже'));
  assert.ok(!row2[6].includes('Target-1'), 'the card row itself no longer carries the long text');
  assert.equal(sources2.rows.length, 26);
  assert.equal(gas2.rows.length, 12);
  assert.equal(layers3.rows.length, 1);
  assert.equal(gas3.rows.length, 12);
  for (const table of [sources2, gas2, gas3, layers3]) {
    for (const row of table.rows) assert.equal(row.length, table.columns.length, 'every row has a cell for every column');
    assert.ok(table.rows.every(r => r[0] === table.rows[0][0] && r[1] === table.rows[0][1]), 'every row repeats the step number and name');
  }
  assert.deepEqual(gas3.columns.slice(0, 4), ['№ этапа', 'Этап', 'Слой', 'Линия']);
  assert.deepEqual(gas3.rows[0].slice(0, 3), ['3', 'Многослойное покрытие', '1']);
  assert.ok(layers3.rows[0][10].includes('Магнетрон magnetron-1') && layers3.rows[0][11].includes('газовых линий: 12'), 'the layer row carries the short source inline and points at the gas table');
});

test('long lists: no value is lost - every source and gas line appears in its own row with material, state, values, window and mode', () => {
  const doc = bigDoc();
  const tables = buildDocumentViewModel(doc, 'technologicalCard').tables;
  const sources2 = tables[1];
  for (let i = 1; i <= 25; i++) {
    assert.deepEqual(sources2.rows[i - 1].slice(2), [`Магнетрон magnetron-${i}`, `Target-${i}`, 'ВКЛ', `мощность — ${100 * i} Вт`, `${i % 5}–${(i % 5) + 10} мин`, 'одновременно'], `magnetron-${i}`);
  }
  assert.deepEqual(sources2.rows[25].slice(2), ['Вакуумно-дуговой источник arc-1', 'Cr, фильтрованный', 'ОТКЛ', '—', '—', '—'], 'an OFF source is stated as OFF, material kept');
  const names = ['Ar', 'N2', 'C2H2', 'O2', 'He', 'H2', 'Kr', 'Xe', 'CH4', 'NH3', 'Ne', 'SiH4'];
  for (const [table, withLayer] of [[tables[2], false], [tables[4], true]] as const) {
    for (let i = 1; i <= 12; i++) {
      const row = table.rows[i - 1];
      assert.deepEqual(withLayer ? row.slice(3) : row.slice(2), [`Линия gas-${i}`, names[i - 1], 'ВКЛ', `${5 * i} sccm`, withLayer ? '0–10 мин' : `${i}–${i + 10} мин`], `gas-${i}`);
    }
  }
});

test('long lists: the on-screen preview rows hold the complete text; only the DOCX/PDF card row points at the tables', () => {
  const doc = bigDoc();
  const full = buildTechnologicalCard(doc).find(r => r.number === 2)!;
  for (let i = 1; i <= 25; i++) assert.ok(full.sources.includes(`Магнетрон magnetron-${i} (мишень: Target-${i}): ВКЛ, мощность — ${100 * i} Вт`), `preview magnetron-${i}`);
  assert.ok(full.gases.includes('Линия gas-12 (газ: SiH4): ВКЛ, расход — 60 sccm'));
  const compact = buildTechnologicalCard(doc, { compactLongLists: true }).find(r => r.number === 2)!;
  assert.ok(compact.sources.includes('полный перечень в таблице') && compact.gases.includes('полный перечень в таблице'));
});

test('PDF: the long card runs onto further pages - every page of a table repeats the column header, every row carries its step, nothing is lost or cut', async () => {
  const pages = await pdfPages((await exportTechDoc(bigDoc(), 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 4, `expected the card to need several pages, got ${pages.length}`);
  const sourcePages = pages.filter(text => /(^| )2 Адгезионный подслой Магнетрон magnetron-/.test(text));
  assert.ok(sourcePages.length >= 2, 'the source table spans at least two pages');
  for (const text of sourcePages) assert.ok(/№ этапа Этап Источник Материал Состояние Значения Время Режим/.test(text), 'the header is repeated on every page of the source table');
  const gasPages = pages.filter(text => /(^| )2 Адгезионный подслой Линия gas-\d+/.test(text));
  assert.ok(gasPages.length >= 1);
  for (const text of gasPages) assert.ok(/№ этапа Этап Линия Газ Состояние Расход Время подачи/.test(text), 'the gas table header is repeated too');
  const all = pages.join(' ');
  assert.equal((all.match(/(^| )2 Адгезионный подслой (Магнетрон magnetron-\d+|Вакуумно-дуговой источник arc-1)/g) ?? []).length, 26);
  assert.equal((all.match(/(^| )2 Адгезионный подслой Линия gas-\d+/g) ?? []).length, 12);
  assert.equal((all.match(/(^| )3 Многослойное покрытие 1 Линия gas-\d+/g) ?? []).length, 12, 'the layer number is on every row of the layer table');
  const order = [...all.matchAll(/2 Адгезионный подслой Магнетрон magnetron-(\d+) Target-\d+/g)].map(m => Number(m[1]));
  assert.deepEqual(order, Array.from({ length: 25 }, (_, i) => i + 1), 'order is preserved across page breaks');
  for (let i = 1; i <= 25; i++) assert.ok(all.includes(`magnetron-${i} Target-${i} ВКЛ мощность — ${100 * i} Вт ${i % 5}–${(i % 5) + 10} мин одновременно`), `row ${i} is complete and in one piece`);
  assert.ok(all.includes('Traceability Процесс: Big'), 'the block after the last table is complete');
});

test('25 magnetrons together with long gas lines (285 characters each) on the card and on the layer: both detail tables are built, nothing is lost', async () => {
  const doc = bigDoc(true);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  const layerGas = vm.tables.find(t => t.heading === 'Этап №3 «Многослойное покрытие», слой 1: газовые линии')!;
  assert.ok(layerGas.rows.length >= 12, 'every line has at least one row (a very narrow column may split one name over several rows)');
  for (let i = 1; i <= 12; i++) {
    const pieces = layerGas.rows.filter(r => r[3] === `Линия gas-${i}`).map(r => r[4]);
    assert.equal(joinChunkCells(pieces), phrase(`G${i}`, 285), `gas ${i} is complete`);
  }
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 6);
  assert.ok(pages.join(' ').includes(phrase('G1', 285).slice(0, 40)));
});

test('PDF: a short card is still one page-sized table without detail tables', async () => {
  const pages = await pdfPages((await exportTechDoc(gasDoc(['Ar', 'N2']), 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length <= 2);
  assert.ok(!pages.join(' ').includes('№ этапа Этап Линия'), 'no detail table for short lists');
});

test('DOCX: the long card keeps every value; each table has a repeating header row', async () => {
  const { buffer } = await exportTechDoc(bigDoc(), 'technologicalCard', 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  const text = flat(docxPlain(buffer));
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 5, 'main + sources + gas + layers + layer gas tables, each with a repeating header');
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 5);
  for (let i = 1; i <= 25; i++) assert.ok(text.includes(`Магнетрон magnetron-${i}`) && text.includes(`Target-${i}`) && text.includes(`мощность — ${100 * i} Вт`) && text.includes(`${i % 5}–${(i % 5) + 10} мин`), `magnetron-${i}`);
  for (let i = 1; i <= 12; i++) assert.ok(text.includes(`Линия gas-${i}`) && text.includes(`${5 * i} sccm`));
  assert.ok(text.includes('Вакуумно-дуговой источник arc-1') && text.includes('Cr, фильтрованный') && text.includes('ОТКЛ'));
  assert.ok(text.includes('Этап №2 «Адгезионный подслой»: источники') && text.includes('Этап №3 «Многослойное покрытие», слой 1: газовые линии'));
});

test('PDF (audit case): four 285-character gas lines span pages; every page of the gas table repeats the header; every row has step number and name; no text is lost', async () => {
  const pages = await pdfPages((await exportTechDoc(gasDoc(longNames), 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 3, `expected the detail table to continue on a further page, got ${pages.length}`);
  const gasPages = pages.filter(t => /2 Адгезионный подслой Линия gas-\d/.test(t));
  assert.ok(gasPages.length >= 2, 'the table itself continues on a second page');
  for (const t of gasPages) assert.ok(t.includes('№ этапа Этап Линия Газ Состояние Расход Время подачи'), 'column header repeated on the continuation page');
  const all = pages.join(' ');
  assert.equal((all.match(/2 Адгезионный подслой Линия gas-\d/g) ?? []).length, 4, 'step number+name in each of the four rows');
  for (const [i, name] of longNames.entries()) assert.ok(all.includes(name.slice(0, 60)) && all.includes(`${10 * (i + 1)} sccm`), `gas-${i + 1}`);
  assert.ok(all.includes('Traceability'), 'the document tail is intact');
});

test('one enormous record: a single 6000-character gas name is split into marked pieces; every piece repeats step and line, the pieces rebuild the name exactly', async () => {
  const name = phrase('HUGE', 6000);
  const doc = gasDoc([name]);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  const rows = vm.tables[1].rows;
  assert.ok(rows.length >= 3);
  rows.forEach((row, i) => {
    assert.deepEqual(row.slice(0, 3), ['2', 'Адгезионный подслой', 'Линия gas-1'], 'context in every piece');
    assert.ok(row[3].startsWith(`[${i + 1}/${rows.length}] `));
    if (i === 0) assert.deepEqual(row.slice(4), ['ВКЛ', '10 sccm', '0–10 мин']);
    else assert.deepEqual(row.slice(4), [CONTINUATION_CELL, CONTINUATION_CELL, CONTINUATION_CELL], 'no empty cell and no copied value');
    assert.ok(estimateLines(row[3], GAS_NAME_WIDTH, WORST_CHAR_PT) <= CARD_ROW_LINE_LIMIT, 'each piece fits a page');
  });
  assert.equal(joinChunkCells(rows.map(r => r[3])), name, 'lossless, character for character');
  assert.ok(vm.sections.flatMap(s => s.paragraphs).join(' ').includes('[k/n]'), 'the note explains the markers');
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.equal((pages.join(' ').match(/2 Адгезионный подслой Линия gas-1 /g) ?? []).length, rows.length);
  for (const t of pages.filter(p => /2 Адгезионный подслой Линия gas-1 \[/.test(p))) assert.ok(t.includes('№ этапа Этап Линия Газ'), 'header on every page holding pieces');
});

test('main card rows too: a 5000-character description is split into marked rows instead of overflowing the page; step number and name are repeated', async () => {
  const text = phrase('CRIT', 5000);
  const doc = docWith(steps => updateStep(steps, 2, { description: text }));
  const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[0].rows.filter(r => r[0] === '2');
  assert.ok(rows.length >= 2);
  rows.forEach(r => assert.deepEqual([r[0], r[1]], ['2', 'Адгезионный подслой']));
  assert.equal(joinChunkCells(rows.map(r => r[9])), text);
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 2 && pages.slice(1).some(t => t.includes('Операция')), 'continuation pages keep the card header');
});

// =====================================================================================
// Layout helpers, exact splitting, PDF display text of line breaks
// =====================================================================================

test('layout helpers: estimateLines / chunkText / splitTallRows keep everything and leave short rows alone', () => {
  assert.equal(estimateLines('', 100, 6.4), 1);
  assert.equal(estimateLines('a\nb', 100, 6.4), 2);
  assert.equal(estimateLines('x'.repeat(100), 64, 6.4), 10, 'a word longer than a line is broken');
  const text = phrase('T', 3000);
  const parts = chunkText(text, 100, WORST_CHAR_PT, 20);
  assert.ok(parts.length > 1 && parts.every(p => estimateLines(p, 100, WORST_CHAR_PT) <= 20));
  assert.equal(parts.join(''), text);
  assert.equal(chunkText('x'.repeat(1000), 100, WORST_CHAR_PT, 3).join(''), 'x'.repeat(1000), 'an unbroken word is sliced without loss');
  const short = [['1', 'a', 'b']];
  assert.deepEqual(splitTallRows(short, [1, 1, 1], [0, 1]), short);
});

test('estimator calibration: against the real PDF renderer the worst-case estimate never under-counts lines, the typical one is at most 10 % below (it errs on the safe side)', () => {
  const widthPt = columnWidthPt(CARD_COLUMN_WEIGHTS, CARD_GAS_COLUMN);
  const samples = [phrase('Ar', 300), phrase('ЗАГЛАВНЫЕ БУКВЫ КИРИЛЛИЦЫ ', 400), 'Линия gas-1 (газ: Ar): ВКЛ, расход — 50 sccm, время — 0–10 мин; '.repeat(6), 'N2/C2H2 смесь '.repeat(30)];
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape' });
  pdf.registerFont('Sans', new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url).pathname);
  pdf.font('Sans').fontSize(8);
  for (const sample of samples) {
    const actual = Math.round(pdf.heightOfString(sample, { width: widthPt }) / pdf.currentLineHeight());
    const worst = estimateLines(sample, widthPt, WORST_CHAR_PT);
    const typical = estimateLines(sample, widthPt, TYPICAL_CHAR_PT);
    assert.ok(worst >= actual, `worst-case ${worst} >= measured ${actual}`);
    assert.ok(/ЗАГЛАВНЫЕ/.test(sample) || typical >= actual * 0.9, `typical ${typical} vs measured ${actual}`);
  }
  assert.ok(CARD_CELL_LINE_BUDGET < CARD_ROW_LINE_LIMIT);
});

// =====================================================================================
// Exact text preservation when a long cell is split
// =====================================================================================

const W = columnWidthPt([6, 16, 12, 16, 10, 16, 24], 3); // gas-name column of the gas detail table
const roundTrip = (text: string, maxLines = 6) => {
  const parts = chunkText(text, W, WORST_CHAR_PT, maxLines);
  assert.equal(parts.join(''), text, 'parts.join("") === original');
  for (const part of parts) assert.ok(estimateLines(part, W, WORST_CHAR_PT) <= maxLines, 'each part fits');
  return parts;
};

test('exact split: 1234567890 x 100 and 6000 characters without a blank are cut into 2, 3 and more parts with nothing lost or doubled', () => {
  const digits = '1234567890'.repeat(100);
  assert.ok(roundTrip(digits, 6).length >= 2);
  const noBlank = 'AbВг-'.repeat(1200);
  assert.equal(noBlank.length, 6000);
  assert.ok(roundTrip(noBlank, 24).length >= 3);
  assert.ok(roundTrip(noBlank, 3).length >= 10);
  for (const n of [1, 2, 3, 5, 24]) assert.equal(chunkText(noBlank, W, WORST_CHAR_PT, n).join(''), noBlank);
});

test('exact split: leading/trailing/repeated blanks, TAB, CR LF, blank lines and empty edges survive byte for byte', () => {
  const samples = [
    '   leading and trailing   ' + 'слово '.repeat(60) + '   ',
    'a  b   c\t\td\t' + 'x  '.repeat(80),
    'первая\n\n\nтретья\r\n\r\nпятая\n' + 'строка '.repeat(50) + '\n\n',
    '\n\n\n' + 'z'.repeat(300) + '\t',
    ' '.repeat(400),
    'TiN, 5 µm, 1e-3 Pa, 2**3**2, ≤ ±α·β ' .repeat(30),
    '😀'.repeat(300) + 'e\u0301'.repeat(200),
  ];
  for (const sample of samples) {
    const parts = roundTrip(sample, 5);
    assert.ok(parts.length >= 2, `split into several parts: ${JSON.stringify(sample.slice(0, 20))}`);
  }
  assert.deepEqual(chunkText('', W, WORST_CHAR_PT, 5), ['']);
  assert.deepEqual(chunkText('TiN', W, WORST_CHAR_PT, 5), ['TiN'], 'short text is a single untouched part');
});

test('exact split: no surrogate pair, CR LF pair or combining mark is torn apart', () => {
  for (const text of ['😀'.repeat(400), 'a\r\n'.repeat(300), 'e\u0301'.repeat(400)]) {
    for (const part of roundTrip(text, 3)) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(part) && !/[\uD800-\uDBFF]$/.test(part), 'no lone surrogate');
      assert.ok(!part.startsWith('\n') || text.startsWith('\n') || !text.includes('\r\n'), 'CR LF kept together');
      assert.ok(!/^\p{M}/u.test(part), 'combining mark stays with its base');
    }
  }
});

test('exact split: splitTallRows keeps the value verbatim in the cells; the marker is a removable prefix, the rest of the row is untouched', () => {
  const value = '  Ti N  \t5 µm\n\n1e-3 Pa; 2**3**2   ' + '1234567890'.repeat(500) + '  \t ';
  const rows = splitTallRows([['2', 'Этап', 'Линия gas-1', value, 'ВКЛ']], [6, 16, 12, 16, 10], [0, 1, 2]);
  assert.ok(rows.length >= 3);
  rows.forEach((row, i) => {
    assert.ok(row[3].startsWith(`[${i + 1}/${rows.length}] `));
    assert.deepEqual(row.slice(0, 3), ['2', 'Этап', 'Линия gas-1']);
  });
  assert.equal(joinChunkCells(rows.map(r => r[3])), value);
  assert.equal(rows[0][4], 'ВКЛ');
  assert.ok(rows.slice(1).every(r => r[4] === CONTINUATION_CELL));
  // a value that does not need splitting is not touched at all (no marker, no trimming)
  const short = [['1', 'Этап', 'x', '  TiN \t 5 µm  ', 'ВКЛ']];
  assert.deepEqual(splitTallRows(short, [6, 16, 12, 16, 10], [0, 1, 2]), short);
});

/** All <w:t> texts of a DOCX in document order, XML entities decoded. */
function docxTexts(buffer: Buffer): string[] {
  const xml = readZipEntryText(buffer, 'word/document.xml');
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}

test('line estimate agrees with the PDF display text: CRLF, a lone CR and LF are each one line break', () => {
  for (const text of ['a\nb\nc', 'a\r\nb\r\nc', 'a\rb\rc', 'a\r\nb\rc\nd', '\r\r\r', 'a\r\n\r\nb']) {
    assert.equal(estimateLines(text, 500, TYPICAL_CHAR_PT), displayText(text).split('\n').length, JSON.stringify(text));
    assert.equal(estimateLines(text, 500, WORST_CHAR_PT), estimateLines(displayText(text), 500, WORST_CHAR_PT));
  }
  assert.equal(estimateLines('a\rb', 500, 6.4), 2);
  assert.equal(estimateLines('a\r\nb', 500, 6.4), 2, 'CRLF is ONE break, not two');
});

test('mixed CRLF / CR / LF values: split exactly, every piece fits, the original comes back unchanged', () => {
  const pieces = Array.from({ length: 200 }, (_, i) => `v${i}`);
  const seps = ['\r\n', '\r', '\n', '\r\n\r\n', '\n\r'];
  const mixed = pieces.map((p, i) => p + seps[i % seps.length]).join('');
  const W2 = columnWidthPt([6, 16, 12, 16, 10, 16, 24], 3);
  for (const text of [mixed, pieces.join('\r'), pieces.join('\r\n'), pieces.join('\n')]) {
    const parts = chunkText(text, W2, WORST_CHAR_PT, 24);
    assert.equal(parts.join(''), text);
    assert.ok(parts.length >= 2);
    for (const part of parts) assert.ok(estimateLines(part, W2, WORST_CHAR_PT) <= 24);
    const rows = splitTallRows([['2', 'Этап', 'Линия', text]], [6, 16, 12, 16], [0, 1, 2]);
    assert.equal(joinChunkCells(rows.map(r => r[3])), text);
  }
});

test('DOCX: the pieces of a split value come back exactly - strip the marker prefix, concatenate, compare', async () => {
  for (const original of ['1234567890'.repeat(600), 'AbВг-'.repeat(1200), ' \t двойной  пробел\t\tTAB\n\nпустая строка 1e-3 Pa, 2**3**2, TiN, 5 µm  '.repeat(80)]) {
    const doc = gasDoc([original]);
    const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[1].rows;
    assert.ok(rows.length >= 2);
    assert.equal(joinChunkCells(rows.map(r => r[3])), original);
    const { buffer } = await exportTechDoc(doc, 'technologicalCard', 'docx');
    const pieces = docxTexts(buffer).filter(t => CHUNK_MARKER_RE.test(t));
    assert.equal(pieces.length, rows.length, 'one marked cell per row');
    assert.equal(pieces.map(t => t.replace(CHUNK_MARKER_RE, '')).join(''), original, 'DOCX text equals the original exactly');
  }
});

test('PDF: the layout may re-wrap lines, but the characters are the original ones - whitespace-insensitive comparison across page breaks', async () => {
  const strip = (t: string) => t.replace(/\s+/g, '');
  for (const original of ['1234567890'.repeat(600), 'AbВг-'.repeat(1200), 'TiN 5 µm 1e-3 Pa 2**3**2 слово  двойной\tTAB\n\nпустая '.repeat(120)]) {
    const doc = gasDoc([original]);
    const parser = new PDFParse({ data: (await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer });
    const result = await parser.getText();
    await parser.destroy();
    assert.ok(result.pages.length >= 2, 'the value runs over a page break');
    const raw = result.pages.map((p: { text: string }) => p.text).join('\n');
    // from the first table header of the gas detail table to the document tail, minus the row prefix, the other cells of the row, the repeated headers and the page footers
    const from = raw.indexOf('Время подачи');
    const to = raw.indexOf('Traceability', from);
    assert.ok(from >= 0 && to > from);
    let body = raw.slice(from + 'Время подачи'.length, to);
    for (const noise of [/№\s*этапа\s*Этап Линия Газ Состояние Расход Время подачи/g, /Страница \d+ из \d+/g, /2 Адгезионный подслой Линия gas-1 \[\d+\/\d+\] ?/g, /ВКЛ 10 sccm 0–10 мин/g, /\(см\. выше\)/g]) body = body.replace(noise, '');
    // Two KNOWN renderer artefacts: U+00B5 is extracted as U+03BC (the same glyph); a TAB is shown as spaces by the PDF text boundary (pdfText)
    // so it carries no character at all - the TAB is compared as the whitespace it is.
    assert.equal(strip(body).replace(/μ/g, 'µ'), strip(original), 'the characters the PDF shows, read in order, are exactly the original ones - none lost, none repeated at the page boundaries');
  }
  assert.equal(displayText('a\tb'), 'a    b', 'a TAB reaches the PDF as spaces, never as a missing glyph');
});

test('audit case: a gas name of 00..84 joined by lone CR (254 characters) is split before it can overflow, context repeated, text exact, PDF checked', async () => {
  const name = Array.from({ length: 85 }, (_, i) => String(i).padStart(2, '0')).join('\r');
  assert.equal(name.length, 254);
  const doc = gasDoc([name]);
  assert.equal(hasLongList(unitOf(doc, 2), 'gases'), true);
  const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[1].rows;
  assert.ok(rows.length >= 2, '85 lines do not fit one page: the record is split');
  rows.forEach((row, i) => {
    assert.deepEqual(row.slice(0, 3), ['2', 'Адгезионный подслой', 'Линия gas-1'], 'step number, name and line in every piece');
    assert.ok(estimateLines(row[3], GAS_NAME_WIDTH, WORST_CHAR_PT) <= CARD_ROW_LINE_LIMIT, `piece ${i + 1} fits a page`);
  });
  assert.deepEqual(rows[0].slice(4), ['ВКЛ', '10 sccm', '0–10 мин']);
  assert.equal(joinChunkCells(rows.map(r => r[3])), name, 'parts.join("") === original, CRs included');
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  const withPieces = pages.filter(t => /2 Адгезионный подслой Линия gas-1 \[\d+\/\d+\]/.test(t));
  assert.ok(withPieces.length >= 2, 'pieces are on more than one page');
  for (const t of withPieces) assert.ok(t.includes('№ этапа Этап Линия Газ'), 'column header repeated on the page');
  const all = pages.join(' ');
  for (let i = 0; i <= 84; i++) assert.ok(all.includes(String(i).padStart(2, '0')), `value ${i} is in the PDF`);
  assert.ok(!/[\u0000\r]/.test(all));
});
