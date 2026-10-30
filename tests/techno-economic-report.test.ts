import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import { runAssessment, formatCurrency, type AssessmentInput, type Currency } from '../src/services/workspace/techno-economic-assessment';
import { EQUIPMENT_CONFIGURATIONS, buildTechnoEconomicHandoff } from '../src/services/workspace/equipment-selector';
import { buildTeaReport, reportRequestBody, ReportInputError, SCENARIO_KEYS, SCENARIO_LABELS, REPORT_TITLE, type TeaReportRequest, type ReportVariant } from '../src/services/workspace/techno-economic-report';
import { estimateLines, columnWidthPt, joinChunkCells, WORST_CHAR_PT, CARD_ROW_LINE_LIMIT, PDF_PORTRAIT_CONTENT_WIDTH_PT, CONTINUATION_CELL } from '../src/services/workspace/techdoc-card-layout';
import { readFileSync } from 'node:fs';
import { parseTeaReportRequest } from '../src/services/workspace/techno-economic-report-parse';
import { exportTeaReport, parseExportFormat } from '../src/services/workspace/techno-economic-report-export';
import { SCENARIO_KEYS as COMPONENT_KEYS, SCENARIO_LABELS as COMPONENT_LABELS } from '../src/components/techno-economic-assessment';
import { POST as exportPOST } from '../src/app/api/workspace/techno-economic/export/route';
import { handleTeaExport } from '../src/services/workspace/techno-economic-report-handler';
import type { GenericDocumentViewModel } from '../src/services/workspace/document-export';

const NOW = new Date(2026, 9, 30, 12, 0, 0); // 30 October 2026, local time
/** Figures are TEST DATA, not recommendations. Hand-calculated: CAPEX 2 650 000; OPEX/month 25 000.5 -> 300 006/year; effective hours 2*8*250*0.8 = 3200; cycles 9600; 38 400 units/year;
 *  depreciation 2 650 000 / 5 = 530 000; saving 4 200 000 - 2 400 000 = 1 800 000; payback 2 650 000 / 1 800 000 = 1.47 years; ROI 67.9 %. */
function inputA(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    capex: { equipment: 2_500_000, installation: 150_000, training: 0 },
    opex: { period: 'month', electricity: 12_000.5, processGases: 8_000, maintenance: 5_000 },
    capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 4 },
    depreciationYears: 5,
    economicEffect: { mode: 'total_external_cost', currentAnnualCost: 4_200_000, newAnnualCost: 2_400_000 },
    ...overrides,
  };
}
const variantA = (o: Partial<AssessmentInput> = {}, title = 'Установка PVD для инструмента'): ReportVariant => ({ title, input: inputA(o) });
const request = (o: Partial<TeaReportRequest> = {}): TeaReportRequest => ({ currency: 'RUB', variantA: variantA(), ...o });
const variantB = (): ReportVariant => ({ title: 'Аутсорсинг', input: inputA({
  capex: { equipment: 400_000 }, opex: { period: 'year', consumables: 90_000, labor: 120_000.25 }, depreciationYears: undefined,
  economicEffect: { mode: 'unit_cost', currentUnitCost: 30, newUnitCost: 22.5 },
}) });
const scenarios = (): Record<(typeof SCENARIO_KEYS)[number], ReportVariant> => ({
  base: variantA({}, 'Базовый вариант'),
  conservative: variantA({ economicEffect: { mode: 'total_external_cost', currentAnnualCost: 3_600_000, newAnnualCost: 2_700_000 } }, 'Консервативный вариант'),
  optimistic: variantA({ economicEffect: { mode: 'total_external_cost', currentAnnualCost: 4_800_000, newAnnualCost: 2_100_000 }, capacity: { shiftsPerDay: 3, hoursPerShift: 8, workingDaysPerYear: 300, utilizationPercent: 90, cycleTimeMinutes: 15, unitsPerCycle: 4 } }, 'Оптимистичный вариант'),
});

/** Everything the document says, as one text. */
function modelText(vm: GenericDocumentViewModel): string {
  const items = vm.body ?? [];
  return [vm.title, ...vm.metadata.map(m => `${m.label}: ${m.value}`),
    ...items.flatMap(i => i.kind === 'section' ? [i.section.heading, ...i.section.paragraphs] : [i.table.heading, i.table.columns.join(' '), ...i.table.rows.map(r => r.join(' '))]),
    vm.traceabilityHeading, ...vm.traceability.map(t => `${t.label}: ${t.value}`), vm.footer].join('\n');
}
const squash = (t: string) => t.replace(/[\s  ]+/g, '');
const headings = (vm: GenericDocumentViewModel) => (vm.body ?? []).flatMap(i => i.kind === 'section' && /^\d\./.test(i.section.heading) ? [i.section.heading] : []);
const tables = (vm: GenericDocumentViewModel) => (vm.body ?? []).flatMap(i => i.kind === 'table' ? [i.table] : []);
const tableByHeading = (vm: GenericDocumentViewModel, start: string) => tables(vm).find(t => t.heading.startsWith(start))!;
const rowOf = (t: { rows: string[][] }, label: string) => t.rows.find(r => r[0] === label || r[0].startsWith(label));
const docxText = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
async function pdfPages(buffer: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).pages.map((p: { text: string }) => p.text); } finally { await parser.destroy(); }
}

// =====================================================================================
// A regular calculation
// =====================================================================================

test('report of a regular calculation: title page data and the eight sections in order, nothing for A/B or scenarios', () => {
  const vm = buildTeaReport(request(), NOW);
  assert.equal(vm.title, REPORT_TITLE);
  assert.deepEqual(vm.metadata.map(m => m.label), ['Тип отчёта', 'Проект / оцениваемое оборудование', 'Конфигурация (Equipment Selector)', 'Состав расчёта', 'Валюта', 'Дата формирования']);
  assert.equal(vm.metadata[0].value, 'Технико-экономическая оценка');
  assert.equal(vm.metadata[1].value, 'Установка PVD для инструмента');
  assert.equal(vm.metadata[2].value, 'не передавалась');
  assert.ok(vm.metadata[5].value.includes('30 октября 2026'), vm.metadata[5].value);
  assert.deepEqual(headings(vm), ['1. Техническая конфигурация', '2. Капитальные затраты (CAPEX)', '3. Эксплуатационные затраты (OPEX)', '4. Производительность', '5. Экономические показатели', '8. Методика расчётов']);
});

