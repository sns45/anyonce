# P3 Stores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every production store: `@anyonce/stores` with `/dynamodb`, `/redis`, `/postgres`, `/d1` and `/durable-objects` subpaths in TypeScript, and `store/dynamodb`, `store/redis`, `store/postgres`, `store/sqlite` in Go, each passing the shared contract suite against its real container or emulator and the full conformance suite through the HTTP adapter, with one gate per store PR and a `docs/stores.md` row per store.

**Architecture:** Every store implements the P1 `Store` interface with `begin` as one atomic operation: a single conditional `INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` in the SQL stores, a single conditional `UpdateItem` in DynamoDB, a single Lua script in Redis, and a single-writer Durable Object transaction. A refused conditional write is classified by one follow-up read in the SQL stores and by `ReturnValuesOnConditionCheckFailure` in DynamoDB. Logical expiry is always the injected `now` compared with `expires_at` (the contract suite runs on a 2023 clock); native TTL, where a backend has one, is scheduled as a duration relative to the injected clock so it never fights the logical clock. A shared codec turns records into flat rows and back so every store serializes the same shape.

**Tech Stack:** Bun 1.2, TypeScript 5 strict, tsup, Biome 2, vitest 3.2.7 plus `@cloudflare/vitest-pool-workers` 0.12.21 for D1 and Durable Objects, `@aws-sdk/client-dynamodb` 3.x, `ioredis` 6 and `redis` 6 (node-redis) and `@upstash/redis` 1.x adapters, `pg` 8 and `postgres` 3 (postgres.js) adapters, DynamoDB Local 2.6.1, Redis 7.4, Postgres 16.9 from `test/compose.yml`; Go 1.26, `github.com/aws/aws-sdk-go-v2` v1.47.0 with `service/dynamodb` v1.69.0, `config` v1.33.5 and `credentials` v1.20.5, `github.com/redis/go-redis/v9` v9.22.0, `github.com/jackc/pgx/v5` v5.11.0 (stdlib driver), `modernc.org/sqlite` v1.59.0 (no cgo).

**Spec:** `requirements.md` sections 3.1, 3.2 (as amended by Q8), 4.2 (REQ-STORE-1..11), 4.3 (REQ-ST-DO-1, REQ-ST-D1-1, REQ-ST-DDB-1, REQ-ST-REDIS-1, REQ-ST-PG-1, REQ-ST-SQLITE-1, REQ-ST-KV-1), D4, D5, D12, D14, D19, D20, D21; `docs/superpowers/questions.md` Q7, Q8, Q20 (the DynamoDB cap); `CHECKLIST.md` "Every phase" and "P3 stores"; GitHub issue #1.

## Global Constraints

- Prose in docs, comments, commit messages, changeset text, SQL comments, YAML: no em or en dashes (U+2013, U+2014). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing.
- Test names start with the REQ id they prove. Store tests import the shared contract suite (`storeContractSuite` from `@anyonce/core/testing`, `storetest.Run` in Go); no hand-written store transition tests. Store-specific tests carry `REQ-ST-<NAME>-1:` names.
- `begin` is one atomic operation per store (D4). Get-then-lock is a defect even if the tests pass. A follow-up read may classify a refused write; it never decides the claim.
- State machine precedence in `begin` (3.2 amended, Q8): TTL expiry first (a row with `expires_at <= now` is absent and is taken over with `fence + 1`), then fingerprint (a live row with a different fingerprint is `mismatch`, whatever its state or lease), then state and lease (a live matching completed row is `completed`; a live matching in-flight row with `lease_until > now` is `in_flight`, otherwise it is taken over with `fence + 1`). A physically absent row starts at fence 1. `complete` with a matching fence on an already completed row is `ok`; `complete` on an absent or expired row is `not_found`; a different fence is `stale_fence`. `abandon` deletes only an in-flight row with a matching fence.
- Time: every store compares the injected `now` (epoch milliseconds in TypeScript, `time.Time` in Go) against stored `expires_at` and `lease_until`; a store never reads the wall clock for logical decisions. Native TTL (Redis `PEXPIRE`, DynamoDB `ttl`, Durable Object alarms) is scheduled as `(expires_at - now) + nativeTtlGraceMs` from the moment of the write, never as the absolute injected timestamp, so the 2023 test clock does not make a backend delete rows on the spot. `nativeTtlGraceMs` defaults to 60000 and exists so a late `complete` from the previous fence holder still finds its row (Q8).
- Row shape shared by every store (the codec in Task 1): `scope`, `key`, `fingerprint`, `state` (`in_flight` or `completed`), `fence` (integer), `lease_until`, `created_at`, `expires_at` (epoch milliseconds, integers), `result_meta` (JSON text or null: `{ kind, status?, headers?, outcome?, error? }`), `result_body` (bytes or null), `result_omitted` (0 or 1). A record decoded from a row carries `result` only when `result_meta` is present, `result.body` only when `result_body` is present, and `resultOmitted: true` only when the flag is 1.
- Result cap (Q20): the contract suite reads `maxResultBytes` from the harness (default 1 MiB); the DynamoDB harness declares 307200 (300 KiB) in both languages, and `docs/stores.md` says so.
- TypeScript `@anyonce/stores`: zero `dependencies`; every client library is an optional peer (`peerDependenciesMeta` optional); `@anyonce/core` is a peer; Web APIs plus the client's own API only (no `node:` imports in `src`, so the D1 and Durable Object entries run in workerd and the others run anywhere the client runs); ESM and CJS with `exports` listing `types` first; `sideEffects: false`; strict TypeScript with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; no `any` outside test fakes.
- Go stores: each in `go/store/<name>` with `New(...)` and, for SQL stores, `EnsureSchema(ctx)`; only the store's own client as a third-party dependency (D21); no cgo anywhere (NFR-5); errors wrapped with `%w`; `context.Context` first on every call; doc comments on exported identifiers; `go vet`, `go test -race`, `golangci-lint run` clean. Run Go as `GOROOT= /opt/homebrew/bin/go <verb> -C go ./...`, golangci-lint as `GOROOT= sh -c 'cd go && golangci-lint run'`, the engine coverage gate as `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`.
- Services: `docker compose -f test/compose.yml up -d --wait` starts DynamoDB Local on 127.0.0.1:18000, Redis on 6379 and Postgres on 15432 (user, password and database `anyonce`). Store integration tests live under `packages/stores/services/` (Bun) and are run by `bun run test:services`; each file skips with a clear message when its service is down, and CI's `services` job treats skips as failures. Go store tests skip when their service is down unless `ANYONCE_REQUIRE_SERVICES=1` is set, which CI sets. `bun run test` never touches a service.
- Workers: D1 and Durable Object tests run under `bun run test:workers` (vitest-pool-workers) with `isolatedStorage` on, from `packages/stores/workers/`; `bun run build` first because the pool resolves `@anyonce/*` through `exports` to `dist`.
- Conformance through the HTTP adapter: every TypeScript store gets a `services/<name>.conformance.test.ts` (or a workers test) running `runConformance` through `withIdempotency(createFixtureApp().fetch, { store, required: true, ttlMs: 2000, skip on /reset })` with `capabilities: ['short-ttl']` and, for DynamoDB, `maxResultBytes: 307200` (the omitted-body vector then exercises the omitted form at 1 MiB plus one byte, which is over the cap, as intended); every Go store gets a `conformance.Run` through `httpmw` the same way. All twenty vectors must pass.
- Branching and PRs (issue #1): this plan and the scaffold land on the integration branch `p3-stores`, opened as a draft PR to `main` that says `Part of #1`. Each store task is a branch `p3-store-<name>` from `p3-stores` with a PR targeting `p3-stores` that says `Part of #1`, carries its gate output and the store's SQL or Lua in the body, and is squash-merged into `p3-stores` once its task review is approved. The final task marks the `p3-stores` PR ready with `Closes #1`. Git only as plain single commands from the worktree root; `gh pr create` and `gh pr merge --squash --delete-branch` for the store PRs.
- Conventional commits: `feat(stores): ...`, `test(stores): REQ-ST-REDIS-1 ...`, `feat(go): ...`, `docs(stores): ...`.
- Never type a `\uXXXX` escape inside a tool parameter; use `\x` or named escapes.
- Changeset `.changeset/p3-stores.md` (Task 1): `@anyonce/stores: minor`, `@anyonce/core: patch` (the suite option).

## Decisions taken in this plan (not spec changes)

- Classification after a refused conditional write in the SQL stores is one `SELECT` of the live row; if that read finds no live row (a race with purge or takeover), `begin` retries the statement, at most three times, then reports `store unavailable` through a thrown error. This keeps D4 (the claim is the one statement) and matches the design note's expectation of a follow-up read.
- Native TTL and alarms are scheduled relative to the injected clock (see Global Constraints); with the 24 h suite TTL nothing is swept during a test, and `physicallyRemove` on each harness simulates the sweep for REQ-STORE-7.
- Durable Object sharding: `shard: 'scope' | 'scope-key'` (default `scope`) picks the object name; `purge(now)` from the Worker reaches every object this store instance has touched in the isolate (a tracked set of names) and the alarm sweeps everything else on the object's own schedule, which `docs/stores.md` explains. Objects use SQLite-backed storage (`new_sqlite_classes`) and the same statements as D1.
- Redis keys are `${prefix}${scope}\x1f${key}` with prefix `anyonce:`; the hash holds the shared row fields; `result_body` is a binary field. Client adapters expose `evalsha(sha, keys, args)` and `eval(script, keys, args)` returning the script's reply; `fromIoredis`, `fromNodeRedis` and `fromUpstash` wrap the three clients. Scripts are loaded lazily by `EVALSHA` first and `EVAL` on `NOSCRIPT`, with the sha cached per store instance.
- Postgres TypeScript adapter is `{ query(sql, params): Promise<{ rows: Record<string, unknown>[] }> }`; `pg` clients and pools satisfy it directly; `fromPostgresJs(sql)` and `fromNeon(sql)` wrap the other two. Placeholders are `$1..$n`; `bytea` carries the body.
- DynamoDB table keys are `pk` (scope) and `sk` (key), both strings; `ensureTable` exists for tests and local development only; TTL is enabled on attribute `ttl` (epoch seconds) by `ensureTable`; `purge` returns 0. DynamoDB Local does not sweep TTL, which is why the harness's `physicallyRemove` is a `DeleteItem`.
- The contract suite gains one optional harness field, `maxResultBytes` (Q20). Nothing else in `@anyonce/core` changes.

## File Structure

```
packages/stores/package.json                @anyonce/stores, subpath exports, optional peers, build entries
packages/stores/tsconfig.json
packages/stores/tsup.config.ts              five entries, external peers
packages/stores/src/codec.ts                RecordRow, encodeResult, decodeRow, rowFromRecord helpers
packages/stores/src/sql.ts                  SQL text shared by D1, Durable Objects (SQLite dialect) and the Postgres variant
packages/stores/src/dynamodb.ts             DynamoDbStore, ensureTable
packages/stores/src/redis.ts                RedisStore, RedisAdapter, fromIoredis, fromNodeRedis, fromUpstash, LUA scripts
packages/stores/src/postgres.ts             PostgresStore, PostgresQuery, fromPostgresJs, fromNeon, ensureSchema, MIGRATION_SQL
packages/stores/src/d1.ts                   D1Store, ensureSchema, MIGRATION_SQL
packages/stores/src/durable-objects.ts      IdempotencyObject (DurableObject with RPC), DurableObjectsStore
packages/stores/src/index.ts                re-exports the codec only (the stores are subpaths)
packages/stores/migrations/postgres/0001_anyonce.sql
packages/stores/migrations/d1/0001_anyonce.sql
packages/stores/test/*.test.ts              codec, sql text, adapter shape tests (no services)
packages/stores/services/*.test.ts          contract suite and conformance per store (Bun, need containers)
packages/stores/workers/*.test.ts           D1 and Durable Objects (vitest-pool-workers)
packages/core/src/testing/index.ts          StoreHarness.maxResultBytes
go/storetest/storetest.go                   Harness.MaxResultBytes
go/store/dynamodb/{dynamodb.go,dynamodb_test.go}
go/store/redis/{redis.go,scripts.go,redis_test.go}
go/store/postgres/{postgres.go,schema.sql (embedded),postgres_test.go}
go/store/sqlite/{sqlite.go,schema.sql (embedded),sqlite_test.go}
go/store/internal/rowcodec/rowcodec.go      shared result meta JSON codec for the Go stores
go/go.mod, go/go.sum                        new requirements
docs/stores.md                              guarantees matrix, one row per store, KV rationale
test/compose.yml                            unchanged (services already declared)
test/workers/wrangler.jsonc                 main worker, DO binding and migration, D1 binding
test/workers/worker.ts                      exports IdempotencyObject for the pool
test/workers/vitest.config.ts               include packages/stores/workers, D1 migrations binding, setup file
test/workers/setup-d1.ts                    applyD1Migrations
.github/workflows/ci.yml                    services job runs Go store tests too; workers job builds first (already)
package.json                                scripts: test (explicit package list), test:services (compose plus packages/stores/services)
scripts/reqs.ts                             no change (walks services/ and workers/ because the files end in .test.ts)
.changeset/p3-stores.md
```

---

### Task 1: Scaffold, shared codec and SQL, suite cap, workers wiring, docs skeleton, integration PR (REQ-ST-KV-1, REQ-STORE-11 cap, REQ-REL-4)

**Files:**
- Create: `packages/stores/package.json`, `packages/stores/tsconfig.json`, `packages/stores/tsup.config.ts`, `packages/stores/src/codec.ts`, `packages/stores/src/sql.ts`, `packages/stores/src/index.ts`, `packages/stores/test/codec.test.ts`, `packages/stores/test/sql.test.ts`, `packages/stores/test/package.test.ts`, `docs/stores.md`, `test/workers/worker.ts`, `test/workers/setup-d1.ts`, `.changeset/p3-stores.md`
- Modify: `packages/core/src/testing/index.ts` (harness cap), `go/storetest/storetest.go` (harness cap), `package.json` (scripts, devDependencies), `test/workers/vitest.config.ts`, `test/workers/wrangler.jsonc`, `test/workers/tsconfig.json`, `.github/workflows/ci.yml`, `test/ci.test.ts`, `CLAUDE.md` (commands)

**Interfaces:**
- Produces: `RecordRow`, `encodeResultMeta(result)`, `decodeResultMeta(text)`, `rowToRecord(row)`, `newRow(op, opts, fence)`; `SQLITE_SCHEMA`, `POSTGRES_SCHEMA`, `BEGIN_SQL`, `COMPLETE_SQL`, `ABANDON_SQL`, `GET_SQL`, `PURGE_SQL`, `SELECT_SQL` for the SQLite dialect and `pgSql(text)` that rewrites `?N` placeholders to `$N`; `StoreHarness.maxResultBytes`; Go `Harness.MaxResultBytes`. Tasks 2 to 11 consume them.

- [ ] **Step 1: Suite cap in both languages, tests first**

`packages/core/test/testing-cap.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory';
import { storeContractSuite } from '../src/testing/index';

describe('contract suite cap', () => {
  test('REQ-STORE-11: the suite reads maxResultBytes from the harness and defaults to 1 MiB', async () => {
    const seen: string[] = [];
    let bodyLength = 0;
    const runner = {
      describe: (_n: string, fn: () => void) => fn(),
      test: (name: string, fn: () => Promise<void>) => {
        if (name.startsWith('REQ-STORE-11')) seen.push(name);
      },
      expect: () => ({ toBe() {}, toEqual() {}, toBeNull() {}, toBeUndefined() {}, toBeGreaterThan() {} }),
    };
    storeContractSuite('cap', () => ({ store: new MemoryStore(), maxResultBytes: 4096 }), runner);
    expect(seen).toEqual(['REQ-STORE-11: a body of exactly maxResultBytes (4096 bytes) round trips byte-exact']);
    storeContractSuite('default', () => ({ store: new MemoryStore() }), {
      ...runner,
      test: (name: string) => {
        if (name.startsWith('REQ-STORE-11')) bodyLength = Number(/\((\d+) bytes\)/.exec(name)?.[1]);
      },
    });
    expect(bodyLength).toBe(1_048_576);
  });
});
```

Run: `bun test packages/core/test/testing-cap.test.ts`
Expected: FAIL (the test name still says 1 MiB and the harness field is ignored).

In `packages/core/src/testing/index.ts`: add `maxResultBytes?: number;` to `StoreHarness` with the doc comment `/** Q20: the largest body this backend stores whole. Defaults to MAX_RESULT_BYTES. */`. The REQ-STORE-11 test becomes: the factory is invoked inside `withHarness` after the name is fixed, so read the cap through a small pre-step: change `storeContractSuite` to resolve the cap once with `const capPromise = Promise.resolve(factory()).then(async (h) => { const cap = h.maxResultBytes ?? MAX_RESULT_BYTES; if (h.close) await h.close(); else await h.store.close?.(); return cap; })` is not acceptable because the runner registers tests synchronously. Instead register the test with a name that carries the cap the harness will declare by accepting an optional third argument on the suite: `storeContractSuite(name, factory, runner, options: { maxResultBytes?: number } = {})`, with the test named `` `REQ-STORE-11: a body of exactly maxResultBytes (${cap} bytes) round trips byte-exact` `` where `cap = options.maxResultBytes ?? MAX_RESULT_BYTES`, and inside the test assert the harness agrees: `expect(h.maxResultBytes ?? MAX_RESULT_BYTES).toBe(cap)`. Update the test above to pass `{ maxResultBytes: 4096 }` as the fourth argument for the `cap` suite (keep the harness field too, so the two must agree). The body loop and the byte-exact assertion use `cap`.

Go, `go/storetest/storetest.go`: add `MaxResultBytes int` to `Harness` (doc comment as above, zero means `MaxResultBytes`), and in the REQ-STORE-11 subtest use `cap := h.MaxResultBytes; if cap == 0 { cap = MaxResultBytes }` for the body size. Add to `go/storetest/storetest_test.go` a subtest `REQ-STORE-11: a harness cap below 1 MiB shrinks the round trip body` that runs `Run` against the memory store with `MaxResultBytes: 4096` through a `testing.T` wrapper and asserts it passes (the existing storetest_test.go already runs `Run` under a subprocess or wrapper; follow its pattern).

Run: `bun test packages/core`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./storetest/ ./store/memory/`
Expected: PASS.

- [ ] **Step 2: Package scaffold**

`packages/stores/package.json`:

```json
{
  "name": "@anyonce/stores",
  "version": "0.0.0",
  "description": "anyonce idempotency stores: DynamoDB, Redis, Postgres, D1 and Durable Objects",
  "license": "Apache-2.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./dynamodb": { "types": "./dist/dynamodb.d.ts", "import": "./dist/dynamodb.js", "require": "./dist/dynamodb.cjs" },
    "./redis": { "types": "./dist/redis.d.ts", "import": "./dist/redis.js", "require": "./dist/redis.cjs" },
    "./postgres": { "types": "./dist/postgres.d.ts", "import": "./dist/postgres.js", "require": "./dist/postgres.cjs" },
    "./d1": { "types": "./dist/d1.d.ts", "import": "./dist/d1.js", "require": "./dist/d1.cjs" },
    "./durable-objects": { "types": "./dist/durable-objects.d.ts", "import": "./dist/durable-objects.js", "require": "./dist/durable-objects.cjs" }
  },
  "files": ["dist", "migrations"],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@anyonce/core": "workspace:*",
    "@aws-sdk/client-dynamodb": ">=3.600.0",
    "@cloudflare/workers-types": ">=4.20240925.0",
    "@upstash/redis": ">=1.30.0",
    "ioredis": ">=5.0.0",
    "pg": ">=8.11.0",
    "postgres": ">=3.4.0",
    "redis": ">=4.6.0"
  },
  "peerDependenciesMeta": {
    "@aws-sdk/client-dynamodb": { "optional": true },
    "@cloudflare/workers-types": { "optional": true },
    "@upstash/redis": { "optional": true },
    "ioredis": { "optional": true },
    "pg": { "optional": true },
    "postgres": { "optional": true },
    "redis": { "optional": true }
  },
  "devDependencies": {
    "@anyonce/conformance": "workspace:*",
    "@anyonce/core": "workspace:*",
    "@anyonce/fixture-hono": "workspace:*",
    "@aws-sdk/client-dynamodb": "^3.1134.0",
    "@cloudflare/workers-types": "^5.20260916.1",
    "@types/pg": "^8.15.0",
    "@upstash/redis": "^1.38.4",
    "ioredis": "^6.0.0",
    "pg": "^8.23.0",
    "postgres": "^3.4.9",
    "redis": "^6.2.1"
  }
}
```

`packages/stores/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["bun-types", "@cloudflare/workers-types"] }, "include": ["src", "test", "services", "tsup.config.ts"] }` (the workers tests have their own tsconfig through test/workers).

`packages/stores/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    dynamodb: 'src/dynamodb.ts',
    redis: 'src/redis.ts',
    postgres: 'src/postgres.ts',
    d1: 'src/d1.ts',
    'durable-objects': 'src/durable-objects.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['cloudflare:workers'],
});
```

`packages/stores/test/package.test.ts` (mirrors core's hygiene test):

```ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');
const NODE_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:[a-z_/]+["']/;

describe('package hygiene', () => {
  test('REQ-ST-KV-1: the package declares five store subpaths, no dependencies, and optional peers only', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: unknown;
      exports: Record<string, Record<string, string>>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './d1', './durable-objects', './dynamodb', './postgres', './redis']);
    expect(Object.keys(pkg.exports)).not.toContain('./kv');
    for (const entry of Object.values(pkg.exports)) expect(Object.keys(entry)).toEqual(['types', 'import', 'require']);
    for (const meta of Object.values(pkg.peerDependenciesMeta)) expect(meta.optional).toBe(true);
  });

  test('REQ-ST-D1-1: no source file imports a node: module, so the D1 and Durable Object entries run in workerd', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(join(pkgDir, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(NODE_SPECIFIER_PATTERN);
  });
});
```

- [ ] **Step 3: Codec, tests first**

`packages/stores/test/codec.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { IdempotencyRecord, OmittedResult, StoredResult } from '@anyonce/core';
import { decodeResultMeta, encodeResultMeta, newRow, rowToRecord } from '../src/codec';

