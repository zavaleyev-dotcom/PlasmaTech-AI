import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convert, unitsOfKind, QUANTITY_KINDS, UNITS, kindOfDimension, toSI, quantity, measured, multiplyMeasured, divideMeasured, powerMeasured, convertMeasured, toSiRational, exact,
  dimDiv, dimMul, dimPow, dimEquals, dimension, POWER, ENERGY, LENGTH, MASS, TEMPERATURE, TIME, VOLTAGE, CURRENT, AMOUNT, AREA, MASS_DENSITY, PRESSURE,
  THERMAL_CONDUCTIVITY, SPECIFIC_HEAT, THERMAL_EXPANSION, RESISTANCE, RESISTIVITY, CONDUCTIVITY, MOLAR_MASS, FIELD_STRENGTH, THERMAL_DIFFUSIVITY,
  PhysicsError, type UnitId, type QuantityKind,
} from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;
const NEW_KINDS: QuantityKind[] = ['thermalConductivity', 'specificHeatCapacity', 'linearExpansionCoefficient', 'resistance', 'resistivity', 'electricalConductivity', 'molarMass', 'magneticFieldStrength', 'magnetization', 'elasticModulus', 'thermalDiffusivity'];

test('dimensions follow from the SI base dimensions', () => {
  assert.deepEqual([...THERMAL_CONDUCTIVITY], [1, 1, -3, 0, -1, 0, 0]);          // kg m s^-3 K^-1
  assert.deepEqual([...SPECIFIC_HEAT], [2, 0, -2, 0, -1, 0, 0]);                 // m^2 s^-2 K^-1
  assert.deepEqual([...THERMAL_EXPANSION], [0, 0, 0, 0, -1, 0, 0]);              // K^-1
  assert.deepEqual([...RESISTANCE], [2, 1, -3, -2, 0, 0, 0]);                    // m^2 kg s^-3 A^-2
  assert.deepEqual([...RESISTIVITY], [3, 1, -3, -2, 0, 0, 0]);                   // m^3 kg s^-3 A^-2
  assert.deepEqual([...CONDUCTIVITY], [-3, -1, 3, 2, 0, 0, 0]);                  // m^-3 kg^-1 s^3 A^2
  assert.deepEqual([...MOLAR_MASS], [0, 1, 0, 0, 0, -1, 0]);                     // kg mol^-1
  assert.deepEqual([...FIELD_STRENGTH], [-1, 0, 0, 1, 0, 0, 0]);                 // A m^-1
  assert.deepEqual([...THERMAL_DIFFUSIVITY], [2, 0, -1, 0, 0, 0, 0]);            // m^2 s^-1
});

test('relations between the dimensions hold (an independent algebraic check)', () => {
  assert.ok(dimEquals(RESISTANCE, dimDiv(VOLTAGE, CURRENT)));                    // ohm = V/A
  assert.ok(dimEquals(RESISTANCE, dimDiv(POWER, dimPow(CURRENT, 2))));           // ohm = W/A^2
  assert.ok(dimEquals(RESISTIVITY, dimMul(RESISTANCE, LENGTH)));                 // ohm m
  assert.ok(dimEquals(CONDUCTIVITY, dimPow(RESISTIVITY, -1)));                   // S/m = 1/(ohm m)
  assert.ok(dimEquals(THERMAL_CONDUCTIVITY, dimDiv(POWER, dimMul(LENGTH, TEMPERATURE))));
  assert.ok(dimEquals(SPECIFIC_HEAT, dimDiv(ENERGY, dimMul(MASS, TEMPERATURE))));
  assert.ok(dimEquals(THERMAL_DIFFUSIVITY, dimDiv(THERMAL_CONDUCTIVITY, dimMul(MASS_DENSITY, SPECIFIC_HEAT)))); // alpha = k / (rho c)
  assert.ok(dimEquals(THERMAL_DIFFUSIVITY, dimDiv(AREA, TIME)));
  assert.ok(dimEquals(MOLAR_MASS, dimDiv(MASS, AMOUNT)));
  assert.ok(dimEquals(FIELD_STRENGTH, dimDiv(CURRENT, LENGTH)));
  assert.ok(dimEquals(THERMAL_EXPANSION, dimPow(TEMPERATURE, -1)));
  assert.ok(dimEquals(dimension({ temperature: -1 }), THERMAL_EXPANSION));
});

