/** Quantities with a standard uncertainty, and first-order (GUM) propagation of it.
 *
 *  `Measured` is a value with its STANDARD uncertainty u (one standard deviation, coverage factor k = 1) in the same unit; u >= 0 and finite. The rules:
 *   - the VALUE of every result AND every uncertainty contribution is computed EXACTLY (exact.ts: rationals, and the root of the exact sum of squares), rounded once
 *     at the very end. No intermediate product, square, power or quotient is a floating-point number, so a representable result is returned even when the
 *     intermediate expressions (1e200 * 1e198, 1e-200 ** 2) would overflow or vanish in `number`. A nonzero uncertainty that cannot be represented (it would be 0,
 *     subnormal or infinite) is an `underflow` / `overflow` error - never a silent 0 and never an approximation;
 *   - the inputs are assumed INDEPENDENT (mutually uncorrelated); covariances are NOT modelled and there is no way to state a correlation. The binary functions
 *     refuse the one case they can see for certain - the very same object passed twice (`correlated_inputs`); two different objects that come from one
 *     measurement or share an error source are NOT detected, that is the caller's responsibility (the general GUM formula needs the covariance terms); sums and differences combine in quadrature, products and quotients through the
 *     sensitivity coefficients (u(ab)^2 = (b u(a))^2 + (a u(b))^2, u(a/b)^2 = (u(a)/b)^2 + (a u(b)/b^2)^2), a power by u(a^n) = |n a^(n-1)| u(a);
 *   - first-order propagation is a LINEARISATION: sums, differences and scaling by an exact factor are linear (affine) in their inputs, a power n = 1 too; a product, a
 *     quotient and a power |n| >= 2 are NOT, and for them the first-order result can be insufficient, especially when an input's uncertainty is significant compared with the
 *     scale of the nonlinearity (for a quotient: the distance of the denominator from zero). A large relative uncertainty does not by itself make it wrong, and the
 *     module does not judge the adequacy - the result says nothing about that.
 *     Where the failure is CERTAIN - every first-order sensitivity is zero while an input is uncertain, so the formula would return a formal 0 for an output that is not
 *     known exactly (x^2 at x = 0 with u(x) > 0; a product of two zeros that are both uncertain) - the function throws `degenerate_linearization` instead of returning 0;
 *     it does NOT add a second-order correction and does not forbid zero inputs whose output is exactly known (u(x) = 0);
 *   - a unit conversion rescales u by the unit's factor only; the offset of an affine scale (°C) does not enter an uncertainty, which is an interval;
 *   - a product/quotient/power finds the kind of its result by SI dimension (kindOfDimension) only when exactly ONE kind has that dimension (a dimension is not a
 *     meaning: K, Pa and A/m are shared by several kinds) and is refused otherwise; scaling by a dimensionless quantity, the power 1 and a ratio of two quantities of
 *     the same kind keep their meaning explicitly; absolute temperature cannot be added (use temperatureDifferenceMeasured); a SEMANTIC kind (temperature difference,
 *     gauge pressure, H, M, elastic modulus) is never an operand of a product/quotient/power otherwise - it can only be scaled (so alpha * dT and C * dT are not executable
 *     through `Measured` yet, although the algebra of dimensions supports them).
 *  Everything is pure and deterministic. */

import { dimDiv, dimMul, dimPow, type Dimension } from './dimensions';
import { PhysicsError } from './errors';
import { add, div, isZero, mul, neg, ONE, rational, rationalFromDecimalText, rationalFromNumber, rationalSqrtToNumber, sign, sub, ZERO, type Rational } from './exact';
import { requireFinite, requireNoOverflow, requireNoUnderflow } from './guards';
import { assertPhysicallyValid, assertUnitsConvertible, convert, exactToNumber, getUnit, kindOfDimension, QUANTITY_KINDS, toSiRational, type KindOfUnit, type QuantityKind, type UnitId, type UnitOf } from './units';
import { getConstant, type ConstantId } from './constants';

export interface Measured<K extends QuantityKind = QuantityKind> {
  readonly value: number;
  /** Standard uncertainty (k = 1), in the same unit as `value`; never negative. */
  readonly standardUncertainty: number;
  readonly unit: UnitOf<K>;
}

