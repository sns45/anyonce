# anyonce

One idempotency core for every way a request reaches a serverless system, in TypeScript and Go.

A request arrives through one of three doors, and all three deliver at least once: an HTTP endpoint keyed by the `Idempotency-Key` header, a queue consumer built on [anyq](https://github.com/sns45/anyq), and a webhook receiver keyed by the Standard Webhooks `webhook-id` header. anyonce puts the same state machine behind all three: claim the key in one atomic write, run the handler once, store the outcome, replay it to duplicates, answer a concurrent duplicate with 409 and a changed payload under the same key with 422. Six atomic stores, both languages, and a language-agnostic conformance suite for the IETF `Idempotency-Key` draft that any implementation can run.

[![conformance](https://img.shields.io/badge/conformance-core%2011%2F11%20%7C%20profile%209%2F9-brightgreen)](conformance/REPORT.md)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

## 30 seconds with Hono

```ts
import { MemoryStore } from '@anyonce/core';
import { idempotency } from '@anyonce/hono';
import { Hono } from 'hono';

const app = new Hono();

app.use('/orders', idempotency({ store: new MemoryStore() }));

app.post('/orders', async (c) => {
  const { item } = await c.req.json<{ item: string }>();
  return c.json({ id: crypto.randomUUID(), item }, 201);
});

export default app;
```

Run it with `bun run app.ts` and send the same order twice under one key:

```sh
curl -i -X POST http://localhost:3000/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' -d '{"item":"book"}'
curl -i -X POST http://localhost:3000/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' -d '{"item":"book"}'
```

The second answer is the first one again, same `201` and same order id, with `Idempotency-Replayed: true`; the handler ran once. The same key with `{"item":"lamp"}` is `422 fingerprint-mismatch`, and a duplicate that arrives while the first is still running is `409 conflict` with `Retry-After`. Every error is an RFC 9457 problem, listed in [docs/problems.md](docs/problems.md). The memory store is for one process; swap in a shared [store](#stores) for anything else.

## Install

```sh
bun add @anyonce/core                      # engine, MemoryStore, and @anyonce/core/http (withIdempotency)
bun add @anyonce/hono hono                 # Hono middleware
bun add @anyonce/anyq @anyq/core           # anyq consumer middleware and its strategy, plus an @anyq adapter
bun add @anyonce/webhooks                  # Standard Webhooks receiver
bun add @anyonce/stores                    # /durable-objects /d1 /dynamodb /redis /postgres
bun add -d @anyonce/conformance            # conformance runner and CLI
go get github.com/sns45/anyonce/go         # every Go package below
```

npm, pnpm and yarn work the same way. `@anyonce/core`, `@anyonce/hono` and `@anyonce/webhooks` have no runtime dependencies; frameworks and store clients are peer dependencies.

## The three doors

### HTTP: `Idempotency-Key`

`withIdempotency` from `@anyonce/core/http` wraps any fetch-shaped handler (Workers, `Bun.serve`, `Deno.serve`, a Lambda function URL behind a small adapter); extra arguments such as `env` and `ctx` pass through. `@anyonce/hono` is the same layer bound to Hono's middleware and context.

```ts
import { withIdempotency } from '@anyonce/core/http';
import { DynamoDbStore } from '@anyonce/stores/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const store = new DynamoDbStore({ client: new DynamoDBClient({}), tableName: 'anyonce_records' });

export const fetch = withIdempotency(routes, { store, required: true, maxResultBytes: 300 * 1024 });
```

In Go, `httpmw` wraps any `http.Handler`:

```go
mw := httpmw.New(postgres.New(db), httpmw.Options{Required: true})
log.Fatal(http.ListenAndServe(":8080", mw.Handler(routes())))
```

By default the layer applies to `POST` and `PATCH`, scopes a key to the method and route, fingerprints the method, path and body, stores responses below 500 and lets a 5xx or a thrown error release the key so the client can retry. The model, including leases and fencing, is in [docs/semantics.md](docs/semantics.md).

### Queue consumers: anyq

The queue door is two pieces, and both are required: `idempotent(handler)` wraps the anyq handler, and `idempotencyStrategy()` goes on the consumer. anyq reaches its park and dead-letter primitives only through a strategy decision, so the wrapped handler reports an in-flight duplicate or a payload mismatch as a typed error and the strategy turns it into a park for the rest of the lease or a dead letter with reason `fingerprint-mismatch`; every other error goes to the inner strategy (anyq's `retryThenDeadLetter()` by default). Without the strategy those errors fall through to anyq's plain retry path.

```ts
import { idempotencyStrategy, idempotent } from '@anyonce/anyq';
import { MemoryStore } from '@anyonce/core';
import { MemoryConsumer } from '@anyq/memory';

const consumer = new MemoryConsumer<Order>({
  driver: 'memory',
  queueName: 'orders',
  strategy: idempotencyStrategy(), // required: parks in-flight duplicates, dead-letters mismatches
});
await consumer.connect();
await consumer.subscribe(
  idempotent(
    async (message) => {
      // Runs once per idempotency-key header.
    },
    { store: new MemoryStore(), key: 'header' },
  ),
);
```

The Go pair is `anyqmw.Wrap` and `anyqmw.Strategy`:

```go
consumer := memory.NewConsumer(memory.Config{
	BaseQueueConfig: core.BaseQueueConfig{
		Driver:   core.DriverMemory,
		Strategy: anyqmw.Strategy(nil), // required, nil delegates to core.RetryThenDeadLetter
	},
	QueueName: "orders",
})
handler := anyqmw.Wrap(func(ctx context.Context, msg core.Message) error {
	return nil // runs once per idempotency-key header
}, anyqmw.Options{Store: memstore.New(), Key: anyqmw.KeySourceHeader})
```

A producer-supplied `idempotency-key` header is the recommended default for any broker whose message id changes on redelivery or on producer retry, because a producer retry publishes a second message with a second id that no consumer-side id can dedupe. The examples key on that header (`key: 'header'`, `anyqmw.KeySourceHeader`) for a second reason: an anyq park re-enqueues the message under a fresh id on some adapters. Which key source is stable on each of anyq's adapters, across redelivery, producer retry and park, is in [docs/queue-ids.md](docs/queue-ids.md).

### Webhook receivers: `webhook-id`

`webhookReceiver` verifies the Standard Webhooks signature first and only then claims the `webhook-id`, so an unsigned or forged delivery is `401` and never touches the store. A sender's retry gets the first answer back.

```ts
import { MemoryStore } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '@anyonce/webhooks';

const receive = webhookReceiver({
  store: new MemoryStore(),
  verify: standardWebhooksVerify(process.env.WEBHOOK_SECRET ?? ''),
});

export const fetch = receive(async (req) => {
  const event = (await req.json()) as { type: string };
  return Response.json({ received: true });
});
```

In Go, `standardwebhooks` does the verification and `webhookmw` the deduplication:

```go
verifier, err := standardwebhooks.New(os.Getenv("WEBHOOK_SECRET"))
if err != nil {
	log.Fatal(err)
}
mw := webhookmw.New(store, webhookmw.Options{Verify: verifier.VerifyFunc()})
http.Handle("/webhooks", mw.Handler(events))
```

Key entropy, scoping by principal, log redaction and what a stored body can leak are covered in [docs/security.md](docs/security.md).

## Stores

Every store claims a key with one atomic operation (no read-then-lock window) and passes the same contract suite, including a race of 50 concurrent claims of which exactly one wins.

| Store | TypeScript | Go | Atomic claim |
|---|---|---|---|
| memory | `MemoryStore` (`@anyonce/core`) | `store/memory` | mutex or single event loop |
| Durable Objects | `@anyonce/stores/durable-objects` | | single writer per object |
| D1 | `@anyonce/stores/d1` | | one conditional `INSERT ... ON CONFLICT` |
| DynamoDB | `@anyonce/stores/dynamodb` | `store/dynamodb` | one conditional `UpdateItem` |
| Redis | `@anyonce/stores/redis` | `store/redis` | one Lua script per transition |
| Postgres | `@anyonce/stores/postgres` | `store/postgres` | one conditional `INSERT ... ON CONFLICT` |
| SQLite | | `store/sqlite` | one connection, one statement |

Consistency, native TTL, setup, cost and the stored body cap per store are in the full matrix in [docs/stores.md](docs/stores.md), with the reason there is no Cloudflare KV store.

## Conformance

The conformance suite is a set of executable JSON vectors for `draft-ietf-httpapi-idempotency-key-header`, split into a `core` tier (what the draft requires) and a `profile` tier (anyonce's own choices, such as the replay header and not storing 5xx). The runners only speak HTTP, so they grade any implementation in any language:

```sh
bunx @anyonce/conformance --url http://localhost:3000 --tier core
```

The badge above states anyonce's own result: every anyonce target, six TypeScript stores and five Go stores, passes every `core` and every `profile` vector. Its text is checked by a test against the committed runs in [conformance/results/](conformance/results/), so it cannot drift from the [cross-implementation report](conformance/REPORT.md), which also grades hono-idempotency, idempo and Fiber on the `core` tier. How to run the suite, read the report and add a vector is in [docs/conformance.md](docs/conformance.md); where the draft is silent or ambiguous is in [conformance/DRAFT-GAPS.md](conformance/DRAFT-GAPS.md).

## Benchmarks

<!-- bench:start -->
Numbers are written by bun run bench.
<!-- bench:end -->

## Go

The Go module is `github.com/sns45/anyonce/go` (Go 1.26 or later, no cgo). The core package depends only on the standard library; the store packages bring their own client, and `anyqmw` brings `github.com/sns45/anyq/go`.

| Package | What it is |
|---|---|
| `anyonce` | engine, `Store` interface, keys, fingerprints, sentinel errors (`ErrConflict`, `ErrMismatch`, `ErrStaleFence`, `ErrStoreUnavailable`) |
| `httpmw` | `func(http.Handler) http.Handler` for the HTTP door |
| `anyqmw` | `Wrap` and `Strategy` for anyq consumers |
| `webhookmw` | webhook receiver middleware |
| `standardwebhooks` | Standard Webhooks signature verification |
| `store/memory`, `store/dynamodb`, `store/redis`, `store/postgres`, `store/sqlite` | stores |
| `storetest` | the store contract suite, for a store of your own |
| `conformance` | the Go conformance runner (CLI in `go/cmd/conformance`) |

## Examples

Each example has a README and a smoke test that runs in CI.

| Example | Door | Store |
|---|---|---|
| [worker-hono-do](examples/worker-hono-do) | HTTP, Cloudflare Worker with Hono | Durable Objects |
| [lambda-fetch-dynamodb](examples/lambda-fetch-dynamodb) | HTTP, AWS Lambda function URL with `withIdempotency` | DynamoDB |
| [go-net-http-postgres](examples/go-net-http-postgres) | HTTP, Go `net/http` with `httpmw` | Postgres |
| [anyq-consumer-ts](examples/anyq-consumer-ts) | queue, anyq consumer in TypeScript | memory |
| [anyq-consumer-go](examples/anyq-consumer-go) | queue, anyq consumer in Go | memory |
| [webhook-receiver-standard-webhooks](examples/webhook-receiver-standard-webhooks) | webhook, Standard Webhooks receiver | memory |

## Docs

- [docs/semantics.md](docs/semantics.md): the state machine, leases and fences, and what anyonce does and does not guarantee.
- [docs/stores.md](docs/stores.md): the store guarantees matrix, atomicity per store, migrations, and why not KV.
- [docs/queue-ids.md](docs/queue-ids.md): message id stability per anyq adapter, and which key source to use.
- [docs/problems.md](docs/problems.md): every problem type with its code and status.
- [docs/conformance.md](docs/conformance.md): running the suite against anything, reading the report, adding a vector.
- [docs/security.md](docs/security.md): key entropy, scope and principal, log redaction, stored bodies.
- [conformance/README.md](conformance/README.md): the vector format and the fixture routes.
- [requirements.md](requirements.md): the design.
- [llms.txt](llms.txt): packages and semantics in one page for language models.

The case study, [in8.sh/anyonce](https://in8.sh/anyonce), is published at launch.

## Licence

[Apache-2.0](LICENSE).
