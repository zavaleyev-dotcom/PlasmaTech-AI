import test from 'node:test';
import assert from 'node:assert/strict';
import * as materials from '../src/materials';
import { createMaterialPropertyRegistry, type MaterialCatalog, type MaterialPropertyRegistry, type PropertyRecord, type RegistryQuery } from '../src/materials';
import { syntheticSystemCatalog, syntheticTarget } from './materials-fixtures';
import { kRecord, BULK, FILM, TARGET, densityRecord, syntheticProvenance, syntheticSource } from './materials-property-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const catalog = (): MaterialCatalog => { const c = syntheticSystemCatalog(); return { ...c, variants: [...c.variants, syntheticTarget()] }; };
const build = (records: PropertyRecord[]): MaterialPropertyRegistry => {
  const result = createMaterialPropertyRegistry({ catalog: catalog(), records, dataVersion: 'fixture-1' });
  if (!result.ok) throw new Error(JSON.stringify(result.report.issues.filter(i => i.severity === 'error')));
  return result.registry;
};
const ids = (r: { records: readonly PropertyRecord[] }): string[] => r.records.map(x => x.id);
const withProv = (over: Record<string, unknown>) => ({ ...syntheticProvenance(), ...over });

const records = (): PropertyRecord[] => [
  kRecord('fixture:k-bulk-300', BULK, 2),
  kRecord('fixture:k-bulk-400', BULK, 3, { conditions: { temperature: q(400, 'K') } as never }),
  kRecord('fixture:k-bulk-range', BULK, 2.5, { conditions: { temperatureRange: { min: q(300, 'K'), max: q(500, 'K') } } as never }),
  kRecord('fixture:k-film', FILM, 1),
  kRecord('fixture:k-film-cross', FILM, 0.5, { conditions: { temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'cross_plane' } as never }),
  kRecord('fixture:k-target', TARGET, 2.2),
  densityRecord({ id: 'fixture:rho-bulk', variant: BULK }),
  kRecord('user:k-user', BULK, 2.1, { id: 'user:k-user', provenance: { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } } as never }),
];

test('find by the exact variant id, the property id and the physical form: bulk, film and target are different variants', () => {
  const reg = build(records());
  assert.deepEqual(ids(reg.findRecords({ variant: FILM })), ['fixture:k-film', 'fixture:k-film-cross']);
  assert.deepEqual(ids(reg.findRecords({ variant: TARGET })), ['fixture:k-target']);
  assert.deepEqual(ids(reg.findRecords({ variant: BULK, property: 'density' })), ['fixture:rho-bulk']);
  assert.deepEqual(ids(reg.findRecords({ property: 'thermal_conductivity', formKind: 'thin_film' })), ['fixture:k-film', 'fixture:k-film-cross']);
  assert.deepEqual(ids(reg.findRecords({ formKind: 'sputtering_target' })), ['fixture:k-target']);
  assert.deepEqual(ids(reg.findRecords({ formKind: 'bulk', property: 'density' })), ['fixture:rho-bulk']);
  assert.deepEqual(ids(reg.findRecords({ formKind: 'powder' })), []);
  assert.deepEqual(ids(reg.findRecords({ variant: 'fixture:synthetic-alloy-bulk' })), []);                                // a variant with no records: nothing, no fallback to a similar one
  assert.equal(reg.findRecords({}).count, 8);
});

test('results are the ORIGINAL records, ordered by id (deterministic), and are never changed', () => {
  const reg = build(records());
  const all = reg.findRecords({});
  assert.deepEqual(ids(all), [...ids(all)].sort());
  assert.deepEqual(ids(build([...records()].reverse()).findRecords({})), ids(all));                                       // independent of the input order
  assert.equal(all.records[0], reg.snapshot.records.find(r => r.id === all.records[0].id));                                // the same frozen object, not a copy
  assert.ok(all.records.every(r => Object.isFrozen(r)));
  const before = JSON.stringify(reg.snapshot);
  reg.findRecords({ variant: BULK }); reg.findRecords({ variant: BULK, property: 'thermal_conductivity' });
  assert.equal(JSON.stringify(reg.snapshot), before);
  assert.throws(() => { (all.records as PropertyRecord[]).push(all.records[0]); }, TypeError);
});

