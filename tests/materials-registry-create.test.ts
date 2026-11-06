import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialPropertyRegistry, type MaterialCatalog, type PropertyRecord } from '../src/materials';
import { syntheticSystemCatalog, syntheticElement, syntheticTarget } from './materials-fixtures';
import { kRecord, BULK, FILM, TARGET, densityRecord } from './materials-property-fixtures';

const catalog = (): MaterialCatalog => { const c = syntheticSystemCatalog(); return { ...c, variants: [...c.variants, syntheticTarget()] }; };
const DATA_VERSION = 'fixture-1';
const input = (records: PropertyRecord[], c: unknown = catalog()) => ({ catalog: c, records, dataVersion: DATA_VERSION });
const create = (records: PropertyRecord[], c: unknown = catalog()) => createMaterialPropertyRegistry(input(records, c));
const errs = (r: { report: { issues: readonly { severity: string; code: string }[] } }): string[] => r.report.issues.filter(i => i.severity === 'error').map(i => i.code);
const deep = <T>(x: T): T => structuredClone(x);
const goodRecords = (): PropertyRecord[] => [kRecord('fixture:k-bulk', BULK, 2), kRecord('fixture:k-film', FILM, 1), densityRecord({ id: 'fixture:rho-bulk' })];

test('a valid catalog and records give a registry with a snapshot, a version and a report', () => {
  const result = create(goodRecords());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.registry.version.schemaVersion, 1);
  assert.equal(result.registry.version.recordCount, 3);
  assert.equal(result.registry.version.variantCount, catalog().variants.length);
  assert.match(result.registry.version.contentFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(result.report.summary.errors, 0);
  assert.ok(result.report.issues.every(i => i.severity !== 'error'));
  assert.equal(result.registry.version.dataVersion, 'fixture-1');
  assert.equal(result.registry.getVariant(BULK)?.id, BULK);
  assert.equal(result.registry.getVariant('fixture:nothing'), undefined);
  assert.ok(Object.isFrozen(result.registry) && Object.isFrozen(result.registry.snapshot) && Object.isFrozen(result.registry.snapshot.records[0]));
});

test('the version identifies the CONTENT: stable, independent of the order, sensitive to any change; no clock is read', () => {
  const a = create(goodRecords());
  const b = create([...goodRecords()].reverse());
  const c = create(goodRecords());
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  assert.equal(a.registry.version.contentFingerprint, c.registry.version.contentFingerprint);
  assert.equal(a.registry.version.contentFingerprint, b.registry.version.contentFingerprint);
  const changed = goodRecords();
  changed[0] = kRecord('fixture:k-bulk', BULK, 2.0000001);
  const d = create(changed);
  assert.ok(d.ok && d.registry.version.contentFingerprint !== a.registry.version.contentFingerprint);
  const fewer = create(goodRecords().slice(0, 2));
  assert.ok(fewer.ok && fewer.registry.version.contentFingerprint !== a.registry.version.contentFingerprint && fewer.registry.version.recordCount === 2);
});

test('the snapshot is independent of the input: changing the input afterwards does not change the registry', () => {
  const records = goodRecords();
  const cat = catalog();
  const result = createMaterialPropertyRegistry({ catalog: cat, records, dataVersion: DATA_VERSION });
  assert.ok(result.ok);
  if (!result.ok) return;
  const before = JSON.stringify(result.registry.snapshot);
  (records[0].value as { value: number }).value = 999;
  (cat.variants as unknown as { form: unknown }[])[0].form = null;
  assert.equal(JSON.stringify(result.registry.snapshot), before);
  assert.notEqual(result.registry.snapshot.records[0], records[0]);
  assert.throws(() => { (result.registry.snapshot.records[0].value as { value: number }).value = 5; }, TypeError);          // frozen: strict mode refuses the write
  assert.equal(result.registry.snapshot.records[0].value.value, 2);
});

