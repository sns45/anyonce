import { afterAll, describe, expect, test } from 'bun:test';
import { LEASE_MS, storeContractSuite, T0, TTL_MS } from '@anyonce/core/testing';
import Redis from 'ioredis';
import { createClient } from 'redis';
import { fromIoredis, fromNodeRedis, type RedisAdapter, RedisStore } from '../src/redis';
import { describeService } from './services';

await describeService('redis store', 6379, () => {
  const io = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
  const node = createClient({ url: 'redis://127.0.0.1:6379' });
  const nodeReady = node.connect();

  afterAll(async () => {
    await io.quit();
    await nodeReady;
    await node.quit();
  });

  storeContractSuite(
    'redis-ioredis',
    () => {
      const store = new RedisStore({ adapter: fromIoredis(io), prefix: `t${Date.now()}:` });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
    { nativePurge: true },
  );

  storeContractSuite(
    'redis-node-redis',
    async () => {
      await nodeReady;
      const store = new RedisStore({ adapter: fromNodeRedis(node), prefix: `n${Date.now()}:` });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
    { nativePurge: true },
  );

  describe('redis specifics', () => {
    test('REQ-ST-REDIS-1: EVALSHA is tried first and EVAL is the fallback after SCRIPT FLUSH, then the sha is cached again', async () => {
      const calls: string[] = [];
      const inner = fromIoredis(io);
      const adapter: RedisAdapter = {
        evalsha: (sha, keys, args) => {
          calls.push('evalsha');
          return inner.evalsha(sha, keys, args);
        },
        eval: (script, keys, args) => {
          calls.push('eval');
          return inner.eval(script, keys, args);
        },
        hgetall: (key) => inner.hgetall(key),
        del: (key) => inner.del(key),
      };
      const store = new RedisStore({ adapter, prefix: `f${Date.now()}:` });
      const op = { scope: 's', key: 'k', fingerprint: 'a' };
      await io.script('FLUSH');
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
      expect(calls).toEqual(['evalsha', 'eval']);
      calls.length = 0;
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 1 });
      expect(calls).toEqual(['evalsha']);
    });

    test('REQ-ST-REDIS-1: the hash carries a native PEXPIRE relative to the wall clock and purge is a no-op', async () => {
      const store = new RedisStore({
        adapter: fromIoredis(io),
        prefix: `p${Date.now()}:`,
        nativeTtlGraceMs: 60_000,
      });
      const op = { scope: 's', key: 'k', fingerprint: 'a' };
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: 5_000, now: T0 });
      const pttl = await io.pttl(store.keyFor(op));
      expect(pttl).toBeGreaterThan(60_000);
      expect(pttl).toBeLessThan(65_001);
      expect(await store.purge(Date.now())).toBe(0);
    });
  });
});
