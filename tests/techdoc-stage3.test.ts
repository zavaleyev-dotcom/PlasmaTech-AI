import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { readZipEntryText } from './helpers/zip-reader';
import {
  createDocumentFromPreset, createBlankDocument, createDefaultSourceSet, createDefaultGasLines, addMagnetron, addArcSource, updateMagnetron, updateArcSource,
  addGasLine, updateGasLine, removeGasLine, addStep, updateStep, duplicateStep, touchDocument, validateDocument, collectStepWarnings,
  addSourceAssignment, updateSourceAssignment, removeSourceAssignment, addGasAssignment, updateGasAssignment, removeGasAssignment,
  findSourceUsage, findGasLineUsage, removeSourceFromDocument, removeGasLineFromDocument,
  formatSourceAssignment, formatGasAssignment, formatTimeWindow, buildStepAssignmentLines,
  buildInstructionView, buildTechnologicalCard, buildBriefRecipe, buildRouteCard,
  restoreDocumentDetailed, tryRestoreDocument, ensureUniqueSourceIds,
  TECHDOC_SCHEMA_VERSION, type TechnicalProcessDocument,
} from '../src/services/workspace/techdoc-assistant';
import { buildDocumentViewModel, exportTechDoc, parseTechnicalProcessDocument } from '../src/services/workspace/techdoc-export';
import { POST as exportPOST } from '../src/app/api/workspace/techdoc/export/route';

async function pdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  // PDFKit may break a line right after an en dash or a slash ("5–" / "15 мин", "см³/" / "мин"): the text
  // is intact, extraction just inserts whitespace there.
  try { return (await parser.getText()).text.replace(/μ/g, 'µ').replace(/([–/])\s+(?=[\dа-яa-z])/gi, '$1').replace(/\s+/g, ' '); } finally { await parser.destroy(); }
}
const docxPlain = (buffer: Buffer) => readZipEntryText(buffer, 'word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** Hybrid preset: step 5 = adhesion underlayer, step 6 = multilayer coating. Section D: two magnetrons
 *  (Ti, Al) and two arc sources (Cr filtered, Zr). Section E: Ar, N2, Ar (a second Ar line) and a
 *  disabled C2H2 line. Values are TEST DATA, not technological recommendations. */
function baseDoc(): TechnicalProcessDocument {
  let doc = createDocumentFromPreset('hybrid-magnetron-arc');
  let sources = addArcSource(addArcSource(addMagnetron(addMagnetron(createDefaultSourceSet()))));
  sources = updateMagnetron(sources, 'magnetron-1', { material: 'Ti', powerW: 1000, mode: 'DC' });
  sources = updateMagnetron(sources, 'magnetron-2', { material: 'Al', mode: 'pulsed DC' });
  sources = updateArcSource(sources, 'arc-1', { cathodeMaterial: 'Cr', filtered: true, arcCurrentA: 100 });
  sources = updateArcSource(sources, 'arc-2', { cathodeMaterial: 'Zr' });
  let gas = createDefaultGasLines();
  gas = updateGasLine(gas, 'gas-1', { gas: 'Ar', enabled: true, flow: 50 });
  gas = updateGasLine(gas, 'gas-2', { gas: 'N2', enabled: true });
  gas = updateGasLine(gas, 'gas-3', { gas: 'Ar', enabled: true });
  gas = updateGasLine(gas, 'gas-4', { gas: 'C2H2', enabled: false });
  doc = { ...doc, general: { processName: 'Hybrid_Stage3' }, sources, gasSystem: gas };
  return { ...doc, steps: updateStep(doc.steps, 5, { durationMin: 30 }) };
}
const withSteps = (doc: TechnicalProcessDocument, fn: (steps: TechnicalProcessDocument['steps']) => TechnicalProcessDocument['steps']): TechnicalProcessDocument => ({ ...doc, steps: fn(doc.steps) });
const step = (doc: TechnicalProcessDocument, order: number) => doc.steps.find(s => s.order === order)!;

/** The 30-minute example from the task: M1 0-30, A1 5-15, M2 15-30 (test data only). */
function exampleDoc(): TechnicalProcessDocument {
  return withSteps(baseDoc(), steps => {
    let s = steps;
    s = addSourceAssignment(s, 5, 'magnetron', 'magnetron-1'); s = updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { powerW: 2000, startMin: 0, durationMin: 30 });
    s = addSourceAssignment(s, 5, 'arc', 'arc-1'); s = updateSourceAssignment(s, 5, 'arc', 'arc-1', { currentA: 80, startMin: 5, durationMin: 10 });
    s = addSourceAssignment(s, 5, 'magnetron', 'magnetron-2'); s = updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', { powerW: 1500, startMin: 15, durationMin: 15 });
    return s;
  });
}

// =====================================================================================
// Model and operations
// =====================================================================================

test('model: every step starts with empty assignment lists; the schema is version 3', () => {
  assert.equal(TECHDOC_SCHEMA_VERSION, 3);
  for (const doc of [createBlankDocument(), createDocumentFromPreset('pecvd'), baseDoc()]) {
    assert.equal(doc.schemaVersion, 3);
    for (const s of doc.steps) { assert.deepEqual(s.sourceAssignments, []); assert.deepEqual(s.gasAssignments, []); }
  }
});

test('assigning a source or gas line fills in NOTHING: ON, parallel, no power/current/flow/time; duplicates are impossible', () => {
  let steps = baseDoc().steps;
  steps = addSourceAssignment(steps, 5, 'magnetron', 'magnetron-1');
  steps = addSourceAssignment(steps, 5, 'magnetron', 'magnetron-1');
  steps = addSourceAssignment(steps, 5, 'arc', 'arc-1');
  steps = addGasAssignment(steps, 5, 'gas-1');
  steps = addGasAssignment(steps, 5, 'gas-1');
  const s5 = steps.find(s => s.order === 5)!;
  assert.deepEqual(s5.sourceAssignments, [
    { sourceId: 'magnetron-1', kind: 'magnetron', enabled: true, mode: 'parallel' },
    { sourceId: 'arc-1', kind: 'arc', enabled: true, mode: 'parallel' },
  ]);
  assert.deepEqual(s5.gasAssignments, [{ lineId: 'gas-1', enabled: true }]);
  assert.throws(() => addSourceAssignment(steps, 99, 'arc', 'arc-1'), /Этап №99 не найден/);
  assert.equal(steps.find(s => s.order === 4)!.sourceAssignments.length, 0, 'other steps untouched');
});

test('the assignment never copies a material or gas name - they live only in sections D and E (one place to edit)', () => {
  const doc = exampleDoc();
  const serialized = JSON.stringify(step(doc, 5).sourceAssignments);
  for (const forbidden of ['Ti', 'Al', 'Cr', 'material', 'cathode', 'filtered']) assert.ok(!serialized.includes(forbidden), forbidden);
  const before = formatSourceAssignment(doc, step(doc, 5).sourceAssignments[0]);
  assert.ok(before.includes('мишень: Ti'));
  const renamed = { ...doc, sources: updateMagnetron(doc.sources, 'magnetron-1', { material: 'Zr-Nb' }) };
  assert.ok(formatSourceAssignment(renamed, step(renamed, 5).sourceAssignments[0]).includes('мишень: Zr-Nb'), 'editing D changes every use');
  assert.ok(buildInstructionView(renamed).includes('мишень: Zr-Nb') && !buildInstructionView(renamed).includes('мишень: Ti'));
  let withGas = withSteps(doc, s => updateGasAssignment(addGasAssignment(s, 5, 'gas-1'), 5, 'gas-1', { flowSccm: 40 }));
  withGas = { ...withGas, gasSystem: updateGasLine(withGas.gasSystem, 'gas-1', { gas: 'He' }) };
  assert.ok(formatGasAssignment(withGas, step(withGas, 5).gasAssignments[0]).includes('газ: He'));
});

test('two magnetrons and two arc sources on one step, and the SAME source with different parameters on different steps', () => {
  let doc = exampleDoc();
  doc = withSteps(doc, steps => {
    let s = addSourceAssignment(steps, 5, 'arc', 'arc-2');
    s = updateSourceAssignment(s, 5, 'arc', 'arc-2', { currentA: 60, startMin: 20, durationMin: 5 });
    // magnetron-1 again on step 6, with its own, different parameters
    s = updateStep(s, 6, { durationMin: 40 });
    s = addSourceAssignment(s, 6, 'magnetron', 'magnetron-1');
    return updateSourceAssignment(s, 6, 'magnetron', 'magnetron-1', { powerW: 3500, startMin: 10, durationMin: 20, mode: 'sequential' });
  });
  assert.doesNotThrow(() => validateDocument(doc));
  assert.equal(step(doc, 5).sourceAssignments.length, 4);
  assert.deepEqual(step(doc, 5).sourceAssignments.map(a => `${a.kind}:${a.sourceId}`), ['magnetron:magnetron-1', 'arc:arc-1', 'magnetron:magnetron-2', 'arc:arc-2']);
  const m1On5 = step(doc, 5).sourceAssignments[0];
  const m1On6 = step(doc, 6).sourceAssignments[0];
  assert.deepEqual([m1On5.powerW, m1On5.startMin, m1On5.durationMin, m1On5.mode], [2000, 0, 30, 'parallel']);
  assert.deepEqual([m1On6.powerW, m1On6.startMin, m1On6.durationMin, m1On6.mode], [3500, 10, 20, 'sequential']);
  assert.deepEqual(findSourceUsage(doc, 'magnetron', 'magnetron-1'), [5, 6]);
  assert.deepEqual(findSourceUsage(doc, 'magnetron', 'magnetron-2'), [5]);
  const edited = withSteps(doc, s => updateSourceAssignment(s, 6, 'magnetron', 'magnetron-1', { powerW: 1 }));
  assert.equal(step(edited, 5).sourceAssignments[0].powerW, 2000, 'editing one step never touches the other');
  assert.ok(step(edited, 6).origin === 'user');
});

test('arc and magnetron ids are independent: "magnetron-1" and "arc-1" are different sources, same-id different-kind is allowed', () => {
  const doc = baseDoc();
  const clash = { ...doc, sources: { ...doc.sources, arcSources: doc.sources.arcSources.map(a => a.id === 'arc-1' ? { ...a, id: 'magnetron-1' } : a) } };
  const s = withSteps(clash, steps => addSourceAssignment(addSourceAssignment(steps, 5, 'magnetron', 'magnetron-1'), 5, 'arc', 'magnetron-1'));
  assert.equal(step(s, 5).sourceAssignments.length, 2);
  assert.doesNotThrow(() => validateDocument(s));
  assert.ok(formatSourceAssignment(s, step(s, 5).sourceAssignments[0]).includes('мишень: Ti'));
  assert.ok(formatSourceAssignment(s, step(s, 5).sourceAssignments[1]).includes('катод: Cr'));
});

// =====================================================================================
// Time model
// =====================================================================================

test('time: the 30-minute example (M1 0-30, A1 5-15, M2 15-30) is valid and shown exactly', () => {
  const doc = exampleDoc();
  assert.doesNotThrow(() => validateDocument(doc));
  const lines = buildStepAssignmentLines(doc, step(doc, 5)).sources;
  assert.deepEqual(lines, [
    'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 2000 Вт, время — 0–30 мин, режим — одновременно',
    'Дуговой источник arc-1 (катод: Cr, фильтрованный): ВКЛ, ток дуги — 80 А, время — 5–15 мин, режим — одновременно',
    'Магнетрон magnetron-2 (мишень: Al): ВКЛ, мощность — 1500 Вт, время — 15–30 мин, режим — одновременно',
  ]);
});

test('time: negative times are rejected; zero is allowed; nothing is invented when a time is missing', () => {
  const doc = exampleDoc();
  const bad = (patch: object) => withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', patch));
  assert.throws(() => validateDocument(bad({ startMin: -1 })), /начало.*отрицательным/);
  assert.throws(() => validateDocument(bad({ durationMin: -0.5 })), /длительность.*отрицательным/);
  assert.throws(() => validateDocument(bad({ startMin: Number.NaN })), /конечное число/);
  assert.throws(() => validateDocument(bad({ currentA: -5 })), /ток дуги.*отрицательным/);
  assert.doesNotThrow(() => validateDocument(bad({ startMin: 0, durationMin: 0 })));
  assert.equal(formatTimeWindow(undefined, undefined), 'не задано');
  assert.equal(formatTimeWindow(5, undefined), 'начало 5 мин, длительность не задана');
  assert.equal(formatTimeWindow(undefined, 7), 'начало не задано, длительность 7 мин');
  assert.equal(formatTimeWindow(0, 0), 'начало 0 мин, длительность 0 мин (нулевой интервал: работы нет)', '0 is a value with its own wording, not "not set"');
  assert.equal(formatTimeWindow(0.1, 0.2), '0.1–0.3 мин', 'a derived end has no float noise');
  const unset = withSteps(baseDoc(), s => addSourceAssignment(s, 5, 'arc', 'arc-1'));
  assert.ok(formatSourceAssignment(unset, step(unset, 5).sourceAssignments[0]).includes('время — не задано'));
});