test('filters on status, verification, source and version', () => {
  const reg = build([
    ...records().slice(0, 1),
    kRecord('fixture:k-eval', BULK, 2.4, { conditions: { temperature: q(350, 'K') } as never, provenance: withProv({ status: 'evaluated', method: undefined }) as never }),
    kRecord('fixture:k-v2', BULK, 2.6, { id: 'fixture:k-v2', version: 2, supersedes: 'fixture:k-bulk-300', conditions: { temperature: q(300, 'K') } as never, provenance: withProv({ verification: { status: 'verified_against_source', verifiedBy: 'СИНТЕТИЧЕСКИЙ', verifiedAt: '2000-01-02' } }) as never }),
    kRecord('fixture:k-book', BULK, 2.7, { conditions: { temperature: q(360, 'K') } as never, provenance: withProv({ source: { type: 'book', title: 'СИНТЕТИЧЕСКАЯ КНИГА', year: 2000, identifiers: [{ type: 'isbn', value: '978-0-306-40615-7' }] } }) as never }),
  ]);
  assert.deepEqual(ids(reg.findRecords({ status: 'evaluated' })), ['fixture:k-eval']);
  assert.deepEqual(ids(reg.findRecords({ status: 'measured' })), ['fixture:k-book', 'fixture:k-v2']);
  assert.deepEqual(ids(reg.findRecords({ status: 'user_input' })), []);
  assert.deepEqual(ids(reg.findRecords({ verification: 'verified_against_source' })), ['fixture:k-v2']);
  assert.deepEqual(ids(reg.findRecords({ sourceType: 'book' })), ['fixture:k-book']);
  assert.deepEqual(ids(reg.findRecords({ sourceIdentifier: { type: 'isbn', value: '9780306406157' } })), ['fixture:k-book']);          // separators are ignored
  assert.deepEqual(ids(reg.findRecords({ sourceIdentifier: { type: 'doi', value: 'https://doi.org/10.0000/SYNTHETIC.FIXTURE' } })), ['fixture:k-eval', 'fixture:k-v2']);   // a DOI in URL form and another case
  assert.deepEqual(ids(reg.findRecords({ sourceIdentifier: { type: 'doi', value: '10.0000/synthetic.fixture' }, status: 'measured' })), ['fixture:k-v2']);   // filters combine with AND
  assert.deepEqual(ids(reg.findRecords({ sourceIdentifier: { type: 'doi', value: '10.0000/synthetic.fixture' }, status: 'user_input' })), []);
  assert.deepEqual(ids(reg.findRecords({ sourceIdentifier: { type: 'isbn', value: '9780306406157' }, includeSuperseded: true })), ['fixture:k-book']);
  assert.deepEqual(ids(reg.findRecords({ version: 2 })), ['fixture:k-v2']);
  assert.deepEqual(ids(reg.findRecords({ version: 3 })), []);
});

test('superseded records are left out unless asked for', () => {
  const reg = build([kRecord('fixture:k-v1', BULK, 2), kRecord('fixture:k-v2', BULK, 3, { version: 2, supersedes: 'fixture:k-v1' })]);
  assert.deepEqual(ids(reg.findRecords({ variant: BULK })), ['fixture:k-v2']);
  assert.deepEqual(ids(reg.findRecords({ variant: BULK, includeSuperseded: true })), ['fixture:k-v1', 'fixture:k-v2']);
  assert.deepEqual(ids(reg.findRecords({ variant: BULK, version: 1 })), []);
  assert.deepEqual(ids(reg.findRecords({ variant: BULK, version: 1, includeSuperseded: true })), ['fixture:k-v1']);
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity' }).status, 'unique_record');
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity', includeSuperseded: true }).status, 'multiple_records');
  const old = reg.findRecords({ variant: BULK, includeSuperseded: true }).matches.find(m => m.record.id === 'fixture:k-v1')!;
  assert.equal(old.superseded, true);
  assert.ok(old.caveats.includes('запись заменена более новой'));
});

