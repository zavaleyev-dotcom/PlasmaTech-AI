import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as materials from '../src/materials';
import { validatePropertySeries, validatePropertySeriesSet, createPropertySeries, MaterialsError, MAX_SEGMENTS, MAX_POWER_EXPONENT } from '../src/materials';
import { syntheticSystemCatalog, syntheticElement, syntheticCompound } from './materials-fixtures';
import { bulkSeries, filmSeries, alphaSeries, singleTable, perRowTable, obs, q, analytic, segment, term } from './materials-series-fixtures';

const issues = (s: unknown, variant?: unknown) => validatePropertySeries(s, variant).issues;
const errs = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'error').map(i => i.code);
const warns = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'warning').map(i => i.code);
const infos = (s: unknown, variant?: unknown): string[] => issues(s, variant).filter(i => i.severity === 'info').map(i => i.code);
const bulk = syntheticElement();
const film = syntheticCompound();
const withTerms = (terms: unknown[], variable: Record<string, unknown> = {}) => analytic({ segments: [segment('s1', 300, 600, {}, { terms, ...(Object.keys(variable).length ? { variable: { reference: q(300, 'K'), scale: q(100, 'K_delta'), ...variable } } : {}) })] });
const src = { citation: 'СИНТЕТИЧЕСКИЙ ИСТОЧНИК' };
const seg = (id: string, min: number, max: number, minInclusive: boolean, maxInclusive: boolean) => segment(id, min, max, { domain: { min: q(min, 'K'), max: q(max, 'K'), minInclusive, maxInclusive } });
const filmAnalytic = (over: Record<string, unknown> = {}) => analytic({ id: 'fixture:analytic-k-film', variant: 'fixture:synthetic-compound-film', commonConditions: { thickness: q(100, 'nm'), direction: 'in_plane' } as never, ...over } as never);

test('1. a correct power_sum series is valid, stored as written and gets a frozen copy', () => {
  assert.deepEqual(errs(analytic()), []);
  assert.deepEqual(errs(analytic(), bulk), []);
  const a = createPropertySeries(analytic(), bulk);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.segments) && Object.isFrozen(a.segments[0].equation));
  assert.deepEqual(a.segments[0].equation, analytic().segments[0].equation);
  assert.throws(() => createPropertySeries(analytic({ id: 'bad id' })), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_series');
  assert.deepEqual(errs(analytic({ segments: [segment('s1', 300, 400), segment('s2', 400, 600)] }), bulk), []);
});

test('2-3. only power_sum exists; the terms are a non-empty list of objects', () => {
  for (const form of ['polynomial', 'exp', 'power_sum ', undefined, 5]) assert.deepEqual(errs(analytic({ segments: [segment('s1', 300, 600, {}, { form })] })), ['invalid_equation'], String(form));
  for (const terms of [[], undefined, null, 'x', {}]) assert.deepEqual(errs(withTerms(terms as never)), ['invalid_equation'], JSON.stringify(terms));
  assert.deepEqual(errs(withTerms([null])), ['invalid_equation']);
  assert.deepEqual(errs(analytic({ segments: [{ ...segment('s1', 300, 600), equation: null as never }] })), ['invalid_equation']);
});

test('4-6. exponents: unique, integer, within -6..+6', () => {
  assert.deepEqual(errs(withTerms([term(1), term(1, 2)])), ['invalid_equation']);
  assert.deepEqual(errs(withTerms([term(0), term(-0)])), ['invalid_equation']);
  for (const n of [0.5, 1.0000001, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined]) assert.deepEqual(errs(withTerms([term(n as never)])), ['invalid_equation'], String(n));
  for (const n of [7, -7, 100, 2 ** 31]) assert.deepEqual(errs(withTerms([term(n)])), ['invalid_equation'], String(n));
  for (const n of [-6, 6]) assert.deepEqual(errs(withTerms([term(n)], { reference: q(100, 'K') })), [], String(n));
  const all = Array.from({ length: 2 * MAX_POWER_EXPONENT + 1 }, (_, i) => term(i - MAX_POWER_EXPONENT));
  assert.deepEqual(errs(withTerms(all, { reference: q(100, 'K') })), []);
  assert.ok(errs(withTerms([...all, term(1)], { reference: q(100, 'K') })).includes('invalid_equation'));                  // a 14th term
  assert.ok(errs(withTerms([...all, term(1)])).includes('invalid_equation'));
});

test('7. coefficient units must be units of the property; coefficients are finite; unknown fields are refused', () => {
  const t = (coefficient: unknown) => withTerms([{ ...term(0), coefficient }]);
  assert.ok(errs(t({ type: 'scalar', value: 1, unit: 'Pa' })).includes('invalid_quantity'));
  assert.ok(errs(t({ type: 'scalar', value: 1, unit: 'furlong' })).includes('invalid_quantity'));
  assert.ok(errs(t({ type: 'scalar', value: Number.NaN, unit: 'W_mK' })).includes('invalid_quantity'));
  assert.ok(errs(t({ type: 'scalar', value: Number.POSITIVE_INFINITY, unit: 'W_mK' })).includes('invalid_quantity'));
  assert.ok(errs(t({ type: 'scalar', value: '1', unit: 'W_mK' })).includes('invalid_quantity'));
  assert.ok(errs(t({ type: 'scalar', value: 1 })).includes('invalid_quantity'));
  assert.ok(errs(t(5)).includes('invalid_equation'));
  assert.ok(errs(t({ type: 'vector', value: 1, unit: 'W_mK' })).includes('invalid_equation'));
  assert.ok(errs(t({ type: 'scalar', value: 1, unit: 'W_mK', extra: 1 })).includes('invalid_equation'));
  // a coefficient of a sum may be negative or zero: it is not a property value
  assert.deepEqual(errs(withTerms([term(0, 5), term(1, -2), term(2, 0)])), []);
  // one unit for all the coefficients of the series
  assert.ok(errs(withTerms([term(0), { ...term(1), coefficient: { type: 'scalar', value: 1, unit: 'W_cmK' } }])).includes('mixed_units'));
  assert.ok(errs(analytic({ segments: [segment('s1', 300, 400), segment('s2', 400, 600, {}, { terms: [{ ...term(0), coefficient: { type: 'scalar', value: 1, unit: 'W_cmK' } }] })] })).includes('mixed_units'));
});

