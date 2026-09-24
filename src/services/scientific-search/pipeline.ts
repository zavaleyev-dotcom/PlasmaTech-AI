import { deduplicatePublications, publicationIdentityKey } from './deduplicate';
import { filterPublications } from './filters';
import { sortPublications } from './sort';
import { ScientificSearchError } from './errors';
import {
  MAX_SEARCH_OFFSET, MAX_COMBINED_SEARCH_DEPTH, MAX_COMBINED_EMITTED_KEYS,
  type ScientificSearchQuery, type ScientificSearchResult, type ScientificSourceProvider, type Publication,
  type SearchContinuation,
} from './types';

/** Single-provider search (source: 'crossref' | 'openalex') - unchanged from the previous F20
 *  fix: one provider, one shared `offset`, no continuation state needed since there is nothing
 *  to merge across providers. */
async function runSingleProviderSearch(query: ScientificSearchQuery, providerItem: ScientificSourceProvider): Promise<ScientificSearchResult> {
  const responses = await Promise.allSettled([providerItem.search(query)]);
  const records: Publication[] = [];
  const sourceStats: ScientificSearchResult['sourceStats'] = [];
  const warnings: string[] = [];
  const response = responses[0];
  const source = providerItem.id;
  if (response.status === 'fulfilled') {
    sourceStats.push({ source, total: response.value.total, retrieved: response.value.publications.length });
    records.push(...response.value.publications.map((item, rank) => ({ ...item, relevanceScore: 1 / (60 + rank + 1) })));
  } else {
    if (response.reason instanceof ScientificSearchError) throw response.reason;
    throw new ScientificSearchError('SOURCES_UNAVAILABLE', 'Не удалось получить данные научных источников. Повторите поиск.', 502, true);
  }
  if (query.openAccessOnly && query.source === 'crossref') warnings.push('Crossref не предоставляет надёжный статус Open Access в этой интеграции. Неизвестный статус исключён; для OA используйте OpenAlex или совместный поиск.');
  const unique = deduplicatePublications(records);
  const filtered = filterPublications(unique, query);
  const publications = sortPublications(filtered, query.sort).slice(0, query.limit);
  const offset = query.offset ?? 0;
  // "more available" is honest per-provider - true only if the provider's own reported total
  // genuinely extends past this page's window, and never true once the next page would cross
  // the deep-pagination bound (so the UI's "Next" naturally disables there instead of the
  // backend silently walking further).
  const hasMore = offset + query.limit < MAX_SEARCH_OFFSET
    && sourceStats.some(item => item.total !== null && offset + query.limit < item.total);
  return {
    publications, total: sourceStats.reduce((sum, item) => sum + (item.total ?? 0), 0), source: query.source, query,
    retrieved: records.length, duplicatesRemoved: records.length - unique.length,
    uniqueRetrieved: unique.length, filteredOut: unique.length - filtered.length,
    returned: publications.length, sourceStats, warnings, offset, hasMore,
  };
}

const emptyContinuation = (): SearchContinuation => ({
  crossrefOffset: 0, openalexOffset: 0, crossrefTotal: null, openalexTotal: null,
  crossrefExhausted: false, openalexExhausted: false, buffer: [], emittedKeys: [],
});

/** F20: combined search (source: 'combined') - Crossref and OpenAlex each keep their OWN
 *  cursor/exhaustion state, and a carry-over BUFFER holds unique records that were already
 *  fetched but did not fit on a previous page, so they are never silently discarded (the
 *  Codex-reported bug: 2 providers x 20 unique each, limit 20 -> page 1 showed 20 of 40 and
 *  page 2 skipped both providers straight to offset 20, losing the other 20 forever).
 *
 *  Each call: (1) start from the caller's continuation (or a fresh, empty one for a new
 *  query); (2) fetch ONE more round from EVERY not-yet-exhausted provider, together, ONLY if
 *  the buffer does not already hold more than one page's worth (this is both what stops the
 *  old "always fetch `limit` from both, always truncate the merged set back down to `limit`"
 *  pattern that was discarding records, AND what keeps the buffer/continuation itself from
 *  growing without bound across many pages) - never more than one round per provider per
 *  call, so a single request can never auto-walk deeper than one page's worth of extra
 *  fetching, AND only if that provider's own offset has not yet reached
 *  MAX_COMBINED_SEARCH_DEPTH (Codex re-detection #3 - see below); (3) dedupe/filter/sort the
 *  WHOLE pool (buffer + freshly fetched) exactly like a normal page; (4) emit the first
 *  `limit`, carry the rest into the new buffer, and record what was emitted in `emittedKeys`
 *  so it can never be re-emitted by a later fetch that happens to return it again.
 *
 *  F20 (Codex re-detection #3): combined mode has NO usable `query.offset` - the client keeps
 *  it fixed at 0 for a combined search's entire lifetime (see search.tsx; only `continuation`
 *  ever advances), so a depth-bound check that read `query.offset` here was comparing against
 *  a value that never changed and therefore never fired: `crossrefOffset`/`openalexOffset`
 *  could climb forever, and `emittedKeys` grew right along with them. The bound is now
 *  enforced directly against each provider's OWN tracked offset (MAX_COMBINED_SEARCH_DEPTH),
 *  which is also what makes `emittedKeys` bounded again - it cannot grow once nothing more is
 *  ever fetched. */
