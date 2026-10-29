/** Real, local, dependency-free technological-documentation builder for PVD/CVD/PECVD/plasma
 *  processes - no external API, no LLM. This module never invents a technological parameter:
 *  every numeric/text field the user has not entered is rendered as "не задано" (or left
 *  `undefined` in the data model) rather than guessed, defaulted, or "corrected". Presets only
 *  create a stage SKELETON (step names/types/order) - they never pre-fill a pressure,
 *  temperature, power, gas, or thickness. No silent parameter substitution, ever.
 *
 *  Schema 4: a process is a list of cards of eight types (see STEP_TYPE_SPECS). Sources and gas lines
 *  are created and configured INSIDE the card - or, for the coating card, inside each coating layer -
 *  that uses them; there is no equipment registry. */

import { solveDeposition, type ThicknessUnit, type RateUnit } from './engineering-calculators';
import { parseTechnicalProcessDocumentDetailed } from './techdoc-parse';
import { MAX_LONG_TEXT } from './techdoc-parse-utils';
import type { MigrationReport } from './techdoc-migrate';
import { createStep, createLayer, placeFields, placeLayerFields, type ProcessStep, type CoatingLayer, type StepPatch } from './techdoc-steps';
export { createStep, createLayer, type ProcessStep, type CoatingLayer, type StepOrigin, type StepPatch } from './techdoc-steps';
import {
  estimateLines, columnWidthPt, CARD_COLUMN_WEIGHTS, CARD_SOURCE_COLUMN, CARD_GAS_COLUMN, CARD_CELL_LINE_BUDGET, TYPICAL_CHAR_PT,
  LAYER_TABLE_WEIGHTS, LAYER_SOURCE_COLUMN, LAYER_GAS_COLUMN,
} from './techdoc-card-layout';
import {
  TECHDOC_SCHEMA_VERSION, DEFAULT_PRESSURE_UNIT, PRESSURE_UNIT_LABELS, isPressureUnit, paToDisplayText, UnsupportedSchemaVersionError,
  SOURCE_KINDS, SOURCE_KIND_LABELS, SOURCE_ID_PREFIX, SOURCE_KIND_FIELDS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING,
  STEP_TYPES, STEP_TYPE_LABELS, STEP_TYPE_SPECS, STEP_FIELD_META, LAYER_FIELDS, LAYER_OPTIONAL_FIELDS, COATING_MODES, COATING_MODE_LABELS, nextId, createEmptyLegacy,
  type PressureUnit, type SourceKind, type StepSource, type StepGas, type StepType, type StepFieldKey, type CoatingMode, type LegacyData, type LegacyField, type LegacyValue,
} from './techdoc-schema';

export {
  TECHDOC_SCHEMA_VERSION, PRESSURE_UNITS, PRESSURE_UNIT_LABELS, PA_PER_MBAR, pressureToPa, paToDisplayText, paToDisplayInputValue, parsePressureInput, parsePressureText,
  SOURCE_KINDS, SOURCE_KIND_LABELS, SOURCE_KIND_FIELDS, ASSIGNMENT_MODES, ASSIGNMENT_MODE_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING,
  STEP_TYPES, STEP_TYPE_LABELS, STEP_TYPE_SPECS, STEP_FIELD_META, LAYER_FIELDS, LAYER_OPTIONAL_FIELDS, COATING_MODES, COATING_MODE_LABELS, hasLegacyData,
  type PressureUnit, type SourceKind, type AssignmentMode, type StepSource, type StepGas, type StepType, type StepFieldKey, type CoatingMode, type LegacyData,
} from './techdoc-schema';

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

/** The one universally-safe physical floor for a Celsius temperature - nothing is colder than absolute
 *  zero, regardless of process type. Unlike an invented technological ceiling (deliberately never added),
 *  this is a physical law. The boundary itself (-273.15 °C) is accepted. */
const ABSOLUTE_ZERO_C = -273.15;

function checkOptionalAboveAbsoluteZero(value: number | undefined, label: string): void {
  if (value === undefined) return;
  assertFinite(value, label);
  if (value < ABSOLUTE_ZERO_C) throw new Error(`${label}: значение не может быть ниже абсолютного нуля (${ABSOLUTE_ZERO_C} °C).`);
}

function checkOptionalNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined) assertNonNegative(value, label);
}

