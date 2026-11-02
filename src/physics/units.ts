/** The registry of units and the exact conversions between them.
 *
 *  A strictly typed table, deliberately NOT a parser of free text expressions: every unit is an entry with a stable identifier (`UnitId`), a quantity kind (and so a
 *  dimension) and an EXACT rational factor to the coherent SI unit of that kind (plus an exact offset for the affine temperature scale °C). Conversion goes
 *  value -> SI -> target in exact rational arithmetic (exact.ts) and rounds once, at the end. Mismatched dimensions, impossible values (below absolute zero, a
 *  negative absolute pressure, a negative mass), non-finite numbers, overflow and underflow are refused with a PhysicsError, never "repaired". */

import {
  type Dimension, dimEquals, formatDimension, LENGTH, MASS, TIME, CURRENT, TEMPERATURE, AMOUNT, LUMINOUS_INTENSITY, VOLTAGE, POWER, ENERGY, MAGNETIC_INDUCTION, PRESSURE, DIMENSIONLESS,
  AREA, VOLUME, VELOCITY, VOLUME_FLOW, CURRENT_DENSITY, POWER_DENSITY, NUMBER_DENSITY, MASS_DENSITY, FREQUENCY, ELECTRIC_CHARGE,
  THERMAL_CONDUCTIVITY, SPECIFIC_HEAT, THERMAL_EXPANSION, RESISTANCE, RESISTIVITY, CONDUCTIVITY, MOLAR_MASS, FIELD_STRENGTH, THERMAL_DIFFUSIVITY,
} from './dimensions';
import { type Rational, rational, rationalFromDecimalText, rationalFromNumber, rationalToNumber, add, sub, mul, div, ZERO, isZero, sign } from './exact';
import { PhysicsError } from './errors';
import { deepFreeze } from './freeze';
import { requireFinite, requireNoOverflow, requireNoUnderflow } from './guards';

// ---------- quantity kinds ----------

export interface QuantityKindSpec {
  readonly dimension: Dimension;
  /** IDENTIFIER (a key of UNITS) of the coherent SI unit of the kind; the display symbol is UNITS[siUnit].symbol. */
  readonly siUnit: string;
  readonly nameRu: string;
  /** The kind cannot be negative as a PHYSICAL quantity (temperature: absolute zero; mass; absolute pressure; amount of substance; luminous intensity).
   *  Gauge-pressure-like or signed uses must say so with `allowNegative`. */
  readonly nonNegative: boolean;
  /** What a value below the limit means, for the message. */
  readonly limitRu?: string;
  /** `false` marks a SEMANTIC kind: one whose meaning is not fixed by its dimension (temperature difference, gauge pressure, magnetic field strength H,
   *  magnetization M, elastic modulus). It never takes part in a product, quotient or power as an operand - except where the operation provably keeps its meaning
   *  (scaling by a dimensionless quantity, the power 1 and 0, a ratio of two quantities of the SAME kind): see uncertainty.ts. */
  readonly derivable?: boolean;
}

