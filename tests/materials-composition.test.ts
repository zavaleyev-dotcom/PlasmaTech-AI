import test from 'node:test';
import assert from 'node:assert/strict';
import * as materials from '../src/materials';
import { validateVariant, atomicFractionsFromStoichiometry, createVariant, MaterialsError, type MaterialKind, type MaterialVariant } from '../src/materials';
import { syntheticAlloy, syntheticCompound, syntheticElement } from './materials-fixtures';

const errors = (v: unknown, kind?: MaterialKind) => validateVariant(v, kind).issues.filter(i => i.severity === 'error').map(i => i.code);
const issues = (v: unknown, kind?: MaterialKind) => validateVariant(v, kind).issues;
const alloy = (constituents: unknown[], extra: Record<string, unknown> = {}): MaterialVariant => ({ ...syntheticAlloy(), composition: { type: 'alloy', basis: 'atomic', constituents, ...extra } as never });
const compound = (stoichiometry: string, species: unknown[]): MaterialVariant => ({ ...syntheticCompound(), composition: { type: 'stoichiometric', stoichiometry, species } as never });

test('valid synthetic variants pass; element, alloy and compound', () => {
  for (const v of [syntheticElement(), syntheticAlloy(), syntheticCompound()]) assert.deepEqual(errors(v), [], v.id);
  assert.ok(Object.isFrozen(createVariant(syntheticAlloy())));
});

test('alloy fractions are EXACT decimals: 0.1 + 0.2 + 0.7 is 1, 0.3 + 0.3 + 0.3 is not', () => {
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 0.1 } }, { symbol: 'Ni', fraction: { value: 0.2 } }, { symbol: 'Cr', fraction: { value: 0.7 } }])), []);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 0.3 } }, { symbol: 'Ni', fraction: { value: 0.3 } }, { symbol: 'Cr', fraction: { value: 0.3 } }])), ['fraction_sum']);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 0.5 } }, { symbol: 'Ni', fraction: { value: 0.6 } }])), ['fraction_sum']);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 0.999999 } }, { symbol: 'Ni', fraction: { value: 0.000002 } }])), ['fraction_sum']); // no silent tolerance
});

test('a declared rounding tolerance is accepted with a warning; absurd tolerances are refused', () => {
  const rounded = [{ symbol: 'Fe', fraction: { value: 0.333 } }, { symbol: 'Ni', fraction: { value: 0.333 } }, { symbol: 'Cr', fraction: { value: 0.333 } }];
  assert.deepEqual(errors(alloy(rounded)), ['fraction_sum']);
  assert.deepEqual(errors(alloy(rounded, { sumTolerance: 0.005 })), []);
  assert.ok(issues(alloy(rounded, { sumTolerance: 0.005 })).some(i => i.code === 'sum_not_exact' && i.severity === 'warning'));
  assert.deepEqual(errors(alloy(rounded, { sumTolerance: 0.0001 })), ['fraction_sum']);
  for (const bad of [-0.1, 0.5, NaN, '0.1']) assert.ok(errors(alloy(rounded, { sumTolerance: bad })).includes('invalid_tolerance'), String(bad));
});

test('bounds: fractions in [0, 1], finite, one form only', () => {
  const two = (a: unknown) => alloy([{ symbol: 'Fe', fraction: a }, { symbol: 'Ni', fraction: { value: 0.5 } }]);
  assert.deepEqual(errors(two({ value: -0.1 })), ['fraction_out_of_range']);
  assert.deepEqual(errors(two({ value: 1.5 })), ['fraction_out_of_range']);
  assert.deepEqual(errors(two({ value: NaN })), ['fraction_malformed']);
  assert.deepEqual(errors(two({ value: Infinity })), ['fraction_malformed']);
  assert.deepEqual(errors(two({ value: '0.5' })), ['fraction_malformed']);
  assert.deepEqual(errors(two({ value: 0.5, min: 0.4, max: 0.6 })), ['fraction_malformed']);
  assert.deepEqual(errors(two({})), ['fraction_malformed']);
  assert.deepEqual(errors(two(null)), ['fraction_malformed']);
  assert.deepEqual(errors(two({ min: 0.6, max: 0.4 })), ['fraction_out_of_range']);
  assert.deepEqual(errors(two({ min: -0.1, max: 0.4 })), ['fraction_out_of_range']);
  assert.deepEqual(errors(two({ min: 0.2, max: 1.2 })), ['fraction_out_of_range']);
  assert.deepEqual(errors(two({ balance: false })), ['fraction_malformed']);
});

