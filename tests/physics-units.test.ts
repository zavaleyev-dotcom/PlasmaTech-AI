import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, convertQuantity, quantity, quantityOfKind, toSI, getUnit, isUnitId, unitsOfKind, areUnitsCompatible, areUnitsConvertible, UNIT_IDS, UNITS, QUANTITY_KINDS, QUANTITY_KIND_IDS, PhysicsError, exact, toSiRational, type Quantity } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;

test('pressure: mbar and Pa are exact (no 7.000000000000001)', () => {
  assert.equal(convert(0.07, 'mbar', 'Pa'), 7);
  assert.equal(convert(1, 'mbar', 'Pa'), 100);
  assert.equal(convert(1, 'Pa', 'mbar'), 0.01);
  assert.equal(convert(0.0003, 'mbar', 'Pa'), 0.03);
  assert.equal(convert(1, 'bar', 'mbar'), 1000);
});

test('Torr is exactly 101325/760 Pa, not 133.322', () => {
  assert.ok(exact.equals(toSiRational(1, 'Torr'), exact.rational(BigInt(101325), BigInt(760))));
  assert.equal(convert(1, 'Torr', 'Pa'), 101325 / 760);
  assert.equal(convert(760, 'Torr', 'atm'), 1);
  assert.equal(convert(760, 'Torr', 'Pa'), 101325);
  assert.notEqual(convert(1, 'Torr', 'Pa'), 133.322);
  assert.equal(convert(1000, 'mTorr', 'Torr'), 1);
  assert.ok(Math.abs(convert(5, 'Torr', 'mbar') - 6.666118421052632) < 1e-12);
});

test('temperature: affine °C/K, exact offset', () => {
  assert.equal(convert(20, 'degC', 'K'), 293.15);
  assert.equal(convert(0.1, 'degC', 'K'), 273.25);
  assert.equal(convert(300, 'K', 'degC'), 26.85);
  assert.equal(convert(0, 'K', 'degC'), -273.15);
  assert.equal(convert(-273.15, 'degC', 'K'), 0);
});

test('temperature difference units have no offset and a negative interval is fine', () => {
  assert.equal(convert(10, 'degC_delta', 'K_delta'), 10);
  assert.equal(convert(-10, 'K_delta', 'degC_delta'), -10);
  assert.equal(convert(-300, 'degC_delta', 'K_delta'), -300);
  assert.equal(convert(1e-3, 'K_delta', 'degC_delta'), 1e-3);
});

test('other units: length, time, mass, current, voltage, power, energy, induction', () => {
  assert.equal(convert(1, 'um', 'nm'), 1000);
  assert.equal(convert(1, 'angstrom', 'nm'), 0.1);
  assert.equal(convert(1, 'h', 's'), 3600);
  assert.equal(convert(90, 'min', 'h'), 1.5);
  assert.equal(convert(1, 'g', 'kg'), 0.001);
  assert.equal(convert(250, 'mA', 'A'), 0.25);
  assert.equal(convert(0.5, 'kV', 'V'), 500);
  assert.equal(convert(2, 'kW', 'W'), 2000);
  assert.equal(convert(1, 'kWh', 'J'), 3.6e6);
  assert.equal(convert(1, 'eV', 'J'), 1.602176634e-19);
  assert.equal(convert(10, 'mT', 'G'), 100);
  assert.equal(convert(50, 'percent', 'one'), 0.5);
});

