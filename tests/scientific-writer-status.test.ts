import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkProviderStatus, classifyBodyReadFailure, classifyGenerationException, classifyGenerationResponse, classifyTransportFailure, classifyUnexpectedSuccess, describeProviderStatus,
  parseGenerationBody, readResponseBody, safeValidationMessage, WRITER_FAILURE_REASONS, type ProviderStatus,
} from '../src/services/workspace/scientific-writer-status';
import { OpenAIWriterProvider, WriterProviderError, unconfiguredWriterProvider, type WriterProvider } from '../src/services/workspace/scientific-writer-provider';
import { handleGenerate } from '../src/services/workspace/scientific-writer-handler';
import { applyGenerationOutcome, createGenerationGuard, defaultDraftForm, type GenerationView } from '../src/services/workspace/scientific-writer-draft-store';

const SECRET = 'sk-TOTALLY-SECRET-MARKER-1234567890';
const respond = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const status = (fetcher: typeof fetch) => checkProviderStatus(fetcher, 1000);
const timeoutError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
const validBody = { documentType: 'article', mode: 'draft', targetLanguage: 'en', title: 'SYNTHETIC', goal: 'SYNTHETIC goal' };
const stub = (generate: WriterProvider['generate'], configured = true): WriterProvider => ({ id: 'stub', configured: () => configured, generate });

// ---------- the status check ----------

test('S1. configured and not configured are reported only when the server\'s valid answer says so', async () => {
  assert.deepEqual(await status(async () => respond({ configured: true, providerId: 'openai' })), { kind: 'configured' });
  assert.deepEqual(await status(async () => respond({ configured: false, providerId: 'unconfigured' })), { kind: 'not_configured' });
  assert.equal(describeProviderStatus({ kind: 'configured' }), null);
  assert.equal(describeProviderStatus({ kind: 'checking' }), null);
  assert.match(describeProviderStatus({ kind: 'not_configured' })!, /сервер сообщает, что ключ OPENAI_API_KEY не задан/);
});

test('S2. a failed check is never reported as "not configured": every way it can fail is its own state', async () => {
  const cases: [string, typeof fetch, ProviderStatus][] = [
    ['network error', async () => { throw new TypeError('fetch failed'); }, { kind: 'check_failed', reason: 'network' }],
    ['stopped server (connection refused)', async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, { kind: 'check_failed', reason: 'network' }],
    ['timeout', async () => { throw timeoutError(); }, { kind: 'check_failed', reason: 'timeout' }],
    ['abort', async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, { kind: 'check_failed', reason: 'aborted' }],
    ['403', async () => respond({ error: 'Недопустимый локальный запрос.' }, 403), { kind: 'check_failed', reason: 'forbidden', httpStatus: 403 }],
    ['500', async () => respond({ error: 'x' }, 500), { kind: 'check_failed', reason: 'server_error', httpStatus: 500 }],
    ['502 html', async () => respond('<html>Bad gateway</html>', 502, 'text/html'), { kind: 'check_failed', reason: 'server_error', httpStatus: 502 }],
    ['503', async () => respond('', 503), { kind: 'check_failed', reason: 'server_error', httpStatus: 503 }],
    ['404', async () => respond('Not found', 404, 'text/plain'), { kind: 'check_failed', reason: 'http_error', httpStatus: 404 }],
    ['not json', async () => respond('<html></html>', 200, 'text/html'), { kind: 'check_failed', reason: 'bad_response' }],
    ['empty object', async () => respond({}), { kind: 'check_failed', reason: 'bad_response' }],
    ['configured not a boolean', async () => respond({ configured: 'yes' }), { kind: 'check_failed', reason: 'bad_response' }],
    ['null', async () => respond('null'), { kind: 'check_failed', reason: 'bad_response' }],
    ['array', async () => respond([{ configured: true }]), { kind: 'check_failed', reason: 'bad_response' }],
  ];
  for (const [name, fetcher, expected] of cases) {
    const got = await status(fetcher);
    assert.deepEqual(got, expected, name);
    const text = describeProviderStatus(got)!;
    assert.match(text, /Не удалось проверить состояние ИИ-провайдера, поэтому неизвестно, настроен ли он/, name);
    assert.ok(!/OPENAI_API_KEY|ключ.*не задан|не настроен(?!\s*ли)/.test(text), `${name}: must not state a missing key`);
  }
  // each message says what happened
  assert.match(describeProviderStatus({ kind: 'check_failed', reason: 'network' })!, /нет связи с сервером/);
  assert.match(describeProviderStatus({ kind: 'check_failed', reason: 'timeout' })!, /не ответил вовремя/);
  assert.match(describeProviderStatus({ kind: 'check_failed', reason: 'server_error', httpStatus: 500 })!, /HTTP 500/);
  assert.match(describeProviderStatus({ kind: 'check_failed', reason: 'forbidden', httpStatus: 403 })!, /нелокальный запрос/);
  assert.match(describeProviderStatus({ kind: 'check_failed', reason: 'bad_response' })!, /не удалось распознать/);
});