test('ranges of allowed composition: feasibility of a sum of 1; the balance component', () => {
  const r = (min: number, max: number) => ({ min, max });
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: r(0.6, 0.8) }, { symbol: 'Ni', fraction: r(0.2, 0.4) }])), []);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: r(0.1, 0.2) }, { symbol: 'Ni', fraction: r(0.1, 0.2) }])), ['fraction_range_infeasible']);   // can never reach 1
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: r(0.7, 0.8) }, { symbol: 'Ni', fraction: r(0.4, 0.5) }])), ['fraction_range_infeasible']);   // always above 1
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { balance: true } }, { symbol: 'Cr', fraction: r(0.1, 0.2) }, { symbol: 'Ni', fraction: { value: 0.1 } }])), []);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { balance: true } }, { symbol: 'Cr', fraction: { balance: true } }])), ['balance_invalid']);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { balance: true } }, { symbol: 'Cr', fraction: { value: 1.0 } }])), []);
  assert.ok(issues(alloy([{ symbol: 'Fe', fraction: { balance: true } }, { symbol: 'Cr', fraction: { value: 1.0 } }])).some(i => i.severity === 'warning'));  // a zero remainder is flagged
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { balance: true } }, { symbol: 'Cr', fraction: r(1.0, 1.0) }, { symbol: 'Ni', fraction: { value: 0.2 } }])), ['fraction_sum']);
});

test('constituents: valid symbols, no duplicates, at least two; one basis; unknown fields refused', () => {
  const ok = { symbol: 'Ni', fraction: { value: 0.5 } };
  assert.deepEqual(errors(alloy([{ symbol: 'Xx', fraction: { value: 0.5 } }, ok])), ['invalid_symbol']);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 0.5 } }, { symbol: 'Fe', fraction: { value: 0.5 } }])), ['duplicate_symbol']);
  assert.deepEqual(errors(alloy([{ symbol: 'Fe', fraction: { value: 1 } }])), ['too_few_constituents']);
  assert.deepEqual(errors(alloy([])), ['too_few_constituents']);
  const base = { symbol: 'Fe', fraction: { value: 0.5 } };
  for (const basis of ['volume', 'molar', 'weight', undefined]) assert.deepEqual(errors({ ...syntheticAlloy(), composition: { type: 'alloy', basis, constituents: [base, ok] } }), ['invalid_composition'], String(basis));
  assert.deepEqual(errors(alloy([{ ...base, density: 7.8 }, ok])), ['invalid_composition']);                       // a smuggled-in property value is refused, not ignored
  assert.deepEqual(errors({ ...syntheticAlloy(), density: 7.8 }), ['invalid_material']);
  assert.deepEqual(errors({ ...syntheticAlloy(), composition: { ...syntheticAlloy().composition, meltingPoint: 1800 } }), ['invalid_composition']);
});

test('composite: constituents are variants, fractions of ONE basis (volume by default), sums, no duplicates', () => {
  const composite = (basis: string, constituents: unknown[]) => ({ ...syntheticAlloy(), id: 'fixture:synthetic-composite', phase: undefined, composition: { type: 'composite', basis, constituents } }) as never;
  const a = { material: 'fixture:synthetic-alloy-bulk', fraction: { value: 0.6 } };
  const b = { material: 'fixture:synthetic-element-bulk', fraction: { value: 0.4 } };
  assert.deepEqual(errors(composite('volume', [a, b]), 'composite'), []);
  assert.deepEqual(errors(composite('mass', [a, b]), 'composite'), []);
  assert.deepEqual(errors(composite('molar', [a, b]), 'composite'), []);
  assert.deepEqual(errors(composite('atomic', [a, b]), 'composite'), ['invalid_composition']);                        // atomic fractions of phases are not a thing
  assert.deepEqual(errors(composite('volume', [a, { ...b, fraction: { value: 0.5 } }]), 'composite'), ['fraction_sum']);
  assert.deepEqual(errors(composite('volume', [a, a]), 'composite'), ['duplicate_id']);
  assert.deepEqual(errors(composite('volume', [a]), 'composite'), ['too_few_constituents']);
  assert.deepEqual(errors(composite('volume', [a, { ...b, material: 'bad id' }]), 'composite'), ['invalid_id']);
});

