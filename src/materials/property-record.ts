/** Validation of property RECORDS: one scalar value of one property of one material variant, with its uncertainty statement, conditions, provenance and version.
 *  The validators return a ValidationReport (they never throw on damaged data); `createPropertyRecord` returns a deep-frozen copy of a valid record.
 *  Nothing here selects, averages, interpolates or looks a value up - that is a later stage, and a record is never "close enough" for another variant. */

import { deepFreeze, type UnitId } from '@/physics';
import { checkKeys, checkQuantity, isIsoDate } from './checks';
import { collectConditions } from './conditions';
import { Collector, isRecord, MaterialsError, type ValidationReport } from './errors';
import { collectVariant } from './variant';
import { MATERIAL_KINDS, type MaterialKind } from './types';
import { contentFingerprint, isMaterialId, parseMaterialId } from './ids';
import { getPropertyDefinition } from './property-definitions';
import { collectUncertainty } from './property-uncertainty';
import { collectProvenance } from './provenance';
import type { PropertyDefinition, PropertyRecord } from './property-types';

const MAX_VERSION = 1000000;
const RESERVED_FORMS: readonly string[] = ['tensor2', 'function'];

/** Validates one record. `variant` is the MaterialVariant the record points at, if the caller has it: with it the conditions are also checked against the variant's
 *  form (a film is not a bulk piece), state and phase range. Without it only the record itself is checked. */
export function collectRecord(record: unknown, variant: unknown, path: string, c: Collector): void {
  if (!isRecord(record)) { c.error('invalid_property', path, `${path}: ожидался объект записи свойства.`); return; }
  checkKeys(record, ['id', 'variant', 'property', 'value', 'uncertainty', 'conditions', 'provenance', 'version', 'updatedAt', 'supersedes'], path, c, 'invalid_property');
  if (!isMaterialId(record.id)) c.error('invalid_id', `${path}.id`, `${path}.id: идентификатор записи — <ref|user|fixture>:<слаг>.`);
  if (!isMaterialId(record.variant)) c.error('invalid_id', `${path}.variant`, `${path}.variant: запись ссылается на вариант материала по идентификатору.`);
  if (isRecord(variant) && typeof record.variant === 'string' && variant.id !== record.variant) c.error('missing_reference', `${path}.variant`, `${path}.variant: переданный вариант («${String(variant.id)}») — не тот, на который ссылается запись («${record.variant}»).`);

  const definition = getPropertyDefinition(record.property);
  if (!definition) c.error('unknown_property', `${path}.property`, `${path}.property: свойство «${String(record.property)}» не определено.`);

  // value
  let valueUnit: { value: number; unit: string } | null = null;
  const vPath = `${path}.value`;
  if (!isRecord(record.value)) c.error('invalid_value', vPath, `${vPath}: ожидался объект { type: 'scalar', value, unit }.`);
  else if (record.value.type !== 'scalar') {
    if (RESERVED_FORMS.includes(record.value.type as string)) c.error('unsupported_value_form', `${vPath}.type`, `${vPath}.type: форма «${String(record.value.type)}» зарезервирована для следующих этапов; сейчас поддерживаются только скалярные значения.`);
    else c.error('invalid_value', `${vPath}.type`, `${vPath}.type: ожидалось «scalar».`);
  } else {
    checkKeys(record.value, ['type', 'value', 'unit'], vPath, c, 'invalid_value');
    if (definition) {
      // the unit must be a unit of the KIND of the property; the value must be finite and physically possible for that kind
      const si = checkQuantity({ value: record.value.value, unit: record.value.unit }, definition.kind, vPath, c);
      if (si !== null) valueUnit = { value: record.value.value as number, unit: record.value.unit as UnitId };
    }
  }

  collectUncertainty(record.uncertainty, valueUnit, definition?.kind ?? null, `${path}.uncertainty`, c);
  if (definition) collectConditions(definition, record.conditions, variant, `${path}.conditions`, c);
  else if (!isRecord(record.conditions)) c.error('invalid_condition', `${path}.conditions`, `${path}.conditions: ожидался объект условий.`);

  const status = collectProvenance(record.provenance, `${path}.provenance`, c);

  // version and date
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1 || record.version > MAX_VERSION) c.error('invalid_version', `${path}.version`, `${path}.version: версия записи — целое число от 1.`);
  if (!isIsoDate(record.updatedAt)) c.error('invalid_version', `${path}.updatedAt`, `${path}.updatedAt: дата актуализации — ГГГГ-ММ-ДД.`);
  if (record.supersedes !== undefined) {
    if (!isMaterialId(record.supersedes)) c.error('supersedes_invalid', `${path}.supersedes`, `${path}.supersedes: идентификатор заменяемой записи некорректен.`);
    else if (record.supersedes === record.id) c.error('supersedes_invalid', `${path}.supersedes`, `${path}.supersedes: запись не может заменять саму себя.`);
  }

  // the namespaces keep the user's data apart from the shipped reference data
  const ns = parseMaterialId(record.id)?.namespace;
  if (ns === 'user' && status !== null && status !== 'user_input') c.error('namespace_mismatch', `${path}.id`, `${path}.id: запись пользователя (user:) должна иметь статус user_input.`);
  if (ns === 'ref' && status === 'user_input') c.error('namespace_mismatch', `${path}.id`, `${path}.id: справочная запись (ref:) не может иметь статус user_input — данные пользователя хранятся отдельно (user:).`);
}

