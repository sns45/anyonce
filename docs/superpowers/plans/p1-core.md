# P1 Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@anyonce/core` (types, key and sf-string parsing, JCS and SHA-256 fingerprints, `newKey`, the memory store, the exported store contract suite, and the `execute` engine) and its Go mirror (`anyonce`, `store/memory`, `storetest`), with the engine, key validator and sf-string parser at 100 percent branch coverage, the REQ-STORE-8 race proven in both languages, and the core bundle under 8 KB.

**Architecture:** One state machine (requirements 3.2 with the Q8 precedence and fence continuation) behind a `Store` interface whose `begin` is a single atomic operation. The engine (3.3) never touches transports; adapters arrive in P2. The store contract suite is a library that takes an injected test runner so the same tests run under bun, vitest and vitest-pool-workers; the memory store is its first consumer. Go mirrors the TypeScript semantics with `context.Context` threaded through every call and `time.Time` at the boundary.

**Tech Stack:** Bun 1.2 (`bun test` runner, workspaces), TypeScript 5.9 strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, tsup (ESM, CJS, d.ts), vitest 3.2.7 with `@vitest/coverage-v8` for branch coverage only, Biome 2, Web Crypto and TextEncoder only in core, Go 1.26 minimum (local toolchain 1.27.1 at `/opt/homebrew/bin/go`), standard library only, `go test -race`, golangci-lint 2.13.2.

**Spec:** `requirements.md` sections 3 (core model as amended), 4.1 (REQ-CORE-1..8), 4.2 (REQ-STORE-1..11), D3 to D7, D9, D13, D14, D21; NFR-2, NFR-3, NFR-4; `docs/superpowers/questions.md` decisions Q7 (OmittedResult), Q8 (precedence and fence continuation), Q10 (branch coverage via vitest), Q11 (core root never imports `./http`); `CHECKLIST.md` sections "Every phase" and "P1 core".

## Global Constraints

- Prose in docs, comments, commit messages, changeset text: no em or en dashes (U+2013, U+2014). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing.
- Test names start with the REQ id they prove: `REQ-CORE-2: rejects a 256 byte key`. Go subtests use `t.Run("REQ-CORE-2: ...", ...)`.
- `@anyonce/core`: zero `dependencies` in `package.json`; Web APIs only (`crypto.subtle`, `crypto.randomUUID`, `TextEncoder`, `TextDecoder`); no `node:` import anywhere under `packages/core/src`; the root entry bundle is under 8192 bytes minified plus gzip; `sideEffects: false`; ESM and CJS with an `exports` map listing `types` first (NFR-3).
- TypeScript: `strict`, `exactOptionalPropertyTypes` (never assign `undefined` to an optional property; build objects conditionally), `noUncheckedIndexedAccess`, no `any` outside test fakes, `verbatimModuleSyntax`.
- Tests in `packages/core/test` import from `bun:test`; the vitest coverage run aliases `bun:test` to `vitest` (Task 1 proves the alias). Use only matchers both runners share: `toBe`, `toEqual`, `toBeNull`, `toBeUndefined`, `toBeTruthy`, `toBeGreaterThan`, `toBeLessThan`, `toHaveLength`, `toThrow`, `toMatch`, `rejects.toThrow`, `toBeInstanceOf`.
- Store `begin` is one atomic operation (D4). In the memory store that means no `await` between reading and writing the record. Get-then-lock is a bug even if tests pass.
- State machine precedence in `begin` (3.2 as amended): TTL expiry first (an expired record is absent), then fingerprint, then lease. Fence continuation: a TTL-expired or lease-expired row that is still present yields `old.fence + 1`; a physically absent row yields fence 1.
- Concurrency tests never use sleeps to pass; the race test uses `Promise.all` with a start gate in TypeScript and a `sync.WaitGroup` plus a channel gate in Go. All time is passed explicitly as `now`; no test reads the wall clock for store semantics.
- Never log a full key; `redactKey(key)` returns the first 8 characters plus `…` (NFR-2). Nothing in core logs at all.
- Go: standard library only; no cgo; errors wrapped with `%w`; sentinel errors `ErrConflict`, `ErrMismatch`, `ErrStaleFence`, `ErrStoreUnavailable`, `ErrInvalidKey` exported from `anyonce`; `context.Context` is the first parameter of every store and engine call; `go vet`, `go test -race`, `golangci-lint run` clean. Use `/opt/homebrew/bin/go` with `-C go` (the first `go` on PATH is a cached 1.25.3; the shell also exports a stale `GOROOT`, so prefix Go commands with `GOROOT=`).
- Conventional commits: `feat(core): ...`, `test(core): REQ-STORE-8 ...`, `feat(go): ...`. Commit after every task. Git only as plain single commands from the worktree root (no `cd`, no `&&` between git commands).
- Changeset for the new public package (`.changeset/p1-core.md`, `@anyonce/core: minor`).
- In source you write, use `\x` escapes (`\x00`, `\x01`, `\x7f`) or the named escapes (`\t`, `\n`) rather than `\u` escapes for control characters, and copy embedded JSON text with doubled backslashes exactly as the plan shows: the editing tools decode a single `\uXXXX` into the real character before it reaches the file. Named escapes and `\x` are both fine; only `\uXXXX` is the hazard.

## File Structure

```
packages/core/package.json            @anyonce/core, exports "." and "./testing", zero dependencies
packages/core/tsconfig.json           extends ../../tsconfig.base.json, include src and test
packages/core/vitest.config.ts        coverage run only: bun:test aliased to vitest, v8 coverage with 100 percent branch threshold on engine.ts, key.ts, sfstring.ts
packages/core/src/types.ts            Operation, StoredResult, OmittedResult, IdempotencyRecord, BeginOutcome, BeginOptions, CompleteStatus, Store, isOmitted
packages/core/src/sfstring.ts         parseSfString (RFC 9651 sf-string)
packages/core/src/key.ts              MAX_KEY_BYTES, validateKey, parseKey (lenient and strict)
packages/core/src/jcs.ts              canonicalize (RFC 8785), JcsError
packages/core/src/fingerprint.ts      sha256Hex, httpFingerprint, jcsFingerprint
packages/core/src/keygen.ts           newKey (UUIDv4 via crypto.randomUUID), redactKey
packages/core/src/memory.ts           MemoryStore (Store plus physicallyRemove and size)
packages/core/src/engine.ts           ExecutePolicy, ExecuteResult, defaultPolicy, defaultStoreResult, resultSize, omitBody, execute
packages/core/src/index.ts            public exports (never imports ./http, which does not exist until P2)
packages/core/src/testing/index.ts    storeContractSuite (exported as @anyonce/core/testing)
packages/core/test/*.test.ts          one file per source file plus package.test.ts (REQ-CORE-7) and memory-race.test.ts
scripts/size.ts                       bun run size: minified plus gzip size of the core root entry against the 8 KB budget
scripts/go-engine-coverage.sh         asserts 100 percent statement coverage on go/anyonce/engine.go
go/anyonce/types.go                   Operation, StoredResult, Record, BeginOutcome, BeginOptions, CompleteStatus, Store
go/anyonce/errors.go                  sentinel errors
go/anyonce/sfstring.go                ParseSfString
go/anyonce/key.go                     MaxKeyBytes, ValidateKey, ParseKey, Syntax
go/anyonce/jcs.go                     Canonicalize, es6Number
go/anyonce/fingerprint.go             SHA256Hex, HTTPFingerprint, JCSFingerprint
go/anyonce/keygen.go                  NewKey, RedactKey
go/anyonce/engine.go                  Policy, Hooks, Result, DefaultPolicy, Execute
go/anyonce/*_test.go                  tests, subtests named with REQ ids
go/store/memory/memory.go             Store (in-memory), PhysicallyRemove, Len
go/store/memory/memory_test.go        storetest.Run against the memory store, REQ-STORE-8 race
go/storetest/storetest.go             Run(t, factory), Harness
```

---

### Task 1: Core package scaffold, types, coverage harness, REQ-CORE-7 package test

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/types.test.ts`, `packages/core/test/package.test.ts`
- Modify: root `package.json` (add `test:coverage` script), `bun.lock` (via `bun add -d`)

**Interfaces:**
- Produces: every type in `src/types.ts` exactly as written below; later tasks import them by these names. `bun run test:coverage` runs the core tests under vitest with v8 coverage (thresholds apply only to files that exist; until Tasks 2, 3 and 8 land the include list points at files not yet created, which vitest ignores).

- [ ] **Step 1: Package files**

`packages/core/package.json`:

```json
{
  "name": "@anyonce/core",
  "version": "0.0.0",
  "description": "Transport-agnostic idempotency engine, store contract and memory store",
  "license": "Apache-2.0",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./testing": { "types": "./dist/testing/index.d.ts", "import": "./dist/testing/index.js", "require": "./dist/testing/index.cjs" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts src/testing/index.ts --format esm,cjs --dts --clean",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "vitest.config.ts"] }
```

Install the coverage provider (bun pins vitest at 3.2.7 already; the provider must match the vitest minor):

```bash
bun add -d @vitest/coverage-v8@3.2.7
```

`packages/core/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Coverage-only harness (Q10). Tests import from bun:test; this alias runs the same files under vitest.
export default defineConfig({
  resolve: { alias: { 'bun:test': 'vitest' } },
  test: {
    // Only the files whose sources carry a branch threshold. Other core tests use Bun globals and stay on bun test.
    include: ['test/engine.test.ts', 'test/key.test.ts', 'test/sfstring.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/engine.ts', 'src/key.ts', 'src/sfstring.ts'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
      reporter: ['text'],
    },
  },
});
```

Root `package.json` scripts: add `"test:coverage": "vitest run --root packages/core --config packages/core/vitest.config.ts --coverage"`.

- [ ] **Step 2: Write the failing tests**

`packages/core/test/types.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { isOmitted } from '../src/types';
import type { BeginOutcome, IdempotencyRecord, OmittedResult, Store, StoredResult } from '../src/types';

describe('types', () => {
  test('REQ-CORE-1: isOmitted distinguishes the omitted form from a stored result', () => {
    const stored: StoredResult = { kind: 'http', status: 201, body: new Uint8Array([1]) };
    const omitted: OmittedResult = { omitted: true, kind: 'http', status: 201 };
    expect(isOmitted(stored)).toBe(false);
    expect(isOmitted(omitted)).toBe(true);
  });

  test('REQ-CORE-1: the Store interface shape compiles for a minimal fake', async () => {
    const record: IdempotencyRecord = {
      scope: 's', key: 'k', fingerprint: 'f', state: 'completed', fence: 1,
      leaseUntil: 0, createdAt: 0, expiresAt: 10, result: { kind: 'message', outcome: 'ok' },
    };
    const outcome: BeginOutcome = { outcome: 'completed', record };
    const fake: Store = {
      begin: async () => outcome,
      complete: async () => 'ok',
      abandon: async () => 'ok',
      get: async () => record,
      purge: async () => 0,
    };
    expect((await fake.begin({ scope: 's', key: 'k', fingerprint: 'f' }, { leaseMs: 1, ttlMs: 1, now: 0 })).outcome).toBe('completed');
  });
});
```

`packages/core/test/package.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

