import type {
  BeginOptions,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  StoredResult,
} from '@anyonce/core';

/** The flat row every store persists (plan Global Constraints). Numbers are epoch milliseconds. */
export interface RecordRow {
  scope: string;
  key: string;
  fingerprint: string;
  state: 'in_flight' | 'completed';
  fence: number;
  lease_until: number;
  created_at: number;
  expires_at: number;
  result_meta: string | null;
  result_body: Uint8Array | null;
  result_omitted: number;
}

/** Everything in a result except the body, as JSON text. Works for the omitted form too. */
export function encodeResultMeta(result: StoredResult | OmittedResult): string {
  const meta: Record<string, unknown> = { kind: result.kind };
  if (result.status !== undefined) meta.status = result.status;
  if (result.headers !== undefined) meta.headers = result.headers;
  if ('outcome' in result && result.outcome !== undefined) meta.outcome = result.outcome;
  if ('error' in result && result.error !== undefined) meta.error = result.error;
  return JSON.stringify(meta);
}

export function decodeResultMeta(text: string): StoredResult {
  const meta = JSON.parse(text) as Partial<StoredResult> & { kind: StoredResult['kind'] };
  const out: StoredResult = { kind: meta.kind };
  if (meta.status !== undefined) out.status = meta.status;
  if (meta.headers !== undefined) out.headers = meta.headers;
  if (meta.outcome !== undefined) out.outcome = meta.outcome;
  if (meta.error !== undefined) out.error = meta.error;
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function newRow(op: Operation, opts: BeginOptions, fence: number): RecordRow {
  return {
    scope: op.scope,
    key: op.key,
    fingerprint: op.fingerprint,
    state: 'in_flight',
    fence,
    lease_until: opts.now + opts.leaseMs,
    created_at: opts.now,
    expires_at: opts.now + opts.ttlMs,
    result_meta: null,
    result_body: null,
    result_omitted: 0,
  };
}

/** Drivers return bigint, string or number for integer columns; every store goes through here. */
export function rowToRecord(row: RecordRow): IdempotencyRecord {
  const record: IdempotencyRecord = {
    scope: row.scope,
    key: row.key,
    fingerprint: row.fingerprint,
    state: row.state,
    fence: num(row.fence),
    leaseUntil: num(row.lease_until),
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
  };
  if (row.result_meta !== null && row.result_meta !== undefined) {
    const result = decodeResultMeta(row.result_meta);
    if (row.result_body !== null && row.result_body !== undefined) {
      result.body = new Uint8Array(row.result_body);
    }
    record.result = result;
  }
  if (num(row.result_omitted) === 1) record.resultOmitted = true;
  return record;
}

/** Web-API base64, for the stores that persist a body as text (Redis hashes, the Upstash REST client). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
