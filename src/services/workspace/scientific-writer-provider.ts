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
    if (!this.apiKey) throw new Error('Генерация текста не настроена: не задан OPENAI_API_KEY.');

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
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('OpenAI не ответил вовремя.');
      throw new Error('Не удалось связаться с OpenAI.');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('OpenAI отклонил доступ - проверьте OPENAI_API_KEY.');
      if (response.status === 429) throw new Error('OpenAI: превышен лимит запросов, попробуйте позже.');
      throw new Error('OpenAI вернул ошибку при генерации текста.');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) throw new Error('OpenAI вернул неожиданный формат ответа.');

    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error('Не удалось разобрать ответ OpenAI.'); }

    const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI вернул пустой ответ.');
    return { text };
  }
}

export const unconfiguredWriterProvider: WriterProvider = {
  id: 'unconfigured',
  configured: () => false,
  async generate(): Promise<WriterGenerationResult> {
    throw new Error('Генерация текста не настроена: не задан OPENAI_API_KEY.');
  },
};

export function getWriterProvider(): WriterProvider {
  const provider = new OpenAIWriterProvider();
  return provider.configured() ? provider : unconfiguredWriterProvider;
}
