/** Converts a document of schema 1-3 (equipment registry + one common field set per step) into schema 4 (eight card types,
 *  sources and gas lines inside the cards, coating layers). Pure and client-safe; runs in memory only - nothing is written to
 *  storage by migrating.
 *
 *  What it guarantees:
 *   - NOTHING is dropped. A value goes either into the place the new card has for it or into `legacy` (kept, viewable, restorable,
 *     never printed as a process parameter). Only steps that are completely empty are not kept (and are counted in the report).
 *   - NOTHING is guessed. A single old pressure/temperature is NOT placed into a "start" or "end" field; an old gas list is not
 *     merged with assignments that already name gases; the registry's nominal values are kept, not applied to steps.
 *   - A reference that cannot be resolved (an assignment pointing at a source that is not in the registry) is kept as a source
 *     with no material and reported.
 *   - An assignment pointing at an id that two registry records share is REFUSED (which record was meant cannot be known). */

import type { TechnicalProcessDocument, QualityCheck } from './techdoc-assistant';
import { placeFields, placeLayerFields, createLayer, createStep, type ProcessStep } from './techdoc-steps';
import { MAX_LONG_TEXT, withUniqueIds } from './techdoc-parse-utils';
import type { V3Document, V3Step, V3StepType } from './techdoc-legacy';
import {
  TECHDOC_SCHEMA_VERSION, STEP_TYPES, STEP_TYPE_LABELS, STEP_TYPE_SPECS, SOURCE_KIND_LABELS, nextId, hasLegacyData,
  type StepSource, type StepGas, type StepType, type LegacyField, type LegacyValue, type LegacyStep, type LegacyStepFields, type LegacyEquipment, type LegacyData,
} from './techdoc-schema';

export interface MigrationReport {
  fromSchema: number;
  /** Cards in the migrated document. */
  steps: number;
  /** Old fields kept as legacy data of a card (not placed in a field of the new card). */
  legacyFields: number;
  /** Old steps that have no card type in schema 4 and were kept as legacy steps. */
  legacySteps: { name: string; originalType: string }[];
  /** Quality-control steps whose text became checks in section D but which also carried other values (duration, ...): those values are kept as legacy steps. */
  qualityResidualSteps: string[];
  /** Switched-off quality-control steps: kept as legacy steps (still off), not turned into active checks. */
  disabledQualitySteps: string[];
  /** Cards whose type changed: coating-like steps became the coating card in single-layer mode. */
  remappedTypes: { order: number; name: string; from: string; to: StepType }[];
  qualityChecksCreated: number;
  qualityChecksSkippedAsDuplicate: number;
  /** Steps with no content at all that were not kept. */
  emptyStepsDropped: number;
  /** Old sources/gas lines carried into cards. */
  sourcesMigrated: number;
  gasLinesMigrated: number;
  /** Old registry items kept as legacy equipment (unused, or with nominal values that have no place in a card). */
  equipmentKept: boolean;
  danglingReferences: string[];
}

export class MigrationIntegrityError extends Error {}

/** Old step type -> what it becomes. */
const TYPE_MAP: Record<V3StepType, StepType | 'quality' | 'legacy'> = {
  loading: 'loading', pumpdown: 'pumpdown', heating: 'heating', plasma_ion_cleaning: 'plasma_ion_cleaning',
  adhesion_underlayer: 'adhesion_underlayer', multilayer_coating: 'multilayer_coating', cooling: 'cooling', unloading: 'unloading',
  main_coating: 'multilayer_coating', reactive_deposition: 'multilayer_coating',
  quality_control: 'quality', surface_preparation: 'legacy', etching: 'legacy', custom: 'legacy',
};

const V3_DEFAULT_LABELS: Record<V3StepType, string> = {
  loading: 'Загрузка', pumpdown: 'Откачка', heating: 'Нагрев', plasma_ion_cleaning: 'Плазменная/ионная очистка', surface_preparation: 'Подготовка поверхности',
  adhesion_underlayer: 'Адгезионный подслой', main_coating: 'Основное покрытие', multilayer_coating: 'Многослойное покрытие', reactive_deposition: 'Реактивное осаждение',
  etching: 'Травление', cooling: 'Охлаждение', unloading: 'Выгрузка', quality_control: 'Контроль качества', custom: 'Пользовательский этап',
};

