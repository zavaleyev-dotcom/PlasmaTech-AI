import test from 'node:test';
import assert from 'node:assert/strict';
import { measured, convertMeasured, toSIMeasured, addMeasured, subtractMeasured, temperatureDifferenceMeasured, scaleMeasured, multiplyMeasured, divideMeasured, powerMeasured, relativeUncertainty, expandedUncertainty, constantWithUncertainty, PhysicsError, type Measured } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;
const near = (actual: number, expected: number, rel = 1e-12) => assert.ok(Math.abs(actual - expected) <= rel * Math.abs(expected), `${actual} vs ${expected}`);

test('measured: validation of the value and of the uncertainty', () => {
  const m = measured(20, 0.5, 'degC');
  assert.deepEqual(m, { value: 20, standardUncertainty: 0.5, unit: 'degC' });
  assert.ok(Object.isFrozen(m));
  assert.equal(measured(1, 0, 'Pa').standardUncertainty, 0);
  assert.ok(Object.is(measured(1, -0, 'Pa').standardUncertainty, 0));
  assert.throws(() => measured(1, -0.1, 'Pa'), code('invalid_uncertainty'));
  for (const bad of [NaN, Infinity, '1' as unknown as number]) assert.throws(() => measured(1, bad, 'Pa'), code('not_finite'));
  assert.throws(() => measured(-5, 0.1, 'K'), code('below_physical_limit'));
  assert.throws(() => measured(-1, 0.1, 'Pa'), code('below_physical_limit'));
  assert.throws(() => measured(1, 0.1, 'xx' as never), code('unknown_unit'));
  assert.deepEqual(measured(-10, 2, 'K_delta'), { value: -10, standardUncertainty: 2, unit: 'K_delta' });
});

test('conversion rescales u by the factor only; the °C offset does not enter an uncertainty', () => {
  assert.deepEqual(convertMeasured(measured(0.07, 0.01, 'mbar'), 'Pa'), { value: 7, standardUncertainty: 1, unit: 'Pa' });
  assert.deepEqual(convertMeasured(measured(20, 0.5, 'degC'), 'K'), { value: 293.15, standardUncertainty: 0.5, unit: 'K' });
  assert.deepEqual(convertMeasured(measured(1, 0.1, 'Torr'), 'Pa').unit, 'Pa');
  near(convertMeasured(measured(1, 0.1, 'Torr'), 'Pa').standardUncertainty, 0.1 * 101325 / 760);
  assert.deepEqual(toSIMeasured(measured(50, 5, 'percent')), { value: 0.5, standardUncertainty: 0.05, unit: 'one' });
  assert.equal(convertMeasured(measured(3, 0, 'nm_min'), 'nm_s').standardUncertainty, 0);
  assert.throws(() => convertMeasured(measured(10, 1, 'degC') as Measured, 'degC_delta' as never), code('kind_mismatch'));
  assert.throws(() => convertMeasured({ value: -5, standardUncertainty: 1, unit: 'K' } as never, 'degC' as never), code('below_physical_limit'));
  assert.throws(() => convertMeasured({ value: 5, standardUncertainty: -1, unit: 'K' } as never, 'degC' as never), code('invalid_uncertainty'));
});

test('sum and difference: quadrature (3-4-5), exact value, SI unit of the kind', () => {
  const a = measured(10, 3, 'W');
  const b = measured(5, 4, 'W');
  assert.deepEqual(addMeasured(a, b), { value: 15, standardUncertainty: 5, unit: 'W' });
  assert.deepEqual(subtractMeasured(a, b), { value: 5, standardUncertainty: 5, unit: 'W' });
  const sum = addMeasured(measured(1, 0.0003, 'kW'), measured(500, 0.4, 'W'));
  assert.equal(sum.value, 1500);
  near(sum.standardUncertainty, 0.5); // sqrt(0.3^2 + 0.4^2)
  assert.equal(addMeasured(measured(0.1, 0, 'mbar'), measured(0.2, 0, 'mbar')).value, 30); // exact: 10 Pa + 20 Pa
  assert.throws(() => subtractMeasured(measured(5, 0, 'Pa'), measured(8, 0, 'Pa')), code('below_physical_limit'));
  assert.throws(() => addMeasured(measured(5, 0, 'Pa'), measured(8, 0, 'Pa_g') as never), code('kind_mismatch'));
});

