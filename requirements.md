# anyonce: requirements

**Status:** authoritative spec, v1 scope. Every decision below is resolved. Claude Code implements against this document; it does not reopen decisions, it files a question in `docs/superpowers/questions.md` and continues with the documented default.

**One line:** anyonce is a transport-agnostic idempotent-execution primitive for serverless and edge systems. One core state machine, three adapters (HTTP `Idempotency-Key`, message-queue consumers via anyq, webhook receivers via Standard Webhooks `webhook-id`), six atomic stores, TypeScript and Go, and a language-agnostic conformance suite for the IETF `Idempotency-Key` draft that any implementation can run.

**Repo:** `github.com/sns45/anyonce`. npm scope `@anyonce/*`. Go module `github.com/sns45/anyonce/go`.

---

## 0. Why this exists (load-bearing section)

### 0.1 The problem

A request reaches a serverless system through one of three doors: an HTTP endpoint, a queue consumer, or an inbound webhook. All three doors deliver at-least-once in practice (client retries, visibility-timeout redelivery, sender retries). The fix is the same at every door: claim a key atomically, run the handler once, record the outcome, replay it on duplicates, reject concurrent duplicates, reject payload changes under the same key. Today each door has its own partial library, with different semantics, different stores, and no shared test suite.

### 0.2 Prior art (whitespace check, September 2026)

| Project | Scope | Stores | Language | Gap anyonce fills |
|---|---|---|---|---|
| `paveg/hono-idempotency` v0.9.0 (May 2026), official Hono third-party middleware | HTTP only, Hono only. Draft-conformant error codes, SHA-256 fingerprint, `Idempotency-Replayed`, non-2xx not cached | memory, Redis, KV, D1, Durable Objects | TypeScript | No queue or webhook door, no DynamoDB or Postgres, no conformance suite, KV store is not atomic across edge locations (documented by the author) |
| `idempo` (Go, net/http) | HTTP only, Stripe semantics | in-memory (others unclear) | Go | Same as above, Go side |
| Fiber `middleware/idempotency` | HTTP only, `X-Idempotency-Key`, cache semantics | Fiber storage | Go | Not draft-conformant header, no fingerprint/422 model |
| Watermill `middleware.Deduplicator`, MassTransit inbox, NATS `Nats-Msg-Id`, SQS FIFO `MessageDeduplicationId` | Queue door only, each bound to one broker or framework | broker-native | Go/.NET/broker | Not portable across brokers, no HTTP or webhook door, no stored result replay |
| Stripe, Adyen, PayPal, Square API docs | Service-side policy descriptions | n/a | n/a | Descriptions, not reusable code or tests |
| IETF `draft-ietf-httpapi-idempotency-key-header-07` | Specification. Expired 18 April 2026, no -08 posted. Still the HTTPAPI WG document; editor's copy last committed February 2025 (`dab060c`, draft 06); -07 published October 2025 without a repo commit | n/a | n/a | No conformance vectors exist for it anywhere |

Search performed: GitHub topic `idempotency-key`, npm, pkg.go.dev, IETF datatracker, HTTPAPI WG repo. No project found that (a) applies one idempotency core across HTTP, queue consumer and webhook receiver, or (b) ships a conformance suite for the draft.

### 0.3 The novelty claim (falsifiable)

anyonce is the first open-source idempotency primitive that:

1. applies one core state machine and one store contract across the three ingress doors (HTTP, queue consumer, webhook receiver), in TypeScript and Go;
2. ships an executable, language-agnostic conformance suite for `draft-ietf-httpapi-idempotency-key-header`, separating the draft's normative requirements from implementation profile choices, and publishes results for third-party implementations;
3. guarantees the claim step is a single atomic write on every supported store (no get-then-lock window), verified by a shared store contract test that runs a concurrency race on every backend.

If any of these three is already true of another project at launch, the claim is narrowed in the article, not defended.

### 0.4 Standards actions (part of the deliverable, not optional)

- **S1.** Open a PR against `ietf-wg-httpapi/idempotency` adding `conformance/` vectors (or, if the WG prefers, an issue linking to the anyonce suite) and an Implementation Status entry per RFC 7942.
- **S2.** Post to `httpapi@ietf.org` with the running-code summary and the cross-implementation report. Running code is how an expired WG draft gets a -08.
- **S3.** File precise issues on the draft for gaps found while implementing. Known candidates: replay indication header is unspecified; "success or an error" replay wording vs deployed practice of not caching 5xx; Structured-Field string syntax (quoted) vs every deployed implementation accepting bare tokens; no guidance on lease/expiry signaling for the 409 case.
- **S4.** For each third-party implementation the suite is run against (hono-idempotency, idempo, Fiber), file issues with the failing vectors, and PRs where the fix is small. Tone: collegial, the suite is offered as a shared asset.

### 0.5 Relationship to the rest of the portfolio

- anyq: the queue adapter is an anyq consumer middleware in both languages. anyonce becomes the consumer-side guarantee anyq currently lacks.
- anyhook: the webhook adapter is the receiver-side twin of anyhook's sender. anyhook signs and retries; anyonce dedupes on `webhook-id`.
- auth-gateway: the HTTP adapter's `scope` hook is where the session principal goes (composite key per draft section 5).

---

## 1. Scope

### 1.1 In scope (v1)