test('conditions: exact filters; a condition that the record does not state never matches; no value applies outside its stated conditions', () => {
  const reg = build(records());
  const k = (conditions: RegistryQuery['conditions'], extra: Partial<RegistryQuery> = {}) => ids(reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions, ...extra }));
  assert.deepEqual(k({ temperature: q(300, 'K') }), ['fixture:k-bulk-300', 'fixture:k-bulk-range', 'user:k-user']);              // the point 300 K and the range 300..500 K that declares it
  assert.deepEqual(k({ temperature: q(400, 'K') }), ['fixture:k-bulk-400', 'fixture:k-bulk-range']);
  assert.deepEqual(k({ temperature: q(450, 'K') }), ['fixture:k-bulk-range']);                                                      // only the range declares 450 K
  assert.deepEqual(k({ temperature: q(310, 'K') }), ['fixture:k-bulk-range']);                                                      // 310 K is NOT 300 K: no rounding, no nearest value
  assert.deepEqual(k({ temperature: q(600, 'K') }), []);                                                                            // outside every stated condition: no data, no extrapolation
  assert.deepEqual(k({ temperature: q(26.85, 'degC') }), ['fixture:k-bulk-300', 'fixture:k-bulk-range', 'user:k-user']);       // the same absolute temperature on the Celsius scale
  assert.deepEqual(k({ temperature: q(300.0000001, 'K') }), ['fixture:k-bulk-range']);                                              // exact comparison
  assert.deepEqual(k({ direction: 'in_plane' }), []);                                                                                // bulk records state no direction: nothing is assumed
  assert.deepEqual(k({ pressure: q(1, 'bar') }), []);
  assert.deepEqual(ids(reg.findRecords({ variant: FILM, conditions: { direction: 'cross_plane' } })), ['fixture:k-film-cross']);
  assert.deepEqual(ids(reg.findRecords({ variant: FILM, conditions: { direction: 'in_plane', thickness: q(0.1, 'um') } })), ['fixture:k-film']);   // 0.1 um is exactly 100 nm
  assert.deepEqual(ids(reg.findRecords({ variant: FILM, conditions: { thickness: q(101, 'nm') } })), []);
  assert.deepEqual(ids(reg.findRecords({ variant: FILM, conditions: { temperature: q(300, 'K'), direction: 'in_plane' } })), ['fixture:k-film']);
});

test('malformed queries are reported, never interpreted', () => {
  const reg = build(records());
  const bad: unknown[] = [null, 5, 'x', [], { variant: 'bulk' }, { property: 'hardness' }, { formKind: 'brick' }, { status: 'guess' }, { verification: 'checked' }, { sourceType: 'blog' }, { version: 0 }, { version: 1.5 },
    { includeSuperseded: 'yes' }, { extra: 1 }, { sourceIdentifier: { type: 'isbn' } }, { sourceIdentifier: { type: 'orcid', value: 'x' } }, { sourceIdentifier: { type: 'doi', value: '' } },
    { conditions: { temperature: q(-5, 'K') } }, { conditions: { temperature: q(10, 'K_delta') } }, { conditions: { pressure: q(1, 'bar_g') } }, { conditions: { thickness: q(0, 'nm') } },
    { conditions: { direction: 'sideways' } }, { conditions: { unknown: 1 } }, { conditions: 5 }, { conditions: { temperature: { value: 300, unit: 'K', extra: 1 } } }];
  for (const query of bad) {
    let result: ReturnType<typeof reg.findRecords> | undefined;
    assert.doesNotThrow(() => { result = reg.findRecords(query as never); }, JSON.stringify(query));
    assert.equal(result!.count, 0, JSON.stringify(query));
    assert.ok(result!.issues.length > 0, JSON.stringify(query));
    assert.equal(result!.status, 'invalid_query', JSON.stringify(query));
  }
  assert.equal(reg.findRecords({ variant: BULK }).issues.length, 0);
});