test('numbers of a regular calculation are the hand-calculated ones, with units and currency (RUB)', () => {
  const vm = buildTeaReport(request(), NOW);
  const capex = tableByHeading(vm, 'Таблица 2.1');
  assert.deepEqual(capex.rows.map(r => [r[0], squash(r[1]), r[2]]), [
    ['Оборудование', '2500000,00₽', 'Исходное значение'], ['Монтаж', '150000,00₽', 'Исходное значение'], ['Обучение', '0,00₽', 'Исходное значение'], ['Итого CAPEX', '2650000,00₽', 'Рассчитано'],
  ]);
  const opex = tableByHeading(vm, 'Таблица 3.1');
  assert.deepEqual(opex.rows.map(r => [r[0], squash(r[1]), r[2]]), [
    ['Электроэнергия (за месяц)', '12000,50₽', 'Исходное значение'], ['Технологические газы (за месяц)', '8000,00₽', 'Исходное значение'], ['Обслуживание (за месяц)', '5000,00₽', 'Исходное значение'],
    ['Итого OPEX за месяц', '25000,50₽', 'Рассчитано'], ['Годовой эквивалент (OPEX в год)', '300006,00₽', 'Рассчитано'],
  ]);
  const capacityInputs = tableByHeading(vm, 'Таблица 4.1');
  assert.deepEqual(capacityInputs.rows.map(r => [r[0], squash(r[1])]), [
    ['Сменность (смен в сутки)', '2'], ['Часов в смену', '8ч'], ['Рабочих дней в год', '250дн.'], ['Загрузка оборудования', '80%'], ['Время технологического цикла', '20мин'], ['Количество изделий за цикл', '4шт.'], ['Срок амортизации', '5лет'],
  ]);
  const computed = tableByHeading(vm, 'Таблица 4.2');
  assert.deepEqual(computed.rows.map(r => [r[0], squash(r[1])]), [
    ['Эффективных часов работы в год', '3200'], ['Циклов в год', '9600'], ['Расчётный годовой выпуск', '38400ед.'], ['Себестоимость изделия без амортизации', '7,81₽'],
    ['Годовая амортизация', '530000,00₽'], ['Себестоимость изделия с амортизацией', '21,61₽'],
  ]);
  const economics = tableByHeading(vm, 'Таблица 5.1');
  assert.equal(squash(rowOf(economics, 'Годовая экономия')![1]), '1800000,00₽');
  assert.equal(rowOf(economics, 'Срок окупаемости')![1], '1.47 лет (17.7 мес.)');
  assert.equal(rowOf(economics, 'ROI')![1], '67.9 %');
  assert.deepEqual(economics.rows.filter(r => r[2] === 'Рассчитано').map(r => r[0]).slice(0, 1), ['Годовая экономия']);
  // the figures are the engine's own, not a second calculation
  const r = runAssessment(inputA());
  assert.equal(r.capex.total, 2_650_000);
  assert.equal(r.payback.years!.toFixed(2), '1.47');
  assert.equal(squash(rowOf(capex, 'Итого CAPEX')![1]), squash(formatCurrency(r.capex.total, 'RUB')));
});

test('inputs, computed values and missing information are told apart; an empty field is never printed as 0', () => {
  const vm = buildTeaReport(request({ variantA: variantA({ depreciationYears: undefined }) }), NOW);
  const capex = tableByHeading(vm, 'Таблица 2.1');
  assert.ok(!capex.rows.some(r => r[0] === 'Доставка'), 'a field that was not filled is not a row with 0');
  assert.equal(squash(rowOf(capex, 'Обучение')![1]), '0,00₽', 'a 0 the user TYPED stays a value');
  const text = modelText(vm);
  assert.ok(text.includes('Не заполнены (в расчёт не входят, как 0 не подставлялись): Доставка; Таможня / логистика; Пусконаладка; Инфраструктура; Оснастка / комплектующие; Прочие единовременные затраты.'));
  assert.ok(text.includes('Не заполнены (в расчёт не входят, как 0 не подставлялись): Расходные материалы; Мишени / катоды; Реактивы; Ремонт; Персонал; Аренда / помещения; Утилизация; Прочие эксплуатационные расходы.'));
  const capacity = tableByHeading(vm, 'Таблица 4.1');
  assert.deepEqual(rowOf(capacity, 'Срок амортизации'), ['Срок амортизации', 'не указано', 'Не указано']);
  assert.deepEqual(rowOf(tableByHeading(vm, 'Таблица 4.2'), 'Себестоимость изделия с амортизацией'), ['Себестоимость изделия с амортизацией', 'не рассчитывалась: срок амортизации не указан', 'Не указано']);
  assert.ok(!tableByHeading(vm, 'Таблица 4.2').rows.some(r => r[0] === 'Годовая амортизация'));
  // no project title and no configuration: stated, not invented
  const bare = buildTeaReport({ currency: 'RUB', variantA: { input: inputA() } }, NOW);
  assert.equal(bare.metadata[1].value, 'не указано');
  assert.equal(bare.metadata[2].value, 'не передавалась');
  assert.ok(modelText(bare).includes('Техническая конфигурация из Equipment Selector не передавалась'));
});

test('unit-cost mode: savings per unit and the output used for the annual saving are shown', () => {
  const vm = buildTeaReport(request({ variantA: variantA({ economicEffect: { mode: 'unit_cost', currentUnitCost: 30, newUnitCost: 22.5 } }) }), NOW);
  const economics = tableByHeading(vm, 'Таблица 5.1');
  assert.deepEqual(economics.rows.map(r => r[0]), ['Способ расчёта эффекта', 'Текущая себестоимость единицы', 'Новая себестоимость единицы', 'Годовой выпуск для расчёта экономии', 'Экономия на единицу', 'Годовая экономия', 'Срок окупаемости (простой, без дисконтирования)', 'ROI']);
  assert.equal(squash(rowOf(economics, 'Экономия на единицу')![1]), '7,50₽');
  assert.equal(squash(rowOf(economics, 'Годовая экономия')![1]), '288000,00₽', '7.5 x 38 400 units');
});

test('payback that is not defined (no positive saving) is reported as such, never as a number', () => {
  const vm = buildTeaReport(request({ variantA: variantA({ economicEffect: { mode: 'total_external_cost', currentAnnualCost: 1_000_000, newAnnualCost: 1_000_000 } }) }), NOW);
  const row = rowOf(tableByHeading(vm, 'Таблица 5.1'), 'Срок окупаемости')!;
  assert.ok(row[1].startsWith('не определён: Окупаемость не определена'), row[1]);
  assert.equal(rowOf(tableByHeading(vm, 'Таблица 5.1'), 'ROI')![1], '0.0 %');
});

