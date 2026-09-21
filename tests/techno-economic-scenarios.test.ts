import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIO_KEYS, SCENARIO_LABELS, defaultScenarioForms } from '../src/components/techno-economic-assessment';
import { runAssessment, type AssessmentInput } from '../src/services/workspace/techno-economic-assessment';

// Regression for the full-functional-audit finding: the existing 3-scenario capability
// (already proven at the engine level - see "scenario analysis (Codex regression)" in
// tests/techno-economic-assessment.test.ts) had no UI. These tests pin the UI-facing scenario
// model (keys/labels/independent default forms) that techno-economic-assessment.tsx now uses,
// without introducing a second calculation engine.

test('SCENARIO_KEYS/SCENARIO_LABELS: exactly Base/Conservative/Optimistic, each with a distinct label', () => {
  assert.deepEqual(SCENARIO_KEYS, ['base', 'conservative', 'optimistic']);
  assert.deepEqual(SCENARIO_LABELS, { base: 'Базовый', conservative: 'Консервативный', optimistic: 'Оптимистичный' });
  const labels = Object.values(SCENARIO_LABELS);
  assert.equal(new Set(labels).size, labels.length, 'every scenario must have a distinct label');
});

test('defaultScenarioForms: creates 3 genuinely independent form objects, not the same object shared by reference', () => {
  const forms = defaultScenarioForms();
  assert.equal(Object.keys(forms).length, 3);
  assert.notEqual(forms.base, forms.conservative);
  assert.notEqual(forms.base, forms.optimistic);
  assert.notEqual(forms.conservative, forms.optimistic);
  // mutating one scenario's nested capex object must never affect another's
  forms.base.capex.equipment = '999999';
  assert.equal(forms.conservative.capex.equipment, '', 'scenarios must not share nested objects either');
});

test('defaultScenarioForms: every scenario starts genuinely empty (financial fields), never a pre-filled/invented baseline', () => {
  const forms = defaultScenarioForms();
  for (const key of SCENARIO_KEYS) {
    assert.equal(forms[key].capex.equipment, '');
    assert.equal(forms[key].opex.electricity, '');
    assert.equal(forms[key].title, '');
  }
});

function scenarioInput(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    capex: { equipment: 5_000_000 },
    opex: { period: 'year', electricity: 200_000, labor: 800_000 },
    capacity: { shiftsPerDay: 2, hoursPerShift: 8, workingDaysPerYear: 250, utilizationPercent: 80, cycleTimeMinutes: 20, unitsPerCycle: 2 },
    economicEffect: { mode: 'total_external_cost', currentAnnualCost: 3_000_000, newAnnualCost: 2_000_000 },
    ...overrides,
  };
}

test('3-scenario UI drives the SAME runAssessment engine per scenario - user-supplied differences produce genuinely different, reproducible results (no second engine, nothing invented automatically)', () => {
  const base = runAssessment(scenarioInput());
  const conservative = runAssessment(scenarioInput({ capacity: { ...scenarioInput().capacity, utilizationPercent: 50 } }));
  const optimistic = runAssessment(scenarioInput({ capacity: { ...scenarioInput().capacity, utilizationPercent: 95 } }));

  assert.ok(optimistic.capacity.unitsPerYear > base.capacity.unitsPerYear);
  assert.ok(base.capacity.unitsPerYear > conservative.capacity.unitsPerYear);

  // reproducible: same scenario input -> identical result, never randomized
  const baseAgain = runAssessment(scenarioInput());
  assert.deepEqual(base, baseAgain);
});

test('a scenario with missing required financial data throws the SAME validation error the engine already gives - no silent zero-filling', () => {
  assert.throws(() => runAssessment(scenarioInput({ capex: { equipment: Number.NaN } })), /Стоимость оборудования/);
});
