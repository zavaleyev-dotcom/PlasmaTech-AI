import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as materials from '../src/materials';
import { validatePropertySeries, validatePropertySeriesSet, createPropertySeries, MaterialsError, MAX_OBSERVATIONS, MAX_SEGMENTS, MAX_POWER_EXPONENT, MAX_CORRELATION_SIZE, type PointSeries } from '../src/materials';
import { syntheticSystemCatalog, syntheticElement, syntheticCompound } from './materials-fixtures';
import { syntheticProvenance, kRecord } from './materials-property-fixtures';
import { bulkSeries, filmSeries, alphaSeries, obs, q, BULK, FILM } from './materials-series-fixtures';

const issues = (s: unknown, variant?: unknown) => validatePropertySeries(s, variant).issues;
const errs = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'error').map(i => i.code);
const warns = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'warning').map(i => i.code);
const infos = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'info').map(i => i.code);
const bulk = syntheticElement();
const film = syntheticCompound();

test('1. a correct series with two temperatures is valid and gets a frozen copy', () => {
  assert.deepEqual(errs(bulkSeries()), []);
  assert.deepEqual(errs(bulkSeries(), bulk), []);
  const created = createPropertySeries(bulkSeries(), bulk);
  assert.ok(Object.isFrozen(created) && Object.isFrozen(created.points) && Object.isFrozen(created.points[0].value));
  assert.throws(() => createPropertySeries(bulkSeries({ id: 'bad id' }), bulk), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_series');
  assert.ok(MAX_OBSERVATIONS === 10000 && MAX_SEGMENTS === 100 && MAX_POWER_EXPONENT === 6 && MAX_CORRELATION_SIZE === 100);
});

test('2. repeated measurements at one temperature are stored, with separate observation ids; nothing is averaged', () => {
  const series = bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1.5), obs('p3', 300, 1.2), obs('p4', 400, 2)] });
  assert.deepEqual(errs(series), []);
  assert.ok(infos(series).includes('repeats_undeclared'));                                   // a note: they are kept as they are, not averaged, not called independent
  const kept = createPropertySeries(series);
  assert.deepEqual(kept.points.map(p => p.value.value), [1, 1.5, 1.2, 2]);                   // all four stored, in the given order, unchanged
  const declared = bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g300', relation: 'same_sample_repeat' } }), obs('p2', 300, 1.5, { replicate: { group: 'g300', relation: 'independent_repeat' } }), obs('p3', 400, 2)] });
  assert.deepEqual(errs(declared), []);
  assert.ok(!infos(declared).includes('repeats_undeclared'));
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'independence_unknown' } }), obs('p2', 300, 1)] })), []);
});

test('3. no statement of independence is required to store repeats; independence is never assumed', () => {
  const unknown = bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1.1)], correlation: { kind: 'unknown' } });
  assert.deepEqual(errs(unknown), []);
  assert.deepEqual(errs(bulkSeries({ correlation: undefined as never })), ['invalid_correlation']);                       // the statement itself must be written (unknown is a statement)
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'independent' } as never })), ['invalid_correlation']);          // independence needs its own provenance
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'independent', provenance: { origin: 'stated_in_source' } } as never })), ['invalid_correlation']);   // stated_in_source needs a source
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'independent', provenance: { origin: 'stated_in_source', source: { citation: 'СИНТЕТИЧЕСКИЙ' } } } })), []);
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'independent', provenance: { origin: 'entered_by_user', note: 'СИНТЕТИЧЕСКОЕ' } } })), []);
  const description = { kind: 'declared', info: { form: 'description', text: 'СИНТЕТИЧЕСКАЯ общая систематическая составляющая' }, provenance: { origin: 'curator_derived' } } as never;
  assert.deepEqual(errs(bulkSeries({ correlation: description })), []);
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'declared', info: { form: 'description', text: '' }, provenance: { origin: 'curator_derived' } } as never })), ['invalid_correlation']);
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'declared', info: { form: 'description', text: 'x' } } as never })), ['invalid_correlation']);       // no provenance of the claim
  assert.deepEqual(errs(bulkSeries({ correlation: { kind: 'guess' } as never })), ['invalid_correlation']);
  // a stored matrix: structure only, exactly; positive semi-definiteness is neither checked nor claimed
  const matrix = (m: number[][], ids = ['p1', 'p2']) => bulkSeries({ correlation: { kind: 'declared', info: { form: 'matrix', ids, matrix: m }, provenance: { origin: 'entered_by_user' } } });
  assert.deepEqual(errs(matrix([[1, 0.5], [0.5, 1]])), []);
  assert.ok(infos(matrix([[1, 0.5], [0.5, 1]])).includes('matrix_psd_not_checked'));
  assert.deepEqual(errs(matrix([[1, 1], [1, 1]])), []);                                                                     // singular but a legal correlation matrix
  assert.deepEqual(errs(matrix([[1, 0.9], [0.9, 1]], ['p1', 'p2'])), []);
  assert.deepEqual(errs(matrix([[1, 0.5], [0.4, 1]])), ['invalid_correlation']);                                            // not symmetric
  assert.deepEqual(errs(matrix([[2, 0.5], [0.5, 1]])), ['invalid_correlation']);                                            // diagonal not 1
  assert.deepEqual(errs(matrix([[1, 1.5], [1.5, 1]])), ['invalid_correlation']);                                            // |r| > 1
  assert.deepEqual(errs(matrix([[1, 0.5, 0], [0.5, 1, 0]])), ['invalid_correlation']);                                      // not square
  assert.deepEqual(errs(matrix([[1, 0.5], [0.5, 1]], ['p1', 'p9'])), ['invalid_correlation']);                               // an id that is not an observation
  assert.deepEqual(errs(matrix([[1, 0.5], [0.5, 1]], ['p1', 'p1'])), ['invalid_correlation']);
  assert.deepEqual(errs(matrix([[1, NaN], [NaN, 1]])), ['invalid_correlation']);
  const big = Array.from({ length: MAX_CORRELATION_SIZE + 1 }, (_, i) => `p${i}`);
  assert.deepEqual(errs(matrix(Array.from({ length: big.length }, (_, i) => big.map((__, j) => (i === j ? 1 : 0))), big)).includes('invalid_correlation'), true);
});

