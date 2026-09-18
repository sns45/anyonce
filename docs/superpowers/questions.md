# Open questions and recorded resolutions

Each entry has a recommended resolution. Work proceeds on the recommendation until Shantanu says otherwise. Raised at the next checkpoint.

**Review status:** all 14 answered on 17 September 2026. Decisions marked ACCEPT adopt the recommendation as written. MODIFY keeps the direction and changes a detail; the changed detail is the binding text. REJECT replaces the recommendation. Section 15 lists every edit these decisions require in requirements.md, CHECKLIST.md and prompt.md; apply those edits in the first task of the next plan so the spec files never disagree with this file.

## Q1: editor's copy date in requirements 0.2

requirements.md 0.2 says the editor's copy of the draft was "last touched November 2025". The clone of `ietf-wg-httpapi/idempotency` shows the last commit on any branch is 26 February 2025 (`dab060c`, "draft 06"). The `-07` text (15 October 2025) was published without a corresponding commit.

Recommended resolution: cite "editor's copy last committed February 2025; -07 published October 2025 without a repo commit" in the case study and S2 post. No code impact.

**Decision: ACCEPT.** Also correct the requirements.md 0.2 table row to the same wording so the spec is not the source of a wrong date. Record the commit hash in `docs/reference/preflight.md`. This detail strengthens S2: the WG repo has been idle for 19 months, which is the case for running code.

## Q2: REQ-Q-2 and REQ-Q-4 assume a handler can reach anyq's delay and dead-letter primitives

In anyq 0.5.0 (both languages) dead-letter and delayed redelivery are protected consumer hooks reachable only through a `RetryDecision` returned by the consumer's configured `strategy`. A wrapped handler cannot call them. See `docs/reference/anyq-interfaces.md`.

Recommended resolution: the queue adapter throws typed errors (`InFlightError` with `delayMs`, `FingerprintMismatchError` with the record) and ships a companion strategy, `idempotencyStrategy(inner?)` in TS and `anyqmw.Strategy(inner)` in Go, that maps them to `park(delayMs)` and `deadLetter('fingerprint-mismatch')` and delegates every other error to `inner` (default `retryThenDeadLetter()`). The README shows both pieces wired together. REQ-Q-4's "if the adapter cannot dead-letter, rethrow a typed error" is then the no-strategy path and needs no extra code. Tests cover: strategy present on memory and SQS (native park), strategy present on Kafka and Redis Streams (park downgrade to in-process retry, which re-enters `begin` after the lease), and no strategy (typed error reaches anyq's legacy path).

**Decision: ACCEPT.** Two additions. First, the strategy is not optional in the documented wiring: the README and both examples show `idempotent(handler)` and `idempotencyStrategy()` together, and the adapter logs a one-time warning at first `InFlightError` if it can detect that no strategy translated it (if detection is impossible, the README states the requirement in the first paragraph). Second, add REQ-Q-8 for the companion strategy so it has its own test IDs; the three test cases listed above are its acceptance criteria. The Kafka and Redis Streams "park downgrade" path must assert that the in-process retry does not call the handler before the lease expires (that is the whole point of the lease).

## Q3: D9 queue fingerprint "SHA-256 over body bytes" is not possible in TS

anyq's TS `IMessage` exposes `body: T` already deserialized and `raw` as a provider-specific object; the original bytes are not available. Go `Message.Body()` is raw bytes.

Recommended resolution: Go uses SHA-256 over `Body()` exactly as D9 says. TS defaults to SHA-256 over the RFC 8785 (JCS) canonical serialization of `message.body` when it is JSON-serializable, so the same logical payload produces the same fingerprint regardless of key order or whitespace; a custom `fingerprint(message)` option remains. Documented in `docs/semantics.md` as a TS profile note. This means the TS and Go queue adapters do not produce cross-language equal fingerprints for the same bytes, which does not matter because a scope is bound to one consumer group in one language.

