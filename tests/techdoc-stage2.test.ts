import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import {
  createBlankDocument, createDocumentFromPreset, updateStep, touchDocument, validateDocument, formatPressure,
  buildInstructionView, buildTechnologicalCard, buildRouteCard, buildBriefRecipe,
  restoreDocumentDetailed, tryRestoreDocument,
  type TechnicalProcessDocument,
} from '../src/services/workspace/techdoc-assistant';
import {
  TECHDOC_SCHEMA_VERSION, PA_PER_MBAR, pressureToPa, paToDisplayText, parsePressureInput, migrateMbarToPa, isPressureUnit,
} from '../src/services/workspace/techdoc-schema';
import { buildDocumentViewModel, exportTechDoc, parseTechnicalProcessDocument } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text; } finally { await parser.destroy(); }
}
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** A document exactly as the pre-Stage-2 app saved it: no schemaVersion, no pressureUnit, step
 *  pressure under `pressureMbar` (and no `pressurePa` key at all). */
function legacyDoc(pressuresMbar: Record<number, number | null | undefined> = { 5: 0.005 }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = json(createDocumentFromPreset('magnetron-pvd'));
  delete doc.schemaVersion;
  delete doc.pressureUnit;
  doc.general.processName = 'AlTiN_PVD';
  doc.steps = doc.steps.map((step: Record<string, unknown>) => {
    const copy = { ...step };
    delete copy.pressurePa;
    const mbar = pressuresMbar[copy.order as number];
    if (mbar !== undefined) copy.pressureMbar = mbar;
    return copy;
  });
  return { ...doc, ...extra };
}
const restoreOk = (raw: unknown) => {
  const result = restoreDocumentDetailed(JSON.stringify(raw));
  assert.equal(result.status, 'ok', JSON.stringify(result));
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
};
const pressureOf = (doc: TechnicalProcessDocument, order = 5) => doc.steps.find(s => s.order === order)?.pressurePa;

// =====================================================================================
// Schema version
// =====================================================================================

test('schema: new documents carry the current schemaVersion (4) and the default display unit Pa; it is separate from traceability.version', () => {
  assert.equal(TECHDOC_SCHEMA_VERSION, 4);
  for (const doc of [createBlankDocument(), createDocumentFromPreset('pecvd')]) {
    assert.equal(doc.schemaVersion, 4);
    assert.equal(doc.pressureUnit, 'pa');
    assert.equal(doc.traceability.version, 1, 'the document revision is a different counter');
  }
  const named = { ...createBlankDocument(), general: { processName: 'X' } };
  const touched = touchDocument(touchDocument(named));
  assert.equal(touched.traceability.version, 3, 'saving bumps the revision');
  assert.equal(touched.schemaVersion, 4, '...and never the schema version');
});

test('schema: a current document round-trips through JSON with schemaVersion and pressureUnit intact', () => {
  let doc = { ...createDocumentFromPreset('magnetron-pvd'), general: { processName: 'X' }, pressureUnit: 'mbar' as const };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 0.5 }) };
  const restored = restoreOk(doc);
  assert.equal(restored.document.schemaVersion, 4);
  assert.equal(restored.document.pressureUnit, 'mbar');
  assert.equal(restored.migratedFromSchema, undefined, 'nothing to migrate');
  assert.deepEqual(json(restored.document), json(doc));
});

// =====================================================================================
// Migration of old (schema 1) recipes
// =====================================================================================

test('migration: 0.005 mbar -> 0.5 Pa (the audit example), shown in Pa by default, flagged as migrated from schema 1', () => {
  const result = restoreOk(legacyDoc());
  assert.equal(pressureOf(result.document), 0.5);
  assert.equal(result.migratedFromSchema, 1);
  assert.equal(result.document.schemaVersion, 4, 'migrated all the way to the current schema');
  assert.equal(result.document.pressureUnit, 'pa');
  assert.ok(!JSON.stringify(result.document).includes('pressureMbar'), 'the old field is gone from the migrated document');
});

test('migration: a table of conversions is exact and free of floating-point noise (1 mbar = 100 Pa)', () => {
  const cases: [number, number][] = [
    [0.005, 0.5], [1, 100], [0.07, 7], [0.0013, 0.13], [1e-7, 1e-5], [1.5e-4, 0.015], [0.00013579, 0.013579], [10, 1000], [2e-3, 0.2], [0.1, 10], [1e-10, 1e-8],
  ];
  assert.equal(PA_PER_MBAR, 100);
  for (const [mbar, pa] of cases) {
    assert.equal(migrateMbarToPa(mbar), pa, `${mbar} mbar`);
    assert.equal(pressureOf(restoreOk(legacyDoc({ 5: mbar })).document), pa, `${mbar} mbar via restore`);
  }
  assert.notEqual(0.07 * 100, 7, 'sanity: the raw double product is noisy; the exact decimal shift is not, and nothing is rounded');
});

