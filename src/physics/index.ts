/** The physics core (Stage 6 / M1.1): exact rational arithmetic, dimensions, a typed unit registry with exact conversion, typed quantities, fundamental constants
 *  with provenance, and the guards (finiteness, ranges, overflow, underflow). Dependency-free, pure, deterministic. Not used by the existing calculators yet.
 *  Limitations of this stage: see README.md next to this file.
 *
 *  The exact-arithmetic helpers (`add`, `mul`, `sign`, `compare`, `ZERO`...) are generic names, so they are NOT re-exported flat: use `exact.add(...)`, `exact.rational(...)`. */
export * from './errors';
export * as exact from './exact';
export type { Rational } from './exact';
export * from './guards';
export * from './freeze';
export * from './dimensions';
export * from './units';
export * from './quantity';
export * from './uncertainty';
export * from './constants';
