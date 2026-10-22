import { createHash, randomUUID } from 'node:crypto';
import type { ScientificSearchQuery, SearchContinuation } from './types';

/** F20 production remediation (Codex re-detection #4): combined-mode continuation used to be
 *  the client's OWN cached, fully-serialized SearchContinuation object, echoed back verbatim
 *  on every request (see the F20/F20-re-detection comments elsewhere in this module for that
 *  design's history). Two real production defects follow directly from transporting that
 *  object over HTTP on every page:
 *
 *   - F20A: parseContinuation's own defensive buffer cap was HARDCODED to 50, but the
 *     pipeline's own carry-over buffer can legitimately hold up to 2x`limit` records - for
 *     limit=50 that is up to 100 - so up to 50 already-fetched, not-yet-shown unique records
 *     were silently dropped on EVERY parser roundtrip whenever limit=50 (reproduced: buffer=100
 *     server-side, truncated to 50 the instant it round-trips through the client and back
 *     through parseSearchQuery). A schema re-validated from arbitrary client JSON on every
 *     single request is exactly the kind of boundary where a bound like this quietly drifts
 *     out of sync with the value it is supposed to mirror.
 *   - F20B: even had the cap matched, `buffer` holds up to ~100 FULL Publication records
 *     (title, abstract, authors, journal, url, ...) and `emittedKeys` can hold hundreds of
 *     identity strings - with realistic (non-toy) metadata this reliably exceeds the app's own
 *     16KB request-body cap (src/app/api/scifinder/search/route.ts) within about 9 pages from
 *     `emittedKeys` alone, turning "Next" into a hard 413 partway through an ordinary deep
 *     combined search, well before MAX_COMBINED_SEARCH_DEPTH is ever reached.
 *
 *  The fix: the client no longer carries the actual continuation state at all. It only ever
 *  holds an opaque, compact TOKEN (a UUID) - exactly what it already treated `continuation` as
 *  in practice (search.tsx never inspects its shape, only caches and replays it verbatim). The
 *  real, fully-typed SearchContinuation - buffer, emittedKeys, provider offsets, all of it -
 *  lives here, server-side, keyed by that token. Nothing is ever re-serialized/re-validated
 *  from client JSON anymore, so F20A's whole class of bug (a re-validation bound drifting out
 *  of sync with the real one) is now structurally impossible, and F20B's payload-size risk is
 *  gone because nothing bulky ever crosses the wire - only a ~36-byte token does, regardless of
 *  how deep the search has paged.
 *
 *  Deliberately BOUNDED and EPHEMERAL, never a persistent store: capped at MAX_SESSIONS entries
 *  (oldest evicted first once full - a plain FIFO Map, never an unbounded/global cache) and
 *  each entry expires after SESSION_TTL_MS of inactivity (refreshed on every successful
 *  resolve(), so an actively-paged session does not expire mid-use). No SQLite, no persistent
 *  user data - purely an in-process cache that is fine to lose on restart: a lost/expired/
 *  unknown session is reported explicitly (CONTINUATION_EXPIRED) so the UI can offer a
 *  restart - never a crash or a 500, and never a silent reset to page one. Single-process
 *  only by design: safe here (this app runs `next start` as one Node process - route.ts pins
 *  `runtime = 'nodejs'`), and even in a hypothetical multi-instance deployment the worst case
 *  is a session landing on a different instance and gracefully resetting - never data
 *  corruption or a stale/incorrect result. */

/** Exported (not just an internal const) so tests can prove the store itself never grows past
 *  this under sustained load, not merely that any one session's own state stays bounded. */
export const MAX_CONTINUATION_SESSIONS = 500;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes of inactivity

/** What a continuation token is bound to at save time and must match again at resolve time:
 *  `fingerprint` ties it to the search that produced it (so query A's token can never page
 *  query B), `clientId` to the anonymous per-browser context (so another client cannot replay
 *  it). This app has no user accounts, so the client context is the anonymous cookie id the
 *  search route issues - see route.ts. */
export interface ContinuationBinding { fingerprint: string; clientId: string }

export type ContinuationResolution =
  | { status: 'ok'; state: SearchContinuation }
  /** Unknown, expired, evicted, OR issued to a different client - deliberately indistinguishable,
   *  so a foreign token cannot be probed for existence. */
  | { status: 'unknown' }
  /** A live token of THIS client, but issued for a different search. */
  | { status: 'mismatch' };

type FingerprintInput = Pick<ScientificSearchQuery, 'query' | 'keywords' | 'doi' | 'yearFrom' | 'yearTo' | 'limit' | 'source' | 'sort' | 'type' | 'journalOnly' | 'hasDoi' | 'hasAbstract' | 'openAccessOnly'>;

/** Every parameter that shapes the result set - everything except `offset` and `continuation`,
 *  which are pagination position, not search identity. */
export function queryFingerprint(q: FingerprintInput): string {
  return createHash('sha256').update(JSON.stringify([
    q.query, q.keywords, q.doi, q.yearFrom ?? null, q.yearTo ?? null, q.limit, q.source, q.sort,
    q.type, q.journalOnly, q.hasDoi, q.hasAbstract, q.openAccessOnly,
  ])).digest('hex');
}

interface Session { state: SearchContinuation; binding: ContinuationBinding; expiresAt: number }

export class ContinuationStore {
  private sessions = new Map<string, Session>();

  /** Stores `state` under a freshly-minted token and returns it. Evicts anything already
   *  expired first, then - if still at capacity - the single oldest entry (Map iteration is
   *  insertion order, so the first key is the oldest); this keeps memory bounded under
   *  sustained traffic without ever needing a background sweep. */
  save(state: SearchContinuation, binding: ContinuationBinding): string {
    this.evictExpired();
    while (this.sessions.size >= MAX_CONTINUATION_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const token = randomUUID();
    this.sessions.set(token, { state, binding, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** Never throws. Callers must surface anything other than 'ok' to the user - a lost or
   *  foreign token must never silently become a fresh first page. */
  resolve(token: string, binding: ContinuationBinding): ContinuationResolution {
    const session = this.sessions.get(token);
    if (!session) return { status: 'unknown' };
    if (session.expiresAt < Date.now()) { this.sessions.delete(token); return { status: 'unknown' }; }
    if (session.binding.clientId !== binding.clientId) return { status: 'unknown' };
    if (session.binding.fingerprint !== binding.fingerprint) return { status: 'mismatch' };
    session.expiresAt = Date.now() + SESSION_TTL_MS; // sliding expiration - an active session never expires mid-use
    return { status: 'ok', state: session.state };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(token);
  }

  /** Test-only diagnostics: how many sessions are currently held, after clearing anything
   *  expired - lets a test assert the store itself stays bounded, not just the app's own state. */
  size(): number {
    this.evictExpired();
    return this.sessions.size;
  }
}

/** One shared store per running server process - mirrors
 *  src/services/rag/consistency-cache.ts's processConsistencyCache exactly, and for the same
 *  reason: tests construct their OWN `new ContinuationStore()` so unrelated tests' sessions can
 *  never collide with each other or with a real server's. */
export const processContinuationStore = new ContinuationStore();

export const CONTINUATION_TOKEN_MAX_LENGTH = 128;
// Generous enough to comfortably fit randomUUID()'s own alphabet/length; a garbled token fails
// this check and is rejected as INVALID_CONTINUATION (see validation.ts).
const TOKEN_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function isValidContinuationToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CONTINUATION_TOKEN_MAX_LENGTH && TOKEN_PATTERN.test(value);
}
