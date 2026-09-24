# @anyonce/anyq

anyq consumer middleware for anyonce idempotency: `idempotent(handler)` wraps an
[anyq](https://github.com/sns45/anyq) handler so it runs at most once per key, and
`idempotencyStrategy()` is the companion strategy anyq needs to turn a duplicate into a park or a dead
letter instead of a plain retry.

## Install

```sh
bun add @anyonce/anyq @anyonce/core @anyq/core
npm i @anyonce/anyq @anyonce/core @anyq/core
```

Peer dependencies: `@anyonce/core` and `@anyq/core` (`>=0.5.0 <1`).

## Usage

Both pieces are required: `strategy: idempotencyStrategy()` on the consumer, and `idempotent(handler)`
around the subscribed handler. anyq reaches its park and dead letter primitives only through a strategy
decision, so without it a duplicate falls through to anyq's plain retry path instead.

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

Producers should set an `idempotency-key` header on every message, and the consumer should key on it
(`key: 'header'`, as above). This is the recommended default for any broker whose message id changes on
redelivery or on a producer retry, because a producer retry publishes a second message with a second id,
and no id the consumer computes on its own can dedupe it.

```ts
await producer.publish(order, { headers: { 'idempotency-key': 'order-o-1' } });
```

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/queue-ids.md](https://github.com/sns45/anyonce/blob/main/docs/queue-ids.md): message id stability per anyq adapter, and which key source to use.
- [docs/stores.md](https://github.com/sns45/anyonce/blob/main/docs/stores.md): the store guarantees matrix.

## Licence

Apache-2.0
