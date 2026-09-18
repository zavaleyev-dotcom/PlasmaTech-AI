import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, PROCESS_PRESETS, STEP_TYPE_LABELS,
  addStep, removeStep, duplicateStep, moveStep, toggleStepEnabled, updateStep, calculateStepDurationFromDeposition,
  createDefaultGasLines, addGasLine, updateGasLine,
  addMagnetron, updateMagnetron, addArcSource, updateArcSource,
  buildInstructionView, buildTechnologicalCard, buildRouteCard, buildBriefRecipe, buildExport,
  createQualityCheck, touchDocument,
  type TechnicalProcessDocument,
} from '../src/services/workspace/techdoc-assistant';

function withName(doc: TechnicalProcessDocument, name = 'Тестовый процесс'): TechnicalProcessDocument {
  return { ...doc, general: { ...doc.general, processName: name } };
}

// ---------- blank document ----------

test('createBlankDocument: starts empty, with 5 default gas lines and no steps, and validates cleanly once a process name is set', () => {
  const doc = createBlankDocument();
  assert.equal(doc.steps.length, 0);
  assert.equal(doc.gasSystem.length, 5);
  assert.equal(doc.traceability.version, 1);
  assert.equal(doc.traceability.source, 'blank');
  assert.throws(() => validateDocument(doc), /Название процесса/);
  assert.doesNotThrow(() => validateDocument(withName(doc)));
});

// ---------- presets create structure only ----------

test('createDocumentFromPreset: creates the expected stage structure with no pre-filled technological parameters', () => {
  const doc = createDocumentFromPreset('magnetron-pvd');
  const preset = PROCESS_PRESETS.find(p => p.id === 'magnetron-pvd')!;
  assert.equal(doc.steps.length, preset.stepTypes.length);
  assert.deepEqual(doc.steps.map(s => s.type), preset.stepTypes);
  assert.deepEqual(doc.steps.map(s => s.order), preset.stepTypes.map((_, i) => i + 1));
  for (const step of doc.steps) {
    assert.equal(step.origin, 'preset');
    assert.equal(step.name, STEP_TYPE_LABELS[step.type]);
    assert.equal(step.durationMin, undefined);
    assert.equal(step.temperatureC, undefined);
    assert.equal(step.pressureMbar, undefined);
    assert.equal(step.powerW, undefined);
    assert.deepEqual(step.gasUsage, []);
  }
  assert.equal(doc.traceability.source, 'magnetron-pvd');
});

test('every preset produces a stage list drawn only from the supported step-type vocabulary, and covers non-PVD processes (PECVD/etching/cleaning)', () => {
  assert.equal(PROCESS_PRESETS.length, 6);
  const ids = PROCESS_PRESETS.map(p => p.id);
  assert.ok(ids.includes('pecvd'));
  assert.ok(ids.includes('icp-rie-etching'));
  assert.ok(ids.includes('plasma-cleaning'));
  const etching = createDocumentFromPreset('icp-rie-etching');
  assert.ok(etching.steps.some(s => s.type === 'etching'));
  const cleaning = createDocumentFromPreset('plasma-cleaning');
  assert.ok(cleaning.steps.some(s => s.type === 'plasma_ion_cleaning'));
  assert.throws(() => createDocumentFromPreset('does-not-exist'), /Пресет не найден/);
});

// ---------- user values are preserved exactly, no silent substitution ----------

test('user-entered values are preserved exactly - no rounding, correction, or substitution by the system', () => {
  let doc = createDocumentFromPreset('magnetron-pvd');
  doc = { ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 187.654321, pressureMbar: 0.00013579, notes: '  raw text, not touched  ' }) };
  const step = doc.steps.find(s => s.order === 1)!;
  assert.equal(step.temperatureC, 187.654321);
  assert.equal(step.pressureMbar, 0.00013579);
  assert.equal(step.notes, '  raw text, not touched  ');
  assert.equal(step.origin, 'user'); // editing a preset step marks it user-modified
});

test('missing optional values stay genuinely empty (undefined), never defaulted to 0 or a placeholder number', () => {
  const doc = createDocumentFromPreset('pecvd');
  for (const step of doc.steps) {
    assert.equal(step.durationMin, undefined);
    assert.equal(step.substrateBiasV, undefined);
    assert.equal(step.rotationRpm, undefined);
    assert.equal(step.distanceMm, undefined);
    assert.equal(step.acceptanceCriteria, undefined);
  }
});

// ---------- invalid numeric input ----------

