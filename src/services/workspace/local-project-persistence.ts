/** Local, durable persistence of ONE editable project in this browser's localStorage (used by Techno-Economic Assessment). The same rules as the Scientific Writer draft,
 *  written once for any content type:
 *   - the data live ONLY in this browser, under their own versioned key; nothing is sent to a server or to a third-party service; nothing is encrypted or backed up;
 *   - no browser API is touched at import or during server rendering: the storage is looked up lazily, and again on every explicit retry;
 *   - READING and WRITING are separate: a readable project is restored even when writing is refused (a full storage), and a failed read never opens writing;
 *   - a restored project is validated as a whole by the caller's `parse`; a damaged, unknown or incompatible value gives no project, never a half-trusted one;
 *   - a stored value that could not be used is put into the single backup slot before it can be overwritten; an existing DIFFERENT backup is never overwritten (the
 *     destructive write is refused instead) and the backup is never cleared automatically;
 *   - a failed write changes nothing: the state on the screen stays, the previous stored project stays, and the next change tries again;
 *   - nothing is written before the stored project has been read successfully, and an unchanged project is not rewritten;
 *   - clearing removes THIS key only (other tools' data are untouched) and is refused if it would destroy an unusable value that cannot be put aside;
 *   - what is written is checked by the SAME rules the loader applies (`readEnvelope`): a project the loader would reject, or would silently change, is not written - the
 *     previous stored project stays and the reason is reported;
 *   - the pending save is flushed when the user leaves, and cancelled when the project is cleared (a waiting timer can never write a deleted project back). */

export interface ProjectStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** The browser's localStorage if it can be READ (lazy; `null` on the server or when access is blocked). Writing is deliberately not probed. */
export function detectProjectStore(): ProjectStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem('__plasmatech_project_probe__');
    return localStorage;
  } catch { return null; }
}

export function createInMemoryProjectStore(): ProjectStore {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

export interface ProjectConfig<T> {
  /** The key of the project; the backup slot is `<key>.unreadable`. */
  readonly key: string;
  readonly version: number;
  readonly defaultContent: () => T;
  /** Validates and canonicalises the stored content as a whole; `null` if it is not a complete, valid project. Must not throw. */
  readonly parse: (value: unknown) => T | null;
  /** The first problem of a content that `parse` rejects, in words (for the user). Optional. */
  readonly explain?: (value: unknown) => string | null;
}

/** Equality of two pieces of JSON-like data that ignores the ORDER of keys and keys whose value is `undefined` (they do not survive JSON). Used to make sure that what is read
 *  back is exactly what was written: nothing is dropped, added or changed. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => (a as Record<string, unknown>)[k] !== undefined || (b as Record<string, unknown>)[k] !== undefined));
    for (const k of keys) if (!sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

export interface StoredProject<T> { readonly content: T; readonly savedAt: string }

export type ProjectLoadResult<T> =
  | { readonly status: 'empty' }
  | { readonly status: 'restored'; readonly project: StoredProject<T>; readonly raw: string }
  | { readonly status: 'corrupted'; readonly raw: string }
  | { readonly status: 'unsupported_version'; readonly raw: string; readonly version: unknown }
  | { readonly status: 'unavailable' }
  | { readonly status: 'read_failed' };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const backupKey = (key: string): string => `${key}.unreadable`;

/** The ONE reader of a stored value: used by `loadProject` and, on the written text, by `save`. */
export function readEnvelope<T>(config: ProjectConfig<T>, raw: string): ProjectLoadResult<T> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'corrupted', raw }; }
  if (isObject(parsed) && typeof parsed.version === 'number' && parsed.version !== config.version) return { status: 'unsupported_version', raw, version: parsed.version };
  if (!isObject(parsed) || parsed.version !== config.version || typeof parsed.savedAt !== 'string' || !Number.isFinite(Date.parse(parsed.savedAt))) return { status: 'corrupted', raw };
  let content: T | null;
  try { content = config.parse(parsed.content); } catch { content = null; }
  return content === null ? { status: 'corrupted', raw } : { status: 'restored', project: { content, savedAt: parsed.savedAt }, raw };
}

export function loadProject<T>(config: ProjectConfig<T>, store: ProjectStore | null): ProjectLoadResult<T> {
  if (!store) return { status: 'unavailable' };
  let raw: string | null;
  try { raw = store.getItem(config.key); } catch { return { status: 'read_failed' }; }
  if (raw === null || raw === '') return { status: 'empty' };
  return readEnvelope(config, raw);
}

export type SaveFailure = 'not_hydrated' | 'unchanged' | 'unavailable' | 'quota' | 'error' | 'quarantine_failed' | 'quarantine_occupied' | 'invalid';
export type SaveOutcome = { readonly ok: true; readonly savedAt: string } | { readonly ok: false; readonly reason: SaveFailure; readonly problem?: string };
export type ClearOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: 'not_hydrated' | 'unavailable' | 'error' | 'quarantine_failed' | 'quarantine_occupied' };

function failureReason(error: unknown): 'quota' | 'error' {
  const e = error as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : '';
  return /quota/i.test(name) || e?.code === 22 || e?.code === 1014 ? 'quota' : 'error';
}

