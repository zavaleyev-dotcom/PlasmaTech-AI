import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrossrefProvider, buildCrossrefUrl } from '../src/integrations/crossref';
import { normalizeCrossrefWork } from '../src/integrations/crossref/normalize';
import { OpenAlexProvider } from '../src/integrations/openalex';
import { normalizeOpenAlexWork, reconstructAbstract } from '../src/integrations/openalex/normalize';
import { sortPublications } from '../src/services/scientific-search/sort';
import { ScientificSearchError } from '../src/services/scientific-search/errors';
import { deduplicatePublications } from '../src/services/scientific-search/deduplicate';
import { filterPublications } from '../src/services/scientific-search/filters';
import { normalizeDoi, plainText, safeUrl } from '../src/services/scientific-search/normalization';
import { parseSearchQuery } from '../src/services/scientific-search/validation';
import { runSearch } from '../src/services/scientific-search/pipeline';
import { buildOpenAlexUrl } from '../src/integrations/openalex';
import {
  MAX_SEARCH_OFFSET, MAX_COMBINED_SEARCH_DEPTH, MAX_COMBINED_EMITTED_KEYS,
  type Publication, type ScientificSourceProvider, type ScientificSearchResult,
} from '../src/services/scientific-search/types';
import { POST } from '../src/app/api/scifinder/search/route';

const query = parseSearchQuery({ query: 'AlTiSiN coating cutting tools' });
const fixture = {
  DOI: '10.1234/TiN', title: ['<i>TiN</i> &amp; wear'],
  author: [{ given: 'A.', family: 'Researcher' }, { name: 'Surface Laboratory' }],
  published: { 'date-parts': [[2022, 1]] }, 'container-title': ['Surface Engineering'],
  publisher: 'Publisher', type: 'journal-article', URL: 'https://example.org/article',
  abstract: '<jats:p>Wear &lt; 5 &amp; hardness &#x3B1;.</jats:p>',
  license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }],
};
const base = normalizeCrossrefWork(fixture);
function publication(values: Partial<Publication> = {}): Publication { return { ...base, ...values }; }

function fakeResponse(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('normalization preserves bibliographic metadata without inferring OA or peer review', () => {
  assert.equal(base.title, 'TiN & wear');
  assert.equal(base.doi, '10.1234/tin');
  assert.equal(base.year, 2022);
  assert.deepEqual(base.authors, ['A. Researcher', 'Surface Laboratory']);
  assert.equal(base.abstract, 'Wear < 5 & hardness α.');
  assert.equal(base.openAccess, null);
  assert.equal('peerReviewed' in base, false);
  assert.equal(normalizeCrossrefWork({ title: ['Untitled work'] }).year, null);
  assert.equal(normalizeCrossrefWork({ URL: 'javascript:alert(1)' }).url, null);
  assert.equal(plainText('<script>alert(1)</script><p>Hello</p>'), 'Hello');
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('https://user:password@example.org'), null);
});

test('DOI normalization accepts resolver URLs and rejects invalid identifiers', () => {
  assert.equal(normalizeDoi(' https://doi.org/10.1234%2FTiN '), '10.1234/tin');
  assert.equal(normalizeDoi('doi: 10.1234/TiN'), '10.1234/tin');
  assert.equal(normalizeDoi('https://evil.example/10.1234/tin'), null);
  assert.equal(normalizeDoi('10.1234/contains spaces'), null);
});

