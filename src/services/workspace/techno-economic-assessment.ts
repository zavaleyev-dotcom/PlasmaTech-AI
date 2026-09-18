/** Real, local, dependency-free techno-economic assessment for PVD/CVD/PECVD equipment and
 *  processes - no external API, no LLM, no network call. Every formula here is a plain,
 *  transparent arithmetic relationship (see each function's own doc comment for the exact
 *  formula) - nothing is estimated, guessed, or looked up from an external source. This is
 *  the REAL production execution path for the "Techno-Economic Assessment" workspace module
 *  (src/components/techno-economic-assessment.tsx), replacing the demo provider's fixed,
 *  input-independent bullet list. */

// ---------- shared validation ----------

interface ValidateOptions { min?: number; max?: number; allowZero?: boolean }

/** Rejects NaN/Infinity/-Infinity and anything outside [min, max] (min defaults to 0,
 *  exclusive unless allowZero) with one clear, field-named message - never silently clamps
 *  or substitutes a default for an out-of-range value. */
function assertValid(value: number, label: string, options: ValidateOptions = {}): number {
  const { min = 0, max = Infinity, allowZero = false } = options;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: введите конечное число.`);
  if (allowZero ? value < min : value <= min) {
    throw new Error(`${label}: значение должно быть ${allowZero ? 'не меньше' : 'больше'} ${min}.`);
  }
  if (value > max) throw new Error(`${label}: значение должно быть не больше ${max}.`);
  return value;
}

/** Optional numeric field: undefined/empty means "not provided" (defaults to 0 for a sum),
 *  but if a value IS given, it must be valid (never a negative one-time/operating cost). */
function optionalNonNegative(value: number | undefined, label: string): number {
  if (value === undefined) return 0;
  return assertValid(value, label, { allowZero: true });
}

// ---------- currency: display formatting ONLY - never a conversion ----------

export type Currency = 'RUB' | 'USD' | 'EUR';
const CURRENCY_LOCALE: Record<Currency, string> = { RUB: 'ru-RU', USD: 'en-US', EUR: 'de-DE' };

/** Formats a number with a currency symbol. Deliberately does NOT accept or apply any
 *  exchange rate - the numeric value passed in is shown exactly as given, only the symbol/
 *  grouping changes. Comparing amounts entered in different currencies is the user's own
 *  responsibility (item 11: no automatic conversion without an explicitly supplied rate). */
export function formatCurrency(value: number, currency: Currency): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

// ---------- A. CAPEX ----------

export interface CapexInput {
  equipment: number;
  delivery?: number;
  customsLogistics?: number;
  installation?: number;
  commissioning?: number;
  training?: number;
  infrastructure?: number;
  tooling?: number;
  otherOneTime?: number;
}

export interface CapexLineItem { label: string; value: number }
export interface CapexResult { total: number; lineItems: CapexLineItem[]; formula: string }

/** CAPEX total = equipment + delivery + installation + commissioning + training +
 *  infrastructure + tooling + other one-time costs (+ customs/logistics). Only `equipment`
 *  is required; every other field defaults to 0 when omitted. */
export function calculateCapex(input: CapexInput): CapexResult {
  const equipment = assertValid(input.equipment, 'Стоимость оборудования');
  const lineItems: CapexLineItem[] = [
    { label: 'Оборудование', value: equipment },
    { label: 'Доставка', value: optionalNonNegative(input.delivery, 'Доставка') },
    { label: 'Таможня / логистика', value: optionalNonNegative(input.customsLogistics, 'Таможня / логистика') },
    { label: 'Монтаж', value: optionalNonNegative(input.installation, 'Монтаж') },
    { label: 'Пусконаладка', value: optionalNonNegative(input.commissioning, 'Пусконаладка') },
    { label: 'Обучение', value: optionalNonNegative(input.training, 'Обучение') },
    { label: 'Инфраструктура', value: optionalNonNegative(input.infrastructure, 'Инфраструктура') },
    { label: 'Оснастка / комплектующие', value: optionalNonNegative(input.tooling, 'Оснастка / комплектующие') },
    { label: 'Прочие единовременные затраты', value: optionalNonNegative(input.otherOneTime, 'Прочие единовременные затраты') },
  ];
  const total = lineItems.reduce((sum, item) => sum + item.value, 0);
  return { total, lineItems, formula: lineItems.map(i => i.label).join(' + ') };
}

// ---------- B. OPEX ----------

export type OpexPeriod = 'month' | 'year';

export interface OpexInput {
  period: OpexPeriod;
  electricity?: number;
  processGases?: number;
  consumables?: number;
  targetsCathodes?: number;
  reagents?: number;
  maintenance?: number;
  repairs?: number;
  labor?: number;
  facilities?: number;
  disposal?: number;
  otherOperating?: number;
}

export interface OpexResult { totalPerPeriod: number; period: OpexPeriod; annualTotal: number; lineItems: CapexLineItem[]; formula: string }

/** Sums every OPEX line for the period the user entered them in (month or year), then
 *  reports the annualized total explicitly - the UI must always show WHICH period a number
 *  belongs to (item 3: "UI должен ясно показывать период"), never a bare number. */
export function calculateOpex(input: OpexInput): OpexResult {
  const lineItems: CapexLineItem[] = [
    { label: 'Электроэнергия', value: optionalNonNegative(input.electricity, 'Электроэнергия') },
    { label: 'Технологические газы', value: optionalNonNegative(input.processGases, 'Технологические газы') },
    { label: 'Расходные материалы', value: optionalNonNegative(input.consumables, 'Расходные материалы') },
    { label: 'Мишени / катоды', value: optionalNonNegative(input.targetsCathodes, 'Мишени / катоды') },
    { label: 'Реактивы', value: optionalNonNegative(input.reagents, 'Реактивы') },
    { label: 'Обслуживание', value: optionalNonNegative(input.maintenance, 'Обслуживание') },
    { label: 'Ремонт', value: optionalNonNegative(input.repairs, 'Ремонт') },
    { label: 'Персонал', value: optionalNonNegative(input.labor, 'Персонал') },
    { label: 'Аренда / помещения', value: optionalNonNegative(input.facilities, 'Аренда / помещения') },
    { label: 'Утилизация', value: optionalNonNegative(input.disposal, 'Утилизация') },
    { label: 'Прочие эксплуатационные расходы', value: optionalNonNegative(input.otherOperating, 'Прочие эксплуатационные расходы') },
  ];
  const totalPerPeriod = lineItems.reduce((sum, item) => sum + item.value, 0);
  const annualTotal = input.period === 'month' ? totalPerPeriod * 12 : totalPerPeriod;
  return { totalPerPeriod, period: input.period, annualTotal, lineItems, formula: input.period === 'month' ? 'год = сумма за месяц × 12' : 'год = сумма введённых годовых статей' };
}

// ---------- C. Production capacity ----------

export interface ProductionCapacityInput {
  shiftsPerDay: number;
  hoursPerShift: number;
  workingDaysPerYear: number;
  utilizationPercent: number;
  cycleTimeMinutes: number;
  unitsPerCycle: number;
}

export interface ProductionCapacityResult {
  effectiveHoursPerYear: number;
  cyclesPerYear: number;
  unitsPerYear: number;
  formula: string;
}

/** effectiveHours = shifts/day × hours/shift × working days/year × utilization%;
 *  cycles/year = effectiveHours × 60 / cycleTimeMinutes; units/year = cycles/year ×
 *  units/cycle. Cycle time must be strictly positive (a zero cycle time is physically
 *  meaningless and would divide by zero) - explicitly rejected, never silently skipped. */
export function calculateProductionCapacity(input: ProductionCapacityInput): ProductionCapacityResult {
  const shiftsPerDay = assertValid(input.shiftsPerDay, 'Смен в сутки');
  const hoursPerShift = assertValid(input.hoursPerShift, 'Часов в смену');
  const workingDaysPerYear = assertValid(input.workingDaysPerYear, 'Рабочих дней в год', { max: 366 });
  const utilizationPercent = assertValid(input.utilizationPercent, 'Загрузка оборудования', { max: 100, allowZero: true });
  const cycleTimeMinutes = assertValid(input.cycleTimeMinutes, 'Время одного цикла');
  const unitsPerCycle = assertValid(input.unitsPerCycle, 'Количество изделий за цикл');

  const effectiveHoursPerYear = shiftsPerDay * hoursPerShift * workingDaysPerYear * (utilizationPercent / 100);
  const cyclesPerYear = (effectiveHoursPerYear * 60) / cycleTimeMinutes;
  const unitsPerYear = cyclesPerYear * unitsPerCycle;
  return {
    effectiveHoursPerYear, cyclesPerYear, unitsPerYear,
    formula: `эфф. часы = ${shiftsPerDay} × ${hoursPerShift} × ${workingDaysPerYear} × ${(utilizationPercent / 100).toFixed(2)}; циклов/год = эфф. часы × 60 / ${cycleTimeMinutes}; ед./год = циклов/год × ${unitsPerCycle}`,
  };
}

// ---------- D. Unit cost (with/without depreciation) ----------

export interface UnitCostResult {
  withoutDepreciation: number;
  withDepreciation: number | null;
  annualDepreciation: number | null;
  formula: string;
}

/** withoutDepreciation = annualOperatingCost / annualOutput. If depreciationYears is
 *  supplied, annualDepreciation = capex / depreciationYears is ADDED to annual cost before
 *  dividing for withDepreciation - both figures are always shown side by side (item 5). */
export function calculateUnitCost(annualOperatingCost: number, annualOutput: number, capex?: number, depreciationYears?: number): UnitCostResult {
  assertValid(annualOperatingCost, 'Годовые эксплуатационные затраты', { allowZero: true });
  const output = assertValid(annualOutput, 'Годовой выпуск продукции');
  const withoutDepreciation = annualOperatingCost / output;
  // The deciding factor is whether a depreciation PERIOD was given, not whether capex itself
  // was passed - in the full pipeline (runAssessment), capex is always known (it is itself
  // computed), so keying this on capex's presence would make "no depreciation requested"
  // unreachable in practice.
  if (depreciationYears === undefined) {
    return { withoutDepreciation, withDepreciation: null, annualDepreciation: null, formula: `себестоимость = OPEX/год / выпуск/год = ${annualOperatingCost.toFixed(2)} / ${output.toFixed(2)}` };
  }
  const capexValue = assertValid(capex ?? 0, 'CAPEX для амортизации', { allowZero: true });
  const years = assertValid(depreciationYears ?? 0, 'Срок амортизации, лет');
  const annualDepreciation = capexValue / years;
  const withDepreciation = (annualOperatingCost + annualDepreciation) / output;
  return {
    withoutDepreciation, withDepreciation, annualDepreciation,
    formula: `с амортизацией = (OPEX/год + CAPEX/срок) / выпуск/год = (${annualOperatingCost.toFixed(2)} + ${capexValue.toFixed(2)}/${years}) / ${output.toFixed(2)}`,
  };
}

// ---------- E. Economic effect ----------

export type EconomicEffectMode = 'unit_cost' | 'total_external_cost';

export interface EconomicEffectInput {
  mode: EconomicEffectMode;
  currentUnitCost?: number;
  newUnitCost?: number;
  annualOutput?: number;
  currentAnnualCost?: number;
  newAnnualCost?: number;
}

export interface EconomicEffectResult { savingsPerUnit: number | null; annualSavings: number; formula: string }

/** Two mutually exclusive modes (the UI lets the user pick whichever data they actually
 *  have): compare unit costs (needs annual output to scale up to an annual figure), or
 *  compare total external/annual costs directly. Never mixes the two. */
export function calculateEconomicEffect(input: EconomicEffectInput): EconomicEffectResult {
  if (input.mode === 'unit_cost') {
    const currentUnitCost = assertValid(input.currentUnitCost ?? NaN, 'Текущая себестоимость единицы', { allowZero: true });
    const newUnitCost = assertValid(input.newUnitCost ?? NaN, 'Новая себестоимость единицы', { allowZero: true });
    const annualOutput = assertValid(input.annualOutput ?? NaN, 'Годовой выпуск продукции');
    const savingsPerUnit = currentUnitCost - newUnitCost;
    return { savingsPerUnit, annualSavings: savingsPerUnit * annualOutput, formula: `экономия/ед. = ${currentUnitCost.toFixed(2)} − ${newUnitCost.toFixed(2)}; годовая экономия = экономия/ед. × ${annualOutput.toFixed(2)}` };
  }
  const currentAnnualCost = assertValid(input.currentAnnualCost ?? NaN, 'Текущие внешние затраты в год', { allowZero: true });
  const newAnnualCost = assertValid(input.newAnnualCost ?? NaN, 'Затраты после внедрения в год', { allowZero: true });
  return { savingsPerUnit: null, annualSavings: currentAnnualCost - newAnnualCost, formula: `годовая экономия = ${currentAnnualCost.toFixed(2)} − ${newAnnualCost.toFixed(2)}` };
}

/** Simple (non-discounted) cumulative savings for each of `years` years - a running sum,
 *  never randomized or estimated. */
export function calculateCumulativeSavings(annualSavings: number, years: number): number[] {
  const n = Math.floor(assertValid(years, 'Число лет для накопленной экономии'));
  const result: number[] = [];
  for (let i = 1; i <= n; i++) result.push(annualSavings * i);
  return result;
}

// ---------- F. Payback ----------

export interface PaybackResult { years: number | null; months: number | null; message: string | null; formula: string }

/** simple payback = CAPEX / annual economic effect. If the annual effect is not positive,
 *  payback is undefined (never a negative or infinite number) - reported as an explicit,
 *  understandable message instead (item 7). */
export function calculatePayback(capex: number, annualEffect: number): PaybackResult {
  assertValid(capex, 'CAPEX', { allowZero: true });
  if (annualEffect <= 0) {
    return { years: null, months: null, message: 'Окупаемость не определена: годовой экономический эффект не положителен.', formula: 'payback = CAPEX / годовой эффект (не определено при эффекте ≤ 0)' };
  }
  const years = capex / annualEffect;
  return { years, months: years * 12, message: null, formula: `payback = CAPEX / годовой эффект = ${capex.toFixed(2)} / ${annualEffect.toFixed(2)}` };
}

// ---------- G. ROI ----------

export interface RoiResult { percent: number; formula: string }

/** ROI % = (annual benefit − annual operating cost) / CAPEX × 100 - exactly the formula
 *  requested for this module. This is a simplified, transparent convention chosen for
 *  engineering comparison, NOT a substitute for a formal accounting/investment ROI - see the
 *  UI's disclaimer and "как рассчитано" block, which states this explicitly. */
export function calculateRoi(annualBenefit: number, annualOperatingCost: number, capex: number): RoiResult {
  assertValid(annualOperatingCost, 'Годовые эксплуатационные затраты', { allowZero: true });
  const capexValue = assertValid(capex, 'CAPEX');
  const percent = ((annualBenefit - annualOperatingCost) / capexValue) * 100;
  return { percent, formula: `ROI % = (годовой эффект − годовые OPEX) / CAPEX × 100 = (${annualBenefit.toFixed(2)} − ${annualOperatingCost.toFixed(2)}) / ${capexValue.toFixed(2)} × 100` };
}

// ---------- H. Break-even ----------

export interface BreakEvenInput { sellingPricePerUnit: number; variableCostPerUnit: number; fixedCosts: number }
export interface BreakEvenResult { volumeUnits: number | null; message: string | null; formula: string }

/** break-even volume = fixed costs / (selling price − variable cost per unit). Undefined
 *  (never negative/infinite) when the contribution margin is not positive - reported as an
 *  explicit message instead. */
export function calculateBreakEven(input: BreakEvenInput): BreakEvenResult {
  const price = assertValid(input.sellingPricePerUnit, 'Цена продажи единицы');
  const variableCost = assertValid(input.variableCostPerUnit, 'Переменная себестоимость единицы', { allowZero: true });
  const fixedCosts = assertValid(input.fixedCosts, 'Фиксированные затраты', { allowZero: true });
  const contributionMargin = price - variableCost;
  if (contributionMargin <= 0) {
    return { volumeUnits: null, message: 'Точка безубыточности не определена: цена продажи не превышает переменную себестоимость.', formula: 'break-even = фикс. затраты / (цена − переменные затраты) (не определено при марже ≤ 0)' };
  }
  return { volumeUnits: fixedCosts / contributionMargin, message: null, formula: `break-even = ${fixedCosts.toFixed(2)} / (${price.toFixed(2)} − ${variableCost.toFixed(2)})` };
}

// ---------- full pipeline: one assessment (used directly, per-scenario, and per A/B variant) ----------

export interface AssessmentInput {
  capex: CapexInput;
  opex: OpexInput;
  capacity: ProductionCapacityInput;
  depreciationYears?: number;
  economicEffect: EconomicEffectInput;
  breakEven?: BreakEvenInput;
}

export interface AssessmentResult {
  capex: CapexResult;
  opex: OpexResult;
  capacity: ProductionCapacityResult;
  unitCost: UnitCostResult;
  economicEffect: EconomicEffectResult;
  payback: PaybackResult;
  roi: RoiResult;
  breakEven: BreakEvenResult | null;
}

/** Runs the whole A-G pipeline once for one consistent set of inputs. Scenario analysis and
 *  the A/B comparison both just call this multiple times with different (user-entered, never
 *  randomized) inputs - there is only ever ONE calculation engine. */
export function runAssessment(input: AssessmentInput): AssessmentResult {
  const capex = calculateCapex(input.capex);
  const opex = calculateOpex(input.opex);
  const capacity = calculateProductionCapacity(input.capacity);
  const unitCost = calculateUnitCost(opex.annualTotal, capacity.unitsPerYear, capex.total, input.depreciationYears);
  const economicEffect = calculateEconomicEffect(
    input.economicEffect.mode === 'unit_cost' && input.economicEffect.annualOutput === undefined
      ? { ...input.economicEffect, annualOutput: capacity.unitsPerYear }
      : input.economicEffect,
  );
  const payback = calculatePayback(capex.total, economicEffect.annualSavings);
  const roi = calculateRoi(economicEffect.annualSavings, opex.annualTotal, capex.total);
  const breakEven = input.breakEven ? calculateBreakEven(input.breakEven) : null;
  return { capex, opex, capacity, unitCost, economicEffect, payback, roi, breakEven };
}
