import { describe, expect, test } from 'bun:test';
import type { ExecuteHooks, ExecutePolicy } from '../src/engine';
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_TTL_MS,
  defaultPolicy,
  defaultStoreResult,
  execute,
  omitBody,
  resultSize,
} from '../src/engine';
import type {
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from '../src/types';

const op: Operation = { scope: 'POST /x', key: 'k', fingerprint: 'f' };
const record: IdempotencyRecord = {
  scope: op.scope,
  key: op.key,
  fingerprint: op.fingerprint,
  state: 'completed',
  fence: 1,
  leaseUntil: 0,
  createdAt: 0,
  expiresAt: 10,
  result: { kind: 'http', status: 201 },
};

type Scripted<T> = T | Error;

class FakeStore implements Store {
  calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(
    private readonly script: {
      begin: Scripted<BeginOutcome>;
      complete?: Scripted<CompleteStatus>;
      abandon?: Scripted<CompleteStatus>;
    },
  ) {}
  private play<T>(
    method: string,
    value: Scripted<T> | undefined,
    args: unknown[],
    fallback: T,
  ): Promise<T> {
    this.calls.push({ method, args });
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? fallback);
  }
  begin(
    o: Operation,
    opts: { leaseMs: number; ttlMs: number; now: number },
  ): Promise<BeginOutcome> {
    return this.play('begin', this.script.begin, [o, opts], { outcome: 'acquired', fence: 1 });
  }
  complete(
    o: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    return this.play('complete', this.script.complete, [o, fence, result, now], 'ok');
  }
  abandon(o: Operation, fence: number): Promise<CompleteStatus> {
    return this.play('abandon', this.script.abandon, [o, fence], 'ok');
  }
  get(): Promise<IdempotencyRecord | null> {
    return Promise.resolve(null);
  }
  purge(): Promise<number> {
    return Promise.resolve(0);
  }
  named(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

const ok: StoredResult = {
  kind: 'http',
  status: 200,
  headers: [['Content-Type', 'text/plain']],
  body: new Uint8Array([1, 2, 3]),
};

function fullHooks(log: string[]): ExecuteHooks {
  return {
    onAcquired: () => log.push('acquired'),
    onReplayed: () => log.push('replayed'),
    onConflict: () => log.push('conflict'),
    onMismatch: () => log.push('mismatch'),
    onStoreError: () => log.push('store_error'),
  };
}

function policy(overrides: Partial<ExecutePolicy> = {}): ExecutePolicy {
  return defaultPolicy({ clock: () => 123, ...overrides });
}

describe('execute', () => {
  test('REQ-CORE-1: acquired runs the handler once, completes with the result, and reports stored', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 7 } });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(
      store,
      op,
      async () => {
        runs += 1;
        return ok;
      },
      policy({ hooks: fullHooks(log) }),
    );
    expect(out).toEqual({ kind: 'executed', result: ok, stored: true });
    expect(runs).toBe(1);
    expect(store.named('begin')[0]?.args[1]).toEqual({
      leaseMs: DEFAULT_LEASE_MS,
      ttlMs: DEFAULT_TTL_MS,
      now: 123,
    });
    expect(store.named('complete')[0]?.args.slice(1)).toEqual([7, ok, 123]);
    expect(store.named('abandon')).toHaveLength(0);
    expect(log).toEqual(['acquired']);
  });

  test('REQ-CORE-1: completed replays without running the handler', async () => {
    const store = new FakeStore({ begin: { outcome: 'completed', record } });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(
      store,
      op,
      async () => {
        runs += 1;
        return ok;
      },
      policy({ hooks: fullHooks(log) }),
    );
    expect(out).toEqual({ kind: 'replayed', record });
    expect(runs).toBe(0);
    expect(log).toEqual(['replayed']);
  });

  test('REQ-CORE-1: in_flight yields conflict with the lease deadline', async () => {
    const store = new FakeStore({ begin: { outcome: 'in_flight', leaseUntil: 999 } });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'conflict', leaseUntil: 999 });
    expect(log).toEqual(['conflict']);
  });

  test('REQ-CORE-1: mismatch yields mismatch with the record', async () => {
    const store = new FakeStore({ begin: { outcome: 'mismatch', record } });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'mismatch', record });
    expect(log).toEqual(['mismatch']);
  });

  test('REQ-CORE-1: a begin failure under fail-closed returns store_error without running', async () => {
    const boom = new Error('down');
    const store = new FakeStore({ begin: boom });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(
      store,
      op,
      async () => {
        runs += 1;
        return ok;
      },
      policy({ hooks: fullHooks(log) }),
    );
    expect(out).toEqual({ kind: 'store_error', error: boom });
    expect(runs).toBe(0);
    expect(log).toEqual(['store_error']);
  });

  test('REQ-CORE-1: a begin failure under fail-open runs the handler and reports stored false', async () => {
    const store = new FakeStore({ begin: new Error('down') });
    const out = await execute(store, op, async () => ok, policy({ onStoreError: 'fail-open' }));
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: a throwing handler abandons the record and rethrows', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 3 } });
    const failure = new Error('handler failed');
    await expect(
      execute(
        store,
        op,
        async () => {
          throw failure;
        },
        policy(),
      ),
    ).rejects.toThrow('handler failed');
    expect(store.named('abandon')[0]?.args).toEqual([op, 3]);
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: when abandon also fails the handler error still wins and onStoreError fires', async () => {
    const store = new FakeStore({
      begin: { outcome: 'acquired', fence: 3 },
      abandon: new Error('abandon down'),
    });
    const log: string[] = [];
    await expect(
      execute(
        store,
        op,
        async () => {
          throw new Error('handler failed');
        },
        policy({ hooks: fullHooks(log) }),
      ),
    ).rejects.toThrow('handler failed');
    expect(log).toEqual(['acquired', 'store_error']);
  });

  test('REQ-CORE-1: a result the policy refuses to store is abandoned and reported stored false', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const out = await execute(store, op, async () => ({ kind: 'http', status: 503 }), policy());
    expect(out).toEqual({ kind: 'executed', result: { kind: 'http', status: 503 }, stored: false });
    expect(store.named('abandon')).toHaveLength(1);
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: a body over maxResultBytes completes with the omitted form, status and headers intact', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const big: StoredResult = {
      kind: 'http',
      status: 200,
      headers: [['ETag', '"x"']],
      body: new Uint8Array(11),
    };
    const out = await execute(store, op, async () => big, policy({ maxResultBytes: 10 }));
    expect(out).toEqual({ kind: 'executed', result: big, stored: true });
    expect(store.named('complete')[0]?.args[2]).toEqual({
      omitted: true,
      kind: 'http',
      status: 200,
      headers: [['ETag', '"x"']],
    });
  });

  test('REQ-CORE-1: a body of exactly maxResultBytes is stored in full', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const exact: StoredResult = { kind: 'http', status: 200, body: new Uint8Array(10) };
    await execute(store, op, async () => exact, policy({ maxResultBytes: 10 }));
    expect(store.named('complete')[0]?.args[2]).toBe(exact);
  });

  test('REQ-CORE-1: a complete failure reports stored false and fires onStoreError (Q15)', async () => {
    const store = new FakeStore({
      begin: { outcome: 'acquired', fence: 1 },
      complete: new Error('complete down'),
    });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
    expect(log).toEqual(['acquired', 'store_error']);
  });

  test('REQ-CORE-1: a stale fence at complete reports stored false', async () => {
    const store = new FakeStore({
      begin: { outcome: 'acquired', fence: 1 },
      complete: 'stale_fence',
    });
    const out = await execute(store, op, async () => ok, policy());
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
  });

  test('REQ-CORE-1: hooks that throw are swallowed and counted', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const hookErrors = { count: 0 };
    const hooks: ExecuteHooks = {
      onAcquired: () => {
        throw new Error('hook');
      },
    };
    const out = await execute(store, op, async () => ok, policy({ hooks, hookErrors }));
    expect(out.kind).toBe('executed');
    expect(hookErrors.count).toBe(1);
  });

  test('REQ-CORE-1: hooks that throw without a counter are still swallowed', async () => {
    const store = new FakeStore({ begin: { outcome: 'completed', record } });
    const hooks: ExecuteHooks = {
      onReplayed: () => {
        throw new Error('hook');
      },
    };
    const out = await execute(store, op, async () => ok, policy({ hooks }));
    expect(out.kind).toBe('replayed');
  });

  test('REQ-CORE-1: without a clock the engine uses Date.now and without hooks it is silent', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const before = Date.now();
    const out = await execute(store, op, async () => ok, defaultPolicy());
    const after = Date.now();
    expect(out.kind).toBe('executed');
    const beginArgs = store.named('begin')[0]?.args ?? [];
    const now = (beginArgs[1] as { now: number }).now;
    expect(now >= before && now <= after).toBe(true);
  });
});

