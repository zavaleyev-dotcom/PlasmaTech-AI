/** Techno-Economic Assessment report: the content of the DOCX / PDF export. Pure and dependency-free (no server-only): it only turns the
 *  inputs of an assessment into the generic document view model (document-export.ts renders DOCX and PDF from the SAME model, so the two files
 *  carry the same content).
 *
 *  Nothing here calculates anything of its own. The numbers come from `runAssessment` (techno-economic-assessment.ts), the one engine of the
 *  module - called here with exactly the inputs the user calculated with, so the report cannot disagree with the screen. What the module does
 *  NOT calculate (NPV, IRR, discounted payback, break-even without inputs, ...) never appears. A value is always one of three things, and the report
 *  says which: entered by the user ("Исходное значение"), computed by the module ("Рассчитано"), or not given ("Не указано") - an empty field is
 *  never printed as 0. */

import {
  runAssessment, formatCurrency,
  type AssessmentInput, type AssessmentResult, type Currency, type CapexInput, type OpexInput, type ProductionCapacityInput,
} from './techno-economic-assessment';
import type { TechnoEconomicHandoff } from './equipment-selector';
import type { GenericDocumentViewModel, ExportTable, ExportSection, BodyItem } from './document-export';
import { splitTallRows, CONTINUATION_CELL, PDF_PORTRAIT_CONTENT_WIDTH_PT } from './techdoc-card-layout';

/** The request (or the inputs of a variant) is unusable: a clear, user-facing message, safe to show. Anything else that fails while building or rendering is an
 *  internal error and must never reach the user in detail. */
export class ReportInputError extends Error {}

export const REPORT_TITLE = 'Технико-экономическая оценка';
export const SCENARIO_KEYS = ['base', 'conservative', 'optimistic'] as const;
export type ScenarioKey = typeof SCENARIO_KEYS[number];
export const SCENARIO_LABELS: Record<ScenarioKey, string> = { base: 'Базовый', conservative: 'Консервативный', optimistic: 'Оптимистичный' };

export interface ReportVariant { title?: string; input: AssessmentInput }

/** What the report is built from: the inputs of the calculation the user ran (the variants / scenarios that were active), the display currency and, if
 *  the user brought one, the configuration handed over from Equipment Selector. */
export interface TeaReportRequest {
  currency: Currency;
  variantA: ReportVariant;
  variantB?: ReportVariant;
  scenarios?: Record<ScenarioKey, ReportVariant>;
  handoff?: TechnoEconomicHandoff;
}

export const CURRENCY_NAMES: Record<Currency, string> = { RUB: 'российский рубль (RUB, ₽)', USD: 'доллар США (USD, $)', EUR: 'евро (EUR, €)' };

// ---------- what a value is ----------

const INPUT = 'Исходное значение';
const COMPUTED = 'Рассчитано';
const MISSING = 'Не указано';
const NOT_GIVEN = 'не указано';

/** A plain number as the user typed it (no rounding): "0,005", "1 250 000,5". */
function plain(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 20 });
}
/** An amount ENTERED by the user: every digit is kept (formatCurrency rounds to 2 places, which is right for results but would hide a typed 0.005). */
function inputMoney(value: number, currency: Currency): string {
  const parts = new Intl.NumberFormat(CURRENCY_LOCALE[currency], { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 20 });
  return parts.format(value);
}
const CURRENCY_LOCALE: Record<Currency, string> = { RUB: 'ru-RU', USD: 'en-US', EUR: 'de-DE' };
/** A computed number shown to at most 2 decimals (the precision of the module's own result cards), trailing zeros kept for money only. */
const computedNumber = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

function dateText(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long' }).format(date);
}
const isoDate = (date: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
};

type Row = [label: string, value: string, kind: string];
const MEASURE_COLUMNS = ['Показатель', 'Значение', 'Происхождение значения'];
const MEASURE_WEIGHTS = [5, 4, 3];

/** A table of the report. A row whose text is too tall for one page (a very long value, many lines) is split into marked continuation rows by the SAME
 *  proven logic as the TechDoc card (splitTallRows): the first column (the name of the parameter) is repeated in every piece, nothing is cut. The PDF
 *  repeats the column header and the table title on every page the table continues on. */
