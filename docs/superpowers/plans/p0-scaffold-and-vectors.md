# P0 Scaffold and Vectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn requirements 4.7 into executable vectors: a JSON schema, 11 `core` and 7 `profile` vectors, a minimal TypeScript runner that executes them against an in-process fetch handler or a base URL, two fixture apps (Hono, net/http) with no idempotency layer that the runner fails in exactly the expected places, plus the workspace, CI skeleton, service containers, and the REQ coverage check.

**Architecture:** Bun workspaces under `packages/` and `conformance/fixtures/`; a Go module under `go/`; shared vectors under `conformance/vectors/<tier>/<name>.json`. The runner (`@anyonce/conformance`) knows only HTTP: it sends each vector's steps to a target and evaluates expectations. Fixture apps expose the endpoints of REQ-CONF-2 and a process-global counter so handler invocations are observable. Everything later (P2 report formats, CLI, Go runner) builds on the runner's `runVectors` result type defined here.

**Tech Stack:** Bun 1.2 (workspaces, `bun test`), TypeScript 5 strict with `exactOptionalPropertyTypes`, Biome 2, tsup, changesets, Ajv (JSON Schema 2020-12), Hono 4, vitest + `@cloudflare/vitest-pool-workers` (workers smoke only), `yaml` (CI and compose file tests), Go 1.25 standard library, golangci-lint, Docker Compose, GitHub Actions.

**Spec:** `requirements.md` sections 4.7 (REQ-CONF-1..4), 4.9 (REQ-REL-4), 6 (P0 row); `docs/superpowers/specs/2026-09-anyonce-design.md` items A3, A6, B1..B8, C2, C3, C6; `docs/superpowers/questions.md` Q5, Q9, Q10.

## Global Constraints

- Prose in docs, comments, commit messages, JSON `title` and `description` fields: no em or en dashes (CLAUDE.md, NFR-6). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' .` returns nothing.
- Test names start with the REQ id they prove, for example `REQ-CONF-1: every vector validates against schema.json`. Tooling tests for `scripts/reqs.ts` are the one exception and start with `reqs script:`.
- TypeScript: `strict`, `exactOptionalPropertyTypes`, no `any` outside test fakes, ESM source. `@anyonce/conformance` may import `node:` modules (it is a test tool, not core).
- Go: standard library only in P0; `go vet`, `go test -race`, `golangci-lint run` clean. No cgo.
- Conventional commits: `feat(conformance): ...`, `test(conformance): REQ-CONF-2 ...`, `chore(ci): ...`. Commit after every task. Run git only from the worktree root with plain commands (no `cd`, no `&&` chains).
- Vector files: `conformance/vectors/core/*.json` and `conformance/vectors/profile/*.json`; ids are `<tier>/<file-name-without-json>`.
- Tier rule (D17, Q9): `core` holds only behavior the draft states; anyonce choices (Retry-After, replay header, 5xx not stored, omitted body, `code` member, 255-byte limit) are `profile`.
- Fixture semantics (design note B4, B5): every POST fixture (`/echo`, `/status/{code}`, `/slow`, `/large`) increments one process-global counter; `GET /counter` returns `{"count":n}` and sits behind the idempotency layer; `POST /reset` zeroes the counter and is the only control endpoint outside the layer. The runner sends `POST /reset` before every vector.
- Capability rule (design note B2, B3): a vector with `requires: ["short-ttl"]` runs only when the runner is given `capabilities: ["short-ttl"]`; `short-ttl` means the target's TTL is at most 2000 ms, so the vector waits 2500 ms. Skipped vectors are reported as `not-applicable`.
- Runtime targets for this phase: Bun for tests, Node 22 for the built package import smoke, workerd for the workers smoke.
- No network in tests beyond `bun install` and local containers.

## File Structure

```
package.json                      workspaces, root scripts (lint, build, test, test:reqs, test:workers, vectors:validate, services:check)
bunfig.toml                       bun test settings
tsconfig.base.json                strict compiler options shared by packages
biome.json                        lint and format
.changeset/config.json            fixed group for @anyonce/*
.github/workflows/ci.yml          jobs: ts, vectors-validate, workers, go, services, node-compat
test/compose.yml                  DynamoDB Local, Redis 7, Postgres 16, Redpanda, ElasticMQ
test/workers/                     vitest config + wrangler.jsonc + smoke test for vitest-pool-workers
scripts/reqs.ts                   REQ coverage check (section 7 item 1)
scripts/services-check.ts         TCP connectivity check for the compose services
scripts/no-skips.sh               fails CI when bun test reports skipped tests
conformance/schema.json           JSON Schema 2020-12 for vector files
conformance/vectors/core/*.json   11 core vectors
conformance/vectors/profile/*.json 7 profile vectors
conformance/README.md             fixture contract, vector format, capabilities, how to add a vector
conformance/fixtures/hono/        @anyonce/fixture-hono: src/app.ts (createFixtureApp), src/server.ts, test/
packages/conformance/             @anyonce/conformance: src/types.ts, src/expect.ts, src/target.ts, src/load.ts, src/run.ts, src/index.ts, test/
go/go.mod                         module github.com/sns45/anyonce/go
go/.golangci.yml
go/conformance/fixture/           fixture.go (NewHandler), fixture_test.go
go/cmd/fixture/main.go            serves the fixture, prints the bound address
```

---

### Task 1: Workspace scaffold, vector schema, and the schema validation test

**Files:**
- Create: `package.json`, `bunfig.toml`, `tsconfig.base.json`, `biome.json`, `.changeset/config.json`, `.changeset/README.md`
- Create: `packages/conformance/package.json`, `packages/conformance/tsconfig.json`, `packages/conformance/src/index.ts`
- Create: `conformance/schema.json`
- Create: `conformance/vectors/core/post-executes-once.json`
- Test: `packages/conformance/test/vectors-validate.test.ts`

**Interfaces:**
- Produces: `conformance/schema.json` (the vector format every later task writes against), root scripts `bun run lint`, `bun run test`, `bun run vectors:validate`.

- [ ] **Step 1: Root workspace files**

`package.json`:

```json
{
  "name": "anyonce-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "conformance/fixtures/*"],
  "scripts": {
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "build": "bun run --filter '@anyonce/*' build",
    "test": "bun test packages conformance scripts",
    "test:reqs": "bun run scripts/reqs.ts --phase p0",
    "test:workers": "vitest run --config test/workers/vitest.config.ts",
    "vectors:validate": "bun test packages/conformance/test/vectors-validate.test.ts",
    "services:check": "bun run scripts/services-check.ts"
  },
  "devDependencies": {}
}
```

`bunfig.toml`:

```toml
[test]
coverage = false
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "declaration": true,
    "types": ["bun-types"]
  }
}
```

`.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [["@anyonce/*"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@anyonce/fixture-hono"]
}
```

`.changeset/README.md`: one line, "Changesets for @anyonce packages. Run `bunx changeset` for any public API change."

Install dev tooling (bun resolves the latest and locks it in `bun.lock`):

```bash
bun add -d typescript @types/bun @biomejs/biome tsup @changesets/cli ajv ajv-formats yaml
bunx biome init
```

Then replace the generated `biome.json` with:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "files": { "includes": ["**", "!**/dist", "!**/node_modules", "!**/.wrangler", "!**/.claude", "!bun.lock"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true, "suspicious": { "noExplicitAny": "error" } } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "always" } },
  "json": { "parser": { "allowComments": true } }
}
```

- [ ] **Step 2: Conformance package skeleton**

`packages/conformance/package.json`:

```json
{
  "name": "@anyonce/conformance",
  "version": "0.0.0",
  "description": "Conformance runner and vectors for draft-ietf-httpapi-idempotency-key-header",
  "license": "Apache-2.0",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/conformance/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/conformance/src/index.ts`:

```ts
export const VERSION = '0.0.0';
```

- [ ] **Step 3: Write the failing validation test**

`packages/conformance/test/vectors-validate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const root = join(import.meta.dir, '../../../conformance');
const schemaPath = join(root, 'schema.json');

function listVectorFiles(): string[] {
  const out: string[] = [];
  for (const tier of ['core', 'profile']) {
    const dir = join(root, 'vectors', tier);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.json')) out.push(join(dir, name));
    }
  }
  return out.sort();
}

describe('vector schema', () => {
  test('REQ-CONF-1: schema.json is a JSON Schema 2020-12 document', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  test('REQ-CONF-1: every vector validates against schema.json', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const files = listVectorFiles();
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const file of files) {
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      if (!validate(vector)) {
        failures.push(`${file}: ${ajv.errorsText(validate.errors)}`);
      }
      const expectedId = file.replace(/^.*\/vectors\//, '').replace(/\.json$/, '');
      if (vector.id !== expectedId) failures.push(`${file}: id ${vector.id} must equal ${expectedId}`);
    }
    expect(failures).toEqual([]);
  });

  test('REQ-CONF-1: step ids are unique and every reference points at an earlier step', () => {
    const failures: string[] = [];
    for (const file of listVectorFiles()) {
      const vector = JSON.parse(readFileSync(file, 'utf8'));
      const seen = new Set<string>();
      for (const step of vector.steps) {
        if (seen.has(step.id)) failures.push(`${vector.id}: duplicate step id ${step.id}`);
        for (const ref of step.concurrentWith ?? []) {
          if (!seen.has(ref)) failures.push(`${vector.id}: step ${step.id} concurrentWith unknown ${ref}`);
        }
        const same = step.expect.bodyEquals;
        if (typeof same === 'object' && same !== null && !seen.has(same.sameAs)) {
          failures.push(`${vector.id}: step ${step.id} sameAs unknown ${same.sameAs}`);
        }
        seen.add(step.id);
      }
    }
    expect(failures).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it, expect failure**

Run: `bun install` then `bun run vectors:validate`
Expected: FAIL, `ENOENT` on `conformance/schema.json`.

- [ ] **Step 5: Write the schema**

`conformance/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://in8.sh/anyonce/conformance/schema.json",
  "title": "anyonce conformance vector",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "tier", "title", "description", "fixture", "steps"],
  "properties": {
    "id": { "type": "string", "pattern": "^(core|profile)/[a-z0-9]+(-[a-z0-9]+)*$" },
    "tier": { "enum": ["core", "profile"] },
    "title": { "type": "string", "minLength": 1 },
    "draftRef": { "type": "string", "pattern": "^section-[0-9]+(\\.[0-9]+)*$" },
    "description": { "type": "string", "minLength": 1 },
    "requires": { "type": "array", "uniqueItems": true, "items": { "enum": ["short-ttl"] } },
    "fixture": { "enum": ["echo", "status", "slow", "large", "counter"] },
    "steps": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/step" } }
  },
  "allOf": [
    { "if": { "properties": { "tier": { "const": "core" } } }, "then": { "required": ["draftRef"] } }
  ],
  "$defs": {
    "stepId": { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "step": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "request", "expect"],
      "properties": {
        "id": { "$ref": "#/$defs/stepId" },
        "delayMs": { "type": "integer", "minimum": 0 },
        "concurrentWith": { "type": "array", "minItems": 1, "uniqueItems": true, "items": { "$ref": "#/$defs/stepId" } },
        "request": {
          "type": "object",
          "additionalProperties": false,
          "required": ["method", "path"],
          "properties": {
            "method": { "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            "path": { "type": "string", "pattern": "^/" },
            "headers": { "type": "object", "additionalProperties": { "type": "string" } },
            "body": { "type": "string" }
          }
        },
        "expect": {
          "type": "object",
          "additionalProperties": false,
          "required": ["status"],
          "properties": {
            "status": { "type": "integer", "minimum": 100, "maximum": 599 },
            "headers": {
              "type": "object",
              "additionalProperties": {
                "oneOf": [
                  { "type": "string" },
                  { "type": "object", "additionalProperties": false, "required": ["present"], "properties": { "present": { "const": true } } },
                  { "type": "object", "additionalProperties": false, "required": ["absent"], "properties": { "absent": { "const": true } } },
                  { "type": "object", "additionalProperties": false, "required": ["regex"], "properties": { "regex": { "type": "string" } } }
                ]
              }
            },
            "bodyEquals": {
              "oneOf": [
                { "type": "string" },
                { "type": "object", "additionalProperties": false, "required": ["sameAs"], "properties": { "sameAs": { "$ref": "#/$defs/stepId" } } }
              ]
            },
            "bodyJson": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean", "null"] } },
            "bodyBytes": { "type": "integer", "minimum": 0 },
            "handlerInvocations": { "type": "integer", "minimum": 0 }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 6: Write the first vector**

`conformance/vectors/core/post-executes-once.json`:

```json
{
  "id": "core/post-executes-once",
  "tier": "core",
  "title": "A POST with a fresh Idempotency-Key executes the handler exactly once",
  "draftRef": "section-2.6",
  "description": "First time request: the resource processes the request normally. The counter proves one invocation.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-post-once-1", "Content-Type": "text/plain" }, "body": "hello" },
      "expect": { "status": 201, "bodyEquals": "hello", "handlerInvocations": 1 }
    }
  ]
}
```

- [ ] **Step 7: Run tests, lint and typecheck, expect pass**

Run: `bun run vectors:validate`, then `bun run lint`, then `bun run --filter @anyonce/conformance typecheck`
Expected: 3 tests pass, Biome clean, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock bunfig.toml tsconfig.base.json biome.json .changeset packages/conformance conformance/schema.json conformance/vectors
git commit -m "feat(conformance): REQ-CONF-1 vector schema, workspace scaffold, first core vector"
```

---

### Task 2: The core tier (REQ-CONF-3)

