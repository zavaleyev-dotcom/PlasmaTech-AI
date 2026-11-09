import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEA_PROJECT_CONFIG, TEA_PROJECT_KEY, applyHandoffToProject, confirmHandoffDelivery, defaultTeaForm, defaultTeaProject, explainTeaProject, isCalculationStale, parseTeaProject,
  planHandoffDelivery, calculationRequestFrom, describeCalculationMismatch, recomputeResults, shownResultContext, teaFormToInput, type CalculatedFrom, type TeaFormState, type TeaProjectContent,
} from '../src/services/workspace/tea-project-store';
import {
  backupKey, createAutosave, createInMemoryProjectStore, createProjectPersistence, detectProjectStore, loadProject, type ProjectStore, type SaveOutcome, type Timers,
} from '../src/services/workspace/local-project-persistence';
import { runAssessment, type AssessmentInput } from '../src/services/workspace/techno-economic-assessment';
import { buildTeaReport, reportRequestBody, type TeaReportRequest } from '../src/services/workspace/techno-economic-report';
import { parseTeaReportRequest } from '../src/services/workspace/techno-economic-report-parse';
import { EQUIPMENT_CONFIGURATIONS, buildTechnoEconomicHandoff } from '../src/services/workspace/equipment-selector';
import {
  queueEquipmentHandoff, consumePendingEquipmentHandoff, peekPendingEquipmentHandoff, acknowledgeEquipmentHandoff, createInMemoryStoreForTests, type EquipmentTeaHandoffRecord, type KeyValueStore,
} from '../src/services/workspace/equipment-tea-handoff';

const FIXED = () => new Date('2030-01-02T03:04:05.000Z');
const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const persistence = (store: ProjectStore | null | (() => ProjectStore | null) = createInMemoryProjectStore()) => createProjectPersistence(TEA_PROJECT_CONFIG, store, FIXED);
const hydrated = (store: ProjectStore = createInMemoryProjectStore()) => { const p = persistence(store); p.hydrate(); return { p, store }; };
const stored = (store: ProjectStore) => JSON.parse(store.getItem(TEA_PROJECT_KEY) ?? 'null');

// A SYNTHETIC project: the numbers are placeholders, not data about any real equipment, price or process.
const input = (equipment: number, saving = [1_000_000, 700_000]): AssessmentInput => ({
  capex: { equipment, delivery: equipment / 10, installation: equipment / 20 },
  opex: { period: 'year', electricity: 100_000, maintenance: 50_000, labor: 300_000 },
  capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 1 },
  depreciationYears: 10,
  economicEffect: { mode: 'total_external_cost', currentAnnualCost: saving[0], newAnnualCost: saving[1] },
});
const handoff = () => buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[0]);
const calculation = (): TeaReportRequest => ({ currency: 'USD', variantA: { title: 'СИНТЕТИЧЕСКИЙ вариант A', input: input(5_000_000) }, variantB: { input: input(3_000_000) }, handoff: handoff() });
const project = (over: Partial<TeaProjectContent> = {}): TeaProjectContent => {
  const base = defaultTeaProject();
  base.formA = { ...defaultTeaForm(), title: 'СИНТЕТИЧЕСКИЙ вариант A', capex: { ...defaultTeaForm().capex, equipment: '5000000', delivery: '500000' }, depreciationYears: '10', currentAnnualCost: '1000000', newAnnualCost: '700000' };
  base.compareB = true;
  base.currency = 'USD';
  base.formB = { ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment: '3000000' }, currentAnnualCost: '1000000', newAnnualCost: '800000' };
  return { ...base, ...over };
};
const scenarioOf = (p: TeaProjectContent): CalculatedFrom => ({ formA: p.formA, formB: p.formB, compareB: p.compareB, currency: p.currency, scenariosEnabled: p.scenariosEnabled, scenarioForms: p.scenarioForms, handoff: p.handoff });
/** A project whose stored calculation really is the calculation of its stored form (what the component produces). */
const consistent = (p: TeaProjectContent): TeaProjectContent => ({ ...p, calculation: calculationRequestFrom(scenarioOf(p)), calculatedFrom: scenarioOf(p) });
const full = (): TeaProjectContent => consistent(project({ handoff: { handoff: handoff(), importedAt: '2030-01-01T00:00:00.000Z' } }));

test('1. a new project is saved under TEA\'s own versioned key, with the time of saving', () => {
  const { p, store } = hydrated();
  assert.equal(store.getItem(TEA_PROJECT_KEY), null);
  assert.deepEqual(p.save(project()), { ok: true, savedAt: '2030-01-02T03:04:05.000Z' });
  const raw = stored(store);
  assert.equal(raw.version, 1); assert.equal(raw.savedAt, '2030-01-02T03:04:05.000Z');
  assert.equal(raw.content.formA.capex.equipment, '5000000');
  assert.equal(TEA_PROJECT_KEY, 'plasmatech.tea.project.v1');
  assert.ok(!TEA_PROJECT_KEY.includes('scientific-writer'));                                    // not mixed with Scientific Writer
  assert.notEqual(TEA_PROJECT_KEY, 'plasmatech.equipment-tea-handoff.v1');                      // nor with the Equipment Selector hand-over
});

test('2. the saved project is restored exactly (navigating away, a refresh and reopening the site = a new controller over the same storage)', () => {
  const store = createInMemoryProjectStore();
  hydrated(store).p.save(full());
  const second = persistence(store);
  const loaded = second.hydrate();
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  assert.deepEqual(loaded.project.content, parseTeaProject(json(full())));                      // whole, canonical
  assert.deepEqual(json(loaded.project.content), json(full()));
  assert.equal(loaded.project.content.formA.capex.equipment, '5000000');
  assert.equal(loaded.project.content.currency, 'USD'); assert.equal(loaded.project.content.compareB, true);
  assert.deepEqual(second.save(loaded.project.content), { ok: false, reason: 'unchanged' });    // the restored project, as the screen holds it, is not rewritten
  assert.equal(second.save(project()).ok, true);
});

test('3. updating single inputs: each change is saved, everything else stays', () => {
  const { p, store } = hydrated();
  p.save(project());
  const edited = project({ formA: { ...project().formA, capex: { ...project().formA.capex, installation: '250000' } } });
  assert.equal(p.save(edited).ok, true);
  assert.equal(stored(store).content.formA.capex.installation, '250000');
  assert.equal(stored(store).content.formA.capex.equipment, '5000000');
  const scen = project(); scen.scenariosEnabled = true; scen.scenarioForms.optimistic.opex.labor = '123';
  assert.equal(p.save(scen).ok, true);
  const loaded = persistence(store).hydrate();
  assert.equal(loaded.status === 'restored' && loaded.project.content.scenarioForms.optimistic.opex.labor, '123');
  assert.equal(loaded.status === 'restored' && loaded.project.content.scenarioForms.base.opex.labor, '');
  // the same content again is not rewritten
  let writes = 0;
  const counting: ProjectStore = { ...createInMemoryProjectStore(), setItem: () => { writes += 1; } };
  const q = hydrated(counting).p;
  q.save(project()); q.save(project()); q.save(project());
  assert.equal(writes, 1);
});

// ---- fake timers for the lifecycle ----
function fakeTimers() {
  let now = 0; let id = 0; const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = { set: (fn, ms) => { id += 1; pending.set(id, { at: now + ms, fn }); return id; }, clear: handle => { pending.delete(handle as number); } };
  return { timers, pendingCount: () => pending.size, advance(ms: number) { now += ms; for (const [key, t] of [...pending]) if (t.at <= now) { pending.delete(key); t.fn(); } } };
}
const editor = (store: ProjectStore = createInMemoryProjectStore(), ft = fakeTimers()) => {
  const p = persistence(store); p.hydrate();
  const outcomes: SaveOutcome[] = [];
  return { store, ft, p, autosave: createAutosave(p, o => outcomes.push(o), 600, ft.timers), outcomes };
};