test('8-9. the scale s is a strictly positive INTERVAL and T0 an ABSOLUTE temperature', () => {
  for (const scale of [q(0, 'K_delta'), q(-1, 'K_delta'), q(Number.NaN, 'K_delta'), q(100, 'K'), q(100, 'degC'), q(1, 'furlong'), 5, null]) assert.ok(errs(withTerms([term(0)], { scale })).includes('invalid_quantity'), JSON.stringify(scale));
  assert.deepEqual(errs(withTerms([term(0)], { scale: q(100, 'degC_delta') })), []);
  for (const reference of [q(10, 'K_delta'), q(-5, 'K'), q(-300, 'degC'), q(Number.NaN, 'K'), 'x', null]) assert.ok(errs(withTerms([term(0)], { reference })).includes('invalid_quantity'), JSON.stringify(reference));
  assert.deepEqual(errs(withTerms([term(0)], { reference: q(26.85, 'degC') })), []);
  assert.deepEqual(errs(analytic({ segments: [segment('s1', 300, 600, {}, { variable: null })] })), ['invalid_equation']);
  assert.deepEqual(errs(analytic({ segments: [segment('s1', 300, 600, {}, { variable: { reference: q(300, 'K'), scale: q(100, 'K_delta'), extra: 1 } })] })), ['invalid_equation']);
});

test('10. a negative exponent forbids T0 inside the domain; the open bound is honoured', () => {
  const at = (reference: number, minInclusive: boolean, maxInclusive: boolean, exponent = -1) => analytic({ segments: [segment('s1', 300, 600, { domain: { min: q(300, 'K'), max: q(600, 'K'), minInclusive, maxInclusive } }, { terms: [term(exponent)], variable: { reference: q(reference, 'K'), scale: q(100, 'K_delta') } })] });
  assert.deepEqual(errs(at(450, true, false)), ['equation_singularity']);                  // inside
  assert.deepEqual(errs(at(300, true, false)), ['equation_singularity']);                  // on an INCLUDED bound
  assert.deepEqual(errs(at(600, true, true)), ['equation_singularity']);
  assert.deepEqual(errs(at(300, false, false)), []);                                       // on an EXCLUDED bound: allowed, with a note
  assert.ok(infos(at(300, false, false)).includes('singularity_at_open_boundary'));
  assert.deepEqual(errs(at(600, true, false)), []);
  assert.deepEqual(errs(at(100, true, true)), []);                                         // outside
  assert.deepEqual(errs(at(900, true, true)), []);
  assert.deepEqual(errs(at(450, true, false, 0)), []);                                     // no negative exponent: no singularity
  assert.deepEqual(errs(at(450, true, false, 3)), []);
  assert.deepEqual(errs(at(450, true, false, -2)), ['equation_singularity']);
  // T0 in degC is compared exactly with the bounds in K
  const celsius = analytic({ segments: [segment('s1', 300, 600, {}, { terms: [term(-1)], variable: { reference: q(26.85, 'degC'), scale: q(100, 'K_delta') } })] });
  assert.deepEqual(errs(celsius), ['equation_singularity']);                               // 26.85 degC = 300 K, which is an included lower bound
});

test('11. open and closed bounds are explicit booleans; min < max strictly', () => {
  for (const [a, b] of [[true, true], [true, false], [false, true], [false, false]] as const) assert.deepEqual(errs(analytic({ segments: [seg('s1', 300, 600, a, b)] })), [], `${a}${b}`);
  const domain = (d: Record<string, unknown>) => analytic({ segments: [segment('s1', 300, 600, { domain: { min: q(300, 'K'), max: q(600, 'K'), minInclusive: true, maxInclusive: false, ...d } as never })] });
  assert.deepEqual(errs(domain({ minInclusive: undefined })), ['invalid_segment']);
  assert.deepEqual(errs(domain({ maxInclusive: 'yes' })), ['invalid_segment']);
  assert.deepEqual(errs(domain({ min: q(600, 'K') })), ['invalid_segment']);
  assert.deepEqual(errs(domain({ min: q(700, 'K') })), ['invalid_segment']);
  assert.ok(errs(domain({ min: q(-1, 'K') })).includes('invalid_quantity'));
  assert.ok(errs(domain({ max: q(10, 'K_delta') })).includes('invalid_quantity'));
  assert.deepEqual(errs(domain({ extra: 1 })), ['invalid_segment']);
  assert.deepEqual(errs(domain({ min: q(26.85, 'degC') })), []);                          // 300 K
  assert.deepEqual(errs(analytic({ segments: [{ ...segment('s1', 300, 600), domain: null as never }] })), ['invalid_segment']);
  assert.deepEqual(errs(analytic({ segments: [segment('S 1', 300, 600)] })), ['invalid_segment']);
  assert.deepEqual(errs(analytic({ segments: [] })), ['series_too_short']);
  assert.ok(errs(analytic({ segments: Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => segment(`s${i}`, 300 + i, 301 + i)) })).includes('series_too_long'));
  assert.deepEqual(errs(analytic({ segments: Array.from({ length: MAX_SEGMENTS }, (_, i) => segment(`s${i}`, 300 + i, 301 + i)) })), []);
});

