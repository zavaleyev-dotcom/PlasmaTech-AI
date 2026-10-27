/** Local, dependency-bounded DOCX/PDF export for TechDoc Assistant documents. No LLM, no
 *  network call, no cloud converter - files are generated entirely server-side with `docx`
 *  (OOXML) and `pdfkit` (+ an embedded Cyrillic-capable TTF font, since PDFKit's built-in
 *  standard fonts have no Cyrillic glyphs). Every value shown here comes straight from
 *  `TechnicalProcessDocument` - nothing is invented; an absent field renders as "не задано"
 *  (prose) or "—" (table cell), exactly like the existing on-screen preview. */

import 'server-only';
import {
  validateDocument, buildTechnologicalCard, buildRouteCard, buildBriefRecipe, formatPressure, buildStepAssignmentLines,
  sourceAssignmentFields, gasAssignmentFields, cardDetailHeading, hasLongSourceList, hasLongGasList,
  PRESSURE_UNIT_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING,
  type TechnicalProcessDocument, type PressureUnit,
} from './techdoc-assistant';
import { CARD_COLUMN_WEIGHTS, SOURCE_DETAIL_WEIGHTS, GAS_DETAIL_WEIGHTS, CARD_CELL_LINE_BUDGET, CONTINUATION_CELL, splitTallRows } from './techdoc-card-layout';
import {
  DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, FILENAME_SEGMENT,
  type DocumentType, type ExportFormat,
} from './techdoc-export-types';
import { renderGenericDocx, renderGenericPdf, sanitizeFilenameSegment, type GenericDocumentViewModel } from './document-export';

export { DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, sanitizeFilenameSegment, type DocumentType, type ExportFormat };

const NOT_SET = 'не задано';

function show(value: string | undefined): string {
  return value !== undefined && value.trim() !== '' ? value : NOT_SET;
}
function showNum(value: number | undefined, unit: string): string {
  return value === undefined ? NOT_SET : `${value}${unit}`;
}

export function buildExportFilename(doc: TechnicalProcessDocument, documentType: DocumentType, format: ExportFormat): string {
  const process = sanitizeFilenameSegment(doc.general.processName, 'process');
  return `${process}_${FILENAME_SEGMENT[documentType]}_v${doc.traceability.version}.${format}`;
}

// ---------- DocumentViewModel (item 4): the ONE normalized layer both DOCX and PDF render from ----------

export interface ViewModelSection { heading: string; paragraphs: string[] }
export interface ViewModelTable { heading: string; columns: string[]; rows: string[][]; columnWeights?: number[] }
export interface ViewModelMetadataItem { label: string; value: string }
export interface ViewModelQualityCheck { parameter: string; method: string; criterion: string; unit: string; result: string; status: string }
export interface ViewModelTraceability { version: string; createdAt: string; updatedAt: string; processName: string; source: string; calculatedFieldsNote: string }

export interface DocumentViewModel {
  documentType: DocumentType;
  title: string;
  metadata: ViewModelMetadataItem[];
  sections: ViewModelSection[];
  tables: ViewModelTable[];
  warnings: string[];
  qualityChecks: ViewModelQualityCheck[];
  traceability: ViewModelTraceability;
  traceabilityHeading: string;
  footer: string;
}

function buildSafetyLines(doc: TechnicalProcessDocument): string[] {
  const lines: string[] = [];
  if (doc.safety.hazards.length) lines.push(`Опасности: ${doc.safety.hazards.join(', ')}`);
  if (doc.safety.ppe.length) lines.push(`СИЗ: ${doc.safety.ppe.join(', ')}`);
  if (doc.safety.interlocks.length) lines.push(`Блокировки: ${doc.safety.interlocks.join(', ')}`);
  if (doc.safety.gasSafety) lines.push(`Газовая безопасность: ${doc.safety.gasSafety}`);
  if (doc.safety.vacuumSafety) lines.push(`Вакуумная безопасность: ${doc.safety.vacuumSafety}`);
  if (doc.safety.highVoltage) lines.push(`Высокое напряжение: ${doc.safety.highVoltage}`);
  if (doc.safety.hotSurfaces) lines.push(`Горячие поверхности: ${doc.safety.hotSurfaces}`);
  if (doc.safety.notes) lines.push(`Примечания: ${doc.safety.notes}`);
  return lines;
}

