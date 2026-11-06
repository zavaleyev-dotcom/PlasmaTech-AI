/** Structural validators of an `AnalyticSeries`: the equation segments, the `power_sum` equation, its coefficients and their uncertainties, the coefficient check state and the
 *  fit statement. STRUCTURE ONLY: the formula  y(T) = sum c_i * x^n_i,  x = (T - T0) / s  is stored, never evaluated - no value is computed (not at a temperature, not at a
 *  joint of two segments), no coefficient is checked against a reference point, no uncertainty is propagated, nothing is fitted. `power_sum` is one stored form, not a
 *  universal model of materials. */

import { exact, getUnit, PhysicsError } from '@/physics';
import { checkKeys, checkQuantity, isIsoDate, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { collectUncertainty } from './property-uncertainty';
import type { PropertyDefinition } from './property-types';
import { checkLocator, exactTemperature, OBSERVATION_ID } from './series-parts';
import { MAX_POWER_EXPONENT, MAX_SEGMENTS } from './series-types';

type Rational = exact.Rational;
const MAX_SIGNIFICANT_DIGITS = 17;
const MAX_OBSERVATIONS_IN_FIT = 1000000;
export const COEFFICIENT_CHECK_STATUSES = Object.freeze(['not_checked', 'reference_points_available', 'independently_checked'] as const);

export interface ParsedSegment { readonly id: string; readonly min: Rational; readonly max: Rational; readonly minInclusive: boolean; readonly maxInclusive: boolean; readonly minQuantity: unknown; readonly maxQuantity: unknown }
export interface ParsedSegments {
  readonly spans: readonly ParsedSegment[];
  /** `<segment id>:<exponent>`: the identifiers the correlation of the coefficients refers to. */
  readonly coefficientIds: ReadonlySet<string>;
  /** At least one coefficient states an uncertainty (anything but `unknown`). */
  readonly statesCoefficientUncertainty: boolean;
}

/** A coefficient or a reference value: `{ type: 'scalar', value, unit }` with a finite value and a unit of the kind of the property. A coefficient may be negative or zero
 *  (it is a term of a sum, not a property value), so the physical-validity rules of a property VALUE are not applied. Returns the unit or null. */
function checkScalar(v: unknown, definition: PropertyDefinition, path: string, c: Collector): string | null {
  if (!isRecord(v) || v.type !== 'scalar') { c.error('invalid_equation', path, `${path}: ожидался объект { type: 'scalar', value, unit }.`); return null; }
  const before = c.errorCount;
  checkKeys(v, ['type', 'value', 'unit'], path, c, 'invalid_equation');
  if (typeof v.value !== 'number' || !Number.isFinite(v.value)) c.error('invalid_quantity', `${path}.value`, `${path}.value: ожидалось конечное число.`);
  if (typeof v.unit !== 'string') { c.error('invalid_quantity', `${path}.unit`, `${path}.unit: ожидалась единица измерения.`); return null; }
  try {
    const spec = getUnit(v.unit);
    if (spec.kind !== definition.kind) { c.error('invalid_quantity', `${path}.unit`, `${path}.unit: единица ${spec.symbol} не относится к величине свойства «${definition.nameRu}».`); return null; }
  } catch (error) {
    if (error instanceof PhysicsError) { c.error('invalid_quantity', `${path}.unit`, `${path}.unit: ${error.message}`); return null; }
    throw error;
  }
  return c.errorCount === before ? v.unit : null;
}

export const within = (t: Rational, s: ParsedSegment): boolean => {
  const lo = exact.compare(t, s.min); const hi = exact.compare(t, s.max);
  return (lo > 0 || (lo === 0 && s.minInclusive)) && (hi < 0 || (hi === 0 && s.maxInclusive));
};

/** Does the domain of the segment contain a temperature >= `from`? An excluded bound counts as not belonging to the domain. */
const reaches = (s: ParsedSegment, from: Rational): boolean => { const cmp = exact.compare(s.max, from); return cmp > 0 || (cmp === 0 && s.maxInclusive); };
export const domainReaches = (spans: readonly ParsedSegment[], from: Rational): boolean => spans.some(s => reaches(s, from));
/** Does the domain of some segment meet the closed temperature interval [from, to] (a point event has from = to)? Open bounds are honoured. */
export const domainMeets = (spans: readonly ParsedSegment[], from: Rational, to: Rational): boolean => spans.some(s => {
  if (!reaches(s, from)) return false;
  const cmp = exact.compare(s.min, to);
  return cmp < 0 || (cmp === 0 && s.minInclusive);
});

/** One `power_sum` equation. Returns the exact T0 and whether a negative exponent occurs; the exponents are used to build the coefficient ids. */
function collectPowerSum(eq: unknown, definition: PropertyDefinition, segmentId: string, path: string, c: Collector, units: Set<string>, ids: Set<string>): { reference?: Rational; negative: boolean; stated: boolean } {
  const out = { reference: undefined as Rational | undefined, negative: false, stated: false };
  if (!isRecord(eq)) { c.error('invalid_equation', path, `${path}: ожидался объект уравнения { form: 'power_sum', variable, terms }.`); return out; }
  if (eq.form !== 'power_sum') { c.error('invalid_equation', `${path}.form`, `${path}.form: форма «${String(eq.form)}» не поддерживается; сейчас хранится только power_sum.`); return out; }
  checkKeys(eq, ['form', 'variable', 'terms'], path, c, 'invalid_equation');
  const vp = `${path}.variable`;
  if (!isRecord(eq.variable)) c.error('invalid_equation', vp, `${vp}: ожидался объект { reference, scale } — x = (T − T0) / s.`);
  else {
    checkKeys(eq.variable, ['reference', 'scale'], vp, c, 'invalid_equation');
    if (checkQuantity(eq.variable.reference, 'temperature', `${vp}.reference`, c) !== null) out.reference = exactTemperature(eq.variable.reference);     // T0: an ABSOLUTE temperature, never an interval
    checkQuantity(eq.variable.scale, 'temperatureDifference', `${vp}.scale`, c, 'positive');                                                              // s: a strictly positive INTERVAL
  }
  const tp = `${path}.terms`;
  if (!Array.isArray(eq.terms) || eq.terms.length === 0) { c.error('invalid_equation', tp, `${tp}: ожидался непустой список членов.`); return out; }
  const exponents = new Set<number>();
  eq.terms.slice(0, 2 * MAX_POWER_EXPONENT + 2).forEach((term, i) => {
    const p = `${tp}[${i}]`;
    if (!isRecord(term)) { c.error('invalid_equation', p, `${p}: ожидался объект члена { exponent, coefficient, uncertainty }.`); return; }
    checkKeys(term, ['exponent', 'coefficient', 'uncertainty', 'locator'], p, c, 'invalid_equation');
    const n = term.exponent;
    const exponentOk = typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= MAX_POWER_EXPONENT;
    if (typeof n !== 'number' || !Number.isInteger(n)) c.error('invalid_equation', `${p}.exponent`, `${p}.exponent: показатель степени — целое число.`);
    else if (!exponentOk) c.error('invalid_equation', `${p}.exponent`, `${p}.exponent: показатель вне допустимого диапазона −${MAX_POWER_EXPONENT}…+${MAX_POWER_EXPONENT} (технический предел реализации).`);
    else if (exponents.has(n)) c.error('invalid_equation', `${p}.exponent`, `${p}.exponent: показатель ${n} повторяется — члены с одинаковой степенью объединяются в один.`);
    else { exponents.add(n); ids.add(`${segmentId}:${n}`); if (n < 0) out.negative = true; }
    const unit = checkScalar(term.coefficient, definition, `${p}.coefficient`, c);
    if (unit !== null) units.add(unit);
    const value = isRecord(term.coefficient) && typeof term.coefficient.value === 'number' && unit !== null ? { value: term.coefficient.value, unit } : null;
    // always explicit: an absent statement is { kind: 'unknown' }, never zero. The coefficient is a term of a sum, not a property value: its limits may be negative or straddle
    // zero, so the physical-validity rules of the PROPERTY are not applied to them (kind = null); finiteness, the order of the limits, the origin and the enclosure of the
    // nominal coefficient are still checked, in the unit of the coefficient.
    const kind = collectUncertainty(term.uncertainty, value, null, `${p}.uncertainty`, c);
    if (kind !== null && kind !== 'unknown') out.stated = true;
    if (term.locator !== undefined) checkLocator(term.locator, `${p}.locator`, c, 'invalid_equation');
  });
  if (eq.terms.length > 2 * MAX_POWER_EXPONENT + 1) c.error('invalid_equation', tp, `${tp}: членов больше, чем возможно при различных показателях −${MAX_POWER_EXPONENT}…+${MAX_POWER_EXPONENT}.`);
  return out;
}

/** The segments. Domains are exact, must not overlap, and a joint temperature may belong to only ONE of two neighbours. Continuity at a joint is neither required nor
 *  evaluated. A negative exponent forbids T0 inside the domain (open bounds are taken into account). */
export function collectSegments(segments: unknown, definition: PropertyDefinition | undefined, path: string, c: Collector): ParsedSegments {
  const spans: ParsedSegment[] = [];
  const coefficientIds = new Set<string>();
  let statesCoefficientUncertainty = false;
  if (!Array.isArray(segments)) { c.error('invalid_series', path, `${path}: ожидался список сегментов.`); return { spans, coefficientIds, statesCoefficientUncertainty }; }
  if (segments.length === 0) c.error('series_too_short', path, `${path}: нужен хотя бы один сегмент.`);
  if (segments.length > MAX_SEGMENTS) c.error('series_too_long', path, `${path}: сегментов больше технического предела ${MAX_SEGMENTS}.`);
  const seen = new Set<string>();
  const units = new Set<string>();
  segments.slice(0, MAX_SEGMENTS).forEach((seg, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(seg)) { c.error('invalid_segment', p, `${p}: ожидался объект сегмента.`); return; }
    checkKeys(seg, ['id', 'domain', 'equation', 'locator'], p, c, 'invalid_segment');
    let id: string | undefined;
    if (typeof seg.id !== 'string' || !OBSERVATION_ID.test(seg.id) || seg.id.length > 64) c.error('invalid_segment', `${p}.id`, `${p}.id: идентификатор сегмента — строчные латинские буквы, цифры, «-», «_», «.» (до 64 символов).`);
    else if (seen.has(seg.id)) c.error('duplicate_segment_id', `${p}.id`, `${p}.id: идентификатор сегмента «${seg.id}» повторяется.`);
    else { seen.add(seg.id); id = seg.id; }
    if (seg.locator !== undefined) checkLocator(seg.locator, `${p}.locator`, c, 'invalid_segment');
    // the temperature domain
    let min: Rational | undefined; let max: Rational | undefined; let minInclusive = false; let maxInclusive = false;
    const dp = `${p}.domain`;
    if (!isRecord(seg.domain)) c.error('invalid_segment', dp, `${dp}: ожидался объект { min, max, minInclusive, maxInclusive }.`);
    else {
      checkKeys(seg.domain, ['min', 'max', 'minInclusive', 'maxInclusive'], dp, c, 'invalid_segment');
      const lo = checkQuantity(seg.domain.min, 'temperature', `${dp}.min`, c); const hi = checkQuantity(seg.domain.max, 'temperature', `${dp}.max`, c);
      for (const key of ['minInclusive', 'maxInclusive'] as const) if (typeof seg.domain[key] !== 'boolean') c.error('invalid_segment', `${dp}.${key}`, `${dp}.${key}: ожидалось true или false (граница явно включена или исключена).`);
      minInclusive = seg.domain.minInclusive === true; maxInclusive = seg.domain.maxInclusive === true;
      if (lo !== null && hi !== null) {
        const a = exactTemperature(seg.domain.min); const b = exactTemperature(seg.domain.max);
        if (exact.compare(a, b) >= 0) c.error('invalid_segment', dp, `${dp}: нижняя граница должна быть строго меньше верхней.`);
        else { min = a; max = b; }
      }
    }
    const parsed = definition ? collectPowerSum(seg.equation, definition, id ?? `#${i}`, `${p}.equation`, c, units, coefficientIds) : { reference: undefined, negative: false, stated: false };   // an unknown property is reported by the header
    if (parsed.stated) statesCoefficientUncertainty = true;
    if (id === undefined || min === undefined || max === undefined) return;
    const dom = seg.domain as Record<string, unknown>;
    const span: ParsedSegment = { id, min, max, minInclusive, maxInclusive, minQuantity: dom.min, maxQuantity: dom.max };
    spans.push(span);
    // a negative exponent: x = 0 (T = T0) is a singularity and must not lie in the domain
    if (parsed.negative && parsed.reference !== undefined) {
      if (within(parsed.reference, span)) c.error('equation_singularity', `${p}.equation`, `${p}.equation: при отрицательном показателе степени точка T = T0 — сингулярность, а она лежит в области применимости сегмента «${id}»; разбейте область или исключите точку (открытая граница).`);
      else if (exact.compare(parsed.reference, min) === 0 || exact.compare(parsed.reference, max) === 0) c.info('singularity_at_open_boundary', `${p}.equation`, `${p}.equation: T0 совпадает с исключённой границей сегмента «${id}», а показатель отрицательный — выражение неограниченно вблизи этой границы.`);
    }
  });
  if (units.size > 1) c.error('mixed_units', path, `${path}: коэффициенты заданы в разных единицах (${[...units].join(', ')}) — в серии одна единица свойства.`);

  // overlaps and joints: sort by the lower bound, keep the segment that reaches farthest
  const order = [...spans].sort((a, b) => exact.compare(a.min, b.min) || exact.compare(a.max, b.max));
  let reach: ParsedSegment | undefined;
  for (const s of order) {
    if (reach !== undefined) {
      const cmp = exact.compare(s.min, reach.max);
      if (cmp < 0) c.error('segment_overlap', path, `${path}: области сегментов «${reach.id}» и «${s.id}» пересекаются.`);
      else if (cmp === 0 && reach.maxInclusive && s.minInclusive) c.error('ambiguous_segment_boundary', path, `${path}: общая граница сегментов «${reach.id}» и «${s.id}» включена в оба — граничная температура должна принадлежать только одному из них.`);
    }
    if (reach === undefined || exact.compare(s.max, reach.max) > 0) reach = s;
  }
  return { spans: order, coefficientIds, statesCoefficientUncertainty };
}