test('an empty registry is valid and states that it has no data', () => {
  const result = create([]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.registry.version.recordCount, 0);
  assert.deepEqual(result.registry.findRecords({}).records, []);
  assert.equal(result.registry.findRecords({ variant: BULK, property: 'density' }).status, 'not_available');
});

test('no registry exists when the data are invalid: a controlled report, registry = null, never an exception', () => {
  const cases: [string, () => ReturnType<typeof create>, string][] = [
    ['an invalid catalog (a reference cycle)', () => create(goodRecords(), (() => { const c = deep(catalog()) as unknown as { variants: { form: { substrate?: string }; id: string }[] }; c.variants[4].form = { kind: 'coating_layer', substrate: 'fixture:synthetic-system-film' } as never; return c; })()), 'reference_cycle'],
    ['a damaged variant', () => create(goodRecords(), (() => { const c = deep(catalog()) as unknown as { variants: { form: unknown }[] }; c.variants[0].form = null; return c; })()), 'invalid_form'],
    ['an unknown property', () => create([kRecord('fixture:k', BULK, 2, { property: 'hardness' })]), 'unknown_property'],
    ['a missing variant', () => create([kRecord('fixture:k', 'fixture:ghost', 2)]), 'missing_reference'],
    ['duplicate record ids', () => create([kRecord('fixture:k', BULK, 2), kRecord('fixture:k', BULK, 3)]), 'duplicate_id'],
    ['a damaged record', () => create([kRecord('fixture:k', BULK, 2, { conditions: null as never })]), 'invalid_condition'],
    ['a record without a source', () => create([kRecord('fixture:k', BULK, 2, { provenance: undefined as never })]), 'invalid_provenance'],
    ['an unknown field in a record', () => create([{ ...kRecord('fixture:k', BULK, 2), physicalProperty: 123 } as never]), 'invalid_property'],
    ['an unknown field in the input', () => createMaterialPropertyRegistry({ ...input(goodRecords()), extra: 1 }), 'registry_invalid'],
    ['an unknown field in the catalog', () => create(goodRecords(), { ...catalog(), extra: { physicalProperty: 123 } }), 'invalid_material'],
  ];
  for (const [name, run, code] of cases) {
    let result: ReturnType<typeof create> | undefined;
    assert.doesNotThrow(() => { result = run(); }, name);
    assert.equal(result!.ok, false, name);
    assert.equal(result!.registry, null, name);
    assert.ok(errs(result!).includes(code), `${name}: expected ${code}, got ${errs(result!).join(',')}`);
    assert.equal(result!.report.ok, false, name);
    assert.ok(result!.report.summary.errors > 0, name);
  }
  for (const bad of [null, undefined, 5, 'x', [], {}, { catalog: null, records: [] }, { catalog: {}, records: 'x' }, { catalog: catalog() }, { records: [] }]) {
    assert.doesNotThrow(() => createMaterialPropertyRegistry(bad));
    const result = createMaterialPropertyRegistry(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.registry, null);
  }
});

test('CRITICAL: a thin-film record without thickness or direction is refused by the registry (the "no variant" boundary of validatePropertyRecord cannot let it in)', () => {
  const poorFilm = kRecord('fixture:k-film', FILM, 1, { conditions: { temperature: { value: 300, unit: 'K' } } as never });
  const result = create([poorFilm]);
  assert.equal(result.ok, false);
  assert.deepEqual(errs(result), ['missing_condition', 'missing_condition']);
  const onlyThickness = kRecord('fixture:k-film', FILM, 1, { conditions: { temperature: { value: 300, unit: 'K' }, thickness: { value: 100, unit: 'nm' } } as never });
  assert.deepEqual(errs(create([onlyThickness])), ['missing_condition']);
  assert.equal(create([kRecord('fixture:k-film', FILM, 1)]).ok, true);                                              // thickness AND direction: accepted
  // the same conditions are fine for a bulk piece and a sputtering target
  assert.equal(create([kRecord('fixture:k-bulk', BULK, 2)]).ok, true);
  assert.equal(create([kRecord('fixture:k-target', TARGET, 2)]).ok, true);
  // a coating system (a coating layer) needs them too
  const system = kRecord('fixture:k-system', 'fixture:synthetic-system-film', 3, { conditions: { temperature: { value: 300, unit: 'K' } } as never });
  assert.deepEqual(errs(create([system])), ['missing_condition', 'missing_condition']);
});

