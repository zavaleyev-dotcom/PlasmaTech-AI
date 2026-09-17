import 'server-only';
import { OpenAIEmbeddingProvider } from './openai';
import type { EmbeddingProvider } from '../types';

/**
 * Returns the configured EmbeddingProvider, or null if none is configured.
 *
 * Deliberately requires an EXPLICIT `EMBEDDING_PROVIDER` environment variable - it never
 * auto-selects OpenAI just because `OPENAI_API_KEY` happens to be set (that key is already
 * used, separately, by the RAG answer provider - see src/services/rag/providers - which
 * only ever sends small per-question context, a fundamentally smaller and different privacy
 * footprint than embedding the whole library). Turning on semantic indexing against an
 * external API is therefore always a second, distinct, explicit opt-in, and even then
 * indexing itself is never triggered automatically by this function - see
 * src/services/embeddings/index.ts and scripts/index-embeddings.ts.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  const selected = process.env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (selected === 'openai') {
    const provider = new OpenAIEmbeddingProvider();
    return provider.configured() ? provider : null;
  }
  return null;
}

export { OpenAIEmbeddingProvider } from './openai';
export { DeterministicEmbeddingProvider, deterministicVector } from './deterministic';
export type { DeterministicProviderOptions } from './deterministic';
