import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as materials from '../src/materials';
import { validatePropertySeries, validatePropertySeriesSet, createPropertySeries, MaterialsError } from '../src/materials';
import { syntheticSystemCatalog, syntheticElement, syntheticCompound } from './materials-fixtures';
import { syntheticProvenance, syntheticSource } from './materials-property-fixtures';
import { bulkSeries, filmSeries, alphaSeries, obs, q, row, singleTable, perRowTable, tableSource } from './materials-series-fixtures';

const issues = (s: unknown, variant?: unknown) => validatePropertySeries(s, variant).issues;
const errs = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'error').map(i => i.code);
const warns = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'warning').map(i => i.code);
const infos = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'info').map(i => i.code);
const bulk = syntheticElement();
const film = syntheticCompound();
const permit = (over: Record<string, unknown> = {}) => ({ permitted: true, method: 'linear_in_temperature', basis: 'curator_decision', justification: 'СИНТЕТИЧЕСКОЕ обоснование', ...over }) as never;
const filmTable = (over: Partial<materials.TabulatedSeries> = {}) => singleTable({ id: 'fixture:table-k-film', variant: 'fixture:synthetic-compound-film', commonConditions: { thickness: q(100, 'nm'), direction: 'in_plane' } as never, ...over });

test('1. a correct single_source table is valid, keeps the rows and gets a frozen copy', () => {
  assert.deepEqual(errs(singleTable()), []);
  assert.deepEqual(errs(singleTable(), bulk), []);
  const t = createPropertySeries(singleTable(), bulk);
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.rows) && Object.isFrozen(t.interpolation));
  assert.deepEqual(t.rows.map(r => r.id), ['r1', 'r2', 'r3']);
  assert.throws(() => createPropertySeries(singleTable({ id: 'bad id' })), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_series');
});

test('2. a correct per_row table is valid; the compilation is optional and is not an origin of the values', () => {
  assert.deepEqual(errs(perRowTable()), []);
  assert.deepEqual(errs(perRowTable({ tableProvenance: { mode: 'per_row' } })), []);
  assert.deepEqual(errs(perRowTable({ tableProvenance: { mode: 'per_row', compilation: { citation: '' } } })), ['invalid_source']);
  // a compilation does not replace the provenance of a row
  const rows = [row('r1', 300, 1), obs('r2', 400, 2), row('r3', 500, 3)];
  assert.deepEqual(errs(perRowTable({ rows })), ['invalid_table_provenance']);
});

test('3. rows of several sources: every row names its own', () => {
  const other = { ...syntheticProvenance(), source: { ...syntheticSource(), title: 'СИНТЕТИЧЕСКАЯ СТАТЬЯ B (не существует)', identifiers: [{ type: 'doi' as const, value: '10.0000/synthetic.fixture-b' }] }, locator: { table: 'Table B' } };
  const t = perRowTable({ rows: [row('r1', 300, 1), row('r2', 400, 2, { provenance: other }), row('r3', 500, 3)] });
  assert.deepEqual(errs(t), []);
  const kept = createPropertySeries(t);
  assert.deepEqual(kept.rows.map(r => r.provenance?.source.title), [syntheticSource().title, 'СИНТЕТИЧЕСКАЯ СТАТЬЯ B (не существует)', syntheticSource().title]);
  assert.deepEqual(kept.correlation, { kind: 'unknown' });                        // no common correlation model is created for several sources
});

test('4. different provenance statuses in different rows are stored; no status is raised', () => {
  const evaluated = { ...syntheticProvenance(), status: 'evaluated' as const };
  const estimate = { ...syntheticProvenance(), status: 'model_estimate' as const };
  const t = perRowTable({ rows: [row('r1', 300, 1), row('r2', 400, 2, { provenance: evaluated }), row('r3', 500, 3, { provenance: estimate })] });
  assert.deepEqual(errs(t), []);
  assert.deepEqual(createPropertySeries(t).rows.map(r => r.provenance?.status), ['measured', 'evaluated', 'model_estimate']);
  // a user series (user:) needs user_input everywhere; a reference one (ref:) forbids it anywhere
  const userRow = (id: string, k: number) => row(id, k, 1, { provenance: { status: 'user_input', source: { type: 'user_data', title: 'СИНТЕТИЧЕСКИЙ ввод пользователя' }, verification: { status: 'not_applicable' } } as never });
  assert.deepEqual(errs(perRowTable({ id: 'user:t1', rows: [userRow('r1', 300), row('r2', 400, 2), userRow('r3', 500)] })), ['namespace_mismatch']);
  assert.deepEqual(errs(perRowTable({ id: 'user:t1', rows: [userRow('r1', 300), userRow('r2', 400), userRow('r3', 500)] })), []);
  assert.deepEqual(errs(perRowTable({ id: 'ref:t1', rows: [userRow('r1', 300), row('r2', 400, 2), row('r3', 500, 3)] })), ['namespace_mismatch']);
});