- TypeScript packages: `@anyonce/core`, `@anyonce/core/http` (subpath export: `withIdempotency` and the shared HTTP helpers), `@anyonce/hono`, `@anyonce/anyq`, `@anyonce/webhooks`, `@anyonce/stores` (subpath exports per store).
- Go packages under `github.com/sns45/anyonce/go`: `anyonce` (core), `httpmw`, `anyqmw`, `webhookmw`, `store/memory`, `store/dynamodb`, `store/redis`, `store/postgres`, `store/sqlite`.
- Conformance suite: `conformance/vectors/*.json`, JSON schema, runners in TS and Go, cross-implementation report.
- Examples: Cloudflare Worker (Hono + Durable Objects store), AWS Lambda function URL (fetch wrapper + DynamoDB store), Go net/http + Postgres, anyq consumer (TS and Go), Standard Webhooks receiver.
- Docs: semantics with state diagram, store guarantees matrix, problem types, conformance guide, security notes.

### 1.2 Out of scope (v1, documented as such)

- Transactional outbox, sagas, workflow orchestration.
- Exactly-once guarantees for side effects inside the handler beyond the anyonce boundary (documented honestly: anyonce guarantees at most one handler execution per key while the record is alive, and result replay; it does not roll back partial side effects).
- Cloudflare KV store. Eventual consistency breaks the atomic-claim invariant. Documented in `docs/stores.md` with the reason.
- Client-side key generation SDKs beyond a small `newKey()` helper.
- OpenTelemetry integration (hooks are provided; OTel bridge is a v1.1 candidate).
- Encryption at rest of stored results (store-level concern; documented).

---

## 2. Architecture decisions (resolved)

| ID | Decision | Rationale |
|---|---|---|
| D1 | Name `anyonce`, npm scope `@anyonce`, Go module path `github.com/sns45/anyonce/go`. Verify `npm view anyonce` and `gh repo view sns45/anyonce` return 404 before scaffolding; if taken, fall back to `anyonce-dev` scope and record it. | Fits the `any*` family (anyq, anyhook). No collision found in npm or GitHub searches. |
| D2 | Monorepo: Bun workspaces for TS under `packages/`, Go as a subdirectory module under `go/`, shared vectors under `conformance/`. | Mirrors anyq layout. |
| D3 | Core exposes `execute(op, run, policy)` and a `Store` interface with a single atomic `begin`. Adapters never talk to stores directly. | One state machine, testable without transports. |
| D4 | `begin` is one conditional write per store. Get-then-lock is forbidden. Each store's `begin` must pass the shared race test (50 concurrent identical claims, exactly one `acquired`). | This is the correctness claim (0.3 item 3). |
| D5 | In-flight records carry a lease (`leaseUntil`) and a monotonic fence token. Expired leases are re-acquirable with `fence + 1`; `complete` with a stale fence is rejected. | Crash recovery without a janitor; no stuck keys. |
| D6 | Result storage policy default: store status `< 500` (2xx, 3xx, 4xx) and replay them; on 5xx or thrown error, `abandon` the record so the client can retry. Configurable via `storeResult(result) => boolean`. | Matches Stripe/Adyen practice and hono-idempotency; the draft's "success or an error" is honored for 4xx. Recorded as a profile choice in conformance, not core. |
| D7 | Key syntax: default `lenient` (accept bare token or quoted sf-string, strip quotes); `strict` mode requires RFC 9651 sf-string as the draft says. Max key length 255 bytes; charset printable ASCII; violations are 400. The 255-byte maximum is a profile choice; the draft sets none. | Every deployed implementation accepts bare tokens; strict mode exists for conformance and for S3. |
| D8 | Scope is required by the core. HTTP adapter default scope is `${method} ${routePattern or path}`; a `principal` hook appends tenant/user. Queue adapter scope is `${queueName}/${consumerGroup}`. Webhook adapter scope is `${routePattern}/${sourceId}`. | Draft section 5 recommends composite keys; making scope explicit prevents cross-tenant replay. |
| D9 | Fingerprint default: SHA-256 over `method + "\n" + path + "\n" + body bytes` for HTTP; SHA-256 over body bytes for webhook, and for Go queue consumers over `Body()` bytes. The TS queue default is total: `string` hashes its UTF-8 bytes; `Uint8Array` or `ArrayBuffer` hashes the bytes; anything else is hashed over its RFC 8785 (JCS) canonical serialization; a body JCS cannot serialize throws a typed `FingerprintError` (at wrap time in tests, at first message in production), never a silent fallback; `raw` is never used. A custom fingerprint function remains available. | Simple default, deterministic, matches prior art so vectors are portable. |
| D10 | Replay marks responses with `Idempotency-Replayed: true`. In-flight duplicates return 409 with `Retry-After` derived from lease remaining (seconds, min 1). Mismatch returns 422. Missing key when required returns 400. All errors are RFC 9457 problem details with `Content-Type: application/problem+json` and a stable `code` member. | Interoperable with hono-idempotency and idempo conventions; 409 + Retry-After is the S3 proposal made concrete. |
| D11 | Problem `type` URIs: `${problemBaseUri}${code}` with default `problemBaseUri = "https://in8.sh/anyonce/problems/"`. Codes: `missing-key`, `invalid-key`, `conflict`, `fingerprint-mismatch`, `payload-too-large`, `store-unavailable`. | Author controls in8.sh; URIs resolve to docs at launch. |
| D12 | Stored result cap: `maxResultBytes` default 1 MiB. Over the cap: record completes with `resultOmitted: true`; replay returns the original status and headers, empty body, and `Idempotency-Replay: omitted`. | Never fail the original request because of replay bookkeeping. Extension header is documented as anyonce profile. |
| D13 | Store failure policy `onStoreError: 'fail-closed' | 'fail-open'`, default `fail-closed` (503 `store-unavailable`). | An idempotency layer that silently stops deduplicating is worse than one that stops serving. Fail-open exists for read-mostly endpoints. |
| D14 | TTL default 24h. Expiry is enforced on read (`begin` treats an expired record as absent) and physically via `purge(now)`. Expired records are absent to `begin`; the fence continues from the stale row when it is still present. | Stores without native TTL (DO, D1, Postgres, SQLite) need both. |
| D15 | Queue adapter outcomes: `completed` duplicate returns success to the broker without running the handler; `in_flight` duplicate returns a retryable failure with delay = lease remaining; `mismatch` routes to anyq dead-letter with reason `fingerprint-mismatch`. Stored result for queue is `{ outcome: 'ok' } | { outcome: 'error', name, message }`, never the message body. | Broker semantics are ack/nack/delay/DLQ, not HTTP bodies. |
| D16 | Webhook adapter runs strictly after signature verification. It accepts either a verified marker set by an upstream verifier or a `verify` callback it invokes first. Unverified requests never touch the store. Duplicate completed → replay stored 2xx immediately. In-flight → 409 + Retry-After. Mismatch (same `webhook-id`, different body) → 422 and an `onSuspicious` hook. | Prevents an attacker from poisoning the dedupe table with forged ids. |
| D17 | Conformance suite has two tiers: `core` (draft MUST/SHOULD, header syntax, 400/409/422, replay of completed result, single handler execution) and `profile` (anyonce extensions: replay header, Retry-After, omitted-body replay, 5xx not stored). Third-party implementations are graded on `core` only. | Fair comparison; profile tier documents anyonce's own choices. |
| D18 | Conformance runners are transport-only: they drive an HTTP handler (in-process `fetch` handler in TS, `http.Handler` in Go) or a base URL. No knowledge of stores. Fixture endpoints are part of the suite (`/echo`, `/status/{n}`, `/slow`, `/counter`). | Any implementation in any language can be tested by pointing the URL runner at it. |
| D19 | Tooling: Bun (runtime, workspaces, `bun test` for core/adapters/stores with emulators), `@cloudflare/vitest-pool-workers` for Durable Objects and D1 tests, Biome for lint/format, tsup for builds (ESM + CJS + d.ts), changesets for releases, npm provenance on publish. Go: minimum supported minor pinned in go.mod (`go 1.26`), latest two minors tested in CI via `stable` and `oldstable`, `go test -race`, golangci-lint, `go vet`. Language features newer than 1.26 are not used until 1.27 is `oldstable`. | Author's stack. |
| D20 | Integration tests use local emulators run as CI services: DynamoDB Local, Redis, Postgres (Docker), workerd via vitest-pool-workers, SQLite in-process. No tests hit real cloud accounts. Fixtures are committed; golden files use a `-update` flag. | Author's automation preference. |
| D21 | Zero production dependencies in `@anyonce/core`, `@anyonce/hono` (Hono is a peer), `@anyonce/webhooks`. Store packages depend only on their client (peer or optional). Go core depends only on the standard library. | Same discipline as svidmint's TS SDK. |
| D22 | Licence Apache-2.0. | Portfolio convention, patent grant matters for a primitive that will be copied. |

