import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  restoreDocumentDetailed, validateDocument, touchDocument, saveDocumentWithBackup, updateLayer, duplicateStep, copyLegacyEquipmentToUnit, restoreLegacyStep, moveLegacyFieldToDescription,
  addStep, updateStep, createBlankDocument, buildInstructionView,
  type TechnicalProcessDocument, type KeyValueStorage,
} from '../src/services/workspace/techdoc-assistant';
import { buildDocumentViewModel, exportTechDoc } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

const FIXTURES = new URL('./fixtures/techdoc/', import.meta.url).pathname;
const readFixture = (name: string) => readFileSync(`${FIXTURES}${name}.json`, 'utf8');
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const restoreOk = (raw: string) => {
  const result = restoreDocumentDetailed(raw);
  assert.equal(result.status, 'ok', JSON.stringify(result).slice(0, 600));
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
};
/** restore -> save (JSON text, as the app writes it) -> restore: the second document must equal the first in every field (only the revision stamp is the app's own). */
function assertRoundTrip(raw: string): TechnicalProcessDocument {
  const first = restoreOk(raw).document;
  const saved = JSON.stringify(first);
  const second = restoreOk(saved);
  assert.equal(second.migration, undefined, 'the saved text is a plain schema-4 document');
  assert.deepEqual(json(second.document), json(first), 'nothing changed by saving and reopening');
  assert.deepEqual(json(restoreOk(JSON.stringify(second.document)).document), json(first), 'and again');
  return first;
}
function v3(steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 3, pressureUnit: 'pa', general: { processName: 'Old' }, initialData: {}, qualityChecks: [], safety: { hazards: [], ppe: [], interlocks: [] },
    sources: { magnetrons: [], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } }, gasSystem: [],
    traceability: { version: 4, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', source: 'blank' },
    steps: steps.map((s, i) => ({ order: i + 1, name: `Этап ${i + 1}`, enabled: true, gasUsage: [], sourceAssignments: [], gasAssignments: [], origin: 'user', calculatedFields: [], ...s })), ...extra,
  });
}
const text = (tag: string, length: number) => `${tag}`.padEnd(length, 'ж');
class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>(); failOn: string | undefined; log: string[] = []; corruptReadback = false;
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.log.push(key); if (key === this.failOn) throw new Error('quota exceeded'); this.data.set(key, this.corruptReadback && key.includes('backup') ? value.slice(1) : value); }
}
const KEY = 'techdoc-assistant:document';

// =====================================================================================
// 1. HIGH - a migrated document must be able to come back (restore -> save -> restore)
// =====================================================================================

test('1a. quality step with a 3000-character description AND a 3000-character note: nothing is cut, the check stays within the stored-text limit, the note is kept as legacy data, and the document reopens', () => {
  const description = text('D-', 3000);
  const notes = text('N-', 3000);
  const raw = v3([{ type: 'quality_control', name: 'Контроль', description, notes, acceptanceCriteria: '2.5–3.5 мкм' }]);
  const doc = assertRoundTrip(raw);
  assert.equal(doc.qualityChecks.length, 1);
  assert.equal(doc.qualityChecks[0].method, description, 'the method is the full description, exactly');
  assert.equal(doc.qualityChecks[0].criterion, '2.5–3.5 мкм');
  assert.ok((doc.qualityChecks[0].method ?? '').length <= 5000);
  const legacy = doc.legacy.steps[0];
  assert.deepEqual(legacy.fields.map(f => [f.key, f.value]), [['notes', notes]], 'the note that did not fit is kept in full, as legacy data');
  assert.equal(legacy.enabled, true);
  const report = restoreOk(raw).migration!;
  assert.equal(report.qualityChecksCreated, 1);
  assert.deepEqual(report.qualityResidualSteps, ['Контроль']);
  // the same through the real export route (untrusted JSON parse -> migrate -> validate -> render)
  return exportPOST(new Request('http://localhost/api/workspace/techdoc/export', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document: JSON.parse(raw), documentType: 'instruction', format: 'docx' }) }))
    .then(response => assert.equal(response.status, 200));
});

