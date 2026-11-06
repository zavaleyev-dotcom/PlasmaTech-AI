/** Validation and matching of registry queries. Every filter is EXACT; a filter on a condition never matches a record that does not state that condition (nothing is
 *  assumed); a query that is malformed or names an unknown property is refused with diagnostics, never "interpreted". */

import { exact, toSiRational } from '@/physics';
import { normalizeDoi, safeUrl } from '@/services/scientific-search/normalization';
import { checkKeys, checkQuantity, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { isMaterialId } from './ids';
import { getPropertyDefinition } from './property-definitions';
import { DIRECTIONS, EXPANSION_DEFINITIONS, HEAT_CAPACITY_MODES, IDENTIFIER_TYPES, SOURCE_TYPES, VALUE_STATUSES, VERIFICATION_STATUSES, type PropertyRecord } from './property-types';
import { AGGREGATE_STATES, MATERIAL_FORM_KINDS, type MaterialVariant } from './types';
import type { RegistryQuery } from './registry-types';

const QUERY_KEYS = ['variant', 'property', 'formKind', 'status', 'verification', 'sourceType', 'sourceIdentifier', 'version', 'conditions', 'includeSuperseded'] as const;
const CONDITION_FILTER_KEYS = ['temperature', 'pressure', 'referenceTemperature', 'thickness', 'direction', 'expansionDefinition', 'heatCapacityMode', 'materialState', 'atmosphere'] as const;

function checkEnum(value: unknown, allowed: readonly string[], path: string, c: Collector): void {
  if (value !== undefined && !allowed.includes(value as string)) c.error('invalid_query', path, `${path}: допустимо одно из: ${allowed.join(', ')}.`);
}

/** Collects the problems of a query (an empty query is valid: it matches every current record). */
export function collectQuery(query: unknown, c: Collector, path = 'query'): void {
  if (!isRecord(query)) { c.error('invalid_query', path, `${path}: ожидался объект запроса.`); return; }
  checkKeys(query, QUERY_KEYS, path, c, 'invalid_query');
  if (query.variant !== undefined && !isMaterialId(query.variant)) c.error('invalid_query', `${path}.variant`, `${path}.variant: ожидался точный идентификатор варианта материала.`);
  if (query.property !== undefined && !getPropertyDefinition(query.property)) c.error('unknown_property', `${path}.property`, `${path}.property: свойство «${String(query.property)}» не определено.`);
  checkEnum(query.formKind, MATERIAL_FORM_KINDS, `${path}.formKind`, c);
  checkEnum(query.status, VALUE_STATUSES, `${path}.status`, c);
  checkEnum(query.verification, VERIFICATION_STATUSES, `${path}.verification`, c);
  checkEnum(query.sourceType, SOURCE_TYPES, `${path}.sourceType`, c);
  if (query.version !== undefined && (typeof query.version !== 'number' || !Number.isInteger(query.version) || query.version < 1)) c.error('invalid_query', `${path}.version`, `${path}.version: версия — целое число от 1.`);
  if (query.includeSuperseded !== undefined && typeof query.includeSuperseded !== 'boolean') c.error('invalid_query', `${path}.includeSuperseded`, `${path}.includeSuperseded: ожидалось true или false.`);
  if (query.sourceIdentifier !== undefined) {
    const p = `${path}.sourceIdentifier`;
    const id = query.sourceIdentifier;
    if (!isRecord(id)) c.error('invalid_query', p, `${p}: ожидался объект { type, value }.`);
    else {
      checkKeys(id, ['type', 'value'], p, c, 'invalid_query');
      checkEnum(id.type, IDENTIFIER_TYPES, `${p}.type`, c);
      if (id.type === undefined) c.error('invalid_query', `${p}.type`, `${p}.type: обязательно.`);
      if (!isNonEmptyString(id.value)) c.error('invalid_query', `${p}.value`, `${p}.value: ожидалась непустая строка.`);
    }
  }
  if (query.conditions !== undefined) {
    const p = `${path}.conditions`;
    const f = query.conditions;
    if (!isRecord(f)) c.error('invalid_query', p, `${p}: ожидался объект фильтра условий.`);
    else {
      checkKeys(f, CONDITION_FILTER_KEYS, p, c, 'invalid_query');
      if (f.temperature !== undefined) checkQuantity(f.temperature, 'temperature', `${p}.temperature`, c);
      if (f.referenceTemperature !== undefined) checkQuantity(f.referenceTemperature, 'temperature', `${p}.referenceTemperature`, c);
      if (f.pressure !== undefined) checkQuantity(f.pressure, 'pressure', `${p}.pressure`, c);
      if (f.thickness !== undefined) checkQuantity(f.thickness, 'length', `${p}.thickness`, c, 'positive');
      checkEnum(f.direction, DIRECTIONS, `${p}.direction`, c);
      checkEnum(f.expansionDefinition, EXPANSION_DEFINITIONS, `${p}.expansionDefinition`, c);
      checkEnum(f.heatCapacityMode, HEAT_CAPACITY_MODES, `${p}.heatCapacityMode`, c);
      checkEnum(f.materialState, AGGREGATE_STATES, `${p}.materialState`, c);
      if (f.atmosphere !== undefined && !isNonEmptyString(f.atmosphere)) c.error('invalid_query', `${p}.atmosphere`, `${p}.atmosphere: ожидалась непустая строка.`);
    }
  }
}

/** Identifiers are compared after normalisation: DOI case-insensitively (and in URL form), ISBN without separators, URL as the parsed href, others trimmed and lower-cased. */
export function normalizedIdentifier(type: string, value: string): string {
  switch (type) {
    case 'doi': return normalizeDoi(value) ?? value.trim().toLowerCase();
    case 'isbn': return value.replace(/[\s-]/g, '').toUpperCase();
    case 'url': return safeUrl(value) ?? value.trim();
    default: return value.trim().toLowerCase();
  }
}

type Q = { value: number; unit: string };
const si = (q: Q) => toSiRational(q.value, q.unit as never);

type TemperatureMatch = 'not_requested' | 'stated_point' | 'declared_range' | 'no';

/** How the record relates to a requested temperature: the exact stated point, the range the record itself declares, or not at all (also when the record states no
 *  temperature: nothing is assumed). Nothing is interpolated and the range is not widened. */
function temperatureMatch(record: PropertyRecord, wanted: Q | undefined): TemperatureMatch {
  if (wanted === undefined) return 'not_requested';
  const c = record.conditions;
  const t = si(wanted);
  if (c.temperature) return exact.equals(si(c.temperature as unknown as Q), t) ? 'stated_point' : 'no';
  if (c.temperatureRange) return exact.compare(si(c.temperatureRange.min as unknown as Q), t) <= 0 && exact.compare(t, si(c.temperatureRange.max as unknown as Q)) <= 0 ? 'declared_range' : 'no';
  return 'no';
}

/** Whether the record (of the given variant) satisfies the query, and how its temperature applies. The query must be valid (collectQuery). */
export function matchQuery(record: PropertyRecord, variant: MaterialVariant | undefined, query: RegistryQuery, isSuperseded: boolean): { matched: boolean; temperature: Exclude<TemperatureMatch, 'no'> } {
  const no = { matched: false, temperature: 'not_requested' as const };
  if (query.includeSuperseded !== true && isSuperseded) return no;
  if (query.variant !== undefined && record.variant !== query.variant) return no;
  if (query.property !== undefined && record.property !== query.property) return no;
  if (query.formKind !== undefined && variant?.form.kind !== query.formKind) return no;
  if (query.status !== undefined && record.provenance.status !== query.status) return no;
  if (query.verification !== undefined && record.provenance.verification.status !== query.verification) return no;
  if (query.sourceType !== undefined && record.provenance.source.type !== query.sourceType) return no;
  if (query.version !== undefined && record.version !== query.version) return no;
  if (query.sourceIdentifier !== undefined) {
    const wanted = normalizedIdentifier(query.sourceIdentifier.type, query.sourceIdentifier.value);
    if (!(record.provenance.source.identifiers ?? []).some(i => i.type === query.sourceIdentifier!.type && normalizedIdentifier(i.type, i.value) === wanted)) return no;
  }
  const f = query.conditions;
  let temperature: Exclude<TemperatureMatch, 'no'> = 'not_requested';
  if (f) {
    const c = record.conditions;
    const t = temperatureMatch(record, f.temperature as unknown as Q | undefined);
    if (t === 'no') return no;
    temperature = t;
    for (const key of ['pressure', 'referenceTemperature', 'thickness'] as const) {
      const wanted = f[key];
      const stated = c[key];
      if (wanted !== undefined && (stated === undefined || !exact.equals(si(wanted as unknown as Q), si(stated as unknown as Q)))) return no;
    }
    for (const key of ['direction', 'expansionDefinition', 'heatCapacityMode', 'materialState', 'atmosphere'] as const) {
      if (f[key] !== undefined && c[key] !== f[key]) return no;
    }
  }
  return { matched: true, temperature };
}

/** How many of the given records do NOT state a condition the query filters on (so their applicability cannot be judged). */
export function countNotStatingQueriedConditions(records: readonly PropertyRecord[], query: RegistryQuery): number {
  const f = query.conditions;
  if (!f) return 0;
  const keys = (Object.keys(f) as (keyof typeof f)[]).filter(k => f[k] !== undefined);
  return records.filter(r => keys.some(k => (k === 'temperature' ? r.conditions.temperature === undefined && r.conditions.temperatureRange === undefined : (r.conditions as unknown as Record<string, unknown>)[k] === undefined))).length;
}
