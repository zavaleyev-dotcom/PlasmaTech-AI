import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRAFT_STORAGE_KEY, UNREADABLE_DRAFT_KEY, createDraftPersistence, createGenerationGuard, createInMemoryDraftStore, defaultDraftContent, defaultDraftForm, detectDraftStore,
  isResultStale, loadDraft, parseDraft, applyGenerationOutcome, createAutosave, type DraftContent, type DraftStore, type GenerationView, type SaveOutcome, type Timers,
} from '../src/services/workspace/scientific-writer-draft-store';
import { saveReferences, createInMemoryStoreForTests, loadReferences } from '../src/services/workspace/scientific-writer-references-store';
import { createReference } from '../src/services/workspace/references';
import { buildEvidenceReport, buildLocalScaffold } from '../src/services/workspace/scientific-writer';

const FIXED = () => new Date('2030-01-02T03:04:05.000Z');
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));   // what survives storage: an `undefined` property is simply absent
const content = (over: Partial<DraftContent> = {}): DraftContent => ({ ...defaultDraftContent(), ...over });
const typed = (): DraftContent => content({ form: { ...defaultDraftForm(), title: 'СИНТЕТИЧЕСКАЯ тема', goal: '  цель с пробелами  \n\nвторой абзац\t', keywords: 'α-C, ta-C' } });
const generated = (): DraftContent => {
  const form = { ...defaultDraftForm(), title: 'T', goal: 'G', methods: 'M' };
  const input = { documentType: form.documentType, mode: form.mode, targetLanguage: form.targetLanguage, title: 'T', goal: 'G', methods: 'M' };
  const evidence = buildEvidenceReport(input);
  return content({
    form, scaffold: buildLocalScaffold(input, evidence), evidencePreview: evidence, generatedFrom: JSON.stringify(form),
    result: { generatedText: 'Сгенерированный текст  с  двойными пробелами\n\n- пункт', evidence, preservation: { ok: false, preservedNumbers: ['1'], missingNumbers: ['2'], preservedTerms: [], missingTerms: ['PVD'] }, changes: ['изменено'], warnings: ['проверьте'] },
    citationStyle: 'gost', profileId: 'thesis_report', exportFormat: 'pdf',
  });
};
const hydrated = (store: DraftStore | null = createInMemoryDraftStore()) => { const p = createDraftPersistence(store, FIXED); p.hydrate(); return { p, store }; };
const stored = (store: DraftStore) => JSON.parse(store.getItem(DRAFT_STORAGE_KEY) ?? 'null');

test('1. a new draft is saved under its own versioned key, with the time of saving', () => {
  const { p, store } = hydrated();
  assert.equal(store!.getItem(DRAFT_STORAGE_KEY), null);
  const outcome = p.save(typed());
  assert.deepEqual(outcome, { ok: true, savedAt: '2030-01-02T03:04:05.000Z' });
  const raw = stored(store!);
  assert.equal(raw.version, 1);
  assert.equal(raw.savedAt, '2030-01-02T03:04:05.000Z');
  assert.equal(raw.form.title, 'СИНТЕТИЧЕСКАЯ тема');
  assert.match(DRAFT_STORAGE_KEY, /\.v1$/);
  assert.notEqual(DRAFT_STORAGE_KEY, 'plasmatech.scientific-writer.references.v1');                // does not collide with the bibliography
});

test('2. a saved draft is restored exactly (after navigating away, a refresh or reopening the tab = a new controller over the same storage)', () => {
  const store = createInMemoryDraftStore();
  hydrated(store).p.save(generated());
  const second = createDraftPersistence(store, FIXED);
  const loaded = second.hydrate();
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  const { version, savedAt, ...restored } = loaded.draft;
  assert.equal(version, 1); assert.equal(savedAt, '2030-01-02T03:04:05.000Z');
  assert.deepEqual(restored, json(generated()));
  assert.equal(parseDraft(JSON.parse(store.getItem(DRAFT_STORAGE_KEY)!))?.form.title, 'T');
});

test('3. the generation result, the structure and the chosen options are saved and restored', () => {
  const store = createInMemoryDraftStore();
  hydrated(store).p.save(generated());
  const loaded = loadDraft(store);
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  assert.equal(loaded.draft.result?.generatedText, generated().result!.generatedText);
  assert.deepEqual(loaded.draft.result?.preservation, json(generated().result!.preservation));
  assert.deepEqual(loaded.draft.result?.warnings, ['проверьте']);
  assert.deepEqual(loaded.draft.scaffold, json(generated().scaffold));
  assert.deepEqual(loaded.draft.evidencePreview, json(generated().evidencePreview));
  assert.equal(loaded.draft.generatedFrom, generated().generatedFrom);
  assert.equal(loaded.draft.citationStyle, 'gost'); assert.equal(loaded.draft.profileId, 'thesis_report'); assert.equal(loaded.draft.exportFormat, 'pdf');
});

test('4. a manual edit after the generation is saved; the stored result is not touched and is reported as stale', () => {
  const { p, store } = hydrated();
  const first = generated();
  p.save(first);
  const edited = { ...first, form: { ...first.form, results: 'добавлено вручную' } };
  assert.equal(p.save(edited).ok, true);
  const loaded = loadDraft(store!);
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  assert.equal(loaded.draft.form.results, 'добавлено вручную');
  assert.equal(loaded.draft.result?.generatedText, first.result!.generatedText);
  assert.equal(isResultStale(loaded.draft.generatedFrom, first.form), false);
  assert.equal(isResultStale(loaded.draft.generatedFrom, loaded.draft.form), true);                // the form changed after the result was generated
  assert.equal(isResultStale(null, loaded.draft.form), false);
});

