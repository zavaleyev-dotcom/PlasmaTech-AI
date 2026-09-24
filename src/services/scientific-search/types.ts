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

/** F20: combined-search continuation state - the client's own opaque token, echoed back
 *  verbatim on the NEXT page request (and cached locally per page for "back" navigation). This
 *  app is fully stateless server-side (no session store), so the state that makes combined
 *  pagination correct - each provider's own next offset/exhaustion, and the carry-over buffer
 *  of already-fetched-but-not-yet-shown unique records - has to live somewhere, and the client
 *  is the only place that persists between requests here.
 *
 *  `buffer` is what actually fixes the lost-results bug: when a page's combined, deduplicated,
 *  filtered result set has MORE unique records than `limit`, the leftover is carried here
 *  instead of being silently discarded - the next page drains this FIRST, only fetching more
 *  from a provider when the buffer alone cannot fill a page. `emittedKeys` (DOI/title+year
 *  identity, matching deduplicatePublications's own notion of "the same work") prevents a
 *  record already shown on an earlier page from ever being re-emitted, even if a later fetch
 *  from either provider happens to return it again. Bounded by construction: `buffer` never
 *  exceeds one page's worth of records, and `emittedKeys` never exceeds MAX_SEARCH_OFFSET
 *  entries (this app never pages deeper than that). */
export interface SearchContinuation {
  crossrefOffset: number;
  openalexOffset: number;
  crossrefTotal: number | null;
  openalexTotal: number | null;
  crossrefExhausted: boolean;
  openalexExhausted: boolean;
  buffer: Publication[];
  emittedKeys: string[];
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
   *  fetched all at once. Meaningful for `source: 'crossref'|'openalex'` only - combined mode
   *  uses `continuation` instead (see below), since a single shared offset is exactly what
   *  previously caused combined pagination to silently drop results. */
  offset: number;
  /** F20: combined-mode-only continuation from a PREVIOUS response's own `continuation` field
   *  - omitted (or provided as `undefined`) for a fresh query, which always starts both
   *  providers at offset 0 with an empty buffer, exactly like `offset: 0` does for a
   *  single-provider search. Ignored entirely for `source: 'crossref'|'openalex'`. */
  continuation?: SearchContinuation;
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
   *  came back full, and never true past the deep-pagination bound. For combined mode, reflects
   *  the ACTUAL combined continuation (buffer + provider exhaustion), never just one provider's
   *  own response. */
  hasMore: boolean;
  /** F20: combined-mode-only - the client must cache this (e.g. one entry per page, for "back"
   *  navigation) and echo it back verbatim as the NEXT request's `continuation` to keep paging
   *  forward without losing or re-emitting a result. Absent for single-provider searches, which
   *  use the simpler `offset` contract above instead. */
  continuation?: SearchContinuation;
}

export interface SearchErrorBody {
  error: { code: string; message: string; retryable: boolean };
}
