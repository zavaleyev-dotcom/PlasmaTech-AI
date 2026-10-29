import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { listZipEntries, readZipEntryText } from './helpers/zip-reader';
import {
  createBlankDocument, addStep, updateStep, addSource, updateSource, addGas, updateGas, addLayer, updateLayer, setCoatingMode, STEP_TYPES,
  type TechnicalProcessDocument, type ProcessStep,
} from '../src/services/workspace/techdoc-assistant';
import { buildDocumentViewModel, exportTechDoc, DOCUMENT_TYPES, EXPORT_FORMATS } from '../src/services/workspace/techdoc-export';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text.replace(/μ/g, 'µ').replace(/([–/])\s+(?=[\dа-яa-z])/gi, '$1').replace(/\s+/g, ' '); } finally { await parser.destroy(); }
}
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** All eight cards with test values (NOT technological recommendations). Card 6 is multilayer with two layers, each with its own sources and gas lines. */
function fullDoc(): TechnicalProcessDocument {
  let steps: ProcessStep[] = STEP_TYPES.reduce<ProcessStep[]>((acc, type) => addStep(acc, type), []);
  steps = updateStep(steps, 1, { durationMin: 15, substrateType: 'Твердый сплав WC-Co', substrateCount: 40, fixture: 'Карусель, 3 яруса', description: 'Загрузка подложек' });
  steps = updateStep(steps, 2, { pressureStartPa: 101325, pressureEndPa: 0.002, durationMin: 30, rotationRpm: 4 });
  steps = updateStep(steps, 3, { temperatureStartC: 25, temperatureEndC: 350, durationMin: 45, pressureStartPa: 0.002, pressureEndPa: 0.5, rotationRpm: 3, heaterPowerW: 5000 });
  steps = updateStep(steps, 4, { durationMin: 20, temperatureC: 300, pressurePa: 1.2, substrateBiasV: -800, rotationRpm: 4, distanceMm: 120, description: 'Очистка ионами Ar' });
  steps = updateSource(addSource(steps, { order: 4 }, 'ion'), { order: 4 }, 'ion-1', { voltageV: 1500, currentA: 0.2, powerW: 300, startMin: 0, durationMin: 20 });
  steps = updateGas(addGas(steps, { order: 4 }), { order: 4 }, 'gas-1', { gas: 'Ar', flowSccm: 60, startMin: 0, durationMin: 20 });
  steps = updateStep(steps, 5, { material: 'Cr', thicknessNm: 200, durationMin: 10, temperatureC: 400, pressurePa: 0.4, substrateBiasV: -100, rotationRpm: 4, distanceMm: 150 });
  steps = updateSource(addSource(steps, { order: 5 }, 'magnetron'), { order: 5 }, 'magnetron-1', { material: 'Cr', powerW: 2000, operatingMode: 'HiPIMS', startMin: 0, durationMin: 10 });
  steps = updateGas(addGas(steps, { order: 5 }), { order: 5 }, 'gas-1', { gas: 'Ar', flowSccm: 35, startMin: 0, durationMin: 10 });
  steps = addLayer(addLayer(steps, 6), 6);
  steps = updateLayer(steps, 6, 'layer-1', { material: 'Ti', thicknessNm: 300, durationMin: 20, temperatureC: 420, pressurePa: 0.5, substrateBiasV: -80, rotationRpm: 4 });
  steps = updateLayer(steps, 6, 'layer-2', { material: 'TiN', thicknessNm: 2500, durationMin: 90, temperatureC: 430, pressurePa: 0.6, substrateBiasV: -60, rotationRpm: 4, distanceMm: 140 });
  const l1 = { order: 6, layerId: 'layer-1' }; const l2 = { order: 6, layerId: 'layer-2' };
  steps = updateSource(addSource(steps, l1, 'magnetron'), l1, 'magnetron-1', { material: 'Ti', powerW: 3000, startMin: 0, durationMin: 20 });
  steps = updateGas(addGas(steps, l1), l1, 'gas-1', { gas: 'Ar', flowSccm: 40, startMin: 0, durationMin: 20 });
  steps = updateSource(addSource(steps, l2, 'magnetron'), l2, 'magnetron-1', { material: 'Ti', powerW: 3500, mode: 'sequential', startMin: 0, durationMin: 45 });
  steps = updateSource(addSource(steps, l2, 'arc'), l2, 'arc-1', { material: 'TiAl', filtered: true, currentA: 85, mode: 'sequential', startMin: 45, durationMin: 45 });
  steps = updateGas(addGas(steps, l2), l2, 'gas-1', { gas: 'Ar', flowSccm: 40 });
  steps = updateGas(addGas(steps, l2), l2, 'gas-2', { gas: 'N2', flowSccm: 15 });
  steps = updateStep(steps, 7, { durationMin: 40, temperatureC: 150, pressurePa: 1000 });
  steps = updateGas(addGas(steps, { order: 7 }), { order: 7 }, 'gas-1', { gas: 'N2', flowSccm: 200 });
  steps = updateStep(steps, 8, { durationMin: 10, temperatureC: 60, description: 'Выгрузка после остывания' });
  return { ...createBlankDocument(), general: { processName: 'Stage4_full', equipment: 'Установка А' }, steps };
}

