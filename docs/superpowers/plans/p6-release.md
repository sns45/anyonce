# P6 Docs, Examples, Benchmarks and Release Dry Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish v1's documentation surface (README, `docs/semantics.md`, `docs/conformance.md`, `docs/security.md`, a checked `docs/stores.md` and `docs/problems.md`, `llms.txt`), ship the six examples REQ-DOC-7 names with a smoke test each run in CI, measure NFR-1 in `benchmarks/` and publish the numbers in the README, and prove the 0.1.0 release end to end as a dry run (changesets version plan, build, pack every package, `go mod tidy` clean, forgeseal SBOM plus signature for every tarball) with a release workflow that only runs on a tag or a manual dispatch. Seven carried items from earlier phases are folded in.

**Architecture:** P6 adds no semantics to any door. Docs are prose plus tests that pin the load-bearing sentences and every link. Examples live under `examples/<name>/`, each a small real program with a README and one smoke test; the four TypeScript examples are workspace members so they resolve `@anyonce/*` from `dist`, the two Go examples are nested modules with a `replace` onto `../../go` so the published module's `go.mod` is untouched. One new CI job, `examples`, brings up only the compose services the examples need (DynamoDB Local and Postgres) and runs all six. The benchmark is an in-process harness over the memory store; the README gets its numbers between markers written by the script. The release dry run is a script that works on a throwaway copy of the tree so nothing it does (consuming changesets, rewriting versions) lands on the branch; `.github/workflows/release.yml` holds the real steps behind tag and dispatch triggers only.

**Tech Stack:** Bun 1.4.2 local and CI, TypeScript 5 strict, Biome 2, tsup, changesets 3 (`@changesets/cli` ^3.0.3), vitest 3.2.7 with `@cloudflare/vitest-pool-workers` 0.12.21 for the Worker example, wrangler 4, Hono 4, `@anyq/core` and `@anyq/memory` 0.5.0, `@anyhook/signing` 0.2.2 (dev only), `@aws-sdk/client-dynamodb` v3, Go 1.26 (`stable` and `oldstable` in CI), `github.com/sns45/anyq/go` v0.5.0, pgx v5, forgeseal v0.5.1 (`go install github.com/sns45/forgeseal/cmd/forgeseal@v0.5.1`), cosign is not used.

**Spec:** `requirements.md` sections 1.1 (examples and docs lists), 1.2 (honest limits), 4.4 REQ-HTTP-17 (Worker and Lambda examples pass the URL-mode runner), 4.5 REQ-Q-8 (README and examples clause), 4.8 (REQ-DOC-1 to REQ-DOC-9), 4.9 (REQ-REL-1 to REQ-REL-5), 5 (NFR-1 to NFR-6), 6 (P6 row), 7; `docs/superpowers/questions.md` Q3 (verbatim sentence), Q4 (README producer key sentence), Q19 (streaming consequences for `docs/semantics.md`), Q24 (shared endpoint note for `docs/security.md`), Q40 (park stable key source in the queue examples), and the new Q60 to Q65; `CHECKLIST.md` "Every phase" and "P6 docs, examples, release".

## Global Constraints

- No em or en dashes (U+2013, U+2014) anywhere: prose, comments, YAML, shell, commit messages, PR bodies, generated README blocks. Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing. Never type a `\uXXXX` escape in a tool parameter; use `\x` or named escapes.
- Every test name starts with the REQ or NFR id it proves (`REQ-DOC-7: ...`, Go `TestREQ_DOC_7_...` or `t.Run("REQ-DOC-7: ...")`). P6 scope is DOC-1..9, REL-1..5, NFR-1..6 plus every earlier phase; `bun run test:reqs` gains `--phase p6` only in Task 9.
- Never log a full key; `redactKey()` (first 8 chars plus `…`) only. Examples log nothing that contains a key. Key-log gate: `rg -n 'console\.(log|info|warn|error)\(.*key' packages go` stays empty, and Task 5 extends the gate to `examples`.
- No external action: no `npm publish`, no Go tag push, no GitHub release, no filing of `conformance/issues/` drafts, no posts anywhere, no Sigstore keyless signing from this machine (it writes to the public Rekor log, Q61). The release workflow file may exist but triggers only on `push: tags` and `workflow_dispatch`, never on a branch push.
- No network in tests or CI beyond package registries (npm, `proxy.golang.org`) and the local compose stack (`test/compose.yml`: DynamoDB Local on 18000, Redis 6379, Postgres 15432, Redpanda 9092, ElasticMQ 9324).
- `@anyonce/core` keeps zero `dependencies`; no published package gains a runtime dependency. Examples and benchmarks may depend on anything already in the workspace plus the store client they demonstrate.
- TypeScript: strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, no `any` outside test fakes, ESM source. Biome clean.
- Go: standard library first; the published module `github.com/sns45/anyonce/go` gains no requirement; nested example modules use `replace github.com/sns45/anyonce/go => ../../go`. No cgo. `%w` wrapping, doc comments on exported identifiers, `go vet`, `go test -race`, `golangci-lint run` (v2.13.2) clean; engine coverage gate `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh` stays 100 percent. Run Go as `GOROOT= /opt/homebrew/bin/go <verb> -C go ./...`; golangci-lint as `GOROOT= sh -c 'cd go && golangci-lint run'`.
- Concurrency tests never sleep to pass: barriers only (`Promise.all` with a start gate, Go `sync.WaitGroup` plus a channel gate).
- Git from the worktree root as plain single commands (no `cd`, no `&&` between git commands, no `-C`). Conventional commits (`docs: ...`, `feat(examples): ...`, `test(go): ...`, `ci: ...`, `build(release): ...`).
- Build before tests: `bun install`, `bun run build`; workspace packages resolve through `dist`.
- Public API changes need a changeset (`bunx changeset`). Only Task 8 expects one.

## Review Focus

