# @anyonce/stores

## 0.1.0

### Minor Changes

- 4e45b23: P3 final review fixes. `@anyonce/core`: `Store` gains the optional `maxResultBytes`, the largest body a backend stores whole (Q20), and `resolveHttpOptions` caps the policy's `maxResultBytes` at it, so a result too large for the store is stored in the omitted form rather than refused by the store. `@anyonce/stores`: the DynamoDB item key is now the single partition key `pk`, the scope and the key joined by the unit separator, with no sort key (Q22), and the store exports `itemKey` plus the four condition and update expressions the parity test compares against the Go ones; `DynamoDbStore` declares its 300 KiB cap. `DurableObjectsStoreOptions` gains `trackForPurge` (default false): Worker-side `purge` reaches only the objects a tracking store has addressed, and returns 0 without it. `PostgresQuery` results carry `rowCount`, so `purge` counts affected rows instead of returning one row per expired record; `fromNeon` now requires `neon(url, { fullResults: true })`. The package also exports `./migrations/*`.
- 4e45b23: D1 store for @anyonce/stores (`@anyonce/stores/d1`): `D1Store`, `D1StoreOptions`, `ensureSchema` and `MIGRATION_SQL`, sharing the SQLite dialect begin statement with the Durable Objects store. The runtime entry of `@anyonce/conformance` gains `runConformance` for callers, such as workerd tests, that supply `vectors` explicitly instead of loading them from disk.
- 4e45b23: Durable Objects store for `@anyonce/stores` (`@anyonce/stores/durable-objects`): `IdempotencyObject`, `DurableObjectsStore` and `DurableObjectsStoreOptions`. The object is the single writer for its shard, so each transition is one synchronous SQLite statement on the object's own storage, sharing the SQLite dialect statements with the D1 store. `shard` selects one object per scope (default) or per scope and key; an `expires_wall` side table plus the object alarm sweeps expired rows on the wall clock, `nativeTtlGraceMs` (default 60000) after the logical expiry, so an injected clock never removes a live row.
- 4e45b23: DynamoDB store for @anyonce/stores (`@anyonce/stores/dynamodb`): `DynamoDbStore`, `DynamoDbStoreOptions`, `ensureTable` and `DYNAMODB_MAX_RESULT_BYTES`. The contract suite gains a `nativePurge` option for backends that expire rows themselves, where `purge` returns 0.
- 4e45b23: Postgres store: PostgresStore over a minimal query adapter (pg directly, fromPostgresJs, fromNeon), ensureSchema and the migration file; the shared begin statement binds precomputed lease and expiry values.
- 4e45b23: Redis store for @anyonce/stores (`@anyonce/stores/redis`): `RedisStore`, `RedisStoreOptions`, `RedisAdapter`, the `fromIoredis`, `fromNodeRedis` and `fromUpstash` client adapters, and the `BEGIN_LUA`, `COMPLETE_LUA` and `ABANDON_LUA` scripts. Every transition is a single Lua script run with EVALSHA and an EVAL fallback on NOSCRIPT, with the sha cached per store. Bodies are stored base64 so the Upstash REST client stays binary safe, which adds `bytesToBase64` and `base64ToBytes` to the package root.
- 4e45b23: Stores: DynamoDB, Redis, Postgres, D1 and Durable Objects for @anyonce/stores. `@anyonce/core/testing` gains two public options on the shared contract suite: `StoreHarness.maxResultBytes` and `StoreSuiteOptions.maxResultBytes` for the backend result cap (Q20), and `StoreSuiteOptions.nativePurge` for a backend that sweeps expired rows itself (Q21).

### Patch Changes

- bc7f476: Peers on `@anyonce/core` use a caret range. Every package declares its `repository` (this repository and its own directory) and ships the Apache-2.0 LICENSE in its tarball.
- 4ca1f2b: Each package ships a README.
- Updated dependencies [696d9d1]
- Updated dependencies [0c3fa90]
- Updated dependencies [4e45b23]
- Updated dependencies [4e45b23]
- Updated dependencies [4e45b23]
- Updated dependencies [a504191]
- Updated dependencies [bc7f476]
- Updated dependencies [4ca1f2b]
  - @anyonce/core@0.1.0