test('5. a damaged JSON gives no draft, nothing throws, and the damaged value is put aside before anything overwrites it', () => {
  for (const raw of ['{not json', '', '[]', 'null', '42', '"text"', '{"version":1}', '{"version":1,"savedAt":"x","form":{}}']) {
    const store = createInMemoryDraftStore();
    if (raw !== '') store.setItem(DRAFT_STORAGE_KEY, raw);
    const loaded = loadDraft(store);
    assert.ok(loaded.status === 'corrupted' || loaded.status === 'empty', `${raw} -> ${loaded.status}`);
  }
  const store = createInMemoryDraftStore();
  store.setItem(DRAFT_STORAGE_KEY, '{broken');
  const p = createDraftPersistence(store, FIXED);
  assert.equal(p.hydrate().status, 'corrupted');
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), '{broken');                                      // reading changes nothing
  assert.equal(p.save(defaultDraftContent()).ok, false);                                          // the untouched empty form is not written over it
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), '{broken');
  assert.equal(p.save(typed()).ok, true);                                                         // the first real change: the old value is quarantined first
  assert.equal(store.getItem(UNREADABLE_DRAFT_KEY), '{broken');
  assert.equal(loadDraft(store).status, 'restored');
});

test('5b. every field of a restored draft is validated; one wrong field rejects the whole draft', () => {
  const good = JSON.parse(JSON.stringify({ version: 1, savedAt: '2030-01-02T03:04:05.000Z', ...generated() }));
  assert.notEqual(parseDraft(good), null);
  const mutate = (fn: (d: Record<string, any>) => void) => { const d = JSON.parse(JSON.stringify(good)); fn(d); return parseDraft(d); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const bad: [string, (d: Record<string, any>) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['documentType', d => { d.form.documentType = 'novel'; }], ['mode', d => { d.form.mode = 'x'; }], ['language', d => { d.form.targetLanguage = 'de'; }],
    ['title type', d => { d.form.title = 5; }], ['title too long', d => { d.form.title = 'x'.repeat(501); }], ['goal too long', d => { d.form.goal = 'x'.repeat(20_001); }], ['missing field', d => { delete d.form.methods; }],
    ['citationStyle', d => { d.citationStyle = 'mla'; }], ['profileId', d => { d.profileId = 'x'; }], ['exportFormat', d => { d.exportFormat = 'odt'; }],
    ['scaffold shape', d => { d.scaffold = [{ heading: 1 }]; }], ['scaffold not list', d => { d.scaffold = {}; }], ['evidence', d => { d.evidencePreview = { provided: 'x', missing: [], fields: [] }; }],
    ['evidence key', d => { d.evidencePreview.fields[0].key = 'secret'; }], ['result text', d => { d.result.generatedText = 5; }], ['result warnings', d => { d.result.warnings = [1]; }],
    ['preservation', d => { d.result.preservation = { ok: 'yes' }; }], ['changes', d => { d.result.changes = 'x'; }], ['generatedFrom', d => { d.generatedFrom = 5; }], ['savedAt', d => { d.savedAt = 'yesterday'; }],
    ['missing version', d => { delete d.version; }], ['undefined result', d => { delete d.result; }],
  ];
  for (const [name, fn] of bad) assert.equal(mutate(fn), null, name);
  assert.notEqual(mutate(d => { d.result = null; d.scaffold = null; d.evidencePreview = null; d.generatedFrom = null; }), null);       // nothing generated yet is valid
  assert.notEqual(mutate(d => { d.form.goal = 'x'.repeat(20_000); }), null);                                                           // the limit itself is valid
});

test('6. an unknown version is not loaded and not overwritten before it is put aside', () => {
  const store = createInMemoryDraftStore();
  const future = JSON.stringify({ version: 2, savedAt: '2030-01-02T03:04:05.000Z', somethingNew: true });
  store.setItem(DRAFT_STORAGE_KEY, future);
  const p = createDraftPersistence(store, FIXED);
  const loaded = p.hydrate();
  assert.equal(loaded.status, 'unsupported_version');
  if (loaded.status === 'unsupported_version') assert.equal(loaded.version, 2);
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), future);
  assert.equal(p.save(typed()).ok, true);
  assert.equal(store.getItem(UNREADABLE_DRAFT_KEY), future);                                     // the newer data are kept, not destroyed
  assert.equal(loadDraft(createInMemoryDraftStore()).status, 'empty');
  for (const version of [0, 1.5, '1', null]) { const s = createInMemoryDraftStore(); s.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version })); assert.notEqual(loadDraft(s).status, 'restored'); }
});

