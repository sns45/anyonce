# Stores

Every store implements the same `Store` contract (requirements 4.2) and passes the same suite (`@anyonce/core/testing`, `go/storetest`). `begin` is one atomic operation everywhere; the mechanism differs per backend and is named below. Logical expiry is always the caller's clock against `expires_at`; native TTL, where the backend has one, is a safety net scheduled after logical expiry. A backend that sweeps expired rows itself returns 0 from `purge`, and its store test says so (the `nativePurge` suite option in TypeScript, `Harness.NativePurge` in Go) so the suite asserts that instead of a removed count, while still requiring logical expiry on read.

| Store | Languages | Consistency | Atomicity of begin | Native TTL | Setup | Cost note | Max stored body |
|---|---|---|---|---|---|---|---|
| memory | TS, Go | single process | mutex or single event loop | no, purge | none | free | 1 MiB |
| dynamodb | TS, Go | strongly consistent reads (ConsistentRead) | one conditional UpdateItem; refusal returns the old item | yes, ttl attribute (seconds, expires_at plus 60 s grace) | ensureTable(client) in TS, EnsureTable(ctx, client, table) in Go, or create pk (S) and sk (S) with TTL on ttl | one write per request, one more per replay read; items capped at 400 KB so maxResultBytes must be at most 300 KiB (Q20) | 300 KiB |
| redis | TS, Go | single node or cluster (every script takes one key) | one Lua script per transition (EVALSHA, EVAL fallback) | yes, PEXPIRE at ttl plus 60 s grace | any Redis 7; adapters for ioredis, node-redis and Upstash REST | one round trip per transition; bodies stored base64 so the REST client stays binary safe | 1 MiB |
| postgres | TS, Go | serializable enough: one statement per transition | INSERT ON CONFLICT DO UPDATE WHERE, refusal classified by one SELECT | no, purge(now) with the expires_at index | migrations/postgres/0001_anyonce.sql or ensureSchema(query) | one statement per transition, two on a refused claim; run purge on a schedule | 1 MiB |
| d1 | TS | strongly consistent within the database | INSERT ON CONFLICT DO UPDATE WHERE, refusal classified by one SELECT | no, purge(now) with the expires_at index (a cron trigger is the usual scheduler) | migrations/d1/0001_anyonce.sql via wrangler d1 migrations, or ensureSchema(db) | one statement per transition; rows up to 2 MB | 1 MiB |
| durable-objects | TS | strongly consistent per object | single writer per object, one SQLite statement per transition | alarm sweep by wall clock (expires_at plus 60 s grace) | bind IdempotencyObject with new_sqlite_classes; DurableObjectsStore({ namespace }) | one RPC per transition; per scope sharding serializes a scope's requests, per scope and key sharding spreads them | 1 MiB (2 MB row limit) |
| sqlite | Go | single process, WAL | one connection (SetMaxOpenConns 1), one statement per transition | no, purge(now) with the expires_at index | Open(ctx, path), then EnsureSchema(ctx) applies schema.sql; modernc.org/sqlite, no cgo | one statement per transition; single writer by construction | 1 MiB |

`DurableObjectsStore.purge(now)` from a Worker reaches only the objects that store instance has already touched, because a Worker cannot enumerate a namespace; the object's own alarm is the real sweep and it runs whether or not anyone calls `purge`.

## Choosing

On Workers, pick Durable Objects when one scope's requests may serialize through a single writer and you want the object to sweep itself, and D1 when the scope is hot enough that a single object would be a bottleneck or a SQL database is already in the stack. On AWS, use DynamoDB: one conditional write per transition, no server to run, native TTL. Anywhere Redis is already deployed, use Redis: one Lua script per transition and one round trip. With a relational database already in the stack, use Postgres. For a single binary with no service to run, use SQLite in Go. The memory store is for tests and single-process development only; it holds nothing across a restart and shares nothing between processes.

## Purge scheduling

DynamoDB and Redis need no scheduling: the backend expires rows itself, and `purge(now)` returns 0 (Q21). Durable Objects sweep themselves through the object alarm; a Worker-side `purge` call is optional and partial, as noted above. Postgres, D1 and SQLite have no native expiry, so `purge(now)` has to run on a schedule against the `expires_at` index: for D1 a Worker cron trigger, for Postgres and SQLite a cron job or the application's own scheduler. Nothing breaks without it, because logical expiry is enforced on read, but the table grows.

## Migrations

- Postgres: [`packages/stores/migrations/postgres/0001_anyonce.sql`](../packages/stores/migrations/postgres/0001_anyonce.sql), or call `ensureSchema(query)`. The Go store applies the same statements from [`go/store/postgres/schema.sql`](../go/store/postgres/schema.sql) through `EnsureSchema`.
- D1: [`packages/stores/migrations/d1/0001_anyonce.sql`](../packages/stores/migrations/d1/0001_anyonce.sql), applied with `wrangler d1 migrations apply`, or call `ensureSchema(db)`. Durable Objects create the same table plus their sweep table on first use.
- SQLite (Go): [`go/store/sqlite/schema.sql`](../go/store/sqlite/schema.sql), applied by `EnsureSchema(ctx)`.

A parity test (`packages/stores/test/parity.test.ts`) keeps the Go schema files byte equal to the TypeScript ones and the Go Lua scripts byte equal to the TypeScript scripts, so a change to one language cannot drift from the other.

## Cloudflare KV is not a store (REQ-ST-KV-1)

KV is eventually consistent across edge locations: two Workers in different colos can both read "absent" and both write a claim, so the REQ-STORE-8 race (50 concurrent begins, exactly one acquired) cannot be met. Use the Durable Objects store (one object per scope, single-writer) or the D1 store (one conditional statement) instead. Both run on Workers with no extra service.
