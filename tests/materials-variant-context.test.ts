import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePropertyRecord, validatePropertyRecords, validateVariant, isValidIsbn, type MaterialCatalog, type MaterialVariant, type PropertyRecord } from '../src/materials';
import { syntheticSystemCatalog, syntheticCompound, syntheticElement } from './materials-fixtures';
import { conductivityRecord, syntheticProvenance } from './materials-property-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const FILM = 'fixture:synthetic-compound-film';
const BULK = 'fixture:synthetic-element-bulk';
const set = (records: unknown, catalog: unknown) => validatePropertyRecords(records, catalog);
const errs = (report: { issues: readonly { severity: string; code: string }[] }): string[] => report.issues.filter(i => i.severity === 'error').map(i => i.code);
const deep = <T>(x: T): T => structuredClone(x);

const bulkRecord = (): PropertyRecord => conductivityRecord({ id: 'fixture:rec-bulk-k', variant: BULK });                              // T only: enough for a bulk piece
const filmRecordPoor = (): PropertyRecord => conductivityRecord({ id: 'fixture:rec-film-k', variant: FILM });                           // T only: NOT enough for a film
const filmRecordFull = (): PropertyRecord => conductivityRecord({ id: 'fixture:rec-film-k', variant: FILM, conditions: { temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'in_plane' } as never });

// ---------- F1: the variant a record points at must itself be valid ----------

test('F1: the audit reproduction - a variant with only an id and form = null is NOT accepted', () => {
  const report = set([conductivityRecord()], { variants: [{ id: 'fixture:synthetic-element-bulk', form: null }] });
  assert.equal(report.ok, false);
  assert.ok(errs(report).includes('invalid_form'));                                                                                    // the diagnosis names the damaged form
  assert.ok(errs(report).includes('invalid_material'));
  assert.ok(report.issues.some(i => i.path.startsWith('catalog.variants[0]')));
});

test('F1: damaged targets - missing form, null form, unknown form kind, only an id, a non-object', () => {
  const damaged: [string, unknown][] = [
    ['no form', (() => { const { form: _f, ...rest } = syntheticElement(); void _f; return rest; })()],
    ['form: null', { ...syntheticElement(), form: null }],
    ['form: {}', { ...syntheticElement(), form: {} }],
    ['unknown form kind', { ...syntheticElement(), form: { kind: 'brick' } }],
    ['only an id', { id: BULK }],
    ['composition: null', { ...syntheticElement(), composition: null }],
    ['phase: null', { ...syntheticElement(), phase: null }],
    ['identity: 5', { ...syntheticElement(), identity: 5 }],
  ];
  for (const [name, variant] of damaged) {
    const report = set([bulkRecord()], { identities: [], variants: [variant] });
    assert.equal(report.ok, false, name);
    assert.ok(errs(report).includes('invalid_material'), name);
    assert.equal(validatePropertyRecord(bulkRecord(), variant).ok, false, `${name} (single record)`);                                   // the one-record entry point too
  }
  for (const variants of [[null], [5], ['x'], [[]]]) assert.deepEqual(errs(set([bulkRecord()], { variants })), ['missing_reference'], JSON.stringify(variants));   // not even a variant
});

test('F1: a damaged variant does not pass by skipping the film conditions - nor is a broken form read as "bulk"', () => {
  const film = syntheticSystemCatalog().variants.find(v => v.id === FILM)!;
  for (const form of [null, undefined, {}, { kind: 'brick' }, 'thin_film', 5, []]) {
    const variant = { ...film, form } as unknown;
    // the record has NO film conditions: with a healthy film variant it fails (missing_condition); with a broken form it must fail too, never pass as bulk
    const poor = set([filmRecordPoor()], { identities: [], variants: [variant] });
    assert.equal(poor.ok, false, JSON.stringify(form));
    // the record WITH all film conditions: still refused, because the variant itself is not valid
    const full = set([filmRecordFull()], { identities: [], variants: [variant] });
    assert.equal(full.ok, false, `${JSON.stringify(form)} (full conditions)`);
    assert.ok(errs(full).includes('invalid_material'), JSON.stringify(form));
  }
});

