import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ELEMENT_SYMBOLS, isElementSymbol, parseMaterialId, isMaterialId, materialId, elementMaterialId, canonicalJson, contentFingerprint, validateIdentity, createIdentity, MaterialsError } from '../src/materials';

const root = join(__dirname, '..');

test('element symbols: 118 unique symbols H..Og in order of atomic number (NIST listing)', () => {
  assert.equal(ELEMENT_SYMBOLS.length, 118);
  assert.equal(new Set(ELEMENT_SYMBOLS).size, 118);
  assert.equal(ELEMENT_SYMBOLS[0], 'H');
  assert.equal(ELEMENT_SYMBOLS[5], 'C');
  assert.equal(ELEMENT_SYMBOLS[21], 'Ti');
  assert.equal(ELEMENT_SYMBOLS[25], 'Fe');
  assert.equal(ELEMENT_SYMBOLS[117], 'Og');
  for (const s of ELEMENT_SYMBOLS) assert.match(s, /^[A-Z][a-z]?$/);
  assert.ok(Object.isFrozen(ELEMENT_SYMBOLS));
  assert.ok(isElementSymbol('Ti'));
  for (const bad of ['ti', 'TI', 'Xx', '', 'D', 'T', 'Titanium', 5, null, undefined]) assert.ok(!isElementSymbol(bad), String(bad));
});

test('ids: namespaces, slug syntax, determinism, no invention', () => {
  assert.deepEqual(parseMaterialId('ref:element-ti'), { namespace: 'ref', slug: 'element-ti' });
  assert.deepEqual(parseMaterialId('fixture:a.b_c-1'), { namespace: 'fixture', slug: 'a.b_c-1' });
  for (const bad of ['', 'ref:', ':x', 'x:abc', 'ref:Abc', 'ref:a b', 'ref:-a', 'ref:a--b', 'ref:a:b', `ref:${'a'.repeat(100)}`, 5, null, undefined, {}]) assert.equal(parseMaterialId(bad), null, String(bad));
  assert.ok(isMaterialId('user:my-alloy'));
  assert.equal(materialId('ref', 'steel-x'), 'ref:steel-x');
  assert.throws(() => materialId('ref', 'Bad Slug'), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_id');
  assert.equal(elementMaterialId('Ti'), 'ref:element-ti');
  assert.throws(() => elementMaterialId('Xx'), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_symbol');
  const ids = ELEMENT_SYMBOLS.map(elementMaterialId);
  assert.equal(new Set(ids).size, 118);                                           // unique
  assert.deepEqual(ids, ELEMENT_SYMBOLS.map(elementMaterialId));                  // stable between calls
  assert.ok(ids.every(isMaterialId));
});

test('canonical JSON and content fingerprint: independent of key order, sensitive to content, deterministic', () => {
  const a = { b: 1, a: { y: [1, 2, { q: 'x' }], x: 'ё' } };
  const b = { a: { x: 'ё', y: [1, 2, { q: 'x' }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(contentFingerprint(a), contentFingerprint(b));
  assert.match(contentFingerprint(a), /^[0-9a-f]{16}$/);
  assert.equal(contentFingerprint(a), contentFingerprint(JSON.parse(JSON.stringify(a))));
  assert.notEqual(contentFingerprint(a), contentFingerprint({ ...a, b: 2 }));
  assert.notEqual(contentFingerprint({ v: 1 }), contentFingerprint({ v: '1' }));
  assert.equal(canonicalJson({ a: undefined, b: -0 }), '{"b":0}');
  assert.throws(() => canonicalJson({ a: NaN }), MaterialsError);
  assert.throws(() => canonicalJson({ a: () => 1 }), MaterialsError);
  // a known vector pins the algorithm (FNV-1a 64 over UTF-8 of the canonical text): it must never change silently
  assert.equal(contentFingerprint('a'), 'd4272417d7c77eea');                                   // FNV-1a 64 of the text "a" (with quotes), computed independently
  assert.equal(contentFingerprint({ b: [true, null], a: 1 }), '595cf28929e773ea');
});

test('the package never reads a clock or a random source (ids must be reproducible)', () => {
  const dir = join(root, 'src/materials');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(Date\.now|new Date|Math\.random|performance\.now|crypto\.)/.test(code), file);
  }
});

test('identity: names, kinds, synonyms; designations (CAS, UNS, GOST...) only with a source', () => {
  const ok = { id: 'fixture:synthetic-x', kind: 'alloy', nameRu: 'СИНТЕТИЧЕСКИЙ сплав', nameEn: 'SYNTHETIC alloy', synonyms: ['a', 'b'] } as const;
  assert.equal(validateIdentity(ok).ok, true);
  assert.ok(Object.isFrozen(createIdentity(ok)));
  const codes = (v: unknown) => validateIdentity(v).issues.filter(i => i.severity === 'error').map(i => i.code);
  assert.deepEqual(codes({ ...ok, nameRu: '' }), ['invalid_name']);
  assert.deepEqual(codes({ ...ok, id: 'Bad Id' }), ['invalid_id']);
  assert.deepEqual(codes({ ...ok, kind: 'metal' }), ['invalid_kind']);
  assert.deepEqual(codes({ ...ok, synonyms: ['a', 'A'] }), ['invalid_name']);
  assert.deepEqual(codes({ ...ok, extra: 1 }), ['invalid_material']);
  assert.deepEqual(codes({ ...ok, designations: [{ system: 'CAS', value: 'x' }] }), ['designation_unsourced']);                  // an unsourced designation is refused
  assert.deepEqual(codes({ ...ok, designations: [{ system: 'CAS', value: 'x', source: { citation: '' } }] }), ['invalid_source']);
  assert.deepEqual(codes({ ...ok, designations: [{ system: 'CAS', value: 'x', source: { citation: 'СИНТЕТИЧЕСКИЙ источник', doi: 'not-a-doi' } }] }), ['invalid_source']);
  assert.equal(validateIdentity({ ...ok, designations: [{ system: 'CAS', value: 'x', source: { citation: 'СИНТЕТИЧЕСКИЙ источник', doi: '10.1234/synthetic', locator: 'Table 1' } }] }).ok, true);
  assert.throws(() => createIdentity({ ...ok, nameRu: '' } as never), (e: unknown) => e instanceof MaterialsError && e.code === 'invalid_material' && e.issues.length === 1);
  // nothing assigns an identifier automatically: an identity without designations has none
  assert.equal((createIdentity(ok) as { designations?: unknown }).designations, undefined);
});