function buildTraceability(doc: TechnicalProcessDocument): ViewModelTraceability {
  const calculated = doc.steps.filter(s => s.calculatedFields.length > 0).map(s => `№${s.order} (${s.calculatedFields.join(', ')})`);
  return {
    version: String(doc.traceability.version),
    createdAt: doc.traceability.createdAt,
    updatedAt: doc.traceability.updatedAt,
    processName: show(doc.general.processName),
    source: doc.traceability.source === 'blank' ? 'создан с чистого листа' : `preset: ${doc.traceability.source}`,
    calculatedFieldsNote: calculated.length > 0 ? `Вычислено системой: ${calculated.join('; ')}` : 'Полей, вычисленных системой, нет.',
  };
}

function buildMetadata(doc: TechnicalProcessDocument): ViewModelMetadataItem[] {
  const g = doc.general;
  return [
    { label: 'Процесс', value: show(g.processName) },
    { label: 'Оборудование', value: show(g.equipment) },
    { label: 'Установка/модель', value: show(g.installationModel) },
    { label: 'Материал подложки', value: show(g.substrateMaterial) },
    { label: 'Тип изделия', value: show(g.productType) },
    { label: 'Материал покрытия/обработки', value: show(g.coatingMaterial) },
    { label: 'Ответственный/подразделение', value: show(g.responsible) },
    { label: 'Версия документа', value: show(g.documentVersion) },
    { label: 'Дата', value: show(g.date) },
  ];
}

function buildQualityChecks(doc: TechnicalProcessDocument): ViewModelQualityCheck[] {
  return doc.qualityChecks.map(qc => ({
    parameter: qc.parameter, method: show(qc.method), criterion: show(qc.criterion),
    unit: show(qc.unit), result: show(qc.result), status: show(qc.status),
  }));
}

/** Document-LEVEL source/gas-system configuration (magnetrons, arc sources, ICP/RF, ion
 *  source, gas lines) - distinct from each step's own gasUsage/sourceConfiguration free text.
 *  Previously this never appeared anywhere in the printed instruction (Codex regression: a
 *  configured magnetron material/power or gas line was silently absent from the document). */
function sourceAndGasSummary(doc: TechnicalProcessDocument): string[] {
  const src = doc.sources;
  const lines: string[] = [];
  if (src.magnetrons.length === 0) lines.push(`Магнетроны: ${NOT_SET}`);
  for (const m of src.magnetrons) lines.push(`Магнетрон ${m.id} (в установке: ${m.enabled ? 'доступен' : 'отключён'}): материал — ${show(m.material)}, мощность — ${showNum(m.powerW, ' Вт')}, режим — ${show(m.mode)}`);
  if (src.arcSources.length === 0) lines.push(`Arc-источники: ${NOT_SET}`);
  for (const a of src.arcSources) lines.push(`Arc-источник ${a.id} (в установке: ${a.enabled ? 'доступен' : 'отключён'}${a.filtered ? ', фильтрованный' : ''}): материал катода — ${show(a.cathodeMaterial)}, ток дуги — ${showNum(a.arcCurrentA, ' А')}`);
  lines.push(`ICP/RF: ${src.icpRf.enabled ? `включён, мощность — ${showNum(src.icpRf.powerW, ' Вт')}, bias — ${showNum(src.icpRf.biasV, ' В')}` : 'не используется'}`);
  lines.push(`Ion source: ${src.ionSource.enabled ? `включён, напряжение — ${showNum(src.ionSource.voltageV, ' В')}, ток — ${showNum(src.ionSource.currentA, ' А')}, мощность — ${showNum(src.ionSource.powerW, ' Вт')}` : 'не используется'}`);
  if (doc.gasSystem.length === 0) lines.push(`Газовая система: ${NOT_SET}`);
  for (const line of doc.gasSystem) lines.push(`Газовая линия ${line.id} (в системе: ${line.enabled ? 'включена' : 'отключена'}): газ — ${show(line.gas)}, расход (справочно) — ${showNum(line.flow, ` ${line.unit}`)}`);
  return lines;
}

