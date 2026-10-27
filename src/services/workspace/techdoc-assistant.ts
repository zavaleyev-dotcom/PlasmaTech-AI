/** Real, local, dependency-free technological-documentation builder for PVD/CVD/PECVD/plasma
 *  processes - no external API, no LLM. This module never invents a technological parameter:
 *  every numeric/text field the user has not entered is rendered as "не задано" (or left
 *  `undefined` in the data model) rather than guessed, defaulted, or "corrected". Presets only
 *  create a stage SKELETON (step names/types/order) - they never pre-fill a pressure,
 *  temperature, power, gas, or acceptance criterion. See requirement 18 in the task spec this
 *  file implements: no silent parameter substitution, ever. */

import { solveDeposition, type ThicknessUnit, type RateUnit } from './engineering-calculators';
import { parseTechnicalProcessDocument, parseSchemaVersion } from './techdoc-parse';
import {
  estimateLines, columnWidthPt, CARD_COLUMN_WEIGHTS, CARD_SOURCE_COLUMN, CARD_GAS_COLUMN, CARD_CELL_LINE_BUDGET, TYPICAL_CHAR_PT,
} from './techdoc-card-layout';
import {
  TECHDOC_SCHEMA_VERSION, DEFAULT_PRESSURE_UNIT, PRESSURE_UNIT_LABELS, isPressureUnit, paToDisplayText, UnsupportedSchemaVersionError,
  SOURCE_KINDS, SOURCE_KIND_LABELS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING,
  type PressureUnit, type SourceKind, type StepSourceAssignment, type StepGasAssignment,
} from './techdoc-schema';

export { TECHDOC_SCHEMA_VERSION, PRESSURE_UNITS, PRESSURE_UNIT_LABELS, PA_PER_MBAR, pressureToPa, paToDisplayText, paToDisplayInputValue, parsePressureInput, parsePressureText, SOURCE_KINDS, SOURCE_KIND_LABELS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING, type PressureUnit, type SourceKind, type AssignmentMode, type StepSourceAssignment, type StepGasAssignment } from './techdoc-schema';

// ---------- shared validation helpers ----------

function assertFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: введите конечное число.`);
  return value;
}

function assertNonNegative(value: number, label: string): number {
  assertFinite(value, label);
  if (value < 0) throw new Error(`${label}: значение не может быть отрицательным.`);
  return value;
}

function checkOptionalFinite(value: number | undefined, label: string): void {
  if (value !== undefined) assertFinite(value, label);
}

/** F08: the one universally-safe physical floor for a Celsius temperature - nothing in this
 *  universe is colder than absolute zero, regardless of process type. Unlike an invented
 *  technological ceiling (deliberately never added - see the 900 °C test below), this is not
 *  a guess about what a real PVD/CVD process needs; it is a physical law, so it applies to
 *  every process type this app supports. The comparison itself is written in a way that never
 *  rejects the exact boundary (-273.15 °C === 0 K) due to floating-point rounding - `value <
 *  ABSOLUTE_ZERO_C` a hair below the constant would silently reject -273.15 itself if the
 *  constant were computed rather than a literal, so it is compared to the same literal used
 *  everywhere else in this project (engineering-calculators.ts's own `+ 273.15` conversion). */
const ABSOLUTE_ZERO_C = -273.15;

function checkOptionalAboveAbsoluteZero(value: number | undefined, label: string): void {
  if (value === undefined) return;
  assertFinite(value, label);
  if (value < ABSOLUTE_ZERO_C) throw new Error(`${label}: значение не может быть ниже абсолютного нуля (${ABSOLUTE_ZERO_C} °C).`);
}

function checkOptionalNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined) assertNonNegative(value, label);
}

// ---------- step types (typical stages of a vacuum/plasma process - not PVD-only) ----------

export const STEP_TYPES = [
  'loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'surface_preparation',
  'adhesion_underlayer', 'main_coating', 'multilayer_coating', 'reactive_deposition',
  'etching', 'cooling', 'unloading', 'quality_control', 'custom',
] as const;
export type StepType = typeof STEP_TYPES[number];

export const STEP_TYPE_LABELS: Record<StepType, string> = {
  loading: 'Загрузка',
  pumpdown: 'Откачка',
  heating: 'Нагрев',
  plasma_ion_cleaning: 'Плазменная/ионная очистка',
  surface_preparation: 'Подготовка поверхности',
  adhesion_underlayer: 'Адгезионный подслой',
  main_coating: 'Основное покрытие',
  multilayer_coating: 'Многослойное покрытие',
  reactive_deposition: 'Реактивное осаждение',
  etching: 'Травление',
  cooling: 'Охлаждение',
  unloading: 'Выгрузка',
  quality_control: 'Контроль качества',
  custom: 'Пользовательский этап',
};

// ---------- ProcessStep (item 2.C) ----------

export interface GasUsage { gas: string; flowSccm?: number }

export type StepOrigin = 'preset' | 'user';

export interface ProcessStep {
  order: number;
  name: string;
  type: StepType;
  enabled: boolean;
  description?: string;
  durationMin?: number;
  temperatureC?: number;
  /** Canonical storage unit is pascal. Never `0` for "not set" (`undefined` means not set; `0` is a
   *  real, if unusual, value). Shown in the document's `pressureUnit`. */
  pressurePa?: number;
  gasUsage: GasUsage[];
  sourceConfiguration?: string;
  powerW?: number;
  currentA?: number;
  substrateBiasV?: number;
  rotationRpm?: number;
  distanceMm?: number;
  notes?: string;
  acceptanceCriteria?: string;
  /** How this step's skeleton was created - never how each field was edited. */
  origin: StepOrigin;
  /** Magnetron / arc sources USED on this step (references to section D, see techdoc-schema.ts).
   *  Empty by default - nothing is assigned or filled in automatically. */
  sourceAssignments: StepSourceAssignment[];
  /** Gas lines of section E USED on this step, with their own flow and timing. */
  gasAssignments: StepGasAssignment[];
  /** Field names populated via an explicit calculation action (item 14) - empty until the user
   *  actually runs a calculation; never set implicitly. */
  calculatedFields: string[];
}

export function createStep(type: StepType, name?: string, origin: StepOrigin = 'user'): Omit<ProcessStep, 'order'> {
  return { name: name ?? STEP_TYPE_LABELS[type], type, enabled: true, gasUsage: [], sourceAssignments: [], gasAssignments: [], origin, calculatedFields: [] };
}

function renumber(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

// ---------- Recipe Builder (item 5): pure, immutable operations on a step list ----------

export function addStep(steps: ProcessStep[], type: StepType, name?: string): ProcessStep[] {
  return renumber([...steps, { ...createStep(type, name, 'user'), order: steps.length + 1 }]);
}

export function removeStep(steps: ProcessStep[], order: number): ProcessStep[] {
  return renumber(steps.filter(step => step.order !== order));
}

export function duplicateStep(steps: ProcessStep[], order: number): ProcessStep[] {
  const index = steps.findIndex(step => step.order === order);
  if (index === -1) throw new Error(`Этап №${order} не найден.`);
  // Duplicating is itself an explicit user action, regardless of whether the ORIGINAL step
  // came from a preset - the copy must never keep claiming origin: 'preset' (Codex regression).
  //
  // F06 (second Codex regression): `origin` and `calculatedFields` answer two DIFFERENT
  // questions and must not be conflated - `origin` is "was this STEP created as a user copy"
  // (always 'user' for a duplicate, correct above), while `calculatedFields` is "did a
  // calculator ACTUALLY produce this field's current value" (a fact about the value itself,
  // unchanged by copying it verbatim). Wiping calculatedFields to [] here previously made a
  // freshly-copied calculated duration (e.g. 100 min from calculateStepDurationFromDeposition)
  // look exactly like a value the user had typed by hand, destroying real provenance for a
  // value nothing about the copy operation actually changed. It is carried over unchanged; the
  // EXISTING updateStep() already clears the stamp correctly the moment the user edits that
  // field on the copy (see the "edit the copied step" test), so provenance still updates the
  // instant the value stops being the calculator's own output.
  const copy: ProcessStep = {
    ...steps[index], gasUsage: steps[index].gasUsage.map(g => ({ ...g })),
    sourceAssignments: steps[index].sourceAssignments.map(a => ({ ...a })), gasAssignments: steps[index].gasAssignments.map(a => ({ ...a })),
    origin: 'user', calculatedFields: [...steps[index].calculatedFields],
  };
  const next = [...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)];
  return renumber(next);
}

export function moveStep(steps: ProcessStep[], order: number, direction: 'up' | 'down'): ProcessStep[] {
  const index = steps.findIndex(step => step.order === order);
  if (index === -1) throw new Error(`Этап №${order} не найден.`);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return renumber(next);
}

export function toggleStepEnabled(steps: ProcessStep[], order: number): ProcessStep[] {
  return steps.map(step => step.order === order ? { ...step, enabled: !step.enabled } : step);
}

/** F06: manually editing a field that is currently stamped as system-calculated
 *  (`calculatedFields`) must clear that stamp for exactly that field - the value on screen is
 *  now the user's own typed value, not the calculator's output, and provenance must reflect
 *  what actually produced the CURRENT value, not what produced an earlier one. Any other
 *  field's calculated stamp (if this step ever has more than one) is left untouched. */
export function updateStep(steps: ProcessStep[], order: number, patch: Partial<Omit<ProcessStep, 'order' | 'origin' | 'calculatedFields'>>): ProcessStep[] {
  const editedFields = Object.keys(patch);
  return steps.map(step => step.order === order
    ? { ...step, ...patch, origin: 'user', calculatedFields: step.calculatedFields.filter(f => !editedFields.includes(f)) }
    : step);
}

/** Explicit-action-only calculation (item 14): reuses Engineering Calculators' own deposition
 *  formula to fill a step's duration from a user-confirmed thickness and rate. Never called
 *  automatically - only in direct response to the user pressing a dedicated "calculate" control,
 *  and it stamps `calculatedFields` so the origin of the value stays visible (traceability). */
export function calculateStepDurationFromDeposition(
  steps: ProcessStep[], order: number,
  thickness: number, thicknessUnit: ThicknessUnit, rate: number, rateUnit: RateUnit,
): ProcessStep[] {
  const result = solveDeposition({ solveFor: 'time', thickness, thicknessUnit, rate, rateUnit, timeUnit: 'min' });
  return steps.map(step => step.order === order
    ? { ...step, durationMin: result.value, calculatedFields: Array.from(new Set([...step.calculatedFields, 'durationMin'])) }
    : step);
}

// ---------- Sources (item 5) ----------

export interface MagnetronSource { id: string; enabled: boolean; material?: string; powerW?: number; mode?: string }
export interface ArcSource { id: string; enabled: boolean; cathodeMaterial?: string; arcCurrentA?: number; filtered: boolean }
export interface IcpRfSource { enabled: boolean; powerW?: number; biasV?: number }
export interface IonSource { enabled: boolean; voltageV?: number; currentA?: number; powerW?: number }

export interface SourceSet {
  magnetrons: MagnetronSource[];
  arcSources: ArcSource[];
  icpRf: IcpRfSource;
  ionSource: IonSource;
}

export function createDefaultSourceSet(): SourceSet {
  return { magnetrons: [], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } };
}

/** A new source id is derived from the sources that ALREADY exist in the list - never from a
 *  module-level counter. The old counter restarted at 0 on every page load, so after a saved
 *  document was restored (ids "magnetron-1", "magnetron-2", ...) the next "add" minted
 *  "magnetron-1" again: two records with one id, and an update/remove by id then hit both.
 *  The next id is one past the highest numeric suffix present, and is re-checked against the
 *  whole id set, so it can never equal an existing id whatever the list contains (restored data,
 *  hand-edited ids, ids with huge or non-numeric suffixes). */
function nextSourceId(prefix: string, existing: readonly { id: string }[]): string {
  const used = new Set(existing.map(item => item.id));
  const pattern = new RegExp(`^${prefix}-(\\d{1,9})$`);
  let max = 0;
  for (const id of used) {
    const match = pattern.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let n = max + 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

/** Ids that occur more than once in one list, or are empty - what makes update/remove-by-id
 *  ambiguous. Pure check; changes nothing. */
export function findDuplicateSourceIds(sources: SourceSet): { magnetrons: string[]; arcSources: string[] } {
  const duplicated = (items: readonly { id: string }[]) => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const { id } of items) { if (id.trim() === '' || seen.has(id)) repeated.add(id); seen.add(id); }
    return [...repeated];
  };
  return { magnetrons: duplicated(sources.magnetrons), arcSources: duplicated(sources.arcSources) };
}

function withUniqueIds<T extends { id: string }>(items: readonly T[], prefix: string): { items: T[]; repaired: number } {
  // The FIRST record that uses an id keeps it; only later repeats (and empty ids) get a fresh
  // id. Nothing but `id` is ever touched - every user-entered parameter is kept as is.
  const kept = new Set<string>();
  const needsNewId = items.map(item => {
    if (item.id.trim() === '' || kept.has(item.id)) return true;
    kept.add(item.id);
    return false;
  });
  const taken: { id: string }[] = [...kept].map(id => ({ id }));
  let repaired = 0;
  const result = items.map((item, index) => {
    if (!needsNewId[index]) return item;
    const id = nextSourceId(prefix, taken);
    taken.push({ id });
    repaired += 1;
    return { ...item, id };
  });
  return { items: result, repaired };
}

/** Makes every magnetron id and every arc-source id unique within its list (see withUniqueIds).
 *  Returns the same SourceSet content when nothing needed repair. */
export function ensureUniqueSourceIds(sources: SourceSet): { sources: SourceSet; repaired: number } {
  const magnetrons = withUniqueIds(sources.magnetrons, 'magnetron');
  const arcSources = withUniqueIds(sources.arcSources, 'arc');
  const repaired = magnetrons.repaired + arcSources.repaired;
  return repaired === 0 ? { sources, repaired: 0 } : { sources: { ...sources, magnetrons: magnetrons.items, arcSources: arcSources.items }, repaired };
}

export function addMagnetron(sources: SourceSet): SourceSet {
  return { ...sources, magnetrons: [...sources.magnetrons, { id: nextSourceId('magnetron', sources.magnetrons), enabled: true }] };
}
export function removeMagnetron(sources: SourceSet, id: string): SourceSet {
  return { ...sources, magnetrons: sources.magnetrons.filter(m => m.id !== id) };
}
export function updateMagnetron(sources: SourceSet, id: string, patch: Partial<MagnetronSource>): SourceSet {
  return { ...sources, magnetrons: sources.magnetrons.map(m => m.id === id ? { ...m, ...patch } : m) };
}

export function addArcSource(sources: SourceSet): SourceSet {
  return { ...sources, arcSources: [...sources.arcSources, { id: nextSourceId('arc', sources.arcSources), enabled: true, filtered: false }] };
}
export function removeArcSource(sources: SourceSet, id: string): SourceSet {
  return { ...sources, arcSources: sources.arcSources.filter(a => a.id !== id) };
}
export function updateArcSource(sources: SourceSet, id: string, patch: Partial<ArcSource>): SourceSet {
  return { ...sources, arcSources: sources.arcSources.map(a => a.id === id ? { ...a, ...patch } : a) };
}

// ---------- Gas system (item 6): at least 5 lines by default, custom gas names allowed ----------

export interface GasLine { id: string; gas: string; flow?: number; unit: string; enabled: boolean }

export function createDefaultGasLines(): GasLine[] {
  return Array.from({ length: 5 }, (_, i) => ({ id: `gas-${i + 1}`, gas: '', unit: 'sccm', enabled: false }));
}

export function addGasLine(lines: GasLine[]): GasLine[] {
  // Unique among the CURRENT lines (derived like source ids): step assignments reference a line by this id.
  return [...lines, { id: nextSourceId('gas', lines), gas: '', unit: 'sccm', enabled: false }];
}
export function removeGasLine(lines: GasLine[], id: string): GasLine[] {
  return lines.filter(l => l.id !== id);
}
export function updateGasLine(lines: GasLine[], id: string, patch: Partial<GasLine>): GasLine[] {
  return lines.map(l => l.id === id ? { ...l, ...patch } : l);
}

// ---------- Step assignments of sources and gas lines (schema 3) ----------
//
// Section D (sources) and section E (gas lines) describe the EQUIPMENT: what exists and, for each
// item, what it is. An assignment says what is USED on one step: a reference (`sourceId`/`lineId`)
// plus ON/OFF, the step-specific power/current/flow and the time window. Materials and gas names
// are never copied into an assignment - they are read from D/E, so one fact has one place to edit.

function mapStep(steps: ProcessStep[], order: number, update: (step: ProcessStep) => ProcessStep): ProcessStep[] {
  if (!steps.some(step => step.order === order)) throw new Error(`Этап №${order} не найден.`);
  return steps.map(step => step.order === order ? { ...update(step), origin: 'user' as const } : step);
}

const sameSource = (kind: SourceKind, sourceId: string) => (a: StepSourceAssignment) => a.kind === kind && a.sourceId === sourceId;

/** Assigns an existing source to a step, ON, in parallel mode, with NO power/current/time filled
 *  in. Assigning the same source to the same step twice changes nothing (no duplicates). */
export function addSourceAssignment(steps: ProcessStep[], order: number, kind: SourceKind, sourceId: string): ProcessStep[] {
  return mapStep(steps, order, step => step.sourceAssignments.some(sameSource(kind, sourceId))
    ? step
    : { ...step, sourceAssignments: [...step.sourceAssignments, { sourceId, kind, enabled: true, mode: 'parallel' }] });
}
export function updateSourceAssignment(
  steps: ProcessStep[], order: number, kind: SourceKind, sourceId: string,
  patch: Partial<Omit<StepSourceAssignment, 'sourceId' | 'kind'>>,
): ProcessStep[] {
  return mapStep(steps, order, step => ({ ...step, sourceAssignments: step.sourceAssignments.map(a => sameSource(kind, sourceId)(a) ? { ...a, ...patch } : a) }));
}
export function removeSourceAssignment(steps: ProcessStep[], order: number, kind: SourceKind, sourceId: string): ProcessStep[] {
  return mapStep(steps, order, step => ({ ...step, sourceAssignments: step.sourceAssignments.filter(a => !sameSource(kind, sourceId)(a)) }));
}

export function addGasAssignment(steps: ProcessStep[], order: number, lineId: string): ProcessStep[] {
  return mapStep(steps, order, step => step.gasAssignments.some(a => a.lineId === lineId)
    ? step
    : { ...step, gasAssignments: [...step.gasAssignments, { lineId, enabled: true }] });
}
export function updateGasAssignment(steps: ProcessStep[], order: number, lineId: string, patch: Partial<Omit<StepGasAssignment, 'lineId'>>): ProcessStep[] {
  return mapStep(steps, order, step => ({ ...step, gasAssignments: step.gasAssignments.map(a => a.lineId === lineId ? { ...a, ...patch } : a) }));
}
export function removeGasAssignment(steps: ProcessStep[], order: number, lineId: string): ProcessStep[] {
  return mapStep(steps, order, step => ({ ...step, gasAssignments: step.gasAssignments.filter(a => a.lineId !== lineId) }));
}

/** Numbers of the steps that use a source / a gas line. */
export function findSourceUsage(doc: Pick<TechnicalProcessDocument, 'steps'>, kind: SourceKind, sourceId: string): number[] {
  return doc.steps.filter(step => step.sourceAssignments.some(sameSource(kind, sourceId))).map(step => step.order);
}
export function findGasLineUsage(doc: Pick<TechnicalProcessDocument, 'steps'>, lineId: string): number[] {
  return doc.steps.filter(step => step.gasAssignments.some(a => a.lineId === lineId)).map(step => step.order);
}

export interface RemovalResult { document: TechnicalProcessDocument; blockedBySteps: number[] }

/** Deleting a source (or gas line) that steps still use would leave those steps pointing at
 *  nothing, or silently erase their settings - so it is REFUSED: the document is returned
 *  unchanged together with the steps that still use it. Unused ones are removed. */
export function removeSourceFromDocument(doc: TechnicalProcessDocument, kind: SourceKind, sourceId: string): RemovalResult {
  const blockedBySteps = findSourceUsage(doc, kind, sourceId);
  if (blockedBySteps.length > 0) return { document: doc, blockedBySteps };
  const sources = kind === 'magnetron' ? removeMagnetron(doc.sources, sourceId) : removeArcSource(doc.sources, sourceId);
  return { document: { ...doc, sources }, blockedBySteps };
}
export function removeGasLineFromDocument(doc: TechnicalProcessDocument, lineId: string): RemovalResult {
  const blockedBySteps = findGasLineUsage(doc, lineId);
  if (blockedBySteps.length > 0) return { document: doc, blockedBySteps };
  return { document: { ...doc, gasSystem: removeGasLine(doc.gasSystem, lineId) }, blockedBySteps };
}

const TIME_EPS = 1e-9;
const trimNumber = (value: number) => Number(value.toPrecision(12)); // display of a derived sum only (0.1 + 0.2)

/** "0–30 мин" when start and duration are both known; otherwise says exactly what is missing.
 *  A duration of 0 is a VALUE (the source/line does not run: an empty interval), clearly different
 *  from "not set". A sum that is not a finite number is reported as such - "Infinity" is never
 *  printed. */
export function formatTimeWindow(startMin: number | undefined, durationMin: number | undefined): string {
  if ([startMin, durationMin].some(v => v !== undefined && !Number.isFinite(v))) return 'некорректное значение времени';
  const zero = 'длительность 0 мин (нулевой интервал: работы нет)';
  if (startMin !== undefined && durationMin !== undefined) {
    const end = startMin + durationMin;
    if (!Number.isFinite(end)) return `начало ${startMin} мин, длительность ${durationMin} мин (конец интервала не определён: слишком большие значения)`;
    return durationMin === 0 ? `начало ${startMin} мин, ${zero}` : `${startMin}–${trimNumber(end)} мин`;
  }
  if (startMin !== undefined) return `начало ${startMin} мин, длительность не задана`;
  if (durationMin !== undefined) return durationMin === 0 ? `начало не задано, ${zero}` : `начало не задано, длительность ${durationMin} мин`;
  return 'не задано';
}

interface SourceRef { enabled: boolean; label: string; description: string; material: string }

function lookupSource(doc: Pick<TechnicalProcessDocument, 'sources'>, kind: SourceKind, sourceId: string): SourceRef | undefined {
  const label = `${SOURCE_KIND_LABELS[kind]} ${sourceId}`;
  if (kind === 'magnetron') {
    const m = doc.sources.magnetrons.find(x => x.id === sourceId);
    if (!m) return undefined;
    const material = m.material?.trim() ? m.material : 'материал не задан';
    return { enabled: m.enabled, label, material, description: `мишень: ${material}` };
  }
  const a = doc.sources.arcSources.find(x => x.id === sourceId);
  if (!a) return undefined;
  const material = `${a.cathodeMaterial?.trim() ? a.cathodeMaterial : 'материал не задан'}${a.filtered ? ', фильтрованный' : ''}`;
  return { enabled: a.enabled, label, material, description: `катод: ${material}` };
}

/** One source assignment as a single line: which source and its material (from section D), ON/OFF,
 *  power or current, the time window and the mode. OFF is stated as OFF; unset values are
 *  stated as unset - nothing is filled in. */
export function formatSourceAssignment(doc: Pick<TechnicalProcessDocument, 'sources'>, a: StepSourceAssignment): string {
  const ref = lookupSource(doc, a.kind, a.sourceId);
  const head = `${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId} (${ref ? ref.description : 'нет в разделе D'})`;
  if (!a.enabled) return `${head}: ОТКЛ на этапе`;
  const value = a.kind === 'magnetron'
    ? `мощность — ${a.powerW !== undefined ? `${a.powerW} Вт` : 'не задана'}`
    : `ток дуги — ${a.currentA !== undefined ? `${a.currentA} А` : 'не задан'}`;
  return `${head}: ВКЛ, ${value}, время — ${formatTimeWindow(a.startMin, a.durationMin)}, режим — ${ASSIGNMENT_MODE_LABELS[a.mode]}`;
}

export function formatGasAssignment(doc: Pick<TechnicalProcessDocument, 'gasSystem'>, a: StepGasAssignment): string {
  const line = doc.gasSystem.find(l => l.id === a.lineId);
  const head = `Линия ${a.lineId} (газ: ${line ? (line.gas.trim() ? line.gas : 'не указан в разделе E') : 'нет в разделе E'})`;
  if (!a.enabled) return `${head}: ОТКЛ на этапе`;
  return `${head}: ВКЛ, расход — ${a.flowSccm !== undefined ? `${a.flowSccm} sccm` : 'не задан'}, подача — ${formatTimeWindow(a.startMin, a.durationMin)}`;
}

/** One source assignment split into table cells (the same facts, wording and OFF/unset rules as
 *  formatSourceAssignment): used where each assignment gets a row of its own. */
export function sourceAssignmentFields(doc: Pick<TechnicalProcessDocument, 'sources'>, a: StepSourceAssignment): { source: string; material: string; state: string; value: string; time: string; mode: string } {
  const ref = lookupSource(doc, a.kind, a.sourceId);
  const base = { source: `${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId}`, material: ref ? ref.material : 'нет в разделе D' };
  if (!a.enabled) return { ...base, state: 'ОТКЛ', value: '—', time: '—', mode: '—' };
  const value = a.kind === 'magnetron'
    ? `мощность — ${a.powerW !== undefined ? `${a.powerW} Вт` : 'не задана'}`
    : `ток дуги — ${a.currentA !== undefined ? `${a.currentA} А` : 'не задан'}`;
  return { ...base, state: 'ВКЛ', value, time: formatTimeWindow(a.startMin, a.durationMin), mode: ASSIGNMENT_MODE_LABELS[a.mode] };
}

export function gasAssignmentFields(doc: Pick<TechnicalProcessDocument, 'gasSystem'>, a: StepGasAssignment): { line: string; gas: string; state: string; flow: string; time: string } {
  const line = doc.gasSystem.find(l => l.id === a.lineId);
  const base = { line: `Линия ${a.lineId}`, gas: line ? (line.gas.trim() ? line.gas : 'не указан в разделе E') : 'нет в разделе E' };
  if (!a.enabled) return { ...base, state: 'ОТКЛ', flow: '—', time: '—' };
  return { ...base, state: 'ВКЛ', flow: a.flowSccm !== undefined ? `${a.flowSccm} sccm` : 'не задан', time: formatTimeWindow(a.startMin, a.durationMin) };
}

/** A card cell moves to a detail table when its text would need more than CARD_CELL_LINE_BUDGET lines in
 *  its real column (see techdoc-card-layout.ts for how the number was measured) - decided by the SIZE of
 *  the content, not by how many assignments there are: four short ones stay inline, four assignments
 *  with very long gas names do not. */
const cellTooTall = (text: string, column: number) => estimateLines(text, columnWidthPt(CARD_COLUMN_WEIGHTS, column), TYPICAL_CHAR_PT) > CARD_CELL_LINE_BUDGET;
export const hasLongSourceList = (doc: TechnicalProcessDocument, step: ProcessStep) => step.sourceAssignments.length > 0 && cellTooTall(fmtSourcePower(doc, step), CARD_SOURCE_COLUMN);
export const hasLongGasList = (doc: TechnicalProcessDocument, step: ProcessStep) => step.gasAssignments.length > 0 && cellTooTall(fmtStepGases(doc, step), CARD_GAS_COLUMN);
export function cardDetailHeading(step: ProcessStep, kind: 'sources' | 'gases'): string {
  return `Этап №${step.order} «${step.name}»: ${kind === 'sources' ? 'источники' : 'газовые линии'}`;
}

/** Everything a step's assignments contribute to a document, as lines - the single source for the
 *  on-screen preview and the exports, so they cannot disagree. */
export function buildStepAssignmentLines(doc: TechnicalProcessDocument, step: ProcessStep): { sources: string[]; gases: string[]; notes: string[]; warnings: string[] } {
  const sources = step.sourceAssignments.map(a => formatSourceAssignment(doc, a));
  const gases = step.gasAssignments.map(a => formatGasAssignment(doc, a));
  const notes: string[] = [];
  if (step.sourceAssignments.some(a => a.enabled && a.mode === 'sequential')) notes.push(`Последовательный режим: ${SEQUENTIAL_MODE_MEANING}.`);
  if (step.gasAssignments.some(a => a.enabled && a.flowSccm !== undefined)) notes.push(`Расход газа: ${SCCM_MEANING}.`);
  const warnings = collectStepWarningItems(doc).filter(w => w.order === step.order).map(w => w.text);
  return { sources, gases, notes, warnings };
}

/** Consistency of every step's assignments with section D / E and with the step's own timing. Only
 *  objective contradictions throw (see validateDocument): a dangling or unusable reference,
 *  negative times, an interval outside the step, a duplicate, a sequential source that overlaps
 *  another. Missing values are never errors here - an ON source with no power is "not set". */
function validateAssignments(doc: TechnicalProcessDocument): void {
  const lineIds = new Set<string>();
  for (const line of doc.gasSystem) {
    if (lineIds.has(line.id)) throw new Error(`Газовая система: повторяется идентификатор линии «${line.id}». Идентификаторы линий должны быть уникальными.`);
    lineIds.add(line.id);
  }
  for (const step of doc.steps) {
    const where = `Этап №${step.order}`;
    const within = (label: string, start: number | undefined, duration: number | undefined) => {
      checkOptionalNonNegative(start, `${where}: ${label}: начало`);
      checkOptionalNonNegative(duration, `${where}: ${label}: длительность`);
      if (start !== undefined && duration !== undefined && !Number.isFinite(start + duration)) {
        throw new Error(`${where}: ${label}: начало + длительность не является конечным числом (слишком большие значения).`);
      }
    };
    const insideStep = (label: string, start: number | undefined, duration: number | undefined) => {
      if (step.durationMin === undefined) return;
      const limit = step.durationMin + TIME_EPS;
      if (start !== undefined && start > limit) throw new Error(`${where}: ${label}: начало (${start} мин) позже конца этапа (${step.durationMin} мин).`);
      if ((start ?? 0) + (duration ?? 0) > limit) throw new Error(`${where}: ${label}: интервал выходит за пределы этапа (${formatTimeWindow(start, duration)}; длительность этапа ${step.durationMin} мин).`);
    };

    const seen = new Set<string>();
    for (const a of step.sourceAssignments) {
      const label = `${SOURCE_KIND_LABELS[a.kind] ?? a.kind} ${a.sourceId}`;
      if (!(SOURCE_KINDS as readonly string[]).includes(a.kind)) throw new Error(`${where}: недопустимый тип источника «${a.kind}».`);
      if (!(ASSIGNMENT_MODES as readonly string[]).includes(a.mode)) throw new Error(`${where}: ${label}: недопустимый режим работы.`);
      const key = `${a.kind}:${a.sourceId}`;
      if (seen.has(key)) throw new Error(`${where}: ${label} назначен на этап дважды.`);
      seen.add(key);
      const ref = lookupSource(doc, a.kind, a.sourceId);
      if (!ref) throw new Error(`${where}: назначен ${label}, которого нет в разделе D «Источники» (возможно, удалён). Снимите назначение или добавьте источник.`);
      if (a.enabled && !ref.enabled) throw new Error(`${where}: ${label} отключён в установке (раздел D), его нельзя включить на этапе.`);
      checkOptionalNonNegative(a.kind === 'magnetron' ? a.powerW : a.currentA, `${where}: ${label}: ${a.kind === 'magnetron' ? 'мощность' : 'ток дуги'}`);
      within(label, a.startMin, a.durationMin);
      if (a.enabled) insideStep(label, a.startMin, a.durationMin);
    }

    const running = step.sourceAssignments.filter(a => a.enabled);
    for (const a of running.filter(x => x.mode === 'sequential')) {
      const label = `${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId}`;
      if (a.startMin === undefined || a.durationMin === undefined) throw new Error(`${where}: ${label}: для последовательного режима нужно задать начало и длительность работы.`);
      const aEnd = a.startMin + a.durationMin;
      if (a.durationMin === 0) continue; // an empty interval (0 min = no work) overlaps nothing
      for (const b of running) {
        if (b === a || b.startMin === undefined || b.durationMin === undefined || b.durationMin === 0) continue;
        const bEnd = b.startMin + b.durationMin;
        if (a.startMin < bEnd - TIME_EPS && b.startMin < aEnd - TIME_EPS) {
          throw new Error(`${where}: ${label} работает последовательно, но его интервал (${formatTimeWindow(a.startMin, a.durationMin)}) пересекается с интервалом ${SOURCE_KIND_LABELS[b.kind]} ${b.sourceId} (${formatTimeWindow(b.startMin, b.durationMin)}).`);
        }
      }
    }

    const seenLines = new Set<string>();
    for (const a of step.gasAssignments) {
      const label = `линия ${a.lineId}`;
      if (seenLines.has(a.lineId)) throw new Error(`${where}: ${label} назначена на этап дважды.`);
      seenLines.add(a.lineId);
      const line = doc.gasSystem.find(l => l.id === a.lineId);
      if (!line) throw new Error(`${where}: назначена ${label}, которой нет в разделе E «Газовая система» (возможно, удалена). Снимите назначение или добавьте линию.`);
      if (a.enabled && !line.enabled) throw new Error(`${where}: ${label} отключена в газовой системе (раздел E), её нельзя использовать на этапе.`);
      checkOptionalNonNegative(a.flowSccm, `${where}: ${label}: расход`);
      within(label, a.startMin, a.durationMin);
      if (a.enabled) insideStep(label, a.startMin, a.durationMin);
    }
  }
}

export interface StepWarning { order: number; text: string }

/** Non-blocking remarks per step: things that cannot be verified or that need the user's attention
 *  but are not contradictions (so an incomplete draft can still be saved and exported). The same
 *  list feeds the editor, the preview and the DOCX/PDF instruction - nothing is shown in one and
 *  hidden in another. */
export function collectStepWarningItems(doc: TechnicalProcessDocument): StepWarning[] {
  const warnings: StepWarning[] = [];
  for (const step of doc.steps) {
    const warn = (text: string) => warnings.push({ order: step.order, text });
    const running = step.sourceAssignments.filter(a => a.enabled);
    const label = (a: StepSourceAssignment) => `${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId}`;

    // The step's own general power/current/gas fields AND structured assignments: both are kept, the
    // app picks neither and does not treat them as equivalent (even for the same material or gas).
    const generalSource = [step.powerW !== undefined ? `мощность этапа ${step.powerW} Вт` : null, step.currentA !== undefined ? `ток этапа ${step.currentA} А` : null].filter(Boolean);
    if (generalSource.length > 0 && step.sourceAssignments.length > 0) {
      warn(`заданы и общие значения этапа (${generalSource.join(', ')}), и назначения источников. Значения не считаются эквивалентными и приоритет не выбирается - проверьте, какие из них действуют.`);
    }
    if (step.gasUsage.length > 0 && step.gasAssignments.length > 0) {
      warn('задан и общий список газов этапа, и назначения газовых линий. Значения не считаются эквивалентными (даже при одинаковом газе) и приоритет не выбирается - проверьте, какие из них действуют.');
    }

    for (const a of running.filter(x => x.mode === 'sequential')) {
      for (const b of running.filter(x => x !== a && (x.startMin === undefined || x.durationMin === undefined))) {
        warn(`у ${label(b)} не заданы начало и длительность - непересечение с последовательным ${label(a)} проверить нельзя.`);
      }
    }
    const timed = [...running, ...step.gasAssignments.filter(a => a.enabled)].some(a => a.startMin !== undefined || a.durationMin !== undefined);
    if (timed && step.durationMin === undefined) warn('не задана длительность этапа - интервалы источников и газов нельзя сверить с границами этапа.');

    for (const a of running.filter(x => x.durationMin === 0)) warn(`${label(a)} включён, но его длительность 0 мин - фактически он не работает на этапе.`);
    for (const a of step.gasAssignments.filter(x => x.enabled)) {
      if (a.durationMin === 0) warn(`линия ${a.lineId} включена, но длительность подачи 0 мин - газ фактически не подаётся.`);
      const line = doc.gasSystem.find(l => l.id === a.lineId);
      if (!line) continue;
      if (!line.gas.trim()) warn(`для линии ${line.id} в разделе E не указан газ.`);
      if (line.unit.trim().toLowerCase() !== 'sccm') warn(`линия ${line.id} ведётся в разделе E в единицах «${line.unit}»; расход на этапе задаётся в sccm и не пересчитывается.`);
    }
  }
  return warnings;
}

export function collectStepWarnings(doc: TechnicalProcessDocument): string[] {
  return collectStepWarningItems(doc).map(w => `Этап №${w.order}: ${w.text}`);
}

// ---------- Quality checks (item 11) - categories only, no invented norms ----------

export const QUALITY_CHECK_CATEGORIES = [
  'Толщина покрытия', 'Адгезия', 'Шероховатость', 'Визуальный контроль',
  'Износостойкость/трибология', 'Электрический параметр', 'Глубина/скорость травления',
] as const;

export interface QualityCheck {
  id: string;
  parameter: string;
  method?: string;
  criterion?: string;
  unit?: string;
  result?: string;
  status?: 'pass' | 'fail' | 'not_tested';
}

export function createQualityCheck(parameter: string): QualityCheck {
  return { id: `qc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, parameter };
}