const op = { scope: 'POST /p', key: 'k', fingerprint: 'fp' };
const T0 = 1_700_000_000_000;

describe('codec', () => {
  test('REQ-STORE-4: result meta round trips kind, status, headers, outcome and error without the body', () => {
    const result: StoredResult = {
      kind: 'message',
      status: 201,
      headers: [['content-type', 'text/plain'], ['set-cookie', 'a=1']],
      outcome: 'error',
      error: { name: 'E', message: 'boom' },
      body: new Uint8Array([1]),
    };
    const meta = encodeResultMeta(result);
    expect(JSON.parse(meta)).toEqual({ kind: 'message', status: 201, headers: [['content-type', 'text/plain'], ['set-cookie', 'a=1']], outcome: 'error', error: { name: 'E', message: 'boom' } });
    expect(decodeResultMeta(meta)).toEqual({ kind: 'message', status: 201, headers: [['content-type', 'text/plain'], ['set-cookie', 'a=1']], outcome: 'error', error: { name: 'E', message: 'boom' } });
  });

  test('REQ-STORE-10: the omitted form encodes status and headers and the row flags result_omitted', () => {
    const omitted: OmittedResult = { omitted: true, kind: 'http', status: 200, headers: [['x', 'y']] };
    expect(JSON.parse(encodeResultMeta(omitted))).toEqual({ kind: 'http', status: 200, headers: [['x', 'y']] });
  });

  test('REQ-STORE-1: newRow builds an in_flight row from the op, the options and the fence', () => {
    expect(newRow(op, { leaseMs: 30_000, ttlMs: 86_400_000, now: T0 }, 2)).toEqual({
      scope: 'POST /p', key: 'k', fingerprint: 'fp', state: 'in_flight', fence: 2,
      lease_until: T0 + 30_000, created_at: T0, expires_at: T0 + 86_400_000,
      result_meta: null, result_body: null, result_omitted: 0,
    });
  });

  test('REQ-STORE-4: rowToRecord decodes a completed row into an IdempotencyRecord with the body', () => {
    const record: IdempotencyRecord = rowToRecord({
      scope: 'POST /p', key: 'k', fingerprint: 'fp', state: 'completed', fence: 1,
      lease_until: T0 + 1, created_at: T0, expires_at: T0 + 2,
      result_meta: '{"kind":"http","status":201,"headers":[["content-type","text/plain"]]}',
      result_body: new Uint8Array([1, 2]), result_omitted: 0,
    });
    expect(record).toEqual({
      scope: 'POST /p', key: 'k', fingerprint: 'fp', state: 'completed', fence: 1,
      leaseUntil: T0 + 1, createdAt: T0, expiresAt: T0 + 2,
      result: { kind: 'http', status: 201, headers: [['content-type', 'text/plain']], body: new Uint8Array([1, 2]) },
    });
  });

  test('REQ-STORE-10: rowToRecord marks resultOmitted and leaves the body out; an in_flight row has no result', () => {
    const omitted = rowToRecord({ scope: 's', key: 'k', fingerprint: 'f', state: 'completed', fence: 1, lease_until: 0, created_at: 0, expires_at: 9, result_meta: '{"kind":"http","status":200}', result_body: null, result_omitted: 1 });
    expect(omitted.resultOmitted).toBe(true);
    expect(omitted.result).toEqual({ kind: 'http', status: 200 });
    const inFlight = rowToRecord({ scope: 's', key: 'k', fingerprint: 'f', state: 'in_flight', fence: 1, lease_until: 0, created_at: 0, expires_at: 9, result_meta: null, result_body: null, result_omitted: 0 });
    expect(inFlight.result).toBeUndefined();
    expect(inFlight.resultOmitted).toBeUndefined();
  });

  test('REQ-STORE-4: numeric columns that arrive as strings or bigints (Postgres drivers) decode to numbers', () => {
    const record = rowToRecord({ scope: 's', key: 'k', fingerprint: 'f', state: 'in_flight', fence: '3' as unknown as number, lease_until: BigInt(5) as unknown as number, created_at: '1', expires_at: 9, result_meta: null, result_body: null, result_omitted: '0' as unknown as number });
    expect(record.fence).toBe(3);
    expect(record.leaseUntil).toBe(5);
    expect(record.createdAt).toBe(1);
  });
});
```

Run: `bun test packages/stores/test/codec.test.ts`
Expected: FAIL (module missing). Run `bun install` first so the workspace links the new package.

`packages/stores/src/codec.ts`:

```ts
import type { BeginOptions, IdempotencyRecord, OmittedResult, Operation, StoredResult } from '@anyonce/core';

/** The flat row every store persists (plan Global Constraints). Numbers are epoch milliseconds. */
export interface RecordRow {
  scope: string;
  key: string;
  fingerprint: string;
  state: 'in_flight' | 'completed';
  fence: number;
  lease_until: number;
  created_at: number;
  expires_at: number;
  result_meta: string | null;
  result_body: Uint8Array | null;
  result_omitted: number;
}

/** Everything in a result except the body, as JSON text. Works for the omitted form too. */
export function encodeResultMeta(result: StoredResult | OmittedResult): string {
  const meta: Record<string, unknown> = { kind: result.kind };
  if (result.status !== undefined) meta.status = result.status;
  if (result.headers !== undefined) meta.headers = result.headers;
  if ('outcome' in result && result.outcome !== undefined) meta.outcome = result.outcome;
  if ('error' in result && result.error !== undefined) meta.error = result.error;
  return JSON.stringify(meta);
}

export function decodeResultMeta(text: string): StoredResult {
  const meta = JSON.parse(text) as Partial<StoredResult> & { kind: StoredResult['kind'] };
  const out: StoredResult = { kind: meta.kind };
  if (meta.status !== undefined) out.status = meta.status;
  if (meta.headers !== undefined) out.headers = meta.headers;
  if (meta.outcome !== undefined) out.outcome = meta.outcome;
  if (meta.error !== undefined) out.error = meta.error;
  return out;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

export function newRow(op: Operation, opts: BeginOptions, fence: number): RecordRow {
  return {
    scope: op.scope,
    key: op.key,
    fingerprint: op.fingerprint,
    state: 'in_flight',
    fence,
    lease_until: opts.now + opts.leaseMs,
    created_at: opts.now,
    expires_at: opts.now + opts.ttlMs,
    result_meta: null,
    result_body: null,
    result_omitted: 0,
  };
}

/** Drivers return bigint, string or number for integer columns; every store goes through here. */
export function rowToRecord(row: RecordRow): IdempotencyRecord {
  const record: IdempotencyRecord = {
    scope: row.scope,
    key: row.key,
    fingerprint: row.fingerprint,
    state: row.state,
    fence: num(row.fence),
    leaseUntil: num(row.lease_until),
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
  };
  if (row.result_meta !== null && row.result_meta !== undefined) {
    const result = decodeResultMeta(row.result_meta);
    if (row.result_body !== null && row.result_body !== undefined) result.body = new Uint8Array(row.result_body);
    record.result = result;
  }
  if (num(row.result_omitted) === 1) record.resultOmitted = true;
  return record;
}
```

`packages/stores/src/index.ts`: `export type { RecordRow } from './codec'; export { decodeResultMeta, encodeResultMeta, newRow, rowToRecord } from './codec';`

- [ ] **Step 4: Shared SQL, tests first**

`packages/stores/test/sql.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ABANDON_SQL, BEGIN_SQL, COMPLETE_SQL, GET_SQL, PURGE_SQL, SELECT_SQL, SQLITE_SCHEMA, pgSql } from '../src/sql';

