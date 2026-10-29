/** Rebuilds a `TechnicalProcessDocument` from arbitrary, untrusted JSON - every field is read by NAME and type/length/array-size
 *  checked here; nothing is ever spread wholesale into our own objects, so a malformed or hostile payload can neither smuggle extra
 *  properties nor blow up memory/CPU with unbounded arrays or strings. Numeric soundness (NaN/Infinity/sign) is left to
 *  `validateDocument`, which every caller already runs afterward.
 *
 *  Deliberately NOT server-only: it is shared by two untrusted-input paths - the DOCX/PDF export API route (an HTTP request body,
 *  server-side) AND TechDoc Assistant's own browser-local persistence (restoreDocumentDetailed, client-side).
 *
 *  Documents of schemas 1-3 are read by techdoc-legacy.ts and converted to the current schema by techdoc-migrate.ts. */

import type { TechnicalProcessDocument, ProcessStep, CoatingLayer } from './techdoc-assistant';
import { parseV3Document } from './techdoc-legacy';
import { migrateV3Document, type MigrationReport } from './techdoc-migrate';
import {
  TECHDOC_SCHEMA_VERSION, UnsupportedSchemaVersionError, STEP_TYPES, STEP_TYPE_SPECS, STEP_FIELD_META, LAYER_FIELDS, SOURCE_KINDS, ASSIGNMENT_MODES, COATING_MODES, SOURCE_KIND_FIELDS,
  createEmptyLegacy, nextId,
  type StepSource, type StepGas, type StepType, type StepFieldKey, type SourceKind, type AssignmentMode, type CoatingMode,
  type LegacyData, type LegacyField, type LegacyValue, type LegacyStep, type LegacyStepFields, type LegacyEquipment,
} from './techdoc-schema';
import {
  MAX_SHORT_TEXT, MAX_LONG_TEXT, MAX_STEPS, MAX_QUALITY_CHECKS, MAX_SMALL_ARRAY,
  asObject, asArray, asRequiredString, asOptionalString, asOptionalNumber, asBoolean, asStringArray,
  parseGeneralInfo, parseInitialData, parseQualityCheck, parseSafety, parseTraceability, parsePressureUnit, withUniqueIds,
} from './techdoc-parse-utils';

const MAX_LAYERS = 100;
/** One legacy VALUE may hold this many nodes (a step can carry dozens of sources); the whole legacy block is bounded separately. */
const MAX_LEGACY_NODES = 5000;
const MAX_LEGACY_TOTAL_NODES = 200_000;
const MAX_LEGACY_DEPTH = 8;

function asStepType(value: unknown, label: string): StepType {
  if (typeof value !== 'string' || !(STEP_TYPES as readonly string[]).includes(value)) throw new Error(`${label}: недопустимый тип этапа.`);
  return value as StepType;
}

function parseStepSource(raw: unknown, where: string): StepSource {
  const o = asObject(raw, where);
  if (typeof o.kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(o.kind)) throw new Error(`${where}: недопустимый тип источника.`);
  const kind = o.kind as SourceKind;
  const mode = o.mode === undefined || o.mode === null ? 'parallel' : o.mode;
  if (typeof mode !== 'string' || !(ASSIGNMENT_MODES as readonly string[]).includes(mode)) throw new Error(`${where}: недопустимый режим работы.`);
  const fields = new Set<string>(SOURCE_KIND_FIELDS[kind]);
  const num = (key: string, label: string) => fields.has(key) ? asOptionalNumber(o[key], `${where}: ${label}`) : undefined;
  const source: StepSource = {
    // A missing id stays empty here and is filled AFTER every explicit id of the list is reserved.
    id: asRequiredString(o.id ?? '', `${where}: id`),
    kind, enabled: asBoolean(o.enabled, `${where}: включён`, true), mode: mode as AssignmentMode,
    // Only the values that belong to the kind are read.
    material: fields.has('material') ? asOptionalString(o.material, `${where}: материал`) : undefined,
    operatingMode: fields.has('operatingMode') ? asOptionalString(o.operatingMode, `${where}: режим питания`) : undefined,
    filtered: fields.has('filtered') ? asBoolean(o.filtered, `${where}: фильтрация`, false) : undefined,
    powerW: num('powerW', 'мощность'), currentA: num('currentA', 'ток'), voltageV: num('voltageV', 'напряжение'), biasV: num('biasV', 'смещение'),
    startMin: asOptionalNumber(o.startMin, `${where}: начало`),
    durationMin: asOptionalNumber(o.durationMin, `${where}: длительность`),
  };
  return Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)) as unknown as StepSource;
}

