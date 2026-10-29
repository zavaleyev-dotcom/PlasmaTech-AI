import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import {
  restoreDocumentDetailed, tryRestoreDocument, validateDocument, touchDocument, stepUnits, buildInstructionView, buildTechnologicalCard, buildRouteCard, buildBriefRecipe,
  moveLegacyFieldToDescription, restoreLegacyField, removeLegacyField, restoreLegacyStep, removeLegacyStep, copyLegacyEquipmentToUnit, clearLegacyEquipment,
  saveDocumentWithBackup, backupKeyFor, hasLegacyData, buildLegacyLines, createQualityCheck,
  type TechnicalProcessDocument, type KeyValueStorage,
} from '../src/services/workspace/techdoc-assistant';
import { describeMigration } from '../src/services/workspace/techdoc-migrate';
import { buildDocumentViewModel, exportTechDoc } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

const FIXTURES = new URL('./fixtures/techdoc/', import.meta.url).pathname;
const readFixture = (name: string) => readFileSync(`${FIXTURES}${name}.json`, 'utf8');
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const restoreOk = (raw: string) => {
  const result = restoreDocumentDetailed(raw);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
};
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const byType = (doc: TechnicalProcessDocument, type: string) => doc.steps.filter(s => s.type === type);
const legacyFieldsOf = (doc: TechnicalProcessDocument, stepId: string) => Object.fromEntries((doc.legacy.stepFields.find(e => e.stepId === stepId)?.fields ?? []).map(f => [f.key, f.value]));

/** A document of schema 3 in the old shape, built by hand - one step per old type is not needed here, the files carry the rich case. */
function v3(steps: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 3, pressureUnit: 'pa', general: { processName: 'Old' }, initialData: {}, qualityChecks: [], safety: { hazards: [], ppe: [], interlocks: [] },
    sources: { magnetrons: [], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } }, gasSystem: [],
    traceability: { version: 4, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z', source: 'blank' },
    steps: steps.map((s, i) => ({ order: i + 1, name: `Этап ${i + 1}`, enabled: true, gasUsage: [], sourceAssignments: [], gasAssignments: [], origin: 'user', calculatedFields: [], ...s })), ...extra,
  });
}

// =====================================================================================
// The rich schema-3 recipe (every old step type, registry, assignments, quality step)
// =====================================================================================

test('schema 3 -> 4: the rich recipe opens, validates, is flagged as migrated and carries the eight card types only', () => {
  const result = restoreOk(readFixture('schema3-rich'));
  assert.equal(result.migratedFromSchema, 3);
  assert.equal(result.document.schemaVersion, 4);
  assert.deepEqual(result.document.steps.map(s => s.type), ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'multilayer_coating', 'cooling', 'unloading']);
  assert.deepEqual(result.document.steps.map(s => s.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.doesNotThrow(() => validateDocument(result.document));
  assert.ok(!('sources' in result.document) && !('gasSystem' in result.document));
  assert.equal(result.document.legacy.migratedFromSchema, 3);
});

test('schema 3 -> 4: the assignments become sources and gas lines INSIDE the cards, with the material/gas copied from the old registry and the step-specific values kept', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const adhesion = byType(doc, 'adhesion_underlayer')[0];
  assert.deepEqual(json(adhesion.sources), [{ id: 'magnetron-2', kind: 'magnetron', enabled: true, material: 'Cr', operatingMode: 'HiPIMS', powerW: 2000, startMin: 0, durationMin: 10, mode: 'parallel' }]);
  assert.deepEqual(json(adhesion.gases), [{ id: 'gas-1', enabled: true, gas: 'Ar', flowSccm: 35, startMin: 0, durationMin: 10 }]);
  assert.equal(adhesion.durationMin, 10);
  assert.equal(adhesion.temperatureC, 400);
  assert.equal(adhesion.pressurePa, 0.4);
  assert.equal(adhesion.substrateBiasV, -100);
  assert.equal(adhesion.rotationRpm, 4);
  assert.equal(adhesion.distanceMm, 150);
  // the old multilayer step: sources of two kinds, SEQUENTIAL mode kept, in one (first) layer
  const multi = doc.steps.find(s => s.name === 'Многослойное покрытие')!;
  assert.equal(multi.coatingMode, 'multi', 'an old multilayer step stays multilayer');
  assert.equal(multi.layers.length, 1);
  assert.deepEqual(json(multi.layers[0].sources), [
    { id: 'magnetron-1', kind: 'magnetron', enabled: true, material: 'Ti', operatingMode: 'DC', powerW: 3000, startMin: 0, durationMin: 45, mode: 'sequential' },
    { id: 'arc-1', kind: 'arc', enabled: true, material: 'TiAl', filtered: true, currentA: 85, startMin: 45, durationMin: 45, mode: 'sequential' },
  ]);
  assert.equal(multi.layers[0].durationMin, 90);
  assert.equal(multi.layers[0].temperatureC, 430);
  assert.equal(multi.layers[0].pressurePa, 0.5);
  assert.equal(multi.layers[0].substrateBiasV, -60);
});

