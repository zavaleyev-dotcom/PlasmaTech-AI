/** Validation of chemical composition: fractions of ONE basis, their bounds and sum, and stoichiometry. Fractions are compared as EXACT decimals (physics `exact`):
 *  0.1 + 0.2 + 0.7 is exactly 1. Mass, atomic and volume fractions are never mixed and never converted into one another: mass <-> atomic needs verified atomic
 *  weights, which this package does not contain, so there is deliberately no such conversion. */

import { exact } from '@/physics';
import { isElementSymbol } from './elements';
import { checkKeys } from './checks';
import { Collector, isRecord, MaterialsError } from './errors';
import { isMaterialId } from './ids';
import type { MaterialComposition, MaterialKind } from './types';

type Rational = exact.Rational;

interface Bounds { readonly min: Rational; readonly max: Rational; readonly balance: boolean }

const MAX_TOLERANCE = 0.01;
const MAX_COUNT = 1000;
const ZERO = exact.ZERO;
const ONE = exact.ONE;

/** The composition type each material kind may have. */
export const COMPOSITION_TYPES_BY_KIND: Readonly<Record<MaterialKind, readonly MaterialComposition['type'][]>> = Object.freeze({
  element: Object.freeze(['element'] as const),
  compound: Object.freeze(['stoichiometric'] as const),
  ceramic: Object.freeze(['stoichiometric'] as const),
  alloy: Object.freeze(['alloy'] as const),
  composite: Object.freeze(['composite'] as const),
  coating_system: Object.freeze(['coating_system'] as const),
});

function fractionBounds(spec: unknown, path: string, c: Collector): Bounds | null {
  if (!isRecord(spec)) { c.error('fraction_malformed', path, `${path}: доля должна быть объектом { value } или { min, max } или { balance: true }.`); return null; }
  const keys = Object.keys(spec).sort().join(',');
  if (keys === 'balance') {
    if (spec.balance !== true) { c.error('fraction_malformed', path, `${path}: balance должен быть true.`); return null; }
    return { min: ZERO, max: ONE, balance: true };
  }
  if (keys === 'value') {
    const v = spec.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) { c.error('fraction_malformed', path, `${path}: значение доли должно быть конечным числом.`); return null; }
    if (v < 0 || v > 1) { c.error('fraction_out_of_range', path, `${path}: доля ${v} вне диапазона [0; 1].`); return null; }
    const r = exact.rationalFromNumber(v);
    return { min: r, max: r, balance: false };
  }
  if (keys === 'max,min') {
    const { min, max } = spec;
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) { c.error('fraction_malformed', path, `${path}: границы диапазона должны быть конечными числами.`); return null; }
    if (min < 0 || max > 1 || min > max) { c.error('fraction_out_of_range', path, `${path}: диапазон [${min}; ${max}] должен удовлетворять 0 ≤ min ≤ max ≤ 1.`); return null; }
    return { min: exact.rationalFromNumber(min), max: exact.rationalFromNumber(max), balance: false };
  }
  c.error('fraction_malformed', path, `${path}: доля задаётся ровно одним из видов: { value }, { min, max } или { balance: true } (получено: ${Object.keys(spec).join(', ') || 'пусто'}).`);
  return null;
}

function toleranceOf(composition: Record<string, unknown>, path: string, c: Collector): Rational {
  const t = composition.sumTolerance;
  if (t === undefined) return ZERO;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_TOLERANCE) {
    c.error('invalid_tolerance', `${path}.sumTolerance`, `${path}.sumTolerance: допуск суммы должен быть числом от 0 до ${MAX_TOLERANCE}.`);
    return ZERO;
  }
  return exact.rationalFromNumber(t);
}