test('6b. if an unreadable value cannot be put aside, nothing is overwritten', () => {
  const data = new Map<string, string>([[DRAFT_STORAGE_KEY, '{broken']]);
  const store: DraftStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { if (k === UNREADABLE_DRAFT_KEY) throw new Error('quota'); data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const p = createDraftPersistence(store, FIXED); p.hydrate();
  assert.deepEqual(p.save(typed()), { ok: false, reason: 'quarantine_failed' });
  assert.equal(data.get(DRAFT_STORAGE_KEY), '{broken');
});

test('7. an unavailable or broken localStorage: no exception, honest outcomes, nothing at import or on the server', () => {
  const p = createDraftPersistence(null, FIXED);
  assert.deepEqual(p.hydrate(), { status: 'unavailable' });
  assert.deepEqual(p.save(typed()), { ok: false, reason: 'not_hydrated' });                          // nothing was read, so nothing is written
  assert.deepEqual(p.clear(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(loadDraft(null), { status: 'unavailable' });
  const throwing: DraftStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  const q = createDraftPersistence(throwing, FIXED);
  assert.deepEqual(q.hydrate(), { status: 'read_failed' });                                       // the storage exists, reading failed: not the same as "no storage"
  assert.deepEqual(q.save(typed()), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(q.clear(), { ok: false, reason: 'not_hydrated' });
  // the server: no `localStorage` at all, or a getter that throws (blocked storage)
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    assert.equal(detectDraftStore(), null);
    delete (globalThis as { localStorage?: unknown }).localStorage;
    assert.equal(detectDraftStore(), null);
  } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
  // the component reaches storage only through this module, inside effects
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.ok(!/\blocalStorage\b/.test(component));
  const storeSource = readFileSync(join(__dirname, '../src/services/workspace/scientific-writer-draft-store.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/^(const|let|var)\s.*localStorage/m.test(storeSource));                                     // no top-level access
});

test('8. the empty initial values never overwrite a saved draft: nothing is written before the stored draft was read, and an untouched form is not written', () => {
  const store = createInMemoryDraftStore();
  hydrated(store).p.save(generated());
  const before = store.getItem(DRAFT_STORAGE_KEY);
  const p = createDraftPersistence(store, FIXED);
  assert.deepEqual(p.save(defaultDraftContent()), { ok: false, reason: 'not_hydrated' });             // the first render's empty form, before the restore
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), before);
  p.hydrate();
  assert.equal(p.isHydrated(), true);
  assert.deepEqual(p.save(generated()), { ok: false, reason: 'unchanged' });                          // the restored draft is not rewritten
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), before);
  const fresh = createDraftPersistence(createInMemoryDraftStore(), FIXED); fresh.hydrate();
  assert.deepEqual(fresh.save(defaultDraftContent()), { ok: false, reason: 'unchanged' });             // an untouched new form creates no stored draft
});

test('9. a failed write (quota, error) reports honestly, keeps the previous stored draft, and is retried on the next change', () => {
  const data = new Map<string, string>();
  let failing: 'quota' | 'plain' | null = null;
  const store: DraftStore = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { if (failing === 'quota') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } if (failing === 'plain') throw new Error('boom'); data.set(k, v); },
    removeItem: k => { data.delete(k); },
  };
  const p = createDraftPersistence(store, FIXED); p.hydrate();
  assert.equal(p.save(typed()).ok, true);
  const good = data.get(DRAFT_STORAGE_KEY);
  const next = { ...typed(), form: { ...typed().form, title: 'новое название' } };
  failing = 'quota';
  assert.deepEqual(p.save(next), { ok: false, reason: 'quota' });
  failing = 'plain';
  assert.deepEqual(p.save(next), { ok: false, reason: 'error' });
  assert.equal(data.get(DRAFT_STORAGE_KEY), good);                                                    // the previous draft is intact
  failing = null;
  assert.equal(p.save(next).ok, true);                                                                // the same content is tried again, because it was never saved
  assert.equal(stored(store).form.title, 'новое название');
  const domQuota = Object.assign(new Error('x'), { code: 22 });
  const s2: DraftStore = { getItem: () => null, setItem: () => { throw domQuota; }, removeItem: () => undefined };
  const p2 = createDraftPersistence(s2, FIXED); p2.hydrate();
  assert.deepEqual(p2.save(typed()), { ok: false, reason: 'quota' });
});

test('10. the text is stored exactly as typed: no trimming, no normalisation, no truncation, any Unicode', () => {
  const text = '  начало\r\n\tтаб   неразрывный​нулевой ширины\n\n\nКонец é (комбинируемый акцент) 😀 “кавычки” ½  ';
  const c = content({ form: { ...defaultDraftForm(), sourceText: text, mode: 'rewrite', goal: text, methods: text } });
  const { p, store } = hydrated();
  p.save(c);
  const loaded = loadDraft(store!);
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  assert.equal(loaded.draft.form.sourceText, text); assert.equal(loaded.draft.form.goal, text); assert.equal(loaded.draft.form.methods, text);
  const long = 'я'.repeat(20_000);
  const big = content({ form: { ...defaultDraftForm(), sourceText: long } });
  const q = hydrated(); q.p.save(big);
  assert.equal((loadDraft(q.store!) as { draft: { form: { sourceText: string } } }).draft.form.sourceText.length, 20_000);
});

test('11. clearing removes this draft only: the bibliography, the other tools and the quarantine slot are untouched', () => {
  const data = new Map<string, string>([['plasmatech.techdoc.document.v1', 'TECHDOC'], ['other', 'x']]);
  const store: DraftStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const refStore = createInMemoryStoreForTests();
  const ref = { ...createReference('book'), title: 'Моя ссылка', authors: ['Иванов И.И.'] };
  assert.equal(saveReferences([ref], refStore), true);
  const p = createDraftPersistence(store, FIXED); p.hydrate();
  p.save(generated());
  assert.notEqual(data.get(DRAFT_STORAGE_KEY), undefined);
  assert.deepEqual(p.clear(), { ok: true });
  assert.equal(data.get(DRAFT_STORAGE_KEY), undefined);
  assert.equal(data.get('plasmatech.techdoc.document.v1'), 'TECHDOC'); assert.equal(data.get('other'), 'x');
  assert.deepEqual(loadReferences(refStore), [ref]);
  assert.equal(loadDraft(store).status, 'empty');
  // after clearing, the empty form is "unchanged"; a new edit saves again
  assert.deepEqual(p.save(defaultDraftContent()), { ok: false, reason: 'unchanged' });
  assert.equal(p.save(typed()).ok, true);
  // the component asks for a confirmation before clearing and never touches the reference store
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.match(component, /window\.confirm\(/);
  assert.ok(component.indexOf('window.confirm(') < component.indexOf('persistence.current.clear()'));
});

test('12. an outdated generation answer is ignored: after clearing, or after a newer request', () => {
  const guard = createGenerationGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);                                                       // a newer request replaced it
  assert.equal(guard.isCurrent(second), true);
  guard.invalidate();                                                                                // the draft was cleared while the request was on its way
  assert.equal(guard.isCurrent(second), false);
  const third = guard.begin();
  assert.equal(guard.isCurrent(third), true);
  assert.equal(guard.isCurrent(0), false);
  // the component applies an answer only if its token is still current
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.equal((component.match(/isCurrent\(token\)/g) ?? []).length, 2);
  assert.match(component, /generationGuard\.current\.invalidate\(\)/);
});