test('4. duplicate observation ids are refused: the same id is the same observation, not a repeat', () => {
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p1', 400, 2)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p1', 300, 1)] })), ['duplicate_observation_id']);
  for (const bad of ['', 'P1', 'p 1', '-p', 'p--1', 5, undefined, 'x'.repeat(65)]) assert.ok(errs(bulkSeries({ points: [obs(bad as never, 300, 1), obs('p2', 400, 2)] })).includes('invalid_observation'), String(bad));
});

test('5. equal values of different observations are NOT duplicates; the same declared origin at one temperature is only a warning', () => {
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1), obs('p3', 300, 1)] })), []);                // equal numbers, three observations
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { run: 'r1' }), obs('p2', 300, 1, { run: 'r1' })] })), []);       // the same run alone does not identify an observation
  const locator = { table: 'T1', page: '3' };
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { locator }), obs('p2', 300, 1, { locator })] })), []);            // the same locator alone neither
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { run: 'r1', locator }), obs('p2', 300, 1, { run: 'r2', locator })] })), []);       // different runs
  const sameOrigin = bulkSeries({ points: [obs('p1', 300, 1, { run: 'r1', locator }), obs('p2', 300, 1, { run: 'r1', locator: { page: '3', table: 'T1' } })] });
  assert.deepEqual(errs(sameOrigin), []);                                                                                           // same run, same place, same temperature, same value: STORED
  assert.ok(warns(sameOrigin).includes('possible_duplicate_observation'));                                                          // only a warning that asks for a look
  const otherValue = bulkSeries({ points: [obs('p1', 300, 1, { run: 'r1', locator }), obs('p2', 300, 9, { run: 'r1', locator })] });
  assert.deepEqual(errs(otherValue), []);                                                                                           // another value at the same declared origin: stored too
  assert.ok(warns(otherValue).includes('possible_duplicate_observation'));
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { run: 'r1', locator }), obs('p2', 400, 1, { run: 'r1', locator })] })), []);                                                   // another temperature
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'same_sample_repeat' } }), obs('p2', 300, 1, { replicate: { group: 'g', relation: 'independent_repeat' } })] })), []);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'independence_unknown' } }), obs('p2', 400, 1, { replicate: { group: 'g', relation: 'independence_unknown' } })] })), ['invalid_replicate']);   // a group of repeats is at ONE temperature
  assert.ok(warns(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'independence_unknown' } }), obs('p2', 400, 1)] })).includes('invalid_replicate'));   // a group of one
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'maybe' as never } }), obs('p2', 400, 1)] })), ['invalid_replicate']);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { run: '' }), obs('p2', 400, 1)] })), ['invalid_observation']);
});

test('6. K and degC are accepted and compared exactly; mixed temperature units are allowed, mixed value units are not', () => {
  const celsius = bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(26.85, 'degC') }, { ...obs('p2', 0, 2), temperature: q(126.85, 'degC') }] });
  assert.deepEqual(errs(celsius), []);
  // 26.85 degC is exactly 300 K: the same temperature (a repeat), no matter the scale
  const sameT = bulkSeries({ points: [obs('p1', 300, 1), { ...obs('p2', 0, 2), temperature: q(26.85, 'degC') }] });
  assert.deepEqual(errs(sameT), []);
  assert.ok(infos(sameT).includes('repeats_undeclared'));
  const acrossScales = bulkSeries({ points: [obs('p1', 300, 1, { run: 'r', locator: { table: 'T' } }), { ...obs('p2', 0, 1), temperature: q(26.85, 'degC'), run: 'r', locator: { table: 'T' } }] });
  assert.deepEqual(errs(acrossScales), []);                                                                                         // ... across scales the warning is the same, nothing is refused
  assert.ok(warns(acrossScales).includes('possible_duplicate_observation'));
  const mixedValueUnits = bulkSeries({ points: [obs('p1', 300, 1), { ...obs('p2', 400, 0.02), value: { type: 'scalar', value: 0.02, unit: 'W_cmK' } }] });
  assert.deepEqual(errs(mixedValueUnits), ['mixed_units']);
});

test('7. a temperature below absolute zero is refused', () => {
  assert.ok(errs(bulkSeries({ points: [obs('p1', -5, 1), obs('p2', 400, 2)] })).includes('invalid_quantity'));
  assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(-300, 'degC') }, obs('p2', 400, 2)] })).includes('invalid_quantity'));
  assert.deepEqual(errs(bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(-273.15, 'degC') }, obs('p2', 400, 2)] })), []);          // exactly 0 K
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 0, 1), obs('p2', 400, 2)] })), []);
});

test('8. a temperature INTERVAL (K_delta) is not an absolute temperature', () => {
  assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(10, 'K_delta') }, obs('p2', 400, 2)] })).includes('invalid_quantity'));
  assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(10, 'degC_delta') }, obs('p2', 400, 2)] })).includes('invalid_quantity'));
  assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 0, 1), temperature: q(300, 'W_mK') }, obs('p2', 400, 2)] })).includes('invalid_quantity'));
  // an interval-valued condition is refused in the common conditions as well
  assert.ok(errs(alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(10, 'K_delta') })).includes('invalid_quantity'));
});

test('9. a unit of another kind, an unknown unit, a malformed value are refused', () => {
  const withValue = (value: unknown) => bulkSeries({ points: [{ ...obs('p1', 300, 1), value: value as never }, obs('p2', 400, 2)] });
  assert.ok(errs(withValue({ type: 'scalar', value: 1, unit: 'kg_m3' })).includes('invalid_quantity'));
  assert.ok(errs(withValue({ type: 'scalar', value: 1, unit: 'nope' })).includes('invalid_quantity'));
  assert.ok(errs(withValue({ type: 'scalar', value: -1, unit: 'W_mK' })).includes('invalid_quantity'));                       // below the physical limit of the kind
  assert.ok(errs(withValue({ type: 'tensor2', value: 1, unit: 'W_mK' })).includes('invalid_observation'));
  assert.ok(errs(withValue(5)).includes('invalid_observation'));
  assert.ok(errs(withValue({ type: 'scalar', value: 1, unit: 'W_mK', extra: 1 })).includes('invalid_observation'));
  assert.ok(errs(bulkSeries({ property: 'hardness' })).includes('unknown_property'));
  assert.ok(errs(bulkSeries({ property: 'molar_mass', points: [{ ...obs('p1', 300, 1), value: { type: 'scalar', value: 1, unit: 'kg_mol' } }, { ...obs('p2', 400, 1), value: { type: 'scalar', value: 1, unit: 'kg_mol' } }] })).includes('series_property_unsupported'));   // not a function of temperature in this model
});

