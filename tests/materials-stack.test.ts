import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStack, flattenStack, totalThickness, Collector, MaterialsError, MAX_FLAT_LAYERS, type MaterialStack } from '../src/materials';
import { syntheticSystemCatalog } from './materials-fixtures';

const q = (value: number, unit: string) => ({ value, unit }) as never;
type Element = Record<string, unknown>;
const layer = (id: string, thickness?: unknown, extra: Record<string, unknown> = {}): Element => ({ type: 'layer', layer: { kind: 'uniform', id, material: 'fixture:a', ...(thickness ? { thickness } : {}), ...extra } });
const run = (stack: unknown) => { const c = new Collector(); validateStack(stack, 'stack', c); return c.report(); };
const codes = (stack: unknown) => run(stack).issues.filter(i => i.severity === 'error').map(i => i.code);
const systemStack = (): MaterialStack => {
  const variant = syntheticSystemCatalog().variants.find(v => v.id === 'fixture:synthetic-system-film')!;
  if (variant.composition.type !== 'coating_system') throw new Error('fixture');
  return variant.composition.stack;
};

test('a multilayer system: adhesion layer, repeated package with a gradient layer, interfaces, cap; flattened in order', () => {
  const stack = systemStack();
  assert.equal(run(stack).ok, true);
  const flat = flattenStack(stack);
  assert.deepEqual(flat.map(f => f.layer.id), ['adhesion', 'a', 'g', 'a', 'g', 'a', 'g', 'a', 'g', 'a', 'g', 'cap']);
  assert.deepEqual(flat.map(f => f.position), [...Array(12).keys()]);
  assert.deepEqual(flat.map(f => f.repetition.join('/')), ['', '0', '0', '1', '1', '2', '2', '3', '3', '4', '4', '']);
  assert.deepEqual(flat.map(f => f.layer.id), flattenStack(stack).map(f => f.layer.id));            // deterministic
  assert.equal(flat[0].layer.role, 'adhesion');
  assert.equal(flat[2].layer.kind, 'gradient');
});

test('total thickness is a geometric exact sum, refused while any layer has no thickness', () => {
  const t = totalThickness(systemStack());
  assert.equal(t.unit, 'm');
  assert.ok(Math.abs(t.value - (20 + 5 * (10 + 5) + 30) * 1e-9) < 1e-18);                           // 125 nm
  const noThickness = { elements: [layer('a', q(10, 'nm')), layer('b')] } as unknown as MaterialStack;
  assert.throws(() => totalThickness(noThickness), (e: unknown) => e instanceof MaterialsError && e.code === 'missing_data');
  assert.ok(run(noThickness).issues.some(i => i.code === 'missing_data' && i.severity === 'info'));  // reported as missing, not an error
  assert.equal(totalThickness({ elements: [layer('a', q(0.1, 'um')), layer('b', q(900, 'nm'))] } as never).value, 1e-6);   // 0.1 um + 900 nm, exactly 1 um
  assert.equal(totalThickness({ elements: [{ type: 'period', repeat: 3, elements: [layer('a', q(0.1, 'nm'))] }] } as never).value, 0.3e-9);
});

test('periodic packages: repeat count, nesting, emptiness, the flattening cap', () => {
  const period = (repeat: unknown, elements: unknown) => ({ elements: [{ type: 'period', repeat, elements }] });
  assert.deepEqual(codes(period(5, [layer('a', q(1, 'nm')), layer('b', q(1, 'nm'))])), []);
  for (const bad of [1, 0, -2, 2.5, NaN, '3', undefined, 10001]) assert.deepEqual(codes(period(bad, [layer('a')])), ['invalid_period'], String(bad));
  assert.deepEqual(codes(period(3, [])), ['invalid_stack']);
  assert.deepEqual(codes(period(3, undefined)), ['invalid_stack']);
  assert.deepEqual(codes({ elements: [] }), ['invalid_stack']);
  assert.deepEqual(codes({}), ['invalid_stack']);
  assert.deepEqual(codes('x'), ['invalid_stack']);
  // nested packages are allowed up to a depth; deeper is refused
  const nest = (depth: number): Element[] => (depth === 0 ? [layer(`l${depth}`)] : [{ type: 'period', repeat: 2, elements: [...nest(depth - 1), layer(`x${depth}`)] }]);
  assert.deepEqual(codes({ elements: nest(2) }), []);
  assert.ok(codes({ elements: nest(9) }).includes('stack_too_large'));
  // an expansion above the cap is refused before anything is expanded
  assert.ok(codes({ elements: [{ type: 'period', repeat: 10000, elements: [{ type: 'period', repeat: 10000, elements: [layer('a')] }] }] }).includes('stack_too_large'));
  assert.ok(MAX_FLAT_LAYERS >= 10000);
});