test('13. the unchanged draft is not rewritten; every real change is; the storage keeps only the latest', () => {
  let writes = 0;
  const data = new Map<string, string>();
  const store: DraftStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { writes += 1; data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const p = createDraftPersistence(store, FIXED); p.hydrate();
  p.save(typed()); p.save(typed()); p.save(typed());
  assert.equal(writes, 1);
  p.save({ ...typed(), exportFormat: 'pdf' });
  assert.equal(writes, 2);
  p.save({ ...typed(), exportFormat: 'pdf', citationStyle: 'ieee' });
  assert.equal(writes, 3);
  assert.equal(stored(store).citationStyle, 'ieee');
  assert.deepEqual([...data.keys()], [DRAFT_STORAGE_KEY]);
});

test('14. the interface says where the draft lives and does not promise encryption or a backup', () => {
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.match(component, /только в этом браузере/);
  assert.match(component, /не отправляется/);
  assert.match(component, /не шифруется и не копируется в резерв/);
  assert.match(component, /Очистить черновик/);
  assert.ok(!/зашифрован(?!о)|резервн(?!о)/.test(component.replace(/не шифруется и не копируется в резерв/, '')));
  assert.ok(!/\bfetch\([^)]*draft/i.test(component));                                               // the draft is never sent anywhere
  const store = readFileSync(join(__dirname, '../src/services/workspace/scientific-writer-draft-store.ts'), 'utf8');
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon/.test(store));
});


// ---------- audit corrections F1-F4 and the lifecycle ----------

const resultOf = (text: string) => ({ ...generated().result!, generatedText: text });
const viewOf = (c: DraftContent): GenerationView => ({ scaffold: c.scaffold, evidencePreview: c.evidencePreview, result: c.result, generatedFrom: c.generatedFrom });
const asContent = (base: DraftContent, v: GenerationView): DraftContent => ({ ...base, ...v });

test('F1. an earlier successful result survives a failed or invalid new generation; only a newer success replaces it, together with its structure and snapshot', () => {
  const first = generated();
  const v0 = viewOf(first);
  const newScaffold = [{ heading: 'Новая структура', text: 'x', usedFields: [] }];
  const failure = { kind: 'failure' as const, scaffold: newScaffold, evidencePreview: first.evidencePreview, snapshot: '{"new":1}' };
  assert.deepEqual(applyGenerationOutcome(v0, failure), v0);                                    // API error: nothing changes
  assert.equal(applyGenerationOutcome(v0, failure), v0);
  assert.deepEqual(applyGenerationOutcome(v0, { kind: 'invalid_input' }), v0);                  // validation error: nothing changes
  const second = applyGenerationOutcome(v0, { kind: 'success', result: resultOf('НОВЫЙ'), scaffold: newScaffold, evidencePreview: first.evidencePreview, snapshot: '{"new":1}' });
  assert.equal(second.result?.generatedText, 'НОВЫЙ');
  assert.deepEqual(second.scaffold, newScaffold);
  assert.equal(second.generatedFrom, '{"new":1}');                                              // result, structure and snapshot are replaced together
  // success -> error -> success keeps the right pairing at every step
  const afterError = applyGenerationOutcome(second, { ...failure, snapshot: '{"third":1}' });
  assert.equal(afterError.result?.generatedText, 'НОВЫЙ'); assert.equal(afterError.generatedFrom, '{"new":1}');   // the old result is never attributed to the new request
  assert.equal(applyGenerationOutcome(afterError, { kind: 'success', result: resultOf('ТРЕТИЙ'), scaffold: null, evidencePreview: null, snapshot: '{"third":1}' }).generatedFrom, '{"third":1}');
  // with NO result yet a failure shows the honest local structure of the new input
  const empty: GenerationView = { scaffold: null, evidencePreview: null, result: null, generatedFrom: null };
  assert.deepEqual(applyGenerationOutcome(empty, failure), { result: null, scaffold: newScaffold, evidencePreview: first.evidencePreview, generatedFrom: '{"new":1}' });
  assert.deepEqual(applyGenerationOutcome(empty, { kind: 'invalid_input' }), empty);
  // the view was not mutated
  assert.equal(v0.result?.generatedText, first.result!.generatedText);
});

test('F1. success -> failed regeneration -> restore: the saved draft still holds the earlier result with the form it was made for', () => {
  const store = createInMemoryDraftStore();
  const { p } = hydrated(store);
  const first = generated();
  p.save(first);
  const edited = { ...first, form: { ...first.form, results: 'правка перед повторной генерацией' } };
  const after = asContent(edited, applyGenerationOutcome(viewOf(edited), { kind: 'failure', scaffold: [], evidencePreview: null, snapshot: JSON.stringify(edited.form) }));
  assert.equal(p.save(after).ok, true);
  const loaded = loadDraft(store);
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  assert.equal(loaded.draft.result?.generatedText, first.result!.generatedText);               // the earlier AI result was not lost
  assert.equal(loaded.draft.generatedFrom, first.generatedFrom);                               // still tied to the form it was generated for
  assert.equal(isResultStale(loaded.draft.generatedFrom, loaded.draft.form), true);           // and shown as outdated for the edited form
});

