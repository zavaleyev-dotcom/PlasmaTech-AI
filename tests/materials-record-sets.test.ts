import test from 'node:test';
import assert from 'node:assert/strict';
import * as materials from '../src/materials';
import { validatePropertyRecord, validatePropertyRecords, createPropertyRecord, MaterialsError, type MaterialCatalog, type PropertyRecord } from '../src/materials';
import { syntheticSystemCatalog } from './materials-fixtures';
import { densityRecord, conductivityRecord, syntheticProvenance } from './materials-property-fixtures';

const catalog = (): MaterialCatalog => syntheticSystemCatalog();
const q = (value: number, unit: string) => ({ value, unit }) as never;
const setErrs = (records: unknown, c: unknown = catalog()) => validatePropertyRecords(records, c).issues.filter(i => i.severity === 'error').map((i): string => i.code);
const setWarns = (records: unknown, c: unknown = catalog()) => validatePropertyRecords(records, c).issues.filter(i => i.severity === 'warning').map((i): string => i.code);
const filmK = (over: Partial<PropertyRecord> = {}): PropertyRecord => conductivityRecord({ id: 'fixture:rec-film-k', variant: 'fixture:synthetic-compound-film', conditions: { temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'in_plane' } as never, ...over });

test('a set of records of different variants: each is resolved to ITS variant and the variants stay different', () => {
  const records = [
    densityRecord({ id: 'fixture:rec-1', variant: 'fixture:synthetic-element-bulk' }),
    densityRecord({ id: 'fixture:rec-2', variant: 'fixture:synthetic-compound-film', value: { type: 'scalar', value: 2, unit: 'kg_m3' } }),
    filmK(),
  ];
  assert.deepEqual(setErrs(records), []);
  assert.deepEqual(setErrs([]), []);
  assert.deepEqual(setErrs([densityRecord({ variant: 'fixture:no-such-variant' })]), ['missing_reference']);                  // no fallback to a similar variant
  assert.deepEqual(setErrs([densityRecord({ id: 'fixture:rec-1' }), densityRecord({ id: 'fixture:rec-1', variant: 'fixture:synthetic-alloy-bulk' })]), ['duplicate_id']);
  // the film record is checked against the FILM variant: its requirements are those of a film
  assert.deepEqual(setErrs([filmK({ conditions: { temperature: q(300, 'K') } as never })]), ['missing_condition', 'missing_condition']);
  assert.deepEqual(setErrs([conductivityRecord({ conditions: { temperature: q(300, 'K') } as never })]), []);                    // the same conditions are enough for the bulk variant
});

test('nothing selects, averages, interpolates or looks values up: no such function exists, and records are never combined', () => {
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /select|choose|pick|average|mean(?!ing)|median|merge|combine|interpolat|extrapolat|lookup|find|query|resolve|best|prefer/i.test(n)), names.join());
  // two conflicting records of one variant and property are both kept, side by side, with no verdict
  const a = densityRecord({ id: 'fixture:rec-a', value: { type: 'scalar', value: 1, unit: 'kg_m3' } });
  const b = densityRecord({ id: 'fixture:rec-b', value: { type: 'scalar', value: 5, unit: 'kg_m3' } });
  const before = JSON.stringify([a, b]);
  const report = validatePropertyRecords([a, b], catalog());
  assert.equal(report.ok, true);
  assert.ok(report.issues.every(i => i.severity !== 'error' && i.code !== 'duplicate_record'));
  assert.equal(JSON.stringify([a, b]), before);                                                                                    // untouched
  assert.equal(createPropertyRecord(a).value.value, 1);
  assert.equal(createPropertyRecord(b).value.value, 5);
});

test('namespaces: a shipped (ref:) record cannot stand on a variant of another namespace; user data stays separate', () => {
  const refRecord = densityRecord({ id: 'ref:rec-1', variant: 'fixture:synthetic-element-bulk' });
  assert.deepEqual(setErrs([refRecord]), ['namespace_mismatch']);
  const user = { status: 'user_input' as const, source: { type: 'user_data' as const }, verification: { status: 'not_applicable' as const } };
  const userRecord = densityRecord({ id: 'user:rec-1', provenance: user as never });
  assert.deepEqual(setErrs([userRecord]), []);                                                                                      // a user's record may stand on any variant
  assert.deepEqual(setErrs([densityRecord({ id: 'fixture:rec-1', variant: 'fixture:synthetic-element-bulk' })]), []);
});

