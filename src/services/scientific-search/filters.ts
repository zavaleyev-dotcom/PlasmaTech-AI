import type { Publication, PublicationFilters } from './types';

export function filterPublications(publications: readonly Publication[], filters: PublicationFilters): Publication[] {
  const type = filters.journalOnly ? 'journal-article' : filters.type;
  return publications.filter(publication =>
    (!filters.yearFrom || (publication.year !== null && publication.year >= filters.yearFrom)) &&
    (!filters.yearTo || (publication.year !== null && publication.year <= filters.yearTo)) &&
    (!type || publication.type === type) &&
    (!filters.openAccessOnly || publication.openAccess === true) &&
    (!filters.hasDoi || !!publication.doi) &&
    (!filters.hasAbstract || !!publication.abstract?.trim()),
  );
}
