import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchEquipment, compareConfigurations, buildTechnoEconomicHandoff, validateRequirement,
  computeBreakdown, computeOverallScore, EQUIPMENT_CONFIGURATIONS, REQUIREMENT_PRESETS,
  type EquipmentRequirement,
} from '../src/services/workspace/equipment-selector';

function baseRequirement(overrides: Partial<EquipmentRequirement> = {}): EquipmentRequirement {
  return {
    purpose: 'deposition', technology: 'magnetron_pvd', substrateType: 'wafer', maxSizeMm: 100,
    materialClass: 'metals', maxProcessTempC: 300, pressureRange: { minMbar: 1e-3, maxMbar: 1e-2 },
    sources: { magnetronCount: 1, arcSourceCount: 0, icpRf: false, substrateBias: true, ionSource: false, combinedModeRequired: false },
    gasSystem: { gasLines: 2, processGases: ['Ar'], mfcRequired: true },
    throughputClass: 'rnd', automation: 'manual', cleanroom: 'not_required',
    ...overrides,
  };
}

// ---------- exact match ----------

test('matchEquipment: an exact-fit requirement scores 100% and is classified "recommended" with no required modifications', () => {
  const req = baseRequirement();
  const results = matchEquipment(req);
  const research = results.find(r => r.config.id === 'research-magnetron-pvd')!;
  assert.equal(research.status, 'recommended');
  assert.equal(research.overallScore, 100);
  assert.deepEqual(research.requiredModifications, []);
  assert.ok(research.whyItFits.length === 8);
});

// ---------- hard rejections ----------

test('matchEquipment (hard filter): substrate/part size exceeding chamber capacity excludes the configuration outright, with a stated reason', () => {
  const req = baseRequirement({ maxSizeMm: 1000 });
  const results = matchEquipment(req);
  const research = results.find(r => r.config.id === 'research-magnetron-pvd')!;
  assert.equal(research.status, 'not_suitable');
  assert.equal(research.overallScore, null);
  assert.ok(research.exclusionReasons.some(r => r.includes('превышает максимальный размер камеры')));
});

test('matchEquipment (hard filter): requiring ICP/RF excludes configurations that do not have it', () => {
  const req = baseRequirement({ purpose: 'etching', technology: 'icp_rf_plasma', sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeRequired: false } });
  const results = matchEquipment(req);
  const research = results.find(r => r.config.id === 'research-magnetron-pvd')!;
  assert.equal(research.status, 'not_suitable');
  assert.ok(research.exclusionReasons.some(r => r.includes('ICP/RF')));
});

test('matchEquipment (hard filter): requiring more gas lines than a configuration supports excludes it', () => {
  const req = baseRequirement({ gasSystem: { gasLines: 10, processGases: ['Ar'], mfcRequired: true } });
  const results = matchEquipment(req);
  const cleaning = results.find(r => r.config.id === 'plasma-cleaning-system')!;
  assert.equal(cleaning.status, 'not_suitable');
  assert.ok(cleaning.exclusionReasons.some(r => r.includes('газовых линий')));
});

test('matchEquipment (hard filter): a required process temperature above a configuration\'s maximum excludes it', () => {
  const req = baseRequirement({ maxProcessTempC: 1000 });
  const results = matchEquipment(req);
  const research = results.find(r => r.config.id === 'research-magnetron-pvd')!;
  assert.equal(research.status, 'not_suitable');
  assert.ok(research.exclusionReasons.some(r => r.includes('температур')));
});

test('matchEquipment (hard filter): an unsupported cleanroom class excludes the configuration', () => {
  const req = baseRequirement({ purpose: 'etching', technology: 'icp_rf_plasma', cleanroom: 'iso6', sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeRequired: false } });
  const results = matchEquipment(req);
  const cleaning = results.find(r => r.config.id === 'plasma-cleaning-system')!;
  assert.equal(cleaning.status, 'not_suitable');
  assert.ok(cleaning.exclusionReasons.some(r => r.includes('чистого помещения')));
});

// ---------- weighted scoring ----------

test('computeBreakdown / computeOverallScore: matches the documented, testable formula exactly', () => {
  const req = baseRequirement({ automation: 'semi_automatic', throughputClass: 'small_batch' });
  const config = EQUIPMENT_CONFIGURATIONS.find(c => c.id === 'multi-cathode-pvd')!;
  const breakdown = computeBreakdown(req, config);
  // process: purpose(deposition ok) + technology(magnetron_pvd ok) + material(metals ok) = 3/3 -> 100
  assert.equal(breakdown.process, 100);
  // substrate: wafer supported -> 100
  assert.equal(breakdown.substrate, 100);
  // automation: semi_automatic supported -> 100; throughput: small_batch supported -> 100
  assert.equal(breakdown.automation, 100);
  assert.equal(breakdown.throughput, 100);
  const overall = computeOverallScore(breakdown);
  const manual = (breakdown.process * 20 + breakdown.substrate * 15 + breakdown.sources * 15 + breakdown.gas * 10
    + breakdown.temperature * 10 + breakdown.automation * 10 + breakdown.throughput * 10 + breakdown.cleanroom * 10) / 100;
  assert.ok(Math.abs(overall - manual) < 1e-9);
});

test('computeBreakdown: gas score blends MFC availability with spare gas-line capacity, exactly as documented', () => {
  const req = baseRequirement({ gasSystem: { gasLines: 4, processGases: ['Ar'], mfcRequired: true } });
  const config = EQUIPMENT_CONFIGURATIONS.find(c => c.id === 'icp-rie-etcher')!;
  const breakdown = computeBreakdown({ ...req, purpose: 'etching', technology: 'icp_rf_plasma', substrateType: 'wafer', sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeRequired: false } }, config);
  // mfcOk(100)*0.5 + min(100, 8/4*100=200->100)*0.5 = 100
  assert.equal(breakdown.gas, 100);
});

