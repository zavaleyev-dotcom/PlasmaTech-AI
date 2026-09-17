import 'server-only';
import type { EmbeddingProvider } from '../types';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Real, testable OpenAI Embeddings adapter. Mirrors the DI/timeout/Content-Type/error-
 *  normalization style already used by OpenAIAnswerProvider (src/services/rag/providers):
 *  an injectable fetcher, a fixed timeout, a strict Content-Type check, and errors that
 *  never leak the API key, upstream response bodies, or raw parser exceptions.
 *
 *  Outbound data: every call sends the raw chunk text (or the user's question text, for
 *  embedQuery) to https://api.openai.com/v1/embeddings over HTTPS. No filename, path, DOI,
 *  or other metadata is ever included in the request body - see embedDocuments/embedQuery
 *  below, which only ever serialize the `texts`/`text` argument itself. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  readonly dimension: number;
  readonly outboundDataDescription: string;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly apiKey: string | undefined = process.env.OPENAI_API_KEY?.trim(),
    model: string = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    dimension: number = Number(process.env.EMBEDDING_DIMENSION) || 1536,
    private readonly timeoutMs = 30_000,
  ) {
    this.model = model;
    this.dimension = dimension;
    this.outboundDataDescription = `Текст каждого чанка (или вопроса) отправляется по HTTPS в OpenAI Embeddings API (модель ${model}). Имена файлов, пути, DOI и прочие метаданные не отправляются - только сырой текст.`;
  }

  configured(): boolean {
    return !!this.apiKey;
  }

  private async request(input: string[]): Promise<Float32Array[]> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY не настроен.');
    let response: Response;
    try {
      response = await this.fetcher('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input, dimensions: this.dimension }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('OpenAI не ответил вовремя.');
      throw new Error('Не удалось связаться с OpenAI.');
    }
    if (response.status === 401 || response.status === 403) throw new Error('OpenAI отклонил доступ. Проверьте OPENAI_API_KEY.');
    if (response.status === 429) throw new Error('Лимит запросов OpenAI исчерпан. Повторите позже.');
    if (!response.ok) throw new Error('OpenAI не смог обработать запрос.');
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType.trim())) throw new Error('OpenAI вернул неожиданный тип ответа.');
    let body: Record<string, unknown>;
    try { body = asRecord(await response.json()); }
    catch { throw new Error('OpenAI вернул некорректный ответ.'); }
    const data = body.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('OpenAI вернул неполный результат.');
    return data.map(item => {
      const embedding = asRecord(item).embedding;
      if (!Array.isArray(embedding)) throw new Error('OpenAI вернул некорректный вектор.');
      return Float32Array.from(embedding as number[]);
    });
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    return this.request([...texts]);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.request([text]);
    return vector;
  }
}
