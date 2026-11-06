import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePropertyRecord, getPropertyDefinition, type PropertyRecord } from '../src/materials';
import { syntheticElement, syntheticCompound, syntheticTarget, syntheticSystemCatalog } from './materials-fixtures';
import { densityRecord, conductivityRecord, syntheticProvenance } from './materials-property-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
const errs = (r: unknown, variant?: unknown) => validatePropertyRecord(r, variant).issues.filter(i => i.severity === 'error').map((i): string => i.code);
const warns = (r: unknown, variant?: unknown) => validatePropertyRecord(r, variant).issues.filter(i => i.severity === 'warning').map((i): string => i.code);
const record = (property: string, unit: string, conditions: unknown, over: Record<string, unknown> = {}): PropertyRecord => ({
  id: 'fixture:rec-x', variant: 'fixture:synthetic-element-bulk', property, value: { type: 'scalar', value: 1, unit }, uncertainty: { kind: 'unknown' }, conditions,
  provenance: syntheticProvenance(), version: 1, updatedAt: '2000-01-01', ...over,
}) as PropertyRecord;

test('required conditions are required: a missing one is an error, nothing is defaulted', () => {
  assert.deepEqual(errs(densityRecord({ conditions: {} })), ['missing_condition']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K') } })), []);
  assert.deepEqual(errs(densityRecord({ conditions: { temperatureRange: { min: q(300, 'K'), max: q(400, 'K') } } })), []);   // a range satisfies "temperature"
  assert.deepEqual(errs(densityRecord({ conditions: { pressure: q(1, 'Pa') } })), ['missing_condition']);
  assert.deepEqual(errs(densityRecord({ conditions: undefined as never })), ['invalid_condition']);
  assert.deepEqual(errs(densityRecord({ conditions: null as never })), ['invalid_condition']);
  assert.deepEqual(errs(record('molar_mass', 'kg_mol', {})), []);                                                         // an intrinsic property with no required condition
  assert.deepEqual(errs(record('specific_heat_capacity', 'J_kgK', { temperature: q(300, 'K') })), ['missing_condition']);   // cp or cv?
  assert.deepEqual(errs(record('specific_heat_capacity', 'J_kgK', { temperature: q(300, 'K'), heatCapacityMode: 'isobaric' })), []);
  assert.deepEqual(errs(record('specific_heat_capacity', 'J_kgK', { temperature: q(300, 'K'), heatCapacityMode: 'adiabatic' })), ['invalid_condition']);
});

test('absolute temperature is not an interval; absolute pressure is not a gauge pressure; physical limits hold', () => {
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(10, 'K_delta') } })), ['invalid_quantity']);              // an interval is not a temperature
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(10, 'degC_delta') } })), ['invalid_quantity']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(-5, 'K') } })), ['invalid_quantity']);                    // below absolute zero
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(-300, 'degC') } })), ['invalid_quantity']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(20, 'degC') } })), []);                                  // an absolute temperature on the Celsius scale is fine
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), pressure: q(1, 'bar') } })), []);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), pressure: q(1, 'bar_g') } })), ['invalid_quantity']);   // gauge pressure
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), pressure: q(-1, 'Pa') } })), ['invalid_quantity']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), temperatureRange: { min: q(1, 'K'), max: q(2, 'K') } } })), ['invalid_condition']);   // a point OR a range
  assert.deepEqual(errs(densityRecord({ conditions: { temperatureRange: { min: q(400, 'K'), max: q(300, 'K') } } })), ['invalid_condition']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperatureRange: { min: q(300, 'K'), max: q(300, 'K') } } })), ['invalid_condition']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperatureRange: { min: q(300, 'K_delta'), max: q(400, 'K') } } })), ['invalid_quantity']);
});

test('a condition that does not apply to the property is refused, not kept', () => {
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), direction: 'in_plane' } })), ['condition_not_allowed']);   // density has no direction
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), heatCapacityMode: 'isobaric' } })), ['condition_not_allowed']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), expansionDefinition: 'mean' } })), ['condition_not_allowed']);
  assert.deepEqual(errs(record('molar_mass', 'kg_mol', { temperature: q(300, 'K') })), ['condition_not_allowed']);                    // molar mass is not a function of T
  assert.deepEqual(errs(record('bulk_modulus', 'GPa_mod', { temperature: q(300, 'K'), direction: 'in_plane' })), ['condition_not_allowed']);
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), unheardOf: 1 } as never })), ['invalid_condition']);   // an unknown condition
});