test('statuses: unique_record, multiple_records, not_available - a single record is a FOUND record, not a recommendation', () => {
  const reg = build(records());
  const one = reg.findRecords({ variant: FILM, property: 'thermal_conductivity', conditions: { direction: 'in_plane' } });
  assert.equal(one.status, 'unique_record');
  assert.equal(one.count, 1);
  assert.equal(one.records[0], reg.snapshot.records.find(r => r.id === 'fixture:k-film'));              // the original frozen record
  assert.equal(one.suitability, 'not_assessed');                                                         // never "fit for calculation", never "recommended"
  const many = reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(300, 'K') } });
  assert.equal(many.status, 'multiple_records');
  assert.deepEqual(ids(many), ['fixture:k-bulk-300', 'fixture:k-bulk-range', 'user:k-user']);          // ALL of them, none chosen
  assert.equal(many.suitability, 'not_assessed');
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity' }).status, 'multiple_records');
  const none = reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(600, 'K') } });
  assert.equal(none.status, 'not_available');
  assert.deepEqual(none.records, []);
  assert.equal(none.suitability, 'not_assessed');
  assert.deepEqual(reg.findRecords({ variant: 'fixture:synthetic-alloy-bulk', property: 'density' }).absence, { otherCurrentRecordsOfVariantAndProperty: 0, recordsNotStatingQueriedConditions: 0 });
  assert.equal(reg.findRecords({ query: 1 } as never).status, 'invalid_query');
  assert.equal(reg.findRecords({}).status, 'multiple_records');
  // "unique" says only that one record was found: even a verified-looking single record carries its caveats and nothing is promoted
  const verified = build([kRecord('fixture:k-v', BULK, 2, { provenance: withProv({ verification: { status: 'verified_against_source', verifiedBy: 'СИНТЕТИЧЕСКИЙ', verifiedAt: '2000-01-02' } }) as never })]).findRecords({ variant: BULK });
  assert.equal(verified.status, 'unique_record');
  assert.equal(verified.suitability, 'not_assessed');
});

test('every found record comes with what qualifies it: conditions, status, verification, uncertainty kind, caveats - nothing is hidden', () => {
  const reg = build([
    kRecord('fixture:k-unknown', BULK, 2, { uncertainty: { kind: 'unknown' } }),
    kRecord('fixture:k-model', BULK, 3, { conditions: { temperature: q(400, 'K') } as never, provenance: withProv({ status: 'model_estimate', method: 'СИНТЕТИЧЕСКАЯ модель' }) as never, uncertainty: { kind: 'bounds', lower: 1, upper: 5, origin: 'stated_in_source' } }),
  ]);
  const result = reg.findRecords({ variant: BULK });
  const unknown = result.matches.find(m => m.record.id === 'fixture:k-unknown')!;
  assert.deepEqual(unknown.conditions, { temperature: { value: 300, unit: 'K' } });
  assert.equal(unknown.provenanceStatus, 'measured');
  assert.equal(unknown.verification, 'unverified');
  assert.equal(unknown.uncertaintyKind, 'unknown');
  assert.ok(unknown.caveats.includes('запись не сверена с первоисточником'));
  assert.ok(unknown.caveats.includes('неопределённость неизвестна'));                                   // an unknown uncertainty stays unknown - never a zero, never hidden
  const model = result.matches.find(m => m.record.id === 'fixture:k-model')!;
  assert.equal(model.provenanceStatus, 'model_estimate');
  assert.equal(model.uncertaintyKind, 'bounds');
  assert.ok(model.caveats.includes('значение — оценка по модели'));
  assert.ok(model.caveats.some(c => /только границы/.test(c)));
  assert.deepEqual(result.matches.map(m => m.record.id), ids(result));                                  // the same order as the records
  assert.ok(result.matches.every(m => m.record === reg.snapshot.records.find(r => r.id === m.record.id) && Object.isFrozen(m) && Object.isFrozen(m.caveats)));
  // there is no ready-to-use Measured anywhere in an answer, and no value-getting function
  const names = [...Object.keys(reg), ...Object.keys(result), ...Object.keys(result.matches[0])];
  assert.ok(!names.some(n => /measured|getValue|nominal|value$/i.test(n)), names.join());
  assert.ok(!JSON.stringify(result).includes('"standardUncertainty"'));
});

