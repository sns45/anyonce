# anyonce design note (Step 1, bounded brainstorm)

Date: 2026-09-16. The design is `requirements.md`; this note does not restate it. It records what a section walk surfaced in three buckets: internal contradictions, information missing for a plan, and risks that change sequencing. Each item names the sections involved and the default the work proceeds on. Items that need Shantanu's confirmation are mirrored in `docs/superpowers/questions.md`.

## A. Internal contradictions

| # | Sections | Contradiction | Default we proceed on |
|---|---|---|---|
| A1 | 3.1 `Store.complete` signature vs D12 and REQ-HTTP-9 | `complete(op, fence, { omitted: true }, now)` carries no status or headers, but an omitted-body replay must return the original status and headers. | The omitted branch carries them: `{ omitted: true; kind; status?; headers? }`. The record stores `resultOmitted: true` and a `result` without `body`. REQ-STORE-10 "no body" still holds. Q7. |
| A2 | 3.2 rules 1 and 4, D5, D14 | "begin on expired-lease in_flight yields acquired" and "begin on any record with a different fingerprint yields mismatch regardless of state" both claim a lease-expired record with a different fingerprint. TTL expiry vs mismatch has the same overlap. | Precedence: TTL-expired record is absent (D14), then fingerprint check, then lease check. So lease-expired plus different fingerprint is `mismatch`; TTL-expired plus anything is `acquired`. The contract suite gets one test per ordering. Q8. |
| A3 | REQ-CONF-3 vs D17 | The 255-byte key limit is anyonce's (D7), not the draft's, yet the vector sits in the `core` tier that third parties are graded on. | Move "key exceeding 255 bytes" to `profile`. It stays a gap entry in `DRAFT-GAPS.md` proposing the draft define a maximum. Q9. |
| A4 | REQ-WH-3 parenthetical vs D6 | "always 2xx by construction since only < 500 is stored" is wrong: 4xx is stored under the D6 default. | Behavior follows D6 (a stored 4xx replays as 4xx). The parenthetical is treated as an explanatory slip; the webhook docs say "2xx in practice because receivers respond 2xx". No question needed. |
| A5 | CLAUDE.md layout vs requirements 4.2 AC | Go store contract suite is `anyonce/storetest` in the AC and `go/storetest` in the layout. | Import path `github.com/sns45/anyonce/go/storetest` per the layout; the AC wording is read as the package name. |
| A6 | CHECKLIST P1 vs bun | "Engine branch coverage 100% (TS via `bun test --coverage`)": bun 1.2.21 reports functions and lines only. Verified locally: a half-covered `if` reports 100. | Branch coverage for `packages/core/src/engine.ts` is measured with vitest plus `@vitest/coverage-v8` (already in the stack for Workers tests) under `bun run test:coverage`; `bun test` remains the runner for everything else. Q10. |

## B. Missing information needed to write the P0 plan