/** The sum rules for the fractions of ONE composition (alloy / composite). */
function checkSum(bounds: readonly Bounds[], tolerance: Rational, path: string, c: Collector): void {
  let minSum = ZERO;
  let maxSum = ZERO;
  let ranged = false;
  let balances = 0;
  for (const b of bounds) {
    if (b.balance) { balances += 1; continue; }
    minSum = exact.add(minSum, b.min);
    maxSum = exact.add(maxSum, b.max);
    if (!exact.equals(b.min, b.max)) ranged = true;
  }
  if (balances > 1) { c.error('balance_invalid', path, `${path}: «остаток» (balance) может быть только у одной компоненты.`); return; }
  const upper = exact.add(ONE, tolerance);
  const lower = exact.sub(ONE, tolerance);
  if (balances === 1) {
    // the remainder must be able to be >= 0: the smallest possible sum of the other constituents must not exceed 1. The declared sum tolerance does NOT apply here:
    // it excuses rounding of a published sum, it cannot make a negative remainder physically possible.
    if (exact.compare(minSum, ONE) > 0) c.error('fraction_sum', path, `${path}: остаток был бы отрицательным (сумма заданных долей не меньше ${exact.rationalToNumber(minSum)} > 1); допуск суммы на остаток не распространяется.`);
    else if (exact.compare(minSum, ONE) === 0 && !ranged) c.warning('balance_invalid', path, `${path}: остаток равен нулю — заданные доли уже дают 1.`);
    return;
  }
  if (!ranged) {
    if (exact.compare(minSum, lower) < 0 || exact.compare(minSum, upper) > 0) {
      c.error('fraction_sum', path, `${path}: сумма долей ${exact.rationalToNumber(minSum)} не равна 1${exact.isZero(tolerance) ? '' : ` (допуск ${exact.rationalToNumber(tolerance)})`}.`);
    } else if (exact.compare(minSum, ONE) !== 0) {
      c.warning('sum_not_exact', path, `${path}: сумма долей ${exact.rationalToNumber(minSum)} равна 1 только в пределах заявленного допуска.`);
    }
    return;
  }
  if (exact.compare(minSum, upper) > 0 || exact.compare(maxSum, lower) < 0) {
    c.error('fraction_range_infeasible', path, `${path}: диапазоны долей (сумма минимумов ${exact.rationalToNumber(minSum)}, сумма максимумов ${exact.rationalToNumber(maxSum)}) не допускают состав с суммой 1.`);
  }
}

function checkAlloy(comp: Record<string, unknown>, path: string, c: Collector): void {
  checkKeys(comp, ['type', 'basis', 'constituents', 'sumTolerance'], path, c, 'invalid_composition');
  if (comp.basis !== 'mass' && comp.basis !== 'atomic') c.error('invalid_composition', `${path}.basis`, `${path}.basis: для сплава допустимы массовые (mass) или атомные (atomic) доли; получено «${String(comp.basis)}». Доли разных баз не смешиваются.`);
  const list = comp.constituents;
  if (!Array.isArray(list)) { c.error('invalid_composition', `${path}.constituents`, `${path}.constituents: ожидается список компонент.`); return; }
  if (list.length < 2) c.error('too_few_constituents', `${path}.constituents`, `${path}.constituents: сплав содержит не менее двух компонент (одна — это химический элемент).`);
  const tolerance = toleranceOf(comp, path, c);
  const seen = new Set<string>();
  const bounds: Bounds[] = [];
  let valid = true;
  list.forEach((entry, i) => {
    const p = `${path}.constituents[${i}]`;
    if (!isRecord(entry)) { c.error('invalid_composition', p, `${p}: ожидался объект { symbol, fraction }.`); valid = false; return; }
    checkKeys(entry, ['symbol', 'fraction'], p, c, 'invalid_composition');
    if (!isElementSymbol(entry.symbol)) { c.error('invalid_symbol', `${p}.symbol`, `${p}.symbol: «${String(entry.symbol)}» не является символом химического элемента.`); valid = false; }
    else if (seen.has(entry.symbol)) { c.error('duplicate_symbol', `${p}.symbol`, `${p}.symbol: элемент «${entry.symbol}» указан дважды.`); valid = false; }
    else seen.add(entry.symbol);
    const b = fractionBounds(entry.fraction, `${p}.fraction`, c);
    if (b) bounds.push(b); else valid = false;
  });
  if (valid && list.length >= 2) checkSum(bounds, tolerance, `${path}.constituents`, c); // with too few constituents the sum would only repeat the same fault
}

