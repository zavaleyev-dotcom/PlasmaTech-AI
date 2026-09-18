import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBreakEven, calculateCapex, calculateCumulativeSavings, calculateEconomicEffect,
  calculateOpex, calculatePayback, calculateProductionCapacity, calculateRoi, calculateUnitCost,
  formatCurrency, runAssessment,
} from '../src/services/workspace/techno-economic-assessment';

// ---------- A. CAPEX ----------

test('calculateCapex: sums all provided line items, equipment alone is enough', () => {
  const result = calculateCapex({ equipment: 1_000_000 });
  assert.equal(result.total, 1_000_000);
});

test('calculateCapex: sums equipment + every optional line item (CAPEX total formula)', () => {
  const result = calculateCapex({
    equipment: 1_000_000, delivery: 50_000, customsLogistics: 30_000, installation: 80_000,
    commissioning: 40_000, training: 20_000, infrastructure: 60_000, tooling: 25_000, otherOneTime: 15_000,
  });
  assert.equal(result.total, 1_000_000 + 50_000 + 30_000 + 80_000 + 40_000 + 20_000 + 60_000 + 25_000 + 15_000);
  assert.equal(result.lineItems.length, 9);
});

test('calculateCapex: rejects missing/invalid equipment cost, and a negative optional field', () => {
  assert.throws(() => calculateCapex({ equipment: 0 }), /Стоимость оборудования/);
  assert.throws(() => calculateCapex({ equipment: -1 }), /Стоимость оборудования/);
  assert.throws(() => calculateCapex({ equipment: NaN }), /Стоимость оборудования/);
  assert.throws(() => calculateCapex({ equipment: Infinity }), /Стоимость оборудования/);
  assert.throws(() => calculateCapex({ equipment: 1000, delivery: -1 }), /Доставка/);
});

// ---------- B. OPEX ----------

test('calculateOpex: sums all line items and shows the period clearly, converting month->year', () => {
  const monthly = calculateOpex({ period: 'month', electricity: 10_000, labor: 200_000 });
  assert.equal(monthly.totalPerPeriod, 210_000);
  assert.equal(monthly.period, 'month');
  assert.equal(monthly.annualTotal, 210_000 * 12);

  const yearly = calculateOpex({ period: 'year', electricity: 120_000, labor: 2_400_000 });
  assert.equal(yearly.annualTotal, 2_520_000, 'a year-period OPEX must not be multiplied again');
});

test('calculateOpex: rejects a negative line item', () => {
  assert.throws(() => calculateOpex({ period: 'year', electricity: -5 }), /Электроэнергия/);
});

// ---------- C. Production capacity ----------

test('calculateProductionCapacity: computes effective hours, cycles/year and units/year', () => {
  const result = calculateProductionCapacity({ shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 30, unitsPerCycle: 4 });
  const effectiveHours = 2 * 8 * 250 * 0.8;
  assert.ok(Math.abs(result.effectiveHoursPerYear - effectiveHours) < 1e-9);
  const cycles = (effectiveHours * 60) / 30;
  assert.ok(Math.abs(result.cyclesPerYear - cycles) < 1e-9);
  assert.ok(Math.abs(result.unitsPerYear - cycles * 4) < 1e-9);
});

test('calculateProductionCapacity (Codex regression): rejects a zero cycle time, and utilization outside 0-100', () => {
  const base = { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 30, unitsPerCycle: 4 };
  assert.throws(() => calculateProductionCapacity({ ...base, cycleTimeMinutes: 0 }), /Время одного цикла/);
  assert.throws(() => calculateProductionCapacity({ ...base, utilizationPercent: -1 }), /Загрузка/);
  assert.throws(() => calculateProductionCapacity({ ...base, utilizationPercent: 101 }), /Загрузка/);
  assert.doesNotThrow(() => calculateProductionCapacity({ ...base, utilizationPercent: 0 }), 'exactly 0% utilization is a valid (if useless) edge case, not an error');
  assert.doesNotThrow(() => calculateProductionCapacity({ ...base, utilizationPercent: 100 }));
});

// ---------- D. Unit cost / depreciation ----------

test('calculateUnitCost: without depreciation is annualOperatingCost/annualOutput; with depreciation adds CAPEX/years first', () => {
  const withoutDep = calculateUnitCost(1_000_000, 10_000);
  assert.equal(withoutDep.withoutDepreciation, 100);
  assert.equal(withoutDep.withDepreciation, null, 'omitting capex/years must leave withDepreciation null, not a guessed value');

  const withDep = calculateUnitCost(1_000_000, 10_000, 2_000_000, 5);
  assert.equal(withDep.annualDepreciation, 400_000);
  assert.equal(withDep.withDepreciation, (1_000_000 + 400_000) / 10_000);
  assert.equal(withDep.withoutDepreciation, 100, 'the without-depreciation figure must be unaffected by capex/years being supplied');
});