test('a variant that is ambiguous (the same id twice, different forms) is refused when a record refers to it', () => {
  const c = deep(catalog()) as unknown as { variants: unknown[] };
  c.variants.push({ ...syntheticElement(), id: 'fixture:synthetic-element-bulk', form: { kind: 'thin_film', thickness: { value: 100, unit: 'nm' } } });
  const result = create([kRecord('fixture:k-bulk', BULK, 2)], c);
  assert.equal(result.ok, false);
  assert.ok(errs(result).includes('duplicate_id'));
  assert.equal(result.registry, null);
});

test('supersession: a record is replaced by ONE newer record; a fork is refused', () => {
  const v1 = kRecord('fixture:k-v1', BULK, 2);
  const v2 = kRecord('fixture:k-v2', BULK, 3, { version: 2, supersedes: 'fixture:k-v1' });
  const v2b = kRecord('fixture:k-v2b', BULK, 4, { version: 2, supersedes: 'fixture:k-v1' });
  const ok = create([v1, v2]);
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.registry.isSuperseded('fixture:k-v1'), true); assert.equal(ok.registry.isSuperseded('fixture:k-v2'), false); }
  const fork = create([v1, v2, v2b]);
  assert.equal(fork.ok, false);
  assert.ok(errs(fork).includes('supersession_fork'));
  assert.equal(create([v2]).ok, false);                                                                              // the replaced record is missing
});

test('warnings and information do not block: unverified records are listed, differences are descriptions', () => {
  const result = create([kRecord('fixture:k-a', BULK, 2), kRecord('fixture:k-b', BULK, 20)]);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(result.report.issues.some(i => i.code === 'unverified_value'));
  assert.ok(result.report.issues.some(i => i.code === 'records_differ' && i.severity === 'info'));                       // different values under equal conditions: described, not judged
  assert.equal(result.report.summary.errors, 0);
  assert.equal(result.registry.snapshot.records.length, 2);                                                           // both kept: nothing is resolved
});

// ---------- damage anywhere in the input ----------

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

test('damage anywhere in { catalog, records } gives a report, never an exception - and a registry exists only if both validators accept the data', () => {
  const base = { catalog: catalog(), records: goodRecords(), dataVersion: DATA_VERSION };
  const paths = pathsOf(base);
  assert.ok(paths.length > 250);
  let created = 0;
  for (const path of paths) for (const garbage of GARBAGE) {
    const copy = deep(base);
    setAt(copy, path, garbage);
    let result: ReturnType<typeof createMaterialPropertyRegistry> | undefined;
    assert.doesNotThrow(() => { result = createMaterialPropertyRegistry(copy); }, `${path.join('.')} = ${String(garbage)}`);
    if (result!.ok) {
      created += 1;
      // an accepted input must be fully valid by BOTH layers: the registry cannot be built from anything either of them refuses
      assert.equal(result!.registry.report.summary.errors, 0);
      assert.ok(result!.registry.snapshot.records.every(r => r.provenance && r.conditions && r.value));
    } else assert.equal(result!.registry, null);
  }
  assert.ok(created > 0);                                                                                                 // harmless changes (optional fields set to undefined) still build
  assert.ok(created < paths.length * GARBAGE.length);
});

// ---------- versions: schemaVersion, dataVersion, record version, contentFingerprint ----------

