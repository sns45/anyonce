# Stores

Every store implements the same `Store` contract (requirements 4.2) and passes the same suite (`@anyonce/core/testing`, `go/storetest`). `begin` is one atomic operation everywhere; the mechanism differs per backend and is named below. Logical expiry is always the caller's clock against `expires_at`; native TTL, where the backend has one, is a safety net scheduled after logical expiry.

| Store | Languages | Consistency | Atomicity of begin | Native TTL | Setup | Cost note | Max stored body |
|---|---|---|---|---|---|---|---|
| memory | TS, Go | single process | mutex or single event loop | no, purge | none | free | 1 MiB |

Rows for DynamoDB, Redis, Postgres, D1, Durable Objects and SQLite are added by their store PRs.

## Cloudflare KV is not a store (REQ-ST-KV-1)

KV is eventually consistent across edge locations: two Workers in different colos can both read "absent" and both write a claim, so the REQ-STORE-8 race (50 concurrent begins, exactly one acquired) cannot be met. Use the Durable Objects store (one object per scope, single-writer) or the D1 store (one conditional statement) instead. Both run on Workers with no extra service.
