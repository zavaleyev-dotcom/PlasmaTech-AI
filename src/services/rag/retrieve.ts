import type { TextStore } from '@/services/library-text/store';
import type { ContentHit } from '@/services/library-text/types';
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
  // Never end up with an empty query just because the whole question was stopwords.
  const salient = keywords.length ? keywords : words;
  return [...quoted, ...salient];
}

function buildFtsQuery(terms: string[]): string {
  // Reconstruct a query string for TextStore.search(): a multi-word term becomes a quoted
  // phrase again (its own tokenizer already accepts quotes for phrases and literal words
  // otherwise), so this never bypasses that method's own safe parsing.
  return terms.map(t => (t.includes(' ') ? `"${t.replaceAll('"', '""')}"` : t)).join(' ');
}

function toRetrievedChunk(store: TextStore, hit: ContentHit, score: number): RetrievedChunk {
  // ContentHit only carries a short FTS snippet; the full chunk text lives in `chunks.text`.
  // TextStore.search()/the schema are not touched - this reads through the already-public
  // `store.db` the same way tests already do, without adding a new method to TextStore.
  const row = store.db.prepare('SELECT text FROM chunks WHERE id=?').get(hit.chunkId) as { text: string } | undefined;
  return {
    chunkId: hit.chunkId, documentId: hit.id, relativePath: hit.relativePath, filename: hit.filename,
    title: hit.title, authors: hit.authors, doi: hit.doi, year: hit.year, sourceFolder: hit.sourceFolder,
    pageStart: hit.pageStart, pageEnd: hit.pageEnd, text: row?.text ?? hit.snippet, snippet: hit.snippet, score,
  };
}

/** store.search() itself throws only if the reconstructed query exceeds 500 chars - our own
 *  pre-flight limit, not an index failure, so this combination is simply skipped rather than
 *  surfaced as an error. Any OTHER exception (a genuine SQLite/search failure) is deliberately
 *  left to propagate out of collect()/retrieveChunks() uncaught: askLibrary() (service.ts)
 *  catches it there and reports a distinct 'index_error' status, instead of this function
 *  masking a real index problem as an ordinary "no results" empty array. */
function collect(store: TextStore, terms: string[], limit: number): RetrievedChunk[] {
  if (!terms.length) return [];
  const query = buildFtsQuery(terms);
  if (query.length > 500) return [];
  const result = store.search(query, 0);
  // Reciprocal-rank score, same convention as scientific-search/pipeline.ts (1/(60+rank+1)),
  // so scores from independent per-term searches below can be fused by simple addition.
  return result.hits.slice(0, limit).map((hit, rank) => toRetrievedChunk(store, hit, 1 / (60 + rank + 1)));
}

/** At most this many distinct keywords get their own fallback search below. */
const MAX_FALLBACK_TERMS = 6;

/** Retrieves the most relevant chunks for a natural-language question, using the existing
 *  FTS5 index as the only retrieval layer (no embeddings, no vector store). */
export function retrieveChunks(store: TextStore, question: string, limit: number): RetrievedChunk[] {
  const terms = extractSearchTerms(question);
  if (!terms.length) return [];
  const strict = collect(store, terms, limit);
  if (strict.length) return strict;
  // The strict AND-of-all-keywords query found nothing: broaden by searching each keyword
  // independently and fusing the results, so a question with several rare technical terms
  // still surfaces chunks that match only some of them.
  const perTerm = terms.slice(0, MAX_FALLBACK_TERMS).map(term => collect(store, [term], limit));
  const fused = new Map<string, RetrievedChunk>();
  for (const list of perTerm) for (const chunk of list) {
    const existing = fused.get(chunk.chunkId);
    fused.set(chunk.chunkId, existing ? { ...existing, score: existing.score + chunk.score } : chunk);
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
