/** Validation of property SERIES - this block: `PointSeries` (observations of one experiment or data set). Storage and validation only: nothing is computed (no
 *  interpolation, extrapolation, averaging, propagation of uncertainty or selection), and a series is never a substitute for a scalar record or the other way round.
 *
 *  The validators return a ValidationReport (they never throw on damaged data); `createPropertySeries` returns a deep-frozen copy of a valid series. The M1.3.1 / M1.3.2
 *  validators are reused as they are: the variant by `collectVariant`, the conditions by `collectConditions` (for EVERY observation, not only the first), the uncertainty of
 *  every observation by `collectUncertainty`, the provenance by `collectProvenance`. */

import { deepFreeze, exact } from '@/physics';
import { checkKeys, checkQuantity, isIsoDate, isNonEmptyString } from './checks';
import { collectConditions } from './conditions';
import { Collector, isRecord, MaterialsError, type ValidationIssue, type ValidationReport } from './errors';
import { isMaterialId, parseMaterialId } from './ids';
import { stableRangeKelvin } from './phase';
import { getPropertyDefinition } from './property-definitions';
import { collectUncertainty } from './property-uncertainty';
import { collectProvenance } from './provenance';
import { checkLocator, collectApplicability, collectCorrelation, exactTemperature, OBSERVATION_ID, type ParsedApplicability } from './series-parts';
import { collectInterpolation, collectTableProvenance } from './series-table';
import { MAX_OBSERVATIONS, REPLICATE_RELATIONS, SERIES_KINDS, UNCERTAINTY_SCOPES, type PointSeries, type TabulatedSeries } from './series-types';
import { collectVariant } from './variant';
import type { MaterialKind, MaterialPhase } from './types';
import type { PropertyDefinition } from './property-types';

type Rational = exact.Rational;
const MAX_VERSION = 1000000;
const POINT_KEYS = ['id', 'kind', 'variant', 'property', 'commonConditions', 'uncertaintyScope', 'applicability', 'version', 'updatedAt', 'supersedes', 'provenance', 'points', 'correlation'] as const;
const TABLE_KEYS = ['id', 'kind', 'variant', 'property', 'commonConditions', 'uncertaintyScope', 'applicability', 'version', 'updatedAt', 'supersedes', 'tableProvenance', 'rows', 'correlation', 'interpolation'] as const;
const OBSERVATION_KEYS = ['id', 'temperature', 'value', 'uncertainty', 'replicate', 'run', 'locator'] as const;
const FILM_FORMS: readonly string[] = ['thin_film', 'coating_layer'];

/** The variant a series is checked against must itself be a structurally valid MaterialVariant (the M1.3.1 validator decides): a damaged variant gives errors and no context,
 *  so a broken form is never read as "bulk". `null` / `undefined` mean "no variant given" (then the film conditions and the phase are not checked, and not assumed). */
function variantContext(variant: unknown, kind: MaterialKind | null, path: string, c: Collector): Record<string, unknown> | undefined {
  if (variant === undefined || variant === null) return undefined;
  const local = new Collector();
  collectVariant(variant, kind, path, local);
  const report = local.report();
  for (const issue of report.issues) if (issue.severity === 'error') c.error(issue.code, issue.path, issue.message);
  if (!report.ok) { c.error('invalid_material', path, `${path}: вариант материала структурно некорректен — условия серии не проверяются относительно него (ошибки варианта перечислены выше).`); return undefined; }
  return variant as Record<string, unknown>;
}