test('schema 3 -> 4: the old general gas list becomes real gas lines only where the card has gas lines and the step had no gas assignments', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const cooling = byType(doc, 'cooling')[0];
  assert.deepEqual(json(cooling.gases), [{ id: 'gas-1', enabled: true, gas: 'N2', flowSccm: 200 }], 'cooling: the general list is now a gas line');
  const cleaning = byType(doc, 'plasma_ion_cleaning')[0];
  assert.deepEqual(json(cleaning.gases), [{ id: 'gas-1', enabled: true, gas: 'Ar', flowSccm: 60 }]);
  const heating = byType(doc, 'heating')[0];
  assert.deepEqual(heating.gases, [], 'the heating card has no gas lines');
  assert.deepEqual(legacyFieldsOf(doc, heating.id).gasUsage, [{ gas: 'Ar', flowSccm: 20 }], 'so its old general list is kept as legacy data, not dropped');
});

test('schema 3 -> 4 does NOT guess: a single old pressure/temperature is never put into "start" or "end"; it stays as legacy data, exact, until the user moves it', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const pumpdown = byType(doc, 'pumpdown')[0];
  assert.equal(pumpdown.pressureStartPa, undefined);
  assert.equal(pumpdown.pressureEndPa, undefined);
  assert.equal(legacyFieldsOf(doc, pumpdown.id).pressurePa, 0.002);
  assert.equal(pumpdown.rotationRpm, 4, 'rotation has the same name and place: it is carried over');
  const heating = byType(doc, 'heating')[0];
  assert.equal(heating.temperatureStartC, undefined);
  assert.equal(heating.temperatureEndC, undefined);
  assert.equal(legacyFieldsOf(doc, heating.id).temperatureC, 350);
  assert.equal(legacyFieldsOf(doc, heating.id).pressurePa, 0.5);
  const loading = byType(doc, 'loading')[0];
  assert.equal(loading.durationMin, 15);
  assert.equal(legacyFieldsOf(doc, loading.id).temperatureC, 25, 'the loading card has no temperature: kept');
});

test('schema 3 -> 4: the removed fields (acceptance criterion, note, general source / power / current, source text) are kept as legacy data of the step, never lost and never in the card', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const pumpdown = byType(doc, 'pumpdown')[0];
  assert.equal(legacyFieldsOf(doc, pumpdown.id).acceptanceCriteria, 'до 2e-3 Па');
  assert.equal(legacyFieldsOf(doc, pumpdown.id).notes, 'не менее 30 мин');
  const heating = byType(doc, 'heating')[0];
  assert.equal(legacyFieldsOf(doc, heating.id).powerW, 5000);
  const cleaning = byType(doc, 'plasma_ion_cleaning')[0];
  assert.equal(legacyFieldsOf(doc, cleaning.id).sourceConfiguration, 'ионный источник');
  assert.equal(legacyFieldsOf(doc, cleaning.id).currentA, 0.2);
  for (const step of doc.steps) assert.ok(!('acceptanceCriteria' in step) && !('notes' in step) && !('powerW' in step));
  assert.equal(cleaning.description, 'Очистка ионами Ar', 'the description is carried over');
});

test('schema 3 -> 4: old step types without a card (surface preparation, etching, custom) and the old "main coating" are handled without deleting a non-empty step', () => {
  const result = restoreOk(readFixture('schema3-rich'));
  const doc = result.document;
  assert.deepEqual(doc.legacy.steps.map(s => [s.name, s.originalType, s.originalOrder]), [['Подготовка (спец.)', 'surface_preparation', 5], ['Травление', 'etching', 9], ['Контроль толщины', 'quality_control', 12]]);
  const prep = doc.legacy.steps[0];
  assert.deepEqual(Object.fromEntries(prep.fields.map(f => [f.key, f.value])), { description: 'Обезжиривание', durationMin: 5, notes: 'ультразвук' });
  // main coating -> the coating card in single-layer mode with ONE layer holding its values
  const main = doc.steps.find(s => s.name === 'Основное покрытие TiN')!;
  assert.equal(main.type, 'multilayer_coating');
  assert.equal(main.coatingMode, 'single');
  assert.equal(main.layers.length, 1);
  assert.deepEqual([main.layers[0].durationMin, main.layers[0].temperatureC, main.layers[0].pressurePa, main.layers[0].substrateBiasV], [60, 420, 0.6, -80]);
  assert.deepEqual(main.layers[0].gases.map(g => `${g.gas}:${g.flowSccm}`), ['Ar:40', 'N2:15']);
  assert.equal(main.layers[0].sources[0].material, 'Ti');
  assert.deepEqual(result.migration!.remappedTypes.map(r => [r.name, r.from, r.to]), [['Основное покрытие TiN', 'main_coating', 'multilayer_coating']]);
  assert.equal(result.migration!.emptyStepsDropped, 1, 'the only completely empty step (an untouched "custom") is not kept - and is reported');
});

