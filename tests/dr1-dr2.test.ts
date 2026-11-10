import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { runTextIndex } from '../src/services/library-text';
import { retrieveChunks, extractSearchTerms } from '../src/services/rag/retrieve';
import { askLibrary } from '../src/services/rag/service';
import { OpenAIAnswerProvider } from '../src/services/rag/providers/openai';
import { SYSTEM_PROMPT, buildUserTurn, UNVERIFIED_CLAIMS_WARNING } from '../src/services/rag/prompt';
import { resetAiGuardForTests } from '../src/services/ai-guard';

const DOCS = [
  'Sample PT-AI-RAG-01. A TiN coating was deposited using DC magnetron sputtering. The working pressure was 0.4 Pa, the magnetron power was 500 W, and the substrate temperature was 200 °C. The coating thickness was 1.2 µm. No hardness measurements were performed.',
  'Sample PT-AI-RAG-02. A TiN coating was deposited using DC magnetron sputtering. The working pressure was 0.3 Pa and the coating thickness was 1.0 µm.',
  'Sample PT-AI-RAG-03. A TiN coating was deposited using DC magnetron sputtering at 0.5 Pa. The hardness measured by nanoindentation was 24 GPa.',
  'Образец ПТ-ИИ-RAG-04. Покрытие TiN осаждали методом магнетронного распыления постоянного тока. Давление 0,4 Па, мощность 500 Вт. Твёрдость не измеряли.',
  'Thermal conductivity of single crystal silicon carbide SiC is about 370 W/(m K) at room temperature.',
];
interface Fx { textStore: TextStore; textFile: string }
async function fixture(fn: (fx: Fx) => Promise<void>, docs: string[] = DOCS): Promise<void> {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dr-test-')));
  const root = path.join(temp, 'pdfs'); await mkdir(root);
  const textFile = path.join(temp, 'text', 'index.sqlite'); const textStore = new TextStore(textFile, 'test');
  try {
    for (let i = 0; i < docs.length; i++) await writeFile(path.join(root, `d${i}.pdf`), `d${i}`);
    let n = 0;
    await runTextIndex({ root, indexFile: path.join(temp, 'metadata.json'), store: textStore, extract: async () => ({ pageCount: 1, pages: [{ page: 1, text: docs[n++ % docs.length] }] }) });
    await fn({ textStore, textFile });
  } finally { textStore.close(); await rm(temp, { recursive: true, force: true }); }
}
const filesFor = (fx: Fx, q: string): string[] => retrieveChunks(fx.textStore, q, 8).chunks.map(c => c.text.slice(0, 40));
const found = (fx: Fx, q: string, marker: string): boolean => retrieveChunks(fx.textStore, q, 8).chunks.some(c => c.text.includes(marker));

// ---------- D-R1 ----------
test('D-R1: the reproduced question - generic words absent from the corpus no longer crowd out the terms that exist', () => fixture(async fx => {
  const q = 'What deposition method and process parameters were used for sample PT-AI-RAG-01? Was its hardness measured?';
  assert.deepEqual(extractSearchTerms(q), ['deposition', 'method', 'process', 'parameters', 'sample', 'PT-AI-RAG-01', 'hardness', 'measured'], 'stop words (what/were/used/was/its) are still removed; sample id and technical words kept');
  assert.ok(found(fx, q, 'No hardness measurements were performed'), 'PT-AI-RAG-01 is found with the question exactly as written');
}));

test('D-R1: what / how / was / were / used / measured phrasings find the document', () => fixture(async fx => {
  for (const q of [
    'How was the hardness measured?', 'What were the working pressure and the magnetron power?', 'Which process parameters were used for sample PT-AI-RAG-01?',
    'Were hardness measurements performed for PT-AI-RAG-01?', 'sample PT-AI-RAG-01 deposition method pressure power temperature thickness hardness measured', 'PT-AI-RAG-01',
  ]) assert.ok(retrieveChunks(fx.textStore, q, 8).chunks.length >= 1, q);
  assert.ok(found(fx, 'Which process parameters were used for sample PT-AI-RAG-01?', 'PT-AI-RAG-01'));
}));

