# lambda-fetch-dynamodb

An AWS Lambda function behind a function URL. The function is an ordinary fetch handler
(`(req: Request) => Promise<Response>`) wrapped by `withIdempotency` from `@anyonce/core/http`, with the
records in DynamoDB (`@anyonce/stores/dynamodb`). A small adapter converts the function URL event to a
`Request` and the `Response` back to a function URL result, so the same handler runs anywhere fetch does.

## What it shows

- [`src/function-url.ts`](./src/function-url.ts): `toRequest(event)` and `toResult(response)` for payload
  format 2.0. Bodies are base64 in both directions, so binary bodies survive; cookies move between the
  `cookies` arrays and the `Cookie` and `Set-Cookie` headers.
- [`src/handler.ts`](./src/handler.ts): `handler(event)`, the Lambda entry point.

```ts
import { withIdempotency } from '@anyonce/core/http';
import { DynamoDbStore } from '@anyonce/stores/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { type FunctionUrlEvent, type FunctionUrlResult, toRequest, toResult } from './function-url';

const store = new DynamoDbStore({
  client: new DynamoDBClient({}),
  tableName: process.env.TABLE_NAME ?? 'anyonce_records',
});

// routes is the plain fetch handler: POST /payments answers 201 with a new payment id.
const app = withIdempotency(routes, {
  store,
  required: true,
  maxResultBytes: 300 * 1024,
});

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  return toResult(await app(toRequest(event)));
}
```

### Why `maxResultBytes` is 300 KiB

A DynamoDB item holds at most 400 KB, attribute names and the record's other fields included, so the
stored response body cannot use the default 1 MiB cap. 300 KiB leaves headroom. A response larger than
that still reaches the client whole; its record is stored in the omitted form, so a retry replays the
status and headers with an empty body and `Idempotency-Replay: omitted`. The DynamoDB store declares the
same cap itself (`DynamoDbStore.maxResultBytes`), and `withIdempotency` never exceeds a store's cap; the
example sets it explicitly so the limit is visible where the handler is configured. See
[docs/stores.md](../../docs/stores.md) for every store's cap.

`toResult` reads the whole response body before it returns, and the idempotency record completes before
that body closes, so the record is in DynamoDB before Lambda freezes the execution environment.

## Run it locally

DynamoDB Local from the repository's compose file stands in for DynamoDB, and
[`src/local.ts`](./src/local.ts) stands in for the function URL: a `Bun.serve` that turns each HTTP request
into a payload 2.0 event, calls the same function URL handler with a DynamoDB Local client, and writes
the result back. From the repository root:

```sh
bun install
bun run build
docker compose -f test/compose.yml up -d --wait dynamodb
cd examples/lambda-fetch-dynamodb
bun run start
```

It creates the table (`anyonce_records`, or `TABLE_NAME`) on DynamoDB Local at `http://127.0.0.1:18000`
(or `DYNAMODB_ENDPOINT`) and listens on port 3000 (or `PORT`). In AWS, create the table with a string
partition key `pk` and TTL on the `ttl` attribute, and set `TABLE_NAME` on the function.

## Try it

POST the same payment twice with one key:

```sh
curl -i -X POST http://127.0.0.1:3000/payments \
  -H 'Idempotency-Key: payment-1' -H 'Content-Type: application/json' \
  -d '{"amount":1200,"currency":"EUR"}'
curl -i -X POST http://127.0.0.1:3000/payments \
  -H 'Idempotency-Key: payment-1' -H 'Content-Type: application/json' \
  -d '{"amount":1200,"currency":"EUR"}'
```

The first response is `201` with a new payment id. The second is the same `201` with the same id and
`Idempotency-Replayed: true`: the payment was not created twice. The same key with a different amount is
`422` with the `fingerprint-mismatch` problem.

## Smoke test

[`test/smoke.test.ts`](./test/smoke.test.ts) checks the event conversion (headers, cookies, a binary body),
then, with DynamoDB Local up, runs the scenario above through the local function URL harness and the
conformance suite's core and profile tiers over HTTP against the fixture routes behind the same
`withIdempotency` configuration. Without DynamoDB Local the service tests skip with a message naming the
compose command. From the repository root:

```sh
bun run test:examples
```