test('same unit: the same validation as any conversion; -0 becomes 0', () => {
  assert.equal(convert(3.3, 'Pa', 'Pa'), 3.3);
  assert.ok(Object.is(convert(-0, 'm', 'm'), 0));
  assert.equal(convert(-7.5, 'degC_delta', 'degC_delta'), -7.5);
  for (const bad of [NaN, Infinity, -Infinity, '1' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    assert.throws(() => convert(bad, 'Pa', 'Pa'), code('not_finite'));
    assert.throws(() => convert(bad, 'K', 'K'), code('not_finite'));
  }
  assert.throws(() => convert(-1, 'K', 'K'), code('below_physical_limit'));
  assert.throws(() => convert(-300, 'degC', 'degC'), code('below_physical_limit'));
  assert.throws(() => convert(-1, 'Pa', 'Pa'), code('below_physical_limit'));
  assert.throws(() => convert(-1, 'kg', 'kg'), code('below_physical_limit'));
  assert.throws(() => convert(1e-310, 'm', 'm'), code('underflow')); // a subnormal is refused in the same way as for any other conversion
  assert.equal(convert(0, 'nm', 'nm'), 0);
});

test('dimension mismatch and kind mismatch are refused', () => {
  assert.throws(() => convert(1, 'Pa', 'K' as never), code('dimension_mismatch'));
  assert.throws(() => convert(1, 'W', 'J' as never), code('dimension_mismatch'));
  assert.throws(() => convert(1, 'nope' as never, 'Pa'), code('unknown_unit'));
  // same SI dimension, different physical kind: never converted implicitly, in either direction
  assert.throws(() => convert(10, 'K', 'K_delta' as never), code('kind_mismatch'));
  assert.throws(() => convert(10, 'K_delta', 'K' as never), code('kind_mismatch'));
  assert.throws(() => convert(10, 'degC', 'degC_delta' as never), code('kind_mismatch'));
  assert.throws(() => convert(10, 'degC_delta', 'degC' as never), code('kind_mismatch'));
  assert.throws(() => convert(100, 'Pa', 'Pa_g' as never), code('kind_mismatch'));
  assert.throws(() => convert(100, 'bar_g', 'bar' as never), code('kind_mismatch'));
  assert.ok(areUnitsCompatible('K', 'K_delta'));      // same dimension...
  assert.ok(!areUnitsConvertible('K', 'K_delta'));    // ...but not convertible
  assert.ok(areUnitsConvertible('K', 'degC'));
  assert.ok(areUnitsCompatible('mbar', 'Torr'));
  assert.ok(!areUnitsCompatible('mbar', 'K'));
});

test('there is no way to switch the physical limit off: convert takes no options', () => {
  assert.equal(convert.length, 3);
  assert.throws(() => (convert as unknown as (...a: unknown[]) => number)(-500, 'degC', 'K', { allowNegative: true }), code('below_physical_limit'));
  assert.throws(() => (convert as unknown as (...a: unknown[]) => number)(-5, 'Pa', 'Torr', { allowNegative: true }), code('below_physical_limit'));
});

test('physical limits of absolute kinds', () => {
  assert.throws(() => convert(-300, 'degC', 'K'), code('below_physical_limit'));
  assert.throws(() => convert(-1, 'K', 'degC'), code('below_physical_limit'));
  assert.throws(() => convert(-1, 'kg', 'g'), code('below_physical_limit'));
  assert.throws(() => convert(-1, 'Pa', 'Torr'), code('below_physical_limit'));
  assert.equal(convert(-5, 'm', 'mm'), -5000); // signed length is fine
  assert.equal(convert(-100, 'Pa_g', 'mbar_g'), -1); // gauge pressure may be negative
});

test('non-finite input, overflow and underflow', () => {
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => convert(bad, 'Pa', 'Torr'), code('not_finite'));
  assert.throws(() => convert(1e308, 'km', 'nm'), code('overflow'));
  assert.throws(() => convert(1e-300, 'nm', 'km'), code('underflow'));
  assert.equal(convert(0, 'nm', 'km'), 0); // exact zero is fine
});