test('schema 3 -> 4: a quality-control step becomes a check in section D once - no duplicate of a check that already exists - and what the check cannot hold stays as a legacy step', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  assert.deepEqual(doc.qualityChecks.map(q => [q.parameter, q.method, q.criterion]), [
    ['Адгезия', 'Роквелл C', 'HF1-HF2'],
    ['Контроль толщины', 'Калотест, 3 точки\nПримечание: после остывания', '2.5–3.5 мкм'],
  ]);
  const residual = doc.legacy.steps.find(s => s.originalType === 'quality_control')!;
  assert.deepEqual(residual.fields.map(f => f.key), ['durationMin'], 'only the duration - the text is in section D, not repeated here');
  // running it again over the migrated document creates nothing new
  const again = restoreOk(JSON.stringify(doc));
  assert.equal(again.migration, undefined);
  assert.equal(again.document.qualityChecks.length, 2);

  // the same check typed twice (old step + a check with the same text) is not duplicated
  const raw = v3([{ type: 'quality_control', name: 'Адгезия', description: 'Роквелл C', acceptanceCriteria: 'HF1-HF2' }], { qualityChecks: [{ id: 'qc-1', parameter: 'адгезия', method: ' Роквелл  C ', criterion: 'HF1-HF2' }] });
  const result = restoreOk(raw);
  assert.equal(result.document.qualityChecks.length, 1);
  assert.equal(result.migration!.qualityChecksSkippedAsDuplicate, 1);
  assert.equal(result.migration!.qualityChecksCreated, 0);
  assert.deepEqual(result.document.legacy.steps, [], 'nothing was left over, so no legacy step');
  assert.equal(result.document.steps.length, 0);
});

test('schema 3 -> 4: the old equipment registry is kept as legacy data - unused items and nominal values included - and is not part of any card', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const eq = doc.legacy.equipment!;
  assert.deepEqual(eq.magnetrons.map(m => [m.id, m.material, m.powerW]), [['magnetron-1', 'Ti', 3000], ['magnetron-2', 'Cr', 2500], ['magnetron-3', 'Zr', undefined]], 'magnetron-1/2 keep their NOMINAL power; magnetron-3 was never used');
  assert.deepEqual(eq.arcSources.map(a => [a.id, a.cathodeMaterial, a.arcCurrentA]), [['arc-1', 'TiAl', 90]]);
  assert.deepEqual([eq.icpRf.enabled, eq.icpRf.powerW, eq.icpRf.biasV], [true, 600, -50]);
  assert.deepEqual([eq.ionSource.enabled, eq.ionSource.voltageV, eq.ionSource.currentA, eq.ionSource.powerW], [true, 1500, 0.2, 300]);
  assert.ok(eq.gasLines.some(l => l.id === 'gas-9' && l.gas === 'He' && l.flow === 12 && l.unit === 'slm'), 'a line kept in slm is preserved as it was');
  assert.ok(!eq.gasLines.some(l => l.gas === '' && !l.enabled), 'untouched default lines are not worth keeping');
});

test('schema 3 -> 4: every number and every text of the old recipe is somewhere in the new document - in a card, in section D, or in the legacy data', () => {
  const old = JSON.parse(readFixture('schema3-rich'));
  const everything = JSON.stringify(restoreOk(readFixture('schema3-rich')).document);
  const skip = new Set(['id', 'order', 'schemaVersion', 'origin', 'createdAt', 'updatedAt', 'version', 'source', 'enabled', 'mode', 'unit', 'calculatedFields', 'pressureUnit', 'kind', 'sourceId', 'lineId', 'name', 'filtered', 'type', 'processName', 'hazards', 'ppe', 'interlocks']);
  const missing: string[] = [];
  const walk = (value: unknown, key = '') => {
    if (Array.isArray(value)) value.forEach(v => walk(v, key));
    else if (value !== null && typeof value === 'object') Object.entries(value as Record<string, unknown>).forEach(([k, v]) => { if (!skip.has(k)) walk(v, k); });
    else if (typeof value === 'number' || (typeof value === 'string' && value !== '')) { if (!everything.includes(typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : JSON.stringify(value))) missing.push(`${key}=${String(value)}`); }
  };
  walk({ steps: old.steps, sources: old.sources, gasSystem: old.gasSystem, qualityChecks: old.qualityChecks, general: old.general, initialData: old.initialData });
  assert.deepEqual(missing, []);
});

test('schema 3 -> 4: the migration report says what was done in plain language; the saved text is not touched by restoring', () => {
  const raw = readFixture('schema3-rich');
  const before = raw.slice();
  const result = restoreOk(raw);
  const lines = describeMigration(result.migration!);
  assert.ok(lines[0].includes('только в памяти') && lines[0].includes('схеме 3'));
  assert.ok(lines.some(l => l.includes('Перенесено в карточки: источников — 4, газовых линий — 5')));
  assert.ok(lines.some(l => l.includes('«Основное покрытие TiN» (прежний тип «Основное покрытие») стал карточкой «Многослойное покрытие» в однослойном режиме')));
  assert.ok(lines.some(l => l.includes('создано проверок в разделе D: 1')));
  assert.ok(lines.some(l => l.includes('Прежний справочник оборудования')));
  assert.equal(raw, before);
});