test('migration: no repeated conversion - save and restore many times, the value stays 0.5 Pa (never 50 / 5000)', () => {
  let doc = restoreOk(legacyDoc()).document;
  for (let cycle = 0; cycle < 6; cycle++) {
    const result = restoreOk(doc);
    assert.equal(result.migratedFromSchema, undefined, `cycle ${cycle}: already current`);
    assert.equal(pressureOf(result.document), 0.5, `cycle ${cycle}`);
    doc = touchDocument(result.document);
  }
  assert.equal(pressureOf(doc), 0.5);
});

test('migration: restoring does not mutate or rewrite the saved data (pure function; the stored legacy JSON stays as it was)', () => {
  const raw = JSON.stringify(legacyDoc());
  const snapshot = raw.slice();
  const writes: string[] = [];
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem: (k: string) => writes.push(k), removeItem: (k: string) => writes.push(k), getItem: () => raw } });
  try {
    restoreDocumentDetailed(raw);
    tryRestoreDocument(raw);
  } finally {
    if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.deepEqual(writes, [], 'restoring never writes to or removes from storage');
  assert.equal(raw, snapshot, 'the input string is untouched');
});

test('migration: documents without pressure keep it absent (never 0); null stays absent; explicit 0 stays 0', () => {
  const none = restoreOk(legacyDoc({})).document;
  assert.ok(none.steps.every(s => s.pressurePa === undefined));
  const withNull = restoreOk(legacyDoc({ 5: null })).document;
  assert.equal(pressureOf(withNull), undefined);
  const zero = restoreOk(legacyDoc({ 5: 0 })).document;
  assert.equal(pressureOf(zero), 0);
  assert.equal(Object.is(pressureOf(zero), 0), true);
  const mixed = restoreOk(legacyDoc({ 3: 1e-3, 5: 0.005, 8: 0 })).document;
  // Heating and unloading cards have no single-pressure field (heating has a start and an end, unloading none): the old value is NOT guessed into
  // one of them - it is kept as legacy data of the card, exactly converted.
  assert.deepEqual(mixed.steps.map(s => s.pressurePa), [undefined, undefined, undefined, undefined, 0.5, undefined, undefined, undefined]);
  const legacyPressure = (order: number) => mixed.legacy.stepFields.find(e => e.stepId === mixed.steps.find(s => s.order === order)!.id)?.fields.find(f => f.key === 'pressurePa')?.value;
  assert.equal(legacyPressure(3), 0.1);
  assert.equal(legacyPressure(8), 0);
});

test('migration: a legacy document with an explicit schemaVersion of 1 migrates too; a document that already has pressurePa keeps it untouched', () => {
  assert.equal(pressureOf(restoreOk(legacyDoc({ 5: 0.005 }, { schemaVersion: 1 })).document), 0.5);
  const both = legacyDoc({ 5: 0.005 });
  (both.steps as Record<string, unknown>[])[4].pressurePa = 3;
  assert.equal(pressureOf(restoreOk(both).document), 3, 'an existing Pa value is never recomputed from mbar');
});

test('migration: in a CURRENT-schema document a stray pressureMbar is ignored, never converted again', () => {
  const doc = json({ ...createDocumentFromPreset('magnetron-pvd'), general: { processName: 'X' } });
  doc.steps[4].pressureMbar = 0.005;
  assert.equal(pressureOf(restoreOk(doc).document), undefined);
  doc.steps[4].pressurePa = 7;
  assert.equal(pressureOf(restoreOk(doc).document), 7);
});

test('migration: other document data survives the migration unchanged (steps, equipment registry kept as legacy data, quality, safety, traceability)', () => {
  const raw = legacyDoc({ 5: 0.005 });
  raw.sources = { magnetrons: [{ id: 'magnetron-1', enabled: true, material: 'Ti', powerW: 1000 }], arcSources: [{ id: 'arc-1', enabled: true, cathodeMaterial: 'Cr', filtered: true }], icpRf: { enabled: false }, ionSource: { enabled: false } };
  (raw.steps as Record<string, unknown>[])[4].description = 'UNIQUE\nmultiline −150 V';
  const result = restoreOk(raw);
  assert.deepEqual(json(result.document.legacy.equipment?.magnetrons), [{ id: 'magnetron-1', enabled: true, material: 'Ti', powerW: 1000 }]);
  assert.deepEqual(json(result.document.legacy.equipment?.arcSources), [{ id: 'arc-1', enabled: true, cathodeMaterial: 'Cr', filtered: true }]);
  assert.equal(result.document.steps[4].description, 'UNIQUE\nmultiline −150 V');
  assert.equal(result.document.steps.length, 8);
  assert.deepEqual(json(result.document.traceability), json(raw.traceability));
});

// =====================================================================================
// Invalid values and future schema versions
// =====================================================================================