test('12-14. overlapping segments, an unambiguous joint and an ambiguous joint', () => {
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 500, true, false), seg('b', 400, 600, true, false)] })), ['segment_overlap']);
  assert.deepEqual(errs(analytic({ segments: [seg('b', 400, 600, true, false), seg('a', 300, 500, true, false)] })), ['segment_overlap']);       // the order of the list does not matter
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 600, true, false), seg('b', 400, 500, true, false)] })), ['segment_overlap']);       // nested
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 500, true, true), seg('b', 300, 500, true, true)] })), ['segment_overlap']);         // equal
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, false), seg('b', 350, 500, true, false), seg('c', 450, 600, true, false)] })), ['segment_overlap', 'segment_overlap']);
  // one joint temperature belongs to ONE segment
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, false), seg('b', 400, 600, true, false)] })), []);   // [300,400) [400,600)
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, true), seg('b', 400, 600, false, false)] })), []);    // [300,400] (400,600)
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, false), seg('b', 400, 600, false, true)] })), []);    // [300,400) (400,600] - the joint belongs to none: allowed
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, true), seg('b', 400, 600, true, true)] })), ['ambiguous_segment_boundary']);
  // (a joint written in kelvin on both sides is the plain case, covered above)
  // a joint written in degC is compared exactly with one in K
  const cel = segment('b', 400, 600, { domain: { min: q(126.85, 'degC'), max: q(600, 'K'), minInclusive: true, maxInclusive: false } });
  assert.deepEqual(errs(analytic({ segments: [seg('a', 300, 400, true, true), cel] })), ['ambiguous_segment_boundary']);
  assert.deepEqual(errs(analytic({ segments: [segment('s1', 300, 400), segment('s1', 400, 600)] })), ['duplicate_segment_id']);
  // continuity at a joint is neither required nor evaluated
  assert.deepEqual(errs(analytic({ segments: [segment('a', 300, 400, {}, { terms: [term(0, 1)] }), segment('b', 400, 600, {}, { terms: [term(0, 999)] })] })), []);
});

test('15. a coefficient uncertainty is explicit: unknown is not zero; the other statements are checked by the M1.3.2 validator', () => {
  const u = (uncertainty: unknown) => withTerms([{ ...term(0), uncertainty }, term(1)]);
  assert.deepEqual(errs(u({ kind: 'unknown' })), []);
  assert.deepEqual(errs(u({ kind: 'standard', u: 0.1, origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(u({ kind: 'expanded', U: 0.2, k: 2, kOrigin: 'stated_in_source', origin: 'stated_in_source' })), []);
  assert.deepEqual(errs(u({ kind: 'bounds', lower: 0.5, upper: 1.5, origin: 'stated_in_source' })), []);
  for (const bad of [undefined, null, {}, { kind: 'standard', u: 0, origin: 'stated_in_source' }, { kind: 'standard', u: -1, origin: 'stated_in_source' }, { kind: 'standard', u: 0.1 }, { kind: 'unknown', u: 0 }, { kind: 'bounds', lower: 2, upper: 3, origin: 'stated_in_source' }, { kind: 'zero' }]) assert.deepEqual(errs(u(bad)), ['invalid_uncertainty'], JSON.stringify(bad));
  assert.deepEqual(createPropertySeries(analytic()).segments[0].equation.terms.map(t => t.uncertainty), [{ kind: 'unknown' }, { kind: 'unknown' }]);
  // the residual spread of a fit is NOT the uncertainty of the coefficients, and neither is derived from the other
  const stated = withTerms([{ ...term(0), uncertainty: { kind: 'standard', u: 0.1, origin: 'stated_in_source' } }, term(1)]);
  assert.deepEqual(errs({ ...stated, uncertaintyScope: 'fit_coefficients' }), []);
  assert.deepEqual(errs({ ...stated, uncertaintyScope: 'fit_residual', fit: { residualStandardDeviation: 0.3 } }), []);       // both are stored, as different quantities (see the F1 tests)
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'fit_residual', fit: { residualStandardDeviation: 0.3 } }), []);
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'fit_residual' }), ['invalid_series']);
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'fit_coefficients' }), ['invalid_series']);                  // coefficient uncertainties are all unknown
  assert.ok(infos({ ...stated, uncertaintyScope: 'unspecified' }).includes('uncertainty_scope_unspecified'));
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'per_observation' }), ['invalid_series']);
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'x' }), ['invalid_series']);
  for (const fit of [{ residualStandardDeviation: 0 }, { residualStandardDeviation: -1 }, { residualStandardDeviation: Number.NaN }, { observations: 0 }, { observations: 1.5 }, { note: '' }, { extra: 1 }, null, 5]) assert.deepEqual(errs({ ...analytic(), fit }), ['invalid_series'], JSON.stringify(fit));
  assert.deepEqual(errs({ ...analytic(), fit: { residualStandardDeviation: 0.3, observations: 12, note: 'СИНТЕТИЧЕСКАЯ' } }), []);
});

test('16. the correlation of coefficients: unknown by default, independence needs provenance, a matrix is checked structurally and its PSD is not claimed', () => {
  const two = analytic({ segments: [segment('s1', 300, 600, {}, { terms: [term(0), term(1)] })] });
  const corr = (c: unknown) => ({ ...two, coefficientCorrelation: c });
  assert.deepEqual(errs(corr({ kind: 'unknown' })), []);
  assert.deepEqual(errs(corr(undefined)), ['invalid_correlation']);
  assert.deepEqual(errs(corr({ kind: 'independent' })), ['invalid_correlation']);
  assert.deepEqual(errs(corr({ kind: 'independent', provenance: { origin: 'stated_in_source', source: src } })), []);
  const matrix = (ids: string[], m: number[][]) => corr({ kind: 'declared', info: { form: 'matrix', ids, matrix: m }, provenance: { origin: 'entered_by_user' } });
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[1, 0.5], [0.5, 1]])), []);
  assert.ok(infos(matrix(['s1:0', 's1:1'], [[1, 0.5], [0.5, 1]])).includes('matrix_psd_not_checked'));
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[1, 0.5], [0.4, 1]])), ['invalid_correlation']);       // not symmetric
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[1, 2], [2, 1]])), ['invalid_correlation']);           // |r| > 1
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[2, 0], [0, 1]])), ['invalid_correlation']);           // diagonal
  assert.deepEqual(errs(matrix(['s1:0', 's9:1'], [[1, 0], [0, 1]])), ['invalid_correlation']);           // not a coefficient of this series
  assert.deepEqual(errs(matrix(['s1:0', 's1:0'], [[1, 0], [0, 1]])), ['invalid_correlation']);
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[1, 0]])), ['invalid_correlation']);
  assert.deepEqual(errs(matrix(['s1:0', 's1:1'], [[1, Number.NaN], [Number.NaN, 1]])), ['invalid_correlation']);
  for (const bad of [null, 5, [], { kind: 'declared' }, { kind: 'declared', info: null, provenance: { origin: 'entered_by_user' } }, { kind: 'weird' }]) { assert.ok(errs(corr(bad)).length > 0 && errs(corr(bad)).every(x => x === 'invalid_correlation'), JSON.stringify(bad)); }
  assert.deepEqual(createPropertySeries(analytic()).coefficientCorrelation, { kind: 'unknown' });         // independence is never assumed
});

