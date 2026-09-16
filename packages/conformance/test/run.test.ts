import { afterAll, describe, expect, test } from 'bun:test';
import { runVectors } from '../src/run';
import type { Vector } from '../src/types';

/** A bare fixture with no idempotency: every POST executes. Records when /slow handlers start and end. */
function bareFixture() {
  let count = 0;
  const slowWindows: Array<{ start: number; end: number }> = [];
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/reset') {
      count = 0;
      return new Response(null, { status: 204 });
    }
    if (req.method === 'GET' && url.pathname === '/counter') {
      return Response.json({ count });
    }
    if (req.method === 'POST' && url.pathname === '/echo') {
      count += 1;
      return new Response(await req.text(), {
        status: 201,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (req.method === 'POST' && url.pathname === '/slow') {
      count += 1;
      const ms = Number(url.searchParams.get('ms') ?? '0');
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      slowWindows.push({ start, end: Date.now() });
      return new Response(`slept:${ms}`, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { handler, slowWindows, count: () => count };
}

const echoTwice: Vector = {
  id: 'core/retry-replays',
  tier: 'core',
  title: 't',
  draftRef: 'section-2.6',
  description: 'd',
  fixture: 'echo',
  steps: [
    {
      id: 'first',
      request: { method: 'POST', path: '/echo', headers: { 'Idempotency-Key': 'k' }, body: 'a' },
      expect: { status: 201, bodyEquals: 'a', handlerInvocations: 1 },
    },
    {
      id: 'retry',
      request: { method: 'POST', path: '/echo', headers: { 'Idempotency-Key': 'k' }, body: 'a' },
      expect: { status: 201, bodyEquals: { sameAs: 'first' }, handlerInvocations: 1 },
    },
  ],
};

const concurrent: Vector = {
  id: 'core/concurrent-409',
  tier: 'core',
  title: 't',
  draftRef: 'section-2.6',
  description: 'd',
  fixture: 'slow',
  steps: [
    {
      id: 'original',
      request: {
        method: 'POST',
        path: '/slow?ms=400',
        headers: { 'Idempotency-Key': 'k' },
        body: 's',
      },
      expect: { status: 200 },
    },
    {
      id: 'duplicate',
      concurrentWith: ['original'],
      delayMs: 100,
      request: {
        method: 'POST',
        path: '/slow?ms=400',
        headers: { 'Idempotency-Key': 'k' },
        body: 's',
      },
      expect: { status: 409, handlerInvocations: 1 },
    },
  ],
};

const needsTtl: Vector = {
  ...echoTwice,
  id: 'core/expiry-executes-again',
  requires: ['short-ttl'],
};
const profileOnly: Vector = {
  ...echoTwice,
  id: 'profile/replayed-header',
  tier: 'profile',
  steps: [echoTwice.steps[0] as Vector['steps'][number]],
};

describe('runVectors', () => {
  test('REQ-CONF-1: a bare target fails the replay step with the counter failure and passes the first step', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [echoTwice]);
    expect(summary.failed).toBe(1);
    const result = summary.results[0];
    expect(result?.status).toBe('fail');
    expect(result?.steps[0]?.failures).toEqual([]);
    expect(result?.steps[1]?.failures).toEqual(['handlerInvocations: expected 1, got 2']);
  });

  test('REQ-CONF-1: concurrentWith sends the duplicate while the original is still in flight', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [concurrent]);
    expect(fx.slowWindows).toHaveLength(2);
    const [a, b] = fx.slowWindows as [
      { start: number; end: number },
      { start: number; end: number },
    ];
    const first = a.start < b.start ? a : b;
    const second = a.start < b.start ? b : a;
    expect(second.start).toBeGreaterThanOrEqual(first.start + 90);
    expect(second.start).toBeLessThan(first.end);
    expect(summary.results[0]?.steps[1]?.failures).toEqual([
      'status: expected 409, got 200',
      'handlerInvocations: expected 1, got 2',
    ]);
  });

  test('REQ-CONF-1: the counter is reset before every vector', async () => {
    const fx = bareFixture();
    const single: Vector = {
      ...echoTwice,
      id: 'core/post-executes-once',
      steps: [echoTwice.steps[0] as Vector['steps'][number]],
    };
    const summary = await runVectors(fx.handler, [single, single]);
    expect(summary.passed).toBe(2);
  });

  test('REQ-CONF-1: vectors whose requirements are not declared are not-applicable', async () => {
    const fx = bareFixture();
    const without = await runVectors(fx.handler, [needsTtl]);
    expect(without.results[0]?.status).toBe('not-applicable');
    expect(without.notApplicable).toBe(1);
    const withCap = await runVectors(fx.handler, [needsTtl], { capabilities: ['short-ttl'] });
    expect(withCap.results[0]?.status).toBe('fail');
  });

  test('REQ-CONF-1: tiers and only filter the vectors that run', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [echoTwice, profileOnly], { tiers: ['profile'] });
    expect(summary.results.map((r) => r.id)).toEqual(['profile/replayed-header']);
    const only = await runVectors(fx.handler, [echoTwice, profileOnly], {
      only: ['core/retry-replays'],
    });
    expect(only.results.map((r) => r.id)).toEqual(['core/retry-replays']);
  });

  test('REQ-CONF-1: a target that cannot be reset yields an error result', async () => {
    const summary = await runVectors(
      async () => new Response('nope', { status: 500 }),
      [echoTwice],
    );
    expect(summary.results[0]?.status).toBe('error');
    expect(summary.errored).toBe(1);
  });
});

describe('URL target', () => {
  const fx = bareFixture();
  const server = Bun.serve({ port: 0, fetch: fx.handler });
  afterAll(() => server.stop(true));

  test('REQ-CONF-1: baseUrl targets are driven over real HTTP', async () => {
    const summary = await runVectors({ baseUrl: `http://127.0.0.1:${server.port}` }, [echoTwice]);
    expect(summary.results[0]?.steps[0]?.failures).toEqual([]);
    expect(summary.results[0]?.steps[1]?.failures).toEqual([
      'handlerInvocations: expected 1, got 2',
    ]);
  });
});