test('5-6. per_row without a row provenance is an error, and single_source with a row provenance is an error: no silent inheritance, no conflicting second origin', () => {
  const missing = perRowTable({ rows: [row('r1', 300, 1), obs('r2', 400, 2), obs('r3', 500, 3)] });
  assert.deepEqual(errs(missing), ['invalid_table_provenance', 'invalid_table_provenance']);
  assert.ok(issues(missing).some(i => i.path === 'series.rows[1].provenance'));
  const extra = singleTable({ rows: [obs('r1', 300, 1), row('r2', 400, 2), obs('r3', 500, 3)] });
  assert.deepEqual(errs(extra), ['invalid_table_provenance']);
  // the very same provenance repeated is still a second origin: the mode is explicit
  assert.deepEqual(errs(singleTable({ rows: [row('r1', 300, 1), row('r2', 400, 2)] })), ['invalid_table_provenance', 'invalid_table_provenance']);
  // ambiguous combinations of modes and fields
  assert.deepEqual(errs(singleTable({ tableProvenance: { mode: 'single_source' } as never })), ['invalid_table_provenance']);
  assert.deepEqual(errs(singleTable({ tableProvenance: { mode: 'single_source', provenance: syntheticProvenance(), compilation: tableSource } as never })), ['invalid_table_provenance']);
  assert.deepEqual(errs(perRowTable({ tableProvenance: { mode: 'per_row', provenance: syntheticProvenance() } as never })), ['invalid_table_provenance']);
  assert.deepEqual(errs(singleTable({ tableProvenance: { mode: 'both' } as never })), ['invalid_table_provenance']);
  assert.deepEqual(errs(singleTable({ tableProvenance: undefined as never })), ['invalid_table_provenance']);
  assert.deepEqual(errs({ ...singleTable(), provenance: syntheticProvenance() }), ['invalid_series']);        // a table-level `provenance` key is the point-series shape
});

test('7. a damaged source of one row is reported at that row, per_row and single_source', () => {
  const bad = { ...syntheticProvenance(), source: { type: 'nonsense' } };
  const t = perRowTable({ rows: [row('r1', 300, 1), row('r2', 400, 2, { provenance: bad as never }), row('r3', 500, 3)] });
  assert.ok(errs(t).length > 0);
  assert.ok(issues(t).filter(i => i.severity === 'error').every(i => i.path.startsWith('series.rows[1].provenance')));
  assert.ok(errs(singleTable({ tableProvenance: { mode: 'single_source', provenance: bad as never } })).length > 0);
  assert.ok(errs(perRowTable({ rows: [row('r1', 300, 1), row('r2', 400, 2, { provenance: 'x' as never }), row('r3', 500, 3)] })).includes('invalid_provenance'));
});

test('8-9. one temperature in rows of different publications, and equal values in different rows, are stored as different observations', () => {
  const other = { ...syntheticProvenance(), source: { ...syntheticSource(), title: 'СИНТЕТИЧЕСКАЯ СТАТЬЯ B (не существует)', identifiers: [{ type: 'doi' as const, value: '10.0000/synthetic.fixture-b' }] } };
  const t = perRowTable({ rows: [row('a1', 300, 1), row('b1', 300, 1.7, { provenance: other }), row('c1', 300, 1, { provenance: other }), row('a2', 400, 2)] });
  assert.deepEqual(errs(t), []);
  const kept = createPropertySeries(t);
  assert.equal(kept.rows.length, 4);
  assert.deepEqual(kept.rows.map(r => r.value.type === 'scalar' ? r.value.value : null), [1, 1.7, 1, 2]);       // nothing averaged, merged or dropped
  assert.ok(infos(t).includes('repeats_undeclared'));
  // the same run and locator at one temperature only asks for a look
  const same = { run: 'r', locator: { table: 'T' } };
  const dup = singleTable({ rows: [obs('r1', 300, 1, same), obs('r2', 300, 1, same), obs('r3', 400, 2)] });
  assert.deepEqual(errs(dup), []);
  assert.ok(warns(dup).includes('possible_duplicate_observation'));
  assert.equal(createPropertySeries(dup).rows.length, 3);
});

