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

/** Established Russian renderings of the domain's English terms (and the reverse direction).
 *  Kept deliberately short and conventional - a hint for the model, not a dictionary, and not
 *  a claim that every term has exactly one acceptable translation. */
export const TRANSLATION_GLOSSARY: readonly (readonly [en: string, ru: string])[] = [
  ['diamond-like carbon (DLC) coatings', 'алмазоподобные углеродные покрытия (DLC)'],
  ['tetrahedral amorphous carbon (ta-C)', 'тетраэдрический аморфный углерод (ta-C)'],
  ['physical vapor deposition (PVD)', 'физическое осаждение из паровой фазы (PVD)'],
  ['chemical vapor deposition (CVD)', 'химическое осаждение из газовой фазы (CVD)'],
  ['plasma-enhanced CVD (PECVD)', 'плазмохимическое осаждение из газовой фазы (PECVD)'],
  ['filtered cathodic vacuum arc (FCVA)', 'фильтрованная катодная вакуумная дуга (FCVA)'],
  ['magnetron sputtering', 'магнетронное распыление'],
  ['substrate bias', 'напряжение смещения на подложке'],
  ['deposition rate', 'скорость осаждения'],
  ['coating thickness', 'толщина покрытия'],
  ['adhesion strength', 'адгезионная прочность'],
  ['wear rate', 'скорость износа'],
  ['coefficient of friction', 'коэффициент трения'],
  ['thin films', 'тонкие плёнки'],
  ['etching', 'травление'],
];

/** Rules that apply whenever the user's OWN text is being rewritten, edited or translated.
 *  The model is told to behave as an editor/translator of fixed content, never as an author.
 *  These are instructions only: nothing here verifies the model complied (see the
 *  deterministic checks below, which are lexical and cannot check meaning). */
const SOURCE_FIDELITY_RULES = [
  'Исходный текст пользователя - единственный источник содержания. Каждое утверждение исходного текста должно быть сохранено: не заменяй конкретное утверждение общей фразой, не пропускай и не сокращай предложения до потери информации.',
  'Фразу "Недостаточно данных" в этом режиме НЕ используй: если сам исходный текст сообщает, что данных нет или они не предоставлены (например "No experimental data on adhesion strength or wear rate were provided"), точно передай именно это утверждение со всеми названными величинами.',
  'Сохраняй отрицания и ограничения ("не", "нет", "no", "not", "without", "only", "не предоставлены", "не измерялось") и все названные материалы, образцы, параметры и условия эксперимента.',
  'Сохраняй числовые значения со знаком, десятичной частью и единицами; не округляй и не пересчитывай.',
  'Не усиливай и не ослабляй выводы: сохраняй степень уверенности исходника ("may", "suggests", "возможно" остаются осторожными), не превращай предположение в доказанный факт, а корреляцию - в причинно-следственную связь.',
  'Не добавляй утверждений о статистической значимости ("significant", "significantly", "статистически значимо", p-значения) и усилителей ("substantially", "dramatically", "clearly demonstrates", "существенно"), если их нет в исходном тексте. Не вводи новые результаты, сравнения, причины или выводы.',
  'Если сомневаешься, как переформулировать, оставь формулировку исходного текста.',
] as const;

function glossaryLines(): string {
  return TRANSLATION_GLOSSARY.map(([en, ru]) => `${en} = ${ru}`).join('; ');
}

function translationInstructions(direction: 'ru_en' | 'en_ru'): string {
  const dir = direction === 'ru_en' ? 'с русского на английский' : 'с английского на русский';
  const target = direction === 'ru_en' ? 'английского' : 'русского';
  return [
    `Задача: выполнить научно-технический перевод предоставленного текста ${dir}. Переводи ВСЕ предложения полностью и точно - это перевод, а не пересказ и не резюме.`,
    `Сохрани общепринятые международные технические сокращения (${PROTECTED_TECHNICAL_TERMS.join(', ')}) без произвольного перевода.`,
    `Используй устоявшуюся терминологию физики плазмы и тонких плёнок на языке ${target}, а не дословную кальку (например: ${glossaryLines()}).`,
    'Числовые значения, знаки и порядок величин сохраняй точно. Единицы измерения передавай стандартными обозначениями целевого языка (V ↔ В, µm ↔ мкм, GPa ↔ ГПа, nm ↔ нм); °C сохраняй как °C.',
  ].join('\n');
}

