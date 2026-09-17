import type { BeginOutcome, IdempotencyRecord, Operation, Store, StoredResult } from '../types';

export interface StoreHarness {
  store: Store;
  /** Simulates a store's native TTL sweep removing the row. Stores without native TTL can omit it; purge is used instead. */
  physicallyRemove?: (op: Pick<Operation, 'scope' | 'key'>) => Promise<void>;
  close?: () => Promise<void>;
}

export type StoreFactory = () => StoreHarness | Promise<StoreHarness>;

export interface MatchersLike {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeGreaterThan(expected: number): void;
}

export interface StoreSuiteRunner {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  expect(actual: unknown): MatchersLike;
}

export const T0 = 1_700_000_000_000;
export const LEASE_MS = 30_000;
export const TTL_MS = 86_400_000;
export const MAX_RESULT_BYTES = 1_048_576;

const httpResult: StoredResult = {
  kind: 'http',
  status: 201,
  headers: [['Content-Type', 'text/plain']],
  body: new Uint8Array([1, 2, 3, 255, 0, 7]),
};

function expectAcquired(
  expect: StoreSuiteRunner['expect'],
  outcome: BeginOutcome,
  fence: number,
): void {
  expect(outcome.outcome).toBe('acquired');
  if (outcome.outcome === 'acquired') expect(outcome.fence).toBe(fence);
}

