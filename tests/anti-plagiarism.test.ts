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

// ---------- F15 (MEDIUM): coveredFraction must be a UNION of unique intervals, never a sum of
// overlapping/nested/duplicate span lengths (which can wildly overstate real coverage) ----------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'; // 26 unique characters -> every slice is an unambiguous, uniquely-locatable substring

test('F15 computeCoveredFraction: a nested span (fully inside an already-covered span) adds nothing to coverage', () => {
  const outer = ALPHABET.slice(5, 20); // 15 chars, positions 5-20
  const inner = ALPHABET.slice(8, 12); // 4 chars, positions 8-12, fully nested inside `outer`
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: outer }), fakeMatch({ inputSpan: inner, chunkId: 'chunk-2' })];
  const fraction = computeCoveredFraction(matches, ALPHABET);
  assert.equal(fraction, 15 / 26, 'the nested span must not add its own length on top of the span that already covers it');
});

test('F15 computeCoveredFraction: overlapping (non-identical) spans are merged into their union, not summed - this is the exact Codex regression (real 58%, previously reported as inflated)', () => {
  const spanA = ALPHABET.slice(0, 15); // positions 0-15 (15 chars)
  const spanB = ALPHABET.slice(10, 20); // positions 10-20 (10 chars) - overlaps spanA on 10-15
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: spanA }), fakeMatch({ inputSpan: spanB, chunkId: 'chunk-2' })];
  const fraction = computeCoveredFraction(matches, ALPHABET);
  assert.equal(fraction, 20 / 26, 'union of [0,15) and [10,20) is [0,20) = 20 chars, NOT the sum 15+10=25 chars the old code would have reported');
});

test('F15 computeCoveredFraction: adjacent (touching, non-overlapping) spans merge into one continuous covered region with no gap and no double count', () => {
  const spanA = ALPHABET.slice(0, 10);
  const spanB = ALPHABET.slice(10, 20);
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: spanA }), fakeMatch({ inputSpan: spanB, chunkId: 'chunk-2' })];
  const fraction = computeCoveredFraction(matches, ALPHABET);
  assert.equal(fraction, 20 / 26);
});

test('F15 computeCoveredFraction: the exact same span text matched against two different corpus chunks (duplicate spans) still counts those characters only once', () => {
  const span = ALPHABET.slice(0, 10);
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: span, chunkId: 'chunk-1' }), fakeMatch({ inputSpan: span, chunkId: 'chunk-2', documentId: 'doc-2' })];
  const fraction = computeCoveredFraction(matches, ALPHABET);
  assert.equal(fraction, 10 / 26);
});

test('F15 computeCoveredFraction: no matches at all -> 0', () => {
  assert.equal(computeCoveredFraction([], ALPHABET), 0);
});

test('F15 computeCoveredFraction: a match covering the entire input text -> exactly 1 (full coverage), never above 1', () => {
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: ALPHABET })];
  assert.equal(computeCoveredFraction(matches, ALPHABET), 1);
});

test('F15 computeCoveredFraction: several overlapping/nested/duplicate spans together still never exceed 1, even though their raw lengths sum to far more than the input', () => {
  const matches: SimilarityMatch[] = [
    fakeMatch({ inputSpan: ALPHABET, chunkId: 'chunk-1' }),
    fakeMatch({ inputSpan: ALPHABET.slice(0, 10), chunkId: 'chunk-2' }),
    fakeMatch({ inputSpan: ALPHABET.slice(5, 15), chunkId: 'chunk-3' }),
    fakeMatch({ inputSpan: ALPHABET.slice(20, 26), chunkId: 'chunk-4' }),
  ];
  assert.equal(computeCoveredFraction(matches, ALPHABET), 1);
});

test('F15 computeCoveredFraction: a span that cannot be located in the input is skipped rather than guessed at - never inflates or crashes', () => {
  const matches: SimilarityMatch[] = [fakeMatch({ inputSpan: 'not present anywhere in the alphabet text 123' })];
  assert.equal(computeCoveredFraction(matches, ALPHABET), 0);
});