export const QUANTITY_KINDS = deepFreeze({
  length: { dimension: LENGTH, siUnit: 'm', nameRu: 'длина', nonNegative: false },
  time: { dimension: TIME, siUnit: 's', nameRu: 'время', nonNegative: false },
  mass: { dimension: MASS, siUnit: 'kg', nameRu: 'масса', nonNegative: true, limitRu: 'масса не может быть отрицательной' },
  temperature: { dimension: TEMPERATURE, siUnit: 'K', nameRu: 'температура', nonNegative: true, limitRu: 'температура не может быть ниже абсолютного нуля (0 K = -273,15 °C)' },
  current: { dimension: CURRENT, siUnit: 'A', nameRu: 'электрический ток', nonNegative: false },
  voltage: { dimension: VOLTAGE, siUnit: 'V', nameRu: 'электрическое напряжение', nonNegative: false },
  power: { dimension: POWER, siUnit: 'W', nameRu: 'мощность', nonNegative: false },
  energy: { dimension: ENERGY, siUnit: 'J', nameRu: 'энергия', nonNegative: false },
  magneticInduction: { dimension: MAGNETIC_INDUCTION, siUnit: 'T', nameRu: 'магнитная индукция', nonNegative: false },
  pressure: { dimension: PRESSURE, siUnit: 'Pa', nameRu: 'давление (абсолютное)', nonNegative: true, limitRu: 'абсолютное давление не может быть отрицательным' },
  amount: { dimension: AMOUNT, siUnit: 'mol', nameRu: 'количество вещества', nonNegative: true, limitRu: 'количество вещества не может быть отрицательным' },
  luminousIntensity: { dimension: LUMINOUS_INTENSITY, siUnit: 'cd', nameRu: 'сила света', nonNegative: true, limitRu: 'сила света не может быть отрицательной' },
  dimensionless: { dimension: DIMENSIONLESS, siUnit: 'one', nameRu: 'безразмерная величина', nonNegative: false },
  // Same SI dimension as `temperature` / `pressure`, DIFFERENT physical kind: the registry never converts between them implicitly.
  temperatureDifference: { dimension: TEMPERATURE, siUnit: 'K_delta', nameRu: 'разность (интервал) температур', nonNegative: false, derivable: false },
  gaugePressure: { dimension: PRESSURE, siUnit: 'Pa_g', nameRu: 'избыточное (манометрическое) давление', nonNegative: false, derivable: false },
  // derived kinds (M1.2): each has its own unit table; products and quotients of quantities land on them through kindOfDimension
  area: { dimension: AREA, siUnit: 'm2', nameRu: 'площадь', nonNegative: true, limitRu: 'площадь не может быть отрицательной' },
  volume: { dimension: VOLUME, siUnit: 'm3', nameRu: 'объём', nonNegative: true, limitRu: 'объём не может быть отрицательным' },
  velocity: { dimension: VELOCITY, siUnit: 'm_s', nameRu: 'скорость (в т. ч. скорость осаждения/травления)', nonNegative: false },
  volumeFlow: { dimension: VOLUME_FLOW, siUnit: 'm3_s', nameRu: 'объёмный расход', nonNegative: false },
  currentDensity: { dimension: CURRENT_DENSITY, siUnit: 'A_m2', nameRu: 'плотность тока', nonNegative: false },
  powerDensity: { dimension: POWER_DENSITY, siUnit: 'W_m2', nameRu: 'плотность мощности', nonNegative: false },
  numberDensity: { dimension: NUMBER_DENSITY, siUnit: 'per_m3', nameRu: 'концентрация (число частиц в единице объёма)', nonNegative: true, limitRu: 'концентрация не может быть отрицательной' },
  massDensity: { dimension: MASS_DENSITY, siUnit: 'kg_m3', nameRu: 'плотность (массовая)', nonNegative: true, limitRu: 'плотность не может быть отрицательной' },
  frequency: { dimension: FREQUENCY, siUnit: 'Hz', nameRu: 'частота', nonNegative: true, limitRu: 'частота не может быть отрицательной' },
  electricCharge: { dimension: ELECTRIC_CHARGE, siUnit: 'C', nameRu: 'электрический заряд', nonNegative: false },
  // property kinds (M1.3.0). A kind that shares its SI dimension with another kind is semantic (derivable: false) where its meaning must not be guessed.
  thermalConductivity: { dimension: THERMAL_CONDUCTIVITY, siUnit: 'W_mK', nameRu: 'теплопроводность', nonNegative: true, limitRu: 'теплопроводность не может быть отрицательной' },
  specificHeatCapacity: { dimension: SPECIFIC_HEAT, siUnit: 'J_kgK', nameRu: 'удельная теплоёмкость', nonNegative: true, limitRu: 'удельная теплоёмкость не может быть отрицательной' },
  linearExpansionCoefficient: { dimension: THERMAL_EXPANSION, siUnit: 'per_K', nameRu: 'коэффициент линейного теплового расширения', nonNegative: false },
  resistance: { dimension: RESISTANCE, siUnit: 'Ohm', nameRu: 'электрическое сопротивление', nonNegative: false },
  resistivity: { dimension: RESISTIVITY, siUnit: 'Ohm_m', nameRu: 'удельное электрическое сопротивление', nonNegative: true, limitRu: 'удельное сопротивление не может быть отрицательным' },
  electricalConductivity: { dimension: CONDUCTIVITY, siUnit: 'S_m', nameRu: 'удельная электрическая проводимость', nonNegative: true, limitRu: 'проводимость не может быть отрицательной' },
  molarMass: { dimension: MOLAR_MASS, siUnit: 'kg_mol', nameRu: 'молярная масса', nonNegative: true, limitRu: 'молярная масса не может быть отрицательной' },
  magneticFieldStrength: { dimension: FIELD_STRENGTH, siUnit: 'A_m_H', nameRu: 'напряжённость магнитного поля', nonNegative: false, derivable: false },
  magnetization: { dimension: FIELD_STRENGTH, siUnit: 'A_m_M', nameRu: 'намагниченность', nonNegative: false, derivable: false },
  elasticModulus: { dimension: PRESSURE, siUnit: 'Pa_mod', nameRu: 'модуль упругости', nonNegative: true, limitRu: 'модуль упругости не может быть отрицательным', derivable: false },
  thermalDiffusivity: { dimension: THERMAL_DIFFUSIVITY, siUnit: 'm2_s', nameRu: 'коэффициент температуропроводности', nonNegative: true, limitRu: 'температуропроводность не может быть отрицательной' },
} as const satisfies Record<string, QuantityKindSpec>);

export type QuantityKind = keyof typeof QUANTITY_KINDS;
export const QUANTITY_KIND_IDS: readonly QuantityKind[] = Object.freeze(Object.keys(QUANTITY_KINDS) as QuantityKind[]);

// ---------- the unit registry ----------

export interface UnitSpec {
  readonly symbol: string;
  readonly nameRu: string;
  readonly kind: QuantityKind;
  /** value in the coherent SI unit = value in this unit * factor + offset. EXACT rationals. */
  readonly factor: Rational;
  readonly offset: Rational;
  /** The definition that makes the factor exact, with where it comes from. */
  readonly basis: string;
}

