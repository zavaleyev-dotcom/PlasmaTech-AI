import test from 'node:test';
import assert from 'node:assert/strict';
import * as materials from '../src/materials';
import { createMaterialPropertyRegistry, contentFingerprint, type MaterialCatalog, type PropertyRecord, type PropertySeries, type SeriesQuery } from '../src/materials';
import { syntheticSystemCatalog, syntheticTarget } from './materials-fixtures';
import { kRecord, BULK, FILM, densityRecord, syntheticProvenance, syntheticSource } from './materials-property-fixtures';
import { bulkSeries, filmSeries, singleTable, perRowTable, row, analytic, obs, q, term, segment } from './materials-series-fixtures';

const catalog = (): MaterialCatalog => { const c = syntheticSystemCatalog(); return { ...c, variants: [...c.variants, syntheticTarget()] }; };
const records = (): PropertyRecord[] => [kRecord('fixture:k-bulk', BULK, 2), kRecord('fixture:k-film', FILM, 1), densityRecord({ id: 'fixture:rho-bulk' })];
const allSeries = (): PropertySeries[] => [bulkSeries({ id: 'fixture:s-points' }), singleTable({ id: 'fixture:s-table' }), analytic({ id: 'fixture:s-analytic' })];
const create = (series?: unknown, recs: PropertyRecord[] = records(), c: unknown = catalog()) => createMaterialPropertyRegistry({ catalog: c, records: recs, ...(series === undefined ? {} : { series }), dataVersion: 'fixture-1' });
const ok = (series?: unknown) => { const r = create(series); assert.equal(r.ok, true, JSON.stringify(r.report.issues.filter(i => i.severity === 'error').map(i => i.code))); if (!r.ok) throw new Error('no registry'); return r.registry; };
const errs = (r: { report: { issues: readonly { severity: string; code: string }[] } }): string[] => r.report.issues.filter(i => i.severity === 'error').map(i => i.code);
const ids = (r: { series: readonly { id: string }[] }): string[] => r.series.map(s => s.id);
const identityOf = (variant: string): string => catalog().variants.find(v => v.id === variant)!.identity;
const doi = (n: number) => ({ ...syntheticSource(), identifiers: [{ type: 'doi' as const, value: `10.0000/synthetic.fixture-${n}` }] });

test('S1. without series, and with `series: []`, the registry is exactly that of M1.3.3: same version, same snapshot, no new field', () => {
  const absent = ok(undefined); const empty = ok([]);
  assert.deepEqual(absent.version, empty.version);
  assert.deepEqual(Object.keys(absent.version).sort(), ['contentFingerprint', 'dataVersion', 'recordCount', 'schemaVersion', 'variantCount']);
  assert.deepEqual(Object.keys(absent.snapshot).sort(), ['catalog', 'records']);
  assert.deepEqual(Object.keys(empty.snapshot).sort(), ['catalog', 'records']);
  const c = catalog();
  const m133 = contentFingerprint({ identities: [...c.identities].sort((a, b) => (a.id < b.id ? -1 : 1)), variants: [...c.variants].sort((a, b) => (a.id < b.id ? -1 : 1)), records: [...records()].sort((a, b) => (a.id < b.id ? -1 : 1)) });
  assert.equal(absent.version.contentFingerprint, m133);                                  // the fingerprint of M1.3.3, byte for byte
  assert.deepEqual(absent.findSeries({}), empty.findSeries({}));
  assert.equal(absent.findSeries({}).status, 'not_available');
  assert.equal(absent.findSeries({}).count, 0);
  assert.equal(absent.findSeries({}).total, 0);
});

