/** Security hardening S3-S6: negative tests first. Every test states what is EXPECTED and asserts it against what ACTUALLY happens; the assertion messages carry both.
 *  Only synthetic data and stubbed transports - no real provider is ever called and no key is read. */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AiGuard, AiLimitError, DEFAULT_AI_GUARD_CONFIG, loadAiGuardConfig, resetAiGuardForTests, getAiGuard, totalTokensFromUsage, type AiGuardConfig,
} from '../src/services/ai-guard';
import { OpenAIWriterProvider, WriterProviderError } from '../src/services/workspace/scientific-writer-provider';
import { OpenAIAnswerProvider } from '../src/services/rag/providers/openai';
import { OpenAIEmbeddingProvider } from '../src/services/embeddings/providers/openai';
import { handleGenerate } from '../src/services/workspace/scientific-writer-handler';
import { classifyGenerationResponse } from '../src/services/workspace/scientific-writer-status';
import { POST as scifinderPOST } from '../src/app/api/scifinder/search/route';
import { POST as semanticPOST } from '../src/app/api/library/semantic/route';
import { POST as techdocPOST } from '../src/app/api/workspace/techdoc/export/route';
import { createDocumentFromPreset, type TechnicalProcessDocument } from '../src/services/workspace/techdoc-assistant';

beforeEach(() => resetAiGuardForTests());

const KEY = 'sk-TEST-KEY-MUST-NEVER-LEAK-0123456789';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const chatOk = (text = 'Synthetic text.', usage?: unknown, finish = 'stop') => json({ choices: [{ message: { content: text }, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
const config = (over: Partial<AiGuardConfig> = {}): AiGuardConfig => ({ ...DEFAULT_AI_GUARD_CONFIG, ...over });
function clock() { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms; }, sleep: async (ms: number) => { t += ms; } }; }
const REQ = { system: 'You are a synthetic writer.', user: 'Write about plasma coatings.' };

async function rejection(promise: Promise<unknown>): Promise<unknown> { try { await promise; } catch (error) { return error; } return undefined; }

// =====================================================================================
// S3 - the guard itself
// =====================================================================================

test('S3 config: missing, malformed, zero or negative overrides fall back to the defaults; there is no "unlimited" switch; the output cap is clamped to the hard ceiling', () => {
  const d = DEFAULT_AI_GUARD_CONFIG;
  const bad = loadAiGuardConfig({ AI_MAX_CONCURRENT: 'abc', AI_CHAT_RATE_PER_MIN: '0', AI_EMBED_RATE_PER_MIN: '-5', AI_CHAT_TOKEN_BUDGET_24H: '1e9', AI_EMBED_TOKEN_BUDGET_24H: '', AI_WRITER_MAX_OUTPUT_TOKENS: ' ', AI_RAG_MAX_OUTPUT_TOKENS: '12.5' });
  assert.deepEqual(bad, d, 'EXPECTED all defaults for unusable overrides');
  const ok = loadAiGuardConfig({ AI_MAX_CONCURRENT: '2', AI_CHAT_RATE_PER_MIN: '5', AI_CHAT_TOKEN_BUDGET_24H: '5000', AI_WRITER_MAX_OUTPUT_TOKENS: '99999' });
  assert.equal(ok.maxConcurrent, 2); assert.equal(ok.ratePerMinute.chat, 5); assert.equal(ok.tokenBudget24h.chat, 5000);
  assert.equal(ok.maxOutputTokens.writer, d.hardMaxOutputTokens, `EXPECTED the clamp to ${d.hardMaxOutputTokens}, ACTUAL ${ok.maxOutputTokens.writer}`);
});

test('S3 output cap: a generation request without a cap, with zero, or above the hard ceiling is refused before anything is booked', async () => {
  const guard = new AiGuard(config());
  for (const cap of [undefined, 0, -1, 1.5, DEFAULT_AI_GUARD_CONFIG.hardMaxOutputTokens + 1]) {
    const error = await rejection(guard.acquire('writer', { inputChars: 10, maxOutputTokens: cap }));
    assert.ok(error instanceof AiLimitError && error.reason === 'output_limit', `EXPECTED output_limit for cap=${String(cap)}, ACTUAL ${String(error)}`);
  }
  assert.deepEqual(guard.snapshot().chat, { requestsLastMinute: 0, actualTokens24h: 0, estimatedTokens24h: 0, budget: DEFAULT_AI_GUARD_CONFIG.tokenBudget24h.chat });
  const lease = await guard.acquire('writer', { inputChars: 10, maxOutputTokens: DEFAULT_AI_GUARD_CONFIG.hardMaxOutputTokens });
  assert.equal(lease.maxOutputTokens, DEFAULT_AI_GUARD_CONFIG.hardMaxOutputTokens, 'a cap exactly at the ceiling is allowed');
});

test('S3 output cap: every real generation request carries max_completion_tokens (Writer 4096, Ask Library 1024 by default)', async () => {
  const sent: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return chatOk('x', { total_tokens: 10 }); }) as typeof fetch;
  await new OpenAIWriterProvider(fetcher, KEY).generate(REQ);
  await new OpenAIAnswerProvider(fetcher, KEY).generate({ question: 'q', context: { block: 'b', citations: [], truncated: false } as never });
  assert.equal(sent[0].max_completion_tokens, 4096, `EXPECTED 4096, ACTUAL ${String(sent[0].max_completion_tokens)}`);
  assert.equal(sent[1].max_completion_tokens, 1024, `EXPECTED 1024, ACTUAL ${String(sent[1].max_completion_tokens)}`);
});