// =====================================================================================
// Technical configuration from Equipment Selector
// =====================================================================================

test('the configuration handed over from Equipment Selector is kept completely, as a typical category (never a manufacturer model), with no costs invented', () => {
  for (const config of EQUIPMENT_CONFIGURATIONS) {
    const handoff = buildTechnoEconomicHandoff(config);
    const vm = buildTeaReport(request({ handoff }), NOW);
    const text = modelText(vm);
    assert.ok(vm.metadata[2].value.includes(handoff.configurationName) && vm.metadata[2].value.includes('типовая категория'));
    const rows = tableByHeading(vm, 'Таблица 1.1').rows;
    const value = (label: string) => rows.find(r => r[0].startsWith(label))![1];
    assert.equal(value('Тип установки'), handoff.configurationName);
    assert.equal(value('Технология'), handoff.supportedTechnologies.join(', ') || 'не указано');
    assert.equal(value('Поддерживаемые процессы'), handoff.supportedPurposes.join(', ') || 'не указано');
    assert.equal(value('Источники плазмы'), handoff.sourcesSummary);
    assert.equal(value('Газовая система'), String(handoff.maxGasLines));
    assert.equal(value('Максимальная температура'), `${handoff.maxProcessTempC.toLocaleString('ru-RU')} °C`);
    assert.equal(value('Максимальный размер камеры'), `${handoff.maxChamberSizeMm.toLocaleString('ru-RU')} мм`);
    assert.equal(value('Производительность'), handoff.throughputClasses.join(', ') || 'не указано');
    assert.equal(value('Автоматизация'), handoff.automationLevels.join(', ') || 'не указано');
    assert.equal(value('Чистое помещение'), handoff.cleanroomSupport.join(', ') || 'не указано');
    assert.deepEqual(rows.find(r => r[0] === 'Вакуумные требования'), ['Вакуумные требования', 'Equipment Selector не передаёт', 'Не указано'], 'what the selector does not know is not made up');
    assert.ok(text.includes('типовая категория оборудования с техническими возможностями, а не конкретная модель'));
    assert.ok(text.includes(handoff.note));
    assert.ok(!/\bманюфактур|производитель[^а-я]*[A-Z]/.test(text) || text.includes('не конкретная модель'));
    assert.ok(!tableByHeading(vm, 'Таблица 2.1').rows.some(r => r[0].toLowerCase().includes('конфигурац')), 'the configuration brings no CAPEX line');
  }
});

// =====================================================================================
// Currency
// =====================================================================================

test('the currency is carried everywhere and nothing is converted: the same numbers in USD and EUR with the right symbol and name', () => {
  const rub = buildTeaReport(request(), NOW);
  for (const [currency, symbol, name] of [['USD', '$', 'доллар США (USD, $)'], ['EUR', '€', 'евро (EUR, €)']] as [Currency, string, string][]) {
    const vm = buildTeaReport(request({ currency }), NOW);
    assert.equal(vm.metadata[4].value, name);
    const capex = tableByHeading(vm, 'Таблица 2.1');
    assert.ok(capex.rows.every(r => r[1].includes(symbol)), currency);
    assert.ok(squash(rowOf(capex, 'Итого CAPEX')![1]).replace(/[$€.,]/g, '').includes('265000000'), `${currency}: the amount is the same number`);
    assert.ok(modelText(vm).includes(name) && modelText(vm).includes('конвертация не выполняется'));
    assert.equal(tableByHeading(vm, 'Таблица 4.2').rows[2][1], tableByHeading(rub, 'Таблица 4.2').rows[2][1], 'a non-monetary figure does not depend on the currency');
  }
  assert.ok(squash(buildTeaReport(request(), NOW).metadata[4].value).includes('RUB'));
});

test('typed amounts keep every digit (0.005 stays 0.005); computed amounts show two decimals like the module itself', () => {
  const vm = buildTeaReport(request({ variantA: variantA({ capex: { equipment: 1_000_000.005, delivery: 0.005 } }) }), NOW);
  const capex = tableByHeading(vm, 'Таблица 2.1');
  assert.equal(squash(rowOf(capex, 'Доставка')![1]), '0,005₽');
  assert.equal(squash(rowOf(capex, 'Оборудование')![1]), '1000000,005₽');
  assert.equal(squash(rowOf(capex, 'Итого CAPEX')![1]), squash(formatCurrency(1_000_000.01, 'RUB')));
});

// =====================================================================================
// A/B comparison, three scenarios
// =====================================================================================

test('A/B: section 6 appears only with variant B - source values, computed values and a comparison, each equal to the engine\'s own results', () => {
  assert.ok(!headings(buildTeaReport(request(), NOW)).some(h => h.startsWith('6.')));
  const vm = buildTeaReport(request({ variantB: variantB() }), NOW);
  assert.deepEqual(headings(vm), ['1. Техническая конфигурация', '2. Капитальные затраты (CAPEX) (Вариант A)', '3. Эксплуатационные затраты (OPEX) (Вариант A)', '4. Производительность (Вариант A)', '5. Экономические показатели (Вариант A)', '6. Сравнение вариантов A/B', '8. Методика расчётов']);
  const inputs = tableByHeading(vm, 'Таблица 6.1');
  assert.deepEqual(inputs.columns, ['Показатель', 'Вариант A', 'Вариант B']);
  assert.deepEqual(inputs.rows.find(r => r[0] === 'CAPEX: Монтаж')!.map((c, i) => i === 0 ? c : squash(c)), ['CAPEX: Монтаж', '150000,00₽', 'неуказано']);
  assert.deepEqual(inputs.rows.find(r => r[0] === 'OPEX: Персонал')!.map((c, i) => i === 0 ? c : squash(c)), ['OPEX: Персонал', 'неуказано', '120000,25₽'], 'a field only B filled is "не указано" for A, not 0');
  assert.deepEqual(inputs.rows.find(r => r[0] === 'Период ввода OPEX'), ['Период ввода OPEX', 'месяц', 'год']);
  assert.deepEqual(inputs.rows.find(r => r[0] === 'Способ расчёта эффекта'), ['Способ расчёта эффекта', 'по годовым затратам', 'по себестоимости единицы']);
  const computed = tableByHeading(vm, 'Таблица 6.2');
  const a = runAssessment(inputA());
  const b = runAssessment(variantB().input);
  const money = (v: number) => squash(formatCurrency(v, 'RUB'));
  assert.deepEqual(computed.rows.map(r => [r[0], squash(r[1]), squash(r[2])]), [
    ['CAPEX', money(a.capex.total), money(b.capex.total)],
    ['OPEX в год', money(a.opex.annualTotal), money(b.opex.annualTotal)],
    ['Расчётный годовой выпуск, ед.', '38400', squash(b.capacity.unitsPerYear.toLocaleString('ru-RU', { maximumFractionDigits: 2 }))],
    ['Себестоимость изделия без амортизации', money(a.unitCost.withoutDepreciation), money(b.unitCost.withoutDepreciation)],
    ['Себестоимость изделия с амортизацией', money(a.unitCost.withDepreciation!), 'нерассчитывалась'],
    ['Годовая экономия', money(a.economicEffect.annualSavings), money(b.economicEffect.annualSavings)],
    ['Срок окупаемости (простой), лет', a.payback.years!.toFixed(2), b.payback.years!.toFixed(2)],
    ['ROI, %', a.roi.percent.toFixed(1), b.roi.percent.toFixed(1)],
  ]);
  assert.ok(modelText(vm).includes('победитель не выбирается'));
});

