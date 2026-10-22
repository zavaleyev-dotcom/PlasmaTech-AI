/** Shared, dependency-bounded DOCX/PDF rendering core - extracted from the original TechDoc
 *  Assistant exporter so Scientific Writer's export (and any future workspace export) reuses
 *  the SAME `docx`/`pdfkit` rendering code instead of a second copy. This file knows nothing
 *  about TechDoc OR Scientific Writer specifically - it only ever renders a generic
 *  {title, metadata, sections, tables, traceability, footer} shape. techdoc-export.ts maps its
 *  own richer ViewModel into this shape at the call site; its own public API/behavior is
 *  unchanged (verified by re-running its full existing test suite after this extraction). */

import 'server-only';
import path from 'node:path';
import { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Packer, PageBreak, AlignmentType, VerticalAlign, TabStopType, Tab, ShadingType } from 'docx';
import PDFDocument from 'pdfkit';
import type { MdBlock, InlineRun } from './scientific-markdown';

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

/** `blocks` (optional) is the rich form of the same content - real headings, bold/italic runs
 *  and lists. Renderers use it when present; `paragraphs` stays the plain-text equivalent that
 *  every existing caller (TechDoc) provides and that tests read. An empty `heading` renders no
 *  heading at all (the content is already self-structured by `blocks`). */
export interface ExportSection { heading: string; paragraphs: string[]; blocks?: Exclude<MdBlock, { kind: 'title-label' }>[] }
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
  /** 'top' (default, TechDoc): `metadata` is printed right under the title. 'appendix': the
   *  document starts with the title and the content only; `metadata` is printed together with
   *  `traceability`, under `traceabilityHeading`, on a new page after the content - so service
   *  information is never mixed into the body of the document. */
  metadataPlacement?: 'top' | 'appendix';
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

const DOCX_MONO_FONT = 'Courier New'; // code and inline code: fixed-width, spaces significant
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

function docxRuns(runs: InlineRun[], size: number): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    run.text.split('\n').forEach((line, index) => {
      out.push(new TextRun({ text: line, font: run.code ? DOCX_MONO_FONT : DOCX_FONT, size, bold: run.bold, italics: run.italic, ...(index > 0 ? { break: 1 } : {}) }));
    });
  }
  return out;
}

const DOCX_HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

