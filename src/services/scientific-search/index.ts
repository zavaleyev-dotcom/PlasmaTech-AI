import 'server-only';
import { CrossrefProvider } from '@/integrations/crossref';
import { OpenAlexProvider } from '@/integrations/openalex';
import { parseSearchQuery } from './validation';
import { runSearch } from './pipeline';
import { processContinuationStore, isValidContinuationToken, type ContinuationStore } from './continuation-store';
import type { ScientificSearchResult, ScientificSearchWireResult, ScientificSourceProvider } from './types';

const providers = {
  crossref: new CrossrefProvider(),
  openalex: new OpenAlexProvider(),
};

/** F20 production remediation: the request's raw `continuation` token, read directly off the
 *  untrusted input (the same lenient shape check parseSearchQuery's resolveContinuation uses)
 *  purely so it can be echoed back in the wire response's `query.continuation` below - NEVER
 *  used to look anything up here (that already happened once, inside parseSearchQuery). */
function rawIncomingToken(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>).continuation;
  return isValidContinuationToken(value) ? value : undefined;
}

/** F20 production remediation (Codex re-detection #4): converts the pipeline's internal result
 *  (continuation as the full typed SearchContinuation object) into the compact wire shape
 *  actually sent to the client - see continuation-store.ts's doc comment for why. Replaces
 *  BOTH `result.continuation` (the token for the NEXT page) and `result.query.continuation`
 *  (echoing the token that was RECEIVED this request, never the resolved object) so the bulky
 *  server-side state can never leak into a response body either. */
function toWireResult(result: ScientificSearchResult, store: ContinuationStore, incomingToken: string | undefined): ScientificSearchWireResult {
  const { continuation, query, ...rest } = result;
  return {
    ...rest,
    query: { ...query, continuation: incomingToken },
    continuation: continuation ? store.save(continuation) : undefined,
  };
}

export async function searchPublications(
  input: unknown,
  deps: { store?: ContinuationStore; crossref?: ScientificSourceProvider; openalex?: ScientificSourceProvider } = {},
): Promise<ScientificSearchWireResult> {
  const store = deps.store ?? processContinuationStore;
  const crossref = deps.crossref ?? providers.crossref;
  const openalex = deps.openalex ?? providers.openalex;
  const query = parseSearchQuery(input, store);
  const result = await runSearch(query, query.source === 'combined' ? [crossref, openalex] : (query.source === 'crossref' ? crossref : openalex));
  return toWireResult(result, store, rawIncomingToken(input));
}