test('all four documents x two formats of a document with all eight cards and a layered coating export as real files', async () => {
  const doc = fullDoc();
  for (const documentType of DOCUMENT_TYPES) {
    const docx = await exportTechDoc(doc, documentType, 'docx');
    assert.equal(docx.buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
    assert.ok(listZipEntries(docx.buffer).includes('word/document.xml'));
    const pdf = await exportTechDoc(doc, documentType, 'pdf');
    assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  }
  assert.deepEqual([...EXPORT_FORMATS], ['docx', 'pdf']);
});

test('the printed instruction (DOCX and PDF) carries every field of every card, the layers, and the sources and gas lines of each layer', async () => {
  const doc = fullDoc();
  const parts = [
    'Тип подложек: Твердый сплав WC-Co', 'Количество подложек: 40 шт.', 'Оснастка / размещение: Карусель, 3 яруса',
    'Начальное давление: 101325 Па', 'Конечное давление: 0.002 Па', 'Вращение (необязательно): 4 об/мин',
    'Начальная температура: 25°C', 'Конечная температура: 350°C', 'Мощность нагревателей (необязательно): 5000 Вт',
    'Напряжение смещения: -800 В', 'Расстояние до подложек (необязательно): 120 мм',
    'Ионный источник ion-1: ВКЛ, напряжение — 1500 В, ток — 0.2 А, мощность — 300 Вт',
    'Магнетрон magnetron-1 (мишень: Cr): ВКЛ, мощность — 2000 Вт, режим питания — HiPIMS',
    'Материал: Cr', 'Толщина: 200 нм', 'Режим покрытия: многослойное (несколько слоёв)',
    'Слой 1:', 'Материал: Ti', 'Толщина: 300 нм', 'Слой 2:', 'Материал: TiN', 'Толщина: 2500 нм',
    'Вакуумно-дуговой источник arc-1 (катод: TiAl, фильтрованный): ВКЛ, ток дуги — 85 А', 'Линия gas-2 (газ: N2): ВКЛ, расход — 15 sccm',
    'Описание: Выгрузка после остывания',
  ];
  const docx = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  const pdf = await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer);
  for (const part of parts) { assert.ok(docx.includes(flat(part)), `DOCX: ${part}`); assert.ok(pdf.includes(flat(part).replace(/([–/])\s+(?=[\dа-яa-z])/gi, '$1')), `PDF: ${part}`); }
  for (const gone of ['Критерий приёмки', 'Источник/мощность', 'Газовая система']) { assert.ok(!docx.includes(gone), gone); assert.ok(!pdf.includes(gone), gone); }
});