**Decision: MODIFY.** Keep JCS as the TS default for objects, and define the other body types so the default is total: `string` hashes its UTF-8 bytes; `Uint8Array` or `ArrayBuffer` hashes the bytes directly; anything else goes through JCS; a body JCS cannot serialize (cyclic, BigInt, undefined at top level) throws a typed `FingerprintError` at wrap time in tests and at first message in production, never a silent fallback. Do not use `raw` for fingerprinting even when a provider exposes bytes there, because that would make the fingerprint provider-dependent within one language. The cross-language inequality is accepted and goes in `docs/semantics.md` with the sentence "a scope is bound to one consumer group in one language" verbatim.

## Q4: REQ-Q-1 default key order

anyq always populates `message.id` in both languages, so the documented order (message id, then `idempotency-key` header, then body hash) reduces to `message.id` in practice.

Recommended resolution: keep the documented order for callers who pass a custom message shape, add a test that the header path is used when `key: 'header'` is chosen explicitly, and note in the README that broker message ids are per delivery on some brokers (SQS redelivery keeps the same `MessageId`; Redis Streams entry ids are stable; Kafka has no id so anyq synthesizes `topic-partition-offset`, which is stable). The anyq adapter docs are the source for which ids are stable across redelivery; P4 verifies each of the three tested adapters.

**Decision: ACCEPT.** The redelivery-stability table goes in `docs/stores.md`'s sibling, a new `docs/queue-ids.md`, one row per anyq adapter (all nine, not just the three tested), with the tested three marked verified and the rest marked "per anyq adapter docs, unverified". A producer-supplied `idempotency-key` header is the recommended default in the README for any broker whose id changes on redelivery or on producer retry (a producer retry creates a second message with a second id, which no consumer-side id can dedupe); the README says this plainly.

## Q5: `docs/reference/draft-07.txt` and the dash gate

The CHECKLIST dash gate scans the whole tree. The fetched draft contains zero em or en dashes (checked with `rg`), so no exclusion is needed today. If a future draft revision introduces one, the gate should exclude `docs/reference/draft-*.txt` since it is verbatim normative text.

Recommended resolution: no change now; noted so the gate is not "fixed" by editing the reference text.

**Decision: MODIFY.** Add the exclusion now: the gate command becomes `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .`. `docs/reference/` holds verbatim third-party text by definition (the draft, anyq interfaces copied from source, anyhook signing routine), so none of it should ever be edited to satisfy a style gate. Cheaper to exclude the directory once than to rely on someone remembering this note.

## Q6: golangci-lint is not installed locally

The Go gate in CHECKLIST.md requires `golangci-lint run`. It is absent on this machine.

Recommended resolution: install with `brew install golangci-lint` before the first Go code lands in P1; CI installs it via the official action. Not a spec question, recorded so the P1 gate does not fail for environmental reasons.

**Decision: ACCEPT.** Pin the same version locally and in CI (the `golangci/golangci-lint-action` `version` input and a comment in `CLAUDE.md` naming it), and commit a `.golangci.yml` in the current config schema version so local and CI runs agree on the linter set. Add `golangci-lint`, `docker`, `bun`, and `go` to a `scripts/doctor.sh` that P0 ships and the every-phase gate runs first.

## Q7: `Store.complete` with `{ omitted: true }` loses status and headers (A1)

D12 says an omitted-body replay returns the original status and headers, but the 3.1 signature passes only `{ omitted: true }`.

Recommended resolution: the omitted variant is `{ omitted: true; kind: 'http' | 'message'; status?: number; headers?: [string, string][] }`. Stores persist `resultOmitted: true` and a `result` without `body`. REQ-STORE-10 checks "no body" and that status and headers survive.

**Decision: ACCEPT.** Update the 3.1 signature in requirements.md to match, and add to REQ-STORE-11 that the cap test also verifies the boundary case at `maxResultBytes + 1` produces the omitted form with status and headers intact.

## Q8: precedence between TTL expiry, lease expiry, and fingerprint mismatch (A2)

3.2 gives "expired lease yields acquired" and "different fingerprint yields mismatch regardless of state" without an order.

Recommended resolution: TTL-expired record is absent (D14) and yields `acquired` with fence 1 restarted; otherwise fingerprint mismatch wins over lease state, so a lease-expired record with a different fingerprint yields `mismatch`. Rationale: the draft's 422 rule is about key reuse with a different payload, and the first payload under a key is the truth for the key's lifetime. The contract suite adds two tests: `REQ-STORE-3: lease-expired record with different fingerprint yields mismatch` and `REQ-STORE-7: ttl-expired record with different fingerprint yields acquired`.