const idsText = (ids: readonly string[]): string => (ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 5).join(', ')} … всего ${ids.length}`);

/** The one validator of a series of observations. A point series stores `points` (one provenance for the whole series); a tabulated series stores `rows` (a table-level
 *  provenance mode plus an interpolation statement). Observations, units, conditions, uncertainties, correlation, applicability and versions are checked by the SAME code. */
function collectObservationSeries(series: Record<string, unknown>, variant: Record<string, unknown> | undefined, path: string, c: Collector, table: boolean): void {
  const rowsKey = table ? 'rows' : 'points';
  checkKeys(series, table ? TABLE_KEYS : POINT_KEYS, path, c, 'invalid_series');
  if (!isMaterialId(series.id)) c.error('invalid_id', `${path}.id`, `${path}.id: идентификатор серии — <ref|user|fixture>:<слаг>.`);
  if (!isMaterialId(series.variant)) c.error('invalid_id', `${path}.variant`, `${path}.variant: серия ссылается на вариант материала по идентификатору.`);
  if (variant && typeof series.variant === 'string' && variant.id !== series.variant) c.error('missing_reference', `${path}.variant`, `${path}.variant: переданный вариант («${String(variant.id)}») — не тот, на который ссылается серия («${series.variant}»).`);

  const definition: PropertyDefinition | undefined = getPropertyDefinition(series.property);
  if (!definition) c.error('unknown_property', `${path}.property`, `${path}.property: свойство «${String(series.property)}» не определено.`);
  else if (!definition.allowedConditions.includes('temperature') && !definition.allowedConditions.includes('temperatureRange')) {
    c.error('series_property_unsupported', `${path}.property`, `${path}.property: свойство «${definition.nameRu}» не зависит от температуры в этой модели — серия по температуре для него не определена.`);
  }

  // ---- observations ----
  const obsPath = `${path}.${rowsKey}`;
  const points = series[rowsKey];
  const rowStatuses: (string | null)[] = [];
  const rowProvenance = table && isRecord(series.tableProvenance) ? series.tableProvenance.mode : undefined;
  const observationIds = new Set<string>();
  const valid: { index: number; id: string; t: Rational; tKey: string; group?: string }[] = [];
  if (!Array.isArray(points)) c.error('invalid_series', obsPath, `${obsPath}: ожидался список наблюдений.`);
  else {
    if (points.length < 2) c.error('series_too_short', obsPath, `${obsPath}: в серии не менее двух наблюдений (одно значение — это скалярная запись).`);
    if (points.length > MAX_OBSERVATIONS) c.error('series_too_long', obsPath, `${obsPath}: наблюдений больше технического предела ${MAX_OBSERVATIONS}.`);
    const identity = new Map<string, string>();
    const replicateGroups = new Map<string, number[]>();
    const validByIndex = new Map<number, { tKey: string }>();
    let replicateOf: string | undefined;
    const units = new Set<string>();
    points.slice(0, MAX_OBSERVATIONS).forEach((obs, i) => {
      const p = `${obsPath}[${i}]`;
      replicateOf = undefined;
      if (!isRecord(obs)) { c.error('invalid_observation', p, `${p}: ожидался объект наблюдения.`); return; }
      checkKeys(obs, table ? [...OBSERVATION_KEYS, 'provenance'] : OBSERVATION_KEYS, p, c, 'invalid_observation');
      if (table) {
        if (rowProvenance === 'per_row') rowStatuses.push(obs.provenance === undefined ? (c.error('invalid_table_provenance', `${p}.provenance`, `${p}.provenance: в режиме per_row у каждой строки своё происхождение; источник не наследуется от таблицы молча.`), null) : collectProvenance(obs.provenance, `${p}.provenance`, c));
        else if (rowProvenance === 'single_source' && obs.provenance !== undefined) c.error('invalid_table_provenance', `${p}.provenance`, `${p}.provenance: в режиме single_source происхождение задано один раз для всей таблицы — у строки своего происхождения быть не должно.`);
      }
      if (typeof obs.id !== 'string' || !OBSERVATION_ID.test(obs.id) || obs.id.length > 64) c.error('invalid_observation', `${p}.id`, `${p}.id: идентификатор наблюдения — строчные латинские буквы, цифры, «-», «_», «.» (до 64 символов).`);
      else if (observationIds.has(obs.id)) c.error('duplicate_observation_id', `${p}.id`, `${p}.id: идентификатор наблюдения «${obs.id}» повторяется — это одно и то же наблюдение, а не повтор.`);
      else observationIds.add(obs.id);
      const temperatureOk = checkQuantity(obs.temperature, 'temperature', `${p}.temperature`, c) !== null;   // an absolute temperature: K or °C, never an interval
      const t = temperatureOk ? exactTemperature(obs.temperature) : undefined;
      if (isRecord(obs.value) && obs.value.type === 'scalar') {
        checkKeys(obs.value, ['type', 'value', 'unit'], `${p}.value`, c, 'invalid_observation');
        if (definition) {
          const si = checkQuantity({ value: obs.value.value, unit: obs.value.unit }, definition.kind, `${p}.value`, c);
          if (si !== null) units.add(String(obs.value.unit));
          collectUncertainty(obs.uncertainty, si !== null ? { value: obs.value.value as number, unit: String(obs.value.unit) } : null, definition.kind, `${p}.uncertainty`, c);
        } else collectUncertainty(obs.uncertainty, null, null, `${p}.uncertainty`, c);
      } else {
        c.error('invalid_observation', `${p}.value`, `${p}.value: ожидался объект { type: 'scalar', value, unit }.`);
        collectUncertainty(obs.uncertainty, null, null, `${p}.uncertainty`, c);
      }
      // run and locator: the declared origin of the observation inside its data set
      if (obs.run !== undefined && !isNonEmptyString(obs.run)) c.error('invalid_observation', `${p}.run`, `${p}.run: ожидалась непустая строка.`);
      const locatorOk = obs.locator === undefined ? true : checkLocator(obs.locator, `${p}.locator`, c);
      if (obs.replicate !== undefined) {
        const r = obs.replicate;
        if (!isRecord(r)) c.error('invalid_replicate', `${p}.replicate`, `${p}.replicate: ожидался объект { group, relation }.`);
        else {
          checkKeys(r, ['group', 'relation'], `${p}.replicate`, c, 'invalid_replicate');
          if (!isNonEmptyString(r.group)) c.error('invalid_replicate', `${p}.replicate.group`, `${p}.replicate.group: ожидалась непустая строка.`);
          else { const list = replicateGroups.get(r.group); if (list) list.push(i); else replicateGroups.set(r.group, [i]); replicateOf = r.group; }
          if (!(REPLICATE_RELATIONS as readonly string[]).includes(r.relation as string)) c.error('invalid_replicate', `${p}.replicate.relation`, `${p}.replicate.relation: один из: ${REPLICATE_RELATIONS.join(', ')} (повтор на одном образце — не независимое измерение).`);
        }
      }
      if (typeof obs.id === 'string' && t !== undefined) { valid.push({ index: i, id: obs.id, t, tKey: `${t.n}/${t.d}`, group: replicateOf }); validByIndex.set(i, { tKey: `${t.n}/${t.d}` }); }
      // Identity is the `id` alone. The same declared origin (run AND locator) at the same temperature is only SUSPICIOUS - a repeat after a cycle, a second pass over the
      // same row of a source, two samples of one run - so it is a warning that asks for a look, never an error, and the observations are kept.
      if (t !== undefined && isNonEmptyString(obs.run) && obs.locator !== undefined && locatorOk) {
        const key = JSON.stringify([obs.run, Object.entries(obs.locator as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)), `${t.n}/${t.d}`]);
        const earlier = identity.get(key);
        if (earlier !== undefined) c.warning('possible_duplicate_observation', `${p}`, `${p}: тот же прогон («${String(obs.run)}»), то же место в источнике и та же температура, что у наблюдения «${earlier}» — возможно, запись введена дважды; наблюдения сохранены как разные (у них разные идентификаторы), проверьте.`);
        else identity.set(key, typeof obs.id === 'string' ? obs.id : `#${i}`);
      }
    });
    if (units.size > 1) c.error('mixed_units', obsPath, `${obsPath}: значения заданы в разных единицах (${[...units].join(', ')}) — в серии одна единица значения (температуры могут быть в K или °C).`);
    // repeats: stored as they are, never averaged, no independence required
    const byTemperature = new Map<string, { id: string; group?: string }[]>();
    for (const o of valid) { const list = byTemperature.get(o.tKey); if (list) list.push({ id: o.id, group: o.group }); else byTemperature.set(o.tKey, [{ id: o.id, group: o.group }]); }
    for (const [group, indexes] of replicateGroups) {
      const keys = new Set<string>();
      for (const i of indexes) { const v = validByIndex.get(i); if (v) keys.add(v.tKey); }
      if (keys.size > 1) c.error('invalid_replicate', obsPath, `${obsPath}: группа повторов «${group}» объединяет наблюдения при разных температурах — повторы относятся к одной температуре.`);
      if (indexes.length === 1) c.warning('invalid_replicate', obsPath, `${obsPath}: группа повторов «${group}» состоит из одного наблюдения.`);
    }
    const undeclared = [...byTemperature.values()].filter(list => list.length > 1 && !(list[0].group !== undefined && list.every(x => x.group === list[0].group)));
    if (undeclared.length > 0) c.info('repeats_undeclared', obsPath, `${obsPath}: при ${undeclared.length} температур(е) несколько наблюдений без общего объявления повторов (${undeclared.slice(0, 3).map(list => idsText(list.map(x => x.id))).join('; ')}); они сохраняются как есть, не усредняются и не считаются независимыми.`);
  }

  // ---- common conditions: the temperature is the axis, everything else is common to ALL the observations ----
  const cond = series.commonConditions;
  const filmVariant = variant !== undefined && isRecord(variant.form) && FILM_FORMS.includes(String(variant.form.kind));
  if (!isRecord(cond)) c.error('invalid_condition', `${path}.commonConditions`, `${path}.commonConditions: ожидался объект условий (без температуры: температура — ось серии).`);
  else {
    for (const key of ['temperature', 'temperatureRange'] as const) if (cond[key] !== undefined) c.error('invalid_condition', `${path}.commonConditions.${key}`, `${path}.commonConditions.${key}: температура задаётся осью (наблюдениями), а не общими условиями.`);
    if (definition && valid.length > 0) {
      // the M1.3.2 conditions validator runs for EVERY observation (the observation's temperature is the temperature condition); the findings are grouped, not repeated
      const found = new Map<string, { issue: ValidationIssue; ids: string[] }>();
      for (const o of valid) {
        const local = new Collector();
        const { temperature: _t, temperatureRange: _r, ...common } = cond as Record<string, unknown>;
        void _t; void _r;
        const obs = (points as unknown[])[o.index] as Record<string, unknown>;
        collectConditions(definition, { ...common, temperature: obs.temperature }, variant, `${path}.commonConditions`, local);
        for (const issue of local.report().issues) {
          if (issue.code === 'condition_outside_phase_range') continue;             // the phase range is judged below, with the declared phase context
          const key = `${issue.severity}|${issue.code}|${issue.message}`;
          const entry = found.get(key) ?? { issue, ids: [] };
          entry.ids.push(o.id);
          found.set(key, entry);
        }
      }
      for (const { issue, ids } of found.values()) {
        const where = ids.length === valid.length ? 'все наблюдения' : `наблюдения: ${idsText(ids)}`;
        const message = `${issue.message} (${where})`;
        if (issue.severity === 'error') c.error(issue.code, issue.path, message);
        else if (issue.severity === 'warning') c.warning(issue.code, issue.path, message);
        else c.info(issue.code, issue.path, message);
      }
    }
  }

  // ---- uncertainty scope, correlation, provenance, version ----
  if (!(UNCERTAINTY_SCOPES as readonly string[]).includes(series.uncertaintyScope as string)) c.error('invalid_series', `${path}.uncertaintyScope`, `${path}.uncertaintyScope: один из: ${UNCERTAINTY_SCOPES.join(', ')}.`);
  else if (series.uncertaintyScope === 'fit_coefficients' || series.uncertaintyScope === 'fit_residual') c.error('invalid_series', `${path}.uncertaintyScope`, `${path}.uncertaintyScope: для серии наблюдений допустимы per_observation и unspecified; fit_* относятся к аналитическим зависимостям.`);
  collectCorrelation(series.correlation, observationIds, `${path}.correlation`, c);
  let status: string | null = null;
  let statuses: (string | null)[] = [];
  if (table) {
    const parsed = collectTableProvenance(series.tableProvenance, `${path}.tableProvenance`, c);
    statuses = parsed.single !== undefined ? [parsed.single] : rowStatuses;
  } else { status = collectProvenance(series.provenance, `${path}.provenance`, c); statuses = [status]; }
  if (typeof series.version !== 'number' || !Number.isInteger(series.version) || series.version < 1 || series.version > MAX_VERSION) c.error('invalid_version', `${path}.version`, `${path}.version: версия серии — целое число от 1.`);
  if (!isIsoDate(series.updatedAt)) c.error('invalid_version', `${path}.updatedAt`, `${path}.updatedAt: дата актуализации — ГГГГ-ММ-ДД.`);
  if (series.supersedes !== undefined) {
    if (!isMaterialId(series.supersedes)) c.error('supersedes_invalid', `${path}.supersedes`, `${path}.supersedes: идентификатор заменяемой серии некорректен.`);
    else if (series.supersedes === series.id) c.error('supersedes_invalid', `${path}.supersedes`, `${path}.supersedes: серия не может заменять саму себя.`);
  }
  const ns = parseMaterialId(series.id)?.namespace;
  if (ns === 'user' && statuses.some(x => x !== null && x !== 'user_input')) c.error('namespace_mismatch', `${path}.id`, `${path}.id: серия пользователя (user:) должна иметь статус user_input.`);
  if (ns === 'ref' && statuses.includes('user_input')) c.error('namespace_mismatch', `${path}.id`, `${path}.id: справочная серия (ref:) не может иметь статус user_input — данные пользователя хранятся отдельно (user:).`);

  // ---- applicability and its relation to the observed temperatures ----
  const app = collectApplicability(series.applicability, `${path}.applicability`, c);
  diagnose(series, app, valid, variant, filmVariant, path, c, rowsKey);
  if (table) collectInterpolation(series.interpolation, app.events, valid.map(v => v.t), `${path}.interpolation`, c);
}


