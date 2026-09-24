import type { AnswerClaim, Citation, GroundingRejectionReason } from './types';

export type GroundingResult = { valid: true; claims: AnswerClaim[] } | { valid: false; reason: GroundingRejectionReason };

/** Matches a bracketed run of digits, optionally combined with other digit runs via any
 *  mix of comma, semicolon, hyphen/en-dash/em-dash or whitespace: [1], [999], [1,999],
 *  [1, 999], [1;999], [1-999], [1–999], and (each independently) [1][999]. Deliberately
 *  requires the bracket's content to consist ONLY of digits and these separators - never
 *  letters - so it never touches a claim's legitimate use of square brackets for plain
 *  scientific notation (e.g. "[Ti]", "[OH]"): our own citation markers are always bare
 *  numbers, so only digit-shaped bracket content can ever be mistaken for one. */
const CITATION_LIKE_BRACKETS = /\[\s*\d+(?:[\s,;\-–—]+\d+)*\s*\]/g;

/** The model's own prose must never be able to forge a trusted-looking citation marker: only
 *  this module's structured citationIds check can ever produce one, and only the caller
 *  (service.ts/UI) renders [n] markers, built from citationIds - never copied from provider
 *  text. This strips any bracket sequence that could be mistaken for one - single markers,
 *  comma/semicolon lists, and numeric ranges alike - from a claim's displayed text, so even
 *  a claim that otherwise passes validation cannot carry a self-authored marker. Exported so
 *  it can be tested directly, independent of the full grounding pipeline. */
export function stripCitationLikeBrackets(text: string): string {
  return text.replace(CITATION_LIKE_BRACKETS, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * Strict, structured, claim-level grounding validation - the only gate an AnswerProvider's
 * output passes through before it can reach a user. Three properties, deliberately kept
 * separate and never conflated:
 *
 *   a) citation INTEGRITY - each claim's citationIds must be a well-formed array of bare
 *      positive integers. There is no free-text citation syntax (no "[1,999]" or "[1-999]"
 *      embedded in prose) for a malformed reference to hide in, because citations are never
 *      parsed out of text - they are a typed field on a structured claim, and any such
 *      bracket sequence found INSIDE a claim's text is stripped (see stripCitationLikeBrackets)
 *      rather than trusted.
 *   b) evidence PRESENCE - every cited id must exist among the sources actually retained in
 *      RagContext.citations, which (see context.ts) only ever contains sources whose real
 *      evidence text survived context-budget truncation. Every claim must cite at least one
 *      such id; a claim with none is rejected, not silently accepted as "uncited but true".
 *   c) semantic truthfulness of a claim's prose is NEVER checked or asserted here. Passing
 *      (a) and (b) proves a claim is *grounded* - backed by a real, retrieved source with
 *      real included text - it does not and cannot prove the claim is factually correct.
 *
 * Citation-like brackets are stripped from a claim's text BEFORE the emptiness check below,
 * not after: a claim whose only "content" was a citation-like marker (e.g. "[999]", "[1]",
 * or several markers with nothing else) must be rejected as having no real text, rather than
 * accepted with the marker later stripped down to an empty or punctuation-only string.
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
    if (typeof text !== 'string') return { valid: false, reason: 'malformed-response' };
    // Sanitize FIRST, trim, then require genuine substantive content (at least one letter or
    // digit) to remain. A claim that is only a citation-like marker, or only
    // whitespace/punctuation once such markers are removed, is not a real statement.
    const sanitizedText = stripCitationLikeBrackets(text);
    if (!/[\p{L}\p{N}]/u.test(sanitizedText)) return { valid: false, reason: 'malformed-response' };
    if (!Array.isArray(citationIds)) return { valid: false, reason: 'malformed-citations' };
    // (a) citation integrity: every id must be a bare positive integer - no ranges, lists,
    // decimals or non-numeric values can pass here, structurally.
    if (!citationIds.every(id => Number.isInteger(id) && (id as number) > 0)) return { valid: false, reason: 'malformed-citations' };
    if (citationIds.length === 0) return { valid: false, reason: 'missing-citations' };
    // (b) evidence presence: every cited id must reference a source whose evidence text was
    // actually included in the context that was sent - never a source outside it.
    if (!(citationIds as number[]).every(id => validIndices.has(id))) return { valid: false, reason: 'unknown-citation' };
    // F21: every claim that passes (a)+(b) is 'retrieved' (a real, included source backs it)
    // AND 'semantic_verification_not_run' (no entailment check ran, and none ever will
    // without a future, explicitly provider-based stage) - both stated plainly, together,
    // never just one or the other, so nothing here can be read as a correctness proof.
    validated.push({ text: sanitizedText, citationIds: citationIds as number[], evidenceStatuses: ['retrieved', 'semantic_verification_not_run'] });
  }
  return { valid: true, claims: validated };
}
