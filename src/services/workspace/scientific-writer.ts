/** Real, local, dependency-free core logic for the Scientific Writer workspace module - no
 *  fabricated citations, DOIs, authors, journals, or experimental results, ever. Every function
 *  here is pure and browser-safe (no server-only imports, no network calls) so both the UI and
 *  the server-side generation route share the exact same validation/structure/prompt logic.
 *  The actual AI text generation (when configured) lives in scientific-writer-provider.ts,
 *  which is server-only - this file only ever prepares requests and checks their results, it
 *  never talks to a network. */

// ---------- enumerations ----------

export const DOCUMENT_TYPES = ['article', 'conference_abstract', 'annotation', 'introduction', 'grant_proposal', 'technical_report'] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export const WRITER_MODES = ['draft', 'rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'] as const;
export type WriterMode = typeof WRITER_MODES[number];

export const LANGUAGES = ['ru', 'en'] as const;
export type Language = typeof LANGUAGES[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  article: 'Научная статья',
  conference_abstract: 'Тезисы конференции',
  annotation: 'Аннотация',
  introduction: 'Введение',
  grant_proposal: 'Грантовая заявка / раздел заявки',
  technical_report: 'Научно-технический отчёт',
};

export const WRITER_MODE_LABELS: Record<WriterMode, string> = {
  draft: 'Создать черновик',
  rewrite: 'Переписать / улучшить текст',
  edit: 'Научное редактирование',
  translate_ru_en: 'RU → EN научный перевод',
  translate_en_ru: 'EN → RU научный перевод',
};

const REWRITE_LIKE_MODES: readonly WriterMode[] = ['rewrite', 'edit', 'translate_ru_en', 'translate_en_ru'];

// ---------- input model ----------

export interface ScientificWriterInput {
  documentType: DocumentType;
  mode: WriterMode;
  targetLanguage: Language;
  title?: string;
  researchField?: string;
  goal?: string;
  researchObject?: string;
  methods?: string;
  results?: string;
  conclusions?: string;
  keywords?: string;
  sourceText?: string;
  additionalRequirements?: string;
}

// ---------- validation (item 10) ----------

const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 20_000;
const MAX_TOTAL_TEXT = 60_000;

function checkLen(value: string | undefined, label: string, maxLen: number): void {
  if (value !== undefined && value.length > maxLen) {
    throw new Error(`${label}: слишком длинный текст (максимум ${maxLen} символов).`);
  }
}

function assertOneOf<T extends string>(value: T, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value)) throw new Error(`${label}: недопустимое значение. Допустимо: ${allowed.join(', ')}.`);
  return value;
}

/** Rejects: invalid enums, an empty request for the selected mode, and text that is too long -
 *  either per field or in total. Never silently truncates or drops a field. */
export function validateInput(input: ScientificWriterInput): void {
  assertOneOf(input.documentType, DOCUMENT_TYPES, 'Тип документа');
  assertOneOf(input.mode, WRITER_MODES, 'Режим работы');
  assertOneOf(input.targetLanguage, LANGUAGES, 'Целевой язык');

  checkLen(input.title, 'Название/тема', MAX_SHORT_TEXT);
  checkLen(input.researchField, 'Область исследования', MAX_SHORT_TEXT);
  checkLen(input.keywords, 'Ключевые слова', MAX_SHORT_TEXT);
  checkLen(input.goal, 'Цель', MAX_LONG_TEXT);
  checkLen(input.researchObject, 'Объект исследования', MAX_LONG_TEXT);
  checkLen(input.methods, 'Методы', MAX_LONG_TEXT);
  checkLen(input.results, 'Основные результаты', MAX_LONG_TEXT);
  checkLen(input.conclusions, 'Выводы', MAX_LONG_TEXT);
  checkLen(input.sourceText, 'Исходный текст', MAX_LONG_TEXT);
  checkLen(input.additionalRequirements, 'Дополнительные требования', MAX_LONG_TEXT);

  const totalLength = [input.title, input.researchField, input.goal, input.researchObject, input.methods, input.results, input.conclusions, input.keywords, input.sourceText, input.additionalRequirements]
    .reduce((sum, v) => sum + (v?.length ?? 0), 0);
  if (totalLength > MAX_TOTAL_TEXT) throw new Error(`Суммарный объём введённого текста слишком велик (максимум ${MAX_TOTAL_TEXT} символов).`);

  if (REWRITE_LIKE_MODES.includes(input.mode)) {
    if (!input.sourceText || !input.sourceText.trim()) throw new Error('Исходный текст: для этого режима обязателен.');
  } else {
    const hasAnyField = [input.title, input.goal, input.researchObject, input.methods, input.results, input.conclusions].some(v => v && v.trim());
    if (!hasAnyField) throw new Error('Заполните хотя бы одно поле (тема, цель, объект, методы, результаты или выводы) для создания черновика.');
  }
}

