import { DurableObject } from 'cloudflare:workers';
import type {
  BeginOptions,
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import { sqlRowToRecordRow as asRow, encodeResultMeta, rowToRecord } from './codec';
import {
  ABANDON_SQL,
  BEGIN_SQL,
  COMPLETE_SQL,
  GET_SQL,
  PURGE_SQL,
  REMOVE_SQL,
  SELECT_SQL,
  SQLITE_SCHEMA,
} from './sql';

/**
 * The object keeps the shared record table plus one extra table: the wall-clock expiry the alarm sweeps by.
 * Logical fields (expires_at, lease_until) stay on the caller's injected clock; only expires_wall is real time.
 */
const ALARM_SCHEMA = `${SQLITE_SCHEMA}
CREATE TABLE IF NOT EXISTS anyonce_sweep (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  expires_wall INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_sweep_expires_wall ON anyonce_sweep (expires_wall);
`;

const SWEEP_UPSERT_SQL = `
INSERT INTO anyonce_sweep (scope, key, expires_wall) VALUES (?1, ?2, ?3)
ON CONFLICT(scope, key) DO UPDATE SET expires_wall = excluded.expires_wall`;

const SWEEP_REMOVE_SQL = 'DELETE FROM anyonce_sweep WHERE scope = ?1 AND key = ?2';

/** Drops sweep entries whose record is gone; PURGE_SQL returns scope only, so the orphans are found by join. */
const SWEEP_PRUNE_SQL = `
DELETE FROM anyonce_sweep WHERE NOT EXISTS (
  SELECT 1 FROM anyonce_records
  WHERE anyonce_records.scope = anyonce_sweep.scope AND anyonce_records.key = anyonce_sweep.key
)`;

const SWEEP_DUE_SQL = 'SELECT scope, key FROM anyonce_sweep WHERE expires_wall <= ?1';

const SWEEP_NEXT_SQL = 'SELECT MIN(expires_wall) AS at FROM anyonce_sweep';

/** Unit separator: the scope and key are joined with it so one composed object name stays unambiguous. */
const SHARD_SEPARATOR = String.fromCharCode(31);

const DEFAULT_GRACE_MS = 60_000;

/** SqlStorageValue covers ArrayBuffer but not Uint8Array, so bodies are copied into their own buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * The shape the Worker side calls the object through. `DurableObjectStub<IdempotencyObject>` cannot be used
 * directly because the RPC types widen tuples: `headers` comes back as `string[][]` rather than
 * `[string, string][]`, which does not satisfy `Store`. The wire values are unchanged, since RPC arguments and
 * returns are structured-clone data (plain objects and Uint8Array), never class instances.
 */
interface IdempotencyObjectRpc {
  begin(op: Operation, opts: BeginOptions, graceMs?: number): Promise<BeginOutcome>;
  complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus>;
  abandon(op: Operation, fence: number): Promise<CompleteStatus>;
  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null>;
  purge(now: number): Promise<number>;
  physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void>;
}

/**
 * REQ-ST-DO-1: one object is one writer, so each statement runs alone; RPC methods take and return plain data.
 * The alarm deletes rows by wall-clock expiry (expires_wall), which is the logical expiry converted to a duration
 * at write time plus the grace, so the injected clock never makes the alarm sweep live rows.
 */
export class IdempotencyObject extends DurableObject implements IdempotencyObjectRpc {
  private ready = false;

  private init(): void {
    if (this.ready) return;
    for (const statement of ALARM_SCHEMA.split(';')) {
      if (statement.trim()) this.ctx.storage.sql.exec(statement);
    }
    this.ready = true;
  }

  private async scheduleSweep(
    scope: string,
    key: string,
    expiresAt: number,
    now: number,
    graceMs: number,
  ): Promise<void> {
    const wall = Date.now() + (expiresAt - now) + graceMs;
    this.ctx.storage.sql.exec(SWEEP_UPSERT_SQL, scope, key, wall);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > wall) await this.ctx.storage.setAlarm(wall);
  }

  async begin(
    op: Operation,
    opts: BeginOptions,
    graceMs = DEFAULT_GRACE_MS,
  ): Promise<BeginOutcome> {
    this.init();
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = this.ctx.storage.sql
        .exec(
          BEGIN_SQL,
          op.scope,
          op.key,
          op.fingerprint,
          opts.now,
          opts.now + opts.leaseMs,
          opts.now + opts.ttlMs,
        )
        .toArray()[0];
      if (claimed !== undefined) {
        await this.scheduleSweep(op.scope, op.key, opts.now + opts.ttlMs, opts.now, graceMs);
        return { outcome: 'acquired', fence: Number(claimed.fence) };
      }
      const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
      if (existing === undefined) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: durable object begin could not settle after three attempts');
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    this.init();
    const omitted = isOmitted(result);
    const body = omitted || result.body === undefined ? null : toArrayBuffer(result.body);
    const updated = this.ctx.storage.sql
      .exec(
        COMPLETE_SQL,
        op.scope,
        op.key,
        fence,
        now,
        encodeResultMeta(result),
        body,
        omitted ? 1 : 0,
      )
      .toArray()[0];
    if (updated !== undefined) return 'ok';
    const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    this.init();
    const deleted = this.ctx.storage.sql.exec(ABANDON_SQL, op.scope, op.key, fence).toArray()[0];
    if (deleted !== undefined) {
      this.ctx.storage.sql.exec(SWEEP_REMOVE_SQL, op.scope, op.key);
      return 'ok';
    }
    const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    this.init();
    const row = this.ctx.storage.sql.exec(GET_SQL, op.scope, op.key, now).toArray()[0];
    return row === undefined ? null : rowToRecord(asRow(row));
  }

  async purge(now: number): Promise<number> {
    this.init();
    const removed = this.ctx.storage.sql.exec(PURGE_SQL, now).toArray();
    if (removed.length > 0) this.ctx.storage.sql.exec(SWEEP_PRUNE_SQL);
    return removed.length;
  }

  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec(REMOVE_SQL, op.scope, op.key);
    this.ctx.storage.sql.exec(SWEEP_REMOVE_SQL, op.scope, op.key);
  }

  /** Deletes rows whose wall-clock expiry passed and reschedules for the earliest remaining one. */
  override async alarm(): Promise<void> {
    this.init();
    const due = this.ctx.storage.sql.exec(SWEEP_DUE_SQL, Date.now()).toArray();
    for (const r of due) {
      this.ctx.storage.sql.exec(REMOVE_SQL, r.scope, r.key);
      this.ctx.storage.sql.exec(SWEEP_REMOVE_SQL, r.scope, r.key);
    }
    const next = this.ctx.storage.sql.exec(SWEEP_NEXT_SQL).toArray()[0];
    if (next !== undefined && next.at !== null) await this.ctx.storage.setAlarm(Number(next.at));
  }
}