test('deduplication prioritizes DOI and enriches records while preserving relevance order', () => {
  const records = deduplicatePublications([
    publication({ id: 'local:1', doi: null, title: 'TIN & WEAR', abstract: null, source: 'local', sources: ['local'] }),
    publication({ id: 'crossref:1' }),
    publication({ id: 'openalex:1', doi: 'https://doi.org/10.1234/TIN', sources: ['openalex'], source: 'openalex' }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].doi, '10.1234/tin');
  assert.ok(records[0].abstract);
  assert.deepEqual(new Set(records[0].sources), new Set(['local', 'crossref', 'openalex']));
  assert.equal(deduplicatePublications([publication({ doi: null }), publication({ doi: null })]).length, 1);
  assert.equal(deduplicatePublications([publication(), publication({ doi: '10.1234/another' })]).length, 2);
  assert.equal(deduplicatePublications([publication({ doi: null, year: null }), publication({ doi: null, year: null })]).length, 2);
  assert.equal(deduplicatePublications([publication({ doi: null }), publication(), publication({ doi: '10.1234/another' })]).length, 3);
});

test('filters apply inclusive years, types, DOI and abstract, and exclude missing years', () => {
  const records = [base, publication({ year: 2021 }), publication({ year: null }), publication({ type: 'book' }), publication({ doi: null }), publication({ abstract: null })];
  const filters = { ...query, yearFrom: 2022, yearTo: 2022, journalOnly: true, hasDoi: true, hasAbstract: true };
  assert.deepEqual(filterPublications(records, filters), [base]);
  assert.equal(filterPublications(records, { ...query, type: 'book' }).length, 1);
});

test('request validation rejects unsafe, inconsistent and unbounded inputs', () => {
  for (const input of [null, [], {}, { query: 'x', limit: 1000 }, { query: 'x', yearFrom: 2023, yearTo: 2020 }, { query: 'x', hasDoi: 'true' }, { query: 'x', type: 'invalid' }, { query: 'x', source: 'unknown' }, { doi: 'invalid' }, { query: 'x'.repeat(501) }, { query: 'x', journalOnly: true, type: 'book' }]) {
    assert.throws(() => parseSearchQuery(input));
  }
  assert.equal(parseSearchQuery({ keywords: 'PVD', limit: 25 }).limit, 25);
  assert.equal(parseSearchQuery({ doi: 'https://doi.org/10.1234/ABC', limit: 50 }).doi, '10.1234/abc');
});

test('Crossref URL uses encoded bibliographic parameters and server-side filters', () => {
  const url = buildCrossrefUrl({ ...query, keywords: 'PVD & CVD', yearFrom: 2020, yearTo: 2024, journalOnly: true, hasAbstract: true });
  assert.equal(url.origin, 'https://api.crossref.org');
  assert.equal(url.searchParams.get('rows'), '10');
  assert.equal(url.searchParams.get('query.bibliographic'), 'AlTiSiN coating cutting tools PVD & CVD');
  assert.equal(url.searchParams.get('filter'), 'from-pub-date:2020-01-01,until-pub-date:2024-12-31,type:journal-article,has-abstract:true');
  const exact = buildCrossrefUrl({ ...query, doi: '10.1234/test?x=1#part' });
  assert.equal(exact.search, '');
  assert.equal(exact.hash, '');
  assert.ok(exact.pathname.includes('%3F'));
});

test('Crossref adapter normalizes search and DOI responses; DOI 404 means no results', async () => {
  const provider = new CrossrefProvider(fakeResponse(200, { status: 'ok', message: { items: [fixture], 'total-results': 123 } }));
  const result = await provider.search(query);
  assert.equal(result.total, 123);
  assert.equal(result.publications[0].doi, base.doi);
  const lookup = new CrossrefProvider(fakeResponse(200, { status: 'ok', message: fixture }));
  assert.equal((await lookup.search({ ...query, doi: base.doi! })).publications.length, 1);
  assert.equal((await new CrossrefProvider(fakeResponse(404, {})).search({ ...query, doi: '10.1234/missing' })).total, 0);
});

test('Crossref exposes stable errors for rate limits, server failure, bad schema and timeout', async () => {
  for (const [status, code] of [[429, 'RATE_LIMITED'], [503, 'UPSTREAM_ERROR'], [200, 'SOURCE_UNAVAILABLE']] as const) {
    await assert.rejects(new CrossrefProvider(fakeResponse(status, {})).search(query), { code });
  }
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Keep the event loop alive: AbortSignal.timeout uses an unref'ed timer.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(new CrossrefProvider(fetcher, 10).search(query), { code: 'UPSTREAM_TIMEOUT' }); }
  finally { clearInterval(keepAlive); }
});

test('pipeline distinguishes source total, fetched records, duplicates and filtered records', async () => {
  const provider: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 100, publications: [base, base, publication({ doi: '10.1234/other', year: 2010 })] }; } };
  const response = await runSearch({ ...query, yearFrom: 2020 }, provider);
  assert.equal(response.total, 100); assert.equal(response.retrieved, 3);
  assert.equal(response.duplicatesRemoved, 1); assert.equal(response.filteredOut, 1); assert.equal(response.returned, 1);
});

test('API route validates bodies and returns structured errors without making external requests', async () => {
  for (const [body, status] of [['{', 400], ['{}', 400], ['x'.repeat(17000), 413], [JSON.stringify({ query: 'PVD', source: 'unknown' }), 400]] as const) {
    const response = await POST(new Request('http://localhost/api/scifinder/search', { method: 'POST', body }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).error.message);
  }
});

const openAlexFixture = {
  id: 'https://openalex.org/W123456', doi: 'https://doi.org/10.1234/TIN',
  title: 'TiN & wear', publication_year: 2022, type: 'article', cited_by_count: 42,
  authorships: [{ author: { display_name: 'A. Researcher' } }],
  primary_location: { source: { display_name: 'Surface Engineering', type: 'journal', host_organization: 'https://openalex.org/P123', host_organization_name: 'Publisher' }, landing_page_url: 'https://example.org/article' },
  open_access: { is_oa: true }, abstract_inverted_index: { Wear: [0, 3], resistance: [1], and: [2] },
};

test('OpenAlex normalizes original abstracts, OA, citations and source type', () => {
  const normalized = normalizeOpenAlexWork(openAlexFixture);
  assert.equal(normalized.abstract, 'Wear resistance and Wear');
  assert.equal(normalized.citationCount, 42);
  assert.equal(normalized.openAccess, true);
  assert.equal(normalized.publisher, 'Publisher');
  assert.equal(normalized.type, 'journal-article');
  assert.equal(normalized.openAlexId, 'https://openalex.org/W123456');
  assert.equal(reconstructAbstract({ text: [0, -1, 900000000] }), 'text');
  const sparse = normalizeOpenAlexWork({ id: openAlexFixture.id, type: 'article' });
  assert.equal(sparse.type, 'article'); assert.equal(sparse.citationCount, null); assert.equal(sparse.openAccess, null);
});

test('OpenAlex supports keyless requests and keeps keys only in server headers', async () => {
  for (const key of ['', 'unit-test-placeholder']) {
    const fetcher: typeof fetch = async (url, init) => {
      assert.equal(new URL(String(url)).origin, 'https://api.openalex.org');
      assert.ok(!String(url).includes('unit-test-placeholder'));
      assert.equal(new Headers(init?.headers).get('Authorization'), key ? `Bearer ${key}` : null);
      return new Response(JSON.stringify({ meta: { count: 1 }, results: [openAlexFixture] }));
    };
    const response = await new OpenAlexProvider(fetcher, 20000, key).search({ ...query, source: 'openalex' });
    assert.equal(response.publications[0].doi, base.doi);
  }
  const doi = await new OpenAlexProvider(fakeResponse(200, openAlexFixture), 20000, '').search({ ...query, doi: base.doi! });
  assert.equal(doi.total, 1);
  assert.equal((await new OpenAlexProvider(fakeResponse(404, {}), 20000, '').search({ ...query, doi: base.doi! })).total, 0);
});

