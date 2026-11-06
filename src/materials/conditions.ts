/** Validation of the conditions of a value against the definition of its property (and, if the variant is known, against the variant). A value is not applicable
 *  outside the conditions it states: there is no default and no "typical" condition, a missing required condition is an error, and a condition that does not apply to
 *  the property is refused rather than kept. Temperatures are ABSOLUTE temperatures: an interval (K_delta) is refused by the kind check. */

import { convert, PhysicsError } from '@/physics';
import { checkKeys, checkQuantity, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { AGGREGATE_STATES } from './types';
import { CONDITION_KEYS, DIRECTIONS, EXPANSION_DEFINITIONS, HEAT_CAPACITY_MODES, type ConditionKey, type PropertyDefinition } from './property-types';

const FILM_FORMS: readonly string[] = ['thin_film', 'coating_layer'];

/** A temperature quantity in kelvin, or null if it cannot be converted (the quantity validators report that). */
function kelvin(q: unknown): number | null {
  if (!isRecord(q) || typeof q.value !== 'number' || typeof q.unit !== 'string') return null;
  try { return convert(q.value, q.unit as never, 'K'); } catch (error) { if (error instanceof PhysicsError) return null; throw error; }
}

const isPresent = (conditions: Record<string, unknown>, key: ConditionKey): boolean => conditions[key] !== undefined;
const satisfied = (conditions: Record<string, unknown>, key: ConditionKey): boolean => (key === 'temperature' ? isPresent(conditions, 'temperature') || isPresent(conditions, 'temperatureRange') : isPresent(conditions, key));

export function collectConditions(definition: PropertyDefinition, conditions: unknown, variant: unknown, path: string, c: Collector): void {
  if (!isRecord(conditions)) { c.error('invalid_condition', path, `${path}: ожидался объект условий (пустой { } допустим только если свойство не требует условий).`); return; }
  checkKeys(conditions, CONDITION_KEYS, path, c, 'invalid_condition');

  // shapes of the individual conditions
  if (conditions.temperature !== undefined) checkQuantity(conditions.temperature, 'temperature', `${path}.temperature`, c);
  if (conditions.temperatureRange !== undefined) {
    const p = `${path}.temperatureRange`;
    if (conditions.temperature !== undefined) c.error('invalid_condition', p, `${p}: температура задаётся либо точкой (temperature), либо диапазоном (temperatureRange), не обоими.`);
    if (!isRecord(conditions.temperatureRange)) c.error('invalid_condition', p, `${p}: ожидался объект { min, max }.`);
    else {
      checkKeys(conditions.temperatureRange, ['min', 'max'], p, c, 'invalid_condition');
      const lo = checkQuantity(conditions.temperatureRange.min, 'temperature', `${p}.min`, c);
      const hi = checkQuantity(conditions.temperatureRange.max, 'temperature', `${p}.max`, c);
      if (lo !== null && hi !== null && !(lo < hi)) c.error('invalid_condition', p, `${p}: нижняя граница должна быть меньше верхней.`);
    }
  }
  if (conditions.pressure !== undefined) checkQuantity(conditions.pressure, 'pressure', `${path}.pressure`, c);
  if (conditions.referenceTemperature !== undefined) checkQuantity(conditions.referenceTemperature, 'temperature', `${path}.referenceTemperature`, c);
  if (conditions.thickness !== undefined) checkQuantity(conditions.thickness, 'length', `${path}.thickness`, c, 'positive');
  for (const key of ['atmosphere', 'measurementMethod', 'context'] as const) if (conditions[key] !== undefined && !isNonEmptyString(conditions[key])) c.error('invalid_condition', `${path}.${key}`, `${path}.${key}: ожидалась непустая строка.`);
  const enums: [ConditionKey, readonly string[]][] = [['direction', DIRECTIONS], ['expansionDefinition', EXPANSION_DEFINITIONS], ['heatCapacityMode', HEAT_CAPACITY_MODES], ['materialState', AGGREGATE_STATES]];
  for (const [key, allowed] of enums) if (conditions[key] !== undefined && !allowed.includes(conditions[key] as string)) c.error('invalid_condition', `${path}.${key}`, `${path}.${key}: допустимо одно из: ${allowed.join(', ')}.`);

  // which conditions the property may state at all
  for (const key of CONDITION_KEYS) if (isPresent(conditions, key) && !definition.allowedConditions.includes(key)) c.error('condition_not_allowed', `${path}.${key}`, `${path}.${key}: условие не применимо к свойству «${definition.nameRu}» (допустимы: ${definition.allowedConditions.join(', ') || 'только context'}).`);

  // which it must state
  const missing = (key: ConditionKey, why: string): void => c.error('missing_condition', `${path}.${key}`, `${path}.${key}: ${why}`);
  for (const key of definition.requiredConditions) if (!satisfied(conditions, key)) missing(key, `для свойства «${definition.nameRu}» условие обязательно${key === 'temperature' ? ' (температура или диапазон температур)' : ''}.`);
  for (const rule of definition.conditionalRules ?? []) {
    if (conditions[rule.when.key] !== rule.when.equals) continue;
    for (const key of rule.require ?? []) if (!satisfied(conditions, key)) missing(key, `при ${rule.when.key} = «${rule.when.equals}» условие обязательно.`);
    for (const key of rule.forbid ?? []) if (isPresent(conditions, key)) c.error('condition_not_allowed', `${path}.${key}`, `${path}.${key}: при ${rule.when.key} = «${rule.when.equals}» условие недопустимо.`);
  }
  // a mean coefficient is averaged over an INTERVAL: the reference temperature must differ from the temperature
  if (conditions.expansionDefinition === 'mean') {
    const t = kelvin(conditions.temperature);
    const t0 = kelvin(conditions.referenceTemperature);
    if (t !== null && t0 !== null && t === t0) c.error('invalid_condition', `${path}.referenceTemperature`, `${path}.referenceTemperature: средний коэффициент усредняется по интервалу — опорная температура должна отличаться от температуры.`);
  }

  // against the variant (when it is known): a film is not a bulk piece
  if (isRecord(variant)) {
    const form = isRecord(variant.form) ? variant.form.kind : undefined;
    if (typeof form === 'string' && FILM_FORMS.includes(form)) {
      for (const key of definition.filmRequiredConditions ?? []) if (!satisfied(conditions, key)) missing(key, `вариант — ${form}: для свойства «${definition.nameRu}» тонкой плёнки условие обязательно (значение плёнки зависит от толщины и направления и не равно значению массивного материала).`);
    }
    const phase = isRecord(variant.phase) ? variant.phase : undefined;
    if (phase && conditions.materialState !== undefined && typeof phase.state === 'string' && conditions.materialState !== phase.state) {
      c.error('condition_state_mismatch', `${path}.materialState`, `${path}.materialState: значение получено в состоянии «${String(conditions.materialState)}», а фаза варианта — «${phase.state}»: это запись о другом варианте.`);
    }
    if (phase && isRecord(phase.stableRange)) {
      const lo = kelvin(phase.stableRange.min);
      const hi = kelvin(phase.stableRange.max);
      const points = [kelvin(conditions.temperature), ...(isRecord(conditions.temperatureRange) ? [kelvin(conditions.temperatureRange.min), kelvin(conditions.temperatureRange.max)] : [])].filter((x): x is number => x !== null);
      if (lo !== null && hi !== null && points.some(t => t < lo || t > hi)) c.warning('condition_outside_phase_range', `${path}.temperature`, `${path}: температура условий вне области стабильности фазы варианта [${lo}; ${hi}] K.`);
    }
  }
}
