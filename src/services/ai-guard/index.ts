/** Local guard for the application's paid AI calls (OpenAI chat completions for Scientific Writer and
 *  Ask Library, OpenAI embeddings for semantic search / indexing).
 *
 *  Scope: LOCAL / PRIVATE SINGLE-USER. This is an in-process safety net, not a billing system, not
 *  a per-user quota, and not a defence against a hostile public audience. It sits in front of the
 *  three outbound call sites and refuses BEFORE any request is sent to the provider.
 *
 *  Three different things are kept apart, on purpose:
 *   1. HARD LIMITS (exact, enforced): a cap on output tokens for every generation request, a cap on
 *      simultaneously running AI operations, and a cap on requests per minute per class.
 *   2. AN ESTIMATED BUDGET (an estimate, never a price): every request first RESERVES an estimated
 *      number of tokens (input characters / 2 - deliberately pessimistic - plus the output cap) from a
 *      rolling 24-hour token budget per class. The app does not know any price, so nothing here is
 *      money and nothing here claims to be what the provider actually charged.
 *   3. ACTUAL USAGE (reported by the provider): when the provider's answer carries a valid `usage`
 *      block the reservation is replaced by the real number. When it carries none (or an invalid one)
 *      the pessimistic estimate stays booked, so a missing usage block can never make spending
 *      invisible or unbounded. A request that failed after it may have been sent also keeps its
 *      reservation; only a request that was refused before sending is returned to the budget.
 *
 *  State lives in memory (shared through globalThis so every route bundle sees the same ledger) and
 *  starts empty after a restart of the server - see the report for that limit. */

export type AiOperation = 'writer' | 'rag_answer' | 'embed_query' | 'embed_documents';
export type AiClass = 'chat' | 'embedding';
const CLASS_OF: Record<AiOperation, AiClass> = { writer: 'chat', rag_answer: 'chat', embed_query: 'embedding', embed_documents: 'embedding' };

export interface AiGuardConfig {
  /** AI operations running at the same moment, across every class. */
  maxConcurrent: number;
  /** Accepted requests per rolling minute, per class. */
  ratePerMinute: Record<AiClass, number>;
  /** Rolling 24-hour token budget, per class (estimated until the provider reports real usage). */
  tokenBudget24h: Record<AiClass, number>;
  /** Output-token cap sent with every generation request. */
  maxOutputTokens: { writer: number; rag_answer: number };
  /** No request may ask for more output than this, whatever the caller passes. */
  hardMaxOutputTokens: number;
}

export const DEFAULT_AI_GUARD_CONFIG: AiGuardConfig = {
  maxConcurrent: 3,
  ratePerMinute: { chat: 15, embedding: 120 },
  tokenBudget24h: { chat: 1_000_000, embedding: 20_000_000 },
  maxOutputTokens: { writer: 4096, rag_answer: 1024 },
  hardMaxOutputTokens: 16_384,
};

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || !/^\d{1,12}$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** Reads the optional local overrides. A missing, malformed, zero or negative value falls back to the default - there is no "unlimited" switch. */
export function loadAiGuardConfig(env: Record<string, string | undefined> = process.env): AiGuardConfig {
  const d = DEFAULT_AI_GUARD_CONFIG;
  const hard = d.hardMaxOutputTokens;
  return {
    maxConcurrent: positiveInt(env.AI_MAX_CONCURRENT, d.maxConcurrent, 16),
    ratePerMinute: { chat: positiveInt(env.AI_CHAT_RATE_PER_MIN, d.ratePerMinute.chat, 600), embedding: positiveInt(env.AI_EMBED_RATE_PER_MIN, d.ratePerMinute.embedding, 6000) },
    tokenBudget24h: { chat: positiveInt(env.AI_CHAT_TOKEN_BUDGET_24H, d.tokenBudget24h.chat, 1_000_000_000), embedding: positiveInt(env.AI_EMBED_TOKEN_BUDGET_24H, d.tokenBudget24h.embedding, 10_000_000_000) },
    maxOutputTokens: { writer: positiveInt(env.AI_WRITER_MAX_OUTPUT_TOKENS, d.maxOutputTokens.writer, hard), rag_answer: positiveInt(env.AI_RAG_MAX_OUTPUT_TOKENS, d.maxOutputTokens.rag_answer, hard) },
    hardMaxOutputTokens: hard,
  };
}

export type AiLimitReason = 'busy' | 'rate_limited' | 'budget_exhausted' | 'output_limit';