function collectReferencePoints(points: unknown, definition: PropertyDefinition | undefined, spans: readonly ParsedSegment[], path: string, c: Collector, required: boolean): void {
  if (points === undefined && !required) return;
  if (!Array.isArray(points) || (required && points.length === 0)) { c.error('invalid_coefficient_check', path, `${path}: ожидался${required ? ' непустой' : ''} список контрольных точек.`); return; }
  points.slice(0, 10000).forEach((pt, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(pt)) { c.error('invalid_coefficient_check', p, `${p}: ожидался объект контрольной точки { temperature, value, locator }.`); return; }
    checkKeys(pt, ['temperature', 'value', 'significantDigits', 'locator'], p, c, 'invalid_coefficient_check');
    if (checkQuantity(pt.temperature, 'temperature', `${p}.temperature`, c) !== null && spans.length > 0 && !spans.some(s => within(exactTemperature(pt.temperature), s))) {
      c.warning('reference_point_outside_domain', `${p}.temperature`, `${p}.temperature: температура контрольной точки вне областей применимости сегментов.`);
    }
    if (definition) checkScalar(pt.value, definition, `${p}.value`, c);
    if (pt.significantDigits !== undefined && !(typeof pt.significantDigits === 'number' && Number.isInteger(pt.significantDigits) && pt.significantDigits >= 1 && pt.significantDigits <= MAX_SIGNIFICANT_DIGITS)) c.error('invalid_coefficient_check', `${p}.significantDigits`, `${p}.significantDigits: целое число от 1 до ${MAX_SIGNIFICANT_DIGITS}.`);
    if (pt.locator === undefined) c.error('invalid_coefficient_check', `${p}.locator`, `${p}.locator: контрольная точка без указания места в источнике не принимается.`);
    else checkLocator(pt.locator, `${p}.locator`, c, 'invalid_coefficient_check');
  });
}