test('10. a repeated Observation.id in rows is an error', () => {
  assert.deepEqual(errs(singleTable({ rows: [obs('r1', 300, 1), obs('r1', 400, 2)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(perRowTable({ rows: [row('r1', 300, 1), row('r1', 300, 1)] })), ['duplicate_observation_id']);
});

test('11. temperatures in K and °C are compared exactly; an interval or a missing unit is refused', () => {
  const t = singleTable({ rows: [{ ...obs('r1', 0, 1), temperature: q(26.85, 'degC') }, obs('r2', 400, 2), { ...obs('r3', 0, 3), temperature: q(226.85, 'degC') }] });
  assert.deepEqual(errs(t), []);
  assert.deepEqual(errs(singleTable({ rows: [{ ...obs('r1', 0, 1), temperature: q(10, 'K_delta') }, obs('r2', 400, 2)] })), ['invalid_quantity']);
  assert.deepEqual(errs(singleTable({ rows: [{ ...obs('r1', 0, 1), temperature: q(-10, 'K') }, obs('r2', 400, 2)] })), ['invalid_quantity']);
  assert.deepEqual(errs(singleTable({ rows: [{ ...obs('r1', 0, 1), temperature: 300 as never }, obs('r2', 400, 2)] })), ['invalid_quantity']);
});

test('12-13. a wrong unit of the property is refused; an unknown uncertainty is allowed and nothing is invented', () => {
  const wrongUnit = { ...obs('r1', 300, 1), value: { type: 'scalar' as const, value: 1, unit: 'Pa' } };
  assert.ok(errs(singleTable({ rows: [wrongUnit as never, obs('r2', 400, 2)] })).includes('invalid_quantity'));
  assert.ok(errs(singleTable({ rows: [{ ...obs('r1', 300, 1), value: { type: 'scalar', value: 1, unit: 'W_mK' }, uncertainty: undefined as never }, obs('r2', 400, 2)] })).includes('invalid_uncertainty'));
  assert.deepEqual(errs(singleTable()), []);                                                                      // { kind: 'unknown' } is a statement
  assert.equal(createPropertySeries(singleTable()).rows[0].uncertainty.kind, 'unknown');
  assert.ok(errs(singleTable({ rows: [obs('r1', 300, 1, { uncertainty: { kind: 'standard', u: -1, origin: 'stated_in_source' } }), obs('r2', 400, 2)] })).length > 0);
  assert.ok(errs(singleTable({ rows: [{ ...obs('r1', 300, 1), value: { type: 'scalar', value: 1, unit: 'W_mK' } }, { ...obs('r2', 400, 2), value: { type: 'scalar', value: 2, unit: 'W_cmK' } as never }] })).includes('mixed_units'));
});

test('14-17. common conditions apply to every row: damaged conditions, a film without thickness or direction, a mean CTE with a damaged reference temperature', () => {
  assert.ok(errs(singleTable({ commonConditions: 'x' as never })).includes('invalid_condition'));
  assert.ok(errs(singleTable({ commonConditions: { temperature: q(300, 'K') } as never })).includes('invalid_condition'));
  assert.deepEqual(errs(filmTable(), film), []);
  assert.deepEqual(errs(filmTable({ commonConditions: { direction: 'in_plane' } as never }), film), ['missing_condition']);
  assert.deepEqual(errs(filmTable({ commonConditions: { thickness: q(100, 'nm') } as never }), film), ['missing_condition']);
  const alpha = (conditions: Record<string, unknown>) => singleTable({ property: 'linear_expansion_coefficient', commonConditions: conditions as never, rows: [350, 400].map((t, i) => ({ id: `r${i + 1}`, temperature: q(t, 'K'), value: { type: 'scalar' as const, value: 10 + i, unit: 'ppm_K' as const }, uncertainty: { kind: 'unknown' as const } })) });
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') }), bulk), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean' }), bulk), ['missing_condition']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(10, 'K_delta') }), bulk), ['invalid_quantity']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'tangent' }), bulk), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'sideways' }), bulk), ['invalid_condition']);
});