test('D-R1: stated limit - lexical search cannot match words that occur nowhere in the corpus ("method", "deposition" when the text says "deposited by sputtering"); it returns nothing rather than guessing', () => fixture(async fx => {
  assert.equal(retrieveChunks(fx.textStore, 'What deposition method was used?', 8).chunks.length, 0);
}));

test('D-R1: scientific terms, sample ids, formulas and numbers are kept in the terms', () => {
  const terms = extractSearchTerms('Was the TiN coating (sample PT-AI-RAG-01, Al2O3 layer, 0.4 Pa, 500 W, 1.2 µm) deposited by DC magnetron sputtering?');
  for (const kept of ['TiN', 'PT-AI-RAG-01', 'Al2O3', 'magnetron', 'sputtering']) assert.ok(terms.includes(kept), kept);
  for (const gone of ['was', 'the', 'by']) assert.ok(!terms.includes(gone), gone);
});

test('D-R1: Russian questions still work (stop words removed, document found by what exists)', () => fixture(async fx => {
  const q = 'Какой метод осаждения и параметры процесса использовались для образца ПТ-ИИ-RAG-04? Измерялась ли твёрдость?';
  assert.ok(found(fx, q, 'Твёрдость не измеряли'), 'Russian composite question');
  assert.ok(found(fx, 'магнетронное распыление постоянного тока давление мощность', 'ПТ-ИИ-RAG-04'), 'Russian keywords');
}));

test('D-R1: a question with no suitable source still returns nothing, FTS syntax characters are harmless, and the strict AND path is unchanged', () => fixture(async fx => {
  assert.equal(retrieveChunks(fx.textStore, 'Which polymer membrane was used for desalination?', 8).chunks.length, 0);
  for (const q of ['"unbalanced quote', 'AND OR NOT (', "sample' OR 1=1 --", 'PT-AI-RAG-01 * NEAR/2']) assert.doesNotThrow(() => retrieveChunks(fx.textStore, q, 8), q);
  const strict = retrieveChunks(fx.textStore, 'DC magnetron sputtering TiN coating', 8).chunks;
  assert.ok(strict.length >= 3, 'ordinary technical query still finds the TiN samples');
  assert.ok(filesFor(fx, 'thermal conductivity silicon carbide').some(t => t.includes('Thermal conductivity')));
}));

// ---------- D-R2: what the model is actually given (real provider, local fetch mock - no network, dummy key) ----------
async function askWithCapturedPrompt(fx: Fx, question: string, answerClaims: unknown): Promise<{ system: string; user: string; result: Awaited<ReturnType<typeof askLibrary>> }> {
  resetAiGuardForTests();
  let captured: { messages: { role: string; content: string }[] } | null = null;
  const fetcher = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: answerClaims }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const provider = new OpenAIAnswerProvider(fetcher, 'dummy-key-never-used-on-a-network', 'gpt-4o-mini');
  const result = await askLibrary({ question, mode: 'lexical', limit: 8 }, { openStore: async () => new TextStore(fx.textFile, 'test'), provider, embeddingProvider: null });
  assert.ok(captured, 'the provider was called through the injected local fetcher only');
  const messages = (captured as { messages: { role: string; content: string }[] }).messages;
  return { system: messages.find(m => m.role === 'system')!.content, user: messages.find(m => m.role === 'user')!.content, result };
}

test('D-R2: the system prompt tells the model to answer every part, to cite what it examined, and not to turn silence into "not done"', () => {
  assert.match(SYSTEM_PROMPT, /several parts/); assert.match(SYSTEM_PROMPT, /answer EVERY part/);
  assert.match(SYSTEM_PROMPT, /does not answer/);
  assert.match(SYSTEM_PROMPT, /do not contain that information/); assert.match(SYSTEM_PROMPT, /cite the index of the element you examined/);
  assert.match(SYSTEM_PROMPT, /ONLY if an element literally says so/); assert.match(SYSTEM_PROMPT, /absence of a mention is not evidence that it was not done/);
  // the earlier rules are untouched: JSON shape, no outside knowledge, no invented values, injection resistance, the exact insufficient-data sentence
  for (const kept of ['Never use outside knowledge', 'never invent numbers', 'citationIds', 'untrusted content', 'USER:']) assert.ok(SYSTEM_PROMPT.replace(/\s+/g, ' ').includes(kept) || SYSTEM_PROMPT.includes(kept), kept);
});