test('10. NaN and Infinity are refused', () => {
  for (const bad of [NaN, Infinity, -Infinity, '1' as never, null as never]) {
    assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 300, 1), value: { type: 'scalar', value: bad, unit: 'W_mK' } }, obs('p2', 400, 2)] })).includes('invalid_quantity'), String(bad));
    assert.ok(errs(bulkSeries({ points: [{ ...obs('p1', 300, 1), temperature: q(bad, 'K') }, obs('p2', 400, 2)] })).includes('invalid_quantity'), `temperature ${String(bad)}`);
  }
});

test('11. the uncertainty of every observation is explicit: missing and damaged statements are refused; unknown is not zero', () => {
  const withU = (u: unknown) => bulkSeries({ points: [{ ...obs('p1', 300, 1), uncertainty: u as never }, obs('p2', 400, 2)] });
  assert.deepEqual(errs(withU({ kind: 'unknown' })), []);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5, origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(withU({ kind: 'expanded', U: 1, k: 2, kOrigin: 'stated_in_source', origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(withU({ kind: 'bounds', lower: 0.5, upper: 1.5, origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(withU(undefined)), ['invalid_uncertainty']);                                                         // missing
  assert.deepEqual(errs(withU(null)), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 'bad', origin: 'stated_in_source' })), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: -1, origin: 'stated_in_source' })), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0, origin: 'stated_in_source' })), ['invalid_uncertainty']);              // a bare zero would claim exactness
  assert.deepEqual(errs(withU({ kind: 'bounds', lower: 2, upper: 3, origin: 'stated_in_source' })), ['invalid_uncertainty']);  // the value 1 is outside the limits
  assert.deepEqual(errs(withU({ kind: 'unknown', u: 0 })), ['invalid_uncertainty']);
  assert.deepEqual(errs(withU({ kind: 'standard', u: 0.5 })), ['invalid_uncertainty']);                                        // no origin
  // nothing is propagated or combined: the series keeps each statement exactly as written, and there is no function that does
  const kept = createPropertySeries(bulkSeries({ points: [{ ...obs('p1', 300, 1), uncertainty: { kind: 'standard', u: 0.5, origin: 'stated_in_source' } }, obs('p2', 400, 2)] }));
  assert.deepEqual(kept.points[0].uncertainty, { kind: 'standard', u: 0.5, origin: 'stated_in_source' });
  assert.deepEqual(kept.points[1].uncertainty, { kind: 'unknown' });
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /propagat|interpolat|extrapolat|average|combine|evaluate|select|choose|pick|best|prefer/i.test(n)), names.join());
  assert.deepEqual(errs(bulkSeries({ uncertaintyScope: 'fit_residual' })), ['invalid_series']);                                // the fit scopes belong to analytic series
  assert.deepEqual(errs(bulkSeries({ uncertaintyScope: 'unspecified' })), []);
});

test('12. an incorrect material form: the variant is checked, a damaged one is not read as "bulk"', () => {
  const damaged = (form: unknown) => ({ ...bulk, form } as unknown);
  for (const form of [null, undefined, {}, { kind: 'brick' }, 'bulk', 5]) {
    const result = validatePropertySeries(filmSeries(), damaged(form));
    assert.equal(result.ok, false, JSON.stringify(form));
    assert.ok(result.issues.some(i => i.code === 'invalid_material'), JSON.stringify(form));
  }
  assert.equal(validatePropertySeries(bulkSeries(), { id: BULK }).ok, false);
  assert.equal(validatePropertySeries(bulkSeries(), 5).ok, false);
  assert.ok(errs(bulkSeries(), syntheticCompound()).includes('missing_reference'));                                             // another variant than the series refers to
  assert.deepEqual(errs(bulkSeries(), null), []);                                                                              // no variant given: not checked, not assumed
});

test('13. a film series without the required conditions is refused; with them it is accepted; bulk needs only the temperature axis', () => {
  const noConditions = filmSeries({ commonConditions: {} });
  assert.deepEqual(errs(noConditions, film), ['missing_condition', 'missing_condition']);                                      // thickness and direction (the M1.3.2 rule), reported once for ALL observations
  assert.match(issues(noConditions, film).find(i => i.code === 'missing_condition')!.message, /все наблюдения/);
  assert.deepEqual(errs(filmSeries({ commonConditions: { thickness: q(100, 'nm') } as never }), film), ['missing_condition']);
  assert.deepEqual(errs(filmSeries(), film), []);
  assert.deepEqual(errs(bulkSeries({ commonConditions: {} }), bulk), []);
  // the temperature is the axis: it cannot also be a common condition, and the film conditions are not borrowed from a bulk series
  assert.ok(errs(bulkSeries({ commonConditions: { temperature: q(300, 'K') } as never })).includes('invalid_condition'));
  assert.ok(errs(bulkSeries({ commonConditions: { temperatureRange: { min: q(300, 'K'), max: q(400, 'K') } } as never })).includes('invalid_condition'));
  assert.ok(errs(bulkSeries({ commonConditions: { heatCapacityMode: 'isobaric' } as never }), bulk).includes('condition_not_allowed'));   // a condition that does not apply to the property
  assert.ok(errs(bulkSeries({ commonConditions: 5 as never })).includes('invalid_condition'));
  // a series on the film variant is never judged by the conditions of a bulk one
  assert.deepEqual(errs(bulkSeries({ variant: FILM, commonConditions: {} }), film), ['missing_condition', 'missing_condition']);
});