**Files:**
- Create: `conformance/vectors/core/key-missing-required.json`, `retry-replays.json`, `mismatch-422.json`, `mismatch-does-not-poison.json`, `concurrent-409.json`, `sf-string-quoted-key.json`, `header-name-case-insensitive.json`, `get-ignored.json`, `two-keys-execute-twice.json`, `expiry-executes-again.json` (all under `conformance/vectors/core/`)
- Create: `packages/conformance/test/catalog.ts` (plain module with the id lists, imported by several test files)
- Test: `packages/conformance/test/vectors-catalog.test.ts`

**Interfaces:**
- Produces: `CORE_IDS` in `test/catalog.ts`, the 11 core vector ids listed below. Task 7 and Task 9 depend on these exact ids.

- [ ] **Step 1: Write the failing catalog test**

`packages/conformance/test/catalog.ts`:

```ts
/** Vector ids by tier. Kept in a plain module so test files never import each other. */
export const CORE_IDS = [
  'core/concurrent-409',
  'core/expiry-executes-again',
  'core/get-ignored',
  'core/header-name-case-insensitive',
  'core/key-missing-required',
  'core/mismatch-422',
  'core/mismatch-does-not-poison',
  'core/post-executes-once',
  'core/retry-replays',
  'core/sf-string-quoted-key',
  'core/two-keys-execute-twice',
];
```

`packages/conformance/test/vectors-catalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_IDS } from './catalog';

const vectorsDir = join(import.meta.dir, '../../../conformance/vectors');

type Loaded = { id: string; tier: string; draftRef?: string; requires?: string[] };

function loadTier(tier: string): Loaded[] {
  return readdirSync(join(vectorsDir, tier))
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(vectorsDir, tier, n), 'utf8')) as Loaded)
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe('vector catalog', () => {
  test('REQ-CONF-3: core tier contains the minimum vector set', () => {
    expect(loadTier('core').map((v) => v.id)).toEqual(CORE_IDS);
  });

  test('REQ-CONF-3: every core vector cites a draft section', () => {
    for (const v of loadTier('core')) {
      expect(v.tier).toBe('core');
      expect(v.draftRef).toMatch(/^section-\d/);
    }
  });

  test('REQ-CONF-3: only the expiry vector requires a capability', () => {
    const requiring = loadTier('core').filter((v) => (v.requires ?? []).length > 0).map((v) => v.id);
    expect(requiring).toEqual(['core/expiry-executes-again']);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/conformance/test/vectors-catalog.test.ts`
Expected: FAIL, received `['core/post-executes-once']`.

- [ ] **Step 3: Write the ten remaining core vectors**

`key-missing-required.json`:

```json
{
  "id": "core/key-missing-required",
  "tier": "core",
  "title": "Missing Idempotency-Key on a documented idempotent operation yields 400 problem details",
  "draftRef": "section-2.7",
  "description": "The fixture's POST routes require the header. The resource replies 400 with an application/problem+json body and does not run the handler.",
  "fixture": "echo",
  "steps": [
    {
      "id": "missing",
      "request": { "method": "POST", "path": "/echo", "headers": { "Content-Type": "text/plain" }, "body": "no key" },
      "expect": { "status": 400, "headers": { "Content-Type": { "regex": "^application/problem\\+json" } }, "handlerInvocations": 0 }
    }
  ]
}
```

`retry-replays.json`:

```json
{
  "id": "core/retry-replays",
  "tier": "core",
  "title": "A retry after completion replays the stored status and body without executing again",
  "draftRef": "section-2.6",
  "description": "Duplicate request, Retry: the resource responds with the result of the previously completed operation. The counter stays at one.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-retry-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201, "bodyEquals": "payload-a", "handlerInvocations": 1 }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-retry-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201, "bodyEquals": { "sameAs": "first" }, "handlerInvocations": 1 }
    }
  ]
}
```

`mismatch-422.json`:

```json
{
  "id": "core/mismatch-422",
  "tier": "core",
  "title": "Reusing a key with a different payload yields 422 problem details",
  "draftRef": "section-2.7",
  "description": "The idempotency key MUST NOT be reused with a different request payload; the resource replies 422 and does not run the handler again.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-mismatch-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201, "handlerInvocations": 1 }
    },
    {
      "id": "changed",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-mismatch-1", "Content-Type": "text/plain" }, "body": "payload-b" },
      "expect": { "status": 422, "headers": { "Content-Type": { "regex": "^application/problem\\+json" } }, "handlerInvocations": 1 }
    }
  ]
}
```

`mismatch-does-not-poison.json`:

```json
{
  "id": "core/mismatch-does-not-poison",
  "tier": "core",
  "title": "A rejected mismatch leaves the original record intact",
  "draftRef": "section-2.7",
  "description": "Clients MUST correct the request before retrying. After a 422, retrying with the original payload still replays the original result and does not execute again.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-poison-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201, "bodyEquals": "payload-a", "handlerInvocations": 1 }
    },
    {
      "id": "changed",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-poison-1", "Content-Type": "text/plain" }, "body": "payload-b" },
      "expect": { "status": 422, "handlerInvocations": 1 }
    },
    {
      "id": "corrected",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-poison-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201, "bodyEquals": { "sameAs": "first" }, "handlerInvocations": 1 }
    }
  ]
}
```

`concurrent-409.json`:

```json
{
  "id": "core/concurrent-409",
  "tier": "core",
  "title": "A duplicate sent while the original is in flight yields 409 problem details",
  "draftRef": "section-2.6",
  "description": "Concurrent Request: the request was retried before the original completed. The first request holds the handler for 1500 ms; the second is sent 300 ms later and must receive a resource conflict error. Only one handler invocation occurs.",
  "fixture": "slow",
  "steps": [
    {
      "id": "original",
      "request": { "method": "POST", "path": "/slow?ms=1500", "headers": { "Idempotency-Key": "k-concurrent-1", "Content-Type": "text/plain" }, "body": "slow" },
      "expect": { "status": 200, "bodyEquals": "slept:1500" }
    },
    {
      "id": "duplicate",
      "concurrentWith": ["original"],
      "delayMs": 300,
      "request": { "method": "POST", "path": "/slow?ms=1500", "headers": { "Idempotency-Key": "k-concurrent-1", "Content-Type": "text/plain" }, "body": "slow" },
      "expect": { "status": 409, "headers": { "Content-Type": { "regex": "^application/problem\\+json" } }, "handlerInvocations": 1 }
    }
  ]
}
```

`sf-string-quoted-key.json`:

```json
{
  "id": "core/sf-string-quoted-key",
  "tier": "core",
  "title": "A quoted Structured Field string key is accepted and deduplicated",
  "draftRef": "section-2.1",
  "description": "Idempotency-Key is an Item Structured Header whose value MUST be a String, so the quoted form must be accepted and a retry with the same quoted key must replay.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "\"quoted-key-1\"", "Content-Type": "text/plain" }, "body": "quoted" },
      "expect": { "status": 201, "bodyEquals": "quoted", "handlerInvocations": 1 }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "\"quoted-key-1\"", "Content-Type": "text/plain" }, "body": "quoted" },
      "expect": { "status": 201, "bodyEquals": { "sameAs": "first" }, "handlerInvocations": 1 }
    }
  ]
}
```

`header-name-case-insensitive.json`:

```json
{
  "id": "core/header-name-case-insensitive",
  "tier": "core",
  "title": "The header field name is matched case-insensitively",
  "draftRef": "section-2.1",
  "description": "HTTP field names are case-insensitive (RFC 9110 section 5.1). A retry that spells the field name in lowercase must replay the first result.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-case-1", "Content-Type": "text/plain" }, "body": "case" },
      "expect": { "status": 201, "handlerInvocations": 1 }
    },
    {
      "id": "retry-lowercase",
      "request": { "method": "POST", "path": "/echo", "headers": { "idempotency-key": "k-case-1", "Content-Type": "text/plain" }, "body": "case" },
      "expect": { "status": 201, "bodyEquals": { "sameAs": "first" }, "handlerInvocations": 1 }
    }
  ]
}
```

`get-ignored.json`:

```json
{
  "id": "core/get-ignored",
  "tier": "core",
  "title": "An Idempotency-Key on a GET request is ignored",
  "draftRef": "section-1",
  "description": "The header makes non-idempotent methods such as POST or PATCH fault-tolerant; GET is already idempotent. Two GETs with the same key must both execute and the second must not replay the first body.",
  "fixture": "counter",
  "steps": [
    {
      "id": "get-before",
      "request": { "method": "GET", "path": "/counter", "headers": { "Idempotency-Key": "k-get-1" } },
      "expect": { "status": 200, "bodyJson": { "count": 0 } }
    },
    {
      "id": "post",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-get-2", "Content-Type": "text/plain" }, "body": "x" },
      "expect": { "status": 201, "handlerInvocations": 1 }
    },
    {
      "id": "get-after",
      "request": { "method": "GET", "path": "/counter", "headers": { "Idempotency-Key": "k-get-1" } },
      "expect": { "status": 200, "bodyJson": { "count": 1 }, "headers": { "Idempotency-Replayed": { "absent": true } } }
    }
  ]
}
```

`two-keys-execute-twice.json`:

```json
{
  "id": "core/two-keys-execute-twice",
  "tier": "core",
  "title": "Two different keys with the same payload execute twice",
  "draftRef": "section-2.2",
  "description": "Uniqueness is defined by the key, not the payload. The same body under two keys is two operations.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-two-1", "Content-Type": "text/plain" }, "body": "same" },
      "expect": { "status": 201, "handlerInvocations": 1 }
    },
    {
      "id": "second",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-two-2", "Content-Type": "text/plain" }, "body": "same" },
      "expect": { "status": 201, "handlerInvocations": 2 }
    }
  ]
}
```

`expiry-executes-again.json`:

```json
{
  "id": "core/expiry-executes-again",
  "tier": "core",
  "title": "After the published expiry the same key executes again",
  "draftRef": "section-2.3",
  "description": "The resource MAY purge keys on expiry. Requires the short-ttl capability (TTL at most 2000 ms); after 2500 ms the same key and payload must execute the handler again.",
  "fixture": "echo",
  "requires": ["short-ttl"],
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-expiry-1", "Content-Type": "text/plain" }, "body": "expire" },
      "expect": { "status": 201, "handlerInvocations": 1 }
    },
    {
      "id": "after-expiry",
      "delayMs": 2500,
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-expiry-1", "Content-Type": "text/plain" }, "body": "expire" },
      "expect": { "status": 201, "handlerInvocations": 2 }
    }
  ]
}
```

- [ ] **Step 4: Run the catalog and schema tests, expect pass**

