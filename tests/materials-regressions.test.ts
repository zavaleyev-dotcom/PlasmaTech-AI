import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCatalog, createCatalog, validateVariant, describeMissingData, totalThickness, variantReferences, STATE_FORM_COMPATIBILITY, AGGREGATE_STATES, MATERIAL_FORM_KINDS,
  MaterialsError, type MaterialCatalog, type MaterialVariant,
} from '../src/materials';
import { identity, syntheticAlloy, syntheticElement, syntheticSystemCatalog } from './materials-fixtures';

const q = (value: number, unit: string) => ({ value, unit });
const errs = (v: unknown, kind?: Parameters<typeof validateVariant>[1]) => validateVariant(v, kind).issues.filter(i => i.severity === 'error').map((i): string => i.code);
const catalogErrs = (c: unknown) => validateCatalog(c).issues.filter(i => i.severity === 'error').map((i): string => i.code);
const deep = <T>(x: T): T => structuredClone(x);
const alloy = (constituents: unknown[], extra: Record<string, unknown> = {}): MaterialVariant => ({ ...syntheticAlloy(), composition: { type: 'alloy', basis: 'atomic', constituents, ...extra } as never });

// ---------- F1: a negative balance is impossible whatever the tolerance ----------

test('F1: the declared sum tolerance cannot make a negative remainder possible', () => {
  const ti = { symbol: 'Ti', fraction: { value: 0.6 } };
  const balance = { symbol: 'N', fraction: { balance: true } };
  for (const sumTolerance of [undefined, 0, 0.001, 0.01]) {
    const extra = sumTolerance === undefined ? {} : { sumTolerance };
    assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { value: 0.405 } }, balance], extra)), ['fraction_sum'], `tolerance ${sumTolerance}`);   // remainder -0.005
  }
  assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { value: 0.4 } }, balance])), []);                                                         // remainder exactly 0 (warned)
  assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { value: 0.399 } }, balance], { sumTolerance: 0.01 })), []);
  // exact decimals, no floating-point slack: 0.1 + 0.2 + 0.7 is exactly 1, so the remainder is exactly 0 and a hair more is negative
  assert.deepEqual(errs(alloy([{ symbol: 'Fe', fraction: { value: 0.1 } }, { symbol: 'Ni', fraction: { value: 0.2 } }, { symbol: 'Cr', fraction: { value: 0.7 } }, { symbol: 'Mo', fraction: { balance: true } }])), []);
  assert.deepEqual(errs(alloy([{ symbol: 'Fe', fraction: { value: 0.1 } }, { symbol: 'Ni', fraction: { value: 0.2 } }, { symbol: 'Cr', fraction: { value: 0.7000000001 } }, { symbol: 'Mo', fraction: { balance: true } }], { sumTolerance: 0.01 })), ['fraction_sum']);
});

test('F1: with ranges there must exist at least one composition with a non-negative remainder', () => {
  const ti = { symbol: 'Ti', fraction: { value: 0.6 } };
  const balance = { symbol: 'N', fraction: { balance: true } };
  assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { min: 0.405, max: 0.5 } }, balance], { sumTolerance: 0.01 })), ['fraction_sum']);        // every composition has a negative remainder
  assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { min: 0.3, max: 0.5 } }, balance], { sumTolerance: 0.01 })), []);                          // exists (Al = 0.3..0.4)
  assert.deepEqual(errs(alloy([ti, { symbol: 'Al', fraction: { min: 0.4, max: 0.5 } }, balance])), []);                                                   // exists (Al = 0.4, remainder 0)
  assert.deepEqual(errs(alloy([{ symbol: 'Ti', fraction: { min: 0.6, max: 0.7 } }, { symbol: 'Al', fraction: { min: 0.401, max: 0.5 } }, balance], { sumTolerance: 0.01 })), ['fraction_sum']);
  // the tolerance still does its own job where there is no balance (a published sum rounded to 0.999)
  assert.deepEqual(errs(alloy([{ symbol: 'Fe', fraction: { value: 0.333 } }, { symbol: 'Ni', fraction: { value: 0.333 } }, { symbol: 'Cr', fraction: { value: 0.333 } }], { sumTolerance: 0.005 })), []);
});