test('14. the mean expansion coefficient keeps ONE reference temperature, different from every observation temperature', () => {
  const mean = (reference: number, kelvin: number[]) => alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(reference, 'K') }, kelvin);
  assert.deepEqual(errs(mean(300, [350, 400]), bulk), []);
  assert.deepEqual(errs(mean(300, [200, 400]), bulk), []);                                                                      // averaged downwards is still an interval
  const atReference = mean(300, [300, 400]);
  assert.deepEqual(errs(atReference, bulk), ['invalid_condition']);                                                              // an observation AT the reference: no interval, not only the first point is checked
  assert.deepEqual(errs(mean(300, [350, 300]), bulk), ['invalid_condition']);                                                    // the LAST observation
  assert.match(issues(mean(300, [350, 400, 300, 500]), bulk).find(i => i.code === 'invalid_condition')!.message, /p3/);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(26.85, 'degC') }, [300, 400]), bulk), ['invalid_condition']);   // the same temperature across scales
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean' }, [350, 400]), bulk), ['missing_condition']);                // no reference temperature
  assert.deepEqual(errs(alphaSeries({ referenceTemperature: q(300, 'K') }, [350, 400]), bulk), ['missing_condition']);          // which coefficient?
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'tangent' }, [350, 400]), bulk), []);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'tangent', referenceTemperature: q(300, 'K') }, [350, 400]), bulk), ['condition_not_allowed']);
  // a series is ONE function of the temperature: a reference temperature that varies is a different series (it cannot be written, it is a single common condition)
  assert.deepEqual(errs({ ...mean(300, [350, 400]), points: [{ ...alphaSeries({}).points[0], referenceTemperature: q(250, 'K') }, alphaSeries({}).points[1]] }).includes('invalid_observation'), true);
});

test('15. the history and the direction of the sweep must agree with the stored order; the order is never sorted', () => {
  const heating = (points: PointSeries['points']) => bulkSeries({ points, applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'heating' } });
  const cooling = (points: PointSeries['points']) => bulkSeries({ points, applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'cooling' } });
  assert.deepEqual(errs(heating([obs('p1', 300, 1), obs('p2', 350, 2), obs('p3', 350, 2.1), obs('p4', 400, 3)])), []);          // equal temperatures are allowed
  assert.deepEqual(errs(cooling([obs('p1', 400, 3), obs('p2', 350, 2), obs('p3', 300, 1)])), []);
  assert.deepEqual(errs(heating([obs('p1', 400, 3), obs('p2', 300, 1)])), ['sweep_inconsistent']);                              // declared heating, the order goes down
  assert.deepEqual(errs(cooling([obs('p1', 300, 1), obs('p2', 400, 3)])), ['sweep_inconsistent']);
  assert.match(issues(heating([obs('p1', 300, 1), obs('p2', 400, 3), obs('p3', 350, 2)])).find(i => i.code === 'sweep_inconsistent')!.message, /p2 → p3/);
  // the stored order is kept: a descending series is stored descending, never re-ordered to ascending
  assert.deepEqual(createPropertySeries(cooling([obs('p1', 400, 3), obs('p2', 300, 1)])).points.map(p => p.id), ['p1', 'p2']);
  // a run that goes up and down: a warning unless the sweep is described, and always a note of possible incomparability
  const upDown = bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 400, 3), obs('p3', 300, 1.1)] });
  assert.deepEqual(errs(upDown), []);
  assert.ok(warns(upDown).includes('sweep_not_described'));
  assert.ok(warns(upDown).includes('potential_incomparability'));
  assert.ok(!warns(bulkSeries({ points: upDown.points, applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'mixed' } })).includes('sweep_not_described'));
  assert.deepEqual(errs(bulkSeries({ points: upDown.points, applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'isothermal_steps' } })), []);
  // thermal history against itself
  const history = (thermalHistory: unknown) => bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, thermalHistory } as never });
  assert.deepEqual(errs(history({ state: 'as_deposited', cycles: 0 })), []);
  assert.deepEqual(errs(history({ state: 'as_deposited', cycles: 3 })), ['history_inconsistent']);
  assert.deepEqual(errs(history({ state: 'as_deposited', annealing: { temperature: q(500, 'K') } })), ['history_inconsistent']);
  assert.deepEqual(errs(history({ state: 'cycled', cycles: 0 })), ['history_inconsistent']);
  assert.deepEqual(errs(history({ state: 'cycled', cycles: 5 })), []);
  assert.deepEqual(errs(history({ state: 'cycled', cycles: 'unknown' })), []);
  assert.deepEqual(errs(history({ state: 'annealed', annealing: { temperature: q(500, 'K'), duration: q(1, 'h'), atmosphere: 'СИНТЕТИЧЕСКАЯ' } })), []);
  assert.deepEqual(errs(history({ state: 'annealed', annealing: { temperature: q(10, 'K_delta') } })), ['invalid_quantity']);
  assert.deepEqual(errs(history({ state: 'warm' })), ['invalid_applicability']);
  assert.deepEqual(errs(history({ state: 'cycled', cycles: -1 })), ['invalid_applicability']);
  assert.deepEqual(errs(bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'sideways' } as never })), ['invalid_applicability']);
});

