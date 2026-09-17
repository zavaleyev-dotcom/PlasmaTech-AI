import type { RagContext } from '../types';

export interface AnswerProviderInput {
  question: string;
  context: RagContext;
}

/** Narrow generation boundary, deliberately independent of any specific vendor SDK, so
 *  OpenAI, Anthropic or a local model can each implement this same contract later. */
export interface AnswerProvider {
  readonly id: string;
  /** Whether this provider has everything it needs (e.g. an API key) to be called at all. */
  configured(): boolean;
  /** Returns the raw answer text (with [n] citation markers). Throws on failure - callers
   *  must not let a thrown error surface as a crash (see service.ts). */
  generate(input: AnswerProviderInput): Promise<string>;
}