function renumber(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

const cloneSource = (s: StepSource): StepSource => ({ ...s });
const cloneGas = (g: StepGas): StepGas => ({ ...g });
const cloneLayer = (l: CoatingLayer): CoatingLayer => ({ ...l, sources: l.sources.map(cloneSource), gases: l.gases.map(cloneGas), calculatedFields: [...l.calculatedFields] });

// ---------- Recipe Builder: pure, immutable operations on a step list ----------

export function addStep(steps: ProcessStep[], type: StepType, name?: string): ProcessStep[] {
  return renumber([...steps, { ...createStep(type, name, 'user', nextId('step', steps)), order: steps.length + 1 }]);
}

export function removeStep(steps: ProcessStep[], order: number): ProcessStep[] {
  return renumber(steps.filter(step => step.order !== order));
}

export function duplicateStep(steps: ProcessStep[], order: number): ProcessStep[] {
  const index = steps.findIndex(step => step.order === order);
  if (index === -1) throw new Error(`Этап №${order} не найден.`);
  // Duplicating is itself an explicit user action: the copy is origin 'user' even when the original came from a preset.
  // `calculatedFields` is carried over unchanged (it is a fact about the VALUE, which copying does not change); updateStep
  // clears the stamp the moment the user edits that field on the copy. The copy owns its own sources, gas lines and layers.
  const original = steps[index];
  const copy: ProcessStep = {
    ...original, id: nextId('step', steps),
    sources: original.sources.map(cloneSource), gases: original.gases.map(cloneGas), layers: original.layers.map(cloneLayer),
    origin: 'user', calculatedFields: [...original.calculatedFields],
  };
  return renumber([...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)]);
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

/** Manually editing a field that is stamped as system-calculated clears that stamp for exactly that field:
 *  the value on screen is now the user's own, and provenance must say what produced the CURRENT value. */
export function updateStep(steps: ProcessStep[], order: number, patch: StepPatch): ProcessStep[] {
  if (!steps.some(step => step.order === order)) throw new Error(`Этап №${order} не найден.`);
  const editedFields = Object.keys(patch);
  return steps.map(step => step.order === order
    ? { ...step, ...patch, origin: 'user' as const, calculatedFields: step.calculatedFields.filter(f => !editedFields.includes(f)) }
    : step);
}

/** Explicit-action-only calculation: reuses Engineering Calculators' deposition formula to fill a card's duration
 *  from a user-confirmed thickness and rate (only the adhesion-underlayer card offers it). Stamps `calculatedFields`. */
export function calculateStepDurationFromDeposition(
  steps: ProcessStep[], order: number,
  thickness: number, thicknessUnit: ThicknessUnit, rate: number, rateUnit: RateUnit,
): ProcessStep[] {
  const result = solveDeposition({ solveFor: 'time', thickness, thicknessUnit, rate, rateUnit, timeUnit: 'min' });
  return steps.map(step => step.order === order
    ? { ...step, durationMin: result.value, calculatedFields: Array.from(new Set([...step.calculatedFields, 'durationMin'])) }
    : step);
}

// ---------- sources and gas lines inside a card or a coating layer ----------

/** Where sources and gas lines live: the card itself, or one of its coating layers. */
export interface UnitRef { order: number; layerId?: string }

interface UnitData { sources: StepSource[]; gases: StepGas[] }

function mapUnit(steps: ProcessStep[], ref: UnitRef, update: (unit: UnitData) => UnitData): ProcessStep[] {
  const step = steps.find(s => s.order === ref.order);
  if (!step) throw new Error(`Этап №${ref.order} не найден.`);
  const spec = STEP_TYPE_SPECS[step.type];
  if (ref.layerId === undefined) {
    if (!spec.sources && !spec.gases) throw new Error(`Этап №${ref.order} («${STEP_TYPE_LABELS[step.type]}»): в этой карточке нет источников и газовых линий.`);
    return steps.map(s => s.order === ref.order ? { ...s, ...update({ sources: s.sources, gases: s.gases }), origin: 'user' as const } : s);
  }
  if (!spec.layers) throw new Error(`Этап №${ref.order}: в этой карточке нет слоёв.`);
  if (!step.layers.some(l => l.id === ref.layerId)) throw new Error(`Этап №${ref.order}: слой ${ref.layerId} не найден.`);
  return steps.map(s => s.order === ref.order
    ? { ...s, layers: s.layers.map(l => l.id === ref.layerId ? { ...l, ...update({ sources: l.sources, gases: l.gases }) } : l), origin: 'user' as const }
    : s);
}

/** Adds a source of `kind` - ON, parallel, with NO values filled in. The card must have sources (or be a coating card with the layer). */
export function addSource(steps: ProcessStep[], ref: UnitRef, kind: SourceKind): ProcessStep[] {
  const step = steps.find(s => s.order === ref.order);
  if (step && ref.layerId === undefined && !STEP_TYPE_SPECS[step.type].sources) throw new Error(`Этап №${ref.order} («${STEP_TYPE_LABELS[step.type]}»): в этой карточке нет источников.`);
  return mapUnit(steps, ref, unit => ({ ...unit, sources: [...unit.sources, { id: nextId(SOURCE_ID_PREFIX[kind], unit.sources), kind, enabled: true, mode: 'parallel' }] }));
}
/** Values that do not belong to the kind of the source are never stored. */
export function updateSource(steps: ProcessStep[], ref: UnitRef, id: string, patch: Partial<Omit<StepSource, 'id' | 'kind'>>): ProcessStep[] {
  return mapUnit(steps, ref, unit => ({
    ...unit,
    sources: unit.sources.map(s => {
      if (s.id !== id) return s;
      const allowed = new Set<string>(['enabled', 'startMin', 'durationMin', 'mode', ...SOURCE_KIND_FIELDS[s.kind]]);
      const kept = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
      return { ...s, ...kept };
    }),
  }));
}
export function removeSource(steps: ProcessStep[], ref: UnitRef, id: string): ProcessStep[] {
  return mapUnit(steps, ref, unit => ({ ...unit, sources: unit.sources.filter(s => s.id !== id) }));
}

export function addGas(steps: ProcessStep[], ref: UnitRef): ProcessStep[] {
  const step = steps.find(s => s.order === ref.order);
  if (step && ref.layerId === undefined && !STEP_TYPE_SPECS[step.type].gases) throw new Error(`Этап №${ref.order} («${STEP_TYPE_LABELS[step.type]}»): в этой карточке нет газовых линий.`);
  return mapUnit(steps, ref, unit => ({ ...unit, gases: [...unit.gases, { id: nextId('gas', unit.gases), enabled: true, gas: '' }] }));
}
export function updateGas(steps: ProcessStep[], ref: UnitRef, id: string, patch: Partial<Omit<StepGas, 'id'>>): ProcessStep[] {
  return mapUnit(steps, ref, unit => ({ ...unit, gases: unit.gases.map(g => g.id === id ? { ...g, ...patch } : g) }));
}
export function removeGas(steps: ProcessStep[], ref: UnitRef, id: string): ProcessStep[] {
  return mapUnit(steps, ref, unit => ({ ...unit, gases: unit.gases.filter(g => g.id !== id) }));
}

// ---------- coating layers ----------

function mapCoatingStep(steps: ProcessStep[], order: number, update: (step: ProcessStep) => ProcessStep): ProcessStep[] {
  const step = steps.find(s => s.order === order);
  if (!step) throw new Error(`Этап №${order} не найден.`);
  if (!STEP_TYPE_SPECS[step.type].layers) throw new Error(`Этап №${order} («${STEP_TYPE_LABELS[step.type]}»): в этой карточке нет слоёв.`);
  return steps.map(s => s.order === order ? { ...update(s), origin: 'user' as const } : s);
}

/** Adds an empty layer. In single-layer mode a second layer is refused. */
export function addLayer(steps: ProcessStep[], order: number): ProcessStep[] {
  return mapCoatingStep(steps, order, step => {
    if (step.coatingMode === 'single' && step.layers.length >= 1) throw new Error(`Этап №${order}: в однослойном режиме может быть только один слой. Переключите режим на многослойный.`);
    return { ...step, layers: [...step.layers, createLayer(nextId('layer', step.layers))] };
  });
}
export function updateLayer(steps: ProcessStep[], order: number, layerId: string, patch: Partial<Omit<CoatingLayer, 'id' | 'sources' | 'gases'>>): ProcessStep[] {
  return mapCoatingStep(steps, order, step => {
    if (!step.layers.some(l => l.id === layerId)) throw new Error(`Этап №${order}: слой ${layerId} не найден.`);
    // a value typed by hand is no longer the calculator's: its stamp is cleared for exactly the edited fields
    const edited = Object.keys(patch);
    return { ...step, layers: step.layers.map(l => l.id === layerId ? { ...l, ...patch, calculatedFields: l.calculatedFields.filter(f => !edited.includes(f)) } : l) };
  });
}
export function removeLayer(steps: ProcessStep[], order: number, layerId: string): ProcessStep[] {
  return mapCoatingStep(steps, order, step => ({ ...step, layers: step.layers.filter(l => l.id !== layerId) }));
}
export function moveLayer(steps: ProcessStep[], order: number, layerId: string, direction: 'up' | 'down'): ProcessStep[] {
  return mapCoatingStep(steps, order, step => {
    const index = step.layers.findIndex(l => l.id === layerId);
    if (index === -1) throw new Error(`Этап №${order}: слой ${layerId} не найден.`);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= step.layers.length) return step;
    const layers = [...step.layers];
    [layers[index], layers[target]] = [layers[target], layers[index]];
    return { ...step, layers };
  });
}
/** Single-layer mode keeps exactly one layer (an empty one is created when there is none). Switching to it while
 *  several layers exist is REFUSED - no layer is ever dropped silently; remove the extra layers first. */
export function setCoatingMode(steps: ProcessStep[], order: number, mode: CoatingMode): ProcessStep[] {
  return mapCoatingStep(steps, order, step => {
    if (mode === 'single' && step.layers.length > 1) throw new Error(`Этап №${order}: в карточке несколько слоёв (${step.layers.length}) - в однослойный режим переключить нельзя. Сначала удалите лишние слои.`);
    const layers = mode === 'single' && step.layers.length === 0 ? [createLayer('layer-1')] : step.layers;
    return { ...step, coatingMode: mode, layers };
  });
}

// ---------- units: where sources and gas lines are read from (a card, or each layer of a coating card) ----------

export interface StepUnit {
  /** "Этап №2" or "Этап №6, слой 2". */
  label: string;
  ref: UnitRef;
  /** 1-based number of the layer; undefined for a card without layers. */
  layerNumber?: number;
  durationMin: number | undefined;
  sources: StepSource[];
  gases: StepGas[];
}

/** The units of one card: the card itself, or one per coating layer. Cards without sources and gas lines still
 *  return their single unit (empty lists). */
export function stepUnits(step: ProcessStep): StepUnit[] {
  if (STEP_TYPE_SPECS[step.type].layers) {
    return step.layers.map((l, i) => ({
      label: `Этап №${step.order}, слой ${i + 1}`, ref: { order: step.order, layerId: l.id }, layerNumber: i + 1,
      durationMin: l.durationMin, sources: l.sources, gases: l.gases,
    }));
  }
  return [{ label: `Этап №${step.order}`, ref: { order: step.order }, durationMin: step.durationMin, sources: step.sources, gases: step.gases }];
}

const TIME_EPS = 1e-9;
const trimNumber = (value: number) => Number(value.toPrecision(12)); // display of a derived sum only (0.1 + 0.2)

/** "0–30 мин" when start and duration are both known; otherwise says exactly what is missing.
 *  A duration of 0 is a VALUE (the source/line does not run: an empty interval), clearly different
 *  from "not set". A sum that is not a finite number is reported as such - "Infinity" is never printed. */
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

const MATERIAL_NOT_SET = 'материал не задан';
const sourceMaterial = (s: StepSource) => s.material?.trim() ? s.material : MATERIAL_NOT_SET;

/** What identifies a source apart from its kind and id: the target / cathode material (and "filtered"). Sources without a
 *  material (ICP/RF, ion) have none. */
function sourceDescriptor(s: StepSource): string | undefined {
  if (s.kind === 'magnetron') return `мишень: ${sourceMaterial(s)}`;
  if (s.kind === 'arc') return `катод: ${sourceMaterial(s)}${s.filtered ? ', фильтрованный' : ''}`;
  return undefined;
}

function sourceValues(s: StepSource): string[] {
  const num = (label: string, value: number | undefined, unit: string, unset: string) => `${label} — ${value !== undefined ? `${value} ${unit}` : unset}`;
  switch (s.kind) {
    case 'magnetron': return [num('мощность', s.powerW, 'Вт', 'не задана'), ...(s.operatingMode?.trim() ? [`режим питания — ${s.operatingMode}`] : [])];
    case 'arc': return [num('ток дуги', s.currentA, 'А', 'не задан')];
    case 'icp_rf': return [num('мощность', s.powerW, 'Вт', 'не задана'), num('смещение', s.biasV, 'В', 'не задано')];
    case 'ion': return [num('напряжение', s.voltageV, 'В', 'не задано'), num('ток', s.currentA, 'А', 'не задан'), num('мощность', s.powerW, 'Вт', 'не задана')];
  }
}

