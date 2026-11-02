/** Exact rational arithmetic on BigInt - the foundation of every unit conversion in the physics core.
 *
 *  Why: converting 0.07 mbar to Pa as `0.07 * 100` gives 7.000000000000001, and Torr = 101325/760 Pa is not a finite decimal at all. Here a number is taken as the
 *  SHORTEST DECIMAL that identifies the double (exactly what the user typed: "0.07"), every factor is an exact rational (1 mbar = 100 Pa, 1 Torr = 101325/760 Pa),
 *  the whole conversion is computed exactly, and ONLY the final result is rounded - once, correctly (to nearest, ties to even), to a double. The same idea as
 *  the exact decimal shift of the TechDoc pressure conversion (techdoc-schema.ts), generalised to arbitrary rational factors and offsets. Pure; no dependencies. */

import { PhysicsError } from './errors';

export interface Rational { readonly n: bigint; readonly d: bigint } // d > 0, gcd(|n|, d) = 1

function gcd(a: bigint, b: bigint): bigint {
  let x = a < BigInt(0) ? -a : a;
  let y = b < BigInt(0) ? -b : b;
  while (y !== BigInt(0)) { [x, y] = [y, x % y]; }
  return x;
}

export function rational(n: bigint, d: bigint = BigInt(1)): Rational {
  if (d === BigInt(0)) throw new RangeError('rational: the denominator is zero');
  if (n === BigInt(0)) return Object.freeze({ n: BigInt(0), d: BigInt(1) });
  const sign = d < BigInt(0) ? -BigInt(1) : BigInt(1);
  const g = gcd(n, d);
  return Object.freeze({ n: (sign * n) / g, d: (sign * d) / g });
}

export const ZERO: Rational = Object.freeze({ n: BigInt(0), d: BigInt(1) });
export const ONE: Rational = Object.freeze({ n: BigInt(1), d: BigInt(1) });

export const add = (a: Rational, b: Rational): Rational => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational): Rational => rational(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational): Rational => rational(a.n * b.n, a.d * b.d);
export function div(a: Rational, b: Rational): Rational {
  if (b.n === BigInt(0)) throw new RangeError('div: division by zero');
  return rational(a.n * b.d, a.d * b.n);
}
export const neg = (a: Rational): Rational => Object.freeze({ n: -a.n, d: a.d });
export const isZero = (a: Rational): boolean => a.n === BigInt(0);
export const sign = (a: Rational): -1 | 0 | 1 => (a.n === BigInt(0) ? 0 : a.n < BigInt(0) ? -1 : 1);
export const equals = (a: Rational, b: Rational): boolean => a.n === b.n && a.d === b.d;
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left === right ? 0 : left < right ? -1 : 1;
}

const MAX_DECIMAL_EXPONENT = 5000; // bounds the size of 10^k (an exponent far beyond any double is rejected, never expanded)
const pow10 = (k: number): bigint => BigInt(10) ** BigInt(k);

function fromDigits(negative: boolean, integer: string, fraction: string, exponent: number): Rational {
  if (Math.abs(exponent) > MAX_DECIMAL_EXPONENT) throw new PhysicsError('invalid_decimal', 'Число слишком велико по порядку: экспонента вне допустимых пределов.');
  const digits = BigInt((integer + fraction).replace(/^0+(?=\d)/, '') || '0');
  const scale = exponent - fraction.length;
  const signed = negative ? -digits : digits;
  return scale >= 0 ? rational(signed * pow10(scale)) : rational(signed, pow10(-scale));
}

/** The exact value of the decimal text that identifies this double (its shortest round-trip form): 0.07 -> 7/100, not 0.070000000000000006661... */
export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) throw new PhysicsError('not_finite', 'Ожидалось конечное число.');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(value)));
  if (!match) throw new PhysicsError('not_finite', 'Ожидалось конечное число.');
  return fromDigits(value < 0, match[1], match[2] ?? '', Number(match[3] ?? 0));
}

const DECIMAL_TEXT = /^([+-])?(?:(\d+)(?:[.,](\d*))?|[.,](\d+))(?:[eE]([+-]?\d+))?$/;

/** Strict decimal syntax only (point or comma, optional sign and exponent): "1.5", "-0,005", ".5", "1e-7", "6.02214076E23". Anything else throws. */
export function rationalFromDecimalText(text: string): Rational {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (!match) throw new PhysicsError('invalid_decimal', `«${text}»: это не десятичное число.`);
  return fromDigits(match[1] === '-', match[2] ?? '0', match[3] ?? match[4] ?? '', Number(match[5] ?? 0));
}

const bitLength = (x: bigint): number => (x === BigInt(0) ? 0 : x.toString(2).length);

