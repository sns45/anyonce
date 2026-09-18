# CHECKLIST.md: phase gates

Each gate is run with `verification-before-completion`. Paste the raw command output into the PR. An item without output is not done.

## Every phase

- [ ] `scripts/doctor.sh` passes (bun, go, docker, golangci-lint present at the pinned versions)
- [ ] `bun run lint` clean, `bun run build` clean, `bun run test` green, `bun run test:reqs` reports no uncovered REQ ids in this phase's scope
- [ ] `cd go && go vet ./... && go test -race ./... && golangci-lint run` clean (once Go code exists)
- [ ] No em or en dashes: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing
- [ ] No full keys logged: `rg -n "console\.(log|info|warn|error)\(.*key" packages go` reviewed, only `redactKey` usages
- [ ] Changeset present for any public API change
- [ ] `docs/superpowers/questions.md` reviewed; every open question has a recommended resolution

## P0 scaffold and vectors

- [ ] `npm view anyonce`, `npm view @anyonce/core`, `gh repo view sns45/anyonce` all not-found (preflight evidence committed in `docs/reference/preflight.md`)
- [ ] `docs/reference/draft-07.txt`, `docs/reference/anyq-interfaces.md`, `docs/reference/anyhook-signing.md` committed
- [ ] `conformance/schema.json` validates every file in `conformance/vectors/` (CI job `vectors-validate`)
- [ ] Vector count: at least 10 `core`, at least 6 `profile`, each `core` vector has a `draftRef`
- [ ] Fixture apps (Hono, net/http) run and the runner reports the expected failures against them with no idempotency layer
- [ ] `test/compose.yml` brings up DynamoDB Local, Redis, Postgres, Redpanda, ElasticMQ; CI job proves connectivity

## P1 core

- [ ] Engine, key validator and sf-string parser branch coverage 100% via `bun run test:coverage` (vitest, `@vitest/coverage-v8`, `branches: 100`); Go via `go test -coverprofile` on `anyonce/engine.go`
- [ ] Store contract suite exported (`@anyonce/core/testing`, `anyonce/storetest`) and consumed by the memory stores
- [ ] REQ-STORE-8 race test: 20 iterations, exactly one `acquired` each, in both languages
- [ ] `@anyonce/core` has no `dependencies`; bundle under 8 KB min+gzip (`bun run size`)
- [ ] RFC 9651 sf-string and RFC 8785 JCS known-answer tests green

## P2 HTTP adapter

- [ ] TS runner: 100% `core` and `profile` against Hono + memory store and `withIdempotency` + memory store
- [ ] Go runner: 100% `core` and `profile` against `httpmw` + memory store
- [ ] Streaming proof test (first chunk observed before handler completes)
- [ ] Runtime matrix for core + hono: Workers (vitest-pool-workers), Bun, Node 22, Deno
- [ ] `docs/problems.md` lists every code with example body

## P3 stores (one gate per store PR)

- [ ] Contract suite green against the real container/emulator
- [ ] Full conformance (`core` + `profile`) green through the HTTP adapter with this store
- [ ] `begin` implementation is a single atomic operation; SQL or Lua pasted in PR body
- [ ] `docs/stores.md` row added: consistency, atomicity mechanism, native TTL, setup, cost note
- [ ] For DO: alarm purge tested; for DynamoDB: TTL attribute set and `ReturnValuesOnConditionCheckFailure` path tested; for Redis: EVALSHA fallback tested; for Postgres/D1/SQLite: migration file applied by `ensureSchema()` test

## P4a queue door

- [ ] anyq adapter tests green against memory/Redis Streams, ElasticMQ (SQS), Redpanda (Kafka), TS and Go
- [ ] Stored queue record contains no payload bytes (REQ-Q-5)
- [ ] Companion strategy (REQ-Q-8) tested with and without a strategy; the park downgrade never calls the handler before the lease expires
- [ ] Mismatch paths route to dead-letter with reason `fingerprint-mismatch`
- [ ] `docs/queue-ids.md` covers every anyq consumer adapter with redelivery id stability (REQ-DOC-9)

## P4b webhook door

- [ ] Webhook verification gate test precedes happy path in git history (REQ-WH-2)
- [ ] anyhook sign → anyonce receive interop test green; Standard Webhooks vectors green
- [ ] Mismatch fires `onSuspicious` (REQ-WH-5)

## P5 cross-implementation report

- [ ] URL-mode runner executed against hono-idempotency, idempo, Fiber in Docker; commands and image tags recorded
- [ ] `conformance/REPORT.md` generated via `-update`, committed, third parties graded on `core` only
- [ ] `conformance/DRAFT-GAPS.md` lists every open point with anyonce's choice and proposed draft text
- [ ] S4 issue drafts in `docs/standards/issues/` (not opened)

## P6 docs, examples, release

- [ ] Six examples each have a CI smoke test that passes
- [ ] Benchmarks script writes numbers into README; NFR-1 met
- [ ] `llms.txt` present and accurate
- [ ] Dry-run release: `bunx changeset version`, `bun run build`, `npm pack` for every package, `go mod tidy` clean, forgeseal SBOM + signature generated for tarballs
- [ ] Real release only after explicit go: npm provenance visible on `npm view @anyonce/core`, Go tag `go/v0.1.0` resolves

## P7 standards and launch

- [ ] `docs/standards/S1-wg-pr.md`, `S2-mailing-list.md`, `S3-draft-issues.md` drafted; nothing sent
- [ ] Five launch surfaces prepared via the project-launch skill: in8.sh case study (four-file template, "Why this is new" uses requirements.md 0.3 verbatim or narrowed with evidence), homepage card, GitHub profile README, resume (both variants, one Letter page, column balance within 20px), `/promote` drafts for Reddit and LinkedIn
- [ ] Case study cites prior art table from requirements.md 0.2 with dates