test('registry integrity: kinds, factors, offsets, SI unit identifiers', () => {
  for (const id of UNIT_IDS) {
    const u = UNITS[id];
    assert.ok(u.kind in QUANTITY_KINDS, id);
    assert.ok(u.factor.n > BigInt(0), id);
    assert.ok(u.basis.length > 0, id);
    if (id !== 'degC') assert.ok(u.offset.n === BigInt(0), id);
    assert.ok(isUnitId(id));
    assert.equal(getUnit(id).id, id);
  }
  for (const kind of QUANTITY_KIND_IDS) {
    const si = QUANTITY_KINDS[kind].siUnit;
    assert.ok(isUnitId(si), `${kind}: siUnit '${si}' is not a unit identifier`);
    assert.equal(UNITS[si].kind, kind, kind);
    assert.ok(exact.equals(UNITS[si].factor, exact.ONE) && exact.isZero(UNITS[si].offset), `${kind}: the SI unit must be coherent (factor 1, offset 0)`);
    assert.ok(unitsOfKind(kind).length >= 1, kind);
  }
  for (const kind of ['length', 'time', 'mass', 'temperature', 'current', 'voltage', 'power', 'energy', 'magneticInduction', 'pressure'] as const) {
    assert.ok(unitsOfKind(kind).length >= 2, kind);
  }
  assert.ok(!isUnitId('__proto__'));
  assert.equal(QUANTITY_KINDS.temperature.dimension.join(), QUANTITY_KINDS.temperatureDifference.dimension.join()); // equal SI dimension
});

test('toSI works for EVERY registered unit (value 1 in the unit -> its SI unit, exact factor)', () => {
  for (const id of UNIT_IDS) {
    const spec = UNITS[id];
    const value = spec.offset.n === BigInt(0) ? 1 : 100;
    const q = quantity(value, id) as Quantity;
    const si = toSI(q);
    assert.equal(si.unit, QUANTITY_KINDS[spec.kind].siUnit, id);
    assert.equal(si.value, exact.rationalToNumber(toSiRational(value, id)), id);
    assert.equal(toSI(si).value, si.value, `${id}: toSI is idempotent`);
  }
  assert.deepEqual(toSI(quantity(50, 'percent')), { value: 0.5, unit: 'one' });
  assert.deepEqual(toSI(quantity(0.07, 'mbar')), { value: 7, unit: 'Pa' });
  assert.deepEqual(toSI(quantity(20, 'degC')), { value: 293.15, unit: 'K' });
  assert.deepEqual(toSI(quantity(-3, 'degC_delta')), { value: -3, unit: 'K_delta' });
  assert.deepEqual(toSI(quantity(-2, 'mbar_g')), { value: -200, unit: 'Pa_g' });
});

test('typed quantities', () => {
  const p = quantity(0.07, 'mbar');
  const typed: Quantity<'pressure'> = p; void typed;
  assert.deepEqual(toSI(p), { value: 7, unit: 'Pa' });
  assert.deepEqual(convertQuantity(p, 'Torr'), { value: convert(0.07, 'mbar', 'Torr'), unit: 'Torr' });
  // @ts-expect-error a temperature unit is not a pressure unit
  assert.throws(() => convertQuantity(p, 'K'), code('dimension_mismatch'));
  // @ts-expect-error a pressure quantity is not a temperature quantity
  const t: Quantity<'temperature'> = typed; void t;
  // @ts-expect-error an absolute temperature is not a temperature difference (same SI dimension, different kind)
  const dt: Quantity<'temperatureDifference'> = quantity(5, 'K'); void dt;
  // @ts-expect-error an absolute pressure is not a gauge pressure
  const gp: Quantity<'gaugePressure'> = typed; void gp;
  assert.throws(() => quantity(NaN, 'Pa'), code('not_finite'));
  assert.throws(() => quantity(1, 'xx' as never), code('unknown_unit'));
  assert.deepEqual(quantityOfKind('temperature', 25, 'degC'), { value: 25, unit: 'degC' });
  assert.throws(() => quantityOfKind('temperature', 25, 'Pa'), code('kind_mismatch'));
  assert.throws(() => quantityOfKind('temperature', 25, 'K_delta'), code('kind_mismatch'));
  assert.throws(() => quantityOfKind('pressure', 'abc', 'Pa'), code('not_finite'));
});
