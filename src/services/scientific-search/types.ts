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
 *  grows past roughly two pages' worth of records (the pipeline only fetches a fresh round
 *  once the buffer has AT MOST one page's worth left, so it oscillates rather than growing
 *  forever), `crossrefOffset`/`openalexOffset` never advance past MAX_COMBINED_SEARCH_DEPTH
 *  (the pipeline stops fetching from a provider once its own offset reaches the bound, exactly
 *  like an exhausted provider), and `emittedKeys` never exceeds MAX_COMBINED_EMITTED_KEYS
 *  entries (enforced both by the offset bound making further growth impossible, and as an
 *  explicit cap on the parsed/persisted array itself). */
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

/** F20 (Codex re-detection #3): the deepest offset EITHER provider may ever be advanced to in
 *  COMBINED mode. Deliberately the same value as MAX_SEARCH_OFFSET (one honest pagination-depth
 *  bound for the whole app), but named and exported separately because combined mode cannot
 *  reuse `query.offset` to enforce it: the client keeps `query.offset` fixed at 0 for the whole
 *  life of a combined search (only `continuation` advances - see below), so a bound check that
 *  read `query.offset` in combined mode was comparing against a value that never changed,
 *  silently never firing. Only `crossrefOffset`/`openalexOffset`, tracked inside
 *  `SearchContinuation` itself, can enforce this bound. */
export const MAX_COMBINED_SEARCH_DEPTH = MAX_SEARCH_OFFSET;

/** F20 (Codex re-detection #3): hard cap on `SearchContinuation.emittedKeys`. Once both
 *  providers' offsets are held at/under MAX_COMBINED_SEARCH_DEPTH (enforced in the pipeline),
 *  the TOTAL number of records either provider can ever supply across an entire combined
 *  session is naturally bounded - each provider stops being fetched from once its own offset
 *  would cross the depth bound, so at most one round can overshoot it by less than one page.
 *  With the largest allowed page size (50) this puts a provably safe ceiling on how many
 *  records either provider could ever contribute, and therefore on `emittedKeys` itself:
 *  `2 * (bound + largest limit)`. Kept as an explicit, independently-enforced cap (not just a
 *  side effect of the offset bound) so `emittedKeys` can never grow without limit even if a
 *  future change to the offset bound is made without updating this file. */
export const MAX_COMBINED_EMITTED_KEYS = 2 * (MAX_COMBINED_SEARCH_DEPTH + 50);

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
  /** F20 (Codex re-detection #3): combined-mode-only - true once `hasMore` has gone false
   *  BECAUSE at least one provider was cut off by MAX_COMBINED_SEARCH_DEPTH, as opposed to
   *  both providers having genuinely run out of real results on their own. The UI uses this to
   *  show an honest "search depth limit reached" message instead of silently disabling "Next"
   *  as if the dataset itself had simply ended - never exposes the numeric bound itself. */
  boundReached?: boolean;
}

export interface SearchErrorBody {
  error: { code: string; message: string; retryable: boolean };
}
