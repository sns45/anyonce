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

export const MIGRATION_SQL = SQLITE_SCHEMA;

export interface D1StoreOptions {
  db: D1Database;
}

export async function ensureSchema(db: D1Database): Promise<void> {
  for (const statement of MIGRATION_SQL.split(';')) {
    if (statement.trim()) await db.prepare(statement).run();
  }
}

/** REQ-ST-D1-1: one INSERT ON CONFLICT DO UPDATE per claim; D1 returns BLOBs as ArrayBuffer. */
export class D1Store implements Store {
  private readonly db: D1Database;

  constructor(options: D1StoreOptions) {
    this.db = options.db;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await this.db
        .prepare(BEGIN_SQL)
        .bind(
          op.scope,
          op.key,
          op.fingerprint,
          opts.now,
          opts.now + opts.leaseMs,
          opts.now + opts.ttlMs,
        )
        .first<{ fence: number }>();
      if (claimed !== null) return { outcome: 'acquired', fence: Number(claimed.fence) };
      const existing = await this.db
        .prepare(SELECT_SQL)
        .bind(op.scope, op.key)
        .first<Record<string, unknown>>();
      if (existing === null) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: d1 begin could not settle after three attempts');
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? null : (result.body ?? null);
    const updated = await this.db
      .prepare(COMPLETE_SQL)
      .bind(op.scope, op.key, fence, now, encodeResultMeta(result), body, omitted ? 1 : 0)
      .first<{ fence: number }>();
    if (updated !== null) return 'ok';
    const existing = await this.db
      .prepare(SELECT_SQL)
      .bind(op.scope, op.key)
      .first<Record<string, unknown>>();
    if (existing === null) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const deleted = await this.db
      .prepare(ABANDON_SQL)
      .bind(op.scope, op.key, fence)
      .first<{ fence: number }>();
    if (deleted !== null) return 'ok';
    const existing = await this.db
      .prepare(SELECT_SQL)
      .bind(op.scope, op.key)
      .first<Record<string, unknown>>();
    if (existing === null) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const row = await this.db
      .prepare(GET_SQL)
      .bind(op.scope, op.key, now)
      .first<Record<string, unknown>>();
    return row === null ? null : rowToRecord(asRow(row));
  }

  async purge(now: number): Promise<number> {
    const { results } = await this.db.prepare(PURGE_SQL).bind(now).all();
    return results.length;
  }

  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.db.prepare(REMOVE_SQL).bind(op.scope, op.key).run();
  }
}