describe('policy helpers', () => {
  test('REQ-CORE-1: defaultPolicy carries the 3.3 defaults and accepts overrides', () => {
    const p = defaultPolicy();
    expect([p.leaseMs, p.ttlMs, p.maxResultBytes, p.onStoreError]).toEqual([
      30_000,
      86_400_000,
      1_048_576,
      'fail-closed',
    ]);
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(1_048_576);
    expect(defaultPolicy({ leaseMs: 5 }).leaseMs).toBe(5);
  });

  test('REQ-CORE-1: defaultStoreResult stores messages and http below 500 only (D6)', () => {
    expect(defaultStoreResult({ kind: 'message', outcome: 'error' })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 200 })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 404 })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 500 })).toBe(false);
    expect(defaultStoreResult({ kind: 'http' })).toBe(false);
  });

  test('REQ-CORE-1: resultSize counts body bytes only and omitBody drops the body (Q17)', () => {
    expect(resultSize({ kind: 'http', status: 200 })).toBe(0);
    expect(resultSize(ok)).toBe(3);
    expect(omitBody(ok)).toEqual({
      omitted: true,
      kind: 'http',
      status: 200,
      headers: [['Content-Type', 'text/plain']],
    });
    expect(omitBody({ kind: 'message', outcome: 'ok' })).toEqual({
      omitted: true,
      kind: 'message',
    });
  });
});