test('time: an interval must lie inside the step (start, end, or duration alone); when the step has no duration nothing can be checked and a warning says so', () => {
  const doc = exampleDoc();
  const patch = (p: object) => withSteps(doc, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', p));
  assert.throws(() => validateDocument(patch({ startMin: 20, durationMin: 15 })), /выходит за пределы этапа/);
  assert.throws(() => validateDocument(patch({ startMin: 31, durationMin: undefined })), /позже конца этапа/);
  assert.throws(() => validateDocument(patch({ startMin: undefined, durationMin: 31 })), /выходит за пределы этапа/);
  assert.doesNotThrow(() => validateDocument(patch({ startMin: 30, durationMin: 0 })), 'touching the end is fine');
  assert.doesNotThrow(() => validateDocument(patch({ startMin: 15, durationMin: 15 })));
  const shorter = withSteps(doc, s => updateStep(s, 5, { durationMin: 20 }));
  assert.throws(() => validateDocument(shorter), /выходит за пределы этапа/, 'shortening the step exposes intervals that no longer fit');
  const noDuration = withSteps(doc, s => updateStep(s, 5, { durationMin: undefined }));
  assert.doesNotThrow(() => validateDocument(noDuration));
  assert.ok(collectStepWarnings(noDuration).some(w => w.includes('Этап №5: не задана длительность этапа')));
  assert.ok(!collectStepWarnings(doc).some(w => w.includes('длительность этапа')));
});

test('time: a switched-OFF source is not range-checked (it does not run); ON/OFF is different from "parameters not set"', () => {
  let doc = exampleDoc();
  doc = withSteps(doc, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', { startMin: 20, durationMin: 99, enabled: false }));
  assert.doesNotThrow(() => validateDocument(doc));
  assert.equal(formatSourceAssignment(doc, step(doc, 5).sourceAssignments[2]), 'Магнетрон magnetron-2 (мишень: Al): ОТКЛ на этапе');
  const unset = withSteps(baseDoc(), s => addSourceAssignment(s, 5, 'magnetron', 'magnetron-1'));
  const text = formatSourceAssignment(unset, step(unset, 5).sourceAssignments[0]);
  assert.ok(text.includes('ВКЛ, мощность — не задана, время — не задано'));
  assert.ok(!text.includes('ОТКЛ'));
  const zeroPower = withSteps(unset, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { powerW: 0 }));
  assert.ok(formatSourceAssignment(zeroPower, step(zeroPower, 5).sourceAssignments[0]).includes('мощность — 0 Вт'), 'zero is a value, not "not set"');
});

// =====================================================================================
// Parallel / sequential
// =====================================================================================

test('mode: sequential = no overlap with any other ENABLED source of the step (touching is allowed); parallel has no constraint', () => {
  const doc = exampleDoc();
  const seq = (order: 'magnetron-1' | 'arc-1' | 'magnetron-2', kind: 'magnetron' | 'arc', patch: object) => withSteps(doc, s => updateSourceAssignment(s, 5, kind, order, { mode: 'sequential', ...patch }));
  assert.throws(() => validateDocument(seq('arc-1', 'arc', {})), /работает последовательно, но его интервал \(5–15 мин\) пересекается с интервалом Магнетрон magnetron-1 \(0–30 мин\)/);
  assert.doesNotThrow(() => validateDocument(withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { mode: 'parallel' }))), 'overlap is fine in parallel');

  let chain = withSteps(doc, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { startMin: 0, durationMin: 5 }));
  chain = withSteps(chain, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { startMin: 5, durationMin: 10, mode: 'sequential' }));
  chain = withSteps(chain, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', { startMin: 15, durationMin: 15, mode: 'sequential' }));
  chain = withSteps(chain, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { mode: 'sequential' }));
  assert.doesNotThrow(() => validateDocument(chain), 'a back-to-back chain 0-5, 5-15, 15-30 is consistent');
  assert.throws(() => validateDocument(withSteps(chain, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { startMin: 4.9 }))), /пересекается/);
  assert.throws(() => validateDocument(withSteps(chain, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', { startMin: 14 }))), /пересекается/);
});

test('mode: a sequential source needs its own start and duration; an OFF source never blocks it; unknown timing of others is a warning, not an error', () => {
  const doc = exampleDoc();
  const noTiming = withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { mode: 'sequential', startMin: undefined }));
  assert.throws(() => validateDocument(noTiming), /для последовательного режима нужно задать начало и длительность/);
  const off = withSteps(doc, s => updateSourceAssignment(updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { enabled: false }), 5, 'arc', 'arc-1', { mode: 'sequential' }));
  assert.doesNotThrow(() => validateDocument(off), 'the overlapping source is OFF, so nothing overlaps - but magnetron-2 (15-30) does not overlap 5-15 either');
  const unknownOther = withSteps(doc, s => updateSourceAssignment(updateSourceAssignment(s, 5, 'magnetron', 'magnetron-2', { startMin: undefined, durationMin: undefined }), 5, 'arc', 'arc-1', { mode: 'sequential' }));
  const loose = withSteps(unknownOther, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { enabled: false }));
  assert.doesNotThrow(() => validateDocument(loose));
  assert.ok(collectStepWarnings(loose).some(w => w.includes('Магнетрон magnetron-2') && w.includes('проверить нельзя')));
});

test('mode: the documents state what "sequential" means whenever it is used', () => {
  const doc = withSteps(exampleDoc(), s => updateSourceAssignment(updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { startMin: 0, durationMin: 5, mode: 'sequential' }), 5, 'arc', 'arc-1', { mode: 'sequential' }));
  assert.doesNotThrow(() => validateDocument(doc));
  assert.ok(buildInstructionView(doc).includes('Последовательный режим: интервал работы источника не пересекается с интервалами других включённых источников этого этапа'));
  assert.ok(!buildInstructionView(exampleDoc()).includes('Последовательный режим:'), 'not mentioned when unused');
});

// =====================================================================================
// Gas lines
// =====================================================================================

function gasDoc(): TechnicalProcessDocument {
  return withSteps(baseDoc(), steps => {
    let s = steps;
    s = addGasAssignment(s, 5, 'gas-1'); s = updateGasAssignment(s, 5, 'gas-1', { flowSccm: 40, startMin: 0, durationMin: 30 });
    s = addGasAssignment(s, 5, 'gas-2'); s = updateGasAssignment(s, 5, 'gas-2', { flowSccm: 10, startMin: 5, durationMin: 20 });
    s = addGasAssignment(s, 5, 'gas-3'); s = updateGasAssignment(s, 5, 'gas-3', { flowSccm: 5 });
    return s;
  });
}

test('gas: several lines run at once; two lines may feed the same gas; flow is sccm with its meaning stated', () => {
  const doc = gasDoc();
  assert.doesNotThrow(() => validateDocument(doc));
  assert.deepEqual(buildStepAssignmentLines(doc, step(doc, 5)).gases, [
    'Линия gas-1 (газ: Ar): ВКЛ, расход — 40 sccm, подача — 0–30 мин',
    'Линия gas-2 (газ: N2): ВКЛ, расход — 10 sccm, подача — 5–25 мин',
    'Линия gas-3 (газ: Ar): ВКЛ, расход — 5 sccm, подача — не задано',
  ]);
  assert.ok(buildStepAssignmentLines(doc, step(doc, 5)).notes.some(n => n.includes('sccm - стандартные см³/мин') && n.includes('не пересчитываются')));
  assert.deepEqual(findGasLineUsage(doc, 'gas-1'), [5]);
  const off = withSteps(doc, s => updateGasAssignment(s, 5, 'gas-2', { enabled: false }));
  assert.equal(formatGasAssignment(off, step(off, 5).gasAssignments[1]), 'Линия gas-2 (газ: N2): ОТКЛ на этапе');
});

test('gas: the unit is never converted - a line kept in another unit only produces a warning, and the step flow stays as typed in sccm', () => {
  let doc = gasDoc();
  doc = { ...doc, gasSystem: updateGasLine(doc.gasSystem, 'gas-1', { unit: 'см³/мин', flow: 50 }) };
  assert.equal(step(doc, 5).gasAssignments[0].flowSccm, 40);
  assert.ok(formatGasAssignment(doc, step(doc, 5).gasAssignments[0]).includes('расход — 40 sccm'));
  assert.ok(collectStepWarnings(doc).some(w => w.includes('линия gas-1') && w.includes('«см³/мин»') && w.includes('не пересчитывается')));
  assert.ok(!collectStepWarnings(gasDoc()).some(w => w.includes('не пересчитывается')), 'sccm lines produce no unit warning');
  const unnamed = { ...doc, gasSystem: updateGasLine(doc.gasSystem, 'gas-2', { gas: '' }) };
  assert.ok(collectStepWarnings(unnamed).some(w => w.includes('для линии gas-2') && w.includes('не указан газ')));
  assert.ok(formatGasAssignment(unnamed, step(unnamed, 5).gasAssignments[1]).includes('газ: не указан в разделе E'));
});

test('gas: consistency with section E - a disabled or missing line cannot be silently used; times and flows are checked', () => {
  const doc = gasDoc();
  const disabled = withSteps({ ...doc, gasSystem: updateGasLine(doc.gasSystem, 'gas-4', { enabled: false }) }, s => addGasAssignment(s, 5, 'gas-4'));
  assert.throws(() => validateDocument(disabled), /линия gas-4 отключена в газовой системе \(раздел E\)/);
  assert.doesNotThrow(() => validateDocument(withSteps(disabled, s => updateGasAssignment(s, 5, 'gas-4', { enabled: false }))), 'an explicit OFF on a disabled line is consistent');
  const lineOff = { ...doc, gasSystem: updateGasLine(doc.gasSystem, 'gas-1', { enabled: false }) };
  assert.throws(() => validateDocument(lineOff), /линия gas-1 отключена/, 'switching a used line off in E is caught');
  const missing = withSteps(doc, s => addGasAssignment(s, 5, 'gas-77'));
  assert.throws(() => validateDocument(missing), /линия gas-77, которой нет в разделе E/);
  assert.throws(() => validateDocument(withSteps(doc, s => updateGasAssignment(s, 5, 'gas-1', { flowSccm: -1 }))), /расход.*отрицательным/);
  assert.throws(() => validateDocument(withSteps(doc, s => updateGasAssignment(s, 5, 'gas-1', { startMin: 20, durationMin: 20 }))), /выходит за пределы этапа/);
  assert.throws(() => validateDocument(withSteps(doc, s => updateGasAssignment(s, 5, 'gas-1', { startMin: -1 }))), /начало.*отрицательным/);
  const twice = withSteps(doc, s => s.map(x => x.order === 5 ? { ...x, gasAssignments: [...x.gasAssignments, { ...x.gasAssignments[0] }] } : x));
  assert.throws(() => validateDocument(twice), /назначена на этап дважды/);
  const dupLine = { ...doc, gasSystem: [...doc.gasSystem, { ...doc.gasSystem[0] }] };
  assert.throws(() => validateDocument(dupLine), /повторяется идентификатор линии «gas-1»/);
});

test('sources: consistency with section D - a missing or unavailable source cannot be used; a duplicate assignment is rejected', () => {
  const doc = exampleDoc();
  assert.throws(() => validateDocument(withSteps(doc, s => addSourceAssignment(s, 5, 'arc', 'arc-9'))), /Дуговой источник arc-9, которого нет в разделе D/);
  assert.throws(() => validateDocument(withSteps(doc, s => addSourceAssignment(s, 5, 'arc', 'magnetron-1'))), /нет в разделе D/, 'a magnetron id is not an arc source');
  const unavailable = { ...doc, sources: { ...doc.sources, magnetrons: doc.sources.magnetrons.map(m => m.id === 'magnetron-1' ? { ...m, enabled: false } : m) } };
  assert.throws(() => validateDocument(unavailable), /Магнетрон magnetron-1 отключён в установке \(раздел D\)/);
  const offOnStep = withSteps(unavailable, s => updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { enabled: false }));
  assert.doesNotThrow(() => validateDocument(offOnStep));
  const twice = withSteps(doc, s => s.map(x => x.order === 5 ? { ...x, sourceAssignments: [...x.sourceAssignments, { ...x.sourceAssignments[0] }] } : x));
  assert.throws(() => validateDocument(twice), /назначен на этап дважды/);
  assert.throws(() => validateDocument(withSteps(doc, s => s.map(x => x.order === 5 ? { ...x, sourceAssignments: x.sourceAssignments.map((a, i) => i === 0 ? { ...a, mode: 'both' as never } : a) } : x))), /недопустимый режим/);
});

// =====================================================================================
// Deleting something that is in use
// =====================================================================================

test('delete: a used source or gas line is NOT removed - the document is returned unchanged with the steps that use it', () => {
  let doc = exampleDoc();
  doc = withSteps(doc, s => updateStep(addSourceAssignment(s, 6, 'magnetron', 'magnetron-1'), 6, { durationMin: 20 }));
  doc = withSteps(doc, s => addGasAssignment(s, 6, 'gas-1'));
  const blocked = removeSourceFromDocument(doc, 'magnetron', 'magnetron-1');
  assert.deepEqual(blocked.blockedBySteps, [5, 6]);
  assert.equal(blocked.document, doc, 'the very same object - nothing changed');
  assert.equal(blocked.document.sources.magnetrons.length, 2);
  const blockedGas = removeGasLineFromDocument(doc, 'gas-1');
  assert.deepEqual(blockedGas.blockedBySteps, [6]);
  assert.equal(blockedGas.document, doc);
  // unused ones are removed
  const unusedSource = removeSourceFromDocument(doc, 'arc', 'arc-2');
  assert.deepEqual(unusedSource.blockedBySteps, []);
  assert.deepEqual(unusedSource.document.sources.arcSources.map(a => a.id), ['arc-1']);
  const unusedLine = removeGasLineFromDocument(doc, 'gas-5');
  assert.equal(unusedLine.document.gasSystem.length, 4);
  // after the assignments are taken off the step, removal works
  let released = withSteps(doc, s => removeSourceAssignment(removeSourceAssignment(s, 5, 'magnetron', 'magnetron-1'), 6, 'magnetron', 'magnetron-1'));
  const removed = removeSourceFromDocument(released, 'magnetron', 'magnetron-1');
  assert.deepEqual(removed.blockedBySteps, []);
  assert.deepEqual(removed.document.sources.magnetrons.map(m => m.id), ['magnetron-2']);
  assert.doesNotThrow(() => validateDocument(removed.document));
  released = withSteps(released, s => removeGasAssignment(s, 6, 'gas-1'));
  assert.doesNotThrow(() => validateDocument(removeGasLineFromDocument(released, 'gas-1').document));
});

