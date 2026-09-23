/** Shared, dependency-bounded DOCX/PDF rendering core - extracted from the original TechDoc
 *  Assistant exporter so Scientific Writer's export (and any future workspace export) reuses
 *  the SAME `docx`/`pdfkit` rendering code instead of a second copy. This file knows nothing
 *  about TechDoc OR Scientific Writer specifically - it only ever renders a generic
 *  {title, metadata, sections, tables, traceability, footer} shape. techdoc-export.ts maps its
 *  own richer ViewModel into this shape at the call site; its own public API/behavior is
 *  unchanged (verified by re-running its full existing test suite after this extraction). */

import 'server-only';
import path from 'node:path';
import { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Packer, PageBreak, AlignmentType, VerticalAlign } from 'docx';
import PDFDocument from 'pdfkit';

export const NOT_SET = 'не задано';
export const DASH = '—';

/** Strips slashes, backslashes, colons, control characters and any other character that is
 *  unsafe in a filename or an HTTP header value, collapses whitespace, and bounds the length. */
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

// ---------- generic DocumentViewModel: the ONE normalized layer every DOCX/PDF export renders from ----------

export interface ExportSection { heading: string; paragraphs: string[] }
export interface ExportTable { heading: string; columns: string[]; rows: string[][] }
export interface ExportMetadataItem { label: string; value: string }

export interface GenericDocumentViewModel {
  title: string;
  metadata: ExportMetadataItem[];
  sections: ExportSection[];
  tables: ExportTable[];
  /** Rendered exactly like `metadata`, under its own heading - callers decide what belongs
   *  here (version/dates/provenance for TechDoc, generation-source/evidence for Scientific
   *  Writer, etc.); this file has no opinion about what traceability MEANS. */
  traceability: ExportMetadataItem[];
  traceabilityHeading: string;
  footer: string;
}

/** F11: real, applied formatting-profile parameters - when omitted, every existing caller
 *  (TechDoc, and Scientific Writer's own default) gets EXACTLY the previous fixed values,
 *  unchanged. Only the fields already defined on FormattingProfile (references.ts) are wired
 *  through here - no new "paragraph spacing" or similar knob is invented beyond what that
 *  data model already declares. */
export interface FormattingOverrides {
  bodyFontSizePt?: number;
  headingFontSizePt?: number;
  lineSpacing?: number;
  marginsMm?: { top: number; bottom: number; left: number; right: number };
}

export interface RenderOptions {
  layout?: 'portrait' | 'landscape';
  /** Insert a page break right after the metadata block, before the first section - used for
   *  long, multi-section prose documents where a clean break reads better. */
  pageBreakAfterMetadata?: boolean;
  formatting?: FormattingOverrides;
}

// ---------- DOCX renderer ----------

const DOCX_FONT = 'Times New Roman'; // ships with every Word install and renders Cyrillic natively
const BODY_SIZE = 22; // half-points -> 11pt (default when no formatting profile is given)
const HEADING_SIZE = 26; // half-points -> 13pt (default)
const SMALL_SIZE = 18; // 9pt, for table cells
const DEFAULT_MARGINS_TWIPS = { top: 1134, bottom: 1134, left: 1417, right: 1417 };

function ptToHalfPoints(pt: number): number { return Math.round(pt * 2); }
function mmToTwips(mm: number): number { return Math.round(mm * 56.6929); }

/** F12: a single `\n` inside `text` must become a real Word line break (`<w:br/>`), not vanish
 *  inside one TextRun's text - Word does not render embedded "\n" characters as line breaks on
 *  its own. Each line after the first gets its own TextRun with `break: 1`, which the `docx`
 *  package renders as a `<w:br/>` immediately before that run's text (verified empirically). */
