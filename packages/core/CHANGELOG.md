# @anyonce/core

## 0.1.0

### Minor Changes

- 696d9d1: Initial core: store types, key and sf-string parsing, RFC 8785 canonicalization, SHA-256 fingerprints, newKey, the memory store, the execute engine, and the store contract suite at @anyonce/core/testing.
- 0c3fa90: HTTP door: the @anyonce/core/http subpath with withIdempotency, problem details, streaming capture and replay; the @anyonce/hono middleware; conformance report formats, runConformance and the anyonce-conformance CLI.
- 4e45b23: P3 final review fixes. `@anyonce/core`: `Store` gains the optional `maxResultBytes`, the largest body a backend stores whole (Q20), and `resolveHttpOptions` caps the policy's `maxResultBytes` at it, so a result too large for the store is stored in the omitted form rather than refused by the store. `@anyonce/stores`: the DynamoDB item key is now the single partition key `pk`, the scope and the key joined by the unit separator, with no sort key (Q22), and the store exports `itemKey` plus the four condition and update expressions the parity test compares against the Go ones; `DynamoDbStore` declares its 300 KiB cap. `DurableObjectsStoreOptions` gains `trackForPurge` (default false): Worker-side `purge` reaches only the objects a tracking store has addressed, and returns 0 without it. `PostgresQuery` results carry `rowCount`, so `purge` counts affected rows instead of returning one row per expired record; `fromNeon` now requires `neon(url, { fullResults: true })`. The package also exports `./migrations/*`.
- 4e45b23: DynamoDB store for @anyonce/stores (`@anyonce/stores/dynamodb`): `DynamoDbStore`, `DynamoDbStoreOptions`, `ensureTable` and `DYNAMODB_MAX_RESULT_BYTES`. The contract suite gains a `nativePurge` option for backends that expire rows themselves, where `purge` returns 0.
- 4e45b23: Stores: DynamoDB, Redis, Postgres, D1 and Durable Objects for @anyonce/stores. `@anyonce/core/testing` gains two public options on the shared contract suite: `StoreHarness.maxResultBytes` and `StoreSuiteOptions.maxResultBytes` for the backend result cap (Q20), and `StoreSuiteOptions.nativePurge` for a backend that sweeps expired rows itself (Q21).
- a504191: Add the webhook door. `@anyonce/webhooks` ships `webhookReceiver`, which runs strictly after signature
  verification, keys on the Standard Webhooks `webhook-id` header or a body derived id, replays a stored response
  with `Idempotency-Replayed: true`, answers 409 with `Retry-After` while a delivery is in flight and 422 with an
  `onSuspicious` hook when the same id arrives with a different body, plus `standardWebhooksVerify(secret)`.
  `@anyonce/core/http` gains two problem codes, `configuration-error` and `signature-invalid`, per code title
  overrides, and two optional `RunContext` fields so a door can supply the key and the body it already read.
  `webhookReceiver` takes `scope?: (req, body) => string`, which replaces the computed scope entirely; supplying
  it together with `sourceId` is a construction-time `TypeError`, as an empty `verifiedMarker` is. A 401
  `signature-invalid` response carries `WWW-Authenticate: Signature` (RFC 9110 section 15.5.2). `@anyonce/core/http`
  also exports `withProtocolHeaders`, the merge that keeps a door's protocol headers on a custom `onError`
  response.

### Patch Changes

- bc7f476: Peers on `@anyonce/core` use a caret range. Every package declares its `repository` (this repository and its own directory) and ships the Apache-2.0 LICENSE in its tarball.
- 4ca1f2b: Each package ships a README.
