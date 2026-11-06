import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePropertyRecord, propertyToMeasured, propertyNominal, MaterialsError, type PropertyRecord, type PropertyUncertainty } from '../src/materials';
import { measured, PhysicsError } from '../src/physics';
import { densityRecord, conductivityRecord } from './materials-property-fixtures';

const withU = (uncertainty: unknown, over: Partial<PropertyRecord> = {}): PropertyRecord => conductivityRecord({ uncertainty: uncertainty as PropertyUncertainty, ...over });
const errs = (r: unknown) => validatePropertyRecord(r).issues.filter(i => i.severity === 'error').map((i): string => i.code);
const warns = (r: unknown) => validatePropertyRecord(r).issues.filter(i => i.severity === 'warning').map((i): string => i.code);
const code = (c: string) => (e: unknown) => e instanceof MaterialsError && e.code === c;

test('an unknown uncertainty is explicit and is NOT zero; the field cannot be left out', () => {
  assert.deepEqual(errs(withU({ kind: 'unknown' })), []);
  const { uncertainty: _omitted, ...withoutField } = conductivityRecord();
  void _omitted;
  assert.deepEqual(errs(withoutField), ['invalid_uncertainty']);                                                 // absence is written { kind: 'unknown' }, never left out
  assert.deepEqual(errs(withU(null)), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'unknown', u: 0 })), ['invalid_uncertainty']);                              // 'unknown' carries nothing, in particular no 0
  assert.deepEqual(errs(withU({ kind: 'zero' })), ['invalid_uncertainty']);
  assert.throws(() => propertyToMeasured(withU({ kind: 'unknown' })), code('uncertainty_not_convertible'));        // no Measured with u = 0 is ever invented for it
});

test('standard uncertainty: zero and non-zero; a zero must be declared exact by definition', () => {
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5, origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0, origin: 'exact_by_definition' })), []);
  assert.ok(warns(withU({ kind: 'standard', u: 0, origin: 'exact_by_definition' })).includes('zero_uncertainty'));
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0, origin: 'stated_in_source' })), ['invalid_uncertainty']);       // a bare zero would claim exactness
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0, origin: 'user_estimate' })), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5, origin: 'exact_by_definition' })), ['invalid_uncertainty']);
  for (const bad of [-1, NaN, Infinity, '0.5', null, undefined]) assert.deepEqual(errs(withU({ kind: 'standard', u: bad, origin: 'stated_in_source' })), ['invalid_uncertainty'], String(bad));
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5 })), ['invalid_uncertainty']);                               // the origin is required: no invented estimates
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5, origin: 'guess' })), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5, origin: 'stated_in_source', extra: 1 })), ['invalid_uncertainty']);
});

test('standard uncertainty is consistent with Measured (M1.2): the same value, the same u, the same unit', () => {
  const record = withU({ kind: 'standard', u: 0.5, origin: 'stated_in_source' });
  const m = propertyToMeasured(record);
  assert.deepEqual(m, measured(2, 0.5, 'W_mK'));
  assert.deepEqual(m, { value: 2, standardUncertainty: 0.5, unit: 'W_mK' });
  const exactRecord = withU({ kind: 'standard', u: 0, origin: 'exact_by_definition' });
  assert.deepEqual(propertyToMeasured(exactRecord), { value: 2, standardUncertainty: 0, unit: 'W_mK' });             // u = 0 is exact, as in Measured
});