test('stoichiometry: integers for a stoichiometric compound, non-whole counts or ranges for a non-stoichiometric one; invalid counts refused', () => {
  const sp = (symbol: string, count: unknown) => ({ symbol, count });
  assert.deepEqual(errors(compound('stoichiometric', [sp('Al', 2), sp('O', 3)])), []);
  assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', 1), sp('N', 0.9)])), ['stoichiometry_invalid']);              // a fraction in a "stoichiometric" formula
  assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', 1), sp('N', { min: 0.9, max: 1 })])), ['stoichiometry_invalid']);
  assert.deepEqual(errors(compound('nonstoichiometric', [sp('Ti', 1), sp('N', { min: 0.9, max: 1 })])), []);
  assert.deepEqual(errors(compound('nonstoichiometric', [sp('Ti', 1), sp('N', 0.95)])), []);
  assert.deepEqual(errors(compound('nonstoichiometric', [sp('Ti', 1), sp('N', 1)])), ['stoichiometry_invalid']);              // declared non-stoichiometric, but all whole
  for (const bad of [0, -1, NaN, Infinity, 1001, '2', null]) assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', bad), sp('N', 1)])), ['stoichiometry_invalid'], String(bad));
  assert.deepEqual(errors(compound('nonstoichiometric', [sp('Ti', { min: 1, max: 0.5 }), sp('N', 1.5)])), ['stoichiometry_invalid']);
  assert.deepEqual(errors(compound('nonstoichiometric', [sp('Ti', { min: 0, max: 1 }), sp('N', 1.5)])), ['stoichiometry_invalid']);
  assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', 1)])), ['too_few_species']);
  assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', 1), sp('Ti', 1)])), ['duplicate_symbol']);
  assert.deepEqual(errors(compound('stoichiometric', [sp('Ti', 1), sp('Qq', 1)])), ['invalid_symbol']);
  assert.deepEqual(errors(compound('ionic', [sp('Ti', 1), sp('N', 1)])), ['stoichiometry_invalid']);
  assert.ok(issues(compound('stoichiometric', [sp('Al', 4), sp('O', 6)])).some(i => i.severity === 'warning'));                // not reduced
});

test('the kind of the material decides which composition is allowed', () => {
  const kinds: MaterialKind[] = ['element', 'compound', 'alloy', 'ceramic', 'composite', 'coating_system'];
  const samples: Record<string, MaterialVariant> = { element: syntheticElement(), alloy: syntheticAlloy(), compound: syntheticCompound() };
  assert.deepEqual(errors(samples.element, 'element'), []);
  assert.deepEqual(errors(samples.compound, 'ceramic'), []);
  for (const kind of kinds) {
    if (kind === 'element') continue;
    assert.ok(errors(samples.element, kind).includes('kind_composition_mismatch'), `element composition as ${kind}`);
  }
  assert.ok(errors(samples.alloy, 'compound').includes('kind_composition_mismatch'));
  assert.ok(errors(samples.compound, 'alloy').includes('kind_composition_mismatch'));
});

test('atomic fractions of a stoichiometric compound = count / total (no atomic weights); ranges and mass fractions are not computed', () => {
  const fractions = atomicFractionsFromStoichiometry({ type: 'stoichiometric', stoichiometry: 'stoichiometric', species: [{ symbol: 'Al', count: 2 }, { symbol: 'O', count: 3 }] });
  assert.deepEqual(fractions, { Al: 0.4, O: 0.6 });
  assert.deepEqual(atomicFractionsFromStoichiometry({ type: 'stoichiometric', stoichiometry: 'stoichiometric', species: [{ symbol: 'Ti', count: 1 }, { symbol: 'N', count: 1 }] }), { Ti: 0.5, N: 0.5 });
  assert.throws(() => atomicFractionsFromStoichiometry({ type: 'stoichiometric', stoichiometry: 'nonstoichiometric', species: [{ symbol: 'Ti', count: 1 }, { symbol: 'N', count: { min: 0.9, max: 1 } }] }), (e: unknown) => e instanceof MaterialsError && e.code === 'missing_data');
  assert.throws(() => atomicFractionsFromStoichiometry({ type: 'stoichiometric', stoichiometry: 'stoichiometric', species: [{ symbol: 'Ti', count: 0 }, { symbol: 'N', count: 1 }] }), MaterialsError);
  // there is deliberately NO conversion between mass, atomic and volume fractions anywhere in the package
  const names = Object.keys(materials);
  assert.ok(!names.some(n => /(mass|weight|convert).*(fraction|basis)|(fraction|basis).*(convert|mass|weight)|atomicWeight|molarMass/i.test(n.replace('atomicFractionsFromStoichiometry', ''))), names.join());
});