test('three scenarios: section 7 only when scenarios exist - base, conservative, optimistic with CAPEX, OPEX, output, unit cost, saving, payback and ROI', () => {
  const vm = buildTeaReport(request({ scenarios: scenarios() }), NOW);
  assert.ok(headings(vm).includes('7. Сценарный анализ') && !headings(vm).some(h => h.startsWith('6.')));
  const computed = tableByHeading(vm, 'Таблица 7.2');
  assert.deepEqual(computed.columns, ['Показатель', ...SCENARIO_KEYS.map(k => SCENARIO_LABELS[k])]);
  const results = SCENARIO_KEYS.map(k => runAssessment(scenarios()[k].input));
  assert.deepEqual(computed.rows.find(r => r[0] === 'Годовая экономия')!.slice(1).map(squash), results.map(r => squash(formatCurrency(r.economicEffect.annualSavings, 'RUB'))));
  assert.deepEqual(computed.rows.find(r => r[0] === 'Срок окупаемости (простой), лет')!.slice(1), results.map(r => r.payback.years!.toFixed(2)));
  assert.deepEqual(computed.rows.find(r => r[0] === 'ROI, %')!.slice(1), results.map(r => r.roi.percent.toFixed(1)));
  assert.deepEqual(computed.rows.find(r => r[0] === 'Расчётный годовой выпуск, ед.')!.slice(1).map(squash), results.map(r => squash(r.capacity.unitsPerYear.toLocaleString('ru-RU', { maximumFractionDigits: 2 }))));
  assert.notEqual(new Set(results.map(r => r.economicEffect.annualSavings)).size, 1, 'the three scenarios really differ');
  assert.ok(computed.rows.map(r => r[0]).join('|').includes('CAPEX') && computed.rows.some(r => r[0] === 'OPEX в год') && computed.rows.some(r => r[0].startsWith('Себестоимость изделия без')));
  const inputs = tableByHeading(vm, 'Таблица 7.1');
  assert.deepEqual(inputs.rows.find(r => r[0] === 'Рабочих дней в год')!.slice(1).map(squash), ['250дн.', '250дн.', '300дн.']);
  // a request with variant B AND scenarios has both sections, in the order 6, 7
  const both = buildTeaReport(request({ variantB: variantB(), scenarios: scenarios() }), NOW);
  assert.deepEqual(headings(both).filter(h => /^[67]\./.test(h)), ['6. Сравнение вариантов A/B', '7. Сценарный анализ']);
});

// =====================================================================================
// Methodology and honesty
// =====================================================================================

test('methodology: only formulas the module really applies; payback is simple (never "discounted"); no NPV/IRR as results; limits of interpretation are stated', () => {
  const vm = buildTeaReport(request(), NOW);
  const formulas = tableByHeading(vm, 'Таблица 8.1');
  assert.deepEqual(formulas.rows.map(r => r[0]), ['CAPEX', 'OPEX в год', 'Производительность', 'Себестоимость изделия', 'Годовая экономия', 'Срок окупаемости (простой)', 'ROI']);
  const r = runAssessment(inputA());
  for (const row of formulas.rows) assert.ok(row[1].length > 20 && row[2].length > 5, row[0]);
  assert.equal(rowOf(formulas, 'CAPEX')![2], `${r.capex.formula} = ${r.capex.total.toFixed(2)}`, 'the substitution is the application\'s own formula text');
  assert.equal(rowOf(formulas, 'Срок окупаемости')![2], r.payback.formula);
  assert.equal(rowOf(formulas, 'ROI')![2], r.roi.formula);
  assert.equal(rowOf(formulas, 'Производительность')![2], r.capacity.formula);
  assert.equal(rowOf(formulas, 'Себестоимость')![2], r.unitCost.formula);
  assert.equal(rowOf(formulas, 'Годовая экономия')![2], r.economicEffect.formula);
  const text = modelText(vm);
  assert.ok(text.includes('Принятые допущения') && text.includes('Ограничения интерпретации'));
  assert.ok(text.includes('не дисконтируются') && text.includes('Модуль не рассчитывает NPV, IRR и дисконтированную окупаемость'));
  // NPV / IRR / discounting appear ONLY in that one denial
  const mentions = text.split('\n').filter(l => /NPV|IRR|дисконтирован/i.test(l));
  for (const l of mentions.filter(l => !l.includes('не рассчитывает NPV, IRR'))) assert.ok(/без дисконтирования|не дисконтируется|не дисконтируются/.test(l), l);
  assert.ok(!tables(vm).some(t => t.rows.some(row => /NPV|IRR/.test(row[0]))), 'no such indicator is a result');
  assert.ok(text.includes('в расчёте используются полные значения'));
  const variables = tableByHeading(vm, 'Таблица 8.2');
  assert.deepEqual(variables.rows.map(r => r[0]), ['CAPEX', 'OPEX в год', 'Расчётный годовой выпуск', 'Срок амортизации', 'Годовая экономия', 'Валюта']);
});

test('the report always carries a successful calculation: invalid inputs are refused with the module\'s own message, never reported', () => {
  assert.throws(() => buildTeaReport(request({ variantA: variantA({ capex: { equipment: -5 } }) }), NOW), /Вариант A: расчёт не выполнен - Стоимость оборудования/);
  assert.throws(() => buildTeaReport(request({ variantA: variantA({ capacity: { shiftsPerDay: 3, hoursPerShift: 9, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 1 } }) }), NOW), /физически невозможны/);
  assert.throws(() => buildTeaReport(request({ variantB: { input: inputA({ capex: { equipment: 0 } }) } }), NOW), /Вариант B: расчёт не выполнен/);
});