function modeInstructions(mode: WriterMode, targetLanguage: Language): string {
  switch (mode) {
    case 'draft':
      return [
        'Задача: подготовить черновик документа СТРОГО на основе перечисленных ниже данных пользователя. Не добавляй факты, цитаты, DOI, авторов, журналы или результаты экспериментов, которых нет в данных. Для разделов без данных напиши "Недостаточно данных".',
        'Оформление: название документа - строка "# Название", каждый раздел - строка "## Название раздела", затем обычные абзацы. Не используй жирный шрифт вместо заголовков.',
      ].join('\n');
    case 'rewrite':
      return `Задача: переписать и улучшить стиль и структуру предоставленного текста, сохранив технический смысл. Не меняй числовые значения, химические формулы, обозначения оборудования и единицы измерения. Не добавляй новые факты.\n${SOURCE_FIDELITY_RULES.join('\n')}`;
    case 'edit':
      return `Задача: выполнить научное редактирование предоставленного текста (грамматика, терминология, ясность изложения). Не меняй числовые значения, химические формулы, обозначения оборудования и единицы измерения. Не добавляй новые факты.\n${SOURCE_FIDELITY_RULES.join('\n')}`;
    case 'translate_ru_en':
      return `${translationInstructions('ru_en')}\n${SOURCE_FIDELITY_RULES.join('\n')}`;
    case 'translate_en_ru':
      return `${translationInstructions('en_ru')}\n${SOURCE_FIDELITY_RULES.join('\n')}`;
  }
  return `Целевой язык: ${targetLanguage === 'ru' ? 'русский' : 'английский'}.`;
}