const sourceHead = (s: StepSource) => `${SOURCE_KIND_LABELS[s.kind]} ${s.id}`;
const gasName = (g: StepGas) => g.gas.trim() ? g.gas : 'газ не указан';

/** One source as a single line: which source and its material, ON/OFF, its values, the time window and the mode. OFF is
 *  stated as OFF; unset values are stated as unset - nothing is filled in. */
export function formatSource(s: StepSource): string {
  const descriptor = sourceDescriptor(s);
  const head = `${sourceHead(s)}${descriptor ? ` (${descriptor})` : ''}`;
  if (!s.enabled) return `${head}: ОТКЛ`;
  return `${head}: ВКЛ, ${sourceValues(s).join(', ')}, время — ${formatTimeWindow(s.startMin, s.durationMin)}, режим — ${ASSIGNMENT_MODE_LABELS[s.mode]}`;
}

export function formatGas(g: StepGas): string {
  const head = `Линия ${g.id} (газ: ${gasName(g)})`;
  if (!g.enabled) return `${head}: ОТКЛ`;
  return `${head}: ВКЛ, расход — ${g.flowSccm !== undefined ? `${g.flowSccm} sccm` : 'не задан'}, подача — ${formatTimeWindow(g.startMin, g.durationMin)}`;
}

/** One source split into table cells (the same facts, wording and OFF/unset rules as formatSource). */
export function sourceFields(s: StepSource): { source: string; material: string; state: string; value: string; time: string; mode: string } {
  const base = { source: sourceHead(s), material: s.kind === 'magnetron' || s.kind === 'arc' ? `${sourceMaterial(s)}${s.kind === 'arc' && s.filtered ? ', фильтрованный' : ''}` : '—' };
  if (!s.enabled) return { ...base, state: 'ОТКЛ', value: '—', time: '—', mode: '—' };
  return { ...base, state: 'ВКЛ', value: sourceValues(s).join('; '), time: formatTimeWindow(s.startMin, s.durationMin), mode: ASSIGNMENT_MODE_LABELS[s.mode] };
}

export function gasFields(g: StepGas): { line: string; gas: string; state: string; flow: string; time: string } {
  const base = { line: `Линия ${g.id}`, gas: gasName(g) };
  if (!g.enabled) return { ...base, state: 'ОТКЛ', flow: '—', time: '—' };
  return { ...base, state: 'ВКЛ', flow: g.flowSccm !== undefined ? `${g.flowSccm} sccm` : 'не задан', time: formatTimeWindow(g.startMin, g.durationMin) };
}

// ---------- validation of sources and gas lines ----------

/** Consistency of every unit's sources and gas lines with its own timing. Only objective contradictions throw: negative
 *  values or times, an interval outside the step/layer, an unknown kind or mode, a repeated id, a sequential source that
 *  overlaps another. Missing values are never errors here - an ON source with no power is "not set". */
function validateUnits(doc: TechnicalProcessDocument): void {
  for (const step of doc.steps) {
    for (const unit of stepUnits(step)) {
      const where = unit.label;
      const within = (label: string, start: number | undefined, duration: number | undefined) => {
        checkOptionalNonNegative(start, `${where}: ${label}: начало`);
        checkOptionalNonNegative(duration, `${where}: ${label}: длительность`);
        if (start !== undefined && duration !== undefined && !Number.isFinite(start + duration)) {
          throw new Error(`${where}: ${label}: начало + длительность не является конечным числом (слишком большие значения).`);
        }
      };
      const inside = (label: string, start: number | undefined, duration: number | undefined) => {
        if (unit.durationMin === undefined) return;
        const limit = unit.durationMin + TIME_EPS;
        if (start !== undefined && start > limit) throw new Error(`${where}: ${label}: начало (${start} мин) позже конца (${unit.durationMin} мин).`);
        if ((start ?? 0) + (duration ?? 0) > limit) throw new Error(`${where}: ${label}: интервал выходит за пределы (${formatTimeWindow(start, duration)}; длительность ${unit.durationMin} мин).`);
      };

      const seen = new Set<string>();
      for (const s of unit.sources) {
        const label = sourceHead(s);
        if (!(SOURCE_KINDS as readonly string[]).includes(s.kind)) throw new Error(`${where}: недопустимый тип источника «${s.kind}».`);
        if (!(ASSIGNMENT_MODES as readonly string[]).includes(s.mode)) throw new Error(`${where}: ${label}: недопустимый режим работы.`);
        if (seen.has(s.id)) throw new Error(`${where}: повторяется идентификатор источника «${s.id}». Идентификаторы должны быть уникальными.`);
        seen.add(s.id);
        checkOptionalNonNegative(s.powerW, `${where}: ${label}: мощность`);
        checkOptionalNonNegative(s.currentA, `${where}: ${label}: ток`);
        checkOptionalFinite(s.voltageV, `${where}: ${label}: напряжение`);
        checkOptionalFinite(s.biasV, `${where}: ${label}: смещение`);
        within(label, s.startMin, s.durationMin);
        if (s.enabled) inside(label, s.startMin, s.durationMin);
      }

      const running = unit.sources.filter(s => s.enabled);
      for (const a of running.filter(x => x.mode === 'sequential')) {
        const label = sourceHead(a);
        if (a.startMin === undefined || a.durationMin === undefined) throw new Error(`${where}: ${label}: для последовательного режима нужно задать начало и длительность работы.`);
        const aEnd = a.startMin + a.durationMin;
        if (a.durationMin === 0) continue; // an empty interval (0 min = no work) overlaps nothing
        for (const b of running) {
          if (b === a || b.startMin === undefined || b.durationMin === undefined || b.durationMin === 0) continue;
          const bEnd = b.startMin + b.durationMin;
          if (a.startMin < bEnd - TIME_EPS && b.startMin < aEnd - TIME_EPS) {
            throw new Error(`${where}: ${label} работает последовательно, но его интервал (${formatTimeWindow(a.startMin, a.durationMin)}) пересекается с интервалом ${sourceHead(b)} (${formatTimeWindow(b.startMin, b.durationMin)}).`);
          }
        }
      }

      const seenGas = new Set<string>();
      for (const g of unit.gases) {
        const label = `линия ${g.id}`;
        if (seenGas.has(g.id)) throw new Error(`${where}: повторяется идентификатор газовой линии «${g.id}». Идентификаторы должны быть уникальными.`);
        seenGas.add(g.id);
        checkOptionalNonNegative(g.flowSccm, `${where}: ${label}: расход`);
        within(label, g.startMin, g.durationMin);
        if (g.enabled) inside(label, g.startMin, g.durationMin);
      }
    }
  }
}

export interface StepWarning { order: number; text: string }

/** Non-blocking remarks per step: things that cannot be verified or that need the user's attention but are not
 *  contradictions (so an incomplete draft can still be saved and exported). The same list feeds the editor, the preview
 *  and the DOCX/PDF instruction - nothing is shown in one and hidden in another. */
export function collectStepWarningItems(doc: TechnicalProcessDocument): StepWarning[] {
  const warnings: StepWarning[] = [];
  for (const step of doc.steps) {
    const spec = STEP_TYPE_SPECS[step.type];
    if (spec.layers && step.layers.length === 0) warnings.push({ order: step.order, text: 'не задано ни одного слоя покрытия.' });
    for (const unit of stepUnits(step)) {
      const prefix = unit.layerNumber !== undefined ? `слой ${unit.layerNumber}: ` : '';
      const warn = (text: string) => warnings.push({ order: step.order, text: `${prefix}${text}` });
      const running = unit.sources.filter(s => s.enabled);
      for (const a of running.filter(x => x.mode === 'sequential')) {
        for (const b of running.filter(x => x !== a && (x.startMin === undefined || x.durationMin === undefined))) {
          warn(`у ${sourceHead(b)} не заданы начало и длительность - непересечение с последовательным ${sourceHead(a)} проверить нельзя.`);
        }
      }
      const timed = [...running, ...unit.gases.filter(g => g.enabled)].some(x => x.startMin !== undefined || x.durationMin !== undefined);
      if (timed && unit.durationMin === undefined) warn(`не задана длительность ${unit.layerNumber !== undefined ? 'слоя' : 'этапа'} - интервалы источников и газов нельзя сверить с границами.`);
      for (const s of running.filter(x => x.durationMin === 0)) warn(`${sourceHead(s)} включён, но его длительность 0 мин - фактически он не работает.`);
      for (const g of unit.gases.filter(x => x.enabled)) {
        if (g.durationMin === 0) warn(`линия ${g.id} включена, но длительность подачи 0 мин - газ фактически не подаётся.`);
        if (!g.gas.trim()) warn(`для линии ${g.id} не указан газ.`);
      }
    }
  }
  return warnings;
}