test('expanded uncertainty keeps k and where k comes from; it converts to u = U / k only with k; without k it is not a standard uncertainty', () => {
  const expanded = (extra: Record<string, unknown>) => ({ kind: 'expanded', U: 1, origin: 'stated_in_source', ...extra });
  assert.deepEqual(errs(withU(expanded({ k: 2, kOrigin: 'stated_in_source' }))), []);
  assert.deepEqual(errs(withU(expanded({ k: 2, kOrigin: 'entered_by_user' }))), []);
  assert.deepEqual(errs(withU(expanded({ k: 2 }))), ['invalid_uncertainty']);                                           // k without its origin
  assert.deepEqual(errs(withU(expanded({ k: 2, kOrigin: 'folklore' }))), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU(expanded({ kOrigin: 'stated_in_source' }))), ['invalid_uncertainty']);                     // an origin of a k that is not there
  for (const bad of [0, -2, NaN, Infinity, '2']) assert.deepEqual(errs(withU(expanded({ k: bad, kOrigin: 'stated_in_source' }))), ['invalid_uncertainty'], String(bad));
  assert.deepEqual(errs(withU(expanded({ U: -1, k: 2, kOrigin: 'stated_in_source' }))), ['invalid_uncertainty']);
  const withK = withU(expanded({ U: 1, k: 2, kOrigin: 'stated_in_source' }));
  assert.deepEqual(propertyToMeasured(withK), { value: 2, standardUncertainty: 0.5, unit: 'W_mK' });                      // u = U / k, exactly
  assert.deepEqual(propertyToMeasured(withU(expanded({ U: 0.3, k: 3, kOrigin: 'entered_by_user' }))).standardUncertainty, 0.1);   // 0.3 / 3, exact decimals
  const noK = withU(expanded({}));
  assert.deepEqual(errs(noK), []);                                                                                        // allowed, but flagged: it is not a standard uncertainty
  assert.ok(warns(noK).includes('expanded_without_k'));
  assert.throws(() => propertyToMeasured(noK), code('uncertainty_not_convertible'));                                      // never silently taken as u
  assert.deepEqual(errs(withU(expanded({ U: 0 }))), ['invalid_uncertainty']);                                             // a zero U needs exact_by_definition
  assert.deepEqual(errs(withU(expanded({ U: 0, origin: 'exact_by_definition' }))), []);
});

test('bounds are limits, not a standard uncertainty: they must enclose the value, are in its unit, and never become u by themselves', () => {
  const bounds = (lower: number, upper: number, origin = 'stated_in_source') => ({ kind: 'bounds', lower, upper, origin });
  assert.deepEqual(errs(withU(bounds(1, 3))), []);
  assert.deepEqual(errs(withU(bounds(2, 2))), []);                                                                         // degenerate limits equal to the value
  assert.deepEqual(errs(withU(bounds(3, 1))), ['invalid_uncertainty']);                                                    // reversed
  assert.deepEqual(errs(withU(bounds(2.5, 3))), ['invalid_uncertainty']);                                                  // the value is outside
  assert.deepEqual(errs(withU(bounds(0, 1.5))), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU(bounds(NaN, 3))), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU(bounds(1, 3, 'exact_by_definition'))), ['invalid_uncertainty']);
  assert.deepEqual(errs(densityRecord({ uncertainty: bounds(-1, 3) as never })), ['invalid_uncertainty']);                // a negative lower limit of a density is not physical
  assert.throws(() => propertyToMeasured(withU(bounds(1, 3))), code('uncertainty_not_convertible'));
  // a half-width (3 - 1) / 2 is NOT quietly used as u either
  assert.throws(() => propertyToMeasured(withU(bounds(1.5, 2.5))), (e: unknown) => e instanceof MaterialsError && /не стандартная/.test(e.message));
});

test('a nominal value may be used without a known uncertainty, but never carries a confirmation', () => {
  const unknown = propertyNominal(conductivityRecord({ uncertainty: { kind: 'unknown' } }));
  assert.equal(unknown.quantity.value, 2);
  assert.equal(unknown.quantity.unit, 'W_mK');
  assert.equal(unknown.uncertaintyKnown, false);
  assert.equal(unknown.metrologicallyConfirmed, false);
  assert.ok(unknown.caveats.some(c => /неопределённость неизвестна/.test(c)));
  assert.ok(unknown.caveats.some(c => /не сверена с первоисточником/.test(c)));
  assert.ok(Object.isFrozen(unknown));
  const known = propertyNominal(conductivityRecord());
  assert.equal(known.uncertaintyKnown, true);
  assert.equal(known.metrologicallyConfirmed, false);                                                                      // even with a known u: nothing here confirms a measurement
  const verified = conductivityRecord({ provenance: { ...conductivityRecord().provenance, verification: { status: 'verified_against_source', verifiedBy: 'СИНТЕТИЧЕСКИЙ СВЕРЯЮЩИЙ', verifiedAt: '2000-01-02' } } });
  assert.equal(propertyNominal(verified).verification, 'verified_against_source');
  assert.equal(propertyNominal(verified).metrologicallyConfirmed, false);
  assert.ok(propertyNominal(conductivityRecord({ uncertainty: { kind: 'bounds', lower: 1, upper: 3, origin: 'stated_in_source' } })).caveats.some(c => /границы/.test(c)));
  assert.throws(() => propertyNominal(conductivityRecord({ id: 'bad' })), code('invalid_property'));
  void PhysicsError;
});