test('OpenAlex returns safe errors for authentication, rate limits, malformed responses and timeout', async () => {
  for (const [status, code] of [[401, 'OPENALEX_AUTH'], [429, 'OPENALEX_RATE_LIMIT'], [500, 'OPENALEX_ERROR'], [200, 'OPENALEX_UNAVAILABLE']] as const) {
    await assert.rejects(new OpenAlexProvider(fakeResponse(status, {}), 20000, '').search(query), { code });
  }
  const fetcher: typeof fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(new OpenAlexProvider(fetcher, 10, '').search(query), { code: 'OPENALEX_TIMEOUT' });
});

test('combined search merges DOI metadata, preserves source badges and counts duplicates', async () => {
  const crossref: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 100, publications: [base] }; } };
  const openalex: ScientificSourceProvider = { id: 'openalex', async search() { return { total: 20, publications: [normalizeOpenAlexWork(openAlexFixture)] }; } };
  const result = await runSearch({ ...query, source: 'combined', openAccessOnly: true }, [crossref, openalex]);
  assert.equal(result.returned, 1); assert.equal(result.retrieved, 2); assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.uniqueRetrieved, 1); assert.equal(result.publications[0].citationCount, 42);
  assert.equal(result.publications[0].openAccess, true);
  assert.deepEqual(result.publications[0].sources, ['crossref', 'openalex']);
  assert.deepEqual(result.sourceStats.map(stat => stat.total), [100, 20]);
});

test('combined search preserves successful results on partial failure and reports all failures', async () => {
  const good: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 1, publications: [base] }; } };
  const bad: ScientificSourceProvider = { id: 'openalex', async search() { throw new ScientificSearchError('OPENALEX_TIMEOUT', 'OpenAlex timeout', 504, true); } };
  const result = await runSearch({ ...query, source: 'combined' }, [good, bad]);
  assert.equal(result.returned, 1); assert.equal(result.warnings.length, 1);
  assert.equal(result.sourceStats[1].total, null); assert.ok(result.sourceStats[1].error);
  await assert.rejects(runSearch(query, [bad]), { code: 'OPENALEX_TIMEOUT' });
});

// ---------- F20 (LOW): real pagination across Crossref/OpenAlex, bounded and honest ----------

test('F20 request validation: offset defaults to 0, must be a non-negative multiple of limit, and a too-deep (but well-formed) offset is clamped rather than rejected', () => {
  assert.equal(parseSearchQuery({ query: 'x' }).offset, 0);
  assert.equal(parseSearchQuery({ query: 'x', limit: 25, offset: 50 }).offset, 50);
  for (const bad of [{ query: 'x', offset: -10 }, { query: 'x', offset: 5 }, { query: 'x', limit: 25, offset: 30 }, { query: 'x', offset: 1.5 }]) {
    assert.throws(() => parseSearchQuery(bad), Error, JSON.stringify(bad));
  }
  const deep = parseSearchQuery({ query: 'x', limit: 50, offset: 10_000 });
  assert.ok(deep.offset <= MAX_SEARCH_OFFSET, 'a too-deep offset must be clamped to the bound, never rejected outright');
  assert.equal(deep.offset % 50, 0, 'the clamped offset must still be a real multiple of limit');
});

test('F20 Crossref URL: page 1 (offset 0) and page 2 (offset = limit) request genuinely different, correctly-encoded offset params', () => {
  const page1 = buildCrossrefUrl({ ...query, offset: 0 });
  const page2 = buildCrossrefUrl({ ...query, offset: 10 });
  assert.equal(page1.searchParams.get('offset'), '0');
  assert.equal(page2.searchParams.get('offset'), '10');
  assert.notEqual(page1.toString(), page2.toString());
});

test('F20 OpenAlex URL: offset converts to OpenAlex\'s own 1-based `page` param (page = offset/limit + 1) - page 1, 2, 3', () => {
  const q25 = { ...query, limit: 25 as const };
  assert.equal(buildOpenAlexUrl({ ...q25, offset: 0 }).searchParams.get('page'), '1');
  assert.equal(buildOpenAlexUrl({ ...q25, offset: 25 }).searchParams.get('page'), '2');
  assert.equal(buildOpenAlexUrl({ ...q25, offset: 50 }).searchParams.get('page'), '3');
});

test('F20 pipeline: offset is echoed back in the result exactly as requested, and reaches the provider unchanged', async () => {
  let receivedOffset: number | undefined;
  const provider: ScientificSourceProvider = {
    id: 'crossref',
    async search(q) { receivedOffset = q.offset; return { total: 1000, publications: [base] }; },
  };
  const response = await runSearch({ ...query, offset: 20 }, provider);
  assert.equal(receivedOffset, 20, 'the provider must receive the SAME offset the query carried');
  assert.equal(response.offset, 20);
});

