/** Untrusted-JSON reader for the Techno-Economic report request (the body of the export route). Every field is read by NAME with its type and size
 *  checked; nothing is spread from the input, so a hostile payload cannot smuggle properties or exhaust memory. Whether the numbers are
 *  acceptable to the calculation (negative cost, 25-hour day, ...) is decided by the one engine itself (runAssessment, called when the report is built). */

import type { AssessmentInput, CapexInput, OpexInput, ProductionCapacityInput, EconomicEffectInput, BreakEvenInput, Currency } from './techno-economic-assessment';
import type { TechnoEconomicHandoff } from './equipment-selector';
import { SCENARIO_KEYS, ReportInputError, type TeaReportRequest, type ReportVariant, type ScenarioKey } from './techno-economic-report';

const CURRENCIES: readonly Currency[] = ['RUB', 'USD', 'EUR'];
const MAX_TEXT = 500;
const MAX_LIST = 30;

function obj(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ReportInputError(`${label}: ожидается объект.`);
  return value as Record<string, unknown>;
}
function optNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReportInputError(`${label}: ожидается конечное число.`);
  return value;
}
function reqNumber(value: unknown, label: string): number {
  const n = optNumber(value, label);
  if (n === undefined) throw new ReportInputError(`${label}: обязательное число.`);
  return n;
}
function optText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ReportInputError(`${label}: ожидается текст.`);
  if (value.length > MAX_TEXT) throw new ReportInputError(`${label}: текст слишком длинный (максимум ${MAX_TEXT} символов).`);
  return value;
}
function reqText(value: unknown, label: string): string {
  const t = optText(value, label);
  if (t === undefined) throw new ReportInputError(`${label}: обязательное текстовое поле.`);
  return t;
}
function textList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new ReportInputError(`${label}: ожидается список (не более ${MAX_LIST}).`);
  return value.map((v, i) => reqText(v, `${label}[${i}]`));
}

const CAPEX_KEYS = ['delivery', 'customsLogistics', 'installation', 'commissioning', 'training', 'infrastructure', 'tooling', 'otherOneTime'] as const;
const OPEX_KEYS = ['electricity', 'processGases', 'consumables', 'targetsCathodes', 'reagents', 'maintenance', 'repairs', 'labor', 'facilities', 'disposal', 'otherOperating'] as const;
const CAPACITY_KEYS = ['shiftsPerDay', 'hoursPerShift', 'workingDaysPerYear', 'utilizationPercent', 'cycleTimeMinutes', 'unitsPerCycle'] as const;

export function parseAssessmentInput(raw: unknown, label: string): AssessmentInput {
  const o = obj(raw, label);
  const capexRaw = obj(o.capex, `${label}: CAPEX`);
  const capex: CapexInput = { equipment: reqNumber(capexRaw.equipment, `${label}: стоимость оборудования`) };
  for (const key of CAPEX_KEYS) { const v = optNumber(capexRaw[key], `${label}: CAPEX ${key}`); if (v !== undefined) capex[key] = v; }
  const opexRaw = obj(o.opex, `${label}: OPEX`);
  if (opexRaw.period !== 'month' && opexRaw.period !== 'year') throw new ReportInputError(`${label}: период OPEX — «month» или «year».`);
  const opex: OpexInput = { period: opexRaw.period };
  for (const key of OPEX_KEYS) { const v = optNumber(opexRaw[key], `${label}: OPEX ${key}`); if (v !== undefined) opex[key] = v; }
  const capRaw = obj(o.capacity, `${label}: производительность`);
  const capacity = Object.fromEntries(CAPACITY_KEYS.map(key => [key, reqNumber(capRaw[key], `${label}: ${key}`)])) as unknown as ProductionCapacityInput;
  const effRaw = obj(o.economicEffect, `${label}: экономический эффект`);
  if (effRaw.mode !== 'unit_cost' && effRaw.mode !== 'total_external_cost') throw new ReportInputError(`${label}: способ расчёта эффекта указан неверно.`);
  const economicEffect: EconomicEffectInput = { mode: effRaw.mode };
  for (const key of ['currentUnitCost', 'newUnitCost', 'annualOutput', 'currentAnnualCost', 'newAnnualCost'] as const) { const v = optNumber(effRaw[key], `${label}: ${key}`); if (v !== undefined) economicEffect[key] = v; }
  const input: AssessmentInput = { capex, opex, capacity, economicEffect };
  const depreciationYears = optNumber(o.depreciationYears, `${label}: срок амортизации`);
  if (depreciationYears !== undefined) input.depreciationYears = depreciationYears;
  if (o.breakEven !== undefined && o.breakEven !== null) {
    const b = obj(o.breakEven, `${label}: безубыточность`);
    input.breakEven = { sellingPricePerUnit: reqNumber(b.sellingPricePerUnit, 'цена'), variableCostPerUnit: reqNumber(b.variableCostPerUnit, 'переменные затраты'), fixedCosts: reqNumber(b.fixedCosts, 'фиксированные затраты') } satisfies BreakEvenInput;
  }
  return input;
}

function parseVariant(raw: unknown, label: string): ReportVariant {
  const o = obj(raw, label);
  const title = optText(o.title, `${label}: название`);
  return { ...(title !== undefined ? { title } : {}), input: parseAssessmentInput(o.input, label) };
}

function parseHandoff(raw: unknown): TechnoEconomicHandoff {
  const o = obj(raw, 'Конфигурация Equipment Selector');
  return {
    configurationId: reqText(o.configurationId, 'id конфигурации'),
    configurationName: reqText(o.configurationName, 'название конфигурации'),
    supportedPurposes: textList(o.supportedPurposes, 'процессы'),
    supportedTechnologies: textList(o.supportedTechnologies, 'технологии'),
    maxChamberSizeMm: reqNumber(o.maxChamberSizeMm, 'размер камеры'),
    maxProcessTempC: reqNumber(o.maxProcessTempC, 'температура'),
    sourcesSummary: reqText(o.sourcesSummary, 'источники'),
    maxGasLines: reqNumber(o.maxGasLines, 'газовые линии'),
    throughputClasses: textList(o.throughputClasses, 'производительность'),
    automationLevels: textList(o.automationLevels, 'автоматизация'),
    cleanroomSupport: textList(o.cleanroomSupport, 'cleanroom'),
    note: reqText(o.note, 'примечание'),
  };
}

export function parseTeaReportRequest(raw: unknown): TeaReportRequest {
  const o = obj(raw, 'запрос');
  if (typeof o.currency !== 'string' || !(CURRENCIES as readonly string[]).includes(o.currency)) throw new ReportInputError('Валюта: допустимо RUB, USD или EUR.');
  const request: TeaReportRequest = { currency: o.currency as Currency, variantA: parseVariant(o.variantA, 'Вариант A') };
  if (o.variantB !== undefined && o.variantB !== null) request.variantB = parseVariant(o.variantB, 'Вариант B');
  if (o.scenarios !== undefined && o.scenarios !== null) {
    const s = obj(o.scenarios, 'сценарии');
    request.scenarios = Object.fromEntries(SCENARIO_KEYS.map(key => [key, parseVariant(s[key], `Сценарий ${key}`)])) as Record<ScenarioKey, ReportVariant>;
  }
  if (o.handoff !== undefined && o.handoff !== null) request.handoff = parseHandoff(o.handoff);
  return request;
}