/** Diagnostics that relate the declared applicability to the observed temperatures and to the variant. Missing information is a warning or an information note, never a
 *  proof of stability; an observation outside a stated phase range is NOT rejected on that ground alone (its nature is unknown): it is a warning of possible incomparability. */
function diagnose(series: Record<string, unknown>, app: ParsedApplicability, valid: { index: number; id: string; t: Rational }[], variant: Record<string, unknown> | undefined, film: boolean, path: string, c: Collector, rowsKey: string): void {
  const ordered = [...valid].sort((a, b) => a.index - b.index);
  const lowest = valid.length > 0 ? valid.reduce((m, o) => (exact.compare(o.t, m) < 0 ? o.t : m), valid[0].t) : undefined;
  const highest = valid.length > 0 ? valid.reduce((m, o) => (exact.compare(o.t, m) > 0 ? o.t : m), valid[0].t) : undefined;
  const k = (r: Rational): number => exact.rationalToNumber(r);

  // sweep direction against the stored (measurement) order
  let ups = 0; let downs = 0; let firstUp = ''; let firstDown = '';
  for (let i = 1; i < ordered.length; i += 1) {
    const cmp = exact.compare(ordered[i].t, ordered[i - 1].t);
    if (cmp > 0) { ups += 1; if (!firstUp) firstUp = `${ordered[i - 1].id} → ${ordered[i].id}`; }
    if (cmp < 0) { downs += 1; if (!firstDown) firstDown = `${ordered[i - 1].id} → ${ordered[i].id}`; }
  }
  if (app.sweep === 'heating' && downs > 0) c.error('sweep_inconsistent', `${path}.applicability.sweepDirection`, `${path}.applicability.sweepDirection: объявлен нагрев, но в порядке измерения температура убывает (${firstDown}); порядок наблюдений не пересортировывается.`);
  if (app.sweep === 'cooling' && ups > 0) c.error('sweep_inconsistent', `${path}.applicability.sweepDirection`, `${path}.applicability.sweepDirection: объявлено охлаждение, но в порядке измерения температура растёт (${firstUp}); порядок наблюдений не пересортировывается.`);
  if (ups > 0 && downs > 0 && (app.sweep === null || app.sweep === 'unknown')) c.warning('sweep_not_described', `${path}.applicability.sweepDirection`, `${path}.applicability.sweepDirection: порядок измерения содержит и нагрев, и охлаждение, а ход температуры не описан (укажите mixed или разметьте события) — наблюдения могут быть несопоставимы.`);
  if (ups > 0 && downs > 0) c.warning('potential_incomparability', `${path}.${rowsKey}`, `${path}.${rowsKey}: наблюдения получены и при росте, и при убывании температуры — возможна несопоставимость (гистерезис, необратимые изменения); порядок сохранён как есть.`);

  // events against the observed range
  for (const e of app.events) {
    const from = e.at ?? e.from; const to = e.at ?? e.to;
    if (from === undefined || to === undefined || lowest === undefined || highest === undefined) continue;
    const inside = exact.compare(to, lowest) >= 0 && exact.compare(from, highest) <= 0;
    if (e.effect === 'range_ends_before' && exact.compare(highest, from) >= 0) c.error('event_contradicts_domain', `${path}.applicability.events`, `${path}.applicability.events: событие «${e.kind}» (≈ ${k(from)} K) объявлено пределом применимости, а наблюдения доходят до ${k(highest)} K — противоречие внутри самой серии.`);
    if (inside && e.effect === 'discontinuity') c.info('interval_crosses_event', `${path}.applicability.events`, `${path}.applicability.events: область наблюдений пересекает событие «${e.kind}» с разрывом свойства; значения по обе стороны относятся к разным состояниям.`);
    if (inside && e.effect === 'irreversible_change') c.warning('irreversible_change_in_domain', `${path}.applicability.events`, `${path}.applicability.events: в области наблюдений происходит необратимое изменение («${e.kind}»); наблюдения до и после него несопоставимы.`);
    if (inside && e.effect === 'unknown') c.warning('event_effect_unknown', `${path}.applicability.events`, `${path}.applicability.events: событие «${e.kind}» в области наблюдений, его влияние на данные не указано.`);
    if (inside && e.effect !== 'range_ends_before') c.warning('potential_incomparability', `${path}.applicability.events`, `${path}.applicability.events: событие «${e.kind}» внутри области наблюдений — возможна несопоставимость наблюдений по разные стороны от него.`);
  }

  // stability and thermal history: silence is not stability
  if (app.stability === 'not_stated') {
    if (film) c.warning('stability_not_stated', `${path}.applicability.stability`, `${path}.applicability.stability: стабильность плёнки (или слоя покрытия) в диапазоне температур не заявлена — отсутствие записи о событиях не доказывает стабильности.`);
    else c.info('stability_not_stated', `${path}.applicability.stability`, `${path}.applicability.stability: стабильность материала в диапазоне температур не заявлена.`);
  }
  if (film) {
    if (series.applicability && isRecord(series.applicability) && series.applicability.thermalHistory === undefined) c.warning('thermal_history_not_stated', `${path}.applicability.thermalHistory`, `${path}.applicability.thermalHistory: история термообработки плёнки (как осаждена, отжиг, число циклов) не указана — значения могут зависеть от неё и от необратимых изменений.`);
    if (app.sweep === null) c.warning('sweep_direction_not_stated', `${path}.applicability.sweepDirection`, `${path}.applicability.sweepDirection: направление изменения температуры не указано (нагрев, охлаждение, смешанный ход).`);
  }

  // the phase range of the variant: an observation outside it is a warning of possible incomparability, not a rejection
  const phase = variant && isRecord(variant.phase) ? variant.phase as unknown as MaterialPhase : undefined;
  if (phase && lowest !== undefined && highest !== undefined) {
    const range = stableRangeKelvin(phase);
    if (!phase.stableRange || range === null) c.info('phase_range_not_stated', `${path}.applicability.phaseContext`, `${path}.applicability.phaseContext: область стабильности фазы варианта не задана — соответствие наблюдений фазе не проверялось.`);
    else {
      const outside = ordered.filter(o => k(o.t) < range.min || k(o.t) > range.max).map(o => o.id);
      if (outside.length > 0) {
        const sourced = phase.source !== undefined ? 'заявление о фазе подтверждено источником' : 'заявление о фазе без источника';
        if (app.phaseContext === 'metastable_beyond_range') c.info('beyond_stable_range', `${path}.applicability.phaseContext`, `${path}.applicability.phaseContext: наблюдения (${idsText(outside)}) вне заявленной области стабильности фазы [${range.min}; ${range.max}] K; серия объявляет фазу метастабильной за её пределами.`);
        else c.warning('beyond_stable_range', `${path}.applicability.phaseContext`, `${path}.applicability.phaseContext: наблюдения (${idsText(outside)}) вне заявленной области стабильности фазы [${range.min}; ${range.max}] K (${sourced}); природа расхождения не указана, серия не отклоняется, но наблюдения могут быть несопоставимы со свойствами этой фазы.`);
      } else if (app.phaseContext === 'metastable_beyond_range') c.warning('beyond_stable_range', `${path}.applicability.phaseContext`, `${path}.applicability.phaseContext: объявлена метастабильность за пределами области стабильности, но все наблюдения внутри неё.`);
    }
  }
}