test('18-19. the interpolation statement: `{ permitted: false }` and an explicit linear permission are stored as they are', () => {
  assert.deepEqual(errs(singleTable({ interpolation: { permitted: false } })), []);
  assert.deepEqual(errs(singleTable({ interpolation: undefined as never })), ['invalid_interpolation']);       // the field itself is mandatory
  assert.deepEqual(errs(singleTable({ interpolation: { permitted: false, method: 'linear_in_temperature' } as never })), ['invalid_interpolation']);
  const stated = permit({ basis: 'stated_in_source', source: { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' }, maxGap: q(150, 'K_delta') });
  for (const interpolation of [permit(), stated, permit({ maxGap: q(100, 'degC_delta') })]) {
    const t = singleTable({ interpolation });
    assert.deepEqual(errs(t), []);
    assert.deepEqual(createPropertySeries(t).interpolation, interpolation);
    assert.ok(infos(t).includes('interpolation_not_evaluated'));                                                // a note: stored only, linearity is not claimed
  }
  assert.ok(!infos(singleTable()).includes('interpolation_not_evaluated'));
});

test('20-22. the justification is mandatory; stated_in_source needs an identifiable source; a curator decision may carry an optional documented ground', () => {
  assert.deepEqual(errs(singleTable({ interpolation: permit({ justification: '' }) })), ['invalid_interpolation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ justification: undefined }) })), ['invalid_interpolation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ justification: '   ' }) })), ['invalid_interpolation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ basis: 'stated_in_source' }) })), ['invalid_interpolation']);
  assert.ok(errs(singleTable({ interpolation: permit({ basis: 'stated_in_source', source: { citation: '' } }) })).includes('invalid_source'));
  assert.deepEqual(errs(singleTable({ interpolation: permit({ basis: 'author' }) })), ['invalid_interpolation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ basis: undefined }) })), ['invalid_interpolation']);
  // the method is mandatory and only linear_in_temperature exists in this step
  for (const method of [undefined, 'spline', 'cubic', 'linear', '']) assert.deepEqual(errs(singleTable({ interpolation: permit({ method }) })), ['invalid_interpolation'], String(method));
  assert.deepEqual(errs(singleTable({ interpolation: { permitted: 'yes' } as never })), ['invalid_interpolation']);
});

test('23-24. maxGap is a positive temperature INTERVAL, never an absolute temperature', () => {
  for (const maxGap of [q(0, 'K_delta'), q(-5, 'K_delta'), q(Number.NaN, 'K_delta'), q(10, 'furlong'), 'x', { value: 10 }]) assert.ok(errs(singleTable({ interpolation: permit({ maxGap }) })).includes('invalid_quantity'), JSON.stringify(maxGap));
  assert.deepEqual(errs(singleTable({ interpolation: permit({ maxGap: q(300, 'K') }) })), ['invalid_quantity']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ maxGap: q(20, 'degC') }) })), ['invalid_quantity']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ maxGap: q(1e-6, 'K_delta') }) })), []);
});

