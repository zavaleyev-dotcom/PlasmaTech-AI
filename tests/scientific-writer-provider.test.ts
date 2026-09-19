import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIWriterProvider, WriterProviderError, unconfiguredWriterProvider, getWriterProvider } from '../src/services/workspace/scientific-writer-provider';

const SECRET_MARKER = 'sk-TOTALLY-SECRET-MARKER-1234567890';

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

// ---------- configured / unconfigured (item 3/9) ----------

test('configured()/unconfigured provider: honestly report whether an API key is present, never assuming one', () => {
  const withKey = new OpenAIWriterProvider(async () => jsonResponse({}), 'a-key');
  const withoutKey = new OpenAIWriterProvider(async () => jsonResponse({}), undefined);
  assert.equal(withKey.configured(), true);
  assert.equal(withoutKey.configured(), false);
  assert.equal(unconfiguredWriterProvider.configured(), false);
});

test('getWriterProvider(): selects the real OpenAI provider only when an API key is actually present in this environment', () => {
  const provider = getWriterProvider();
  if (process.env.OPENAI_API_KEY) {
    assert.equal(provider.id, 'openai');
    assert.equal(provider.configured(), true);
  } else {
    assert.equal(provider.id, 'unconfigured');
    assert.equal(provider.configured(), false);
  }
});

test('unconfiguredWriterProvider.generate(): always rejects with kind "not_configured", never returns fabricated text', async () => {
  await assert.rejects(() => unconfiguredWriterProvider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'not_configured');
});

// ---------- successful response ----------

test('successful provider response: returns the model text exactly, unmodified', async () => {
  const provider = new OpenAIWriterProvider(async () => jsonResponse({ choices: [{ message: { content: 'Generated abstract text.' } }] }), 'test-key');
  const result = await provider.generate({ system: 'sys', user: 'usr' });
  assert.equal(result.text, 'Generated abstract text.');
});

// ---------- malformed / empty response ----------

test('malformed provider response: non-JSON content-type is rejected with kind "error", not silently accepted', async () => {
  const provider = new OpenAIWriterProvider(async () => new Response('<html>error page</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
});

test('malformed provider response: valid JSON but missing choices[0].message.content is rejected with kind "error"', async () => {
  const provider = new OpenAIWriterProvider(async () => jsonResponse({ unexpected: 'shape' }), 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
});

test('malformed provider response: broken JSON body is rejected with kind "error", not a crash', async () => {
  const provider = new OpenAIWriterProvider(async () => new Response('{not valid json', { status: 200, headers: { 'Content-Type': 'application/json' } }), 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
});

test('empty provider response: an empty or whitespace-only message content is rejected with kind "error", never treated as valid text', async () => {
  const empty = new OpenAIWriterProvider(async () => jsonResponse({ choices: [{ message: { content: '' } }] }), 'test-key');
  await assert.rejects(() => empty.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
  const whitespace = new OpenAIWriterProvider(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] }), 'test-key');
  await assert.rejects(() => whitespace.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
});

// ---------- timeout ----------

test('provider timeout: an AbortError/TimeoutError from the fetcher is normalized to kind "unavailable"', async () => {
  const provider = new OpenAIWriterProvider(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }, 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'unavailable');
});

test('network failure: a generic fetch rejection is normalized to kind "unavailable" without leaking the underlying error', async () => {
  const provider = new OpenAIWriterProvider(async () => { throw new Error('ECONNREFUSED 1.2.3.4:443'); }, 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => {
    return err instanceof WriterProviderError && err.kind === 'unavailable' && !err.message.includes('ECONNREFUSED') && !err.message.includes('1.2.3.4');
  });
});

// ---------- 401 / 429 / 5xx ----------

test('401/403: bad credentials are reported with kind "error" (not transient - retrying the same key will not help)', async () => {
  const unauthorized = new OpenAIWriterProvider(async () => new Response('', { status: 401 }), 'bad-key');
  await assert.rejects(() => unauthorized.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
  const forbidden = new OpenAIWriterProvider(async () => new Response('', { status: 403 }), 'bad-key');
  await assert.rejects(() => forbidden.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'error');
});

test('429: rate limiting is reported with kind "unavailable" (transient - worth retrying later)', async () => {
  const provider = new OpenAIWriterProvider(async () => new Response('', { status: 429 }), 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'unavailable');
});

test('5xx: an upstream OpenAI outage is reported with kind "unavailable" (transient)', async () => {
  const provider = new OpenAIWriterProvider(async () => new Response('', { status: 500 }), 'test-key');
  await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'unavailable');
  const badGateway = new OpenAIWriterProvider(async () => new Response('', { status: 503 }), 'test-key');
  await assert.rejects(() => badGateway.generate({ system: 's', user: 'u' }), (err: unknown) => err instanceof WriterProviderError && err.kind === 'unavailable');
});

// ---------- API key never exposed (item 2/9) ----------

test('API key is never exposed: no error message, from any failure path, ever contains the raw key value', async () => {
  const scenarios: (() => Promise<Response>)[] = [
    async () => new Response('', { status: 401 }),
    async () => new Response('', { status: 403 }),
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 500 }),
    async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async () => jsonResponse({}),
    async () => { throw new Error(`failed while using key ${SECRET_MARKER}`); }, // even a hostile fetcher that echoes the key must not leak it
  ];
  for (const fetcher of scenarios) {
    const provider = new OpenAIWriterProvider(fetcher, SECRET_MARKER);
    await assert.rejects(() => provider.generate({ system: 's', user: 'u' }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(SECRET_MARKER), `error message must never contain the API key, got: ${err.message}`);
      return true;
    });
  }
});

test('API key is never sent anywhere except the Authorization header of the real OpenAI request', async () => {
  let capturedAuth: string | null = null;
  const provider = new OpenAIWriterProvider(async (_url, init) => {
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  }, SECRET_MARKER);
  const result = await provider.generate({ system: 's', user: 'u' });
  assert.equal(capturedAuth, `Bearer ${SECRET_MARKER}`);
  assert.ok(!result.text.includes(SECRET_MARKER));
});
