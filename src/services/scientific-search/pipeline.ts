import { deduplicatePublications } from './deduplicate';
import { filterPublications } from './filters';
import type { ScientificSearchQuery, ScientificSearchResult, ScientificSourceProvider } from './types';

export async function runSearch(
  query: ScientificSearchQuery,
  provider: ScientificSourceProvider,
): Promise<ScientificSearchResult> {
  const response = await provider.search(query);
  const unique = deduplicatePublications(response.publications);
  const filtered = filterPublications(unique, query);
  const publications = filtered.slice(0, query.limit);
  return {
    publications, total: response.total, source: query.source, query,
    retrieved: response.publications.length,
    duplicatesRemoved: response.publications.length - unique.length,
    filteredOut: unique.length - filtered.length,
    returned: publications.length,
  };
}
