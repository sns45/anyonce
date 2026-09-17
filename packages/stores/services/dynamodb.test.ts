import { describe, expect, test } from 'bun:test';
import { LEASE_MS, storeContractSuite, T0, TTL_MS } from '@anyonce/core/testing';
import {
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { DYNAMODB_MAX_RESULT_BYTES, DynamoDbStore, ensureTable, itemKey } from '../src/dynamodb';
import { describeService } from './services';

const TABLE = `anyonce_test_${Date.now()}`;

function client(): DynamoDBClient {
  return new DynamoDBClient({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:18000',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

await describeService('dynamodb store', 18000, () => {
  const shared = client();
  const ready = ensureTable(shared, TABLE);

  storeContractSuite(
    'dynamodb',
    async () => {
      await ready;
      const store = new DynamoDbStore({ client: shared, tableName: TABLE });
      return {
        store,
        physicallyRemove: (op) => store.physicallyRemove(op),
        maxResultBytes: DYNAMODB_MAX_RESULT_BYTES,
      };
    },
    { describe, test, expect },
    { maxResultBytes: DYNAMODB_MAX_RESULT_BYTES, nativePurge: true },
  );

  describe('dynamodb specifics', () => {
    test('REQ-ST-DDB-1: a refused begin classifies the outcome from ReturnValuesOnConditionCheckFailure with no second call', async () => {
      await ready;
      let commands: string[] = [];
      const counting = client();
      counting.middlewareStack.add(
        (next, context) => async (args) => {
          commands.push(context.commandName ?? 'unknown');
          return next(args);
        },
        { step: 'initialize', name: 'count', priority: 'low' },
      );
      const store = new DynamoDbStore({ client: counting, tableName: TABLE });
      const op = { scope: `rvocf-${Date.now()}`, key: 'k', fingerprint: 'a' };
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
      await store.complete(op, 1, { kind: 'http', status: 200, body: new Uint8Array([1]) }, T0 + 1);
      commands = [];
      const mismatch = await store.begin(
        { ...op, fingerprint: 'b' },
        { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 2 },
      );
      expect(mismatch.outcome).toBe('mismatch');
      expect(commands).toEqual(['UpdateItemCommand']);
      commands = [];
      const completed = await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 3 });
      expect(completed.outcome).toBe('completed');
      if (completed.outcome === 'completed')
        expect(completed.record.result?.body).toEqual(new Uint8Array([1]));
      expect(commands).toEqual(['UpdateItemCommand']);
      counting.destroy();
    });

    test('REQ-ST-DDB-1: the ttl attribute is enabled on the table and set relative to the wall clock plus the grace', async () => {
      await ready;
      const ttlSpec = await shared.send(new DescribeTimeToLiveCommand({ TableName: TABLE }));
      expect(ttlSpec.TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED');
      expect(ttlSpec.TimeToLiveDescription?.AttributeName).toBe('ttl');
      const store = new DynamoDbStore({
        client: shared,
        tableName: TABLE,
        nativeTtlGraceMs: 60_000,
      });
      const op = { scope: `ttl-${Date.now()}`, key: 'k', fingerprint: 'a' };
      const before = Date.now();
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: 5_000, now: T0 });
      const item = await shared.send(
        new GetItemCommand({
          TableName: TABLE,
          Key: { pk: { S: itemKey(op) } },
          ConsistentRead: true,
        }),
      );
      const ttl = Number(item.Item?.ttl?.N);
      expect(ttl).toBeGreaterThan(Math.floor((before + 5_000 + 60_000) / 1000) - 2);
      expect(ttl).toBeLessThan(Math.floor((before + 5_000 + 60_000) / 1000) + 5);
      expect(Number(item.Item?.expires_at?.N)).toBe(T0 + 5_000);
    });

    test('REQ-ST-DDB-1: the item lives under the single partition key pk, the scope and key joined (Q22)', async () => {
      await ready;
      const store = new DynamoDbStore({ client: shared, tableName: TABLE });
      const op = { scope: `q22-${Date.now()}`, key: 'k/with/slashes', fingerprint: 'a' };
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
      const composite = `${op.scope}${String.fromCharCode(31)}${op.key}`;
      expect(itemKey(op)).toBe(composite);
      const found = await shared.send(
        new GetItemCommand({
          TableName: TABLE,
          Key: { pk: { S: composite } },
          ConsistentRead: true,
        }),
      );
      expect(found.Item?.pk?.S).toBe(composite);
      expect(found.Item?.sk).toBeUndefined();
      expect(Number(found.Item?.fence?.N)).toBe(1);
      // The row still decodes back into its scope and key.
      const record = await store.get(op, T0 + 1);
      expect(record?.scope).toBe(op.scope);
      expect(record?.key).toBe(op.key);
    });

    test('REQ-ST-DDB-1: purge is a no-op that returns 0 and ensureTable is idempotent', async () => {
      await ready;
      const store = new DynamoDbStore({ client: shared, tableName: TABLE });
      expect(await store.purge(Date.now())).toBe(0);
      await ensureTable(shared, TABLE);
    });
  });
});