describe('shared sql', () => {
  test('REQ-ST-D1-1: begin is one INSERT ON CONFLICT DO UPDATE with the TTL and lease conditions and the fence formula', () => {
    expect(BEGIN_SQL).toContain('INSERT INTO anyonce_records');
    expect(BEGIN_SQL).toContain('ON CONFLICT(scope, key) DO UPDATE SET');
    expect(BEGIN_SQL).toContain('fence = anyonce_records.fence + 1');
    expect(BEGIN_SQL).toContain('WHERE anyonce_records.expires_at <= ?4');
    expect(BEGIN_SQL).toContain("anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4");
    expect(BEGIN_SQL.trim().endsWith('RETURNING fence')).toBe(true);
    expect(BEGIN_SQL.split(';').filter((s) => s.trim()).length).toBe(1);
  });

  test('REQ-ST-D1-1: complete and abandon are single conditional statements on fence and state', () => {
    expect(COMPLETE_SQL).toContain("state = 'completed'");
    expect(COMPLETE_SQL).toContain('WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = \'in_flight\'');
    expect(ABANDON_SQL).toContain("DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'");
    expect(GET_SQL).toContain('expires_at > ?3');
    expect(PURGE_SQL).toContain('DELETE FROM anyonce_records WHERE expires_at <= ?1');
    expect(SELECT_SQL).toContain('WHERE scope = ?1 AND key = ?2');
  });

  test('REQ-ST-PG-1: pgSql rewrites ?N placeholders to $N without touching quoted text', () => {
    expect(pgSql('SELECT ?1, ?2 FROM t WHERE x = ?10')).toBe('SELECT $1, $2 FROM t WHERE x = $10');
    expect(pgSql("SELECT '?1' FROM t WHERE y = ?1")).toBe("SELECT '?1' FROM t WHERE y = $1");
  });

  test('REQ-ST-D1-1: the schema creates the table with a composite primary key and an index on expires_at', () => {
    expect(SQLITE_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS anyonce_records');
    expect(SQLITE_SCHEMA).toContain('PRIMARY KEY (scope, key)');
    expect(SQLITE_SCHEMA).toContain('CREATE INDEX IF NOT EXISTS anyonce_records_expires_at');
  });
});
```

`packages/stores/src/sql.ts`:

```ts
/**
 * Statements shared by the SQLite dialect stores (D1, Durable Objects) and, through pgSql, Postgres.
 * Parameters: begin ?1 scope, ?2 key, ?3 fingerprint, ?4 now, ?5 leaseMs, ?6 ttlMs.
 */
export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS anyonce_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  result_meta TEXT,
  result_body BLOB,
  result_omitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_records_expires_at ON anyonce_records (expires_at);
`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS anyonce_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  fence BIGINT NOT NULL,
  lease_until BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  result_meta TEXT,
  result_body BYTEA,
  result_omitted SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS anyonce_records_expires_at ON anyonce_records (expires_at);
`;

/** D4: the claim is this one statement. A refused write returns no row; SELECT_SQL then classifies it. */
export const BEGIN_SQL = `
INSERT INTO anyonce_records (scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted)
VALUES (?1, ?2, ?3, 'in_flight', 1, ?4 + ?5, ?4, ?4 + ?6, NULL, NULL, 0)
ON CONFLICT(scope, key) DO UPDATE SET
  fingerprint = excluded.fingerprint,
  state = 'in_flight',
  fence = anyonce_records.fence + 1,
  lease_until = excluded.lease_until,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  result_meta = NULL,
  result_body = NULL,
  result_omitted = 0
WHERE anyonce_records.expires_at <= ?4
   OR (anyonce_records.fingerprint = excluded.fingerprint AND anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4)
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 fence, ?4 now, ?5 result_meta, ?6 result_body, ?7 result_omitted. */
export const COMPLETE_SQL = `
UPDATE anyonce_records SET state = 'completed', result_meta = ?5, result_body = ?6, result_omitted = ?7
WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight'
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 fence. */
export const ABANDON_SQL = `
DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight'
RETURNING fence`;

/** ?1 scope, ?2 key, ?3 now. */
export const GET_SQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND expires_at > ?3`;

/** ?1 scope, ?2 key: the raw row, expired or not, used to classify a refused write. */
export const SELECT_SQL = `
SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted
FROM anyonce_records WHERE scope = ?1 AND key = ?2`;

/** ?1 now. */
export const PURGE_SQL = `DELETE FROM anyonce_records WHERE expires_at <= ?1 RETURNING scope`;

/** ?1 scope, ?2 key: test-only physical removal. */
export const REMOVE_SQL = `DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2`;

/** Rewrites ?N placeholders to $N for Postgres, leaving single-quoted text alone. */
export function pgSql(text: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && ch === '?' && /[0-9]/.test(text[i + 1] ?? '')) {
      out += '$';
      continue;
    }
    out += ch;
  }
  return out;
}
```

Run: `bun test packages/stores`
Expected: PASS (codec, sql, package tests).

- [ ] **Step 5: Root scripts, workers wiring, CI, docs skeleton, changeset**

Root `package.json`:
- `"test": "bun test packages/core packages/hono packages/conformance conformance scripts test/ci.test.ts packages/stores/test"`
- `"test:services": "bun test test/compose.test.ts packages/stores/services"`
- devDependencies: add `"@anyonce/stores": "workspace:*"` (the workers pool resolves it).

`test/workers/wrangler.jsonc`:

```jsonc
{
  "name": "anyonce-workers-tests",
  "main": "./worker.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "IDEMPOTENCY", "class_name": "IdempotencyObject" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["IdempotencyObject"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "anyonce-test", "database_id": "anyonce-test" }]
}
```

`test/workers/worker.ts` (Task 6 fills the class; until then it re-exports a placeholder so the pool starts):

```ts
export { IdempotencyObject } from '@anyonce/stores/durable-objects';
export default { fetch: () => new Response('anyonce workers test host') };
```

Because `@anyonce/stores/durable-objects` does not exist until Task 6, create `packages/stores/src/durable-objects.ts` now with the minimal exported class so the build, the pool and the typecheck pass:

```ts
import { DurableObject } from 'cloudflare:workers';

/** Placeholder until the Durable Objects store task lands; keeps the workers test host bootable. */
export class IdempotencyObject extends DurableObject {}
```

`test/workers/vitest.config.ts`:

```ts
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('packages/stores/migrations/d1');
  return {
    test: {
      include: ['test/workers/**/*.test.ts', 'packages/stores/workers/**/*.test.ts'],
      testTimeout: 60_000,
      setupFiles: ['./test/workers/setup-d1.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

`packages/stores/migrations/d1/0001_anyonce.sql`: the `SQLITE_SCHEMA` text (kept in sync by a test in Task 5).

`test/workers/setup-d1.ts`:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    IDEMPOTENCY: DurableObjectNamespace;
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`test/workers/tsconfig.json`: add `"../../packages/stores/workers"` to `include` if it lists paths, or keep `"."` and add a second tsconfig under `packages/stores/workers/tsconfig.json` extending it with `"include": ["."]`; wire `bun run typecheck` to check it (root `typecheck` script gains `tsc --noEmit -p packages/stores/workers/tsconfig.json`).

`.github/workflows/ci.yml`, `services` job: after `bun run services:check` add

```yaml
      - uses: actions/setup-go@v5
        with:
          go-version: stable
      - name: go store tests against the services
        working-directory: go
        env:
          ANYONCE_REQUIRE_SERVICES: '1'
        run: go test -race -count=1 ./store/...
```

and keep the `bun run test:services` step (it now includes `packages/stores/services`). `test/ci.test.ts`: add `REQ-REL-4: the services job runs the Go store tests with services required` asserting the run text contains `go test -race -count=1 ./store/...` and the env var.

`docs/stores.md` skeleton:

```markdown
# Stores

Every store implements the same `Store` contract (requirements 4.2) and passes the same suite (`@anyonce/core/testing`, `go/storetest`). `begin` is one atomic operation everywhere; the mechanism differs per backend and is named below. Logical expiry is always the caller's clock against `expires_at`; native TTL, where the backend has one, is a safety net scheduled after logical expiry.

| Store | Languages | Consistency | Atomicity of begin | Native TTL | Setup | Cost note | Max stored body |
|---|---|---|---|---|---|---|---|
| memory | TS, Go | single process | mutex or single event loop | no, purge | none | free | 1 MiB |

Rows for DynamoDB, Redis, Postgres, D1, Durable Objects and SQLite are added by their store PRs.

## Cloudflare KV is not a store (REQ-ST-KV-1)

KV is eventually consistent across edge locations: two Workers in different colos can both read "absent" and both write a claim, so the REQ-STORE-8 race (50 concurrent begins, exactly one acquired) cannot be met. Use the Durable Objects store (one object per scope, single-writer) or the D1 store (one conditional statement) instead. Both run on Workers with no extra service.
```

`.changeset/p3-stores.md`:

```markdown
---
"@anyonce/stores": minor
"@anyonce/core": patch
---

Stores: DynamoDB, Redis, Postgres, D1 and Durable Objects for @anyonce/stores; the contract suite reads the result cap from the harness (Q20).
```

`CLAUDE.md` commands: `bun run test:services` now needs the compose stack and runs the store suites; `bun run test:workers` runs the D1 and Durable Objects suites; Go store tests read `ANYONCE_REQUIRE_SERVICES`.

- [ ] **Step 6: Verify and open the integration PR**

Run: `bun install`, `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`, `bun run test:workers` (the P2 tests plus the empty stores include), `bun test test/ci.test.ts`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`, `bun run test:reqs`
Expected: all green; `test:reqs` for phase p3 lists REQ-ST-DO-1, REQ-ST-D1-1, REQ-ST-DDB-1, REQ-ST-REDIS-1, REQ-ST-PG-1, REQ-ST-SQLITE-1 as uncovered until their tasks land (change `test:reqs` to `--phase p3` in this task; the integration PR stays draft until Task 11).

Commit on `p3-stores`, push, open the draft PR:

```bash
git add -A
git commit -m "feat(stores): P3 scaffold, shared codec and SQL, suite result cap (Q20), workers wiring, docs skeleton"
git push -u origin p3-stores
gh pr create --draft --base main --head p3-stores --title "P3: stores" --body "Part of #1. Integration branch for the P3 store PRs; marked ready when every store has merged."
```

---
### Task 2: TypeScript DynamoDB store (REQ-ST-DDB-1)

Branch `p3-store-dynamodb-ts` from `p3-stores`; PR to `p3-stores`, `Part of #1`, body carries the condition and update expressions.

**Files:**
- Create: `packages/stores/src/dynamodb.ts`, `packages/stores/services/dynamodb.test.ts`, `packages/stores/services/dynamodb.conformance.test.ts`, `packages/stores/services/services.ts` (shared skip helper)
- Modify: `docs/stores.md` (row)

**Interfaces:**
- Consumes: `RecordRow`, `encodeResultMeta`, `rowToRecord` from `./codec`; `Store`, `BeginOutcome`, `CompleteStatus`, `IdempotencyRecord`, `OmittedResult`, `Operation`, `StoredResult`, `BeginOptions`, `isOmitted` from `@anyonce/core`; `DynamoDBClient` and commands from `@aws-sdk/client-dynamodb`.
- Produces: `DynamoDbStore`, `DynamoDbStoreOptions`, `ensureTable(client, tableName?)`, `DYNAMODB_MAX_RESULT_BYTES = 307200`; the services helper `serviceUp(port)` and `describeService(name, port, fn)`.

- [ ] **Step 1: Services helper**

`packages/stores/services/services.ts`:

```ts
import { describe, test } from 'bun:test';
import { connect } from 'node:net';

export function tcpOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Registers the suite when the service answers; otherwise one skipped test that names the fix. */
export async function describeService(name: string, port: number, fn: () => void): Promise<void> {
  const up = await tcpOpen(port);
  if (up) {
    describe(name, fn);
    return;
  }
  test.skip(`${name}: service down on 127.0.0.1:${port}; run docker compose -f test/compose.yml up -d --wait`, () => {});
}
```

(A skipped test is what `scripts/no-skips.sh` catches in CI's `services` job, which is the intended failure mode when a container is missing.)

- [ ] **Step 2: Write the failing tests**

`packages/stores/services/dynamodb.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { DescribeTimeToLiveCommand, DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { LEASE_MS, storeContractSuite, T0, TTL_MS } from '@anyonce/core/testing';
import { DYNAMODB_MAX_RESULT_BYTES, DynamoDbStore, ensureTable } from '../src/dynamodb';
import { describeService } from './services';

const TABLE = `anyonce_test_${Date.now()}`;

function client(): DynamoDBClient {
  return new DynamoDBClient({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:18000',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

await describeService('dynamodb store', 18000, () => {
  const shared = client();
  const ready = ensureTable(shared, TABLE);

  storeContractSuite(
    'dynamodb',
    async () => {
      await ready;
      const store = new DynamoDbStore({ client: shared, tableName: TABLE });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op), maxResultBytes: DYNAMODB_MAX_RESULT_BYTES };
    },
    { describe, test, expect },
    { maxResultBytes: DYNAMODB_MAX_RESULT_BYTES },
  );

  describe('dynamodb specifics', () => {
    test('REQ-ST-DDB-1: a refused begin classifies the outcome from ReturnValuesOnConditionCheckFailure with no second call', async () => {
      await ready;
      let commands: string[] = [];
      const counting = client();
      counting.middlewareStack.add(
        (next, context) => async (args) => {
          commands.push(context.commandName ?? 'unknown');
          return next(args);
        },
        { step: 'initialize', name: 'count', priority: 'low' },
      );
      const store = new DynamoDbStore({ client: counting, tableName: TABLE });
      const op = { scope: `rvocf-${Date.now()}`, key: 'k', fingerprint: 'a' };
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
      await store.complete(op, 1, { kind: 'http', status: 200, body: new Uint8Array([1]) }, T0 + 1);
      commands = [];
      const mismatch = await store.begin({ ...op, fingerprint: 'b' }, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 2 });
      expect(mismatch.outcome).toBe('mismatch');
      expect(commands).toEqual(['UpdateItemCommand']);
      commands = [];
      const completed = await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 3 });
      expect(completed.outcome).toBe('completed');
      if (completed.outcome === 'completed') expect(completed.record.result?.body).toEqual(new Uint8Array([1]));
      expect(commands).toEqual(['UpdateItemCommand']);
      counting.destroy();
    });

    test('REQ-ST-DDB-1: the ttl attribute is enabled on the table and set relative to the wall clock plus the grace', async () => {
      await ready;
      const ttlSpec = await shared.send(new DescribeTimeToLiveCommand({ TableName: TABLE }));
      expect(ttlSpec.TimeToLiveDescription?.TimeToLiveStatus).toBe('ENABLED');
      expect(ttlSpec.TimeToLiveDescription?.AttributeName).toBe('ttl');
      const store = new DynamoDbStore({ client: shared, tableName: TABLE, nativeTtlGraceMs: 60_000 });
      const op = { scope: `ttl-${Date.now()}`, key: 'k', fingerprint: 'a' };
      const before = Date.now();
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: 5_000, now: T0 });
      const item = await shared.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: op.scope }, sk: { S: op.key } }, ConsistentRead: true }));
      const ttl = Number(item.Item?.ttl?.N);
      expect(ttl).toBeGreaterThan(Math.floor((before + 5_000 + 60_000) / 1000) - 2);
      expect(ttl).toBeLessThan(Math.floor((before + 5_000 + 60_000) / 1000) + 5);
      expect(Number(item.Item?.expires_at?.N)).toBe(T0 + 5_000);
    });

    test('REQ-ST-DDB-1: purge is a no-op that returns 0 and ensureTable is idempotent', async () => {
      await ready;
      const store = new DynamoDbStore({ client: shared, tableName: TABLE });
      expect(await store.purge(Date.now())).toBe(0);
      await ensureTable(shared, TABLE);
    });
  });
});
```

`packages/stores/services/dynamodb.conformance.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DYNAMODB_MAX_RESULT_BYTES, DynamoDbStore, ensureTable } from '../src/dynamodb';
import { describeService } from './services';

await describeService('dynamodb conformance', 18000, () => {
  test('REQ-ST-DDB-1: every core and profile vector passes through withIdempotency with the DynamoDB store', async () => {
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:18000', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
    const table = `anyonce_conf_${Date.now()}`;
    await ensureTable(client, table);
    const store = new DynamoDbStore({ client, tableName: table });
    const handler = withIdempotency(createFixtureApp().fetch, {
      store,
      required: true,
      ttlMs: 2000,
      maxResultBytes: DYNAMODB_MAX_RESULT_BYTES,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'], report: 'markdown' });
    const notPassing = summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.passed).toBe(20);
    client.destroy();
  }, 60_000);
});
```

Run: `docker compose -f test/compose.yml up -d --wait dynamodb`, then `bun test packages/stores/services/dynamodb.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement dynamodb.ts**

```ts
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import {
  type AttributeValue,
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  GetItemCommand,
  ResourceInUseException,
  UpdateItemCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';

/** Q20: a DynamoDB item is capped at 400 KB, so bodies above this are stored in the omitted form. */
export const DYNAMODB_MAX_RESULT_BYTES = 307_200;

export interface DynamoDbStoreOptions {
  client: DynamoDBClient;
  /** Default anyonce_records. Keys pk (scope) and sk (key). */
  tableName?: string;
  /** Added to the native ttl attribute so a late complete from the previous fence holder still finds its row. Default 60000. */
  nativeTtlGraceMs?: number;
}

type Item = Record<string, AttributeValue>;

function n(value: number): AttributeValue {
  return { N: String(value) };
}

function itemToRow(item: Item): RecordRow {
  return {
    scope: item.pk?.S ?? '',
    key: item.sk?.S ?? '',
    fingerprint: item.fingerprint?.S ?? '',
    state: (item.state?.S as RecordRow['state']) ?? 'in_flight',
    fence: Number(item.fence?.N ?? 0),
    lease_until: Number(item.lease_until?.N ?? 0),
    created_at: Number(item.created_at?.N ?? 0),
    expires_at: Number(item.expires_at?.N ?? 0),
    result_meta: item.result_meta?.S ?? null,
    result_body: item.result_body?.B ?? null,
    result_omitted: Number(item.result_omitted?.N ?? 0),
  };
}

/**
 * REQ-ST-DDB-1. begin, complete and abandon are each one conditional write; a refused write carries the old item
 * back through ReturnValuesOnConditionCheckFailure, so no second read is needed to classify it.
 */
export class DynamoDbStore implements Store {
  private readonly client: DynamoDBClient;
  private readonly table: string;
  private readonly grace: number;

  constructor(options: DynamoDbStoreOptions) {
    this.client = options.client;
    this.table = options.tableName ?? 'anyonce_records';
    this.grace = options.nativeTtlGraceMs ?? 60_000;
  }

  private key(op: Pick<Operation, 'scope' | 'key'>): Item {
    return { pk: { S: op.scope }, sk: { S: op.key } };
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ttlSeconds = Math.floor((Date.now() + opts.ttlMs + this.grace) / 1000);
      try {
        const out = await this.client.send(
          new UpdateItemCommand({
            TableName: this.table,
            Key: this.key(op),
            ConditionExpression:
              'attribute_not_exists(pk) OR expires_at <= :now OR (fingerprint = :fp AND #state = :in_flight AND lease_until <= :now)',
            UpdateExpression:
              'SET fingerprint = :fp, #state = :in_flight, fence = if_not_exists(fence, :zero) + :one, lease_until = :lease, created_at = :now, expires_at = :exp, #ttl = :ttl, result_omitted = :zero REMOVE result_meta, result_body',
            ExpressionAttributeNames: { '#state': 'state', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':fp': { S: op.fingerprint },
              ':in_flight': { S: 'in_flight' },
              ':now': n(opts.now),
              ':zero': n(0),
              ':one': n(1),
              ':lease': n(opts.now + opts.leaseMs),
              ':exp': n(opts.now + opts.ttlMs),
              ':ttl': n(ttlSeconds),
            },
            ReturnValues: 'ALL_NEW',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        );
        return { outcome: 'acquired', fence: Number(out.Attributes?.fence?.N) };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException) || error.Item === undefined) throw error;
        const row = itemToRow(error.Item as Item);
        if (row.expires_at <= opts.now) continue;
        const record = rowToRecord(row);
        if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
        if (row.state === 'completed') return { outcome: 'completed', record };
        if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
      }
    }
    throw new Error('anyonce: dynamodb begin could not settle after three attempts');
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? undefined : result.body;
    const values: Item = {
      ':fence': n(fence),
      ':now': n(now),
      ':in_flight': { S: 'in_flight' },
      ':completed': { S: 'completed' },
      ':meta': { S: encodeResultMeta(result) },
      ':om': n(omitted ? 1 : 0),
    };
    let update = 'SET #state = :completed, result_meta = :meta, result_omitted = :om';
    if (body !== undefined) {
      values[':body'] = { B: body };
      update += ', result_body = :body';
    } else {
      update += ' REMOVE result_body';
    }
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.table,
          Key: this.key(op),
          ConditionExpression: 'fence = :fence AND expires_at > :now AND #state = :in_flight',
          UpdateExpression: update,
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: values,
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (error.Item === undefined) return 'not_found';
      const row = itemToRow(error.Item as Item);
      if (row.expires_at <= now) return 'not_found';
      if (row.fence !== fence) return 'stale_fence';
      return 'ok';
    }
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: this.key(op),
          ConditionExpression: 'fence = :fence AND #state = :in_flight',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':fence': n(fence), ':in_flight': { S: 'in_flight' } },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (error.Item === undefined) return 'not_found';
      const row = itemToRow(error.Item as Item);
      if (row.state !== 'in_flight') return 'not_found';
      return row.fence === fence ? 'not_found' : 'stale_fence';
    }
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const out = await this.client.send(new GetItemCommand({ TableName: this.table, Key: this.key(op), ConsistentRead: true }));
    if (out.Item === undefined) return null;
    const row = itemToRow(out.Item as Item);
    return row.expires_at > now ? rowToRecord(row) : null;
  }

  /** Native TTL sweeps expired items; nothing to do here (REQ-ST-DDB-1). */
  async purge(_now: number): Promise<number> {
    return 0;
  }

  /** Test-only: what a TTL sweep would do. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: this.key(op) }));
  }
}

/** Creates the table with pk and sk string keys, on-demand billing and TTL on the ttl attribute. Idempotent. */
export async function ensureTable(client: DynamoDBClient, tableName = 'anyonce_records'): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  for (let i = 0; i < 50; i++) {
    const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
    if (described.Table?.TableStatus === 'ACTIVE') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    await client.send(new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }));
  } catch (error) {
    // Already enabled: DynamoDB answers with a ValidationException naming the current state.
    if (!(error instanceof Error && /TimeToLive is already enabled/i.test(error.message))) throw error;
  }
}
```

Notes: `if_not_exists(fence, :zero) + :one` is the Q8 fence formula (a stale row keeps its fence and gets plus one; a removed row restarts at 1). The abandon classification returns `not_found` when the fence matches but the condition still failed, which can only mean the row is no longer in flight.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/stores/services/dynamodb.test.ts packages/stores/services/dynamodb.conformance.test.ts`
Expected: PASS (the suite at cap 307200; 20 of 20 vectors). If `ensureTable` fails on `UpdateTimeToLive` under DynamoDB Local with a different message, widen the regex to the message Local prints and note it in the report. Run `bun run lint`, `bun run typecheck`, `bun run build`.