function putAside(store: ProjectStore, slot: string, raw: string): 'ok' | 'occupied' | 'failed' {
  let existing: string | null;
  try { existing = store.getItem(slot); } catch { return 'failed'; }
  if (existing === raw) return 'ok';
  if (existing !== null) return 'occupied';
  try { store.setItem(slot, raw); } catch { return 'failed'; }
  return 'ok';
}

export interface ProjectPersistence<T> {
  /** Reads the stored project once and, only if the read succeeded, opens saving. After a failed read (`unavailable`, `read_failed`) call it again to retry: the storage is
   *  looked up again. `keepExisting`: the caller already has new input, so a stored project that is found is not adopted; it is put aside before the first save. */
  hydrate(options?: { keepExisting?: boolean }): ProjectLoadResult<T>;
  isHydrated(): boolean;
  save(content: T): SaveOutcome;
  clear(): ClearOutcome;
}

export function createProjectPersistence<T>(config: ProjectConfig<T>, source: ProjectStore | null | (() => ProjectStore | null), now: () => Date = () => new Date()): ProjectPersistence<T> {
  let store: ProjectStore | null = typeof source === 'function' ? null : source;
  let hydrated = false;
  let lastSerialized: string | null = null;
  let pending: string | null = null;
  const slot = backupKey(config.key);
  const serialize = (content: T): string => JSON.stringify(content);
  return {
    hydrate(options = {}) {
      if (typeof source === 'function' && !hydrated) { try { store = source(); } catch { store = null; } }
      const loaded = loadProject(config, store);
      if (loaded.status === 'unavailable' || loaded.status === 'read_failed') return loaded;
      hydrated = true;
      pending = null;
      lastSerialized = serialize(config.defaultContent());                                  // an untouched empty project is not "a change": it is never written over a stored value
      if (loaded.status === 'restored') { if (options.keepExisting) pending = loaded.raw; else lastSerialized = serialize(loaded.project.content); }
      else if (loaded.status === 'corrupted' || loaded.status === 'unsupported_version') pending = loaded.raw;
      return loaded;
    },
    isHydrated: () => hydrated,
    save(content) {
      if (!hydrated) return { ok: false, reason: 'not_hydrated' };
      if (!store) return { ok: false, reason: 'unavailable' };
      const serialized = serialize(content);
      if (serialized === lastSerialized) return { ok: false, reason: 'unchanged' };
      // What is written must be readable: the loader's own rules are applied to the text that would be written, and it must give back exactly this content.
      const savedAt = now().toISOString();
      const text = JSON.stringify({ version: config.version, savedAt, content });
      const check = readEnvelope(config, text);
      if (check.status !== 'restored' || !sameData(check.project.content, JSON.parse(text).content)) {
        const problem = config.explain?.(JSON.parse(text).content) ?? 'проект не проходит проверку при загрузке или был бы изменён при чтении';
        return { ok: false, reason: 'invalid', problem };
      }
      if (pending !== null) {
        const aside = putAside(store, slot, pending);
        if (aside !== 'ok') return { ok: false, reason: aside === 'occupied' ? 'quarantine_occupied' : 'quarantine_failed' };
        pending = null;
      }
      try { store.setItem(config.key, text); } catch (error) { return { ok: false, reason: failureReason(error) }; }
      lastSerialized = serialized;
      return { ok: true, savedAt };
    },
    clear() {
      if (!store) return { ok: false, reason: 'unavailable' };
      if (!hydrated) return { ok: false, reason: 'not_hydrated' };
      if (pending !== null) {
        const aside = putAside(store, slot, pending);
        if (aside !== 'ok') return { ok: false, reason: aside === 'occupied' ? 'quarantine_occupied' : 'quarantine_failed' };
        pending = null;
      }
      try { store.removeItem(config.key); } catch { return { ok: false, reason: 'error' }; }
      lastSerialized = serialize(config.defaultContent());
      return { ok: true };
    },
  };
}

// ---------- automatic saving ----------

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface Autosave<T> {
  update(content: T): void;
  /** Save what is pending NOW (leaving the page, unmounting). Does not report. */
  flush(): void;
  /** Forget what is pending (the project is being cleared). */
  cancel(): void;
}

export function createAutosave<T>(persistence: ProjectPersistence<T>, report: (outcome: SaveOutcome, content: T) => void, delayMs = 600, timers: Timers = realTimers): Autosave<T> {
  let latest: { content: T } | null = null;
  let handle: unknown = null;
  const stop = (): void => { if (handle !== null) { timers.clear(handle); handle = null; } };
  const run = (announce: boolean): void => {
    if (latest === null || !persistence.isHydrated()) return;
    const content = latest.content;
    const outcome = persistence.save(content);
    if (outcome.ok || outcome.reason === 'unchanged') latest = null;                         // done; any other failure keeps the content for the next attempt
    if (announce && !(outcome.ok === false && outcome.reason === 'unchanged')) report(outcome, content);
  };
  return {
    update(content) { latest = { content }; stop(); handle = timers.set(() => { handle = null; run(true); }, delayMs); },
    flush() { stop(); run(false); },
    cancel() { stop(); latest = null; },
  };
}
