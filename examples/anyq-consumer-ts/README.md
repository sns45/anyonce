# anyq-consumer-ts

An [anyq](https://www.npmjs.com/package/@anyq/core) consumer whose handler runs at most once per order. Two
pieces are wired together and both are required: `idempotent(handler, { store, key: 'header' })` from
`@anyonce/anyq` wraps the handler, and `strategy: idempotencyStrategy()` goes on the consumer. The strategy is
not optional, because anyq reaches its park and dead-letter primitives only through a strategy decision: the
wrapped handler reports an in-flight duplicate or a payload mismatch as a typed error, and without the strategy
that error falls through to anyq's plain retry path instead of parking for the rest of the lease or going to
the dead-letter queue. The key source is `'header'` because an anyq park re-enqueues the message with a fresh
message id on this adapter, so the id would not follow the parked copy (see
[docs/queue-ids.md](../../docs/queue-ids.md)). Producers should set an `idempotency-key` header on every
message: it is the recommended default for any broker whose message id changes on redelivery or on a producer
retry, and a producer retry always publishes a second message with a second id.

## What it shows

- [`src/consumer.ts`](./src/consumer.ts): `createConsumer({ queueName, store })` builds an anyq memory
  consumer with the companion strategy and subscribes the wrapped handler. The smoke test drives this same
  function.
- A completed order that arrives again (a redelivery, or a producer retry under the same `idempotency-key`)
  is acknowledged without running the handler.
- An order whose first claim is still running is parked for the lease remainder and handled once the lease
  has gone, never before.
- The memory store (`MemoryStore` from `@anyonce/core`) keeps the example self contained. A consumer group
  with more than one instance needs a shared store; see [docs/stores.md](../../docs/stores.md).

```ts
import { idempotencyStrategy, idempotent } from '@anyonce/anyq';
import { MemoryStore } from '@anyonce/core';
import { MemoryConsumer } from '@anyq/memory';

const consumer = new MemoryConsumer<Order>({
  driver: 'memory',
  queueName: 'orders',
  // Required: turns the door's typed errors into a park or a dead letter.
  strategy: idempotencyStrategy(),
});
await consumer.connect();
await consumer.subscribe(
  idempotent<Order>(
    async (message) => {
      // Runs once per idempotency-key header.
    },
    { store: new MemoryStore(), key: 'header' },
  ),
);
```

The producer side sets the header:

```ts
await producer.publish(order, { headers: { 'idempotency-key': 'order-o-1' } });
```

## Run it locally

No compose service is needed; the memory adapter is in process. From the repository root:

```sh
bun install
bun run build
cd examples/anyq-consumer-ts
bun run start
```

It publishes the same order twice under one `idempotency-key`, the way a producer retry does, and prints:

```text
handled order o-1
the second delivery replayed; the handler ran once
```

## Smoke test

[`test/smoke.test.ts`](./test/smoke.test.ts) drives `createConsumer` with a real anyq memory producer: an
order sent twice under one key runs the handler once, and an order that meets another consumer's live claim
parks (the strategy marks the in-flight error translated) and runs once, after the lease expires. Both wait on
barriers, never on a duration. From the repository root:

```sh
bun run test:examples
```

On another broker, swap `@anyq/memory` for its adapter and keep both pieces. Kafka and Redis Streams have no
native delayed redelivery, so those consumers also set `allowParkDowngrade` (see the `idempotencyStrategy`
doc comment in [`packages/anyq/src/strategy.ts`](../../packages/anyq/src/strategy.ts)), and which key source
survives a park on each broker is in [docs/queue-ids.md](../../docs/queue-ids.md).