test('1a. when description and note TOGETHER fit the limit they are combined exactly as before; at the boundary (5000) it still fits, one character more goes to legacy', () => {
  const small = assertRoundTrip(v3([{ type: 'quality_control', name: 'К', description: 'Калотест', notes: 'после остывания' }]));
  assert.equal(small.qualityChecks[0].method, 'Калотест\nПримечание: после остывания');
  assert.deepEqual(small.legacy.steps, []);
  const prefix = '\nПримечание: '.length;
  const fits = assertRoundTrip(v3([{ type: 'quality_control', name: 'К', description: text('a', 4000), notes: text('b', 5000 - 4000 - prefix) }]));
  assert.equal(fits.qualityChecks[0].method!.length, 5000);
  assert.deepEqual(fits.legacy.steps, []);
  const over = assertRoundTrip(v3([{ type: 'quality_control', name: 'К', description: text('a', 4000), notes: text('b', 5000 - 4000 - prefix + 1) }]));
  assert.equal(over.qualityChecks[0].method!.length, 4000);
  assert.equal(over.legacy.steps[0].fields[0].key, 'notes');
  // a note without a description: the note alone is the method when it fits
  assert.equal(assertRoundTrip(v3([{ type: 'quality_control', name: 'К', notes: 'только примечание' }])).qualityChecks[0].method, 'Примечание: только примечание');
  // whitespace of the user's own text is not trimmed away
  assert.equal(assertRoundTrip(v3([{ type: 'quality_control', name: 'К', description: '  отступ\n\nи пустая строка  ' }])).qualityChecks[0].method, '  отступ\n\nи пустая строка  ');
});

function magnetrons(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `magnetron-${i + 1}`, enabled: true, material: `Mat-${i + 1}`, powerW: 100 + i, mode: 'DC' }));
}
const assignments = (count: number, base = 0) => Array.from({ length: count }, (_, i) => ({ sourceId: `magnetron-${i + 1}`, kind: 'magnetron', enabled: i % 2 === 0, mode: 'parallel', powerW: 1000 + base + i, startMin: 0, durationMin: 10 }));
const registry = (count: number) => ({ sources: { magnetrons: magnetrons(count), arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } } });

test('1b. 20 custom steps with 30 magnetron assignments each: the document opens, every source is kept with material, power and ON/OFF state, and it reopens after saving', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({ type: 'custom', name: `Спец-${i + 1}`, description: `описание ${i + 1}`, durationMin: 10, sourceAssignments: assignments(30, i) }));
  const doc = assertRoundTrip(v3(steps, registry(30)));
  assert.equal(doc.legacy.steps.length, 20, 'a step without a card type is kept, not dropped');
  doc.legacy.steps.forEach((step, i) => {
    const sources = step.fields.find(f => f.key === 'sources')!.value as Record<string, unknown>[];
    assert.equal(sources.length, 30);
    sources.forEach((s, j) => assert.deepEqual([s.id, s.material, s.powerW, s.enabled], [`magnetron-${j + 1}`, `Mat-${j + 1}`, 1000 + i + j, j % 2 === 0], `step ${i + 1} source ${j + 1}`));
  });
  assert.equal(doc.legacy.equipment!.magnetrons.length, 30, 'the registry (nominal power) is kept too');
});

