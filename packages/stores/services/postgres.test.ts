import { afterAll, describe, expect, test } from 'bun:test';
import { storeContractSuite } from '@anyonce/core/testing';
import { Pool } from 'pg';
import postgres from 'postgres';
import { ensureSchema, fromPostgresJs, PostgresStore } from '../src/postgres';
import { describeService } from './services';

const URL = 'postgres://anyonce:anyonce@127.0.0.1:15432/anyonce';

await describeService('postgres store', 15432, () => {
  const pool = new Pool({ connectionString: URL, max: 60 });
  const ready = ensureSchema(pool);

  storeContractSuite(
    'postgres-pg',
    async () => {
      await ready;
      const store = new PostgresStore({ query: pool });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  const sql = postgres(URL, { max: 60 });
  storeContractSuite(
    'postgres-postgresjs',
    async () => {
      await ready;
      const store = new PostgresStore({ query: fromPostgresJs(sql) });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  afterAll(async () => {
    await pool.end();
    await sql.end();
  });

  describe('postgres specifics', () => {
    test('REQ-ST-PG-1: ensureSchema applies the migration idempotently and the expires_at index exists', async () => {
      await ready;
      await ensureSchema(pool);
      const { rows } = await pool.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'anyonce_records'",
      );
      expect(rows.map((r: { indexname: string }) => r.indexname)).toContain(
        'anyonce_records_expires_at',
      );
    });
  });
});