test('delete: if a used source is removed anyway (bypassing the guard), validation reports it instead of silently dropping the settings', () => {
  const doc = exampleDoc();
  const bypass = { ...doc, sources: { ...doc.sources, magnetrons: doc.sources.magnetrons.filter(m => m.id !== 'magnetron-2') } };
  assert.throws(() => validateDocument(bypass), /Этап №5: назначен Магнетрон magnetron-2, которого нет в разделе D/);
  assert.equal(step(bypass, 5).sourceAssignments.length, 3, 'the settings are still there');
  const bypassGas = { ...gasDoc(), gasSystem: removeGasLine(gasDoc().gasSystem, 'gas-2') };
  assert.throws(() => validateDocument(bypassGas), /Этап №5: назначена линия gas-2, которой нет в разделе E/);
});

test('gas line ids stay unique: added lines get fresh ids, also after removals', () => {
  let lines = createDefaultGasLines();
  for (let i = 0; i < 5; i++) lines = addGasLine(lines);
  assert.equal(new Set(lines.map(l => l.id)).size, 10);
  assert.deepEqual(lines.slice(5).map(l => l.id), ['gas-6', 'gas-7', 'gas-8', 'gas-9', 'gas-10']);
  lines = removeGasLine(lines, 'gas-3');
  lines = addGasLine(lines);
  assert.equal(new Set(lines.map(l => l.id)).size, lines.length);
});

test('duplicating a step copies its assignments independently', () => {
  const doc = exampleDoc();
  const steps = duplicateStep(doc.steps, 5);
  assert.deepEqual(steps[5].sourceAssignments, steps[4].sourceAssignments);
  const edited = updateSourceAssignment(steps, 6, 'magnetron', 'magnetron-1', { powerW: 1 });
  assert.equal(edited[4].sourceAssignments[0].powerW, 2000);
  assert.equal(edited[5].sourceAssignments[0].powerW, 1);
});

// =====================================================================================
// Saving, restoring, migration
// =====================================================================================

function fullDoc(): TechnicalProcessDocument {
  let doc = withSteps(exampleDoc(), steps => {
    let s = updateStep(steps, 6, { durationMin: 40, pressurePa: 0.5, substrateBiasV: -80, rotationRpm: 5, temperatureC: 350 });
    s = addSourceAssignment(s, 6, 'magnetron', 'magnetron-1');
    s = updateSourceAssignment(s, 6, 'magnetron', 'magnetron-1', { powerW: 3500, startMin: 10, durationMin: 20, mode: 'sequential' });
    s = addSourceAssignment(s, 6, 'arc', 'arc-2');
    s = updateSourceAssignment(s, 6, 'arc', 'arc-2', { currentA: 60, enabled: false });
    s = addGasAssignment(s, 6, 'gas-1'); s = updateGasAssignment(s, 6, 'gas-1', { flowSccm: 40, startMin: 0, durationMin: 40 });
    return s;
  });
  doc = withSteps(doc, steps => {
    const s = addGasAssignment(steps, 5, 'gas-2');
    return updateGasAssignment(s, 5, 'gas-2', { flowSccm: 12, startMin: 5, durationMin: 20 });
  });
  return { ...doc, pressureUnit: 'mbar' };
}
const restoreOk = (value: unknown) => {
  const result = restoreDocumentDetailed(JSON.stringify(value));
  assert.equal(result.status, 'ok', JSON.stringify(result));
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
};

test('full cycle: create -> configure -> save -> restore -> edit -> save again: links, ids and every value survive; no duplicates appear', () => {
  const doc = fullDoc();
  assert.doesNotThrow(() => validateDocument(doc));
  const first = restoreOk(touchDocument(doc));
  assert.equal(first.migratedFromSchema, undefined);
  assert.deepEqual(json(first.document.steps), json(doc.steps), 'every step, with its assignments, comes back identical');
  assert.deepEqual(json(first.document.sources), json(doc.sources));
  assert.equal(first.document.pressureUnit, 'mbar');
  assert.equal(first.document.schemaVersion, 3);

  // edit after restore: change a parameter, add and remove assignments
  let edited = first.document;
  edited = withSteps(edited, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { currentA: 90 }));
  edited = withSteps(edited, s => addSourceAssignment(s, 5, 'arc', 'arc-2'));
  edited = withSteps(edited, s => addSourceAssignment(s, 5, 'arc', 'arc-2'));
  edited = withSteps(edited, s => removeGasAssignment(s, 5, 'gas-2'));
  const second = restoreOk(touchDocument(edited));
  const s5 = step(second.document, 5);
  assert.equal(s5.sourceAssignments.find(a => a.sourceId === 'arc-1')!.currentA, 90);
  assert.equal(s5.sourceAssignments.filter(a => a.sourceId === 'arc-2').length, 1, 'no duplicate assignment');
  assert.equal(s5.gasAssignments.length, 0);
  assert.deepEqual(json(step(second.document, 6)), json(step(doc, 6)), 'the untouched step is bit-for-bit what was configured');
  for (let i = 0; i < 5; i++) {
    const again = restoreOk(touchDocument(second.document));
    assert.deepEqual(json(again.document.steps), json(second.document.steps), `cycle ${i}`);
    assert.equal(again.repairedSourceIds + again.repairedGasLineIds, 0);
  }
});

test('migration: a schema-2 document (no assignments) opens with every parameter intact and empty assignment lists', () => {
  const doc = json(baseDoc());
  doc.schemaVersion = 2;
  for (const s of doc.steps) { delete s.sourceAssignments; delete s.gasAssignments; }
  doc.steps[4].temperatureC = 250; doc.steps[4].pressurePa = 0.5; doc.steps[4].powerW = 3000; doc.steps[4].sourceConfiguration = 'M1+A1'; doc.steps[4].gasUsage = [{ gas: 'Ar', flowSccm: 40 }];
  const result = restoreOk(doc);
  assert.equal(result.migratedFromSchema, 2);
  assert.equal(result.document.schemaVersion, 3);
  const s5 = step(result.document, 5);
  assert.deepEqual([s5.temperatureC, s5.pressurePa, s5.powerW, s5.sourceConfiguration, s5.gasUsage], [250, 0.5, 3000, 'M1+A1', [{ gas: 'Ar', flowSccm: 40 }]]);
  assert.deepEqual(result.document.steps.map(s => [s.sourceAssignments, s.gasAssignments]), result.document.steps.map(() => [[], []]));
  assert.deepEqual(json(result.document.sources), json(doc.sources));
  assert.deepEqual(json(result.document.gasSystem), json(doc.gasSystem));
  assert.equal(result.repairedSourceIds, 0);
  assert.equal(restoreOk(touchDocument(result.document)).migratedFromSchema, undefined, 'saved as schema 3 afterwards: not migrated again');
});

test('migration: a schema-1 document gets BOTH migrations - 0.005 mbar -> 0.5 Pa and empty assignments - and loses nothing', () => {
  const doc = json(baseDoc());
  delete doc.schemaVersion; delete doc.pressureUnit;
  for (const s of doc.steps) { delete s.sourceAssignments; delete s.gasAssignments; delete s.pressurePa; }
  doc.steps[5].pressureMbar = 0.005; doc.steps[5].description = 'legacy\nmultiline';
  const result = restoreOk(doc);
  assert.equal(result.migratedFromSchema, 1);
  assert.equal(step(result.document, 6).pressurePa, 0.5);
  assert.equal(step(result.document, 6).description, 'legacy\nmultiline');
  assert.equal(step(result.document, 6).sourceAssignments.length, 0);
  assert.equal(result.document.schemaVersion, 3);
});

test('migration: an older document that happens to contain assignment fields does not get them interpreted (schema < 3 has none)', () => {
  const doc = json(fullDoc());
  doc.schemaVersion = 2;
  const result = restoreOk(doc);
  assert.ok(result.document.steps.every(s => s.sourceAssignments.length === 0 && s.gasAssignments.length === 0));
});

test('restore: a saved document whose steps point at a missing source or line is not loaded half-broken (status invalid; storage untouched)', () => {
  const doc = json(fullDoc());
  doc.sources.magnetrons = doc.sources.magnetrons.filter((m: { id: string }) => m.id !== 'magnetron-1');
  assert.equal(restoreDocumentDetailed(JSON.stringify(doc)).status, 'invalid');
  const noLine = json(fullDoc());
  noLine.gasSystem = noLine.gasSystem.filter((l: { id: string }) => l.id !== 'gas-1');
  assert.equal(restoreDocumentDetailed(JSON.stringify(noLine)).status, 'invalid');
  assert.equal(tryRestoreDocument(JSON.stringify(noLine)), null);
});

test('restore: a future schema (4) is still reported and never parsed; duplicate gas line ids that NO step uses are repaired', () => {
  assert.deepEqual(restoreDocumentDetailed(JSON.stringify({ ...json(fullDoc()), schemaVersion: 4 })), { status: 'future_version', schemaVersion: 4 });
  const doc = json(fullDoc());
  doc.gasSystem = [...doc.gasSystem, { ...doc.gasSystem[4], gas: 'He' }]; // gas-5 is used by no step
  const result = restoreOk(doc);
  assert.equal(result.repairedGasLineIds, 1);
  assert.equal(new Set(result.document.gasSystem.map(l => l.id)).size, result.document.gasSystem.length);
  assert.equal(result.document.gasSystem[4].id, 'gas-5', 'the first owner of an id keeps it');
  assert.ok(formatGasAssignment(result.document, step(result.document, 6).gasAssignments[0]).includes('газ: Ar'));
  assert.deepEqual(json(step(result.document, 6).gasAssignments), json(step(fullDoc(), 6).gasAssignments), 'assignments untouched');
});

test('restore: Stage 1 id repair still works with assignments when the duplicated source id is not referenced', () => {
  const doc = json(exampleDoc());
  doc.sources.arcSources = [doc.sources.arcSources[0], { id: 'arc-2', enabled: true, cathodeMaterial: 'Zr' }, { id: 'arc-2', enabled: true, cathodeMaterial: 'Duplicate' }];
  const result = restoreOk(doc);
  assert.equal(result.repairedSourceIds, 1);
  assert.equal(new Set(result.document.sources.arcSources.map(a => a.id)).size, 3);
  assert.ok(formatSourceAssignment(result.document, step(result.document, 5).sourceAssignments[1]).includes('катод: Cr'));
  assert.equal(ensureUniqueSourceIds(result.document.sources).repaired, 0);
});

test('parse: untrusted assignment data - bad kind/id/mode/number, oversize lists are rejected; irrelevant fields are dropped; defaults are explicit', () => {
  const make = (patch: object) => { const d = json(baseDoc()); Object.assign(d.steps[4], patch); return d; };
  const good = { sourceId: 'magnetron-1', kind: 'magnetron' };
  for (const bad of [{ sourceAssignments: [{ ...good, kind: 'ion' }] }, { sourceAssignments: [{ ...good, sourceId: '' }] }, { sourceAssignments: [{ ...good, sourceId: 5 }] },
    { sourceAssignments: [{ ...good, mode: 'both' }] }, { sourceAssignments: [{ ...good, powerW: 'x' }] }, { sourceAssignments: [{ ...good, startMin: '5' }] }, { sourceAssignments: 'nope' },
    { sourceAssignments: Array.from({ length: 51 }, () => good) }, { gasAssignments: [{ lineId: '' }] }, { gasAssignments: [{ lineId: 3 }] }, { gasAssignments: [{ lineId: 'gas-1', flowSccm: 'x' }] }, { sourceAssignments: [null] }]) {
    assert.throws(() => parseTechnicalProcessDocument(make(bad)), Error, JSON.stringify(bad).slice(0, 80));
  }
  const parsed = parseTechnicalProcessDocument(make({
    sourceAssignments: [{ sourceId: 'magnetron-1', kind: 'magnetron', currentA: 99, powerW: 10, junk: true }, { sourceId: 'arc-1', kind: 'arc', powerW: 77, currentA: 5, enabled: false, mode: 'sequential' }],
    gasAssignments: [{ lineId: 'gas-1', extra: 1 }],
  }));
  const [m, a] = step(parsed, 5).sourceAssignments;
  assert.deepEqual(json(m), { sourceId: 'magnetron-1', kind: 'magnetron', mode: 'parallel', enabled: true, powerW: 10 }, 'a magnetron has no arc current; absent enabled/mode default explicitly');
  assert.deepEqual(json(a), { sourceId: 'arc-1', kind: 'arc', mode: 'sequential', enabled: false, currentA: 5 }, 'an arc source has no magnetron power');
  assert.deepEqual(json(step(parsed, 5).gasAssignments), [{ lineId: 'gas-1', enabled: true }]);
});

// =====================================================================================
// Views and exports
// =====================================================================================