// ---------- F2: the validator never throws on a damaged record ----------

const GARBAGE: unknown[] = [null, undefined, 5, 'x', [], {}, true, NaN];

/** Every object/array path in a JSON value, as arrays of keys. */
function pathsOf(value: unknown, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) { const p = [...prefix, Array.isArray(value) ? Number(key) : key]; out.push(p); pathsOf((value as Record<string, unknown>)[key], p, out); }
  }
  return out;
}
function setAt(root: unknown, path: (string | number)[], value: unknown): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1]] = value;
}

test('F2: the audit case - composition = null returns a report, no TypeError', () => {
  const catalog = deep(syntheticSystemCatalog()) as unknown as { variants: Record<string, unknown>[] };
  catalog.variants[1].composition = null;
  const report = validateCatalog(catalog);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some(i => i.severity === 'error'));
});

test('F2: every single path of a valid catalog replaced by garbage gives a ValidationReport (never an exception)', () => {
  const base = syntheticSystemCatalog();
  const paths = pathsOf(base);
  assert.ok(paths.length > 100);
  let checked = 0;
  for (const path of paths) {
    for (const garbage of GARBAGE) {
      const catalog = deep(base);
      setAt(catalog, path, garbage);
      let report: ReturnType<typeof validateCatalog> | undefined;
      assert.doesNotThrow(() => { report = validateCatalog(catalog); }, `${path.join('.')} = ${String(garbage)}`);
      assert.ok(report && Array.isArray(report.issues) && typeof report.ok === 'boolean', path.join('.'));
      checked += 1;
    }
  }
  assert.ok(checked > 800);
});