test('schemas 1 and 2 go through the same migration: pressure converted exactly once (mbar -> Pa), every other value placed or kept', () => {
  const s3 = restoreOk(readFixture('schema3-rich')).document;
  const s2 = restoreOk(readFixture('schema2'));
  const s1 = restoreOk(readFixture('schema1'));
  assert.equal(s2.migratedFromSchema, 2);
  assert.equal(s1.migratedFromSchema, 1);
  for (const result of [s1, s2]) {
    assert.deepEqual(result.document.steps.map(s => [s.type, s.name]), s3.steps.map(s => [s.type, s.name]));
    assert.deepEqual(result.document.steps.map(s => s.pressurePa), s3.steps.map(s => s.pressurePa), 'the same pressures as the schema-3 document');
    assert.deepEqual(result.document.steps.map(s => s.durationMin), s3.steps.map(s => s.durationMin));
    assert.deepEqual(result.document.qualityChecks.map(q => q.parameter), s3.qualityChecks.map(q => q.parameter));
    assert.doesNotThrow(() => validateDocument(result.document));
  }
  assert.equal(byType(s1.document, 'adhesion_underlayer')[0].pressurePa, 0.4, '0.004 mbar -> 0.4 Pa');
  // schemas 1 and 2 had no assignments: their registry is kept whole, and the steps have no sources
  assert.deepEqual(byType(s1.document, 'adhesion_underlayer')[0].sources, []);
  assert.equal(s1.document.legacy.equipment!.magnetrons.length, 3);
});

// =====================================================================================
// Corner cases
// =====================================================================================

test('a dangling reference (an assignment of a source that is not in the registry) is kept as a source without material and reported; it is not dropped', () => {
  const raw = v3([{ type: 'adhesion_underlayer', durationMin: 10, sourceAssignments: [{ sourceId: 'magnetron-7', kind: 'magnetron', enabled: true, powerW: 500, startMin: 0, durationMin: 10, mode: 'parallel' }], gasAssignments: [{ lineId: 'gas-9', enabled: true, flowSccm: 5 }] }]);
  const result = restoreOk(raw);
  const adhesion = result.document.steps[0];
  assert.deepEqual([adhesion.sources[0].id, adhesion.sources[0].material, adhesion.sources[0].powerW], ['magnetron-7', undefined, 500]);
  assert.deepEqual([adhesion.gases[0].id, adhesion.gases[0].gas, adhesion.gases[0].flowSccm], ['gas-9', '', 5]);
  assert.equal(result.migration!.danglingReferences.length, 2);
  assert.ok(describeMigration(result.migration!).some(l => l.includes('отсутствовал в старом справочнике')));
});

test('an assignment that points at an id shared by two registry records is REFUSED with a diagnosis - never a guess - and nothing is loaded', () => {
  const raw = v3([{ type: 'adhesion_underlayer', sourceAssignments: [{ sourceId: 'magnetron-1', kind: 'magnetron', enabled: true, mode: 'parallel' }] }],
    { sources: { magnetrons: [{ id: 'magnetron-1', enabled: true, material: 'Ti' }, { id: 'magnetron-1', enabled: true, material: 'Al' }], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } } });
  const result = restoreDocumentDetailed(raw);
  assert.equal(result.status, 'invalid');
  assert.match(result.status === 'invalid' ? result.reason ?? '' : '', /Ti \/ Al/);
  assert.equal(tryRestoreDocument(raw), null);
  // the same duplicate NOT referenced by any step is harmless: the first record keeps the id, the legacy snapshot gets a unique id for the second
  const unreferenced = restoreOk(v3([{ type: 'loading' }], { sources: { magnetrons: [{ id: 'magnetron-1', enabled: true, material: 'Ti' }, { id: 'magnetron-1', enabled: true, material: 'Al' }], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } } }));
  assert.deepEqual(unreferenced.document.legacy.equipment!.magnetrons.map(m => `${m.material}:${m.id}`), ['Ti:magnetron-1', 'Al:magnetron-2']);
});

test('id-less registry records get ids AFTER explicit ones are reserved (an explicit id is never taken by another record)', () => {
  const raw = v3([{ type: 'adhesion_underlayer', gasAssignments: [{ lineId: 'gas-0', enabled: true, flowSccm: 1 }] }],
    { gasSystem: [{ gas: 'Ar', unit: 'sccm', enabled: true }, { id: 'gas-0', gas: 'N2', unit: 'sccm', enabled: true }] });
  const result = restoreOk(raw);
  assert.equal(result.document.steps[0].gases[0].gas, 'N2', 'the assignment of "gas-0" stays on the line that explicitly owns that id');
});