test('17. the three states of CoefficientCheck; none of them is computed or raised by the program', () => {
  const point = { temperature: q(400, 'K'), value: { type: 'scalar', value: 1.2, unit: 'W_mK' }, significantDigits: 3, locator: { table: 'Table S1' } };
  const check = (c: unknown) => analytic({ coefficientCheck: c as never });
  assert.deepEqual(errs(check({ status: 'not_checked' })), []);
  assert.ok(infos(check({ status: 'not_checked' })).includes('coefficients_not_checked'));            // not checked is not "verified"
  assert.deepEqual(errs(check({ status: 'reference_points_available', points: [point] })), []);
  assert.ok(infos(check({ status: 'reference_points_available', points: [point] })).includes('coefficient_check_not_computed'));
  const attestation = { by: 'СИНТЕТИЧЕСКИЙ КУРАТОР', at: '2000-01-02', method: 'СИНТЕТИЧЕСКИЙ способ' };
  assert.deepEqual(errs(check({ status: 'independently_checked', attestation })), []);
  assert.deepEqual(errs(check({ status: 'independently_checked', attestation, points: [point] })), []);
  assert.ok(infos(check({ status: 'independently_checked', attestation })).includes('coefficient_check_not_computed'));
  // the points are stored, never compared with the formula: a point far from the formula's value is not an error
  assert.deepEqual(errs(check({ status: 'reference_points_available', points: [{ ...point, value: { type: 'scalar', value: 1e9, unit: 'W_mK' } }] })), []);
  assert.deepEqual(createPropertySeries(check({ status: 'reference_points_available', points: [point] })).coefficientCheck, { status: 'reference_points_available', points: [point] });
  for (const bad of [undefined, null, {}, { status: 'verified' }, { status: 'checked' }, { status: 'not_checked', points: [point] }, { status: 'not_checked', attestation }, 'not_checked']) assert.ok(errs(check(bad)).includes('invalid_coefficient_check'), JSON.stringify(bad));
  assert.ok(warns(check({ status: 'reference_points_available', points: [{ ...point, temperature: q(900, 'K') }] })).includes('reference_point_outside_domain'));
});

test('18. a damaged attestation is refused; an attestation is a statement of a named person, not an automatic confirmation', () => {
  const a = (att: unknown) => analytic({ coefficientCheck: { status: 'independently_checked', attestation: att } as never });
  const ok = { by: 'СИНТЕТИЧЕСКИЙ КУРАТОР', at: '2000-01-02', method: 'СИНТЕТИЧЕСКИЙ способ' };
  for (const bad of [undefined, null, 5, {}, { ...ok, by: '' }, { ...ok, by: undefined }, { ...ok, at: '2000-13-40' }, { ...ok, at: 'yesterday' }, { ...ok, at: undefined }, { ...ok, method: '  ' }, { ...ok, method: undefined }, { ...ok, extra: 1 }]) { assert.ok(errs(a(bad)).length > 0 && errs(a(bad)).every(x => x === 'invalid_coefficient_check'), JSON.stringify(bad)); }
  assert.deepEqual(errs(analytic({ coefficientCheck: { status: 'independently_checked' } as never })), ['invalid_coefficient_check']);
  assert.deepEqual(errs(a(ok)), []);
  assert.deepEqual(createPropertySeries(a(ok)).coefficientCheck, { status: 'independently_checked', attestation: ok });   // stored as written; no field is added or promoted
  assert.ok(!Object.keys(createPropertySeries(a(ok))).includes('verified'));
  // the provenance of the series is a separate thing and is not changed by the check
  assert.deepEqual(createPropertySeries(a(ok)).provenance, analytic().provenance);
});

test('19. a reference point needs a locator, a temperature, a value of the property and valid significant digits', () => {
  const point = { temperature: q(400, 'K'), value: { type: 'scalar', value: 1.2, unit: 'W_mK' }, locator: { table: 'Table S1' } };
  const pts = (points: unknown) => analytic({ coefficientCheck: { status: 'reference_points_available', points } as never });
  assert.deepEqual(errs(pts([point])), []);
  const { locator: _l, ...noLocator } = point; void _l;
  assert.deepEqual(errs(pts([noLocator])), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts([])), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts(undefined)), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts([{ ...point, locator: {} }])), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts([{ ...point, locator: { table: '' } }])), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts([{ ...point, locator: { sheet: 'x' } }])), ['invalid_coefficient_check']);
  assert.ok(errs(pts([{ ...point, temperature: q(10, 'K_delta') }])).includes('invalid_quantity'));
  assert.ok(errs(pts([{ ...point, value: { type: 'scalar', value: 1, unit: 'Pa' } }])).includes('invalid_quantity'));
  for (const significantDigits of [0, 18, 2.5, '3', -1]) assert.deepEqual(errs(pts([{ ...point, significantDigits }])), ['invalid_coefficient_check'], String(significantDigits));
  assert.deepEqual(errs(pts([{ ...point, extra: 1 }])), ['invalid_coefficient_check']);
  assert.deepEqual(errs(pts([null, 5])), ['invalid_coefficient_check', 'invalid_coefficient_check']);
});

