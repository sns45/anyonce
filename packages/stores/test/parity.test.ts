import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ABANDON_CONDITION,
  BEGIN_CONDITION,
  BEGIN_UPDATE,
  COMPLETE_CONDITION,
} from '../src/dynamodb';
import { ABANDON_LUA, BEGIN_LUA, COMPLETE_LUA } from '../src/redis';
import {
  ABANDON_SQL,
  BEGIN_SQL,
  COMPLETE_SQL,
  GET_SQL,
  POSTGRES_SCHEMA,
  PURGE_SQL,
  REMOVE_SQL,
  SELECT_SQL,
  SQLITE_SCHEMA,
} from '../src/sql';

const root = join(import.meta.dir, '../../..');

const goSource = (path: string): string => readFileSync(join(root, path), 'utf8');

/**
 * The value of a Go backtick constant, so a parity assertion compares the two texts rather than asking whether
 * one appears somewhere in the file. A raw literal cannot contain a backtick, so the first one ends it.
 */
function goConst(source: string, name: string): string {
  const match = new RegExp(`const ${name} = \`([^\`]*)\``).exec(source);
  if (match?.[1] === undefined)
    throw new Error(`${name} is not a backtick string constant in the Go source`);
  return match[1];
}

describe('cross-language parity', () => {
  test('REQ-ST-REDIS-1: the Go Lua scripts are byte identical to the TypeScript ones', () => {
    const go = goSource('go/store/redis/scripts.go');
    const scripts: [string, string][] = [
      ['beginLua', BEGIN_LUA],
      ['completeLua', COMPLETE_LUA],
      ['abandonLua', ABANDON_LUA],
    ];
    for (const [name, script] of scripts) expect(goConst(go, name).trim()).toBe(script.trim());
  });

  test('REQ-ST-PG-1: the Go sqlstore statements are byte identical to the TypeScript SQL text', () => {
    const go = goSource('go/store/internal/sqlstore/sqlstore.go');
    const statements: [string, string][] = [
      ['beginSQL', BEGIN_SQL],
      ['completeSQL', COMPLETE_SQL],
      ['abandonSQL', ABANDON_SQL],
      ['getSQL', GET_SQL],
      ['selectSQL', SELECT_SQL],
      ['purgeSQL', PURGE_SQL],
      ['removeSQL', REMOVE_SQL],
    ];
    for (const [name, text] of statements) expect(goConst(go, name).trim()).toBe(text.trim());
  });

  test('REQ-ST-DDB-1: the Go DynamoDB expressions are byte identical to the TypeScript ones', () => {
    const go = goSource('go/store/dynamodb/dynamodb.go');
    const expressions: [string, string][] = [
      ['beginCondition', BEGIN_CONDITION],
      ['beginUpdate', BEGIN_UPDATE],
      ['completeCondition', COMPLETE_CONDITION],
      ['abandonCondition', ABANDON_CONDITION],
    ];
    for (const [name, text] of expressions) expect(goConst(go, name).trim()).toBe(text.trim());
  });

  test('REQ-ST-PG-1: the Go Postgres schema file equals the TypeScript schema', () => {
    expect(goSource('go/store/postgres/schema.sql').trim()).toBe(POSTGRES_SCHEMA.trim());
  });

  test('REQ-ST-SQLITE-1: the Go SQLite schema file equals the TypeScript SQLite schema', () => {
    expect(goSource('go/store/sqlite/schema.sql').trim()).toBe(SQLITE_SCHEMA.trim());
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

  test('REQ-ST-PG-1: goConst refuses a name that is not a backtick constant, so a rename cannot pass silently', () => {
    expect(() => goConst('const other = `x`', 'beginSQL')).toThrow(/beginSQL/);
  });
});