const decimal = (text: string): Rational => rationalFromDecimalText(text);
const fraction = (n: number, d: number): Rational => rational(BigInt(n), BigInt(d));
function unit<K extends QuantityKind>(kind: K, symbol: string, nameRu: string, factor: Rational, basis: string, offset: Rational = ZERO): UnitSpec & { readonly kind: K } {
  return { kind, symbol, nameRu, factor, offset, basis };
}

const SI = 'Единица СИ (или десятичная кратная/дольная ей).';
const SI_EXACT_EV = 'Точно с 2019 г.: 1 эВ = 1,602176634e-19 Дж, так как элементарный заряд e = 1,602176634e-19 Кл фиксирован определением СИ (Брошюра СИ, 9-е изд., 2019).';

/** Every unit the physics core knows. The key is the stable identifier stored in data; the symbol is for display. */
export const UNITS = deepFreeze({
  // length
  m: unit('length', 'м', 'метр', decimal('1'), SI),
  km: unit('length', 'км', 'километр', decimal('1e3'), SI),
  cm: unit('length', 'см', 'сантиметр', decimal('1e-2'), SI),
  mm: unit('length', 'мм', 'миллиметр', decimal('1e-3'), SI),
  um: unit('length', 'мкм', 'микрометр', decimal('1e-6'), SI),
  nm: unit('length', 'нм', 'нанометр', decimal('1e-9'), SI),
  angstrom: unit('length', 'Å', 'ангстрем', decimal('1e-10'), 'Точно: 1 Å = 1e-10 м (внесистемная единица, определена через метр).'),
  pm: unit('length', 'пм', 'пикометр', decimal('1e-12'), SI),
  // time
  s: unit('time', 'с', 'секунда', decimal('1'), SI),
  ms: unit('time', 'мс', 'миллисекунда', decimal('1e-3'), SI),
  us: unit('time', 'мкс', 'микросекунда', decimal('1e-6'), SI),
  min: unit('time', 'мин', 'минута', decimal('60'), 'Точно: 1 мин = 60 с (допустима к применению с СИ).'),
  h: unit('time', 'ч', 'час', decimal('3600'), 'Точно: 1 ч = 3600 с (допустима к применению с СИ).'),
  d: unit('time', 'сут', 'сутки', decimal('86400'), 'Точно: 1 сут = 86400 с (допустима к применению с СИ).'),
  // mass
  kg: unit('mass', 'кг', 'килограмм', decimal('1'), SI),
  g: unit('mass', 'г', 'грамм', decimal('1e-3'), SI),
  mg: unit('mass', 'мг', 'миллиграмм', decimal('1e-6'), SI),
  ug: unit('mass', 'мкг', 'микрограмм', decimal('1e-9'), SI),
  t: unit('mass', 'т', 'тонна', decimal('1e3'), 'Точно: 1 т = 1000 кг (допустима к применению с СИ).'),
  // temperature: K is coherent; °C is the affine scale with its zero at 273.15 K exactly (by definition)
  K: unit('temperature', 'K', 'кельвин', decimal('1'), SI),
  degC: unit('temperature', '°C', 'градус Цельсия', decimal('1'), 'Точно: T[K] = t[°C] + 273,15 (шкала Цельсия определена через кельвин; шаг градуса равен кельвину).', decimal('273.15')),
  // electric current
  A: unit('current', 'А', 'ампер', decimal('1'), SI),
  kA: unit('current', 'кА', 'килоампер', decimal('1e3'), SI),
  mA: unit('current', 'мА', 'миллиампер', decimal('1e-3'), SI),
  uA: unit('current', 'мкА', 'микроампер', decimal('1e-6'), SI),
  // voltage
  V: unit('voltage', 'В', 'вольт', decimal('1'), SI),
  kV: unit('voltage', 'кВ', 'киловольт', decimal('1e3'), SI),
  mV: unit('voltage', 'мВ', 'милливольт', decimal('1e-3'), SI),
  // power
  W: unit('power', 'Вт', 'ватт', decimal('1'), SI),
  kW: unit('power', 'кВт', 'киловатт', decimal('1e3'), SI),
  MW: unit('power', 'МВт', 'мегаватт', decimal('1e6'), SI),
  mW: unit('power', 'мВт', 'милливатт', decimal('1e-3'), SI),
  // energy
  J: unit('energy', 'Дж', 'джоуль', decimal('1'), SI),
  kJ: unit('energy', 'кДж', 'килоджоуль', decimal('1e3'), SI),
  mJ: unit('energy', 'мДж', 'миллиджоуль', decimal('1e-3'), SI),
  eV: unit('energy', 'эВ', 'электронвольт', decimal('1.602176634e-19'), SI_EXACT_EV),
  keV: unit('energy', 'кэВ', 'килоэлектронвольт', decimal('1.602176634e-16'), SI_EXACT_EV),
  Wh: unit('energy', 'Вт·ч', 'ватт-час', decimal('3600'), 'Точно: 1 Вт·ч = 3600 Дж.'),
  kWh: unit('energy', 'кВт·ч', 'киловатт-час', decimal('3.6e6'), 'Точно: 1 кВт·ч = 3,6e6 Дж.'),
  // magnetic induction
  T: unit('magneticInduction', 'Тл', 'тесла', decimal('1'), SI),
  mT: unit('magneticInduction', 'мТл', 'миллитесла', decimal('1e-3'), SI),
  uT: unit('magneticInduction', 'мкТл', 'микротесла', decimal('1e-6'), SI),
  G: unit('magneticInduction', 'Гс', 'гаусс', decimal('1e-4'), 'Точно: 1 Гс = 1e-4 Тл (СГС-Гаусс).'),
  // pressure (absolute)
  Pa: unit('pressure', 'Па', 'паскаль', decimal('1'), SI),
  hPa: unit('pressure', 'гПа', 'гектопаскаль', decimal('100'), SI),
  kPa: unit('pressure', 'кПа', 'килопаскаль', decimal('1e3'), SI),
  MPa: unit('pressure', 'МПа', 'мегапаскаль', decimal('1e6'), SI),
  bar: unit('pressure', 'бар', 'бар', decimal('1e5'), 'Точно: 1 бар = 100000 Па (допустима к применению с СИ).'),
  mbar: unit('pressure', 'мбар', 'миллибар', decimal('100'), 'Точно: 1 мбар = 100 Па (= 1 гПа).'),
  ubar: unit('pressure', 'мкбар', 'микробар', decimal('0.1'), 'Точно: 1 мкбар = 0,1 Па.'),
  atm: unit('pressure', 'атм', 'стандартная атмосфера', decimal('101325'), 'Точно: 1 атм = 101325 Па (10-я Генеральная конференция по мерам и весам, 1954).'),
  Torr: unit('pressure', 'Торр', 'торр', fraction(101325, 760), 'Точно: 1 Торр = 101325/760 Па (1/760 стандартной атмосферы) ≈ 133,3223684 Па; не равно 133,322 Па.'),
  mTorr: unit('pressure', 'мТорр', 'миллиторр', fraction(101325, 760000), 'Точно: 1 мТорр = 101325/760000 Па.'),
  // gauge (relative) pressure: the SAME numeric factors as the absolute units, a DIFFERENT kind - it may be negative (vacuum gauge) and is converted to an absolute
  // pressure only against an explicit reference pressure (gaugeToAbsolute in quantity.ts)
  Pa_g: unit('gaugePressure', 'Па (изб.)', 'паскаль избыточный', decimal('1'), 'Избыточное давление относительно ЗАДАННОГО опорного; множитель как у Па.'),
  kPa_g: unit('gaugePressure', 'кПа (изб.)', 'килопаскаль избыточный', decimal('1e3'), 'Избыточное давление; множитель как у кПа.'),
  MPa_g: unit('gaugePressure', 'МПа (изб.)', 'мегапаскаль избыточный', decimal('1e6'), 'Избыточное давление; множитель как у МПа.'),
  mbar_g: unit('gaugePressure', 'мбар (изб.)', 'миллибар избыточный', decimal('100'), 'Избыточное давление; 1 мбар = 100 Па.'),
  bar_g: unit('gaugePressure', 'бар (изб.)', 'бар избыточный', decimal('1e5'), 'Избыточное давление; 1 бар = 100000 Па.'),
  Torr_g: unit('gaugePressure', 'Торр (изб.)', 'торр избыточный', fraction(101325, 760), 'Избыточное давление; 1 Торр = 101325/760 Па.'),
  // temperature DIFFERENCE (interval): no affine offset - an interval of 10 °C is an interval of 10 K. Not convertible to/from the absolute scales.
  K_delta: unit('temperatureDifference', 'K (разн.)', 'кельвин (разность температур)', decimal('1'), 'Интервал температур; 1 K_delta = 1 degC_delta точно (шаг градуса Цельсия равен кельвину).'),
  degC_delta: unit('temperatureDifference', '°C (разн.)', 'градус Цельсия (разность температур)', decimal('1'), 'Интервал температур; смещения нет.'),
  // area, volume
  m2: unit('area', 'м²', 'квадратный метр', decimal('1'), SI),
  cm2: unit('area', 'см²', 'квадратный сантиметр', decimal('1e-4'), 'Точно: 1 см² = 1e-4 м².'),
  mm2: unit('area', 'мм²', 'квадратный миллиметр', decimal('1e-6'), 'Точно: 1 мм² = 1e-6 м².'),
  m3: unit('volume', 'м³', 'кубический метр', decimal('1'), SI),
  L: unit('volume', 'л', 'литр', decimal('1e-3'), 'Точно: 1 л = 1 дм³ = 1e-3 м³ (допустима к применению с СИ).'),
  mL: unit('volume', 'мл', 'миллилитр', decimal('1e-6'), 'Точно: 1 мл = 1 см³ = 1e-6 м³.'),
  cm3: unit('volume', 'см³', 'кубический сантиметр', decimal('1e-6'), 'Точно: 1 см³ = 1e-6 м³.'),
  mm3: unit('volume', 'мм³', 'кубический миллиметр', decimal('1e-9'), 'Точно: 1 мм³ = 1e-9 м³.'),
  // velocity (deposition / etch rates)
  m_s: unit('velocity', 'м/с', 'метр в секунду', decimal('1'), SI),
  cm_s: unit('velocity', 'см/с', 'сантиметр в секунду', decimal('1e-2'), 'Точно: 1 см/с = 1e-2 м/с.'),
  mm_s: unit('velocity', 'мм/с', 'миллиметр в секунду', decimal('1e-3'), 'Точно: 1 мм/с = 1e-3 м/с.'),
  um_s: unit('velocity', 'мкм/с', 'микрометр в секунду', decimal('1e-6'), 'Точно: 1 мкм/с = 1e-6 м/с.'),
  nm_s: unit('velocity', 'нм/с', 'нанометр в секунду', decimal('1e-9'), 'Точно: 1 нм/с = 1e-9 м/с.'),
  angstrom_s: unit('velocity', 'Å/с', 'ангстрем в секунду', decimal('1e-10'), 'Точно: 1 Å/с = 1e-10 м/с.'),
  nm_min: unit('velocity', 'нм/мин', 'нанометр в минуту', fraction(1, 60000000000), 'Точно: 1 нм/мин = 1e-9/60 м/с.'),
  um_min: unit('velocity', 'мкм/мин', 'микрометр в минуту', fraction(1, 60000000), 'Точно: 1 мкм/мин = 1e-6/60 м/с.'),
  um_h: unit('velocity', 'мкм/ч', 'микрометр в час', fraction(1, 3600000000), 'Точно: 1 мкм/ч = 1e-6/3600 м/с.'),
  km_h: unit('velocity', 'км/ч', 'километр в час', fraction(5, 18), 'Точно: 1 км/ч = 1000/3600 = 5/18 м/с.'),
  // volumetric flow (NOT sccm/slm: they depend on a reference state and are a separate, later decision)
  m3_s: unit('volumeFlow', 'м³/с', 'кубический метр в секунду', decimal('1'), SI),
  L_s: unit('volumeFlow', 'л/с', 'литр в секунду', decimal('1e-3'), 'Точно: 1 л/с = 1e-3 м³/с.'),
  L_min: unit('volumeFlow', 'л/мин', 'литр в минуту', fraction(1, 60000), 'Точно: 1 л/мин = 1e-3/60 м³/с.'),
  cm3_s: unit('volumeFlow', 'см³/с', 'кубический сантиметр в секунду', decimal('1e-6'), 'Точно: 1 см³/с = 1e-6 м³/с.'),
  cm3_min: unit('volumeFlow', 'см³/мин', 'кубический сантиметр в минуту', fraction(1, 60000000), 'Точно: 1 см³/мин = 1e-6/60 м³/с.'),
  m3_h: unit('volumeFlow', 'м³/ч', 'кубический метр в час', fraction(1, 3600), 'Точно: 1 м³/ч = 1/3600 м³/с.'),
  // current density, power density
  A_m2: unit('currentDensity', 'А/м²', 'ампер на квадратный метр', decimal('1'), SI),
  mA_cm2: unit('currentDensity', 'мА/см²', 'миллиампер на квадратный сантиметр', decimal('10'), 'Точно: 1 мА/см² = 1e-3 А / 1e-4 м² = 10 А/м².'),
  uA_cm2: unit('currentDensity', 'мкА/см²', 'микроампер на квадратный сантиметр', decimal('1e-2'), 'Точно: 1 мкА/см² = 1e-2 А/м².'),
  A_cm2: unit('currentDensity', 'А/см²', 'ампер на квадратный сантиметр', decimal('1e4'), 'Точно: 1 А/см² = 1e4 А/м².'),
  W_m2: unit('powerDensity', 'Вт/м²', 'ватт на квадратный метр', decimal('1'), SI),
  kW_m2: unit('powerDensity', 'кВт/м²', 'киловатт на квадратный метр', decimal('1e3'), SI),
  mW_cm2: unit('powerDensity', 'мВт/см²', 'милливатт на квадратный сантиметр', decimal('10'), 'Точно: 1 мВт/см² = 1e-3 Вт / 1e-4 м² = 10 Вт/м².'),
  W_cm2: unit('powerDensity', 'Вт/см²', 'ватт на квадратный сантиметр', decimal('1e4'), 'Точно: 1 Вт/см² = 1e4 Вт/м².'),
  // number density, mass density, frequency, charge
  per_m3: unit('numberDensity', 'м⁻³', 'на кубический метр', decimal('1'), SI),
  per_cm3: unit('numberDensity', 'см⁻³', 'на кубический сантиметр', decimal('1e6'), 'Точно: 1 см⁻³ = 1e6 м⁻³.'),
  kg_m3: unit('massDensity', 'кг/м³', 'килограмм на кубический метр', decimal('1'), SI),
  g_cm3: unit('massDensity', 'г/см³', 'грамм на кубический сантиметр', decimal('1e3'), 'Точно: 1 г/см³ = 1e-3 кг / 1e-6 м³ = 1000 кг/м³.'),
  Hz: unit('frequency', 'Гц', 'герц', decimal('1'), SI),
  kHz: unit('frequency', 'кГц', 'килогерц', decimal('1e3'), SI),
  MHz: unit('frequency', 'МГц', 'мегагерц', decimal('1e6'), SI),
  GHz: unit('frequency', 'ГГц', 'гигагерц', decimal('1e9'), SI),
  C: unit('electricCharge', 'Кл', 'кулон', decimal('1'), SI),
  mC: unit('electricCharge', 'мКл', 'милликулон', decimal('1e-3'), SI),
  uC: unit('electricCharge', 'мкКл', 'микрокулон', decimal('1e-6'), SI),
  Ah: unit('electricCharge', 'А·ч', 'ампер-час', decimal('3600'), 'Точно: 1 А·ч = 3600 Кл.'),
  // thermal conductivity, specific heat, thermal expansion
  W_mK: unit('thermalConductivity', 'Вт/(м·К)', 'ватт на метр-кельвин', decimal('1'), SI),
  mW_mK: unit('thermalConductivity', 'мВт/(м·К)', 'милливатт на метр-кельвин', decimal('1e-3'), SI),
  W_cmK: unit('thermalConductivity', 'Вт/(см·К)', 'ватт на сантиметр-кельвин', decimal('100'), 'Точно: 1 Вт/(см·К) = 1 Вт / (1e-2 м · К) = 100 Вт/(м·К).'),
  J_kgK: unit('specificHeatCapacity', 'Дж/(кг·К)', 'джоуль на килограмм-кельвин', decimal('1'), SI),
  kJ_kgK: unit('specificHeatCapacity', 'кДж/(кг·К)', 'килоджоуль на килограмм-кельвин', decimal('1e3'), SI),
  J_gK: unit('specificHeatCapacity', 'Дж/(г·К)', 'джоуль на грамм-кельвин', decimal('1e3'), 'Точно: 1 Дж/(г·К) = 1 Дж / (1e-3 кг · К) = 1000 Дж/(кг·К).'),
  per_K: unit('linearExpansionCoefficient', 'К⁻¹', 'на кельвин', decimal('1'), 'Единица СИ. Значение относится к интервалу температур: определение (касательное или среднее от опорной температуры) задаётся условиями свойства, не единицей.'),
  per_degC: unit('linearExpansionCoefficient', '°C⁻¹', 'на градус Цельсия', decimal('1'), 'Точно: 1 °C⁻¹ = 1 К⁻¹ (шаг градуса равен кельвину; это обратная величина ИНТЕРВАЛА температур, смещение 273,15 не применяется).'),
  ppm_K: unit('linearExpansionCoefficient', '10⁻⁶ К⁻¹', 'миллионная доля на кельвин', decimal('1e-6'), 'Точно: 1e-6 К⁻¹.'),
  // electrical resistance, resistivity, conductivity
  Ohm: unit('resistance', 'Ом', 'ом', decimal('1'), 'Единица СИ: 1 Ом = 1 В/А.'),
  mOhm: unit('resistance', 'мОм', 'миллиом', decimal('1e-3'), SI),
  kOhm: unit('resistance', 'кОм', 'килоом', decimal('1e3'), SI),
  MOhm: unit('resistance', 'МОм', 'мегаом', decimal('1e6'), SI),
  Ohm_m: unit('resistivity', 'Ом·м', 'ом-метр', decimal('1'), 'Единица СИ: 1 Ом·м = 1 В·м/А.'),
  Ohm_cm: unit('resistivity', 'Ом·см', 'ом-сантиметр', decimal('1e-2'), 'Точно: 1 Ом·см = 1 Ом · 1e-2 м = 1e-2 Ом·м.'),
  uOhm_cm: unit('resistivity', 'мкОм·см', 'микроом-сантиметр', decimal('1e-8'), 'Точно: 1 мкОм·см = 1e-6 Ом · 1e-2 м = 1e-8 Ом·м.'),
  nOhm_m: unit('resistivity', 'нОм·м', 'наноом-метр', decimal('1e-9'), 'Точно: 1 нОм·м = 1e-9 Ом·м.'),
  S_m: unit('electricalConductivity', 'См/м', 'сименс на метр', decimal('1'), 'Единица СИ: 1 См/м = 1/(Ом·м).'),
  S_cm: unit('electricalConductivity', 'См/см', 'сименс на сантиметр', decimal('100'), 'Точно: 1 См/см = 1 См / 1e-2 м = 100 См/м.'),
  MS_m: unit('electricalConductivity', 'МСм/м', 'мегасименс на метр', decimal('1e6'), SI),
  // molar mass
  kg_mol: unit('molarMass', 'кг/моль', 'килограмм на моль', decimal('1'), SI),
  g_mol: unit('molarMass', 'г/моль', 'грамм на моль', decimal('1e-3'), 'Точно: 1 г/моль = 1e-3 кг/моль.'),
  // magnetic field strength H and magnetization M (same SI dimension A/m, different quantities)
  A_m_H: unit('magneticFieldStrength', 'А/м', 'ампер на метр (напряжённость поля)', decimal('1'), SI),
  kA_m_H: unit('magneticFieldStrength', 'кА/м', 'килоампер на метр (напряжённость поля)', decimal('1e3'), SI),
  A_m_M: unit('magnetization', 'А/м', 'ампер на метр (намагниченность)', decimal('1'), SI),
  kA_m_M: unit('magnetization', 'кА/м', 'килоампер на метр (намагниченность)', decimal('1e3'), SI),
  emu_cm3: unit('magnetization', 'эме/см³', 'электромагнитная единица на кубический сантиметр', decimal('1e3'), 'Точно: 1 эме = 1 абампер·см² = 10 А · 1e-4 м² = 1e-3 А·м²; 1 эме/см³ = 1e-3 А·м² / 1e-6 м³ = 1000 А/м. (Эрстед не включён: 1 Э = 1000/(4π) А/м — иррациональный коэффициент.)'),
  // elastic modulus (same SI dimension as pressure, a different quantity)
  Pa_mod: unit('elasticModulus', 'Па (модуль)', 'паскаль (модуль упругости)', decimal('1'), SI),
  MPa_mod: unit('elasticModulus', 'МПа (модуль)', 'мегапаскаль (модуль упругости)', decimal('1e6'), SI),
  GPa_mod: unit('elasticModulus', 'ГПа (модуль)', 'гигапаскаль (модуль упругости)', decimal('1e9'), 'Точно: 1 ГПа = 1e9 Па.'),
  // thermal diffusivity
  m2_s: unit('thermalDiffusivity', 'м²/с', 'квадратный метр в секунду', decimal('1'), SI),
  cm2_s: unit('thermalDiffusivity', 'см²/с', 'квадратный сантиметр в секунду', decimal('1e-4'), 'Точно: 1 см²/с = 1e-4 м²/с.'),
  mm2_s: unit('thermalDiffusivity', 'мм²/с', 'квадратный миллиметр в секунду', decimal('1e-6'), 'Точно: 1 мм²/с = 1e-6 м²/с.'),
  // amount of substance and luminous intensity (the two remaining SI base dimensions)
  mol: unit('amount', 'моль', 'моль', decimal('1'), SI),
  mmol: unit('amount', 'ммоль', 'миллимоль', decimal('1e-3'), SI),
  cd: unit('luminousIntensity', 'кд', 'кандела', decimal('1'), SI),
  // dimensionless
  one: unit('dimensionless', '1', 'единица (безразмерная)', decimal('1'), 'Безразмерное число.'),
  percent: unit('dimensionless', '%', 'процент', decimal('0.01'), 'Точно: 1 % = 0,01.'),
} as const satisfies Record<string, UnitSpec>);

