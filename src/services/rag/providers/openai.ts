import 'server-only';
import { SYSTEM_PROMPT, buildUserTurn } from '../prompt';
import type { AnswerProvider, AnswerProviderInput, AnswerProviderOutput } from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Best-effort parse of the model's own JSON payload ({"claims": [...]}). This is NOT a
 *  provider-transport failure if it doesn't parse or doesn't match the shape - the model
 *  simply failed to follow instructions. Falling back to a single uncited claim lets
 *  validateAnswerGrounding() (citations.ts) reject it the same way it rejects any other
 *  uncited claim, instead of this adapter inventing its own error path for "the model
 *  ignored the format". */
function parseModelOutput(content: string): AnswerProviderOutput {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).claims)) {
      return parsed as AnswerProviderOutput;
    }
  } catch { /* not valid JSON - fall through to the uncited fallback below */ }
  return { claims: [{ text: content, citationIds: [] }] };
}

/** Real, testable OpenAI Chat Completions adapter. Mirrors the DI/timeout/error-handling
 *  style already used by CrossrefProvider/OpenAlexProvider: an injectable fetcher, a fixed
 *  timeout, and structured errors that never leak the API key, upstream response bodies, or
 *  raw parser exceptions to the caller. */
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

  async generate({ question, context }: AnswerProviderInput): Promise<AnswerProviderOutput> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY не настроен.');
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserTurn(question, context) },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('OpenAI не ответил вовремя.');
      // Never re-throw the original error: it may embed a URL, host, or other connection detail.
      throw new Error('Не удалось связаться с OpenAI.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('OpenAI отклонил доступ. Проверьте OPENAI_API_KEY.');
    if (response.status === 429) throw new Error('Лимит запросов OpenAI исчерпан. Повторите позже.');
    if (!response.ok) throw new Error('OpenAI не смог обработать запрос.');
    // A successful response must be declared as JSON. A non-2xx aside, some proxies/gateways
    // return a 200 with an HTML or plain-text error page instead of the expected API
    // response; treating that as success would hand an arbitrary string to the JSON parser
    // below and to the model-output parser. Reject on the header alone, before even trying.
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType.trim())) throw new Error('OpenAI вернул неожиданный тип ответа.');
    let body: Record<string, unknown>;
    try { body = asRecord(await response.json()); }
    catch { throw new Error('OpenAI вернул некорректный ответ.'); } // malformed JSON despite the declared content type
    const choices = body.choices;
    const content = Array.isArray(choices) ? asRecord(asRecord(choices[0]).message).content : undefined;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Пустой ответ модели.');
    return parseModelOutput(content);
  }
}
