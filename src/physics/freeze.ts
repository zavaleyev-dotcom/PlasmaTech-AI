/** Deep, recursive `Object.freeze` for the registries: units, kinds, constants and dimensions are shared by the whole application, so a stray assignment
 *  (`UNITS.Torr.factor = ...`) must throw (strict mode) or be ignored, never silently change every later conversion.
 *
 *  Scope: PLAIN objects (prototype `Object.prototype` or `null`) and arrays only, plus primitives (bigint included, which are immutable already). Anything else -
 *  Map, Set, Date, TypedArray, class instances, functions - is returned untouched and is NOT traversed: freezing a Map would not freeze its entries, which would be a
 *  false promise. Extending this contract needs a separate decision.
 *
 *  Every plain object/array reachable from the root is frozen even when the root or an intermediate node was already frozen by someone else; cycles are handled
 *  (each node is visited once); references are preserved (the same objects are frozen in place, nothing is copied). */
const isPlain = (value: object): boolean => {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export function deepFreeze<T>(value: T): T {
  const visited = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || visited.has(node) || !isPlain(node)) return;
    visited.add(node);
    if (!Object.isFrozen(node)) Object.freeze(node);
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor && 'value' in descriptor) walk(descriptor.value); // never invoke a getter
    }
  };
  walk(value);
  return value;
}
