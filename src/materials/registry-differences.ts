/** Descriptive comparison of two records of the same variant and property. There is NO statistical verdict here: no coverage factor, no combination of uncertainties (their
 *  correlation is unknown, so independence is never assumed), no overlap-of-intervals rule. Different values are not necessarily a scientific contradiction - they are
 *  described, and where conditions differ or are not fully stated they are explicitly NOT treated as comparable. Free text (measurement method, context) cannot be compared
 *  by machine: a difference in it asks for an expert (`review_required`), and it is never ignored. */

import { exact, getUnit, toSiRational } from '@/physics';
import { getPropertyDefinition } from './property-definitions';
import { validatePropertyRecord } from './property-record';
import type { DifferenceCategory, RecordDifference } from './registry-types';
import type { PropertyRecord, PropertyUncertainty } from './property-types';

/** Conditions with a machine-comparable value. */
const STRUCTURED_KEYS = ['temperature', 'temperatureRange', 'pressure', 'atmosphere', 'direction', 'referenceTemperature', 'expansionDefinition', 'heatCapacityMode', 'materialState', 'thickness'] as const;
/** Conditions that are free text: equal text is equal, anything else needs a person. */
const FREE_TEXT_KEYS = ['measurementMethod', 'context'] as const;

const isQuantity = (x: unknown): x is { value: number; unit: string } => typeof x === 'object' && x !== null && typeof (x as { value?: unknown }).value === 'number' && typeof (x as { unit?: unknown }).unit === 'string';
const same = (a: { value: number; unit: string }, b: { value: number; unit: string }): boolean => exact.equals(toSiRational(a.value, a.unit as never), toSiRational(b.value, b.unit as never));

function structuredEqual(a: unknown, b: unknown): boolean {
  if (isQuantity(a) && isQuantity(b)) return same(a, b);
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const x = a as { min?: unknown; max?: unknown };
    const y = b as { min?: unknown; max?: unknown };
    return isQuantity(x.min) && isQuantity(y.min) && isQuantity(x.max) && isQuantity(y.max) && same(x.min, y.min) && same(x.max, y.max);
  }
  return a === b;
}

const normalizedText = (s: unknown): string => String(s).trim().replace(/\s+/g, ' ');

function uncertaintiesEqual(a: PropertyUncertainty, b: PropertyUncertainty, unitA: string, unitB: string): boolean {
  if (a.kind !== b.kind) return false;
  const si = (n: number, unit: string) => toSiRational(n, unit as never);
  switch (a.kind) {
    case 'unknown': return true;
    case 'standard': return b.kind === 'standard' && a.origin === b.origin && exact.equals(si(a.u, unitA), si(b.u, unitB));
    case 'expanded': return b.kind === 'expanded' && a.origin === b.origin && exact.equals(si(a.U, unitA), si(b.U, unitB)) && a.k === b.k && a.kOrigin === b.kOrigin;
    case 'bounds': return b.kind === 'bounds' && a.origin === b.origin && exact.equals(si(a.lower, unitA), si(b.lower, unitB)) && exact.equals(si(a.upper, unitA), si(b.upper, unitB));
  }
}

/** The outcome of comparing two records: a description (`compared`), or a controlled refusal (`refused`) when the two records are not comparable AT ALL - they belong to
 *  different variants, to different properties, or one of them is not a well-formed record. Records of different variants or properties are never described as identical or
 *  different: a number in SI units does not make two different quantities equivalent. */
export type RecordComparison =
  | { readonly status: 'compared'; readonly category: DifferenceCategory; readonly reasons: readonly string[] }
  | { readonly status: 'refused'; readonly reason: 'different_variant' | 'different_property' | 'incompatible_units' | 'invalid_record'; readonly message: string };

const refuse = (reason: 'different_variant' | 'different_property' | 'incompatible_units' | 'invalid_record', message: string): RecordComparison => Object.freeze({ status: 'refused' as const, reason, message });

