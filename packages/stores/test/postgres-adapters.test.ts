import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromNeon, fromPostgresJs, MIGRATION_SQL } from '../src/postgres';
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
    expect(await fromPostgresJs(sql).query('SELECT $1', [1])).toEqual({ rows: [{ a: 1 }] });
    const neon = {
      query: async (text: string, params: unknown[]) => {
        seen.push([text, params]);
        return [{ b: 2 }];
      },
    };
    expect(await fromNeon(neon).query('SELECT $1', [2])).toEqual({ rows: [{ b: 2 }] });
    expect(seen).toEqual([
      ['SELECT $1', [1]],
      ['SELECT $1', [2]],
    ]);
  });
});