test('absolute temperatures are not added; their difference is a temperature difference', () => {
  assert.throws(() => addMeasured(measured(20, 1, 'degC'), measured(30, 1, 'degC')), code('kind_mismatch'));
  assert.throws(() => subtractMeasured(measured(20, 1, 'degC'), measured(30, 1, 'degC')), code('kind_mismatch'));
  const d = temperatureDifferenceMeasured(measured(30, 0.4, 'degC'), measured(20, 0.3, 'degC'));
  assert.equal(d.unit, 'K_delta');
  assert.equal(d.value, 10);
  near(d.standardUncertainty, 0.5);
  assert.equal(temperatureDifferenceMeasured(measured(20, 0.3, 'degC'), measured(30, 0.4, 'degC')).value, -10);
  assert.equal(temperatureDifferenceMeasured(measured(300, 0, 'K'), measured(20, 0, 'degC')).value, 6.85);
  assert.throws(() => temperatureDifferenceMeasured(measured(5, 1, 'K_delta') as never, measured(5, 1, 'K')), code('kind_mismatch'));
  // intervals themselves add
  assert.deepEqual(addMeasured(measured(10, 3, 'K_delta'), measured(-6, 4, 'degC_delta')), { value: 4, standardUncertainty: 5, unit: 'K_delta' });
});

test('product: P = V I (GUM), the kind follows from the dimension', () => {
  const p = multiplyMeasured(measured(10, 0.1, 'V'), measured(2, 0.02, 'A'));
  assert.equal(p.unit, 'W');
  assert.equal(p.value, 20);
  near(p.standardUncertainty, Math.sqrt(0.04 + 0.04));
  const j = multiplyMeasured(measured(5, 0, 'W'), measured(3, 0, 's'));
  assert.deepEqual(j, { value: 15, standardUncertainty: 0, unit: 'J' });
  assert.equal(multiplyMeasured(measured(2, 0, 'mA'), measured(5, 0, 'V')).value, 0.01); // exact SI: 0.002 * 5
  assert.throws(() => multiplyMeasured(measured(1, 0, 'V'), measured(1, 0, 'W')), code('unsupported_dimension'));
});

test('quotient: power density, exact value, GUM uncertainty; zero divisor refused', () => {
  const q = divideMeasured(measured(100, 1, 'W'), measured(0.01, 0.0001, 'm2'));
  assert.equal(q.unit, 'W_m2');
  assert.equal(q.value, 10000);
  near(q.standardUncertainty, Math.sqrt(100 ** 2 + 100 ** 2));
  const rate = divideMeasured(measured(300, 3, 'nm'), measured(2, 0, 'min'));
  assert.equal(rate.unit, 'm_s');
  near(rate.value, 300e-9 / 120);
  assert.throws(() => divideMeasured(measured(1, 0, 'W'), measured(0, 0, 'm2')), code('out_of_range'));
  assert.throws(() => divideMeasured(measured(1, 0, 'J'), measured(1, 0, 'm')), code('unsupported_dimension')); // force: not registered
  const dimensionless = divideMeasured(measured(6, 0.3, 'm'), measured(2, 0, 'm'));
  assert.deepEqual(dimensionless, { value: 3, standardUncertainty: 0.15, unit: 'one' });
});

