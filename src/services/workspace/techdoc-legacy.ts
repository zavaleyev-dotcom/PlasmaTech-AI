/** Reader for TechDoc documents of schemas 1-3 (the shape BEFORE equipment moved into the step cards).
 *
 *  Schemas 1-3 kept an equipment registry at document level (`sources`, `gasSystem`); steps referred to
 *  it by id (schema 3) and carried one common set of fields whatever their type. This module only
 *  READS that shape into `V3Document` with the same bounded, by-name checks as the current parser; the
 *  conversion into schema 4 is techdoc-migrate.ts. Pure and client-safe (no server-only, no I/O). */

import type { GeneralInfo, InitialData, QualityCheck, SafetySection, Traceability } from './techdoc-assistant';
import { migrateMbarToPa, type PressureUnit, type LegacyMagnetron, type LegacyArc, type LegacyGasLine, type LegacyEquipment } from './techdoc-schema';
import {
  MAX_STEPS, MAX_LONG_TEXT, MAX_SMALL_ARRAY, MAX_QUALITY_CHECKS,
  asObject, asArray, asRequiredString, asOptionalString, asOptionalNumber, asBoolean, asStringArray,
  parseGeneralInfo, parseInitialData, parseQualityCheck, parseSafety, parseTraceability, parsePressureUnit,
} from './techdoc-parse-utils';

/** The step types of schemas 1-3. */
export const V3_STEP_TYPES = [
  'loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'surface_preparation',
  'adhesion_underlayer', 'main_coating', 'multilayer_coating', 'reactive_deposition',
  'etching', 'cooling', 'unloading', 'quality_control', 'custom',
] as const;
export type V3StepType = typeof V3_STEP_TYPES[number];

export interface V3SourceAssignment {
  sourceId: string;
  kind: 'magnetron' | 'arc';
  enabled: boolean;
  powerW?: number;
  currentA?: number;
  startMin?: number;
  durationMin?: number;
  mode: 'parallel' | 'sequential';
}
export interface V3GasAssignment { lineId: string; enabled: boolean; flowSccm?: number; startMin?: number; durationMin?: number }
export interface V3GasUsage { gas: string; flowSccm?: number }

export interface V3Step {
  order: number;
  name: string;
  type: V3StepType;
  enabled: boolean;
  description?: string;
  durationMin?: number;
  temperatureC?: number;
  pressurePa?: number;
  gasUsage: V3GasUsage[];
  sourceConfiguration?: string;
  powerW?: number;
  currentA?: number;
  substrateBiasV?: number;
  rotationRpm?: number;
  distanceMm?: number;
  notes?: string;
  acceptanceCriteria?: string;
  origin: 'preset' | 'user';
  sourceAssignments: V3SourceAssignment[];
  gasAssignments: V3GasAssignment[];
  calculatedFields: string[];
}

export interface V3Document {
  pressureUnit: PressureUnit;
  general: GeneralInfo;
  initialData: InitialData;
  steps: V3Step[];
  equipment: LegacyEquipment;
  qualityChecks: QualityCheck[];
  safety: SafetySection;
  traceability: Traceability;
}

function asV3StepType(value: unknown, label: string): V3StepType {
  if (typeof value !== 'string' || !(V3_STEP_TYPES as readonly string[]).includes(value)) throw new Error(`${label}: недопустимый тип этапа.`);
  return value as V3StepType;
}

function parseGasUsage(raw: unknown, label: string): V3GasUsage[] {
  return asArray(raw, label, MAX_SMALL_ARRAY).map((entry, i) => {
    const o = asObject(entry, `${label}[${i}]`);
    return { gas: asRequiredString(o.gas ?? '', `${label}[${i}].gas`), flowSccm: asOptionalNumber(o.flowSccm, `${label}[${i}].flowSccm`) };
  });
}

/** Schema 1 stored the step pressure in mbar as `pressureMbar`; it is converted to pascal exactly here, once.
 *  A step that already carries `pressurePa` keeps it untouched; in a later schema a stray `pressureMbar` is ignored. */
function parseStepPressure(o: Record<string, unknown>, label: string, schema1: boolean): number | undefined {
  const pa = asOptionalNumber(o.pressurePa, `${label}: давление`);
  if (pa !== undefined) return pa;
  if (!schema1) return undefined;
  const mbar = asOptionalNumber(o.pressureMbar, `${label}: давление`);
  return mbar === undefined ? undefined : migrateMbarToPa(mbar);
}