test('4. leaving at once: the last input is saved by the flush, without waiting for the delay; clearing cancels a waiting save', () => {
  const a = editor();
  a.autosave.update(project());
  assert.equal(a.store.getItem(TEA_PROJECT_KEY), null);                                         // still waiting
  a.autosave.flush();                                                                           // unmount / pagehide
  assert.equal(stored(a.store).content.formA.capex.equipment, '5000000');
  assert.equal(a.ft.pendingCount(), 0); assert.equal(a.outcomes.length, 0);
  // a newer edit restarts the delay; one save of the last content
  const b = editor();
  b.autosave.update(project()); b.ft.advance(300);
  b.autosave.update(project({ currency: 'EUR' })); b.ft.advance(300);
  assert.equal(b.store.getItem(TEA_PROJECT_KEY), null);
  b.ft.advance(300);
  assert.equal(stored(b.store).content.currency, 'EUR'); assert.equal(b.outcomes.length, 1);
  // clearing with a waiting timer: the deleted project is never written back
  const c = editor();
  c.autosave.update(project()); c.ft.advance(1_000);
  c.autosave.update(project({ currency: 'RUB' }));
  c.autosave.cancel();
  assert.deepEqual(c.p.clear(), { ok: true });
  c.ft.advance(10_000); c.autosave.flush();
  assert.equal(c.store.getItem(TEA_PROJECT_KEY), null);
  c.autosave.update(defaultTeaProject()); c.ft.advance(1_000);                                   // the reset form: nothing to write
  assert.equal(c.store.getItem(TEA_PROJECT_KEY), null);
});

test('5. damaged data: no project, nothing thrown, the damaged value is put aside before anything overwrites it', () => {
  for (const raw of ['{not json', '[]', 'null', '42', '"text"', '{"version":1}', '{"version":1,"savedAt":"x","content":{}}', '{"version":1,"savedAt":"2030-01-02T03:04:05.000Z","content":null}']) {
    const store = createInMemoryProjectStore(); store.setItem(TEA_PROJECT_KEY, raw);
    assert.equal(loadProject(TEA_PROJECT_CONFIG, store).status, 'corrupted', raw);
  }
  const store = createInMemoryProjectStore(); store.setItem(TEA_PROJECT_KEY, '{broken');
  const p = persistence(store);
  assert.equal(p.hydrate().status, 'corrupted');
  assert.equal(store.getItem(TEA_PROJECT_KEY), '{broken');
  assert.equal(p.save(defaultTeaProject()).ok, false);                                          // the untouched empty project is not written over it
  assert.equal(store.getItem(TEA_PROJECT_KEY), '{broken');
  assert.equal(p.save(project()).ok, true);
  assert.equal(store.getItem(backupKey(TEA_PROJECT_KEY)), '{broken');
  // every field is validated; one wrong field rejects the whole project
  const good = json(full());
  assert.notEqual(parseTeaProject(good), null);
  const mutate = (fn: (d: any) => void) => { const d = json(good); fn(d); return parseTeaProject(d); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const bad: [string, (d: any) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['currency', d => { d.currency = 'GBP'; }], ['compareB', d => { d.compareB = 'yes'; }], ['scenariosEnabled', d => { d.scenariosEnabled = 1; }], ['title type', d => { d.formA.title = 5; }],
    ['title long', d => { d.formA.title = 'x'.repeat(201); }], ['capex missing', d => { delete d.formA.capex.equipment; }], ['capex number', d => { d.formA.capex.equipment = 5000000; }],
    ['opexPeriod', d => { d.formA.opexPeriod = 'week'; }], ['effectMode', d => { d.formB.effectMode = 'x'; }], ['capacity', d => { d.formA.capacity = null; }],
    ['scenario missing', d => { delete d.scenarioForms.optimistic; }], ['handoff', d => { d.handoff.handoff.maxChamberSizeMm = 'big'; }], ['handoff time', d => { d.handoff.importedAt = 5; }],
    ['calculation currency', d => { d.calculation.currency = 'X'; }], ['calculation input', d => { d.calculation.variantA.input.capex.equipment = 'much'; }], ['calculation NaN-like', d => { d.calculation.variantA.input.capacity = null; }],
    ['undefined calculation', d => { delete d.calculation; }], ['not object', d => { d.formA = []; }],
  ];
  for (const [name, fn] of bad) assert.equal(mutate(fn), null, name);
  assert.notEqual(mutate(d => { d.calculation = null; d.calculatedFrom = null; d.handoff = null; }), null);
});

test('6. an unknown version is not loaded and not overwritten before it is put aside', () => {
  const store = createInMemoryProjectStore();
  const future = JSON.stringify({ version: 2, savedAt: '2030-01-02T03:04:05.000Z', content: { somethingNew: true } });
  store.setItem(TEA_PROJECT_KEY, future);
  const p = persistence(store);
  const loaded = p.hydrate();
  assert.equal(loaded.status, 'unsupported_version');
  assert.equal(store.getItem(TEA_PROJECT_KEY), future);
  assert.equal(p.save(project()).ok, true);
  assert.equal(store.getItem(backupKey(TEA_PROJECT_KEY)), future);
  for (const version of [0, 1.5, '1', null]) { const s = createInMemoryProjectStore(); s.setItem(TEA_PROJECT_KEY, JSON.stringify({ version, savedAt: '2030-01-02T03:04:05.000Z', content: json(project()) })); assert.notEqual(loadProject(TEA_PROJECT_CONFIG, s).status, 'restored'); }
});

test('7. an unavailable or broken localStorage: no exception, honest outcomes, nothing on the server', () => {
  const p = persistence(null);
  assert.deepEqual(p.hydrate(), { status: 'unavailable' });
  assert.deepEqual(p.save(project()), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(p.clear(), { ok: false, reason: 'unavailable' });
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    assert.equal(detectProjectStore(), null);
    delete (globalThis as { localStorage?: unknown }).localStorage;
    assert.equal(detectProjectStore(), null);
  } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  assert.ok(!/\blocalStorage\b/.test(component));                                               // storage only through the module, inside effects
});

test('8. a full storage: a readable project is still restored, the refused write is reported, nothing is deleted, and the next change tries again', () => {
  const seeded = createInMemoryProjectStore(); hydrated(seeded).p.save(full());
  const data = new Map<string, string>([[TEA_PROJECT_KEY, seeded.getItem(TEA_PROJECT_KEY)!]]);
  let full_ = true;
  const store: ProjectStore = {
    getItem: k => data.get(k) ?? null, removeItem: k => { data.delete(k); },
    setItem: (k, v) => { if (full_) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } data.set(k, v); },
  };
  const p = persistence(store);
  assert.equal(p.hydrate().status, 'restored');                                                 // reading works although writing is refused
  const original = data.get(TEA_PROJECT_KEY);
  const next = { ...project(), currency: 'EUR' as const };
  assert.deepEqual(p.save(next), { ok: false, reason: 'quota' });
  assert.equal(data.get(TEA_PROJECT_KEY), original);
  full_ = false;
  assert.equal(p.save(next).ok, true);
  assert.equal(JSON.parse(data.get(TEA_PROJECT_KEY)!).content.currency, 'EUR');
  // detection does not write
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const fake = { getItem: (k: string) => data.get(k) ?? null, setItem: () => { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); }, removeItem: () => undefined };
  try { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake }); assert.notEqual(detectProjectStore(), null); assert.equal(loadProject(TEA_PROJECT_CONFIG, detectProjectStore()).status, 'restored'); }
  finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
});

