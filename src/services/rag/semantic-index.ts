import 'server-only';
import { createHash } from 'node:crypto';
import { openTextStore } from '@/services/library-text';
import type { TextStore } from '@/services/library-text/store';
import {
  EmbeddingStore, computeEmbeddingOverview, getEmbeddingProvider, openEmbeddingStore,
  runEmbeddingIndex, validateEmbeddingVector,
} from '@/services/embeddings';
import type { EmbeddingProgress, EmbeddingProvider } from '@/services/embeddings/types';
import { chunkConsistencyChecker } from './hybrid';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The public, browser-safe control surface for semantic (embedding) indexing - built ON TOP
 * of the existing embeddings module (computeEmbeddingOverview, runEmbeddingIndex,
 * EmbeddingStore, getEmbeddingProvider) without duplicating or changing any of its logic.
 * Lives in rag/, not embeddings/, for the same reason chunkConsistencyChecker does
 * (hybrid.ts): it needs to open BOTH the text index and the embedding store, and the
 * embeddings module deliberately never imports library-text itself.
 *
 * Safety contract for everything returned here:
 *  - never a stack trace, an absolute file path, an API key, or a raw provider response -
 *    every error message is one of the fixed, pre-written Russian strings below or one
 *    already-normalized deep inside runEmbeddingIndex/EmbeddingStore (which never include any
 *    of those either - see their own doc comments);
 *  - never triggers a network call on its own - getSemanticIndexInfo() is read-only, and
 *    startSemanticIndex() only ever calls the provider if the caller has ALREADY supplied
 *    `confirmExternal: true` for a non-local provider (see below);
 *  - never a hidden default to the full 54 958-chunk library - only the three explicit
 *    sample tiers below are accepted.
 */

/** Public status vocabulary for the UI. Deliberately spelled `building` (not the internal
 *  EmbeddingOverview status's `rebuilding`) to match this feature's own public contract -
 *  mapped, never renamed, at the boundary in getSemanticIndexInfo() below. `error` is a case
 *  the internal EmbeddingIndexStatus type declares but computeEmbeddingOverview() itself
 *  never produces (it assumes the store opened successfully) - here, a store/text-index open
 *  or read failure is what actually produces it. */
export type SemanticIndexStatus = 'not_configured' | 'empty' | 'partial' | 'ready' | 'stale' | 'building' | 'error';

/** The only sample sizes the web UI may ever request. No `--all`/full-library option here,
 *  the same deliberate omission as scripts/index-embeddings.ts (which caps at a much smaller
 *  MAX_SAMPLE_SIZE=300 for its own CLI use) - a full 54 958-chunk build requires a separate,
 *  explicit decision and is out of scope for this control surface entirely. */
export const SEMANTIC_INDEX_SAMPLE_TIERS = [200, 2000, 10000] as const;
export type SemanticIndexSampleTier = typeof SEMANTIC_INDEX_SAMPLE_TIERS[number];

export interface SemanticIndexProgressView {
  running: boolean;
  cancelled: boolean;
  total: number;
  processed: number;
  reused: number;
  embedded: number;
  failed: number;
  skipped: number;
  orphanRemoved: number;
  /** 0-100, against the requested sample size when known, else against `total` (chunks
   *  discovered so far) - never NaN/Infinity, never negative, never over 100. */
  percent: number;
  elapsedMs: number;
}

export interface SemanticIndexInfo {
  status: SemanticIndexStatus;
  totalChunks: number;
  embeddedChunks: number;
  /** 0-100, rounded; embeddedChunks/totalChunks by construction, so this can never exceed
   *  100 (embeddedChunks is itself never counted above totalChunks - see
   *  computeEmbeddingOverview/EmbeddingStore.validCount). */
  coveragePercent: number;
  provider: string | null;
  model: string | null;
  dimension: number | null;
  invalidVectorCount: number;
  staleCount: number;
  orphanCount: number;
  lastBuildTime: string | null;
  lastError: string | null;
  /** True whenever a provider IS configured and it is not the local, network-free
   *  deterministic test provider - i.e., starting a job would send chunk text to an external
   *  API. The UI must show outboundDataDescription and require explicit confirmation before
   *  ever calling startSemanticIndex with confirmExternal:true in that case. */
  requiresExternalConfirmation: boolean;
  /** Factual, human-readable description of what leaves this machine if a job is started
   *  with the current provider - safe to show verbatim, never null when a provider exists. */
  outboundDataDescription: string | null;
  progress: SemanticIndexProgressView | null;
}