test('S2. a non-empty series extends the snapshot and the version; the scalar records are untouched and separate', () => {
  const plain = ok(undefined); const reg = ok(allSeries());
  assert.equal(reg.version.seriesCount, 3);
  assert.equal(reg.version.recordCount, 3);
  assert.notEqual(reg.version.contentFingerprint, plain.version.contentFingerprint);
  assert.deepEqual(reg.snapshot.series?.map(s => s.id).sort(), ['fixture:s-analytic', 'fixture:s-points', 'fixture:s-table']);
  assert.deepEqual(reg.snapshot.records, plain.snapshot.records);                         // the records are not changed by the series
  assert.ok(reg.snapshot.records.every(r => !('kind' in r) || (r as { kind?: string }).kind === undefined));
  assert.deepEqual(reg.findRecords({}).records.map(r => r.id), plain.findRecords({}).records.map(r => r.id));   // findRecords never returns a series
  assert.deepEqual(reg.coverage(BULK), plain.coverage(BULK));
  assert.equal(reg.findRecords({ variant: BULK, property: 'thermal_conductivity' }).count, 1);                // a series is not a scalar value
  // the fingerprint: stable, independent of the order, sensitive to any change
  assert.equal(ok([...allSeries()].reverse()).version.contentFingerprint, reg.version.contentFingerprint);
  assert.equal(ok(allSeries()).version.contentFingerprint, reg.version.contentFingerprint);
  assert.notEqual(ok([bulkSeries({ id: 'fixture:s-points', version: 1, points: [obs('p1', 300, 1), obs('p2', 400, 3)] }), singleTable({ id: 'fixture:s-table' }), analytic({ id: 'fixture:s-analytic' })]).version.contentFingerprint, reg.version.contentFingerprint);
  assert.notEqual(ok([allSeries()[0]]).version.contentFingerprint, reg.version.contentFingerprint);
});

test('S3. all-or-nothing: one damaged series refuses the whole registry, with a report and no registry', () => {
  const good = allSeries();
  for (const bad of [bulkSeries({ id: 'fixture:bad', points: [obs('p1', 300, 1)] }), singleTable({ id: 'fixture:bad', interpolation: undefined as never }), analytic({ id: 'fixture:bad', segments: [] }), null, 5, 'x', [], {}, { ...bulkSeries(), kind: 'curve' }]) {
    const r = create([...good, bad]);
    assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 60));
    assert.equal(r.registry, null);
    assert.ok(errs(r).length > 0);
    assert.equal(r.report.ok, false);
  }
  assert.equal(create('not a list').ok, false);
  assert.equal(create({}).ok, false);
  assert.equal(create(null).ok, false);
  assert.equal(create(allSeries(), records(), 'not a catalog').ok, false);
  assert.equal(createMaterialPropertyRegistry({ catalog: catalog(), records: records(), series: allSeries(), dataVersion: 'fixture-1', extra: 1 }).ok, false);
  // the good part alone is fine: nothing was half-registered
  assert.equal(create(good).ok, true);
});

