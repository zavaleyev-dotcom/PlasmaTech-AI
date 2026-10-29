/** Storage-format version and pressure units of a TechDoc technological document. Pure and
 *  dependency-free (no server-only, no I/O), shared by the structural parser (techdoc-parse.ts),
 *  the document model (techdoc-assistant.ts) and the UI, so none of them import each other for
 *  these constants.
 *
 *  `schemaVersion` versions the SHAPE OF THE STORED DATA. It is deliberately not
 *  `traceability.version`, which counts revisions of one technological document's content.
 *
 *    1 (a document with no `schemaVersion` field at all) - step pressure stored as `pressureMbar`
 *    2                                                    - step pressure stored as `pressurePa`,
 *                                                           plus a `pressureUnit` display setting
 *    3                                                    - each step additionally carries
 *                                                           `sourceAssignments` / `gasAssignments`
 *                                                           that REFER to a document-level equipment
 *                                                           registry (`sources`, `gasSystem`)
 *    4                                                    - no registry: every source and gas line is
 *                                                           created and configured INSIDE the card of
 *                                                           the step (or layer) that uses it; eight
 *                                                           card types with their own fields; coating
 *                                                           layers; everything the new structure has
 *                                                           no place for is kept as `legacy` data
 *
 *  A document from a NEWER schema than this build knows is never parsed or converted: its
 *  structure is unknown, so guessing would risk silently corrupting it. */
export const TECHDOC_SCHEMA_VERSION = 4;

// ---------- sources and gas lines of a step / coating layer (schema 4) ----------

export const SOURCE_KINDS = ['magnetron', 'arc', 'icp_rf', 'ion'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  magnetron: 'Магнетрон', arc: 'Вакуумно-дуговой источник', icp_rf: 'ICP/RF-источник', ion: 'Ионный источник',
};
/** Prefix of the id a new source of each kind gets (unique within one step or layer). */
export const SOURCE_ID_PREFIX: Record<SourceKind, string> = { magnetron: 'magnetron', arc: 'arc', icp_rf: 'icp', ion: 'ion' };

export const ASSIGNMENT_MODES = ['parallel', 'sequential'] as const;
export type AssignmentMode = typeof ASSIGNMENT_MODES[number];
export const ASSIGNMENT_MODE_LABELS: Record<AssignmentMode, string> = { parallel: 'одновременно', sequential: 'последовательно' };

/** What "sequential" means, stated once and used by validation, previews and exports alike: during
 *  its own interval NO other enabled source of the same step (or layer) is running (touching at an
 *  endpoint is allowed). "Parallel" places no constraint on overlap. */
export const SEQUENTIAL_MODE_MEANING = 'интервал работы источника не пересекается с интервалами других включённых источников этого этапа или слоя (касание границ допускается; длительность 0 мин означает, что работы нет, и пересечением не считается)';

/** The meaning of the flow unit used for gas - the app never converts other units into it. */
export const SCCM_MEANING = 'sccm - стандартные см³/мин; условия приведения (температура, давление) определяются оборудованием и приложением не пересчитываются';

/** One source, created and configured inside the card (or coating layer) that uses it. Nothing is
 *  registered anywhere else. Which values apply depends on `kind` (see SOURCE_KIND_FIELDS); a value
 *  that does not apply to the kind is never stored. `enabled` is ON/OFF for this card - OFF is a
 *  deliberate state, different from an ON source whose values are simply not filled in
 *  (`undefined`). Times are minutes from the start of the step (or layer). */
export interface StepSource {
  id: string;
  kind: SourceKind;
  enabled: boolean;
  /** Magnetron target / arc cathode material. */
  material?: string;
  /** Magnetron operating (power-supply) mode, free text (e.g. "DC", "HiPIMS"). Not the same thing as `mode`. */
  operatingMode?: string;
  /** Arc source: filtered (FCVA). */
  filtered?: boolean;
  powerW?: number;
  currentA?: number;
  voltageV?: number;
  /** ICP/RF bias. */
  biasV?: number;
  startMin?: number;
  durationMin?: number;
  /** Parallel (simultaneous) or sequential with the other sources of the same step / layer. */
  mode: AssignmentMode;
}