function recordOf(outcome: BeginOutcome): IdempotencyRecord | undefined {
  return outcome.outcome === 'completed' || outcome.outcome === 'mismatch'
    ? outcome.record
    : undefined;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The shared store contract (requirements 4.2). Every store in every language must pass it. The runner is
 * injected so the same file runs under bun test, vitest and vitest-pool-workers.
 */
export function storeContractSuite(
  name: string,
  factory: StoreFactory,
  runner: StoreSuiteRunner,
): void {
  const { describe, test, expect } = runner;
  const unique = crypto.randomUUID();
  const op = (tag: string, fingerprint = 'fp-a'): Operation => ({
    scope: `suite:${name}:${unique}:${tag}`,
    key: `key-${tag}`,
    fingerprint,
  });
  const opts = (now: number) => ({ leaseMs: LEASE_MS, ttlMs: TTL_MS, now });

  const withHarness = (fn: (h: StoreHarness) => Promise<void>) => async () => {
    const h = await factory();
    try {
      await fn(h);
    } finally {
      if (h.close) await h.close();
      else await h.store.close?.();
    }
  };

  describe(`store contract: ${name}`, () => {
    test(
      'REQ-STORE-1: begin on an absent record returns acquired with fence 1',
      withHarness(async (h) => {
        expectAcquired(expect, await h.store.begin(op('s1'), opts(T0)), 1);
      }),
    );

    test(
      'REQ-STORE-2: a second begin with the same fingerprint while the lease is live returns in_flight with the same leaseUntil',
      withHarness(async (h) => {
        const o = op('s2');
        await h.store.begin(o, opts(T0));
        const second = await h.store.begin(o, opts(T0 + 1000));
        expect(second.outcome).toBe('in_flight');
        if (second.outcome === 'in_flight') expect(second.leaseUntil).toBe(T0 + LEASE_MS);
        const third = await h.store.begin(o, opts(T0 + LEASE_MS - 1));
        expect(third.outcome).toBe('in_flight');
      }),
    );

    test(
      'REQ-STORE-3: begin with a different fingerprint returns mismatch while in_flight',
      withHarness(async (h) => {
        const o = op('s3a');
        await h.store.begin(o, opts(T0));
        const out = await h.store.begin(op('s3a', 'fp-b'), opts(T0 + 10));
        expect(out.outcome).toBe('mismatch');
        expect(recordOf(out)?.fingerprint).toBe('fp-a');
        expect(recordOf(out)?.state).toBe('in_flight');
      }),
    );

    test(
      'REQ-STORE-3: begin with a different fingerprint returns mismatch when completed',
      withHarness(async (h) => {
        const o = op('s3b');
        await h.store.begin(o, opts(T0));
        await h.store.complete(o, 1, httpResult, T0 + 5);
        const out = await h.store.begin(op('s3b', 'fp-b'), opts(T0 + 10));
        expect(out.outcome).toBe('mismatch');
        expect(recordOf(out)?.state).toBe('completed');
      }),
    );

    test(
      'REQ-STORE-3: a lease-expired record with a different fingerprint still yields mismatch',
      withHarness(async (h) => {
        const o = op('s3c');
        await h.store.begin(o, opts(T0));
        const out = await h.store.begin(op('s3c', 'fp-b'), opts(T0 + LEASE_MS + 1));
        expect(out.outcome).toBe('mismatch');
      }),
    );

    test(
      'REQ-STORE-4: complete then begin returns completed with the stored result byte-exact',
      withHarness(async (h) => {
        const o = op('s4');
        await h.store.begin(o, opts(T0));
        expect(await h.store.complete(o, 1, httpResult, T0 + 5)).toBe('ok');
        const out = await h.store.begin(o, opts(T0 + 10));
        expect(out.outcome).toBe('completed');
        const rec = recordOf(out);
        expect(rec?.state).toBe('completed');
        expect(rec?.fence).toBe(1);
        expect(rec?.result?.kind).toBe('http');
        expect(rec?.result?.status).toBe(201);
        expect(rec?.result?.headers).toEqual([['Content-Type', 'text/plain']]);
        expect(bytesEqual(rec?.result?.body, httpResult.body as Uint8Array)).toBe(true);
        expect(rec?.resultOmitted ?? false).toBe(false);
      }),
    );

    test(
      'REQ-STORE-4: complete on an absent record returns not_found and completing twice with the same fence is ok',
      withHarness(async (h) => {
        const o = op('s4b');
        expect(await h.store.complete(o, 1, httpResult, T0)).toBe('not_found');
        await h.store.begin(o, opts(T0));
        expect(await h.store.complete(o, 1, httpResult, T0 + 1)).toBe('ok');
        expect(await h.store.complete(o, 1, httpResult, T0 + 2)).toBe('ok');
      }),
    );

    test(
      'REQ-STORE-4: a message result with outcome error and two headers round trips',
      withHarness(async (h) => {
        const o = op('s4c');
        const message: StoredResult = {
          kind: 'message',
          outcome: 'error',
          error: { name: 'HandlerError', message: 'boom' },
          headers: [
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
          ],
          body: new Uint8Array([9, 8, 7]),
        };
        await h.store.begin(o, opts(T0));
        expect(await h.store.complete(o, 1, message, T0 + 1)).toBe('ok');
        const out = await h.store.begin(o, opts(T0 + 2));
        expect(out.outcome).toBe('completed');
        const stored = recordOf(out)?.result;
        expect(stored?.kind).toBe('message');
        expect(stored?.outcome).toBe('error');
        expect(stored?.error).toEqual({ name: 'HandlerError', message: 'boom' });
        expect(stored?.headers?.length).toBe(2);
        expect(stored?.headers).toEqual([
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
        ]);
        expect(bytesEqual(stored?.body, message.body as Uint8Array)).toBe(true);
      }),
    );

    test(
      'REQ-STORE-5: lease takeover yields fence 2 and a complete with fence 1 is stale and leaves the record unchanged',
      withHarness(async (h) => {
        const o = op('s5');
        expectAcquired(expect, await h.store.begin(o, opts(T0)), 1);
        expectAcquired(expect, await h.store.begin(o, opts(T0 + LEASE_MS)), 2);
        expect(await h.store.complete(o, 1, httpResult, T0 + LEASE_MS + 1)).toBe('stale_fence');
        const rec = await h.store.get(o, T0 + LEASE_MS + 2);
        expect(rec?.state).toBe('in_flight');
        expect(rec?.fence).toBe(2);
        expect(rec?.result).toBeUndefined();
        expect(rec?.leaseUntil).toBe(T0 + LEASE_MS + LEASE_MS);
      }),
    );

    test(
      'REQ-STORE-6: abandon removes the in-flight record and begin afterwards acquires again',
      withHarness(async (h) => {
        const o = op('s6');
        await h.store.begin(o, opts(T0));
        expect(await h.store.abandon(o, 2)).toBe('stale_fence');
        expect(await h.store.abandon(o, 1)).toBe('ok');
        expect(await h.store.get(o, T0 + 1)).toBeNull();
        expect(await h.store.abandon(o, 1)).toBe('not_found');
        expectAcquired(expect, await h.store.begin(o, opts(T0 + 2)), 1);
      }),
    );

    test(
      'REQ-STORE-7: after expiresAt begin acquires with the fence continued from the stale row',
      withHarness(async (h) => {
        const o = op('s7a');
        await h.store.begin(o, opts(T0));
        await h.store.complete(o, 1, httpResult, T0 + 1);
        expect(await h.store.get(o, T0 + TTL_MS)).toBeNull();
        expectAcquired(expect, await h.store.begin(o, opts(T0 + TTL_MS)), 2);
        const rec = await h.store.get(o, T0 + TTL_MS + 1);
        expect(rec?.state).toBe('in_flight');
        expect(rec?.expiresAt).toBe(T0 + TTL_MS + TTL_MS);
        expect(rec?.result).toBeUndefined();
        expect(rec?.resultOmitted ?? false).toBe(false);
      }),
    );

    test(
      'REQ-STORE-7: a ttl-expired row with a different fingerprint yields acquired',
      withHarness(async (h) => {
        const o = op('s7b');
        await h.store.begin(o, opts(T0));
        expectAcquired(expect, await h.store.begin(op('s7b', 'fp-b'), opts(T0 + TTL_MS)), 2);
      }),
    );

    test(
      'REQ-STORE-7: purge removes expired records and returns how many',
      withHarness(async (h) => {
        await h.store.begin(op('s7c'), opts(T0));
        await h.store.begin(op('s7d'), opts(T0 + 1000));
        const removed = await h.store.purge(T0 + TTL_MS + 500);
        expect(removed).toBeGreaterThan(0);
        expect(await h.store.get(op('s7c'), T0 + TTL_MS + 500)).toBeNull();
        expect((await h.store.get(op('s7d'), T0 + TTL_MS + 500))?.state).toBe('in_flight');
      }),
    );

    test(
      'REQ-STORE-7: a physically removed row restarts the fence at 1',
      withHarness(async (h) => {
        const o = op('s7e');
        await h.store.begin(o, opts(T0));
        await h.store.begin(o, opts(T0 + LEASE_MS));
        if (h.physicallyRemove) await h.physicallyRemove(o);
        else await h.store.purge(T0 + TTL_MS + LEASE_MS);
        expectAcquired(expect, await h.store.begin(o, opts(T0 + TTL_MS + LEASE_MS)), 1);
      }),
    );

    test(
      'REQ-STORE-8: 50 concurrent begins yield exactly one acquired and 49 in_flight, 20 iterations',
      withHarness(async (h) => {
        for (let iteration = 0; iteration < 20; iteration++) {
          const o = op(`s8-${iteration}`);
          const gate = Promise.resolve();
          const outcomes = await Promise.all(
            Array.from({ length: 50 }, () => gate.then(() => h.store.begin(o, opts(T0)))),
          );
          const acquired = outcomes.filter((x) => x.outcome === 'acquired').length;
          const inFlight = outcomes.filter((x) => x.outcome === 'in_flight').length;
          expect(acquired).toBe(1);
          expect(inFlight).toBe(49);
        }
      }),
      60_000,
    );

    test(
      'REQ-STORE-9: the same key under two scopes yields two independent records',
      withHarness(async (h) => {
        const a: Operation = {
          scope: `suite:${name}:${unique}:s9-a`,
          key: 'shared-key',
          fingerprint: 'fp-a',
        };
        const b: Operation = {
          scope: `suite:${name}:${unique}:s9-b`,
          key: 'shared-key',
          fingerprint: 'fp-a',
        };
        expectAcquired(expect, await h.store.begin(a, opts(T0)), 1);
        expectAcquired(expect, await h.store.begin(b, opts(T0)), 1);
        await h.store.complete(a, 1, httpResult, T0 + 1);
        expect((await h.store.begin(b, opts(T0 + 2))).outcome).toBe('in_flight');
        expect((await h.store.begin(a, opts(T0 + 2))).outcome).toBe('completed');
      }),
    );

    test(
      'REQ-STORE-10: the omitted form completes with resultOmitted, no body, and status and headers intact',
      withHarness(async (h) => {
        const o = op('s10');
        await h.store.begin(o, opts(T0));
        expect(
          await h.store.complete(
            o,
            1,
            {
              omitted: true,
              kind: 'http',
              status: 200,
              headers: [['Content-Type', 'application/octet-stream']],
            },
            T0 + 1,
          ),
        ).toBe('ok');
        const out = await h.store.begin(o, opts(T0 + 2));
        expect(out.outcome).toBe('completed');
        const rec = recordOf(out);
        expect(rec?.resultOmitted).toBe(true);
        expect(rec?.result?.body).toBeUndefined();
        expect(rec?.result?.status).toBe(200);
        expect(rec?.result?.headers).toEqual([['Content-Type', 'application/octet-stream']]);
      }),
    );

    test(
      'REQ-STORE-11: a body of exactly 1 MiB round trips byte-exact',
      withHarness(async (h) => {
        const o = op('s11');
        const body = new Uint8Array(MAX_RESULT_BYTES);
        for (let i = 0; i < body.byteLength; i++) body[i] = (i * 31 + 7) & 0xff;
        await h.store.begin(o, opts(T0));
        expect(await h.store.complete(o, 1, { kind: 'http', status: 200, body }, T0 + 1)).toBe(
          'ok',
        );
        const out = await h.store.begin(o, opts(T0 + 2));
        expect(out.outcome).toBe('completed');
        const rec = recordOf(out);
        expect(rec?.result?.body?.byteLength).toBe(MAX_RESULT_BYTES);
        expect(bytesEqual(rec?.result?.body, body)).toBe(true);
      }),
      30_000,
    );
  });
}
