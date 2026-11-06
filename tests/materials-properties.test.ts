import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPERTY_DEFINITIONS, getPropertyDefinition, validatePropertyRecord, createPropertyRecord, CONDITION_KEYS, VALUE_FORMS, MaterialsError } from '../src/materials';
import { QUANTITY_KINDS, getUnit, dimEquals } from '../src/physics';
import { densityRecord, conductivityRecord } from './materials-property-fixtures';
import { syntheticElement } from './materials-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const errs = (r: unknown, variant?: unknown) => validatePropertyRecord(r, variant).issues.filter(i => i.severity === 'error').map((i): string => i.code);

test('definitions: the initial set, each in a kind the physics registry already has; the canonical unit and dimension come from the kind', () => {
  const ids = PROPERTY_DEFINITIONS.map(d => d.id);
  assert.deepEqual(ids, ['density', 'thermal_conductivity', 'specific_heat_capacity', 'linear_expansion_coefficient', 'electrical_resistivity', 'electrical_conductivity', 'molar_mass', 'youngs_modulus', 'shear_modulus', 'bulk_modulus', 'thermal_diffusivity']);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of PROPERTY_DEFINITIONS) {
    const kind = QUANTITY_KINDS[d.kind];
    assert.ok(kind, `${d.id}: kind ${d.kind} is registered`);
    assert.equal(d.siUnit, kind.siUnit);
    assert.equal(getUnit(d.siUnit).kind, d.kind);
    assert.ok(dimEquals(d.dimension, kind.dimension));
    assert.ok(d.nameRu.length > 0 && d.nameEn.length > 0 && d.definitionRu.length > 20);
    assert.deepEqual([...d.valueForms], ['scalar']);                                                  // only scalars now; tensor2 / function are reserved names
    for (const key of [...d.requiredConditions, ...d.allowedConditions]) assert.ok((CONDITION_KEYS as readonly string[]).includes(key), `${d.id}: ${key}`);
    for (const key of d.requiredConditions) assert.ok(key === 'temperature' ? d.allowedConditions.includes('temperature') && d.allowedConditions.includes('temperatureRange') : d.allowedConditions.includes(key), `${d.id}: required ${key} must be allowed`);
    for (const key of d.filmRequiredConditions ?? []) assert.ok(d.allowedConditions.includes(key), `${d.id}: film-required ${key} must be allowed`);
  }
  assert.ok(VALUE_FORMS.includes('tensor2') && VALUE_FORMS.includes('function'));                      // reserved, not closed off
  assert.ok(Object.isFrozen(PROPERTY_DEFINITIONS) && Object.isFrozen(PROPERTY_DEFINITIONS[0]) && Object.isFrozen(PROPERTY_DEFINITIONS[0].requiredConditions));
});

test('the three elastic moduli are separate properties of one kind (the elastic modulus, not the pressure); no new kind was needed', () => {
  const moduli = ['youngs_modulus', 'shear_modulus', 'bulk_modulus'].map(id => getPropertyDefinition(id)!);
  assert.deepEqual(moduli.map(d => d.kind), ['elasticModulus', 'elasticModulus', 'elasticModulus']);
  assert.deepEqual(moduli.map(d => d.siUnit), ['Pa_mod', 'Pa_mod', 'Pa_mod']);
  assert.equal(new Set(moduli.map(d => d.id)).size, 3);
  assert.equal(getPropertyDefinition('density')!.kind, 'massDensity');
  assert.equal(getPropertyDefinition('linear_expansion_coefficient')!.kind, 'linearExpansionCoefficient');
  for (const bad of ['', 'Density', '__proto__', 'toString', 'constructor', undefined, null, 5, {}]) assert.equal(getPropertyDefinition(bad), undefined, String(bad));
});

test('a valid synthetic record passes; the unit may be any unit of the kind', () => {
  assert.deepEqual(errs(densityRecord()), []);
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 0.001, unit: 'g_cm3' } })), []);
  assert.deepEqual(errs(conductivityRecord({ value: { type: 'scalar', value: 0.02, unit: 'W_cmK' } })), []);
  assert.ok(Object.isFrozen(createPropertyRecord(densityRecord())));
  assert.throws(() => createPropertyRecord(densityRecord({ id: 'bad id' })), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_property');
});

