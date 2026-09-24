/** Bridges SciFinder search results into Scientific Writer's References list - deterministic
 *  field mapping only, no second bibliography model, no new external calls. Reuses the SAME
 *  DOI/title normalization already used by the combined-search deduplication pipeline
 *  (src/services/scientific-search/normalization.ts), so "the same DOI" means the same thing on
 *  both sides of the integration. Transfer between the two independent workspace modules uses
 *  this browser's own localStorage only - never sent to a server, never shared across devices,
 *  matching the pattern already used by TechDoc Assistant's own draft persistence. */

import type { Publication } from '@/services/scientific-search/types';
import { generateReferenceId, referenceDedupKey, type Reference, type ReferenceType, type ReferenceProvenance } from './references';
import { loadReferences as loadCanonicalReferences } from './scientific-writer-references-store';

const STORAGE_KEY = 'plasmatech.scifinder-import.pending.v1';
const MAX_PENDING_ENTRIES = 200;

// ---------- publication -> reference type mapping (item 3) ----------

/** Only decides which of the 7 UI type buckets to preselect - never invents a bibliographic
 *  fact. The user can change the type afterward in Scientific Writer. */
function mapPublicationType(pub: Publication): ReferenceType {
  switch (pub.type) {
    case 'journal-article': return 'journal_article';
    case 'proceedings-article': return 'conference_paper';
    case 'book-chapter': return 'book_chapter';
    case 'book': case 'monograph': case 'edited-book': return 'book';
    case 'dissertation': return 'thesis';
    case 'report': return 'report';
    default: return pub.journal ? 'journal_article' : 'website';
  }
}

/** Both Crossref and OpenAlex adapters substitute the literal "Без названия" when the source
 *  provided no real title (see normalizeCrossrefWork/normalizeOpenAlexWork) - that placeholder
 *  must never be carried into Scientific Writer as if it were a real title. */
function realTitle(pub: Publication): string | undefined {
  return pub.title && pub.title !== 'Без названия' ? pub.title : undefined;
}

/** Deterministic mapping - every field either comes straight from the SciFinder result or is
 *  left undefined (item 3/10). `Publication` has no volume/issue/pages at all, so those stay
 *  unset here, exactly as "не заполнено", never guessed. */
export function mapPublicationToReference(pub: Publication): Reference {
  const provenance: ReferenceProvenance = {
    source: 'scifinder',
    provider: pub.sources.join('+'),
    importedAt: new Date().toISOString(),
    originalId: pub.doi ?? pub.id,
  };
  return {
    id: generateReferenceId(),
    type: mapPublicationType(pub),
    authors: [...pub.authors],
    title: realTitle(pub),
    containerTitle: pub.journal ?? undefined,
    year: pub.year ?? undefined,
    doi: pub.doi ?? undefined,
    url: pub.url ?? undefined,
    provenance,
  };
}

// ---------- duplicate detection (item 8): DOI > title+year > title+first author - reuses
// references.ts's referenceDedupKey (F13), the SAME priority cascade the Reference Manager's
// own list-level duplicate check uses, so "the same reference" means the same thing on both
// sides of this integration, not two independent definitions. ----------

function bestDedupKey(ref: Pick<Reference, 'doi' | 'title' | 'year' | 'authors'>): string | null {
  return referenceDedupKey(ref)?.key ?? null;
}

// ---------- the transfer queue itself (item 6) ----------
//
// F02 fix: this queue holds ONLY references not yet durably merged into Scientific Writer's
// own canonical store (scientific-writer-references-store.ts). It is not itself the source of
// truth for "has this been imported" - that question is answered by the canonical store, which
// is what actually determines what the user sees on every mount. A pending entry is removed
// from this queue ONLY after Scientific Writer confirms the merge was durably saved
// (clearPendingReferences), never merely because it was handed to the caller once - so a failed
// save can never silently lose a reference.