test('S3. the check asks with a timeout and no cache, and never throws', async () => {
  let seen: RequestInit | undefined;
  await status(async (_url, init) => { seen = init; return respond({ configured: true }); });
  assert.equal(seen?.cache, 'no-store'); assert.ok(seen?.signal instanceof AbortSignal);
  let hung = false;
  const got = await checkProviderStatus(((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => { hung = true; init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)); })) as typeof fetch, 30);
  assert.equal(hung, true);
  assert.deepEqual(got, { kind: 'check_failed', reason: 'timeout' });                               // a real timeout of a server that never answers
  await assert.doesNotReject(status(async () => { throw 'not even an Error'; }));
  assert.deepEqual(await status(async () => { throw 'not even an Error'; }), { kind: 'check_failed', reason: 'network' });
});

// ---------- the generation: what the server reports -> what the user reads ----------

test('G1. every provider cause the server can report gets its own message and state', () => {
  const cases: [number, unknown, string, 'not_configured' | 'unavailable' | 'error', RegExp][] = [
    [503, { code: 'not_configured' }, 'not_configured', 'not_configured', /не настроен.*OPENAI_API_KEY/],
    [502, { code: 'unavailable', reason: 'timeout' }, 'provider_timeout', 'unavailable', /не ответил вовремя/],
    [502, { code: 'unavailable', reason: 'network' }, 'provider_network', 'unavailable', /не смог связаться с ИИ-провайдером/],
    [502, { code: 'unavailable', reason: 'rate_limit' }, 'rate_limit', 'unavailable', /ограничил число запросов/],
    [502, { code: 'unavailable', reason: 'upstream' }, 'provider_unavailable', 'unavailable', /временно недоступен/],
    [502, { code: 'unavailable' }, 'provider_unavailable', 'unavailable', /временно недоступен/],
    [502, { code: 'error', reason: 'auth' }, 'provider_auth', 'error', /отклонил доступ.*ключ API/],
    [502, { code: 'error', reason: 'rejected' }, 'provider_rejected', 'error', /вернул ошибку при генерации/],
    [502, { code: 'error', reason: 'bad_response' }, 'bad_provider_response', 'error', /не удалось использовать/],
    [502, { code: 'error', reason: 'internal' }, 'internal_error', 'error', /Внутренняя ошибка сервера/],
    [502, { code: 'error' }, 'internal_error', 'error', /Внутренняя ошибка сервера/],
    [400, { code: 'invalid_request', error: 'Цель: обязательное поле.' }, 'invalid_request', 'error', /Запрос не принят: Цель: обязательное поле\./],
    [400, { error: 'Неверный формат запроса.' }, 'invalid_request', 'error', /Запрос не принят/],
    [403, { error: 'Недопустимый локальный запрос.' }, 'forbidden', 'error', /нелокальный/],
    [413, { error: 'Запрос слишком большой.' }, 'too_large', 'error', /слишком большой/],
    [500, undefined, 'server_error', 'unavailable', /Сервер вернул ошибку \(HTTP 500\) без пояснения/],
    [502, undefined, 'server_error', 'unavailable', /HTTP 502/],
    [404, undefined, 'unexpected_answer', 'error', /неожиданный ответ \(HTTP 404\)/],
    [418, { weird: true }, 'unexpected_answer', 'error', /HTTP 418/],
  ];
  for (const [http, body, cause, state, text] of cases) {
    const f = classifyGenerationResponse(http, body);
    assert.equal(f.cause, cause, JSON.stringify(body) + http); assert.equal(f.state, state, cause); assert.match(f.message, text, cause);
  }
});

test('G2. a request that got no answer is a network problem or a timeout, not a provider problem; a missing key is never inferred', () => {
  const net = classifyGenerationException(new TypeError('fetch failed'));
  assert.deepEqual([net.cause, net.state], ['network', 'unavailable']); assert.match(net.message, /Не удалось связаться с сервером/);
  const slow = classifyGenerationException(timeoutError());
  assert.deepEqual([slow.cause, slow.state], ['timeout', 'unavailable']);
  assert.equal(classifyGenerationException('string').cause, 'network');
  for (const f of [net, slow, classifyGenerationResponse(500, undefined), classifyGenerationResponse(502, { code: 'error' }), classifyGenerationResponse(403, undefined)]) assert.ok(!/OPENAI_API_KEY|не настроен/.test(f.message), f.message);
  const odd = classifyUnexpectedSuccess();
  assert.deepEqual([odd.cause, odd.state], ['unexpected_answer', 'error']);
});

