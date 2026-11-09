import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildComparisonSnapshot, currentComparison } from '../src/services/workspace/equipment-selector';
import {
  solveDeposition, formatSignificant, depositionInputKey, meanFreePathInputKey, calculateMeanFreePath,
} from '../src/services/workspace/engineering-calculators';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// ---------- F1: comparison headers and rows always describe the same selection ----------
test('F1: swapping a compared configuration makes the old comparison stale; a new one pairs 300/250 mm with the right headers', () => {
  const first = buildComparisonSnapshot(['research-magnetron-pvd', 'multi-cathode-pvd']);
  assert.deepEqual(first.names, ['Research Magnetron PVD', 'Multi-Cathode PVD']);
  const sizeRow = (s: typeof first) => s.rows.find(r => r.parameter === 'Максимальный размер изделия')!.values;
  assert.deepEqual(sizeRow(first), ['150 мм', '300 мм']);
  const selection = ['multi-cathode-pvd', 'filtered-vacuum-arc'];
  assert.equal(currentComparison(first, selection), null, 'old rows must not be shown under the new selection');
  assert.equal(currentComparison(first, ['multi-cathode-pvd']), null);
  const second = buildComparisonSnapshot(selection);
  assert.deepEqual(second.names, ['Multi-Cathode PVD', 'Filtered Vacuum Arc / FCVA']);
  assert.deepEqual(sizeRow(second), ['300 мм', '250 мм']);
  assert.equal(currentComparison(second, selection), second);
});

test('F1: adding and removing a third variant invalidates, then the same selection matches again', () => {
  const pair = ['multi-cathode-pvd', 'filtered-vacuum-arc'];
  const snap = buildComparisonSnapshot(pair);
  assert.equal(currentComparison(snap, [...pair, 'pecvd-system']), null);
  assert.equal(currentComparison(snap, pair), snap);
  const triple = buildComparisonSnapshot([...pair, 'pecvd-system']);
  assert.equal(triple.names.length, 3);
  assert.ok(triple.rows.every(r => r.values.length === 3));
  assert.equal(currentComparison(triple, pair), null);
  assert.equal(currentComparison(snap, [...pair].reverse()), null, 'order change = different header order');
});

test('F1: the component renders headers from the snapshot, not from the live selection', () => {
  const src = read('src/components/equipment-selector.tsx');
  assert.ok(!/comparisonRows/.test(src));
  assert.match(src, /shownComparison\.names\.map/);
  assert.ok(!/<thead>.*compareNames/.test(src));
});

// ---------- F2: stale results ----------
test('F2: a deposition result is tied to its inputs - changing thickness invalidates 100 min, recompute gives 200 min', () => {
  const base = { solveFor: 'time', thickness: '1000', thicknessUnit: 'nm', rate: '10', rateUnit: 'nm_per_min', time: '', timeUnit: 'min' };
  const key1 = depositionInputKey(base);
  const r1 = solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' });
  assert.equal(r1.value, 100);
  assert.notEqual(key1, depositionInputKey({ ...base, thickness: '2000' }));
  assert.notEqual(key1, depositionInputKey({ ...base, rateUnit: 'nm_per_s' }));
  assert.notEqual(key1, depositionInputKey({ ...base, solveFor: 'rate' }));
  assert.equal(solveDeposition({ solveFor: 'time', thickness: 2000, thicknessUnit: 'nm', rate: 10, rateUnit: 'nm_per_min', timeUnit: 'min' }).value, 200);
});

test('F2: mean-free-path key reacts to every input; the custom diameter only matters for a custom gas', () => {
  const b = { pressure: '1', pressureUnit: 'pa', temperatureC: '20', gas: 'argon', customDiameterPm: '350' };
  const k = meanFreePathInputKey(b);
  for (const change of [{ pressure: '2' }, { pressureUnit: 'mbar' }, { temperatureC: '30' }, { gas: 'nitrogen' }]) assert.notEqual(k, meanFreePathInputKey({ ...b, ...change }));
  assert.equal(k, meanFreePathInputKey({ ...b, customDiameterPm: '999' }));
  assert.notEqual(meanFreePathInputKey({ ...b, gas: 'custom' }), meanFreePathInputKey({ ...b, gas: 'custom', customDiameterPm: '999' }));
});

