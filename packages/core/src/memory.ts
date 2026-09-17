import type {
  BeginOptions,
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from './types';
import { isOmitted } from './types';

function mapKey(op: Pick<Operation, 'scope' | 'key'>): string {
  return `${op.scope}\x00${op.key}`;
}

function copyResult(result: StoredResult): StoredResult {
  const out: StoredResult = { kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers.map(([n, v]) => [n, v]);
  if (result.body !== undefined) out.body = new Uint8Array(result.body);
  if (result.outcome !== undefined) out.outcome = result.outcome;
  if (result.error !== undefined)
    out.error = { name: result.error.name, message: result.error.message };
  return out;
}

function omittedToStored(result: OmittedResult): StoredResult {
  const out: StoredResult = { kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers.map(([n, v]) => [n, v]);
  return out;
}

function copyRecord(record: IdempotencyRecord): IdempotencyRecord {
  const out: IdempotencyRecord = {
    scope: record.scope,
    key: record.key,
    fingerprint: record.fingerprint,
    state: record.state,
    fence: record.fence,
    leaseUntil: record.leaseUntil,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  if (record.result !== undefined) out.result = copyResult(record.result);
  if (record.resultOmitted !== undefined) out.resultOmitted = record.resultOmitted;
  return out;
}

/**
 * REQ-CORE-6: in-process store for tests and single-instance deployments. begin performs its read and write
 * without yielding, so concurrent callers in one event loop see one atomic claim (D4).
 */
export class MemoryStore implements Store {
  private readonly records = new Map<string, IdempotencyRecord>();

  get size(): number {
    return this.records.size;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    const key = mapKey(op);
    const existing = this.records.get(key);
    const { now } = opts;
    if (existing !== undefined && existing.expiresAt > now) {
      if (existing.fingerprint !== op.fingerprint)
        return { outcome: 'mismatch', record: copyRecord(existing) };
      if (existing.state === 'completed')
        return { outcome: 'completed', record: copyRecord(existing) };
      if (existing.leaseUntil > now)
        return { outcome: 'in_flight', leaseUntil: existing.leaseUntil };
    }
    const fence = existing === undefined ? 1 : existing.fence + 1;
    this.records.set(key, {
      scope: op.scope,
      key: op.key,
      fingerprint: op.fingerprint,
      state: 'in_flight',
      fence,
      leaseUntil: now + opts.leaseMs,
      createdAt: now,
      expiresAt: now + opts.ttlMs,
    });
    return { outcome: 'acquired', fence };
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    const existing = this.records.get(mapKey(op));
    if (existing === undefined || existing.expiresAt <= now) return 'not_found';
    if (existing.fence !== fence) return 'stale_fence';
    if (existing.state === 'completed') return 'ok';
    existing.state = 'completed';
    if (isOmitted(result)) {
      existing.result = omittedToStored(result);
      existing.resultOmitted = true;
    } else {
      existing.result = copyResult(result);
    }
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const key = mapKey(op);
    const existing = this.records.get(key);
    if (existing === undefined || existing.state !== 'in_flight') return 'not_found';
    if (existing.fence !== fence) return 'stale_fence';
    this.records.delete(key);
    return 'ok';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(mapKey(op));
    if (existing === undefined || existing.expiresAt <= now) return null;
    return copyRecord(existing);
  }

  async purge(now: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test-only: simulates a native TTL sweep deleting the row, so the next begin restarts the fence at 1 (Q8). */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    this.records.delete(mapKey(op));
  }
}
