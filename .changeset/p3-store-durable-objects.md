---
"@anyonce/stores": minor
---

Durable Objects store for `@anyonce/stores` (`@anyonce/stores/durable-objects`): `IdempotencyObject`, `DurableObjectsStore` and `DurableObjectsStoreOptions`. The object is the single writer for its shard, so each transition is one synchronous SQLite statement on the object's own storage, sharing the SQLite dialect statements with the D1 store. `shard` selects one object per scope (default) or per scope and key; an `expires_wall` side table plus the object alarm sweeps expired rows on the wall clock, `nativeTtlGraceMs` (default 60000) after the logical expiry, so an injected clock never removes a live row.
