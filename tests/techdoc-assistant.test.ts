import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, PROCESS_PRESETS, STEP_TYPES, STEP_TYPE_LABELS,
  addStep, removeStep, duplicateStep, moveStep, toggleStepEnabled, updateStep, calculateStepDurationFromDeposition, addGas, updateGas, addSource, updateSource, createStep,
  buildInstructionView, buildTechnologicalCard, buildRouteCard, buildBriefRecipe, buildExport,
  createQualityCheck, touchDocument, tryRestoreDocument,
  type TechnicalProcessDocument,
} from '../src/services/workspace/techdoc-assistant';

function withName(doc: TechnicalProcessDocument, name = 'Тестовый процесс'): TechnicalProcessDocument {
  return { ...doc, general: { ...doc.general, processName: name } };
}

test('createBlankDocument: starts empty - no steps, no equipment registry, no legacy data - and validates cleanly once a process name is set', () => {
  const doc = createBlankDocument();
  assert.equal(doc.steps.length, 0);
  assert.equal(doc.schemaVersion, 4);
  assert.deepEqual(doc.legacy, { stepFields: [], steps: [] });
  assert.ok(!('sources' in doc) && !('gasSystem' in doc), 'sources and gas lines belong to the cards, not to the document');
  assert.equal(doc.traceability.version, 1);
  assert.equal(doc.traceability.source, 'blank');
  assert.throws(() => validateDocument(doc), /Название процесса/);
  assert.doesNotThrow(() => validateDocument(withName(doc)));
});

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
    assert.equal(step.pressurePa, undefined);
    assert.deepEqual(step.sources, []);
    assert.deepEqual(step.gases, []);
  }
  assert.equal(doc.traceability.source, 'magnetron-pvd');
});

test('every preset produces a stage list drawn only from the eight card types, and covers non-PVD processes (PECVD/etching/cleaning)', () => {
  assert.equal(PROCESS_PRESETS.length, 6);
  const ids = PROCESS_PRESETS.map(p => p.id);
  assert.ok(ids.includes('pecvd'));
  assert.ok(ids.includes('icp-rie-etching'));
  assert.ok(ids.includes('plasma-cleaning'));
  for (const preset of PROCESS_PRESETS) for (const type of createDocumentFromPreset(preset.id).steps.map(s => s.type)) assert.ok((STEP_TYPES as readonly string[]).includes(type), `${preset.id}: ${type}`);
  assert.ok(createDocumentFromPreset('icp-rie-etching').steps.some(s => s.type === 'plasma_ion_cleaning'));
  assert.ok(createDocumentFromPreset('plasma-cleaning').steps.some(s => s.type === 'plasma_ion_cleaning'));
  assert.throws(() => createDocumentFromPreset('does-not-exist'), /Пресет не найден/);
});

test('user-entered values are preserved exactly - no rounding, correction, or substitution by the system', () => {
  let doc = createDocumentFromPreset('magnetron-pvd');
  doc = { ...doc, steps: updateStep(doc.steps, 5, { temperatureC: 187.654321, pressurePa: 0.013579, description: '  raw text, not touched  ' }) };
  const step = doc.steps.find(s => s.order === 5)!;
  assert.equal(step.temperatureC, 187.654321);
  assert.equal(step.pressurePa, 0.013579);
  assert.equal(step.description, '  raw text, not touched  ');
  assert.equal(step.origin, 'user'); // editing a preset step marks it user-modified
});

test('missing optional values stay genuinely empty (undefined), never defaulted to 0 or a placeholder number', () => {
  const doc = createDocumentFromPreset('pecvd');
  for (const step of doc.steps) {
    assert.equal(step.durationMin, undefined);
    assert.equal(step.substrateBiasV, undefined);
    assert.equal(step.rotationRpm, undefined);
    assert.equal(step.distanceMm, undefined);
    assert.equal(step.thicknessNm, undefined);
    assert.equal(step.substrateCount, undefined);
  }
});

// ---------- invalid numeric input ----------

