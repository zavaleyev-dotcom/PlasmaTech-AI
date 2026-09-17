import type { RagContext } from '../types';

export interface AnswerProviderInput {
  question: string;
  context: RagContext;
}

/** Structured provider output: citationIds is a typed array of source indices, not text to
 *  be regex-parsed out of `answer`. This is what makes citation validation (citations.ts)
 *  a strict, mechanical check instead of best-effort text scanning - there is no free-text
 *  citation syntax left for a malformed reference to hide in. */
export interface AnswerProviderOutput {
  answer: string;
  citationIds: number[];
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
   *  failure (network, timeout, non-2xx, unparsable HTTP response) - never for the model's
   *  own answer being empty/uncited/malformed, which is a grounding concern, not a
   *  provider-transport error (see citations.ts). Implementations must never let a thrown
   *  error's message include upstream response bodies, stack traces, URLs or API keys. */
  generate(input: AnswerProviderInput): Promise<AnswerProviderOutput>;
}
