# CLAUDE.md: anyonce repo conventions

Read `requirements.md` before touching code. It is the design; this file is how we work in this repo.

## Layout

```
packages/core            @anyonce/core        engine, types, memory store, testing/ (store contract suite)
  src/http/              @anyonce/core/http   withIdempotency and the shared HTTP helpers (subpath export)
packages/hono            @anyonce/hono        Hono middleware + withIdempotency fetch wrapper
packages/anyq            @anyonce/anyq        anyq consumer middleware
packages/webhooks        @anyonce/webhooks    Standard Webhooks receiver + verify helper
packages/stores          @anyonce/stores      subpath exports: /durable-objects /d1 /dynamodb /redis /postgres
packages/conformance     @anyonce/conformance runner + CLI
conformance/             vectors/, schema.json, README.md, REPORT.md, DRAFT-GAPS.md, fixtures/
go/                      Go module github.com/sns45/anyonce/go
  anyonce/               core
  httpmw/ anyqmw/ webhookmw/
  store/memory store/dynamodb store/redis store/postgres store/sqlite
  storetest/             store contract suite
  conformance/           Go runner
examples/                six examples, each with a CI smoke test
docs/                    semantics.md stores.md queue-ids.md problems.md conformance.md security.md reference/ standards/ superpowers/
benchmarks/
```

## Commands

- `bun install` at root (workspaces). `bun run build`, `bun run test`, `bun run test:workers` (vitest-pool-workers for DO, D1 and the P2 runtime matrix; run `bun run build` first, the workspace packages resolve through their `exports` to `dist`), `bun run test:node` (Node 22 runtime matrix, also needs `bun run build` first), `bun run test:deno` (Deno 2 runtime matrix, also needs `bun run build` first), `bun run test:reqs` (REQ coverage check, scoped to the current phase; it is on `--phase p3` from P3 onwards), `bun run test:coverage` (vitest v8 branch coverage on the engine, the key validator and the sf-string parser; added in P1), `bun run lint` (Biome), `bun run conformance -- --url <base> [--tier core] [--report junit]`, `scripts/doctor.sh` (checks bun, go, docker and golangci-lint at the pinned versions).
- `docker compose -f test/compose.yml up -d` starts DynamoDB Local, Redis 7, Postgres 16, Redpanda, ElasticMQ for integration tests. Tests skip with a clear message if a service is down; CI treats skips as failures.
- `bun run test:services` needs that compose stack up: it runs the connectivity check plus the store suites under `packages/stores/services`. `bun run test:workers` runs the D1 and Durable Objects store suites alongside the P2 runtime matrix. The Go store tests read `ANYONCE_REQUIRE_SERVICES`: unset they skip a missing service, set to `1` (as CI does) they fail instead.
- Go: `cd go && go build ./... && go vet ./... && go test -race ./... && golangci-lint run` (golangci-lint pinned to v2.13.2 locally and in CI).

## Code rules

- TypeScript: strict, `exactOptionalPropertyTypes`, no `any` outside test fakes, ESM source, tsup builds ESM+CJS+d.ts. Web APIs only in core, hono, webhooks (no `node:` imports). Peer dependencies for framework and client libraries.
- Go: standard library first; the only third-party deps are the store clients and `modernc.org/sqlite`. No cgo. Errors wrapped with `%w`; sentinel errors exported from `anyonce` (`ErrConflict`, `ErrMismatch`, `ErrStaleFence`, `ErrStoreUnavailable`).
- Import direction: `@anyonce/core` root never imports from `./http`; `@anyonce/hono` and `@anyonce/webhooks` import only from `@anyonce/core` and `@anyonce/core/http`. A test enforces this.
- Store `begin` is one atomic operation per store. Get-then-lock is a bug even if the tests pass.
- Four kinds of text exist once per language and must stay byte equal across them: the SQL statements (`packages/stores/src/sql.ts` against the constants in `go/store/internal/sqlstore/sqlstore.go`), the DynamoDB condition and update expressions (`packages/stores/src/dynamodb.ts` against the constants in `go/store/dynamodb/dynamodb.go`), the Redis Lua scripts (`packages/stores/src/redis.ts` against `go/store/redis/scripts.go`), and the schemas (`packages/stores/src/sql.ts` against `go/store/postgres/schema.sql` and `go/store/sqlite/schema.sql`, plus the committed migrations under `packages/stores/migrations`). `packages/stores/test/parity.test.ts` compares each pair whole, reading the Go backtick constants by name, so change both sides in the same commit and keep the Go constants as single backtick literals.
- Never log a full idempotency key; use `redactKey()` (first 8 chars + `…`).
- Public API changes require a changeset (`bunx changeset`).

## Tests

- Test names start with the REQ id they prove. One REQ can have many tests; every REQ has at least one.
- Store tests import the shared contract suite; do not hand-write store transition tests.
- Concurrency tests never use sleeps to pass. Use barriers (`/slow` fixture, `Promise.all` with a start gate, Go `sync.WaitGroup` plus a channel gate).
- Golden files use `-update` (`bun run test -- --update`, `go test ./... -update`). Fixtures are committed; no network fetches in CI beyond package registries and local containers.

## Docs and prose

- No em or en dashes anywhere in prose, comments, commit messages, or generated docs. Use a comma, colon, or a new sentence.
- Diagrams in Mermaid inside markdown.
- Every problem type documented in `docs/problems.md` with a stable code; the base URI is configurable and defaults to `https://in8.sh/anyonce/problems/`.

## Git

- Branch per phase (`p0-scaffold-and-vectors`, `p1-core`, `p4a-queue`, `p4b-webhooks`, ...) via `using-git-worktrees`; store PRs branch from the P3 branch as `p3-store-<name>`.
- Conventional commits (`feat(core): ...`, `test(stores): REQ-STORE-8 ...`). Squash merge to `main`. PR body lists REQ ids covered and pastes the verification output.
- CI must be green before requesting review.

## Things not to do

- Do not implement a Cloudflare KV store.
- Do not add a dependency to core to save time.
- Do not send anything external (issues on other repos, WG PRs, mailing list, npm publish) without an explicit go from Shantanu.
- Do not restate requirements.md inside design notes or plans; link to section numbers.