test('F20 pipeline: hasMore is true only when a successful provider genuinely reports more records beyond this page', async () => {
  const stillMore: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 100, publications: [base] }; } };
  const exhausted: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 10, publications: [base] }; } };
  assert.equal((await runSearch({ ...query, limit: 10, offset: 0 }, stillMore)).hasMore, true, 'offset 0 + limit 10 = 10 < total 100 -> more available');
  assert.equal((await runSearch({ ...query, limit: 10, offset: 0 }, exhausted)).hasMore, false, 'offset 0 + limit 10 = 10 >= total 10 -> end of results, never claim more');
  assert.equal((await runSearch({ ...query, limit: 10, offset: 90 }, stillMore)).hasMore, false, 'offset 90 + limit 10 = 100 >= total 100 -> genuinely the last page');
});

test('F20 pipeline: hasMore never claims more once the deep-pagination bound is reached, even if a provider reports a huge total', async () => {
  const hugeTotal: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 1_000_000, publications: [base] }; } };
  const nearBound = MAX_SEARCH_OFFSET - 10;
  const response = await runSearch({ ...query, limit: 10, offset: nearBound }, hugeTotal);
  assert.equal(response.hasMore, false, 'the bound must win even against a provider that genuinely has far more records');
});

test('F20 combined pagination: a fresh combined query (no continuation) starts both providers at offset 0, and returns a continuation for the next page', async () => {
  const offsets: Record<string, number | undefined> = {};
  const crossref: ScientificSourceProvider = { id: 'crossref', async search(q) { offsets.crossref = q.offset; return { total: 100, publications: [base] }; } };
  const openalex: ScientificSourceProvider = { id: 'openalex', async search(q) { offsets.openalex = q.offset; return { total: 100, publications: [normalizeOpenAlexWork(openAlexFixture)] }; } };
  const result = await runSearch({ ...query, source: 'combined', limit: 25 }, [crossref, openalex]);
  assert.equal(offsets.crossref, 0);
  assert.equal(offsets.openalex, 0);
  assert.equal(result.offset, 0);
  assert.ok(result.continuation, 'combined mode must return a continuation token for the next page');
});

test('F20 combined pagination: dedup still merges an overlapping DOI correctly on a page OTHER than the first (offset > 0)', async () => {
  const crossref: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 100, publications: [base] }; } };
  const openalex: ScientificSourceProvider = { id: 'openalex', async search() { return { total: 100, publications: [normalizeOpenAlexWork(openAlexFixture)] }; } };
  const result = await runSearch({ ...query, source: 'combined', offset: 50 }, [crossref, openalex]);
  assert.equal(result.returned, 1, 'the same DOI from both providers must still merge into one record on a later page too');
  assert.deepEqual(result.publications[0].sources, ['crossref', 'openalex']);
});

test('F20 back navigation: requesting offset 0 again after having moved to offset > limit is fully deterministic (page 1 comes back identically - stateless pagination)', async () => {
  const provider: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 100, publications: [base] }; } };
  const page1First = await runSearch({ ...query, offset: 0 }, provider);
  await runSearch({ ...query, offset: 10 }, provider); // simulate having navigated forward
  const page1Again = await runSearch({ ...query, offset: 0 }, provider); // "Назад" back to page 1
  assert.deepEqual(page1Again.publications, page1First.publications);
  assert.equal(page1Again.offset, 0);
});

test('F20 new query resets pagination: a query object built without an explicit offset (exactly what a fresh form submit sends) always starts at 0, regardless of any prior page', () => {
  assert.equal(parseSearchQuery({ query: 'a completely different topic' }).offset, 0);
});

test('F20 provider rate limit during pagination: a 429 on a later page (offset > 0) still degrades to a controlled, retryable error - not a crash, not a fabricated page', async () => {
  const fetcher: typeof fetch = async () => new Response('{}', { status: 429 });
  await assert.rejects(new CrossrefProvider(fetcher).search({ ...query, offset: 20 }), { code: 'RATE_LIMITED' });
});

test('F20 provider partial failure during pagination: OpenAlex failing on a later page still lets Crossref\'s page come back, with an honest offset/hasMore', async () => {
  const good: ScientificSourceProvider = { id: 'crossref', async search() { return { total: 200, publications: [base] }; } };
  const bad: ScientificSourceProvider = { id: 'openalex', async search() { throw new ScientificSearchError('OPENALEX_RATE_LIMIT', 'OpenAlex rate limited', 429, true); } };
  const result = await runSearch({ ...query, source: 'combined', offset: 30 }, [good, bad]);
  assert.equal(result.returned, 1, 'Crossref\'s page must still come back even though OpenAlex failed on this page');
  assert.equal(result.offset, 30);
  assert.equal(result.hasMore, true, '30 + limit(10) = 40 < Crossref\'s reported total 200 -> honestly still more available');
  assert.ok(result.warnings.some(w => w.includes('OpenAlex')));
});

// ---------- F20 (MEDIUM) Codex regression #2: combined-search pagination must never lose a
// unique record - carry-over buffer + independent per-provider continuation state ----------

/** A stub provider backed by a fixed, ordered list of records - serves them exactly like a
 *  real paginated API would: `records.slice(offset, offset + limit)`, with `total` honestly
 *  reflecting the full list length. `search` calls are counted so a test can assert exactly
 *  how many round-trips a given scenario needed. */
function makeListProvider(id: 'crossref' | 'openalex', records: Publication[]): ScientificSourceProvider & { callCount: number } {
  const p = {
    id, callCount: 0,
    async search(q: Parameters<ScientificSourceProvider['search']>[0]) {
      p.callCount++;
      const offset = q.offset ?? 0;
      return { total: records.length, publications: records.slice(offset, offset + q.limit) };
    },
  };
  return p;
}

