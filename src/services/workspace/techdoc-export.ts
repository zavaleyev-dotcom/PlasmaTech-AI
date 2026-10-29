/** Local, dependency-bounded DOCX/PDF export for TechDoc Assistant documents. No LLM, no
 *  network call, no cloud converter - files are generated entirely server-side with `docx`
 *  (OOXML) and `pdfkit` (+ an embedded Cyrillic-capable TTF font, since PDFKit's built-in
 *  standard fonts have no Cyrillic glyphs). Every value shown here comes straight from
 *  `TechnicalProcessDocument` - nothing is invented; an absent field renders as "не задано"
 *  (prose) or "—" (table cell), exactly like the existing on-screen preview. */

import 'server-only';
import {
  validateDocument, buildTechnologicalCard, buildRouteCard, buildBriefRecipe, buildStepDetails, buildLegacyLines, stepUnits,
  sourceFields, gasFields, cardDetailHeading, layersTableHeading, hasLongList,
  PRESSURE_UNIT_LABELS, SEQUENTIAL_MODE_MEANING, SCCM_MEANING, LEGACY_APPENDIX_TITLE, LEGACY_APPENDIX_NOTE, STEP_TYPE_LABELS,
  type TechnicalProcessDocument, type ProcessStep, type StepUnit,
} from './techdoc-assistant';
import {
  CARD_COLUMN_WEIGHTS, LAYER_TABLE_WEIGHTS, SOURCE_DETAIL_WEIGHTS, GAS_DETAIL_WEIGHTS, SOURCE_DETAIL_LAYER_WEIGHTS, GAS_DETAIL_LAYER_WEIGHTS,
  CARD_CELL_LINE_BUDGET, CONTINUATION_CELL, splitTallRows,
} from './techdoc-card-layout';
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
  const calculated = doc.steps.flatMap(s => [
    ...(s.calculatedFields.length > 0 ? [`№${s.order} (${s.calculatedFields.join(', ')})`] : []),
    ...s.layers.flatMap((l, i) => l.calculatedFields.length > 0 ? [`№${s.order}, слой ${i + 1} (${l.calculatedFields.join(', ')})`] : []),
  ]);
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

/** One table per card unit (the card itself, or one coating layer) that has a long source or gas list: every item is its OWN short
 *  row, and every row repeats the step number and name (and the layer) - so a table that runs onto further pages (the column header
 *  is repeated by the renderer) never separates a value from the step it belongs to. */
function detailTablesFor(step: ProcessStep, unit: StepUnit): ViewModelTable[] {
  const tables: ViewModelTable[] = [];
  const stepName = step.enabled ? step.name : `${step.name} (отключён)`;
  const layered = unit.layerNumber !== undefined;
  const lead = (extra: string[]) => layered ? [String(step.order), stepName, String(unit.layerNumber), ...extra] : [String(step.order), stepName, ...extra];
  const head = (cols: string[]) => layered ? ['№ этапа', 'Этап', 'Слой', ...cols] : ['№ этапа', 'Этап', ...cols];
  const identity = layered ? [0, 1, 2, 3] : [0, 1, 2];
  if (hasLongList(unit, 'sources')) {
    const weights = layered ? SOURCE_DETAIL_LAYER_WEIGHTS : SOURCE_DETAIL_WEIGHTS;
    tables.push({
      heading: cardDetailHeading(step, unit, 'sources'),
      columns: head(['Источник', 'Материал', 'Состояние', 'Значения', 'Время', 'Режим']),
      columnWeights: [...weights],
      rows: splitTallRows(unit.sources.map(s => { const f = sourceFields(s); return lead([f.source, f.material, f.state, f.value, f.time, f.mode]); }), weights, identity),
    });
  }
  if (hasLongList(unit, 'gases')) {
    const weights = layered ? GAS_DETAIL_LAYER_WEIGHTS : GAS_DETAIL_WEIGHTS;
    tables.push({
      heading: cardDetailHeading(step, unit, 'gases'),
      columns: head(['Линия', 'Газ', 'Состояние', 'Расход', 'Время подачи']),
      columnWeights: [...weights],
      rows: splitTallRows(unit.gases.map(g => { const f = gasFields(g); return lead([f.line, f.gas, f.state, f.flow, f.time]); }), weights, identity),
    });
  }
  return tables;
}