test('a difference or a gauge pressure cannot be multiplied (its kind would be lost) but can be scaled', () => {
  assert.throws(() => multiplyMeasured(measured(10, 1, 'K_delta'), measured(2, 0, 'm')), code('kind_mismatch'));
  assert.throws(() => divideMeasured(measured(1, 0, 'Pa_g'), measured(2, 0, 's')), code('kind_mismatch'));
  assert.throws(() => powerMeasured(measured(1, 0, 'Pa_g'), 2), code('kind_mismatch'));
  assert.deepEqual(scaleMeasured(measured(10, 1, 'K_delta'), -2), { value: -20, standardUncertainty: 2, unit: 'K_delta' });
  assert.deepEqual(scaleMeasured(measured(-3, 0.5, 'mbar_g'), 4), { value: -1200, standardUncertainty: 200, unit: 'Pa_g' });
  assert.throws(() => scaleMeasured(measured(1, 0, 'Pa'), -1), code('below_physical_limit'));
  assert.throws(() => scaleMeasured(measured(1, 0, 'Pa'), NaN), code('not_finite'));
});

test('power: length^2 is an area, u = |n x^(n-1)| u; negative and zero powers', () => {
  const a = powerMeasured(measured(0.1, 0.001, 'm'), 2);
  assert.equal(a.unit, 'm2');
  near(a.value, 0.01);
  near(a.standardUncertainty, 2 * 0.1 * 0.001);
  const v = powerMeasured(measured(2, 0.1, 'cm'), 3);
  assert.equal(v.unit, 'm3');
  near(v.standardUncertainty, 3 * 0.02 ** 2 * 0.001);
  const inv = powerMeasured(measured(4, 0.2, 's'), -1);
  assert.equal(inv.unit, 'Hz');
  assert.equal(inv.value, 0.25);
  near(inv.standardUncertainty, 0.2 / 16);
  assert.throws(() => powerMeasured(measured(2, 0, 's'), -2), code('unsupported_dimension'));
  assert.deepEqual(powerMeasured(measured(7, 1, 'm'), 0), { value: 1, standardUncertainty: 0, unit: 'one' });
  assert.throws(() => powerMeasured(measured(0, 0, 's'), -1), code('out_of_range'));
  assert.throws(() => powerMeasured(measured(2, 0, 'm'), 1.5), code('out_of_range'));
  assert.throws(() => powerMeasured(measured(2, 0, 'm'), 17), code('out_of_range'));
});

test('relative and expanded uncertainty', () => {
  near(relativeUncertainty(measured(200, 5, 'mbar')), 0.025);
  assert.throws(() => relativeUncertainty(measured(0, 1, 'Pa')), code('out_of_range'));
  assert.equal(expandedUncertainty(measured(1, 0.25, 'V'), 2), 0.5);
  assert.throws(() => expandedUncertainty(measured(1, 0.25, 'V'), 0), code('invalid_uncertainty'));
  assert.throws(() => expandedUncertainty(measured(1, 0.25, 'V'), -2), code('invalid_uncertainty'));
});

test('overflow in the uncertainty or the value is refused; zero uncertainty stays zero', () => {
  assert.throws(() => multiplyMeasured(measured(1e200, 0, 'm'), measured(1e200, 0, 'm')), code('overflow'));
  assert.throws(() => multiplyMeasured(measured(1e200, 1e200, 'm'), measured(1e200, 0, 'm')), code('overflow'));
  assert.equal(multiplyMeasured(measured(3, 0, 'm'), measured(4, 0, 'm')).standardUncertainty, 0);
});

test('constantWithUncertainty: exact constants have 0, CODATA constants carry theirs', () => {
  assert.deepEqual(constantWithUncertainty('boltzmann'), { value: 1.380649e-23, standardUncertainty: 0, siSymbol: 'Дж/К', exact: true });
  const me = constantWithUncertainty('electronMass');
  assert.equal(me.value, 9.1093837139e-31);
  assert.equal(me.standardUncertainty, 2.8e-40);
  assert.equal(me.exact, false);
  assert.throws(() => constantWithUncertainty('nope'), code('unknown_constant'));
});

