import test from 'node:test';
import assert from 'node:assert/strict';
import * as materials from '../src/materials';
import { createMaterialPropertyRegistry, compareRecords, describeDifferences, validatePropertyRecord, type PropertyRecord, type PropertyUncertainty } from '../src/materials';
import { syntheticSystemCatalog } from './materials-fixtures';
import { kRecord, BULK, FILM, syntheticProvenance } from './materials-property-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const std = (u: number): PropertyUncertainty => ({ kind: 'standard', u, origin: 'stated_in_source' });
const rec = (id: string, value: number, extra: Partial<PropertyRecord> = {}): PropertyRecord => kRecord(id, BULK, value, extra);
const cmp = (a: PropertyRecord, b: PropertyRecord) => { const r = compareRecords(a, b); if (r.status !== 'compared') throw new Error(`refused: ${r.message}`); return r; };
const cat = (a: PropertyRecord, b: PropertyRecord) => cmp(a, b).category;
const registry = (records: PropertyRecord[]) => {
  const result = createMaterialPropertyRegistry({ catalog: syntheticSystemCatalog(), records, dataVersion: 'fixture-1' });
  if (!result.ok) throw new Error(JSON.stringify(result.report.issues.filter(i => i.severity === 'error')));
  return result.registry;
};
const cpRecord = (id: string, value: number, mode: 'isobaric' | 'isochoric', extra: Record<string, unknown> = {}): PropertyRecord => ({
  id, variant: BULK, property: 'specific_heat_capacity', value: { type: 'scalar', value, unit: 'J_kgK' }, uncertainty: std(1), conditions: { temperature: q(300, 'K'), heatCapacityMode: mode, ...extra } as never,
  provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01',
});
const alphaRecord = (id: string, value: number, conditions: Record<string, unknown>): PropertyRecord => ({
  id, variant: BULK, property: 'linear_expansion_coefficient', value: { type: 'scalar', value, unit: 'ppm_K' }, uncertainty: std(0.1), conditions: conditions as never,
  provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01',
});

test('the categories: identical, different_values, conditions_differ, insufficient_context, review_required', () => {
  const a = rec('fixture:a', 2);
  assert.equal(cat(a, rec('fixture:b', 2)), 'identical');                                                                         // the same checkable data
  assert.equal(cat(a, rec('fixture:b', 2, { value: { type: 'scalar', value: 0.02, unit: 'W_cmK' }, uncertainty: std(0.005) })), 'identical');   // the same in other units
  assert.equal(cat(a, rec('fixture:b', 3)), 'different_values');                                                                   // nominal values differ, every stated condition is equal
  assert.equal(cat(a, rec('fixture:b', 3, { conditions: { temperature: q(400, 'K') } as never })), 'conditions_differ');
  assert.equal(cat(a, rec('fixture:b', 3, { conditions: { temperature: q(300, 'K'), atmosphere: 'СИНТЕТИЧЕСКАЯ' } as never })), 'insufficient_context');
  assert.equal(cat(a, rec('fixture:b', 3, { conditions: { temperature: q(300, 'K'), measurementMethod: 'СИНТЕТИЧЕСКИЙ метод' } as never })), 'insufficient_context');   // a method stated by one only
  assert.equal(cat(rec('fixture:a', 2, { conditions: { temperature: q(300, 'K'), measurementMethod: 'метод А' } as never }), rec('fixture:b', 2, { conditions: { temperature: q(300, 'K'), measurementMethod: 'метод Б' } as never })), 'review_required');
  assert.equal(cat(a, rec('fixture:b', 2, { uncertainty: std(0.7) })), 'review_required');                                         // equal values, different uncertainty statements
  assert.ok(cmp(a, rec('fixture:b', 3)).reasons.length > 0);
  assert.ok(Object.keys(materials).every(n => !/conflict/i.test(n)));                                                              // no "conflict" verdict exists any more
});

test('different values are NOT a scientific contradiction: no statistical verdict, however far apart the values or small the uncertainties', () => {
  for (const [value, u] of [[2.0001, 0.0000001], [10, 0.0001], [1e6, 1e-9]] as const) {
    const result = cmp(rec('fixture:a', 2, { uncertainty: std(u) }), rec('fixture:b', value, { uncertainty: std(u) }));
    assert.equal(result.category, 'different_values');
    assert.ok(!/конфликт|противореч(?!ие\b)/i.test(result.reasons.join(' ')) || /не доказывает/.test(result.reasons.join(' ')));
    assert.match(result.reasons.join(' '), /не доказывает ни сопоставимость методик, ни научное противоречие/);
    assert.match(result.reasons.join(' '), /статистический вывод не делается/);
  }
  // the same category whatever the uncertainty statements: unknown, bounds, expanded without k, large or tiny
  const variants: PropertyUncertainty[] = [{ kind: 'unknown' }, { kind: 'bounds', lower: 1, upper: 100, origin: 'stated_in_source' }, { kind: 'expanded', U: 1, origin: 'stated_in_source' }, std(1e-12), std(1e6)];
  for (const ua of variants) for (const ub of variants) assert.equal(cat(rec('fixture:a', 2, { uncertainty: ua }), rec('fixture:b', 7, { uncertainty: ub })), 'different_values', `${ua.kind}/${ub.kind}`);
});

