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
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';
import {
  ABANDON_SQL,
  BEGIN_SQL,
  COMPLETE_SQL,
  GET_SQL,
  POSTGRES_SCHEMA,
  PURGE_SQL,
  pgSql,
  REMOVE_SQL,
  SELECT_SQL,
} from './sql';

/**
 * The one call the store needs. pg clients and pools satisfy it directly. rowCount is how many rows the
 * statement affected, which is what `purge` reports; pg types it as `number | null` (null for a statement that
 * reports no count), so the store reads it as `rowCount ?? 0`.
 */
export interface PostgresQuery {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** postgres.js resolves to the row array itself, carrying the affected-row count on its `count` property. */
export function fromPostgresJs(sql: {
  unsafe(text: string, params?: unknown[]): Promise<unknown>;
}): PostgresQuery {
  return {
    query: async (text, params) => {
      const result = (await sql.unsafe(text, params)) as Record<string, unknown>[] & {
        count?: number;
      };
      return { rows: result, rowCount: result.count ?? null };
    },
  };
}

/**
 * Neon's HTTP driver must be constructed as `neon(url, { fullResults: true })`. By default a query resolves to
 * a bare row array, which carries no affected-row count, so `purge` would have nothing to report; with
 * fullResults each query resolves to `{ rows, rowCount }`, which is what this adapter maps. A bare array is
 * refused with a message naming the option rather than silently purging and reporting 0.
 */
export function fromNeon(sql: {
  query(text: string, params: unknown[]): Promise<unknown>;
}): PostgresQuery {
  return {
    query: async (text, params) => {
      const result = (await sql.query(text, params)) as {
        rows?: Record<string, unknown>[];
        rowCount?: number | null;
      };
      if (!Array.isArray(result?.rows))
        throw new TypeError(
          'anyonce: fromNeon needs the full result shape; construct the client as neon(url, { fullResults: true }) so every query resolves to { rows, rowCount }',
        );
      return { rows: result.rows, rowCount: result.rowCount ?? null };
    },
  };
}

export const MIGRATION_SQL = POSTGRES_SCHEMA;

export async function ensureSchema(query: PostgresQuery): Promise<void> {
  for (const statement of MIGRATION_SQL.split(';')) {
    if (statement.trim()) await query.query(statement, []);
  }
}

export interface PostgresStoreOptions {
  query: PostgresQuery;
}

const BEGIN = pgSql(BEGIN_SQL);
const COMPLETE = pgSql(COMPLETE_SQL);
const ABANDON = pgSql(ABANDON_SQL);
const GET = pgSql(GET_SQL);
const SELECT = pgSql(SELECT_SQL);
const PURGE = pgSql(PURGE_SQL);
const REMOVE = pgSql(REMOVE_SQL);

function asRow(r: Record<string, unknown>): RecordRow {
  return {
    scope: String(r.scope),
    key: String(r.key),
    fingerprint: String(r.fingerprint),
    state: r.state as RecordRow['state'],
    fence: Number(r.fence),
    lease_until: Number(r.lease_until),
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    result_meta:
      r.result_meta === null || r.result_meta === undefined ? null : String(r.result_meta),
    result_body:
      r.result_body === null || r.result_body === undefined
        ? null
        : new Uint8Array(r.result_body as ArrayLike<number>),
    result_omitted: Number(r.result_omitted),
  };
}

/** REQ-ST-PG-1: begin is one INSERT ON CONFLICT DO UPDATE; a refused write is classified by one SELECT. */
export class PostgresStore implements Store {
  private readonly db: PostgresQuery;

  constructor(options: PostgresStoreOptions) {
    this.db = options.query;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await this.db.query(BEGIN, [
        op.scope,
        op.key,
        op.fingerprint,
        opts.now,
        opts.now + opts.leaseMs,
        opts.now + opts.ttlMs,
      ]);
      if (rows[0] !== undefined) return { outcome: 'acquired', fence: Number(rows[0].fence) };
      const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
      if (existing === undefined) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      // The lease lapsed between the refused claim and this read, so retry rather than fall out of the loop.
      if (row.lease_until <= opts.now) continue;
      return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: postgres begin could not settle after three attempts');
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? null : (result.body ?? null);
    const { rows } = await this.db.query(COMPLETE, [
      op.scope,
      op.key,
      fence,
      now,
      encodeResultMeta(result),
      body,
      omitted ? 1 : 0,
    ]);
    if (rows[0] !== undefined) return 'ok';
    const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const { rows } = await this.db.query(ABANDON, [op.scope, op.key, fence]);
    if (rows[0] !== undefined) return 'ok';
    const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(GET, [op.scope, op.key, now]);
    return rows[0] === undefined ? null : rowToRecord(asRow(rows[0]));
  }

  /** The driver's affected-row count, not a RETURNING row per record, so a large sweep costs no extra memory. */
  async purge(now: number): Promise<number> {
    return (await this.db.query(PURGE, [now])).rowCount ?? 0;
  }

  /** Test-only physical removal. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.db.query(REMOVE, [op.scope, op.key]);
  }
}
