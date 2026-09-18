import 'server-only';
import { validateEmbeddingVector } from '../vector';
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
    // Never assume data[i] corresponds to input[i] by array position alone - match by the
    // "index" field the API actually returns, which is the only reliable correspondence
    // (the API does not guarantee response order matches request order).
    const byIndex = new Map<number, unknown>();
    for (const item of data) {
      const record = asRecord(item);
      const index = record.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= input.length) {
        throw new Error('OpenAI вернул некорректный индекс вектора.');
      }
      if (byIndex.has(index)) throw new Error('OpenAI вернул повторяющийся индекс вектора.');
      byIndex.set(index, record.embedding);
    }
    if (byIndex.size !== input.length) throw new Error('OpenAI вернул неполный результат.');
    const vectors: Float32Array[] = [];
    for (let i = 0; i < input.length; i++) {
      const embedding = byIndex.get(i);
      if (!Array.isArray(embedding)) throw new Error('OpenAI вернул некорректный вектор.');
      // Validate every RAW element before Float32Array.from() ever runs: that constructor
      // coerces via Number(...), so a string like "2" silently becomes 2 and null silently
      // becomes 0 - exactly the kind of malformed upstream payload that must be rejected
      // outright, never coerced into a number that then looks legitimate.
      for (const value of embedding) {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('OpenAI вернул вектор с недопустимым элементом.');
      }
      const vector = Float32Array.from(embedding as number[]);
      // Re-validate AFTER the float64->float32 conversion: a magnitude beyond float32 range
      // (e.g. 1e40) becomes Infinity, and one far below it (e.g. 1e-50) rounds to 0 - both
      // are only detectable once the value has actually been narrowed to a Float32Array.
      const validation = validateEmbeddingVector(vector, this.dimension);
      if (!validation.valid) throw new Error('OpenAI вернул математически некорректный вектор.');
      vectors.push(validation.vector);
    }
    return vectors;
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
