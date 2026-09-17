import { describe, expect, test } from 'bun:test';
import { fromIoredis, fromNodeRedis, fromUpstash } from '../src/redis';

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
    const client = {
      evalsha: async (sha: string, keys: string[], args: string[]) => [sha, keys, args],
      eval: async (s: string, keys: string[], args: string[]) => [s, keys, args],
      hgetall: async (_key: string) => null,
      del: async (_key: string) => 1,
    };
    const a = fromUpstash(client);
    expect(await a.evalsha('sha', ['k'], ['x'])).toEqual(['sha', ['k'], ['x']]);
    expect(await a.hgetall('k')).toEqual({});
  });
});