const FIELD_LABELS: Record<string, string> = {
  description: 'Описание',
  durationMin: 'Продолжительность, мин', temperatureC: 'Температура, °C', pressurePa: 'Давление, Па', substrateBiasV: 'Напряжение смещения, В',
  rotationRpm: 'Вращение, об/мин', distanceMm: 'Расстояние, мм', powerW: 'Мощность этапа (общая), Вт', currentA: 'Ток этапа (общий), А',
  sourceConfiguration: 'Источник (описание)', gasUsage: 'Общий список газов', notes: 'Примечание', acceptanceCriteria: 'Критерий приёмки',
  sources: 'Источники этапа', gases: 'Газовые линии этапа',
};

/** JSON-safe copy: no `undefined` members. */
function clean<T extends object>(value: T): LegacyValue {
  return JSON.parse(JSON.stringify(value)) as LegacyValue;
}

function norm(text: string | undefined): string { return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase(); }

function duplicatedIds(items: readonly { id: string }[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of items) { if (id.trim() === '') continue; if (seen.has(id)) repeated.add(id); seen.add(id); }
  return repeated;
}

/** An assignment that refers to an id shared by several registry records cannot be resolved: refuse, with the candidates listed. */
function assertNoAmbiguousReferences(v3: V3Document): void {
  const eq = v3.equipment;
  const lines = duplicatedIds(eq.gasLines);
  const magnetrons = duplicatedIds(eq.magnetrons);
  const arcs = duplicatedIds(eq.arcSources);
  for (const step of v3.steps) {
    for (const a of step.gasAssignments) {
      if (!lines.has(a.lineId)) continue;
      const candidates = eq.gasLines.filter(l => l.id === a.lineId).map(l => l.gas.trim() || 'газ не указан').join(' / ');
      throw new MigrationIntegrityError(`Этап №${step.order}: назначена линия ${a.lineId}, но в старом справочнике несколько линий с таким идентификатором (${candidates}). Определить, какая имеется в виду, нельзя. Документ не загружен и не изменён - исправьте идентификаторы линий вручную.`);
    }
    for (const a of step.sourceAssignments) {
      const repeated = a.kind === 'magnetron' ? magnetrons : arcs;
      if (!repeated.has(a.sourceId)) continue;
      const pool = a.kind === 'magnetron' ? eq.magnetrons.filter(m => m.id === a.sourceId).map(m => m.material) : eq.arcSources.filter(x => x.id === a.sourceId).map(x => x.cathodeMaterial);
      throw new MigrationIntegrityError(`Этап №${step.order}: назначен ${SOURCE_KIND_LABELS[a.kind]} ${a.sourceId}, но в старом справочнике несколько источников с таким идентификатором (${pool.map(m => m?.trim() || 'материал не задан').join(' / ')}). Определить, какой имеется в виду, нельзя. Документ не загружен и не изменён - исправьте идентификаторы источников вручную.`);
    }
  }
}

interface Resolved { sources: StepSource[]; gases: StepGas[]; usedMagnetrons: Set<string>; usedArcs: Set<string>; usedLines: Set<string> }