test('F2: damaged top-level and nested structures', () => {
  for (const bad of [null, undefined, 5, 'x', [], {}, { identities: 5, variants: [] }, { identities: [], variants: 5 }, { identities: [null], variants: [null] }, { identities: ['x'], variants: [5] }]) {
    assert.doesNotThrow(() => validateCatalog(bad));
    assert.equal(validateCatalog(bad).ok, false, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => variantReferences(null));
  assert.deepEqual(variantReferences({ composition: { type: 'coating_system', stack: { elements: [null, 5, { type: 'layer', layer: null }, { type: 'period', elements: 'x' }] } }, form: null }), []);
  // a damaged reference target: the referencing record is reported, the walk does not crash
  const catalog = deep(syntheticSystemCatalog()) as unknown as { variants: Record<string, unknown>[] };
  catalog.variants[0] = null as never;
  assert.doesNotThrow(() => validateCatalog(catalog));
  assert.ok(catalogErrs(catalog).includes('missing_reference'));
  assert.throws(() => createCatalog(catalog as never), MaterialsError);
});

// ---------- F3: the role of a reference is kept ----------

const element = (id: string, ident: string): MaterialVariant => ({ ...syntheticElement(), id, identity: ident });
function systemOf(id: string, stack: Record<string, unknown>): MaterialVariant {
  return { id, identity: 'fixture:synthetic-system', composition: { type: 'coating_system', stack } as never, form: { kind: 'coating_layer' } };
}
const nestedCatalog = (outerStack: Record<string, unknown>): MaterialCatalog => ({
  identities: [identity('synthetic-element', 'element'), identity('synthetic-system', 'coating_system')],
  variants: [
    element('fixture:el-a', 'fixture:synthetic-element'),
    { ...element('fixture:el-b', 'fixture:synthetic-element'), composition: { type: 'element', symbol: 'Si' } },
    systemOf('fixture:inner', { elements: [{ type: 'layer', layer: { kind: 'uniform', id: 'l1', material: 'fixture:el-a' } }] }),
    systemOf('fixture:outer', outerStack),
  ],
});
const layerOf = (material: string) => ({ type: 'layer', layer: { kind: 'uniform', id: 'inner-layer', material } });

test('F3: the same variant as the substrate AND as a layer material of a system is refused (the layer role is checked, not the id)', () => {
  const catalog = nestedCatalog({ substrate: 'fixture:inner', elements: [layerOf('fixture:inner')] });
  assert.deepEqual(catalogErrs(catalog), ['nested_coating_system']);
  const roles = variantReferences(catalog.variants[3]);
  assert.deepEqual(roles.map(r => `${r.role}:${r.id}`), ['stack_substrate:fixture:inner', 'layer_material:fixture:inner']);
});

test('F3: a coating system is allowed as a substrate, forbidden as a layer material and as either end of a graded layer', () => {
  assert.deepEqual(catalogErrs(nestedCatalog({ substrate: 'fixture:inner', elements: [layerOf('fixture:el-a')] })), []);                                      // a coated substrate
  assert.deepEqual(catalogErrs(nestedCatalog({ elements: [layerOf('fixture:inner')] })), ['nested_coating_system']);                                         // a layer
  const gradient = (from: string, to: string) => ({ elements: [{ type: 'layer', layer: { kind: 'gradient', id: 'g', from, to } }] });
  assert.deepEqual(catalogErrs(nestedCatalog(gradient('fixture:inner', 'fixture:el-a'))), ['nested_coating_system']);
  assert.deepEqual(catalogErrs(nestedCatalog(gradient('fixture:el-a', 'fixture:inner'))), ['nested_coating_system']);
  assert.deepEqual(catalogErrs(nestedCatalog(gradient('fixture:el-a', 'fixture:el-b'))), []);
  // inside a periodic package too
  assert.deepEqual(catalogErrs(nestedCatalog({ elements: [{ type: 'period', repeat: 3, elements: [layerOf('fixture:el-a'), { type: 'layer', layer: { kind: 'uniform', id: 'deep', material: 'fixture:inner' } }] }] })), ['nested_coating_system']);
  // a plain material is a fine substrate AND a fine layer at the same time (equal ids in different roles are not an error as such)
  assert.deepEqual(catalogErrs(nestedCatalog({ substrate: 'fixture:el-a', elements: [layerOf('fixture:el-a')] })), []);
  assert.deepEqual(variantReferences(nestedCatalog(gradient('fixture:el-a', 'fixture:el-b')).variants[3]).map(r => r.role), ['gradient_from', 'gradient_to']);
});

test('F3: cycles are still found, whatever the roles', () => {
  const selfLayer = nestedCatalog({ elements: [layerOf('fixture:outer')] });
  assert.ok(catalogErrs(selfLayer).includes('reference_cycle'));
  const selfSubstrate = nestedCatalog({ substrate: 'fixture:outer', elements: [layerOf('fixture:el-a')] });
  assert.deepEqual(catalogErrs(selfSubstrate), ['reference_cycle']);
  const viaForm = nestedCatalog({ elements: [layerOf('fixture:el-a')] });
  (viaForm.variants[3] as { form: unknown }).form = { kind: 'coating_layer', substrate: 'fixture:outer' };
  assert.deepEqual(catalogErrs(viaForm), ['reference_cycle']);
  const twoStep = nestedCatalog({ substrate: 'fixture:inner', elements: [layerOf('fixture:el-a')] });
  (twoStep.variants[2] as { form: unknown }).form = { kind: 'coating_layer', substrate: 'fixture:outer' };                                                      // inner stands on outer, outer on inner
  assert.deepEqual(catalogErrs(twoStep), ['reference_cycle']);
});

// ---------- F4: aggregate state and form ----------

const EXPECTED: Record<string, Record<string, 'ok' | 'ambiguous' | 'incompatible'>> = {
  solid: { bulk: 'ok', thin_film: 'ok', coating_layer: 'ok', sputtering_target: 'ok', powder: 'ok', foil: 'ok', substrate: 'ok' },
  liquid: { bulk: 'ok', thin_film: 'ambiguous', coating_layer: 'ambiguous', sputtering_target: 'ambiguous', powder: 'incompatible', foil: 'incompatible', substrate: 'ambiguous' },
  gas: { bulk: 'ok', thin_film: 'incompatible', coating_layer: 'incompatible', sputtering_target: 'incompatible', powder: 'incompatible', foil: 'incompatible', substrate: 'incompatible' },
  plasma: { bulk: 'ok', thin_film: 'incompatible', coating_layer: 'incompatible', sputtering_target: 'incompatible', powder: 'incompatible', foil: 'incompatible', substrate: 'incompatible' },
};

test('F4: the state x form table (written out, 4 x 7)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(STATE_FORM_COMPATIBILITY)), EXPECTED);
  for (const state of AGGREGATE_STATES) for (const form of MATERIAL_FORM_KINDS) {
    const phase = state === 'solid' ? { state, order: 'unknown' } : { state, order: 'not_applicable' };
    const v = { ...syntheticElement(), phase, form: { kind: form } } as MaterialVariant;
    const report = validateVariant(v);
    const mismatch = report.issues.some(i => i.code === 'state_form_mismatch' && i.severity === 'error');
    const ambiguous = report.issues.some(i => i.code === 'state_form_ambiguous' && i.severity === 'warning');
    const verdict = EXPECTED[state][form];
    assert.equal(mismatch, verdict === 'incompatible', `${state} x ${form}`);
    assert.equal(ambiguous, verdict === 'ambiguous', `${state} x ${form}`);
    assert.equal(report.ok, verdict !== 'incompatible', `${state} x ${form}`);
  }
});