/** The step's free-text description, exactly as typed - line breaks, units and technical
 *  designations untouched (the renderers turn each "\n" into a real line break). It is shown in
 *  the on-screen instruction preview (buildInstructionView) and must reach the printed document
 *  too; a step without a description adds nothing, same as the preview. */
function stepDescriptionBlock(step: TechnicalProcessDocument['steps'][number]): string {
  return step.description && step.description.trim() !== '' ? `\nОписание: ${step.description}` : '';
}

/** Every source and gas-line assignment of the step - ON/OFF, material (from D), power/current,
 *  time window, mode, flow - one line each, from the same builder the on-screen preview uses. */
function stepAssignmentBlock(doc: TechnicalProcessDocument, step: TechnicalProcessDocument['steps'][number]): string {
  const { sources, gases, notes, warnings } = buildStepAssignmentLines(doc, step);
  const out: string[] = [];
  if (sources.length > 0) out.push('Источники на этапе (из раздела D):', ...sources.map(text => `• ${text}`));
  if (gases.length > 0) out.push('Газовые линии на этапе (из раздела E):', ...gases.map(text => `• ${text}`));
  out.push(...notes);
  if (warnings.length > 0) out.push('Замечания к данным этапа:', ...warnings.map(text => `• ${text}`));
  return out.length > 0 ? `\n${out.join('\n')}` : '';
}

/** A card cell holds the step's general values AND all its source/gas assignments (full text).
 *  The note says so, and states what "последовательно" means, so the table is not read as less
 *  (or more) than it is. Absent when no step carries assignments. */
/** One table per step that has a long source or gas list: every assignment is its OWN short row, and every
 *  row repeats the step number and name - so a table that runs onto further pages (the column header is
 *  repeated by the renderer) never separates a value from the step it belongs to. */
function cardDetailTables(doc: TechnicalProcessDocument): ViewModelTable[] {
  const tables: ViewModelTable[] = [];
  for (const step of doc.steps) {
    const stepName = step.enabled ? step.name : `${step.name} (отключён)`;
    if (hasLongSourceList(doc, step)) {
      const rows = step.sourceAssignments.map(a => {
        const f = sourceAssignmentFields(doc, a);
        return [String(step.order), stepName, f.source, f.material, f.state, f.value, f.time, f.mode];
      });
      tables.push({
        heading: cardDetailHeading(step, 'sources'),
        columns: ['№ этапа', 'Этап', 'Источник', 'Материал', 'Состояние', 'Мощность / ток', 'Время', 'Режим'],
        columnWeights: [...SOURCE_DETAIL_WEIGHTS],
        rows: splitTallRows(rows, SOURCE_DETAIL_WEIGHTS, [0, 1, 2]),
      });
    }
    if (hasLongGasList(doc, step)) {
      const rows = step.gasAssignments.map(a => {
        const f = gasAssignmentFields(doc, a);
        return [String(step.order), stepName, f.line, f.gas, f.state, f.flow, f.time];
      });
      tables.push({
        heading: cardDetailHeading(step, 'gases'),
        columns: ['№ этапа', 'Этап', 'Линия', 'Газ', 'Состояние', 'Расход', 'Время подачи'],
        columnWeights: [...GAS_DETAIL_WEIGHTS],
        rows: splitTallRows(rows, GAS_DETAIL_WEIGHTS, [0, 1, 2]),
      });
    }
  }
  return tables;
}

