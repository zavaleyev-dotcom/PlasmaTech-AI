import test from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, QUANTITY_KINDS, CONSTANTS, UNIT_IDS, QUANTITY_KIND_IDS, CONSTANT_IDS, BASE_DIMENSIONS, BASE_UNIT_SYMBOLS, PHYSICS_ERROR_CODES, PRESSURE, DIMENSIONLESS, FORCE, dimension, dimMul, dimDiv, dimPow, exact, convert, deepFreeze } from '../src/physics';

/** Every object and array reachable from `root` (also through symbol keys) must be frozen. */
function assertDeepFrozen(root: unknown, path = 'root', seen = new Set<unknown>()): void {
  if (root === null || typeof root !== 'object' || seen.has(root)) return;
  seen.add(root);
  assert.ok(Object.isFrozen(root), `${path} is not frozen`);
  for (const key of Reflect.ownKeys(root)) assertDeepFrozen((root as Record<PropertyKey, unknown>)[key], `${path}.${String(key)}`, seen);
}

function mutationIsRefusedOrIgnored(mutate: () => void, readBack: () => unknown, before: unknown): void {
  try { mutate(); } catch (e) { assert.ok(e instanceof TypeError); }
  assert.deepEqual(readBack(), before);
}

test('F5: registries are deeply frozen (nested objects, arrays, rationals)', () => {
  assertDeepFrozen(UNITS, 'UNITS');
  assertDeepFrozen(QUANTITY_KINDS, 'QUANTITY_KINDS');
  assertDeepFrozen(CONSTANTS, 'CONSTANTS');
  for (const list of [UNIT_IDS, QUANTITY_KIND_IDS, CONSTANT_IDS, BASE_DIMENSIONS, BASE_UNIT_SYMBOLS, PHYSICS_ERROR_CODES]) assertDeepFrozen(list);
  for (const r of [exact.ZERO, exact.ONE, exact.rational(BigInt(3), BigInt(4)), exact.neg(exact.ONE), exact.add(exact.ONE, exact.ONE)]) assertDeepFrozen(r);
});

test('F5: dimensions are frozen, including those produced by the algebra', () => {
  for (const d of [PRESSURE, DIMENSIONLESS, FORCE, dimension({ length: 2 }), dimMul(PRESSURE, FORCE), dimDiv(PRESSURE, FORCE), dimPow(PRESSURE, 2)]) assertDeepFrozen(d);
});

test('F5: mutating a unit, a constant, a kind or a dimension has no effect', () => {
  mutationIsRefusedOrIgnored(() => { (UNITS.Torr as { symbol: string }).symbol = 'X'; }, () => UNITS.Torr.symbol, 'Торр');
  mutationIsRefusedOrIgnored(() => { (UNITS.Torr.factor as { n: bigint }).n = BigInt(1); }, () => UNITS.Torr.factor.n, BigInt(101325 / 5));
  mutationIsRefusedOrIgnored(() => { (UNITS.degC.offset as { d: bigint }).d = BigInt(7); }, () => UNITS.degC.offset.d, BigInt(20));
  mutationIsRefusedOrIgnored(() => { (CONSTANTS.boltzmann as { value: number }).value = 1; }, () => CONSTANTS.boltzmann.value, 1.380649e-23);
  mutationIsRefusedOrIgnored(() => { (CONSTANTS.boltzmann.source as { origin: string }).origin = 'x'; }, () => CONSTANTS.boltzmann.source.origin.startsWith('Определение СИ'), true);
  mutationIsRefusedOrIgnored(() => { (CONSTANTS.boltzmann.dimension as unknown as number[])[0] = 9; }, () => CONSTANTS.boltzmann.dimension[0], 2);
  mutationIsRefusedOrIgnored(() => { (QUANTITY_KINDS.temperature as { nonNegative: boolean }).nonNegative = false; }, () => QUANTITY_KINDS.temperature.nonNegative, true);
  mutationIsRefusedOrIgnored(() => { (PRESSURE as unknown as number[])[1] = 5; }, () => PRESSURE.join(), '-1,1,-2,0,0,0,0');
  mutationIsRefusedOrIgnored(() => { (UNIT_IDS as string[]).push('evil'); }, () => UNIT_IDS.includes('evil' as never), false);
  mutationIsRefusedOrIgnored(() => { (UNITS as Record<string, unknown>).evil = {}; }, () => 'evil' in UNITS, false);
  mutationIsRefusedOrIgnored(() => { delete (UNITS as Record<string, unknown>).Pa; }, () => 'Pa' in UNITS, true);
  mutationIsRefusedOrIgnored(() => { (exact.ONE as { n: bigint }).n = BigInt(2); }, () => exact.ONE.n, BigInt(1));
  // and conversions still give the right answers afterwards
  assert.equal(convert(1, 'Torr', 'Pa'), 101325 / 760);
  assert.equal(convert(0.07, 'mbar', 'Pa'), 7);
});