test('calculateUnitCost: rejects a zero/negative annual output (division by zero) and a zero depreciation period', () => {
  assert.throws(() => calculateUnitCost(1000, 0), /Годовой выпуск/);
  assert.throws(() => calculateUnitCost(1000, -5), /Годовой выпуск/);
  assert.throws(() => calculateUnitCost(1000, 100, 50_000, 0), /амортизации/);
});

// ---------- E. Economic effect ----------

test('calculateEconomicEffect: unit_cost mode multiplies the per-unit savings by annual output', () => {
  const result = calculateEconomicEffect({ mode: 'unit_cost', currentUnitCost: 150, newUnitCost: 100, annualOutput: 10_000 });
  assert.equal(result.savingsPerUnit, 50);
  assert.equal(result.annualSavings, 500_000);
});

test('calculateEconomicEffect: total_external_cost mode is a direct annual difference, with no per-unit figure', () => {
  const result = calculateEconomicEffect({ mode: 'total_external_cost', currentAnnualCost: 3_000_000, newAnnualCost: 2_200_000 });
  assert.equal(result.savingsPerUnit, null);
  assert.equal(result.annualSavings, 800_000);
});

test('calculateEconomicEffect (Codex regression): a negative economic effect (the new option is more expensive) is reported honestly, not clamped to zero', () => {
  const result = calculateEconomicEffect({ mode: 'total_external_cost', currentAnnualCost: 1_000_000, newAnnualCost: 1_500_000 });
  assert.equal(result.annualSavings, -500_000);
});

test('calculateCumulativeSavings: a simple (non-discounted) running sum, never randomized', () => {
  assert.deepEqual(calculateCumulativeSavings(100_000, 5), [100_000, 200_000, 300_000, 400_000, 500_000]);
  // Reproducibility: identical inputs must always produce identical output.
  assert.deepEqual(calculateCumulativeSavings(100_000, 5), calculateCumulativeSavings(100_000, 5));
});

// ---------- F. Payback ----------

test('calculatePayback: simple payback = CAPEX / annual effect, in years and months', () => {
  const result = calculatePayback(1_000_000, 250_000);
  assert.equal(result.years, 4);
  assert.equal(result.months, 48);
  assert.equal(result.message, null);
});

test('calculatePayback (Codex regression): a zero or negative annual effect never computes a payback figure - a clear message instead', () => {
  const zero = calculatePayback(1_000_000, 0);
  assert.equal(zero.years, null); assert.equal(zero.months, null); assert.ok(zero.message);
  const negative = calculatePayback(1_000_000, -50_000);
  assert.equal(negative.years, null); assert.ok(negative.message);
});

// ---------- G. ROI ----------

test('calculateRoi: ROI % = (annual benefit - annual operating cost) / CAPEX * 100, exactly as specified', () => {
  const result = calculateRoi(500_000, 300_000, 1_000_000);
  assert.equal(result.percent, ((500_000 - 300_000) / 1_000_000) * 100);
  assert.equal(result.percent, 20);
});

test('calculateRoi: a negative ROI (benefit does not cover operating cost) is reported, not hidden', () => {
  const result = calculateRoi(100_000, 300_000, 1_000_000);
  assert.equal(result.percent, -20);
});

// ---------- H. Break-even ----------

test('calculateBreakEven: volume = fixed costs / (price - variable cost)', () => {
  const result = calculateBreakEven({ sellingPricePerUnit: 500, variableCostPerUnit: 300, fixedCosts: 1_000_000 });
  assert.equal(result.volumeUnits, 1_000_000 / 200);
  assert.equal(result.message, null);
});

test('calculateBreakEven (Codex regression): a non-positive contribution margin never computes a volume - a clear message instead', () => {
  const equal = calculateBreakEven({ sellingPricePerUnit: 300, variableCostPerUnit: 300, fixedCosts: 1_000_000 });
  assert.equal(equal.volumeUnits, null); assert.ok(equal.message);
  const negative = calculateBreakEven({ sellingPricePerUnit: 200, variableCostPerUnit: 300, fixedCosts: 1_000_000 });
  assert.equal(negative.volumeUnits, null); assert.ok(negative.message);
});

// ---------- invalid input across the board ----------

