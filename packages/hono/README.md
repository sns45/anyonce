# @anyonce/hono

Hono middleware for anyonce: binds the `@anyonce/core/http` idempotency door to Hono's context and
routing, scoping each key to the method and the matched route pattern.

## Install

```sh
bun add @anyonce/hono @anyonce/core hono
npm i @anyonce/hono @anyonce/core hono
```

Peer dependencies: `@anyonce/core` and `hono` (`>=4.8.0`).

## Usage

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

Send the same order twice under one `Idempotency-Key`: the second answer is the first one again, same
`201` and same order id, with `Idempotency-Replayed: true`; the handler ran once. The same key with a
changed body is `422 fingerprint-mismatch`. `MemoryStore` is for one process; swap in a shared store from
`@anyonce/stores` for anything else.

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/semantics.md](https://github.com/sns45/anyonce/blob/main/docs/semantics.md): the state machine, leases and fences.
- [docs/stores.md](https://github.com/sns45/anyonce/blob/main/docs/stores.md): the store guarantees matrix.

## Licence

Apache-2.0