/** A global `localStorage` whose reads can be made to fail temporarily; detection really goes through it. */
function withFlakyStorage<T>(seed: Record<string, string>, body: (control: { fail: boolean; data: Map<string, string> }) => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const control = { fail: false, data: new Map(Object.entries(seed)) };
  const fake = {
    getItem: (k: string) => { if (control.fail) throw new Error('SecurityError: temporarily unavailable'); return control.data.get(k) ?? null; },
    setItem: (k: string, v: string) => { control.data.set(k, v); }, removeItem: (k: string) => { control.data.delete(k); },
  };
  try { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake }); return body(control); }
  finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete (globalThis as { localStorage?: unknown }).localStorage; }
}
const savedProject = (): string => { const s = createInMemoryProjectStore(); hydrated(s).p.save(full()); return s.getItem(TEA_PROJECT_KEY)!; };

test('9. a failed read: nothing is written until a read succeeds; the storage is found again on retry; the typed input is not replaced by the stored project', () => {
  const A = savedProject();
  withFlakyStorage({ [TEA_PROJECT_KEY]: A }, control => {
    control.fail = true;
    assert.equal(detectProjectStore(), null);
    const p = persistence(detectProjectStore);                                                   // the DETECTION is handed over, so a retry looks again
    assert.deepEqual(p.hydrate(), { status: 'unavailable' });
    assert.equal(p.isHydrated(), false);
    const ft = fakeTimers(); const outcomes: SaveOutcome[] = [];
    const autosave = createAutosave(p, o => outcomes.push(o), 600, ft.timers);
    autosave.update(project({ currency: 'EUR' })); ft.advance(5_000); autosave.flush();         // the user keeps working: it lives in memory only
    assert.equal(control.data.get(TEA_PROJECT_KEY), A);                                         // the stored project is untouched
    assert.deepEqual(p.hydrate({ keepExisting: true }), { status: 'unavailable' });
    control.fail = false;
    assert.equal(p.hydrate({ keepExisting: true }).status, 'restored');                         // the storage is back; the caller does NOT apply the stored project over the input
    autosave.update(project({ currency: 'EUR' })); ft.advance(1_000);
    assert.equal(control.data.get(backupKey(TEA_PROJECT_KEY)), A);                              // the earlier project was put aside BEFORE
    assert.equal(JSON.parse(control.data.get(TEA_PROJECT_KEY)!).content.currency, 'EUR');
  });
  // a read that throws on an existing storage is read_failed, not "no data"
  const flaky: ProjectStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('must not write'); }, removeItem: () => { throw new Error('must not remove'); } };
  const q = persistence(flaky);
  assert.deepEqual(q.hydrate(), { status: 'read_failed' });
  assert.deepEqual(q.save(project()), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(q.clear(), { ok: false, reason: 'not_hydrated' });
  // with no new input, the retry restores the stored project and saving then works
  withFlakyStorage({ [TEA_PROJECT_KEY]: A }, control => {
    control.fail = true;
    const p = persistence(detectProjectStore); p.hydrate();
    control.fail = false;
    const again = p.hydrate();
    assert.equal(again.status, 'restored');
    assert.deepEqual(p.save(again.status === 'restored' ? again.project.content : full()), { ok: false, reason: 'unchanged' });
    assert.equal(p.save(project()).ok, true);
  });
});

test('10. a busy backup slot blocks the destructive write and the clearing: both documents survive and nothing is cleared automatically', () => {
  const store = createInMemoryProjectStore();
  store.setItem(backupKey(TEA_PROJECT_KEY), 'DOCUMENT-A');
  store.setItem(TEA_PROJECT_KEY, '{broken B');
  const p = persistence(store);
  assert.equal(p.hydrate().status, 'corrupted');
  assert.deepEqual(p.save(project()), { ok: false, reason: 'quarantine_occupied' });
  assert.deepEqual(p.save(project({ currency: 'EUR' })), { ok: false, reason: 'quarantine_occupied' });
  assert.equal(store.getItem(backupKey(TEA_PROJECT_KEY)), 'DOCUMENT-A'); assert.equal(store.getItem(TEA_PROJECT_KEY), '{broken B');
  assert.deepEqual(p.clear(), { ok: false, reason: 'quarantine_occupied' });
  assert.equal(store.getItem(TEA_PROJECT_KEY), '{broken B');
  // a backup that cannot be written blocks the write as well
  const data = new Map<string, string>([[TEA_PROJECT_KEY, '{broken']]);
  const noBackup: ProjectStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { if (k.endsWith('.unreadable')) throw new Error('quota'); data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const q = persistence(noBackup); q.hydrate();
  assert.deepEqual(q.save(project()), { ok: false, reason: 'quarantine_failed' });
  assert.equal(data.get(TEA_PROJECT_KEY), '{broken');
});

test('11. clearing removes the TEA project only: Scientific Writer, the Equipment Selector hand-over and everything else stay', () => {
  const data = new Map<string, string>([
    ['plasmatech.scientific-writer.draft.v1', 'WRITER'], ['plasmatech.scientific-writer.references.v1', 'REFS'], ['plasmatech.equipment-tea-handoff.v1', 'HANDOFF'], ['other', 'x'],
  ]);
  const store: ProjectStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const p = persistence(store); p.hydrate();
  p.save(full());
  assert.notEqual(data.get(TEA_PROJECT_KEY), undefined);
  assert.deepEqual(p.clear(), { ok: true });
  assert.equal(data.get(TEA_PROJECT_KEY), undefined);
  for (const [k, v] of [['plasmatech.scientific-writer.draft.v1', 'WRITER'], ['plasmatech.scientific-writer.references.v1', 'REFS'], ['plasmatech.equipment-tea-handoff.v1', 'HANDOFF'], ['other', 'x']]) assert.equal(data.get(k), v, k);
  assert.equal(loadProject(TEA_PROJECT_CONFIG, store).status, 'empty');
  assert.deepEqual(p.save(defaultTeaProject()), { ok: false, reason: 'unchanged' });
  assert.equal(p.save(project()).ok, true);
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  assert.match(component, /window\.confirm\(/);
  assert.ok(component.indexOf('window.confirm(') < component.indexOf('persistence.current.clear()'));
  assert.ok(component.indexOf('autosave.current?.cancel()') < component.indexOf('persistence.current.clear()'));
});

test('12. the results after a restore are calculated again by the one engine and equal the results of the original inputs; no result is stored', () => {
  const store = createInMemoryProjectStore();
  hydrated(store).p.save(full());
  const raw = store.getItem(TEA_PROJECT_KEY)!;
  assert.ok(!/formula|annualTotal|payback|roi|unitsPerYear/i.test(raw), 'only inputs are stored');
  const loaded = persistence(store).hydrate();
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored' || !loaded.project.content.calculation) return;
  const again = recomputeResults(loaded.project.content.calculation)!;
  assert.deepEqual(again.resultA, runAssessment(teaFormToInput(full().formA)));
  assert.deepEqual(again.resultB, runAssessment(teaFormToInput(full().formB)));
  assert.deepEqual(again.scenarioResults, { base: null, conservative: null, optimistic: null });
  assert.equal(again.resultA.capex.total, 5_500_000);                                           // 5 000 000 + 500 000 delivery
  // scenarios
  const sc = project({ scenariosEnabled: true });
  sc.scenarioForms.conservative = { ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment: '6000000' }, currentAnnualCost: '900000', newAnnualCost: '600000' };
  sc.scenarioForms.optimistic = { ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment: '4000000' }, currentAnnualCost: '900000', newAnnualCost: '600000' };
  sc.scenarioForms.base = { ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment: '5000000' }, currentAnnualCost: '900000', newAnnualCost: '600000' };
  const s2 = createInMemoryProjectStore(); hydrated(s2).p.save(consistent(sc));
  const l2 = persistence(s2).hydrate();
  assert.equal(l2.status, 'restored');
  const c2 = l2.status === 'restored' ? l2.project.content.calculation : null;
  const r2 = c2 ? recomputeResults(c2)! : null;
  assert.deepEqual(r2?.scenarioResults.conservative, runAssessment(teaFormToInput(sc.scenarioForms.conservative)));
  assert.deepEqual(r2?.scenarioResults.optimistic, runAssessment(teaFormToInput(sc.scenarioForms.optimistic)));
  // an input the engine refuses is not shown (the form is kept)
  assert.equal(recomputeResults({ currency: 'RUB', variantA: { input: { ...input(1), capacity: { ...input(1).capacity, shiftsPerDay: 25 } } } }), null);
  assert.equal(recomputeResults(parseTeaReportRequest(json({ currency: 'RUB', variantA: { input: { ...input(1), capacity: { ...input(1).capacity, hoursPerShift: -1 } } } }))), null);
});