/** The tables that follow the card: for a coating card the layers table, then the detail tables of any unit with a long list. */
function cardDetailTables(doc: TechnicalProcessDocument, layerRows: Map<number, string[][]>): ViewModelTable[] {
  const tables: ViewModelTable[] = [];
  for (const step of doc.steps) {
    const rows = layerRows.get(step.order);
    if (rows && rows.length > 0) {
      tables.push({
        heading: layersTableHeading(step),
        columns: ['№ эт.', 'Этап', 'Слой', 'Материал', 'Толщина', 'Время', 'Темп.', 'Давл.', 'Bias', 'Вращ. / расст.', 'Источники', 'Газы'],
        columnWeights: [...LAYER_TABLE_WEIGHTS],
        rows: splitTallRows(rows, LAYER_TABLE_WEIGHTS, [0, 1, 2]),
      });
    }
    for (const unit of stepUnits(step)) tables.push(...detailTablesFor(step, unit));
  }
  return tables;
}

function legacyNote(doc: TechnicalProcessDocument): ViewModelSection[] {
  return buildLegacyLines(doc).length > 0
    ? [{ heading: 'Данные прежней версии', paragraphs: ['Документ содержит данные прежней версии, которые не входят в технологический режим и в эту таблицу не включены; они приведены в приложении к технологической инструкции.'] }]
    : [];
}

function cardNotes(doc: TechnicalProcessDocument, split: boolean): ViewModelSection[] {
  const withLists = doc.steps.filter(step => stepUnits(step).some(u => u.sources.length > 0 || u.gases.length > 0));
  const anyLong = doc.steps.some(step => stepUnits(step).some(u => hasLongList(u, 'sources') || hasLongList(u, 'gases')));
  const hasLayers = doc.steps.some(step => step.layers.length > 0 && STEP_TYPE_LABELS[step.type]);
  const paragraphs: string[] = [];
  if (hasLayers) paragraphs.push('Для карточки покрытия параметры каждого слоя (материал, толщина, время, температура, давление, смещение, вращение, источники и газовые линии) приведены в таблице «Этап №…: слои покрытия»; в строке карты указано «по слоям».');
  if (withLists.length > 0) {
    paragraphs.push(`В колонках «Источники» и «Газы» через «;» перечислены все источники и газовые линии этапа${anyLong ? ' (кроме перечней, слишком больших для ячейки - см. ниже)' : ''}.`);
    if (doc.steps.some(step => stepUnits(step).some(u => u.sources.some(s => s.enabled && s.mode === 'sequential')))) paragraphs.push(`Последовательный режим: ${SEQUENTIAL_MODE_MEANING}.`);
    if (anyLong) {
      paragraphs.push(`Для этапов и слоёв, у которых перечень источников или газовых линий слишком велик для одной ячейки (более ${CARD_CELL_LINE_BUDGET} строк текста в колонке), в таблице указано только число; полный перечень (каждый элемент отдельной строкой с номером и названием этапа) приведён в таблицах «Этап №…: источники» и «Этап №…: газовые линии» ниже. Ничего не опущено.`);
    }
    paragraphs.push(unitsNote(doc));
  }
  if (split) {
    paragraphs.push(`Значение, не помещающееся на одной странице, разбито на части «[k/n]» в нескольких строках: каждая строка повторяет номер и название этапа (и источник или линию); «${CONTINUATION_CELL}» означает, что значение указано в первой строке. Части идут по порядку и являются непрерывными фрагментами исходного значения; маркер «[k/n] » (скобки, дробь и один пробел) - только нумерация: чтобы получить исходное значение, отбросьте этот префикс у каждой части и соедините части подряд, ничего не добавляя. Ничего не опущено.`);
  }
  const sections: ViewModelSection[] = paragraphs.length > 0 ? [{ heading: 'Примечание', paragraphs }] : [];
  return [...sections, ...legacyNote(doc)];
}

function unitsNote(doc: TechnicalProcessDocument): string {
  return `Единицы: давление — ${PRESSURE_UNIT_LABELS[doc.pressureUnit]} (хранится в паскалях); расход газа — ${SCCM_MEANING}.`;
}