- [ ] **Step 5: docs row and PR**

Append to the `docs/stores.md` matrix:

`| dynamodb | TS, Go | strongly consistent reads (ConsistentRead) | one conditional UpdateItem; refusal returns the old item | yes, ttl attribute (seconds, expires_at plus 60 s grace) | ensureTable(client) or create pk (S) and sk (S) with TTL on ttl | one write per request, one more per replay read; items capped at 400 KB so maxResultBytes must be at most 300 KiB (Q20) | 300 KiB |`

Commit, push, open the PR with the condition and update expressions in the body:

```bash
git add packages/stores docs/stores.md
git commit -m "feat(stores): REQ-ST-DDB-1 DynamoDB store with conditional UpdateItem begin and ReturnValuesOnConditionCheckFailure classification"
git push -u origin p3-store-dynamodb-ts
gh pr create --base p3-stores --head p3-store-dynamodb-ts --title "P3: DynamoDB store (TypeScript)" --body-file <path to a body that says Part of #1, lists REQ-ST-DDB-1, pastes the two expressions, and the gate output>
```

---

### Task 3: TypeScript Redis store (REQ-ST-REDIS-1)

Branch `p3-store-redis-ts` from `p3-stores` (after Task 2 merges, rebase if needed); PR to `p3-stores`, `Part of #1`, body carries the three Lua scripts.

**Files:**
- Create: `packages/stores/src/redis.ts`, `packages/stores/test/redis-adapters.test.ts`, `packages/stores/services/redis.test.ts`, `packages/stores/services/redis.conformance.test.ts`
- Modify: `packages/stores/src/codec.ts` (base64 helpers), `packages/stores/test/codec.test.ts`, `docs/stores.md`

**Interfaces:**
- Produces: `RedisStore`, `RedisStoreOptions`, `RedisAdapter`, `fromIoredis`, `fromNodeRedis`, `fromUpstash`, `BEGIN_LUA`, `COMPLETE_LUA`, `ABANDON_LUA`, `bytesToBase64`, `base64ToBytes` (codec).

- [ ] **Step 1: Base64 helpers, tests first**

Add to `packages/stores/test/codec.test.ts`:

```ts
  test('REQ-ST-REDIS-1: bytes round trip through base64 without node Buffer, including empty and 1 MiB inputs', () => {
    const small = new Uint8Array([0, 1, 254, 255, 10, 13]);
    expect(base64ToBytes(bytesToBase64(small))).toEqual(small);
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    const big = new Uint8Array(1_048_576);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
```

Implementation in `codec.ts` (chunked `btoa` and `atob`, Web APIs only):

```ts
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
```

- [ ] **Step 2: Adapter shape tests (no service)**

`packages/stores/test/redis-adapters.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { fromIoredis, fromNodeRedis, fromUpstash } from '../src/redis';

describe('redis adapters', () => {
  test('REQ-ST-REDIS-1: fromIoredis spreads keys and args after numkeys', async () => {
    const calls: unknown[][] = [];
    const client = {
      evalsha: async (...args: unknown[]) => { calls.push(['evalsha', ...args]); return 1; },
      eval: async (...args: unknown[]) => { calls.push(['eval', ...args]); return 2; },
      hgetall: async (key: string) => { calls.push(['hgetall', key]); return { a: '1' }; },
      del: async (key: string) => { calls.push(['del', key]); return 1; },
    };
    const a = fromIoredis(client);
    expect(await a.evalsha('sha', ['k'], ['x', 'y'])).toBe(1);
    expect(await a.eval('script', ['k'], ['x'])).toBe(2);
    expect(await a.hgetall('k')).toEqual({ a: '1' });
    await a.del('k');
    expect(calls).toEqual([['evalsha', 'sha', 1, 'k', 'x', 'y'], ['eval', 'script', 1, 'k', 'x'], ['hgetall', 'k'], ['del', 'k']]);
  });

  test('REQ-ST-REDIS-1: fromNodeRedis passes keys and arguments as an options object', async () => {
    const calls: unknown[][] = [];
    const client = {
      evalSha: async (sha: string, o: unknown) => { calls.push(['evalSha', sha, o]); return 1; },
      eval: async (s: string, o: unknown) => { calls.push(['eval', s, o]); return 2; },
      hGetAll: async (key: string) => { calls.push(['hGetAll', key]); return { a: '1' }; },
      del: async (key: string) => { calls.push(['del', key]); return 1; },
    };
    const a = fromNodeRedis(client);
    await a.evalsha('sha', ['k'], ['x']);
    await a.eval('s', ['k'], []);
    expect(await a.hgetall('k')).toEqual({ a: '1' });
    await a.del('k');
    expect(calls).toEqual([['evalSha', 'sha', { keys: ['k'], arguments: ['x'] }], ['eval', 's', { keys: ['k'], arguments: [] }], ['hGetAll', 'k'], ['del', 'k']]);
  });

  test('REQ-ST-REDIS-1: fromUpstash passes keys and args arrays and maps a null hgetall to an empty object', async () => {
    const client = {
      evalsha: async (sha: string, keys: string[], args: string[]) => [sha, keys, args],
      eval: async (s: string, keys: string[], args: string[]) => [s, keys, args],
      hgetall: async (_key: string) => null,
      del: async (_key: string) => 1,
    };
    const a = fromUpstash(client);
    expect(await a.evalsha('sha', ['k'], ['x'])).toEqual(['sha', ['k'], ['x']]);
    expect(await a.hgetall('k')).toEqual({});
  });
});
```

- [ ] **Step 3: Service tests**

`packages/stores/services/redis.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { LEASE_MS, storeContractSuite, T0, TTL_MS } from '@anyonce/core/testing';
import Redis from 'ioredis';
import { createClient } from 'redis';
import { fromIoredis, fromNodeRedis, type RedisAdapter, RedisStore } from '../src/redis';
import { describeService } from './services';

await describeService('redis store', 6379, () => {
  const io = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: false });
  storeContractSuite(
    'redis-ioredis',
    () => {
      const store = new RedisStore({ adapter: fromIoredis(io), prefix: `t${Date.now()}:` });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  const node = createClient({ url: 'redis://127.0.0.1:6379' });
  const nodeReady = node.connect();
  storeContractSuite(
    'redis-node-redis',
    async () => {
      await nodeReady;
      const store = new RedisStore({ adapter: fromNodeRedis(node), prefix: `n${Date.now()}:` });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  describe('redis specifics', () => {
    test('REQ-ST-REDIS-1: EVALSHA is tried first and EVAL is the fallback after SCRIPT FLUSH, then the sha is cached again', async () => {
      const calls: string[] = [];
      const inner = fromIoredis(io);
      const adapter: RedisAdapter = {
        evalsha: (sha, keys, args) => { calls.push('evalsha'); return inner.evalsha(sha, keys, args); },
        eval: (script, keys, args) => { calls.push('eval'); return inner.eval(script, keys, args); },
        hgetall: (key) => inner.hgetall(key),
        del: (key) => inner.del(key),
      };
      const store = new RedisStore({ adapter, prefix: `f${Date.now()}:` });
      const op = { scope: 's', key: 'k', fingerprint: 'a' };
      await io.script('FLUSH');
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
      expect(calls).toEqual(['evalsha', 'eval']);
      calls.length = 0;
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 + 1 });
      expect(calls).toEqual(['evalsha']);
    });

    test('REQ-ST-REDIS-1: the hash carries a native PEXPIRE relative to the wall clock and purge is a no-op', async () => {
      const store = new RedisStore({ adapter: fromIoredis(io), prefix: `p${Date.now()}:`, nativeTtlGraceMs: 60_000 });
      const op = { scope: 's', key: 'k', fingerprint: 'a' };
      await store.begin(op, { leaseMs: LEASE_MS, ttlMs: 5_000, now: T0 });
      const pttl = await io.pttl(store.keyFor(op));
      expect(pttl).toBeGreaterThan(60_000);
      expect(pttl).toBeLessThan(65_001);
      expect(await store.purge(Date.now())).toBe(0);
    });
  });
});
```

`packages/stores/services/redis.conformance.test.ts` mirrors the DynamoDB one with `new RedisStore({ adapter: fromIoredis(new Redis(...)) })`, named `REQ-ST-REDIS-1: every core and profile vector passes through withIdempotency with the Redis store` (no `maxResultBytes` override).

- [ ] **Step 4: Implement redis.ts**

```ts
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import { base64ToBytes, bytesToBase64, encodeResultMeta, type RecordRow, rowToRecord } from './codec';

/** The four calls the store needs; three client shapes are wrapped below. */
export interface RedisAdapter {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}

interface IoredisLike {
  evalsha(...args: (string | number)[]): Promise<unknown>;
  eval(...args: (string | number)[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}
interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
}
interface UpstashLike {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  del(key: string): Promise<unknown>;
}

export function fromIoredis(client: IoredisLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    eval: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
    hgetall: (key) => client.hgetall(key),
    del: (key) => client.del(key),
  };
}

export function fromNodeRedis(client: NodeRedisLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalSha(sha, { keys, arguments: args }),
    eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
    hgetall: (key) => client.hGetAll(key),
    del: (key) => client.del(key),
  };
}

export function fromUpstash(client: UpstashLike): RedisAdapter {
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys, args),
    eval: (script, keys, args) => client.eval(script, keys, args),
    hgetall: async (key) => {
      const out = await client.hgetall(key);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(out ?? {})) flat[k] = String(v);
      return flat;
    },
    del: (key) => client.del(key),
  };
}

/** KEYS[1] hash; ARGV fingerprint, now, leaseMs, ttlMs, graceMs. Returns {'acquired', fence} | {'in_flight', leaseUntil} | {'completed', ...HGETALL} | {'mismatch', ...HGETALL}. */
export const BEGIN_LUA = `
local k = KEYS[1]
local fp = ARGV[1]
local now = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local grace = tonumber(ARGV[5])
local row = redis.call('HMGET', k, 'fingerprint', 'state', 'fence', 'lease_until', 'expires_at')
local fence = 1
if row[1] then
  if tonumber(row[5]) > now then
    if row[1] ~= fp then
      local all = redis.call('HGETALL', k)
      table.insert(all, 1, 'mismatch')
      return all
    end
    if row[2] == 'completed' then
      local all = redis.call('HGETALL', k)
      table.insert(all, 1, 'completed')
      return all
    end
    if tonumber(row[4]) > now then
      return {'in_flight', row[4]}
    end
  end
  fence = tonumber(row[3]) + 1