function resolveAssignments(step: V3Step, v3: V3Document, report: MigrationReport): Resolved {
  const eq = v3.equipment;
  const sources: StepSource[] = [];
  const gases: StepGas[] = [];
  const usedMagnetrons = new Set<string>();
  const usedArcs = new Set<string>();
  const usedLines = new Set<string>();
  for (const a of step.sourceAssignments) {
    const id = sources.some(s => s.id === a.sourceId) ? nextId(a.kind === 'magnetron' ? 'magnetron' : 'arc', sources) : a.sourceId;
    let source: StepSource;
    if (a.kind === 'magnetron') {
      const m = eq.magnetrons.find(x => x.id === a.sourceId);
      if (m) usedMagnetrons.add(m.id); else report.danglingReferences.push(`Этап №${step.order}: магнетрон ${a.sourceId} отсутствовал в старом справочнике - перенесён без материала.`);
      source = { id, kind: 'magnetron', enabled: a.enabled, material: m?.material, operatingMode: m?.mode, powerW: a.powerW, startMin: a.startMin, durationMin: a.durationMin, mode: a.mode };
    } else {
      const x = eq.arcSources.find(y => y.id === a.sourceId);
      if (x) usedArcs.add(x.id); else report.danglingReferences.push(`Этап №${step.order}: дуговой источник ${a.sourceId} отсутствовал в старом справочнике - перенесён без материала.`);
      source = { id, kind: 'arc', enabled: a.enabled, material: x?.cathodeMaterial, filtered: x?.filtered, currentA: a.currentA, startMin: a.startMin, durationMin: a.durationMin, mode: a.mode };
    }
    sources.push(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined)) as unknown as StepSource);
  }
  for (const a of step.gasAssignments) {
    const line = eq.gasLines.find(l => l.id === a.lineId);
    if (line) usedLines.add(line.id); else report.danglingReferences.push(`Этап №${step.order}: газовая линия ${a.lineId} отсутствовала в старом справочнике - перенесена без названия газа.`);
    const id = gases.some(g => g.id === a.lineId) ? nextId('gas', gases) : a.lineId;
    const gas: StepGas = { id, enabled: a.enabled, gas: line?.gas ?? '', flowSccm: a.flowSccm, startMin: a.startMin, durationMin: a.durationMin };
    gases.push(Object.fromEntries(Object.entries(gas).filter(([, v]) => v !== undefined)) as unknown as StepGas);
  }
  return { sources, gases, usedMagnetrons, usedArcs, usedLines };
}

/** Every non-empty old field of a step as a LegacyField (name, label, value). `sources` / `gases` are the resolved
 *  assignments in the shape of schema 4. */
function oldFields(step: V3Step, resolved: Resolved): LegacyField[] {
  const out: LegacyField[] = [];
  const add = (key: string, value: LegacyValue | undefined) => { if (value !== undefined) out.push({ key, label: FIELD_LABELS[key] ?? key, value }); };
  add('description', step.description?.trim() ? step.description : undefined);
  add('durationMin', step.durationMin);
  add('temperatureC', step.temperatureC);
  add('pressurePa', step.pressurePa);
  add('substrateBiasV', step.substrateBiasV);
  add('rotationRpm', step.rotationRpm);
  add('distanceMm', step.distanceMm);
  add('powerW', step.powerW);
  add('currentA', step.currentA);
  add('sourceConfiguration', step.sourceConfiguration?.trim() ? step.sourceConfiguration : undefined);
  add('gasUsage', step.gasUsage.length > 0 ? clean(step.gasUsage) : undefined);
  add('notes', step.notes?.trim() ? step.notes : undefined);
  add('acceptanceCriteria', step.acceptanceCriteria?.trim() ? step.acceptanceCriteria : undefined);
  add('sources', resolved.sources.length > 0 ? clean(resolved.sources) : undefined);
  add('gases', resolved.gases.length > 0 ? clean(resolved.gases) : undefined);
  return out;
}

/** Equipment worth keeping: anything that carries information not already in a card. */
function legacyEquipmentOf(v3: V3Document, used: { magnetrons: Set<string>; arcs: Set<string>; lines: Set<string> }): LegacyEquipment | undefined {
  const eq = v3.equipment;
  const magnetrons = withUniqueIds(eq.magnetrons, 'magnetron').filter(m => !used.magnetrons.has(m.id) || m.powerW !== undefined || !m.enabled);
  const arcSources = withUniqueIds(eq.arcSources, 'arc').filter(a => !used.arcs.has(a.id) || a.arcCurrentA !== undefined || !a.enabled);
  const gasLines = withUniqueIds(eq.gasLines, 'gas').filter(l => {
    const meaningful = l.gas.trim() !== '' || l.flow !== undefined || l.enabled;
    return meaningful && (!used.lines.has(l.id) || l.flow !== undefined || !l.enabled || l.unit.trim().toLowerCase() !== 'sccm');
  });
  const icpRf = eq.icpRf.enabled || eq.icpRf.powerW !== undefined || eq.icpRf.biasV !== undefined ? eq.icpRf : { enabled: false };
  const ionSource = eq.ionSource.enabled || eq.ionSource.voltageV !== undefined || eq.ionSource.currentA !== undefined || eq.ionSource.powerW !== undefined ? eq.ionSource : { enabled: false };
  const any = magnetrons.length > 0 || arcSources.length > 0 || gasLines.length > 0 || icpRf.enabled || icpRf.powerW !== undefined || icpRf.biasV !== undefined
    || ionSource.enabled || ionSource.voltageV !== undefined || ionSource.currentA !== undefined || ionSource.powerW !== undefined;
  return any ? { magnetrons, arcSources, icpRf: { ...icpRf }, ionSource: { ...ionSource }, gasLines } : undefined;
}