test('uncertainties are neither combined nor assumed independent, and an unknown one never becomes zero', () => {
  const unknown = rec('fixture:a', 2, { uncertainty: { kind: 'unknown' } });
  const tiny = rec('fixture:b', 2.0000001, { uncertainty: std(1e-12) });
  assert.equal(cat(unknown, tiny), 'different_values');                                                                            // not "conflict" because one u is "zero": unknown is not zero
  assert.equal(cat(tiny, unknown), 'different_values');
  assert.equal(cat(unknown, rec('fixture:b', 2, { uncertainty: { kind: 'unknown' } })), 'identical');
  assert.equal(cat(unknown, rec('fixture:b', 2, { uncertainty: std(0.5) })), 'review_required');                                  // equal values, one uncertainty unknown: not identical, not hidden
  // the source text of the module has no coverage factor, no square root of a sum of squares, no overlap test
  const code = materials.compareRecords.toString() + materials.describeDifferences.toString();
  assert.ok(!/sqrt|Math\.hypot|coverage|\*\* ?2/i.test(code));
  assert.ok(!('COMPATIBILITY_COVERAGE_FACTOR' in materials));
});

test('different measurement methods and different free-text context need an expert; free text is never ignored', () => {
  const m = (id: string, method: string | undefined, value = 2, context?: string) => rec(id, value, { conditions: { temperature: q(300, 'K'), ...(method ? { measurementMethod: method } : {}), ...(context ? { context } : {}) } as never });
  assert.equal(cat(m('fixture:a', 'лазерная вспышка'), m('fixture:b', 'стационарный метод')), 'review_required');
  assert.equal(cat(m('fixture:a', 'лазерная вспышка'), m('fixture:b', 'стационарный метод', 9)), 'review_required');                 // different values AND methods: still an expert's call
  assert.equal(cat(m('fixture:a', 'лазерная вспышка'), m('fixture:b', '  лазерная   вспышка ')), 'identical');                    // the same text up to whitespace
  assert.equal(cat(m('fixture:a', 'лазерная вспышка'), m('fixture:b', 'лазерная вспышка', 9)), 'different_values');
  assert.equal(cat(m('fixture:a', undefined), m('fixture:b', 'лазерная вспышка')), 'insufficient_context');
  assert.equal(cat(m('fixture:a', undefined, 2, 'отожжён'), m('fixture:b', undefined, 2, 'не отожжён')), 'review_required');
  assert.equal(cat(m('fixture:a', undefined, 2, 'отожжён'), m('fixture:b', undefined)), 'insufficient_context');
  // a structured difference is stated first (the free text does not hide it)
  assert.equal(cat(rec('fixture:a', 2, { conditions: { temperature: q(300, 'K'), measurementMethod: 'А' } as never }), rec('fixture:b', 2, { conditions: { temperature: q(400, 'K'), measurementMethod: 'Б' } as never })), 'conditions_differ');
});

test('specific heat: Cp and Cv are different conditions; the mode is never ignored', () => {
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric'), cpRecord('fixture:b', 400, 'isochoric')), 'conditions_differ');           // the same number, different quantities
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric'), cpRecord('fixture:b', 410, 'isochoric')), 'conditions_differ');
  assert.match(cmp(cpRecord('fixture:a', 400, 'isobaric'), cpRecord('fixture:b', 410, 'isochoric')).reasons.join(' '), /heatCapacityMode/);
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric'), cpRecord('fixture:b', 410, 'isobaric')), 'different_values');
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric'), cpRecord('fixture:b', 400, 'isobaric')), 'identical');
  // the pressure, when stated, matters too
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric', { pressure: q(1, 'bar') }), cpRecord('fixture:b', 400, 'isobaric', { pressure: q(2, 'bar') })), 'conditions_differ');
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric', { pressure: q(1, 'bar') }), cpRecord('fixture:b', 400, 'isobaric')), 'insufficient_context');
  assert.equal(cat(cpRecord('fixture:a', 400, 'isobaric', { pressure: q(1, 'bar') }), cpRecord('fixture:b', 400, 'isobaric', { pressure: q(100, 'kPa') })), 'identical');   // 1 bar = 100 kPa exactly
});

test('expansion coefficient: tangent and mean are different; the reference temperature is a condition', () => {
  const tangent = alphaRecord('fixture:a', 10, { expansionDefinition: 'tangent', temperature: q(500, 'K') });
  const mean = alphaRecord('fixture:b', 10, { expansionDefinition: 'mean', temperature: q(500, 'K'), referenceTemperature: q(300, 'K') });
  assert.equal(cat(tangent, mean), 'conditions_differ');                                                                            // equal numbers, different quantities
  assert.match(cmp(tangent, mean).reasons.join(' '), /expansionDefinition/);
  const mean2 = alphaRecord('fixture:c', 10, { expansionDefinition: 'mean', temperature: q(500, 'K'), referenceTemperature: q(293.15, 'K') });
  assert.equal(cat(mean, mean2), 'conditions_differ');                                                                              // another reference temperature
  assert.match(cmp(mean, mean2).reasons.join(' '), /referenceTemperature/);
  assert.equal(cat(mean, alphaRecord('fixture:d', 11, { expansionDefinition: 'mean', temperature: q(500, 'K'), referenceTemperature: q(26.85, 'degC') })), 'different_values');   // 26.85 degC is 300 K
});