export type SourceFieldKey = 'material' | 'operatingMode' | 'filtered' | 'powerW' | 'currentA' | 'voltageV' | 'biasV';
/** The values each kind of source carries - the single place that decides what is stored, edited,
 *  validated and printed for a source. */
export const SOURCE_KIND_FIELDS: Record<SourceKind, readonly SourceFieldKey[]> = {
  magnetron: ['material', 'powerW', 'operatingMode'],
  arc: ['material', 'currentA', 'filtered'],
  icp_rf: ['powerW', 'biasV'],
  ion: ['voltageV', 'currentA', 'powerW'],
};

/** One gas line of a card (or layer): the gas is typed right here, not picked from a registry.
 *  `flowSccm` is always sccm. */
export interface StepGas {
  id: string;
  enabled: boolean;
  gas: string;
  flowSccm?: number;
  startMin?: number;
  durationMin?: number;
}

// ---------- card types and their fields (schema 4) ----------

export const STEP_TYPES = [
  'loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer',
  'multilayer_coating', 'cooling', 'unloading',
] as const;
export type StepType = typeof STEP_TYPES[number];

export const STEP_TYPE_LABELS: Record<StepType, string> = {
  loading: 'Загрузка',
  pumpdown: 'Откачка',
  heating: 'Нагрев',
  plasma_ion_cleaning: 'Плазменная/ионная очистка',
  adhesion_underlayer: 'Адгезионный подслой',
  multilayer_coating: 'Многослойное покрытие',
  cooling: 'Охлаждение',
  unloading: 'Выгрузка',
};

/** Numeric/text fields a card can carry (the `ProcessStep` / `CoatingLayer` property names). */
export const STEP_FIELD_KEYS = [
  'durationMin', 'temperatureC', 'temperatureStartC', 'temperatureEndC', 'pressurePa', 'pressureStartPa', 'pressureEndPa',
  'heaterPowerW', 'substrateBiasV', 'rotationRpm', 'distanceMm', 'substrateType', 'substrateCount', 'fixture', 'material', 'thicknessNm',
] as const;
export type StepFieldKey = typeof STEP_FIELD_KEYS[number];

export interface StepFieldMeta {
  label: string;
  unit?: string;
  /** 'text' fields are strings, 'count' is a non-negative integer, 'number' any finite number. */
  kind: 'number' | 'text' | 'count';
  /** Marked "(необязательно)" in the editor; nothing is ever required, optional only says it is not part of the core set. */
  optional?: boolean;
  /** A pressure in Pa (shown in the document's pressure unit). */
  pressure?: boolean;
  /** Physical rule: 'nonnegative' (default for numbers), 'temperature' (not below absolute zero), 'finite' (bias may be negative). */
  rule?: 'nonnegative' | 'temperature' | 'finite';
}

export const STEP_FIELD_META: Record<StepFieldKey, StepFieldMeta> = {
  durationMin: { label: 'Продолжительность', unit: 'мин', kind: 'number' },
  temperatureC: { label: 'Температура', unit: '°C', kind: 'number', rule: 'temperature' },
  temperatureStartC: { label: 'Начальная температура', unit: '°C', kind: 'number', rule: 'temperature' },
  temperatureEndC: { label: 'Конечная температура', unit: '°C', kind: 'number', rule: 'temperature' },
  pressurePa: { label: 'Давление', kind: 'number', pressure: true },
  pressureStartPa: { label: 'Начальное давление', kind: 'number', pressure: true },
  pressureEndPa: { label: 'Конечное давление', kind: 'number', pressure: true },
  heaterPowerW: { label: 'Мощность нагревателей', unit: 'Вт', kind: 'number', optional: true },
  substrateBiasV: { label: 'Напряжение смещения', unit: 'В', kind: 'number', rule: 'finite' },
  rotationRpm: { label: 'Вращение', unit: 'об/мин', kind: 'number' },
  distanceMm: { label: 'Расстояние до подложек', unit: 'мм', kind: 'number', optional: true },
  substrateType: { label: 'Тип подложек', kind: 'text' },
  substrateCount: { label: 'Количество подложек', unit: 'шт.', kind: 'count' },
  fixture: { label: 'Оснастка / размещение', kind: 'text' },
  material: { label: 'Материал', kind: 'text' },
  thicknessNm: { label: 'Толщина', unit: 'нм', kind: 'number' },
};

