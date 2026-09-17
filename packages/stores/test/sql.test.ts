import { describe, expect, test } from 'bun:test';
import {
  ABANDON_SQL,
  BEGIN_SQL,
  COMPLETE_SQL,
  GET_SQL,
  PURGE_SQL,
  pgSql,
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

  test('REQ-ST-D1-1: complete and abandon are single conditional statements on fence and state', () => {
    expect(COMPLETE_SQL).toContain("state = 'completed'");
    expect(COMPLETE_SQL).toContain(
      "WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight'",
    );
    expect(ABANDON_SQL).toContain(
      "DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'",
    );
    expect(GET_SQL).toContain('expires_at > ?3');
    expect(PURGE_SQL).toContain('DELETE FROM anyonce_records WHERE expires_at <= ?1');
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
});
