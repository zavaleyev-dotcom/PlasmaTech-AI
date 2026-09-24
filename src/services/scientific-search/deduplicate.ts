import { normalizeDoi, normalizedTitle } from './normalization';
import type { Publication } from './types';

function titleKey(publication: Publication): string | null {
  const title = normalizedTitle(publication.title);
  // A missing title/year is insufficient to identify a work reliably.
  return title && publication.title !== 'Без названия' && publication.year !== null
    ? `${title}|${publication.year}` : null;
}

/** F20: the SAME "is this the same work" notion deduplicatePublications uses internally (DOI
 *  first, else normalized title+year), exposed as a single per-record key - used by combined-
 *  search pagination (pipeline.ts) to track which records have already been shown across
 *  pages, so a later fetch returning a record already emitted on an earlier page is recognized
 *  and skipped rather than re-emitted as if it were new. Returns null when a record cannot be
 *  identified reliably (no DOI, no usable title/year) - such a record is never deduplicated
 *  against anything, exactly like deduplicatePublications treats it. */
export function publicationIdentityKey(publication: Publication): string | null {
  const doi = normalizeDoi(publication.doi);
  if (doi) return `doi:${doi}`;
  const title = titleKey(publication);
  return title ? `title:${title}` : null;
}

function merge(first: Publication, second: Publication): Publication {
  const preferred = first.doi ? first : second.doi ? second : first;
  const other = preferred === first ? second : first;
  return {
    ...preferred,
    authors: preferred.authors.length ? preferred.authors : other.authors,
    abstract: preferred.abstract || other.abstract,
    journal: preferred.journal || other.journal,
    publisher: preferred.publisher || other.publisher,
    url: preferred.url || other.url,
    year: preferred.year ?? other.year,
    type: preferred.type || other.type,
    openAccess: preferred.openAccess ?? other.openAccess,
    citationCount: preferred.citationCount ?? other.citationCount,
    openAlexId: preferred.openAlexId ?? other.openAlexId,
    relevanceScore: (first.relevanceScore ?? 0) + (second.relevanceScore ?? 0),
    sources: [...new Set([...first.sources, ...second.sources])],
  };
}

export function deduplicatePublications(publications: readonly Publication[]): Publication[] {
  const result: Publication[] = [];
  // DOI-bearing records first: title-only records can enrich a known record,
  // but must never bridge two different DOIs with similar titles.
  const records = publications.map((publication, index) => ({
    publication: { ...publication, doi: normalizeDoi(publication.doi) }, index,
  }));
  records.sort((a, b) => Number(!!b.publication.doi) - Number(!!a.publication.doi));
  const originalOrder: number[] = [];
  for (const { publication, index } of records) {
    const key = titleKey(publication);
    const matches = result.map((existing, position) => ({ existing, position })).filter(({ existing }) => {
      if (publication.doi && existing.doi) return publication.doi === existing.doi;
      return key !== null && key === titleKey(existing);
    });
    // Ambiguous title-only record: preserve it instead of choosing an arbitrary DOI.
    if (matches.length === 1) {
      const position = matches[0].position;
      result[position] = merge(result[position], publication);
      originalOrder[position] = Math.min(originalOrder[position], index);
    } else {
      result.push(publication);
      originalOrder.push(index);
    }
  }
  return result.map((publication, index) => ({ publication, order: originalOrder[index] }))
    .sort((a, b) => a.order - b.order).map(item => item.publication);
}
