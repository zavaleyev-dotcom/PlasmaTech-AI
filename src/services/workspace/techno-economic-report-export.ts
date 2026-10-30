/** Server side of the Techno-Economic report export: the view model of techno-economic-report.ts rendered to DOCX or PDF by the SAME shared renderer
 *  (document-export.ts) the other workspace exports use. DOCX and PDF come from one view model, so they carry the same content. */

import 'server-only';
import { buildTeaReport, reportFilename, ReportInputError, type TeaReportRequest } from './techno-economic-report';
import { renderGenericDocx, renderGenericPdf, sanitizeFilenameSegment, type GenericDocumentViewModel } from './document-export';

export const REPORT_FORMATS = ['docx', 'pdf'] as const;
export type ReportFormat = typeof REPORT_FORMATS[number];

export const CONTENT_TYPE: Record<ReportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export function parseExportFormat(value: unknown): ReportFormat {
  if (typeof value !== 'string' || !(REPORT_FORMATS as readonly string[]).includes(value)) throw new ReportInputError(`Формат файла: недопустимое значение. Допустимо: ${REPORT_FORMATS.join(', ')}.`);
  return value as ReportFormat;
}

export interface ReportFile { buffer: Buffer; filename: string; contentType: string }

/** Step 1 - content: validates the request (throws ReportInputError with a user-facing message for unusable inputs) and builds the document. */
export function prepareTeaReport(request: TeaReportRequest, now: Date = new Date()): { viewModel: GenericDocumentViewModel; filenameBase: (format: ReportFormat) => string } {
  const viewModel = buildTeaReport(request, now);
  return { viewModel, filenameBase: format => reportFilename(request, now, format, sanitizeFilenameSegment) };
}

/** Step 2 - rendering: title page (title + metadata) on its own page, then the sections. A failure here is an INTERNAL error, never the user's input. */
export async function renderTeaReport(viewModel: GenericDocumentViewModel, format: ReportFormat): Promise<Buffer> {
  const options = { layout: 'portrait' as const, pageBreakAfterMetadata: true };
  return format === 'docx' ? renderGenericDocx(viewModel, options) : renderGenericPdf(viewModel, options);
}

/** Both steps in one call (`now` is injectable so a test can fix the date). */
export async function exportTeaReport(request: TeaReportRequest, format: ReportFormat, now: Date = new Date()): Promise<ReportFile> {
  const { viewModel, filenameBase } = prepareTeaReport(request, now);
  return { buffer: await renderTeaReport(viewModel, format), filename: filenameBase(format), contentType: CONTENT_TYPE[format] };
}