end
redis.call('HSET', k, 'fingerprint', fp, 'state', 'in_flight', 'fence', fence, 'lease_until', now + lease, 'created_at', now, 'expires_at', now + ttl, 'result_omitted', 0)
redis.call('HDEL', k, 'result_meta', 'result_body')
redis.call('PEXPIRE', k, ttl + grace)
return {'acquired', fence}
`;

/** ARGV fence, now, meta, body ('-' for none), omitted. Returns ok | stale_fence | not_found. */
export const COMPLETE_LUA = `
local k = KEYS[1]
local fence = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local row = redis.call('HMGET', k, 'fence', 'state', 'expires_at')
if not row[1] or tonumber(row[3]) <= now then return 'not_found' end
if tonumber(row[1]) ~= fence then return 'stale_fence' end
if row[2] == 'completed' then return 'ok' end
redis.call('HSET', k, 'state', 'completed', 'result_meta', ARGV[3], 'result_omitted', ARGV[5])
if ARGV[4] == '-' then redis.call('HDEL', k, 'result_body') else redis.call('HSET', k, 'result_body', ARGV[4]) end
return 'ok'
`;

/** ARGV fence. Returns ok | stale_fence | not_found. */
export const ABANDON_LUA = `
local k = KEYS[1]
local fence = tonumber(ARGV[1])
local row = redis.call('HMGET', k, 'fence', 'state')
if not row[1] or row[2] ~= 'in_flight' then return 'not_found' end
if tonumber(row[1]) ~= fence then return 'stale_fence' end
redis.call('DEL', k)
return 'ok'
`;

export interface RedisStoreOptions {
  adapter: RedisAdapter;
  /** Key prefix. Default anyonce: */
  prefix?: string;
  /** Added to PEXPIRE so a late complete from the previous fence holder still finds its hash. Default 60000. */
  nativeTtlGraceMs?: number;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

function hashToRow(scope: string, key: string, fields: Record<string, string>): RecordRow {
  return {
    scope,
    key,
    fingerprint: fields.fingerprint ?? '',
    state: (fields.state as RecordRow['state']) ?? 'in_flight',
    fence: Number(fields.fence ?? 0),
    lease_until: Number(fields.lease_until ?? 0),
    created_at: Number(fields.created_at ?? 0),
    expires_at: Number(fields.expires_at ?? 0),
    result_meta: fields.result_meta ?? null,
    result_body: fields.result_body === undefined ? null : base64ToBytes(fields.result_body),
    result_omitted: Number(fields.result_omitted ?? 0),
  };
}

function pairsToFields(pairs: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) out[String(pairs[i])] = String(pairs[i + 1]);
  return out;
}

/** REQ-ST-REDIS-1: every state transition is one Lua script (EVALSHA, EVAL on NOSCRIPT), one hash per record. */
export class RedisStore implements Store {
  private readonly adapter: RedisAdapter;
  private readonly prefix: string;
  private readonly grace: number;
  private readonly shas = new Map<string, string>();

  constructor(options: RedisStoreOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix ?? 'anyonce:';
    this.grace = options.nativeTtlGraceMs ?? 60_000;
  }

  keyFor(op: Pick<Operation, 'scope' | 'key'>): string {
    return `${this.prefix}${op.scope}\x1f${op.key}`;
  }

  private async run(script: string, keys: string[], args: string[]): Promise<unknown> {
    let sha = this.shas.get(script);
    if (sha === undefined) {
      sha = await sha1Hex(script);
      this.shas.set(script, sha);
    }
    try {
      return await this.adapter.evalsha(sha, keys, args);
    } catch (error) {
      if (!(error instanceof Error && /NOSCRIPT/i.test(error.message))) throw error;
      return this.adapter.eval(script, keys, args);
    }
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    const reply = (await this.run(BEGIN_LUA, [this.keyFor(op)], [op.fingerprint, String(opts.now), String(opts.leaseMs), String(opts.ttlMs), String(this.grace)])) as unknown[];
    const tag = String(reply[0]);
    if (tag === 'acquired') return { outcome: 'acquired', fence: Number(reply[1]) };
    if (tag === 'in_flight') return { outcome: 'in_flight', leaseUntil: Number(reply[1]) };
    const record = rowToRecord(hashToRow(op.scope, op.key, pairsToFields(reply.slice(1))));
    return tag === 'completed' ? { outcome: 'completed', record } : { outcome: 'mismatch', record };
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted || result.body === undefined ? '-' : bytesToBase64(result.body);
    const reply = await this.run(COMPLETE_LUA, [this.keyFor(op)], [String(fence), String(now), encodeResultMeta(result), body, omitted ? '1' : '0']);
    return String(reply) as CompleteStatus;
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    return String(await this.run(ABANDON_LUA, [this.keyFor(op)], [String(fence)])) as CompleteStatus;
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const fields = await this.adapter.hgetall(this.keyFor(op));
    if (fields.fingerprint === undefined) return null;
    const row = hashToRow(op.scope, op.key, fields);
    return row.expires_at > now ? rowToRecord(row) : null;
  }

  /** PEXPIRE sweeps expired hashes; nothing to do here. */
  async purge(_now: number): Promise<number> {
    return 0;
  }

  /** Test-only: what the native expiry would do. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.adapter.del(this.keyFor(op));
  }
}
```

Note on the empty body: `result.body` of zero length encodes to `''`, which is stored (not `'-'`), so an empty body round trips as an empty `Uint8Array` and an absent body stays absent. ioredis returns Lua integers as numbers and strings as strings; node-redis and Upstash do the same, and `String(...)` plus `Number(...)` normalize the rest.

- [ ] **Step 5: Run, docs row, PR**

Run: `docker compose -f test/compose.yml up -d --wait redis`, `bun test packages/stores/test packages/stores/services/redis.test.ts packages/stores/services/redis.conformance.test.ts`, `bun run lint`, `bun run typecheck`, `bun run build`.
Expected: both client suites and the conformance run pass; the fallback test shows `['evalsha', 'eval']` then `['evalsha']`.

docs row: `| redis | TS, Go | single node or cluster with hash tags | one Lua script per transition (EVALSHA, EVAL fallback) | yes, PEXPIRE at ttl plus 60 s grace | any Redis 7; adapters for ioredis, node-redis and Upstash REST | one round trip per transition; bodies stored base64 so the REST client stays binary safe | 1 MiB |`

Commit, push, PR to `p3-stores` with the three Lua scripts in the body.

---
### Task 4: TypeScript Postgres store (REQ-ST-PG-1)

Branch `p3-store-postgres-ts` from `p3-stores`; PR to `p3-stores`, `Part of #1`, body carries the begin statement.

**Files:**
- Create: `packages/stores/src/postgres.ts`, `packages/stores/migrations/postgres/0001_anyonce.sql`, `packages/stores/test/postgres-adapters.test.ts`, `packages/stores/services/postgres.test.ts`, `packages/stores/services/postgres.conformance.test.ts`
- Modify: `docs/stores.md`

**Interfaces:**
- Produces: `PostgresStore`, `PostgresStoreOptions`, `PostgresQuery`, `fromPostgresJs`, `fromNeon`, `ensureSchema(query)`, `MIGRATION_SQL`.

- [ ] **Step 1: Adapter and migration tests (no service)**

`packages/stores/test/postgres-adapters.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POSTGRES_SCHEMA } from '../src/sql';
import { MIGRATION_SQL, fromNeon, fromPostgresJs } from '../src/postgres';

describe('postgres adapters', () => {
  test('REQ-ST-PG-1: the migration file is the embedded schema', () => {
    expect(readFileSync(join(import.meta.dir, '../migrations/postgres/0001_anyonce.sql'), 'utf8')).toBe(MIGRATION_SQL);
    expect(MIGRATION_SQL).toBe(POSTGRES_SCHEMA);
  });

  test('REQ-ST-PG-1: fromPostgresJs uses unsafe with params and returns rows; fromNeon calls query', async () => {
    const seen: unknown[] = [];
    const sql = { unsafe: async (text: string, params: unknown[]) => { seen.push([text, params]); return [{ a: 1 }]; } };
    expect(await fromPostgresJs(sql).query('SELECT $1', [1])).toEqual({ rows: [{ a: 1 }] });
    const neon = { query: async (text: string, params: unknown[]) => { seen.push([text, params]); return [{ b: 2 }]; } };
    expect(await fromNeon(neon).query('SELECT $1', [2])).toEqual({ rows: [{ b: 2 }] });
    expect(seen).toEqual([['SELECT $1', [1]], ['SELECT $1', [2]]]);
  });
});
```

- [ ] **Step 2: Service tests**

`packages/stores/services/postgres.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { storeContractSuite } from '@anyonce/core/testing';
import { Pool } from 'pg';
import postgres from 'postgres';
import { PostgresStore, ensureSchema, fromPostgresJs } from '../src/postgres';
import { describeService } from './services';

const URL = 'postgres://anyonce:anyonce@127.0.0.1:15432/anyonce';

await describeService('postgres store', 15432, () => {
  const pool = new Pool({ connectionString: URL, max: 60 });
  const ready = ensureSchema(pool);

  storeContractSuite(
    'postgres-pg',
    async () => {
      await ready;
      const store = new PostgresStore({ query: pool });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  const sql = postgres(URL, { max: 60 });
  storeContractSuite(
    'postgres-postgresjs',
    async () => {
      await ready;
      const store = new PostgresStore({ query: fromPostgresJs(sql) });
      return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
    },
    { describe, test, expect },
  );

  describe('postgres specifics', () => {
    test('REQ-ST-PG-1: ensureSchema applies the migration idempotently and the expires_at index exists', async () => {
      await ready;
      await ensureSchema(pool);
      const { rows } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'anyonce_records'");
      expect(rows.map((r: { indexname: string }) => r.indexname)).toContain('anyonce_records_expires_at');
    });
  });
});
```

`packages/stores/services/postgres.conformance.test.ts` mirrors the DynamoDB one with `new PostgresStore({ query: new Pool({ connectionString: URL }) })` after `ensureSchema`, named `REQ-ST-PG-1: every core and profile vector passes through withIdempotency with the Postgres store`.

- [ ] **Step 3: Implement postgres.ts and the migration file**

`packages/stores/migrations/postgres/0001_anyonce.sql` contains exactly `POSTGRES_SCHEMA`.

```ts
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';
import { ABANDON_SQL, BEGIN_SQL, COMPLETE_SQL, GET_SQL, POSTGRES_SCHEMA, PURGE_SQL, REMOVE_SQL, SELECT_SQL, pgSql } from './sql';

/** The one call the store needs. pg clients and pools satisfy it directly. */
export interface PostgresQuery {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function fromPostgresJs(sql: { unsafe(text: string, params: unknown[]): Promise<unknown> }): PostgresQuery {
  return { query: async (text, params) => ({ rows: (await sql.unsafe(text, params)) as Record<string, unknown>[] }) };
}

export function fromNeon(sql: { query(text: string, params: unknown[]): Promise<unknown> }): PostgresQuery {
  return { query: async (text, params) => ({ rows: (await sql.query(text, params)) as Record<string, unknown>[] }) };
}

export const MIGRATION_SQL = POSTGRES_SCHEMA;

export async function ensureSchema(query: PostgresQuery): Promise<void> {
  for (const statement of MIGRATION_SQL.split(';')) {
    if (statement.trim()) await query.query(statement, []);
  }
}

export interface PostgresStoreOptions {
  query: PostgresQuery;
}

const BEGIN = pgSql(BEGIN_SQL);
const COMPLETE = pgSql(COMPLETE_SQL);
const ABANDON = pgSql(ABANDON_SQL);
const GET = pgSql(GET_SQL);
const SELECT = pgSql(SELECT_SQL);
const PURGE = pgSql(PURGE_SQL);
const REMOVE = pgSql(REMOVE_SQL);

function asRow(r: Record<string, unknown>): RecordRow {
  return {
    scope: String(r.scope),
    key: String(r.key),
    fingerprint: String(r.fingerprint),
    state: r.state as RecordRow['state'],
    fence: Number(r.fence),
    lease_until: Number(r.lease_until),
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    result_meta: r.result_meta === null || r.result_meta === undefined ? null : String(r.result_meta),
    result_body: r.result_body === null || r.result_body === undefined ? null : new Uint8Array(r.result_body as ArrayLike<number>),
    result_omitted: Number(r.result_omitted),
  };
}

/** REQ-ST-PG-1: begin is one INSERT ON CONFLICT DO UPDATE; a refused write is classified by one SELECT. */
export class PostgresStore implements Store {
  private readonly db: PostgresQuery;

  constructor(options: PostgresStoreOptions) {
    this.db = options.query;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await this.db.query(BEGIN, [op.scope, op.key, op.fingerprint, opts.now, opts.leaseMs, opts.ttlMs]);
      if (rows[0] !== undefined) return { outcome: 'acquired', fence: Number(rows[0].fence) };
      const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
      if (existing === undefined) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: postgres begin could not settle after three attempts');
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? null : (result.body ?? null);
    const { rows } = await this.db.query(COMPLETE, [op.scope, op.key, fence, now, encodeResultMeta(result), body, omitted ? 1 : 0]);
    if (rows[0] !== undefined) return 'ok';
    const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const { rows } = await this.db.query(ABANDON, [op.scope, op.key, fence]);
    if (rows[0] !== undefined) return 'ok';
    const existing = (await this.db.query(SELECT, [op.scope, op.key])).rows[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(GET, [op.scope, op.key, now]);
    return rows[0] === undefined ? null : rowToRecord(asRow(rows[0]));
  }

  async purge(now: number): Promise<number> {
    return (await this.db.query(PURGE, [now])).rows.length;
  }

  /** Test-only physical removal. */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.db.query(REMOVE, [op.scope, op.key]);
  }
}
```

Parameter types: `pg` sends JavaScript numbers as text and Postgres casts them to `BIGINT`; `bytea` accepts `Uint8Array` in pg 8 and postgres.js 3 (pass `Buffer.from(body)` only if a driver rejects a bare `Uint8Array`; note it in the report if so). The `result_omitted` column is `SMALLINT`, so `1` and `0` cast fine.

- [ ] **Step 4: Run, docs row, PR**

Run: `docker compose -f test/compose.yml up -d --wait postgres`, `bun test packages/stores/test packages/stores/services/postgres.test.ts packages/stores/services/postgres.conformance.test.ts`, lint, typecheck, build.
Expected: both driver suites pass (the race test opens 50 connections, hence `max: 60`), 20 of 20 vectors.

docs row: `| postgres | TS, Go | serializable enough: one statement per transition | INSERT ON CONFLICT DO UPDATE WHERE, refusal classified by one SELECT | no, purge(now) with the expires_at index | migrations/postgres/0001_anyonce.sql or ensureSchema(query) | one statement per transition, two on a refused claim; run purge on a schedule | 1 MiB |`

Commit, push, PR with the begin statement in the body.

---

### Task 5: TypeScript D1 store (REQ-ST-D1-1)

Branch `p3-store-d1` from `p3-stores`; PR to `p3-stores`, `Part of #1`.

**Files:**
- Create: `packages/stores/src/d1.ts`, `packages/stores/workers/d1.test.ts`, `packages/stores/workers/tsconfig.json`, `packages/stores/test/d1-migration.test.ts`
- Modify: `docs/stores.md`

**Interfaces:**
- Produces: `D1Store`, `D1StoreOptions`, `ensureSchema(db)`, `MIGRATION_SQL`.

- [ ] **Step 1: Migration file test (no workerd)**

`packages/stores/test/d1-migration.test.ts`: asserts `readFileSync('migrations/d1/0001_anyonce.sql') === MIGRATION_SQL` and `MIGRATION_SQL === SQLITE_SCHEMA`, named `REQ-ST-D1-1: the D1 migration file is the embedded SQLite schema`.

- [ ] **Step 2: Workers tests**

`packages/stores/workers/tsconfig.json`: `{ "extends": "../../../test/workers/tsconfig.json", "include": ["."] }` (and add it to the root `typecheck` script).

`packages/stores/workers/d1.test.ts`:

```ts
import { runConformance } from '@anyonce/conformance/runtime';
import { withIdempotency } from '@anyonce/core/http';
import { storeContractSuite } from '@anyonce/core/testing';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { env } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { D1Store, ensureSchema } from '../src/d1';

const runner = {
  describe,
  test: (name: string, fn: () => Promise<void>, timeoutMs?: number) => test(name, fn, timeoutMs),
  expect,
};

storeContractSuite('d1', async () => {
  await ensureSchema(env.DB);
  const store = new D1Store({ db: env.DB });
  return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
}, runner);

describe('d1 specifics', () => {
  test('REQ-ST-D1-1: ensureSchema is idempotent on top of the applied migration', async () => {
    await ensureSchema(env.DB);
    await ensureSchema(env.DB);
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'anyonce_records_expires_at'").all();
    expect(results).toHaveLength(1);
  });

  test('REQ-ST-D1-1: every core and profile vector passes inside workerd through withIdempotency with the D1 store', async () => {
    const modules = import.meta.glob('../../../conformance/vectors/{core,profile}/*.json', { eager: true, import: 'default' });
    const vectors = Object.values(modules) as Parameters<typeof runConformance>[0]['vectors'];
    expect(vectors?.length).toBe(20);
    await ensureSchema(env.DB);
    const handler = withIdempotency(createFixtureApp().fetch, { store: new D1Store({ db: env.DB }), required: true, ttlMs: 2000, skip: (req) => new URL(req.url).pathname === '/reset' });
    const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'], vectors, report: 'markdown' });
    expect(summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`), report).toEqual([]);
  }, 60_000);
});
```

`runConformance` lives in the root entry which imports the loader; the `runtime` entry exports `runVectors` and `formatReport` but not `runConformance`. Add `runConformance` to `packages/conformance/src/runtime.ts` behind a `vectors` requirement: split `conformance.ts` so the function that takes `vectors` explicitly (`runConformanceWith(options & { vectors })`) lives in a node-free module re-exported by both entries, and the root `runConformance` calls `loadVectors()` when `vectors` is absent. Keep the existing root API and tests unchanged; add `REQ-CONF-5: the runtime entry exposes runConformance for callers that supply vectors` in `packages/conformance/test/runtime.test.ts`.

- [ ] **Step 3: Implement d1.ts**

```ts
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';
import { ABANDON_SQL, BEGIN_SQL, COMPLETE_SQL, GET_SQL, PURGE_SQL, REMOVE_SQL, SELECT_SQL, SQLITE_SCHEMA } from './sql';