export type UnitId = keyof typeof UNITS;
export const UNIT_IDS: readonly UnitId[] = Object.freeze(Object.keys(UNITS) as UnitId[]);
export type KindOfUnit<U extends UnitId> = (typeof UNITS)[U]['kind'];
/** The identifiers of the units of one quantity kind: UnitOf<'pressure'> is 'Pa' | 'hPa' | ... - the compiler refuses a temperature unit there. */
export type UnitOf<K extends QuantityKind> = { [U in UnitId]: KindOfUnit<U> extends K ? U : never }[UnitId];

export function isUnitId(value: unknown): value is UnitId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UNITS, value);
}
export function getUnit(id: string): UnitSpec & { readonly id: UnitId } {
  if (!isUnitId(id)) throw new PhysicsError('unknown_unit', `Неизвестная единица измерения «${String(id)}».`);
  return Object.freeze({ id, ...UNITS[id] });
}
export const unitsOfKind = (kind: QuantityKind): UnitId[] => UNIT_IDS.filter(id => UNITS[id].kind === kind);
export const dimensionOfUnit = (id: UnitId): Dimension => QUANTITY_KINDS[getUnit(id).kind].dimension;
export const areUnitsCompatible = (a: UnitId, b: UnitId): boolean => dimEquals(dimensionOfUnit(a), dimensionOfUnit(b));

