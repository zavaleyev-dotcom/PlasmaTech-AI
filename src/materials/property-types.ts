/** Types of the property records (M1.3.2): what a property IS (definition), what a value of it IS (record) and where it comes from (provenance). This stage stores
 *  and validates scalar values; it does not select, combine, interpolate or compute anything (registry queries are M1.3.3, temperature dependences M1.3.4).
 *  There are no real property values in the package: records exist only as synthetic fixtures in the tests.
 *
 *  A value belongs to a VARIANT (identity + composition + phase + structure + form), never to a bare material name: the same material as a bulk piece, a sputtering
 *  target and a thin film are different variants with different records, and nothing here falls back from one to another. */

import type { Dimension, QuantityKind, Quantity, UnitId } from '@/physics';
import type { AggregateState } from './types';

// ---------- definitions ----------

/** The forms a value can take. Only `scalar` is implemented; `tensor2` and `function` (a temperature dependence) are reserved names for later stages. */
export const VALUE_FORMS = Object.freeze(['scalar', 'tensor2', 'function'] as const);
export type ValueForm = typeof VALUE_FORMS[number];

export const CONDITION_KEYS = Object.freeze([
  'temperature', 'temperatureRange', 'pressure', 'atmosphere', 'direction', 'referenceTemperature', 'expansionDefinition', 'heatCapacityMode',
  'measurementMethod', 'materialState', 'thickness', 'context',
] as const);
export type ConditionKey = typeof CONDITION_KEYS[number];

export interface ConditionalRule {
  readonly when: { readonly key: ConditionKey; readonly equals: string };
  readonly require?: readonly ConditionKey[];
  readonly forbid?: readonly ConditionKey[];
}

export interface PropertyDefinition {
  /** A stable slug: `thermal_conductivity`. */
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
  /** The physical kind in the physics registry - fixes the dimension, the allowed units and the physical limits of the value. */
  readonly kind: QuantityKind;
  /** The canonical SI unit of the kind (a unit identifier of the physics registry). */
  readonly siUnit: UnitId;
  readonly dimension: Dimension;
  readonly definitionRu: string;
  readonly valueForms: readonly ValueForm[];
  /** Conditions every record of this property must state. `temperature` is satisfied by `temperature` or by `temperatureRange`. */
  readonly requiredConditions: readonly ConditionKey[];
  /** The only conditions a record of this property may state; any other is an error (a condition that does not apply is not silently kept). */
  readonly allowedConditions: readonly ConditionKey[];
  readonly conditionalRules?: readonly ConditionalRule[];
  /** Additionally required when the variant is a thin film or a coating layer: a film's value depends on its thickness and direction, a bulk value does not. */
  readonly filmRequiredConditions?: readonly ConditionKey[];
}

// ---------- conditions ----------

export const DIRECTIONS = Object.freeze(['in_plane', 'cross_plane'] as const);
export type Direction = typeof DIRECTIONS[number];
export const EXPANSION_DEFINITIONS = Object.freeze(['tangent', 'mean'] as const);
export type ExpansionDefinition = typeof EXPANSION_DEFINITIONS[number];
export const HEAT_CAPACITY_MODES = Object.freeze(['isobaric', 'isochoric'] as const);
export type HeatCapacityMode = typeof HEAT_CAPACITY_MODES[number];

/** The conditions under which a value was obtained / applies. Temperatures are ABSOLUTE temperatures (never an interval); pressure is ABSOLUTE pressure. A value
 *  is not applicable outside the stated conditions - there is no default and no "typical" condition. */
export interface PropertyConditions {
  readonly temperature?: Quantity<'temperature'>;
  readonly temperatureRange?: { readonly min: Quantity<'temperature'>; readonly max: Quantity<'temperature'> };
  readonly pressure?: Quantity<'pressure'>;
  readonly atmosphere?: string;
  readonly direction?: Direction;
  /** For the MEAN expansion coefficient: the temperature T0 the mean is counted from (the coefficient is averaged over T0 ... `temperature`). */
  readonly referenceTemperature?: Quantity<'temperature'>;
  /** `tangent`: alpha(T) = (1/L) dL/dT at `temperature`; `mean`: averaged between `referenceTemperature` and `temperature`. The two are different numbers. */
  readonly expansionDefinition?: ExpansionDefinition;
  readonly heatCapacityMode?: HeatCapacityMode;
  readonly measurementMethod?: string;
  /** The aggregate state of the material when the value was obtained. */
  readonly materialState?: AggregateState;
  /** The film thickness at which the value was obtained. */
  readonly thickness?: Quantity<'length'>;
  /** Further context that affects how the value is to be read. */
  readonly context?: string;
}

// ---------- provenance ----------

export const VALUE_STATUSES = Object.freeze(['measured', 'evaluated', 'model_estimate', 'user_input'] as const);
export type ValueStatus = typeof VALUE_STATUSES[number];