test('G3. nothing sensitive reaches the screen: the server\'s own text is not echoed for provider failures, and nothing is composed from a key, a path or a stack', () => {
  const hostile = `ENOENT /Users/someone/.secret/config.json at Object.<anonymous> (file.js:1:1) ${SECRET}`;
  for (const body of [{ code: 'error', reason: 'internal', error: hostile }, { code: 'error', reason: 'auth', error: hostile }, { code: 'unavailable', reason: 'timeout', error: hostile }, { code: 'error', error: hostile, stack: hostile }, { code: 'not_configured', error: hostile }]) {
    const f = classifyGenerationResponse(502, body);
    for (const leak of [SECRET, '/Users', 'ENOENT', 'config.json', 'Object.<anonymous>', 'file.js']) assert.ok(!f.message.includes(leak), `${JSON.stringify(body)} leaks ${leak}`);
  }
  // only a rejected request shows the server's validation text, and it is cut
  assert.ok(classifyGenerationResponse(400, { code: 'invalid_request', error: 'я'.repeat(1000) }).message.length < 400);
  assert.ok(!/OPENAI_API_KEY=|Bearer|sk-/.test(describeProviderStatus({ kind: 'not_configured' })!));
});

test('G4. the body of an answer is read without mistaking an error page for a lost connection', async () => {
  assert.deepEqual(await readResponseBody(respond({ a: 1 })), { kind: 'json', value: { a: 1 } });
  assert.deepEqual(await readResponseBody(respond('<html>500</html>', 500, 'text/html')), { kind: 'invalid_json' });
  assert.deepEqual(await readResponseBody(respond('', 502)), { kind: 'invalid_json' });
  assert.deepEqual(await readResponseBody(respond('{"truncated": ', 200)), { kind: 'invalid_json' });
  const f = classifyGenerationResponse(500, undefined);
  assert.equal(f.cause, 'server_error'); assert.notEqual(f.cause, 'network');
});

// ---------- the server side: the cause travels with the code ----------

test('P1. the provider names the cause of every failure and never puts the key into a message', async () => {
  const provider = (fetcher: typeof fetch) => new OpenAIWriterProvider(fetcher, SECRET, 'm', 50);
  const failures: [string, typeof fetch, string, string][] = [
    ['timeout', async () => { throw timeoutError(); }, 'unavailable', 'timeout'],
    ['abort', async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }, 'unavailable', 'timeout'],
    ['network', async () => { throw new TypeError(`fetch failed ${SECRET}`); }, 'unavailable', 'network'],
    ['401', async () => respond({ error: { message: SECRET } }, 401), 'error', 'auth'],
    ['403', async () => respond({}, 403), 'error', 'auth'],
    ['429', async () => respond({}, 429), 'unavailable', 'rate_limit'],
    ['500', async () => respond({}, 500), 'unavailable', 'upstream'],
    ['503', async () => respond({}, 503), 'unavailable', 'upstream'],
    ['400', async () => respond({ error: SECRET }, 400), 'error', 'rejected'],
    ['not json', async () => respond('<html/>', 200, 'text/html'), 'error', 'bad_response'],
    ['broken json', async () => respond('{not json', 200), 'error', 'bad_response'],
    ['empty', async () => respond({ choices: [{ message: { content: '  ' } }] }), 'error', 'bad_response'],
    ['no choices', async () => respond({}), 'error', 'bad_response'],
  ];
  for (const [name, fetcher, kind, reason] of failures) {
    const err = await provider(fetcher).generate({ system: 's', user: 'u' }).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof WriterProviderError, name);
    assert.equal(err.kind, kind, name); assert.equal(err.reason, reason, name);
    assert.ok((WRITER_FAILURE_REASONS as readonly string[]).includes(err.reason!), name);
    assert.ok(!err.message.includes(SECRET), `${name}: the key must never be in a message`);
  }
  const notConfigured = await new OpenAIWriterProvider(async () => respond({}), undefined).generate({ system: 's', user: 'u' }).then(() => null, (e: unknown) => e);
  assert.ok(notConfigured instanceof WriterProviderError);
  assert.equal(notConfigured.kind, 'not_configured'); assert.equal(notConfigured.reason, undefined);
  const real = await unconfiguredWriterProvider.generate({ system: 's', user: 'u' }).then(() => null, (e: unknown) => e);
  assert.ok(real instanceof WriterProviderError && real.reason === undefined);
});

