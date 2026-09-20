import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_INPUT_CHARS, MAX_INPUT_CHARS, NEAR_EXACT_THRESHOLD, SIMILAR_THRESHOLD, SELF_REPEAT_THRESHOLD,
  validateSimilarityInput, normalizeText, segmentSentences, segmentParagraphs,
  containmentScore, classifyMatch, pickBestSourceSentence, findSelfRepeats, dedupMatches, sortMatches, computeCoveredFraction,
  type SimilarityMatch,
} from '../src/services/workspace/anti-plagiarism';

// ---------- validation (item 9) ----------

test('validateSimilarityInput: rejects empty, too-short, and oversized input; accepts a reasonable text', () => {
  assert.throws(() => validateSimilarityInput(''), /Введите текст/);
  assert.throws(() => validateSimilarityInput('   '), /Введите текст/);
  assert.throws(() => validateSimilarityInput('short'), /короткий/);
  assert.throws(() => validateSimilarityInput('a'.repeat(MAX_INPUT_CHARS + 1)), /длинный/);
  assert.doesNotThrow(() => validateSimilarityInput('a'.repeat(MIN_INPUT_CHARS)));
});

// ---------- normalization / segmentation (item 6/7) ----------

test('normalizeText: NFKC + whitespace collapse never touches numbers, units, formulas, DOIs, Cyrillic, or English', () => {
  const text = '  Толщина   TiN  составила  350   нм  при  0.5 Па,  doi:10.1000/xyz  ';
  const result = normalizeText(text);
  assert.equal(result, 'Толщина TiN составила 350 нм при 0.5 Па, doi:10.1000/xyz');
});

test('segmentSentences / segmentParagraphs: split RU and EN text correctly, preserving content', () => {
  const sentences = segmentSentences('First sentence about PVD. Second sentence about CVD.');
  assert.equal(sentences.length, 2);
  assert.ok(sentences[0].includes('PVD'));
  const paragraphs = segmentParagraphs('Первый абзац.\n\nВторой абзац.');
  assert.equal(paragraphs.length, 2);
});

// ---------- containment / classification (item 6) ----------

test('containmentScore: an identical span scores 1.0, an unrelated span scores near 0', () => {
  const text = 'The magnetron deposition of AlTiN coating on high-speed steel was performed at 400 degrees.';
  assert.equal(containmentScore(text, text), 1);
  assert.ok(containmentScore(text, 'Completely unrelated sentence about cooking recipes today.') < 0.2);
});

test('classifyMatch: exact requires containment 1.0 AND literal substring presence; near_exact/similar/none follow the named thresholds', () => {
  const original = 'Deposition was performed at 400 degrees Celsius for 60 minutes.';
  assert.equal(classifyMatch(original, `Some preamble. ${original} Some epilogue.`, 1), 'exact');
  assert.equal(classifyMatch('a b c d e f g h', 'x b c d e f g y', NEAR_EXACT_THRESHOLD), 'near_exact');
  assert.equal(classifyMatch('a b c d e f g h', 'x b c d e y y y', SIMILAR_THRESHOLD), 'similar');
  assert.equal(classifyMatch('a b c d e f g h', 'totally different words entirely here', 0.1), null);
});

test('pickBestSourceSentence: returns the single sentence within a longer source that best matches the input, not the whole chunk', () => {
  const source = 'Irrelevant intro sentence here. The coating thickness reached 350 nm after deposition. Another irrelevant sentence follows.';
  const best = pickBestSourceSentence(source, 'The coating thickness reached 350 nm after deposition.');
  assert.equal(best, 'The coating thickness reached 350 nm after deposition.');
});

// ---------- self-repeat (item 3.E) ----------

test('findSelfRepeats: flags two near-identical sentences within the SAME input text, ignores short/unrelated sentences', () => {
  const sentences = [
    'The deposition rate was measured at ten nanometers per minute during the experiment today.',
    'Short one.',
    'The deposition rate was measured at ten nanometers per minute during the experiment.',
    'A totally unrelated sentence about something else entirely different here.',
  ];
  const repeats = findSelfRepeats(sentences);
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].type, 'self_repeat');
  assert.ok(repeats[0].score >= SELF_REPEAT_THRESHOLD);
});

test('findSelfRepeats: no false positive when all sentences are genuinely distinct', () => {
  const sentences = [
    'The deposition rate was measured at ten nanometers per minute today.',
    'The substrate temperature was held at four hundred degrees Celsius.',
    'Hardness values reached twenty four hundred Vickers after processing.',
  ];
  assert.deepEqual(findSelfRepeats(sentences), []);
});

// ---------- dedup / ordering ----------

function fakeMatch(overrides: Partial<SimilarityMatch> = {}): SimilarityMatch {
  return { type: 'similar', inputSpan: 'span', sourceSpan: 'source', documentId: 'doc-1', documentTitle: 'Title', relativePath: 'a.pdf', chunkId: 'chunk-1', pageStart: 1, pageEnd: 1, score: 0.6, ...overrides };
}

test('dedupMatches: keeps the highest-scoring instance when the same (type, chunk, input span) repeats', () => {
  const matches = [fakeMatch({ score: 0.6 }), fakeMatch({ score: 0.9 }), fakeMatch({ chunkId: 'chunk-2', score: 0.7 })];
  const deduped = dedupMatches(matches);
  assert.equal(deduped.length, 2);
  assert.ok(deduped.some(m => m.chunkId === 'chunk-1' && m.score === 0.9));
});

test('sortMatches: orders by severity (exact > near_exact > similar > self_repeat) then by score', () => {
  const matches = [fakeMatch({ type: 'similar', score: 0.9 }), fakeMatch({ type: 'exact', score: 0.6 }), fakeMatch({ type: 'self_repeat', score: 0.95 })];
  const sorted = sortMatches(matches);
  assert.deepEqual(sorted.map(m => m.type), ['exact', 'similar', 'self_repeat']);
});

// ---------- honest scope: no fake "originality %" (item 5) ----------

test('computeCoveredFraction: is a plain coverage ratio (0..1) over corpus matches only, excluding self-repeats, never an "originality/plagiarism %" label', () => {
  const input = 'a'.repeat(100);
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: 'a'.repeat(50) }), fakeMatch({ type: 'self_repeat', inputSpan: 'a'.repeat(1000), documentId: null, chunkId: null })];
  const fraction = computeCoveredFraction(matches, input);
  assert.ok(fraction > 0 && fraction <= 1);
  assert.equal(computeCoveredFraction([], input), 0);
});