test('F4: the audit case (a gas as a powder) and others', () => {
  const gasPowder = { ...syntheticElement(), phase: { state: 'gas', order: 'not_applicable' }, form: { kind: 'powder', particleSize: q(5, 'um') } };
  assert.ok(errs(gasPowder).includes('state_form_mismatch'));
  assert.deepEqual(errs({ ...gasPowder, phase: { state: 'solid', order: 'unknown' } }), []);
  assert.deepEqual(errs({ ...gasPowder, phase: { state: 'liquid', order: 'not_applicable' } }), ['state_form_mismatch']);
  // a liquid film is possible but needs context: a warning that asks for it, not an error
  const liquidFilm = { ...syntheticElement(), phase: { state: 'liquid', order: 'not_applicable' }, form: { kind: 'thin_film', thickness: q(1, 'um') } };
  assert.deepEqual(errs(liquidFilm), []);
  assert.ok(validateVariant(liquidFilm).issues.some(i => i.code === 'state_form_ambiguous'));
  // a composite or a coating system has no phase of its own: the check does not apply
  assert.ok(!validateVariant(syntheticSystemCatalog().variants[4]).issues.some(i => i.code.startsWith('state_form')));
});

// ---------- F5: unknown fields at every level ----------

test('F5: unknown fields are errors at every level and are never dropped silently', () => {
  const extra = { physicalProperty: 123 };
  const base = syntheticSystemCatalog();
  const cases: [string, (c: MaterialCatalog) => void, string][] = [
    ['catalog', c => Object.assign(c, { extra }), 'invalid_material'],
    ['identity', c => Object.assign(c.identities[0], { extra }), 'invalid_material'],
    ['variant', c => Object.assign(c.variants[0], { extra }), 'invalid_material'],
    ['composition', c => Object.assign(c.variants[2].composition, { extra }), 'invalid_composition'],
    ['alloy constituent', c => Object.assign((c.variants[2].composition as unknown as { constituents: object[] }).constituents[0], { extra }), 'invalid_composition'],
    ['fraction', c => Object.assign(((c.variants[2].composition as unknown as { constituents: { fraction: object }[] }).constituents[0]).fraction, { extra }), 'fraction_malformed'],
    ['stoichiometry species', c => Object.assign((c.variants[1].composition as unknown as { species: object[] }).species[0], { extra }), 'invalid_composition'],
    ['phase', c => Object.assign(c.variants[0].phase as object, { extra }), 'invalid_phase'],
    ['crystal structure', c => Object.assign((c.variants[0].phase as { crystalStructure: object }).crystalStructure, { extra }), 'invalid_phase'],
    ['form', c => Object.assign(c.variants[1].form, { extra }), 'invalid_form'],
    ['form thickness (a Quantity)', c => Object.assign((c.variants[1].form as { thickness: object }).thickness, { extra }), 'invalid_quantity'],
    ['deposition', c => Object.assign((c.variants[1].form as { deposition: object }).deposition, { extra }), 'invalid_form'],
    ['stack', c => Object.assign((c.variants[4].composition as unknown as { stack: object }).stack, { extra }), 'invalid_stack'],
    ['layer', c => Object.assign((c.variants[4].composition as unknown as { stack: { elements: { layer: object }[] } }).stack.elements[0].layer, { extra }), 'invalid_layer'],
    ['layer thickness (a Quantity)', c => Object.assign((c.variants[4].composition as unknown as { stack: { elements: { layer: { thickness: object } }[] } }).stack.elements[0].layer.thickness, { extra }), 'invalid_quantity'],
    ['period', c => Object.assign((c.variants[4].composition as unknown as { stack: { elements: object[] } }).stack.elements[1], { extra }), 'invalid_period'],
    ['interface', c => Object.assign((c.variants[4].composition as unknown as { stack: { elements: { interfaceToNext: object }[] } }).stack.elements[0].interfaceToNext, { extra }), 'invalid_interface'],
    ['interface width (a Quantity)', c => Object.assign((c.variants[4].composition as unknown as { stack: { elements: { interfaceBetweenRepeats: { width: object } }[] } }).stack.elements[1].interfaceBetweenRepeats.width, { extra }), 'invalid_quantity'],
  ];
  for (const [name, mutate, code] of cases) {
    const catalog = deep(base);
    assert.deepEqual(catalogErrs(catalog), [], `${name}: the unmodified fixture must be valid`);
    mutate(catalog);
    const before = JSON.stringify(catalog);
    const codes = catalogErrs(catalog);
    assert.ok(codes.includes(code), `${name}: expected ${code}, got ${codes.join(',')}`);
    assert.equal(JSON.stringify(catalog), before, `${name}: validation must not change the record`);
    assert.throws(() => createCatalog(catalog), MaterialsError, name);                                                                                          // not stored as validated
  }
});

