import test from 'node:test';
import assert from 'node:assert/strict';
import { exact, PhysicsError } from '../src/physics';

const { rational, rationalFromNumber, rationalFromDecimalText, rationalToNumber, rationalToExactDecimal, add, mul, div, equals, compare, isZero } = exact;

test('rational: normalizes sign and gcd, zero denominator rejected', () => {
  const r = rational(BigInt(6), BigInt(-4));
  assert.equal(r.n, BigInt(-3)); assert.equal(r.d, BigInt(2));
  assert.throws(() => rational(BigInt(1), BigInt(0)), RangeError);
  assert.ok(isZero(rational(BigInt(0), BigInt(5))));
});

test('rationalFromNumber takes the shortest decimal: 0.07 is exactly 7/100', () => {
  assert.ok(equals(rationalFromNumber(0.07), rational(BigInt(7), BigInt(100))));
  assert.ok(equals(rationalFromNumber(1e-7), rational(BigInt(1), BigInt(10000000))));
  assert.ok(equals(rationalFromNumber(-2.5), rational(BigInt(-5), BigInt(2))));
  assert.ok(equals(rationalFromNumber(1.5e21), rational(BigInt('1500000000000000000000'))));
});

test('rationalFromDecimalText: dot, comma, exponent; garbage and huge exponents rejected', () => {
  assert.ok(equals(rationalFromDecimalText('1,5'), rational(BigInt(3), BigInt(2))));
  assert.ok(equals(rationalFromDecimalText('-.25'), rational(BigInt(-1), BigInt(4))));
  assert.ok(equals(rationalFromDecimalText('2e3'), rational(BigInt(2000))));
  for (const bad of ['', 'abc', '1e', '1.2.3', '1e99999', ' ']) {
    assert.throws(() => rationalFromDecimalText(bad), (e: unknown) => e instanceof PhysicsError && e.code === 'invalid_decimal', bad);
  }
});

test('arithmetic is exact: 0.1 + 0.2 == 0.3', () => {
  assert.ok(equals(add(rationalFromNumber(0.1), rationalFromNumber(0.2)), rationalFromNumber(0.3)));
  assert.ok(equals(mul(rational(BigInt(1), BigInt(3)), rational(BigInt(3))), rational(BigInt(1))));
  assert.ok(equals(div(rational(BigInt(1)), rational(BigInt(4))), rationalFromNumber(0.25)));
  assert.equal(compare(rationalFromNumber(0.1), rationalFromNumber(0.2)), -1);
});

test('rationalToNumber: correct rounding, round-trip, subnormals, overflow', () => {
  for (const v of [0, 1, -1, 0.1, 1 / 3, 133.32236842105263, 1e-300, 5e-324, 1.7976931348623157e308, 123456789.123456789]) {
    assert.equal(rationalToNumber(rationalFromNumber(v)), v, String(v));
  }
  assert.equal(rationalToNumber(rational(BigInt(101325), BigInt(760))), 101325 / 760);
  assert.equal(rationalToNumber(rationalFromDecimalText('1e400')), Infinity);
  assert.equal(rationalToNumber(rationalFromDecimalText('1e-400')), 0);
});

test('rationalToExactDecimal: exact for 2^a 5^b denominators, null otherwise', () => {
  assert.equal(rationalToExactDecimal(rational(BigInt(1), BigInt(8))), '0.125');
  assert.equal(rationalToExactDecimal(rational(BigInt(-7), BigInt(100))), '-0.07');
  assert.equal(rationalToExactDecimal(rational(BigInt(1), BigInt(3))), null);
});

// ---------- rounding boundaries (from the independent audit) ----------

const B = (x: number | string | bigint) => BigInt(x);
const TWO = BigInt(2);
const pow2 = (k: number) => TWO ** BigInt(k);

test('ties round to even at the 2^53 boundary', () => {
  const t = pow2(53);
  assert.equal(rationalToNumber(rational(t + B(1))), 9007199254740992);      // tie, even is 2^53
  assert.equal(rationalToNumber(rational(t + B(3))), 9007199254740996);      // tie, even is 2^53 + 4
  assert.equal(rationalToNumber(rational(t + B(2))), 9007199254740994);      // exactly representable
  assert.equal(rationalToNumber(rational(pow2(54) - B(1), TWO)), 9007199254740992); // 2^53 - 1/2: tie between 2^53-1 (odd) and 2^53 (even)
  assert.equal(rationalToNumber(rational(t + B(1) + B(0), B(1))), Number(t + B(1)));
});

test('a rounding carry that reaches 2^53 keeps the value correct', () => {
  const m = pow2(53) - B(1);
  assert.equal(rationalToNumber(rational(m * TWO + B(1), TWO)), 9007199254740992);
  assert.equal(rationalToNumber(rational(m * pow2(30) + pow2(29) + B(1))), Number(m * pow2(30) + pow2(29) + B(1)));
});

