/** Local, durable draft of Scientific Writer (P1 fix): everything the user typed, the structure that was built, the generated result and the chosen options survive
 *  navigating away, a browser refresh and closing and reopening the tab in the same browser profile.
 *
 *  Where it lives: ONLY this browser's localStorage, under its own versioned key. It is never sent to a server and never to a third-party service. It is NOT encrypted and NOT
 *  backed up: anyone with access to this browser profile can read it, and clearing the site data deletes it. The user interface says so.
 *
 *  Safety rules (each is covered by tests/scientific-writer-draft-store.test.ts):
 *   - no browser API is touched at import or during server-side rendering: storage is looked up lazily, inside functions that only run in the browser;
 *   - READING and WRITING are separate: if the stored draft can be read it is restored even when writing is refused (a full storage), and a failed read never opens writing;
 *   - a restored draft is validated strictly and as a whole - a damaged JSON, an unknown version or a wrong shape yields no draft, never a half-trusted one;
 *   - an unreadable stored value is moved aside (quarantined) before it can be overwritten, and if that is impossible nothing is overwritten;
 *   - the text is stored exactly as typed (no trimming, no normalisation);
 *   - a failed write (quota, private mode, no storage) is reported and changes nothing: the state on the screen stays, the previous stored draft stays;
 *   - nothing is written before the stored draft has been read (the initial empty values can never overwrite a saved draft), and an unchanged draft is not rewritten;
 *   - a generation answer that arrives after the draft was cleared or after a newer request is ignored (see `createGenerationGuard`);
 *   - clearing removes THIS key only: the bibliography and the data of other tools are untouched. */

import type { CitationStyle, DocumentProfileId } from './references';
import { CITATION_STYLES, DOCUMENT_PROFILES } from './references';
import { DOCUMENT_TYPES, LANGUAGES, WRITER_MODES, type DocumentType, type EvidenceReport, type Language, type PreservationCheck, type ScaffoldSection, type WriterMode } from './scientific-writer';

export const DRAFT_STORAGE_KEY = 'plasmatech.scientific-writer.draft.v1';
/** One slot where a stored value that could not be read is moved before the draft key may be overwritten. */
export const UNREADABLE_DRAFT_KEY = 'plasmatech.scientific-writer.draft.unreadable.v1';
export const DRAFT_VERSION = 1;

export interface DraftStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export interface DraftForm {
  documentType: DocumentType; mode: WriterMode; targetLanguage: Language;
  title: string; researchField: string; goal: string; researchObject: string;
  methods: string; results: string; conclusions: string; keywords: string;
  sourceText: string; additionalRequirements: string;
}

export interface DraftGenerationResult {
  generatedText: string;
  evidence: EvidenceReport;
  preservation: PreservationCheck | null;
  changes: string[] | null;
  warnings: string[];
}

/** What is saved (without the version and the time of saving). */
export interface DraftContent {
  form: DraftForm;
  citationStyle: CitationStyle;
  profileId: DocumentProfileId;
  exportFormat: 'docx' | 'pdf';
  scaffold: ScaffoldSection[] | null;
  evidencePreview: EvidenceReport | null;
  result: DraftGenerationResult | null;
  /** The form (as JSON) the structure / result was built from; `null` when nothing was generated. Used to tell the user that the form changed after the generation. */
  generatedFrom: string | null;
}

export interface WriterDraft extends DraftContent { readonly version: typeof DRAFT_VERSION; readonly savedAt: string }

export function defaultDraftForm(): DraftForm {
  return {
    documentType: 'article', mode: 'draft', targetLanguage: 'en',
    title: '', researchField: '', goal: '', researchObject: '', methods: '', results: '', conclusions: '', keywords: '',
    sourceText: '', additionalRequirements: '',
  };
}

export function defaultDraftContent(): DraftContent {
  return { form: defaultDraftForm(), citationStyle: 'apa', profileId: 'generic_article', exportFormat: 'docx', scaffold: null, evidencePreview: null, result: null, generatedFrom: null };
}

// ---------- storage ----------

/** The browser's localStorage if it can be READ (looked up lazily; `null` on the server or when access is blocked). Writing is deliberately NOT probed: a full storage refuses
 *  writes but still holds the saved draft, and treating "cannot write" as "no storage" would make a saved draft unrecoverable. A refused write is reported when saving. */
export function detectDraftStore(): DraftStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem('__plasmatech_draft_probe__');
    return localStorage;
  } catch { return null; }
}

