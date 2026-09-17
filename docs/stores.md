# Stores

Every store implements the same `Store` contract (requirements 4.2) and passes the same suite (`@anyonce/core/testing`, `go/storetest`). `begin` is one atomic operation everywhere; the mechanism differs per backend and is named below. Logical expiry is always the caller's clock against `expires_at`; native TTL, where the backend has one, is a safety net scheduled after logical expiry.

| Store | Languages | Consistency | Atomicity of begin | Native TTL | Setup | Cost note | Max stored body |
|---|---|---|---|---|---|---|---|
| memory | TS, Go | single process | mutex or single event loop | no, purge | none | free | 1 MiB |
| dynamodb | TS, Go | strongly consistent reads (ConsistentRead) | one conditional UpdateItem; refusal returns the old item | yes, ttl attribute (seconds, expires_at plus 60 s grace) | ensureTable(client) or create pk (S) and sk (S) with TTL on ttl | one write per request, one more per replay read; items capped at 400 KB so maxResultBytes must be at most 300 KiB (Q20) | 300 KiB |
| redis | TS, Go | single node or cluster with hash tags | one Lua script per transition (EVALSHA, EVAL fallback) | yes, PEXPIRE at ttl plus 60 s grace | any Redis 7; adapters for ioredis, node-redis and Upstash REST | one round trip per transition; bodies stored base64 so the REST client stays binary safe | 1 MiB |
| postgres | TS, Go | serializable enough: one statement per transition | INSERT ON CONFLICT DO UPDATE WHERE, refusal classified by one SELECT | no, purge(now) with the expires_at index | migrations/postgres/0001_anyonce.sql or ensureSchema(query) | one statement per transition, two on a refused claim; run purge on a schedule | 1 MiB |

Rows for D1, Durable Objects and SQLite are added by their store PRs.

## Cloudflare KV is not a store (REQ-ST-KV-1)

KV is eventually consistent across edge locations: two Workers in different colos can both read "absent" and both write a claim, so the REQ-STORE-8 race (50 concurrent begins, exactly one acquired) cannot be met. Use the Durable Objects store (one object per scope, single-writer) or the D1 store (one conditional statement) instead. Both run on Workers with no extra service.