describe('package hygiene', () => {
  test('REQ-CORE-7: package.json declares no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-CORE-7: the bundled root entry imports nothing from node:', async () => {
    const result = await Bun.build({ entrypoints: [join(pkgDir, 'src/index.ts')], target: 'browser', minify: false });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toMatch(/["']node:[a-z_/]+["']/);
  });

  test('REQ-CORE-7: no source file under src imports a node: module', () => {
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
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from ["']node:/);
    }
  });
});
```

- [ ] **Step 3: Run them, expect failure**

Run: `bun install` then `bun test packages/core`
Expected: FAIL, cannot resolve `../src/types`.

- [ ] **Step 4: Write the types**

`packages/core/src/types.ts`:

```ts
/** An idempotent operation identity: scope isolates tenants and routes, key comes from the client, fingerprint hashes the payload. */
export interface Operation {
  scope: string;
  key: string;
  fingerprint: string;
}

export type RecordState = 'in_flight' | 'completed';
export type ResultKind = 'http' | 'message';

export interface StoredResult {
  kind: ResultKind;
  status?: number;
  headers?: [string, string][];
  body?: Uint8Array;
  outcome?: 'ok' | 'error';
  error?: { name: string; message: string };
}

/** The form `complete` receives when the body exceeded maxResultBytes (Q7): status and headers survive, the body does not. */
export interface OmittedResult {
  omitted: true;
  kind: ResultKind;
  status?: number;
  headers?: [string, string][];
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  state: RecordState;
  fence: number;
  leaseUntil: number;
  createdAt: number;
  expiresAt: number;
  result?: StoredResult;
  resultOmitted?: boolean;
}

export type BeginOutcome =
  | { outcome: 'acquired'; fence: number }
  | { outcome: 'in_flight'; leaseUntil: number }
  | { outcome: 'completed'; record: IdempotencyRecord }
  | { outcome: 'mismatch'; record: IdempotencyRecord };

export interface BeginOptions {
  leaseMs: number;
  ttlMs: number;
  now: number;
}

export type CompleteStatus = 'ok' | 'stale_fence' | 'not_found';

export interface Store {
  begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome>;
  complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus>;
  abandon(op: Operation, fence: number): Promise<CompleteStatus>;
  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null>;
  purge(now: number): Promise<number>;
  close?(): Promise<void>;
}

export function isOmitted(result: StoredResult | OmittedResult): result is OmittedResult {
  return 'omitted' in result && result.omitted === true;
}
```

`packages/core/src/index.ts`:

```ts
export { isOmitted } from './types';
export type * from './types';
```

- [ ] **Step 5: Run tests, the coverage harness, lint and typecheck, expect pass**

Run: `bun test packages/core` (5 pass), then `bun run test:coverage` (no matching files yet, so vitest reports no tests and exits 0 thanks to `passWithNoTests`), then `bun run lint`, then `bun run --filter @anyonce/core typecheck`.
Expected: all clean. To prove the `bun:test` alias works before Task 2 depends on it, temporarily copy `test/types.test.ts` to `test/sfstring.test.ts`, run `bun run test:coverage` (expect 2 passed under vitest), then delete the copy. If the alias does not resolve under vitest, stop and report; it is the mechanism every later coverage step depends on.

- [ ] **Step 6: Commit**

```bash
git add packages/core package.json bun.lock
git commit -m "feat(core): REQ-CORE-1 package scaffold, store types and coverage harness"
```

---

### Task 2: Structured Field string parser (REQ-CORE-3)

**Files:**
- Create: `packages/core/src/sfstring.ts`
- Test: `packages/core/test/sfstring.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Produces: `parseSfString(input: string): SfStringResult` where `SfStringResult = { ok: true; value: string } | { ok: false; reason: string }`. Accepts exactly one RFC 9651 sf-string with optional surrounding spaces; parameters (`;`), lists and bare tokens are rejected. Task 3 calls it.

- [ ] **Step 1: Write the failing test**

`packages/core/test/sfstring.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { parseSfString } from '../src/sfstring';

describe('parseSfString', () => {
  const ok: Array<[string, string]> = [
    ['"abc"', 'abc'],
    ['"hello world"', 'hello world'],
    ['"foo \\"bar\\" \\\\ baz"', 'foo "bar" \\ baz'],
    ['"a\\"b"', 'a"b'],
    ['""', ''],
    ['  "padded"  ', 'padded'],
    ['"8e03978e-40d5-43e8-bc93-6894a57f9324"', '8e03978e-40d5-43e8-bc93-6894a57f9324'],
  ];
  for (const [input, value] of ok) {
    test(`REQ-CORE-3: accepts ${JSON.stringify(input)}`, () => {
      expect(parseSfString(input)).toEqual({ ok: true, value });
    });
  }

  const bad: Array<[string, string]> = [
    ['abc', 'missing opening quote'],
    ['', 'missing opening quote'],
    ['"abc', 'unterminated'],
    ['"abc"x', 'trailing'],
    ['"abc";a=1', 'trailing'],
    ['"a\\nb"', 'invalid escape'],
    ['"a\\', 'unterminated escape'],
    ['"café"', 'non-printable or non-ASCII'],
    ['"tab\there"', 'non-printable or non-ASCII'],
    ['"del\x7f"', 'non-printable or non-ASCII'],
  ];
  for (const [input, reason] of bad) {
    test(`REQ-CORE-3: rejects ${JSON.stringify(input)}`, () => {
      const result = parseSfString(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });
  }
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/sfstring.test.ts`
Expected: FAIL, cannot resolve `../src/sfstring`.

- [ ] **Step 3: Implement the parser**

`packages/core/src/sfstring.ts`:

```ts
export type SfStringResult = { ok: true; value: string } | { ok: false; reason: string };

function fail(reason: string): SfStringResult {
  return { ok: false, reason };
}

function trimSpaces(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === 0x20) start++;
  while (end > start && input.charCodeAt(end - 1) === 0x20) end--;
  return input.slice(start, end);
}

/**
 * Parses one RFC 9651 sf-string (section 4.2.5): a DQUOTE, then printable ASCII with backslash escapes for
 * DQUOTE and backslash only, then a closing DQUOTE. Surrounding spaces are discarded. Anything after the
 * closing quote (including parameters) is rejected because the key is the whole field value.
 */
export function parseSfString(input: string): SfStringResult {
  const s = trimSpaces(input);
  if (s.length === 0 || s.charCodeAt(0) !== 0x22) return fail('not an sf-string: missing opening quote');
  let out = '';
  let i = 1;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code === 0x5c) {
      i++;
      if (i >= s.length) return fail('unterminated escape');
      const next = s.charCodeAt(i);
      if (next !== 0x22 && next !== 0x5c) return fail(`invalid escape \\${s[i]}`);
      out += s[i];
      i++;
      continue;
    }
    if (code === 0x22) {
      if (i + 1 < s.length) return fail('trailing characters after the closing quote');
      return { ok: true, value: out };
    }
    if (code < 0x20 || code > 0x7e) return fail('non-printable or non-ASCII character in sf-string');
    out += s[i];
    i++;
  }
  return fail('unterminated quote');
}
```

Add to `packages/core/src/index.ts`: `export { parseSfString } from './sfstring';` and `export type { SfStringResult } from './sfstring';`.

- [ ] **Step 4: Run tests, coverage, lint, typecheck, expect pass**

Run: `bun test packages/core/test/sfstring.test.ts` (17 pass), then `bun run test:coverage` (sfstring.ts must show 100 percent branches; if a branch is uncovered, add a table row that hits it rather than lowering the threshold), then `bun run lint`, then `bun run --filter @anyonce/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/sfstring.ts packages/core/src/index.ts packages/core/test/sfstring.test.ts
git commit -m "feat(core): REQ-CORE-3 RFC 9651 sf-string parser"
```

---

### Task 3: Key validation and parsing (REQ-CORE-2)

**Files:**
- Create: `packages/core/src/key.ts`
- Test: `packages/core/test/key.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `parseSfString` (Task 2).
- Produces: `MAX_KEY_BYTES = 255`; `validateKey(key: string, allowSpace?: boolean): KeyValidation` with `KeyValidation = { ok: true } | { ok: false; reason: string }`; `parseKey(headerValue: string, syntax: KeySyntax): ParseKeyResult` with `KeySyntax = 'lenient' | 'strict'` and `ParseKeyResult = { ok: true; key: string } | { ok: false; code: 'invalid-key'; reason: string }`. P2's HTTP adapter calls `parseKey` and maps `invalid-key` to the D11 problem code.

- [ ] **Step 1: Write the failing test**

`packages/core/test/key.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MAX_KEY_BYTES, parseKey, validateKey } from '../src/key';

describe('validateKey', () => {
  test('REQ-CORE-2: accepts printable ASCII from 1 to 255 bytes', () => {
    expect(validateKey('a')).toEqual({ ok: true });
    expect(validateKey('!~')).toEqual({ ok: true });
    expect(validateKey('a'.repeat(MAX_KEY_BYTES))).toEqual({ ok: true });
  });

  const rejected: Array<[string, string, string]> = [
    ['empty', '', 'empty'],
    ['256 bytes', 'a'.repeat(256), 'exceeds 255'],
    ['space without sf-string', 'a b', 'outside printable ASCII'],
    ['control char', 'a\x01b', 'outside printable ASCII'],
    ['tab', 'a\tb', 'outside printable ASCII'],
    ['DEL', 'a\x7fb', 'outside printable ASCII'],
    ['non-ASCII', 'café', 'outside printable ASCII'],
    ['emoji', 'k\u{1F600}', 'outside printable ASCII'],
  ];
  for (const [label, key, reason] of rejected) {
    test(`REQ-CORE-2: rejects ${label}`, () => {
      const result = validateKey(key);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(reason);
    });
  }

  test('REQ-CORE-2: allows space only when allowSpace is set', () => {
    expect(validateKey('a b', true)).toEqual({ ok: true });
    expect(validateKey(' ', true)).toEqual({ ok: true });
    expect(validateKey('a b', false).ok).toBe(false);
  });
});

describe('parseKey', () => {
  test('REQ-CORE-2: lenient accepts a bare token', () => {
    expect(parseKey('abc-123', 'lenient')).toEqual({ ok: true, key: 'abc-123' });
    expect(parseKey('  abc  ', 'lenient')).toEqual({ ok: true, key: 'abc' });
  });

  test('REQ-CORE-3: lenient strips quotes and unescapes an sf-string', () => {
    expect(parseKey('"abc"', 'lenient')).toEqual({ ok: true, key: 'abc' });
    expect(parseKey('"a\\"b"', 'lenient')).toEqual({ ok: true, key: 'a"b' });
    expect(parseKey('"with space"', 'lenient')).toEqual({ ok: true, key: 'with space' });
  });

  test('REQ-CORE-3: strict requires an sf-string', () => {
    expect(parseKey('"abc"', 'strict')).toEqual({ ok: true, key: 'abc' });
    const bare = parseKey('abc', 'strict');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.code).toBe('invalid-key');
  });

  test('REQ-CORE-3: an unterminated quote is invalid in both modes', () => {
    expect(parseKey('"abc', 'strict').ok).toBe(false);
    expect(parseKey('"abc', 'lenient').ok).toBe(false);
  });

  test('REQ-CORE-2: an empty sf-string is invalid-key', () => {
    const result = parseKey('""', 'lenient');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch('empty');
  });

  test('REQ-CORE-2: a 256 byte bare key is invalid-key', () => {
    const result = parseKey('a'.repeat(256), 'lenient');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-key');
  });

  test('REQ-CORE-2: a quoted key over 255 bytes is invalid-key', () => {
    expect(parseKey(`"${'a'.repeat(256)}"`, 'strict').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/key.test.ts`
Expected: FAIL, cannot resolve `../src/key`.

- [ ] **Step 3: Implement**

`packages/core/src/key.ts`:

```ts
import { parseSfString } from './sfstring';

export const MAX_KEY_BYTES = 255;

export type KeySyntax = 'lenient' | 'strict';
export type KeyValidation = { ok: true } | { ok: false; reason: string };
export type ParseKeyResult = { ok: true; key: string } | { ok: false; code: 'invalid-key'; reason: string };

/** REQ-CORE-2: 1 to 255 bytes of printable ASCII (0x21..0x7E); space (0x20) only when the key came from an sf-string. */
export function validateKey(key: string, allowSpace = false): KeyValidation {
  if (key.length === 0) return { ok: false, reason: 'key is empty' };
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code === 0x20 && allowSpace) continue;
    if (code < 0x21 || code > 0x7e) return { ok: false, reason: `key contains a character outside printable ASCII at index ${i}` };
  }
  if (key.length > MAX_KEY_BYTES) return { ok: false, reason: `key exceeds ${MAX_KEY_BYTES} bytes` };
  return { ok: true };
}

function invalid(reason: string): ParseKeyResult {
  return { ok: false, code: 'invalid-key', reason };
}

/**
 * D7: lenient accepts a bare token or a quoted sf-string (quotes stripped, escapes unescaped); strict accepts only an
 * sf-string. Either way the resulting key must satisfy validateKey; space is allowed only inside an sf-string.
 */
export function parseKey(headerValue: string, syntax: KeySyntax): ParseKeyResult {
  const trimmed = headerValue.trim();
  const quoted = trimmed.charCodeAt(0) === 0x22;
  if (syntax === 'strict' || quoted) {
    const parsed = parseSfString(trimmed);
    if (!parsed.ok) return invalid(parsed.reason);
    const validation = validateKey(parsed.value, true);
    if (!validation.ok) return invalid(validation.reason);
    return { ok: true, key: parsed.value };
  }
  const validation = validateKey(trimmed, false);
  if (!validation.ok) return invalid(validation.reason);
  return { ok: true, key: trimmed };
}
```

Add to `packages/core/src/index.ts`: `export { MAX_KEY_BYTES, parseKey, validateKey } from './key';` and `export type { KeySyntax, KeyValidation, ParseKeyResult } from './key';`.

- [ ] **Step 4: Run tests, coverage, lint, typecheck, expect pass**

Run: `bun test packages/core/test/key.test.ts` (17 pass), `bun run test:coverage` (key.ts and sfstring.ts at 100 percent branches), `bun run lint`, `bun run --filter @anyonce/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/key.ts packages/core/src/index.ts packages/core/test/key.test.ts
git commit -m "feat(core): REQ-CORE-2 key validation and lenient or strict parsing"
```

---

### Task 4: RFC 8785 JSON canonicalization (REQ-CORE-4)

**Files:**
- Create: `packages/core/src/jcs.ts`
- Test: `packages/core/test/jcs.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `canonicalize(value: unknown): string` (RFC 8785 JCS text) and `class JcsError extends Error` thrown for `undefined`, functions, symbols, BigInt, NaN and Infinity. Task 5's `jcsFingerprint` hashes its output; P4a's queue fingerprint (Q3) reuses it.

- [ ] **Step 1: Write the failing test**

`packages/core/test/jcs.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { JcsError, canonicalize } from '../src/jcs';

/** Decodes an IEEE 754 double from its 16 hex digit big-endian representation. */
function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i++) view.setUint8(i, Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return view.getFloat64(0);
}

describe('canonicalize', () => {
  test('REQ-CORE-4: RFC 8785 section 3.2.3 example canonicalizes byte for byte', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test('REQ-CORE-4: object keys sort by UTF-16 code units, not locale', () => {
    expect(canonicalize({ b: 1, a: 2, 'é': 3, B: 4, '10': 5, '9': 6 })).toBe('{"10":5,"9":6,"B":4,"a":2,"b":1,"é":3}');
  });

  test('REQ-CORE-4: nested structures, empty containers and strings with control characters', () => {
    expect(canonicalize({ z: [{ y: {} }, []], a: 'tab\there\x01' })).toBe('{"a":"tab\\there\\u0001","z":[{"y":{}},[]]}');
  });

  test('REQ-CORE-4: undefined properties are dropped, matching JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  const numbers: Array<[string, string]> = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['41b3de4355555555', '333333333.3333333'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['44b52d02c7e14af6', '1e+23'],
  ];
  for (const [hex, expected] of numbers) {
    test(`REQ-CORE-4: number ${hex} serializes as ${expected}`, () => {
      expect(canonicalize(fromHex(hex))).toBe(expected);
    });
  }

  test('REQ-CORE-4: non-finite numbers, undefined, bigint and functions throw JcsError', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(JcsError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(JcsError);
    expect(() => canonicalize(undefined)).toThrow(JcsError);
    expect(() => canonicalize(10n)).toThrow(JcsError);
    expect(() => canonicalize(() => 1)).toThrow(JcsError);
    expect(() => canonicalize([undefined])).toThrow(JcsError);
  });

  test('REQ-CORE-4: toJSON is honored like JSON.stringify', () => {
    expect(canonicalize({ d: new Date(0) })).toBe('{"d":"1970-01-01T00:00:00.000Z"}');
  });
});
```

The number table comes from RFC 8785 Appendix B. JavaScript is the reference implementation of that algorithm, so if an expected string disagrees with `JSON.stringify(fromHex(hex))`, the table row is mistyped: fix the row from the RFC text, never the implementation, and carry the corrected table into Task 11.

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/jcs.test.ts`
Expected: FAIL, cannot resolve `../src/jcs`.

- [ ] **Step 3: Implement**

`packages/core/src/jcs.ts`:

```ts
export class JcsError extends Error {
  override readonly name = 'JcsError';
}

function serializeObject(value: object): string {
  const maybe = value as { toJSON?: unknown };
  if (typeof maybe.toJSON === 'function') return serialize((maybe.toJSON as () => unknown).call(value));
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new JcsError('non-finite numbers cannot be canonicalized');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return serializeObject(value);
    default:
      throw new JcsError(`${typeof value} values cannot be canonicalized`);
  }
}

/**
 * RFC 8785 JSON Canonicalization Scheme. Numbers follow ECMAScript Number::toString (which JSON.stringify
 * implements), strings use the JSON.stringify escaping rules the RFC mandates, and object members are sorted by
 * UTF-16 code units (the default Array.prototype.sort order for strings).
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}
```

Add to `packages/core/src/index.ts`: `export { JcsError, canonicalize } from './jcs';`.

- [ ] **Step 4: Run tests, lint, typecheck, expect pass**

Run: `bun test packages/core/test/jcs.test.ts` (19 pass), `bun run lint`, `bun run --filter @anyonce/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/jcs.ts packages/core/src/index.ts packages/core/test/jcs.test.ts
git commit -m "feat(core): REQ-CORE-4 RFC 8785 canonicalization"
```

---

### Task 5: Fingerprint helpers, newKey and redactKey (REQ-CORE-4, REQ-CORE-5, NFR-2)

**Files:**
- Create: `packages/core/src/fingerprint.ts`, `packages/core/src/keygen.ts`
- Test: `packages/core/test/fingerprint.test.ts`, `packages/core/test/keygen.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `canonicalize` (Task 4).
- Produces: `sha256Hex(bytes: Uint8Array): Promise<string>`, `httpFingerprint(method: string, path: string, body: Uint8Array): Promise<string>` (SHA-256 over `method + "\n" + path + "\n" + body`, D9, method used as given), `jcsFingerprint(json: unknown): Promise<string>`, `newKey(): string` (UUIDv4), `redactKey(key: string): string`. P2 and P4a call these.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/fingerprint.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { httpFingerprint, jcsFingerprint, sha256Hex } from '../src/fingerprint';

const enc = new TextEncoder();

describe('fingerprints', () => {
  test('REQ-CORE-4: sha256Hex known answers', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('REQ-CORE-4: httpFingerprint hashes method, newline, path, newline, body bytes', async () => {
    const expected = await sha256Hex(enc.encode('POST\n/echo\nhello'));
    expect(await httpFingerprint('POST', '/echo', enc.encode('hello'))).toBe(expected);
    expect(await httpFingerprint('POST', '/echo', enc.encode('hellp'))).not.toBe(expected);
    expect(await httpFingerprint('PATCH', '/echo', enc.encode('hello'))).not.toBe(expected);
    expect(await httpFingerprint('POST', '/echo2', enc.encode('hello'))).not.toBe(expected);
  });

  test('REQ-CORE-4: httpFingerprint with an empty body still includes both separators', async () => {
    expect(await httpFingerprint('POST', '/x', new Uint8Array(0))).toBe(await sha256Hex(enc.encode('POST\n/x\n')));
  });

  test('REQ-CORE-4: jcsFingerprint is key order independent and equals the hash of the canonical text', async () => {
    const a = await jcsFingerprint({ b: 1, a: [2, 3] });
    const b = await jcsFingerprint({ a: [2, 3], b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(await sha256Hex(enc.encode('{"a":[2,3],"b":1}')));
  });

  test('REQ-CORE-4: jcsFingerprint rejects values JCS cannot serialize', async () => {
    await expect(jcsFingerprint({ a: 10n })).rejects.toThrow('cannot be canonicalized');
  });
});
```

`packages/core/test/keygen.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { newKey, redactKey } from '../src/keygen';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newKey', () => {
  test('REQ-CORE-5: returns a lowercase UUID version 4', () => {
    expect(newKey()).toMatch(UUID_V4);
  });

  test('REQ-CORE-5: 10000 keys are unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newKey());
    expect(seen.size).toBe(10_000);
  });
});

describe('redactKey', () => {
  test('NFR-2: keeps the first 8 characters and appends an ellipsis', () => {
    expect(redactKey('8e03978e-40d5-43e8-bc93-6894a57f9324')).toBe('8e03978e…');
    expect(redactKey('short')).toBe('short…');
  });
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `bun test packages/core/test/fingerprint.test.ts packages/core/test/keygen.test.ts`
Expected: FAIL, cannot resolve `../src/fingerprint` and `../src/keygen`.

- [ ] **Step 3: Implement**

`packages/core/src/fingerprint.ts`:

```ts
import { canonicalize } from './jcs';

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Lowercase hex SHA-256 of the given bytes via Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** D9 default HTTP fingerprint: SHA-256 over method, LF, path, LF, body bytes. The method is hashed as given. */
export async function httpFingerprint(method: string, path: string, body: Uint8Array): Promise<string> {
  const prefix = encoder.encode(`${method}\n${path}\n`);
  const joined = new Uint8Array(prefix.byteLength + body.byteLength);
  joined.set(prefix, 0);
  joined.set(body, prefix.byteLength);
  return sha256Hex(joined);
}

/** SHA-256 over the RFC 8785 canonical form of a JSON value. Rejects values JCS cannot serialize. */
export async function jcsFingerprint(json: unknown): Promise<string> {
  return sha256Hex(encoder.encode(canonicalize(json)));
}
```

`packages/core/src/keygen.ts`:

```ts
/** REQ-CORE-5: a fresh UUID version 4 from Web Crypto. */
export function newKey(): string {
  return crypto.randomUUID();
}

/** NFR-2: the only form of a key that may ever reach a log line. */
export function redactKey(key: string): string {
  return `${key.slice(0, 8)}…`;
}
```

Add to `packages/core/src/index.ts`: `export { httpFingerprint, jcsFingerprint, sha256Hex } from './fingerprint';` and `export { newKey, redactKey } from './keygen';`.

- [ ] **Step 4: Run tests, lint, typecheck, expect pass**

Run: `bun test packages/core/test/fingerprint.test.ts packages/core/test/keygen.test.ts` (8 pass), `bun run lint`, `bun run --filter @anyonce/core typecheck`. If `tsc` rejects `bytes as BufferSource`, use `bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer` instead and note it.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fingerprint.ts packages/core/src/keygen.ts packages/core/src/index.ts packages/core/test/fingerprint.test.ts packages/core/test/keygen.test.ts
git commit -m "feat(core): REQ-CORE-4 fingerprint helpers, REQ-CORE-5 newKey, redactKey"
```

---

### Task 6: Store contract suite as a library (REQ-STORE-1..11, exported as `@anyonce/core/testing`)

**Files:**
- Create: `packages/core/src/testing/index.ts`
- Test: `packages/core/test/testing-suite.test.ts` (proves the suite fails against a broken store)

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `storeContractSuite(name: string, factory: StoreFactory, runner: StoreSuiteRunner): void` with `StoreHarness = { store: Store; physicallyRemove?: (op: Pick<Operation, 'scope' | 'key'>) => Promise<void>; close?: () => Promise<void> }`, `StoreFactory = () => StoreHarness | Promise<StoreHarness>`, and `StoreSuiteRunner = { describe; test; expect }` (shapes below). Task 7 (memory), every P3 store, and third parties call it. Every test creates its own harness and closes it. All times are explicit (`T0`, `LEASE_MS`, `TTL_MS`); a lease is live while `leaseUntil > now` and a record is alive while `expiresAt > now`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/testing-suite.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { storeContractSuite } from '../src/testing/index';
import type { Store } from '../src/types';

/** A store that violates REQ-STORE-1 on purpose: begin never acquires. */
const brokenStore: Store = {
  begin: async () => ({ outcome: 'in_flight', leaseUntil: 0 }),
  complete: async () => 'not_found',
  abandon: async () => 'not_found',
  get: async () => null,
  purge: async () => 0,
};

describe('storeContractSuite harness', () => {
  test('REQ-STORE-1: the suite registers one test per contract requirement and fails a broken store', async () => {
    const registered: Array<{ name: string; fn: () => Promise<void> }> = [];
    storeContractSuite('broken', () => ({ store: brokenStore }), {
      describe: (_name, fn) => fn(),
      test: (name, fn) => {
        registered.push({ name, fn });
      },
      expect,
    });
    const ids = new Set(registered.map((t) => /^(REQ-STORE-\d+)/.exec(t.name)?.[1]));
    for (let n = 1; n <= 11; n++) expect(ids.has(`REQ-STORE-${n}`)).toBe(true);
    const first = registered.find((t) => t.name.startsWith('REQ-STORE-1:'));
    expect(first).toBeTruthy();
    let failed = false;
    try {
      await first?.fn();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/testing-suite.test.ts`
Expected: FAIL, cannot resolve `../src/testing/index`.

- [ ] **Step 3: Write the suite**

`packages/core/src/testing/index.ts`:

```ts
import type { BeginOutcome, IdempotencyRecord, Operation, Store, StoredResult } from '../types';

export interface StoreHarness {
  store: Store;
  /** Simulates a store's native TTL sweep removing the row. Stores without native TTL can omit it; purge is used instead. */
  physicallyRemove?: (op: Pick<Operation, 'scope' | 'key'>) => Promise<void>;
  close?: () => Promise<void>;
}

export type StoreFactory = () => StoreHarness | Promise<StoreHarness>;

export interface MatchersLike {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeGreaterThan(expected: number): void;
}

export interface StoreSuiteRunner {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  expect(actual: unknown): MatchersLike;
}

export const T0 = 1_700_000_000_000;
export const LEASE_MS = 30_000;
export const TTL_MS = 86_400_000;
export const MAX_RESULT_BYTES = 1_048_576;

const httpResult: StoredResult = {
  kind: 'http',
  status: 201,
  headers: [['Content-Type', 'text/plain']],
  body: new Uint8Array([1, 2, 3, 255, 0, 7]),
};

function expectAcquired(expect: StoreSuiteRunner['expect'], outcome: BeginOutcome, fence: number): void {
  expect(outcome.outcome).toBe('acquired');
  if (outcome.outcome === 'acquired') expect(outcome.fence).toBe(fence);
}

function recordOf(outcome: BeginOutcome): IdempotencyRecord | undefined {
  return outcome.outcome === 'completed' || outcome.outcome === 'mismatch' ? outcome.record : undefined;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The shared store contract (requirements 4.2). Every store in every language must pass it. The runner is
 * injected so the same file runs under bun test, vitest and vitest-pool-workers.
 */
export function storeContractSuite(name: string, factory: StoreFactory, runner: StoreSuiteRunner): void {
  const { describe, test, expect } = runner;
  const unique = crypto.randomUUID();
  const op = (tag: string, fingerprint = 'fp-a'): Operation => ({ scope: `suite:${name}:${unique}:${tag}`, key: `key-${tag}`, fingerprint });
  const opts = (now: number) => ({ leaseMs: LEASE_MS, ttlMs: TTL_MS, now });

  const withHarness = (fn: (h: StoreHarness) => Promise<void>) => async () => {
    const h = await factory();
    try {
      await fn(h);
    } finally {
      await h.close?.();
    }
  };

  describe(`store contract: ${name}`, () => {
    test('REQ-STORE-1: begin on an absent record returns acquired with fence 1', withHarness(async (h) => {
      expectAcquired(expect, await h.store.begin(op('s1'), opts(T0)), 1);
    }));

    test('REQ-STORE-2: a second begin with the same fingerprint while the lease is live returns in_flight with the same leaseUntil', withHarness(async (h) => {
      const o = op('s2');
      await h.store.begin(o, opts(T0));
      const second = await h.store.begin(o, opts(T0 + 1000));
      expect(second.outcome).toBe('in_flight');
      if (second.outcome === 'in_flight') expect(second.leaseUntil).toBe(T0 + LEASE_MS);
      const third = await h.store.begin(o, opts(T0 + LEASE_MS - 1));
      expect(third.outcome).toBe('in_flight');
    }));

    test('REQ-STORE-3: begin with a different fingerprint returns mismatch while in_flight', withHarness(async (h) => {
      const o = op('s3a');
      await h.store.begin(o, opts(T0));
      const out = await h.store.begin(op('s3a', 'fp-b'), opts(T0 + 10));
      expect(out.outcome).toBe('mismatch');
      expect(recordOf(out)?.fingerprint).toBe('fp-a');
      expect(recordOf(out)?.state).toBe('in_flight');
    }));

    test('REQ-STORE-3: begin with a different fingerprint returns mismatch when completed', withHarness(async (h) => {
      const o = op('s3b');
      await h.store.begin(o, opts(T0));
      await h.store.complete(o, 1, httpResult, T0 + 5);
      const out = await h.store.begin(op('s3b', 'fp-b'), opts(T0 + 10));
      expect(out.outcome).toBe('mismatch');
      expect(recordOf(out)?.state).toBe('completed');
    }));

    test('REQ-STORE-3: a lease-expired record with a different fingerprint still yields mismatch', withHarness(async (h) => {
      const o = op('s3c');
      await h.store.begin(o, opts(T0));
      const out = await h.store.begin(op('s3c', 'fp-b'), opts(T0 + LEASE_MS + 1));
      expect(out.outcome).toBe('mismatch');
    }));

    test('REQ-STORE-4: complete then begin returns completed with the stored result byte-exact', withHarness(async (h) => {
      const o = op('s4');
      await h.store.begin(o, opts(T0));
      expect(await h.store.complete(o, 1, httpResult, T0 + 5)).toBe('ok');
      const out = await h.store.begin(o, opts(T0 + 10));
      expect(out.outcome).toBe('completed');
      const rec = recordOf(out);
      expect(rec?.state).toBe('completed');
      expect(rec?.fence).toBe(1);
      expect(rec?.result?.kind).toBe('http');
      expect(rec?.result?.status).toBe(201);
      expect(rec?.result?.headers).toEqual([['Content-Type', 'text/plain']]);
      expect(bytesEqual(rec?.result?.body, httpResult.body as Uint8Array)).toBe(true);
      expect(rec?.resultOmitted ?? false).toBe(false);
    }));

    test('REQ-STORE-4: complete on an absent record returns not_found and completing twice with the same fence is ok', withHarness(async (h) => {
      const o = op('s4b');
      expect(await h.store.complete(o, 1, httpResult, T0)).toBe('not_found');
      await h.store.begin(o, opts(T0));
      expect(await h.store.complete(o, 1, httpResult, T0 + 1)).toBe('ok');
      expect(await h.store.complete(o, 1, httpResult, T0 + 2)).toBe('ok');
    }));

    test('REQ-STORE-5: lease takeover yields fence 2 and a complete with fence 1 is stale and leaves the record unchanged', withHarness(async (h) => {
      const o = op('s5');
      expectAcquired(expect, await h.store.begin(o, opts(T0)), 1);
      expectAcquired(expect, await h.store.begin(o, opts(T0 + LEASE_MS)), 2);
      expect(await h.store.complete(o, 1, httpResult, T0 + LEASE_MS + 1)).toBe('stale_fence');
      const rec = await h.store.get(o, T0 + LEASE_MS + 2);
      expect(rec?.state).toBe('in_flight');
      expect(rec?.fence).toBe(2);
      expect(rec?.result).toBeUndefined();
      expect(rec?.leaseUntil).toBe(T0 + LEASE_MS + LEASE_MS);
    }));

    test('REQ-STORE-6: abandon removes the in-flight record and begin afterwards acquires again', withHarness(async (h) => {
      const o = op('s6');
      await h.store.begin(o, opts(T0));
      expect(await h.store.abandon(o, 2)).toBe('stale_fence');
      expect(await h.store.abandon(o, 1)).toBe('ok');
      expect(await h.store.get(o, T0 + 1)).toBeNull();
      expect(await h.store.abandon(o, 1)).toBe('not_found');
      expectAcquired(expect, await h.store.begin(o, opts(T0 + 2)), 1);
    }));

    test('REQ-STORE-7: after expiresAt begin acquires with the fence continued from the stale row', withHarness(async (h) => {
      const o = op('s7a');
      await h.store.begin(o, opts(T0));
      await h.store.complete(o, 1, httpResult, T0 + 1);
      expect(await h.store.get(o, T0 + TTL_MS)).toBeNull();
      expectAcquired(expect, await h.store.begin(o, opts(T0 + TTL_MS)), 2);
      const rec = await h.store.get(o, T0 + TTL_MS + 1);
      expect(rec?.state).toBe('in_flight');
      expect(rec?.expiresAt).toBe(T0 + TTL_MS + TTL_MS);
    }));

    test('REQ-STORE-7: a ttl-expired row with a different fingerprint yields acquired', withHarness(async (h) => {
      const o = op('s7b');
      await h.store.begin(o, opts(T0));
      expectAcquired(expect, await h.store.begin(op('s7b', 'fp-b'), opts(T0 + TTL_MS)), 2);
    }));

    test('REQ-STORE-7: purge returns the number of expired records removed', withHarness(async (h) => {
      await h.store.begin(op('s7c'), opts(T0));
      await h.store.begin(op('s7d'), opts(T0 + 1000));
      const removed = await h.store.purge(T0 + TTL_MS + 500);
      expect(removed).toBe(1);
      expect(await h.store.get(op('s7c'), T0 + TTL_MS + 500)).toBeNull();
      expect((await h.store.get(op('s7d'), T0 + TTL_MS + 500))?.state).toBe('in_flight');
    }));

    test('REQ-STORE-7: a physically removed row restarts the fence at 1', withHarness(async (h) => {
      const o = op('s7e');
      await h.store.begin(o, opts(T0));
      await h.store.begin(o, opts(T0 + LEASE_MS));
      if (h.physicallyRemove) await h.physicallyRemove(o);
      else await h.store.purge(T0 + TTL_MS + LEASE_MS);
      expectAcquired(expect, await h.store.begin(o, opts(T0 + TTL_MS + LEASE_MS)), 1);
    }));

    test('REQ-STORE-8: 50 concurrent begins yield exactly one acquired and 49 in_flight, 20 iterations', withHarness(async (h) => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const o = op(`s8-${iteration}`);
        const gate = Promise.resolve();
        const outcomes = await Promise.all(Array.from({ length: 50 }, () => gate.then(() => h.store.begin(o, opts(T0)))));
        const acquired = outcomes.filter((x) => x.outcome === 'acquired').length;
        const inFlight = outcomes.filter((x) => x.outcome === 'in_flight').length;
        expect(acquired).toBe(1);
        expect(inFlight).toBe(49);
      }
    }), 60_000);

    test('REQ-STORE-9: the same key under two scopes yields two independent records', withHarness(async (h) => {
      const a: Operation = { scope: `suite:${name}:${unique}:s9-a`, key: 'shared-key', fingerprint: 'fp-a' };
      const b: Operation = { scope: `suite:${name}:${unique}:s9-b`, key: 'shared-key', fingerprint: 'fp-a' };
      expectAcquired(expect, await h.store.begin(a, opts(T0)), 1);
      expectAcquired(expect, await h.store.begin(b, opts(T0)), 1);
      await h.store.complete(a, 1, httpResult, T0 + 1);
      expect((await h.store.begin(b, opts(T0 + 2))).outcome).toBe('in_flight');
      expect((await h.store.begin(a, opts(T0 + 2))).outcome).toBe('completed');
    }));

    test('REQ-STORE-10: the omitted form completes with resultOmitted, no body, and status and headers intact', withHarness(async (h) => {
      const o = op('s10');
      await h.store.begin(o, opts(T0));
      expect(await h.store.complete(o, 1, { omitted: true, kind: 'http', status: 200, headers: [['Content-Type', 'application/octet-stream']] }, T0 + 1)).toBe('ok');
      const rec = recordOf(await h.store.begin(o, opts(T0 + 2)));
      expect(rec?.resultOmitted).toBe(true);
      expect(rec?.result?.body).toBeUndefined();
      expect(rec?.result?.status).toBe(200);
      expect(rec?.result?.headers).toEqual([['Content-Type', 'application/octet-stream']]);
    }));

    test('REQ-STORE-11: a body of exactly 1 MiB round trips byte-exact', withHarness(async (h) => {
      const o = op('s11');
      const body = new Uint8Array(MAX_RESULT_BYTES);
      for (let i = 0; i < body.byteLength; i++) body[i] = (i * 31 + 7) & 0xff;
      await h.store.begin(o, opts(T0));
      expect(await h.store.complete(o, 1, { kind: 'http', status: 200, body }, T0 + 1)).toBe('ok');
      const rec = recordOf(await h.store.begin(o, opts(T0 + 2)));
      expect(rec?.result?.body?.byteLength).toBe(MAX_RESULT_BYTES);
      expect(bytesEqual(rec?.result?.body, body)).toBe(true);
    }), 30_000);
  });
}
```

- [ ] **Step 4: Run the harness test, lint, typecheck, expect pass**

Run: `bun test packages/core/test/testing-suite.test.ts` (1 pass: eleven REQ ids registered and the broken store fails REQ-STORE-1), `bun run lint`, `bun run --filter @anyonce/core typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/testing packages/core/test/testing-suite.test.ts
git commit -m "feat(core): REQ-STORE-1 to REQ-STORE-11 store contract suite exported as @anyonce/core/testing"
```

---

### Task 7: Memory store (REQ-CORE-6), first consumer of the suite

**Files:**
- Create: `packages/core/src/memory.ts`
- Test: `packages/core/test/memory.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: types (Task 1), `storeContractSuite` (Task 6).
- Produces: `class MemoryStore implements Store` with `physicallyRemove(op): Promise<void>` (test-only helper, documented) and `get size(): number`. `begin` is synchronous inside (no `await` between read and write), which is what makes it atomic under `Promise.all`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/memory.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory';
import { LEASE_MS, T0, TTL_MS, storeContractSuite } from '../src/testing/index';

storeContractSuite('memory', () => {
  const store = new MemoryStore();
  return { store, physicallyRemove: (op) => store.physicallyRemove(op) };
}, { describe, test, expect });

describe('MemoryStore extras', () => {
  test('REQ-CORE-6: records returned to callers are copies, mutating them does not change the store', async () => {
    const store = new MemoryStore();
    const op = { scope: 's', key: 'k', fingerprint: 'f' };
    await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
    const body = new Uint8Array([9, 9]);
    await store.complete(op, 1, { kind: 'http', status: 200, body }, T0 + 1);
    body[0] = 1;
    const rec = await store.get(op, T0 + 2);
    expect(rec?.result?.body?.[0]).toBe(9);
    if (rec?.result?.body) rec.result.body[1] = 1;
    expect((await store.get(op, T0 + 3))?.result?.body?.[1]).toBe(9);
  });

  test('REQ-CORE-6: size and physicallyRemove reflect the map', async () => {
    const store = new MemoryStore();
    const op = { scope: 's', key: 'k', fingerprint: 'f' };
    await store.begin(op, { leaseMs: LEASE_MS, ttlMs: TTL_MS, now: T0 });
    expect(store.size).toBe(1);
    await store.physicallyRemove(op);
    expect(store.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/memory.test.ts`
Expected: FAIL, cannot resolve `../src/memory`.

- [ ] **Step 3: Implement**

`packages/core/src/memory.ts`:

```ts
import { isOmitted } from './types';
import type { BeginOptions, BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from './types';

function mapKey(op: Pick<Operation, 'scope' | 'key'>): string {
  return `${op.scope}\x00${op.key}`;
}

function copyResult(result: StoredResult): StoredResult {
  const out: StoredResult = { kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers.map(([n, v]) => [n, v]);
  if (result.body !== undefined) out.body = new Uint8Array(result.body);
  if (result.outcome !== undefined) out.outcome = result.outcome;
  if (result.error !== undefined) out.error = { name: result.error.name, message: result.error.message };
  return out;
}

function omittedToStored(result: OmittedResult): StoredResult {
  const out: StoredResult = { kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers.map(([n, v]) => [n, v]);
  return out;
}

function copyRecord(record: IdempotencyRecord): IdempotencyRecord {
  const out: IdempotencyRecord = {
    scope: record.scope,
    key: record.key,
    fingerprint: record.fingerprint,
    state: record.state,
    fence: record.fence,
    leaseUntil: record.leaseUntil,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  if (record.result !== undefined) out.result = copyResult(record.result);
  if (record.resultOmitted !== undefined) out.resultOmitted = record.resultOmitted;
  return out;
}

/**
 * REQ-CORE-6: in-process store for tests and single-instance deployments. begin performs its read and write
 * without yielding, so concurrent callers in one event loop see one atomic claim (D4).
 */
export class MemoryStore implements Store {
  private readonly records = new Map<string, IdempotencyRecord>();

  get size(): number {
    return this.records.size;
  }

  async begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome> {
    const key = mapKey(op);
    const existing = this.records.get(key);
    const { now } = opts;
    if (existing !== undefined && existing.expiresAt > now) {
      if (existing.fingerprint !== op.fingerprint) return { outcome: 'mismatch', record: copyRecord(existing) };
      if (existing.state === 'completed') return { outcome: 'completed', record: copyRecord(existing) };
      if (existing.leaseUntil > now) return { outcome: 'in_flight', leaseUntil: existing.leaseUntil };
    }
    const fence = existing === undefined ? 1 : existing.fence + 1;
    this.records.set(key, {
      scope: op.scope,
      key: op.key,
      fingerprint: op.fingerprint,
      state: 'in_flight',
      fence,
      leaseUntil: now + opts.leaseMs,
      createdAt: now,
      expiresAt: now + opts.ttlMs,
    });
    return { outcome: 'acquired', fence };
  }

  async complete(op: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    const existing = this.records.get(mapKey(op));
    if (existing === undefined || existing.expiresAt <= now) return 'not_found';
    if (existing.fence !== fence) return 'stale_fence';
    if (existing.state === 'completed') return 'ok';
    existing.state = 'completed';
    if (isOmitted(result)) {
      existing.result = omittedToStored(result);
      existing.resultOmitted = true;
    } else {
      existing.result = copyResult(result);
    }
    return 'ok';
  }

  async abandon(op: Operation, fence: number): Promise<CompleteStatus> {
    const key = mapKey(op);
    const existing = this.records.get(key);
    if (existing === undefined || existing.state !== 'in_flight') return 'not_found';
    if (existing.fence !== fence) return 'stale_fence';
    this.records.delete(key);
    return 'ok';
  }

  async get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(mapKey(op));
    if (existing === undefined || existing.expiresAt <= now) return null;
    return copyRecord(existing);
  }

  async purge(now: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test-only: simulates a native TTL sweep deleting the row, so the next begin restarts the fence at 1 (Q8). */
  async physicallyRemove(op: Pick<Operation, 'scope' | 'key'>): Promise<void> {
    this.records.delete(mapKey(op));
  }
}
```

Add to `packages/core/src/index.ts`: `export { MemoryStore } from './memory';`.

- [ ] **Step 4: Run tests, lint, typecheck, expect pass**

Run: `bun test packages/core/test/memory.test.ts` (18 pass: 16 suite tests plus 2 extras; the race test runs 20 iterations without any sleep), `bun run lint`, `bun run --filter @anyonce/core typecheck`. If REQ-STORE-8 fails, `begin` has an `await` before its write; that is the bug, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory.ts packages/core/src/index.ts packages/core/test/memory.test.ts
git commit -m "feat(core): REQ-CORE-6 memory store passes the store contract suite"
```

---

### Task 8: The engine (REQ-CORE-1) with 100 percent branch coverage

**Files:**
- Create: `packages/core/src/engine.ts`
- Test: `packages/core/test/engine.test.ts`
- Modify: `packages/core/src/index.ts`, `docs/superpowers/questions.md` (Q15, Q16, Q17)

**Interfaces:**
- Consumes: types (Task 1).
- Produces: `ExecuteHooks`, `ExecutePolicy` (3.3 plus `hookErrors?: { count: number }`), `ExecuteResult`, `DEFAULT_LEASE_MS`, `DEFAULT_TTL_MS`, `DEFAULT_MAX_RESULT_BYTES`, `defaultStoreResult(result)`, `defaultPolicy(overrides?)`, `resultSize(result)`, `omitBody(result): OmittedResult`, `execute(store, op, run, policy)`. P2's HTTP adapter and P4a's queue adapter call `execute` and switch on `kind`.
- Rulings this task records in `docs/superpowers/questions.md` (append, same format as Q1 to Q14, each with a recommended resolution the code follows):
  - Q15: a store error at `complete` returns `{ kind: 'executed', stored: false }` in both modes and fires `onStoreError`; `store_error` is returned only when `begin` fails under fail-closed, because by the time `complete` fails the handler has already run and hiding its result behind a 503 would make the client retry work that happened. `abandon` on a completed record returns `not_found`; a `complete` returning `stale_fence` or `not_found` yields `stored: false`.
  - Q16: the Go `Execute` returns `(Result, nil)` for executed, replayed, conflict and mismatch (the `Kind` field is the signal, matching the TS union); it returns `(Result{Kind: ResultStoreError}, err)` with `err` wrapping `ErrStoreUnavailable` for a fail-closed store failure at begin; and `(Result{}, err)` wrapping the handler's error when `run` fails (after abandoning). `ErrConflict`, `ErrMismatch` and `ErrStaleFence` are exported for adapters and stores to use as sentinels.
  - Q17: `resultSize` is the body byte length only; headers are allowlisted and small, and the cap exists to bound stored bodies (D12).

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_TTL_MS,
  defaultPolicy,
  defaultStoreResult,
  execute,
  omitBody,
  resultSize,
} from '../src/engine';
import type { ExecuteHooks, ExecutePolicy } from '../src/engine';
import type { BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from '../src/types';

const op: Operation = { scope: 'POST /x', key: 'k', fingerprint: 'f' };
const record: IdempotencyRecord = {
  scope: op.scope, key: op.key, fingerprint: op.fingerprint, state: 'completed', fence: 1,
  leaseUntil: 0, createdAt: 0, expiresAt: 10, result: { kind: 'http', status: 201 },
};

type Scripted<T> = T | Error;

class FakeStore implements Store {
  calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(
    private readonly script: { begin: Scripted<BeginOutcome>; complete?: Scripted<CompleteStatus>; abandon?: Scripted<CompleteStatus> },
  ) {}
  private play<T>(method: string, value: Scripted<T> | undefined, args: unknown[], fallback: T): Promise<T> {
    this.calls.push({ method, args });
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value ?? fallback);
  }
  begin(o: Operation, opts: { leaseMs: number; ttlMs: number; now: number }): Promise<BeginOutcome> {
    return this.play('begin', this.script.begin, [o, opts], { outcome: 'acquired', fence: 1 });
  }
  complete(o: Operation, fence: number, result: StoredResult | OmittedResult, now: number): Promise<CompleteStatus> {
    return this.play('complete', this.script.complete, [o, fence, result, now], 'ok');
  }
  abandon(o: Operation, fence: number): Promise<CompleteStatus> {
    return this.play('abandon', this.script.abandon, [o, fence], 'ok');
  }
  get(): Promise<IdempotencyRecord | null> {
    return Promise.resolve(null);
  }
  purge(): Promise<number> {
    return Promise.resolve(0);
  }
  named(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

const ok: StoredResult = { kind: 'http', status: 200, headers: [['Content-Type', 'text/plain']], body: new Uint8Array([1, 2, 3]) };

function fullHooks(log: string[]): ExecuteHooks {
  return {
    onAcquired: () => log.push('acquired'),
    onReplayed: () => log.push('replayed'),
    onConflict: () => log.push('conflict'),
    onMismatch: () => log.push('mismatch'),
    onStoreError: () => log.push('store_error'),
  };
}

function policy(overrides: Partial<ExecutePolicy> = {}): ExecutePolicy {
  return defaultPolicy({ clock: () => 123, ...overrides });
}

describe('execute', () => {
  test('REQ-CORE-1: acquired runs the handler once, completes with the result, and reports stored', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 7 } });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(store, op, async () => { runs += 1; return ok; }, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'executed', result: ok, stored: true });
    expect(runs).toBe(1);
    expect(store.named('begin')[0]?.args[1]).toEqual({ leaseMs: DEFAULT_LEASE_MS, ttlMs: DEFAULT_TTL_MS, now: 123 });
    expect(store.named('complete')[0]?.args.slice(1)).toEqual([7, ok, 123]);
    expect(store.named('abandon')).toHaveLength(0);
    expect(log).toEqual(['acquired']);
  });

  test('REQ-CORE-1: completed replays without running the handler', async () => {
    const store = new FakeStore({ begin: { outcome: 'completed', record } });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(store, op, async () => { runs += 1; return ok; }, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'replayed', record });
    expect(runs).toBe(0);
    expect(log).toEqual(['replayed']);
  });

  test('REQ-CORE-1: in_flight yields conflict with the lease deadline', async () => {
    const store = new FakeStore({ begin: { outcome: 'in_flight', leaseUntil: 999 } });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'conflict', leaseUntil: 999 });
    expect(log).toEqual(['conflict']);
  });

  test('REQ-CORE-1: mismatch yields mismatch with the record', async () => {
    const store = new FakeStore({ begin: { outcome: 'mismatch', record } });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'mismatch', record });
    expect(log).toEqual(['mismatch']);
  });

  test('REQ-CORE-1: a begin failure under fail-closed returns store_error without running', async () => {
    const boom = new Error('down');
    const store = new FakeStore({ begin: boom });
    const log: string[] = [];
    let runs = 0;
    const out = await execute(store, op, async () => { runs += 1; return ok; }, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'store_error', error: boom });
    expect(runs).toBe(0);
    expect(log).toEqual(['store_error']);
  });

  test('REQ-CORE-1: a begin failure under fail-open runs the handler and reports stored false', async () => {
    const store = new FakeStore({ begin: new Error('down') });
    const out = await execute(store, op, async () => ok, policy({ onStoreError: 'fail-open' }));
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: a throwing handler abandons the record and rethrows', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 3 } });
    const failure = new Error('handler failed');
    await expect(execute(store, op, async () => { throw failure; }, policy())).rejects.toThrow('handler failed');
    expect(store.named('abandon')[0]?.args).toEqual([op, 3]);
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: when abandon also fails the handler error still wins and onStoreError fires', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 3 }, abandon: new Error('abandon down') });
    const log: string[] = [];
    await expect(execute(store, op, async () => { throw new Error('handler failed'); }, policy({ hooks: fullHooks(log) }))).rejects.toThrow('handler failed');
    expect(log).toEqual(['acquired', 'store_error']);
  });

  test('REQ-CORE-1: a result the policy refuses to store is abandoned and reported stored false', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const out = await execute(store, op, async () => ({ kind: 'http', status: 503 }), policy());
    expect(out).toEqual({ kind: 'executed', result: { kind: 'http', status: 503 }, stored: false });
    expect(store.named('abandon')).toHaveLength(1);
    expect(store.named('complete')).toHaveLength(0);
  });

  test('REQ-CORE-1: a body over maxResultBytes completes with the omitted form, status and headers intact', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const big: StoredResult = { kind: 'http', status: 200, headers: [['ETag', '"x"']], body: new Uint8Array(11) };
    const out = await execute(store, op, async () => big, policy({ maxResultBytes: 10 }));
    expect(out).toEqual({ kind: 'executed', result: big, stored: true });
    expect(store.named('complete')[0]?.args[2]).toEqual({ omitted: true, kind: 'http', status: 200, headers: [['ETag', '"x"']] });
  });

  test('REQ-CORE-1: a body of exactly maxResultBytes is stored in full', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const exact: StoredResult = { kind: 'http', status: 200, body: new Uint8Array(10) };
    await execute(store, op, async () => exact, policy({ maxResultBytes: 10 }));
    expect(store.named('complete')[0]?.args[2]).toBe(exact);
  });

  test('REQ-CORE-1: a complete failure reports stored false and fires onStoreError (Q15)', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 }, complete: new Error('complete down') });
    const log: string[] = [];
    const out = await execute(store, op, async () => ok, policy({ hooks: fullHooks(log) }));
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
    expect(log).toEqual(['acquired', 'store_error']);
  });

  test('REQ-CORE-1: a stale fence at complete reports stored false', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 }, complete: 'stale_fence' });
    const out = await execute(store, op, async () => ok, policy());
    expect(out).toEqual({ kind: 'executed', result: ok, stored: false });
  });

  test('REQ-CORE-1: hooks that throw are swallowed and counted', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const hookErrors = { count: 0 };
    const hooks: ExecuteHooks = { onAcquired: () => { throw new Error('hook'); } };
    const out = await execute(store, op, async () => ok, policy({ hooks, hookErrors }));
    expect(out.kind).toBe('executed');
    expect(hookErrors.count).toBe(1);
  });

  test('REQ-CORE-1: hooks that throw without a counter are still swallowed', async () => {
    const store = new FakeStore({ begin: { outcome: 'completed', record } });
    const hooks: ExecuteHooks = { onReplayed: () => { throw new Error('hook'); } };
    const out = await execute(store, op, async () => ok, policy({ hooks }));
    expect(out.kind).toBe('replayed');
  });

  test('REQ-CORE-1: without a clock the engine uses Date.now and without hooks it is silent', async () => {
    const store = new FakeStore({ begin: { outcome: 'acquired', fence: 1 } });
    const before = Date.now();
    const out = await execute(store, op, async () => ok, defaultPolicy());
    const after = Date.now();
    expect(out.kind).toBe('executed');
    const now = (store.named('begin')[0]?.args[1] as { now: number }).now;
    expect(now >= before && now <= after).toBe(true);
  });
});