| # | Section | Gap | Default we proceed on |
|---|---|---|---|
| B1 | REQ-CONF-1 | `Step` has `concurrentWith?: stepId[]` and `bodyEquals: { sameAs: stepId }` but no `id` field. | Every step has a required `id` (string, unique within the vector). |
| B2 | REQ-CONF-1, REQ-CONF-3 | The expiry vector needs time to pass; the schema has no delay field and no way to say a vector needs a fixture capability. | `Step.delayMs?: number` (wait before sending) and vector-level `requires?: string[]` (for example `["short-ttl"]`). The runner skips vectors whose requirements the target does not declare and reports them as `not-applicable`, never as a pass or fail. Third parties are graded on applicable `core` vectors only. |
| B3 | REQ-CONF-2, REQ-CONF-3 | How the implementation under test is told to use a short TTL. | Reference fixture apps read `ANYONCE_TTL_MS` (default 2000 in conformance mode). The runner's `--capability short-ttl --ttl-ms 2000` flags declare it. The expiry vector waits `ttl + 500`. |
| B4 | REQ-CONF-1 `handlerInvocations` | Only `/echo` increments the counter, so invocation counts on `/status`, `/slow`, `/large` are unobservable. | Every POST fixture increments the same counter; `GET /counter` returns `{"count": n}`; `POST /reset` zeroes it. |
| B5 | REQ-CONF-3 "key on GET is ignored" | Whether GET with a key must execute (no dedupe) or may dedupe. | Core vector expects two GETs with the same key both execute (counter increments twice) and no `Idempotency-Replayed` header; `draftRef` cites section 1 (non-idempotent methods). |
| B6 | Section 7 item 1, CLAUDE.md `test:reqs` | Which REQ ids are "in this phase's scope" for the coverage check. | `scripts/reqs.ts` parses `requirements.md` for every `REQ-*` and `NFR-*` id and the phase table in section 6; it fails on any id of a completed or current phase that has no test whose name starts with it, across `bun test` names and `go test -list`. |
| B7 | D19, REQ-REL-4 | CI provider. | GitHub Actions, one workflow per language plus `vectors-validate`, `services` for the five containers. |
| B8 | 4.4 header, D21 | Where the framework-agnostic `withIdempotency` and the shared HTTP pieces (key parsing, problem details, response capture, replay headers) live. The webhook receiver needs all of them but must not depend on `@anyonce/hono`. | They live in `@anyonce/core` under the subpath `@anyonce/core/http` (Web APIs only, zero deps). `@anyonce/hono` and `@anyonce/webhooks` both import it. The 8 KB budget applies to the root entry; the `http` subpath gets its own budget line (16 KB) in `bun run size`. Q11. |
| B9 | REQ-Q-2, REQ-Q-4, REQ-Q-1 | Already resolved from source in `docs/reference/anyq-interfaces.md`: dead-letter and delay are strategy decisions, TS has no raw body bytes, message ids are always present. | Q2, Q3, Q4 in `questions.md`. |

## C. Risks that change sequencing

| # | Risk | Effect on the phase order in the prompt |
|---|---|---|
| C1 | The webhook door is the HTTP door plus a verification gate and a key source (D16, REQ-WH-3..5 return the same 409, 422, replay responses). It cannot be built on P1 alone. | P4 webhook half depends on P2, not P1. Queue half depends on P1 only. P4 starts after P2 alongside P3 and P5; the queue adapter can be its first task so the P1-only claim still holds for that piece. |
| C2 | P5 runs third-party implementations in Docker; CLAUDE.md forbids network fetches in CI beyond registries and local containers. | P5 Dockerfiles install pinned versions from npm and the Go proxy only (`hono-idempotency@0.9.0`, `idempo`, Fiber), never `git clone`. Image tags recorded in `REPORT.md`. No order change, but P5's first task is the three Dockerfiles. |
| C3 | Durable Objects and D1 tests need `@cloudflare/vitest-pool-workers` and `wrangler`; the DO store race test runs inside workerd. | P0 installs the workers test pool and proves one trivial workerd test in CI so P3's DO and D1 PRs do not discover toolchain problems. Adds one P0 task. |
| C4 | The `bun test` REQ-STORE-8 race relies on real concurrency in the store. Memory stores are single-threaded; the race is a check of the `begin` code path ordering, not of I/O. | No order change. The memory store test is still required (it catches async get-then-set bugs). Real races are proven per store in P3. |
| C5 | Deno 2.7.3, Node 22.17, Bun 1.2.21, Go 1.25.3, Docker 28 are present locally; golangci-lint is not. | Install golangci-lint before P1's Go gate (Q6). |
| C6 | `@anyonce/core/testing` (store contract suite) is exported from core but must use a test runner API. Bun and vitest share `describe`/`it`/`expect` shapes only loosely. | The suite takes an injected `{ describe, it, expect }` triple so it runs under bun, vitest, and vitest-pool-workers unchanged. Decided in P1's plan, no order change. |

## D. What is not in question

Everything in section 2 (D1..D22) proceeds as written. No alternative architecture is proposed. The name checks passed (`docs/reference/preflight.md`), so D1 needs no fallback.
