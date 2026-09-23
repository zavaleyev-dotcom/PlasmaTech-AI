/** The canonical, durable store for Scientific Writer's References list - every reference the
 *  user sees (typed in manually, or merged in from SciFinder) lives here, in this browser's own
 *  localStorage, so it survives navigating away and back (F02: previously references lived only
 *  in React state, so they silently vanished on unmount while the SciFinder transfer ledger had
 *  already marked the import "consumed" - a lost-data bug this store exists to close). Never
 *  sent to a server, never shared across devices - same locality guarantee as TechDoc
 *  Assistant's own document persistence. */

import type { Reference } from './references';

const STORAGE_KEY = 'plasmatech.scientific-writer.references.v1';

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

function detectWorkingLocalStorage(): KeyValueStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probeKey = '__plasmatech_storage_probe__';
    localStorage.setItem(probeKey, '1');
    const ok = localStorage.getItem(probeKey) === '1';
    localStorage.removeItem(probeKey);
    return ok ? localStorage : null;
  } catch { return null; }
}

function isReference(value: unknown): value is Reference {
  return value !== null && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { type?: unknown }).type === 'string'
    && Array.isArray((value as { authors?: unknown }).authors);
}

/** Reads the currently-saved reference list - `[]` if nothing was ever saved, storage is
 *  unavailable, or the stored value is corrupted (never partially trusted: a malformed entry
 *  drops the WHOLE list back to empty rather than silently keeping a mangled subset). */
export function loadReferences(store: KeyValueStore | null = detectWorkingLocalStorage()): Reference[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isReference) ? parsed : [];
  } catch { return []; }
}

/** Returns true ONLY if the write genuinely reached durable storage. Callers that treat an
 *  import as "delivered" (the SciFinder transfer queue) must check this - never assume success
 *  (F02: "if persistence fails, a reference must never be marked as successfully consumed"). */
export function saveReferences(refs: Reference[], store: KeyValueStore | null = detectWorkingLocalStorage()): boolean {
  if (!store) return false;
  try { store.setItem(STORAGE_KEY, JSON.stringify(refs)); return true; } catch { return false; }
}

/** Merges two reference lists (e.g. the already-saved canonical list and a batch just pulled
 *  in from SciFinder) without duplicating an entry that - by some retry/race - ended up in
 *  both, keyed by id (the one thing every reference genuinely has). */
export function mergeReferencesById(...lists: Reference[][]): Reference[] {
  const byId = new Map<string, Reference>();
  for (const list of lists) for (const ref of list) byId.set(ref.id, ref);
  return [...byId.values()];
}

/** Test-only: a working in-memory KeyValueStore, for environments (some Node test runtimes)
 *  where the built-in `localStorage` global exists but is not actually functional. */
export function createInMemoryStoreForTests(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
