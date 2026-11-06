/** Using a validated property value. Two ways, and they are DIFFERENT:
 *   - `propertyToMeasured` gives a `Measured` (value with a standard uncertainty, M1.2) - only when the record states a STANDARD uncertainty, or an EXPANDED one with its
 *     coverage factor (u = U / k, exact). For `unknown`, for limits (`bounds`) and for an expanded uncertainty without k it REFUSES: they are not standard
 *     uncertainties and nothing here assumes a distribution or a coverage factor;
 *   - `propertyNominal` gives the value as a plain quantity with an explicit note of what is NOT known - a nominal calculation without a known uncertainty is
 *     allowed, but its result carries no metrological confirmation and a record that was not compared with its source is not called confirmed.
 *  Neither selects among records, averages, or converts conditions. */

import { exact, exactToNumber, measured, quantity, type Measured, type Quantity, type UnitId } from '@/physics';
import { MaterialsError } from './errors';
import { validatePropertyRecord } from './property-record';
import type { PropertyRecord, ValueStatus, VerificationStatus } from './property-types';

function requireValid(record: PropertyRecord): void {
  const report = validatePropertyRecord(record);
  const errors = report.issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new MaterialsError('invalid_property', `Запись свойства некорректна: ${errors[0].path}: ${errors[0].message}`, report.issues);
}

export function propertyToMeasured(record: PropertyRecord): Measured {
  requireValid(record);
  const { value, unit } = record.value;
  const u = record.uncertainty;
  switch (u.kind) {
    case 'standard': return measured(value, u.u, unit);
    case 'expanded': {
      if (u.k === undefined) throw new MaterialsError('uncertainty_not_convertible', 'Расширенная неопределённость без коэффициента охвата k не является стандартной и не может быть пересчитана.', []);
      const standard = u.U === 0 ? 0 : exactToNumber(exact.div(exact.rationalFromNumber(u.U), exact.rationalFromNumber(u.k)), 'Стандартная неопределённость u = U / k');
      return measured(value, standard, unit);
    }
    case 'bounds': throw new MaterialsError('uncertainty_not_convertible', 'Границы значения — не стандартная неопределённость: без явно заданного распределения они не превращаются в u.', []);
    default: throw new MaterialsError('uncertainty_not_convertible', 'Неопределённость неизвестна (это не ноль): Measured не может быть построен.', []);
  }
}

export interface NominalValue {
  readonly quantity: Quantity;
  /** true only when the record states a usable standard uncertainty (standard, or expanded with k). */
  readonly uncertaintyKnown: boolean;
  readonly status: ValueStatus;
  readonly verification: VerificationStatus;
  /** Always `false`: a nominal value is never "metrologically confirmed" by this package, whatever its record says. */
  readonly metrologicallyConfirmed: false;
  readonly caveats: readonly string[];
}

export function propertyNominal(record: PropertyRecord): NominalValue {
  requireValid(record);
  const u = record.uncertainty;
  const uncertaintyKnown = u.kind === 'standard' || (u.kind === 'expanded' && u.k !== undefined);
  const caveats: string[] = [];
  if (!uncertaintyKnown) caveats.push(u.kind === 'unknown' ? 'неопределённость неизвестна' : u.kind === 'bounds' ? 'заданы только границы, стандартная неопределённость неизвестна' : 'расширенная неопределённость без коэффициента охвата');
  if (record.provenance.verification.status === 'unverified') caveats.push('запись не сверена с первоисточником');
  if (record.provenance.status === 'model_estimate') caveats.push('значение — оценка по модели');
  if (record.provenance.status === 'user_input') caveats.push('значение введено пользователем');
  return Object.freeze({
    quantity: quantity(record.value.value, record.value.unit as UnitId) as Quantity,
    uncertaintyKnown, status: record.provenance.status, verification: record.provenance.verification.status, metrologicallyConfirmed: false as const,
    caveats: Object.freeze(caveats),
  });
}
