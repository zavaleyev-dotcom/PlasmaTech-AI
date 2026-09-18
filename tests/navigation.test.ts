import test from 'node:test';
import assert from 'node:assert/strict';
import { navigation } from '../src/lib/content';

// ---------- canonical library route + unambiguous navigation labels (Codex regression) ----------
//
// Note: src/app/[section]/page.tsx (generateStaticParams/generateMetadata) is NOT imported
// here - importing any page/component file that pulls in `next/link` fails in this test
// runner's react-server environment (next/link's client-side router context is incompatible
// with it - a tooling limitation, not something this test file can work around). The parts of
// the navigation fix that live in page.tsx are instead verified via the production build's
// own static-route listing (which genuinely invokes generateStaticParams) and a live smoke
// test against the dev server - see the final report for both.

test('navigation lists both /library and /my-library with distinct, unambiguous labels', () => {
  const library = navigation.find(n => n.href === '/library');
  const myLibrary = navigation.find(n => n.href === '/my-library');
  assert.ok(library, '/library must still be reachable from navigation - never silently removed');
  assert.ok(myLibrary, '/my-library (the canonical, fully working local-library route) must be reachable from navigation');
  assert.notEqual(library!.label, myLibrary!.label, 'the two routes must never share an ambiguous label a user could confuse');
  assert.equal(library!.label, 'База знаний', 'the static glossary route is labeled for what it actually is - a knowledge base, not "the library"');
  assert.equal(myLibrary!.label, 'Моя библиотека');
});

test('navigation still lists every other pre-existing route unchanged - the rename touched only /library\'s label', () => {
  const hrefs = navigation.map(n => n.href);
  assert.deepEqual(hrefs, ['/', '/about', '/expertise', '/projects', '/workspace', '/library', '/my-library', '/contacts']);
  assert.equal(navigation.find(n => n.href === '/')!.label, 'Главная');
  assert.equal(navigation.find(n => n.href === '/workspace')!.label, 'AI Workspace');
});