test('invalid: negative, non-numeric and non-finite pressures are rejected (restore -> invalid, validate throws), zero is not', () => {
  assert.equal(restoreDocumentDetailed(JSON.stringify(legacyDoc({ 5: -0.005 }))).status, 'invalid', 'negative legacy mbar');
  const doc = { ...createDocumentFromPreset('magnetron-pvd'), general: { processName: 'X' } };
  for (const bad of [-0.5, -1e-9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 5, { pressurePa: bad }) }), /давление/, String(bad));
  }
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 0 }) }));
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 1e-12 }) }));
  const textual = json(doc); textual.steps[4].pressurePa = 'abc';
  assert.equal(restoreDocumentDetailed(JSON.stringify(textual)).status, 'invalid');
  assert.throws(() => validateDocument({ ...doc, pressureUnit: 'torr' as never }), /Единица давления/);
});

test('invalid: malformed schemaVersion / pressureUnit values are rejected, not guessed', () => {
  for (const schemaVersion of ['2', 0, -1, 1.5, true, [], {}]) {
    assert.equal(restoreDocumentDetailed(JSON.stringify({ ...legacyDoc(), schemaVersion })).status, 'invalid', JSON.stringify(schemaVersion));
  }
  for (const pressureUnit of ['torr', 'Pa', 'MBAR', 5, '']) {
    assert.equal(restoreDocumentDetailed(JSON.stringify({ ...legacyDoc(), pressureUnit })).status, 'invalid', JSON.stringify(pressureUnit));
  }
  assert.equal(isPressureUnit('pa') && isPressureUnit('mbar'), true);
  assert.equal(restoreOk({ ...legacyDoc(), schemaVersion: null, pressureUnit: null }).document.pressureUnit, 'pa', 'null means absent');
});

test('future schema: a newer unknown version is reported, never parsed, converted or loaded', () => {
  for (const version of [5, 6, 99, 1000000]) {
    const future = { ...legacyDoc(), schemaVersion: version };
    const result = restoreDocumentDetailed(JSON.stringify(future));
    assert.deepEqual(result, { status: 'future_version', schemaVersion: version });
    assert.equal(tryRestoreDocument(JSON.stringify(future)), null);
  }
  // Its structure is unknown, so even garbage under a future version is "future", not "invalid".
  assert.equal(restoreDocumentDetailed(JSON.stringify({ schemaVersion: 7, steps: 'who knows' })).status, 'future_version');
  assert.equal(restoreDocumentDetailed(JSON.stringify({ schemaVersion: 2, steps: 'broken' })).status, 'invalid');
  assert.equal(restoreDocumentDetailed(null).status, 'empty');
  assert.equal(restoreDocumentDetailed('not json').status, 'invalid');
});

test('future schema: the export API refuses it with a clear 400 instead of rendering a guess', async () => {
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ document: { ...legacyDoc(), schemaVersion: 5 }, documentType: 'instruction', format: 'docx' }),
  }));
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /Версия схемы документа \(5\)/);
  assert.throws(() => parseTechnicalProcessDocument({ ...legacyDoc(), schemaVersion: 5 }), /новее поддерживаемой/);
});

// =====================================================================================
// Units: Pa <-> mbar
// =====================================================================================

test('units: conversions between Pa and mbar are exact inverses, including very small positive pressures', () => {
  const values = [0.5, 1, 100, 1e-5, 1e-9, 3e-9, 0.013579, 7, 1234.5678, 1e-12, 5e-6, 0.07, 101325];
  for (const pa of values) {
    const mbarText = paToDisplayText(pa, 'mbar')!;
    assert.equal(parsePressureInput(mbarText, 'mbar'), pa, `${pa} Pa -> "${mbarText}" mbar -> back`);
    assert.ok(Math.abs(pressureToPa(Number(mbarText), 'mbar')! - pa) <= Math.abs(pa) * 2.3e-16, `${pa} Pa via the number path`);
    assert.equal(parsePressureInput(paToDisplayText(pa, 'pa')!, 'pa'), pa);
    assert.equal(pressureToPa(pa, 'pa'), pa);
  }
  assert.equal(paToDisplayText(0.5, 'mbar'), '0.005');
  assert.equal(paToDisplayText(1e-5, 'mbar'), '1e-7');
  assert.equal(pressureToPa(0.005, 'mbar'), 0.5);
  assert.equal(pressureToPa(1e-7, 'mbar'), 1e-5);
});

test('units: zero is a value, an empty field is not - in both directions and both units', () => {
  for (const unit of ['pa', 'mbar'] as const) {
    assert.equal(pressureToPa(0, unit), 0);
    assert.equal(paToDisplayText(0, unit), '0');
    assert.equal(pressureToPa(undefined, unit), undefined);
    assert.equal(paToDisplayText(undefined, unit), undefined);
    assert.equal(parsePressureInput('0', unit), 0);
    assert.equal(parsePressureInput('', unit), undefined);
    assert.equal(parsePressureInput('   ', unit), undefined);
    assert.equal(formatPressure(0, unit), unit === 'pa' ? '0 Па' : '0 мбар');
    assert.equal(formatPressure(undefined, unit), 'не задано');
    assert.equal(formatPressure(undefined, unit, true), '—');
    assert.equal(formatPressure(0, unit, true), unit === 'pa' ? '0 Па' : '0 мбар');
  }
});