/** Minimal storage shape this module needs - real `localStorage` satisfies it. Injectable so
 *  tests can supply a working in-memory fake instead of depending on a real browser (some Node
 *  test runtimes expose a `localStorage` global whose methods are present but non-functional
 *  stubs, so we probe it rather than trust its mere existence). */
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
  return value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string';
}

function readPending(store: KeyValueStore | null): Reference[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReference) : [];
  } catch { return []; }
}

/** F18: returns true ONLY if the write genuinely reached durable storage - the initial
 *  detectWorkingLocalStorage() probe writes a single byte and can succeed even when the REAL
 *  payload then blows the browser's storage quota, so the actual write must be checked at the
 *  call site too, never assumed from the earlier probe alone. */
function writePending(store: KeyValueStore | null, refs: Reference[]): boolean {
  if (!store) return false;
  try { store.setItem(STORAGE_KEY, JSON.stringify(refs.slice(-MAX_PENDING_ENTRIES))); return true; }
  catch { return false; }
}

export type ImportOutcome =
  | { status: 'queued'; reference: Reference }
  | { status: 'duplicate'; existingReference: Reference }
  /** F18: the write to browser storage did not succeed (quota exceeded, storage unavailable,
   *  private-mode restrictions, setItem throwing) - the reference was never durably queued, so
   *  the caller must not treat this as delivered. Carries no internal error detail (path,
   *  exception message) - only the fact that it failed, safe to show the user as-is. */
  | { status: 'failed' };

/** Called from the SciFinder "Добавить в Scientific Writer" action. Never adds a silent
 *  duplicate (item 5/8): if the same publication (by DOI, else title+year, else title+first
 *  author) already exists in Scientific Writer's REAL, currently-saved reference list, or is
 *  still sitting in this queue waiting to be merged, this reports it instead of queuing a copy -
 *  so a reference the user deleted can always be re-imported, and one that is merely queued
 *  (Writer not opened yet) is not queued twice.
 *
 *  F18: "queued" is returned ONLY after the write is confirmed durable - a storage failure
 *  (quota exceeded, unavailable, setItem throwing) reports "failed" instead, and since nothing
 *  was actually written, nothing is marked consumed/queued anywhere - a later retry for the
 *  SAME publication sees no matching pending/canonical entry and can succeed normally, and a
 *  failed attempt never creates a false "duplicate" report either. */
export function queuePublicationForScientificWriter(pub: Publication, store: KeyValueStore | null = detectWorkingLocalStorage()): ImportOutcome {
  const reference = mapPublicationToReference(pub);
  const pending = readPending(store);
  const key = bestDedupKey(reference);
  if (key) {
    const existing = [...loadCanonicalReferences(store), ...pending].find(existingRef => bestDedupKey(existingRef) === key);
    if (existing) return { status: 'duplicate', existingReference: existing };
  }
  const saved = writePending(store, [...pending, reference]);
  if (!saved) return { status: 'failed' };
  return { status: 'queued', reference };
}

/** Called when Scientific Writer mounts: returns every reference queued since the last
 *  successful merge, WITHOUT removing them from the queue - the caller must durably save the
 *  merge first and only then call `clearPendingReferences()`. Never mutates the queue itself,
 *  so a failed save leaves the queue exactly as it was for the next attempt to retry. */
export function peekPendingReferences(store: KeyValueStore | null = detectWorkingLocalStorage()): Reference[] {
  return readPending(store);
}

/** Called ONLY after Scientific Writer has confirmed (via scientific-writer-references-store's
 *  `saveReferences` returning true) that the pending references are now durably part of its
 *  own canonical list. Removes exactly the given ids - not "everything currently queued" - so a
 *  publication queued concurrently (after the peek that was just saved) is never dropped. */
export function clearPendingReferences(ids: readonly string[], store: KeyValueStore | null = detectWorkingLocalStorage()): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const remaining = readPending(store).filter(ref => !idSet.has(ref.id));
  writePending(store, remaining);
}

/** Test-only: a working in-memory KeyValueStore, for environments (some Node test runtimes)
 *  where the built-in `localStorage` global exists but is not actually functional. */
export function createInMemoryStoreForTests(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
