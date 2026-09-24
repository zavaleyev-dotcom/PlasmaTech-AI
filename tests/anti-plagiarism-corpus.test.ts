import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TextStore } from '../src/services/library-text/store';
import { checkSimilarity } from '../src/services/workspace/anti-plagiarism-corpus';
import type { TextDocument, TextChunk } from '../src/services/library-text/types';

function fakeDoc(id: string, overrides: Partial<TextDocument> = {}): TextDocument {
  return {
    id, relativePath: `${id}.pdf`, filename: `${id}.pdf`, title: `Document ${id}`, doi: null, authors: ['Test Author'],
    year: 2024, sourceFolder: 'root', text: '', pageCount: 1, characterCount: 0, wordCount: 0, status: 'success',
    error: null, extractedAt: new Date().toISOString(), modifiedDate: new Date().toISOString(), fileSize: 100, hash: null, version: 1,
    ...overrides,
  };
}

function fakeChunk(documentId: string, ordinal: number, text: string): TextChunk {
  return { id: `${documentId}:${ordinal}`, documentId, ordinal, pageStart: 1, pageEnd: 1, text, wordCount: text.split(/\s+/).length };
}

async function withFixtureStore(seed: (store: TextStore) => void, run: (store: () => Promise<TextStore>) => Promise<void>) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anti-plagiarism-test-')));
  const dbFile = path.join(temp, 'index.sqlite');
  try {
    const seedStore = new TextStore(dbFile, 'test');
    seed(seedStore);
    seedStore.close();
    let opened: TextStore | null = null;
    await run(async () => { opened = new TextStore(dbFile, 'test'); return opened; });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const SOURCE_TEXT_EN = 'The magnetron deposition of AlTiN coating on high-speed steel substrate was performed at a temperature of four hundred degrees Celsius for sixty minutes, producing a coating thickness of two point five micrometers with excellent adhesion properties measured by scratch testing methods.';
const SOURCE_TEXT_RU = 'Магнетронное осаждение покрытия AlTiN на подложку из быстрорежущей стали проводилось при температуре четыреста градусов Цельсия в течение шестидесяти минут, что обеспечило толщину покрытия два и пять микрометра с отличной адгезией по результатам испытаний на царапание.';

// ---------- exact match ----------

test('checkSimilarity: an exact copy of a corpus sentence is classified "exact" with correct source attribution', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en', { title: 'AlTiN Coating Study' }), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const report = await checkSimilarity(`Introduction text here. ${SOURCE_TEXT_EN} Conclusion text here.`, { openStore });
      const exact = report.matches.find(m => m.type === 'exact');
      assert.ok(exact, 'expected an exact match');
      assert.equal(exact!.documentId, 'doc-en');
      assert.equal(exact!.documentTitle, 'AlTiN Coating Study');
      assert.equal(exact!.relativePath, 'doc-en.pdf');
      assert.equal(report.scope.exactMatches, 1);
      assert.ok(report.scope.chunksChecked >= 1);
      assert.ok(report.scope.documentsChecked >= 1);
    },
  );
});

// ---------- near-exact match ----------

test('checkSimilarity: a lightly-edited copy (one word changed near the end) is classified "near_exact"', async () => {
  const nearEdit = SOURCE_TEXT_EN.replace('scratch testing methods', 'indentation testing methods');
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const report = await checkSimilarity(nearEdit, { openStore });
      assert.ok(report.matches.some(m => m.type === 'near_exact'));
      assert.equal(report.scope.nearExactMatches, 1);
    },
  );
});

// ---------- paraphrased / low-match case ----------

test('checkSimilarity: a genuinely paraphrased, differently-worded passage does not trigger a match', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const paraphrase = 'Researchers investigated how various process parameters influence the mechanical properties of thin films deposited using physical vapor techniques on metallic substrates over the past decade.';
      const report = await checkSimilarity(paraphrase, { openStore });
      assert.equal(report.matches.filter(m => m.type !== 'self_repeat').length, 0);
    },
  );
});

// ---------- no match ----------

test('checkSimilarity: text with no relation to the corpus produces zero matches, with an honest scope report', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const report = await checkSimilarity('A completely different topic about baking bread at home with simple ingredients and basic kitchen tools.', { openStore });
      assert.equal(report.matches.length, 0);
      assert.equal(report.scope.corpusEmpty, false);
      assert.ok(report.scope.corpusSize.chunks >= 1);
    },
  );
});

// ---------- self-repeat ----------

test('checkSimilarity: repeated sentences WITHIN the pasted text are flagged as self_repeat, independent of the corpus', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, 'Completely unrelated corpus content about something else entirely different from the input.')]),
    async openStore => {
      const repeated = 'The sample was annealed at three hundred degrees for two hours in vacuum. Something else in between here today. The sample was annealed at three hundred degrees for two hours in vacuum.';
      const report = await checkSimilarity(repeated, { openStore });
      const selfRepeat = report.matches.find(m => m.type === 'self_repeat');
      assert.ok(selfRepeat);
      assert.equal(selfRepeat!.documentId, null);
      assert.ok(report.scope.selfRepeats >= 1);
    },
  );
});

// ---------- Cyrillic ----------

test('checkSimilarity: works correctly on Cyrillic (Russian) text end to end', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-ru'), [fakeChunk('doc-ru', 0, SOURCE_TEXT_RU)]),
    async openStore => {
      const report = await checkSimilarity(`Введение. ${SOURCE_TEXT_RU} Заключение.`, { openStore });
      assert.ok(report.matches.some(m => m.type === 'exact' || m.type === 'near_exact'));
    },
  );
});

// ---------- scientific abbreviations / chemical formulas / numbers preserved ----------