function table(heading: string, rows: string[][], columns: string[] = MEASURE_COLUMNS, weights: number[] = MEASURE_WEIGHTS): ExportTable {
  return { heading, columns, rows: splitTallRows(rows.map(r => [...r]), weights, [0], PDF_PORTRAIT_CONTENT_WIDTH_PT), columnWeights: weights, repeatHeading: true };
}
const section = (heading: string, ...paragraphs: string[]): BodyItem => ({ kind: 'section', section: { heading, paragraphs } satisfies ExportSection });
const tableItem = (t: ExportTable): BodyItem => ({ kind: 'table', table: t });

// ---------- source items: which cost lines were filled ----------

const CAPEX_LABELS: [keyof CapexInput, string][] = [
  ['equipment', 'Оборудование'], ['delivery', 'Доставка'], ['customsLogistics', 'Таможня / логистика'], ['installation', 'Монтаж'], ['commissioning', 'Пусконаладка'],
  ['training', 'Обучение'], ['infrastructure', 'Инфраструктура'], ['tooling', 'Оснастка / комплектующие'], ['otherOneTime', 'Прочие единовременные затраты'],
];
const OPEX_LABELS: [keyof OpexInput, string][] = [
  ['electricity', 'Электроэнергия'], ['processGases', 'Технологические газы'], ['consumables', 'Расходные материалы'], ['targetsCathodes', 'Мишени / катоды'], ['reagents', 'Реактивы'],
  ['maintenance', 'Обслуживание'], ['repairs', 'Ремонт'], ['labor', 'Персонал'], ['facilities', 'Аренда / помещения'], ['disposal', 'Утилизация'], ['otherOperating', 'Прочие эксплуатационные расходы'],
];
const filled = <T extends object>(input: T, labels: [keyof T, string][]) => labels.filter(([key]) => typeof input[key] === 'number') as [keyof T, string][];
const notFilled = <T extends object>(input: T, labels: [keyof T, string][]) => labels.filter(([key]) => typeof input[key] !== 'number').map(([, label]) => label);

const PERIOD_LABEL = { month: 'месяц', year: 'год' } as const;
const CAPACITY_LABELS: [keyof ProductionCapacityInput, string, string][] = [
  ['shiftsPerDay', 'Сменность (смен в сутки)', ''], ['hoursPerShift', 'Часов в смену', ' ч'], ['workingDaysPerYear', 'Рабочих дней в год', ' дн.'],
  ['utilizationPercent', 'Загрузка оборудования', ' %'], ['cycleTimeMinutes', 'Время технологического цикла', ' мин'], ['unitsPerCycle', 'Количество изделий за цикл', ' шт.'],
];

// ---------- one variant: the sections 2-5 ----------

interface Assessed { title?: string; input: AssessmentInput; result: AssessmentResult }

function assess(variant: ReportVariant, label: string): Assessed {
  try { return { title: variant.title, input: variant.input, result: runAssessment(variant.input) }; }
  catch (error) {
    // the engine reports invalid inputs with plain, user-facing Errors; anything else (a TypeError, ...) is a defect, not the user's input
    if (error instanceof Error && error.constructor === Error) throw new ReportInputError(`${label}: расчёт не выполнен - ${error.message}`);
    throw error;
  }
}

function capexRows(a: Assessed, currency: Currency): { rows: Row[]; missing: string[] } {
  const items = filled(a.input.capex, CAPEX_LABELS);
  const rows: Row[] = items.map(([key, label]) => [label, inputMoney(a.input.capex[key] as number, currency), INPUT]);
  rows.push(['Итого CAPEX', formatCurrency(a.result.capex.total, currency), COMPUTED]);
  return { rows, missing: notFilled(a.input.capex, CAPEX_LABELS) };
}

function opexRows(a: Assessed, currency: Currency): { rows: Row[]; missing: string[] } {
  const items = filled(a.input.opex, OPEX_LABELS);
  const period = PERIOD_LABEL[a.input.opex.period];
  const rows: Row[] = items.map(([key, label]) => [`${label} (за ${period})`, inputMoney(a.input.opex[key] as number, currency), INPUT]);
  rows.push([`Итого OPEX за ${period}`, formatCurrency(a.result.opex.totalPerPeriod, currency), COMPUTED]);
  rows.push(['Годовой эквивалент (OPEX в год)', formatCurrency(a.result.opex.annualTotal, currency), COMPUTED]);
  return { rows, missing: notFilled(a.input.opex, OPEX_LABELS) };
}