test('1b. the same load on real cards: 20 adhesion steps and 20 coating steps with 30 magnetrons each reopen, with all sources in the cards', () => {
  const adhesion = Array.from({ length: 20 }, (_, i) => ({ type: 'adhesion_underlayer', durationMin: 10, sourceAssignments: assignments(30, i) }));
  const doc = assertRoundTrip(v3(adhesion, registry(30)));
  doc.steps.forEach((step, i) => {
    assert.equal(step.sources.length, 30);
    assert.deepEqual(step.sources.map(s => [s.material, s.powerW, s.enabled]), Array.from({ length: 30 }, (_, j) => [`Mat-${j + 1}`, 1000 + i + j, j % 2 === 0]));
  });
  const coating = Array.from({ length: 20 }, (_, i) => ({ type: 'multilayer_coating', durationMin: 10, sourceAssignments: assignments(30, i) }));
  const layered = assertRoundTrip(v3(coating, registry(30)));
  assert.ok(layered.steps.every(s => s.layers[0].sources.length === 30));
});

test('1b. the whole legacy block may be large: 150 custom steps with many fields each still reopen (the limit is per value, plus a generous total)', () => {
  const steps = Array.from({ length: 150 }, (_, i) => ({ type: 'custom', name: `S${i}`, description: 'd', durationMin: 1, temperatureC: 2, pressurePa: 3, powerW: 4, currentA: 5, notes: 'n', acceptanceCriteria: 'a', sourceAssignments: assignments(20, i) }));
  const doc = assertRoundTrip(v3(steps, registry(30)));
  assert.equal(doc.legacy.steps.length, 150);
});

test('1b. a document that could NOT be reopened is never written: saving refuses it and the stored data stays untouched; an overlong text cannot be moved into a description', () => {
  const storage = new FakeStorage();
  storage.data.set(KEY, 'STORED BEFORE');
  const doc: TechnicalProcessDocument = { ...createBlankDocument(), general: { processName: 'Big' }, steps: updateStep(addStep([], 'loading'), 1, { description: 'x'.repeat(6000) }) };
  const outcome = saveDocumentWithBackup(storage, KEY, doc);
  assert.equal(outcome.status, 'not_restorable');
  assert.equal(storage.data.get(KEY), 'STORED BEFORE');
  assert.deepEqual(storage.log, [], 'nothing was written, not even a backup');
  const migrated = restoreOk(v3([{ type: 'pumpdown', name: 'Откачка', description: 'd'.repeat(4900), notes: 'n'.repeat(500) }])).document;
  assert.throws(() => moveLegacyFieldToDescription(migrated, migrated.steps[0].id, 'notes'), /слишком длинным/);
  assert.equal(migrated.legacy.stepFields[0].fields.some(f => f.key === 'notes'), true, 'the note stays where it was');
});

test('restore -> save -> restore keeps the rich recipes of every older schema exactly (materials, gases, numbers, ON/OFF states, legacy data)', () => {
  for (const name of ['schema3-rich', 'schema2', 'schema1']) {
    const first = assertRoundTrip(readFixture(name));
    assert.ok(first.steps.length > 0 && first.qualityChecks.length === 2, name);
  }
  const rich = restoreOk(readFixture('schema3-rich')).document;
  const reopened = restoreOk(JSON.stringify(rich)).document;
  const adhesion = reopened.steps.find(s => s.type === 'adhesion_underlayer')!;
  assert.deepEqual([adhesion.sources[0].material, adhesion.sources[0].powerW, adhesion.sources[0].enabled, adhesion.gases[0].gas, adhesion.gases[0].flowSccm, adhesion.gases[0].enabled], ['Cr', 2000, true, 'Ar', 35, true]);
  assert.equal(reopened.legacy.equipment!.magnetrons.find(m => m.id === 'magnetron-3')!.material, 'Zr');
  // disabled sources / gas lines of an old recipe stay disabled through two round trips
  const off = assertRoundTrip(v3([{ type: 'adhesion_underlayer', durationMin: 10,
    sourceAssignments: [{ sourceId: 'magnetron-1', kind: 'magnetron', enabled: false, mode: 'parallel', powerW: 700 }], gasAssignments: [{ lineId: 'gas-1', enabled: false, flowSccm: 25 }] }],
  { ...registry(1), gasSystem: [{ id: 'gas-1', gas: 'Ar', unit: 'sccm', enabled: true }] }));
  assert.deepEqual([off.steps[0].sources[0].enabled, off.steps[0].sources[0].powerW, off.steps[0].gases[0].enabled, off.steps[0].gases[0].flowSccm], [false, 700, false, 25]);
});