test('input parsing: scientific notation, decimal comma, both units; garbage is NaN (rejected later), negatives stay negative (rejected later)', () => {
  assert.equal(parsePressureInput('1e-5', 'pa'), 1e-5);
  assert.equal(parsePressureInput('1E-5', 'pa'), 1e-5);
  assert.equal(parsePressureInput('1,5e-3', 'pa'), 1.5e-3);
  assert.equal(parsePressureInput('5e-6', 'mbar'), 5e-4);
  assert.equal(parsePressureInput('0.0000001', 'mbar'), 1e-5);
  assert.equal(parsePressureInput(' 0.5 ', 'pa'), 0.5);
  assert.equal(parsePressureInput('0.005', 'mbar'), 0.5);
  assert.ok(Number.isNaN(parsePressureInput('abc', 'pa')));
  assert.ok(Number.isNaN(parsePressureInput('1e', 'pa')));
  assert.equal(parsePressureInput('-1', 'pa'), -1);
  assert.equal(parsePressureInput('-1', 'mbar'), -100);
});

test('units: switching the display unit never changes the stored physical value; switching back restores the same text', () => {
  let doc: TechnicalProcessDocument = { ...createDocumentFromPreset('magnetron-pvd'), general: { processName: 'X' } };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 0.5 }) };
  const inPa = buildInstructionView(doc);
  const switched = { ...doc, pressureUnit: 'mbar' as const };
  assert.equal(pressureOf(switched), 0.5, 'stored value unchanged');
  assert.ok(buildInstructionView(switched).includes('- Давление: 0.005 мбар'));
  const back = { ...switched, pressureUnit: 'pa' as const };
  assert.equal(buildInstructionView(back), inPa);
  assert.equal(pressureOf(back), 0.5);
  for (let i = 0; i < 10; i++) doc = { ...doc, pressureUnit: doc.pressureUnit === 'pa' ? 'mbar' : 'pa' };
  assert.equal(pressureOf(doc), 0.5, 'no drift after many toggles');
  assert.equal(restoreOk(doc).document.pressureUnit, doc.pressureUnit, 'the chosen display unit persists');
});

test('units: very small positive pressures stay positive and are shown in scientific notation, never rounded to 0', () => {
  let doc: TechnicalProcessDocument = { ...createDocumentFromPreset('magnetron-pvd'), general: { processName: 'X' } };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 1e-7 }) };
  assert.equal(formatPressure(1e-7, 'pa'), '1e-7 Па');
  assert.equal(formatPressure(1e-7, 'mbar'), '1e-9 мбар');
  assert.ok(buildInstructionView(doc).includes('1e-7 Па'));
  assert.equal(pressureOf(restoreOk(doc).document), 1e-7);
  assert.equal(restoreOk(legacyDoc({ 5: 1e-9 })).document.steps[4].pressurePa, 1e-7);
  assert.ok(parsePressureInput('1e-9', 'mbar')! > 0);
});

// =====================================================================================
// Every TechDoc view and the exports
// =====================================================================================

function migratedDoc(unit: 'pa' | 'mbar' = 'pa'): TechnicalProcessDocument {
  return { ...restoreOk(legacyDoc({ 5: 0.005, 7: 0 })).document, pressureUnit: unit };
}

test('views: instruction, technological card, brief recipe and route card agree on the unit (migrated 0.005 mbar)', () => {
  const pa = migratedDoc('pa');
  assert.ok(buildInstructionView(pa).includes('- Давление: 0.5 Па'));
  assert.ok(buildInstructionView(pa).includes('- Давление: 0 Па'));
  assert.equal(buildTechnologicalCard(pa).find(r => r.number === 5)!.pressure, '0.5 Па');
  assert.equal(buildTechnologicalCard(pa).find(r => r.number === 7)!.pressure, '0 Па');
  assert.equal(buildTechnologicalCard(pa).find(r => r.number === 1)!.pressure, '—');
  assert.ok(buildBriefRecipe(pa).includes('P: 0.5 Па'));
  assert.ok(buildBriefRecipe(pa).includes('P: 0 Па'));
  assert.ok(!/мбар/.test(buildInstructionView(pa) + JSON.stringify(buildTechnologicalCard(pa)) + buildBriefRecipe(pa)));
  assert.ok(!/(?:мбар|Па)/.test(JSON.stringify(buildRouteCard(pa))), 'the route card has no pressure column');

  const mbar = migratedDoc('mbar');
  assert.ok(buildInstructionView(mbar).includes('- Давление: 0.005 мбар'));
  assert.equal(buildTechnologicalCard(mbar).find(r => r.number === 5)!.pressure, '0.005 мбар');
  assert.ok(buildBriefRecipe(mbar).includes('P: 0.005 мбар'));
  assert.ok(!/\d\s*Па(?![а-яё])/.test(buildInstructionView(mbar) + JSON.stringify(buildTechnologicalCard(mbar)) + buildBriefRecipe(mbar)));
});