test('S3 output cap reached: an answer cut off by the output cap (finish_reason=length) is not presented as a finished text, but its real usage is booked', async () => {
  const guard = new AiGuard(config());
  let calls = 0;
  const fetcher = (async () => { calls++; return chatOk('A cut-off tex', { prompt_tokens: 200, completion_tokens: 4000, total_tokens: 4200 }, 'length'); }) as typeof fetch;
  const error = await rejection(new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard).generate(REQ));
  assert.ok(error instanceof WriterProviderError && error.kind === 'error' && error.reason === 'bad_response', `EXPECTED a rejected answer, ACTUAL ${String(error)}`);
  assert.equal(calls, 1);
  assert.equal(guard.snapshot().chat.actualTokens24h, 4200, 'the real usage of the truncated answer is still booked');
  assert.equal(guard.snapshot().inFlight, 0);
});

test('S3 rate limit: the request over the per-minute limit is refused with a retry hint and the provider is NOT called; the limit is rolling', async () => {
  const c = clock();
  const guard = new AiGuard(config({ ratePerMinute: { chat: 3, embedding: 120 } }), c.now, c.sleep);
  let calls = 0;
  const fetcher = (async () => { calls++; return chatOk('ok', { total_tokens: 10 }); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  for (let i = 0; i < 3; i++) await provider.generate(REQ);
  const error = await rejection(provider.generate(REQ));
  assert.ok(error instanceof WriterProviderError && error.reason === 'local_limit' && error.kind === 'unavailable', `EXPECTED local_limit, ACTUAL ${String(error)}`);
  assert.match((error as Error).message, /Повторите через \d+ с/);
  assert.equal(calls, 3, `EXPECTED 3 provider calls, ACTUAL ${calls}`);
  c.advance(60_001);
  await provider.generate(REQ);
  assert.equal(calls, 4, 'after a minute the next request goes through');
});

test('S3 concurrency: simultaneous requests over the limit are refused immediately (exactly N run), and the slot is freed afterwards', async () => {
  const guard = new AiGuard(config({ maxConcurrent: 2 }));
  let running = 0; let peak = 0; let calls = 0;
  const release: Array<() => void> = [];
  const fetcher = (async () => { calls++; running++; peak = Math.max(peak, running); await new Promise<void>(r => release.push(r)); running--; return chatOk('ok', { total_tokens: 10 }); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  const batch = Array.from({ length: 6 }, () => provider.generate(REQ).then(() => 'ok', (e: unknown) => (e instanceof WriterProviderError ? e.reason : 'other')));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 2, `EXPECTED exactly 2 provider calls in flight, ACTUAL ${calls}`);
  assert.equal(guard.snapshot().inFlight, 2);
  release.forEach(r => r());
  const outcome = await Promise.all(batch);
  assert.equal(outcome.filter(o => o === 'ok').length, 2, `ACTUAL outcomes: ${outcome.join(',')}`);
  assert.equal(outcome.filter(o => o === 'local_limit').length, 4);
  assert.equal(peak, 2, `EXPECTED peak concurrency 2, ACTUAL ${peak}`);
  assert.equal(guard.snapshot().inFlight, 0, 'slots are released');
  const later = provider.generate(REQ); await new Promise(r => setTimeout(r, 5)); release.forEach(r => r()); await later;
});

test('S3 budget: once the rolling token budget is used up, requests are refused BEFORE the provider is called; the refusal is reported as a budget reason', async () => {
  const c = clock();
  const guard = new AiGuard(config({ tokenBudget24h: { chat: 10_000, embedding: 1_000_000 } }), c.now, c.sleep);
  let calls = 0;
  const fetcher = (async () => { calls++; return chatOk('ok', { prompt_tokens: 600, completion_tokens: 600, total_tokens: 1200 }); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  // Each request reserves ~4124 (cap 4096 + input estimate) and settles to the real 1200: five fit (6000 used), the sixth needs 6000 + 4124 > 10000 and is refused.
  for (let i = 0; i < 5; i++) await provider.generate(REQ);
  assert.equal(guard.snapshot().chat.actualTokens24h, 6000);
  const error = await rejection(provider.generate(REQ));
  assert.ok(error instanceof WriterProviderError && error.reason === 'local_budget', `EXPECTED local_budget, ACTUAL ${String(error)}`);
  assert.equal(calls, 5, `EXPECTED the 6th provider call NOT to happen, ACTUAL calls=${calls}`);
  c.advance(24 * 60 * 60 * 1000 + 1);
  assert.equal(guard.snapshot().chat.actualTokens24h, 0, 'the 24-hour window rolls');
});

test('S3 no usage data: without a usage block the pessimistic estimate stays booked, so spending cannot continue unbounded; a damaged usage block counts as absent', async () => {
  const guard = new AiGuard(config({ tokenBudget24h: { chat: 10_000, embedding: 1_000_000 } }));
  let calls = 0;
  const bodies: Array<() => Response> = [() => chatOk('ok'), () => chatOk('ok', { total_tokens: -4 }), () => chatOk('ok', { total_tokens: 'many' }), () => chatOk('ok', null)];
  const fetcher = (async () => { calls++; return (bodies[Math.min(calls - 1, bodies.length - 1)])(); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  await provider.generate(REQ);
  const afterOne = guard.snapshot().chat;
  assert.equal(afterOne.actualTokens24h, 0, 'nothing is claimed as actual');
  assert.ok(afterOne.estimatedTokens24h >= 4096, `EXPECTED the estimate (>= output cap) to stay booked, ACTUAL ${afterOne.estimatedTokens24h}`);
  await provider.generate(REQ); // second estimate: 8200 of 10000
  const error = await rejection(provider.generate(REQ));
  assert.ok(error instanceof WriterProviderError && error.reason === 'local_budget', `EXPECTED the third unmetered request to be refused, ACTUAL ${String(error)}`);
  assert.equal(calls, 2, 'EXPECTED the provider not to be called a third time');
  assert.equal(totalTokensFromUsage({ total_tokens: 1e12 }), null);
  assert.equal(totalTokensFromUsage({ prompt_tokens: 3, completion_tokens: 4 }), 7);
});

test('S3 provider failure: a failure after sending keeps the reservation and frees the slot; a refusal before sending books nothing', async () => {
  const guard = new AiGuard(config({ ratePerMinute: { chat: 2, embedding: 120 } }));
  let calls = 0;
  const fetcher = (async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return json({ error: 'boom' }, 500); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  const e1 = await rejection(provider.generate(REQ));
  assert.ok(e1 instanceof WriterProviderError && e1.reason === 'network');
  const e2 = await rejection(provider.generate(REQ));
  assert.ok(e2 instanceof WriterProviderError && e2.reason === 'upstream');
  assert.equal(guard.snapshot().inFlight, 0, 'slots are released after failures');
  assert.ok(guard.snapshot().chat.estimatedTokens24h > 0, 'the failed-after-send reservations stay booked');
  const before = guard.snapshot().chat;
  const e3 = await rejection(provider.generate(REQ));
  assert.ok(e3 instanceof WriterProviderError && e3.reason === 'local_limit');
  assert.deepEqual(guard.snapshot().chat, before, 'a refused request books nothing');
  assert.equal(calls, 2);
  const lease = await new AiGuard(config()).acquire('writer', { inputChars: 100, maxOutputTokens: 100 });
  lease.fail(false); lease.fail(true); lease.complete({ total_tokens: 5 }); // idempotent settling
});

test('S3 AI not configured: no key means not_configured, nothing is reserved and nothing is sent', async () => {
  const guard = new AiGuard(config());
  let calls = 0;
  const provider = new OpenAIWriterProvider((async () => { calls++; return chatOk(); }) as typeof fetch, undefined, 'm', 1000, guard);
  const error = await rejection(provider.generate(REQ));
  assert.ok(error instanceof WriterProviderError && error.kind === 'not_configured', `ACTUAL ${String(error)}`);
  assert.equal(calls, 0);
  assert.equal(guard.snapshot().chat.requestsLastMinute, 0);
  assert.equal(guard.snapshot().inFlight, 0);
});

test('S3 no leaks: neither a limit refusal nor a provider failure puts the key, a path or a provider body into the error text; API answer for a limit is a safe 429', async () => {
  const guard = new AiGuard(config({ maxConcurrent: 1 }));
  const hold: Array<() => void> = [];
  const fetcher = (async () => { await new Promise<void>(r => hold.push(r)); return json({ error: { message: `bad key ${KEY} at /srv/app.js` } }, 401); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  const first = provider.generate(REQ).catch((e: unknown) => e);
  await new Promise(r => setTimeout(r, 10));
  const limit = await handleGenerate({ documentType: 'article', mode: 'draft', targetLanguage: 'en', title: 'Synthetic title', goal: 'Synthetic goal for the test' }, provider);
  assert.equal(limit.status, 429, `EXPECTED HTTP 429, ACTUAL ${limit.status}`);
  assert.equal(limit.body.code, 'unavailable'); assert.equal(limit.body.reason, 'local_limit');
  hold.forEach(r => r());
  const failure = await first;
  const everything = JSON.stringify(limit) + String((failure as Error).message);
  assert.ok(!everything.includes(KEY) && !everything.includes('/srv/app.js') && !everything.includes('bad key'), `LEAK in: ${everything}`);
  const view = classifyGenerationResponse(limit.status, limit.body);
  assert.equal(view.cause, 'local_limit'); assert.equal(view.state, 'unavailable');
  assert.match(view.message, /Запрос к ИИ-провайдеру не отправлялся/);
  const budget = classifyGenerationResponse(429, { error: 'x', code: 'unavailable', reason: 'local_budget' });
  assert.equal(budget.cause, 'local_budget'); assert.equal(budget.state, 'error');
});

test('S3 Ask Library: an answer request over the limit is refused before the provider is called, and a rate-limited AI answer still shows the sources with a safe sentence', async () => {
  const guard = new AiGuard(config({ ratePerMinute: { chat: 1, embedding: 120 } }));
  let calls = 0;
  const provider = new OpenAIAnswerProvider((async () => { calls++; return json({ choices: [{ message: { content: '{"claims":[]}' } }], usage: { total_tokens: 50 } }); }) as typeof fetch, KEY, 'm', 1000, guard);
  const input = { question: 'q', context: { block: 'b', citations: [], truncated: false } as never };
  await provider.generate(input);
  const error = await rejection(provider.generate(input));
  assert.ok(error instanceof AiLimitError && error.reason === 'rate_limited', `EXPECTED AiLimitError(rate_limited), ACTUAL ${String(error)}`);
  assert.equal(calls, 1);
  assert.ok(!(error as Error).message.includes(KEY));
});

test('S3 embeddings: a question embedding over the limit is refused at once; an indexing batch waits for a free slot instead of failing; real usage is booked', async () => {
  const c = clock();
  const guard = new AiGuard(config({ ratePerMinute: { chat: 15, embedding: 1 } }), c.now, c.sleep);
  let calls = 0;
  const fetcher = (async () => { calls++; return json({ data: [{ index: 0, embedding: [1, 0, 0, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } }); }) as typeof fetch;
  const provider = new OpenAIEmbeddingProvider(fetcher, KEY, 'm', 4, 1000, guard);
  await provider.embedQuery('first');
  const refused = await rejection(provider.embedQuery('second'));
  assert.ok(refused instanceof AiLimitError && refused.reason === 'rate_limited', `EXPECTED an immediate refusal, ACTUAL ${String(refused)}`);
  assert.equal(calls, 1);
  const waited = c.now();
  const vectors = await provider.embedDocuments(['batch text']);
  assert.equal(vectors.length, 1);
  assert.ok(c.now() - waited >= 1000, 'the indexing batch waited for a rate slot');
  assert.equal(calls, 2);
  assert.equal(guard.snapshot().embedding.actualTokens24h, 14, 'real usage booked');
  // Waiting is bounded: a wait longer than the allowance is a refusal, not an endless block.
  const bounded = new AiGuard(config({ ratePerMinute: { chat: 15, embedding: 1 } }), c.now, c.sleep);
  await bounded.acquire('embed_documents', { inputChars: 10 });
  const e = await rejection(bounded.acquire('embed_documents', { inputChars: 10, waitForRateMs: 5000 }));
  assert.ok(e instanceof AiLimitError && e.reason === 'rate_limited', `EXPECTED a refusal when the slot is further away than the allowance, ACTUAL ${String(e)}`);
});

test('S3 normal local use is not blocked: ten Writer requests in a row and three at once pass with the DEFAULT limits', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; await new Promise(r => setTimeout(r, 5)); return chatOk('ok', { total_tokens: 800 }); }) as typeof fetch;
  const guard = getAiGuard();
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  for (let i = 0; i < 10; i++) await provider.generate(REQ);
  const parallel = await Promise.all([provider.generate(REQ), provider.generate(REQ).catch(() => 'limited')]);
  assert.equal(calls >= 11, true);
  assert.ok(parallel.every(r => typeof r === 'object' || r === 'limited'));
  assert.equal(guard.snapshot().inFlight, 0);
});

// =====================================================================================
// S4 - SciFinder
// =====================================================================================

const SF = 'http://localhost/api/scifinder/search';
const sfBody = JSON.stringify({ query: 'plasma coating', source: 'combined', limit: 10 });
const sfRequest = (headers: Record<string, string>, url = SF) => new Request(url, { method: 'POST', headers, body: sfBody });

test('S4 SciFinder: foreign Host, foreign Origin, cross-site, missing/incorrect Content-Type and a missing Host are all HTTP 403; no search provider is reached and no cookie is issued', async () => {
  // The search providers are module singletons, so they are observed (and kept off the network) by replacing their `search` on the prototypes.
  const crossref = requireFromHere('../src/integrations/crossref') as { CrossrefProvider: { prototype: { search: unknown } } };
  const openalex = requireFromHere('../src/integrations/openalex') as { OpenAlexProvider: { prototype: { search: unknown } } };
  const savedCrossref = crossref.CrossrefProvider.prototype.search; const savedOpenalex = openalex.OpenAlexProvider.prototype.search;
  let outbound = 0;
  const stub = async () => { outbound++; return { total: 0, publications: [] }; };
  crossref.CrossrefProvider.prototype.search = stub; openalex.OpenAlexProvider.prototype.search = stub;
  try {
    const J = 'application/json';
    const cases: Array<[string, Record<string, string>]> = [
      ['public Host', { host: 'example.com', 'content-type': J }],
      ['look-alike Host', { host: 'localhost.evil.example', 'content-type': J }],
      ['Host with a path-like suffix', { host: 'localhost:3000@evil.example', 'content-type': J }],
      ['foreign Origin', { host: 'localhost:3000', origin: 'https://evil.example', 'content-type': J }],
      ['cross-site fetch', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site', 'content-type': J }],
      ['text/plain Content-Type', { host: 'localhost:3000', 'content-type': 'text/plain' }],
      ['form Content-Type', { host: 'localhost:3000', 'content-type': 'application/x-www-form-urlencoded' }],
      ['no Content-Type', { host: 'localhost:3000' }],
      ['no Host', { 'content-type': J }],
    ];
    for (const [name, headers] of cases) {
      const response = await scifinderPOST(sfRequest(headers));
      const body = await response.json();
      assert.equal(response.status, 403, `${name}: EXPECTED 403, ACTUAL ${response.status}`);
      assert.equal(body.error.code, 'FORBIDDEN', name);
      assert.equal(response.headers.get('set-cookie'), null, `${name}: no cookie may be issued to a refused request`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(outbound, 0, `EXPECTED 0 outbound requests for refused calls, ACTUAL ${outbound}`);

    // Positive control: a normal local browser request still reaches the search machinery (here: the stubbed provider) and keeps the cookie context.
    const localHeaders: Array<Record<string, string>> = [{ host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': J, 'sec-fetch-site': 'same-origin' }, { host: '127.0.0.1:3000', 'content-type': 'application/json; charset=utf-8' }, { host: '[::1]:3000', 'content-type': J }];
    for (const headers of localHeaders) {
      const response = await scifinderPOST(sfRequest(headers));
      assert.notEqual(response.status, 403, `a local request must not be refused (Host ${headers.host}), ACTUAL ${response.status}`);
    }
    assert.ok(outbound > 0, 'EXPECTED the local request to reach the search provider layer');
    const cont = await scifinderPOST(new Request(SF, { method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x', source: 'combined', limit: 10, continuation: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }) }));
    assert.equal(cont.status, 410);
    assert.match(cont.headers.get('set-cookie') ?? '', /sf_ctx=[0-9a-f-]{36}.*HttpOnly/i, 'the cookie context is still issued for a local request');
  } finally { crossref.CrossrefProvider.prototype.search = savedCrossref; openalex.OpenAlexProvider.prototype.search = savedOpenalex; }
});

// =====================================================================================
// S5 - semantic POST
// =====================================================================================

const SEM = 'http://localhost/api/library/semantic';
const LOCAL = { host: 'localhost:3000', 'content-type': 'application/json' };
const semPost = (body: BodyInit | null, headers: Record<string, string> = LOCAL, extra: RequestInit = {}) => semanticPOST(new Request(SEM, { method: 'POST', headers, body, ...extra }));
/** A body of exactly `bytes` bytes that is still valid JSON for the contract. */
const padded = (bytes: number) => { const core = '{"sampleSize":200}'; return core + ' '.repeat(bytes - core.length); };
function stream(chunkBytes: number, chunks: number, counter: { pulled: number }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull(controller) { if (counter.pulled >= chunks) { controller.close(); return; } counter.pulled++; controller.enqueue(new Uint8Array(chunkBytes).fill(0x20)); } });
}

test('S5 semantic: an oversized body is HTTP 413 - by honest Content-Length (unread), by dishonest Content-Length, and at the exact boundary (1024 ok, 1025 refused)', async () => {
  delete process.env.EMBEDDING_PROVIDER;
  const honest = await semPost('x'.repeat(5000), { ...LOCAL, 'content-length': '5000' });
  assert.equal(honest.status, 413, `honest length: EXPECTED 413, ACTUAL ${honest.status}`);
  const dishonest = await semPost(JSON.stringify({ sampleSize: 200, pad: 'x'.repeat(5000) }), { ...LOCAL, 'content-length': '10' });
  assert.equal(dishonest.status, 413, `dishonest Content-Length: EXPECTED 413 from the bytes actually received, ACTUAL ${dishonest.status}`);
  const atLimit = await semPost(padded(1024));
  assert.equal(atLimit.status, 409, `1024 bytes: EXPECTED to be accepted (then refused only because no embedding provider is configured: 409), ACTUAL ${atLimit.status}`);
  assert.equal((await atLimit.json()).reason, 'not_configured');
  const over = await semPost(padded(1025));
  assert.equal(over.status, 413, `1025 bytes: EXPECTED 413, ACTUAL ${over.status}`);
  assert.equal((await over.json()).reason, undefined, 'a refused body never reaches the indexing service (it alone produces `reason`)');
});

test('S5 semantic: a STREAMING body over the limit is cancelled after a few chunks instead of being read to the end', async () => {
  const counter = { pulled: 0 };
  const response = await semanticPOST(new Request(SEM, { method: 'POST', headers: LOCAL, body: stream(512, 10_000, counter), duplex: 'half' } as RequestInit));
  assert.equal(response.status, 413, `EXPECTED 413, ACTUAL ${response.status}`);
  assert.ok(counter.pulled <= 8, `EXPECTED the stream to stop shortly after the 1 KiB limit (<= 8 pulled chunks of 512 B), ACTUAL pulled ${counter.pulled} of 10000`);
});

test('S5 semantic: invalid JSON, a non-object, unknown fields, wrong types, an empty body, a wrong Content-Type and a foreign Origin are controlled 4xx - and never start indexing', async () => {
  delete process.env.EMBEDDING_PROVIDER;
  const cases: Array<[string, Promise<Response>, number]> = [
    ['invalid JSON', semPost('{"sampleSize":'), 400],
    ['array', semPost('[200]'), 400],
    ['null', semPost('null'), 400],
    ['number', semPost('200'), 400],
    ['unknown field', semPost('{"sampleSize":200,"all":true}'), 400],
    ['prototype-looking field', semPost('{"sampleSize":200,"__proto__":{"a":1},"constructor":1}'), 400],
    ['sampleSize as string', semPost('{"sampleSize":"200"}'), 400],
    ['sampleSize not a tier', semPost('{"sampleSize":54958}'), 400],
    ['no sampleSize', semPost('{}'), 400],
    ['confirmExternal as string', semPost('{"sampleSize":200,"confirmExternal":"yes"}'), 400],
    ['empty body', semPost(null), 400],
    ['text/plain', semPost('{"sampleSize":200}', { host: 'localhost:3000', 'content-type': 'text/plain' }), 403],
    ['foreign Origin', semPost('{"sampleSize":200}', { ...LOCAL, origin: 'https://evil.example' }), 403],
    ['public Host', semPost('{"sampleSize":200}', { host: 'example.com', 'content-type': 'application/json' }), 403],
  ];
  for (const [name, pending, expected] of cases) {
    const response = await pending;
    const body = await response.json();
    assert.equal(response.status, expected, `${name}: EXPECTED ${expected}, ACTUAL ${response.status}`);
    assert.equal(body.reason, undefined, `${name}: indexing service must not have been reached`);
    assert.equal(typeof body.error, 'string');
  }
});

test('S5 semantic: valid requests keep working - the external-send confirmation is still enforced by the service, and an unconfigured provider is a clear 409', async () => {
  delete process.env.EMBEDDING_PROVIDER;
  for (const body of ['{"sampleSize":200}', '{"sampleSize":2000,"confirmExternal":false}', '{"sampleSize":10000,"confirmExternal":true}']) {
    const response = await semPost(body);
    assert.equal(response.status, 409, `${body}: EXPECTED 409 (no provider configured), ACTUAL ${response.status}`);
    assert.equal((await response.json()).reason, 'not_configured');
  }
});

// =====================================================================================
// S6 - TechDoc export errors
// =====================================================================================

const requireFromHere = createRequire(__filename);
const TD = 'http://localhost/api/workspace/techdoc/export';
const sampleDoc = (): TechnicalProcessDocument => { const doc = createDocumentFromPreset('magnetron-pvd'); return { ...doc, general: { ...doc.general, processName: 'AlTiN_PVD' } }; };
const tdPost = (body: unknown) => techdocPOST(new Request(TD, { method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('S6 TechDoc: user-input errors stay HTTP 400 with their own message (bad format, bad type, future schema, invalid document)', async () => {
  const doc = sampleDoc();
  const cases: Array<[string, unknown, RegExp]> = [
    ['unknown format', { document: doc, documentType: 'instruction', format: 'exe' }, /Формат файла/],
    ['unknown document type', { document: doc, documentType: 'nope', format: 'docx' }, /Вид документа/],
    ['future schema', { document: { ...doc, schemaVersion: 99 }, documentType: 'instruction', format: 'docx' }, /Версия схемы документа \(99\)/],
    ['empty process name', { document: { ...doc, general: { ...doc.general, processName: '   ' } }, documentType: 'instruction', format: 'docx' }, /Название процесса/],
  ];
  for (const [name, body, pattern] of cases) {
    const response = await tdPost(body);
    const text = JSON.stringify(await response.json());
    assert.equal(response.status, 400, `${name}: EXPECTED 400, ACTUAL ${response.status} ${text}`);
    assert.match(text, pattern, name);
  }
});

/** Loads a fresh copy of the export route whose `techdoc-export` dependency is replaced by a copy with the given overrides (the real module's exports are getter-only, so they cannot be patched in place). */
function routeWith(overrides: Record<string, unknown>): { post: typeof techdocPOST; restore: () => void } {
  const exportPath = requireFromHere.resolve('../src/services/workspace/techdoc-export');
  const routePath = requireFromHere.resolve('../src/app/api/workspace/techdoc/export/route');
  const real = requireFromHere(exportPath) as Record<string, unknown>;
  const savedExport = requireFromHere.cache[exportPath]; const savedRoute = requireFromHere.cache[routePath];
  requireFromHere.cache[exportPath] = Object.assign(Object.create(Object.getPrototypeOf(savedExport)), savedExport, { exports: { ...real, ...overrides } });
  delete requireFromHere.cache[routePath];
  const post = (requireFromHere(routePath) as { POST: typeof techdocPOST }).POST;
  return { post, restore: () => { requireFromHere.cache[exportPath] = savedExport; requireFromHere.cache[routePath] = savedRoute; } };
}
const callWith = (post: typeof techdocPOST, body: unknown) => post(new Request(TD, { method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('S6 TechDoc: an internal render failure is HTTP 500 with one neutral sentence - no path, stack, token or exception text reaches the client; it is logged on the server only', async () => {
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  const thrown: unknown[] = [
    new Error('ENOENT: no such file /Users/viktor/secret/font.ttf at render (/srv/app/node_modules/docx/build/index.js:1:1) token=sk-RENDER-LEAK-123'),
    'plain string with /etc/passwd',
    new TypeError('Cannot read properties of undefined (reading "/srv/x")'),
  ];
  for (const error of thrown) {
    const { post, restore } = routeWith({ exportTechDoc: async () => { throw error; } });
    try {
      const response = await callWith(post, { document: sampleDoc(), documentType: 'instruction', format: 'docx' });
      const text = await response.text();
      assert.equal(response.status, 500, `EXPECTED 500, ACTUAL ${response.status}`);
      assert.ok(!/ENOENT|\/Users|\/srv|node_modules|sk-RENDER|token=|at render|passwd|Cannot read/.test(text), `LEAK in client body: ${text}`);
      assert.match(text, /внутренней ошибки/);
    } finally { restore(); }
  }
  console.error = originalError;
  assert.equal(logged.length, 3, 'every real exception is logged server-side');
  assert.match(String((logged[0][1] as Error).message), /ENOENT/);
});

test('S6 TechDoc: a bug-shaped exception while PARSING is a generic 400, not its text', async () => {
  const { post, restore } = routeWith({ parseExportFormat: () => { throw new TypeError('Cannot read properties of undefined (reading "/srv/secret")'); } });
  try {
    const response = await callWith(post, { document: sampleDoc(), documentType: 'instruction', format: 'docx' });
    const text = await response.text();
    assert.equal(response.status, 400, `EXPECTED 400, ACTUAL ${response.status}`);
    assert.ok(!/srv|Cannot read/.test(text), `LEAK: ${text}`);
    assert.match(text, /Некорректные данные документа/);
  } finally { restore(); }
});

test('S6 TechDoc: successful DOCX and PDF export is unchanged (status, content type, signature)', async () => {
  const docx = await tdPost({ document: sampleDoc(), documentType: 'instruction', format: 'docx' });
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get('content-type') ?? '', /wordprocessingml/);
  assert.equal(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  const pdf = await tdPost({ document: sampleDoc(), documentType: 'recipe', format: 'pdf' });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

// =====================================================================================
// S3 final fix - contradictory / invalid `usage` must never release the reservation
// =====================================================================================

test('S3 usage: the parser trusts only a consistent block (chat and embeddings), and rejects every contradictory or damaged one', () => {
  const T = totalTokensFromUsage;
  // trusted
  assert.equal(T({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }), 100, 'correct chat usage');
  assert.equal(T({ prompt_tokens: 80, completion_tokens: 20 }), 100, 'chat without total: the sum of both components');
  assert.equal(T({ prompt_tokens: 7, total_tokens: 7 }, 'embedding'), 7, 'correct embeddings usage');
  assert.equal(T({ prompt_tokens: 7 }, 'embedding'), 7, 'embeddings without total: the prompt');
  assert.equal(T({ total_tokens: 55 }, 'embedding'), 55, 'embeddings: a total alone is enough');
  assert.equal(T({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 130 }), 130, 'a total above the parts is accepted as stated');
  // rejected -> null (the estimate stays booked)
  const bad: Array<[string, unknown]> = [
    ['Codex case: total 0, positive components', { total_tokens: 0, prompt_tokens: 80, completion_tokens: 20 }],
    ['total below the sum of components', { total_tokens: 99, prompt_tokens: 80, completion_tokens: 20 }],
    ['total below the prompt alone', { total_tokens: 10, prompt_tokens: 80 }],
    ['all zero', { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 }],
    ['only zero total', { total_tokens: 0 }],
    ['negative total', { total_tokens: -1, prompt_tokens: 5, completion_tokens: 5 }],
    ['negative component with a good total', { total_tokens: 100, prompt_tokens: -80, completion_tokens: 20 }],
    ['fractional total', { total_tokens: 99.5 }],
    ['fractional component', { total_tokens: 100, prompt_tokens: 80.5, completion_tokens: 19.5 }],
    ['string total', { total_tokens: '100' }],
    ['string component with a good total', { total_tokens: 100, prompt_tokens: '80', completion_tokens: 20 }],
    ['NaN total', { total_tokens: NaN }],
    ['Infinity total', { total_tokens: Infinity }],
    ['-Infinity component', { total_tokens: 100, prompt_tokens: -Infinity }],
    ['null component', { total_tokens: 100, prompt_tokens: null, completion_tokens: 20 }],
    ['implausibly large', { total_tokens: 1e12 }],
    ['chat: total alone (Codex case 1)', { total_tokens: 1 }],
    ['chat: total + prompt only (Codex case 2)', { total_tokens: 1, prompt_tokens: 1 }],
    ['chat: total + completion only (Codex case 3)', { total_tokens: 1, completion_tokens: 1 }],
    ['chat: total 500 + prompt only', { total_tokens: 500, prompt_tokens: 80 }],
    ['chat without total and without completion', { prompt_tokens: 80 }],
    ['chat without total and without prompt', { completion_tokens: 20 }],
    ['empty object', {}],
    ['absent', undefined], ['null', null], ['string', 'usage'], ['array', [1, 2, 3]], ['number', 100],
  ];
  for (const [name, usage] of bad) assert.equal(T(usage), null, `${name}: EXPECTED null, ACTUAL ${String(T(usage))}`);
});

test('S3 usage (Codex reproduction, real OpenAIWriterProvider): a contradictory usage block never releases the reservation - budget 100, reserve 20, +61 s between requests', async () => {
  const c = clock();
  const guard = new AiGuard(config({ tokenBudget24h: { chat: 100, embedding: 1_000_000 }, maxOutputTokens: { writer: 10, rag_answer: 10 }, ratePerMinute: { chat: 1, embedding: 120 } }), c.now, c.sleep);
  // Reserve per request = ceil(20 / 2) + 10 = 20 tokens.
  const request = { system: 'a'.repeat(10), user: 'b'.repeat(10) };
  let calls = 0;
  const fetcher = (async () => { calls++; return chatOk('ok', { total_tokens: 0, prompt_tokens: 80, completion_tokens: 20 }); }) as typeof fetch;
  const provider = new OpenAIWriterProvider(fetcher, KEY, 'm', 1000, guard);
  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    try { await provider.generate(request); outcomes.push('ok'); }
    catch (error) { outcomes.push(error instanceof WriterProviderError ? String(error.reason) : 'other'); }
    c.advance(61_000); // the per-minute rate limit never interferes: only the budget can stop these
  }
  assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'ok', 'ok', 'local_budget', 'local_budget', 'local_budget', 'local_budget', 'local_budget'], `ACTUAL ${outcomes.join(',')}`);
  assert.equal(calls, 5, `EXPECTED at most 5 provider calls (100 / 20), ACTUAL ${calls} - the refusals happen BEFORE the provider is called`);
  const snap = guard.snapshot().chat;
  assert.equal(snap.actualTokens24h, 0, 'the damaged usage is never booked as actual');
  assert.equal(snap.estimatedTokens24h, 100, `EXPECTED the 5 reservations (100) to stay booked, ACTUAL ${snap.estimatedTokens24h}`);
  assert.equal(guard.snapshot().inFlight, 0);
});

test('S3 usage (real providers): every damaged shape keeps the reservation; correct chat and embeddings usage is booked as actual; counters never go negative', async () => {
  const shapes: Array<[string, unknown]> = [
    ['total 0', { total_tokens: 0, prompt_tokens: 80, completion_tokens: 20 }], ['total < sum', { total_tokens: 50, prompt_tokens: 80, completion_tokens: 20 }],
    ['negative', { total_tokens: -100, prompt_tokens: 80, completion_tokens: 20 }], ['fractional', { total_tokens: 10.5 }], ['string', { total_tokens: '100' }],
    ['NaN as JSON null', { total_tokens: null, prompt_tokens: 80, completion_tokens: 20, extra: NaN }], ['no total, one component', { prompt_tokens: 80 }], ['absent', undefined],
  ];
  for (const [name, usage] of shapes) {
    const guard = new AiGuard(config({ maxOutputTokens: { writer: 10, rag_answer: 10 } }));
    await new OpenAIWriterProvider((async () => chatOk('ok', usage)) as typeof fetch, KEY, 'm', 1000, guard).generate({ system: 'a'.repeat(10), user: 'b'.repeat(10) });
    const snap = guard.snapshot().chat;
    assert.equal(snap.estimatedTokens24h, 20, `${name}: EXPECTED the 20-token reservation to stay booked, ACTUAL ${snap.estimatedTokens24h}`);
    assert.equal(snap.actualTokens24h, 0, name);
  }
  // correct chat usage -> the confirmed number replaces the reservation
  const good = new AiGuard(config({ maxOutputTokens: { writer: 10, rag_answer: 10 } }));
  await new OpenAIWriterProvider((async () => chatOk('ok', { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 })) as typeof fetch, KEY, 'm', 1000, good).generate({ system: 'a'.repeat(10), user: 'b'.repeat(10) });
  assert.deepEqual([good.snapshot().chat.actualTokens24h, good.snapshot().chat.estimatedTokens24h], [12, 0]);
  // correct embeddings usage, and a damaged one
  const embed = new AiGuard(config());
  const ok = new OpenAIEmbeddingProvider((async () => json({ data: [{ index: 0, embedding: [1, 0, 0, 0] }], usage: { prompt_tokens: 9, total_tokens: 9 } })) as typeof fetch, KEY, 'm', 4, 1000, embed);
  await ok.embedQuery('some question');
  assert.equal(embed.snapshot().embedding.actualTokens24h, 9);
  const damaged = new AiGuard(config());
  const dp = new OpenAIEmbeddingProvider((async () => json({ data: [{ index: 0, embedding: [1, 0, 0, 0] }], usage: { prompt_tokens: 9, total_tokens: 0 } })) as typeof fetch, KEY, 'm', 4, 1000, damaged);
  await dp.embedQuery('some question');
  assert.equal(damaged.snapshot().embedding.actualTokens24h, 0);
  assert.ok(damaged.snapshot().embedding.estimatedTokens24h > 0, 'embeddings: damaged usage keeps the estimate');
});

test('S3 usage (guard level): an exception after sending keeps the reservation; repeated complete/fail never release or refund twice; concurrent damaged-usage requests all keep their reservations', async () => {
  const guard = new AiGuard(config({ maxOutputTokens: { writer: 10, rag_answer: 10 } }));
  const a = await guard.acquire('writer', { inputChars: 20, maxOutputTokens: 10 });
  a.complete({ total_tokens: 0, prompt_tokens: 80, completion_tokens: 20 });
  a.complete({ total_tokens: 5 }); // a second settle must change nothing
  a.fail(false); a.fail(true);
  assert.deepEqual([guard.snapshot().chat.estimatedTokens24h, guard.snapshot().chat.actualTokens24h, guard.snapshot().inFlight], [20, 0, 0]);
  const b = await guard.acquire('writer', { inputChars: 20, maxOutputTokens: 10 });
  b.fail(true); b.complete({ total_tokens: 1 }); // an exception after sending, then a late complete: still the reservation
  assert.deepEqual([guard.snapshot().chat.estimatedTokens24h, guard.snapshot().chat.actualTokens24h], [40, 0]);
  const c2 = await guard.acquire('writer', { inputChars: 20, maxOutputTokens: 10 });
  c2.fail(false); c2.fail(false); // refused before sending: refunded exactly once
  assert.deepEqual([guard.snapshot().chat.estimatedTokens24h, guard.snapshot().inFlight], [40, 0]);

  const tight = new AiGuard(config({ tokenBudget24h: { chat: 100, embedding: 1_000_000 }, maxOutputTokens: { writer: 10, rag_answer: 10 }, maxConcurrent: 16, ratePerMinute: { chat: 600, embedding: 120 } }));
  let calls = 0;
  const provider = new OpenAIWriterProvider((async () => { calls++; await new Promise(r => setTimeout(r, 5)); return chatOk('ok', { total_tokens: 0, prompt_tokens: 80, completion_tokens: 20 }); }) as typeof fetch, KEY, 'm', 1000, tight);
  const results = await Promise.all(Array.from({ length: 12 }, () => provider.generate({ system: 'a'.repeat(10), user: 'b'.repeat(10) }).then(() => 'ok', (e: unknown) => (e instanceof WriterProviderError ? String(e.reason) : 'other'))));
  assert.equal(results.filter(r => r === 'ok').length, 5, `EXPECTED exactly 5 of 12 concurrent requests to fit the budget, ACTUAL ${results.join(',')}`);
  assert.equal(calls, 5, `EXPECTED 5 provider calls, ACTUAL ${calls}`);
  assert.equal(tight.snapshot().chat.estimatedTokens24h, 100);
  assert.equal(tight.snapshot().inFlight, 0);
});

test('S3 usage: an INCOMPLETE chat usage is untrusted whatever its total - each of the three Codex JSONs separately, 10 sequential requests through the real OpenAIWriterProvider (budget 100, reserve 20, +61 s)', async () => {
  const cases: Array<[string, unknown]> = [
    ['{"total_tokens":1}', { total_tokens: 1 }],
    ['{"total_tokens":1,"prompt_tokens":1}', { total_tokens: 1, prompt_tokens: 1 }],
    ['{"total_tokens":1,"completion_tokens":1}', { total_tokens: 1, completion_tokens: 1 }],
  ];
  const lines: string[] = [];
  for (const [label, usage] of cases) {
    assert.equal(totalTokensFromUsage(usage), null, `${label}: parser EXPECTED null (untrusted)`);
    const c = clock();
    const guard = new AiGuard(config({ tokenBudget24h: { chat: 100, embedding: 1_000_000 }, maxOutputTokens: { writer: 10, rag_answer: 10 }, ratePerMinute: { chat: 1, embedding: 120 } }), c.now, c.sleep);
    let calls = 0;
    const provider = new OpenAIWriterProvider((async () => { calls++; return chatOk('ok', usage); }) as typeof fetch, KEY, 'm', 1000, guard);
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      try { await provider.generate({ system: 'a'.repeat(10), user: 'b'.repeat(10) }); outcomes.push('ok'); }
      catch (error) { outcomes.push(error instanceof WriterProviderError ? String(error.reason) : 'other'); }
      c.advance(61_000);
    }
    const snap = guard.snapshot().chat;
    lines.push(`${label} -> ${outcomes.join(',')} | provider calls ${calls} | reserved ${snap.estimatedTokens24h} | actual ${snap.actualTokens24h}`);
    assert.deepEqual(outcomes, ['ok', 'ok', 'ok', 'ok', 'ok', 'local_budget', 'local_budget', 'local_budget', 'local_budget', 'local_budget'], `${label}: ACTUAL ${outcomes.join(',')}`);
    assert.equal(calls, 5, `${label}: EXPECTED 5 provider calls, ACTUAL ${calls}`);
    assert.equal(snap.estimatedTokens24h, 100, `${label}: EXPECTED the reservation 100 to stay, ACTUAL ${snap.estimatedTokens24h}`);
    assert.equal(snap.actualTokens24h, 0, label);
  }
  console.log(lines.join('\n'));
});

test('S3 usage: a complete chat usage is booked as actual - with total and without total; a valid embeddings usage still works', async () => {
  for (const [label, usage, expected] of [
    ['with total', { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }, 12],
    ['without total', { prompt_tokens: 8, completion_tokens: 4 }, 12],
    ['total above the parts', { prompt_tokens: 8, completion_tokens: 4, total_tokens: 15 }, 15],
  ] as const) {
    const guard = new AiGuard(config({ maxOutputTokens: { writer: 10, rag_answer: 10 } }));
    await new OpenAIWriterProvider((async () => chatOk('ok', usage)) as typeof fetch, KEY, 'm', 1000, guard).generate({ system: 'a'.repeat(10), user: 'b'.repeat(10) });
    assert.deepEqual([guard.snapshot().chat.actualTokens24h, guard.snapshot().chat.estimatedTokens24h], [expected, 0], `chat ${label}`);
  }
  for (const [label, usage, expected] of [['prompt + total', { prompt_tokens: 9, total_tokens: 9 }, 9], ['prompt only', { prompt_tokens: 9 }, 9], ['total only', { total_tokens: 9 }, 9]] as const) {
    const guard = new AiGuard(config());
    await new OpenAIEmbeddingProvider((async () => json({ data: [{ index: 0, embedding: [1, 0, 0, 0] }], usage })) as typeof fetch, KEY, 'm', 4, 1000, guard).embedQuery('question');
    assert.equal(guard.snapshot().embedding.actualTokens24h, expected, `embeddings ${label}`);
  }
});