test('validateDocument: rejects NaN/Infinity, negative time/pressure/thickness/flow, but never rejects a merely unusual (e.g. very high) temperature', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 900 }) }), 'a high but finite temperature is the technologist\'s call, not an error');
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: NaN }) }), /температура/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: Infinity }) }), /температура/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { durationMin: -5 }) }), /продолжительность/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { pressurePa: -1 }) }), /давление/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { thicknessNm: -10 }) }), /толщина/);
  const withGas = addGas(doc.steps, { order: 1 });
  assert.throws(() => validateDocument({ ...doc, steps: updateGas(withGas, { order: 1 }, withGas[0].gases[0].id, { flowSccm: -1 }) }), /расход/);
});

test('validateDocument (F08): rejects negative rotation speed and negative target-to-substrate distance - magnitudes with no negative convention anywhere in this model', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { rotationRpm: -10 }) }), /вращение/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { distanceMm: -50 }) }), /расстояние/);
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { rotationRpm: 30, distanceMm: 120 }) }));
});

test('validateDocument (F08): substrate bias stays finite-only (never rejected merely for being negative - that is its normal, expected sign in PVD)', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { substrateBiasV: -80 }) }), 'a negative bias is the normal case in PVD, not an error');
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { substrateBiasV: NaN }) }), /смещения/);
});

test('validateDocument (F08): an unusual but physically possible high temperature (e.g. 900 °C) is never rejected just because it is large - no invented technological ceiling', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 900 }) }));
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: -196 }) }), 'a real cryogenic sub-zero temperature is also not an error');
});

// ---------- F08 (MEDIUM) Codex regression: temperature must never go below absolute zero ----------

test('validateDocument (F08): -500 °C (physically impossible, far below absolute zero) is rejected - the exact Codex reproduction', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: -500 }) }), /абсолютного нуля/);
});

test('validateDocument (F08): -273.16 °C (one hundredth of a degree below absolute zero) is rejected', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: -273.16 }) }), /абсолютного нуля/);
});

test('validateDocument (F08): -273.15 °C (exactly absolute zero, 0 K) is accepted at the boundary, not rejected by an off-by-a-hair floating-point comparison', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: -273.15 }) }));
});

test('validateDocument (F08): 900 °C and other high positive temperatures remain unbounded - no arbitrary technological ceiling was introduced alongside the absolute-zero floor', () => {
  let doc = withName(createBlankDocument());
  doc = { ...doc, steps: addStep(doc.steps, 'adhesion_underlayer') };
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 900 }) }));
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { temperatureC: 5000 }) }), 'an extreme but not physically impossible temperature is still never capped');
});

test('validateDocument (F08): "Допустимая температура" (initialData.allowedTemperatureC) gets the same absolute-zero floor as a per-step temperature', () => {
  const doc = withName(createBlankDocument());
  assert.throws(() => validateDocument({ ...doc, initialData: { ...doc.initialData, allowedTemperatureC: -300 } }), /абсолютного нуля/);
  assert.doesNotThrow(() => validateDocument({ ...doc, initialData: { ...doc.initialData, allowedTemperatureC: 850 } }));
});

test('validateDocument: rejects a duplicate step order and an empty process name', () => {
  const doc = withName(createBlankDocument());
  const withSteps = { ...doc, steps: [
    { ...createStep('loading', 'A', 'user', 'step-1'), order: 1 },
    { ...createStep('cooling', 'B', 'user', 'step-2'), order: 1 },
  ] };
  assert.throws(() => validateDocument(withSteps), /Дублирующийся номер этапа/);
  assert.throws(() => validateDocument({ ...doc, general: { processName: '   ' } }), /Название процесса/);
});

