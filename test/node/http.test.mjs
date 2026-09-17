import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureApp } from '../../conformance/fixtures/hono/dist/app.js';
import { runConformance } from '../../packages/conformance/dist/index.js';
import { withIdempotency } from '../../packages/core/dist/http/index.js';
import { MemoryStore } from '../../packages/core/dist/index.js';
import { idempotency } from '../../packages/hono/dist/index.js';

test('NFR-4: every vector passes on Node through withIdempotency', {
  timeout: 60_000,
}, async () => {
  const app = createFixtureApp();
  const handler = withIdempotency(app.fetch, {
    store: new MemoryStore(),
    required: true,
    ttlMs: 2000,
    skip: (req) => new URL(req.url).pathname === '/reset',
  });
  const { summary, report } = await runConformance({
    target: handler,
    capabilities: ['short-ttl'],
  });
  assert.equal(summary.failed + summary.errored + summary.notApplicable, 0, report);
});

test('NFR-4: every vector passes on Node through the Hono middleware', {
  timeout: 60_000,
}, async () => {
  const app = createFixtureApp(
    { count: 0 },
    idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }),
  );
  const { summary, report } = await runConformance({
    target: app.fetch,
    capabilities: ['short-ttl'],
  });
  assert.equal(summary.failed + summary.errored + summary.notApplicable, 0, report);
});