test('four different versions: schemaVersion (structure), dataVersion (the data set, from the caller), record versions (per record), contentFingerprint (the content)', () => {
  const v1 = kRecord('fixture:k-v1', BULK, 2);
  const v2 = kRecord('fixture:k-v2', BULK, 3, { version: 2, supersedes: 'fixture:k-v1' });
  const result = createMaterialPropertyRegistry({ catalog: catalog(), records: [v1, v2], dataVersion: '2025.1+fixture' });
  assert.ok(result.ok);
  if (!result.ok) return;
  const version = result.registry.version;
  assert.equal(version.schemaVersion, 1);                                                        // the structure of the registry
  assert.equal(version.dataVersion, '2025.1+fixture');                                           // the data set: given, never derived
  assert.deepEqual(result.registry.snapshot.records.map(r => r.version), [1, 2]);               // the record versions, kept in the records
  assert.match(version.contentFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(new Set([version.schemaVersion, version.dataVersion, version.contentFingerprint]).size, 3);
  assert.deepEqual(Object.keys(version).sort(), ['contentFingerprint', 'dataVersion', 'recordCount', 'schemaVersion', 'variantCount']);
  // the same content and the same data version give the same snapshot, whatever the order
  const again = createMaterialPropertyRegistry({ catalog: catalog(), records: [v2, v1], dataVersion: '2025.1+fixture' });
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.registry.version, version);
  // another data version over the same content: the fingerprint of the CONTENT is the same, the data version differs
  const other = createMaterialPropertyRegistry({ catalog: catalog(), records: [v1, v2], dataVersion: '2025.2' });
  assert.ok(other.ok);
  if (other.ok) {
    assert.equal(other.registry.version.contentFingerprint, version.contentFingerprint);
    assert.notEqual(other.registry.version.dataVersion, version.dataVersion);
  }
  // the supersedes history is part of the content: removing the link changes the fingerprint
  const noLink = createMaterialPropertyRegistry({ catalog: catalog(), records: [v1, { ...v2, supersedes: undefined }], dataVersion: '2025.1+fixture' });
  assert.ok(noLink.ok && noLink.registry.version.contentFingerprint !== version.contentFingerprint);
  // a record version is part of the content too
  const bumped = createMaterialPropertyRegistry({ catalog: catalog(), records: [v1, { ...v2, version: 3 }], dataVersion: '2025.1+fixture' });
  assert.ok(bumped.ok && bumped.registry.version.contentFingerprint !== version.contentFingerprint);
});

test('the data version is REQUIRED and supplied by the caller: missing, empty, wrongly typed or odd values are refused; no clock, no randomness', () => {
  for (const bad of [undefined, null, '', ' ', 5, {}, 'has space', '-start', 'x'.repeat(65), 'ё']) {
    const result = createMaterialPropertyRegistry({ catalog: catalog(), records: goodRecords(), dataVersion: bad });
    assert.equal(result.ok, false, String(bad));
    assert.ok(errs(result).includes('registry_invalid'), String(bad));
  }
  for (const good of ['1', '2025.1', 'v1.2.3-rc.1', 'build_7+exp.sha', 'x'.repeat(64)]) assert.equal(createMaterialPropertyRegistry({ catalog: catalog(), records: goodRecords(), dataVersion: good }).ok, true, good);
  assert.equal(createMaterialPropertyRegistry({ catalog: catalog(), records: goodRecords() }).ok, false);
});

