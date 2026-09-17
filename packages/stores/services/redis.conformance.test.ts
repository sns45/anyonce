import { expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import Redis from 'ioredis';
import { fromIoredis, RedisStore } from '../src/redis';
import { describeService } from './services';

await describeService('redis conformance', 6379, () => {
  test('REQ-ST-REDIS-1: every core and profile vector passes through withIdempotency with the Redis store', async () => {
    const client = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
    const store = new RedisStore({
      adapter: fromIoredis(client),
      prefix: `conf${Date.now()}:`,
    });
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
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
    await client.quit();
  }, 60_000);
});