test('E. phases, events, stability: information is kept; silence is not stability; an observation outside the phase range is a warning, not a rejection', () => {
  const ev = (effect: string, temperature = 350, kind = 'phase_transition') => ({ kind, temperature: q(temperature, 'K'), effect, source: { citation: 'СИНТЕТИЧЕСКИЙ' } });
  const withEvents = (events: unknown[]) => bulkSeries({ applicability: { events, stability: { kind: 'not_stated' } } as never });
  assert.deepEqual(errs(withEvents([ev('discontinuity')])), []);
  assert.ok(infos(withEvents([ev('discontinuity')])).includes('interval_crosses_event'));
  assert.ok(warns(withEvents([ev('irreversible_change', 350, 'oxidation_or_reaction')])).includes('irreversible_change_in_domain'));
  assert.ok(warns(withEvents([ev('unknown')])).includes('event_effect_unknown'));
  assert.ok(warns(withEvents([ev('discontinuity')])).includes('potential_incomparability'));
  assert.deepEqual(errs(withEvents([ev('range_ends_before', 350)])), ['event_contradicts_domain']);                              // data above the stated limit: contradiction inside the series
  assert.deepEqual(errs(withEvents([ev('range_ends_before', 500)])), []);
  assert.deepEqual(warns(withEvents([ev('discontinuity', 900)])), []);                                                           // an event outside the observed range does not matter
  assert.deepEqual(errs(withEvents([{ ...ev('discontinuity'), source: undefined }])), ['invalid_applicability']);                // an event without a source is refused
  assert.deepEqual(errs(withEvents([{ kind: 'phase_transition', effect: 'discontinuity', source: { citation: 'x' } }])), ['invalid_applicability']);   // neither temperature nor range
  assert.deepEqual(errs(withEvents([{ ...ev('discontinuity'), range: { min: q(300, 'K'), max: q(400, 'K') } }])), ['invalid_applicability']);        // both
  assert.deepEqual(errs(withEvents([{ kind: 'film_degradation', range: { min: q(400, 'K'), max: q(300, 'K') }, effect: 'unknown', source: { citation: 'x' } }])), ['invalid_applicability']);
  assert.deepEqual(errs(withEvents([ev('vanishing')])), ['invalid_applicability']);
  assert.deepEqual(errs(withEvents([ev('discontinuity', 350, 'melting_of_dreams')])), ['invalid_applicability']);
  assert.deepEqual(errs(withEvents([{ kind: 'delamination', range: { min: q(320, 'K'), max: q(380, 'K') }, effect: 'irreversible_change', source: { citation: 'x' } }])), []);
  // silence is not stability
  assert.ok(infos(bulkSeries(), bulk).includes('stability_not_stated'));
  assert.ok(warns(filmSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, thermalHistory: { state: 'as_deposited' }, sweepDirection: 'heating' } }), film).includes('stability_not_stated'));
  assert.ok(!warns(filmSeries(), film).includes('stability_not_stated'));                                                        // a sourced statement of stability
  assert.deepEqual(errs(bulkSeries({ applicability: { events: [], stability: { kind: 'stated_stable_over_range' } } as never })), ['invalid_applicability']);
  assert.deepEqual(errs(bulkSeries({ applicability: undefined as never })), ['invalid_applicability']);
  assert.deepEqual(errs(bulkSeries({ applicability: { events: [] } as never })), ['invalid_applicability']);
  // a film without history and sweep: warnings, not errors
  const bare = filmSeries({ applicability: { events: [], stability: { kind: 'stated_stable_over_range', source: { citation: 'x' } } } });
  assert.deepEqual(errs(bare, film), []);
  assert.ok(warns(bare, film).includes('thermal_history_not_stated'));
  assert.ok(warns(bare, film).includes('sweep_direction_not_stated'));
  assert.ok(!warns(bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' } } }), bulk).includes('thermal_history_not_stated'));
  // phase range of the variant
  const bounded = (source?: { citation: string }) => ({ ...bulk, phase: { state: 'solid', order: 'crystalline', stableRange: { min: q(350, 'K'), max: q(500, 'K') }, ...(source ? { source } : {}) } });
  assert.ok(infos(bulkSeries(), bulk).includes('phase_range_not_stated'));
  assert.deepEqual(warns(bulkSeries({ points: [obs('p1', 400, 1), obs('p2', 450, 2)] }), bounded()), []);
  const outside = bulkSeries();                                                                                                  // 300 K and 400 K: 300 K is below the stable range
  assert.deepEqual(errs(outside, bounded()), []);                                                                                // NOT rejected on this ground alone
  assert.deepEqual(errs(outside, bounded({ citation: 'СИНТЕТИЧЕСКИЙ' })), []);                                                   // not even when the phase statement has a source
  assert.ok(warns(outside, bounded()).includes('beyond_stable_range'));
  assert.match(issues(outside, bounded({ citation: 'x' })).find(i => i.code === 'beyond_stable_range')!.message, /подтверждено источником/);
  assert.match(issues(outside, bounded()).find(i => i.code === 'beyond_stable_range')!.message, /без источника/);
  const declared = bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, phaseContext: { relation: 'metastable_beyond_range', source: { citation: 'СИНТЕТИЧЕСКИЙ' } } } });
  assert.ok(infos(declared, bounded()).includes('beyond_stable_range'));
  assert.ok(!warns(declared, bounded()).includes('beyond_stable_range'));
  assert.deepEqual(errs(bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, phaseContext: { relation: 'wherever' } } as never })), ['invalid_applicability']);
});

test('16. damaged nested objects give a report, never an exception', () => {
  const garbage: unknown[] = [null, undefined, 5, 'x', [], {}, true, NaN];
  const paths = (value: unknown, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] => {
    if (value !== null && typeof value === 'object') for (const key of Object.keys(value)) { const p = [...prefix, Array.isArray(value) ? Number(key) : key]; out.push(p); paths((value as Record<string, unknown>)[key], p, out); }
    return out;
  };
  const setAt = (root: unknown, path: (string | number)[], value: unknown): void => { let n = root as Record<string | number, unknown>; for (const k of path.slice(0, -1)) n = n[k] as Record<string | number, unknown>; n[path[path.length - 1]] = value; };
  const rich = filmSeries({
    points: [obs('p1', 300, 1, { run: 'r', locator: { table: 'T' }, replicate: { group: 'g', relation: 'independence_unknown' } }), obs('p2', 300, 1.1, { replicate: { group: 'g', relation: 'same_sample_repeat' } }), obs('p3', 400, 2)],
    correlation: { kind: 'declared', info: { form: 'matrix', ids: ['p1', 'p2'], matrix: [[1, 0.5], [0.5, 1]] }, provenance: { origin: 'stated_in_source', source: { citation: 'x' } } },
    applicability: { events: [{ kind: 'phase_transition', range: { min: q(310, 'K'), max: q(320, 'K') }, effect: 'unknown', source: { citation: 'x' } }], stability: { kind: 'stated_stable_over_range', source: { citation: 'x' } }, phaseContext: { relation: 'within_stable_range' }, thermalHistory: { state: 'annealed', annealing: { temperature: q(500, 'K'), duration: q(1, 'h') }, cycles: 2 }, sweepDirection: 'mixed' },
    supersedes: 'fixture:series-old',
  });
  const variant = syntheticSystemCatalog().variants.find(v => v.id === FILM);
  const all = paths(rich);
  assert.ok(all.length > 60);
  for (const path of all) for (const bad of garbage) {
    const copy = structuredClone(rich);
    setAt(copy, path, bad);
    assert.doesNotThrow(() => validatePropertySeries(copy), `${path.join('.')} = ${String(bad)}`);
    assert.doesNotThrow(() => validatePropertySeries(copy, variant), `${path.join('.')} = ${String(bad)} (variant)`);
    assert.doesNotThrow(() => validatePropertySeriesSet([copy, copy], syntheticSystemCatalog()), `${path.join('.')} = ${String(bad)} (set)`);
  }
  for (const bad of [null, undefined, 5, 'x', [], {}, [null]]) { assert.doesNotThrow(() => validatePropertySeries(bad)); assert.equal(validatePropertySeries(bad).ok, false, JSON.stringify(bad)); }
  assert.doesNotThrow(() => validatePropertySeriesSet(null, null));
  assert.equal(validatePropertySeriesSet('x', null).ok, false);
});

