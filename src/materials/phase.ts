/** Validation of the PHASE (aggregate state + crystalline order + crystal structure) and of the STRUCTURE (microstructure: grain size, texture, porosity). Kept apart on
 *  purpose: an aggregate state is not a crystalline order, and neither is a microstructure. The absence of data is never turned into an answer: `order: 'unknown'` is
 *  explicit, and the absence of amorphousness data is not evidence of crystallinity (nor the reverse). */

import { convert, PhysicsError } from '@/physics';
import { checkKeys, checkQuantity, checkSource, isNonEmptyString } from './checks';
import { Collector, isRecord } from './errors';
import { AGGREGATE_STATES, LATTICE_SYSTEMS, STRUCTURAL_ORDERS, type MaterialPhase } from './types';

const CRYSTALLINE: readonly string[] = ['crystalline', 'partially_crystalline'];

export function validatePhase(phase: unknown, path: string, c: Collector): void {
  if (!isRecord(phase)) { c.error('invalid_phase', path, `${path}: ожидался объект фазы.`); return; }
  checkKeys(phase, ['state', 'order', 'phaseName', 'crystalStructure', 'stableRange', 'source'], path, c, 'invalid_phase');
  const stateOk = (AGGREGATE_STATES as readonly string[]).includes(phase.state as string);
  const orderOk = (STRUCTURAL_ORDERS as readonly string[]).includes(phase.order as string);
  if (!stateOk) c.error('invalid_phase', `${path}.state`, `${path}.state: агрегатное состояние должно быть одним из: ${AGGREGATE_STATES.join(', ')}.`);
  if (!orderOk) c.error('invalid_phase', `${path}.order`, `${path}.order: порядок должен быть задан явно, одним из: ${STRUCTURAL_ORDERS.join(', ')} («unknown» — если сведений нет).`);
  if (stateOk && orderOk) {
    if (phase.state === 'solid' && phase.order === 'not_applicable') c.error('state_order_mismatch', `${path}.order`, `${path}.order: для твёрдого тела «not_applicable» недопустимо — укажите crystalline, partially_crystalline, amorphous или unknown.`);
    if (phase.state !== 'solid' && phase.order !== 'not_applicable') c.error('state_order_mismatch', `${path}.order`, `${path}.order: для состояния «${String(phase.state)}» кристаллический порядок неприменим — ожидалось «not_applicable».`);
  }
  if (phase.phaseName !== undefined && !isNonEmptyString(phase.phaseName)) c.error('invalid_phase', `${path}.phaseName`, `${path}.phaseName: ожидалась непустая строка.`);
  if (phase.crystalStructure !== undefined) {
    const p = `${path}.crystalStructure`;
    if (orderOk && !CRYSTALLINE.includes(phase.order as string)) c.error('crystal_structure_not_applicable', p, `${p}: кристаллическая структура задаётся только при order = crystalline или partially_crystalline (сейчас «${String(phase.order)}»).`);
    if (!isRecord(phase.crystalStructure)) c.error('invalid_phase', p, `${p}: ожидался объект.`);
    else {
      const cs = phase.crystalStructure;
      checkKeys(cs, ['latticeSystem', 'spaceGroup', 'prototype'], p, c, 'invalid_phase');
      if (cs.latticeSystem === undefined && cs.spaceGroup === undefined && cs.prototype === undefined) c.error('invalid_phase', p, `${p}: пустое описание структуры — укажите хотя бы одно поле или уберите объект.`);
      if (cs.latticeSystem !== undefined && !(LATTICE_SYSTEMS as readonly string[]).includes(cs.latticeSystem as string)) c.error('invalid_phase', `${p}.latticeSystem`, `${p}.latticeSystem: допустимо одно из: ${LATTICE_SYSTEMS.join(', ')}.`);
      for (const f of ['spaceGroup', 'prototype'] as const) if (cs[f] !== undefined && !isNonEmptyString(cs[f])) c.error('invalid_phase', `${p}.${f}`, `${p}.${f}: ожидалась непустая строка.`);
    }
  }
  if (phase.stableRange !== undefined) {
    const p = `${path}.stableRange`;
    if (!isRecord(phase.stableRange)) c.error('invalid_phase', p, `${p}: ожидался объект { min, max }.`);
    else {
      checkKeys(phase.stableRange, ['min', 'max'], p, c, 'invalid_phase');
      const lo = checkQuantity(phase.stableRange.min, 'temperature', `${p}.min`, c);
      const hi = checkQuantity(phase.stableRange.max, 'temperature', `${p}.max`, c);
      if (lo !== null && hi !== null && !(lo < hi)) c.error('invalid_phase', p, `${p}: нижняя граница температуры должна быть меньше верхней.`);
    }
  }
  if (phase.source !== undefined) checkSource(phase.source, `${path}.source`, c);
  if (phase.state === 'solid' && phase.order === 'unknown') c.info('order_unknown', `${path}.order`, `${path}.order: кристаллический порядок не известен (это не означает ни кристалличность, ни аморфность).`);
}