- A README or llms.txt that names an export, option or Go identifier that does not exist: every code identifier listed in `llms.txt` and every import in a README code block must resolve (Tasks 6, 3).
- An example that passes its smoke test only because the test reaches around the example (imports internals, sets a different option than the README shows): each smoke test drives the example's own exported entry with the README's configuration (Tasks 4, 5).
- A benchmark assertion that flakes on a slow shared runner: the NFR-1 test compares medians of wrapped against bare over the same process and asserts the difference only, with the spec's 2 ms threshold and no tighter one (Task 7).
- A packed tarball whose manifest still says `workspace:` or lacks `types`, `exports`, `sideEffects: false`: the dry run inspects every tarball's `package/package.json` (Task 8).
- A release workflow that could publish from a branch push, or that publishes without provenance: the workflow shape test pins triggers, `id-token: write` and `--provenance` (Task 8).

## Decisions taken in this plan (not spec changes)

- **The dry run never commits a version bump.** `scripts/release/dry-run.ts` exports the tree with `git archive HEAD` into a temporary directory and runs `bunx changeset version`, `bun install`, `bun run build`, `bun pm pack` for every package, `go mod tidy -diff`, and forgeseal there. The version commit belongs to the release PR the owner opens after an explicit go, so later fixes and P7 changesets still land in 0.1.0 (Q65).
- **Tarballs are packed with `bun pm pack`, and peers use `workspace:^`.** `npm pack` leaves `workspace:*` in the packed manifest (verified locally on `@anyonce/hono`), which would publish an uninstallable peer range; `bun pm pack` rewrites the protocol. `workspace:^` makes the rewritten peer `^0.1.0` rather than an exact pin. Publishing uses `npm publish <tarball> --provenance --access public` so provenance still comes from npm (Q60).
- **Dry run signing is keyed, release signing is keyless.** `forgeseal ca init` creates a throwaway CA inside the temp directory, `forgeseal sign --keyed` signs each tarball's SBOM and the tarball, `forgeseal verify` checks them. The workflow uses keyless Sigstore under GitHub OIDC on a tag (Q61).
- **One new CI job, `examples`.** Only one phase runs at a time now, so `test/ci.test.ts`'s job list is edited directly. The job starts `docker compose -f test/compose.yml up -d --wait dynamodb postgres`, sets up Bun and Go, builds, and runs `bun run test:examples` plus the two Go example modules with `ANYONCE_REQUIRE_SERVICES=1` semantics (skips fail).
- **The Worker example is tested in workerd, the Lambda example over a real socket.** REQ-HTTP-17's AC: the Worker example runs the conformance runner in-process under its own vitest-pool-workers config (`examples/worker-hono-do/vitest.config.ts`); the Lambda example's smoke test serves the handler through a local function URL harness (`Bun.serve` translating HTTP to a payload v2 event and back) and runs the URL-mode runner against it with the DynamoDB store on DynamoDB Local.
- **The Lambda adapter is ten lines in the example, not a dependency.** The example converts the function URL event to a `Request` and the `Response` back to the function URL result itself; no `aws-lambda` types package, no Lambda Web Adapter.
- **The benchmark is in-process** (Q63): `withIdempotency` around a trivial handler with the memory store against the same handler bare, fresh key per iteration (first-execution path) and a fixed key (replay path), p50 and p99 of each, overhead is wrapped minus bare. The README table names the machine and Bun version.
- **README conformance badge and case study link** (Q62): the badge is a static shields.io image whose text is asserted against `conformance/results/` by a test and which links to `conformance/REPORT.md`; the case study link points at `https://in8.sh/anyonce` and says it goes live at launch (P7).
- **Carried items.** (1) `go/anyqmw/memory_test.go` stop-while-running flake: Task 1. (2) Go bridge duplication `httpmw` and `webhookmw`: Task 1 consolidates into `go/internal/httpx` whatever is byte-for-byte shared, and rules on anything that is not. (3) REQ-Q-8 README and examples clause: Tasks 5 and 6. (4) wrangler readiness hardening: Task 2. (5) Workers `waitUntil` note: Task 3. (6) `RunContext` additions: already landed in P4b (`keyLookup`, `body` in `packages/core/src/http/run.ts`); Task 3 documents them in `docs/semantics.md`'s adapter section, no code. (7) D1 and DO workers flake: Task 2. The `issueLink` filed-URL branch waits for the S4 go and is not in P6.

## File Structure

```
go/anyqmw/memory_test.go                       barrier before run.stop (carried 1)
go/internal/httpx/*.go, go/httpmw/*.go,
  go/webhookmw/*.go                            shared bridge code moves into httpx (carried 2)
go/internal/nocgo/nocgo_test.go                NFR-5: no non-standard package in the module graph has cgo files
go/internal/pkgdoc/pkgdoc_test.go              REQ-REL-3: every package in the module has a package doc comment
scripts/report/collect.ts, scripts/report.test.ts   wrangler readiness hardening (carried 4)
test/workers/vitest.config.ts, docs/stores.md  D1 and DO flake note or reduction (carried 7)
docs/semantics.md docs/conformance.md docs/security.md   new (DOC-2, DOC-5, DOC-6)
docs/stores.md docs/problems.md                checked and completed (DOC-3, DOC-4)
test/docs.test.ts                              DOC-2..6 content and link checks, NFR-6 dash scan
examples/worker-hono-do/                       Hono + DurableObjectsStore Worker, README, vitest workers smoke
examples/lambda-fetch-dynamodb/                function URL handler, withIdempotency + DynamoDbStore, README, bun smoke
examples/go-net-http-postgres/                 nested Go module, httpmw + store/postgres, README, go test smoke
examples/webhook-receiver-standard-webhooks/   webhookReceiver + standardWebhooksVerify, README, bun smoke
examples/anyq-consumer-ts/                     idempotent + idempotencyStrategy on @anyq/memory, README, bun smoke
examples/anyq-consumer-go/                     nested Go module, anyqmw.Wrap + anyqmw.Strategy, README, go test smoke
examples/examples.test.ts                      REQ-DOC-7 inventory: six dirs, README each, smoke each, CI runs each
README.md                                      DOC-1, bench block between markers
llms.txt                                       DOC-8
test/readme.test.ts                            DOC-1, DOC-8 (exports exist), REQ-Q-8 README clause
benchmarks/http-overhead.ts                    the harness and README writer (`bun run bench`)
benchmarks/http-overhead.test.ts               NFR-1 threshold on the running machine
scripts/release/dry-run.ts                     the dry run (`bun run release:dry-run`)
scripts/release/manifest.ts                    pure checks over a packed manifest
scripts/release.test.ts                        REL-1, REL-2, NFR-3 manifest checks, release.yml shape
.github/workflows/release.yml                  tag and dispatch only
.github/workflows/ci.yml, test/ci.test.ts      `examples` job
package.json                                   workspaces, scripts test:examples, bench, release:dry-run, test:reqs
```

