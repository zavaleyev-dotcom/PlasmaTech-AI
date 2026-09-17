import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../types';

/** Expands a SHA-256 seed into `count` bytes via repeated re-hashing (seed || counter) -
 *  simple, dependency-free, and fully deterministic for a given input string. */
function expandBytes(seed: string, count: number): Buffer {
  const out = Buffer.alloc(count);
  let offset = 0;
  let counter = 0;
  while (offset < count) {
    const digest = createHash('sha256').update(seed).update(String(counter)).digest();
    const take = Math.min(digest.length, count - offset);
    digest.copy(out, offset, 0, take);
    offset += take;
    counter++;
  }
  return out;
}

/** Turns arbitrary text into a deterministic, unit-length vector of the given dimension.
 *  Two calls with the same text and dimension always produce the exact same vector; two
 *  different texts produce (with overwhelming probability) different vectors. Not a real
 *  semantic embedding - it carries no notion of meaning - but it is fully sufficient to
 *  exercise the storage/reuse/staleness/retrieval machinery without any network or model. */
export function deterministicVector(text: string, dimension: number): Float32Array {
  const bytes = expandBytes(text, dimension * 4);
  const vector = new Float32Array(dimension);
  let sumSquares = 0;
  for (let i = 0; i < dimension; i++) {
    // Map 4 bytes to a value in [-1, 1).
    const uint32 = bytes.readUInt32LE(i * 4);
    const value = (uint32 / 0xffffffff) * 2 - 1;
    vector[i] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  for (let i = 0; i < dimension; i++) vector[i] /= norm;
  return vector;
}

export interface DeterministicProviderOptions {
  dimension?: number;
  /** Forces embedDocuments/embedQuery to throw for a given text - models a provider failure. */
  failOn?: (text: string) => boolean;
  /** Forces a zero-length vector for a given text - models a malformed/empty provider result. */
  emptyVectorOn?: (text: string) => boolean;
  /** Forces a vector one element longer than `dimension` - models a provider returning the
   *  wrong dimension (e.g. after a silent model change upstream). */
  wrongDimensionOn?: (text: string) => boolean;
}

/** No network, no API key, fully reproducible - the only provider used in tests and in the
 *  small local smoke-test sample run. Never sends anything anywhere. */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'deterministic' as const;
  readonly model: string;
  readonly dimension: number;
  readonly outboundDataDescription = 'Ничего не покидает компьютер: детерминированный тестовый провайдер работает полностью локально.';

  constructor(private readonly options: DeterministicProviderOptions = {}) {
    this.dimension = options.dimension ?? 16;
    this.model = `deterministic-${this.dimension}d`;
  }

  configured(): boolean {
    return true;
  }

  private embedOne(text: string): Float32Array {
    if (this.options.failOn?.(text)) throw new Error('deterministic provider: forced failure');
    if (this.options.emptyVectorOn?.(text)) return new Float32Array(0);
    if (this.options.wrongDimensionOn?.(text)) return deterministicVector(text, this.dimension + 1);
    return deterministicVector(text, this.dimension);
  }

  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(text => this.embedOne(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embedOne(text);
  }
}
