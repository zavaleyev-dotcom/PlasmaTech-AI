import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { listZipEntries, readZipEntryText } from './helpers/zip-reader';
import { normalizeCrossrefWork } from '../src/integrations/crossref/normalize';
import { normalizeOpenAlexWork } from '../src/integrations/openalex/normalize';
import type { Publication } from '../src/services/scientific-search/types';
import {
  mapPublicationToReference, queuePublicationForScientificWriter, peekPendingReferences, clearPendingReferences,
  createInMemoryStoreForTests, type KeyValueStore,
} from '../src/services/workspace/scifinder-import';
import {
  formatReferenceApa, formatReferenceIeee, formatReferenceGost, removeReference, updateReference, type Reference,
} from '../src/services/workspace/references';
import { loadReferences, saveReferences, mergeReferencesById } from '../src/services/workspace/scientific-writer-references-store';
import { exportScientificDocument, buildScientificDocumentViewModel } from '../src/services/workspace/scientific-writer-export';

// The Node test runtime's built-in `localStorage` global exists but its methods are
// non-functional stubs here, so every ledger test gets its own real, working in-memory store
// instead of relying on the (auto-detected, real-browser-only) default.
function freshStore(): KeyValueStore {
  return createInMemoryStoreForTests();
}

/** Simulates EXACTLY what Scientific Writer's own mount effect does (see
 *  src/components/scientific-writer.tsx): load the canonical list, merge in anything queued
 *  from SciFinder, and only clear the queue once the merge is confirmed durably saved. Used
 *  here to exercise the real F02 fix (persistence across "unmount/remount") without a browser. */
function simulateScientificWriterMount(store: KeyValueStore): Reference[] {
  const saved = loadReferences(store);
  const pending = peekPendingReferences(store);
  if (pending.length === 0) return saved;
  const merged = mergeReferencesById(saved, pending);
  if (saveReferences(merged, store)) clearPendingReferences(pending.map(r => r.id), store);
  return merged;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}

// A realistic, but entirely synthetic (test-only), Crossref "work" JSON shape.
function crossrefWork(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DOI: '10.5555/scifinder.test.0001',
    title: ['Synthetic SciFinder-import test article on AlTiN coatings'],
    author: [{ given: 'Test', family: 'AuthorOne' }, { given: 'Test', family: 'AuthorTwo' }],
    published: { 'date-parts': [[2022]] },
    'container-title': ['SciFinder Test Journal'],
    publisher: 'Test Publisher',
    URL: 'https://example.test/scifinder-article',
    type: 'journal-article',
    ...overrides,
  };
}

function openAlexWork(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://openalex.org/W2001',
    title: 'Synthetic OpenAlex-import test article on AlTiN coatings',
    authorships: [{ author: { display_name: 'Test AuthorThree' } }],
    publication_year: 2021,
    primary_location: { source: { display_name: 'OpenAlex Test Source', type: 'journal' }, landing_page_url: 'https://example.test/openalex-article' },
    doi: '10.5555/scifinder.test.0002',
    type: 'article',
    cited_by_count: 3,
    open_access: { is_oa: true },
    ...overrides,
  };
}

// ---------- mapping: Crossref/OpenAlex result -> Reference (item 3/14) ----------

test('mapPublicationToReference: Crossref journal article maps deterministically, with SciFinder provenance', () => {
  const pub = normalizeCrossrefWork(crossrefWork());
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.type, 'journal_article');
  assert.deepEqual(ref.authors, ['Test AuthorOne', 'Test AuthorTwo']);
  assert.equal(ref.title, 'Synthetic SciFinder-import test article on AlTiN coatings');
  assert.equal(ref.containerTitle, 'SciFinder Test Journal');
  assert.equal(ref.year, 2022);
  assert.equal(ref.doi, '10.5555/scifinder.test.0001');
  assert.equal(ref.volume, undefined);
  assert.equal(ref.issue, undefined);
  assert.equal(ref.pages, undefined);
  assert.equal(ref.provenance?.source, 'scifinder');
  assert.equal(ref.provenance?.provider, 'crossref');
  assert.equal(ref.provenance?.originalId, '10.5555/scifinder.test.0001');
  assert.ok(ref.provenance?.importedAt);
});