test('preview: the instruction shows, for the step, every source and gas line with material, ON/OFF, power/current, window, mode and flow', () => {
  const doc = withSteps(fullDoc(), s => updateGasAssignment(s, 5, 'gas-2', { enabled: false }));
  const preview = buildInstructionView(doc);
  for (const text of [
    'Источники на этапе (из раздела D):',
    'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 2000 Вт, время — 0–30 мин, режим — одновременно',
    'Дуговой источник arc-1 (катод: Cr, фильтрованный): ВКЛ, ток дуги — 80 А, время — 5–15 мин, режим — одновременно',
    'Магнетрон magnetron-2 (мишень: Al): ВКЛ, мощность — 1500 Вт, время — 15–30 мин, режим — одновременно',
    'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 3500 Вт, время — 10–30 мин, режим — последовательно',
    'Дуговой источник arc-2 (катод: Zr): ОТКЛ на этапе',
    'Газовые линии на этапе (из раздела E):',
    'Линия gas-1 (газ: Ar): ВКЛ, расход — 40 sccm, подача — 0–40 мин',
    'Линия gas-2 (газ: N2): ОТКЛ на этапе',
    'Давление: 0.005 мбар',
  ]) assert.ok(preview.includes(text), text);
  assert.ok(preview.includes('- Источник/мощность: см. «Источники на этапе» ниже'), 'the general line points at the structured block instead of showing a misleading dash');
  assert.ok(preview.includes('## D. Источники (справочник оборудования;') && preview.includes('Магнетрон magnetron-1 (в установке: доступен)'));
  assert.ok(preview.includes('## E. Газовая система (справочник линий;') && preview.includes('Линия gas-1 (в системе: включена): газ — Ar, расход (справочно)'));
});

test('technological card: a cell lists the general values AND all assignments - it never shows less than the editor holds; the note says so', () => {
  const doc = fullDoc();
  const row5 = buildTechnologicalCard(doc).find(r => r.number === 5)!;
  for (const text of ['Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 2000 Вт, время — 0–30 мин, режим — одновременно', 'Дуговой источник arc-1 (катод: Cr, фильтрованный)', 'Магнетрон magnetron-2']) assert.ok(row5.sourcePower.includes(text), text);
  assert.ok(row5.gases.includes('Линия gas-2 (газ: N2): ВКЛ, расход — 12 sccm, подача — 5–25 мин'));
  const withLegacy = withSteps(doc, s => updateStep(s, 5, { sourceConfiguration: 'M1+A1', powerW: 3000, gasUsage: [{ gas: 'Ar', flowSccm: 40 }] }));
  const legacyRow = buildTechnologicalCard(withLegacy).find(r => r.number === 5)!;
  assert.ok(legacyRow.sourcePower.startsWith('M1+A1, 3000 Вт; Магнетрон magnetron-1'));
  assert.ok(legacyRow.gases.startsWith('Ar (40 sccm); Линия gas-2'));
  assert.equal(buildTechnologicalCard(doc).find(r => r.number === 1)!.sourcePower, '—');
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.sections[0].heading, 'Примечание');
  assert.ok(vm.sections[0].paragraphs.join('\n').includes('перечислены общие значения этапа и все назначения'));
  assert.ok(vm.sections[0].paragraphs.join('\n').includes('Последовательный режим:'));
  assert.deepEqual(buildDocumentViewModel(baseDoc(), 'technologicalCard').sections, [], 'no note when nothing is assigned');
  assert.ok(!JSON.stringify(buildRouteCard(doc)).includes('magnetron-1'), 'the route card has no source/gas columns and claims none');
});

test('brief recipe: says it is abbreviated and states how many assignments each step has, instead of looking complete', () => {
  const doc = fullDoc();
  const recipe = buildBriefRecipe(doc);
  assert.ok(recipe.includes('Сокращённое представление:') && recipe.includes('полные данные в технологической инструкции'));
  assert.ok(recipe.includes('5. ') && recipe.includes('[назначено: источников 3 (включено 3), газовых линий 1 (включено 1) - см. инструкцию]'));
  assert.ok(recipe.includes('[назначено: источников 2 (включено 1), газовых линий 1 (включено 1) - см. инструкцию]'));
  assert.ok(!buildBriefRecipe(baseDoc()).includes('Сокращённое представление') && !buildBriefRecipe(baseDoc()).includes('[назначено'), 'unchanged when nothing is assigned');
  assert.ok(buildDocumentViewModel(doc, 'recipe').sections[0].paragraphs[0].startsWith('Сокращённое представление'));
});

test('export view model: the step paragraph carries the same lines as the preview (no divergence), plus the units note', () => {
  const doc = fullDoc();
  const vm = buildDocumentViewModel(doc, 'instruction');
  const params = vm.sections.find(s => s.heading.startsWith('7.'))!.paragraphs;
  for (const order of [5, 6]) {
    const paragraph = params.find(p => p.startsWith(`№${order}.`))!;
    const lines = buildStepAssignmentLines(doc, step(doc, order));
    for (const line of [...lines.sources, ...lines.gases, ...lines.notes]) assert.ok(paragraph.includes(line), `step ${order}: ${line}`);
    assert.ok(paragraph.includes('Источники на этапе (из раздела D):') && paragraph.includes('Газовые линии на этапе (из раздела E):'));
  }
  assert.ok(params.at(-1)!.startsWith('Единицы: давление — мбар (хранится в паскалях); расход газа — sccm - стандартные см³/мин'));
  assert.ok(params.some(p => p.includes('Магнетрон magnetron-1 (в установке: доступен): материал — Ti')));
  const unassigned = params.find(p => p.startsWith('№4.'))!;
  assert.ok(!unassigned.includes('Источники на этапе'), 'steps without assignments are unchanged');
  assert.ok(unassigned.includes('давление: не задано;'));
});

test('DOCX and PDF of the instruction contain every source and gas assignment of the editor, with materials, ON/OFF, windows, modes, sccm', async () => {
  const doc = fullDoc();
  const expected = [
    'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 2000 Вт, время — 0–30 мин, режим — одновременно',
    'Дуговой источник arc-1 (катод: Cr, фильтрованный): ВКЛ, ток дуги — 80 А, время — 5–15 мин, режим — одновременно',
    'Магнетрон magnetron-2 (мишень: Al): ВКЛ, мощность — 1500 Вт, время — 15–30 мин, режим — одновременно',
    'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 3500 Вт, время — 10–30 мин, режим — последовательно',
    'Дуговой источник arc-2 (катод: Zr): ОТКЛ на этапе',
    'Линия gas-1 (газ: Ar): ВКЛ, расход — 40 sccm, подача — 0–40 мин',
    'Линия gas-2 (газ: N2): ВКЛ, расход — 12 sccm, подача — 5–25 мин',
    'Последовательный режим: интервал работы источника не пересекается',
    'расход газа — sccm - стандартные см³/мин',
    'давление: 0.005 мбар;',
  ];
  const docx = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  const pdf = await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer);
  for (const text of expected) {
    assert.ok(docx.includes(flat(text)), `DOCX is missing: ${text}`);
    assert.ok(pdf.includes(flat(text)), `PDF is missing: ${text}`);
  }
  // parity: every line of the on-screen preview's assignment blocks is in the exported document
  for (const order of [5, 6]) {
    const lines = buildStepAssignmentLines(doc, step(doc, order));
    for (const line of [...lines.sources, ...lines.gases]) assert.ok(docx.includes(flat(line)) && pdf.includes(flat(line)), `preview line missing in export: ${line}`);
  }
});

test('DOCX and PDF of the technological card and the brief recipe carry the assignments / the abbreviation notice; the route card still exports', async () => {
  const doc = fullDoc();
  for (const [type, needles] of [
    ['technologicalCard', ['Магнетрон magnetron-1 (мишень: Ti)', 'Линия gas-1 (газ: Ar)', 'перечислены общие значения этапа и все назначения']],
    ['recipe', ['Сокращённое представление', 'источников 3 (включено 3)']],
  ] as const) {
    const docx = flat(docxPlain((await exportTechDoc(doc, type, 'docx')).buffer));
    const pdf = await pdfText((await exportTechDoc(doc, type, 'pdf')).buffer);
    for (const needle of needles) { assert.ok(docx.includes(needle), `${type} docx: ${needle}`); assert.ok(pdf.includes(needle), `${type} pdf: ${needle}`); }
  }
  for (const format of ['docx', 'pdf'] as const) assert.ok((await exportTechDoc(doc, 'routeCard', format)).buffer.length > 0);
});

test('the legacy step gas list is labelled sccm (it holds sccm), not "см³/мин"', async () => {
  const doc = withSteps(baseDoc(), s => updateStep(s, 5, { gasUsage: [{ gas: 'Ar', flowSccm: 40 }] }));
  assert.ok(buildInstructionView(doc).includes('- Газы: Ar (40 sccm)'));
  const text = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  assert.ok(text.includes('газы: Ar (40 sccm)') && !text.includes('см³/мин)'));
});

test('export API: a schema-3 payload with assignments exports; a dangling reference is a clear 400; a schema-2 payload is migrated and exported', async () => {
  const post = (document: unknown, format: 'docx' | 'pdf' = 'docx') => exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document, documentType: 'instruction', format }),
  }));
  const ok = await post(fullDoc());
  assert.equal(ok.status, 200);
  assert.ok(flat(docxPlain(Buffer.from(await ok.arrayBuffer()))).includes('Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 2000 Вт'));
  const dangling = json(fullDoc());
  dangling.steps[4].sourceAssignments.push({ sourceId: 'arc-9', kind: 'arc', enabled: true, mode: 'parallel' });
  const bad = await post(dangling);
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(await bad.json()), /Дуговой источник arc-9, которого нет в разделе D/);
  const v2 = json(baseDoc());
  v2.schemaVersion = 2;
  for (const s of v2.steps) { delete s.sourceAssignments; delete s.gasAssignments; }
  const migrated = await post(v2, 'pdf');
  assert.equal(migrated.status, 200);
  assert.ok((await pdfText(Buffer.from(await migrated.arrayBuffer()))).includes('Hybrid_Stage3'));
});

test('Stage 1 and Stage 2 behaviour is intact: ids, descriptions, pressure units and migration live next to assignments', async () => {
  let doc = fullDoc();
  doc = withSteps(doc, s => updateStep(s, 5, { description: 'UNIQUE-STAGE3-DESC\nline two', pressurePa: 1e-5 }));
  const restored = restoreOk(touchDocument(doc));
  assert.equal(step(restored.document, 5).pressurePa, 1e-5);
  assert.equal(restored.document.pressureUnit, 'mbar');
  const text = flat(docxPlain((await exportTechDoc(restored.document, 'instruction', 'docx')).buffer));
  assert.ok(text.includes('Описание: UNIQUE-STAGE3-DESC line two'));
  assert.ok(text.includes('давление: 1e-7 мбар;'));
  assert.deepEqual(restored.document.sources.magnetrons.map(m => m.id), ['magnetron-1', 'magnetron-2']);
});

// =====================================================================================
// Table layout (technological card)
// =====================================================================================

test('card layout: the Gases and Source/power columns are the widest, the table keeps equal columns when no weights are given, and the block after a table starts at the left margin', async () => {
  const doc = fullDoc();
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  const weights = vm.tables[0].columnWeights!;
  assert.equal(weights.length, vm.tables[0].columns.length);
  const [gases, source] = ['Газы', 'Источник/мощность'].map(name => weights[vm.tables[0].columns.indexOf(name)]);
  assert.ok(weights.every(w => w <= source) && gases === Math.max(...weights.filter(w => w !== source)));
  const route = buildDocumentViewModel(doc, 'routeCard').tables[0];
  assert.equal(route.columnWeights, undefined, 'other tables keep equal widths');

  const docx = readZipEntryText((await exportTechDoc(doc, 'technologicalCard', 'docx')).buffer, 'word/document.xml');
  const widths = [...docx.matchAll(/<w:tcW w:type="pct" w:w="(\d+)%"\/>|<w:tcW w:w="(\d+)%" w:type="pct"\/>/g)].slice(0, 10).map(m => Number(m[1] ?? m[2]));
  assert.equal(widths.length, 10);
  assert.ok(widths[6] > widths[1] * 2 && widths[5] > widths[1], `DOCX header widths follow the weights: ${widths}`);

  const pdf = await pdfText((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.ok(pdf.includes('Traceability') && pdf.includes('Источник: preset: hybrid-magnetron-arc'), 'the traceability block after the table is complete, not clipped at the right edge');
  assert.ok(pdf.includes('Примечание: Полей, вычисленных системой, нет.'));
});

// =====================================================================================
// Audit fixes: gas line id reservation, legacy/structured conflicts, warnings in exports,
// zero-length intervals, time overflow
// =====================================================================================

function rawWithLines(lines: object[], assignmentLineId?: string) {
  const raw = json(baseDoc());
  raw.gasSystem = lines;
  raw.steps[4].gasAssignments = assignmentLineId ? [{ lineId: assignmentLineId, enabled: true, flowSccm: 10 }] : [];
  return raw;
}
const lineOf = (doc: TechnicalProcessDocument, order: number, index = 0) => doc.gasSystem.find(l => l.id === step(doc, order).gasAssignments[index].lineId);

test('gas ids (HIGH): an id-less line never takes an id another line explicitly owns - the audit case Ar (no id) / N2 "gas-0" keeps the assignment on N2', () => {
  const raw = rawWithLines([{ gas: 'Ar', unit: 'sccm', enabled: true }, { id: 'gas-0', gas: 'N2', unit: 'sccm', enabled: true }], 'gas-0');
  const result = restoreOk(raw);
  assert.equal(lineOf(result.document, 5)!.gas, 'N2', 'the assignment still points at N2');
  assert.deepEqual(result.document.gasSystem.map(l => `${l.gas}:${l.id}`), ['Ar:gas-1', 'N2:gas-0']);
  assert.ok(formatGasAssignment(result.document, step(result.document, 5).gasAssignments[0]).includes('газ: N2'));
  assert.equal(result.repairedGasLineIds, 0, 'nothing is "repaired" - the id was simply missing');
  const again = restoreOk(touchDocument(result.document));
  assert.deepEqual(again.document.gasSystem.map(l => l.id), ['gas-1', 'gas-0']);
  assert.deepEqual(json(step(again.document, 5).gasAssignments), json(step(result.document, 5).gasAssignments));
});

test('gas ids: explicit ids are reserved first whatever the order; missing and empty ids get fresh unique ones; explicit ids never change', () => {
  const parse = (lines: object[]) => parseTechnicalProcessDocument(rawWithLines(lines)).gasSystem.map(l => `${l.gas}:${l.id}`);
  assert.deepEqual(parse([{ gas: 'A' }, { id: 'gas-1', gas: 'B' }, { gas: 'C' }, { id: 'gas-3', gas: 'D' }]), ['A:gas-4', 'B:gas-1', 'C:gas-5', 'D:gas-3']);
  assert.deepEqual(parse([{ id: '', gas: 'A' }, { id: 'gas-0', gas: 'B' }, { id: 'gas-1', gas: 'C' }]), ['A:gas-2', 'B:gas-0', 'C:gas-1']);
  assert.deepEqual(parse([{ gas: 'A' }, { gas: 'B' }]), ['A:gas-1', 'B:gas-2']);
  assert.deepEqual(parse([{ id: 'line-ar', gas: 'A' }, { gas: 'B' }, { id: 'gas-99999999999', gas: 'C' }]), ['A:line-ar', 'B:gas-1', 'C:gas-99999999999']);
  assert.throws(() => parseTechnicalProcessDocument(rawWithLines([{ id: 5, gas: 'A' }])), Error, 'a non-string id is still rejected');
});

test('gas ids: the export API gets the same reservation (an id-less line cannot steal the id of the line a step uses)', async () => {
  const raw = rawWithLines([{ gas: 'Ar', unit: 'sccm', enabled: true }, { id: 'gas-0', gas: 'N2', unit: 'sccm', enabled: true }], 'gas-0');
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document: raw, documentType: 'instruction', format: 'docx' }),
  }));
  assert.equal(response.status, 200);
  const text = flat(docxPlain(Buffer.from(await response.arrayBuffer())));
  assert.ok(text.includes('Линия gas-0 (газ: N2): ВКЛ, расход — 10 sccm') && !text.includes('Линия gas-0 (газ: Ar)'));
});