test('17. unknown additional fields are refused at every level', () => {
  const extra = { physicalProperty: 123 };
  const cases: [string, PointSeries][] = [
    ['series', { ...bulkSeries(), ...extra } as never],
    ['observation', bulkSeries({ points: [{ ...obs('p1', 300, 1), ...extra }, obs('p2', 400, 2)] })],
    ['value', bulkSeries({ points: [{ ...obs('p1', 300, 1), value: { type: 'scalar', value: 1, unit: 'W_mK', ...extra } }, obs('p2', 400, 2)] as never })],
    ['temperature (a Quantity)', bulkSeries({ points: [{ ...obs('p1', 300, 1), temperature: { value: 300, unit: 'K', ...extra } }, obs('p2', 400, 2)] as never })],
    ['uncertainty', bulkSeries({ points: [{ ...obs('p1', 300, 1), uncertainty: { kind: 'unknown', ...extra } }, obs('p2', 400, 2)] as never })],
    ['replicate', bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'independence_unknown', ...extra } as never }), obs('p2', 300, 2)] })],
    ['locator', bulkSeries({ points: [obs('p1', 300, 1, { locator: { table: 'T', ...extra } as never }), obs('p2', 400, 2)] })],
    ['common conditions', bulkSeries({ commonConditions: { ...extra } as never })],
    ['provenance', bulkSeries({ provenance: { ...syntheticProvenance(), ...extra } as never })],
    ['correlation', bulkSeries({ correlation: { kind: 'unknown', ...extra } as never })],
    ['applicability', bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, ...extra } as never })],
    ['stability', bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated', ...extra } } as never })],
    ['thermal history', bulkSeries({ applicability: { events: [], stability: { kind: 'not_stated' }, thermalHistory: { state: 'unknown', ...extra } } as never })],
    ['event', bulkSeries({ applicability: { events: [{ kind: 'phase_transition', temperature: q(900, 'K'), effect: 'unknown', source: { citation: 'x' }, ...extra }], stability: { kind: 'not_stated' } } as never })],
  ];
  for (const [name, series] of cases) {
    const before = JSON.stringify(series);
    assert.equal(validatePropertySeries(series).ok, false, name);
    assert.equal(JSON.stringify(series), before, `${name}: not modified`);
    assert.throws(() => createPropertySeries(series), MaterialsError, name);
  }
  assert.equal(validatePropertySeries(bulkSeries()).ok, true);
});

test('the analytic kind is declared in the contract but refused until implemented; the length limits are enforced', () => {
  for (const kind of ['analytic']) assert.deepEqual(errs({ ...bulkSeries(), kind }), ['unsupported_series_kind'], kind);
  assert.deepEqual(errs({ ...bulkSeries(), kind: 'curve' }), ['invalid_series']);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1)] })), ['series_too_short']);
  assert.deepEqual(errs(bulkSeries({ points: [] })), ['series_too_short']);
  const many = Array.from({ length: MAX_OBSERVATIONS + 1 }, (_, i) => obs(`p${i}`, 300 + (i % 100), 1 + i * 0.001));
  assert.ok(errs(bulkSeries({ points: many })).includes('series_too_long'));
  const atLimit = Array.from({ length: MAX_OBSERVATIONS }, (_, i) => obs(`p${i}`, 300 + (i % 100), 1));
  assert.ok(!errs(bulkSeries({ points: atLimit })).includes('series_too_long'));
});

test('ids, versions and replacement: one id space, the same kind, variant and property, a higher version, one replacement, no cycles', () => {
  const catalog = syntheticSystemCatalog();
  const a = bulkSeries({ id: 'fixture:series-a' });
  const b = bulkSeries({ id: 'fixture:series-b', version: 2, supersedes: 'fixture:series-a' });
  const setErrs = (list: unknown, records?: unknown) => validatePropertySeriesSet(list, catalog, records).issues.filter(i => i.severity === 'error').map(i => i.code);
  assert.deepEqual(setErrs([a, b]), []);
  assert.deepEqual(setErrs([a, { ...a }]), ['duplicate_id']);
  assert.deepEqual(setErrs([bulkSeries({ variant: 'fixture:ghost' })]), ['missing_reference']);
  assert.deepEqual(setErrs([b]), ['supersedes_invalid']);                                                                         // the replaced series is missing
  assert.deepEqual(setErrs([a, { ...b, version: 1 }]), ['supersedes_invalid']);                                                   // not a higher version
  assert.ok(setErrs([a, { ...b, variant: FILM, commonConditions: filmSeries().commonConditions }]).includes('supersedes_invalid'));   // another variant
  assert.ok(setErrs([a, { ...b, property: 'electrical_resistivity', points: [{ ...obs('p1', 300, 1), value: { type: 'scalar', value: 1, unit: 'Ohm_m' } }, { ...obs('p2', 400, 2), value: { type: 'scalar', value: 2, unit: 'Ohm_m' } }] }]).includes('supersedes_invalid'));   // another property
  assert.deepEqual(setErrs([a, b, { ...b, id: 'fixture:series-b2' }]), ['supersession_fork']);
  const cyc1 = bulkSeries({ id: 'fixture:series-c1', version: 2, supersedes: 'fixture:series-c2' });
  const cyc2 = bulkSeries({ id: 'fixture:series-c2', version: 1, supersedes: 'fixture:series-c1' });
  assert.ok(setErrs([cyc1, cyc2]).includes('supersedes_invalid'));
  assert.deepEqual([...new Set(setErrs([{ ...a, supersedes: 'fixture:series-a' }]))], ['supersedes_invalid']);                  // a series cannot replace itself
  // one id space with the records
  assert.deepEqual(setErrs([a], [kRecord('fixture:series-a', BULK, 2)]), ['duplicate_id']);
  assert.deepEqual(setErrs([a], [kRecord('fixture:rec-other', BULK, 2)]), []);
  // a shipped series cannot stand on a variant of another namespace; a user's series follows the user_input rule
  assert.ok(setErrs([bulkSeries({ id: 'ref:series-a' })]).includes('namespace_mismatch'));
  const user = bulkSeries({ id: 'user:series-a', provenance: { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } } as never });
  assert.deepEqual(setErrs([user]), []);
  assert.ok(setErrs([bulkSeries({ id: 'user:series-b' })]).includes('namespace_mismatch'));
  // version and date
  for (const bad of [0, -1, 1.5, '1', NaN, 1000001]) assert.ok(errs(bulkSeries({ version: bad as never })).includes('invalid_version'), String(bad));
  for (const bad of ['2000-02-30', '2000-1-1', '', 5]) assert.ok(errs(bulkSeries({ updatedAt: bad as never })).includes('invalid_version'), String(bad));
  // the series are not merged: a scalar record with the same variant and property stays a different thing
  assert.equal(validatePropertySeriesSet([a], catalog, [kRecord('fixture:rec-1', BULK, 2)]).ok, true);
  void bulk; void film;
});

