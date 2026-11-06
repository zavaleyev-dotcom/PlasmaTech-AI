import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePropertyRecord, isValidIsbn, MIN_SOURCE_YEAR, MAX_SOURCE_YEAR, type PropertyRecord } from '../src/materials';
import { densityRecord, syntheticProvenance, syntheticSource } from './materials-property-fixtures';

const rec = (provenance: unknown, over: Partial<PropertyRecord> = {}): PropertyRecord => densityRecord({ provenance: provenance as never, ...over });
const prov = (over: Record<string, unknown> = {}) => ({ ...syntheticProvenance(), ...over });
const src = (over: Record<string, unknown> = {}) => ({ ...syntheticSource(), ...over });
const report = (r: unknown) => validatePropertyRecord(r).issues;
const errs = (r: unknown) => report(r).filter(i => i.severity === 'error').map((i): string => i.code);
const codes = (r: unknown, severity: string) => report(r).filter(i => i.severity === severity).map((i): string => i.code);
const without = (obj: Record<string, unknown>, key: string): Record<string, unknown> => { const { [key]: _, ...rest } = obj; void _; return rest; };

test('a complete synthetic provenance passes; a well-formed DOI is only a format, the record stays unverified', () => {
  assert.deepEqual(errs(rec(prov())), []);
  const issues = report(rec(prov()));
  assert.ok(issues.some(i => i.code === 'identifier_unchecked' && i.severity === 'info'));              // "the format is right; the publication was NOT checked"
  assert.ok(issues.some(i => i.code === 'unverified_value' && i.severity === 'info'));                  // and the value is not called confirmed
  assert.ok(issues.every(i => i.code !== 'identifier_unchecked' || /НЕ проверялись/.test(i.message)));
});

test('the source: type, title, year and an identifiable origin (authors or an identifier) are required for measured / evaluated values', () => {
  for (const status of ['measured', 'evaluated']) {
    assert.deepEqual(errs(rec(prov({ status }))), [], status);
    assert.deepEqual(errs(rec(prov({ status, source: without(src(), 'title') }))), ['invalid_provenance'], status);
    assert.deepEqual(errs(rec(prov({ status, source: without(src(), 'year') }))), ['invalid_provenance'], status);
    assert.deepEqual(errs(rec(prov({ status, source: without(without(src(), 'authors'), 'identifiers') }))), ['source_unidentifiable'], status);
    assert.deepEqual(errs(rec(prov({ status, source: without(src(), 'authors') }))), [], status);                       // an identifier alone is enough to find it
    assert.deepEqual(errs(rec(prov({ status, source: without(src(), 'identifiers') }))), [], status);                   // so are the authors
    assert.deepEqual(errs(rec(prov({ status, source: { ...src(), type: 'user_data' } }))), ['invalid_provenance'], status);
    assert.deepEqual(errs(rec(prov({ status, source: src({ type: 'magazine' }) }))), ['invalid_provenance'], status);
  }
  assert.deepEqual(errs(rec(without(prov(), 'source'))), ['invalid_provenance']);                                        // no source at all
  assert.deepEqual(errs(rec(prov({ source: null }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(null)), ['invalid_provenance']);
  assert.deepEqual(errs(rec(undefined)), ['invalid_provenance']);
  for (const type of ['journal_article', 'book', 'handbook', 'standard', 'thesis', 'report', 'database', 'dataset', 'other']) assert.deepEqual(errs(rec(prov({ source: src({ type }) }))), [], type);
});

test('year, authors, title are checked; nothing is invented', () => {
  for (const bad of [MIN_SOURCE_YEAR - 1, MAX_SOURCE_YEAR + 1, 2000.5, NaN, '2000']) assert.deepEqual(errs(rec(prov({ source: src({ year: bad }) }))), ['invalid_provenance'], String(bad));
  assert.deepEqual(errs(rec(prov({ source: src({ year: MIN_SOURCE_YEAR }) }))), []);
  assert.deepEqual(errs(rec(prov({ source: src({ authors: [] }) }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ source: src({ authors: [''] }) }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ source: src({ authors: 'one author' }) }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ source: src({ title: '' }) }))), ['invalid_provenance']);
});