test('export view model: every document type shows the migrated pressure in the chosen unit', () => {
  const instruction = (doc: TechnicalProcessDocument) => buildDocumentViewModel(doc, 'instruction').sections.find(s => s.heading.startsWith('7.'))!.paragraphs.find(p => p.startsWith('№5.'))!;
  assert.ok(instruction(migratedDoc('pa')).includes('Давление: 0.5 Па'));
  assert.ok(instruction(migratedDoc('mbar')).includes('Давление: 0.005 мбар'));
  const noPressure = { ...migratedDoc('pa'), steps: migratedDoc('pa').steps.map(s => ({ ...s, pressurePa: undefined })) };
  assert.ok(instruction(noPressure).includes('Давление: не задано'));
  const card = (doc: TechnicalProcessDocument) => buildDocumentViewModel(doc, 'technologicalCard').tables[0].rows.find(r => r[0] === '5')![4];
  assert.equal(card(migratedDoc('pa')), '0.5 Па');
  assert.equal(card(migratedDoc('mbar')), '0.005 мбар');
  const recipe = (doc: TechnicalProcessDocument) => buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs.join('\n');
  assert.ok(recipe(migratedDoc('pa')).includes('P: 0.5 Па') && recipe(migratedDoc('mbar')).includes('P: 0.005 мбар'));
  assert.ok(!JSON.stringify(buildDocumentViewModel(migratedDoc('pa'), 'routeCard').tables).match(/мбар|Па(?![а-яё])/));
});

const TYPES = ['instruction', 'technologicalCard', 'routeCard', 'recipe'] as const;

test('DOCX and PDF of a migrated 0.005 mbar recipe show 0.5 Па (Pa selected) in every pressure-bearing document, and 0.005 мбар when mbar is selected', async () => {
  for (const type of ['instruction', 'technologicalCard', 'recipe'] as const) {
    const docxPa = docxPlain((await exportTechDoc(migratedDoc('pa'), type, 'docx')).buffer);
    const pdfPa = await pdfText((await exportTechDoc(migratedDoc('pa'), type, 'pdf')).buffer);
    for (const [format, text] of [['docx', docxPa], ['pdf', pdfPa]] as const) {
      assert.ok(/0\.5\s*Па/.test(text.replace(/\s+/g, ' ')), `${type}/${format}: 0.5 Па`);
      assert.ok(!/мбар/.test(text), `${type}/${format}: no stray mbar in Pa mode`);
      assert.ok(!/0\.005/.test(text), `${type}/${format}: the unconverted legacy number must not appear`);
    }
    const docxMbar = docxPlain((await exportTechDoc(migratedDoc('mbar'), type, 'docx')).buffer);
    const pdfMbar = (await pdfText((await exportTechDoc(migratedDoc('mbar'), type, 'pdf')).buffer)).replace(/\s+/g, ' ');
    for (const text of [docxMbar, pdfMbar]) {
      assert.ok(/0\.005\s*мбар/.test(text.replace(/\s+/g, ' ')), `${type}: 0.005 мбар`);
      assert.ok(!/\d\s*Па(?![а-яё])/.test(text), `${type}: no stray Pa in mbar mode`);
    }
  }
  for (const format of ['docx', 'pdf'] as const) {
    const { buffer } = await exportTechDoc(migratedDoc('pa'), 'routeCard', format);
    assert.ok(buffer.length > 0, `routeCard ${format} still exports`);
  }
  assert.equal(TYPES.length, 4);
});

test('export of 0, a very small value and an unset pressure: shown as "0 Па", "1e-7 Па" and "не задано" in DOCX and PDF', async () => {
  let doc = migratedDoc('pa'); // card 5: 0.5 Pa, cooling (7): 0 Pa, the other cards: unset
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 1e-7 }) };
  const docx = docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer);
  const pdf = (await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer)).replace(/\s+/g, ' ');
  for (const text of [docx.replace(/\s+/g, ' '), pdf]) {
    assert.ok(text.includes('Давление: 0 Па'), 'zero');
    assert.ok(text.includes('Давление: 1e-7 Па'), 'tiny');
    assert.ok(text.includes('Давление: не задано'), 'unset');
  }
});

test('export API: a LEGACY payload (pressureMbar, no schemaVersion) is migrated on the way in and exported as 0.5 Па', async () => {
  const post = (document: unknown, format: 'docx' | 'pdf') => exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document, documentType: 'instruction', format }),
  }));
  const docx = await post(legacyDoc(), 'docx');
  assert.equal(docx.status, 200);
  assert.ok(/Давление: 0\.5 Па/.test(docxPlain(Buffer.from(await docx.arrayBuffer()))));
  const pdf = await post(legacyDoc(), 'pdf');
  assert.ok(/0\.5\s*Па/.test((await pdfText(Buffer.from(await pdf.arrayBuffer()))).replace(/\s+/g, ' ')));
  const negative = await post(legacyDoc({ 5: -1 }), 'docx');
  assert.equal(negative.status, 400);
  assert.match(JSON.stringify(await negative.json()), /давление/);
});