// ---------- extreme magnitudes: no intermediate overflow/underflow, no silent loss of a nonzero uncertainty ----------

test('divide: a representable result despite extreme intermediate expressions (audit cases)', () => {
  const q1 = divideMeasured(measured(1, 0, 'm'), measured(1e200, 1e198, 'm'));
  assert.equal(q1.unit, 'one');
  assert.equal(q1.value, 1e-200);
  assert.equal(q1.standardUncertainty, 1e-202);
  const q3 = divideMeasured(measured(1e200, 1e198, 'm'), measured(1e200, 1e198, 'm'));
  assert.equal(q3.value, 1);
  near(q3.standardUncertainty, 0.0141421356237, 1e-11);
  assert.equal(q3.standardUncertainty, Math.SQRT2 / 100);
  const q4 = divideMeasured(measured(1e-200, 0, 'm'), measured(1e-200, 0, 'm'));
  assert.deepEqual(q4, { value: 1, standardUncertainty: 0, unit: 'one' });
  // more: both far out of range in different directions
  const q5 = divideMeasured(measured(1e300, 1e298, 'W'), measured(1e300, 1e298, 'm2'));
  assert.equal(q5.unit, 'W_m2');
  assert.equal(q5.value, 1);
  assert.equal(q5.standardUncertainty, Math.SQRT2 / 100);
  const q6 = divideMeasured(measured(1e-300, 1e-302, 'W'), measured(1e-300, 1e-302, 'm2'));
  assert.equal(q6.value, 1);
  assert.equal(q6.standardUncertainty, Math.SQRT2 / 100);
  const q7 = divideMeasured(measured(1e150, 1e148, 'W'), measured(1e-150, 1e-152, 'm2'));
  assert.equal(q7.value, 1e300);
  near(q7.standardUncertainty, Math.SQRT2 * 1e298, 1e-15);
});

test('power: a representable result despite extreme intermediate expressions (audit cases)', () => {
  const inv = powerMeasured(measured(1e160, 1e158, 's'), -1);
  assert.equal(inv.unit, 'Hz');
  assert.equal(inv.value, 1e-160);
  assert.equal(inv.standardUncertainty, 1e-162);
  const same = powerMeasured(measured(1e200, 1e198, 'm'), 1);
  assert.deepEqual(same, { value: 1e200, standardUncertainty: 1e198, unit: 'm' });
  const cube = powerMeasured(measured(1e100, 1e98, 'm'), 3);
  assert.equal(cube.unit, 'm3');
  assert.equal(cube.value, 1e300);
  near(cube.standardUncertainty, 3e298, 1e-15); // 3 x^2 u = 3 * 1e200 * 1e98
  const root = powerMeasured(measured(1e-100, 1e-102, 'm'), -3);   // 1/x^3 = 1e300, u = 3 u / x^4
  assert.equal(root.unit, 'per_m3');
  assert.equal(root.value, 1e300);
  near(root.standardUncertainty, 3e298, 1e-15);
  assert.throws(() => powerMeasured(measured(1e160, 0, 'm'), 2), code('overflow'));     // the VALUE itself is out of range: refused
  assert.throws(() => powerMeasured(measured(1e-160, 0, 'm'), 2), code('underflow'));
});

test('multiply: the same exactness', () => {
  const p = multiplyMeasured(measured(1e200, 1e198, 'm'), measured(1e-200, 0, 'm'));
  assert.equal(p.unit, 'm2');
  assert.equal(p.value, 1);
  assert.equal(p.standardUncertainty, 1e-2);
  // the product itself (1e-300 m2) is representable and so is its uncertainty
  const r = multiplyMeasured(measured(1e-200, 1e-202, 'm'), measured(1e-100, 1e-102, 'm'));
  assert.equal(r.value, 1e-300);
  near(r.standardUncertainty, Math.SQRT2 * 1e-302, 1e-15);
  // a value out of range is refused, not clamped
  assert.throws(() => multiplyMeasured(measured(1e-200, 0, 'm'), measured(1e-200, 0, 'm')), code('underflow'));
});

