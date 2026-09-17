import type { AnswerClaim, RagContext } from '../types';

export interface AnswerProviderInput {
  question: string;
  context: RagContext;
}

/** Structured, claim-level provider output. There is no free-text citation syntax anywhere
 *  in this contract for a malformed reference to hide in (no "answer" string containing
 *  "[1,999]"-style markers): each claim carries its own typed citationIds array, and the
 *  provider's prose can never itself become a trusted citation marker (citations.ts strips
 *  any bracket sequence that looks like one from a claim's text before it is trusted). */
export interface AnswerProviderOutput {
  claims: AnswerClaim[];
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
