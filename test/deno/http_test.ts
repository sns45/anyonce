/// <reference lib="deno.ns" />
// This suite runs with `deno test --no-check` because tsup's dts plugin emits declaration-only
// chunk files that `deno check` cannot resolve; `bun run typecheck` already covers the sources.
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '@anyonce/hono';

function assertAllPassed(
  summary: { failed: number; errored: number; notApplicable: number },
  report: string,
): void {
  if (summary.failed + summary.errored + summary.notApplicable !== 0) throw new Error(report);
}

Deno.test('NFR-4: every vector passes on Deno through withIdempotency', async () => {
  const app = createFixtureApp();
  const handler = withIdempotency(app.fetch, {
    store: new MemoryStore(),
    required: true,
    ttlMs: 2000,
    skip: (req: Request) => new URL(req.url).pathname === '/reset',
  });
  const { summary, report } = await runConformance({
    target: handler,
    capabilities: ['short-ttl'],
  });
  assertAllPassed(summary, report);
});

Deno.test('NFR-4: every vector passes on Deno through the Hono middleware', async () => {
  const app = createFixtureApp(
    { count: 0 },
    idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }),
  );
  const { summary, report } = await runConformance({
    target: app.fetch,
    capabilities: ['short-ttl'],
  });
  assertAllPassed(summary, report);
});
