/** Validators of the table-specific parts of a `TabulatedSeries`: the table-level provenance mode and the interpolation STATEMENT. Structure only. Nothing is computed here:
 *  no interpolation, no extrapolation, no uncertainty of an interpolated value; and a permission to interpolate is a statement about the table, not a proof that the property
 *  is linear in temperature, and not a guarantee for an interval that crosses a phase transition or a structural change. */

import { exact } from '@/physics';
import { checkKeys, checkQuantity, checkSource, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { collectProvenance } from './provenance';
import type { ParsedEvent } from './series-parts';

type Rational = exact.Rational;
export const TABLE_PROVENANCE_MODES = Object.freeze(['per_row', 'single_source'] as const);
export const INTERPOLATION_METHODS = Object.freeze(['linear_in_temperature'] as const);
export const INTERPOLATION_BASES = Object.freeze(['stated_in_source', 'curator_decision'] as const);

/** The table-level provenance. `per_row`: every row carries its own provenance (checked row by row by the series validator); the optional `compilation` names the publication the
 *  table was compiled in and NEVER stands in for the origin of a value. `single_source`: the whole table has one provenance and rows carry none. Returns the status of the
 *  single provenance (`single`) when there is one. */
export function collectTableProvenance(tp: unknown, path: string, c: Collector): { single?: string | null } {
  if (!isRecord(tp)) { c.error('invalid_table_provenance', path, `${path}: ожидался объект { mode: 'per_row' | 'single_source', ... } — режим происхождения таблицы задаётся явно.`); return {}; }
  if (tp.mode === 'per_row') {
    checkKeys(tp, ['mode', 'compilation'], path, c, 'invalid_table_provenance');
    if (tp.compilation !== undefined) checkSource(tp.compilation, `${path}.compilation`, c);
    return {};
  }
  if (tp.mode === 'single_source') {
    checkKeys(tp, ['mode', 'provenance'], path, c, 'invalid_table_provenance');
    if (tp.provenance === undefined) { c.error('invalid_table_provenance', `${path}.provenance`, `${path}.provenance: в режиме single_source общее происхождение обязательно.`); return {}; }
    return { single: collectProvenance(tp.provenance, `${path}.provenance`, c) };
  }
  c.error('invalid_table_provenance', `${path}.mode`, `${path}.mode: один из: ${TABLE_PROVENANCE_MODES.join(', ')} (режим не угадывается).`);
  return {};
}

/** The interpolation statement: `{ permitted: false }` (the safe default) or an explicit permission for `linear_in_temperature` with a basis, a justification and, if
 *  given, a positive temperature INTERVAL `maxGap`. The temperatures of the observations and the declared events are used only to WARN when the permission spans an event. */
export function collectInterpolation(s: unknown, events: readonly ParsedEvent[], temperatures: readonly Rational[], path: string, c: Collector): void {
  if (!isRecord(s)) { c.error('invalid_interpolation', path, `${path}: утверждение об интерполяции обязательно; по умолчанию { permitted: false }.`); return; }
  if (s.permitted === false) { checkKeys(s, ['permitted'], path, c, 'invalid_interpolation'); return; }
  if (s.permitted !== true) { c.error('invalid_interpolation', `${path}.permitted`, `${path}.permitted: ожидалось true или false.`); return; }
  checkKeys(s, ['permitted', 'method', 'basis', 'justification', 'source', 'maxGap'], path, c, 'invalid_interpolation');
  if (!(INTERPOLATION_METHODS as readonly string[]).includes(s.method as string)) c.error('invalid_interpolation', `${path}.method`, `${path}.method: при permitted: true метод обязателен; сейчас допустим только ${INTERPOLATION_METHODS.join(', ')}.`);
  if (!isNonEmptyString(s.justification)) c.error('invalid_interpolation', `${path}.justification`, `${path}.justification: обоснование обязательно (непустая строка).`);
  // `source` always passes the same source check. `stated_in_source`: it is the source of the STATEMENT that interpolation is acceptable (required). `curator_decision`: it is an
  // optional documented ground of the curator's own decision - it does not say that the author recommended interpolation and does not turn the basis into `stated_in_source`.
  if (s.basis !== 'stated_in_source' && s.basis !== 'curator_decision') c.error('invalid_interpolation', `${path}.basis`, `${path}.basis: один из: ${INTERPOLATION_BASES.join(', ')}.`);
  else if (s.source !== undefined) checkSource(s.source, `${path}.source`, c);
  else if (s.basis === 'stated_in_source') c.error('invalid_interpolation', `${path}.source`, `${path}.source: при basis «stated_in_source» нужен идентифицируемый источник этого утверждения.`);
  if (s.maxGap !== undefined) checkQuantity(s.maxGap, 'temperatureDifference', `${path}.maxGap`, c, 'positive');   // an INTERVAL (K_delta, degC_delta), never an absolute temperature
  c.info('interpolation_not_evaluated', path, `${path}: разрешение на интерполяцию только хранится; оно не доказывает линейности зависимости, значения между строками не вычисляются, неопределённость не оценивается, экстраполяция не допускается.`);
  if (temperatures.length > 0) {
    let lo = temperatures[0]; let hi = temperatures[0];
    for (const t of temperatures) { if (exact.compare(t, lo) < 0) lo = t; if (exact.compare(t, hi) > 0) hi = t; }
    for (const e of events) {
      const from = e.at ?? e.from; const to = e.at ?? e.to;
      if (from === undefined || to === undefined || e.effect === 'range_ends_before') continue;
      if (exact.compare(to, lo) >= 0 && exact.compare(from, hi) <= 0) { c.warning('interpolation_across_event', path, `${path}: разрешена интерполяция, а область таблицы пересекает событие «${e.kind}» — разрешение не гарантирует допустимости интерполяции через фазовый или структурный переход.`); break; }
    }
  }
}