---

## 3. Core model

### 3.1 Types (TypeScript shown; Go mirrors with `[]byte` at the boundary and generics only where they remove casts)

```ts
export interface Operation {
  scope: string;        // required, see D8
  key: string;          // validated per D7
  fingerprint: string;  // hex SHA-256 or custom
}

export type RecordState = 'in_flight' | 'completed';

export interface StoredResult {
  kind: 'http' | 'message';
  status?: number;                // http
  headers?: [string, string][];   // http, allowlisted by adapter
  body?: Uint8Array;              // http
  outcome?: 'ok' | 'error';       // message
  error?: { name: string; message: string }; // message
}

export type OmittedResult = { omitted: true; kind: 'http' | 'message'; status?: number; headers?: [string, string][] };

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  state: RecordState;
  fence: number;          // monotonic per (scope,key)
  leaseUntil: number;     // epoch ms, meaningful while in_flight
  createdAt: number;      // epoch ms
  expiresAt: number;      // epoch ms
  result?: StoredResult;
  resultOmitted?: boolean;
}

export type BeginOutcome =
  | { outcome: 'acquired'; fence: number }
  | { outcome: 'in_flight'; leaseUntil: number }
  | { outcome: 'completed'; record: IdempotencyRecord }
  | { outcome: 'mismatch'; record: IdempotencyRecord };

export interface Store {
  begin(op: Operation, opts: { leaseMs: number; ttlMs: number; now: number }): Promise<BeginOutcome>;
  complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<'ok' | 'stale_fence' | 'not_found'>;
  abandon(op: Operation, fence: number): Promise<'ok' | 'stale_fence' | 'not_found'>;
  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null>;
  purge(now: number): Promise<number>;
  close?(): Promise<void>;
}
```

### 3.2 State machine

```
absent ──begin──▶ in_flight(fence=n) ──complete──▶ completed(result)
                      │                                  │
                      │ lease expires                    │ ttl expires / purge
                      ▼                                  ▼
                 re-acquirable(fence=n+1)              absent
                      │
                      └──abandon──▶ absent
```

Rules:
- `begin` on `absent` or expired-lease `in_flight` → `acquired` (fence increments on takeover).
- `begin` on live `in_flight` with same fingerprint → `in_flight`.
- `begin` on `completed` with same fingerprint → `completed`.
- `begin` on any record with a different fingerprint → `mismatch` (regardless of state).
- `complete`/`abandon` with a fence lower than the record's current fence → `stale_fence`, no write.
- Expired records (`expiresAt <= now`) are treated as `absent` by `begin` and `get`.

