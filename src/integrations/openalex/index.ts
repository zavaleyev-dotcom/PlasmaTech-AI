import 'server-only';
import { ScientificSearchError } from '@/services/scientific-search/errors';
import type { ScientificSearchQuery, ScientificSourceProvider, SourceSearchResult } from '@/services/scientific-search/types';
import { asRecord, normalizeOpenAlexWork } from './normalize';

export function buildOpenAlexUrl(query: ScientificSearchQuery): URL {
  const url = new URL(query.doi ? `works/${encodeURIComponent(`https://doi.org/${query.doi}`)}` : 'works', 'https://api.openalex.org/');
  if (query.doi) return url;
  url.searchParams.set('search', [query.query, query.keywords].filter(Boolean).join(' '));
  url.searchParams.set('per_page', String(query.limit));
  url.searchParams.set('select', 'id,doi,title,authorships,publication_year,primary_location,type,open_access,cited_by_count,abstract_inverted_index');
  const filters: string[] = [];
  if (query.yearFrom) filters.push(`from_publication_date:${query.yearFrom}-01-01`);
  if (query.yearTo) filters.push(`to_publication_date:${query.yearTo}-12-31`);
  const type = query.journalOnly ? 'journal-article' : query.type;
  if (type === 'journal-article') filters.push('type:article', 'primary_location.source.type:journal');
  else if (type === 'proceedings-article') filters.push('type:article', 'primary_location.source.type:conference');
  else if (type) filters.push(`type:${type === 'posted-content' ? 'preprint' : type}`);
  if (query.hasDoi) filters.push('has_doi:true');
  if (query.hasAbstract) filters.push('has_abstract:true');
  if (query.openAccessOnly) filters.push('open_access.is_oa:true');
  if (filters.length) url.searchParams.set('filter', filters.join(','));
  // Retrieve relevance-ranked candidates; the common pipeline sorts the fetched set.
  return url;
}

export class OpenAlexProvider implements ScientificSourceProvider {
  readonly id = 'openalex' as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
    private readonly apiKey: string | undefined = process.env.OPENALEX_API_KEY?.trim(),
  ) {}

  async search(query: ScientificSearchQuery): Promise<SourceSearchResult> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'PlasmaTech-AI-SciFinder/0.1' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetcher(buildOpenAlexUrl(query), {
        headers, cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404 && query.doi) return { publications: [], total: 0 };
      if (response.status === 401 || response.status === 403) throw new ScientificSearchError('OPENALEX_AUTH', 'OpenAlex отклонил доступ. Проверьте OPENALEX_API_KEY на сервере или используйте Crossref.', 502);
      if (response.status === 429) throw new ScientificSearchError('OPENALEX_RATE_LIMIT', 'Лимит OpenAlex исчерпан. Повторите позже; бесплатный ключ OPENALEX_API_KEY повышает лимит запросов без ключа.', 429, true);
      if (!response.ok) throw new ScientificSearchError('OPENALEX_ERROR', 'OpenAlex не смог обработать запрос. Уточните запрос или повторите позже.', 502, true);
      const body = asRecord(await response.json());
      if (query.doi) return { publications: [normalizeOpenAlexWork(body)], total: 1 };
      const total = asRecord(body.meta).count;
      if (!Array.isArray(body.results) || typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw new Error('Invalid OpenAlex response');
      return { publications: body.results.map(normalizeOpenAlexWork), total };
    } catch (error) {
      if (error instanceof ScientificSearchError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new ScientificSearchError('OPENALEX_TIMEOUT', 'OpenAlex не ответил вовремя. Повторите поиск.', 504, true);
      // Never expose the API key, request headers or raw upstream error bodies.
      throw new ScientificSearchError('OPENALEX_UNAVAILABLE', 'Не удалось получить данные OpenAlex. Проверьте соединение и повторите поиск.', 502, true);
    }
  }
}