**Decision: MODIFY.** The ordering is right: TTL expiry first, then fingerprint, then lease. The fence restart is the change. Do not restart the fence at 1 when the TTL-expired row is still physically present; continue it as `old.fence + 1`. Reason: a handler from the previous TTL epoch can, in principle, still be running (a 24 h TTL is long, a stuck handler is not impossible), and a restarted fence of 1 would let its late `complete` land on the new record. Stores whose native TTL has already deleted the row (DynamoDB, Redis) restart at 1 because there is nothing to continue from, which is safe because native deletion only happens after expiry plus the provider's sweep delay. The single-statement `begin` on D1, Postgres and SQLite computes `fence = COALESCE(existing.fence, 0) + 1` in the conflict branch, so this costs nothing. `REQ-STORE-7` becomes two assertions: ttl-expired row present yields `acquired` with `fence = old + 1`; ttl-expired row absent yields `acquired` with `fence = 1`. The memory store simulates both by exposing a test-only `physicallyRemove(op)`.

## Q9: the 255-byte key limit vector belongs in `profile`, not `core` (A3)

The draft sets no maximum key length. Grading third parties on it contradicts D17.

Recommended resolution: tier `profile`, id `profile/key-too-long`. Gap entry proposes the draft recommend a documented maximum. `core` still has eleven vectors because two draft-derived cases were added instead: `core/mismatch-does-not-poison` (section 2.7, a rejected 422 leaves the original record intact) and `core/header-name-case-insensitive` (section 2.1 via RFC 9110 field name rules). An empty quoted key was considered and rejected as a core vector because the draft does not forbid it.

**Decision: ACCEPT.** Both added core vectors are good. The empty-key decision is also right for `core`; add `profile/empty-key-rejected` so anyonce's own 400 on `""` is still tested, and log it as a draft gap (the draft should say whether an empty key is a key). Move the 255-byte limit from REQ-CONF-3 to REQ-CONF-4 in requirements.md and mark D7's limit as a profile choice.

## Q10: branch coverage cannot come from `bun test --coverage` (A6)

Verified on bun 1.2.21: coverage output has `% Funcs` and `% Lines` columns only; a function with an untaken `if` branch reports 100.

Recommended resolution: `bun run test:coverage` runs vitest with `@vitest/coverage-v8` over `packages/core/src/engine.ts` with `branches: 100` as a threshold; CHECKLIST P1 wording updated to cite that command. All other tests stay on `bun test`.

**Decision: ACCEPT.** Extend the threshold file list to the sf-string parser and the key validator (`packages/core/src/key.ts` or wherever they land): those are the other two places where an untaken branch is a conformance bug. Everything else stays on `bun test`.

## Q11: `withIdempotency` and shared HTTP helpers live in `@anyonce/core/http` (B8)

`@anyonce/webhooks` needs key parsing, problem details, response capture and replay headers but must not depend on `@anyonce/hono`.

Recommended resolution: subpath export `@anyonce/core/http` (Web APIs only, zero deps) holds `withIdempotency` and the helpers; `@anyonce/hono` becomes a thin binding to Hono's context and typing. The 8 KB budget (REQ-REL-5) applies to the root entry; the `http` subpath gets its own 16 KB line. requirements 4.4's "`@anyonce/hono` plus framework-agnostic `withIdempotency`" still holds for users: `@anyonce/hono` re-exports it.

**Decision: ACCEPT.** Update requirements 1.1, 4.4 and REQ-REL-5, and CLAUDE.md's layout block, to name the subpath. Import direction is enforced by a test: `@anyonce/core` root must not import from `./http` (so the queue door never pays for HTTP code), and `@anyonce/hono` and `@anyonce/webhooks` import only from `@anyonce/core` and `@anyonce/core/http`.

## Q12: P4 webhook adapter depends on P2 (C1)

The prompt says P4 depends on P1 only. The webhook receiver returns the same 409, 422 and replay responses as the HTTP adapter and reuses its helpers.

Recommended resolution: P4 starts after P2 merges, in parallel with P3 and P5; its first task is the queue adapter, which truly needs only P1.