export const MIGRATION_SQL = SQLITE_SCHEMA;

export interface D1StoreOptions {
  db: D1Database;
}

export async function ensureSchema(db: D1Database): Promise<void> {
  for (const statement of MIGRATION_SQL.split(';')) {
    if (statement.trim()) await db.prepare(statement).run();
  }
}

function asRow(r: Record<string, unknown>): RecordRow {
  return {
    scope: String(r.scope),
    key: String(r.key),
    fingerprint: String(r.fingerprint),
    state: r.state as RecordRow['state'],
    fence: Number(r.fence),
    lease_until: Number(r.lease_until),
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    result_meta: r.result_meta === null ? null : String(r.result_meta),
    result_body: r.result_body === null ? null : new Uint8Array(r.result_body as ArrayBuffer),
    result_omitted: Number(r.result_omitted),
  };
}

/** REQ-ST-D1-1: one INSERT ON CONFLICT DO UPDATE per claim; D1 returns BLOBs as ArrayBuffer. */
export class D1Store implements Store {
  private readonly db: D1Database;

  constructor(options: D1StoreOptions) {
    this.db = options.db;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await this.db.prepare(BEGIN_SQL).bind(op.scope, op.key, op.fingerprint, opts.now, opts.leaseMs, opts.ttlMs).first<{ fence: number }>();
      if (claimed !== null) return { outcome: 'acquired', fence: Number(claimed.fence) };
      const existing = await this.db.prepare(SELECT_SQL).bind(op.scope, op.key).first<Record<string, unknown>>();
      if (existing === null) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: d1 begin could not settle after three attempts');
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    const omitted = isOmitted(result);
    const body = omitted ? null : (result.body ?? null);
    const updated = await this.db.prepare(COMPLETE_SQL).bind(op.scope, op.key, fence, now, encodeResultMeta(result), body, omitted ? 1 : 0).first<{ fence: number }>();
    if (updated !== null) return 'ok';
    const existing = await this.db.prepare(SELECT_SQL).bind(op.scope, op.key).first<Record<string, unknown>>();
    if (existing === null) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const deleted = await this.db.prepare(ABANDON_SQL).bind(op.scope, op.key, fence).first<{ fence: number }>();
    if (deleted !== null) return 'ok';
    const existing = await this.db.prepare(SELECT_SQL).bind(op.scope, op.key).first<Record<string, unknown>>();
    if (existing === null) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const row = await this.db.prepare(GET_SQL).bind(op.scope, op.key, now).first<Record<string, unknown>>();
    return row === null ? null : rowToRecord(asRow(row));
  }

  async purge(now: number): Promise<number> {
    const { results } = await this.db.prepare(PURGE_SQL).bind(now).all();
    return results.length;
  }

  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    await this.db.prepare(REMOVE_SQL).bind(op.scope, op.key).run();
  }
}
```

D1 binds `Uint8Array` as BLOB; if the pool rejects a `Uint8Array` bind, pass `body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)` (an `ArrayBuffer`) and note it. The race test runs 50 `begin` calls on one D1 binding; D1 serializes them, which is the atomicity mechanism.

- [ ] **Step 4: Run, docs row, PR**

Run: `bun run build`, `bun run test:workers`, `bun test packages/stores/test`, lint, typecheck.
Expected: the suite, the specifics and the in-workerd conformance run pass.

docs row: `| d1 | TS | strongly consistent within the database | INSERT ON CONFLICT DO UPDATE WHERE, refusal classified by one SELECT | no, purge(now) with the expires_at index (a cron trigger is the usual scheduler) | migrations/d1/0001_anyonce.sql via wrangler d1 migrations, or ensureSchema(db) | one statement per transition; rows up to 2 MB | 1 MiB |`

---

### Task 6: TypeScript Durable Objects store (REQ-ST-DO-1)

Branch `p3-store-durable-objects` from `p3-stores`; PR to `p3-stores`, `Part of #1`.

**Files:**
- Create: `packages/stores/workers/durable-objects.test.ts`
- Modify: `packages/stores/src/durable-objects.ts` (replace the placeholder), `test/workers/worker.ts` (unchanged export), `docs/stores.md`

**Interfaces:**
- Produces: `IdempotencyObject` (RPC methods `begin`, `complete`, `abandon`, `get`, `purge`, `physicallyRemove`, and `alarm`), `DurableObjectsStore`, `DurableObjectsStoreOptions` (`namespace`, `shard`, `nativeTtlGraceMs`).

- [ ] **Step 1: Workers tests**

`packages/stores/workers/durable-objects.test.ts`:

```ts
import { runConformance } from '@anyonce/conformance/runtime';
import { withIdempotency } from '@anyonce/core/http';
import { LEASE_MS, storeContractSuite, T0 } from '@anyonce/core/testing';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { DurableObjectsStore, type IdempotencyObject } from '../src/durable-objects';

const runner = { describe, test: (n: string, fn: () => Promise<void>, t?: number) => test(n, fn, t), expect };

for (const shard of ['scope', 'scope-key'] as const) {
  storeContractSuite(`durable-objects-${shard}`, () => {
    const store = new DurableObjectsStore({ namespace: env.IDEMPOTENCY, shard });
    return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
  }, runner);
}

describe('durable objects specifics', () => {
  test('REQ-ST-DO-1: 50 parallel stub.begin calls on one object yield exactly one acquired', async () => {
    const stub = env.IDEMPOTENCY.get(env.IDEMPOTENCY.idFromName('race')) as DurableObjectStub<IdempotencyObject>;
    const op = { scope: 'race', key: 'k', fingerprint: 'a' };
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => stub.begin(op, { leaseMs: LEASE_MS, ttlMs: 60_000, now: T0 }, 60_000)));
    expect(outcomes.filter((o) => o.outcome === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'in_flight')).toHaveLength(49);
  });

  test('REQ-ST-DO-1: the alarm purges rows whose wall clock expiry has passed and reschedules for the rest', async () => {
    const store = new DurableObjectsStore({ namespace: env.IDEMPOTENCY, shard: 'scope', nativeTtlGraceMs: 0 });
    const soon = { scope: 'alarm', key: 'soon', fingerprint: 'a' };
    const later = { scope: 'alarm', key: 'later', fingerprint: 'a' };
    await store.begin(soon, { leaseMs: LEASE_MS, ttlMs: 0, now: T0 });
    await store.begin(later, { leaseMs: LEASE_MS, ttlMs: 3_600_000, now: T0 });
    const stub = env.IDEMPOTENCY.get(env.IDEMPOTENCY.idFromName('alarm'));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const rows = await runInDurableObject(stub as DurableObjectStub<IdempotencyObject>, (instance, state) => state.storage.sql.exec('SELECT key FROM anyonce_records').toArray());
    expect(rows.map((r) => r.key)).toEqual(['later']);
    expect(await runInDurableObject(stub as DurableObjectStub<IdempotencyObject>, (_i, state) => state.storage.getAlarm())).not.toBeNull();
  });

  test('REQ-ST-DO-1: every core and profile vector passes inside workerd through withIdempotency with the Durable Objects store', async () => {
    const modules = import.meta.glob('../../../conformance/vectors/{core,profile}/*.json', { eager: true, import: 'default' });
    const vectors = Object.values(modules) as Parameters<typeof runConformance>[0]['vectors'];
    expect(vectors?.length).toBe(20);
    const handler = withIdempotency(createFixtureApp().fetch, { store: new DurableObjectsStore({ namespace: env.IDEMPOTENCY }), required: true, ttlMs: 2000, skip: (req) => new URL(req.url).pathname === '/reset' });
    const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'], vectors, report: 'markdown' });
    expect(summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`), report).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Implement durable-objects.ts**

```ts
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '@anyonce/core';
import { isOmitted } from '@anyonce/core';
import { DurableObject } from 'cloudflare:workers';
import { encodeResultMeta, type RecordRow, rowToRecord } from './codec';
import { ABANDON_SQL, BEGIN_SQL, COMPLETE_SQL, GET_SQL, PURGE_SQL, REMOVE_SQL, SELECT_SQL, SQLITE_SCHEMA } from './sql';

/** SQLite-backed rows carry one extra column: the wall-clock expiry the alarm sweeps by. */
const ALARM_SCHEMA = `${SQLITE_SCHEMA}
CREATE TABLE IF NOT EXISTS anyonce_sweep (scope TEXT NOT NULL, key TEXT NOT NULL, expires_wall INTEGER NOT NULL, PRIMARY KEY (scope, key));
CREATE INDEX IF NOT EXISTS anyonce_sweep_expires_wall ON anyonce_sweep (expires_wall);`;

function asRow(r: Record<string, unknown>): RecordRow {
  return {
    scope: String(r.scope), key: String(r.key), fingerprint: String(r.fingerprint), state: r.state as RecordRow['state'],
    fence: Number(r.fence), lease_until: Number(r.lease_until), created_at: Number(r.created_at), expires_at: Number(r.expires_at),
    result_meta: r.result_meta === null ? null : String(r.result_meta),
    result_body: r.result_body === null ? null : new Uint8Array(r.result_body as ArrayBuffer),
    result_omitted: Number(r.result_omitted),
  };
}

/**
 * REQ-ST-DO-1: one object is one writer, so each statement runs alone; RPC methods take and return plain data.
 * The alarm deletes rows by wall-clock expiry (expires_wall), which is the logical expiry converted to a duration
 * at write time plus the grace, so the injected clock never makes the alarm sweep live rows.
 */
export class IdempotencyObject extends DurableObject {
  private ready = false;

  private init(): void {
    if (this.ready) return;
    for (const statement of ALARM_SCHEMA.split(';')) if (statement.trim()) this.ctx.storage.sql.exec(statement);
    this.ready = true;
  }

  private scheduleSweep(scope: string, key: string, expiresAt: number, now: number, graceMs: number): void {
    const wall = Date.now() + (expiresAt - now) + graceMs;
    this.ctx.storage.sql.exec('INSERT INTO anyonce_sweep (scope, key, expires_wall) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET expires_wall = excluded.expires_wall', scope, key, wall);
    const current = this.ctx.storage.getAlarm();
    void Promise.resolve(current).then((at) => {
      if (at === null || at > wall) return this.ctx.storage.setAlarm(wall);
    });
  }

  async begin(op: Operation, opts: BeginOptions, graceMs = 60_000): Promise<BeginOutcome> {
    this.init();
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = this.ctx.storage.sql.exec(BEGIN_SQL, op.scope, op.key, op.fingerprint, opts.now, opts.leaseMs, opts.ttlMs).toArray()[0];
      if (claimed !== undefined) {
        this.scheduleSweep(op.scope, op.key, opts.now + opts.ttlMs, opts.now, graceMs);
        return { outcome: 'acquired', fence: Number(claimed.fence) };
      }
      const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
      if (existing === undefined) continue;
      const row = asRow(existing);
      if (row.expires_at <= opts.now) continue;
      const record = rowToRecord(row);
      if (row.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record };
      if (row.state === 'completed') return { outcome: 'completed', record };
      if (row.lease_until > opts.now) return { outcome: 'in_flight', leaseUntil: row.lease_until };
    }
    throw new Error('anyonce: durable object begin could not settle after three attempts');
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    this.init();
    const omitted = isOmitted(result);
    const body = omitted ? null : (result.body ?? null);
    const updated = this.ctx.storage.sql.exec(COMPLETE_SQL, op.scope, op.key, fence, now, encodeResultMeta(result), body, omitted ? 1 : 0).toArray()[0];
    if (updated !== undefined) return 'ok';
    const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.expires_at <= now) return 'not_found';
    if (row.fence !== fence) return 'stale_fence';
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    this.init();
    const deleted = this.ctx.storage.sql.exec(ABANDON_SQL, op.scope, op.key, fence).toArray()[0];
    if (deleted !== undefined) {
      this.ctx.storage.sql.exec('DELETE FROM anyonce_sweep WHERE scope = ? AND key = ?', op.scope, op.key);
      return 'ok';
    }
    const existing = this.ctx.storage.sql.exec(SELECT_SQL, op.scope, op.key).toArray()[0];
    if (existing === undefined) return 'not_found';
    const row = asRow(existing);
    if (row.state !== 'in_flight') return 'not_found';
    return row.fence === fence ? 'not_found' : 'stale_fence';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    this.init();
    const row = this.ctx.storage.sql.exec(GET_SQL, op.scope, op.key, now).toArray()[0];
    return row === undefined ? null : rowToRecord(asRow(row));
  }

  async purge(now: number): Promise<number> {
    this.init();
    const removed = this.ctx.storage.sql.exec(PURGE_SQL, now).toArray();
    for (const r of removed) this.ctx.storage.sql.exec('DELETE FROM anyonce_sweep WHERE scope = ? AND key = ?', r.scope, r.key);
    return removed.length;
  }

  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    this.init();
    this.ctx.storage.sql.exec(REMOVE_SQL, op.scope, op.key);
    this.ctx.storage.sql.exec('DELETE FROM anyonce_sweep WHERE scope = ? AND key = ?', op.scope, op.key);
  }

  /** Deletes rows whose wall-clock expiry passed and reschedules for the earliest remaining one. */
  async alarm(): Promise<void> {
    this.init();
    const wallNow = Date.now();
    const due = this.ctx.storage.sql.exec('SELECT scope, key FROM anyonce_sweep WHERE expires_wall <= ?', wallNow).toArray();
    for (const r of due) {
      this.ctx.storage.sql.exec(REMOVE_SQL, r.scope, r.key);
      this.ctx.storage.sql.exec('DELETE FROM anyonce_sweep WHERE scope = ? AND key = ?', r.scope, r.key);
    }
    const next = this.ctx.storage.sql.exec('SELECT MIN(expires_wall) AS at FROM anyonce_sweep').toArray()[0];
    if (next !== undefined && next.at !== null) await this.ctx.storage.setAlarm(Number(next.at));
  }
}

export interface DurableObjectsStoreOptions {
  namespace: DurableObjectNamespace<IdempotencyObject>;
  /** One object per scope (default) or per scope and key. */
  shard?: 'scope' | 'scope-key';
  /** Added to the alarm time so a late complete from the previous fence holder still finds its row. Default 60000. */
  nativeTtlGraceMs?: number;
}

/** REQ-ST-DO-1: the Worker-side Store; every call is one RPC to the object that owns the scope (or the key). */
export class DurableObjectsStore implements Store {
  private readonly namespace: DurableObjectNamespace<IdempotencyObject>;
  private readonly shard: 'scope' | 'scope-key';
  private readonly grace: number;
  private readonly touched = new Set<string>();

  constructor(options: DurableObjectsStoreOptions) {
    this.namespace = options.namespace;
    this.shard = options.shard ?? 'scope';
    this.grace = options.nativeTtlGraceMs ?? 60_000;
  }

  private stub(op: Pick<Operation, 'scope' | 'key'>): DurableObjectStub<IdempotencyObject> {
    const name = this.shard === 'scope' ? op.scope : `${op.scope}\x1f${op.key}`;
    this.touched.add(name);
    return this.namespace.get(this.namespace.idFromName(name));
  }

  begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    return this.stub(op).begin(op, opts, this.grace);
  }
  complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    return this.stub(op).complete(op, fence, result, now);
  }
  abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    return this.stub(op).abandon(op, fence);
  }
  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    return this.stub(op).get(op, now);
  }
  /** Reaches every object this instance has touched; the alarm covers the rest on the object's own schedule. */
  async purge(now: number): Promise<number> {
    let removed = 0;
    for (const name of this.touched) removed += await this.namespace.get(this.namespace.idFromName(name)).purge(now);
    return removed;
  }
  physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    return this.stub(op).physicallyRemove(op);
  }
}
```

