/** Multilayer coatings: sequences of layers, adhesion and intermediate layers, periodically repeated packages, graded layers and the interfaces between layers.
 *  This is a DESCRIPTION of a structure. No effective property of a stack is computed - that needs a verified physical model. The only derived quantities are
 *  geometric: the flattened layer sequence and the total thickness. */

import { exact, quantity, toSiRational, exactToNumber, type Quantity } from '@/physics';
import { checkKeys, checkQuantity, isNonEmptyString } from './checks';
import { Collector, isRecord, MaterialsError } from './errors';
import { isMaterialId } from './ids';
import { INTERFACE_KINDS, LAYER_ROLES, type MaterialLayer, type MaterialStack, type StackElement } from './types';

export const MAX_STACK_DEPTH = 8;
export const MAX_FLAT_LAYERS = 10000;
const MAX_REPEAT = 10000;
const LAYER_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function validateInterface(value: unknown, path: string, c: Collector): void {
  if (!isRecord(value)) { c.error('invalid_interface', path, `${path}: ожидался объект описания границы.`); return; }
  checkKeys(value, ['kind', 'width', 'roughness', 'note'], path, c, 'invalid_interface');
  if (Object.keys(value).length === 0) c.error('invalid_interface', path, `${path}: пустое описание границы — задайте хотя бы одно поле или уберите объект.`);
  if (value.kind !== undefined && !(INTERFACE_KINDS as readonly string[]).includes(value.kind as string)) c.error('invalid_interface', `${path}.kind`, `${path}.kind: допустимо одно из: ${INTERFACE_KINDS.join(', ')}.`);
  if (value.width !== undefined) checkQuantity(value.width, 'length', `${path}.width`, c, 'nonnegative');
  if (value.roughness !== undefined) checkQuantity(value.roughness, 'length', `${path}.roughness`, c, 'nonnegative');
  if (value.note !== undefined && !isNonEmptyString(value.note)) c.error('invalid_interface', `${path}.note`, `${path}.note: ожидалась непустая строка.`);
}

function validateLayer(layer: unknown, path: string, ids: Set<string>, c: Collector): void {
  if (!isRecord(layer)) { c.error('invalid_layer', path, `${path}: ожидался объект слоя.`); return; }
  if (layer.kind === 'uniform') checkKeys(layer, ['id', 'kind', 'material', 'role', 'thickness'], path, c, 'invalid_layer');
  else if (layer.kind === 'gradient') checkKeys(layer, ['id', 'kind', 'from', 'to', 'profile', 'role', 'thickness'], path, c, 'invalid_layer');
  else { c.error('invalid_layer', `${path}.kind`, `${path}.kind: слой должен быть uniform или gradient.`); return; }
  if (typeof layer.id !== 'string' || !LAYER_ID.test(layer.id)) c.error('invalid_layer', `${path}.id`, `${path}.id: идентификатор слоя — строчные латинские буквы, цифры, «-» и «_».`);
  else if (ids.has(layer.id)) c.error('duplicate_layer_id', `${path}.id`, `${path}.id: идентификатор слоя «${layer.id}» повторяется в стеке.`);
  else ids.add(layer.id);
  if (layer.role !== undefined && !(LAYER_ROLES as readonly string[]).includes(layer.role as string)) c.error('invalid_layer', `${path}.role`, `${path}.role: допустимо одно из: ${LAYER_ROLES.join(', ')}.`);
  if (layer.thickness !== undefined) checkQuantity(layer.thickness, 'length', `${path}.thickness`, c, 'positive');
  else c.info('missing_data', `${path}.thickness`, `${path}: толщина слоя не задана.`);
  if (layer.kind === 'uniform') {
    if (!isMaterialId(layer.material)) c.error('invalid_id', `${path}.material`, `${path}.material: некорректный идентификатор варианта материала.`);
  } else {
    if (!isMaterialId(layer.from)) c.error('invalid_id', `${path}.from`, `${path}.from: некорректный идентификатор варианта материала.`);
    if (!isMaterialId(layer.to)) c.error('invalid_id', `${path}.to`, `${path}.to: некорректный идентификатор варианта материала.`);
    if (isMaterialId(layer.from) && layer.from === layer.to) c.error('invalid_layer', path, `${path}: градиентный слой должен соединять два РАЗНЫХ материала.`);
    if (layer.profile !== undefined && !isNonEmptyString(layer.profile)) c.error('invalid_layer', `${path}.profile`, `${path}.profile: ожидалась непустая строка (это пометка источника, а не модель).`);
  }
}

