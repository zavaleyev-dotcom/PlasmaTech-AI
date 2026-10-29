import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlankDocument, createDocumentFromPreset, validateDocument, collectStepWarnings,
  addStep, updateStep, duplicateStep, createStep, calculateStepDurationFromDeposition,
  addSource, updateSource, removeSource, addGas, updateGas, removeGas,
  addLayer, updateLayer, removeLayer, moveLayer, setCoatingMode, stepUnits,
  buildInstructionView, buildTechnologicalCard, buildBriefRecipe, buildStepDetails, tryRestoreDocument,
  STEP_TYPES, STEP_TYPE_SPECS, STEP_TYPE_LABELS, SOURCE_KIND_FIELDS, formatSource, formatGas,
  type TechnicalProcessDocument, type ProcessStep,
} from '../src/services/workspace/techdoc-assistant';

const named = (doc: TechnicalProcessDocument): TechnicalProcessDocument => ({ ...doc, general: { ...doc.general, processName: 'Stage4' } });
const step = (doc: TechnicalProcessDocument, order: number) => doc.steps.find(s => s.order === order)!;
const eightCards = (): ProcessStep[] => STEP_TYPES.reduce<ProcessStep[]>((steps, type) => addStep(steps, type), []);
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

// =====================================================================================
// The eight cards and their fields (the agreed structure)
// =====================================================================================

test('there are exactly eight card types, in the agreed order and with the agreed names; "Контроль качества" is not a card any more', () => {
  assert.deepEqual([...STEP_TYPES], ['loading', 'pumpdown', 'heating', 'plasma_ion_cleaning', 'adhesion_underlayer', 'multilayer_coating', 'cooling', 'unloading']);
  assert.deepEqual(STEP_TYPES.map(t => STEP_TYPE_LABELS[t]), ['Загрузка', 'Откачка', 'Нагрев', 'Плазменная/ионная очистка', 'Адгезионный подслой', 'Многослойное покрытие', 'Охлаждение', 'Выгрузка']);
  assert.ok(!(STEP_TYPES as readonly string[]).includes('quality_control'));
});

test('card 1 Загрузка: duration, substrate type and count, fixture/placement, description - nothing else', () => {
  assert.deepEqual([...STEP_TYPE_SPECS.loading.fields], ['durationMin', 'substrateType', 'substrateCount', 'fixture']);
  assert.deepEqual([STEP_TYPE_SPECS.loading.sources, STEP_TYPE_SPECS.loading.gases, STEP_TYPE_SPECS.loading.layers, STEP_TYPE_SPECS.loading.calculator], [false, false, false, false]);
});

test('card 2 Откачка: start and end pressure, duration, OPTIONAL rotation', () => {
  assert.deepEqual([...STEP_TYPE_SPECS.pumpdown.fields], ['pressureStartPa', 'pressureEndPa', 'durationMin', 'rotationRpm']);
  assert.deepEqual([...STEP_TYPE_SPECS.pumpdown.optional], ['rotationRpm']);
});

test('card 3 Нагрев: start/end temperature, duration, start/end pressure, rotation, OPTIONAL heater power', () => {
  assert.deepEqual([...STEP_TYPE_SPECS.heating.fields], ['temperatureStartC', 'temperatureEndC', 'durationMin', 'pressureStartPa', 'pressureEndPa', 'rotationRpm', 'heaterPowerW']);
  assert.deepEqual([...STEP_TYPE_SPECS.heating.optional], ['heaterPowerW']);
});

test('card 4 Плазменная/ионная очистка: duration, temperature, pressure, bias, rotation, OPTIONAL distance; sources AND gas lines; NO thickness calculator', () => {
  const spec = STEP_TYPE_SPECS.plasma_ion_cleaning;
  assert.deepEqual([...spec.fields], ['durationMin', 'temperatureC', 'pressurePa', 'substrateBiasV', 'rotationRpm', 'distanceMm']);
  assert.deepEqual([...spec.optional], ['distanceMm']);
  assert.deepEqual([spec.sources, spec.gases, spec.layers, spec.calculator], [true, true, false, false]);
});

test('card 5 Адгезионный подслой: one underlayer - material, thickness, duration, temperature, pressure, bias, rotation, OPTIONAL distance; sources, gas lines AND the thickness/rate calculator', () => {
  const spec = STEP_TYPE_SPECS.adhesion_underlayer;
  assert.deepEqual([...spec.fields], ['material', 'thicknessNm', 'durationMin', 'temperatureC', 'pressurePa', 'substrateBiasV', 'rotationRpm', 'distanceMm']);
  assert.deepEqual([...spec.optional], ['distanceMm']);
  assert.deepEqual([spec.sources, spec.gases, spec.layers, spec.calculator], [true, true, false, true]);
});