test('F1: two variants with one id (different forms) are ambiguous and rejected - neither is picked', () => {
  const bulkForm: MaterialVariant = { ...syntheticElement(), id: 'fixture:twin' };
  const filmForm: MaterialVariant = { ...syntheticElement(), id: 'fixture:twin', form: { kind: 'thin_film', thickness: q(100, 'nm') } };
  const catalog: MaterialCatalog = { identities: [], variants: [bulkForm, filmForm] };
  const record = conductivityRecord({ id: 'fixture:rec-twin', variant: 'fixture:twin' });                                              // T only: would pass if the BULK twin were taken
  const report = set([record], catalog);
  assert.equal(report.ok, false);
  assert.deepEqual(errs(report), ['duplicate_id']);
  assert.match(report.issues.find(i => i.code === 'duplicate_id')!.message, /неоднозначн/);
  // the order does not matter, and the film twin first does not help either
  assert.equal(set([record], { identities: [], variants: [filmForm, bulkForm] }).ok, false);
  // the same with two IDENTICAL variants: still ambiguous (they are two records, not one)
  assert.deepEqual(errs(set([record], { identities: [], variants: [bulkForm, deep(bulkForm)] })), ['duplicate_id']);
  // a duplicate that no record refers to is not this function's concern (validateCatalog reports it)
  assert.equal(set([bulkRecord()], { identities: [], variants: [syntheticElement(), bulkForm, deep(bulkForm)] }).ok, true);
});

test('F1: a valid film needs thickness AND direction; with them it passes; a valid bulk piece passes with its allowed conditions', () => {
  const catalog = syntheticSystemCatalog();
  assert.deepEqual(errs(set([filmRecordPoor()], catalog)), ['missing_condition', 'missing_condition']);
  assert.deepEqual(errs(set([filmRecordFull()], catalog)), []);
  assert.equal(set([filmRecordFull()], catalog).ok, true);
  assert.deepEqual(errs(set([bulkRecord()], catalog)), []);
  assert.deepEqual(errs(set([conductivityRecord({ variant: BULK, conditions: { temperature: q(300, 'K'), direction: 'in_plane', atmosphere: 'СИНТЕТИЧЕСКАЯ' } as never })], catalog)), []);
  assert.deepEqual(errs(set([filmRecordFull(), bulkRecord()], catalog)), []);
  // a record of a bulk piece with a condition the property does not allow
  assert.deepEqual(errs(set([conductivityRecord({ variant: BULK, conditions: { temperature: q(300, 'K'), heatCapacityMode: 'isobaric' } as never })], catalog)), ['condition_not_allowed']);
  // the single-record entry point behaves the same way for a valid variant
  assert.deepEqual(errs(validatePropertyRecord(filmRecordPoor(), syntheticCompound())), ['missing_condition', 'missing_condition']);
  assert.equal(validatePropertyRecord(bulkRecord(), syntheticElement()).ok, true);
});

// ---------- damaged nested fields: never an exception, never a pass through the damage ----------