test('an old step with only a name and nothing else of a card type is migrated, not dropped; an old document with no steps migrates to an empty process', () => {
  const result = restoreOk(v3([{ type: 'cooling', name: 'Остывание' }]));
  assert.deepEqual(result.document.steps.map(s => [s.type, s.name]), [['cooling', 'Остывание']]);
  assert.deepEqual(result.document.legacy.stepFields, []);
  const empty = restoreOk(v3([]));
  assert.deepEqual(empty.document.steps, []);
  assert.equal(hasLegacyData(empty.document.legacy), false);
});

test('a disabled old step stays disabled; calculated-field marks survive on fields that still exist; custom step names are kept', () => {
  const result = restoreOk(v3([{ type: 'adhesion_underlayer', name: 'Мой подслой', enabled: false, durationMin: 100, calculatedFields: ['durationMin'] }]));
  assert.deepEqual([result.document.steps[0].enabled, result.document.steps[0].name, result.document.steps[0].calculatedFields], [false, 'Мой подслой', ['durationMin']]);
});

test('migrating twice changes nothing: a migrated document saved and restored again is a plain schema-4 document with identical content', () => {
  const first = restoreOk(readFixture('schema3-rich')).document;
  const second = restoreOk(JSON.stringify(touchDocument(first)));
  assert.equal(second.migration, undefined);
  assert.deepEqual(json({ ...second.document, traceability: undefined }), json({ ...first, traceability: undefined }));
});

test('hostile / oversized legacy data is bounded: a deeply nested or huge legacy value is rejected, never processed unbounded', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const deep: unknown = Array.from({ length: 20 }).reduce<unknown>(acc => [acc], 'x');
  const bad = json({ ...doc, legacy: { ...doc.legacy, stepFields: [{ stepId: 'step-1', stepName: 'x', fields: [{ key: 'k', label: 'k', value: deep }] }] } });
  assert.equal(restoreDocumentDetailed(JSON.stringify(bad)).status, 'invalid');
  const long = json({ ...doc, legacy: { ...doc.legacy, stepFields: [{ stepId: 'step-1', stepName: 'x', fields: [{ key: 'k', label: 'k', value: 'a'.repeat(6000) }] }] } });
  assert.equal(restoreDocumentDetailed(JSON.stringify(long)).status, 'invalid');
});

// =====================================================================================
// Legacy data: view and restore
// =====================================================================================

test('legacy field -> description: appended with its label, removed from the legacy data, the card is marked as edited by the user', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const pumpdown = byType(doc, 'pumpdown')[0];
  const next = moveLegacyFieldToDescription(doc, pumpdown.id, 'notes');
  assert.equal(byType(next, 'pumpdown')[0].description, 'Примечание: не менее 30 мин');
  assert.equal(legacyFieldsOf(next, pumpdown.id).notes, undefined);
  assert.equal(legacyFieldsOf(next, pumpdown.id).acceptanceCriteria, 'до 2e-3 Па', 'the other legacy fields are untouched');
  const twice = moveLegacyFieldToDescription(next, pumpdown.id, 'acceptanceCriteria');
  assert.equal(byType(twice, 'pumpdown')[0].description, 'Примечание: не менее 30 мин\nКритерий приёмки: до 2e-3 Па', 'an existing description is extended, never replaced');
  assert.throws(() => moveLegacyFieldToDescription(twice, pumpdown.id, 'notes'), /не найдено/);
});

test('legacy field -> card field: allowed only into a field the card has, that is still empty, and of the right type; nothing is overwritten', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const pumpdown = byType(doc, 'pumpdown')[0];
  const moved = restoreLegacyField(doc, pumpdown.id, 'pressurePa', 'pressureEndPa');
  assert.equal(byType(moved, 'pumpdown')[0].pressureEndPa, 0.002);
  assert.equal(legacyFieldsOf(moved, pumpdown.id).pressurePa, undefined);
  assert.throws(() => restoreLegacyField(doc, pumpdown.id, 'notes', 'pressureStartPa'), /не подходит/, 'text into a number field');
  assert.throws(() => restoreLegacyField(doc, pumpdown.id, 'pressurePa', 'temperatureC'), /нет поля/, 'the card has no such field');
  const filled = { ...doc, steps: doc.steps.map(s => s.id === pumpdown.id ? { ...s, pressureStartPa: 5 } : s) };
  assert.throws(() => restoreLegacyField(filled, pumpdown.id, 'pressurePa', 'pressureStartPa'), /уже заполнено/);
  assert.equal(byType(filled, 'pumpdown')[0].pressureStartPa, 5);
  const removed = removeLegacyField(doc, pumpdown.id, 'notes');
  assert.equal(legacyFieldsOf(removed, pumpdown.id).notes, undefined);
  assert.equal(removeLegacyField(removeLegacyField(removed, pumpdown.id, 'pressurePa'), pumpdown.id, 'acceptanceCriteria').legacy.stepFields.some(e => e.stepId === pumpdown.id), false, 'an entry without fields disappears');
});