test('a point temperature and a declared range are different conditions', () => {
  const point = rec('fixture:a', 2);
  const range = rec('fixture:b', 2, { conditions: { temperatureRange: { min: q(300, 'K'), max: q(500, 'K') } } as never });
  assert.equal(cat(point, range), 'insufficient_context');                                                                         // a point and a range are not the same statement
  assert.equal(cat(range, rec('fixture:c', 2, { conditions: { temperatureRange: { min: q(300, 'K'), max: q(500, 'K') } } as never })), 'identical');
  assert.equal(cat(range, rec('fixture:c', 2, { conditions: { temperatureRange: { min: q(300, 'K'), max: q(600, 'K') } } as never })), 'conditions_differ');
  assert.equal(cat(rec('fixture:a', 2, { conditions: { temperature: q(300, 'K') } as never }), rec('fixture:c', 2, { conditions: { temperature: q(26.85, 'degC') } as never })), 'identical');
});

test('the form and the film conditions: thickness and direction are compared, bulk and film are never compared with each other', () => {
  const film = (id: string, value: number, thickness: number, direction: 'in_plane' | 'cross_plane') => kRecord(id, FILM, value, { conditions: { temperature: q(300, 'K'), thickness: q(thickness, 'nm'), direction } as never });
  assert.equal(cat(film('fixture:a', 1, 100, 'in_plane'), film('fixture:b', 5, 100, 'cross_plane')), 'conditions_differ');
  assert.equal(cat(film('fixture:a', 1, 100, 'in_plane'), film('fixture:b', 5, 200, 'in_plane')), 'conditions_differ');
  assert.equal(cat(film('fixture:a', 1, 100, 'in_plane'), kRecord('fixture:b', FILM, 5, { conditions: { temperature: q(300, 'K'), thickness: q(0.1, 'um'), direction: 'in_plane' } as never })), 'different_values');   // 0.1 um is exactly 100 nm
  assert.equal(cat(film('fixture:a', 1, 100, 'in_plane'), film('fixture:b', 5, 100, 'in_plane')), 'different_values');
  // different variants (a bulk piece and a film) are never compared: no pair between them appears anywhere
  const reg = registry([kRecord('fixture:k-bulk', BULK, 2), film('fixture:k-film', 90, 100, 'in_plane')]);
  assert.deepEqual(reg.differences(), []);
  assert.deepEqual(describeDifferences([kRecord('fixture:k-bulk', BULK, 2), film('fixture:k-film', 90, 100, 'in_plane')]), []);
});

test('differences are descriptive diagnostics: both records stay, ordered by id, independent of the input order, and superseded records take no part', () => {
  const records = [rec('fixture:k-c', 30), rec('fixture:k-a', 2), rec('fixture:k-b', 10, { conditions: { temperature: q(400, 'K') } as never })];
  const reg = registry(records);
  assert.deepEqual(reg.differences().map(d => `${d.category}:${d.records.join('|')}`), ['conditions_differ:fixture:k-a|fixture:k-b', 'different_values:fixture:k-a|fixture:k-c', 'conditions_differ:fixture:k-b|fixture:k-c']);
  assert.deepEqual(registry([...records].reverse()).differences(), reg.differences());
  assert.equal(reg.snapshot.records.length, 3);
  assert.ok(Object.isFrozen(reg.differences()) && Object.isFrozen(reg.differences()[0]) && Object.isFrozen(reg.differences()[0].reasons));
  const result = reg.findRecords({ variant: BULK, conditions: { temperature: q(300, 'K') } });
  assert.deepEqual(result.differences.map(d => d.category), ['different_values']);                                                // among the returned records only
  assert.deepEqual(reg.findRecords({ variant: BULK, version: 99 }).differences, []);
  const old = registry([rec('fixture:k-old', 10), rec('fixture:k-new', 2, { version: 2, supersedes: 'fixture:k-old' })]);
  assert.deepEqual(old.differences(), []);
  assert.equal(old.findRecords({ variant: BULK, includeSuperseded: true }).differences.length, 1);                                // asked for explicitly: described
  // the registry report mentions an expert-review case as a warning and different values as information
  const methods = registry([rec('fixture:k-a', 2, { conditions: { temperature: q(300, 'K'), measurementMethod: 'А' } as never }), rec('fixture:k-b', 2, { conditions: { temperature: q(300, 'K'), measurementMethod: 'Б' } as never })]);
  assert.ok(methods.report.issues.some(i => i.code === 'records_differ' && i.severity === 'warning'));
  assert.ok(reg.report.issues.some(i => i.code === 'records_differ' && i.severity === 'info'));
  assert.equal(reg.report.summary.errors, 0);
});

