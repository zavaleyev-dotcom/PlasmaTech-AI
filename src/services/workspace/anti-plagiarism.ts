/** Real, local, dependency-free text-similarity checking for Scientific Writer - no LLM, no
 *  external plagiarism service, no internet-wide search. This file is pure and browser-safe
 *  (no node:sqlite, no TextStore import) - it only ever normalizes/segments/scores TEXT; the
 *  actual local-corpus lookup lives in anti-plagiarism-corpus.ts (server-only). Every threshold
 *  is a named, exported constant - never a magic number buried in logic - and every score is a
 *  local, checkable containment ratio, never presented as a global "originality %" or
 *  "plagiarism %" figure (this app has no way to know what exists outside its own corpus). */

// ---------- named thresholds (item 6) ----------

/** A pasted text shorter than this cannot meaningfully be checked - too little signal for any
 *  n-gram-based comparison to be honest. */
export const MIN_INPUT_CHARS = 20;
/** Bounds worst-case work per request - see MAX_SEGMENTS_* / CANDIDATES_PER_SEGMENT below for
 *  how this keeps the whole pipeline O(segments × bounded-candidates), never O(input × corpus). */
export const MAX_INPUT_CHARS = 20_000;
export const MAX_SEGMENTS_SENTENCES = 300;
export const MAX_SEGMENTS_PARAGRAPHS = 100;
/** A sentence/paragraph shorter than this (in words) is skipped - too short for a containment
 *  score to mean anything (a 2-word fragment "matches" almost everything trivially). */
export const MIN_SEGMENT_WORDS = 5;
/** Bounded candidate retrieval (item 6/9): at most this many corpus chunks are compared against
 *  EACH segment, via the existing FTS index - never a brute-force scan of the whole corpus. */
export const CANDIDATES_PER_SEGMENT = 5;
/** Caps the total number of matches actually returned to the caller/UI. */
export const MAX_REPORTED_MATCHES = 50;
/** Word n-gram ("shingle") size used for the containment score. */
export const NGRAM_SIZE = 5;
/** score >= this (and the input text appears as a literal substring of the source) -> 'exact'. */
export const EXACT_CONTAINMENT = 1;
/** score >= this (but not 'exact') -> 'near_exact'. */
export const NEAR_EXACT_THRESHOLD = 0.85;
/** score >= this (but below NEAR_EXACT_THRESHOLD) -> 'similar'. Below this: not reported. */
export const SIMILAR_THRESHOLD = 0.55;
/** Same containment metric, applied between two segments of the SAME input text, for
 *  self-repeat detection. */
export const SELF_REPEAT_THRESHOLD = 0.85;

export const SCOPE_DISCLAIMER = 'Проверка выполнена только по локальному корпусу PlasmaTech-AI и не является глобальной проверкой оригинальности.';

// ---------- types ----------

export type MatchType = 'exact' | 'near_exact' | 'similar' | 'self_repeat';

export interface SimilarityMatch {
  type: MatchType;
  /** The user's own fragment, exactly as typed (not normalized). */
  inputSpan: string;
  /** The matched fragment from the source (a single sentence from the source chunk/segment,
   *  not the whole multi-hundred-word chunk). */
  sourceSpan: string;
  documentId: string | null;
  documentTitle: string | null;
  relativePath: string | null;
  chunkId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Local containment score for this specific pair, 0..1 - NEVER an "originality %". */
  score: number;
}

export interface CorpusSize { documents: number; chunks: number }

export interface SimilarityScope {
  corpusSize: CorpusSize;
  corpusEmpty: boolean;
  documentsChecked: number;
  chunksChecked: number;
  sentencesChecked: number;
  paragraphsChecked: number;
  exactMatches: number;
  nearExactMatches: number;
  similarMatches: number;
  selfRepeats: number;
  /** Fraction (0..1) of the input text's characters covered by at least one exact/near_exact/
   *  similar match against the corpus (self-repeats are excluded from this figure - they are a
   *  different question: "did the user repeat themselves", not "does this match the corpus"). */
  coveredFraction: number;
}

export interface SimilarityReport { matches: SimilarityMatch[]; scope: SimilarityScope; disclaimer: string }

// ---------- validation (item 9) ----------

export function validateSimilarityInput(text: string): void {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Введите текст для проверки.');
  if (text.trim().length < MIN_INPUT_CHARS) throw new Error(`Текст слишком короткий для проверки (минимум ${MIN_INPUT_CHARS} символов).`);
  if (text.length > MAX_INPUT_CHARS) throw new Error(`Текст слишком длинный (максимум ${MAX_INPUT_CHARS} символов).`);
}

// ---------- normalization / segmentation (item 6/7) ----------

/** NFKC + whitespace collapse - Cyrillic, English, chemical formulas (subscripts/superscripts
 *  normalize consistently under NFKC), and DOIs/abbreviations are all preserved as text; this
 *  never rewrites or "corrects" a single character, only collapses whitespace runs. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Sentence segmentation via Intl.Segmenter, the same primitive already used by the library's
 *  own chunker (src/services/library-text/chunk.ts) - not reinvented, just reused at the
 *  language level (no library-specific import, to keep this file dependency-free). */
export function segmentSentences(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  return [...segmenter.segment(normalizeText(text))].map(s => s.segment.trim()).filter(Boolean);
}

/** Paragraphs: blank-line-separated runs of the ORIGINAL text (segmented before whitespace
 *  collapse would erase the blank lines that mark paragraph boundaries). */
export function segmentParagraphs(text: string): string[] {
  return text.split(/\n\s*\n+/).map(p => normalizeText(p)).filter(Boolean);
}

