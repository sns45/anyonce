import { describe, expect, test } from 'bun:test';
import type {
  BeginOutcome,
  IdempotencyRecord,
  OmittedResult,
  Store,
  StoredResult,
} from '../src/types';
import { isOmitted } from '../src/types';

describe('types', () => {
  test('REQ-CORE-1: isOmitted distinguishes the omitted form from a stored result', () => {
    const stored: StoredResult = { kind: 'http', status: 201, body: new Uint8Array([1]) };
    const omitted: OmittedResult = { omitted: true, kind: 'http', status: 201 };
    expect(isOmitted(stored)).toBe(false);
    expect(isOmitted(omitted)).toBe(true);
  });

  test('REQ-CORE-1: the Store interface shape compiles for a minimal fake', async () => {
    const record: IdempotencyRecord = {
      scope: 's',
      key: 'k',
      fingerprint: 'f',
      state: 'completed',
      fence: 1,
      leaseUntil: 0,
      createdAt: 0,
      expiresAt: 10,
      result: { kind: 'message', outcome: 'ok' },
    };
    const outcome: BeginOutcome = { outcome: 'completed', record };
    const fake: Store = {
      begin: async () => outcome,
      complete: async () => 'ok',
      abandon: async () => 'ok',
      get: async () => record,
      purge: async () => 0,
    };
    expect(
      (
        await fake.begin(
          { scope: 's', key: 'k', fingerprint: 'f' },
          { leaseMs: 1, ttlMs: 1, now: 0 },
        )
      ).outcome,
    ).toBe('completed');
  });
});
