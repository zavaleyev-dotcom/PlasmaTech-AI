import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, createCatalog, referencedVariantIds, MaterialsError, type MaterialCatalog, type MaterialVariant } from '../src/materials';
import { identity, solidCrystal, syntheticAlloy, syntheticCompound, syntheticElement, syntheticSystemCatalog } from './materials-fixtures';

const errs = (c: unknown) => validateCatalog(c).issues.filter(i => i.severity === 'error').map(i => i.code);
const composite = (id: string, refs: [string, string]): MaterialVariant => ({
  id, identity: 'fixture:synthetic-composite',
  composition: { type: 'composite', basis: 'volume', constituents: [{ material: refs[0], fraction: { value: 0.5 } }, { material: refs[1], fraction: { value: 0.5 } }] },
  form: { kind: 'bulk' },
});
const base = (): MaterialCatalog => ({ identities: [identity('synthetic-element', 'element'), identity('synthetic-compound', 'compound'), identity('synthetic-alloy', 'alloy'), identity('synthetic-composite', 'composite')], variants: [syntheticElement(), syntheticCompound(), syntheticAlloy()] });

test('a valid synthetic catalog (with a multilayer system) passes and is frozen', () => {
  const catalog = syntheticSystemCatalog();
  assert.deepEqual(errs(catalog), []);
  const created = createCatalog(catalog);
  assert.ok(Object.isFrozen(created) && Object.isFrozen(created.variants[0]));
  assert.notEqual(created, catalog);                                                                  // a copy: the input is not touched
  assert.ok(!Object.isFrozen(catalog));
});

test('unique ids: duplicate identities and variants, unknown identity, kind <-> composition against the identity', () => {
  const c = base();
  assert.deepEqual(errs({ ...c, identities: [...c.identities, c.identities[0]] }), ['duplicate_id']);
  assert.deepEqual(errs({ ...c, variants: [...c.variants, c.variants[0]] }), ['duplicate_id']);
  assert.deepEqual(errs({ ...c, variants: [{ ...syntheticElement(), identity: 'fixture:nobody' }, ...c.variants.slice(1)] }), ['missing_reference']);
  assert.deepEqual(errs({ ...c, identities: [identity('synthetic-element', 'alloy'), ...c.identities.slice(1)] }), ['kind_composition_mismatch']);   // an element composition under an alloy identity
  assert.deepEqual(errs(null), ['invalid_material']);
  assert.deepEqual(errs({ identities: [] }), ['invalid_material']);
});

test('duplicate content under different ids is reported (warning), not merged', () => {
  const c = base();
  const twin: MaterialVariant = { ...syntheticElement(), id: 'fixture:synthetic-element-twin' };
  const report = validateCatalog({ ...c, variants: [...c.variants, twin] });
  assert.ok(report.ok);
  assert.equal(report.issues.filter(i => i.severity === 'warning' && i.code === 'duplicate_id').length, 1);
  assert.equal(createCatalog({ ...c, variants: [...c.variants, twin] }).variants.length, 4);        // both kept
});

test('references must resolve: composite constituents, layers, gradient ends, substrates', () => {
  const c = base();
  assert.deepEqual(errs({ ...c, variants: [...c.variants, composite('fixture:synthetic-composite-bulk', ['fixture:synthetic-element-bulk', 'fixture:synthetic-alloy-bulk'])] }), []);
  assert.deepEqual(errs({ ...c, variants: [...c.variants, composite('fixture:synthetic-composite-bulk', ['fixture:synthetic-element-bulk', 'fixture:ghost'])] }), ['missing_reference']);
  const system = syntheticSystemCatalog();
  const broken = { ...system, variants: system.variants.filter(v => v.id !== 'fixture:synthetic-substrate-bulk') };
  assert.ok(errs(broken).includes('missing_reference'));
  const refs = referencedVariantIds(system.variants[4]);
  assert.deepEqual([...new Set(refs)].sort(), ['fixture:synthetic-alloy-bulk', 'fixture:synthetic-compound-film', 'fixture:synthetic-element-bulk', 'fixture:synthetic-substrate-bulk']);
  assert.deepEqual(refs, referencedVariantIds(system.variants[4]));                                   // deterministic order
});