test('technological card: one row per card with its parameters, plus a layers table - one row per layer with its own material, thickness, times, sources and gas lines', async () => {
  const vm = buildDocumentViewModel(fullDoc(), 'technologicalCard');
  assert.deepEqual(vm.tables[0].columns, ['№', 'Операция', 'Время', 'Темп.', 'Давление', 'Газы', 'Источники', 'Bias', 'Прочие параметры', 'Описание']);
  assert.equal(vm.tables[0].rows.length, 8);
  const row = (n: string) => vm.tables[0].rows.find(r => r[0] === n)!;
  assert.deepEqual(row('2').slice(2, 5), ['30 мин', '—', '101325 Па → 0.002 Па']);
  assert.deepEqual(row('3').slice(2, 5), ['45 мин', '25°C → 350°C', '0.002 Па → 0.5 Па']);
  assert.equal(row('6')[2], 'по слоям');
  assert.equal(row('6')[1], 'Многослойное покрытие');
  assert.equal(row('6')[8], 'многослойное, слоёв: 2');
  assert.deepEqual(row('7').slice(2, 5), ['40 мин', '150°C', '1000 Па']);
  assert.ok(row('7')[5].includes('газ: N2') && row('7')[6] === '—', 'cooling shows gas lines, no sources');
  const layers = vm.tables.find(t => t.heading === 'Этап №6 «Многослойное покрытие»: слои покрытия')!;
  assert.deepEqual(layers.columns.slice(0, 9), ['№ эт.', 'Этап', 'Слой', 'Материал', 'Толщина', 'Время', 'Темп.', 'Давл.', 'Bias']);
  assert.deepEqual(layers.rows.map(r => r.slice(0, 11 - 1)), [
    ['6', 'Многослойное покрытие', '1', 'Ti', '300 нм', '20 мин', '420°C', '0.5 Па', '-80 В', '4 об/мин'],
    ['6', 'Многослойное покрытие', '2', 'TiN', '2500 нм', '90 мин', '430°C', '0.6 Па', '-60 В', '4 об/мин / 140 мм'],
  ]);
  assert.ok(layers.rows[1][10].includes('Магнетрон magnetron-1') && layers.rows[1][10].includes('Вакуумно-дуговой источник arc-1') && !layers.rows[0][10].includes('arc-1'));
  const docx = flat(docxPlain((await exportTechDoc(fullDoc(), 'technologicalCard', 'docx')).buffer));
  assert.ok(docx.includes('слои покрытия') && docx.includes('TiN') && docx.includes('2500 нм'));
  const xml = readZipEntryText((await exportTechDoc(fullDoc(), 'technologicalCard', 'docx')).buffer, 'word/document.xml');
  assert.ok((xml.match(/<w:tblHeader\/>/g) ?? []).length >= 2, 'both tables have a repeating header row');
});

test('route card and recipe of the eight cards: the route card has no control/note columns; the recipe shows ranges, layers and the abbreviation notice', () => {
  const doc = fullDoc();
  const route = buildDocumentViewModel(doc, 'routeCard');
  assert.deepEqual(route.tables[0].columns, ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход']);
  assert.deepEqual(route.tables[0].rows.map(r => r[1]), ['Загрузка', 'Откачка', 'Нагрев', 'Плазменная/ионная очистка', 'Адгезионный подслой', 'Многослойное покрытие', 'Охлаждение', 'Выгрузка']);
  const recipe = buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs.join('\n');
  assert.ok(recipe.includes('Сокращённое представление'));
  assert.ok(recipe.includes('3. Нагрев — T: 25°C → 350°C, P: 0.002 Па → 0.5 Па, t: 45 мин'));
  assert.ok(recipe.includes('2. Откачка — P: 101325 Па → 0.002 Па, t: 30 мин'));
  assert.ok(recipe.includes('6. Многослойное покрытие — многослойное, слоёв: 2 (слой 1: T: 420°C, P: 0.5 Па, t: 20 мин; слой 2: T: 430°C, P: 0.6 Па, t: 90 мин)'));
  assert.ok(recipe.includes('4. Плазменная/ионная очистка — T: 300°C, P: 1.2 Па, t: 20 мин [источников: 1 (включено 1), газовых линий: 1 (включено 1) - см. инструкцию]'));
});

test('single-layer mode prints "однослойное, слоёв: 1" everywhere', () => {
  let doc: TechnicalProcessDocument = { ...createBlankDocument(), general: { processName: 'One' }, steps: setCoatingMode(addStep([], 'multilayer_coating'), 1, 'single') };
  doc = { ...doc, steps: updateLayer(doc.steps, 1, 'layer-1', { material: 'TiN', thicknessNm: 1500 }) };
  assert.equal(buildDocumentViewModel(doc, 'technologicalCard').tables[0].rows[0][8], 'однослойное, слоёв: 1');
  assert.ok(buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs.join('\n').includes('однослойное, слоёв: 1'));
  assert.ok(buildDocumentViewModel(doc, 'instruction').sections.flatMap(s => s.paragraphs).join('\n').includes('Режим покрытия: однослойное (один слой)'));
});

test('a disabled card is still printed in the instruction (marked as disabled) and skipped by the recipe; all parameters stay', () => {
  let doc = fullDoc();
  doc = { ...doc, steps: doc.steps.map(s => s.order === 4 ? { ...s, enabled: false } : s) };
  const text = buildDocumentViewModel(doc, 'instruction').sections.flatMap(s => s.paragraphs).join('\n');
  assert.ok(text.includes('№4. Плазменная/ионная очистка (отключён)') && text.includes('Напряжение смещения: -800 В'));
  assert.ok(!buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs.join('\n').includes('Плазменная'));
});