// =====================================================================================
// 2. Disabled steps stay disabled
// =====================================================================================

test('2. a switched-off old step keeps enabled=false when it becomes a legacy step, when it is restored as a card, and through restore -> save -> restore', () => {
  const raw = v3([
    { type: 'etching', name: 'Травление (выкл.)', enabled: false, description: 'ионное', durationMin: 12 },
    { type: 'custom', name: 'Спец (вкл.)', enabled: true, durationMin: 3 },
    { type: 'loading', name: 'Загрузка (выкл.)', enabled: false, durationMin: 15 },
  ]);
  const doc = assertRoundTrip(raw);
  assert.deepEqual(doc.legacy.steps.map(s => [s.name, s.enabled]), [['Травление (выкл.)', false], ['Спец (вкл.)', true]]);
  assert.deepEqual(doc.steps.map(s => [s.name, s.enabled]), [['Загрузка (выкл.)', false]], 'a mapped card stays off too');
  const off = doc.legacy.steps.find(s => s.name === 'Травление (выкл.)')!;
  const restored = restoreLegacyStep(doc, off.id, 'plasma_ion_cleaning');
  assert.equal(restored.steps[restored.steps.length - 1].enabled, false, 'a restored card is still switched off');
  assert.equal(restoreLegacyStep(doc, doc.legacy.steps.find(s => s.enabled)!.id, 'loading').steps.at(-1)!.enabled, true);
  assert.ok(buildInstructionView(doc).includes('(был отключён)'), 'the appendix says it was off');
});

test('2. a switched-off quality-control step does NOT become an active check: it is kept whole, still off, as a legacy step', () => {
  const raw = v3([
    { type: 'quality_control', name: 'Выключенный контроль', enabled: false, description: 'Калотест', acceptanceCriteria: '3 мкм', notes: 'заметка', durationMin: 5 },
    { type: 'quality_control', name: 'Рабочий контроль', description: 'Роквелл', acceptanceCriteria: 'HF1' },
  ]);
  const result = restoreOk(raw);
  assert.deepEqual(result.document.qualityChecks.map(q => q.parameter), ['Рабочий контроль'], 'only the enabled step became a check');
  const kept = result.document.legacy.steps.find(s => s.name === 'Выключенный контроль')!;
  assert.equal(kept.enabled, false);
  assert.deepEqual(Object.fromEntries(kept.fields.map(f => [f.key, f.value])), { description: 'Калотест', durationMin: 5, notes: 'заметка', acceptanceCriteria: '3 мкм' }, 'every value of the step is kept');
  assert.deepEqual(result.migration!.disabledQualitySteps, ['Выключенный контроль']);
  assertRoundTrip(raw);
  // an empty switched-off quality step carries nothing and is not kept
  assert.deepEqual(restoreOk(v3([{ type: 'quality_control', name: 'Пусто', enabled: false }])).document.legacy.steps, []);
});

// =====================================================================================
// 3. Switched-off gas line stays off when copied from the legacy equipment
// =====================================================================================