**Decision: ACCEPT.** Split P4 into P4a (queue adapter, TS and Go, starts after P1) and P4b (webhook receiver, TS and Go, starts after P2). P4a can run in parallel with P2. Update the phase table in requirements.md section 6 and the parallelism list in prompt.md.

## Q13: REQ-REL-4 "Go latest two minors" versus D19 "latest stable pinned in go.mod"

With `go 1.25.3` pinned in `go.mod`, a Go 1.24 CI runner cannot build the module without toolchain auto-download, so a two-minor matrix is not meaningful until Go 1.26 ships.

Recommended resolution: CI uses `go-version-file: go/go.mod` (one toolchain, the pinned one) in P0. When Go 1.26 is released, `go.mod` moves to `go 1.26` and the matrix gains `1.25.x` as the second entry. Recorded here so REQ-REL-4 is not marked complete on the Go axis until then.

**Decision: REJECT, the premise is stale.** Go 1.26 shipped in February 2026 and is at 1.26.7 as of 19 August 2026; Go 1.27 (generic methods, `encoding/json/v2`, post-quantum crypto) was scheduled for August 2026 and was at rc3 on 13 August. The local toolchain that reported `1.25.3` is two releases behind. Do this instead: run `go version`, upgrade the local toolchain to the current stable from go.dev/dl, and check whether 1.27 final has been tagged. `go.mod` says `go 1.26` (minor only, no patch, no `toolchain` line) so any 1.26+ toolchain builds it without auto-download. CI matrix uses actions/setup-go's `stable` and `oldstable` aliases rather than hard-coded versions, so REQ-REL-4 "latest two minors" is true today and stays true after each August and February release without a PR. D19's "latest stable pinned" is amended to "minimum supported minor pinned in go.mod, latest two tested in CI". Language features from 1.27 (generic methods, json/v2) are not used until 1.27 is `oldstable`, which keeps the module buildable on both matrix entries.

## Q14: core vectors assert application/problem+json, which the draft does not mandate

`core/key-missing-required`, `core/mismatch-422` and `core/concurrent-409` require `Content-Type: application/problem+json`, and `core/get-ignored` asserts the absence of `Idempotency-Replayed`. Draft section 2.7 shows RFC 7807 bodies as one example and a `Link` header as an alternative for all three error cases, so a draft-conformant third party that answers with `Link` and a text body fails three of eleven core vectors, which contradicts D17. REQ-CONF-3 literally says "400 with application/problem+json", so the vectors follow it for now.

Recommended resolution: before the P5 grading run, drop the `Content-Type` assertions from those three core vectors and the `Idempotency-Replayed` absence check from `core/get-ignored` (status plus `handlerInvocations` already prove the behavior; `profile/problem-code-member` covers the anyonce body shape), and keep the media type as a `profile` expectation. Recorded as draft gaps G1 and G2 so S3 can propose that the draft name the media type.

**Decision: ACCEPT, but do it now, not before P5.** Core vectors must never encode a profile choice, even temporarily, because P2 will be built green against them and any later loosening looks like grading on a curve. Change the four vectors in the current P0 branch, fix REQ-CONF-3 to read "400 (status only; body shape is a profile expectation)", and keep `profile/problem-content-type` as the anyonce-only assertion. G1 and G2 stay in `DRAFT-GAPS.md`.

---

## 15. Spec amendments required by these decisions

Apply as the first task of the next plan, one commit, message `docs(spec): apply questions.md decisions Q1-Q14`. Each line names the file and the exact place.

