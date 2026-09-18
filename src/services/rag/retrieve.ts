import type { TextStore } from '@/services/library-text/store';
import type { ContentHit } from '@/services/library-text/types';
import { hydrateChunk } from './hydrate';
import type { RetrievedChunk } from './types';

// A small, deliberately simple stopword list (RU + EN): strips generic question/function
// words so a natural-language question turns into salient keywords for TextStore.search(),
// which otherwise ANDs every single token together and would over-constrain the query.
const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так', 'его', 'но', 'да',
  'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее', 'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет',
  'о', 'из', 'ему', 'теперь', 'когда', 'даже', 'ну', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до',
  'вас', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей', 'может', 'они', 'тут', 'где', 'есть',
  'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была', 'сам', 'без', 'человек', 'чего', 'раз', 'тоже', 'себе',
  'под', 'будет', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой', 'какие', 'какая', 'здесь', 'этом',
  'один', 'мой', 'тем', 'чтобы', 'нее', 'сейчас', 'были', 'куда', 'зачем', 'всех', 'можно', 'при', 'об', 'другой',
  'после', 'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'много', 'три', 'эту', 'моя',
  'перед', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'всю', 'между', 'это', 'эта', 'использовались',
  'использовался', 'использовалась', 'использовать', 'применялись', 'применялась',
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'what', 'which', 'how', 'when', 'where', 'why',
  'who', 'whom', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'used', 'use', 'using', 'with', 'at', 'by',
  'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its', 'into', 'than', 'then', 'so', 'such', 'can', 'could',
  'would', 'should', 'will', 'shall', 'do', 'does', 'did', 'has', 'have', 'had', 'not', 'no', 'yes', 'you', 'your',
  'we', 'our', 'they', 'their',
]);

/** Turns a natural-language question into keywords/phrases for the existing FTS layer.
 *  Quoted phrases are preserved verbatim; everything else is reduced to salient words. */
export function extractSearchTerms(question: string): string[] {
  const quoted = [...question.matchAll(/"([^"]+)"/gu)].map(m => m[1].trim()).filter(Boolean);
  const rest = question.replace(/"[^"]+"/gu, ' ');
  const words = [...rest.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)].map(m => m[0]);
  const keywords = words.filter(w => w.length >= 3 && !STOPWORDS.has(w.toLocaleLowerCase()));
  // If the length>=3 filter alone left nothing, still never send a KNOWN stopword to FTS -
  // a single-/short-word question that happens to be a pure function word (e.g. "a", "и")
  // is not just unhelpful, it is also, empirically, one of the most expensive possible FTS
  // queries (near-universal terms can match 90%+ of the corpus - see docs/architecture.md's
  // FTS latency findings). Only fall back to raw (non-stopword) words so a genuinely short,
  // non-generic question still gets searched.
  const salient = keywords.length ? keywords : words.filter(w => !STOPWORDS.has(w.toLocaleLowerCase()));
  return [...quoted, ...salient];
}

function buildFtsQuery(terms: string[]): string {
  // Reconstruct a query string for TextStore.search(): a multi-word term becomes a quoted
  // phrase again (its own tokenizer already accepts quotes for phrases and literal words
  // otherwise), so this never bypasses that method's own safe parsing.
  return terms.map(t => (t.includes(' ') ? `"${t.replaceAll('"', '""')}"` : t)).join(' ');
}

