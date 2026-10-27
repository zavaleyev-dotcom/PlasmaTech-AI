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
 *                                                           `sourceAssignments` (magnetron / arc
 *                                                           sources used on that step) and
 *                                                           `gasAssignments` (gas lines used on
 *                                                           that step); older documents get both
 *                                                           as empty lists - nothing is guessed
 *
 *  A document from a NEWER schema than this build knows is never parsed or converted: its
 *  structure is unknown, so guessing would risk silently corrupting it. */
export const TECHDOC_SCHEMA_VERSION = 3;

// ---------- per-step assignments of equipment (schema 3) ----------

export const SOURCE_KINDS = ['magnetron', 'arc'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = { magnetron: 'Магнетрон', arc: 'Дуговой источник' };

export const ASSIGNMENT_MODES = ['parallel', 'sequential'] as const;
export type AssignmentMode = typeof ASSIGNMENT_MODES[number];
export const ASSIGNMENT_MODE_LABELS: Record<AssignmentMode, string> = { parallel: 'одновременно', sequential: 'последовательно' };

/** What "sequential" means, stated once and used by validation, previews and exports alike: during
 *  its own interval NO other enabled source of the same step is running (touching at an
 *  endpoint is allowed). "Parallel" places no constraint on overlap. */
export const SEQUENTIAL_MODE_MEANING = 'интервал работы источника не пересекается с интервалами других включённых источников этого этапа (касание границ допускается; длительность 0 мин означает, что работы нет, и пересечением не считается)';

/** The meaning of the flow unit used for gas on a step - the app never converts other units into it. */
export const SCCM_MEANING = 'sccm - стандартные см³/мин; условия приведения (температура, давление) определяются оборудованием и приложением не пересчитываются';

/** One equipment source USED on one step. The source itself (its material, nominal values, filtered
 *  flag) lives only in section D and is referenced by `sourceId` + `kind` (ids are unique per
 *  kind, so "magnetron-1" and "arc-1" are different sources): the assignment never carries its own
 *  copy of a material. `enabled` is ON/OFF on THIS step; OFF is a deliberate state, different from
 *  an ON source whose power/current/time are simply not filled in (`undefined`). Times are minutes
 *  from the start of the step. */
export interface StepSourceAssignment {
  sourceId: string;
  kind: SourceKind;
  enabled: boolean;
  /** Power of a magnetron on this step (never set for an arc source). */
  powerW?: number;
  /** Arc current on this step (never set for a magnetron). */
  currentA?: number;
  startMin?: number;
  durationMin?: number;
  mode: AssignmentMode;
}

/** One gas line of section E used on one step. The gas itself comes from the line (single source of
 *  truth, like a source's material). `flowSccm` is always sccm. */
export interface StepGasAssignment {
  lineId: string;
  enabled: boolean;
  flowSccm?: number;
  startMin?: number;
  durationMin?: number;
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