---

### Task 1: Go hygiene: the anyqmw flake, the bridge consolidation, NFR-5 and REL-3 tests

**Files:**
- Modify: `go/anyqmw/memory_test.go` (around the `REQ-Q-8: with the strategy configured, an in-flight duplicate parks...` subtest, line 139 `st := run.stop(t)`), and any sibling subtest with the same shape
- Modify: `go/internal/httpx/`, `go/httpmw/`, `go/webhookmw/`
- Create: `go/internal/nocgo/nocgo_test.go`, `go/internal/pkgdoc/pkgdoc_test.go`

**Interfaces:**
- Consumes: the existing harness in `go/anyqmw/harness_test.go` (`start`, `drive`, `driven`, `newSignal`, `newInner`).
- Produces: nothing public; `httpmw` and `webhookmw` exported APIs are unchanged (a diff of `go doc -all` for both packages before and after is empty and goes in the report).

- [ ] **Step 1: Reproduce the flake.** Run `GOROOT= /opt/homebrew/bin/go test -C go -race -count=200 -run 'TestMemory' ./anyqmw/` (adjust the `-run` pattern to the test's real top-level name). Record the failure count and message in the report. The race: `in.ran.wait(t, 1, ...)` returns as soon as the inner handler has started, `run.stop(t)` then stops the consumer while the wrapped handler is still between `run` and `complete`, so `wantParked` can observe a record that is still in flight.
- [ ] **Step 2: Fix with a barrier.** Wait for the delivery to settle (the `settled` signal the `drive` helper already fires after the wrapped handler returns and the message is acked) before `run.stop(t)`: `in.ran.wait(t, 1, "inner handler calls")`, then `settled.wait(t, 1, "settled deliveries")`, then `run.stop(t)`. Count the settles the test really expects (the original delivery that parked plus the redelivery). Apply the same ordering to every subtest in the file that stops while a handler can be running. No `time.Sleep`.
- [ ] **Step 3: Prove it.** `-count=500 -race` on the same pattern: 0 failures. Paste the output.
- [ ] **Step 4: Bridge consolidation.** List every function, type and constant in `go/httpmw/*.go` and `go/webhookmw/*.go` (non-test) whose body is identical or differs only in identifiers. Move each identical one into `go/internal/httpx` (with a test there if it lacks one, named for the REQ it serves, for example `TestREQ_HTTP_10_...`), and call it from both. Leave in place anything whose behavior differs between the doors (key source, verification gate, problem titles) and write one line per such item in the report saying why. Nothing exported from `httpmw` or `webhookmw` changes name or signature.
- [ ] **Step 5: NFR-5 test.** `go/internal/nocgo/nocgo_test.go`, package `nocgo`, test `TestNFR_5_NoNonStandardPackageInTheModuleGraphHasCgoFiles`: run `go list -deps -json ./...` from the module root (find it with `go env GOMOD` via `exec.Command`, use the `go` binary from `runtime.GOROOT()/bin/go` falling back to `PATH`), decode the stream, fail listing every package with `Standard == false` and `len(CgoFiles) > 0`. The standard library is excluded because `net` and `os/user` carry cgo files that `CGO_ENABLED=0` disables.
- [ ] **Step 6: REQ-REL-3 test.** `go/internal/pkgdoc/pkgdoc_test.go`, test `TestREQ_REL_3_EveryPackageHasAPackageDocComment`: walk the module (skip `testdata`, directories with only `_test.go` files, and `webhookmw/interop` which is its own module), parse each package with `go/parser` `ParseDir` in `ParseComments` mode, and require at least one file whose `Doc` comment starts with `Package <name>` (or `Command <name>` for `package main`). Add missing doc comments where it fails.
- [ ] **Step 7: Gate.** `go build`, `go vet`, `go test -race ./...`, golangci-lint, `CGO_ENABLED=0 go build ./...`, and the engine coverage script, all clean. Commit per step group: `test(go): REQ-Q-8 wait for the settled delivery before stopping the memory consumer`, `refactor(go): move the shared door helpers into internal/httpx`, `test(go): NFR-5 and REQ-REL-3 module graph and package doc checks`.

### Task 2: Report tooling hardening: wrangler readiness and the workers flake

**Files:**
- Modify: `scripts/report/collect.ts`, `scripts/report.test.ts`
- Modify: `test/workers/vitest.config.ts` (comment only unless a reduction is found), `docs/stores.md` (a known-issues line under the D1 and DO rows) or `packages/stores/workers/*.test.ts`

**Interfaces:**
- Consumes: the existing `WRANGLER_READY_TIMEOUT_MS`, the readiness line parser and the `workerd-url` rows in `scripts/report/rows.ts`.
- Produces: `bun run report` unchanged for callers; the workerd rows fail with a clear message instead of hanging, and have a second readiness path.

- [ ] **Step 1: Failing tests.** In `scripts/report.test.ts` add pure-function tests around the readiness logic, with the logic factored into an exported function that takes the line stream and a probe function as parameters so no process is spawned in the unit test:
  - `REQ-CONF-8: wrangler readiness accepts the Ready line with or without SGR escapes`
  - `REQ-CONF-8: wrangler readiness falls back to an HTTP probe of GET /counter once the port is announced but the Ready line never comes`
  - `REQ-CONF-8: wrangler readiness fails fast with the output tail when wrangler exits first`
  The HTTP probe is a bounded retry loop driven by responses (`GET /counter` answering 200 ends it), with the attempt count and interval as parameters; the unit test injects a fake fetch that answers 503 twice then 200, so no timer-based wait is needed to pass.
- [ ] **Step 2: Implement** the exported `waitForWorkerReady(lines, probe, opts)` and use it in the collector. Keep the existing timeout as the overall ceiling. A Miniflare fallback is not added: the probe is the sturdier signal, and Miniflare would be a second runtime path to maintain; write that ruling in the report.
- [ ] **Step 3: D1 and DO flake.** Run `bun run test:workers` ten times in a loop and record pass count. If a failure reproduces, find the file and test; reduce it only by removing a real cause (for example a storage frame pop racing an unawaited statement, per the existing comment in `test/workers/vitest.config.ts`), never by retry or sleep. If it does not reproduce in ten runs, document: a "Known CI flake" line under the D1 row in `docs/stores.md` with the observed error text (`Network connection lost`), the mitigation already in place (`singleWorker: true`), and the rule that the only permitted CI action is `gh run rerun <id> --failed` for that job.
- [ ] **Step 4: Gate and commit.** `bun run test` (report tests), `bun run lint`. Commit `fix(conformance): REQ-CONF-8 probe the worker when wrangler never prints its ready line` and `docs(stores): record the D1 workers flake and its mitigation`.

### Task 3: Docs: semantics, conformance, security, stores, problems

**Files:**
- Create: `docs/semantics.md`, `docs/conformance.md`, `docs/security.md`, `test/docs.test.ts`
- Modify: `docs/stores.md`, `docs/problems.md` (only where a check fails), root `package.json` `test` script (append `test/docs.test.ts`)

**Interfaces:**
- Consumes: the problem catalogue in `packages/core/src/http/problems.ts` (every code), `conformance/README.md`, `conformance/REPORT.md`, `requirements.md` 1.2.
- Produces: the five doc paths the README (Task 6) links to.

Content requirements (link to requirements.md section numbers, do not restate it):
- `docs/semantics.md` (REQ-DOC-2): the state machine as a Mermaid `stateDiagram-v2` with states `absent`, `in_flight`, `completed` and every 3.2 transition; `begin` precedence (TTL, then fingerprint, then lease) and fence continuation; lease and fence explained with a worked example of a stale `complete`; what the engine does on throw, on `storeResult` false, over `maxResultBytes`; fail-closed and fail-open including Q15's `complete` rule; per door outcome tables (HTTP 409 and 422 and replay, queue D15 including Q43, webhook D16); streaming consequences from Q19 (a duplicate during the first response's body gets 409; a stalled client holds the claim until the lease expires; the Go small-body difference); the honest limits paragraph from 1.2 (at most one handler execution per key while the record is alive, result replay, no rollback of partial side effects); the Q3 cross-language fingerprint note containing verbatim "a scope is bound to one consumer group in one language"; a Cloudflare Workers note: the idempotency record completes inside the request's own promise chain, so no `ctx.waitUntil` is needed or used for correctness, and a handler that defers work with `waitUntil` gets no idempotency guarantee for that deferred work because the record completes when the response body finishes; the `RunContext` fields (`routeScope`, `keyLookup`, `body`) for authors of a new door.
- `docs/conformance.md` (REQ-DOC-5): run against anything (`bunx @anyonce/conformance --url ... --tier core --report markdown`, the Go `go/cmd/conformance` CLI and when to use it per Q52, in-process `runConformance` and Go `conformance.Run`); the fixture contract by link to `conformance/README.md`; the `short-ttl` capability; how to read `REPORT.md` (tiers, N/A, runner per vector); how to add a vector (schema, tier rule D17, `draftRef`, validation command `bun run vectors:validate`, golden update with `--update`).
- `docs/security.md` (REQ-DOC-6): key entropy (use `newKey()`, UUIDv4, 122 random bits; keys are not secrets but must be unguessable across tenants); scope and principal composition (D8, `principal`, `requirePrincipal`, cross-tenant replay); the webhook shared-endpoint namespace note from Q24; the verification gate (D16, Q29 `WWW-Authenticate: Signature`); log redaction (only `redactKey`, 8 chars, NFR-2); replay isolation (stored header allowlist, `Set-Cookie` never stored); stored bodies (at rest in the store in plain form, encryption is a store concern per 1.2, `maxResultBytes`, DynamoDB 300 KiB per Q20).
- `docs/stores.md` (REQ-DOC-3): confirm the matrix has one row per store (memory, Durable Objects, D1, DynamoDB, Redis, Postgres, SQLite) with consistency, atomicity mechanism, native TTL, setup, cost; the KV exclusion with its reason; links to every migration SQL file (`packages/stores/migrations/**`, `go/store/postgres/schema.sql`, `go/store/sqlite/schema.sql`). Add what is missing.
- `docs/problems.md` (REQ-DOC-4): confirm every code in the catalogue has a section with code, status, when, and an example body; add what is missing.