export interface StepTypeSpec {
  /** Fields of the card, in editor order. Rotation of a pump-down, heater power and distance are optional ones. */
  fields: readonly StepFieldKey[];
  /** Fields that are optional for THIS card type (a field optional elsewhere may be core here and vice versa). */
  optional: readonly StepFieldKey[];
  sources: boolean;
  gases: boolean;
  /** The card holds coating layers (each with its own fields, sources and gases) instead of its own. */
  layers: boolean;
  calculator: boolean;
}

export const STEP_TYPE_SPECS: Record<StepType, StepTypeSpec> = {
  loading: { fields: ['durationMin', 'substrateType', 'substrateCount', 'fixture'], optional: [], sources: false, gases: false, layers: false, calculator: false },
  pumpdown: { fields: ['pressureStartPa', 'pressureEndPa', 'durationMin', 'rotationRpm'], optional: ['rotationRpm'], sources: false, gases: false, layers: false, calculator: false },
  heating: { fields: ['temperatureStartC', 'temperatureEndC', 'durationMin', 'pressureStartPa', 'pressureEndPa', 'rotationRpm', 'heaterPowerW'], optional: ['heaterPowerW'], sources: false, gases: false, layers: false, calculator: false },
  plasma_ion_cleaning: { fields: ['durationMin', 'temperatureC', 'pressurePa', 'substrateBiasV', 'rotationRpm', 'distanceMm'], optional: ['distanceMm'], sources: true, gases: true, layers: false, calculator: false },
  adhesion_underlayer: { fields: ['material', 'thicknessNm', 'durationMin', 'temperatureC', 'pressurePa', 'substrateBiasV', 'rotationRpm', 'distanceMm'], optional: ['distanceMm'], sources: true, gases: true, layers: false, calculator: true },
  multilayer_coating: { fields: [], optional: [], sources: false, gases: false, layers: true, calculator: false },
  cooling: { fields: ['durationMin', 'temperatureC', 'pressurePa'], optional: [], sources: false, gases: true, layers: false, calculator: false },
  unloading: { fields: ['durationMin', 'temperatureC'], optional: [], sources: false, gases: false, layers: false, calculator: false },
};

/** Fields of ONE coating layer of a multilayer card. */
export const LAYER_FIELDS: readonly StepFieldKey[] = ['material', 'thicknessNm', 'durationMin', 'temperatureC', 'pressurePa', 'substrateBiasV', 'rotationRpm', 'distanceMm'];
export const LAYER_OPTIONAL_FIELDS: readonly StepFieldKey[] = ['distanceMm'];

export const COATING_MODES = ['multi', 'single'] as const;
export type CoatingMode = typeof COATING_MODES[number];
export const COATING_MODE_LABELS: Record<CoatingMode, string> = { multi: 'многослойное (несколько слоёв)', single: 'однослойное (один слой)' };

/** A new id `${prefix}-N` one past the highest number in use among `existing`, re-checked against the whole set so it can
 *  never equal an existing id whatever the list holds (restored data, hand-edited ids, huge or non-numeric suffixes). */