test('identifiers: DOI syntax, ISBN check digit, URL, standard number; duplicates and bad formats refused', () => {
  const ids = (identifiers: unknown) => rec(prov({ source: src({ identifiers }) }));
  assert.deepEqual(errs(ids([{ type: 'doi', value: '10.0000/synthetic.fixture' }])), []);
  assert.deepEqual(errs(ids([{ type: 'doi', value: 'https://doi.org/10.0000/Synthetic.Fixture' }])), []);               // a DOI URL form is a DOI too
  for (const bad of ['10.12/x', 'doi', '11.0000/x', '10.0000/', '']) assert.deepEqual(errs(ids([{ type: 'doi', value: bad }])), ['invalid_identifier'], bad);
  assert.deepEqual(errs(ids([{ type: 'doi', value: '10.0000/a' }, { type: 'doi', value: '10.0000/A' }])), ['invalid_identifier']);   // the same DOI twice
  assert.deepEqual(errs(ids([{ type: 'isbn', value: '978-0-306-40615-7' }])), []);                                          // a standard ISBN-13 example with a correct check digit
  assert.deepEqual(errs(ids([{ type: 'isbn', value: '0-306-40615-2' }])), []);                                              // ISBN-10
  assert.deepEqual(errs(ids([{ type: 'isbn', value: '978-0-306-40615-8' }])), ['invalid_identifier']);                      // a wrong check digit
  assert.deepEqual(errs(ids([{ type: 'isbn', value: '12345' }])), ['invalid_identifier']);
  assert.deepEqual(errs(ids([{ type: 'url', value: 'https://example.org/x' }])), []);
  for (const bad of ['ftp://x', 'javascript:alert(1)', 'https://user:pw@example.org', 'not a url']) assert.deepEqual(errs(ids([{ type: 'url', value: bad }])), ['invalid_identifier'], bad);
  assert.deepEqual(errs(ids([{ type: 'standard_number', value: 'СИНТЕТИЧЕСКИЙ СТ 0000' }])), []);
  assert.deepEqual(errs(ids([{ type: 'standard_number', value: ' ' }])), ['invalid_identifier']);
  assert.deepEqual(errs(ids([{ type: 'orcid', value: 'x' }])), ['invalid_identifier']);
  assert.deepEqual(errs(ids([])), ['invalid_identifier']);
  assert.deepEqual(errs(ids('doi:10.0000/x')), ['invalid_identifier']);
  assert.ok(isValidIsbn('9780306406157') && isValidIsbn('0306406152') && !isValidIsbn('9780306406158') && !isValidIsbn(5) && !isValidIsbn(''));
});