test('25. unknown fields are refused everywhere', () => {
  assert.deepEqual(errs({ ...singleTable(), extra: 1 }), ['invalid_series']);
  assert.deepEqual(errs({ ...singleTable(), points: [] }), ['invalid_series']);
  assert.deepEqual(errs(singleTable({ rows: [{ ...obs('r1', 300, 1), extra: 1 } as never, obs('r2', 400, 2)] })), ['invalid_observation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ extra: 1 }) })), ['invalid_interpolation']);
  assert.deepEqual(errs(singleTable({ interpolation: permit({ order: 2 }) })), ['invalid_interpolation']);
  // a property value smuggled into a row or a table
  assert.deepEqual(errs(singleTable({ rows: [{ ...obs('r1', 300, 1), interpolated: { type: 'scalar', value: 1, unit: 'W_mK' } } as never, obs('r2', 400, 2)] })), ['invalid_observation']);
});

test('26. damaged nested objects give errors, never unhandled exceptions', () => {
  const damaged: unknown[] = [null, 5, 'x', [], {}, { kind: 'table' }, { ...singleTable(), rows: null }, { ...singleTable(), rows: [null, 5, 'x', [], {}] }, { ...singleTable(), rows: [{ id: 5 }, { id: null }] },
    { ...singleTable(), tableProvenance: null }, { ...singleTable(), tableProvenance: [] }, { ...singleTable(), interpolation: null }, { ...singleTable(), interpolation: [] }, { ...singleTable(), interpolation: { permitted: true } },
    { ...perRowTable(), rows: [{ ...row('r1', 300, 1), provenance: null }, { ...row('r2', 400, 2), provenance: [] }] }, { ...singleTable(), correlation: 5 }, { ...singleTable(), applicability: null },
    { ...singleTable(), commonConditions: null }, { ...singleTable(), interpolation: permit({ maxGap: null }) }, { ...singleTable(), interpolation: permit({ source: null, basis: 'stated_in_source' }) }];
  for (const input of damaged) {
    assert.doesNotThrow(() => validatePropertySeries(input), JSON.stringify(input)?.slice(0, 80));
    assert.doesNotThrow(() => validatePropertySeries(input, bulk));
    assert.doesNotThrow(() => validatePropertySeriesSet([input], syntheticSystemCatalog()));
    assert.ok(errs(input).length > 0, JSON.stringify(input)?.slice(0, 80));
  }
  assert.throws(() => createPropertySeries({ ...singleTable(), rows: null } as never), (e: unknown) => e instanceof MaterialsError);
});

test('27. the original order of the rows is preserved; the input is never reordered or modified', () => {
  const t = singleTable({ rows: [obs('c', 500, 3), obs('a', 300, 1), obs('b', 400, 2), obs('d', 300, 1.1)], applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'mixed' } });
  const before = JSON.stringify(t);
  assert.deepEqual(errs(t), []);
  assert.deepEqual(createPropertySeries(t).rows.map(r => r.id), ['c', 'a', 'b', 'd']);
  assert.equal(JSON.stringify(t), before);
  assert.deepEqual(errs(singleTable({ rows: [obs('a', 400, 1), obs('b', 300, 2)], applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'heating' } })), ['sweep_inconsistent']);
});

test('28-29. nothing is averaged and nothing is computed between the points: no function that does it exists, and the stored statement does not change the rows', () => {
  const rows = [obs('r1', 300, 1), obs('r2', 300, 1), obs('r3', 400, 2)];
  const t = createPropertySeries(singleTable({ rows, interpolation: permit() }));
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows.map(r => (r.value.type === 'scalar' ? r.value.value : null)), [1, 1, 2]);
  assert.deepEqual(Object.keys(t).sort(), Object.keys(singleTable()).sort());                                    // no computed field is added
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /interpolat(e|ion)(At|Value)|evaluate|extrapolat|average|dedup|mergeRows|valueAt|resample/i.test(n)), names.join());
  assert.deepEqual(Object.keys(materials).filter(n => /interpol/i.test(n)), []);                                // the statement is validated inside the series; nothing public interpolates
  assert.ok(!/\.(toFixed|round)\(|Math\.(round|floor|ceil)/.test(readFileSync(join(__dirname, '../src/materials/series-table.ts'), 'utf8')));
});

test('30. point series are unchanged: the same validator, the same codes; the kinds are not interchangeable', () => {
  assert.deepEqual(errs(bulkSeries()), []);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p1', 400, 2)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(bulkSeries({ provenance: undefined as never })), ['invalid_provenance']);
  assert.deepEqual(errs({ ...bulkSeries(), rows: [] }), ['invalid_series']);                                       // `rows` is not a point-series field
  assert.deepEqual(errs({ ...bulkSeries(), interpolation: { permitted: false } }), ['invalid_series']);
  const same = { run: 'run-1', locator: { table: 'Table 1' }, replicate: { group: 'g', relation: 'same_sample_repeat' as const } };
  const p = bulkSeries({ points: [obs('p1', 300, 1, same), obs('p2', 300, 1, same)] });
  assert.equal(validatePropertySeries(p).ok, true);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean' }), bulk), ['missing_condition']);
  assert.deepEqual(errs(filmSeries({ commonConditions: {} }), film), ['missing_condition', 'missing_condition']);
  assert.ok(errs({ ...singleTable(), kind: 'analytic' }).length > 0);                                              // a table is not an analytic series
  assert.deepEqual(errs({ ...singleTable(), kind: 'spline' }), ['invalid_series']);
});

