import type {
  BeginOptions,
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import {
  type AttributeValue,
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  GetItemCommand,
  ResourceInUseException,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';

/** Q20: a DynamoDB item is capped at 400 KB, so bodies above this are stored in the omitted form. */
export const DYNAMODB_MAX_RESULT_BYTES = 307_200;

/** Unit separator: the scope and key are joined with it so one composed partition key stays unambiguous. */
const KEY_SEPARATOR = String.fromCharCode(31);

/** Q22: the item key is the single partition key pk, the scope and the key joined by the unit separator. */
export function itemKey(op: Pick<Operation, 'scope' | 'key'>): string {
  return `${op.scope}${KEY_SEPARATOR}${op.key}`;
}

export interface DynamoDbStoreOptions {
  client: DynamoDBClient;
  /** Default anyonce_records. One partition key, pk, holding the scope and the key (Q22). No sort key. */
  tableName?: string;
  /** Added to the native ttl attribute so a late complete from the previous fence holder still finds its row. Default 60000. */
  nativeTtlGraceMs?: number;
}

type Item = Record<string, AttributeValue>;

function n(value: number): AttributeValue {
  return { N: String(value) };
}

function itemToRow(item: Item): RecordRow {
  const pk = item.pk?.S ?? '';
  // Split on the first separator: a scope never contains one, a key may.
  const at = pk.indexOf(KEY_SEPARATOR);
  return {
    scope: at === -1 ? pk : pk.slice(0, at),
    key: at === -1 ? '' : pk.slice(at + 1),
    fingerprint: item.fingerprint?.S ?? '',
    state: (item.state?.S as RecordRow['state']) ?? 'in_flight',
    fence: Number(item.fence?.N ?? 0),
    lease_until: Number(item.lease_until?.N ?? 0),
    created_at: Number(item.created_at?.N ?? 0),
    expires_at: Number(item.expires_at?.N ?? 0),
    result_meta: item.result_meta?.S ?? null,
    result_body: item.result_body?.B ?? null,
    result_omitted: Number(item.result_omitted?.N ?? 0),
  };
}

/**
 * REQ-ST-DDB-1. begin, complete and abandon are each one conditional write; a refused write carries the old item
 * back through ReturnValuesOnConditionCheckFailure, so no second read is needed to classify it.
 */
export class DynamoDbStore implements Store {
  private readonly client: DynamoDBClient;
  private readonly table: string;
  private readonly grace: number;

  constructor(options: DynamoDbStoreOptions) {
    this.client = options.client;
    this.table = options.tableName ?? 'anyonce_records';
    this.grace = options.nativeTtlGraceMs ?? 60_000;
  }

  private key(op: Pick<Operation, 'scope' | 'key'>): Item {
    return { pk: { S: itemKey(op) } };
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ttlSeconds = Math.floor((Date.now() + opts.ttlMs + this.grace) / 1000);
      try {
        const out = await this.client.send(
          new UpdateItemCommand({
            TableName: this.table,
            Key: this.key(op),
            ConditionExpression:
              'attribute_not_exists(pk) OR expires_at <= :now OR (fingerprint = :fp AND #state = :in_flight AND lease_until <= :now)',
            UpdateExpression:
              'SET fingerprint = :fp, #state = :in_flight, fence = if_not_exists(fence, :zero) + :one, lease_until = :lease, created_at = :now, expires_at = :exp, #ttl = :ttl, result_omitted = :zero REMOVE result_meta, result_body',
            ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':fp': { S: op.fingerprint },
              ':in_flight': { S: 'in_flight' },
              ':now': n(opts.now),
              ':zero': n(0),
              ':one': n(1),
              ':lease': n(opts.now + opts.leaseMs),
              ':exp': n(opts.now + opts.ttlMs),
              ':ttl': n(ttlSeconds),
            },
            ReturnValues: 'ALL_NEW',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        return { outcome: 'acquired', fence: Number(out.Attributes?.fence?.N) };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        if (error.Item === undefined)
          throw new Error(
            'anyonce: dynamodb refused the begin write without returning the old item, so the refusal cannot be classified; the endpoint must honour ReturnValuesOnConditionCheckFailure (DynamoDB Local 2.x or later, or a live table)',
            { cause: error },
          );
        const row = itemToRow(error.Item as Item);
        if (row.expires_at <= opts.now) continue;
        const record = rowToRecord(row);
        if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
        if (row.state === 'completed') return { outcome: 'completed', record };
        if (row.lease_until > opts.now)
          return { outcome: 'in_flight', leaseUntil: row.lease_until };
      }
    }
    throw new Error(
      'anyonce: dynamodb begin could not settle after three attempts; the row for this scope and key expired or was rewritten between every conditional write and its classification, or the stored row is malformed (expires_at not a number)',
    );
  }

  async complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? undefined : result.body;
    if (body !== undefined && body.byteLength > DYNAMODB_MAX_RESULT_BYTES)
      throw new Error(
        `anyonce: dynamodb cannot store a ${body.byteLength} byte body because an item is capped at 400 KB (Q20); set maxResultBytes to at most ${DYNAMODB_MAX_RESULT_BYTES} so a larger result is stored in the omitted form instead`,
      );
    const values: Item = {
      ':fence': n(fence),
      ':now': n(now),
      ':in_flight': { S: 'in_flight' },
      ':completed': { S: 'completed' },
      ':meta': { S: encodeResultMeta(result) },
      ':om': n(omitted ? 1 : 0),
    };
    let update = 'SET #state = :completed, result_meta = :meta, result_omitted = :om';
    if (body !== undefined) {
      values[':body'] = { B: body };
      update += ', result_body = :body';
    } else {
      update += ' REMOVE result_body';
    }
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: this.key(op),
          ConditionExpression: 'fence = :fence AND expires_at > :now AND #state = :in_flight',
          UpdateExpression: update,
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: values,
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (error.Item === undefined) return 'not_found';
      const row = itemToRow(error.Item as Item);
      if (row.expires_at <= now) return 'not_found';
      if (row.fence !== fence) return 'stale_fence';
      return 'ok';
    }
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: this.key(op),
          ConditionExpression: 'fence = :fence AND #state = :in_flight',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':fence': n(fence), ':in_flight': { S: 'in_flight' } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (error.Item === undefined) return 'not_found';
      const row = itemToRow(error.Item as Item);
      if (row.state !== 'in_flight') return 'not_found';
      return row.fence === fence ? 'not_found' : 'stale_fence';
    }
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const out = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: this.key(op), ConsistentRead: true }),
    );
    if (out.Item === undefined) return null;
    const row = itemToRow(out.Item as Item);
    return row.expires_at > now ? rowToRecord(row) : null;
  }

  /** Native TTL sweeps expired items; nothing to do here (REQ-ST-DDB-1). */
  async purge(_now: number): Promise<number> {
    return 0;
  }

  /** Test-only: what a TTL sweep would do. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: this.key(op) }));
  }
}

/**
 * Creates the table with the single pk string partition key, on-demand billing and TTL on the ttl attribute.
 * Idempotent. Meant for tests and local development; a production table comes from infrastructure code.
 */
export async function ensureTable(
  client: DynamoDBClient,
  tableName = 'anyonce_records',
): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  let active = false;
  for (let i = 0; i < 50; i++) {
    const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (described.Table?.TableStatus === 'ACTIVE') {
      active = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!active)
    throw new Error(
      `anyonce: dynamodb table ${tableName} did not become ACTIVE within 10 seconds; create it out of band or retry once the table finishes provisioning`,
    );
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      }),
    );
  } catch (error) {
    // Already enabled: DynamoDB answers with a ValidationException naming the current state.
    if (!(error instanceof Error && /TimeToLive is already enabled/i.test(error.message)))
      throw error;
  }
}