Run: `bun test packages/conformance/test`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add conformance/vectors/core packages/conformance/test/catalog.ts packages/conformance/test/vectors-catalog.test.ts
git commit -m "feat(conformance): REQ-CONF-3 core tier vectors"
```

---

### Task 3: The profile tier (REQ-CONF-4)

**Files:**
- Create: `conformance/vectors/profile/replayed-header.json`, `retry-after-on-409.json`, `4xx-replayed.json`, `5xx-not-stored.json`, `omitted-body-replay.json`, `problem-code-member.json`, `key-too-long.json` (all under `conformance/vectors/profile/`)
- Modify: `packages/conformance/test/catalog.ts` (add `PROFILE_IDS`), `packages/conformance/test/vectors-catalog.test.ts` (import it, add two tests)

**Interfaces:**
- Produces: `PROFILE_IDS` in `test/catalog.ts`; the 7 profile vector ids.

- [ ] **Step 1: Add the failing profile tests**

Append to `packages/conformance/test/catalog.ts` (and add `PROFILE_IDS` to the import in the catalog test):

```ts
export const PROFILE_IDS = [
  'profile/4xx-replayed',
  'profile/5xx-not-stored',
  'profile/key-too-long',
  'profile/omitted-body-replay',
  'profile/problem-code-member',
  'profile/replayed-header',
  'profile/retry-after-on-409',
];
```

and inside the `describe`:

```ts
  test('REQ-CONF-4: profile tier contains the anyonce extension vectors', () => {
    expect(loadTier('profile').map((v) => v.id)).toEqual(PROFILE_IDS);
  });

  test('REQ-CONF-4: profile vectors never require a capability', () => {
    expect(loadTier('profile').filter((v) => (v.requires ?? []).length > 0)).toEqual([]);
  });
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/conformance/test/vectors-catalog.test.ts`
Expected: FAIL, `ENOENT` on `conformance/vectors/profile`.

- [ ] **Step 3: Write the seven profile vectors**

`replayed-header.json`:

```json
{
  "id": "profile/replayed-header",
  "tier": "profile",
  "title": "A replayed response carries Idempotency-Replayed: true and the original does not",
  "description": "anyonce profile: replay is marked with the Idempotency-Replayed response header so clients can tell a replay from a fresh execution.",
  "fixture": "echo",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-replayed-1", "Content-Type": "text/plain" }, "body": "r" },
      "expect": { "status": 201, "headers": { "Idempotency-Replayed": { "absent": true } } }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-replayed-1", "Content-Type": "text/plain" }, "body": "r" },
      "expect": { "status": 201, "headers": { "Idempotency-Replayed": "true" }, "bodyEquals": { "sameAs": "first" } }
    }
  ]
}
```

`retry-after-on-409.json`:

```json
{
  "id": "profile/retry-after-on-409",
  "tier": "profile",
  "title": "A 409 for an in-flight duplicate carries Retry-After in whole seconds",
  "description": "anyonce profile: Retry-After is derived from the remaining lease, at least 1 second.",
  "fixture": "slow",
  "steps": [
    {
      "id": "original",
      "request": { "method": "POST", "path": "/slow?ms=1500", "headers": { "Idempotency-Key": "k-retry-after-1", "Content-Type": "text/plain" }, "body": "slow" },
      "expect": { "status": 200 }
    },
    {
      "id": "duplicate",
      "concurrentWith": ["original"],
      "delayMs": 300,
      "request": { "method": "POST", "path": "/slow?ms=1500", "headers": { "Idempotency-Key": "k-retry-after-1", "Content-Type": "text/plain" }, "body": "slow" },
      "expect": { "status": 409, "headers": { "Retry-After": { "regex": "^[1-9][0-9]*$" } } }
    }
  ]
}
```

`4xx-replayed.json`:

```json
{
  "id": "profile/4xx-replayed",
  "tier": "profile",
  "title": "A stored 4xx result is replayed",
  "description": "anyonce profile (D6): results with status below 500 are stored, so a 404 from the handler replays as 404 without a second execution.",
  "fixture": "status",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/status/404", "headers": { "Idempotency-Key": "k-4xx-1", "Content-Type": "text/plain" }, "body": "s" },
      "expect": { "status": 404, "bodyEquals": "status:404", "handlerInvocations": 1 }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/status/404", "headers": { "Idempotency-Key": "k-4xx-1", "Content-Type": "text/plain" }, "body": "s" },
      "expect": { "status": 404, "bodyEquals": { "sameAs": "first" }, "headers": { "Idempotency-Replayed": "true" }, "handlerInvocations": 1 }
    }
  ]
}
```

`5xx-not-stored.json`:

```json
{
  "id": "profile/5xx-not-stored",
  "tier": "profile",
  "title": "A 5xx result is not stored, so a retry executes again",
  "description": "anyonce profile (D6): on 5xx the record is abandoned so the client can retry; the second request executes and is not marked as a replay.",
  "fixture": "status",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/status/500", "headers": { "Idempotency-Key": "k-5xx-1", "Content-Type": "text/plain" }, "body": "s" },
      "expect": { "status": 500, "bodyEquals": "status:500", "handlerInvocations": 1 }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/status/500", "headers": { "Idempotency-Key": "k-5xx-1", "Content-Type": "text/plain" }, "body": "s" },
      "expect": { "status": 500, "headers": { "Idempotency-Replayed": { "absent": true } }, "handlerInvocations": 2 }
    }
  ]
}
```

`omitted-body-replay.json`:

```json
{
  "id": "profile/omitted-body-replay",
  "tier": "profile",
  "title": "A result above the stored size cap replays with status and headers but an empty body",
  "description": "anyonce profile (D12): the original streams through untouched; the replay returns the original status, an empty body, Idempotency-Replayed: true and Idempotency-Replay: omitted. The cap is 1 MiB, so the fixture returns one byte more.",
  "fixture": "large",
  "steps": [
    {
      "id": "first",
      "request": { "method": "POST", "path": "/large?bytes=1048577", "headers": { "Idempotency-Key": "k-omitted-1", "Content-Type": "text/plain" }, "body": "l" },
      "expect": { "status": 200, "bodyBytes": 1048577, "handlerInvocations": 1 }
    },
    {
      "id": "retry",
      "request": { "method": "POST", "path": "/large?bytes=1048577", "headers": { "Idempotency-Key": "k-omitted-1", "Content-Type": "text/plain" }, "body": "l" },
      "expect": { "status": 200, "bodyBytes": 0, "headers": { "Idempotency-Replayed": "true", "Idempotency-Replay": "omitted" }, "handlerInvocations": 1 }
    }
  ]
}
```

`problem-code-member.json`:

```json
{
  "id": "profile/problem-code-member",
  "tier": "profile",
  "title": "Problem details carry a stable code member",
  "description": "anyonce profile (D10, D11): every error body is RFC 9457 problem details with a code member: missing-key for 400, fingerprint-mismatch for 422.",
  "fixture": "echo",
  "steps": [
    {
      "id": "missing",
      "request": { "method": "POST", "path": "/echo", "headers": { "Content-Type": "text/plain" }, "body": "no key" },
      "expect": { "status": 400, "bodyJson": { "code": "missing-key" } }
    },
    {
      "id": "first",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-code-1", "Content-Type": "text/plain" }, "body": "payload-a" },
      "expect": { "status": 201 }
    },
    {
      "id": "changed",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "k-code-1", "Content-Type": "text/plain" }, "body": "payload-b" },
      "expect": { "status": 422, "bodyJson": { "code": "fingerprint-mismatch" } }
    }
  ]
}
```

`key-too-long.json` (the key is exactly 256 `a` characters):

```json
{
  "id": "profile/key-too-long",
  "tier": "profile",
  "title": "A key longer than 255 bytes yields 400 invalid-key",
  "description": "anyonce profile (D7): keys are 1 to 255 bytes of printable ASCII. The draft sets no maximum; this is recorded as a draft gap.",
  "fixture": "echo",
  "steps": [
    {
      "id": "too-long",
      "request": { "method": "POST", "path": "/echo", "headers": { "Idempotency-Key": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Content-Type": "text/plain" }, "body": "long" },
      "expect": { "status": 400, "bodyJson": { "code": "invalid-key" }, "handlerInvocations": 0 }
    }
  ]
}
```

Verify the key length before committing: `bun -e "const v=JSON.parse(require('fs').readFileSync('conformance/vectors/profile/key-too-long.json','utf8')); console.log(v.steps[0].request.headers['Idempotency-Key'].length)"` must print `256`.

- [ ] **Step 4: Run tests and lint, expect pass**

Run: `bun test packages/conformance/test`, then `bun run lint`
Expected: 8 tests pass, Biome clean.

- [ ] **Step 5: Commit**

```bash
git add conformance/vectors/profile packages/conformance/test/vectors-catalog.test.ts
git commit -m "feat(conformance): REQ-CONF-4 profile tier vectors"
```

---

### Task 4: Runner types and the expectation evaluator

**Files:**
- Create: `packages/conformance/src/types.ts`, `packages/conformance/src/expect.ts`
- Modify: `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/expect.test.ts`

**Interfaces:**
- Produces: the types below (used verbatim by Task 5, Task 7, Task 9 and by P2) and `evaluateExpect(expect, observed, ctx): string[]` where an empty array means the step passed.

- [ ] **Step 1: Write the types**

`packages/conformance/src/types.ts`:

```ts
export type Tier = 'core' | 'profile';
export type Capability = 'short-ttl';
export type FixtureName = 'echo' | 'status' | 'slow' | 'large' | 'counter';
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HeaderExpectation = string | { present: true } | { absent: true } | { regex: string };

export interface StepRequest {
  method: Method;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface StepExpect {
  status: number;
  headers?: Record<string, HeaderExpectation>;
  bodyEquals?: string | { sameAs: string };
  bodyJson?: Record<string, string | number | boolean | null>;
  bodyBytes?: number;
  handlerInvocations?: number;
}

export interface Step {
  id: string;
  delayMs?: number;
  concurrentWith?: string[];
  request: StepRequest;
  expect: StepExpect;
}

export interface Vector {
  id: string;
  tier: Tier;
  title: string;
  draftRef?: string;
  description: string;
  requires?: Capability[];
  fixture: FixtureName;
  steps: Step[];
}

export interface ObservedResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface StepOutcome {
  stepId: string;
  failures: string[];
}

export type VectorStatus = 'pass' | 'fail' | 'not-applicable' | 'error';

export interface VectorResult {
  id: string;
  tier: Tier;
  status: VectorStatus;
  steps: StepOutcome[];
  error?: string;
}

export interface RunSummary {
  results: VectorResult[];
  passed: number;
  failed: number;
  notApplicable: number;
  errored: number;
}

export interface EvaluationContext {
  /** Bodies of earlier steps in this vector, by step id, for sameAs. */
  priorBodies: Map<string, Uint8Array>;
  /** Counter value read after the step (and its concurrent group) settled, when the expectation asks for it. */
  handlerInvocations?: number;
}
```

- [ ] **Step 2: Write the failing evaluator test**

`packages/conformance/test/expect.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateExpect } from '../src/expect';
import type { EvaluationContext, ObservedResponse } from '../src/types';

const enc = new TextEncoder();

function observed(status: number, headers: Record<string, string>, body = ''): ObservedResponse {
  return { status, headers: new Headers(headers), body: enc.encode(body) };
}

function ctx(extra: Partial<EvaluationContext> = {}): EvaluationContext {
  return { priorBodies: new Map(), ...extra };
}

describe('evaluateExpect', () => {
  test('REQ-CONF-1: status mismatch is reported with expected and actual', () => {
    expect(evaluateExpect({ status: 201 }, observed(200, {}), ctx())).toEqual(['status: expected 201, got 200']);
  });

  test('REQ-CONF-1: exact header match is case-insensitive on the name and exact on the value', () => {
    const ok = evaluateExpect({ status: 200, headers: { 'idempotency-replayed': 'true' } }, observed(200, { 'Idempotency-Replayed': 'true' }), ctx());
    expect(ok).toEqual([]);
    const bad = evaluateExpect({ status: 200, headers: { 'Idempotency-Replayed': 'true' } }, observed(200, { 'Idempotency-Replayed': 'True' }), ctx());
    expect(bad).toEqual(['header Idempotency-Replayed: expected "true", got "True"']);
  });

  test('REQ-CONF-1: present, absent and regex header expectations', () => {
    const res = observed(409, { 'Retry-After': '3', 'Content-Type': 'application/problem+json' });
    expect(evaluateExpect({ status: 409, headers: { 'Retry-After': { present: true } } }, res, ctx())).toEqual([]);
    expect(evaluateExpect({ status: 409, headers: { 'Idempotency-Replayed': { absent: true } } }, res, ctx())).toEqual([]);
    expect(evaluateExpect({ status: 409, headers: { 'Retry-After': { regex: '^[1-9][0-9]*$' } } }, res, ctx())).toEqual([]);
    expect(evaluateExpect({ status: 409, headers: { 'Content-Type': { absent: true } } }, res, ctx())).toEqual([
      'header Content-Type: expected absent, got "application/problem+json"',
    ]);
    expect(evaluateExpect({ status: 409, headers: { 'X-Missing': { present: true } } }, res, ctx())).toEqual(['header X-Missing: expected present, got absent']);
    expect(evaluateExpect({ status: 409, headers: { 'Retry-After': { regex: '^0$' } } }, res, ctx())).toEqual(['header Retry-After: expected /^0$/, got "3"']);
  });

  test('REQ-CONF-1: bodyEquals compares the utf8 body and sameAs compares bytes with an earlier step', () => {
    expect(evaluateExpect({ status: 200, bodyEquals: 'hello' }, observed(200, {}, 'hello'), ctx())).toEqual([]);
    expect(evaluateExpect({ status: 200, bodyEquals: 'hello' }, observed(200, {}, 'bye'), ctx())).toEqual(['body: expected "hello", got "bye"']);
    const prior = new Map([['first', enc.encode('hello')]]);
    expect(evaluateExpect({ status: 200, bodyEquals: { sameAs: 'first' } }, observed(200, {}, 'hello'), ctx({ priorBodies: prior }))).toEqual([]);
    expect(evaluateExpect({ status: 200, bodyEquals: { sameAs: 'first' } }, observed(200, {}, 'other'), ctx({ priorBodies: prior }))).toEqual([
      'body: expected same bytes as step first (5 bytes), got 5 bytes that differ',
    ]);
    expect(evaluateExpect({ status: 200, bodyEquals: { sameAs: 'nope' } }, observed(200, {}, 'x'), ctx())).toEqual(['body: sameAs references unknown step nope']);
  });

  test('REQ-CONF-1: bodyJson checks top-level members and reports parse errors', () => {
    expect(evaluateExpect({ status: 400, bodyJson: { code: 'missing-key' } }, observed(400, {}, '{"code":"missing-key","title":"x"}'), ctx())).toEqual([]);
    expect(evaluateExpect({ status: 400, bodyJson: { code: 'missing-key' } }, observed(400, {}, '{"code":"other"}'), ctx())).toEqual(['body.code: expected "missing-key", got "other"']);
    expect(evaluateExpect({ status: 400, bodyJson: { code: 'missing-key' } }, observed(400, {}, 'not json'), ctx())).toEqual(['body: expected JSON object, got unparseable body']);
    expect(evaluateExpect({ status: 200, bodyJson: { count: 1 } }, observed(200, {}, '{"count":0}'), ctx())).toEqual(['body.count: expected 1, got 0']);
  });

  test('REQ-CONF-1: bodyBytes checks the byte length', () => {
    expect(evaluateExpect({ status: 200, bodyBytes: 5 }, observed(200, {}, 'hello'), ctx())).toEqual([]);
    expect(evaluateExpect({ status: 200, bodyBytes: 0 }, observed(200, {}, 'hello'), ctx())).toEqual(['body: expected 0 bytes, got 5']);
  });

  test('REQ-CONF-1: handlerInvocations compares against the counter read by the runner', () => {
    expect(evaluateExpect({ status: 200, handlerInvocations: 1 }, observed(200, {}), ctx({ handlerInvocations: 1 }))).toEqual([]);
    expect(evaluateExpect({ status: 200, handlerInvocations: 1 }, observed(200, {}), ctx({ handlerInvocations: 2 }))).toEqual(['handlerInvocations: expected 1, got 2']);
    expect(evaluateExpect({ status: 200, handlerInvocations: 1 }, observed(200, {}), ctx())).toEqual(['handlerInvocations: counter unavailable']);
  });

  test('REQ-CONF-1: all failures are collected, not just the first', () => {
    const out = evaluateExpect({ status: 201, bodyEquals: 'a', headers: { 'X-A': 'b' } }, observed(200, {}, 'z'), ctx());
    expect(out).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `bun test packages/conformance/test/expect.test.ts`
Expected: FAIL, cannot resolve `../src/expect`.

- [ ] **Step 4: Implement the evaluator**

`packages/conformance/src/expect.ts`:

```ts
import type { EvaluationContext, HeaderExpectation, ObservedResponse, StepExpect } from './types';

const decoder = new TextDecoder();

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function checkHeader(name: string, expectation: HeaderExpectation, headers: Headers): string | undefined {
  const actual = headers.get(name);
  if (typeof expectation === 'string') {
    if (actual === null) return `header ${name}: expected "${expectation}", got absent`;
    if (actual !== expectation) return `header ${name}: expected "${expectation}", got "${actual}"`;
    return undefined;
  }
  if ('present' in expectation) {
    return actual === null ? `header ${name}: expected present, got absent` : undefined;
  }
  if ('absent' in expectation) {
    return actual === null ? undefined : `header ${name}: expected absent, got "${actual}"`;
  }
  const re = new RegExp(expectation.regex);
  if (actual === null) return `header ${name}: expected /${expectation.regex}/, got absent`;
  if (!re.test(actual)) return `header ${name}: expected /${expectation.regex}/, got "${actual}"`;
  return undefined;
}

function checkBodyEquals(expected: string | { sameAs: string }, body: Uint8Array, ctx: EvaluationContext): string | undefined {
  if (typeof expected === 'string') {
    const actual = decoder.decode(body);
    return actual === expected ? undefined : `body: expected "${expected}", got "${actual}"`;
  }
  const prior = ctx.priorBodies.get(expected.sameAs);
  if (prior === undefined) return `body: sameAs references unknown step ${expected.sameAs}`;
  if (bytesEqual(prior, body)) return undefined;
  return `body: expected same bytes as step ${expected.sameAs} (${prior.byteLength} bytes), got ${body.byteLength} bytes that differ`;
}

function checkBodyJson(expected: Record<string, unknown>, body: Uint8Array): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(body));
  } catch {
    return ['body: expected JSON object, got unparseable body'];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['body: expected JSON object, got non-object'];
  }
  const record = parsed as Record<string, unknown>;
  const failures: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      failures.push(`body.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(record[key])}`);
    }
  }
  return failures;
}

/** Returns a list of human readable failures; empty means the observed response satisfies the expectation. */
export function evaluateExpect(expect: StepExpect, observed: ObservedResponse, ctx: EvaluationContext): string[] {
  const failures: string[] = [];
  if (observed.status !== expect.status) {
    failures.push(`status: expected ${expect.status}, got ${observed.status}`);
  }
  for (const [name, expectation] of Object.entries(expect.headers ?? {})) {
    const failure = checkHeader(name, expectation, observed.headers);
    if (failure) failures.push(failure);
  }
  if (expect.bodyEquals !== undefined) {
    const failure = checkBodyEquals(expect.bodyEquals, observed.body, ctx);
    if (failure) failures.push(failure);
  }
  if (expect.bodyJson !== undefined) {
    failures.push(...checkBodyJson(expect.bodyJson, observed.body));
  }
  if (expect.bodyBytes !== undefined && observed.body.byteLength !== expect.bodyBytes) {
    failures.push(`body: expected ${expect.bodyBytes} bytes, got ${observed.body.byteLength}`);
  }
  if (expect.handlerInvocations !== undefined) {
    if (ctx.handlerInvocations === undefined) {
      failures.push('handlerInvocations: counter unavailable');
    } else if (ctx.handlerInvocations !== expect.handlerInvocations) {
      failures.push(`handlerInvocations: expected ${expect.handlerInvocations}, got ${ctx.handlerInvocations}`);
    }
  }
  return failures;
}
```

`packages/conformance/src/index.ts`:

```ts
export { evaluateExpect } from './expect';
export type * from './types';
```

- [ ] **Step 5: Run tests, lint and typecheck, expect pass**

Run: `bun test packages/conformance/test/expect.test.ts`, then `bun run lint`, then `bun run --filter @anyonce/conformance typecheck`
Expected: 8 tests pass, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/conformance/src packages/conformance/test/expect.test.ts
git commit -m "feat(conformance): REQ-CONF-1 vector types and expectation evaluator"
```

---

### Task 5: Runner execution (targets, loading, concurrency, reset, capabilities)

**Files:**
- Create: `packages/conformance/src/target.ts`, `packages/conformance/src/load.ts`, `packages/conformance/src/run.ts`
- Modify: `packages/conformance/src/index.ts`
- Test: `packages/conformance/test/run.test.ts`

**Interfaces:**
- Consumes: `evaluateExpect`, all types from Task 4.
- Produces:
  - `type FetchHandler = (request: Request) => Response | Promise<Response>`
  - `type Target = FetchHandler | { baseUrl: string }`
  - `toSender(target: Target): (req: StepRequest) => Promise<ObservedResponse>`
  - `loadVectors(dir?: string): Vector[]` (default dir is the repo's `conformance/vectors`)
  - `runVectors(target: Target, vectors: Vector[], options?: RunOptions): Promise<RunSummary>`
  - `interface RunOptions { tiers?: Tier[]; capabilities?: Capability[]; only?: string[]; resetPath?: string; counterPath?: string }`
  - Step ordering rule: a step referenced by any later step's `concurrentWith` is sent and left pending. A step with `concurrentWith` waits `delayMs`, is sent while those are pending, and then the whole group is awaited and evaluated together with one counter read. Any other step first awaits all pending steps, then waits `delayMs`, sends, awaits, evaluates.

- [ ] **Step 1: Write the failing runner test**

`packages/conformance/test/run.test.ts`:

```ts
import { afterAll, describe, expect, test } from 'bun:test';
import { runVectors } from '../src/run';
import type { Vector } from '../src/types';

/** A bare fixture with no idempotency: every POST executes. Records when /slow handlers start and end. */
function bareFixture() {
  let count = 0;
  const slowWindows: Array<{ start: number; end: number }> = [];
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/reset') {
      count = 0;
      return new Response(null, { status: 204 });
    }
    if (req.method === 'GET' && url.pathname === '/counter') {
      return Response.json({ count });
    }
    if (req.method === 'POST' && url.pathname === '/echo') {
      count += 1;
      return new Response(await req.text(), { status: 201, headers: { 'Content-Type': 'text/plain' } });
    }
    if (req.method === 'POST' && url.pathname === '/slow') {
      count += 1;
      const ms = Number(url.searchParams.get('ms') ?? '0');
      const start = Date.now();
      await new Promise((r) => setTimeout(r, ms));
      slowWindows.push({ start, end: Date.now() });
      return new Response(`slept:${ms}`, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return { handler, slowWindows, count: () => count };
}

const echoTwice: Vector = {
  id: 'core/retry-replays',
  tier: 'core',
  title: 't',
  draftRef: 'section-2.6',
  description: 'd',
  fixture: 'echo',
  steps: [
    { id: 'first', request: { method: 'POST', path: '/echo', headers: { 'Idempotency-Key': 'k' }, body: 'a' }, expect: { status: 201, bodyEquals: 'a', handlerInvocations: 1 } },
    { id: 'retry', request: { method: 'POST', path: '/echo', headers: { 'Idempotency-Key': 'k' }, body: 'a' }, expect: { status: 201, bodyEquals: { sameAs: 'first' }, handlerInvocations: 1 } },
  ],
};

const concurrent: Vector = {
  id: 'core/concurrent-409',
  tier: 'core',
  title: 't',
  draftRef: 'section-2.6',
  description: 'd',
  fixture: 'slow',
  steps: [
    { id: 'original', request: { method: 'POST', path: '/slow?ms=400', headers: { 'Idempotency-Key': 'k' }, body: 's' }, expect: { status: 200 } },
    { id: 'duplicate', concurrentWith: ['original'], delayMs: 100, request: { method: 'POST', path: '/slow?ms=400', headers: { 'Idempotency-Key': 'k' }, body: 's' }, expect: { status: 409, handlerInvocations: 1 } },
  ],
};

const needsTtl: Vector = { ...echoTwice, id: 'core/expiry-executes-again', requires: ['short-ttl'] };
const profileOnly: Vector = { ...echoTwice, id: 'profile/replayed-header', tier: 'profile', steps: [echoTwice.steps[0] as Vector['steps'][number]] };

describe('runVectors', () => {
  test('REQ-CONF-1: a bare target fails the replay step with the counter failure and passes the first step', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [echoTwice]);
    expect(summary.failed).toBe(1);
    const result = summary.results[0];
    expect(result?.status).toBe('fail');
    expect(result?.steps[0]?.failures).toEqual([]);
    expect(result?.steps[1]?.failures).toEqual(['handlerInvocations: expected 1, got 2']);
  });

  test('REQ-CONF-1: concurrentWith sends the duplicate while the original is still in flight', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [concurrent]);
    expect(fx.slowWindows).toHaveLength(2);
    const [a, b] = fx.slowWindows as [{ start: number; end: number }, { start: number; end: number }];
    const first = a.start < b.start ? a : b;
    const second = a.start < b.start ? b : a;
    expect(second.start).toBeGreaterThanOrEqual(first.start + 90);
    expect(second.start).toBeLessThan(first.end);
    expect(summary.results[0]?.steps[1]?.failures).toEqual(['status: expected 409, got 200', 'handlerInvocations: expected 1, got 2']);
  });

  test('REQ-CONF-1: the counter is reset before every vector', async () => {
    const fx = bareFixture();
    const single: Vector = { ...echoTwice, id: 'core/post-executes-once', steps: [echoTwice.steps[0] as Vector['steps'][number]] };
    const summary = await runVectors(fx.handler, [single, single]);
    expect(summary.passed).toBe(2);
  });

  test('REQ-CONF-1: vectors whose requirements are not declared are not-applicable', async () => {
    const fx = bareFixture();
    const without = await runVectors(fx.handler, [needsTtl]);
    expect(without.results[0]?.status).toBe('not-applicable');
    expect(without.notApplicable).toBe(1);
    const withCap = await runVectors(fx.handler, [needsTtl], { capabilities: ['short-ttl'] });
    expect(withCap.results[0]?.status).toBe('fail');
  });

  test('REQ-CONF-1: tiers and only filter the vectors that run', async () => {
    const fx = bareFixture();
    const summary = await runVectors(fx.handler, [echoTwice, profileOnly], { tiers: ['profile'] });
    expect(summary.results.map((r) => r.id)).toEqual(['profile/replayed-header']);
    const only = await runVectors(fx.handler, [echoTwice, profileOnly], { only: ['core/retry-replays'] });
    expect(only.results.map((r) => r.id)).toEqual(['core/retry-replays']);
  });

  test('REQ-CONF-1: a target that cannot be reset yields an error result', async () => {
    const summary = await runVectors(async () => new Response('nope', { status: 500 }), [echoTwice]);
    expect(summary.results[0]?.status).toBe('error');
    expect(summary.errored).toBe(1);
  });
});

describe('URL target', () => {
  const fx = bareFixture();
  const server = Bun.serve({ port: 0, fetch: fx.handler });
  afterAll(() => server.stop(true));

  test('REQ-CONF-1: baseUrl targets are driven over real HTTP', async () => {
    const summary = await runVectors({ baseUrl: `http://127.0.0.1:${server.port}` }, [echoTwice]);
    expect(summary.results[0]?.steps[0]?.failures).toEqual([]);
    expect(summary.results[0]?.steps[1]?.failures).toEqual(['handlerInvocations: expected 1, got 2']);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/conformance/test/run.test.ts`
Expected: FAIL, cannot resolve `../src/run`.

- [ ] **Step 3: Implement target, load and run**

`packages/conformance/src/target.ts`:

```ts
import type { ObservedResponse, StepRequest } from './types';

export type FetchHandler = (request: Request) => Response | Promise<Response>;
export type Target = FetchHandler | { baseUrl: string };
export type Sender = (req: StepRequest) => Promise<ObservedResponse>;

const IN_PROCESS_ORIGIN = 'http://conformance.invalid';

function buildInit(req: StepRequest): RequestInit {
  const init: RequestInit = { method: req.method, headers: req.headers ?? {} };
  if (req.body !== undefined) init.body = req.body;
  return init;
}

async function observe(response: Response): Promise<ObservedResponse> {
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

/** Wraps a target as a function that sends one step request and reads the whole response. */
export function toSender(target: Target): Sender {
  if (typeof target === 'function') {
    return async (req) => observe(await target(new Request(IN_PROCESS_ORIGIN + req.path, buildInit(req))));
  }
  const base = target.baseUrl.replace(/\/$/, '');
  return async (req) => observe(await fetch(base + req.path, buildInit(req)));
}
```

`packages/conformance/src/load.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Vector } from './types';

const DEFAULT_DIR = fileURLToPath(new URL('../../../conformance/vectors', import.meta.url));

/** Loads every vector file under dir/core and dir/profile, sorted by id. Validation is the schema test's job. */
export function loadVectors(dir: string = DEFAULT_DIR): Vector[] {
  const vectors: Vector[] = [];
  for (const tier of ['core', 'profile']) {
    const tierDir = join(dir, tier);
    let names: string[];
    try {
      names = readdirSync(tierDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      vectors.push(JSON.parse(readFileSync(join(tierDir, name), 'utf8')) as Vector);
    }
  }
  return vectors.sort((a, b) => a.id.localeCompare(b.id));
}
```

`packages/conformance/src/run.ts`:

```ts
import { evaluateExpect } from './expect';
import { type Sender, type Target, toSender } from './target';
import type { Capability, ObservedResponse, RunSummary, Step, StepOutcome, Tier, Vector, VectorResult } from './types';

export interface RunOptions {
  tiers?: Tier[];
  capabilities?: Capability[];
  only?: string[];
  resetPath?: string;
  counterPath?: string;
}

const decoder = new TextDecoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCounter(send: Sender, counterPath: string): Promise<number | undefined> {
  const res = await send({ method: 'GET', path: counterPath });
  if (res.status !== 200) return undefined;
  try {
    const parsed = JSON.parse(decoder.decode(res.body)) as { count?: unknown };
    return typeof parsed.count === 'number' ? parsed.count : undefined;
  } catch {
    return undefined;
  }
}

function deferredIds(steps: Step[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const ref of step.concurrentWith ?? []) ids.add(ref);
  }
  return ids;
}

/** Runs one vector against a sender. Assumes requirements were already checked by the caller. */
export async function runVector(send: Sender, vector: Vector, options: RunOptions = {}): Promise<VectorResult> {
  const resetPath = options.resetPath ?? '/reset';
  const counterPath = options.counterPath ?? '/counter';
  const outcomes: StepOutcome[] = [];
  const priorBodies = new Map<string, Uint8Array>();
  const pending = new Map<string, { step: Step; promise: Promise<ObservedResponse> }>();
  const deferred = deferredIds(vector.steps);

  const evaluateGroup = async (group: Array<{ step: Step; response: ObservedResponse }>): Promise<void> => {
    const needsCounter = group.some((g) => g.step.expect.handlerInvocations !== undefined);
    const handlerInvocations = needsCounter ? await readCounter(send, counterPath) : undefined;
    for (const { step, response } of group) {
      const ctx = handlerInvocations === undefined ? { priorBodies } : { priorBodies, handlerInvocations };
      outcomes.push({ stepId: step.id, failures: evaluateExpect(step.expect, response, ctx) });
      priorBodies.set(step.id, response.body);
    }
  };

  const settlePending = async (): Promise<void> => {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    const responses = await Promise.all(entries.map((e) => e.promise));
    await evaluateGroup(entries.map((e, i) => ({ step: e.step, response: responses[i] as ObservedResponse })));
  };

  try {
    const reset = await send({ method: 'POST', path: resetPath });
    if (reset.status < 200 || reset.status >= 300) {
      return { id: vector.id, tier: vector.tier, status: 'error', steps: [], error: `reset returned ${reset.status}` };
    }

    for (const step of vector.steps) {
      const partners = step.concurrentWith ?? [];
      if (partners.length === 0) await settlePending();
      if (step.delayMs) await sleep(step.delayMs);
      const promise = send(step.request);
      if (deferred.has(step.id)) {
        pending.set(step.id, { step, promise });
        continue;
      }
      if (partners.length > 0) {
        const group = partners.map((id) => pending.get(id)).filter((e): e is { step: Step; promise: Promise<ObservedResponse> } => e !== undefined);
        for (const id of partners) pending.delete(id);
        const responses = await Promise.all([...group.map((g) => g.promise), promise]);
        const own = responses[responses.length - 1] as ObservedResponse;
        await evaluateGroup([...group.map((g, i) => ({ step: g.step, response: responses[i] as ObservedResponse })), { step, response: own }]);
        continue;
      }
      await evaluateGroup([{ step, response: await promise }]);
    }
    await settlePending();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: vector.id, tier: vector.tier, status: 'error', steps: outcomes, error: message };
  }

  const status = outcomes.every((o) => o.failures.length === 0) ? 'pass' : 'fail';
  return { id: vector.id, tier: vector.tier, status, steps: outcomes };
}

/** Runs the selected vectors sequentially and summarizes. */
export async function runVectors(target: Target, vectors: Vector[], options: RunOptions = {}): Promise<RunSummary> {
  const send = toSender(target);
  const capabilities = new Set<Capability>(options.capabilities ?? []);
  const tiers = options.tiers ? new Set<Tier>(options.tiers) : undefined;
  const only = options.only ? new Set(options.only) : undefined;
  const results: VectorResult[] = [];

  for (const vector of vectors) {
    if (tiers && !tiers.has(vector.tier)) continue;
    if (only && !only.has(vector.id)) continue;
    const missing = (vector.requires ?? []).filter((c) => !capabilities.has(c));
    if (missing.length > 0) {
      results.push({ id: vector.id, tier: vector.tier, status: 'not-applicable', steps: [], error: `requires ${missing.join(', ')}` });
      continue;
    }
    results.push(await runVector(send, vector, options));
  }

  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    notApplicable: results.filter((r) => r.status === 'not-applicable').length,
    errored: results.filter((r) => r.status === 'error').length,
  };
}
```

`packages/conformance/src/index.ts`:

```ts
export { evaluateExpect } from './expect';
export { loadVectors } from './load';
export { type RunOptions, runVector, runVectors } from './run';
export { type FetchHandler, type Sender, type Target, toSender } from './target';
export type * from './types';
```

- [ ] **Step 4: Run tests, lint and typecheck, expect pass**

Run: `bun test packages/conformance/test/run.test.ts`, then `bun run lint`, then `bun run --filter @anyonce/conformance typecheck`
Expected: 7 tests pass, clean. The concurrency test must pass without retries; if the second `/slow` start is not inside the first window, the ordering rule is implemented wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/conformance/src packages/conformance/test/run.test.ts
git commit -m "feat(conformance): REQ-CONF-1 runner with in-process and URL targets"
```

---

### Task 6: Hono fixture app (REQ-CONF-2)

**Files:**
- Create: `conformance/fixtures/hono/package.json`, `conformance/fixtures/hono/tsconfig.json`, `conformance/fixtures/hono/src/app.ts`, `conformance/fixtures/hono/src/server.ts`
- Test: `conformance/fixtures/hono/test/app.test.ts`

**Interfaces:**
- Produces: `createFixtureApp(state?: FixtureState): Hono` exported from `@anyonce/fixture-hono`, where `FixtureState = { count: number }`. The app has no idempotency layer; P2 mounts the middleware in front of it.

- [ ] **Step 1: Package files**

`conformance/fixtures/hono/package.json`:

```json
{
  "name": "@anyonce/fixture-hono",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/app.ts",
  "exports": { ".": "./src/app.ts" },
  "scripts": { "start": "bun run src/server.ts", "typecheck": "tsc --noEmit" },
  "dependencies": { "hono": "^4.0.0" }
}
```

`conformance/fixtures/hono/tsconfig.json`:

```json
{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }
```

Run `bun install` at the repo root so the workspace links.

- [ ] **Step 2: Write the failing fixture tests**

`conformance/fixtures/hono/test/app.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '../src/app';

function post(path: string, body = 'b', headers: Record<string, string> = {}): Request {
  return new Request(`http://fixture.invalid${path}`, { method: 'POST', body, headers });
}

describe('hono fixture', () => {
  test('REQ-CONF-2: POST /echo returns 201 with the body and content type echoed and increments the counter', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/echo', 'hello', { 'Content-Type': 'text/plain' }));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('hello');
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const counter = await app.fetch(new Request('http://fixture.invalid/counter'));
    expect(await counter.json()).toEqual({ count: 1 });
  });

  test('REQ-CONF-2: POST /status/{code} returns that status with body status:{code} and counts', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/status/404'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('status:404');
    const res500 = await app.fetch(post('/status/500'));
    expect(res500.status).toBe(500);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({ count: 2 });
  });

  test('REQ-CONF-2: POST /status with a non-status code returns 400 and does not count', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/status/abc'));
    expect(res.status).toBe(400);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({ count: 0 });
  });

  test('REQ-CONF-2: POST /slow?ms=N waits at least N ms then returns slept:N', async () => {
    const app = createFixtureApp();
    const start = Date.now();
    const res = await app.fetch(post('/slow?ms=120'));
    expect(Date.now() - start).toBeGreaterThanOrEqual(115);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('slept:120');
  });

  test('REQ-CONF-2: POST /large?bytes=N returns exactly N bytes', async () => {
    const app = createFixtureApp();
    const res = await app.fetch(post('/large?bytes=70000'));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(70000);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  test('REQ-CONF-2: POST /reset clears the counter and GET /counter reports it', async () => {
    const app = createFixtureApp();
    await app.fetch(post('/echo'));
    await app.fetch(post('/slow?ms=0'));
    await app.fetch(post('/large?bytes=1'));
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({ count: 3 });
    const reset = await app.fetch(post('/reset', ''));
    expect(reset.status).toBe(204);
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({ count: 0 });
  });

  test('REQ-CONF-2: the fixture has no idempotency layer, a repeated key executes again', async () => {
    const app = createFixtureApp();
    await app.fetch(post('/echo', 'a', { 'Idempotency-Key': 'k' }));
    const second = await app.fetch(post('/echo', 'a', { 'Idempotency-Key': 'k' }));
    expect(second.headers.get('Idempotency-Replayed')).toBeNull();
    expect(await (await app.fetch(new Request('http://fixture.invalid/counter'))).json()).toEqual({ count: 2 });
  });
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `bun test conformance/fixtures/hono`
Expected: FAIL, cannot resolve `../src/app`.

- [ ] **Step 4: Implement the app and server**

`conformance/fixtures/hono/src/app.ts`:

```ts
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface FixtureState {
  count: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reference fixture for the conformance suite (requirements REQ-CONF-2), with no idempotency layer.
 * Every POST fixture increments the shared counter; /reset is the only control endpoint.
 */
export function createFixtureApp(state: FixtureState = { count: 0 }): Hono {
  const app = new Hono();

  app.post('/reset', (c) => {
    state.count = 0;
    return c.body(null, 204);
  });

  app.get('/counter', (c) => c.json({ count: state.count }));

  app.post('/echo', async (c) => {
    state.count += 1;
    const body = await c.req.arrayBuffer();
    return c.body(body, 201, { 'Content-Type': c.req.header('content-type') ?? 'application/octet-stream' });
  });

  app.post('/status/:code', (c) => {
    const code = Number(c.req.param('code'));
    if (!Number.isInteger(code) || code < 200 || code > 599) {
      return c.text('invalid status code', 400);
    }
    state.count += 1;
    return c.text(`status:${code}`, code as ContentfulStatusCode);
  });

  app.post('/slow', async (c) => {
    state.count += 1;
    const ms = Number(c.req.query('ms') ?? '0');
    await sleep(Number.isFinite(ms) && ms > 0 ? ms : 0);
    return c.text(`slept:${ms}`, 200);
  });

  app.post('/large', (c) => {
    state.count += 1;
    const bytes = Number(c.req.query('bytes') ?? '0');
    const size = Number.isInteger(bytes) && bytes >= 0 ? bytes : 0;
    return c.body(new Uint8Array(size).fill(0x78), 200, { 'Content-Type': 'application/octet-stream' });
  });

  return app;
}
```

`conformance/fixtures/hono/src/server.ts`:

```ts
import { createFixtureApp } from './app';

const port = Number(process.env.PORT ?? '0');
const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: createFixtureApp().fetch });
console.log(`listening on http://127.0.0.1:${server.port}`);
```

- [ ] **Step 5: Run tests, lint and typecheck, expect pass**

Run: `bun test conformance/fixtures/hono`, then `bun run lint`, then `bun run --filter @anyonce/fixture-hono typecheck`
Expected: 7 tests pass, clean.

- [ ] **Step 6: Commit**

```bash
git add conformance/fixtures/hono bun.lock package.json
git commit -m "feat(conformance): REQ-CONF-2 hono fixture app without idempotency"
```

---

### Task 7: The bare Hono fixture fails exactly the expected vectors, and the conformance README

**Files:**
- Modify: `packages/conformance/package.json` (add `"devDependencies": { "@anyonce/fixture-hono": "workspace:*" }`)
- Create: `packages/conformance/test/bare-hono.test.ts`, `conformance/README.md`
- Modify: `packages/conformance/test/catalog.ts` (add `BARE_PASS_IDS`)

**Interfaces:**
- Consumes: `runVectors`, `loadVectors` (Task 5), `createFixtureApp` (Task 6), `CORE_IDS` and `PROFILE_IDS` (Tasks 2 and 3).
- Produces: `BARE_PASS_IDS` in `test/catalog.ts`, the exact set of vectors a target with no idempotency passes. Task 9 reuses it for the Go fixture.

- [ ] **Step 1: Write the failing test**

Append to `packages/conformance/test/catalog.ts`:

```ts
/** Vectors that hold even without an idempotency layer: they only assert that handlers execute. */
export const BARE_PASS_IDS = [
  'core/expiry-executes-again',
  'core/get-ignored',
  'core/post-executes-once',
  'core/two-keys-execute-twice',
  'profile/5xx-not-stored',
];
```

`packages/conformance/test/bare-hono.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { loadVectors } from '../src/load';
import { runVectors } from '../src/run';
import { BARE_PASS_IDS, CORE_IDS, PROFILE_IDS } from './catalog';

describe('bare hono fixture', () => {
  test(
    'REQ-CONF-2: with no idempotency layer the runner fails every vector except the execution-only ones',
    async () => {
      const app = createFixtureApp();
      const summary = await runVectors(app.fetch, loadVectors(), { capabilities: ['short-ttl'] });
      expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
      expect(summary.errored).toBe(0);
      expect(summary.notApplicable).toBe(0);
      const passed = summary.results.filter((r) => r.status === 'pass').map((r) => r.id).sort();
      expect(passed).toEqual(BARE_PASS_IDS);
      const failed = summary.results.filter((r) => r.status === 'fail').map((r) => r.id).sort();
      expect(failed).toEqual([...CORE_IDS, ...PROFILE_IDS].filter((id) => !BARE_PASS_IDS.includes(id)).sort());
    },
    30_000,
  );

  test('REQ-CONF-2: every failure on the bare fixture is a status or counter mismatch, never a runner error', async () => {
    const app = createFixtureApp();
    const summary = await runVectors(app.fetch, loadVectors(), { tiers: ['core'] });
    for (const result of summary.results) {
      for (const step of result.steps) {
        for (const failure of step.failures) {
          expect(failure).toMatch(/^(status|handlerInvocations|header [A-Za-z-]+|body):/);
        }
      }
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun install` then `bun test packages/conformance/test/bare-hono.test.ts`
Expected: FAIL. Read the assertion diff. If the passing set differs from `BARE_PASS_IDS`, the vector at fault has an expectation that does not depend on idempotency; fix the vector, not the list.

- [ ] **Step 3: Make it pass**

This task adds no implementation. The test passes once Tasks 2 to 6 are correct. Typical fixes discovered here: a vector `bodyEquals` that the fixture does not produce, a wrong `Content-Type` echo, the 1 MiB `large` response taking longer than the default test timeout (the test sets 30 s).

- [ ] **Step 4: Write the conformance README**

`conformance/README.md`:

```markdown
# anyonce conformance suite

Executable vectors for `draft-ietf-httpapi-idempotency-key-header-07` (`docs/reference/draft-07.txt`). Any implementation in any language can run them: mount the fixture endpoints behind your idempotency layer and point the runner at the URL.

## Tiers

- `core`: behavior the draft states (MUST and SHOULD, header syntax, 400, 409, 422, replay of a completed result, single handler execution). Third-party implementations are graded on this tier only. Every core vector cites the draft section in `draftRef`.
- `profile`: anyonce's documented choices where the draft is silent (`Idempotency-Replayed`, `Retry-After` on 409, 4xx replayed, 5xx not stored, omitted-body replay above 1 MiB, the problem `code` member, the 255-byte key limit). See `DRAFT-GAPS.md` for the proposed draft text behind each.

## Fixture contract (REQ-CONF-2)

Mount these behind your idempotency layer. All POST routes must require the `Idempotency-Key` header. Every POST fixture increments one process-global counter.

| Route | Behavior |
|---|---|
| `POST /echo` | 201, echoes the request body bytes and `Content-Type` (default `application/octet-stream`), counter +1 |
| `POST /status/{code}` | responds with `{code}` and body `status:{code}` as `text/plain`, counter +1 |
| `POST /slow?ms=N` | waits N ms, then 200 with body `slept:N`, counter +1 |
| `POST /large?bytes=N` | 200 with N bytes of `x` as `application/octet-stream`, counter +1 |
| `GET /counter` | 200 with `{"count": n}`. Behind the layer (a key on GET must be ignored) |
| `POST /reset` | 204, counter set to 0. The only control endpoint, mounted outside the layer |

Reference apps with no idempotency layer: `fixtures/hono` (`bun run --filter @anyonce/fixture-hono start`) and `go/cmd/fixture` (`go run ./cmd/fixture`). Both print the listening address.

## Vector format (REQ-CONF-1)

`schema.json` (JSON Schema 2020-12) is the contract. A vector is `{ id, tier, title, draftRef?, description, requires?, fixture, steps }`; a step is `{ id, delayMs?, concurrentWith?, request: { method, path, headers?, body? }, expect: { status, headers?, bodyEquals?, bodyJson?, bodyBytes?, handlerInvocations? } }`.

Execution rules:

- The runner sends `POST /reset` before every vector.
- Steps run in order. A step named in a later step's `concurrentWith` is sent and left pending. A step with `concurrentWith` waits `delayMs`, is sent while those are pending, and the whole group is then awaited and checked together with one `GET /counter` read.
- `handlerInvocations` compares against `GET /counter` after the step (or its group) settles.
- `bodyEquals: { sameAs }` compares bytes with an earlier step's body.

## Capabilities

`requires: ["short-ttl"]` marks a vector that needs a TTL of at most 2000 ms on the target. Pass `capabilities: ['short-ttl']` (or `--capability short-ttl` on the CLI in P2) only when your target is configured that way. Otherwise the vector is reported as `not-applicable` and does not count as a pass or a fail.

## Running

In-process (TypeScript):

```ts
import { loadVectors, runVectors } from '@anyonce/conformance';
const summary = await runVectors(app.fetch, loadVectors(), { tiers: ['core'] });
```

Against a URL: `runVectors({ baseUrl: 'http://localhost:3000' }, loadVectors())`. The CLI, report formats and the Go runner arrive in P2.

## Adding a vector

1. Create `vectors/<tier>/<name>.json`; the `id` must be `<tier>/<name>`.
2. Core vectors must cite a `draftRef`; profile vectors must not use `requires`.
3. Add the id to `CORE_IDS` or `PROFILE_IDS` in `packages/conformance/test/catalog.ts`, and to `BARE_PASS_IDS` there if it passes without an idempotency layer.
4. Run `bun run vectors:validate` and `bun test packages/conformance`.
```

- [ ] **Step 5: Run tests and lint, expect pass**

Run: `bun test packages/conformance`, then `bun run lint`
Expected: all conformance tests pass including both bare-fixture tests, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/conformance conformance/README.md bun.lock
git commit -m "test(conformance): REQ-CONF-2 bare hono fixture fails the expected vectors"
```

---

### Task 8: Go module and net/http fixture (REQ-CONF-2)

**Files:**
- Create: `go/go.mod`, `go/.golangci.yml`, `go/conformance/fixture/fixture.go`, `go/cmd/fixture/main.go`
- Test: `go/conformance/fixture/fixture_test.go`

**Interfaces:**
- Produces: package `github.com/sns45/anyonce/go/conformance/fixture` with `New() *Fixture`, `(*Fixture).Handler() http.Handler`, `(*Fixture).Count() int`, `(*Fixture).Reset()`; binary `go/cmd/fixture` with flag `-addr` (default `127.0.0.1:0`) that prints `listening on http://<host:port>` on stdout. P2 wraps `Handler()` with `httpmw`.
- Go test naming: subtests named with the REQ id, `t.Run("REQ-CONF-2: ...", ...)`, so `scripts/reqs.ts` (Task 10) can find them.

- [ ] **Step 1: Module files**

`go/go.mod`:

```
module github.com/sns45/anyonce/go

go 1.25.3
```

`go/.golangci.yml`:

```yaml
version: "2"
linters:
  default: standard
  enable:
    - misspell
formatters:
  enable:
    - gofmt
```

If `golangci-lint` is missing locally, install it first: `brew install golangci-lint` (Q6).

- [ ] **Step 2: Write the failing fixture test**

`go/conformance/fixture/fixture_test.go`:

```go
package fixture_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

func do(t *testing.T, h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func counter(t *testing.T, h http.Handler) int {
	t.Helper()
	rec := do(t, h, http.MethodGet, "/counter", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("counter status = %d", rec.Code)
	}
	var out struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("counter body: %v", err)
	}
	return out.Count
}

func TestFixture(t *testing.T) {
	t.Run("REQ-CONF-2: POST /echo returns 201 with body and content type echoed and counts", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/echo", "hello", map[string]string{"Content-Type": "text/plain"})
		if rec.Code != http.StatusCreated || rec.Body.String() != "hello" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/plain" {
			t.Fatalf("content type = %q", ct)
		}
		if n := counter(t, h); n != 1 {
			t.Fatalf("counter = %d, want 1", n)
		}
	})

	t.Run("REQ-CONF-2: POST /status/{code} returns that status with body status:{code} and counts", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/status/404", "s", nil)
		if rec.Code != 404 || rec.Body.String() != "status:404" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
		if rec500 := do(t, h, http.MethodPost, "/status/500", "s", nil); rec500.Code != 500 {
			t.Fatalf("got %d", rec500.Code)
		}
		if n := counter(t, h); n != 2 {
			t.Fatalf("counter = %d, want 2", n)
		}
	})

	t.Run("REQ-CONF-2: POST /status with a non-status code returns 400 and does not count", func(t *testing.T) {
		h := fixture.New().Handler()
		if rec := do(t, h, http.MethodPost, "/status/abc", "s", nil); rec.Code != http.StatusBadRequest {
			t.Fatalf("got %d", rec.Code)
		}
		if n := counter(t, h); n != 0 {
			t.Fatalf("counter = %d, want 0", n)
		}
	})

	t.Run("REQ-CONF-2: POST /slow?ms=N waits at least N ms then returns slept:N", func(t *testing.T) {
		h := fixture.New().Handler()
		start := time.Now()
		rec := do(t, h, http.MethodPost, "/slow?ms=120", "s", nil)
		if elapsed := time.Since(start); elapsed < 115*time.Millisecond {
			t.Fatalf("elapsed %v", elapsed)
		}
		if rec.Code != 200 || rec.Body.String() != "slept:120" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
	})

	t.Run("REQ-CONF-2: POST /large?bytes=N returns exactly N bytes", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/large?bytes=70000", "l", nil)
		body, _ := io.ReadAll(rec.Body)
		if rec.Code != 200 || len(body) != 70000 {
			t.Fatalf("got %d with %d bytes", rec.Code, len(body))
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
			t.Fatalf("content type = %q", ct)
		}
	})

	t.Run("REQ-CONF-2: POST /reset clears the counter and GET /counter reports it", func(t *testing.T) {
		h := fixture.New().Handler()
		do(t, h, http.MethodPost, "/echo", "a", nil)
		do(t, h, http.MethodPost, "/slow?ms=0", "a", nil)
		do(t, h, http.MethodPost, "/large?bytes=1", "a", nil)
		if n := counter(t, h); n != 3 {
			t.Fatalf("counter = %d, want 3", n)
		}
		if rec := do(t, h, http.MethodPost, "/reset", "", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("reset = %d", rec.Code)
		}
		if n := counter(t, h); n != 0 {
			t.Fatalf("counter = %d, want 0", n)
		}
	})

	t.Run("REQ-CONF-2: the fixture has no idempotency layer, a repeated key executes again", func(t *testing.T) {
		h := fixture.New().Handler()
		hdr := map[string]string{"Idempotency-Key": "k"}
		do(t, h, http.MethodPost, "/echo", "a", hdr)
		second := do(t, h, http.MethodPost, "/echo", "a", hdr)
		if second.Header().Get("Idempotency-Replayed") != "" {
			t.Fatal("unexpected replay header")
		}
		if n := counter(t, h); n != 2 {
			t.Fatalf("counter = %d, want 2", n)
		}
	})
}
```

- [ ] **Step 3: Run it, expect failure**

Run (from `go/`): `go test ./...`
Expected: FAIL, package `fixture` not found.

- [ ] **Step 4: Implement the fixture and the binary**

`go/conformance/fixture/fixture.go`:

```go
// Package fixture is the reference net/http fixture for the anyonce conformance suite
// (requirements REQ-CONF-2). It has no idempotency layer; httpmw wraps Handler() in P2.
package fixture

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// Fixture holds the process-global handler invocation counter.
type Fixture struct {
	count atomic.Int64
}

// New returns a fixture with a zero counter.
func New() *Fixture { return &Fixture{} }

// Count returns the number of POST fixture invocations since the last Reset.
func (f *Fixture) Count() int { return int(f.count.Load()) }

// Reset zeroes the counter.
func (f *Fixture) Reset() { f.count.Store(0) }

// Handler returns the fixture routes. Every POST fixture increments the counter;
// /reset is the only control endpoint and must stay outside any idempotency layer.
func (f *Fixture) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /reset", func(w http.ResponseWriter, _ *http.Request) {
		f.Reset()
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /counter", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"count": f.Count()})
	})

	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		ct := r.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(body)
	})

	mux.HandleFunc("POST /status/{code}", func(w http.ResponseWriter, r *http.Request) {
		code, err := strconv.Atoi(r.PathValue("code"))
		if err != nil || code < 200 || code > 599 {
			http.Error(w, "invalid status code", http.StatusBadRequest)
			return
		}
		f.count.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(code)
		_, _ = io.WriteString(w, "status:"+strconv.Itoa(code))
	})

	mux.HandleFunc("POST /slow", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
		if err != nil || ms < 0 {
			ms = 0
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "slept:"+strconv.Itoa(ms))
	})

	mux.HandleFunc("POST /large", func(w http.ResponseWriter, r *http.Request) {
		f.count.Add(1)
		n, err := strconv.Atoi(r.URL.Query().Get("bytes"))
		if err != nil || n < 0 {
			n = 0
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(n))
		_, _ = io.Copy(w, bytes.NewReader(bytes.Repeat([]byte{'x'}, n)))
	})

	return mux
}
```

`go/cmd/fixture/main.go`:

```go
// Command fixture serves the conformance fixture with no idempotency layer.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address, port 0 picks a free port")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}
	fmt.Printf("listening on http://%s\n", ln.Addr().String())

	srv := &http.Server{Handler: fixture.New().Handler()}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
```

- [ ] **Step 5: Run the Go gate, expect pass**

Run (from `go/`): `go build ./...`, then `go vet ./...`, then `go test -race ./...`, then `golangci-lint run`
Expected: build clean, vet clean, 7 subtests pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add go
git commit -m "feat(go): REQ-CONF-2 net/http fixture without idempotency"
```

---

### Task 9: The TS runner drives the Go fixture over a URL and fails the same vectors

**Files:**
- Test: `packages/conformance/test/bare-nethttp.test.ts`

**Interfaces:**
- Consumes: `BARE_PASS_IDS` (Task 7), `go/cmd/fixture` (Task 8), `runVectors` with a `baseUrl` target (Task 5).

- [ ] **Step 1: Write the test**

`packages/conformance/test/bare-nethttp.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVectors } from '../src/load';
import { runVectors } from '../src/run';
import { BARE_PASS_IDS } from './catalog';

const goDir = join(import.meta.dir, '../../../go');
const hasGo = Bun.which('go') !== null;

let proc: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl = '';

async function readAddress(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    const match = /listening on (http:\/\/[^\s]+)/.exec(buffer);
    if (match?.[1]) return match[1];
  }
  throw new Error(`fixture exited before printing its address: ${buffer}`);
}

describe.skipIf(!hasGo)('bare net/http fixture', () => {
  beforeAll(async () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'anyonce-fixture-')), 'fixture');
    const build = Bun.spawnSync(['go', 'build', '-o', bin, './cmd/fixture'], { cwd: goDir, stderr: 'pipe' });
    if (build.exitCode !== 0) throw new Error(`go build failed: ${build.stderr.toString()}`);
    proc = Bun.spawn([bin, '-addr', '127.0.0.1:0'], { stdout: 'pipe', stderr: 'inherit' });
    baseUrl = await readAddress(proc.stdout as ReadableStream<Uint8Array>);
  }, 120_000);

  afterAll(() => {
    proc?.kill();
  });

  test(
    'REQ-CONF-2: over a URL the bare net/http fixture passes only the execution-only vectors',
    async () => {
      const summary = await runVectors({ baseUrl }, loadVectors(), { capabilities: ['short-ttl'] });
      expect(summary.errored).toBe(0);
      const passed = summary.results.filter((r) => r.status === 'pass').map((r) => r.id).sort();
      expect(passed).toEqual(BARE_PASS_IDS);
    },
    30_000,
  );
});

if (!hasGo) {
  test.skip('REQ-CONF-2: skipped because go is not on PATH', () => {});
}
```

- [ ] **Step 2: Run it, expect pass**

Run: `bun test packages/conformance/test/bare-nethttp.test.ts`
Expected: 1 test passes (first run includes a Go build). If the passing set differs from the Hono run, the Go fixture deviates from the contract: fix `fixture.go`, never the list.

- [ ] **Step 3: Commit**

```bash
git add packages/conformance/test/bare-nethttp.test.ts
git commit -m "test(conformance): REQ-CONF-2 URL mode against the bare net/http fixture"
```

---

### Task 10: REQ coverage check, `bun run test:reqs` (requirements section 7 item 1)

**Files:**
- Create: `scripts/reqs.ts`
- Test: `scripts/reqs.test.ts`

**Interfaces:**
- Produces: `bun run scripts/reqs.ts --phase p0` exits 0 when every REQ id in scope of phases up to and including `p0` has at least one test name starting with it, and exits 1 listing the uncovered ids otherwise. `--all` checks every defined id. Also exits 1 when a test references an id that requirements.md does not define.
- Exported for tests: `parseDefinedIds(text): string[]`, `parsePhaseScopes(text, defined): Map<string, string[]>` (phase key `p0`..`p7`), `expandScope(spec, defined): string[]`, `collectTestIds(root): Map<string, string[]>` (id to file paths), `coverageReport(defined, scoped, found)`.
- Test name conventions recognized: TypeScript string literals that start with `REQ-<AREA>-<n>:` or `NFR-<n>:` inside `*.test.ts`; Go `t.Run("REQ-...: ...")` strings and functions named `TestREQ_<AREA>_<n>` inside `*_test.go`.

- [ ] **Step 1: Write the failing test**

`scripts/reqs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTestIds, coverageReport, expandScope, parseDefinedIds, parsePhaseScopes } from './reqs';

const sample = `
### 4.1 Core
- **REQ-CORE-1** Implement things.
- **REQ-CORE-2** Validate keys.
### 4.3 Stores
- **REQ-ST-DO-1** (TS) Durable Objects store.
- **REQ-ST-D1-1** (TS) D1 store.
### 4.7 Conformance
- **REQ-CONF-1** Vector format.
- **REQ-CONF-2** Fixtures.
- **REQ-CONF-3** core tier.
- **REQ-CONF-4** profile tier.
### 4.9 Release
- **REQ-REL-4** CI matrix.
## 5. Non-functional requirements
- **NFR-1** Overhead.
- **NFR-6** Prose.
## 6. Phases
| Phase | Deliverable | REQs |
|---|---|---|
| P0 Scaffold and vectors | Repo. | CONF-1..4, REL-4 |
| P1 Core | Engine. | CORE-1..2 |
| P3 Stores | Stores. | ST-* |
| P6 Docs | Docs. | NFR-* |
| P7 Standards and launch | S1..S3 executed. | 0.4 |
`;

describe('reqs script', () => {
  test('reqs script: parses every bold REQ and NFR definition once', () => {
    expect(parseDefinedIds(sample)).toEqual([
      'REQ-CORE-1', 'REQ-CORE-2', 'REQ-ST-DO-1', 'REQ-ST-D1-1', 'REQ-CONF-1', 'REQ-CONF-2', 'REQ-CONF-3', 'REQ-CONF-4', 'REQ-REL-4', 'NFR-1', 'NFR-6',
    ]);
  });

  test('reqs script: expands ranges, wildcards and NFR entries against the defined ids', () => {
    const defined = parseDefinedIds(sample);
    expect(expandScope('CONF-1..4, REL-4', defined)).toEqual(['REQ-CONF-1', 'REQ-CONF-2', 'REQ-CONF-3', 'REQ-CONF-4', 'REQ-REL-4']);
    expect(expandScope('ST-*', defined)).toEqual(['REQ-ST-DO-1', 'REQ-ST-D1-1']);
    expect(expandScope('NFR-*', defined)).toEqual(['NFR-1', 'NFR-6']);
    expect(expandScope('0.4', defined)).toEqual([]);
  });

  test('reqs script: maps phases from the section 6 table', () => {
    const scopes = parsePhaseScopes(sample, parseDefinedIds(sample));
    expect([...scopes.keys()]).toEqual(['p0', 'p1', 'p3', 'p6', 'p7']);
    expect(scopes.get('p1')).toEqual(['REQ-CORE-1', 'REQ-CORE-2']);
    expect(scopes.get('p7')).toEqual([]);
  });

  test('reqs script: collects ids from TypeScript and Go test names', () => {
    const root = mkdtempSync(join(tmpdir(), 'reqs-'));
    mkdirSync(join(root, 'pkg', 'test'), { recursive: true });
    mkdirSync(join(root, 'go', 'x'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'test', 'a.test.ts'), "test('REQ-CONF-1: validates', () => {});\nit(\"REQ-CONF-2: fixtures\", () => {});\ntest(`NFR-6: prose`, () => {});\n");
    writeFileSync(join(root, 'go', 'x', 'a_test.go'), 'func TestREQ_CONF_2_fixture(t *testing.T) {\n\tt.Run("REQ-REL-4: ci", func(t *testing.T) {})\n}\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'z.test.ts'), "test('REQ-CORE-1: ignored', () => {});\n");
    const found = collectTestIds(root);
    expect([...found.keys()].sort()).toEqual(['NFR-6', 'REQ-CONF-1', 'REQ-CONF-2', 'REQ-REL-4']);
    expect(found.get('REQ-CONF-2')).toHaveLength(2);
  });

  test('reqs script: reports uncovered ids in scope and unknown ids in tests', () => {
    const defined = ['REQ-CONF-1', 'REQ-CONF-2'];
    const found = new Map([
      ['REQ-CONF-1', ['a.test.ts']],
      ['REQ-NOPE-9', ['b.test.ts']],
    ]);
    const report = coverageReport(defined, ['REQ-CONF-1', 'REQ-CONF-2'], found);
    expect(report.uncovered).toEqual(['REQ-CONF-2']);
    expect(report.unknown).toEqual(['REQ-NOPE-9']);
    expect(report.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test scripts/reqs.test.ts`
Expected: FAIL, cannot resolve `./reqs`.

- [ ] **Step 3: Implement the script**

`scripts/reqs.ts`:

```ts
#!/usr/bin/env bun
/**
 * REQ coverage check (requirements.md section 7 item 1).
 * Every REQ and NFR id in scope must have at least one test whose name starts with the id.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ID_PATTERN = /\b((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+))\b/;
const DEFINITION = /\*\*((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+))\*\*/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', '.wrangler', 'coverage']);

export function parseDefinedIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    const id = match[1] as string;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Expands one cell of the section 6 REQs column, for example "CONF-1..4, REL-4" or "ST-*" or "NFR-*". */
export function expandScope(spec: string, defined: string[]): string[] {
  const out: string[] = [];
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const prefix = token.startsWith('NFR-') ? '' : 'REQ-';
    const wildcard = /^([A-Z0-9-]+)-\*$/.exec(token);
    if (wildcard) {
      const area = `${prefix}${wildcard[1]}-`;
      for (const id of defined) if (id.startsWith(area)) out.push(id);
      continue;
    }
    const range = /^([A-Z0-9-]+)-(\d+)\.\.(\d+)$/.exec(token);
    if (range) {
      for (let n = Number(range[2]); n <= Number(range[3]); n++) {
        const id = `${prefix}${range[1]}-${n}`;
        if (defined.includes(id)) out.push(id);
      }
      continue;
    }
    const single = /^([A-Z0-9-]+)-(\d+)$/.exec(token);
    if (single) {
      const id = `${prefix}${single[1]}-${single[2]}`;
      if (defined.includes(id)) out.push(id);
    }
  }
  return out;
}

export function parsePhaseScopes(text: string, defined: string[]): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const row = /^\|\s*(P\d)\b[^|]*\|[^|]*\|([^|]*)\|/.exec(line);
    if (!row) continue;
    scopes.set((row[1] as string).toLowerCase(), expandScope(row[2] as string, defined));
  }
  return scopes;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.test.ts') || name.endsWith('_test.go')) out.push(full);
  }
}

function idsInTsSource(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/['"`]((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+)):/g)) out.push(match[1] as string);
  return out;
}

function idsInGoSource(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/"((?:REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)|(?:NFR-\d+)):/g)) out.push(match[1] as string);
  for (const match of source.matchAll(/func Test((?:REQ_[A-Z0-9]+(?:_[A-Z0-9]+)*_\d+)|(?:NFR_\d+))\b/g)) {
    out.push((match[1] as string).replace(/_/g, '-'));
  }
  return out;
}

export function collectTestIds(root: string): Map<string, string[]> {
  const files: string[] = [];
  walk(root, files);
  const found = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ids = file.endsWith('.go') ? idsInGoSource(source) : idsInTsSource(source);
    for (const id of ids) {
      const list = found.get(id) ?? [];
      list.push(relative(root, file));
      found.set(id, list);
    }
  }
  return found;
}

export interface CoverageReport {
  ok: boolean;
  uncovered: string[];
  unknown: string[];
  covered: Array<{ id: string; tests: number }>;
}

export function coverageReport(defined: string[], scoped: string[], found: Map<string, string[]>): CoverageReport {
  const uncovered = scoped.filter((id) => !found.has(id));
  const unknown = [...found.keys()].filter((id) => !defined.includes(id) && ID_PATTERN.test(id)).sort();
  const covered = scoped.filter((id) => found.has(id)).map((id) => ({ id, tests: (found.get(id) ?? []).length }));
  return { ok: uncovered.length === 0 && unknown.length === 0, uncovered, unknown, covered };
}

function main(argv: string[]): number {
  const root = join(import.meta.dir, '..');
  const text = readFileSync(join(root, 'requirements.md'), 'utf8');
  const defined = parseDefinedIds(text);
  const scopes = parsePhaseScopes(text, defined);
  const phaseArg = argv.indexOf('--phase');
  let scoped: string[];
  if (argv.includes('--all')) {
    scoped = defined;
  } else if (phaseArg >= 0) {
    const upTo = (argv[phaseArg + 1] ?? '').toLowerCase();
    scoped = [];
    for (const [phase, ids] of scopes) {
      scoped.push(...ids);
      if (phase === upTo) break;
    }
  } else {
    console.error('usage: bun run scripts/reqs.ts --phase p0 | --all');
    return 2;
  }
  const report = coverageReport(defined, scoped, collectTestIds(root));
  for (const row of report.covered) console.log(`${row.id.padEnd(18)} ${row.tests} test(s)`);
  if (report.uncovered.length > 0) console.error(`\nUNCOVERED: ${report.uncovered.join(', ')}`);
  if (report.unknown.length > 0) console.error(`\nUNKNOWN ids referenced by tests: ${report.unknown.join(', ')}`);
  console.log(`\n${report.covered.length}/${scoped.length} in-scope ids covered`);
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Run tests and the script, expect pass**

Run: `bun test scripts/reqs.test.ts`, then `bun run test:reqs`, then `bun run lint`
Expected: 5 tests pass; the script prints REQ-CONF-1..4 with test counts and reports `REQ-REL-4` as UNCOVERED and exits 1 (Task 11 covers it). Lint clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/reqs.ts scripts/reqs.test.ts
git commit -m "chore(scripts): REQ coverage check for bun run test:reqs"
```

---

### Task 11: Service containers, connectivity check, CI workflow (REQ-REL-4)

**Files:**
- Create: `test/compose.yml`, `scripts/services-check.ts`, `scripts/no-skips.sh`, `.github/workflows/ci.yml`
- Test: `test/compose.test.ts`, `test/ci.test.ts`
- Modify: `package.json` (`"test": "bun test packages conformance scripts test/compose.test.ts test/ci.test.ts"`)

**Interfaces:**
- Produces: `SERVICES` exported from `scripts/services-check.ts` as `Array<{ name; host; port }>`; `checkServices(): Promise<Array<{ name; up: boolean }>>`. P3 and P4 tests import `SERVICES` for their skip messages.

- [ ] **Step 1: Write the failing tests**

`test/compose.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SERVICES, checkServices } from '../scripts/services-check';

const compose = parse(readFileSync(join(import.meta.dir, 'compose.yml'), 'utf8')) as { services: Record<string, { image: string; ports: string[] }> };
const status = await checkServices();
const allUp = status.every((s) => s.up);

describe('service containers', () => {
  test('REQ-REL-4: compose declares DynamoDB Local, Redis 7, Postgres 16, Redpanda and ElasticMQ with pinned images', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['dynamodb', 'elasticmq', 'postgres', 'redis', 'redpanda']);
    for (const svc of Object.values(compose.services)) {
      expect(svc.image).toMatch(/:[^:]+$/);
      expect(svc.image).not.toMatch(/:latest$/);
    }
    expect(compose.services.redis?.image).toMatch(/^redis:7/);
    expect(compose.services.postgres?.image).toMatch(/^postgres:16/);
    expect(SERVICES.map((s) => s.name).sort()).toEqual(Object.keys(compose.services).sort());
  });

  test.skipIf(!allUp)('REQ-REL-4: every compose service accepts a TCP connection', () => {
    expect(status.filter((s) => !s.up)).toEqual([]);
  });

  if (!allUp) {
    test.skip(`REQ-REL-4: services down (${status.filter((s) => !s.up).map((s) => s.name).join(', ')}); run docker compose -f test/compose.yml up -d --wait`, () => {});
  }
});
```

`test/ci.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

type Job = { steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>; strategy?: { matrix?: Record<string, unknown[]> } };
const ci = parse(readFileSync(join(import.meta.dir, '../.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };
const runs = (job: Job) => job.steps.map((s) => s.run ?? '').join('\n');
const uses = (job: Job) => job.steps.map((s) => s.uses ?? '');

describe('ci workflow', () => {
  test('REQ-REL-4: declares the ts, vectors-validate, workers, go, services and node-compat jobs', () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(['go', 'node-compat', 'services', 'ts', 'vectors-validate', 'workers']);
  });

  test('REQ-REL-4: the services job starts the compose stack and proves connectivity', () => {
    const job = ci.jobs.services as Job;
    expect(runs(job)).toContain('docker compose -f test/compose.yml up -d --wait');
    expect(runs(job)).toContain('bun run services:check');
    expect(runs(job)).toContain('scripts/no-skips.sh');
  });

  test('REQ-REL-4: node-compat runs the built output on Node 22 and go uses the go.mod toolchain', () => {
    const node = ci.jobs['node-compat'] as Job;
    expect(uses(node).some((u) => u.startsWith('actions/setup-node@'))).toBe(true);
    expect(JSON.stringify(node.steps)).toContain('"node-version":22');
    const go = ci.jobs.go as Job;
    expect(JSON.stringify(go.steps)).toContain('go-version-file');
    expect(runs(go)).toContain('go test -race ./...');
    expect(uses(go).some((u) => u.startsWith('golangci/golangci-lint-action@'))).toBe(true);
  });

  test('REQ-REL-4: every bun test job fails on skipped tests', () => {
    for (const name of ['ts', 'services']) {
      expect(runs(ci.jobs[name] as Job)).toContain('scripts/no-skips.sh');
    }
  });
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `bun test test/compose.test.ts test/ci.test.ts`
Expected: FAIL, cannot resolve `../scripts/services-check` and `ENOENT` on `ci.yml`.

- [ ] **Step 3: Write compose, the check script, the no-skips gate and the workflow**

`test/compose.yml` (verify each tag exists with `docker compose -f test/compose.yml pull`; if a tag has been removed, use the newest patch of the same minor and say so in the commit body):

```yaml
services:
  dynamodb:
    image: amazon/dynamodb-local:2.6.1
    command: ["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"]
    ports: ["8000:8000"]
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8000 || exit 1"]
      interval: 2s
      timeout: 2s
      retries: 30
  redis:
    image: redis:7.4-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 30
  postgres:
    image: postgres:16.9-alpine
    environment:
      POSTGRES_USER: anyonce
      POSTGRES_PASSWORD: anyonce
      POSTGRES_DB: anyonce
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U anyonce"]
      interval: 2s
      timeout: 2s
      retries: 30
  redpanda:
    image: redpandadata/redpanda:v24.3.11
    command:
      - redpanda
      - start
      - --mode=dev-container
      - --smp=1
      - --memory=512M
      - --overprovisioned
      - --kafka-addr=PLAINTEXT://0.0.0.0:9092
      - --advertise-kafka-addr=PLAINTEXT://127.0.0.1:9092
    ports: ["9092:9092"]
    healthcheck:
      test: ["CMD-SHELL", "rpk cluster health | grep -q 'Healthy:.*true'"]
      interval: 3s
      timeout: 3s
      retries: 40
  elasticmq:
    image: softwaremill/elasticmq-native:1.6.12
    ports: ["9324:9324", "9325:9325"]
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:9325 >/dev/null || exit 1"]
      interval: 2s
      timeout: 2s
      retries: 30
```

If the DynamoDB Local image lacks `curl`, drop its healthcheck block; `--wait` then only waits for the container to start and `services:check` proves the port.

`scripts/services-check.ts`:

```ts
#!/usr/bin/env bun
/** TCP connectivity check for the compose services in test/compose.yml. */
import { connect } from 'node:net';

export interface Service {
  name: string;
  host: string;
  port: number;
}

export const SERVICES: Service[] = [
  { name: 'dynamodb', host: '127.0.0.1', port: 8000 },
  { name: 'redis', host: '127.0.0.1', port: 6379 },
  { name: 'postgres', host: '127.0.0.1', port: 5432 },
  { name: 'redpanda', host: '127.0.0.1', port: 9092 },
  { name: 'elasticmq', host: '127.0.0.1', port: 9324 },
];

export function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
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

export async function checkServices(services: Service[] = SERVICES): Promise<Array<{ name: string; up: boolean }>> {
  return Promise.all(services.map(async (s) => ({ name: s.name, up: await tcpOpen(s.host, s.port) })));
}

if (import.meta.main) {
  const status = await checkServices();
  for (const s of status) console.log(`${s.name.padEnd(10)} ${s.up ? 'up' : 'DOWN'}`);
  process.exit(status.every((s) => s.up) ? 0 : 1);
}
```

`scripts/no-skips.sh` (make it executable with `chmod +x`):

```bash
#!/usr/bin/env bash
# Fails when a bun test log reports skipped tests. Usage: bun test 2>&1 | tee test.log; scripts/no-skips.sh test.log
set -euo pipefail
log="${1:?usage: no-skips.sh <bun-test-log>}"
if grep -Eq '^\s*[1-9][0-9]* skip' "$log"; then
  echo "skipped tests are failures in CI:" >&2
  grep -E '^\s*[1-9][0-9]* skip|skip\)' "$log" >&2 || true
  exit 1
fi
echo "no skipped tests"
```

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-go@v5
        with:
          go-version-file: go/go.mod
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run build
      - run: bun run test 2>&1 | tee test.log
      - run: scripts/no-skips.sh test.log
      - run: bun run test:reqs

  vectors-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run vectors:validate

  workers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run test:workers

  go:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: go
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go/go.mod
      - run: go build ./...
      - run: go vet ./...
      - run: go test -race ./...
      - uses: golangci/golangci-lint-action@v7
        with:
          working-directory: go

  services:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: docker compose -f test/compose.yml up -d --wait
      - run: bun run services:check
      - run: bun test test/compose.test.ts 2>&1 | tee services.log
      - run: scripts/no-skips.sh services.log
      - if: always()
        run: docker compose -f test/compose.yml down -v

  node-compat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: node --input-type=module -e "const m = await import('./packages/conformance/dist/index.js'); if (typeof m.runVectors !== 'function') process.exit(1);"
      - run: node -e "const m = require('./packages/conformance/dist/index.cjs'); if (typeof m.runVectors !== 'function') process.exit(1);"
```

- [ ] **Step 4: Run the tests with the stack up, expect pass**

Run: `docker compose -f test/compose.yml pull`, then `docker compose -f test/compose.yml up -d --wait`, then `bun run services:check`, then `bun test test/compose.test.ts test/ci.test.ts`, then `bun run test:reqs`, then `bun run lint`
Expected: five services `up`; 6 tests pass with 0 skipped; `test:reqs` now exits 0 with REQ-CONF-1..4 and REQ-REL-4 covered; lint clean. Then `docker compose -f test/compose.yml down -v`.

- [ ] **Step 5: Commit**

```bash
git add test/compose.yml test/compose.test.ts test/ci.test.ts scripts/services-check.ts scripts/no-skips.sh .github/workflows/ci.yml package.json
git commit -m "chore(ci): REQ-REL-4 service containers, connectivity check and workflow skeleton"
```

---

### Task 12: workerd smoke through vitest-pool-workers (design note C3)

**Files:**
- Create: `test/workers/vitest.config.ts`, `test/workers/wrangler.jsonc`, `test/workers/tsconfig.json`
- Test: `test/workers/smoke.test.ts`

**Interfaces:**
- Produces: `bun run test:workers` runs vitest inside workerd. P3's Durable Objects and D1 suites reuse `test/workers/vitest.config.ts` as their base config.

- [ ] **Step 1: Install and write the failing test**

```bash
bun add -d vitest @cloudflare/vitest-pool-workers wrangler
```

`test/workers/smoke.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

describe('workerd', () => {
  test('REQ-REL-4: tests execute inside workerd with Web Crypto available', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('')));
    expect(digest[0]).toBe(0xe3);
    expect(digest[31]).toBe(0x55);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun run test:workers`
Expected: FAIL, no config file at `test/workers/vitest.config.ts`.

- [ ] **Step 3: Write the config**

`test/workers/wrangler.jsonc`:

```jsonc
{
  "name": "anyonce-workers-tests",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": ["nodejs_compat"]
}
```

`test/workers/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './test/workers/wrangler.jsonc' },
      },
    },
  },
});
```

`test/workers/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"] },
  "include": ["."]
}
```

If `@cloudflare/workers-types` is not pulled in transitively, add it: `bun add -d @cloudflare/workers-types`.

- [ ] **Step 4: Run it, expect pass**

Run: `bun run test:workers`, then `bun run lint`
Expected: 1 test passes inside workerd (the vitest banner shows the workers pool), lint clean. Add `.wrangler/` to `.gitignore` if the run created it (already listed).

- [ ] **Step 5: Commit**

```bash
git add test/workers package.json bun.lock
git commit -m "chore(test): REQ-REL-4 workerd smoke via vitest-pool-workers"
```

---

### Task 13: Build, Node compatibility smoke, licence, changeset

**Files:**
- Create: `LICENSE`, `.changeset/p0-conformance.md`
- Verify: `packages/conformance/dist/` output

**Interfaces:**
- Produces: `bun run build` emits `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` for `@anyonce/conformance`, loadable from Node 22 in both module systems (REQ-REL-4 Node compat, NFR-3).

- [ ] **Step 1: Build and run the Node smoke locally**

Run: `bun run build`
Expected: tsup writes ESM, CJS and d.ts under `packages/conformance/dist`.

Run (Node 22 must be on PATH, `node --version` prints `v22.`):

```bash
node --input-type=module -e "const m = await import('./packages/conformance/dist/index.js'); if (typeof m.runVectors !== 'function') process.exit(1); console.log('esm ok');"
node -e "const m = require('./packages/conformance/dist/index.cjs'); if (typeof m.runVectors !== 'function') process.exit(1); console.log('cjs ok');"
```

Expected: `esm ok` and `cjs ok`. If the CJS build fails on `import.meta.url` in `load.ts`, tsup shims it; keep the `--shims` flag on the build script: `tsup src/index.ts --format esm,cjs --dts --clean --shims`.

- [ ] **Step 2: Licence and changeset**

`LICENSE`: the Apache License 2.0 text, verbatim (`curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`; the same text is in `/tmp/anyq/LICENSE` from preflight).

`.changeset/p0-conformance.md`:

```markdown
---
"@anyonce/conformance": minor
---

