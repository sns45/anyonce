# @anyonce/stores

Atomic idempotency stores for anyonce: Durable Objects, D1, DynamoDB, Redis and Postgres, each claiming a
key with one atomic operation and passing the same store contract suite as `MemoryStore`.

## Install

```sh
bun add @anyonce/stores @anyonce/core
npm i @anyonce/stores @anyonce/core
```

Peer dependency: `@anyonce/core`. Each store also has a peer dependency on its own client, installed only
when you use that store: `@aws-sdk/client-dynamodb`, `@cloudflare/workers-types`, `ioredis`, `redis`,
`@upstash/redis`, `pg` or `postgres`.

## Usage

Each store is a subpath export; import only the one you need.

```ts
import { withIdempotency } from '@anyonce/core/http';
import { DynamoDbStore } from '@anyonce/stores/dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const store = new DynamoDbStore({ client: new DynamoDBClient({}), tableName: 'anyonce_records' });

export const fetch = withIdempotency(routes, { store, required: true, maxResultBytes: 300 * 1024 });
```

## Subpaths

| Subpath | Backend | Atomic claim |
|---|---|---|
| `@anyonce/stores/durable-objects` | Cloudflare Durable Objects | single writer per object |
| `@anyonce/stores/d1` | Cloudflare D1 | one conditional `INSERT ... ON CONFLICT` |
| `@anyonce/stores/dynamodb` | DynamoDB | one conditional `UpdateItem` |
| `@anyonce/stores/redis` | Redis | one Lua script per transition |
| `@anyonce/stores/postgres` | Postgres | one conditional `INSERT ... ON CONFLICT` |

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/stores.md](https://github.com/sns45/anyonce/blob/main/docs/stores.md): the full guarantees matrix, migrations, and why not Cloudflare KV.
- [docs/semantics.md](https://github.com/sns45/anyonce/blob/main/docs/semantics.md): the state machine, leases and fences.

## Licence

Apache-2.0
