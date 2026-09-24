/** Real, local, dependency-free bibliographic reference model and citation formatting for
 *  Scientific Writer - no automatic DOI lookup, no Crossref/OpenAlex call, no LLM. Every field
 *  in a Reference comes only from what the user actually typed; formatters only ever print
 *  fields that are present - an absent field is OMITTED from the formatted citation, never
 *  replaced with "undefined" or an invented placeholder.
 *
 *  DOI syntax/canonicalization reuses the ONE shared implementation
 *  (src/services/scientific-search/normalization.ts) already used by the SciFinder search
 *  pipeline and by scifinder-import.ts's own duplicate check - a pure string function, no
 *  network call, so this stays dependency-free (F19: never a second, independent regexp). */

import { normalizeDoi, normalizedTitle } from '@/services/scientific-search/normalization';

// ---------- reference data model (item 3) ----------

export const REFERENCE_TYPES = ['journal_article', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'website'] as const;
export type ReferenceType = typeof REFERENCE_TYPES[number];

export const REFERENCE_TYPE_LABELS: Record<ReferenceType, string> = {
  journal_article: 'Статья в журнале',
  conference_paper: 'Доклад конференции',
  book: 'Книга',
  book_chapter: 'Глава книги',
  thesis: 'Диссертация',
  report: 'Отчёт',
  website: 'Веб-источник',
};

/** Where a reference came from - purely informational, never read by any formatter, so it can
 *  never change the formatted citation text (SciFinder-integration item 4). Absent entirely for
 *  a manually-typed reference. */
export interface ReferenceProvenance {
  source: 'scifinder';
  /** Provider(s) that reported this record, e.g. "crossref", "openalex", or "crossref+openalex". */
  provider: string;
  importedAt: string;
  /** The original SciFinder result's DOI or internal id, kept only for traceability. */
  originalId?: string;
}

export interface Reference {
  id: string;
  type: ReferenceType;
  /** Each author exactly as the user typed it - never split/reformatted into "Last, F." */
  authors: string[];
  title?: string;
  /** Journal / conference name / publisher / institution, depending on `type`. */
  containerTitle?: string;
  year?: number;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  accessDate?: string;
  language?: string;
  provenance?: ReferenceProvenance;
}

export function generateReferenceId(): string {
  return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createReference(type: ReferenceType): Reference {
  return { id: generateReferenceId(), type, authors: [] };
}

// ---------- CRUD (item 4): add/edit/remove/reorder/duplicate ----------

export function addReference(refs: Reference[], type: ReferenceType): Reference[] {
  return [...refs, createReference(type)];
}
export function removeReference(refs: Reference[], id: string): Reference[] {
  return refs.filter(r => r.id !== id);
}
export function updateReference(refs: Reference[], id: string, patch: Partial<Omit<Reference, 'id'>>): Reference[] {
  return refs.map(r => (r.id === id ? { ...r, ...patch } : r));
}
export function duplicateReference(refs: Reference[], id: string): Reference[] {
  const index = refs.findIndex(r => r.id === id);
  if (index === -1) return refs;
  const copy: Reference = { ...refs[index], id: generateReferenceId(), authors: [...refs[index].authors] };
  return [...refs.slice(0, index + 1), copy, ...refs.slice(index + 1)];
}
export function moveReference(refs: Reference[], id: string, direction: 'up' | 'down'): Reference[] {
  const index = refs.findIndex(r => r.id === id);
  if (index === -1) return refs;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= refs.length) return refs;
  const next = [...refs];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// ---------- validation (item 4/7): syntax only, no external lookup ----------

/** Validates DOI SYNTAX only - this block never queries Crossref or any external service to
 *  confirm a DOI actually resolves to something. Accepts every form `normalizeDoi` recognizes
 *  (bare DOI, "doi:" prefix, doi.org/dx.doi.org URL) - not only the bare canonical form -
 *  since F19's manual editor normalizes on blur, but a reference created programmatically
 *  (import, test data) should not be flagged "malformed" just for carrying one of those
 *  equally-valid forms. */
export function isValidDoiSyntax(doi: string): boolean {
  return normalizeDoi(doi) !== null;
}

export function isValidUrl(url: string): boolean {
  try { new URL(url); return true; } catch { return false; }
}

export function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1500 && year <= new Date().getFullYear() + 1;
}

export interface ReferenceIssue { referenceId: string | null; message: string }
export interface ReferenceListCheck { errors: ReferenceIssue[]; warnings: ReferenceIssue[] }

