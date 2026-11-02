import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVariant, describeMissingData, validatePhase, validateStructure, Collector, type MaterialVariant } from '../src/materials';
import { syntheticAlloy, syntheticCompound, syntheticElement, syntheticTarget, solidCrystal } from './materials-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const errs = (v: unknown) => validateVariant(v).issues.filter(i => i.severity === 'error').map(i => i.code);
const withPhase = (phase: unknown): MaterialVariant => ({ ...syntheticElement(), phase: phase as never });
const withStructure = (structure: unknown, phase: unknown = solidCrystal()): MaterialVariant => ({ ...syntheticElement(), phase: phase as never, structure: structure as never });
const withForm = (form: unknown): MaterialVariant => ({ ...syntheticElement(), form: form as never });

test('aggregate state, crystalline order and crystal structure are separate and explicit', () => {
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'crystalline', crystalStructure: { latticeSystem: 'cubic', spaceGroup: 'СИНТЕТИЧЕСКАЯ' } })), []);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'amorphous' })), []);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'partially_crystalline', crystalStructure: { prototype: 'СИНТЕТИЧЕСКИЙ' } })), []);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'unknown' })), []);
  assert.deepEqual(errs(withPhase({ state: 'liquid', order: 'not_applicable' })), []);
  assert.deepEqual(errs(withPhase({ state: 'gas', order: 'not_applicable' })), []);
  // the order is required (absence is not an answer) and must fit the state
  assert.deepEqual(errs(withPhase({ state: 'solid' })), ['invalid_phase']);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'not_applicable' })), ['state_order_mismatch']);
  assert.deepEqual(errs(withPhase({ state: 'liquid', order: 'crystalline' })), ['state_order_mismatch']);
  assert.deepEqual(errs(withPhase({ state: 'liquid', order: 'unknown' })), ['state_order_mismatch']);
  assert.deepEqual(errs(withPhase({ state: 'plasma', order: 'amorphous' })), ['state_order_mismatch']);
  assert.deepEqual(errs(withPhase({ state: 'foam', order: 'unknown' })), ['invalid_phase']);
  // a crystal structure only for a crystalline solid
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'amorphous', crystalStructure: { latticeSystem: 'cubic' } })), ['crystal_structure_not_applicable']);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'unknown', crystalStructure: { latticeSystem: 'cubic' } })), ['crystal_structure_not_applicable']);
  assert.deepEqual(errs(withPhase({ state: 'liquid', order: 'not_applicable', crystalStructure: { latticeSystem: 'cubic' } })), ['crystal_structure_not_applicable']);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'crystalline', crystalStructure: {} })), ['invalid_phase']);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'crystalline', crystalStructure: { latticeSystem: 'cubical' } })), ['invalid_phase']);
  assert.deepEqual(errs(withPhase({ state: 'solid', order: 'crystalline', hardness: 5 })), ['invalid_phase']);
});

test('"unknown" is not "crystalline" and not "amorphous": the unknown order is reported as such and nothing is inferred', () => {
  const v = withPhase({ state: 'solid', order: 'unknown' });
  const report = validateVariant(v);
  assert.ok(report.issues.some(i => i.code === 'order_unknown' && i.severity === 'info'));
  const missing = describeMissingData(v).map(m => m.path);
  assert.ok(missing.includes('phase.order'));
  assert.ok(!missing.includes('phase.crystalStructure'));                                    // not asked for: the order is unknown, not crystalline
  const crystalline = describeMissingData({ ...syntheticElement(), phase: { state: 'solid', order: 'crystalline' } }).map(m => m.path);
  assert.ok(crystalline.includes('phase.crystalStructure'));
  assert.ok(crystalline.includes('phase.source'));                                           // a claim about the order without a source is flagged
});