export function collectStepWarnings(doc: TechnicalProcessDocument): string[] {
  return collectStepWarningItems(doc).map(w => `Этап №${w.order}: ${w.text}`);
}

// ---------- Quality checks (section D) - categories only, no invented norms ----------

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

// ---------- Safety (section E) - fields only, never auto-filled ----------

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

// ---------- General info (A) / Process requirements (B) ----------

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

// ---------- Traceability ----------

export interface Traceability { version: number; createdAt: string; updatedAt: string; source: string }

export function touchDocument(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  return { ...doc, traceability: { ...doc.traceability, version: doc.traceability.version + 1, updatedAt: new Date().toISOString() } };
}

// ---------- restoring a saved document ----------

/** Attempts to restore a document previously saved to the browser's own localStorage - returns `null` on anything that
 *  doesn't parse as JSON or doesn't pass the same validation a fresh edit would, so a corrupted/incompatible save never
 *  crashes the page or silently loads a half-broken document. The structural parser (techdoc-parse.ts) is the one the
 *  DOCX/PDF export route trusts for untrusted HTTP input. */
export function tryRestoreDocument(rawJson: string | null | undefined): TechnicalProcessDocument | null {
  const result = restoreDocumentDetailed(rawJson);
  return result.status === 'ok' ? result.document : null;
}

export type RestoreResult =
  | { status: 'empty' }
  /** `migration` is set when the saved document was an OLDER schema and was converted in memory. Nothing is written back by
   *  restoring: the stored copy stays as it was until the user saves explicitly (and a backup of it is made first). */
  | { status: 'ok'; document: TechnicalProcessDocument; migratedFromSchema?: number; migration?: MigrationReport }
  /** Saved by a NEWER schema than this build knows: not parsed, not converted, not loaded. */
  | { status: 'future_version'; schemaVersion: number }
  /** Unusable data. `reason` (when known) is a safe, human-readable explanation to show the user. */
  | { status: 'invalid'; reason?: string };

/** Restores a saved document and says WHY when it cannot. Never throws and never writes to storage. */
export function restoreDocumentDetailed(rawJson: string | null | undefined): RestoreResult {
  if (!rawJson) return { status: 'empty' };
  try {
    const { document, migration } = parseTechnicalProcessDocumentDetailed(JSON.parse(rawJson));
    validateDocument(document);
    return { status: 'ok', document, ...(migration ? { migratedFromSchema: migration.fromSchema, migration } : {}) };
  } catch (error) {
    if (error instanceof UnsupportedSchemaVersionError) return { status: 'future_version', schemaVersion: error.schemaVersion };
    const reason = error instanceof SyntaxError ? 'Сохранённые данные повреждены (это не корректный JSON).' : error instanceof Error ? error.message : undefined;
    return { status: 'invalid', reason };
  }
}

/** Minimal Storage surface (a real localStorage or a test double). */
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function backupKeyFor(storageKey: string, fromSchema: number): string {
  return `${storageKey}:backup-schema${fromSchema}`;
}

export type SaveOutcome =
  | { status: 'saved'; backupWritten: boolean; backupKey?: string }
  | { status: 'backup_failed'; backupKey: string; reason: string }
  /** The document would not open again (a size/nesting limit): nothing was written, the stored data is untouched. */
  | { status: 'not_restorable'; reason: string };

const MAX_BACKUP_KEYS = 50;

/** Saves `doc` under `storageKey`. Before anything is written the document must be able to come back: it is run through the same restore
 *  a reload does, and a document that would not restore is REFUSED (the stored data stays as it was).
 *
 *  When the document was MIGRATED from an older schema (`migrated`), the stored text before migration (`originalRaw`) is first copied under a
 *  backup key. An existing backup is reused ONLY if it is exactly this text; a backup that holds a different recipe is never overwritten or
 *  trusted - the copy goes under the next free key ("...-schema3", "...-schema3-2", ...). Every copy is read back and compared; if no reliable copy
 *  can be made, the save is REFUSED. */
export function saveDocumentWithBackup(
  storage: KeyValueStorage, storageKey: string, doc: TechnicalProcessDocument,
  migrated?: { fromSchema: number; originalRaw: string },
): SaveOutcome {
  const text = JSON.stringify(doc);
  const check = restoreDocumentDetailed(text);
  if (check.status !== 'ok') return { status: 'not_restorable', reason: check.status === 'invalid' ? check.reason ?? 'документ не проходит проверку' : 'документ не читается' };
  let backupWritten = false;
  let backupKey: string | undefined;
  if (migrated) {
    const base = backupKeyFor(storageKey, migrated.fromSchema);
    try {
      for (let i = 1; i <= MAX_BACKUP_KEYS && backupKey === undefined; i++) {
        const key = i === 1 ? base : `${base}-${i}`;
        const existing = storage.getItem(key);
        if (existing === migrated.originalRaw) { backupKey = key; break; }
        if (existing !== null) continue; // another recipe lives there: never overwritten
        storage.setItem(key, migrated.originalRaw);
        if (storage.getItem(key) !== migrated.originalRaw) return { status: 'backup_failed', backupKey: key, reason: 'резервная копия не совпала с исходным текстом после записи' };
        backupKey = key; backupWritten = true;
      }
    } catch (error) {
      return { status: 'backup_failed', backupKey: base, reason: error instanceof Error ? error.message : 'хранилище недоступно' };
    }
    if (backupKey === undefined) return { status: 'backup_failed', backupKey: base, reason: 'не найден свободный ключ резервной копии' };
  }
  storage.setItem(storageKey, text);
  return { status: 'saved', backupWritten, ...(backupKey ? { backupKey } : {}) };
}

// ---------- TechnicalProcessDocument (top level) ----------

export interface TechnicalProcessDocument {
  /** Version of the STORAGE FORMAT (see techdoc-schema.ts) - not the revision of the document's content, which is `traceability.version`. */
  schemaVersion: number;
  /** Display unit of every pressure in the editor, previews and exports. Changing it never changes a stored value (always pascal). */
  pressureUnit: PressureUnit;
  general: GeneralInfo;
  initialData: InitialData;
  steps: ProcessStep[];
  qualityChecks: QualityCheck[];
  safety: SafetySection;
  /** Everything an older schema carried that the cards have no place for. Never part of the process in exports. */
  legacy: LegacyData;
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
    qualityChecks: [],
    safety: createDefaultSafety(),
    legacy: createEmptyLegacy(),
    traceability: { version: 1, createdAt: now, updatedAt: now, source: 'blank' },
  };
}

// ---------- Presets: structure ONLY - no unconfirmed technological parameters ----------

export interface ProcessPreset { id: string; label: string; description: string; stepTypes: StepType[]; coatingMode?: CoatingMode }

export const PROCESS_PRESETS: ProcessPreset[] = [
  { id: 'magnetron-pvd', label: 'Magnetron PVD coating', description: 'Типовая структура процесса магнетронного PVD-покрытия (однослойное покрытие).', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'cooling', 'unloading'], coatingMode: 'single' },
  { id: 'vacuum-arc-fcva', label: 'Vacuum Arc / FCVA coating', description: 'Типовая структура процесса вакуумно-дугового (FCVA) осаждения (однослойное покрытие).', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'cooling', 'unloading'], coatingMode: 'single' },
  { id: 'hybrid-magnetron-arc', label: 'Hybrid Magnetron + Arc', description: 'Типовая структура гибридного процесса (магнетрон + дуга), многослойное покрытие.', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'cooling', 'unloading'], coatingMode: 'multi' },
  { id: 'pecvd', label: 'PECVD', description: 'Типовая структура процесса плазмохимического осаждения (PECVD).', stepTypes: ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'multilayer_coating', 'cooling', 'unloading'], coatingMode: 'single' },
  { id: 'icp-rie-etching', label: 'ICP/RIE etching', description: 'Типовая структура процесса плазменного травления ICP/RIE (карточка «Плазменная/ионная очистка»).', stepTypes: ['loading', 'pumpdown', 'plasma_ion_cleaning', 'unloading'] },
  { id: 'plasma-cleaning', label: 'Plasma cleaning', description: 'Типовая структура процесса плазменной очистки.', stepTypes: ['loading', 'pumpdown', 'plasma_ion_cleaning', 'cooling', 'unloading'] },
];

