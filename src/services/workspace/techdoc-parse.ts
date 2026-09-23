/** Rebuilds a `TechnicalProcessDocument` from arbitrary, untrusted JSON - every field is read
 *  by NAME and type/length/array-size checked here; nothing is ever spread wholesale into our
 *  own objects, so a malformed or hostile payload can neither smuggle extra properties nor
 *  blow up memory/CPU with unbounded arrays or strings. Numeric soundness (NaN/Infinity/sign)
 *  is left to `validateDocument`, which every caller already runs afterward.
 *
 *  Deliberately NOT server-only: this is shared by two very different untrusted-input paths -
 *  the DOCX/PDF export API route (an HTTP request body, see techdoc-export.ts, server-side)
 *  AND TechDoc Assistant's own browser-local persistence (tryRestoreDocument in
 *  techdoc-assistant.ts, client-side, restoring from this browser's own localStorage). F07: a
 *  corrupted/partial localStorage snapshot previously only got the
 *  shallow, value-only checks in `validateDocument` (which assumes the document is already
 *  correctly SHAPED and only range-checks numbers) - a structurally wrong snapshot (wrong
 *  field types, `steps` not an array, etc.) that never hit one of those specific numeric
 *  checks could still be accepted as "restored", then crash later when a view/export tried to
 *  read it. Reusing this already-thorough, already-tested structural parser for BOTH paths
 *  closes that gap without a second, independently-written (and possibly inconsistent)
 *  validator. */

import {
  STEP_TYPES,
  type TechnicalProcessDocument, type GeneralInfo, type InitialData, type ProcessStep, type GasUsage,
  type SourceSet, type MagnetronSource, type ArcSource, type GasLine, type QualityCheck, type SafetySection, type Traceability,
} from './techdoc-assistant';