- [ ] **Step 1: Failing tests** in `test/docs.test.ts`:
  - `REQ-DOC-2: semantics has a Mermaid state diagram with every state and the Q3 sentence verbatim` (asserts a ```` ```mermaid ```` block containing `stateDiagram-v2`, `in_flight`, `completed`, and the exact sentence)
  - `REQ-DOC-2: semantics states the honest limits and the Workers waitUntil note` (asserts `waitUntil` and "does not roll back" appear)
  - `REQ-DOC-3: stores lists every store, the KV exclusion and links every migration file that exists` (globs the migration files and asserts each path appears)
  - `REQ-DOC-4: problems documents every problem code in the catalogue with an example body` (imports the code list from `@anyonce/core/http`; if the catalogue is not exported as a list, read it from the built module's exported problem constructor inputs; each code must have a heading and a following ```` ```json ```` block with `"code": "<code>"`)
  - `REQ-DOC-5: conformance names the CLI, the Go runner, the short-ttl capability and how to add a vector`
  - `REQ-DOC-6: security covers key entropy, principal scope, redaction to 8 characters, the header allowlist and stored bodies`
  - `REQ-DOC-1: every relative link in docs/*.md resolves to a file in the repository` (markdown link regex, strip anchors, skip `http(s):` and `mailto:`)
  - `NFR-6: no tracked text file contains an em or en dash` (walks `git ls-files` output, excludes `docs/reference/**` and lockfiles, reads as UTF-8, searches for the two characters built with `String.fromCharCode(0x2013, 0x2014)` in the test source so the test file itself stays clean)
- [ ] **Step 2: Run** `bun test test/docs.test.ts`: FAIL on the missing files.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run** again: PASS. Add `test/docs.test.ts` to the root `test` script.
- [ ] **Step 5: Commit** `docs: semantics, conformance and security guides (REQ-DOC-2, REQ-DOC-5, REQ-DOC-6)` and `docs: complete the stores and problems references (REQ-DOC-3, REQ-DOC-4)`.

