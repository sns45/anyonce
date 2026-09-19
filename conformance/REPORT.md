# Cross-implementation conformance report

This file is generated, not hand written. It is a golden file checked by CI: run `bun run report -- --update` to regenerate it from a full run of every row in the manifest, which also rewrites the committed run summaries under `conformance/results/`.

Third-party implementations are graded on the `core` tier only. Their `profile` numbers are printed for information alongside anyonce's own results and are never a pass or fail judgement of that implementation.

## Matrix

| Implementation | Version | Language | Store | Core | Profile | N/A | Failing core vectors |
|---|---|---|---|---|---|---|---|
| anyonce | this repo | TypeScript | memory | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | TypeScript | durable-objects | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | TypeScript | d1 | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | TypeScript | dynamodb | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | TypeScript | redis | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | TypeScript | postgres | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | Go | memory | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | Go | dynamodb | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | Go | redis | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | Go | postgres | 11/11 | 9/9 | 0 | none |
| anyonce | this repo | Go | sqlite | 11/11 | 9/9 | 0 | none |
| hono-idempotency | 0.9.1 | TypeScript | memory | 11/11 | 4/9 (info) | 0 | none |
| idempo | v1.0.0 | Go | in-memory | 9/11 | 3/9 (info) | 0 | [core/get-ignored](issues/idempo-get-ignored.md), [core/key-missing-required](issues/idempo-key-missing-required.md) |
| fiber | v3.5.0 | Go | fiber storage | 7/11 | 0/9 (info) | 0 | [core/concurrent-409](issues/fiber-concurrent-409.md), [core/key-missing-required](issues/fiber-key-missing-required.md), [core/mismatch-422](issues/fiber-mismatch-422.md), [core/mismatch-does-not-poison](issues/fiber-mismatch-does-not-poison.md) |

## Targets

### anyonce-ts-memory

- Runner: ts-in-process
- Fixture: conformance/fixtures/hono (in-process, via scripts/report/collect.ts)

### anyonce-ts-durable-objects

- Runner: workerd-url
- Fixture: conformance/report/worker/ (wrangler dev --local, ANYONCE_STORE=durable-objects)

### anyonce-ts-d1

- Runner: workerd-url
- Fixture: conformance/report/worker/ (wrangler dev --local, ANYONCE_STORE=d1)

### anyonce-ts-dynamodb

- Runner: ts-in-process
- Fixture: conformance/fixtures/hono (in-process) behind packages/stores/src/dynamodb.ts

### anyonce-ts-redis

- Runner: ts-in-process
- Fixture: conformance/fixtures/hono (in-process) behind packages/stores/src/redis.ts

### anyonce-ts-postgres

- Runner: ts-in-process
- Fixture: conformance/fixtures/hono (in-process) behind packages/stores/src/postgres.ts

### anyonce-go-memory

- Runner: go-url
- Fixture: go/cmd/fixture -idempotent -store memory

### anyonce-go-dynamodb

- Runner: go-url
- Fixture: go/cmd/fixture -idempotent -store dynamodb

### anyonce-go-redis

- Runner: go-url
- Fixture: go/cmd/fixture -idempotent -store redis

### anyonce-go-postgres

- Runner: go-url
- Fixture: go/cmd/fixture -idempotent -store postgres

### anyonce-go-sqlite

- Runner: go-url
- Fixture: go/cmd/fixture -idempotent -store sqlite

### hono-idempotency

- Runner: ts-url
- Fixture: conformance/third-party/hono-idempotency/
- Image: node:22.23.2-alpine
- Packages: hono-idempotency@0.9.1, hono@4.13.8, hono-problem-details@0.11.0, @hono/node-server@2.1.1
- Notes: memoryStore({ ttl: 2000 }), against a library default of 24 hours, so the short-ttl capability can be declared and core/expiry-executes-again is graded rather than reported not-applicable. required: true, so the fixture matches core/key-missing-required. methods and dangerouslyAllowGlobalKeys are also set but are inert for this fixture: every route is POST, and the fixture never reuses a key across routes, so neither setting changes what the run measures.