test('20. phase and structural limits: events, stability, thermal history and the stable range of the variant', () => {
  const event = (effect: string, kelvin = 450) => ({ kind: 'phase_transition' as const, temperature: q(kelvin, 'K'), effect: effect as never, source: src });
  const app = (events: unknown[], extra: Record<string, unknown> = {}) => analytic({ applicability: { events, stability: { kind: 'not_stated' }, ...extra } as never });
  // one equation across a discontinuity or an irreversible change is suspicious; a split is suggested, never done
  assert.ok(warns(app([event('discontinuity')])).includes('segment_crosses_event'));
  assert.ok(warns(app([event('irreversible_change')])).includes('segment_crosses_event'));
  assert.ok(warns(app([event('unknown')])).includes('segment_crosses_event'));
  assert.ok(!warns(app([event('discontinuity', 900)])).includes('segment_crosses_event'));
  assert.deepEqual(errs(app([event('discontinuity')])), []);
  const split = analytic({ segments: [seg('lo', 300, 450, true, false), seg('hi', 450, 600, true, false)], applicability: { events: [event('discontinuity')], stability: { kind: 'not_stated' } } });
  assert.deepEqual(errs(split), []);
  assert.ok(!warns(split).includes('segment_crosses_event'));                                                           // the event sits on the joint: nothing to warn about
  assert.deepEqual(errs(app([event('range_ends_before', 400)])), ['event_contradicts_domain']);                     // a declared limit below the domain
  assert.deepEqual(errs(app([event('range_ends_before', 700)])), []);
  // a wide range is not stability
  assert.ok(infos(analytic()).includes('stability_not_stated'));
  assert.ok(!infos(app([], { stability: { kind: 'stated_stable_over_range', source: src } })).includes('stability_not_stated'));
  assert.ok(errs(app([], { stability: { kind: 'stated_stable_over_range' } })).includes('invalid_applicability'));
  assert.ok(errs(app([], { thermalHistory: { state: 'as_deposited', cycles: 3 } })).includes('history_inconsistent'));
  // the sweep direction describes a measurement order: an equation has none
  assert.deepEqual(errs(app([], { sweepDirection: 'cooling' })), []);
  // the stable range of the variant: outside it is a warning of incomparability, not a rejection
  const outside = analytic({ segments: [segment('s1', 300, 6000)] });
  const range = issues(outside, bulk).filter(i => i.code === 'beyond_stable_range' || i.code === 'phase_range_not_stated');
  assert.ok(range.length > 0);
  assert.deepEqual(errs(outside, bulk), []);
  assert.ok(errs(app([event('discontinuity')]), 'not a variant').length > 0);
});

test('21. thin-film conditions and the property conditions apply to the whole series', () => {
  assert.deepEqual(errs(filmAnalytic(), film), []);
  assert.deepEqual(errs(filmAnalytic({ commonConditions: { direction: 'in_plane' } as never }), film), ['missing_condition']);
  assert.deepEqual(errs(filmAnalytic({ commonConditions: { thickness: q(100, 'nm') } as never }), film), ['missing_condition']);
  assert.deepEqual(errs(filmAnalytic({ commonConditions: {} }), film), ['missing_condition', 'missing_condition']);
  assert.ok(warns(filmAnalytic(), film).includes('stability_not_stated'));                                              // a film's stability is not assumed
  assert.ok(warns(filmAnalytic(), film).includes('thermal_history_not_stated'));
  assert.ok(!warns(filmAnalytic(), film).includes('sweep_direction_not_stated'));                                       // no measurement order in an equation
  assert.deepEqual(errs(analytic({ commonConditions: { temperature: q(300, 'K') } as never })), ['invalid_condition']);
  assert.deepEqual(errs(analytic({ commonConditions: 'x' as never })), ['invalid_condition']);
  // the mean CTE keeps one reference temperature; the tangent one has none
  const alpha = (conditions: Record<string, unknown>) => analytic({ property: 'linear_expansion_coefficient', commonConditions: conditions as never, segments: [segment('s1', 350, 600, {}, { terms: [{ ...term(0), coefficient: { type: 'scalar', value: 10, unit: 'ppm_K' } }] })] });
  assert.deepEqual(errs(alpha({ expansionDefinition: 'tangent' }), bulk), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') }), bulk), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean' }), bulk), ['missing_condition']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(10, 'K_delta') }), bulk), ['invalid_quantity']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(350, 'K') }), bulk), ['invalid_condition']);   // equal to a domain bound
  assert.ok(errs(analytic({ property: 'density' }), bulk).includes('invalid_quantity'));                                // a W/(m K) coefficient is not a density
  assert.ok(errs(analytic({ property: 'no_such_property' })).includes('unknown_property'));
  assert.ok(errs(analytic({ variant: 'not an id' })).includes('invalid_id'));
});

test('22. damaged nested objects give errors, never unhandled exceptions', () => {
  const base = analytic();
  const damaged: unknown[] = [null, 5, 'x', [], {}, { kind: 'analytic' }, { ...base, segments: null }, { ...base, segments: [null, 5, 'x', [], {}] }, { ...base, segments: [{ id: 5 }] },
    { ...base, segments: [{ ...base.segments[0], equation: { form: 'power_sum', terms: [{}] } }] }, { ...base, segments: [{ ...base.segments[0], equation: { form: 'power_sum', variable: [], terms: [[]] } }] },
    { ...base, coefficientCheck: [] }, { ...base, coefficientCheck: { status: 'independently_checked', attestation: [] } }, { ...base, coefficientCheck: { status: 'reference_points_available', points: [[]] } },
    { ...base, coefficientCorrelation: 5 }, { ...base, fit: [] }, { ...base, applicability: null }, { ...base, commonConditions: null }, { ...base, provenance: null }, { ...base, segments: [{ ...base.segments[0], domain: [] }] },
    { ...base, segments: [{ ...base.segments[0], locator: 5 }] }, { ...base, segments: [{ ...base.segments[0], equation: { ...base.segments[0].equation, terms: [{ ...term(0), locator: [] }] } }] }];
  for (const input of damaged) {
    assert.doesNotThrow(() => validatePropertySeries(input), JSON.stringify(input)?.slice(0, 80));
    assert.doesNotThrow(() => validatePropertySeries(input, bulk));
    assert.doesNotThrow(() => validatePropertySeriesSet([input], syntheticSystemCatalog()));
    assert.ok(errs(input).length > 0, JSON.stringify(input)?.slice(0, 80));
  }
  assert.throws(() => createPropertySeries({ ...base, segments: null } as never), (e: unknown) => e instanceof MaterialsError);
  // unknown fields at every level
  assert.deepEqual(errs({ ...base, extra: 1 }), ['invalid_series']);
  assert.deepEqual(errs({ ...base, points: [] }), ['invalid_series']);
  assert.deepEqual(errs({ ...base, rows: [] }), ['invalid_series']);
  assert.deepEqual(errs({ ...base, interpolation: { permitted: true } }), ['invalid_series']);
  assert.deepEqual(errs(analytic({ segments: [{ ...base.segments[0], extra: 1 } as never] })), ['invalid_segment']);
  assert.deepEqual(errs(withTerms([{ ...term(0), extra: 1 }])), ['invalid_equation']);
  assert.deepEqual(errs(withTerms([{ ...term(0), value: 5 }])), ['invalid_equation']);                                    // a property value smuggled into a term
  assert.deepEqual(errs({ ...base, provenance: undefined }), ['invalid_provenance']);
});