test('component and report agree on the scenario keys and labels (one set of names)', () => {
  assert.deepEqual([...COMPONENT_KEYS], [...SCENARIO_KEYS]);
  assert.deepEqual(COMPONENT_LABELS, SCENARIO_LABELS);
});

// =====================================================================================
// DOCX and PDF
// =====================================================================================

test('DOCX and PDF are real files with the same content: every cell of every table and every paragraph of the model is in both', async () => {
  const req = request({ variantB: variantB(), scenarios: scenarios(), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) });
  const vm = buildTeaReport(req, NOW);
  const docx = await exportTeaReport(req, 'docx', NOW);
  const pdf = await exportTeaReport(req, 'pdf', NOW);
  assert.equal(docx.buffer.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.equal(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(docx.filename.endsWith('.docx') && pdf.filename.endsWith('.pdf'));
  assert.equal(docx.filename.replace('.docx', ''), pdf.filename.replace('.pdf', ''));
  const docxPlain = squash(docxText(docx.buffer));
  const pdfTokens = squash((await pdfPages(pdf.buffer)).join('\n'));
  const cells: string[] = [];
  for (const t of tables(vm)) { cells.push(t.heading, ...t.columns); t.rows.forEach(r => cells.push(...r)); }
  for (const i of vm.body ?? []) if (i.kind === 'section') cells.push(i.section.heading, ...i.section.paragraphs);
  cells.push(...vm.metadata.flatMap(m => [m.label, m.value]), ...vm.traceability.flatMap(m => [m.label, m.value]), vm.footer);
  for (const cell of cells.filter(c => c !== '')) {
    assert.ok(docxPlain.includes(squash(cell)), `DOCX misses: ${cell.slice(0, 60)}`);
    // a PDF line break may separate the lines of one cell from a neighbouring cell: every word of the cell must be present
    for (const word of cell.split(/[\s  ]+/).filter(Boolean)) assert.ok(pdfTokens.includes(squash(word)), `PDF misses "${word}" of: ${cell.slice(0, 60)}`);
  }
});

test('DOCX structure: every table is a real Word table with a repeating header row, and the title page ends with a page break', async () => {
  const req = request({ variantB: variantB(), scenarios: scenarios(), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) });
  const xml = readZipEntryText((await exportTeaReport(req, 'docx', NOW)).buffer, 'word/document.xml');
  const expected = tables(buildTeaReport(req, NOW)).length;
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, expected);
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, expected);
  assert.ok(xml.indexOf('<w:br w:type="page"/>') > xml.indexOf('Дата формирования') && xml.indexOf('<w:br w:type="page"/>') < xml.indexOf('1. Техническая конфигурация'));
});

test('PDF: the title page is a page of its own, the sections follow on the next pages, and long tables continue with a repeated header', async () => {
  const req = request({ variantB: variantB(), scenarios: scenarios(), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) });
  const pages = await pdfPages((await exportTeaReport(req, 'pdf', NOW)).buffer);
  assert.ok(pages.length >= 4, `pages: ${pages.length}`);
  const first = pages[0].replace(/\s+/g, ' ');
  assert.ok(first.includes('Технико-экономическая оценка') && first.includes('Установка PVD для инструмента') && first.includes('30 октября 2026') && first.includes('Конфигурация (Equipment Selector)'));
  assert.ok(!first.includes('1. Техническая конфигурация'), 'the first section starts on the next page');
  assert.ok(pages[1].replace(/\s+/g, ' ').includes('1. Техническая конфигурация'));
  // no orphan page: a table header is never left alone at the bottom of a page with its own text spilling onto an otherwise empty page
  for (const [i, page] of pages.entries()) assert.ok(page.replace(/Страница \d+ из \d+/, '').trim().length > 150 || i === pages.length - 1, `page ${i + 1} is almost empty: ${JSON.stringify(page.slice(0, 80))}`);
  // every page that holds rows of a measure table shows its column header
  for (const page of pages.slice(1)) {
    const text = page.replace(/\s+/g, ' ');
    if (/Исходное значение|Рассчитано/.test(text)) assert.ok(/Показатель Значение Происхождение значения|Показатель Вариант A|Показатель Базовый|Параметр Значение/.test(text), `header missing on a page:\n${text.slice(0, 200)}`);
  }
});

test('a missing-data report (minimal inputs) still exports: nothing is invented and every optional gap is named', async () => {
  const minimal: TeaReportRequest = { currency: 'EUR', variantA: { input: { ...inputA(), capex: { equipment: 100_000 }, opex: { period: 'year' }, depreciationYears: undefined } } };
  const vm = buildTeaReport(minimal, NOW);
  assert.deepEqual(tableByHeading(vm, 'Таблица 3.1').rows.map(r => r[0]), ['Итого OPEX за год', 'Годовой эквивалент (OPEX в год)'], 'no OPEX line was filled: no line is shown');
  assert.ok(modelText(vm).includes('Не заполнены (в расчёт не входят, как 0 не подставлялись): Электроэнергия;'));
  for (const format of ['docx', 'pdf'] as const) assert.ok((await exportTeaReport(minimal, format, NOW)).buffer.length > 1000);
});

