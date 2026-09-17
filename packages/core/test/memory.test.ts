import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory';
import { LEASE_MS, storeContractSuite, T0, TTL_MS } from '../src/testing/index';

storeContractSuite(
  'memory',
  () => {
    const store = new MemoryStore();
    return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
  },
  { describe, test, expect },
);

describe('MemoryStore extras', () => {
  test('REQ-CORE-6: records returned to callers are copies, mutating them does not change the store', async () => {
    const store = new MemoryStore();
    const op = { scope: 's', key: 'k', fingerprint: 'f' };
    await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
    const body = new Uint8Array([9, 9]);
    await store.complete(op, 1, { kind: 'http', status: 200, body }, T0 + 1);
    body[0] = 1;
    const rec = await store.get(op, T0 + 2);
    expect(rec?.result?.body?.[0]).toBe(9);
    if (rec?.result?.body) rec.result.body[1] = 1;
    expect((await store.get(op, T0 + 3))?.result?.body?.[1]).toBe(9);
  });

  test('REQ-CORE-6: size and physicallyRemove reflect the map', async () => {
    const store = new MemoryStore();
    const op = { scope: 's', key: 'k', fingerprint: 'f' };
    await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
    expect(store.size).toBe(1);
    await store.physicallyRemove(op);
    expect(store.size).toBe(0);
  });
});
