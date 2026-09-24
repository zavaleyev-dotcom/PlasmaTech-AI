export type PublicationSource = 'crossref' | 'openalex' | 'semantic-scholar' | 'google-drive' | 'local';

/** Shared bibliographic model; absent metadata stays null, never inferred. */
export interface Publication {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  doi: string | null;
  abstract: string | null;
  publisher: string | null;
  url: string | null;
  type: string | null;
  source: PublicationSource;
  sources: PublicationSource[];
  openAccess: boolean | null;
  citationCount: number | null;
  openAlexId: string | null;
  /** Reciprocal source-rank score, calculated only by the search pipeline. */
  relevanceScore?: number;
}

export const publicationTypes = [
  'journal-article', 'proceedings-article', 'book-chapter', 'book',
  'posted-content', 'report', 'dissertation', 'dataset',
] as const;
export type PublicationTypeFilter = '' | (typeof publicationTypes)[number];

export interface PublicationFilters {
  yearFrom?: number;
  yearTo?: number;
  type: PublicationTypeFilter;
  journalOnly: boolean;
  hasDoi: boolean;
  hasAbstract: boolean;
  openAccessOnly: boolean;
}

export interface ScientificSearchQuery extends PublicationFilters {
  query: string;
  keywords: string;
  doi: string;
  limit: 10 | 25 | 50;
  source: 'crossref' | 'openalex' | 'combined';
  sort: 'relevance' | 'year' | 'citations' | 'open-access';
  /** F20: 0-based record offset - Crossref applies this directly (its own native `offset`
   *  param); OpenAlex converts it to its own `page` param (page = offset/limit + 1). Always a
   *  multiple of `limit` in a well-formed request (the UI only ever moves by whole pages).
   *  Clamped server-side to MAX_SEARCH_OFFSET - deep pagination is intentionally bounded, never
   *  fetched all at once. */
  offset: number;
}

/** F20: the deepest record offset this app will ever request from a provider - a deliberate,
 *  honest bound (not every provider page is reliably rankable arbitrarily deep, and nothing
 *  here auto-walks every page), never silently exceeded. */
export const MAX_SEARCH_OFFSET = 500;

export interface SourceSearchResult {
  publications: Publication[];
  total: number;
}

/** Each adapter owns its remote schema and returns normalized publications. */
export interface ScientificSourceProvider {
  readonly id: PublicationSource;
  search(query: ScientificSearchQuery): Promise<SourceSearchResult>;
}

export interface ScientificSearchResult extends SourceSearchResult {
  source: ScientificSearchQuery['source'];
  retrieved: number;
  duplicatesRemoved: number;
  filteredOut: number;
  returned: number;
  query: ScientificSearchQuery;
  sourceStats: { source: PublicationSource; total: number | null; retrieved: number; error?: string }[];
  warnings: string[];
  uniqueRetrieved: number;
  /** F20: the offset ACTUALLY used for this response (after clamping to MAX_SEARCH_OFFSET) -
   *  the UI must show this, not just echo back whatever it requested, so a clamp is always
   *  visible rather than silently ignored. */
  offset: number;
  /** F20: honestly derived from each successful provider's own reported total vs this page's
   *  offset+limit (and the MAX_SEARCH_OFFSET bound) - never assumed true just because this page
   *  came back full, and never true past the deep-pagination bound. */
  hasMore: boolean;
}

export interface SearchErrorBody {
  error: { code: string; message: string; retryable: boolean };
}