test('F1. clearing while an answer is pending: the late answer is ignored and the deleted draft does not come back', () => {
  const store = createInMemoryDraftStore();
  const persistence = createDraftPersistence(store, FIXED); persistence.hydrate();
  const guard = createGenerationGuard();
  persistence.save(generated());
  const token = guard.begin();                                // a request is on its way
  guard.invalidate();                                         // the user clears the draft (confirmed)
  assert.deepEqual(persistence.clear(), { ok: true });
  assert.equal(guard.isCurrent(token), false);                // the answer arrives: it is not applied, so nothing is saved
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), null);
  // an old answer cannot overwrite the result of a newer request either
  const older = guard.begin(); const newer = guard.begin();
  assert.equal(guard.isCurrent(older), false); assert.equal(guard.isCurrent(newer), true);
});

test('F2. a full storage still lets the saved draft be restored; the refused write is reported separately and nothing is deleted', () => {
  const data = new Map<string, string>();
  const store: DraftStore = { getItem: k => data.get(k) ?? null, setItem: () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }, removeItem: k => { data.delete(k); } };
  const seeded = createInMemoryDraftStore(); hydrated(seeded).p.save(generated());
  data.set(DRAFT_STORAGE_KEY, seeded.getItem(DRAFT_STORAGE_KEY)!);
  const p = createDraftPersistence(store, FIXED);
  const loaded = p.hydrate();
  assert.equal(loaded.status, 'restored');                                                 // reading works although writing is refused
  assert.deepEqual(p.save({ ...generated(), exportFormat: 'docx' }), { ok: false, reason: 'quota' });   // reported on its own
  assert.equal(data.get(DRAFT_STORAGE_KEY), seeded.getItem(DRAFT_STORAGE_KEY));            // the saved draft is intact
  assert.equal(p.isHydrated(), true);
  // detection does not write: a global localStorage whose setItem always fails is still a readable storage
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = { getItem: (k: string) => data.get(k) ?? null, setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); }, removeItem: () => undefined };
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake });
    const detected = detectDraftStore();
    assert.notEqual(detected, null);
    assert.equal(loadDraft(detected).status, 'restored');
  } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
});

test('F3. an existing different backup is never overwritten: the destructive write is blocked and both documents survive', () => {
  const store = createInMemoryDraftStore();
  store.setItem(UNREADABLE_DRAFT_KEY, 'DOCUMENT-A');                                       // an earlier unreadable document, put aside
  store.setItem(DRAFT_STORAGE_KEY, '{broken B');                                          // the main key now holds another unreadable document
  const p = createDraftPersistence(store, FIXED);
  assert.equal(p.hydrate().status, 'corrupted');
  assert.deepEqual(p.save(typed()), { ok: false, reason: 'quarantine_occupied' });         // the user enters document C: the save is refused
  assert.equal(store.getItem(UNREADABLE_DRAFT_KEY), 'DOCUMENT-A');
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), '{broken B');
  assert.deepEqual(p.save({ ...typed(), exportFormat: 'pdf' }), { ok: false, reason: 'quarantine_occupied' });   // and again: still nothing lost, nothing cleared automatically
  assert.equal(store.getItem(UNREADABLE_DRAFT_KEY), 'DOCUMENT-A'); assert.equal(store.getItem(DRAFT_STORAGE_KEY), '{broken B');
  // clearing is refused for the same reason: the unreadable document would be destroyed
  assert.deepEqual(p.clear(), { ok: false, reason: 'quarantine_occupied' });
  assert.equal(store.getItem(DRAFT_STORAGE_KEY), '{broken B');
  // the same document already in the backup is fine (idempotent), and a free slot is used
  const same = createInMemoryDraftStore(); same.setItem(UNREADABLE_DRAFT_KEY, '{broken B'); same.setItem(DRAFT_STORAGE_KEY, '{broken B');
  const q = createDraftPersistence(same, FIXED); q.hydrate();
  assert.equal(q.save(typed()).ok, true);
  assert.equal(same.getItem(UNREADABLE_DRAFT_KEY), '{broken B');
});