Initial conformance runner: vector schema, 11 core and 7 profile vectors, in-process and URL targets, reference fixtures.
```

- [ ] **Step 3: Full local gate, expect pass**

Run each, in order: `bun run lint`, `bun run build`, `bun run test 2>&1 | tee /tmp/anyonce-test.log`, `scripts/no-skips.sh /tmp/anyonce-test.log`, `bun run test:reqs`, `bun run test:workers`, `bun run vectors:validate`
Expected: all green, no skips, `test:reqs` exits 0.

- [ ] **Step 4: Commit**

```bash
git add LICENSE .changeset/p0-conformance.md packages/conformance/package.json
git commit -m "chore: licence, conformance changeset and build shims"
```

---

## Phase gate (CHECKLIST.md, P0 section)

Run after Task 13 with `verification-before-completion`, paste raw output into the PR:

1. `bun run lint`, `bun run build`, `bun run test 2>&1 | tee /tmp/p0.log`, `scripts/no-skips.sh /tmp/p0.log`, `bun run test:reqs`
2. From `go/`: `go vet ./...`, `go test -race ./...`, `golangci-lint run`
3. `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' .` returns nothing
4. `rg -n "console\.(log|info|warn|error)\(.*key" packages go` returns nothing
5. Changeset present: `ls .changeset/*.md`
6. `docs/superpowers/questions.md` reviewed: every entry has a recommended resolution
7. Preflight and reference docs present: `ls docs/reference/preflight.md docs/reference/draft-07.txt docs/reference/anyq-interfaces.md docs/reference/anyhook-signing.md`
8. `bun run vectors:validate`; vector count `ls conformance/vectors/core | wc -l` is 11 and `ls conformance/vectors/profile | wc -l` is 7
9. Fixture apps fail the right vectors: `bun test packages/conformance/test/bare-hono.test.ts packages/conformance/test/bare-nethttp.test.ts`
10. `docker compose -f test/compose.yml up -d --wait`, `bun run services:check`, `bun test test/compose.test.ts`, `docker compose -f test/compose.yml down -v`

PR body: REQ ids covered are REQ-CONF-1, REQ-CONF-2, REQ-CONF-3, REQ-CONF-4, REQ-REL-4. Squash merge to `main`.