test('deepFreeze: handles nested structures, primitives and already frozen input', () => {
  const o = deepFreeze({ a: { b: [1, { c: 2 }] }, n: BigInt(1) });
  assertDeepFrozen(o);
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze(o), o);
});

test('deepFreeze: a root frozen beforehand does not stop the traversal into unfrozen children', () => {
  const inner = { c: [1, { d: 2 }] };
  const root = Object.freeze({ a: inner, list: [{ x: 1 }] });
  assert.ok(Object.isFrozen(root) && !Object.isFrozen(inner));
  const result = deepFreeze(root);
  assert.equal(result, root);          // the same reference
  assert.equal(root.a, inner);         // children are the same objects, frozen in place
  assertDeepFrozen(root);
  assert.deepEqual(inner, { c: [1, { d: 2 }] }); // contents unchanged
  // an intermediate frozen node, too
  const leaf = { v: 1 };
  const mid = Object.freeze({ leaf });
  const top = { mid };
  deepFreeze(top);
  assert.ok(Object.isFrozen(top) && Object.isFrozen(leaf));
});

test('deepFreeze: cyclic structures terminate and are frozen completely', () => {
  const a: { name: string; self?: unknown; peer?: unknown; list: unknown[] } = { name: 'a', list: [] };
  const b: { name: string; back: unknown } = { name: 'b', back: a };
  a.self = a; a.peer = b; a.list.push(a, b);
  assert.equal(deepFreeze(a), a);
  assertDeepFrozen(a);
  assert.ok(Object.isFrozen(b) && Object.isFrozen(a.list));
  assert.equal(a.self, a);
  assert.equal(b.back, a);
  const arr: unknown[] = []; arr.push(arr);
  deepFreeze(arr);
  assert.ok(Object.isFrozen(arr));
});

test('deepFreeze: scope is plain objects and arrays only - special objects are left untouched, getters are not invoked', () => {
  const map = new Map([['k', { v: 1 }]]);
  const date = new Date(0);
  const typed = new Uint8Array(2);
  class Box { value = { n: 1 }; }
  const box = new Box();
  let getterCalls = 0;
  const withGetter = { get lazy() { getterCalls += 1; return { z: 1 }; }, plain: { y: 1 } };
  deepFreeze({ map, date, typed, box, withGetter, fn: () => 1 });
  assert.ok(!Object.isFrozen(map) && !Object.isFrozen(date) && !Object.isFrozen(typed) && !Object.isFrozen(box) && !Object.isFrozen(box.value));
  assert.ok(Object.isFrozen(withGetter) && Object.isFrozen(withGetter.plain));
  assert.equal(getterCalls, 0);
  map.set('new', { v: 2 }); // still usable
  assert.equal(map.size, 2);
  assert.ok(Object.isFrozen(Object.create(null) as object) === false);
  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { inner: { q: 1 } });
  deepFreeze(nullProto);
  assertDeepFrozen(nullProto);
});