test('provenance does not decide anything: measured is not preferred over a model estimate; ref and user have no priority', () => {
  const measured = rec('fixture:k-m', 2);
  const model = rec('fixture:k-e', 9, { provenance: { ...syntheticProvenance(), status: 'model_estimate' } });          // the same method text: only the STATUS differs
  assert.equal(cat(measured, model), 'different_values');                                                       // a status does not change the category
  const reg = registry([measured, model]);
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity' }).status, 'multiple_records');
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity', status: 'measured' }).status, 'unique_record');   // narrowed by the CALLER; the registry never narrows
  const user = rec('user:k-u', 9, { provenance: { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } } as never });
  const both = registry([rec('fixture:k-r', 2), user]);
  assert.deepEqual(both.findRecords({ variant: BULK }).records.map(r => r.id), ['fixture:k-r', 'user:k-u']);
});

// ---------- F1: provenance.method is a characteristic of its own ----------

const withMethod = (id: string, value: number, method: string | undefined, extra: Partial<PropertyRecord> = {}): PropertyRecord => {
  const r = rec(id, value, extra);
  const { method: _old, ...rest } = r.provenance;
  void _old;
  // a MEASURED value must state its method (M1.3.2), so a record without a method is an evaluated one - the status itself does not enter the comparison
  return { ...r, provenance: (method === undefined ? { ...rest, status: 'evaluated' } : { ...rest, method }) as never };
};

test('F1: different provenance.method at equal values is review_required, never identical (the audit reproduction)', () => {
  const a = rec('fixture:a', 2);
  const b = rec('fixture:b', 2);
  (a.provenance as { method?: string }).method = 'Синтетический метод A';
  (b.provenance as { method?: string }).method = 'Синтетический метод B';
  const result = cmp(a, b);
  assert.equal(result.category, 'review_required');
  assert.match(result.reasons.join(' '), /provenance\.method/);
  assert.match(result.reasons.join(' '), /экспертная оценка/);
  assert.notEqual(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, 'метод B')), 'identical');
  // the registry reports it too, as a warning, and keeps both records
  const reg = registry([withMethod('fixture:k-a', 2, 'метод A'), withMethod('fixture:k-b', 2, 'метод B')]);
  assert.deepEqual(reg.differences().map(d => d.category), ['review_required']);
  assert.ok(reg.report.issues.some(i => i.code === 'records_differ' && i.severity === 'warning'));
  assert.equal(reg.snapshot.records.length, 2);
});

test('F1: the same provenance.method continues with the remaining checks; the wording is not interpreted', () => {
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, 'метод A')), 'identical');
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, '  метод   A ')), 'identical');                // whitespace only
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 3, 'метод A')), 'different_values');
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, 'метод A', { uncertainty: std(0.9) })), 'review_required');
  // no approximate matching: a near-identical wording, another case, another language are DIFFERENT methods
  for (const other of ['Метод A', 'метод А', 'метод A.', 'method A', 'метод A (уточнённый)']) assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, other)), 'review_required', other);
});

test('F1: a method given by one record only is insufficient_context', () => {
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, undefined)), 'insufficient_context');
  assert.equal(cat(withMethod('fixture:a', 2, undefined), withMethod('fixture:b', 2, 'метод A')), 'insufficient_context');
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 5, undefined)), 'insufficient_context');             // also at different values
  assert.match(cmp(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, undefined)).reasons.join(' '), /provenance\.method/);
  assert.equal(cat(withMethod('fixture:a', 2, undefined), withMethod('fixture:b', 2, undefined)), 'identical');                           // no method in either: nothing to compare
});

test('F1: conditions.measurementMethod is compared separately and is not mixed with provenance.method', () => {
  const cm = (id: string, value: number, conditionMethod: string | undefined, provenanceMethod: string) => {
    const r = withMethod(id, value, provenanceMethod, { conditions: { temperature: q(300, 'K'), ...(conditionMethod ? { measurementMethod: conditionMethod } : {}) } as never });
    return r;
  };
  // different conditions.measurementMethod under the same provenance.method
  const same = cmp(cm('fixture:a', 2, 'лазерная вспышка', 'обзор A'), cm('fixture:b', 2, 'стационарный метод', 'обзор A'));
  assert.equal(same.category, 'review_required');
  assert.match(same.reasons.join(' '), /measurementMethod/);
  assert.ok(!/provenance\.method/.test(same.reasons.join(' ')));
  // the same conditions.measurementMethod under different provenance.method
  const other = cmp(cm('fixture:a', 2, 'лазерная вспышка', 'обзор A'), cm('fixture:b', 2, 'лазерная вспышка', 'обзор B'));
  assert.equal(other.category, 'review_required');
  assert.match(other.reasons.join(' '), /provenance\.method/);
  assert.ok(!/measurementMethod/.test(other.reasons.join(' ')));
  // both different: both are named
  const both = cmp(cm('fixture:a', 2, 'лазерная вспышка', 'обзор A'), cm('fixture:b', 2, 'стационарный метод', 'обзор B'));
  assert.equal(both.category, 'review_required');
  assert.match(both.reasons.join(' '), /measurementMethod/);
  assert.match(both.reasons.join(' '), /provenance\.method/);
  // a measurement method in one place is not a method in the other
  assert.equal(cat(cm('fixture:a', 2, 'лазерная вспышка', 'обзор A'), cm('fixture:b', 2, undefined, 'обзор A')), 'insufficient_context');
  assert.equal(cat(cm('fixture:a', 2, 'метод A', 'метод A'), cm('fixture:b', 2, 'метод A', 'метод A')), 'identical');
});

