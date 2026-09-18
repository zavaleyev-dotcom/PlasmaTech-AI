/** Real, local, dependency-free technological-documentation builder for PVD/CVD/PECVD/plasma
 *  processes - no external API, no LLM. This module never invents a technological parameter:
 *  every numeric/text field the user has not entered is rendered as "не задано" (or left
 *  `undefined` in the data model) rather than guessed, defaulted, or "corrected". Presets only
 *  create a stage SKELETON (step names/types/order) - they never pre-fill a pressure,
 *  temperature, power, gas, or acceptance criterion. See requirement 18 in the task spec this
 *  file implements: no silent parameter substitution, ever. */

import { solveDeposition, type ThicknessUnit, type RateUnit } from './engineering-calculators';

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
  pressureMbar?: number;
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
  /** Field names populated via an explicit calculation action (item 14) - empty until the user
   *  actually runs a calculation; never set implicitly. */
  calculatedFields: string[];
}

export function createStep(type: StepType, name?: string, origin: StepOrigin = 'user'): Omit<ProcessStep, 'order'> {
  return { name: name ?? STEP_TYPE_LABELS[type], type, enabled: true, gasUsage: [], origin, calculatedFields: [] };
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
  const copy: ProcessStep = { ...steps[index], gasUsage: steps[index].gasUsage.map(g => ({ ...g })), calculatedFields: [] };
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

export function updateStep(steps: ProcessStep[], order: number, patch: Partial<Omit<ProcessStep, 'order' | 'origin' | 'calculatedFields'>>): ProcessStep[] {
  return steps.map(step => step.order === order ? { ...step, ...patch, origin: 'user' } : step);
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

let sourceIdCounter = 0;
function nextSourceId(prefix: string): string { sourceIdCounter += 1; return `${prefix}-${sourceIdCounter}`; }

export function addMagnetron(sources: SourceSet): SourceSet {
  return { ...sources, magnetrons: [...sources.magnetrons, { id: nextSourceId('magnetron'), enabled: true }] };
}
export function removeMagnetron(sources: SourceSet, id: string): SourceSet {
  return { ...sources, magnetrons: sources.magnetrons.filter(m => m.id !== id) };
}
export function updateMagnetron(sources: SourceSet, id: string, patch: Partial<MagnetronSource>): SourceSet {
  return { ...sources, magnetrons: sources.magnetrons.map(m => m.id === id ? { ...m, ...patch } : m) };
}

export function addArcSource(sources: SourceSet): SourceSet {
  return { ...sources, arcSources: [...sources.arcSources, { id: nextSourceId('arc'), enabled: true, filtered: false }] };
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
  return [...lines, { id: `gas-${lines.length + 1}-${Date.now()}`, gas: '', unit: 'sccm', enabled: false }];
}
export function removeGasLine(lines: GasLine[], id: string): GasLine[] {
  return lines.filter(l => l.id !== id);
}
export function updateGasLine(lines: GasLine[], id: string, patch: Partial<GasLine>): GasLine[] {
  return lines.map(l => l.id === id ? { ...l, ...patch } : l);
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

// ---------- TechnicalProcessDocument (top level) ----------

export interface TechnicalProcessDocument {
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
  if (!doc.general.processName || !doc.general.processName.trim()) {
    throw new Error('Название процесса: обязательное поле, введите значение.');
  }

  const seenOrders = new Set<number>();
  for (const step of doc.steps) {
    if (seenOrders.has(step.order)) throw new Error(`Дублирующийся номер этапа: №${step.order}. Номера этапов должны быть уникальными.`);
    seenOrders.add(step.order);

    checkOptionalNonNegative(step.durationMin, `Этап №${step.order}: длительность`);
    checkOptionalFinite(step.temperatureC, `Этап №${step.order}: температура`);
    checkOptionalNonNegative(step.pressureMbar, `Этап №${step.order}: давление`);
    checkOptionalNonNegative(step.powerW, `Этап №${step.order}: мощность`);
    checkOptionalNonNegative(step.currentA, `Этап №${step.order}: ток`);
    checkOptionalFinite(step.substrateBiasV, `Этап №${step.order}: substrate bias`);
    checkOptionalFinite(step.rotationRpm, `Этап №${step.order}: вращение`);
    checkOptionalFinite(step.distanceMm, `Этап №${step.order}: расстояние`);
    for (const usage of step.gasUsage) checkOptionalNonNegative(usage.flowSccm, `Этап №${step.order}: расход газа (${usage.gas || 'без названия'})`);
  }

  for (const line of doc.gasSystem) checkOptionalNonNegative(line.flow, `Газовая линия ${line.gas || line.id}: расход`);

  for (const magnetron of doc.sources.magnetrons) checkOptionalNonNegative(magnetron.powerW, `Магнетрон ${magnetron.id}: мощность`);
  for (const arc of doc.sources.arcSources) checkOptionalNonNegative(arc.arcCurrentA, `Arc-источник ${arc.id}: ток дуги`);
  checkOptionalNonNegative(doc.sources.icpRf.powerW, 'ICP/RF: мощность');
  checkOptionalFinite(doc.sources.icpRf.biasV, 'ICP/RF: bias');
  checkOptionalFinite(doc.sources.ionSource.voltageV, 'Ion source: напряжение');
  checkOptionalNonNegative(doc.sources.ionSource.currentA, 'Ion source: ток');
  checkOptionalNonNegative(doc.sources.ionSource.powerW, 'Ion source: мощность');

  checkOptionalNonNegative(doc.initialData.partSizeMm, 'Размер изделия');
  checkOptionalNonNegative(doc.initialData.quantity, 'Количество');
  checkOptionalNonNegative(doc.initialData.requiredThicknessUm, 'Требуемая толщина');
  checkOptionalFinite(doc.initialData.allowedTemperatureC, 'Допустимая температура');
}

// ---------- formatting helper: never invent a value, always show "не задано" / "—" ----------

const NOT_SET = 'не задано';
const DASH = '—';

function fmtNum(value: number | undefined, unit: string, dash = false): string {
  if (value === undefined) return dash ? DASH : NOT_SET;
  return `${value}${unit}`;
}
function fmtStr(value: string | undefined, dash = false): string {
  if (value === undefined || value === '') return dash ? DASH : NOT_SET;
  return value;
}
function fmtGases(usage: GasUsage[]): string {
  if (usage.length === 0) return DASH;
  return usage.map(u => `${u.gas || NOT_SET}${u.flowSccm !== undefined ? ` (${u.flowSccm} см³/мин)` : ''}`).join(', ');
}
function fmtSourcePower(step: ProcessStep): string {
  const parts: string[] = [];
  if (step.sourceConfiguration) parts.push(step.sourceConfiguration);
  if (step.powerW !== undefined) parts.push(`${step.powerW} Вт`);
  if (step.currentA !== undefined) parts.push(`${step.currentA} А`);
  return parts.length > 0 ? parts.join(', ') : DASH;
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
    lines.push(`- Давление: ${fmtNum(step.pressureMbar, ' мбар')}`);
    lines.push(`- Газы: ${fmtGases(step.gasUsage)}`);
    lines.push(`- Источник/мощность: ${fmtSourcePower(step)}`);
    lines.push(`- Substrate bias: ${fmtNum(step.substrateBiasV, ' В')}`);
    lines.push(`- Вращение: ${fmtNum(step.rotationRpm, ' об/мин')}`);
    lines.push(`- Расстояние: ${fmtNum(step.distanceMm, ' мм')}`);
    lines.push(`- Критерий приёмки: ${fmtStr(step.acceptanceCriteria)}`);
    if (step.notes) lines.push(`- Примечание: ${step.notes}`);
  }
  lines.push('');
  lines.push('## F. Контроль качества');
  if (doc.qualityChecks.length === 0) lines.push(NOT_SET);
  for (const qc of doc.qualityChecks) {
    lines.push(`- ${qc.parameter}: метод — ${fmtStr(qc.method)}, критерий — ${fmtStr(qc.criterion)}, результат — ${fmtStr(qc.result)}, статус — ${fmtStr(qc.status)}`);
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

export function buildTechnologicalCard(doc: TechnicalProcessDocument): TechCardRow[] {
  return doc.steps.map(step => ({
    number: step.order,
    operation: step.enabled ? step.name : `${step.name} (отключён)`,
    duration: fmtNum(step.durationMin, ' мин', true),
    temperature: fmtNum(step.temperatureC, '°C', true),
    pressure: fmtNum(step.pressureMbar, ' мбар', true),
    gases: fmtGases(step.gasUsage),
    sourcePower: fmtSourcePower(step),
    bias: fmtNum(step.substrateBiasV, ' В', true),
    control: fmtStr(step.acceptanceCriteria, true),
    note: fmtStr(step.notes, true),
  }));
}

export interface RouteCardRow {
  number: number; stage: string; equipment: string; input: string; operation: string; output: string; control: string;
}

export function buildRouteCard(doc: TechnicalProcessDocument): RouteCardRow[] {
  const equipment = fmtStr(doc.general.equipment, true);
  return doc.steps.map((step, index) => ({
    number: step.order,
    stage: STEP_TYPE_LABELS[step.type],
    equipment,
    input: index === 0 ? 'Исходное изделие' : `результат операции №${doc.steps[index - 1].order}`,
    operation: step.enabled ? step.name : `${step.name} (отключён)`,
    output: index === doc.steps.length - 1 ? 'Готовое изделие' : `на операцию №${doc.steps[index + 1].order}`,
    control: step.type === 'quality_control' ? 'см. раздел «Контроль качества»' : fmtStr(step.acceptanceCriteria, true),
  }));
}

export function buildBriefRecipe(doc: TechnicalProcessDocument): string {
  const lines: string[] = [`# Краткий рецепт: ${fmtStr(doc.general.processName)}`];
  for (const step of doc.steps) {
    if (!step.enabled) continue;
    const parts = [
      step.temperatureC !== undefined ? `T: ${step.temperatureC}°C` : null,
      step.pressureMbar !== undefined ? `P: ${step.pressureMbar} мбар` : null,
      step.durationMin !== undefined ? `t: ${step.durationMin} мин` : null,
      step.powerW !== undefined ? `W: ${step.powerW} Вт` : null,
    ].filter(Boolean);
    lines.push(`${step.order}. ${step.name} — ${parts.length ? parts.join(', ') : NOT_SET}`);
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
        ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход', 'Контроль'],
        routeCard.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output, r.control]),
      ),
      briefRecipe: buildBriefRecipe(doc),
    },
  };
}