test('recipe builder: add, reorder, duplicate, disable and remove steps keep order sequential and data intact', () => {
  let steps = addStep([], 'loading');
  steps = addStep(steps, 'pumpdown');
  steps = addStep(steps, 'cooling');
  assert.deepEqual(steps.map(s => s.order), [1, 2, 3]);

  steps = moveStep(steps, 1, 'down');
  assert.deepEqual(steps.map(s => s.type), ['pumpdown', 'loading', 'cooling']);
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

test('provenance after copy (Codex regression): duplicating a preset-sourced step marks the copy as user-created, never as still coming from the preset', () => {
  const doc = createDocumentFromPreset('magnetron-pvd');
  assert.equal(doc.steps[0].origin, 'preset');
  const withCopy = duplicateStep(doc.steps, 1);
  assert.equal(withCopy[0].origin, 'preset', 'the original step keeps its real preset origin');
  assert.equal(withCopy[1].origin, 'user', 'the duplicate is an explicit user action and must say so');
  // every OTHER step must be untouched by the copy
  for (let i = 2; i < withCopy.length; i++) assert.equal(withCopy[i].origin, 'preset');
});

// ---------- document views ----------

test('technological card output: shows "—" for every unset field, and real values for what was entered', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: updateStep(doc.steps, 5, { temperatureC: 350, pressurePa: 0.5 }) };
  const card = buildTechnologicalCard(doc);
  assert.equal(card.length, doc.steps.length);
  const adhesion = card.find(r => r.number === 5)!;
  assert.equal(adhesion.temperature, '350°C');
  assert.equal(adhesion.pressure, '0.5 Па');
  const untouched = card.find(r => r.number === 1)!;
  assert.equal(untouched.duration, '—');
  assert.equal(untouched.temperature, '—');
  assert.equal(untouched.description, '—');
});

test('route card output: input/output are positional references and equipment is reused from general info', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const withEquipment = { ...doc, general: { ...doc.general, equipment: 'Установка X' } };
  const route = buildRouteCard(withEquipment);
  assert.equal(route[0].input, 'Исходное изделие');
  assert.equal(route[route.length - 1].output, 'Готовое изделие');
  assert.ok(route.every(r => r.equipment === 'Установка X'));
  assert.deepEqual(Object.keys(route[0]), ['number', 'stage', 'equipment', 'input', 'operation', 'output'], 'no acceptance-criterion / note columns any more');
});

test('route card (Codex regression): disabled steps are skipped in the input/output chain - neighbors reference the nearest ENABLED step, never a step that was actually skipped', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const withDisabled = { ...doc, steps: toggleStepEnabled(doc.steps, 2) }; // disable step 2 ("Откачка")
  const route = buildRouteCard(withDisabled);
  assert.equal(route[0].output, 'на операцию №3', 'step 1 must hand off to the next ENABLED step (3), not the disabled step 2');
  assert.equal(route[2].input, 'результат операции №1', 'step 3 must receive from the nearest ENABLED predecessor (1), not the disabled step 2');
  assert.ok(route[1].operation.includes('отключён'));
});

test('route card (Codex regression): disabling the very first or very last step still resolves to "Исходное изделие" / "Готовое изделие" for their neighbors', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  let steps = toggleStepEnabled(doc.steps, 1);
  steps = toggleStepEnabled(steps, steps.length);
  const route = buildRouteCard({ ...doc, steps });
  assert.equal(route[1].input, 'Исходное изделие');
  assert.equal(route[route.length - 2].output, 'Готовое изделие');
});

test('instruction output: is built from the same document data, includes all sections, and never fabricates a value', () => {
  const doc = withName(createDocumentFromPreset('pecvd'));
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('Технологическая инструкция'));
  // "includes all sections" must actually check every section (Codex: this used to check only
  // one of five headers, so a section could silently disappear without failing the test).
  for (const heading of ['A. Основные сведения', 'B. Требования к процессу', 'C. Технологические этапы', 'D. Контроль качества', 'E. Безопасность']) {
    assert.ok(instruction.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(instruction.includes('не задано'));
  assert.ok(!instruction.includes('undefined'));
  for (const gone of ['Источники (справочник', 'Газовая система', 'Критерий приёмки', 'Примечание:']) assert.ok(!instruction.includes(gone), `removed: ${gone}`);
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
  doc = { ...doc, steps: updateStep(doc.steps, 5, { temperatureC: 300 }) };
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

// ---------- F17 (LOW): quality-check unit must appear in the instruction text/UI view exactly
// as it does in the export QC table, for criterion AND result, never invented when unset ----------

test('F17 buildInstructionView: a quality check with a unit shows it attached to both criterion and result (thickness = 2.5 µm)', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Толщина покрытия'), method: 'Калотест', criterion: '>= 2.0', unit: 'µm', result: '2.5', status: 'pass' }] };
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('критерий — >= 2.0 µm'), instruction);
  assert.ok(instruction.includes('результат — 2.5 µm'), instruction);
});

test('F17 buildInstructionView: roughness = 10 nm and temperature = 400 °C both carry their unit in the instruction text', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = {
    ...doc,
    qualityChecks: [
      { ...createQualityCheck('Шероховатость'), criterion: '<= 15', unit: 'nm', result: '10' },
      { ...createQualityCheck('Температура'), criterion: '400', unit: '°C', result: '400' },
    ],
  };
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('результат — 10 nm'), instruction);
  assert.ok(instruction.includes('результат — 400 °C'), instruction);
});