export function buildSystemPrompt(mode: WriterMode, targetLanguage: Language): string {
  const lines = [
    'Ты - ассистент для подготовки научно-технических текстов в области физики плазмы, вакуумных и PVD/CVD/PECVD технологий нанесения покрытий.',
    'Категорически запрещено: придумывать цитаты, DOI, библиографические ссылки, авторов, названия журналов, экспериментальные результаты или числовые данные, которых нет в предоставленном пользователем тексте.',
    'Не утверждай статистическую значимость различий и не усиливай выводы без подтверждающих данных в тексте пользователя.',
  ];
  // The "insufficient data" placeholder is only for drafting sections the user gave no data
  // for. In rewrite/edit/translate modes the user's text is the content: applying the
  // placeholder there replaces real statements with a stock phrase.
  if (!REWRITE_LIKE_MODES.includes(mode)) lines.push('Если данных для раздела недостаточно - явно напиши "Недостаточно данных" вместо того, чтобы придумывать содержание.');
  lines.push(modeInstructions(mode, targetLanguage));
  return lines.join('\n');
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
//
// F03: numbers are matched as whole tokens (never substring - "5" must never match inside
// "15"), and - critically - a number is paired with whatever recognized physical unit
// immediately follows it, so "5 µm" and "15 nm" are distinct tokens even though neither
// substring-contains the other, and "10 °C" and "10 K" are distinct even though the bare
// number is identical. All boundary checks are Unicode-aware (\p{L}/\p{N}, not the ASCII-only
// \b/\w), so this works the same right up against Cyrillic text with no space at all
// ("5мкм").

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** True only if `needle` occurs in `haystack` as a whole token - never merely as a substring
 *  of a longer word or number (e.g. "RF" inside "performance", "5" inside "15"). */
function containsAsWord(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
}

/** Units this project's scientific-writing domain actually uses (PVD/CVD/PECVD/plasma
 *  materials science, RU+EN) - deliberately explicit and curated, exactly like
 *  PROTECTED_TECHNICAL_TERMS above, rather than guessing at "unit-shaped" words (which risks
 *  either missing real units or misreading ordinary text as one). Sorted longest-first so e.g.
 *  "kPa"/"MPa"/"GPa" match before a bare "Pa" would. */
const KNOWN_UNITS = [
  'nm', 'мкм', 'нм', 'mm', 'мм', 'cm', 'см', 'µm', 'μm', 'm', 'м',
  '°C', '°С', '°К', '°F', 'K', 'К',
  'ms', 'мс', 'min', 'мин', 'h', 'ч', 's', 'с',
  'kPa', 'кПа', 'MPa', 'МПа', 'GPa', 'ГПа', 'Pa', 'Па', 'mbar', 'мбар', 'bar', 'бар', 'torr', 'Torr', 'торр',
  'kW', 'кВт', 'mA', 'мА', 'kV', 'кВ', 'W', 'Вт', 'A', 'А', 'V', 'В',
  'kHz', 'кГц', 'Hz', 'Гц',
  'HRC', 'HV', 'sccm', '%',
].sort((a, b) => b.length - a.length);

const UNIT_ALTERNATION = KNOWN_UNITS.map(escapeRegExp).join('|');

/** The SAME physical unit written in another language/script (or with a look-alike glyph) must
 *  compare equal: a faithful EN->RU translation turns "V" into "В", "µm" into "мкм", "GPa"
 *  into "ГПа" - and Cyrillic "В"/"А"/"К"/"С" are visually identical to the Latin letters, so
 *  texts routinely mix them. Everything maps to one canonical (Latin/SI) spelling; units that
 *  are genuinely DIFFERENT ("°C" vs "K", "µm" vs "nm") stay different. */
const UNIT_CANONICAL: Record<string, string> = {
  'нм': 'nm', 'мкм': 'µm', 'μm': 'µm', 'мм': 'mm', 'см': 'cm', 'м': 'm',
  '°С': '°C', '°К': 'K', 'К': 'K',
  'мс': 'ms', 'мин': 'min', 'ч': 'h', 'с': 's',
  'кПа': 'kPa', 'МПа': 'MPa', 'ГПа': 'GPa', 'Па': 'Pa', 'мбар': 'mbar', 'бар': 'bar', 'Torr': 'torr', 'торр': 'torr',
  'кВт': 'kW', 'мА': 'mA', 'кВ': 'kV', 'А': 'A', 'В': 'V', 'Вт': 'W', 'кГц': 'kHz', 'Гц': 'Hz',
};
function canonicalUnit(unit: string): string { return UNIT_CANONICAL[unit] ?? unit; }
/** Every character real scientific text uses as a numeric minus/plus sign - not just the
 *  ASCII hyphen-minus. Text pasted from Word/LaTeX/PDF exports (and LLM output, which tends
 *  to use proper math typography) very commonly renders a negative exponent with U+2212
 *  MINUS SIGN ("−") rather than U+002D HYPHEN-MINUS, and autocorrect/OCR can substitute
 *  the Unicode hyphen/en dash/em dash for the same role. Placed first inside the character
 *  class below so the literal "-" needs no escaping. */
const SIGN_CHARS = '-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212+';
const SIGN_VARIANT_RE = /[‐‑‒–—−]/g;
/** Captures a full numeric literal - including scientific/exponent notation ("1e-3", "9e-3",
 *  "1E+6", "2.5e-3") as ONE atomic mantissa+exponent token, never split into a bare mantissa
 *  digit run - and, only if immediately followed (after optional whitespace, allowing "5мкм"
 *  with no space at all) by one of KNOWN_UNITS and then a non-letter/digit, that unit too.
 *
 *  F03 (Codex regression #1): the previous pattern had no exponent group at all, so "1e-3 Pa"
 *  matched only its OWN trailing "-3 Pa" substring (the "1e" mantissa prefix was silently
 *  dropped, because "e" is a letter, not a digit/sign the old pattern recognized) - and since
 *  "9e-3 Pa" reduces the exact same way, a genuinely 9x-different value went completely
 *  undetected. The exponent group below is matched as part of the SAME capture as the
 *  mantissa, so "1e-3" is read as one token, never re-split at the "-3" that happens to
 *  follow the "e".
 *
 *  F03 (Codex regression #2, re-detected after the fix above): the exponent-group fix used
 *  `[-+]?` for both the leading and exponent sign - ASCII-only. A real "1e−3 Pa" (typographic
 *  minus, see SIGN_CHARS) fell through EXACTLY the same way the original bug did: the "e−3"
 *  was not recognized as part of the number at all, so only the trailing bare "3 Pa" matched,
 *  and "1e−3 Pa" vs "9e−3 Pa" again reduced to the identical token. SIGN_CHARS closes this
 *  for both sign positions.
 *
 *  The trailing lookahead also stops a bare number from matching as a prefix of an unrelated
 *  alphanumeric token (e.g. "5G" is never read as the number 5). */
const NUMBER_TOKEN_RE = new RegExp(`((?:(?<![\\p{L}\\p{N}])[${SIGN_CHARS}])?\\d+(?:[.,]\\d+)?(?:[eE][${SIGN_CHARS}]?\\d+)?)(?:\\s*(${UNIT_ALTERNATION}))?(?![\\p{L}\\p{N}])`, 'gu');

/** `key` is the comparison identity (canonical value + canonical unit). `inherited` marks a
 *  number that had no unit of its own and received one from the unit-bearing number right
 *  after it in a range/list ("-50 to -100 V", "1.2 and 1.1 µm") - see inheritRangeUnits. */
interface NumericToken { raw: string; key: string; value: string; unit?: string; inherited: boolean; start: number; end: number }

/** Text between two numbers that makes them one range/list sharing a unit. Deliberately narrow:
 *  only a comma, a range word (EN/RU) or a dash/slash/ellipsis - never arbitrary prose. */
const RANGE_GAP_RE = /^\s*(?:,\s*)?(?:(?:to|and|or|до|и|или)\s+|[-‐-―−/…]|\.{3})?\s*$/iu;

/** "-50 to -100 V" and "-50 V to -100 V" are the same quantities written two ways; a rewrite
 *  or translation may freely switch between them. Applied identically to BOTH texts being
 *  compared, so the first number of such a range is compared as "-50 V" on either side. Walks
 *  right-to-left so a whole list ("-50, -100, -150 V") resolves. */
function inheritRangeUnits(text: string, tokens: NumericToken[]): void {
  for (let i = tokens.length - 2; i >= 0; i--) {
    const current = tokens[i];
    const next = tokens[i + 1];
    if (current.unit || !next.unit) continue;
    const gap = text.slice(current.end, next.start);
    if (gap.trim() === '' || !RANGE_GAP_RE.test(gap)) continue;
    current.unit = next.unit;
    current.key = `${current.value}${next.unit}`;
    current.inherited = true;
  }
}

/** Every number (optionally paired with its unit) in `text`, as both a human-readable form
 *  (`raw`, exactly as written - for display in warnings) and a comparison key (`key`).
 *
 *  The key is built from the number's actual PARSED numeric value (`Number(...).toString()`),
 *  not from its literal source text: this is what makes "1.0e3 W" and "1000 W" compare as the
 *  SAME scientific quantity (a safe, narrow normalization - only mathematically-equal-valued
 *  numbers ever collapse to the same key, via JS's own number parser, never a heuristic string
 *  rewrite), while "1e-3 Pa" and "9e-3 Pa" - genuinely different values, not a formatting
 *  difference - still produce different keys ("0.001Pa" vs "0.009Pa"). Comma is treated as the
 *  same decimal separator as a period ("2,5" and "2.5" are the same value) before parsing.
 *  Any Unicode minus/dash sign matched via SIGN_CHARS is normalized to the ASCII hyphen-minus
 *  first - `Number()` itself only ever recognizes "-", so without this step a real "−1e-3"
 *  would parse to NaN (or silently lose its sign) instead of the actual negative value.
 *  The unit is compared in its canonical spelling (UNIT_CANONICAL), so "−150 V" and "−150 В",
 *  "0.9 µm" and "0.9 мкм", "3.1 GPa" and "3.1 ГПа" are the same quantity. */
function extractNumericTokens(text: string): NumericToken[] {
  const tokens = Array.from(text.matchAll(NUMBER_TOKEN_RE)).map((match): NumericToken => {
    const [raw, number, unit] = match;
    const normalizedNumber = number.replace(SIGN_VARIANT_RE, '-').replace(',', '.');
    const value = Number(normalizedNumber).toString();
    const canonical = unit ? canonicalUnit(unit) : undefined;
    const start = match.index ?? 0;
    return { raw: raw.trim(), value, unit: canonical, key: canonical ? `${value}${canonical}` : value, inherited: false, start, end: start + raw.length };
  });
  inheritRangeUnits(text, tokens);
  return tokens;
}

function uniqueByKey(tokens: NumericToken[]): NumericToken[] {
  return Array.from(new Map(tokens.map(t => [t.key, t])).values());
}

/** What a text offers for matching: every effective key, plus the values of numbers that had
 *  no unit of their own in that text (needed to let a range-inherited unit survive a
 *  punctuation change - see isCovered). */
interface TokenPool { keys: Set<string>; unitlessValues: Set<string> }

function buildPool(tokens: NumericToken[]): TokenPool {
  return {
    keys: new Set(tokens.map(t => t.key)),
    unitlessValues: new Set(tokens.filter(t => !t.unit || t.inherited).map(t => t.value)),
  };
}

/** A token is covered when the pool holds the same value+unit. A token whose unit was only
 *  INHERITED from its range neighbour is also covered by the same value written without a unit
 *  (e.g. "Table 2, 5 µm" rewritten as "Table 2. 5 µm" must not flag "2") - never by the same
 *  value with a DIFFERENT explicit unit, and never for a number that carried its own unit. */
function isCovered(token: NumericToken, pool: TokenPool): boolean {
  if (pool.keys.has(token.key)) return true;
  return token.inherited && pool.unitlessValues.has(token.value);
}

export interface PreservationCheck { preservedNumbers: string[]; missingNumbers: string[]; preservedTerms: string[]; missingTerms: string[]; ok: boolean }

/** Terms that stay in their original Latin spelling in any translation. The remaining
 *  PROTECTED_TECHNICAL_TERMS are ordinary English words ("pressure", "plasma", ...) that a
 *  correct translation MUST translate - requiring them verbatim in a translation would flag
 *  every faithful EN->RU result. */
const TRANSLATION_INVARIANT_TERMS: readonly string[] = ['PVD', 'CVD', 'PECVD', 'FCVA', 'ICP/RF', 'ICP', 'RF', 'ta-C'];

/** Confirms every number (with its unit, when it has one) and every protected technical term
 *  present in the ORIGINAL text still appears - as the SAME number+unit pair, never merely a
 *  matching substring - somewhere in the EDITED/translated text. A real, checkable guarantee
 *  rather than an assumption about how the model behaved. Deterministic and lexical only: it
 *  does NOT verify that the meaning is preserved. */
export function checkPreservation(original: string, edited: string, mode?: WriterMode): PreservationCheck {
  const originalTokens = uniqueByKey(extractNumericTokens(original));
  const editedPool = buildPool(extractNumericTokens(edited));
  const missing = originalTokens.filter(t => !isCovered(t, editedPool));
  const missingKeys = new Set(missing.map(t => t.key));
  const isTranslation = mode === 'translate_ru_en' || mode === 'translate_en_ru';
  const candidateTerms = isTranslation ? PROTECTED_TECHNICAL_TERMS.filter(t => TRANSLATION_INVARIANT_TERMS.includes(t)) : PROTECTED_TECHNICAL_TERMS;
  const presentTerms = candidateTerms.filter(t => containsAsWord(original, t));
  const missingTerms = presentTerms.filter(t => !containsAsWord(edited, t));
  return {
    preservedNumbers: originalTokens.filter(t => !missingKeys.has(t.key)).map(t => t.raw),
    missingNumbers: missing.map(t => t.raw),
    preservedTerms: presentTerms.filter(t => !missingTerms.includes(t)),
    missingTerms,
    ok: missing.length === 0 && missingTerms.length === 0,
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

/** A bare number (never one with a unit - a list marker never has a physical unit attached) is
 *  treated as structural (list/section numbering, not a claimed quantity) ONLY when it actually
 *  appears in that shape: at the start of a line, immediately followed by ". "/") "/": " - a
 *  real list-marker, never merely because the value itself happens to be small (F03: the old
 *  blanket "any number 0-20" exclusion let a genuinely invented small experimental value, e.g.
 *  "15 GPa", slip through unchecked purely because 15 <= 20 - unsafe, since real values
 *  routinely fall in that range). */
function structuralListMarkerKeys(text: string): Set<string> {
  const keys = new Set<string>();
  // Canonicalized the same way as extractNumericTokens's own keys (e.g. a "05." marker must
  // key as "5", matching how a bare "05" value would canonicalize too) - otherwise a leading-
  // zero marker could fail to match its own generated token's key and be falsely flagged.
  for (const match of text.matchAll(/(?:^|\n)[ \t]*(\d{1,3})[.):]\s/g)) keys.add(Number(match[1]).toString());
  return keys;
}

export interface InventedNumberCheck { invented: string[]; ok: boolean }

/** Checks that every number+unit pair in the GENERATED text traces back to the SAME pair the
 *  user actually supplied (across all input fields, including sourceText) - catches a model
 *  inventing a new experimental figure from nothing, which checkPreservation alone (original ->
 *  edited survival) cannot: for `draft` mode there is no "original" to compare against at all.
 *  A bare number with no unit that supplied text also mentions bare (in ANY context - a
 *  legitimate duration, count, etc.) is not flagged; a number that only appears attached to a
 *  DIFFERENT or no unit in the supplied text (e.g. "15 GPa" when the user only ever gave "15
 *  min") is a genuinely new claim and IS flagged - because it is compared as a pair, not a bare
 *  digit string. */
export function checkNoInventedNumbers(input: ScientificWriterInput, generatedText: string): InventedNumberCheck {
  const suppliedText = [
    input.title, input.researchField, input.goal, input.researchObject, input.methods,
    input.results, input.conclusions, input.keywords, input.sourceText, input.additionalRequirements,
  ].filter((v): v is string => !!v).join('\n');
  const suppliedPool = buildPool(extractNumericTokens(suppliedText));
  const generatedTokens = uniqueByKey(extractNumericTokens(generatedText));
  const structuralKeys = structuralListMarkerKeys(generatedText);
  const invented = generatedTokens.filter(t => !isCovered(t, suppliedPool) && !structuralKeys.has(t.key));
  return { invented: invented.map(t => t.raw), ok: invented.length === 0 };
}

// Word boundaries are Unicode-aware lookarounds: JS's \b is ASCII-only even with the `u` flag,
// so "\bдостоверн" can never match - there is no \b between a space and "д". "недостоверно"
// (the opposite claim) is deliberately NOT matched: a letter precedes the stem.
const WB_START = String.raw`(?<![\p{L}\p{N}])`;
const WB_END = String.raw`(?![\p{L}\p{N}])`;
const SIGNIFICANCE_MARKERS: readonly RegExp[] = [
  new RegExp(`${WB_START}significant(?:ly)?${WB_END}`, 'giu'),
  new RegExp(`${WB_START}statistically${WB_END}`, 'giu'),
  new RegExp(`${WB_START}p\\s*[<=≤]\\s*0?[.,]\\d+`, 'giu'),
  new RegExp(`${WB_START}статистическ\\p{L}*\\s+значим\\p{L}*`, 'giu'),
  new RegExp(`${WB_START}достовер\\p{L}*`, 'giu'),
];

export interface AddedSignificanceCheck { added: string[]; ok: boolean }

// A marker is NOT an asserted claim only when a negation demonstrably scopes THAT marker:
//   (A) a negator right before it, with at most one word in between - "не достоверен",
//       "не является статистически значимым", "was not significant", "недостаточно достоверно" -
//       except constructions that AFFIRM despite the "не": "не только"/"not only" and
//       "не менее"/"no less" ("не менее достоверен" = at least as reliable), and double negation
//       ("не может не быть достоверным");
//   (B) a negated assessment verb right after it, in the same coordination - "Достоверность не
//       оценивалась", "Significance was not assessed" - but NOT after a conjunction: in
//       "Результат достоверен и не проверялся" the "не" belongs to a separate, joined predicate;
//   (C) a fixed "no data on / without assessment of" phrase directly before it.
// Any other negator in the clause ("Без нагрева ... достоверно", "... получено без нагрева",
// "Нагрев не применяли, результат достоверен") negates something else and suppresses nothing.
// "без"/"without" are deliberately NOT negators: they negate the noun that follows them. Whenever
// the scope is unclear the marker counts as a claim - a warning is preferred to a silent pass.
// This is a conservative lexical heuristic, not an understanding of the sentence.
const NEGATOR_WORD = /^(?:не|нет|ни|недостаточно|not|no|never|cannot|insufficient|unable|\p{L}+n't)$/iu;
// A word right after "не"/"not" that makes the pair AFFIRM the marker instead of negating it.
const AFFIRMING_AFTER_NEGATOR = /^(?:только|лишь|просто|менее|меньше|хуже|only|merely|just|less|worse)$/iu;
const CONJUNCTION = '(?:и|а|но|да|или|либо|зато|хотя|причём|причем|and|but|or|yet|so|while|though|although|whereas)';
const ASSESSMENT_VERBS = '(?:оцен\\p{L}*|определ\\p{L}*|провер\\p{L}*|подтвержд\\p{L}*|подтверждён|установ\\p{L}*|показан\\p{L}*|доказан\\p{L}*|исследовал\\p{L}*|рассчитыва\\p{L}*|анализиров\\p{L}*|'
  + 'assess\\p{L}*|evaluat\\p{L}*|test\\p{L}*|determin\\p{L}*|establish\\p{L}*|confirm\\p{L}*|demonstrat\\p{L}*|calculat\\p{L}*|examin\\p{L}*|check\\p{L}*|measur\\p{L}*|verif\\p{L}*|comput\\p{L}*)';
const NEGATED_ASSESSMENT_AFTER = new RegExp(`^\\s*(?:(?!${CONJUNCTION}(?![\\p{L}\\p{N}]))[\\p{L}\\p{N}'-]+\\s+)?(?:не|not|\\p{L}+n't)\\s+(?:[\\p{L}'-]+\\s+)?${ASSESSMENT_VERBS}`, 'iu');
const NO_DATA_PHRASE_BEFORE = new RegExp(
  `(?:${WB_START}нет\\s+(?:данных|информации|сведений|оценки|подтверждения)\\s+(?:о|об|по|для)?|${WB_START}без\\s+(?:оценки|проверки|подтверждения|анализа|определения)|`
  + `${WB_START}no\\s+(?:data|evidence|information)\\s+(?:on|about|of|for)|${WB_START}without\\s+(?:assessment|assessing|testing|confirmation|evaluation)\\s+(?:of)?)\\s*$`, 'iu');
// A clause ends at sentence/clause punctuation or a spaced dash.
const CLAUSE_BOUNDARY = /[.!?;:,\n]|\s[—–-]\s/gu;

function clauseAround(text: string, start: number, end: number): { before: string; after: string } {
  let clauseStart = 0;
  let clauseEnd = text.length;
  for (const boundary of text.matchAll(CLAUSE_BOUNDARY)) {
    const at = boundary.index ?? 0;
    if (at + boundary[0].length <= start) clauseStart = at + boundary[0].length;
    else if (at >= end) { clauseEnd = at; break; }
  }
  return { before: text.slice(clauseStart, start), after: text.slice(end, clauseEnd) };
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/u).map(w => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);
}

function isNegated(text: string, start: number, end: number): boolean {
  const { before, after } = clauseAround(text, start, end);
  const words = wordsOf(before);
  const last = words[words.length - 1];
  const beforeLast = words[words.length - 2];
  // Two negators close together ("не может не быть достоверным") cancel out: an assertion.
  const doubleNegation = (index: number) => words.slice(Math.max(0, index - 2), index).some(w => NEGATOR_WORD.test(w));
  if (last && NEGATOR_WORD.test(last)) return !doubleNegation(words.length - 1);
  if (beforeLast && NEGATOR_WORD.test(beforeLast) && last && !AFFIRMING_AFTER_NEGATOR.test(last)) return !doubleNegation(words.length - 2);
  if (NO_DATA_PHRASE_BEFORE.test(before)) return true;
  return NEGATED_ASSESSMENT_AFTER.test(after);
}

/** Wording about (statistical) significance or reliability that the OUTPUT asserts but the user's
 *  source text never asserted. Lexical only - it catches the specific, recurring failure of an
 *  editor adding "significantly"/"достоверно" where nothing was established, not every possible
 *  strengthening of a claim (that needs a semantic verifier, which this project does not have).
 *  A marker the source only used in a negated form ("Достоверность не оценивалась") does not
 *  excuse the output asserting it. Meaningful for same-language rewriting/editing; not applied
 *  to translation, where "significantly" is a legitimate rendering of the source's own
 *  "значительно". */
export function checkNoAddedSignificanceClaims(source: string, output: string): AddedSignificanceCheck {
  const added = new Set<string>();
  for (const marker of SIGNIFICANCE_MARKERS) {
    const assertedInSource = Array.from(source.matchAll(marker)).some(m => !isNegated(source, m.index ?? 0, (m.index ?? 0) + m[0].length));
    if (assertedInSource) continue;
    for (const match of output.matchAll(marker)) {
      const at = match.index ?? 0;
      if (!isNegated(output, at, at + match[0].length)) added.add(match[0].toLowerCase());
    }
  }
  return { added: [...added], ok: added.size === 0 };
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
  if ((input.mode === 'rewrite' || input.mode === 'edit') && input.sourceText) {
    const significance = checkNoAddedSignificanceClaims(input.sourceText, generatedText);
    if (!significance.ok) warnings.push(`В результат добавлены формулировки о значимости, которых нет в исходном тексте: ${significance.added.join(', ')}. Проверьте, подтверждены ли они вашими данными.`);
  }
  const inventedNumbers = checkNoInventedNumbers(input, generatedText);
  if (!inventedNumbers.ok) warnings.push(`Обнаружены числа, не подтверждённые пользователем: ${inventedNumbers.invented.join(', ')}. Проверьте перед использованием.`);
  const scholarly = checkNoFabricatedScholarlyArtifacts(generatedText);
  if (scholarly.doiFound) warnings.push('Обнаружен DOI-подобный текст - система никогда не предоставляет реальные DOI, проверьте и удалите.');
  if (scholarly.citationMarkersFound) warnings.push('Обнаружены признаки цитирования (например, "[1]" или "(Автор, год)") - такие ссылки не подтверждены и не должны использоваться без проверки.');
  if (scholarly.referenceSectionFound) warnings.push('Обнаружен раздел со списком литературы - система не предоставляет реальные источники, этот раздел не должен использоваться без проверки.');
  return warnings;
}
