/** Local, dependency-bounded DOCX/PDF export for TechDoc Assistant documents. No LLM, no
 *  network call, no cloud converter - files are generated entirely server-side with `docx`
 *  (OOXML) and `pdfkit` (+ an embedded Cyrillic-capable TTF font, since PDFKit's built-in
 *  standard fonts have no Cyrillic glyphs). Every value shown here comes straight from
 *  `TechnicalProcessDocument` - nothing is invented; an absent field renders as "не задано"
 *  (prose) or "—" (table cell), exactly like the existing on-screen preview. */

import 'server-only';
import path from 'node:path';
import { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Packer, PageBreak, AlignmentType, VerticalAlign } from 'docx';
import PDFDocument from 'pdfkit';
import {
  validateDocument, buildTechnologicalCard, buildRouteCard, buildBriefRecipe, STEP_TYPES,
  type TechnicalProcessDocument, type GeneralInfo, type InitialData, type ProcessStep, type GasUsage,
  type SourceSet, type MagnetronSource, type ArcSource, type GasLine, type QualityCheck, type SafetySection, type Traceability,
} from './techdoc-assistant';
import {
  DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, FILENAME_SEGMENT,
  type DocumentType, type ExportFormat,
} from './techdoc-export-types';

export { DOCUMENT_TYPES, EXPORT_FORMATS, DOCUMENT_TYPE_LABELS, type DocumentType, type ExportFormat };

const NOT_SET = 'не задано';
const DASH = '—';

function show(value: string | undefined): string {
  return value !== undefined && value.trim() !== '' ? value : NOT_SET;
}
function showNum(value: number | undefined, unit: string): string {
  return value === undefined ? NOT_SET : `${value}${unit}`;
}

/** Strips slashes, backslashes, colons, control characters and any other character that is
 *  unsafe in a filename or an HTTP header value, collapses whitespace, and bounds the length -
 *  used for BOTH the process-name segment and as a defense-in-depth pass on the whole name. */
export function sanitizeFilenameSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function buildExportFilename(doc: TechnicalProcessDocument, documentType: DocumentType, format: ExportFormat): string {
  const process = sanitizeFilenameSegment(doc.general.processName, 'process');
  return `${process}_${FILENAME_SEGMENT[documentType]}_v${doc.traceability.version}.${format}`;
}

// ---------- DocumentViewModel (item 4): the ONE normalized layer both DOCX and PDF render from ----------

export interface ViewModelSection { heading: string; paragraphs: string[] }
export interface ViewModelTable { heading: string; columns: string[]; rows: string[][] }
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
  for (const m of src.magnetrons) lines.push(`Магнетрон (${m.enabled ? 'включён' : 'отключён'}): материал — ${show(m.material)}, мощность — ${showNum(m.powerW, ' Вт')}, режим — ${show(m.mode)}`);
  if (src.arcSources.length === 0) lines.push(`Arc-источники: ${NOT_SET}`);
  for (const a of src.arcSources) lines.push(`Arc-источник (${a.enabled ? 'включён' : 'отключён'}${a.filtered ? ', фильтрованный' : ''}): материал катода — ${show(a.cathodeMaterial)}, ток дуги — ${showNum(a.arcCurrentA, ' А')}`);
  lines.push(`ICP/RF: ${src.icpRf.enabled ? `включён, мощность — ${showNum(src.icpRf.powerW, ' Вт')}, bias — ${showNum(src.icpRf.biasV, ' В')}` : 'не используется'}`);
  lines.push(`Ion source: ${src.ionSource.enabled ? `включён, напряжение — ${showNum(src.ionSource.voltageV, ' В')}, ток — ${showNum(src.ionSource.currentA, ' А')}, мощность — ${showNum(src.ionSource.powerW, ' Вт')}` : 'не используется'}`);
  if (doc.gasSystem.length === 0) lines.push(`Газовая система: ${NOT_SET}`);
  for (const line of doc.gasSystem) lines.push(`Газовая линия (${line.enabled ? 'включена' : 'отключена'}): газ — ${show(line.gas)}, расход — ${showNum(line.flow, ` ${line.unit}`)}`);
  return lines;
}