export function nextId(prefix: string, existing: readonly { id: string }[]): string {
  const used = new Set(existing.map(item => item.id));
  const pattern = new RegExp(`^${prefix}-(\\d{1,9})$`);
  let max = 0;
  for (const id of used) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let n = max + 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

// ---------- legacy data (everything schema 1-3 carried that schema 4 has no place for) ----------

export type LegacyValue = string | number | boolean | null | LegacyValue[] | { [key: string]: LegacyValue };

/** One old field of a step that has no home in the new card (for example the old acceptance criterion). */
export interface LegacyField { key: string; label: string; value: LegacyValue }
export interface LegacyStepFields { stepId: string; stepName: string; fields: LegacyField[] }
/** A whole old step that has no card type in schema 4 (e.g. "Травление"): kept, not part of the process. */
export interface LegacyStep { id: string; originalOrder: number; name: string; originalType: string; /** The step was switched off in the old document; kept so a restored card is still off. */ enabled: boolean; fields: LegacyField[] }

export interface LegacyMagnetron { id: string; enabled: boolean; material?: string; powerW?: number; mode?: string }
export interface LegacyArc { id: string; enabled: boolean; cathodeMaterial?: string; arcCurrentA?: number; filtered: boolean }
export interface LegacyGasLine { id: string; gas: string; flow?: number; unit: string; enabled: boolean }
/** The complete old equipment registry (sections "Источники" and "Газовая система" of schema 1-3), copied as it was. */
export interface LegacyEquipment {
  magnetrons: LegacyMagnetron[];
  arcSources: LegacyArc[];
  icpRf: { enabled: boolean; powerW?: number; biasV?: number };
  ionSource: { enabled: boolean; voltageV?: number; currentA?: number; powerW?: number };
  gasLines: LegacyGasLine[];
}

export interface LegacyData {
  /** Schema the document was migrated from; absent for a document created in schema 4. */
  migratedFromSchema?: number;
  stepFields: LegacyStepFields[];
  steps: LegacyStep[];
  equipment?: LegacyEquipment;
}

export function createEmptyLegacy(): LegacyData { return { stepFields: [], steps: [] }; }
export function hasLegacyData(legacy: LegacyData): boolean {
  return legacy.stepFields.some(s => s.fields.length > 0) || legacy.steps.length > 0 || legacy.equipment !== undefined;
}

export const PRESSURE_UNITS = ['pa', 'mbar'] as const;
export type PressureUnit = typeof PRESSURE_UNITS[number];
export const DEFAULT_PRESSURE_UNIT: PressureUnit = 'pa';
export const PRESSURE_UNIT_LABELS: Record<PressureUnit, string> = { pa: 'Па', mbar: 'мбар' };

/** 1 mbar = 100 Pa, exactly. */
export const PA_PER_MBAR = 100;

export function isPressureUnit(value: unknown): value is PressureUnit {
  return typeof value === 'string' && (PRESSURE_UNITS as readonly string[]).includes(value);
}

// ---------- exact decimal handling of pressure values ----------
//
// Converting Pa <-> mbar is a shift of the decimal exponent by 2 (1 mbar = 100 Pa). It is done on
// the DECIMAL DIGITS of the number (its shortest round-trip text, which JavaScript guarantees
// identifies the double uniquely), never by multiplying/dividing doubles and rounding the
// result. That means:
//  - nothing is rounded: the canonical `pressurePa` keeps every digit its double carries;
//  - no floating-point noise appears (0.07 mbar is exactly 7 Pa, not 7.000000000000001);
//  - Pa -> mbar -> Pa returns the identical double, for every finite value;
//  - a value too small for a double in the TARGET unit can still be displayed (as text), and one
//    too small for the STORAGE unit is reported as underflow instead of silently becoming 0.
// IEEE-754 doubles themselves have ~15.95 significant decimal digits (17 are needed to identify
// every double): digits beyond what a double can hold are not representable anywhere, and this
// code neither invents nor claims them.

interface Decimal { negative: boolean; digits: string; exp10: number } // value = ±digits x 10^exp10

const ZERO: Decimal = { negative: false, digits: '0', exp10: 0 };
const EXPONENT_CLAMP = 1_000_000; // beyond any double: classifies as over/underflow without exploding

function normalizeDecimal(negative: boolean, integer: string, fraction: string, exponent: number): Decimal {
  let digits = integer + fraction;
  let exp10 = exponent - fraction.length;
  digits = digits.replace(/^0+/, '');
  if (digits === '') return ZERO;
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  if (trailing > 0) { digits = digits.slice(0, digits.length - trailing); exp10 += trailing; }
  return { negative, digits, exp10: Math.max(-EXPONENT_CLAMP, Math.min(EXPONENT_CLAMP, exp10)) };
}

/** The exact shortest decimal expansion of a finite double. */
function decimalOfNumber(value: number): Decimal | null {
  if (!Number.isFinite(value)) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(value)));
  if (!match) return null;
  const decimal = normalizeDecimal(false, match[1], match[2] ?? '', Number(match[3] ?? 0));
  return decimal.digits === '0' ? decimal : { ...decimal, negative: value < 0 };
}