test('expansion coefficient: tangent and mean are different statements; the reference temperature belongs to the mean one only', () => {
  const alpha = (conditions: unknown) => record('linear_expansion_coefficient', 'ppm_K', conditions);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'tangent', temperature: q(300, 'K') })), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(500, 'K'), referenceTemperature: q(300, 'K') })), []);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(100, 'K'), referenceTemperature: q(300, 'K') })), []);   // averaged downwards, still an interval
  assert.deepEqual(errs(alpha({ temperature: q(300, 'K') })), ['missing_condition']);                                                // which coefficient is this? not guessed
  assert.ok(errs(alpha({})).includes('missing_condition'));
  assert.deepEqual(errs(alpha({ expansionDefinition: 'tangent' })), ['missing_condition']);                                          // the temperature of the derivative
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(500, 'K') })), ['missing_condition']);                  // no reference temperature
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', referenceTemperature: q(300, 'K') })), ['missing_condition']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'tangent', temperature: q(300, 'K'), referenceTemperature: q(200, 'K') })), ['condition_not_allowed']);
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(300, 'K'), referenceTemperature: q(300, 'K') })), ['invalid_condition']);   // the same temperature: no interval
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(26.85, 'degC'), referenceTemperature: q(300, 'K') })), ['invalid_condition']);  // the same, across scales
  assert.deepEqual(errs(alpha({ expansionDefinition: 'mean', temperature: q(500, 'K'), referenceTemperature: q(10, 'K_delta') })), ['invalid_quantity']);   // an interval is not a temperature
  assert.ok(errs(alpha({ expansionDefinition: 'mean', temperatureRange: { min: q(300, 'K'), max: q(500, 'K') } })).includes('condition_not_allowed'));
  assert.ok(getPropertyDefinition('linear_expansion_coefficient')!.definitionRu.includes('Касательный'));
});

test('bulk, thin film and sputtering target are not equivalent: a film needs its thickness and direction, a bulk piece does not', () => {
  const k = (conditions: unknown, variant: string) => conductivityRecord({ variant, conditions: conditions as never });
  const bulk = syntheticElement();
  const film = syntheticCompound();                                                                                     // fixture:synthetic-compound-film (a thin film)
  const target = syntheticTarget();                                                                                     // a sputtering target
  assert.deepEqual(errs(k({ temperature: q(300, 'K') }, bulk.id), bulk), []);                                           // bulk: temperature is enough
  assert.deepEqual(errs(k({ temperature: q(300, 'K') }, target.id), target), []);                                       // a target is a bulk-like piece
  assert.deepEqual(errs(k({ temperature: q(300, 'K') }, film.id), film), ['missing_condition', 'missing_condition']);  // a film: thickness AND direction
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), thickness: q(100, 'nm') }, film.id), film), ['missing_condition']);
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'in_plane' }, film.id), film), []);
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), thickness: q(100, 'nm'), direction: 'cross_plane' }, film.id), film), []);
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), thickness: q(0, 'nm'), direction: 'in_plane' }, film.id), film), ['invalid_quantity']);
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), direction: 'sideways' }, bulk.id), bulk), ['invalid_condition']);
  // the resistivity / conductivity / diffusivity of a film likewise; the density of a film does not need them
  for (const [property, unit] of [['electrical_resistivity', 'Ohm_m'], ['electrical_conductivity', 'S_m'], ['thermal_diffusivity', 'm2_s']] as const) {
    assert.deepEqual(errs(record(property, unit, { temperature: q(300, 'K') }, { variant: film.id }), film), ['missing_condition', 'missing_condition'], property);
    assert.deepEqual(errs(record(property, unit, { temperature: q(300, 'K') }, { variant: bulk.id }), bulk), [], property);
  }
  assert.deepEqual(errs(densityRecord({ variant: film.id }), film), []);
  // a coating system (a coating_layer) is a film too
  const system = syntheticSystemCatalog().variants.find(v => v.id === 'fixture:synthetic-system-film')!;
  assert.deepEqual(errs(k({ temperature: q(300, 'K') }, system.id), system), ['missing_condition', 'missing_condition']);
  // without the variant the film requirement cannot be checked - it is not silently assumed to hold
  assert.deepEqual(errs(k({ temperature: q(300, 'K') }, film.id)), []);
});

test('state of the material and the temperature range of its phase', () => {
  const bulk = syntheticElement();
  const k = (conditions: unknown) => conductivityRecord({ conditions: conditions as never });
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), materialState: 'solid' }), bulk), []);
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), materialState: 'liquid' }), bulk), ['condition_state_mismatch']);               // a liquid is another variant
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), materialState: 'plasma' })), []);                                                // no variant: not checked
  assert.deepEqual(errs(k({ temperature: q(300, 'K'), materialState: 'foam' })), ['invalid_condition']);
  const bounded = { ...bulk, phase: { state: 'solid', order: 'crystalline', stableRange: { min: q(200, 'K'), max: q(400, 'K') } } };
  assert.deepEqual(warns(k({ temperature: q(300, 'K') }), bounded), []);
  assert.ok(warns(k({ temperature: q(500, 'K') }), bounded).includes('condition_outside_phase_range'));
  assert.ok(warns(k({ temperatureRange: { min: q(300, 'K'), max: q(500, 'K') } }), bounded).includes('condition_outside_phase_range'));
  assert.deepEqual(errs(k({ temperature: q(500, 'K') }), bounded), []);                                                                // a warning, not an error
});

test('other condition fields: atmosphere, method, context are non-empty text; unit kinds are enforced', () => {
  for (const key of ['atmosphere', 'measurementMethod', 'context'] as const) {
    assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), [key]: 'СИНТЕТИЧЕСКОЕ' } as never })), [], key);
    assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), [key]: '' } as never })), ['invalid_condition'], key);
    assert.deepEqual(errs(densityRecord({ conditions: { temperature: q(300, 'K'), [key]: 5 } as never })), ['invalid_condition'], key);
  }
  assert.deepEqual(errs(densityRecord({ conditions: { temperature: { value: 300, unit: 'K', extra: 1 } } as never })), ['invalid_quantity']);   // unknown field inside a quantity
});
