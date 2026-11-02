/** Errors and validation reports of the materials package. Validators never throw for bad DATA: they collect issues (code, severity, path, message in Russian) so a
 *  caller sees ALL problems of a record at once; only the `create*` functions throw (`MaterialsError`), and only when at least one issue is an error. Nothing is
 *  ever repaired, defaulted or filled in. */

export const MATERIAL_ISSUE_CODES = Object.freeze([
  'invalid_id', 'duplicate_id', 'invalid_kind', 'invalid_name', 'invalid_designation', 'designation_unsourced', 'invalid_source',
  'invalid_symbol', 'duplicate_symbol', 'kind_composition_mismatch', 'invalid_composition',
  'fraction_malformed', 'fraction_out_of_range', 'fraction_sum', 'fraction_range_infeasible', 'balance_invalid', 'too_few_constituents', 'invalid_tolerance',
  'stoichiometry_invalid', 'too_few_species',
  'invalid_phase', 'state_order_mismatch', 'crystal_structure_not_applicable', 'phase_not_applicable', 'phase_required',
  'invalid_structure', 'structure_not_applicable', 'invalid_quantity',
  'invalid_form', 'form_field_not_allowed', 'form_kind_mismatch', 'state_form_mismatch', 'state_form_ambiguous', 'substrate_conflict',
  'invalid_stack', 'duplicate_layer_id', 'invalid_layer', 'invalid_period', 'invalid_interface', 'stack_too_large',
  'missing_reference', 'reference_cycle', 'nested_coating_system',
  'missing_data', 'invalid_material', 'sum_not_exact', 'order_unknown',
] as const);
export type MaterialIssueCode = typeof MATERIAL_ISSUE_CODES[number];

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  readonly code: MaterialIssueCode;
  readonly severity: IssueSeverity;
  /** Where in the record, e.g. `composition.constituents[1].fraction`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationReport {
  /** true when there is no issue of severity `error` (warnings and info do not block). */
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export class MaterialsError extends Error {
  readonly code: MaterialIssueCode;
  readonly issues: readonly ValidationIssue[];
  constructor(code: MaterialIssueCode, message: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = 'MaterialsError';
    this.code = code;
    this.issues = issues;
  }
}

/** Collects the issues of one validation run. */
export class Collector {
  private readonly list: ValidationIssue[] = [];
  error(code: MaterialIssueCode, path: string, message: string): void { this.list.push({ code, severity: 'error', path, message }); }
  warning(code: MaterialIssueCode, path: string, message: string): void { this.list.push({ code, severity: 'warning', path, message }); }
  info(code: MaterialIssueCode, path: string, message: string): void { this.list.push({ code, severity: 'info', path, message }); }
  get errorCount(): number { return this.list.filter(i => i.severity === 'error').length; }
  report(): ValidationReport {
    const issues = Object.freeze(this.list.map(i => Object.freeze({ ...i })));
    return Object.freeze({ ok: !issues.some(i => i.severity === 'error'), issues });
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