function capacityRows(a: Assessed, currency: Currency): { inputs: Row[]; computed: Row[] } {
  const c = a.input.capacity;
  const inputs: Row[] = CAPACITY_LABELS.map(([key, label, unit]) => [label, `${plain(c[key])}${unit}`, INPUT]);
  inputs.push(['Срок амортизации', a.input.depreciationYears !== undefined ? `${plain(a.input.depreciationYears)} лет` : NOT_GIVEN, a.input.depreciationYears !== undefined ? INPUT : MISSING]);
  const r = a.result;
  const computed: Row[] = [
    ['Эффективных часов работы в год', computedNumber(r.capacity.effectiveHoursPerYear), COMPUTED],
    ['Циклов в год', computedNumber(r.capacity.cyclesPerYear), COMPUTED],
    ['Расчётный годовой выпуск', `${computedNumber(r.capacity.unitsPerYear)} ед.`, COMPUTED],
    ['Себестоимость изделия без амортизации', formatCurrency(r.unitCost.withoutDepreciation, currency), COMPUTED],
  ];
  if (r.unitCost.withDepreciation !== null && r.unitCost.annualDepreciation !== null) {
    computed.push(['Годовая амортизация', formatCurrency(r.unitCost.annualDepreciation, currency), COMPUTED]);
    computed.push(['Себестоимость изделия с амортизацией', formatCurrency(r.unitCost.withDepreciation, currency), COMPUTED]);
  } else {
    computed.push(['Себестоимость изделия с амортизацией', 'не рассчитывалась: срок амортизации не указан', MISSING]);
  }
  return { inputs, computed };
}

function economicRows(a: Assessed, currency: Currency): Row[] {
  const e = a.input.economicEffect;
  const r = a.result;
  const rows: Row[] = [];
  if (e.mode === 'unit_cost') {
    rows.push(['Способ расчёта эффекта', 'по себестоимости единицы (текущая / новая)', INPUT]);
    rows.push(['Текущая себестоимость единицы', e.currentUnitCost !== undefined ? inputMoney(e.currentUnitCost, currency) : NOT_GIVEN, e.currentUnitCost !== undefined ? INPUT : MISSING]);
    rows.push(['Новая себестоимость единицы', e.newUnitCost !== undefined ? inputMoney(e.newUnitCost, currency) : NOT_GIVEN, e.newUnitCost !== undefined ? INPUT : MISSING]);
    // an output the user GAVE is an input; only when none was given does the module use the output it calculated (section 4)
    if (e.annualOutput !== undefined) rows.push(['Годовой выпуск для расчёта экономии', `${plain(e.annualOutput)} ед.`, INPUT]);
    else rows.push(['Годовой выпуск для расчёта экономии', `${computedNumber(r.capacity.unitsPerYear)} ед. (расчётный выпуск, раздел 4)`, COMPUTED]);
    if (r.economicEffect.savingsPerUnit !== null) rows.push(['Экономия на единицу', formatCurrency(r.economicEffect.savingsPerUnit, currency), COMPUTED]);
  } else {
    rows.push(['Способ расчёта эффекта', 'по текущим и новым годовым затратам', INPUT]);
    rows.push(['Текущие внешние затраты в год', e.currentAnnualCost !== undefined ? inputMoney(e.currentAnnualCost, currency) : NOT_GIVEN, e.currentAnnualCost !== undefined ? INPUT : MISSING]);
    rows.push(['Затраты после внедрения в год', e.newAnnualCost !== undefined ? inputMoney(e.newAnnualCost, currency) : NOT_GIVEN, e.newAnnualCost !== undefined ? INPUT : MISSING]);
  }
  rows.push(['Годовая экономия', formatCurrency(r.economicEffect.annualSavings, currency), COMPUTED]);
  rows.push(['Срок окупаемости (простой, без дисконтирования)', r.payback.years !== null ? `${r.payback.years.toFixed(2)} лет (${r.payback.months!.toFixed(1)} мес.)` : `не определён: ${r.payback.message}`, COMPUTED]);
  rows.push(['ROI', `${r.roi.percent.toFixed(1)} %`, COMPUTED]);
  if (r.breakEven) rows.push(['Точка безубыточности', r.breakEven.volumeUnits !== null ? `${computedNumber(r.breakEven.volumeUnits)} ед.` : `не определена: ${r.breakEven.message}`, COMPUTED]);
  return rows;
}

// ---------- the technical configuration (section 1) ----------

