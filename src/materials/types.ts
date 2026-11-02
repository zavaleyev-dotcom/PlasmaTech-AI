/** The data model of the materials registry (M1.3.1): WHAT a material is - identity, composition, phase, structure, form, layer stacks. It contains NO physical
 *  property values (density, conductivity, melting point...): those come in M1.3.2 with their sources, and are never inferred from anything here.
 *
 *  The central idea: a property belongs to a VARIANT - identity + composition + phase + structure + form - never to a bare material name. A bulk piece, a sputtering
 *  target and a thin film of "the same" material are different variants and are never treated as equivalent. The intended use is context, not a property. */

import type { Quantity } from '@/physics';

export const MATERIAL_KINDS = Object.freeze(['element', 'compound', 'alloy', 'ceramic', 'composite', 'coating_system'] as const);
export type MaterialKind = typeof MATERIAL_KINDS[number];

/** A sourced statement: nothing in a record is asserted without saying where it comes from. Full provenance (authors, methods, conditions) is M1.3.2. */
export interface SourceNote {
  readonly citation: string;
  /** Checked for DOI syntax only (no network lookup). */
  readonly doi?: string;
  readonly locator?: string;
}

/** An external designation (CAS, UNS, GOST...). Only with a source; nothing here is ever assigned automatically. */
export interface Designation {
  readonly system: string;
  readonly value: string;
  readonly source: SourceNote;
}

export interface MaterialIdentity {
  /** `<namespace>:<slug>`, see ids.ts. */
  readonly id: string;
  readonly kind: MaterialKind;
  readonly nameRu: string;
  readonly nameEn?: string;
  readonly synonyms?: readonly string[];
  readonly designations?: readonly Designation[];
}

// ---------- composition ----------

/** A fraction: one exact value, OR a range [min, max] of the allowed/nominal composition, OR `balance` (the remainder; at most one per composition). Never mixed. */
export type FractionSpec =
  | { readonly value: number }
  | { readonly min: number; readonly max: number }
  | { readonly balance: true };

/** What the fractions of ONE composition are fractions of. A composition has exactly one basis: mass, atomic and volume fractions are never mixed or converted
 *  into each other here (mass <-> atomic needs verified atomic weights, which this package does not contain). */
export type FractionBasis = 'mass' | 'atomic' | 'molar' | 'volume';

export interface ElementComposition { readonly type: 'element'; readonly symbol: string }

export interface AlloyComposition {
  readonly type: 'alloy';
  /** An alloy of elements: mass or atomic fractions (the molar fraction of atoms IS the atomic fraction and has no separate name here). */
  readonly basis: 'mass' | 'atomic';
  readonly constituents: readonly { readonly symbol: string; readonly fraction: FractionSpec }[];
  /** Declared rounding tolerance of the published sum (0 < tol <= 0.01); absent = the fractions must sum to exactly 1. */
  readonly sumTolerance?: number;
}

/** A compound or ceramic given by the amount of each element per formula unit. `stoichiometric`: positive integers. `nonstoichiometric`: at least one count is not a
 *  whole number or is a range (TiN(0.9..1.0)). A count is NOT a fraction. */
export interface StoichiometricComposition {
  readonly type: 'stoichiometric';
  readonly stoichiometry: 'stoichiometric' | 'nonstoichiometric';
  readonly species: readonly { readonly symbol: string; readonly count: number | { readonly min: number; readonly max: number } }[];
}

/** A composite: constituents are VARIANTS (by id), their fractions are of one basis (volume by default, or mass / molar). */
export interface CompositeComposition {
  readonly type: 'composite';
  readonly basis: 'volume' | 'mass' | 'molar';
  readonly constituents: readonly { readonly material: string; readonly fraction: FractionSpec }[];
  readonly sumTolerance?: number;
}

export interface CoatingSystemComposition { readonly type: 'coating_system'; readonly stack: MaterialStack }

export type MaterialComposition = ElementComposition | AlloyComposition | StoichiometricComposition | CompositeComposition | CoatingSystemComposition;

// ---------- phase and structure ----------

/** Aggregate state - a different thing from the crystalline order and from the microstructure. */
export const AGGREGATE_STATES = Object.freeze(['solid', 'liquid', 'gas', 'plasma'] as const);
export type AggregateState = typeof AGGREGATE_STATES[number];

/** Crystalline order of a SOLID. `unknown` is an explicit answer: the absence of data about amorphousness is not evidence of crystallinity, nor the reverse.
 *  `not_applicable` is required for a liquid, gas and plasma, and only for them. */
export const STRUCTURAL_ORDERS = Object.freeze(['crystalline', 'partially_crystalline', 'amorphous', 'unknown', 'not_applicable'] as const);
export type StructuralOrder = typeof STRUCTURAL_ORDERS[number];

export const LATTICE_SYSTEMS = Object.freeze(['triclinic', 'monoclinic', 'orthorhombic', 'tetragonal', 'trigonal', 'hexagonal', 'cubic'] as const);
export type LatticeSystem = typeof LATTICE_SYSTEMS[number];

