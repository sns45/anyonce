import { env } from 'cloudflare:test';
import { runConformance } from '@anyonce/conformance/runtime';
import { withIdempotency } from '@anyonce/core/http';
import { storeContractSuite } from '@anyonce/core/testing';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { describe, expect, test } from 'vitest';
import { D1Store, ensureSchema } from '../src/d1';

const runner = {
  describe,
  test: (name: string, fn: () => Promise<void>, timeoutMs?: number) => test(name, fn, timeoutMs),
  expect,
};

storeContractSuite(
  'd1',
  async () => {
    await ensureSchema(env.DB);
    const store = new D1Store({ db: env.DB });
    return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
  },
  runner,
);

describe('d1 specifics', () => {
  test('REQ-ST-D1-1: ensureSchema is idempotent on top of the applied migration', async () => {
    await ensureSchema(env.DB);
    await ensureSchema(env.DB);
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'anyonce_records_expires_at'",
    ).all();
    expect(results).toHaveLength(1);
  });

  test('REQ-ST-D1-1: every core and profile vector passes inside workerd through withIdempotency with the D1 store', async () => {
    const modules = import.meta.glob('../../../conformance/vectors/{core,profile}/*.json', {
      eager: true,
      import: 'default',
    });
    const vectors = Object.values(modules) as Parameters<typeof runConformance>[0]['vectors'];
    expect(vectors?.length).toBe(20);
    await ensureSchema(env.DB);
    const handler = withIdempotency(createFixtureApp().fetch, {
      store: new D1Store({ db: env.DB }),
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary, report } = await runConformance({
      target: handler,
      capabilities: ['short-ttl'],
      vectors,
      report: 'markdown',
    });
    expect(
      summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`),
      report,
    ).toEqual([]);
  }, 60_000);
});