// ---------- Safety (item 12) - fields only, never auto-filled ----------

export interface SafetySection {
  hazards: string[];
  ppe: string[];
  interlocks: string[];
  gasSafety?: string;
  vacuumSafety?: string;
  highVoltage?: string;
  hotSurfaces?: string;
  notes?: string;
}

export function createDefaultSafety(): SafetySection {
  return { hazards: [], ppe: [], interlocks: [] };
}

// ---------- General info (A) / Initial data (B) ----------

export interface GeneralInfo {
  processName: string;
  purpose?: string;
  equipment?: string;
  installationModel?: string;
  substrateMaterial?: string;
  productType?: string;
  coatingMaterial?: string;
  responsible?: string;
  documentVersion?: string;
  date?: string;
}

export interface InitialData {
  partSizeMm?: number;
  quantity?: number;
  initialSurfaceCondition?: string;
  cleanlinessRequirement?: string;
  coatingRequirement?: string;
  requiredThicknessUm?: number;
  allowedTemperatureC?: number;
  additionalRequirements?: string;
}

// ---------- Traceability (item 13) ----------

export interface Traceability { version: number; createdAt: string; updatedAt: string; source: string }

export function touchDocument(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  return { ...doc, traceability: { ...doc.traceability, version: doc.traceability.version + 1, updatedAt: new Date().toISOString() } };
}