test('stable temperature range: temperatures, ordered, above absolute zero', () => {
  const ok = { state: 'solid', order: 'crystalline', stableRange: { min: q(300, 'K'), max: q(1000, 'degC') } };
  assert.deepEqual(errs(withPhase(ok)), []);
  assert.deepEqual(errs(withPhase({ ...ok, stableRange: { min: q(1000, 'K'), max: q(300, 'K') } })), ['invalid_phase']);
  assert.deepEqual(errs(withPhase({ ...ok, stableRange: { min: q(-5, 'K'), max: q(300, 'K') } })), ['invalid_quantity']);
  assert.deepEqual(errs(withPhase({ ...ok, stableRange: { min: q(1, 'Pa'), max: q(300, 'K') } })), ['invalid_quantity']);
  assert.deepEqual(errs(withPhase({ ...ok, stableRange: { min: q(100, 'K_delta'), max: q(300, 'K') } })), ['invalid_quantity']);   // an interval is not a temperature
});

test('microstructure: grain size, texture and porosity depend on the order; absence is "not reported"', () => {
  assert.deepEqual(errs(withStructure({ grainSize: { size: q(50, 'nm'), definition: 'СИНТЕТИЧЕСКОЕ' }, texture: { description: 'СИНТЕТИЧЕСКАЯ' }, porosity: q(5, 'percent'), features: ['a', 'b'] })), []);
  assert.deepEqual(errs(withStructure({})), []);                                                                      // empty = nothing reported, valid
  assert.deepEqual(errs(withStructure({ grainSize: { size: q(50, 'nm') } }, { state: 'solid', order: 'amorphous' })), ['structure_not_applicable']);
  assert.deepEqual(errs(withStructure({ texture: { description: 'x' } }, { state: 'solid', order: 'amorphous' })), ['structure_not_applicable']);
  assert.deepEqual(errs(withStructure({ porosity: q(0.1, 'one') }, { state: 'solid', order: 'amorphous' })), []);     // an amorphous solid may be porous
  assert.deepEqual(errs(withStructure({ porosity: q(0.1, 'one') }, { state: 'liquid', order: 'not_applicable' })), ['structure_not_applicable']);
  const unknownOrder = validateVariant(withStructure({ grainSize: { size: q(50, 'nm') } }, { state: 'solid', order: 'unknown' }));
  assert.ok(unknownOrder.ok && unknownOrder.issues.some(i => i.severity === 'warning'));                              // allowed, but flagged
  for (const bad of [q(-1, 'nm'), q(0, 'nm'), q(5, 'Pa'), q(NaN, 'nm'), { value: 1 }, 5]) assert.deepEqual(errs(withStructure({ grainSize: { size: bad } })), ['invalid_quantity'], JSON.stringify(bad));
  assert.deepEqual(errs(withStructure({ porosity: q(1, 'one') })), ['invalid_structure']);
  assert.deepEqual(errs(withStructure({ porosity: q(-0.1, 'one') })), ['invalid_quantity']);
  assert.deepEqual(errs(withStructure({ porosity: q(5, 'nm') })), ['invalid_quantity']);
  assert.deepEqual(errs(withStructure({ features: [] })), ['invalid_structure']);
  assert.deepEqual(errs(withStructure({ features: ['a', 'a'] })), ['invalid_structure']);
  assert.deepEqual(errs(withStructure({ density: 5 })), ['invalid_structure']);                                      // no property values
  const c = new Collector();
  validateStructure('x', undefined, 'structure', c);
  assert.equal(c.errorCount, 1);
  const p = new Collector();
  validatePhase(null, 'phase', p);
  assert.equal(p.errorCount, 1);
});