test('the replacement history: kept (nothing is removed), one replacement per record, no cycles, readable through history()', () => {
  const v1 = kRecord('fixture:k-v1', BULK, 2);
  const v2 = kRecord('fixture:k-v2', BULK, 3, { version: 2, supersedes: 'fixture:k-v1' });
  const v3 = kRecord('fixture:k-v3', BULK, 4, { version: 3, supersedes: 'fixture:k-v2' });
  const result = create([v3, v1, v2]);
  assert.ok(result.ok);
  if (!result.ok) return;
  const reg = result.registry;
  assert.deepEqual(reg.history('fixture:k-v2')!.map(r => r.id), ['fixture:k-v1', 'fixture:k-v2', 'fixture:k-v3']);          // the whole chain, oldest to newest, from any member
  assert.deepEqual(reg.history('fixture:k-v1')!.map(r => r.id), ['fixture:k-v1', 'fixture:k-v2', 'fixture:k-v3']);
  assert.equal(reg.history('fixture:ghost'), undefined);
  assert.equal(reg.snapshot.records.length, 3);                                                                                 // the superseded ones are still there
  assert.equal(reg.isSuperseded('fixture:k-v1') && reg.isSuperseded('fixture:k-v2') && !reg.isSuperseded('fixture:k-v3'), true);
  assert.deepEqual(reg.findRecords({ variant: BULK }).records.map(r => r.id), ['fixture:k-v3']);                                // only the current one by default
  assert.equal(reg.findRecords({ variant: BULK, includeSuperseded: true }).count, 3);
  // a cycle of replacement is refused (it can never be built: each replacement needs a higher version, and the registry checks the cycle itself)
  const a = kRecord('fixture:k-a', BULK, 2, { version: 2, supersedes: 'fixture:k-b' });
  const b = kRecord('fixture:k-b', BULK, 3, { version: 1, supersedes: 'fixture:k-a' });
  const cycle = create([a, b]);
  assert.equal(cycle.ok, false);
  assert.ok(errs(cycle).includes('supersedes_invalid'));
  assert.equal(create([kRecord('fixture:k-self', BULK, 2, { supersedes: 'fixture:k-self' })]).ok, false);
  assert.ok(errs(create([v1, v2, kRecord('fixture:k-v2b', BULK, 5, { version: 2, supersedes: 'fixture:k-v1' })])).includes('supersession_fork'));
});

test('duplicates and namespaces: the same id twice, the same content under two ids; ref / user / fixture are independent, none has priority', () => {
  assert.ok(errs(create([kRecord('fixture:k-1', BULK, 2), kRecord('fixture:k-1', BULK, 3)])).includes('duplicate_id'));
  const twinA = kRecord('fixture:k-a', BULK, 2);
  const twinB = { ...twinA, id: 'fixture:k-b' };
  const twins = create([twinA, twinB]);
  assert.ok(twins.ok);                                                                                                           // identical content under another id is a diagnostic, not an error
  if (twins.ok) {
    assert.equal(twins.registry.snapshot.records.length, 2);                                                                     // nothing is merged
    assert.ok(twins.report.issues.some(i => i.code === 'duplicate_record' && i.severity === 'warning'));
    assert.deepEqual(twins.registry.differences().map(d => d.category), ['identical']);
  }
  // shipped (ref:) and user (user:) records of one variant side by side: both are found, none is preferred, a ref record cannot stand on a user variant
  const userProv = { status: 'user_input', source: { type: 'user_data' }, verification: { status: 'not_applicable' } } as never;
  const mixed = create([kRecord('fixture:k-ref', BULK, 2), kRecord('user:k-mine', BULK, 2.5, { provenance: userProv })]);
  assert.ok(mixed.ok);
  if (mixed.ok) {
    const found = mixed.registry.findRecords({ variant: BULK, property: 'thermal_conductivity' });
    assert.equal(found.status, 'multiple_records');
    assert.deepEqual(found.records.map(r => r.id), ['fixture:k-ref', 'user:k-mine']);
  }
  const userVariant = deep(catalog()) as unknown as { variants: { id: string }[] };
  userVariant.variants[0] = { ...userVariant.variants[0], id: 'user:my-variant' };
  assert.equal(create([kRecord('ref:k-1', 'user:my-variant', 2)], userVariant).ok, false);                                       // a shipped record never depends on user data
});