test('mapPublicationToReference: OpenAlex journal article maps deterministically, with SciFinder provenance', () => {
  const pub = normalizeOpenAlexWork(openAlexWork());
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.type, 'journal_article');
  assert.deepEqual(ref.authors, ['Test AuthorThree']);
  assert.equal(ref.containerTitle, 'OpenAlex Test Source');
  assert.equal(ref.year, 2021);
  assert.equal(ref.doi, '10.5555/scifinder.test.0002');
  assert.equal(ref.provenance?.provider, 'openalex');
});

test('mapPublicationToReference: missing DOI stays undefined - never fabricated, and provenance falls back to the internal id', () => {
  const pub = normalizeCrossrefWork(crossrefWork({ DOI: undefined }));
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.doi, undefined);
  assert.equal(ref.provenance?.originalId, pub.id);
});

test('mapPublicationToReference: missing journal/container-title stays undefined', () => {
  const pub = normalizeCrossrefWork(crossrefWork({ 'container-title': undefined }));
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.containerTitle, undefined);
});

test('mapPublicationToReference: multiple authors are preserved in order, never truncated or reformatted', () => {
  const pub = normalizeCrossrefWork(crossrefWork({ author: [
    { given: 'A', family: 'One' }, { given: 'B', family: 'Two' }, { given: 'C', family: 'Three' },
  ] }));
  const ref = mapPublicationToReference(pub);
  assert.deepEqual(ref.authors, ['A One', 'B Two', 'C Three']);
});

test('mapPublicationToReference: Cyrillic and Unicode metadata survive unaltered', () => {
  const pub = normalizeCrossrefWork(crossrefWork({
    title: ['Синтетическая тестовая статья о покрытиях AlTiN (µm, 400 °C)'],
    author: [{ given: 'Тест', family: 'Авторов' }],
    'container-title': ['Тестовый научный журнал'],
  }));
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.title, 'Синтетическая тестовая статья о покрытиях AlTiN (µm, 400 °C)');
  assert.deepEqual(ref.authors, ['Тест Авторов']);
  assert.equal(ref.containerTitle, 'Тестовый научный журнал');
});

test('mapPublicationToReference: a missing title (Crossref\'s own "Без названия" placeholder) never becomes a fabricated Reference title', () => {
  const pub = normalizeCrossrefWork(crossrefWork({ title: undefined }));
  assert.equal(pub.title, 'Без названия');
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.title, undefined);
});

test('mapPublicationToReference: publication type mapping covers conference/book/book-chapter/thesis/report/website, never inventing a bibliographic fact', () => {
  const cases: [string, string][] = [
    ['proceedings-article', 'conference_paper'], ['book-chapter', 'book_chapter'],
    ['book', 'book'], ['dissertation', 'thesis'], ['report', 'report'],
  ];
  for (const [crossrefType, expected] of cases) {
    const pub = normalizeCrossrefWork(crossrefWork({ type: crossrefType }));
    assert.equal(mapPublicationToReference(pub).type, expected, `type ${crossrefType}`);
  }
  const noJournalNoType = normalizeCrossrefWork(crossrefWork({ type: 'dataset', 'container-title': undefined }));
  assert.equal(mapPublicationToReference(noJournalNoType).type, 'website');
});

test('mapPublicationToReference: no fabricated metadata - a nearly-empty publication maps to a reference with every unavailable field left undefined', () => {
  const pub = normalizeCrossrefWork({ title: undefined, DOI: undefined, author: undefined, 'container-title': undefined, URL: undefined, type: undefined });
  const ref = mapPublicationToReference(pub);
  assert.equal(ref.title, undefined);
  assert.equal(ref.doi, undefined);
  assert.deepEqual(ref.authors, []);
  assert.equal(ref.containerTitle, undefined);
  assert.equal(ref.year, undefined);
  for (const style of [formatReferenceApa(ref), formatReferenceIeee(ref, 1), formatReferenceGost(ref, 1)]) {
    assert.ok(!/undefined/i.test(style));
  }
});

// ---------- duplicate detection (item 8) ----------

test('duplicate DOI: queuing the same DOI twice is reported as a duplicate, never silently added twice', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  const first = queuePublicationForScientificWriter(pub, store);
  assert.equal(first.status, 'queued');
  const second = queuePublicationForScientificWriter(pub, store);
  assert.equal(second.status, 'duplicate');
});