describe('policy helpers', () => {
  test('REQ-CORE-1: defaultPolicy carries the 3.3 defaults and accepts overrides', () => {
    const p = defaultPolicy();
    expect([p.leaseMs, p.ttlMs, p.maxResultBytes, p.onStoreError]).toEqual([30_000, 86_400_000, 1_048_576, 'fail-closed']);
    expect(DEFAULT_MAX_RESULT_BYTES).toBe(1_048_576);
    expect(defaultPolicy({ leaseMs: 5 }).leaseMs).toBe(5);
  });

  test('REQ-CORE-1: defaultStoreResult stores messages and http below 500 only (D6)', () => {
    expect(defaultStoreResult({ kind: 'message', outcome: 'error' })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 200 })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 404 })).toBe(true);
    expect(defaultStoreResult({ kind: 'http', status: 500 })).toBe(false);
    expect(defaultStoreResult({ kind: 'http' })).toBe(false);
  });

  test('REQ-CORE-1: resultSize counts body bytes only and omitBody drops the body (Q17)', () => {
    expect(resultSize({ kind: 'http', status: 200 })).toBe(0);
    expect(resultSize(ok)).toBe(3);
    expect(omitBody(ok)).toEqual({ omitted: true, kind: 'http', status: 200, headers: [['Content-Type', 'text/plain']] });
    expect(omitBody({ kind: 'message', outcome: 'ok' })).toEqual({ omitted: true, kind: 'message' });
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun test packages/core/test/engine.test.ts`
Expected: FAIL, cannot resolve `../src/engine`.

- [ ] **Step 3: Implement**

`packages/core/src/engine.ts`:

```ts
import type { BeginOutcome, CompleteStatus, IdempotencyRecord, OmittedResult, Operation, Store, StoredResult } from './types';

export interface ExecuteHooks {
  onAcquired?(op: Operation): void;
  onReplayed?(op: Operation, record: IdempotencyRecord): void;
  onConflict?(op: Operation, leaseUntil: number): void;
  onMismatch?(op: Operation, record: IdempotencyRecord): void;
  onStoreError?(op: Operation, error: unknown): void;
}

export interface ExecutePolicy {
  leaseMs: number;
  ttlMs: number;
  maxResultBytes: number;
  storeResult: (result: StoredResult) => boolean;
  onStoreError: 'fail-closed' | 'fail-open';
  clock?: () => number;
  hooks?: ExecuteHooks;
  /** Incremented every time a hook throws. Hooks never throw into the engine (3.3). */
  hookErrors?: { count: number };
}

export type ExecuteResult =
  | { kind: 'executed'; result: StoredResult; stored: boolean }
  | { kind: 'replayed'; record: IdempotencyRecord }
  | { kind: 'conflict'; leaseUntil: number }
  | { kind: 'mismatch'; record: IdempotencyRecord }
  | { kind: 'store_error'; error: unknown };

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_TTL_MS = 86_400_000;
export const DEFAULT_MAX_RESULT_BYTES = 1_048_576;

/** D6: store message outcomes and HTTP results below 500. */
export function defaultStoreResult(result: StoredResult): boolean {
  return result.kind === 'message' || (result.status ?? 500) < 500;
}

export function defaultPolicy(overrides: Partial<ExecutePolicy> = {}): ExecutePolicy {
  return {
    leaseMs: DEFAULT_LEASE_MS,
    ttlMs: DEFAULT_TTL_MS,
    maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
    storeResult: defaultStoreResult,
    onStoreError: 'fail-closed',
    ...overrides,
  };
}

/** Q17: the cap bounds stored bodies; headers are allowlisted and small. */
export function resultSize(result: StoredResult): number {
  return result.body?.byteLength ?? 0;
}

/** D12 and Q7: the omitted form keeps status and headers so a replay can reproduce them. */
export function omitBody(result: StoredResult): OmittedResult {
  const out: OmittedResult = { omitted: true, kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers;
  return out;
}

type Safely = (fn: () => void) => void;

async function abandonQuietly(store: Store, op: Operation, fence: number, hooks: ExecuteHooks, safely: Safely): Promise<void> {
  try {
    await store.abandon(op, fence);
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
  }
}

/**
 * The one state machine (requirements 3.3). Runs the handler at most once per acquired claim, replays completed
 * results, reports conflicts and mismatches, and never lets a hook or a store failure change which of those it did.
 */
export async function execute(store: Store, op: Operation, run: () => Promise<StoredResult>, policy: ExecutePolicy): Promise<ExecuteResult> {
  const now = (): number => (policy.clock ?? Date.now)();
  const hooks: ExecuteHooks = policy.hooks ?? {};
  const safely: Safely = (fn) => {
    try {
      fn();
    } catch {
      if (policy.hookErrors !== undefined) policy.hookErrors.count += 1;
    }
  };

  let outcome: BeginOutcome;
  try {
    outcome = await store.begin(op, { leaseMs: policy.leaseMs, ttlMs: policy.ttlMs, now: now() });
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
    if (policy.onStoreError === 'fail-closed') return { kind: 'store_error', error };
    return { kind: 'executed', result: await run(), stored: false };
  }

  if (outcome.outcome === 'completed') {
    const { record } = outcome;
    safely(() => hooks.onReplayed?.(op, record));
    return { kind: 'replayed', record };
  }
  if (outcome.outcome === 'in_flight') {
    const { leaseUntil } = outcome;
    safely(() => hooks.onConflict?.(op, leaseUntil));
    return { kind: 'conflict', leaseUntil };
  }
  if (outcome.outcome === 'mismatch') {
    const { record } = outcome;
    safely(() => hooks.onMismatch?.(op, record));
    return { kind: 'mismatch', record };
  }

  const { fence } = outcome;
  safely(() => hooks.onAcquired?.(op));

  let result: StoredResult;
  try {
    result = await run();
  } catch (error) {
    await abandonQuietly(store, op, fence, hooks, safely);
    throw error;
  }

  if (!policy.storeResult(result)) {
    await abandonQuietly(store, op, fence, hooks, safely);
    return { kind: 'executed', result, stored: false };
  }

  const payload = resultSize(result) > policy.maxResultBytes ? omitBody(result) : result;
  let status: CompleteStatus;
  try {
    status = await store.complete(op, fence, payload, now());
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
    return { kind: 'executed', result, stored: false };
  }
  return { kind: 'executed', result, stored: status === 'ok' };
}
```

Add to `packages/core/src/index.ts`: `export { DEFAULT_LEASE_MS, DEFAULT_MAX_RESULT_BYTES, DEFAULT_TTL_MS, defaultPolicy, defaultStoreResult, execute, omitBody, resultSize } from './engine';` and `export type { ExecuteHooks, ExecutePolicy, ExecuteResult } from './engine';`.

- [ ] **Step 4: Record Q15, Q16 and Q17**

Append to `docs/superpowers/questions.md` three entries in the existing format (heading, situation paragraph, "Recommended resolution:" paragraph) with the texts from the Interfaces block above. Keep the decision paragraphs absent (they are new questions for Shantanu). No em or en dashes.

- [ ] **Step 5: Run tests, coverage, lint, typecheck, expect pass**

Run: `bun test packages/core/test/engine.test.ts` (19 pass), `bun run test:coverage` (engine.ts, key.ts and sfstring.ts each at 100 percent branches, functions, lines and statements; the run fails on any threshold miss), `bun run lint`, `bun run --filter @anyonce/core typecheck`. If coverage reports an uncovered branch in engine.ts, add a scripted test that reaches it; do not restructure the engine to dodge the branch.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/engine.ts packages/core/src/index.ts packages/core/test/engine.test.ts docs/superpowers/questions.md
git commit -m "feat(core): REQ-CORE-1 execute engine with full branch coverage"
```

---

### Task 9: Build, size budget, scripts, CI steps and changeset (REQ-CORE-7, REQ-REL-5, NFR-3)

**Files:**
- Create: `scripts/size.ts`, `.changeset/p1-core.md`
- Test: `packages/core/test/size.test.ts`, `packages/core/test/build.test.ts`
- Modify: root `package.json` (`size` script, `test:reqs` to `--phase p1`), `.github/workflows/ci.yml` (`ts` job), `test/ci.test.ts`

**Interfaces:**
- Consumes: everything under `packages/core/src`.
- Produces: `measureBundle(entry: string): Promise<{ minified: number; gzip: number }>` exported from `scripts/size.ts`; `bun run size` prints each budget line and exits 1 over budget; `bun run build` emits `packages/core/dist/{index,testing/index}.{js,cjs,d.ts}`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/size.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CORE_BUDGET_BYTES, measureBundle } from '../../../scripts/size';

describe('bundle size', () => {
  test('REQ-REL-5: the core root entry is under 8 KB minified plus gzip', async () => {
    const { gzip, minified } = await measureBundle(join(import.meta.dir, '../src/index.ts'));
    expect(minified).toBeGreaterThan(0);
    expect(gzip).toBeLessThan(CORE_BUDGET_BYTES);
  });
});
```

`packages/core/test/build.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dir, '../dist');

describe('build output', () => {
  test('NFR-3: tsup emits esm, cjs and d.ts for both entries', async () => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: join(import.meta.dir, '..'), stderr: 'pipe', stdout: 'pipe' });
    expect(build.exitCode).toBe(0);
    for (const file of ['index.js', 'index.cjs', 'index.d.ts', 'testing/index.js', 'testing/index.cjs', 'testing/index.d.ts']) {
      expect(existsSync(join(dist, file))).toBe(true);
    }
    const esm = (await import(join(dist, 'index.js'))) as { execute?: unknown; MemoryStore?: unknown };
    expect(typeof esm.execute).toBe('function');
    expect(typeof esm.MemoryStore).toBe('function');
    const testing = (await import(join(dist, 'testing/index.js'))) as { storeContractSuite?: unknown };
    expect(typeof testing.storeContractSuite).toBe('function');
  }, 60_000);
});
```

- [ ] **Step 2: Run them, expect failure**

Run: `bun test packages/core/test/size.test.ts packages/core/test/build.test.ts`
Expected: FAIL, cannot resolve `../../../scripts/size`; the build test fails on the missing `dist` if run alone.

- [ ] **Step 3: Write the size script, scripts and CI changes**

`scripts/size.ts`:

```ts
#!/usr/bin/env bun
/** REQ-REL-5: minified plus gzip size of package entries against their budgets. */
import { join } from 'node:path';