test('P2. the route answer carries `reason` next to `code`, and the screen turns every provider failure into the right message end to end', async () => {
  const run = async (generate: WriterProvider['generate'], configured = true) => handleGenerate(validBody, stub(generate, configured));
  const kinds: [string, WriterProviderError, string, string][] = [
    ['timeout', new WriterProviderError('x', 'unavailable', 'timeout'), 'unavailable', 'provider_timeout'],
    ['network', new WriterProviderError('x', 'unavailable', 'network'), 'unavailable', 'provider_network'],
    ['rate', new WriterProviderError('x', 'unavailable', 'rate_limit'), 'unavailable', 'rate_limit'],
    ['upstream', new WriterProviderError('x', 'unavailable', 'upstream'), 'unavailable', 'provider_unavailable'],
    ['auth', new WriterProviderError('x', 'error', 'auth'), 'error', 'provider_auth'],
    ['rejected', new WriterProviderError('x', 'error', 'rejected'), 'error', 'provider_rejected'],
    ['bad', new WriterProviderError('x', 'error', 'bad_response'), 'error', 'bad_provider_response'],
  ];
  for (const [name, error, state, cause] of kinds) {
    const { status: http, body } = await run(async () => { throw error; });
    assert.equal(http, 502, name); assert.equal(body.reason, error.reason, name); assert.equal(body.code, error.kind, name);
    const f = classifyGenerationResponse(http, body);
    assert.equal(f.cause, cause, name); assert.equal(f.state, state, name);
  }
  // a provider that is not configured: 503 + not_configured, no reason, and the screen states it as a fact reported by the server
  const nc = await run(async () => { throw new WriterProviderError('x', 'not_configured'); }, false);
  assert.equal(nc.status, 503); assert.equal(nc.body.code, 'not_configured'); assert.ok(!('reason' in nc.body));
  assert.equal(classifyGenerationResponse(nc.status, nc.body).state, 'not_configured');
  // an unexpected exception: neutral message, reason `internal`, nothing of the exception is sent
  const realError = console.error; console.error = () => undefined;                                  // the server logs the detail; the test does not need to print it
  const internal = await run(async () => { throw new Error(`boom ${SECRET} /Users/x`); });
  console.error = realError;
  assert.equal(internal.status, 502); assert.equal(internal.body.code, 'error'); assert.equal(internal.body.reason, 'internal');
  assert.ok(!JSON.stringify(internal.body).includes(SECRET) && !JSON.stringify(internal.body).includes('/Users'));
  assert.equal(classifyGenerationResponse(internal.status, internal.body).cause, 'internal_error');
  // a validation failure is not a provider failure
  const invalid = await handleGenerate({ ...validBody, mode: 'nope' }, stub(async () => ({ text: 'x' })));
  assert.equal(invalid.status, 400);
  assert.equal(classifyGenerationResponse(invalid.status, invalid.body).cause, 'invalid_request');
  // success is unchanged
  const ok = await run(async () => ({ text: 'Abstract.' }));
  assert.equal(ok.status, 200); assert.notEqual(parseGenerationBody(JSON.parse(JSON.stringify(ok.body))), null);
});

// ---------- the screen ----------