function stepParagraph(step: TechnicalProcessDocument['steps'][number]): string {
  const gases = step.gasUsage.length > 0
    ? step.gasUsage.map(g => `${g.gas || NOT_SET}${g.flowSccm !== undefined ? ` (${g.flowSccm} см³/мин)` : ''}`).join(', ')
    : NOT_SET;
  const source = [step.sourceConfiguration, step.powerW !== undefined ? `${step.powerW} Вт` : null, step.currentA !== undefined ? `${step.currentA} А` : null]
    .filter((part): part is string => Boolean(part)).join(', ') || NOT_SET;
  return `№${step.order}. ${step.name}${!step.enabled ? ' (отключён)' : ''} — длительность: ${showNum(step.durationMin, ' мин')}; `
    + `температура: ${showNum(step.temperatureC, '°C')}; давление: ${showNum(step.pressureMbar, ' мбар')}; газы: ${gases}; `
    + `источник/мощность: ${source}; bias: ${showNum(step.substrateBiasV, ' В')}; вращение: ${showNum(step.rotationRpm, ' об/мин')}; `
    + `расстояние: ${showNum(step.distanceMm, ' мм')}; критерий приёмки: ${show(step.acceptanceCriteria)}; примечание: ${show(step.notes)}`;
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
    const rows = buildTechnologicalCard(doc);
    return {
      documentType, title: `${DOCUMENT_TYPE_LABELS.technologicalCard}: ${show(g.processName)}`, metadata, sections: [],
      tables: [{ heading: DOCUMENT_TYPE_LABELS.technologicalCard, columns: ['№', 'Операция', 'Время', 'Температура', 'Давление', 'Газы', 'Источник/мощность', 'Bias', 'Контроль', 'Примечание'],
        rows: rows.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sourcePower, r.bias, r.control, r.note]) }],
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
    { heading: '7. Параметры процесса', paragraphs: [...sourceAndGasSummary(doc), ...(doc.steps.length > 0 ? doc.steps.map(stepParagraph) : [NOT_SET])] },
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

// ---------- DOCX renderer ----------

const DOCX_FONT = 'Times New Roman'; // ships with every Word install and renders Cyrillic natively
const BODY_SIZE = 22; // half-points -> 11pt
const SMALL_SIZE = 18; // 9pt, for table cells

function textParagraph(text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, font: DOCX_FONT, size: opts.size ?? BODY_SIZE, bold: opts.bold })], spacing: { after: 100 } });
}