/** A working in-memory store for tests and for runtimes without a functional `localStorage`. */
export function createInMemoryDraftStore(): DraftStore {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

// ---------- validation of a restored draft ----------

const SHORT_FIELDS = ['title', 'researchField', 'keywords'] as const;
const LONG_FIELDS = ['goal', 'researchObject', 'methods', 'results', 'conclusions', 'sourceText', 'additionalRequirements'] as const;
const SHORT_LIMIT = 500;
const LONG_LIMIT = 20_000;
const EVIDENCE_KEYS: readonly string[] = ['title', 'researchField', 'goal', 'researchObject', 'methods', 'results', 'conclusions', 'keywords'];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

function isForm(v: unknown): v is DraftForm {
  if (!isObject(v)) return false;
  if (!oneOf(DOCUMENT_TYPES, v.documentType) || !oneOf(WRITER_MODES, v.mode) || !oneOf(LANGUAGES, v.targetLanguage)) return false;
  return SHORT_FIELDS.every(k => typeof v[k] === 'string' && (v[k] as string).length <= SHORT_LIMIT) && LONG_FIELDS.every(k => typeof v[k] === 'string' && (v[k] as string).length <= LONG_LIMIT);
}
const isEvidence = (v: unknown): v is EvidenceReport => isObject(v) && isStringArray(v.provided) && isStringArray(v.missing)
  && Array.isArray(v.fields) && v.fields.every(f => isObject(f) && typeof f.key === 'string' && EVIDENCE_KEYS.includes(f.key) && typeof f.label === 'string' && typeof f.provided === 'boolean' && (f.value === undefined || typeof f.value === 'string'));
const isPreservation = (v: unknown): v is PreservationCheck => isObject(v) && typeof v.ok === 'boolean' && isStringArray(v.preservedNumbers) && isStringArray(v.missingNumbers) && isStringArray(v.preservedTerms) && isStringArray(v.missingTerms);
const isScaffold = (v: unknown): v is ScaffoldSection[] => Array.isArray(v) && v.every(s => isObject(s) && typeof s.heading === 'string' && typeof s.text === 'string' && isStringArray(s.usedFields));
const isResult = (v: unknown): v is DraftGenerationResult => isObject(v) && typeof v.generatedText === 'string' && isEvidence(v.evidence)
  && (v.preservation === null || isPreservation(v.preservation)) && (v.changes === null || isStringArray(v.changes)) && isStringArray(v.warnings);

/** The draft in a stored value, or `null` if the value is not a complete, valid draft of THIS version. Never throws, never returns part of a draft. */
export function parseDraft(raw: unknown): WriterDraft | null {
  if (!isObject(raw) || raw.version !== DRAFT_VERSION) return null;
  if (typeof raw.savedAt !== 'string' || !Number.isFinite(Date.parse(raw.savedAt))) return null;
  if (!isForm(raw.form) || !oneOf(CITATION_STYLES, raw.citationStyle) || !oneOf(DOCUMENT_PROFILES, raw.profileId) || !oneOf(['docx', 'pdf'] as const, raw.exportFormat)) return null;
  if (!(raw.scaffold === null || isScaffold(raw.scaffold)) || !(raw.evidencePreview === null || isEvidence(raw.evidencePreview)) || !(raw.result === null || isResult(raw.result))) return null;
  if (!(raw.generatedFrom === null || typeof raw.generatedFrom === 'string')) return null;
  return {
    version: DRAFT_VERSION, savedAt: raw.savedAt, form: raw.form, citationStyle: raw.citationStyle, profileId: raw.profileId, exportFormat: raw.exportFormat,
    scaffold: raw.scaffold, evidencePreview: raw.evidencePreview, result: raw.result, generatedFrom: raw.generatedFrom,
  };
}

export type DraftLoadResult =
  | { readonly status: 'empty' }
  | { readonly status: 'restored'; readonly draft: WriterDraft; readonly raw: string }
  | { readonly status: 'corrupted'; readonly raw: string }
  | { readonly status: 'unsupported_version'; readonly raw: string; readonly version: unknown }
  /** There is no storage at all (the server, blocked access). */
  | { readonly status: 'unavailable' }
  /** The storage exists but reading failed this time: nothing is known about the stored draft, so nothing may be written until a read succeeds. */
  | { readonly status: 'read_failed' };

/** Reads the saved draft. Does not write anything. */
export function loadDraft(store: DraftStore | null): DraftLoadResult {
  if (!store) return { status: 'unavailable' };
  let raw: string | null;
  try { raw = store.getItem(DRAFT_STORAGE_KEY); } catch { return { status: 'read_failed' }; }
  if (raw === null || raw === '') return { status: 'empty' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'corrupted', raw }; }
  if (isObject(parsed) && typeof parsed.version === 'number' && parsed.version !== DRAFT_VERSION) return { status: 'unsupported_version', raw, version: parsed.version };
  const draft = parseDraft(parsed);
  return draft ? { status: 'restored', draft, raw } : { status: 'corrupted', raw };
}