test('F1: different methods together with different values: review_required, still no verdict', () => {
  const result = cmp(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 90, 'метод B'));
  assert.equal(result.category, 'review_required');
  assert.ok(!/конфликт|противореч|значим/i.test(result.reasons.join(' ')));
  assert.ok(!/статистическ/.test(result.reasons.join(' ')) || /не делается|не оценива/.test(result.reasons.join(' ')));
  for (const [ua, ub] of [[std(1e-9), std(1e-9)], [{ kind: 'unknown' }, { kind: 'unknown' }], [std(1e9), std(1e9)]] as [PropertyUncertainty, PropertyUncertainty][]) {
    assert.equal(cat(withMethod('fixture:a', 2, 'метод A', { uncertainty: ua }), withMethod('fixture:b', 9, 'метод B', { uncertainty: ub })), 'review_required');
  }
  assert.ok(!Object.keys(materials).some(n => /conflict/i.test(n)));
});

test('the order of the diagnostics is fixed and every difference is listed whatever the category', () => {
  // 1. a structured condition differs  >  2. one-sided  >  3. free text differs  >  4. values
  const a = withMethod('fixture:a', 2, 'метод A', { conditions: { temperature: q(300, 'K'), measurementMethod: 'M1' } as never });
  const b = withMethod('fixture:b', 7, 'метод B', { conditions: { temperature: q(400, 'K'), measurementMethod: 'M2' } as never });
  const top = cmp(a, b);
  assert.equal(top.category, 'conditions_differ');                                                                                          // the highest rank wins ...
  assert.match(top.reasons.join(' '), /temperature/);
  assert.match(top.reasons.join(' '), /measurementMethod/);                                                                                 // ... and the method differences are not lost behind it
  assert.match(top.reasons.join(' '), /provenance\.method/);
  const oneSided = cmp(withMethod('fixture:a', 2, 'метод A', { conditions: { temperature: q(300, 'K'), atmosphere: 'X' } as never }), withMethod('fixture:b', 2, 'метод B'));
  assert.equal(oneSided.category, 'insufficient_context');
  assert.match(oneSided.reasons.join(' '), /atmosphere/);
  assert.match(oneSided.reasons.join(' '), /provenance\.method/);
  // deterministic: argument order and repetition do not change the result
  assert.deepEqual(cmp(a, b), cmp(b, a));
  assert.deepEqual(cmp(a, b), cmp(a, b));
  // each category arises only from its own situation (no false categories)
  const cats = new Set([cat(rec('fixture:a', 2), rec('fixture:b', 2)), cat(rec('fixture:a', 2), rec('fixture:b', 3)), cat(a, b), cat(rec('fixture:a', 2), rec('fixture:b', 2, { conditions: { temperature: q(300, 'K'), atmosphere: 'X' } as never })), cat(withMethod('fixture:a', 2, 'A'), withMethod('fixture:b', 2, 'B'))]);
  assert.deepEqual([...cats].sort(), ['conditions_differ', 'different_values', 'identical', 'insufficient_context', 'review_required']);
});

// ---------- F2: records of different variants or properties are never compared ----------

test('F2: different variants are refused, not described - even with the same property, the same number and the same conditions', () => {
  const a = rec('fixture:a', 2);
  const film = { ...rec('fixture:b', 2), variant: FILM };
  const result = compareRecords(a, film);
  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.reason, 'different_variant');
  assert.match(result.status === 'refused' ? result.message : '', /разным вариантам/);
  assert.equal(compareRecords(film, a).status, 'refused');
  assert.equal(compareRecords(a, { ...rec('fixture:b', 2), variant: 'fixture:synthetic-compound-target' }).status, 'refused');
  assert.ok(!('category' in result));                                                                                                    // there is no category to be mistaken for "identical"
});

/** A VALID record of any property (the conditions its definition requires), so that the refusal tested is about the property, not about a malformed record. */
const validRecord = (id: string, property: string, unit: string, value: number, conditions: Record<string, unknown>): PropertyRecord => ({
  id, variant: BULK, property, value: { type: 'scalar', value, unit }, uncertainty: std(0.1), conditions: conditions as never, provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01',
}) as PropertyRecord;