test('F17 buildInstructionView: no unit set -> criterion/result render exactly as typed, nothing invented', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Визуальный контроль'), criterion: 'без дефектов', result: 'соответствует' }] };
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('критерий — без дефектов'));
  assert.ok(instruction.includes('результат — соответствует'));
  assert.ok(!instruction.includes('без дефектов undefined'));
});

test('F17 buildInstructionView: an unset criterion/result never gets a fabricated unit-only value', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Адгезия'), unit: 'МПа' }] };
  const instruction = buildInstructionView(doc);
  assert.ok(instruction.includes('критерий — не задано'));
  assert.ok(instruction.includes('результат — не задано'));
});

test('F17 UI/export consistency: the exact same quality check shows the unit both in buildInstructionView (UI preview) and in the export QC table', async () => {
  const { buildDocumentViewModel } = await import('../src/services/workspace/techdoc-export');
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Толщина покрытия'), criterion: '>= 2.0', unit: 'µm', result: '2.5', status: 'pass' }] };
  const instruction = buildInstructionView(doc);
  const viewModel = buildDocumentViewModel(doc, 'instruction');
  assert.ok(instruction.includes('2.5 µm'));
  const exportedRow = viewModel.qualityChecks[0];
  assert.equal(exportedRow.unit, 'µm');
  assert.equal(exportedRow.result, '2.5');
});

// ---------- traceability ----------

test('traceability: version increments and updatedAt changes on touch, while createdAt and source never change', () => {
  const doc = createDocumentFromPreset('pecvd');
  const touched = touchDocument(doc);
  assert.equal(touched.traceability.version, doc.traceability.version + 1);
  assert.equal(touched.traceability.createdAt, doc.traceability.createdAt);
  assert.equal(touched.traceability.source, doc.traceability.source);
});

// ---------- honest local (browser) persistence (Codex regression) ----------

test('tryRestoreDocument (Codex regression): restores a validly-saved document exactly, so a page reload after "Сохранить структуру" genuinely gets the saved data back', () => {
  const doc = withName(createDocumentFromPreset('pecvd'));
  const restored = tryRestoreDocument(JSON.stringify(doc));
  // F07 changed tryRestoreDocument to run the persisted JSON through the same structural
  // parser the export API route uses - every optional field the ORIGINAL object simply never
  // had a key for now comes back explicitly `undefined` instead of absent (e.g.
  // `{processName: 'x'}` -> `{processName: 'x', purpose: undefined, ...}`). Both mean exactly
  // the same thing to every reader in this app (`=== undefined`/`?.`), but they are not
  // `deepEqual` as raw objects - comparing the JSON representation (how this is actually
  // persisted and read back for real) is the meaningful equivalence check here.
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(doc)));
});

test('tryRestoreDocument (Codex regression): never crashes or loads bad data - missing, malformed, non-JSON, or failing-validation input all fall back to null', () => {
  assert.equal(tryRestoreDocument(null), null);
  assert.equal(tryRestoreDocument(undefined), null);
  assert.equal(tryRestoreDocument(''), null);
  assert.equal(tryRestoreDocument('not json at all'), null);
  assert.equal(tryRestoreDocument(JSON.stringify({ general: { processName: '' } })), null, 'a saved document that fails validateDocument (e.g. empty process name) must not be loaded silently');
  assert.equal(tryRestoreDocument(JSON.stringify({ general: { processName: '   ' } })), null, 'whitespace-only process name must also be rejected, matching validateDocument');
});

// ---------- F07 (MEDIUM): restore boundary - real runtime schema validation, not just value ranges ----------

test('F07: structurally invalid JSON (steps replaced by a string instead of an array) is rejected, never accepted as a document with a broken steps field', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const corrupted = { ...doc, steps: 'not an array at all' };
  assert.equal(tryRestoreDocument(JSON.stringify(corrupted)), null);
});

