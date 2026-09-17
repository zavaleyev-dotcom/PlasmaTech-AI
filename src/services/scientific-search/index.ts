import 'server-only';
import { CrossrefProvider } from '@/integrations/crossref';
import { OpenAlexProvider } from '@/integrations/openalex';
import { parseSearchQuery } from './validation';
import { runSearch } from './pipeline';

const providers = {
  crossref: new CrossrefProvider(),
  openalex: new OpenAlexProvider(),
};

export async function searchPublications(input: unknown) {
  const query = parseSearchQuery(input);
  return runSearch(query, query.source === 'combined' ? [providers.crossref, providers.openalex] : providers[query.source]);
}