test('card 6 Многослойное покрытие: no fields of its own - layers carry them; sources and gas lines belong to each layer', () => {
  const spec = STEP_TYPE_SPECS.multilayer_coating;
  assert.deepEqual([...spec.fields], []);
  assert.deepEqual([spec.sources, spec.gases, spec.layers], [false, false, true]);
});

test('card 7 Охлаждение: duration, temperature, pressure and GAS LINES (no sources); card 8 Выгрузка: duration and temperature only', () => {
  assert.deepEqual([...STEP_TYPE_SPECS.cooling.fields], ['durationMin', 'temperatureC', 'pressurePa']);
  assert.deepEqual([STEP_TYPE_SPECS.cooling.sources, STEP_TYPE_SPECS.cooling.gases], [false, true]);
  assert.deepEqual([...STEP_TYPE_SPECS.unloading.fields], ['durationMin', 'temperatureC']);
  assert.deepEqual([STEP_TYPE_SPECS.unloading.sources, STEP_TYPE_SPECS.unloading.gases], [false, false]);
});

test('no card has "Критерий приёмки" or "Примечание", nor the old general source/power/current fields and the old general gas list', () => {
  const step = addStep([], 'adhesion_underlayer')[0] as unknown as Record<string, unknown>;
  for (const gone of ['acceptanceCriteria', 'notes', 'sourceConfiguration', 'powerW', 'currentA', 'gasUsage', 'sourceAssignments', 'gasAssignments']) assert.ok(!(gone in step), gone);
  assert.ok('description' in step || step.description === undefined, 'the description stays');
  const details = buildInstructionView(named({ ...createBlankDocument(), steps: eightCards() }));
  for (const gone of ['Критерий приёмки', 'Примечание', 'Газы:', 'Источник/мощность']) assert.ok(!details.includes(gone), gone);
});

test('a stored card keeps only the fields of its type: a payload that carries a field the card does not have has it dropped, never smuggled in', () => {
  const doc = named({ ...createBlankDocument(), steps: addStep([], 'loading') });
  const raw = json(doc);
  raw.steps[0].temperatureC = 300; raw.steps[0].pressurePa = 1; raw.steps[0].sources = [{ id: 'm', kind: 'magnetron', enabled: true, mode: 'parallel' }]; raw.steps[0].acceptanceCriteria = 'x';
  const restored = tryRestoreDocument(JSON.stringify(raw))!;
  const loaded = restored.steps[0];
  assert.equal(loaded.temperatureC, undefined);
  assert.equal(loaded.pressurePa, undefined);
  assert.deepEqual(loaded.sources, []);
  assert.ok(!('acceptanceCriteria' in loaded));
});

test('optional fields are marked "(необязательно)" in the printed card parameter lines; the others are not', () => {
  const doc = named({ ...createBlankDocument(), steps: eightCards() });
  const lines = (order: number) => buildStepDetails(doc, step(doc, order)).parameters.map(p => p.label);
  assert.ok(lines(2).includes('Вращение (необязательно)'));
  assert.ok(lines(3).includes('Мощность нагревателей (необязательно)'));
  assert.ok(lines(4).includes('Расстояние до подложек (необязательно)'));
  assert.ok(lines(3).includes('Вращение') && !lines(3).includes('Вращение (необязательно)'), 'rotation is optional only on the pump-down card');
});

test('every card prints its own parameters in the instruction, with units and "не задано" for what is empty - nothing invented', () => {
  let doc = named({ ...createBlankDocument(), steps: eightCards() });
  doc = { ...doc, steps: updateStep(doc.steps, 1, { durationMin: 15, substrateType: 'Сталь 12Х18Н10Т', substrateCount: 24, fixture: 'Карусель, 3 яруса' }) };
  doc = { ...doc, steps: updateStep(doc.steps, 2, { pressureStartPa: 101325, pressureEndPa: 0.002, durationMin: 30, rotationRpm: 4 }) };
  doc = { ...doc, steps: updateStep(doc.steps, 3, { temperatureStartC: 25, temperatureEndC: 350, durationMin: 45, pressureStartPa: 0.002, pressureEndPa: 0.5, rotationRpm: 3, heaterPowerW: 5000 }) };
  const text = buildInstructionView(doc);
  for (const part of ['Тип подложек: Сталь 12Х18Н10Т', 'Количество подложек: 24 шт.', 'Оснастка / размещение: Карусель, 3 яруса', 'Начальное давление: 101325 Па', 'Конечное давление: 0.002 Па',
    'Вращение (необязательно): 4 об/мин', 'Начальная температура: 25°C', 'Конечная температура: 350°C', 'Мощность нагревателей (необязательно): 5000 Вт']) assert.ok(text.includes(part), part);
  assert.ok(text.includes('Тип подложек: не задано') === false, 'a filled field is not reported as unset');
});