test('3. a legacy gas line that is OFF (25 sccm) is copied into a card still OFF, with its flow', () => {
  const raw = v3([{ type: 'adhesion_underlayer', durationMin: 10 }], { gasSystem: [
    { id: 'gas-1', gas: 'Ar', unit: 'sccm', enabled: false, flow: 25 }, { id: 'gas-2', gas: 'N2', unit: 'sccm', enabled: true, flow: 40 }, { id: 'gas-3', gas: 'He', unit: 'slm', enabled: false, flow: 5 },
  ] });
  const doc = restoreOk(raw).document;
  const into = (id: string) => copyLegacyEquipmentToUnit(doc, { kind: 'gas', id }, { order: 1 }).steps[0].gases.at(-1)!;
  assert.deepEqual([into('gas-1').gas, into('gas-1').enabled, into('gas-1').flowSccm], ['Ar', false, 25]);
  assert.deepEqual([into('gas-2').gas, into('gas-2').enabled, into('gas-2').flowSccm], ['N2', true, 40]);
  assert.deepEqual([into('gas-3').enabled, into('gas-3').flowSccm], [false, undefined], 'still off; a flow in slm is never converted');
  const reopened = restoreOk(JSON.stringify(copyLegacyEquipmentToUnit(doc, { kind: 'gas', id: 'gas-1' }, { order: 1 }))).document;
  assert.equal(reopened.steps[0].gases[0].enabled, false);
});

// =====================================================================================
// 4. Quality-check ids are unique
// =====================================================================================

test('4. migrated checks get ids that cannot collide with existing ones, however the existing ids look; every id is unique after restoring and again after reopening', () => {
  const existing = [
    { id: 'qc-migrated-1', parameter: 'Старая 1', method: 'м1' },
    { id: 'qc-migrated-2', parameter: 'Старая 2', method: 'м2' },
    { id: 'qc-1', parameter: 'Старая 3', method: 'м3' },
  ];
  const raw = v3([
    { type: 'quality_control', name: 'Новая A', description: 'a', acceptanceCriteria: '1' },
    { type: 'quality_control', name: 'Новая B', description: 'b', acceptanceCriteria: '2' },
  ], { qualityChecks: existing });
  const doc = assertRoundTrip(raw);
  assert.equal(doc.qualityChecks.length, 5);
  const ids = doc.qualityChecks.map(q => q.id);
  assert.equal(new Set(ids).size, 5, ids.join(','));
  assert.deepEqual(doc.qualityChecks.slice(0, 3).map(q => q.id), ['qc-migrated-1', 'qc-migrated-2', 'qc-1'], 'existing ids keep their value');
  assert.doesNotThrow(() => validateDocument(doc));
});

test('4. repeated / empty / missing ids of checks are repaired on restore: the first owner keeps its id, nothing else changes; editing or deleting one check never touches another', () => {
  const doc0 = restoreOk(readFixture('schema3-rich')).document;
  const raw = json({ ...doc0, qualityChecks: [
    { id: 'dup', parameter: 'Первая', method: 'M1', criterion: 'C1' }, { id: 'dup', parameter: 'Вторая', method: 'M2', criterion: 'C2' },
    { parameter: 'Без id', method: 'M3' }, { id: '', parameter: 'Пустой id', method: 'M4' }, { id: 'qc-1', parameter: 'Явный qc-1', method: 'M5' },
  ] });
  const doc = restoreOk(JSON.stringify(raw)).document;
  assert.equal(doc.qualityChecks.length, 5);
  assert.equal(new Set(doc.qualityChecks.map(q => q.id)).size, 5);
  assert.equal(doc.qualityChecks[0].id, 'dup');
  assert.equal(doc.qualityChecks[4].id, 'qc-1', 'an explicit id is never taken by an id-less record that comes earlier');
  assert.deepEqual(doc.qualityChecks.map(q => [q.parameter, q.method]), [['Первая', 'M1'], ['Вторая', 'M2'], ['Без id', 'M3'], ['Пустой id', 'M4'], ['Явный qc-1', 'M5']], 'no value is altered');
  // the editor addresses checks by id: change one, remove another - the rest is untouched
  const target = doc.qualityChecks[1];
  const edited = doc.qualityChecks.map(x => x.id === target.id ? { ...x, result: 'EDIT' } : x);
  assert.deepEqual(edited.map(q => q.result), [undefined, 'EDIT', undefined, undefined, undefined]);
  assert.deepEqual(doc.qualityChecks.filter(x => x.id !== target.id).map(q => q.parameter), ['Первая', 'Без id', 'Пустой id', 'Явный qc-1']);
  // reopening changes nothing
  assertRoundTrip(JSON.stringify(raw));
  // a document that still has a repeated id (built by hand, bypassing the parser) is refused by validation, so it can never be saved
  assert.throws(() => validateDocument({ ...doc, qualityChecks: [{ id: 'x', parameter: 'a' }, { id: 'x', parameter: 'b' }] }), /повторяется или пуст идентификатор/);
});

