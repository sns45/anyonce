/**
 * A local function URL: Bun.serve turns each HTTP request into a payload 2.0 event, calls the handler, and
 * writes the result back. The smoke test drives the same harness; `bun run start` serves the example with it
 * against DynamoDB Local from test/compose.yml.
 */
import { DynamoDbStore, ensureTable } from '@anyonce/stores/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { type FunctionUrlEvent, type FunctionUrlResult, fromResult, toEvent } from './function-url';
import { createApp, functionUrlHandler } from './handler';

export interface FunctionUrlServerOptions {
  handler: (event: FunctionUrlEvent) => Promise<FunctionUrlResult>;
  port: number;
  /** A request this returns a response for never reaches the function (a test control path). */
  control?: (req: Request) => Response | Promise<Response> | undefined;
}

export function serveFunctionUrl(options: FunctionUrlServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(req) {
      const direct = options.control?.(req);
      if (direct !== undefined) return direct;
      return fromResult(await options.handler(await toEvent(req)));
    },
  });
}

/** A client for DynamoDB Local; the credentials are placeholders it accepts. */
export function localClient(endpoint: string): DynamoDBClient {
  return new DynamoDBClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

if (import.meta.main) {
  const client = localClient(process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:18000');
  const tableName = process.env.TABLE_NAME ?? 'anyonce_records';
  await ensureTable(client, tableName);
  const server = serveFunctionUrl({
    handler: functionUrlHandler(createApp({ store: new DynamoDbStore({ client, tableName }) })),
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`function URL harness on ${server.url}`);
}