test('legacy step -> card: it returns as a card of the chosen type at the end of the process; its values go to the fields of that card and the rest stays legacy', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const etching = doc.legacy.steps.find(s => s.name === 'Травление')!;
  const restored = restoreLegacyStep(doc, etching.id, 'plasma_ion_cleaning');
  const card = restored.steps[restored.steps.length - 1];
  assert.deepEqual([card.type, card.name, card.order, card.durationMin, card.description], ['plasma_ion_cleaning', 'Травление', doc.steps.length + 1, 12, 'Травление']);
  assert.ok(!restored.legacy.steps.some(s => s.id === etching.id));
  assert.doesNotThrow(() => validateDocument(restored));
  const prep = doc.legacy.steps.find(s => s.name === 'Подготовка (спец.)')!;
  const asLoading = restoreLegacyStep(doc, prep.id, 'loading');
  const loading = asLoading.steps[asLoading.steps.length - 1];
  assert.equal(loading.durationMin, 5);
  assert.equal(legacyFieldsOf(asLoading, loading.id).notes, 'ультразвук', 'a value without a place stays with the new card');
  // into the coating card the values go to its single layer
  const asCoating = restoreLegacyStep(doc, prep.id, 'multilayer_coating');
  const coating = asCoating.steps[asCoating.steps.length - 1];
  assert.deepEqual([coating.coatingMode, coating.layers.length, coating.layers[0].durationMin, coating.description], ['single', 1, 5, 'Обезжиривание']);
  assert.equal(removeLegacyStep(doc, prep.id).legacy.steps.length, doc.legacy.steps.length - 1);
  assert.throws(() => restoreLegacyStep(doc, 'legacy-step-99', 'loading'), /не найден/);
});

test('legacy equipment -> card: a COPY becomes a new source / gas line of the chosen card or layer; the record stays; a flow in slm is not converted', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const adhesion = byType(doc, 'adhesion_underlayer')[0];
  let next = copyLegacyEquipmentToUnit(doc, { kind: 'magnetron', id: 'magnetron-3' }, { order: adhesion.order });
  next = copyLegacyEquipmentToUnit(next, { kind: 'arc', id: 'arc-1' }, { order: adhesion.order });
  next = copyLegacyEquipmentToUnit(next, { kind: 'icp_rf' }, { order: adhesion.order });
  next = copyLegacyEquipmentToUnit(next, { kind: 'ion' }, { order: adhesion.order });
  next = copyLegacyEquipmentToUnit(next, { kind: 'gas', id: 'gas-9' }, { order: adhesion.order });
  next = copyLegacyEquipmentToUnit(next, { kind: 'gas', id: 'gas-1' }, { order: adhesion.order });
  const added = byType(next, 'adhesion_underlayer')[0];
  assert.deepEqual(added.sources.slice(1).map(s => [s.id, s.kind, s.material, s.currentA, s.powerW, s.voltageV, s.biasV]), [
    ['magnetron-3', 'magnetron', 'Zr', undefined, undefined, undefined, undefined],
    ['arc-1', 'arc', 'TiAl', 90, undefined, undefined, undefined],
    ['icp-1', 'icp_rf', undefined, undefined, 600, undefined, -50],
    ['ion-1', 'ion', undefined, 0.2, 300, 1500, undefined],
  ]);
  const gases = added.gases.slice(1);
  assert.deepEqual(gases.map(g => [g.gas, g.flowSccm]), [['He', undefined], ['Ar', 40]], 'He was kept in slm: the line is copied WITHOUT a flow, nothing is converted to sccm');
  assert.equal(next.legacy.equipment!.magnetrons.length, 3, 'the legacy record stays');
  assert.throws(() => copyLegacyEquipmentToUnit(doc, { kind: 'magnetron', id: 'magnetron-3' }, { order: byType(doc, 'loading')[0].order }), /нет источников/);
  assert.equal(clearLegacyEquipment(doc).legacy.equipment, undefined);
  // into a layer
  const layered = { ...doc, steps: doc.steps.map(s => s.name === 'Многослойное покрытие' ? s : s) };
  const multi = layered.steps.find(s => s.name === 'Многослойное покрытие')!;
  const intoLayer = copyLegacyEquipmentToUnit(layered, { kind: 'magnetron', id: 'magnetron-3' }, { order: multi.order, layerId: multi.layers[0].id });
  assert.equal(intoLayer.steps.find(s => s.id === multi.id)!.layers[0].sources.length, 3);
  assert.ok(stepUnits(multi).length === 1);
});

