import type { AnswerProvider, AnswerProviderOutput } from './types';

/** Default provider when no generative model is set up. askLibrary() checks configured()
 *  before ever calling generate(); this still throws defensively if it were called anyway. */
export const unconfiguredProvider: AnswerProvider = {
  id: 'unconfigured',
  configured: () => false,
  async generate(): Promise<AnswerProviderOutput> { throw new Error('Генерация ответа не настроена.'); },
};