function parseSourceAssignment(raw: unknown, label: string, index: number): V3SourceAssignment {
  const where = `${label}: назначение источника[${index}]`;
  const o = asObject(raw, where);
  if (o.kind !== 'magnetron' && o.kind !== 'arc') throw new Error(`${where}: недопустимый тип источника.`);
  const kind = o.kind;
  const sourceId = asRequiredString(o.sourceId, `${where}: sourceId`);
  if (sourceId.trim() === '') throw new Error(`${where}: не указан источник.`);
  const mode = o.mode === undefined || o.mode === null ? 'parallel' : o.mode;
  if (mode !== 'parallel' && mode !== 'sequential') throw new Error(`${where}: недопустимый режим работы.`);
  return {
    sourceId, kind, mode,
    enabled: asBoolean(o.enabled, `${where}: включён`, true),
    powerW: kind === 'magnetron' ? asOptionalNumber(o.powerW, `${where}: мощность`) : undefined,
    currentA: kind === 'arc' ? asOptionalNumber(o.currentA, `${where}: ток дуги`) : undefined,
    startMin: asOptionalNumber(o.startMin, `${where}: начало`),
    durationMin: asOptionalNumber(o.durationMin, `${where}: длительность`),
  };
}

function parseGasAssignment(raw: unknown, label: string, index: number): V3GasAssignment {
  const where = `${label}: назначение газовой линии[${index}]`;
  const o = asObject(raw, where);
  const lineId = asRequiredString(o.lineId, `${where}: lineId`);
  if (lineId.trim() === '') throw new Error(`${where}: не указана линия.`);
  return {
    lineId,
    enabled: asBoolean(o.enabled, `${where}: включена`, true),
    flowSccm: asOptionalNumber(o.flowSccm, `${where}: расход`),
    startMin: asOptionalNumber(o.startMin, `${where}: начало`),
    durationMin: asOptionalNumber(o.durationMin, `${where}: длительность`),
  };
}