const DECIMAL_TEXT_RE = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

/** Strict decimal syntax only (point or comma, optional exponent). Anything else is null. */
function decimalOfText(text: string): Decimal | null {
  const match = DECIMAL_TEXT_RE.exec(text.trim().replace(',', '.'));
  if (!match) return null;
  const exponent = Number(match[5] ?? 0);
  return normalizeDecimal(match[1] === '-', match[2] ?? '', match[3] ?? match[4] ?? '', Number.isFinite(exponent) ? exponent : Math.sign(exponent) * EXPONENT_CLAMP);
}

function shifted(decimal: Decimal, deltaExp10: number): Decimal {
  return decimal.digits === '0' ? decimal : { ...decimal, exp10: Math.max(-EXPONENT_CLAMP, Math.min(EXPONENT_CLAMP, decimal.exp10 + deltaExp10)) };
}

/** Nearest double to the decimal (JavaScript's own correctly-rounded parser). May be 0 (underflow)
 *  or Infinity (overflow) for a non-zero decimal - callers must check, see classify(). */
function decimalToNumber(decimal: Decimal): number {
  return decimal.digits === '0' ? 0 : Number(`${decimal.negative ? '-' : ''}${decimal.digits}e${decimal.exp10}`);
}

/** Decimal -> text in the same style JavaScript prints doubles: plain notation for 1e-6 <= |x| < 1e21,
 *  scientific otherwise. Works for magnitudes no double can hold. */
