import { expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { defaultScope, withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { Pool } from 'pg';
import { ensureSchema, PostgresStore } from '../src/postgres';
import { describeService } from './services';

const CONNECTION_STRING = 'postgres://anyonce:anyonce@127.0.0.1:15432/anyonce';

await describeService('postgres conformance', 15432, () => {
  test('REQ-ST-PG-1: every core and profile vector passes through withIdempotency with the Postgres store', async () => {
    const client = new Pool({ connectionString: CONNECTION_STRING });
    await ensureSchema(client);
    const store = new PostgresStore({ query: client });
    const runId = Date.now();
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: 2000,
      scope: (req) => `conf${runId}:${defaultScope(req)}`,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    try {
      const { summary, report } = await runConformance({
        target: handler,
        capabilities: ['short-ttl'],
        report: 'markdown',
      });
      const notPassing = summary.results
        .filter((r) => r.status !== 'pass')
        .map((r) => `${r.id}: ${r.status}`);
      expect(notPassing, report).toEqual([]);
      expect(summary.passed).toBe(20);
    } finally {
      // A failed run must still release the pool, otherwise bun hangs on the open handle.
      await client.end();
    }
  }, 60_000);
});
