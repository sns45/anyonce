import { describe, expect, test } from 'bun:test';
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
  SQLITE_SCHEMA,
} from '../src/sql';

describe('shared sql', () => {
  test('REQ-ST-D1-1: begin is one INSERT ON CONFLICT DO UPDATE with the TTL and lease conditions and the fence formula', () => {
    expect(BEGIN_SQL).toContain('INSERT INTO anyonce_records');
    expect(BEGIN_SQL).toContain('ON CONFLICT(scope, key) DO UPDATE SET');
    expect(BEGIN_SQL).toContain('fence = anyonce_records.fence + 1');
    expect(BEGIN_SQL).toContain('WHERE anyonce_records.expires_at <= ?4');
    expect(BEGIN_SQL).toContain(
      "anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4",
    );
    expect(BEGIN_SQL.trim().endsWith('RETURNING fence')).toBe(true);
    expect(BEGIN_SQL.split(';').filter((s) => s.trim()).length).toBe(1);
  });

  test('REQ-ST-PG-1: begin binds precomputed lease_until and expires_at instead of adding them in SQL, so pgSql never produces an ambiguous $4 + $5', () => {
    expect(BEGIN_SQL).toContain("VALUES (?1, ?2, ?3, 'in_flight', 1, ?5, ?4, ?6, NULL, NULL, 0)");
    expect(BEGIN_SQL).not.toContain('?4 + ?5');
    expect(BEGIN_SQL).not.toContain('?4 + ?6');
    expect(pgSql(BEGIN_SQL)).toContain(
      "VALUES ($1, $2, $3, 'in_flight', 1, $5, $4, $6, NULL, NULL, 0)",
    );
    expect(pgSql(BEGIN_SQL)).not.toContain('$4 + $5');
  });

  test('REQ-ST-D1-1: complete and abandon are single conditional statements on fence and state', () => {
    expect(COMPLETE_SQL).toContain("state = 'completed'");
    expect(COMPLETE_SQL).toContain(
      "WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight'",
    );
    expect(ABANDON_SQL).toContain(
      "DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'",
    );
    expect(GET_SQL).toContain('expires_at > ?3');
    expect(PURGE_SQL).toBe('DELETE FROM anyonce_records WHERE expires_at <= ?1');
    expect(SELECT_SQL).toContain('WHERE scope = ?1 AND key = ?2');
  });

  test('REQ-ST-PG-1: pgSql rewrites ?N placeholders to $N without touching quoted text', () => {
    expect(pgSql('SELECT ?1, ?2 FROM t WHERE x = ?10')).toBe('SELECT $1, $2 FROM t WHERE x = $10');
    expect(pgSql("SELECT '?1' FROM t WHERE y = ?1")).toBe("SELECT '?1' FROM t WHERE y = $1");
  });

  test('REQ-ST-D1-1: the schema creates the table with a composite primary key and an index on expires_at', () => {
    expect(SQLITE_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS anyonce_records');
    expect(SQLITE_SCHEMA).toContain('PRIMARY KEY (scope, key)');
    expect(SQLITE_SCHEMA).toContain('CREATE INDEX IF NOT EXISTS anyonce_records_expires_at');
  });

  test('REQ-ST-PG-1: the postgres schema uses BIGINT and BYTEA and creates the same primary key and index', () => {
    expect(POSTGRES_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS anyonce_records');
    expect(POSTGRES_SCHEMA).toContain('fence BIGINT NOT NULL');
    expect(POSTGRES_SCHEMA).toContain('lease_until BIGINT NOT NULL');
    expect(POSTGRES_SCHEMA).toContain('created_at BIGINT NOT NULL');
    expect(POSTGRES_SCHEMA).toContain('expires_at BIGINT NOT NULL');
    expect(POSTGRES_SCHEMA).toContain('result_body BYTEA');
    expect(POSTGRES_SCHEMA).toContain('result_omitted SMALLINT NOT NULL DEFAULT 0');
    expect(POSTGRES_SCHEMA).toContain('PRIMARY KEY (scope, key)');
    expect(POSTGRES_SCHEMA).toContain('CREATE INDEX IF NOT EXISTS anyonce_records_expires_at');
  });

  test('REQ-ST-PG-1: REMOVE_SQL is the test-only physical delete by scope and key with no RETURNING', () => {
    expect(REMOVE_SQL).toBe('DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2');
  });

  test('REQ-ST-PG-1: PURGE_SQL has no RETURNING, so a sweep is counted by the driver rather than materialized', () => {
    expect(PURGE_SQL).not.toContain('RETURNING');
    expect(pgSql(PURGE_SQL)).toBe('DELETE FROM anyonce_records WHERE expires_at <= $1');
  });
});