test('control conversion factors (each from the definition of the unit)', () => {
  assert.equal(convert(1, 'W_cmK', 'W_mK'), 100);
  assert.equal(convert(1000, 'mW_mK', 'W_mK'), 1);
  assert.equal(convert(1, 'J_gK', 'J_kgK'), 1000);
  assert.equal(convert(1, 'kJ_kgK', 'J_gK'), 1);
  assert.equal(convert(1, 'ppm_K', 'per_K'), 1e-6);
  assert.equal(convert(12.5, 'ppm_K', 'per_degC'), 12.5e-6);
  assert.equal(convert(1, 'per_degC', 'per_K'), 1);                              // a reciprocal INTERVAL: no 273.15 offset
  assert.equal(convert(1, 'kOhm', 'Ohm'), 1000);
  assert.equal(convert(1, 'MOhm', 'kOhm'), 1000);
  assert.equal(convert(1, 'mOhm', 'Ohm'), 0.001);
  assert.equal(convert(1, 'Ohm_cm', 'Ohm_m'), 0.01);
  assert.equal(convert(1, 'uOhm_cm', 'nOhm_m'), 10);                             // 1e-8 / 1e-9
  assert.equal(convert(2.65, 'uOhm_cm', 'Ohm_m'), 2.65e-8);
  assert.equal(convert(1, 'S_cm', 'S_m'), 100);
  assert.equal(convert(1, 'MS_m', 'S_cm'), 1e4);
  assert.equal(convert(1, 'g_mol', 'kg_mol'), 0.001);
  assert.equal(convert(1000, 'g_mol', 'kg_mol'), 1);
  assert.equal(convert(1, 'kA_m_H', 'A_m_H'), 1000);
  assert.equal(convert(1, 'emu_cm3', 'A_m_M'), 1000);
  assert.equal(convert(1, 'emu_cm3', 'kA_m_M'), 1);
  assert.equal(convert(1, 'GPa_mod', 'MPa_mod'), 1000);
  assert.equal(convert(1, 'GPa_mod', 'Pa_mod'), 1e9);
  assert.equal(convert(1, 'cm2_s', 'm2_s'), 1e-4);
  assert.equal(convert(1, 'mm2_s', 'cm2_s'), 0.01);
});

test('conversions are exact rationals, reversible, and agree with the definitions', () => {
  const exactFactor = (unit: UnitId, numerator: string, denominator = '1') => assert.ok(exact.equals(toSiRational(1, unit), exact.rational(BigInt(numerator), BigInt(denominator))), unit);
  exactFactor('W_cmK', '100'); exactFactor('J_gK', '1000'); exactFactor('emu_cm3', '1000'); exactFactor('GPa_mod', '1000000000');
  exactFactor('uOhm_cm', '1', '100000000'); exactFactor('S_cm', '100'); exactFactor('mm2_s', '1', '1000000');
  const values = [1, 0.07, 3.3, 123.456, 2.5e-7, 7e10, 1e-3, 42];
  for (const kind of NEW_KINDS) {
    const ids = unitsOfKind(kind);
    for (const a of ids) for (const b of ids) for (const v of values) {
      const back = convert(convert(v, a, b), b, a);
      assert.ok(Math.abs(back - v) <= 4.5e-16 * Math.abs(v), `${a} -> ${b} -> ${a}: ${v} gave ${back}`);
    }
  }
});