function configurationRows(h: TechnoEconomicHandoff): Row[] {
  const list = (items: string[]) => items.length > 0 ? items.join(', ') : NOT_GIVEN;
  const FROM = 'Equipment Selector';
  return [
    ['Тип установки (типовая категория конфигурации)', h.configurationName, FROM],
    ['Технология', list(h.supportedTechnologies), FROM],
    ['Поддерживаемые процессы', list(h.supportedPurposes), FROM],
    ['Источники плазмы', h.sourcesSummary, FROM],
    ['Газовая система (максимум газовых линий)', String(h.maxGasLines), FROM],
    ['Максимальная температура процесса', `${plain(h.maxProcessTempC)} °C`, FROM],
    ['Вакуумные требования', 'Equipment Selector не передаёт', MISSING],
    ['Максимальный размер камеры', `${plain(h.maxChamberSizeMm)} мм`, FROM],
    ['Производительность (класс)', list(h.throughputClasses), FROM],
    ['Автоматизация', list(h.automationLevels), FROM],
    ['Чистое помещение (cleanroom)', list(h.cleanroomSupport), FROM],
  ];
}

// ---------- comparison tables ----------

function compareInputs(variants: { name: string; a: Assessed }[], currency: Currency): string[][] {
  // one row per item that at least one variant filled; a variant that left it empty shows "не указано"
  const rows: string[][] = [];
  const add = (label: string, cell: (a: Assessed) => string | undefined) => {
    const cells = variants.map(v => cell(v.a));
    if (cells.every(c => c === undefined)) return;
    rows.push([label, ...cells.map(c => c ?? NOT_GIVEN)]);
  };
  add('Что оцениваем', a => a.title && a.title.trim() !== '' ? a.title : undefined);
  for (const [key, label] of CAPEX_LABELS) add(`CAPEX: ${label}`, a => typeof a.input.capex[key] === 'number' ? inputMoney(a.input.capex[key] as number, currency) : undefined);
  add('Период ввода OPEX', a => PERIOD_LABEL[a.input.opex.period]);
  for (const [key, label] of OPEX_LABELS) add(`OPEX: ${label}`, a => typeof a.input.opex[key] === 'number' ? inputMoney(a.input.opex[key] as number, currency) : undefined);
  for (const [key, label, unit] of CAPACITY_LABELS) add(label, a => `${plain(a.input.capacity[key])}${unit}`);
  add('Срок амортизации', a => a.input.depreciationYears !== undefined ? `${plain(a.input.depreciationYears)} лет` : undefined);
  add('Способ расчёта эффекта', a => a.input.economicEffect.mode === 'unit_cost' ? 'по себестоимости единицы' : 'по годовым затратам');
  add('Годовой выпуск для расчёта экономии (задан явно)', a => a.input.economicEffect.mode === 'unit_cost' && a.input.economicEffect.annualOutput !== undefined ? `${plain(a.input.economicEffect.annualOutput)} ед.` : undefined);
  add('Текущая себестоимость единицы', a => a.input.economicEffect.currentUnitCost !== undefined ? inputMoney(a.input.economicEffect.currentUnitCost, currency) : undefined);
  add('Новая себестоимость единицы', a => a.input.economicEffect.newUnitCost !== undefined ? inputMoney(a.input.economicEffect.newUnitCost, currency) : undefined);
  add('Текущие внешние затраты в год', a => a.input.economicEffect.currentAnnualCost !== undefined ? inputMoney(a.input.economicEffect.currentAnnualCost, currency) : undefined);
  add('Затраты после внедрения в год', a => a.input.economicEffect.newAnnualCost !== undefined ? inputMoney(a.input.economicEffect.newAnnualCost, currency) : undefined);
  return rows;
}

function compareComputed(variants: { name: string; a: Assessed }[], currency: Currency): string[][] {
  const money = (v: number) => formatCurrency(v, currency);
  const rows: [string, (r: AssessmentResult) => string][] = [
    ['CAPEX', r => money(r.capex.total)],
    ['OPEX в год', r => money(r.opex.annualTotal)],
    ['Расчётный годовой выпуск, ед.', r => computedNumber(r.capacity.unitsPerYear)],
    ['Себестоимость изделия без амортизации', r => money(r.unitCost.withoutDepreciation)],
    ['Себестоимость изделия с амортизацией', r => r.unitCost.withDepreciation !== null ? money(r.unitCost.withDepreciation) : 'не рассчитывалась'],
    ['Годовая экономия', r => money(r.economicEffect.annualSavings)],
    ['Срок окупаемости (простой), лет', r => r.payback.years !== null ? r.payback.years.toFixed(2) : 'не определён'],
    ['ROI, %', r => r.roi.percent.toFixed(1)],
  ];
  return rows.map(([label, f]) => [label, ...variants.map(v => f(v.a.result))]);
}