test('forms: every form kind is supported; fields are only allowed where they make sense', () => {
  const t = q(100, 'nm');
  assert.deepEqual(errs(withForm({ kind: 'bulk' })), []);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', thickness: t, deposition: { process: 'СИНТЕТИЧЕСКИЙ' }, substrate: 'fixture:synthetic-substrate-bulk' })), []);
  assert.deepEqual(errs(withForm({ kind: 'coating_layer', thickness: t })), []);
  assert.deepEqual(errs(withForm({ kind: 'sputtering_target', thickness: q(6, 'mm'), intendedUse: ['sputtering_target'] })), []);
  assert.deepEqual(errs(withForm({ kind: 'powder', particleSize: q(5, 'um') })), []);
  assert.deepEqual(errs(withForm({ kind: 'foil', thickness: q(25, 'um') })), []);
  assert.deepEqual(errs(withForm({ kind: 'substrate', thickness: q(500, 'um') })), []);
  assert.deepEqual(errs(withForm({ kind: 'plate' })), ['invalid_form']);
  assert.deepEqual(errs(withForm({})), ['invalid_form']);
  assert.deepEqual(errs(withForm({ kind: 'bulk', thickness: t })), ['form_field_not_allowed']);
  assert.deepEqual(errs(withForm({ kind: 'powder', thickness: t })), ['form_field_not_allowed']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', particleSize: t })), ['form_field_not_allowed']);
  assert.deepEqual(errs(withForm({ kind: 'sputtering_target', deposition: { process: 'x' } })), ['form_field_not_allowed']);   // the deposition technology is the context of a FILM
  assert.deepEqual(errs(withForm({ kind: 'foil', substrate: 'fixture:x' })), ['form_field_not_allowed']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', thickness: q(0, 'nm') })), ['invalid_quantity']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', thickness: q(-5, 'nm') })), ['invalid_quantity']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', thickness: q(5, 's') })), ['invalid_quantity']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', substrate: 'not an id' })), ['invalid_id']);
  assert.deepEqual(errs(withForm({ kind: 'thin_film', deposition: { process: '' } })), ['invalid_form']);
  assert.deepEqual(errs(withForm({ kind: 'bulk', intendedUse: ['coating', 'coating'] })), ['invalid_form']);
  assert.deepEqual(errs(withForm({ kind: 'bulk', intendedUse: ['gaming'] })), ['invalid_form']);
  assert.deepEqual(errs(withForm({ kind: 'bulk', density: 1 })), ['invalid_form']);
});

test('bulk, target and film variants of one material are DIFFERENT variants; the use does not change the variant', () => {
  const film = syntheticCompound();
  const target = syntheticTarget();
  assert.notEqual(film.id, target.id);
  assert.notDeepEqual(film.form, target.form);
  assert.deepEqual(film.composition, target.composition);
  assert.deepEqual(film.phase, target.phase);
  // the intended use is context: adding it changes nothing but itself
  const plain = { ...syntheticElement(), form: { kind: 'bulk' } } as MaterialVariant;
  const labelled = { ...syntheticElement(), form: { kind: 'bulk', intendedUse: ['structural'] } } as MaterialVariant;
  assert.deepEqual(errs(plain), errs(labelled));
  assert.deepEqual(plain.composition, labelled.composition);
  // a composite or a coating system has no phase of its own: phase is refused there
  assert.ok(errs({ ...syntheticAlloy(), composition: { type: 'composite', basis: 'volume', constituents: [{ material: 'fixture:a', fraction: { value: 0.5 } }, { material: 'fixture:b', fraction: { value: 0.5 } }] } }).includes('phase_not_applicable'));
  // and the other kinds must have one
  assert.deepEqual(errs({ ...syntheticAlloy(), phase: undefined }), ['phase_required']);
});

test('missing data is listed, never filled in', () => {
  const film = describeMissingData({ ...syntheticCompound(), form: { kind: 'thin_film' } }).map(m => m.path);
  for (const path of ['form.thickness', 'form.deposition', 'form.substrate', 'structure']) assert.ok(film.includes(path), path);
  assert.deepEqual(describeMissingData(syntheticElement()).map(m => m.path).filter(p => p.startsWith('form')), []);
  const powder = describeMissingData({ ...syntheticElement(), form: { kind: 'powder' } }).map(m => m.path);
  assert.ok(powder.includes('form.particleSize'));
  const complete = describeMissingData({ ...syntheticAlloy(), structure: { porosity: q(1, 'percent'), grainSize: { size: q(1, 'um') } }, phase: { ...solidCrystal(), source: { citation: 'СИНТЕТИЧЕСКИЙ' } } as never });
  assert.deepEqual(complete.map(m => m.path).filter(p => p.startsWith('structure')), []);
  // validating and describing never changes the record
  const v = syntheticCompound();
  const before = JSON.stringify(v);
  validateVariant(v); describeMissingData(v);
  assert.equal(JSON.stringify(v), before);
});
