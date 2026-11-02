import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MATERIAL_ISSUE_CODES } from '../src/materials';

/** Isolation of the materials package, checked on source text only - independent of Git. */
const root = join(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const specifiers = (source: string): string[] => [
  ...source.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm),   // static imports and re-exports (a string 'from' inside code is not one)
  ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
  ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
  ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
].map(m => m[1]);
const isMaterialsSpecifier = (spec: string): boolean => /(^|\/)materials(\/|$)/.test(spec);

test('the materials package imports only itself, the physics core and the pure DOI normaliser', () => {
  const allowed = (spec: string): boolean => spec.startsWith('./') || spec === '@/physics' || spec === '@/services/scientific-search/normalization';
  const files = walk(join(root, 'src/materials')).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 10);
  for (const file of files) for (const spec of specifiers(readFileSync(file, 'utf8'))) assert.ok(allowed(spec), `${relative(root, file)} imports '${spec}'`);
});

test('no existing module imports the materials package (TechDoc, TEA, Equipment Selector, calculators, src/calculators are untouched)', () => {
  const sources = [
    ...walk(join(root, 'src')).filter(f => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !f.includes('/src/materials/')),
    ...walk(join(root, 'tests')).filter(f => /\.(ts|tsx)$/.test(f) && !/\/materials-[^/]+\.(test\.)?ts$/.test(f)),
  ];
  assert.ok(sources.length > 20);
  for (const file of sources) for (const spec of specifiers(readFileSync(file, 'utf8'))) assert.ok(!isMaterialsSpecifier(spec), `${relative(root, file)} imports '${spec}'`);
});

test('the package ships no data: no data directory, no JSON, no reference tables - fixtures live in tests only and are synthetic', () => {
  const files = walk(join(root, 'src/materials'));
  assert.ok(!existsSync(join(root, 'src/materials/data')));
  assert.deepEqual(files.filter(f => /\.(json|csv|tsv|yaml|yml)$/.test(f)), []);
  const fixtures = readFileSync(join(root, 'tests/materials-fixtures.ts'), 'utf8');
  assert.match(fixtures, /СИНТЕТИЧЕСК/);
  assert.match(fixtures, /NOT reference data/);
  for (const file of files.filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(density|conductivity|resistivity|meltingPoint|specificHeat|expansionCoefficient|elasticModulus|youngModulus|atomicWeight|atomicMass)\b/i.test(code), `${relative(root, file)} mentions a property`);
  }
});

test('README documents every issue code and the accepted decisions', () => {
  const readme = readFileSync(join(root, 'src/materials/README.md'), 'utf8');
  for (const code of MATERIAL_ISSUE_CODES) assert.ok(readme.includes(`\`${code}\``), `README does not mention '${code}'`);
  for (const topic of ['вариант', 'агрегатное состояние', 'аморфн', 'неизвестн', 'пакет', 'атомных масс', 'синтетическ']) assert.ok(readme.toLowerCase().includes(topic), topic);
});