/** The same object as both inputs of a formula for INDEPENDENT inputs would silently give a wrong uncertainty (x - x is exactly 0, not sqrt(2) u). Only identity is
 *  detected: a copy, or two objects sharing a measurement, are not (see the module comment). */
function requireDistinct(a: unknown, b: unknown, operation: string): void {
  if (a === b) throw new PhysicsError('correlated_inputs', `${operation}: одно и то же измерение передано дважды как два независимых входа. Формулы M1.2 верны только для независимых величин; для коррелированных нужна общая формула GUM с ковариациями (не реализована).`);
}

function requireUncertainty(u: unknown, label: string): number {
  const n = requireFinite(u, `${label}: стандартная неопределённость`);
  if (n < 0) throw new PhysicsError('invalid_uncertainty', `${label}: стандартная неопределённость не может быть отрицательной.`);
  return n === 0 ? 0 : n;
}

/** A measured quantity: the value must be physically possible for its kind (see `quantity`) and the uncertainty finite and not negative. Frozen. */
export function measured<U extends UnitId>(value: number, standardUncertainty: number, unit: U): Measured<KindOfUnit<U>> {
  const spec = getUnit(unit);
  const label = `Величина (${spec.symbol})`;
  assertPhysicallyValid(value, unit, label);
  const u = requireUncertainty(standardUncertainty, label);
  return Object.freeze({ value: value === 0 ? 0 : value, standardUncertainty: u, unit }) as unknown as Measured<KindOfUnit<U>>;
}

function check(m: unknown, what: string): Measured {
  if (m === null || typeof m !== 'object') throw new PhysicsError('not_finite', `${what}: величина не задана.`);
  const q = m as Measured;
  const spec = getUnit(String(q.unit));
  assertPhysicallyValid(q.value, spec.id, `${what} (${spec.symbol})`);
  requireUncertainty(q.standardUncertainty, `${what} (${spec.symbol})`);
  return q;
}

/** `u` (in unit `from`) as an exact SI interval: the uncertainty is scaled by the factor, never shifted by the offset. */
const uncertaintySi = (u: number, unit: UnitId): Rational => mul(rationalFromNumber(u), getUnit(unit).factor);

/** An exact non-negative contribution as a double; a nonzero exact value that would become 0 or subnormal (or overflow) is an ERROR, never a silent 0. */
function uncertaintyToNumber(exact: Rational, label: string): number {
  return isZero(exact) ? 0 : exactToNumber(exact, `${label}: неопределённость`);
}

/** The root of the exact sum of squares of exact contributions - computed without any intermediate floating-point square, product or quotient (see
 *  rationalSqrtToNumber), then rounded once. A representable result is returned even if the intermediate expressions (1e200 * 1e198, 1e-200 ** 2) are not. */
function combine(label: string, ...terms: Rational[]): number {
  const sumSquares = terms.reduce((sum, t) => add(sum, mul(t, t)), ZERO);
  if (isZero(sumSquares)) return 0;
  const result = rationalSqrtToNumber(sumSquares);
  requireNoOverflow(result, `${label}: неопределённость`);
  return requireNoUnderflow(result, `${label}: неопределённость`);
}

const abs = (x: Rational): Rational => (sign(x) < 0 ? neg(x) : x);

/** The same measured quantity in another unit of the same kind: the value exactly as `convert`, the uncertainty rescaled by the factor ratio. */
export function convertMeasured<K extends QuantityKind>(m: Measured<K>, to: UnitOf<K>): Measured<K> {
  check(m, 'Величина');
  assertUnitsConvertible(m.unit, to);
  const ratio = div(getUnit(m.unit).factor, getUnit(to).factor);
  const u = uncertaintyToNumber(mul(rationalFromNumber(m.standardUncertainty), ratio), 'Преобразование');
  return Object.freeze({ value: convert(m.value, m.unit, to), standardUncertainty: u, unit: to });
}

export function toSIMeasured<K extends QuantityKind>(m: Measured<K>): Measured<K> {
  return convertMeasured(m, QUANTITY_KINDS[getUnit(m.unit).kind].siUnit as UnitOf<K>);
}