function checkComposite(comp: Record<string, unknown>, path: string, c: Collector): void {
  checkKeys(comp, ['type', 'basis', 'constituents', 'sumTolerance'], path, c, 'invalid_composition');
  if (comp.basis !== 'volume' && comp.basis !== 'mass' && comp.basis !== 'molar') c.error('invalid_composition', `${path}.basis`, `${path}.basis: для композита допустимы volume, mass или molar; получено «${String(comp.basis)}».`);
  const list = comp.constituents;
  if (!Array.isArray(list)) { c.error('invalid_composition', `${path}.constituents`, `${path}.constituents: ожидается список компонент.`); return; }
  if (list.length < 2) c.error('too_few_constituents', `${path}.constituents`, `${path}.constituents: композит содержит не менее двух компонент.`);
  const tolerance = toleranceOf(comp, path, c);
  const seen = new Set<string>();
  const bounds: Bounds[] = [];
  let valid = true;
  list.forEach((entry, i) => {
    const p = `${path}.constituents[${i}]`;
    if (!isRecord(entry)) { c.error('invalid_composition', p, `${p}: ожидался объект { material, fraction }.`); valid = false; return; }
    checkKeys(entry, ['material', 'fraction'], p, c, 'invalid_composition');
    if (!isMaterialId(entry.material)) { c.error('invalid_id', `${p}.material`, `${p}.material: некорректный идентификатор варианта материала.`); valid = false; }
    else if (seen.has(entry.material)) { c.error('duplicate_id', `${p}.material`, `${p}.material: компонента «${entry.material}» указана дважды.`); valid = false; }
    else seen.add(entry.material);
    const b = fractionBounds(entry.fraction, `${p}.fraction`, c);
    if (b) bounds.push(b); else valid = false;
  });
  if (valid && list.length >= 2) checkSum(bounds, tolerance, `${path}.constituents`, c); // with too few constituents the sum would only repeat the same fault
}

function checkStoichiometric(comp: Record<string, unknown>, kind: MaterialKind, path: string, c: Collector): void {
  checkKeys(comp, ['type', 'stoichiometry', 'species'], path, c, 'invalid_composition');
  if (comp.stoichiometry !== 'stoichiometric' && comp.stoichiometry !== 'nonstoichiometric') c.error('stoichiometry_invalid', `${path}.stoichiometry`, `${path}.stoichiometry: ожидалось «stoichiometric» или «nonstoichiometric».`);
  const species = comp.species;
  if (!Array.isArray(species)) { c.error('invalid_composition', `${path}.species`, `${path}.species: ожидается список элементов с количествами на формульную единицу.`); return; }
  if (species.length < 2) c.error('too_few_species', `${path}.species`, `${path}.species: ${kind === 'ceramic' ? 'керамика' : 'соединение'} содержит не менее двух разных элементов.`);
  const seen = new Set<string>();
  let allWholeFixed = true;
  let anyCount = false;
  const integers: number[] = [];
  species.forEach((entry, i) => {
    const p = `${path}.species[${i}]`;
    if (!isRecord(entry)) { c.error('invalid_composition', p, `${p}: ожидался объект { symbol, count }.`); return; }
    checkKeys(entry, ['symbol', 'count'], p, c, 'invalid_composition');
    if (!isElementSymbol(entry.symbol)) c.error('invalid_symbol', `${p}.symbol`, `${p}.symbol: «${String(entry.symbol)}» не является символом химического элемента.`);
    else if (seen.has(entry.symbol)) c.error('duplicate_symbol', `${p}.symbol`, `${p}.symbol: элемент «${entry.symbol}» указан дважды.`);
    else seen.add(entry.symbol);
    const count = entry.count;
    if (typeof count === 'number') {
      if (!Number.isFinite(count) || count <= 0 || count > MAX_COUNT) { c.error('stoichiometry_invalid', `${p}.count`, `${p}.count: количество должно быть числом больше 0 и не более ${MAX_COUNT}.`); return; }
      anyCount = true;
      if (!Number.isInteger(count)) allWholeFixed = false; else integers.push(count);
    } else if (isRecord(count) && Object.keys(count).sort().join(',') === 'max,min') {
      const { min, max } = count;
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max > MAX_COUNT || min > max) {
        c.error('stoichiometry_invalid', `${p}.count`, `${p}.count: диапазон должен удовлетворять 0 < min ≤ max ≤ ${MAX_COUNT}.`); return;
      }
      anyCount = true;
      allWholeFixed = false;
    } else c.error('stoichiometry_invalid', `${p}.count`, `${p}.count: ожидалось число или диапазон { min, max }.`);
  });
  if (!anyCount) return;
  if (comp.stoichiometry === 'stoichiometric' && !allWholeFixed) c.error('stoichiometry_invalid', `${path}.species`, `${path}.species: стехиометрическое соединение задаётся целыми положительными числами; дробные количества и диапазоны — у нестехиометрического.`);
  if (comp.stoichiometry === 'nonstoichiometric' && allWholeFixed) c.error('stoichiometry_invalid', `${path}.species`, `${path}.species: объявлено нестехиометрическим, но все количества — фиксированные целые числа.`);
  if (comp.stoichiometry === 'stoichiometric' && allWholeFixed && integers.length > 1) {
    const g = integers.reduce((a, b) => { let x = a; let y = b; while (y) { [x, y] = [y, x % y]; } return x; });
    if (g > 1) c.warning('stoichiometry_invalid', `${path}.species`, `${path}.species: формула не сокращена (общий делитель ${g}).`);
  }
}

