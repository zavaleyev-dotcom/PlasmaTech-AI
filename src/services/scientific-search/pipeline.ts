import { deduplicatePublications } from './deduplicate';
import { filterPublications } from './filters';
import { sortPublications } from './sort';
import { ScientificSearchError } from './errors';
import type { ScientificSearchQuery, ScientificSearchResult, ScientificSourceProvider, Publication } from './types';

export async function runSearch(
  query: ScientificSearchQuery,
  provider: ScientificSourceProvider | ScientificSourceProvider[],
): Promise<ScientificSearchResult> {
  const providers = Array.isArray(provider) ? provider : [provider];
  const responses = await Promise.allSettled(providers.map(item => item.search(query)));
  const records: Publication[] = [];
  const sourceStats: ScientificSearchResult['sourceStats'] = [];
  const warnings: string[] = [];
  let successful = 0;
  responses.forEach((response, index) => {
    const source = providers[index].id;
    if (response.status === 'fulfilled') {
      successful++;
      sourceStats.push({ source, total: response.value.total, retrieved: response.value.publications.length });
      records.push(...response.value.publications.map((item, rank) => ({ ...item, relevanceScore: 1 / (60 + rank + 1) })));
    } else {
      const message = response.reason instanceof ScientificSearchError ? response.reason.message : 'Источник временно недоступен.';
      sourceStats.push({ source, total: null, retrieved: 0, error: message });
      warnings.push(`${source === 'crossref' ? 'Crossref' : 'OpenAlex'}: ${message}`);
    }
  });
  if (!successful) {
    const failure = responses.find(item => item.status === 'rejected');
    if (failure?.status === 'rejected' && failure.reason instanceof ScientificSearchError) throw failure.reason;
    throw new ScientificSearchError('SOURCES_UNAVAILABLE', 'Не удалось получить данные научных источников. Повторите поиск.', 502, true);
  }
  if (query.openAccessOnly && query.source === 'crossref') warnings.push('Crossref не предоставляет надёжный статус Open Access в этой интеграции. Неизвестный статус исключён; для OA используйте OpenAlex или совместный поиск.');
  const unique = deduplicatePublications(records);
  const filtered = filterPublications(unique, query);
  const publications = sortPublications(filtered, query.sort).slice(0, query.limit);
  return {
    publications, total: sourceStats.reduce((sum, item) => sum + (item.total ?? 0), 0), source: query.source, query,
    retrieved: records.length, duplicatesRemoved: records.length - unique.length,
    uniqueRetrieved: unique.length, filteredOut: unique.length - filtered.length,
    returned: publications.length, sourceStats, warnings,
  };
}