test('file name: built from the project title, safe for headers, with the date', async () => {
  const dangerous = request({ variantA: variantA({}, 'Эта "установка"/..\r\nX-Evil: 1') });
  const file = await exportTeaReport(dangerous, 'docx', NOW);
  assert.ok(file.filename.endsWith('_TEA-report_2026-10-30.docx'), file.filename);
  assert.ok(!/[\r\n"/\\]/.test(file.filename) && !file.filename.includes('..'));
  assert.equal((await exportTeaReport({ currency: 'RUB', variantA: { input: inputA() } }, 'pdf', NOW)).filename, 'TEA_TEA-report_2026-10-30.pdf');
});

// =====================================================================================
// Request parsing and the route
// =====================================================================================

test('parseTeaReportRequest: reads by name, bounds everything, drops unknown properties, refuses bad shapes', () => {
  const good = JSON.parse(JSON.stringify({ currency: 'USD', variantA: variantA(), variantB: variantB(), scenarios: scenarios(), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) }));
  const parsed = parseTeaReportRequest({ ...good, hostile: { x: 1 }, variantA: { ...good.variantA, __proto__: { polluted: true }, extra: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), good, 'round trip through the parser changes nothing');
  assert.equal((parsed as unknown as { hostile?: unknown }).hostile, undefined);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.throws(() => parseTeaReportRequest({ ...good, currency: 'GBP' }), /Валюта/);
  assert.throws(() => parseTeaReportRequest({ ...good, variantA: { input: { ...good.variantA.input, capex: { equipment: 'много' } } } }), /ожидается конечное число/);
  assert.throws(() => parseTeaReportRequest({ ...good, variantA: { input: { ...good.variantA.input, opex: { period: 'week' } } } }), /период OPEX/);
  assert.throws(() => parseTeaReportRequest({ ...good, variantA: { title: 'x'.repeat(600), input: good.variantA.input } }), /слишком длинный/);
  assert.throws(() => parseTeaReportRequest({ ...good, scenarios: { base: good.variantA } }), /Сценарий conservative/);
  assert.throws(() => parseTeaReportRequest(null), /ожидается объект/);
  assert.throws(() => parseExportFormat('xlsx'), /Формат файла/);
});

const post = (body: unknown, headers: Record<string, string> = {}) => exportPOST(new Request('http://localhost/api/workspace/techno-economic/export', {
  method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));

test('export route: DOCX and PDF of the last calculation with correct headers; a refused calculation, bad JSON, size, format and non-local requests are handled', async () => {
  const report = JSON.parse(JSON.stringify(request({ variantB: variantB(), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[1]) })));
  const docx = await post({ report, format: 'docx' });
  assert.equal(docx.status, 200);
  assert.equal(docx.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(docx.headers.get('Content-Disposition')!.includes('attachment') && !docx.headers.get('Content-Disposition')!.match(/[\r\n]/));
  assert.equal(docx.headers.get('X-Content-Type-Options'), 'nosniff');
  const docxBuffer = Buffer.from(await docx.arrayBuffer());
  assert.ok(docxText(docxBuffer).includes('6. Сравнение вариантов A/B'));
  const pdf = await post({ report, format: 'pdf' });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');
  const bad = await post({ report: { ...report, variantA: { input: { ...report.variantA.input, capex: { equipment: -1 } } } }, format: 'docx' });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /расчёт не выполнен/);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ report, format: 'xlsx' })).status, 400);
  assert.equal((await post({ format: 'docx' })).status, 400);
  assert.equal((await post('a'.repeat(1_000_001))).status, 413);
  assert.equal((await exportPOST(new Request('http://evil.example/x', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: '{}' }))).status, 403);
  assert.equal((await exportPOST(new Request('http://localhost/x', { method: 'POST', headers: { host: 'localhost' }, body: '{}' }))).status, 403);
});

// =====================================================================================
// The existing calculations are untouched
// =====================================================================================

test('the existing engine is unchanged: the reference figures of the module (CAPEX, OPEX, output, unit cost, saving, payback, ROI) come out as before, and the report adds none of its own', () => {
  const r = runAssessment(inputA());
  assert.equal(r.capex.total, 2_650_000);
  assert.equal(r.opex.annualTotal, 300_006);
  assert.deepEqual([r.capacity.effectiveHoursPerYear, r.capacity.cyclesPerYear, r.capacity.unitsPerYear], [3200, 9600, 38_400]);
  assert.ok(Math.abs(r.unitCost.withoutDepreciation - 300_006 / 38_400) < 1e-12);
  assert.equal(r.unitCost.annualDepreciation, 530_000);
  assert.equal(r.economicEffect.annualSavings, 1_800_000);
  assert.ok(Math.abs(r.payback.years! - 2_650_000 / 1_800_000) < 1e-12);
  assert.ok(Math.abs(r.roi.percent - (1_800_000 / 2_650_000) * 100) < 1e-9);
  assert.equal(r.breakEven, null);
  assert.deepEqual(Object.keys(r).sort(), ['breakEven', 'capacity', 'capex', 'economicEffect', 'opex', 'payback', 'roi', 'unitCost']);
});

// =====================================================================================
// Audit fixes (Stage 5): currency snapshot, safe API errors, origin of the annual output, tall table rows
// =====================================================================================

test('FIX 1 currency: the currency belongs to the snapshot of the calculation - the request body carries the currency of the calculation, nothing else can re-label the amounts', async () => {
  const snapshot = request({ currency: 'RUB', variantA: variantA({ capex: { equipment: 1_000_000 } }), handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) });
  const body = reportRequestBody(snapshot, 'docx');
  assert.equal(body.report, snapshot, 'exactly the snapshot, not a rebuilt copy');
  assert.equal(body.report.currency, 'RUB');
  // what the user does on the screen afterwards (the selector says USD) cannot reach the snapshot: it is a value, and the body is made from it alone
  const selectorNow: Currency = 'USD';
  assert.notEqual(selectorNow, body.report.currency);
  const response = await post(JSON.parse(JSON.stringify(body)));
  const text = squash(docxText(Buffer.from(await response.arrayBuffer())));
  assert.ok(text.includes('1000000,00₽') && !text.includes('$'), 'one million roubles stays one million roubles');
  assert.ok(text.includes('российскийрубль(RUB,₽)'));
  // the same numbers calculated in USD are a DIFFERENT snapshot and say so
  const usd = buildTeaReport({ ...snapshot, currency: 'USD' }, NOW);
  assert.ok(squash(modelText(usd)).includes('$1,000,000.00') && !squash(modelText(usd)).includes('₽'));
});

test('FIX 1 configuration: the configuration of the snapshot is the one shown when the calculation ran; no snapshot configuration means "не передавалась" - another one is never put into an old report', () => {
  const first = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
  const second = buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[1]);
  assert.notEqual(first.configurationName, second.configurationName);
  const old = request({ handoff: first });
  const body = reportRequestBody(old, 'pdf');
  const report = buildTeaReport(body.report, NOW);
  assert.ok(modelText(report).includes(first.configurationName) && !modelText(report).includes(second.configurationName));
  const without = reportRequestBody(request(), 'pdf');
  assert.equal(without.report.handoff, undefined);
  assert.equal(buildTeaReport(without.report, NOW).metadata[2].value, 'не передавалась');
});

