# @anyonce/core

The idempotency engine for anyonce, independent of transport: the state machine, key parsing and
validation, fingerprinting, `MemoryStore`, the shared HTTP door (`@anyonce/core/http`), and the store
contract suite (`@anyonce/core/testing`) that every anyonce store passes.

## Install

```sh
bun add @anyonce/core
npm i @anyonce/core
```

No runtime dependencies. `@anyonce/hono`, `@anyonce/webhooks`, `@anyonce/anyq` and `@anyonce/stores` all
build on this package and name it as a peer dependency.

## Usage

`withIdempotency` wraps any handler that takes a `Request` and returns a `Response` (Workers,
`Bun.serve`, `Deno.serve`, or a Lambda function URL behind a small adapter).

```ts
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';

const store = new MemoryStore();

export const fetch = withIdempotency(routes, { store, required: true });
```

A retried `POST` under the same `Idempotency-Key` header gets the stored response back, with
`Idempotency-Replayed: true`; the handler ran once. The same key with a changed body is `422
fingerprint-mismatch`. `MemoryStore` is for one process; swap in a shared store from `@anyonce/stores`
for anything else.

## Subpaths

- `@anyonce/core` (root): the engine, key and fingerprint helpers, `MemoryStore`.
- `@anyonce/core/http`: `withIdempotency`, RFC 9457 problem responses, request scoping and capture.
- `@anyonce/core/testing`: `storeContractSuite`, the shared test suite for a store of your own.

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/semantics.md](https://github.com/sns45/anyonce/blob/main/docs/semantics.md): the state machine, leases and fences.
- [docs/stores.md](https://github.com/sns45/anyonce/blob/main/docs/stores.md): the store guarantees matrix.

## Licence

Apache-2.0