test('validateDocument: rejects NaN/Infinity, negative time/pressure/flow/power, but never rejects a merely unusual (e.g. very high) temperature', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'main_coating') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 900 }) }), 'a high but finite temperature is the technologist\'s call, not an error');
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: NaN }) }), /температура/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: Infinity }) }), /температура/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { durationMin: -5 }) }), /длительность/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { pressureMbar: -1 }) }), /давление/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { powerW: -100 }) }), /мощность/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { gasUsage: [{ gas: 'Ar', flowSccm: -1 }] }) }), /расход газа/);
});

test('validateDocument: rejects a duplicate step order and an empty process name', () => {
  const doc = withName(createBlankDocument());
  const withSteps = { ...doc, steps: [
    { order: 1, name: 'A', type: 'loading' as const, enabled: true, gasUsage: [], origin: 'user' as const, calculatedFields: [] },
    { order: 1, name: 'B', type: 'cooling' as const, enabled: true, gasUsage: [], origin: 'user' as const, calculatedFields: [] },
  ] };
  assert.throws(() => validateDocument(withSteps), /Дублирующийся номер этапа/);
  assert.throws(() => validateDocument({ ...doc, general: { processName: '   ' } }), /Название процесса/);
});

// ---------- gas system: 5 lines minimum, custom gas names ----------

test('gas system: default is 5 lines, more can be added, and gas names are free text (not limited to Ar/N2/O2)', () => {
  let lines = createDefaultGasLines();
  assert.equal(lines.length, 5);
  lines = updateGasLine(lines, lines[0].id, { gas: 'C2H2', flow: 15, enabled: true });
  assert.equal(lines[0].gas, 'C2H2');
  lines = addGasLine(lines);
  assert.equal(lines.length, 6);
});

// ---------- sources: multiple magnetrons, arc, ICP/bias ----------

test('sources: supports multiple independent magnetrons and arc sources, plus ICP/RF and ion source with bias', () => {
  let doc = createBlankDocument();
  doc = { ...doc, sources: addMagnetron(doc.sources) };
  doc = { ...doc, sources: addMagnetron(doc.sources) };
  assert.equal(doc.sources.magnetrons.length, 2);
  doc = { ...doc, sources: updateMagnetron(doc.sources, doc.sources.magnetrons[0].id, { material: 'Ti', powerW: 3000, mode: 'DC' }) };
  doc = { ...doc, sources: updateMagnetron(doc.sources, doc.sources.magnetrons[1].id, { material: 'Cr', powerW: 2000 }) };
  assert.equal(doc.sources.magnetrons[0].material, 'Ti');
  assert.equal(doc.sources.magnetrons[1].material, 'Cr');

  doc = { ...doc, sources: addArcSource(doc.sources) };
  doc = { ...doc, sources: updateArcSource(doc.sources, doc.sources.arcSources[0].id, { cathodeMaterial: 'TiAl', arcCurrentA: 80, filtered: true }) };
  assert.equal(doc.sources.arcSources[0].arcCurrentA, 80);
  assert.equal(doc.sources.arcSources[0].filtered, true);

  doc = { ...doc, sources: { ...doc.sources, icpRf: { enabled: true, powerW: 500, biasV: -80 } } };
  assert.equal(doc.sources.icpRf.biasV, -80); // negative bias is physically normal - must not be rejected
  assert.doesNotThrow(() => validateDocument(withName(doc)));
});

// ---------- recipe builder: reorder / duplicate / remove / disable ----------

test('recipe builder: add, reorder, duplicate, disable and remove steps keep order sequential and data intact', () => {
  let steps = addStep([], 'loading');
  steps = addStep(steps, 'pumpdown');
  steps = addStep(steps, 'main_coating');
  assert.deepEqual(steps.map(s => s.order), [1, 2, 3]);

  steps = moveStep(steps, 1, 'down');
  assert.deepEqual(steps.map(s => s.type), ['pumpdown', 'loading', 'main_coating']);
  assert.deepEqual(steps.map(s => s.order), [1, 2, 3]);

  steps = duplicateStep(steps, 2);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map(s => s.order), [1, 2, 3, 4]);
  assert.equal(steps[1].type, 'loading');
  assert.equal(steps[2].type, 'loading'); // the duplicate sits right after the original

  steps = toggleStepEnabled(steps, 3);
  assert.equal(steps.find(s => s.order === 3)!.enabled, false);

  steps = removeStep(steps, 1);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map(s => s.order), [1, 2, 3]);
});

// ---------- document views ----------

