/** The registry of fundamental physical constants, each with its provenance.
 *
 *  Three honest classes, never mixed up:
 *   - `exact`    - fixed by the definition of the SI (2019 redefinition) or by convention, so with NO uncertainty; or derived from those by exact arithmetic (R, F);
 *   - `measured` - a CODATA recommended value WITH its standard uncertainty, the dataset and the year stated.
 *  Values are decimal TEXT first (the source of truth, exact) and a double second (that text rounded once). Nothing here is invented or "rounded for convenience":
 *  a value without a verified source does not belong in this file. Material properties are a separate, later stage. */

import { type Dimension, dimDiv, dimMul, dimPow, ENERGY, FORCE, LENGTH, MASS, TIME, CURRENT, TEMPERATURE, AMOUNT, VELOCITY, ACCELERATION, ELECTRIC_CHARGE, CAPACITANCE, PRESSURE } from './dimensions';
import { mul, rationalFromDecimalText, rationalToExactDecimal, rationalToNumber, type Rational } from './exact';
import { PhysicsError } from './errors';
import { deepFreeze } from './freeze';

export type ConstantStatus = 'exact' | 'measured';

export interface ConstantSource {
  /** Where the value was verified. */
  readonly origin: string;
  /** The dataset and its version/year ("CODATA 2022"), or the document ("Брошюра СИ, 9-е изд.") for definitions. */
  readonly dataset: string;
  readonly url?: string;
}

export interface PhysicalConstant {
  readonly id: string;
  readonly symbol: string;
  readonly nameRu: string;
  readonly status: ConstantStatus;
  /** Exact decimal text of the value in SI units. */
  readonly valueText: string;
  /** The value as a double (valueText rounded once, to nearest). */
  readonly value: number;
  /** Coherent SI unit as DISPLAY text (compound units are not in the unit registry, so this is a symbol, never a registry identifier). */
  readonly siSymbol: string;
  readonly dimension: Dimension;
  /** Standard uncertainty in the units of the last digits' scale, as decimal text; only for `measured`. */
  readonly standardUncertaintyText?: string;
  readonly source: ConstantSource;
  readonly note?: string;
}

const NIST = 'NIST, Fundamental Physical Constants (physics.nist.gov/cuu/Constants)';
const NIST_URL = 'https://physics.nist.gov/cuu/Constants/';
const CODATA = 'CODATA 2022 (рекомендованные значения 2022 г.)';
const SI_SRC: ConstantSource = { origin: 'Определение СИ (переопределение 2019 г.): значение зафиксировано точно', dataset: 'Брошюра СИ, 9-е изд. (BIPM, 2019)', url: 'https://www.bipm.org/en/publications/si-brochure' };
const DERIVED_SRC: ConstantSource = { origin: 'Точное произведение определяющих констант СИ', dataset: 'Брошюра СИ, 9-е изд. (BIPM, 2019)', url: 'https://www.bipm.org/en/publications/si-brochure' };
const measured: ConstantSource = { origin: NIST, dataset: CODATA, url: NIST_URL };

function make(id: string, symbol: string, nameRu: string, status: ConstantStatus, valueText: string, siUnit: string, dim: Dimension, source: ConstantSource, extra: { standardUncertaintyText?: string; note?: string } = {}): PhysicalConstant {
  const exact: Rational = rationalFromDecimalText(valueText);
  return { id, symbol, nameRu, status, valueText, value: rationalToNumber(exact), siSymbol: siUnit, dimension: dim, source, ...extra };
}

/** Exact decimal text of a product of two exact constants - a derived EXACT constant has no hand-typed digits to get wrong. */
function exactProductText(a: string, b: string): string {
  const text = rationalToExactDecimal(mul(rationalFromDecimalText(a), rationalFromDecimalText(b)));
  if (text === null) throw new PhysicsError('invalid_decimal', 'Произведение точных констант не является конечной десятичной дробью.');
  return text;
}

const BOLTZMANN_TEXT = '1.380649e-23';
const AVOGADRO_TEXT = '6.02214076e23';
const ELEMENTARY_CHARGE_TEXT = '1.602176634e-19';

const ACTION = dimMul(ENERGY, TIME);
const ENTROPY_LIKE = dimDiv(ENERGY, TEMPERATURE); // J/K
const MOLAR_ENTROPY_LIKE = dimDiv(ENTROPY_LIKE, AMOUNT); // J/(mol K)
const PER_MOLE = dimPow(AMOUNT, -1);
const FARADAY_DIM = dimDiv(ELECTRIC_CHARGE, AMOUNT);
const PERMITTIVITY = dimDiv(CAPACITANCE, LENGTH); // F/m
const PERMEABILITY = dimDiv(FORCE, dimPow(CURRENT, 2)); // N/A^2