/** Attempts to restore a document previously saved to the browser's own localStorage (see the
 *  "Экспорт документа" module's "Сохранить структуру" control) - returns `null` on anything
 *  that doesn't parse as JSON or doesn't pass the same validation a fresh edit would, so a
 *  corrupted/incompatible save never crashes the page or silently loads a half-broken document.
 *
 *  F07: a bare `JSON.parse(...) as TechnicalProcessDocument` type assertion previously trusted
 *  the persisted shape completely - `validateDocument` only range-checks numeric VALUES on the
 *  assumption the document is already correctly SHAPED (an array where one is expected, an
 *  object where one is expected, etc.), so a structurally wrong but numerically-quiet snapshot
 *  (e.g. `steps` replaced by a string, a missing `safety`/`qualityChecks` field) could pass
 *  straight through and only crash LATER, outside this function's own try/catch, when a
 *  view/export tried to read it. `parseTechnicalProcessDocument` (techdoc-parse.ts) is the
 *  same thorough structural parser the DOCX/PDF export API route already trusts for untrusted
 *  HTTP input - reusing it here closes that gap instead of writing a second, possibly
 *  inconsistent validator. */
export function tryRestoreDocument(rawJson: string | null | undefined): TechnicalProcessDocument | null {
  const result = restoreDocumentDetailed(rawJson);
  return result.status === 'ok' ? result.document : null;
}

