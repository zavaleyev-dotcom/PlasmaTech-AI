/** Types of the material property registry (M1.3.3): an immutable, validated, in-memory snapshot of a catalog and its property records, with deterministic SEARCH,
 *  explicit handling of missing data, layered version information and DESCRIPTIVE diagnostics of how records differ.
 *
 *  The registry finds records. It does not judge them: finding exactly one record does not make it a recommended value, a verified value or a value fit for an
 *  engineering calculation (`suitability` is always `not_assessed`), and there is no function that hands a record to a calculation as a ready `Measured`. It never chooses
 *  among records (not the latest version, not the smallest uncertainty), never averages, interpolates or extrapolates, and never substitutes another variant, state or
 *  temperature for a missing one. Differences between records are described (identical, different values, different conditions, insufficient context, review required),
 *  never ruled on statistically. */

import type { Quantity } from '@/physics';
import type { ValidationIssue } from './errors';
import type { AggregateState, MaterialCatalog, MaterialFormKind, MaterialVariant } from './types';
import type { Direction, ExpansionDefinition, HeatCapacityMode, IdentifierType, PropertyConditions, PropertyRecord, SourceType, ValueStatus, VerificationStatus } from './property-types';

export interface RegistryInput {
  readonly catalog: MaterialCatalog;
  readonly records: readonly PropertyRecord[];
  /** The version of THIS DATA SET, chosen by the caller or by a controlled publication process (for example `2025.1`). Never derived from the clock. Required. */
  readonly dataVersion: string;
}

/** The validated data: deep-frozen copies, independent of the objects that were passed in. */
export interface RegistrySnapshot {
  readonly catalog: MaterialCatalog;
  readonly records: readonly PropertyRecord[];
}

/** Four DIFFERENT versions, never mixed up:
 *   - `schemaVersion`: the version of the structure of the registry (this module);
 *   - `dataVersion`: the version of the data set, given by the caller (not computed, no clock);
 *   - the version of each RECORD is `PropertyRecord.version` (M1.3.2, "recordVersion"), kept in the records; superseded records stay in the snapshot as history;
 *   - `contentFingerprint`: a deterministic fingerprint of the CONTENT (FNV-1a 64 of the canonical content, independent of the order of records and variants, including
 *     every record version and `supersedes` link). It detects accidental change; it is NOT a proof of authenticity of the scientific data and not a security hash. */
export interface RegistryVersion {
  readonly schemaVersion: 1;
  readonly dataVersion: string;
  readonly contentFingerprint: string;
  readonly variantCount: number;
  readonly recordCount: number;
}

export interface RegistryValidationReport {
  /** true when there is no error; only then is a registry created. */
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly summary: { readonly errors: number; readonly warnings: number; readonly info: number };
}

/** Equality filters on the stated conditions of a record. A condition the record does NOT state never matches a filter on it: nothing is assumed. */
export interface ConditionFilter {
  /** An absolute temperature. A record matches if its stated temperature is exactly this one (a point value), or if this temperature lies inside the temperature RANGE the
   *  record itself declares (the source's stated range of applicability - not a measurement at every temperature of it, and nothing is computed for the requested one). */
  readonly temperature?: Quantity<'temperature'>;
  readonly pressure?: Quantity<'pressure'>;
  readonly referenceTemperature?: Quantity<'temperature'>;
  readonly thickness?: Quantity<'length'>;
  readonly direction?: Direction;
  readonly expansionDefinition?: ExpansionDefinition;
  readonly heatCapacityMode?: HeatCapacityMode;
  readonly materialState?: AggregateState;
  readonly atmosphere?: string;
}

/** All filters are exact and combined with AND. Superseded records are left out unless `includeSuperseded` is true. */
export interface RegistryQuery {
  /** The exact id of a material variant. */
  readonly variant?: string;
  readonly property?: string;
  /** The physical form of the VARIANT (bulk, thin_film, sputtering_target...). */
  readonly formKind?: MaterialFormKind;
  /** The provenance status of the value. */
  readonly status?: ValueStatus;
  readonly verification?: VerificationStatus;
  readonly sourceType?: SourceType;
  /** A source identifier (DOI, ISBN, standard number, URL) compared after normalisation. */
  readonly sourceIdentifier?: { readonly type: IdentifierType; readonly value: string };
  /** The exact version of the record (`PropertyRecord.version`). */
  readonly version?: number;
  readonly conditions?: ConditionFilter;
  readonly includeSuperseded?: boolean;
}