### Task 4: HTTP and webhook examples with smoke tests, and the `examples` CI job

**Files:**
- Create: `examples/worker-hono-do/{package.json,README.md,wrangler.jsonc,src/index.ts,test/smoke.test.ts,vitest.config.ts,tsconfig.json}`
- Create: `examples/lambda-fetch-dynamodb/{package.json,README.md,src/handler.ts,src/function-url.ts,test/smoke.test.ts,tsconfig.json}`
- Create: `examples/go-net-http-postgres/{go.mod,go.sum,README.md,main.go,app.go,smoke_test.go}`
- Create: `examples/webhook-receiver-standard-webhooks/{package.json,README.md,src/index.ts,test/smoke.test.ts,tsconfig.json}`
- Modify: root `package.json` (workspaces gain the four TS example dirs listed explicitly, scripts `test:examples` and `test:examples:workers`), `bun.lock`, `.github/workflows/ci.yml` (new `examples` job), `test/ci.test.ts` (job list and one job test)

**Interfaces:**
- Consumes: `withIdempotency` and `idempotencyOf` from `@anyonce/core/http`, `idempotency` from `@anyonce/hono`, `DurableObjectsStore` and `IdempotencyObject` from `@anyonce/stores/durable-objects`, `DynamoDbStore` and `ensureTable` from `@anyonce/stores/dynamodb`, `webhookReceiver` and `standardWebhooksVerify` from `@anyonce/webhooks`, `runConformance` from `@anyonce/conformance`, the Go `httpmw`, `store/postgres` and `conformance` packages, `@anyonce/fixture-hono` for the fixture routes.
- Produces: each TS example exports a factory `createApp(deps)` returning the fetch handler the README shows, so the smoke test drives exactly that handler; the Go example exports nothing (package `main`) and its test calls the same `newHandler(store)` that `main` calls.

Each example: a README with what it shows, how to run it locally (compose service, command), and the one idempotency behavior to try with `curl` (POST twice with one key, see `Idempotency-Replayed: true`). No key is logged. Each smoke test has two parts: the README scenario (first POST runs, second replays with the header, a different body under the same key is 422), then the conformance run `core` and `profile` against the example's handler configuration with the fixture routes mounted behind the same wrapper configuration.