function variantsTable(heading: string, names: string[], rows: string[][]): ExportTable {
  return table(heading, rows, ['Показатель', ...names], [4, ...names.map(() => 3)]);
}

// ---------- methodology (section 8) ----------

function methodologyRows(a: Assessed): string[][] {
  const r = a.result;
  const mode = a.input.economicEffect.mode;
  return [
    ['CAPEX', 'сумма заполненных статей единовременных затрат (оборудование, доставка, таможня/логистика, монтаж, пусконаладка, обучение, инфраструктура, оснастка, прочее)', `${r.capex.formula} = ${r.capex.total.toFixed(2)}`],
    ['OPEX в год', 'сумма заполненных статей за введённый период; если период — месяц, годовой эквивалент = сумма за месяц × 12; если год — сумма статей', `${r.opex.formula}; OPEX в год = ${r.opex.annualTotal.toFixed(2)}`],
    ['Производительность', 'эффективные часы = смен × часов в смену × рабочих дней × загрузка / 100; циклов в год = эффективные часы × 60 / время цикла (мин); выпуск в год = циклов в год × изделий за цикл', r.capacity.formula],
    ['Себестоимость изделия', 'без амортизации = OPEX в год / выпуск в год; с амортизацией (если указан срок) = (OPEX в год + CAPEX / срок амортизации) / выпуск в год', r.unitCost.formula],
    ['Годовая экономия', mode === 'unit_cost'
      ? 'экономия на единицу = текущая − новая себестоимость единицы; годовая экономия = экономия на единицу × годовой выпуск'
      : 'годовая экономия = текущие внешние затраты в год − затраты после внедрения в год', r.economicEffect.formula],
    ['Срок окупаемости (простой)', 'CAPEX / годовая экономия; не определён, если годовая экономия не положительна. Не дисконтируется', r.payback.formula],
    ['ROI', 'годовая экономия / CAPEX × 100 (годовая экономия уже учитывает эксплуатационные затраты нового решения, повторно OPEX не вычитается)', r.roi.formula],
  ];
}

function variableRows(a: Assessed, currency: Currency): Row[] {
  const r = a.result;
  const money = (v: number) => formatCurrency(v, currency);
  return [
    ['CAPEX', money(r.capex.total), COMPUTED],
    ['OPEX в год', money(r.opex.annualTotal), COMPUTED],
    ['Расчётный годовой выпуск', `${computedNumber(r.capacity.unitsPerYear)} ед.`, COMPUTED],
    ['Срок амортизации', a.input.depreciationYears !== undefined ? `${plain(a.input.depreciationYears)} лет` : NOT_GIVEN, a.input.depreciationYears !== undefined ? INPUT : MISSING],
    ['Годовая экономия', money(r.economicEffect.annualSavings), COMPUTED],
    ['Валюта', CURRENCY_NAMES[currency], INPUT],
  ];
}

// ---------- the report ----------