async function runCombinedSearch(query: ScientificSearchQuery, crossref: ScientificSourceProvider, openalex: ScientificSourceProvider): Promise<ScientificSearchResult> {
  const incoming = query.continuation ?? emptyContinuation();
  const emittedKeys = new Set(incoming.emittedKeys);
  const pool: Publication[] = [...incoming.buffer];

  let crossrefOffset = incoming.crossrefOffset;
  let openalexOffset = incoming.openalexOffset;
  let crossrefTotal = incoming.crossrefTotal;
  let openalexTotal = incoming.openalexTotal;
  let crossrefExhausted = incoming.crossrefExhausted;
  let openalexExhausted = incoming.openalexExhausted;

  const sourceStats: ScientificSearchResult['sourceStats'] = [];
  const warnings: string[] = [];
  let anySuccess = false;

  async function fetchRound(providerItem: ScientificSourceProvider, offset: number): Promise<{ nextOffset: number; exhausted: boolean; total: number | null }> {
    try {
      const result = await providerItem.search({ ...query, offset });
      anySuccess = true;
      sourceStats.push({ source: providerItem.id, total: result.total, retrieved: result.publications.length });
      const scored = result.publications.map((item, rank) => ({ ...item, relevanceScore: 1 / (60 + rank + 1) }));
      for (const item of scored) {
        const key = publicationIdentityKey(item);
        if (key && emittedKeys.has(key)) continue; // already shown on an earlier page - never re-emit
        pool.push(item);
      }
      return { nextOffset: offset + result.publications.length, exhausted: result.publications.length < query.limit, total: result.total };
    } catch (error) {
      const message = error instanceof ScientificSearchError ? error.message : 'Источник временно недоступен.';
      sourceStats.push({ source: providerItem.id, total: null, retrieved: 0, error: message });
      warnings.push(`${providerItem.id === 'crossref' ? 'Crossref' : 'OpenAlex'}: ${message}`);
      // A provider failure this round does not permanently mark it exhausted - a LATER page
      // may retry it (transient failures like a rate limit should not permanently strand the
      // other provider's remaining results as "the only source" forever).
      return { nextOffset: offset, exhausted: false, total: null };
    }
  }

  // F20 (Codex regression #2): only fetch a fresh round when the carry-over buffer does NOT
  // already comfortably cover this page - fetching unconditionally from both providers on
  // EVERY page (the previous version of this fix) never lost a record, but it never stopped
  // growing either: each round pulled in up to 2x`limit` fresh records while only `limit`
  // were emitted, so the buffer - and the `continuation` object the client must cache and
  // echo back on every request - grew by a net `limit` records forever, violating "bounded
  // continuation state". The gate below (<=, not <) still fetches whenever the buffer holds
  // AT MOST one page's worth, so with two evenly-supplied providers a fetch still happens
  // every OTHER round at most, keeping the buffer providably bounded (oscillating, never
  // exceeding roughly 2x`limit`) while a transient provider failure is still discovered
  // within at most one extra page, never silently deferred indefinitely.
  //
  // The gate is evaluated ONCE, for both providers together - never per-provider. Skipping
  // only ONE provider's fetch while still fetching the other would let its offset fall
  // behind and bias the merged/sorted pool toward whichever provider kept advancing, exactly
  // the "show Crossref until it runs out, then OpenAlex" failure this design deliberately
  // avoids; both providers always advance in lockstep whenever a fetch round does happen.
  // Nothing fetched is ever discarded either way - this only decides WHEN the next round's
  // extra records get pulled in, never IF a fetched unique record eventually gets emitted.
  // F20 (Codex re-detection #3): a provider at/past MAX_COMBINED_SEARCH_DEPTH is treated
  // exactly like an exhausted one for fetch-gating purposes - its offset simply stops
  // advancing and it is never fetched from again this session, regardless of what its own
  // `total` claims. This is the actual enforcement point for the combined-mode depth bound
  // (nothing upstream of this can be trusted to stop it, since `query.offset` cannot).
  if (incoming.buffer.length <= query.limit) {
    if (!crossrefExhausted && crossrefOffset < MAX_COMBINED_SEARCH_DEPTH) {
      const round = await fetchRound(crossref, crossrefOffset);
      crossrefOffset = round.nextOffset; crossrefExhausted = round.exhausted || crossrefExhausted; crossrefTotal = round.total ?? crossrefTotal;
    }
    if (!openalexExhausted && openalexOffset < MAX_COMBINED_SEARCH_DEPTH) {
      const round = await fetchRound(openalex, openalexOffset);
      openalexOffset = round.nextOffset; openalexExhausted = round.exhausted || openalexExhausted; openalexTotal = round.total ?? openalexTotal;
    }
  }

  // F20 (Codex re-detection #3): each provider is "done" once it is genuinely exhausted OR its
  // own offset has reached MAX_COMBINED_SEARCH_DEPTH - the bound now lives entirely on the
  // providers' own tracked offsets, never on `query.offset` (which combined mode never
  // advances - see the module doc comment above). `boundReached` is only true when the bound,
  // not genuine exhaustion, is what actually cut a provider off - so the UI's message stays
  // honest instead of firing on ordinary end-of-results too.
  const crossrefBounded = crossrefOffset >= MAX_COMBINED_SEARCH_DEPTH;
  const openalexBounded = openalexOffset >= MAX_COMBINED_SEARCH_DEPTH;
  const crossrefDone = crossrefExhausted || crossrefBounded;
  const openalexDone = openalexExhausted || openalexBounded;

  // F20 (Codex re-detection #3): an empty result with nothing fetched THIS round is only a
  // genuine failure when at least one provider was actually still eligible to be fetched from
  // and simply came back empty/errored. Once both providers are already done (exhausted, or
  // correctly held at the depth bound - the whole point of this fix), a call that lands here
  // with an empty pool is the legitimate, honest end of a bounded/exhausted combined search,
  // never a "sources unavailable" error - the fetch block above deliberately skipped both
  // providers on purpose, so `anySuccess` staying false says nothing about availability.
  if (!anySuccess && pool.length === 0 && !(crossrefDone && openalexDone)) {
    throw new ScientificSearchError('SOURCES_UNAVAILABLE', 'Не удалось получить данные научных источников. Повторите поиск.', 502, true);
  }

  const unique = deduplicatePublications(pool);
  const filtered = filterPublications(unique, query);
  const sorted = sortPublications(filtered, query.sort);
  const publications = sorted.slice(0, query.limit);
  const remainder = sorted.slice(query.limit); // never dropped - carried into the next page's buffer
  for (const item of publications) { const key = publicationIdentityKey(item); if (key) emittedKeys.add(key); }
  // F20 (Codex re-detection #3): defense in depth on top of the offset bound above - even if
  // something upstream ever let a round over-fetch, `emittedKeys` itself can never exceed this
  // cap. Keeps the NEWEST keys (the ones a subsequent fetch is actually at risk of re-hitting),
  // never the oldest - see the matching slice(-N) in validation.ts's parseContinuation.
  const boundedEmittedKeys = [...emittedKeys].slice(-MAX_COMBINED_EMITTED_KEYS);

  const offset = query.offset ?? 0;
  // hasMore reflects the ACTUAL combined continuation - true if there is still buffered
  // content (always drained fully, bound or not - the bound only stops FETCHING further, it
  // never discards what was already fetched), or either provider is neither exhausted nor
  // bounded and its own reported total, if known, has not been fully consumed.
  const hasMore = remainder.length > 0
    || (!crossrefDone && (crossrefTotal === null || crossrefOffset < crossrefTotal))
    || (!openalexDone && (openalexTotal === null || openalexOffset < openalexTotal));
  const boundReached = !hasMore && (crossrefBounded || openalexBounded);

  const continuation: SearchContinuation = {
    crossrefOffset, openalexOffset, crossrefTotal, openalexTotal, crossrefExhausted, openalexExhausted,
    buffer: remainder, emittedKeys: boundedEmittedKeys,
  };

  return {
    publications, total: (crossrefTotal ?? 0) + (openalexTotal ?? 0), source: 'combined', query,
    retrieved: pool.length, duplicatesRemoved: pool.length - unique.length,
    uniqueRetrieved: unique.length, filteredOut: unique.length - filtered.length,
    returned: publications.length, sourceStats, warnings, offset, hasMore, continuation, boundReached,
  };
}

export async function runSearch(
  query: ScientificSearchQuery,
  provider: ScientificSourceProvider | ScientificSourceProvider[],
): Promise<ScientificSearchResult> {
  if (!Array.isArray(provider)) return runSingleProviderSearch(query, provider);
  const crossref = provider.find(p => p.id === 'crossref');
  const openalex = provider.find(p => p.id === 'openalex');
  if (!crossref || !openalex) {
    // Defensive only - this app only ever constructs [crossref, openalex] for combined mode
    // (src/services/scientific-search/index.ts); falls back to the single-provider path for
    // whichever ONE provider actually is present rather than crashing.
    const only = provider[0];
    if (!only) throw new ScientificSearchError('SOURCES_UNAVAILABLE', 'Не удалось получить данные научных источников. Повторите поиск.', 502, true);
    return runSingleProviderSearch(query, only);
  }
  return runCombinedSearch(query, crossref, openalex);
}