// =====================================================================================
// 5. Backups
// =====================================================================================

test('5. a backup is reused only if it is exactly the recipe being migrated; another recipe in the slot is never overwritten and the copy goes to the next free key', () => {
  const original = readFixture('schema3-rich');
  const doc = touchDocument(restoreOk(original).document);
  const storage = new FakeStorage();
  const slot = 'techdoc-assistant:document:backup-schema3';
  storage.data.set(slot, readFixture('schema2')); // a backup of a DIFFERENT recipe of the same schema family
  storage.data.set(KEY, original);
  const outcome = saveDocumentWithBackup(storage, KEY, doc, { fromSchema: 3, originalRaw: original });
  assert.deepEqual(outcome, { status: 'saved', backupWritten: true, backupKey: `${slot}-2` });
  assert.equal(storage.data.get(slot), readFixture('schema2'), 'the older backup is exactly as it was');
  assert.equal(storage.data.get(`${slot}-2`), original, 'the new backup is the recipe that was migrated');
  assert.ok(!storage.log.includes(slot));
  assert.equal(JSON.parse(storage.data.get(KEY)!).schemaVersion, 4);
});

test('5. if reliable backing up is impossible the save is refused and the stored data is untouched: write fails, read-back differs, or every slot is taken by other recipes', () => {
  const original = readFixture('schema3-rich');
  const doc = touchDocument(restoreOk(original).document);
  const slot = 'techdoc-assistant:document:backup-schema3';

  const failing = new FakeStorage();
  failing.data.set(KEY, original); failing.failOn = slot;
  assert.equal(saveDocumentWithBackup(failing, KEY, doc, { fromSchema: 3, originalRaw: original }).status, 'backup_failed');
  assert.equal(failing.data.get(KEY), original);

  const corrupt = new FakeStorage();
  corrupt.data.set(KEY, original); corrupt.corruptReadback = true;
  const outcome = saveDocumentWithBackup(corrupt, KEY, doc, { fromSchema: 3, originalRaw: original });
  assert.equal(outcome.status, 'backup_failed');
  assert.equal(corrupt.data.get(KEY), original, 'the document was not written after a bad backup');
  assert.ok(!corrupt.log.includes(KEY));

  const full = new FakeStorage();
  full.data.set(KEY, original);
  full.data.set(slot, 'other 1');
  for (let i = 2; i <= 50; i++) full.data.set(`${slot}-${i}`, `other ${i}`);
  const noSlot = saveDocumentWithBackup(full, KEY, doc, { fromSchema: 3, originalRaw: original });
  assert.equal(noSlot.status, 'backup_failed');
  assert.equal(full.data.get(KEY), original);
  assert.ok([...full.data.entries()].every(([k, v]) => k === KEY || v.startsWith('other')), 'no existing backup was overwritten');
});

// =====================================================================================
// 6. Provenance of a layer duration
// =====================================================================================

const calcNote = (doc: TechnicalProcessDocument) => buildDocumentViewModel(doc, 'instruction').traceability.calculatedFieldsNote;