/** Builds the report. `generatedAt` is the date printed on the title page. Throws a clear message if the inputs of a variant do not calculate. */
export function buildTeaReport(request: TeaReportRequest, generatedAt: Date): GenericDocumentViewModel {
  const currency = request.currency;
  const a = assess(request.variantA, 'Вариант A');
  const b = request.variantB ? assess(request.variantB, 'Вариант B') : undefined;
  const scenarios = request.scenarios
    ? Object.fromEntries(SCENARIO_KEYS.map(key => [key, assess(request.scenarios![key], `Сценарий «${SCENARIO_LABELS[key]}»`)])) as Record<ScenarioKey, Assessed>
    : undefined;
  const multi = b !== undefined || scenarios !== undefined;
  const suffix = multi ? ' (Вариант A)' : '';

  const body: BodyItem[] = [];

  // 1. technical configuration
  body.push(section('1. Техническая конфигурация',
    request.handoff
      ? `Конфигурация передана из модуля Equipment Selector. Это типовая категория оборудования с техническими возможностями, а не конкретная модель или коммерческое предложение производителя. ${request.handoff.note}`
      : 'Техническая конфигурация из Equipment Selector не передавалась: ниже нет сведений об оборудовании, их не заполняли автоматически.'));
  if (request.handoff) body.push(tableItem(table('Таблица 1.1. Параметры конфигурации', configurationRows(request.handoff), ['Параметр', 'Значение', 'Источник сведений'])));

  // 2. CAPEX
  const capex = capexRows(a, currency);
  body.push(section(`2. Капитальные затраты (CAPEX)${suffix}`,
    `Валюта: ${CURRENCY_NAMES[currency]}. Суммы введены пользователем в этой валюте; конвертация не выполняется. Исходные суммы показаны без округления, итог — рассчитан модулем.`));
  body.push(tableItem(table('Таблица 2.1. Статьи CAPEX', capex.rows)));
  if (capex.missing.length > 0) body.push(section('', `Не заполнены (в расчёт не входят, как 0 не подставлялись): ${capex.missing.join('; ')}.`));

  // 3. OPEX
  const opex = opexRows(a, currency);
  body.push(section(`3. Эксплуатационные затраты (OPEX)${suffix}`,
    `Период ввода данных, указанный пользователем: ${PERIOD_LABEL[a.input.opex.period]}. ${a.input.opex.period === 'month' ? 'Годовой эквивалент рассчитан приложением как сумма за месяц × 12.' : 'Статьи введены за год, годовой эквивалент равен их сумме.'} Валюта: ${CURRENCY_NAMES[currency]}.`));
  body.push(tableItem(table('Таблица 3.1. Статьи OPEX', opex.rows)));
  if (opex.missing.length > 0) body.push(section('', `Не заполнены (в расчёт не входят, как 0 не подставлялись): ${opex.missing.join('; ')}.`));

  // 4. capacity
  const capacity = capacityRows(a, currency);
  body.push(section(`4. Производительность${suffix}`));
  body.push(tableItem(table('Таблица 4.1. Исходные данные', capacity.inputs)));
  body.push(tableItem(table('Таблица 4.2. Расчётные показатели', capacity.computed)));

  // 5. economics
  body.push(section(`5. Экономические показатели${suffix}`,
    'Окупаемость — простая (CAPEX / годовая экономия), без дисконтирования. ROI — упрощённый (годовая экономия / CAPEX × 100).'));
  body.push(tableItem(table('Таблица 5.1. Экономические показатели', economicRows(a, currency))));

  // 6. A/B
  if (b) {
    const variants = [{ name: 'Вариант A', a }, { name: 'Вариант B', a: b }];
    body.push(section('6. Сравнение вариантов A/B', 'Сравнение носит информационный характер: победитель не выбирается. Суммы обоих вариантов введены в одной валюте, конвертация не выполняется.'));
    body.push(tableItem(variantsTable('Таблица 6.1. Исходные значения', variants.map(v => v.name), compareInputs(variants, currency))));
    body.push(tableItem(variantsTable('Таблица 6.2. Расчётные показатели', variants.map(v => v.name), compareComputed(variants, currency))));
  }

  // 7. scenarios
  if (scenarios) {
    const variants = SCENARIO_KEYS.map(key => ({ name: SCENARIO_LABELS[key], a: scenarios[key] }));
    body.push(section('7. Сценарный анализ', 'Каждый сценарий рассчитан тем же движком по значениям, которые ввёл пользователь; допущения «консервативный» и «оптимистичный» приложение не придумывает.'));
    body.push(tableItem(variantsTable('Таблица 7.1. Исходные значения сценариев', variants.map(v => v.name), compareInputs(variants, currency))));
    body.push(tableItem(variantsTable('Таблица 7.2. Расчётные показатели сценариев', variants.map(v => v.name), compareComputed(variants, currency))));
  }

  if (body.some(i => i.kind === 'table' && i.table.rows.some(r => r.includes(CONTINUATION_CELL)))) {
    body.push(section('Примечание о длинных значениях', `Значение, не помещающееся на странице, разбито на части «[k/n]» в нескольких строках таблицы: каждая строка повторяет название параметра, «${CONTINUATION_CELL}» означает, что значение указано в первой строке. Части идут по порядку и являются непрерывными фрагментами исходного значения; маркер «[k/n] » (скобки, дробь и один пробел) - только нумерация: чтобы получить исходное значение, отбросьте этот префикс у каждой части и соедините части подряд, ничего не добавляя.`));
  }

  // 8. methodology
  body.push(section('8. Методика расчётов', 'Формулы применены приложением без изменений. Значения подставлены из введённых данных; в расчёте используются полные значения, округление (до 2 знаков для денежных величин) выполняется только при отображении.'));
  body.push(tableItem(table(`Таблица 8.1. Формулы${multi ? ' (расчёт Варианта A)' : ''}`, methodologyRows(a), ['Показатель', 'Формула', 'Подстановка значений'], [3, 6, 6])));
  body.push(tableItem(table(`Таблица 8.2. Значения основных переменных${multi ? ' (Вариант A)' : ''}`, variableRows(a, currency))));
  body.push(section('Принятые допущения',
    '1. Годовые значения (затраты, выпуск, экономия) принимаются постоянными; показатели относятся к одному типовому году.',
    `2. Все суммы заданы в одной валюте: ${CURRENCY_NAMES[currency]}; курс валют и пересчёт приложением не применяются.`,
    '3. Годовая экономия равна разности введённых затрат (текущих и новых) и считается уже с учётом эксплуатационных затрат нового решения.',
    '4. Выпуск рассчитан по введённым сменности, числу рабочих дней, загрузке оборудования и времени цикла.'));
  body.push(section('Ограничения интерпретации',
    '1. Срок окупаемости простой: деньги разных лет не дисконтируются, инфляция, налоги, процентные ставки и остаточная стоимость не учитываются.',
    '2. ROI — упрощённая инженерная оценка, не бухгалтерский и не инвестиционный показатель. Модуль не рассчитывает NPV, IRR и дисконтированную окупаемость.',
    '3. Точность результатов не выше точности введённых данных; пустые поля не заменялись нулями или типовыми значениями.',
    '4. Конфигурация Equipment Selector — типовая категория; цены оборудования и эксплуатационные затраты она не содержит и вводятся пользователем.',
    '5. Документ не заменяет бухгалтерское, налоговое или инвестиционное заключение.'));

  const titleLine = (request.variantA.title && request.variantA.title.trim() !== '') ? request.variantA.title : NOT_GIVEN;
  const mode = scenarios ? 'три сценария (базовый, консервативный, оптимистичный)' : b ? 'сравнение вариантов A и B' : 'один вариант';
  return {
    title: REPORT_TITLE,
    metadata: [
      { label: 'Тип отчёта', value: REPORT_TITLE },
      { label: 'Проект / оцениваемое оборудование', value: titleLine },
      { label: 'Конфигурация (Equipment Selector)', value: request.handoff ? `${request.handoff.configurationName} (типовая категория, не конкретная модель)` : 'не передавалась' },
      { label: 'Состав расчёта', value: mode },
      { label: 'Валюта', value: CURRENCY_NAMES[currency] },
      { label: 'Дата формирования', value: dateText(generatedAt) },
    ],
    sections: body.filter((i): i is Extract<BodyItem, { kind: 'section' }> => i.kind === 'section').map(i => i.section),
    tables: body.filter((i): i is Extract<BodyItem, { kind: 'table' }> => i.kind === 'table').map(i => i.table),
    body,
    traceability: [
      { label: 'Источник расчётов', value: 'модуль Techno-Economic Assessment платформы PlasmaTech AI, локальный расчёт без внешних API' },
      { label: 'Данные', value: 'введены пользователем; отсутствующие значения не заменялись' },
      { label: 'Дата формирования', value: dateText(generatedAt) },
    ],
    traceabilityHeading: 'Сведения о документе',
    footer: `${REPORT_TITLE} • ${titleLine} • ${dateText(generatedAt)}`,
    metadataPlacement: 'top',
  };
}

export function reportFilename(request: TeaReportRequest, generatedAt: Date, format: 'docx' | 'pdf', sanitize: (v: string, fallback: string) => string): string {
  return `${sanitize(request.variantA.title ?? '', 'TEA')}_TEA-report_${isoDate(generatedAt)}.${format}`;
}

/** The request the export route receives for ONE snapshot of a calculation: everything in it (inputs, currency, configuration) was fixed when the calculation
 *  ran, so nothing that changes on the screen afterwards can alter an old report. */
export function reportRequestBody(snapshot: TeaReportRequest, format: 'docx' | 'pdf'): { report: TeaReportRequest; format: 'docx' | 'pdf' } {
  return { report: snapshot, format };
}