/** The variant a record is checked against must itself be a structurally VALID MaterialVariant (the M1.3.1 validator decides): an object with a string id is not enough,
 *  and a damaged form must never be read as "bulk" and let the film conditions slip through. A damaged variant gives errors (not an exception) and no context. `null` /
 *  `undefined` mean "no variant given". */
function validatedVariantContext(variant: unknown, kind: MaterialKind | null, path: string, c: Collector): Record<string, unknown> | undefined {
  if (variant === undefined || variant === null) return undefined;
  const local = new Collector();
  collectVariant(variant, kind, path, local);
  const report = local.report();
  for (const issue of report.issues) if (issue.severity === 'error') c.error(issue.code, issue.path, issue.message);
  if (!report.ok) {
    c.error('invalid_material', path, `${path}: вариант материала структурно некорректен — условия записи не проверяются относительно него (ошибки варианта перечислены выше).`);
    return undefined;
  }
  return variant as Record<string, unknown>;
}

export function validatePropertyRecord(record: unknown, variant?: unknown): ValidationReport {
  const c = new Collector();
  const context = validatedVariantContext(variant, null, 'variant', c);
  collectRecord(record, context, 'record', c);
  return c.report();
}

/** A validated, deep-frozen copy. Throws MaterialsError with ALL the issues when the record is invalid. */
export function createPropertyRecord(input: PropertyRecord, variant?: unknown): PropertyRecord {
  const report = validatePropertyRecord(input, variant);
  const errors = report.issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new MaterialsError('invalid_property', `Запись свойства некорректна: ${errors.length} ошибок. Первая — ${errors[0].path}: ${errors[0].message}`, report.issues);
  return deepFreeze(structuredClone(input));
}

/** Validates a SET of records against the variants of a catalog: each record resolves to ITS variant (never to a similar one), ids are unique, the namespace of a
 *  record may not depend on a variant of a less shared namespace (a shipped record on a user's variant), a superseded record is of the same variant and property
 *  and has a lower version. Identical content under different ids is reported (warning), never merged; conflicting records are not compared here (M1.3.3). */