function toRetrievedChunk(store: TextStore, hit: ContentHit, score: number): RetrievedChunk | null {
  // hit.id is the document id (ContentHit extends TextMetadata, whose `id` field is the
  // document, not the chunk); hydrateChunk re-reads the chunk/document rows directly so the
  // lexical and semantic retrieval paths always produce an identical RetrievedChunk shape.
  return hydrateChunk(store, hit.chunkId, hit.id, score, hit.snippet);
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** True if ANY contributing FTS query (the strict search, or one of the per-term fallback
   *  searches) had to rank by natural order instead of bm25 relevance because it was too
   *  broad (see TextStore.search()'s own `rankingDegraded`) - surfaced, never hidden, so
   *  diagnostics can report that these results are not fully relevance-ranked. */
  rankingDegraded: boolean;
}

/** store.search() itself throws only if the reconstructed query exceeds 500 chars - our own
 *  pre-flight limit, not an index failure, so this combination is simply skipped rather than
 *  surfaced as an error. Any OTHER exception (a genuine SQLite/search failure) is deliberately
 *  left to propagate out of collect()/retrieveChunks() uncaught: askLibrary() (service.ts)
 *  catches it there and reports a distinct 'index_error' status, instead of this function
 *  masking a real index problem as an ordinary "no results" empty array. */
function collect(store: TextStore, terms: string[], limit: number): { chunks: RetrievedChunk[]; rankingDegraded: boolean } {
  if (!terms.length) return { chunks: [], rankingDegraded: false };
  // Bounded, deterministic term selection: build the query incrementally (in the caller's
  // original term order) and stop BEFORE exceeding the 500-char limit, rather than building
  // the full string first and discarding the ENTIRE strict search the moment it is too long.
  // A long, genuinely information-rich question deserves a real (if truncated) strict AND
  // search, not an automatic escalation to the more expensive per-term fallback below just
  // because its full reconstructed query happened to be a few characters too long.
  const bounded: string[] = [];
  let queryLength = 0;
  for (const term of terms) {
    const piece = term.includes(' ') ? `"${term.replaceAll('"', '""')}"` : term;
    const nextLength = queryLength + piece.length + (bounded.length ? 1 : 0);
    if (nextLength > 500) break;
    bounded.push(term);
    queryLength = nextLength;
  }
  if (!bounded.length) return { chunks: [], rankingDegraded: false };
  const query = buildFtsQuery(bounded);
  const result = store.search(query, 0);
  // Reciprocal-rank score, same convention as scientific-search/pipeline.ts (1/(60+rank+1)),
  // so scores from independent per-term searches below can be fused by simple addition.
  const chunks = result.hits.slice(0, limit)
    .map((hit, rank) => toRetrievedChunk(store, hit, 1 / (60 + rank + 1)))
    .filter((chunk): chunk is RetrievedChunk => chunk !== null);
  return { chunks, rankingDegraded: result.rankingDegraded };
}

/** At most this many distinct keywords get their own fallback search below. Kept small
 *  deliberately: each one is a full, separate store.search() call (its own count/rank/
 *  snippet query), so this directly bounds a worst case that is NOT itself a single
 *  pathological query but the SUM of several individually-fine ones - see the frequency-
 *  ascending ordering below, which is what actually keeps that sum small in practice. */
const MAX_FALLBACK_TERMS = 4;

/** Cheap (a few ms, per docs/architecture.md's FTS latency measurements) document-frequency
 *  check for one term/phrase - used only to ORDER fallback candidates, never to change what
 *  is searched. */
function termFrequency(store: TextStore, term: string): number {
  const match = `"${term.replaceAll('"', '""')}"`;
  return Number(store.db.prepare('SELECT count(*) n FROM content_search WHERE content_search MATCH ?').get(match)!.n);
}

/** Retrieves the most relevant chunks for a natural-language question, using the existing
 *  FTS5 index as the only retrieval layer (no embeddings, no vector store). */
export function retrieveChunks(store: TextStore, question: string, limit: number): RetrieveResult {
  const terms = extractSearchTerms(question);
  if (!terms.length) return { chunks: [], rankingDegraded: false };
  const strict = collect(store, terms, limit);
  if (strict.chunks.length) return strict;
  // The strict AND-of-all-keywords query found nothing: broaden by searching each keyword
  // independently and fusing the results, so a question with several rare technical terms
  // still surfaces chunks that match only some of them. Rarer terms are prioritized (both
  // cheaper per search AND, in practice, more likely to carry real discriminative signal
  // than a term common enough to match a large fraction of the corpus) - measured: several
  // individually-acceptable but moderately common terms (thousands of matches each) summed
  // to a multi-hundred-millisecond total when all run in the original question order.
  const byFrequency = [...terms].sort((a, b) => termFrequency(store, a) - termFrequency(store, b));
  const perTerm = byFrequency.slice(0, MAX_FALLBACK_TERMS).map(term => collect(store, [term], limit));
  const fused = new Map<string, RetrievedChunk>();
  let rankingDegraded = strict.rankingDegraded;
  for (const result of perTerm) {
    rankingDegraded ||= result.rankingDegraded;
    for (const chunk of result.chunks) {
      const existing = fused.get(chunk.chunkId);
      fused.set(chunk.chunkId, existing ? { ...existing, score: existing.score + chunk.score } : chunk);
    }
  }
  const chunks = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { chunks, rankingDegraded };
}
