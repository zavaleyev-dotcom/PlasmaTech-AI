import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as checkPOST } from '../src/app/api/workspace/anti-plagiarism/route';
import { handleCheck } from '../src/services/workspace/anti-plagiarism-handler';

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/workspace/anti-plagiarism', {
    method: 'POST',
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------- local-only / content-type ----------

test('rejects non-local requests and requests without a JSON content-type', async () => {
  const crossOrigin = await checkPOST(new Request('http://evil.example/api/workspace/anti-plagiarism', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }));
  assert.equal(crossOrigin.status, 403);
  const missingContentType = await checkPOST(new Request('http://localhost/api/workspace/anti-plagiarism', { method: 'POST', headers: { host: 'localhost' } }));
  assert.equal(missingContentType.status, 403);
});

// ---------- malformed JSON / invalid request ----------

test('rejects malformed JSON with a 400, not a crash', async () => {
  const response = await checkPOST(postRequest('not json at all'));
  assert.equal(response.status, 400);
});

test('rejects a non-object body and a body missing/mistyped "text"', async () => {
  const { status: arrayStatus } = await handleCheck([1, 2, 3]);
  assert.equal(arrayStatus, 400);
  const { status: missingStatus } = await handleCheck({});
  assert.equal(missingStatus, 400);
  const { status: wrongTypeStatus } = await handleCheck({ text: 12345 });
  assert.equal(wrongTypeStatus, 400);
});

// ---------- server-side validation (empty / oversized), independent of any client-side check ----------

test('server-side validation rejects an empty or too-short text', async () => {
  const { status: emptyStatus, body: emptyBody } = await handleCheck({ text: '' });
  assert.equal(emptyStatus, 400);
  assert.ok(typeof emptyBody.error === 'string');
  const { status: shortStatus } = await handleCheck({ text: 'too short' });
  assert.equal(shortStatus, 400);
});

test('server-side validation rejects an oversized text', async () => {
  const { status } = await handleCheck({ text: 'a'.repeat(20_001) });
  assert.equal(status, 400);
});

test('rejects an oversized raw request body before ever parsing JSON', async () => {
  const response = await checkPOST(postRequest('a'.repeat(200_001)));
  assert.equal(response.status, 413);
});

// ---------- F10: internal errors never leak to the client ----------

test('handleCheck: an arbitrary internal exception (e.g. a filesystem/storage failure) is never forwarded verbatim - only a fixed, neutral message', async () => {
  const throwing = async () => { throw new Error('ENOENT: no such file or directory, open \'/tmp/secret-internal-path/index.sqlite\''); };
  const { status, body } = await handleCheck({ text: 'a'.repeat(200) }, throwing);
  assert.equal(status, 500);
  assert.equal(body.error, 'Не удалось выполнить проверку.');
  assert.ok(!String(body.error).includes('/tmp/'), 'the real filesystem path must never reach the client');
  assert.ok(!String(body.error).includes('ENOENT'));
});

test('handleCheck: a genuine ValidationError (e.g. text too short) still returns its own safe, specific message', async () => {
  const { status, body } = await handleCheck({ text: 'short' });
  assert.equal(status, 400);
  assert.ok(String(body.error).includes('короткий'), 'a real validation message must still reach the client');
});

// Note: a "valid request against the REAL local corpus returns 200" check is intentionally
// NOT here - the node:test runner (raw `node --import tsx`) does not auto-load .env.local the
// way `next dev`/`next build` do, so SCIENTIFIC_LIBRARY_PATH is invisible in this process even
// though it is genuinely configured for the real app. That real-corpus, real-route path is
// instead verified by the live dev-server functional smoke test (which does go through
// Next.js's own env loading). checkSimilarity()'s corpus behavior itself (exact/near_exact/
// similar/self_repeat/empty-corpus/dedup/attribution) is already covered exhaustively against
// a synthetic, dependency-injected TextStore in anti-plagiarism-corpus.test.ts.