test('subnormal boundary: below half the smallest subnormal is 0, the tie goes to even, above rounds up', () => {
  const half = (k: number) => rational(B(k), pow2(1075)); // k * 2^-1075
  assert.equal(rationalToNumber(half(1)), 0);                      // tie between 0 and 2^-1074: even is 0
  assert.equal(rationalToNumber(rational(pow2(1) + B(1), pow2(1076))), 5e-324); // slightly above the tie
  assert.equal(rationalToNumber(half(2)), 5e-324);                 // exactly the smallest subnormal
  assert.equal(rationalToNumber(half(3)), 1e-323);                 // tie between 1 and 2 units: even is 2 (= 2^-1073)
  assert.equal(rationalToNumber(half(5)), 1e-323);                 // tie between 2 and 3 units: even is 2
  assert.equal(rationalToNumber(half(7)), 2e-323);                 // tie between 3 and 4 units: even is 4
  assert.equal(rationalToNumber(rationalFromDecimalText('2.2250738585072014e-308')), 2.2250738585072014e-308); // smallest normal
});

test('overflow boundary: the largest double, and the exact tie above it which rounds to Infinity', () => {
  const max = (pow2(53) - B(1)) * pow2(971);
  assert.equal(rationalToNumber(rational(max)), Number.MAX_VALUE);
  assert.equal(rationalToNumber(rational(max + pow2(969))), Number.MAX_VALUE);   // below the tie
  assert.equal(rationalToNumber(rational(max + pow2(970))), Infinity);           // the tie: even mantissa is 2^53 -> overflow
  assert.equal(rationalToNumber(rational(pow2(1024))), Infinity);
  assert.equal(rationalToNumber(rational(-pow2(1024))), -Infinity);
});

test('seeded cross-check against the engine\'s correctly rounded Number(text) (decimal strings, incl. subnormal and huge exponents)', () => {
  let seed = 20240607;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(next() * 10)).join('');
  for (let i = 0; i < 3000; i += 1) {
    const text = `${next() < 0.5 ? '-' : ''}${digits(1 + Math.floor(next() * 4))}.${digits(1 + Math.floor(next() * 22))}e${Math.floor(next() * 700) - 350}`;
    const expected = Number(text);
    const actual = rationalToNumber(rationalFromDecimalText(text));
    assert.ok(Object.is(actual, expected) || (actual === 0 && expected === 0), `${text}: ${actual} != ${expected}`);
  }
});

test('integers and dyadic fractions against Number(bigint)', () => {
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (let i = 0; i < 1500; i += 1) {
    let n = BigInt(1);
    const bits = 54 + (next() % 200);
    for (let b = 1; b < bits; b += 1) n = (n << BigInt(1)) | BigInt(next() & 1);
    assert.equal(rationalToNumber(rational(n)), Number(n), n.toString());
  }
});

// ---------- exact square root (used for the root of the sum of squares of uncertainty contributions) ----------

test('rationalSqrtToNumber: perfect squares, powers of ten far outside the range of their squares, and edge cases', () => {
  const { rationalSqrtToNumber } = exact;
  assert.equal(rationalSqrtToNumber(rational(B(0))), 0);
  assert.equal(rationalSqrtToNumber(rational(B(4))), 2);
  assert.equal(rationalSqrtToNumber(rational(B(1), B(4))), 0.5);
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e-400')), 1e-200);   // the square is far below the double range
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e400')), 1e200);     // the square is far above it
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e-404')), 1e-202);
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e-640')), 1e-320);   // subnormal result
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e-650')), 0);        // below half the smallest subnormal
  assert.equal(rationalSqrtToNumber(rationalFromDecimalText('1e700')), Infinity);
  assert.equal(rationalSqrtToNumber(rational(B(2))), Math.SQRT2);
  assert.throws(() => rationalSqrtToNumber(rational(B(-1))), RangeError);
});

test('rationalSqrtToNumber against the correctly rounded Math.sqrt on exact (dyadic) inputs and against exact squares', () => {
  const { rationalSqrtToNumber } = exact;
  let seed = 424242;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 4000; i += 1) {
    const n = B(1 + ((next() * 2097152 + (next() >>> 11)) % 9007199254740991));
    const k = next() % 64;
    const expected = Math.sqrt(Number(n) / 2 ** k);   // n < 2^53 and a power of two: the input is exactly representable, Math.sqrt is correctly rounded
    assert.equal(rationalSqrtToNumber(rational(n, pow2(k))), expected, `${n}/2^${k}`);
  }
  for (let i = 0; i < 500; i += 1) {
    let x = BigInt(1);
    for (let b = 1; b < 60 + (next() % 200); b += 1) x = (x << BigInt(1)) | BigInt(next() & 1);
    assert.equal(rationalSqrtToNumber(rational(x * x)), Number(x), x.toString());
    assert.equal(rationalSqrtToNumber(rational(x * x, B(9))), rationalToNumber(rational(x, B(3))), `${x}/3`);
  }
});
