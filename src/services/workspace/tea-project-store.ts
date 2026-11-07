/** The editable project of Techno-Economic Assessment (P1-02): what the user typed and chose, saved in this browser so that it survives navigating away, a refresh and
 *  reopening the site. Only INPUTS and settings are stored. Results are derived: the last calculation is stored as its inputs (the report request) and is calculated again
 *  by the one engine (`runAssessment`) when the project is restored - no result, formula text or total is ever stored, so a restored project can never show a number the engine
 *  would not produce from its inputs. No formula, parameter or calculation lives here.
 *
 *  The schema of a stored project is STRICT: an unknown or missing field anywhere (the project, a form and its CAPEX / OPEX / capacity groups, the scenarios, the hand-over
 *  card, the stored calculation) makes the whole project unreadable, so nothing is silently dropped on loading; an unreadable project is put aside, not overwritten. The same
 *  rules are applied before writing (see `local-project-persistence.ts`), so a project is never written that the loader would reject.
 *
 *  The storage rules are those of `local-project-persistence.ts`. The key is TEA's own and differs from Scientific Writer's and from the Equipment Selector hand-over. */

import { runAssessment, type AssessmentInput, type AssessmentResult, type Currency, type EconomicEffectMode, type OpexPeriod } from './techno-economic-assessment';
import type { EquipmentTeaHandoffRecord } from './equipment-tea-handoff';
import { parseHandoff, parseTeaReportRequest } from './techno-economic-report-parse';
import { SCENARIO_KEYS, type ReportVariant, type ScenarioKey, type TeaReportRequest } from './techno-economic-report';
import { sameData, type ProjectConfig } from './local-project-persistence';

export const TEA_PROJECT_KEY = 'plasmatech.tea.project.v1';
export const TEA_PROJECT_VERSION = 1;

/** The raw (string) form of one variant or scenario: converted to numbers only when a calculation runs. */
export interface TeaFormState {
  title: string;
  capex: Record<'equipment' | 'delivery' | 'customsLogistics' | 'installation' | 'commissioning' | 'training' | 'infrastructure' | 'tooling' | 'otherOneTime', string>;
  opexPeriod: OpexPeriod;
  opex: Record<'electricity' | 'processGases' | 'consumables' | 'targetsCathodes' | 'reagents' | 'maintenance' | 'repairs' | 'labor' | 'facilities' | 'disposal' | 'otherOperating', string>;
  capacity: Record<'shiftsPerDay' | 'hoursPerShift' | 'workingDaysPerYear' | 'utilizationPercent' | 'cycleTimeMinutes' | 'unitsPerCycle', string>;
  depreciationYears: string;
  effectMode: EconomicEffectMode;
  currentUnitCost: string; newUnitCost: string;
  currentAnnualCost: string; newAnnualCost: string;
}

export function defaultTeaForm(): TeaFormState {
  return {
    title: '',
    capex: { equipment: '', delivery: '', customsLogistics: '', installation: '', commissioning: '', training: '', infrastructure: '', tooling: '', otherOneTime: '' },
    opexPeriod: 'year',
    opex: { electricity: '', processGases: '', consumables: '', targetsCathodes: '', reagents: '', maintenance: '', repairs: '', labor: '', facilities: '', disposal: '', otherOperating: '' },
    capacity: { shiftsPerDay: '2', hoursPerShift: '8', workingDaysPerYear: '250', utilizationPercent: '80', cycleTimeMinutes: '20', unitsPerCycle: '1' },
    depreciationYears: '',
    effectMode: 'total_external_cost',
    currentUnitCost: '', newUnitCost: '',
    currentAnnualCost: '', newAnnualCost: '',
  };
}

export function defaultTeaScenarioForms(): Record<ScenarioKey, TeaFormState> {
  return { base: defaultTeaForm(), conservative: defaultTeaForm(), optimistic: defaultTeaForm() };
}