test('23. point series and tabulated series are unchanged', () => {
  assert.deepEqual(errs(bulkSeries()), []);
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 300, 1), obs('p1', 400, 2)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(bulkSeries({ uncertaintyScope: 'fit_residual' })), ['invalid_series']);
  assert.deepEqual(errs(bulkSeries({ uncertaintyScope: 'per_observation' })), []);
  assert.deepEqual(errs({ ...bulkSeries(), segments: [] }), ['invalid_series']);
  assert.deepEqual(errs(singleTable()), []);
  assert.deepEqual(errs(perRowTable()), []);
  assert.deepEqual(errs(singleTable({ rows: [obs('r1', 300, 1), obs('r1', 400, 2)] })), ['duplicate_observation_id']);
  assert.deepEqual(errs(singleTable({ uncertaintyScope: 'fit_coefficients' })), ['invalid_series']);
  assert.deepEqual(errs(filmSeries({ commonConditions: {} }), film), ['missing_condition', 'missing_condition']);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean' }), bulk), ['missing_condition']);
  assert.deepEqual(errs({ ...analytic(), kind: 'curve' }), ['invalid_series']);
  assert.deepEqual(errs({ ...analytic(), kind: 'points' }).length > 0, true);
  // sweep consistency still applies to measured series and not to equations
  assert.deepEqual(errs(bulkSeries({ points: [obs('p1', 400, 1), obs('p2', 300, 2)], applicability: { events: [], stability: { kind: 'not_stated' }, sweepDirection: 'heating' } })), ['sweep_inconsistent']);
});

test('24. nothing is evaluated: no evaluation function exists, the stored equation is not changed and no value is added', () => {
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /evaluat|valueAt|compute|solve|fit(?!_)|resample|interpol|extrapol|average|simplif/i.test(n)), names.join());
  const a = analytic({ segments: [segment('a', 300, 400), segment('b', 400, 600, {}, { terms: [term(0, 7)] })] });
  const before = JSON.stringify(a);
  const kept = createPropertySeries(a);
  assert.equal(JSON.stringify(a), before);                                                                             // the input is untouched
  assert.deepEqual(JSON.parse(JSON.stringify(kept)), JSON.parse(before));                                              // the copy equals the input: no value, no simplification
  assert.deepEqual(Object.keys(kept).sort(), Object.keys(a).sort());
  const code = readFileSync(join(__dirname, '../src/materials/series-analytic.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\*\*|Math\.(pow|exp|log|sqrt|hypot)|\.toFixed\(|reduce\(/.test(code), 'no arithmetic on coefficients');
  // the bounds of the closed-form checks are compared exactly, and a term list is never reordered
  assert.deepEqual(kept.segments[1].equation.terms.map(t => t.exponent), [0]);
  assert.deepEqual(createPropertySeries(analytic({ segments: [segment('s1', 300, 600, {}, { terms: [term(2), term(-1), term(0)], variable: { reference: q(100, 'K'), scale: q(100, 'K_delta') } })] })).segments[0].equation.terms.map(t => t.exponent), [2, -1, 0]);
});

test('25. a set of series: analytic series replace only analytic series of the same variant and property', () => {
  const catalog = syntheticSystemCatalog();
  const v1 = analytic({ id: 'fixture:analytic-k-1' });
  const v2 = analytic({ id: 'fixture:analytic-k-2', version: 2, supersedes: 'fixture:analytic-k-1' });
  const codes = (list: unknown[]) => validatePropertySeriesSet(list, catalog).issues.filter(i => i.severity === 'error').map(i => i.code);
  assert.deepEqual(codes([v1, v2]), []);
  assert.deepEqual(codes([singleTable({ id: 'fixture:table-k-1' }), analytic({ id: 'fixture:analytic-k-9', version: 2, supersedes: 'fixture:table-k-1' })]), ['supersedes_invalid']);
  assert.deepEqual(codes([v1, { ...v2, version: 1 }]), ['supersedes_invalid']);
  assert.ok(codes([v1, { ...v1 }]).includes('duplicate_id'));
  assert.ok(MAX_SEGMENTS === 100 && MAX_POWER_EXPONENT === 6);
});

// ---------- Step 3 audit corrections F1-F4 ----------

const coeffUncertainty = (value: number, uncertainty: unknown, extra: Record<string, unknown> = {}) => analytic({ ...extra, segments: [segment('s1', 300, 600, {}, { terms: [{ ...term(0, value), uncertainty }, term(1, 1)] })] });

test('F1: the uncertainty of a coefficient and the residual spread of the fit are stored together, as different quantities', () => {
  const standard = { kind: 'standard' as const, u: 0.1, origin: 'stated_in_source' as const };
  const withFit = (u: unknown, fit: unknown = { residualStandardDeviation: 0.3 }) => coeffUncertainty(1, u, { uncertaintyScope: 'fit_residual', fit } as never);
  assert.deepEqual(errs(withFit(standard)), []);                                                                       // 1
  assert.deepEqual(errs(withFit({ kind: 'bounds', lower: 0.5, upper: 1.5, origin: 'stated_in_source' })), []);         // 2
  assert.deepEqual(errs(withFit({ kind: 'bounds', lower: 1.5, upper: 2, origin: 'stated_in_source' })), ['invalid_uncertainty']);   // 2: the nominal is outside
  assert.deepEqual(errs(withFit({ kind: 'unknown' })), []);                                                            // 3
  const kept = createPropertySeries(withFit({ kind: 'unknown' }));
  assert.deepEqual(kept.segments[0].equation.terms[0].uncertainty, { kind: 'unknown' });                               // unknown stays unknown, not zero and not the residual
  for (const fit of [{ residualStandardDeviation: 0 }, { residualStandardDeviation: -0.3 }, { residualStandardDeviation: Number.NaN }, { residualStandardDeviation: Number.POSITIVE_INFINITY }, { residualStandardDeviation: '0.3' }, null, []]) assert.ok(errs(withFit(standard, fit)).length > 0, JSON.stringify(fit));   // 4
  assert.deepEqual(errs(coeffUncertainty(1, standard, { uncertaintyScope: 'fit_residual' } as never)), ['invalid_series']);                                            // fit_residual still needs its residual
  // 5: nothing is derived: both numbers come back exactly as written, and the independence of the coefficients is not assumed
  const both = createPropertySeries(withFit(standard));
  assert.deepEqual(both.segments[0].equation.terms[0].uncertainty, standard);
  assert.deepEqual(both.fit, { residualStandardDeviation: 0.3 });
  assert.deepEqual(both.coefficientCorrelation, { kind: 'unknown' });
  assert.deepEqual(errs(coeffUncertainty(1, standard, { uncertaintyScope: 'fit_coefficients', fit: { residualStandardDeviation: 0.3 } } as never)), []);
  assert.deepEqual(errs({ ...analytic(), uncertaintyScope: 'fit_coefficients' }), ['invalid_series']);                  // unchanged: coefficients scope with nothing stated
});