test('no silent underflow of a nonzero uncertainty: scale, relative, expanded', () => {
  assert.throws(() => scaleMeasured(measured(1, 1e-200, 'm'), 1e-200), code('underflow'));
  assert.deepEqual(scaleMeasured(measured(1, 1e-200, 'm'), 1e100), { value: 1e100, standardUncertainty: 1e-100, unit: 'm' });
  assert.throws(() => scaleMeasured(measured(1, 1e300, 'm'), 1e300), code('overflow'));
  assert.deepEqual(scaleMeasured(measured(1, 0, 'm'), 1e-200), { value: 1e-200, standardUncertainty: 0, unit: 'm' });
  assert.throws(() => relativeUncertainty(measured(1e300, 1e-300, 'm')), code('underflow'));
  assert.equal(relativeUncertainty(measured(1e200, 1e-100, 'm')), 1e-300);
  assert.equal(relativeUncertainty(measured(1e200, 0, 'm')), 0);
  assert.throws(() => expandedUncertainty(measured(1, 1e-200, 'm'), 1e-200), code('underflow'));
  assert.equal(expandedUncertainty(measured(1, 1e-200, 'm'), 2), 2e-200);
  assert.equal(expandedUncertainty(measured(1, 0, 'm'), 1e-300), 0);
  assert.throws(() => expandedUncertainty(measured(1, 1e300, 'm'), 1e300), code('overflow'));
  // the other propagation functions refuse rather than lose an uncertainty, too
  assert.throws(() => convertMeasured(measured(1, 1e-300, 'nm'), 'km'), code('underflow'));
  assert.equal(addMeasured(measured(1e-200, 1e-200, 'm'), measured(1, 0, 'm')).standardUncertainty, 1e-200);
});

// ---------- independence of the inputs ----------

test('the very same Measured object cannot be both inputs of a formula for independent inputs: x+x, x-x, x*x, x/x', () => {
  const x = measured(3, 1, 'W');
  assert.throws(() => addMeasured(x, x), code('correlated_inputs'));
  assert.throws(() => subtractMeasured(x, x), code('correlated_inputs'));
  assert.throws(() => multiplyMeasured(x, x), code('correlated_inputs'));
  assert.throws(() => divideMeasured(x, x), code('correlated_inputs'));
  const t = measured(300, 1, 'K');
  assert.throws(() => temperatureDifferenceMeasured(t, t), code('correlated_inputs'));
  // an exact quantity (u = 0) is no exception: the check is about identity, not about the numbers
  const exactX = measured(2, 0, 'm');
  assert.throws(() => multiplyMeasured(exactX, exactX), code('correlated_inputs'));
  // the correct way to square or to double is the dedicated function: power (x^2) and scale (2x) use the correlated formula
  assert.deepEqual(powerMeasured(measured(3, 1, 'm'), 2), { value: 9, standardUncertainty: 6, unit: 'm2' });
  assert.deepEqual(scaleMeasured(x, 2), { value: 6, standardUncertainty: 2, unit: 'W' });
});

test('two independent measurements with equal numbers are processed normally (the independent-input formulas)', () => {
  const a = measured(3, 1, 'W');
  const b = measured(3, 1, 'W');
  assert.notEqual(a, b);
  const sum = addMeasured(a, b);
  assert.equal(sum.value, 6);
  near(sum.standardUncertainty, Math.SQRT2);
  const diff = subtractMeasured(a, b);
  assert.equal(diff.value, 0);
  near(diff.standardUncertainty, Math.SQRT2);
  const prod = multiplyMeasured(measured(3, 1, 'm'), measured(3, 1, 'm'));
  assert.equal(prod.value, 9);
  near(prod.standardUncertainty, Math.sqrt(18));
  const quot = divideMeasured(measured(3, 1, 'm'), measured(3, 1, 'm'));
  assert.equal(quot.value, 1);
  near(quot.standardUncertainty, Math.SQRT2 / 3);
});

