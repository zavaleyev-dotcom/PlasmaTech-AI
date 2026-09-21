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

export interface RenderOptions {
  layout?: 'portrait' | 'landscape';
  /** Insert a page break right after the metadata block, before the first section - used for
   *  long, multi-section prose documents where a clean break reads better. */
  pageBreakAfterMetadata?: boolean;
}

// ---------- DOCX renderer ----------

const DOCX_FONT = 'Times New Roman'; // ships with every Word install and renders Cyrillic natively
const BODY_SIZE = 22; // half-points -> 11pt
const SMALL_SIZE = 18; // 9pt, for table cells

function textParagraph(text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph {
  return new Paragraph({ children: [new TextRun({ text, font: DOCX_FONT, size: opts.size ?? BODY_SIZE, bold: opts.bold })], spacing: { after: 100 } });
}

function metadataParagraph(item: ExportMetadataItem): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${item.label}: `, font: DOCX_FONT, size: BODY_SIZE, bold: true }),
      new TextRun({ text: item.value, font: DOCX_FONT, size: BODY_SIZE }),
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
  const children: (Paragraph | Table)[] = [];
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.title, font: DOCX_FONT, size: 32, bold: true })], heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, spacing: { after: 200 } }));
  children.push(...viewModel.metadata.map(metadataParagraph));
  if (options.pageBreakAfterMetadata) children.push(new Paragraph({ children: [new PageBreak()] }));

  for (const section of viewModel.sections) {
    children.push(new Paragraph({ children: [new TextRun({ text: section.heading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(...section.paragraphs.map(p => textParagraph(p)));
  }

  for (const table of viewModel.tables) {
    children.push(new Paragraph({ children: [new TextRun({ text: table.heading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(docxTable(table));
  }

  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.traceabilityHeading, font: DOCX_FONT, size: 26, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 100 } }));
  children.push(...viewModel.traceability.map(metadataParagraph));
  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.footer, font: DOCX_FONT, size: 18, italics: true })], spacing: { before: 300 } }));

  const landscape = options.layout === 'landscape';
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

export async function renderGenericPdf(viewModel: GenericDocumentViewModel, options: RenderOptions = {}): Promise<Buffer> {
  const landscape = options.layout === 'landscape';
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
      if (options.pageBreakAfterMetadata) doc.addPage();

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

function ensureSpace(doc: PDFKit.PDFDocument, minHeight: number): void {
  if (doc.y + minHeight > doc.page.height - PDF_MARGIN) doc.addPage();
}

function drawTable(doc: PDFKit.PDFDocument, table: ExportTable, contentWidth: number): void {
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
