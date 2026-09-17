import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromNeon, fromPostgresJs, MIGRATION_SQL, PostgresStore } from '../src/postgres';
import { POSTGRES_SCHEMA } from '../src/sql';

describe('postgres adapters', () => {
  test('REQ-ST-PG-1: the migration file is the embedded schema', () => {
    expect(
      readFileSync(join(import.meta.dir, '../migrations/postgres/0001_anyonce.sql'), 'utf8'),
    ).toBe(MIGRATION_SQL);
    expect(MIGRATION_SQL).toBe(POSTGRES_SCHEMA);
  });

  test('REQ-ST-PG-1: fromPostgresJs uses unsafe with params and returns rows; fromNeon calls query', async () => {
    const seen: unknown[] = [];
    const sql = {
      unsafe: async (text: string, params: unknown[]) => {
        seen.push([text, params]);
        return [{ a: 1 }];
      },
    };
    expect(await fromPostgresJs(sql).query('SELECT $1', [1])).toEqual({
      rows: [{ a: 1 }],
      rowCount: null,
    });
    const neon = {
      query: async (text: string, params: unknown[]) => {
        seen.push([text, params]);
        return { rows: [{ b: 2 }], rowCount: 1 };
      },
    };
    expect(await fromNeon(neon).query('SELECT $1', [2])).toEqual({
      rows: [{ b: 2 }],
      rowCount: 1,
    });
    expect(seen).toEqual([
      ['SELECT $1', [1]],
      ['SELECT $1', [2]],
    ]);
  });

  test('REQ-ST-PG-1: fromPostgresJs reports the affected-row count that postgres.js carries on the result', async () => {
    const deleted = Object.assign([] as Record<string, unknown>[], { count: 7 });
    const sql = { unsafe: async () => deleted };
    expect(await fromPostgresJs(sql).query('DELETE FROM t', [])).toEqual({ rows: [], rowCount: 7 });
  });

  test('REQ-ST-PG-1: fromNeon refuses a bare row array and names the fullResults option', async () => {
    const bare = { query: async () => [{ b: 2 }] };
    await expect(fromNeon(bare).query('SELECT 1', [])).rejects.toThrow(/fullResults/);
  });

  test('REQ-ST-PG-1: purge reports the rowCount the driver gives rather than the rows it returned', async () => {
    const calls: string[] = [];
    const store = new PostgresStore({
      query: {
        query: async (text: string) => {
          calls.push(text);
          return { rows: [], rowCount: 5 };
        },
      },
    });
    expect(await store.purge(123)).toBe(5);
    expect(calls[0]).toBe('DELETE FROM anyonce_records WHERE expires_at <= $1');
    const noCount = new PostgresStore({ query: { query: async () => ({ rows: [] }) } });
    expect(await noCount.purge(123)).toBe(0);
  });
});