test('U1. the screen no longer turns every failure into "not configured"', () => {
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.ok(!/setProviderConfigured/.test(component));
  assert.ok(!/\.catch\(\(\) => setProviderConfigured\(false\)\)/.test(component));
  assert.ok(!/ИИ-провайдер не настроен \(нет OPENAI_API_KEY\)/.test(component));
  assert.ok(!/временно недоступен \(сеть, тайм-аут или ограничение запросов\)/.test(component));
  assert.match(component, /checkProviderStatus\(\)\.then\(setProviderStatus\)/);
  assert.match(component, /describeProviderStatus\(providerStatus\)/);
  assert.match(component, /providerStatus\.kind === 'check_failed' && <button[^>]*onClick=\{runStatusCheck\}>Проверить снова/);   // an explicit re-check, no automatic loop
  assert.ok(!/setInterval|setTimeout\(runStatusCheck, [1-9]/.test(component));
  assert.match(component, /classifyGenerationException\(error\)/); assert.match(component, /classifyGenerationResponse\(response\.status, body\)/);
  assert.match(component, /readResponseBody\(response\)/);
  assert.ok(!/const body = await response\.json\(\);/.test(component), 'an error page must not be read as JSON inside a catch that says "no connection"');
  assert.match(component, /parseGenerationBody\(body\)/);
  // the texts the screen shows for the three states come from the classified message, not from a fixed guess
  assert.match(component, /<p role="alert">\{errorMessage\}<\/p>/);
  assert.match(component, /\{errorMessage\} \{result \?/);
  // the generation, translation, validation, drafts, bibliography and export code paths are untouched
  for (const kept of ['buildEvidenceReport(input)', 'buildLocalScaffold(input, evidence)', 'applyGenerationOutcome(', 'exportDocument', 'saveReferences(references)']) assert.ok(component.includes(kept), kept);
});


// ======================= P1-03 audit corrections F1-F3 =======================

const realAnswer = async (over: Record<string, unknown> = {}, mode = 'draft'): Promise<Record<string, unknown>> => {
  const body = mode === 'draft' ? validBody : { documentType: 'article', mode, targetLanguage: 'en', sourceText: 'The PVD coating thickness was 350 nm.' };
  const { status: http, body: answer } = await handleGenerate(body, stub(async () => ({ text: 'Abstract: coatings were studied. Thickness 12 nm.' })));
  assert.equal(http, 200);
  return JSON.parse(JSON.stringify({ ...answer, ...over }));                 // exactly as it comes through HTTP
};

test('F1-a. a correct answer of the existing API is accepted as it is, in every mode', async () => {
  for (const mode of ['draft', 'rewrite', 'edit', 'translate_ru_en']) {
    const answer = await realAnswer({}, mode);
    const parsed = parseGenerationBody(answer);
    assert.notEqual(parsed, null, mode);
    assert.equal(parsed!.generatedText, answer.generatedText);
    assert.deepEqual(parsed!.evidence, answer.evidence);
    assert.deepEqual(parsed!.preservation, answer.preservation);
    assert.deepEqual(parsed!.changes, answer.changes);
    assert.deepEqual(parsed!.warnings, answer.warnings);
    assert.ok(!('providerId' in parsed!));                                      // only what the screen uses is taken
  }
  const rewrite = await realAnswer({}, 'rewrite');
  assert.notEqual(rewrite.preservation, null); assert.ok(Array.isArray(rewrite.changes));           // the structures with content are accepted too
  const draft = await realAnswer();
  assert.equal(draft.preservation, null); assert.equal(draft.changes, null);                         // and null where the API sends null
  assert.notEqual(parseGenerationBody(draft), null);
  const parsed = parseGenerationBody(draft)!;
  assert.notEqual(parsed, draft as unknown);                                                         // a copy: the answer object itself is not kept
  (draft.warnings as unknown[]).push(5);
  assert.deepEqual(parsed.warnings, (await realAnswer()).warnings);
});

test('F1-b. a damaged successful answer is refused as a whole: evidence, lists, item types, warnings, missing fields', async () => {
  const good = await realAnswer();
  const evidence = good.evidence as { fields: Record<string, unknown>[]; provided: unknown[]; missing: unknown[] };
  const bad: [string, Record<string, unknown>][] = [
    ['evidence is an empty object', { evidence: {} }],
    ['evidence is a string', { evidence: 'ok' }], ['evidence is null', { evidence: null }], ['evidence is an array', { evidence: [] }],
    ['evidence.provided is not an array', { evidence: { ...evidence, provided: 'title' } }],
    ['evidence.provided is missing', { evidence: { fields: evidence.fields, missing: evidence.missing } }],
    ['evidence.missing is not an array', { evidence: { ...evidence, missing: { 0: 'x' } } }],
    ['evidence.missing is missing', { evidence: { fields: evidence.fields, provided: evidence.provided } }],
    ['evidence.provided items are numbers', { evidence: { ...evidence, provided: [1, 2] } }],
    ['evidence.missing items are objects', { evidence: { ...evidence, missing: [{}] } }],
    ['evidence.fields is missing', { evidence: { provided: evidence.provided, missing: evidence.missing } }],
    ['evidence.fields is not an array', { evidence: { ...evidence, fields: 'x' } }],
    ['an evidence field of a wrong shape', { evidence: { ...evidence, fields: [{ key: 'title' }] } }],
    ['an evidence field with an unknown key', { evidence: { ...evidence, fields: [{ ...evidence.fields[0], key: 'secret' }] } }],
    ['warnings is a string', { warnings: 'проверьте' }], ['warnings is an object', { warnings: {} }], ['warnings is null', { warnings: null }], ['warnings is missing', { warnings: undefined }],
    ['warnings items are numbers', { warnings: [1] }], ['warnings items are null', { warnings: [null] }], ['warnings mixed', { warnings: ['ok', 5] }],
    ['generatedText is missing', { generatedText: undefined }], ['generatedText is a number', { generatedText: 5 }], ['generatedText is empty', { generatedText: '' }], ['generatedText is blank', { generatedText: '   ' }],
    ['preservation is missing', { preservation: undefined }], ['preservation is a string', { preservation: 'ok' }], ['preservation without ok', { preservation: { preservedNumbers: [], missingNumbers: [], preservedTerms: [], missingTerms: [] } }],
    ['preservation lists of numbers', { preservation: { ok: true, preservedNumbers: [1], missingNumbers: [], preservedTerms: [], missingTerms: [] } }],
    ['changes is missing', { changes: undefined }], ['changes is a string', { changes: 'x' }], ['changes items are numbers', { changes: [1] }],
  ];
  for (const [name, over] of bad) {
    const answer = { ...good, ...over };
    assert.equal(parseGenerationBody(JSON.parse(JSON.stringify(answer))), null, name);
  }
  for (const nonObject of [null, undefined, 5, 'text', [], true]) assert.equal(parseGenerationBody(nonObject), null, String(nonObject));
  assert.equal(parseGenerationBody({}), null);
  // the damaged answer is not "partially" used: nothing at all comes out
  assert.equal(parseGenerationBody({ ...good, warnings: ['ok', 5] }), null);
});

test('F1-c. success -> a damaged answer -> the previous result, its structure, evidence and form snapshot stay available; a late answer is still ignored', async () => {
  const first = parseGenerationBody(await realAnswer())!;
  const form = { ...defaultDraftForm(), title: 'T', goal: 'G' };
  const scaffold = [{ heading: 'Введение', text: 'x', usedFields: ['goal'] }];
  const before: GenerationView = { scaffold, evidencePreview: first.evidence, result: first, generatedFrom: JSON.stringify(form) };
  // the second request gets HTTP 200 with a damaged body
  const damaged = await realAnswer({ evidence: {}, warnings: 'x' });
  assert.equal(parseGenerationBody(damaged), null);
  const failure = classifyUnexpectedSuccess();
  assert.equal(failure.state, 'error'); assert.match(failure.message, /неожиданного формата/);
  const after = applyGenerationOutcome(before, { kind: 'failure', scaffold: [], evidencePreview: null, snapshot: JSON.stringify({ ...form, goal: 'changed' }) });
  assert.equal(after, before);                                                                      // the very same view: nothing replaced
  assert.equal(after.result?.generatedText, first.generatedText); assert.deepEqual(after.scaffold, scaffold); assert.equal(after.generatedFrom, JSON.stringify(form));
  // the late-answer protection is as before: only the latest request may apply its answer
  const guard = createGenerationGuard();
  const older = guard.begin(); const newer = guard.begin();
  assert.equal(guard.isCurrent(older), false); assert.equal(guard.isCurrent(newer), true);
  // and the component: parse BEFORE anything is applied; no field of the body is read outside the checked copy
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  const generate = component.slice(component.indexOf('async function generate('), component.indexOf('async function start('));
  assert.ok(generate.indexOf('parseGenerationBody(body)') < generate.indexOf("applyOutcome({ kind: 'success'"));
  assert.ok(generate.indexOf('isCurrent(token)') < generate.indexOf('parseGenerationBody(body)'));
  assert.ok(!/body\.(generatedText|evidence|preservation|changes|warnings)/.test(generate), 'the answer is used only through the checked copy');
  assert.ok(!/ as GenerationResult/.test(generate));
});

test('F2-a. reading the body: invalid JSON, a timeout, a dropped connection, an abort and any other transport error are five different things', async () => {
  const broken = (error: unknown, http = 200): Response => { const r = new Response('x', { status: http }); Object.defineProperty(r, 'text', { value: async () => { throw error; } }); return r; };
  const drop = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });
  assert.deepEqual(await readResponseBody(broken(timeoutError())), { kind: 'read_failed', failure: 'timeout' });
  assert.deepEqual(await readResponseBody(broken(Object.assign(new Error('x'), { name: 'AbortError' }))), { kind: 'read_failed', failure: 'aborted' });
  assert.deepEqual(await readResponseBody(broken(drop)), { kind: 'read_failed', failure: 'connection_lost' });
  assert.deepEqual(await readResponseBody(broken(new TypeError('network error'))), { kind: 'read_failed', failure: 'connection_lost' });
  assert.deepEqual(await readResponseBody(broken(Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }))), { kind: 'read_failed', failure: 'connection_lost' });
  assert.deepEqual(await readResponseBody(broken(new Error('something else'))), { kind: 'read_failed', failure: 'transport' });
  assert.deepEqual(await readResponseBody(broken('a string was thrown')), { kind: 'read_failed', failure: 'transport' });
  assert.deepEqual(await readResponseBody(respond('{"a":', 200)), { kind: 'invalid_json' });                // only a real syntax problem is "invalid JSON"
  for (const [error, expected] of [[timeoutError(), 'timeout'], [new TypeError('x'), 'connection_lost'], [new Error('y'), 'transport']] as const) assert.equal(classifyTransportFailure(error), expected);
});