function tokenize(text: string): string[] {
  return normalizeText(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function ngramSet(tokens: string[], n: number): Set<string> {
  const size = Math.min(n, tokens.length);
  const grams = new Set<string>();
  if (size === 0) return grams;
  for (let i = 0; i + size <= tokens.length; i++) grams.add(tokens.slice(i, i + size).join(' '));
  return grams;
}

// ---------- containment scoring (item 6): |input n-grams ∩ source n-grams| / |input n-grams| ----------

/** Containment (not symmetric Jaccard): what fraction of the INPUT span's word n-grams also
 *  appear in the (usually much longer) source text. This is the right metric for "was this
 *  short span copied from within this longer chunk" - a plain Jaccard against a 1000+ word
 *  chunk would stay tiny even for a fully copied sentence. */
export function containmentScore(inputText: string, sourceText: string, n: number = NGRAM_SIZE): number {
  const inputTokens = tokenize(inputText);
  if (inputTokens.length === 0) return 0;
  const inputGrams = ngramSet(inputTokens, n);
  if (inputGrams.size === 0) return 0;
  const sourceGrams = ngramSet(tokenize(sourceText), n);
  let matched = 0;
  for (const gram of inputGrams) if (sourceGrams.has(gram)) matched++;
  return matched / inputGrams.size;
}

export function classifyMatch(inputText: string, sourceText: string, score: number): MatchType | null {
  if (score >= NEAR_EXACT_THRESHOLD) {
    if (score >= EXACT_CONTAINMENT) {
      const normalizedSource = normalizeText(sourceText).toLocaleLowerCase();
      const normalizedInput = normalizeText(inputText).toLocaleLowerCase();
      if (normalizedSource.includes(normalizedInput)) return 'exact';
    }
    return 'near_exact';
  }
  if (score >= SIMILAR_THRESHOLD) return 'similar';
  return null;
}

/** Picks the single best-matching sentence WITHIN a (potentially long) source text to display
 *  as "совпавший фрагмент источника" - never the whole multi-hundred-word chunk. */
export function pickBestSourceSentence(sourceText: string, inputSpan: string): string {
  const sentences = segmentSentences(sourceText);
  if (sentences.length === 0) return normalizeText(sourceText).slice(0, 300);
  let best = sentences[0];
  let bestScore = -1;
  for (const sentence of sentences) {
    const score = containmentScore(inputSpan, sentence);
    if (score > bestScore) { bestScore = score; best = sentence; }
  }
  return best;
}

// ---------- self-repeat detection (item 3.E) - within the pasted text only ----------

export function findSelfRepeats(sentences: string[]): SimilarityMatch[] {
  const matches: SimilarityMatch[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (tokenize(sentences[i]).length < MIN_SEGMENT_WORDS) continue;
    for (let j = i + 1; j < sentences.length; j++) {
      if (tokenize(sentences[j]).length < MIN_SEGMENT_WORDS) continue;
      const score = containmentScore(sentences[i], sentences[j]);
      if (score >= SELF_REPEAT_THRESHOLD) {
        matches.push({
          type: 'self_repeat', inputSpan: sentences[i], sourceSpan: sentences[j],
          documentId: null, documentTitle: null, relativePath: null, chunkId: null, pageStart: null, pageEnd: null,
          score,
        });
      }
    }
  }
  return matches;
}

// ---------- dedup + ordering (item 6) ----------

const TYPE_SEVERITY: Record<MatchType, number> = { exact: 3, near_exact: 2, similar: 1, self_repeat: 0 };

/** Merges matches that are effectively the same finding (same type, same source chunk - or
 *  'self' for self-repeats - and the same input span, once normalized) - keeps only the
 *  highest-scoring instance instead of showing near-duplicate rows for the same real match. */
export function dedupMatches(matches: SimilarityMatch[]): SimilarityMatch[] {
  const bestByKey = new Map<string, SimilarityMatch>();
  for (const match of matches) {
    const key = `${match.type}:${match.chunkId ?? `self:${normalizeText(match.sourceSpan).toLocaleLowerCase()}`}:${normalizeText(match.inputSpan).toLocaleLowerCase()}`;
    const existing = bestByKey.get(key);
    if (!existing || match.score > existing.score) bestByKey.set(key, match);
  }
  return [...bestByKey.values()];
}

export function sortMatches(matches: SimilarityMatch[]): SimilarityMatch[] {
  return [...matches].sort((a, b) => TYPE_SEVERITY[b.type] - TYPE_SEVERITY[a.type] || b.score - a.score);
}

/** Fraction of the input text's characters covered by at least one corpus match (exact/
 *  near_exact/similar - self-repeats excluded, since they answer a different question). Simple
 *  sum-of-unique-span-lengths approximation, not a full interval merge - documented as a known
 *  limitation (a paragraph match and a sentence match against the same underlying text both
 *  count their own length, so this can slightly OVER-report coverage in that specific case). */
export function computeCoveredFraction(matches: SimilarityMatch[], inputText: string): number {
  const corpusMatches = matches.filter(m => m.type !== 'self_repeat');
  if (corpusMatches.length === 0) return 0;
  const uniqueSpans = new Set(corpusMatches.map(m => normalizeText(m.inputSpan).toLocaleLowerCase()));
  const coveredChars = [...uniqueSpans].reduce((sum, span) => sum + span.length, 0);
  const totalChars = normalizeText(inputText).length;
  return totalChars > 0 ? Math.min(1, coveredChars / totalChars) : 0;
}