test('F4. after a failed read nothing is written until a read succeeds; the stored document is never touched', () => {
  const data = new Map<string, string>();
  const seeded = createInMemoryDraftStore(); hydrated(seeded).p.save(generated());
  data.set(DRAFT_STORAGE_KEY, seeded.getItem(DRAFT_STORAGE_KEY)!);
  let failReads = true; let writes = 0;
  const store: DraftStore = {
    getItem: k => { if (failReads) throw new Error('temporarily unavailable'); return data.get(k) ?? null; },
    setItem: (k, v) => { writes += 1; data.set(k, v); }, removeItem: k => { data.delete(k); },
  };
  const original = data.get(DRAFT_STORAGE_KEY);
  const p = createDraftPersistence(store, FIXED);
  assert.deepEqual(p.hydrate(), { status: 'read_failed' });
  assert.equal(p.isHydrated(), false);
  assert.deepEqual(p.save(typed()), { ok: false, reason: 'not_hydrated' });                // the screen's first-render values cannot overwrite an unknown stored document
  assert.deepEqual(p.save(defaultDraftContent()), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(p.clear(), { ok: false, reason: 'not_hydrated' });
  assert.equal(writes, 0); assert.equal(data.get(DRAFT_STORAGE_KEY), original);
  assert.deepEqual(p.hydrate(), { status: 'read_failed' });                                // a retry while reading still fails
  failReads = false;
  const again = p.hydrate();                                                                 // the retry succeeds
  assert.equal(again.status, 'restored');
  assert.equal(p.isHydrated(), true);
  assert.deepEqual(p.save(generated()), { ok: false, reason: 'unchanged' });
  assert.equal(p.save({ ...generated(), exportFormat: 'docx' }).ok, true);                // normal saving after a successful read
  // the user already typed during the outage: the stored draft is not adopted, it is put aside first
  const store2 = createInMemoryDraftStore(); store2.setItem(DRAFT_STORAGE_KEY, seeded.getItem(DRAFT_STORAGE_KEY)!);
  const p2 = createDraftPersistence(store2, FIXED);
  assert.equal(p2.hydrate({ keepExisting: true }).status, 'restored');
  assert.equal(p2.save(typed()).ok, true);
  assert.equal(store2.getItem(UNREADABLE_DRAFT_KEY), seeded.getItem(DRAFT_STORAGE_KEY));   // the earlier draft is kept in the backup slot
  assert.equal(stored(store2).form.title, 'СИНТЕТИЧЕСКАЯ тема');
  // no storage at all is not "hydrated" either
  const none = createDraftPersistence(null, FIXED);
  assert.deepEqual(none.hydrate(), { status: 'unavailable' }); assert.equal(none.isHydrated(), false);
});

// ---- lifecycle of the automatic saving, without a DOM: fake timers ----

function fakeTimers() {
  let now = 0; let id = 0; const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = { set: (fn, ms) => { id += 1; pending.set(id, { at: now + ms, fn }); return id; }, clear: handle => { pending.delete(handle as number); } };
  return { timers, pendingCount: () => pending.size, advance(ms: number) { now += ms; for (const [key, t] of [...pending]) if (t.at <= now) { pending.delete(key); t.fn(); } } };
}
const editor = (store: DraftStore = createInMemoryDraftStore(), ft = fakeTimers()) => {
  const persistence = createDraftPersistence(store, FIXED);
  const outcomes: SaveOutcome[] = [];
  persistence.hydrate();
  const autosave = createAutosave(persistence, o => outcomes.push(o), 600, ft.timers);
  return { store, ft, persistence, autosave, outcomes };
};

test('L1. typing then leaving at once (unmount or pagehide) saves what was typed, without waiting for the delay', () => {
  const a = editor();
  a.autosave.update(typed());
  assert.equal(a.store.getItem(DRAFT_STORAGE_KEY), null);                                  // still waiting
  assert.equal(a.ft.pendingCount(), 1);
  a.autosave.flush();                                                                      // unmount / pagehide
  assert.equal(stored(a.store).form.title, 'СИНТЕТИЧЕСКАЯ тема');
  assert.equal(a.ft.pendingCount(), 0);                                                    // the waiting timer is gone
  assert.equal(a.outcomes.length, 0);                                                      // leaving does not report (no state update after unmount)
  a.ft.advance(10_000);
  assert.equal(a.outcomes.length, 0);
  // the same through the real browser event path: two flushes (pagehide then unmount) write once
  let writes = 0;
  const counting: DraftStore = { ...createInMemoryDraftStore(), setItem: () => { writes += 1; } };
  const b = editor(counting);
  b.autosave.update(typed()); b.autosave.flush(); b.autosave.flush();
  assert.equal(writes, 1);
});

test('L2. the delay: several quick edits give one save of the last content; the report arrives after it', () => {
  const a = editor();
  a.autosave.update(typed());
  a.ft.advance(300);
  a.autosave.update({ ...typed(), exportFormat: 'pdf' });                                   // a newer edit restarts the delay
  a.ft.advance(300);
  assert.equal(a.store.getItem(DRAFT_STORAGE_KEY), null);
  a.ft.advance(300);
  assert.equal(stored(a.store).exportFormat, 'pdf');
  assert.equal(a.outcomes.length, 1); assert.equal(a.outcomes[0].ok, true);
  a.ft.advance(5_000);
  assert.equal(a.outcomes.length, 1);                                                      // nothing more is written
});

test('L3. remounting restores what was saved; a Strict Mode double mount neither loses nor duplicates it', () => {
  const store = createInMemoryDraftStore();
  const first = editor(store);
  first.autosave.update(generated()); first.autosave.flush();
  // Strict Mode: mount, cleanup, mount again over the same storage
  const ft = fakeTimers();
  const mountA = editor(store, ft); mountA.autosave.flush();                                // cleanup of the simulated first mount: nothing pending, nothing written
  const mountB = editor(store, ft);
  assert.deepEqual(json(loadDraft(store).status === 'restored' ? (loadDraft(store) as { draft: { form: unknown } }).draft.form : null), json(generated().form));
  mountB.autosave.update(generated());                                                      // the restored content is "updated" once more by the effect
  mountB.ft.advance(1_000);
  assert.equal(mountB.outcomes.length, 0);                                                  // unchanged: no rewrite, no report
  assert.deepEqual(json(stored(store).result), json(generated().result));
});

test('L4. clearing with a waiting timer: the timer is cancelled and the deleted draft is never written back', () => {
  const a = editor();
  a.autosave.update(generated()); a.ft.advance(1_000);
  assert.notEqual(a.store.getItem(DRAFT_STORAGE_KEY), null);
  a.autosave.update({ ...generated(), exportFormat: 'docx', form: { ...generated().form, title: 'правка перед очисткой' } });   // a save is waiting
  assert.equal(a.ft.pendingCount(), 1);
  a.autosave.cancel();                                                                       // the user confirmed clearing
  assert.equal(a.ft.pendingCount(), 0);
  assert.deepEqual(a.persistence.clear(), { ok: true });
  a.ft.advance(10_000); a.autosave.flush();                                                  // neither the timer nor an unmount flush brings it back
  assert.equal(a.store.getItem(DRAFT_STORAGE_KEY), null);
  a.autosave.update(defaultDraftContent());                                                  // the reset form: the effect after clearing
  a.ft.advance(1_000); a.autosave.flush();
  assert.equal(a.store.getItem(DRAFT_STORAGE_KEY), null);                                    // an empty form creates no draft
  a.autosave.update(typed()); a.ft.advance(1_000);                                           // new work after clearing is saved normally
  assert.equal(stored(a.store).form.title, 'СИНТЕТИЧЕСКАЯ тема');
});

test('L5. a failed save keeps the content for the next attempt; a read that has not succeeded writes nothing even on leaving', () => {
  const data = new Map<string, string>(); let failing = true;
  const store: DraftStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { if (failing) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const a = editor(store);
  a.autosave.update(typed()); a.ft.advance(1_000);
  assert.deepEqual(a.outcomes.map(o => o.ok === false ? o.reason : 'ok'), ['quota']);
  failing = false;
  a.autosave.flush();                                                                        // leaving: the content that could not be saved is tried again
  assert.equal(stored(store).form.title, 'СИНТЕТИЧЕСКАЯ тема');
  // a persistence whose read failed: updates and flushes write nothing
  const broken: DraftStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('must not write'); }, removeItem: () => { throw new Error('must not remove'); } };
  const persistence = createDraftPersistence(broken, FIXED); persistence.hydrate();
  const ft = fakeTimers(); const autosave = createAutosave(persistence, () => undefined, 600, ft.timers);
  autosave.update(typed()); ft.advance(1_000); autosave.flush();
  assert.equal(persistence.isHydrated(), false);
});

