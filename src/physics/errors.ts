/** Errors of the physics core. Every refusal carries a stable machine-readable `code` (so a caller can react to the KIND of problem) and a message in
 *  Russian written for the user, like the rest of the project. Nothing in the core ever replaces an invalid number by a default or a clamped value:
 *  it either returns a correct result or throws one of these. */

export const PHYSICS_ERROR_CODES = Object.freeze([
  'not_finite',         // NaN, ±Infinity, null, a string, ... instead of a number
  'out_of_range',       // a finite number outside the range the quantity may take
  'below_physical_limit', // physically impossible: below absolute zero, a negative mass, a negative absolute pressure, ...
  'overflow',           // the exact result does not fit into a double
  'underflow',          // the exact result is not zero but would become 0 or lose all precision (subnormal)
  'dimension_mismatch', // units/quantities of different dimensions
  'unknown_unit',       // an identifier that is not in the unit registry
  'unknown_constant',   // an identifier that is not in the constant registry
  'invalid_decimal',    // a text that is not a strict decimal number
  'kind_mismatch',      // same SI dimension but a different physical KIND: absolute temperature vs temperature difference, absolute vs gauge pressure
  'unsupported_dimension', // a product/quotient/power whose dimension matches no registered kind
  'invalid_uncertainty',   // a negative or non-finite standard uncertainty, or an invalid coverage factor
  'correlated_inputs',     // the SAME Measured object passed as two inputs of a formula that assumes independent inputs (x + x, x / x...)
  'degenerate_linearization', // first-order propagation gives a formal 0 where the output is NOT exactly known (y = x^2 at x = 0 with u(x) > 0)
  'missing_reference',  // a gauge <-> absolute pressure conversion without an explicitly given reference pressure
] as const);
export type PhysicsErrorCode = typeof PHYSICS_ERROR_CODES[number];

export class PhysicsError extends Error {
  readonly code: PhysicsErrorCode;
  constructor(code: PhysicsErrorCode, message: string) {
    super(message);
    this.name = 'PhysicsError';
    this.code = code;
  }
}