/** `phase` is the variant's phase if it has one (composites and coating systems have none). */
export function validateStructure(structure: unknown, phase: MaterialPhase | undefined, path: string, c: Collector): void {
  if (!isRecord(structure)) { c.error('invalid_structure', path, `${path}: ожидался объект структуры.`); return; }
  checkKeys(structure, ['grainSize', 'texture', 'porosity', 'features', 'source'], path, c, 'invalid_structure');
  const order = phase?.order;
  const state = phase?.state;
  if (state !== undefined && state !== 'solid') c.error('structure_not_applicable', path, `${path}: микроструктура описывается только для твёрдого тела (сейчас «${state}»).`);

  if (structure.grainSize !== undefined) {
    const p = `${path}.grainSize`;
    if (!isRecord(structure.grainSize)) c.error('invalid_structure', p, `${p}: ожидался объект { size, definition? }.`);
    else {
      checkKeys(structure.grainSize, ['size', 'definition'], p, c, 'invalid_structure');
      checkQuantity(structure.grainSize.size, 'length', `${p}.size`, c, 'positive');
      if (structure.grainSize.definition !== undefined && !isNonEmptyString(structure.grainSize.definition)) c.error('invalid_structure', `${p}.definition`, `${p}.definition: ожидалась непустая строка.`);
    }
    if (order === 'amorphous' || order === 'not_applicable') c.error('structure_not_applicable', p, `${p}: размер зерна неприменим к ${order === 'amorphous' ? 'аморфному материалу' : 'не твёрдому состоянию'}.`);
    else if (order === 'unknown') c.warning('structure_not_applicable', p, `${p}: размер зерна задан при неизвестном кристаллическом порядке — порядок следует уточнить.`);
  }
  if (structure.texture !== undefined) {
    const p = `${path}.texture`;
    if (!isRecord(structure.texture) || !isNonEmptyString(structure.texture.description)) c.error('invalid_structure', p, `${p}: ожидался объект { description } с непустым описанием.`);
    else checkKeys(structure.texture, ['description'], p, c, 'invalid_structure');
    if (order === 'amorphous' || order === 'not_applicable') c.error('structure_not_applicable', p, `${p}: текстура неприменима к ${order === 'amorphous' ? 'аморфному материалу' : 'не твёрдому состоянию'}.`);
  }
  if (structure.porosity !== undefined) {
    const p = `${path}.porosity`;
    const fraction = checkQuantity(structure.porosity, 'dimensionless', p, c, 'nonnegative');
    if (fraction !== null && !(fraction < 1)) c.error('invalid_structure', p, `${p}: пористость должна быть меньше 1 (доля пустот).`);
  }
  if (structure.features !== undefined) {
    const p = `${path}.features`;
    if (!Array.isArray(structure.features) || structure.features.length === 0 || !structure.features.every(isNonEmptyString)) c.error('invalid_structure', p, `${p}: ожидался непустой список непустых строк.`);
    else if (new Set(structure.features.map(f => f.trim())).size !== structure.features.length) c.error('invalid_structure', p, `${p}: признаки не должны повторяться.`);
  }
  if (structure.source !== undefined) checkSource(structure.source, `${path}.source`, c);
}

/** Convenience for the stable-range check of tests and callers: the range in kelvin. */
export function stableRangeKelvin(phase: MaterialPhase): { min: number; max: number } | null {
  if (!phase.stableRange) return null;
  try { return { min: convert(phase.stableRange.min.value, phase.stableRange.min.unit, 'K'), max: convert(phase.stableRange.max.value, phase.stableRange.max.unit, 'K') }; }
  catch (error) { if (error instanceof PhysicsError) return null; throw error; }
}
