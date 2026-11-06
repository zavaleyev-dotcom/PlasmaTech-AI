/** Search of property SERIES in the registry (M1.3.4, step 4): validation of a series query and exact matching. Every filter is exact and combined with AND; nothing is
 *  chosen, ranked, interpolated, averaged or evaluated, and no tolerance is applied to a temperature (there is no temperature filter). A series is returned as it was stored. */

import { checkKeys } from './checks';
import { Collector, isRecord } from './errors';
import { isMaterialId } from './ids';
import { getPropertyDefinition } from './property-definitions';
import { IDENTIFIER_TYPES, SOURCE_TYPES, VALUE_STATUSES, VERIFICATION_STATUSES, type PropertyProvenance } from './property-types';
import { normalizedIdentifier } from './registry-query';
import type { SeriesQuery } from './registry-types';
import { SERIES_KINDS, type PropertySeries } from './series-types';

const QUERY_KEYS = ['materialId', 'variant', 'property', 'seriesKind', 'seriesId', 'version', 'status', 'sourceType', 'sourceIdentifier', 'verification', 'includeSuperseded', 'page'] as const;
export const MAX_PAGE_LIMIT = 10000;

const checkEnum = (value: unknown, allowed: readonly string[], path: string, c: Collector): void => {
  if (value !== undefined && !allowed.includes(value as string)) c.error('invalid_query', path, `${path}: допустимо одно из: ${allowed.join(', ')}.`);
};

/** The problems of a series query (an empty query is valid: it matches every current series). */
export function collectSeriesQuery(query: unknown, c: Collector, path = 'query'): void {
  if (!isRecord(query)) { c.error('invalid_query', path, `${path}: ожидался объект запроса.`); return; }
  checkKeys(query, QUERY_KEYS, path, c, 'invalid_query');
  for (const key of ['materialId', 'variant', 'seriesId'] as const) if (query[key] !== undefined && !isMaterialId(query[key])) c.error('invalid_query', `${path}.${key}`, `${path}.${key}: ожидался точный идентификатор вида <ref|user|fixture>:<слаг>.`);
  if (query.property !== undefined && !getPropertyDefinition(query.property)) c.error('unknown_property', `${path}.property`, `${path}.property: свойство «${String(query.property)}» не определено.`);
  checkEnum(query.seriesKind, SERIES_KINDS, `${path}.seriesKind`, c);
  checkEnum(query.status, VALUE_STATUSES, `${path}.status`, c);
  checkEnum(query.sourceType, SOURCE_TYPES, `${path}.sourceType`, c);
  checkEnum(query.verification, VERIFICATION_STATUSES, `${path}.verification`, c);
  if (query.version !== undefined && (typeof query.version !== 'number' || !Number.isInteger(query.version) || query.version < 1)) c.error('invalid_query', `${path}.version`, `${path}.version: версия — целое число от 1.`);
  if (query.includeSuperseded !== undefined && typeof query.includeSuperseded !== 'boolean') c.error('invalid_query', `${path}.includeSuperseded`, `${path}.includeSuperseded: ожидалось true или false.`);
  if (query.sourceIdentifier !== undefined) {
    const p = `${path}.sourceIdentifier`; const id = query.sourceIdentifier;
    if (!isRecord(id)) c.error('invalid_query', p, `${p}: ожидался объект { type, value }.`);
    else {
      checkKeys(id, ['type', 'value'], p, c, 'invalid_query');
      if (!(IDENTIFIER_TYPES as readonly string[]).includes(id.type as string)) c.error('invalid_query', `${p}.type`, `${p}.type: допустимо одно из: ${IDENTIFIER_TYPES.join(', ')}.`);
      if (typeof id.value !== 'string' || id.value.trim() === '') c.error('invalid_query', `${p}.value`, `${p}.value: ожидалась непустая строка.`);
    }
  }
  if (query.page !== undefined) {
    const p = `${path}.page`; const page = query.page;
    if (!isRecord(page)) c.error('invalid_query', p, `${p}: ожидался объект { offset, limit }.`);
    else {
      checkKeys(page, ['offset', 'limit'], p, c, 'invalid_query');
      if (typeof page.offset !== 'number' || !Number.isInteger(page.offset) || page.offset < 0) c.error('invalid_query', `${p}.offset`, `${p}.offset: целое число от 0.`);
      if (typeof page.limit !== 'number' || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE_LIMIT) c.error('invalid_query', `${p}.limit`, `${p}.limit: целое число от 1 до ${MAX_PAGE_LIMIT}.`);
    }
  }
}

/** The PRIMARY provenance of the physical values of a series - and nothing else. A point or an analytic series has one; a table in `single_source` mode has the one of the
 *  table; a table in `per_row` mode has one per row. The compilation of a table, the sources of the segments and of the coefficients (locators), the correlation, the
 *  applicability and the source of an interpolation statement are NOT provenance of the values and are never searched. */
export function primaryProvenance(series: PropertySeries): readonly PropertyProvenance[] {
  if (series.kind === 'table') return series.tableProvenance.mode === 'single_source' ? [series.tableProvenance.provenance] : series.rows.flatMap(r => (r.provenance ? [r.provenance] : []));
  return [series.provenance];
}

/** Does ONE provenance satisfy every provenance filter of the query? (For a per_row table the filters must hold for the same row.) */
function satisfies(p: PropertyProvenance, query: SeriesQuery): boolean {
  if (query.status !== undefined && p.status !== query.status) return false;
  if (query.verification !== undefined && p.verification.status !== query.verification) return false;
  if (query.sourceType !== undefined && p.source.type !== query.sourceType) return false;
  if (query.sourceIdentifier !== undefined) {
    const wanted = normalizedIdentifier(query.sourceIdentifier.type, query.sourceIdentifier.value);
    if (!(p.source.identifiers ?? []).some(i => i.type === query.sourceIdentifier!.type && normalizedIdentifier(i.type, i.value) === wanted)) return false;
  }
  return true;
}

const provenanceFiltered = (q: SeriesQuery): boolean => q.status !== undefined || q.verification !== undefined || q.sourceType !== undefined || q.sourceIdentifier !== undefined;

/** Whether the series satisfies the query. `identityOf`: the material identity of the series' variant. The query must be valid (collectSeriesQuery). */
export function matchSeries(series: PropertySeries, identityOf: string | undefined, query: SeriesQuery, superseded: boolean): boolean {
  if (query.includeSuperseded !== true && superseded) return false;
  if (query.seriesId !== undefined && series.id !== query.seriesId) return false;
  if (query.variant !== undefined && series.variant !== query.variant) return false;
  if (query.materialId !== undefined && identityOf !== query.materialId) return false;
  if (query.property !== undefined && series.property !== query.property) return false;
  if (query.seriesKind !== undefined && series.kind !== query.seriesKind) return false;
  if (query.version !== undefined && series.version !== query.version) return false;
  if (provenanceFiltered(query) && !primaryProvenance(series).some(p => satisfies(p, query))) return false;
  return true;
}
