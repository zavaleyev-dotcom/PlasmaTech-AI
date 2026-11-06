/** Types of the property SERIES (M1.3.4): a temperature-dependent property of one material variant as a set of observations, a table, or an analytic dependence.
 *
 *  A series is a SEPARATE entity from a `PropertyRecord`: the scalar records of M1.3.2 are unchanged and `PROPERTY_DEFINITIONS` are unchanged. This first block implements the
 *  STORAGE and VALIDATION of `PointSeries` only (observations of one experiment or data set). `TabulatedSeries` and `AnalyticSeries` are declared here as types so that the
 *  contract is fixed, and are refused by the validator until they are implemented. NOTHING here computes a value: no interpolation, no extrapolation, no evaluation of a
 *  formula, no averaging, no propagation of uncertainty, no selection among observations or series. The numbers in the tests are synthetic placeholders; there is no reference
 *  data in this package. */

import type { Quantity } from '@/physics';
import type { PropertyConditions, PropertyProvenance, PropertyUncertainty, ScalarValue, SourceLocator } from './property-types';
import type { SourceNote } from './types';

// ---------- technical limits (limits of the implementation, NOT physical constants) ----------

export const MAX_OBSERVATIONS = 10000;
export const MAX_SEGMENTS = 100;
export const MAX_POWER_EXPONENT = 6;
export const MAX_CORRELATION_SIZE = 100;

// ---------- vocabularies ----------

export const SERIES_KINDS = Object.freeze(['points', 'table', 'analytic'] as const);
export type SeriesKind = typeof SERIES_KINDS[number];

/** What the uncertainty statements of a series are statements ABOUT. A point series can only state them per observation or leave the scope unspecified: the fit scopes are
 *  for analytic series. A residual spread of a fit is not the uncertainty of its coefficients. */
export const UNCERTAINTY_SCOPES = Object.freeze(['per_observation', 'fit_coefficients', 'fit_residual', 'unspecified'] as const);
export type UncertaintyScope = typeof UNCERTAINTY_SCOPES[number];

/** The ONE public vocabulary of the relation between observations in a group of repeats:
 *   - `independent_repeat`   - independence is EXPLICITLY declared (by the source or the curator);
 *   - `same_sample_repeat`   - a repeat on the same sample: stored as is, NO statistical independence is stated or implied;
 *   - `independence_unknown` - nothing is known about independence. */
export const REPLICATE_RELATIONS = Object.freeze(['independent_repeat', 'same_sample_repeat', 'independence_unknown'] as const);
export type ReplicateRelation = typeof REPLICATE_RELATIONS[number];

export const EVENT_KINDS = Object.freeze(['phase_transition', 'structural_change', 'oxidation_or_reaction', 'film_degradation', 'delamination', 'residual_stress_change'] as const);
export type EventKind = typeof EVENT_KINDS[number];

/** What an event does to the validity of the data around it. `range_ends_before`: the data are valid only below the event; `discontinuity`: the property jumps there;
 *  `irreversible_change`: after the event the material is not the same; `unknown`: the effect is not stated. */
export const EVENT_EFFECTS = Object.freeze(['range_ends_before', 'discontinuity', 'irreversible_change', 'unknown'] as const);
export type EventEffect = typeof EVENT_EFFECTS[number];

export const SWEEP_DIRECTIONS = Object.freeze(['heating', 'cooling', 'isothermal_steps', 'mixed', 'unknown'] as const);
export type SweepDirection = typeof SWEEP_DIRECTIONS[number];

export const HISTORY_STATES = Object.freeze(['as_deposited', 'annealed', 'cycled', 'unknown'] as const);
export type HistoryState = typeof HISTORY_STATES[number];

export const CORRELATION_ORIGINS = Object.freeze(['stated_in_source', 'entered_by_user', 'curator_derived'] as const);
export type CorrelationOrigin = typeof CORRELATION_ORIGINS[number];

// ---------- observations ----------

/** Whether observations at one temperature are repeats, and what kind. Optional: repeats may be stored without any statement of independence, and equal numbers, equal
 *  `run`, equal `locator` never make two observations "the same" - only the `id` does. A repeat on one sample is not an independent measurement - say which, or leave it out. */
export interface ReplicateInfo {
  /** The label of a group of repeats at ONE temperature. */
  readonly group: string;
  readonly relation: ReplicateRelation;
}

/** One observation. The STORED ORDER of the observations is the order of the measurement (a heating run, a cooling run, a cycle): it is part of the data and is never sorted.
 *  Identity: ONLY the `id` (unique in the series). `run` and `locator` describe where the observation comes from; they do not identify it. */
export interface Observation {
  readonly id: string;
  readonly temperature: Quantity<'temperature'>;
  readonly value: ScalarValue;
  /** Always present: an absent statement is written `{ kind: 'unknown' }`, never left out and never zero. */
  readonly uncertainty: PropertyUncertainty;
  readonly replicate?: ReplicateInfo;
  /** A label of the measurement run / sample as given by the source. */
  readonly run?: string;
  readonly locator?: SourceLocator;
}

// ---------- correlation ----------

export interface CorrelationProvenance {
  readonly origin: CorrelationOrigin;
  /** Required for `stated_in_source`. */
  readonly source?: SourceNote;
  readonly locator?: SourceLocator;
  readonly note?: string;
}

export type CorrelationInfo =
  | { readonly form: 'description'; readonly text: string }
  /** Stored, not used: no uncertainty is propagated. Its positive semi-definiteness is NOT checked (see README). */
  | { readonly form: 'matrix'; readonly ids: readonly string[]; readonly matrix: readonly (readonly number[])[] };

