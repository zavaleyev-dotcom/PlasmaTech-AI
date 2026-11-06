/** Validators of the parts of a property series: locators, correlation statements and the applicability statement. Structure only - nothing is computed, and no
 *  independence, stability or phase is ever assumed for the sake of a statement that is missing. */

import { exact, toSiRational } from '@/physics';
import { checkKeys, checkQuantity, checkSource, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { CORRELATION_ORIGINS, EVENT_EFFECTS, EVENT_KINDS, HISTORY_STATES, MAX_CORRELATION_SIZE, SWEEP_DIRECTIONS, type EventEffect } from './series-types';

type Rational = exact.Rational;

export const OBSERVATION_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const LOCATOR_KEYS = ['page', 'table', 'figure', 'equation', 'section'] as const;

/** The exact SI value of a temperature quantity that has already passed `checkQuantity` (an absolute temperature). */
export const exactTemperature = (q: unknown): Rational => {
  const { value, unit } = q as { value: number; unit: string };
  return toSiRational(value, unit as never);
};

/** A place in the source: at least one of page, table, figure, equation, section, each a non-empty string. */
export function checkLocator(locator: unknown, path: string, c: Collector): boolean {
  if (!isRecord(locator)) { c.error('invalid_observation', path, `${path}: ожидался объект с местом в источнике.`); return false; }
  const before = c.errorCount;
  checkKeys(locator, LOCATOR_KEYS, path, c, 'invalid_observation');
  const present = LOCATOR_KEYS.filter(k => locator[k] !== undefined);
  if (present.length === 0 && Object.keys(locator).length === 0) c.error('invalid_observation', path, `${path}: пустое указание места — задайте страницу, таблицу, рисунок, уравнение или раздел.`);
  for (const k of present) if (!isNonEmptyString(locator[k])) c.error('invalid_observation', `${path}.${k}`, `${path}.${k}: ожидалась непустая строка.`);
  return c.errorCount === before;
}

function collectCorrelationProvenance(p: unknown, path: string, c: Collector): void {
  if (!isRecord(p)) { c.error('invalid_correlation', path, `${path}: у утверждения о корреляции должно быть происхождение { origin, ... }.`); return; }
  checkKeys(p, ['origin', 'source', 'locator', 'note'], path, c, 'invalid_correlation');
  if (!(CORRELATION_ORIGINS as readonly string[]).includes(p.origin as string)) c.error('invalid_correlation', `${path}.origin`, `${path}.origin: один из: ${CORRELATION_ORIGINS.join(', ')}.`);
  if (p.origin === 'stated_in_source' && p.source === undefined) c.error('invalid_correlation', `${path}.source`, `${path}: для «stated_in_source» источник обязателен.`);
  if (p.source !== undefined) checkSource(p.source, `${path}.source`, c);
  if (p.locator !== undefined) checkLocator(p.locator, `${path}.locator`, c);
  if (p.note !== undefined && !isNonEmptyString(p.note)) c.error('invalid_correlation', `${path}.note`, `${path}.note: ожидалась непустая строка.`);
}

/** The correlation statement: `unknown` (nothing is assumed), `independent` (only with its own provenance) or `declared` (a description or a matrix, with provenance).
 *  A matrix is checked STRUCTURALLY, exactly and without any tolerance (size, ids, symmetry, unit diagonal, |r| <= 1); that it is positive semi-definite is NOT checked and
 *  never claimed - an information note says so. Nothing is propagated. `observationIds`: the ids the matrix may refer to. */
export function collectCorrelation(statement: unknown, observationIds: ReadonlySet<string>, path: string, c: Collector): void {
  if (!isRecord(statement)) { c.error('invalid_correlation', path, `${path}: утверждение о корреляции обязательно; если ничего не известно, запишите { kind: 'unknown' } (независимость не предполагается).`); return; }
  if (statement.kind === 'unknown') { checkKeys(statement, ['kind'], path, c, 'invalid_correlation'); return; }
  if (statement.kind === 'independent') {
    checkKeys(statement, ['kind', 'provenance'], path, c, 'invalid_correlation');
    collectCorrelationProvenance(statement.provenance, `${path}.provenance`, c);
    return;
  }
  if (statement.kind !== 'declared') { c.error('invalid_correlation', `${path}.kind`, `${path}.kind: unknown, independent или declared.`); return; }
  checkKeys(statement, ['kind', 'info', 'provenance'], path, c, 'invalid_correlation');
  collectCorrelationProvenance(statement.provenance, `${path}.provenance`, c);
  const info = statement.info;
  if (!isRecord(info)) { c.error('invalid_correlation', `${path}.info`, `${path}.info: ожидалось описание или матрица.`); return; }
  if (info.form === 'description') {
    checkKeys(info, ['form', 'text'], `${path}.info`, c, 'invalid_correlation');
    if (!isNonEmptyString(info.text)) c.error('invalid_correlation', `${path}.info.text`, `${path}.info.text: ожидался непустой текст.`);
    return;
  }
  if (info.form !== 'matrix') { c.error('invalid_correlation', `${path}.info.form`, `${path}.info.form: description или matrix.`); return; }
  const p = `${path}.info`;
  checkKeys(info, ['form', 'ids', 'matrix'], p, c, 'invalid_correlation');
  const { ids, matrix } = info;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_CORRELATION_SIZE || !ids.every(isNonEmptyString)) { c.error('invalid_correlation', `${p}.ids`, `${p}.ids: ожидался список из 2…${MAX_CORRELATION_SIZE} идентификаторов наблюдений.`); return; }
  if (new Set(ids).size !== ids.length) c.error('invalid_correlation', `${p}.ids`, `${p}.ids: идентификаторы не должны повторяться.`);
  for (const id of ids) if (!observationIds.has(id)) c.error('invalid_correlation', `${p}.ids`, `${p}.ids: «${String(id)}» — не идентификатор наблюдения этой серии.`);
  if (!Array.isArray(matrix) || matrix.length !== ids.length || !matrix.every(row => Array.isArray(row) && row.length === ids.length)) { c.error('invalid_correlation', `${p}.matrix`, `${p}.matrix: ожидалась квадратная матрица ${ids.length}×${ids.length}.`); return; }
  let numeric = true;
  for (const row of matrix as unknown[][]) for (const x of row) if (typeof x !== 'number' || !Number.isFinite(x)) numeric = false;
  if (!numeric) { c.error('invalid_correlation', `${p}.matrix`, `${p}.matrix: элементы — конечные числа.`); return; }
  const m = matrix as number[][];
  for (let i = 0; i < m.length; i += 1) {
    if (m[i][i] !== 1) c.error('invalid_correlation', `${p}.matrix[${i}][${i}]`, `${p}.matrix: диагональный элемент должен быть ровно 1.`);
    for (let j = i + 1; j < m.length; j += 1) {
      if (m[i][j] !== m[j][i]) c.error('invalid_correlation', `${p}.matrix[${i}][${j}]`, `${p}.matrix: матрица не симметрична.`);
      if (Math.abs(m[i][j]) > 1) c.error('invalid_correlation', `${p}.matrix[${i}][${j}]`, `${p}.matrix: коэффициент корреляции по модулю больше 1.`);
    }
  }
  c.info('matrix_psd_not_checked', p, `${p}: матрица проверена только структурно; её неотрицательная определённость НЕ проверялась и не утверждается, неопределённость по ней не распространяется.`);
}