test('Stage 1 behaviour is intact after the schema change: explicit registry ids and step descriptions survive a migrated restore and the export', async () => {
  const raw = legacyDoc({ 5: 0.005 });
  raw.sources = { magnetrons: [{ material: 'Ti' }, { id: 'magnetron-0', material: 'Al' }], arcSources: [], icpRf: { enabled: false }, ionSource: { enabled: false } };
  (raw.steps as Record<string, unknown>[])[4].description = 'UNIQUE-STAGE2-DESC\nline two';
  const result = restoreOk(raw);
  assert.deepEqual(result.document.legacy.equipment?.magnetrons.map(m => `${m.material}:${m.id}`), ['Ti:magnetron-1', 'Al:magnetron-0'], 'the explicit id is reserved first; the id-less record gets a fresh one');
  const text = docxPlain((await exportTechDoc(result.document, 'instruction', 'docx')).buffer);
  assert.ok(text.includes('Описание: UNIQUE-STAGE2-DESC\nline two') && /Давление: 0\.5 Па/.test(text));
});

// =====================================================================================
// Numeric edge cases: underflow, signed zero, 16-17 significant digits
// =====================================================================================

import { parsePressureText, paToDisplayInputValue } from '../src/services/workspace/techdoc-schema';

/** The NUMBER path (a double entered in mbar -> Pa) starts from an already-rounded double, so IEEE-754
 *  itself limits it to about one unit in the last place; the TEXT path is exact. */
const withinOneUlp = (a: number, b: number) => a === b || Math.abs(a - b) <= Math.abs(b) * 2.3e-16;

test('underflow (display): a positive pressure is never shown as 0 - 5e-324 Pa is "5e-326" mbar, in every view', () => {
  assert.equal(paToDisplayText(5e-324, 'mbar'), '5e-326');
  assert.equal(paToDisplayText(5e-324, 'pa'), '5e-324');
  assert.equal(formatPressure(5e-324, 'mbar'), '5e-326 мбар');
  assert.equal(formatPressure(5e-324, 'pa'), '5e-324 Па');
  assert.equal(paToDisplayInputValue(5e-324, 'mbar'), '5e-326', 'the input gets the exact text, not 0');
  assert.equal(paToDisplayInputValue(0, 'mbar'), 0, 'a real zero is still 0');
  assert.equal(paToDisplayInputValue(0.5, 'mbar'), 0.005, 'ordinary values stay numbers (typing "0.0050" is not rewritten)');
  assert.equal(paToDisplayInputValue(undefined, 'pa'), undefined);
  for (const pa of [5e-324, 1e-323, 2.5e-320, 1e-310, 2.2250738585072014e-308]) {
    for (const unit of ['pa', 'mbar'] as const) assert.notEqual(Number(paToDisplayText(pa, unit)) === 0 && paToDisplayText(pa, unit) === '0', true, `${pa} ${unit}`);
    assert.equal(parsePressureInput(paToDisplayText(pa, 'mbar')!, 'mbar'), pa, `${pa}: the exact text of the mbar value parses back to the same Pa`);
  }
});

test('underflow (display) through the document views and exports: the tiny pressure is visible, never "0"', async () => {
  let doc: TechnicalProcessDocument = { ...migratedDoc('mbar'), steps: migratedDoc('mbar').steps.map(s => ({ ...s, pressurePa: undefined as number | undefined })) };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 5e-324 }) };
  assert.ok(buildInstructionView(doc).includes('- Давление: 5e-326 мбар'));
  assert.equal(buildTechnologicalCard(doc).find(r => r.number === 5)!.pressure, '5e-326 мбар');
  assert.ok(buildBriefRecipe(doc).includes('P: 5e-326 мбар'));
  const restored = restoreOk(doc).document;
  assert.equal(pressureOf(restored), 5e-324, 'JSON save/restore keeps the denormal exactly');
  const docx = docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer);
  const pdf = (await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer)).replace(/\s+/g, ' ');
  for (const text of [docx, pdf]) assert.ok(text.includes('Давление: 5e-326 мбар'), 'exported');
  const inPa = docxPlain((await exportTechDoc({ ...doc, pressureUnit: 'pa' }, 'instruction', 'docx')).buffer);
  assert.ok(inPa.includes('Давление: 5e-324 Па'));
});