/** F13: the single canonical duplicate-identity key for a reference, in priority order - DOI
 *  first (canonical, URL/prefix-insensitive via the shared normalizeDoi), else normalized
 *  title + year, else normalized title + first author when year is absent. Two references
 *  that only share a title (no year, no author, or - when a DOI is present on both - a
 *  DIFFERENT DOI) are never considered duplicates by this key: "Annual report" 2020 and
 *  "Annual report" 2021 are genuinely different bibliographic records, not the same one
 *  entered twice. Shared verbatim with scifinder-import.ts's own duplicate check, so "the same
 *  reference" means the same thing everywhere in the app (not two independent definitions). */
export type ReferenceDedupBasis = 'doi' | 'title-year' | 'title-author';
export interface ReferenceDedupResult { key: string; basis: ReferenceDedupBasis }

export function referenceDedupKey(ref: Pick<Reference, 'doi' | 'title' | 'year' | 'authors'>): ReferenceDedupResult | null {
  if (ref.doi) {
    const normalized = normalizeDoi(ref.doi);
    if (normalized) return { key: `doi:${normalized}`, basis: 'doi' };
  }
  const title = ref.title?.trim() ? normalizedTitle(ref.title) : '';
  if (!title) return null;
  if (ref.year !== undefined) return { key: `title-year:${title}|${ref.year}`, basis: 'title-year' };
  if (ref.authors[0]?.trim()) return { key: `title-author:${title}|${normalizedTitle(ref.authors[0])}`, basis: 'title-author' };
  return null;
}

const DEDUP_BASIS_LABEL: Record<ReferenceDedupBasis, string> = {
  doi: 'совпадает DOI',
  'title-year': 'совпадают название и год',
  'title-author': 'совпадают название и первый автор (год не указан)',
};

/** Checks the WHOLE reference list (not one reference in isolation): duplicate references
 *  (F13 - see referenceDedupKey), malformed DOI/URL/year, missing required fields, and - only
 *  when `citedIds` is explicitly supplied (this project has no automatic in-text citation
 *  detection, so "cited" is always a manual, honest signal from the caller, never inferred) -
 *  the cross-check between what is actually cited and what exists in the list. Passing
 *  `undefined` skips that cross-check entirely rather than reporting every reference as "never
 *  cited", which would be misleading when citation usage genuinely was not tracked. Errors and
 *  warnings are kept separate (item 7) - a warning never blocks export, an error should be
 *  fixed by the user before relying on the bibliography. */
export function checkReferenceList(refs: Reference[], citedIds?: string[]): ReferenceListCheck {
  const errors: ReferenceIssue[] = [];
  const warnings: ReferenceIssue[] = [];

  const seenKeys = new Map<string, string>();

  for (const ref of refs) {
    const isEmpty = !ref.title?.trim() && ref.authors.length === 0 && !ref.containerTitle?.trim() && ref.year === undefined && !ref.doi?.trim() && !ref.url?.trim();
    if (isEmpty) { errors.push({ referenceId: ref.id, message: 'Пустой источник: не заполнено ни одно поле.' }); continue; }

    if (!ref.title?.trim()) warnings.push({ referenceId: ref.id, message: 'Не указано название источника.' });
    if (ref.authors.length === 0 && ref.type !== 'website') warnings.push({ referenceId: ref.id, message: 'Не указаны авторы.' });

    if (ref.doi?.trim() && !isValidDoiSyntax(ref.doi)) errors.push({ referenceId: ref.id, message: `Некорректный формат DOI: "${ref.doi}".` });
    if (ref.url?.trim() && !isValidUrl(ref.url)) errors.push({ referenceId: ref.id, message: `Некорректный URL: "${ref.url}".` });
    if (ref.year !== undefined && !isValidYear(ref.year)) errors.push({ referenceId: ref.id, message: `Некорректный год: ${ref.year}.` });

    const dedup = referenceDedupKey(ref);
    if (dedup) {
      const existingId = seenKeys.get(dedup.key);
      if (existingId) errors.push({ referenceId: ref.id, message: `Дублирующийся источник (${DEDUP_BASIS_LABEL[dedup.basis]}) - совпадает с источником ${existingId}.` });
      else seenKeys.set(dedup.key, ref.id);
    }
  }

  if (citedIds !== undefined) {
    const refIds = new Set(refs.map(r => r.id));
    const citedSet = new Set(citedIds);
    for (const citedId of citedSet) {
      if (!refIds.has(citedId)) warnings.push({ referenceId: citedId, message: 'Источник процитирован в тексте, но отсутствует в списке источников.' });
    }
    for (const ref of refs) {
      if (!citedSet.has(ref.id)) warnings.push({ referenceId: ref.id, message: 'Источник добавлен в список, но ни разу не процитирован в тексте.' });
    }
  }

  return { errors, warnings };
}