export const CORE_BUDGET_BYTES = 8192;

export interface Budget {
  name: string;
  entry: string;
  limit: number;
}

export const BUDGETS: Budget[] = [{ name: '@anyonce/core', entry: 'packages/core/src/index.ts', limit: CORE_BUDGET_BYTES }];

export async function measureBundle(entry: string): Promise<{ minified: number; gzip: number }> {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: true });
  if (!result.success) throw new Error(`bundle failed for ${entry}: ${result.logs.map((l) => l.message).join('; ')}`);
  const output = result.outputs[0];
  if (output === undefined) throw new Error(`no output for ${entry}`);
  const text = await output.text();
  const minified = new TextEncoder().encode(text).byteLength;
  const gzip = Bun.gzipSync(new TextEncoder().encode(text)).byteLength;
  return { minified, gzip };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  let failed = false;
  for (const budget of BUDGETS) {
    const { minified, gzip } = await measureBundle(join(root, budget.entry));
    const status = gzip <= budget.limit ? 'ok' : 'OVER';
    console.log(`${budget.name.padEnd(22)} ${String(gzip).padStart(6)} B gzip (${minified} B min), limit ${budget.limit} B: ${status}`);
    if (gzip > budget.limit) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
```

Root `package.json` scripts: add `"size": "bun run scripts/size.ts"`; change `"test:reqs"` to `"bun run scripts/reqs.ts --phase p1"`.

`.github/workflows/ci.yml`, `ts` job: after `- run: bun run build` add `- run: bun run size`; after the `scripts/no-skips.sh test.log` step add `- run: bun run test:coverage`. Keep everything else.

`test/ci.test.ts`: add `REQ-REL-4: the ts job runs the size budget and the coverage gate` asserting `runs(ci.jobs.ts)` contains `bun run size` and `bun run test:coverage`.

`.changeset/p1-core.md`:

```markdown
---
"@anyonce/core": minor
---

Initial core: store types, key and sf-string parsing, RFC 8785 canonicalization, SHA-256 fingerprints, newKey, the memory store, the execute engine, and the store contract suite at @anyonce/core/testing.
```

- [ ] **Step 4: Run the build, the tests, the size script, lint, typecheck and the REQ gate, expect pass**

Run: `bun run build`, then `bun test packages/core` (all core tests; the build test rebuilds), then `bun run size` (prints the core line with `ok`; if it is over 8192 bytes, look for accidental bulk such as duplicated helpers or the testing suite leaking into the root entry, since `src/index.ts` must not export from `./testing`), then `bun run test:coverage`, `bun run lint`, `bun run typecheck`, `bun run test:reqs` (REQ-CORE-1..7 and REQ-STORE-1..11 covered; REQ-CORE-8 uncovered until Task 10, so exit 1 is expected here and noted), `bun test test/ci.test.ts`.

Node smoke for both module systems: `node -e "const m = require('./packages/core/dist/index.cjs'); const t = require('./packages/core/dist/testing/index.cjs'); if (typeof m.execute !== 'function' || typeof t.storeContractSuite !== 'function') process.exit(1); console.log('cjs ok');"` and `node --input-type=module -e "const m = await import('./packages/core/dist/index.js'); if (typeof m.execute !== 'function') process.exit(1); console.log('esm ok');"`.

- [ ] **Step 5: Commit**

```bash
git add scripts/size.ts packages/core/test/size.test.ts packages/core/test/build.test.ts package.json .github/workflows/ci.yml test/ci.test.ts .changeset/p1-core.md
git commit -m "chore(core): REQ-REL-5 size budget, build smoke, coverage and size CI steps, changeset"
```

---

### Task 10: Go core types, sentinel errors, sf-string and key parsing (REQ-CORE-8, REQ-CORE-2, REQ-CORE-3)

**Files:**
- Create: `go/anyonce/doc.go`, `go/anyonce/types.go`, `go/anyonce/errors.go`, `go/anyonce/sfstring.go`, `go/anyonce/key.go`, `go/anyonce/keygen.go`
- Test: `go/anyonce/sfstring_test.go`, `go/anyonce/key_test.go`, `go/anyonce/keygen_test.go`

**Interfaces:**
- Produces the package `github.com/sns45/anyonce/go/anyonce` with the types below (Tasks 11 to 13 and every later Go package import them by these names): `Operation`, `State`, `Kind`, `Outcome`, `MessageError`, `StoredResult` (with `Omitted bool` as the Q7 form), `Record`, `BeginKind`, `BeginOutcome`, `BeginOptions`, `CompleteStatus`, `Store`; errors `ErrConflict`, `ErrMismatch`, `ErrStaleFence`, `ErrStoreUnavailable`, `ErrInvalidKey`; `ParseSfString(input string) (string, error)`; `MaxKeyBytes`, `Syntax`, `SyntaxLenient`, `SyntaxStrict`, `ValidateKey(key string, allowSpace bool) error`, `ParseKey(headerValue string, syntax Syntax) (string, error)`; `RedactKey(key string) string`. Go commands: `GOROOT= /opt/homebrew/bin/go <verb> -C go ...`.

- [ ] **Step 1: Write the failing tests**

`go/anyonce/sfstring_test.go`:

```go
package anyonce_test

import (
	"errors"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestParseSfString(t *testing.T) {
	ok := []struct{ in, want string }{
		{`"abc"`, "abc"},
		{`"hello world"`, "hello world"},
		{`"foo \"bar\" \\ baz"`, `foo "bar" \ baz`},
		{`"a\"b"`, `a"b`},
		{`""`, ""},
		{`  "padded"  `, "padded"},
	}
	for _, tc := range ok {
		t.Run("REQ-CORE-3: accepts "+tc.in, func(t *testing.T) {
			got, err := anyonce.ParseSfString(tc.in)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	bad := []string{`abc`, ``, `"abc`, `"abc"x`, `"abc";a=1`, `"a\nb"`, `"a\`, "\"café\"", "\"tab\there\"", "\"del\x7f\""}
	for _, in := range bad {
		t.Run("REQ-CORE-3: rejects "+in, func(t *testing.T) {
			if _, err := anyonce.ParseSfString(in); !errors.Is(err, anyonce.ErrInvalidKey) {
				t.Fatalf("want ErrInvalidKey, got %v", err)
			}
		})
	}
}
```

`go/anyonce/key_test.go`:

```go
package anyonce_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestValidateKey(t *testing.T) {
	t.Run("REQ-CORE-2: accepts printable ASCII from 1 to 255 bytes", func(t *testing.T) {
		for _, k := range []string{"a", "!~", strings.Repeat("a", anyonce.MaxKeyBytes)} {
			if err := anyonce.ValidateKey(k, false); err != nil {
				t.Fatalf("%q: %v", k, err)
			}
		}
	})
	rejected := map[string]string{
		"empty":                   "",
		"256 bytes":               strings.Repeat("a", 256),
		"space without sf-string": "a b",
		"control char":            "a\x01b",
		"tab":                     "a\tb",
		"DEL":                     "a\x7fb",
		"non-ASCII":               "café",
	}
	for name, key := range rejected {
		t.Run("REQ-CORE-2: rejects "+name, func(t *testing.T) {
			if err := anyonce.ValidateKey(key, false); !errors.Is(err, anyonce.ErrInvalidKey) {
				t.Fatalf("want ErrInvalidKey, got %v", err)
			}
		})
	}
	t.Run("REQ-CORE-2: allows space only when allowSpace is set", func(t *testing.T) {
		if err := anyonce.ValidateKey("a b", true); err != nil {
			t.Fatal(err)
		}
		if err := anyonce.ValidateKey("a b", false); err == nil {
			t.Fatal("expected rejection")
		}
	})
}

func TestParseKey(t *testing.T) {
	cases := []struct {
		name, in string
		syntax   anyonce.Syntax
		want     string
		wantErr  bool
	}{
		{"REQ-CORE-2: lenient accepts a bare token", "abc-123", anyonce.SyntaxLenient, "abc-123", false},
		{"REQ-CORE-2: lenient trims spaces", "  abc  ", anyonce.SyntaxLenient, "abc", false},
		{"REQ-CORE-3: lenient strips quotes and unescapes", `"a\"b"`, anyonce.SyntaxLenient, `a"b`, false},
		{"REQ-CORE-3: lenient keeps a space inside an sf-string", `"with space"`, anyonce.SyntaxLenient, "with space", false},
		{"REQ-CORE-3: strict accepts an sf-string", `"abc"`, anyonce.SyntaxStrict, "abc", false},
		{"REQ-CORE-3: strict rejects a bare token", "abc", anyonce.SyntaxStrict, "", true},
		{"REQ-CORE-3: unterminated quote is invalid in strict", `"abc`, anyonce.SyntaxStrict, "", true},
		{"REQ-CORE-3: unterminated quote is invalid in lenient", `"abc`, anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: empty sf-string is invalid", `""`, anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: 256 byte bare key is invalid", strings.Repeat("a", 256), anyonce.SyntaxLenient, "", true},
		{"REQ-CORE-2: quoted key over 255 bytes is invalid", `"` + strings.Repeat("a", 256) + `"`, anyonce.SyntaxStrict, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := anyonce.ParseKey(tc.in, tc.syntax)
			if tc.wantErr {
				if !errors.Is(err, anyonce.ErrInvalidKey) {
					t.Fatalf("want ErrInvalidKey, got %v", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
```

`go/anyonce/keygen_test.go` (RedactKey only; NewKey arrives in Task 11):

```go
package anyonce_test

import (
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestRedactKey(t *testing.T) {
	t.Run("NFR-2: keeps the first 8 characters and appends an ellipsis", func(t *testing.T) {
		if got := anyonce.RedactKey("8e03978e-40d5-43e8-bc93-6894a57f9324"); got != "8e03978e…" {
			t.Fatalf("got %q", got)
		}
		if got := anyonce.RedactKey("short"); got != "short…" {
			t.Fatalf("got %q", got)
		}
	})
}
```

- [ ] **Step 2: Run them, expect failure**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./anyonce/`
Expected: FAIL, package `anyonce` not found.

- [ ] **Step 3: Implement**

`go/anyonce/doc.go`:

```go
// Package anyonce is the core idempotency engine: one state machine (requirements 3.2) behind a Store whose
// Begin is a single atomic operation, plus key parsing, fingerprints and the memory store's contract.
package anyonce
```

`go/anyonce/types.go`:

```go
package anyonce

import (
	"context"
	"time"
)

// Operation identifies one idempotent execution: scope isolates tenants and routes, key comes from the client,
// fingerprint hashes the payload.
type Operation struct {
	Scope       string
	Key         string
	Fingerprint string
}

// State is the record state.
type State string

const (
	StateInFlight  State = "in_flight"
	StateCompleted State = "completed"
)

// Kind is the result kind.
type Kind string

const (
	KindHTTP    Kind = "http"
	KindMessage Kind = "message"
)

// Outcome is a message result outcome.
type Outcome string

const (
	OutcomeOK    Outcome = "ok"
	OutcomeError Outcome = "error"
)

// MessageError is the stored error of a message outcome.
type MessageError struct {
	Name    string
	Message string
}

// StoredResult mirrors the TypeScript StoredResult. Omitted marks the D12 form: the body was dropped because it
// exceeded the cap, while Status and Headers survive (Q7).
type StoredResult struct {
	Kind    Kind
	Status  int
	Headers [][2]string
	Body    []byte
	Outcome Outcome
	Error   *MessageError
	Omitted bool
}

// Clone returns a deep copy so callers cannot mutate store state through it.
func (r StoredResult) Clone() StoredResult {
	out := r
	if r.Headers != nil {
		out.Headers = make([][2]string, len(r.Headers))
		copy(out.Headers, r.Headers)
	}
	if r.Body != nil {
		out.Body = append([]byte(nil), r.Body...)
	}
	if r.Error != nil {
		e := *r.Error
		out.Error = &e
	}
	return out
}

// Record is the stored idempotency record.
type Record struct {
	Scope         string
	Key           string
	Fingerprint   string
	State         State
	Fence         int64
	LeaseUntil    time.Time
	CreatedAt     time.Time
	ExpiresAt     time.Time
	Result        *StoredResult
	ResultOmitted bool
}

// Clone returns a deep copy.
func (r Record) Clone() Record {
	out := r
	if r.Result != nil {
		res := r.Result.Clone()
		out.Result = &res
	}
	return out
}

// BeginKind is the outcome of Begin.
type BeginKind string

const (
	BeginAcquired  BeginKind = "acquired"
	BeginInFlight  BeginKind = "in_flight"
	BeginCompleted BeginKind = "completed"
	BeginMismatch  BeginKind = "mismatch"
)

// BeginOutcome carries Fence for acquired, LeaseUntil for in_flight, and Record for completed and mismatch.
type BeginOutcome struct {
	Kind       BeginKind
	Fence      int64
	LeaseUntil time.Time
	Record     *Record
}

// BeginOptions are the lease, TTL and the caller's clock reading.
type BeginOptions struct {
	Lease time.Duration
	TTL   time.Duration
	Now   time.Time
}

// CompleteStatus is the result of Complete and Abandon.
type CompleteStatus string

const (
	CompleteOK         CompleteStatus = "ok"
	CompleteStaleFence CompleteStatus = "stale_fence"
	CompleteNotFound   CompleteStatus = "not_found"
)

// Store is the atomic claim store (D3, D4). Begin is one atomic operation per implementation.
type Store interface {
	Begin(ctx context.Context, op Operation, opts BeginOptions) (BeginOutcome, error)
	Complete(ctx context.Context, op Operation, fence int64, result StoredResult, now time.Time) (CompleteStatus, error)
	Abandon(ctx context.Context, op Operation, fence int64) (CompleteStatus, error)
	Get(ctx context.Context, scope, key string, now time.Time) (*Record, error)
	Purge(ctx context.Context, now time.Time) (int, error)
}
```

`go/anyonce/errors.go`:

```go
package anyonce

import "errors"

var (
	// ErrConflict marks an in-flight duplicate (adapters map it to 409).
	ErrConflict = errors.New("anyonce: operation in flight")
	// ErrMismatch marks a key reused with a different payload (422).
	ErrMismatch = errors.New("anyonce: fingerprint mismatch")
	// ErrStaleFence marks a complete or abandon from a superseded lease holder.
	ErrStaleFence = errors.New("anyonce: stale fence")
	// ErrStoreUnavailable wraps a store failure under fail-closed (503).
	ErrStoreUnavailable = errors.New("anyonce: store unavailable")
	// ErrInvalidKey wraps every key syntax or validation failure (400 invalid-key).
	ErrInvalidKey = errors.New("anyonce: invalid key")
)
```

`go/anyonce/sfstring.go`:

```go
package anyonce

import (
	"fmt"
	"strings"
)

// ParseSfString parses one RFC 9651 sf-string: a DQUOTE, printable ASCII with backslash escapes for DQUOTE and
// backslash only, and a closing DQUOTE. Surrounding spaces are discarded; anything after the closing quote is an
// error because the key is the whole field value. Errors wrap ErrInvalidKey.
func ParseSfString(input string) (string, error) {
	s := strings.Trim(input, " ")
	if s == "" || s[0] != '"' {
		return "", fmt.Errorf("%w: not an sf-string: missing opening quote", ErrInvalidKey)
	}
	var out strings.Builder
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\':
			i++
			if i >= len(s) {
				return "", fmt.Errorf("%w: unterminated escape", ErrInvalidKey)
			}
			if s[i] != '"' && s[i] != '\\' {
				return "", fmt.Errorf("%w: invalid escape \\%c", ErrInvalidKey, s[i])
			}
			out.WriteByte(s[i])
		case c == '"':
			if i+1 < len(s) {
				return "", fmt.Errorf("%w: trailing characters after the closing quote", ErrInvalidKey)
			}
			return out.String(), nil
		case c < 0x20 || c > 0x7e:
			return "", fmt.Errorf("%w: non-printable or non-ASCII character in sf-string", ErrInvalidKey)
		default:
			out.WriteByte(c)
		}
	}
	return "", fmt.Errorf("%w: unterminated quote", ErrInvalidKey)
}
```

`go/anyonce/key.go`:

```go
package anyonce

import (
	"fmt"
	"strings"
)

// MaxKeyBytes is the D7 key length limit (a profile choice; the draft sets none).
const MaxKeyBytes = 255

// Syntax selects lenient (bare token or sf-string) or strict (sf-string only) key parsing (D7).
type Syntax string

const (
	SyntaxLenient Syntax = "lenient"
	SyntaxStrict  Syntax = "strict"
)

// ValidateKey enforces REQ-CORE-2: 1 to 255 bytes of printable ASCII (0x21..0x7E); space only when allowSpace.
func ValidateKey(key string, allowSpace bool) error {
	if key == "" {
		return fmt.Errorf("%w: key is empty", ErrInvalidKey)
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if c == 0x20 && allowSpace {
			continue
		}
		if c < 0x21 || c > 0x7e {
			return fmt.Errorf("%w: key contains a character outside printable ASCII at index %d", ErrInvalidKey, i)
		}
	}
	if len(key) > MaxKeyBytes {
		return fmt.Errorf("%w: key exceeds %d bytes", ErrInvalidKey, MaxKeyBytes)
	}
	return nil
}

// ParseKey applies D7: lenient accepts a bare token or a quoted sf-string, strict accepts only an sf-string.
// The resulting key must satisfy ValidateKey; space is allowed only inside an sf-string.
func ParseKey(headerValue string, syntax Syntax) (string, error) {
	trimmed := strings.TrimSpace(headerValue)
	quoted := strings.HasPrefix(trimmed, `"`)
	if syntax == SyntaxStrict || quoted {
		value, err := ParseSfString(trimmed)
		if err != nil {
			return "", err
		}
		if err := ValidateKey(value, true); err != nil {
			return "", err
		}
		return value, nil
	}
	if err := ValidateKey(trimmed, false); err != nil {
		return "", err
	}
	return trimmed, nil
}
```

`go/anyonce/keygen.go` (NewKey is added in Task 11):

```go
package anyonce

// RedactKey returns the only form of a key that may reach a log line (NFR-2): the first 8 bytes plus an ellipsis.
func RedactKey(key string) string {
	if len(key) > 8 {
		key = key[:8]
	}
	return key + "…"
}
```

- [ ] **Step 4: Run the Go gate, expect pass**

Run: `GOROOT= /opt/homebrew/bin/go build -C go ./...`, `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./anyonce/` (all subtests pass), `GOROOT= sh -c 'cd go && golangci-lint run'` (0 issues).

- [ ] **Step 5: Commit**

```bash
git add go/anyonce
git commit -m "feat(go): REQ-CORE-8 core types and errors, REQ-CORE-2 key validation, REQ-CORE-3 sf-string"
```

---

### Task 11: Go JCS, fingerprints and NewKey (REQ-CORE-4, REQ-CORE-5)

**Files:**
- Create: `go/anyonce/jcs.go`, `go/anyonce/fingerprint.go`
- Modify: `go/anyonce/keygen.go` (add `NewKey`)
- Test: `go/anyonce/jcs_test.go`, `go/anyonce/fingerprint_test.go`, `go/anyonce/keygen_test.go` (add NewKey tests)

**Interfaces:**
- Produces: `Canonicalize(v any) ([]byte, error)` (RFC 8785 over any value `encoding/json` can marshal), `SHA256Hex(b []byte) string`, `HTTPFingerprint(method, path string, body []byte) string`, `JCSFingerprint(v any) (string, error)`, `NewKey() (string, error)`. P2's `httpmw` and P4a's `anyqmw` call these.

- [ ] **Step 1: Write the failing tests**

`go/anyonce/jcs_test.go` (the number table is the one Task 4 verified against JavaScript; copy any corrections made there):

```go
package anyonce_test

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func fromHex(t *testing.T, hex string) float64 {
	t.Helper()
	bits, err := strconv.ParseUint(hex, 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	return math.Float64frombits(bits)
}

func TestCanonicalize(t *testing.T) {
	t.Run("REQ-CORE-4: RFC 8785 section 3.2.3 example canonicalizes byte for byte", func(t *testing.T) {
		var input any
		text := "{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],\"string\":\"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\"literals\":[null,true,false]}"
		if err := json.Unmarshal([]byte(text), &input); err != nil {
			t.Fatal(err)
		}
		got, err := anyonce.Canonicalize(input)
		if err != nil {
			t.Fatal(err)
		}
		want := "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}"
		if string(got) != want {
			t.Fatalf("got  %s\nwant %s", got, want)
		}
	})

	t.Run("REQ-CORE-4: object keys sort by UTF-16 code units", func(t *testing.T) {
		got, err := anyonce.Canonicalize(map[string]any{"b": 1, "a": 2, "é": 3, "B": 4, "10": 5, "9": 6})
		if err != nil || string(got) != "{\"10\":5,\"9\":6,\"B\":4,\"a\":2,\"b\":1,\"é\":3}" {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	t.Run("REQ-CORE-4: nested structures, empty containers, control characters, no HTML escaping", func(t *testing.T) {
		got, err := anyonce.Canonicalize(map[string]any{"z": []any{map[string]any{"y": map[string]any{}}, []any{}}, "a": "tab\there\x01<&>"})
		if err != nil || string(got) != "{\"a\":\"tab\\there\\u0001<&>\",\"z\":[{\"y\":{}},[]]}" {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	t.Run("REQ-CORE-4: structs and integers go through encoding/json first", func(t *testing.T) {
		type payload struct {
			Amount int    `json:"amount"`
			ID     string `json:"id"`
		}
		got, err := anyonce.Canonicalize(payload{Amount: 5, ID: "x"})
		if err != nil || string(got) != `{"amount":5,"id":"x"}` {
			t.Fatalf("got %s, %v", got, err)
		}
	})

	numbers := []struct{ hex, want string }{
		{"0000000000000000", "0"},
		{"8000000000000000", "0"},
		{"0000000000000001", "5e-324"},
		{"7fefffffffffffff", "1.7976931348623157e+308"},
		{"4340000000000000", "9007199254740992"},
		{"444b1ae4d6e2ef4f", "999999999999999900000"},
		{"444b1ae4d6e2ef50", "1e+21"},
		{"3eb0c6f7a0b5ed8d", "0.000001"},
		{"3eb0c6f7a0b5ed8c", "9.999999999999997e-7"},
		{"41b3de4355555555", "333333333.3333333"},
		{"becbf647612f3696", "-0.0000033333333333333333"},
		{"44b52d02c7e14af6", "1e+23"},
	}
	for _, tc := range numbers {
		t.Run("REQ-CORE-4: number "+tc.hex+" serializes as "+tc.want, func(t *testing.T) {
			got, err := anyonce.Canonicalize(fromHex(t, tc.hex))
			if err != nil || string(got) != tc.want {
				t.Fatalf("got %s, %v; want %s", got, err, tc.want)
			}
		})
	}

	t.Run("REQ-CORE-4: non-finite numbers and unsupported values are errors", func(t *testing.T) {
		for _, v := range []any{math.NaN(), math.Inf(1), func() {}, make(chan int)} {
			if _, err := anyonce.Canonicalize(v); err == nil {
				t.Fatalf("expected error for %T", v)
			}
		}
	})
}
```

`go/anyonce/fingerprint_test.go`:

```go
package anyonce_test

import (
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestFingerprints(t *testing.T) {
	t.Run("REQ-CORE-4: SHA256Hex known answers", func(t *testing.T) {
		if got := anyonce.SHA256Hex(nil); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
			t.Fatal(got)
		}
		if got := anyonce.SHA256Hex([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CORE-4: HTTPFingerprint hashes method, LF, path, LF, body", func(t *testing.T) {
		want := anyonce.SHA256Hex([]byte("POST\n/echo\nhello"))
		if got := anyonce.HTTPFingerprint("POST", "/echo", []byte("hello")); got != want {
			t.Fatal(got)
		}
		if anyonce.HTTPFingerprint("PATCH", "/echo", []byte("hello")) == want || anyonce.HTTPFingerprint("POST", "/echo", []byte("hellp")) == want {
			t.Fatal("fingerprint must change with method or body")
		}
		if got := anyonce.HTTPFingerprint("POST", "/x", nil); got != anyonce.SHA256Hex([]byte("POST\n/x\n")) {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CORE-4: JCSFingerprint is key order independent and hashes the canonical text", func(t *testing.T) {
		a, errA := anyonce.JCSFingerprint(map[string]any{"b": 1, "a": []any{2, 3}})
		b, errB := anyonce.JCSFingerprint(map[string]any{"a": []any{2, 3}, "b": 1})
		if errA != nil || errB != nil || a != b || a != anyonce.SHA256Hex([]byte(`{"a":[2,3],"b":1}`)) {
			t.Fatalf("%s %s %v %v", a, b, errA, errB)
		}
	})
}
```

Append to `go/anyonce/keygen_test.go`:

```go
func TestNewKey(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	t.Run("REQ-CORE-5: returns a lowercase UUID version 4", func(t *testing.T) {
		k, err := anyonce.NewKey()
		if err != nil || !re.MatchString(k) {
			t.Fatalf("%q %v", k, err)
		}
	})
	t.Run("REQ-CORE-5: 10000 keys are unique", func(t *testing.T) {
		seen := make(map[string]struct{}, 10000)
		for i := 0; i < 10000; i++ {
			k, err := anyonce.NewKey()
			if err != nil {
				t.Fatal(err)
			}
			seen[k] = struct{}{}
		}
		if len(seen) != 10000 {
			t.Fatalf("%d unique", len(seen))
		}
	})
}
```

(add `"regexp"` to that file's imports).

- [ ] **Step 2: Run them, expect failure**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./anyonce/`
Expected: FAIL, undefined `Canonicalize`, `SHA256Hex`, `NewKey`.

- [ ] **Step 3: Implement**

`go/anyonce/jcs.go`:

```go
package anyonce

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

var errNonFinite = errors.New("anyonce: non-finite number cannot be canonicalized")

// Canonicalize produces the RFC 8785 (JCS) form of any value encoding/json can marshal: members sorted by UTF-16
// code units, numbers in ECMAScript Number::toString form, strings escaped per the RFC (no HTML escaping).
func Canonicalize(v any) ([]byte, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("anyonce: canonicalize: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, fmt.Errorf("anyonce: canonicalize: %w", err)
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, tree); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if x {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return fmt.Errorf("anyonce: canonicalize: %w", err)
		}
		s, err := es6Number(f)
		if err != nil {
			return err
		}
		buf.WriteString(s)
	case string:
		writeJSONString(buf, x)
	case []any:
		buf.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			writeJSONString(buf, k)
			buf.WriteByte(':')
			if err := writeCanonical(buf, x[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("anyonce: canonicalize: unsupported value %T", v)
	}
	return nil
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

func writeJSONString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
}

// es6Number formats f exactly as ECMAScript Number::toString does, which RFC 8785 section 3.2.2.3 requires.
func es6Number(f float64) (string, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "", errNonFinite
	}
	if f == 0 {
		return "0", nil
	}
	neg := f < 0
	if neg {
		f = -f
	}
	mant, expStr, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	exp, _ := strconv.Atoi(expStr)
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := exp + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(e)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(e)
		}
	}
	if neg {
		out = "-" + out
	}
	return out, nil
}
```

`go/anyonce/fingerprint.go`:

```go
package anyonce

import (
	"crypto/sha256"
	"encoding/hex"
)

// SHA256Hex returns the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// HTTPFingerprint is the D9 default: SHA-256 over method, LF, path, LF, body. The method is hashed as given.
func HTTPFingerprint(method, path string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte{'\n'})
	h.Write([]byte(path))
	h.Write([]byte{'\n'})
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

// JCSFingerprint is SHA-256 over the RFC 8785 canonical form of v.
func JCSFingerprint(v any) (string, error) {
	canonical, err := Canonicalize(v)
	if err != nil {
		return "", err
	}
	return SHA256Hex(canonical), nil
}
```

Add to `go/anyonce/keygen.go` (imports `crypto/rand`, `encoding/hex`, `fmt`):

```go
// NewKey returns a fresh UUID version 4 built from crypto/rand (REQ-CORE-5).
func NewKey() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("anyonce: newKey: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], nil
}
```

- [ ] **Step 4: Run the Go gate, expect pass**

Run: `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./anyonce/`, `GOROOT= sh -c 'cd go && golangci-lint run'`. If a number sample fails, compare the Go output with `JSON.stringify` of the same double in bun (`bun -e "..."`); JavaScript is the reference and the Go formatter must match it.

- [ ] **Step 5: Commit**

```bash
git add go/anyonce
git commit -m "feat(go): REQ-CORE-4 RFC 8785 canonicalization and fingerprints, REQ-CORE-5 NewKey"
```

---

### Task 12: Go store contract suite and memory store (REQ-CORE-6, REQ-STORE-1..11 in Go)

**Files:**
- Create: `go/storetest/storetest.go`, `go/store/memory/memory.go`
- Test: `go/store/memory/memory_test.go`, `go/storetest/storetest_test.go` (broken store fails)

**Interfaces:**
- Consumes: `anyonce` types (Task 10).
- Produces: package `github.com/sns45/anyonce/go/storetest` with `Harness{ Store anyonce.Store; PhysicallyRemove func(ctx context.Context, scope, key string) error; Close func() error }`, `Factory func(t *testing.T) Harness`, `Run(t *testing.T, name string, factory Factory)`, constants `Lease`, `TTL`, `T0`, `MaxResultBytes`; package `github.com/sns45/anyonce/go/store/memory` with `New() *Store`, `(*Store).PhysicallyRemove(ctx, scope, key string) error`, `(*Store).Len() int`. P3's Go stores call `storetest.Run`.

- [ ] **Step 1: Write the failing tests**

`go/storetest/storetest_test.go`:

```go
package storetest_test

import (
	"context"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/storetest"
)

// broken never acquires, violating REQ-STORE-1 on purpose.
type broken struct{}

func (broken) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight}, nil
}
func (broken) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return anyonce.CompleteNotFound, nil
}
func (broken) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return anyonce.CompleteNotFound, nil
}
func (broken) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) { return nil, nil }
func (broken) Purge(context.Context, time.Time) (int, error)                          { return 0, nil }

// TestBrokenProbe only runs inside the subprocess spawned below; it is expected to fail.
func TestBrokenProbe(t *testing.T) {
	if os.Getenv("STORETEST_PROBE") != "1" {
		t.Skip("probe runs in a subprocess")
	}
	storetest.Run(t, "broken", func(*testing.T) storetest.Harness { return storetest.Harness{Store: broken{}} })
}

func TestRunFailsABrokenStore(t *testing.T) {
	t.Run("REQ-STORE-1: the suite fails a store that never acquires", func(t *testing.T) {
		cmd := exec.Command(os.Args[0], "-test.run", "^TestBrokenProbe$", "-test.v")
		cmd.Env = append(os.Environ(), "STORETEST_PROBE=1")
		out, err := cmd.CombinedOutput()
		if err == nil {
			t.Fatalf("expected the probe to fail; output:\n%s", out)
		}
		if !strings.Contains(string(out), "REQ-STORE-1") {
			t.Fatalf("probe output does not mention REQ-STORE-1:\n%s", out)
		}
	})
}
```

(imports: `context`, `os`, `os/exec`, `strings`, `testing`, `time`, plus the two anyonce packages). The skip inside `TestBrokenProbe` is a subprocess guard, not a service skip; it runs in the parent process every time and is the one intentional skip in the Go suite.

`go/store/memory/memory_test.go`:

```go
package memory_test

import (
	"context"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/storetest"
)

func TestMemoryStoreContract(t *testing.T) {
	storetest.Run(t, "memory", func(*testing.T) storetest.Harness {
		s := memory.New()
		return storetest.Harness{Store: s, PhysicallyRemove: s.PhysicallyRemove}
	})
}

func TestMemoryStoreExtras(t *testing.T) {
	t.Run("REQ-CORE-6: records returned to callers are copies", func(t *testing.T) {
		s := memory.New()
		ctx := context.Background()
		op := anyonce.Operation{Scope: "s", Key: "k", Fingerprint: "f"}
		if _, err := s.Begin(ctx, op, anyonce.BeginOptions{Lease: storetest.Lease, TTL: storetest.TTL, Now: storetest.T0}); err != nil {
			t.Fatal(err)
		}
		body := []byte{9, 9}
		if _, err := s.Complete(ctx, op, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, storetest.T0); err != nil {
			t.Fatal(err)
		}
		body[0] = 1
		rec, _ := s.Get(ctx, "s", "k", storetest.T0)
		if rec.Result.Body[0] != 9 {
			t.Fatal("store shared the caller's slice")
		}
		rec.Result.Body[1] = 1
		again, _ := s.Get(ctx, "s", "k", storetest.T0)
		if again.Result.Body[1] != 9 {
			t.Fatal("caller mutated store state")
		}
		if s.Len() != 1 {
			t.Fatalf("len %d", s.Len())
		}
	})
	t.Run("REQ-CORE-6: a cancelled context is honored", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := memory.New().Begin(ctx, anyonce.Operation{Scope: "s", Key: "k"}, anyonce.BeginOptions{Now: storetest.T0}); err == nil {
			t.Fatal("expected context error")
		}
	})
}
```

- [ ] **Step 2: Run them, expect failure**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./storetest/ ./store/memory/`
Expected: FAIL, packages not found.

- [ ] **Step 3: Write the suite**

`go/storetest/storetest.go`:

```go
// Package storetest is the shared store contract (requirements 4.2). Every anyonce store must pass Run.
package storetest

import (
	"bytes"
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

const (
	Lease          = 30 * time.Second
	TTL            = 24 * time.Hour
	MaxResultBytes = 1 << 20
)

// T0 is the fixed clock every test starts from; time never comes from the wall clock here.
var T0 = time.UnixMilli(1_700_000_000_000).UTC()

// Harness is what a store's test file hands to Run. PhysicallyRemove simulates a native TTL sweep deleting the
// row (stores without native TTL may leave it nil; Purge is used instead). Close releases resources.
type Harness struct {
	Store            anyonce.Store
	PhysicallyRemove func(ctx context.Context, scope, key string) error
	Close            func() error
}

// Factory builds a fresh harness per test.
type Factory func(t *testing.T) Harness

var httpResult = anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 201, Headers: [][2]string{{"Content-Type", "text/plain"}}, Body: []byte{1, 2, 3, 255, 0, 7}}

func opts(now time.Time) anyonce.BeginOptions { return anyonce.BeginOptions{Lease: Lease, TTL: TTL, Now: now} }

// Run registers one subtest per contract requirement against the factory's store.
func Run(t *testing.T, name string, factory Factory) {
	t.Helper()
	uniq := time.Now().UnixNano()
	op := func(tag, fingerprint string) anyonce.Operation {
		return anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:%s", name, uniq, tag), Key: "key-" + tag, Fingerprint: fingerprint}
	}
	ctx := context.Background()
	with := func(fn func(t *testing.T, s anyonce.Store, h Harness)) func(t *testing.T) {
		return func(t *testing.T) {
			h := factory(t)
			if h.Close != nil {
				t.Cleanup(func() { _ = h.Close() })
			}
			fn(t, h.Store, h)
		}
	}
	mustBegin := func(t *testing.T, s anyonce.Store, o anyonce.Operation, now time.Time) anyonce.BeginOutcome {
		t.Helper()
		out, err := s.Begin(ctx, o, opts(now))
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		return out
	}
	expectAcquired := func(t *testing.T, out anyonce.BeginOutcome, fence int64) {
		t.Helper()
		if out.Kind != anyonce.BeginAcquired || out.Fence != fence {
			t.Fatalf("want acquired fence %d, got %+v", fence, out)
		}
	}

	t.Run("REQ-STORE-1: begin on an absent record returns acquired with fence 1", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		expectAcquired(t, mustBegin(t, s, op("s1", "fp-a"), T0), 1)
	}))

	t.Run("REQ-STORE-2: a second begin with the same fingerprint while the lease is live returns in_flight with the same leaseUntil", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s2", "fp-a")
		mustBegin(t, s, o, T0)
		second := mustBegin(t, s, o, T0.Add(time.Second))
		if second.Kind != anyonce.BeginInFlight || !second.LeaseUntil.Equal(T0.Add(Lease)) {
			t.Fatalf("got %+v", second)
		}
		if third := mustBegin(t, s, o, T0.Add(Lease-time.Millisecond)); third.Kind != anyonce.BeginInFlight {
			t.Fatalf("got %+v", third)
		}
	}))

	t.Run("REQ-STORE-3: begin with a different fingerprint returns mismatch while in_flight", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s3a", "fp-a"), T0)
		out := mustBegin(t, s, op("s3a", "fp-b"), T0.Add(10*time.Millisecond))
		if out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.Fingerprint != "fp-a" || out.Record.State != anyonce.StateInFlight {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-3: begin with a different fingerprint returns mismatch when completed", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s3b", "fp-a")
		mustBegin(t, s, o, T0)
		if _, err := s.Complete(ctx, o, 1, httpResult, T0.Add(5*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		out := mustBegin(t, s, op("s3b", "fp-b"), T0.Add(10*time.Millisecond))
		if out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.State != anyonce.StateCompleted {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-3: a lease-expired record with a different fingerprint still yields mismatch", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s3c", "fp-a"), T0)
		if out := mustBegin(t, s, op("s3c", "fp-b"), T0.Add(Lease+time.Millisecond)); out.Kind != anyonce.BeginMismatch {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-4: complete then begin returns completed with the stored result byte-exact", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4", "fp-a")
		mustBegin(t, s, o, T0)
		if st, err := s.Complete(ctx, o, 1, httpResult, T0.Add(5*time.Millisecond)); err != nil || st != anyonce.CompleteOK {
			t.Fatalf("complete: %v %v", st, err)
		}
		out := mustBegin(t, s, o, T0.Add(10*time.Millisecond))
		rec := out.Record
		if out.Kind != anyonce.BeginCompleted || rec == nil || rec.State != anyonce.StateCompleted || rec.Fence != 1 || rec.Result == nil {
			t.Fatalf("got %+v", out)
		}
		if rec.Result.Kind != anyonce.KindHTTP || rec.Result.Status != 201 || len(rec.Result.Headers) != 1 || rec.Result.Headers[0] != [2]string{"Content-Type", "text/plain"} {
			t.Fatalf("result %+v", rec.Result)
		}
		if !bytes.Equal(rec.Result.Body, httpResult.Body) || rec.ResultOmitted {
			t.Fatalf("body %v omitted %v", rec.Result.Body, rec.ResultOmitted)
		}
	}))

	t.Run("REQ-STORE-4: complete on an absent record returns not_found and completing twice with the same fence is ok", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4b", "fp-a")
		if st, _ := s.Complete(ctx, o, 1, httpResult, T0); st != anyonce.CompleteNotFound {
			t.Fatalf("got %v", st)
		}
		mustBegin(t, s, o, T0)
		for i := 0; i < 2; i++ {
			if st, _ := s.Complete(ctx, o, 1, httpResult, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
				t.Fatalf("got %v", st)
			}
		}
	}))

	t.Run("REQ-STORE-5: lease takeover yields fence 2 and a complete with fence 1 is stale and leaves the record unchanged", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s5", "fp-a")
		expectAcquired(t, mustBegin(t, s, o, T0), 1)
		expectAcquired(t, mustBegin(t, s, o, T0.Add(Lease)), 2)
		if st, _ := s.Complete(ctx, o, 1, httpResult, T0.Add(Lease+time.Millisecond)); st != anyonce.CompleteStaleFence {
			t.Fatalf("got %v", st)
		}
		rec, err := s.Get(ctx, o.Scope, o.Key, T0.Add(Lease+2*time.Millisecond))
		if err != nil || rec == nil || rec.State != anyonce.StateInFlight || rec.Fence != 2 || rec.Result != nil || !rec.LeaseUntil.Equal(T0.Add(2*Lease)) {
			t.Fatalf("got %+v %v", rec, err)
		}
	}))

	t.Run("REQ-STORE-6: abandon removes the in-flight record and begin afterwards acquires again", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s6", "fp-a")
		mustBegin(t, s, o, T0)
		if st, _ := s.Abandon(ctx, o, 2); st != anyonce.CompleteStaleFence {
			t.Fatalf("got %v", st)
		}
		if st, _ := s.Abandon(ctx, o, 1); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		if rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(time.Millisecond)); rec != nil {
			t.Fatalf("got %+v", rec)
		}
		if st, _ := s.Abandon(ctx, o, 1); st != anyonce.CompleteNotFound {
			t.Fatalf("got %v", st)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(2*time.Millisecond)), 1)
	}))

	t.Run("REQ-STORE-7: after expiresAt begin acquires with the fence continued from the stale row", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s7a", "fp-a")
		mustBegin(t, s, o, T0)
		if _, err := s.Complete(ctx, o, 1, httpResult, T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		if rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(TTL)); rec != nil {
			t.Fatalf("expired record visible: %+v", rec)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(TTL)), 2)
		rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(TTL+time.Millisecond))
		if rec == nil || rec.State != anyonce.StateInFlight || !rec.ExpiresAt.Equal(T0.Add(2*TTL)) {
			t.Fatalf("got %+v", rec)
		}
	}))

	t.Run("REQ-STORE-7: a ttl-expired row with a different fingerprint yields acquired", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s7b", "fp-a"), T0)
		expectAcquired(t, mustBegin(t, s, op("s7b", "fp-b"), T0.Add(TTL)), 2)
	}))

	t.Run("REQ-STORE-7: purge returns the number of expired records removed", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s7c", "fp-a"), T0)
		mustBegin(t, s, op("s7d", "fp-a"), T0.Add(time.Second))
		removed, err := s.Purge(ctx, T0.Add(TTL+500*time.Millisecond))
		if err != nil || removed != 1 {
			t.Fatalf("removed %d %v", removed, err)
		}
		if rec, _ := s.Get(ctx, op("s7c", "fp-a").Scope, "key-s7c", T0.Add(TTL+500*time.Millisecond)); rec != nil {
			t.Fatal("s7c still visible")
		}
		if rec, _ := s.Get(ctx, op("s7d", "fp-a").Scope, "key-s7d", T0.Add(TTL+500*time.Millisecond)); rec == nil || rec.State != anyonce.StateInFlight {
			t.Fatalf("s7d %+v", rec)
		}
	}))

	t.Run("REQ-STORE-7: a physically removed row restarts the fence at 1", with(func(t *testing.T, s anyonce.Store, h Harness) {
		o := op("s7e", "fp-a")
		mustBegin(t, s, o, T0)
		mustBegin(t, s, o, T0.Add(Lease))
		if h.PhysicallyRemove != nil {
			if err := h.PhysicallyRemove(ctx, o.Scope, o.Key); err != nil {
				t.Fatal(err)
			}
		} else if _, err := s.Purge(ctx, T0.Add(TTL+Lease)); err != nil {
			t.Fatal(err)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(TTL+Lease)), 1)
	}))

	t.Run("REQ-STORE-8: 50 concurrent begins yield exactly one acquired and 49 in_flight, 20 iterations", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		for iteration := 0; iteration < 20; iteration++ {
			o := op(fmt.Sprintf("s8-%d", iteration), "fp-a")
			gate := make(chan struct{})
			outcomes := make([]anyonce.BeginOutcome, 50)
			errs := make([]error, 50)
			var wg sync.WaitGroup
			for i := 0; i < 50; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-gate
					outcomes[i], errs[i] = s.Begin(ctx, o, opts(T0))
				}(i)
			}
			close(gate)
			wg.Wait()
			acquired, inFlight := 0, 0
			for i := range outcomes {
				if errs[i] != nil {
					t.Fatalf("iteration %d: %v", iteration, errs[i])
				}
				switch outcomes[i].Kind {
				case anyonce.BeginAcquired:
					acquired++
				case anyonce.BeginInFlight:
					inFlight++
				}
			}
			if acquired != 1 || inFlight != 49 {
				t.Fatalf("iteration %d: acquired %d in_flight %d", iteration, acquired, inFlight)
			}
		}
	}))

	t.Run("REQ-STORE-9: the same key under two scopes yields two independent records", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		a := anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:s9-a", name, uniq), Key: "shared-key", Fingerprint: "fp-a"}
		b := anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:s9-b", name, uniq), Key: "shared-key", Fingerprint: "fp-a"}
		expectAcquired(t, mustBegin(t, s, a, T0), 1)
		expectAcquired(t, mustBegin(t, s, b, T0), 1)
		if _, err := s.Complete(ctx, a, 1, httpResult, T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		if out := mustBegin(t, s, b, T0.Add(2*time.Millisecond)); out.Kind != anyonce.BeginInFlight {
			t.Fatalf("b %+v", out)
		}
		if out := mustBegin(t, s, a, T0.Add(2*time.Millisecond)); out.Kind != anyonce.BeginCompleted {
			t.Fatalf("a %+v", out)
		}
	}))

	t.Run("REQ-STORE-10: the omitted form completes with resultOmitted, no body, and status and headers intact", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s10", "fp-a")
		mustBegin(t, s, o, T0)
		omitted := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"Content-Type", "application/octet-stream"}}, Omitted: true}
		if st, _ := s.Complete(ctx, o, 1, omitted, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		rec := mustBegin(t, s, o, T0.Add(2*time.Millisecond)).Record
		if rec == nil || !rec.ResultOmitted || rec.Result == nil || rec.Result.Body != nil || rec.Result.Status != 200 || len(rec.Result.Headers) != 1 {
			t.Fatalf("got %+v", rec)
		}
	}))

	t.Run("REQ-STORE-11: a body of exactly 1 MiB round trips byte-exact", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s11", "fp-a")
		body := make([]byte, MaxResultBytes)
		for i := range body {
			body[i] = byte((i*31 + 7) & 0xff)
		}
		mustBegin(t, s, o, T0)
		if st, _ := s.Complete(ctx, o, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		rec := mustBegin(t, s, o, T0.Add(2*time.Millisecond)).Record
		if rec == nil || rec.Result == nil || len(rec.Result.Body) != MaxResultBytes || !bytes.Equal(rec.Result.Body, body) {
			t.Fatal("1 MiB body did not round trip")
		}
	}))
}
```

`go/store/memory/memory.go`:

```go
// Package memory is the in-process store (REQ-CORE-6) for tests and single-instance deployments.
package memory