function sameCheck(a: QualityCheck, b: QualityCheck): boolean {
  return norm(a.parameter) === norm(b.parameter) && norm(a.method) === norm(b.method) && norm(a.criterion) === norm(b.criterion);
}

export function migrateV3Document(v3: V3Document, fromSchema: number): { document: TechnicalProcessDocument; report: MigrationReport } {
  assertNoAmbiguousReferences(v3);
  const report: MigrationReport = {
    fromSchema, steps: 0, legacyFields: 0, legacySteps: [], qualityResidualSteps: [], disabledQualitySteps: [], remappedTypes: [], qualityChecksCreated: 0, qualityChecksSkippedAsDuplicate: 0,
    emptyStepsDropped: 0, sourcesMigrated: 0, gasLinesMigrated: 0, equipmentKept: false, danglingReferences: [],
  };
  const steps: ProcessStep[] = [];
  const stepFields: LegacyStepFields[] = [];
  const legacySteps: LegacyStep[] = [];
  // ids of existing checks are reserved first (a repeated or empty id is repaired); migrated checks get ids that cannot collide with them
  const qualityChecks: QualityCheck[] = withUniqueIds(v3.qualityChecks.map(q => ({ ...q })), 'qc');
  const used = { magnetrons: new Set<string>(), arcs: new Set<string>(), lines: new Set<string>() };

  for (const old of v3.steps) {
    const resolved = resolveAssignments(old, v3, report);
    resolved.usedMagnetrons.forEach(id => used.magnetrons.add(id));
    resolved.usedArcs.forEach(id => used.arcs.add(id));
    resolved.usedLines.forEach(id => used.lines.add(id));
    const fields = oldFields(old, resolved);
    const target = TYPE_MAP[old.type];

    if (target === 'quality') {
      // A SWITCHED-OFF quality step is not an active check: it is kept whole (still off) as a legacy step the user can bring back.
      if (!old.enabled) {
        if (fields.length === 0) { report.emptyStepsDropped += 1; continue; }
        legacySteps.push({ id: `legacy-step-${legacySteps.length + 1}`, originalOrder: old.order, name: old.name, originalType: old.type, enabled: false, fields });
        report.disabledQualitySteps.push(old.name);
        continue;
      }
      // The text goes into the check as it is (nothing trimmed or cut). "Примечание" is appended to the method only while the whole method still fits
      // the stored-text limit; otherwise the note stays as a legacy field of the step - the limit would make the saved document unreadable.
      const description = old.description?.trim() ? old.description : undefined;
      const noteText = old.notes?.trim() ? old.notes : undefined;
      const withNote = noteText !== undefined ? [description, `Примечание: ${noteText}`].filter(Boolean).join('\n') : description;
      const noteFits = withNote !== undefined && withNote.length <= MAX_LONG_TEXT;
      const method = noteFits ? withNote : description;
      const criterion = old.acceptanceCriteria?.trim() ? old.acceptanceCriteria : undefined;
      const created: QualityCheck | undefined = method !== undefined || criterion !== undefined
        ? { id: '', parameter: old.name.trim() ? old.name : 'Контроль качества', ...(method !== undefined ? { method } : {}), ...(criterion !== undefined ? { criterion } : {}) }
        : undefined;
      if (created) {
        if (qualityChecks.some(q => sameCheck(q, created))) report.qualityChecksSkippedAsDuplicate += 1;
        else { qualityChecks.push({ ...created, id: nextId('qc', qualityChecks) }); report.qualityChecksCreated += 1; }
      }
      // Whatever the check has no place for (duration, temperature, a note that did not fit, ...) is kept: it is not duplicated in D.
      const inCheck = new Set(['description', 'acceptanceCriteria', ...(noteFits || noteText === undefined ? ['notes'] : [])]);
      const residual = fields.filter(f => !inCheck.has(f.key));
      if (residual.length > 0) {
        legacySteps.push({ id: `legacy-step-${legacySteps.length + 1}`, originalOrder: old.order, name: old.name, originalType: old.type, enabled: true, fields: residual });
        report.qualityResidualSteps.push(old.name);
      } else if (!created) report.emptyStepsDropped += 1;
      continue;
    }

    if (target === 'legacy') {
      const isEmpty = fields.length === 0 && old.name.trim() === V3_DEFAULT_LABELS[old.type];
      if (isEmpty) { report.emptyStepsDropped += 1; continue; }
      legacySteps.push({ id: `legacy-step-${legacySteps.length + 1}`, originalOrder: old.order, name: old.name, originalType: old.type, enabled: old.enabled, fields });
      report.legacySteps.push({ name: old.name, originalType: old.type });
      continue;
    }

    const type = target;
    const spec = STEP_TYPE_SPECS[type];
    const id = nextId('step', steps);
    let step: ProcessStep = { ...createStep(type, old.name, old.origin, id), order: steps.length + 1, enabled: old.enabled };
    if (type !== old.type) report.remappedTypes.push({ order: step.order, name: old.name, from: old.type, to: type });

    // The general gas list becomes real gas lines only where the card has gas lines AND the step has no gas assignments (otherwise the
    // two would double count and the old note "not equivalent" would be lost): then it stays as a legacy field.
    let work = fields;
    const unitCanHaveGas = spec.gases || spec.layers;
    let gasFromUsage: StepGas[] = [];
    if (unitCanHaveGas && old.gasAssignments.length === 0 && old.gasUsage.length > 0) {
      gasFromUsage = old.gasUsage.map((g, i) => ({ id: `gas-${i + 1}`, enabled: true, gas: g.gas, ...(g.flowSccm !== undefined ? { flowSccm: g.flowSccm } : {}) }));
      work = work.filter(f => f.key !== 'gasUsage');
    }
    const gases = [...resolved.gases, ...gasFromUsage];
    const sources = resolved.sources;

    let leftovers: LegacyField[];
    if (spec.layers) {
      const rest = work.filter(f => f.key !== 'sources' && f.key !== 'gases');
      const descriptionField = rest.find(f => f.key === 'description');
      if (descriptionField && typeof descriptionField.value === 'string') step.description = descriptionField.value;
      const hasContent = rest.some(f => f.key !== 'description') || sources.length > 0 || gases.length > 0;
      const single = old.type !== 'multilayer_coating';
      if (hasContent || single) {
        const placed = placeLayerFields({ ...createLayer('layer-1'), sources, gases }, rest.filter(f => f.key !== 'description'));
        step.layers = [placed.layer];
        leftovers = placed.rest;
      } else leftovers = [];
      step.coatingMode = single ? 'single' : 'multi';
    } else {
      const rest = work.filter(f => f.key !== 'sources' && f.key !== 'gases');
      const placed = placeFields(step, rest);
      step = placed.step;
      leftovers = placed.rest;
      if (spec.sources) step.sources = sources; else if (sources.length > 0) leftovers.push({ key: 'sources', label: FIELD_LABELS.sources, value: clean(sources) });
      if (spec.gases) step.gases = gases; else if (gases.length > 0) leftovers.push({ key: 'gases', label: FIELD_LABELS.gases, value: clean(gases) });
    }
    const placedSources = spec.sources || spec.layers ? sources.length : 0;
    const placedGases = spec.gases || spec.layers ? gases.length : 0;
    report.sourcesMigrated += placedSources;
    report.gasLinesMigrated += placedGases;
    // The "calculated by the system" mark follows the FIELD it describes. For the coating card that is the duration of the layer the old values went into
    // (the card itself has no duration); a mark whose value is not in a field of the new card (it went to legacy) is not carried: nothing claims it.
    if (spec.layers) {
      step.calculatedFields = [];
      if (step.layers[0]?.durationMin !== undefined && old.calculatedFields.includes('durationMin')) step.layers = [{ ...step.layers[0], calculatedFields: ['durationMin'] }];
    } else {
      step.calculatedFields = old.calculatedFields.filter(f => (spec.fields as readonly string[]).includes(f) && (step as unknown as Record<string, unknown>)[f] !== undefined);
    }
    if (leftovers.length > 0) {
      stepFields.push({ stepId: step.id, stepName: step.name, fields: leftovers });
      report.legacyFields += leftovers.length;
    }
    steps.push(step);
  }

  const equipment = legacyEquipmentOf(v3, used);
  report.equipmentKept = equipment !== undefined;
  report.steps = steps.length;
  const legacy: LegacyData = { migratedFromSchema: fromSchema, stepFields, steps: legacySteps, ...(equipment ? { equipment } : {}) };
  const document: TechnicalProcessDocument = {
    schemaVersion: TECHDOC_SCHEMA_VERSION,
    pressureUnit: v3.pressureUnit,
    general: v3.general,
    initialData: v3.initialData,
    steps,
    qualityChecks,
    safety: v3.safety,
    legacy: hasLegacyData(legacy) ? legacy : { ...legacy, stepFields: [], steps: [] },
    traceability: v3.traceability,
  };
  return { document, report };
}