/** How a returned record relates to the requested temperature. Preserved in the answer so that a range is never mistaken for a point measurement. */
export type TemperatureApplicability =
  | { readonly kind: 'not_requested' }
  | { readonly kind: 'stated_point'; readonly temperature: Quantity<'temperature'> }
  | { readonly kind: 'declared_range'; readonly range: { readonly min: Quantity<'temperature'>; readonly max: Quantity<'temperature'> } };

/** Everything that qualifies a returned record, so that nothing is hidden: the conditions, the provenance status, the verification status, the uncertainty statement kind,
 *  the temperature applicability, and plain-language caveats. */
export interface RecordMatch {
  readonly record: PropertyRecord;
  readonly temperature: TemperatureApplicability;
  /** The conditions under which the value was obtained / applies (as stated in the record). */
  readonly conditions: PropertyConditions;
  readonly provenanceStatus: ValueStatus;
  readonly verification: VerificationStatus;
  readonly uncertaintyKind: 'unknown' | 'standard' | 'expanded' | 'bounds';
  readonly superseded: boolean;
  readonly caveats: readonly string[];
}

/** Descriptive categories for two records of the SAME variant and property. They state what can be seen in the data, not what is scientifically true:
 *   - `identical`: the same checkable data (value, uncertainty statement, conditions including the free text);
 *   - `different_values`: all stated conditions are equal and the nominal values differ (this does not say the methods are comparable, and it is not a contradiction);
 *   - `conditions_differ`: some stated condition differs (temperature, pressure, direction, thickness, state, Cp/Cv mode, expansion definition, reference temperature...);
 *   - `insufficient_context`: a condition is stated by one record only, so comparability cannot be judged;
 *   - `review_required`: free text (measurement method, context) differs or other differences cannot be compared by machine - an expert must look. */
export type DifferenceCategory = 'identical' | 'different_values' | 'conditions_differ' | 'insufficient_context' | 'review_required';

export interface RecordDifference {
  readonly category: DifferenceCategory;
  readonly variant: string;
  readonly property: string;
  readonly records: readonly [string, string];
  /** What was found, in words. No statistical conclusion: uncertainties are not combined (their correlation is unknown) and no coverage factor is applied. */
  readonly reasons: readonly string[];
}

export type QueryStatus = 'unique_record' | 'multiple_records' | 'not_available' | 'invalid_query';

/** The answer to a search. The records are the original (frozen) records, ordered by id; `matches` describes each of them in the same order. */
export interface RegistryQueryResult {
  readonly status: QueryStatus;
  readonly records: readonly PropertyRecord[];
  readonly matches: readonly RecordMatch[];
  readonly count: number;
  /** Always `not_assessed`: the registry does not judge whether a record is fit for an engineering calculation, nor recommend one. */
  readonly suitability: 'not_assessed';
  /** How the returned records differ from one another (all pairs of the same variant and property). */
  readonly differences: readonly RecordDifference[];
  /** For `not_available` with an exact variant and property: counts only (no fallback is offered and no value of another condition is shown). */
  readonly absence?: { readonly otherCurrentRecordsOfVariantAndProperty: number; readonly recordsNotStatingQueriedConditions: number };
  /** The problems of a malformed query (empty for a valid one): a bad query is reported, never interpreted. */
  readonly issues: readonly ValidationIssue[];
}

export interface CoverageEntry { readonly property: string; readonly currentRecords: number }

export interface MaterialPropertyRegistry {
  readonly version: RegistryVersion;
  readonly snapshot: RegistrySnapshot;
  /** Warnings and information of the validation that created the registry (there are no errors in it). */
  readonly report: RegistryValidationReport;
  getVariant(id: string): MaterialVariant | undefined;
  /** Search of records: the matching original records with their qualifications, never a selection among them. */
  findRecords(query: RegistryQuery): RegistryQueryResult;
  /** How all CURRENT records of the snapshot differ from one another (descriptive; see DifferenceCategory). */
  differences(): readonly RecordDifference[];
  isSuperseded(recordId: string): boolean;
  /** The replacement history of a record: the oldest record it descends from, up to the newest one that replaces it. `undefined` for an unknown record. Nothing is removed. */
  history(recordId: string): readonly PropertyRecord[] | undefined;
  /** For every defined property, how many current records the variant has (0 is stated explicitly); `undefined` for an unknown variant. */
  coverage(variantId: string): readonly CoverageEntry[] | undefined;
}

export type RegistryCreationResult =
  | { readonly ok: true; readonly registry: MaterialPropertyRegistry; readonly report: RegistryValidationReport }
  | { readonly ok: false; readonly registry: null; readonly report: RegistryValidationReport };
