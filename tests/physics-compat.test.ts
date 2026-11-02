import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Isolation of the physics core, checked on the source text only - independent of Git, of any branch and of the state of the working tree. */
const root = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** Module specifiers of static imports, re-exports, dynamic imports and require() in a source text. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*['"]([^'"]+)['"]/g)) found.push(m[1]);
  return found;
}

const isPhysicsSpecifier = (spec: string): boolean => /(^|\/)physics(\/|$)/.test(spec);

test('the specifier scanner recognises every import form (self-check)', () => {
  const sample = [
    "import { a } from '../physics';", "import x from '../../src/physics/units';", "export * from './physics';", "export { y } from '@/physics/index';",
    "const m = await import('../physics');", "const r = require('../physics/exact');", "import '../physics/side-effect';",
  ].join('\n');
  assert.equal(specifiers(sample).filter(isPhysicsSpecifier).length, 7);
  assert.equal(specifiers("import a from '../services/physics-like'; import b from 'react';").filter(isPhysicsSpecifier).length, 0);
});

test('the physics core is dependency-free: it imports only its own modules', () => {
  const files = walk(join(root, 'src/physics')).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 8);
  for (const file of files) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) assert.ok(spec.startsWith('./'), `${relative(root, file)} imports '${spec}'`);
  }
});

test('no existing module imports the physics core (M1.1 is isolated from calculators, TechDoc, TEA, Equipment Selector, src/calculators)', () => {
  const sources = [
    ...walk(join(root, 'src')).filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.includes('/src/physics/')),
    ...walk(join(root, 'tests')).filter(f => /\.(ts|tsx)$/.test(f) && !/\/physics-[^/]+\.test\.ts$/.test(f)),
  ];
  assert.ok(sources.length > 20, 'the scan must actually find the existing sources');
  for (const file of sources) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) assert.ok(!isPhysicsSpecifier(spec), `${relative(root, file)} imports '${spec}'`);
  }
});

test('the core has no hidden global state and no I/O: no process, fs, Date, Math.random, fetch or timers', () => {
  for (const file of walk(join(root, 'src/physics')).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(process\.|Math\.random|Date\.now|new Date|fetch\(|setTimeout|localStorage|require\()/.test(code), relative(root, file));
  }
});