export interface DurableObjectsStoreOptions {
  namespace: DurableObjectNamespace<IdempotencyObject>;
  /** One object per scope (default) or per scope and key. */
  shard?: 'scope' | 'scope-key';
  /** Added to the alarm time so a late complete from the previous fence holder still finds its row. Default 60000. */
  nativeTtlGraceMs?: number;
  /**
   * Remember every object name this store instance has addressed, so `purge(now)` can reach those objects.
   * Default false, because the set grows with the number of distinct scopes (or scopes and keys) the isolate
   * serves and nothing else reads it: each object's alarm sweeps itself regardless. With it false `purge`
   * records nothing, does nothing and returns 0. Set it to true only when something on the Worker side calls
   * `purge`.
   */
  trackForPurge?: boolean;
}

/** REQ-ST-DO-1: the Worker-side Store; every call is one RPC to the object that owns the scope (or the key). */
export class DurableObjectsStore implements Store {
  private readonly namespace: DurableObjectNamespace<IdempotencyObject>;
  private readonly shard: 'scope' | 'scope-key';
  private readonly grace: number;
  private readonly trackForPurge: boolean;
  private readonly touched = new Set<string>();

  constructor(options: DurableObjectsStoreOptions) {
    this.namespace = options.namespace;
    this.shard = options.shard ?? 'scope';
    this.grace = options.nativeTtlGraceMs ?? DEFAULT_GRACE_MS;
    this.trackForPurge = options.trackForPurge ?? false;
  }

  private stub(op: Pick<Operation, 'scope' | 'key'>): IdempotencyObjectRpc {
    const name = this.shard === 'scope' ? op.scope : `${op.scope}${SHARD_SEPARATOR}${op.key}`;
    if (this.trackForPurge) this.touched.add(name);
    return this.byName(name);
  }

  private byName(name: string): IdempotencyObjectRpc {
    return this.namespace.get(this.namespace.idFromName(name)) as unknown as IdempotencyObjectRpc;
  }

  begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    return this.stub(op).begin(op, opts, this.grace);
  }

  complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    return this.stub(op).complete(op, fence, result, now);
  }

  abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    return this.stub(op).abandon(op, fence);
  }

  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    return this.stub(op).get(op, now);
  }

  /**
   * Needs `trackForPurge: true`; without it this returns 0 and does nothing. With it, a pass sweeps what the
   * objects this instance has addressed hold right now, which is never the whole namespace, because a Worker
   * cannot enumerate one. Rows that expire after the pass are the alarm's, on each object's own schedule.
   */
  async purge(now: number): Promise<number> {
    if (!this.trackForPurge) return 0;
    let removed = 0;
    for (const name of this.touched) removed += await this.byName(name).purge(now);
    // Each of those objects has just been swept; the set refills from the next call that addresses one.
    this.touched.clear();
    return removed;
  }

  physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    return this.stub(op).physicallyRemove(op);
  }
}
