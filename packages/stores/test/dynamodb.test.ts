import { describe, expect, test } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DYNAMODB_MAX_RESULT_BYTES, DynamoDbStore } from '../src/dynamodb';

const REFUSED = 'the test client must not be called';

/** Counts sends and never answers one: the check under test runs before the store talks to DynamoDB. */
function refusingClient(sends: { count: number }): DynamoDBClient {
  return {
    send: async () => {
      sends.count++;
      throw new Error(REFUSED);
    },
  } as unknown as DynamoDBClient;
}

async function completeWith(body: Uint8Array, sends: { count: number }): Promise<string> {
  const store = new DynamoDbStore({ client: refusingClient(sends), tableName: 't' });
  try {
    await store.complete(
      { scope: 's', key: 'k', fingerprint: 'f' },
      1,
      { kind: 'http', status: 200, body },
      0,
    );
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('dynamodb store limits', () => {
  test('REQ-ST-DDB-1: complete refuses a body above the item cap and names maxResultBytes (Q20)', async () => {
    const sends = { count: 0 };
    const body = new Uint8Array(DYNAMODB_MAX_RESULT_BYTES + 1);
    expect(body.byteLength).toBe(307_201);
    const message = await completeWith(body, sends);
    expect(message).toContain('maxResultBytes');
    expect(message).toContain('307201');
    expect(message).toContain(String(DYNAMODB_MAX_RESULT_BYTES));
    expect(sends.count).toBe(0);
  });

  test('REQ-ST-DDB-1: a body exactly at the cap is handed to DynamoDB rather than refused', async () => {
    const sends = { count: 0 };
    const message = await completeWith(new Uint8Array(DYNAMODB_MAX_RESULT_BYTES), sends);
    expect(message).toBe(REFUSED);
    expect(sends.count).toBe(1);
  });
});
