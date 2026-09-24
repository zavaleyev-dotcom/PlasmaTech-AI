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
  // ROI must use the NET annual savings alone - annualSavings already reflects the new
  // system's OPEX (it is current cost minus new cost), so OPEX must not be subtracted again.
  assert.equal(result.roi.percent, (2_600_000 / 5_300_000) * 100);
});

test('runAssessment (Codex regression): ROI no longer double-subtracts OPEX - a 2-year-payback investment must show a positive, payback-consistent ROI, not a large negative one', () => {
  const result = runAssessment({
    capex: { equipment: 1_000_000 },
    opex: { period: 'year', electricity: 1_200_000 },
    capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 1 },
    economicEffect: { mode: 'total_external_cost', currentAnnualCost: 1_700_000, newAnnualCost: 1_200_000 },
  });
  assert.equal(result.economicEffect.annualSavings, 500_000);
  assert.equal(result.opex.annualTotal, 1_200_000); // a large absolute OPEX, unrelated in scale to the savings delta
  assert.equal(result.payback.years, 2);
  // Before the fix this computed ((500_000 - 1_200_000) / 1_000_000) * 100 = -70%, contradicting
  // a genuinely good (2-year payback) investment. ROI must instead be consistent with payback:
  // a positive rate of return whose reciprocal-ish relationship matches years-to-payback.
  assert.equal(result.roi.percent, 50);
  assert.ok(result.roi.percent > 0, 'a profitable, fast-payback investment must never show a large negative ROI');
  // presentation issue found alongside the fix: the "как рассчитано" text must not show a
  // confusing "− 0.00" that reads as if OPEX were mistakenly zeroed out.
  assert.ok(!result.roi.formula.includes('− 0.00') && !result.roi.formula.includes('- 0.00'), 'the ROI formula text must not display a misleading "minus 0.00 OPEX"');
  assert.ok(result.roi.formula.includes('не требуется'), 'the formula text must explain why OPEX is not subtracted again');
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

// ---------- F05 (MEDIUM): validation gaps found by Codex ----------

test('calculateProductionCapacity (F05): a physically impossible schedule (4 shifts x 12 hours/day = 48h > 24h) is rejected with a clear message', () => {
  assert.throws(
    () => calculateProductionCapacity({ shiftsPerDay: 4, hoursPerShift: 12, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 1 }),
    /физически невозможны/,
  );
});

test('calculateProductionCapacity (F05): a normal schedule at or under 24h/day is unaffected (e.g. 3 shifts x 8 hours = 24h exactly)', () => {
  assert.doesNotThrow(() => calculateProductionCapacity({ shiftsPerDay: 3, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 1 }));
});

test('calculatePayback (F05): calculatePayback(100, NaN) must be a validation error, never a NaN "successful" result (NaN <= 0 is false in JS)', () => {
  assert.throws(() => calculatePayback(100, NaN), /Годовой экономический эффект: введите конечное число\./);
});

test('calculatePayback (F05): Infinity/-Infinity annual effect is also rejected, never silently computed', () => {
  assert.throws(() => calculatePayback(100, Infinity), /Годовой экономический эффект/);
  assert.throws(() => calculatePayback(100, -Infinity), /Годовой экономический эффект/);
});

test('calculateRoi (F05): a NaN annual benefit is rejected server-side, independent of any UI check', () => {
  assert.throws(() => calculateRoi(NaN, 0, 1_000_000), /Годовой экономический эффект: введите конечное число\./);
});

test('calculateCumulativeSavings (F05): a NaN annual savings figure is rejected rather than producing an array of NaN', () => {
  assert.throws(() => calculateCumulativeSavings(NaN, 5), /Годовая экономия: введите конечное число\./);
});

test('calculateRoi (F05): a genuinely negative annual benefit (a real loss) is still accepted, not rejected just for being negative', () => {
  assert.doesNotThrow(() => calculateRoi(-50_000, 0, 1_000_000));
});

// ---------- F05 (LOW) Codex regression: OUTPUT overflow, not just input validation - finite
// inputs whose ARITHMETIC overflows must never be returned as a valid economic result ----------

test('calculatePayback (F05): calculatePayback(1e308, 1) must be a controlled range error, never { months: Infinity } - years alone is finite, but years*12 overflows', () => {
  assert.throws(() => calculatePayback(1e308, 1), /не является конечным числом/);
});

test('calculateCumulativeSavings (F05): calculateCumulativeSavings(1e308, 2) must be a controlled range error, never [1e308, Infinity] - the SECOND year overflows even though the first does not', () => {
  assert.throws(() => calculateCumulativeSavings(1e308, 2), /не является конечным числом/);
});

test('calculateCapex (F05): summing several individually-valid, extreme line items that overflow the total is rejected, never returned as CAPEX = Infinity', () => {
  assert.throws(() => calculateCapex({ equipment: 1e308, infrastructure: 1e308 }), /не является конечным числом/);
});

test('calculateOpex (F05): a monthly total that overflows once annualized (×12) is rejected, never returned as an Infinity annual OPEX', () => {
  assert.throws(() => calculateOpex({ period: 'month', electricity: 1.7e308 }), /не является конечным числом/);
});

test('calculateUnitCost (F05): an extreme operating cost over a vanishingly small (but valid, positive) output overflowing to Infinity is rejected, never returned as a valid unit cost', () => {
  assert.throws(() => calculateUnitCost(1e300, 1e-300), /не является конечным числом/);
});

test('calculateUnitCost (F05): depreciation-with-amortization overflow (CAPEX/years, or the combined with-depreciation figure) is rejected the same way', () => {
  assert.throws(() => calculateUnitCost(1, 1, 1e308, 1e-300), /не является конечным числом/);
});

test('calculateEconomicEffect (F05): a unit_cost-mode annualized multiplication (savings/unit x annual output) overflowing to Infinity is rejected, never returned as a valid savings figure', () => {
  assert.throws(() => calculateEconomicEffect({ mode: 'unit_cost', currentUnitCost: 1e300, newUnitCost: 0, annualOutput: 1e10 }), /не является конечным числом/);
});

test('calculateBreakEven (F05): an extreme fixed cost divided by a vanishingly small (but positive) contribution margin overflowing to Infinity is rejected, never returned as a valid break-even volume', () => {
  assert.throws(() => calculateBreakEven({ sellingPricePerUnit: 1e-300 + 1e-310, variableCostPerUnit: 1e-300, fixedCosts: 1e300 }), /не является конечным числом/);
});

test('runAssessment (F05): an overflow anywhere in the pipeline (e.g. CAPEX total) surfaces as the SAME controlled error, never a partially-computed result with Infinity/NaN fields', () => {
  const base = {
    capex: { equipment: 1e308, infrastructure: 1e308 },
    opex: { period: 'year' as const, electricity: 100_000 },
    capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 90, cycleTimeMinutes: 15, unitsPerCycle: 1 },
    economicEffect: { mode: 'total_external_cost' as const, currentAnnualCost: 500_000, newAnnualCost: 300_000 },
  };
  assert.throws(() => runAssessment(base), /не является конечным числом/);
});

test('calculateCapex/calculateOpex/calculateUnitCost/calculateEconomicEffect/calculateBreakEven (F05): ordinary, non-extreme values used throughout this project are completely unaffected by the new overflow guards', () => {
  assert.equal(calculateCapex({ equipment: 1_000_000, installation: 50_000 }).total, 1_050_000);
  assert.equal(calculateOpex({ period: 'month', electricity: 10_000 }).annualTotal, 120_000);
  assert.equal(calculateUnitCost(500_000, 10_000).withoutDepreciation, 50);
  assert.equal(calculateEconomicEffect({ mode: 'total_external_cost', currentAnnualCost: 500_000, newAnnualCost: 300_000 }).annualSavings, 200_000);
  assert.equal(calculateBreakEven({ sellingPricePerUnit: 100, variableCostPerUnit: 60, fixedCosts: 400_000 }).volumeUnits, 10_000);
});