const GARBAGE: unknown[] = [null, undefined, 5, 'x', [], {}, true, NaN];
function pathsOf(value: unknown, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (value !== null && typeof value === 'object') for (const key of Object.keys(value)) { const p = [...prefix, Array.isArray(value) ? Number(key) : key]; out.push(p); pathsOf((value as Record<string, unknown>)[key], p, out); }
  return out;
}
function setAt(root: unknown, path: (string | number)[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

test('damage anywhere in a variant: a report, never an exception - and a record set is OK only if the variant is valid', () => {
  const base = syntheticSystemCatalog();
  for (const id of [FILM, 'fixture:synthetic-system-film']) {
    const target = base.variants.find(v => v.id === id)!;
    const index = base.variants.findIndex(v => v.id === id);
    const record = id === FILM ? filmRecordFull() : conductivityRecord({ id: 'fixture:rec-system-k', variant: id, conditions: { temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'in_plane' } as never });
    assert.equal(set([record], base).ok, true, `${id}: the undamaged variant with full conditions passes`);
    const paths = pathsOf(target);
    assert.ok(paths.length > 5);
    for (const path of paths) for (const garbage of GARBAGE) {
      const catalog = deep(base) as unknown as { variants: unknown[] };
      setAt(catalog.variants[index], path, garbage);
      const damaged = catalog.variants[index];
      let report: ReturnType<typeof validatePropertyRecords> | undefined;
      assert.doesNotThrow(() => { report = set([record], catalog); }, `${id} ${path.join('.')}`);
      assert.doesNotThrow(() => validatePropertyRecord(record, damaged), `${id} ${path.join('.')} (single)`);
      // the invariant: if the variant is not valid, the record set is not OK (the damage is never skipped over)
      if (!validateVariant(damaged).ok) {
        assert.equal(report!.ok, false, `${id} ${path.join('.')} = ${String(garbage)}`);
        assert.equal(validatePropertyRecord(record, damaged).ok, false, `${id} ${path.join('.')} = ${String(garbage)} (single)`);
      }
    }
  }
});

// ---------- F2: ISBN ----------

test('F2: ISBN-13 needs the prefix 978 or 979, a correct check digit, 13 digits; not any EAN-13', () => {
  assert.equal(isValidIsbn('0000000000000'), false);                                                                                   // the audit case: a correct EAN check digit, no ISBN prefix
  assert.equal(isValidIsbn('9780306406157'), true);                                                                                    // 978, correct check digit
  assert.equal(isValidIsbn('978-0-306-40615-7'), true);                                                                                // separators are ignored, as before
  assert.equal(isValidIsbn('979 10 90636 07 1'), true);                                                                                // 979, correct check digit
  assert.equal(isValidIsbn('9791090636071'), true);
  assert.equal(isValidIsbn('9780306406158'), false);                                                                                   // 978, wrong check digit
  assert.equal(isValidIsbn('9791090636070'), false);                                                                                   // 979, wrong check digit
  assert.equal(isValidIsbn('1234567890128'), false);                                                                                   // an EAN-13 with a correct check digit, wrong prefix
  assert.equal(isValidIsbn('9771234567898'), false);                                                                                   // 977 (ISSN-based EAN) with a correct check digit
  assert.equal(isValidIsbn('9770000000000'), false);
  assert.equal(isValidIsbn('978030640615'), false);                                                                                    // 12 digits
  assert.equal(isValidIsbn('97803064061577'), false);                                                                                  // 14 digits
  assert.equal(isValidIsbn('978030640615X'), false);                                                                                   // X is only for ISBN-10
});

test('F2: ISBN-10 is still supported, including the X check character', () => {
  assert.equal(isValidIsbn('0306406152'), true);
  assert.equal(isValidIsbn('0-306-40615-2'), true);
  assert.equal(isValidIsbn('080442957X'), true);                                                                                       // check character X
  assert.equal(isValidIsbn('080442957x'), true);
  assert.equal(isValidIsbn('0306406153'), false);                                                                                      // wrong check digit
  assert.equal(isValidIsbn('080442958X'), false);
  assert.equal(isValidIsbn('X306406152'), false);                                                                                      // X only at the end
  assert.equal(isValidIsbn('030640615'), false);
  for (const bad of [5, null, undefined, {}, '', ' ', 'abc']) assert.equal(isValidIsbn(bad), false, String(bad));
});

test('F2: a source whose only identifier is an invalid ISBN is not identifiable; a valid ISBN does not verify the record; no network is involved', () => {
  const rec = (identifiers: unknown, extra: Record<string, unknown> = {}): PropertyRecord => conductivityRecord({
    provenance: { ...syntheticProvenance(), source: { type: 'book', title: 'СИНТЕТИЧЕСКАЯ КНИГА', year: 2000, identifiers, ...extra } } as never,
  });
  const codes = (r: PropertyRecord) => validatePropertyRecord(r).issues.filter(i => i.severity === 'error').map(i => i.code);
  const all = (r: PropertyRecord) => validatePropertyRecord(r).issues;
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '0000000000000' }])), ['invalid_identifier', 'source_unidentifiable']);               // no authors, the one identifier is invalid
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '9780306406158' }])), ['invalid_identifier', 'source_unidentifiable']);
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '9771234567898' }])), ['invalid_identifier', 'source_unidentifiable']);
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '0000000000000' }], { authors: ['СИНТЕТИЧЕСКИЙ АВТОР'] })), ['invalid_identifier']);   // the authors still identify the source, the bad ISBN is still an error
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '9780306406157' }])), []);
  assert.deepEqual(codes(rec([{ type: 'isbn', value: '979-10-90636-07-1' }])), []);
  // a well-formed ISBN is only a format: the record stays unverified and says so
  const valid = all(rec([{ type: 'isbn', value: '9780306406157' }]));
  assert.ok(valid.some(i => i.code === 'identifier_unchecked' && /НЕ проверялись/.test(i.message)));
  assert.ok(valid.some(i => i.code === 'unverified_value'));
  assert.equal(rec([{ type: 'isbn', value: '9780306406157' }]).provenance.verification.status, 'unverified');
});