export const CONSTANTS = deepFreeze({
  speedOfLight: make('speedOfLight', 'c', 'скорость света в вакууме', 'exact', '299792458', 'м/с', VELOCITY, SI_SRC),
  planck: make('planck', 'h', 'постоянная Планка', 'exact', '6.62607015e-34', 'Дж·с', ACTION, SI_SRC),
  elementaryCharge: make('elementaryCharge', 'e', 'элементарный заряд', 'exact', ELEMENTARY_CHARGE_TEXT, 'Кл', ELECTRIC_CHARGE, SI_SRC),
  boltzmann: make('boltzmann', 'k_B', 'постоянная Больцмана', 'exact', BOLTZMANN_TEXT, 'Дж/К', ENTROPY_LIKE, SI_SRC),
  avogadro: make('avogadro', 'N_A', 'постоянная Авогадро', 'exact', AVOGADRO_TEXT, '1/моль', PER_MOLE, SI_SRC),
  gasConstant: make('gasConstant', 'R', 'универсальная газовая постоянная', 'exact', exactProductText(AVOGADRO_TEXT, BOLTZMANN_TEXT), 'Дж/(моль·К)', MOLAR_ENTROPY_LIKE, DERIVED_SRC, { note: 'R = N_A · k_B, точно.' }),
  faraday: make('faraday', 'F', 'постоянная Фарадея', 'exact', exactProductText(AVOGADRO_TEXT, ELEMENTARY_CHARGE_TEXT), 'Кл/моль', FARADAY_DIM, DERIVED_SRC, { note: 'F = N_A · e, точно.' }),
  standardGravity: make('standardGravity', 'g_n', 'стандартное ускорение свободного падения', 'exact', '9.80665', 'м/с²', ACCELERATION,
    { origin: 'Конвенциональное значение (3-я ГКМВ, 1901), точно', dataset: 'Брошюра СИ, 9-е изд. (BIPM, 2019)', url: 'https://www.bipm.org/en/publications/si-brochure' }, { note: 'Конвенция, а не измеренная величина; не равно локальному g.' }),
  standardAtmosphere: make('standardAtmosphere', 'atm', 'стандартная атмосфера', 'exact', '101325', 'Па', PRESSURE,
    { origin: 'Конвенциональное значение (10-я ГКМВ, 1954), точно', dataset: 'Брошюра СИ, 9-е изд. (BIPM, 2019)', url: 'https://www.bipm.org/en/publications/si-brochure' }),
  electronMass: make('electronMass', 'm_e', 'масса электрона', 'measured', '9.1093837139e-31', 'кг', MASS, measured, { standardUncertaintyText: '2.8e-40' }),
  protonMass: make('protonMass', 'm_p', 'масса протона', 'measured', '1.67262192595e-27', 'кг', MASS, measured, { standardUncertaintyText: '5.2e-37' }),
  atomicMassConstant: make('atomicMassConstant', 'm_u', 'атомная единица массы', 'measured', '1.66053906892e-27', 'кг', MASS, measured, { standardUncertaintyText: '5.2e-37' }),
  vacuumPermittivity: make('vacuumPermittivity', 'ε₀', 'электрическая постоянная', 'measured', '8.8541878188e-12', 'Ф/м', PERMITTIVITY, measured, { standardUncertaintyText: '1.4e-21' }),
  vacuumPermeability: make('vacuumPermeability', 'μ₀', 'магнитная постоянная', 'measured', '1.25663706127e-6', 'Н/А²', PERMEABILITY, measured, { standardUncertaintyText: '2.0e-16', note: 'После 2019 г. μ₀ не точная: измеряется (через постоянную тонкой структуры).' }),
} as const satisfies Record<string, PhysicalConstant>);

export type ConstantId = keyof typeof CONSTANTS;
export const CONSTANT_IDS: readonly ConstantId[] = Object.freeze(Object.keys(CONSTANTS) as ConstantId[]);

export function getConstant(id: string): PhysicalConstant {
  if (!Object.prototype.hasOwnProperty.call(CONSTANTS, id)) throw new PhysicsError('unknown_constant', `Неизвестная физическая константа «${id}».`);
  return CONSTANTS[id as ConstantId];
}