test('dimensions and units: an incompatible unit, a unit of a look-alike kind, non-finite and physically impossible values are refused', () => {
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 1, unit: 'W_mK' } })), ['invalid_quantity']);                 // wrong dimension
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 1, unit: 'Pa' } })), ['invalid_quantity']);
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 1, unit: 'nope' as never } })), ['invalid_quantity']);
  const modulus = (unit: string) => ({ id: 'fixture:rec-e', variant: 'fixture:synthetic-element-bulk', property: 'youngs_modulus', value: { type: 'scalar', value: 1, unit }, uncertainty: { kind: 'unknown' }, conditions: { temperature: q(300, 'K') }, provenance: densityRecord().provenance, version: 1, updatedAt: '2000-01-01' });
  assert.deepEqual(errs(modulus('GPa_mod')), []);
  assert.deepEqual(errs(modulus('GPa' as never)), ['invalid_quantity']);                                                                // 'GPa' is not even a unit; and
  assert.deepEqual(errs(modulus('Pa')), ['invalid_quantity']);                                                                          // a pressure is not an elastic modulus
  assert.deepEqual(errs(modulus('A_m_M')), ['invalid_quantity']);
  for (const bad of [NaN, Infinity, -Infinity, '1' as never, null as never]) assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: bad, unit: 'kg_m3' } })), ['invalid_quantity'], String(bad));
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: -1, unit: 'kg_m3' } })), ['invalid_quantity']);                  // a negative density
  assert.deepEqual(errs(conductivityRecord({ value: { type: 'scalar', value: -1, unit: 'W_mK' } })), ['invalid_quantity']);
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 1e308, unit: 'g_cm3' } })), ['invalid_quantity']);              // overflow in the SI conversion
  const alpha = { ...densityRecord(), property: 'linear_expansion_coefficient', value: { type: 'scalar', value: -3, unit: 'ppm_K' }, conditions: { expansionDefinition: 'tangent', temperature: q(300, 'K') } };
  assert.deepEqual(errs(alpha), []);                                                                                                    // a negative expansion coefficient exists
});

test('value forms: tensors and functions are reserved for later stages and refused now, distinctly from garbage', () => {
  assert.deepEqual(errs(densityRecord({ value: { type: 'tensor2', components: [[1]], unit: 'kg_m3' } as never })), ['unsupported_value_form']);
  assert.deepEqual(errs(densityRecord({ value: { type: 'function', points: [] } as never })), ['unsupported_value_form']);
  assert.deepEqual(errs(densityRecord({ value: { type: 'blob' } as never })), ['invalid_value']);
  assert.deepEqual(errs(densityRecord({ value: 5 as never })), ['invalid_value']);
  assert.deepEqual(errs(densityRecord({ value: { type: 'scalar', value: 1, unit: 'kg_m3', extra: 1 } as never })), ['invalid_value']);
});

test('unknown property; deterministic ids; version and date', () => {
  assert.ok(errs(densityRecord({ property: 'hardness' })).includes('unknown_property'));
  assert.ok(errs(densityRecord({ property: '__proto__' })).includes('unknown_property'));
  for (const bad of ['', 'x', 'Fixture:a', 'fixture:A', 5, null]) assert.ok(errs(densityRecord({ id: bad as never })).includes('invalid_id'), String(bad));
  assert.ok(errs(densityRecord({ variant: 'nope' })).includes('invalid_id'));
  for (const bad of [0, -1, 1.5, NaN, '1', 1000001]) assert.deepEqual(errs(densityRecord({ version: bad as never })), ['invalid_version'], String(bad));
  for (const bad of ['2000-13-01', '2000-02-30', '2001-02-29', '20000101', '2000-1-1', '', 5]) assert.deepEqual(errs(densityRecord({ updatedAt: bad as never })), ['invalid_version'], String(bad));
  assert.deepEqual(errs(densityRecord({ updatedAt: '2000-02-29' })), []);                                                               // 2000 was a leap year
  assert.deepEqual(errs(densityRecord({ version: 7 })), []);
  assert.deepEqual(errs(densityRecord({ supersedes: 'fixture:rec-density-1' })), ['supersedes_invalid']);                               // not itself
  assert.deepEqual(errs(densityRecord({ supersedes: 'bad' as never })), ['supersedes_invalid']);
});

test('the record points at ITS variant: bulk, film and target records are different records of different variants, nothing falls back', () => {
  const bulk = densityRecord({ id: 'fixture:rec-bulk', variant: 'fixture:synthetic-element-bulk' });
  const target = densityRecord({ id: 'fixture:rec-target', variant: 'fixture:synthetic-compound-target', value: { type: 'scalar', value: 2, unit: 'kg_m3' } });
  assert.notEqual(bulk.variant, target.variant);
  assert.deepEqual(errs(bulk, syntheticElement()), []);
  assert.deepEqual(errs(target, syntheticElement()), ['missing_reference']);                                                            // a variant that is not the one referenced is refused
  assert.deepEqual(errs(bulk, null), []);
});
