import type { Store } from '@anyonce/core';
import { type HttpIdempotencyOptions, withIdempotency } from '@anyonce/core/http';
import { DynamoDbStore } from '@anyonce/stores/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { type FunctionUrlEvent, type FunctionUrlResult, toRequest, toResult } from './function-url';

/**
 * A DynamoDB item holds at most 400 KB, attribute names included, so a stored response body must stay well
 * under it. 300 KiB leaves room for the record's other attributes; a larger response is stored in the omitted
 * form (status and headers replay, the body does not). The DynamoDB store declares the same cap itself.
 */
export const MAX_RESULT_BYTES = 300 * 1024;

export type FetchHandler = (req: Request) => Response | Promise<Response>;

export interface AppDeps {
  store: Store;
  /** How long a completed result replays. Default 24 hours (the anyonce default). */
  ttlMs?: number;
  /** The routes behind the idempotency layer. Default: the payments route below. */
  routes?: FetchHandler;
}

/** The example's one route: creates a payment and answers 201 with its id. */
export async function routes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/payments') {
    let payment: { amount: number; currency: string };
    try {
      payment = (await req.json()) as { amount: number; currency: string };
    } catch {
      return new Response('body must be JSON with an amount and a currency', { status: 400 });
    }
    const { amount, currency } = payment;
    // Runs once per key: a retry with the same key and body gets this exact response back, id included.
    return Response.json({ id: crypto.randomUUID(), amount, currency }, { status: 201 });
  }
  return new Response('not found', { status: 404 });
}

/** The withIdempotency configuration this example runs with. */
export function idempotencyOptions(deps: AppDeps): HttpIdempotencyOptions {
  const options: HttpIdempotencyOptions = {
    store: deps.store,
    // A POST without Idempotency-Key is a 400 missing-key rather than an unprotected write.
    required: true,
    maxResultBytes: MAX_RESULT_BYTES,
  };
  if (deps.ttlMs !== undefined) options.ttlMs = deps.ttlMs;
  return options;
}

/** The fetch handler: the routes wrapped by withIdempotency. */
export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return withIdempotency(deps.routes ?? routes, idempotencyOptions(deps));
}

/** Adapts a fetch handler to a function URL (payload format 2.0). */
export function functionUrlHandler(
  app: (req: Request) => Promise<Response>,
): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  // toResult reads the whole body before returning, and the record completes before the body closes, so the
  // stored response is in DynamoDB before Lambda freezes the execution environment.
  return async (event) => toResult(await app(toRequest(event)));
}

let cached: ((event: FunctionUrlEvent) => Promise<FunctionUrlResult>) | undefined;

/** The Lambda entry point. TABLE_NAME names the table; region and credentials come from the Lambda runtime. */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  cached ??= functionUrlHandler(
    createApp({
      store: new DynamoDbStore({
        client: new DynamoDBClient({}),
        tableName: process.env.TABLE_NAME ?? 'anyonce_records',
      }),
    }),
  );
  return cached(event);
}