test('18. the series modules contain no numerical reference data and no computation of property values', () => {
  const dir = join(__dirname, '../src/materials');
  const files = readdirSync(dir).filter(f => /^series(-[a-z]+)?\.ts$/.test(f));
  assert.deepEqual(files.sort(), ['series-parts.ts', 'series-table.ts', 'series-types.ts', 'series.ts']);
  for (const file of files) {
    const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""').replace(/\/\^\[[^\n]*\$\//g, '');   // strings and the id regex literal are not data
    const numbers = [...code.matchAll(/(?<![\w.])\d[\d_.eE]*/g)].map(m => m[0]);
    for (const n of numbers) assert.ok(['0', '1', '2', '5', '64', '100', '10000', '1000000', '6'].includes(n), `${file}: unexpected numeric literal ${n}`);
    assert.ok(!/\b(Math\.(sqrt|pow|exp|log|hypot)|interpolate|extrapolate|average|mean\()/.test(code), `${file}: computation of values`);
  }
});

test('tangent and mean expansion coefficients: the mean one keeps a single reference temperature for the WHOLE series, the tangent one has none', () => {
  const tangent = alphaSeries({ expansionDefinition: 'tangent' }, [350, 400, 450]);
  assert.deepEqual(errs(tangent, bulk), []);
  const mean = alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') }, [350, 400, 450]);
  assert.deepEqual(errs(mean, bulk), []);
  assert.deepEqual(createPropertySeries(mean, bulk).commonConditions, { expansionDefinition: 'mean', referenceTemperature: { value: 300, unit: 'K' } });
  // the reference temperature is a COMMON condition: there is no per-observation reference temperature in the structure
  assert.ok(errs({ ...mean, points: [{ ...mean.points[0], referenceTemperature: q(250, 'K') }, mean.points[1]] }).includes('invalid_observation'));
});

test('repeats with different runs are kept side by side and the series is not a scalar record: the scalar record stays a separate thing', () => {
  const series = bulkSeries({ points: [obs('p1', 300, 1, { run: 'run-a', replicate: { group: 'g300', relation: 'independent_repeat' } }), obs('p2', 300, 1, { run: 'run-b', replicate: { group: 'g300', relation: 'independent_repeat' } }), obs('p3', 400, 2, { run: 'run-a' })] });
  assert.deepEqual(errs(series, bulk), []);
  const kept = createPropertySeries(series, bulk);
  assert.deepEqual(kept.points.map(p => [p.id, p.run, p.value.value]), [['p1', 'run-a', 1], ['p2', 'run-b', 1], ['p3', 'run-a', 2]]);
  assert.equal(validatePropertySeries(kRecord('fixture:rec-1', BULK, 2)).ok, false);                                       // a record is not a series
  assert.deepEqual(errs(kRecord('fixture:rec-1', BULK, 2)), ['invalid_series']);
});

// ---------- F1: repeated observations are kept; only the id identifies an observation ----------

test('F1: the audit reproduction - equal run, locator, temperature, value, uncertainty and replicate group, but different ids: both observations are stored', () => {
  const extra = { run: 'run-1', locator: { table: 'Table 1' }, replicate: { group: 'g', relation: 'same_sample_repeat' as const } };
  const series = bulkSeries({ points: [obs('p1', 300, 1, extra), obs('p2', 300, 1, extra)] });
  const report = validatePropertySeries(series);
  assert.equal(report.ok, true);
  assert.deepEqual(errs(series), []);
  assert.ok(warns(series).includes('possible_duplicate_observation'));                         // a warning that asks for a look - not an error
  const kept = createPropertySeries(series);                                                    // not refused: a frozen copy with BOTH observations
  assert.deepEqual(kept.points.map(p => p.id), ['p1', 'p2']);
  assert.equal(kept.points.length, 2);
});

test('F1: the only identity is Observation.id; no error from run, locator, temperature, value or uncertainty, equal or not', () => {
  // the SAME id: an error, whatever else is equal or different
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p1', 300, 1)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { run: 'a' }), obs('p1', 400, 9, { run: 'b' })] })), ['duplicate_observation_id']);
  // different ids: stored, in every combination of equal and different details
  const u = { kind: 'standard' as const, u: 0.5, origin: 'stated_in_source' as const };
  const cases: [string, ReturnType<typeof obs>, ReturnType<typeof obs>][] = [
    ['everything equal', obs('p1', 300, 1, { run: 'r', locator: { table: 'T' }, uncertainty: u }), obs('p2', 300, 1, { run: 'r', locator: { table: 'T' }, uncertainty: u })],
    ['same temperature, different values', obs('p1', 300, 1), obs('p2', 300, 1.7)],
    ['same run, same temperature, different values', obs('p1', 300, 1, { run: 'r' }), obs('p2', 300, 1.7, { run: 'r' })],
    ['same locator only', obs('p1', 300, 1, { locator: { table: 'T' } }), obs('p2', 300, 1, { locator: { table: 'T' } })],
    ['same value only', obs('p1', 300, 1), obs('p2', 400, 1)],
    ['equal uncertainty statements', obs('p1', 300, 1, { uncertainty: u }), obs('p2', 300, 1.2, { uncertainty: u })],
  ];
  for (const [name, a, b] of cases) {
    const series = bulkSeries({ points: [a, b, obs('p9', 500, 5)] });
    assert.deepEqual(errs(series), [], name);
    assert.equal(createPropertySeries(series).points.length, 3, name);
  }
  // no invented metadata is demanded: bare repeats pass without run, locator or replicate
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1), obs('p3', 300, 1)] })), []);
  assert.ok(!warns(bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1)] })).includes('possible_duplicate_observation'));     // nothing suspicious is declared, nothing is flagged
  assert.ok(!warns(bulkSeries({ points: [obs('p1', 300, 1, { run: 'r' }), obs('p2', 300, 1, { run: 'r' })] })).includes('possible_duplicate_observation'));   // a run alone is not a declared origin of a row
});

