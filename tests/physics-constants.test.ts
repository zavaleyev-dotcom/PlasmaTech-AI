import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTANTS, CONSTANT_IDS, getConstant, PhysicsError, dimEquals, PRESSURE, exact } from '../src/physics';

test('exact SI defining constants', () => {
  assert.equal(CONSTANTS.speedOfLight.value, 299792458);
  assert.equal(CONSTANTS.planck.value, 6.62607015e-34);
  assert.equal(CONSTANTS.elementaryCharge.value, 1.602176634e-19);
  assert.equal(CONSTANTS.boltzmann.value, 1.380649e-23);
  assert.equal(CONSTANTS.avogadro.value, 6.02214076e23);
  assert.equal(CONSTANTS.standardGravity.value, 9.80665);
  assert.equal(CONSTANTS.standardAtmosphere.value, 101325);
});

test('R and F are the exact products', () => {
  assert.equal(CONSTANTS.gasConstant.valueText, '8.31446261815324');
  assert.equal(CONSTANTS.gasConstant.value, 8.31446261815324);
  assert.equal(CONSTANTS.faraday.valueText, '96485.3321233100184');
  assert.equal(CONSTANTS.faraday.value, 96485.33212331001);
});

test('CODATA 2022 measured values carry an uncertainty', () => {
  const expected: Record<string, [string, string]> = {
    electronMass: ['9.1093837139e-31', '2.8e-40'],
    protonMass: ['1.67262192595e-27', '5.2e-37'],
    atomicMassConstant: ['1.66053906892e-27', '5.2e-37'],
    vacuumPermittivity: ['8.8541878188e-12', '1.4e-21'],
    vacuumPermeability: ['1.25663706127e-6', '2.0e-16'],
  };
  for (const [id, [text, u]] of Object.entries(expected)) {
    const c = getConstant(id);
    assert.equal(c.status, 'measured', id);
    assert.equal(c.valueText, text, id);
    assert.equal(c.standardUncertaintyText, u, id);
    assert.match(c.source.dataset, /CODATA 2022/);
  }
});

test('every constant has a source, value consistent with its text, and finite positive value', () => {
  for (const id of CONSTANT_IDS) {
    const c = CONSTANTS[id];
    assert.ok(c.source.origin && c.source.dataset, id);
    assert.equal(c.value, exact.rationalToNumber(exact.rationalFromDecimalText(c.valueText)), id);
    assert.ok(Number.isFinite(c.value) && c.value > 0, id);
    if (c.status === 'exact') assert.equal(c.standardUncertaintyText, undefined, id);
    else assert.ok(c.standardUncertaintyText, id);
  }
  assert.ok(dimEquals(CONSTANTS.standardAtmosphere.dimension, PRESSURE));
});

test('getConstant: unknown id and prototype keys rejected', () => {
  assert.equal(getConstant('boltzmann'), CONSTANTS.boltzmann);
  for (const bad of ['nope', '__proto__', 'toString']) {
    assert.throws(() => getConstant(bad), (e: unknown) => e instanceof PhysicsError && e.code === 'unknown_constant');
  }
});