test('31. the kind-specific shape is strict: a table needs `tableProvenance`, `rows` and `interpolation`', () => {
  const { tableProvenance: _a, ...noProv } = singleTable(); void _a;
  const { interpolation: _b, ...noInterp } = singleTable(); void _b;
  const { rows: _c, ...noRows } = singleTable(); void _c;
  assert.deepEqual(errs(noProv), ['invalid_table_provenance']);
  assert.deepEqual(errs(noInterp), ['invalid_interpolation']);
  assert.deepEqual(errs(noRows), ['invalid_series', 'series_too_short'].filter(x => errs(noRows).includes(x)));
  assert.ok(errs(noRows).includes('invalid_series'));
  assert.ok(errs(singleTable({ rows: [obs('r1', 300, 1)] })).includes('series_too_short'));
});

test('32. correlation and applicability use the Step 1 statements: independence is never assumed', () => {
  const t = singleTable();
  assert.deepEqual(createPropertySeries(t).correlation, { kind: 'unknown' });
  assert.deepEqual(errs(singleTable({ correlation: undefined as never })), ['invalid_correlation']);
  assert.deepEqual(errs(singleTable({ correlation: { kind: 'independent' } as never })), ['invalid_correlation']);
  assert.deepEqual(errs(singleTable({ correlation: { kind: 'independent', provenance: { origin: 'stated_in_source', source: { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' } } } })), []);
  const matrix = singleTable({ correlation: { kind: 'declared', info: { form: 'matrix', ids: ['r1', 'r2'], matrix: [[1, 0.5], [0.5, 1]] }, provenance: { origin: 'entered_by_user' } } });
  assert.deepEqual(errs(matrix), []);
  assert.ok(infos(matrix).includes('matrix_psd_not_checked'));
  assert.deepEqual(errs(singleTable({ correlation: { kind: 'declared', info: { form: 'matrix', ids: ['r1', 'zz'], matrix: [[1, 0], [0, 1]] }, provenance: { origin: 'entered_by_user' } } })), ['invalid_correlation']);
  assert.ok(errs(singleTable({ uncertaintyScope: 'fit_residual' })).includes('invalid_series'));
});

test('33. the permission to interpolate does not hide an event inside the table range', () => {
  const event = { kind: 'phase_transition' as const, temperature: q(450, 'K'), effect: 'discontinuity' as const, source: { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' } };
  const app = { events: [event], stability: { kind: 'not_stated' as const } };
  const permitted = singleTable({ applicability: app, interpolation: permit() });
  assert.deepEqual(errs(permitted), []);
  assert.ok(warns(permitted).includes('interpolation_across_event'));
  assert.ok(!warns(singleTable({ applicability: app })).includes('interpolation_across_event'));                // no permission - nothing to warn about
  assert.ok(!warns(singleTable({ applicability: { ...app, events: [{ ...event, temperature: q(900, 'K') }] }, interpolation: permit() })).includes('interpolation_across_event'));
  // the table range is not widened and nothing is extrapolated: the statement carries no range of its own
  assert.deepEqual(Object.keys(createPropertySeries(permitted).interpolation).sort(), ['basis', 'justification', 'method', 'permitted']);
});

test('34. a set of series: tables replace only a table of the same variant and property; ids share one space', () => {
  const catalog = syntheticSystemCatalog();
  const v1 = singleTable({ id: 'fixture:table-k-1' });
  const v2 = singleTable({ id: 'fixture:table-k-2', version: 2, supersedes: 'fixture:table-k-1' });
  assert.deepEqual(validatePropertySeriesSet([v1, v2], catalog).issues.filter(i => i.severity === 'error').map(i => i.code), []);
  const points = bulkSeries({ id: 'fixture:series-k-1' });
  const crossKind = singleTable({ id: 'fixture:table-k-3', version: 2, supersedes: 'fixture:series-k-1' });
  assert.deepEqual(validatePropertySeriesSet([points, crossKind], catalog).issues.filter(i => i.severity === 'error').map(i => i.code), ['supersedes_invalid']);
  const otherProperty = singleTable({ id: 'fixture:table-d-2', property: 'linear_expansion_coefficient', version: 2, supersedes: 'fixture:table-k-1', rows: alphaSeries({ expansionDefinition: 'tangent' }).points as never, commonConditions: { expansionDefinition: 'tangent' } as never });
  assert.ok(validatePropertySeriesSet([v1, otherProperty], catalog).issues.some(i => i.code === 'supersedes_invalid'));
  assert.ok(validatePropertySeriesSet([v1, { ...v1 }], catalog).issues.some(i => i.code === 'duplicate_id'));
  assert.ok(validatePropertySeriesSet([singleTable({ variant: 'fixture:nowhere' })], catalog).issues.some(i => i.code === 'missing_reference'));
});

test('35. a table of the technical limit size is validated in linear time', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => obs(`r${i}`, 300 + (i % 100), 1 + i * 1e-6, { replicate: { group: `g${i % 100}`, relation: 'same_sample_repeat' } }));
  const started = Date.now();
  const report = validatePropertySeries(singleTable({ rows }));
  assert.equal(report.ok, true);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.ok(errs(singleTable({ rows: [...rows, obs('extra', 300, 1)] })).includes('series_too_long'));
});

test('F1: the source of an interpolation statement - required for stated_in_source, optional for curator_decision, checked whenever present', () => {
  const good = { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' };
  const interp = (basis: string, source?: unknown) => singleTable({ interpolation: permit({ basis, ...(source === undefined ? {} : { source }) }) });
  assert.deepEqual(errs(interp('curator_decision')), []);                                                           // 1
  assert.deepEqual(errs(interp('curator_decision', good)), []);                                                     // 2
  for (const bad of [{ citation: '' }, {}, null, 'x', [], { citation: 'a', extra: 1 }, { citation: 'a', doi: 'not a doi' }]) {
    const t = interp('curator_decision', bad);
    assert.doesNotThrow(() => validatePropertySeries(t));
    const report = validatePropertySeries(t);
    assert.equal(report.ok, false, JSON.stringify(bad));                                                            // 3
    assert.ok(report.issues.some(i => i.severity === 'error' && i.path.startsWith('series.interpolation.source')), JSON.stringify(bad));
    assert.ok(errs(interp('stated_in_source', bad)).length > 0, JSON.stringify(bad));                               // 6
  }
  assert.deepEqual(errs(interp('stated_in_source', good)), []);                                                     // 4
  assert.deepEqual(errs(interp('stated_in_source')), ['invalid_interpolation']);                                    // 5
  assert.deepEqual(errs(interp('unknown_basis', good)), ['invalid_interpolation']);
  // 7: the basis is stored as written, with or without a source
  assert.equal((createPropertySeries(interp('curator_decision', good)).interpolation as { basis: string }).basis, 'curator_decision');
  assert.equal((createPropertySeries(interp('curator_decision')).interpolation as { basis: string }).basis, 'curator_decision');
  assert.equal((createPropertySeries(interp('stated_in_source', good)).interpolation as { basis: string }).basis, 'stated_in_source');
  // 8: the statement's source never touches the provenance of the table or of its rows
  for (const make of [singleTable, perRowTable]) {
    const plain = createPropertySeries(make({ interpolation: permit() }));
    const withSource = createPropertySeries(make({ interpolation: permit({ source: good }) }));
    assert.deepEqual(withSource.tableProvenance, plain.tableProvenance);
    assert.deepEqual(withSource.rows, plain.rows);
    assert.deepEqual(errs(make({ interpolation: permit({ source: good }) })), []);
  }
  assert.ok(!infos(interp('curator_decision', good)).includes('unverified_value') || infos(singleTable()).includes('unverified_value'));   // no verification status is created or raised
  // 9: nothing is computed
  const t = createPropertySeries(interp('curator_decision', good));
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows.map(r => r.id), ['r1', 'r2', 'r3']);
  // 10: damaged nested structures
  for (const interpolation of [permit({ source: { citation: { x: 1 } } }), permit({ source: [null] }), permit({ basis: 'stated_in_source', source: undefined }), permit({ basis: {} }), permit({ basis: null, source: good })]) {
    assert.doesNotThrow(() => validatePropertySeries(singleTable({ interpolation })));
    assert.ok(errs(singleTable({ interpolation })).length > 0);
  }
});