// ---------- deterministic ordering ----------

test('matchEquipment: ordering is deterministic and reproducible across repeated calls with the same input', () => {
  const req = baseRequirement();
  const first = matchEquipment(req);
  const second = matchEquipment(baseRequirement());
  assert.deepEqual(first.map(r => r.config.id), second.map(r => r.config.id));
  assert.deepEqual(first.map(r => r.overallScore), second.map(r => r.overallScore));
  // recommended results must precede suitable-with-modifications, which must precede not_suitable
  const statusOrder = first.map(r => r.status);
  const rank = { recommended: 0, suitable_with_modifications: 1, not_suitable: 2 } as const;
  for (let i = 1; i < statusOrder.length; i++) assert.ok(rank[statusOrder[i]] >= rank[statusOrder[i - 1]]);
});

// ---------- comparison ----------

test('compareConfigurations: builds a parameter table for 2-3 configurations, and rejects an out-of-range count', () => {
  const rows = compareConfigurations(['research-magnetron-pvd', 'multi-cathode-pvd', 'filtered-vacuum-arc']);
  assert.equal(rows.length, 8);
  for (const row of rows) assert.equal(row.values.length, 3);
  assert.ok(rows.some(r => r.parameter === 'Газовые линии (макс.)'));
  assert.throws(() => compareConfigurations(['research-magnetron-pvd']), /от 2 до 3/);
  assert.throws(() => compareConfigurations(['a', 'b', 'c', 'd']), /от 2 до 3/);
  assert.throws(() => compareConfigurations(['research-magnetron-pvd', 'does-not-exist']), /не найдена/);
});

// ---------- presets ----------

test('presets: every preset is a valid requirement and yields at least one usable (non-excluded) configuration', () => {
  assert.equal(REQUIREMENT_PRESETS.length, 5);
  for (const preset of REQUIREMENT_PRESETS) {
    assert.doesNotThrow(() => validateRequirement(preset.requirement), `preset ${preset.id} should be valid`);
    const results = matchEquipment(preset.requirement);
    assert.equal(results.length, EQUIPMENT_CONFIGURATIONS.length);
    assert.ok(results.some(r => r.status !== 'not_suitable'), `preset ${preset.id} should have at least one viable configuration`);
  }
});

// ---------- invalid input ----------

test('validateRequirement: rejects missing/invalid purpose, negative gas lines, NaN/Infinity, and inverted pressure range', () => {
  assert.throws(() => validateRequirement(baseRequirement({ purpose: 'unknown' as never })), /Назначение/);
  assert.throws(() => validateRequirement(baseRequirement({ gasSystem: { gasLines: -1, processGases: [], mfcRequired: false } })), /отрицательным/);
  assert.throws(() => validateRequirement(baseRequirement({ maxSizeMm: NaN })), /конечное число/);
  assert.throws(() => validateRequirement(baseRequirement({ maxProcessTempC: Infinity })), /разумного диапазона|конечное число/);
  assert.throws(() => validateRequirement(baseRequirement({ pressureRange: { minMbar: 1e-2, maxMbar: 1e-3 } })), /больше минимального/);
  assert.throws(() => validateRequirement(baseRequirement({ maxSizeMm: 0 })), /больше 0/);
  assert.throws(() => validateRequirement(baseRequirement({ sources: { magnetronCount: 1.5, arcSourceCount: 0, icpRf: false, substrateBias: true, ionSource: false, combinedModeRequired: false } })), /целое число/);
});

test('validateRequirement: rejects incompatible purpose/technology combinations', () => {
  assert.throws(() => validateRequirement(baseRequirement({ purpose: 'etching', technology: 'magnetron_pvd' })), /Несовместимая комбинация/);
  assert.throws(() => validateRequirement(baseRequirement({ purpose: 'plasma_cleaning', technology: 'vacuum_arc_fcva' })), /Несовместимая комбинация/);
  assert.throws(() => validateRequirement(baseRequirement({ purpose: 'deposition', technology: 'icp_rf_plasma' })), /Несовместимая комбинация/);
});

// ---------- free text must never influence scoring ----------

test('specialRequirements (free text) is never read by the matching engine - identical requirements differing only in free text produce identical results', () => {
  const withoutText = matchEquipment(baseRequirement());
  const withText = matchEquipment(baseRequirement({ specialRequirements: 'Нужна дополнительная документация на русском языке, желательно с расширенной гарантией.' }));
  assert.deepEqual(withoutText, withText);
});

// ---------- handoff to Techno-Economic Assessment ----------

test('buildTechnoEconomicHandoff: carries only technical parameters, never an invented cost figure', () => {
  const config = EQUIPMENT_CONFIGURATIONS.find(c => c.id === 'pecvd-system')!;
  const handoff = buildTechnoEconomicHandoff(config);
  assert.equal(handoff.configurationId, 'pecvd-system');
  assert.equal(handoff.configurationName, 'PECVD System');
  assert.equal(handoff.maxChamberSizeMm, 200);
  assert.equal(handoff.maxProcessTempC, 350);
  const keys = Object.keys(handoff).join(' ').toLowerCase();
  assert.ok(!keys.includes('capex') && !keys.includes('opex') && !keys.includes('cost') && !keys.includes('price'));
  assert.ok(handoff.note.includes('вручную'));
});