/** What is known about the correlation between the observations (or, later, between coefficients). Independence is NEVER assumed: `unknown` is the honest default and
 *  `independent` is a statement that needs its own provenance. */
export type CorrelationStatement =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'independent'; readonly provenance: CorrelationProvenance }
  | { readonly kind: 'declared'; readonly info: CorrelationInfo; readonly provenance: CorrelationProvenance };

// ---------- applicability ----------

export interface ApplicabilityEvent {
  readonly kind: EventKind;
  /** The temperature of the event, OR the range in which it takes place. */
  readonly temperature?: Quantity<'temperature'>;
  readonly range?: { readonly min: Quantity<'temperature'>; readonly max: Quantity<'temperature'> };
  readonly effect: EventEffect;
  readonly source: SourceNote;
}

export interface SeriesApplicability {
  /** How the observations relate to the stable range of the variant's phase, when that is stated. */
  readonly phaseContext?: { readonly relation: 'within_stable_range' | 'metastable_beyond_range'; readonly source?: SourceNote };
  readonly events: readonly ApplicabilityEvent[];
  /** A wide temperature range is not a proof of stability: `not_stated` is the default and `stated_stable_over_range` needs a source. */
  readonly stability: { readonly kind: 'not_stated' } | { readonly kind: 'stated_stable_over_range'; readonly source: SourceNote };
  readonly thermalHistory?: {
    readonly state: HistoryState;
    readonly annealing?: { readonly temperature?: Quantity<'temperature'>; readonly duration?: Quantity<'time'>; readonly atmosphere?: string };
    readonly cycles?: number | 'unknown';
    readonly note?: string;
  };
  readonly sweepDirection?: SweepDirection;
}

// ---------- series ----------

export interface SeriesBase {
  /** `<ref|user|fixture>:<slug>`; one id space with the property records: an id cannot be both. */
  readonly id: string;
  readonly kind: SeriesKind;
  readonly variant: string;
  readonly property: string;
  /** Every condition EXCEPT the temperature (the temperature is the axis): the same rules as for a record of this property, applied to ALL the observations. */
  readonly commonConditions: Omit<PropertyConditions, 'temperature' | 'temperatureRange'>;
  readonly uncertaintyScope: UncertaintyScope;
  readonly applicability: SeriesApplicability;
  /** The version of THIS series (an integer >= 1). */
  readonly version: number;
  readonly updatedAt: string;
  /** Replaces another series: only one of the same kind, variant and property, with a lower version. */
  readonly supersedes?: string;
}

/** Observations of ONE experiment or data set: one provenance for all of them (rows carry none of their own). */
export interface PointSeries extends SeriesBase {
  readonly kind: 'points';
  readonly provenance: PropertyProvenance;
  readonly points: readonly Observation[];
  readonly correlation: CorrelationStatement;
}

// ---- declared for the contract, NOT implemented in this block (refused by the validator) ----

export type TableProvenance =
  | { readonly mode: 'per_row'; readonly compilation?: SourceNote }
  | { readonly mode: 'single_source'; readonly provenance: PropertyProvenance };
export interface TableRow extends Observation { readonly provenance?: PropertyProvenance }
export interface TabulatedSeries extends SeriesBase {
  readonly kind: 'table';
  readonly tableProvenance: TableProvenance;
  readonly rows: readonly TableRow[];
  readonly correlation: CorrelationStatement;
  readonly interpolation: InterpolationStatement;
}

export type InterpolationStatement =
  | { readonly permitted: false }
  | { readonly permitted: true; readonly method: 'linear_in_temperature'; readonly basis: 'stated_in_source' | 'curator_decision'; readonly justification: string; readonly source?: SourceNote; readonly maxGap?: Quantity<'temperatureDifference'> };

export type CheckStatus = 'not_checked' | 'reference_points_available' | 'independently_checked';
export interface ReferencePoint { readonly temperature: Quantity<'temperature'>; readonly value: ScalarValue; readonly significantDigits?: number; readonly locator: SourceLocator }
export type CoefficientCheck =
  | { readonly status: 'not_checked' }
  | { readonly status: 'reference_points_available'; readonly points: readonly ReferencePoint[] }
  | { readonly status: 'independently_checked'; readonly attestation: { readonly by: string; readonly at: string; readonly method: string }; readonly points?: readonly ReferencePoint[] };

export interface PowerSumEquation {
  readonly form: 'power_sum';
  readonly variable: { readonly reference: Quantity<'temperature'>; readonly scale: Quantity<'temperatureDifference'> };
  readonly terms: readonly { readonly exponent: number; readonly coefficient: ScalarValue; readonly uncertainty: PropertyUncertainty; readonly locator?: SourceLocator }[];
}
export type EquationForm = PowerSumEquation;
export interface EquationSegment {
  readonly id: string;
  readonly domain: { readonly min: Quantity<'temperature'>; readonly max: Quantity<'temperature'>; readonly minInclusive: boolean; readonly maxInclusive: boolean };
  readonly equation: EquationForm;
  readonly locator?: SourceLocator;
}
export interface AnalyticSeries extends SeriesBase {
  readonly kind: 'analytic';
  readonly provenance: PropertyProvenance;
  readonly segments: readonly EquationSegment[];
  readonly coefficientCheck: CoefficientCheck;
  readonly coefficientCorrelation: CorrelationStatement;
  readonly fit?: { readonly residualStandardDeviation?: number; readonly observations?: number; readonly note?: string };
}

export type PropertySeries = PointSeries | TabulatedSeries | AnalyticSeries;