/** Builds ONLY the stage skeleton (order, type, name) from a preset - every parameter field stays `undefined` ("не задано"). */
export function createDocumentFromPreset(presetId: string): TechnicalProcessDocument {
  const preset = PROCESS_PRESETS.find(p => p.id === presetId);
  if (!preset) throw new Error(`Пресет не найден: ${presetId}`);
  const steps: ProcessStep[] = [];
  for (const type of preset.stepTypes) {
    const step: ProcessStep = { ...createStep(type, undefined, 'preset', nextId('step', steps)), order: steps.length + 1 };
    if (type === 'multilayer_coating') {
      step.coatingMode = preset.coatingMode ?? 'multi';
      if (step.coatingMode === 'single') step.layers = [createLayer('layer-1')];
    }
    steps.push(step);
  }
  const doc = createBlankDocument();
  return { ...doc, steps, traceability: { ...doc.traceability, source: presetId } };
}

// ---------- validation: only objectively invalid values, never invented limits ----------

function checkField(key: StepFieldKey, value: unknown, where: string): void {
  if (value === undefined) return;
  const meta = STEP_FIELD_META[key];
  const label = `${where}: ${meta.label.toLowerCase()}`;
  if (meta.kind === 'text') { if (typeof value !== 'string') throw new Error(`${label}: ожидается текст.`); return; }
  const n = value as number;
  if (meta.kind === 'count') {
    assertNonNegative(n, label);
    if (!Number.isInteger(n)) throw new Error(`${label}: ожидается целое число.`);
    return;
  }
  if (meta.rule === 'temperature') checkOptionalAboveAbsoluteZero(n, label);
  else if (meta.rule === 'finite') checkOptionalFinite(n, label); // bias is routinely negative in PVD - finite only
  else checkOptionalNonNegative(n, label);
}

