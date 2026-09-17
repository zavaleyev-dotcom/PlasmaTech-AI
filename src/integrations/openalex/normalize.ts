import { plainText, normalizeDoi, safeUrl, doiUrl } from '@/services/scientific-search/normalization';
import type { Publication } from '@/services/scientific-search/types';

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Reconstruct original words by position; this is not an AI-generated summary. */
export function reconstructAbstract(value: unknown): string | null {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(asRecord(value))) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      // Bound malformed indices without allocating sparse arrays from remote input.
      if (typeof position === 'number' && Number.isInteger(position) && position >= 0 && position < 50_000) words.set(position, word);
    }
  }
  return plainText([...words].sort(([a], [b]) => a - b).map(([, word]) => word).join(' ')) || null;
}

export function normalizeOpenAlexWork(value: unknown): Publication {
  const work = asRecord(value);
  const location = asRecord(work.primary_location);
  const source = asRecord(location.source);
  const rawType = plainText(work.type);
  const types: Record<string, string> = { 'book-chapter': 'book-chapter', book: 'book', preprint: 'posted-content', report: 'report', dissertation: 'dissertation', dataset: 'dataset' };
  // OpenAlex 'article' also includes non-journal works: use source type to distinguish.
  const type = rawType === 'article' ? (source.type === 'journal' ? 'journal-article' : source.type === 'conference' ? 'proceedings-article' : 'article') : types[rawType] || rawType || null;
  const doi = normalizeDoi(work.doi);
  const openAlexId = typeof work.id === 'string' && /^https:\/\/openalex\.org\/W\d+$/.test(work.id) ? work.id : null;
  if (!openAlexId) throw new Error('Invalid OpenAlex work ID');
  const year = work.publication_year;
  const citations = work.cited_by_count;
  const isOa = asRecord(work.open_access).is_oa;
  return {
    id: `openalex:${openAlexId.split('/').pop()}`,
    title: plainText(work.title) || plainText(work.display_name) || 'Без названия',
    authors: Array.isArray(work.authorships) ? work.authorships.map(item => plainText(asRecord(asRecord(item).author).display_name)).filter(Boolean) : [],
    year: typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null,
    journal: plainText(source.display_name) || null,
    doi,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    // A host institution is not necessarily a publisher.
    publisher: typeof source.host_organization === 'string' && source.host_organization.startsWith('https://openalex.org/P') ? plainText(source.host_organization_name) || null : null,
    url: safeUrl(location.landing_page_url) || (doi ? doiUrl(doi) : openAlexId),
    type, source: 'openalex', sources: ['openalex'],
    openAccess: typeof isOa === 'boolean' ? isOa : null,
    citationCount: typeof citations === 'number' && Number.isSafeInteger(citations) && citations >= 0 ? citations : null,
    openAlexId,
  };
}