test('DOI normalization: "https://doi.org/10.x/y" and "10.x/y" are treated as the exact same DOI for dedup purposes', () => {
  const store = freshStore();
  const first = normalizeCrossrefWork(crossrefWork({ DOI: '10.5555/scifinder.test.0003' }));
  queuePublicationForScientificWriter(first, store);
  const second = normalizeCrossrefWork(crossrefWork({ DOI: 'https://doi.org/10.5555/SCIFINDER.TEST.0003' }));
  const outcome = queuePublicationForScientificWriter(second, store);
  assert.equal(outcome.status, 'duplicate');
});

test('duplicate title/year (no DOI on either side) is reported as a duplicate', () => {
  const store = freshStore();
  const first = normalizeCrossrefWork(crossrefWork({ DOI: undefined, title: ['Same synthetic title, different casing'] }));
  queuePublicationForScientificWriter(first, store);
  const second = normalizeCrossrefWork(crossrefWork({ DOI: undefined, title: ['SAME SYNTHETIC TITLE, DIFFERENT CASING'] }));
  const outcome = queuePublicationForScientificWriter(second, store);
  assert.equal(outcome.status, 'duplicate');
});

test('a different DOI is never conflated with a duplicate title/year match', () => {
  const store = freshStore();
  const first = normalizeCrossrefWork(crossrefWork({ DOI: '10.5555/scifinder.test.0004', title: ['Distinctly titled synthetic article'] }));
  queuePublicationForScientificWriter(first, store);
  const second = normalizeCrossrefWork(crossrefWork({ DOI: '10.5555/scifinder.test.0005', title: ['Distinctly titled synthetic article'] }));
  const outcome = queuePublicationForScientificWriter(second, store);
  assert.equal(outcome.status, 'queued');
});

// ---------- provider disagreement / provenance (items 4/9/14) ----------

test('provenance: a fresh import records source=scifinder, provider, importedAt and originalId', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  const outcome = queuePublicationForScientificWriter(pub, store);
  assert.equal(outcome.status, 'queued');
  if (outcome.status === 'queued') {
    assert.equal(outcome.reference.provenance?.source, 'scifinder');
    assert.equal(outcome.reference.provenance?.provider, 'crossref');
  }
});

test('provider disagreement: a publication already merged from Crossref+OpenAlex (upstream dedup) carries both provider names into provenance, without this integration re-merging or overwriting any field itself', () => {
  const mergedPublication: Publication = {
    id: 'crossref:10.5555/scifinder.test.0006', title: 'Merged synthetic publication', authors: ['Test AuthorFour'],
    year: 2020, journal: 'Merged Test Journal', doi: '10.5555/scifinder.test.0006', abstract: null, publisher: null,
    url: null, type: 'journal-article', source: 'crossref', sources: ['crossref', 'openalex'],
    openAccess: null, citationCount: null, openAlexId: 'https://openalex.org/W3001',
  };
  const ref = mapPublicationToReference(mergedPublication);
  assert.equal(ref.provenance?.provider, 'crossref+openalex');
  assert.equal(ref.containerTitle, 'Merged Test Journal', 'the already-merged field is passed through as-is, never re-derived');
});

// ---------- import into Scientific Writer / edit / remove (item 14) ----------

test('import into Scientific Writer: mounting merges the queue into the canonical store and clears it, so a second mount does not re-add anything', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  queuePublicationForScientificWriter(pub, store);
  const firstMount = simulateScientificWriterMount(store);
  assert.equal(firstMount.length, 1);
  assert.equal(firstMount[0].doi, '10.5555/scifinder.test.0001');
  assert.equal(peekPendingReferences(store).length, 0, 'the queue must be cleared once the merge is durably saved');

  const secondMount = simulateScientificWriterMount(store);
  assert.equal(secondMount.length, 1, 'the reference must still be there on a second mount - not duplicated, not lost');
  assert.deepEqual(secondMount, firstMount);
});

test('remove imported reference: removeReference works uniformly on a SciFinder-imported reference', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  queuePublicationForScientificWriter(pub, store);
  const [imported] = simulateScientificWriterMount(store);
  const afterRemoval = removeReference([imported], imported.id);
  assert.equal(afterRemoval.length, 0);
});

test('edit imported reference: updateReference changes a field while provenance is preserved unless explicitly overwritten', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  queuePublicationForScientificWriter(pub, store);
  const [imported] = simulateScientificWriterMount(store);
  const [edited] = updateReference([imported], imported.id, { title: 'Manually corrected title' });
  assert.equal(edited.title, 'Manually corrected title');
  assert.equal(edited.provenance?.source, 'scifinder');
});

// ---------- F02 (HIGH) full regression flow: persistence survives unmount/remount ----------

