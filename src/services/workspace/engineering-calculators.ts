/** Real, local, dependency-free engineering calculations for PVD/CVD/PECVD work - no
 *  external API, no network call, deterministic and independently verifiable formulas.
 *  This is the REAL production execution path for the "Engineering Calculators" workspace
 *  module (src/components/workspace/engineering-calculators.tsx) - unlike the other
 *  workspace modules, which still go through the demo provider (src/services/workspace),
 *  this one is genuinely computed from the user's own input. */

// ---------- deposition thickness / rate / time (d = v * t) ----------

export const THICKNESS_UNITS = ['nm', 'um'] as const;
export type ThicknessUnit = typeof THICKNESS_UNITS[number];
export const RATE_UNITS = ['nm_per_min', 'nm_per_s', 'um_per_h'] as const;
export type RateUnit = typeof RATE_UNITS[number];
export const TIME_UNITS = ['s', 'min', 'h'] as const;
export type TimeUnit = typeof TIME_UNITS[number];
export const DEPOSITION_SOLVE_FOR_OPTIONS = ['thickness', 'rate', 'time'] as const;
export type DepositionSolveFor = typeof DEPOSITION_SOLVE_FOR_OPTIONS[number];

export interface DepositionInput {
  solveFor: DepositionSolveFor;
  /** Required unless solveFor === 'thickness'. */
  thickness?: number;
  thicknessUnit: ThicknessUnit;
  /** Required unless solveFor === 'rate'. */
  rate?: number;
  rateUnit: RateUnit;
  /** Required unless solveFor === 'time'. */
  time?: number;
  timeUnit: TimeUnit;
}

export interface DepositionResult {
  solveFor: DepositionSolveFor;
  value: number;
  unit: ThicknessUnit | RateUnit | TimeUnit;
  formula: string;
}

const THICKNESS_TO_NM: Record<ThicknessUnit, number> = { nm: 1, um: 1000 };
const RATE_TO_NM_PER_MIN: Record<RateUnit, number> = { nm_per_min: 1, nm_per_s: 60, um_per_h: 1000 / 60 };
const TIME_TO_MIN: Record<TimeUnit, number> = { s: 1 / 60, min: 1, h: 60 };

const RATE_LABEL: Record<RateUnit, string> = { nm_per_min: 'нм/мин', nm_per_s: 'нм/с', um_per_h: 'мкм/ч' };
const THICKNESS_LABEL: Record<ThicknessUnit, string> = { nm: 'нм', um: 'мкм' };
const TIME_LABEL: Record<TimeUnit, string> = { s: 'с', min: 'мин', h: 'ч' };