export function assertUnitsCompatible(a: UnitId, b: UnitId): void {
  const da = dimensionOfUnit(a);
  const db = dimensionOfUnit(b);
  if (!dimEquals(da, db)) throw new PhysicsError('dimension_mismatch', `Нельзя преобразовать ${UNITS[a].symbol} (${formatDimension(da)}) в ${UNITS[b].symbol} (${formatDimension(db)}): размерности различаются.`);
}

/** The registered kind that is the ONLY one with this SI dimension - how a product, quotient or power of quantities finds its kind (V * A -> power). A dimension
 *  is not a meaning: when two or more kinds share it (K: absolute temperature / temperature difference; Pa: absolute pressure / gauge pressure / elastic modulus;
 *  A/m: H / M) the answer is ambiguous and NOTHING is guessed - `unsupported_dimension`, as for a dimension with no kind (J / m: a force is not registered). */
export function kindOfDimension(dim: Dimension): QuantityKind {
  const matches = QUANTITY_KIND_IDS.filter(k => dimEquals(QUANTITY_KINDS[k].dimension, dim));
  if (matches.length !== 1) throw new PhysicsError('unsupported_dimension', matches.length === 0
    ? `Размерности ${formatDimension(dim)} не соответствует ни одна зарегистрированная величина.`
    : `Размерности ${formatDimension(dim)} соответствуют несколько величин (${matches.map(k => QUANTITY_KINDS[k].nameRu).join('; ')}): род результата по размерности не определяется.`);
  return matches[0];
}