/** A measured quantity in the coherent SI unit, EXACT: value and uncertainty as rationals (the uncertainty already scaled by the unit's factor). */
interface SiForm { value: Rational; u: Rational; kind: QuantityKind; dimension: Dimension }

function inSi(input: unknown, what: string): SiForm {
  const m = check(input, what);
  const spec = getUnit(m.unit);
  return { value: toSiRational(m.value, spec.id), u: uncertaintySi(m.standardUncertainty, spec.id), kind: spec.kind, dimension: QUANTITY_KINDS[spec.kind].dimension };
}

function build(kind: QuantityKind, exactValue: Rational, u: number, label: string): Measured {
  const siUnit = QUANTITY_KINDS[kind].siUnit as UnitId;
  const value = isZero(exactValue) ? 0 : exactToNumber(exactValue, label);
  return measured(value, requireNoOverflow(u, label), siUnit);
}

const isDimensionlessKind = (kind: QuantityKind): boolean => kind === 'dimensionless';

/** A SEMANTIC kind (temperature difference, gauge pressure, H, M, elastic modulus) cannot be an operand of a product, quotient or power: the result would be given a
 *  kind by its dimension alone, and a dimension is not a meaning. */
function requireProductKind(s: SiForm, what: string): void {
  if ((QUANTITY_KINDS[s.kind] as { derivable?: boolean }).derivable === false) {
    throw new PhysicsError('kind_mismatch', `${what}: «${QUANTITY_KINDS[s.kind].nameRu}» нельзя умножать, делить и возводить в степень — смысл величины определяется не размерностью, а родом; допустимы только масштабирование (scaleMeasured), умножение и деление на безразмерную величину, степени 0 и 1 и отношение величин одного рода.`);
  }
}

/** The kind of a product. Multiplying by a DIMENSIONLESS quantity keeps the kind of the other factor (also a semantic one: 2 GPa_mod x (1 +- 0.05) is a modulus);
 *  otherwise both factors must be non-semantic and the kind is the only one with the product dimension (ambiguous or unregistered -> `unsupported_dimension`). */
function productKind(x: SiForm, y: SiForm): QuantityKind {
  if (isDimensionlessKind(x.kind)) return y.kind;
  if (isDimensionlessKind(y.kind)) return x.kind;
  requireProductKind(x, 'Множитель 1');
  requireProductKind(y, 'Множитель 2');
  return kindOfDimension(dimMul(x.dimension, y.dimension));
}

/** The kind of a quotient: divided by a dimensionless quantity - the kind of the numerator; two quantities of the SAME kind - dimensionless (a ratio of two moduli,
 *  of two temperature differences); otherwise as for a product. */
function quotientKind(x: SiForm, y: SiForm): QuantityKind {
  if (isDimensionlessKind(y.kind)) return x.kind;
  if (x.kind === y.kind) return 'dimensionless';
  requireProductKind(x, 'Делимое');
  requireProductKind(y, 'Делитель');
  return kindOfDimension(dimDiv(x.dimension, y.dimension));
}

/** a + b, in the SI unit of the kind; the kinds must be equal. Absolute temperatures cannot be added (physically meaningless): use temperatureDifferenceMeasured. */
export function addMeasured<K extends QuantityKind>(a: Measured<K>, b: Measured<K>): Measured<K> {
  requireDistinct(a, b, 'Сумма');
  const x = inSi(a, 'Слагаемое 1');
  const y = inSi(b, 'Слагаемое 2');
  assertUnitsConvertible(a.unit, b.unit);
  if (x.kind === 'temperature') throw new PhysicsError('kind_mismatch', 'Абсолютные температуры не складываются; используйте temperatureDifferenceMeasured или явный сдвиг на разность температур.');
  return build(x.kind, add(x.value, y.value), combine('Сумма', x.u, y.u), 'Сумма') as unknown as Measured<K>;
}