function requirePositiveFinite(value: number | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: введите положительное число.`);
  }
  return value;
}

/** Runtime guard for the string-literal unit/preset fields (solveFor, thicknessUnit,
 *  rateUnit, timeUnit, pressureUnit, gas). TypeScript enforces these at compile time for
 *  callers written in TS, but nothing stopped an unexpected runtime value (e.g. a stray
 *  string) from reaching the arithmetic and silently producing NaN instead of a clear error
 *  (Codex regression - see the "runtime validation" test). */
function assertOneOf<T extends string>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) throw new Error(`${label}: недопустимое значение. Допустимо: ${allowed.join(', ')}.`);
  return value;
}

/** Solves thickness = rate * time for whichever ONE of the three the caller asks for,
 *  requiring the other two as real, validated (positive, finite) numbers - never silently
 *  substitutes a default or ignores what was actually typed. */
export function solveDeposition(input: DepositionInput): DepositionResult {
  assertOneOf(input.solveFor, DEPOSITION_SOLVE_FOR_OPTIONS, 'Искомая величина');
  assertOneOf(input.thicknessUnit, THICKNESS_UNITS, 'Единица толщины');
  assertOneOf(input.rateUnit, RATE_UNITS, 'Единица скорости');
  assertOneOf(input.timeUnit, TIME_UNITS, 'Единица времени');
  if (input.solveFor === 'thickness') {
    const rateNmMin = requirePositiveFinite(input.rate, 'Скорость осаждения') * RATE_TO_NM_PER_MIN[input.rateUnit];
    const timeMin = requirePositiveFinite(input.time, 'Время осаждения') * TIME_TO_MIN[input.timeUnit];
    const thicknessNm = rateNmMin * timeMin;
    const value = thicknessNm / THICKNESS_TO_NM[input.thicknessUnit];
    return { solveFor: 'thickness', value, unit: input.thicknessUnit, formula: `d = v × t = ${rateNmMin.toFixed(4)} нм/мин × ${timeMin.toFixed(4)} мин` };
  }
  if (input.solveFor === 'rate') {
    const thicknessNm = requirePositiveFinite(input.thickness, 'Толщина покрытия') * THICKNESS_TO_NM[input.thicknessUnit];
    const timeMin = requirePositiveFinite(input.time, 'Время осаждения') * TIME_TO_MIN[input.timeUnit];
    const rateNmMin = thicknessNm / timeMin;
    const value = rateNmMin / RATE_TO_NM_PER_MIN[input.rateUnit];
    return { solveFor: 'rate', value, unit: input.rateUnit, formula: `v = d / t = ${thicknessNm.toFixed(4)} нм / ${timeMin.toFixed(4)} мин` };
  }
  const thicknessNm = requirePositiveFinite(input.thickness, 'Толщина покрытия') * THICKNESS_TO_NM[input.thicknessUnit];
  const rateNmMin = requirePositiveFinite(input.rate, 'Скорость осаждения') * RATE_TO_NM_PER_MIN[input.rateUnit];
  const timeMin = thicknessNm / rateNmMin;
  const value = timeMin / TIME_TO_MIN[input.timeUnit];
  return { solveFor: 'time', value, unit: input.timeUnit, formula: `t = d / v = ${thicknessNm.toFixed(4)} нм / ${rateNmMin.toFixed(4)} нм/мин` };
}

export function depositionUnitLabel(unit: ThicknessUnit | RateUnit | TimeUnit): string {
  return THICKNESS_LABEL[unit as ThicknessUnit] ?? RATE_LABEL[unit as RateUnit] ?? TIME_LABEL[unit as TimeUnit] ?? unit;
}

// ---------- mean free path in vacuum (kinetic theory of gases) ----------

export const PRESSURE_UNITS = ['pa', 'mbar', 'torr'] as const;
export type PressureUnit = typeof PRESSURE_UNITS[number];
export const GAS_PRESETS = ['argon', 'nitrogen', 'custom'] as const;
export type GasPreset = typeof GAS_PRESETS[number];

export interface MeanFreePathInput {
  pressure: number;
  pressureUnit: PressureUnit;
  /** Celsius - converted to Kelvin internally. */
  temperatureC: number;
  gas: GasPreset;
  /** Required only when gas === 'custom'. Kinetic (collision) diameter, picometres. */
  customDiameterPm?: number;
}

export interface MeanFreePathResult {
  meanFreePathM: number;
  meanFreePathMm: number;
  formula: string;
}

const PRESSURE_TO_PA: Record<PressureUnit, number> = { pa: 1, mbar: 100, torr: 133.322 };
// Kinetic (collision) diameters, picometres - standard reference values (CRC Handbook order of
// magnitude); intentionally only the two gases most commonly used as PVD/CVD process/purge
// gases, plus an explicit custom option for anything else, rather than guessing at a value.
const GAS_DIAMETER_PM: Record<Exclude<GasPreset, 'custom'>, number> = { argon: 340, nitrogen: 364 };
const BOLTZMANN_J_PER_K = 1.380649e-23;

/** λ = kT / (√2 · π · d² · p) - the standard kinetic-theory mean free path formula. A
 *  well-established, independently verifiable physical relationship (see e.g. any vacuum
 *  technology reference), computed exactly, not approximated or looked up from a table. */
export function calculateMeanFreePath(input: MeanFreePathInput): MeanFreePathResult {
  assertOneOf(input.pressureUnit, PRESSURE_UNITS, 'Единица давления');
  assertOneOf(input.gas, GAS_PRESETS, 'Газ');
  const pressurePa = requirePositiveFinite(input.pressure, 'Давление');
  const temperatureK = input.temperatureC + 273.15;
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) throw new Error('Температура: значение должно быть выше абсолютного нуля (-273.15 °C).');
  const diameterPm = input.gas === 'custom' ? requirePositiveFinite(input.customDiameterPm, 'Диаметр молекулы газа') : GAS_DIAMETER_PM[input.gas];
  const pressureInPa = pressurePa * PRESSURE_TO_PA[input.pressureUnit];
  const diameterM = diameterPm * 1e-12;
  const meanFreePathM = (BOLTZMANN_J_PER_K * temperatureK) / (Math.SQRT2 * Math.PI * diameterM * diameterM * pressureInPa);
  return {
    meanFreePathM, meanFreePathMm: meanFreePathM * 1000,
    formula: `λ = kT / (√2·π·d²·p) при T = ${temperatureK.toFixed(2)} К, p = ${pressureInPa.toExponential(3)} Па, d = ${diameterPm} пм`,
  };
}