test('card rows: ranges are shown as start → end, the other fields in their columns, optional/extra fields in "Прочие параметры"', () => {
  let doc = named({ ...createBlankDocument(), steps: eightCards() });
  doc = { ...doc, steps: updateStep(doc.steps, 3, { temperatureStartC: 25, temperatureEndC: 350, pressureStartPa: 0.5, rotationRpm: 3, heaterPowerW: 5000 }) };
  doc = { ...doc, steps: updateStep(doc.steps, 1, { substrateCount: 24, fixture: 'Карусель' }) };
  const rows = buildTechnologicalCard(doc);
  const heating = rows.find(r => r.number === 3)!;
  assert.equal(heating.temperature, '25°C → 350°C');
  assert.equal(heating.pressure, '0.5 Па → не задано');
  assert.ok(heating.params.includes('Вращение: 3 об/мин') && heating.params.includes('Мощность нагревателей: 5000 Вт'));
  assert.ok(rows.find(r => r.number === 1)!.params.includes('Количество подложек: 24 шт.') && rows.find(r => r.number === 1)!.params.includes('Оснастка / размещение: Карусель'));
  assert.equal(rows.find(r => r.number === 8)!.pressure, '—', 'a card without a pressure field shows a dash');
});

test('pressures of the cards follow the document display unit (Pa or mbar) without changing the stored value', () => {
  let doc = named({ ...createBlankDocument(), steps: addStep([], 'pumpdown') });
  doc = { ...doc, steps: updateStep(doc.steps, 1, { pressureStartPa: 100, pressureEndPa: 0.5 }) };
  assert.equal(buildTechnologicalCard(doc)[0].pressure, '100 Па → 0.5 Па');
  const mbar = { ...doc, pressureUnit: 'mbar' as const };
  assert.equal(buildTechnologicalCard(mbar)[0].pressure, '1 мбар → 0.005 мбар');
  assert.equal(mbar.steps[0].pressureStartPa, 100);
});

test('a card type is fixed when the card is created: updateStep cannot change it, and a source cannot be added to a card that has none', () => {
  const steps = eightCards();
  assert.throws(() => addSource(steps, { order: 1 }, 'magnetron'), /нет источников/);
  assert.throws(() => addSource(steps, { order: 7 }, 'magnetron'), /нет источников/, 'cooling has gas lines only');
  assert.throws(() => addGas(steps, { order: 8 }), /нет газовых линий/);
  assert.doesNotThrow(() => addGas(steps, { order: 7 }));
  assert.doesNotThrow(() => addSource(steps, { order: 4 }, 'ion'));
  assert.throws(() => addSource(steps, { order: 6 }, 'magnetron'), /нет источников/, 'the coating card has no sources of its own - its layers do');
  assert.throws(() => addLayer(steps, 5), /нет слоёв/);
});

// =====================================================================================
// Sources and gas lines are created inside the card - no registry
// =====================================================================================

test('a source is created in the card with NOTHING filled in: ON, parallel, no material, power or time', () => {
  const steps = addSource(addStep([], 'adhesion_underlayer'), { order: 1 }, 'magnetron');
  assert.deepEqual(steps[0].sources, [{ id: 'magnetron-1', kind: 'magnetron', enabled: true, mode: 'parallel' }]);
  const gas = addGas(steps, { order: 1 });
  assert.deepEqual(gas[0].gases, [{ id: 'gas-1', enabled: true, gas: '' }]);
});

