import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceModules, isWorkspaceModuleLive, moduleBadge, getWorkspaceModule } from '../src/modules/workspace/registry';
import { tools } from '../src/lib/content';

// Regression for the "full functional audit" finding: several already-working workspace
// modules were still labeled/routed as a canned demo. These tests pin the single source of
// truth (registry `mode`) and its two UI-facing derivations (workspace tool-grid routing/label,
// shell status badge) so a future module can never silently regress back to "Демо"/"DEMO".

test('every registered workspace module is live (no module silently reverted to demo mode)', () => {
  for (const item of workspaceModules) {
    assert.equal(item.mode, 'live', `expected ${item.id} to be live`);
  }
  assert.equal(workspaceModules.length, 6);
});

test('isWorkspaceModuleLive: true for every known module id, false for an unknown id (never throws)', () => {
  for (const item of workspaceModules) {
    assert.equal(isWorkspaceModuleLive(item.id), true);
  }
  // @ts-expect-error - deliberately an id outside the known union, to prove the lookup is safe
  assert.equal(isWorkspaceModuleLive('not-a-real-module'), false);
});

test('moduleBadge: SciFinder and the Library keep their existing bespoke labels, untouched', () => {
  assert.equal(moduleBadge('/workspace/scifinder'), 'SCIENTIFIC SEARCH');
  assert.equal(moduleBadge('/my-library'), 'LOCAL LIBRARY');
});

test('moduleBadge: every other live workspace module reports LIVE, never DEMO', () => {
  const liveSlugsExceptScifinder = workspaceModules.filter(m => m.id !== 'scifinder').map(m => m.slug);
  for (const slug of liveSlugsExceptScifinder) {
    assert.equal(moduleBadge(`/workspace/${slug}`), 'LIVE', `expected /workspace/${slug} to report LIVE`);
  }
});

test('moduleBadge: an unknown workspace slug or a non-workspace route reports DEMO, never crashes', () => {
  assert.equal(moduleBadge('/workspace/not-a-real-module'), 'DEMO');
  assert.equal(moduleBadge('/'), 'DEMO');
  assert.equal(moduleBadge('/about'), 'DEMO');
});

test('getWorkspaceModule: resolves every registered slug to its module + tool metadata', () => {
  for (const item of workspaceModules) {
    const resolved = getWorkspaceModule(item.slug);
    assert.ok(resolved);
    assert.equal(resolved?.mode, 'live');
    assert.equal(resolved?.tool.id, item.id);
  }
  assert.equal(getWorkspaceModule('not-a-real-slug'), undefined);
});

test('content.ts: no tool metadata still claims to be a non-functional demo/placeholder (regression against reintroducing false demo copy)', () => {
  for (const tool of tools) {
    const text = `${tool.note} ${tool.result.join(' ')}`.toLocaleLowerCase();
    assert.ok(!text.includes('демонстрационн'), `${tool.id}: note/result text still claims to be a demo: "${tool.note}"`);
    assert.ok(!text.includes('не выполняется') && !text.includes('не используются для расчета') && !text.includes('не генерируются'),
      `${tool.id}: note text still disclaims real functionality: "${tool.note}"`);
  }
});

test('src/app/page.tsx: the homepage no longer claims the (fully live) workspace is a demo (regression against reintroducing false demo copy)', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'app', 'page.tsx'), 'utf8').toLocaleLowerCase();
  assert.ok(!source.includes('демонстрационном режиме'), 'homepage must not claim the tools run "in demo mode"');
  assert.ok(!source.includes('демонстрационн'), 'homepage must not contain any "demo"-framing copy for the (live) workspace section');
});