/** Everything that is saved. */
export interface TeaProjectContent {
  formA: TeaFormState;
  formB: TeaFormState;
  compareB: boolean;
  currency: Currency;
  scenariosEnabled: boolean;
  scenarioForms: Record<ScenarioKey, TeaFormState>;
  /** The configuration card from Equipment Selector that is shown (kept here so that the card survives; the queue entry is removed only after this is safely saved). */
  handoff: EquipmentTeaHandoffRecord | null;
  /** The INPUTS of the last calculation that is shown; its results are calculated again on restore. */
  calculation: TeaReportRequest | null;
  /** The FORM (as typed) that the shown calculation was made from; the shown results are "outdated" when the current form differs from it. */
  calculatedFrom: CalculatedFrom | null;
}

export type CalculatedFrom = Pick<TeaProjectContent, 'formA' | 'formB' | 'compareB' | 'currency' | 'scenariosEnabled' | 'scenarioForms' | 'handoff'>;

export function defaultTeaProject(): TeaProjectContent {
  return { formA: defaultTeaForm(), formB: defaultTeaForm(), compareB: false, currency: 'RUB', scenariosEnabled: false, scenarioForms: defaultTeaScenarioForms(), handoff: null, calculation: null, calculatedFrom: null };
}

// ---------- the form -> the inputs of a calculation (pure conversion; the formulas live in techno-economic-assessment.ts) ----------

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export function teaFormToInput(form: TeaFormState): AssessmentInput {
  return {
    capex: {
      equipment: Number(form.capex.equipment),
      delivery: num(form.capex.delivery), customsLogistics: num(form.capex.customsLogistics), installation: num(form.capex.installation),
      commissioning: num(form.capex.commissioning), training: num(form.capex.training), infrastructure: num(form.capex.infrastructure),
      tooling: num(form.capex.tooling), otherOneTime: num(form.capex.otherOneTime),
    },
    opex: {
      period: form.opexPeriod,
      electricity: num(form.opex.electricity), processGases: num(form.opex.processGases), consumables: num(form.opex.consumables),
      targetsCathodes: num(form.opex.targetsCathodes), reagents: num(form.opex.reagents), maintenance: num(form.opex.maintenance),
      repairs: num(form.opex.repairs), labor: num(form.opex.labor), facilities: num(form.opex.facilities),
      disposal: num(form.opex.disposal), otherOperating: num(form.opex.otherOperating),
    },
    capacity: {
      shiftsPerDay: Number(form.capacity.shiftsPerDay), hoursPerShift: Number(form.capacity.hoursPerShift),
      workingDaysPerYear: Number(form.capacity.workingDaysPerYear), utilizationPercent: Number(form.capacity.utilizationPercent),
      cycleTimeMinutes: Number(form.capacity.cycleTimeMinutes), unitsPerCycle: Number(form.capacity.unitsPerCycle),
    },
    depreciationYears: num(form.depreciationYears),
    economicEffect: form.effectMode === 'unit_cost'
      ? { mode: 'unit_cost', currentUnitCost: num(form.currentUnitCost), newUnitCost: num(form.newUnitCost) }
      : { mode: 'total_external_cost', currentAnnualCost: num(form.currentAnnualCost), newAnnualCost: num(form.newAnnualCost) },
  };
}

const variantOf = (form: TeaFormState): ReportVariant => ({ ...(form.title.trim() !== '' ? { title: form.title } : {}), input: teaFormToInput(form) });

/** The calculation request that a form gives: the same recipe as "Рассчитать" in the component (the title only when it is not blank; variant B when the comparison is on; the
 *  scenarios when they are on; the currency; the configuration). Used to check that a stored calculation really is the calculation of the stored `calculatedFrom`. */
export function calculationRequestFrom(source: CalculatedFrom): TeaReportRequest {
  const request: TeaReportRequest = { currency: source.currency, variantA: variantOf(source.formA), ...(source.handoff ? { handoff: source.handoff.handoff } : {}) };
  if (source.compareB) request.variantB = variantOf(source.formB);
  if (source.scenariosEnabled) request.scenarios = Object.fromEntries(SCENARIO_KEYS.map(key => [key, variantOf(source.scenarioForms[key])])) as Record<ScenarioKey, ReportVariant>;
  return request;
}

/** Where the stored calculation differs from the calculation of the stored form (`null` if they agree). Only `calculatedFrom` is used - never the current form, which may
 *  have been edited after the calculation. */
