import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrossrefProvider, buildCrossrefUrl } from '../src/integrations/crossref';
import { normalizeCrossrefWork } from '../src/integrations/crossref/normalize';
import { OpenAlexProvider } from '../src/integrations/openalex';
import { deduplicatePublications } from '../src/services/scientific-search/deduplicate';
import { filterPublications } from '../src/services/scientific-search/filters';
import { normalizeDoi, plainText, safeUrl } from '../src/services/scientific-search/normalization';
import { parseSearchQuery } from '../src/services/scientific-search/validation';
import { runSearch } from '../src/services/scientific-search/pipeline';
import type { Publication, ScientificSourceProvider } from '../src/services/scientific-search/types';
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

test('OpenAlex stays inactive regardless of key presence', async () => {
  const previous = process.env.OPENALEX_API_KEY;
  try {
    delete process.env.OPENALEX_API_KEY;
    assert.deepEqual(new OpenAlexProvider().getStatus(), { configured: false, active: false });
    process.env.OPENALEX_API_KEY = 'test-placeholder-not-a-real-key';
    assert.deepEqual(new OpenAlexProvider().getStatus(), { configured: true, active: false });
    await assert.rejects(new OpenAlexProvider().search(query), { code: 'SOURCE_NOT_ACTIVE' });
  } finally {
    if (previous === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = previous;
  }
});

test('API route validates bodies and returns structured errors without making external requests', async () => {
  for (const [body, status] of [['{', 400], ['{}', 400], ['x'.repeat(17000), 413], [JSON.stringify({ query: 'PVD', source: 'openalex' }), 503]] as const) {
    const response = await POST(new Request('http://localhost/api/scifinder/search', { method: 'POST', body }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).error.message);
  }
});
