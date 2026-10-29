/** The technological card (step) model of schema 4 - types and constructors only, no document-level logic, so both the
 *  document model (techdoc-assistant.ts) and the schema migration (techdoc-migrate.ts) can build cards without importing
 *  each other. Pure and client-safe. */

import {
  STEP_TYPE_LABELS, STEP_TYPE_SPECS, STEP_FIELD_META, LAYER_FIELDS,
  type StepSource, type StepGas, type StepType, type StepFieldKey, type CoatingMode, type LegacyField, type LegacyValue,
} from './techdoc-schema';

// ---------- coating layers (multilayer card) ----------

/** One layer of the coating card. A layer owns its fields, sources and gas lines. */
export interface CoatingLayer {
  id: string;
  material?: string;
  thicknessNm?: number;
  durationMin?: number;
  temperatureC?: number;
  pressurePa?: number;
  substrateBiasV?: number;
  rotationRpm?: number;
  distanceMm?: number;
  sources: StepSource[];
  gases: StepGas[];
  /** Fields of THIS layer whose value came from a calculation (provenance of the layer, not of the card). */
  calculatedFields: string[];
}

// ---------- ProcessStep: one technological card ----------

export type StepOrigin = 'preset' | 'user';

export interface ProcessStep {
  /** Stable identity of the card (the number `order` changes when cards are moved). */
  id: string;
  order: number;
  name: string;
  type: StepType;
  enabled: boolean;
  description?: string;
  // ----- fields of the card; which of them the card of this type has: STEP_TYPE_SPECS[type].fields -----
  durationMin?: number;
  temperatureC?: number;
  temperatureStartC?: number;
  temperatureEndC?: number;
  /** Canonical storage unit is pascal. Never `0` for "not set" (`undefined` means not set). Shown in the document's `pressureUnit`. */
  pressurePa?: number;
  pressureStartPa?: number;
  pressureEndPa?: number;
  heaterPowerW?: number;
  substrateBiasV?: number;
  rotationRpm?: number;
  distanceMm?: number;
  substrateType?: string;
  substrateCount?: number;
  fixture?: string;
  material?: string;
  thicknessNm?: number;
  /** Sources and gas lines of this card (cards whose type has them; empty otherwise). */
  sources: StepSource[];
  gases: StepGas[];
  /** Coating card only: single-layer (exactly one layer) or multilayer. */
  coatingMode: CoatingMode;
  layers: CoatingLayer[];
  /** How this card was created - never how each field was edited. */
  origin: StepOrigin;
  /** Field names populated via an explicit calculation action - empty until the user runs one. */
  calculatedFields: string[];
}

/** Editable properties of a card. The type of a card is fixed when it is created (changing it would orphan
 *  the fields of the old type); sources, gases and layers have their own operations. */
export type StepPatch = Partial<Pick<ProcessStep, 'name' | 'enabled' | 'description' | StepFieldKey>>;

export function createStep(type: StepType, name?: string, origin: StepOrigin = 'user', id = 'step-1'): Omit<ProcessStep, 'order'> {
  return {
    id, name: name ?? STEP_TYPE_LABELS[type], type, enabled: true, sources: [], gases: [],
    coatingMode: 'multi', layers: [], origin, calculatedFields: [],
  };
}

export function createLayer(id: string): CoatingLayer { return { id, sources: [], gases: [], calculatedFields: [] }; }

const TEXT_FIELDS = new Set<string>(Object.entries(STEP_FIELD_META).filter(([, m]) => m.kind === 'text').map(([k]) => k));

/** Puts old values into the card where the NEW structure has a place for them and returns the rest untouched. A value is
 *  placed only when the card type has that field, the card's own field is still empty, and the value has the right type
 *  (number or text). The coating card's own fields live in layers, so for it nothing is placed here. */
export function placeFields(step: ProcessStep, fields: LegacyField[]): { step: ProcessStep; rest: LegacyField[] } {
  const spec = STEP_TYPE_SPECS[step.type];
  const next: ProcessStep = { ...step };
  const rest: LegacyField[] = [];
  for (const field of fields) {
    const key = field.key;
    if (key === 'description' && typeof field.value === 'string' && !next.description) { next.description = field.value; continue; }
    if ((spec.fields as readonly string[]).includes(key) && (next as unknown as Record<string, unknown>)[key] === undefined) {
      const wantsText = TEXT_FIELDS.has(key);
      if (typeof field.value === (wantsText ? 'string' : 'number')) { (next as unknown as Record<string, unknown>)[key] = field.value; continue; }
    }
    rest.push(field);
  }
  return { step: next, rest };
}

/** Same for one coating layer. */
export function placeLayerFields(layer: CoatingLayer, fields: LegacyField[]): { layer: CoatingLayer; rest: LegacyField[] } {
  const next: CoatingLayer = { ...layer };
  const rest: LegacyField[] = [];
  for (const field of fields) {
    const key = field.key;
    if ((LAYER_FIELDS as readonly string[]).includes(key) && (next as unknown as Record<string, unknown>)[key] === undefined) {
      const wantsText = TEXT_FIELDS.has(key);
      if (typeof field.value === (wantsText ? 'string' : 'number')) { (next as unknown as Record<string, unknown>)[key] = field.value; continue; }
    }
    rest.push(field);
  }
  return { layer: next, rest };
}

export type { LegacyValue };
export { STEP_TYPE_LABELS };