test('F2: different properties are refused, whatever the numbers - thermal conductivity against density, equal numbers in different dimensions', () => {
  const k = rec('fixture:a', 2);
  const density = validRecord('fixture:b', 'density', 'kg_m3', 2, { temperature: q(300, 'K') });
  const r1 = compareRecords(k, density);
  assert.equal(r1.status, 'refused');
  assert.equal(r1.status === 'refused' && r1.reason, 'different_property');
  assert.equal(compareRecords(density, k).status === 'refused' && (compareRecords(density, k) as { reason: string }).reason, 'different_property');
  // the same SI number in two dimensions: 2 W/(m K) and 2 kg/m3, 2 J/(kg K), 2 Ohm m ...
  const others: [string, string, Record<string, unknown>][] = [
    ['specific_heat_capacity', 'J_kgK', { temperature: q(300, 'K'), heatCapacityMode: 'isobaric' }], ['electrical_resistivity', 'Ohm_m', { temperature: q(300, 'K') }],
    ['electrical_conductivity', 'S_m', { temperature: q(300, 'K') }], ['molar_mass', 'kg_mol', {}], ['youngs_modulus', 'Pa_mod', { temperature: q(300, 'K') }], ['thermal_diffusivity', 'm2_s', { temperature: q(300, 'K') }],
  ];
  for (const [property, unit, conditions] of others) {
    const other = validRecord('fixture:b', property, unit, 2, conditions);
    assert.equal(validatePropertyRecord(other).ok, true, `${property}: the fixture itself is valid`);
    const result = compareRecords(k, other);
    assert.equal(result.status, 'refused', property);
    assert.equal(result.status === 'refused' && result.reason, 'different_property', property);
    assert.equal(compareRecords(other, k).status === 'refused' && (compareRecords(other, k) as { reason: string }).reason, 'different_property', property);
  }
  // three moduli of one kind are three properties: Young's modulus and the shear modulus with the same number are not the same property
  const young = validRecord('fixture:y', 'youngs_modulus', 'GPa_mod', 2, { temperature: q(300, 'K') });
  const shear = validRecord('fixture:s', 'shear_modulus', 'GPa_mod', 2, { temperature: q(300, 'K') });
  assert.equal(compareRecords(young, shear).status === 'refused' && (compareRecords(young, shear) as { reason: string }).reason, 'different_property');
});

test('F2: units that do not belong to the property, malformed records and unknown units are refused (no implicit kind, no implicit conversion)', () => {
  const a = rec('fixture:a', 2);
  const wrongUnit = { ...rec('fixture:b', 2), value: { type: 'scalar' as const, value: 2, unit: 'kg_m3' as const } } as PropertyRecord;     // a density unit under thermal conductivity
  // such a record is not valid (M1.3.2: the unit must belong to the kind of the property), so it is refused as invalid_record before anything is converted; the
  // `incompatible_units` branch of compareRecords is only a defensive second line
  assert.equal(compareRecords(a, wrongUnit).status === 'refused' && (compareRecords(a, wrongUnit) as { reason: string }).reason, 'invalid_record');
  assert.equal(compareRecords(wrongUnit, { ...wrongUnit, id: 'fixture:c' }).status, 'refused');                                           // both wrong: still not compared
  for (const bad of [null, undefined, 5, 'x', [], {}, { ...a, conditions: null }, { ...a, value: null }, { ...a, provenance: null }, { ...a, uncertainty: 5 }, { ...a, variant: 5 }, { ...a, value: { type: 'scalar', value: 'x', unit: 'W_mK' } }]) {
    let r: ReturnType<typeof compareRecords> | undefined;
    assert.doesNotThrow(() => { r = compareRecords(a, bad as never); }, JSON.stringify(bad));
    assert.equal(r!.status, 'refused', JSON.stringify(bad));
    assert.doesNotThrow(() => compareRecords(bad as never, a));
  }
  assert.equal(compareRecords(a, { ...a, value: { type: 'scalar', value: 2, unit: 'nope' } } as never).status === 'refused' && (compareRecords(a, { ...a, value: { type: 'scalar', value: 2, unit: 'nope' } } as never) as { reason: string }).reason, 'invalid_record');
});

test('F2: compatible records (one variant, one property) are compared as before, and differences() keeps its protection', () => {
  const a = rec('fixture:a', 2);
  const b = rec('fixture:b', 3);
  const ok = compareRecords(a, b);
  assert.equal(ok.status, 'compared');
  assert.equal(ok.status === 'compared' && ok.category, 'different_values');
  // describeDifferences never mixes variants or properties: records of several variants and properties give pairs within each group only
  const mixed: PropertyRecord[] = [
    rec('fixture:k1', 2), rec('fixture:k2', 3), kRecord('fixture:f1', FILM, 2), kRecord('fixture:f2', FILM, 2),
    { ...rec('fixture:d1', 2), property: 'density', value: { type: 'scalar', value: 2, unit: 'kg_m3' }, conditions: { temperature: q(300, 'K') } as never } as PropertyRecord,
  ];
  const pairs = describeDifferences(mixed).map(d => `${d.variant}/${d.property}/${d.category}/${d.records.join('|')}`);
  assert.deepEqual(pairs, [`${FILM}/thermal_conductivity/identical/fixture:f1|fixture:f2`, `${BULK}/thermal_conductivity/different_values/fixture:k1|fixture:k2`]);   // groups ordered by the first record id: deterministic
  // the registry uses the same protected path
  const reg = registry([rec('fixture:k1', 2), rec('fixture:k2', 3), kRecord('fixture:f1', FILM, 2)]);
  assert.deepEqual(reg.differences().map(d => d.records.join('|')), ['fixture:k1|fixture:k2']);
  assert.ok(reg.differences().every(d => d.category !== 'identical' || d.records.length === 2));
});

