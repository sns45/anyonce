import { describe, expect, test } from 'bun:test';
import {
  AnyonceQueueError,
  FingerprintMismatchError,
  InFlightError,
  isFingerprintMismatchError,
  isInFlightError,
  QueueConfigurationError,
} from '../src/errors';

describe('typed queue errors', () => {
  test('REQ-Q-1: an in-flight error carries the lease, the delay and a retryable flag', () => {
    const err = new InFlightError(1_700_000_030_000, 4_500);
    expect(err).toBeInstanceOf(AnyonceQueueError);
    expect(err.name).toBe('InFlightError');
    expect(err.code).toBe('in-flight');
    expect(err.retryable).toBe(true);
    expect(err.leaseUntil).toBe(1_700_000_030_000);
    expect(err.delayMs).toBe(4_500);
    expect(err.translated).toBe(false);
    expect(err.message).not.toContain('1_700_000_030_000');
  });

  test('REQ-Q-1: a mismatch error carries the record and is not retryable', () => {
    const record = {
      scope: 'orders/workers',
      key: 'm-1',
      fingerprint: 'aa',
      state: 'completed' as const,
      fence: 1,
      leaseUntil: 0,
      createdAt: 0,
      expiresAt: 1,
    };
    const err = new FingerprintMismatchError(record);
    expect(err.name).toBe('FingerprintMismatchError');
    expect(err.code).toBe('fingerprint-mismatch');
    expect(err.retryable).toBe(false);
    expect(err.record).toBe(record);
    expect(err.message).not.toContain('m-1');
  });

  test('REQ-Q-1: the predicates match a foreign copy of the error by code', () => {
    const foreign = Object.assign(new Error('other copy'), {
      code: 'in-flight',
      retryable: true,
      delayMs: 10,
    });
    expect(isInFlightError(foreign)).toBe(true);
    expect(isFingerprintMismatchError(foreign)).toBe(false);
    expect(isInFlightError(new QueueConfigurationError('no scope'))).toBe(false);
    expect(
      isFingerprintMismatchError(Object.assign(new Error('x'), { code: 'fingerprint-mismatch' })),
    ).toBe(true);
    expect(isInFlightError('not an error')).toBe(false);
  });
});
