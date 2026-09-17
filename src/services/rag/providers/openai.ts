import 'server-only';
import { SYSTEM_PROMPT, buildUserTurn } from '../prompt';
import type { AnswerProvider, AnswerProviderInput } from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Real, testable OpenAI Chat Completions adapter. Mirrors the DI/timeout/error-handling
 *  style already used by CrossrefProvider/OpenAlexProvider: an injectable fetcher, a fixed
 *  timeout, and structured errors that never leak the API key or raw upstream bodies. */
export class OpenAIAnswerProvider implements AnswerProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiKey: string | undefined = process.env.OPENAI_API_KEY?.trim(),
    private readonly model: string = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    private readonly timeoutMs = 30_000,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async generate({ question, context }: AnswerProviderInput): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY не настроен.');
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserTurn(question, context) },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('OpenAI не ответил вовремя.');
      throw new Error('Не удалось связаться с OpenAI.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('OpenAI отклонил доступ. Проверьте OPENAI_API_KEY.');
    if (response.status === 429) throw new Error('Лимит запросов OpenAI исчерпан. Повторите позже.');
    if (!response.ok) throw new Error('OpenAI не смог обработать запрос.');
    const body = asRecord(await response.json());
    const choices = body.choices;
    const text = Array.isArray(choices) ? asRecord(asRecord(choices[0]).message).content : undefined;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Пустой ответ модели.');
    return text;
  }
}
