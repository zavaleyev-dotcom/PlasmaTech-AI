/** Typed physical quantities: a number together with the unit it is expressed in. The compiler knows the KIND of the quantity from its unit - `Quantity<'pressure'>`
 *  accepts only absolute-pressure units - so `convertQuantity(pressure, 'K')` does not compile; for data that arrives at run time (JSON, forms) the same rules are
 *  checked when the call is made. A quantity is created only if it is physically possible (finite; not below 0 K; no negative mass or absolute pressure), and
 *  the conversion checks it again, so a hand-made `{ value, unit }` object cannot smuggle an impossible value through. The value is kept exactly as given (in the
 *  unit given); nothing is converted until you ask.
 *
 *  Absolute temperature, temperature DIFFERENCE, absolute pressure and gauge pressure are four different kinds: they never convert into one another implicitly.
 *  The only bridges are the explicit functions below (temperatureDifference, shiftTemperature, gaugeToAbsolute, absoluteToGauge). */

import { PhysicsError } from './errors';
import { requireFinite } from './guards';
import { add, sub } from './exact';
import { assertPhysicallyValid, convert, exactToNumber, fromSiRational, getUnit, QUANTITY_KINDS, toSiRational, type KindOfUnit, type QuantityKind, type UnitId, type UnitOf } from './units';

export interface Quantity<K extends QuantityKind = QuantityKind> {
  readonly value: number;
  readonly unit: UnitOf<K>;
}

/** Builds a quantity; the number must be finite, the unit known, and the value physically possible for its kind. -0 becomes 0. The result is frozen. */
export function quantity<U extends UnitId>(value: number, unit: U): Quantity<KindOfUnit<U>> {
  const spec = getUnit(unit); // throws unknown_unit
  assertPhysicallyValid(value, unit, `Величина (${spec.symbol})`);
  return Object.freeze({ value: value === 0 ? 0 : value, unit }) as unknown as Quantity<KindOfUnit<U>>;
}

/** A quantity of the kind `kind` from untrusted data: the unit must be known AND of that kind, otherwise `kind_mismatch`/`unknown_unit`. */
export function quantityOfKind<K extends QuantityKind>(kind: K, value: unknown, unit: unknown): Quantity<K> {
  const spec = getUnit(String(unit));
  if (spec.kind !== kind) throw new PhysicsError('kind_mismatch', `Единица ${spec.symbol} не относится к величине «${QUANTITY_KINDS[kind].nameRu}».`);
  return quantity(requireFinite(value, `Величина «${QUANTITY_KINDS[kind].nameRu}»`), spec.id) as unknown as Quantity<K>;
}

export function convertQuantity<K extends QuantityKind>(q: Quantity<K>, to: UnitOf<K>): Quantity<K> {
  return Object.freeze({ value: convert(q.value, q.unit, to), unit: to });
}

/** The same quantity in the coherent SI unit of its kind (Pa, K, K_delta, Pa_g, one, ...). */
export function toSI<K extends QuantityKind>(q: Quantity<K>): Quantity<K> {
  return convertQuantity(q, QUANTITY_KINDS[getUnit(q.unit).kind].siUnit as UnitOf<K>);
}

function requireKind<K extends QuantityKind>(input: unknown, kind: K, what: string): Quantity<K> {
  if (input === undefined || input === null || typeof input !== 'object') throw new PhysicsError('missing_reference', `${what}: величина не задана.`);
  const q = input as { value: number; unit: unknown };
  const spec = getUnit(String(q.unit));
  if (spec.kind !== kind) throw new PhysicsError('kind_mismatch', `${what}: ожидалась величина «${QUANTITY_KINDS[kind].nameRu}», получена единица ${spec.symbol} («${QUANTITY_KINDS[spec.kind].nameRu}»).`);
  assertPhysicallyValid(q.value, spec.id, `${what} (${spec.symbol})`);
  return input as Quantity<K>;
}

// ---------- temperature: absolute <-> difference ----------

/** `later - earlier` of two ABSOLUTE temperatures as a temperature difference in K_delta (exact: 20 °C - 10 °C = 10 K_delta; 300 K - 20 °C = 6.85 K_delta). */
export function temperatureDifference(later: Quantity<'temperature'>, earlier: Quantity<'temperature'>): Quantity<'temperatureDifference'> {
  const a = requireKind(later, 'temperature', 'Температура');
  const b = requireKind(earlier, 'temperature', 'Температура');
  const exact = sub(toSiRational(a.value, a.unit), toSiRational(b.value, b.unit));
  return Object.freeze({ value: exactToNumber(exact, 'Разность температур'), unit: 'K_delta' as const });
}

/** An absolute temperature shifted by a temperature difference, in K. The result must not fall below 0 K (an interval itself may be negative: -10 K_delta is fine). */
export function shiftTemperature(t: Quantity<'temperature'>, delta: Quantity<'temperatureDifference'>): Quantity<'temperature'> {
  const a = requireKind(t, 'temperature', 'Температура');
  const d = requireKind(delta, 'temperatureDifference', 'Разность температур');
  const si = add(toSiRational(a.value, a.unit), toSiRational(d.value, d.unit));
  return Object.freeze({ value: fromSiRational(si, 'K', 'Температура после сдвига'), unit: 'K' as const });
}

// ---------- pressure: gauge <-> absolute ----------

/** absolute = reference + gauge, in Pa (exact). The REFERENCE (ambient) pressure is a mandatory argument: nothing - not even 101325 Pa - is assumed. A gauge value
 *  that would give a negative absolute pressure (a vacuum deeper than the reference) is refused. */
export function gaugeToAbsolute(gauge: Quantity<'gaugePressure'>, reference: Quantity<'pressure'>): Quantity<'pressure'> {
  const g = requireKind(gauge, 'gaugePressure', 'Избыточное давление');
  const r = requireKind(reference, 'pressure', 'Опорное давление');
  const si = add(toSiRational(r.value, r.unit), toSiRational(g.value, g.unit));
  return Object.freeze({ value: fromSiRational(si, 'Pa', 'Абсолютное давление'), unit: 'Pa' as const });
}

/** gauge = absolute - reference, in Pa_g (exact); negative below the reference. */
export function absoluteToGauge(absolute: Quantity<'pressure'>, reference: Quantity<'pressure'>): Quantity<'gaugePressure'> {
  const a = requireKind(absolute, 'pressure', 'Абсолютное давление');
  const r = requireKind(reference, 'pressure', 'Опорное давление');
  const si = sub(toSiRational(a.value, a.unit), toSiRational(r.value, r.unit));
  return Object.freeze({ value: fromSiRational(si, 'Pa_g', 'Избыточное давление'), unit: 'Pa_g' as const });
}