import (
	"context"
	"sync"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Store keeps records in a map guarded by one mutex, so Begin is one atomic claim (D4).
type Store struct {
	mu      sync.Mutex
	records map[string]*anyonce.Record
}

// New returns an empty store.
func New() *Store { return &Store{records: make(map[string]*anyonce.Record)} }

func mapKey(scope, key string) string { return scope + "\x00" + key }

// Len returns the number of stored records, expired or not.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

// Begin applies the 3.2 precedence: TTL expiry (absent), then fingerprint, then lease; fence continues from a
// stale row (Q8).
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	if err := ctx.Err(); err != nil {
		return anyonce.BeginOutcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	k := mapKey(op.Scope, op.Key)
	existing := s.records[k]
	now := opts.Now
	if existing != nil && existing.ExpiresAt.After(now) {
		if existing.Fingerprint != op.Fingerprint {
			rec := existing.Clone()
			return anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}, nil
		}
		if existing.State == anyonce.StateCompleted {
			rec := existing.Clone()
			return anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}, nil
		}
		if existing.LeaseUntil.After(now) {
			return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: existing.LeaseUntil}, nil
		}
	}
	var fence int64 = 1
	if existing != nil {
		fence = existing.Fence + 1
	}
	s.records[k] = &anyonce.Record{
		Scope: op.Scope, Key: op.Key, Fingerprint: op.Fingerprint, State: anyonce.StateInFlight, Fence: fence,
		LeaseUntil: now.Add(opts.Lease), CreatedAt: now, ExpiresAt: now.Add(opts.TTL),
	}
	return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: fence}, nil
}

