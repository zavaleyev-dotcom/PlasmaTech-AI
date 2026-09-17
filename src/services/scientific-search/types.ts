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
}

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
}

export interface SearchErrorBody {
  error: { code: string; message: string; retryable: boolean };
}