test('every calculator rejects NaN and Infinity, never silently treating them as zero', () => {
  assert.throws(() => calculateCapex({ equipment: NaN }));
  assert.throws(() => calculateOpex({ period: 'year', electricity: Infinity }));
  assert.throws(() => calculateProductionCapacity({ shiftsPerDay: NaN, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 30, unitsPerCycle: 4 }));
  assert.throws(() => calculateUnitCost(Infinity, 100));
  assert.throws(() => calculatePayback(NaN, 100));
  assert.throws(() => calculateRoi(100, 100, NaN));
  assert.throws(() => calculateBreakEven({ sellingPricePerUnit: Infinity, variableCostPerUnit: 100, fixedCosts: 100 }));
});

// ---------- full pipeline: scenario-style variation and A/B comparison ----------

function baseAssessmentInput() {
  return {
    capex: { equipment: 5_000_000, installation: 300_000 },
    opex: { period: 'year' as const, electricity: 400_000, labor: 1_800_000, maintenance: 200_000 },
    capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 6 },
    depreciationYears: 7,
    economicEffect: { mode: 'total_external_cost' as const, currentAnnualCost: 5_000_000, newAnnualCost: 2_400_000 },
  };
}

test('runAssessment: computes the whole pipeline consistently end to end for one full input set', () => {
  const result = runAssessment(baseAssessmentInput());
  assert.equal(result.capex.total, 5_300_000);
  assert.equal(result.opex.annualTotal, 2_400_000);
  assert.ok(result.capacity.unitsPerYear > 0);
  assert.equal(result.unitCost.withoutDepreciation, result.opex.annualTotal / result.capacity.unitsPerYear);
  assert.equal(result.economicEffect.annualSavings, 2_600_000);
  assert.equal(result.payback.years, result.capex.total / result.economicEffect.annualSavings);
  assert.equal(result.roi.percent, ((2_600_000 - 2_400_000) / 5_300_000) * 100);
});

test('scenario analysis (Codex regression): three manually-adjusted parameter sets (optimistic/base/conservative) produce three genuinely different, reproducible results from the SAME calculation engine - never random', () => {
  const base = baseAssessmentInput();
  const optimistic = runAssessment({ ...base, capacity: { ...base.capacity, utilizationPercent: 95 }, economicEffect: { ...base.economicEffect, newAnnualCost: 2_000_000 } });
  const conservative = runAssessment({ ...base, capacity: { ...base.capacity, utilizationPercent: 60 }, economicEffect: { ...base.economicEffect, newAnnualCost: 3_000_000 } });
  const baseResult = runAssessment(base);

  assert.ok(optimistic.economicEffect.annualSavings > baseResult.economicEffect.annualSavings);
  assert.ok(conservative.economicEffect.annualSavings < baseResult.economicEffect.annualSavings);
  assert.ok(optimistic.capacity.unitsPerYear > conservative.capacity.unitsPerYear);
  // Reproducibility: the same scenario inputs always give the same numbers.
  const optimisticAgain = runAssessment({ ...base, capacity: { ...base.capacity, utilizationPercent: 95 }, economicEffect: { ...base.economicEffect, newAnnualCost: 2_000_000 } });
  assert.deepEqual(optimistic, optimisticAgain);
});

test('A/B comparison (Codex regression): two fully independent input sets are compared without either result affecting the other, and neither is auto-selected as a "winner"', () => {
  const optionA = runAssessment(baseAssessmentInput());
  const optionB = runAssessment({
    capex: { equipment: 3_000_000 },
    opex: { period: 'year', electricity: 600_000, labor: 1_200_000 },
    capacity: { shiftsPerDay: 1, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 70, cycleTimeMinutes: 15, unitsPerCycle: 3 },
    economicEffect: { mode: 'total_external_cost', currentAnnualCost: 5_000_000, newAnnualCost: 1_800_000 },
  });
  assert.notEqual(optionA.capex.total, optionB.capex.total);
  assert.notEqual(optionA.payback.years, optionB.payback.years);
  // Both are just data - runAssessment itself never picks or labels a "better" option.
  assert.ok(!('winner' in optionA) && !('winner' in optionB));
});

// ---------- currency: display formatting only, never a silent conversion ----------

test('formatCurrency (Codex regression) never converts the numeric value - only the symbol/format changes across currencies', () => {
  const rub = formatCurrency(1234.5, 'RUB');
  const usd = formatCurrency(1234.5, 'USD');
  const eur = formatCurrency(1234.5, 'EUR');
  for (const formatted of [rub, usd, eur]) {
    assert.ok(formatted.includes('1') && formatted.includes('234'), `expected the digits 1234 to appear unconverted in "${formatted}"`);
  }
  assert.notEqual(rub, usd, 'the symbol/format must differ');
  assert.notEqual(usd, eur);
});