// Complete stores the result (or the omitted form) when the fence matches.
func (s *Store) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.records[mapKey(op.Scope, op.Key)]
	if existing == nil || !existing.ExpiresAt.After(now) {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence != fence {
		return anyonce.CompleteStaleFence, nil
	}
	if existing.State == anyonce.StateCompleted {
		return anyonce.CompleteOK, nil
	}
	stored := result.Clone()
	if result.Omitted {
		stored.Body = nil
		existing.ResultOmitted = true
	}
	existing.State = anyonce.StateCompleted
	existing.Result = &stored
	return anyonce.CompleteOK, nil
}

// Abandon deletes an in-flight record when the fence matches.
func (s *Store) Abandon(ctx context.Context, op anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	k := mapKey(op.Scope, op.Key)
	existing := s.records[k]
	if existing == nil || existing.State != anyonce.StateInFlight {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence != fence {
		return anyonce.CompleteStaleFence, nil
	}
	delete(s.records, k)
	return anyonce.CompleteOK, nil
}

// Get returns a copy of a live record, or nil.
func (s *Store) Get(ctx context.Context, scope, key string, now time.Time) (*anyonce.Record, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.records[mapKey(scope, key)]
	if existing == nil || !existing.ExpiresAt.After(now) {
		return nil, nil
	}
	rec := existing.Clone()
	return &rec, nil
}

// Purge deletes expired records and returns how many.
func (s *Store) Purge(ctx context.Context, now time.Time) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for k, rec := range s.records {
		if !rec.ExpiresAt.After(now) {
			delete(s.records, k)
			removed++
		}
	}
	return removed, nil
}