test('F2-b. the status check: HTTP 200 followed by an exception while reading the body keeps its true cause; a really broken JSON stays "bad_response"', async () => {
  const brokenBody = (error: unknown): typeof fetch => async () => { const r = new Response('x', { status: 200, headers: { 'Content-Type': 'application/json' } }); Object.defineProperty(r, 'text', { value: async () => { throw error; } }); return r; };
  assert.deepEqual(await status(brokenBody(timeoutError())), { kind: 'check_failed', reason: 'timeout' });
  assert.deepEqual(await status(brokenBody(Object.assign(new Error('x'), { name: 'AbortError' }))), { kind: 'check_failed', reason: 'aborted' });
  assert.deepEqual(await status(brokenBody(new TypeError('terminated'))), { kind: 'check_failed', reason: 'connection_lost' });
  assert.deepEqual(await status(brokenBody(new Error('other'))), { kind: 'check_failed', reason: 'network' });
  assert.deepEqual(await status(async () => respond('{"configured": tru', 200)), { kind: 'check_failed', reason: 'bad_response' });
  assert.deepEqual(await status(async () => respond('', 200)), { kind: 'check_failed', reason: 'bad_response' });
  for (const [reason, text] of [['timeout', /не ответил вовремя/], ['aborted', /прервана/], ['connection_lost', /оборвалось/], ['bad_response', /не удалось распознать/]] as const) {
    const message = describeProviderStatus({ kind: 'check_failed', reason })!;
    assert.match(message, text, reason); assert.ok(!/OPENAI_API_KEY|TimeoutError|terminated|Error:/.test(message), reason);
  }
  // fetch itself failing is still told apart
  assert.deepEqual(await status(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }), { kind: 'check_failed', reason: 'aborted' });
  assert.deepEqual(await status(async () => { throw timeoutError(); }), { kind: 'check_failed', reason: 'timeout' });
});