export function describeCalculationMismatch(calculation: TeaReportRequest, from: CalculatedFrom): string | null {
  const roundTrip = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v));
  const expected = roundTrip(calculationRequestFrom(from)); const actual = roundTrip(calculation);
  const parts: [string, string][] = [['currency', 'валюта'], ['variantA', 'вариант A'], ['variantB', 'вариант B'], ['scenarios', 'сценарии'], ['handoff', 'конфигурация Equipment Selector']];
  const differing = parts.filter(([key]) => !sameData(expected[key], actual[key])).map(([, name]) => name);
  return differing.length > 0 ? differing.join(', ') : sameData(expected, actual) ? null : 'прочие поля расчётного запроса';
}

const sourceOf = (p: TeaProjectContent): CalculatedFrom => ({ formA: p.formA, formB: p.formB, compareB: p.compareB, currency: p.currency, scenariosEnabled: p.scenariosEnabled, scenarioForms: p.scenarioForms, handoff: p.handoff });

/** True when the shown results were calculated from another form than the current one (a field, the currency, a switch or the configuration changed after the calculation).
 *  The comparison is between the typed forms - no number is converted or calculated, and nothing is recalculated here. */
export function isCalculationStale(project: TeaProjectContent): boolean {
  if (project.calculation === null) return false;
  return project.calculatedFrom === null || !sameData(sourceOf(project), project.calculatedFrom);
}

/** What the shown results are labelled with: the currency and the titles of the CALCULATION, never those of the form that may have changed since. */
export function shownResultContext(project: TeaProjectContent): { currency: Currency; titleA: string; titleB: string; scenarioTitles: Record<ScenarioKey, string> } | null {
  const c = project.calculation;
  if (!c) return null;
  return {
    currency: c.currency, titleA: c.variantA.title ?? '', titleB: c.variantB?.title ?? '',
    scenarioTitles: Object.fromEntries(SCENARIO_KEYS.map(key => [key, c.scenarios?.[key].title ?? ''])) as Record<ScenarioKey, string>,
  };
}

// ---------- validation of a stored project (strict, whole-or-nothing, canonical key order) ----------

const MAX_NUMBER_TEXT = 400;
const MAX_TITLE = 200;
const CURRENCIES: readonly Currency[] = ['RUB', 'USD', 'EUR'];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

class Problem extends Error {}
const fail = (message: string): never => { throw new Problem(message); };

function exactObject(raw: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isObject(raw)) return fail(`${path}: ожидался объект.`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) fail(`${path}: неизвестное поле «${key}» (проект не изменяется молча, поэтому он не принимается).`);
  for (const key of keys) if (!(key in raw)) fail(`${path}: нет поля «${key}».`);
  return raw;
}
function text(raw: unknown, max: number, path: string): string {
  if (typeof raw !== 'string') return fail(`${path}: ожидалась строка.`);
  if (raw.length > max) return fail(`${path}: слишком длинное значение (${raw.length} символов, допустимо не более ${max}); оно не усекается — сократите его.`);
  return raw;
}
function group<K extends string>(raw: unknown, keys: readonly K[], path: string): Record<K, string> {
  const o = exactObject(raw, keys, path);
  const out = {} as Record<K, string>;
  for (const key of keys) out[key] = text(o[key], MAX_NUMBER_TEXT, `${path}.${key}`);
  return out;
}

const FORM_KEYS = ['title', 'capex', 'opexPeriod', 'opex', 'capacity', 'depreciationYears', 'effectMode', 'currentUnitCost', 'newUnitCost', 'currentAnnualCost', 'newAnnualCost'] as const;