test('underflow (input): a non-zero number too small for a double is reported, not stored as 0 or -0', () => {
  const cases: [string, 'pa' | 'mbar'][] = [['1e-999', 'pa'], ['-1e-999', 'pa'], ['1e-999', 'mbar'], ['-1e-999', 'mbar'], ['5e-325', 'pa'], ['1e-326', 'mbar'], ['0.000000000000000000001e-310', 'pa']];
  for (const [text, unit] of cases) {
    assert.deepEqual(parsePressureText(text, unit), { status: 'invalid', reason: 'underflow' }, `${text} ${unit}`);
    assert.ok(Number.isNaN(parsePressureInput(text, unit)), `${text} ${unit}: the editor value is NaN`);
  }
  const doc = { ...createDocumentFromPreset('pecvd'), general: { processName: 'X' } };
  for (const [text, unit] of cases) {
    assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 4, { pressurePa: parsePressureInput(text, unit) }) }), /давление/, `${text} ${unit}: rejected by validation`);
  }
});

test('underflow (input): just inside the double range is accepted exactly; mbar input is converted by decimal shift, so 5e-326 mbar IS 5e-324 Pa', () => {
  assert.deepEqual(parsePressureText('5e-324', 'pa'), { status: 'ok', pa: 5e-324 });
  assert.deepEqual(parsePressureText('5e-326', 'mbar'), { status: 'ok', pa: 5e-324 });
  assert.deepEqual(parsePressureText('4.9406564584124654e-324', 'pa'), { status: 'ok', pa: 5e-324 });
  assert.deepEqual(parsePressureText('1e-320', 'pa'), { status: 'ok', pa: 1e-320 });
});

test('signed zero and the other parse outcomes: "-0" is a plain 0, zero mantissas never count as underflow, overflow/garbage are named', () => {
  for (const text of ['0', '-0', '+0', '0.0', '-0.000', '0e-999', '-0e999', '0e5', '.0']) {
    const result = parsePressureText(text, 'mbar');
    assert.equal(result.status, 'ok', text);
    assert.ok(result.status === 'ok' && Object.is(result.pa, 0), `${text} is +0, never -0`);
  }
  assert.deepEqual(parsePressureText('1e999', 'pa'), { status: 'invalid', reason: 'overflow' });
  assert.deepEqual(parsePressureText('1e308', 'mbar'), { status: 'invalid', reason: 'overflow' }, 'x100 overflows the storage unit');
  assert.deepEqual(parsePressureText('1e99999999999999999999', 'pa'), { status: 'invalid', reason: 'overflow' });
  assert.deepEqual(parsePressureText('1e-99999999999999999999', 'pa'), { status: 'invalid', reason: 'underflow' });
  for (const text of ['abc', '1e', '--1', '1.2.3', '1 2', 'Infinity', 'NaN', '0x10', '١٢', '1e+', '.', 'e5', '1,2,3']) {
    assert.deepEqual(parsePressureText(text, 'pa'), { status: 'invalid', reason: 'not_a_number' }, JSON.stringify(text));
  }
  assert.deepEqual(parsePressureText('', 'pa'), { status: 'empty' });
  assert.deepEqual(parsePressureText('   ', 'mbar'), { status: 'empty' });
  assert.deepEqual(parsePressureText('-1e-3', 'pa'), { status: 'ok', pa: -0.001 }, 'a genuine negative is returned as is - validateDocument rejects it');
  assert.deepEqual(parsePressureText('1,5E-3', 'pa'), { status: 'ok', pa: 0.0015 });
});

test('a legacy recipe with a pressure that overflows Pa, or a negative one that would underflow, is not loaded as a corrupted value', () => {
  assert.equal(restoreDocumentDetailed(JSON.stringify(legacyDoc({ 5: 1e307 }))).status, 'invalid', '1e307 mbar = 1e309 Pa: not representable');
  assert.equal(restoreDocumentDetailed(JSON.stringify(legacyDoc({ 5: -1e-300 }))).status, 'invalid', 'negative stays negative');
  assert.equal(pressureOf(restoreOk(legacyDoc({ 5: 5e-324 })).document), 5e-322, 'a denormal legacy mbar value converts exactly');
});

const SIXTEEN_SEVENTEEN = [
  0.12345678901234566, 0.1234567890123457, 1.2345678901234567e-5, 123456789.12345678, 9.999999999999999e-7, 0.30000000000000004,
  1.7976931348623157e305, 2.2250738585072014e-308, 4.35e-9, 0.1 + 0.2, 1 / 3, 2 / 3, Math.PI * 1e-4, Math.E * 1e3, 1234567890.1234567,
];

test('precision: canonical Pa is never rounded - 16-17 significant digits survive Pa -> mbar -> Pa exactly (the audit example)', () => {
  const x = 0.12345678901234566;
  const mbarText = paToDisplayText(x, 'mbar')!;
  assert.equal(mbarText, '0.0012345678901234566', 'all 17 digits are shown, none dropped');
  assert.equal(parsePressureInput(mbarText, 'mbar'), x, 'back to the identical double (the old code returned 0.123456789012346)');
  assert.ok(withinOneUlp(pressureToPa(Number(mbarText), 'mbar')!, x), 'the double-valued path is limited by IEEE-754 to ~1 ulp - which is why the editor works on the exact text');
  for (const pa of SIXTEEN_SEVENTEEN) {
    const text = paToDisplayText(pa, 'mbar')!;
    assert.equal(parsePressureInput(text, 'mbar'), pa, `${pa} -> ${text}`);
    assert.equal(parsePressureInput(paToDisplayText(pa, 'pa')!, 'pa'), pa);
    if (pa > 1e-300) assert.ok(withinOneUlp(pressureToPa(Number(text), 'mbar')!, pa), `${pa}: number path within 1 ulp (a subnormal mbar double cannot hold it - the text path can)`);
  }
});