test('locator and method: the place in the source and how the value was obtained', () => {
  assert.ok(codes(rec(without(prov(), 'locator')), 'warning').includes('missing_locator'));                              // a warning: harder to verify
  assert.deepEqual(errs(rec(without(prov(), 'locator'))), []);
  for (const locator of [{ page: '12' }, { table: 'T1' }, { figure: 'Fig. 3' }, { equation: '(4)' }, { section: '2.1' }, { page: '12', table: 'T1' }]) assert.deepEqual(errs(rec(prov({ locator }))), [], JSON.stringify(locator));
  assert.deepEqual(errs(rec(prov({ locator: {} }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ locator: { page: '' } }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ locator: { chapter: '1' } }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(without(prov(), 'method'))), ['missing_method']);                                              // measured needs a method
  assert.deepEqual(errs(rec(prov({ method: '' }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(without(prov({ status: 'evaluated' }), 'method'))), []);                                      // an evaluation may not state one (an info note)
  assert.ok(codes(rec(without(prov({ status: 'evaluated' }), 'method')), 'info').includes('missing_method'));
});

test('statuses: measured, evaluated, model_estimate, user_input and the rules each carries', () => {
  assert.deepEqual(errs(rec(prov({ status: 'invented' }))), ['invalid_provenance']);
  // model_estimate: the model must be named (method) and its source identifiable
  const model = prov({ status: 'model_estimate', method: 'СИНТЕТИЧЕСКАЯ модель', source: src({ type: 'report' }) });
  assert.deepEqual(errs(rec(model)), []);
  assert.deepEqual(errs(rec(without(model, 'method'))), ['missing_method']);
  assert.deepEqual(errs(rec({ ...model, source: { type: 'report' } })), ['source_unidentifiable']);
  // user_input: the user's own data; no primary source to verify against
  const user = { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } };
  assert.deepEqual(errs(rec(user, { id: 'user:my-density' })), []);
  assert.deepEqual(errs(rec(user, { id: 'fixture:u' })), []);
  assert.deepEqual(errs(rec({ ...user, source: src() }, { id: 'user:my-density' })), ['invalid_provenance']);              // a journal article is not user data
  assert.deepEqual(errs(rec({ ...user, verification: { status: 'unverified' } }, { id: 'user:my-density' })), ['verification_inconsistent']);
  assert.deepEqual(errs(rec({ ...user, verification: { status: 'verified_against_source', verifiedBy: 'x', verifiedAt: '2000-01-01' } }, { id: 'user:my-density' })), ['verification_inconsistent']);
});

test('verification is a statement by a named person on a date; "unverified" is the honest default; no inference from a DOI', () => {
  const v = (verification: unknown) => rec(prov({ verification }));
  assert.deepEqual(errs(v({ status: 'unverified' })), []);
  assert.deepEqual(errs(v({ status: 'verified_against_source', verifiedBy: 'СИНТЕТИЧЕСКИЙ СВЕРЯЮЩИЙ', verifiedAt: '2000-01-02' })), []);
  assert.deepEqual(codes(v({ status: 'verified_against_source', verifiedBy: 'С', verifiedAt: '2000-01-02' }), 'info').includes('unverified_value'), false);
  assert.deepEqual(errs(v({ status: 'verified_against_source' })), ['verification_inconsistent', 'verification_inconsistent']);
  assert.deepEqual(errs(v({ status: 'verified_against_source', verifiedBy: 'С' })), ['verification_inconsistent']);
  assert.deepEqual(errs(v({ status: 'verified_against_source', verifiedBy: '', verifiedAt: '2000-01-02' })), ['verification_inconsistent']);
  assert.deepEqual(errs(v({ status: 'verified_against_source', verifiedBy: 'С', verifiedAt: '2000-02-30' })), ['verification_inconsistent']);
  assert.deepEqual(errs(v({ status: 'unverified', verifiedBy: 'С' })), ['verification_inconsistent']);                     // an unverified record carries no verifier
  assert.deepEqual(errs(v({ status: 'not_applicable' })), ['verification_inconsistent']);                                   // only for the user's own data
  assert.deepEqual(errs(v({ status: 'checked' })), ['invalid_provenance']);
  assert.deepEqual(errs(v(undefined)), ['invalid_provenance']);
  assert.deepEqual(errs(v(null)), ['invalid_provenance']);
  // a record with a valid DOI and nothing else is NOT verified
  assert.ok(codes(rec(prov()), 'info').includes('unverified_value'));
});

test('namespaces keep the user\'s data apart from the shipped reference data', () => {
  const user = { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } };
  assert.deepEqual(errs(rec(user, { id: 'ref:x' })), ['namespace_mismatch']);                                              // shipped data cannot be user input
  assert.deepEqual(errs(rec(prov(), { id: 'user:x' })), ['namespace_mismatch']);                                           // a user's record is user_input
  assert.deepEqual(errs(rec(prov(), { id: 'ref:x' })), []);
  assert.deepEqual(errs(rec(prov(), { id: 'fixture:x' })), []);
});

test('unknown fields in provenance, source, locator, verification and identifiers are errors', () => {
  const extra = { physicalProperty: 123 };
  assert.deepEqual(errs(rec(prov(extra))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ source: src(extra) }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ locator: { table: 'T', ...extra } }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ verification: { status: 'unverified', ...extra } }))), ['invalid_provenance']);
  assert.deepEqual(errs(rec(prov({ source: src({ identifiers: [{ type: 'doi', value: '10.0000/x', ...extra }] }) }))), ['invalid_identifier']);
  assert.deepEqual(errs({ ...densityRecord(), ...extra }), ['invalid_property']);
});
