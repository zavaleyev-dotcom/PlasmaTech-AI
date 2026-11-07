/** Real local-only handoff of a selected Equipment Selector configuration's TECHNICAL
 *  parameters into Techno-Economic Assessment. No CAPEX/OPEX/equipment cost is ever invented
 *  here - only the fields Equipment Selector's own model actually knows (see
 *  `TechnoEconomicHandoff` in equipment-selector.ts) are carried over, and TEA marks them with
 *  explicit provenance. Uses this browser's own localStorage only - never sent to a server,
 *  never shared across devices - independent of the SciFinder->Scientific Writer transfer
 *  mechanism (a different module, deliberately not reused here so each workspace pair stays
 *  independent). */

import type { TechnoEconomicHandoff } from './equipment-selector';

const STORAGE_KEY = 'plasmatech.equipment-tea-handoff.v1';

export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

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

export interface EquipmentTeaHandoffRecord { handoff: TechnoEconomicHandoff; importedAt: string }

function isHandoffRecord(value: unknown): value is EquipmentTeaHandoffRecord {
  return value !== null && typeof value === 'object'
    && typeof (value as { importedAt?: unknown }).importedAt === 'string'
    && typeof (value as { handoff?: unknown }).handoff === 'object' && (value as { handoff?: unknown }).handoff !== null;
}

/** Called from Equipment Selector when the user explicitly clicks the handoff action. This is a
 *  single pending slot, not a growing list: a repeated or duplicate handoff (same or a
 *  different configuration) simply overwrites it, so nothing can accumulate or corrupt state. */
export function queueEquipmentHandoff(handoff: TechnoEconomicHandoff, store: KeyValueStore | null = detectWorkingLocalStorage()): void {
  if (!store) return;
  const record: EquipmentTeaHandoffRecord = { handoff, importedAt: new Date().toISOString() };
  try { store.setItem(STORAGE_KEY, JSON.stringify(record)); }
  catch { /* storage unavailable (quota/private mode) - nothing to fall back to */ }
}

/** Called once when Techno-Economic Assessment mounts: returns the pending handoff (if any) and
 *  clears it, so a later remount/reload never silently re-applies it over the user's own edits. */
export function consumePendingEquipmentHandoff(store: KeyValueStore | null = detectWorkingLocalStorage()): EquipmentTeaHandoffRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isHandoffRecord(parsed)) return null;
    store.removeItem(STORAGE_KEY);
    return parsed;
  } catch { return null; }
}

/** Test-only: a working in-memory KeyValueStore, for environments (some Node test runtimes)
 *  where the built-in `localStorage` global exists but is not actually functional. */
export function createInMemoryStoreForTests(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

// ---------- delivery that is confirmed before the queue entry is removed (used by Techno-Economic Assessment) ----------
//
// `consumePendingEquipmentHandoff` above reads AND removes in one step, which loses the configuration if the project it was applied to cannot be saved. TEA uses these two
// instead: it READS the pending entry (`peek`), applies it to its project, and asks to remove it (`acknowledge`) only after that project has been written for certain. The
// entry is identified by its configuration and its `importedAt`; an entry that is already part of the saved project is therefore never applied a second time, and a newer
// hand-over queued meanwhile is never removed by the confirmation of an older one. No new queue is introduced: the same single slot and key are used.

/** True when both records are the same hand-over (the same configuration queued at the same moment). */
export function isSameHandoff(a: EquipmentTeaHandoffRecord | null | undefined, b: EquipmentTeaHandoffRecord | null | undefined): boolean {
  return !!a && !!b && a.importedAt === b.importedAt && a.handoff.configurationId === b.handoff.configurationId;
}

/** The storage for READING: working reads are enough (a full storage refuses writes but still holds the entry). */
function detectReadableStorage(): KeyValueStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem(STORAGE_KEY);
    return localStorage;
  } catch { return null; }
}

/** The pending hand-over, WITHOUT removing it. `null` if there is none, the storage cannot be read or the entry is damaged (a damaged entry is left in place). */
export function peekPendingEquipmentHandoff(store: KeyValueStore | null = detectReadableStorage()): EquipmentTeaHandoffRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isHandoffRecord(parsed) ? parsed : null;
  } catch { return null; }
}

/** Removes the pending entry if, and only if, it is still THIS hand-over. Returns whether the queue no longer holds it (already gone counts as done); a failed removal
 *  returns false and leaves the entry, so that the next opening can try again without applying it destructively a second time. */
export function acknowledgeEquipmentHandoff(record: EquipmentTeaHandoffRecord, store: KeyValueStore | null = detectReadableStorage()): boolean {
  if (!store) return false;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    if (isHandoffRecord(parsed) && !isSameHandoff(parsed, record)) return true;       // a newer hand-over is waiting: it is not ours to remove, ours is already gone
    if (!isHandoffRecord(parsed)) return false;                                       // damaged: left for the user's next hand-over to overwrite
    store.removeItem(STORAGE_KEY);
    return store.getItem(STORAGE_KEY) === null;
  } catch { return false; }
}