Precedence in `begin`: TTL expiry is checked first (an expired record is absent), then the fingerprint, then the lease. Fence continuation: when a TTL-expired row is still physically present, the new record's fence is `old.fence + 1`; when the store's native TTL has already removed the row, the fence restarts at 1.

### 3.3 Engine

```ts
export interface ExecutePolicy {
  leaseMs: number;                 // default 30_000
  ttlMs: number;                   // default 86_400_000
  maxResultBytes: number;          // default 1_048_576
  storeResult: (r: StoredResult) => boolean; // default: kind==='message' || (status ?? 500) < 500
  onStoreError: 'fail-closed' | 'fail-open';  // default fail-closed
  clock?: () => number;
  hooks?: {
    onAcquired?(op: Operation): void;
    onReplayed?(op: Operation, rec: IdempotencyRecord): void;
    onConflict?(op: Operation, leaseUntil: number): void;
    onMismatch?(op: Operation, rec: IdempotencyRecord): void;
    onStoreError?(op: Operation, err: unknown): void;
  };
}

export type ExecuteResult =
  | { kind: 'executed'; result: StoredResult; stored: boolean }
  | { kind: 'replayed'; record: IdempotencyRecord }
  | { kind: 'conflict'; leaseUntil: number }
  | { kind: 'mismatch'; record: IdempotencyRecord }
  | { kind: 'store_error'; error: unknown };   // only when fail-closed

export function execute(
  store: Store,
  op: Operation,
  run: () => Promise<StoredResult>,
  policy: ExecutePolicy,
): Promise<ExecuteResult>;
```

Engine guarantees:
- `run` is invoked at most once per `acquired` outcome and never on any other outcome.
- If `run` throws, the engine calls `abandon` and rethrows (adapters translate to 500 / retryable failure).
- If `storeResult(result)` is false, the engine calls `abandon` and returns `{ kind: 'executed', stored: false }`.
- If the serialized result exceeds `maxResultBytes`, the engine calls `complete` with `{ omitted: true }`.
- `fail-open`: on store error at `begin`, run the handler and return `executed` with `stored: false`; on store error at `complete`, return `executed` with `stored: false`. `fail-closed`: return `store_error` without running.
- Hooks never throw into the engine; exceptions are swallowed and counted.

---

## 4. Requirements

Numbering: `REQ-<area>-<n>`. Each REQ has acceptance criteria (AC). Tests reference REQ IDs in their names.

### 4.1 Core (`@anyonce/core`, Go `anyonce`)

- **REQ-CORE-1** Implement `Operation`, `IdempotencyRecord`, `Store`, `execute` per section 3. AC: unit tests cover every transition in 3.2 with a fake store; 100% branch coverage on the engine file.
- **REQ-CORE-2** Key validation: 1..255 bytes, printable ASCII (0x21..0x7E) plus space when inside an sf-string; reject otherwise with `invalid-key`. AC: table-driven tests including empty, 256 bytes, control chars, non-ASCII.
- **REQ-CORE-3** Structured-Field string parsing (RFC 9651 sf-string) in `strict` mode; `lenient` mode accepts bare token and strips surrounding quotes with escapes unescaped. AC: vectors from RFC 9651 examples; bare `abc`, `"abc"`, `"a\"b"`, unterminated quote.
- **REQ-CORE-4** Fingerprint helpers: `sha256Hex(bytes)`, `httpFingerprint(method, path, body)`, `jcsFingerprint(json)` (RFC 8785). AC: known-answer tests; JCS test vectors from the RFC.
- **REQ-CORE-5** `newKey()` returns UUIDv4 via Web Crypto (TS) / `crypto/rand` (Go). AC: format test, 10k uniqueness smoke.
- **REQ-CORE-6** Memory store ships inside core (TS and Go), used by tests and single-instance deployments. AC: passes the store contract suite (4.2).
- **REQ-CORE-7** Zero production dependencies; Web APIs only in TS (Web Crypto, TextEncoder). AC: `package.json` has no `dependencies`; a test asserts the built bundle imports nothing from `node:`.
- **REQ-CORE-8** Go core mirrors TS semantics with `Store` interface, `Execute(ctx, store, op, run, policy) (Result, error)`; `context.Context` threaded everywhere. AC: same transition tests; `go test -race` clean.

### 4.2 Store contract suite (shared, runs against every store in both languages)

- **REQ-STORE-1** `begin` on absent returns `acquired` with `fence = 1`.
- **REQ-STORE-2** Second `begin` with same fingerprint while lease live returns `in_flight` with the same `leaseUntil`.
- **REQ-STORE-3** `begin` with different fingerprint returns `mismatch` in both `in_flight` and `completed` states.
- **REQ-STORE-4** `complete` then `begin` returns `completed` with the stored result byte-exact.
- **REQ-STORE-5** Lease takeover: after `leaseUntil`, `begin` returns `acquired` with `fence = 2`; a subsequent `complete` with `fence = 1` returns `stale_fence` and the record is unchanged.
- **REQ-STORE-6** `abandon` removes the in-flight record; `begin` afterwards returns `acquired`.
- **REQ-STORE-7** Expiry: after `expiresAt`, `begin` returns `acquired`; with the stale row still present the fence is `old.fence + 1`, with the row physically removed the fence is 1 (the memory store exposes a test-only `physicallyRemove(op)` to simulate native deletion); `get` returns null; `purge` returns the count removed.
- **REQ-STORE-8** Race: 50 concurrent `begin` calls for the same op yield exactly one `acquired` and 49 `in_flight`. Run 20 iterations. This is the D4 invariant; a store that cannot pass it is not shipped.
- **REQ-STORE-9** Scope isolation: same key under two scopes yields two independent records.
- **REQ-STORE-10** Result cap: `complete` with the omitted form produces a record with `resultOmitted: true` and no body; status and headers survive omission.
- **REQ-STORE-11** Large body round trip at exactly `maxResultBytes` (1 MiB) survives byte-exact, and `maxResultBytes + 1` yields the omitted form with status and headers intact.
AC for the suite: exported as `@anyonce/core/testing` (TS) and `anyonce/storetest` (Go) so third parties can validate custom stores.