test('FIX 1 component: the download works from the snapshot alone - the snapshot carries currency and configuration, and the download no longer reads the currency selector or the import card', () => {
  const source = readFileSync(new URL('../src/components/techno-economic-assessment.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('const snapshot: ReportSnapshot = { currency, variantA: variant(formA, inputA), ...(importedHandoff ? { handoff: importedHandoff.handoff } : {}) };'), 'currency and configuration are fixed when the calculation runs');
  assert.ok(source.includes('function ReportDownload({ snapshot, displayCurrency }'));
  assert.ok(source.includes('body: JSON.stringify(reportRequestBody(snapshot, format))'));
  assert.ok(!/\.\.\.snapshot, currency/.test(source) && !source.includes('handoff={importedHandoff}'), 'no override of the snapshot at download time');
  assert.ok(source.includes('Валюта отчёта: {CURRENCY_NAMES[snapshot.currency]} (валюта расчёта)') && source.includes('displayCurrency !== snapshot.currency'), 'the user is told which currency the report has');
});

test('FIX 2 API errors: unusable input is a 4xx with the validation message; an internal rendering failure (ENOENT) is a 500 with a neutral message - no path, no stack, no system details', async () => {
  const report = JSON.parse(JSON.stringify(request({ variantB: variantB() })));
  const ENOENT_PATH = '/Volumes/123-All/GitHub/PlasmaTech-AI/node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
  const enoent = async () => { throw Object.assign(new Error(`ENOENT: no such file or directory, open '${ENOENT_PATH}'`), { code: 'ENOENT', errno: -2, syscall: 'open', path: ENOENT_PATH }); };
  const send = (body: unknown, render?: Parameters<typeof handleTeaExport>[1]) => handleTeaExport(new Request('http://localhost/api/workspace/techno-economic/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), render);
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    for (const format of ['pdf', 'docx']) {
      const failed = await send({ report, format }, enoent);
      assert.equal(failed.status, 500, format);
      const text = JSON.stringify(await failed.json());
      assert.match(text, /внутренней ошибки/);
      for (const leak of ['ENOENT', 'node_modules', 'dejavu', 'DejaVu', '.ttf', '/Volumes', 'errno', 'syscall', 'at ', 'Error:', ENOENT_PATH]) assert.ok(!text.includes(leak), `the response leaks "${leak}": ${text}`);
      assert.equal(failed.headers.get('Content-Type')?.startsWith('application/json'), true);
      assert.equal(failed.headers.get('Content-Disposition'), null, 'no file is offered');
    }
    assert.ok(logged.some(args => String(args[0]).includes('rendering failed') && String(args[1]).includes('ENOENT')), 'the details stay in the SERVER log');
    // a failure that is not an Error object at all is neutral too
    const odd = await send({ report, format: 'pdf' }, async () => { throw '/etc/passwd leaked'; });
    assert.equal(odd.status, 500);
    assert.ok(!JSON.stringify(await odd.json()).includes('/etc'));
  } finally { console.error = realError; }
  // validation problems: 400 with the message written for the user, never 500, and the renderer is not even reached
  let renderCalls = 0;
  const counting = async () => { renderCalls += 1; return Buffer.alloc(0); };
  for (const [body, pattern] of [
    [{ report: { ...report, variantA: { input: { ...report.variantA.input, capex: { equipment: -1 } } } }, format: 'pdf' }, /расчёт не выполнен/],
    [{ report: { ...report, currency: 'GBP' }, format: 'pdf' }, /Валюта/],
    [{ report, format: 'xlsx' }, /Формат файла/],
    [{ report: null, format: 'pdf' }, /ожидается объект/],
  ] as [unknown, RegExp][]) {
    const response = await send(body, counting);
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), pattern);
  }
  assert.equal(renderCalls, 0);
  assert.ok(new ReportInputError('x') instanceof Error);
  // the real route still serves a real file
  assert.equal((await post({ report, format: 'pdf' })).status, 200);
});

test('FIX 3 annual output: an output the user gave is an INPUT (123 units), not the calculated 38 400; the saving is computed from 123, and DOCX and PDF say the same', async () => {
  const given = request({ variantA: variantA({ economicEffect: { mode: 'unit_cost', currentUnitCost: 30, newUnitCost: 22.5, annualOutput: 123 } }) });
  const vm = buildTeaReport(given, NOW);
  const economics = tableByHeading(vm, 'Таблица 5.1');
  assert.deepEqual(rowOf(economics, 'Годовой выпуск для расчёта экономии'), ['Годовой выпуск для расчёта экономии', '123 ед.', 'Исходное значение']);
  assert.ok(!rowOf(economics, 'Годовой выпуск для расчёта экономии')![1].includes('38'), 'the calculated output is not named as the source of 123');
  assert.equal(squash(rowOf(economics, 'Годовая экономия')![1]), '922,50₽', '7.5 x 123');
  const r = runAssessment(given.variantA.input);
  assert.equal(r.economicEffect.annualSavings, 922.5);
  assert.equal(rowOf(economics, 'Срок окупаемости')![1], `${r.payback.years!.toFixed(2)} лет (${r.payback.months!.toFixed(1)} мес.)`);
  assert.equal(rowOf(economics, 'ROI')![1], `${r.roi.percent.toFixed(1)} %`);
  // the calculated output of section 4 is still what it was
  assert.equal(squash(rowOf(tableByHeading(vm, 'Таблица 4.2'), 'Расчётный годовой выпуск')![1]), '38400ед.');
  // without a given output the module uses the calculated one - and the report says so
  const calculated = buildTeaReport(request({ variantA: variantA({ economicEffect: { mode: 'unit_cost', currentUnitCost: 30, newUnitCost: 22.5 } }) }), NOW);
  assert.deepEqual(rowOf(tableByHeading(calculated, 'Таблица 5.1'), 'Годовой выпуск для расчёта экономии'), ['Годовой выпуск для расчёта экономии', '38 400 ед. (расчётный выпуск, раздел 4)'.replace(/ /g, '\u00a0').replace('38\u00a0400', '38\u00a0400').replace(/\u00a0ед\./, ' ед.').replace(/\u00a0\(/, ' (').replace(/расчётный\u00a0выпуск,\u00a0раздел\u00a04/, 'расчётный выпуск, раздел 4'), 'Рассчитано']);
  // A/B and scenarios list an explicit output among the inputs; total-cost mode ignores it (the engine does)
  const ab = buildTeaReport(request({ variantA: given.variantA, variantB: variantB() }), NOW);
  assert.deepEqual(rowOf(tableByHeading(ab, 'Таблица 6.1'), 'Годовой выпуск для расчёта экономии (задан явно)'), ['Годовой выпуск для расчёта экономии (задан явно)', '123 ед.', 'не указано']);
  // through the route, in both formats, and the parser accepts the field
  const parsed = parseTeaReportRequest(JSON.parse(JSON.stringify(given)));
  assert.equal(parsed.variantA.input.economicEffect.annualOutput, 123);
  const docx = squash(docxText((await exportTeaReport(parsed, 'docx', NOW)).buffer));
  const pdf = squash((await pdfPages((await exportTeaReport(parsed, 'pdf', NOW)).buffer)).join('\n'));
  for (const text of [docx, pdf]) assert.ok(text.includes('Годовойвыпускдлярасчётаэкономии') && text.includes('123ед.') && text.includes('922,50'));
});

/** A configuration whose "sources" text is S00 ... S84, one value per line separated by SINGLE CR (the audit case). */
const CR_SOURCES = Array.from({ length: 85 }, (_, i) => `S${String(i).padStart(2, '0')}`).join('\r');
const crHandoff = () => ({ ...buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]), sourcesSummary: CR_SOURCES });