test('technological card output: shows "—" for every unset field, and real values for what was entered', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: updateStep(doc.steps, 6, { temperatureC: 350, pressureMbar: 0.005, gasUsage: [{ gas: 'Ar', flowSccm: 40 }] }) };
  const card = buildTechnologicalCard(doc);
  assert.equal(card.length, doc.steps.length);
  const mainCoating = card.find(r => r.number === 6)!;
  assert.equal(mainCoating.temperature, '350°C');
  assert.equal(mainCoating.pressure, '0.005 мбар');
  assert.equal(mainCoating.gases, 'Ar (40 см³/мин)');
  const untouched = card.find(r => r.number === 1)!;
  assert.equal(untouched.duration, '—');
  assert.equal(untouched.temperature, '—');
  assert.equal(untouched.control, '—');
});

test('route card output: input/output are positional references, equipment reused from general info, control points to quality checks for QC steps', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const withEquipment = { ...doc, general: { ...doc.general, equipment: 'Установка X' } };
  const route = buildRouteCard(withEquipment);
  assert.equal(route[0].input, 'Исходное изделие');
  assert.equal(route[route.length - 1].output, 'Готовое изделие');
  assert.ok(route.every(r => r.equipment === 'Установка X'));
  const qcRow = route.find(r => r.stage === STEP_TYPE_LABELS.quality_control)!;
  assert.equal(qcRow.control, 'см. раздел «Контроль качества»');
});

test('instruction output: is built from the same document data, includes all sections, and never fabricates a value', () => {
  const doc = withName(createDocumentFromPreset('pecvd'));
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('Технологическая инструкция'));
  assert.ok(instruction.includes('B. Исходные данные'));
  assert.ok(instruction.includes('не задано'));
  assert.ok(!instruction.includes('undefined'));
});

test('all four views (instruction, tech card, route card, brief recipe) are derived from one document with no manual duplication of literals', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const exported = buildExport(doc);
  assert.ok(exported.markdown.instruction.length > 0);
  assert.ok(exported.markdown.technologicalCard.includes('Операция'));
  assert.ok(exported.markdown.routeCard.includes('Оборудование'));
  assert.ok(exported.markdown.briefRecipe.includes('Краткий рецепт'));
  assert.deepEqual(exported.json, doc);
});

test('brief recipe: skips disabled steps and shows only entered parameters', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: toggleStepEnabled(doc.steps, 1) };
  doc = { ...doc, steps: updateStep(doc.steps, 6, { temperatureC: 300 }) };
  const recipe = buildBriefRecipe(doc);
  assert.ok(!recipe.includes('1. Загрузка'));
  assert.ok(recipe.includes('T: 300°C'));
});

// ---------- quality checks ----------

test('quality checks: categories are suggestions only - user supplies method/criterion/result themselves', () => {
  const qc = createQualityCheck('Толщина покрытия');
  assert.equal(qc.parameter, 'Толщина покрытия');
  assert.equal(qc.method, undefined);
  assert.equal(qc.criterion, undefined);
  assert.equal(qc.result, undefined);
  assert.equal(qc.status, undefined);
});

// ---------- traceability ----------

test('traceability: version increments and updatedAt changes on touch, while createdAt and source never change', () => {
  const doc = createDocumentFromPreset('pecvd');
  const touched = touchDocument(doc);
  assert.equal(touched.traceability.version, doc.traceability.version + 1);
  assert.equal(touched.traceability.createdAt, doc.traceability.createdAt);
  assert.equal(touched.traceability.source, doc.traceability.source);
});

// ---------- calculated values only after an explicit action ----------

test('calculateStepDurationFromDeposition: only sets a step\'s duration when explicitly invoked, and stamps calculatedFields - never runs silently', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const before = doc.steps.find(s => s.order === 6)!;
  assert.equal(before.durationMin, undefined);
  assert.deepEqual(before.calculatedFields, []);

  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 6, 1000, 'nm', 10, 'nm_per_min') };
  const after = doc.steps.find(s => s.order === 6)!;
  assert.ok(Math.abs(after.durationMin! - 100) < 1e-9);
  assert.deepEqual(after.calculatedFields, ['durationMin']);

  // every other step remains untouched
  const other = doc.steps.find(s => s.order === 1)!;
  assert.equal(other.durationMin, undefined);
});

test('no silent parameter substitution: an untouched preset document round-trips through every view with every field genuinely absent', () => {
  const doc = withName(createDocumentFromPreset('icp-rie-etching'));
  const exported = buildExport(doc);
  assert.ok(!exported.markdown.technologicalCard.includes('undefined'));
  assert.ok(!exported.markdown.routeCard.includes('undefined'));
  assert.ok(exported.markdown.technologicalCard.includes('—'));
  for (const step of doc.steps) assert.equal(step.calculatedFields.length, 0);
});
