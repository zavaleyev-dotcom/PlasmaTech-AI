/** Bridges SciFinder search results into Scientific Writer's References list - deterministic
 *  field mapping only, no second bibliography model, no new external calls. Reuses the SAME
 *  DOI/title normalization already used by the combined-search deduplication pipeline
 *  (src/services/scientific-search/normalization.ts), so "the same DOI" means the same thing on
 *  both sides of the integration. Transfer between the two independent workspace modules uses
 *  this browser's own localStorage only - never sent to a server, never shared across devices,
 *  matching the pattern already used by TechDoc Assistant's own draft persistence. */

import { normalizeDoi, normalizedTitle } from '@/services/scientific-search/normalization';
import type { Publication } from '@/services/scientific-search/types';
import { generateReferenceId, type Reference, type ReferenceType, type ReferenceProvenance } from './references';

const STORAGE_KEY = 'plasmatech.scifinder-import.v1';
const MAX_LEDGER_ENTRIES = 200;

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

// ---------- duplicate detection (item 8): DOI > title+year > title+first author ----------

function bestDedupKey(ref: Pick<Reference, 'doi' | 'title' | 'year' | 'authors'>): string | null {
  if (ref.doi) {
    const normalized = normalizeDoi(ref.doi);
    if (normalized) return `doi:${normalized}`;
  }
  const title = ref.title ? normalizedTitle(ref.title) : '';
  if (title && ref.year !== undefined) return `title-year:${title}|${ref.year}`;
  if (title && ref.authors[0]) return `title-author:${title}|${normalizedTitle(ref.authors[0])}`;
  return null;
}

// ---------- the transfer ledger itself (item 6) ----------

interface LedgerRecord { reference: Reference; consumed: boolean }

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

function isLedgerRecord(value: unknown): value is LedgerRecord {
  return value !== null && typeof value === 'object' && typeof (value as { consumed?: unknown }).consumed === 'boolean'
    && typeof (value as { reference?: unknown }).reference === 'object' && (value as { reference?: unknown }).reference !== null;
}

function readLedger(store: KeyValueStore | null): LedgerRecord[] {
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLedgerRecord) : [];
  } catch { return []; }
}

function writeLedger(store: KeyValueStore | null, records: LedgerRecord[]): void {
  if (!store) return;
  try { store.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_LEDGER_ENTRIES))); }
  catch { /* storage unavailable (quota/private mode) - nothing to fall back to */ }
}

export type ImportOutcome =
  | { status: 'queued'; reference: Reference }
  | { status: 'duplicate'; existingReference: Reference };

/** Called from the SciFinder "Добавить в Scientific Writer" action. Never adds a silent
 *  duplicate (item 5/8): if the same publication (by DOI, else title+year, else title+first
 *  author) was already sent through this mechanism, reports it instead of queuing a copy. */
export function queuePublicationForScientificWriter(pub: Publication, store: KeyValueStore | null = detectWorkingLocalStorage()): ImportOutcome {
  const reference = mapPublicationToReference(pub);
  const ledger = readLedger(store);
  const key = bestDedupKey(reference);
  if (key) {
    const existing = ledger.find(record => bestDedupKey(record.reference) === key);
    if (existing) return { status: 'duplicate', existingReference: existing.reference };
  }
  writeLedger(store, [...ledger, { reference, consumed: false }]);
  return { status: 'queued', reference };
}

/** Called once when Scientific Writer mounts: returns every reference queued since the last
 *  time it was consumed, and marks them consumed so a later remount does not re-add them. The
 *  ledger itself is kept (not cleared) so duplicate detection above still works across page
 *  reloads within the same browser. */
export function consumePendingReferences(store: KeyValueStore | null = detectWorkingLocalStorage()): Reference[] {
  const ledger = readLedger(store);
  const pending = ledger.filter(record => !record.consumed);
  if (pending.length === 0) return [];
  writeLedger(store, ledger.map(record => ({ ...record, consumed: true })));
  return pending.map(record => record.reference);
}

/** Test-only: a working in-memory KeyValueStore, for environments (some Node test runtimes)
 *  where the built-in `localStorage` global exists but is not actually functional. */
export function createInMemoryStoreForTests(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
