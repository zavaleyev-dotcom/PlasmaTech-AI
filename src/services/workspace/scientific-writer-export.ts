/** Server-only DOCX/PDF export for Scientific Writer results - reuses the SAME shared renderer
 *  (document-export.ts) that TechDoc Assistant's export uses, so there is only ever one DOCX/
 *  PDF rendering implementation in this project, not two. This file only ever formats data the
 *  CLIENT already has and sends verbatim (whatever is currently shown on screen: either the
 *  local, non-AI scaffold or the AI-generated result) - it never regenerates, calls the AI
 *  provider, or invents content for a missing section. A section with no data still says
 *  "Недостаточно данных", exactly as shown on screen. */

import 'server-only';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentType } from './scientific-writer';
import { EXPORT_FORMATS, type ExportFormat } from './techdoc-export-types';
import { renderGenericDocx, renderGenericPdf, sanitizeFilenameSegment, type GenericDocumentViewModel, type ExportSection, type ExportMetadataItem } from './document-export';

export { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, EXPORT_FORMATS, type DocumentType, type ExportFormat };

const NOT_SET = 'не задано';

function show(value: string | undefined): string { return value !== undefined && value.trim() !== '' ? value : NOT_SET; }

const FILENAME_SEGMENT: Record<DocumentType, string> = {
  article: 'article',
  conference_abstract: 'conference-abstract',
  annotation: 'annotation',
  introduction: 'introduction',
  grant_proposal: 'grant-proposal',
  technical_report: 'technical-report',
};

// ---------- the export request: exactly what the client currently has on screen ----------

export interface ScientificExportSection { heading: string; text: string }

export interface ScientificExportRequest {
  documentType: DocumentType;
  /** The user's own title/topic field - used for the document title and filename, never
   *  invented if absent. */
  title?: string;
  /** True only when `sections` came from a real AI provider response; false when they came
   *  from the local (non-AI) scaffold - shown explicitly in the exported document so it is
   *  never mistaken for a verified/AI-written result. */
  generatedByAI: boolean;
  sections: ScientificExportSection[];
  providedFields: string[];
  missingFields: string[];
  warnings: string[];
}

export function buildExportFilename(request: ScientificExportRequest, format: ExportFormat): string {
  const titleSegment = sanitizeFilenameSegment(request.title ?? '', 'document');
  return `${titleSegment}_${FILENAME_SEGMENT[request.documentType]}.${format}`;
}

function splitParagraphs(text: string): string[] {
  const parts = text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text.trim() || NOT_SET];
}

/** Validates the CONTENT of an already-shaped request - not its JSON shape (see
 *  parseExportRequest for that). Rejects an "empty result" (item 14): exporting is refused
 *  when there is genuinely nothing to export, rather than producing a blank document. */
export function validateExportRequest(request: ScientificExportRequest): void {
  if (request.sections.length === 0) throw new Error('Нет данных для экспорта: сначала сформируйте черновик или локальную структуру.');
  const hasRealContent = request.sections.some(s => s.text.trim() && s.text.trim() !== NOT_SET && s.text.trim().toLocaleLowerCase() !== 'недостаточно данных');
  if (!hasRealContent) throw new Error('Нет данных для экспорта: во всех разделах указано "Недостаточно данных".');
}

// ---------- ScientificWriterResult -> ScientificDocumentViewModel -> generic renderer ----------

export function buildScientificDocumentViewModel(request: ScientificExportRequest): GenericDocumentViewModel {
  const typeLabel = DOCUMENT_TYPE_LABELS[request.documentType];
  const title = request.title ? `${typeLabel}: ${request.title}` : typeLabel;

  const metadata: ExportMetadataItem[] = [
    { label: 'Тип документа', value: typeLabel },
    { label: 'Тема', value: show(request.title) },
    { label: 'Источник текста', value: request.generatedByAI ? 'сгенерировано ИИ - требует проверки автором' : 'локальная структура, без ИИ-генерации' },
  ];

  const sections: ExportSection[] = request.sections.map(s => ({ heading: s.heading, paragraphs: splitParagraphs(s.text) }));

  const traceability: ExportMetadataItem[] = [
    { label: 'Предоставленные пользователем данные', value: request.providedFields.length ? request.providedFields.join(', ') : NOT_SET },
    { label: 'Не заданные данные', value: request.missingFields.length ? request.missingFields.join(', ') : '—' },
    { label: 'Предупреждения проверки', value: request.warnings.length ? request.warnings.join('; ') : 'нет' },
  ];

  return {
    title,
    metadata,
    sections,
    tables: [],
    traceability,
    traceabilityHeading: 'Происхождение данных',
    footer: 'Scientific Writer не заменяет проверку научных фактов: любые утверждения, цифры, цитаты и ссылки должны быть проверены автором перед публикацией. Система не создаёт вымышленные ссылки, DOI, авторов или журналы.',
  };
}

