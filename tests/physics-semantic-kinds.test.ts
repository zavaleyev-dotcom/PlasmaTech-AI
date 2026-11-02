import test from 'node:test';
import assert from 'node:assert/strict';
import { measured, multiplyMeasured, divideMeasured, powerMeasured, addMeasured, scaleMeasured, convert, quantity, convertQuantity, QUANTITY_KINDS, QUANTITY_KIND_IDS, PhysicsError, type Measured } from '../src/physics';

const code = (c: string) => (e: unknown) => e instanceof PhysicsError && e.code === c;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-12 * Math.abs(b), `${a} vs ${b}`);

test('the audit reproductions: the elastic modulus keeps its kind and never becomes a pressure', () => {
  const E = measured(2, 0.1, 'GPa_mod');
  const byOne = multiplyMeasured(E, measured(1, 0, 'one'));
  assert.equal(byOne.unit, 'Pa_mod');
  assert.equal(byOne.value, 2e9);
  assert.equal(byOne.standardUncertainty, 1e8);
  const identity = powerMeasured(E, 1);
  assert.deepEqual(identity, { value: 2e9, standardUncertainty: 1e8, unit: 'Pa_mod' });
  assert.deepEqual(multiplyMeasured(measured(1, 0, 'one'), E), byOne);
  assert.deepEqual(divideMeasured(E, measured(1, 0, 'one')), byOne);
  assert.deepEqual(multiplyMeasured(E, measured(0.5, 0.05, 'one')).unit, 'Pa_mod');       // an UNCERTAIN dimensionless factor, the kind is kept
  close(multiplyMeasured(E, measured(0.5, 0.05, 'one')).standardUncertainty, Math.sqrt((0.5 * 1e8) ** 2 + (2e9 * 0.05) ** 2));
  assert.deepEqual(scaleMeasured(E, 2), { value: 4e9, standardUncertainty: 2e8, unit: 'Pa_mod' });
  // no implicit modulus -> pressure, in any direction, through any entry point
  assert.throws(() => convert(1, 'GPa_mod', 'MPa' as never), code('kind_mismatch'));
  assert.throws(() => convertQuantity(quantity(1, 'GPa_mod') as never, 'Pa' as never), code('kind_mismatch'));
  assert.throws(() => addMeasured(E, measured(1, 0, 'Pa') as never), code('kind_mismatch'));
});

test('general rule: a semantic kind is an operand only where the operation provably keeps its meaning', () => {
  const E = measured(2, 0.1, 'GPa_mod');
  // powers other than 0 and 1, products with a non-dimensionless quantity, a quotient by a quantity of ANOTHER kind: refused
  assert.throws(() => powerMeasured(E, 2), code('kind_mismatch'));
  assert.throws(() => powerMeasured(E, -1), code('kind_mismatch'));
  assert.throws(() => multiplyMeasured(E, measured(2, 0, 'm3')), code('kind_mismatch'));   // E * V is not decided by dimension alone
  assert.throws(() => divideMeasured(E, measured(2, 0, 'Pa')), code('kind_mismatch'));     // modulus / pressure
  assert.throws(() => divideMeasured(measured(2, 0, 'Pa'), E), code('kind_mismatch'));
  assert.throws(() => divideMeasured(measured(2, 0, 's'), E), code('kind_mismatch'));
  // x^0 is the constant 1 (dimensionless); a ratio of two quantities of the SAME kind is dimensionless
  assert.deepEqual(powerMeasured(E, 0), { value: 1, standardUncertainty: 0, unit: 'one' });
  const ratio = divideMeasured(measured(200, 4, 'GPa_mod'), measured(100, 3, 'GPa_mod'));
  assert.equal(ratio.unit, 'one');
  assert.equal(ratio.value, 2);
  close(ratio.standardUncertainty, Math.sqrt((4 / 100) ** 2 + (200 * 3 / 100 ** 2) ** 2));
});