test('cyclic references are forbidden: self, two-step, three-step, through a substrate; acyclic sharing is fine', () => {
  const c = base();
  const el = 'fixture:synthetic-element-bulk';
  assert.deepEqual(errs({ ...c, variants: [...c.variants, composite('fixture:cyc-a', ['fixture:cyc-a', el])] }), ['reference_cycle']);                                  // contains itself
  assert.deepEqual(errs({ ...c, variants: [...c.variants, composite('fixture:cyc-a', ['fixture:cyc-b', el]), composite('fixture:cyc-b', ['fixture:cyc-a', el])] }), ['reference_cycle']);
  assert.deepEqual(errs({ ...c, variants: [...c.variants, composite('fixture:cyc-a', ['fixture:cyc-b', el]), composite('fixture:cyc-b', ['fixture:cyc-c', el]), composite('fixture:cyc-c', ['fixture:cyc-a', el])] }), ['reference_cycle']);
  const diamond = [composite('fixture:top', ['fixture:left', 'fixture:right']), composite('fixture:left', [el, 'fixture:synthetic-alloy-bulk']), composite('fixture:right', [el, 'fixture:synthetic-alloy-bulk'])];
  assert.deepEqual(errs({ ...c, variants: [...c.variants, ...diamond] }), []);                                                                                      // shared constituents are not a cycle
  const filmOnItself: MaterialVariant = { ...syntheticCompound(), id: 'fixture:film-self', form: { kind: 'thin_film', substrate: 'fixture:film-self' } };
  assert.deepEqual(errs({ ...c, variants: [...c.variants, filmOnItself] }), ['reference_cycle']);
  const message = validateCatalog({ ...c, variants: [...c.variants, composite('fixture:cyc-a', ['fixture:cyc-b', el]), composite('fixture:cyc-b', ['fixture:cyc-a', el])] }).issues.find(i => i.code === 'reference_cycle')!.message;
  assert.match(message, /fixture:cyc-a → fixture:cyc-b → fixture:cyc-a|fixture:cyc-b → fixture:cyc-a → fixture:cyc-b/);
  assert.throws(() => createCatalog({ ...c, variants: [...c.variants, composite('fixture:cyc-a', ['fixture:cyc-a', el])] }), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_material');
});

test('a coating system cannot be a layer of another coating system (flatten it into one stack)', () => {
  const system = syntheticSystemCatalog();
  const outer: MaterialVariant = {
    id: 'fixture:outer-system', identity: 'fixture:synthetic-system',
    composition: { type: 'coating_system', stack: { elements: [{ type: 'layer', layer: { kind: 'uniform', id: 'inner', material: 'fixture:synthetic-system-film' } }] } },
    form: { kind: 'coating_layer' },
  };
  assert.deepEqual(errs({ ...system, variants: [...system.variants, outer] }), ['nested_coating_system']);
});

test('no invented property values: records carry composition, phase, structure and form only', () => {
  const allowedVariantKeys = ['id', 'identity', 'composition', 'phase', 'structure', 'form'];
  for (const v of syntheticSystemCatalog().variants) for (const key of Object.keys(v)) assert.ok(allowedVariantKeys.includes(key), key);
  const identityKeys = ['id', 'kind', 'nameRu', 'nameEn', 'synonyms', 'designations'];
  for (const i of syntheticSystemCatalog().identities) for (const key of Object.keys(i)) assert.ok(identityKeys.includes(key), key);
  // every fixture is explicitly synthetic
  for (const i of syntheticSystemCatalog().identities) { assert.match(i.id, /^fixture:/); assert.match(i.nameRu, /СИНТЕТИЧЕСК/); }
  for (const v of syntheticSystemCatalog().variants) assert.match(v.id, /^fixture:/);
  assert.equal(solidCrystal().state, 'solid');
});
