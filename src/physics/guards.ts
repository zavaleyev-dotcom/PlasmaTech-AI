/** Numeric guards: the checks every physical calculation needs, in one place. Each throws a PhysicsError with a stable code and a message that names the
 *  quantity; none of them ever "repairs" a value. (The same ideas as the F04 guards of engineering-calculators.ts, which keeps its own private copies.) */

import { PhysicsError } from './errors';

/** Smallest positive NORMAL double. A nonzero result below it is subnormal: it has lost digits of precision. */
export const MIN_NORMAL = 2.2250738585072014e-308;

/** A real, finite number - never NaN, ±Infinity, null, undefined, a string or a boxed number. */
export function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PhysicsError('not_finite', `${label}: введите конечное число.`);
  return value;
}

export function requirePositive(value: unknown, label: string): number {
  const n = requireFinite(value, label);
  if (n <= 0) throw new PhysicsError('out_of_range', `${label}: значение должно быть больше 0.`);
  return n;
}

export function requireNonNegative(value: unknown, label: string): number {
  const n = requireFinite(value, label);
  if (n < 0) throw new PhysicsError('out_of_range', `${label}: значение не может быть отрицательным.`);
  return n;
}

export interface RangeOptions { minInclusive?: boolean; maxInclusive?: boolean }

/** `min <= value <= max` (bounds inclusive by default; pass `minInclusive: false` for an open bound). `-Infinity` / `+Infinity` bounds mean "no bound" in that direction.
 *  The BOUNDS are validated too and are never repaired or swapped: a NaN bound, a reversed range (min > max) and an empty range (min === max with an open end) are a
 *  caller's programming error and throw `out_of_range`. */
export function requireInRange(value: unknown, min: number, max: number, label: string, options: RangeOptions = {}): number {
  const n = requireFinite(value, label);
  const { minInclusive = true, maxInclusive = true } = options;
  if (typeof min !== 'number' || typeof max !== 'number' || Number.isNaN(min) || Number.isNaN(max)) throw new PhysicsError('out_of_range', `${label}: границы диапазона должны быть числами (не NaN).`);
  if (min > max) throw new PhysicsError('out_of_range', `${label}: неверный диапазон — нижняя граница ${min} больше верхней ${max}.`);
  if (min === max && !(minInclusive && maxInclusive)) throw new PhysicsError('out_of_range', `${label}: диапазон пуст — границы совпадают (${min}), а одна из них исключена.`);
  if (n < min || n > max || (!minInclusive && n === min) || (!maxInclusive && n === max)) {
    throw new PhysicsError('out_of_range', `${label}: значение должно лежать в диапазоне ${minInclusive ? '[' : '('}${min}; ${max}${maxInclusive ? ']' : ')'}.`);
  }
  return n;
}

/** A computed result must itself be a real number: an Infinity/NaN means the arithmetic overflowed although every input was fine. */
export function requireNoOverflow(result: number, label: string): number {
  if (!Number.isFinite(result)) throw new PhysicsError('overflow', `${label}: результат не помещается в число двойной точности (переполнение) - проверьте введённые величины.`);
  return result;
}

/** A nonzero input must not produce a zero (or subnormal, precision-less) result: that would silently report a tiny positive quantity as "nothing".
 *  `exactlyZero` says the exact result IS zero (then 0 is correct). */
export function requireNoUnderflow(result: number, label: string, exactlyZero = false): number {
  if (exactlyZero) return result;
  if (result === 0 || (Math.abs(result) < MIN_NORMAL)) throw new PhysicsError('underflow', `${label}: результат слишком мал для представления (потеря точности, underflow) - проверьте введённые величины.`);
  return result;
}