// PhysicallyRemove is a test helper simulating a native TTL sweep, so the next Begin restarts the fence at 1.
func (s *Store) PhysicallyRemove(ctx context.Context, scope, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, mapKey(scope, key))
	return nil
}
```

- [ ] **Step 4: Run the Go gate, expect pass**

Run: `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./...` (memory contract 16 subtests plus extras pass; the race detector must be silent), `GOROOT= sh -c 'cd go && golangci-lint run'`. If `Get` returning `nil, nil` trips a linter (nilnil), keep the behavior and add a `//nolint:nilnil // nil record means absent` comment on that line.

- [ ] **Step 5: Commit**

```bash
git add go/storetest go/store
git commit -m "feat(go): REQ-STORE-1 to REQ-STORE-11 storetest suite and REQ-CORE-6 memory store"
```

---

### Task 13: Go engine with full statement coverage (REQ-CORE-1, REQ-CORE-8)

**Files:**
- Create: `go/anyonce/engine.go`, `scripts/go-engine-coverage.sh`
- Test: `go/anyonce/engine_test.go`
- Modify: `.github/workflows/ci.yml` (`go` job), `test/ci.test.ts`, `docs/superpowers/questions.md` (Q16 already written in Task 8; nothing new)

**Interfaces:**
- Consumes: `anyonce` types and errors.
- Produces: `StoreErrorMode` (`FailClosed`, `FailOpen`), `Hooks`, `Policy` (with `HookErrors *atomic.Int64`), `ResultKind` (`ResultExecuted`, `ResultReplayed`, `ResultConflict`, `ResultMismatch`, `ResultStoreError`), `Result`, `DefaultStoreResult`, `DefaultPolicy`, `ResultSize`, `OmitBody`, `Execute(ctx, store, op, run, policy) (Result, error)` with the Q16 error contract. P2's `httpmw` and P4a's `anyqmw` call `Execute`.

- [ ] **Step 1: Write the failing test**

`go/anyonce/engine_test.go`:

