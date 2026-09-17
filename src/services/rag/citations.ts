import type { AnswerClaim, Citation, GroundingRejectionReason } from './types';

export type GroundingResult = { valid: true; claims: AnswerClaim[] } | { valid: false; reason: GroundingRejectionReason };

/** Matches a bracketed, comma-separated run of integers: [1], [999], [1,999], [1, 2, 3]. This
 *  is deliberately the exact shape of a citation marker - and nothing else - so it never
 *  touches a claim's legitimate use of square brackets (e.g. a chemical formula). */
const CITATION_LIKE_BRACKETS = /\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g;

/** The model's own prose must never be able to forge a trusted-looking citation marker: only
 *  this module's structured citationIds check can ever produce one, and only the caller
 *  (service.ts/UI) renders [n] markers, built from citationIds - never copied from provider
 *  text. This strips any bracket sequence that could be mistaken for one (including the
 *  historically problematic "[1,999]"/"[999]" shapes) from a claim's displayed text, so even
 *  a claim that otherwise passes validation cannot carry a self-authored marker. */
function stripCitationLikeBrackets(text: string): string {
  return text.replace(CITATION_LIKE_BRACKETS, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * Strict, structured, claim-level grounding validation - the only gate an AnswerProvider's
 * output passes through before it can reach a user. Three properties, deliberately kept
 * separate and never conflated:
 *
 *   a) citation INTEGRITY - each claim's citationIds must be a well-formed array of bare
 *      positive integers. There is no free-text citation syntax (no "[1,999]" embedded in
 *      prose) for a malformed reference to hide in, because citations are never parsed out
 *      of text - they are a typed field on a structured claim.
 *   b) evidence PRESENCE - every cited id must exist among the sources actually retained in
 *      RagContext.citations, which (see context.ts) only ever contains sources whose real
 *      evidence text survived context-budget truncation. Every claim must cite at least one
 *      such id; a claim with none is rejected, not silently accepted as "uncited but true".
 *   c) semantic truthfulness of a claim's prose is NEVER checked or asserted here. Passing
 *      (a) and (b) proves a claim is *grounded* - backed by a real, retrieved source with
 *      real included text - it does not and cannot prove the claim is factually correct.
 *
 * Rejects the WHOLE answer (all-or-nothing) if ANY single claim fails (a) or (b), or if
 * there are no claims at all: a partially-trusted answer is not safer than none. */
export function validateAnswerGrounding(output: unknown, citations: readonly Citation[]): GroundingResult {
  if (!output || typeof output !== 'object') return { valid: false, reason: 'malformed-response' };
  const { claims } = output as Record<string, unknown>;
  if (!Array.isArray(claims) || claims.length === 0) return { valid: false, reason: 'malformed-response' };
  const validIndices = new Set(citations.map(c => c.index));
  const validated: AnswerClaim[] = [];
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') return { valid: false, reason: 'malformed-response' };
    const { text, citationIds } = claim as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) return { valid: false, reason: 'malformed-response' };
    if (!Array.isArray(citationIds)) return { valid: false, reason: 'malformed-citations' };
    // (a) citation integrity: every id must be a bare positive integer - no ranges, lists,
    // decimals or non-numeric values can pass here, structurally.
    if (!citationIds.every(id => Number.isInteger(id) && (id as number) > 0)) return { valid: false, reason: 'malformed-citations' };
    if (citationIds.length === 0) return { valid: false, reason: 'missing-citations' };
    // (b) evidence presence: every cited id must reference a source whose evidence text was
    // actually included in the context that was sent - never a source outside it.
    if (!(citationIds as number[]).every(id => validIndices.has(id))) return { valid: false, reason: 'unknown-citation' };
    validated.push({ text: stripCitationLikeBrackets(text), citationIds: citationIds as number[] });
  }
  return { valid: true, claims: validated };
}