export function validateDocument(doc: TechnicalProcessDocument): void {
  if (!isPressureUnit(doc.pressureUnit)) throw new Error('Единица давления: допустимо Па или мбар.');
  if (!doc.general.processName || !doc.general.processName.trim()) {
    throw new Error('Название процесса: обязательное поле, введите значение.');
  }

  const seenOrders = new Set<number>();
  const seenIds = new Set<string>();
  for (const step of doc.steps) {
    if (seenOrders.has(step.order)) throw new Error(`Дублирующийся номер этапа: №${step.order}. Номера этапов должны быть уникальными.`);
    seenOrders.add(step.order);
    if (seenIds.has(step.id)) throw new Error(`Дублирующийся идентификатор этапа «${step.id}».`);
    seenIds.add(step.id);
    if (!(STEP_TYPES as readonly string[]).includes(step.type)) throw new Error(`Этап №${step.order}: недопустимый тип карточки «${step.type}».`);

    const where = `Этап №${step.order}`;
    const spec = STEP_TYPE_SPECS[step.type];
    for (const key of spec.fields) checkField(key, step[key], where);
    if (!(COATING_MODES as readonly string[]).includes(step.coatingMode)) throw new Error(`${where}: недопустимый режим покрытия.`);
    if (spec.layers) {
      if (step.coatingMode === 'single' && step.layers.length > 1) throw new Error(`${where}: в однослойном режиме может быть только один слой (сейчас ${step.layers.length}).`);
      const layerIds = new Set<string>();
      step.layers.forEach((layer, index) => {
        if (layerIds.has(layer.id)) throw new Error(`${where}: повторяется идентификатор слоя «${layer.id}».`);
        layerIds.add(layer.id);
        for (const key of LAYER_FIELDS) checkField(key, layer[key as keyof CoatingLayer], `${where}, слой ${index + 1}`);
      });
    }
  }

  checkOptionalNonNegative(doc.initialData.partSizeMm, 'Размер изделия');
  checkOptionalNonNegative(doc.initialData.quantity, 'Количество');
  checkOptionalNonNegative(doc.initialData.requiredThicknessUm, 'Требуемая толщина');
  checkOptionalAboveAbsoluteZero(doc.initialData.allowedTemperatureC, 'Допустимая температура');

  const qcIds = new Set<string>();
  for (const qc of doc.qualityChecks) {
    if (qc.id.trim() === '' || qcIds.has(qc.id)) throw new Error(`Контроль качества: повторяется или пуст идентификатор проверки «${qc.id}». Идентификаторы должны быть уникальными.`);
    qcIds.add(qc.id);
  }

  validateUnits(doc);
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

/** One card field as text: "12 мин", "0.5 Па", "ВАК-1", "не задано". */
function fieldValueText(key: StepFieldKey, value: unknown, unit: PressureUnit, dash = false): string {
  const meta = STEP_FIELD_META[key];
  if (value === undefined || value === '') return dash ? DASH : NOT_SET;
  if (meta.pressure) return formatPressure(value as number, unit, dash);
  if (meta.kind === 'text') return String(value);
  // "350°C" (no space) as in every earlier version of the documents; other units are separated by a space
  return `${value}${meta.unit ? (meta.unit === '°C' ? meta.unit : ` ${meta.unit}`) : ''}`;
}

/** The label of a printed parameter line: the name only - the unit is part of the VALUE ("0.5 Па", "60 мин"). */
const fieldLabel = (key: StepFieldKey, optionalKeys: readonly StepFieldKey[]) => `${STEP_FIELD_META[key].label}${optionalKeys.includes(key) ? ' (необязательно)' : ''}`;

export interface ParameterLine { key: StepFieldKey; label: string; value: string }

/** The fields of a card in the order of its type, each with its label and value ("не задано" when empty). */
export function stepParameterLines(doc: Pick<TechnicalProcessDocument, 'pressureUnit'>, step: ProcessStep): ParameterLine[] {
  const spec = STEP_TYPE_SPECS[step.type];
  return spec.fields.map(key => ({ key, label: fieldLabel(key, spec.optional), value: fieldValueText(key, step[key], doc.pressureUnit) }));
}
export function layerParameterLines(doc: Pick<TechnicalProcessDocument, 'pressureUnit'>, layer: CoatingLayer): ParameterLine[] {
  return LAYER_FIELDS.map(key => ({ key, label: fieldLabel(key, LAYER_OPTIONAL_FIELDS), value: fieldValueText(key, layer[key as keyof CoatingLayer], doc.pressureUnit) }));
}

// ---------- long source / gas lists in the card: decided by the SIZE of the content ----------

const unitSourcesText = (unit: StepUnit) => unit.sources.length > 0 ? unit.sources.map(formatSource).join('; ') : DASH;
const unitGasesText = (unit: StepUnit) => unit.gases.length > 0 ? unit.gases.map(formatGas).join('; ') : DASH;

/** A card cell moves to a detail table when its text would need more than CARD_CELL_LINE_BUDGET lines in its real column (see
 *  techdoc-card-layout.ts for how the number was measured) - decided by the SIZE of the content, not by how many items there are. */
export function hasLongList(unit: StepUnit, kind: 'sources' | 'gases'): boolean {
  if ((kind === 'sources' ? unit.sources.length : unit.gases.length) === 0) return false;
  const layered = unit.layerNumber !== undefined;
  const weights = layered ? LAYER_TABLE_WEIGHTS : CARD_COLUMN_WEIGHTS;
  const column = layered ? (kind === 'sources' ? LAYER_SOURCE_COLUMN : LAYER_GAS_COLUMN) : (kind === 'sources' ? CARD_SOURCE_COLUMN : CARD_GAS_COLUMN);
  return estimateLines(kind === 'sources' ? unitSourcesText(unit) : unitGasesText(unit), columnWidthPt(weights, column), TYPICAL_CHAR_PT) > CARD_CELL_LINE_BUDGET;
}

export function cardDetailHeading(step: ProcessStep, unit: StepUnit, kind: 'sources' | 'gases'): string {
  const where = unit.layerNumber !== undefined ? `Этап №${step.order} «${step.name}», слой ${unit.layerNumber}` : `Этап №${step.order} «${step.name}»`;
  return `${where}: ${kind === 'sources' ? 'источники' : 'газовые линии'}`;
}
export function layersTableHeading(step: ProcessStep): string {
  return `Этап №${step.order} «${step.name}»: слои покрытия`;
}

function listCell(step: ProcessStep, unit: StepUnit, kind: 'sources' | 'gases', compact: boolean): string {
  const full = kind === 'sources' ? unitSourcesText(unit) : unitGasesText(unit);
  if (!(compact && hasLongList(unit, kind))) return full;
  const items = kind === 'sources' ? unit.sources : unit.gases;
  const on = items.filter(i => i.enabled).length;
  return `${kind === 'sources' ? 'источников' : 'газовых линий'}: ${items.length} (включено ${on}) - полный перечень в таблице «${cardDetailHeading(step, unit, kind)}» ниже`;
}

// ---------- everything one card contributes to a document - the single source for the preview and the exports ----------

export interface StepDetailUnit { title?: string; parameters: ParameterLine[]; sources: string[]; gases: string[] }
export interface StepDetails { parameters: ParameterLine[]; units: StepDetailUnit[]; notes: string[]; warnings: string[] }

export function buildStepDetails(doc: TechnicalProcessDocument, step: ProcessStep): StepDetails {
  const spec = STEP_TYPE_SPECS[step.type];
  const units: StepDetailUnit[] = spec.layers
    ? step.layers.map((layer, i) => ({ title: `Слой ${i + 1}`, parameters: layerParameterLines(doc, layer), sources: layer.sources.map(formatSource), gases: layer.gases.map(formatGas) }))
    : (spec.sources || spec.gases) ? [{ parameters: [], sources: step.sources.map(formatSource), gases: step.gases.map(formatGas) }] : [];
  const all = stepUnits(step);
  const notes: string[] = [];
  if (all.some(u => u.sources.some(s => s.enabled && s.mode === 'sequential'))) notes.push(`Последовательный режим: ${SEQUENTIAL_MODE_MEANING}.`);
  if (all.some(u => u.gases.some(g => g.enabled && g.flowSccm !== undefined))) notes.push(`Расход газа: ${SCCM_MEANING}.`);
  return {
    parameters: spec.layers ? [{ key: 'material', label: 'Режим покрытия', value: COATING_MODE_LABELS[step.coatingMode] } as ParameterLine] : stepParameterLines(doc, step),
    units, notes,
    warnings: collectStepWarningItems(doc).filter(w => w.order === step.order).map(w => w.text),
  };
}

// ---------- legacy data: shown separately, never as part of the process ----------

function legacyValueText(value: LegacyValue): string {
  if (typeof value === 'string') return value;
  if (value === null) return DASH;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Lines describing the data kept from an older schema, or [] when there is none. Not process parameters: exports print them
 *  in a separate, clearly labelled appendix. */
export function buildLegacyLines(doc: TechnicalProcessDocument): string[] {
  const legacy = doc.legacy;
  const lines: string[] = [];
  for (const entry of legacy.stepFields.filter(e => e.fields.length > 0)) {
    lines.push(`Этап «${entry.stepName}»: ${entry.fields.map(f => `${f.label} — ${legacyValueText(f.value)}`).join('; ')}`);
  }
  for (const step of legacy.steps) {
    lines.push(`Этап прежней версии «${step.name}»${step.enabled ? '' : ' (был отключён)'} (прежний тип: ${step.originalType}, был №${step.originalOrder}): ${step.fields.length > 0 ? step.fields.map(f => `${f.label} — ${legacyValueText(f.value)}`).join('; ') : 'без параметров'}`);
  }
  const eq = legacy.equipment;
  if (eq) {
    for (const m of eq.magnetrons) lines.push(`Прежний справочник: магнетрон ${m.id} (${m.enabled ? 'доступен' : 'отключён'}): материал — ${fmtStr(m.material)}, мощность — ${fmtNum(m.powerW, ' Вт')}, режим — ${fmtStr(m.mode)}`);
    for (const a of eq.arcSources) lines.push(`Прежний справочник: дуговой источник ${a.id} (${a.enabled ? 'доступен' : 'отключён'}${a.filtered ? ', фильтрованный' : ''}): катод — ${fmtStr(a.cathodeMaterial)}, ток — ${fmtNum(a.arcCurrentA, ' А')}`);
    if (eq.icpRf.enabled || eq.icpRf.powerW !== undefined || eq.icpRf.biasV !== undefined) lines.push(`Прежний справочник: ICP/RF (${eq.icpRf.enabled ? 'включён' : 'выключен'}): мощность — ${fmtNum(eq.icpRf.powerW, ' Вт')}, смещение — ${fmtNum(eq.icpRf.biasV, ' В')}`);
    const ion = eq.ionSource;
    if (ion.enabled || ion.voltageV !== undefined || ion.currentA !== undefined || ion.powerW !== undefined) lines.push(`Прежний справочник: ионный источник (${ion.enabled ? 'включён' : 'выключен'}): напряжение — ${fmtNum(ion.voltageV, ' В')}, ток — ${fmtNum(ion.currentA, ' А')}, мощность — ${fmtNum(ion.powerW, ' Вт')}`);
    for (const g of eq.gasLines) lines.push(`Прежний справочник: газовая линия ${g.id} (${g.enabled ? 'включена' : 'отключена'}): газ — ${fmtStr(g.gas)}, расход — ${fmtNum(g.flow, ` ${g.unit}`)}`);
  }
  return lines;
}

export const LEGACY_APPENDIX_TITLE = 'Данные прежней версии (не входят в технологический режим)';
export const LEGACY_APPENDIX_NOTE = 'Эти данные перенесены из документа старой схемы и не являются параметрами процесса. Их можно просмотреть и перенести в карточки в редакторе.';

// ---------- document views: all built from the SAME data, no duplication ----------

export function buildInstructionView(doc: TechnicalProcessDocument): string {
  const g = doc.general;
  const lines: string[] = [];
  lines.push(`# Технологическая инструкция: ${fmtStr(g.processName)}`);
  lines.push('');
  lines.push('## A. Основные сведения');
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
  lines.push('## B. Требования к процессу');
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
  lines.push('## C. Технологические этапы');
  for (const step of doc.steps) {
    if (!step.enabled) { lines.push(`### ${step.order}. ${step.name} (отключён)`); continue; }
    lines.push(step.name === STEP_TYPE_LABELS[step.type] ? `### ${step.order}. ${step.name}` : `### ${step.order}. ${step.name} [${STEP_TYPE_LABELS[step.type]}]`);
    if (step.description) lines.push(step.description);
    const details = buildStepDetails(doc, step);
    for (const p of details.parameters) lines.push(`- ${p.label}: ${p.value}`);
    for (const unit of details.units) {
      if (unit.title) {
        lines.push(`- ${unit.title}:`);
        for (const p of unit.parameters) lines.push(`  - ${p.label}: ${p.value}`);
      }
      const pad = unit.title ? '  ' : '';
      if (unit.sources.length > 0) { lines.push(`${pad}- Источники:`); for (const text of unit.sources) lines.push(`${pad}  - ${text}`); }
      if (unit.gases.length > 0) { lines.push(`${pad}- Газовые линии:`); for (const text of unit.gases) lines.push(`${pad}  - ${text}`); }
    }
    for (const note of details.notes) lines.push(`- ${note}`);
    if (details.warnings.length > 0) { lines.push('- Замечания к данным этапа:'); for (const text of details.warnings) lines.push(`  - ${text}`); }
  }
  lines.push('');
  lines.push('## D. Контроль качества');
  if (doc.qualityChecks.length === 0) lines.push(NOT_SET);
  for (const qc of doc.qualityChecks) {
    // The unit appears exactly as in the export QC table - never invented when qc.unit is unset, only shown when the user
    // entered one, and attached to criterion/result (the numeric-looking fields a unit qualifies).
    const unit = qc.unit?.trim() ? ` ${qc.unit.trim()}` : '';
    const criterion = qc.criterion?.trim() ? `${qc.criterion.trim()}${unit}` : fmtStr(qc.criterion);
    const result = qc.result?.trim() ? `${qc.result.trim()}${unit}` : fmtStr(qc.result);
    lines.push(`- ${qc.parameter}: метод — ${fmtStr(qc.method)}, критерий — ${criterion}, результат — ${result}, статус — ${fmtStr(qc.status)}`);
  }
  lines.push('');
  lines.push('## E. Безопасность');
  lines.push(`- Опасности: ${doc.safety.hazards.length ? doc.safety.hazards.join(', ') : NOT_SET}`);
  lines.push(`- СИЗ: ${doc.safety.ppe.length ? doc.safety.ppe.join(', ') : NOT_SET}`);
  lines.push(`- Блокировки: ${doc.safety.interlocks.length ? doc.safety.interlocks.join(', ') : NOT_SET}`);
  lines.push(`- Газовая безопасность: ${fmtStr(doc.safety.gasSafety)}`);
  lines.push(`- Вакуумная безопасность: ${fmtStr(doc.safety.vacuumSafety)}`);
  lines.push(`- Высокое напряжение: ${fmtStr(doc.safety.highVoltage)}`);
  lines.push(`- Горячие поверхности: ${fmtStr(doc.safety.hotSurfaces)}`);
  if (doc.safety.notes) lines.push(`- Примечания: ${doc.safety.notes}`);
  const legacyLines = buildLegacyLines(doc);
  if (legacyLines.length > 0) {
    lines.push('');
    lines.push(`## ${LEGACY_APPENDIX_TITLE}`);
    lines.push(LEGACY_APPENDIX_NOTE);
    for (const text of legacyLines) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

export interface TechCardLayerRow {
  /** Number of the step the layer belongs to. */
  number: number; stepName: string; layer: number;
  material: string; thickness: string; duration: string; temperature: string; pressure: string; bias: string; motion: string;
  sources: string; gases: string;
}
export interface TechCardRow {
  number: number; operation: string; duration: string; temperature: string; pressure: string;
  gases: string; sources: string; bias: string; params: string; description: string;
  /** One row per coating layer (coating card only). */
  layers: TechCardLayerRow[];
}

const BY_LAYERS = 'по слоям';

function range(start: string, end: string): string {
  if (start === DASH && end === DASH) return DASH;
  return `${start === DASH ? NOT_SET : start} → ${end === DASH ? NOT_SET : end}`;
}

/** `compactLongLists` (used for DOCX/PDF): a card with a long source/gas list shows only the COUNT in its cell and points at the
 *  table that lists every item (see cardDetailHeading) - an explicit reference, never a silently shortened cell. Without it
 *  (on-screen preview, markdown) every cell holds the complete text. */
export function buildTechnologicalCard(doc: TechnicalProcessDocument, options: { compactLongLists?: boolean } = {}): TechCardRow[] {
  const compact = options.compactLongLists === true;
  const unit = doc.pressureUnit;
  return doc.steps.map(step => {
    const spec = STEP_TYPE_SPECS[step.type];
    const name = step.enabled ? step.name : `${step.name} (отключён)`;
    const units = stepUnits(step);
    if (spec.layers) {
      const layers: TechCardLayerRow[] = step.layers.map((layer, i) => ({
        number: step.order, stepName: name, layer: i + 1,
        material: fmtStr(layer.material, true), thickness: fmtNum(layer.thicknessNm, ' нм', true), duration: fmtNum(layer.durationMin, ' мин', true),
        temperature: fmtNum(layer.temperatureC, '°C', true), pressure: formatPressure(layer.pressurePa, unit, true), bias: fmtNum(layer.substrateBiasV, ' В', true),
        motion: [layer.rotationRpm !== undefined ? `${layer.rotationRpm} об/мин` : null, layer.distanceMm !== undefined ? `${layer.distanceMm} мм` : null].filter(Boolean).join(' / ') || DASH,
        sources: listCell(step, units[i], 'sources', compact), gases: listCell(step, units[i], 'gases', compact),
      }));
      return {
        number: step.order, operation: name,
        duration: BY_LAYERS, temperature: BY_LAYERS, pressure: BY_LAYERS, gases: BY_LAYERS, sources: BY_LAYERS, bias: BY_LAYERS,
        params: `${step.coatingMode === 'single' ? 'однослойное' : 'многослойное'}, слоёв: ${step.layers.length}`,
        description: fmtStr(step.description, true), layers,
      };
    }
    const has = (key: StepFieldKey) => (spec.fields as readonly string[]).includes(key);
    const show = (key: StepFieldKey) => has(key) ? fieldValueText(key, step[key], unit, true) : DASH;
    const temperature = has('temperatureStartC') || has('temperatureEndC') ? range(show('temperatureStartC'), show('temperatureEndC')) : show('temperatureC');
    const pressure = has('pressureStartPa') || has('pressureEndPa') ? range(show('pressureStartPa'), show('pressureEndPa')) : show('pressurePa');
    const covered: StepFieldKey[] = ['durationMin', 'temperatureC', 'temperatureStartC', 'temperatureEndC', 'pressurePa', 'pressureStartPa', 'pressureEndPa', 'substrateBiasV'];
    const other = spec.fields.filter(k => !covered.includes(k)).map(k => `${STEP_FIELD_META[k].label}: ${fieldValueText(k, step[k], unit)}`);
    return {
      number: step.order, operation: name, duration: show('durationMin'), temperature, pressure,
      gases: spec.gases ? listCell(step, units[0], 'gases', compact) : DASH,
      sources: spec.sources ? listCell(step, units[0], 'sources', compact) : DASH,
      bias: show('substrateBiasV'), params: other.length > 0 ? other.join('; ') : DASH, description: fmtStr(step.description, true), layers: [],
    };
  });
}

export interface RouteCardRow {
  number: number; stage: string; equipment: string; input: string; operation: string; output: string;
}

/** A disabled step is skipped in the real process, so it must never be shown as the thing handing input to (or receiving output
 *  from) its neighbors - input/output always reference the nearest ENABLED step, not just the adjacent array index. */
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
  }));
}