const LIMIT_MESSAGES: Record<AiLimitReason, string> = {
  busy: 'Сейчас выполняется максимально допустимое число ИИ-операций. Повторите чуть позже.',
  rate_limited: 'Превышена локальная частота ИИ-запросов.',
  budget_exhausted: 'Достигнут локальный лимит ИИ-токенов за 24 часа. Запрос к ИИ-провайдеру не отправлялся.',
  output_limit: 'Запрошенный размер ответа ИИ превышает локальный предел. Запрос к ИИ-провайдеру не отправлялся.',
};

/** Thrown BEFORE anything is sent to the provider. The message is fixed text - it never contains a key, a path or a provider detail. */
export class AiLimitError extends Error {
  readonly reason: AiLimitReason;
  readonly retryAfterSec?: number;
  constructor(reason: AiLimitReason, retryAfterSec?: number) {
    super(reason === 'rate_limited' && retryAfterSec ? `${LIMIT_MESSAGES.rate_limited} Повторите через ${retryAfterSec} с.` : LIMIT_MESSAGES[reason]);
    this.name = 'AiLimitError';
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

/** The fixed user-facing sentence for a limit. Same text as the error message. */
export function aiLimitMessage(error: AiLimitError): string { return error.message; }

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PLAUSIBLE_TOKENS = 100_000_000;

interface LedgerEntry { id: number; at: number; cls: AiClass; tokens: number; actual: boolean }

export interface AiLease {
  /** The output cap that must be sent with the request (undefined for embeddings). */
  readonly maxOutputTokens: number | undefined;
  /** The provider answered. Pass its `usage` block as received (or nothing): a valid one replaces the estimate with the real number, anything else leaves the estimate booked. */
  complete(usage?: unknown): void;
  /** The request did not produce a usable answer. `sent=false` returns the reservation (nothing left this machine); otherwise the reservation stays booked. Safe to call after complete(). */
  fail(sent: boolean): void;
}

export interface AcquireOptions {
  /** Total characters that will be sent as input. */
  inputChars: number;
  /** Generation requests only. */
  maxOutputTokens?: number;
  /** Embedding batches only: how long to wait for a free rate slot instead of refusing at once (indexing paces itself this way). */
  waitForRateMs?: number;
}

export interface AiGuardSnapshot {
  inFlight: number;
  chat: { requestsLastMinute: number; actualTokens24h: number; estimatedTokens24h: number; budget: number };
  embedding: { requestsLastMinute: number; actualTokens24h: number; estimatedTokens24h: number; budget: number };
}

/** The confirmed token consumption of an OpenAI answer's `usage` block, or null when the block cannot be trusted - in which case the caller keeps the estimate booked.
 *
 *  Fields (the OpenAI contract, nothing invented): chat completions report `prompt_tokens`, `completion_tokens` and `total_tokens`; embeddings report `prompt_tokens` and
 *  `total_tokens` (there is no completion). A usage block is trusted only when ALL of this holds:
 *   - every field that is present is a finite, non-negative integer within a plausible ceiling (a string, NaN, Infinity, a fraction or a negative number poisons the WHOLE block);
 *   - the consumption is positive (a request that sent input cannot have used 0 tokens);
 *   - `total_tokens`, when present, is not smaller than the sum of the components that are present (a total below its own parts is a contradiction, never "the cheaper reading");
 *   - the components must be complete for the operation, ALWAYS and independently of `total_tokens`: prompt AND completion for chat, prompt (or a total) for embeddings.
 *  The confirmed number is the total when it is present, otherwise the sum of the components. */
export function totalTokensFromUsage(usage: unknown, cls: AiClass = 'chat'): number | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const valid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_PLAUSIBLE_TOKENS;
  for (const field of ['total_tokens', 'prompt_tokens', 'completion_tokens'] as const) {
    if (u[field] !== undefined && !valid(u[field])) return null;
  }
  const total = u.total_tokens as number | undefined;
  const prompt = u.prompt_tokens as number | undefined;
  const completion = u.completion_tokens as number | undefined;
  // Chat completions ALWAYS report both components. Without them a `total_tokens` cannot be cross-checked, so it is not trusted - whatever its value and whether or not it is present.
  if (cls === 'chat' && (prompt === undefined || completion === undefined)) return null;
  // Embeddings report only the prompt (and its total); one of the two is needed.
  if (cls === 'embedding' && prompt === undefined && total === undefined) return null;
  const components = (prompt ?? 0) + (completion ?? 0);
  if (total !== undefined) return total > 0 && total >= components ? total : null;
  return components > 0 ? components : null;
}

export class AiGuard {
  private inFlight = 0;
  private nextId = 1;
  private ledger: LedgerEntry[] = [];
  private starts: Record<AiClass, number[]> = { chat: [], embedding: [] };