const MAX_SHORT_TEXT = 300;
const MAX_LONG_TEXT = 5000;
const MAX_STEPS = 200;
const MAX_QUALITY_CHECKS = 200;
const MAX_SMALL_ARRAY = 50;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  return value as Record<string, unknown>;
}
function asArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: ожидается массив.`);
  if (value.length > maxItems) throw new Error(`${label}: слишком много элементов (максимум ${maxItems}).`);
  return value;
}
function asRequiredString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string {
  if (typeof value !== 'string') throw new Error(`${label}: обязательное строковое поле.`);
  if (value.length > maxLen) throw new Error(`${label}: текст слишком длинный (максимум ${maxLen} символов).`);
  return value;
}
function asOptionalString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asRequiredString(value, label, maxLen);
}
function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`${label}: ожидается число.`);
  return value;
}
function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}
function asStringArray(value: unknown, label: string, maxItems = MAX_SMALL_ARRAY, maxLen = MAX_SHORT_TEXT): string[] {
  return asArray(value, label, maxItems).map((v, i) => asRequiredString(v, `${label}[${i}]`, maxLen));
}
function asStepType(value: unknown, label: string): ProcessStep['type'] {
  if (typeof value !== 'string' || !STEP_TYPES.includes(value as ProcessStep['type'])) throw new Error(`${label}: недопустимый тип этапа.`);
  return value as ProcessStep['type'];
}

function parseGeneralInfo(raw: unknown): GeneralInfo {
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

function parseInitialData(raw: unknown): InitialData {
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

function parseGasUsage(raw: unknown, label: string): GasUsage[] {
  return asArray(raw, label, MAX_SMALL_ARRAY).map((entry, i) => {
    const o = asObject(entry, `${label}[${i}]`);
    return { gas: asRequiredString(o.gas ?? '', `${label}[${i}].gas`), flowSccm: asOptionalNumber(o.flowSccm, `${label}[${i}].flowSccm`) };
  });
}

function parseStep(raw: unknown, index: number): ProcessStep {
  const o = asObject(raw, `Этап[${index}]`);
  const label = `Этап №${index + 1}`;
  return {
    order: asOptionalNumber(o.order, `${label}: номер`) ?? index + 1,
    name: asRequiredString(o.name, `${label}: название`),
    type: asStepType(o.type, `${label}: тип`),
    enabled: asBoolean(o.enabled, `${label}: включён`, true),
    description: asOptionalString(o.description, `${label}: описание`, MAX_LONG_TEXT),
    durationMin: asOptionalNumber(o.durationMin, `${label}: длительность`),
    temperatureC: asOptionalNumber(o.temperatureC, `${label}: температура`),
    pressureMbar: asOptionalNumber(o.pressureMbar, `${label}: давление`),
    gasUsage: parseGasUsage(o.gasUsage, `${label}: газы`),
    sourceConfiguration: asOptionalString(o.sourceConfiguration, `${label}: источник`),
    powerW: asOptionalNumber(o.powerW, `${label}: мощность`),
    currentA: asOptionalNumber(o.currentA, `${label}: ток`),
    substrateBiasV: asOptionalNumber(o.substrateBiasV, `${label}: bias`),
    rotationRpm: asOptionalNumber(o.rotationRpm, `${label}: вращение`),
    distanceMm: asOptionalNumber(o.distanceMm, `${label}: расстояние`),
    notes: asOptionalString(o.notes, `${label}: примечание`, MAX_LONG_TEXT),
    acceptanceCriteria: asOptionalString(o.acceptanceCriteria, `${label}: критерий приёмки`, MAX_LONG_TEXT),
    origin: o.origin === 'preset' ? 'preset' : 'user',
    calculatedFields: asStringArray(o.calculatedFields, `${label}: вычисленные поля`, 20, 100),
  };
}

function parseMagnetron(raw: unknown, index: number): MagnetronSource {
  const o = asObject(raw, `Магнетрон[${index}]`);
  return {
    id: asRequiredString(o.id ?? `magnetron-${index}`, `Магнетрон[${index}]: id`),
    enabled: asBoolean(o.enabled, `Магнетрон[${index}]: включён`, true),
    material: asOptionalString(o.material, `Магнетрон[${index}]: материал`),
    powerW: asOptionalNumber(o.powerW, `Магнетрон[${index}]: мощность`),
    mode: asOptionalString(o.mode, `Магнетрон[${index}]: режим`),
  };
}

function parseArcSource(raw: unknown, index: number): ArcSource {
  const o = asObject(raw, `Arc-источник[${index}]`);
  return {
    id: asRequiredString(o.id ?? `arc-${index}`, `Arc-источник[${index}]: id`),
    enabled: asBoolean(o.enabled, `Arc-источник[${index}]: включён`, true),
    cathodeMaterial: asOptionalString(o.cathodeMaterial, `Arc-источник[${index}]: материал катода`),
    arcCurrentA: asOptionalNumber(o.arcCurrentA, `Arc-источник[${index}]: ток дуги`),
    filtered: asBoolean(o.filtered, `Arc-источник[${index}]: фильтрованный`, false),
  };
}

function parseSourceSet(raw: unknown): SourceSet {
  const o = asObject(raw ?? {}, 'Источники');
  const icpRfRaw = asObject(o.icpRf ?? {}, 'ICP/RF');
  const ionSourceRaw = asObject(o.ionSource ?? {}, 'Ion source');
  return {
    magnetrons: asArray(o.magnetrons, 'Магнетроны', MAX_SMALL_ARRAY).map(parseMagnetron),
    arcSources: asArray(o.arcSources, 'Arc-источники', MAX_SMALL_ARRAY).map(parseArcSource),
    icpRf: {
      enabled: asBoolean(icpRfRaw.enabled, 'ICP/RF: включён', false),
      powerW: asOptionalNumber(icpRfRaw.powerW, 'ICP/RF: мощность'),
      biasV: asOptionalNumber(icpRfRaw.biasV, 'ICP/RF: bias'),
    },
    ionSource: {
      enabled: asBoolean(ionSourceRaw.enabled, 'Ion source: включён', false),
      voltageV: asOptionalNumber(ionSourceRaw.voltageV, 'Ion source: напряжение'),
      currentA: asOptionalNumber(ionSourceRaw.currentA, 'Ion source: ток'),
      powerW: asOptionalNumber(ionSourceRaw.powerW, 'Ion source: мощность'),
    },
  };
}

function parseGasLine(raw: unknown, index: number): GasLine {
  const o = asObject(raw, `Газовая линия[${index}]`);
  return {
    id: asRequiredString(o.id ?? `gas-${index}`, `Газовая линия[${index}]: id`),
    gas: asRequiredString(o.gas ?? '', `Газовая линия[${index}]: газ`),
    flow: asOptionalNumber(o.flow, `Газовая линия[${index}]: расход`),
    unit: asRequiredString(o.unit ?? 'sccm', `Газовая линия[${index}]: единица`, 20),
    enabled: asBoolean(o.enabled, `Газовая линия[${index}]: включена`, false),
  };
}

const QUALITY_STATUSES = ['pass', 'fail', 'not_tested'] as const;

function parseQualityCheck(raw: unknown, index: number): QualityCheck {
  const o = asObject(raw, `Контроль качества[${index}]`);
  const status = o.status;
  return {
    id: asRequiredString(o.id ?? `qc-${index}`, `Контроль качества[${index}]: id`),
    parameter: asRequiredString(o.parameter, `Контроль качества[${index}]: параметр`),
    method: asOptionalString(o.method, `Контроль качества[${index}]: метод`, MAX_LONG_TEXT),
    criterion: asOptionalString(o.criterion, `Контроль качества[${index}]: критерий`, MAX_LONG_TEXT),
    unit: asOptionalString(o.unit, `Контроль качества[${index}]: единица`),
    result: asOptionalString(o.result, `Контроль качества[${index}]: результат`, MAX_LONG_TEXT),
    status: typeof status === 'string' && (QUALITY_STATUSES as readonly string[]).includes(status) ? status as QualityCheck['status'] : undefined,
  };
}

function parseSafety(raw: unknown): SafetySection {
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

function parseTraceability(raw: unknown): Traceability {
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

/** Rebuilds a `TechnicalProcessDocument` from arbitrary, untrusted JSON. Every field is read by
 *  name and type/length/array-size checked - nothing is ever spread wholesale from the input,
 *  so unexpected extra keys are silently dropped rather than smuggled into the document, and
 *  no single field can be used to exhaust memory/CPU. */
export function parseTechnicalProcessDocument(raw: unknown): TechnicalProcessDocument {
  const o = asObject(raw, 'document');
  const stepsRaw = asArray(o.steps, 'Этапы процесса', MAX_STEPS);
  const qualityChecksRaw = asArray(o.qualityChecks, 'Контроль качества', MAX_QUALITY_CHECKS);
  const gasSystemRaw = asArray(o.gasSystem, 'Газовая система', MAX_SMALL_ARRAY);
  return {
    general: parseGeneralInfo(o.general),
    initialData: parseInitialData(o.initialData),
    steps: stepsRaw.map((s, i) => parseStep(s, i)),
    sources: parseSourceSet(o.sources),
    gasSystem: gasSystemRaw.map((g, i) => parseGasLine(g, i)),
    qualityChecks: qualityChecksRaw.map((q, i) => parseQualityCheck(q, i)),
    safety: parseSafety(o.safety),
    traceability: parseTraceability(o.traceability),
  };
}