/** Validates the composition against the kind of the material it belongs to. The coating-system stack is validated by stack.ts. */
export function validateComposition(kind: MaterialKind, composition: unknown, path: string, c: Collector): void {
  if (!isRecord(composition) || typeof composition.type !== 'string') { c.error('invalid_composition', path, `${path}: ожидался объект состава с полем type.`); return; }
  const allowed = COMPOSITION_TYPES_BY_KIND[kind];
  if (!allowed || !(allowed as readonly string[]).includes(composition.type)) {
    c.error('kind_composition_mismatch', path, `${path}: материал вида «${kind}» не может иметь состав типа «${composition.type}» (допустимо: ${(allowed ?? []).join(', ')}).`);
    return;
  }
  switch (composition.type) {
    case 'element':
      checkKeys(composition, ['type', 'symbol'], path, c, 'invalid_composition');
      if (!isElementSymbol(composition.symbol)) c.error('invalid_symbol', `${path}.symbol`, `${path}.symbol: «${String(composition.symbol)}» не является символом химического элемента.`);
      return;
    case 'alloy': checkAlloy(composition, path, c); return;
    case 'composite': checkComposite(composition, path, c); return;
    case 'stoichiometric': checkStoichiometric(composition, kind, path, c); return;
    case 'coating_system': checkKeys(composition, ['type', 'stack'], path, c, 'invalid_composition'); return;
    default: c.error('invalid_composition', path, `${path}: неизвестный тип состава «${String(composition.type)}».`);
  }
}

/** Atomic fractions of the elements of a compound with FIXED counts: count / total. A pure ratio - no atomic weights involved. Ranges are not supported. */
export function atomicFractionsFromStoichiometry(composition: Extract<MaterialComposition, { type: 'stoichiometric' }>): Readonly<Record<string, number>> {
  const c = new Collector();
  validateComposition('compound', composition, 'composition', c);
  if (c.errorCount > 0) throw new MaterialsError('invalid_composition', 'Состав некорректен: атомные доли не вычисляются.', c.report().issues);
  let total: Rational = ZERO;
  const counts: [string, Rational][] = [];
  for (const s of composition.species) {
    if (typeof s.count !== 'number') throw new MaterialsError('missing_data', `Для элемента «${s.symbol}» количество задано диапазоном: атомные доли не определены однозначно.`);
    const r = exact.rationalFromNumber(s.count);
    counts.push([s.symbol, r]);
    total = exact.add(total, r);
  }
  return Object.freeze(Object.fromEntries(counts.map(([symbol, r]) => [symbol, exact.rationalToNumber(exact.div(r, total))])));
}
