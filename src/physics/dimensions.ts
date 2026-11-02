/** Physical dimensions: the seven base dimensions of the SI as a vector of integer exponents. Two quantities can be added, compared or converted into one another
 *  only if their dimensions are equal; a product/quotient/power of quantities has the product/quotient/power of their dimensions. Pure; no dependencies. */

import { PhysicsError } from './errors';

/** Order and symbols of the SI base units: length (m), mass (kg), time (s), electric current (A), thermodynamic temperature (K), amount of substance (mol),
 *  luminous intensity (cd). */
export const BASE_DIMENSIONS = Object.freeze(['length', 'mass', 'time', 'current', 'temperature', 'amount', 'luminousIntensity'] as const);
export const BASE_UNIT_SYMBOLS = Object.freeze(['m', 'kg', 's', 'A', 'K', 'mol', 'cd'] as const);
export type BaseDimension = typeof BASE_DIMENSIONS[number];

export type Dimension = readonly [length: number, mass: number, time: number, current: number, temperature: number, amount: number, luminousIntensity: number];

const SUPERSCRIPT: Readonly<Record<string, string>> = Object.freeze({ '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' });

/** Dimensions are shared values: never mutable. */
const frozen = (exponents: number[]): Dimension => Object.freeze(exponents) as unknown as Dimension;

function checkExponent(value: number): number {
  if (!Number.isInteger(value)) throw new PhysicsError('out_of_range', 'Показатель степени размерности должен быть целым числом.');
  return value === 0 ? 0 : value; // never -0
}

/** A dimension from the exponents of the base dimensions that are present, e.g. dimension({ length: 1, time: -1 }) is a velocity. */
export function dimension(exponents: Partial<Record<BaseDimension, number>> = {}): Dimension {
  for (const key of Object.keys(exponents)) if (!(BASE_DIMENSIONS as readonly string[]).includes(key)) throw new PhysicsError('dimension_mismatch', `Неизвестная базовая размерность «${key}».`);
  return frozen(BASE_DIMENSIONS.map(name => checkExponent(exponents[name] ?? 0)));
}

export const DIMENSIONLESS: Dimension = dimension();

export const dimMul = (a: Dimension, b: Dimension): Dimension => frozen(a.map((x, i) => x + b[i]));
export const dimDiv = (a: Dimension, b: Dimension): Dimension => frozen(a.map((x, i) => x - b[i]));
export const dimPow = (a: Dimension, exponent: number): Dimension => { const n = checkExponent(exponent); return frozen(a.map(x => checkExponent(x * n))); };
export const dimEquals = (a: Dimension, b: Dimension): boolean => a.every((x, i) => x === b[i]);
export const isDimensionless = (a: Dimension): boolean => dimEquals(a, DIMENSIONLESS);

/** Throws `dimension_mismatch` unless the two dimensions are equal. */
export function assertSameDimension(a: Dimension, b: Dimension, what = 'Величины'): void {
  if (!dimEquals(a, b)) throw new PhysicsError('dimension_mismatch', `${what} имеют разные размерности: ${formatDimension(a)} и ${formatDimension(b)}.`);
}

/** "kg·m⁻¹·s⁻²" for a pressure; "1" for a dimensionless quantity. Positive exponents first, in the order of the base units. */
export function formatDimension(a: Dimension): string {
  const parts = a.flatMap((exp, i) => exp === 0 ? [] : [`${BASE_UNIT_SYMBOLS[i]}${exp === 1 ? '' : String(exp).split('').map(ch => SUPERSCRIPT[ch]).join('')}`]);
  return parts.length === 0 ? '1' : parts.join('·');
}

// Base dimensions
export const LENGTH = dimension({ length: 1 });
export const MASS = dimension({ mass: 1 });
export const TIME = dimension({ time: 1 });
export const CURRENT = dimension({ current: 1 });
export const TEMPERATURE = dimension({ temperature: 1 });
export const AMOUNT = dimension({ amount: 1 });
export const LUMINOUS_INTENSITY = dimension({ luminousIntensity: 1 });

// Derived dimensions - built from the base ones by the SI definitions of the derived units, not typed in: N = kg·m/s², Pa = N/m², J = N·m, W = J/s,
// C = A·s, V = W/A, T = V·s/m² (= Wb/m²).
export const VELOCITY = dimDiv(LENGTH, TIME);
export const ACCELERATION = dimDiv(VELOCITY, TIME);
export const FORCE = dimMul(MASS, ACCELERATION);
export const AREA = dimPow(LENGTH, 2);
export const PRESSURE = dimDiv(FORCE, AREA);
export const ENERGY = dimMul(FORCE, LENGTH);
export const POWER = dimDiv(ENERGY, TIME);
export const ELECTRIC_CHARGE = dimMul(CURRENT, TIME);
export const VOLTAGE = dimDiv(POWER, CURRENT);
export const MAGNETIC_FLUX = dimMul(VOLTAGE, TIME);
export const MAGNETIC_INDUCTION = dimDiv(MAGNETIC_FLUX, AREA);
export const CAPACITANCE = dimDiv(ELECTRIC_CHARGE, VOLTAGE);
export const VOLUME = dimPow(LENGTH, 3);
export const VOLUME_FLOW = dimDiv(VOLUME, TIME);
export const CURRENT_DENSITY = dimDiv(CURRENT, AREA);
export const POWER_DENSITY = dimDiv(POWER, AREA);
export const NUMBER_DENSITY = dimPow(LENGTH, -3);
export const MASS_DENSITY = dimDiv(MASS, VOLUME);
export const FREQUENCY = dimPow(TIME, -1);
// property dimensions (M1.3.0), all derived from the base dimensions
export const THERMAL_CONDUCTIVITY = dimDiv(POWER, dimMul(LENGTH, TEMPERATURE));       // W/(m K)
export const SPECIFIC_HEAT = dimDiv(ENERGY, dimMul(MASS, TEMPERATURE));               // J/(kg K)
export const THERMAL_EXPANSION = dimPow(TEMPERATURE, -1);                              // 1/K
export const RESISTANCE = dimDiv(VOLTAGE, CURRENT);                                    // V/A = ohm
export const RESISTIVITY = dimMul(RESISTANCE, LENGTH);                                 // ohm m
export const CONDUCTIVITY = dimDiv(dimPow(RESISTANCE, -1), LENGTH);                    // S/m
export const MOLAR_MASS = dimDiv(MASS, AMOUNT);                                        // kg/mol
export const FIELD_STRENGTH = dimDiv(CURRENT, LENGTH);                                 // A/m
export const THERMAL_DIFFUSIVITY = dimDiv(AREA, TIME);                                 // m^2/s