function makeUniqueRecords(prefix: string, count: number): Publication[] {
  return Array.from({ length: count }, (_, i) => publication({ doi: `10.9999/${prefix}-${i}`, title: `${prefix} record ${i}`, year: 2020 + (i % 5) }));
}

test('F20 combined pagination: 20 unique Crossref + 20 unique OpenAlex records, limit 25 -> page 1 + page 2 together expose ALL 40 unique results (the exact Codex reproduction - 2 providers x 20 unique, previously page 2 skipped straight past the un-emitted half and lost it forever)', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 20));
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 20));

  const page1 = await runSearch({ ...query, source: 'combined', limit: 25 }, [crossref, openalex]);
  assert.equal(page1.returned, 25);
  assert.ok(page1.continuation);

  const page2 = await runSearch({ ...query, source: 'combined', limit: 25, continuation: page1.continuation }, [crossref, openalex]);
  assert.equal(page2.returned, 15, 'the remaining 15 unique records must still be reachable, not lost');

  const allIds = new Set([...page1.publications, ...page2.publications].map(p => p.doi));
  assert.equal(allIds.size, 40, `expected all 40 unique DOIs across both pages, got ${allIds.size}`);
});

test('F20 combined pagination: partial overlap between providers - overlapping records merge (sources badge shows both), and no unique record is lost across pages', async () => {
  const shared = Array.from({ length: 5 }, (_, i) => publication({ doi: `10.9999/shared-${i}`, title: `Shared record ${i}`, year: 2021 }));
  const crossrefOnly = makeUniqueRecords('cr-only', 15);
  const openalexOnly = makeUniqueRecords('oa-only', 15);
  const crossref = makeListProvider('crossref', [...shared, ...crossrefOnly]);
  const openalex = makeListProvider('openalex', [...shared, ...openalexOnly]);

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  let totalReturned = 0;
  for (let page = 0; page < 6; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    totalReturned += result.returned;
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  // 5 shared (merged, each provider lists them too) + 15 crossref-only + 15 openalex-only =
  // 35 genuinely unique works.
  assert.equal(allDois.size, 35, `expected 35 unique DOIs total, got ${allDois.size}`);
  assert.equal(totalReturned, 35, 'no record emitted twice across pages');
});

test('F20 combined pagination: FULL overlap between providers (both return the exact same records) - every record merges into one, none duplicated across pages', async () => {
  const shared = makeUniqueRecords('dup', 30);
  const crossref = makeListProvider('crossref', shared);
  const openalex = makeListProvider('openalex', shared);

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  let totalReturned = 0;
  for (let page = 0; page < 4; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    totalReturned += result.returned;
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(allDois.size, 30, 'exactly 30 unique works, even though both providers returned all 30 each');
  assert.equal(totalReturned, 30, 'no record emitted twice across pages');
});

test('F20 combined pagination: provider A exhausted earlier than provider B - pagination continues correctly using only B\'s remaining records', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 5)); // exhausted after page 1
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 25));

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  for (let page = 0; page < 4; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(allDois.size, 30, `expected all 30 unique records (5 + 25) across pages, got ${allDois.size}`);
  assert.equal(continuation?.crossrefExhausted, true);
});

test('F20 combined pagination: OpenAlex returns 429 on the SECOND page - Crossref\'s own remaining records still page through correctly via the buffer/continuation, nothing lost', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 30));
  let openalexCalls = 0;
  const openalexRecords = makeUniqueRecords('oa', 30);
  const openalex: ScientificSourceProvider = {
    id: 'openalex',
    async search(q) {
      openalexCalls++;
      if (openalexCalls === 2) throw new ScientificSearchError('OPENALEX_RATE_LIMIT', 'OpenAlex rate limited', 429, true);
      const offset = q.offset ?? 0;
      return { total: openalexRecords.length, publications: openalexRecords.slice(offset, offset + q.limit) };
    },
  };

  const page1 = await runSearch({ ...query, source: 'combined', limit: 10 }, [crossref, openalex]);
  assert.equal(page1.returned, 10);

  const page2 = await runSearch({ ...query, source: 'combined', limit: 10, continuation: page1.continuation }, [crossref, openalex]);
  assert.equal(page2.returned, 10, 'Crossref alone must still fill the page even though OpenAlex failed this round');
  assert.ok(page2.warnings.some(w => w.includes('OpenAlex')));

  // OpenAlex recovers on page 3 (a transient failure never permanently strands it).
  const page3 = await runSearch({ ...query, source: 'combined', limit: 10, continuation: page2.continuation }, [crossref, openalex]);
  const allDois = new Set([...page1.publications, ...page2.publications, ...page3.publications].map(p => p.doi));
  assert.ok(allDois.size >= 20, 'no record lost even across the failed round');
});

test('F20 combined pagination: back navigation restores a deterministic previous page by replaying its cached continuation', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 20));
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 20));

  const page1 = await runSearch({ ...query, source: 'combined', limit: 10 }, [crossref, openalex]);
  const page2 = await runSearch({ ...query, source: 'combined', limit: 10, continuation: page1.continuation }, [crossref, openalex]);
  // "Back" = the client replays the continuation it cached BEFORE requesting page 2 (i.e. the
  // one page 1 itself returned) - never tries to invert page2's continuation arithmetically.
  const backToPage1 = await runSearch({ ...query, source: 'combined', limit: 10, continuation: page1.continuation }, [crossref, openalex]);
  assert.deepEqual(backToPage1.publications.map(p => p.doi), page2.publications.map(p => p.doi), 'replaying the same cached continuation must deterministically reproduce the same page');
});