function parseStep(raw: unknown, index: number, schema1: boolean, hasAssignments: boolean): V3Step {
  const o = asObject(raw, `Этап[${index}]`);
  const label = `Этап №${index + 1}`;
  return {
    order: asOptionalNumber(o.order, `${label}: номер`) ?? index + 1,
    name: asRequiredString(o.name, `${label}: название`),
    type: asV3StepType(o.type, `${label}: тип`),
    enabled: asBoolean(o.enabled, `${label}: включён`, true),
    description: asOptionalString(o.description, `${label}: описание`, MAX_LONG_TEXT),
    durationMin: asOptionalNumber(o.durationMin, `${label}: длительность`),
    temperatureC: asOptionalNumber(o.temperatureC, `${label}: температура`),
    pressurePa: parseStepPressure(o, label, schema1),
    gasUsage: parseGasUsage(o.gasUsage, `${label}: газы`),
    // Schema < 3 documents have no assignments; nothing is inferred from the free-text fields.
    sourceAssignments: hasAssignments ? asArray(o.sourceAssignments, `${label}: источники этапа`, MAX_SMALL_ARRAY).map((a, i) => parseSourceAssignment(a, label, i)) : [],
    gasAssignments: hasAssignments ? asArray(o.gasAssignments, `${label}: газовые линии этапа`, MAX_SMALL_ARRAY).map((a, i) => parseGasAssignment(a, label, i)) : [],
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

function parseMagnetron(raw: unknown, index: number): LegacyMagnetron {
  const o = asObject(raw, `Магнетрон[${index}]`);
  return {
    // A missing id stays empty: it is assigned later, AFTER every explicit id in the list is reserved.
    id: asRequiredString(o.id ?? '', `Магнетрон[${index}]: id`),
    enabled: asBoolean(o.enabled, `Магнетрон[${index}]: включён`, true),
    material: asOptionalString(o.material, `Магнетрон[${index}]: материал`),
    powerW: asOptionalNumber(o.powerW, `Магнетрон[${index}]: мощность`),
    mode: asOptionalString(o.mode, `Магнетрон[${index}]: режим`),
  };
}

function parseArcSource(raw: unknown, index: number): LegacyArc {
  const o = asObject(raw, `Arc-источник[${index}]`);
  return {
    id: asRequiredString(o.id ?? '', `Arc-источник[${index}]: id`),
    enabled: asBoolean(o.enabled, `Arc-источник[${index}]: включён`, true),
    cathodeMaterial: asOptionalString(o.cathodeMaterial, `Arc-источник[${index}]: материал катода`),
    arcCurrentA: asOptionalNumber(o.arcCurrentA, `Arc-источник[${index}]: ток дуги`),
    filtered: asBoolean(o.filtered, `Arc-источник[${index}]: фильтрованный`, false),
  };
}

function parseGasLine(raw: unknown, index: number): LegacyGasLine {
  const o = asObject(raw, `Газовая линия[${index}]`);
  return {
    id: asRequiredString(o.id ?? '', `Газовая линия[${index}]: id`),
    gas: asRequiredString(o.gas ?? '', `Газовая линия[${index}]: газ`),
    flow: asOptionalNumber(o.flow, `Газовая линия[${index}]: расход`),
    unit: asRequiredString(o.unit ?? 'sccm', `Газовая линия[${index}]: единица`, 20),
    enabled: asBoolean(o.enabled, `Газовая линия[${index}]: включена`, false),
  };
}

/** Gives every id-less item a fresh id `${prefix}-N` (one past the highest number in use), only after ALL explicit ids
 *  of the list are reserved. Items that already have an id are returned untouched, so references to them keep their meaning. */
function fillMissingIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const used = new Set(items.filter(l => l.id.trim() !== '').map(l => l.id));
  const pattern = new RegExp(`^${prefix}-(\\d{1,9})$`);
  let max = 0;
  for (const id of used) { const m = pattern.exec(id); if (m) max = Math.max(max, Number(m[1])); }
  let next = max + 1;
  return items.map(item => {
    if (item.id.trim() !== '') return item;
    while (used.has(`${prefix}-${next}`)) next += 1;
    const id = `${prefix}-${next}`;
    used.add(id);
    return { ...item, id };
  });
}

function parseEquipment(o: Record<string, unknown>): LegacyEquipment {
  const sourcesRaw = asObject(o.sources ?? {}, 'Источники');
  const icpRaw = asObject(sourcesRaw.icpRf ?? {}, 'ICP/RF');
  const ionRaw = asObject(sourcesRaw.ionSource ?? {}, 'Ion source');
  return {
    magnetrons: fillMissingIds(asArray(sourcesRaw.magnetrons, 'Магнетроны', MAX_SMALL_ARRAY).map(parseMagnetron), 'magnetron'),
    arcSources: fillMissingIds(asArray(sourcesRaw.arcSources, 'Arc-источники', MAX_SMALL_ARRAY).map(parseArcSource), 'arc'),
    icpRf: {
      enabled: asBoolean(icpRaw.enabled, 'ICP/RF: включён', false),
      powerW: asOptionalNumber(icpRaw.powerW, 'ICP/RF: мощность'),
      biasV: asOptionalNumber(icpRaw.biasV, 'ICP/RF: bias'),
    },
    ionSource: {
      enabled: asBoolean(ionRaw.enabled, 'Ion source: включён', false),
      voltageV: asOptionalNumber(ionRaw.voltageV, 'Ion source: напряжение'),
      currentA: asOptionalNumber(ionRaw.currentA, 'Ion source: ток'),
      powerW: asOptionalNumber(ionRaw.powerW, 'Ion source: мощность'),
    },
    gasLines: fillMissingIds(asArray(o.gasSystem, 'Газовая система', MAX_SMALL_ARRAY).map(parseGasLine), 'gas'),
  };
}

/** Reads a document of schema 1, 2 or 3. `schemaVersion` is the (already checked) version of the document. */
export function parseV3Document(o: Record<string, unknown>, schemaVersion: number): V3Document {
  return {
    pressureUnit: parsePressureUnit(o.pressureUnit),
    general: parseGeneralInfo(o.general),
    initialData: parseInitialData(o.initialData),
    steps: asArray(o.steps, 'Этапы процесса', MAX_STEPS).map((s, i) => parseStep(s, i, schemaVersion < 2, schemaVersion >= 3)),
    equipment: parseEquipment(o),
    qualityChecks: asArray(o.qualityChecks, 'Контроль качества', MAX_QUALITY_CHECKS).map((q, i) => parseQualityCheck(q, i)),
    safety: parseSafety(o.safety),
    traceability: parseTraceability(o.traceability),
  };
}
