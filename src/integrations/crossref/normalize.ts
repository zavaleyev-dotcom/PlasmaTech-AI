import { createHash } from 'node:crypto';
import { doiUrl, normalizeDoi, plainText, safeUrl } from '@/services/scientific-search/normalization';
import type { Publication } from '@/services/scientific-search/types';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function firstText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value.map(plainText).find(Boolean) || null;
}

function publicationYear(work: Record<string, unknown>): number | null {
  for (const field of ['published', 'issued', 'published-print', 'published-online']) {
    const parts = record(work[field])['date-parts'];
    const year = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : null;
    if (typeof year === 'number' && Number.isInteger(year) && year >= 1000 && year <= 9999) return year;
  }
  return null;
}

export function normalizeCrossrefWork(value: unknown): Publication {
  const work = record(value);
  const doi = normalizeDoi(work.DOI);
  const title = firstText(work.title) || 'Без названия';
  const year = publicationYear(work);
  const fallbackId = createHash('sha256').update(JSON.stringify(work)).digest('hex').slice(0, 24);
  return {
    id: `crossref:${doi || fallbackId}`,
    title,
    authors: Array.isArray(work.author) ? work.author.map(author => {
      const person = record(author);
      return plainText(person.name) || [plainText(person.given), plainText(person.family)].filter(Boolean).join(' ');
    }).filter(Boolean) : [],
    year,
    journal: firstText(work['container-title']),
    doi,
    abstract: plainText(work.abstract) || null,
    publisher: plainText(work.publisher) || null,
    url: safeUrl(work.URL) || (doi ? doiUrl(doi) : null),
    type: plainText(work.type) || null,
    source: 'crossref',
    sources: ['crossref'],
    // A license URL or a journal-article type does not establish OA or peer review.
    openAccess: null,
  };
}