// ---------- final F4: the storage is found again after a temporary failure of the first access ----------

/** A global `localStorage` whose reads can be made to fail temporarily; `detectDraftStore()` really goes through it. */
function withFlakyStorage<T>(seed: Record<string, string>, body: (control: { fail: boolean; data: Map<string, string>; reads: number }) => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const control = { fail: false, data: new Map(Object.entries(seed)), reads: 0 };
  const fake = {
    getItem: (k: string) => { control.reads += 1; if (control.fail) throw new Error('SecurityError: temporarily unavailable'); return control.data.get(k) ?? null; },
    setItem: (k: string, v: string) => { control.data.set(k, v); }, removeItem: (k: string) => { control.data.delete(k); },
  };
  try { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake }); return body(control); }
  finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
}
const savedA = (): string => { const s = createInMemoryDraftStore(); hydrated(s).p.save(generated()); return s.getItem(DRAFT_STORAGE_KEY)!; };

test('F4-final. the first detection fails, the storage comes back: it is found again and the saved draft A is restored when there is no new input', () => {
  const A = savedA();
  withFlakyStorage({ [DRAFT_STORAGE_KEY]: A }, control => {
    control.fail = true;
    assert.equal(detectDraftStore(), null);                                                // the first detection: unavailable
    const p = createDraftPersistence(detectDraftStore, FIXED);                             // the DETECTION is what is handed over, not a ready storage
    assert.deepEqual(p.hydrate(), { status: 'unavailable' });
    assert.equal(p.isHydrated(), false);
    assert.deepEqual(p.save(typed()), { ok: false, reason: 'not_hydrated' });
    assert.deepEqual(p.clear(), { ok: false, reason: 'unavailable' });
    assert.deepEqual(p.hydrate(), { status: 'unavailable' });                              // still failing: the same answer, nothing written
    control.fail = false;                                                                  // the storage is available again
    const again = p.hydrate();                                                             // the explicit retry
    assert.equal(again.status, 'restored');
    assert.equal(p.isHydrated(), true);
    assert.deepEqual(p.save(generated()), { ok: false, reason: 'unchanged' });             // A is shown and not rewritten
    assert.equal(control.data.get(DRAFT_STORAGE_KEY), A);
    assert.equal(p.save({ ...generated(), exportFormat: 'docx' }).ok, true);               // and autosave works after the recovery
    assert.equal(JSON.parse(control.data.get(DRAFT_STORAGE_KEY)!).exportFormat, 'docx');
  });
});

test('F4-final. the user already typed C: A is NOT put on the screen; it is put aside before C is written', () => {
  const A = savedA();
  withFlakyStorage({ [DRAFT_STORAGE_KEY]: A }, control => {
    control.fail = true;
    const p = createDraftPersistence(detectDraftStore, FIXED);
    assert.equal(p.hydrate().status, 'unavailable');
    const ft = fakeTimers(); const outcomes: SaveOutcome[] = [];
    const autosave = createAutosave(p, o => outcomes.push(o), 600, ft.timers);
    autosave.update(typed()); ft.advance(1_000); autosave.flush();                         // C is typed while the storage is unavailable: it only lives in memory
    assert.equal(control.data.get(DRAFT_STORAGE_KEY), A);                                  // nothing was written, A is untouched
    control.fail = false;
    const loaded = p.hydrate({ keepExisting: true });                                     // the retry knows that there is new input
    assert.equal(loaded.status, 'restored');                                              // ...but A is reported, and the caller does not apply it over C
    autosave.update(typed());                                                              // the component hands C over again
    ft.advance(1_000);
    assert.equal(control.data.get(UNREADABLE_DRAFT_KEY), A);                               // A was put aside BEFORE
    assert.equal(JSON.parse(control.data.get(DRAFT_STORAGE_KEY)!).form.title, 'СИНТЕТИЧЕСКАЯ тема');   // C was written
    assert.ok(outcomes.some(o => o.ok));
  });
});