test('F5: sources and structure nodes: citation, designation, phase source, stable range, grain size, porosity', () => {
  const extra = { physicalProperty: 123 };
  const withSource = (source: unknown) => ({ ...syntheticElement(), phase: { ...syntheticElement().phase, source } }) as never;
  assert.deepEqual(errs(withSource({ citation: 'СИНТЕТИЧЕСКИЙ' })), []);
  assert.deepEqual(errs(withSource({ citation: 'СИНТЕТИЧЕСКИЙ', ...extra })), ['invalid_source']);
  assert.deepEqual(errs(withSource({ citation: 'СИНТЕТИЧЕСКИЙ', doi: '10.1234/x', locator: 'T1', page: 3 })), ['invalid_source']);
  const withStructure = (structure: unknown) => ({ ...syntheticElement(), structure }) as never;
  assert.deepEqual(errs(withStructure({ grainSize: { size: { ...q(5, 'nm'), ...extra } } })), ['invalid_quantity']);
  assert.deepEqual(errs(withStructure({ porosity: { ...q(5, 'percent'), ...extra } })), ['invalid_quantity']);
  assert.deepEqual(errs(withStructure({ source: { citation: 'x', ...extra } })), ['invalid_source']);
  const stable = (min: unknown) => ({ ...syntheticElement(), phase: { state: 'solid', order: 'crystalline', stableRange: { min, max: q(900, 'K') } } }) as never;
  assert.deepEqual(errs(stable(q(300, 'K'))), []);
  assert.deepEqual(errs(stable({ ...q(300, 'K'), ...extra })), ['invalid_quantity']);
  const designation = (source: unknown) => ({ id: 'fixture:x', kind: 'alloy', nameRu: 'СИНТЕТИЧЕСКИЙ', designations: [{ system: 'UNS', value: 'S', source }] });
  assert.equal(validateCatalog({ identities: [designation({ citation: 'СИНТЕТИЧЕСКИЙ' })], variants: [] }).ok, true);
  assert.deepEqual(catalogErrs({ identities: [designation({ citation: 'СИНТЕТИЧЕСКИЙ', ...extra })], variants: [] }), ['invalid_source']);
  assert.deepEqual(catalogErrs({ identities: [{ ...designation({ citation: 'x' }), designations: [{ system: 'UNS', value: 'S', source: { citation: 'x' }, ...extra }] }], variants: [] }), ['invalid_material']);
});