const STORE_UNAVAILABLE_MESSAGE = 'Хранилище семантического индекса недоступно или повреждено.';
const TEXT_INDEX_UNAVAILABLE_MESSAGE = 'Текстовый индекс недоступен. Постройте его в разделе «Поиск по содержимому».';

function toProgressView(progress: EmbeddingProgress | null): SemanticIndexProgressView | null {
  if (!progress) return null;
  const target = progress.sampleTarget ?? progress.total;
  const percent = target > 0 ? Math.max(0, Math.min(100, Math.round((progress.processed / target) * 100))) : (progress.running ? 0 : 100);
  const endedAtMs = progress.finishedAt ? new Date(progress.finishedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, endedAtMs - new Date(progress.startedAt).getTime());
  return {
    running: progress.running, cancelled: progress.cancelled,
    total: progress.total, processed: progress.processed, reused: progress.reused, embedded: progress.embedded,
    failed: progress.failed, skipped: progress.skipped, orphanRemoved: progress.orphanRemoved,
    percent, elapsedMs,
  };
}

function externalConfirmationInfo(provider: EmbeddingProvider | null) {
  return {
    requiresExternalConfirmation: !!provider && provider.id !== 'deterministic',
    outboundDataDescription: provider?.outboundDataDescription ?? null,
  };
}

export interface SemanticIndexInfoOptions {
  /** Injected for tests; defaults to the real getEmbeddingProvider() env-based auto-detection. */
  provider?: EmbeddingProvider | null;
  openTextStore?: () => Promise<TextStore>;
  openEmbeddingStore?: () => Promise<EmbeddingStore>;
}

/** Read-only, browser-safe snapshot of the semantic index - never throws (a store/text-index
 *  open or computation failure becomes `status: 'error'` with the fixed generic message
 *  above, never the raw exception). Reuses computeEmbeddingOverview/EmbeddingStore.validCount
 *  as the single source of truth for status/coverage; only adds the invalid/stale/orphan
 *  breakdown (which those return as one combined "stale" figure) and the public-safe fields
 *  (progress view, external-provider disclosure). */
export async function getSemanticIndexInfo(options: SemanticIndexInfoOptions = {}): Promise<SemanticIndexInfo> {
  const provider = options.provider !== undefined ? options.provider : getEmbeddingProvider();
  const { requiresExternalConfirmation, outboundDataDescription } = externalConfirmationInfo(provider);
  const empty = (status: SemanticIndexStatus, totalChunks: number, lastError: string | null): SemanticIndexInfo => ({
    status, totalChunks, embeddedChunks: 0, coveragePercent: 0,
    provider: provider?.id ?? null, model: provider?.model ?? null, dimension: provider?.dimension ?? null,
    invalidVectorCount: 0, staleCount: 0, orphanCount: 0, lastBuildTime: null, lastError,
    requiresExternalConfirmation, outboundDataDescription, progress: null,
  });

  const openText = options.openTextStore ?? openTextStore;
  let textStore: TextStore;
  try { textStore = await openText(); }
  catch { return empty('error', 0, TEXT_INDEX_UNAVAILABLE_MESSAGE); }

  let embeddingStore: EmbeddingStore | null = null;
  try {
    const openEmbeddings = options.openEmbeddingStore ?? openEmbeddingStore;
    embeddingStore = await openEmbeddings();
    const totalChunks = textStore.chunkCount();
    const isConsistent = chunkConsistencyChecker(textStore);
    const overview = computeEmbeddingOverview(embeddingStore, provider, totalChunks, isConsistent);
    const status: SemanticIndexStatus = overview.status === 'rebuilding' ? 'building' : overview.status;

    // Granular invalid/orphan/stale breakdown - computeEmbeddingOverview only reports one
    // combined "staleChunks" figure (total - valid); the UI wants to know which of these
    // specifically apply so it can show only the ones that are actually nonzero.
    let invalidVectorCount = 0; let orphanCount = 0; let staleCount = 0;
    if (provider) {
      for (const row of embeddingStore.currentRows(provider.id, provider.model, provider.dimension)) {
        if (!validateEmbeddingVector(row.vector, provider.dimension).valid) { invalidVectorCount++; continue; }
        const chunkRow = textStore.db.prepare('SELECT documentId, text FROM chunks WHERE id=?').get(row.chunkId) as { documentId: string; text: string } | undefined;
        if (!chunkRow) { orphanCount++; continue; }
        if (chunkRow.documentId !== row.documentId || sha256(chunkRow.text) !== row.contentHash) staleCount++;
      }
    }

    const coveragePercent = overview.stats.totalChunks > 0 ? Math.round((overview.stats.embeddedChunks / overview.stats.totalChunks) * 100) : 0;
    return {
      status, totalChunks: overview.stats.totalChunks, embeddedChunks: overview.stats.embeddedChunks, coveragePercent,
      provider: overview.stats.providerId, model: overview.stats.model, dimension: overview.stats.dimension,
      invalidVectorCount, orphanCount, staleCount,
      lastBuildTime: overview.progress?.finishedAt ?? null,
      lastError: overview.progress?.error ?? null,
      requiresExternalConfirmation, outboundDataDescription,
      progress: toProgressView(overview.progress),
    };
  } catch {
    return empty('error', textStore.chunkCount(), STORE_UNAVAILABLE_MESSAGE);
  } finally {
    embeddingStore?.close();
    textStore.close();
  }
}