function parseStepGas(raw: unknown, where: string): StepGas {
  const o = asObject(raw, where);
  const gas: StepGas = {
    id: asRequiredString(o.id ?? '', `${where}: id`),
    enabled: asBoolean(o.enabled, `${where}: включена`, true),
    gas: asRequiredString(o.gas ?? '', `${where}: газ`),
    flowSccm: asOptionalNumber(o.flowSccm, `${where}: расход`),
    startMin: asOptionalNumber(o.startMin, `${where}: начало`),
    durationMin: asOptionalNumber(o.durationMin, `${where}: длительность`),
  };
  return Object.fromEntries(Object.entries(gas).filter(([, v]) => v !== undefined)) as unknown as StepGas;
}

/** Gives every id-less item a fresh id after all explicit ids are reserved (so no explicit id is ever taken by another item). */
function fillIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const taken: { id: string }[] = items.filter(i => i.id.trim() !== '').map(i => ({ id: i.id }));
  return items.map(item => {
    if (item.id.trim() !== '') return item;
    const id = nextId(prefix, taken);
    taken.push({ id });
    return { ...item, id };
  });
}

function parseSources(raw: unknown, label: string): StepSource[] {
  return fillIds(asArray(raw, `${label}: источники`, MAX_SMALL_ARRAY).map((s, i) => parseStepSource(s, `${label}: источник[${i}]`)), 'source');
}
function parseGases(raw: unknown, label: string): StepGas[] {
  return fillIds(asArray(raw, `${label}: газовые линии`, MAX_SMALL_ARRAY).map((g, i) => parseStepGas(g, `${label}: газовая линия[${i}]`)), 'gas');
}