test('nothing has to be registered elsewhere first: a document with no equipment sections can hold sources and gas lines and validates', () => {
  let doc = named({ ...createBlankDocument(), steps: addStep([], 'plasma_ion_cleaning') });
  doc = { ...doc, steps: updateSource(addSource(doc.steps, { order: 1 }, 'ion'), { order: 1 }, 'ion-1', { voltageV: 1500, currentA: 0.2, powerW: 300, startMin: 0, durationMin: 10 }) };
  doc = { ...doc, steps: updateGas(addGas(doc.steps, { order: 1 }), { order: 1 }, 'gas-1', { gas: 'Ar', flowSccm: 60 }) };
  assert.doesNotThrow(() => validateDocument(doc));
  assert.ok(!('sources' in doc) && !('gasSystem' in doc));
});

test('every kind of source carries exactly its own values: magnetron (material, power, operating mode), arc (material, current, filtered), ICP/RF (power, bias), ion (voltage, current, power)', () => {
  assert.deepEqual([...SOURCE_KIND_FIELDS.magnetron], ['material', 'powerW', 'operatingMode']);
  assert.deepEqual([...SOURCE_KIND_FIELDS.arc], ['material', 'currentA', 'filtered']);
  assert.deepEqual([...SOURCE_KIND_FIELDS.icp_rf], ['powerW', 'biasV']);
  assert.deepEqual([...SOURCE_KIND_FIELDS.ion], ['voltageV', 'currentA', 'powerW']);
  let steps = addStep([], 'adhesion_underlayer');
  for (const kind of ['magnetron', 'arc', 'icp_rf', 'ion'] as const) steps = addSource(steps, { order: 1 }, kind);
  assert.deepEqual(steps[0].sources.map(s => s.id), ['magnetron-1', 'arc-1', 'icp-1', 'ion-1']);
  // a value that does not belong to the kind is not stored
  steps = updateSource(steps, { order: 1 }, 'magnetron-1', { material: 'Ti', powerW: 3000, operatingMode: 'DC', currentA: 99, voltageV: 5, biasV: 7, filtered: true });
  assert.deepEqual(json(steps[0].sources[0]), { id: 'magnetron-1', kind: 'magnetron', enabled: true, mode: 'parallel', material: 'Ti', powerW: 3000, operatingMode: 'DC' });
  steps = updateSource(steps, { order: 1 }, 'arc-1', { material: 'TiAl', currentA: 90, filtered: true, powerW: 1 });
  assert.deepEqual(json(steps[0].sources[1]), { id: 'arc-1', kind: 'arc', enabled: true, mode: 'parallel', material: 'TiAl', currentA: 90, filtered: true });
  steps = updateSource(steps, { order: 1 }, 'icp-1', { powerW: 600, biasV: -50, material: 'x' });
  assert.deepEqual(json(steps[0].sources[2]), { id: 'icp-1', kind: 'icp_rf', enabled: true, mode: 'parallel', powerW: 600, biasV: -50 });
  steps = updateSource(steps, { order: 1 }, 'ion-1', { voltageV: 1500, currentA: 0.2, powerW: 300 });
  assert.deepEqual(json(steps[0].sources[3]), { id: 'ion-1', kind: 'ion', enabled: true, mode: 'parallel', voltageV: 1500, currentA: 0.2, powerW: 300 });
});

test('several sources of one kind, and ids that stay unique after removals', () => {
  let steps = addStep([], 'adhesion_underlayer');
  for (let i = 0; i < 3; i++) steps = addSource(steps, { order: 1 }, 'magnetron');
  assert.deepEqual(steps[0].sources.map(s => s.id), ['magnetron-1', 'magnetron-2', 'magnetron-3']);
  steps = removeSource(steps, { order: 1 }, 'magnetron-2');
  steps = addSource(steps, { order: 1 }, 'magnetron');
  assert.deepEqual(steps[0].sources.map(s => s.id), ['magnetron-1', 'magnetron-3', 'magnetron-4'], 'a removed id is not reused while a higher one exists');
  steps = addGas(addGas(steps, { order: 1 }), { order: 1 });
  steps = removeGas(steps, { order: 1 }, 'gas-1');
  assert.deepEqual(addGas(steps, { order: 1 })[0].gases.map(g => g.id), ['gas-2', 'gas-3']);
});