/** Same as tryRestoreDocument, plus how many source ids had to be repaired. A saved document
 *  can contain duplicate (or empty) magnetron/arc ids - written by the old counter-based id
 *  generator after an earlier restore - and with duplicates an update or delete by id changes
 *  several sources at once. Duplicates are repaired on restore: the first record keeps its id,
 *  later repeats get a fresh unique one, and no source parameter is altered. */
export function restoreDocumentWithReport(rawJson: string | null | undefined): { document: TechnicalProcessDocument; repairedSourceIds: number } | null {
  const result = restoreDocumentDetailed(rawJson);
  return result.status === 'ok' ? { document: result.document, repairedSourceIds: result.repairedSourceIds } : null;
}

export type RestoreResult =
  | { status: 'empty' }
  /** `migratedFromSchema` is set when the saved document was an OLDER schema and was converted in
   *  memory (1 -> pressure mbar -> Pa; 1 or 2 -> empty step assignments). Nothing is written back
   *  by restoring: the stored copy stays as it was until the user saves explicitly. */
  | { status: 'ok'; document: TechnicalProcessDocument; repairedSourceIds: number; repairedGasLineIds: number; migratedFromSchema?: number }
  /** Saved by a NEWER schema than this build knows: not parsed, not converted, not loaded. */
  | { status: 'future_version'; schemaVersion: number }
  /** Unusable data. `reason` (when known) is a safe, human-readable explanation to show the user. */
  | { status: 'invalid'; reason?: string };

/** Restores a saved document and says WHY when it cannot: nothing saved, a newer unknown schema
 *  (the caller must tell the user and must not overwrite it silently), or unusable data. Never
 *  throws and never writes to storage. */
class DocumentIntegrityError extends Error {}

/** Repairing a duplicated id (first owner keeps it, later ones get a new id) is only safe while NO
 *  step refers to that id. If a step's assignment points at an id that two or more records share, it
 *  is impossible to know which record was meant - guessing would silently bind the step to the wrong
 *  source or gas. That is refused with an explanation instead. */
function assertNoAmbiguousReferences(doc: TechnicalProcessDocument): void {
  const duplicated = (items: readonly { id: string }[]) => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const { id } of items) { if (id.trim() === '') continue; if (seen.has(id)) repeated.add(id); seen.add(id); }
    return repeated;
  };
  const lines = duplicated(doc.gasSystem);
  const magnetrons = duplicated(doc.sources.magnetrons);
  const arcs = duplicated(doc.sources.arcSources);
  for (const step of doc.steps) {
    for (const a of step.gasAssignments) {
      if (!lines.has(a.lineId)) continue;
      const candidates = doc.gasSystem.filter(l => l.id === a.lineId).map(l => l.gas.trim() || 'газ не указан').join(' / ');
      throw new DocumentIntegrityError(`Этап №${step.order}: назначена линия ${a.lineId}, но в разделе E несколько линий с таким идентификатором (${candidates}). Определить, какая имеется в виду, нельзя. Документ не загружен и не изменён - исправьте идентификаторы линий вручную.`);
    }
    for (const a of step.sourceAssignments) {
      const repeated = a.kind === 'magnetron' ? magnetrons : arcs;
      if (!repeated.has(a.sourceId)) continue;
      const pool = a.kind === 'magnetron' ? doc.sources.magnetrons.filter(m => m.id === a.sourceId).map(m => m.material) : doc.sources.arcSources.filter(x => x.id === a.sourceId).map(x => x.cathodeMaterial);
      throw new DocumentIntegrityError(`Этап №${step.order}: назначен ${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId}, но в разделе D несколько источников с таким идентификатором (${pool.map(m => m?.trim() || 'материал не задан').join(' / ')}). Определить, какой имеется в виду, нельзя. Документ не загружен и не изменён - исправьте идентификаторы источников вручную.`);
    }
  }
}