function cardNotes(doc: TechnicalProcessDocument, split: boolean): ViewModelSection[] {
  const withAssignments = doc.steps.filter(step => step.sourceAssignments.length > 0 || step.gasAssignments.length > 0);
  const anyLong = doc.steps.some(step => hasLongSourceList(doc, step) || hasLongGasList(doc, step));
  const paragraphs: string[] = [];
  if (withAssignments.length > 0) {
    paragraphs.push(`В колонках «Источник/мощность» и «Газы» через «;» перечислены общие значения этапа и все назначения источников и газовых линий данного этапа${anyLong ? ' (кроме этапов с длинными перечнями - см. ниже)' : ''}.`);
    if (doc.steps.some(step => step.sourceAssignments.some(a => a.enabled && a.mode === 'sequential'))) paragraphs.push(`Последовательный режим: ${SEQUENTIAL_MODE_MEANING}.`);
    if (anyLong) {
      paragraphs.push(`Для этапов, у которых перечень назначений источников или газовых линий слишком велик для одной ячейки карты (более ${CARD_CELL_LINE_BUDGET} строк текста в колонке), в таблице карты указано только число назначений; полный перечень (каждое назначение отдельной строкой с номером и названием этапа) приведён в таблицах «Этап №…: источники» и «Этап №…: газовые линии» ниже. Ничего не опущено.`);
    }
    paragraphs.push(unitsNote(doc));
  }
  if (split) {
    paragraphs.push(`Значение, не помещающееся на одной странице, разбито на части «[k/n]» в нескольких строках: каждая строка повторяет номер и название этапа (и источник или линию); «${CONTINUATION_CELL}» означает, что значение указано в первой строке. Части идут по порядку и являются непрерывными фрагментами исходного значения; маркер «[k/n] » (скобки, дробь и один пробел) - только нумерация: чтобы получить исходное значение, отбросьте этот префикс у каждой части и соедините части подряд, ничего не добавляя. Ничего не опущено.`);
  }
  return paragraphs.length > 0 ? [{ heading: 'Примечание', paragraphs }] : [];
}

function unitsNote(doc: TechnicalProcessDocument): string {
  return `Единицы: давление — ${PRESSURE_UNIT_LABELS[doc.pressureUnit]} (хранится в паскалях); расход газа — ${SCCM_MEANING}.`;
}

function stepParagraph(doc: TechnicalProcessDocument, step: TechnicalProcessDocument['steps'][number], unit: PressureUnit): string {
  const gases = step.gasUsage.length > 0
    ? step.gasUsage.map(g => `${g.gas || NOT_SET}${g.flowSccm !== undefined ? ` (${g.flowSccm} sccm)` : ''}`).join(', ')
    : NOT_SET;
  const source = [step.sourceConfiguration, step.powerW !== undefined ? `${step.powerW} Вт` : null, step.currentA !== undefined ? `${step.currentA} А` : null]
    .filter((part): part is string => Boolean(part)).join(', ') || NOT_SET;
  return `№${step.order}. ${step.name}${!step.enabled ? ' (отключён)' : ''} — длительность: ${showNum(step.durationMin, ' мин')}; `
    + `температура: ${showNum(step.temperatureC, '°C')}; давление: ${formatPressure(step.pressurePa, unit)}; газы: ${gases}; `
    + `источник/мощность: ${source}; bias: ${showNum(step.substrateBiasV, ' В')}; вращение: ${showNum(step.rotationRpm, ' об/мин')}; `
    + `расстояние: ${showNum(step.distanceMm, ' мм')}; критерий приёмки: ${show(step.acceptanceCriteria)}; примечание: ${show(step.notes)}`
    + stepAssignmentBlock(doc, step)
    + stepDescriptionBlock(step);
}

