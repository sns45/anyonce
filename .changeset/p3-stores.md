---
"@anyonce/stores": minor
"@anyonce/core": minor
---

Stores: DynamoDB, Redis, Postgres, D1 and Durable Objects for @anyonce/stores. `@anyonce/core/testing` gains two public options on the shared contract suite: `StoreHarness.maxResultBytes` and `StoreSuiteOptions.maxResultBytes` for the backend result cap (Q20), and `StoreSuiteOptions.nativePurge` for a backend that sweeps expired rows itself (Q21).