test('registry: every new kind has an SI unit identifier, derived dimensions are unique, shared dimensions are not derivable', () => {
  for (const kind of NEW_KINDS) {
    const spec = QUANTITY_KINDS[kind];
    assert.ok(unitsOfKind(kind).length >= 1, kind);
    assert.equal(UNITS[spec.siUnit as UnitId].kind, kind);
    assert.equal(toSI(quantity(1, spec.siUnit as UnitId)).unit, spec.siUnit);
  }
  assert.equal(kindOfDimension(THERMAL_CONDUCTIVITY), 'thermalConductivity');
  assert.equal(kindOfDimension(SPECIFIC_HEAT), 'specificHeatCapacity');
  assert.equal(kindOfDimension(THERMAL_EXPANSION), 'linearExpansionCoefficient');
  assert.equal(kindOfDimension(RESISTANCE), 'resistance');
  assert.equal(kindOfDimension(RESISTIVITY), 'resistivity');
  assert.equal(kindOfDimension(CONDUCTIVITY), 'electricalConductivity');
  assert.equal(kindOfDimension(MOLAR_MASS), 'molarMass');
  assert.equal(kindOfDimension(THERMAL_DIFFUSIVITY), 'thermalDiffusivity');
  assert.throws(() => kindOfDimension(PRESSURE), code('unsupported_dimension')); // Pa: pressure, gauge pressure or modulus? never guessed
  assert.throws(() => kindOfDimension(FIELD_STRENGTH), code('unsupported_dimension')); // A/m: H or M? never guessed
});

test('semantic kinds with the same SI dimension are not mixed', () => {
  assert.throws(() => convert(1, 'A_m_H', 'A_m_M' as never), code('kind_mismatch'));
  assert.throws(() => convert(1, 'A_m_M', 'A_m_H' as never), code('kind_mismatch'));
  assert.throws(() => convert(1, 'GPa_mod', 'MPa' as never), code('kind_mismatch'));
  assert.throws(() => convert(1, 'Pa', 'Pa_mod' as never), code('kind_mismatch'));
  assert.throws(() => convert(1, 'Pa_g', 'Pa_mod' as never), code('kind_mismatch'));
  assert.throws(() => convert(1, 'Ohm', 'Ohm_m' as never), code('dimension_mismatch'));
  assert.throws(() => convert(1, 'S_m', 'Ohm_m' as never), code('dimension_mismatch'));   // a reciprocal is not a unit conversion
});

test('physical limits: resistivity, conductivity, molar mass, modulus, specific heat, thermal conductivity and diffusivity are not negative; signed ones are', () => {
  for (const [unit, value] of [['Ohm_m', -1], ['S_m', -1], ['g_mol', -1], ['GPa_mod', -1], ['J_kgK', -1], ['W_mK', -1], ['m2_s', -1]] as const) {
    assert.throws(() => quantity(value, unit), code('below_physical_limit'), unit);
  }
  assert.deepEqual(quantity(-3.5, 'ppm_K'), { value: -3.5, unit: 'ppm_K' });     // a negative expansion coefficient exists
  assert.deepEqual(quantity(-2, 'mOhm'), { value: -2, unit: 'mOhm' });           // a differential resistance can be negative
  assert.deepEqual(quantity(-1, 'kA_m_M'), { value: -1, unit: 'kA_m_M' });       // M and H are signed along an axis
  assert.deepEqual(quantity(-1, 'A_m_H'), { value: -1, unit: 'A_m_H' });
});

test('overflow and underflow in the new units', () => {
  assert.throws(() => convert(1e308, 'GPa_mod', 'Pa_mod'), code('overflow'));
  assert.throws(() => convert(1e308, 'MOhm', 'mOhm'), code('overflow'));
  assert.throws(() => convert(1e-300, 'nOhm_m', 'Ohm_m'), code('underflow'));     // 1e-309: subnormal
  assert.throws(() => convert(1e-305, 'mm2_s', 'm2_s'), code('underflow'));
  assert.throws(() => convert(NaN, 'W_mK', 'W_cmK'), code('not_finite'));
  assert.equal(convert(0, 'W_mK', 'W_cmK'), 0);
});

