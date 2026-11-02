import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_DIMENSIONS, dimension, dimMul, dimDiv, dimPow, dimEquals, isDimensionless, DIMENSIONLESS, assertSameDimension, formatDimension, PRESSURE, FORCE, ENERGY, POWER, VOLTAGE, MAGNETIC_INDUCTION, LENGTH, MASS, TIME, CURRENT, PhysicsError } from '../src/physics';

test('seven SI base dimensions', () => {
  assert.equal(BASE_DIMENSIONS.length, 7);
  assert.equal(DIMENSIONLESS.length, 7);
});

test('derived dimensions come out of the algebra', () => {
  assert.deepEqual([...FORCE], [1, 1, -2, 0, 0, 0, 0]);
  assert.deepEqual([...PRESSURE], [-1, 1, -2, 0, 0, 0, 0]);
  assert.deepEqual([...ENERGY], [2, 1, -2, 0, 0, 0, 0]);
  assert.deepEqual([...POWER], [2, 1, -3, 0, 0, 0, 0]);
  assert.deepEqual([...VOLTAGE], [2, 1, -3, -1, 0, 0, 0]);
  assert.deepEqual([...MAGNETIC_INDUCTION], [0, 1, -2, -1, 0, 0, 0]);
});

test('algebra: multiply, divide, power, equality, dimensionless', () => {
  assert.ok(dimEquals(dimDiv(ENERGY, TIME), POWER));
  assert.ok(dimEquals(dimMul(PRESSURE, dimPow(LENGTH, 2)), FORCE));
  assert.ok(isDimensionless(dimDiv(MASS, MASS)));
  assert.ok(!dimEquals(ENERGY, POWER));
  assert.ok(dimEquals(dimension({ length: 1 }), LENGTH));
  assert.ok(!dimEquals(CURRENT, TIME));
});

test('assertSameDimension throws dimension_mismatch with readable text', () => {
  assertSameDimension(PRESSURE, PRESSURE);
  assert.throws(() => assertSameDimension(PRESSURE, ENERGY), (e: unknown) => e instanceof PhysicsError && e.code === 'dimension_mismatch');
  assert.equal(formatDimension(DIMENSIONLESS), '1');
  assert.equal(formatDimension(PRESSURE), 'm⁻¹·kg·s⁻²');
});