function checkForm(raw: unknown, path: string): TeaFormState {
  const o = exactObject(raw, FORM_KEYS, path);
  const d = defaultTeaForm();
  const title = text(o.title, MAX_TITLE, `${path}.title`);
  const capex = group(o.capex, Object.keys(d.capex) as (keyof TeaFormState['capex'])[], `${path}.capex`);
  const opex = group(o.opex, Object.keys(d.opex) as (keyof TeaFormState['opex'])[], `${path}.opex`);
  const capacity = group(o.capacity, Object.keys(d.capacity) as (keyof TeaFormState['capacity'])[], `${path}.capacity`);
  if (o.opexPeriod !== 'year' && o.opexPeriod !== 'month') fail(`${path}.opexPeriod: «year» или «month».`);
  if (o.effectMode !== 'total_external_cost' && o.effectMode !== 'unit_cost') fail(`${path}.effectMode: «total_external_cost» или «unit_cost».`);
  return {
    title, capex, opexPeriod: o.opexPeriod as OpexPeriod, opex, capacity, depreciationYears: text(o.depreciationYears, MAX_NUMBER_TEXT, `${path}.depreciationYears`), effectMode: o.effectMode as EconomicEffectMode,
    currentUnitCost: text(o.currentUnitCost, MAX_NUMBER_TEXT, `${path}.currentUnitCost`), newUnitCost: text(o.newUnitCost, MAX_NUMBER_TEXT, `${path}.newUnitCost`),
    currentAnnualCost: text(o.currentAnnualCost, MAX_NUMBER_TEXT, `${path}.currentAnnualCost`), newAnnualCost: text(o.newAnnualCost, MAX_NUMBER_TEXT, `${path}.newAnnualCost`),
  };
}

function checkHandoff(raw: unknown): EquipmentTeaHandoffRecord {
  const o = exactObject(raw, ['handoff', 'importedAt'], 'handoff');
  const importedAt = text(o.importedAt, 64, 'handoff.importedAt');
  let parsed: ReturnType<typeof parseHandoff>;
  try { parsed = parseHandoff(o.handoff); } catch (e) { return fail(`handoff: ${e instanceof Error ? e.message : 'конфигурация Equipment Selector некорректна'}`); }
  if (!sameData(parsed, o.handoff)) fail('handoff: в конфигурации Equipment Selector есть неизвестные или изменяемые при чтении поля.');
  return { handoff: parsed, importedAt };
}

function checkCalculation(raw: unknown): TeaReportRequest {
  let parsed: TeaReportRequest;
  try { parsed = parseTeaReportRequest(raw); } catch (e) { return fail(`calculation: ${e instanceof Error ? e.message : 'расчёт некорректен'}`); }
  if (!sameData(parsed, raw)) fail('calculation: в сохранённом расчёте есть неизвестные поля или значения, которые изменились бы при чтении.');
  return parsed;
}

const PROJECT_KEYS = ['formA', 'formB', 'compareB', 'currency', 'scenariosEnabled', 'scenarioForms', 'handoff', 'calculation', 'calculatedFrom'] as const;
const SOURCE_KEYS = ['formA', 'formB', 'compareB', 'currency', 'scenariosEnabled', 'scenarioForms', 'handoff'] as const;

function checkSource(raw: unknown, path: string): CalculatedFrom {
  const o = exactObject(raw, SOURCE_KEYS, path);
  const formA = checkForm(o.formA, `${path}.formA`); const formB = checkForm(o.formB, `${path}.formB`);
  if (typeof o.compareB !== 'boolean') fail(`${path}.compareB: ожидалось true или false.`);
  if (typeof o.scenariosEnabled !== 'boolean') fail(`${path}.scenariosEnabled: ожидалось true или false.`);
  if (typeof o.currency !== 'string' || !(CURRENCIES as readonly string[]).includes(o.currency)) fail(`${path}.currency: RUB, USD или EUR.`);
  const sf = exactObject(o.scenarioForms, SCENARIO_KEYS, `${path}.scenarioForms`);
  const scenarioForms = {} as Record<ScenarioKey, TeaFormState>;
  for (const key of SCENARIO_KEYS) scenarioForms[key] = checkForm(sf[key], `${path}.scenarioForms.${key}`);
  return { formA, formB, compareB: o.compareB as boolean, currency: o.currency as Currency, scenariosEnabled: o.scenariosEnabled as boolean, scenarioForms, handoff: o.handoff === null ? null : checkHandoff(o.handoff) };
}