test('layer ids are unique in the stack; a layer in a repeated package keeps one id', () => {
  assert.deepEqual(codes({ elements: [layer('a'), layer('a')] }), ['duplicate_layer_id']);
  assert.deepEqual(codes({ elements: [layer('a'), { type: 'period', repeat: 2, elements: [layer('a')] }] }), ['duplicate_layer_id']);
  assert.deepEqual(codes({ elements: [layer('Bad Id')] }), ['invalid_layer']);
  assert.deepEqual(codes({ elements: [layer('a', undefined, { material: 'no id' })] }), ['invalid_id']);
});

test('layers: roles, thickness, gradient layers', () => {
  const g = (extra: Record<string, unknown>) => ({ elements: [{ type: 'layer', layer: { kind: 'gradient', id: 'g', from: 'fixture:a', to: 'fixture:b', ...extra } }] });
  assert.deepEqual(codes(g({})), []);
  assert.deepEqual(codes(g({ to: 'fixture:a' })), ['invalid_layer']);                                // a gradient needs two DIFFERENT materials
  assert.deepEqual(codes(g({ from: 'bad' })), ['invalid_id']);
  assert.deepEqual(codes(g({ profile: '' })), ['invalid_layer']);
  assert.deepEqual(codes({ elements: [{ type: 'layer', layer: { kind: 'blend', id: 'a' } }] }), ['invalid_layer']);
  for (const role of ['adhesion', 'intermediate', 'functional', 'protective', 'buffer', 'capping']) assert.deepEqual(codes({ elements: [layer('a', undefined, { role })] }), [], role);
  assert.deepEqual(codes({ elements: [layer('a', undefined, { role: 'magic' })] }), ['invalid_layer']);
  for (const bad of [q(0, 'nm'), q(-1, 'nm'), q(1, 'K'), q(NaN, 'nm'), 5]) assert.deepEqual(codes({ elements: [layer('a', bad)] }), ['invalid_quantity'], JSON.stringify(bad));
  assert.deepEqual(codes({ elements: [layer('a', undefined, { effectiveConductivity: 5 })] }), ['invalid_layer']);   // no effective properties of layers or stacks
  assert.deepEqual(codes({ elements: [layer('a')], effectiveDensity: 3 }), ['invalid_stack']);
});

test('interfaces between layers: described, never computed; allowed only where a next element exists', () => {
  const withInterface = (iface: unknown, last = false) => ({ elements: last ? [layer('a'), { ...layer('b'), interfaceToNext: iface }] : [{ ...layer('a'), interfaceToNext: iface }, layer('b')] });
  assert.deepEqual(codes(withInterface({ kind: 'diffuse', width: q(2, 'nm'), roughness: q(0.3, 'nm'), note: 'СИНТЕТИЧЕСКАЯ' })), []);
  assert.deepEqual(codes(withInterface({ kind: 'unknown' })), []);
  assert.deepEqual(codes(withInterface({})), ['invalid_interface']);
  assert.deepEqual(codes(withInterface({ kind: 'fuzzy' })), ['invalid_interface']);
  assert.deepEqual(codes(withInterface({ width: q(-1, 'nm') })), ['invalid_quantity']);
  assert.deepEqual(codes(withInterface({ roughness: q(1, 'Pa') })), ['invalid_quantity']);
  assert.deepEqual(codes(withInterface({ kind: 'sharp', adhesionEnergy: 1 })), ['invalid_interface']);
  assert.deepEqual(codes(withInterface({ kind: 'sharp' }, true)), ['invalid_interface']);             // nothing follows the last element
  assert.deepEqual(codes({ elements: [{ type: 'period', repeat: 2, interfaceBetweenRepeats: { kind: 'sharp' }, elements: [layer('a'), layer('b')] }] }), []);
  assert.deepEqual(codes({ elements: [{ type: 'period', repeat: 2, interfaceBetweenRepeats: {}, elements: [layer('a'), layer('b')] }] }), ['invalid_interface']);
  assert.deepEqual(codes({ elements: [{ type: 'period', repeat: 2, elements: [{ ...layer('a'), interfaceToNext: { kind: 'sharp' } }] }] }), ['invalid_interface']);   // inside a period the last element has no "next"
});

test('nothing in the package computes effective properties of a stack', async () => {
  const names = Object.keys(await import('../src/materials'));
  assert.ok(!names.some(n => /effective|average|mixture|homogeni[sz]/i.test(n)), names.join());
});