test('6. the "calculated" mark of an old coating step moves to the duration of its layer; the card itself carries no mark', () => {
  const doc = assertRoundTrip(v3([{ type: 'multilayer_coating', name: 'Покрытие', durationMin: 100, temperatureC: 400, calculatedFields: ['durationMin'] }]));
  assert.deepEqual(doc.steps[0].calculatedFields, []);
  assert.deepEqual(doc.steps[0].layers[0].calculatedFields, ['durationMin']);
  assert.equal(doc.steps[0].layers[0].durationMin, 100);
  assert.equal(calcNote(doc), 'Вычислено системой: №1, слой 1 (durationMin)');
  // the old "main coating" (single layer) behaves the same
  const main = restoreOk(v3([{ type: 'main_coating', name: 'Основное', durationMin: 60, calculatedFields: ['durationMin'] }])).document;
  assert.deepEqual([main.steps[0].coatingMode, main.steps[0].layers[0].calculatedFields], ['single', ['durationMin']]);
  // a card with its own duration keeps the mark on the card
  const adhesion = restoreOk(v3([{ type: 'adhesion_underlayer', durationMin: 100, calculatedFields: ['durationMin'] }])).document;
  assert.deepEqual([adhesion.steps[0].calculatedFields, adhesion.steps[0].layers], [['durationMin'], []]);
});

test('6. editing the layer duration by hand removes the mark: 7 typed minutes are never exported as "calculated by the system" (DOCX and PDF)', async () => {
  let doc = restoreOk(v3([{ type: 'multilayer_coating', name: 'Покрытие', durationMin: 100, calculatedFields: ['durationMin'] }])).document;
  assert.ok(calcNote(doc).includes('слой 1 (durationMin)'));
  doc = { ...doc, steps: updateLayer(doc.steps, 1, doc.steps[0].layers[0].id, { durationMin: 7 }) };
  assert.equal(doc.steps[0].layers[0].durationMin, 7);
  assert.deepEqual(doc.steps[0].layers[0].calculatedFields, []);
  assert.equal(calcNote(doc), 'Полей, вычисленных системой, нет.');
  for (const type of ['instruction', 'technologicalCard', 'routeCard', 'recipe'] as const) {
    assert.equal(buildDocumentViewModel(doc, type).traceability.calculatedFieldsNote, 'Полей, вычисленных системой, нет.', type);
  }
  const { buffer } = await exportTechDoc(doc, 'instruction', 'docx');
  assert.ok(!(await import('./helpers/zip-reader')).readZipEntryText(buffer, 'word/document.xml').includes('Вычислено системой'));
  // editing ANOTHER field of the layer keeps the mark of the duration; the stamp survives a save/reopen and a copy of the card
  let marked = restoreOk(v3([{ type: 'multilayer_coating', name: 'П', durationMin: 100, calculatedFields: ['durationMin'] }])).document;
  marked = { ...marked, steps: updateLayer(marked.steps, 1, marked.steps[0].layers[0].id, { temperatureC: 350 }) };
  assert.deepEqual(marked.steps[0].layers[0].calculatedFields, ['durationMin']);
  const reopened = restoreOk(JSON.stringify(marked)).document;
  assert.deepEqual(reopened.steps[0].layers[0].calculatedFields, ['durationMin']);
  const copied = duplicateStep(reopened.steps, 1);
  const edited = updateLayer(copied, 2, copied[1].layers[0].id, { durationMin: 9 });
  assert.deepEqual(edited[0].layers[0].calculatedFields, ['durationMin'], 'editing the copy leaves the original\'s mark');
  assert.deepEqual(edited[1].layers[0].calculatedFields, []);
});

test('6. an old step with a typed (not calculated) duration of 7 minutes is never marked as calculated', () => {
  const doc = assertRoundTrip(v3([{ type: 'multilayer_coating', name: 'П', durationMin: 7, calculatedFields: [] }]));
  assert.equal(calcNote(doc), 'Полей, вычисленных системой, нет.');
  const none = restoreOk(v3([{ type: 'loading', name: 'Загрузка', temperatureC: 5, calculatedFields: ['temperatureC'] }])).document;
  assert.deepEqual(none.steps[0].calculatedFields, [], 'a mark whose value went to legacy data is not carried: nothing claims it');
});