export function restoreDocumentDetailed(rawJson: string | null | undefined): RestoreResult {
  if (!rawJson) return { status: 'empty' };
  try {
    const json: unknown = JSON.parse(rawJson);
    const savedSchema = json !== null && typeof json === 'object' && !Array.isArray(json) ? parseSchemaVersion((json as Record<string, unknown>).schemaVersion) : 1;
    const parsed = parseTechnicalProcessDocument(json);
    assertNoAmbiguousReferences(parsed);
    // Duplicate ids are repaired BEFORE validation (validation rejects a repeated gas line id):
    // the first record keeps its id, later repeats get a fresh one, nothing else changes.
    const { sources, repaired } = ensureUniqueSourceIds(parsed.sources);
    const gas = withUniqueIds(parsed.gasSystem, 'gas');
    const document = repaired === 0 && gas.repaired === 0 ? parsed : { ...parsed, sources, gasSystem: gas.items };
    validateDocument(document);
    return {
      status: 'ok', document, repairedSourceIds: repaired, repairedGasLineIds: gas.repaired,
      ...(savedSchema < TECHDOC_SCHEMA_VERSION ? { migratedFromSchema: savedSchema } : {}),
    };
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError) return { status: 'future_version', schemaVersion: error.schemaVersion };
    const reason = error instanceof SyntaxError ? 'Сохранённые данные повреждены (это не корректный JSON).' : error instanceof Error ? error.message : undefined;
    return { status: 'invalid', reason };
  }
}

// ---------- TechnicalProcessDocument (top level) ----------

export interface TechnicalProcessDocument {
  /** Version of the STORAGE FORMAT (see techdoc-schema.ts) - not the revision of the document's
   *  content, which is `traceability.version`. */
  schemaVersion: number;
  /** Display unit of every step pressure in the editor, previews and exports. Changing it never
   *  changes a stored value (those are always pascal). */
  pressureUnit: PressureUnit;
  general: GeneralInfo;
  initialData: InitialData;
  steps: ProcessStep[];
  sources: SourceSet;
  gasSystem: GasLine[];
  qualityChecks: QualityCheck[];
  safety: SafetySection;
  traceability: Traceability;
}

export function createBlankDocument(): TechnicalProcessDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: TECHDOC_SCHEMA_VERSION,
    pressureUnit: DEFAULT_PRESSURE_UNIT,
    general: { processName: '' },
    initialData: {},
    steps: [],
    sources: createDefaultSourceSet(),
    gasSystem: createDefaultGasLines(),
    qualityChecks: [],
    safety: createDefaultSafety(),
    traceability: { version: 1, createdAt: now, updatedAt: now, source: 'blank' },
  };
}

// ---------- Presets (item 4): structure ONLY - no unconfirmed technological parameters ----------

export interface ProcessPreset { id: string; label: string; description: string; stepTypes: StepType[] }

export const PROCESS_PRESETS: ProcessPreset[] = [
  { id: 'magnetron-pvd', label: 'Magnetron PVD coating', description: 'Типовая структура процесса магнетронного PVD-покрытия.', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'main_coating', 'cooling', 'unloading', 'quality_control'] },
  { id: 'vacuum-arc-fcva', label: 'Vacuum Arc / FCVA coating', description: 'Типовая структура процесса вакуумно-дугового (FCVA) осаждения.', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'main_coating', 'cooling', 'unloading', 'quality_control'] },
  { id: 'hybrid-magnetron-arc', label: 'Hybrid Magnetron + Arc', description: 'Типовая структура гибридного процесса (магнетрон + дуга), многослойное покрытие.', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'cooling', 'unloading', 'quality_control'] },
  { id: 'pecvd', label: 'PECVD', description: 'Типовая структура процесса плазмохимического осаждения (PECVD).', stepTypes: ['loading', 'pumpdown', 'heating', 'surface_preparation', 'reactive_deposition', 'cooling', 'unloading', 'quality_control'] },
  { id: 'icp-rie-etching', label: 'ICP/RIE etching', description: 'Типовая структура процесса плазменного травления ICP/RIE.', stepTypes: ['loading', 'pumpdown', 'surface_preparation', 'etching', 'unloading', 'quality_control'] },
  { id: 'plasma-cleaning', label: 'Plasma cleaning', description: 'Типовая структура процесса плазменной очистки.', stepTypes: ['loading', 'pumpdown', 'plasma_ion_cleaning', 'unloading', 'quality_control'] },
];

/** Builds ONLY the stage skeleton (order, type, name) from a preset - every parameter field
 *  stays `undefined` ("не задано"). The user must confirm every real technological value. */
export function createDocumentFromPreset(presetId: string): TechnicalProcessDocument {
  const preset = PROCESS_PRESETS.find(p => p.id === presetId);
  if (!preset) throw new Error(`Пресет не найден: ${presetId}`);
  const now = new Date().toISOString();
  const steps = renumber(preset.stepTypes.map(type => ({ ...createStep(type, undefined, 'preset'), order: 0 })));
  return {
    schemaVersion: TECHDOC_SCHEMA_VERSION,
    pressureUnit: DEFAULT_PRESSURE_UNIT,
    general: { processName: '' },
    initialData: {},
    steps,
    sources: createDefaultSourceSet(),
    gasSystem: createDefaultGasLines(),
    qualityChecks: [],
    safety: createDefaultSafety(),
    traceability: { version: 1, createdAt: now, updatedAt: now, source: presetId },
  };
}

// ---------- validation (item 7): only objectively invalid values, never invented limits ----------