test('F4-final. a busy backup slot blocks the destructive write: A, the earlier backup and the in-memory C all survive', () => {
  const A = savedA();
  withFlakyStorage({ [DRAFT_STORAGE_KEY]: A, [UNREADABLE_DRAFT_KEY]: 'EARLIER BACKUP' }, control => {
    control.fail = true;
    const p = createDraftPersistence(detectDraftStore, FIXED);
    p.hydrate();
    control.fail = false;
    assert.equal(p.hydrate({ keepExisting: true }).status, 'restored');
    const ft = fakeTimers(); const outcomes: SaveOutcome[] = [];
    const autosave = createAutosave(p, o => outcomes.push(o), 600, ft.timers);
    autosave.update(typed()); ft.advance(1_000);
    assert.deepEqual(outcomes.map(o => (o.ok ? 'ok' : o.reason)), ['quarantine_occupied']);
    assert.equal(control.data.get(DRAFT_STORAGE_KEY), A);                                  // A intact
    assert.equal(control.data.get(UNREADABLE_DRAFT_KEY), 'EARLIER BACKUP');                // the earlier backup intact, not cleared automatically
    autosave.flush();                                                                      // leaving the page: still nothing destroyed, C is still held for another attempt
    assert.equal(control.data.get(DRAFT_STORAGE_KEY), A);
    control.data.delete(UNREADABLE_DRAFT_KEY);                                             // the user frees the slot by hand
    autosave.flush();
    assert.equal(control.data.get(UNREADABLE_DRAFT_KEY), A);                               // now A is put aside...
    assert.equal(JSON.parse(control.data.get(DRAFT_STORAGE_KEY)!).form.title, 'СИНТЕТИЧЕСКАЯ тема');   // ...and C saved
  });
});

test('F4-final. a retry that fails again keeps the typed input in memory and writes nothing; there is no automatic retry loop', () => {
  const A = savedA();
  withFlakyStorage({ [DRAFT_STORAGE_KEY]: A }, control => {
    control.fail = true;
    const p = createDraftPersistence(detectDraftStore, FIXED);
    p.hydrate();
    const readsAfterMount = control.reads;
    const ft = fakeTimers();
    const autosave = createAutosave(p, () => undefined, 600, ft.timers);
    autosave.update(typed()); ft.advance(60_000); autosave.flush();
    assert.equal(control.reads, readsAfterMount);                                          // typing and waiting never re-read: a retry is an explicit action only
    assert.deepEqual(p.hydrate({ keepExisting: true }), { status: 'unavailable' });        // the explicit retry fails again
    assert.equal(p.isHydrated(), false);
    autosave.flush();
    assert.equal(control.data.get(DRAFT_STORAGE_KEY), A);                                  // still nothing written
    control.fail = false;
    assert.equal(p.hydrate({ keepExisting: true }).status, 'restored');
    autosave.flush();                                                                      // C was held in memory the whole time and is saved after the recovery
    assert.equal(JSON.parse(control.data.get(DRAFT_STORAGE_KEY)!).form.title, 'СИНТЕТИЧЕСКАЯ тема');
    assert.equal(control.data.get(UNREADABLE_DRAFT_KEY), A);
  });
});

test('F4-final. the ordinary restore without any error works as before, through the detection path', () => {
  const A = savedA();
  withFlakyStorage({ [DRAFT_STORAGE_KEY]: A }, control => {
    const p = createDraftPersistence(detectDraftStore, FIXED);
    const loaded = p.hydrate();
    assert.equal(loaded.status, 'restored');
    if (loaded.status === 'restored') assert.deepEqual(json(loaded.draft.form), json(generated().form));
    assert.deepEqual(p.save(generated()), { ok: false, reason: 'unchanged' });
    assert.equal(control.data.get(UNREADABLE_DRAFT_KEY), undefined);                       // nothing is put aside when nothing is in the way
  });
  withFlakyStorage({}, () => {
    const p = createDraftPersistence(detectDraftStore, FIXED);
    assert.equal(p.hydrate().status, 'empty');
    assert.equal(p.save(typed()).ok, true);
  });
  assert.deepEqual(createDraftPersistence(() => { throw new Error('detection itself fails'); }, FIXED).hydrate(), { status: 'unavailable' });   // a failing detection is a controlled state
});

test('F4-final. the retry button exists for both failed states; a retry never starts a generation, never sends the draft and never resets the form', () => {
  const component = readFileSync(join(__dirname, '../src/components/scientific-writer.tsx'), 'utf8');
  assert.match(component, /draftStatus\.kind === 'read_failed' \|\| draftStatus\.kind === 'unavailable'\) && <button[^>]*onClick=\{retryRead\}/);
  assert.match(component, /createDraftPersistence\(detectDraftStore\)/);                  // the detection function itself, so a retry looks for the storage again
  const start = component.indexOf('function retryRead()');
  const body = component.slice(start, component.indexOf('\n  }\n', start));
  assert.ok(body.length > 100);
  assert.ok(!/fetch\(|generate\(|start\(|submit\(|setForm\(|setResult\(|applyRestored\(/.test(body), 'a retry does not call the AI, the server or reset the form');
  assert.match(body, /keepExisting: !pristine/);                                          // a stored draft is never applied over the user's input
  assert.ok(!/setInterval|setTimeout\(\s*retryRead/.test(component));                     // no automatic repeat
});