/** The user-facing summary of a migration, one short sentence per fact. */
export function describeMigration(report: MigrationReport): string[] {
  const lines = [`Документ был сохранён в схеме ${report.fromSchema} и преобразован в схему ${TECHDOC_SCHEMA_VERSION} только в памяти: сохранённая копия не изменена.`];
  if (report.sourcesMigrated + report.gasLinesMigrated > 0) lines.push(`Перенесено в карточки: источников — ${report.sourcesMigrated}, газовых линий — ${report.gasLinesMigrated}.`);
  for (const r of report.remappedTypes) lines.push(`Этап №${r.order} «${r.name}» (прежний тип «${V3_DEFAULT_LABELS[r.from as V3StepType] ?? r.from}») стал карточкой «${STEP_TYPE_LABELS[r.to]}» в однослойном режиме.`);
  if (report.qualityChecksCreated > 0) lines.push(`Из этапов «Контроль качества» создано проверок в разделе D: ${report.qualityChecksCreated}.`);
  if (report.qualityChecksSkippedAsDuplicate > 0) lines.push(`Совпадающих с существующими проверок не создано: ${report.qualityChecksSkippedAsDuplicate}.`);
  if (report.disabledQualitySteps.length > 0) lines.push(`Отключённые этапы контроля качества не стали действующими проверками: ${report.disabledQualitySteps.map(n => `«${n}»`).join(', ')} сохранены как данные прежней версии (отключёнными).`);
  if (report.qualityResidualSteps.length > 0) lines.push(`У этапов контроля качества, текст которых стал проверками раздела D, были и другие значения (длительность и т.п.) - они сохранены как данные прежней версии: ${report.qualityResidualSteps.map(n => `«${n}»`).join(', ')}.`);
  if (report.legacySteps.length > 0) lines.push(`Этапов, которым нет места среди восьми карточек, сохранено как данные прежней версии: ${report.legacySteps.length} (${report.legacySteps.map(s => `«${s.name}»`).join(', ')}). Их можно вернуть в процесс.`);
  if (report.legacyFields > 0) lines.push(`Полей прежней версии, у которых нет места в новых карточках, сохранено отдельно: ${report.legacyFields}. Их можно перенести в карточку.`);
  if (report.equipmentKept) lines.push('Прежний справочник оборудования (неиспользованные записи и номинальные значения) сохранён отдельно.');
  if (report.emptyStepsDropped > 0) lines.push(`Пустых этапов без данных не перенесено: ${report.emptyStepsDropped}.`);
  for (const d of report.danglingReferences) lines.push(d);
  return lines;
}

export { STEP_TYPES };