test('supersession: the same variant and property, a higher version, an existing record', () => {
  const v1 = densityRecord({ id: 'fixture:rec-v1' });
  const v2 = densityRecord({ id: 'fixture:rec-v2', version: 2, supersedes: 'fixture:rec-v1', value: { type: 'scalar', value: 3, unit: 'kg_m3' } });
  assert.deepEqual(setErrs([v1, v2]), []);
  assert.deepEqual(setErrs([v2]), ['supersedes_invalid']);                                                                          // missing target
  assert.deepEqual(setErrs([v1, { ...v2, version: 1 }]), ['supersedes_invalid']);                                                   // not higher
  assert.deepEqual(setErrs([v1, { ...v2, variant: 'fixture:synthetic-alloy-bulk' }]), ['supersedes_invalid']);
  assert.deepEqual(setErrs([v1, { ...v2, property: 'molar_mass', value: { type: 'scalar', value: 1, unit: 'kg_mol' }, conditions: {} }]), ['supersedes_invalid']);
});

test('identical content under different ids is a warning, never merged', () => {
  const a = densityRecord({ id: 'fixture:rec-a' });
  const b = densityRecord({ id: 'fixture:rec-b', version: 4, updatedAt: '2001-01-01' });                                           // id, version and date differ only
  assert.deepEqual(setErrs([a, b]), []);
  assert.deepEqual(setWarns([a, b]), ['duplicate_record']);
  assert.equal(validatePropertyRecords([a, b], catalog()).issues.filter(i => i.code === 'duplicate_record').length, 1);
});

// ---------- damaged structures ----------

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

test('damaged records: every path of a rich record replaced by garbage gives a report, never an exception', () => {
  const rich = filmK({
    uncertainty: { kind: 'expanded', U: 1, k: 2, kOrigin: 'stated_in_source', origin: 'stated_in_source' },
    supersedes: 'fixture:rec-old',
    provenance: { ...syntheticProvenance(), method: 'M', locator: { page: '1', table: 'T' }, verification: { status: 'verified_against_source', verifiedBy: 'V', verifiedAt: '2000-01-02', note: 'n' } } as never,
  });
  const variant = catalog().variants.find(v => v.id === 'fixture:synthetic-compound-film');
  const paths = pathsOf(rich);
  assert.ok(paths.length > 30);
  let checked = 0;
  for (const path of paths) for (const garbage of GARBAGE) {
    const copy = structuredClone(rich);
    setAt(copy, path, garbage);
    assert.doesNotThrow(() => validatePropertyRecord(copy), path.join('.'));
    assert.doesNotThrow(() => validatePropertyRecord(copy, variant), path.join('.'));
    assert.doesNotThrow(() => validatePropertyRecords([copy, copy], catalog()), path.join('.'));
    const report = validatePropertyRecord(copy, variant);
    assert.ok(Array.isArray(report.issues) && typeof report.ok === 'boolean');
    checked += 1;
  }
  assert.ok(checked > 240);
  for (const bad of [null, undefined, 5, 'x', [], {}, [null], [5]]) {
    assert.doesNotThrow(() => validatePropertyRecord(bad));
    assert.equal(validatePropertyRecord(bad).ok, false, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => validatePropertyRecords(null, null));
  assert.doesNotThrow(() => validatePropertyRecords([null], { variants: 5 }));
  assert.doesNotThrow(() => validatePropertyRecords([densityRecord()], undefined));
  assert.equal(validatePropertyRecords('x', catalog()).ok, false);
  assert.throws(() => createPropertyRecord({ ...densityRecord(), conditions: null } as never), MaterialsError);
});

test('unknown fields at every level of a record are refused, and validation does not change the record', () => {
  const extra = { physicalProperty: 123 };
  const base = filmK({ uncertainty: { kind: 'standard', u: 0.5, origin: 'stated_in_source' } });
  const variant = catalog().variants.find(v => v.id === 'fixture:synthetic-compound-film');
  const mutations: [string, (r: Record<string, unknown>) => void][] = [
    ['record', r => Object.assign(r, extra)],
    ['value', r => Object.assign(r.value as object, extra)],
    ['uncertainty', r => Object.assign(r.uncertainty as object, extra)],
    ['conditions', r => Object.assign(r.conditions as object, extra)],
    ['condition quantity', r => Object.assign((r.conditions as { thickness: object }).thickness, extra)],
    ['provenance', r => Object.assign(r.provenance as object, extra)],
    ['source', r => Object.assign((r.provenance as { source: object }).source, extra)],
    ['verification', r => Object.assign((r.provenance as { verification: object }).verification, extra)],
  ];
  assert.deepEqual(validatePropertyRecord(base, variant).issues.filter(i => i.severity === 'error'), []);
  for (const [name, mutate] of mutations) {
    const copy = structuredClone(base) as unknown as Record<string, unknown>;
    mutate(copy);
    const frozen = JSON.stringify(copy);
    const report = validatePropertyRecord(copy, variant);
    assert.equal(report.ok, false, name);
    assert.equal(JSON.stringify(copy), frozen, `${name}: not modified`);
    assert.throws(() => createPropertyRecord(copy as never, variant), MaterialsError, name);
  }
});
