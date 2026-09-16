# Open questions and recorded resolutions

Each entry has a recommended resolution. Work proceeds on the recommendation until Shantanu says otherwise. Raised at the next checkpoint.

## Q1: editor's copy date in requirements 0.2

requirements.md 0.2 says the editor's copy of the draft was "last touched November 2025". The clone of `ietf-wg-httpapi/idempotency` shows the last commit on any branch is 26 February 2025 (`dab060c`, "draft 06"). The `-07` text (15 October 2025) was published without a corresponding commit.

Recommended resolution: cite "editor's copy last committed February 2025; -07 published October 2025 without a repo commit" in the case study and S2 post. No code impact.

## Q2: REQ-Q-2 and REQ-Q-4 assume a handler can reach anyq's delay and dead-letter primitives

In anyq 0.5.0 (both languages) dead-letter and delayed redelivery are protected consumer hooks reachable only through a `RetryDecision` returned by the consumer's configured `strategy`. A wrapped handler cannot call them. See `docs/reference/anyq-interfaces.md`.

Recommended resolution: the queue adapter throws typed errors (`InFlightError` with `delayMs`, `FingerprintMismatchError` with the record) and ships a companion strategy, `idempotencyStrategy(inner?)` in TS and `anyqmw.Strategy(inner)` in Go, that maps them to `park(delayMs)` and `deadLetter('fingerprint-mismatch')` and delegates every other error to `inner` (default `retryThenDeadLetter()`). The README shows both pieces wired together. REQ-Q-4's "if the adapter cannot dead-letter, rethrow a typed error" is then the no-strategy path and needs no extra code. Tests cover: strategy present on memory and SQS (native park), strategy present on Kafka and Redis Streams (park downgrade to in-process retry, which re-enters `begin` after the lease), and no strategy (typed error reaches anyq's legacy path).

## Q3: D9 queue fingerprint "SHA-256 over body bytes" is not possible in TS

anyq's TS `IMessage` exposes `body: T` already deserialized and `raw` as a provider-specific object; the original bytes are not available. Go `Message.Body()` is raw bytes.

Recommended resolution: Go uses SHA-256 over `Body()` exactly as D9 says. TS defaults to SHA-256 over the RFC 8785 (JCS) canonical serialization of `message.body` when it is JSON-serializable, so the same logical payload produces the same fingerprint regardless of key order or whitespace; a custom `fingerprint(message)` option remains. Documented in `docs/semantics.md` as a TS profile note. This means the TS and Go queue adapters do not produce cross-language equal fingerprints for the same bytes, which does not matter because a scope is bound to one consumer group in one language.

## Q4: REQ-Q-1 default key order

anyq always populates `message.id` in both languages, so the documented order (message id, then `idempotency-key` header, then body hash) reduces to `message.id` in practice.

Recommended resolution: keep the documented order for callers who pass a custom message shape, add a test that the header path is used when `key: 'header'` is chosen explicitly, and note in the README that broker message ids are per delivery on some brokers (SQS redelivery keeps the same `MessageId`; Redis Streams entry ids are stable; Kafka has no id so anyq synthesizes `topic-partition-offset`, which is stable). The anyq adapter docs are the source for which ids are stable across redelivery; P4 verifies each of the three tested adapters.

## Q5: `docs/reference/draft-07.txt` and the dash gate

The CHECKLIST dash gate scans the whole tree. The fetched draft contains zero em or en dashes (checked with `rg`), so no exclusion is needed today. If a future draft revision introduces one, the gate should exclude `docs/reference/draft-*.txt` since it is verbatim normative text.

Recommended resolution: no change now; noted so the gate is not "fixed" by editing the reference text.

## Q6: golangci-lint is not installed locally

The Go gate in CHECKLIST.md requires `golangci-lint run`. It is absent on this machine.

Recommended resolution: install with `brew install golangci-lint` before the first Go code lands in P1; CI installs it via the official action. Not a spec question, recorded so the P1 gate does not fail for environmental reasons.

## Q7: `Store.complete` with `{ omitted: true }` loses status and headers (A1)

D12 says an omitted-body replay returns the original status and headers, but the 3.1 signature passes only `{ omitted: true }`.

Recommended resolution: the omitted variant is `{ omitted: true; kind: 'http' | 'message'; status?: number; headers?: [string, string][] }`. Stores persist `resultOmitted: true` and a `result` without `body`. REQ-STORE-10 checks "no body" and that status and headers survive.

## Q8: precedence between TTL expiry, lease expiry, and fingerprint mismatch (A2)

3.2 gives "expired lease yields acquired" and "different fingerprint yields mismatch regardless of state" without an order.

Recommended resolution: TTL-expired record is absent (D14) and yields `acquired` with fence 1 restarted; otherwise fingerprint mismatch wins over lease state, so a lease-expired record with a different fingerprint yields `mismatch`. Rationale: the draft's 422 rule is about key reuse with a different payload, and the first payload under a key is the truth for the key's lifetime. The contract suite adds two tests: `REQ-STORE-3: lease-expired record with different fingerprint yields mismatch` and `REQ-STORE-7: ttl-expired record with different fingerprint yields acquired`.

## Q9: the 255-byte key limit vector belongs in `profile`, not `core` (A3)

The draft sets no maximum key length. Grading third parties on it contradicts D17.

Recommended resolution: tier `profile`, id `profile/key-too-long`. Gap entry proposes the draft recommend a documented maximum. `core` keeps ten vectors by adding `core/key-empty-quoted` (`Idempotency-Key: ""` is a valid sf-string but an empty key, expect 400) so the CHECKLIST count still holds.

## Q10: branch coverage cannot come from `bun test --coverage` (A6)

Verified on bun 1.2.21: coverage output has `% Funcs` and `% Lines` columns only; a function with an untaken `if` branch reports 100.

Recommended resolution: `bun run test:coverage` runs vitest with `@vitest/coverage-v8` over `packages/core/src/engine.ts` with `branches: 100` as a threshold; CHECKLIST P1 wording updated to cite that command. All other tests stay on `bun test`.

## Q11: `withIdempotency` and shared HTTP helpers live in `@anyonce/core/http` (B8)

`@anyonce/webhooks` needs key parsing, problem details, response capture and replay headers but must not depend on `@anyonce/hono`.

Recommended resolution: subpath export `@anyonce/core/http` (Web APIs only, zero deps) holds `withIdempotency` and the helpers; `@anyonce/hono` becomes a thin binding to Hono's context and typing. The 8 KB budget (REQ-REL-5) applies to the root entry; the `http` subpath gets its own 16 KB line. requirements 4.4's "`@anyonce/hono` plus framework-agnostic `withIdempotency`" still holds for users: `@anyonce/hono` re-exports it.

## Q12: P4 webhook adapter depends on P2 (C1)

The prompt says P4 depends on P1 only. The webhook receiver returns the same 409, 422 and replay responses as the HTTP adapter and reuses its helpers.

Recommended resolution: P4 starts after P2 merges, in parallel with P3 and P5; its first task is the queue adapter, which truly needs only P1.
