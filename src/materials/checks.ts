/** Small shared checks used by the validators: strings, sources, physical quantities. */

import { assertPhysicallyValid, convert, getUnit, PhysicsError, QUANTITY_KINDS, type QuantityKind, type UnitId } from '@/physics';
import { normalizeDoi } from '@/services/scientific-search/normalization';
import { Collector, isRecord } from './errors';

export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A statement's source: a non-empty citation, a DOI of valid syntax if given (no network lookup), a locator if given. */
export function checkSource(source: unknown, path: string, c: Collector): boolean {
  if (!isRecord(source) || !isNonEmptyString(source.citation)) {
    c.error('invalid_source', path, `${path}: источник должен быть объектом с непустой ссылкой (citation).`);
    return false;
  }
  let ok = true;
  const before = c.errorCount;
  checkKeys(source, ['citation', 'doi', 'locator'], path, c, 'invalid_source');
  if (c.errorCount > before) ok = false;
  if (source.doi !== undefined && (typeof source.doi !== 'string' || normalizeDoi(source.doi) === null)) { c.error('invalid_source', `${path}.doi`, `${path}.doi: некорректный DOI.`); ok = false; }
  if (source.locator !== undefined && !isNonEmptyString(source.locator)) { c.error('invalid_source', `${path}.locator`, `${path}.locator: ожидается непустая строка.`); ok = false; }
  return ok;
}

/** A quantity of the given kind: the unit exists and is of that kind, the value is finite and physically possible, and (optionally) positive / non-negative.
 *  Returns the value in the SI unit of the kind, or null (with an issue) when invalid. */
export function checkQuantity(q: unknown, kind: QuantityKind, path: string, c: Collector, rule: 'positive' | 'nonnegative' | 'any' = 'any'): number | null {
  if (!isRecord(q) || typeof q.value !== 'number' || typeof q.unit !== 'string') {
    c.error('invalid_quantity', path, `${path}: ожидалась величина вида { value, unit }.`);
    return null;
  }
  const unknownBefore = c.errorCount;
  checkKeys(q, ['value', 'unit'], path, c, 'invalid_quantity');
  if (c.errorCount > unknownBefore) return null;
  try {
    const spec = getUnit(q.unit);
    if (spec.kind !== kind) { c.error('invalid_quantity', path, `${path}: единица ${spec.symbol} не относится к величине «${QUANTITY_KINDS[kind].nameRu}».`); return null; }
    assertPhysicallyValid(q.value, spec.id);
    const si = convert(q.value, spec.id, QUANTITY_KINDS[kind].siUnit as UnitId);
    if (rule === 'positive' && !(si > 0)) { c.error('invalid_quantity', path, `${path}: значение должно быть больше 0.`); return null; }
    if (rule === 'nonnegative' && si < 0) { c.error('invalid_quantity', path, `${path}: значение не может быть отрицательным.`); return null; }
    return si;
  } catch (error) {
    if (error instanceof PhysicsError) { c.error('invalid_quantity', path, `${path}: ${error.message}`); return null; }
    throw error;
  }
}

/** Unknown keys are an error: a misspelt or smuggled-in field (for example a property value) is never silently ignored. */
export function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, c: Collector, code: 'invalid_composition' | 'invalid_phase' | 'invalid_structure' | 'invalid_form' | 'invalid_layer' | 'invalid_stack' | 'invalid_material' | 'invalid_interface' | 'invalid_period' | 'invalid_source' | 'invalid_quantity'): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) c.error(code, `${path}.${key}`, `${path}: неизвестное поле «${key}» (допустимо: ${allowed.join(', ')}).`);
}