test('gas ids: a REAL duplicate that a step refers to is refused with a diagnosis (never a silent pick); an unreferenced duplicate is repaired', () => {
  const ambiguous = rawWithLines([{ id: 'gas-1', gas: 'Ar', unit: 'sccm', enabled: true }, { id: 'gas-1', gas: 'N2', unit: 'sccm', enabled: true }], 'gas-1');
  const result = restoreDocumentDetailed(JSON.stringify(ambiguous));
  assert.equal(result.status, 'invalid');
  assert.ok(result.status === 'invalid' && result.reason);
  assert.match(result.status === 'invalid' ? result.reason! : '', /Этап №5: назначена линия gas-1, но в разделе E несколько линий с таким идентификатором \(Ar \/ N2\)/);
  assert.match(result.status === 'invalid' ? result.reason! : '', /Документ не загружен и не изменён/);
  assert.equal(tryRestoreDocument(JSON.stringify(ambiguous)), null);

  const unreferenced = rawWithLines([{ id: 'gas-1', gas: 'Ar', unit: 'sccm', enabled: true }, { id: 'gas-1', gas: 'N2', unit: 'sccm', enabled: true }]);
  const repaired = restoreOk(unreferenced);
  assert.equal(repaired.repairedGasLineIds, 1);
  assert.deepEqual(repaired.document.gasSystem.map(l => `${l.gas}:${l.id}`), ['Ar:gas-1', 'N2:gas-2']);

  const sources = json(exampleDoc());
  sources.sources.magnetrons = [{ id: 'magnetron-1', enabled: true, material: 'Ti' }, { id: 'magnetron-1', enabled: true, material: 'Duplicate' }, sources.sources.magnetrons[1]];
  const sourceResult = restoreDocumentDetailed(JSON.stringify(sources));
  assert.ok(sourceResult.status === 'invalid' && /назначен Магнетрон magnetron-1, но в разделе D несколько источников с таким идентификатором \(Ti \/ Duplicate\)/.test(sourceResult.reason ?? ''));
  const arcs = json(exampleDoc());
  arcs.sources.arcSources = [arcs.sources.arcSources[0], { ...arcs.sources.arcSources[0], cathodeMaterial: 'Other' }];
  assert.ok(/Дуговой источник arc-1/.test((restoreDocumentDetailed(JSON.stringify(arcs)) as { reason?: string }).reason ?? ''));
});

test('restore reasons: corrupted JSON, validation failures and dangling references all come back with a readable reason; storage is never touched', () => {
  const syntax = restoreDocumentDetailed('{not json');
  assert.ok(syntax.status === 'invalid' && syntax.reason === 'Сохранённые данные повреждены (это не корректный JSON).');
  const dangling = json(fullDoc());
  dangling.gasSystem = dangling.gasSystem.filter((l: { id: string }) => l.id !== 'gas-1');
  const result = restoreDocumentDetailed(JSON.stringify(dangling));
  assert.ok(result.status === 'invalid' && /назначена линия gas-1, которой нет в разделе E/.test(result.reason ?? ''));
  assert.deepEqual(restoreDocumentDetailed(null), { status: 'empty' });
});

// ---- Task 2: legacy general fields vs structured assignments ----

function conflictDoc(): TechnicalProcessDocument {
  let doc = withSteps(exampleDoc(), s => updateStep(s, 5, { powerW: 3000, currentA: 5, gasUsage: [{ gas: 'Ar', flowSccm: 40 }] }));
  doc = withSteps(doc, s => updateGasAssignment(addGasAssignment(s, 5, 'gas-1'), 5, 'gas-1', { flowSccm: 40, startMin: 0, durationMin: 30 }));
  return doc;
}

test('conflict (MEDIUM): general power/current/gas AND structured assignments on one step -> a clear warning; nothing is removed, no priority is chosen, same material/gas is not "equivalent"', () => {
  const doc = conflictDoc();
  assert.doesNotThrow(() => validateDocument(doc), 'a draft with both is still valid - it is a warning, not an error');
  const all = collectStepWarnings(doc);
  assert.ok(all.some(w => w.startsWith('Этап №5: заданы и общие значения этапа (мощность этапа 3000 Вт, ток этапа 5 А), и назначения источников. Значения не считаются эквивалентными и приоритет не выбирается')));
  assert.ok(all.some(w => w.startsWith('Этап №5: задан и общий список газов этапа, и назначения газовых линий.') && w.includes('даже при одинаковом газе')), 'Ar in both places is still reported');
  // both sets of data are kept exactly as entered
  const s5 = step(doc, 5);
  assert.deepEqual([s5.powerW, s5.currentA, s5.gasUsage], [3000, 5, [{ gas: 'Ar', flowSccm: 40 }]]);
  assert.equal(s5.sourceAssignments[0].powerW, 2000);
  const restored = restoreOk(touchDocument(doc)).document;
  assert.deepEqual(json(step(restored, 5)), json(s5));
  assert.ok(collectStepWarnings(restored).some(w => w.includes('приоритет не выбирается')));
});

test('conflict: no warning when only one side is filled; each of power, current and gas triggers on its own', () => {
  assert.ok(!collectStepWarnings(exampleDoc()).some(w => w.includes('приоритет')), 'assignments only');
  const legacyOnly = withSteps(baseDoc(), s => updateStep(s, 5, { powerW: 3000, gasUsage: [{ gas: 'Ar' }] }));
  assert.ok(!collectStepWarnings(legacyOnly).some(w => w.includes('приоритет')), 'general fields only');
  const powerOnly = withSteps(exampleDoc(), s => updateStep(s, 5, { powerW: 1 }));
  assert.ok(collectStepWarnings(powerOnly).some(w => w.includes('(мощность этапа 1 Вт)')));
  const currentOnly = withSteps(exampleDoc(), s => updateStep(s, 5, { currentA: 2 }));
  assert.ok(collectStepWarnings(currentOnly).some(w => w.includes('(ток этапа 2 А)')));
  const gasOnly = withSteps(gasDoc(), s => updateStep(s, 5, { gasUsage: [{ gas: 'He' }] }));
  assert.equal(collectStepWarnings(gasOnly).filter(w => w.includes('приоритет')).length, 1);
  const sourceConfigurationOnly = withSteps(exampleDoc(), s => updateStep(s, 5, { sourceConfiguration: 'M1+A1' }));
  assert.ok(!collectStepWarnings(sourceConfigurationOnly).some(w => w.includes('приоритет')), 'a free-text description is not a competing value');
});

test('conflict: the warning is in the editor list, the preview, and the DOCX/PDF instruction', async () => {
  const doc = conflictDoc();
  const preview = buildInstructionView(doc);
  assert.ok(preview.includes('- Замечания к данным этапа:') && preview.includes('  - заданы и общие значения этапа (мощность этапа 3000 Вт, ток этапа 5 А), и назначения источников.'));
  const paragraph = buildDocumentViewModel(doc, 'instruction').sections.find(s => s.heading.startsWith('7.'))!.paragraphs.find(p => p.startsWith('№5.'))!;
  assert.ok(paragraph.includes('Замечания к данным этапа:') && paragraph.includes('• заданы и общие значения этапа'));
  assert.ok(paragraph.includes('газы: Ar (40 sccm)') && paragraph.includes('Магнетрон magnetron-1 (мишень: Ti): ВКЛ'), 'both data sets are still printed');
  for (const text of ['Замечания к данным этапа:', 'заданы и общие значения этапа (мощность этапа 3000 Вт, ток этапа 5 А), и назначения источников', 'приоритет не выбирается', 'даже при одинаковом газе']) {
    assert.ok(flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer)).includes(text), `DOCX: ${text}`);
    assert.ok((await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer)).includes(text), `PDF: ${text}`);
  }
});

// ---- Task 3: unverifiable sequential mode appears in the exports ----

function unverifiableDoc(): TechnicalProcessDocument {
  return withSteps(baseDoc(), s => {
    let r = addSourceAssignment(s, 5, 'magnetron', 'magnetron-1');
    r = updateSourceAssignment(r, 5, 'magnetron', 'magnetron-1', { powerW: 1000, startMin: 0, durationMin: 10, mode: 'sequential' });
    return addSourceAssignment(r, 5, 'arc', 'arc-1');
  });
}

test('unverifiable sequence (MEDIUM): the draft stays valid and exportable, and the warning is in the preview and in the DOCX/PDF instruction', async () => {
  const doc = unverifiableDoc();
  assert.doesNotThrow(() => validateDocument(doc), 'an incomplete draft can still be saved');
  const text = 'у Дуговой источник arc-1 не заданы начало и длительность - непересечение с последовательным Магнетрон magnetron-1 проверить нельзя.';
  assert.ok(collectStepWarnings(doc).includes(`Этап №5: ${text}`));
  assert.ok(buildInstructionView(doc).includes(text));
  const docx = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  const pdf = await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer);
  assert.ok(docx.includes(text) && pdf.includes(text));
  assert.ok(docx.includes('Замечания к данным этапа:') && pdf.includes('Замечания к данным этапа:'));
  assert.ok(restoreOk(touchDocument(doc)).document.steps[4].sourceAssignments.length === 2, 'and it survives save/restore');
});

test('unverifiable sequence: the other warnings (no step duration, non-sccm unit, no gas name) are exported too; a complete step has none', async () => {
  let doc = withSteps(exampleDoc(), s => updateStep(s, 5, { durationMin: undefined }));
  doc = withSteps(doc, s => updateGasAssignment(addGasAssignment(s, 5, 'gas-1'), 5, 'gas-1', { flowSccm: 5 }));
  doc = { ...doc, gasSystem: updateGasLine(doc.gasSystem, 'gas-1', { unit: 'см³/мин' }) };
  const docx = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  assert.ok(docx.includes('не задана длительность этапа - интервалы источников и газов нельзя сверить с границами этапа'));
  assert.ok(docx.includes('линия gas-1 ведётся в разделе E в единицах «см³/мин»; расход на этапе задаётся в sccm и не пересчитывается'));
  const clean = flat(docxPlain((await exportTechDoc(exampleDoc(), 'instruction', 'docx')).buffer));
  assert.ok(!clean.includes('Замечания к данным этапа'), 'no warnings block when there is nothing to warn about');
  assert.ok(!buildInstructionView(exampleDoc()).includes('Замечания'));
});

// ---- Task 4: zero-length intervals ----

test('zero duration (MEDIUM): 0 min means "no work" - an empty interval that overlaps nothing, and is not the same as "not set"', () => {
  const doc = exampleDoc(); // M1 0-30 (parallel), A1 5-15, M2 15-30
  const inside = withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { startMin: 10, durationMin: 0, mode: 'sequential' }));
  assert.doesNotThrow(() => validateDocument(inside), 'a zero-length sequential interval inside another source\'s run is not an overlap');
  const other = withSteps(doc, s => updateSourceAssignment(updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { mode: 'sequential' }), 5, 'arc', 'arc-1', { startMin: 12, durationMin: 0 }));
  assert.throws(() => validateDocument(other), /Магнетрон magnetron-2.*пересекается|magnetron-1.*пересекается/, 'a sequential source still conflicts with REAL intervals');
  const chain = withSteps(doc, s => {
    let r = updateSourceAssignment(s, 5, 'magnetron', 'magnetron-1', { startMin: 0, durationMin: 5 });
    r = updateSourceAssignment(r, 5, 'arc', 'arc-1', { startMin: 7, durationMin: 0 });
    return updateSourceAssignment(r, 5, 'magnetron', 'magnetron-2', { mode: 'sequential', startMin: 8, durationMin: 4 });
  });
  assert.doesNotThrow(() => validateDocument(chain), 'a sequential interval (8-12) next to a real one (0-5) and a zero-length one (at 7) is fine');
  // 0 is different from unset
  const unset = withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { mode: 'sequential', durationMin: undefined }));
  assert.throws(() => validateDocument(unset), /для последовательного режима нужно задать начало и длительность/, 'unset still fails the sequential requirement');
  assert.doesNotThrow(() => validateDocument(inside), '0 satisfies it');
  assert.notEqual(formatTimeWindow(10, 0), formatTimeWindow(10, undefined));
  assert.equal(formatTimeWindow(10, 0), 'начало 10 мин, длительность 0 мин (нулевой интервал: работы нет)');
  assert.equal(formatTimeWindow(10, undefined), 'начало 10 мин, длительность не задана');
  assert.equal(formatTimeWindow(undefined, 0), 'начало не задано, длительность 0 мин (нулевой интервал: работы нет)');
  assert.equal(formatTimeWindow(0, 30), '0–30 мин', 'ordinary windows are unchanged');
});