/** Convertible = the same KIND, which is stricter than the same dimension: an absolute temperature and a temperature difference, or an absolute and a gauge pressure,
 *  have equal SI dimensions but are different physical quantities and are never converted into one another implicitly. */
export const areUnitsConvertible = (a: UnitId, b: UnitId): boolean => getUnit(a).kind === getUnit(b).kind;

export function assertUnitsConvertible(a: UnitId, b: UnitId): void {
  assertUnitsCompatible(a, b);
  const ka = getUnit(a).kind;
  const kb = getUnit(b).kind;
  if (ka !== kb) throw new PhysicsError('kind_mismatch', `Нельзя преобразовать ${UNITS[a].symbol} («${QUANTITY_KINDS[ka].nameRu}») в ${UNITS[b].symbol} («${QUANTITY_KINDS[kb].nameRu}»): размерности равны, но это разные физические величины.`);
}

// ---------- conversion ----------

function toSiExact(value: Rational, spec: UnitSpec): Rational { return add(mul(value, spec.factor), spec.offset); }
function fromSiExact(si: Rational, spec: UnitSpec): Rational { return div(sub(si, spec.offset), spec.factor); }

/** Throws `below_physical_limit` when the exact SI value is negative for a kind that cannot be negative (absolute temperature below 0 K, mass, absolute pressure...). */
function checkPhysicalLimit(si: Rational, kind: QuantityKind, label: string): void {
  const spec = QUANTITY_KINDS[kind] as QuantityKindSpec;
  if (spec.nonNegative && sign(si) < 0) throw new PhysicsError('below_physical_limit', `${label}: ${spec.limitRu ?? 'значение ниже физически допустимого'}.`);
}