export interface ParsedEvent { readonly kind: string; readonly effect: EventEffect; readonly at?: Rational; readonly from?: Rational; readonly to?: Rational }
export interface ParsedApplicability {
  readonly events: readonly ParsedEvent[];
  readonly stability: 'not_stated' | 'stated_stable_over_range' | null;
  readonly phaseContext: 'within_stable_range' | 'metastable_beyond_range' | null;
  readonly historyState: string | null;
  readonly cycles: number | 'unknown' | null;
  readonly sweep: string | null;
}

/** Structure of the applicability statement and its internal consistency. Whether the OBSERVED temperatures contradict it is judged by the series validator. */
export function collectApplicability(a: unknown, path: string, c: Collector): ParsedApplicability {
  const empty: ParsedApplicability = { events: [], stability: null, phaseContext: null, historyState: null, cycles: null, sweep: null };
  if (!isRecord(a)) { c.error('invalid_applicability', path, `${path}: сведения о применимости обязательны (при отсутствии сведений: { events: [], stability: { kind: 'not_stated' } }).`); return empty; }
  checkKeys(a, ['phaseContext', 'events', 'stability', 'thermalHistory', 'sweepDirection'], path, c, 'invalid_applicability');
  let phaseContext: ParsedApplicability['phaseContext'] = null;
  if (a.phaseContext !== undefined) {
    const p = `${path}.phaseContext`;
    if (!isRecord(a.phaseContext)) c.error('invalid_applicability', p, `${p}: ожидался объект { relation, source? }.`);
    else {
      checkKeys(a.phaseContext, ['relation', 'source'], p, c, 'invalid_applicability');
      if (a.phaseContext.relation !== 'within_stable_range' && a.phaseContext.relation !== 'metastable_beyond_range') c.error('invalid_applicability', `${p}.relation`, `${p}.relation: within_stable_range или metastable_beyond_range.`);
      else phaseContext = a.phaseContext.relation;
      if (a.phaseContext.source !== undefined) checkSource(a.phaseContext.source, `${p}.source`, c);
    }
  }
  const events: ParsedEvent[] = [];
  if (!Array.isArray(a.events)) c.error('invalid_applicability', `${path}.events`, `${path}.events: ожидался список событий (возможно, пустой).`);
  else a.events.forEach((e, i) => {
    const p = `${path}.events[${i}]`;
    if (!isRecord(e)) { c.error('invalid_applicability', p, `${p}: ожидался объект события.`); return; }
    checkKeys(e, ['kind', 'temperature', 'range', 'effect', 'source'], p, c, 'invalid_applicability');
    if (!(EVENT_KINDS as readonly string[]).includes(e.kind as string)) c.error('invalid_applicability', `${p}.kind`, `${p}.kind: один из: ${EVENT_KINDS.join(', ')}.`);
    const effectOk = (EVENT_EFFECTS as readonly string[]).includes(e.effect as string);
    if (!effectOk) c.error('invalid_applicability', `${p}.effect`, `${p}.effect: один из: ${EVENT_EFFECTS.join(', ')}.`);
    if (e.source === undefined) c.error('invalid_applicability', `${p}.source`, `${p}.source: событие без источника не принимается.`);
    else checkSource(e.source, `${p}.source`, c);
    if ((e.temperature === undefined) === (e.range === undefined)) { c.error('invalid_applicability', p, `${p}: задайте температуру события (temperature) ИЛИ диапазон (range), одно из двух.`); return; }
    let at: Rational | undefined; let from: Rational | undefined; let to: Rational | undefined;
    if (e.temperature !== undefined) { if (checkQuantity(e.temperature, 'temperature', `${p}.temperature`, c) !== null) at = exactTemperature(e.temperature); }
    else if (!isRecord(e.range)) c.error('invalid_applicability', `${p}.range`, `${p}.range: ожидался объект { min, max }.`);
    else {
      checkKeys(e.range, ['min', 'max'], `${p}.range`, c, 'invalid_applicability');
      const lo = checkQuantity(e.range.min, 'temperature', `${p}.range.min`, c);
      const hi = checkQuantity(e.range.max, 'temperature', `${p}.range.max`, c);
      if (lo !== null && hi !== null) {
        from = exactTemperature(e.range.min); to = exactTemperature(e.range.max);
        if (exact.compare(from, to) >= 0) { c.error('invalid_applicability', `${p}.range`, `${p}.range: нижняя граница должна быть меньше верхней.`); from = undefined; to = undefined; }
      }
    }
    if (effectOk && (at !== undefined || from !== undefined)) events.push({ kind: String(e.kind), effect: e.effect as EventEffect, at, from, to });
  });
  let stability: ParsedApplicability['stability'] = null;
  if (!isRecord(a.stability)) c.error('invalid_applicability', `${path}.stability`, `${path}.stability: обязательно; при отсутствии сведений: { kind: 'not_stated' } (широкий диапазон температур не доказывает стабильность).`);
  else if (a.stability.kind === 'not_stated') { checkKeys(a.stability, ['kind'], `${path}.stability`, c, 'invalid_applicability'); stability = 'not_stated'; }
  else if (a.stability.kind === 'stated_stable_over_range') {
    checkKeys(a.stability, ['kind', 'source'], `${path}.stability`, c, 'invalid_applicability');
    if (a.stability.source === undefined) c.error('invalid_applicability', `${path}.stability.source`, `${path}.stability: заявление о стабильности без источника не принимается.`);
    else checkSource(a.stability.source, `${path}.stability.source`, c);
    stability = 'stated_stable_over_range';
  } else c.error('invalid_applicability', `${path}.stability.kind`, `${path}.stability.kind: not_stated или stated_stable_over_range.`);

  let historyState: string | null = null; let cycles: number | 'unknown' | null = null;
  if (a.thermalHistory !== undefined) {
    const p = `${path}.thermalHistory`;
    const h = a.thermalHistory;
    if (!isRecord(h)) c.error('invalid_applicability', p, `${p}: ожидался объект.`);
    else {
      checkKeys(h, ['state', 'annealing', 'cycles', 'note'], p, c, 'invalid_applicability');
      if (!(HISTORY_STATES as readonly string[]).includes(h.state as string)) c.error('invalid_applicability', `${p}.state`, `${p}.state: один из: ${HISTORY_STATES.join(', ')}.`);
      else historyState = h.state as string;
      if (h.cycles !== undefined) {
        if (h.cycles === 'unknown') cycles = 'unknown';
        else if (typeof h.cycles === 'number' && Number.isInteger(h.cycles) && h.cycles >= 0) cycles = h.cycles;
        else c.error('invalid_applicability', `${p}.cycles`, `${p}.cycles: целое число ≥ 0 или «unknown».`);
      }
      if (h.note !== undefined && !isNonEmptyString(h.note)) c.error('invalid_applicability', `${p}.note`, `${p}.note: ожидалась непустая строка.`);
      if (h.annealing !== undefined) {
        const q = `${p}.annealing`;
        if (!isRecord(h.annealing)) c.error('invalid_applicability', q, `${q}: ожидался объект.`);
        else {
          checkKeys(h.annealing, ['temperature', 'duration', 'atmosphere'], q, c, 'invalid_applicability');
          if (h.annealing.temperature !== undefined) checkQuantity(h.annealing.temperature, 'temperature', `${q}.temperature`, c);
          if (h.annealing.duration !== undefined) checkQuantity(h.annealing.duration, 'time', `${q}.duration`, c, 'positive');
          if (h.annealing.atmosphere !== undefined && !isNonEmptyString(h.annealing.atmosphere)) c.error('invalid_applicability', `${q}.atmosphere`, `${q}.atmosphere: ожидалась непустая строка.`);
        }
        // internal consistency of the history
        if (historyState === 'as_deposited') c.error('history_inconsistent', q, `${q}: у состояния «as_deposited» отжига быть не может.`);
      }
      if (historyState === 'as_deposited' && typeof cycles === 'number' && cycles > 0) c.error('history_inconsistent', `${p}.cycles`, `${p}: состояние «as_deposited» несовместимо с ненулевым числом термических циклов.`);
      if (historyState === 'cycled' && cycles === 0) c.error('history_inconsistent', `${p}.cycles`, `${p}: состояние «cycled» несовместимо с нулём термических циклов.`);
    }
  }
  let sweep: string | null = null;
  if (a.sweepDirection !== undefined) {
    if (!(SWEEP_DIRECTIONS as readonly string[]).includes(a.sweepDirection as string)) c.error('invalid_applicability', `${path}.sweepDirection`, `${path}.sweepDirection: один из: ${SWEEP_DIRECTIONS.join(', ')}.`);
    else sweep = a.sweepDirection as string;
  }
  return { events, stability, phaseContext, historyState, cycles, sweep };
}