export type StartSemanticIndexResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_sample' | 'not_configured' | 'confirmation_required' | 'already_running'; message: string };

export interface StartSemanticIndexOptions {
  sampleSize: number;
  /** Must be explicitly true for a job to proceed when the configured provider is external
   *  (see requiresExternalConfirmation above) - absent/false means the request is refused
   *  BEFORE opening anything or making any provider call. */
  confirmExternal?: boolean;
  /** Injected for tests; undefined means "use the real getEmbeddingProvider() auto-detection". */
  provider?: EmbeddingProvider | null;
  openTextStore?: () => Promise<TextStore>;
  openEmbeddingStore?: () => Promise<EmbeddingStore>;
}

/** Starts a bounded, resumable embedding-indexing run in the background (fire-and-forget,
 *  mirrors library-text's startTextIndex() exactly) and returns immediately once it is
 *  safely underway - the caller (the API route) should respond 202 and let the client poll
 *  getSemanticIndexInfo() for progress, the same pattern already used for text indexing.
 *
 * Every rejection reason is checked BEFORE anything is opened or any provider call is made:
 * an invalid sample size, no configured provider, or a missing external-provider confirmation
 * all short-circuit with zero side effects. Only "already running" requires opening the
 * embedding store first (to read its persisted progress) - even then, no provider call has
 * happened yet. */
export async function startSemanticIndex(options: StartSemanticIndexOptions): Promise<StartSemanticIndexResult> {
  if (!SEMANTIC_INDEX_SAMPLE_TIERS.includes(options.sampleSize as SemanticIndexSampleTier)) {
    return { ok: false, reason: 'invalid_sample', message: `Допустимый объём индексирования: ${SEMANTIC_INDEX_SAMPLE_TIERS.join(', ')} фрагментов.` };
  }
  const provider = options.provider !== undefined ? options.provider : getEmbeddingProvider();
  if (!provider) return { ok: false, reason: 'not_configured', message: 'Провайдер эмбеддингов не настроен. Индексирование недоступно.' };

  const { requiresExternalConfirmation, outboundDataDescription } = externalConfirmationInfo(provider);
  if (requiresExternalConfirmation && !options.confirmExternal) {
    return { ok: false, reason: 'confirmation_required', message: `Требуется подтверждение отправки данных во внешний API. ${outboundDataDescription ?? ''}`.trim() };
  }

  const openEmbeddings = options.openEmbeddingStore ?? openEmbeddingStore;
  const embeddingStore = await openEmbeddings();
  const current = embeddingStore.overviewProgress();
  if (current?.running) { embeddingStore.close(); return { ok: false, reason: 'already_running', message: 'Индексирование уже запущено.' }; }

  const openText = options.openTextStore ?? openTextStore;
  const textStore = await openText();
  void runEmbeddingIndex({ textStore, embeddingStore, provider, sample: options.sampleSize })
    .catch(() => { /* runEmbeddingIndex never throws for a normal run failure - it records progress.error instead; this only guards the fire-and-forget promise itself */ })
    .finally(() => { textStore.close(); embeddingStore.close(); });
  return { ok: true };
}

export interface StopSemanticIndexOptions { openEmbeddingStore?: () => Promise<EmbeddingStore> }

/** Requests a safe stop of a currently-running job (same cooperative-cancellation mechanism
 *  runEmbeddingIndex already polls - see EmbeddingStore.requestStop()); a no-op, not an error,
 *  if nothing is running. */
export async function stopSemanticIndex(options: StopSemanticIndexOptions = {}): Promise<{ stopping: boolean }> {
  const open = options.openEmbeddingStore ?? openEmbeddingStore;
  const embeddingStore = await open();
  try { embeddingStore.requestStop(); return { stopping: true }; }
  finally { embeddingStore.close(); }
}