function docxBlocks(blocks: NonNullable<ExportSection['blocks']>, bodySize: number, headingSize: number, lineSpacing: number | undefined): Paragraph[] {
  const spacingLine = lineSpacing ? { line: Math.round(240 * lineSpacing), lineRule: 'auto' as const } : {};
  const out: Paragraph[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const size = block.level === 1 ? headingSize : block.level === 2 ? Math.max(bodySize + 2, headingSize - 2) : bodySize;
      out.push(new Paragraph({
        children: block.runs.map(r => new TextRun({ text: r.text, font: DOCX_FONT, size, bold: true, italics: r.italic })),
        heading: DOCX_HEADINGS[block.level - 1], spacing: { before: 200, after: 100 }, keepNext: true,
      }));
    } else if (block.kind === 'paragraph') {
      out.push(new Paragraph({ children: docxRuns(block.runs, bodySize), spacing: { after: 100, ...spacingLine } }));
    } else if (block.kind === 'code') {
      const codeLines = block.text.split('\n');
      codeLines.forEach((line, index) => {
        // One paragraph per line: every space is kept (the docx writer marks the text as
        // space-preserving) and each tab becomes a real Word tab, never collapsed.
        const children = line.split('\t').flatMap((part, i) => (i === 0 ? [part] : [new Tab(), part]));
        out.push(new Paragraph({
          children: [new TextRun({ children, font: DOCX_MONO_FONT, size: Math.max(bodySize - 2, 16) })],
          shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' }, keepLines: true,
          spacing: { after: index === codeLines.length - 1 ? 120 : 0 },
        }));
      });
    } else {
      for (const item of block.items) {
        out.push(new Paragraph({
          children: [new TextRun({ text: `${item.marker}\t`, font: DOCX_FONT, size: bodySize }), ...docxRuns(item.runs, bodySize)],
          indent: { left: 567, hanging: 283 }, tabStops: [{ type: TabStopType.LEFT, position: 567 }], spacing: { after: 60, ...spacingLine },
        }));
      }
    }
  }
  return out;
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
  const appendix = viewModel.metadataPlacement === 'appendix';
  if (!appendix) children.push(...viewModel.metadata.map(item => metadataParagraph(item, bodySize)));
  if (options.pageBreakAfterMetadata) children.push(new Paragraph({ children: [new PageBreak()] }));

  for (const section of viewModel.sections) {
    if (section.heading) children.push(new Paragraph({ children: [new TextRun({ text: section.heading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    if (section.blocks) children.push(...docxBlocks(section.blocks, bodySize, headingSize, lineSpacing));
    else children.push(...section.paragraphs.map(p => textParagraph(p, { size: bodySize, lineSpacing })));
  }

  for (const table of viewModel.tables) {
    children.push(new Paragraph({ children: [new TextRun({ text: table.heading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 100 } }));
    children.push(docxTable(table));
  }

  children.push(new Paragraph({ children: [new TextRun({ text: viewModel.traceabilityHeading, font: DOCX_FONT, size: headingSize, bold: true })], heading: HeadingLevel.HEADING_1, pageBreakBefore: appendix, spacing: { before: 300, after: 100 } }));
  if (appendix) children.push(...viewModel.metadata.map(item => metadataParagraph(item, bodySize)));
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
const PDF_FONT_MONO = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSansMono.ttf');
const PDF_FONT_ITALIC = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans-Oblique.ttf');
const PDF_FONT_BOLD_ITALIC = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSans-BoldOblique.ttf');
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
      doc.registerFont('Mono', PDF_FONT_MONO);
      doc.registerFont('Italic', PDF_FONT_ITALIC);
      doc.registerFont('BoldItalic', PDF_FONT_BOLD_ITALIC);
      doc.font('Body');

      const chunks: Buffer[] = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const contentWidth = doc.page.width - margins.left - margins.right;

      doc.font('Bold').fontSize(16).fillColor('#000000').text(viewModel.title, { width: contentWidth });
      doc.moveDown(0.5);
      doc.font('Body').fontSize(bodySize);
      const appendix = viewModel.metadataPlacement === 'appendix';
      if (!appendix) {
        for (const item of viewModel.metadata) {
          doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
        }
        doc.moveDown(0.5);
      }
      if (options.pageBreakAfterMetadata) doc.addPage();

      for (const section of viewModel.sections) {
        if (section.heading) {
          ensureSpace(doc, 40, margins);
          doc.font('Bold').fontSize(headingSize).text(section.heading, { width: contentWidth });
          doc.moveDown(0.3);
        }
        doc.font('Body').fontSize(bodySize);
        if (section.blocks) {
          pdfBlocks(doc, section.blocks, { contentWidth, margins, bodySize, headingSize, lineGap });
        } else {
          for (const paragraph of section.paragraphs) {
            ensureSpace(doc, 14, margins);
            doc.text(paragraph, { width: contentWidth, align: 'left', lineGap });
            doc.moveDown(0.2);
          }
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

      if (appendix) doc.addPage(); else ensureSpace(doc, 60, margins);
      doc.font('Bold').fontSize(headingSize).text(viewModel.traceabilityHeading, { width: contentWidth });
      doc.moveDown(0.3);
      doc.font('Body').fontSize(bodySize);
      if (appendix) {
        for (const item of viewModel.metadata) {
          doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
        }
      }
      for (const item of viewModel.traceability) {
        doc.font('Bold').text(`${item.label}: `, { continued: true, width: contentWidth }).font('Body').text(item.value);
      }
      doc.moveDown(0.5);
      doc.font('Body').fontSize(8).fillColor('#666666').text(viewModel.footer, { width: contentWidth });

      // F16: page numbers must be stamped onto the buffered pages BEFORE doc.end() finalizes
      // the document - switchToPage()/text() calls made after end() (e.g. inside the 'end'
      // stream event) happen once PDFKit has already flushed and closed each page, so they
      // never reach the actual output. This must run for every document, single-page included.
      // Writing INTO the bottom margin also needs PDFKit's own documented workaround: with the
      // real bottom margin still in effect, .text() sees the target y as being past the usable
      // content area and silently triggers an extra addPage() instead of drawing there - so the
      // margin is zeroed only for the duration of this one stamp, then restored.
      const pages = doc.bufferedPageRange();
      for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i);
        const restoreBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Body').fontSize(8).fillColor('#666666')
          .text(`Страница ${i + 1} из ${pages.count}`, margins.left, doc.page.height - margins.bottom + 20, { width: doc.page.width - margins.left - margins.right, align: 'center', lineBreak: false });
        doc.page.margins.bottom = restoreBottomMargin;
      }

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Не удалось сформировать PDF.'));
    }
  });
}

function pdfFontFor(run: InlineRun, base: 'Body' | 'Bold' = 'Body'): string {
  if (run.code) return 'Mono';
  const bold = run.bold || base === 'Bold';
  return bold && run.italic ? 'BoldItalic' : bold ? 'Bold' : run.italic ? 'Italic' : 'Body';
}

/** Writes bold/italic runs as ONE wrapped paragraph (PDFKit's `continued` chaining). */
function pdfRuns(doc: PDFKit.PDFDocument, runs: InlineRun[], opts: { width: number; lineGap?: number; base?: 'Body' | 'Bold' }): void {
  const visible = runs.filter(r => r.text !== '');
  visible.forEach((run, index) => {
    doc.font(pdfFontFor(run, opts.base)).text(run.text, { continued: index < visible.length - 1, width: opts.width, align: 'left', lineGap: opts.lineGap ?? 0 });
  });
  if (visible.length === 0) doc.text('', { width: opts.width });
}

const PDF_LIST_INDENT = 16;

function pdfBlocks(
  doc: PDFKit.PDFDocument, blocks: NonNullable<ExportSection['blocks']>,
  ctx: { contentWidth: number; margins: PdfMargins; bodySize: number; headingSize: number; lineGap: number },
): void {
  for (const block of blocks) {
    if (block.kind === 'heading') {
      ensureSpace(doc, 40, ctx.margins);
      const size = block.level === 1 ? ctx.headingSize : block.level === 2 ? Math.max(ctx.bodySize + 2, ctx.headingSize - 2) : ctx.bodySize + 1;
      doc.moveDown(0.3).fontSize(size);
      pdfRuns(doc, block.runs, { width: ctx.contentWidth, base: 'Bold' });
      doc.moveDown(0.3).font('Body').fontSize(ctx.bodySize);
    } else if (block.kind === 'paragraph') {
      ensureSpace(doc, 14, ctx.margins);
      pdfRuns(doc, block.runs, { width: ctx.contentWidth, lineGap: ctx.lineGap });
      doc.moveDown(0.2);
    } else if (block.kind === 'code') {
      doc.font('Mono').fontSize(Math.max(ctx.bodySize - 1, 7));
      for (const line of block.text.split('\n')) {
        ensureSpace(doc, 12, ctx.margins);
        // A tab cannot be positioned in PDF text: shown as 4 spaces (display only).
        doc.text(line === '' ? ' ' : line.replace(/\t/g, '    '), ctx.margins.left + 8, doc.y, { width: ctx.contentWidth - 8, lineGap: 0 });
      }
      doc.x = ctx.margins.left;
      doc.font('Body').fontSize(ctx.bodySize).moveDown(0.3);
    } else {
      for (const item of block.items) {
        ensureSpace(doc, 14, ctx.margins);
        const left = ctx.margins.left;
        const top = doc.y;
        doc.font('Body').text(item.marker, left, top, { width: PDF_LIST_INDENT, lineBreak: false });
        doc.x = left + PDF_LIST_INDENT;
        doc.y = top;
        pdfRuns(doc, item.runs, { width: ctx.contentWidth - PDF_LIST_INDENT, lineGap: ctx.lineGap });
        doc.x = left;
        doc.moveDown(0.1);
      }
      doc.moveDown(0.1);
    }
  }
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