test('D-R2: the compound question and the direct negation both reach the model; a grounded two-part answer keeps its citations and the warning stays', () => fixture(async fx => {
  const q = 'What deposition method and process parameters were used for sample PT-AI-RAG-01? Was its hardness measured?';
  const { system, user, result } = await askWithCapturedPrompt(fx, q, [
    { text: 'A TiN coating was deposited by DC magnetron sputtering at 0.4 Pa, 500 W and 200 °C; the thickness was 1.2 µm.', citationIds: [1] },
    { text: 'No hardness measurements were performed.', citationIds: [1] },
  ]);
  assert.ok(system.includes('answer EVERY part'));
  assert.ok(user.startsWith('USER QUESTION:\n' + q), 'the whole compound question, unchanged');
  assert.ok(user.includes('No hardness measurements were performed'), 'the sentence that answers the second part is in the data given to the model');
  assert.equal(user, buildUserTurn(q, { block: user.slice(user.indexOf('\n\n') + 2), citations: [], truncated: false }));
  assert.equal(result.status, 'answered');
  assert.equal(result.answer.claims.length, 2);
  assert.ok(result.answer.claims.every(c => c.citationIds.length === 1 && c.citationIds[0] === 1));
  assert.ok(result.citations.length >= 1 && result.citations[0].filename.length > 0, 'citations and their documents are kept');
  assert.ok(UNVERIFIED_CLAIMS_WARNING.includes('автоматически не проверено'), 'the unverified-claims warning text exists and is shown by the UI');
}));

test('D-R2: document that does not mention the measurement - its own element given to the model contains no negation and no hardness statement', () => fixture(async fx => {
  const { user } = await askWithCapturedPrompt(fx, 'What was the working pressure and was hardness measured for sample PT-AI-RAG-02?', [{ text: 'The working pressure was 0.3 Pa.', citationIds: [1] }, { text: 'The retrieved source does not report whether hardness was measured.', citationIds: [1] }]);
  const entries = JSON.parse(user.slice(user.indexOf('\n[') + 1)) as { index: number; content: string }[];
  const own = entries.find(e => e.content.includes('PT-AI-RAG-02'));
  assert.ok(own, 'the sample the question is about is in the data');
  assert.ok(!/hardness/i.test(own!.content), 'nothing about hardness is invented into that element');
  assert.ok(entries.every(e => Number.isInteger(e.index)), 'every element keeps its citable index');
}));

test('D-R2: positive measurement and the Russian variant are passed through unchanged', () => fixture(async fx => {
  const pos = await askWithCapturedPrompt(fx, 'What was the hardness of sample PT-AI-RAG-03 and how was it measured?', [{ text: 'The hardness measured by nanoindentation was 24 GPa.', citationIds: [1] }]);
  assert.ok(pos.user.includes('nanoindentation was 24 GPa'));
  const ru = await askWithCapturedPrompt(fx, 'Какой метод осаждения и параметры процесса использовались для образца ПТ-ИИ-RAG-04? Измерялась ли твёрдость?', [{ text: 'Покрытие осаждали магнетронным распылением постоянного тока.', citationIds: [1] }, { text: 'Твёрдость не измеряли.', citationIds: [1] }]);
  assert.ok(ru.user.includes('Твёрдость не измеряли')); assert.equal(ru.result.status, 'answered');
}));

test('D-R2: a question with no source never reaches the model at all (nothing to answer from, no call)', () => fixture(async fx => {
  resetAiGuardForTests();
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('must not be called'); }) as unknown as typeof fetch;
  const result = await askLibrary({ question: 'Which polymer membrane was used for desalination?', mode: 'lexical', limit: 8 }, { openStore: async () => new TextStore(fx.textFile, 'test'), provider: new OpenAIAnswerProvider(fetcher, 'dummy', 'gpt-4o-mini'), embeddingProvider: null });
  assert.equal(result.status, 'insufficient_evidence'); assert.equal(calls, 0);
}));