/** The M1.3.2 validator decides whether a record is well formed (no second implementation of the PropertyRecord rules): the value is a finite number of a unit of the
 *  property's kind, the uncertainty statement, the conditions, the provenance, the id and the version are valid, there are no unknown fields. No variant is given, so
 *  nothing is said about whether the conditions fit the FORM of the material (a film's thickness and direction): applicability to a variant is NOT declared confirmed.
 *  The try/catch is only a guard at the public boundary - the validation itself is what rejects bad data. */
function invalidReason(record: unknown, label: string): string | undefined {
  try {
    const report = validatePropertyRecord(record);
    if (report.ok) return undefined;
    const first = report.issues.find(i => i.severity === 'error');
    return `${label} запись некорректна${first ? `: ${first.path}: ${first.message}` : ''}`;
  } catch {
    return `${label} запись не удалось проверить`;
  }
}

/** Describes two records. The ORDER of the checks is fixed and each step is final (the order of the arguments does not matter):
 *   0. refusal: either record fails the M1.3.2 validation (checked FIRST, before any value is converted or compared, whatever the other record is) -> `invalid_record`;
 *      then different `variant`; different `property`; a unit that is not a unit of the property's kind (a defensive check: the validator already refuses such records);
 *   1. a stated structured condition differs                                -> `conditions_differ`
 *   2. a condition or `provenance.method` is stated by one record only      -> `insufficient_context`
 *   3. free text differs: `conditions.measurementMethod`, `conditions.context`, or `provenance.method` (compared after whitespace normalisation only; two different
 *      wordings are never taken for the same method)                       -> `review_required`
 *   4. (all the above equal) values and uncertainty statements equal         -> `identical`; values equal, uncertainty statements differ -> `review_required`;
 *      values differ                                                         -> `different_values`.
 *  A refusal is not the result of a scientific comparison. Whatever the category, the differences found by the stages that were carried out are listed in `reasons`, so
 *  that a higher-ranked category never hides a lower-ranked difference (a different `provenance.method` is never lost behind `identical`, nor behind `conditions_differ`);
 *  when the conditions are not comparable, the numeric values are deliberately not examined, and `reasons` does not promise an exhaustive list of numeric differences.
 *  `provenance.method` (how the value was obtained) is a characteristic of its own and is not mixed with `conditions.measurementMethod` (how it was measured under the
 *  stated conditions). There is no statistical verdict anywhere. */
export function compareRecords(a: PropertyRecord, b: PropertyRecord): RecordComparison {
  const bad = invalidReason(a, 'Первая') ?? invalidReason(b, 'Вторая');
  if (bad) return refuse('invalid_record', bad);
  return compareValidated(a, b);
}