/** The state of the check of the coefficients. `not_checked` is NOT a verified formula. `reference_points_available` stores reference points (at least one, with a locator);
 *  `independently_checked` stores a named attestation { by, at, method }. The program computes nothing and never raises a status by itself: the points are not compared with
 *  the formula, and an attestation by a user or a curator is a statement of that person, not a confirmation by the publication. */
export function collectCoefficientCheck(check: unknown, definition: PropertyDefinition | undefined, spans: readonly ParsedSegment[], path: string, c: Collector): void {
  if (!isRecord(check)) { c.error('invalid_coefficient_check', path, `${path}: состояние проверки коэффициентов обязательно; по умолчанию { status: 'not_checked' }.`); return; }
  if (check.status === 'not_checked') {
    checkKeys(check, ['status'], path, c, 'invalid_coefficient_check');
    c.info('coefficients_not_checked', path, `${path}: коэффициенты не проверялись — формула не считается проверенной.`);
    return;
  }
  if (check.status === 'reference_points_available') {
    checkKeys(check, ['status', 'points'], path, c, 'invalid_coefficient_check');
    collectReferencePoints(check.points, definition, spans, `${path}.points`, c, true);
  } else if (check.status === 'independently_checked') {
    checkKeys(check, ['status', 'attestation', 'points'], path, c, 'invalid_coefficient_check');
    const a = check.attestation; const ap = `${path}.attestation`;
    if (!isRecord(a)) c.error('invalid_coefficient_check', ap, `${ap}: аттестация обязательна: { by, at, method } — кто, когда и каким способом проверил.`);
    else {
      checkKeys(a, ['by', 'at', 'method'], ap, c, 'invalid_coefficient_check');
      if (!isNonEmptyString(a.by)) c.error('invalid_coefficient_check', `${ap}.by`, `${ap}.by: укажите, кто выполнил проверку.`);
      if (!isIsoDate(a.at)) c.error('invalid_coefficient_check', `${ap}.at`, `${ap}.at: дата проверки — ГГГГ-ММ-ДД.`);
      if (!isNonEmptyString(a.method)) c.error('invalid_coefficient_check', `${ap}.method`, `${ap}.method: укажите способ проверки.`);
    }
    collectReferencePoints(check.points, definition, spans, `${path}.points`, c, false);
  } else { c.error('invalid_coefficient_check', `${path}.status`, `${path}.status: один из: ${COEFFICIENT_CHECK_STATUSES.join(', ')} (статус не угадывается и не повышается).`); return; }
  c.info('coefficient_check_not_computed', path, `${path}: проверка коэффициентов программой не выполнялась: контрольные точки и аттестация только хранятся, формула не вычислялась и с точками не сравнивалась.`);
}