requirements.md
- 0.2 table, IETF row: "editor's copy last committed February 2025 (`dab060c`, draft 06); -07 published October 2025 without a repo commit" (Q1)
- 1.1: add `@anyonce/core/http` subpath to the package list (Q11)
- 2, D7: note "255-byte maximum is a profile choice; the draft sets none" (Q9)
- 2, D9: TS queue default becomes the total definition from Q3 (Q3)
- 2, D14: "Expired records are absent to `begin`; fence continues from the stale row when it is still present" (Q8)
- 2, D19: Go line becomes "minimum supported minor pinned in go.mod (`go 1.26`), latest two minors tested in CI via `stable` and `oldstable`" (Q13)
- 3.1: `complete` result parameter becomes `StoredResult | OmittedResult` with `OmittedResult = { omitted: true; kind; status?; headers? }` (Q7)
- 3.2: add the precedence paragraph: TTL expiry, then fingerprint, then lease; fence continuation rule (Q8)
- 4.2 REQ-STORE-7: split into present-row and absent-row assertions (Q8); REQ-STORE-10 and 11: status and headers survive omission, `maxResultBytes + 1` boundary (Q7)
- 4.4 lead paragraph: `withIdempotency` lives in `@anyonce/core/http`; `@anyonce/hono` re-exports (Q11)
- 4.5: add REQ-Q-8 companion strategy with the three acceptance cases and the lease-respecting retry assertion (Q2); REQ-Q-1 note pointing to `docs/queue-ids.md` (Q4)
- 4.7 REQ-CONF-3: remove "with application/problem+json" and the 255-byte case; add `core/mismatch-does-not-poison` and `core/header-name-case-insensitive` (Q9, Q14); REQ-CONF-4: add `profile/key-too-long`, `profile/empty-key-rejected`, `profile/problem-content-type` (Q9, Q14)
- 4.8: add REQ-DOC-9 `docs/queue-ids.md` (Q4)
- 4.9 REQ-REL-4: Go axis wording per Q13; REQ-REL-5: root 8 KB, `http` subpath 16 KB (Q11)
- 6 phase table: P4 splits into P4a and P4b with the dependencies from Q12

CHECKLIST.md
- Every phase: dash gate command gains `--glob '!docs/reference/**'` (Q5); add "`scripts/doctor.sh` passes" as the first item (Q6)
- P1: branch coverage item cites `bun run test:coverage` (vitest, `@vitest/coverage-v8`, `branches: 100` on engine, key validator, sf-string parser) (Q10)
- P4 splits into P4a and P4b (Q12)

CLAUDE.md
- Layout block: add `packages/core/src/http/` and the `docs/queue-ids.md` file (Q4, Q11)
- Commands: add `bun run test:coverage` and `scripts/doctor.sh`; Go line names the pinned golangci-lint version (Q6, Q10)
- Code rules: add the import-direction rule from Q11

prompt.md
- Phase order and parallelism: P4a after P1 (parallel with P2), P4b after P2 (parallel with P3 and P5) (Q12)
- Step 0 preflight: add "run `go version`; upgrade to current stable before P1" (Q13)

---

## Q15: what `execute` returns when the store fails at `complete`

Requirements 3.3 gives `onStoreError: 'fail-closed' | 'fail-open'` for store failures but names only the `begin` call. A failure at `complete` happens after the handler has already run, so the two modes cannot mean there what they mean at `begin`, and the `ExecuteResult` union has to pick one shape. The same gap covers a `complete` that answers `stale_fence` or `not_found` instead of throwing, and an `abandon` aimed at a record another worker has already completed.

Recommended resolution: a store error at `complete` returns `{ kind: 'executed', stored: false }` in both modes and fires `onStoreError`; `store_error` is returned only when `begin` fails under fail-closed, because by the time `complete` fails the handler has already run and hiding its result behind a 503 would make the client retry work that happened. `abandon` on a completed record returns `not_found`; a `complete` returning `stale_fence` or `not_found` yields `stored: false`.

## Q16: the Go `Execute` has no discriminated union to return

TypeScript's `ExecuteResult` is a five arm union that the HTTP and queue adapters switch on. Go has no union type, so the port needs a rule for which outcomes travel inside the `Result` value and which travel as an `error`, plus the sentinels adapters and stores compare against. Nothing in requirements 3.3 says this, and the Go engine will be written against whatever this file records. Documented only; no TypeScript code follows from it.

Recommended resolution: the Go `Execute` returns `(Result, nil)` for executed, replayed, conflict and mismatch (the `Kind` field is the signal, matching the TS union); it returns `(Result{Kind: ResultStoreError}, err)` with `err` wrapping `ErrStoreUnavailable` for a fail-closed store failure at begin; and `(Result{}, err)` wrapping the handler's error when `run` fails (after abandoning). `ErrConflict`, `ErrMismatch` and `ErrStaleFence` are exported for adapters and stores to use as sentinels.