// ---------- persistence controller ----------

export type SaveFailure = 'not_hydrated' | 'unchanged' | 'unavailable' | 'quota' | 'error' | 'quarantine_failed' | 'quarantine_occupied';
export type SaveOutcome = { readonly ok: true; readonly savedAt: string } | { readonly ok: false; readonly reason: SaveFailure };
export type ClearOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_hydrated' | 'unavailable' | 'error' | 'quarantine_failed' | 'quarantine_occupied' };

const serializeContent = (content: DraftContent): string => JSON.stringify(content);

function failureReason(error: unknown): 'quota' | 'error' {
  const e = error as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  return /quota/i.test(name) || e?.code === 22 || e?.code === 1014 ? 'quota' : 'error';
}

/** Puts a value that must not be lost into the single backup slot. An existing DIFFERENT backup is never overwritten: the destructive write is refused instead, so both
 *  documents survive. The backup is never cleared automatically. */
function putAside(store: DraftStore, raw: string): 'ok' | 'occupied' | 'failed' {
  let existing: string | null;
  try { existing = store.getItem(UNREADABLE_DRAFT_KEY); } catch { return 'failed'; }
  if (existing === raw) return 'ok';
  if (existing !== null) return 'occupied';
  try { store.setItem(UNREADABLE_DRAFT_KEY, raw); } catch { return 'failed'; }
  return 'ok';
}

export interface DraftPersistence {
  /** Reads the stored draft and, only if the read succeeded, opens saving. Before a successful read nothing is ever written; after a failed read (`unavailable`,
   *  `read_failed`) call it again to retry - the stored document is untouched. `keepExisting`: the caller has already started a new draft, so a stored one that is found is
   *  not adopted; it is put aside before the first save instead. */
  hydrate(options?: { keepExisting?: boolean }): DraftLoadResult;
  isHydrated(): boolean;
  /** Writes the draft if it changed since it was read or last saved. Never throws; on failure nothing changes (the previous stored draft stays, and the next call tries again). */
  save(content: DraftContent): SaveOutcome;
  /** Removes THIS draft only. A stored value that could not be read is put aside first; if that is impossible the draft is NOT removed. */
  clear(): ClearOutcome;
}

/** `source`: a storage, or a function that finds one (`detectDraftStore`). A function is called again by EVERY `hydrate()` until a read succeeds, so a storage that was
 *  momentarily unavailable at the first attempt is found again on retry; once hydrated, the storage that was read is the one that is written. */
export function createDraftPersistence(source: DraftStore | null | (() => DraftStore | null), now: () => Date = () => new Date()): DraftPersistence {
  let store: DraftStore | null = typeof source === 'function' ? null : source;
  let hydrated = false;
  let lastSerialized: string | null = null;
  let pendingUnreadable: string | null = null;
  return {
    hydrate(options = {}) {
      if (typeof source === 'function' && !hydrated) { try { store = source(); } catch { store = null; } }
      const loaded = loadDraft(store);
      if (loaded.status === 'unavailable' || loaded.status === 'read_failed') return loaded;          // not hydrated: no write is allowed on top of an unknown stored value
      hydrated = true;
      pendingUnreadable = null;
      lastSerialized = serializeContent(defaultDraftContent());                                         // the untouched empty form is not "a change": it is never written over a stored value
      if (loaded.status === 'restored') {
        if (options.keepExisting) pendingUnreadable = loaded.raw;
        else { const { version: _v, savedAt: _s, ...content } = loaded.draft; void _v; void _s; lastSerialized = serializeContent(content); }
      } else if (loaded.status === 'corrupted' || loaded.status === 'unsupported_version') pendingUnreadable = loaded.raw;
      return loaded;
    },
    isHydrated: () => hydrated,
    save(content) {
      if (!hydrated) return { ok: false, reason: 'not_hydrated' };
      if (!store) return { ok: false, reason: 'unavailable' };
      const serialized = serializeContent(content);
      if (serialized === lastSerialized) return { ok: false, reason: 'unchanged' };
      if (pendingUnreadable !== null) {                                                  // never overwrite what could not be read before it has been put aside
        const aside = putAside(store, pendingUnreadable);
        if (aside !== 'ok') return { ok: false, reason: aside === 'occupied' ? 'quarantine_occupied' : 'quarantine_failed' };
        pendingUnreadable = null;
      }
      const savedAt = now().toISOString();
      try { store.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: DRAFT_VERSION, savedAt, ...content })); } catch (error) { return { ok: false, reason: failureReason(error) }; }
      lastSerialized = serialized;
      return { ok: true, savedAt };
    },
    clear() {
      if (!store) return { ok: false, reason: 'unavailable' };
      if (!hydrated) return { ok: false, reason: 'not_hydrated' };                       // the stored value was never read: it is not removed blindly
      if (pendingUnreadable !== null) {
        const aside = putAside(store, pendingUnreadable);
        if (aside !== 'ok') return { ok: false, reason: aside === 'occupied' ? 'quarantine_occupied' : 'quarantine_failed' };
        pendingUnreadable = null;
      }
      try { store.removeItem(DRAFT_STORAGE_KEY); } catch { return { ok: false, reason: 'error' }; }
      lastSerialized = serializeContent(defaultDraftContent());
      return { ok: true };
    },
  };
}