test('F2: the limits of a coefficient are not subject to the physical-value rules of the property', () => {
  const b = (value: number, lower: unknown, upper: unknown) => coeffUncertainty(value, { kind: 'bounds', lower, upper, origin: 'stated_in_source' });
  assert.deepEqual(errs(b(-1, -2, 0)), []);                                                                            // 1: the audit example
  assert.deepEqual(errs(b(-1, -2, 0), bulk), []);
  assert.deepEqual(errs(b(0, -1, 1)), []);                                                                             // 2
  assert.deepEqual(errs(b(1, 0.5, 1.5)), []);                                                                          // 3
  assert.deepEqual(errs(b(-1, 0, -2)), ['invalid_uncertainty']);                                                       // 4: reversed
  assert.deepEqual(errs(b(1, 2, 3)), ['invalid_uncertainty']);                                                         // 5: the nominal is outside
  assert.deepEqual(errs(b(-3, -2, 0)), ['invalid_uncertainty']);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null, undefined]) {            // 6
    assert.deepEqual(errs(b(1, bad, 2)), ['invalid_uncertainty'], `lower ${String(bad)}`);
    assert.deepEqual(errs(b(1, 0, bad)), ['invalid_uncertainty'], `upper ${String(bad)}`);
  }
  assert.deepEqual(errs(coeffUncertainty(-1, { kind: 'bounds', lower: -2, upper: 0 })), ['invalid_uncertainty']);       // the origin is still required
  assert.deepEqual(errs(coeffUncertainty(-1, { kind: 'bounds', lower: -2, upper: 0, origin: 'stated_in_source', extra: 1 })), ['invalid_uncertainty']);
  assert.deepEqual(errs(coeffUncertainty(-1, { kind: 'standard', u: 0.1, origin: 'stated_in_source' })), []);
  // 7: the rules for a property VALUE are untouched: a negative observation, a negative record-like value with negative limits
  assert.ok(errs(bulkSeries({ points: [obs('p1', 300, -1, { uncertainty: { kind: 'bounds', lower: -2, upper: 0, origin: 'stated_in_source' } }), obs('p2', 400, 2)] })).includes('invalid_quantity'));
  assert.ok(errs(bulkSeries({ points: [obs('p1', 300, 1, { uncertainty: { kind: 'bounds', lower: -1, upper: 2, origin: 'stated_in_source' } }), obs('p2', 400, 2)] })).includes('invalid_uncertainty'));
  assert.ok(errs(singleTable({ rows: [obs('r1', 300, 1, { uncertainty: { kind: 'bounds', lower: -1, upper: 2, origin: 'stated_in_source' } }), obs('r2', 400, 2)] })).includes('invalid_uncertainty'));
});