export function buildDocumentViewModel(doc: TechnicalProcessDocument, documentType: DocumentType): DocumentViewModel {
  validateDocument(doc);
  const g = doc.general;
  const metadata = buildMetadata(doc);
  const warnings = buildSafetyLines(doc);
  const qualityChecks = buildQualityChecks(doc);
  const traceability = buildTraceability(doc);
  const footer = `${DOCUMENT_TYPE_LABELS[documentType]} • ${show(g.processName)} • версия ${doc.traceability.version}`;

  if (documentType === 'technologicalCard') {
    const rows = buildTechnologicalCard(doc, { compactLongLists: true });
    const tables: ViewModelTable[] = [{
      heading: DOCUMENT_TYPE_LABELS.technologicalCard,
      columns: ['№', 'Операция', 'Время', 'Температура', 'Давление', 'Газы', 'Источник/мощность', 'Bias', 'Контроль', 'Примечание'],
      // The Gases and Source/power cells carry every assignment of the step in full, so they get most of the width.
      columnWeights: [...CARD_COLUMN_WEIGHTS],
      // A free-text cell (acceptance criterion, note) too long for one page is split into marked continuation rows.
      rows: splitTallRows(rows.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sourcePower, r.bias, r.control, r.note]), CARD_COLUMN_WEIGHTS, [0, 1]),
    }, ...cardDetailTables(doc)];
    const split = tables.some(t => t.rows.some(row => row.includes(CONTINUATION_CELL)));
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.technologicalCard}: ${show(g.processName)}`, metadata, sections: cardNotes(doc, split), tables,
      warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  if (documentType === 'routeCard') {
    const rows = buildRouteCard(doc);
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.routeCard}: ${show(g.processName)}`, metadata, sections: [],
      tables: [{ heading: DOCUMENT_TYPE_LABELS.routeCard, columns: ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход', 'Контроль', 'Примечание'],
        rows: rows.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output, r.control, r.note]) }],
      warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  if (documentType === 'recipe') {
    const lines = buildBriefRecipe(doc).split('\n').slice(1);
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.recipe}: ${show(g.processName)}`, metadata,
      sections: [{ heading: DOCUMENT_TYPE_LABELS.recipe, paragraphs: lines.length > 0 ? lines : [NOT_SET] }],
      tables: [], warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  // instruction (item 5): the dedicated, more granular 10-section structure
  const d = doc.initialData;
  const sections: ViewModelSection[] = [
    { heading: '1. Общие сведения', paragraphs: [
      `Материал подложки: ${show(g.substrateMaterial)}`,
      `Тип изделия: ${show(g.productType)}`,
      `Материал покрытия/обработки: ${show(g.coatingMaterial)}`,
      `Ответственный/подразделение: ${show(g.responsible)}`,
      `Версия документа: ${show(g.documentVersion)}`,
      `Дата: ${show(g.date)}`,
    ] },
    { heading: '2. Назначение процесса', paragraphs: [show(g.purpose)] },
    { heading: '3. Оборудование', paragraphs: [`Оборудование: ${show(g.equipment)}`, `Установка/модель: ${show(g.installationModel)}`] },
    { heading: '4. Исходные данные', paragraphs: [
      `Размер изделия: ${showNum(d.partSizeMm, ' мм')}`,
      `Количество: ${showNum(d.quantity, '')}`,
      `Исходное состояние поверхности: ${show(d.initialSurfaceCondition)}`,
      `Требования к чистоте: ${show(d.cleanlinessRequirement)}`,
    ] },
    { heading: '5. Требования к изделию', paragraphs: [
      `Требования к покрытию/обработке: ${show(d.coatingRequirement)}`,
      `Требуемая толщина: ${showNum(d.requiredThicknessUm, ' мкм')}`,
      `Допустимая температура: ${showNum(d.allowedTemperatureC, '°C')}`,
      `Дополнительные требования: ${show(d.additionalRequirements)}`,
    ] },
    { heading: '6. Последовательность операций', paragraphs: doc.steps.length > 0
      ? doc.steps.map(s => `№${s.order}. ${s.name}${!s.enabled ? ' (отключён)' : ''}`)
      : [NOT_SET] },
    { heading: '7. Параметры процесса', paragraphs: [...sourceAndGasSummary(doc), ...(doc.steps.length > 0 ? doc.steps.map(s => stepParagraph(doc, s, doc.pressureUnit)) : [NOT_SET]), unitsNote(doc)] },
    { heading: '8. Контроль качества', paragraphs: qualityChecks.length > 0 ? [`Определено параметров контроля: ${qualityChecks.length}. См. таблицу ниже.`] : [NOT_SET] },
    { heading: '9. Требования безопасности', paragraphs: warnings.length > 0 ? warnings : [NOT_SET] },
  ];

  return {
    documentType, title: `${DOCUMENT_TYPE_LABELS.instruction}: ${show(g.processName)}`, metadata, sections,
    tables: qualityChecks.length > 0 ? [{ heading: 'Контроль качества', columns: ['Параметр', 'Метод', 'Критерий', 'Единица', 'Результат', 'Статус'],
      rows: qualityChecks.map(qc => [qc.parameter, qc.method, qc.criterion, qc.unit, qc.result, qc.status]) }] : [],
    warnings, qualityChecks, traceability, traceabilityHeading: '10. Traceability / версия документа', footer,
  };
}

// ---------- generic-renderer mapping: this ViewModel -> document-export.ts's shared shape ----------

/** Maps TechDoc's own (richer) DocumentViewModel onto the generic shape the shared renderer
 *  (document-export.ts) actually consumes - `warnings`/`qualityChecks` are NOT included here
 *  because renderGenericDocx/Pdf never read them either; both already get folded into
 *  `sections`/`tables` at buildDocumentViewModel() time. */
function toGenericViewModel(viewModel: DocumentViewModel): GenericDocumentViewModel {
  const t = viewModel.traceability;
  return {
    title: viewModel.title,
    metadata: viewModel.metadata,
    sections: viewModel.sections,
    tables: viewModel.tables,
    traceability: [
      { label: 'Процесс', value: t.processName },
      { label: 'Версия', value: t.version },
      { label: 'Создан', value: t.createdAt },
      { label: 'Обновлён', value: t.updatedAt },
      { label: 'Источник', value: t.source },
      { label: 'Примечание', value: t.calculatedFieldsNote },
    ],
    traceabilityHeading: viewModel.traceabilityHeading,
    footer: viewModel.footer,
  };
}

function renderOptionsFor(documentType: DocumentType) {
  return {
    layout: (documentType === 'technologicalCard' || documentType === 'routeCard' ? 'landscape' : 'portrait') as 'landscape' | 'portrait',
    pageBreakAfterMetadata: documentType === 'instruction',
  };
}

// ---------- top-level export entry point ----------

export interface ExportResult { buffer: Buffer; filename: string; contentType: string }

const CONTENT_TYPE: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export async function exportTechDoc(doc: TechnicalProcessDocument, documentType: DocumentType, format: ExportFormat): Promise<ExportResult> {
  const viewModel = buildDocumentViewModel(doc, documentType);
  const generic = toGenericViewModel(viewModel);
  const options = renderOptionsFor(documentType);
  const buffer = format === 'docx' ? await renderGenericDocx(generic, options) : await renderGenericPdf(generic, options);
  return { buffer, filename: buildExportFilename(doc, documentType, format), contentType: CONTENT_TYPE[format] };
}

// ---------- untrusted-JSON parsing ----------
// parseTechnicalProcessDocument now lives in techdoc-parse.ts (F07) - shared, client-safe, so
// TechDoc Assistant's own localStorage restore (tryRestoreDocument) can reuse the exact same
// thorough structural parser this export route always used, instead of a shallower check.
export { parseTechnicalProcessDocument } from './techdoc-parse';

export function parseDocumentType(value: unknown): DocumentType {
  if (typeof value !== 'string' || !DOCUMENT_TYPES.includes(value as DocumentType)) {
    throw new Error(`Вид документа: недопустимое значение. Допустимо: ${DOCUMENT_TYPES.join(', ')}.`);
  }
  return value as DocumentType;
}

export function parseExportFormat(value: unknown): ExportFormat {
  if (typeof value !== 'string' || !EXPORT_FORMATS.includes(value as ExportFormat)) {
    throw new Error(`Формат файла: недопустимое значение. Допустимо: ${EXPORT_FORMATS.join(', ')}.`);
  }
  return value as ExportFormat;
}