/** Validates one series. `variant` is the MaterialVariant it refers to, if known: with it the film conditions and the phase range are checked against the variant. */
export function validatePropertySeries(series: unknown, variant?: unknown): ValidationReport {
  const c = new Collector();
  const context = variantContext(variant, null, 'variant', c);
  collectSeries(series, context, 'series', c);
  return c.report();
}

function collectSeries(series: unknown, variant: Record<string, unknown> | undefined, path: string, c: Collector): void {
  if (!isRecord(series)) { c.error('invalid_series', path, `${path}: ожидался объект серии.`); return; }
  if (!(SERIES_KINDS as readonly string[]).includes(series.kind as string)) { c.error('invalid_series', `${path}.kind`, `${path}.kind: вид серии — один из: ${SERIES_KINDS.join(', ')}.`); return; }
  if (series.kind !== 'points' && series.kind !== 'table') { c.error('unsupported_series_kind', `${path}.kind`, `${path}.kind: вид «${String(series.kind)}» объявлен в контракте, но ещё не реализован; сейчас поддерживаются серии наблюдений (points) и таблицы (table).`); return; }
  collectObservationSeries(series, variant, path, c, series.kind === 'table');
}

/** A validated, deep-frozen copy. Throws MaterialsError with ALL the issues when the series is invalid. */
export function createPropertySeries<T extends PointSeries | TabulatedSeries>(input: T, variant?: unknown): T {
  const report = validatePropertySeries(input, variant);
  const errors = report.issues.filter(i => i.severity === 'error');
  if (errors.length > 0) throw new MaterialsError('invalid_series', `Серия некорректна: ${errors.length} ошибок. Первая — ${errors[0].path}: ${errors[0].message}`, report.issues);
  return deepFreeze(structuredClone(input));
}