test('INDEPENDENCE: the sources and gas lines of two cards never affect each other, even with the same ids and the same materials', () => {
  let steps = addStep(addStep([], 'plasma_ion_cleaning'), 'adhesion_underlayer');
  for (const order of [1, 2]) {
    steps = updateSource(addSource(steps, { order }, 'magnetron'), { order }, 'magnetron-1', { material: 'Ti', powerW: 1000 });
    steps = updateGas(addGas(steps, { order }), { order }, 'gas-1', { gas: 'Ar', flowSccm: 10 });
  }
  steps = updateSource(steps, { order: 2 }, 'magnetron-1', { powerW: 3000, material: 'Cr' });
  steps = updateGas(steps, { order: 2 }, 'gas-1', { flowSccm: 99, enabled: false });
  assert.deepEqual([steps[0].sources[0].material, steps[0].sources[0].powerW, steps[0].gases[0].flowSccm, steps[0].gases[0].enabled], ['Ti', 1000, 10, true], 'card 1 is untouched');
  assert.deepEqual([steps[1].sources[0].material, steps[1].sources[0].powerW, steps[1].gases[0].flowSccm, steps[1].gases[0].enabled], ['Cr', 3000, 99, false]);
  steps = removeSource(steps, { order: 1 }, 'magnetron-1');
  assert.equal(steps[1].sources.length, 1, 'removing a source of one card leaves the other card alone');
});

test('INDEPENDENCE: a copied card owns its own sources, gas lines and layers - editing the copy never changes the original', () => {
  let steps = addStep(addStep([], 'adhesion_underlayer'), 'multilayer_coating');
  steps = updateSource(addSource(steps, { order: 1 }, 'magnetron'), { order: 1 }, 'magnetron-1', { material: 'Ti', powerW: 1000 });
  steps = addLayer(steps, 2);
  steps = updateSource(addSource(steps, { order: 2, layerId: 'layer-1' }, 'arc'), { order: 2, layerId: 'layer-1' }, 'arc-1', { material: 'Cr', currentA: 80 });
  const copied = duplicateStep(duplicateStep(steps, 1), 3);
  assert.equal(copied.length, 4);
  let edited = updateSource(copied, { order: 2 }, 'magnetron-1', { powerW: 5 });
  edited = updateSource(edited, { order: 4, layerId: 'layer-1' }, 'arc-1', { currentA: 5 });
  assert.equal(edited[0].sources[0].powerW, 1000);
  assert.equal(edited[1].sources[0].powerW, 5);
  assert.equal(edited[2].layers[0].sources[0].currentA, 80);
  assert.equal(edited[3].layers[0].sources[0].currentA, 5);
  assert.notEqual(copied[2].id, copied[3].id, 'a copy gets its own card id');
});

// =====================================================================================
// Coating layers: one-layer mode and multilayer
// =====================================================================================

test('a coating card starts multilayer with no layers; layers are added, edited, moved and removed; each owns its fields, sources and gas lines', () => {
  let steps = addStep([], 'multilayer_coating');
  assert.equal(steps[0].coatingMode, 'multi');
  assert.deepEqual(steps[0].layers, []);
  steps = addLayer(addLayer(addLayer(steps, 1), 1), 1);
  assert.deepEqual(steps[0].layers.map(l => l.id), ['layer-1', 'layer-2', 'layer-3']);
  steps = updateLayer(steps, 1, 'layer-1', { material: 'Ti', thicknessNm: 100, durationMin: 10, temperatureC: 400, pressurePa: 0.5, substrateBiasV: -100, rotationRpm: 4, distanceMm: 120 });
  steps = updateLayer(steps, 1, 'layer-2', { material: 'TiN', thicknessNm: 2000 });
  const layerRef = { order: 1, layerId: 'layer-1' };
  steps = updateSource(addSource(steps, layerRef, 'magnetron'), layerRef, 'magnetron-1', { material: 'Ti', powerW: 3000 });
  steps = updateGas(addGas(steps, layerRef), layerRef, 'gas-1', { gas: 'Ar', flowSccm: 40 });
  assert.equal(steps[0].layers[1].sources.length, 0, 'layer 2 has none of layer 1\'s sources');
  assert.equal(steps[0].layers[2].gases.length, 0);
  steps = moveLayer(steps, 1, 'layer-3', 'up');
  assert.deepEqual(steps[0].layers.map(l => l.id), ['layer-1', 'layer-3', 'layer-2']);
  steps = removeLayer(steps, 1, 'layer-3');
  assert.deepEqual(steps[0].layers.map(l => l.id), ['layer-1', 'layer-2']);
  assert.equal(addLayer(steps, 1)[0].layers[2].id, 'layer-3', 'ids are derived from the existing layers');
  assert.throws(() => updateLayer(steps, 1, 'layer-9', { material: 'x' }), /не найден/);
});