// ---------- citation styles (item 2/5/6) ----------

export const CITATION_STYLES = ['apa', 'ieee', 'gost'] as const;
export type CitationStyle = typeof CITATION_STYLES[number];

export const CITATION_STYLE_LABELS: Record<CitationStyle, string> = {
  apa: 'APA',
  ieee: 'IEEE',
  gost: 'GOST-style (упрощённый, не заявлен как соответствие конкретному ГОСТ)',
};

function volumeIssue(ref: Reference): string | undefined {
  if (!ref.volume && !ref.issue) return undefined;
  if (ref.volume && ref.issue) return `${ref.volume}(${ref.issue})`;
  return ref.volume ?? ref.issue;
}

function joinClauses(clauses: (string | undefined)[]): string {
  return clauses.filter((c): c is string => !!c && c.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- APA (full reference), alphabetized bibliography by convention ----------

function formatAuthorsApa(authors: string[]): string | undefined {
  if (authors.length === 0) return undefined;
  if (authors.length === 1) return `${authors[0]}.`;
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}.`;
  return `${authors.slice(0, -1).join(', ')}, & ${authors[authors.length - 1]}.`;
}

export function formatReferenceApa(ref: Reference): string {
  const authors = formatAuthorsApa(ref.authors);
  const year = ref.year !== undefined ? `(${ref.year}).` : undefined;
  const title = ref.title ? `${ref.title}.` : undefined;
  const vi = volumeIssue(ref);
  const containerParts = [ref.containerTitle, vi, ref.pages].filter((v): v is string => !!v);
  const container = containerParts.length ? `${containerParts.join(', ')}.` : undefined;
  const link = ref.doi ? `https://doi.org/${ref.doi}` : ref.url;
  return joinClauses([authors, year, title, container, link]);
}

// ---------- IEEE (numbered, citation order) ----------

function formatAuthorsIeee(authors: string[]): string | undefined {
  if (authors.length === 0) return undefined;
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return `${authors.slice(0, -1).join(', ')}, and ${authors[authors.length - 1]}`;
}

export function formatReferenceIeee(ref: Reference, number: number): string {
  const authors = formatAuthorsIeee(ref.authors);
  const authorsClause = authors ? `${authors},` : undefined;
  const title = ref.title ? `"${ref.title},"` : undefined;
  const container = ref.containerTitle ? `${ref.containerTitle},` : undefined;
  const vol = ref.volume ? `vol. ${ref.volume},` : undefined;
  const no = ref.issue ? `no. ${ref.issue},` : undefined;
  const pp = ref.pages ? `pp. ${ref.pages},` : undefined;
  const year = ref.year !== undefined ? `${ref.year}${ref.doi || ref.url ? ',' : '.'}` : undefined;
  const link = ref.doi ? `doi: ${ref.doi}.` : ref.url ? `${ref.url}.` : undefined;
  const body = joinClauses([authorsClause, title, container, vol, no, pp, year, link]);
  return `[${number}] ${body}`;
}

// ---------- GOST-style (numbered, citation order; explicitly named as a simplified style) ----------

export function formatReferenceGost(ref: Reference, number: number): string {
  const authors = ref.authors.length > 0 ? `${ref.authors.join(', ')}.` : undefined;
  const title = ref.title ? ref.title : undefined;
  const container = ref.containerTitle ? `// ${ref.containerTitle}.` : undefined;
  const year = ref.year !== undefined ? `– ${ref.year}.` : undefined;
  const vi = volumeIssue(ref);
  const volPart = vi ? `– Т./№ ${vi}.` : undefined;
  const pages = ref.pages ? `– С. ${ref.pages}.` : undefined;
  const link = ref.doi ? `– DOI: ${ref.doi}.` : ref.url ? `– URL: ${ref.url}.` : undefined;
  const body = joinClauses([authors, title, container, year, volPart, pages, link]);
  return `${number}. ${body}`;
}

export interface FormattedBibliography { numbered: boolean; entries: { reference: Reference; text: string }[] }

/** Builds the full bibliography for ONE style from the CURRENT reference list - APA is
 *  alphabetized by first author (a safe, deterministic display re-ordering, never altering any
 *  field's content); IEEE/GOST keep the list's own order and number sequentially from it, so
 *  reordering the list predictably renumbers the bibliography (item 7's "numbering stability"). */
export function buildBibliography(refs: Reference[], style: CitationStyle): FormattedBibliography {
  if (style === 'apa') {
    const sorted = [...refs].sort((a, b) => (a.authors[0] ?? a.title ?? '').localeCompare(b.authors[0] ?? b.title ?? ''));
    return { numbered: false, entries: sorted.map(r => ({ reference: r, text: formatReferenceApa(r) })) };
  }
  const formatter = style === 'ieee' ? formatReferenceIeee : formatReferenceGost;
  return { numbered: true, entries: refs.map((r, i) => ({ reference: r, text: formatter(r, i + 1) })) };
}

// ---------- in-text citations (item 6) ----------

const NO_SOURCE_FALLBACK = '(источник не указан)';

/** Never invents an author or year - if genuinely absent, an honest fallback marker is used
 *  instead ("б.г." = "без года", i.e. "no date given"), never a fabricated value. */
export function formatInTextApa(ref: Reference): string {
  const authorPart = ref.authors.length === 0 ? undefined
    : ref.authors.length === 1 ? ref.authors[0]
    : ref.authors.length === 2 ? `${ref.authors[0]} & ${ref.authors[1]}`
    : `${ref.authors[0]} et al.`;
  const yearPart = ref.year !== undefined ? String(ref.year) : undefined;
  if (!authorPart && !yearPart) return NO_SOURCE_FALLBACK;
  if (!authorPart) return `(${yearPart})`;
  if (!yearPart) return `(${authorPart}, б.г.)`;
  return `(${authorPart}, ${yearPart})`;
}

export function formatInTextNumeric(number: number): string {
  return `[${number}]`;
}

/** Looks up a reference's current position in the list (1-based) for IEEE/GOST in-text
 *  numbering - returns null (never a fabricated number) if the reference is not in the list. */
export function referenceNumber(refs: Reference[], id: string): number | null {
  const index = refs.findIndex(r => r.id === id);
  return index === -1 ? null : index + 1;
}

export function formatInText(refs: Reference[], id: string, style: CitationStyle): string {
  const ref = refs.find(r => r.id === id);
  if (!ref) return NO_SOURCE_FALLBACK;
  if (style === 'apa') return formatInTextApa(ref);
  const number = referenceNumber(refs, id);
  return number === null ? NO_SOURCE_FALLBACK : formatInTextNumeric(number);
}

// ---------- document formatting profiles (item 9) ----------

export const DOCUMENT_PROFILES = ['generic_article', 'conference_paper', 'thesis_report'] as const;
export type DocumentProfileId = typeof DOCUMENT_PROFILES[number];

export interface FormattingProfile {
  id: DocumentProfileId;
  label: string;
  description: string;
  bodyFontSizePt: number;
  headingFontSizePt: number;
  lineSpacing: number;
  marginsMm: { top: number; bottom: number; left: number; right: number };
}

export const FORMATTING_PROFILES: Record<DocumentProfileId, FormattingProfile> = {
  generic_article: {
    id: 'generic_article', label: 'Generic Article', description: 'Базовый профиль для научной статьи общего вида - не привязан к конкретному журналу.',
    bodyFontSizePt: 11, headingFontSizePt: 14, lineSpacing: 1.15, marginsMm: { top: 20, bottom: 20, left: 20, right: 20 },
  },
  conference_paper: {
    id: 'conference_paper', label: 'Conference Paper', description: 'Базовый профиль для доклада конференции.',
    bodyFontSizePt: 10, headingFontSizePt: 13, lineSpacing: 1.0, marginsMm: { top: 20, bottom: 20, left: 18, right: 18 },
  },
  thesis_report: {
    id: 'thesis_report', label: 'Thesis / Report', description: 'Базовый профиль для диссертации/отчёта - увеличенные поля и межстрочный интервал.',
    bodyFontSizePt: 12, headingFontSizePt: 14, lineSpacing: 1.5, marginsMm: { top: 20, bottom: 20, left: 30, right: 15 },
  },
};

// ---------- journal preset architecture (item 10): registry interface, intentionally empty ----------

export interface JournalPreset {
  id: string;
  label: string;
  publisher?: string;
  citationStyle: CitationStyle;
  profile: DocumentProfileId;
}

/** Intentionally empty in V1 - the registry/interface exists so specific journal presets
 *  (Elsevier, Springer, IEEE journals, specific Russian journals, ...) can be added later
 *  without inventing compliance with any journal's real requirements now. */
export const JOURNAL_PRESETS: JournalPreset[] = [];

export function getJournalPreset(id: string): JournalPreset | undefined {
  return JOURNAL_PRESETS.find(p => p.id === id);
}
