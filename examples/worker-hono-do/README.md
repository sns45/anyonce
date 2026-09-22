# worker-hono-do

A Cloudflare Worker built with Hono. Every `POST` runs behind the `@anyonce/hono` middleware, and the
idempotency records live in a Durable Object (`@anyonce/stores/durable-objects`), so a retried request with
the same `Idempotency-Key` gets the stored response instead of creating a second order.

## What it shows

- `idempotency({ store, required: true })` mounted on the whole app; `GET` requests pass through untouched.
- `new DurableObjectsStore({ namespace: env.IDEMPOTENCY })` as the store, one object per scope.
- `export { IdempotencyObject }` from the Worker entry, and the binding plus SQLite migration in
  [`wrangler.jsonc`](./wrangler.jsonc).

```ts
import type { Store } from '@anyonce/core';
import { idempotency } from '@anyonce/hono';
import { DurableObjectsStore, IdempotencyObject } from '@anyonce/stores/durable-objects';
import { Hono } from 'hono';

export { IdempotencyObject };

export function createApp(deps: { store: Store }) {
  const app = new Hono();
  app.use(idempotency({ store: deps.store, required: true }));
  app.post('/orders', async (c) => {
    const { item } = await c.req.json<{ item: string }>();
    return c.json({ id: crypto.randomUUID(), item }, 201);
  });
  return app.fetch;
}

export default {
  fetch: (req: Request, env: Env) =>
    createApp({ store: new DurableObjectsStore({ namespace: env.IDEMPOTENCY }) })(req),
};
```

The full source is [`src/index.ts`](./src/index.ts); it builds the app once per isolate.

## Run it locally

No compose service is needed: `wrangler dev` runs the Durable Object locally in workerd. From the
repository root:

```sh
bun install
bun run build
cd examples/worker-hono-do
bunx wrangler dev
```

## Try it

POST the same order twice with one key:

```sh
curl -i -X POST http://localhost:8787/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' \
  -d '{"item":"book"}'
curl -i -X POST http://localhost:8787/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' \
  -d '{"item":"book"}'
```

The first response is `201` with a fresh order id. The second is the same `201` with the same id and
`Idempotency-Replayed: true`: the handler did not run again. Send the same key with a different body
(`{"item":"lamp"}`) and the answer is `422` with the `fingerprint-mismatch` problem. A `POST` with no key
is `400 missing-key`.

## Smoke test

[`test/smoke.test.ts`](./test/smoke.test.ts) runs in workerd under
[`vitest.config.ts`](./vitest.config.ts) (`@cloudflare/vitest-pool-workers`). It drives the Worker entry
through the scenario above, then runs the conformance suite's core and profile tiers against the fixture
routes behind the same middleware configuration and the Durable Objects store. From the repository root:

```sh
bun run test:examples:workers
```
