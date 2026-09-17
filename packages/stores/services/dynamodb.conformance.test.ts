import { expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DYNAMODB_MAX_RESULT_BYTES, DynamoDbStore, ensureTable } from '../src/dynamodb';
import { describeService } from './services';

await describeService('dynamodb conformance', 18000, () => {
  test('REQ-ST-DDB-1: every core and profile vector passes through withIdempotency with the DynamoDB store', async () => {
    const client = new DynamoDBClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:18000',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const table = `anyonce_conf_${Date.now()}`;
    await ensureTable(client, table);
    const store = new DynamoDbStore({ client, tableName: table });
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: 2000,
      maxResultBytes: DYNAMODB_MAX_RESULT_BYTES,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    try {
      const { summary, report } = await runConformance({
        target: handler,
        capabilities: ['short-ttl'],
        report: 'markdown',
      });
      const notPassing = summary.results
        .filter((r) => r.status !== 'pass')
        .map((r) => `${r.id}: ${r.status}`);
      expect(notPassing, report).toEqual([]);
      expect(summary.passed).toBe(20);
    } finally {
      // A failed run must still release the socket, otherwise bun hangs on the open handle.
      client.destroy();
    }
  }, 60_000);
});