test('F20 combined pagination: a new query (no continuation) always resets pagination state, even after previous pages advanced deep', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 40));
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 40));
  let continuation: ScientificSearchResult['continuation'];
  for (let page = 0; page < 3; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    continuation = result.continuation;
  }
  // A fresh query (a new search box submission) omits `continuation` entirely.
  const fresh = await runSearch({ ...query, source: 'combined', limit: 10 }, [crossref, openalex]);
  assert.equal(fresh.offset, 0);
  assert.equal(fresh.publications[0]?.doi, '10.9999/cr-0', 'a fresh query must restart from the very beginning, not continue from the deep page reached before');
});

test('F20 combined pagination: hasMore reflects the ACTUAL combined continuation (buffer + provider exhaustion), not just whichever provider happened to respond on this exact call', async () => {
  // Both providers exhausted (5 records each, all fit on page 1) -> hasMore must be false.
  const smallCrossref = makeListProvider('crossref', makeUniqueRecords('cr', 5));
  const smallOpenalex = makeListProvider('openalex', makeUniqueRecords('oa', 5));
  const exhausted = await runSearch({ ...query, source: 'combined', limit: 25 }, [smallCrossref, smallOpenalex]);
  assert.equal(exhausted.hasMore, false, 'both providers fully exhausted on page 1 - nothing more to page into');

  // One provider still has more even though the buffer alone filled this exact page.
  const bigCrossref = makeListProvider('crossref', makeUniqueRecords('cr', 100));
  const smallOpenalex2 = makeListProvider('openalex', makeUniqueRecords('oa', 5));
  const stillMore = await runSearch({ ...query, source: 'combined', limit: 10 }, [bigCrossref, smallOpenalex2]);
  assert.equal(stillMore.hasMore, true, 'Crossref alone still has far more to give');
});

// ---------- F20 (Codex re-detection): bounded continuation state ----------
//
// Root cause: a fresh round of `limit` records was fetched from BOTH providers on EVERY page,
// unconditionally - even when the carry-over buffer already had more than enough to fill the
// page. That never lost a record, but the buffer (and the `continuation` object the client
// must cache and echo back on every request) grew by a net `limit` records forever: with two
// providers that never run out, paging N pages deep left roughly N*limit/2 records sitting in
// the buffer, an unbounded and ever-growing payload - exactly what Codex's checklist called out
// as "bounded continuation state", independent of whether any record was actually lost.

test('F20 (re-detection): with two providers that never exhaust, the continuation buffer stays bounded (never exceeds 2x limit) across many pages, instead of growing by `limit` every page forever', async () => {
  const limit = 10;
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 500));
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 500));

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit, continuation }, [crossref, openalex]);
    assert.ok(
      (result.continuation?.buffer.length ?? 0) <= 2 * limit,
      `page ${page + 1}: buffer grew to ${result.continuation?.buffer.length} records - continuation state must stay bounded, never grow linearly with the number of pages visited`,
    );
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
  }
  assert.equal(allDois.size, 200, 'still exactly 20 pages x 10 unique records emitted, no duplicates and nothing skipped, even though far fewer records were pre-fetched per page than before');
});

test('F20 (re-detection): bounding the buffer never drops or duplicates a record - 20 unique Crossref + 20 unique OpenAlex, limit 10, draining fully across pages still exposes all 40 exactly once', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('cr', 20));
  const openalex = makeListProvider('openalex', makeUniqueRecords('oa', 20));

  let continuation: ScientificSearchResult['continuation'];
  const seen: string[] = [];
  for (let page = 0; page < 8; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    for (const pub of result.publications) if (pub.doi) seen.push(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(seen.length, 40, `expected exactly 40 emitted records total (no duplicates, nothing lost), got ${seen.length}`);
  assert.equal(new Set(seen).size, 40, 'every emitted DOI must be unique - no record re-emitted on a later page');
});

// ---------- F20 (Codex re-detection #3): combined pagination must have a REAL depth bound -
// the old `belowBound` check compared MAX_SEARCH_OFFSET against `query.offset`, which combined
// mode never advances (the client keeps it fixed at 0 - see search.tsx), so the bound silently
// never fired: crossrefOffset/openalexOffset/emittedKeys could all grow forever. The bound now
// lives on the providers' own tracked offsets (MAX_COMBINED_SEARCH_DEPTH) instead. ----------

