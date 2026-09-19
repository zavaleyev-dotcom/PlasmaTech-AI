import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as writerGET, POST as writerPOST, handleGenerate } from '../src/app/api/workspace/scientific-writer/route';
import { WriterProviderError, type WriterProvider } from '../src/services/workspace/scientific-writer-provider';

function stubProvider(overrides: Partial<WriterProvider> = {}): WriterProvider {
  return {
    id: 'stub',
    configured: () => true,
    generate: async () => ({ text: 'Stub generated text.' }),
    ...overrides,
  };
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/workspace/scientific-writer', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validDraftBody = {
  documentType: 'article', mode: 'draft', targetLanguage: 'en',
  title: 'Влияние давления на твёрдость TiN', goal: 'Изучить влияние давления на твёрдость покрытий',
};

// ---------- provider unavailable state (item 8/11) ----------

test('GET status: reports configured=false when OPENAI_API_KEY is not set in this environment, never pretending a provider is active', async () => {
  const response = await writerGET(new Request('http://localhost/api/workspace/scientific-writer', { headers: { host: 'localhost' } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.configured, 'boolean');
  if (!process.env.OPENAI_API_KEY) {
    assert.equal(body.configured, false);
    assert.equal(body.providerId, 'unconfigured');
  }
});

test('POST: when the provider is not configured, returns 503 with a clear not_configured code rather than fabricating generated text', async () => {
  if (process.env.OPENAI_API_KEY) return; // this environment genuinely has a key - the unavailable path isn't reachable to test here
  const response = await writerPOST(postRequest(validDraftBody));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'not_configured');
  assert.ok(!('generatedText' in body));
});

// ---------- local-only / content-type ----------

test('rejects non-local requests and requests without a JSON content-type', async () => {
  const crossOrigin = await writerPOST(new Request('http://evil.example/api/workspace/scientific-writer', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }));
  assert.equal(crossOrigin.status, 403);
  const missingContentType = await writerPOST(new Request('http://localhost/api/workspace/scientific-writer', { method: 'POST', headers: { host: 'localhost' } }));
  assert.equal(missingContentType.status, 403);
  const crossOriginGet = await writerGET(new Request('http://evil.example/api/workspace/scientific-writer', { headers: { host: 'evil.example' } }));
  assert.equal(crossOriginGet.status, 403);
});

// ---------- malformed JSON / invalid enum / type rejection ----------

test('rejects malformed JSON with a 400, not a crash', async () => {
  const response = await writerPOST(postRequest('not json at all'));
  assert.equal(response.status, 400);
});

test('rejects an invalid document type or mode before touching the provider', async () => {
  const badType = await writerPOST(postRequest({ ...validDraftBody, documentType: 'bogus' }));
  assert.equal(badType.status, 400);
  const badMode = await writerPOST(postRequest({ ...validDraftBody, mode: 'bogus' }));
  assert.equal(badMode.status, 400);
});

// ---------- empty / oversized input ----------

test('rejects an empty draft request server-side (matching the client-side validator)', async () => {
  const response = await writerPOST(postRequest({ documentType: 'article', mode: 'draft', targetLanguage: 'en' }));
  assert.equal(response.status, 400);
});

test('rejects an oversized field server-side, independent of any client-side check', async () => {
  const response = await writerPOST(postRequest({ ...validDraftBody, methods: 'a'.repeat(25_000) }));
  assert.equal(response.status, 400);
});

test('rejects an oversized raw request body before ever parsing JSON', async () => {
  const response = await writerPOST(postRequest('a'.repeat(300_001)));
  assert.equal(response.status, 413);
});

// ---------- server-side validation does not trust the client shape ----------

test('server-side parsing never spreads untrusted properties into the request (prototype-pollution safe)', async () => {
  const raw = JSON.parse('{"documentType":"article","mode":"draft","targetLanguage":"en","title":"X","__proto__":{"polluted":true}}');
  const response = await writerPOST(postRequest(raw));
  // Either accepted (200/503, key absent) or a validation error - never a crash, and never a polluted global.
  assert.ok([200, 400, 503, 502].includes(response.status));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined, 'global Object.prototype must stay clean');
});