test('F07: missing required nested objects/arrays (safety, qualityChecks, legacy entirely absent) still restore safely - filled in with a real empty shape, never a half-broken object that crashes a later view', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const rest = { ...(doc as unknown as Record<string, unknown>) };
  delete rest.safety;
  delete rest.qualityChecks;
  delete rest.legacy;
  const restored = tryRestoreDocument(JSON.stringify(rest));
  assert.ok(restored !== null, 'a document missing these fields entirely must still restore (they get a real, empty, well-shaped default)');
  assert.deepEqual(restored!.safety.hazards, []);
  assert.deepEqual(restored!.safety.ppe, []);
  assert.deepEqual(restored!.safety.interlocks, []);
  assert.deepEqual(restored!.qualityChecks, []);
  assert.deepEqual(restored!.legacy, { stepFields: [], steps: [] });
  // the restored document must be genuinely usable by every view, not just "not null"
  assert.doesNotThrow(() => buildInstructionView(restored!));
});

test('F07: a wrong field TYPE inside a nested object (a source power as a string) is rejected, not silently coerced or left to crash a later render', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: addSource(doc.steps, { order: 5 }, 'magnetron') };
  doc = { ...doc, steps: updateSource(doc.steps, { order: 5 }, 'magnetron-1', { powerW: 3000 }) };
  assert.ok(tryRestoreDocument(JSON.stringify(doc)) !== null);
  const corrupted = JSON.stringify(doc).replace('"powerW":3000', '"powerW":"THREE THOUSAND"');
  assert.equal(tryRestoreDocument(corrupted), null);
});

test('F07: one partially corrupted step inside an otherwise valid steps array is rejected wholesale, never silently dropped or half-loaded', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const raw = JSON.parse(JSON.stringify(doc));
  raw.steps[2] = { order: 3 }; // missing required `name`/`type`
  assert.equal(tryRestoreDocument(JSON.stringify(raw)), null);
});

test('F07: a genuinely valid, fully-populated persisted document (cards with sources and gases, quality checks, safety) still restores correctly - the stricter parser does not regress the happy path', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: addSource(doc.steps, { order: 5 }, 'magnetron') };
  doc = { ...doc, steps: updateSource(doc.steps, { order: 5 }, 'magnetron-1', { powerW: 3000, material: 'Ti', operatingMode: 'DC' }) };
  doc = { ...doc, steps: addGas(doc.steps, { order: 5 }) };
  doc = { ...doc, steps: updateGas(doc.steps, { order: 5 }, 'gas-1', { gas: 'Ar', flowSccm: 40 }) };
  doc = { ...doc, qualityChecks: [{ ...createQualityCheck('Толщина'), method: 'Калотест', result: '2.3 мкм', status: 'pass' }] };
  doc = { ...doc, safety: { ...doc.safety, hazards: ['Высокое напряжение'] } };
  const restored = tryRestoreDocument(JSON.stringify(doc));
  assert.ok(restored !== null);
  const step = restored!.steps.find(s => s.order === 5)!;
  assert.equal(step.sources[0].powerW, 3000);
  assert.equal(step.sources[0].material, 'Ti');
  assert.equal(step.gases[0].gas, 'Ar');
  assert.equal(restored!.qualityChecks[0].status, 'pass');
  assert.deepEqual(restored!.safety.hazards, ['Высокое напряжение']);
});

test('calculateStepDurationFromDeposition: only sets a step\'s duration when explicitly invoked, and stamps calculatedFields - never runs silently', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const before = doc.steps.find(s => s.order === 5)!;
  assert.equal(before.durationMin, undefined);
  assert.deepEqual(before.calculatedFields, []);

  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  const after = doc.steps.find(s => s.order === 5)!;
  assert.ok(Math.abs(after.durationMin! - 100) < 1e-9);
  assert.deepEqual(after.calculatedFields, ['durationMin']);

  // every other step remains untouched
  const other = doc.steps.find(s => s.order === 1)!;
  assert.equal(other.durationMin, undefined);
});

// ---------- invalid duration-calculator input: clear errors, never a silently invented value ----------
// Regression for the full-functional-audit finding: the UI call site did not catch this throw,
// crashing the page. The fix is UI-side (a try/catch around the call in StepCard); these tests
// pin down the exact, human-readable error messages that catch block now surfaces to the user.

