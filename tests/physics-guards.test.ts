import test from 'node:test';
import assert from 'node:assert/strict';
import { requireFinite, requirePositive, requireNonNegative, requireInRange, requireNoOverflow, requireNoUnderflow, PhysicsError, MIN_NORMAL } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;

test('requireFinite rejects non-numbers and non-finite', () => {
  assert.equal(requireFinite(3, 'x'), 3);
  for (const bad of [NaN, Infinity, '1', null, undefined, {}]) assert.throws(() => requireFinite(bad, 'x'), code('not_finite'));
});

test('positive / non-negative / range', () => {
  assert.equal(requirePositive(1e-300, 'x'), 1e-300);
  assert.throws(() => requirePositive(0, 'x'), code('out_of_range'));
  assert.equal(requireNonNegative(0, 'x'), 0);
  assert.throws(() => requireNonNegative(-1, 'x'), code('out_of_range'));
  assert.equal(requireInRange(5, 0, 10, 'x'), 5);
  assert.equal(requireInRange(10, 0, 10, 'x'), 10);
  assert.throws(() => requireInRange(10, 0, 10, 'x', { maxInclusive: false }), code('out_of_range'));
  assert.throws(() => requireInRange(11, 0, 10, 'x'), code('out_of_range'));
});

test('overflow and underflow', () => {
  assert.throws(() => requireNoOverflow(Infinity, 'x'), code('overflow'));
  assert.equal(requireNoOverflow(1e300, 'x'), 1e300);
  assert.throws(() => requireNoUnderflow(0, 'x'), code('underflow'));
  assert.throws(() => requireNoUnderflow(MIN_NORMAL / 2, 'x'), code('underflow'));
  assert.equal(requireNoUnderflow(0, 'x', true), 0);
  assert.equal(requireNoUnderflow(MIN_NORMAL, 'x'), MIN_NORMAL);
});

test('requireInRange validates the bounds: NaN, reversed, empty ranges are refused, never repaired', () => {
  assert.throws(() => requireInRange(5, NaN, 10, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, 0, NaN, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, NaN, NaN, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, 10, 0, 'x'), code('out_of_range'));      // reversed: 5 would have fit [0; 10], but no silent swap
  assert.throws(() => requireInRange(5, 1, 0, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, Infinity, -Infinity, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, Infinity, 10, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, 0, -Infinity, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, '0' as never, 10, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(5, 5, 5, 'x', { minInclusive: false }), code('out_of_range')); // empty range
  assert.throws(() => requireInRange(5, 5, 5, 'x', { maxInclusive: false }), code('out_of_range'));
});

test('requireInRange: infinite bounds are open directions, equal inclusive bounds accept exactly that value', () => {
  assert.equal(requireInRange(-1e300, -Infinity, 0, 'x'), -1e300);
  assert.equal(requireInRange(1e300, 0, Infinity, 'x'), 1e300);
  assert.equal(requireInRange(7, -Infinity, Infinity, 'x'), 7);
  assert.equal(requireInRange(0, -Infinity, 0, 'x'), 0);
  assert.throws(() => requireInRange(1, -Infinity, 0, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(0, -Infinity, 0, 'x', { maxInclusive: false }), code('out_of_range'));
  assert.equal(requireInRange(5, 5, 5, 'x'), 5);
  assert.throws(() => requireInRange(5.0000001, 5, 5, 'x'), code('out_of_range'));
  assert.throws(() => requireInRange(4.9999999, 5, 5, 'x'), code('out_of_range'));
});

test('requireInRange: the rules for the VALUE are unchanged (non-finite or non-number first)', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined]) assert.throws(() => requireInRange(bad, -Infinity, Infinity, 'x'), code('not_finite'));
});