// ---------- F6: one source of geometry ----------

test('F6: a coating system has no thickness of its own; the stack is the single source of geometry', () => {
  const catalog = deep(syntheticSystemCatalog());
  const system = catalog.variants[4] as unknown as { form: Record<string, unknown>; composition: { stack: never } };
  assert.deepEqual(catalogErrs(catalog), []);
  assert.ok(Math.abs(totalThickness(system.composition.stack).value - 125e-9) < 1e-18);                                  // the stack: 20 + 5 * (10 + 5) + 30 = 125 nm
  system.form.thickness = q(999, 'nm');                                                                                    // contradicts the sum of the layers
  assert.deepEqual(catalogErrs(catalog), ['form_field_not_allowed']);
  system.form.thickness = q(125, 'nm');                                                                                    // even an agreeing value is a second source
  assert.deepEqual(catalogErrs(catalog), ['form_field_not_allowed']);
  delete system.form.thickness;
  assert.deepEqual(catalogErrs(catalog), []);
  // a single film still has its own thickness
  assert.deepEqual(errs({ ...syntheticElement(), form: { kind: 'thin_film', thickness: q(100, 'nm') } }), []);
});

test('F6: the substrate must be one: form.substrate and stack.substrate agree or only one is given', () => {
  const build = (formSubstrate?: string, stackSubstrate?: string): MaterialCatalog => {
    const catalog = deep(syntheticSystemCatalog());
    const system = catalog.variants[4] as unknown as { form: Record<string, unknown>; composition: { stack: Record<string, unknown> } };
    if (stackSubstrate === undefined) delete system.composition.stack.substrate; else system.composition.stack.substrate = stackSubstrate;
    if (formSubstrate === undefined) delete system.form.substrate; else system.form.substrate = formSubstrate;
    return catalog;
  };
  const sub = 'fixture:synthetic-substrate-bulk';
  assert.deepEqual(catalogErrs(build(sub, sub)), []);                                                                      // agree
  assert.deepEqual(catalogErrs(build(undefined, sub)), []);                                                                // stack only
  assert.deepEqual(catalogErrs(build(sub, undefined)), []);                                                                // form only
  assert.deepEqual(catalogErrs(build(undefined, undefined)), []);                                                          // none: a missing datum, not an error
  assert.deepEqual(catalogErrs(build('fixture:synthetic-element-bulk', sub)), ['substrate_conflict']);                    // contradiction
  assert.deepEqual(catalogErrs(build(sub, 'fixture:synthetic-element-bulk')), ['substrate_conflict']);
  // missing-data report follows the same single contract
  const missing = (c: MaterialCatalog) => describeMissingData(c.variants[4]).map(m => m.path).filter(p => p.includes('substrate'));
  assert.deepEqual(missing(build(sub, sub)), []);
  assert.deepEqual(missing(build(undefined, sub)), []);
  assert.deepEqual(missing(build(sub, undefined)), []);
  assert.deepEqual(missing(build(undefined, undefined)), ['composition.stack.substrate']);                                   // one entry: nothing said about a substrate
});