test('the new kinds work with uncertainty propagation and kind lookup: sigma = 1/rho, R rho L, V / I', () => {
  const sigma = powerMeasured(measured(2, 0.02, 'Ohm_m'), -1);
  assert.equal(sigma.unit, 'S_m');
  assert.equal(sigma.value, 0.5);
  assert.ok(Math.abs(sigma.standardUncertainty - 0.005) < 1e-15);
  const r = divideMeasured(measured(10, 0.1, 'V'), measured(2, 0.02, 'A'));
  assert.equal(r.unit, 'Ohm');
  assert.equal(r.value, 5);
  assert.ok(Math.abs(r.standardUncertainty - Math.sqrt((0.1 / 2) ** 2 + (10 * 0.02 / 4) ** 2)) < 1e-14);
  const rho = multiplyMeasured(measured(2, 0, 'Ohm'), measured(3, 0, 'm'));
  assert.deepEqual(rho, { value: 6, standardUncertainty: 0, unit: 'Ohm_m' });
  const molar = divideMeasured(measured(63.5, 0, 'g'), measured(1, 0, 'mol'));
  assert.equal(molar.unit, 'kg_mol');
  assert.equal(molar.value, 0.0635);
  assert.deepEqual(convertMeasured(measured(1.7, 0.05, 'uOhm_cm'), 'nOhm_m'), { value: 17, standardUncertainty: 0.5, unit: 'nOhm_m' });
  assert.deepEqual(convertMeasured(measured(2, 0.1, 'GPa_mod'), 'MPa_mod'), { value: 2000, standardUncertainty: 100, unit: 'MPa_mod' });
});

test('resistivity from a real formula: rho = R A / L  (R = 2 ohm, A = 4 m^2, L = 8 m  ->  1 ohm m)', () => {
  const R = measured(2, 0, 'Ohm');
  const A = measured(4, 0, 'm2');
  const L = measured(8, 0, 'm');
  const geometry = divideMeasured(A, L);                 // A / L = 0.5 m: m^2 / m is a length
  assert.deepEqual(geometry, { value: 0.5, standardUncertainty: 0, unit: 'm' });
  assert.deepEqual(multiplyMeasured(R, geometry), { value: 1, standardUncertainty: 0, unit: 'Ohm_m' });
  // with uncertainties (first-order GUM, independent inputs): u(A/L)^2 = (u(A)/L)^2 + (A u(L)/L^2)^2 ; u(rho)^2 = (a u(R))^2 + (R u(a))^2
  const u = divideMeasured(measured(4, 0.04, 'm2'), measured(8, 0.08, 'm'));
  assert.equal(u.value, 0.5);
  assert.ok(Math.abs(u.standardUncertainty - Math.sqrt(2 * 0.005 ** 2)) < 1e-15);
  const rho = multiplyMeasured(measured(2, 0.02, 'Ohm'), u);
  assert.equal(rho.unit, 'Ohm_m');
  assert.equal(rho.value, 1);
  assert.ok(Math.abs(rho.standardUncertainty - Math.sqrt((0.5 * 0.02) ** 2 + (2 * u.standardUncertainty) ** 2)) < 1e-14);
  assert.ok(Math.abs(rho.standardUncertainty - 0.017320508075688773) < 1e-15);   // sqrt(3) / 100, by hand
  // the other order of the formula is NOT executable through Measured: R * A has no registered kind (ohm m^2) - a controlled error, not a wrong kind
  assert.throws(() => multiplyMeasured(R, A), code('unsupported_dimension'));
  // the conductivity is the reciprocal
  assert.deepEqual(powerMeasured(measured(1, 0, 'Ohm_m'), -1), { value: 1, standardUncertainty: 0, unit: 'S_m' });
});