/** The stored content as a whole; throws a `Problem` (a message for the user) if any part is not valid. */
function checkTeaProject(raw: unknown): TeaProjectContent {
  const o = exactObject(raw, PROJECT_KEYS, 'проект');
  const source = checkSource(Object.fromEntries(SOURCE_KEYS.map(k => [k, o[k]])), 'проект');
  const calculation = o.calculation === null ? null : checkCalculation(o.calculation);
  const calculatedFrom = o.calculatedFrom === null ? null : checkSource(o.calculatedFrom, 'calculatedFrom');
  // the stored calculation and the form it was made from are ONE statement: they must agree (the current form is not compared - it may be edited after the calculation)
  if ((calculation === null) !== (calculatedFrom === null)) fail('calculation и calculatedFrom должны быть заданы вместе: расчёт без формы, из которой он сделан (или наоборот), не принимается.');
  if (calculation && calculatedFrom) {
    const mismatch = describeCalculationMismatch(calculation, calculatedFrom);
    if (mismatch !== null) fail(`calculation не соответствует calculatedFrom (${mismatch}): сохранённый расчёт не получен из сохранённой формы, он не исправляется автоматически и не принимается.`);
  }
  return { ...source, calculation, calculatedFrom };
}

export function parseTeaProject(raw: unknown): TeaProjectContent | null {
  try { return checkTeaProject(raw); } catch { return null; }
}

/** The first problem of a project that cannot be saved or loaded, in words; `null` if the project is valid. */
export function explainTeaProject(raw: unknown): string | null {
  try { checkTeaProject(raw); return null; } catch (e) { return e instanceof Problem ? e.message : 'проект не проходит проверку'; }
}

export const TEA_PROJECT_CONFIG: ProjectConfig<TeaProjectContent> = {
  key: TEA_PROJECT_KEY, version: TEA_PROJECT_VERSION, defaultContent: defaultTeaProject, parse: parseTeaProject, explain: explainTeaProject,
};

// ---------- results are derived ----------

export interface RecomputedResults {
  resultA: AssessmentResult;
  resultB: AssessmentResult | null;
  scenarioResults: Record<ScenarioKey, AssessmentResult | null>;
}

/** Calculates the shown results again, with the one engine, from the stored inputs of the last calculation. `null` if the engine refuses them (they are then not shown;
 *  the stored form is kept). */
export function recomputeResults(calculation: TeaReportRequest): RecomputedResults | null {
  try {
    const scenarioResults: Record<ScenarioKey, AssessmentResult | null> = { base: null, conservative: null, optimistic: null };
    if (calculation.scenarios) for (const key of SCENARIO_KEYS) scenarioResults[key] = runAssessment(calculation.scenarios[key].input);
    return { resultA: runAssessment(calculation.variantA.input), resultB: calculation.variantB ? runAssessment(calculation.variantB.input) : null, scenarioResults };
  } catch { return null; }
}

// ---------- the Equipment Selector hand-over: applied first, removed from the queue only after the project containing it is safely written ----------

export type HandoffPlan = 'none' | 'already_saved' | 'apply';

/** What to do with the pending hand-over after the stored project was read: nothing if there is none; `already_saved` if the stored project already contains this very
 *  hand-over (it was written earlier but the queue entry could not be removed - it must not be applied again, only removed); otherwise `apply`. */
export function planHandoffDelivery(restoredHandoff: EquipmentTeaHandoffRecord | null, pending: EquipmentTeaHandoffRecord | null): HandoffPlan {
  if (!pending) return 'none';
  return restoredHandoff && restoredHandoff.importedAt === pending.importedAt && restoredHandoff.handoff.configurationId === pending.handoff.configurationId ? 'already_saved' : 'apply';
}

/** Called after a write succeeded with `saved` as its content. The pending hand-over is acknowledged (removed from the queue) only if THAT written project contains it.
 *  Returns what is still waiting: `null` once the queue no longer holds it, otherwise the same record (a failed removal is retried by the next successful write). */
export function confirmHandoffDelivery(pending: EquipmentTeaHandoffRecord | null, saved: Pick<TeaProjectContent, 'handoff'>, acknowledge: (record: EquipmentTeaHandoffRecord) => boolean): EquipmentTeaHandoffRecord | null {
  if (!pending) return null;
  if (planHandoffDelivery(saved.handoff, pending) !== 'already_saved') return pending;
  return acknowledge(pending) ? null : pending;
}

/** The project after a hand-over is applied: only the configuration card and the DESCRIPTIVE title of variant A change. No financial field, variant B, scenario, currency or
 *  switch is touched. */
export function applyHandoffToProject(project: TeaProjectContent, record: EquipmentTeaHandoffRecord): TeaProjectContent {
  return { ...project, handoff: record, formA: { ...project.formA, title: record.handoff.configurationName } };
}