// ---------- evidence tracking (item 4/12): what the user actually gave us ----------

type EvidenceKey = 'title' | 'researchField' | 'goal' | 'researchObject' | 'methods' | 'results' | 'conclusions' | 'keywords';

export interface EvidenceField { key: EvidenceKey; label: string; provided: boolean; value?: string }
export interface EvidenceReport { fields: EvidenceField[]; provided: string[]; missing: string[] }

const EVIDENCE_FIELD_DEFS: { key: EvidenceKey; label: string }[] = [
  { key: 'title', label: 'Название/тема' },
  { key: 'researchField', label: 'Область исследования' },
  { key: 'goal', label: 'Цель' },
  { key: 'researchObject', label: 'Объект исследования' },
  { key: 'methods', label: 'Методы' },
  { key: 'results', label: 'Основные результаты' },
  { key: 'conclusions', label: 'Выводы' },
  { key: 'keywords', label: 'Ключевые слова' },
];

/** The single source of truth for "what did the user actually tell us" - every downstream
 *  piece (local scaffold, AI prompt, missing-data placeholders) reads from this, never from
 *  raw fields directly, so a field that was never filled in can never quietly become
 *  "generated" content. */
export function buildEvidenceReport(input: ScientificWriterInput): EvidenceReport {
  const fields = EVIDENCE_FIELD_DEFS.map(def => {
    const raw = input[def.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    return { key: def.key, label: def.label, provided: value.length > 0, value: value || undefined };
  });
  return { fields, provided: fields.filter(f => f.provided).map(f => f.label), missing: fields.filter(f => !f.provided).map(f => f.label) };
}

export const NOT_ENOUGH_DATA = 'Недостаточно данных';
export const NOT_SET = 'Не задано';

// ---------- document structure (item 5) ----------

export interface DocumentSection { id: string; heading: string; requiredEvidenceKeys: EvidenceKey[] }

export const DOCUMENT_STRUCTURES: Record<DocumentType, DocumentSection[]> = {
  article: [
    { id: 'title', heading: 'Title', requiredEvidenceKeys: ['title'] },
    { id: 'abstract', heading: 'Abstract', requiredEvidenceKeys: ['goal', 'methods', 'results', 'conclusions'] },
    { id: 'keywords', heading: 'Keywords', requiredEvidenceKeys: ['keywords'] },
    { id: 'introduction', heading: 'Introduction', requiredEvidenceKeys: ['researchField', 'goal'] },
    { id: 'methods', heading: 'Materials and Methods', requiredEvidenceKeys: ['methods', 'researchObject'] },
    { id: 'results', heading: 'Results', requiredEvidenceKeys: ['results'] },
    { id: 'discussion', heading: 'Discussion', requiredEvidenceKeys: ['results', 'conclusions'] },
    { id: 'conclusion', heading: 'Conclusion', requiredEvidenceKeys: ['conclusions'] },
  ],
  conference_abstract: [
    { id: 'title', heading: 'Title', requiredEvidenceKeys: ['title'] },
    { id: 'abstract', heading: 'Abstract', requiredEvidenceKeys: ['goal', 'methods', 'results', 'conclusions'] },
    { id: 'keywords', heading: 'Keywords', requiredEvidenceKeys: ['keywords'] },
  ],
  annotation: [
    { id: 'title', heading: 'Title', requiredEvidenceKeys: ['title'] },
    { id: 'annotation', heading: 'Аннотация', requiredEvidenceKeys: ['goal', 'methods', 'results', 'conclusions'] },
  ],
  introduction: [
    { id: 'title', heading: 'Title', requiredEvidenceKeys: ['title'] },
    { id: 'introduction', heading: 'Introduction', requiredEvidenceKeys: ['researchField', 'goal'] },
  ],
  grant_proposal: [
    { id: 'title', heading: 'Название проекта', requiredEvidenceKeys: ['title'] },
    { id: 'relevance', heading: 'Актуальность / проблема', requiredEvidenceKeys: ['researchField', 'goal'] },
    { id: 'goals', heading: 'Цель и задачи', requiredEvidenceKeys: ['goal'] },
    { id: 'methods', heading: 'Методы', requiredEvidenceKeys: ['methods'] },
    { id: 'expected_results', heading: 'Ожидаемые результаты', requiredEvidenceKeys: ['results'] },
    { id: 'significance', heading: 'Значимость', requiredEvidenceKeys: ['conclusions'] },
  ],
  technical_report: [
    { id: 'title', heading: 'Название', requiredEvidenceKeys: ['title'] },
    { id: 'purpose', heading: 'Цель работы', requiredEvidenceKeys: ['goal'] },
    { id: 'object', heading: 'Объект', requiredEvidenceKeys: ['researchObject'] },
    { id: 'methods', heading: 'Методы', requiredEvidenceKeys: ['methods'] },
    { id: 'results', heading: 'Результаты', requiredEvidenceKeys: ['results'] },
    { id: 'conclusions', heading: 'Выводы', requiredEvidenceKeys: ['conclusions'] },
  ],
};

export interface ScaffoldSection { heading: string; text: string; usedFields: string[] }

/** Builds the honest, non-AI fallback: the user's OWN words, organized into the standard
 *  structure for the chosen document type. A section with no relevant evidence shows
 *  NOT_ENOUGH_DATA instead of inventing content - this never claims to be AI-written prose. */
export function buildLocalScaffold(input: ScientificWriterInput, evidence: EvidenceReport): ScaffoldSection[] {
  const byKey = new Map(evidence.fields.map(f => [f.key, f]));
  return DOCUMENT_STRUCTURES[input.documentType].map(section => {
    const relevant = section.requiredEvidenceKeys.map(key => byKey.get(key)).filter((f): f is EvidenceField => !!f && f.provided);
    if (relevant.length === 0) return { heading: section.heading, text: NOT_ENOUGH_DATA, usedFields: [] };
    const text = relevant.map(f => `${f.label}: ${f.value}`).join('\n');
    return { heading: section.heading, text, usedFields: relevant.map(f => f.label) };
  });
}

// ---------- protected technical vocabulary (item 7) ----------

export const PROTECTED_TECHNICAL_TERMS = [
  'PVD', 'CVD', 'PECVD', 'FCVA', 'ICP/RF', 'ICP', 'RF', 'ta-C',
  'substrate bias', 'deposition rate', 'pressure', 'temperature', 'plasma',
  'coating thickness', 'adhesion', 'tribology', 'etching', 'thin films',
] as const;

// ---------- prompt construction for the real AI provider (item 8) ----------

export interface GenerationPrompt { system: string; user: string }

function modeInstructions(mode: WriterMode, targetLanguage: Language): string {
  switch (mode) {
    case 'draft':
      return 'Задача: подготовить черновик документа СТРОГО на основе перечисленных ниже данных пользователя. Не добавляй факты, цитаты, DOI, авторов, журналы или результаты экспериментов, которых нет в данных. Для разделов без данных напиши "Недостаточно данных".';
    case 'rewrite':
      return 'Задача: переписать и улучшить стиль и структуру предоставленного текста, сохранив технический смысл. Не меняй числовые значения, химические формулы, обозначения оборудования и единицы измерения. Не добавляй новые факты.';
    case 'edit':
      return 'Задача: выполнить научное редактирование предоставленного текста (грамматика, терминология, ясность изложения). Не меняй числовые значения, химические формулы, обозначения оборудования и единицы измерения. Не добавляй новые факты.';
    case 'translate_ru_en':
      return `Задача: выполнить научно-технический перевод предоставленного текста с русского на английский. Сохрани общепринятые международные технические сокращения (${PROTECTED_TECHNICAL_TERMS.join(', ')}) без произвольного перевода. Не меняй числовые значения и единицы измерения.`;
    case 'translate_en_ru':
      return `Задача: выполнить научно-технический перевод предоставленного текста с английского на русский. Сохрани общепринятые международные технические сокращения (${PROTECTED_TECHNICAL_TERMS.join(', ')}) без произвольного перевода. Не меняй числовые значения и единицы измерения.`;
  }
  return `Целевой язык: ${targetLanguage === 'ru' ? 'русский' : 'английский'}.`;
}

export function buildSystemPrompt(mode: WriterMode, targetLanguage: Language): string {
  return [
    'Ты - ассистент для подготовки научно-технических текстов в области физики плазмы, вакуумных и PVD/CVD/PECVD технологий нанесения покрытий.',
    'Категорически запрещено: придумывать цитаты, DOI, библиографические ссылки, авторов, названия журналов, экспериментальные результаты или числовые данные, которых нет в предоставленном пользователем тексте.',
    'Если данных для раздела недостаточно - явно напиши "Недостаточно данных" вместо того, чтобы придумывать содержание.',
    modeInstructions(mode, targetLanguage),
  ].join('\n');
}

/** Lists ONLY what the user actually provided (via EvidenceReport) plus an explicit "missing"
 *  list - the model is never handed a blank slate and told to "fill in" everything itself. */
export function buildUserPrompt(input: ScientificWriterInput, evidence: EvidenceReport): string {
  const lines: string[] = [`Тип документа: ${DOCUMENT_TYPE_LABELS[input.documentType]}`];
  if (REWRITE_LIKE_MODES.includes(input.mode)) {
    lines.push('', '--- Исходный текст пользователя ---', input.sourceText ?? '');
  } else {
    lines.push('', '--- Данные, предоставленные пользователем ---');
    for (const field of evidence.fields) if (field.provided) lines.push(`${field.label}: ${field.value}`);
    lines.push('', `--- Поля, для которых данные НЕ предоставлены (не придумывай их) ---`, evidence.missing.length ? evidence.missing.join(', ') : 'нет');
  }
  if (input.additionalRequirements?.trim()) lines.push('', '--- Дополнительные требования пользователя ---', input.additionalRequirements.trim());
  return lines.join('\n');
}

export function buildGenerationPrompt(input: ScientificWriterInput, evidence: EvidenceReport): GenerationPrompt {
  return { system: buildSystemPrompt(input.mode, input.targetLanguage), user: buildUserPrompt(input, evidence) };
}

// ---------- post-generation safety checks (items 6/7): verify, never trust blindly ----------

const NUMBER_RE = /[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?/g;

export interface PreservationCheck { preservedNumbers: string[]; missingNumbers: string[]; preservedTerms: string[]; missingTerms: string[]; ok: boolean }

/** Confirms every number and every protected technical term present in the ORIGINAL text still
 *  appears verbatim in the EDITED/translated text - a real, checkable guarantee rather than an
 *  assumption about how the model behaved. */
export function checkPreservation(original: string, edited: string): PreservationCheck {
  const numbers = Array.from(new Set(original.match(NUMBER_RE) ?? []));
  const missingNumbers = numbers.filter(n => !edited.includes(n));
  const presentTerms = PROTECTED_TECHNICAL_TERMS.filter(t => original.includes(t));
  const missingTerms = presentTerms.filter(t => !edited.includes(t));
  return {
    preservedNumbers: numbers.filter(n => !missingNumbers.includes(n)),
    missingNumbers,
    preservedTerms: presentTerms.filter(t => !missingTerms.includes(t)),
    missingTerms,
    ok: missingNumbers.length === 0 && missingTerms.length === 0,
  };
}

/** A simple, honest, exact-sentence-match diff summary - counts, never a claim about WHAT
 *  changed semantically (which would itself risk fabricating an interpretation). */
export function summarizeChanges(original: string, edited: string): string[] {
  const splitSentences = (text: string) => text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const originalSentences = splitSentences(original);
  const editedSentences = splitSentences(edited);
  const originalSet = new Set(originalSentences);
  const editedSet = new Set(editedSentences);
  const removed = originalSentences.filter(s => !editedSet.has(s));
  const added = editedSentences.filter(s => !originalSet.has(s));
  const changes: string[] = [];
  if (removed.length > 0) changes.push(`Удалено или изменено предложений: ${removed.length}`);
  if (added.length > 0) changes.push(`Добавлено или изменено предложений: ${added.length}`);
  if (changes.length === 0) changes.push('Существенных изменений не обнаружено.');
  return changes;
}

/** Numbers that commonly appear as structural artifacts (list/section numbering, ordinal
 *  references) rather than invented data - excluded from the invented-number check to keep it
 *  useful instead of noisy. Everything else is a real claim and must trace back to the user. */
const STRUCTURAL_NUMBER_EXCLUSIONS = new Set(Array.from({ length: 21 }, (_, i) => String(i)));

export interface InventedNumberCheck { invented: string[]; ok: boolean }

/** Checks that every number in the GENERATED text traces back to something the user actually
 *  supplied (across all input fields, including sourceText) - catches a model inventing a new
 *  experimental figure from nothing, which checkPreservation alone (original -> edited survival)
 *  cannot: for `draft` mode there is no "original" to compare against at all. */
export function checkNoInventedNumbers(input: ScientificWriterInput, generatedText: string): InventedNumberCheck {
  const suppliedText = [
    input.title, input.researchField, input.goal, input.researchObject, input.methods,
    input.results, input.conclusions, input.keywords, input.sourceText, input.additionalRequirements,
  ].filter((v): v is string => !!v).join('\n');
  const suppliedNumbers = new Set(suppliedText.match(NUMBER_RE) ?? []);
  const generatedNumbers = Array.from(new Set(generatedText.match(NUMBER_RE) ?? []));
  const invented = generatedNumbers.filter(n => !suppliedNumbers.has(n) && !STRUCTURAL_NUMBER_EXCLUSIONS.has(n));
  return { invented, ok: invented.length === 0 };
}

const DOI_RE = /\b10\.\d{4,9}\/\S+/;
const CITATION_MARKER_RE = /\[\d+\]|\bet al\.?\b|\([A-ZА-Я][a-zа-я]+(?:\s+(?:and|&)\s+[A-ZА-Я][a-zа-я]+|\s+et al\.?)?,?\s*\d{4}\)/;
const REFERENCE_SECTION_RE = /\b(references|bibliography|литература|библиография|список\s+литературы)\b/i;

export interface ScholarlyArtifactCheck { doiFound: boolean; citationMarkersFound: boolean; referenceSectionFound: boolean; ok: boolean }

/** This app never gives the model any real bibliography to cite, so ANY DOI-like string,
 *  author-year citation marker, or "References"/"Bibliography" heading appearing in generated
 *  text is necessarily fabricated - a deterministic pattern check, not a trust assumption. */
export function checkNoFabricatedScholarlyArtifacts(generatedText: string): ScholarlyArtifactCheck {
  const doiFound = DOI_RE.test(generatedText);
  const citationMarkersFound = CITATION_MARKER_RE.test(generatedText);
  const referenceSectionFound = REFERENCE_SECTION_RE.test(generatedText);
  return { doiFound, citationMarkersFound, referenceSectionFound, ok: !doiFound && !citationMarkersFound && !referenceSectionFound };
}

/** Combines every post-generation safeguard into one human-readable list. An empty array means
 *  every check passed - the route/UI must never present a result as clean without actually
 *  running this. */
export function buildSafetyWarnings(input: ScientificWriterInput, generatedText: string, preservation: PreservationCheck | null): string[] {
  const warnings: string[] = [];
  if (preservation && !preservation.ok) {
    if (preservation.missingNumbers.length) warnings.push(`Возможна потеря числовых значений: ${preservation.missingNumbers.join(', ')}.`);
    if (preservation.missingTerms.length) warnings.push(`Возможна потеря защищённых терминов: ${preservation.missingTerms.join(', ')}.`);
  }
  const inventedNumbers = checkNoInventedNumbers(input, generatedText);
  if (!inventedNumbers.ok) warnings.push(`Обнаружены числа, не подтверждённые пользователем: ${inventedNumbers.invented.join(', ')}. Проверьте перед использованием.`);
  const scholarly = checkNoFabricatedScholarlyArtifacts(generatedText);
  if (scholarly.doiFound) warnings.push('Обнаружен DOI-подобный текст - система никогда не предоставляет реальные DOI, проверьте и удалите.');
  if (scholarly.citationMarkersFound) warnings.push('Обнаружены признаки цитирования (например, "[1]" или "(Автор, год)") - такие ссылки не подтверждены и не должны использоваться без проверки.');
  if (scholarly.referenceSectionFound) warnings.push('Обнаружен раздел со списком литературы - система не предоставляет реальные источники, этот раздел не должен использоваться без проверки.');
  return warnings;
}