/** Returns the number of flattened layers under the elements (capped), validating as it goes. */
function validateElements(elements: unknown, path: string, depth: number, ids: Set<string>, c: Collector): number {
  if (!Array.isArray(elements) || elements.length === 0) { c.error('invalid_stack', path, `${path}: ожидался непустой список элементов стека.`); return 0; }
  if (depth > MAX_STACK_DEPTH) { c.error('stack_too_large', path, `${path}: вложенность периодов больше ${MAX_STACK_DEPTH}.`); return 0; }
  let count = 0;
  elements.forEach((element, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(element)) { c.error('invalid_stack', p, `${p}: ожидался объект элемента стека.`); return; }
    const isLast = i === elements.length - 1;
    if (element.interfaceToNext !== undefined) {
      if (isLast) c.error('invalid_interface', `${p}.interfaceToNext`, `${p}.interfaceToNext: после последнего элемента списка границы нет.`);
      validateInterface(element.interfaceToNext, `${p}.interfaceToNext`, c);
    }
    if (element.type === 'layer') {
      checkKeys(element, ['type', 'layer', 'interfaceToNext'], p, c, 'invalid_stack');
      validateLayer(element.layer, `${p}.layer`, ids, c);
      count += 1;
    } else if (element.type === 'period') {
      checkKeys(element, ['type', 'repeat', 'elements', 'interfaceToNext', 'interfaceBetweenRepeats'], p, c, 'invalid_period');
      const repeat = element.repeat;
      const repeatOk = typeof repeat === 'number' && Number.isInteger(repeat) && repeat >= 2 && repeat <= MAX_REPEAT;
      if (!repeatOk) c.error('invalid_period', `${p}.repeat`, `${p}.repeat: число повторений — целое от 2 до ${MAX_REPEAT} (один пакет без повторения описывается обычными слоями).`);
      if (element.interfaceBetweenRepeats !== undefined) validateInterface(element.interfaceBetweenRepeats, `${p}.interfaceBetweenRepeats`, c);
      const inner = validateElements(element.elements, `${p}.elements`, depth + 1, ids, c);
      count += repeatOk ? Math.min(inner * (repeat as number), MAX_FLAT_LAYERS + 1) : inner;
    } else c.error('invalid_stack', `${p}.type`, `${p}.type: элемент стека — layer или period.`);
    if (count > MAX_FLAT_LAYERS) count = MAX_FLAT_LAYERS + 1;
  });
  return count;
}

export function validateStack(stack: unknown, path: string, c: Collector): void {
  if (!isRecord(stack)) { c.error('invalid_stack', path, `${path}: ожидался объект стека.`); return; }
  checkKeys(stack, ['substrate', 'elements'], path, c, 'invalid_stack');
  if (stack.substrate !== undefined && !isMaterialId(stack.substrate)) c.error('invalid_id', `${path}.substrate`, `${path}.substrate: некорректный идентификатор варианта подложки.`);
  const total = validateElements(stack.elements, `${path}.elements`, 1, new Set<string>(), c);
  if (total > MAX_FLAT_LAYERS) c.error('stack_too_large', path, `${path}: после раскрытия повторяющихся пакетов слоёв больше ${MAX_FLAT_LAYERS}.`);
}

export interface FlatLayer {
  /** 0-based position from the substrate outwards. */
  readonly position: number;
  readonly layer: MaterialLayer;
  /** The repetition index of every period the layer sits in, outermost first (empty for a layer outside any period). */
  readonly repetition: readonly number[];
}

/** The layers in order, with every repeated package expanded. Deterministic. The stack must be valid (use validateStack / the variant validator first). */
export function flattenStack(stack: MaterialStack): readonly FlatLayer[] {
  const out: FlatLayer[] = [];
  const walk = (elements: readonly StackElement[], repetition: readonly number[]): void => {
    for (const element of elements) {
      if (element.type === 'layer') {
        out.push(Object.freeze({ position: out.length, layer: element.layer, repetition: Object.freeze([...repetition]) }));
      } else {
        for (let r = 0; r < element.repeat; r += 1) {
          walk(element.elements, [...repetition, r]);
          if (out.length > MAX_FLAT_LAYERS) throw new MaterialsError('stack_too_large', `Стек содержит больше ${MAX_FLAT_LAYERS} слоёв.`);
        }
      }
    }
  };
  walk(stack.elements, []);
  return Object.freeze(out);
}

/** The geometric total thickness (exact sum of the layer thicknesses, in metres). Refused while any layer has no thickness: nothing is assumed. */
export function totalThickness(stack: MaterialStack): Quantity<'length'> {
  const layers = flattenStack(stack);
  let sum = exact.ZERO;
  for (const { layer, position } of layers) {
    if (layer.thickness === undefined) throw new MaterialsError('missing_data', `У слоя «${layer.id}» (позиция ${position}) не задана толщина: суммарная толщина не определена.`);
    sum = exact.add(sum, toSiRational(layer.thickness.value, layer.thickness.unit));
  }
  return quantity(exactToNumber(sum, 'Суммарная толщина стека'), 'm') as Quantity<'length'>;
}
