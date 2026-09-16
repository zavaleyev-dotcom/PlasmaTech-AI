import 'server-only';
import { ScientificSearchError } from '@/services/scientific-search/errors';
import type { ScientificSearchQuery, ScientificSourceProvider, SourceSearchResult } from '@/services/scientific-search/types';

/** Prepared adapter. A key alone does not opt the platform into external calls. */
export class OpenAlexProvider implements ScientificSourceProvider {
  readonly id = 'openalex' as const;

  getStatus(): { configured: boolean; active: false } {
    return { configured: Boolean(process.env.OPENALEX_API_KEY?.trim()), active: false };
  }

  async search(_query: ScientificSearchQuery): Promise<SourceSearchResult> {
    // Reserved for an explicit future implementation and activation.
    void _query;
    throw new ScientificSearchError('SOURCE_NOT_ACTIVE', 'OpenAlex подготовлен, но пока не активирован. Выберите Crossref.', 503);
  }
}