test('S4. identity: unique ids in one space with the records; no silent replacement of a version', () => {
  assert.deepEqual(errs(create([bulkSeries({ id: 'fixture:dup' }), singleTable({ id: 'fixture:dup' })])), ['duplicate_id']);
  assert.ok(errs(create([bulkSeries({ id: 'fixture:k-bulk' })])).includes('duplicate_id'));                  // the id of a record
  assert.ok(errs(create([bulkSeries({ id: 'fixture:dup' }), bulkSeries({ id: 'fixture:dup', version: 2 })])).includes('duplicate_id'));   // a new version needs a new id and `supersedes`
  const v1 = bulkSeries({ id: 'fixture:s-1' });
  assert.equal(create([v1, bulkSeries({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-1' })]).ok, true);
  assert.deepEqual(errs(create([v1, bulkSeries({ id: 'fixture:s-2', version: 1, supersedes: 'fixture:s-1' })])), ['supersedes_invalid']);
  assert.deepEqual(errs(create([bulkSeries({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-0' })])), ['supersedes_invalid']);
  assert.deepEqual(errs(create([v1, singleTable({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-1' })])), ['supersedes_invalid']);          // another kind
  assert.ok(errs(create([v1, bulkSeries({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-1', property: 'density' })])).includes('supersedes_invalid'));
  assert.ok(errs(create([v1, bulkSeries({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-1' }), bulkSeries({ id: 'fixture:s-3', version: 3, supersedes: 'fixture:s-1' })])).includes('supersession_fork'));
  assert.ok(errs(create([bulkSeries({ id: 'fixture:s-1', version: 2, supersedes: 'fixture:s-2' }), bulkSeries({ id: 'fixture:s-2', version: 3, supersedes: 'fixture:s-1' })])).length > 0);   // a cycle
  assert.ok(errs(create([bulkSeries({ id: 'fixture:s-1', supersedes: 'fixture:s-1' })])).includes('supersedes_invalid'));
});

test('S5. the material, the variant and the physical conditions are checked against the catalog', () => {
  assert.ok(errs(create([bulkSeries({ id: 'fixture:s-x', variant: 'fixture:nowhere' })])).includes('missing_reference'));
  assert.ok(errs(create([bulkSeries({ id: 'ref:s-x' })])).includes('namespace_mismatch'));                      // a shipped series on a fixture variant
  assert.ok(errs(create([bulkSeries({ id: 'fixture:s-x', property: 'no_such_property' })])).includes('unknown_property'));
  assert.ok(errs(create([filmSeries({ id: 'fixture:s-film', commonConditions: {} })])).includes('missing_condition'));      // a thin film without thickness and direction
  assert.equal(create([filmSeries({ id: 'fixture:s-film' })]).ok, true);
  assert.ok(errs(create([analytic({ id: 'fixture:s-a', variant: FILM })])).includes('missing_condition'));
  assert.ok(errs(create([singleTable({ id: 'fixture:s-t', variant: FILM })])).includes('missing_condition'));
  assert.ok(errs(create(allSeries(), records(), { identities: [], variants: [] })).length > 0);
});

test('S6. the snapshot is an independent, deep-frozen copy; results are the stored objects and cannot be used to change them', () => {
  const input = allSeries();
  const reg = ok(input);
  const before = JSON.stringify(reg.snapshot.series);
  ((input[0] as unknown) as { points: unknown[] }).points.push(obs('zz', 999, 9));
  ((input[1] as unknown) as { rows: unknown[] }).rows.length = 0;
  assert.equal(JSON.stringify(reg.snapshot.series), before);
  assert.notEqual(reg.snapshot.series![0], input[0]);
  assert.ok(Object.isFrozen(reg.snapshot.series) && Object.isFrozen(reg.snapshot.series![0]));
  const found = reg.findSeries({ seriesKind: 'points' });
  assert.ok(Object.isFrozen(found) && Object.isFrozen(found.series) && Object.isFrozen(found.matches) && Object.isFrozen(found.matches[0]) && Object.isFrozen(found.series[0]));
  assert.equal(found.series[0], reg.snapshot.series!.find(s => s.id === 'fixture:s-points'));               // the stored object itself
  assert.throws(() => { (found.series[0] as { id: string }).id = 'x'; }, TypeError);
  assert.throws(() => { ((found.series[0] as materials.PointSeries).points as unknown[]).push(1); }, TypeError);
  assert.throws(() => { (found.series as unknown as unknown[]).push(1); }, TypeError);
  assert.throws(() => { (found.matches[0] as { kind: string }).kind = 'x'; }, TypeError);
  assert.throws(() => { (reg.snapshot.series as unknown as unknown[]).length = 0; }, TypeError);
  assert.equal(Object.isFrozen(reg), true);
  assert.equal(reg.findSeries({ seriesKind: 'points' }).series[0], found.series[0]);                         // the same object on every call: nothing is rebuilt
});

test('S7. findSeries filters: material, variant, property, kind, id, version; combined with AND; ordered by id', () => {
  const list: PropertySeries[] = [
    bulkSeries({ id: 'fixture:s-points' }), singleTable({ id: 'fixture:s-table' }), analytic({ id: 'fixture:s-analytic' }),
    filmSeries({ id: 'fixture:s-film' }), bulkSeries({ id: 'fixture:s-density', property: 'density', points: [obs('p1', 300, 1), obs('p2', 400, 2)].map(o => ({ ...o, value: { type: 'scalar' as const, value: o.value.type === 'scalar' ? o.value.value : 1, unit: 'kg_m3' as const } })) as never }),
  ];
  const reg = ok(list);
  const find = (query: SeriesQuery) => ids(reg.findSeries(query));
  assert.deepEqual(find({}), ['fixture:s-analytic', 'fixture:s-density', 'fixture:s-film', 'fixture:s-points', 'fixture:s-table']);
  assert.deepEqual(find({}), ids(ok([...list].reverse()).findSeries({})));                                  // the same answer for any input order
  assert.deepEqual(find({ variant: BULK }), ['fixture:s-analytic', 'fixture:s-density', 'fixture:s-points', 'fixture:s-table']);
  assert.deepEqual(find({ variant: FILM }), ['fixture:s-film']);
  assert.deepEqual(find({ variant: BULK, property: 'thermal_conductivity' }), ['fixture:s-analytic', 'fixture:s-points', 'fixture:s-table']);
  assert.deepEqual(find({ property: 'density' }), ['fixture:s-density']);
  assert.deepEqual(find({ seriesKind: 'points' }), ['fixture:s-density', 'fixture:s-film', 'fixture:s-points']);
  assert.deepEqual(find({ seriesKind: 'table' }), ['fixture:s-table']);
  assert.deepEqual(find({ seriesKind: 'analytic' }), ['fixture:s-analytic']);
  assert.deepEqual(find({ seriesKind: 'points', variant: BULK, property: 'thermal_conductivity' }), ['fixture:s-points']);
  assert.deepEqual(find({ seriesId: 'fixture:s-table' }), ['fixture:s-table']);
  assert.deepEqual(find({ seriesId: 'fixture:s-nothing' }), []);
  assert.deepEqual(find({ version: 1 }).length, 5);
  assert.deepEqual(find({ version: 2 }), []);
  assert.deepEqual(find({ materialId: identityOf(BULK) }), find({ variant: BULK }));
  assert.deepEqual(find({ materialId: identityOf(FILM) }), ['fixture:s-film']);
  assert.deepEqual(find({ materialId: 'fixture:no-such-material' }), []);
  assert.equal(reg.findSeries({ seriesId: 'fixture:s-table' }).status, 'unique_series');
  assert.equal(reg.findSeries({ variant: BULK }).status, 'multiple_series');
  assert.equal(reg.findSeries({ seriesId: 'fixture:s-nothing' }).status, 'not_available');
  assert.equal(reg.findSeries({}).suitability, 'not_assessed');
  // every match is described, in the same order, and nothing is chosen
  const all = reg.findSeries({});
  assert.deepEqual(all.matches.map(m => m.series.id), ids(all));
  assert.deepEqual(all.matches.map(m => m.kind), all.series.map(s => s.kind));
  assert.ok(all.matches.every(m => m.caveats.length > 0 && m.superseded === false));
  assert.ok(!('best' in all) && !('selected' in all) && !('recommended' in all));
  // not_available with a variant and property: counts only
  assert.deepEqual(reg.findSeries({ variant: FILM, property: 'density' }).absence, { otherCurrentSeriesOfVariantAndProperty: 0 });
});

test('S8. superseded series are left out unless asked for; nothing is replaced silently', () => {
  const reg = ok([bulkSeries({ id: 'fixture:s-1' }), bulkSeries({ id: 'fixture:s-2', version: 2, supersedes: 'fixture:s-1' })]);
  assert.deepEqual(ids(reg.findSeries({})), ['fixture:s-2']);
  assert.deepEqual(ids(reg.findSeries({ includeSuperseded: true })), ['fixture:s-1', 'fixture:s-2']);
  assert.deepEqual(ids(reg.findSeries({ version: 1 })), []);
  assert.deepEqual(ids(reg.findSeries({ version: 1, includeSuperseded: true })), ['fixture:s-1']);
  assert.equal(reg.findSeries({ includeSuperseded: true }).matches[0].superseded, true);
  assert.ok(reg.findSeries({ includeSuperseded: true }).matches[0].caveats.some(x => x.includes('заменена')));
  assert.equal(reg.snapshot.series!.length, 2);                                                               // the history stays in the snapshot
});

test('S9. the source filter relates to the PRIMARY provenance of the values only', () => {
  const a = syntheticProvenance();
  const b = { ...syntheticProvenance(), source: doi(2), verification: { status: 'verified_against_source' as const, verifiedBy: 'СИНТЕТИЧЕСКИЙ КУРАТОР', verifiedAt: '2000-01-02' } };
  const single = singleTable({ id: 'fixture:s-single', tableProvenance: { mode: 'single_source', provenance: b } });
  const perRow = perRowTable({ id: 'fixture:s-perrow', tableProvenance: { mode: 'per_row', compilation: { citation: 'СИНТЕТИЧЕСКИЙ СБОРНИК' } }, rows: [row('r1', 300, 1), row('r2', 400, 2, { provenance: b }), row('r3', 500, 3)] });
  const points = bulkSeries({ id: 'fixture:s-points', provenance: a });
  const ana = analytic({ id: 'fixture:s-analytic', provenance: b, coefficientCheck: { status: 'independently_checked', attestation: { by: 'СИНТЕТИЧЕСКИЙ КУРАТОР', at: '2000-01-02', method: 'способ' } } });
  const reg = ok([single, perRow, points, ana]);
  const find = (query: SeriesQuery) => ids(reg.findSeries(query));
  const idOf = (n: number) => ({ type: 'doi' as const, value: `10.0000/synthetic.fixture-${n}` });
  assert.deepEqual(find({ sourceIdentifier: { type: 'doi', value: '10.0000/synthetic.fixture' } }), ['fixture:s-perrow', 'fixture:s-points']);       // per_row: some row has it
  assert.deepEqual(find({ sourceIdentifier: idOf(2) }), ['fixture:s-analytic', 'fixture:s-perrow', 'fixture:s-single']);
  assert.deepEqual(find({ sourceIdentifier: { type: 'doi', value: 'https://doi.org/10.0000/SYNTHETIC.FIXTURE-2' } }), ['fixture:s-analytic', 'fixture:s-perrow', 'fixture:s-single']);   // normalised
  assert.deepEqual(find({ sourceIdentifier: idOf(9) }), []);
  assert.deepEqual(find({ verification: 'verified_against_source' }), ['fixture:s-analytic', 'fixture:s-perrow', 'fixture:s-single']);
  assert.deepEqual(find({ verification: 'unverified' }), ['fixture:s-perrow', 'fixture:s-points']);
  // the filters of ONE provenance must hold for the SAME row: no row is both doi-2 and unverified
  assert.deepEqual(find({ sourceIdentifier: idOf(2), verification: 'unverified' }), []);
  assert.deepEqual(find({ sourceIdentifier: idOf(2), verification: 'verified_against_source' }), ['fixture:s-analytic', 'fixture:s-perrow', 'fixture:s-single']);
  assert.deepEqual(find({ sourceType: 'journal_article', status: 'measured' }), ['fixture:s-analytic', 'fixture:s-perrow', 'fixture:s-points', 'fixture:s-single']);
  assert.deepEqual(find({ status: 'evaluated' }), []);
  // what is NOT the primary provenance is not searched: the compilation, a coefficient attestation, an interpolation source
  const interp = singleTable({ id: 'fixture:s-interp', interpolation: { permitted: true, method: 'linear_in_temperature', basis: 'stated_in_source', justification: 'СИНТЕТИЧЕСКОЕ', source: { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК', doi: '10.0000/synthetic.fixture-7' } } });
  const reg2 = ok([interp, perRow]);
  assert.deepEqual(ids(reg2.findSeries({ sourceIdentifier: idOf(7) })), []);
  assert.deepEqual(ids(reg2.findSeries({ sourceType: 'other' })), []);
  assert.deepEqual(ids(reg2.findSeries({ verification: 'verified_against_source' })), ['fixture:s-perrow']);
  // the provenance of a returned series is described, per row for a per_row table
  const m = reg.findSeries({ seriesId: 'fixture:s-perrow' }).matches[0];
  assert.deepEqual(m.verificationStatuses, ['unverified', 'verified_against_source']);
  assert.deepEqual(m.provenanceStatuses, ['measured']);
});

test('S10. an explicit page: deterministic order, `total` of all matches, nothing else changes', () => {
  const list = Array.from({ length: 7 }, (_, i) => bulkSeries({ id: `fixture:s-${i}` }));
  const reg = ok(list);
  const all = ids(reg.findSeries({}));
  assert.equal(all.length, 7);
  const p1 = reg.findSeries({ page: { offset: 0, limit: 3 } });
  assert.deepEqual(ids(p1), all.slice(0, 3)); assert.equal(p1.count, 3); assert.equal(p1.total, 7); assert.equal(p1.status, 'multiple_series');
  assert.deepEqual(ids(reg.findSeries({ page: { offset: 3, limit: 3 } })), all.slice(3, 6));
  assert.deepEqual(ids(reg.findSeries({ page: { offset: 6, limit: 3 } })), all.slice(6));
  const beyond = reg.findSeries({ page: { offset: 20, limit: 3 } });
  assert.equal(beyond.count, 0); assert.equal(beyond.total, 7); assert.equal(beyond.status, 'multiple_series');      // the page is empty, the set is not
  assert.deepEqual(ids(reg.findSeries({ page: { offset: 0, limit: 10000 } })), all);
  assert.equal(reg.findSeries({ page: { offset: 0, limit: 3 } }).matches.length, 3);
  for (const page of [{ offset: -1, limit: 3 }, { offset: 0, limit: 0 }, { offset: 0, limit: 10001 }, { offset: 1.5, limit: 3 }, { offset: 0 }, { limit: 3 }, 5, null, { offset: 0, limit: 3, extra: 1 }]) {
    const r = reg.findSeries({ page } as never);
    assert.equal(r.status, 'invalid_query', JSON.stringify(page)); assert.equal(r.count, 0); assert.ok(r.issues.length > 0);
  }
});

test('S11. a malformed query is reported, never interpreted and never thrown; there is no temperature filter and no ranking', () => {
  const reg = ok(allSeries());
  for (const bad of [null, 5, 'x', [], { extra: 1 }, { seriesKind: 'tabulated' }, { seriesKind: 'point' }, { property: 'nope' }, { variant: 'bad id' }, { materialId: 5 }, { seriesId: '' }, { version: 0 }, { version: 1.5 }, { version: '1' },
    { status: 'x' }, { verification: 'x' }, { sourceType: 'x' }, { sourceIdentifier: { type: 'doi' } }, { sourceIdentifier: { type: 'nope', value: 'x' } }, { sourceIdentifier: 'x' }, { includeSuperseded: 'yes' },
    { temperature: { value: 300, unit: 'K' } }, { conditions: {} }, { sort: 'best' }, { orderBy: 'uncertainty' }, { best: true }, { tolerance: 5 }]) {
    let r: materials.SeriesQueryResult | undefined;
    assert.doesNotThrow(() => { r = reg.findSeries(bad as never); }, JSON.stringify(bad));
    assert.equal(r!.status, 'invalid_query', JSON.stringify(bad));
    assert.equal(r!.count, 0); assert.equal(r!.total, 0); assert.ok(r!.issues.some(i => i.severity === 'error'));
  }
  assert.equal(reg.findSeries({}).status, 'multiple_series');
});

test('S12. M1.3.3 behaves as before with series present; findSeries does not change findRecords or the other methods', () => {
  const plain = ok(undefined); const reg = ok(allSeries());
  for (const query of [{}, { variant: BULK }, { property: 'density' }, { variant: BULK, property: 'thermal_conductivity' }, { includeSuperseded: true }, { conditions: { temperature: q(300, 'K') } }, { status: 'measured' }] as materials.RegistryQuery[]) {
    assert.deepEqual(reg.findRecords(query), plain.findRecords(query), JSON.stringify(query));
  }
  assert.deepEqual(reg.differences(), plain.differences());
  assert.deepEqual(reg.coverage(BULK), plain.coverage(BULK));
  assert.deepEqual(reg.history('fixture:k-bulk'), plain.history('fixture:k-bulk'));
  assert.equal(reg.isSuperseded('fixture:k-bulk'), false);
  assert.deepEqual(reg.getVariant(BULK), plain.getVariant(BULK));
  // an id of a series is not an id of a record
  assert.equal(reg.history('fixture:s-points'), undefined);
  assert.equal(reg.isSuperseded('fixture:s-points'), false);
  assert.ok(!reg.snapshot.records.some(r => r.id === 'fixture:s-points'));
});

test('S13. nothing is computed: no function selects, interpolates, averages or evaluates; the stored series come back exactly as written', () => {
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /evaluat|valueAt|interpol|extrapol|average|best|recommend|select|resample|toRecord|seriesToRecord|asScalar/i.test(n)), names.join());
  const input = allSeries();
  const reg = ok(input);
  for (const s of input) assert.deepEqual(JSON.parse(JSON.stringify(reg.findSeries({ seriesId: s.id }).series[0])), JSON.parse(JSON.stringify(s)));
  assert.deepEqual(Object.keys(reg).sort(), ['coverage', 'differences', 'findRecords', 'findSeries', 'getVariant', 'history', 'isSuperseded', 'report', 'snapshot', 'version']);
  const t = reg.findSeries({ seriesKind: 'table' }).series[0] as materials.TabulatedSeries;
  assert.equal(t.rows.length, 3);                                                                              // no row added, none merged
  assert.deepEqual(t.interpolation, { permitted: false });
  const a = reg.findSeries({ seriesKind: 'analytic' }).matches[0];
  assert.ok(a.caveats.some(x => x.includes('коэффициенты не проверялись')));
});

test('S14. a registry of the largest allowed series is built and searched in reasonable time', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => obs(`r${i}`, 300 + (i % 100), 1 + i * 1e-6));
  const segs = Array.from({ length: 100 }, (_, i) => segment(`s${i}`, 300 + i, 301 + i));
  const started = Date.now();
  const reg = ok([bulkSeries({ id: 'fixture:s-big-points', points: rows }), singleTable({ id: 'fixture:s-big-table', rows }), analytic({ id: 'fixture:s-big-analytic', segments: segs })]);
  assert.equal(reg.findSeries({ variant: BULK }).total, 3);
  assert.ok(Date.now() - started < 10000, `${Date.now() - started} ms`);
  assert.ok(term(0).exponent === 0);
});