export interface CrystalStructure {
  readonly latticeSystem?: LatticeSystem;
  readonly spaceGroup?: string;
  /** A structure-type name as given by the source. */
  readonly prototype?: string;
}

export interface MaterialPhase {
  readonly state: AggregateState;
  readonly order: StructuralOrder;
  /** The crystalline phase's label as given by the source. */
  readonly phaseName?: string;
  /** Only for order crystalline / partially_crystalline. */
  readonly crystalStructure?: CrystalStructure;
  /** The temperature interval in which this phase is stable. */
  readonly stableRange?: { readonly min: Quantity<'temperature'>; readonly max: Quantity<'temperature'> };
  readonly source?: SourceNote;
}

/** Microstructure of a solid: the features that depend on how a piece was made. Each field is optional and ABSENT means "not reported", never a default. */
export interface MaterialStructure {
  /** A grain size makes sense only for a crystalline or partially crystalline solid. */
  readonly grainSize?: { readonly size: Quantity<'length'>; readonly definition?: string };
  readonly texture?: { readonly description: string };
  /** The void fraction, 0 <= p < 1. */
  readonly porosity?: Quantity<'dimensionless'>;
  readonly features?: readonly string[];
  readonly source?: SourceNote;
}

// ---------- form ----------

export const MATERIAL_FORM_KINDS = Object.freeze(['bulk', 'thin_film', 'coating_layer', 'sputtering_target', 'powder', 'foil', 'substrate'] as const);
export type MaterialFormKind = typeof MATERIAL_FORM_KINDS[number];

export const INTENDED_USES = Object.freeze(['sputtering_target', 'coating', 'substrate', 'structural'] as const);
export type IntendedUse = typeof INTENDED_USES[number];

export interface MaterialForm {
  readonly kind: MaterialFormKind;
  /** thin_film, coating_layer, foil, sputtering_target, substrate. */
  readonly thickness?: Quantity<'length'>;
  /** powder only. */
  readonly particleSize?: Quantity<'length'>;
  /** thin_film and coating_layer only: how the film was made - the CONTEXT of the variant. */
  readonly deposition?: { readonly process: string; readonly notes?: string };
  /** thin_film and coating_layer only: the variant (by id) the film sits on. */
  readonly substrate?: string;
  /** Context only: the intended use never decides a property. */
  readonly intendedUse?: readonly IntendedUse[];
}

// ---------- layers and stacks ----------

export const LAYER_ROLES = Object.freeze(['adhesion', 'intermediate', 'functional', 'protective', 'buffer', 'capping'] as const);
export type LayerRole = typeof LAYER_ROLES[number];

export const INTERFACE_KINDS = Object.freeze(['sharp', 'diffuse', 'unknown'] as const);

/** The boundary between two layers. Described, never computed into effective properties. */
export interface MaterialInterface {
  readonly kind?: typeof INTERFACE_KINDS[number];
  readonly width?: Quantity<'length'>;
  readonly roughness?: Quantity<'length'>;
  readonly note?: string;
}

interface LayerBase {
  /** Unique within the stack (a layer in a repeated package keeps one id; its instances are told apart by their position). */
  readonly id: string;
  readonly role?: LayerRole;
  /** Optional: an absent thickness is "not known", and a total thickness is refused until every layer has one. */
  readonly thickness?: Quantity<'length'>;
}

export interface UniformLayer extends LayerBase { readonly kind: 'uniform'; readonly material: string }
/** A graded layer between two variants. The profile is a note of the source, not a model. */
export interface GradientLayer extends LayerBase { readonly kind: 'gradient'; readonly from: string; readonly to: string; readonly profile?: string }
export type MaterialLayer = UniformLayer | GradientLayer;

interface ElementBase {
  /** The boundary between this element and the next one in the same list. Not allowed on the last element of a list. */
  readonly interfaceToNext?: MaterialInterface;
}
export interface LayerElement extends ElementBase { readonly type: 'layer'; readonly layer: MaterialLayer }
/** A periodically repeated package (a superlattice period, a multilayer bilayer): `repeat` copies of `elements`, in order. */
export interface PeriodElement extends ElementBase {
  readonly type: 'period';
  readonly repeat: number;
  readonly elements: readonly StackElement[];
  /** The boundary between the last element of one repetition and the first of the next. */
  readonly interfaceBetweenRepeats?: MaterialInterface;
}
export type StackElement = LayerElement | PeriodElement;

export interface MaterialStack {
  /** The variant the stack is deposited on. */
  readonly substrate?: string;
  /** From the substrate outwards. */
  readonly elements: readonly StackElement[];
}

// ---------- variant and catalog ----------

export interface MaterialVariant {
  readonly id: string;
  /** The id of a MaterialIdentity. */
  readonly identity: string;
  readonly composition: MaterialComposition;
  /** Required for element, compound, alloy and ceramic; absent for composite and coating_system (their phases are those of their constituents). */
  readonly phase?: MaterialPhase;
  readonly structure?: MaterialStructure;
  readonly form: MaterialForm;
}

export interface MaterialCatalog {
  readonly identities: readonly MaterialIdentity[];
  readonly variants: readonly MaterialVariant[];
}
