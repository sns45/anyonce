import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ABANDON_LUA, BEGIN_LUA, COMPLETE_LUA } from '../src/redis';
import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from '../src/sql';

const root = join(import.meta.dir, '../../..');

describe('cross-language parity', () => {
  test('REQ-ST-REDIS-1: the Go Lua scripts are byte identical to the TypeScript ones', () => {
    const go = readFileSync(join(root, 'go/store/redis/scripts.go'), 'utf8');
    for (const script of [BEGIN_LUA, COMPLETE_LUA, ABANDON_LUA])
      expect(go).toContain(script.trim());
  });

  test('REQ-ST-PG-1: the Go Postgres schema file equals the TypeScript schema', () => {
    expect(readFileSync(join(root, 'go/store/postgres/schema.sql'), 'utf8').trim()).toBe(
      POSTGRES_SCHEMA.trim(),
    );
  });

  test('REQ-ST-SQLITE-1: the Go SQLite schema file equals the TypeScript SQLite schema', () => {
    expect(readFileSync(join(root, 'go/store/sqlite/schema.sql'), 'utf8').trim()).toBe(
      SQLITE_SCHEMA.trim(),
    );
  });

  test('REQ-ST-D1-1: the committed D1 and Postgres migrations are the schemas the stores apply', () => {
    const d1 = readFileSync(
      join(root, 'packages/stores/migrations/d1/0001_anyonce.sql'),
      'utf8',
    ).trim();
    const pg = readFileSync(
      join(root, 'packages/stores/migrations/postgres/0001_anyonce.sql'),
      'utf8',
    ).trim();
    expect(d1).toBe(SQLITE_SCHEMA.trim());
    expect(pg).toBe(POSTGRES_SCHEMA.trim());
  });
});