/** The comparison itself, for records that have ALREADY passed the validation (the registry's records, or the pair checked by compareRecords). */
function compareValidated(a: PropertyRecord, b: PropertyRecord): RecordComparison {
  if (a.variant !== b.variant) return refuse('different_variant', `записи относятся к разным вариантам материала («${a.variant}» и «${b.variant}») — не сравниваются`);
  if (a.property !== b.property) return refuse('different_property', `записи относятся к разным свойствам («${a.property}» и «${b.property}») — не сравниваются, даже если числа совпадают`);
  const definition = getPropertyDefinition(a.property);
  let kindA: string; let kindB: string;
  try { kindA = getUnit(a.value.unit).kind; kindB = getUnit(b.value.unit).kind; } catch { return refuse('invalid_record', 'неизвестная единица измерения значения — сравнение невозможно'); }   // defensive: validated records have known units
  if (kindA !== kindB || (definition && definition.kind !== kindA)) return refuse('incompatible_units', 'единицы значений не относятся к роду свойства или к одному роду — значения не сравниваются');

  const ca = a.conditions as unknown as Record<string, unknown>;
  const cb = b.conditions as unknown as Record<string, unknown>;
  const differing: string[] = [];
  const oneSided: string[] = [];
  const textDiffering: string[] = [];
  for (const key of STRUCTURED_KEYS) {
    const x = ca[key];
    const y = cb[key];
    if (x === undefined && y === undefined) continue;
    if (x === undefined || y === undefined) { oneSided.push(key); continue; }
    if (!structuredEqual(x, y)) differing.push(key);
  }
  const text = (name: string, x: unknown, y: unknown): void => {
    if (x === undefined && y === undefined) return;
    if (x === undefined || y === undefined) { oneSided.push(name); return; }
    if (normalizedText(x) !== normalizedText(y)) textDiffering.push(name);
  };
  for (const key of FREE_TEXT_KEYS) text(key, ca[key], cb[key]);
  text('provenance.method', a.provenance.method, b.provenance.method);

  // every difference found is listed, whatever the category: a higher-ranked category must not hide a lower-ranked difference
  const findings: string[] = [];
  if (differing.length > 0) findings.push(`заявленные условия различаются: ${differing.join(', ')}`);
  if (oneSided.length > 0) findings.push(`условие или метод получения заявлены только одной из записей: ${oneSided.join(', ')}`);
  if (textDiffering.length > 0) findings.push(`различается текст (${textDiffering.join(', ')}) — машинное сравнение невозможно`);
  if (differing.length > 0) return { status: 'compared', category: 'conditions_differ', reasons: [...findings, 'значения не сравниваются: они отвечают на разные вопросы'] };
  if (oneSided.length > 0) return { status: 'compared', category: 'insufficient_context', reasons: [...findings, 'сопоставимость оценить нельзя'] };
  if (textDiffering.length > 0) return { status: 'compared', category: 'review_required', reasons: [...findings, 'необходима экспертная оценка; значения и неопределённости не оцениваются'] };
  // all stated conditions and methods are equal
  const valuesEqual = exact.equals(toSiRational(a.value.value, a.value.unit), toSiRational(b.value.value, b.value.unit));
  const uncertaintyEqual = uncertaintiesEqual(a.uncertainty as PropertyUncertainty, b.uncertainty as PropertyUncertainty, a.value.unit, b.value.unit);
  const sameSource = JSON.stringify(a.provenance.source) === JSON.stringify(b.provenance.source);
  if (valuesEqual && uncertaintyEqual) return { status: 'compared', category: 'identical', reasons: [sameSource ? 'совпадают значение, неопределённость, условия и метод получения; источник тот же — вероятный дубликат' : 'совпадают значение, неопределённость, условия и метод получения; источники различаются'] };
  if (valuesEqual) return { status: 'compared', category: 'review_required', reasons: ['значения равны, а заявленные неопределённости различаются — необходима экспертная оценка'] };
  return { status: 'compared', category: 'different_values', reasons: ['заявленные условия и метод получения совпадают, номинальные значения различаются; это не доказывает ни сопоставимость методик, ни научное противоречие, статистический вывод не делается'] };
}

const byId = (x: { id: string }, y: { id: string }): number => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Descriptions of all pairs of records of the same variant and property, for records ALREADY validated (the registry's snapshot): no validation is repeated. */
export function describeValidatedDifferences(records: readonly PropertyRecord[]): readonly RecordDifference[] {
  const groups = new Map<string, PropertyRecord[]>();
  for (const r of [...records].sort(byId)) {
    const key = `${r.variant}\u0000${r.property}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: RecordDifference[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) for (let j = i + 1; j < group.length; j += 1) {
      const compared = compareValidated(group[i], group[j]);
      if (compared.status !== 'compared') continue;                                      // cannot happen within a group of one variant and property; never reported as a difference
      const { category, reasons } = compared;
      out.push(Object.freeze({ category, variant: group[i].variant, property: group[i].property, records: Object.freeze([group[i].id, group[j].id]) as readonly [string, string], reasons: Object.freeze([...reasons]) }));
    }
  }
  return Object.freeze(out);
}

/** Descriptions of ALL pairs of records of the same variant and property (different variants and properties are never compared). Each record is validated ONCE first:
 *  a record that fails the M1.3.2 validation takes part in no pair. Deterministic order: by record id. */
export function describeDifferences(records: readonly PropertyRecord[]): readonly RecordDifference[] {
  return describeValidatedDifferences(records.filter(r => invalidReason(r, '') === undefined));
}