test('legacy data is shown in a separate appendix of the instruction and is NEVER part of the process tables, the route card or the recipe', async () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const lines = buildLegacyLines(doc);
  assert.ok(lines.length > 5);
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('## Данные прежней версии (не входят в технологический режим)'));
  for (const marker of ['Критерий приёмки — до 2e-3 Па', 'ультразвук', 'Прежний справочник: магнетрон magnetron-3', 'Этап прежней версии «Травление»']) assert.ok(instruction.includes(marker), marker);
  // the printed instruction: the appendix is the LAST section, after the safety section
  const vm = buildDocumentViewModel(doc, 'instruction');
  assert.equal(vm.sections[vm.sections.length - 1].heading, 'Данные прежней версии (не входят в технологический режим)');
  assert.ok(vm.sections.slice(0, -1).every(s => !s.paragraphs.join('\n').includes('до 2e-3 Па')), 'not mixed into the process sections');
  // the process documents do not contain any legacy value, only a one-line pointer
  for (const type of ['technologicalCard', 'routeCard', 'recipe'] as const) {
    const other = buildDocumentViewModel(doc, type);
    const everything = JSON.stringify([other.tables]) + (type === 'recipe' ? other.sections[0].paragraphs.join('\n') : '');
    for (const secret of ['до 2e-3 Па', 'ультразвук', 'Zr', 'Травление']) assert.ok(!everything.includes(secret), `${type}: ${secret}`);
    assert.ok(other.sections.some(s => s.heading === 'Данные прежней версии'), `${type}: the pointer note`);
  }
  assert.ok(!buildBriefRecipe(doc).includes('ультразвук') && !JSON.stringify(buildTechnologicalCard(doc)).includes('ультразвук') && !JSON.stringify(buildRouteCard(doc)).includes('ультразвук'));
  // DOCX of the instruction carries the appendix
  const text = docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer);
  assert.ok(text.includes('Данные прежней версии (не входят в технологический режим)') && text.includes('до 2e-3 Па'));
  const cardText = docxPlain((await exportTechDoc(doc, 'technologicalCard', 'docx')).buffer);
  assert.ok(!cardText.includes('до 2e-3 Па') && cardText.includes('Документ содержит данные прежней версии'));
  const pdf = new PDFParse({ data: (await exportTechDoc(doc, 'instruction', 'pdf')).buffer });
  const pdfText = (await pdf.getText()).text; await pdf.destroy();
  assert.ok(pdfText.replace(/\s+/g, ' ').includes('Данные прежней версии (не входят в технологический режим)'));
});

test('a document without legacy data prints no appendix and no pointer note', () => {
  const clean = { ...restoreOk(readFixture('schema3-rich')).document, legacy: { stepFields: [], steps: [] } };
  assert.ok(!buildInstructionView(clean).includes('Данные прежней версии'));
  for (const type of ['technologicalCard', 'routeCard', 'recipe', 'instruction'] as const) assert.ok(!buildDocumentViewModel(clean, type).sections.some(s => s.heading.startsWith('Данные прежней версии')), type);
});

// =====================================================================================
// Backup before the first save of a migrated document
// =====================================================================================

class FakeStorage implements KeyValueStorage {
  data = new Map<string, string>();
  failOn: string | undefined;
  log: string[] = [];
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.log.push(key); if (key === this.failOn) throw new Error('quota exceeded'); this.data.set(key, value); }
}
const KEY = 'techdoc-assistant:document';

test('backup: the first save of a migrated document first copies the OLD stored text, byte for byte, under a separate key - then writes the new version', () => {
  const storage = new FakeStorage();
  const original = readFixture('schema3-rich');
  storage.data.set(KEY, original);
  const doc = touchDocument(restoreOk(original).document);
  const outcome = saveDocumentWithBackup(storage, KEY, doc, { fromSchema: 3, originalRaw: original });
  assert.deepEqual(outcome, { status: 'saved', backupWritten: true, backupKey: 'techdoc-assistant:document:backup-schema3' });
  assert.equal(backupKeyFor(KEY, 3), 'techdoc-assistant:document:backup-schema3');
  assert.equal(storage.data.get('techdoc-assistant:document:backup-schema3'), original, 'the backup is the old text itself');
  assert.deepEqual(storage.log, ['techdoc-assistant:document:backup-schema3', KEY], 'the backup is written BEFORE the document');
  assert.equal(JSON.parse(storage.data.get(KEY)!).schemaVersion, 4);
});