/** The fit statement. The residual spread of a fit is NOT the uncertainty of the coefficients: it is stored in its own field and never copied into a coefficient. */
export function collectFit(fit: unknown, scope: unknown, statesCoefficientUncertainty: boolean, path: string, c: Collector): void {
  // `uncertaintyScope` says what the series-level statement is about; the uncertainty of a coefficient (the estimate of that parameter) and the residual spread of the fit are
  // different quantities that may be stored together. Neither is converted into the other, and independence of the coefficients is never assumed.
  if (scope === 'fit_residual' && !(isRecord(fit) && fit.residualStandardDeviation !== undefined)) c.error('invalid_series', path, `${path}: область «fit_residual» требует fit.residualStandardDeviation.`);
  if (scope === 'fit_coefficients' && !statesCoefficientUncertainty) c.error('invalid_series', path, `${path}: область «fit_coefficients» заявлена, но ни у одного коэффициента неопределённость не задана.`);
  if (scope === 'unspecified' && statesCoefficientUncertainty) c.info('uncertainty_scope_unspecified', path, `${path}: у коэффициентов заданы неопределённости, а их область (fit_coefficients) не заявлена.`);
  if (fit === undefined) return;
  if (!isRecord(fit)) { c.error('invalid_series', path, `${path}: ожидался объект { residualStandardDeviation?, observations?, note? }.`); return; }
  checkKeys(fit, ['residualStandardDeviation', 'observations', 'note'], path, c, 'invalid_series');
  if (fit.residualStandardDeviation !== undefined && !(typeof fit.residualStandardDeviation === 'number' && Number.isFinite(fit.residualStandardDeviation) && fit.residualStandardDeviation > 0)) c.error('invalid_series', `${path}.residualStandardDeviation`, `${path}.residualStandardDeviation: положительное конечное число (нулевой разброс заявлял бы точное совпадение).`);
  if (fit.observations !== undefined && !(typeof fit.observations === 'number' && Number.isInteger(fit.observations) && fit.observations >= 1 && fit.observations <= MAX_OBSERVATIONS_IN_FIT)) c.error('invalid_series', `${path}.observations`, `${path}.observations: целое число от 1.`);
  if (fit.note !== undefined && !isNonEmptyString(fit.note)) c.error('invalid_series', `${path}.note`, `${path}.note: ожидалась непустая строка.`);
}