test('checkSimilarity: technical abbreviations, chemical formulas and numeric values inside a matched span are reported verbatim, never altered', async () => {
  const technical = 'The PVD process deposited a ta-C coating with substrate bias of minus eighty volts at a deposition rate of two nanometers per minute under 0.5 Pa pressure using AlTiN and TiN targets.';
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-tech'), [fakeChunk('doc-tech', 0, technical)]),
    async openStore => {
      const report = await checkSimilarity(`Prefix sentence here. ${technical} Suffix sentence here.`, { openStore });
      const match = report.matches.find(m => m.type === 'exact' || m.type === 'near_exact');
      assert.ok(match);
      for (const token of ['PVD', 'ta-C', 'AlTiN', 'TiN', '0.5']) assert.ok(match!.inputSpan.includes(token), `expected inputSpan to preserve ${token}`);
    },
  );
});

// ---------- dedup ----------

test('checkSimilarity: the same real match is not reported twice even when both a sentence and its containing paragraph independently find it', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const report = await checkSimilarity(SOURCE_TEXT_EN, { openStore });
      const exactMatchesForThisChunk = report.matches.filter(m => m.type === 'exact' && m.chunkId === 'doc-en:0' && m.inputSpan === SOURCE_TEXT_EN);
      assert.ok(exactMatchesForThisChunk.length <= 1, 'must not report the identical (type, chunk, span) match more than once');
    },
  );
});

// ---------- empty corpus ----------

test('checkSimilarity: an empty local corpus is reported honestly - no matches, corpusEmpty flag, never a crash', async () => {
  await withFixtureStore(
    () => { /* seed nothing */ },
    async openStore => {
      const report = await checkSimilarity('Any input text long enough to pass the minimum length validation check.', { openStore });
      assert.equal(report.scope.corpusEmpty, true);
      assert.deepEqual(report.matches, []);
      assert.equal(report.scope.corpusSize.chunks, 0);
    },
  );
});

// ---------- F14 (LOW): self-repeat detection must run independently of corpus emptiness ----------

test('F14 checkSimilarity: empty corpus + a repeated sentence -> self-repeat is still found (the exact Codex regression - previously the empty-corpus branch returned before self-repeat analysis ran)', async () => {
  await withFixtureStore(
    () => { /* seed nothing - empty corpus */ },
    async openStore => {
      const repeated = 'The sample was annealed at three hundred degrees for two hours in vacuum. Something else in between here today. The sample was annealed at three hundred degrees for two hours in vacuum.';
      const report = await checkSimilarity(repeated, { openStore });
      assert.equal(report.scope.corpusEmpty, true, 'corpus emptiness must still be reported honestly');
      const selfRepeat = report.matches.find(m => m.type === 'self_repeat');
      assert.ok(selfRepeat, 'self-repeat must be found even though the external corpus is empty');
      assert.equal(selfRepeat!.documentId, null);
      assert.ok(report.scope.selfRepeats >= 1);
      assert.equal(report.scope.exactMatches, 0);
      assert.equal(report.scope.nearExactMatches, 0);
      assert.equal(report.scope.similarMatches, 0);
    },
  );
});

test('F14 checkSimilarity: empty corpus + no repeated sentence -> zero self-repeats, zero matches, still honest about the empty corpus', async () => {
  await withFixtureStore(
    () => { /* seed nothing - empty corpus */ },
    async openStore => {
      const noRepeat = 'This sentence is entirely distinct from every other sentence in this short paragraph. Nothing here repeats at all in any way whatsoever.';
      const report = await checkSimilarity(noRepeat, { openStore });
      assert.equal(report.scope.corpusEmpty, true);
      assert.equal(report.scope.selfRepeats, 0);
      assert.equal(report.matches.length, 0);
    },
  );
});

test('F14 checkSimilarity: a NON-empty corpus + a repeated sentence still finds the self-repeat exactly as before (regression against breaking the normal-corpus path)', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, 'Completely unrelated corpus content about something else entirely different from the input.')]),
    async openStore => {
      const repeated = 'The sample was annealed at three hundred degrees for two hours in vacuum. Something else in between here today. The sample was annealed at three hundred degrees for two hours in vacuum.';
      const report = await checkSimilarity(repeated, { openStore });
      assert.equal(report.scope.corpusEmpty, false);
      assert.ok(report.scope.selfRepeats >= 1);
    },
  );
});

test('F14 checkSimilarity: empty corpus + a repeated CYRILLIC sentence -> self-repeat still found', async () => {
  await withFixtureStore(
    () => { /* seed nothing - empty corpus */ },
    async openStore => {
      const repeatedRu = `${SOURCE_TEXT_RU} Промежуточное предложение здесь. ${SOURCE_TEXT_RU}`;
      const report = await checkSimilarity(repeatedRu, { openStore });
      assert.equal(report.scope.corpusEmpty, true);
      const selfRepeat = report.matches.find(m => m.type === 'self_repeat');
      assert.ok(selfRepeat, 'Cyrillic self-repeat must be found even with an empty corpus');
      assert.ok(report.scope.selfRepeats >= 1);
    },
  );
});

// ---------- honest scope reporting / disclaimer ----------

test('checkSimilarity: always includes the mandated local-corpus-only disclaimer, and never a fake "originality %"', async () => {
  await withFixtureStore(
    store => store.replace(fakeDoc('doc-en'), [fakeChunk('doc-en', 0, SOURCE_TEXT_EN)]),
    async openStore => {
      const report = await checkSimilarity(SOURCE_TEXT_EN, { openStore });
      assert.ok(report.disclaimer.includes('локальному корпусу PlasmaTech-AI'));
      assert.ok(!('originality' in report.scope));
      assert.ok(!Object.keys(report.scope).some(k => /plagiaris/i.test(k)));
    },
  );
});
