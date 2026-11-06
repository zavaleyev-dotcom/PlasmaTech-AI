/** The material property registry: an immutable, validated, in-memory snapshot of a catalog and its property records.
 *
 *  Creation is all-or-nothing. The catalog is validated by the M1.3.1 validators, the records by the M1.3.2 validators AGAINST that catalog (so a thin-film record is
 *  always checked against its film variant - the "no variant given" boundary of `validatePropertyRecord` can never let a film record without thickness or direction in),
 *  and the registry adds its own checks (the data version, supersession forks and cycles). If there is any error, NO registry exists - only a report - so nothing can be
 *  read from damaged or contradictory data and a partially built registry is impossible.
 *
 *  The registry finds records and describes them; it does not judge them. It never creates data or changes a record, never selects among records, never averages,
 *  interpolates or extrapolates, never substitutes one variant, state or temperature for another, and never hands out a ready-to-use `Measured`. */

import { deepFreeze } from '@/physics';
import { checkKeys } from './checks';
import { Collector, isRecord, type ValidationIssue } from './errors';
import { contentFingerprint } from './ids';
import { PROPERTY_DEFINITIONS } from './property-definitions';
import type { PropertyRecord } from './property-types';
import { validatePropertyRecords } from './property-record';
import { validateCatalog } from './catalog';
import { describeValidatedDifferences } from './registry-differences';
import { collectQuery, countNotStatingQueriedConditions, matchQuery } from './registry-query';
import type {
  CoverageEntry, MaterialPropertyRegistry, RecordDifference, RecordMatch, RegistryCreationResult, RegistryInput, RegistryQuery, RegistryQueryResult, RegistrySnapshot,
  RegistryValidationReport, RegistryVersion, TemperatureApplicability,
} from './registry-types';
import type { MaterialVariant } from './types';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const DATA_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function summarize(issues: readonly ValidationIssue[]): RegistryValidationReport {
  const count = (severity: string): number => issues.filter(i => i.severity === severity).length;
  const errors = count('error');
  return Object.freeze({ ok: errors === 0, issues: Object.freeze([...issues]), summary: Object.freeze({ errors, warnings: count('warning'), info: count('info') }) });
}

function fail(c: Collector): RegistryCreationResult {
  return Object.freeze({ ok: false as const, registry: null, report: summarize(c.report().issues) });
}

function caveatsOf(record: PropertyRecord, superseded: boolean): readonly string[] {
  const out: string[] = [];
  const status = record.provenance.status;
  if (record.provenance.verification.status === 'unverified') out.push('запись не сверена с первоисточником');
  if (status === 'model_estimate') out.push('значение — оценка по модели');
  if (status === 'user_input') out.push('значение введено пользователем');
  const u = record.uncertainty;
  if (u.kind === 'unknown') out.push('неопределённость неизвестна');
  else if (u.kind === 'bounds') out.push('заданы только границы, стандартная неопределённость неизвестна');
  else if (u.kind === 'expanded' && u.k === undefined) out.push('расширенная неопределённость без коэффициента охвата');
  if (record.conditions.temperatureRange) out.push('значение заявлено источником для диапазона температур, а не измерено при каждой температуре диапазона');
  if (superseded) out.push('запись заменена более новой');
  return Object.freeze(out);
}