test('F2: components only show a result whose key equals the current inputs; Equipment Selector handoff stays wired', () => {
  const calc = read('src/components/engineering-calculators.tsx');
  assert.equal((calc.match(/resultState\.key === key/g) ?? []).length, 2);
  const sel = read('src/components/equipment-selector.tsx');
  assert.match(sel, /resultsState\.key === formKey/);
  assert.match(sel, /queueEquipmentHandoff\(built\)/);
});

// ---------- F3: scientific formatting ----------
test('F3: formatSignificant never renders a non-zero value as zero', () => {
  assert.equal(formatSignificant(0.00001), '1e-5');
  assert.equal(formatSignificant(1e8), '1e8');
  assert.equal(formatSignificant(100), '100');
  assert.equal(formatSignificant(0.5), '0.5');
  for (const v of [1e-300, 4.2e-9, 0.0004321, 7e12]) assert.notEqual(Number(formatSignificant(v)), 0);
  assert.equal(formatSignificant(0), '0');
});

test('F3: 1000 nm at 0.00001 nm/min -> 1e8 min, rate stays non-zero in the formula (all three solve modes and unit conversions)', () => {
  const t = solveDeposition({ solveFor: 'time', thickness: 1000, thicknessUnit: 'nm', rate: 0.00001, rateUnit: 'nm_per_min', timeUnit: 'min' });
  assert.ok(Math.abs(t.value - 1e8) < 1e-3);
  assert.ok(!t.formula.includes('0.0000'), t.formula);
  assert.match(t.formula, /1e-5 нм\/мин/);
  const d = solveDeposition({ solveFor: 'thickness', rate: 0.00001, rateUnit: 'nm_per_min', time: 1e8, timeUnit: 'min', thicknessUnit: 'nm' });
  assert.ok(Math.abs(d.value - 1000) < 1e-6);
  assert.match(d.formula, /1e-5 нм\/мин × 1e8 мин/);
  const r = solveDeposition({ solveFor: 'rate', thickness: 1000, thicknessUnit: 'nm', time: 1e8, timeUnit: 'min', rateUnit: 'nm_per_min' });
  assert.ok(Math.abs(r.value - 1e-5) < 1e-15);
  assert.match(r.formula, /1000 нм \/ 1e8 мин/);
  const conv = solveDeposition({ solveFor: 'time', thickness: 1, thicknessUnit: 'um', rate: 1e-7, rateUnit: 'um_per_h', timeUnit: 'h' });
  assert.ok(!/ 0(\.0+)? нм\/мин/.test(conv.formula), conv.formula);
  assert.equal(conv.unit, 'h');
  const sec = solveDeposition({ solveFor: 'thickness', rate: 1e-6, rateUnit: 'nm_per_s', time: 3600, timeUnit: 's', thicknessUnit: 'um' });
  assert.ok(Math.abs(sec.value - 3.6e-6) < 1e-15);
  assert.ok(!sec.formula.includes('0.0000'), sec.formula);
});

test('F3: mean free path formula keeps its units and temperature', () => {
  const m = calculateMeanFreePath({ pressure: 1e-9, pressureUnit: 'mbar', temperatureC: 20, gas: 'argon' });
  assert.match(m.formula, /293\.15 К/);
});

// ---------- F4: Workspace label ----------
test('F4: the Workspace page no longer claims that all results are pre-prepared / the whole workspace is a demo', () => {
  const page = read('src/app/[section]/page.tsx');
  assert.ok(!page.includes('Все результаты подготовлены заранее'));
  assert.ok(!page.includes('Демонстрационный режим'));
  assert.match(page, /Рабочие инструменты/);
});
