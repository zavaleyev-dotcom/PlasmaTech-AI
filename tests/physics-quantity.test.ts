import test from 'node:test';
import assert from 'node:assert/strict';
import { quantity, convertQuantity, toSI, temperatureDifference, shiftTemperature, gaugeToAbsolute, absoluteToGauge, PhysicsError, type Quantity } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;

test('F4: a physically impossible Quantity cannot be created', () => {
  assert.throws(() => quantity(-5, 'K'), code('below_physical_limit'));
  assert.throws(() => quantity(-300, 'degC'), code('below_physical_limit'));
  assert.throws(() => quantity(-273.16, 'degC'), code('below_physical_limit'));
  assert.throws(() => quantity(-1, 'Pa'), code('below_physical_limit'));
  assert.throws(() => quantity(-1e-9, 'Torr'), code('below_physical_limit'));
  assert.throws(() => quantity(-1, 'kg'), code('below_physical_limit'));
  assert.throws(() => quantity(-1, 'mol'), code('below_physical_limit'));
  assert.throws(() => quantity(NaN, 'K'), code('not_finite'));
  assert.deepEqual(quantity(-273.15, 'degC'), { value: -273.15, unit: 'degC' }); // exactly 0 K
  assert.deepEqual(quantity(0, 'K'), { value: 0, unit: 'K' });
  assert.deepEqual(quantity(-10, 'K_delta'), { value: -10, unit: 'K_delta' });       // an interval may be negative
  assert.deepEqual(quantity(-300, 'degC_delta'), { value: -300, unit: 'degC_delta' });
  assert.deepEqual(quantity(-5, 'mbar_g'), { value: -5, unit: 'mbar_g' });           // gauge pressure may be negative
  assert.ok(Object.is(quantity(-0, 'Pa').value, 0));
});

test('F4: the result is frozen and a forged object is still refused at conversion', () => {
  const q = quantity(1, 'Pa');
  assert.ok(Object.isFrozen(q));
  assert.throws(() => convertQuantity({ value: -5, unit: 'K' } as never, 'degC' as never), code('below_physical_limit'));
  assert.throws(() => convertQuantity({ value: -5, unit: 'Pa' } as never, 'Torr' as never), code('below_physical_limit'));
  assert.throws(() => toSI({ value: Infinity, unit: 'K' } as never), code('not_finite'));
});

test('F2: absolute temperature and temperature difference are different kinds', () => {
  assert.throws(() => convertQuantity(quantity(10, 'degC') as never, 'degC_delta' as never), code('kind_mismatch'));
  assert.throws(() => convertQuantity(quantity(10, 'K_delta') as never, 'K' as never), code('kind_mismatch'));
  const d = temperatureDifference(quantity(20, 'degC'), quantity(10, 'degC'));
  assert.deepEqual(d, { value: 10, unit: 'K_delta' });
  assert.deepEqual(temperatureDifference(quantity(300, 'K'), quantity(20, 'degC')), { value: 6.85, unit: 'K_delta' });
  assert.deepEqual(temperatureDifference(quantity(10, 'degC'), quantity(20, 'degC')), { value: -10, unit: 'K_delta' });
  assert.deepEqual(convertQuantity(d, 'degC_delta'), { value: 10, unit: 'degC_delta' });
  assert.deepEqual(shiftTemperature(quantity(20, 'degC'), quantity(-10, 'K_delta')), { value: 283.15, unit: 'K' });
  assert.deepEqual(shiftTemperature(quantity(20, 'degC'), quantity(5, 'degC_delta')), { value: 298.15, unit: 'K' });
  assert.deepEqual(shiftTemperature(quantity(10, 'K'), quantity(-10, 'K_delta')), { value: 0, unit: 'K' });
  assert.throws(() => shiftTemperature(quantity(10, 'K'), quantity(-10.5, 'K_delta')), code('below_physical_limit'));
  // wrong kinds passed through `as never` are refused at run time
  assert.throws(() => temperatureDifference(quantity(5, 'K_delta') as never, quantity(5, 'K')), code('kind_mismatch'));
  assert.throws(() => shiftTemperature(quantity(5, 'K'), quantity(5, 'K') as never), code('kind_mismatch'));
});

test('F3: gauge <-> absolute needs an explicit reference; nothing is assumed', () => {
  const ref = quantity(101325, 'Pa');
  assert.deepEqual(gaugeToAbsolute(quantity(0, 'Pa_g'), ref), { value: 101325, unit: 'Pa' });
  assert.deepEqual(gaugeToAbsolute(quantity(1, 'bar_g'), ref), { value: 201325, unit: 'Pa' });
  assert.deepEqual(gaugeToAbsolute(quantity(-500, 'mbar_g'), ref), { value: 51325, unit: 'Pa' });
  assert.deepEqual(gaugeToAbsolute(quantity(-101325, 'Pa_g'), ref), { value: 0, unit: 'Pa' }); // perfect vacuum
  assert.deepEqual(gaugeToAbsolute(quantity(1, 'bar_g'), quantity(1000, 'mbar')), { value: 200000, unit: 'Pa' }); // reference in another unit
  assert.deepEqual(absoluteToGauge(quantity(0.07, 'mbar'), quantity(1, 'bar')), { value: -99993, unit: 'Pa_g' });
  assert.deepEqual(absoluteToGauge(ref, ref), { value: 0, unit: 'Pa_g' });
  // round trip: the gauge value is rounded to a double once, so the way back is exact only to double precision
  const g = absoluteToGauge(quantity(3, 'Torr'), quantity(760, 'Torr'));
  const back = gaugeToAbsolute(g, quantity(760, 'Torr'));
  assert.equal(back.unit, 'Pa');
  assert.ok(Math.abs(back.value - 3 * 101325 / 760) < 1e-9);
  // a deeper vacuum than the reference is not an absolute pressure
  assert.throws(() => gaugeToAbsolute(quantity(-102000, 'Pa_g'), ref), code('below_physical_limit'));
  // no reference -> refused, no default 101325
  assert.throws(() => gaugeToAbsolute(quantity(1, 'bar_g'), undefined as never), code('missing_reference'));
  assert.throws(() => absoluteToGauge(quantity(1, 'bar'), null as never), code('missing_reference'));
  // wrong kinds are refused
  assert.throws(() => gaugeToAbsolute(quantity(1, 'bar') as never, ref), code('kind_mismatch'));
  assert.throws(() => gaugeToAbsolute(quantity(1, 'bar_g'), quantity(1, 'bar_g') as never), code('kind_mismatch'));
  assert.throws(() => absoluteToGauge(quantity(1, 'bar_g') as never, ref), code('kind_mismatch'));
  const typed: Quantity<'pressure'> = ref; void typed;
});
