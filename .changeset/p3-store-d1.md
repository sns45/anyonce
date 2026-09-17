---
"@anyonce/stores": minor
"@anyonce/conformance": minor
---

D1 store for @anyonce/stores (`@anyonce/stores/d1`): `D1Store`, `D1StoreOptions`, `ensureSchema` and `MIGRATION_SQL`, sharing the SQLite dialect begin statement with the Durable Objects store. The runtime entry of `@anyonce/conformance` gains `runConformance` for callers, such as workerd tests, that supply `vectors` explicitly instead of loading them from disk.