/** The double nearest to the rational (ties to even) - bit-for-bit what `Number("<exact decimal>")` gives, including subnormals. May return 0 (the exact value is
 *  below half the smallest subnormal) or ±Infinity (above the largest double); callers must check - see units.ts. */
export function rationalToNumber(value: Rational): number {
  if (value.n === BigInt(0)) return 0;
  const negative = value.n < BigInt(0);
  const a = negative ? -value.n : value.n;
  const d = value.d;
  const shift = 55 - (bitLength(a) - bitLength(d)); // quotient of 55-56 bits: more than the 53 of a double plus a guard bit
  const num = shift >= 0 ? a << BigInt(shift) : a;
  const den = shift >= 0 ? d : d << BigInt(-shift);
  const q = num / den;
  const rem = num % den; // sticky information for the rounding below
  const qBits = bitLength(q);
  let drop = qBits - 53;
  let e = drop - shift; // value = (q >> drop) * 2^e, before rounding
  if (e < -1074) { drop += -1074 - e; e = -1074; } // subnormal range: fewer than 53 significant bits survive
  if (drop > qBits + 1) return negative ? -0 : 0; // below half the smallest subnormal
  const dropped = q & ((BigInt(1) << BigInt(drop)) - BigInt(1));
  let m = q >> BigInt(drop);
  const half = BigInt(1) << BigInt(drop - 1);
  if (dropped > half || (dropped === half && (rem !== BigInt(0) || (m & BigInt(1)) === BigInt(1)))) m += BigInt(1);
  const magnitude = Number(m) * 2 ** e; // m <= 2^53: exact; the product of m by a power of two is exact unless it overflows
  return negative ? -magnitude : magnitude;
}

/** The exact decimal text of a rational whose denominator has only the prime factors 2 and 5 (a terminating decimal); `null` otherwise (1/3, 101325/760...). */
export function rationalToExactDecimal(value: Rational): string | null {
  let d = value.d;
  let twos = 0;
  let fives = 0;
  while (d % BigInt(2) === BigInt(0)) { d /= BigInt(2); twos += 1; }
  while (d % BigInt(5) === BigInt(0)) { d /= BigInt(5); fives += 1; }
  if (d !== BigInt(1)) return null;
  const places = Math.max(twos, fives);
  const scaled = (value.n < BigInt(0) ? -value.n : value.n) * (pow10(places) / value.d);
  const digits = scaled.toString().padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
  return (value.n < BigInt(0) ? '-' : '') + text;
}

function isqrt(n: bigint): bigint {
  if (n < BigInt(2)) return n;
  let x = BigInt(1) << BigInt((bitLength(n) + 1) >> 1); // >= sqrt(n)
  for (;;) {
    const y = (x + n / x) >> BigInt(1);
    if (y >= x) return x;
    x = y;
  }
}

/** The double nearest to sqrt(value) (ties to even), computed EXACTLY - no intermediate rounding, no overflow of squares, no underflow of tiny terms. May return 0 or
 *  Infinity for a result outside the double range (callers check, as for rationalToNumber).
 *
 *  Proof sketch: floor(sqrt(a/b)) = isqrt(floor(a/b)) exactly. With a/b = value * 4^s, m = floor(sqrt(value) * 2^s) has at least ~120 bits, so the double rounding
 *  (to 53 bits, boundaries are INTEGER multiples of m's unit) cannot see the fractional part of sqrt(value) * 2^s except through "is it zero": the value is
 *  therefore represented as (m + 1/2) / 2^s when inexact (strictly between m and m + 1, on the same side of every rounding boundary as the true root) and as m / 2^s
 *  when m * m * b === a (an exact square). */
export function rationalSqrtToNumber(value: Rational): number {
  if (value.n < BigInt(0)) throw new RangeError('rationalSqrtToNumber: negative argument');
  if (value.n === BigInt(0)) return 0;
  let s = Math.ceil((122 - (bitLength(value.n) - bitLength(value.d))) / 2);
  for (;;) {
    const a = s >= 0 ? value.n << BigInt(2 * s) : value.n;
    const b = s >= 0 ? value.d : value.d << BigInt(-2 * s);
    const m = isqrt(a / b);
    if (bitLength(m) < 60) { s += 32; continue; }
    const exactSquare = m * m * b === a;
    const num = exactSquare ? m * BigInt(2) : m * BigInt(2) + BigInt(1); // value of sqrt * 2^s, doubled
    return s >= 0 ? rationalToNumber(rational(num, BigInt(1) << BigInt(s + 1))) : rationalToNumber(rational(num << BigInt(-s), BigInt(2)));
  }
}