/** The value `value` of unit `unit` must be a finite number that is physically possible for its kind (-5 K, -300 °C, a negative absolute pressure are not).
 *  Used when a quantity is created and again on every conversion, so a forged `{ value, unit }` object is caught too. */
export function assertPhysicallyValid(value: number, unit: UnitId, label = `Величина (${getUnit(unit).symbol})`): void {
  const spec = getUnit(unit);
  requireFinite(value, label);
  checkPhysicalLimit(toSiExact(rationalFromNumber(value), spec), spec.kind, label);
}

/** The exact rational rounded once to a double, refusing an overflow and an underflow (a nonzero exact value that would become 0 or subnormal). */
export function exactToNumber(exact: Rational, label: string): number {
  const result = rationalToNumber(exact);
  requireNoOverflow(result, label);
  return requireNoUnderflow(result, label, isZero(exact));
}

/** An exact SI value (see toSiRational) expressed in the unit `to`, rounded once. */
export function fromSiRational(si: Rational, to: UnitId, label: string): number {
  const spec = getUnit(to);
  checkPhysicalLimit(si, spec.kind, label);
  return exactToNumber(fromSiExact(si, spec), label);
}

/** Converts `value` from unit `from` to unit `to`, EXACTLY (one rounding at the end). 0.07 mbar -> 7 Pa, 1 Torr -> 133.32236842105263 Pa, 20 °C -> 293.15 K.
 *  Refuses units of different dimensions or of different kinds (absolute vs difference, absolute vs gauge), non-finite input, a value below the physical limit
 *  (-5 K, a negative absolute pressure...), and results that overflow or underflow. There is no way to switch these checks off. The same code runs when `from === to`:
 *  an input that is not a finite number or is physically impossible is refused there too (and -0 is returned as 0). */
export function convert(value: number, from: UnitId, to: UnitId): number {
  const fromSpec = getUnit(from);
  const toSpec = getUnit(to);
  assertUnitsConvertible(from, to);
  const label = `Величина (${fromSpec.symbol})`;
  requireFinite(value, label);
  const si = toSiExact(rationalFromNumber(value), fromSpec);
  checkPhysicalLimit(si, fromSpec.kind, label);
  return exactToNumber(fromSiExact(si, toSpec), `Результат преобразования ${fromSpec.symbol} → ${toSpec.symbol}`);
}

/** The exact rational value of `value` in the coherent SI unit of its kind (no rounding at all) - for exact derivations and for tests. Does not check the limit. */
export function toSiRational(value: number, from: UnitId): Rational {
  return toSiExact(rationalFromNumber(requireFinite(value, 'Величина')), getUnit(from));
}