export function validateDocument(doc: TechnicalProcessDocument): void {
  if (!isPressureUnit(doc.pressureUnit)) throw new Error('Единица давления: допустимо Па или мбар.');
  if (!doc.general.processName || !doc.general.processName.trim()) {
    throw new Error('Название процесса: обязательное поле, введите значение.');
  }

  const seenOrders = new Set<number>();
  for (const step of doc.steps) {
    if (seenOrders.has(step.order)) throw new Error(`Дублирующийся номер этапа: №${step.order}. Номера этапов должны быть уникальными.`);
    seenOrders.add(step.order);

    checkOptionalNonNegative(step.durationMin, `Этап №${step.order}: длительность`);
    checkOptionalAboveAbsoluteZero(step.temperatureC, `Этап №${step.order}: температура`);
    checkOptionalNonNegative(step.pressurePa, `Этап №${step.order}: давление`);
    checkOptionalNonNegative(step.powerW, `Этап №${step.order}: мощность`);
    checkOptionalNonNegative(step.currentA, `Этап №${step.order}: ток`);
    checkOptionalFinite(step.substrateBiasV, `Этап №${step.order}: substrate bias`); // bias is routinely negative in PVD - finite only, never non-negative
    // F08: rotation speed and target-to-substrate distance are magnitudes - the model has no
    // "negative RPM"/"negative distance" convention anywhere, so a negative value here is not
    // "unusual but possible" (unlike e.g. a high temperature, which is never capped), it is a
    // mathematically/physically impossible reading. Was previously checked only for finiteness.
    checkOptionalNonNegative(step.rotationRpm, `Этап №${step.order}: вращение`);
    checkOptionalNonNegative(step.distanceMm, `Этап №${step.order}: расстояние`);
    for (const usage of step.gasUsage) checkOptionalNonNegative(usage.flowSccm, `Этап №${step.order}: расход газа (${usage.gas || 'без названия'})`);
  }

  for (const line of doc.gasSystem) checkOptionalNonNegative(line.flow, `Газовая линия ${line.gas || line.id}: расход`);

  doc.sources.magnetrons.forEach((magnetron, index) => checkOptionalNonNegative(magnetron.powerW, `Магнетрон ${magnetron.id || `#${index + 1}`}: мощность`));
  doc.sources.arcSources.forEach((arc, index) => checkOptionalNonNegative(arc.arcCurrentA, `Arc-источник ${arc.id || `#${index + 1}`}: ток дуги`));
  checkOptionalNonNegative(doc.sources.icpRf.powerW, 'ICP/RF: мощность');
  checkOptionalFinite(doc.sources.icpRf.biasV, 'ICP/RF: bias');
  checkOptionalFinite(doc.sources.ionSource.voltageV, 'Ion source: напряжение');
  checkOptionalNonNegative(doc.sources.ionSource.currentA, 'Ion source: ток');
  checkOptionalNonNegative(doc.sources.ionSource.powerW, 'Ion source: мощность');

  checkOptionalNonNegative(doc.initialData.partSizeMm, 'Размер изделия');
  checkOptionalNonNegative(doc.initialData.quantity, 'Количество');
  checkOptionalNonNegative(doc.initialData.requiredThicknessUm, 'Требуемая толщина');
  checkOptionalAboveAbsoluteZero(doc.initialData.allowedTemperatureC, 'Допустимая температура');

  validateAssignments(doc);
}

// ---------- formatting helper: never invent a value, always show "не задано" / "—" ----------

const NOT_SET = 'не задано';
const DASH = '—';

function fmtNum(value: number | undefined, unit: string, dash = false): string {
  if (value === undefined) return dash ? DASH : NOT_SET;
  return `${value}${unit}`;
}
/** A stored pressure (Pa) shown in the document's display unit, e.g. "0.5 Па" / "0.005 мбар".
 *  `0` is shown as "0 Па" (a value), `undefined` as "не задано"/"—" (no value). */
export function formatPressure(pa: number | undefined, unit: PressureUnit, dash = false): string {
  const shown = paToDisplayText(pa, unit);
  return shown === undefined ? (dash ? DASH : NOT_SET) : `${shown} ${PRESSURE_UNIT_LABELS[unit]}`;
}

function fmtStr(value: string | undefined, dash = false): string {
  if (value === undefined || value === '') return dash ? DASH : NOT_SET;
  return value;
}
/** The step's own free-text gas list (`gasUsage`, kept from earlier versions). Flow is in sccm - the
 *  unit the field has always held (it was mislabelled "см³/мин", which is not the same unit). */
function fmtGases(usage: GasUsage[]): string {
  if (usage.length === 0) return DASH;
  return usage.map(u => `${u.gas || NOT_SET}${u.flowSccm !== undefined ? ` (${u.flowSccm} sccm)` : ''}`).join(', ');
}
function legacySourcePower(step: ProcessStep): string {
  const parts: string[] = [];
  if (step.sourceConfiguration) parts.push(step.sourceConfiguration);
  if (step.powerW !== undefined) parts.push(`${step.powerW} Вт`);
  if (step.currentA !== undefined) parts.push(`${step.currentA} А`);
  return parts.length > 0 ? parts.join(', ') : DASH;
}
/** Table-cell form: the step's general values AND every structured assignment, so a card or table
 *  never shows fewer sources/gases than the editor holds. */
function fmtSourcePower(doc: TechnicalProcessDocument, step: ProcessStep): string {
  const general = legacySourcePower(step);
  const assigned = step.sourceAssignments.map(a => formatSourceAssignment(doc, a));
  const all = [...(general === DASH ? [] : [general]), ...assigned];
  return all.length > 0 ? all.join('; ') : DASH;
}
function fmtStepGases(doc: TechnicalProcessDocument, step: ProcessStep): string {
  const general = fmtGases(step.gasUsage);
  const assigned = step.gasAssignments.map(a => formatGasAssignment(doc, a));
  const all = [...(general === DASH ? [] : [general]), ...assigned];
  return all.length > 0 ? all.join('; ') : DASH;
}

// ---------- document views (item 8): all built from the SAME data, no duplication ----------

export function buildInstructionView(doc: TechnicalProcessDocument): string {
  const g = doc.general;
  const lines: string[] = [];
  lines.push(`# Технологическая инструкция: ${fmtStr(g.processName)}`);
  lines.push('');
  lines.push('## A. Общие сведения');
  lines.push(`- Назначение: ${fmtStr(g.purpose)}`);
  lines.push(`- Оборудование: ${fmtStr(g.equipment)}`);
  lines.push(`- Установка/модель: ${fmtStr(g.installationModel)}`);
  lines.push(`- Материал подложки: ${fmtStr(g.substrateMaterial)}`);
  lines.push(`- Тип изделия: ${fmtStr(g.productType)}`);
  lines.push(`- Материал покрытия/обработки: ${fmtStr(g.coatingMaterial)}`);
  lines.push(`- Ответственный/подразделение: ${fmtStr(g.responsible)}`);
  lines.push(`- Версия документа: ${fmtStr(g.documentVersion)}`);
  lines.push(`- Дата: ${fmtStr(g.date)}`);
  lines.push('');
  lines.push('## B. Исходные данные');
  const d = doc.initialData;
  lines.push(`- Размер изделия: ${fmtNum(d.partSizeMm, ' мм')}`);
  lines.push(`- Количество: ${fmtNum(d.quantity, '')}`);
  lines.push(`- Исходное состояние поверхности: ${fmtStr(d.initialSurfaceCondition)}`);
  lines.push(`- Требования к чистоте: ${fmtStr(d.cleanlinessRequirement)}`);
  lines.push(`- Требования к покрытию/обработке: ${fmtStr(d.coatingRequirement)}`);
  lines.push(`- Требуемая толщина: ${fmtNum(d.requiredThicknessUm, ' мкм')}`);
  lines.push(`- Допустимая температура: ${fmtNum(d.allowedTemperatureC, '°C')}`);
  lines.push(`- Дополнительные требования: ${fmtStr(d.additionalRequirements)}`);
  lines.push('');
  lines.push('## C. Последовательность технологических операций');
  for (const step of doc.steps) {
    if (!step.enabled) { lines.push(`### ${step.order}. ${step.name} (отключён)`); continue; }
    lines.push(`### ${step.order}. ${step.name} [${STEP_TYPE_LABELS[step.type]}]`);
    if (step.description) lines.push(step.description);
    lines.push(`- Длительность: ${fmtNum(step.durationMin, ' мин')}`);
    lines.push(`- Температура: ${fmtNum(step.temperatureC, '°C')}`);
    lines.push(`- Давление: ${formatPressure(step.pressurePa, doc.pressureUnit)}`);
    const extra = buildStepAssignmentLines(doc, step);
    const generalGases = fmtGases(step.gasUsage);
    const generalSources = legacySourcePower(step);
    lines.push(`- Газы: ${generalGases === DASH && extra.gases.length > 0 ? 'см. «Газовые линии на этапе» ниже' : generalGases}`);
    lines.push(`- Источник/мощность: ${generalSources === DASH && extra.sources.length > 0 ? 'см. «Источники на этапе» ниже' : generalSources}`);
    lines.push(`- Substrate bias: ${fmtNum(step.substrateBiasV, ' В')}`);
    lines.push(`- Вращение: ${fmtNum(step.rotationRpm, ' об/мин')}`);
    lines.push(`- Расстояние: ${fmtNum(step.distanceMm, ' мм')}`);
    lines.push(`- Критерий приёмки: ${fmtStr(step.acceptanceCriteria)}`);
    if (extra.sources.length > 0) { lines.push('- Источники на этапе (из раздела D):'); for (const text of extra.sources) lines.push(`  - ${text}`); }
    if (extra.gases.length > 0) { lines.push('- Газовые линии на этапе (из раздела E):'); for (const text of extra.gases) lines.push(`  - ${text}`); }
    for (const note of extra.notes) lines.push(`- ${note}`);
    if (extra.warnings.length > 0) { lines.push('- Замечания к данным этапа:'); for (const text of extra.warnings) lines.push(`  - ${text}`); }
    if (step.notes) lines.push(`- Примечание: ${step.notes}`);
  }
  lines.push('');
  lines.push('## D. Источники (справочник оборудования; включение и параметры на этапах - в разделе C)');
  const src = doc.sources;
  if (src.magnetrons.length === 0) lines.push(`- Магнетроны: ${NOT_SET}`);
  for (const m of src.magnetrons) lines.push(`- Магнетрон ${m.id} (в установке: ${m.enabled ? 'доступен' : 'отключён'}): материал — ${fmtStr(m.material)}, мощность — ${fmtNum(m.powerW, ' Вт')}, режим — ${fmtStr(m.mode)}`);
  if (src.arcSources.length === 0) lines.push(`- Arc-источники: ${NOT_SET}`);
  for (const a of src.arcSources) lines.push(`- Arc-источник ${a.id} (в установке: ${a.enabled ? 'доступен' : 'отключён'}${a.filtered ? ', фильтрованный' : ''}): материал катода — ${fmtStr(a.cathodeMaterial)}, ток дуги — ${fmtNum(a.arcCurrentA, ' А')}`);
  lines.push(`- ICP/RF: ${src.icpRf.enabled ? `включён, мощность — ${fmtNum(src.icpRf.powerW, ' Вт')}, bias — ${fmtNum(src.icpRf.biasV, ' В')}` : 'не используется'}`);
  lines.push(`- Ion source: ${src.ionSource.enabled ? `включён, напряжение — ${fmtNum(src.ionSource.voltageV, ' В')}, ток — ${fmtNum(src.ionSource.currentA, ' А')}, мощность — ${fmtNum(src.ionSource.powerW, ' Вт')}` : 'не используется'}`);
  lines.push('');
  lines.push('## E. Газовая система (справочник линий; подача на этапах - в разделе C)');
  if (doc.gasSystem.length === 0) lines.push(NOT_SET);
  for (const line of doc.gasSystem) lines.push(`- Линия ${line.id} (в системе: ${line.enabled ? 'включена' : 'отключена'}): газ — ${fmtStr(line.gas)}, расход (справочно) — ${fmtNum(line.flow, ` ${line.unit}`)}`);
  lines.push('');
  lines.push('## F. Контроль качества');
  if (doc.qualityChecks.length === 0) lines.push(NOT_SET);
  for (const qc of doc.qualityChecks) {
    // F17: unit must appear here exactly as it does in the export QC table
    // (document-export.ts's buildQualityChecks) - never invented when qc.unit is unset, only
    // ever shown when the user actually entered one, and attached to criterion/result (both
    // of which are the numeric-looking fields a unit actually qualifies).
    const unit = qc.unit?.trim() ? ` ${qc.unit.trim()}` : '';
    const criterion = qc.criterion?.trim() ? `${qc.criterion.trim()}${unit}` : fmtStr(qc.criterion);
    const result = qc.result?.trim() ? `${qc.result.trim()}${unit}` : fmtStr(qc.result);
    lines.push(`- ${qc.parameter}: метод — ${fmtStr(qc.method)}, критерий — ${criterion}, результат — ${result}, статус — ${fmtStr(qc.status)}`);
  }
  lines.push('');
  lines.push('## G. Требования безопасности');
  lines.push(`- Опасности: ${doc.safety.hazards.length ? doc.safety.hazards.join(', ') : NOT_SET}`);
  lines.push(`- СИЗ: ${doc.safety.ppe.length ? doc.safety.ppe.join(', ') : NOT_SET}`);
  lines.push(`- Блокировки: ${doc.safety.interlocks.length ? doc.safety.interlocks.join(', ') : NOT_SET}`);
  lines.push(`- Газовая безопасность: ${fmtStr(doc.safety.gasSafety)}`);
  lines.push(`- Вакуумная безопасность: ${fmtStr(doc.safety.vacuumSafety)}`);
  lines.push(`- Высокое напряжение: ${fmtStr(doc.safety.highVoltage)}`);
  lines.push(`- Горячие поверхности: ${fmtStr(doc.safety.hotSurfaces)}`);
  if (doc.safety.notes) lines.push(`- Примечания: ${doc.safety.notes}`);
  return lines.join('\n');
}

export interface TechCardRow {
  number: number; operation: string; duration: string; temperature: string; pressure: string;
  gases: string; sourcePower: string; bias: string; control: string; note: string;
}

/** `compactLongLists` (used for DOCX/PDF): a step with a long source/gas list shows only the COUNT in its
 *  card row and points at the table that lists every assignment (see cardDetailHeading) - an explicit
 *  reference, never a silently shortened cell. Without it (on-screen preview, markdown) every cell holds
 *  the complete text. */
export function buildTechnologicalCard(doc: TechnicalProcessDocument, options: { compactLongLists?: boolean } = {}): TechCardRow[] {
  const compact = options.compactLongLists === true;
  const sourceCell = (step: ProcessStep) => {
    if (!(compact && hasLongSourceList(doc, step))) return fmtSourcePower(doc, step);
    const general = legacySourcePower(step);
    const on = step.sourceAssignments.filter(a => a.enabled).length;
    return [...(general === DASH ? [] : [general]), `назначено источников: ${step.sourceAssignments.length} (включено ${on}) - полный перечень в таблице «${cardDetailHeading(step, 'sources')}» ниже`].join('; ');
  };
  const gasCell = (step: ProcessStep) => {
    if (!(compact && hasLongGasList(doc, step))) return fmtStepGases(doc, step);
    const general = fmtGases(step.gasUsage);
    const on = step.gasAssignments.filter(a => a.enabled).length;
    return [...(general === DASH ? [] : [general]), `назначено газовых линий: ${step.gasAssignments.length} (включено ${on}) - полный перечень в таблице «${cardDetailHeading(step, 'gases')}» ниже`].join('; ');
  };
  return doc.steps.map(step => ({
    number: step.order,
    operation: step.enabled ? step.name : `${step.name} (отключён)`,
    duration: fmtNum(step.durationMin, ' мин', true),
    temperature: fmtNum(step.temperatureC, '°C', true),
    pressure: formatPressure(step.pressurePa, doc.pressureUnit, true),
    gases: gasCell(step),
    sourcePower: sourceCell(step),
    bias: fmtNum(step.substrateBiasV, ' В', true),
    control: fmtStr(step.acceptanceCriteria, true),
    note: fmtStr(step.notes, true),
  }));
}

export interface RouteCardRow {
  number: number; stage: string; equipment: string; input: string; operation: string; output: string; control: string; note: string;
}

/** A disabled step is skipped in the real process, so it must never be shown as the thing
 *  handing input to (or receiving output from) its neighbors - input/output always reference
 *  the nearest ENABLED step, not just the adjacent array index (Codex regression: previously a
 *  disabled step still appeared as a legitimate hand-off point in the chain). */
export function buildRouteCard(doc: TechnicalProcessDocument): RouteCardRow[] {
  const equipment = fmtStr(doc.general.equipment, true);
  const steps = doc.steps;
  function nearestEnabledBefore(index: number): string {
    for (let i = index - 1; i >= 0; i--) if (steps[i].enabled) return `результат операции №${steps[i].order}`;
    return 'Исходное изделие';
  }
  function nearestEnabledAfter(index: number): string {
    for (let i = index + 1; i < steps.length; i++) if (steps[i].enabled) return `на операцию №${steps[i].order}`;
    return 'Готовое изделие';
  }
  return steps.map((step, index) => ({
    number: step.order,
    stage: STEP_TYPE_LABELS[step.type],
    equipment,
    input: nearestEnabledBefore(index),
    operation: step.enabled ? step.name : `${step.name} (отключён)`,
    output: nearestEnabledAfter(index),
    control: step.type === 'quality_control' ? 'см. раздел «Контроль качества»' : fmtStr(step.acceptanceCriteria, true),
    note: fmtStr(step.notes, true),
  }));
}

export function buildBriefRecipe(doc: TechnicalProcessDocument): string {
  const lines: string[] = [`# Краткий рецепт: ${fmtStr(doc.general.processName)}`];
  const assigned = (step: ProcessStep) => step.sourceAssignments.length > 0 || step.gasAssignments.length > 0;
  // The recipe shows only temperature, pressure, time and power. When steps also carry source/gas
  // assignments it says so, instead of looking complete.
  if (doc.steps.some(step => step.enabled && assigned(step))) {
    lines.push('Сокращённое представление: температура, давление, время и мощность этапа. Назначения источников и газовых линий указаны только числом - полные данные в технологической инструкции.');
  }
  for (const step of doc.steps) {
    if (!step.enabled) continue;
    const parts = [
      step.temperatureC !== undefined ? `T: ${step.temperatureC}°C` : null,
      step.pressurePa !== undefined ? `P: ${formatPressure(step.pressurePa, doc.pressureUnit)}` : null,
      step.durationMin !== undefined ? `t: ${step.durationMin} мин` : null,
      step.powerW !== undefined ? `W: ${step.powerW} Вт` : null,
    ].filter(Boolean);
    const onSources = step.sourceAssignments.filter(a => a.enabled).length;
    const onGases = step.gasAssignments.filter(a => a.enabled).length;
    const marker = assigned(step)
      ? ` [назначено: источников ${step.sourceAssignments.length} (включено ${onSources}), газовых линий ${step.gasAssignments.length} (включено ${onGases}) - см. инструкцию]`
      : '';
    lines.push(`${step.order}. ${step.name} — ${parts.length ? parts.join(', ') : NOT_SET}${marker}`);
  }
  return lines.join('\n');
}

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n');
  return [header, divider, body].join('\n');
}

// ---------- export architecture (item 17): structured JSON + markdown views ----------

export interface TechDocExport {
  json: TechnicalProcessDocument;
  markdown: { instruction: string; technologicalCard: string; routeCard: string; briefRecipe: string };
}

export function buildExport(doc: TechnicalProcessDocument): TechDocExport {
  const techCard = buildTechnologicalCard(doc);
  const routeCard = buildRouteCard(doc);
  return {
    json: doc,
    markdown: {
      instruction: buildInstructionView(doc),
      technologicalCard: toMarkdownTable(
        ['№', 'Операция', 'Время', 'Температура', 'Давление', 'Газы', 'Источник/мощность', 'Bias', 'Контроль', 'Примечание'],
        techCard.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sourcePower, r.bias, r.control, r.note]),
      ),
      routeCard: toMarkdownTable(
        ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход', 'Контроль', 'Примечание'],
        routeCard.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output, r.control, r.note]),
      ),
      briefRecipe: buildBriefRecipe(doc),
    },
  };
}
