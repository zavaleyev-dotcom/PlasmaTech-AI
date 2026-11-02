import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, kindOfDimension, QUANTITY_KINDS, QUANTITY_KIND_IDS, unitsOfKind, dimMul, dimDiv, dimPow, LENGTH, TIME, VOLTAGE, CURRENT, POWER, AREA, ENERGY, TEMPERATURE, PRESSURE, VELOCITY, MASS, FREQUENCY, PhysicsError } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;

test('derived units: exact factors from their definitions', () => {
  assert.equal(convert(1, 'L', 'cm3'), 1000);
  assert.equal(convert(1, 'mL', 'cm3'), 1);
  assert.equal(convert(1, 'cm2', 'mm2'), 100);
  assert.equal(convert(1, 'm3', 'L'), 1000);
  assert.equal(convert(60, 'nm_min', 'nm_s'), 1);
  assert.equal(convert(36, 'km_h', 'm_s'), 10);
  assert.equal(convert(1, 'um_min', 'nm_min'), 1000);
  assert.equal(convert(3600, 'um_h', 'um_s'), 1);
  assert.equal(convert(10, 'angstrom_s', 'nm_s'), 1);
  assert.equal(convert(60, 'L_min', 'L_s'), 1);
  assert.equal(convert(3600, 'm3_h', 'm3_s'), 1);
  assert.equal(convert(60, 'cm3_min', 'cm3_s'), 1);
  assert.equal(convert(1, 'mA_cm2', 'A_m2'), 10);
  assert.equal(convert(1, 'A_cm2', 'mA_cm2'), 1000);
  assert.equal(convert(1, 'W_cm2', 'W_m2'), 1e4);
  assert.equal(convert(1, 'mW_cm2', 'W_m2'), 10);
  assert.equal(convert(1, 'per_cm3', 'per_m3'), 1e6);
  assert.equal(convert(1, 'g_cm3', 'kg_m3'), 1000);
  assert.equal(convert(13.56, 'MHz', 'Hz'), 13560000);
  assert.equal(convert(1, 'Ah', 'C'), 3600);
  assert.equal(convert(1, 'nm_min', 'm_s'), 1e-9 / 60);
  assert.equal(convert(1, 'L_min', 'm3_s'), 1e-3 / 60);
});

test('physical limits of the new kinds: area, volume, densities and frequency cannot be negative; velocity can', () => {
  for (const [value, unit] of [[-1, 'm2'], [-1, 'L'], [-1, 'per_cm3'], [-1, 'g_cm3'], [-1, 'Hz']] as const) assert.throws(() => convert(value, unit, unit), code('below_physical_limit'), unit);
  assert.equal(convert(-5, 'nm_min', 'nm_s'), -5 / 60); // an etch rate has a sign
  assert.ok(Object.is(convert(-5, 'nm_min', 'nm_min'), -5));
});

test('kinds are not mixed even when dimensions look related', () => {
  assert.throws(() => convert(1, 'm3_s', 'm_s' as never), code('dimension_mismatch'));
  assert.throws(() => convert(1, 'Hz', 'C' as never), code('dimension_mismatch'));
  assert.throws(() => convert(1, 'm2', 'm3' as never), code('dimension_mismatch'));
});

test('kindOfDimension: products and quotients find their kind; ambiguity and unknown dimensions are refused, never guessed', () => {
  assert.equal(kindOfDimension(dimMul(VOLTAGE, CURRENT)), 'power');
  assert.equal(kindOfDimension(dimDiv(POWER, AREA)), 'powerDensity');
  assert.equal(kindOfDimension(dimDiv(CURRENT, AREA)), 'currentDensity');
  assert.equal(kindOfDimension(dimPow(LENGTH, 2)), 'area');
  assert.equal(kindOfDimension(dimPow(LENGTH, 3)), 'volume');
  assert.equal(kindOfDimension(dimDiv(LENGTH, TIME)), 'velocity');
  assert.equal(kindOfDimension(dimPow(TIME, -1)), 'frequency');
  // a dimension shared by several kinds is AMBIGUOUS and is refused, never resolved to the 'primary' kind (J/m3 is not a pressure; K is not necessarily an absolute temperature)
  assert.throws(() => kindOfDimension(dimDiv(ENERGY, dimPow(LENGTH, 3))), code('unsupported_dimension'));
  assert.throws(() => kindOfDimension(TEMPERATURE), code('unsupported_dimension'));
  assert.throws(() => kindOfDimension(PRESSURE), code('unsupported_dimension'));
  assert.equal(kindOfDimension(dimDiv(MASS, dimPow(LENGTH, 3))), 'massDensity');
  assert.throws(() => kindOfDimension(dimDiv(ENERGY, LENGTH)), code('unsupported_dimension')); // force is not registered
  assert.throws(() => kindOfDimension(dimMul(VELOCITY, FREQUENCY)), code('unsupported_dimension'));
});

test('kindOfDimension answers exactly for the dimensions that belong to ONE kind; semantic kinds always share their dimension', () => {
  for (const kind of QUANTITY_KIND_IDS) {
    const spec = QUANTITY_KINDS[kind] as { dimension: readonly number[]; derivable?: boolean };
    const sharing = QUANTITY_KIND_IDS.filter(k => QUANTITY_KINDS[k].dimension.join() === spec.dimension.join());
    if (sharing.length === 1) assert.equal(kindOfDimension(spec.dimension as never), kind, kind);
    else assert.throws(() => kindOfDimension(spec.dimension as never), code('unsupported_dimension'), kind);
    if (spec.derivable === false) assert.ok(sharing.length > 1, `${kind} is marked semantic but its dimension is unique`);
    assert.ok(unitsOfKind(kind).length >= 1);
  }
  // the kinds that share a dimension are exactly: K (temperature, temperatureDifference), Pa (pressure, gaugePressure, elasticModulus), A/m (H, M)
  const shared = QUANTITY_KIND_IDS.filter(kind => QUANTITY_KIND_IDS.filter(k => QUANTITY_KINDS[k].dimension.join() === QUANTITY_KINDS[kind].dimension.join()).length > 1).sort();
  assert.deepEqual(shared, ['elasticModulus', 'gaugePressure', 'magneticFieldStrength', 'magnetization', 'pressure', 'temperature', 'temperatureDifference']);
});