- [ ] **Step 1: worker-hono-do.** Hono app with `idempotency({ store })` where the store is `new DurableObjectsStore(env.IDEMPOTENCY)`; `export { IdempotencyObject }` from the Worker entry; `wrangler.jsonc` with the DO binding and SQLite migration. Smoke test under its own `vitest.config.ts` (vitest-pool-workers, `singleWorker: true`) named `REQ-DOC-7: worker-hono-do replays a completed POST` and `REQ-HTTP-17: worker-hono-do passes the core and profile conformance tiers in workerd`. Root script `test:examples:workers` runs `vitest run --config examples/worker-hono-do/vitest.config.ts`.
- [ ] **Step 2: lambda-fetch-dynamodb.** `src/handler.ts` exports `handler(event)` for a function URL (payload format 2.0) that converts to a `Request` with `src/function-url.ts` (`toRequest(event)`, `toResult(response)`; base64 bodies both directions), calls a `withIdempotency`-wrapped fetch handler over `new DynamoDbStore({ client, tableName })`, and returns the result; `maxResultBytes` is set to at most 300 KiB per Q20 and the README says why. Smoke test (bun) with DynamoDB Local at `http://127.0.0.1:18000` (skips with a clear message if down, like the store service tests): `REQ-DOC-7: lambda-fetch-dynamodb replays a completed POST through the function URL harness` and `REQ-HTTP-17: lambda-fetch-dynamodb passes the core and profile tiers over a local function URL harness` (a `Bun.serve` on port 0 that turns the HTTP request into a payload v2 event, calls `handler`, writes the result; the URL runner drives it by `baseUrl`). Unit test `REQ-HTTP-17: function URL conversion round trips headers, cookies and a binary body`.
- [ ] **Step 3: go-net-http-postgres.** Nested module `example.local/anyonce/go-net-http-postgres` with `require github.com/sns45/anyonce/go v0.0.0` plus `replace github.com/sns45/anyonce/go => ../../go`; `main.go` opens Postgres from `DATABASE_URL`, calls `postgres.EnsureSchema` (or whatever the store names it), serves `newHandler(store)` from `app.go` which is `httpmw.New(store, httpmw.Options{...}).Handler(mux)`. `smoke_test.go` with `TestREQ_DOC_7_GoNetHTTPPostgresReplaysACompletedPost` and `TestREQ_DOC_7_GoNetHTTPPostgresPassesConformance` (Go `conformance.Run`, core and profile), skipping on a missing Postgres unless `ANYONCE_REQUIRE_SERVICES=1`, in which case it fails. The module must pass `go vet` and `golangci-lint run` from its own directory.
- [ ] **Step 4: webhook-receiver-standard-webhooks.** A fetch handler behind `webhookReceiver({ store, verify: standardWebhooksVerify(secret) })` with the memory store; README shows the Standard Webhooks headers. Smoke test signs with `@anyhook/signing` (devDependency of the example): `REQ-DOC-7: webhook receiver runs a signed delivery once and replays the redelivery`, `REQ-DOC-7: webhook receiver rejects an unsigned delivery before touching the store` (401, `WWW-Authenticate: Signature`).
- [ ] **Step 5: CI.** New `examples` job: checkout, setup-bun latest, setup-go stable, `bun install --frozen-lockfile`, `bun run build`, `docker compose -f test/compose.yml up -d --wait dynamodb postgres`, `bun run test:examples 2>&1 | tee examples.log` with `shell: bash`, `scripts/no-skips.sh examples.log`, `bun run test:examples:workers`, then for each Go example a step with `working-directory: examples/<name>` running `go vet ./...` and `go test -race -count=1 ./...` with `ANYONCE_REQUIRE_SERVICES: '1'`, and `if: always()` compose down. `test/ci.test.ts`: job list gains `examples`; new test `REQ-DOC-7: the examples job starts DynamoDB Local and Postgres, runs every example smoke test and fails on skips`. Root `test:examples` is `bun test examples` (the bun smoke tests only; the worker example's test file must not match `bun test`'s default glob, so name it `smoke.workers.ts` and include that pattern in its vitest config, or exclude its directory; pick one and state it in the report).
- [ ] **Step 6: Gate and commit.** `bun run lint`, `bun run typecheck` (add each TS example's tsconfig to the root `typecheck` chain), `bun run test`, `bun run test:examples` with the two services up, `bun run test:examples:workers`, both Go example modules. One commit per example (`feat(examples): ...`) plus `ci: run the example smoke tests`.

### Task 5: Queue examples, the REQ-Q-8 examples clause, and the REQ-DOC-7 inventory

**Files:**
- Create: `examples/anyq-consumer-ts/{package.json,README.md,src/consumer.ts,test/smoke.test.ts,tsconfig.json}`
- Create: `examples/anyq-consumer-go/{go.mod,go.sum,README.md,main.go,consumer.go,smoke_test.go}`
- Create: `examples/examples.test.ts`
- Modify: root `package.json` (workspace entry), `bun.lock`, `.github/workflows/ci.yml` (one more Go example step in `examples`, and the key-log gate step in `ts` becomes `rg -n 'console\.(log|info|warn|error)\(.*key' packages go examples`), `test/ci.test.ts` if it asserts the gate text, `CHECKLIST.md` "Every phase" key-log line to name `examples`

**Interfaces:**
- Consumes: `idempotent`, `idempotencyStrategy`, `KeySource` from `@anyonce/anyq`; `@anyq/core` and `@anyq/memory` 0.5.0; Go `anyqmw.Wrap`, `anyqmw.Strategy`, `anyqmw.Options{Store, Key: anyqmw.KeySourceHeader}`, anyq Go memory adapter.
- Produces: nothing downstream.

- [ ] **Step 1: anyq-consumer-ts.** Consumer on `@anyq/memory` with `strategy: idempotencyStrategy()` and handler `idempotent(handler, { store, key: 'header' })`; the README's first paragraph states that the strategy is required wiring and why (Q2), and that the header key source is used because a park re-enqueues with a fresh id (Q40), and recommends a producer-supplied `idempotency-key` header (Q4). Smoke tests: `REQ-DOC-7: anyq-consumer-ts runs the handler once for a redelivered message`, `REQ-Q-8: anyq-consumer-ts wires idempotent and idempotencyStrategy together and an in-flight duplicate parks without running the handler before the lease expires` (barrier based, following `packages/anyq/test` patterns; no sleeps).
- [ ] **Step 2: anyq-consumer-go.** Same shape with `anyqmw.Wrap` and `anyqmw.Strategy(nil)`; nested module with `replace` to `../../go`, requires `github.com/sns45/anyq/go v0.5.0`. Tests `TestREQ_DOC_7_AnyqConsumerGoRunsTheHandlerOnceForARedeliveredMessage`, `TestREQ_Q_8_AnyqConsumerGoWiresWrapAndStrategyTogether`.
- [ ] **Step 3: Inventory test** `examples/examples.test.ts`:
  - `REQ-DOC-7: examples holds exactly the six named examples, each with a README and a smoke test` (names: `worker-hono-do`, `lambda-fetch-dynamodb`, `go-net-http-postgres`, `anyq-consumer-ts`, `anyq-consumer-go`, `webhook-receiver-standard-webhooks`)
  - `REQ-DOC-7: the examples CI job runs every example` (parses `ci.yml`; each Go example dir appears as a `working-directory`; `test:examples` and `test:examples:workers` are run)
  - `REQ-Q-8: both queue examples show the door and the strategy wired together` (reads each example's README and source: TS has `idempotent(` and `idempotencyStrategy(`; Go has `anyqmw.Wrap(` and `anyqmw.Strategy(`)
- [ ] **Step 4: Gate and commit** as Task 4 Step 6. Commits `feat(examples): anyq consumer in TypeScript with the companion strategy`, `feat(examples): anyq consumer in Go with the companion strategy`, `test(examples): REQ-DOC-7 inventory and the REQ-Q-8 wiring clause`, `ci: key-log gate covers examples`.

### Task 6: README and llms.txt

**Files:**
- Create: `README.md`, `llms.txt`, `test/readme.test.ts`
- Modify: root `package.json` `test` script (append `test/readme.test.ts`)

**Interfaces:**
- Consumes: every doc from Task 3, every example from Tasks 4 and 5, `conformance/results/*.json` and `conformance/REPORT.md`.
- Produces: README markers `<!-- bench:start -->` and `<!-- bench:end -->` (with a placeholder line inside, `Numbers are written by bun run bench.`) that Task 7 fills.

README (REQ-DOC-1) sections in this order: one line pitch; the three-door paragraph (HTTP `Idempotency-Key`, queue consumers via anyq, webhook receivers via `webhook-id`); badges (conformance, licence Apache-2.0); a 30-second Hono example (a complete file: `new Hono()`, `app.use('/orders', idempotency({ store: new MemoryStore() }))` or the real option shape, a POST route, `export default app`) plus the `curl` pair; install lines per package; the three doors each with a minimal snippet: `withIdempotency`, the queue door showing `idempotent(handler)` and `idempotencyStrategy()` wired together in the first queue paragraph plus the Go `anyqmw.Wrap` and `anyqmw.Strategy` pair (REQ-Q-8 clause), the webhook door; the sentence from Q4 stating plainly that a producer-supplied `idempotency-key` header is the recommended default for any broker whose message id changes on redelivery or producer retry; the store matrix (summary table with a link to `docs/stores.md`); conformance (what it is, the badge's source, link to `docs/conformance.md` and `conformance/REPORT.md`); benchmarks block with the markers; Go module section; examples table linking all six; docs index; case study link `https://in8.sh/anyonce` noted as published at launch (Q62); licence.

`llms.txt` (REQ-DOC-8), in the llmstxt.org shape: `# anyonce`, a `>` summary line, a short semantics paragraph (claim, lease, fence, replay, 409, 422, D6 storage rule), then `## Packages` with one line per npm entry point (`@anyonce/core`, `@anyonce/core/http`, `@anyonce/core/testing`, `@anyonce/hono`, `@anyonce/anyq`, `@anyonce/webhooks`, `@anyonce/stores/durable-objects`, `/d1`, `/dynamodb`, `/redis`, `/postgres`, `@anyonce/conformance`) each followed by `exports: a, b, c` listing the main value exports, `## Go` with one line per Go package and `exports:` listing its main identifiers, `## Docs` linking every docs file, `## Examples`.

- [ ] **Step 1: Failing tests** in `test/readme.test.ts`:
  - `REQ-DOC-1: README names the three doors, links the store matrix, the conformance report and the case study`
  - `REQ-DOC-1: README states the producer-supplied idempotency-key recommendation` (asserts the sentence contains `idempotency-key` and `redelivery` and `producer`)
  - `REQ-DOC-1: the README Hono example type checks and replays a duplicate POST` (extracts the first ```` ```ts ```` block, writes it to a temp file inside the repo's scratch path under `test/.tmp/` (gitignored), imports it with Bun, sends two POSTs with one key through `app.fetch`, asserts the second has `Idempotency-Replayed: true`)
  - `REQ-DOC-1: the conformance badge text matches the committed anyonce results` (derives core and profile pass counts from `conformance/results/` rows whose implementation is anyonce, compares to the badge URL text)
  - `REQ-DOC-1: every relative link in README.md resolves`
  - `REQ-Q-8: README shows idempotent and idempotencyStrategy in one code block and anyqmw.Wrap with anyqmw.Strategy in one code block`
  - `REQ-DOC-8: every export llms.txt lists for an npm entry point is exported by the built package` (dynamic `import()` of each specifier from `dist`, `expect(name in mod)`; type-only names are not listed)
  - `REQ-DOC-8: every identifier llms.txt lists for a Go package is declared in that package` (regex over the package's non-test `.go` files for `func Name`, `type Name`, `var Name`, `const Name` or a name inside a const or var block)
  - `REQ-DOC-8: llms.txt lists every npm entry point in every package.json exports map` (so a new subpath without a line fails)
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Write** `README.md` and `llms.txt`; add `test/.tmp/` to `.gitignore`.
- [ ] **Step 4: Run**: PASS, plus `bun run test`.
- [ ] **Step 5: Commit** `docs: README with the three doors, stores, conformance and examples (REQ-DOC-1)` and `docs: llms.txt checked against the real exports (REQ-DOC-8)`.

### Task 7: Benchmarks and NFR-1

**Files:**
- Create: `benchmarks/http-overhead.ts`, `benchmarks/http-overhead.test.ts`, `benchmarks/README.md`
- Modify: `README.md` (between the markers, written by the script), root `package.json` (script `bench`; `test` gains `benchmarks`)

**Interfaces:**
- Consumes: `withIdempotency` from `@anyonce/core/http`, `MemoryStore` from `@anyonce/core`, the README markers from Task 6.
- Produces: `export async function measure(opts: { iterations: number; warmup: number }): Promise<BenchResult>` where `BenchResult = { bare: Stats; firstExecution: Stats; replay: Stats; overheadP50Ms: { firstExecution: number; replay: number }; runtime: string; iterations: number }` and `Stats = { p50Ms: number; p99Ms: number }`; `export function renderBenchBlock(r: BenchResult, machine: string): string`; `export function writeReadme(readme: string, block: string): string` (replaces what is between the markers, throws if either marker is missing).

- [ ] **Step 1: Failing tests** in `benchmarks/http-overhead.test.ts`:
  - `NFR-1: the HTTP adapter adds under 2 ms p50 over a bare handler with the memory store` (runs `measure({ iterations: 2000, warmup: 200 })`, asserts `overheadP50Ms.firstExecution < 2` and `overheadP50Ms.replay < 2`; iterations are sequential awaits, each builds a fresh `Request` with a fresh body; timing with `performance.now()`)
  - `NFR-1: writeReadme replaces only the text between the bench markers and refuses a README without them`
  - `NFR-1: the README carries a bench block whose recorded p50 overheads are under 2 ms` (parses the table the script writes)
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `measure`, `renderBenchBlock` (a markdown table: path, bare p50, wrapped p50, overhead p50, p99; a line naming runtime version, OS and CPU model from `os.cpus()[0].model`, iterations; no em dash), `writeReadme`, and a `main` that runs 20000 iterations and rewrites README.md (`bun run bench`). Run it once and commit the numbers.
- [ ] **Step 4: Run**: PASS, and the test runtime stays under 10 seconds.
- [ ] **Step 5: Commit** `feat(benchmarks): NFR-1 HTTP adapter overhead with the memory store` and `docs: benchmark numbers in the README`.

### Task 8: Release: workflow, packing, and the 0.1.0 dry run

**Files:**
- Create: `.github/workflows/release.yml`, `scripts/release/dry-run.ts`, `scripts/release/manifest.ts`, `scripts/release.test.ts`, `.changeset/p6-release.md`
- Modify: `packages/{anyq,hono,stores,webhooks}/package.json` (peer `@anyonce/core` from `workspace:*` to `workspace:^`), `bun.lock`, root `package.json` (script `release:dry-run`; `test` already includes `scripts`), `.gitignore` (`release-dry-run/`), `CHECKLIST.md` (P6 dry-run line cites `bun run release:dry-run`)

**Interfaces:**
- Consumes: `.changeset/config.json` (fixed group `[["@anyonce/*"]]`), every package's `package.json`.
- Produces: `checkPackedManifest(manifest: unknown, name: string): string[]` (a list of problems, empty when fine) in `scripts/release/manifest.ts`; `bun run release:dry-run` writing `release-dry-run/summary.json` with `{ versions: Record<string,string>, tarballs: Array<{ name, file, sha256, sbom, signature, verified: boolean }>, goModTidyClean: boolean }`.

- [ ] **Step 1: Failing tests** in `scripts/release.test.ts`:
  - `REQ-REL-1: changesets uses one fixed group for every @anyonce package` (reads config; `fixed` is `[["@anyonce/*"]]`; every non-private `@anyonce/*` package is matched)
  - `REQ-REL-1: the pending changesets release every published package at 0.1.0` (uses `@changesets/read` and `@changesets/assemble-release-plan` or `@changesets/get-release-plan`, added as root devDependencies at the versions `@changesets/cli` already resolves in `bun.lock`; no git access, so it works on a shallow CI checkout)
  - `NFR-3: checkPackedManifest accepts a manifest with exports, types, ESM and CJS entries and sideEffects false` and `NFR-3: checkPackedManifest reports a workspace: specifier, a missing types entry and sideEffects not false`
  - `REQ-REL-2: release.yml runs only on a tag or a manual dispatch` (`on` has exactly `push.tags` and `workflow_dispatch`; `push.branches` absent; `pull_request` absent)
  - `REQ-REL-2: release.yml publishes packed tarballs with provenance and signs them with forgeseal` (`permissions.id-token: write`; a step runs `bun pm pack`; a step runs `npm publish` with `--provenance` and `--access public` over the tarballs; steps run `forgeseal sbom` and `forgeseal sign` for each tarball; the publish job is gated on a tag matching `v*`)
  - `REQ-REL-3: release.yml verifies the Go module on a go/v tag` (a job whose `if` or trigger matches `go/v*` runs `go vet ./...`, `go test -race ./...` and golangci-lint v2.13.2 in `go`, and runs `go mod tidy -diff`)
- [ ] **Step 2: Run**: FAIL.
- [ ] **Step 3: Implement** `manifest.ts`, the peer changes, `.changeset/p6-release.md` (`patch` for the four packages whose peer range changes, text: peers on `@anyonce/core` use a caret range), and `release.yml`:
  - `on: push: tags: ['v*', 'go/v*']` and `workflow_dispatch` with a boolean input `publish` default false; `permissions: contents: read, id-token: write`.
  - job `npm` (if the ref is a `v*` tag, or dispatch): checkout, setup-bun, setup-node 22 with `registry-url: https://registry.npmjs.org`, setup-go stable, `bun install --frozen-lockfile`, `bun run build`, `bun run test`, `go install github.com/sns45/forgeseal/cmd/forgeseal@v0.5.1`, pack each package with `bun pm pack --destination dist-release`, per tarball `forgeseal sbom` and `forgeseal sign` (keyless) and `forgeseal verify`, then `npm publish <tarball> --provenance --access public` only when the ref is a tag or `inputs.publish` is true, with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`; upload the SBOMs and bundles as workflow artifacts.
  - job `go` (if the ref is a `go/v*` tag, or dispatch): setup-go stable, in `go`: `go mod tidy -diff`, `go vet ./...`, `go test -race ./...`, golangci-lint action v7 `version: v2.13.2`.
- [ ] **Step 4: Implement** `scripts/release/dry-run.ts`: create `release-dry-run/work` (clean first), `git archive HEAD | tar -x -C` into it, then in it: `bunx changeset version`, `bun install`, `bun run build`, for each non-private package `bun pm pack --destination ../tarballs`, then run `checkPackedManifest` on each tarball's `package/package.json` (fail on any problem), `go mod tidy -diff` in `work/go`, and forgeseal: locate `forgeseal` on `PATH` or `$(go env GOPATH)/bin`, else install it with `go install github.com/sns45/forgeseal/cmd/forgeseal@v0.5.1` into `release-dry-run/bin`; `forgeseal ca` to create a throwaway CA under `release-dry-run/ca` (read `forgeseal ca --help` for the exact subcommand), then per tarball `forgeseal sbom --dir <unpacked package dir> -o <name>.cdx.json`, `forgeseal sign --keyed --ca-cert ... --ca-key ... --artifact <tarball> --bundle <tarball>.sigstore.json`, the same for the SBOM, and `forgeseal verify`. Write `summary.json` and print a one-line-per-tarball table. It never runs `npm publish`, never pushes, never contacts Fulcio or Rekor (keyed mode only), and says so in its header comment.
- [ ] **Step 5: Run** `bun test scripts/release.test.ts`: PASS. Run `bun run release:dry-run` and paste its full output into the report; every version is `0.1.0`, every tarball has an SBOM and a verified signature, `go mod tidy` is clean. Confirm `git status` shows no change outside `release-dry-run/` (gitignored).
- [ ] **Step 6: Commit** `build(release): peers on @anyonce/core use a caret workspace range`, `ci: release workflow on tag or dispatch only (REQ-REL-2, REQ-REL-3)`, `build(release): 0.1.0 dry run with packed manifest checks and forgeseal (REQ-REL-1, REQ-REL-2)`.

### Task 9: Phase gate wiring

**Files:**
- Modify: root `package.json` (`test:reqs` appends `&& bun run scripts/reqs.ts --phase p6`), `CHECKLIST.md` (tick the P6 items that have evidence; the real-release item stays unticked with a pointer to Q64)

- [ ] **Step 1:** `bun run test:reqs`: every chained phase green, the p6 line shows every DOC, REL and NFR id covered. If any id is uncovered, stop and report which task owes it.
- [ ] **Step 2:** Run the phase gate below and paste each command's tail into the report.
- [ ] **Step 3: Commit** `test: REQ coverage check includes P6`.

## Phase gate (mirrors CHECKLIST.md)

```
scripts/doctor.sh
bun run lint
bun run build
bun run typecheck
bun run size
bun run test
bun run test:coverage
bun run test:reqs
bun run test:workers
bun run test:examples:workers
docker compose -f test/compose.yml up -d --wait
bun run test:services
bun run test:examples
GOROOT= /opt/homebrew/bin/go vet -C go ./...
GOROOT= /opt/homebrew/bin/go test -C go -race ./...
GOROOT= sh -c 'cd go && golangci-lint run'
GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh
(for each Go example) GOROOT= ANYONCE_REQUIRE_SERVICES=1 /opt/homebrew/bin/go test -C examples/<name> -race ./...
bun run bench   (numbers only; the committed README is not rewritten by the gate)
bun run release:dry-run
rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .
rg -n 'console\.(log|info|warn|error)\(.*key' packages go examples
```

Checklist items: six examples each with a passing CI smoke test; benchmark numbers in README and NFR-1 met; `llms.txt` present and accurate; dry run: changesets version, build, pack every package, `go mod tidy` clean, forgeseal SBOM and signature for every tarball. Not in P6 without an explicit go: the real publish with provenance and the `go/v0.1.0` tag (Q64).