/** Validates a SET of series against the variants of a catalog (and, if given, the property records): each series is checked against ITS variant, ids are unique and
 *  share one id space with the records, a shipped series cannot stand on a variant of another namespace, and a replacement (`supersedes`) is a series of the same kind, variant
 *  and property with a higher version, one replacement per series, no cycles. Series are never merged, selected or compared here. */
export function validatePropertySeriesSet(seriesList: unknown, catalog: unknown, records?: unknown): ValidationReport {
  const c = new Collector();
  if (!Array.isArray(seriesList)) { c.error('invalid_series', 'series', 'series: ожидался список серий.'); return c.report(); }
  const variants = new Map<string, { index: number; variant: unknown }[]>();
  if (isRecord(catalog) && Array.isArray(catalog.variants)) catalog.variants.forEach((v, index) => { if (isRecord(v) && typeof v.id === 'string') variants.set(v.id, [...(variants.get(v.id) ?? []), { index, variant: v }]); });
  const resolved = new Map<string, Record<string, unknown> | undefined>();
  const recordIds = new Set<string>(Array.isArray(records) ? records.flatMap(r => (isRecord(r) && typeof r.id === 'string' ? [r.id] : [])) : []);
  const byId = new Map<string, Record<string, unknown>>();
  seriesList.forEach((series, i) => {
    const path = `series[${i}]`;
    let variant: Record<string, unknown> | undefined;
    if (isRecord(series) && typeof series.variant === 'string') {
      const found = variants.get(series.variant);
      if (!found) c.error('missing_reference', `${path}.variant`, `${path}.variant: вариант «${series.variant}» не найден в каталоге.`);
      else if (found.length > 1) c.error('duplicate_id', `${path}.variant`, `${path}.variant: идентификатор варианта «${series.variant}» встречается в каталоге ${found.length} раза — ссылка неоднозначна, вариант не выбирается.`);
      else if (resolved.has(series.variant)) variant = resolved.get(series.variant);
      else {
        const raw = found[0].variant;
        variant = variantContext(raw, null, `catalog.variants[${found[0].index}]`, c);
        resolved.set(series.variant, variant);
      }
    }
    collectSeries(series, variant, path, c);
    if (!isRecord(series) || typeof series.id !== 'string') return;
    if (byId.has(series.id)) { c.error('duplicate_id', `${path}.id`, `${path}.id: серия «${series.id}» уже есть в наборе.`); return; }
    if (recordIds.has(series.id)) c.error('duplicate_id', `${path}.id`, `${path}.id: идентификатор «${series.id}» уже занят записью свойства — у записей и серий одно пространство идентификаторов.`);
    byId.set(series.id, series);
    const seriesNs = parseMaterialId(series.id)?.namespace;
    const variantNs = typeof series.variant === 'string' ? parseMaterialId(series.variant)?.namespace : undefined;
    if (seriesNs && variantNs && seriesNs !== 'user' && variantNs !== seriesNs) c.error('namespace_mismatch', `${path}.variant`, `${path}.variant: серия пространства «${seriesNs}:» не может ссылаться на вариант пространства «${variantNs}:».`);
  });
  const replacedBy = new Map<string, string[]>();
  seriesList.forEach((series, i) => {
    if (!isRecord(series) || typeof series.supersedes !== 'string' || typeof series.id !== 'string') return;
    const path = `series[${i}].supersedes`;
    replacedBy.set(series.supersedes, [...(replacedBy.get(series.supersedes) ?? []), series.id]);
    const target = byId.get(series.supersedes);
    if (!target) { c.error('supersedes_invalid', path, `${path}: заменяемая серия «${series.supersedes}» не найдена в наборе.`); return; }
    if (target.variant !== series.variant || target.property !== series.property) c.error('supersedes_invalid', path, `${path}: заменять можно только серию того же варианта и того же свойства.`);
    if (target.kind !== series.kind) c.error('supersedes_invalid', path, `${path}: заменять можно только серию того же вида («${String(target.kind)}» ≠ «${String(series.kind)}»).`);
    if (typeof series.version === 'number' && typeof target.version === 'number' && series.version <= target.version) c.error('supersedes_invalid', path, `${path}: версия заменяющей серии (${series.version}) должна быть больше версии заменяемой (${target.version}).`);
  });
  for (const [target, replacements] of replacedBy) if (replacements.length > 1) c.error('supersession_fork', `series[${target}]`, `Серия «${target}» заменяется несколькими сериями (${replacements.join(', ')}): «актуальная» серия была бы неоднозначной.`);
  for (const start of [...replacedBy.keys()]) {
    const seen = new Set<string>([start]);
    let node = byId.get(start)?.supersedes;
    while (typeof node === 'string' && byId.has(node)) { if (node === start) { c.error('supersedes_invalid', `series[${start}]`, `Цикл замещения серий через «${start}».`); break; } if (seen.has(node)) break; seen.add(node); node = byId.get(node)?.supersedes; }
  }
  return c.report();
}