test('a point, a declared range and a requested temperature: the answer keeps which one it was, nothing is interpolated or extended', () => {
  const reg = build(records());
  const k = (t: number) => reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(t, 'K') } });
  const at300 = k(300);
  const point = at300.matches.find(m => m.record.id === 'fixture:k-bulk-300')!;
  const range = at300.matches.find(m => m.record.id === 'fixture:k-bulk-range')!;
  assert.deepEqual(point.temperature, { kind: 'stated_point', temperature: { value: 300, unit: 'K' } });
  assert.deepEqual(range.temperature, { kind: 'declared_range', range: { min: { value: 300, unit: 'K' }, max: { value: 500, unit: 'K' } } });     // the ORIGINAL range, kept
  assert.ok(range.caveats.some(c => /диапазона температур, а не измерено при каждой температуре/.test(c)));                                        // not a point measurement at every temperature
  assert.ok(!point.caveats.some(c => /диапазона/.test(c)));
  assert.deepEqual(reg.findRecords({ variant: BULK }).matches.find(m => m.record.id === 'fixture:k-bulk-300')!.temperature, { kind: 'not_requested' });
  // the value returned is the record's own: no value is computed for the requested temperature
  assert.equal(range.record.value.value, 2.5);
  assert.deepEqual(ids(k(450)), ['fixture:k-bulk-range']);
  assert.equal(k(450).records[0].value.value, 2.5);
  // between two points: nothing - the two neighbours (300 K and 400 K) are not interpolated
  assert.deepEqual(ids(build([records()[0], records()[1]]).findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(350, 'K') } })), []);
  assert.equal(build([records()[0], records()[1]]).findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(350, 'K') } }).status, 'not_available');
  // beyond the declared range: nothing - the range is not extended; and a range is not a point at its ends' neighbours
  assert.deepEqual(ids(k(500)), ['fixture:k-bulk-range']);                                                                                          // the range closes at 500 K inclusive
  assert.deepEqual(ids(k(500.0001)), []);
  assert.deepEqual(ids(k(299.9999)), []);
});

test('not_available explains with COUNTS only: other records of the variant and property, and records that do not state the queried condition', () => {
  const reg = build(records());
  const result = reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { direction: 'in_plane' } });
  assert.equal(result.status, 'not_available');
  assert.deepEqual(result.absence, { otherCurrentRecordsOfVariantAndProperty: 4, recordsNotStatingQueriedConditions: 4 });                           // none of the four states a direction
  const beyond = reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(900, 'K') } });
  assert.deepEqual(beyond.absence, { otherCurrentRecordsOfVariantAndProperty: 4, recordsNotStatingQueriedConditions: 0 });                           // they all state a temperature - just not this one
  assert.ok(!('records' in (beyond.absence as object)) && !JSON.stringify(beyond.absence).includes('value'));                                        // no value of another condition is shown
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity', conditions: { temperature: q(900, 'K') } }).count, 0);
  assert.equal(reg.findRecords({ property: 'thermal_conductivity', conditions: { temperature: q(900, 'K') } }).absence, undefined);                  // no exact variant: no counts
});

test('a film is never answered with a bulk value, a bulk piece never with a film value, a target never with either', () => {
  const reg = build([kRecord('fixture:k-bulk', BULK, 2)]);                                                                         // data for the bulk piece only
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity' }).status, 'unique_record');
  assert.equal(reg.findRecords({ variant: FILM, property: 'thermal_conductivity' }).status, 'not_available');
  assert.equal(reg.findRecords({ variant: TARGET, property: 'thermal_conductivity' }).status, 'not_available');
  assert.equal(reg.findRecords({ formKind: 'thin_film', property: 'thermal_conductivity' }).status, 'not_available');
  const reverse = build([kRecord('fixture:k-film', FILM, 1)]);
  assert.equal(reverse.findRecords({ variant: BULK, property: 'thermal_conductivity' }).status, 'not_available');
  assert.deepEqual(reverse.findRecords({ formKind: 'bulk' }).records, []);
  assert.deepEqual(reverse.findRecords({ variant: BULK, property: 'thermal_conductivity' }).absence, { otherCurrentRecordsOfVariantAndProperty: 0, recordsNotStatingQueriedConditions: 0 });   // the film's record is not even counted for the bulk variant
});

test('missing data is stated: coverage lists every property with its number of current records, zeros included', () => {
  const reg = build(records());
  const coverage = reg.coverage(BULK)!;
  assert.equal(coverage.length, materials.PROPERTY_DEFINITIONS.length);
  assert.deepEqual(coverage.find(c => c.property === 'thermal_conductivity'), { property: 'thermal_conductivity', currentRecords: 4 });
  assert.deepEqual(coverage.find(c => c.property === 'density'), { property: 'density', currentRecords: 1 });
  assert.deepEqual(coverage.find(c => c.property === 'molar_mass'), { property: 'molar_mass', currentRecords: 0 });
  assert.equal(reg.coverage('fixture:unknown'), undefined);
  assert.deepEqual(reg.coverage('fixture:synthetic-alloy-bulk')!.filter(c => c.currentRecords > 0), []);
});