RPC carries `Uint8Array` bodies by structured clone. `getAlarm()` returns a promise on the SQLite backend; the `scheduleSweep` helper handles both shapes. If `DurableObjectStub<IdempotencyObject>` typing rejects the RPC method calls, add `// @ts-expect-error` with the reason or type the stub through `Rpc.DurableObjectBranded`; report what was needed.

- [ ] **Step 3: Run, docs row, PR**

Run: `bun run build`, `bun run test:workers`, lint, typecheck.
Expected: both shard suites, the race, the alarm test and the conformance run pass.

docs row: `| durable-objects | TS | strongly consistent per object | single writer per object, one SQLite statement per transition | alarm sweep by wall clock (expires_at plus 60 s grace) | bind IdempotencyObject with new_sqlite_classes; DurableObjectsStore({ namespace }) | one RPC per transition; per scope sharding serializes a scope's requests, per scope and key sharding spreads them | 1 MiB (2 MB row limit) |`

---
### Task 7: Go DynamoDB store (REQ-ST-DDB-1 in Go)

Branch `p3-store-dynamodb-go` from `p3-stores`; PR to `p3-stores`, `Part of #1`.

**Files:**
- Create: `go/store/internal/rowcodec/rowcodec.go`, `go/store/internal/rowcodec/rowcodec_test.go`, `go/store/dynamodb/dynamodb.go`, `go/store/dynamodb/dynamodb_test.go`, `go/store/internal/servicetest/servicetest.go`
- Modify: `go/go.mod`, `go/go.sum`, `docs/stores.md` (DynamoDB row already lists Go)

**Interfaces:**
- Produces: `rowcodec.Meta` (JSON of kind, status, headers, outcome, error), `rowcodec.EncodeMeta(result) (string, error)`, `rowcodec.DecodeMeta(text) (anyonce.StoredResult, error)`, `rowcodec.Row` struct and `rowcodec.ToRecord(row) anyonce.Record`; `servicetest.Require(t, name, addr)` (skips unless the port answers or `ANYONCE_REQUIRE_SERVICES=1` makes it fatal); `dynamodb.New(client, Options) *Store`, `dynamodb.Options{Table, NativeTTLGrace}`, `dynamodb.EnsureTable(ctx, client, table) error`, `dynamodb.MaxResultBytes = 307200`, `(*Store).PhysicallyRemove`.

- [ ] **Step 1: rowcodec and servicetest, tests first**

`go/store/internal/rowcodec/rowcodec_test.go`:

```go
package rowcodec

import (
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestMeta(t *testing.T) {
	t.Run("REQ-STORE-4: meta round trips kind, status, headers, outcome and error without the body", func(t *testing.T) {
		in := anyonce.StoredResult{Kind: anyonce.KindMessage, Status: 201, Headers: [][2]string{{"content-type", "text/plain"}, {"set-cookie", "a=1"}}, Outcome: anyonce.OutcomeError, Error: &anyonce.MessageError{Name: "E", Message: "boom"}, Body: []byte{1}}
		text, err := EncodeMeta(in)
		if err != nil {
			t.Fatal(err)
		}
		if text != `{"kind":"message","status":201,"headers":[["content-type","text/plain"],["set-cookie","a=1"]],"outcome":"error","error":{"name":"E","message":"boom"}}` {
			t.Fatal(text)
		}
		out, err := DecodeMeta(text)
		if err != nil || out.Kind != in.Kind || out.Status != 201 || len(out.Headers) != 2 || out.Outcome != anyonce.OutcomeError || out.Error == nil || out.Error.Message != "boom" || out.Body != nil {
			t.Fatalf("%+v %v", out, err)
		}
	})
	t.Run("REQ-STORE-10: an omitted result encodes status and headers only and ToRecord sets ResultOmitted", func(t *testing.T) {
		text, _ := EncodeMeta(anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"x", "y"}}, Omitted: true})
		if text != `{"kind":"http","status":200,"headers":[["x","y"]]}` {
			t.Fatal(text)
		}
		rec := ToRecord(Row{Scope: "s", Key: "k", Fingerprint: "f", State: "completed", Fence: 1, LeaseUntil: 0, CreatedAt: 0, ExpiresAt: 9, ResultMeta: &text, ResultOmitted: 1})
		if !rec.ResultOmitted || rec.Result == nil || rec.Result.Body != nil || rec.Result.Status != 200 || !rec.ExpiresAt.Equal(time.UnixMilli(9)) {
			t.Fatalf("%+v", rec)
		}
	})
	t.Run("REQ-STORE-4: ToRecord decodes a completed row with a body and leaves Result nil for an in flight row", func(t *testing.T) {
		meta := `{"kind":"http","status":201}`
		rec := ToRecord(Row{Scope: "s", Key: "k", Fingerprint: "f", State: "completed", Fence: 2, ResultMeta: &meta, ResultBody: []byte{1, 2}})
		if rec.Result == nil || string(rec.Result.Body) != "\x01\x02" || rec.Fence != 2 || rec.State != anyonce.StateCompleted {
			t.Fatalf("%+v", rec)
		}
		if ToRecord(Row{State: "in_flight"}).Result != nil {
			t.Fatal("in flight row must not carry a result")
		}
	})
}
```

`go/store/internal/rowcodec/rowcodec.go`:

```go
// Package rowcodec is the flat row shape shared by the Go stores and the JSON codec for result metadata.
package rowcodec

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Row mirrors the TypeScript RecordRow: epoch milliseconds, JSON meta, raw body bytes, 0 or 1 for omitted.
type Row struct {
	Scope         string
	Key           string
	Fingerprint   string
	State         string
	Fence         int64
	LeaseUntil    int64
	CreatedAt     int64
	ExpiresAt     int64
	ResultMeta    *string
	ResultBody    []byte
	ResultOmitted int64
}

type meta struct {
	Kind    anyonce.Kind          `json:"kind"`
	Status  *int                  `json:"status,omitempty"`
	Headers [][2]string           `json:"headers,omitempty"`
	Outcome *anyonce.Outcome      `json:"outcome,omitempty"`
	Error   *anyonce.MessageError `json:"error,omitempty"`
}

// EncodeMeta serializes everything but the body; the omitted form encodes the same way.
func EncodeMeta(r anyonce.StoredResult) (string, error) {
	m := meta{Kind: r.Kind, Headers: r.Headers, Error: r.Error}
	if r.Status != 0 {
		s := r.Status
		m.Status = &s
	}
	if r.Outcome != "" {
		o := r.Outcome
		m.Outcome = &o
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("rowcodec: encode meta: %w", err)
	}
	return string(b), nil
}

// DecodeMeta parses what EncodeMeta wrote; Body stays nil.
func DecodeMeta(text string) (anyonce.StoredResult, error) {
	var m meta
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		return anyonce.StoredResult{}, fmt.Errorf("rowcodec: decode meta: %w", err)
	}
	out := anyonce.StoredResult{Kind: m.Kind, Headers: m.Headers, Error: m.Error}
	if m.Status != nil {
		out.Status = *m.Status
	}
	if m.Outcome != nil {
		out.Outcome = *m.Outcome
	}
	return out, nil
}

// ToRecord decodes a row; a malformed meta yields a record without a result rather than an error, because a
// store must still report the claim state.
func ToRecord(row Row) anyonce.Record {
	rec := anyonce.Record{
		Scope: row.Scope, Key: row.Key, Fingerprint: row.Fingerprint, State: anyonce.State(row.State), Fence: row.Fence,
		LeaseUntil: time.UnixMilli(row.LeaseUntil).UTC(), CreatedAt: time.UnixMilli(row.CreatedAt).UTC(), ExpiresAt: time.UnixMilli(row.ExpiresAt).UTC(),
		ResultOmitted: row.ResultOmitted == 1,
	}
	if row.ResultMeta != nil {
		if res, err := DecodeMeta(*row.ResultMeta); err == nil {
			if row.ResultBody != nil {
				res.Body = append([]byte(nil), row.ResultBody...)
			}
			res.Omitted = rec.ResultOmitted
			rec.Result = &res
		}
	}
	return rec
}
```

`go/store/internal/servicetest/servicetest.go`:

```go
// Package servicetest gates integration tests on a reachable service.
package servicetest

import (
	"net"
	"os"
	"testing"
	"time"
)

// Require skips the test when addr does not accept a TCP connection, unless ANYONCE_REQUIRE_SERVICES is set, in
// which case an unreachable service fails the test (CI's services job sets it).
func Require(t *testing.T, name, addr string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 1500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return
	}
	if os.Getenv("ANYONCE_REQUIRE_SERVICES") != "" {
		t.Fatalf("%s is required but %s is not reachable: %v", name, addr, err)
	}
	t.Skipf("%s not reachable on %s; run docker compose -f test/compose.yml up -d --wait", name, addr)
}
```

- [ ] **Step 2: DynamoDB tests**

Add the modules: `GOROOT= /opt/homebrew/bin/go get -C go github.com/aws/aws-sdk-go-v2@v1.47.0 github.com/aws/aws-sdk-go-v2/service/dynamodb@v1.69.0 github.com/aws/aws-sdk-go-v2/config@v1.33.5 github.com/aws/aws-sdk-go-v2/credentials@v1.20.5` then `GOROOT= /opt/homebrew/bin/go mod tidy -C go`.

`go/store/dynamodb/dynamodb_test.go`:

```go
package dynamodb_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awsdynamodb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/dynamodb"
	"github.com/sns45/anyonce/go/store/internal/servicetest"
	"github.com/sns45/anyonce/go/storetest"
	"net/http"
)

func client() *awsdynamodb.Client {
	return awsdynamodb.New(awsdynamodb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String("http://127.0.0.1:18000"),
		Credentials:  credentials.NewStaticCredentialsProvider("local", "local", ""),
	})
}

func TestDynamoDBStore(t *testing.T) {
	servicetest.Require(t, "dynamodb", "127.0.0.1:18000")
	ctx := context.Background()
	c := client()
	table := fmt.Sprintf("anyonce_go_%d", time.Now().UnixNano())
	if err := dynamodb.EnsureTable(ctx, c, table); err != nil {
		t.Fatal(err)
	}
	storetest.Run(t, "dynamodb", func(*testing.T) storetest.Harness {
		s := dynamodb.New(c, dynamodb.Options{Table: table})
		return storetest.Harness{Store: s, PhysicallyRemove: s.PhysicallyRemove, MaxResultBytes: dynamodb.MaxResultBytes}
	})

	t.Run("REQ-ST-DDB-1: a refused begin classifies from the returned old item and the ttl attribute is enabled", func(t *testing.T) {
		s := dynamodb.New(c, dynamodb.Options{Table: table})
		op := anyonce.Operation{Scope: fmt.Sprintf("rvocf-%d", time.Now().UnixNano()), Key: "k", Fingerprint: "a"}
		opts := anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}
		if _, err := s.Begin(ctx, op, opts); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: []byte{1}}, storetest.T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		out, err := s.Begin(ctx, anyonce.Operation{Scope: op.Scope, Key: op.Key, Fingerprint: "b"}, opts)
		if err != nil || out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.Result == nil || string(out.Record.Result.Body) != "\x01" {
			t.Fatalf("%+v %v", out, err)
		}
		ttl, err := c.DescribeTimeToLive(ctx, &awsdynamodb.DescribeTimeToLiveInput{TableName: aws.String(table)})
		if err != nil || ttl.TimeToLiveDescription.TimeToLiveStatus != types.TimeToLiveStatusEnabled || *ttl.TimeToLiveDescription.AttributeName != "ttl" {
			t.Fatalf("%+v %v", ttl, err)
		}
		if n, err := s.Purge(ctx, time.Now()); err != nil || n != 0 {
			t.Fatalf("purge %d %v", n, err)
		}
	})

	t.Run("REQ-ST-DDB-1: every core and profile vector passes through httpmw with the DynamoDB store", func(t *testing.T) {
		f := fixture.New()
		mw := httpmw.New(dynamodb.New(c, dynamodb.Options{Table: table}), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second, MaxResultBytes: dynamodb.MaxResultBytes}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
		}
	})
}
```

- [ ] **Step 3: Implement dynamodb.go**

Mirror the TypeScript store exactly: `Begin` is one `UpdateItem` with the same condition and update expressions and `ReturnValuesOnConditionCheckFailure: types.ReturnValuesOnConditionCheckFailureAllOld`; on `*types.ConditionalCheckFailedException` read `err.Item`, convert to `rowcodec.Row` (`pk`, `sk`, `fingerprint`, `state` as `AttributeValueMemberS`; `fence`, `lease_until`, `created_at`, `expires_at`, `result_omitted`, `ttl` as `AttributeValueMemberN`; `result_meta` S; `result_body` `AttributeValueMemberB`), classify with the same precedence, retry up to three times when the old item is expired. `Complete` and `Abandon` as in TypeScript. `Get` uses `ConsistentRead: aws.Bool(true)`. `Purge` returns 0. `PhysicallyRemove` deletes. The native `ttl` is `time.Now().Add(opts.TTL + grace).Unix()`. `EnsureTable` creates the table (pay per request, pk HASH, sk RANGE), waits for ACTIVE with `awsdynamodb.NewTableExistsWaiter`, then `UpdateTimeToLive` ignoring a `*types.ValidationException` whose message says TimeToLive is already enabled. Export `const MaxResultBytes = 307200` with the Q20 comment. Errors wrap with `%w` and a `dynamodb:` prefix. Doc comments on every exported identifier.

- [ ] **Step 4: Run, PR**

Run: `docker compose -f test/compose.yml up -d --wait dynamodb`, `GOROOT= /opt/homebrew/bin/go test -C go -race -count=1 ./store/...`, vet, golangci-lint, `ANYONCE_REQUIRE_SERVICES=1 GOROOT= /opt/homebrew/bin/go test -C go -count=1 ./store/dynamodb/` (proves the gate mode), engine coverage gate.
Expected: contract suite at the 300 KiB cap, specifics, 20 of 20 through httpmw. Commit (`go.mod`, `go.sum` included), push, PR to `p3-stores` with the expressions in the body.

---

### Task 8: Go Redis store (REQ-ST-REDIS-1 in Go)

Branch `p3-store-redis-go`; PR to `p3-stores`, `Part of #1`, body carries the scripts (identical to the TypeScript ones).

**Files:**
- Create: `go/store/redis/redis.go`, `go/store/redis/scripts.go`, `go/store/redis/redis_test.go`
- Modify: `go/go.mod`, `go/go.sum`

- [ ] **Step 1: Tests**

Add `github.com/redis/go-redis/v9@v9.22.0`. `go/store/redis/redis_test.go`: `servicetest.Require(t, "redis", "127.0.0.1:6379")`; `storetest.Run(t, "redis", ...)` with `redisstore.New(client, redisstore.Options{Prefix: fmt.Sprintf("go%d:", time.Now().UnixNano())})` and `PhysicallyRemove`; a subtest `REQ-ST-REDIS-1: EVALSHA is tried first and EVAL is the fallback after SCRIPT FLUSH` that calls `client.ScriptFlush(ctx)`, runs `Begin`, and asserts through a `redis.Hook` (go-redis `AddHook` with a `ProcessHook` that records command names) that the sequence is `evalsha, eval` then `evalsha` on the next call; a subtest `REQ-ST-REDIS-1: the hash carries a PEXPIRE relative to the wall clock and purge is a no-op` (`client.PTTL` between 60 s and 65 s for a 5 s TTL with a 60 s grace); the conformance subtest `REQ-ST-REDIS-1: every core and profile vector passes through httpmw with the Redis store`.

- [ ] **Step 2: Implement**