### idempo

- Runner: ts-url
- Fixture: conformance/third-party/idempo/
- Image: golang:1.26.8-alpine3.24
- Packages: github.com/eben-vranken/idempo@v1.0.0
- Notes: inmem.New(2s, 2s), the lock and retention lifetimes of the store, so the short-ttl capability can be declared and core/expiry-executes-again is graded rather than reported not-applicable. Every field of idempo.Options itself is left at its default; the middleware has no TTL option of its own.

### fiber

- Runner: ts-url
- Fixture: conformance/third-party/fiber/
- Image: golang:1.26.8-alpine3.24
- Packages: github.com/gofiber/fiber/v3@v3.5.0
- Notes: Lifetime: 2s, against a library default of 30 minutes, so the short-ttl capability can be declared and core/expiry-executes-again is graded rather than reported not-applicable. KeyHeader overridden from the default X-Idempotency-Key to Idempotency-Key, and KeyHeaderValidate overridden to accept every key, per Q53. Without both of those every vector fails key validation before the middleware runs at all.

## Per-vector detail

### hono-idempotency

| Vector | Status | Runner | Detail |
|---|---|---|---|
| core/concurrent-409 | pass | ts |  |
| core/expiry-executes-again | pass | ts |  |
| core/get-ignored | pass | ts |  |
| core/header-name-case-insensitive | pass | go |  |
| core/key-missing-required | pass | ts |  |
| core/mismatch-422 | pass | ts |  |
| core/mismatch-does-not-poison | pass | ts |  |
| core/post-executes-once | pass | ts |  |
| core/retry-replays | pass | ts |  |
| core/sf-string-quoted-key | pass | ts |  |
| core/two-keys-execute-twice | pass | ts |  |

### idempo

| Vector | Status | Runner | Detail |
|---|---|---|---|
| core/concurrent-409 | pass | ts |  |
| core/expiry-executes-again | pass | ts |  |
| core/get-ignored | fail | ts | get-after: body.count: expected 1, got 0 |
| core/header-name-case-insensitive | pass | go |  |
| core/key-missing-required | fail | ts | missing: status: expected 400, got 201; missing: handlerInvocations: expected 0, got 1 |
| core/mismatch-422 | pass | ts |  |
| core/mismatch-does-not-poison | pass | ts |  |
| core/post-executes-once | pass | ts |  |
| core/retry-replays | pass | ts |  |
| core/sf-string-quoted-key | pass | ts |  |
| core/two-keys-execute-twice | pass | ts |  |

### fiber

| Vector | Status | Runner | Detail |
|---|---|---|---|
| core/concurrent-409 | fail | ts | duplicate: status: expected 409, got 200 |
| core/expiry-executes-again | pass | ts |  |
| core/get-ignored | pass | ts |  |
| core/header-name-case-insensitive | pass | go |  |
| core/key-missing-required | fail | ts | missing: status: expected 400, got 201; missing: handlerInvocations: expected 0, got 1 |
| core/mismatch-422 | fail | ts | changed: status: expected 422, got 201 |
| core/mismatch-does-not-poison | fail | ts | changed: status: expected 422, got 201 |
| core/post-executes-once | pass | ts |  |
| core/retry-replays | pass | ts |  |
| core/sf-string-quoted-key | pass | ts |  |
| core/two-keys-execute-twice | pass | ts |  |

## How this file is generated

Two gates check this file. The `ts` job runs no containers at all: `bun run test` includes `scripts/report.test.ts`, which renders this file from the committed `conformance/results/*.json` and asserts the result equals what is committed, so a hand edit here fails the cheap gate. The `services` job brings up `test/compose.yml` and `conformance/third-party/compose.yml`, re-runs every row for real, and compares both the fresh results and the fresh render against what is committed (`bun run report`). Run `bun run report -- --update` locally with both compose files up to regenerate everything.