test('single-layer mode: exactly one layer; a second one is refused; switching to it never drops a layer silently', () => {
  let steps = addStep([], 'multilayer_coating');
  steps = setCoatingMode(steps, 1, 'single');
  assert.equal(steps[0].coatingMode, 'single');
  assert.equal(steps[0].layers.length, 1, 'an empty layer is created');
  assert.throws(() => addLayer(steps, 1), /только один слой/);
  steps = setCoatingMode(steps, 1, 'multi');
  steps = addLayer(steps, 1);
  assert.equal(steps[0].layers.length, 2);
  assert.throws(() => setCoatingMode(steps, 1, 'single'), /нельзя/, 'two layers cannot become "single" silently');
  assert.equal(steps[0].layers.length, 2);
  steps = removeLayer(steps, 1, 'layer-2');
  assert.equal(setCoatingMode(steps, 1, 'single')[0].layers.length, 1);
});

test('presets: magnetron and FCVA presets build the coating card in single-layer mode with one empty layer; the hybrid preset stays multilayer', () => {
  for (const id of ['magnetron-pvd', 'vacuum-arc-fcva', 'pecvd']) {
    const coating = createDocumentFromPreset(id).steps.find(s => s.type === 'multilayer_coating')!;
    assert.equal(coating.coatingMode, 'single', id);
    assert.equal(coating.layers.length, 1, id);
  }
  const hybrid = createDocumentFromPreset('hybrid-magnetron-arc').steps.find(s => s.type === 'multilayer_coating')!;
  assert.equal(hybrid.coatingMode, 'multi');
  assert.equal(hybrid.layers.length, 0);
});

test('the layers of the coating card appear in the instruction, the card (own rows) and the recipe - with the sources and gas lines of EACH layer', () => {
  let doc = named({ ...createBlankDocument(), steps: addStep([], 'multilayer_coating') });
  doc = { ...doc, steps: addLayer(addLayer(doc.steps, 1), 1) };
  doc = { ...doc, steps: updateLayer(doc.steps, 1, 'layer-1', { material: 'Ti', thicknessNm: 100, durationMin: 10, temperatureC: 400, pressurePa: 0.5 }) };
  doc = { ...doc, steps: updateLayer(doc.steps, 1, 'layer-2', { material: 'TiN', thicknessNm: 2000, durationMin: 60, temperatureC: 420 }) };
  doc = { ...doc, steps: updateSource(addSource(doc.steps, { order: 1, layerId: 'layer-1' }, 'magnetron'), { order: 1, layerId: 'layer-1' }, 'magnetron-1', { material: 'Ti', powerW: 3000, startMin: 0, durationMin: 10 }) };
  doc = { ...doc, steps: updateSource(addSource(doc.steps, { order: 1, layerId: 'layer-2' }, 'arc'), { order: 1, layerId: 'layer-2' }, 'arc-1', { material: 'TiAl', currentA: 90, startMin: 0, durationMin: 60 }) };
  doc = { ...doc, steps: updateGas(addGas(doc.steps, { order: 1, layerId: 'layer-2' }), { order: 1, layerId: 'layer-2' }, 'gas-1', { gas: 'N2', flowSccm: 15 }) };
  const instruction = buildInstructionView(doc);
  for (const part of ['- Слой 1:', '  - Материал: Ti', '  - Толщина: 100 нм', '- Слой 2:', '  - Материал: TiN', '  - Толщина: 2000 нм', 'Магнетрон magnetron-1 (мишень: Ti): ВКЛ, мощность — 3000 Вт', 'Вакуумно-дуговой источник arc-1 (катод: TiAl)', 'Линия gas-1 (газ: N2): ВКЛ, расход — 15 sccm']) {
    assert.ok(instruction.includes(part), part);
  }
  const row = buildTechnologicalCard(doc)[0];
  assert.equal(row.operation, 'Многослойное покрытие');
  assert.equal(row.params, 'многослойное, слоёв: 2');
  assert.deepEqual(row.layers.map(l => [l.layer, l.material, l.thickness, l.duration, l.temperature]), [[1, 'Ti', '100 нм', '10 мин', '400°C'], [2, 'TiN', '2000 нм', '60 мин', '420°C']]);
  assert.ok(row.layers[0].sources.includes('мишень: Ti') && !row.layers[0].sources.includes('TiAl'), 'layer 1 shows only its own source');
  assert.ok(row.layers[1].gases.includes('газ: N2') && row.layers[0].gases === '—');
  const recipe = buildBriefRecipe(doc);
  assert.ok(recipe.includes('многослойное, слоёв: 2') && recipe.includes('слой 1: T: 400°C, P: 0.5 Па, t: 10 мин') && recipe.includes('слой 2: T: 420°C, t: 60 мин'));
});

