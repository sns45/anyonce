# Security notes

What an operator needs to know to deploy anyonce without turning the idempotency layer into a leak. Requirements are in [requirements.md](../requirements.md) D8, D16, NFR-2 and REQ-HTTP-5, REQ-HTTP-8, REQ-DOC-6; behavior is described in [semantics.md](semantics.md).

## Key entropy

Generate keys with `newKey()` (TypeScript, from `@anyonce/core`) or `anyonce.NewKey()` (Go). Both return a UUIDv4: 122 random bits from Web Crypto (`crypto.randomUUID()`) or `crypto/rand` (REQ-CORE-5).

An idempotency key is not a secret. It travels in a header, it shows up in client logs, and anyone who holds it may retry. It must still be unguessable across tenants, because a key is the handle a replay is served under: a request that presents the same scope, the same key and the same payload receives the stored response, whoever sends it. Within one scope, a guessable key (a counter, a timestamp, an order number) lets a third party that can reproduce the payload read another client's result, and a 422 on a guessed key with a different payload tells them that key is in use. With 122 random bits that search is infeasible. Keys a client derives from its own data should carry the same amount of randomness, or be scoped per principal as described next.

## Scope and principal

Every record is addressed by `(scope, key)`, and the core refuses to run without a scope (D8). The HTTP door's default scope is `${method} ${routePattern or path}`: in `@anyonce/hono` the matched route pattern, in `withIdempotency` and Go `httpmw` the request path, because neither sees a router. That default is shared by every caller of the route, so on a multi-tenant API two tenants who happen to use the same key on the same route share one record, and the second one receives the first one's response. This is cross-tenant replay, and preventing it is the reason scope is explicit.

Compose the tenant into the scope with the `principal` option (`Principal` in Go). It receives the request and returns the authenticated user or tenant id, which the door appends as `${scope}#${principal}` (REQ-HTTP-5). Take the principal from the verified session or token, never from a header the client chooses freely.

Set `requirePrincipal: true` (`RequirePrincipal` in Go) on any route where a missing principal must not fall back to the shared scope. Without it, a principal function that returns nothing (an unauthenticated request, a token the function could not parse) leaves the scope without the `#principal` suffix, and that request lands in the shared namespace. With it, the request is refused with 500 `missing-principal` (Q18). Setting `requirePrincipal` without a `principal` function fails at construction: `resolveHttpOptions` throws a `TypeError` and `httpmw.New` panics.

A custom `scope` function replaces the default route half; the principal is still appended after it.

### Webhook receivers on a shared endpoint

The webhook door's default scope is `${routePattern}/${sourceId}`, or the route alone when no `sourceId` is supplied (Q24). `sourceId` (`SourceID` in Go) is the verified sender identity, and anyonce cannot invent one: a Standard Webhooks secret identifies the receiving endpoint, not the sender. So a single endpoint that receives deliveries from several senders, without a `sourceId`, has one dedupe namespace for all of them. Two senders that pick the same `webhook-id` then collide: the second delivery is replayed the first one's response, or refused with 422 if the bodies differ, and its handler never runs. A multi-tenant receiver that can map a signature, a path segment or a payload field to a sender should pass it as `sourceId`, or supply a whole `scope` function. Supplying both `scope` and `sourceId` is refused at construction (a `TypeError`, a panic in Go), because `scope` replaces the computed scope and would silently drop the sender identity.

## The webhook verification gate

The webhook receiver runs strictly after signature verification (D16). A request that has not been verified never calls the store, so a forged delivery cannot plant a `webhook-id` in the dedupe table and suppress the genuine delivery that arrives later.

- A receiver built with neither a `verify` callback nor a `verifiedMarker` answers every request with 500 `configuration-error` and logs one fixed line per receiver instance (REQ-WH-2, Q26). It fails closed; it never processes an unverified delivery.
- A `verify` callback that throws (TypeScript) or returns an error (Go) is also 500 `configuration-error`: a verifier that cannot decide is broken, and treating it as a rejection would hide the fault. The thrown error is discarded, not logged, because it commonly quotes the header or key it choked on.
- A delivery that fails verification, or lacks the upstream verified marker, is 401 `signature-invalid` with `WWW-Authenticate: Signature`, which RFC 9110 section 15.5.2 requires on every 401 (Q29).
- In TypeScript, `skip` runs after the gate: it turns off deduplication for a path, never verification.