test('F02 full flow: import -> mount (merge+save) -> simulated unmount/remount -> reference still restored, and re-importing the SAME DOI is correctly a duplicate', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());

  // 1. SciFinder: user clicks "Добавить в Scientific Writer".
  const queued = queuePublicationForScientificWriter(pub, store);
  assert.equal(queued.status, 'queued');

  // 2. Scientific Writer mounts for the first time: reference appears, queue is drained.
  const afterFirstMount = simulateScientificWriterMount(store);
  assert.equal(afterFirstMount.length, 1);

  // 3. Simulated unmount: nothing more happens to the store (no code runs) - this IS the
  //    unmount, since React state alone (never touched here) is where the OLD bug lived.

  // 4. Simulated remount: Scientific Writer mounts again from scratch.
  const afterRemount = simulateScientificWriterMount(store);
  assert.equal(afterRemount.length, 1, 'the reference must survive the remount - this is exactly the bug F02 reports');
  assert.equal(afterRemount[0].doi, '10.5555/scifinder.test.0001');

  // 5. Re-importing the SAME publication is correctly detected as a duplicate, because the
  //    reference genuinely, durably still exists - not because of a stale, separate ledger flag.
  const secondImport = queuePublicationForScientificWriter(pub, store);
  assert.equal(secondImport.status, 'duplicate');

  // 6. After the user deletes the reference, the DOI is genuinely gone - so re-importing the
  //    same publication is now correctly allowed again (predictable delete/re-import semantics).
  const afterDelete = removeReference(afterRemount, afterRemount[0].id);
  assert.equal(saveReferences(afterDelete, store), true);
  const thirdImport = queuePublicationForScientificWriter(pub, store);
  assert.equal(thirdImport.status, 'queued', 'once genuinely deleted, the same DOI must be importable again');
});

test('F02: a failed save never clears the pending queue, so a later successful mount still delivers the reference', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  queuePublicationForScientificWriter(pub, store);

  // Simulate a mount whose save attempt fails (storage unavailable/quota) - pass a store whose
  // setItem always throws, exactly like a real quota/permission failure would.
  const failingStore: KeyValueStore = { getItem: store.getItem.bind(store), setItem: () => { throw new Error('quota exceeded'); } };
  const saved = loadReferences(failingStore);
  const pendingDuringFailure = peekPendingReferences(failingStore);
  assert.equal(pendingDuringFailure.length, 1);
  const merged = mergeReferencesById(saved, pendingDuringFailure);
  const persisted = saveReferences(merged, failingStore);
  assert.equal(persisted, false, 'the save itself must honestly report failure');
  if (persisted) clearPendingReferences(pendingDuringFailure.map(r => r.id), failingStore); // never reached - mirrors the real component's guard

  // The queue must be untouched by the failed attempt - a later, working mount still delivers it.
  assert.equal(peekPendingReferences(store).length, 1, 'a failed save must never clear the pending queue');
  const laterMount = simulateScientificWriterMount(store);
  assert.equal(laterMount.length, 1, 'the reference must still be delivered once storage works again');
});

// ---------- F18 (LOW): queuePublicationForScientificWriter atomic semantics - "queued" is
// reported ONLY after a confirmed write; a storage failure is its own honest status ----------

test('F18 queuePublicationForScientificWriter: a normal, working store genuinely queues the reference (regression against breaking the happy path)', () => {
  const store = freshStore();
  const pub = normalizeCrossrefWork(crossrefWork());
  const outcome = queuePublicationForScientificWriter(pub, store);
  assert.equal(outcome.status, 'queued');
  assert.equal(peekPendingReferences(store).length, 1);
});

test('F18 queuePublicationForScientificWriter: setItem throwing (quota exceeded / storage unavailable) reports "failed", never "queued"', () => {
  const throwingStore: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const pub = normalizeCrossrefWork(crossrefWork());
  const outcome = queuePublicationForScientificWriter(pub, throwingStore);
  assert.equal(outcome.status, 'failed', 'the Codex regression - previously this was falsely reported as "queued"');
});

test('F18 queuePublicationForScientificWriter: storage genuinely unavailable (null store, e.g. private-mode browsing) also reports "failed"', () => {
  const outcome = queuePublicationForScientificWriter(normalizeCrossrefWork(crossrefWork()), null);
  assert.equal(outcome.status, 'failed');
});