## Q17: whether `maxResultBytes` measures headers as well as the body

D12 caps a stored result at `maxResultBytes`, and `resultSize` is what decides when `execute` swaps the full result for the omitted form. A `StoredResult` carries a status, a header list and a body, so the cap could be measured over the whole serialized record or over the body alone, and the two answers differ by the header bytes right at the boundary.

Recommended resolution: `resultSize` is the body byte length only; headers are allowlisted and small, and the cap exists to bound stored bodies (D12).

## Q18: REQ-HTTP-5 needs a problem code that D11 does not list

REQ-HTTP-5 says a missing principal under `requirePrincipal` is a 500 configuration error, and REQ-HTTP-13 says every error is a problem details document with a stable code, but D11's code list has no entry for it.

Recommended resolution: add `missing-principal` (500) to the D11 list and to `docs/problems.md`. A `requirePrincipal: true` configuration without a `principal` function fails at construction (`resolveHttpOptions` throws, Go `httpmw.New` panics), which is the "startup-time check where possible" half of the requirement; the request-time half returns the new problem.

**Decision: pending.** P2 proceeds on the recommendation.

## Q19: when a streamed HTTP result completes, and what a stalled client costs

REQ-HTTP-7 says the response streams to the client while a copy is buffered, and the record completes with the captured result. The first P2 capture read the handler's stream as fast as it could, so the record completed regardless of the client and a slow client could hold the whole body in memory. The whole-branch review asked for backpressure.

Recommended resolution: the capture is pull driven. The handler's stream is read at the client's pace, the record completes only when the client has received the whole body (or cancelled, after which the remaining bytes are drained for the store), and the client sees EOF only after the record is complete. Consequences, to be documented in `docs/semantics.md` (P6): a duplicate that arrives while the first client is still receiving the body gets 409 with Retry-After, not a replay; a client that stalls without cancelling holds the claim until the lease expires, at which point a retry takes over the claim. Go behaves the same way for bodies large enough to block on the socket (the handler writes to the connection and the record completes when the handler returns); a small body fits the server buffer, so a Go record can complete before the client has read anything.

**Decision: pending.** P2 proceeds on the recommendation.

## Q20: DynamoDB's 400 KB item limit against the 1 MiB round trip in REQ-STORE-11

REQ-STORE-11 asks every store to round trip a body of exactly `maxResultBytes` (1 MiB). A DynamoDB item is capped at 400 KB including attribute names, so no single-item design can hold it. D1 rows and SQLite-backed Durable Object values allow 2 MB, Redis and Postgres allow far more, so DynamoDB is the only store affected.

Recommended resolution: the contract suite reads the cap from the harness (`StoreHarness.maxResultBytes`, Go `Harness.MaxResultBytes`, default 1 MiB) and the DynamoDB harness declares 300 KiB. `docs/stores.md` records the DynamoDB cap, and the adapter option `maxResultBytes` must be set to at most 300 KiB when the DynamoDB store is used; larger results are stored in the omitted form (status and headers replay, body does not), which is the D12 degradation, not a failure. Chunking bodies across items was considered and rejected: it makes the replay read non atomic across items, multiplies write cost, and serves a case the omitted form already handles honestly.

**Decision: pending.** P3 proceeds on the recommendation.

## Q21: `purge` on stores with native TTL

REQ-STORE-7 says `purge(now)` returns the count removed and the contract suite asserted a count above zero, while REQ-ST-DDB-1 and REQ-ST-REDIS-1 say `purge` is a no-op that returns 0 because the backend sweeps expired rows itself. Both cannot hold for the same store.

Recommended resolution: the contract suite takes `nativePurge: true` in its options (Go `Harness.NativePurge`) for DynamoDB and Redis. Under that option the suite still requires logical expiry on read (`get` returns null and `begin` acquires after `expires_at`) and only drops the removed-count assertion; `purge` returns 0 and `docs/stores.md` says so in the native TTL column. Stores without native TTL (Postgres, D1, SQLite, memory, Durable Objects from the Worker side) keep the count assertion. REQ-STORE-7's wording is read as "returns the count this call removed", which is 0 when the backend already did the work.