function textParagraph(text: string, opts: { bold?: boolean; size?: number; lineSpacing?: number } = {}): Paragraph {
  const lines = text.split('\n');
  const size = opts.size ?? BODY_SIZE;
  return new Paragraph({
    children: lines.map((line, index) => new TextRun({
      text: line, font: DOCX_FONT, size, bold: opts.bold, ...(index > 0 ? { break: 1 } : {}),
    })),
    spacing: { after: 100, ...(opts.lineSpacing ? { line: Math.round(240 * opts.lineSpacing), lineRule: 'auto' } : {}) },
  });
}

function metadataParagraph(item: ExportMetadataItem, size = BODY_SIZE): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${item.label}: `, font: DOCX_FONT, size, bold: true }),
      new TextRun({ text: item.value, font: DOCX_FONT, size }),
    ],
    spacing: { after: 40 },
  });
}

function docxTable(table: ExportTable): Table {
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

export async function renderGenericDocx(viewModel: GenericDocumentViewModel, options: RenderOptions = {}): Promise<Buffer> {
  const bodySize = options.formatting?.bodyFontSizePt !== undefined ? ptToHalfPoints(options.formatting.bodyFontSizePt) : BODY_SIZE;
  const headingSize = options.formatting?.headingFontSizePt !== undefined ? ptToHalfPoints(options.formatting.headingFontSizePt) : HEADING_SIZE;
  const lineSpacing = options.formatting?.lineSpacing;
  const margins = options.formatting?.marginsMm
    ? {
      top: mmToTwips(options.formatting.marginsMm.top), bottom: mmToTwips(options.formatting.marginsMm.bottom),
      left: mmToTwips(options.formatting.marginsMm.left), right: mmToTwips(options.formatting.marginsMm.right),
    }
    : DEFAULT_MARGINS_TWIPS;

  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.title, font: DOCX_FONT, size: 32, bold: true })], heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, spacing: { after: 200 } }));
  children.push(...viewModel.metadata.map(item => metadataParagraph(item, bodySize)));
  if (options.pageBreakAfterMetadata) children.push(new Paragraph({ children: [new PageBreak()] }));

  for (const section of viewModel.sections) {
    children.push(new Paragraph({ children: [new TextRun({ text: section.heading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(...section.paragraphs.map(p => textParagraph(p, { size: bodySize, lineSpacing })));
  }

  for (const table of viewModel.tables) {
    children.push(new Paragraph({ children: [new TextRun({ text: table.heading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(docxTable(table));
  }

  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.traceabilityHeading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } }));
  children.push(...viewModel.traceability.map(item => metadataParagraph(item, bodySize)));
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.footer, font: DOCX_FONT, size: 18, italics: true })], spacing: { before: 300 } }));

  const landscape = options.layout === 'landscape';
  const [width, height] = landscape ? [16838, 11906] : [11906, 16838];
  const document = new Document({
    sections: [{
      properties: { page: { size: { width, height }, margin: margins } },
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
const PDF_BODY_SIZE = 10;
const PDF_HEADING_SIZE = 13;

const MM_TO_PT = 72 / 25.4;
function mmToPt(mm: number): number { return Math.round(mm * MM_TO_PT); }

interface PdfMargins { top: number; bottom: number; left: number; right: number }

export async function renderGenericPdf(viewModel: GenericDocumentViewModel, options: RenderOptions = {}): Promise<Buffer> {
  const landscape = options.layout === 'landscape';
  const margins: PdfMargins = options.formatting?.marginsMm
    ? {
      top: mmToPt(options.formatting.marginsMm.top), bottom: mmToPt(options.formatting.marginsMm.bottom),
      left: mmToPt(options.formatting.marginsMm.left), right: mmToPt(options.formatting.marginsMm.right),
    }
    : { top: PDF_MARGIN, bottom: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN };
  const bodySize = options.formatting?.bodyFontSizePt ?? PDF_BODY_SIZE;
  const headingSize = options.formatting?.headingFontSizePt ?? PDF_HEADING_SIZE;
  // PDFKit has no native "line spacing multiplier" for wrapped text (unlike DOCX's
  // spacing.line) - approximated as extra gap between wrapped lines, proportional to the
  // resolved body font size, so e.g. thesis_report's 1.5 genuinely reads roomier than
  // conference_paper's 1.0 without claiming exact DOCX-equivalent typographic line-height.
  const lineGap = options.formatting?.lineSpacing ? Math.round(bodySize * (options.formatting.lineSpacing - 1)) : 0;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margins, bufferPages: true });
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
            .text(`Страница ${i + 1} из ${pages.count}`, margins.left, doc.page.height - margins.bottom + 20, { width: doc.page.width - margins.left - margins.right, align: 'center' });
        }
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);

      const contentWidth = doc.page.width - margins.left - margins.right;

      doc.font('Bold').fontSize(16).fillColor('#000000').text(viewModel.title, { width: contentWidth });
      doc.moveDown(0.5);
      doc.font('Body').fontSize(bodySize);
      for (const item of viewModel.metadata) {
        doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
      }
      doc.moveDown(0.5);
      if (options.pageBreakAfterMetadata) doc.addPage();

      for (const section of viewModel.sections) {
        ensureSpace(doc, 40, margins);
        doc.font('Bold').fontSize(headingSize).text(section.heading, { width: contentWidth });
        doc.moveDown(0.3);
        doc.font('Body').fontSize(bodySize);
        for (const paragraph of section.paragraphs) {
          ensureSpace(doc, 14, margins);
          doc.text(paragraph, { width: contentWidth, align: 'left', lineGap });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.4);
      }

      for (const table of viewModel.tables) {
        ensureSpace(doc, 40, margins);
        doc.font('Bold').fontSize(headingSize).text(table.heading, { width: contentWidth });
        doc.moveDown(0.3);
        drawTable(doc, table, contentWidth, margins);
        doc.moveDown(0.4);
      }

      ensureSpace(doc, 60, margins);
      doc.font('Bold').fontSize(headingSize).text(viewModel.traceabilityHeading, { width: contentWidth });
      doc.moveDown(0.3);
      doc.font('Body').fontSize(bodySize);
      for (const item of viewModel.traceability) {
        doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
      }
      doc.moveDown(0.5);
      doc.font('Body').fontSize(8).fillColor('#666666').text(viewModel.footer, { width: contentWidth });

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Не удалось сформировать PDF.'));
    }
  });
}

function ensureSpace(doc: PDFKit.PDFDocument, minHeight: number, margins: PdfMargins): void {
  if (doc.y + minHeight > doc.page.height - margins.bottom) doc.addPage();
}

function drawTable(doc: PDFKit.PDFDocument, table: ExportTable, contentWidth: number, margins: PdfMargins): void {
  const columnWidth = contentWidth / table.columns.length;
  const rows = table.rows.length > 0 ? table.rows : [table.columns.map(() => DASH)];

  function drawHeader(): void {
    const startY = doc.y;
    doc.font('Bold').fontSize(8);
    const rowHeight = Math.max(...table.columns.map(col => doc.heightOfString(col, { width: columnWidth - 6 }))) + 8;
    doc.rect(margins.left, startY, contentWidth, rowHeight).fill('#E2E2E2');
    doc.fillColor('#000000');
    table.columns.forEach((col, i) => {
      doc.text(col, margins.left + i * columnWidth + 3, startY + 4, { width: columnWidth - 6 });
    });
    doc.y = startY + rowHeight;
  }

  drawHeader();
  doc.font('Body').fontSize(8);

  for (const row of rows) {
    const rowHeight = Math.max(...row.map(cell => doc.heightOfString(cell || DASH, { width: columnWidth - 6 }))) + 8;
    if (doc.y + rowHeight > doc.page.height - margins.bottom) {
      doc.addPage();
      drawHeader();
      doc.font('Body').fontSize(8);
    }
    const startY = doc.y;
    row.forEach((cell, i) => {
      doc.text(cell || DASH, margins.left + i * columnWidth + 3, startY + 4, { width: columnWidth - 6 });
    });
    doc.y = startY + rowHeight;
  }
}
