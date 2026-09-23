import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReferences, saveReferences, mergeReferencesById, createInMemoryStoreForTests, type KeyValueStore } from '../src/services/workspace/scientific-writer-references-store';
import { createReference } from '../src/services/workspace/references';

function freshStore(): KeyValueStore {
  return createInMemoryStoreForTests();
}

test('loadReferences: an empty/never-saved store returns [], never throws', () => {
  assert.deepEqual(loadReferences(freshStore()), []);
  assert.deepEqual(loadReferences(null), []);
});

test('saveReferences/loadReferences: round-trips manually-created references exactly', () => {
  const store = freshStore();
  const ref = { ...createReference('book'), title: 'A manually typed reference', authors: ['Иванов И.И.'] };
  assert.equal(saveReferences([ref], store), true);
  assert.deepEqual(loadReferences(store), [ref]);
});

test('saveReferences: reports true/false honestly based on whether storage actually accepted the write', () => {
  const store = freshStore();
  assert.equal(saveReferences([createReference('book')], store), true);
  const failingStore: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(saveReferences([createReference('book')], failingStore), false);
  assert.equal(saveReferences([createReference('book')], null), false);
});

test('loadReferences: corrupted/malformed stored data safely falls back to [] rather than a partially-trusted list', () => {
  const store = freshStore();
  store.setItem('plasmatech.scientific-writer.references.v1', 'not json at all');
  assert.deepEqual(loadReferences(store), []);

  const store2 = freshStore();
  store2.setItem('plasmatech.scientific-writer.references.v1', JSON.stringify({ not: 'an array' }));
  assert.deepEqual(loadReferences(store2), []);

  const store3 = freshStore();
  store3.setItem('plasmatech.scientific-writer.references.v1', JSON.stringify([{ id: 'ok', type: 'book', authors: [] }, { totally: 'wrong shape' }]));
  assert.deepEqual(loadReferences(store3), [], 'one malformed entry drops the whole list rather than keeping a partially-trusted subset');
});

test('mergeReferencesById: concatenates distinct references and de-duplicates by id when the same reference appears in both lists', () => {
  const a = createReference('journal_article');
  const b = createReference('book');
  assert.deepEqual(mergeReferencesById([a], [b]), [a, b]);
  assert.deepEqual(mergeReferencesById([a], [a]), [a]);
  assert.equal(mergeReferencesById([a], [a, b]).length, 2);
});