test('13. the formulas are not touched: this feature only adds storage; the calculation modules differ from the base only by one export', () => {
  const store = readFileSync(join(__dirname, '../src/services/workspace/tea-project-store.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const persistenceSource = readFileSync(join(__dirname, '../src/services/workspace/local-project-persistence.ts'), 'utf8');
  assert.ok(!/calculate(Capex|Opex|ProductionCapacity|UnitCost|EconomicEffect|Payback|Roi|BreakEven|CumulativeSavings)/.test(store), 'no formula is imported');
  assert.ok(!/\bMath\.|toFixed|\*\s*\d|\/\s*\d/.test(store), 'no arithmetic');
  assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon/.test(store + persistenceSource), 'nothing is sent anywhere');
  // the engine gives the same numbers as before for a fixed synthetic input
  const r = runAssessment(input(5_000_000));
  assert.equal(r.capex.total, 5_000_000 + 500_000 + 250_000);
  assert.equal(r.opex.annualTotal, 450_000);
  assert.equal(r.economicEffect.annualSavings, 300_000);
  assert.equal(r.capacity.unitsPerYear, 2 * 8 * 250 * 0.8 * (60 / 20));
});

test('14. no regressions of the DOCX/PDF report and of the Equipment Selector hand-over: the restored calculation builds the same report; the hand-over is consumed as before', () => {
  const NOW = new Date('2030-01-02T03:04:05.000Z');
  const store = createInMemoryProjectStore(); hydrated(store).p.save(full());
  const loaded = persistence(store).hydrate();
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored' || !loaded.project.content.calculation) return;
  const restored = loaded.project.content.calculation;
  assert.deepEqual(json(buildTeaReport(restored, NOW)), json(buildTeaReport(full().calculation!, NOW)));            // the same document model, so the same DOCX and PDF
  assert.deepEqual(json(reportRequestBody(restored, 'docx')), json(reportRequestBody(full().calculation!, 'docx')));
  assert.deepEqual(json(reportRequestBody(restored, 'pdf').report), json(reportRequestBody(full().calculation!, 'pdf').report));
  assert.deepEqual(restored.handoff, handoff());                                                                // the configuration travels with the saved calculation
  // the hand-over queue: consumed exactly once, as before; the saved project is a separate key
  const queue = createInMemoryStoreForTests();
  queueEquipmentHandoff(handoff(), queue);
  assert.ok(consumePendingEquipmentHandoff(queue));
  assert.equal(consumePendingEquipmentHandoff(queue), null);
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  const mount = component.slice(component.indexOf('const p = createProjectPersistence'), component.indexOf('const leave ='));
  assert.ok(mount.indexOf('p.hydrate()') < mount.indexOf('peekPendingEquipmentHandoff()'), 'the stored project is read first, then the hand-over is applied on top');
  assert.ok(!/consumePendingEquipmentHandoff/.test(component), 'the hand-over is no longer removed on arrival');
  assert.match(component, /setFormA\(prev => \(\{ \.\.\.prev, title: next\.formA\.title \}\)\)/);   // the hand-over still sets only the descriptive title
});

test('15. the interface: the banner says where the project lives, there is a retry for both failed states, a confirmed clearing, and a retry never calculates or resets the form', () => {
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  assert.match(component, /только в этом браузере/); assert.match(component, /не отправляется/); assert.match(component, /не шифруется и не копируется в резерв/);
  assert.match(component, /Очистить проект/);
  assert.match(component, /projectStatus\.kind === 'read_failed' \|\| projectStatus\.kind === 'unavailable'\) && <button[^>]*onClick=\{retryRead\}/);
  assert.match(component, /createProjectPersistence\(TEA_PROJECT_CONFIG, detectProjectStore\)/);
  const start = component.indexOf('function retryRead()');
  const body = component.slice(start, component.indexOf('\n  }\n', start));
  assert.ok(body.length > 100);
  assert.ok(!/calculate\(|runAssessment|setFormA|setFormB|applyProject|fetch\(/.test(body), 'a retry does not calculate, reset the form or call a server');
  assert.match(body, /keepExisting: !pristine/);
  assert.ok(!/setInterval|setTimeout\(\s*retryRead/.test(component));
});


// ======================= P1-02 audit corrections F1-F4 =======================

/** What the component's "Рассчитать" does with the form: the inputs of variant A, the currency (and B / scenarios when switched on) become the snapshot, and the form is remembered. */
const calculateFrom = (p: TeaProjectContent): TeaProjectContent => ({
  ...p,
  calculation: { currency: p.currency, variantA: { ...(p.formA.title.trim() !== '' ? { title: p.formA.title } : {}), input: teaFormToInput(p.formA) }, ...(p.handoff ? { handoff: p.handoff.handoff } : {}) },
  calculatedFrom: scenarioOf(p),
});
const withEquipment = (p: TeaProjectContent, equipment: string): TeaProjectContent => ({ ...p, formA: { ...p.formA, capex: { ...p.formA.capex, equipment } } });
const filled = (equipment: string): TeaProjectContent => {
  const p = defaultTeaProject();
  p.formA = { ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment }, opex: { ...defaultTeaForm().opex, labor: '100000' }, currentAnnualCost: '900000', newAnnualCost: '600000' };
  return p;
};

test('F1. an outdated calculation is marked as such, labelled with its own currency, and never recalculated by itself (CAPEX 1 000 000 RUB -> 2 000 000 USD -> save -> restore)', () => {
  const calculated = calculateFrom(filled('1000000'));
  assert.equal(calculated.currency, 'RUB');
  assert.equal(isCalculationStale(calculated), false);                                              // right after the calculation the results are current
  // the user edits the form after the calculation
  const edited: TeaProjectContent = { ...withEquipment(calculated, '2000000'), currency: 'USD' };
  assert.equal(isCalculationStale(edited), true);
  assert.equal(edited.formA.capex.equipment, '2000000');                                           // the form holds the new values
  assert.equal(edited.calculation!.currency, 'RUB');                                               // the calculation keeps its own
  // save and restore (a new controller over the same storage)
  const store = createInMemoryProjectStore();
  const { p } = hydrated(store);
  assert.equal(p.save(edited).ok, true);
  const loaded = persistence(store).hydrate();
  assert.equal(loaded.status, 'restored');
  if (loaded.status !== 'restored') return;
  const restored = loaded.project.content;
  assert.equal(restored.formA.capex.equipment, '2000000'); assert.equal(restored.currency, 'USD');
  assert.equal(isCalculationStale(restored), true);                                                // still marked outdated after the restore
  assert.equal(shownResultContext(restored)?.currency, 'RUB');                                      // labelled with the currency of the calculation
  const again = recomputeResults(restored.calculation!)!;
  assert.equal(again.resultA.capex.total, 1_000_000);                                              // the shown result is the old one
  // a new calculation uses the current values, the warning disappears
  const renewed = calculateFrom(restored);
  assert.equal(isCalculationStale(renewed), false);
  assert.equal(shownResultContext(renewed)?.currency, 'USD');
  assert.equal(recomputeResults(renewed.calculation!)!.resultA.capex.total, 2_000_000);
  // and the stored project of the renewed calculation is current after another round trip
  const store2 = createInMemoryProjectStore(); hydrated(store2).p.save(renewed);
  const l2 = persistence(store2).hydrate();
  assert.equal(l2.status === 'restored' && isCalculationStale(l2.project.content), false);
});

test('F1. what makes a calculation outdated: any field, a switch, the currency, the configuration; what does not: nothing else', () => {
  const base = calculateFrom(filled('1000000'));
  assert.equal(isCalculationStale(base), false);
  assert.equal(isCalculationStale({ ...base, formA: { ...base.formA, title: 'новое название' } }), true);
  assert.equal(isCalculationStale({ ...base, formA: { ...base.formA, opex: { ...base.formA.opex, labor: '1' } } }), true);
  assert.equal(isCalculationStale({ ...base, formA: { ...base.formA, opexPeriod: 'month' } }), true);
  assert.equal(isCalculationStale({ ...base, compareB: true }), true);
  assert.equal(isCalculationStale({ ...base, scenariosEnabled: true }), true);
  assert.equal(isCalculationStale({ ...base, formB: { ...base.formB, title: 'B' } }), true);                // variant B edited
  assert.equal(isCalculationStale({ ...base, scenarioForms: { ...base.scenarioForms, base: { ...base.scenarioForms.base, title: 'S' } } }), true);
  assert.equal(isCalculationStale({ ...base, handoff: { handoff: handoff(), importedAt: '2030-01-01T00:00:00.000Z' } }), true);
  assert.equal(isCalculationStale({ ...base, calculatedFrom: null }), true);                                // a calculation whose form is unknown is never presented as current
  assert.equal(isCalculationStale({ ...base, calculation: null, calculatedFrom: null }), false);           // no results, nothing to warn about
  assert.equal(isCalculationStale(JSON.parse(JSON.stringify(base))), false);                                // a round trip through JSON changes nothing
  // the component: the exact warning, the labels from the calculation, and no calculation without the user
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  assert.match(component, /\{STALE_RESULTS_MESSAGE\}/);                                          // T1: outdated results are replaced by this message, not shown (see tests/t1-doc-layout.test.ts)
  assert.match(component, /shown\?\.titleA/); assert.match(component, /shown\?\.titleB/); assert.match(component, /shown\?\.scenarioTitles\[key\]/);
  assert.match(component, /const shownCurrency = shown\?\.currency \?\? currency/);
  assert.ok(!/formA\.title \? `: \$\{formA\.title\}`/.test(component), 'the heading no longer uses the current title');
  assert.equal((component.match(/runAssessment\(/g) ?? []).length, 3, 'runAssessment only in the calculation itself (A, B, scenarios)');
  assert.equal((component.match(/recomputeResults\(/g) ?? []).length, 1, 'results are recomputed only when a stored project is restored');
  assert.match(component, /source=\{|snapshot=\{reportSnapshot\}/);                                      // the report still gets the calculation snapshot
});

/** A session of the component as far as persistence and the hand-over go: mount (read, then hand-over), edit, save, confirm. */
function openTea(projectStore: ProjectStore | null | (() => ProjectStore | null), queue: KeyValueStore | null) {
  const p = persistence(projectStore);
  const loaded = p.hydrate();
  let content: TeaProjectContent = loaded.status === 'restored' ? loaded.project.content : defaultTeaProject();
  const pending = queue ? peekPendingEquipmentHandoff(queue) : null;
  const plan = planHandoffDelivery(loaded.status === 'restored' ? loaded.project.content.handoff : null, pending);
  let waiting: EquipmentTeaHandoffRecord | null = null;
  if (pending && plan === 'already_saved' && queue) acknowledgeEquipmentHandoff(pending, queue);
  else if (pending && plan === 'apply') { waiting = pending; content = applyHandoffToProject(content, pending); }
  return {
    p, loaded, plan, get content() { return content; }, get waiting() { return waiting; },
    edit(change: (c: TeaProjectContent) => TeaProjectContent) { content = change(content); },
    save() {
      const outcome = p.save(content);
      if (outcome.ok && queue) waiting = confirmHandoffDelivery(waiting, content, r => acknowledgeEquipmentHandoff(r, queue));
      return outcome;
    },
  };
}
const queued = (): { queue: KeyValueStore; record: EquipmentTeaHandoffRecord } => {
  const queue = createInMemoryStoreForTests();
  queueEquipmentHandoff(handoff(), queue);
  return { queue, record: peekPendingEquipmentHandoff(queue)! };
};
const flakyProjectStore = (over: { failWrites?: boolean } = {}) => {
  const state = { failWrites: over.failWrites ?? false };
  const data = new Map<string, string>();
  const store: ProjectStore = {
    getItem: k => data.get(k) ?? null, removeItem: k => { data.delete(k); },
    setItem: (k, v) => { if (state.failWrites) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } data.set(k, v); },
  };
  return { store, state, data };
};

test('F2. normal delivery: the hand-over is read, applied, saved and only then removed from the queue', () => {
  const { queue, record } = queued();
  const store = createInMemoryProjectStore();
  const s = openTea(store, queue);
  assert.equal(s.plan, 'apply');
  assert.deepEqual(peekPendingEquipmentHandoff(queue), record);                                    // reading did not remove it
  assert.equal(s.content.handoff?.handoff.configurationId, record.handoff.configurationId);
  assert.equal(s.content.formA.title, record.handoff.configurationName);
  assert.deepEqual(peekPendingEquipmentHandoff(queue), record);                                    // applied on the screen but not yet saved: still in the queue
  assert.equal(s.save().ok, true);
  assert.equal(peekPendingEquipmentHandoff(queue), null);                                          // saved: removed
  assert.equal(s.waiting, null);
  assert.equal(stored(store).content.handoff.importedAt, record.importedAt);                        // and it lives in the saved project
  const again = openTea(store, queue);                                                              // reopening: restored, nothing to deliver
  assert.equal(again.plan, 'none'); assert.equal(again.content.handoff?.importedAt, record.importedAt);
});

test('F2. a failed save keeps the hand-over: the queue is untouched and the next opening delivers it again', () => {
  const { queue, record } = queued();
  const flaky = flakyProjectStore({ failWrites: true });
  const s = openTea(flaky.store, queue);
  assert.deepEqual(s.save(), { ok: false, reason: 'quota' });                                      // QuotaExceededError
  assert.deepEqual(peekPendingEquipmentHandoff(queue), record);                                    // still available
  assert.deepEqual(s.waiting, record);
  assert.equal(flaky.data.get(TEA_PROJECT_KEY), undefined);
  // reopening after the failure: the hand-over is applied again, and this time the save succeeds
  flaky.state.failWrites = false;
  const second = openTea(flaky.store, queue);
  assert.equal(second.plan, 'apply');
  assert.equal(second.save().ok, true);
  assert.equal(peekPendingEquipmentHandoff(queue), null);
  // an unavailable storage and a failed read never destroy it either
  const { queue: q2, record: r2 } = queued();
  const none = openTea(null, q2);
  assert.equal(none.plan, 'apply'); assert.deepEqual(none.save(), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(peekPendingEquipmentHandoff(q2), r2);
  const brokenReads: ProjectStore = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  const failedRead = openTea(brokenReads, q2);
  assert.deepEqual(failedRead.save(), { ok: false, reason: 'not_hydrated' });
  assert.deepEqual(peekPendingEquipmentHandoff(q2), r2);
});

test('F2. the project is saved but the queue entry cannot be removed: reopening does not apply the same configuration again, and retries only the removal', () => {
  const data = new Map<string, string>();
  const base = createInMemoryStoreForTests();
  let removalFails = true;
  const queue: KeyValueStore = { getItem: k => base.getItem(k), setItem: (k, v) => base.setItem(k, v), removeItem: k => { if (removalFails) throw new Error('cannot remove'); base.removeItem(k); } };
  queueEquipmentHandoff(handoff(), queue);
  const record = peekPendingEquipmentHandoff(queue)!;
  const store: ProjectStore = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  const first = openTea(store, queue);
  assert.equal(first.save().ok, true);                                                             // the project is saved...
  assert.deepEqual(first.waiting, record);                                                         // ...but the removal failed, so it is still waiting
  assert.deepEqual(peekPendingEquipmentHandoff(queue), record);
  // the user changes variant A's title by hand and reopens
  first.edit(c => ({ ...c, formA: { ...c.formA, title: 'МОЁ НАЗВАНИЕ' } }));
  assert.equal(first.save().ok, true);
  const second = openTea(store, queue);
  assert.equal(second.plan, 'already_saved');                                                      // not applied again
  assert.equal(second.content.formA.title, 'МОЁ НАЗВАНИЕ');                                         // the user's edit is not overwritten by the same configuration
  assert.deepEqual(peekPendingEquipmentHandoff(queue), record);                                    // removal failed again, still retried
  removalFails = false;
  const third = openTea(store, queue);
  assert.equal(third.plan, 'already_saved');
  assert.equal(third.content.formA.title, 'МОЁ НАЗВАНИЕ');
  assert.equal(peekPendingEquipmentHandoff(queue), null);                                          // finally removed
  // a NEWER hand-over queued meanwhile is never removed by the confirmation of an older one
  const q2 = createInMemoryStoreForTests();
  queueEquipmentHandoff(handoff(), q2);
  const older = peekPendingEquipmentHandoff(q2)!;
  queueEquipmentHandoff(buildTechnoEconomicHandoff(EQUIPMENT_CONFIGURATIONS[EQUIPMENT_CONFIGURATIONS.length - 1]), q2);
  const newer = peekPendingEquipmentHandoff(q2)!;
  const sameConfig = older.handoff.configurationId === newer.handoff.configurationId && older.importedAt === newer.importedAt;
  assert.equal(acknowledgeEquipmentHandoff(older, q2), true);
  assert.deepEqual(peekPendingEquipmentHandoff(q2), sameConfig ? null : newer);
});

test('F2. applying a hand-over changes nothing but the configuration card and the descriptive title: financial fields, variant B, scenarios, currency and switches stay', () => {
  const before = withEquipment(project({ scenariosEnabled: true, calculation: calculation(), calculatedFrom: null }), '7777777');
  before.scenarioForms.optimistic.opex.labor = '12345';
  const record: EquipmentTeaHandoffRecord = { handoff: handoff(), importedAt: '2030-01-01T00:00:00.000Z' };
  const after = applyHandoffToProject(before, record);
  assert.equal(after.formA.title, record.handoff.configurationName);
  assert.deepEqual({ ...after, handoff: null, formA: { ...after.formA, title: before.formA.title } }, { ...before, handoff: null });
  assert.equal(after.formA.capex.equipment, '7777777'); assert.equal(after.scenarioForms.optimistic.opex.labor, '12345');
  assert.equal(after.formB.capex.equipment, '3000000'); assert.equal(after.currency, 'USD'); assert.equal(after.compareB, true); assert.equal(after.scenariosEnabled, true);
  assert.notEqual(after, before); assert.equal(before.handoff, null);                                  // the input is not mutated
  // through a full session: a restored project keeps all of that when the hand-over arrives
  const store = createInMemoryProjectStore();
  hydrated(store).p.save(withEquipment(project(), '7777777'));
  const { queue } = queued();
  const s = openTea(store, queue);
  assert.equal(s.content.formA.capex.equipment, '7777777'); assert.equal(s.content.formB.capex.equipment, '3000000');
  assert.equal(s.save().ok, true);
  assert.equal(stored(store).content.formA.capex.equipment, '7777777');
});

test('F3. what is written must be readable: a 402-character CAPEX value is refused with a reason, nothing is truncated, and the previous valid project stays', () => {
  const store = createInMemoryProjectStore();
  const { p } = hydrated(store);
  const valid = withEquipment(project(), '1234567');
  assert.equal(p.save(valid).ok, true);
  const good = store.getItem(TEA_PROJECT_KEY);
  const tooLong = '9'.repeat(402);
  const bad = withEquipment(project(), tooLong);
  const outcome = p.save(bad);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, 'invalid');
  assert.match(!outcome.ok ? outcome.problem ?? '' : '', /formA\.capex\.equipment/);
  assert.match(!outcome.ok ? outcome.problem ?? '' : '', /402/);
  assert.match(!outcome.ok ? outcome.problem ?? '' : '', /не усекается/);
  assert.equal(store.getItem(TEA_PROJECT_KEY), good);                                           // the earlier valid record is untouched
  assert.equal(bad.formA.capex.equipment.length, 402);                                          // and the input itself is not modified
  // 400 is allowed, 401 is not; the check is the loader's own
  assert.equal(p.save(withEquipment(project(), '1'.repeat(400))).ok, true);
  const at401 = p.save(withEquipment(project(), '1'.repeat(401)));
  assert.equal(!at401.ok && at401.reason, 'invalid');
  // a long title (UI limit 200), and a project that is wrong in other ways, are refused the same way and with their own reasons
  assert.match(String((p.save({ ...project(), formA: { ...project().formA, title: 'т'.repeat(201) } }) as { problem?: string }).problem), /formA\.title/);
  assert.match(explainTeaProject({ ...JSON.parse(JSON.stringify(project())), currency: 'GBP' }) ?? '', /currency: RUB, USD или EUR/);
  // the invariant: if save() says ok, the loader accepts exactly the same data
  for (const candidate of [project(), full(), withEquipment(project(), '1'.repeat(400)), defaultTeaProject(), { ...project(), compareB: true }]) {
    const fresh = hydrated(); const outcome2 = fresh.p.save(candidate);
    if (outcome2.ok) { const back = loadProject(TEA_PROJECT_CONFIG, fresh.store); assert.equal(back.status, 'restored'); }
  }
  // through the scheduler: the invalid content is reported, kept for the next attempt, and never written
  const ed = editor();
  ed.autosave.update(bad); ed.ft.advance(1_000);
  assert.equal(ed.outcomes.length, 1); assert.equal(!ed.outcomes[0].ok && ed.outcomes[0].reason, 'invalid');
  ed.autosave.flush();
  assert.equal(ed.store.getItem(TEA_PROJECT_KEY), null);
  ed.autosave.update(withEquipment(project(), '5')); ed.ft.advance(1_000);                     // the user fixes the field: it is saved
  assert.equal(stored(ed.store).content.formA.capex.equipment, '5');
});

test('F4. the schema is strict: an unknown field anywhere makes the project unreadable (it is put aside, not silently cleaned), and it cannot be written either', () => {
  const good = JSON.parse(JSON.stringify(full()));
  assert.notEqual(parseTeaProject(good), null);
  const bad = (name: string, fn: (d: any) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const d = JSON.parse(JSON.stringify(good)); fn(d);
    assert.equal(parseTeaProject(d), null, name);
    assert.match(explainTeaProject(d) ?? '', /неизвестное поле|нет поля|calculation|handoff|ожидал/, name);
  };
  bad('project', d => { d.extra = 1; });
  bad('form', d => { d.formA.extra = 1; });
  bad('capex', d => { d.formA.capex.extra = '1'; });
  bad('opex', d => { d.formB.opex.extra = '1'; });
  bad('capacity', d => { d.scenarioForms.base.capacity.extra = '1'; });
  bad('scenarios', d => { d.scenarioForms.fourth = d.scenarioForms.base; });
  bad('scenario form', d => { d.scenarioForms.optimistic.extra = 1; });
  bad('handoff record', d => { d.handoff.extra = 1; });
  bad('handoff configuration', d => { d.handoff.handoff.extra = 'x'; });
  bad('calculation', d => { d.calculation.extra = 1; });
  bad('calculation input', d => { d.calculation.variantA.input.capex.extra = 1; });
  bad('calculation variant', d => { d.calculation.variantA.extra = 1; });
  bad('calculatedFrom', d => { d.calculatedFrom.extra = 1; });
  bad('calculatedFrom form', d => { d.calculatedFrom.formA.capex.extra = '1'; });
  bad('missing field', d => { delete d.formA.opex.labor; });
  bad('missing project field', d => { delete d.calculatedFrom; });
  // from storage: unreadable, put aside before anything overwrites it
  const raw = JSON.parse(JSON.stringify(good)); raw.formA.capex.surprise = '1';
  const store = createInMemoryProjectStore();
  const text = JSON.stringify({ version: 1, savedAt: '2030-01-02T03:04:05.000Z', content: raw });
  store.setItem(TEA_PROJECT_KEY, text);
  const p = persistence(store);
  assert.equal(p.hydrate().status, 'corrupted');
  assert.equal(p.save(project()).ok, true);
  assert.equal(store.getItem(`${TEA_PROJECT_KEY}.unreadable`), text);                           // the unknown field was kept, not dropped
  // on the way out: a project with an unknown field is refused as well
  const withExtra = { ...project(), extra: 1 } as unknown as TeaProjectContent;
  const refused = hydrated().p.save(withExtra);
  assert.equal(!refused.ok && refused.reason, 'invalid');
  // every real Equipment Selector configuration passes the strict hand-over check (no incompatibility with the standard format)
  for (const configuration of EQUIPMENT_CONFIGURATIONS) {
    const record: EquipmentTeaHandoffRecord = { handoff: buildTechnoEconomicHandoff(configuration), importedAt: '2030-01-01T00:00:00.000Z' };
    const content = applyHandoffToProject(defaultTeaProject(), record);
    const fresh = hydrated(); const o = fresh.p.save(content);
    assert.equal(o.ok, true, configuration.id ?? configuration.name);
    const back = loadProject(TEA_PROJECT_CONFIG, fresh.store);
    assert.equal(back.status === 'restored' && back.project.content.handoff?.handoff.configurationId, record.handoff.configurationId);
  }
});

test('F-regressions. the calculation engine, scenarios, A/B and the report are untouched', () => {
  const a = runAssessment(input(5_000_000)); const b = runAssessment(input(3_000_000));
  assert.equal(a.capex.total, 5_750_000); assert.equal(b.capex.total, 3_450_000);
  assert.equal(a.opex.annualTotal, 450_000); assert.equal(a.economicEffect.annualSavings, 300_000);
  assert.equal(a.payback.years, a.capex.total / 300_000);                                         // the payback formula as before
  const assessmentSource = readFileSync(join(__dirname, '../src/services/workspace/techno-economic-assessment.ts'), 'utf8');
  assert.ok(!/localStorage|tea-project|local-project/.test(assessmentSource));
  const request: TeaReportRequest = { ...calculation(), scenarios: { base: { input: input(5_000_000) }, conservative: { input: input(6_000_000) }, optimistic: { input: input(4_000_000) } } };
  assert.equal(parseTeaReportRequest(JSON.parse(JSON.stringify(request))).scenarios?.conservative.input.capex.equipment, 6_000_000);
  assert.ok(buildTeaReport(request, new Date('2030-01-02T03:04:05.000Z')).sections.length > 0);
});

// ======================= P1-02 final F1: the stored calculation must be the calculation of the stored form =======================

const withScenarios = (): TeaProjectContent => {
  const p = project({ scenariosEnabled: true, compareB: true });
  const sc = (equipment: string): TeaFormState => ({ ...defaultTeaForm(), capex: { ...defaultTeaForm().capex, equipment }, currentAnnualCost: '900000', newAnnualCost: '600000' });
  p.scenarioForms = { base: sc('5000000'), conservative: sc('6000000'), optimistic: sc('4000000') };
  return consistent(p);
};
const asJson = (p: TeaProjectContent) => JSON.parse(JSON.stringify(p));
const tamper = (p: TeaProjectContent, change: (d: any) => void) => { const d = asJson(p); change(d); return d; }; // eslint-disable-line @typescript-eslint/no-explicit-any

test('F1-final. a consistent calculation and form are accepted, saved and restored (no variant B, B, scenarios, hand-over: every combination)', () => {
  const cases: [string, TeaProjectContent][] = [
    ['A only', consistent(filled('1000000'))],
    ['A and B', consistent(project())],
    ['A, B and scenarios', withScenarios()],
    ['A and scenarios, no B', consistent({ ...withScenarios(), compareB: false })],
    ['with the configuration', full()],
    ['nothing calculated', filled('1000000')],
    ['blank title', consistent({ ...filled('1000000'), formA: { ...filled('1000000').formA, title: '   ' } })],
  ];
  for (const [name, content] of cases) {
    assert.notEqual(parseTeaProject(asJson(content)), null, name);
    assert.equal(explainTeaProject(asJson(content)), null, name);
    const { p, store } = hydrated();
    assert.equal(p.save(content).ok, true, name);
    const back = loadProject(TEA_PROJECT_CONFIG, store);
    assert.equal(back.status, 'restored', name);
    if (back.status === 'restored') {
      assert.equal(isCalculationStale(back.project.content), false, name);
      assert.equal(describeCalculationMismatch(back.project.content.calculation ?? calculationRequestFrom(scenarioOf(content)), scenarioOf(back.project.content)), null, name);
    }
  }
});

test('F1-final. the Codex reproduction: CAPEX 1 000 000 in the form, 9 000 000 in the calculation -> rejected everywhere, never "current", never silently corrected', () => {
  const good = consistent(filled('1000000'));
  assert.equal(good.calculation!.variantA.input.capex.equipment, 1_000_000);
  const forged = tamper(good, d => { d.calculation.variantA.input.capex.equipment = 9_000_000; });
  assert.equal(parseTeaProject(forged), null);                                                       // the loader refuses it
  assert.match(explainTeaProject(forged) ?? '', /calculation не соответствует calculatedFrom \(вариант A\)/);
  // writing it is refused with the same reason and the previous valid record stays
  const { p, store } = hydrated();
  assert.equal(p.save(good).ok, true);
  const before = store.getItem(TEA_PROJECT_KEY);
  const refused = p.save(forged as TeaProjectContent);
  assert.equal(!refused.ok && refused.reason, 'invalid');
  assert.match(!refused.ok ? refused.problem ?? '' : '', /не соответствует calculatedFrom/);
  assert.equal(store.getItem(TEA_PROJECT_KEY), before);                                             // not overwritten
  // read from storage: unreadable, kept aside, nothing corrected
  const raw = JSON.stringify({ version: 1, savedAt: '2030-01-02T03:04:05.000Z', content: forged });
  const store2 = createInMemoryProjectStore(); store2.setItem(TEA_PROJECT_KEY, raw);
  const q = persistence(store2);
  assert.equal(q.hydrate().status, 'corrupted');
  assert.equal(store2.getItem(TEA_PROJECT_KEY), raw);                                               // no automatic fix
  assert.equal(q.save(good).ok, true);
  assert.equal(store2.getItem(`${TEA_PROJECT_KEY}.unreadable`), raw);                               // the inconsistent record is kept, not erased
  // and the in-memory test: it is never presented as the current calculation
  assert.equal(isCalculationStale({ ...good, calculation: forged.calculation }), false);            // (the staleness check compares forms; the inconsistency is caught on write and load)
  assert.equal(describeCalculationMismatch(forged.calculation, good.calculatedFrom!), 'вариант A');
});

test('F1-final. every part of the calculation is checked against the stored form: currency, variant A, variant B, scenarios, the configuration, the switches', () => {
  const base = withScenarios();
  const cases: [string, (d: any) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['currency', d => { d.calculation.currency = 'EUR'; }, /валюта/],
    ['variant A title', d => { d.calculation.variantA.title = 'другое'; }, /вариант A/],
    ['variant A opex', d => { d.calculation.variantA.input.opex.labor = 1; }, /вариант A/],
    ['variant A depreciation', d => { d.calculation.variantA.input.depreciationYears = 99; }, /вариант A/],
    ['variant B', d => { d.calculation.variantB.input.capex.equipment = 1; }, /вариант B/],
    ['variant B removed although it was on', d => { delete d.calculation.variantB; }, /вариант B/],
    ['variant B added although it was off', d => { d.calculatedFrom.compareB = false; }, /вариант B/],
    ['scenario', d => { d.calculation.scenarios.conservative.input.capex.equipment = 1; }, /сценарии/],
    ['scenario removed although on', d => { delete d.calculation.scenarios; }, /сценарии/],
    ['scenarios added although off', d => { d.calculatedFrom.scenariosEnabled = false; }, /сценарии/],
    ['the other scenario key', d => { d.calculation.scenarios.optimistic.title = 'x'; }, /сценарии/],
    ['calculatedFrom changed, calculation not', d => { d.calculatedFrom.formA.capex.equipment = '1'; }, /вариант A/],
    ['calculatedFrom currency', d => { d.calculatedFrom.currency = 'RUB'; }, /валюта/],
  ];
  for (const [name, change, expected] of cases) {
    const d = tamper(base, change);
    assert.equal(parseTeaProject(d), null, name);
    assert.match(explainTeaProject(d) ?? '', expected, name);
    const outcome = hydrated().p.save(d as TeaProjectContent);
    assert.equal(!outcome.ok && outcome.reason, 'invalid', name);
  }
  // the configuration
  const withHandoff = full();
  const d1 = tamper(withHandoff, d => { delete d.calculation.handoff; });
  assert.match(explainTeaProject(d1) ?? '', /конфигурация Equipment Selector/);
  const d2 = tamper(withHandoff, d => { d.calculatedFrom.handoff = null; });
  assert.match(explainTeaProject(d2) ?? '', /конфигурация Equipment Selector/);
  // a calculation without its form, and a form without its calculation, are one statement broken in half
  assert.match(explainTeaProject(tamper(full(), d => { d.calculatedFrom = null; })) ?? '', /должны быть заданы вместе/);
  assert.match(explainTeaProject(tamper(full(), d => { d.calculation = null; })) ?? '', /должны быть заданы вместе/);
  // nothing was changed by the check
  assert.deepEqual(asJson(base), asJson(withScenarios()));
});

test('F1-final. editing the CURRENT form after the calculation is normal: the project stays valid, is saved and restored, and the old results are marked outdated', () => {
  const calculated = consistent(filled('1000000'));
  const edits: [string, TeaProjectContent][] = [
    ['capex', withEquipment(calculated, '2000000')],
    ['currency', { ...calculated, currency: 'USD' }],
    ['title', { ...calculated, formA: { ...calculated.formA, title: 'новое' } }],
    ['switch B', { ...calculated, compareB: true }],
    ['switch scenarios', { ...calculated, scenariosEnabled: true }],
    ['variant B form', { ...calculated, formB: { ...calculated.formB, capex: { ...calculated.formB.capex, equipment: '5' } } }],
    ['scenario form', { ...calculated, scenarioForms: { ...calculated.scenarioForms, base: { ...calculated.scenarioForms.base, title: 'S' } } }],
    ['the configuration card hidden', { ...full(), handoff: null }],
  ];
  for (const [name, edited] of edits) {
    assert.notEqual(parseTeaProject(asJson(edited)), null, `${name}: stays valid`);
    const { p, store } = hydrated();
    assert.equal(p.save(edited).ok, true, name);
    const back = loadProject(TEA_PROJECT_CONFIG, store);
    assert.equal(back.status, 'restored', name);
    if (back.status !== 'restored') continue;
    const restored = back.project.content;
    assert.equal(isCalculationStale(restored), true, `${name}: marked outdated`);
    assert.equal(restored.formA.capex.equipment, edited.formA.capex.equipment, name);                // the form holds what the user typed
    assert.equal(describeCalculationMismatch(restored.calculation!, restored.calculatedFrom!), null, `${name}: the calculation still matches ITS form`);
    assert.equal(recomputeResults(restored.calculation!)!.resultA.capex.total, recomputeResults(edited.calculation!)!.resultA.capex.total, name);   // and shows the old result, not the edited form's
  }
  // missing optional parts follow the existing contract: no B and no scenarios in the form -> none in the calculation
  const plain = consistent(filled('1000000'));
  assert.equal(plain.calculation!.variantB, undefined); assert.equal(plain.calculation!.scenarios, undefined);
  assert.equal(explainTeaProject(asJson(plain)), null);
});

test('F1-final. the recipe that checks the calculation is the component\'s own recipe', () => {
  const component = readFileSync(join(__dirname, '../src/components/techno-economic-assessment.tsx'), 'utf8');
  // the component builds the snapshot like this; calculationRequestFrom must give the same request (the title only when not blank, B and scenarios when switched on, the configuration)
  assert.ok(component.includes("const variant = (form: FormState, input: AssessmentInput): ReportVariant => ({ ...(form.title.trim() !== '' ? { title: form.title } : {}), input });"));
  assert.ok(component.includes('const snapshot: ReportSnapshot = { currency, variantA: variant(formA, inputA), ...(importedHandoff ? { handoff: importedHandoff.handoff } : {}) };'));
  assert.ok(component.includes('if (compareB) { const inputB = toAssessmentInput(formB); setResultB(runAssessment(inputB)); snapshot.variantB = variant(formB, inputB); }'));
  assert.ok(component.includes('if (scenariosEnabled) {') && component.includes('snapshot.scenarios = inputs;'));
  assert.ok(component.includes('setCalculatedFrom({ formA, formB, compareB, currency, scenariosEnabled, scenarioForms, handoff: importedHandoff });'));
  // the request that comes out has the documented shape, in the documented cases
  const none = calculationRequestFrom(scenarioOf(filled('1000000')));
  assert.deepEqual(Object.keys(none).sort(), ['currency', 'variantA']);
  const all = calculationRequestFrom(scenarioOf(full()));
  assert.deepEqual(Object.keys(all).sort(), ['currency', 'handoff', 'variantA', 'variantB']);
  assert.deepEqual(Object.keys(calculationRequestFrom(scenarioOf(withScenarios()))).sort(), ['currency', 'scenarios', 'variantA', 'variantB']);
  assert.equal(all.variantA.title, 'СИНТЕТИЧЕСКИЙ вариант A');
  assert.equal(calculationRequestFrom(scenarioOf({ ...filled('1'), formA: { ...filled('1').formA, title: '  ' } })).variantA.title, undefined);
});
