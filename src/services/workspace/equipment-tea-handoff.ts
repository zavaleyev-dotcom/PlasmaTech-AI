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