/** a - b, in the SI unit of the kind (the same rules as addMeasured). The result must itself be possible: 5 Pa - 8 Pa is not an absolute pressure. */
export function subtractMeasured<K extends QuantityKind>(a: Measured<K>, b: Measured<K>): Measured<K> {
  requireDistinct(a, b, 'Разность');
  const x = inSi(a, 'Уменьшаемое');
  const y = inSi(b, 'Вычитаемое');
  assertUnitsConvertible(a.unit, b.unit);
  if (x.kind === 'temperature') throw new PhysicsError('kind_mismatch', 'Разность абсолютных температур — это другая величина; используйте temperatureDifferenceMeasured.');
  return build(x.kind, sub(x.value, y.value), combine('Разность', x.u, y.u), 'Разность') as unknown as Measured<K>;
}

/** later - earlier of two absolute temperatures as a temperature difference in K_delta (exact value, uncertainties in quadrature). */
export function temperatureDifferenceMeasured(later: Measured<'temperature'>, earlier: Measured<'temperature'>): Measured<'temperatureDifference'> {
  requireDistinct(later, earlier, 'Разность температур');
  const x = inSi(later, 'Температура 1');
  const y = inSi(earlier, 'Температура 2');
  if (x.kind !== 'temperature' || y.kind !== 'temperature') throw new PhysicsError('kind_mismatch', 'Ожидались абсолютные температуры.');
  return build('temperatureDifference', sub(x.value, y.value), combine('Разность температур', x.u, y.u), 'Разность температур') as unknown as Measured<'temperatureDifference'>;
}

/** m * factor for an exact dimensionless number: the kind is kept (also for a temperature difference and a gauge pressure), u is scaled by |factor| EXACTLY
 *  (a nonzero u that would vanish is an `underflow` error, not a silent 0). */
export function scaleMeasured<K extends QuantityKind>(m: Measured<K>, factor: number): Measured<K> {
  const x = inSi(m, 'Величина');
  requireFinite(factor, 'Множитель');
  const f = rationalFromNumber(factor);
  return build(x.kind, mul(x.value, f), uncertaintyToNumber(mul(x.u, abs(f)), 'Масштабирование'), 'Результат масштабирования') as unknown as Measured<K>;
}

/** a * b; the result kind follows from the product of the dimensions (V * A -> power) and is expressed in its SI unit. u^2 = (|b| u(a))^2 + (|a| u(b))^2, exact. */
export function multiplyMeasured<A extends QuantityKind, B extends QuantityKind>(a: Measured<A>, b: Measured<B>): Measured {
  requireDistinct(a, b, 'Произведение');
  const x = inSi(a, 'Множитель 1');
  const y = inSi(b, 'Множитель 2');
  // both factors are exactly 0 and both uncertain: y = a b still varies (by u(a) u(b)), but both first-order sensitivities (|b|, |a|) are 0
  if (isZero(x.value) && isZero(y.value) && sign(x.u) > 0 && sign(y.u) > 0) throw new PhysicsError('degenerate_linearization', 'Произведение двух нулевых неопределённых величин: коэффициенты чувствительности первого порядка равны 0, а неопределённость результата не равна 0 — линейное приближение неприменимо.');
  const kind = productKind(x, y);
  return build(kind, mul(x.value, y.value), combine('Произведение', mul(abs(y.value), x.u), mul(abs(x.value), y.u)), 'Произведение');
}

/** a / b (b must not be zero); the result kind follows from the quotient of the dimensions (W / m^2 -> power density). u^2 = (u(a)/|b|)^2 + (|a| u(b)/b^2)^2, exact. */
export function divideMeasured<A extends QuantityKind, B extends QuantityKind>(a: Measured<A>, b: Measured<B>): Measured {
  requireDistinct(a, b, 'Частное');
  const x = inSi(a, 'Делимое');
  const y = inSi(b, 'Делитель');
  if (isZero(y.value)) throw new PhysicsError('out_of_range', 'Делитель равен нулю.');
  const kind = quotientKind(x, y);
  const by = abs(y.value);
  return build(kind, div(x.value, y.value), combine('Частное', div(x.u, by), div(mul(abs(x.value), y.u), mul(by, by))), 'Частное');
}

const MAX_POWER = 16;

