import 'server-only';
import { ScientificSearchError } from '@/services/scientific-search/errors';
import type { ScientificSearchQuery, ScientificSourceProvider, SourceSearchResult } from '@/services/scientific-search/types';
import { normalizeCrossrefWork, record } from './normalize';

export const CROSSREF_TIMEOUT_MS = 20_000;

export function buildCrossrefUrl(query: ScientificSearchQuery, contactEmail?: string): URL {
  // The host is fixed; user input is encoded as data, never used as a fetch URL.
  const url = new URL(query.doi ? `works/${encodeURIComponent(query.doi)}` : 'works', 'https://api.crossref.org/');
  if (contactEmail) url.searchParams.set('mailto', contactEmail);
  if (!query.doi) {
    url.searchParams.set('query.bibliographic', [query.query, query.keywords].filter(Boolean).join(' '));
    url.searchParams.set('rows', String(query.limit));
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('select', 'DOI,title,author,published,issued,container-title,abstract,publisher,URL,type');
    const filters: string[] = [];
    if (query.yearFrom) filters.push(`from-pub-date:${query.yearFrom}-01-01`);
    if (query.yearTo) filters.push(`until-pub-date:${query.yearTo}-12-31`);
    if (query.journalOnly || query.type) filters.push(`type:${query.journalOnly ? 'journal-article' : query.type}`);
    if (query.hasAbstract) filters.push('has-abstract:true');
    if (filters.length) url.searchParams.set('filter', filters.join(','));
  }
  return url;
}

export class CrossrefProvider implements ScientificSourceProvider {
  readonly id = 'crossref' as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = CROSSREF_TIMEOUT_MS,
    private readonly contactEmail = process.env.CROSSREF_CONTACT_EMAIL?.trim(),
  ) {}

  async search(query: ScientificSearchQuery): Promise<SourceSearchResult> {
    try {
      const response = await this.fetcher(buildCrossrefUrl(query, this.contactEmail), {
        headers: { Accept: 'application/json', 'User-Agent': 'PlasmaTech-AI-SciFinder/0.1' },
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: 'no-store',
      });
      if (response.status === 404 && query.doi) return { publications: [], total: 0 };
      if (response.status === 429) {
        throw new ScientificSearchError('RATE_LIMITED', 'Crossref временно ограничил запросы. Подождите минуту и повторите поиск.', 429, true);
      }
      if (!response.ok) {
        throw new ScientificSearchError('UPSTREAM_ERROR', 'Crossref сейчас не смог обработать запрос. Повторите поиск позже.', 502, true);
      }
      const body = record(await response.json());
      const message = record(body.message);
      if (body.status !== 'ok') throw new Error('Invalid Crossref envelope');
      if (query.doi) {
        if (!message.DOI) throw new Error('Missing Crossref DOI');
        return { publications: [normalizeCrossrefWork(message)], total: 1 };
      }
      if (!Array.isArray(message.items) || typeof message['total-results'] !== 'number') {
        throw new Error('Invalid Crossref result list');
      }
      if (message.items.some(item => typeof record(item).DOI !== 'string')) throw new Error('Invalid Crossref work');
      return { publications: message.items.map(normalizeCrossrefWork), total: message['total-results'] };
    } catch (error) {
      if (error instanceof ScientificSearchError) throw error;
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
        throw new ScientificSearchError('UPSTREAM_TIMEOUT', 'Crossref не ответил вовремя. Попробуйте повторить поиск или уточнить запрос.', 504, true);
      }
      // Do not return upstream URLs, query strings, credentials or raw responses.
      throw new ScientificSearchError('SOURCE_UNAVAILABLE', 'Не удалось получить данные Crossref. Проверьте соединение и повторите поиск.', 502, true);
    }
  }
}
