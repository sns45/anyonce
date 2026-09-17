import { describe, expect, test } from 'bun:test';
import type { IdempotencyRecord, OmittedResult, StoredResult } from '@anyonce/core';
import { decodeResultMeta, encodeResultMeta, newRow, rowToRecord } from '../src/codec';

const op = { scope: 'POST /p', key: 'k', fingerprint: 'fp' };
const T0 = 1_700_000_000_000;

describe('codec', () => {
  test('REQ-STORE-4: result meta round trips kind, status, headers, outcome and error without the body', () => {
    const result: StoredResult = {
      kind: 'message',
      status: 201,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'a=1'],
      ],
      outcome: 'error',
      error: { name: 'E', message: 'boom' },
      body: new Uint8Array([1]),
    };
    const meta = encodeResultMeta(result);
    expect(JSON.parse(meta)).toEqual({
      kind: 'message',
      status: 201,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'a=1'],
      ],
      outcome: 'error',
      error: { name: 'E', message: 'boom' },
    });
    expect(decodeResultMeta(meta)).toEqual({
      kind: 'message',
      status: 201,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'a=1'],
      ],
      outcome: 'error',
      error: { name: 'E', message: 'boom' },
    });
  });

  test('REQ-STORE-10: the omitted form encodes status and headers and the row flags result_omitted', () => {
    const omitted: OmittedResult = {
      omitted: true,
      kind: 'http',
      status: 200,
      headers: [['x', 'y']],
    };
    expect(JSON.parse(encodeResultMeta(omitted))).toEqual({
      kind: 'http',
      status: 200,
      headers: [['x', 'y']],
    });
  });

  test('REQ-STORE-1: newRow builds an in_flight row from the op, the options and the fence', () => {
    expect(newRow(op, { leaseMs: 30_000, ttlMs: 86_400_000, now: T0 }, 2)).toEqual({
      scope: 'POST /p',
      key: 'k',
      fingerprint: 'fp',
      state: 'in_flight',
      fence: 2,
      lease_until: T0 + 30_000,
      created_at: T0,
      expires_at: T0 + 86_400_000,
      result_meta: null,
      result_body: null,
      result_omitted: 0,
    });
  });

  test('REQ-STORE-4: rowToRecord decodes a completed row into an IdempotencyRecord with the body', () => {
    const record: IdempotencyRecord = rowToRecord({
      scope: 'POST /p',
      key: 'k',
      fingerprint: 'fp',
      state: 'completed',
      fence: 1,
      lease_until: T0 + 1,
      created_at: T0,
      expires_at: T0 + 2,
      result_meta: '{"kind":"http","status":201,"headers":[["content-type","text/plain"]]}',
      result_body: new Uint8Array([1, 2]),
      result_omitted: 0,
    });
    expect(record).toEqual({
      scope: 'POST /p',
      key: 'k',
      fingerprint: 'fp',
      state: 'completed',
      fence: 1,
      leaseUntil: T0 + 1,
      createdAt: T0,
      expiresAt: T0 + 2,
      result: {
        kind: 'http',
        status: 201,
        headers: [['content-type', 'text/plain']],
        body: new Uint8Array([1, 2]),
      },
    });
  });

  test('REQ-STORE-10: rowToRecord marks resultOmitted and leaves the body out; an in_flight row has no result', () => {
    const omitted = rowToRecord({
      scope: 's',
      key: 'k',
      fingerprint: 'f',
      state: 'completed',
      fence: 1,
      lease_until: 0,
      created_at: 0,
      expires_at: 9,
      result_meta: '{"kind":"http","status":200}',
      result_body: null,
      result_omitted: 1,
    });
    expect(omitted.resultOmitted).toBe(true);
    expect(omitted.result).toEqual({ kind: 'http', status: 200 });
    const inFlight = rowToRecord({
      scope: 's',
      key: 'k',
      fingerprint: 'f',
      state: 'in_flight',
      fence: 1,
      lease_until: 0,
      created_at: 0,
      expires_at: 9,
      result_meta: null,
      result_body: null,
      result_omitted: 0,
    });
    expect(inFlight.result).toBeUndefined();
    expect(inFlight.resultOmitted).toBeUndefined();
  });

  test('REQ-STORE-4: numeric columns that arrive as strings or bigints (Postgres drivers) decode to numbers', () => {
    const record = rowToRecord({
      scope: 's',
      key: 'k',
      fingerprint: 'f',
      state: 'in_flight',
      fence: '3' as unknown as number,
      lease_until: BigInt(5) as unknown as number,
      created_at: '1' as unknown as number,
      expires_at: 9,
      result_meta: null,
      result_body: null,
      result_omitted: '0' as unknown as number,
    });
    expect(record.fence).toBe(3);
    expect(record.leaseUntil).toBe(5);
    expect(record.createdAt).toBe(1);
  });
});