test('zero duration: the rule is stated in the documents, a running-but-zero source or gas line is warned about, and the exports show it', async () => {
  const doc = withSteps(exampleDoc(), s => updateGasAssignment(addGasAssignment(updateSourceAssignment(s, 5, 'arc', 'arc-1', { startMin: 10, durationMin: 0, mode: 'sequential' }), 5, 'gas-1'), 5, 'gas-1', { flowSccm: 5, startMin: 3, durationMin: 0 }));
  assert.doesNotThrow(() => validateDocument(doc));
  const warnings = collectStepWarnings(doc);
  assert.ok(warnings.includes('Этап №5: Дуговой источник arc-1 включён, но его длительность 0 мин - фактически он не работает на этапе.'));
  assert.ok(warnings.includes('Этап №5: линия gas-1 включена, но длительность подачи 0 мин - газ фактически не подаётся.'));
  assert.ok(buildInstructionView(doc).includes('длительность 0 мин (нулевой интервал: работы нет)'));
  assert.ok(buildInstructionView(doc).includes('длительность 0 мин означает, что работы нет, и пересечением не считается'));
  const docx = flat(docxPlain((await exportTechDoc(doc, 'instruction', 'docx')).buffer));
  const pdf = await pdfText((await exportTechDoc(doc, 'instruction', 'pdf')).buffer);
  for (const text of ['Дуговой источник arc-1 (катод: Cr, фильтрованный): ВКЛ, ток дуги — 80 А, время — начало 10 мин, длительность 0 мин (нулевой интервал: работы нет), режим — последовательно',
    'длительность 0 мин означает, что работы нет, и пересечением не считается', 'Дуговой источник arc-1 включён, но его длительность 0 мин']) {
    assert.ok(docx.includes(text) && pdf.includes(text), text);
  }
  const off = withSteps(doc, s => updateSourceAssignment(s, 5, 'arc', 'arc-1', { enabled: false }));
  assert.ok(!collectStepWarnings(off).some(w => w.includes('длительность 0 мин')), 'an OFF source is not warned about');
  assert.deepEqual(json(step(restoreOk(touchDocument(doc)).document, 5).sourceAssignments[1]), json(step(doc, 5).sourceAssignments[1]), '0 survives save/restore as 0');
});

// ---- Task 5: overflow of start + duration ----

test('overflow (LOW): start + duration must stay finite - a draft with 1e308 + 1e308 is rejected and "Infinity" is never printed', async () => {
  const huge = withSteps(baseDoc(), s => updateSourceAssignment(addSourceAssignment(s, 5, 'magnetron', 'magnetron-1'), 5, 'magnetron', 'magnetron-1', { startMin: 1e308, durationMin: 1e308 }));
  for (const doc of [huge, withSteps(huge, s => updateStep(s, 5, { durationMin: undefined })), withSteps(huge, s => updateStep(s, 5, { durationMin: 30 }))]) {
    assert.throws(() => validateDocument(doc), /Магнетрон magnetron-1: начало \+ длительность не является конечным числом/);
  }
  const hugeGas = withSteps(baseDoc(), s => updateGasAssignment(addGasAssignment(s, 5, 'gas-1'), 5, 'gas-1', { startMin: 1e308, durationMin: 1e308 }));
  assert.throws(() => validateDocument(hugeGas), /линия gas-1: начало \+ длительность не является конечным числом/);
  assert.equal(formatTimeWindow(1e308, 1e308), 'начало 1e+308 мин, длительность 1e+308 мин (конец интервала не определён: слишком большие значения)');
  assert.equal(formatTimeWindow(Infinity, 5), 'некорректное значение времени');
  assert.equal(formatTimeWindow(5, Number.NaN), 'некорректное значение времени');
  for (const doc of [huge, hugeGas]) {
    assert.ok(!buildInstructionView(doc).includes('Infinity'), 'the draft preview never shows Infinity');
    assert.ok(!JSON.stringify(collectStepWarnings(doc)).includes('Infinity'));
    assert.throws(() => buildDocumentViewModel(doc, 'instruction'), /не является конечным числом/, 'the export refuses it instead of printing it');
  }
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document: json(huge), documentType: 'instruction', format: 'docx' }),
  }));
  assert.equal(response.status, 400);
  assert.ok(!JSON.stringify(await response.json()).includes('Infinity'));
});

test('overflow: large but finite values still work (the boundary is the sum, not the magnitude)', () => {
  const big = withSteps(baseDoc(), s => updateSourceAssignment(addSourceAssignment(s, 5, 'magnetron', 'magnetron-1'), 5, 'magnetron', 'magnetron-1', { startMin: 1e308, durationMin: 0 }));
  const noStepLimit = withSteps(big, s => updateStep(s, 5, { durationMin: undefined }));
  assert.doesNotThrow(() => validateDocument(noStepLimit));
  assert.ok(!buildInstructionView(noStepLimit).includes('Infinity'));
  assert.throws(() => validateDocument(big), /позже конца этапа|выходит за пределы этапа/, 'with a 30-minute step it is simply out of range');
});

// =====================================================================================
// Technological card: long assignment lists across several PDF pages
// =====================================================================================

import { hasLongGasList, hasLongSourceList, sourceAssignmentFields, gasAssignmentFields, cardDetailHeading } from '../src/services/workspace/techdoc-assistant';

/** 25 magnetrons (materials Target-1..25, power 100*i W, window i%5 .. i%5+10) and one filtered arc source that is
 *  switched OFF on step 2; 12 gas lines on step 2 AND on step 3; step 3 has a single magnetron (a short list). */
function bigDoc(): TechnicalProcessDocument {
  let sources = createDefaultSourceSet();
  for (let i = 1; i <= 25; i++) sources = updateMagnetron(addMagnetron(sources), `magnetron-${i}`, { material: `Target-${i}` });
  sources = updateArcSource(addArcSource(sources), 'arc-1', { cathodeMaterial: 'Cr', filtered: true });
  let gas = createDefaultGasLines();
  for (let i = 0; i < 9; i++) gas = addGasLine(gas);
  gas = gas.map((l, i) => ({ ...l, gas: ['Ar', 'N2', 'C2H2', 'O2', 'He', 'H2', 'Kr', 'Xe', 'CH4', 'NH3', 'Ne', 'SiH4', 'CF4', 'SF6'][i], enabled: true }));
  let steps = addStep(addStep(addStep(addStep([], 'loading'), 'adhesion_underlayer'), 'multilayer_coating'), 'cooling');
  steps = updateStep(updateStep(steps, 2, { durationMin: 30, temperatureC: 350, pressurePa: 0.5 }), 3, { durationMin: 60 });
  for (let i = 1; i <= 25; i++) {
    steps = addSourceAssignment(steps, 2, 'magnetron', `magnetron-${i}`);
    steps = updateSourceAssignment(steps, 2, 'magnetron', `magnetron-${i}`, { powerW: 100 * i, startMin: i % 5, durationMin: 10 });
  }
  steps = updateSourceAssignment(addSourceAssignment(steps, 2, 'arc', 'arc-1'), 2, 'arc', 'arc-1', { currentA: 80, startMin: 5, durationMin: 10, enabled: false });
  for (const order of [2, 3]) {
    for (let i = 1; i <= 12; i++) steps = updateGasAssignment(addGasAssignment(steps, order, `gas-${i}`), order, `gas-${i}`, { flowSccm: 5 * i, startMin: order === 2 ? i : 0, durationMin: 10 });
  }
  steps = updateSourceAssignment(addSourceAssignment(steps, 3, 'magnetron', 'magnetron-1'), 3, 'magnetron', 'magnetron-1', { powerW: 1234, startMin: 0, durationMin: 60 });
  return { ...createBlankDocument(), general: { processName: 'Big' }, sources, gasSystem: gas, steps };
}

async function pdfPages(buffer: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.pages.map((page: { text: string }) => page.text.replace(/μ/g, 'µ').replace(/([–/])\s+(?=[\dа-яa-z])/gi, '$1').replace(/\s+/g, ' '));
  } finally { await parser.destroy(); }
}

test('long lists: a step whose lists do not fit a card cell gets its own detail table - one assignment per row - and a pointer in the card row', () => {
  const doc = bigDoc();
  assert.doesNotThrow(() => validateDocument(doc));
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.deepEqual(vm.tables.map(t => t.heading), [
    'Технологическая карта',
    'Этап №2 «Адгезионный подслой»: источники', 'Этап №2 «Адгезионный подслой»: газовые линии', 'Этап №3 «Многослойное покрытие»: газовые линии',
  ], 'step 3 has only one magnetron, so no source table for it');
  const [main, sources2, gas2, gas3] = vm.tables;
  const row2 = main.rows.find(r => r[0] === '2')!;
  assert.ok(row2[6].includes('назначено источников: 26 (включено 25) - полный перечень в таблице «Этап №2 «Адгезионный подслой»: источники» ниже'));
  assert.ok(row2[5].includes('назначено газовых линий: 12 (включено 12) - полный перечень в таблице «Этап №2 «Адгезионный подслой»: газовые линии» ниже'));
  assert.ok(!row2[6].includes('Target-1'), 'the card row itself no longer carries the long text');
  assert.equal(sources2.rows.length, 26);
  assert.equal(gas2.rows.length, 12);
  assert.equal(gas3.rows.length, 12);
  for (const table of [sources2, gas2, gas3]) {
    for (const row of table.rows) assert.equal(row.length, table.columns.length, 'every row has a cell for every column');
    assert.ok(table.rows.every(r => r[0] === table.rows[0][0] && r[1] === table.rows[0][1]), 'every row repeats the step number and name');
  }
  assert.deepEqual(sources2.columns.slice(0, 4), ['№ этапа', 'Этап', 'Источник', 'Материал']);
  assert.equal(sources2.rows[0].slice(0, 2).join('|'), '2|Адгезионный подслой');
  assert.equal(gas3.rows[0].slice(0, 2).join('|'), '3|Многослойное покрытие');
  assert.ok(sources2.columnWeights && gas2.columnWeights && sources2.columnWeights.length === sources2.columns.length);
});

test('long lists: no value is lost - every source and gas assignment appears in its own row with material, state, power/current, window and mode', () => {
  const doc = bigDoc();
  const [, sources2, gas2, gas3] = buildDocumentViewModel(doc, 'technologicalCard').tables;
  for (let i = 1; i <= 25; i++) {
    const row = sources2.rows[i - 1];
    assert.deepEqual(row.slice(2), [`Магнетрон magnetron-${i}`, `Target-${i}`, 'ВКЛ', `мощность — ${100 * i} Вт`, `${i % 5}–${(i % 5) + 10} мин`, 'одновременно'], `magnetron-${i}`);
  }
  assert.deepEqual(sources2.rows[25].slice(2), ['Дуговой источник arc-1', 'Cr, фильтрованный', 'ОТКЛ', '—', '—', '—'], 'an OFF source is stated as OFF, material kept');
  for (const [table, order] of [[gas2, 2], [gas3, 3]] as const) {
    for (let i = 1; i <= 12; i++) {
      const gasName = ['Ar', 'N2', 'C2H2', 'O2', 'He', 'H2', 'Kr', 'Xe', 'CH4', 'NH3', 'Ne', 'SiH4'][i - 1];
      assert.deepEqual(table.rows[i - 1].slice(2), [`Линия gas-${i}`, gasName, 'ВКЛ', `${5 * i} sccm`, order === 2 ? `${i}–${i + 10} мин` : `0–10 мин`], `step ${order} gas-${i}`);
    }
  }
  // the table cells are the same facts as the line form used elsewhere
  const step2 = step(doc, 2);
  for (const a of step2.sourceAssignments.filter(x => x.enabled)) {
    const f = sourceAssignmentFields(doc, a);
    const line = formatSourceAssignment(doc, a);
    for (const part of [f.source, f.material, f.state, f.value, f.time, f.mode]) assert.ok(line.includes(part), `${part} in ${line}`);
  }
  for (const a of step2.gasAssignments) {
    const f = gasAssignmentFields(doc, a);
    const line = formatGasAssignment(doc, a);
    for (const part of [f.line.replace('Линия ', ''), f.gas, f.state, f.flow, f.time]) assert.ok(line.includes(part), `${part} in ${line}`);
  }
});

test('long lists: the on-screen preview and markdown card still hold the complete text; only the DOCX/PDF card row points at the tables', () => {
  const doc = bigDoc();
  const full = buildTechnologicalCard(doc).find(r => r.number === 2)!;
  for (let i = 1; i <= 25; i++) assert.ok(full.sourcePower.includes(`Магнетрон magnetron-${i} (мишень: Target-${i}): ВКЛ, мощность — ${100 * i} Вт`), `preview magnetron-${i}`);
  assert.ok(full.gases.includes('Линия gas-12 (газ: SiH4): ВКЛ, расход — 60 sccm'));
  assert.ok(buildTechnologicalCard(doc, { compactLongLists: true }).find(r => r.number === 2)!.sourcePower.includes('полный перечень в таблице'));
  const short = buildTechnologicalCard(doc, { compactLongLists: true }).find(r => r.number === 3)!;
  assert.equal(short.sourcePower, buildTechnologicalCard(doc).find(r => r.number === 3)!.sourcePower, 'a short list (1 source) stays inline');
  assert.equal(cardDetailHeading(step(doc, 3), 'gases'), 'Этап №3 «Многослойное покрытие»: газовые линии');
});

