import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { runConformance } from '@anyonce/conformance/runtime';
import { withIdempotency } from '@anyonce/core/http';
import { LEASE_MS, storeContractSuite, T0 } from '@anyonce/core/testing';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { describe, expect, test } from 'vitest';
import { DurableObjectsStore, type IdempotencyObject } from '../src/durable-objects';

const runner = {
  describe,
  test: (name: string, fn: () => Promise<void>, timeoutMs?: number) => test(name, fn, timeoutMs),
  expect,
};

for (const shard of ['scope', 'scope-key'] as const) {
  storeContractSuite(
    `durable-objects-${shard}`,
    () => {
      // trackForPurge, because REQ-STORE-7 in the suite asserts a purge count from the Worker side.
      const store = new DurableObjectsStore({
        namespace: env.IDEMPOTENCY,
        shard,
        trackForPurge: true,
      });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    runner,
  );
}

describe('durable objects specifics', () => {
  test('REQ-ST-DO-1: 50 parallel stub.begin calls on one object yield exactly one acquired', async () => {
    const stub = env.IDEMPOTENCY.get(
      env.IDEMPOTENCY.idFromName('race'),
    ) as DurableObjectStub<IdempotencyObject>;
    const op = { scope: 'race', key: 'k', fingerprint: 'a' };
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        stub.begin(op, { leaseMs: LEASE_MS, ttlMs: 60_000, now: T0 }, 60_000),
      ),
    );
    expect(outcomes.filter((o) => o.outcome === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'in_flight')).toHaveLength(49);
  });

  test('REQ-ST-DO-1: purge does nothing without trackForPurge and sweeps the addressed objects with it', async () => {
    const op = { scope: 'purge-opt-in', key: 'k', fingerprint: 'a' };
    const untracked = new DurableObjectsStore({ namespace: env.IDEMPOTENCY, shard: 'scope' });
    await untracked.begin(op, { leaseMs: LEASE_MS, ttlMs: 1_000, now: T0 });
    expect(await untracked.purge(T0 + 5_000)).toBe(0);
    const stub = env.IDEMPOTENCY.get(
      env.IDEMPOTENCY.idFromName('purge-opt-in'),
    ) as DurableObjectStub<IdempotencyObject>;
    const before = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec('SELECT key FROM anyonce_records').toArray(),
    );
    expect(before.map((r) => r.key)).toEqual(['k']);

    const tracked = new DurableObjectsStore({
      namespace: env.IDEMPOTENCY,
      shard: 'scope',
      trackForPurge: true,
    });
    await tracked.get(op, T0 + 1);
    expect(await tracked.purge(T0 + 5_000)).toBe(1);
    const after = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec('SELECT key FROM anyonce_records').toArray(),
    );
    expect(after).toEqual([]);
  });

  test('REQ-ST-DO-1: the alarm purges rows whose wall clock expiry has passed and reschedules for the rest', async () => {
    const store = new DurableObjectsStore({
      namespace: env.IDEMPOTENCY,
      shard: 'scope',
      nativeTtlGraceMs: 0,
    });
    const soon = { scope: 'alarm', key: 'soon', fingerprint: 'a' };
    const later = { scope: 'alarm', key: 'later', fingerprint: 'a' };
    await store.begin(soon, { leaseMs: LEASE_MS, ttlMs: 0, now: T0 });
    await store.begin(later, { leaseMs: LEASE_MS, ttlMs: 3_600_000, now: T0 });
    const stub = env.IDEMPOTENCY.get(
      env.IDEMPOTENCY.idFromName('alarm'),
    ) as DurableObjectStub<IdempotencyObject>;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT key FROM anyonce_records').toArray(),
    );
    expect(rows.map((r) => r.key)).toEqual(['later']);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();
  });

  test('REQ-ST-DO-1: every core and profile vector passes inside workerd through withIdempotency with the Durable Objects store', async () => {
    const modules = import.meta.glob('../../../conformance/vectors/{core,profile}/*.json', {
      eager: true,
      import: 'default',
    });
    const vectors = Object.values(modules) as Parameters<typeof runConformance>[0]['vectors'];
    expect(vectors?.length).toBe(20);
    const handler = withIdempotency(createFixtureApp().fetch, {
      store: new DurableObjectsStore({ namespace: env.IDEMPOTENCY }),
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