test('identity is NOT correlation detection: a copy of the same measurement is accepted (documented limitation of M1.2)', () => {
  const x = measured(3, 1, 'W');
  const copy = { ...x };
  assert.doesNotThrow(() => subtractMeasured(x, copy as typeof x)); // treated as independent: sqrt(2), not the true 0
  assert.equal(subtractMeasured(x, copy as typeof x).value, 0);
});

// ---------- degenerate linearization ----------

test('power at a stationary point with an uncertain input is refused, not reported as u = 0', () => {
  assert.throws(() => powerMeasured(measured(0, 1, 'm'), 2), code('degenerate_linearization'));
  assert.throws(() => powerMeasured(measured(0, 1, 'm'), 3), code('degenerate_linearization'));
  assert.throws(() => powerMeasured(measured(0, 0.001, 'cm'), 4), code('degenerate_linearization'));
  assert.throws(() => powerMeasured(measured(0, 1, 's'), -1), code('out_of_range')); // 1/0 is refused separately
  assert.throws(() => powerMeasured(measured(-273.15, 1, 'degC'), 2), code('degenerate_linearization')); // 0 K exactly; diagnosed before (and regardless of) the kind lookup
});

test('...but not where the result IS exactly determined or the first order is genuinely valid', () => {
  assert.deepEqual(powerMeasured(measured(0, 0, 'm'), 2), { value: 0, standardUncertainty: 0, unit: 'm2' }); // an exact zero stays exact
  assert.deepEqual(powerMeasured(measured(0, 1, 'm'), 1), { value: 0, standardUncertainty: 1, unit: 'm' });  // linear: sensitivity 1
  assert.deepEqual(powerMeasured(measured(0, 1, 'm'), 0), { value: 1, standardUncertainty: 0, unit: 'one' }); // a constant function
  assert.deepEqual(powerMeasured(measured(2, 1, 'm'), 2), { value: 4, standardUncertainty: 4, unit: 'm2' });  // 2 x u
});

test('product of two uncertain zeros is refused; a zero factor that is exact, or a nonzero partner, is fine', () => {
  assert.throws(() => multiplyMeasured(measured(0, 1, 'V'), measured(0, 2, 'A')), code('degenerate_linearization'));
  assert.throws(() => multiplyMeasured(measured(0, 1, 'mV'), measured(0, 0.001, 'kA')), code('degenerate_linearization'));
  assert.deepEqual(multiplyMeasured(measured(0, 1, 'V'), measured(0, 0, 'A')), { value: 0, standardUncertainty: 0, unit: 'W' });   // 0 * (known exact 0)
  assert.deepEqual(multiplyMeasured(measured(0, 0, 'V'), measured(0, 2, 'A')), { value: 0, standardUncertainty: 0, unit: 'W' });
  assert.deepEqual(multiplyMeasured(measured(0, 1, 'V'), measured(5, 0, 'A')), { value: 0, standardUncertainty: 5, unit: 'W' });  // the first order is valid: |b| u(a)
  const half = multiplyMeasured(measured(0, 1, 'V'), measured(5, 0.1, 'A'));
  assert.equal(half.value, 0);
  assert.equal(half.standardUncertainty, 5);                                                                                      // a first-order result, not 0
});

test('divide has no stationary point: the numerator sensitivity 1/|b| never vanishes', () => {
  assert.deepEqual(divideMeasured(measured(0, 1, 'W'), measured(5, 0, 'm2')), { value: 0, standardUncertainty: 0.2, unit: 'W_m2' });
  assert.deepEqual(divideMeasured(measured(0, 0, 'W'), measured(5, 1, 'm2')), { value: 0, standardUncertainty: 0, unit: 'W_m2' }); // y = 0 exactly
});