**Decision: pending.** P3 proceeds on the recommendation.

Amendment recorded in P3: REQ-ST-REDIS-1 said `PEXPIREAT`, but both Redis stores set a relative `PEXPIRE` of the TTL plus the grace because the logical clock is injected and an absolute wall-clock deadline cannot be derived from it, so the requirement text and the `nativePurge` doc comment now say `PEXPIRE` (relative to the write, plus a grace).

## Q22: the DynamoDB item key put a whole route on one partition

The first P3 DynamoDB store keyed an item by `pk = scope`, `sk = key`. D8's default scope is the method plus the route pattern, so every claim for one HTTP route shares a partition key, and DynamoDB caps a single partition at roughly 1000 writes per second however large the table is. A busy endpoint would throttle on the partition rather than on the table's capacity. The sort key bought nothing in return: the stores only ever address one item at a time, by scope and key, and never `Query` a scope.

Recommended resolution: one partition key, `pk = scope + <unit separator> + key`, and no sort key. `ensureTable` and `EnsureTable` create `pk` (S) as the only key; `itemKey`/`ItemKey` compose it and the row decoder splits on the first separator, which a scope never contains. Every claim is then a point write on its own partition and the table spreads across partitions the way DynamoDB expects. `docs/stores.md` records it in the Setup and Cost cells.

**Decision: pending.** P3 proceeds on the recommendation.

## Q23: REQ-WH-2 and D16 need problem codes that D11 does not list

REQ-WH-2 returns a "500 `configuration-error`" when the receiver has neither a `verify` callback nor a `verifiedMarker`, and D16 says an unverified request never reaches the store without naming the status a failed verification returns. D11's catalogue has neither code, and REQ-HTTP-13 says every error is a problem details document with a stable `code`. Separately, the D11 titles name the `Idempotency-Key` header, which is the wrong header to name to a webhook sender that sent `webhook-id`.

Recommended resolution: add two codes to D11, to `packages/core/src/http/problems.ts`, to the Go catalogue and to `docs/problems.md`. `configuration-error` (500) is the REQ-WH-2 answer. `signature-invalid` (401) is the answer when `verify` returns false or the `verifiedMarker` is absent: 401 rather than 403 because the sender did present a credential (a signature) and it did not verify, which is what the Standard Webhooks ecosystem returns. Neither code is reachable from the HTTP door, so the HTTP door's behaviour does not change. For the titles, add an optional `problemTitles` map to the HTTP options (Go `Options.ProblemTitles`) that overrides a title per code without touching the status or the code, and let `@anyonce/webhooks` and `webhookmw` set titles that name `webhook-id`.

**Decision: pending.** P4b proceeds on the recommendation.

## Q24: what `sourceId` is in D8's webhook scope

D8 gives the webhook adapter the scope `${routePattern}/${sourceId}` and never says where `sourceId` comes from. REQ-WH-1's `verify` returns a boolean, so verification yields no sender identity, and the REQ-WH-6 helper `standardWebhooksVerify(secret)` identifies an endpoint (one secret per receiving endpoint), not a sender.

Recommended resolution: `sourceId` is the verified sender identity when the deployment can produce one, and the receiver takes it as an option, `sourceId?: (req, body) => string | undefined` (Go `Options.SourceID func(*http.Request, []byte) string`). The default scope is `${routePattern}/${sourceId}` when that function yields a non-empty value and `${routePattern}` alone when it does not, because inventing a constant source segment would be noise in every stored row. `routePattern` is the `routePattern` option when given, otherwise the request pathname (Go `r.URL.EscapedPath()`), which mirrors the HTTP door's D8 fallback. A multi-tenant receiver that maps a signature or a path segment to a tenant passes `sourceId` and gets per-tenant replay isolation; `docs/security.md` (P6) records that a shared endpoint without a `sourceId` shares one dedupe namespace across senders.

**Decision: pending.** P4b proceeds on the recommendation.

## Q25: whether D7's key rules apply to a webhook id, and what a verified request with no id gets

