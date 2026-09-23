import test from 'node:test';
import assert from 'node:assert/strict';

/** Regression / build-gate test for F01: a Next.js App Router `route.ts` module may ONLY
 *  export the names Next itself recognizes (HTTP method handlers + a small set of route
 *  config options) - listed below exactly as Next.js 16.3.5 generates them in
 *  `.next/types/app/**\/route.ts`. Any OTHER named export (e.g. a helper function a test wants
 *  to import directly) is silently accepted by `next build` (Turbopack) but makes the
 *  production `next build --webpack` fail with a TS2344 "does not satisfy the constraint"
 *  error - a real BLOCKER that a Turbopack-only build never catches. This test statically
 *  enforces the same constraint Next's generated type-checker enforces, without needing to run
 *  a full webpack build in CI. */
const ALLOWED_ROUTE_EXPORTS = new Set([
  'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH',
  'config', 'generateStaticParams', 'instant', 'prefetch', 'unstable_dynamicStaleTime',
  'revalidate', 'dynamic', 'dynamicParams', 'fetchCache', 'preferredRegion', 'runtime', 'maxDuration',
]);

const ROUTE_MODULES = [
  '../src/app/api/library/ask/route',
  '../src/app/api/library/pdf/route',
  '../src/app/api/library/route',
  '../src/app/api/library/semantic/route',
  '../src/app/api/library/text/route',
  '../src/app/api/scifinder/search/route',
  '../src/app/api/workspace/anti-plagiarism/route',
  '../src/app/api/workspace/scientific-writer/export/route',
  '../src/app/api/workspace/scientific-writer/route',
  '../src/app/api/workspace/techdoc/export/route',
];

for (const modulePath of ROUTE_MODULES) {
  test(`route module exports only Next.js-recognized names: ${modulePath}`, async () => {
    const mod = await import(modulePath);
    const disallowed = Object.keys(mod).filter(key => !ALLOWED_ROUTE_EXPORTS.has(key));
    assert.deepEqual(disallowed, [], `${modulePath} exports non-route names (would fail \`next build --webpack\`'s route-type check): ${disallowed.join(', ')}`);
  });
}