test('F18 queuePublicationForScientificWriter: after a failed write, retrying the SAME publication against a now-working store succeeds - never permanently stuck', () => {
  const pub = normalizeCrossrefWork(crossrefWork());
  const throwingStore: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const failedAttempt = queuePublicationForScientificWriter(pub, throwingStore);
  assert.equal(failedAttempt.status, 'failed');

  const workingStore = freshStore();
  const retry = queuePublicationForScientificWriter(pub, workingStore);
  assert.equal(retry.status, 'queued', 'a retry against working storage must succeed - the failed attempt left nothing behind to block it');
});

test('F18 queuePublicationForScientificWriter: a failed write never creates a false "duplicate" report for the very next attempt', () => {
  const pub = normalizeCrossrefWork(crossrefWork());
  const throwingStore: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  queuePublicationForScientificWriter(pub, throwingStore);
  // Retry against the SAME (still-throwing) store - since nothing was ever durably written,
  // the dedup check must find no existing match; the outcome must be "failed" again, not
  // "duplicate" (which would incorrectly imply a real, saved copy already exists).
  const secondAttempt = queuePublicationForScientificWriter(pub, throwingStore);
  assert.equal(secondAttempt.status, 'failed');
});

// ---------- citation formatting after import (item 11/14) ----------

test('APA/IEEE/GOST-style formatting works immediately on an imported reference, without any separate SciFinder-specific formatter', () => {
  const pub = normalizeCrossrefWork(crossrefWork());
  const ref = mapPublicationToReference(pub);
  const apa = formatReferenceApa(ref);
  assert.ok(apa.includes('Test AuthorOne') && apa.includes('2022') && apa.includes('SciFinder Test Journal'));
  const ieee = formatReferenceIeee(ref, 1);
  assert.ok(ieee.startsWith('[1]') && ieee.includes('10.5555/scifinder.test.0001'));
  const gost = formatReferenceGost(ref, 1);
  assert.ok(gost.startsWith('1.') && gost.includes('// SciFinder Test Journal'));
  for (const text of [apa, ieee, gost]) assert.ok(!/undefined/i.test(text));
});

// ---------- full DOCX/PDF export flow after import (item 12/14) ----------

test('DOCX export after import: the bibliography contains the real author/DOI from the SciFinder result', async () => {
  const pub = normalizeCrossrefWork(crossrefWork());
  const ref = mapPublicationToReference(pub);
  const request = {
    documentType: 'article' as const, title: 'Import flow smoke document', generatedByAI: false,
    sections: [{ heading: 'Abstract', text: 'Synthetic content for the export flow test.' }],
    providedFields: [], missingFields: [], warnings: [],
    references: [ref], citationStyle: 'ieee' as const,
  };
  const { buffer } = await exportScientificDocument(request, 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  assert.ok(listZipEntries(buffer).includes('word/document.xml'));
  assert.ok(xml.includes('Test AuthorOne'));
  assert.ok(xml.includes('10.5555/scifinder.test.0001'));
  assert.ok(xml.includes('Список источников'));
});

test('PDF export after import: the bibliography contains the real author/DOI from the SciFinder result', async () => {
  const pub = normalizeOpenAlexWork(openAlexWork());
  const ref = mapPublicationToReference(pub);
  const request = {
    documentType: 'article' as const, title: 'Import flow smoke document', generatedByAI: false,
    sections: [{ heading: 'Abstract', text: 'Synthetic content for the export flow test.' }],
    providedFields: [], missingFields: [], warnings: [],
    references: [ref], citationStyle: 'apa' as const,
  };
  const { buffer } = await exportScientificDocument(request, 'pdf');
  const text = await extractPdfText(buffer);
  assert.ok(text.includes('Test AuthorThree'));
  assert.ok(text.includes('10.5555/scifinder.test.0002'));
});

test('buildScientificDocumentViewModel: an imported reference with a malformed/absent field still integrity-checks cleanly through the existing checkReferenceList path', () => {
  const pub = normalizeCrossrefWork(crossrefWork({ DOI: undefined }));
  const ref = mapPublicationToReference(pub);
  const viewModel = buildScientificDocumentViewModel({
    documentType: 'article', generatedByAI: false, sections: [{ heading: 'Abstract', text: 'x' }],
    providedFields: [], missingFields: [], warnings: [], references: [ref], citationStyle: 'gost',
  });
  const errorMeta = viewModel.traceability.find(t => t.label.includes('ошибки'));
  assert.equal(errorMeta?.value, 'нет', 'a merely-missing DOI is not an error - only a malformed one is');
});