test('backup: an existing backup of the SAME text is reused; a backup holding a DIFFERENT recipe is never overwritten - the copy goes under the next free key', () => {
  const storage = new FakeStorage();
  const original = readFixture('schema3-rich');
  storage.data.set('techdoc-assistant:document:backup-schema3', original);
  const doc = touchDocument(restoreOk(original).document);
  assert.deepEqual(saveDocumentWithBackup(storage, KEY, doc, { fromSchema: 3, originalRaw: original }), { status: 'saved', backupWritten: false, backupKey: 'techdoc-assistant:document:backup-schema3' });
  assert.ok(!storage.log.includes('techdoc-assistant:document:backup-schema3'), 'an identical backup is not even written to');
  // another recipe sits in the first backup slot
  const other = new FakeStorage();
  other.data.set('techdoc-assistant:document:backup-schema3', 'ANOTHER RECIPE');
  assert.deepEqual(saveDocumentWithBackup(other, KEY, doc, { fromSchema: 3, originalRaw: original }), { status: 'saved', backupWritten: true, backupKey: 'techdoc-assistant:document:backup-schema3-2' });
  assert.equal(other.data.get('techdoc-assistant:document:backup-schema3'), 'ANOTHER RECIPE', 'the existing backup is untouched');
  assert.equal(other.data.get('techdoc-assistant:document:backup-schema3-2'), original);
  // a third recipe: the next slot, and the second backup is never overwritten either
  other.data.set('techdoc-assistant:document:backup-schema3-2', 'YET ANOTHER');
  const third = saveDocumentWithBackup(other, KEY, doc, { fromSchema: 3, originalRaw: original });
  assert.deepEqual(third, { status: 'saved', backupWritten: true, backupKey: 'techdoc-assistant:document:backup-schema3-3' });
  assert.equal(other.data.get('techdoc-assistant:document:backup-schema3-2'), 'YET ANOTHER');
  // saving the same migrated recipe again finds its own copy (slot 3) and makes no new one
  assert.deepEqual(saveDocumentWithBackup(other, KEY, doc, { fromSchema: 3, originalRaw: original }), { status: 'saved', backupWritten: false, backupKey: 'techdoc-assistant:document:backup-schema3-3' });
  // a different old schema gets its own backup key
  const schema1 = new FakeStorage();
  saveDocumentWithBackup(schema1, KEY, touchDocument(restoreOk(readFixture('schema1')).document), { fromSchema: 1, originalRaw: readFixture('schema1') });
  assert.ok(schema1.data.has('techdoc-assistant:document:backup-schema1'));
});

test('backup: if the backup cannot be written the save is REFUSED and the stored (old) document stays untouched', () => {
  const storage = new FakeStorage();
  const original = readFixture('schema3-rich');
  storage.data.set(KEY, original);
  storage.failOn = 'techdoc-assistant:document:backup-schema3';
  const outcome = saveDocumentWithBackup(storage, KEY, touchDocument(restoreOk(original).document), { fromSchema: 3, originalRaw: original });
  assert.equal(outcome.status, 'backup_failed');
  assert.equal(storage.data.get(KEY), original, 'the old document is exactly as it was');
  assert.ok(!storage.log.includes(KEY), 'the main key was not even written');
});

test('backup: a document that was NOT migrated is saved without any backup, and the next saves of a migrated document do not make further backups', () => {
  const storage = new FakeStorage();
  const doc = touchDocument(restoreOk(readFixture('schema3-rich')).document);
  assert.deepEqual(saveDocumentWithBackup(storage, KEY, doc), { status: 'saved', backupWritten: false });
  assert.deepEqual(storage.log, [KEY]);
  assert.ok([...storage.data.keys()].every(k => !k.includes('backup')));
});

// =====================================================================================
// The export API accepts every older schema and migrates on the way in
// =====================================================================================

test('export API: a schema-3 payload is migrated and exported (instruction with the appendix, card with the cards); a refused ambiguous payload is a clear 400', async () => {
  const post = (document: unknown, documentType: string, format = 'docx') => exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document, documentType, format }),
  }));
  const rich = JSON.parse(readFixture('schema3-rich'));
  const instruction = await post(rich, 'instruction');
  assert.equal(instruction.status, 200);
  const text = docxPlain(Buffer.from(await instruction.arrayBuffer()));
  assert.ok(text.includes('мишень: Cr') && text.includes('Данные прежней версии (не входят в технологический режим)'));
  for (const type of ['technologicalCard', 'routeCard', 'recipe']) assert.equal((await post(rich, type, 'pdf')).status, 200, type);
  for (const name of ['schema1', 'schema2']) assert.equal((await post(JSON.parse(readFixture(name)), 'technologicalCard')).status, 200, name);
  const ambiguous = JSON.parse(v3([{ type: 'adhesion_underlayer', sourceAssignments: [{ sourceId: 'magnetron-1', kind: 'magnetron', enabled: true, mode: 'parallel' }] }],
    { sources: { magnetrons: [{ id: 'magnetron-1', enabled: true, material: 'Ti' }, { id: 'magnetron-1', enabled: true, material: 'Al' }], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } } }));
  const refused = await post(ambiguous, 'instruction');
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(await refused.json()), /Ti \/ Al/);
});

test('quality checks created by the migration are ordinary checks: editable, exportable, with the same fields', () => {
  const doc = restoreOk(readFixture('schema3-rich')).document;
  const migrated = doc.qualityChecks.find(q => q.parameter === 'Контроль толщины')!;
  assert.equal(migrated.status, undefined);
  const edited = { ...doc, qualityChecks: [...doc.qualityChecks.filter(q => q !== migrated), { ...migrated, result: '3.1', unit: 'мкм', status: 'pass' as const }, createQualityCheck('Шероховатость')] };
  assert.doesNotThrow(() => validateDocument(edited));
  assert.ok(buildInstructionView(edited).includes('результат — 3.1 мкм'));
});