test('F2-c. generation: a timeout, a dropped connection, an abort or a transport error while the body is read give their own message and are retryable; they are not "bad answer" or "invalid JSON"', () => {
  const cases: [Parameters<typeof classifyBodyReadFailure>[0], string, RegExp][] = [
    ['timeout', 'timeout', /не ответил вовремя/], ['aborted', 'aborted', /прерван/], ['connection_lost', 'connection_lost', /оборвалось во время получения ответа/], ['transport', 'transport', /Ошибка при получении ответа/],
  ];
  for (const [failure, cause, text] of cases) {
    const f = classifyBodyReadFailure(failure);
    assert.equal(f.cause, cause); assert.equal(f.state, 'unavailable'); assert.match(f.message, text);
    assert.ok(!/неожиданного формата|JSON|OPENAI_API_KEY|не настроен/.test(f.message), failure);
  }
  assert.equal(classifyGenerationException(Object.assign(new Error('x'), { name: 'AbortError' })).cause, 'aborted');
  assert.equal(classifyGenerationException(timeoutError()).cause, 'timeout');
  assert.equal(classifyGenerationException(new TypeError('fetch failed')).cause, 'network');
  // a valid HTTP answer with a really broken JSON is still "not what was expected"
  assert.equal(classifyUnexpectedSuccess().cause, 'unexpected_answer');
  // the component handles the five cases through these functions
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.match(component, /read\.kind === 'read_failed'\) \{ fail\(classifyBodyReadFailure\(read\.failure\)\)/);
  assert.ok(!/response\.json\(\)/.test(component.slice(component.indexOf('async function generate('), component.indexOf('async function start('))));
});