`scripts.go` holds `beginLua`, `completeLua`, `abandonLua` as string constants identical to the TypeScript scripts (copy them verbatim; a test in Task 11 asserts the two languages' scripts are byte identical by reading `packages/stores/src/redis.ts`). `redis.go`: `Options{Prefix string (default "anyonce:"), NativeTTLGrace time.Duration (default 60 s)}`, `New(client redis.UniversalClient, opts Options) *Store`, three `*redis.Script` values (`redis.NewScript`), whose `Run` does EVALSHA then EVAL on NOSCRIPT (that is the go-redis fallback; the hook test proves it). `Begin` parses the reply slice: `[]interface{}` with the tag first; `in_flight` carries the lease as a string or int64; `completed` and `mismatch` carry the HGETALL pairs, turned into `rowcodec.Row` with the body base64-decoded (`encoding/base64.StdEncoding`), then `rowcodec.ToRecord`. `Complete` passes `'-'` for a nil body and base64 otherwise, omitted `1` or `0`; the reply string maps to `anyonce.CompleteStatus`. `Get` is `HGetAll` plus the expiry check. `Purge` returns 0. `PhysicallyRemove` is `Del`. Key is `prefix + scope + "\x1f" + key`.

- [ ] **Step 3: Run, PR**

Run the Go gates with `docker compose -f test/compose.yml up -d --wait redis`. Commit, push, PR.

---

### Task 9: Go Postgres store (REQ-ST-PG-1 in Go)

Branch `p3-store-postgres-go`; PR to `p3-stores`, `Part of #1`.

**Files:**
- Create: `go/store/postgres/postgres.go`, `go/store/postgres/schema.sql`, `go/store/postgres/postgres_test.go`, `go/store/internal/sqlstore/sqlstore.go`, `go/store/internal/sqlstore/sqlstore_test.go`
- Modify: `go/go.mod`, `go/go.sum`

**Interfaces:**
- Produces: `sqlstore.Store` (a `database/sql` implementation parameterized by dialect: placeholder style and the schema), used by Postgres and SQLite; `postgres.Open(ctx, dsn) (*sqlstore.Store, error)`, `postgres.New(db *sql.DB) *sqlstore.Store`, `postgres.EnsureSchema(ctx, db) error`, `postgres.Schema` (embedded `schema.sql`).

- [ ] **Step 1: sqlstore, tests against SQLite in memory first (no service)**

Add `github.com/jackc/pgx/v5@v5.11.0` and `modernc.org/sqlite@v1.59.0` (the SQLite module is needed by this task's unit tests and by Task 10). `go/store/internal/sqlstore/sqlstore.go`:

```go
// Package sqlstore is the database/sql store shared by Postgres and SQLite: one conditional statement per
// transition, a follow-up SELECT to classify a refused write.
package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/internal/rowcodec"
)

// Dialect is what differs between SQLite and Postgres.
type Dialect struct {
	// Placeholder renders the nth (1-based) parameter: "?" for SQLite, "$n" for Postgres.
	Placeholder func(n int) string
	// Schema is the CREATE statements, split on ";".
	Schema string
}

const beginSQL = `
INSERT INTO anyonce_records (scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted)
VALUES (?1, ?2, ?3, 'in_flight', 1, ?4 + ?5, ?4, ?4 + ?6, NULL, NULL, 0)
ON CONFLICT(scope, key) DO UPDATE SET
  fingerprint = excluded.fingerprint, state = 'in_flight', fence = anyonce_records.fence + 1,
  lease_until = excluded.lease_until, created_at = excluded.created_at, expires_at = excluded.expires_at,
  result_meta = NULL, result_body = NULL, result_omitted = 0
WHERE anyonce_records.expires_at <= ?4
   OR (anyonce_records.fingerprint = excluded.fingerprint AND anyonce_records.state = 'in_flight' AND anyonce_records.lease_until <= ?4)
RETURNING fence`
const completeSQL = `UPDATE anyonce_records SET state = 'completed', result_meta = ?5, result_body = ?6, result_omitted = ?7
WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND expires_at > ?4 AND state = 'in_flight' RETURNING fence`
const abandonSQL = `DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2 AND fence = ?3 AND state = 'in_flight' RETURNING fence`
const selectSQL = `SELECT scope, key, fingerprint, state, fence, lease_until, created_at, expires_at, result_meta, result_body, result_omitted FROM anyonce_records WHERE scope = ?1 AND key = ?2`
const getSQL = selectSQL + ` AND expires_at > ?3`
const purgeSQL = `DELETE FROM anyonce_records WHERE expires_at <= ?1`
const removeSQL = `DELETE FROM anyonce_records WHERE scope = ?1 AND key = ?2`

// render replaces ?N with the dialect placeholder. Positional reuse (?4 twice) is fine for both dialects when the
// argument list is passed in order, because SQLite and pgx both support numbered parameters.
func render(d Dialect, text string) string {
	out := text
	for n := 9; n >= 1; n-- {
		out = strings.ReplaceAll(out, "?"+strconv.Itoa(n), d.Placeholder(n))
	}
	return out
}

// Store implements anyonce.Store over database/sql.
type Store struct {
	db      *sql.DB
	d       Dialect
	begin   string
	complete string
	abandon string
	sel     string
	get     string
	purge   string
	remove  string
}

// New builds a store; call EnsureSchema first on a fresh database.
func New(db *sql.DB, d Dialect) *Store {
	return &Store{db: db, d: d, begin: render(d, beginSQL), complete: render(d, completeSQL), abandon: render(d, abandonSQL), sel: render(d, selectSQL), get: render(d, getSQL), purge: render(d, purgeSQL), remove: render(d, removeSQL)}
}

// EnsureSchema applies the dialect's schema statements; safe to call repeatedly.
func (s *Store) EnsureSchema(ctx context.Context) error {
	for _, stmt := range strings.Split(s.d.Schema, ";") {
		if strings.TrimSpace(stmt) == "" {
			continue
		}
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("sqlstore: ensure schema: %w", err)
		}
	}
	return nil
}

func ms(t time.Time) int64 { return t.UnixMilli() }

func scanRow(rows *sql.Rows) (rowcodec.Row, error) {
	var r rowcodec.Row
	var meta sql.NullString
	if err := rows.Scan(&r.Scope, &r.Key, &r.Fingerprint, &r.State, &r.Fence, &r.LeaseUntil, &r.CreatedAt, &r.ExpiresAt, &meta, &r.ResultBody, &r.ResultOmitted); err != nil {
		return r, fmt.Errorf("sqlstore: scan: %w", err)
	}
	if meta.Valid {
		r.ResultMeta = &meta.String
	}
	return r, nil
}

func (s *Store) selectRow(ctx context.Context, scope, key string) (*rowcodec.Row, error) {
	rows, err := s.db.QueryContext(ctx, s.sel, scope, key)
	if err != nil {
		return nil, fmt.Errorf("sqlstore: select: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	r, err := scanRow(rows)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) execReturning(ctx context.Context, query string, args ...any) (bool, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return false, fmt.Errorf("sqlstore: exec: %w", err)
	}
	defer rows.Close()
	return rows.Next(), rows.Err()
}

// Begin is one conditional statement; a refused write is classified by one SELECT (plan decisions).
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	now := ms(opts.Now)
	for attempt := 0; attempt < 3; attempt++ {
		rows, err := s.db.QueryContext(ctx, s.begin, op.Scope, op.Key, op.Fingerprint, now, opts.Lease.Milliseconds(), opts.TTL.Milliseconds())
		if err != nil {
			return anyonce.BeginOutcome{}, fmt.Errorf("sqlstore: begin: %w", err)
		}
		if rows.Next() {
			var fence int64
			err := rows.Scan(&fence)
			rows.Close()
			if err != nil {
				return anyonce.BeginOutcome{}, fmt.Errorf("sqlstore: begin scan: %w", err)
			}
			return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: fence}, nil
		}
		rows.Close()
		existing, err := s.selectRow(ctx, op.Scope, op.Key)
		if err != nil {
			return anyonce.BeginOutcome{}, err
		}
		if existing == nil || existing.ExpiresAt <= now {
			continue
		}
		rec := rowcodec.ToRecord(*existing)
		switch {
		case existing.Fingerprint != op.Fingerprint:
			return anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}, nil
		case existing.State == "completed":
			return anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}, nil
		case existing.LeaseUntil > now:
			return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: rec.LeaseUntil}, nil
		}
	}
	return anyonce.BeginOutcome{}, errors.New("sqlstore: begin could not settle after three attempts")
}
```

plus `Complete`, `Abandon`, `Get`, `Purge` (`RowsAffected`) and `PhysicallyRemove` following the TypeScript store line for line (the classification after a refused `Complete`: absent or expired is `not_found`, fence differs is `stale_fence`, otherwise `ok`; after a refused `Abandon`: absent or not in flight is `not_found`, fence differs is `stale_fence`, otherwise `not_found`). `Complete` binds `nil` for `result_body` when the result is omitted or has no body, and `result_omitted` as `int64`.

`sqlstore_test.go`: run `storetest.Run` against an in-memory SQLite (`sql.Open("sqlite", "file::memory:?cache=shared")` with `db.SetMaxOpenConns(1)`) using the SQLite dialect (`Placeholder: func(int) string { return "?" }` is wrong for numbered reuse; use `func(n int) string { return "?" + strconv.Itoa(n) }`, which modernc SQLite accepts), named `REQ-ST-SQLITE-1: the shared sql store passes the contract against in memory SQLite`, plus `REQ-ST-PG-1: render turns ?N into the dialect placeholder without touching quoted text`.

- [ ] **Step 2: Postgres package and tests**

`go/store/postgres/schema.sql` is the Postgres schema (same text as `POSTGRES_SCHEMA` in TypeScript; Task 11 asserts equality). `postgres.go`: `//go:embed schema.sql` into `Schema`; `Dialect` with `Placeholder: func(n int) string { return "$" + strconv.Itoa(n) }`; `New(db *sql.DB) *sqlstore.Store`; `Open(ctx, dsn) (*sqlstore.Store, error)` using `sql.Open("pgx", dsn)` (import `_ "github.com/jackc/pgx/v5/stdlib"`), `db.PingContext`, `SetMaxOpenConns(60)`; `EnsureSchema(ctx, db)`.

`postgres_test.go`: `servicetest.Require(t, "postgres", "127.0.0.1:15432")`, `Open` with `postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable`, `EnsureSchema`, `storetest.Run(t, "postgres", ...)`, a subtest `REQ-ST-PG-1: EnsureSchema is idempotent and creates the expires_at index` (query `pg_indexes`), and the conformance subtest `REQ-ST-PG-1: every core and profile vector passes through httpmw with the Postgres store`.

Postgres numbered parameters: `$4` may appear several times in the begin statement; pgx binds by number, so pass the six arguments once. `BIGINT` columns scan into `int64`; `BYTEA` into `[]byte`; `SMALLINT` into `int64`.

- [ ] **Step 3: Run, PR**

Go gates with the Postgres container up. Commit, push, PR with the begin statement.

---

### Task 10: Go SQLite store (REQ-ST-SQLITE-1)

Branch `p3-store-sqlite-go`; PR to `p3-stores`, `Part of #1`.

**Files:**
- Create: `go/store/sqlite/sqlite.go`, `go/store/sqlite/schema.sql`, `go/store/sqlite/sqlite_test.go`

- [ ] **Step 1: Tests**

`sqlite_test.go`: `storetest.Run(t, "sqlite", ...)` against `sqlite.Open(ctx, t.TempDir()+"/anyonce.db")` (a file, so the race test exercises real locking; `SetMaxOpenConns(1)` keeps writers serialized and is documented as the atomicity mechanism), `PhysicallyRemove`; `REQ-ST-SQLITE-1: the store is cgo free` (a test that `runtime/cgo` is not linked: `//go:build !cgo` is not a test; instead assert the module's `go list -deps` has no `runtime/cgo`, done in Task 11's CI step with `CGO_ENABLED=0 go build ./...`); `REQ-ST-SQLITE-1: EnsureSchema applies the migration and is idempotent`; the conformance subtest `REQ-ST-SQLITE-1: every core and profile vector passes through httpmw with the SQLite store`.

- [ ] **Step 2: Implement**

`schema.sql` is the SQLite schema (same text as `SQLITE_SCHEMA`; Task 11 asserts equality). `sqlite.go`: `//go:embed schema.sql`, `Dialect{Placeholder: "?n", Schema}`, `Open(ctx, path) (*sqlstore.Store, error)` with `sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")` (import `_ "modernc.org/sqlite"`), `SetMaxOpenConns(1)`, `New(db)`, `EnsureSchema`.

- [ ] **Step 3: Run, PR**

`CGO_ENABLED=0 GOROOT= /opt/homebrew/bin/go build -C go ./...` must succeed (NFR-5). Go gates. Commit, push, PR.

---
### Task 11: Cross-language parity checks, docs matrix, CI, phase gate, integration PR ready (REQ-ST-KV-1, REQ-REL-4)

On `p3-stores` after every store PR has merged.

**Files:**
- Create: `packages/stores/test/parity.test.ts`
- Modify: `docs/stores.md` (final matrix, migration links, purge scheduling guidance), `.github/workflows/ci.yml` (`CGO_ENABLED=0` build step in the go job), `test/ci.test.ts`, `README.md` store matrix pointer if a README exists, `CLAUDE.md`

- [ ] **Step 1: Parity tests**

`packages/stores/test/parity.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ABANDON_LUA, BEGIN_LUA, COMPLETE_LUA } from '../src/redis';
import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from '../src/sql';

const root = join(import.meta.dir, '../../..');

describe('cross-language parity', () => {
  test('REQ-ST-REDIS-1: the Go Lua scripts are byte identical to the TypeScript ones', () => {
    const go = readFileSync(join(root, 'go/store/redis/scripts.go'), 'utf8');
    for (const script of [BEGIN_LUA, COMPLETE_LUA, ABANDON_LUA]) expect(go).toContain(script.trim());
  });

  test('REQ-ST-PG-1: the Go Postgres schema file equals the TypeScript schema', () => {
    expect(readFileSync(join(root, 'go/store/postgres/schema.sql'), 'utf8').trim()).toBe(POSTGRES_SCHEMA.trim());
  });

  test('REQ-ST-SQLITE-1: the Go SQLite schema file equals the TypeScript SQLite schema', () => {
    expect(readFileSync(join(root, 'go/store/sqlite/schema.sql'), 'utf8').trim()).toBe(SQLITE_SCHEMA.trim());
  });
});
```

- [ ] **Step 2: CI and docs**

`.github/workflows/ci.yml` go job: add `- run: CGO_ENABLED=0 go build ./...` before `go vet` (NFR-5) and assert it in `test/ci.test.ts` (`REQ-REL-4: the go job builds with cgo disabled`).

`docs/stores.md`: the six rows are present from the store PRs; add a "Choosing" paragraph (Workers: Durable Objects or D1; AWS: DynamoDB; anything with Redis: Redis; relational: Postgres; single binary: SQLite), a "Purge scheduling" paragraph (native TTL stores need nothing; Postgres, D1 and SQLite need `purge(now)` on a schedule, D1 via a cron trigger, Durable Objects sweep themselves), and links to the two migration files. Check every row has all eight columns.

- [ ] **Step 3: Phase gate**

Run after every store has merged into `p3-stores`, with the compose stack up:

1. `GOROOT= scripts/doctor.sh`
2. `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test 2>&1 | tee /tmp/p3.log`, `scripts/no-skips.sh /tmp/p3.log`, `bun run test:reqs` (phase p3: every REQ-ST id covered)
3. `bun run test:coverage`, `bun run size` (unchanged budgets)
4. `docker compose -f test/compose.yml up -d --wait`, `bun run services:check`, `bun run test:services 2>&1 | tee /tmp/p3-services.log`, `scripts/no-skips.sh /tmp/p3-services.log`
5. `bun run test:workers` (D1 and Durable Objects suites plus the P2 tests)
6. `ANYONCE_REQUIRE_SERVICES=1 GOROOT= /opt/homebrew/bin/go test -C go -race -count=1 ./...`, `CGO_ENABLED=0 GOROOT= /opt/homebrew/bin/go build -C go ./...`, vet, golangci-lint, engine coverage gate
7. Every store PR body pasted its SQL or Lua and its gate output (CHECKLIST P3 per-store items: DO alarm purge, DynamoDB TTL and ReturnValuesOnConditionCheckFailure, Redis EVALSHA fallback, Postgres, D1 and SQLite ensureSchema)
8. `docs/stores.md` has one row per store with all columns and the KV rationale
9. Dash gate, key-log gate, changeset `.changeset/p3-stores.md`, `docs/superpowers/questions.md` Q20 raised at the checkpoint
10. `gh pr ready` on the `p3-stores` PR with the body updated: `Closes #1`, REQ ids, the gate output, the review trail

PR body: REQ ids covered are REQ-ST-DO-1, REQ-ST-D1-1, REQ-ST-DDB-1, REQ-ST-REDIS-1, REQ-ST-PG-1, REQ-ST-SQLITE-1, REQ-ST-KV-1 plus REQ-STORE-1..11 against every backend. The `p3-stores` PR is squash-merged to `main` after the checkpoint.
