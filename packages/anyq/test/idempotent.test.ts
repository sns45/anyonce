import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { FingerprintMismatchError, InFlightError } from '../src/errors';
import { idempotent } from '../src/idempotent';
import { fakeMessage } from './fake';

const OP = { scope: 'orders', key: 'msg-1' };

describe('idempotent handler', () => {
  test('REQ-Q-2: the first delivery runs the handler and the duplicate does not', async () => {
    const store = new MemoryStore();
    const seen: unknown[] = [];
    const handler = idempotent<{ a: number }>(
      async (message) => {
        seen.push(message.body);
      },
      { store },
    );
    const message = fakeMessage({ id: 'msg-1', body: { a: 1 } });
    await handler(message);
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(seen).toEqual([{ a: 1 }]);
  });

  test('REQ-Q-5: the stored record is the outcome only, with no payload bytes', async () => {
    const store = new MemoryStore();
    const handler = idempotent(async () => {}, { store });
    await handler(fakeMessage({ id: 'msg-1', body: { secret: 'do-not-store-me' } }));
    const record = await store.get(OP, Date.now());
    expect(record?.state).toBe('completed');
    expect(record?.result).toEqual({ kind: 'message', outcome: 'ok' });
    expect(record?.result?.body).toBeUndefined();
    expect(record?.resultOmitted).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('do-not-store-me');
  });

  test('REQ-Q-2: an in-flight duplicate throws InFlightError with the lease remainder as the delay', async () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    const handler = idempotent(async () => {}, { store, leaseMs: 5_000, clock: () => now });
    const claimed = await store.begin(
      { ...OP, fingerprint: await fingerprintOf({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    expect(claimed.outcome).toBe('acquired');
    const error = await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).leaseUntil).toBe(now + 5_000);
    expect((error as InFlightError).delayMs).toBe(5_000);
  });

  test('REQ-Q-2: onInFlight ack returns without running the handler and without throwing', async () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    let ran = 0;
    const handler = idempotent(
      async () => {
        ran += 1;
      },
      { store, leaseMs: 5_000, clock: () => now, onInFlight: 'ack' },
    );
    await store.begin(
      { ...OP, fingerprint: await fingerprintOf({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(ran).toBe(0);
  });

  test('REQ-Q-4: the same identity with a different payload throws FingerprintMismatchError', async () => {
    const store = new MemoryStore();
    let ran = 0;
    const handler = idempotent(
      async () => {
        ran += 1;
      },
      { store },
    );
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    const error = await handler(fakeMessage({ id: 'msg-1', body: { a: 2 } })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FingerprintMismatchError);
    expect((error as FingerprintMismatchError).record.key).toBe('msg-1');
    expect(ran).toBe(1);
  });

  test('REQ-Q-3: a handler exception abandons the claim and rethrows the original error', async () => {
    const store = new MemoryStore();
    const boom = new Error('handler exploded');
    const handler = idempotent(
      async () => {
        throw boom;
      },
      { store },
    );
    await expect(handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }))).rejects.toBe(boom);
    expect(await store.get(OP, Date.now())).toBeNull();
  });

  test('REQ-Q-3: after an abandoned claim the next delivery runs the handler again', async () => {
    const store = new MemoryStore();
    let attempts = 0;
    const handler = idempotent(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
      },
      { store },
    );
    await expect(handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }))).rejects.toThrow(
      'transient',
    );
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(attempts).toBe(2);
  });

  test('REQ-Q-2: two concurrent deliveries of one message run the handler once, the other conflicts', async () => {
    const store = new MemoryStore();
    let running = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = idempotent(
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
      },
      { store },
    );
    const first = handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    const second = handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch((e: unknown) => e);
    const conflict = await second;
    release?.();
    await first;
    expect(conflict).toBeInstanceOf(InFlightError);
    expect(peak).toBe(1);
  });

  test('REQ-Q-2: a store failure under fail-closed reaches anyq so the message is retried', async () => {
    const failing = {
      ...new MemoryStore(),
      begin: async () => {
        throw new Error('store down');
      },
    } as unknown as MemoryStore;
    const handler = idempotent(async () => {}, { store: failing });
    await expect(handler(fakeMessage({ id: 'msg-1', body: {} }))).rejects.toThrow('store down');
  });

  test('REQ-Q-1: onStoreError fail-open runs the handler and returns when the store is down', async () => {
    const failing = {
      ...new MemoryStore(),
      begin: async () => {
        throw new Error('store down');
      },
    } as unknown as MemoryStore;
    let ran = 0;
    const handler = idempotent(
      async () => {
        ran += 1;
      },
      { store: failing, onStoreError: 'fail-open' },
    );
    await handler(fakeMessage({ id: 'msg-1', body: {} }));
    expect(ran).toBe(1);
  });

  test('REQ-Q-1: a supplied hook fires on the outcome it names', async () => {
    const store = new MemoryStore();
    const acquired: string[] = [];
    const replayed: string[] = [];
    const handler = idempotent(async () => {}, {
      store,
      hooks: {
        onAcquired: (op) => acquired.push(op.key),
        onReplayed: (op) => replayed.push(op.key),
      },
    });
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(acquired).toEqual(['msg-1']);
    expect(replayed).toEqual(['msg-1']);
  });
});

async function fingerprintOf(body: unknown): Promise<string> {
  const { messageFingerprint } = await import('../src/fingerprint');
  return messageFingerprint(body);
}