test('calculateStepDurationFromDeposition: zero/negative/non-finite thickness or rate throws a clear, field-named message - never silently computes a duration', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const invalidThicknesses = [0, -5, NaN, Infinity];
  for (const thickness of invalidThicknesses) {
    assert.throws(
      () => calculateStepDurationFromDeposition(doc.steps, 5, thickness, 'nm', 10, 'nm_per_min'),
      /Толщина покрытия: введите положительное число\./,
      `thickness=${thickness} must throw a clear validation message`,
    );
  }
  const invalidRates = [0, -1, NaN, Infinity];
  for (const rate of invalidRates) {
    assert.throws(
      () => calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', rate, 'nm_per_min'),
      /Скорость осаждения: введите положительное число\./,
      `rate=${rate} must throw a clear validation message`,
    );
  }
});

test('calculateStepDurationFromDeposition: an empty input field (Number(\'\') === 0, the exact case the UI can produce) is rejected the same way, not treated as zero-duration', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  assert.throws(() => calculateStepDurationFromDeposition(doc.steps, 5, Number(''), 'nm', 10, 'nm_per_min'), /Толщина покрытия/);
  assert.throws(() => calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', Number(''), 'nm_per_min'), /Скорость осаждения/);
});

test('calculateStepDurationFromDeposition: an invalid call never mutates the original steps array (the caller\'s existing state stays intact after the throw)', () => {
  const doc = withName(createDocumentFromPreset('magnetron-pvd'));
  const before = JSON.stringify(doc.steps);
  assert.throws(() => calculateStepDurationFromDeposition(doc.steps, 5, 0, 'nm', 10, 'nm_per_min'));
  assert.equal(JSON.stringify(doc.steps), before, 'the input steps array must be unchanged after a rejected calculation');
});

test('no silent parameter substitution: an untouched preset document round-trips through every view with every field genuinely absent', () => {
  const doc = withName(createDocumentFromPreset('icp-rie-etching'));
  const exported = buildExport(doc);
  assert.ok(!exported.markdown.technologicalCard.includes('undefined'));
  assert.ok(!exported.markdown.routeCard.includes('undefined'));
  assert.ok(exported.markdown.technologicalCard.includes('—'));
  for (const step of doc.steps) assert.equal(step.calculatedFields.length, 0);
});

// ---------- F06 (MEDIUM): provenance must reflect what actually produced the CURRENT value ----------

test('F06: calculate -> the step is correctly stamped as system-calculated', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  const step = doc.steps.find(s => s.order === 5)!;
  assert.deepEqual(step.calculatedFields, ['durationMin']);
  assert.ok(Math.abs(step.durationMin! - 100) < 1e-9);
});

test('F06: edit calculated value -> manually overwriting durationMin clears its "calculated" provenance stamp (Codex regression: it previously stayed stamped after a manual edit)', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  assert.deepEqual(doc.steps.find(s => s.order === 5)!.calculatedFields, ['durationMin']);

  doc = { ...doc, steps: updateStep(doc.steps, 5, { durationMin: 250 }) };
  const edited = doc.steps.find(s => s.order === 5)!;
  assert.equal(edited.durationMin, 250, 'the manually-entered value itself must be preserved exactly');
  assert.deepEqual(edited.calculatedFields, [], 'provenance must no longer claim this value is system-calculated');
  assert.equal(edited.origin, 'user');
});

test('F06: editing an UNRELATED field never clears a different field\'s calculated stamp', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  doc = { ...doc, steps: updateStep(doc.steps, 5, { temperatureC: 350 }) };
  const step = doc.steps.find(s => s.order === 5)!;
  assert.deepEqual(step.calculatedFields, ['durationMin'], 'durationMin is still genuinely the calculator\'s value - only editing IT should clear the stamp');
  assert.equal(step.temperatureC, 350);
});

test('F06 (Codex regression #2): copy a calculated step -> the copy KEEPS the "calculated" stamp for the field whose value was copied unchanged - `origin` (step-level: "created as a user copy") and `calculatedFields` (field-level: "this value came from a calculator") are different facts, and copying a step must never erase the second just because it always sets the first', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  doc = { ...doc, steps: duplicateStep(doc.steps, 5) };
  const copy = doc.steps.find(s => s.order === 6)!;
  assert.equal(copy.durationMin, 100, 'the copy starts with the same value...');
  assert.deepEqual(copy.calculatedFields, ['durationMin'], '...and the calculated-field provenance for that UNCHANGED value must survive the copy, not be wiped just because the step itself is a new user-created row');
  assert.equal(copy.origin, 'user', 'the step itself is still correctly marked as a user copy, never as still coming from a preset');
  // the ORIGINAL is untouched by copying it
  assert.deepEqual(doc.steps.find(s => s.order === 5)!.calculatedFields, ['durationMin']);
});