### 4.3 Stores (TS `@anyonce/stores/<name>`, Go `store/<name>`)

Each store documents: consistency, atomicity mechanism for `begin`, native TTL or not, setup, and cost notes, in a shared matrix in `docs/stores.md`.

- **REQ-ST-DO-1** (TS) Durable Objects store: one DO instance per `(scope)` or per `(scope,key)` shard, selectable; `begin` is a single storage transaction inside the DO (single-writer); alarm-based `purge`. Ships a `class IdempotencyObject extends DurableObject` with RPC methods so the Worker calls it without HTTP fetch. AC: contract suite under vitest-pool-workers; race test uses 50 parallel `stub.begin()` calls.
- **REQ-ST-D1-1** (TS) D1 store: `begin` is one `INSERT ... ON CONFLICT(scope,key) DO UPDATE SET ... WHERE lease_until <= ?1 OR expires_at <= ?1 RETURNING ...` statement; schema migration provided as SQL file and `ensureSchema()`; `purge` via indexed `expires_at`. AC: contract suite under vitest-pool-workers. The conflict branch computes `fence = COALESCE(existing.fence, 0) + 1` so a TTL-expired row that is still present continues the fence (Q8).
- **REQ-ST-DDB-1** (TS + Go) DynamoDB store: `begin` is `PutItem`/`UpdateItem` with a `ConditionExpression` (`attribute_not_exists(pk) OR lease_until <= :now OR expires_at <= :now`), returning the existing item on `ConditionalCheckFailedException` via `ReturnValuesOnConditionCheckFailure`; TTL attribute for native expiry; `purge` is a no-op that returns 0. AC: contract suite against DynamoDB Local; TS uses `@aws-sdk/client-dynamodb` v3 as a peer, Go uses `aws-sdk-go-v2`.
- **REQ-ST-REDIS-1** (TS + Go) Redis store: `begin`, `complete`, `abandon` each a single Lua script (EVALSHA with fallback) so the read-check-write is atomic; hash per `(scope,key)`; `PEXPIRE` (relative to the write, plus a grace) for native TTL; `purge` no-op. Compatible with ioredis, node-redis, and `@upstash/redis` (REST) in TS; `go-redis` in Go. AC: contract suite against Redis 7 container; script sha caching tested.
- **REQ-ST-PG-1** (TS + Go) Postgres store: `begin` is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` statement; `purge` via index on `expires_at`; migration SQL provided. TS driver-agnostic via a minimal `query(sql, params)` adapter (works with `pg`, `postgres.js`, Neon serverless); Go uses `database/sql` + pgx stdlib. AC: contract suite against Postgres 16 container. The conflict branch computes `fence = COALESCE(existing.fence, 0) + 1` so a TTL-expired row that is still present continues the fence (Q8).
- **REQ-ST-SQLITE-1** (Go only) SQLite store via `modernc.org/sqlite` (cgo-free), same statement shape as D1, including the fence formula. AC: contract suite in-process.
- **REQ-ST-KV-1** Cloudflare KV is explicitly not implemented; `docs/stores.md` explains why (eventual consistency defeats REQ-STORE-8) and points to DO or D1.

### 4.4 HTTP adapter (`@anyonce/core/http` holds the framework-agnostic `withIdempotency` for any `fetch` handler and the shared HTTP helpers; `@anyonce/hono` re-exports it and binds Hono's context and typing; Go `httpmw` as `func(http.Handler) http.Handler`)

- **REQ-HTTP-1** Applies to configurable methods, default `POST`, `PATCH`. Other methods pass through untouched. AC: vectors `core/methods-*.json`.
- **REQ-HTTP-2** Header name configurable, default `Idempotency-Key`; case-insensitive lookup; multiple header values → 400 `invalid-key`.
- **REQ-HTTP-3** `required: boolean` default false. Missing header with `required: true` → 400 `missing-key` problem details with a `Link: <docsUrl>; rel="describedby"` header as the draft suggests. Missing header with `required: false` → pass through.
- **REQ-HTTP-4** Key syntax per D7 with `keySyntax: 'lenient' | 'strict'`.
- **REQ-HTTP-5** Scope per D8: `scope?: (req) => string` overrides; `principal?: (req) => string | undefined` appends `#${principal}`; `requirePrincipal: boolean` default false makes a missing principal a 500 configuration error at startup-time check where possible, otherwise at first request.
- **REQ-HTTP-6** Fingerprint per D9 with `fingerprint?: 'body' | 'jcs' | ((req, bodyBytes) => Promise<string>)`; body read once and re-supplied to the handler (Request cloned in TS, body buffered and reset in Go). `maxRequestBytes` default 1 MiB → 413 `payload-too-large`.
- **REQ-HTTP-7** First request: handler runs; response captured (status, allowlisted headers, body bytes) and stored per D6/D12; response streamed to the client while a copy is buffered up to `maxResultBytes`.
- **REQ-HTTP-8** Header allowlist for stored responses, default `Content-Type`, `Content-Language`, `Location`, `ETag`, `Link`; configurable. `Set-Cookie` is never stored.
- **REQ-HTTP-9** Completed duplicate → replay stored status, headers, body; add `Idempotency-Replayed: true`. Omitted-body replay per D12.
- **REQ-HTTP-10** In-flight duplicate → 409 `conflict` problem details plus `Retry-After: <ceil(leaseRemaining/1000), min 1>`.
- **REQ-HTTP-11** Fingerprint mismatch → 422 `fingerprint-mismatch` problem details.
- **REQ-HTTP-12** Store unavailable per D13 → 503 `store-unavailable` with `Retry-After: 1` (fail-closed) or pass-through with `Idempotency-Degraded: true` (fail-open).
- **REQ-HTTP-13** Problem details per D11; `onError(problem, req) => Response` override; `hono-problem-details` is not a dependency.
- **REQ-HTTP-14** Handler can read `idempotencyKey` and `idempotencyFence` from context (Hono `c.get`, Go `context.Value` via typed accessor).
- **REQ-HTTP-15** `skip?: (req) => boolean` for per-request opt-out.
- **REQ-HTTP-16** Hono package: `idempotency(options)` middleware typed with `IdempotencyEnv` so `hc<AppType>` RPC clients see the variables; peer dep `hono >= 4`.
- **REQ-HTTP-17** `withIdempotency(handler, options)` wraps any `(req: Request, ...rest) => Promise<Response>` for Workers without Hono and for Lambda function URLs (via the Lambda Web Adapter or `aws-lambda` fetch shims). AC: Worker example and Lambda example both pass the URL-mode conformance runner in CI (Worker via `unstable_dev`/vitest-pool-workers; Lambda via a local fetch harness, not a deployed function).
- **REQ-HTTP-18** Go `httpmw.New(store, Options).Handler(next)`; response capture via a `http.ResponseWriter` wrapper that supports `Flush`, `Hijack` passthrough (idempotency disabled on hijack), and `http.ResponseController`. AC: Go conformance runner passes `core` and `profile`.

