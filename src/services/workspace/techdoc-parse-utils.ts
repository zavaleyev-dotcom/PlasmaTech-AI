/** Bounded readers for untrusted JSON, shared by the current-schema parser (techdoc-parse.ts) and the
 *  parser of older schemas (techdoc-legacy.ts). Every value is read by name and type/length/size
 *  checked; nothing is ever spread wholesale into our own objects. */

export const MAX_SHORT_TEXT = 300;
export const MAX_LONG_TEXT = 5000;
export const MAX_STEPS = 200;
export const MAX_QUALITY_CHECKS = 200;
export const MAX_SMALL_ARRAY = 50;

export function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  return value as Record<string, unknown>;
}
export function asArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: ожидается массив.`);
  if (value.length > maxItems) throw new Error(`${label}: слишком много элементов (максимум ${maxItems}).`);
  return value;
}
export function asRequiredString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string {
  if (typeof value !== 'string') throw new Error(`${label}: обязательное строковое поле.`);
  if (value.length > maxLen) throw new Error(`${label}: текст слишком длинный (максимум ${maxLen} символов).`);
  return value;
}
export function asOptionalString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asRequiredString(value, label, maxLen);
}
export function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`${label}: ожидается число.`);
  return value;
}
export function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}
export function asStringArray(value: unknown, label: string, maxItems = MAX_SMALL_ARRAY, maxLen = MAX_SHORT_TEXT): string[] {
  return asArray(value, label, maxItems).map((v, i) => asRequiredString(v, `${label}[${i}]`, maxLen));
}

import type { GeneralInfo, InitialData, QualityCheck, SafetySection, Traceability } from './techdoc-assistant';
import { DEFAULT_PRESSURE_UNIT, isPressureUnit, nextId } from './techdoc-schema';

/** First record that uses an id keeps it; later repeats and empty ids get a fresh `${prefix}-N`, chosen after ALL explicit ids are reserved.
 *  Nothing but `id` changes. */
export function withUniqueIds<T extends { id: string }>(items: readonly T[], prefix: string): T[] {
  const kept = new Set<string>();
  const needs = items.map(item => { if (item.id.trim() === '' || kept.has(item.id)) return true; kept.add(item.id); return false; });
  const taken: { id: string }[] = [...kept].map(id => ({ id }));
  return items.map((item, i) => {
    if (!needs[i]) return item;
    const id = nextId(prefix, taken);
    taken.push({ id });
    return { ...item, id };
  });
}

export function parseGeneralInfo(raw: unknown): GeneralInfo {
  const o = asObject(raw ?? {}, 'Общие сведения');
  return {
    processName: asRequiredString(o.processName, 'Название процесса', MAX_SHORT_TEXT),
    purpose: asOptionalString(o.purpose, 'Назначение', MAX_LONG_TEXT),
    equipment: asOptionalString(o.equipment, 'Оборудование'),
    installationModel: asOptionalString(o.installationModel, 'Установка/модель'),
    substrateMaterial: asOptionalString(o.substrateMaterial, 'Материал подложки'),
    productType: asOptionalString(o.productType, 'Тип изделия'),
    coatingMaterial: asOptionalString(o.coatingMaterial, 'Материал покрытия/обработки'),
    responsible: asOptionalString(o.responsible, 'Ответственный/подразделение'),
    documentVersion: asOptionalString(o.documentVersion, 'Версия документа'),
    date: asOptionalString(o.date, 'Дата'),
  };
}

export function parseInitialData(raw: unknown): InitialData {
  const o = asObject(raw ?? {}, 'Исходные данные');
  return {
    partSizeMm: asOptionalNumber(o.partSizeMm, 'Размер изделия'),
    quantity: asOptionalNumber(o.quantity, 'Количество'),
    initialSurfaceCondition: asOptionalString(o.initialSurfaceCondition, 'Исходное состояние поверхности', MAX_LONG_TEXT),
    cleanlinessRequirement: asOptionalString(o.cleanlinessRequirement, 'Требования к чистоте', MAX_LONG_TEXT),
    coatingRequirement: asOptionalString(o.coatingRequirement, 'Требования к покрытию/обработке', MAX_LONG_TEXT),
    requiredThicknessUm: asOptionalNumber(o.requiredThicknessUm, 'Требуемая толщина'),
    allowedTemperatureC: asOptionalNumber(o.allowedTemperatureC, 'Допустимая температура'),
    additionalRequirements: asOptionalString(o.additionalRequirements, 'Дополнительные требования', MAX_LONG_TEXT),
  };
}

const QUALITY_STATUSES = ['pass', 'fail', 'not_tested'] as const;

export function parseQualityCheck(raw: unknown, index: number): QualityCheck {
  const o = asObject(raw, `Контроль качества[${index}]`);
  const status = o.status;
  return {
    // A missing id stays empty here and is filled by withUniqueIds AFTER every explicit id is reserved (an index fallback could take an id a later check owns)
    id: asRequiredString(o.id ?? '', `Контроль качества[${index}]: id`),
    parameter: asRequiredString(o.parameter, `Контроль качества[${index}]: параметр`),
    method: asOptionalString(o.method, `Контроль качества[${index}]: метод`, MAX_LONG_TEXT),
    criterion: asOptionalString(o.criterion, `Контроль качества[${index}]: критерий`, MAX_LONG_TEXT),
    unit: asOptionalString(o.unit, `Контроль качества[${index}]: единица`),
    result: asOptionalString(o.result, `Контроль качества[${index}]: результат`, MAX_LONG_TEXT),
    status: typeof status === 'string' && (QUALITY_STATUSES as readonly string[]).includes(status) ? status as QualityCheck['status'] : undefined,
  };
}

export function parseSafety(raw: unknown): SafetySection {
  const o = asObject(raw ?? {}, 'Безопасность');
  return {
    hazards: asStringArray(o.hazards, 'Опасности'),
    ppe: asStringArray(o.ppe, 'СИЗ'),
    interlocks: asStringArray(o.interlocks, 'Блокировки'),
    gasSafety: asOptionalString(o.gasSafety, 'Газовая безопасность', MAX_LONG_TEXT),
    vacuumSafety: asOptionalString(o.vacuumSafety, 'Вакуумная безопасность', MAX_LONG_TEXT),
    highVoltage: asOptionalString(o.highVoltage, 'Высокое напряжение', MAX_LONG_TEXT),
    hotSurfaces: asOptionalString(o.hotSurfaces, 'Горячие поверхности', MAX_LONG_TEXT),
    notes: asOptionalString(o.notes, 'Примечания', MAX_LONG_TEXT),
  };
}

export function parseTraceability(raw: unknown): Traceability {
  const o = asObject(raw ?? {}, 'Traceability');
  const now = new Date().toISOString();
  const version = asOptionalNumber(o.version, 'Traceability: версия') ?? 1;
  return {
    version,
    createdAt: asOptionalString(o.createdAt, 'Traceability: создан') ?? now,
    updatedAt: asOptionalString(o.updatedAt, 'Traceability: обновлён') ?? now,
    source: asOptionalString(o.source, 'Traceability: источник', MAX_SHORT_TEXT) ?? 'blank',
  };
}

/** Display unit; absent (every pre-existing document) -> the default, pascals. */
export function parsePressureUnit(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_PRESSURE_UNIT;
  if (!isPressureUnit(value)) throw new Error('Единица давления: допустимо Па или мбар.');
  return value;
}