The webhook door's key is a `webhook-id` header value or a body-derived id (REQ-WH-1), not an `Idempotency-Key`. D7 defines key syntax (lenient or strict RFC 9651 sf-string, 255 bytes, printable ASCII) for the HTTP door. Nothing says whether a webhook id is validated the same way, and REQ-WH-1 does not say what happens when a request verifies but carries no id.

Recommended resolution: the length and charset half of D7 applies, because the id becomes the store key and every store has to hold it: the id goes through the lenient parser (1 to 255 bytes, printable ASCII, surrounding quotes stripped), and an id that fails is 400 `invalid-key`. The strict sf-string mode is not offered on the webhook door, because `webhook-id` is not a structured field and no sender quotes it. `required` defaults to true on the webhook door (it defaults to false on the HTTP door per REQ-HTTP-3), so a request that verified and carries no id and no `key` function result is 400 `missing-key`: a verified sender with no id is a sender bug and silently passing it through would run the handler on every redelivery.

**Decision: pending.** P4b proceeds on the recommendation.

## Q26: REQ-WH-2 says the receiver logs once, and P2 decided the adapters never log

REQ-WH-2 says the middleware "returns 500 `configuration-error` at first request and logs once". The P2 plan's constraints say nothing in `packages/core`, `packages/hono` or `go/httpmw` logs at all, and NFR-2 plus the CI key-log gate police what may appear in a log line.

Recommended resolution: the no-logging rule stays for `@anyonce/core`, `@anyonce/hono` and `go/httpmw`. `@anyonce/webhooks` and `go/webhookmw` log exactly once per receiver instance, and only for the configuration error, through an injectable sink (`logger?: (message: string) => void`, default `console.error`; Go `Logf func(format string, args ...any)`, default `log.Printf`) so the tests assert the message without capturing stderr. The message is a fixed string that names the two options and carries no request data, no header value and no key, so the key-log gate stays green and NFR-2 is unaffected. No other code path in either package logs.

**Decision: pending.** P4b proceeds on the recommendation.

## Q27: the anyhook signer is available in both languages for the REQ-WH-6 interop test

The interop test signs with anyhook and receives with anyonce. Checked on 18 September 2026: `npm view @anyhook/signing version` reports 0.2.2, and `https://proxy.golang.org/github.com/sns45/anyhook/go/@latest` reports `v0.2.1` (tag `go/v0.2.1`, commit `a08fd47`). Both match `docs/reference/anyhook-signing.md`, so no reimplementation of the signer is needed in either language. The Go side still has a packaging question: CLAUDE.md says the Go module's only third-party dependencies are the store clients and `modernc.org/sqlite`, and a test-only require would still land in the published `go/go.mod` and `go/go.sum`.

Recommended resolution: TypeScript adds `@anyhook/signing@0.2.2` as a devDependency of `packages/webhooks` (a devDependency is not a published dependency, so D21 is unaffected). Go puts the interop test in a nested, test-only module `go/webhookmw/interop` with its own `go.mod` requiring `github.com/sns45/anyhook/go v0.2.1`, so `github.com/sns45/anyonce/go` keeps the dependency set CLAUDE.md names and `go build ./...` in `go/` never sees it; the existing `go` CI job gains one step that runs `go test -race ./...` inside that directory. anyonce still imports nothing from anyhook at runtime.

**Decision: pending.** P4b proceeds on the recommendation.

## Q28: which conformance vectors apply to the webhook door

The webhook receiver is an HTTP door built on `runIdempotent`, so the replay, 409 and 422 vectors should hold for it, but the suite was written for the `Idempotency-Key` door and the runner drives fixture control paths (`POST /reset`, `GET /counter`) that a receiver with `required: true` would answer 400.

Recommended resolution: P4b runs the whole suite through the receiver in both languages with `idHeader` set to `Idempotency-Key`, `verify` returning true (the vectors carry no signatures, and the gate is proven by its own tests), `required: true`, and a `skip` predicate for the runner's control paths `/reset` and `/counter` so the runner can reset and read the counter. Every vector that does not pass is listed in `conformance/README.md` with the reason it does not apply to this door, and is never made to pass by weakening the receiver. The expectation recorded up front is that all core and all profile vectors pass, because the receiver changes only where the key comes from, what the scope is and what runs before the store.

**Decision: pending.** P4b proceeds on the recommendation.