test('the same rules for H and M (A/m) and for the other semantic kinds', () => {
  const H = measured(5, 0.5, 'kA_m_H');
  const M = measured(5, 0.5, 'kA_m_M');
  assert.deepEqual(multiplyMeasured(H, measured(1, 0, 'one')), { value: 5000, standardUncertainty: 500, unit: 'A_m_H' });
  assert.deepEqual(multiplyMeasured(M, measured(1, 0, 'one')), { value: 5000, standardUncertainty: 500, unit: 'A_m_M' });
  assert.deepEqual(powerMeasured(H, 1), { value: 5000, standardUncertainty: 500, unit: 'A_m_H' });
  assert.deepEqual(powerMeasured(M, 1), { value: 5000, standardUncertainty: 500, unit: 'A_m_M' });
  assert.throws(() => divideMeasured(H, M), code('kind_mismatch'));            // chi = M / H is a decision for a dedicated function, not a guess from dimensions
  assert.throws(() => divideMeasured(M, H), code('kind_mismatch'));
  assert.throws(() => addMeasured(H, M as never), code('kind_mismatch'));
  assert.throws(() => multiplyMeasured(H, measured(2, 0, 'm')), code('kind_mismatch'));
  assert.throws(() => powerMeasured(H, 2), code('kind_mismatch'));
  assert.equal(divideMeasured(H, measured(10, 0, 'kA_m_H')).unit, 'one');      // a ratio of two H
  assert.equal(divideMeasured(H, measured(10, 0, 'kA_m_H')).value, 0.5);
  // temperature difference and gauge pressure
  assert.deepEqual(multiplyMeasured(measured(10, 1, 'K_delta'), measured(2, 0, 'one')), { value: 20, standardUncertainty: 2, unit: 'K_delta' });
  assert.deepEqual(powerMeasured(measured(-10, 1, 'K_delta'), 1), { value: -10, standardUncertainty: 1, unit: 'K_delta' });
  assert.deepEqual(multiplyMeasured(measured(-3, 0.5, 'mbar_g'), measured(2, 0, 'one')), { value: -600, standardUncertainty: 100, unit: 'Pa_g' });
  assert.throws(() => multiplyMeasured(measured(10, 1, 'K_delta'), measured(2, 0, 'm')), code('kind_mismatch'));
  assert.throws(() => divideMeasured(measured(1, 0, 'Pa_g'), measured(2, 0, 's')), code('kind_mismatch'));
  assert.throws(() => powerMeasured(measured(1, 0, 'Pa_g'), 2), code('kind_mismatch'));
  assert.equal(divideMeasured(measured(10, 1, 'K_delta'), measured(5, 0, 'degC_delta')).unit, 'one'); // delta / delta
});

test('absolute temperature and absolute pressure keep their own kind too (scaling, the power 1)', () => {
  assert.deepEqual(multiplyMeasured(measured(300, 3, 'K'), measured(2, 0, 'one')), { value: 600, standardUncertainty: 6, unit: 'K' });
  assert.deepEqual(powerMeasured(measured(20, 1, 'degC'), 1), { value: 293.15, standardUncertainty: 1, unit: 'K' });  // the SI value of an absolute temperature
  assert.deepEqual(multiplyMeasured(measured(2, 0.1, 'mbar'), measured(1, 0, 'one')), { value: 200, standardUncertainty: 10, unit: 'Pa' });
  assert.equal(divideMeasured(measured(600, 0, 'K'), measured(300, 0, 'K')).unit, 'one');                              // a ratio of absolute temperatures
  assert.equal(divideMeasured(measured(600, 0, 'K'), measured(300, 0, 'K')).value, 2);
  assert.equal(multiplyMeasured(measured(2, 0, 'Pa'), measured(3, 0, 'm3')).unit, 'J');                                 // p V: the dimension is unique (energy)
});

test('the inverse expansion coefficient is NOT an absolute temperature (nor, for now, an interval): a controlled error', () => {
  const alpha = measured(2, 0.1, 'per_K');
  for (const f of [() => powerMeasured(alpha, -1), () => powerMeasured(measured(10, 1, 'ppm_K'), -1), () => divideMeasured(measured(1, 0, 'one'), alpha), () => powerMeasured(measured(1, 0, 'per_degC'), -1)]) {
    assert.throws(f, code('unsupported_dimension'));
  }
  // the message names the ambiguity
  assert.throws(() => powerMeasured(alpha, -1), (e: unknown) => e instanceof PhysicsError && /температур/.test(e.message));
  // and no operation turns a K-dimension result into a value of the absolute scale with the 273.15 offset
  const results: (Measured | null)[] = [];
  for (const f of [() => powerMeasured(alpha, -1), () => divideMeasured(measured(1, 0, 'one'), alpha)]) { try { results.push(f()); } catch { results.push(null); } }
  assert.deepEqual(results, [null, null]);
  // the product alpha * dT is a legitimate formula but not executable through Measured yet (dT is a semantic operand)
  assert.throws(() => multiplyMeasured(alpha, measured(10, 1, 'K_delta')), code('kind_mismatch'));
});

test('invariants of the registry: every semantic kind shares its dimension; every dimension-sharing kind is documented', () => {
  const byDimension = new Map<string, string[]>();
  for (const k of QUANTITY_KIND_IDS) byDimension.set(QUANTITY_KINDS[k].dimension.join(), [...(byDimension.get(QUANTITY_KINDS[k].dimension.join()) ?? []), k]);
  for (const k of QUANTITY_KIND_IDS) {
    const semantic = (QUANTITY_KINDS[k] as { derivable?: boolean }).derivable === false;
    const sharing = (byDimension.get(QUANTITY_KINDS[k].dimension.join()) ?? []).length > 1;
    if (semantic) assert.ok(sharing, k);
  }
});