// =====================================================================================
// Validation and remarks, per card and per layer
// =====================================================================================

test('validation of card and layer fields: negative thickness/rotation/duration, impossible temperature, NaN, a fractional substrate count', () => {
  let doc = named({ ...createBlankDocument(), steps: addStep(addStep([], 'loading'), 'multilayer_coating') });
  doc = { ...doc, steps: addLayer(doc.steps, 2) };
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { substrateCount: 2.5 }) }), /целое/);
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { substrateCount: -1 }) }), /количество подложек/);
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { substrateCount: 0 }) }), 'zero is a value');
  assert.throws(() => validateDocument({ ...doc, steps: updateLayer(doc.steps, 2, 'layer-1', { thicknessNm: -5 }) }), /слой 1: толщина/);
  assert.throws(() => validateDocument({ ...doc, steps: updateLayer(doc.steps, 2, 'layer-1', { temperatureC: -300 }) }), /абсолютного нуля/);
  assert.throws(() => validateDocument({ ...doc, steps: updateLayer(doc.steps, 2, 'layer-1', { rotationRpm: Number.NaN }) }), /вращение/);
  assert.doesNotThrow(() => validateDocument({ ...doc, steps: updateLayer(doc.steps, 2, 'layer-1', { substrateBiasV: -80, thicknessNm: 0 }) }), 'a negative bias is the normal sign');
  assert.throws(() => validateDocument({ ...doc, steps: updateStep(doc.steps, 1, { description: undefined, durationMin: Number.POSITIVE_INFINITY }) }), /продолжительность/);
});

test('times of a source or gas line are checked against ITS card or layer: inside the interval, not negative, finite', () => {
  let steps = updateStep(addStep([], 'adhesion_underlayer'), 1, { durationMin: 30 });
  steps = addSource(steps, { order: 1 }, 'magnetron');
  const ok = { ...named(createBlankDocument()), steps };
  assert.doesNotThrow(() => validateDocument({ ...ok, steps: updateSource(steps, { order: 1 }, 'magnetron-1', { startMin: 0, durationMin: 30 }) }));
  assert.throws(() => validateDocument({ ...ok, steps: updateSource(steps, { order: 1 }, 'magnetron-1', { startMin: 5, durationMin: 30 }) }), /выходит за пределы/);
  assert.throws(() => validateDocument({ ...ok, steps: updateSource(steps, { order: 1 }, 'magnetron-1', { startMin: -1 }) }), /начало/);
  assert.throws(() => validateDocument({ ...ok, steps: updateSource(steps, { order: 1 }, 'magnetron-1', { startMin: 1e308, durationMin: 1e308 }) }), /не является конечным/);
  // the same source switched OFF is not range-checked: it does not run
  assert.doesNotThrow(() => validateDocument({ ...ok, steps: updateSource(steps, { order: 1 }, 'magnetron-1', { startMin: 5, durationMin: 99, enabled: false }) }));
});

test('"sequential" is checked inside one card or layer only: the same intervals in two different layers do not collide, inside one layer they do; touching is allowed; 0 min is no work', () => {
  let steps = addLayer(addLayer(addStep([], 'multilayer_coating'), 1), 1);
  steps = updateLayer(updateLayer(steps, 1, 'layer-1', { durationMin: 20 }), 1, 'layer-2', { durationMin: 20 });
  const seq = (layerId: string, id: string, start: number, duration: number) => { steps = updateSource(steps, { order: 1, layerId }, id, { mode: 'sequential', startMin: start, durationMin: duration }); };
  for (const layerId of ['layer-1', 'layer-2']) { steps = addSource(addSource(steps, { order: 1, layerId }, 'magnetron'), { order: 1, layerId }, 'arc'); }
  seq('layer-1', 'magnetron-1', 0, 10); seq('layer-2', 'magnetron-1', 0, 10); seq('layer-1', 'arc-1', 10, 10); seq('layer-2', 'arc-1', 10, 10);
  const doc = { ...named(createBlankDocument()), steps };
  assert.doesNotThrow(() => validateDocument(doc), 'touching at 10 min is allowed, and layer 2 does not collide with layer 1');
  seq('layer-2', 'arc-1', 5, 10);
  assert.throws(() => validateDocument({ ...doc, steps }), /Этап №1, слой 2: .* работает последовательно/);
  seq('layer-2', 'arc-1', 5, 0);
  assert.doesNotThrow(() => validateDocument({ ...doc, steps }), 'an interval of 0 min overlaps nothing');
});