test('rejects a rewrite-mode request missing the required sourceText, server-side', async () => {
  const response = await writerPOST(postRequest({ documentType: 'article', mode: 'rewrite', targetLanguage: 'en' }));
  assert.equal(response.status, 400);
});

// ---------- handleGenerate with a stub provider (item 9): every outcome, end to end ----------

test('handleGenerate: a successful generation returns 200 with the text, evidence, and an empty warnings array when nothing is wrong', async () => {
  const { status, body } = await handleGenerate(validDraftBody, stubProvider({ generate: async () => ({ text: 'Abstract: coatings were studied.' }) }));
  assert.equal(status, 200);
  assert.equal(body.generatedText, 'Abstract: coatings were studied.');
  assert.deepEqual(body.warnings, []);
  assert.ok(body.evidence);
});

test('handleGenerate: citation/DOI safeguard - a fabricated DOI or reference list in the AI output surfaces as a warning, never silently shown as clean', async () => {
  const withDoi = await handleGenerate(validDraftBody, stubProvider({ generate: async () => ({ text: 'See doi:10.1234/abcd.5678 for details.' }) }));
  assert.equal(withDoi.status, 200);
  assert.ok((withDoi.body.warnings as string[]).some(w => w.includes('DOI')));

  const withReferences = await handleGenerate(validDraftBody, stubProvider({ generate: async () => ({ text: 'Conclusion.\n\nReferences\n[1] Smith et al.' }) }));
  assert.ok((withReferences.body.warnings as string[]).length > 0);
});

test('handleGenerate: preservation safeguard - a rewrite that drops a number or protected term surfaces a warning', async () => {
  const rewriteBody = { documentType: 'article', mode: 'rewrite', targetLanguage: 'en', sourceText: 'The PVD coating thickness was 350 nm.' };
  const { status, body } = await handleGenerate(rewriteBody, stubProvider({ generate: async () => ({ text: 'The coating was thick.' }) }));
  assert.equal(status, 200);
  const warnings = body.warnings as string[];
  assert.ok(warnings.some(w => w.includes('350')));
  assert.ok(warnings.some(w => w.includes('PVD')));
  assert.equal((body.preservation as { ok: boolean }).ok, false);
});

test('handleGenerate: invented-number safeguard - a draft that states a number the user never gave surfaces a warning', async () => {
  const { body } = await handleGenerate(validDraftBody, stubProvider({ generate: async () => ({ text: 'Hardness reached 9999 HV under these conditions.' }) }));
  assert.ok((body.warnings as string[]).some(w => w.includes('9999')));
});

test('handleGenerate: provider not configured returns 503 with code not_configured, never fabricating text', async () => {
  const { status, body } = await handleGenerate(validDraftBody, stubProvider({ configured: () => false, generate: async () => { throw new WriterProviderError('nope', 'not_configured'); } }));
  assert.equal(status, 503);
  assert.equal(body.code, 'not_configured');
  assert.ok(!('generatedText' in body));
});

test('handleGenerate: provider unavailable (timeout/429/5xx) returns 502 with code unavailable', async () => {
  const { status, body } = await handleGenerate(validDraftBody, stubProvider({ generate: async () => { throw new WriterProviderError('OpenAI не ответил вовремя.', 'unavailable'); } }));
  assert.equal(status, 502);
  assert.equal(body.code, 'unavailable');
});

test('handleGenerate: provider error (401/malformed/empty) returns 502 with code error', async () => {
  const { status, body } = await handleGenerate(validDraftBody, stubProvider({ generate: async () => { throw new WriterProviderError('OpenAI отклонил доступ.', 'error'); } }));
  assert.equal(status, 502);
  assert.equal(body.code, 'error');
});

test('handleGenerate: a non-object body is rejected with 400 rather than crashing', async () => {
  const { status } = await handleGenerate('just a string', stubProvider());
  assert.equal(status, 400);
  const { status: arrayStatus } = await handleGenerate([1, 2, 3], stubProvider());
  assert.equal(arrayStatus, 400);
});