test('size rule: four ordinary assignments stay inline with no extra table or note; five ordinary ones move to a table', () => {
  const make = (count: number) => withSteps({ ...exampleDoc(), gasSystem: exampleDoc().gasSystem.map(l => ({ ...l, enabled: true })) }, steps => {
    let s = updateStep(steps, 5, { durationMin: 30 });
    s = s.map(x => x.order === 5 ? { ...x, sourceAssignments: [], gasAssignments: [] } : x);
    for (let i = 1; i <= count; i++) s = addGasAssignment(s, 5, `gas-${i}`);
    return s;
  });
  const four = make(4);
  const vm4 = buildDocumentViewModel(four, 'technologicalCard');
  assert.equal(vm4.tables.length, 1);
  assert.equal(vm4.tables[0].rows.find(r => r[0] === '5')![5], buildTechnologicalCard(four).find(r => r.number === 5)!.gases, 'identical to the full text');
  assert.ok(!vm4.sections[0].paragraphs.join(' ').includes('слишком велик') && !vm4.sections[0].paragraphs[0].includes('кроме этапов'));
  const five = make(5);
  const vm5 = buildDocumentViewModel(five, 'technologicalCard');
  assert.equal(vm5.tables.length, 2);
  assert.equal(vm5.tables[1].heading, 'Этап №5 «Адгезионный подслой»: газовые линии');
  assert.ok(vm5.sections[0].paragraphs.join(' ').includes('слишком велик для одной ячейки карты'));
});

test('short cards are unchanged: a card with only short lists renders exactly as before (single table, full cells, original note)', () => {
  const doc = fullDoc();
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 1);
  const rows = buildTechnologicalCard(doc);
  assert.deepEqual(vm.tables[0].rows, rows.map(r => [String(r.number), r.operation, r.duration, r.temperature, r.pressure, r.gases, r.sourcePower, r.bias, r.control, r.note]));
  assert.equal(vm.sections[0].paragraphs[0], 'В колонках «Источник/мощность» и «Газы» через «;» перечислены общие значения этапа и все назначения источников и газовых линий данного этапа.');
});

test('PDF: the long card runs onto further pages - every page of a table repeats the column header, every row carries its step, nothing is lost or cut', async () => {
  const doc = bigDoc();
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 4, `expected the card to need several pages, got ${pages.length}`);

  // pages that contain source rows each start with the column header of the source table
  const sourcePages = pages.filter(text => /Магнетрон magnetron-\d+/.test(text.replace(/назначено[^«]*«[^»]*»/g, '')) && /(^| )2 Адгезионный подслой Магнетрон magnetron-/.test(text));
  assert.ok(sourcePages.length >= 2, 'the source table spans at least two pages');
  for (const text of sourcePages) assert.ok(/№ этапа Этап Источник Материал Состояние Мощность \/ ?ток Время Режим/.test(text), 'the header is repeated on every page of the source table');
  const gasPages = pages.filter(text => /(^| )(2|3) (Адгезионный подслой|Многослойное покрытие) Линия gas-\d+/.test(text));
  assert.ok(gasPages.length >= 2);
  for (const text of gasPages) assert.ok(/№ этапа Этап Линия Газ Состояние Расход Время подачи/.test(text), 'the gas table header is repeated too');

  const all = pages.join(' ');
  // every row repeats the step it belongs to: the number of "<n> <step name> Магнетрон ..." rows equals the number of assignments
  assert.equal((all.match(/(^| )2 Адгезионный подслой (Магнетрон magnetron-\d+|Дуговой источник arc-1)/g) ?? []).length, 26);
  assert.equal((all.match(/(^| )2 Адгезионный подслой Линия gas-\d+/g) ?? []).length, 12);
  assert.equal((all.match(/(^| )3 Многослойное покрытие Линия gas-\d+/g) ?? []).length, 12);
  // order is preserved across the page break (magnetron-1..25 ascending as read page by page)
  const order = [...all.matchAll(/2 Адгезионный подслой Магнетрон magnetron-(\d+) Target-\d+/g)].map(m => Number(m[1]));
  assert.deepEqual(order, Array.from({ length: 25 }, (_, i) => i + 1));
  for (let i = 1; i <= 25; i++) {
    assert.ok(all.includes(`magnetron-${i} Target-${i} ВКЛ мощность — ${100 * i} Вт ${i % 5}–${(i % 5) + 10} мин одновременно`), `row ${i} is complete and in one piece`);
  }
  assert.ok(all.includes('Дуговой источник arc-1 Cr, фильтрованный ОТКЛ'));
  for (let i = 1; i <= 12; i++) {
    assert.ok(all.includes(`2 Адгезионный подслой Линия gas-${i} `) && all.includes(`3 Многослойное покрытие Линия gas-${i} `));
    assert.ok(all.includes(`${5 * i} sccm`));
  }
  assert.ok(all.includes('Traceability Процесс: Big') && all.includes('Источник: создан с чистого листа'), 'the block after the last table is complete');
  assert.ok(all.includes('Магнетрон magnetron-1 (мишень: Target-1): ВКЛ, мощность — 1234 Вт, время — 0–60 мин, режим — одновременно'), 'the short list of step 3 stays inline');
});

test('PDF: a short card is still one page-sized table without detail tables', async () => {
  const pages = await pdfPages((await exportTechDoc(fullDoc(), 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length <= 2);
  assert.ok(!pages.join(' ').includes('№ этапа Этап Источник'), 'no detail table for short lists');
});

test('DOCX: the long card keeps every value; each table has a repeating header row', async () => {
  const { buffer } = await exportTechDoc(bigDoc(), 'technologicalCard', 'docx');
  const xml = readZipEntryText(buffer, 'word/document.xml');
  const text = flat(docxPlain(buffer));
  assert.equal((xml.match(/<w:tblHeader\/>/g) ?? []).length, 4, 'main + three detail tables, each with a repeating header');
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 4);
  for (let i = 1; i <= 25; i++) assert.ok(text.includes(`Магнетрон magnetron-${i}`) && text.includes(`Target-${i}`) && text.includes(`мощность — ${100 * i} Вт`) && text.includes(`${i % 5}–${(i % 5) + 10} мин`), `magnetron-${i}`);
  for (let i = 1; i <= 12; i++) assert.ok(text.includes(`Линия gas-${i}`) && text.includes(`${5 * i} sccm`));
  assert.ok(text.includes('Дуговой источник arc-1') && text.includes('Cr, фильтрованный') && text.includes('ОТКЛ'));
  assert.ok(text.includes('Этап №2 «Адгезионный подслой»: источники') && text.includes('Этап №3 «Многослойное покрытие»: газовые линии'));
  assert.ok(text.includes('слишком велик для одной ячейки карты'));
});

test('long lists through the export API, and the instruction document is unaffected by the card layout', async () => {
  const response = await exportPOST(new Request('http://localhost/api/workspace/techdoc/export', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ document: json(bigDoc()), documentType: 'technologicalCard', format: 'pdf' }),
  }));
  assert.equal(response.status, 200);
  assert.ok((await pdfPages(Buffer.from(await response.arrayBuffer()))).length >= 4);
  const instruction = flat(docxPlain((await exportTechDoc(bigDoc(), 'instruction', 'docx')).buffer));
  for (let i = 1; i <= 25; i++) assert.ok(instruction.includes(`Магнетрон magnetron-${i} (мишень: Target-${i}): ВКЛ, мощность — ${100 * i} Вт`), `instruction keeps magnetron-${i} in full`);
});

// =====================================================================================
// Content-size rule: long assignments, one enormous record, estimator calibration
// =====================================================================================

import PDFDocument from 'pdfkit';
import { estimateLines, chunkText, splitTallRows, columnWidthPt, CARD_GAS_COLUMN, CARD_COLUMN_WEIGHTS, CARD_CELL_LINE_BUDGET, CARD_ROW_LINE_LIMIT, WORST_CHAR_PT, TYPICAL_CHAR_PT, CONTINUATION_CELL, joinChunkCells, CHUNK_MARKER_RE } from '../src/services/workspace/techdoc-card-layout';

const phrase = (tag: string, length: number) => `${tag} газовая смесь высокой чистоты марки А для плазменной обработки `.repeat(Math.ceil(length / 40)).slice(0, length).trim();

/** One step "Адгезионный подслой" (order 2) with the given gas names assigned, one line each. */
function longGasDoc(names: string[]): TechnicalProcessDocument {
  let gas = createDefaultGasLines();
  while (gas.length < names.length) gas = addGasLine(gas);
  gas = gas.map((l, i) => ({ ...l, gas: names[i] ?? l.gas, enabled: i < names.length }));
  let steps = updateStep(addStep(addStep([], 'loading'), 'adhesion_underlayer'), 2, { durationMin: 30 });
  names.forEach((_, i) => { steps = updateGasAssignment(addGasAssignment(steps, 2, `gas-${i + 1}`), 2, `gas-${i + 1}`, { flowSccm: 10 * (i + 1), startMin: i, durationMin: 10 }); });
  return { ...createBlankDocument(), general: { processName: 'Long' }, gasSystem: gas, steps };
}

function longMaterialDoc(materials: string[]): TechnicalProcessDocument {
  let sources = createDefaultSourceSet();
  materials.forEach((m, i) => { sources = updateMagnetron(addMagnetron(sources), `magnetron-${i + 1}`, { material: m }); });
  let steps = updateStep(addStep(addStep([], 'loading'), 'adhesion_underlayer'), 2, { durationMin: 30 });
  materials.forEach((_, i) => { steps = updateSourceAssignment(addSourceAssignment(steps, 2, 'magnetron', `magnetron-${i + 1}`), 2, 'magnetron', `magnetron-${i + 1}`, { powerW: 100 * (i + 1), startMin: i, durationMin: 10 }); });
  return { ...createBlankDocument(), general: { processName: 'Long' }, sources, steps };
}

const longNames = [1, 2, 3, 4].map(i => phrase(`L${i}`, 285));

test('size rule: four SHORT gas lines stay inline - the card is byte-for-byte what it was', () => {
  const doc = longGasDoc(['Ar', 'N2', 'C2H2', 'O2']);
  assert.equal(hasLongGasList(doc, step(doc, 2)), false);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 1);
  assert.equal(vm.tables[0].rows.find(r => r[0] === '2')![5], buildTechnologicalCard(doc).find(r => r.number === 2)!.gases);
  assert.ok(!vm.sections[0].paragraphs.join(' ').includes('слишком велик'));
});

test('size rule (audit case): four gas lines of ~285 characters get a detail table, one record per row, each with step number and name', () => {
  const doc = longGasDoc(longNames);
  assert.equal(longNames[0].length >= 280, true);
  assert.equal(hasLongGasList(doc, step(doc, 2)), true, 'four assignments, but too much text for a cell');
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 2);
  const gasTable = vm.tables[1];
  assert.equal(gasTable.heading, 'Этап №2 «Адгезионный подслой»: газовые линии');
  assert.equal(gasTable.rows.length, 4);
  gasTable.rows.forEach((row, i) => {
    assert.deepEqual([row[0], row[1], row[2], row[3]], ['2', 'Адгезионный подслой', `Линия gas-${i + 1}`, longNames[i]], 'full gas name, nothing cut');
    assert.deepEqual(row.slice(4), ['ВКЛ', `${10 * (i + 1)} sccm`, `${i}–${i + 10} мин`]);
  });
  assert.ok(vm.sections[0].paragraphs.join(' ').includes('слишком велик'));
});

test('size rule: long materials of sources are detected the same way as long gas names (four magnetrons)', () => {
  const doc = longMaterialDoc([1, 2, 3, 4].map(i => phrase(`M${i}`, 250)));
  assert.equal(hasLongSourceList(doc, step(doc, 2)), true);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  const table = vm.tables.find(t => t.heading.endsWith(': источники'))!;
  assert.equal(table.rows.length, 4);
  table.rows.forEach((row, i) => assert.deepEqual([row[0], row[1], row[2], row[3], row[5], row[6]], ['2', 'Адгезионный подслой', `Магнетрон magnetron-${i + 1}`, phrase(`M${i + 1}`, 250), `мощность — ${100 * (i + 1)} Вт`, `${i}–${i + 10} мин`]));
  const short = longMaterialDoc(['Ti', 'Cr', 'Zr', 'Al']);
  assert.equal(hasLongSourceList(short, step(short, 2)), false);
});

test('size rule: five ordinary assignments move to a table, 25 magnetrons with long gas lists work too', () => {
  const five = longGasDoc(['Ar', 'N2', 'C2H2', 'O2', 'He']);
  assert.equal(hasLongGasList(five, step(five, 2)), true);
  assert.equal(buildDocumentViewModel(five, 'technologicalCard').tables[1].rows.length, 5);
  const doc = bigDoc();
  doc.gasSystem = doc.gasSystem.map((l, i) => ({ ...l, gas: i < 12 ? phrase(`G${i + 1}`, 285) : l.gas }));
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.find(t => t.heading === 'Этап №2 «Адгезионный подслой»: источники')!.rows.length, 26);
  assert.equal(vm.tables.find(t => t.heading === 'Этап №3 «Многослойное покрытие»: газовые линии')!.rows.length, 12);
});