export function buildBriefRecipe(doc: TechnicalProcessDocument): string {
  const lines: string[] = [`# Краткий рецепт: ${fmtStr(doc.general.processName)}`];
  const hasUnits = (step: ProcessStep) => stepUnits(step).some(u => u.sources.length > 0 || u.gases.length > 0);
  // The recipe shows only temperature, pressure and time. When cards also carry sources, gas lines or layers it says so.
  if (doc.steps.some(step => step.enabled && (hasUnits(step) || STEP_TYPE_SPECS[step.type].layers))) {
    lines.push('Сокращённое представление: температура, давление и время. Источники, газовые линии и слои указаны только числом - полные данные в технологической инструкции.');
  }
  const unit = doc.pressureUnit;
  for (const step of doc.steps) {
    if (!step.enabled) continue;
    const spec = STEP_TYPE_SPECS[step.type];
    if (spec.layers) {
      const on = step.layers.length;
      const layerParts = step.layers.map((l, i) => `слой ${i + 1}: ${[l.temperatureC !== undefined ? `T: ${l.temperatureC}°C` : null, l.pressurePa !== undefined ? `P: ${formatPressure(l.pressurePa, unit)}` : null, l.durationMin !== undefined ? `t: ${l.durationMin} мин` : null].filter(Boolean).join(', ') || NOT_SET}`);
      lines.push(`${step.order}. ${step.name} — ${step.coatingMode === 'single' ? 'однослойное' : 'многослойное'}, слоёв: ${on}${layerParts.length ? ` (${layerParts.join('; ')})` : ''}`);
      continue;
    }
    const has = (key: StepFieldKey) => (spec.fields as readonly string[]).includes(key);
    const parts = [
      has('temperatureC') && step.temperatureC !== undefined ? `T: ${step.temperatureC}°C` : null,
      (has('temperatureStartC') || has('temperatureEndC')) && (step.temperatureStartC !== undefined || step.temperatureEndC !== undefined) ? `T: ${fieldValueText('temperatureStartC', step.temperatureStartC, unit)} → ${fieldValueText('temperatureEndC', step.temperatureEndC, unit)}` : null,
      has('pressurePa') && step.pressurePa !== undefined ? `P: ${formatPressure(step.pressurePa, unit)}` : null,
      (has('pressureStartPa') || has('pressureEndPa')) && (step.pressureStartPa !== undefined || step.pressureEndPa !== undefined) ? `P: ${fieldValueText('pressureStartPa', step.pressureStartPa, unit)} → ${fieldValueText('pressureEndPa', step.pressureEndPa, unit)}` : null,
      step.durationMin !== undefined && has('durationMin') ? `t: ${step.durationMin} мин` : null,
    ].filter(Boolean);
    const marker = step.sources.length > 0 || step.gases.length > 0
      ? ` [источников: ${step.sources.length} (включено ${step.sources.filter(s => s.enabled).length}), газовых линий: ${step.gases.length} (включено ${step.gases.filter(g => g.enabled).length}) - см. инструкцию]`
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

// ---------- export architecture: structured JSON + markdown views ----------

export interface TechDocExport {
  json: TechnicalProcessDocument;
  markdown: { instruction: string; technologicalCard: string; routeCard: string; briefRecipe: string };
}

export function buildExport(doc: TechnicalProcessDocument): TechDocExport {
  const techCard = buildTechnologicalCard(doc);
  const routeCard = buildRouteCard(doc);
  const cardRows = techCard.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sources, r.bias, r.params, r.description]);
  const layerRows = techCard.flatMap(r => r.layers.map(l => [String(l.number), l.stepName, String(l.layer), l.material, l.thickness, l.duration, l.temperature, l.pressure, l.bias, l.motion, l.sources, l.gases]));
  return {
    json: doc,
    markdown: {
      instruction: buildInstructionView(doc),
      technologicalCard: [
        toMarkdownTable(['№', 'Операция', 'Время', 'Темп.', 'Давление', 'Газы', 'Источники', 'Bias', 'Прочие параметры', 'Описание'], cardRows),
        ...(layerRows.length > 0 ? ['', 'Слои покрытия:', toMarkdownTable(['№ этапа', 'Этап', 'Слой', 'Материал', 'Толщина', 'Время', 'Температура', 'Давление', 'Bias', 'Вращение / расстояние', 'Источники', 'Газы'], layerRows)] : []),
      ].join('\n'),
      routeCard: toMarkdownTable(
        ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход'],
        routeCard.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output]),
      ),
      briefRecipe: buildBriefRecipe(doc),
    },
  };
}