export interface ExportResult { buffer: Buffer; filename: string; contentType: string }

const CONTENT_TYPE: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

export async function exportScientificDocument(request: ScientificExportRequest, format: ExportFormat): Promise<ExportResult> {
  validateExportRequest(request);
  const viewModel = buildScientificDocumentViewModel(request);
  const buffer = format === 'docx' ? await renderGenericDocx(viewModel) : await renderGenericPdf(viewModel);
  return { buffer, filename: buildExportFilename(request, format), contentType: CONTENT_TYPE[format] };
}

// ---------- server-side parsing of untrusted client JSON ----------

const MAX_TITLE = 500;
const MAX_SECTION_TEXT = 20_000;
const MAX_SECTIONS = 20;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_LEN = 300;

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
function asRequiredString(value: unknown, label: string, maxLen: number): string {
  if (typeof value !== 'string') throw new Error(`${label}: обязательное строковое поле.`);
  if (value.length > maxLen) throw new Error(`${label}: текст слишком длинный (максимум ${maxLen} символов).`);
  return value;
}
function asOptionalString(value: unknown, label: string, maxLen: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return asRequiredString(value, label, maxLen);
}
function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}: ожидается логическое значение.`);
  return value;
}
function asStringArray(value: unknown, label: string): string[] {
  return asArray(value, label, MAX_LIST_ITEMS).map((v, i) => asRequiredString(v, `${label}[${i}]`, MAX_LIST_ITEM_LEN));
}
function asSection(value: unknown, index: number): ScientificExportSection {
  const o = asObject(value, `Раздел[${index}]`);
  return {
    heading: asRequiredString(o.heading, `Раздел[${index}]: заголовок`, MAX_TITLE),
    text: asRequiredString(o.text ?? '', `Раздел[${index}]: текст`, MAX_SECTION_TEXT),
  };
}

/** Rebuilds a ScientificExportRequest from arbitrary, untrusted JSON - every field is read by
 *  name and type/length/array-size checked; nothing is ever spread wholesale from the input. */
export function parseExportRequest(raw: unknown): ScientificExportRequest {
  const o = asObject(raw, 'Запрос экспорта');
  if (typeof o.documentType !== 'string' || !DOCUMENT_TYPES.includes(o.documentType as DocumentType)) {
    throw new Error(`Тип документа: недопустимое значение. Допустимо: ${DOCUMENT_TYPES.join(', ')}.`);
  }
  const sectionsRaw = asArray(o.sections, 'Разделы', MAX_SECTIONS);
  return {
    documentType: o.documentType as DocumentType,
    title: asOptionalString(o.title, 'Тема', MAX_TITLE),
    generatedByAI: asBoolean(o.generatedByAI ?? false, 'Признак ИИ-генерации'),
    sections: sectionsRaw.map((s, i) => asSection(s, i)),
    providedFields: asStringArray(o.providedFields, 'Предоставленные данные'),
    missingFields: asStringArray(o.missingFields, 'Не заданные данные'),
    warnings: asStringArray(o.warnings, 'Предупреждения'),
  };
}

export function parseExportFormat(value: unknown): ExportFormat {
  if (typeof value !== 'string' || !EXPORT_FORMATS.includes(value as ExportFormat)) {
    throw new Error(`Формат файла: недопустимое значение. Допустимо: ${EXPORT_FORMATS.join(', ')}.`);
  }
  return value as ExportFormat;
}
