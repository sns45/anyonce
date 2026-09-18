import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { RetryStrategy, RetryStrategyContext } from '@anyq/core';
import { FingerprintMismatchError, InFlightError } from '../src/errors';
import { idempotent } from '../src/idempotent';
import { IDEMPOTENCY_STRATEGY_NAME, idempotencyStrategy } from '../src/strategy';
import { fakeMessage } from './fake';

function context(error: Error): RetryStrategyContext {
  return { message: fakeMessage({ body: {} }), error, attempt: 1, maxAttempts: 4 };
}

describe('idempotencyStrategy', () => {
  test('REQ-Q-8: an in-flight error becomes a park for the lease remainder', async () => {
    const strategy = idempotencyStrategy();
    const error = new InFlightError(1_700_000_005_000, 4_200);
    await expect(strategy.decide(context(error))).resolves.toEqual({
      action: 'park',
      delayMs: 4_200,
    });
    expect(error.translated).toBe(true);
  });

  test('REQ-Q-8: a mismatch becomes a dead-letter with reason fingerprint-mismatch', async () => {
    const strategy = idempotencyStrategy();
    const error = new FingerprintMismatchError({
      scope: 'orders',
      key: 'msg-1',
      fingerprint: 'aa',
      state: 'completed',
      fence: 1,
      leaseUntil: 0,
      createdAt: 0,
      expiresAt: 1,
    });
    await expect(strategy.decide(context(error))).resolves.toEqual({
      action: 'deadLetter',
      reason: 'fingerprint-mismatch',
    });
    expect(error.retryable).toBe(false);
  });

  test('REQ-Q-8: every other error is delegated to the inner strategy', async () => {
    const seen: Error[] = [];
    const inner: RetryStrategy = {
      name: 'test-inner',
      decide(ctx) {
        seen.push(ctx.error);
        return { action: 'requeue' };
      },
    };
    const strategy = idempotencyStrategy(inner);
    const other = new Error('downstream timeout');
    await expect(strategy.decide(context(other))).resolves.toEqual({ action: 'requeue' });
    expect(seen).toEqual([other]);
    expect(strategy.name).toBe(IDEMPOTENCY_STRATEGY_NAME);
  });

  test('REQ-Q-8: the default inner strategy is retryThenDeadLetter', async () => {
    const strategy = idempotencyStrategy();
    const decision = await strategy.decide({
      message: fakeMessage({ body: {} }),
      error: new Error('downstream timeout'),
      attempt: 9,
      maxAttempts: 4,
    });
    expect(decision).toEqual({ action: 'deadLetter', reason: 'max attempts exceeded' });
  });

  test('REQ-Q-8: with no strategy the typed error reaches anyq untranslated and the door warns once', async () => {
    const store = new MemoryStore();
    const warnings: string[] = [];
    const now = 1_700_000_000_000;
    const handler = idempotent(async () => {}, {
      store,
      leaseMs: 5_000,
      clock: () => now,
      logger: { warn: (message) => warnings.push(message) },
    });
    const { messageFingerprint } = await import('../src/fingerprint');
    await store.begin(
      { scope: 'orders', key: 'msg-1', fingerprint: await messageFingerprint({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    for (let i = 0; i < 3; i++) {
      await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch(() => {});
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('idempotencyStrategy');
  });

  test('REQ-Q-8: a translated in-flight error does not produce the warning', async () => {
    const store = new MemoryStore();
    const warnings: string[] = [];
    const now = 1_700_000_000_000;
    const strategy = idempotencyStrategy();
    const handler = idempotent(async () => {}, {
      store,
      leaseMs: 5_000,
      clock: () => now,
      logger: { warn: (message) => warnings.push(message) },
    });
    const { messageFingerprint } = await import('../src/fingerprint');
    await store.begin(
      { scope: 'orders', key: 'msg-1', fingerprint: await messageFingerprint({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    for (let i = 0; i < 3; i++) {
      const message = fakeMessage({ id: 'msg-1', body: { a: 1 } });
      const error = await handler(message).catch((e: unknown) => e);
      await strategy.decide({ message, error: error as Error, attempt: 1, maxAttempts: 4 });
    }
    expect(warnings).toEqual([]);
  });
});