`standardWebhooksVerify(secret)` (TypeScript) and `standardwebhooks.New(secret)` with its `Verify` method or `VerifyFunc()` for `webhookmw` (Go) implement the Standard Webhooks check: HMAC-SHA256 over `${id}.${timestamp}.${body}`, `v1,` prefixed signatures, and a timestamp tolerance of 5 minutes by default, which bounds how long a captured delivery can be replayed at the signature layer (REQ-WH-6).

## Logs never carry a full key

`redactKey()` (Go `anyonce.RedactKey`) is the only form of a key that may reach a log line: the first 8 characters followed by an ellipsis (NFR-2). Nothing in anyonce logs a key at all:

- `@anyonce/core`, `@anyonce/hono` and Go `httpmw` never log.
- `@anyonce/webhooks` and Go `webhookmw` log only the two fixed configuration-error lines, once each per receiver, through an injectable sink (`logger`, Go `Logf`). The lines carry no request data, no header value and no key (Q26).
- `@anyonce/anyq` and Go `anyqmw` log one fixed warning when an in-flight duplicate was not translated by the companion strategy.
- The `detail` member of a problem response never contains the key.

Hooks receive the full `Operation`, key included, because a hook may need it for metrics or tracing. If a hook logs, it must log `redactKey(op.key)`, never `op.key`. CI enforces this for the repository itself with a gate that fails on any `console.log`, `info`, `warn` or `error` call whose arguments mention a key.

## Replay isolation

A replay sends a stored response to a different request than the one that produced it, so what is stored must be safe to send again:

- Only allowlisted response headers are stored and replayed (REQ-HTTP-8). The default allowlist is `Content-Type`, `Content-Language`, `Location`, `ETag` and `Link`; set `storeHeaders` (`StoreHeaders` in Go) to change it. An explicit empty list stores no headers.
- `Set-Cookie` is never stored, whatever the allowlist says. A replayed response therefore never re-issues a session cookie to whoever holds the key.
- In Go, the stored headers are the snapshot taken when the handler wrote the status line, so headers set after the response started do not leak into the record.
- A replay is marked `Idempotency-Replayed: true`, so clients and intermediaries can tell it apart from a fresh execution.
- Problem responses carry `Cache-Control: no-store`, including those rendered through an `onError` override.

The response body is replayed as stored. A handler whose response embeds data specific to the caller should run under a per-principal scope, so the only party a replay reaches is the one that produced it.

## Stored bodies

Stored HTTP response bodies sit in the store as plain bytes (base64 text in Redis, which is an encoding, not encryption). anyonce does not encrypt them: encryption at rest is a store concern and out of scope for v1 (requirements 1.2). Use the backend's own encryption at rest (DynamoDB and managed Postgres or Redis offerings provide it) and restrict who can read the table, bucket or keyspace, as you would for any table holding API responses.

Limit what is stored:

- `maxResultBytes` (default 1 MiB) caps the stored body. Above the cap only the status and allowlisted headers are stored and the replay has an empty body with `Idempotency-Replay: omitted` (D12). Lower it for endpoints whose large responses should not be persisted.
- DynamoDB items are capped at 400 KB, so with the DynamoDB store the cap is 300 KiB (Q20). Both HTTP bridges lower `maxResultBytes` to it automatically because the store declares it; larger results are stored in the omitted form.
- `storeResult` decides whether a result is stored at all. The default stores statuses below 500; a stricter function can decline anything sensitive, at the cost of a retry running the handler again.
- Request bodies are never stored, only their SHA-256 fingerprint (D9). Queue payloads are never stored; the queue door stores only `{ outcome: 'ok' }` (REQ-Q-5). A fingerprint of a short, predictable payload can be confirmed by hashing guesses, so do not treat it as confidential.
- A record lives for the TTL (`ttlMs`, default 24 hours). Stores with native expiry delete it shortly after (a 60 second grace on DynamoDB and Redis); Postgres, D1 and SQLite rows remain until `purge(now)` runs, so schedule it where retention matters ([stores.md](stores.md#purge-scheduling)).
