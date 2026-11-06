/** Validation of the uncertainty statement of a property value. The four kinds (unknown, standard, expanded, bounds) are different statements and are never
 *  converted into one another by the validator. `unknown` is not zero; an exactly zero uncertainty must be declared `exact_by_definition`; limits are not a standard
 *  deviation; an expanded uncertainty without its coverage factor is not a standard uncertainty. */

import { checkKeys, checkQuantity } from './checks';
import { Collector, isRecord } from './errors';
import { COVERAGE_FACTOR_ORIGINS, UNCERTAINTY_ORIGINS, type PropertyUncertainty } from './property-types';
import type { QuantityKind } from '@/physics';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** `value` is the (unit-bearing) value the statement is about, when it is valid; it is used to check that limits enclose it. */
export function collectUncertainty(u: unknown, value: { value: number; unit: string } | null, kind: QuantityKind | null, path: string, c: Collector): PropertyUncertainty['kind'] | null {
  if (!isRecord(u)) { c.error('invalid_uncertainty', path, `${path}: ожидалось утверждение о неопределённости; если источник её не сообщает, запишите { kind: 'unknown' }.`); return null; }
  const originOk = (origin: unknown, p: string, allowExact: boolean): boolean => {
    if (!(UNCERTAINTY_ORIGINS as readonly string[]).includes(origin as string)) { c.error('invalid_uncertainty', p, `${p}: происхождение оценки — одно из: ${UNCERTAINTY_ORIGINS.join(', ')}.`); return false; }
    if (origin === 'exact_by_definition' && !allowExact) { c.error('invalid_uncertainty', p, `${p}: «exact_by_definition» — только для нулевой стандартной или расширенной неопределённости.`); return false; }
    return true;
  };
  switch (u.kind) {
    case 'unknown':
      checkKeys(u, ['kind'], path, c, 'invalid_uncertainty');
      return 'unknown';
    case 'standard': {
      checkKeys(u, ['kind', 'u', 'origin'], path, c, 'invalid_uncertainty');
      if (!finite(u.u) || u.u < 0) c.error('invalid_uncertainty', `${path}.u`, `${path}.u: стандартная неопределённость — конечное неотрицательное число в единице значения.`);
      if (originOk(u.origin, `${path}.origin`, true) && finite(u.u)) zeroRule(u.u, u.origin as string, path, c);
      return 'standard';
    }
    case 'expanded': {
      checkKeys(u, ['kind', 'U', 'k', 'kOrigin', 'origin'], path, c, 'invalid_uncertainty');
      if (!finite(u.U) || u.U < 0) c.error('invalid_uncertainty', `${path}.U`, `${path}.U: расширенная неопределённость — конечное неотрицательное число в единице значения.`);
      if (originOk(u.origin, `${path}.origin`, true) && finite(u.U)) zeroRule(u.U, u.origin as string, path, c);
      if (u.k === undefined) {
        if (u.kOrigin !== undefined) c.error('invalid_uncertainty', `${path}.kOrigin`, `${path}.kOrigin: происхождение коэффициента охвата указано без самого коэффициента.`);
        c.warning('expanded_without_k', path, `${path}: коэффициент охвата k не указан — расширенную неопределённость нельзя пересчитать в стандартную, и она не является стандартной.`);
      } else {
        if (!finite(u.k) || u.k <= 0) c.error('invalid_uncertainty', `${path}.k`, `${path}.k: коэффициент охвата — конечное число больше 0.`);
        if (!(COVERAGE_FACTOR_ORIGINS as readonly string[]).includes(u.kOrigin as string)) c.error('invalid_uncertainty', `${path}.kOrigin`, `${path}.kOrigin: если k известен, нужно указать его происхождение: ${COVERAGE_FACTOR_ORIGINS.join(', ')}.`);
      }
      return 'expanded';
    }
    case 'bounds': {
      checkKeys(u, ['kind', 'lower', 'upper', 'origin'], path, c, 'invalid_uncertainty');
      originOk(u.origin, `${path}.origin`, false);
      if (!finite(u.lower) || !finite(u.upper)) { c.error('invalid_uncertainty', path, `${path}: границы lower и upper — конечные числа в единице значения.`); return 'bounds'; }
      if (u.lower > u.upper) c.error('invalid_uncertainty', path, `${path}: нижняя граница больше верхней.`);
      else if (value && (value.value < u.lower || value.value > u.upper)) c.error('invalid_uncertainty', path, `${path}: значение ${value.value} лежит вне заявленных границ [${u.lower}; ${u.upper}].`);
      if (value && kind) {
        const sub = new Collector();
        checkQuantity({ value: u.lower, unit: value.unit }, kind, `${path}.lower`, sub);
        checkQuantity({ value: u.upper, unit: value.unit }, kind, `${path}.upper`, sub);
        for (const issue of sub.report().issues) c.error('invalid_uncertainty', issue.path, issue.message);
      }
      return 'bounds';
    }
    default:
      c.error('invalid_uncertainty', `${path}.kind`, `${path}.kind: unknown, standard, expanded или bounds.`);
      return null;
  }
}

/** An exactly zero uncertainty means "exact" (as in M1.2's Measured), so it is accepted only when declared exact by definition - and that origin only for zero. */
function zeroRule(amount: number, origin: string, path: string, c: Collector): void {
  if (amount === 0 && origin !== 'exact_by_definition') c.error('invalid_uncertainty', `${path}.origin`, `${path}: нулевая неопределённость означает «точно» и допустима только при origin = exact_by_definition (если неопределённость не известна, запишите unknown).`);
  else if (amount === 0) c.warning('zero_uncertainty', path, `${path}: нулевая неопределённость — значение объявлено точным по определению.`);
  if (amount !== 0 && origin === 'exact_by_definition') c.error('invalid_uncertainty', `${path}.origin`, `${path}: «exact_by_definition» несовместимо с ненулевой неопределённостью.`);
}