test('precision: mbar -> Pa keeps every digit too, with no float noise and no rounding (0.07 mbar = 7 Pa exactly)', () => {
  const exact: [string, number][] = [['0.07', 7], ['0.12345678901234566', 12.345678901234566], ['1.2345678901234567e-7', 1.2345678901234567e-5], ['0.30000000000000004', 30.000000000000004], ['123456789.12345678', 12345678912.345678]];
  for (const [text, pa] of exact) {
    assert.equal(parsePressureInput(text, 'mbar'), pa, `${text} mbar`);
    assert.ok(withinOneUlp(pressureToPa(Number(text), 'mbar')!, pa), `${text} mbar (number path)`);
    assert.equal(migrateMbarToPa(Number(text)), parsePressureInput(String(Number(text)), 'mbar'), `${text} mbar (legacy migration = exact shift of the stored number's own digits)`);
  }
  assert.equal(pressureToPa(0.07, 'mbar'), 7);
  assert.equal(pressureToPa(0.1 + 0.2, 'mbar'), 30.000000000000004, 'a value that really is 0.30000000000000004 is not "corrected" to 0.3');
});

test('precision: a deterministic sweep of 40000 random doubles (all magnitudes, subnormals included) round-trips Pa -> text -> Pa bit-exactly in both units', () => {
  const view = new DataView(new ArrayBuffer(8));
  let state = 0x9e3779b9;
  const next32 = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state; };
  let checked = 0;
  for (let i = 0; i < 40000; i++) {
    view.setUint32(0, next32()); view.setUint32(4, next32());
    const pa = Math.abs(view.getFloat64(0));
    if (!Number.isFinite(pa) || pa === 0) continue;
    for (const unit of ['pa', 'mbar'] as const) {
      const text = paToDisplayText(pa, unit)!;
      const result = parsePressureText(text, unit);
      assert.ok(result.status === 'ok' && Object.is(result.pa, pa), `${pa} via ${unit}: "${text}" -> ${JSON.stringify(result)}`);
      assert.ok(Number(text) !== 0 || unit === 'mbar', 'the Pa text is never 0 for a positive value');
    }
    checked++;
  }
  assert.ok(checked > 39000);
});

test('precision: a 17-digit mbar value survives migration, JSON save, restore and a second save bit-for-bit', () => {
  const mbar = 0.12345678901234566;
  const migrated = restoreOk(legacyDoc({ 5: mbar })).document;
  const pa = pressureOf(migrated)!;
  assert.equal(pa, 12.345678901234566);
  let doc = migrated;
  for (let i = 0; i < 5; i++) { doc = restoreOk(touchDocument(doc)).document; assert.ok(Object.is(pressureOf(doc), pa), `cycle ${i}`); }
  const shownInMbar = formatPressure(pa, 'mbar');
  assert.equal(shownInMbar, '0.12345678901234566 мбар', 'shows back exactly the number that was typed in the old app');
});

test('precision: exports show all 17 digits, in both units, in DOCX and PDF', async () => {
  let doc: TechnicalProcessDocument = { ...migratedDoc('pa'), steps: migratedDoc('pa').steps.map(s => ({ ...s, pressurePa: undefined as number | undefined })) };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { pressurePa: 0.12345678901234566 }) };
  for (const [unit, text] of [['pa', 'Давление: 0.12345678901234566 Па'], ['mbar', 'Давление: 0.0012345678901234566 мбар']] as const) {
    const withUnit = { ...doc, pressureUnit: unit };
    assert.ok(docxPlain((await exportTechDoc(withUnit, 'instruction', 'docx')).buffer).includes(text), `docx ${unit}`);
    assert.ok((await pdfText((await exportTechDoc(withUnit, 'instruction', 'pdf')).buffer)).replace(/\s+/g, ' ').includes(text), `pdf ${unit}`);
  }
});

test('the input value shown for a 17-digit pressure is a number only when it round-trips unchanged; otherwise the exact text', () => {
  assert.equal(paToDisplayInputValue(0.12345678901234566, 'pa'), 0.12345678901234566);
  const mbar = paToDisplayInputValue(0.12345678901234566, 'mbar');
  assert.ok(typeof mbar === 'number' ? paToDisplayText(0.12345678901234566, 'mbar') === String(mbar) : mbar === paToDisplayText(0.12345678901234566, 'mbar'));
  assert.equal(parsePressureInput(String(mbar), 'mbar'), 0.12345678901234566);
});