test('PDF (audit case): four 285-character gas lines span pages; every page of the gas table repeats the header; every row has step number and name; no text is lost', async () => {
  const pages = await pdfPages((await exportTechDoc(longGasDoc(longNames), 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.length >= 3, `expected the detail table to continue on a further page, got ${pages.length}`);
  const gasPages = pages.filter(t => /2 Адгезионный подслой Линия gas-\d/.test(t));
  assert.ok(gasPages.length >= 2, 'the table itself continues on a second page');
  for (const t of gasPages) assert.ok(t.includes('№ этапа Этап Линия Газ Состояние Расход Время подачи'), 'column header repeated on the continuation page');
  const all = pages.join(' ');
  assert.equal((all.match(/2 Адгезионный подслой Линия gas-\d/g) ?? []).length, 4, 'step number+name in each of the four rows');
  for (const [i, name] of longNames.entries()) assert.ok(all.includes(name.slice(0, 60)) && all.includes(`${10 * (i + 1)} sccm`), `gas-${i + 1}`);
  assert.ok(all.includes('Traceability'), 'the document tail is intact');
});

test('one enormous record: a single 6000-character gas name is split into marked pieces; every piece repeats step and line, the pieces rebuild the name exactly', async () => {
  const name = phrase('HUGE', 6000);
  const doc = longGasDoc([name]);
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  const rows = vm.tables[1].rows;
  assert.ok(rows.length >= 3);
  rows.forEach((row, i) => {
    assert.deepEqual(row.slice(0, 3), ['2', 'Адгезионный подслой', 'Линия gas-1'], 'context in every piece');
    assert.ok(row[3].startsWith(`[${i + 1}/${rows.length}] `));
    if (i === 0) assert.deepEqual(row.slice(4), ['ВКЛ', '10 sccm', '0–10 мин']);
    else assert.deepEqual(row.slice(4), [CONTINUATION_CELL, CONTINUATION_CELL, CONTINUATION_CELL], 'no empty cell and no copied value');
    assert.ok(estimateLines(row[3], columnWidthPt([6, 16, 12, 16, 10, 16, 24], 3), WORST_CHAR_PT) <= CARD_ROW_LINE_LIMIT, 'each piece fits a page');
  });
  assert.equal(joinChunkCells(rows.map(r => r[3])), name, 'lossless, character for character');
  assert.ok(vm.sections[0].paragraphs.join(' ').includes('[k/n]') || vm.sections[0].paragraphs.join(' ').includes('[1/'), 'the note explains the markers');

  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  const all = pages.join(' ');
  assert.equal((all.match(/2 Адгезионный подслой Линия gas-1 /g) ?? []).length, rows.length);
  for (const t of pages.filter(p => /2 Адгезионный подслой Линия gas-1 \[/.test(p))) assert.ok(t.includes('№ этапа Этап Линия Газ'), 'header on every page holding pieces');
});

test('main card rows too: a 5000-character acceptance criterion is split instead of overflowing the page', async () => {
  const doc = longGasDoc(['Ar']);
  doc.steps = updateStep(doc.steps, 2, { acceptanceCriteria: phrase('CRIT', 5000) });
  const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[0].rows;
  const pieces = rows.filter(r => r[0] === '2');
  assert.ok(pieces.length >= 2);
  pieces.forEach(r => assert.deepEqual([r[0], r[1]], ['2', 'Адгезионный подслой']));
  const pages = await pdfPages((await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer);
  assert.ok(pages.slice(1).some(t => t.includes('№ Операция') || t.includes('Операция')), 'continuation pages keep the card header');
});

test('layout helpers: estimateLines / chunkText / splitTallRows keep everything and leave short rows alone', () => {
  assert.equal(estimateLines('', 100, 6.4), 1);
  assert.equal(estimateLines('a\nb', 100, 6.4), 2);
  assert.equal(estimateLines('x'.repeat(100), 64, 6.4), 10, 'a word longer than a line is broken');
  const text = phrase('T', 3000);
  const parts = chunkText(text, 100, WORST_CHAR_PT, 20);
  assert.ok(parts.length > 1 && parts.every(p => estimateLines(p, 100, WORST_CHAR_PT) <= 20));
  assert.equal(parts.join(''), text);
  assert.equal(chunkText('x'.repeat(1000), 100, WORST_CHAR_PT, 3).join(''), 'x'.repeat(1000), 'an unbroken word is sliced without loss');
  const short = [['1', 'a', 'b']];
  assert.deepEqual(splitTallRows(short, [1, 1, 1], [0, 1]), short);
});

test('estimator calibration: against the real PDF renderer the worst-case estimate never under-counts lines, the typical one is at most 10 % below (it errs on the safe side)', () => {
  const widthPt = columnWidthPt(CARD_COLUMN_WEIGHTS, CARD_GAS_COLUMN);
  const samples = [phrase('Ar', 300), phrase('ЗАГЛАВНЫЕ БУКВЫ КИРИЛЛИЦЫ ', 400), 'Линия gas-1 (газ: Ar): ВКЛ, расход — 50 sccm, время — 0–10 мин; '.repeat(6), 'N2/C2H2 смесь '.repeat(30)];
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape' });
  pdf.registerFont('Sans', new URL('../node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf', import.meta.url).pathname);
  pdf.font('Sans').fontSize(8);
  for (const sample of samples) {
    const actual = Math.round(pdf.heightOfString(sample, { width: widthPt }) / pdf.currentLineHeight());
    const worst = estimateLines(sample, widthPt, WORST_CHAR_PT);
    const typical = estimateLines(sample, widthPt, TYPICAL_CHAR_PT);
    assert.ok(worst >= actual, `worst-case ${worst} >= measured ${actual}`);
    assert.ok(/ЗАГЛАВНЫЕ/.test(sample) || typical >= actual * 0.9, `typical ${typical} vs measured ${actual}`);
  }
  assert.ok(CARD_CELL_LINE_BUDGET < CARD_ROW_LINE_LIMIT);
});

// =====================================================================================
// Exact text preservation when a long cell is split
// =====================================================================================

const W = columnWidthPt([6, 16, 12, 16, 10, 16, 24], 3); // gas-name column of the gas detail table
const roundTrip = (text: string, maxLines = 6) => {
  const parts = chunkText(text, W, WORST_CHAR_PT, maxLines);
  assert.equal(parts.join(''), text, 'parts.join("") === original');
  for (const part of parts) assert.ok(estimateLines(part, W, WORST_CHAR_PT) <= maxLines, 'each part fits');
  return parts;
};

test('exact split: 1234567890 x 100 and 6000 characters without a blank are cut into 2, 3 and more parts with nothing lost or doubled', () => {
  const digits = '1234567890'.repeat(100);
  assert.ok(roundTrip(digits, 6).length >= 2);
  const noBlank = 'AbВг-'.repeat(1200);
  assert.equal(noBlank.length, 6000);
  assert.ok(roundTrip(noBlank, 24).length >= 3);
  assert.ok(roundTrip(noBlank, 3).length >= 10);
  for (const n of [1, 2, 3, 5, 24]) assert.equal(chunkText(noBlank, W, WORST_CHAR_PT, n).join(''), noBlank);
});

test('exact split: leading/trailing/repeated blanks, TAB, CR LF, blank lines and empty edges survive byte for byte', () => {
  const samples = [
    '   leading and trailing   ' + 'слово '.repeat(60) + '   ',
    'a  b   c\t\td\t' + 'x  '.repeat(80),
    'первая\n\n\nтретья\r\n\r\nпятая\n' + 'строка '.repeat(50) + '\n\n',
    '\n\n\n' + 'z'.repeat(300) + '\t',
    ' '.repeat(400),
    'TiN, 5 µm, 1e-3 Pa, 2**3**2, ≤ ±α·β ' .repeat(30),
    '😀'.repeat(300) + 'e\u0301'.repeat(200),
  ];
  for (const sample of samples) {
    const parts = roundTrip(sample, 5);
    assert.ok(parts.length >= 2, `split into several parts: ${JSON.stringify(sample.slice(0, 20))}`);
  }
  assert.deepEqual(chunkText('', W, WORST_CHAR_PT, 5), ['']);
  assert.deepEqual(chunkText('TiN', W, WORST_CHAR_PT, 5), ['TiN'], 'short text is a single untouched part');
});

test('exact split: no surrogate pair, CR LF pair or combining mark is torn apart', () => {
  for (const text of ['😀'.repeat(400), 'a\r\n'.repeat(300), 'e\u0301'.repeat(400)]) {
    for (const part of roundTrip(text, 3)) {
      assert.ok(!/^[\uDC00-\uDFFF]/.test(part) && !/[\uD800-\uDBFF]$/.test(part), 'no lone surrogate');
      assert.ok(!part.startsWith('\n') || text.startsWith('\n') || !text.includes('\r\n'), 'CR LF kept together');
      assert.ok(!/^\p{M}/u.test(part), 'combining mark stays with its base');
    }
  }
});

test('exact split: splitTallRows keeps the value verbatim in the cells; the marker is a removable prefix, the rest of the row is untouched', () => {
  const value = '  Ti N  \t5 µm\n\n1e-3 Pa; 2**3**2   ' + '1234567890'.repeat(500) + '  \t ';
  const rows = splitTallRows([['2', 'Этап', 'Линия gas-1', value, 'ВКЛ']], [6, 16, 12, 16, 10], [0, 1, 2]);
  assert.ok(rows.length >= 3);
  rows.forEach((row, i) => {
    assert.ok(row[3].startsWith(`[${i + 1}/${rows.length}] `));
    assert.deepEqual(row.slice(0, 3), ['2', 'Этап', 'Линия gas-1']);
  });
  assert.equal(joinChunkCells(rows.map(r => r[3])), value);
  assert.equal(rows[0][4], 'ВКЛ');
  assert.ok(rows.slice(1).every(r => r[4] === CONTINUATION_CELL));
  // a value that does not need splitting is not touched at all (no marker, no trimming)
  const short = [['1', 'Этап', 'x', '  TiN \t 5 µm  ', 'ВКЛ']];
  assert.deepEqual(splitTallRows(short, [6, 16, 12, 16, 10], [0, 1, 2]), short);
});

/** All <w:t> texts of a DOCX in document order, XML entities decoded. */
function docxTexts(buffer: Buffer): string[] {
  const xml = readZipEntryText(buffer, 'word/document.xml');
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}

test('DOCX: the pieces of a split value come back exactly - strip the marker prefix, concatenate, compare', async () => {
  for (const original of ['1234567890'.repeat(600), 'AbВг-'.repeat(1200), ' \t двойной  пробел\t\tTAB\n\nпустая строка 1e-3 Pa, 2**3**2, TiN, 5 µm  '.repeat(80)]) {
    const doc = longGasDoc([original]);
    const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[1].rows;
    assert.ok(rows.length >= 2);
    assert.equal(joinChunkCells(rows.map(r => r[3])), original);
    const { buffer } = await exportTechDoc(doc, 'technologicalCard', 'docx');
    const texts = docxTexts(buffer);
    const pieces = texts.filter(t => CHUNK_MARKER_RE.test(t));
    assert.equal(pieces.length, rows.length, 'one marked cell per row');
    assert.equal(pieces.map(t => t.replace(CHUNK_MARKER_RE, '')).join(''), original, 'DOCX text equals the original exactly');
  }
});

test('PDF: the layout may re-wrap lines, but the characters are the original ones - whitespace-insensitive comparison across page breaks', async () => {
  const strip = (t: string) => t.replace(/\s+/g, '');
  for (const original of ['1234567890'.repeat(600), 'AbВг-'.repeat(1200), 'TiN 5 µm 1e-3 Pa 2**3**2 слово  двойной\tTAB\n\nпустая '.repeat(120)]) {
    const doc = longGasDoc([original]);
    const rows = buildDocumentViewModel(doc, 'technologicalCard').tables[1].rows;
    const parser = new PDFParse({ data: (await exportTechDoc(doc, 'technologicalCard', 'pdf')).buffer });
    const result = await parser.getText();
    await parser.destroy();
    assert.ok(result.pages.length >= 2, 'the value runs over a page break');
    // keep only what the gas-name column shows: from the first table header to the document tail, minus the row prefix
    // ("<step> <name> <line> [k/n] "), the other cells of the row, the repeated headers and the page footers
    const raw = result.pages.map((p: { text: string }) => p.text).join('\n');
    const from = raw.indexOf('Время подачи');
    const to = raw.indexOf('Traceability', from);
    assert.ok(from >= 0 && to > from);
    let body = raw.slice(from + 'Время подачи'.length, to);
    for (const noise of [/№\s*этапа\s*Этап Линия Газ Состояние Расход Время подачи/g, /Страница \d+ из \d+/g, /2 Адгезионный подслой Линия gas-1 \[\d+\/\d+\] ?/g, /ВКЛ 10 sccm 0–10 мин/g, /\(см\. выше\)/g]) body = body.replace(noise, '');
    // Two KNOWN renderer artefacts are accounted for explicitly (they are properties of PDFKit/DejaVu text extraction, not of the split):
    //  - U+00B5 (micro sign) is extracted as U+03BC (Greek mu) - the same glyph;
    //  - a TAB is drawn as a missing-glyph box and extracted as NUL. The DOCX holds the exact TAB; the PDF is a visual copy.
    const shown = strip(body).replace(/μ/g, 'µ').replace(/\u0000/g, '\t');
    assert.equal(strip(shown), strip(original), 'the characters the PDF shows, read in order, are exactly the original ones - none lost, none repeated at the page boundaries');
    assert.equal((result.pages.map((p: { text: string }) => p.text).join('\n').match(/\[\d+\/\d+\]/g) ?? []).length >= rows.length, true);
  }
});

test('short tables are unaffected by the exact-split work: a short card keeps its cells untouched', () => {
  const doc = fullDoc();
  const vm = buildDocumentViewModel(doc, 'technologicalCard');
  assert.equal(vm.tables.length, 1);
  assert.ok(vm.tables[0].rows.every(r => !r.some(c => /^\[\d+\/\d+\] /.test(c) || c === CONTINUATION_CELL)));
});