/** m^n for an integer n (|n| <= 16): the dimension is raised too (length^2 -> area), u(m^n) = |n| |m|^(n-1) u(m), exact (for n < 0: |n| u / |m|^(|n|+1)). */
export function powerMeasured<K extends QuantityKind>(m: Measured<K>, n: number): Measured {
  const x = inSi(m, 'Основание');
  if (!Number.isInteger(n) || Math.abs(n) > MAX_POWER) throw new PhysicsError('out_of_range', `Показатель степени должен быть целым числом, |n| ≤ ${MAX_POWER}.`);
  if (n < 0 && isZero(x.value)) throw new PhysicsError('out_of_range', 'Нуль нельзя возводить в отрицательную степень.');
  if (n === 0) return build('dimensionless', ONE, 0, 'Степень'); // a constant function: exactly known whatever x is (and of any kind)
  // y = x^n, |n| >= 2, at x = 0: the sensitivity n x^(n-1) is 0 (a stationary point) but y varies with an uncertain x. (n < 0 at 0 was refused above, n = 1 has sensitivity 1.)
  if (Math.abs(n) >= 2 && isZero(x.value) && sign(x.u) > 0) throw new PhysicsError('degenerate_linearization', `Степень ${n} в точке 0 при ненулевой неопределённости: коэффициент чувствительности первого порядка равен 0 (стационарная точка), а неопределённость результата не равна 0 — линейное приближение неприменимо.`);
  // the power 1 is the identity and keeps the kind (also a semantic one); any other power must not change a meaning by dimension alone
  if (n !== 1) requireProductKind(x, 'Основание');
  const kind = n === 1 ? x.kind : kindOfDimension(dimPow(x.dimension, n));
  const k = Math.abs(n);
  const magnitude = (e: number): Rational => { let r: Rational = ONE; for (let i = 0; i < e; i += 1) r = mul(r, abs(x.value)); return r; };
  let value: Rational = ONE;
  for (let i = 0; i < k; i += 1) value = mul(value, x.value);
  if (n < 0) value = div(ONE, value);
  const sensitivity = n > 0 ? mul(rational(BigInt(n)), magnitude(n - 1)) : div(rational(BigInt(k)), magnitude(k + 1));
  return build(kind, value, uncertaintyToNumber(mul(sensitivity, x.u), 'Степень'), 'Степень');
}

/** u / |value|, exact and rounded once; refused for a zero value, and a nonzero ratio that would underflow is an `underflow` error, not a silent 0. */
export function relativeUncertainty<K extends QuantityKind>(m: Measured<K>): number {
  const x = inSi(m, 'Величина');
  if (isZero(x.value)) throw new PhysicsError('out_of_range', 'Относительная неопределённость не определена для нулевого значения.');
  return uncertaintyToNumber(div(x.u, abs(x.value)), 'Относительная');
}

/** The expanded uncertainty U = k u (k > 0, finite; k = 2 is about 95 % for a normal distribution), in the unit of `m`; exact product rounded once, no silent underflow. */
export function expandedUncertainty<K extends QuantityKind>(m: Measured<K>, coverageFactor: number): number {
  check(m, 'Величина');
  const k = requireFinite(coverageFactor, 'Коэффициент охвата');
  if (k <= 0) throw new PhysicsError('invalid_uncertainty', 'Коэффициент охвата должен быть больше 0.');
  return uncertaintyToNumber(mul(rationalFromNumber(m.standardUncertainty), rationalFromNumber(k)), 'Расширенная');
}

/** A CODATA constant as a number with its standard uncertainty, both in SI base/derived units written in the constant's `siSymbol`; 0 for an exact constant. */
export function constantWithUncertainty(id: ConstantId | string): { readonly value: number; readonly standardUncertainty: number; readonly siSymbol: string; readonly exact: boolean } {
  const c = getConstant(id);
  const u = c.standardUncertaintyText === undefined ? 0 : exactToNumber(rationalFromDecimalText(c.standardUncertaintyText), `Неопределённость ${c.symbol}`);
  return Object.freeze({ value: c.value, standardUncertainty: u, siSymbol: c.siSymbol, exact: c.status === 'exact' });
}