test('F20 (bound fix #3) A. LONG RUN / BOUND: two never-exhausting providers - provider offsets, emitted/dedup state and carry-over all stay bounded through the full configured combined depth, hasMore goes false at the bound, and no further provider fetch happens beyond it', async () => {
  const limit = 50;
  const crossref = makeListProvider('crossref', makeUniqueRecords('bound-cr', 5000));
  const openalex = makeListProvider('openalex', makeUniqueRecords('bound-oa', 5000));

  let continuation: ScientificSearchResult['continuation'];
  let last: ScientificSearchResult | undefined;
  for (let page = 0; page < 100; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit, continuation }, [crossref, openalex]);
    last = result;
    assert.ok((result.continuation?.crossrefOffset ?? 0) <= MAX_COMBINED_SEARCH_DEPTH + limit, `page ${page + 1}: crossrefOffset ${result.continuation?.crossrefOffset} exceeded the bound by more than one round`);
    assert.ok((result.continuation?.openalexOffset ?? 0) <= MAX_COMBINED_SEARCH_DEPTH + limit, `page ${page + 1}: openalexOffset ${result.continuation?.openalexOffset} exceeded the bound by more than one round`);
    assert.ok((result.continuation?.emittedKeys.length ?? 0) <= MAX_COMBINED_EMITTED_KEYS, `page ${page + 1}: emittedKeys grew to ${result.continuation?.emittedKeys.length}, past the hard cap`);
    assert.ok((result.continuation?.buffer.length ?? 0) <= 2 * limit, `page ${page + 1}: buffer grew to ${result.continuation?.buffer.length}, past the O(limit) carry-over bound`);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.ok(last, 'the loop must have run at least once');
  assert.equal(last!.hasMore, false, 'the configured depth bound must eventually make hasMore false even though neither provider ever truly runs out');
  assert.equal(last!.boundReached, true, 'hasMore going false here must be attributed to the depth bound, not genuine provider exhaustion');
  assert.equal(last!.continuation?.crossrefOffset, MAX_COMBINED_SEARCH_DEPTH, 'Crossref offset must be held exactly at the configured bound, never past it');
  assert.equal(last!.continuation?.openalexOffset, MAX_COMBINED_SEARCH_DEPTH, 'OpenAlex offset must be held exactly at the configured bound, never past it');

  const callsBefore = { crossref: crossref.callCount, openalex: openalex.callCount };
  const beyond = await runSearch({ ...query, source: 'combined', limit, continuation: last!.continuation }, [crossref, openalex]);
  assert.equal(crossref.callCount, callsBefore.crossref, 'no further Crossref fetch once the bound is reached and the buffer is drained - Next must be a genuine no-op');
  assert.equal(openalex.callCount, callsBefore.openalex, 'no further OpenAlex fetch once the bound is reached and the buffer is drained');
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.hasMore, false);
});

test('F20 (bound fix #3) B. LOSSLESS: well within the supported combined depth, draining every page yields every unique record exactly once (0 lost, 0 duplicated)', async () => {
  const limit = 25;
  const crossref = makeListProvider('crossref', makeUniqueRecords('lossless-cr', 60));
  const openalex = makeListProvider('openalex', makeUniqueRecords('lossless-oa', 60));

  let continuation: ScientificSearchResult['continuation'];
  const seen: string[] = [];
  for (let page = 0; page < 20; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit, continuation }, [crossref, openalex]);
    for (const pub of result.publications) if (pub.doi) seen.push(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(seen.length, 120, `expected all 120 unique records emitted (60 + 60), got ${seen.length}`);
  assert.equal(new Set(seen).size, 120, 'no record emitted twice across pages');
});

test('F20 (bound fix #3) C. PARTIAL OVERLAP: shared DOIs between Crossref and OpenAlex dedupe correctly across pages, within the supported depth', async () => {
  const shared = Array.from({ length: 8 }, (_, i) => publication({ doi: `10.9999/bound-shared-${i}`, title: `Shared ${i}`, year: 2021 }));
  const crossref = makeListProvider('crossref', [...shared, ...makeUniqueRecords('bound-cr-only', 22)]);
  const openalex = makeListProvider('openalex', [...shared, ...makeUniqueRecords('bound-oa-only', 22)]);

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  let totalReturned = 0;
  for (let page = 0; page < 10; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
    totalReturned += result.returned;
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(allDois.size, 52, '8 shared + 22 crossref-only + 22 openalex-only = 52 unique works');
  assert.equal(totalReturned, 52, 'no record emitted twice across pages');
});

test('F20 (bound fix #3) D. FULL OVERLAP: both providers return the identical record set - merges into one copy each, no duplicates, and hasMore correctly reflects genuine (not bounded) exhaustion', async () => {
  const shared = makeUniqueRecords('bound-dup', 40);
  const crossref = makeListProvider('crossref', shared);
  const openalex = makeListProvider('openalex', shared);

  let continuation: ScientificSearchResult['continuation'];
  const allDois = new Set<string>();
  let totalReturned = 0;
  let last: ScientificSearchResult | undefined;
  for (let page = 0; page < 10; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 25, continuation }, [crossref, openalex]);
    last = result;
    totalReturned += result.returned;
    for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.equal(allDois.size, 40, 'exactly 40 unique works despite both providers listing all 40');
  assert.equal(totalReturned, 40, 'no duplicate emission');
  assert.equal(last?.hasMore, false, 'both providers genuinely exhausted -> hasMore false');
  assert.equal(last?.boundReached, false, 'this is genuine exhaustion, far short of the depth bound - never mislabeled as a bound hit');
});

test('F20 (bound fix #3) E. PROVIDER EXHAUSTION: pagination completes correctly whichever provider runs out first', async () => {
  for (const [firstSize, secondSize] of [[6, 34], [34, 6]] as const) {
    const crossref = makeListProvider('crossref', makeUniqueRecords('exh-cr', firstSize));
    const openalex = makeListProvider('openalex', makeUniqueRecords('exh-oa', secondSize));
    let continuation: ScientificSearchResult['continuation'];
    const allDois = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit: 10, continuation }, [crossref, openalex]);
      for (const pub of result.publications) if (pub.doi) allDois.add(pub.doi);
      continuation = result.continuation;
      if (!result.hasMore) break;
    }
    assert.equal(allDois.size, firstSize + secondSize, `expected ${firstSize + secondSize} unique records regardless of which provider exhausts first`);
  }
});