### 4.5 Queue adapter (`@anyonce/anyq`, Go `anyqmw`)

Claude Code MUST read the real anyq consumer handler signature from `github.com/sns45/anyq` (TS `packages/core`) and `github.com/sns45/anyq/go` before implementing; the shapes below are illustrative.

- **REQ-Q-1** `idempotent(handler, { store, key?, scope?, fingerprint?, leaseMs?, ttlMs?, onInFlight?: 'retry' | 'ack' })` returns a handler with the same signature. Default `key`: message id if the adapter exposes one, else `idempotency-key` message attribute/header, else SHA-256 of body. Default scope: `${queue}/${consumerGroup}`. Redelivery id stability per adapter is documented in `docs/queue-ids.md`. The key source is an explicit option (`'id'`, `'header'`, `'body'` or a function) because an anyq park does not preserve the message id on every adapter (Q23).
- **REQ-Q-2** Outcomes per D15. `retry` on in-flight uses anyq's delay/requeue primitive with delay = lease remaining; `ack` treats in-flight duplicate as handled (documented as at-most-once-per-lease trade-off).
- **REQ-Q-3** Handler exception → `abandon` and rethrow so anyq's existing retry strategy and DLQ policy apply unchanged.
- **REQ-Q-4** Mismatch → call anyq dead-letter with reason `fingerprint-mismatch`; if the adapter cannot dead-letter, rethrow a typed `FingerprintMismatchError`.
- **REQ-Q-5** Stored result is the message outcome only (D15), never the payload. AC: a test asserts the stored record has no body bytes.
- **REQ-Q-6** Works with at least three anyq adapters in tests: memory/Redis Streams, SQS (LocalStack or elasticmq container), Kafka (redpanda container). Other adapters are covered by the anyq handler contract, not re-tested here.
- **REQ-Q-7** Go: `anyqmw.Wrap(handler, Options)`; same outcomes; `context.Context` cancellation abandons the record.
- **REQ-Q-8** Companion strategy `idempotencyStrategy(inner?)` (TS) and `anyqmw.Strategy(inner)` (Go) maps `InFlightError` to `park(delayMs)` and `FingerprintMismatchError` to `deadLetter('fingerprint-mismatch')` and delegates every other error to `inner` (default `retryThenDeadLetter()`). AC: strategy present on memory and SQS (native park); strategy present on Kafka and Redis Streams (park downgrades to an in-process retry that must not call the handler before the lease expires); no strategy (the typed error reaches anyq's legacy path). The README and both examples show `idempotent(handler)` and the strategy wired together; the adapter logs once at first `InFlightError` if it can detect that no strategy translated it.

### 4.6 Webhook adapter (`@anyonce/webhooks`, Go `webhookmw`)

- **REQ-WH-1** `webhookReceiver({ store, idHeader?: 'webhook-id', key?: (req, body) => string, scope?, verify?: (req, body) => Promise<boolean>, verifiedMarker?: string, onSuspicious? })`. Default key source is the Standard Webhooks `webhook-id` header. `key` function supports body-derived ids (Stripe `event.id`, GitHub `X-GitHub-Delivery` via header override).
- **REQ-WH-2** Verification gate per D16: if neither `verify` nor a truthy `verifiedMarker` context value is present, the middleware returns 500 `configuration-error` at first request and logs once. Unverified requests never call `store.begin`.
- **REQ-WH-3** Duplicate completed → replay stored response with `Idempotency-Replayed: true` (always 2xx by construction since only `< 500` is stored and receivers respond 2xx).
- **REQ-WH-4** In-flight → 409 + `Retry-After` (sender retries later; first delivery finishes).
- **REQ-WH-5** Mismatch → 422, `onSuspicious(req, record)` hook fires.
- **REQ-WH-6** Ships a `standardWebhooksVerify(secret)` helper implementing the Standard Webhooks signature check (HMAC-SHA256 over `${id}.${timestamp}.${body}`, `v1,` prefixes, timestamp tolerance default 5 minutes) so the adapter is usable without a second package; anyhook's sender is the interop test partner (sign with anyhook, receive with anyonce). AC: round-trip test against anyhook's signer; Standard Webhooks published test vectors pass.
- **REQ-WH-7** Go `webhookmw.New(store, Options).Handler(next)` with the same behavior and a `standardwebhooks.Verify` helper.

### 4.7 Conformance suite (`conformance/`)

- **REQ-CONF-1** Vector format: `conformance/schema.json` (JSON Schema 2020-12). A vector file is `{ id, tier: 'core' | 'profile', title, draftRef?: 'section-2.6', description, fixture: FixtureRef, steps: Step[] }`. A `Step` is `{ request: { method, path, headers, body? }, concurrentWith?: stepId[], expect: { status, headers?: { [name]: string | { present: true } | { absent: true } | { regex } }, bodyEquals?: string | { sameAs: stepId }, handlerInvocations?: number } }`. AC: every vector validates against the schema in CI.
- **REQ-CONF-2** Fixtures the implementation under test must mount behind its idempotency layer: `POST /echo` (201, echoes body, increments a counter exposed at `GET /counter`), `POST /status/{code}` (returns that status with body `"status:{code}"`), `POST /slow?ms=N` (sleeps N ms then 200), `POST /large?bytes=N` (returns N bytes), `POST /reset` (clears counter). Documented in `conformance/README.md`; reference fixture apps provided for Hono and net/http.
- **REQ-CONF-3** `core` tier vectors (minimum set, each cites the draft section): key missing when required → 400 (status only; body shape is a profile expectation); key present on POST executes handler once; identical retry after completion replays same status and body and does not increment counter; same key different body → 422; concurrent duplicate while in flight → 409; sf-string quoted key accepted; key on GET is ignored; two different keys execute twice; expiry after TTL executes again (uses a short-TTL fixture flag); same key after a rejected mismatch still replays the original (`core/mismatch-does-not-poison`); header name matched case-insensitively (`core/header-name-case-insensitive`).
- **REQ-CONF-4** `profile` tier vectors: `Idempotency-Replayed: true` on replay; `Retry-After` on 409; 4xx original is replayed; 5xx original is not stored (retry executes again); omitted-body replay above cap; problem `code` member present; key exceeding 255 bytes → 400 (`profile/key-too-long`); empty quoted key → 400 (`profile/empty-key-rejected`); error responses use `application/problem+json` (`profile/problem-content-type`).
- **REQ-CONF-5** TS runner `@anyonce/conformance`: `runConformance({ target: fetchHandler | { baseUrl }, tiers, report: 'json' | 'markdown' | 'junit' })`; usable inside `bun test` and vitest. Concurrency steps are executed with `Promise.all` and a barrier so both requests are in flight before either handler resolves (uses `/slow`).
- **REQ-CONF-6** Go runner `conformance.Run(t, http.Handler | baseURL, Options)` with the same report formats.
- **REQ-CONF-7** CLI: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown` for testing any implementation in any language.
- **REQ-CONF-8** Cross-implementation report `conformance/REPORT.md` generated by CI (`-update` flag pattern) for: anyonce TS (each store), anyonce Go (each store), hono-idempotency, idempo, Fiber idempotency. Third parties graded on `core` only. Each failing vector links to a filed issue (S4).
- **REQ-CONF-9** Draft gap list `conformance/DRAFT-GAPS.md`: every place the vectors had to choose behavior the draft leaves open, with the anyonce choice and a proposed draft text. This is the S3 input.

### 4.8 Documentation and examples

- **REQ-DOC-1** `README.md` (root): the three-door pitch, 30-second Hono example, store matrix, conformance badge, link to case study. States plainly that a producer-supplied `idempotency-key` header is the recommended default for any broker whose message id changes on redelivery or producer retry (Q4).
- **REQ-DOC-2** `docs/semantics.md`: state machine (Mermaid), lease and fence explanation, what anyonce does and does not guarantee (honest limits paragraph from 1.2). Includes the cross-language fingerprint note from Q3 with the sentence "a scope is bound to one consumer group in one language" verbatim.
- **REQ-DOC-3** `docs/stores.md`: guarantees matrix, atomicity mechanism per store, KV exclusion rationale, migration SQL links.
- **REQ-DOC-4** `docs/problems.md`: every problem type with code, status, when, example body; served at the D11 base URI at launch.
- **REQ-DOC-5** `docs/conformance.md`: how to run the suite against anything, how to read the report, how to add a vector.
- **REQ-DOC-6** `docs/security.md`: key entropy, scope/principal composition, log redaction of keys (only first 8 chars logged), replay isolation, stored-body considerations.
- **REQ-DOC-7** Examples under `examples/`: `worker-hono-do`, `lambda-fetch-dynamodb`, `go-net-http-postgres`, `anyq-consumer-ts`, `anyq-consumer-go`, `webhook-receiver-standard-webhooks`. Each has a README and a smoke test run in CI.
- **REQ-DOC-8** `llms.txt` at repo root summarizing packages and semantics (same pattern as in8.sh).
- **REQ-DOC-9** `docs/queue-ids.md`: one row per anyq consumer adapter with the message id's stability across redelivery and producer retry; the three adapters tested in P4a marked verified, the rest marked per anyq docs, unverified; recommends a producer-supplied `idempotency-key` header where the id is not stable.

### 4.9 Release and supply chain

- **REQ-REL-1** changesets with `@anyonce/*` fixed versioning group; initial `0.1.0`.
- **REQ-REL-2** npm publish with provenance (`--provenance`) from GitHub Actions OIDC; forgeseal SBOM + Sigstore signing of the release tarballs as a release step (portfolio dogfooding).
- **REQ-REL-3** Go module tagged `go/v0.1.0`; `go vet`, `go test -race`, golangci-lint in CI; pkg.go.dev renders.
- **REQ-REL-4** CI matrix: Bun latest, Node 22 (compat test of built output), Go `stable` and `oldstable` via actions/setup-go; services: DynamoDB Local, Redis 7, Postgres 16, Redpanda, ElasticMQ.
- **REQ-REL-5** Bundle size budget: `@anyonce/core` root entry under 8 KB, `@anyonce/core/http` subpath under 16 KB, minified plus gzip; checked in CI.

---

## 5. Non-functional requirements

- **NFR-1** Overhead: HTTP adapter adds under 2 ms p50 with the memory store (measured in `benchmarks/`, published in README).
- **NFR-2** No key material or full keys in logs; keys are redacted to 8 characters in hooks' default logger.
- **NFR-3** TS packages publish ESM and CJS with `exports` map and `types`; `sideEffects: false`.
- **NFR-4** Works on Cloudflare Workers, Bun, Node 22+, Deno (core and Hono adapter tested on all four; stores tested where the client runs).
- **NFR-5** Go: no cgo anywhere (SQLite via modernc).
- **NFR-6** Prose in docs and comments: no em or en dashes.

---

## 6. Phases (input to `writing-plans`)

Each phase ends with: tests green in CI, `verification-before-completion` evidence pasted into the PR, code review via `requesting-code-review`, branch finished via `finishing-a-development-branch`. P4a starts after P1 and runs in parallel with P2; after P2, phases 3, 4b and 5 are independent of each other. These are the sub-agent parallelization points. The Depends on column lists each phase's direct prerequisite phases; a phase's scope is itself plus the transitive closure of these dependencies.

| Phase | Deliverable | REQs | Depends on |
|---|---|---|---|
| P0 Scaffold and vectors | Repo, workspaces, CI skeleton, `conformance/schema.json`, all `core` and `profile` vectors written and schema-validated, fixture apps (Hono, net/http). Vectors first: they are the executable form of this spec. | CONF-1..4, REL-4 | none |
| P1 Core | TS core + memory store + store contract suite + engine; Go core + memory store + storetest. | CORE-1..8, STORE-1..11 | P0 |
| P2 HTTP adapter | `withIdempotency`, Hono middleware, TS conformance runner, all core+profile vectors green with memory store. Go `httpmw` + Go runner green. | HTTP-1..18, CONF-5..7 | P1 |
| P3 Stores | DO, D1, DynamoDB, Redis, Postgres (TS); DynamoDB, Redis, Postgres, SQLite (Go). Each passes contract suite and full conformance via the HTTP adapter. | ST-* | P2 |
| P4a Queue door | anyq adapters (TS, Go), companion strategy, `docs/queue-ids.md`. Starts after P1, parallel with P2. | Q-1..8, DOC-9 | P1 |
| P4b Webhook door | webhook receivers (TS, Go), anyhook interop test. Starts after P2, parallel with P3 and P5. | WH-1..7 | P2 |
| P5 Cross-implementation report | Run suite against hono-idempotency, idempo, Fiber; `REPORT.md`, `DRAFT-GAPS.md`; file S4 issues. | CONF-8..9 | P2 |
| P6 Docs, examples, release | All docs, six examples with CI smoke, benchmarks, 0.1.0 release with provenance and forgeseal signing, `llms.txt`. | DOC-*, REL-*, NFR-* | P3, P4a, P4b, P5 |
| P7 Standards and launch | S1..S3 executed; five launch surfaces via the project-launch skill; case study with the 0.3 claim as the "Why this is new" section. | 0.4 | P6 |

---

## 7. Acceptance for v1 done

1. Every REQ has at least one test named with its ID; `bun run test:reqs` and `go test ./... -run REQ` list coverage per REQ and fail on missing IDs.
2. Conformance: anyonce passes 100% of `core` and `profile` with every store in both languages.
3. `REPORT.md` published with at least three third-party implementations graded.
4. S1 PR or issue open on the WG repo; S2 mail sent; S3 issues filed and linked from `DRAFT-GAPS.md`.
5. `npm view @anyonce/core` shows provenance; Go module resolves; examples deploy locally per README.
6. Case study live on in8.sh with the falsifiable claim stated as written in 0.3, narrowed if evidence required it.

---

## 8. Glossary

- **Door**: an ingress path (HTTP, queue consumer, webhook receiver).
- **Claim**: the atomic `begin` that transitions `absent → in_flight`.
- **Lease**: time window during which an in-flight claim is exclusive.
- **Fence**: monotonic token that invalidates completions from a superseded lease holder.
- **Replay**: returning the stored result of a completed operation without executing the handler.
- **Profile**: anyonce's documented choices where the draft is silent.