export const SOURCE_TYPES = Object.freeze(['journal_article', 'book', 'handbook', 'standard', 'thesis', 'report', 'database', 'dataset', 'user_data', 'other'] as const);
export type SourceType = typeof SOURCE_TYPES[number];

export const IDENTIFIER_TYPES = Object.freeze(['doi', 'isbn', 'standard_number', 'url', 'other'] as const);
export type IdentifierType = typeof IDENTIFIER_TYPES[number];

/** An identifier of a source. Its FORMAT is checked (DOI syntax, ISBN check digit, URL syntax); that the publication exists is NOT - nothing here queries a network. */
export interface SourceIdentifier { readonly type: IdentifierType; readonly value: string }

export interface SourceDescription {
  readonly type: SourceType;
  /** Each author as given by the source; never invented. */
  readonly authors?: readonly string[];
  readonly title?: string;
  readonly year?: number;
  readonly identifiers?: readonly SourceIdentifier[];
}

/** Where in the source the value stands. */
export interface SourceLocator {
  readonly page?: string;
  readonly table?: string;
  readonly figure?: string;
  readonly equation?: string;
  readonly section?: string;
}

/** Whether a person actually compared the record with the primary source. `unverified` is the honest default; a well-formed DOI is NOT a verification. */
export const VERIFICATION_STATUSES = Object.freeze(['verified_against_source', 'unverified', 'not_applicable'] as const);
export type VerificationStatus = typeof VERIFICATION_STATUSES[number];

export interface SourceVerification {
  readonly status: VerificationStatus;
  /** Required for `verified_against_source`: who compared. */
  readonly verifiedBy?: string;
  /** Required for `verified_against_source`: when (YYYY-MM-DD). */
  readonly verifiedAt?: string;
  readonly note?: string;
}

export interface PropertyProvenance {
  readonly status: ValueStatus;
  readonly source: SourceDescription;
  readonly locator?: SourceLocator;
  /** How the value was obtained (the experimental method, the evaluation procedure, the model). Required for `measured` and `model_estimate`. */
  readonly method?: string;
  readonly verification: SourceVerification;
}

// ---------- uncertainty ----------

/** Where an uncertainty statement comes from. `exact_by_definition` is only for an exactly zero uncertainty (a quantity exact by definition). */
export const UNCERTAINTY_ORIGINS = Object.freeze(['stated_in_source', 'user_estimate', 'model_output', 'exact_by_definition'] as const);
export type UncertaintyOrigin = typeof UNCERTAINTY_ORIGINS[number];
export const COVERAGE_FACTOR_ORIGINS = Object.freeze(['stated_in_source', 'entered_by_user'] as const);
export type CoverageFactorOrigin = typeof COVERAGE_FACTOR_ORIGINS[number];

/** The four DIFFERENT things a source can say about uncertainty. They are never converted into one another implicitly:
 *   - `unknown`: nothing is stated. It is NOT zero - zero means "exact".
 *   - `standard`: the standard uncertainty u (one standard deviation, k = 1), in the unit of the value;
 *   - `expanded`: U = k u; with `k` (and where k comes from) it converts to u = U / k; WITHOUT k it cannot be converted - it is not a standard uncertainty;
 *   - `bounds`: the source gives LIMITS the value lies between (not a standard deviation; no distribution is assumed, so it never becomes u by itself). */
export type PropertyUncertainty =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'standard'; readonly u: number; readonly origin: UncertaintyOrigin }
  | { readonly kind: 'expanded'; readonly U: number; readonly k?: number; readonly kOrigin?: CoverageFactorOrigin; readonly origin: UncertaintyOrigin }
  | { readonly kind: 'bounds'; readonly lower: number; readonly upper: number; readonly origin: UncertaintyOrigin };

// ---------- records ----------

/** A scalar value. `tensor2` and `function` are reserved for later stages (see VALUE_FORMS): they are refused here with `unsupported_value_form`. */
export interface ScalarValue { readonly type: 'scalar'; readonly value: number; readonly unit: UnitId }
export type PropertyValue = ScalarValue;

export interface PropertyRecord {
  /** `<ref|user|fixture>:<slug>`. */
  readonly id: string;
  /** The id of the MaterialVariant the value belongs to. */
  readonly variant: string;
  /** The id of a PropertyDefinition. */
  readonly property: string;
  readonly value: PropertyValue;
  /** Always present: an absent statement is written `{ kind: 'unknown' }`, never left out. */
  readonly uncertainty: PropertyUncertainty;
  readonly conditions: PropertyConditions;
  readonly provenance: PropertyProvenance;
  /** The version of THIS record (integer >= 1); a corrected record gets a new id and `supersedes` the old one. */
  readonly version: number;
  /** YYYY-MM-DD. */
  readonly updatedAt: string;
  readonly supersedes?: string;
}