function metadataParagraph(item: ViewModelMetadataItem): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${item.label}: `, font: DOCX_FONT, size: BODY_SIZE, bold: true }),
      new TextRun({ text: item.value, font: DOCX_FONT, size: BODY_SIZE }),
    ],
    spacing: { after: 40 },
  });
}

function docxTable(table: ViewModelTable): Table {
  const columnWidth = Math.floor(100 / table.columns.length);
  const headerRow = new TableRow({
    tableHeader: true,
    children: table.columns.map(col => new TableCell({
      width: { size: columnWidth, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
      shading: { fill: 'E2E2E2' },
      children: [new Paragraph({ children: [new TextRun({ text: col, font: DOCX_FONT, size: SMALL_SIZE, bold: true })] })],
    })),
  });
  const bodyRows = (table.rows.length > 0 ? table.rows : [table.columns.map(() => DASH)]).map(row => new TableRow({
    children: row.map(cell => new TableCell({
      width: { size: columnWidth, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text: cell, font: DOCX_FONT, size: SMALL_SIZE })] })],
    })),
  }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

export async function renderDocx(viewModel: DocumentViewModel): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.title, font: DOCX_FONT, size: 32, bold: true })], heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, spacing: { after: 200 } }));
  children.push(...viewModel.metadata.map(metadataParagraph));
  if (viewModel.documentType === 'instruction') children.push(new Paragraph({ children: [new PageBreak()] }));

  for (const section of viewModel.sections) {
    children.push(new Paragraph({ children: [new TextRun({ text: section.heading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(...section.paragraphs.map(p => textParagraph(p)));
  }

  for (const table of viewModel.tables) {
    children.push(new Paragraph({ children: [new TextRun({ text: table.heading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(docxTable(table));
  }

  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.traceabilityHeading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } }));
  const t = viewModel.traceability;
  children.push(textParagraph(`Процесс: ${t.processName}`));
  children.push(textParagraph(`Версия: ${t.version}`));
  children.push(textParagraph(`Создан: ${t.createdAt}`));
  children.push(textParagraph(`Обновлён: ${t.updatedAt}`));
  children.push(textParagraph(`Источник: ${t.source}`));
  children.push(textParagraph(t.calculatedFieldsNote));
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.footer, font: DOCX_FONT, size: 18, italics: true })], spacing: { before: 300 } }));

  // Wide, many-column tables (technological/route card) get more room to stay readable in landscape.
  const landscape = viewModel.documentType === 'technologicalCard' || viewModel.documentType === 'routeCard';
  const [width, height] = landscape ? [16838, 11906] : [11906, 16838];
  const document = new Document({
    sections: [{
      properties: { page: { size: { width, height }, margin: { top: 1134, bottom: 1134, left: 1417, right: 1417 } } },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

// ---------- PDF renderer ----------

// Built from `process.cwd()` as a plain runtime path string, never via `require.resolve(...)` -
// under Turbopack's route-handler bundling, `require.resolve` (even resolving the package's own
// package.json, a "known" module type) does not return a real filesystem path at all: it
// returns Turbopack's internal numeric module id, which then blows up `path.dirname`/`fs`
// calls at request time ("path argument must be of type string. Received type number").
// `process.cwd()` is always the project root for `next dev`/`next build`/`next start`, so this
// stays correct without asking either bundler to trace or load the .ttf as a module.
const PDF_FONT_REGULAR = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans.ttf');
const PDF_FONT_BOLD = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans-Bold.ttf');
const PDF_MARGIN = 56;

export async function renderPdf(viewModel: DocumentViewModel): Promise<Buffer> {
  // Wide, many-column tables (technological/route card) get more room to stay readable in landscape.
  const landscape = viewModel.documentType === 'technologicalCard' || viewModel.documentType === 'routeCard';
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: PDF_MARGIN, bufferPages: true });
      doc.registerFont('Body', PDF_FONT_REGULAR);
      doc.registerFont('Bold', PDF_FONT_BOLD);
      doc.font('Body');

      const chunks: Buffer[] = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i++) {
          doc.switchToPage(pages.start + i);
          doc.font('Body').fontSize(8).fillColor('#666666')
            .text(`Страница ${i + 1} из ${pages.count}`, PDF_MARGIN, doc.page.height - PDF_MARGIN + 20, { width: doc.page.width - PDF_MARGIN * 2, align: 'center' });
        }
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);

      const contentWidth = doc.page.width - PDF_MARGIN * 2;

      doc.font('Bold').fontSize(16).fillColor('#000000').text(viewModel.title, { width: contentWidth });
      doc.moveDown(0.5);
      doc.font('Body').fontSize(10);
      for (const item of viewModel.metadata) {
        doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
      }
      doc.moveDown(0.5);
      if (viewModel.documentType === 'instruction') doc.addPage();

      for (const section of viewModel.sections) {
        ensureSpace(doc, 40);
        doc.font('Bold').fontSize(13).text(section.heading, { width: contentWidth });
        doc.moveDown(0.3);
        doc.font('Body').fontSize(10);
        for (const paragraph of section.paragraphs) {
          ensureSpace(doc, 14);
          doc.text(paragraph, { width: contentWidth, align: 'left' });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.4);
      }

      for (const table of viewModel.tables) {
        ensureSpace(doc, 40);
        doc.font('Bold').fontSize(13).text(table.heading, { width: contentWidth });
        doc.moveDown(0.3);
        drawTable(doc, table, contentWidth);
        doc.moveDown(0.4);
      }

      ensureSpace(doc, 60);
      doc.font('Bold').fontSize(13).text(viewModel.traceabilityHeading, { width: contentWidth });
      doc.moveDown(0.3);
      doc.font('Body').fontSize(10);
      const t = viewModel.traceability;
      for (const line of [`Процесс: ${t.processName}`, `Версия: ${t.version}`, `Создан: ${t.createdAt}`, `Обновлён: ${t.updatedAt}`, `Источник: ${t.source}`, t.calculatedFieldsNote]) {
        doc.text(line, { width: contentWidth });
      }
      doc.moveDown(0.5);
      doc.font('Body').fontSize(8).fillColor('#666666').text(viewModel.footer, { width: contentWidth });

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Не удалось сформировать PDF.'));
    }
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, minHeight: number): void {
  if (doc.y + minHeight > doc.page.height - PDF_MARGIN) doc.addPage();
}

function drawTable(doc: PDFKit.PDFDocument, table: ViewModelTable, contentWidth: number): void {
  const columnWidth = contentWidth / table.columns.length;
  const rows = table.rows.length > 0 ? table.rows : [table.columns.map(() => DASH)];

  function drawHeader(): void {
    const startY = doc.y;
    doc.font('Bold').fontSize(8);
    const rowHeight = Math.max(...table.columns.map(col => doc.heightOfString(col, { width: columnWidth - 6 }))) + 8;
    doc.rect(PDF_MARGIN, startY, contentWidth, rowHeight).fill('#E2E2E2');
    doc.fillColor('#000000');
    table.columns.forEach((col, i) => {
      doc.text(col, PDF_MARGIN + i * columnWidth + 3, startY + 4, { width: columnWidth - 6 });
    });
    doc.y = startY + rowHeight;
  }

  drawHeader();
  doc.font('Body').fontSize(8);

  for (const row of rows) {
    const rowHeight = Math.max(...row.map(cell => doc.heightOfString(cell || DASH, { width: columnWidth - 6 }))) + 8;
    if (doc.y + rowHeight > doc.page.height - PDF_MARGIN) {
      doc.addPage();
      drawHeader();
      doc.font('Body').fontSize(8);
    }
    const startY = doc.y;
    row.forEach((cell, i) => {
      doc.text(cell || DASH, PDF_MARGIN + i * columnWidth + 3, startY + 4, { width: columnWidth - 6 });
    });
    doc.y = startY + rowHeight;
  }
}

// ---------- top-level export entry point ----------

export interface ExportResult { buffer: Buffer; filename: string; contentType: string }

const CONTENT_TYPE: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export async function exportTechDoc(doc: TechnicalProcessDocument, documentType: DocumentType, format: ExportFormat): Promise<ExportResult> {
  const viewModel = buildDocumentViewModel(doc, documentType);
  const buffer = format === 'docx' ? await renderDocx(viewModel) : await renderPdf(viewModel);
  return { buffer, filename: buildExportFilename(doc, documentType, format), contentType: CONTENT_TYPE[format] };
}

// ---------- server-side parsing of untrusted client JSON (item 13/14) ----------
// Never trusts the client's shape: every field is read by NAME and type-checked/length-capped
// here - nothing is ever spread wholesale from the parsed JSON into our own objects, so a
// malformed or hostile payload can neither smuggle extra properties nor blow up memory/CPU
// with unbounded arrays or strings. Numeric soundness (NaN/Infinity/sign) is left to
// `validateDocument`, which every caller (buildDocumentViewModel) already runs.

const MAX_SHORT_TEXT = 300;
const MAX_LONG_TEXT = 5000;
const MAX_STEPS = 200;
const MAX_QUALITY_CHECKS = 200;
const MAX_SMALL_ARRAY = 50;

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидается объект.`);
  return value as Record<string, unknown>;
}
function asArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}: ожидается массив.`);
  if (value.length > maxItems) throw new Error(`${label}: слишком много элементов (максимум ${maxItems}).`);
  return value;
}
function asRequiredString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string {
  if (typeof value !== 'string') throw new Error(`${label}: обязательное строковое поле.`);
  if (value.length > maxLen) throw new Error(`${label}: текст слишком длинный (максимум ${maxLen} символов).`);
  return value;
}
function asOptionalString(value: unknown, label: string, maxLen = MAX_SHORT_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asRequiredString(value, label, maxLen);
}
function asOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`${label}: ожидается число.`);
  return value;
}
function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}
function asStringArray(value: unknown, label: string, maxItems = MAX_SMALL_ARRAY, maxLen = MAX_SHORT_TEXT): string[] {
  return asArray(value, label, maxItems).map((v, i) => asRequiredString(v, `${label}[${i}]`, maxLen));
}
function asStepType(value: unknown, label: string): ProcessStep['type'] {
  if (typeof value !== 'string' || !STEP_TYPES.includes(value as ProcessStep['type'])) throw new Error(`${label}: недопустимый тип этапа.`);
  return value as ProcessStep['type'];
}

function parseGeneralInfo(raw: unknown): GeneralInfo {
  const o = asObject(raw ?? {}, 'Общие сведения');
  return {
    processName: asRequiredString(o.processName, 'Название процесса', MAX_SHORT_TEXT),
    purpose: asOptionalString(o.purpose, 'Назначение', MAX_LONG_TEXT),
    equipment: asOptionalString(o.equipment, 'Оборудование'),
    installationModel: asOptionalString(o.installationModel, 'Установка/модель'),
    substrateMaterial: asOptionalString(o.substrateMaterial, 'Материал подложки'),
    productType: asOptionalString(o.productType, 'Тип изделия'),
    coatingMaterial: asOptionalString(o.coatingMaterial, 'Материал покрытия/обработки'),
    responsible: asOptionalString(o.responsible, 'Ответственный/подразделение'),
    documentVersion: asOptionalString(o.documentVersion, 'Версия документа'),
    date: asOptionalString(o.date, 'Дата'),
  };
}

function parseInitialData(raw: unknown): InitialData {
  const o = asObject(raw ?? {}, 'Исходные данные');
  return {
    partSizeMm: asOptionalNumber(o.partSizeMm, 'Размер изделия'),
    quantity: asOptionalNumber(o.quantity, 'Количество'),
    initialSurfaceCondition: asOptionalString(o.initialSurfaceCondition, 'Исходное состояние поверхности', MAX_LONG_TEXT),
    cleanlinessRequirement: asOptionalString(o.cleanlinessRequirement, 'Требования к чистоте', MAX_LONG_TEXT),
    coatingRequirement: asOptionalString(o.coatingRequirement, 'Требования к покрытию/обработке', MAX_LONG_TEXT),
    requiredThicknessUm: asOptionalNumber(o.requiredThicknessUm, 'Требуемая толщина'),
    allowedTemperatureC: asOptionalNumber(o.allowedTemperatureC, 'Допустимая температура'),
    additionalRequirements: asOptionalString(o.additionalRequirements, 'Дополнительные требования', MAX_LONG_TEXT),
  };
}

function parseGasUsage(raw: unknown, label: string): GasUsage[] {
  return asArray(raw, label, MAX_SMALL_ARRAY).map((entry, i) => {
    const o = asObject(entry, `${label}[${i}]`);
    return { gas: asRequiredString(o.gas ?? '', `${label}[${i}].gas`), flowSccm: asOptionalNumber(o.flowSccm, `${label}[${i}].flowSccm`) };
  });
}

function parseStep(raw: unknown, index: number): ProcessStep {
  const o = asObject(raw, `Этап[${index}]`);
  const label = `Этап №${index + 1}`;
  return {
    order: asOptionalNumber(o.order, `${label}: номер`) ?? index + 1,
    name: asRequiredString(o.name, `${label}: название`),
    type: asStepType(o.type, `${label}: тип`),
    enabled: asBoolean(o.enabled, `${label}: включён`, true),
    description: asOptionalString(o.description, `${label}: описание`, MAX_LONG_TEXT),
    durationMin: asOptionalNumber(o.durationMin, `${label}: длительность`),
    temperatureC: asOptionalNumber(o.temperatureC, `${label}: температура`),
    pressureMbar: asOptionalNumber(o.pressureMbar, `${label}: давление`),
    gasUsage: parseGasUsage(o.gasUsage, `${label}: газы`),
    sourceConfiguration: asOptionalString(o.sourceConfiguration, `${label}: источник`),
    powerW: asOptionalNumber(o.powerW, `${label}: мощность`),
    currentA: asOptionalNumber(o.currentA, `${label}: ток`),
    substrateBiasV: asOptionalNumber(o.substrateBiasV, `${label}: bias`),
    rotationRpm: asOptionalNumber(o.rotationRpm, `${label}: вращение`),
    distanceMm: asOptionalNumber(o.distanceMm, `${label}: расстояние`),
    notes: asOptionalString(o.notes, `${label}: примечание`, MAX_LONG_TEXT),
    acceptanceCriteria: asOptionalString(o.acceptanceCriteria, `${label}: критерий приёмки`, MAX_LONG_TEXT),
    origin: o.origin === 'preset' ? 'preset' : 'user',
    calculatedFields: asStringArray(o.calculatedFields, `${label}: вычисленные поля`, 20, 100),
  };
}

function parseMagnetron(raw: unknown, index: number): MagnetronSource {
  const o = asObject(raw, `Магнетрон[${index}]`);
  return {
    id: asRequiredString(o.id ?? `magnetron-${index}`, `Магнетрон[${index}]: id`),
    enabled: asBoolean(o.enabled, `Магнетрон[${index}]: включён`, true),
    material: asOptionalString(o.material, `Магнетрон[${index}]: материал`),
    powerW: asOptionalNumber(o.powerW, `Магнетрон[${index}]: мощность`),
    mode: asOptionalString(o.mode, `Магнетрон[${index}]: режим`),
  };
}

function parseArcSource(raw: unknown, index: number): ArcSource {
  const o = asObject(raw, `Arc-источник[${index}]`);
  return {
    id: asRequiredString(o.id ?? `arc-${index}`, `Arc-источник[${index}]: id`),
    enabled: asBoolean(o.enabled, `Arc-источник[${index}]: включён`, true),
    cathodeMaterial: asOptionalString(o.cathodeMaterial, `Arc-источник[${index}]: материал катода`),
    arcCurrentA: asOptionalNumber(o.arcCurrentA, `Arc-источник[${index}]: ток дуги`),
    filtered: asBoolean(o.filtered, `Arc-источник[${index}]: фильтрованный`, false),
  };
}

function parseSourceSet(raw: unknown): SourceSet {
  const o = asObject(raw ?? {}, 'Источники');
  const icpRfRaw = asObject(o.icpRf ?? {}, 'ICP/RF');
  const ionSourceRaw = asObject(o.ionSource ?? {}, 'Ion source');
  return {
    magnetrons: asArray(o.magnetrons, 'Магнетроны', MAX_SMALL_ARRAY).map(parseMagnetron),
    arcSources: asArray(o.arcSources, 'Arc-источники', MAX_SMALL_ARRAY).map(parseArcSource),
    icpRf: {
      enabled: asBoolean(icpRfRaw.enabled, 'ICP/RF: включён', false),
      powerW: asOptionalNumber(icpRfRaw.powerW, 'ICP/RF: мощность'),
      biasV: asOptionalNumber(icpRfRaw.biasV, 'ICP/RF: bias'),
    },
    ionSource: {
      enabled: asBoolean(ionSourceRaw.enabled, 'Ion source: включён', false),
      voltageV: asOptionalNumber(ionSourceRaw.voltageV, 'Ion source: напряжение'),
      currentA: asOptionalNumber(ionSourceRaw.currentA, 'Ion source: ток'),
      powerW: asOptionalNumber(ionSourceRaw.powerW, 'Ion source: мощность'),
    },
  };
}

function parseGasLine(raw: unknown, index: number): GasLine {
  const o = asObject(raw, `Газовая линия[${index}]`);
  return {
    id: asRequiredString(o.id ?? `gas-${index}`, `Газовая линия[${index}]: id`),
    gas: asRequiredString(o.gas ?? '', `Газовая линия[${index}]: газ`),
    flow: asOptionalNumber(o.flow, `Газовая линия[${index}]: расход`),
    unit: asRequiredString(o.unit ?? 'sccm', `Газовая линия[${index}]: единица`, 20),
    enabled: asBoolean(o.enabled, `Газовая линия[${index}]: включена`, false),
  };
}

const QUALITY_STATUSES = ['pass', 'fail', 'not_tested'] as const;

function parseQualityCheck(raw: unknown, index: number): QualityCheck {
  const o = asObject(raw, `Контроль качества[${index}]`);
  const status = o.status;
  return {
    id: asRequiredString(o.id ?? `qc-${index}`, `Контроль качества[${index}]: id`),
    parameter: asRequiredString(o.parameter, `Контроль качества[${index}]: параметр`),
    method: asOptionalString(o.method, `Контроль качества[${index}]: метод`, MAX_LONG_TEXT),
    criterion: asOptionalString(o.criterion, `Контроль качества[${index}]: критерий`, MAX_LONG_TEXT),
    unit: asOptionalString(o.unit, `Контроль качества[${index}]: единица`),
    result: asOptionalString(o.result, `Контроль качества[${index}]: результат`, MAX_LONG_TEXT),
    status: typeof status === 'string' && (QUALITY_STATUSES as readonly string[]).includes(status) ? status as QualityCheck['status'] : undefined,
  };
}

function parseSafety(raw: unknown): SafetySection {
  const o = asObject(raw ?? {}, 'Безопасность');
  return {
    hazards: asStringArray(o.hazards, 'Опасности'),
    ppe: asStringArray(o.ppe, 'СИЗ'),
    interlocks: asStringArray(o.interlocks, 'Блокировки'),
    gasSafety: asOptionalString(o.gasSafety, 'Газовая безопасность', MAX_LONG_TEXT),
    vacuumSafety: asOptionalString(o.vacuumSafety, 'Вакуумная безопасность', MAX_LONG_TEXT),
    highVoltage: asOptionalString(o.highVoltage, 'Высокое напряжение', MAX_LONG_TEXT),
    hotSurfaces: asOptionalString(o.hotSurfaces, 'Горячие поверхности', MAX_LONG_TEXT),
    notes: asOptionalString(o.notes, 'Примечания', MAX_LONG_TEXT),
  };
}

function parseTraceability(raw: unknown): Traceability {
  const o = asObject(raw ?? {}, 'Traceability');
  const now = new Date().toISOString();
  const version = asOptionalNumber(o.version, 'Traceability: версия') ?? 1;
  return {
    version,
    createdAt: asOptionalString(o.createdAt, 'Traceability: создан') ?? now,
    updatedAt: asOptionalString(o.updatedAt, 'Traceability: обновлён') ?? now,
    source: asOptionalString(o.source, 'Traceability: источник', MAX_SHORT_TEXT) ?? 'blank',
  };
}

/** Rebuilds a `TechnicalProcessDocument` from arbitrary, untrusted JSON (an API request body).
 *  Every field is read by name and type/length/array-size checked - nothing is ever spread
 *  wholesale from the input, so unexpected extra keys are silently dropped rather than
 *  smuggled into the document, and no single field can be used to exhaust memory/CPU. */
export function parseTechnicalProcessDocument(raw: unknown): TechnicalProcessDocument {
  const o = asObject(raw, 'document');
  const stepsRaw = asArray(o.steps, 'Этапы процесса', MAX_STEPS);
  const qualityChecksRaw = asArray(o.qualityChecks, 'Контроль качества', MAX_QUALITY_CHECKS);
  const gasSystemRaw = asArray(o.gasSystem, 'Газовая система', MAX_SMALL_ARRAY);
  return {
    general: parseGeneralInfo(o.general),
    initialData: parseInitialData(o.initialData),
    steps: stepsRaw.map((s, i) => parseStep(s, i)),
    sources: parseSourceSet(o.sources),
    gasSystem: gasSystemRaw.map((g, i) => parseGasLine(g, i)),
    qualityChecks: qualityChecksRaw.map((q, i) => parseQualityCheck(q, i)),
    safety: parseSafety(o.safety),
    traceability: parseTraceability(o.traceability),
  };
}

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