/** Every card in the printed instruction: its type, description, the fields of its type, and - from the same builder the on-screen
 *  preview uses - every source and gas line (per layer for a coating card), the notes and the remarks. */
function stepParagraph(doc: TechnicalProcessDocument, step: ProcessStep): string {
  const head = `№${step.order}. ${step.name}${!step.enabled ? ' (отключён)' : ''}${step.name === STEP_TYPE_LABELS[step.type] ? '' : ` [${STEP_TYPE_LABELS[step.type]}]`}`;
  const d = buildStepDetails(doc, step);
  const out: string[] = [];
  if (step.description && step.description.trim() !== '') out.push(`Описание: ${step.description}`);
  out.push(...d.parameters.map(p => `${p.label}: ${p.value}`));
  for (const unit of d.units) {
    if (unit.title) out.push(`${unit.title}:`, ...unit.parameters.map(p => `  ${p.label}: ${p.value}`));
    if (unit.sources.length > 0) out.push('Источники:', ...unit.sources.map(text => `• ${text}`));
    if (unit.gases.length > 0) out.push('Газовые линии:', ...unit.gases.map(text => `• ${text}`));
  }
  out.push(...d.notes);
  if (d.warnings.length > 0) out.push('Замечания к данным этапа:', ...d.warnings.map(text => `• ${text}`));
  return `${head}\n${out.join('\n')}`;
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
      columns: ['№', 'Операция', 'Время', 'Темп.', 'Давление', 'Газы', 'Источники', 'Bias', 'Прочие параметры', 'Описание'],
      // The Gases and Sources cells carry every source and gas line of the step in full, so they get most of the width.
      columnWeights: [...CARD_COLUMN_WEIGHTS],
      // A free-text cell (description) too long for one page is split into marked continuation rows.
      rows: splitTallRows(rows.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sources, r.bias, r.params, r.description]), CARD_COLUMN_WEIGHTS, [0, 1]),
    }, ...cardDetailTables(doc, new Map(rows.filter(r => r.layers.length > 0).map(r => [r.number, r.layers.map(l => [String(l.number), l.stepName, String(l.layer), l.material, l.thickness, l.duration, l.temperature, l.pressure, l.bias, l.motion, l.sources, l.gases])])))];
    const split = tables.some(t => t.rows.some(row => row.includes(CONTINUATION_CELL)));
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.technologicalCard}: ${show(g.processName)}`, metadata, sections: cardNotes(doc, split), tables,
      warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  if (documentType === 'routeCard') {
    const rows = buildRouteCard(doc);
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.routeCard}: ${show(g.processName)}`, metadata, sections: legacyNote(doc),
      tables: [{ heading: DOCUMENT_TYPE_LABELS.routeCard, columns: ['№', 'Этап', 'Оборудование', 'Вход', 'Операция', 'Выход'],
        rows: rows.map(r => [String(r.number), r.stage, r.equipment, r.input, r.operation, r.output]) }],
      warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  if (documentType === 'recipe') {
    const lines = buildBriefRecipe(doc).split('\n').slice(1);
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.recipe}: ${show(g.processName)}`, metadata,
      sections: [{ heading: DOCUMENT_TYPE_LABELS.recipe, paragraphs: lines.length > 0 ? lines : [NOT_SET] }, ...legacyNote(doc)],
      tables: [], warnings, qualityChecks, traceability, traceabilityHeading: 'Traceability', footer,
    };
  }

  // instruction: the dedicated, more granular 10-section structure
  const legacyLines = buildLegacyLines(doc);
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
    { heading: '7. Параметры процесса', paragraphs: [...(doc.steps.length > 0 ? doc.steps.map(s => stepParagraph(doc, s)) : [NOT_SET]), unitsNote(doc)] },
    { heading: '8. Контроль качества', paragraphs: qualityChecks.length > 0 ? [`Определено параметров контроля: ${qualityChecks.length}. См. таблицу ниже.`] : [NOT_SET] },
    { heading: '9. Требования безопасности', paragraphs: warnings.length > 0 ? warnings : [NOT_SET] },
    ...(legacyLines.length > 0 ? [{ heading: LEGACY_APPENDIX_TITLE, paragraphs: [LEGACY_APPENDIX_NOTE, ...legacyLines] }] : []),
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