// ---------- legacy data: view and restore ----------
//
// Old values that the new cards have no place for are never deleted by a migration. They stay in `doc.legacy`, are shown next
// to the card they came from, and the user can move them into the card (a field, the description, a source or a gas line) or
// remove them explicitly. Nothing here changes anything unless called.

const withLegacy = (doc: TechnicalProcessDocument, legacy: LegacyData): TechnicalProcessDocument => ({ ...doc, legacy });

function legacyEntry(doc: TechnicalProcessDocument, stepId: string) {
  return doc.legacy.stepFields.find(e => e.stepId === stepId);
}
function takeLegacyField(doc: TechnicalProcessDocument, stepId: string, key: string): { field: LegacyField; others: LegacyData } {
  const entry = legacyEntry(doc, stepId);
  const field = entry?.fields.find(f => f.key === key);
  if (!entry || !field) throw new Error('Прежнее поле не найдено.');
  const stepFields = doc.legacy.stepFields
    .map(e => e.stepId === stepId ? { ...e, fields: e.fields.filter(f => f.key !== key) } : e)
    .filter(e => e.fields.length > 0);
  return { field, others: { ...doc.legacy, stepFields } };
}
const legacyText = (field: LegacyField) => `${field.label}: ${legacyValueText(field.value)}`;

/** Appends an old field to the card's description as "Название: значение" and removes it from the legacy data. */
export function moveLegacyFieldToDescription(doc: TechnicalProcessDocument, stepId: string, key: string): TechnicalProcessDocument {
  const step = doc.steps.find(s => s.id === stepId);
  if (!step) throw new Error('Этап не найден.');
  const { field, others } = takeLegacyField(doc, stepId, key);
  const description = [step.description, legacyText(field)].filter(Boolean).join('\n');
  if (description.length > MAX_LONG_TEXT) throw new Error(`Описание не может быть длиннее ${MAX_LONG_TEXT} символов: перенос сделал бы его слишком длинным. Значение остаётся в данных прежней версии.`);
  return { ...withLegacy(doc, others), steps: doc.steps.map(s => s.id === stepId ? { ...s, description, origin: 'user' as const } : s) };
}

/** Moves an old value into a field of the card. Refused when the card has no such field, the field already holds a value
 *  (nothing is overwritten) or the value is not of that field's type. */
export function restoreLegacyField(doc: TechnicalProcessDocument, stepId: string, key: string, target: StepFieldKey): TechnicalProcessDocument {
  const step = doc.steps.find(s => s.id === stepId);
  if (!step) throw new Error('Этап не найден.');
  const spec = STEP_TYPE_SPECS[step.type];
  if (!(spec.fields as readonly string[]).includes(target)) throw new Error(`В карточке «${STEP_TYPE_LABELS[step.type]}» нет поля «${STEP_FIELD_META[target].label}».`);
  if (step[target] !== undefined) throw new Error(`Поле «${STEP_FIELD_META[target].label}» уже заполнено - прежнее значение не перезаписывает его.`);
  const { field, others } = takeLegacyField(doc, stepId, key);
  const wantsText = STEP_FIELD_META[target].kind === 'text';
  if (typeof field.value !== (wantsText ? 'string' : 'number')) throw new Error(`Значение «${legacyValueText(field.value)}» не подходит к полю «${STEP_FIELD_META[target].label}».`);
  return { ...withLegacy(doc, others), steps: updateStep(doc.steps, step.order, { [target]: field.value } as StepPatch) };
}

/** Removes an old field - only when the user explicitly asks. */
export function removeLegacyField(doc: TechnicalProcessDocument, stepId: string, key: string): TechnicalProcessDocument {
  return withLegacy(doc, takeLegacyField(doc, stepId, key).others);
}

/** Turns an old step that has no card type into a card of `type`: values that fit its fields are placed, the rest stays legacy
 *  data of the new card. The step is appended at the end of the process (move it where it belongs). */
export function restoreLegacyStep(doc: TechnicalProcessDocument, legacyStepId: string, type: StepType): TechnicalProcessDocument {
  const old = doc.legacy.steps.find(s => s.id === legacyStepId);
  if (!old) throw new Error('Прежний этап не найден.');
  const spec = STEP_TYPE_SPECS[type];
  const base: ProcessStep = { ...createStep(type, old.name, 'user', nextId('step', doc.steps)), order: doc.steps.length + 1, enabled: old.enabled };
  let step = base;
  let rest: LegacyField[];
  if (spec.layers) {
    const placed = placeLayerFields(createLayer('layer-1'), old.fields.filter(f => f.key !== 'description'));
    step = { ...base, coatingMode: 'single', layers: [placed.layer] };
    const description = old.fields.find(f => f.key === 'description' && typeof f.value === 'string');
    if (description) step.description = description.value as string;
    rest = placed.rest;
  } else {
    const placed = placeFields(base, old.fields);
    step = placed.step;
    rest = placed.rest;
  }
  const stepFields = rest.length > 0 ? [...doc.legacy.stepFields, { stepId: step.id, stepName: step.name, fields: rest }] : doc.legacy.stepFields;
  return { ...doc, steps: [...doc.steps, step], legacy: { ...doc.legacy, steps: doc.legacy.steps.filter(s => s.id !== legacyStepId), stepFields } };
}

export function removeLegacyStep(doc: TechnicalProcessDocument, legacyStepId: string): TechnicalProcessDocument {
  return withLegacy(doc, { ...doc.legacy, steps: doc.legacy.steps.filter(s => s.id !== legacyStepId) });
}

export type LegacyEquipmentRef =
  | { kind: 'magnetron' | 'arc'; id: string }
  | { kind: 'icp_rf' | 'ion' }
  | { kind: 'gas'; id: string };

/** Copies an item of the old equipment registry into a card (or layer) as a NEW source / gas line, with the values it had. The
 *  old record stays in the legacy data (it is a copy, not a move). A gas flow kept in a unit other than sccm is not converted: the
 *  line is created without a flow. */
export function copyLegacyEquipmentToUnit(doc: TechnicalProcessDocument, item: LegacyEquipmentRef, ref: UnitRef): TechnicalProcessDocument {
  const eq = doc.legacy.equipment;
  if (!eq) throw new Error('Прежнего справочника оборудования нет.');
  const step = doc.steps.find(s => s.order === ref.order);
  if (!step) throw new Error(`Этап №${ref.order} не найден.`);
  if (item.kind === 'gas') {
    const line = eq.gasLines.find(l => l.id === item.id);
    if (!line) throw new Error(`Прежняя газовая линия ${item.id} не найдена.`);
    const added = addGas(doc.steps, ref);
    const unit = stepUnits(added.find(s => s.order === ref.order)!).find(u => u.ref.layerId === ref.layerId)!;
    const created = unit.gases[unit.gases.length - 1];
    const sccm = line.unit.trim().toLowerCase() === 'sccm';
    // the line keeps its old ON/OFF state: a switched-off line stays switched off after copying
    return { ...doc, steps: updateGas(added, ref, created.id, { gas: line.gas, enabled: line.enabled, ...(sccm && line.flow !== undefined ? { flowSccm: line.flow } : {}) }) };
  }
  const kind: SourceKind = item.kind;
  const added = addSource(doc.steps, ref, kind);
  const unit = stepUnits(added.find(s => s.order === ref.order)!).find(u => u.ref.layerId === ref.layerId)!;
  const created = unit.sources[unit.sources.length - 1];
  let patch: Partial<Omit<StepSource, 'id' | 'kind'>> = {};
  if (item.kind === 'magnetron') {
    const m = eq.magnetrons.find(x => x.id === item.id);
    if (!m) throw new Error(`Прежний магнетрон ${item.id} не найден.`);
    patch = { material: m.material, powerW: m.powerW, operatingMode: m.mode, enabled: m.enabled };
  } else if (item.kind === 'arc') {
    const a = eq.arcSources.find(x => x.id === item.id);
    if (!a) throw new Error(`Прежний дуговой источник ${item.id} не найден.`);
    patch = { material: a.cathodeMaterial, currentA: a.arcCurrentA, filtered: a.filtered, enabled: a.enabled };
  } else if (item.kind === 'icp_rf') patch = { powerW: eq.icpRf.powerW, biasV: eq.icpRf.biasV, enabled: eq.icpRf.enabled };
  else patch = { voltageV: eq.ionSource.voltageV, currentA: eq.ionSource.currentA, powerW: eq.ionSource.powerW, enabled: eq.ionSource.enabled };
  return { ...doc, steps: updateSource(added, ref, created.id, patch) };
}

export function clearLegacyEquipment(doc: TechnicalProcessDocument): TechnicalProcessDocument {
  const { equipment: _equipment, ...rest } = doc.legacy;
  void _equipment;
  return withLegacy(doc, rest);
}