test('nothing chooses among records: not the latest version, not the smallest uncertainty, not the "best" source; no averaging; same result for any input order', () => {
  const names = [...Object.keys(materials), ...Object.keys(build(records()))];
  assert.ok(!names.some(n => /select|choose|pick|average|mean(?!ing)|median|merge|combine|interpolat|extrapolat|best|prefer/i.test(n)), names.join());
  const reg = build([kRecord('fixture:k-a', BULK, 2, { uncertainty: { kind: 'standard', u: 0.001, origin: 'stated_in_source' } }), kRecord('fixture:k-b', BULK, 4, { version: 9, uncertainty: { kind: 'standard', u: 5, origin: 'stated_in_source' }, provenance: withProv({ source: { ...syntheticSource(), title: 'СИНТЕТИЧЕСКАЯ СТАТЬЯ 2' } }) as never })]);
  const result = reg.findRecords({ variant: BULK, property: 'thermal_conductivity' });
  assert.equal(result.status, 'multiple_records');                                                                                 // not "the one with u = 0.001", not "version 9"
  assert.deepEqual(result.records.map(r => r.value.value), [2, 4]);                                                                // no 3 (the mean), no single one
  assert.deepEqual(ids(build([...records()].reverse()).findRecords({})), ids(build(records()).findRecords({})));                    // the order of the input does not change the answer
  assert.deepEqual(JSON.stringify(build([...records()].reverse()).findRecords({})), JSON.stringify(build(records()).findRecords({})));
});

test('the answer cannot be used to change the snapshot: results and their parts are frozen, the registry exposes no Map or Set, the input is copied', () => {
  const records0 = records();
  const reg = build(records0);
  const before = JSON.stringify(reg.snapshot);
  const result = reg.findRecords({ variant: BULK });
  const attempts: (() => void)[] = [
    () => { (result.records as PropertyRecord[]).push(result.records[0]); },
    () => { (result.records as PropertyRecord[])[0] = result.records[1]; },
    () => { (result.records[0].value as { value: number }).value = 1e9; },
    () => { (result.records[0].conditions as { temperature?: unknown }).temperature = undefined; },
    () => { (result.records[0].provenance as { status: string }).status = 'evaluated'; },
    () => { (result.matches as unknown[]).length = 0; },
    () => { (result.matches[0].caveats as string[]).push('x'); },
    () => { (result.differences as unknown[]).push(1); },
    () => { (result as { status: string }).status = 'unique_record'; },
    () => { (reg.snapshot.records as PropertyRecord[]).pop(); },
    () => { (reg.snapshot.catalog.variants[0] as { id: string }).id = 'fixture:hijacked'; },
    () => { (reg.version as { dataVersion: string }).dataVersion = 'x'; },
    () => { (reg.getVariant(BULK) as { form: unknown }).form = null; },
    () => { (reg.coverage(BULK) as unknown as CoverageLike[])[0].currentRecords = 99; },
    () => { (reg.differences() as unknown[]).push(1); },
  ];
  for (const attempt of attempts) assert.throws(attempt, TypeError);
  assert.equal(JSON.stringify(reg.snapshot), before);
  // the input objects: the registry holds copies, so changing the fixtures afterwards changes nothing, and building the registry changed none of them
  const copyOfInput = JSON.stringify(records());
  assert.equal(JSON.stringify(records0), copyOfInput);
  (records0[0].value as { value: number }).value = 12345;
  assert.equal(reg.snapshot.records.find(r => r.id === 'fixture:k-bulk-300')!.value.value, 2);
  // no Map or Set (whose contents Object.freeze cannot protect) is reachable from the registry or from an answer
  const seen = new Set<unknown>();
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    assert.ok(!(x instanceof Map) && !(x instanceof Set) && !(x instanceof WeakMap) && !(x instanceof WeakSet), 'a Map or Set is reachable');
    for (const key of Reflect.ownKeys(x)) walk((x as Record<PropertyKey, unknown>)[key]);
  };
  walk(reg); walk(result); walk(reg.differences()); walk(reg.coverage(BULK)); walk(reg.history('fixture:k-bulk-300'));
  interface CoverageLike { currentRecords: number }
});