test('F06: edit the copied step\'s calculated value -> the stamp is removed ONLY from the edited field, exactly like editing the original would', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  doc = { ...doc, steps: duplicateStep(doc.steps, 5) };
  doc = { ...doc, steps: updateStep(doc.steps, 6, { durationMin: 42 }) };
  const editedCopy = doc.steps.find(s => s.order === 6)!;
  assert.equal(editedCopy.durationMin, 42);
  assert.deepEqual(editedCopy.calculatedFields, [], 'the value is now genuinely user-typed, so the stamp must be gone');
});

test('F06: editing an UNRELATED field on the copy never clears the copied calculated-field stamp', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  doc = { ...doc, steps: duplicateStep(doc.steps, 5) };
  doc = { ...doc, steps: updateStep(doc.steps, 6, { temperatureC: 350 }) };
  const copy = doc.steps.find(s => s.order === 6)!;
  assert.deepEqual(copy.calculatedFields, ['durationMin']);
  assert.equal(copy.temperatureC, 350);
});

test('F06 full flow (Codex reproduction): calculate 100 min -> duplicate -> provenance still says calculated -> edit copied duration -> provenance removed only from the edited field -> save/restore -> semantics retained', () => {
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  assert.ok(Math.abs(doc.steps.find(s => s.order === 5)!.durationMin! - 100) < 1e-9);

  doc = { ...doc, steps: duplicateStep(doc.steps, 5) };
  let copy = doc.steps.find(s => s.order === 6)!;
  assert.equal(copy.durationMin, 100);
  assert.deepEqual(copy.calculatedFields, ['durationMin'], 'copy still says calculated/copied-from-calculated');

  doc = { ...doc, steps: updateStep(doc.steps, 6, { durationMin: 77 }) };
  copy = doc.steps.find(s => s.order === 6)!;
  assert.equal(copy.durationMin, 77);
  assert.deepEqual(copy.calculatedFields, [], 'provenance removed only from the edited field');
  // the original (order 6) must be completely unaffected by editing its copy
  assert.deepEqual(doc.steps.find(s => s.order === 5)!.calculatedFields, ['durationMin']);

  const restored = tryRestoreDocument(JSON.stringify(doc));
  assert.ok(restored);
  const restoredOriginal = restored!.steps.find(s => s.order === 5)!;
  const restoredCopy = restored!.steps.find(s => s.order === 6)!;
  assert.deepEqual(restoredOriginal.calculatedFields, ['durationMin'], 'save/restore retains the original\'s calculated provenance');
  assert.deepEqual(restoredCopy.calculatedFields, [], 'save/restore retains the edited copy\'s cleared provenance');
  assert.equal(restoredCopy.durationMin, 77);
});

test('F06: UI/export consistency - buildInstructionView and the export view model read the SAME copied-and-preserved calculated provenance', async () => {
  const { buildDocumentViewModel } = await import('../src/services/workspace/techdoc-export');
  let doc = withName(createDocumentFromPreset('magnetron-pvd'));
  doc = { ...doc, steps: calculateStepDurationFromDeposition(doc.steps, 5, 1000, 'nm', 10, 'nm_per_min') };
  doc = { ...doc, steps: duplicateStep(doc.steps, 5) };
  const copy = doc.steps.find(s => s.order === 6)!;
  assert.deepEqual(copy.calculatedFields, ['durationMin']);
  // Both read the same underlying document - there is no second, independent provenance model.
  const viewModel = buildDocumentViewModel(doc, 'instruction');
  assert.ok(viewModel.traceability.calculatedFieldsNote.includes('№5 (durationMin)'), viewModel.traceability.calculatedFieldsNote);
  assert.ok(viewModel.traceability.calculatedFieldsNote.includes('№6 (durationMin)'), viewModel.traceability.calculatedFieldsNote);
});

