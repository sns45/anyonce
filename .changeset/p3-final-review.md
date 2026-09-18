---
"@anyonce/stores": minor
"@anyonce/core": minor
---

P3 final review fixes. `@anyonce/core`: `Store` gains the optional `maxResultBytes`, the largest body a backend stores whole (Q20), and `resolveHttpOptions` caps the policy's `maxResultBytes` at it, so a result too large for the store is stored in the omitted form rather than refused by the store. `@anyonce/stores`: the DynamoDB item key is now the single partition key `pk`, the scope and the key joined by the unit separator, with no sort key (Q22), and the store exports `itemKey` plus the four condition and update expressions the parity test compares against the Go ones; `DynamoDbStore` declares its 300 KiB cap. `DurableObjectsStoreOptions` gains `trackForPurge` (default false): Worker-side `purge` reaches only the objects a tracking store has addressed, and returns 0 without it. `PostgresQuery` results carry `rowCount`, so `purge` counts affected rows instead of returning one row per expired record; `fromNeon` now requires `neon(url, { fullResults: true })`. The package also exports `./migrations/*`.