function decimalToText(decimal: Decimal): string {
  if (decimal.digits === '0') return '0';
  const { digits, exp10 } = decimal;
  const sign = decimal.negative ? '-' : '';
  const scientific = exp10 + digits.length - 1; // exponent of the first digit
  if (scientific >= -6 && scientific < 21) {
    if (exp10 >= 0) return `${sign}${digits}${'0'.repeat(exp10)}`;
    const pointAt = digits.length + exp10;
    return pointAt > 0 ? `${sign}${digits.slice(0, pointAt)}.${digits.slice(pointAt)}` : `${sign}0.${'0'.repeat(-pointAt)}${digits}`;
  }
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${mantissa}e${scientific >= 0 ? '+' : '-'}${Math.abs(scientific)}`;
}

/** Why a typed pressure could not be turned into a stored value. `underflow`: a non-zero number
 *  too small for a double (it would silently become 0). `overflow`: too large (Infinity). */
export type PressureParseResult =
  | { status: 'empty' }
  | { status: 'ok'; pa: number }
  | { status: 'invalid'; reason: 'not_a_number' | 'underflow' | 'overflow' };

/** Text typed in a pressure field in `unit` -> the canonical Pa, with an explicit reason when that
 *  is impossible. Accepts a decimal point or comma and scientific notation ("1e-5", "1,5E-3").
 *  A literal zero (also "-0", "0e-999") is a valid 0; a NON-zero value that does not fit in a double
 *  is reported as underflow - never silently stored as 0 or -0. A negative value is returned as the
 *  negative number it is (validateDocument rejects it with its own message). */
export function parsePressureText(text: string, unit: PressureUnit): PressureParseResult {
  if (text.trim() === '') return { status: 'empty' };
  const decimal = decimalOfText(text);
  if (!decimal) return { status: 'invalid', reason: 'not_a_number' };
  if (decimal.digits === '0') return { status: 'ok', pa: 0 };
  const pa = decimalToNumber(unit === 'mbar' ? shifted(decimal, 2) : decimal);
  if (!Number.isFinite(pa)) return { status: 'invalid', reason: 'overflow' };
  if (pa === 0) return { status: 'invalid', reason: 'underflow' };
  return { status: 'ok', pa };
}

/** The editor-facing form: an empty field is `undefined` ("not set"); anything unusable is NaN,
 *  which `validateDocument` rejects with a clear message (it can never become 0 or -0). */
export function parsePressureInput(text: string, unit: PressureUnit): number | undefined {
  const result = parsePressureText(text, unit);
  return result.status === 'empty' ? undefined : result.status === 'ok' ? result.pa : Number.NaN;
}

/** A number already held as a double, entered in `unit` -> the canonical Pa (exact decimal shift,
 *  no rounding). `undefined` stays `undefined`; 0 stays 0. A non-finite input passes through
 *  unchanged (validation rejects it); a result beyond the double range is Infinity (also rejected). */
export function pressureToPa(value: number | undefined, unit: PressureUnit): number | undefined {
  if (value === undefined) return undefined;
  if (unit === 'pa') return value;
  const decimal = decimalOfNumber(value);
  return decimal ? decimalToNumber(shifted(decimal, 2)) : value;
}

/** Legacy `pressureMbar` (schema 1) -> canonical Pa: the same exact decimal shift, applied once,
 *  when a schema-1 document is read. */
export function migrateMbarToPa(mbar: number): number {
  return pressureToPa(mbar, 'mbar') as number;
}

/** The canonical Pa as exact text in `unit` ("0.5" Pa -> "0.005" mbar). Unlike converting to a
 *  double first, this cannot underflow: 5e-324 Pa is "5e-326" mbar, not 0. */
export function paToDisplayText(pa: number | undefined, unit: PressureUnit): string | undefined {
  if (pa === undefined) return undefined;
  const decimal = decimalOfNumber(pa);
  if (!decimal) return String(pa);
  return decimalToText(unit === 'mbar' ? shifted(decimal, -2) : decimal);
}

/** What a number input should hold for this pressure: a NUMBER when the displayed text round-trips
 *  through a double unchanged (a number keeps React's numeric comparison, so typing "0.0050"
 *  is not rewritten under the user's hands), otherwise the exact TEXT (values a double cannot hold
 *  in the display unit, e.g. "5e-326" mbar). Never 0 for a positive pressure. */
export function paToDisplayInputValue(pa: number | undefined, unit: PressureUnit): number | string | undefined {
  const text = paToDisplayText(pa, unit);
  if (text === undefined) return undefined;
  const asNumber = Number(text);
  const decimalOfBack = Number.isFinite(asNumber) ? decimalOfNumber(asNumber) : null;
  return decimalOfBack && decimalToText(decimalOfBack) === text ? asNumber : text;
}

/** A document written by a newer schema than this build understands. */
export class UnsupportedSchemaVersionError extends Error {
  readonly schemaVersion: number;
  constructor(schemaVersion: number) {
    super(`Версия схемы документа (${schemaVersion}) новее поддерживаемой (${TECHDOC_SCHEMA_VERSION}). Документ не загружен и не изменён.`);
    this.name = 'UnsupportedSchemaVersionError';
    this.schemaVersion = schemaVersion;
  }
}