  constructor(
    readonly config: AiGuardConfig = loadAiGuardConfig(),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  private prune(at: number) {
    this.ledger = this.ledger.filter(e => at - e.at < DAY_MS);
    for (const cls of ['chat', 'embedding'] as const) this.starts[cls] = this.starts[cls].filter(t => at - t < MINUTE_MS);
  }

  private tokensUsed(cls: AiClass): number { return this.ledger.filter(e => e.cls === cls).reduce((sum, e) => sum + e.tokens, 0); }

  /** One synchronous check-and-reserve step: nothing awaits between the checks and the booking, so concurrent callers can never both pass the same limit. */
  private tryAcquire(op: AiOperation, opts: AcquireOptions): { lease: AiLease } | { error: AiLimitError } {
    const cls = CLASS_OF[op];
    const at = this.now();
    this.prune(at);

    const isGeneration = op === 'writer' || op === 'rag_answer';
    const cap = opts.maxOutputTokens;
    if (isGeneration && (cap === undefined || !Number.isInteger(cap) || cap <= 0 || cap > this.config.hardMaxOutputTokens)) return { error: new AiLimitError('output_limit') };
    if (!Number.isFinite(opts.inputChars) || opts.inputChars < 0) return { error: new AiLimitError('budget_exhausted') };

    const estimate = Math.ceil(opts.inputChars / 2) + (isGeneration ? cap! : 0);
    if (this.tokensUsed(cls) + estimate > this.config.tokenBudget24h[cls]) return { error: new AiLimitError('budget_exhausted') };
    if (this.inFlight >= this.config.maxConcurrent) return { error: new AiLimitError('busy') };
    const recent = this.starts[cls];
    if (recent.length >= this.config.ratePerMinute[cls]) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + MINUTE_MS - at) / 1000));
      return { error: new AiLimitError('rate_limited', retryAfterSec) };
    }

    const entry: LedgerEntry = { id: this.nextId++, at, cls, tokens: estimate, actual: false };
    this.ledger.push(entry);
    recent.push(at);
    this.inFlight += 1;
    let settled = false;
    const release = () => { if (!settled) { settled = true; this.inFlight = Math.max(0, this.inFlight - 1); return true; } return false; };
    const lease: AiLease = {
      maxOutputTokens: isGeneration ? cap : undefined,
      complete: usage => {
        if (!release()) return;
        const actual = totalTokensFromUsage(usage, cls);
        if (actual !== null) { entry.tokens = actual; entry.actual = true; }
      },
      fail: sent => {
        if (!release()) return;
        if (!sent) {
          this.ledger = this.ledger.filter(e => e.id !== entry.id);
          const index = this.starts[cls].indexOf(at);
          if (index >= 0) this.starts[cls].splice(index, 1);
        }
      },
    };
    return { lease };
  }

  /** Reserves capacity for one provider request or throws `AiLimitError` without sending anything. */
  async acquire(op: AiOperation, opts: AcquireOptions): Promise<AiLease> {
    const deadline = this.now() + (opts.waitForRateMs ?? 0);
    while (true) {
      const attempt = this.tryAcquire(op, opts);
      if ('lease' in attempt) return attempt.lease;
      const { error } = attempt;
      const waitMs = error.reason === 'rate_limited' && error.retryAfterSec ? error.retryAfterSec * 1000 : 0;
      if (waitMs === 0 || this.now() + waitMs > deadline) throw error;
      await this.sleep(waitMs);
    }
  }

  snapshot(): AiGuardSnapshot {
    this.prune(this.now());
    const part = (cls: AiClass) => {
      const rows = this.ledger.filter(e => e.cls === cls);
      return {
        requestsLastMinute: this.starts[cls].length,
        actualTokens24h: rows.filter(e => e.actual).reduce((s, e) => s + e.tokens, 0),
        estimatedTokens24h: rows.filter(e => !e.actual).reduce((s, e) => s + e.tokens, 0),
        budget: this.config.tokenBudget24h[cls],
      };
    };
    return { inFlight: this.inFlight, chat: part('chat'), embedding: part('embedding') };
  }
}

const GLOBAL_KEY = '__plasmatechAiGuard';

/** The process-wide guard (one ledger shared by every route and provider of this server process). */
export function getAiGuard(): AiGuard {
  const holder = globalThis as unknown as Record<string, AiGuard | undefined>;
  return holder[GLOBAL_KEY] ??= new AiGuard();
}

/** Test support: starts the process-wide guard from an empty ledger (so one test's calls never count against the next). */
export function resetAiGuardForTests(): void {
  (globalThis as unknown as Record<string, AiGuard | undefined>)[GLOBAL_KEY] = undefined;
}