test('F1: repeats on the same sample, independent repeats and repeats of unknown independence are all stored; none is called independent unless declared', () => {
  const group = (relation: string) => bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation } as never }), obs('p2', 300, 1.1, { replicate: { group: 'g', relation } as never }), obs('p3', 400, 2)] });
  for (const relation of ['same_sample_repeat', 'independent_repeat', 'independence_unknown']) {
    assert.deepEqual(errs(group(relation)), [], relation);
    assert.equal(createPropertySeries(group(relation)).points[0].replicate?.relation, relation);
  }
  // mixed relations inside one group are the author's statement per observation
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: 'same_sample_repeat' } }), obs('p2', 300, 1.1, { replicate: { group: 'g', relation: 'independent_repeat' } }), obs('p3', 400, 2)] })), []);
  // no replicate statement at all: stored, and the series states no independence anywhere
  const bare = createPropertySeries(bulkSeries({ points: [obs('p1', 300, 1), obs('p2', 300, 1.1)] }));
  assert.equal(bare.points.every(p => p.replicate === undefined), true);
  assert.deepEqual(bare.correlation, { kind: 'unknown' });
});

test('F1: ONE public vocabulary for ReplicateInfo.relation; the former names are not a second set', () => {
  assert.deepEqual([...materials.REPLICATE_RELATIONS], ['independent_repeat', 'same_sample_repeat', 'independence_unknown']);
  for (const old of ['independent_measurement', 'unknown', 'independence_known', 'repeat', '']) {
    assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1, { replicate: { group: 'g', relation: old as never } }), obs('p2', 300, 2)] })), ['invalid_replicate'], old);
  }
  const text = readFileSync(join(__dirname, '../src/materials/README.md'), 'utf8') + readFileSync(join(__dirname, '../src/materials/series-types.ts'), 'utf8');
  for (const name of materials.REPLICATE_RELATIONS) assert.ok(text.includes(name), `${name} is documented`);
  assert.ok(!/independent_measurement/.test(text));                                                                              // the former name is gone from the documentation
});

test('F1: a temperature measured again after heating and cooling or after a thermal cycle is stored, in the measurement order', () => {
  const run = [obs('up-300', 300, 1, { run: 'cycle-1' }), obs('up-400', 400, 2, { run: 'cycle-1' }), obs('down-300', 300, 1.05, { run: 'cycle-1' }), obs('up2-300', 300, 1.08, { run: 'cycle-2' }), obs('up2-400', 400, 2.1, { run: 'cycle-2' })];
  const series = bulkSeries({ points: run, applicability: { events: [], stability: { kind: 'not_stated' }, thermalHistory: { state: 'cycled', cycles: 2 }, sweepDirection: 'mixed' } });
  assert.deepEqual(errs(series), []);
  const kept = createPropertySeries(series);
  assert.deepEqual(kept.points.map(p => p.id), ['up-300', 'up-400', 'down-300', 'up2-300', 'up2-400']);          // the original order, not sorted by temperature
  assert.deepEqual(kept.points.filter(p => p.temperature.value === 300).map(p => p.value.value), [1, 1.05, 1.08]);   // the same temperature three times, three different values
  assert.ok(warns(series).includes('potential_incomparability'));                                                   // up and down: a note, as before
  // the same with the cycle described only by the order (no explicit history)
  assert.deepEqual(errs(bulkSeries({ points: run })), []);
});

test('F1: equal values never merge observations: nothing is averaged, deduplicated or reordered', () => {
  const series = bulkSeries({ points: [obs('p3', 400, 7), obs('p1', 300, 5), obs('p2', 300, 5), obs('p4', 300, 5)] });
  const kept = createPropertySeries(series);
  assert.deepEqual(kept.points.map(p => [p.id, p.temperature.value, p.value.value]), [['p3', 400, 7], ['p1', 300, 5], ['p2', 300, 5], ['p4', 300, 5]]);
  assert.equal(new Set(kept.points.map(p => p.id)).size, 4);
  assert.notEqual(kept, series);
  assert.deepEqual(series.points.map(p => p.id), ['p3', 'p1', 'p2', 'p4']);                                         // the input is untouched
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /dedup|unique|merge|average|mean(?!ing)/i.test(n)), names.join());
});

test('F1: the possible-duplicate warning never blocks a valid series, and the rest of the rules still hold', () => {
  const same = { run: 'r1', locator: { table: 'T1' } };
  const series = bulkSeries({ points: [obs('p1', 300, 1, same), obs('p2', 300, 1, same), obs('p3', 400, 2, same)] });
  const report = validatePropertySeries(series);
  assert.equal(report.ok, true);
  assert.equal(report.issues.filter(i => i.code === 'possible_duplicate_observation').length, 1);                   // p2 against p1; p3 is another temperature
  assert.doesNotThrow(() => createPropertySeries(series, bulk));
  // the other physical rules are unaffected
  assert.ok(errs(bulkSeries({ points: [obs('p1', -5, 1, same), obs('p2', 300, 1, same)] })).includes('invalid_quantity'));
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 400, 1, same), obs('p2', 300, 1, same)], applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'heating' } })), ['sweep_inconsistent']);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') }, [300, 400]), bulk), ['invalid_condition']);
  assert.deepEqual(errs(filmSeries({ commonConditions: {} }), film), ['missing_condition', 'missing_condition']);
  assert.deepEqual(errs(bulkSeries({ points: [{ ...obs('p1', 300, 1, same), uncertainty: undefined as never }, obs('p2', 400, 2)] })), ['invalid_uncertainty']);
});