test('F3. the text of a rejected request is shown only if it is one of the known validation messages; anything else is replaced by a fixed sentence', () => {
  // every real message of the Writer API's validation is accepted and useful to the user
  const known = [
    'Цель: слишком длинный текст (максимум 20000 символов).', 'Название/тема: слишком длинный текст (максимум 500 символов).', 'Название/тема: текст слишком длинный (максимум 500 символов).',
    'Исходный текст: для этого режима обязателен.', 'Суммарный объём введённого текста слишком велик (максимум 60000 символов).',
    'Заполните хотя бы одно поле (тема, цель, объект, методы, результаты или выводы) для создания черновика.',
    'Тип документа: недопустимое значение. Допустимо: article, conference_abstract, annotation.', 'Режим работы: недопустимое значение.', 'Целевой язык: обязательное поле.', 'Методы: ожидается строка.',
    'Неверный формат запроса.', 'Неверный формат запроса (ожидался JSON).', 'Пустое тело запроса.',
  ];
  for (const text of known) assert.equal(safeValidationMessage(text), `Запрос не принят: ${text}`, text);
  const generic = 'Запрос не принят: проверьте введённые данные.';
  const hostile = [
    'ENOENT: no such file or directory, open \'/Users/someone/.secret/config.json\'', 'C:\\Users\\x\\secret.txt', 'Error: boom\n    at Object.<anonymous> (/app/server.js:10:5)', '<html><body>500 Internal Server Error</body></html>',
    '<script>alert(1)</script>', `Цель: слишком длинный текст (максимум 20000 символов). ${SECRET}`, SECRET, `Bearer ${SECRET}`, 'Цель: слишком длинный текст (максимум 20000 символов).\n    at validate (/srv/x.js:1:1)',
    'Цель: слишком длинный текст (максимум 20000 символов).<img src=x>', 'Цель: слишком длинный текст (максимум 99999999 символов).', 'Секрет: слишком длинный текст (максимум 5 символов).', 'х'.repeat(5000),
    'Цель: недопустимое значение. Допустимо: /etc/passwd.', 'Тип документа: недопустимое значение. Допустимо: a, ../../b.', '', '   ',
  ];
  for (const text of hostile) assert.equal(safeValidationMessage(text), generic, JSON.stringify(text).slice(0, 60));
  for (const notText of [undefined, null, 5, {}, [], true]) assert.equal(safeValidationMessage(notText), generic);
  // through the classification: HTTP 400 with and without a code, and a provider "rejected" failure
  for (const text of hostile) {
    for (const f of [classifyGenerationResponse(400, { code: 'invalid_request', error: text }), classifyGenerationResponse(400, { error: text })]) {
      assert.equal(f.cause, 'invalid_request'); assert.equal(f.message, generic);
      for (const leak of [SECRET, '/Users', 'ENOENT', '<html', '<script', 'at Object', 'server.js', 'passwd']) assert.ok(!f.message.includes(leak), leak);
    }
  }
  const rejected = classifyGenerationResponse(502, { code: 'error', reason: 'rejected', error: `OpenAI said ${SECRET} /Users/x <html>` });
  assert.equal(rejected.cause, 'provider_rejected'); assert.ok(!/OpenAI said|Users|html/.test(rejected.message) && !rejected.message.includes(SECRET));
  assert.equal(classifyGenerationResponse(400, { code: 'invalid_request', error: known[0] }).message, `Запрос не принят: ${known[0]}`);
  // the real validation still rejects, with a message the screen can show
  assert.ok(true);
});

test('F3-b. the real API rejections reach the user as useful, safe messages', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...validBody, goal: 'я'.repeat(20_001) }, /Запрос не принят: Цель: текст слишком длинный \(максимум 20000 символов\)\./],
    [{ documentType: 'article', mode: 'rewrite', targetLanguage: 'en' }, /Запрос не принят: Исходный текст: для этого режима обязателен\./],
    [{ documentType: 'article', mode: 'draft', targetLanguage: 'en' }, /Запрос не принят: Заполните хотя бы одно поле/],
    [{ ...validBody, documentType: 'bogus' }, /Запрос не принят: Тип документа: недопустимое значение\. Допустимо: /],
    [{ ...validBody, mode: 'nope' }, /Запрос не принят: Режим работы: недопустимое значение\./],
    [{ ...validBody, title: 5 }, /Запрос не принят: Название\/тема: ожидается строка\./],
    [{ ...validBody, title: 'т'.repeat(501) }, /Запрос не принят: Название\/тема: текст слишком длинный/],
  ];
  for (const [body, expected] of cases) {
    const { status: http, body: answer } = await handleGenerate(body, stub(async () => ({ text: 'x' })));
    assert.equal(http, 400);
    const f = classifyGenerationResponse(http, JSON.parse(JSON.stringify(answer)));
    assert.equal(f.cause, 'invalid_request'); assert.match(f.message, expected);
  }
});
