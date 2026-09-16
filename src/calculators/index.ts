export interface CalculationValue {
  value: number;
  unit: string;
}

export interface CalculationResult {
  output: CalculationValue;
  assumptions: readonly string[];
}

/** Pure deterministic calculators belong here, separately from AI output. */
export interface EngineeringCalculator {
  id: string;
  calculate(inputs: Readonly<Record<string, CalculationValue>>): CalculationResult;
}
