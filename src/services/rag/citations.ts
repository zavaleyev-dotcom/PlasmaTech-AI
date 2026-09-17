import type { Citation, GroundingRejectionReason } from './types';

export type GroundingResult = { valid: true } | { valid: false; reason: GroundingRejectionReason };

/** Strict, structured citation validation. Deliberately split into two independently
 *  checkable properties, per the request that follows from these rules:
 *    a) citation INTEGRITY  - citationIds must be a well-formed array of bare positive
 *       integers (no lists-in-brackets, no decimals, no strings: this is why the provider
 *       returns a typed array instead of text to be regex-parsed - there is no free-text
 *       syntax like "[1,999]" left for a malformed citation to hide in).
 *    b) evidence SUFFICIENCY - every cited id must exist among the sources actually passed
 *       in RagContext.citations, and a substantive answer must cite at least one of them.
 *  This function proves the answer is *grounded in the retrieved sources* in a mechanical,
 *  testable sense. It does NOT and cannot prove the answer's prose is factually correct
 *  (c) - that remains the provider's responsibility and is never claimed here. */
export function validateAnswerGrounding(output: unknown, citations: readonly Citation[]): GroundingResult {
  if (!output || typeof output !== 'object') return { valid: false, reason: 'malformed-response' };
  const { answer, citationIds } = output as Record<string, unknown>;
  if (typeof answer !== 'string' || !answer.trim()) return { valid: false, reason: 'malformed-response' };
  if (!Array.isArray(citationIds)) return { valid: false, reason: 'malformed-citations' };
  // (a) citation integrity: every id must be a bare positive integer - no ranges, lists,
  // decimals, or non-numeric values can pass here, structurally.
  if (!citationIds.every(id => Number.isInteger(id) && (id as number) > 0)) return { valid: false, reason: 'malformed-citations' };
  const validIndices = new Set(citations.map(c => c.index));
  // (b) evidence sufficiency: every cited id must reference a source that was actually
  // retrieved - the provider can never point at a source outside RagContext.citations.
  if (!(citationIds as number[]).every(id => validIndices.has(id))) return { valid: false, reason: 'unknown-citation' };
  // A substantive answer must be grounded in at least one real source.
  if (citationIds.length === 0) return { valid: false, reason: 'missing-citations' };
  return { valid: true };
}

/** Defense in depth only: validateAnswerGrounding() is the actual gate (it rejects the whole
 *  answer if citationIds is malformed/unknown/missing). This additionally strips any inline
 *  "[n]" marker from the display text whose n is not an actually-cited, valid index, so the
 *  rendered text cannot visually imply a source that citationIds does not vouch for either. */
export function sanitizeInlineCitations(text: string, citationIds: readonly number[]): string {
  const valid = new Set(citationIds);
  return text.replace(/\[(\d+)\]/g, (match, digits: string) => (valid.has(Number(digits)) ? match : ''));
}
