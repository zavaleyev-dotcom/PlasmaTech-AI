import type { Citation } from './types';

/** Checks every [n] marker in a generated answer against the actual retrieval results.
 *  Returns false if the model cited an index that does not correspond to a real retrieved
 *  source - the caller must then discard the answer text entirely (see service.ts): a
 *  partially-doctored answer is not safer than rejecting it outright. */
export function hasOnlyKnownCitations(text: string, citations: readonly Citation[]): boolean {
  const valid = new Set(citations.map(c => c.index));
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    if (!valid.has(Number(match[1]))) return false;
  }
  return true;
}
