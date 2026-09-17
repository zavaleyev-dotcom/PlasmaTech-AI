import { openTextStore } from '../src/services/library-text';
import {
  DEFAULT_EMBEDDING_BATCH_SIZE, DeterministicEmbeddingProvider, EmbeddingStore, MAX_SAMPLE_SIZE,
  embeddingsConfig, getEmbeddingProvider, runEmbeddingIndex,
} from '../src/services/embeddings';

/**
 * Sample-only embedding indexing. Deliberately does NOT support a full-library run: there
 * is no `--all` flag here (contrast scripts/index-library-text.ts, which does have one).
 * A full build of all 54 958 chunks - and, if EMBEDDING_PROVIDER=openai, sending all of
 * them to an external API - requires a separate, explicit decision and is out of scope for
 * this stage. This script's own hard ceiling (MAX_SAMPLE_SIZE) applies even if a larger
 * number is passed by mistake.
 */
async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 2 && args[0] === '--sample' && /^\d+$/.test(args[1]))) {
    throw new Error(`Use --sample <n> (1-${MAX_SAMPLE_SIZE}). Full-library builds are not supported by this script.`);
  }
  const sample = Math.max(1, Math.min(MAX_SAMPLE_SIZE, Number(args[1])));

  const provider = getEmbeddingProvider() ?? new DeterministicEmbeddingProvider();
  console.log(`Provider: ${provider.id} / ${provider.model} (dimension ${provider.dimension})`);
  console.log(`Outbound data: ${provider.outboundDataDescription}`);
  if (provider.id === 'deterministic') {
    console.log('No EMBEDDING_PROVIDER configured - using the local, network-free deterministic test provider.');
    console.log('These vectors carry no real semantic meaning; this run only exercises/benchmarks the pipeline.');
  }

  const textStore = await openTextStore();
  const config = await embeddingsConfig();
  const embeddingStore = new EmbeddingStore(config.databaseFile, config.rootId);
  const timer = setInterval(() => console.log(JSON.stringify(embeddingStore.progress())), 5_000);
  const startedAt = Date.now();
  try {
    const progress = await runEmbeddingIndex({ textStore, embeddingStore, provider, sample, batchSize: DEFAULT_EMBEDDING_BATCH_SIZE });
    console.log(JSON.stringify(progress));
    console.log(`Wall time: ${Date.now() - startedAt} ms`);
    if (progress.error) process.exitCode = 1;
  } finally { clearInterval(timer); textStore.close(); embeddingStore.close(); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