// ---------- automatic saving (debounce, flush on leaving, cancel on clearing) ----------

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface Autosave {
  /** The content changed: save it after the delay (a newer change restarts the delay). */
  update(content: DraftContent): void;
  /** Save what is pending NOW (leaving the page, unmounting). Does not report. */
  flush(): void;
  /** Forget what is pending (the draft is being cleared): a waiting timer can no longer write the deleted draft back. */
  cancel(): void;
}

/** The scheduler behind the editor. It lives outside React so that its lifecycle (typing then leaving at once, `pagehide`, a pending delay, clearing) is tested without a DOM. */
export function createAutosave(persistence: DraftPersistence, report: (outcome: SaveOutcome) => void, delayMs = 600, timers: Timers = realTimers): Autosave {
  let latest: DraftContent | null = null;
  let handle: unknown = null;
  const stop = (): void => { if (handle !== null) { timers.clear(handle); handle = null; } };
  const run = (announce: boolean): void => {
    if (latest === null || !persistence.isHydrated()) return;                           // nothing pending, or the stored draft has not been read successfully
    const outcome = persistence.save(latest);
    if (outcome.ok || outcome.reason === 'unchanged') latest = null;                    // done; any other failure keeps the content for the next attempt
    if (announce && !(outcome.ok === false && outcome.reason === 'unchanged')) report(outcome);
  };
  return {
    update(content) { latest = content; stop(); handle = timers.set(() => { handle = null; run(true); }, delayMs); },
    flush() { stop(); run(false); },
    cancel() { stop(); latest = null; },
  };
}

// ---------- stale results ----------

/** True when the form was changed after the shown result / structure was generated from it. */
export function isResultStale(generatedFrom: string | null, form: DraftForm): boolean {
  return generatedFrom !== null && generatedFrom !== JSON.stringify(form);
}

/** Orders asynchronous generations: only the answer of the latest request, and only if nothing invalidated it (clearing the draft, a newer request), may be applied. */
export function createGenerationGuard(): { begin(): number; invalidate(): void; isCurrent(token: number): boolean } {
  let current = 0;
  return { begin: () => { current += 1; return current; }, invalidate: () => { current += 1; }, isCurrent: token => token === current };
}

// ---------- the shown result and the generation that replaces it ----------

/** What the user sees as the product of a generation. These four go together: the result, the structure and the evidence belong to the form snapshot `generatedFrom`. */
export interface GenerationView {
  scaffold: ScaffoldSection[] | null;
  evidencePreview: EvidenceReport | null;
  result: DraftGenerationResult | null;
  generatedFrom: string | null;
}

export type GenerationOutcome =
  /** The new request succeeded: everything is replaced together, for the form snapshot it was made for. */
  | { readonly kind: 'success'; readonly result: DraftGenerationResult; readonly scaffold: ScaffoldSection[] | null; readonly evidencePreview: EvidenceReport | null; readonly snapshot: string }
  /** The new request failed (API error, no provider, unavailable). */
  | { readonly kind: 'failure'; readonly scaffold: ScaffoldSection[] | null; readonly evidencePreview: EvidenceReport | null; readonly snapshot: string }
  /** The new input did not pass validation: no request was made. */
  | { readonly kind: 'invalid_input' };

/** The view after an outcome. A previous SUCCESSFUL result is replaced only by a newer success: after an error, or a validation error, it stays exactly as it was together
 *  with its structure and the snapshot it was generated for (it is never attributed to the new request). Only when there is no result yet does a failed request show the
 *  local structure built from the new input - the honest "no AI" fallback. */
export function applyGenerationOutcome(view: GenerationView, outcome: GenerationOutcome): GenerationView {
  if (outcome.kind === 'success') return { result: outcome.result, scaffold: outcome.scaffold, evidencePreview: outcome.evidencePreview, generatedFrom: outcome.snapshot };
  if (outcome.kind === 'invalid_input' || view.result !== null) return view;
  return { result: null, scaffold: outcome.scaffold, evidencePreview: outcome.evidencePreview, generatedFrom: outcome.snapshot };
}