test('remarks per card and layer: unknown timing, missing duration, 0 min, no gas name, a coating card without layers; none of the old "general vs assigned" conflicts', () => {
  let doc = named({ ...createBlankDocument(), steps: addStep(addStep([], 'adhesion_underlayer'), 'multilayer_coating') });
  doc = { ...doc, steps: updateSource(addSource(doc.steps, { order: 1 }, 'magnetron'), { order: 1 }, 'magnetron-1', { startMin: 0, durationMin: 0 }) };
  doc = { ...doc, steps: addGas(doc.steps, { order: 1 }) };
  doc = { ...doc, steps: addLayer(doc.steps, 2) };
  doc = { ...doc, steps: updateGas(addGas(doc.steps, { order: 2, layerId: 'layer-1' }), { order: 2, layerId: 'layer-1' }, 'gas-1', { gas: 'Ar', startMin: 0, durationMin: 5 }) };
  const warnings = collectStepWarnings(doc);
  assert.ok(warnings.some(w => w.startsWith('Этап №1:') && w.includes('не задана длительность этапа')));
  assert.ok(warnings.some(w => w.includes('длительность 0 мин - фактически он не работает')));
  assert.ok(warnings.some(w => w.startsWith('Этап №1:') && w.includes('не указан газ')));
  assert.ok(warnings.some(w => w.startsWith('Этап №2:') && w.includes('слой 1: не задана длительность слоя')));
  assert.ok(!warnings.some(w => w.includes('общие значения этапа')));
  assert.deepEqual(collectStepWarnings(named({ ...createBlankDocument(), steps: addStep([], 'multilayer_coating') })), ['Этап №1: не задано ни одного слоя покрытия.']);
});

test('formatting: an OFF source/gas line says OFF, an unset value says unset, nothing is invented', () => {
  const steps = addGas(addSource(addStep([], 'adhesion_underlayer'), { order: 1 }, 'magnetron'), { order: 1 });
  assert.equal(formatSource(steps[0].sources[0]), 'Магнетрон magnetron-1 (мишень: материал не задан): ВКЛ, мощность — не задана, время — не задано, режим — одновременно');
  assert.equal(formatGas(steps[0].gases[0]), 'Линия gas-1 (газ: газ не указан): ВКЛ, расход — не задан, подача — не задано');
  assert.equal(formatSource({ ...steps[0].sources[0], enabled: false }), 'Магнетрон magnetron-1 (мишень: материал не задан): ОТКЛ');
});

test('the thickness/rate calculator only fills the duration of the card it is called for, and stays an explicit action (the editor offers it on the adhesion card only)', () => {
  const steps = addStep(addStep([], 'plasma_ion_cleaning'), 'adhesion_underlayer');
  const calc = calculateStepDurationFromDeposition(steps, 2, 1000, 'nm', 10, 'nm_per_min');
  assert.ok(Math.abs(calc[1].durationMin! - 100) < 1e-9);
  assert.equal(calc[0].durationMin, undefined);
  assert.deepEqual(STEP_TYPES.filter(t => STEP_TYPE_SPECS[t].calculator), ['adhesion_underlayer']);
});

test('stepUnits: a card without layers is one unit, a coating card has one unit per layer', () => {
  let steps = addStep(addStep([], 'adhesion_underlayer'), 'multilayer_coating');
  assert.deepEqual(stepUnits(steps[0]).map(u => u.label), ['Этап №1']);
  assert.deepEqual(stepUnits(steps[1]), []);
  steps = addLayer(addLayer(steps, 2), 2);
  assert.deepEqual(stepUnits(steps[1]).map(u => u.label), ['Этап №2, слой 1', 'Этап №2, слой 2']);
  assert.deepEqual(stepUnits(steps[1]).map(u => u.ref.layerId), ['layer-1', 'layer-2']);
});

test('createStep produces a card with the requested type and no equipment, no layers', () => {
  const card = createStep('cooling', undefined, 'user', 'step-9');
  assert.deepEqual([card.id, card.type, card.name, card.sources, card.gases, card.layers, card.enabled], ['step-9', 'cooling', 'Охлаждение', [], [], [], true]);
});