// ---------- F2 (final): records are validated before any comparison ----------

const clone = <T>(x: T): T => structuredClone(x);
type Mutable = Record<string, unknown>;
const corrupted: [string, (r: Mutable) => void][] = [
  ['value NaN', r => { (r.value as Mutable).value = NaN; }],
  ['value Infinity', r => { (r.value as Mutable).value = Infinity; }],
  ['value -Infinity', r => { (r.value as Mutable).value = -Infinity; }],
  ['value a string', r => { (r.value as Mutable).value = '2'; }],
  ['a negative density-like value (below the physical limit)', r => { (r.value as Mutable).value = -1; }],
  ['uncertainty u a string', r => { r.uncertainty = { kind: 'standard', u: 'bad', origin: 'stated_in_source' }; }],
  ['uncertainty negative', r => { r.uncertainty = { kind: 'standard', u: -0.5, origin: 'stated_in_source' }; }],
  ['uncertainty a zero without exact_by_definition', r => { r.uncertainty = { kind: 'standard', u: 0, origin: 'stated_in_source' }; }],
  ['uncertainty of an unknown kind', r => { r.uncertainty = { kind: 'guess' }; }],
  ['uncertainty missing', r => { delete r.uncertainty; }],
  ['condition temperature with an unknown unit', r => { (r.conditions as Mutable).temperature = { value: 300, unit: 'nope' }; }],
  ['condition temperature a temperature interval', r => { (r.conditions as Mutable).temperature = { value: 10, unit: 'K_delta' }; }],
  ['condition temperature below absolute zero', r => { (r.conditions as Mutable).temperature = { value: -5, unit: 'K' }; }],
  ['condition temperature a number', r => { (r.conditions as Mutable).temperature = 300; }],
  ['conditions null', r => { r.conditions = null; }],
  ['conditions missing the required temperature', r => { r.conditions = {}; }],
  ['value unit unknown', r => { (r.value as Mutable).unit = 'nope'; }],
  ['value unit of another kind', r => { (r.value as Mutable).unit = 'kg_m3'; }],
  ['id undefined', r => { r.id = undefined; }],
  ['id missing', r => { delete r.id; }],
  ['id malformed', r => { r.id = 'Bad Id'; }],
  ['version undefined', r => { r.version = undefined; }],
  ['version missing', r => { delete r.version; }],
  ['version zero', r => { r.version = 0; }],
  ['updatedAt invalid', r => { r.updatedAt = '2000-02-30'; }],
  ['provenance missing', r => { delete r.provenance; }],
  ['provenance null', r => { r.provenance = null; }],
  ['provenance source missing', r => { delete (r.provenance as Mutable).source; }],
  ['provenance without the verification statement', r => { delete (r.provenance as Mutable).verification; }],
  ['an unknown extra field in the record', r => { r.physicalProperty = 123; }],
  ['an unknown extra field in the value', r => { (r.value as Mutable).extra = 1; }],
  ['an unknown extra field in a condition quantity', r => { (r.conditions as Mutable).temperature = { value: 300, unit: 'K', extra: 1 }; }],
  ['an unknown extra field in the provenance', r => { (r.provenance as Mutable).extra = 1; }],
  ['variant malformed', r => { r.variant = 5; }],
  ['property unknown', r => { r.property = 'hardness'; }],
];

test('F2: a structurally invalid record is refused as invalid_record, in both argument orders, whatever the other record is (no category, no exception)', () => {
  const good = rec('fixture:a', 2);
  const partner = rec('fixture:b', 3);
  for (const [name, mutate] of corrupted) {
    const bad = clone(rec('fixture:c', 2)) as unknown as Mutable;
    mutate(bad);
    for (const other of [good, partner]) {
      for (const [x, y] of [[other, bad], [bad, other]] as const) {
        let result: ReturnType<typeof compareRecords> | undefined;
        assert.doesNotThrow(() => { result = compareRecords(x as PropertyRecord, y as PropertyRecord); }, name);
        assert.equal(result!.status, 'refused', name);
        assert.equal(result!.status === 'refused' && result!.reason, 'invalid_record', name);
        assert.ok(!('category' in result!), `${name}: a refusal has no category`);
        assert.ok(!('reasons' in result!), name);
        assert.match(result!.status === 'refused' ? result!.message : '', /некорректна/, name);
      }
    }
    // both records corrupted: still refused
    const bad2 = clone(rec('fixture:d', 2)) as unknown as Mutable;
    mutate(bad2);
    assert.equal(compareRecords(bad as unknown as PropertyRecord, bad2 as unknown as PropertyRecord).status, 'refused', `${name} (both)`);
    assert.equal(compareRecords(bad as unknown as PropertyRecord, clone(bad) as unknown as PropertyRecord).status, 'refused', `${name} (the same damage twice is not "identical")`);
  }
  for (const bad of [null, undefined, 5, 'x', true, [], {}, () => 1]) {
    for (const [x, y] of [[good, bad], [bad, good]] as const) {
      let result: ReturnType<typeof compareRecords> | undefined;
      assert.doesNotThrow(() => { result = compareRecords(x as never, y as never); }, String(bad));
      assert.equal(result!.status === 'refused' && result!.reason, 'invalid_record', String(bad));
    }
  }
  assert.ok(corrupted.length >= 30);
});