test('F3: the reference temperature of a mean expansion coefficient must not belong to the domain of any segment (open bounds, K and degC)', () => {
  const alpha = (segments: unknown[], ref: unknown) => analytic({ property: 'linear_expansion_coefficient', commonConditions: { expansionDefinition: 'mean', referenceTemperature: ref } as never, segments: segments as never });
  const cu = (id: string, min: number, max: number, minInclusive: boolean, maxInclusive: boolean) => segment(id, min, max, { domain: { min: q(min, 'K'), max: q(max, 'K'), minInclusive, maxInclusive } }, { terms: [{ ...term(0), coefficient: { type: 'scalar', value: 10, unit: 'ppm_K' } }] });
  const run = (min: boolean, max: boolean, ref: number, unit = 'K') => errs(alpha([cu('s1', 300, 600, min, max)], q(ref, unit)), bulk);
  assert.deepEqual(run(false, false, 450), ['invalid_condition']);                                                     // 1
  assert.deepEqual(run(false, false, 300), []);                                                                        // 2
  assert.deepEqual(run(true, false, 300), ['invalid_condition']);                                                      // 3
  assert.deepEqual(run(false, true, 600), ['invalid_condition']);                                                      // 4
  assert.deepEqual(run(true, false, 600), []);                                                                         // 5
  assert.deepEqual(run(true, true, 100), []);                                                                          // 6
  assert.deepEqual(run(true, true, 900), []);
  assert.deepEqual(run(false, false, 600), []);
  assert.deepEqual(run(true, true, 300), ['invalid_condition']);
  assert.deepEqual(run(true, true, 600), ['invalid_condition']);
  // 7: the same in degC (26.85 degC = 300 K, 176.85 degC = 450 K, 326.85 degC = 600 K)
  assert.deepEqual(run(false, false, 176.85, 'degC'), ['invalid_condition']);
  assert.deepEqual(run(false, false, 26.85, 'degC'), []);
  assert.deepEqual(run(true, false, 26.85, 'degC'), ['invalid_condition']);
  assert.deepEqual(run(false, true, 326.85, 'degC'), ['invalid_condition']);
  assert.deepEqual(run(true, false, 326.85, 'degC'), []);
  // the bounds themselves may be written in degC
  const celsius = segment('s1', 300, 600, { domain: { min: q(26.85, 'degC'), max: q(326.85, 'degC'), minInclusive: false, maxInclusive: false } }, { terms: [{ ...term(0), coefficient: { type: 'scalar', value: 10, unit: 'ppm_K' } }] });
  assert.deepEqual(errs(alpha([celsius], q(300, 'K')), bulk), []);
  assert.deepEqual(errs(alpha([celsius], q(450, 'K')), bulk), ['invalid_condition']);
  // 8: several segments with a common boundary: the joint belongs to exactly one of them, and so does the verdict
  const joint = (ref: number) => errs(alpha([cu('a', 300, 450, true, false), cu('b', 450, 600, true, false)], q(ref, 'K')), bulk);
  assert.deepEqual(joint(450), ['invalid_condition']);                                                                 // belongs to b
  assert.deepEqual(joint(375), ['invalid_condition']);
  assert.deepEqual(joint(700), []);
  assert.deepEqual(errs(alpha([cu('a', 300, 450, true, true), cu('b', 450, 600, false, false)], q(450, 'K')), bulk), ['invalid_condition']);   // belongs to a
  assert.deepEqual(errs(alpha([cu('a', 300, 450, true, false), cu('b', 450, 600, false, false)], q(450, 'K')), bulk), []);                      // belongs to neither
  // the other rules of the mean coefficient are unchanged; the tangent one has no reference temperature; point series and tables keep their rule
  assert.deepEqual(errs(alpha([cu('s1', 300, 600, true, false)], undefined), bulk), ['missing_condition']);
  assert.deepEqual(errs(alpha([cu('s1', 300, 600, true, false)], q(10, 'K_delta')), bulk), ['invalid_quantity']);
  assert.deepEqual(errs(analytic({ property: 'linear_expansion_coefficient', commonConditions: { expansionDefinition: 'tangent' } as never, segments: [cu('s1', 300, 600, true, false)] as never }), bulk), []);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(350, 'K') }, [350, 400]), bulk), ['invalid_condition']);
  assert.deepEqual(errs(alphaSeries({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') }, [350, 400]), bulk), []);
});

test('F4: an event against an analytic temperature interval honours open and closed bounds', () => {
  const ev = (effect: string, kelvin: number, unit = 'K') => ({ kind: 'phase_transition' as const, temperature: q(kelvin, unit), effect: effect as never, source: src });
  const run = (segments: unknown[], events: unknown[]) => {
    const series = analytic({ segments: segments as never, applicability: { events, stability: { kind: 'not_stated' } } as never });
    return { errors: errs(series), warnings: warns(series), infos: infos(series) };
  };
  const half = seg('s1', 300, 600, true, false); const closed = seg('s1', 300, 600, true, true);
  assert.deepEqual(run([half], [ev('range_ends_before', 600)]).errors, []);                                            // 1
  assert.deepEqual(run([closed], [ev('range_ends_before', 600)]).errors, ['event_contradicts_domain']);                // 2
  assert.deepEqual(run([half], [ev('range_ends_before', 599)]).errors, ['event_contradicts_domain']);                  // 3: inside
  assert.deepEqual(run([half], [ev('range_ends_before', 450)]).errors, ['event_contradicts_domain']);
  assert.deepEqual(run([half], [ev('range_ends_before', 700)]).errors, []);                                            // 4: outside
  assert.deepEqual(run([half], [ev('range_ends_before', 200)]).errors, ['event_contradicts_domain']);                  // the whole domain lies beyond the limit
  assert.deepEqual(run([half], [ev('range_ends_before', 326.85, 'degC')]).errors, []);                                 // 5: 326.85 degC = 600 K
  assert.deepEqual(run([closed], [ev('range_ends_before', 326.85, 'degC')]).errors, ['event_contradicts_domain']);
  assert.deepEqual(run([half], [ev('range_ends_before', 176.85, 'degC')]).errors, ['event_contradicts_domain']);
  // 6: neighbouring segments
  assert.deepEqual(run([seg('a', 300, 450, true, false), seg('b', 450, 600, true, false)], [ev('range_ends_before', 600)]).errors, []);
  assert.deepEqual(run([seg('a', 300, 450, true, false), seg('b', 450, 600, true, true)], [ev('range_ends_before', 600)]).errors, ['event_contradicts_domain']);
  assert.deepEqual(run([seg('a', 300, 450, true, false), seg('b', 450, 600, true, false)], [ev('range_ends_before', 450)]).errors, ['event_contradicts_domain']);   // b starts at the limit and belongs to it
  assert.deepEqual(run([seg('a', 300, 450, true, true), seg('b', 450, 600, false, false)], [ev('range_ends_before', 450)]).errors, ['event_contradicts_domain']);
  // other effects at the excluded bound do not make a false finding; inside the interval they are diagnosed as before
  for (const effect of ['discontinuity', 'irreversible_change', 'unknown']) {
    const atBound = run([half], [ev(effect, 600)]);
    assert.deepEqual(atBound.errors, [], effect);
    assert.ok(!atBound.warnings.includes('potential_incomparability') && !atBound.warnings.includes('irreversible_change_in_domain') && !atBound.warnings.includes('event_effect_unknown'), effect);
    assert.ok(!atBound.infos.includes('interval_crosses_event'), effect);
    const inside = run([half], [ev(effect, 450)]);
    assert.ok(inside.warnings.includes('segment_crosses_event'), effect);
    assert.ok(inside.warnings.includes('potential_incomparability') || inside.infos.includes('interval_crosses_event'), effect);
  }
  assert.ok(run([closed], [ev('discontinuity', 600)]).infos.includes('interval_crosses_event'));                       // a closed bound belongs to the domain
  // an event given as a RANGE: the limit starts where the range starts
  const range = (min: number, max: number) => ({ kind: 'phase_transition' as const, range: { min: q(min, 'K'), max: q(max, 'K') }, effect: 'range_ends_before' as never, source: src });
  assert.deepEqual(run([half], [range(600, 650)]).errors, []);
  assert.deepEqual(run([half], [range(550, 650)]).errors, ['event_contradicts_domain']);
  // point series keep the point semantics: an observation AT the limit contradicts it
  const pointApp = { events: [ev('range_ends_before', 400)], stability: { kind: 'not_stated' as const } };
  assert.deepEqual(errs(bulkSeries({ applicability: pointApp })), ['event_contradicts_domain']);
  assert.deepEqual(errs(bulkSeries({ applicability: { events: [ev('range_ends_before', 401)], stability: { kind: 'not_stated' } } })), []);
});
