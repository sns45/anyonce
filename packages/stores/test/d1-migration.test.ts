import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_SQL } from '../src/d1';
import { SQLITE_SCHEMA } from '../src/sql';

describe('d1 migration', () => {
  test('REQ-ST-D1-1: the D1 migration file is the embedded SQLite schema', () => {
    expect(readFileSync(join(import.meta.dir, '../migrations/d1/0001_anyonce.sql'), 'utf8')).toBe(
      MIGRATION_SQL,
    );
    expect(MIGRATION_SQL).toBe(SQLITE_SCHEMA);
  });
});
