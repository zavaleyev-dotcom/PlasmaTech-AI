import type { RagContext } from '../types';

export interface AnswerProviderInput {
  question: string;
  context: RagContext;
}

/** The provider's own claim shape, BEFORE validation - deliberately narrower than the fully
 *  validated `AnswerClaim` (types.ts): it has no `evidenceStatuses`, because that field only
 *  has a meaning once validateAnswerGrounding() (citations.ts) has actually confirmed the
 *  claim is grounded. citationIds is typed optimistically here for a well-behaved provider,
 *  but citations.ts always re-checks the real (possibly malformed) value at runtime as
 *  `unknown` - this type is not itself a trust boundary. */
export interface RawAnswerClaim {
  text: string;
  citationIds: number[];
}

/** Structured, claim-level provider output. There is no free-text citation syntax anywhere
 *  in this contract for a malformed reference to hide in (no "answer" string containing
 *  "[1,999]"-style markers): each claim carries its own typed citationIds array, and the
 *  provider's prose can never itself become a trusted citation marker (citations.ts strips
 *  any bracket sequence that looks like one from a claim's text before it is trusted). */
export interface AnswerProviderOutput {
  claims: RawAnswerClaim[];
}

/** Narrow generation boundary, deliberately independent of any specific vendor SDK, so
 *  OpenAI, Anthropic or a local model can each implement this same contract later. */
export interface AnswerProvider {
  readonly id: string;
  /** Whether this provider has everything it needs (e.g. an API key) to be called at all. */
  configured(): boolean;
  /** Returns the provider's raw structured output - NOT yet validated against the actual
   *  retrieved sources; the caller (service.ts) always runs it through
   *  validateAnswerGrounding() before it can reach a user. Throws only for a technical
   *  failure (network, timeout, non-2xx, unexpected content type, unparsable HTTP response) -
   *  never for the model's own answer being empty/uncited/malformed, which is a grounding
   *  concern, not a provider-transport error (see citations.ts). Implementations must never
   *  let a thrown error's message include upstream response bodies, stack traces, URLs or
   *  API keys. */
  generate(input: AnswerProviderInput): Promise<AnswerProviderOutput>;
}