/** Creates the registry from `{ catalog, records, dataVersion }`, or reports why it cannot. Never throws on damaged input. */
export function createMaterialPropertyRegistry(input: unknown): RegistryCreationResult {
  const c = new Collector();
  if (!isRecord(input)) { c.error('registry_invalid', 'registry', 'registry: ожидался объект { catalog, records, dataVersion }.'); return fail(c); }
  checkKeys(input, ['catalog', 'records', 'dataVersion'], 'registry', c, 'registry_invalid');
  if (typeof input.dataVersion !== 'string' || !DATA_VERSION.test(input.dataVersion)) c.error('registry_invalid', 'registry.dataVersion', 'registry.dataVersion: версия набора данных задаётся вызывающим кодом (строка до 64 символов: буквы, цифры, «.», «_», «+», «-»); из времени она не выводится.');

  const seen = new Set<string>();
  const forward = (issues: readonly ValidationIssue[], prefix = ''): void => {
    for (const issue of issues) {
      const path = prefix ? `${prefix}${issue.path}` : issue.path;
      const key = `${issue.severity}|${issue.code}|${path}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (issue.severity === 'error') c.error(issue.code, path, issue.message);
      else if (issue.severity === 'warning') c.warning(issue.code, path, issue.message);
      else c.info(issue.code, path, issue.message);
    }
  };
  forward(validateCatalog(input.catalog).issues, 'catalog.');                          // 1. the whole catalog, by the M1.3.1 validators
  forward(validatePropertyRecords(input.records, input.catalog).issues);              // 2. the records, each against ITS variant, by the M1.3.2 validators

  // 3. the registry's own checks on the replacement history: one replacement per record (no fork) and no cycle (a record cannot descend from itself)
  if (Array.isArray(input.records)) {
    const replacedBy = new Map<string, string[]>();
    const parent = new Map<string, string>();
    for (const r of input.records) if (isRecord(r) && typeof r.id === 'string' && typeof r.supersedes === 'string') { replacedBy.set(r.supersedes, [...(replacedBy.get(r.supersedes) ?? []), r.id]); parent.set(r.id, r.supersedes); }
    for (const [target, replacements] of replacedBy) {
      if (replacements.length > 1) c.error('supersession_fork', `records[${target}]`, `Запись «${target}» заменяется несколькими записями (${replacements.join(', ')}): «актуальная» запись была бы неоднозначной.`);
    }
    for (const start of [...parent.keys()].sort()) {
      const path = [start];
      let node = parent.get(start);
      while (node !== undefined && !path.includes(node) && path.length <= parent.size) { path.push(node); node = parent.get(node); }
      if (node !== undefined && path.includes(node) && node === start) c.error('supersedes_invalid', `records[${start}]`, `Цикл замещения: ${[...path, start].join(' → ')}.`);
    }
  }
  if (c.errorCount > 0) return fail(c);

  // validated: an independent, deep-frozen snapshot (later changes of the input do not reach it)
  const source = input as unknown as RegistryInput;
  const snapshot: RegistrySnapshot = deepFreeze(structuredClone({ catalog: source.catalog, records: source.records }));
  const variants = new Map<string, MaterialVariant>(snapshot.catalog.variants.map(v => [v.id, v]));
  const recordsById = new Map<string, PropertyRecord>(snapshot.records.map(r => [r.id, r]));
  const supersededIds = new Set<string>(snapshot.records.flatMap(r => (r.supersedes ? [r.supersedes] : [])));
  const current = snapshot.records.filter(r => !supersededIds.has(r.id));
  const allDifferences = describeValidatedDifferences(current);
  for (const d of allDifferences) {
    const where = `differences[${d.records.join(' | ')}]`;
    const text = `${d.variant} / ${d.property}: записи «${d.records[0]}» и «${d.records[1]}» — ${d.reasons.join('; ')}.`;
    if (d.category === 'review_required') c.warning('records_differ', where, text);
    else if (d.category === 'different_values' || d.category === 'identical') c.info('records_differ', where, text);
  }
  const report = summarize(c.report().issues);
  const version: RegistryVersion = Object.freeze({
    schemaVersion: 1 as const,
    dataVersion: source.dataVersion,
    variantCount: snapshot.catalog.variants.length,
    recordCount: snapshot.records.length,
    contentFingerprint: contentFingerprint({ identities: [...snapshot.catalog.identities].sort(byId), variants: [...snapshot.catalog.variants].sort(byId), records: [...snapshot.records].sort(byId) }),
  });

  const find = (query: RegistryQuery): RegistryQueryResult => {
    const qc = new Collector();
    collectQuery(query, qc);
    const qr = qc.report();
    if (!qr.ok) return Object.freeze({ status: 'invalid_query' as const, records: Object.freeze([]), matches: Object.freeze([]), count: 0, suitability: 'not_assessed' as const, differences: Object.freeze([]), issues: qr.issues });
    const matches: RecordMatch[] = [];
    for (const r of [...snapshot.records].sort(byId)) {
      const m = matchQuery(r, variants.get(r.variant), query, supersededIds.has(r.id));
      if (!m.matched) continue;
      const temperature: TemperatureApplicability = m.temperature === 'stated_point' ? { kind: 'stated_point', temperature: r.conditions.temperature! }
        : m.temperature === 'declared_range' ? { kind: 'declared_range', range: r.conditions.temperatureRange! } : { kind: 'not_requested' };
      matches.push(Object.freeze({
        record: r, temperature: Object.freeze(temperature), conditions: r.conditions, provenanceStatus: r.provenance.status, verification: r.provenance.verification.status,
        uncertaintyKind: r.uncertainty.kind, superseded: supersededIds.has(r.id), caveats: caveatsOf(r, supersededIds.has(r.id)),
      }));
    }
    const found = matches.map(m => m.record);
    const status = found.length === 0 ? 'not_available' as const : found.length === 1 ? 'unique_record' as const : 'multiple_records' as const;
    let absence: RegistryQueryResult['absence'];
    if (status === 'not_available' && query.variant !== undefined && query.property !== undefined) {
      const ofVariant = current.filter(r => r.variant === query.variant && r.property === query.property);
      absence = Object.freeze({ otherCurrentRecordsOfVariantAndProperty: ofVariant.length, recordsNotStatingQueriedConditions: countNotStatingQueriedConditions(ofVariant, query) });
    }
    return Object.freeze({ status, records: Object.freeze(found), matches: Object.freeze(matches), count: found.length, suitability: 'not_assessed' as const, differences: describeValidatedDifferences(found), ...(absence ? { absence } : {}), issues: qr.issues });
  };

  const registry: MaterialPropertyRegistry = Object.freeze({
    version, snapshot, report,
    getVariant: (id: string): MaterialVariant | undefined => variants.get(id),
    findRecords: find,
    differences: (): readonly RecordDifference[] => allDifferences,
    isSuperseded: (recordId: string): boolean => supersededIds.has(recordId),
    history: (recordId: string): readonly PropertyRecord[] | undefined => {
      let record = recordsById.get(recordId);
      if (!record) return undefined;
      const chain: PropertyRecord[] = [record];
      while (record.supersedes !== undefined && recordsById.has(record.supersedes)) { record = recordsById.get(record.supersedes)!; chain.unshift(record); }
      let newer = snapshot.records.find(r => r.supersedes === chain[chain.length - 1].id);
      while (newer) { chain.push(newer); const tip: PropertyRecord = newer; newer = snapshot.records.find(r => r.supersedes === tip.id); }
      return Object.freeze(chain);
    },
    coverage: (variantId: string): readonly CoverageEntry[] | undefined => (variants.has(variantId)
      ? Object.freeze(PROPERTY_DEFINITIONS.map(d => Object.freeze({ property: d.id, currentRecords: current.filter((r: PropertyRecord) => r.variant === variantId && r.property === d.id).length })))
      : undefined),
  });
  return Object.freeze({ ok: true as const, registry, report });
}
