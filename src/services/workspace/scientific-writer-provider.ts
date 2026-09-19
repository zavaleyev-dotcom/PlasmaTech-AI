/** Server-only real text-generation provider for Scientific Writer, modeled directly on the
 *  project's existing RAG answer provider (src/services/rag/providers/openai.ts): same
 *  OPENAI_API_KEY/OPENAI_MODEL env vars (this is the same OpenAI account already used for RAG
 *  answers - no new credential), same raw-fetch transport (no SDK dependency), same
 *  timeout/Content-Type/error-normalization pattern, and the same configured()/unconfigured
 *  fallback shape so the UI can honestly report "provider unavailable" instead of ever
 *  pretending text was AI-generated when it wasn't. */

import 'server-only';

export interface WriterGenerationRequest { system: string; user: string }
export interface WriterGenerationResult { text: string }

export interface WriterProvider {
  readonly id: string;
  configured(): boolean;
  generate(request: WriterGenerationRequest): Promise<WriterGenerationResult>;
}

/** Distinguishes WHY generation failed, so the route/UI can react correctly instead of treating
 *  every failure the same way: 'not_configured' (no key - nothing to retry), 'unavailable'
 *  (network/timeout/rate-limit/upstream outage - transient, retrying later may help), 'error'
 *  (a response came back but was rejected/unusable - e.g. bad credentials, malformed or empty
 *  content - retrying the same request won't help without a real fix). */
export type WriterProviderErrorKind = 'not_configured' | 'unavailable' | 'error';

export class WriterProviderError extends Error {
  readonly kind: WriterProviderErrorKind;
  constructor(message: string, kind: WriterProviderErrorKind) {
    super(message);
    this.name = 'WriterProviderError';
    this.kind = kind;
  }
}

export class OpenAIWriterProvider implements WriterProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiKey: string | undefined = process.env.OPENAI_API_KEY?.trim(),
    private readonly model: string = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    private readonly timeoutMs = 60_000,
  ) {}

  configured(): boolean {
    return !!this.apiKey;
  }

  async generate({ system, user }: WriterGenerationRequest): Promise<WriterGenerationResult> {
    if (!this.apiKey) throw new WriterProviderError('Генерация текста не настроена: не задан OPENAI_API_KEY.', 'not_configured');

    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new WriterProviderError('OpenAI не ответил вовремя.', 'unavailable');
      throw new WriterProviderError('Не удалось связаться с OpenAI.', 'unavailable');
    }

    if (!response.ok) {
      // 401/403: the credential itself is bad - not transient, retrying won't help without a fix.
      if (response.status === 401 || response.status === 403) throw new WriterProviderError('OpenAI отклонил доступ - проверьте OPENAI_API_KEY.', 'error');
      // 429 and any 5xx: rate limit / upstream outage - both are transient, worth retrying later.
      if (response.status === 429) throw new WriterProviderError('OpenAI: превышен лимит запросов, попробуйте позже.', 'unavailable');
      if (response.status >= 500) throw new WriterProviderError('OpenAI временно недоступен, попробуйте позже.', 'unavailable');
      throw new WriterProviderError('OpenAI вернул ошибку при генерации текста.', 'error');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) throw new WriterProviderError('OpenAI вернул неожиданный формат ответа.', 'error');

    let body: unknown;
    try { body = await response.json(); }
    catch { throw new WriterProviderError('Не удалось разобрать ответ OpenAI.', 'error'); }

    const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new WriterProviderError('OpenAI вернул пустой ответ.', 'error');
    return { text };
  }
}

export const unconfiguredWriterProvider: WriterProvider = {
  id: 'unconfigured',
  configured: () => false,
  async generate(): Promise<WriterGenerationResult> {
    throw new WriterProviderError('Генерация текста не настроена: не задан OPENAI_API_KEY.', 'not_configured');
  },
};

export function getWriterProvider(): WriterProvider {
  const provider = new OpenAIWriterProvider();
  return provider.configured() ? provider : unconfiguredWriterProvider;
}