export function validatePropertyRecords(records: unknown, catalog: unknown): ValidationReport {
  const c = new Collector();
  if (!Array.isArray(records)) { c.error('invalid_property', 'records', 'records: ожидался список записей.'); return c.report(); }
  // every variant of the catalog by id: with all its occurrences, so that an id that is not unique is seen as AMBIGUOUS (never "the first one")
  const variants = new Map<string, { index: number; variant: unknown }[]>();
  const identityKinds = new Map<string, MaterialKind>();
  if (isRecord(catalog) && Array.isArray(catalog.identities)) for (const i of catalog.identities) if (isRecord(i) && typeof i.id === 'string' && (MATERIAL_KINDS as readonly string[]).includes(i.kind as string)) identityKinds.set(i.id, i.kind as MaterialKind);
  if (isRecord(catalog) && Array.isArray(catalog.variants)) catalog.variants.forEach((v, index) => { if (isRecord(v) && typeof v.id === 'string') variants.set(v.id, [...(variants.get(v.id) ?? []), { index, variant: v }]); });
  const resolved = new Map<string, Record<string, unknown> | undefined>();
  const byId = new Map<string, Record<string, unknown>>();
  const fingerprints = new Map<string, string>();
  records.forEach((record, i) => {
    const path = `records[${i}]`;
    let variant: Record<string, unknown> | undefined;
    if (isRecord(record) && typeof record.variant === 'string') {
      const id = record.variant;
      const found = variants.get(id);
      if (!found) c.error('missing_reference', `${path}.variant`, `${path}.variant: вариант «${id}» не найден в каталоге.`);
      else if (found.length > 1) c.error('duplicate_id', `${path}.variant`, `${path}.variant: идентификатор варианта «${id}» встречается в каталоге ${found.length} раза (индексы ${found.map(f => f.index).join(', ')}) — ссылка неоднозначна, вариант не выбирается.`);
      else if (resolved.has(id)) variant = resolved.get(id);
      else {
        const { index, variant: raw } = found[0];
        const identityId = isRecord(raw) ? raw.identity : undefined;
        variant = validatedVariantContext(raw, typeof identityId === 'string' ? identityKinds.get(identityId) ?? null : null, `catalog.variants[${index}]`, c);
        resolved.set(id, variant);
      }
    }
    collectRecord(record, variant, path, c);
    if (!isRecord(record) || typeof record.id !== 'string') return;
    if (byId.has(record.id)) { c.error('duplicate_id', `${path}.id`, `${path}.id: запись «${record.id}» уже есть в наборе.`); return; }
    byId.set(record.id, record);
    const recordNs = parseMaterialId(record.id)?.namespace;
    const variantNs = typeof record.variant === 'string' ? parseMaterialId(record.variant)?.namespace : undefined;
    if (recordNs && variantNs && recordNs !== 'user' && variantNs !== recordNs) c.error('namespace_mismatch', `${path}.variant`, `${path}.variant: запись пространства «${recordNs}:» не может ссылаться на вариант пространства «${variantNs}:».`);
    try {
      const { id: _id, version: _version, updatedAt: _updatedAt, supersedes: _supersedes, ...content } = record;
      void _id; void _version; void _updatedAt; void _supersedes;
      const fp = contentFingerprint(content);
      const earlier = fingerprints.get(fp);
      if (earlier) c.warning('duplicate_record', path, `${path}: содержимое совпадает с записью «${earlier}» — вероятный дубликат (записи не объединяются).`);
      else fingerprints.set(fp, record.id);
    } catch { /* a record that cannot be canonicalised already has an error */ }
  });
  records.forEach((record, i) => {
    if (!isRecord(record) || typeof record.supersedes !== 'string' || typeof record.id !== 'string') return;
    const path = `records[${i}].supersedes`;
    const target = byId.get(record.supersedes);
    if (!target) { c.error('supersedes_invalid', path, `${path}: заменяемая запись «${record.supersedes}» не найдена в наборе.`); return; }
    if (target.variant !== record.variant || target.property !== record.property) c.error('supersedes_invalid', path, `${path}: заменять можно только запись того же варианта и того же свойства.`);
    if (typeof record.version === 'number' && typeof target.version === 'number' && record.version <= target.version) c.error('supersedes_invalid', path, `${path}: версия заменяющей записи (${record.version}) должна быть больше версии заменяемой (${target.version}).`);
  });
  return c.report();
}

export const propertyDefinitionOf = (record: PropertyRecord): PropertyDefinition | undefined => getPropertyDefinition(record.property);
