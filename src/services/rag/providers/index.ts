import 'server-only';
import { OpenAIAnswerProvider } from './openai';
import { unconfiguredProvider } from './unconfigured';
import type { AnswerProvider } from './types';

/** Picks the first configured provider (currently just OpenAI), falling back to the
 *  unconfigured default. Anthropic or a local model are added the same way: implement
 *  AnswerProvider, then check its configured() here before the fallback. */
export function getAnswerProvider(): AnswerProvider {
  const openai = new OpenAIAnswerProvider();
  if (openai.configured()) return openai;
  return unconfiguredProvider;
}

export type { AnswerProvider, AnswerProviderInput } from './types';
export { OpenAIAnswerProvider } from './openai';
export { unconfiguredProvider } from './unconfigured';