```go
package anyonce_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

type call struct {
	method string
	fence  int64
	result anyonce.StoredResult
	opts   anyonce.BeginOptions
}

type fakeStore struct {
	begin        anyonce.BeginOutcome
	beginErr     error
	complete     anyonce.CompleteStatus
	completeErr  error
	abandonErr   error
	calls        []call
}

func (f *fakeStore) Begin(_ context.Context, _ anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	f.calls = append(f.calls, call{method: "begin", opts: opts})
	if f.beginErr != nil {
		return anyonce.BeginOutcome{}, f.beginErr
	}
	if f.begin.Kind == "" {
		return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 1}, nil
	}
	return f.begin, nil
}
func (f *fakeStore) Complete(_ context.Context, _ anyonce.Operation, fence int64, result anyonce.StoredResult, _ time.Time) (anyonce.CompleteStatus, error) {
	f.calls = append(f.calls, call{method: "complete", fence: fence, result: result})
	if f.completeErr != nil {
		return "", f.completeErr
	}
	if f.complete == "" {
		return anyonce.CompleteOK, nil
	}
	return f.complete, nil
}
func (f *fakeStore) Abandon(_ context.Context, _ anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	f.calls = append(f.calls, call{method: "abandon", fence: fence})
	if f.abandonErr != nil {
		return "", f.abandonErr
	}
	return anyonce.CompleteOK, nil
}
func (f *fakeStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) { return nil, nil }
func (f *fakeStore) Purge(context.Context, time.Time) (int, error)                          { return 0, nil }
func (f *fakeStore) named(method string) []call {
	var out []call
	for _, c := range f.calls {
		if c.method == method {
			out = append(out, c)
		}
	}
	return out
}

var (
	op       = anyonce.Operation{Scope: "POST /x", Key: "k", Fingerprint: "f"}
	okResult = anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"Content-Type", "text/plain"}}, Body: []byte{1, 2, 3}}
	record   = anyonce.Record{Scope: "POST /x", Key: "k", Fingerprint: "f", State: anyonce.StateCompleted, Fence: 1}
	fixedNow = time.UnixMilli(123).UTC()
)

func fullHooks(log *[]string) anyonce.Hooks {
	push := func(s string) { *log = append(*log, s) }
	return anyonce.Hooks{
		OnAcquired:   func(anyonce.Operation) { push("acquired") },
		OnReplayed:   func(anyonce.Operation, *anyonce.Record) { push("replayed") },
		OnConflict:   func(anyonce.Operation, time.Time) { push("conflict") },
		OnMismatch:   func(anyonce.Operation, *anyonce.Record) { push("mismatch") },
		OnStoreError: func(anyonce.Operation, error) { push("store_error") },
	}
}

func policy(mut func(*anyonce.Policy)) anyonce.Policy {
	p := anyonce.DefaultPolicy()
	p.Clock = func() time.Time { return fixedNow }
	if mut != nil {
		mut(&p)
	}
	return p
}

func run(result anyonce.StoredResult, err error, runs *int) func(context.Context) (anyonce.StoredResult, error) {
	return func(context.Context) (anyonce.StoredResult, error) {
		*runs++
		return result, err
	}
}

func TestExecute(t *testing.T) {
	ctx := context.Background()

	t.Run("REQ-CORE-1: acquired runs the handler once, completes with the result, and reports stored", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 7}}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultExecuted || !res.Stored || runs != 1 {
			t.Fatalf("%+v %v runs %d", res, err, runs)
		}
		if b := s.named("begin"); len(b) != 1 || b[0].opts.Lease != 30*time.Second || b[0].opts.TTL != 24*time.Hour || !b[0].opts.Now.Equal(fixedNow) {
			t.Fatalf("begin opts %+v", b)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].fence != 7 || c[0].result.Status != 200 {
			t.Fatalf("complete %+v", c)
		}
		if len(s.named("abandon")) != 0 || len(log) != 1 || log[0] != "acquired" {
			t.Fatalf("abandon/log %v", log)
		}
	})

	t.Run("REQ-CORE-1: completed replays without running the handler", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultReplayed || res.Record != &rec || runs != 0 || len(log) != 1 || log[0] != "replayed" {
			t.Fatalf("%+v %v runs %d log %v", res, err, runs, log)
		}
	})

	t.Run("REQ-CORE-1: in_flight yields conflict with the lease deadline", func(t *testing.T) {
		until := fixedNow.Add(time.Second)
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: until}}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultConflict || !res.LeaseUntil.Equal(until) || len(log) != 1 || log[0] != "conflict" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: mismatch yields mismatch with the record", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultMismatch || res.Record != &rec || len(log) != 1 || log[0] != "mismatch" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: a begin failure under fail-closed returns store_error wrapping ErrStoreUnavailable without running (Q16)", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if !errors.Is(err, anyonce.ErrStoreUnavailable) || res.Kind != anyonce.ResultStoreError || runs != 0 || len(log) != 1 || log[0] != "store_error" {
			t.Fatalf("%+v %v runs %d log %v", res, err, runs, log)
		}
	})

	t.Run("REQ-CORE-1: a begin failure under fail-open runs the handler and reports stored false", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.OnStoreError = anyonce.FailOpen }))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(s.named("complete")) != 0 {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: a failing handler abandons the record and returns the wrapped error", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 3}}
		boom := errors.New("handler failed")
		_, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{}, boom, new(int)), policy(nil))
		if !errors.Is(err, boom) || len(s.named("abandon")) != 1 || s.named("abandon")[0].fence != 3 || len(s.named("complete")) != 0 {
			t.Fatalf("%v %+v", err, s.calls)
		}
	})

	t.Run("REQ-CORE-1: when abandon also fails the handler error still wins and OnStoreError fires", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 3}, abandonErr: errors.New("abandon down")}
		var log []string
		boom := errors.New("handler failed")
		_, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{}, boom, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if !errors.Is(err, boom) || len(log) != 2 || log[1] != "store_error" {
			t.Fatalf("%v %v", err, log)
		}
	})

	t.Run("REQ-CORE-1: a result the policy refuses to store is abandoned and reported stored false", func(t *testing.T) {
		s := &fakeStore{}
		res, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 503}, nil, new(int)), policy(nil))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(s.named("abandon")) != 1 || len(s.named("complete")) != 0 {
			t.Fatalf("%+v %v %+v", res, err, s.calls)
		}
	})

	t.Run("REQ-CORE-1: a body over MaxResultBytes completes with the omitted form, status and headers intact", func(t *testing.T) {
		s := &fakeStore{}
		big := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"ETag", `"x"`}}, Body: make([]byte, 11)}
		res, err := anyonce.Execute(ctx, s, op, run(big, nil, new(int)), policy(func(p *anyonce.Policy) { p.MaxResultBytes = 10 }))
		c := s.named("complete")
		if err != nil || !res.Stored || len(c) != 1 || !c[0].result.Omitted || c[0].result.Body != nil || c[0].result.Status != 200 || len(c[0].result.Headers) != 1 {
			t.Fatalf("%+v %v %+v", res, err, c)
		}
	})

	t.Run("REQ-CORE-1: a body of exactly MaxResultBytes is stored in full", func(t *testing.T) {
		s := &fakeStore{}
		exact := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: make([]byte, 10)}
		if _, err := anyonce.Execute(ctx, s, op, run(exact, nil, new(int)), policy(func(p *anyonce.Policy) { p.MaxResultBytes = 10 })); err != nil {
			t.Fatal(err)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].result.Omitted || len(c[0].result.Body) != 10 {
			t.Fatalf("%+v", c)
		}
	})

	t.Run("REQ-CORE-1: a complete failure reports stored false and fires OnStoreError (Q15)", func(t *testing.T) {
		s := &fakeStore{completeErr: errors.New("complete down")}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(log) != 2 || log[1] != "store_error" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: a stale fence at complete reports stored false", func(t *testing.T) {
		s := &fakeStore{complete: anyonce.CompleteStaleFence}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(nil))
		if err != nil || res.Stored {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: hooks that panic are recovered and counted", func(t *testing.T) {
		s := &fakeStore{}
		var count atomic.Int64
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) {
			p.Hooks = anyonce.Hooks{OnAcquired: func(anyonce.Operation) { panic("hook") }}
			p.HookErrors = &count
		}))
		if err != nil || res.Kind != anyonce.ResultExecuted || count.Load() != 1 {
			t.Fatalf("%+v %v count %d", res, err, count.Load())
		}
	})

	t.Run("REQ-CORE-1: hooks that panic without a counter are still recovered", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) {
			p.Hooks = anyonce.Hooks{OnReplayed: func(anyonce.Operation, *anyonce.Record) { panic("hook") }}
		}))
		if err != nil || res.Kind != anyonce.ResultReplayed {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: without a clock the engine uses time.Now and without hooks it is silent", func(t *testing.T) {
		s := &fakeStore{}
		before := time.Now()
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), anyonce.DefaultPolicy())
		after := time.Now()
		now := s.named("begin")[0].opts.Now
		if err != nil || res.Kind != anyonce.ResultExecuted || now.Before(before) || now.After(after) {
			t.Fatalf("%+v %v %v", res, err, now)
		}
	})

	t.Run("REQ-CORE-8: a cancelled context short-circuits before begin", func(t *testing.T) {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		s := &fakeStore{}
		runs := 0
		_, err := anyonce.Execute(cancelled, s, op, run(okResult, nil, &runs), policy(nil))
		if !errors.Is(err, context.Canceled) || runs != 0 || len(s.calls) != 0 {
			t.Fatalf("%v runs %d calls %d", err, runs, len(s.calls))
		}
	})
}

func TestPolicyHelpers(t *testing.T) {
	t.Run("REQ-CORE-1: DefaultPolicy carries the 3.3 defaults", func(t *testing.T) {
		p := anyonce.DefaultPolicy()
		if p.Lease != 30*time.Second || p.TTL != 24*time.Hour || p.MaxResultBytes != 1<<20 || p.OnStoreError != anyonce.FailClosed || p.StoreResult == nil {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("REQ-CORE-1: DefaultStoreResult stores messages and http below 500 only (D6)", func(t *testing.T) {
		cases := []struct {
			in   anyonce.StoredResult
			want bool
		}{
			{anyonce.StoredResult{Kind: anyonce.KindMessage, Outcome: anyonce.OutcomeError}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 404}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 500}, false},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP}, false},
		}
		for _, tc := range cases {
			if got := anyonce.DefaultStoreResult(tc.in); got != tc.want {
				t.Fatalf("%+v: got %v", tc.in, got)
			}
		}
	})
	t.Run("REQ-CORE-1: ResultSize counts body bytes and OmitBody drops the body (Q17)", func(t *testing.T) {
		if anyonce.ResultSize(okResult) != 3 || anyonce.ResultSize(anyonce.StoredResult{}) != 0 {
			t.Fatal("size")
		}
		o := anyonce.OmitBody(okResult)
		if !o.Omitted || o.Body != nil || o.Status != 200 || len(o.Headers) != 1 || o.Kind != anyonce.KindHTTP {
			t.Fatalf("%+v", o)
		}
	})
}
```

- [ ] **Step 2: Run it, expect failure**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./anyonce/`
Expected: FAIL, undefined `Execute`, `Policy`, `Hooks`.

- [ ] **Step 3: Implement**

`go/anyonce/engine.go`:

```go
package anyonce

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// StoreErrorMode is D13: fail-closed (default) or fail-open.
type StoreErrorMode string

const (
	FailClosed StoreErrorMode = "fail-closed"
	FailOpen   StoreErrorMode = "fail-open"
)

// Hooks are observability callbacks. A panicking hook is recovered and counted; it never reaches the engine.
type Hooks struct {
	OnAcquired   func(op Operation)
	OnReplayed   func(op Operation, record *Record)
	OnConflict   func(op Operation, leaseUntil time.Time)
	OnMismatch   func(op Operation, record *Record)
	OnStoreError func(op Operation, err error)
}

// Policy mirrors the TypeScript ExecutePolicy (requirements 3.3).
type Policy struct {
	Lease          time.Duration
	TTL            time.Duration
	MaxResultBytes int
	StoreResult    func(StoredResult) bool
	OnStoreError   StoreErrorMode
	Clock          func() time.Time
	Hooks          Hooks
	HookErrors     *atomic.Int64
}

// ResultKind mirrors the TypeScript ExecuteResult union tag.
type ResultKind string

const (
	ResultExecuted   ResultKind = "executed"
	ResultReplayed   ResultKind = "replayed"
	ResultConflict   ResultKind = "conflict"
	ResultMismatch   ResultKind = "mismatch"
	ResultStoreError ResultKind = "store_error"
)

// Result is what Execute returns. Kind says which fields are meaningful: Result and Stored for executed, Record for
// replayed and mismatch, LeaseUntil for conflict, Err for store_error.
type Result struct {
	Kind       ResultKind
	Result     StoredResult
	Stored     bool
	Record     *Record
	LeaseUntil time.Time
	Err        error
}

// DefaultStoreResult is D6: store message outcomes and HTTP results below 500. A zero Status counts as 500.
func DefaultStoreResult(r StoredResult) bool {
	if r.Kind == KindMessage {
		return true
	}
	status := r.Status
	if status == 0 {
		status = 500
	}
	return status < 500
}

// DefaultPolicy returns the 3.3 defaults: 30 s lease, 24 h TTL, 1 MiB cap, fail-closed.
func DefaultPolicy() Policy {
	return Policy{Lease: 30 * time.Second, TTL: 24 * time.Hour, MaxResultBytes: 1 << 20, StoreResult: DefaultStoreResult, OnStoreError: FailClosed}
}

// ResultSize is the body length (Q17).
func ResultSize(r StoredResult) int { return len(r.Body) }

// OmitBody returns the D12 omitted form: status and headers kept, body dropped.
func OmitBody(r StoredResult) StoredResult {
	return StoredResult{Kind: r.Kind, Status: r.Status, Headers: r.Headers, Omitted: true}
}

func (p Policy) now() time.Time {
	if p.Clock != nil {
		return p.Clock()
	}
	return time.Now()
}

func (p Policy) safely(fn func()) {
	defer func() {
		if recovered := recover(); recovered != nil && p.HookErrors != nil {
			p.HookErrors.Add(1)
		}
	}()
	fn()
}

func (p Policy) storeError(op Operation, err error) {
	if p.Hooks.OnStoreError != nil {
		p.safely(func() { p.Hooks.OnStoreError(op, err) })
	}
}

func abandonQuietly(ctx context.Context, store Store, op Operation, fence int64, policy Policy) {
	if _, err := store.Abandon(ctx, op, fence); err != nil {
		policy.storeError(op, err)
	}
}

// Execute is the one state machine (requirements 3.3). It runs the handler at most once per acquired claim,
// replays completed results, and reports conflicts and mismatches through Result.Kind. Error contract (Q16):
// (Result, nil) for executed, replayed, conflict and mismatch; (Result{Kind: ResultStoreError}, err wrapping
// ErrStoreUnavailable) for a fail-closed store failure at begin; (Result{}, err wrapping the handler's error)
// when run fails, after abandoning the claim.
func Execute(ctx context.Context, store Store, op Operation, run func(ctx context.Context) (StoredResult, error), policy Policy) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	outcome, err := store.Begin(ctx, op, BeginOptions{Lease: policy.Lease, TTL: policy.TTL, Now: policy.now()})
	if err != nil {
		policy.storeError(op, err)
		if policy.OnStoreError == FailClosed {
			wrapped := fmt.Errorf("%w: begin: %w", ErrStoreUnavailable, err)
			return Result{Kind: ResultStoreError, Err: wrapped}, wrapped
		}
		result, runErr := run(ctx)
		if runErr != nil {
			return Result{}, fmt.Errorf("anyonce: handler failed: %w", runErr)
		}
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}

	switch outcome.Kind {
	case BeginCompleted:
		if policy.Hooks.OnReplayed != nil {
			policy.safely(func() { policy.Hooks.OnReplayed(op, outcome.Record) })
		}
		return Result{Kind: ResultReplayed, Record: outcome.Record}, nil
	case BeginInFlight:
		if policy.Hooks.OnConflict != nil {
			policy.safely(func() { policy.Hooks.OnConflict(op, outcome.LeaseUntil) })
		}
		return Result{Kind: ResultConflict, LeaseUntil: outcome.LeaseUntil}, nil
	case BeginMismatch:
		if policy.Hooks.OnMismatch != nil {
			policy.safely(func() { policy.Hooks.OnMismatch(op, outcome.Record) })
		}
		return Result{Kind: ResultMismatch, Record: outcome.Record}, nil
	}

	if policy.Hooks.OnAcquired != nil {
		policy.safely(func() { policy.Hooks.OnAcquired(op) })
	}
	result, runErr := run(ctx)
	if runErr != nil {
		abandonQuietly(ctx, store, op, outcome.Fence, policy)
		return Result{}, fmt.Errorf("anyonce: handler failed: %w", runErr)
	}
	if !policy.StoreResult(result) {
		abandonQuietly(ctx, store, op, outcome.Fence, policy)
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}
	payload := result
	if ResultSize(result) > policy.MaxResultBytes {
		payload = OmitBody(result)
	}
	status, err := store.Complete(ctx, op, outcome.Fence, payload, policy.now())
	if err != nil {
		policy.storeError(op, err)
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}
	return Result{Kind: ResultExecuted, Result: result, Stored: status == CompleteOK}, nil
}
```

`scripts/go-engine-coverage.sh` (executable):

```bash
#!/usr/bin/env bash
# CHECKLIST P1: 100 percent statement coverage on go/anyonce/engine.go.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="$(mktemp)"
GO="${GO:-go}"
"$GO" test -C "$root/go" -coverprofile="$profile" ./anyonce/ >/dev/null
report="$("$GO" tool -C "$root/go" cover -func="$profile" | grep 'anyonce/engine.go' || true)"
rm -f "$profile"
if [ -z "$report" ]; then
  echo "no coverage rows for engine.go" >&2
  exit 1
fi
echo "$report"
if echo "$report" | grep -vq '100.0%'; then
  echo "engine.go is not at 100 percent statement coverage" >&2
  exit 1
fi
echo "engine.go statement coverage 100 percent"
```

If `go tool -C` is not accepted by the installed toolchain, run `go tool cover` without `-C` (the profile path is absolute). Locally run it as `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`.

`.github/workflows/ci.yml`, `go` job: after `go test -race ./...` add a step `- run: ../scripts/go-engine-coverage.sh` (the job's working directory is `go`; the script resolves the repo root itself). `test/ci.test.ts`: add `REQ-REL-4: the go job runs the engine coverage gate` asserting `runs(ci.jobs.go)` contains `go-engine-coverage.sh`.

- [ ] **Step 4: Run the Go gate, the coverage gate, and the REQ gate, expect pass**

Run: `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`, `GOROOT= sh -c 'cd go && golangci-lint run'`, `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh` (every engine.go function at 100.0 percent; if one is short, add the subtest that reaches the missing statement), `bun test test/ci.test.ts`, `bun run test:reqs` (exit 0: REQ-CORE-1..8 and REQ-STORE-1..11 all covered across both languages).

- [ ] **Step 5: Commit**

```bash
git add go/anyonce/engine.go go/anyonce/engine_test.go scripts/go-engine-coverage.sh .github/workflows/ci.yml test/ci.test.ts
git commit -m "feat(go): REQ-CORE-1 Execute engine with full statement coverage, REQ-CORE-8 context threading"
```

---

## Phase gate (CHECKLIST.md, "Every phase" and "P1 core")

Run after Task 13 with `verification-before-completion`, paste the raw output into the PR:

1. `scripts/doctor.sh` (prefix `GOROOT=` locally)
2. `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test 2>&1 | tee /tmp/p1.log`, `scripts/no-skips.sh /tmp/p1.log`, `bun run test:reqs` (phase p1, all REQ-CORE and REQ-STORE ids covered)
3. `bun run test:coverage` (engine.ts, key.ts, sfstring.ts at 100 percent branches), `bun run size` (core root entry under 8192 bytes gzip)
4. From the repo root with the brew toolchain: `go vet ./...`, `go test -race ./...` (memory contract including the 20-iteration race), `golangci-lint run`, `scripts/go-engine-coverage.sh`
5. RFC 9651 and RFC 8785 known-answer tests are part of `bun test packages/core` and `go test ./anyonce/`; cite their names in the PR body
6. `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing
7. `rg -n "console\.(log|info|warn|error)\(.*key" packages go` returns nothing
8. Changeset present: `.changeset/p1-core.md`
9. `docs/superpowers/questions.md` reviewed: Q15, Q16 and Q17 have recommended resolutions and are raised at the checkpoint
10. Node compat smoke on both core entries (Task 9 step 4)

PR body: REQ ids covered are REQ-CORE-1 through REQ-CORE-8 and REQ-STORE-1 through REQ-STORE-11 (plus REQ-REL-5 size budget and NFR-2 redaction). Squash merge to `main`.