test('F20 (bound fix #3) F. PROVIDER ERROR: one provider fails mid-run (429), the other keeps paging correctly, and the depth bound is still honored on both', async () => {
  const limit = 50;
  const crossref = makeListProvider('crossref', makeUniqueRecords('err-cr', 5000));
  const openalexBase = makeListProvider('openalex', makeUniqueRecords('err-oa', 5000));
  let callNum = 0;
  const openalex: ScientificSourceProvider = {
    id: 'openalex',
    async search(q) {
      callNum++;
      if (callNum === 3) throw new ScientificSearchError('OPENALEX_RATE_LIMIT', 'OpenAlex rate limited', 429, true);
      return openalexBase.search(q);
    },
  };

  let continuation: ScientificSearchResult['continuation'];
  let last: ScientificSearchResult | undefined;
  let sawWarning = false;
  for (let page = 0; page < 100; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit, continuation }, [crossref, openalex]);
    last = result;
    if (result.warnings.some(w => w.includes('OpenAlex'))) sawWarning = true;
    assert.ok((result.continuation?.crossrefOffset ?? 0) <= MAX_COMBINED_SEARCH_DEPTH + limit, `crossrefOffset ${result.continuation?.crossrefOffset} exceeded the bound`);
    assert.ok((result.continuation?.openalexOffset ?? 0) <= MAX_COMBINED_SEARCH_DEPTH + limit, `openalexOffset ${result.continuation?.openalexOffset} exceeded the bound`);
    continuation = result.continuation;
    if (!result.hasMore) break;
  }
  assert.ok(sawWarning, 'the 429 must have surfaced as a warning on some page');
  assert.equal(last?.hasMore, false, 'the depth bound must still be reached on both providers despite the mid-run failure');
});

test('F20 (bound fix #3) G. BACK NAVIGATION: page1 -> page2 -> page3 -> back to page2 -> back to page1 is deterministic within the supported range', async () => {
  const crossref = makeListProvider('crossref', makeUniqueRecords('back-cr', 90));
  const openalex = makeListProvider('openalex', makeUniqueRecords('back-oa', 90));
  const limit = 10;

  // Mirrors search.tsx's `combinedHistory`: history[i] is the token to send when REQUESTING
  // page i; history[0] is always undefined (a fresh start).
  const history: Array<ScientificSearchResult['continuation']> = [undefined];
  const pages: ScientificSearchResult[] = [];
  for (let i = 0; i < 3; i++) {
    const result = await runSearch({ ...query, source: 'combined', limit, continuation: history[i] }, [crossref, openalex]);
    pages.push(result);
    history[i + 1] = result.continuation;
  }

  const backToPage2 = await runSearch({ ...query, source: 'combined', limit, continuation: history[1] }, [crossref, openalex]);
  assert.deepEqual(backToPage2.publications.map(p => p.doi), pages[1].publications.map(p => p.doi), '"Назад" to page 2 must reproduce page 2 exactly');

  const backToPage1 = await runSearch({ ...query, source: 'combined', limit, continuation: history[0] }, [crossref, openalex]);
  assert.deepEqual(backToPage1.publications.map(p => p.doi), pages[0].publications.map(p => p.doi), '"Назад" to page 1 must reproduce page 1 exactly');
});

test('F20 (bound fix #3) H. QUERY RESET: a brand-new query without continuation fully clears provider continuation, carry-over and emitted/dedup state, even after paging deep', async () => {
  const limit = 50;
  const crossref = makeListProvider('crossref', makeUniqueRecords('reset-cr', 5000));
  const openalex = makeListProvider('openalex', makeUniqueRecords('reset-oa', 5000));

  let continuation: ScientificSearchResult['continuation'];
  for (let page = 0; page < 15; page++) {
    const result: ScientificSearchResult = await runSearch({ ...query, source: 'combined', limit, continuation }, [crossref, openalex]);
    continuation = result.continuation;
  }
  assert.ok((continuation?.crossrefOffset ?? 0) > 0, 'sanity: pagination really did advance before the reset');

  // A fresh form submission - exactly src/components/scifinder/search.tsx's `submit`, which
  // rebuilds the request WITHOUT `continuation` at all.
  const fresh = await runSearch({ ...query, source: 'combined', limit }, [crossref, openalex]);
  assert.equal(fresh.offset, 0);
  assert.equal(fresh.publications[0]?.doi, '10.9999/reset-cr-0', 'must restart from the very first record, not continue from the deep page reached before');
  assert.equal(fresh.continuation?.crossrefOffset, limit, 'a fresh query starts a brand-new continuation exactly one page in, not wherever the previous session left off');
  assert.equal(fresh.continuation?.emittedKeys.length, limit, 'emittedKeys must not carry over any history from the previous (deep) session');
  assert.equal(fresh.continuation?.buffer.length, limit, 'carry-over buffer must not carry over any history either');
});

test('sorting places unavailable values last and OA filter excludes unknown status', () => {
  const records = [publication({ id: 'unknown', year: null, citationCount: null }), publication({ id: 'older', year: 2020, citationCount: 42, openAccess: true }), publication({ id: 'newer', year: 2024, citationCount: 0, openAccess: false })];
  assert.deepEqual(sortPublications(records, 'year').map(p => p.id), ['newer', 'older', 'unknown']);
  assert.deepEqual(sortPublications(records, 'citations').map(p => p.id), ['older', 'newer', 'unknown']);
  assert.deepEqual(sortPublications(records, 'open-access').map(p => p.id), ['older', 'newer', 'unknown']);
  assert.deepEqual(filterPublications(records, { ...query, openAccessOnly: true }).map(p => p.id), ['older']);
  assert.equal(parseSearchQuery({ query: 'PVD', source: 'combined', sort: 'citations' }).source, 'combined');
  assert.throws(() => parseSearchQuery({ query: 'PVD', sort: 'unsupported' }));
});