test('F2: the four audit reproductions', () => {
  const a = rec('fixture:a', 2);
  const refusedAsInvalid = (x: unknown, y: unknown): void => {
    const r1 = compareRecords(x as PropertyRecord, y as PropertyRecord);
    const r2 = compareRecords(y as PropertyRecord, x as PropertyRecord);
    for (const r of [r1, r2]) { assert.equal(r.status, 'refused'); assert.equal(r.status === 'refused' && r.reason, 'invalid_record'); assert.ok(!('category' in r)); }
  };
  refusedAsInvalid(a, { ...rec('fixture:b', 2), value: { type: 'scalar', value: NaN, unit: 'W_mK' } });
  refusedAsInvalid(a, { ...rec('fixture:b', 2), uncertainty: { kind: 'standard', u: 'bad', origin: 'stated_in_source' } });
  refusedAsInvalid(a, { ...rec('fixture:b', 2), conditions: { temperature: { value: 300, unit: 'nope' } } });
  refusedAsInvalid(a, { ...rec('fixture:b', 2), id: undefined, version: undefined });
});

test('F2: valid records are validated first and then compared as before; the refusals different_variant and different_property are kept', () => {
  const a = rec('fixture:a', 2);
  assert.equal(compareRecords(a, rec('fixture:b', 2)).status === 'compared' && (compareRecords(a, rec('fixture:b', 2)) as { category: string }).category, 'identical');
  assert.equal(compareRecords(a, rec('fixture:b', 3)).status === 'compared' && (compareRecords(a, rec('fixture:b', 3)) as { category: string }).category, 'different_values');
  assert.equal(compareRecords(a, { ...rec('fixture:b', 2), variant: FILM }).status === 'refused' && (compareRecords(a, { ...rec('fixture:b', 2), variant: FILM }) as { reason: string }).reason, 'different_variant');
  assert.equal(compareRecords(a, validRecord('fixture:b', 'density', 'kg_m3', 2, { temperature: q(300, 'K') })).status === 'refused' && (compareRecords(a, validRecord('fixture:b', 'density', 'kg_m3', 2, { temperature: q(300, 'K') })) as { reason: string }).reason, 'different_property');
  // validation comes first: a damaged record paired with a record of ANOTHER variant is reported as invalid, not as "different variant"
  const damaged = { ...rec('fixture:b', 2), variant: FILM, value: { type: 'scalar', value: NaN, unit: 'W_mK' } } as PropertyRecord;
  assert.equal(compareRecords(a, damaged).status === 'refused' && (compareRecords(a, damaged) as { reason: string }).reason, 'invalid_record');
  // all five categories still arise exactly as before
  const t = (x: number) => q(x, 'K');
  assert.equal(cat(a, rec('fixture:b', 3, { conditions: { temperature: t(400) } as never })), 'conditions_differ');
  assert.equal(cat(a, rec('fixture:b', 3, { conditions: { temperature: t(300), atmosphere: 'X' } as never })), 'insufficient_context');
  assert.equal(cat(a, rec('fixture:b', 2, { conditions: { temperature: t(300), measurementMethod: 'M' } as never })), 'insufficient_context');
  assert.equal(cat(withMethod('fixture:a', 2, 'метод A'), withMethod('fixture:b', 2, 'метод B')), 'review_required');
});

test('F2: the registry keeps its behaviour - differences() and findRecords() are unchanged, describeDifferences skips invalid records', () => {
  const records = [rec('fixture:k1', 2), rec('fixture:k2', 3), rec('fixture:k3', 2, { conditions: { temperature: q(400, 'K') } as never })];
  const reg = registry(records);
  assert.deepEqual(reg.differences().map(d => `${d.category}:${d.records.join('|')}`), ['different_values:fixture:k1|fixture:k2', 'conditions_differ:fixture:k1|fixture:k3', 'conditions_differ:fixture:k2|fixture:k3']);
  assert.deepEqual(reg.findRecords({ variant: BULK }).differences.map(d => d.category), ['different_values', 'conditions_differ', 'conditions_differ']);
  assert.equal(reg.findRecords({ variant: BULK, conditions: { temperature: q(300, 'K') } }).count, 2);
  // the public describeDifferences validates each record once and leaves an invalid one out of every pair (it never throws)
  const bad = { ...rec('fixture:k9', 2), value: { type: 'scalar', value: NaN, unit: 'W_mK' } } as PropertyRecord;
  assert.deepEqual(describeDifferences([...records, bad]).map(d => d.records.join('|')), ['fixture:k1|fixture:k2', 'fixture:k1|fixture:k3', 'fixture:k2|fixture:k3']);
  assert.doesNotThrow(() => describeDifferences([null, 5, bad, ...records] as never));
  assert.deepEqual(describeDifferences([bad, { ...bad, id: 'fixture:k8' }]), []);                                                      // two invalid records are not "identical"
});
