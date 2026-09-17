import { describe, expect, test } from 'bun:test';
import { fromIoredis, fromNodeRedis, fromUpstash, RedisStore } from '../src/redis';

describe('redis adapters', () => {
  test('REQ-ST-REDIS-1: fromIoredis spreads keys and args after numkeys', async () => {
    const calls: unknown[][] = [];
    const client = {
      evalsha: async (...args: unknown[]) => {
        calls.push(['evalsha', ...args]);
        return 1;
      },
      eval: async (...args: unknown[]) => {
        calls.push(['eval', ...args]);
        return 2;
      },
      hgetall: async (key: string) => {
        calls.push(['hgetall', key]);
        return { a: '1' };
      },
      del: async (key: string) => {
        calls.push(['del', key]);
        return 1;
      },
    };
    const a = fromIoredis(client);
    expect(await a.evalsha('sha', ['k'], ['x', 'y'])).toBe(1);
    expect(await a.eval('script', ['k'], ['x'])).toBe(2);
    expect(await a.hgetall('k')).toEqual({ a: '1' });
    await a.del('k');
    expect(calls).toEqual([
      ['evalsha', 'sha', 1, 'k', 'x', 'y'],
      ['eval', 'script', 1, 'k', 'x'],
      ['hgetall', 'k'],
      ['del', 'k'],
    ]);
  });

  test('REQ-ST-REDIS-1: fromNodeRedis passes keys and arguments as an options object', async () => {
    const calls: unknown[][] = [];
    const client = {
      evalSha: async (sha: string, o: unknown) => {
        calls.push(['evalSha', sha, o]);
        return 1;
      },
      eval: async (s: string, o: unknown) => {
        calls.push(['eval', s, o]);
        return 2;
      },
      hGetAll: async (key: string) => {
        calls.push(['hGetAll', key]);
        return { a: '1' };
      },
      del: async (key: string) => {
        calls.push(['del', key]);
        return 1;
      },
    };
    const a = fromNodeRedis(client);
    await a.evalsha('sha', ['k'], ['x']);
    await a.eval('s', ['k'], []);
    expect(await a.hgetall('k')).toEqual({ a: '1' });
    await a.del('k');
    expect(calls).toEqual([
      ['evalSha', 'sha', { keys: ['k'], arguments: ['x'] }],
      ['eval', 's', { keys: ['k'], arguments: [] }],
      ['hGetAll', 'k'],
      ['del', 'k'],
    ]);
  });

  test('REQ-ST-REDIS-1: fromUpstash passes keys and args arrays and maps a null hgetall to an empty object', async () => {
    const calls: unknown[][] = [];
    const client = {
      evalsha: async (sha: string, keys: string[], args: string[]) => {
        calls.push(['evalsha', sha, keys, args]);
        return 'ok';
      },
      eval: async (s: string, keys: string[], args: string[]) => {
        calls.push(['eval', s, keys, args]);
        return 'ok';
      },
      hgetall: async (_key: string) => null,
      del: async (_key: string) => 1,
    };
    const a = fromUpstash(client);
    expect(await a.evalsha('sha', ['k'], ['x'])).toBe('ok');
    expect(await a.eval('script', ['k'], ['x'])).toBe('ok');
    expect(await a.hgetall('k')).toEqual({});
    expect(calls).toEqual([
      ['evalsha', 'sha', ['k'], ['x']],
      ['eval', 'script', ['k'], ['x']],
    ]);
  });

  test('REQ-ST-REDIS-1: fromUpstash puts an automaticDeserialization reply back to text', async () => {
    const meta = { kind: 'http', status: 201 };
    const client = {
      evalsha: async () => ['completed', 'result_meta', meta, 'fence', 1],
      eval: async () => ['mismatch', 'result_meta', meta],
      hgetall: async (_key: string) => ({ result_meta: meta, fence: 1, fingerprint: 'a' }),
      del: async (_key: string) => 1,
    };
    const a = fromUpstash(client);
    expect(await a.hgetall('k')).toEqual({
      result_meta: '{"kind":"http","status":201}',
      fence: '1',
      fingerprint: 'a',
    });
    expect(await a.evalsha('sha', ['k'], [])).toEqual([
      'completed',
      'result_meta',
      '{"kind":"http","status":201}',
      'fence',
      1,
    ]);
    expect(await a.eval('s', ['k'], [])).toEqual([
      'mismatch',
      'result_meta',
      '{"kind":"http","status":201}',
    ]);
  });

  test('REQ-ST-REDIS-1: a completed record decodes through fromUpstash even with the replies deserialized', async () => {
    const client = {
      evalsha: async () => [
        'completed',
        'fingerprint',
        'a',
        'state',
        'completed',
        'fence',
        1,
        'lease_until',
        0,
        'created_at',
        0,
        'expires_at',
        9_999_999_999_999,
        'result_meta',
        { kind: 'http', status: 201, headers: [['Content-Type', 'text/plain']] },
        'result_omitted',
        0,
      ],
      eval: async () => [],
      hgetall: async (_key: string) => null,
      del: async (_key: string) => 1,
    };
    const store = new RedisStore({ adapter: fromUpstash(client) });
    const outcome = await store.begin(
      { scope: 's', key: 'k', fingerprint: 'a' },
      { now: 0, leaseMs: 1_000, ttlMs: 2_000 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;
    expect(outcome.record.result?.status).toBe(201);
    expect(outcome.record.result?.headers).toEqual([['Content-Type', 'text/plain']]);
  });
});