test('FIX 4 tall row: a value taller than a page is split into marked continuation rows - the parameter name in each, nothing cut, the text rebuilds exactly - by the TechDoc splitting logic', () => {
  assert.equal(CR_SOURCES.length, 339, '85 values of 3 characters and 84 single CR');
  const vm = buildTeaReport(request({ handoff: crHandoff() }), NOW);
  const t = tableByHeading(vm, 'Таблица 1.1');
  const rows = t.rows.filter(r => r[0] === 'Источники плазмы');
  assert.ok(rows.length >= 2, '85 lines do not fit one page');
  rows.forEach((row, i) => {
    assert.equal(row[0], 'Источники плазмы', 'the name of the parameter is in every piece');
    assert.ok(row[1].startsWith(`[${i + 1}/${rows.length}] `));
    assert.ok(estimateLines(row[1], columnWidthPt([5, 4, 3], 1, PDF_PORTRAIT_CONTENT_WIDTH_PT), WORST_CHAR_PT) <= CARD_ROW_LINE_LIMIT, `piece ${i + 1} fits a page`);
    assert.equal(row[2], i === 0 ? 'Equipment Selector' : CONTINUATION_CELL);
  });
  assert.equal(joinChunkCells(rows.map(r => r[1])), CR_SOURCES, 'parts.join("") === original - every S.. and every CR');
  assert.ok(t.repeatHeading === true);
  assert.ok(modelText(vm).includes('Примечание о длинных значениях') && modelText(vm).includes('[k/n]'));
  // rows that are not too tall are untouched, and a normal report has no such note
  assert.equal(t.rows.filter(r => r[0] === 'Технология').length, 1);
  assert.ok(!modelText(buildTeaReport(request({ handoff: buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]) }), NOW)).includes('Примечание о длинных значениях'));
  // the same inside a table of several columns: a long project title in the A/B table
  const longTitle = Array.from({ length: 60 }, (_, i) => `T${String(i).padStart(2, '0')}`).join('\r');
  const ab = buildTeaReport(request({ variantA: variantA({}, longTitle), variantB: variantB() }), NOW);
  const titleRows = tableByHeading(ab, 'Таблица 6.1').rows.filter(r => r[0] === 'Что оцениваем');
  assert.ok(titleRows.length >= 2);
  assert.equal(joinChunkCells(titleRows.map(r => r[1])), longTitle);
  assert.ok(titleRows.every(r => r[0] === 'Что оцениваем'));
});

test('FIX 4 PDF: the tall CR value runs over several pages - on every page the table title ("продолжение"), the column header and the parameter name are there; every S00..S84 is in the file; no page is empty', async () => {
  const req = request({ handoff: crHandoff() });
  const pdf = await exportTeaReport(req, 'pdf', NOW);
  const pages = (await pdfPages(pdf.buffer)).map(p => p.replace(/\s+/g, ' '));
  const holding = pages.filter(p => /S\d\d/.test(p));
  assert.ok(holding.length >= 2, 'the value continues on a further page');
  for (const page of holding) {
    assert.ok(page.includes('Параметр Значение Источник сведений'), `column header missing: ${page.slice(0, 160)}`);
    assert.ok(page.includes('Источники плазмы'), 'the parameter name is on every page');
  }
  for (const page of holding.slice(1)) assert.ok(page.includes('Таблица 1.1. Параметры конфигурации (продолжение)'), 'the table is named on the continuation page');
  const all = squash(pages.join(' '));
  for (let i = 0; i < 85; i++) assert.ok(all.includes(`S${String(i).padStart(2, '0')}`), `S${i} is in the PDF`);
  assert.ok(!all.includes('\u0000'));
  for (const [i, page] of pages.entries()) assert.ok(page.replace(/Страница \d+ из \d+/, '').trim().length > 150 || i === pages.length - 1, `page ${i + 1} is almost empty`);
  // DOCX: the same rows (the data is the model); its tables keep a repeating header row
  const docx = await exportTeaReport(req, 'docx', NOW);
  const docxAll = squash(docxText(docx.buffer));
  for (let i = 0; i < 85; i++) assert.ok(docxAll.includes(`S${String(i).padStart(2, '0')}`));
  assert.equal((readZipEntryText(docx.buffer, 'word/document.xml').match(/<w:tblHeader\/>/g) ?? []).length, tables(buildTeaReport(req, NOW)).length);
});

test('FIX 4 compatibility: the shared renderer without the new options behaves as before (no "продолжение" title for tables that do not ask for it), and TechDoc layout defaults are unchanged', async () => {
  const { renderGenericPdf } = await import('../src/services/workspace/document-export');
  const rows = Array.from({ length: 120 }, (_, i) => [`Строка ${i}`, 'значение']);
  const vm = { title: 'T', metadata: [], sections: [], tables: [{ heading: 'Длинная таблица', columns: ['A', 'B'], rows }], traceability: [], traceabilityHeading: 'Tr', footer: 'f' };
  const plain = (await pdfPages(await renderGenericPdf(vm))).join(' ');
  assert.ok(!plain.includes('(продолжение)'));
  const withTitle = (await pdfPages(await renderGenericPdf({ ...vm, tables: [{ ...vm.tables[0], repeatHeading: true }] }))).join(' ');
  assert.ok(withTitle.includes('Длинная таблица (продолжение)'));
  assert.equal(columnWidthPt([1, 1], 0), (729.9 / 2) - 6, 'the default width is the landscape card of TechDoc');
});