/** Reads the fields in `keys` from `o` by their kind (number / text / non-negative-integer count), leaving the others unset. */
function readFields(o: Record<string, unknown>, keys: readonly StepFieldKey[], label: string): Partial<Record<StepFieldKey, number | string>> {
  const out: Partial<Record<StepFieldKey, number | string>> = {};
  for (const key of keys) {
    const meta = STEP_FIELD_META[key];
    const value = meta.kind === 'text' ? asOptionalString(o[key], `${label}: ${meta.label.toLowerCase()}`, MAX_SHORT_TEXT) : asOptionalNumber(o[key], `${label}: ${meta.label.toLowerCase()}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function parseLayer(raw: unknown, label: string, index: number): CoatingLayer {
  const where = `${label}, слой ${index + 1}`;
  const o = asObject(raw, where);
  return {
    id: asRequiredString(o.id ?? '', `${where}: id`),
    ...(readFields(o, LAYER_FIELDS, where) as Partial<CoatingLayer>),
    sources: parseSources(o.sources, where),
    gases: parseGases(o.gases, where),
    calculatedFields: asStringArray(o.calculatedFields, `${where}: вычисленные поля`, 20, 100).filter(f => (LAYER_FIELDS as readonly string[]).includes(f)),
  };
}

function parseStep(raw: unknown, index: number): ProcessStep {
  const o = asObject(raw, `Этап[${index}]`);
  const label = `Этап №${index + 1}`;
  const type = asStepType(o.type, `${label}: тип`);
  const spec = STEP_TYPE_SPECS[type];
  const mode = o.coatingMode === undefined || o.coatingMode === null ? 'multi' : o.coatingMode;
  if (typeof mode !== 'string' || !(COATING_MODES as readonly string[]).includes(mode)) throw new Error(`${label}: недопустимый режим покрытия.`);
  const layers = spec.layers ? fillIds(asArray(o.layers, `${label}: слои`, MAX_LAYERS).map((l, i) => parseLayer(l, label, i)), 'layer') : [];
  return {
    id: asRequiredString(o.id ?? '', `${label}: id`),
    order: asOptionalNumber(o.order, `${label}: номер`) ?? index + 1,
    name: asRequiredString(o.name, `${label}: название`),
    type,
    enabled: asBoolean(o.enabled, `${label}: включён`, true),
    description: asOptionalString(o.description, `${label}: описание`, MAX_LONG_TEXT),
    // Only the fields the card type has are read: whatever else a payload carries is dropped, never smuggled in.
    ...(readFields(o, spec.fields, label) as Partial<ProcessStep>),
    sources: spec.sources ? parseSources(o.sources, label) : [],
    gases: spec.gases ? parseGases(o.gases, label) : [],
    coatingMode: mode as CoatingMode,
    layers,
    origin: o.origin === 'preset' ? 'preset' : 'user',
    calculatedFields: asStringArray(o.calculatedFields, `${label}: вычисленные поля`, 20, 100),
  };
}

// ---------- legacy block (bounded, structure-free JSON values) ----------

function parseLegacyValue(value: unknown, label: string, budget: { nodes: number }, depth = 0): LegacyValue {
  if (++budget.nodes > MAX_LEGACY_NODES) throw new Error(`${label}: слишком много вложенных данных.`);
  if (depth > MAX_LEGACY_DEPTH) throw new Error(`${label}: слишком глубокая вложенность.`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') { if (value.length > MAX_LONG_TEXT) throw new Error(`${label}: текст слишком длинный.`); return value; }
  if (Array.isArray(value)) return value.map(v => parseLegacyValue(v, label, budget, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, parseLegacyValue(v, label, budget, depth + 1)]));
  throw new Error(`${label}: недопустимое значение.`);
}

function parseLegacyFields(raw: unknown, label: string, total: { nodes: number }): LegacyField[] {
  return asArray(raw, label, MAX_SMALL_ARRAY).map((f, i) => {
    const o = asObject(f, `${label}[${i}]`);
    const own = { nodes: 0 }; // every field has its own budget: many fields with big values must not exhaust a shared one
    const value = parseLegacyValue(o.value ?? null, `${label}[${i}]`, own);
    total.nodes += own.nodes;
    if (total.nodes > MAX_LEGACY_TOTAL_NODES) throw new Error(`${label}: слишком много данных прежней версии.`);
    return { key: asRequiredString(o.key, `${label}[${i}]: ключ`, 100), label: asRequiredString(o.label ?? o.key, `${label}[${i}]: название`), value };
  });
}

function parseLegacyEquipment(raw: unknown): LegacyEquipment | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObject(raw, 'Прежний справочник');
  const icp = asObject(o.icpRf ?? {}, 'Прежний ICP/RF');
  const ion = asObject(o.ionSource ?? {}, 'Прежний ion source');
  return {
    magnetrons: asArray(o.magnetrons, 'Прежние магнетроны', MAX_SMALL_ARRAY).map((m, i) => {
      const x = asObject(m, `Прежний магнетрон[${i}]`);
      return { id: asRequiredString(x.id ?? '', `Прежний магнетрон[${i}]: id`), enabled: asBoolean(x.enabled, 'включён', true), material: asOptionalString(x.material, 'материал'), powerW: asOptionalNumber(x.powerW, 'мощность'), mode: asOptionalString(x.mode, 'режим') };
    }),
    arcSources: asArray(o.arcSources, 'Прежние дуговые источники', MAX_SMALL_ARRAY).map((a, i) => {
      const x = asObject(a, `Прежний дуговой источник[${i}]`);
      return { id: asRequiredString(x.id ?? '', `Прежний дуговой источник[${i}]: id`), enabled: asBoolean(x.enabled, 'включён', true), cathodeMaterial: asOptionalString(x.cathodeMaterial, 'материал катода'), arcCurrentA: asOptionalNumber(x.arcCurrentA, 'ток дуги'), filtered: asBoolean(x.filtered, 'фильтрованный', false) };
    }),
    icpRf: { enabled: asBoolean(icp.enabled, 'ICP/RF: включён', false), powerW: asOptionalNumber(icp.powerW, 'ICP/RF: мощность'), biasV: asOptionalNumber(icp.biasV, 'ICP/RF: смещение') },
    ionSource: { enabled: asBoolean(ion.enabled, 'Ion source: включён', false), voltageV: asOptionalNumber(ion.voltageV, 'напряжение'), currentA: asOptionalNumber(ion.currentA, 'ток'), powerW: asOptionalNumber(ion.powerW, 'мощность') },
    gasLines: asArray(o.gasLines, 'Прежние газовые линии', MAX_SMALL_ARRAY).map((l, i) => {
      const x = asObject(l, `Прежняя газовая линия[${i}]`);
      return { id: asRequiredString(x.id ?? '', `Прежняя газовая линия[${i}]: id`), gas: asRequiredString(x.gas ?? '', 'газ'), flow: asOptionalNumber(x.flow, 'расход'), unit: asRequiredString(x.unit ?? 'sccm', 'единица', 20), enabled: asBoolean(x.enabled, 'включена', false) };
    }),
  };
}

function parseLegacy(raw: unknown): LegacyData {
  if (raw === undefined || raw === null) return createEmptyLegacy();
  const o = asObject(raw, 'Данные прежней версии');
  const budget = { nodes: 0 };
  const stepFields: LegacyStepFields[] = asArray(o.stepFields, 'Прежние поля этапов', MAX_STEPS).map((e, i) => {
    const x = asObject(e, `Прежние поля этапа[${i}]`);
    return { stepId: asRequiredString(x.stepId, `Прежние поля этапа[${i}]: stepId`), stepName: asRequiredString(x.stepName ?? '', `Прежние поля этапа[${i}]: название`), fields: parseLegacyFields(x.fields, `Прежние поля этапа[${i}]`, budget) };
  });
  const steps: LegacyStep[] = asArray(o.steps, 'Прежние этапы', MAX_STEPS).map((e, i) => {
    const x = asObject(e, `Прежний этап[${i}]`);
    return {
      id: asRequiredString(x.id ?? `legacy-step-${i + 1}`, `Прежний этап[${i}]: id`), originalOrder: asOptionalNumber(x.originalOrder, `Прежний этап[${i}]: номер`) ?? i + 1,
      name: asRequiredString(x.name ?? '', `Прежний этап[${i}]: название`), originalType: asRequiredString(x.originalType ?? '', `Прежний этап[${i}]: тип`, 100),
      enabled: asBoolean(x.enabled, `Прежний этап[${i}]: включён`, true),
      fields: parseLegacyFields(x.fields, `Прежний этап[${i}]`, budget),
    };
  });
  const migratedFromSchema = asOptionalNumber(o.migratedFromSchema, 'Прежняя схема');
  const equipment = parseLegacyEquipment(o.equipment);
  return { ...(migratedFromSchema !== undefined ? { migratedFromSchema } : {}), stepFields, steps, ...(equipment ? { equipment } : {}) };
}

/** Absent -> 1 (documents saved before the field existed). A newer-than-known version is refused with UnsupportedSchemaVersionError
 *  BEFORE anything else is read: its structure is unknown, and guessing could corrupt it. Anything that is not a positive integer is
 *  a malformed document. */
export function parseSchemaVersion(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('Версия схемы документа: ожидается целое число не меньше 1.');
  if (value > TECHDOC_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(value);
  return value;
}

export interface ParsedDocument { document: TechnicalProcessDocument; migration?: MigrationReport }

/** Reads a document of ANY supported schema. An older one is converted (in memory) to the current schema and the report says how. */
export function parseTechnicalProcessDocumentDetailed(raw: unknown): ParsedDocument {
  const o = asObject(raw, 'document');
  const schemaVersion = parseSchemaVersion(o.schemaVersion);
  if (schemaVersion < TECHDOC_SCHEMA_VERSION) {
    const { document, report } = migrateV3Document(parseV3Document(o, schemaVersion), schemaVersion);
    const migrated = finishSteps(document);
    // A migrated document must be able to come back after a save: it goes through the SAME current-schema parser a reload uses. If it could not
    // (a limit nobody anticipated), it is refused with an explanation - never loaded in a state that cannot be saved and reopened.
    try { parseCurrent(JSON.parse(JSON.stringify(migrated)) as Record<string, unknown>); } catch (error) {
      throw new Error(`Документ после преобразования из схемы ${schemaVersion} не удалось бы открыть снова: ${error instanceof Error ? error.message : 'превышено ограничение'}. Исходные данные не изменены.`);
    }
    return { document: migrated, migration: report };
  }
  return { document: finishSteps(parseCurrent(o)) };
}

function parseCurrent(o: Record<string, unknown>): TechnicalProcessDocument {
  return {
    schemaVersion: TECHDOC_SCHEMA_VERSION,
    pressureUnit: parsePressureUnit(o.pressureUnit),
    general: parseGeneralInfo(o.general),
    initialData: parseInitialData(o.initialData),
    steps: asArray(o.steps, 'Этапы процесса', MAX_STEPS).map((s, i) => parseStep(s, i)),
    qualityChecks: withUniqueIds(asArray(o.qualityChecks, 'Контроль качества', MAX_QUALITY_CHECKS).map((q, i) => parseQualityCheck(q, i)), 'qc'),
    safety: parseSafety(o.safety),
    legacy: parseLegacy(o.legacy),
    traceability: parseTraceability(o.traceability),
  };
}

/** Gives every id-less step a fresh id AFTER all explicit ids are reserved. */
function finishSteps(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  return { ...doc, steps: fillIds(doc.steps, 'step') };
}

export function parseTechnicalProcessDocument(raw: unknown): TechnicalProcessDocument {
  return parseTechnicalProcessDocumentDetailed(raw).document;
}
