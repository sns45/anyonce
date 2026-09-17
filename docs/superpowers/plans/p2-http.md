# P2 HTTP Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the HTTP door in both languages: `@anyonce/core/http` (`withIdempotency` for any fetch handler plus the shared HTTP helpers), `@anyonce/hono` (the Hono binding), the finished TypeScript conformance runner (report formats, `runConformance`, the CLI), and Go `httpmw` plus the Go conformance runner, with every core and profile vector green against the memory store on Bun, Node 22, Deno and workerd in TypeScript and under `go test -race` in Go.

**Architecture:** The engine from P1 stays the only state machine. `runIdempotent` in `@anyonce/core/http` is the transport bridge: it reads the key, scope and fingerprint from a `Request`, calls `execute`, and turns the outcome into a `Response`. Responses stream to the client through a capture that buffers a copy up to the result cap and closes the client stream only after the record is complete, so a client that has seen EOF can retry and be replayed. `withIdempotency` and the Hono middleware are thin wrappers over `runIdempotent`; Go `httpmw` mirrors the same steps with a `http.ResponseWriter` wrapper. The conformance runners stay transport-only (D18).

**Tech Stack:** Bun 1.2 (`bun test`, workspaces), TypeScript 5 strict, tsup, Biome 2, Hono 4.13 (peer), vitest 3.2.7 with `@cloudflare/vitest-pool-workers` 0.12.21 for workerd, Node 22 (`node --test`), Deno 2.7, Go 1.26 minimum (local toolchain `/opt/homebrew/bin/go`), standard library only, golangci-lint 2.13.2.

**Spec:** `requirements.md` sections 2 (D6 to D14, D17, D18, D21), 4.4 (REQ-HTTP-1..18), 4.7 (REQ-CONF-5..7), 4.8 (REQ-DOC-4), 4.9 (REQ-REL-4, REQ-REL-5), 5 (NFR-2, NFR-4); `docs/superpowers/questions.md` Q7, Q9, Q11, Q14, Q15, Q16, Q17 and the new Q18 (Task 1); `docs/superpowers/specs/2026-09-anyonce-design.md` items B2, B3, B5, B8, C1; `CHECKLIST.md` sections "Every phase" and "P2 HTTP adapter".

## Global Constraints

- Prose in docs, comments, commit messages, changeset text, YAML and shell: no em or en dashes (U+2013, U+2014). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing.
- Test names start with the REQ id they prove: `REQ-HTTP-9: a completed duplicate replays status, headers and body`. Go subtests use `t.Run("REQ-HTTP-9: ...", ...)`. Node and Deno test names carry `NFR-4:`.
- `@anyonce/core/http`: Web APIs only (`Request`, `Response`, `Headers`, `ReadableStream`, `crypto.subtle`, `TextEncoder`); no `node:` import anywhere under `packages/core/src`; zero `dependencies`; the `http` subpath bundle is under 16384 bytes minified plus gzip (REQ-REL-5) and the root entry stays under 8192; the root entry never imports `./http` (Q11) and the package test proves it.
- `@anyonce/hono`: imports only from `@anyonce/core`, `@anyonce/core/http`, `hono` and `hono/route`; `hono >= 4.0.0` and `@anyonce/core` are peer dependencies (D21: zero production dependencies); a test proves the import direction.
- `@anyonce/conformance` may use `node:fs`, `node:path`, `node:url`, `node:process` in `load.ts` and `cli.ts` only; the `runtime` subpath (Task 8) must stay free of `node:` imports so it runs inside workerd.
- TypeScript: `strict`, `exactOptionalPropertyTypes` (build objects conditionally, never assign `undefined` to an optional property), `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any` outside test fakes.
- Problem details (D10, D11, REQ-HTTP-13): every error is `application/problem+json` with members `type`, `title`, `status`, `code` and optional `detail`; `type` is `${problemBaseUri}${code}`; the codes are `missing-key` (400), `invalid-key` (400), `conflict` (409), `fingerprint-mismatch` (422), `payload-too-large` (413), `store-unavailable` (503) and, per Q18, `missing-principal` (500). A 400 `missing-key` carries `Link: <docsUrl>; rel="describedby"`. A 409 carries `Retry-After` of `ceil(leaseRemainingMs / 1000)` with a minimum of 1. A 503 carries `Retry-After: 1`.
- Scope (D8, REQ-HTTP-5): default `${METHOD} ${route pattern}` where a router provides one (Hono: `routePath(c, -1)` from `hono/route`), otherwise `${METHOD} ${url.pathname}`; a principal appends `#${principal}`. Fingerprint (D9, REQ-HTTP-6): `httpFingerprint(method, pathname + search, bodyBytes)`; the `jcs` mode hashes `method`, LF, `pathname + search`, LF, the RFC 8785 form of the JSON body, and falls back to the byte form when the body is not JSON.
- Streaming rule (REQ-HTTP-7): the handler's response streams to the client chunk by chunk while a copy is buffered up to `maxResultBytes` plus one chunk; the client stream is closed only after `complete` or `abandon` has settled, and never before. A bodiless response is released only after the record settles. `Set-Cookie` is never stored (REQ-HTTP-8).
- The engine's `run` callback receives the fence: TypeScript `run(fence)` (additive), Go `run(ctx, fence)` (P1 code is unpublished; the change is made in this phase with a test).
- Never log a full key; nothing in `packages/core`, `packages/hono` or `go/httpmw` logs at all. `redactKey` is the only form a key may take in any message (NFR-2). Problem `detail` strings never include the key value.
- Go: standard library only in `go/httpmw` and `go/conformance`; no cgo; errors wrapped with `%w`; `context.Context` threaded through every call; the `http.ResponseWriter` wrapper implements `Flush`, `Hijack` (passthrough, idempotency disabled) and `Unwrap` (so `http.ResponseController` works); `go vet`, `go test -race`, `golangci-lint run` clean. Run Go as `GOROOT= /opt/homebrew/bin/go <verb> -C go ./...`; golangci-lint as `GOROOT= sh -c 'cd go && golangci-lint run'`; the engine coverage gate as `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh` (engine.go must stay at 100 percent after the fence change).
- Conformance runs use real time (the concurrency vectors wait 1500 ms, the expiry vector 2500 ms). Every test that runs the whole suite sets a 60000 ms timeout. No test sleeps to make an assertion pass; the vectors' own `delayMs` is the only waiting.
- Conventional commits: `feat(core): ...`, `feat(hono): ...`, `feat(conformance): ...`, `feat(go): ...`, `test(...)`, `docs(...)`. Commit after every task. Git only as plain single commands from the worktree root (no `cd`, no `&&` between git commands, no `-C`).
- Never write a `\uXXXX` escape inside a tool parameter; the editing tools decode it into the raw character. Use `\x` escapes or named escapes.
- Changeset `.changeset/p2-http.md` (Task 7): `@anyonce/core: minor`, `@anyonce/hono: minor`, `@anyonce/conformance: minor`.

## Decisions taken in this plan (not spec changes)

- REQ-HTTP-2 "multiple header values yield 400 invalid-key" needs no special code in TypeScript: `Headers.get` joins repeated fields with a comma and a space, so the joined value fails `parseKey` (a space is not allowed in a bare token and a second quoted string is trailing garbage for an sf-string). Task 4 proves it with a test. Go checks `len(h.Values(name)) > 1` explicitly.
- REQ-HTTP-5 "500 configuration error": `requirePrincipal: true` without a `principal` function throws at construction (`resolveHttpOptions`, Go `New` panics); a principal function that returns nothing at request time yields 500 `missing-principal` (Q18).
- REQ-HTTP-6 body handling in TypeScript: the bridge reads `req.clone()` for the fingerprint and hands the original `Request` to the handler untouched, so every framework sees an unread body. Over `maxRequestBytes` the clone read is cancelled and 413 is returned before the handler runs.
- REQ-HTTP-14 in `withIdempotency`: the handler reads `idempotencyOf(req)`; the bridge records the info in a `WeakMap` keyed by the `Request` it hands to the handler. Hono reads `c.get('idempotencyKey')` and `c.get('idempotencyFence')`.
- REQ-HTTP-17 AC (Worker and Lambda examples pass the URL-mode runner): the example directories arrive in P6 (REQ-DOC-7). P2 proves both shapes with harnesses: the suite runs inside workerd through `withIdempotency` (Task 8) and through a local Lambda function URL harness that serves a Lambda-shaped handler over HTTP for the URL-mode runner (Task 6). P6 reuses these harnesses in the examples' smoke tests.
- D21 for `@anyonce/hono`: `@anyonce/core` is a peer dependency (like `hono`), so the package ships with zero `dependencies`.
- Go default scope has no route pattern: `httpmw` wraps the mux, so `r.Pattern` is empty when the middleware runs; the default is `METHOD path` and `Options.Scope` can supply a pattern. Documented on `Options`.
- Go runner target: an `http.Handler` is served by `httptest.NewServer` for the run, so concurrency and streaming behave as over the wire; a `string` is used as a base URL.

## File Structure

```
packages/core/package.json                 add the "./http" export and the http tsup entry; devDependencies on @anyonce/conformance and @anyonce/fixture-hono for the suite tests
packages/core/src/http/problems.ts         ProblemCode, Problem, PROBLEM_STATUS, PROBLEM_TITLE, DEFAULT_PROBLEM_BASE_URI, problem, problemResponse
packages/core/src/http/options.ts          HttpIdempotencyOptions, ResolvedHttpOptions, defaults, resolveHttpOptions
packages/core/src/http/request.ts          lookupKey, requestPath, defaultScope, resolveScope, readBody, requestFingerprint
packages/core/src/http/capture.ts          storedHeaders, captureResponse (streaming copy), replayResponse
packages/core/src/http/run.ts              IdempotencyInfo, idempotencyOf, runIdempotent
packages/core/src/http/index.ts            withIdempotency and the public re-exports of the subpath
packages/core/src/engine.ts                run(fence) (one line change plus doc)
packages/core/test/http/*.test.ts          problems, options, request, capture, run, conformance, streaming, lambda-harness
packages/core/test/package.test.ts         REQ-CORE-7 root entry never imports ./http
packages/core/test/size.test.ts            REQ-REL-5 http subpath budget
packages/hono/package.json                 @anyonce/hono, peers hono >= 4 and @anyonce/core
packages/hono/src/index.ts                 idempotency(options), IdempotencyEnv, re-exports
packages/hono/test/*.test.ts               middleware, conformance, typing, imports
packages/conformance/src/report.ts         ReportFormat, formatReport (json, markdown, junit)
packages/conformance/src/conformance.ts    runConformance
packages/conformance/src/runtime.ts        subpath entry with no node: imports (run, expect, report, target, types)
packages/conformance/src/cli.ts            bin anyonce-conformance
packages/conformance/test/*.test.ts        report, conformance, cli, cli-go
conformance/fixtures/hono/src/app.ts       createFixtureApp(state, layer) plus a build script
conformance/README.md                      CLI, report formats, Go runner
docs/problems.md                           REQ-DOC-4
docs/superpowers/questions.md              Q18
scripts/size.ts                            @anyonce/core/http budget line (16384)
test/workers/http.test.ts                  suite inside workerd through withIdempotency and the Hono middleware
test/node/http.test.mjs                    suite under node --test through the built dist
test/deno/deno.json, test/deno/http_test.ts  suite under deno test through the built dist
.github/workflows/ci.yml                   deno job; node-compat and workers additions
go/anyonce/engine.go                       run(ctx, fence)
go/httpmw/options.go                       Options, FingerprintMode, withDefaults
go/httpmw/problems.go                      Code, Problem, NewProblem, WriteProblem
go/httpmw/request.go                       lookupKey, requestPath, resolveScope, readBody, fingerprint
go/httpmw/context.go                       KeyFromContext, FenceFromContext
go/httpmw/writer.go                        captureWriter (Flush, Hijack, Unwrap)
go/httpmw/middleware.go                    Middleware, New, Handler, writeReplay
go/httpmw/*_test.go                        unit tests, streaming proof, conformance_test.go
go/conformance/vector.go                   Vector, Step, StepRequest, StepExpect, HeaderExpectation, BodyEquals
go/conformance/load.go                     LoadVectors, DefaultVectorsDir
go/conformance/expect.go                   evaluate
go/conformance/run.go                      Options, Summary, VectorResult, StepOutcome, RunVectors
go/conformance/report.go                   Format
go/conformance/testing.go                  Run(t, target, opts)
go/conformance/*_test.go                   loader, evaluator, runner, report, testing tests
go/cmd/fixture/main.go                     -idempotent and -ttl-ms flags
package.json                               scripts: conformance, test:node, test:deno; test:reqs phase p2
.changeset/p2-http.md
```

---

### Task 1: `@anyonce/core/http` scaffold, problem details, docs/problems.md, size budget (REQ-HTTP-13, REQ-DOC-4, REQ-REL-5, REQ-CORE-7)

**Files:**
- Create: `packages/core/src/http/problems.ts`, `packages/core/src/http/index.ts` (temporary content, replaced in Task 4), `packages/core/test/http/problems.test.ts`, `docs/problems.md`
- Modify: `packages/core/package.json` (exports, build script), `scripts/size.ts`, `packages/core/test/size.test.ts`, `packages/core/test/package.test.ts`, `docs/superpowers/questions.md` (append Q18)

**Interfaces:**
- Produces: `ProblemCode`, `Problem`, `PROBLEM_STATUS`, `PROBLEM_TITLE`, `DEFAULT_PROBLEM_BASE_URI`, `problem(code, baseUri, detail?)`, `problemResponse(problem, extraHeaders?)` consumed by Tasks 4 and 7.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/http/problems.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_STATUS,
  problem,
  problemResponse,
} from '../../src/http/problems';

describe('problem details', () => {
  test('REQ-HTTP-13: every code maps to its D11 status', () => {
    expect(PROBLEM_STATUS).toEqual({
      'missing-key': 400,
      'invalid-key': 400,
      conflict: 409,
      'fingerprint-mismatch': 422,
      'payload-too-large': 413,
      'store-unavailable': 503,
      'missing-principal': 500,
    });
  });

  test('REQ-HTTP-13: problem builds type from the base URI and the code', () => {
    const p = problem('conflict', DEFAULT_PROBLEM_BASE_URI);
    expect(p).toEqual({
      type: 'https://in8.sh/anyonce/problems/conflict',
      title: 'A request with this Idempotency-Key is still in progress',
      status: 409,
      code: 'conflict',
    });
    expect(problem('invalid-key', 'https://example.test/p/', 'key is empty').detail).toBe(
      'key is empty',
    );
  });

  test('REQ-HTTP-13: problemResponse is application/problem+json with the members and extra headers', async () => {
    const res = problemResponse(problem('missing-key', DEFAULT_PROBLEM_BASE_URI), [
      ['Link', '<https://docs.test/keys>; rel="describedby"'],
    ]);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Link')).toBe('<https://docs.test/keys>; rel="describedby"');
    expect(await res.json()).toEqual({
      type: 'https://in8.sh/anyonce/problems/missing-key',
      title: 'The Idempotency-Key header is required for this request',
      status: 400,
      code: 'missing-key',
    });
  });
});
```

Append to `packages/core/test/size.test.ts` inside its existing `describe`:

```ts
  test('REQ-REL-5: the http subpath entry is under 16384 bytes gzip', async () => {
    const { gzip } = await measureBundle(join(root, 'packages/core/src/http/index.ts'));
    expect(gzip).toBeLessThan(HTTP_BUDGET_BYTES + 1);
    expect(HTTP_BUDGET_BYTES).toBe(16384);
  });
```

(Import `HTTP_BUDGET_BYTES` next to `measureBundle` from `../../../scripts/size`; `root` and `join` already exist in that file.)

Append to `packages/core/test/package.test.ts` inside `describe('package hygiene')`:

```ts
  test('REQ-CORE-7: the root entry never imports the http subpath', async () => {
    const source = readFileSync(join(pkgDir, 'src/index.ts'), 'utf8');
    expect(source).not.toMatch(/from\s*["']\.\/http/);
    const result = await Bun.build({
      entrypoints: [join(pkgDir, 'src/index.ts')],
      target: 'browser',
      minify: false,
    });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toContain('withIdempotency');
    expect(text).not.toContain('application/problem+json');
  });

  test('REQ-CORE-7: package.json exports the http subpath with types first', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(Object.keys(pkg.exports['./http'] as object)).toEqual(['types', 'import', 'require']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/problems.test.ts packages/core/test/size.test.ts packages/core/test/package.test.ts`
Expected: FAIL (module `../../src/http/problems` not found; `HTTP_BUDGET_BYTES` not exported; `./http` export missing).

- [ ] **Step 3: Implement problems.ts**

`packages/core/src/http/problems.ts`:

```ts
/** D11 problem codes. missing-principal is the Q18 addition for REQ-HTTP-5. */
export type ProblemCode =
  | 'missing-key'
  | 'invalid-key'
  | 'conflict'
  | 'fingerprint-mismatch'
  | 'payload-too-large'
  | 'store-unavailable'
  | 'missing-principal';

/** RFC 9457 problem details with the anyonce code member (D10). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: ProblemCode;
}

export const DEFAULT_PROBLEM_BASE_URI = 'https://in8.sh/anyonce/problems/';

export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  'missing-key': 400,
  'invalid-key': 400,
  conflict: 409,
  'fingerprint-mismatch': 422,
  'payload-too-large': 413,
  'store-unavailable': 503,
  'missing-principal': 500,
};

export const PROBLEM_TITLE: Record<ProblemCode, string> = {
  'missing-key': 'The Idempotency-Key header is required for this request',
  'invalid-key': 'The Idempotency-Key header value is not a valid key',
  conflict: 'A request with this Idempotency-Key is still in progress',
  'fingerprint-mismatch': 'This Idempotency-Key was already used with a different request payload',
  'payload-too-large': 'The request body exceeds the size this idempotent endpoint accepts',
  'store-unavailable': 'The idempotency store is unavailable',
  'missing-principal': 'The idempotency scope requires a principal and none was found',
};

export function problem(code: ProblemCode, baseUri: string, detail?: string): Problem {
  const out: Problem = {
    type: `${baseUri}${code}`,
    title: PROBLEM_TITLE[code],
    status: PROBLEM_STATUS[code],
    code,
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

/** Serializes a problem as application/problem+json. Extra headers (Link, Retry-After) are set, not appended. */
export function problemResponse(p: Problem, extraHeaders: [string, string][] = []): Response {
  const headers = new Headers({
    'Content-Type': 'application/problem+json',
    'Cache-Control': 'no-store',
  });
  for (const [name, value] of extraHeaders) headers.set(name, value);
  return new Response(JSON.stringify(p), { status: p.status, headers });
}
```

`packages/core/src/http/index.ts` (temporary; Task 4 replaces it):

```ts
export type { Problem, ProblemCode } from './problems';
export {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_STATUS,
  PROBLEM_TITLE,
  problem,
  problemResponse,
} from './problems';
```

- [ ] **Step 4: Wire the subpath, the build and the budget**

`packages/core/package.json`: add after the `./testing` export block:

```json
    "./http": {
      "types": "./dist/http/index.d.ts",
      "import": "./dist/http/index.js",
      "require": "./dist/http/index.cjs"
    }
```

and change the build script to `tsup src/index.ts src/testing/index.ts src/http/index.ts --format esm,cjs --dts --clean`.

`scripts/size.ts`: add `export const HTTP_BUDGET_BYTES = 16384;` under `CORE_BUDGET_BYTES` and a second budget:

```ts
  { name: '@anyonce/core/http', entry: 'packages/core/src/http/index.ts', limit: HTTP_BUDGET_BYTES },
```

- [ ] **Step 5: Write docs/problems.md**

`docs/problems.md`:

```markdown
# Problem types

Every error anyonce returns over HTTP is an RFC 9457 problem details document with `Content-Type: application/problem+json`, the standard `type`, `title` and `status` members, an optional `detail`, and a stable `code` member (D10, D11). `type` is `problemBaseUri` followed by `code`; the base URI defaults to `https://in8.sh/anyonce/problems/` and is configurable per adapter. The `detail` member never contains the idempotency key.

| Code | Status | When | Extra headers |
|---|---|---|---|
| `missing-key` | 400 | The header is absent and the endpoint requires it (`required: true`) | `Link: <docsUrl>; rel="describedby"` |
| `invalid-key` | 400 | The header value is not a valid key: empty, longer than 255 bytes, outside printable ASCII, not an sf-string in strict mode, or the header field is repeated | none |
| `conflict` | 409 | A request with the same key and scope is still in flight | `Retry-After: <seconds until the lease expires, at least 1>` |
| `fingerprint-mismatch` | 422 | The key was already used in this scope with a different payload | none |
| `payload-too-large` | 413 | The request body exceeds `maxRequestBytes` (default 1 MiB) | none |
| `store-unavailable` | 503 | The store failed and the adapter runs fail-closed (D13) | `Retry-After: 1` |
| `missing-principal` | 500 | `requirePrincipal` is set and the principal function returned nothing for this request (Q18) | none |

## Example bodies

`missing-key`

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-key",
  "title": "The Idempotency-Key header is required for this request",
  "status": 400,
  "code": "missing-key"
}
```

`invalid-key`

```json
{
  "type": "https://in8.sh/anyonce/problems/invalid-key",
  "title": "The Idempotency-Key header value is not a valid key",
  "status": 400,
  "detail": "key exceeds 255 bytes",
  "code": "invalid-key"
}
```

`conflict`

```json
{
  "type": "https://in8.sh/anyonce/problems/conflict",
  "title": "A request with this Idempotency-Key is still in progress",
  "status": 409,
  "code": "conflict"
}
```

`fingerprint-mismatch`

```json
{
  "type": "https://in8.sh/anyonce/problems/fingerprint-mismatch",
  "title": "This Idempotency-Key was already used with a different request payload",
  "status": 422,
  "code": "fingerprint-mismatch"
}
```

`payload-too-large`

```json
{
  "type": "https://in8.sh/anyonce/problems/payload-too-large",
  "title": "The request body exceeds the size this idempotent endpoint accepts",
  "status": 413,
  "code": "payload-too-large"
}
```

`store-unavailable`

```json
{
  "type": "https://in8.sh/anyonce/problems/store-unavailable",
  "title": "The idempotency store is unavailable",
  "status": 503,
  "code": "store-unavailable"
}
```

`missing-principal`

```json
{
  "type": "https://in8.sh/anyonce/problems/missing-principal",
  "title": "The idempotency scope requires a principal and none was found",
  "status": 500,
  "code": "missing-principal"
}
```

## Overriding

Both adapters accept `onError(problem, request)` returning a `Response` (TypeScript) or `OnError(w, r, problem)` (Go) to render problems differently, for example to translate titles. The status and code must not change; the conformance suite's profile tier checks the media type and the code member.
```

- [ ] **Step 6: Append Q18 to questions.md**

Append after Q17 in `docs/superpowers/questions.md`:

```markdown
## Q18: REQ-HTTP-5 needs a problem code that D11 does not list

REQ-HTTP-5 says a missing principal under `requirePrincipal` is a 500 configuration error, and REQ-HTTP-13 says every error is a problem details document with a stable code, but D11's code list has no entry for it.

Recommended resolution: add `missing-principal` (500) to the D11 list and to `docs/problems.md`. A `requirePrincipal: true` configuration without a `principal` function fails at construction (`resolveHttpOptions` throws, Go `httpmw.New` panics), which is the "startup-time check where possible" half of the requirement; the request-time half returns the new problem.

**Decision: pending.** P2 proceeds on the recommendation.
```

- [ ] **Step 7: Run the tests, lint, build and size**

Run: `bun test packages/core/test/http/problems.test.ts packages/core/test/size.test.ts packages/core/test/package.test.ts`
Expected: PASS.

Run: `bun run lint`, `bun run build`, `bun run size`
Expected: lint clean; six `Build success` lines plus the new http entry; the size table shows both `@anyonce/core` (under 8192) and `@anyonce/core/http` (under 16384) with `ok`.

- [ ] **Step 8: Commit**

```bash
git add packages/core scripts/size.ts docs/problems.md docs/superpowers/questions.md
git commit -m "feat(core): REQ-HTTP-13 problem details and the @anyonce/core/http subpath with its size budget"
```

---

### Task 2: Options and request-side helpers (REQ-HTTP-1..6, REQ-HTTP-8, REQ-HTTP-15 defaults)

**Files:**
- Create: `packages/core/src/http/options.ts`, `packages/core/src/http/request.ts`, `packages/core/test/http/options.test.ts`, `packages/core/test/http/request.test.ts`

**Interfaces:**
- Consumes: `parseKey`, `KeySyntax` from `../key`; `httpFingerprint`, `sha256Hex` from `../fingerprint`; `canonicalize` from `../jcs`; `ExecutePolicy`, `defaultPolicy`, `ExecuteHooks` from `../engine`; `Store`, `StoredResult` from `../types`; `Problem`, `DEFAULT_PROBLEM_BASE_URI` from `./problems`.
- Produces: `HttpIdempotencyOptions`, `ResolvedHttpOptions`, `FingerprintMode`, `FingerprintFn`, `DEFAULT_METHODS`, `DEFAULT_HEADER_NAME`, `DEFAULT_MAX_REQUEST_BYTES`, `DEFAULT_STORED_HEADERS`, `resolveHttpOptions(options)`; `lookupKey(headers, headerName, syntax)`, `requestPath(req)`, `defaultScope(req)`, `resolveScope(req, options, routeScope?)`, `readBody(req, maxBytes)`, `requestFingerprint(req, body, mode)`. Task 4 consumes all of them.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/http/options.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../../src/memory';
import {
  DEFAULT_HEADER_NAME,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_METHODS,
  DEFAULT_STORED_HEADERS,
  resolveHttpOptions,
} from '../../src/http/options';

describe('resolveHttpOptions', () => {
  const store = new MemoryStore();

  test('REQ-HTTP-1: the default methods are POST and PATCH, matched case-insensitively', () => {
    expect(DEFAULT_METHODS).toEqual(['POST', 'PATCH']);
    const resolved = resolveHttpOptions({ store, methods: ['put', 'Delete'] });
    expect([...resolved.methods]).toEqual(['PUT', 'DELETE']);
    expect([...resolveHttpOptions({ store }).methods]).toEqual(['POST', 'PATCH']);
  });

  test('REQ-HTTP-2: the header name defaults to Idempotency-Key', () => {
    expect(DEFAULT_HEADER_NAME).toBe('Idempotency-Key');
    expect(resolveHttpOptions({ store }).headerName).toBe('Idempotency-Key');
    expect(resolveHttpOptions({ store, headerName: 'X-Request-Key' }).headerName).toBe(
      'X-Request-Key',
    );
  });

  test('REQ-HTTP-3: required defaults to false', () => {
    expect(resolveHttpOptions({ store }).required).toBe(false);
  });

  test('REQ-HTTP-4: key syntax defaults to lenient', () => {
    expect(resolveHttpOptions({ store }).keySyntax).toBe('lenient');
    expect(resolveHttpOptions({ store, keySyntax: 'strict' }).keySyntax).toBe('strict');
  });

  test('REQ-HTTP-5: requirePrincipal without a principal function throws at construction', () => {
    expect(() => resolveHttpOptions({ store, requirePrincipal: true })).toThrow(
      /requirePrincipal/,
    );
    expect(
      resolveHttpOptions({ store, requirePrincipal: true, principal: () => 'p' }).requirePrincipal,
    ).toBe(true);
  });

  test('REQ-HTTP-6: fingerprint defaults to body and maxRequestBytes to 1 MiB', () => {
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(1_048_576);
    const resolved = resolveHttpOptions({ store });
    expect(resolved.fingerprint).toBe('body');
    expect(resolved.maxRequestBytes).toBe(1_048_576);
  });

  test('REQ-HTTP-8: the stored header allowlist defaults to five headers, lowercased', () => {
    expect(DEFAULT_STORED_HEADERS).toEqual([
      'Content-Type',
      'Content-Language',
      'Location',
      'ETag',
      'Link',
    ]);
    expect([...resolveHttpOptions({ store }).storeHeaders]).toEqual([
      'content-type',
      'content-language',
      'location',
      'etag',
      'link',
    ]);
    expect([...resolveHttpOptions({ store, storeHeaders: ['X-Trace'] }).storeHeaders]).toEqual([
      'x-trace',
    ]);
  });

  test('REQ-HTTP-13: the problem base URI and docs URL have D11 defaults', () => {
    const resolved = resolveHttpOptions({ store });
    expect(resolved.problemBaseUri).toBe('https://in8.sh/anyonce/problems/');
    expect(resolved.docsUrl).toBe('https://in8.sh/anyonce/problems/missing-key');
    expect(resolveHttpOptions({ store, problemBaseUri: 'https://p.test/' }).docsUrl).toBe(
      'https://p.test/missing-key',
    );
  });

  test('REQ-HTTP-12: engine policy fields flow into the policy with 3.3 defaults', () => {
    const hooks = {};
    const resolved = resolveHttpOptions({ store, ttlMs: 2000, onStoreError: 'fail-open', hooks });
    expect(resolved.policy.ttlMs).toBe(2000);
    expect(resolved.policy.leaseMs).toBe(30_000);
    expect(resolved.policy.maxResultBytes).toBe(1_048_576);
    expect(resolved.policy.onStoreError).toBe('fail-open');
    expect(resolved.policy.hooks).toBe(hooks);
    expect(resolveHttpOptions({ store }).policy.onStoreError).toBe('fail-closed');
  });
});
```

`packages/core/test/http/request.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { httpFingerprint, jcsFingerprint, sha256Hex } from '../../src/fingerprint';
import { resolveHttpOptions } from '../../src/http/options';
import {
  defaultScope,
  lookupKey,
  readBody,
  requestFingerprint,
  requestPath,
  resolveScope,
} from '../../src/http/request';
import { MemoryStore } from '../../src/memory';

const store = new MemoryStore();
const enc = new TextEncoder();

function post(path: string, body?: string, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = body;
  return new Request(`http://t.invalid${path}`, init);
}

describe('lookupKey', () => {
  test('REQ-HTTP-2: the header name is matched case-insensitively', () => {
    const headers = new Headers({ 'idempotency-key': 'abc' });
    expect(lookupKey(headers, 'Idempotency-Key', 'lenient')).toEqual({ kind: 'ok', key: 'abc' });
    expect(lookupKey(new Headers(), 'Idempotency-Key', 'lenient')).toEqual({ kind: 'missing' });
  });

  test('REQ-HTTP-2: a repeated header field is invalid because the joined value is not a key', () => {
    const headers = new Headers();
    headers.append('Idempotency-Key', 'one');
    headers.append('Idempotency-Key', 'two');
    const result = lookupKey(headers, 'Idempotency-Key', 'lenient');
    expect(result.kind).toBe('invalid');
    const quoted = new Headers();
    quoted.append('Idempotency-Key', '"one"');
    quoted.append('Idempotency-Key', '"two"');
    expect(lookupKey(quoted, 'Idempotency-Key', 'strict').kind).toBe('invalid');
  });

  test('REQ-HTTP-4: strict syntax rejects a bare token and lenient accepts it', () => {
    const headers = new Headers({ 'Idempotency-Key': 'bare-token' });
    expect(lookupKey(headers, 'Idempotency-Key', 'strict').kind).toBe('invalid');
    expect(lookupKey(headers, 'Idempotency-Key', 'lenient')).toEqual({
      kind: 'ok',
      key: 'bare-token',
    });
    expect(
      lookupKey(new Headers({ 'Idempotency-Key': '"quoted key"' }), 'Idempotency-Key', 'strict'),
    ).toEqual({ kind: 'ok', key: 'quoted key' });
  });

  test('REQ-HTTP-2: the invalid reason never contains the key value', () => {
    const headers = new Headers({ 'Idempotency-Key': 'has space inside' });
    const result = lookupKey(headers, 'Idempotency-Key', 'lenient');
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).not.toContain('has space');
  });
});

describe('scope', () => {
  test('REQ-HTTP-5: the default scope is METHOD and pathname without the query', () => {
    expect(defaultScope(post('/orders?x=1'))).toBe('POST /orders');
    expect(requestPath(post('/orders?x=1'))).toBe('/orders?x=1');
  });

  test('REQ-HTTP-5: a route scope wins over the pathname and a scope option wins over both', () => {
    const plain = resolveHttpOptions({ store });
    expect(resolveScope(post('/orders/42'), plain, 'POST /orders/:id')).toEqual({
      ok: true,
      scope: 'POST /orders/:id',
    });
    const custom = resolveHttpOptions({ store, scope: () => 'custom' });
    expect(resolveScope(post('/orders/42'), custom, 'POST /orders/:id')).toEqual({
      ok: true,
      scope: 'custom',
    });
  });

  test('REQ-HTTP-5: a principal is appended after a hash and a missing one is a 500 only when required', () => {
    const withPrincipal = resolveHttpOptions({
      store,
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
    });
    expect(resolveScope(post('/p', 'b', { 'x-tenant': 'acme' }), withPrincipal)).toEqual({
      ok: true,
      scope: 'POST /p#acme',
    });
    expect(resolveScope(post('/p'), withPrincipal)).toEqual({ ok: true, scope: 'POST /p' });
    const required = resolveHttpOptions({
      store,
      requirePrincipal: true,
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
    });
    expect(resolveScope(post('/p'), required)).toEqual({ ok: false, code: 'missing-principal' });
  });
});

describe('readBody', () => {
  test('REQ-HTTP-6: reads the body once and leaves the original request readable', async () => {
    const req = post('/p', 'payload');
    const read = await readBody(req, 1024);
    expect(read).toEqual({ ok: true, body: enc.encode('payload') });
    expect(await req.text()).toBe('payload');
  });

  test('REQ-HTTP-6: a body over maxRequestBytes is rejected before the handler sees it', async () => {
    const declared = post('/p', 'x'.repeat(10), { 'content-length': '10' });
    expect(await readBody(declared, 9)).toEqual({ ok: false, code: 'payload-too-large' });
    const undeclared = new Request('http://t.invalid/p', {
      method: 'POST',
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('12345'));
          c.enqueue(enc.encode('67890'));
          c.close();
        },
      }),
      // @ts-expect-error duplex is required for stream bodies in Node and Bun but is not in lib.dom
      duplex: 'half',
    });
    expect(await readBody(undeclared, 9)).toEqual({ ok: false, code: 'payload-too-large' });
  });

  test('REQ-HTTP-6: a request without a body reads as zero bytes', async () => {
    expect(await readBody(post('/p'), 10)).toEqual({ ok: true, body: new Uint8Array(0) });
  });
});

describe('requestFingerprint', () => {
  test('REQ-HTTP-6: body mode is httpFingerprint over method, path with query and bytes', async () => {
    const req = post('/orders?x=1', 'abc');
    expect(await requestFingerprint(req, enc.encode('abc'), 'body')).toBe(
      await httpFingerprint('POST', '/orders?x=1', enc.encode('abc')),
    );
  });

  test('REQ-HTTP-6: jcs mode gives one fingerprint for two spellings of the same JSON', async () => {
    const a = await requestFingerprint(post('/p'), enc.encode('{"a":1,"b":[1,2]}'), 'jcs');
    const b = await requestFingerprint(post('/p'), enc.encode(' { "b" : [1, 2], "a" : 1 } '), 'jcs');
    expect(a).toBe(b);
    const expected = await sha256Hex(enc.encode(`POST\n/p\n{"a":1,"b":[1,2]}`));
    expect(a).toBe(expected);
    expect(a).not.toBe(await jcsFingerprint({ a: 1, b: [1, 2] }));
  });

  test('REQ-HTTP-6: jcs mode falls back to the byte form when the body is not JSON', async () => {
    const body = enc.encode('not json');
    expect(await requestFingerprint(post('/p'), body, 'jcs')).toBe(
      await httpFingerprint('POST', '/p', body),
    );
  });

  test('REQ-HTTP-6: a custom function receives the request and the bytes', async () => {
    const custom = await requestFingerprint(
      post('/p', 'abc', { 'x-v': '2' }),
      enc.encode('abc'),
      async (req, body) => `${req.headers.get('x-v')}:${body.byteLength}`,
    );
    expect(custom).toBe('2:3');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/options.test.ts packages/core/test/http/request.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement options.ts**

```ts
import { defaultPolicy, type ExecuteHooks, type ExecutePolicy } from '../engine';
import type { KeySyntax } from '../key';
import type { Store, StoredResult } from '../types';
import { DEFAULT_PROBLEM_BASE_URI, type Problem } from './problems';

export type FingerprintMode = 'body' | 'jcs';
export type FingerprintFn = (req: Request, body: Uint8Array) => Promise<string> | string;

export const DEFAULT_METHODS = ['POST', 'PATCH'];
export const DEFAULT_HEADER_NAME = 'Idempotency-Key';
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
export const DEFAULT_STORED_HEADERS = ['Content-Type', 'Content-Language', 'Location', 'ETag', 'Link'];

/** Options for withIdempotency and the framework bindings (requirements 4.4). */
export interface HttpIdempotencyOptions {
  store: Store;
  /** REQ-HTTP-1: methods the layer applies to; others pass through. Default POST and PATCH. */
  methods?: string[];
  /** REQ-HTTP-2: header name, matched case-insensitively. Default Idempotency-Key. */
  headerName?: string;
  /** REQ-HTTP-3: a missing header is 400 missing-key when true, pass-through when false. Default false. */
  required?: boolean;
  /** REQ-HTTP-4 and D7. Default lenient. */
  keySyntax?: KeySyntax;
  /** REQ-HTTP-5: replaces the default scope of METHOD plus route pattern or pathname. */
  scope?: (req: Request) => string;
  /** REQ-HTTP-5: appended to the scope after a hash. */
  principal?: (req: Request) => string | undefined;
  /** REQ-HTTP-5: a principal function that returns nothing yields 500 missing-principal. Default false. */
  requirePrincipal?: boolean;
  /** REQ-HTTP-6 and D9. Default body. */
  fingerprint?: FingerprintMode | FingerprintFn;
  /** REQ-HTTP-6: larger bodies are 413 payload-too-large. Default 1 MiB. */
  maxRequestBytes?: number;
  /** REQ-HTTP-8: response headers stored and replayed. Set-Cookie is never stored. */
  storeHeaders?: string[];
  leaseMs?: number;
  ttlMs?: number;
  maxResultBytes?: number;
  storeResult?: (result: StoredResult) => boolean;
  onStoreError?: 'fail-closed' | 'fail-open';
  clock?: () => number;
  hooks?: ExecuteHooks;
  hookErrors?: { count: number };
  /** D11. Default https://in8.sh/anyonce/problems/ */
  problemBaseUri?: string;
  /** REQ-HTTP-3: the Link target on a 400 missing-key. Default problemBaseUri plus missing-key. */
  docsUrl?: string;
  /** REQ-HTTP-13: render a problem differently. Status and code must not change. */
  onError?: (problem: Problem, req: Request) => Response | Promise<Response>;
  /** REQ-HTTP-15: per-request opt-out. */
  skip?: (req: Request) => boolean;
}

export interface ResolvedHttpOptions {
  store: Store;
  methods: Set<string>;
  headerName: string;
  required: boolean;
  keySyntax: KeySyntax;
  scope?: (req: Request) => string;
  principal?: (req: Request) => string | undefined;
  requirePrincipal: boolean;
  fingerprint: FingerprintMode | FingerprintFn;
  maxRequestBytes: number;
  storeHeaders: Set<string>;
  policy: ExecutePolicy;
  problemBaseUri: string;
  docsUrl: string;
  onError?: (problem: Problem, req: Request) => Response | Promise<Response>;
  skip?: (req: Request) => boolean;
}

export function resolveHttpOptions(options: HttpIdempotencyOptions): ResolvedHttpOptions {
  if (options.requirePrincipal === true && options.principal === undefined) {
    throw new TypeError('anyonce: requirePrincipal is true but no principal function was given');
  }
  const policyOverrides: Partial<ExecutePolicy> = {};
  if (options.leaseMs !== undefined) policyOverrides.leaseMs = options.leaseMs;
  if (options.ttlMs !== undefined) policyOverrides.ttlMs = options.ttlMs;
  if (options.maxResultBytes !== undefined) policyOverrides.maxResultBytes = options.maxResultBytes;
  if (options.storeResult !== undefined) policyOverrides.storeResult = options.storeResult;
  if (options.onStoreError !== undefined) policyOverrides.onStoreError = options.onStoreError;
  if (options.clock !== undefined) policyOverrides.clock = options.clock;
  if (options.hooks !== undefined) policyOverrides.hooks = options.hooks;
  if (options.hookErrors !== undefined) policyOverrides.hookErrors = options.hookErrors;
  const problemBaseUri = options.problemBaseUri ?? DEFAULT_PROBLEM_BASE_URI;
  const resolved: ResolvedHttpOptions = {
    store: options.store,
    methods: new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase())),
    headerName: options.headerName ?? DEFAULT_HEADER_NAME,
    required: options.required ?? false,
    keySyntax: options.keySyntax ?? 'lenient',
    requirePrincipal: options.requirePrincipal ?? false,
    fingerprint: options.fingerprint ?? 'body',
    maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    storeHeaders: new Set((options.storeHeaders ?? DEFAULT_STORED_HEADERS).map((h) => h.toLowerCase())),
    policy: defaultPolicy(policyOverrides),
    problemBaseUri,
    docsUrl: options.docsUrl ?? `${problemBaseUri}missing-key`,
  };
  if (options.scope !== undefined) resolved.scope = options.scope;
  if (options.principal !== undefined) resolved.principal = options.principal;
  if (options.onError !== undefined) resolved.onError = options.onError;
  if (options.skip !== undefined) resolved.skip = options.skip;
  return resolved;
}
```

- [ ] **Step 4: Implement request.ts**

```ts
import { httpFingerprint, sha256Hex } from '../fingerprint';
import { canonicalize } from '../jcs';
import { type KeySyntax, parseKey } from '../key';
import type { FingerprintFn, FingerprintMode, ResolvedHttpOptions } from './options';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type KeyLookup =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; key: string };

/**
 * REQ-HTTP-2. Headers.get is case-insensitive and joins repeated fields with a comma and a space, so a repeated
 * header fails parseKey on its own (a bare token cannot contain a space; a second quoted string is trailing data).
 */
export function lookupKey(headers: Headers, headerName: string, syntax: KeySyntax): KeyLookup {
  const raw = headers.get(headerName);
  if (raw === null) return { kind: 'missing' };
  const parsed = parseKey(raw, syntax);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  return { kind: 'ok', key: parsed.key };
}

/** D9: the path hashed into the fingerprint is pathname plus search. */
export function requestPath(req: Request): string {
  const url = new URL(req.url);
  return url.pathname + url.search;
}

/** D8 default when no router pattern is available. */
export function defaultScope(req: Request): string {
  return `${req.method.toUpperCase()} ${new URL(req.url).pathname}`;
}

export type ScopeResult = { ok: true; scope: string } | { ok: false; code: 'missing-principal' };

export function resolveScope(
  req: Request,
  options: ResolvedHttpOptions,
  routeScope?: string,
): ScopeResult {
  const base = options.scope !== undefined ? options.scope(req) : (routeScope ?? defaultScope(req));
  if (options.principal === undefined) return { ok: true, scope: base };
  const principal = options.principal(req);
  if (principal === undefined || principal === '') {
    if (options.requirePrincipal) return { ok: false, code: 'missing-principal' };
    return { ok: true, scope: base };
  }
  return { ok: true, scope: `${base}#${principal}` };
}

export type BodyRead = { ok: true; body: Uint8Array } | { ok: false; code: 'payload-too-large' };

/** REQ-HTTP-6: reads a clone so the handler still receives an unread body; stops at maxBytes plus one. */
export async function readBody(req: Request, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, code: 'payload-too-large' };
  const body = req.clone().body;
  if (body === null) return { ok: true, body: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, code: 'payload-too-large' };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: out };
}

/** D9 and REQ-HTTP-6. The jcs mode falls back to the byte form when the body is not JSON. */
export async function requestFingerprint(
  req: Request,
  body: Uint8Array,
  mode: FingerprintMode | FingerprintFn,
): Promise<string> {
  if (typeof mode === 'function') return await mode(req, body);
  const method = req.method.toUpperCase();
  const path = requestPath(req);
  if (mode === 'jcs') {
    let canonical: string | undefined;
    try {
      canonical = canonicalize(JSON.parse(decoder.decode(body)));
    } catch {
      canonical = undefined;
    }
    if (canonical !== undefined) return sha256Hex(encoder.encode(`${method}\n${path}\n${canonical}`));
  }
  return httpFingerprint(method, path, body);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/core/test/http/options.test.ts packages/core/test/http/request.test.ts`
Expected: PASS. If the streamed-body 413 test fails under Bun because `duplex` is rejected, replace that request with `new Request(url, { method: 'POST', body: new Blob([enc.encode('1234567890')]) })` and remove the `@ts-expect-error` line; the declared-length branch still proves the cap.

Run: `bun run lint`, `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/http/options.ts packages/core/src/http/request.ts packages/core/test/http/options.test.ts packages/core/test/http/request.test.ts
git commit -m "feat(core): REQ-HTTP-1..6 http options, key lookup, scope, body read and fingerprint helpers"
```

---

### Task 3: Streaming response capture and replay (REQ-HTTP-7, REQ-HTTP-8, REQ-HTTP-9)

**Files:**
- Create: `packages/core/src/http/capture.ts`, `packages/core/test/http/capture.test.ts`

**Interfaces:**
- Consumes: `StoredResult`, `IdempotencyRecord` from `../types`.
- Produces: `storedHeaders(headers, allow)`, `Capture` (`response`, `stored`, `streaming`, `close()`, `fail(reason)`), `captureResponse(res, allow, maxResultBytes, extraHeaders?)`, `replayResponse(record)`. Task 4 consumes them.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/http/capture.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { captureResponse, replayResponse, storedHeaders } from '../../src/http/capture';
import type { IdempotencyRecord } from '../../src/types';

const enc = new TextEncoder();
const dec = new TextDecoder();
const allow = new Set(['content-type', 'location', 'etag']);

function streamOf(parts: string[], gate?: Promise<void>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const [i, part] of parts.entries()) {
        if (i === 1 && gate) await gate;
        controller.enqueue(enc.encode(part));
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return dec.decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe('storedHeaders', () => {
  test('REQ-HTTP-8: keeps allowlisted headers, lowercased, and never Set-Cookie', () => {
    const headers = new Headers({
      'Content-Type': 'text/plain',
      'X-Other': '1',
      ETag: '"v1"',
      'Set-Cookie': 'a=1',
    });
    expect(storedHeaders(headers, new Set([...allow, 'set-cookie']))).toEqual([
      ['content-type', 'text/plain'],
      ['etag', '"v1"'],
    ]);
  });
});

describe('captureResponse', () => {
  test('REQ-HTTP-7: chunks reach the client before the source finishes and the stored copy has every byte', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const res = new Response(streamOf(['first', 'second'], gate), {
      status: 201,
      headers: { 'Content-Type': 'text/plain', 'X-Other': '1' },
    });
    const capture = captureResponse(res, allow, 1024);
    expect(capture.streaming).toBe(true);
    expect(capture.response.status).toBe(201);
    expect(capture.response.headers.get('X-Other')).toBe('1');
    const reader = (capture.response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('first');
    release();
    const second = await reader.read();
    expect(dec.decode(second.value)).toBe('second');
    const stored = await capture.stored;
    expect(stored).toEqual({
      kind: 'http',
      status: 201,
      headers: [['content-type', 'text/plain']],
      body: enc.encode('firstsecond'),
    });
    let closed = false;
    const pending = reader.read().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    capture.close();
    await pending;
    expect(closed).toBe(true);
  });

  test('REQ-HTTP-7: the stored body stops growing past the cap but stays larger than the cap', async () => {
    const res = new Response(streamOf(['aaaa', 'bbbb', 'cccc', 'dddd']), { status: 200 });
    const capture = captureResponse(res, allow, 5);
    const client = readAll(capture.response.body as ReadableStream<Uint8Array>);
    const stored = await capture.stored;
    capture.close();
    expect(await client).toBe('aaaabbbbccccdddd');
    expect(stored.body?.byteLength).toBe(8);
  });

  test('REQ-HTTP-7: a bodiless response is not streaming and stores zero bytes', async () => {
    const res = new Response(null, { status: 204, headers: { Location: '/x' } });
    const capture = captureResponse(res, allow, 1024);
    expect(capture.streaming).toBe(false);
    expect(capture.response.status).toBe(204);
    expect(await capture.stored).toEqual({
      kind: 'http',
      status: 204,
      headers: [['location', '/x']],
      body: new Uint8Array(0),
    });
  });

  test('REQ-HTTP-12: extra headers are added to the client response only', async () => {
    const res = new Response('x', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    const capture = captureResponse(res, allow, 1024, [['Idempotency-Degraded', 'true']]);
    expect(capture.response.headers.get('Idempotency-Degraded')).toBe('true');
    expect((await capture.stored).headers).toEqual([['content-type', 'text/plain']]);
    capture.close();
  });

  test('REQ-HTTP-7: a failing source rejects stored and errors the client stream', async () => {
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('a'));
          c.error(new Error('boom'));
        },
      }),
    );
    const capture = captureResponse(res, allow, 1024);
    await expect(capture.stored).rejects.toThrow('boom');
    await expect(readAll(capture.response.body as ReadableStream<Uint8Array>)).rejects.toThrow(
      'boom',
    );
  });

  test('REQ-HTTP-7: fail() errors a client stream that is still open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const capture = captureResponse(new Response(streamOf(['a', 'b'], gate)), allow, 1024);
    const client = readAll(capture.response.body as ReadableStream<Uint8Array>);
    capture.fail(new Error('abandoned'));
    release();
    await expect(client).rejects.toThrow('abandoned');
  });
});

describe('replayResponse', () => {
  const base: IdempotencyRecord = {
    scope: 'POST /p',
    key: 'k',
    fingerprint: 'f',
    state: 'completed',
    fence: 1,
    leaseUntil: 0,
    createdAt: 0,
    expiresAt: 10,
  };

  test('REQ-HTTP-9: replays status, stored headers and body and marks Idempotency-Replayed', async () => {
    const res = replayResponse({
      ...base,
      result: { kind: 'http', status: 201, headers: [['content-type', 'text/plain']], body: enc.encode('hi') },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(res.headers.get('Idempotency-Replay')).toBeNull();
    expect(await res.text()).toBe('hi');
  });

  test('REQ-HTTP-9: an omitted result replays status and headers with an empty body and Idempotency-Replay omitted (D12)', async () => {
    const res = replayResponse({
      ...base,
      resultOmitted: true,
      result: { kind: 'http', status: 200, headers: [['content-type', 'application/octet-stream']] },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(res.headers.get('Idempotency-Replay')).toBe('omitted');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test('REQ-HTTP-9: a stored 204 replays without a body', async () => {
    const res = replayResponse({ ...base, result: { kind: 'http', status: 204, body: new Uint8Array(0) } });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/capture.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement capture.ts**

```ts
import type { IdempotencyRecord, StoredResult } from '../types';

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** REQ-HTTP-8: allowlisted names, lowercased by Headers iteration; Set-Cookie is dropped whatever the allowlist says. */
export function storedHeaders(headers: Headers, allow: Set<string>): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    if (allow.has(name)) out.push([name, value]);
  });
  return out;
}

export interface Capture {
  /** The response to hand to the client. Its stream (when streaming) closes only when close() is called. */
  response: Response;
  /** Resolves when the handler's body has been consumed; the body may exceed the cap by up to one chunk. */
  stored: Promise<StoredResult>;
  /** False for a bodiless response: nothing to stream, so the caller releases it after the record settles. */
  streaming: boolean;
  close(): void;
  fail(reason: unknown): void;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * REQ-HTTP-7: streams the handler's body to the client while buffering a copy. Buffering stops once the copy is
 * larger than maxResultBytes (the engine then stores the omitted form), so memory is bounded by the cap plus one
 * chunk. The client stream is closed by the caller, after the record has settled.
 */
export function captureResponse(
  res: Response,
  allow: Set<string>,
  maxResultBytes: number,
  extraHeaders: [string, string][] = [],
): Capture {
  const headers = new Headers(res.headers);
  for (const [name, value] of extraHeaders) headers.set(name, value);
  const base: StoredResult = { kind: 'http', status: res.status, headers: storedHeaders(res.headers, allow) };

  if (res.body === null || NULL_BODY_STATUS.has(res.status)) {
    const stored: StoredResult = { ...base, body: new Uint8Array(0) };
    return {
      response: new Response(null, { status: res.status, statusText: res.statusText, headers }),
      stored: Promise.resolve(stored),
      streaming: false,
      close() {},
      fail() {},
    };
  }

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let clientOpen = true;
  const clientBody = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      clientOpen = false;
    },
  });
  const source = res.body;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overCap = false;

  const stored = (async (): Promise<StoredResult> => {
    const reader = source.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (clientOpen) controller.enqueue(value);
        if (!overCap) {
          chunks.push(value);
          size += value.byteLength;
          if (size > maxResultBytes) overCap = true;
        }
      }
    } catch (error) {
      if (clientOpen) {
        clientOpen = false;
        controller.error(error);
      }
      throw error;
    }
    return { ...base, body: concat(chunks, size) };
  })();

  return {
    response: new Response(clientBody, { status: res.status, statusText: res.statusText, headers }),
    stored,
    streaming: true,
    close() {
      if (!clientOpen) return;
      clientOpen = false;
      controller.close();
    },
    fail(reason) {
      if (!clientOpen) return;
      clientOpen = false;
      controller.error(reason);
    },
  };
}

/** REQ-HTTP-9 and D12. */
export function replayResponse(record: IdempotencyRecord): Response {
  const result = record.result;
  const status = result?.status ?? 200;
  const headers = new Headers(result?.headers ?? []);
  headers.set('Idempotency-Replayed', 'true');
  if (record.resultOmitted === true) headers.set('Idempotency-Replay', 'omitted');
  const body = result?.body;
  const useBody =
    record.resultOmitted !== true &&
    body !== undefined &&
    body.byteLength > 0 &&
    !NULL_BODY_STATUS.has(status);
  return new Response(useBody ? body : null, { status, headers });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/http/capture.test.ts`
Expected: PASS.

Run: `bun run lint`, `bun run typecheck`
Expected: clean. If Biome flags the empty `close() {}` methods, add `// bodiless: nothing to close` comments inside them.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/capture.ts packages/core/test/http/capture.test.ts
git commit -m "feat(core): REQ-HTTP-7 streaming response capture and REQ-HTTP-9 replay"
```

---
### Task 4: The engine bridge, `withIdempotency` and `idempotencyOf` (REQ-HTTP-1..15, REQ-HTTP-17, REQ-CORE-1 fence)

**Files:**
- Create: `packages/core/src/http/run.ts`, `packages/core/test/http/run.test.ts`
- Modify: `packages/core/src/http/index.ts` (final public surface), `packages/core/src/engine.ts` (run receives the fence), `packages/core/test/engine.test.ts` (one test)

**Interfaces:**
- Consumes: everything from Tasks 1 to 3; `execute`, `ExecutePolicy`, `ExecuteHooks` from `../engine`; `Operation` from `../types`.
- Produces: `IdempotencyInfo`, `idempotencyOf(req)`, `IdempotentRun`, `RunContext`, `runIdempotent(req, run, options, ctx?)`, `withIdempotency(handler, options)`. Task 7 (Hono) consumes `runIdempotent`, `resolveHttpOptions` and `RunContext`; Tasks 6 and 8 consume `withIdempotency`.

- [ ] **Step 1: Engine change, test first**

Add to `packages/core/test/engine.test.ts` inside the main `describe` (use the file's existing `store`, `op` and `policy` helpers; adapt names if they differ):

```ts
  test('REQ-CORE-1: run receives the fence of the acquired claim and 0 under fail-open', async () => {
    const store = new MemoryStore();
    const fences: number[] = [];
    const run = async (fence: number) => {
      fences.push(fence);
      return { kind: 'http' as const, status: 200 };
    };
    await execute(store, op, run, defaultPolicy({ clock: () => T0 }));
    const failing = {
      ...store,
      begin: async () => {
        throw new Error('down');
      },
    } as unknown as Store;
    await execute(failing, op, run, defaultPolicy({ clock: () => T0, onStoreError: 'fail-open' }));
    expect(fences).toEqual([1, 0]);
  });
```

Run: `bun test packages/core/test/engine.test.ts`
Expected: FAIL on the new test (`fences` is `[undefined, undefined]`).

In `packages/core/src/engine.ts` change the signature and both call sites:

```ts
export async function execute(
  store: Store,
  op: Operation,
  /** Receives the fence of the acquired claim; 0 when running without a claim under fail-open. */
  run: (fence: number) => Promise<StoredResult>,
  policy: ExecutePolicy,
): Promise<ExecuteResult> {
```

fail-open branch: `return { kind: 'executed', result: await run(0), stored: false };` and the acquired branch: `result = await run(fence);`.

Run: `bun test packages/core/test/engine.test.ts` and `bun run test:coverage`
Expected: PASS; engine.ts stays at 100 percent on every column.

- [ ] **Step 2: Write the failing bridge tests**

`packages/core/test/http/run.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { idempotencyOf, withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';
import type { Store } from '../../src/types';

const enc = new TextEncoder();

function post(path: string, key?: string, body = 'b', extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'text/plain', ...extra };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request(`http://t.invalid${path}`, { method: 'POST', body, headers });
}

function counting(status = 201, headers: Record<string, string> = {}) {
  const state = { calls: 0, bodies: [] as string[] };
  const handler = async (req: Request): Promise<Response> => {
    state.calls += 1;
    state.bodies.push(await req.text());
    return new Response(`r${state.calls}`, { status, headers: { 'Content-Type': 'text/plain', ...headers } });
  };
  return { state, handler };
}

function failingStore(error = new Error('store down')): Store {
  const never = async () => {
    throw error;
  };
  return { begin: never, complete: never, abandon: never, get: never, purge: never };
}

describe('withIdempotency', () => {
  test('REQ-HTTP-1: a GET passes through untouched and a PATCH is covered by default', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    const get = new Request('http://t.invalid/p', { headers: { 'Idempotency-Key': 'k' } });
    await wrapped(get);
    await wrapped(get);
    expect(state.calls).toBe(2);
    const patch = new Request('http://t.invalid/p', { method: 'PATCH', body: 'b', headers: { 'Idempotency-Key': 'k' } });
    await wrapped(patch);
    await wrapped(patch.clone());
    expect(state.calls).toBe(3);
  });

  test('REQ-HTTP-1: methods overrides the default list', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), methods: ['PUT'] });
    await wrapped(post('/p', 'k'));
    await wrapped(post('/p', 'k'));
    expect(state.calls).toBe(2);
    const put = () => new Request('http://t.invalid/p', { method: 'PUT', body: 'b', headers: { 'Idempotency-Key': 'k' } });
    await wrapped(put());
    await wrapped(put());
    expect(state.calls).toBe(3);
  });

  test('REQ-HTTP-2: the header is found case-insensitively and a repeated header is 400 invalid-key', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await wrapped(post('/p', undefined, 'b', { 'idempotency-key': 'k' }));
    const replay = await wrapped(post('/p', 'k'));
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(state.calls).toBe(1);
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    headers.append('Idempotency-Key', 'one');
    headers.append('Idempotency-Key', 'two');
    const res = await wrapped(new Request('http://t.invalid/p', { method: 'POST', body: 'b', headers }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid-key');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-3: a missing key passes through by default and is 400 missing-key with a Link when required', async () => {
    const { state, handler } = counting();
    const lenient = withIdempotency(handler, { store: new MemoryStore() });
    expect((await lenient(post('/p'))).status).toBe(201);
    expect(state.calls).toBe(1);
    const strict = withIdempotency(handler, { store: new MemoryStore(), required: true, docsUrl: 'https://d.test/keys' });
    const res = await strict(post('/p'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect(res.headers.get('Link')).toBe('<https://d.test/keys>; rel="describedby"');
    expect(await res.json()).toEqual({
      type: 'https://in8.sh/anyonce/problems/missing-key',
      title: 'The Idempotency-Key header is required for this request',
      status: 400,
      code: 'missing-key',
    });
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-4: strict syntax rejects a bare token with 400 invalid-key', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), keySyntax: 'strict' });
    expect((await wrapped(post('/p', 'bare'))).status).toBe(400);
    expect((await wrapped(post('/p', '"quoted"'))).status).toBe(201);
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-5: the default scope is method and pathname so the same key on another path executes again', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await wrapped(post('/a?x=1', 'k'));
    await wrapped(post('/a?x=2', 'k'));
    expect(state.calls).toBe(1);
    await wrapped(post('/b', 'k'));
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-5: principals isolate keys and a required principal that is missing is 500 missing-principal', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, {
      store: new MemoryStore(),
      principal: (req) => req.headers.get('x-tenant') ?? undefined,
      requirePrincipal: true,
    });
    await wrapped(post('/p', 'k', 'b', { 'x-tenant': 'a' }));
    await wrapped(post('/p', 'k', 'b', { 'x-tenant': 'b' }));
    expect(state.calls).toBe(2);
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('missing-principal');
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-6: the handler still reads the body, and a body over maxRequestBytes is 413', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), maxRequestBytes: 4 });
    await wrapped(post('/p', 'k', 'abcd'));
    expect(state.bodies).toEqual(['abcd']);
    const res = await wrapped(post('/p', 'k2', 'abcde'));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('payload-too-large');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-6: jcs fingerprinting treats reordered JSON as the same payload', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), fingerprint: 'jcs' });
    await wrapped(post('/p', 'k', '{"a":1,"b":2}'));
    const res = await wrapped(post('/p', 'k', '{"b":2,"a":1}'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-6: a custom fingerprint function decides what counts as the same request', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), fingerprint: async () => 'constant' });
    await wrapped(post('/p', 'k', 'one'));
    await wrapped(post('/p', 'k', 'two'));
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-7: the first request runs the handler and stores the captured response', async () => {
    const store = new MemoryStore();
    const { handler } = counting(201, { ETag: '"v1"', 'X-Other': 'no' });
    const wrapped = withIdempotency(handler, { store });
    const res = await wrapped(post('/p', 'k'));
    expect(await res.text()).toBe('r1');
    const record = await store.get({ scope: 'POST /p', key: 'k' }, Date.now());
    expect(record?.state).toBe('completed');
    expect(record?.result).toEqual({
      kind: 'http',
      status: 201,
      headers: [['content-type', 'text/plain'], ['etag', '"v1"']],
      body: enc.encode('r1'),
    });
  });

  test('REQ-HTTP-8: Set-Cookie is never stored even when allowlisted', async () => {
    const store = new MemoryStore();
    const { handler } = counting(201, { 'Set-Cookie': 'a=1', 'X-Trace': 't' });
    const wrapped = withIdempotency(handler, { store, storeHeaders: ['Set-Cookie', 'X-Trace'] });
    await (await wrapped(post('/p', 'k'))).text();
    const record = await store.get({ scope: 'POST /p', key: 'k' }, Date.now());
    expect(record?.result?.headers).toEqual([['x-trace', 't']]);
  });

  test('REQ-HTTP-9: a completed duplicate replays status, headers and body with Idempotency-Replayed', async () => {
    const { state, handler } = counting(202, { Location: '/orders/1' });
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await (await wrapped(post('/p', 'k'))).text();
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe('/orders/1');
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await res.text()).toBe('r1');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-9: a result over maxResultBytes replays with an empty body and Idempotency-Replay omitted', async () => {
    const { handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), maxResultBytes: 1 });
    expect(await (await wrapped(post('/p', 'k'))).text()).toBe('r1');
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replay')).toBe('omitted');
    expect(await res.text()).toBe('');
  });

  test('REQ-HTTP-10: an in-flight duplicate is 409 conflict with Retry-After from the lease', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const handler = async () => {
      await gate;
      return new Response('done');
    };
    let acquired!: () => void;
    const claimed = new Promise<void>((r) => {
      acquired = r;
    });
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), leaseMs: 30_000, clock: () => now, hooks: { onAcquired: () => acquired() } });
    const first = wrapped(post('/p', 'k'));
    await claimed;
    now += 4_500;
    const dup = await wrapped(post('/p', 'k'));
    expect(dup.status).toBe(409);
    expect(dup.headers.get('Retry-After')).toBe('26');
    expect((await dup.json()).code).toBe('conflict');
    release();
    expect(await (await first).text()).toBe('done');
  });

  test('REQ-HTTP-10: Retry-After is at least 1', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const claimed = new Promise<void>((r) => {
      acquired = r;
    });
    const wrapped = withIdempotency(async () => {
      await gate;
      return new Response('done');
    }, { store: new MemoryStore(), leaseMs: 30_000, clock: () => now, hooks: { onAcquired: () => acquired() } });
    const first = wrapped(post('/p', 'k'));
    await claimed;
    now += 29_999;
    expect((await wrapped(post('/p', 'k'))).headers.get('Retry-After')).toBe('1');
    release();
    await first;
  });

  test('REQ-HTTP-11: the same key with a different body is 422 fingerprint-mismatch and the original still replays', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    await (await wrapped(post('/p', 'k', 'one'))).text();
    const res = await wrapped(post('/p', 'k', 'two'));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('fingerprint-mismatch');
    expect((await wrapped(post('/p', 'k', 'one'))).headers.get('Idempotency-Replayed')).toBe('true');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-12: a failing store is 503 store-unavailable with Retry-After 1 when fail-closed', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: failingStore() });
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect((await res.json()).code).toBe('store-unavailable');
    expect(state.calls).toBe(0);
  });

  test('REQ-HTTP-12: fail-open runs the handler and marks the response Idempotency-Degraded', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: failingStore(), onStoreError: 'fail-open' });
    const res = await wrapped(post('/p', 'k'));
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Degraded')).toBe('true');
    expect(await res.text()).toBe('r1');
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-13: onError renders every problem and problems use the configured base URI', async () => {
    const wrapped = withIdempotency(counting().handler, {
      store: new MemoryStore(),
      required: true,
      problemBaseUri: 'https://p.test/',
      onError: (problem) => new Response(`custom:${problem.code}:${problem.type}`, { status: problem.status }),
    });
    const res = await wrapped(post('/p'));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('custom:missing-key:https://p.test/missing-key');
  });

  test('REQ-HTTP-14: the handler reads the key and fence through idempotencyOf', async () => {
    const seen: Array<{ key: string; fence: number } | undefined> = [];
    const wrapped = withIdempotency(async (req: Request) => {
      seen.push(idempotencyOf(req));
      return new Response('ok');
    }, { store: new MemoryStore() });
    await (await wrapped(post('/p', 'k'))).text();
    await (await wrapped(new Request('http://t.invalid/p'))).text();
    expect(seen).toEqual([{ key: 'k', fence: 1 }, undefined]);
  });

  test('REQ-HTTP-15: skip opts a request out entirely', async () => {
    const { state, handler } = counting();
    const wrapped = withIdempotency(handler, { store: new MemoryStore(), skip: (req) => new URL(req.url).pathname === '/reset' });
    await wrapped(post('/reset', 'k'));
    await wrapped(post('/reset', 'k'));
    expect(state.calls).toBe(2);
  });

  test('REQ-HTTP-17: extra handler arguments pass through and a thrown handler error propagates after abandon', async () => {
    const store = new MemoryStore();
    const seen: unknown[] = [];
    const wrapped = withIdempotency(async (_req: Request, env: { name: string }, ctx: number) => {
      seen.push(env.name, ctx);
      throw new Error('handler failed');
    }, { store });
    await expect(wrapped(post('/p', 'k'), { name: 'env' }, 7)).rejects.toThrow('handler failed');
    expect(seen).toEqual(['env', 7]);
    expect(await store.get({ scope: 'POST /p', key: 'k' }, Date.now())).toBeNull();
  });

  test('REQ-HTTP-7: a 5xx response is not stored (D6) so the retry executes again', async () => {
    const { state, handler } = counting(500);
    const wrapped = withIdempotency(handler, { store: new MemoryStore() });
    expect(await (await wrapped(post('/p', 'k'))).text()).toBe('r1');
    const retry = await wrapped(post('/p', 'k'));
    expect(retry.headers.get('Idempotency-Replayed')).toBeNull();
    expect(await retry.text()).toBe('r2');
    expect(state.calls).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/run.test.ts`
Expected: FAIL (`withIdempotency` is not exported yet).

- [ ] **Step 4: Implement run.ts**

```ts
import { type ExecuteHooks, type ExecutePolicy, execute } from '../engine';
import type { Operation } from '../types';
import { type Capture, captureResponse, replayResponse } from './capture';
import type { ResolvedHttpOptions } from './options';
import { type ProblemCode, problem, problemResponse } from './problems';
import { lookupKey, readBody, requestFingerprint, resolveScope } from './request';

/** REQ-HTTP-14: what a handler can learn about the claim it runs under. */
export interface IdempotencyInfo {
  key: string;
  fence: number;
}

const infoByRequest = new WeakMap<Request, IdempotencyInfo>();

/** REQ-HTTP-14 for withIdempotency: undefined when the request ran outside the layer. */
export function idempotencyOf(req: Request): IdempotencyInfo | undefined {
  return infoByRequest.get(req);
}

export type IdempotentRun = (req: Request, info: IdempotencyInfo | undefined) => Promise<Response>;

export interface RunContext {
  /** A router's scope (METHOD plus pattern); used when the options carry no scope function. */
  routeScope?: string;
}

function retryAfterSeconds(leaseUntil: number, now: number): string {
  return String(Math.max(1, Math.ceil((leaseUntil - now) / 1000)));
}

/**
 * The transport bridge (requirements 4.4). Every framework binding calls this with the raw Request and a run
 * callback that invokes the downstream handler. Returns the response to send, streaming when the handler streams.
 */
export async function runIdempotent(
  req: Request,
  run: IdempotentRun,
  options: ResolvedHttpOptions,
  ctx: RunContext = {},
): Promise<Response> {
  if (!options.methods.has(req.method.toUpperCase())) return run(req, undefined);
  if (options.skip !== undefined && options.skip(req)) return run(req, undefined);

  const fail = async (code: ProblemCode, detail?: string, headers: [string, string][] = []): Promise<Response> => {
    const p = problem(code, options.problemBaseUri, detail);
    if (options.onError !== undefined) return options.onError(p, req);
    return problemResponse(p, headers);
  };

  const lookup = lookupKey(req.headers, options.headerName, options.keySyntax);
  if (lookup.kind === 'missing') {
    if (!options.required) return run(req, undefined);
    return fail('missing-key', undefined, [['Link', `<${options.docsUrl}>; rel="describedby"`]]);
  }
  if (lookup.kind === 'invalid') return fail('invalid-key', lookup.reason);

  const scope = resolveScope(req, options, ctx.routeScope);
  if (!scope.ok) return fail('missing-principal');

  const body = await readBody(req, options.maxRequestBytes);
  if (!body.ok) return fail('payload-too-large');
  const fingerprint = await requestFingerprint(req, body.body, options.fingerprint);
  const op: Operation = { scope: scope.scope, key: lookup.key, fingerprint };

  let degraded = false;
  const userHooks: ExecuteHooks = options.policy.hooks ?? {};
  const policy: ExecutePolicy = {
    ...options.policy,
    hooks: {
      ...userHooks,
      onStoreError(o, error) {
        degraded = true;
        userHooks.onStoreError?.(o, error);
      },
    },
  };
  const now = (): number => (policy.clock ?? Date.now)();

  let capture: Capture | undefined;
  let resolveClient!: (res: Response) => void;
  const client = new Promise<Response>((resolve) => {
    resolveClient = resolve;
  });

  const outcome = execute(
    options.store,
    op,
    async (fence) => {
      const info: IdempotencyInfo = { key: op.key, fence };
      infoByRequest.set(req, info);
      const res = await run(req, info);
      capture = captureResponse(res, options.storeHeaders, policy.maxResultBytes, degraded ? [['Idempotency-Degraded', 'true']] : []);
      if (capture.streaming) resolveClient(capture.response);
      return capture.stored;
    },
    policy,
  );

  const settled: Promise<Response> = outcome.then(
    async (result) => {
      switch (result.kind) {
        case 'executed': {
          const done = capture as Capture;
          done.close();
          resolveClient(done.response);
          return done.response;
        }
        case 'replayed':
          return replayResponse(result.record);
        case 'conflict':
          return fail('conflict', undefined, [['Retry-After', retryAfterSeconds(result.leaseUntil, now())]]);
        case 'mismatch':
          return fail('fingerprint-mismatch');
        case 'store_error':
          return fail('store-unavailable', undefined, [['Retry-After', '1']]);
      }
    },
    (error: unknown) => {
      if (capture !== undefined) {
        capture.fail(error);
        return capture.response;
      }
      throw error;
    },
  );

  return Promise.race([client, settled]);
}
```

Notes for the implementer: `capture` is assigned inside the run callback, which always runs before `executed` resolves, so the cast in the `executed` branch is sound. The race resolves with the client response as soon as the handler starts streaming; `settled` keeps running and closes the stream after `complete` or `abandon`. A handler that throws before producing a response rejects `settled` while `client` is still pending, so the caller sees the rejection.

- [ ] **Step 5: Write the final index.ts**

```ts
import { type HttpIdempotencyOptions, resolveHttpOptions } from './options';
import { runIdempotent } from './run';

export type { Capture } from './capture';
export { captureResponse, replayResponse, storedHeaders } from './capture';
export type {
  FingerprintFn,
  FingerprintMode,
  HttpIdempotencyOptions,
  ResolvedHttpOptions,
} from './options';
export {
  DEFAULT_HEADER_NAME,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_METHODS,
  DEFAULT_STORED_HEADERS,
  resolveHttpOptions,
} from './options';
export type { Problem, ProblemCode } from './problems';
export {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_STATUS,
  PROBLEM_TITLE,
  problem,
  problemResponse,
} from './problems';
export type { BodyRead, KeyLookup, ScopeResult } from './request';
export { defaultScope, lookupKey, readBody, requestFingerprint, requestPath, resolveScope } from './request';
export type { IdempotencyInfo, IdempotentRun, RunContext } from './run';
export { idempotencyOf, runIdempotent } from './run';

export type FetchLikeHandler<Rest extends unknown[]> = (
  req: Request,
  ...rest: Rest
) => Response | Promise<Response>;

/**
 * REQ-HTTP-17: wraps any fetch-shaped handler (Workers, Bun.serve, Deno.serve, Lambda fetch shims). Extra
 * arguments such as env and ctx pass through untouched. The handler reads idempotencyOf(req) for REQ-HTTP-14.
 */
export function withIdempotency<Rest extends unknown[]>(
  handler: FetchLikeHandler<Rest>,
  options: HttpIdempotencyOptions,
): (req: Request, ...rest: Rest) => Promise<Response> {
  const resolved = resolveHttpOptions(options);
  return (req, ...rest) =>
    runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), resolved);
}
```

- [ ] **Step 6: Run the tests, lint, typecheck, size**

Run: `bun test packages/core`
Expected: PASS, including the P1 files.

Run: `bun run lint`, `bun run typecheck`, `bun run size`, `bun run test:coverage`
Expected: clean; `@anyonce/core/http` under 16384; engine.ts still 100 percent.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): REQ-HTTP-1..15 runIdempotent bridge, withIdempotency and idempotencyOf"
```

---

### Task 5: Conformance runner report formats, `runConformance`, the CLI and the fixture layer hook (REQ-CONF-5, REQ-CONF-7)

**Files:**
- Create: `packages/conformance/src/report.ts`, `packages/conformance/src/conformance.ts`, `packages/conformance/src/cli.ts`, `packages/conformance/test/report.test.ts`, `packages/conformance/test/conformance.test.ts`, `packages/conformance/test/cli.test.ts`
- Modify: `packages/conformance/src/index.ts`, `packages/conformance/package.json` (bin, build entries), `conformance/fixtures/hono/src/app.ts` (layer parameter), `conformance/fixtures/hono/package.json` (build script), `conformance/README.md`, root `package.json` (`conformance` script)

**Interfaces:**
- Consumes: `RunSummary`, `VectorResult`, `Target`, `Tier`, `Capability`, `RunOptions`, `runVectors`, `loadVectors` from P0.
- Produces: `ReportFormat`, `formatReport(summary, format, meta?)`, `ConformanceOptions`, `ConformanceResult`, `runConformance(options)`; `createFixtureApp(state?, layer?)`; the `anyonce-conformance` bin. Tasks 6, 7, 8 and 12 consume them.

- [ ] **Step 1: Write the failing tests**

`packages/conformance/test/report.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatReport } from '../src/report';
import type { RunSummary } from '../src/types';

const summary: RunSummary = {
  results: [
    { id: 'core/post-executes-once', tier: 'core', status: 'pass', steps: [{ stepId: 'first', failures: [] }] },
    {
      id: 'core/retry-replays',
      tier: 'core',
      status: 'fail',
      steps: [
        { stepId: 'first', failures: [] },
        { stepId: 'retry', failures: ['status: expected 201, got 409', 'handlerInvocations: expected 1, got 2'] },
      ],
    },
    { id: 'core/expiry-executes-again', tier: 'core', status: 'not-applicable', steps: [], error: 'requires short-ttl' },
    { id: 'profile/replayed-header', tier: 'profile', status: 'error', steps: [], error: 'reset returned 500' },
  ],
  passed: 1,
  failed: 1,
  notApplicable: 1,
  errored: 1,
};

describe('formatReport', () => {
  test('REQ-CONF-5: json is the summary itself plus the target and the time', () => {
    const parsed = JSON.parse(formatReport(summary, 'json', { target: 'http://x', generatedAt: '2026-09-17T00:00:00Z' }));
    expect(parsed.target).toBe('http://x');
    expect(parsed.generatedAt).toBe('2026-09-17T00:00:00Z');
    expect(parsed.passed).toBe(1);
    expect(parsed.results).toHaveLength(4);
  });

  test('REQ-CONF-5: markdown has a summary line and one table row per vector with the failures', () => {
    const md = formatReport(summary, 'markdown', { target: 'http://x' });
    expect(md).toContain('# anyonce conformance report');
    expect(md).toContain('Target: http://x');
    expect(md).toContain('1 passed, 1 failed, 1 not applicable, 1 errored');
    expect(md).toContain('| Vector | Tier | Status | Details |');
    expect(md).toContain('| core/post-executes-once | core | pass |  |');
    expect(md).toContain('| core/retry-replays | core | fail | retry: status: expected 201, got 409; retry: handlerInvocations: expected 1, got 2 |');
    expect(md).toContain('| core/expiry-executes-again | core | not-applicable | requires short-ttl |');
    expect(md).toContain('| profile/replayed-header | profile | error | reset returned 500 |');
  });

  test('REQ-CONF-5: junit has one testcase per vector with failure, skipped and error elements', () => {
    const xml = formatReport(summary, 'junit');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuite name="anyonce-conformance" tests="4" failures="1" errors="1" skipped="1">');
    expect(xml).toContain('<testcase classname="core" name="core/post-executes-once"/>');
    expect(xml).toContain('<testcase classname="core" name="core/retry-replays"><failure message="retry: status: expected 201, got 409; retry: handlerInvocations: expected 1, got 2"/></testcase>');
    expect(xml).toContain('<testcase classname="core" name="core/expiry-executes-again"><skipped message="requires short-ttl"/></testcase>');
    expect(xml).toContain('<testcase classname="profile" name="profile/replayed-header"><error message="reset returned 500"/></testcase>');
  });

  test('REQ-CONF-5: junit escapes XML special characters in messages', () => {
    const xml = formatReport(
      { results: [{ id: 'core/x', tier: 'core', status: 'fail', steps: [{ stepId: 's', failures: ['body: expected "<a&b>"'] }] }], passed: 0, failed: 1, notApplicable: 0, errored: 0 },
      'junit',
    );
    expect(xml).toContain('message="s: body: expected &quot;&lt;a&amp;b&gt;&quot;"');
  });
});
```

`packages/conformance/test/conformance.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { runConformance } from '../src/conformance';
import { BARE_PASS_IDS, CORE_IDS } from './catalog';

describe('runConformance', () => {
  test('REQ-CONF-5: runs the selected tiers against a fetch handler and returns the summary and the report', async () => {
    const app = createFixtureApp();
    const { summary, report } = await runConformance({ target: app.fetch, tiers: ['core'], report: 'markdown' });
    expect(summary.results.map((r) => r.id)).toEqual(CORE_IDS);
    expect(summary.results.find((r) => r.id === 'core/expiry-executes-again')?.status).toBe('not-applicable');
    expect(summary.passed).toBe(BARE_PASS_IDS.filter((id) => id.startsWith("core/") && id !== "core/expiry-executes-again").length);
    expect(report).toContain('# anyonce conformance report');
    expect(report).toContain('Target: in-process fetch handler');
  }, 60_000);

  test('REQ-CONF-5: only narrows the run to the named vectors', async () => {
    const { summary } = await runConformance({ target: createFixtureApp().fetch, only: ['core/post-executes-once'] });
    expect(summary.results.map((r) => r.id)).toEqual(['core/post-executes-once']);
    expect(summary.passed).toBe(1);
  });
});
```

`packages/conformance/test/cli.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFixtureApp } from '@anyonce/fixture-hono';

const cli = join(import.meta.dir, '../src/cli.ts');
let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createFixtureApp().fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe('anyonce-conformance CLI', () => {
  test('REQ-CONF-7: exits 1 with a json report when vectors fail against a bare fixture', async () => {
    const { code, stdout } = await run(['--url', baseUrl, '--tier', 'core', '--report', 'json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.failed).toBeGreaterThan(0);
    expect(parsed.target).toBe(baseUrl);
  }, 60_000);

  test('REQ-CONF-7: exits 0 with markdown when only passing vectors are selected', async () => {
    const { code, stdout } = await run(['--url', baseUrl, '--only', 'core/post-executes-once', '--report', 'markdown']);
    expect(code).toBe(0);
    expect(stdout).toContain('| core/post-executes-once | core | pass |  |');
  }, 60_000);

  test('REQ-CONF-7: declares capabilities, writes --out and rejects a ttl above the short-ttl bound', async () => {
    const out = join(import.meta.dir, '../.cli-out.xml');
    const ok = await run(['--url', baseUrl, '--only', 'core/expiry-executes-again', '--capability', 'short-ttl', '--ttl-ms', '2000', '--report', 'junit', '--out', out]);
    expect(ok.code).toBe(0);
    expect(await Bun.file(out).text()).toContain('<testcase classname="core" name="core/expiry-executes-again"/>');
    const bad = await run(['--url', baseUrl, '--capability', 'short-ttl', '--ttl-ms', '5000']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('short-ttl');
    const noUrl = await run(['--tier', 'core']);
    expect(noUrl.code).toBe(2);
    expect(noUrl.stderr).toContain('--url');
  }, 60_000);
});
```

Add `packages/conformance/.cli-out.xml` to `.gitignore` (root): append the line `packages/conformance/.cli-out.xml`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/conformance/test/report.test.ts packages/conformance/test/conformance.test.ts packages/conformance/test/cli.test.ts`
Expected: FAIL (modules not found; CLI file missing).

- [ ] **Step 3: Implement report.ts**

```ts
import type { RunSummary, VectorResult } from './types';

export type ReportFormat = 'json' | 'markdown' | 'junit';

export interface ReportMeta {
  target?: string;
  generatedAt?: string;
}

function details(result: VectorResult): string {
  if (result.status === 'not-applicable' || result.status === 'error') return result.error ?? '';
  const out: string[] = [];
  for (const step of result.steps) for (const failure of step.failures) out.push(`${step.stepId}: ${failure}`);
  return out.join('; ');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdown(summary: RunSummary, meta: ReportMeta): string {
  const lines = ['# anyonce conformance report', ''];
  if (meta.target !== undefined) lines.push(`Target: ${meta.target}`, '');
  lines.push(
    `${summary.passed} passed, ${summary.failed} failed, ${summary.notApplicable} not applicable, ${summary.errored} errored`,
    '',
    '| Vector | Tier | Status | Details |',
    '|---|---|---|---|',
  );
  for (const result of summary.results) {
    lines.push(`| ${result.id} | ${result.tier} | ${result.status} | ${details(result).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function junit(summary: RunSummary): string {
  const cases = summary.results.map((result) => {
    const open = `<testcase classname="${result.tier}" name="${escapeXml(result.id)}"`;
    const message = escapeXml(details(result));
    switch (result.status) {
      case 'pass':
        return `${open}/>`;
      case 'fail':
        return `${open}><failure message="${message}"/></testcase>`;
      case 'not-applicable':
        return `${open}><skipped message="${message}"/></testcase>`;
      case 'error':
        return `${open}><error message="${message}"/></testcase>`;
    }
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="anyonce-conformance" tests="${summary.results.length}" failures="${summary.failed}" errors="${summary.errored}" skipped="${summary.notApplicable}">`,
    ...cases.map((c) => `  ${c}`),
    '</testsuite>',
    '',
  ].join('\n');
}

/** REQ-CONF-5: the three report formats share one summary shape. */
export function formatReport(summary: RunSummary, format: ReportFormat, meta: ReportMeta = {}): string {
  switch (format) {
    case 'json':
      return JSON.stringify({ ...meta, ...summary }, null, 2);
    case 'markdown':
      return markdown(summary, meta);
    case 'junit':
      return junit(summary);
  }
}
```

- [ ] **Step 4: Implement conformance.ts and the fixture layer hook**

`packages/conformance/src/conformance.ts`:

```ts
import { loadVectors } from './load';
import { type ReportFormat, formatReport } from './report';
import { type RunOptions, runVectors } from './run';
import type { Target } from './target';
import type { RunSummary, Vector } from './types';

export interface ConformanceOptions extends RunOptions {
  target: Target;
  /** Default markdown. */
  report?: ReportFormat;
  /** Default: every vector under conformance/vectors. */
  vectors?: Vector[];
}

export interface ConformanceResult {
  summary: RunSummary;
  report: string;
}

/** REQ-CONF-5: one call for tests and the CLI. */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceResult> {
  const { target, report, vectors, ...runOptions } = options;
  const summary = await runVectors(target, vectors ?? loadVectors(), runOptions);
  const label = typeof target === 'function' ? 'in-process fetch handler' : target.baseUrl;
  return {
    summary,
    report: formatReport(summary, report ?? 'markdown', { target: label, generatedAt: new Date().toISOString() }),
  };
}
```

`packages/conformance/src/index.ts`: add

```ts
export { type ConformanceOptions, type ConformanceResult, runConformance } from './conformance';
export { type ReportFormat, type ReportMeta, formatReport } from './report';
```

`conformance/fixtures/hono/src/app.ts`: change the signature and the body so the layer is registered after `/reset` and before every other route:

```ts
import { Hono, type MiddlewareHandler } from 'hono';
```

```ts
/**
 * Reference fixture for the conformance suite (requirements REQ-CONF-2). With no layer it has no idempotency at all.
 * A layer is mounted after /reset (the control endpoint stays outside it) and before every fixture route.
 */
export function createFixtureApp(state: FixtureState = { count: 0 }, layer?: MiddlewareHandler): Hono {
  const app = new Hono();

  app.post('/reset', (c) => {
    state.count = 0;
    return c.body(null, 204);
  });

  if (layer !== undefined) app.use(layer);

  app.get('/counter', (c) => c.json({ count: state.count }));
```

(keep the rest of the routes unchanged). Because `app.use(layer)` has no path, it covers every route registered after it.

`conformance/fixtures/hono/package.json`: add `"build": "tsup src/app.ts --format esm --clean"` to `scripts` (the root `bun run build` filter `@anyonce/*` picks it up; `hono` is a dependency so tsup leaves it external). Keep `exports` pointing at `./src/app.ts`; the Node and Deno tests import `dist/app.js` by relative path.

- [ ] **Step 5: Implement cli.ts**

```ts
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { runConformance } from './conformance';
import type { ReportFormat } from './report';
import type { Capability, Tier } from './types';

const USAGE = `usage: anyonce-conformance --url <base> [--tier core|profile]... [--only <id>]... [--capability short-ttl]... [--ttl-ms <n>] [--report json|markdown|junit] [--out <file>]`;

interface Args {
  url?: string;
  tiers: Tier[];
  only: string[];
  capabilities: Capability[];
  ttlMs?: number;
  report: ReportFormat;
  out?: string;
}

export function parseArgs(input: string[]): Args | string {
  const args: Args = { tiers: [], only: [], capabilities: [], report: 'markdown' };
  for (let i = 0; i < input.length; i++) {
    const flag = input[i];
    const value = input[i + 1];
    if (flag === '--help' || flag === '-h') return USAGE;
    if (value === undefined) return `${flag} needs a value\n${USAGE}`;
    i++;
    switch (flag) {
      case '--url':
        args.url = value;
        break;
      case '--tier':
        if (value !== 'core' && value !== 'profile') return `unknown tier ${value}`;
        args.tiers.push(value);
        break;
      case '--only':
        args.only.push(value);
        break;
      case '--capability':
        if (value !== 'short-ttl') return `unknown capability ${value}`;
        args.capabilities.push(value);
        break;
      case '--ttl-ms':
        args.ttlMs = Number(value);
        if (!Number.isInteger(args.ttlMs) || args.ttlMs <= 0) return `--ttl-ms must be a positive integer`;
        break;
      case '--report':
        if (value !== 'json' && value !== 'markdown' && value !== 'junit') return `unknown report format ${value}`;
        args.report = value;
        break;
      case '--out':
        args.out = value;
        break;
      default:
        return `unknown flag ${flag}\n${USAGE}`;
    }
  }
  if (args.url === undefined) return `--url is required\n${USAGE}`;
  if (args.capabilities.includes('short-ttl') && args.ttlMs !== undefined && args.ttlMs > 2000) {
    return `short-ttl requires a target TTL of at most 2000 ms, got ${args.ttlMs}`;
  }
  return args;
}

async function main(): Promise<number> {
  const parsed = parseArgs(argv.slice(2));
  if (typeof parsed === 'string') {
    stderr.write(`${parsed}\n`);
    return 2;
  }
  const { summary, report } = await runConformance({
    target: { baseUrl: parsed.url as string },
    report: parsed.report,
    ...(parsed.tiers.length > 0 ? { tiers: parsed.tiers } : {}),
    ...(parsed.only.length > 0 ? { only: parsed.only } : {}),
    capabilities: parsed.capabilities,
  });
  if (parsed.out !== undefined) writeFileSync(parsed.out, report);
  else stdout.write(report);
  return summary.failed === 0 && summary.errored === 0 ? 0 : 1;
}

main().then(
  (code) => exit(code),
  (error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exit(2);
  },
);
```

`packages/conformance/package.json`: add `"bin": { "anyonce-conformance": "./dist/cli.js" }` and change the build script to `tsup src/index.ts src/cli.ts --format esm,cjs --dts --clean --shims`. tsup keeps the shebang line on `dist/cli.js`. Root `package.json` scripts: add `"conformance": "bun run packages/conformance/src/cli.ts"`.

- [ ] **Step 6: Update the conformance README**

Replace the "Running" section of `conformance/README.md` with:

```markdown
## Running

In-process (TypeScript):

```ts
import { runConformance } from '@anyonce/conformance';
const { summary, report } = await runConformance({ target: app.fetch, tiers: ['core'], report: 'markdown' });
```

Against a URL from the command line (any implementation, any language):

```sh
bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown
bunx @anyonce/conformance --url http://localhost:3000 --capability short-ttl --ttl-ms 2000 --report junit --out report.xml
```

Flags: `--url` (required), `--tier core|profile` (repeatable, default both), `--only <id>` (repeatable), `--capability short-ttl` (declares that the target's TTL is at most 2000 ms), `--ttl-ms <n>` (the target's TTL, checked against the capability), `--report json|markdown|junit` (default markdown), `--out <file>`. Exit code 0 when every applicable vector passed, 1 when any failed or errored, 2 on usage errors.

Reports: `json` is the run summary plus `target` and `generatedAt`; `markdown` is a table with one row per vector; `junit` has one `testcase` per vector with `failure`, `skipped` (not applicable) or `error` children.

Go, inside a test:

```go
conformance.Run(t, handler, conformance.Options{Capabilities: []string{"short-ttl"}})
```

`handler` is an `http.Handler` (served by `httptest.NewServer` for the run) or a base URL string. `conformance.RunVectors` and `conformance.Format` are the library forms.
```

- [ ] **Step 7: Run the tests, lint, typecheck, build**

Run: `bun test packages/conformance conformance`
Expected: PASS (the P0 bare-fixture tests still pass with the unchanged default `createFixtureApp()`).

Run: `bun run lint`, `bun run typecheck`, `bun run build`
Expected: clean; the fixture's `dist/app.js` and the conformance `dist/cli.js` (starting with the shebang) exist.

Run: `bun run conformance -- --help`
Expected: exit 2 with the usage line.

- [ ] **Step 8: Commit**

```bash
git add packages/conformance conformance/fixtures/hono conformance/README.md package.json .gitignore
git commit -m "feat(conformance): REQ-CONF-5 report formats and runConformance, REQ-CONF-7 CLI, fixture layer hook"
```

---

### Task 6: Every vector green through `withIdempotency`, the streaming proof and the Lambda harness (REQ-HTTP-7, REQ-HTTP-17, CHECKLIST P2)

**Files:**
- Create: `packages/core/test/http/conformance.test.ts`, `packages/core/test/http/streaming.test.ts`, `packages/core/test/http/lambda-harness.test.ts`
- Modify: `packages/core/package.json` (devDependencies `@anyonce/conformance` and `@anyonce/fixture-hono` as `workspace:*`), then `bun install`

**Interfaces:**
- Consumes: `withIdempotency`, `idempotencyOf` from `../../src/http`; `MemoryStore`; `runConformance`, `CORE_IDS`, `PROFILE_IDS` are read from `@anyonce/conformance` and its `test/catalog.ts` (import the catalog by relative path `../../../conformance/test/catalog`); `createFixtureApp` from `@anyonce/fixture-hono`.

- [ ] **Step 1: Add the dev dependencies**

In `packages/core/package.json` add:

```json
  "devDependencies": {
    "@anyonce/conformance": "workspace:*",
    "@anyonce/fixture-hono": "workspace:*"
  }
```

Run: `bun install`
Expected: the lockfile updates; `bun run test:reqs` and the REQ-CORE-7 package test still pass (they check `dependencies`, not `devDependencies`).

- [ ] **Step 2: Write the conformance test**

`packages/core/test/http/conformance.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';
import { CORE_IDS, PROFILE_IDS } from '../../../conformance/test/catalog';

describe('withIdempotency conformance', () => {
  test('REQ-HTTP-17: every core and profile vector passes through withIdempotency with the memory store', async () => {
    const app = createFixtureApp();
    const handler = withIdempotency(app.fetch, {
      store: new MemoryStore(),
      required: true,
      ttlMs: 2000,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'], report: 'markdown' });
    const notPassing = summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
```

(`expect(value, message)` is Bun's two-argument form; the markdown report is printed on failure.)

- [ ] **Step 3: Write the streaming proof**

`packages/core/test/http/streaming.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('streaming', () => {
  test('REQ-HTTP-7: the client receives the first chunk before the handler finishes and EOF only after the record is complete', async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let handlerDone = false;
    const handler = withIdempotency(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(enc.encode('first'));
              await gate;
              c.enqueue(enc.encode('second'));
              c.close();
              handlerDone = true;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/plain' } },
        ),
      { store },
    );
    const res = await handler(new Request('http://t.invalid/stream', { method: 'POST', body: 'b', headers: { 'Idempotency-Key': 'k1' } }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe('first');
    expect(handlerDone).toBe(false);
    expect((await store.get({ scope: 'POST /stream', key: 'k1' }, Date.now()))?.state).toBe('in_flight');
    release();
    const second = await reader.read();
    expect(dec.decode(second.value)).toBe('second');
    const end = await reader.read();
    expect(end.done).toBe(true);
    const record = await store.get({ scope: 'POST /stream', key: 'k1' }, Date.now());
    expect(record?.state).toBe('completed');
    expect(dec.decode(record?.result?.body)).toBe('firstsecond');
  });

  test('REQ-HTTP-7: a bodiless response is released only once the record is complete', async () => {
    const store = new MemoryStore();
    const handler = withIdempotency(async () => new Response(null, { status: 204 }), { store });
    const res = await handler(new Request('http://t.invalid/none', { method: 'POST', body: 'b', headers: { 'Idempotency-Key': 'k2' } }));
    expect(res.status).toBe(204);
    expect((await store.get({ scope: 'POST /none', key: 'k2' }, Date.now()))?.state).toBe('completed');
  });
});
```

- [ ] **Step 4: Write the Lambda function URL harness**

`packages/core/test/http/lambda-harness.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { withIdempotency } from '../../src/http';
import { MemoryStore } from '../../src/memory';
import { CORE_IDS, PROFILE_IDS } from '../../../conformance/test/catalog';

/** The subset of a Lambda function URL (payload 2.0) event and result that a fetch shim needs. */
interface FunctionUrlEvent {
  version: '2.0';
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  requestContext: { http: { method: string } };
  body?: string;
  isBase64Encoded: boolean;
}
interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A minimal Lambda fetch shim: event to Request, Response to result. Examples in P6 use the real adapters. */
function toLambdaHandler(fetchHandler: (req: Request) => Promise<Response>) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const url = `http://lambda.invalid${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
    const init: RequestInit = { method: event.requestContext.http.method, headers: event.headers };
    if (event.body !== undefined && init.method !== 'GET' && init.method !== 'HEAD') {
      init.body = event.isBase64Encoded ? fromBase64(event.body) : event.body;
    }
    const res = await fetchHandler(new Request(url, init));
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return { statusCode: res.status, headers, body: toBase64(new Uint8Array(await res.arrayBuffer())), isBase64Encoded: true };
  };
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  const app = createFixtureApp();
  const lambda = toLambdaHandler(
    withIdempotency(app.fetch, { store: new MemoryStore(), required: true, ttlMs: 2000, skip: (req) => new URL(req.url).pathname === '/reset' }),
  );
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const event: FunctionUrlEvent = {
        version: '2.0',
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        requestContext: { http: { method: req.method } },
        isBase64Encoded: true,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') event.body = toBase64(new Uint8Array(await req.arrayBuffer()));
      const result = await lambda(event);
      return new Response(result.isBase64Encoded ? fromBase64(result.body) : result.body, { status: result.statusCode, headers: result.headers });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

describe('lambda function url harness', () => {
  test('REQ-HTTP-17: the URL-mode runner passes every vector against a Lambda-shaped handler behind withIdempotency', async () => {
    const { summary, report } = await runConformance({ target: { baseUrl }, capabilities: ['short-ttl'], report: 'markdown' });
    const notPassing = summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
```

- [ ] **Step 5: Run the three tests**

Run: `bun test packages/core/test/http/conformance.test.ts packages/core/test/http/streaming.test.ts packages/core/test/http/lambda-harness.test.ts`
Expected: PASS. If a vector fails, the markdown report names the step and the mismatch; fix the bridge, not the vector. Two vectors worth checking first: `profile/omitted-body-replay` (needs `bodyBytes: 0` and both replay headers) and `core/concurrent-409` (the duplicate must reach `begin` while the first request is inside the handler; `readBody` and `requestFingerprint` run before `begin`, which is fine because the first request is already past `begin` when the duplicate arrives 300 ms later).

Run: `bun run test`
Expected: PASS across the monorepo.

- [ ] **Step 6: Commit**

```bash
git add packages/core bun.lock
git commit -m "test(core): REQ-HTTP-17 every vector green through withIdempotency, REQ-HTTP-7 streaming proof, Lambda URL harness"
```

---
### Task 7: `@anyonce/hono` (REQ-HTTP-16, REQ-HTTP-14, REQ-HTTP-5 route scope) and the changeset

**Files:**
- Create: `packages/hono/package.json`, `packages/hono/tsconfig.json`, `packages/hono/src/index.ts`, `packages/hono/test/middleware.test.ts`, `packages/hono/test/conformance.test.ts`, `packages/hono/test/typing.test.ts`, `packages/hono/test/package.test.ts`, `.changeset/p2-http.md`
- Modify: `packages/core/test/package.test.ts` is untouched; `scripts/size.ts` is untouched (no budget line for hono; it is a thin binding)

**Interfaces:**
- Consumes: `HttpIdempotencyOptions`, `resolveHttpOptions`, `runIdempotent`, `IdempotencyInfo` from `@anyonce/core/http`; `MiddlewareHandler` from `hono`; `routePath` from `hono/route`.
- Produces: `idempotency(options): MiddlewareHandler<IdempotencyEnv>`, `IdempotencyEnv`, `IdempotencyVariables`, re-exports of `withIdempotency`, `idempotencyOf` and the option and problem types.

- [ ] **Step 1: Package scaffold**

`packages/hono/package.json`:

```json
{
  "name": "@anyonce/hono",
  "version": "0.0.0",
  "description": "Hono middleware for anyonce idempotency",
  "license": "Apache-2.0",
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@anyonce/core": "workspace:*",
    "hono": ">=4.0.0"
  },
  "devDependencies": {
    "@anyonce/conformance": "workspace:*",
    "@anyonce/core": "workspace:*",
    "@anyonce/fixture-hono": "workspace:*",
    "hono": "^4.13.8"
  }
}
```

`packages/hono/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`.

Run: `bun install`.

- [ ] **Step 2: Write the failing tests**

`packages/hono/test/middleware.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { Hono } from 'hono';
import { type IdempotencyEnv, idempotency } from '../src';

function post(path: string, key?: string, body = 'b'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return new Request(`http://t.invalid${path}`, { method: 'POST', body, headers });
}

function build(store = new MemoryStore()) {
  const state = { calls: 0 };
  const app = new Hono<IdempotencyEnv>()
    .use(idempotency({ store, required: true }))
    .post('/orders/:id', async (c) => {
      state.calls += 1;
      const body = await c.req.text();
      return c.json({ id: c.req.param('id'), body, key: c.get('idempotencyKey'), fence: c.get('idempotencyFence') }, 201);
    })
    .get('/orders/:id', (c) => c.json({ key: c.get('idempotencyKey') ?? null }));
  return { app, state, store };
}

describe('idempotency middleware', () => {
  test('REQ-HTTP-16: the first request runs the handler and the duplicate replays it', async () => {
    const { app, state } = build();
    const first = await app.fetch(post('/orders/1', 'k'));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ id: '1', body: 'b', key: 'k', fence: 1 });
    const replay = await app.fetch(post('/orders/1', 'k'));
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(replay.headers.get('Content-Type')).toContain('application/json');
    expect(await replay.json()).toEqual({ id: '1', body: 'b', key: 'k', fence: 1 });
    expect(state.calls).toBe(1);
  });

  test('REQ-HTTP-14: the handler reads idempotencyKey and idempotencyFence from the context and a GET sees neither', async () => {
    const { app } = build();
    expect(await (await app.fetch(post('/orders/2', 'k2'))).json()).toMatchObject({ key: 'k2', fence: 1 });
    expect(await (await app.fetch(new Request('http://t.invalid/orders/2'))).json()).toEqual({ key: null });
  });

  test('REQ-HTTP-5: the default scope is the route pattern so two ids share a scope but a different route does not', async () => {
    const { app, state, store } = build();
    await (await app.fetch(post('/orders/1', 'k'))).text();
    await (await app.fetch(post('/orders/2', 'k'))).text();
    expect(state.calls).toBe(1);
    const record = await store.get({ scope: 'POST /orders/:id', key: 'k' }, Date.now());
    expect(record?.state).toBe('completed');
  });

  test('REQ-HTTP-3: a missing key is a problem response through the middleware', async () => {
    const { app, state } = build();
    const res = await app.fetch(post('/orders/1'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect((await res.json()).code).toBe('missing-key');
    expect(state.calls).toBe(0);
  });

  test('REQ-HTTP-16: a handler that throws reaches app.onError and the record is abandoned', async () => {
    const store = new MemoryStore();
    const app = new Hono<IdempotencyEnv>()
      .use(idempotency({ store }))
      .post('/boom', () => {
        throw new Error('boom');
      })
      .onError((err, c) => c.text(err.message, 500));
    const res = await app.fetch(post('/boom', 'k'));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('boom');
    expect(await store.get({ scope: 'POST /boom', key: 'k' }, Date.now())).toBeNull();
  });

  test('REQ-HTTP-7: a streamed Hono response reaches the client chunk by chunk', async () => {
    const { stream } = await import('hono/streaming');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const app = new Hono<IdempotencyEnv>().use(idempotency({ store: new MemoryStore() })).post('/s', (c) =>
      stream(c, async (s) => {
        await s.write('first');
        await gate;
        await s.write('second');
      }),
    );
    const res = await app.fetch(post('/s', 'k'));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('second');
    expect((await reader.read()).done).toBe(true);
  });
});
```

`packages/hono/test/conformance.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '../src';
import { CORE_IDS, PROFILE_IDS } from '../../conformance/test/catalog';

describe('hono conformance', () => {
  test('REQ-HTTP-16: every core and profile vector passes through the Hono middleware with the memory store', async () => {
    const app = createFixtureApp({ count: 0 }, idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }));
    const { summary, report } = await runConformance({ target: app.fetch, capabilities: ['short-ttl'], report: 'markdown' });
    const notPassing = summary.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.passed).toBe(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
```

`packages/hono/test/typing.test.ts` (compiled by `typecheck`; the runtime assertion is small on purpose):

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { type IdempotencyEnv, idempotency } from '../src';

const app = new Hono<IdempotencyEnv>()
  .use(idempotency({ store: new MemoryStore() }))
  .post('/typed', (c) => {
    const key: string | undefined = c.get('idempotencyKey');
    const fence: number | undefined = c.get('idempotencyFence');
    return c.json({ key: key ?? null, fence: fence ?? null });
  });

type AppType = typeof app;

describe('typing', () => {
  test('REQ-HTTP-16: hc<AppType> sees the route and the variables are typed on the env', async () => {
    const client = hc<AppType>('http://t.invalid', { fetch: app.fetch });
    const res = await client.typed.$post({}, { headers: { 'Idempotency-Key': 'k' } });
    expect(await res.json()).toEqual({ key: 'k', fence: 1 });
  });
});
```

`packages/hono/test/package.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

describe('package hygiene', () => {
  test('REQ-HTTP-16: hono and @anyonce/core are peers and there are no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ '@anyonce/core': 'workspace:*', hono: '>=4.0.0' });
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-HTTP-16: the source imports only from @anyonce/core, @anyonce/core/http and hono', () => {
    const source = readFileSync(join(pkgDir, 'src/index.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      expect(['@anyonce/core', '@anyonce/core/http', 'hono', 'hono/route']).toContain(specifier);
    }
    expect(source).not.toMatch(/node:/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/hono`
Expected: FAIL (`../src` not found).

- [ ] **Step 4: Implement the middleware**

`packages/hono/src/index.ts`:

```ts
import { type HttpIdempotencyOptions, resolveHttpOptions, runIdempotent } from '@anyonce/core/http';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

export type {
  FingerprintFn,
  FingerprintMode,
  HttpIdempotencyOptions,
  IdempotencyInfo,
  Problem,
  ProblemCode,
} from '@anyonce/core/http';
export { idempotencyOf, withIdempotency } from '@anyonce/core/http';

/** REQ-HTTP-14: variables the middleware sets for handlers. */
export interface IdempotencyVariables {
  idempotencyKey?: string;
  idempotencyFence?: number;
}

/** REQ-HTTP-16: use `new Hono<IdempotencyEnv>()` so `c.get` and `hc<AppType>` know the variables. */
export type IdempotencyEnv = { Variables: IdempotencyVariables };

/**
 * REQ-HTTP-16: Hono middleware over runIdempotent. The default scope is METHOD plus the matched route pattern
 * (D8), read from the last matched route so it names the endpoint rather than this middleware.
 */
export function idempotency(options: HttpIdempotencyOptions): MiddlewareHandler<IdempotencyEnv> {
  const resolved = resolveHttpOptions(options);
  return async (c, next) => {
    const routeScope = `${c.req.method.toUpperCase()} ${routePath(c, -1) || c.req.path}`;
    const response = await runIdempotent(
      c.req.raw,
      async (_req, info) => {
        if (info !== undefined) {
          c.set('idempotencyKey', info.key);
          c.set('idempotencyFence', info.fence);
        }
        await next();
        return c.res;
      },
      resolved,
      { routeScope },
    );
    c.res = undefined;
    c.res = response;
  };
}
```

Why the double assignment: Hono's `res` setter merges the headers of a previous response into the new one; clearing first makes the bridge's response the whole answer.

- [ ] **Step 5: Run the tests, lint, typecheck, build**

Run: `bun test packages/hono`
Expected: PASS. If `routePath(c, -1)` is not accepted by the type signature of the installed Hono, use `c.req.matchedRoutes.at(-1)?.path ?? c.req.path` instead and drop the `hono/route` import (and remove it from the package test's allowlist).

Run: `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test`
Expected: clean; `packages/hono/dist` exists; the whole suite passes.

- [ ] **Step 6: Changeset**

`.changeset/p2-http.md`:

```markdown
---
"@anyonce/core": minor
"@anyonce/hono": minor
"@anyonce/conformance": minor
---

HTTP door: the @anyonce/core/http subpath with withIdempotency, problem details, streaming capture and replay; the @anyonce/hono middleware; conformance report formats, runConformance and the anyonce-conformance CLI.
```

- [ ] **Step 7: Commit**

```bash
git add packages/hono .changeset/p2-http.md bun.lock
git commit -m "feat(hono): REQ-HTTP-16 idempotency middleware with IdempotencyEnv typing, every vector green"
```

---

### Task 8: Runtime matrix (workerd, Node 22, Deno) and CI (NFR-4, REQ-REL-4)

**Files:**
- Create: `packages/conformance/src/runtime.ts`, `test/workers/http.test.ts`, `test/node/http.test.mjs`, `test/deno/deno.json`, `test/deno/http_test.ts`
- Modify: `packages/conformance/package.json` (runtime export and build entry), `test/workers/vitest.config.ts` (no change unless noted), `test/workers/tsconfig.json`, `.github/workflows/ci.yml`, `test/ci.test.ts`, root `package.json` (scripts `test:node`, `test:deno`, and `test:reqs` phase p2)

**Interfaces:**
- Produces: `@anyonce/conformance/runtime` (`runVectors`, `evaluateExpect`, `formatReport`, `toSender`, types) with no `node:` import; scripts `bun run test:node` and `bun run test:deno`.

- [ ] **Step 1: The runtime subpath**

`packages/conformance/src/runtime.ts`:

```ts
/** The runner without the vector loader and the CLI, for runtimes without node:fs (workerd). */
export { evaluateExpect } from './expect';
export { type ReportFormat, type ReportMeta, formatReport } from './report';
export { type RunOptions, runVector, runVectors } from './run';
export { type FetchHandler, type Sender, type Target, toSender } from './target';
export type * from './types';
```

`packages/conformance/package.json`: add the export

```json
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js",
      "require": "./dist/runtime.cjs"
    }
```

and the build entry: `tsup src/index.ts src/runtime.ts src/cli.ts --format esm,cjs --dts --clean --shims`.

Add to `packages/conformance/test/run.test.ts` (or a new `runtime.test.ts`):

```ts
  test('REQ-CONF-5: the runtime entry bundles without any node: import', async () => {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/runtime.ts')], target: 'browser', minify: false });
    expect(result.success).toBe(true);
    const text = await (result.outputs[0] as { text(): Promise<string> }).text();
    expect(text).not.toMatch(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:/);
  });
```

- [ ] **Step 2: workerd test**

`test/workers/http.test.ts`:

```ts
import { runVectors } from '@anyonce/conformance/runtime';
import type { Vector } from '@anyonce/conformance/runtime';
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '@anyonce/hono';
import { describe, expect, test } from 'vitest';

const modules = import.meta.glob('../../conformance/vectors/{core,profile}/*.json', { eager: true, import: 'default' });
const vectors = Object.values(modules) as Vector[];

function report(results: Array<{ id: string; status: string; steps: Array<{ stepId: string; failures: string[] }>; error?: string }>): string {
  return results
    .filter((r) => r.status !== 'pass')
    .map((r) => `${r.id}: ${r.status} ${r.error ?? ''} ${r.steps.flatMap((s) => s.failures.map((f) => `${s.stepId}: ${f}`)).join('; ')}`)
    .join('\n');
}

describe('workerd', () => {
  test('NFR-4: every vector passes inside workerd through withIdempotency', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const app = createFixtureApp();
    const handler = withIdempotency(app.fetch, { store: new MemoryStore(), required: true, ttlMs: 2000, skip: (req) => new URL(req.url).pathname === '/reset' });
    const summary = await runVectors(handler, vectors, { capabilities: ['short-ttl'] });
    expect(report(summary.results), report(summary.results)).toBe('');
    expect(summary.passed).toBe(vectors.length);
  }, 60_000);

  test('NFR-4: every vector passes inside workerd through the Hono middleware', async () => {
    const app = createFixtureApp({ count: 0 }, idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }));
    const summary = await runVectors(app.fetch, vectors, { capabilities: ['short-ttl'] });
    expect(report(summary.results), report(summary.results)).toBe('');
    expect(summary.passed).toBe(vectors.length);
  }, 60_000);
});
```

Add the workspace packages to the root `devDependencies` so the workers config resolves them: `"@anyonce/conformance": "workspace:*"`, `"@anyonce/core": "workspace:*"`, `"@anyonce/fixture-hono": "workspace:*"`, `"@anyonce/hono": "workspace:*"`, then `bun install`. The imports resolve through each package's `exports` to `dist`, so `bun run build` must run before `bun run test:workers` (add it to the CI job below and note it in CLAUDE.md's command line for `test:workers`). If `import.meta.glob` is not typed in `test/workers/tsconfig.json`, add `"vite/client"` to its `types` array.

Run: `bun run build`, `bun run test:workers`
Expected: PASS (three tests including the P0 smoke). If the pool reports the test timed out at 5000 ms despite the per-test timeout, set `test.testTimeout: 60_000` in `test/workers/vitest.config.ts`.

- [ ] **Step 3: Node 22 test**

`test/node/http.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureApp } from '../../conformance/fixtures/hono/dist/app.js';
import { runConformance } from '../../packages/conformance/dist/index.js';
import { withIdempotency } from '../../packages/core/dist/http/index.js';
import { MemoryStore } from '../../packages/core/dist/index.js';
import { idempotency } from '../../packages/hono/dist/index.js';

test('NFR-4: every vector passes on Node through withIdempotency', { timeout: 60_000 }, async () => {
  const app = createFixtureApp();
  const handler = withIdempotency(app.fetch, { store: new MemoryStore(), required: true, ttlMs: 2000, skip: (req) => new URL(req.url).pathname === '/reset' });
  const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'] });
  assert.equal(summary.failed + summary.errored + summary.notApplicable, 0, report);
});

test('NFR-4: every vector passes on Node through the Hono middleware', { timeout: 60_000 }, async () => {
  const app = createFixtureApp({ count: 0 }, idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }));
  const { summary, report } = await runConformance({ target: app.fetch, capabilities: ['short-ttl'] });
  assert.equal(summary.failed + summary.errored + summary.notApplicable, 0, report);
});
```

Root `package.json` script: `"test:node": "node --test test/node/"`.

Run: `bun run build`, `bun run test:node`
Expected: 2 passing. `hono` resolves from the root `node_modules` for the fixture's dist and for `@anyonce/hono`'s dist because both files sit inside the workspace.

- [ ] **Step 4: Deno test**

`test/deno/deno.json`:

```json
{
  "imports": {
    "@anyonce/core": "../../packages/core/dist/index.js",
    "@anyonce/core/http": "../../packages/core/dist/http/index.js",
    "@anyonce/hono": "../../packages/hono/dist/index.js",
    "@anyonce/conformance": "../../packages/conformance/dist/index.js",
    "@anyonce/fixture-hono": "../../conformance/fixtures/hono/dist/app.js",
    "hono": "npm:hono@4.13.8",
    "hono/": "npm:hono@4.13.8/"
  }
}
```

`test/deno/http_test.ts`:

```ts
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { idempotency } from '@anyonce/hono';

function assertAllPassed(summary: { failed: number; errored: number; notApplicable: number }, report: string): void {
  if (summary.failed + summary.errored + summary.notApplicable !== 0) throw new Error(report);
}

Deno.test('NFR-4: every vector passes on Deno through withIdempotency', async () => {
  const app = createFixtureApp();
  const handler = withIdempotency(app.fetch, { store: new MemoryStore(), required: true, ttlMs: 2000, skip: (req: Request) => new URL(req.url).pathname === '/reset' });
  const { summary, report } = await runConformance({ target: handler, capabilities: ['short-ttl'] });
  assertAllPassed(summary, report);
});

Deno.test('NFR-4: every vector passes on Deno through the Hono middleware', async () => {
  const app = createFixtureApp({ count: 0 }, idempotency({ store: new MemoryStore(), required: true, ttlMs: 2000 }));
  const { summary, report } = await runConformance({ target: app.fetch, capabilities: ['short-ttl'] });
  assertAllPassed(summary, report);
});
```

Root `package.json` script: `"test:deno": "deno test --config test/deno/deno.json --allow-read --allow-env --allow-net=127.0.0.1 test/deno/"`.

Biome: add `"!test/deno/deno.json"` to nothing; the JSON is plain. If Biome complains about the `Deno` global in `http_test.ts`, add `/// <reference lib="deno.ns" />` as the first line (harmless for Biome, informative for editors).

Run: `bun run build`, `bun run test:deno`
Expected: 2 passed. The first run downloads `hono@4.13.8` from npm into Deno's cache (a package registry, allowed by CLAUDE.md). If Deno reports that the dist files import `hono/route` and the import map does not cover it, the `hono/` prefix entry handles it; if it reports a `node:` specifier problem for `@anyonce/conformance`, the loader uses `node:fs` and `node:url`, both supported by Deno 2.

- [ ] **Step 5: CI**

`.github/workflows/ci.yml`:

- In the `workers` job insert `- run: bun run build` before `- run: bun run test:workers`.
- In the `node-compat` job append `- run: bun run test:node` after the existing smoke steps.
- Add a job:

```yaml
  deno:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun run test:deno
```

`test/ci.test.ts`: change the job list assertion to include `'deno'` (sorted: `deno, go, node-compat, services, ts, vectors-validate, workers`) and add:

```ts
  test('REQ-REL-4: the runtime matrix jobs build first and run the node and deno suites', () => {
    expect(runs(ci.jobs.workers as Job)).toContain('bun run build');
    expect(runs(ci.jobs.workers as Job).indexOf('bun run build')).toBeLessThan(runs(ci.jobs.workers as Job).indexOf('bun run test:workers'));
    expect(runs(ci.jobs['node-compat'] as Job)).toContain('bun run test:node');
    expect(runs(ci.jobs.deno as Job)).toContain('bun run test:deno');
    expect(uses(ci.jobs.deno as Job)).toContain('denoland/setup-deno@v2');
  });
```

Root `package.json`: change `test:reqs` to `bun run scripts/reqs.ts --phase p2`.

Run: `bun test test/ci.test.ts`, `bun run test:reqs`
Expected: PASS; `test:reqs` lists REQ-HTTP-18 and REQ-CONF-6 as uncovered (they are Go, Tasks 10 and 11) and nothing else. If it lists more, a TypeScript test name is missing its id.

- [ ] **Step 6: Commit**

```bash
git add packages/conformance test .github/workflows/ci.yml package.json bun.lock
git commit -m "test: NFR-4 runtime matrix on workerd, Node 22 and Deno with the conformance runtime entry, REQ-REL-4 CI jobs"
```

---
### Task 9: Go `httpmw` options, problems, request helpers and context accessors (REQ-HTTP-1..6, REQ-HTTP-13, REQ-HTTP-14, REQ-HTTP-15 in Go)

**Files:**
- Create: `go/httpmw/doc.go`, `go/httpmw/options.go`, `go/httpmw/problems.go`, `go/httpmw/request.go`, `go/httpmw/context.go`, `go/httpmw/options_test.go`, `go/httpmw/problems_test.go`, `go/httpmw/request_test.go`, `go/httpmw/context_test.go`

**Interfaces:**
- Consumes: `anyonce.ParseKey`, `anyonce.Syntax`, `anyonce.SyntaxLenient`, `anyonce.HTTPFingerprint`, `anyonce.SHA256Hex`, `anyonce.Canonicalize`, `anyonce.Policy`, `anyonce.DefaultPolicy`.
- Produces: `Options`, `FingerprintMode`, `DefaultMethods`, `DefaultHeaderName`, `DefaultMaxRequestBytes`, `DefaultStoreHeaders`, `DefaultProblemBaseURI`, `Code` constants, `Problem`, `NewProblem`, `WriteProblem`, `KeyFromContext`, `FenceFromContext`, and the unexported `resolved`, `lookupKey`, `requestPath`, `defaultScope`, `resolveScope`, `readBody`, `fingerprint`, `withInfo`, `errTooLarge`. Task 10 consumes them.

- [ ] **Step 1: Write the failing tests**

`go/httpmw/options_test.go`:

```go
package httpmw

import (
	"net/http"
	"testing"
)

func TestOptions(t *testing.T) {
	t.Run("REQ-HTTP-1: the default methods are POST and PATCH and Methods is matched uppercased", func(t *testing.T) {
		r := Options{}.resolve()
		if !r.methods[http.MethodPost] || !r.methods[http.MethodPatch] || r.methods[http.MethodGet] {
			t.Fatalf("methods %v", r.methods)
		}
		if got := (Options{Methods: []string{"put"}}).resolve().methods; !got["PUT"] || got["POST"] {
			t.Fatalf("methods %v", got)
		}
	})
	t.Run("REQ-HTTP-2: the header name defaults to Idempotency-Key", func(t *testing.T) {
		if r := (Options{}).resolve(); r.HeaderName != "Idempotency-Key" {
			t.Fatal(r.HeaderName)
		}
	})
	t.Run("REQ-HTTP-4: key syntax defaults to lenient", func(t *testing.T) {
		if r := (Options{}).resolve(); r.KeySyntax != "lenient" {
			t.Fatal(r.KeySyntax)
		}
	})
	t.Run("REQ-HTTP-6: fingerprint defaults to body and MaxRequestBytes to 1 MiB", func(t *testing.T) {
		r := (Options{}).resolve()
		if r.Fingerprint != FingerprintBody || r.MaxRequestBytes != 1<<20 {
			t.Fatalf("%+v", r.Options)
		}
	})
	t.Run("REQ-HTTP-8: the store header allowlist defaults to five canonical names", func(t *testing.T) {
		r := (Options{}).resolve()
		for _, name := range []string{"Content-Type", "Content-Language", "Location", "Etag", "Link"} {
			if !r.storeHeaders[name] {
				t.Fatalf("missing %s in %v", name, r.storeHeaders)
			}
		}
		if got := (Options{StoreHeaders: []string{"x-trace"}}).resolve().storeHeaders; !got["X-Trace"] || got["Content-Type"] {
			t.Fatalf("%v", got)
		}
	})
	t.Run("REQ-HTTP-13: the problem base URI and docs URL have D11 defaults", func(t *testing.T) {
		r := (Options{}).resolve()
		if r.ProblemBaseURI != "https://in8.sh/anyonce/problems/" || r.DocsURL != "https://in8.sh/anyonce/problems/missing-key" {
			t.Fatalf("%+v", r.Options)
		}
		if got := (Options{ProblemBaseURI: "https://p.test/"}).resolve().DocsURL; got != "https://p.test/missing-key" {
			t.Fatal(got)
		}
	})
}
```

`go/httpmw/problems_test.go`:

```go
package httpmw

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProblems(t *testing.T) {
	t.Run("REQ-HTTP-13: every code maps to its D11 status", func(t *testing.T) {
		want := map[Code]int{CodeMissingKey: 400, CodeInvalidKey: 400, CodeConflict: 409, CodeFingerprintMismatch: 422, CodePayloadTooLarge: 413, CodeStoreUnavailable: 503, CodeMissingPrincipal: 500}
		for code, status := range want {
			if p := NewProblem(code, DefaultProblemBaseURI, ""); p.Status != status || p.Type != DefaultProblemBaseURI+string(code) || p.Code != code || p.Title == "" {
				t.Fatalf("%+v", p)
			}
		}
	})
	t.Run("REQ-HTTP-13: WriteProblem writes application/problem+json with the members and extra headers", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteProblem(rec, NewProblem(CodeMissingKey, DefaultProblemBaseURI, ""), http.Header{"Link": {"<https://d.test>; rel=\"describedby\""}})
		if rec.Code != 400 || rec.Header().Get("Content-Type") != "application/problem+json" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Link") != "<https://d.test>; rel=\"describedby\"" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["code"] != "missing-key" || body["status"] != float64(400) || body["type"] != "https://in8.sh/anyonce/problems/missing-key" {
			t.Fatalf("%v", body)
		}
		if _, ok := body["detail"]; ok {
			t.Fatal("detail must be omitted when empty")
		}
	})
}
```

`go/httpmw/request_test.go`:

```go
package httpmw

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
)

func TestRequestHelpers(t *testing.T) {
	t.Run("REQ-HTTP-2: the header is looked up case-insensitively and a repeated field is invalid", func(t *testing.T) {
		h := http.Header{}
		h.Set("idempotency-key", "abc")
		if key, st, _ := lookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != keyOK || key != "abc" {
			t.Fatalf("%v %q", st, key)
		}
		if _, st, _ := lookupKey(http.Header{}, "Idempotency-Key", anyonce.SyntaxLenient); st != keyMissing {
			t.Fatal(st)
		}
		h.Add("Idempotency-Key", "two")
		if _, st, reason := lookupKey(h, "Idempotency-Key", anyonce.SyntaxLenient); st != keyInvalid || !strings.Contains(reason, "repeated") {
			t.Fatalf("%v %q", st, reason)
		}
	})
	t.Run("REQ-HTTP-4: strict syntax rejects a bare token", func(t *testing.T) {
		h := http.Header{"Idempotency-Key": {"bare"}}
		if _, st, _ := lookupKey(h, "Idempotency-Key", anyonce.SyntaxStrict); st != keyInvalid {
			t.Fatal(st)
		}
		if key, st, _ := lookupKey(http.Header{"Idempotency-Key": {"\"quoted key\""}}, "Idempotency-Key", anyonce.SyntaxStrict); st != keyOK || key != "quoted key" {
			t.Fatalf("%v %q", st, key)
		}
	})
	t.Run("REQ-HTTP-2: the invalid reason never contains the key value", func(t *testing.T) {
		_, _, reason := lookupKey(http.Header{"Idempotency-Key": {"has space inside"}}, "Idempotency-Key", anyonce.SyntaxLenient)
		if strings.Contains(reason, "has space") {
			t.Fatal(reason)
		}
	})
	t.Run("REQ-HTTP-5: the default scope is METHOD and path, a Scope option wins, a principal is appended", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/orders/42?x=1", nil)
		if got := defaultScope(r); got != "POST /orders/42" {
			t.Fatal(got)
		}
		if got := requestPath(r); got != "/orders/42?x=1" {
			t.Fatal(got)
		}
		if scope, ok := resolveScope(r, (Options{Scope: func(*http.Request) string { return "custom" }}).resolve()); !ok || scope != "custom" {
			t.Fatalf("%q %v", scope, ok)
		}
		principal := func(r *http.Request) string { return r.Header.Get("X-Tenant") }
		r.Header.Set("X-Tenant", "acme")
		if scope, ok := resolveScope(r, (Options{Principal: principal}).resolve()); !ok || scope != "POST /orders/42#acme" {
			t.Fatalf("%q %v", scope, ok)
		}
		r.Header.Del("X-Tenant")
		if scope, ok := resolveScope(r, (Options{Principal: principal}).resolve()); !ok || scope != "POST /orders/42" {
			t.Fatalf("%q %v", scope, ok)
		}
		if _, ok := resolveScope(r, (Options{Principal: principal, RequirePrincipal: true}).resolve()); ok {
			t.Fatal("expected missing principal")
		}
	})
	t.Run("REQ-HTTP-6: readBody reads once, re-supplies the body and enforces the cap", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("payload"))
		body, err := readBody(r, 1024)
		if err != nil || string(body) != "payload" {
			t.Fatalf("%q %v", body, err)
		}
		again, _ := io.ReadAll(r.Body)
		if string(again) != "payload" {
			t.Fatalf("handler sees %q", again)
		}
		declared := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("0123456789"))
		if _, err := readBody(declared, 9); !errors.Is(err, errTooLarge) {
			t.Fatal(err)
		}
		undeclared := httptest.NewRequest(http.MethodPost, "/p", io.NopCloser(bytes.NewReader([]byte("0123456789"))))
		undeclared.ContentLength = -1
		if _, err := readBody(undeclared, 9); !errors.Is(err, errTooLarge) {
			t.Fatal(err)
		}
		if body, err := readBody(httptest.NewRequest(http.MethodPost, "/p", nil), 9); err != nil || len(body) != 0 {
			t.Fatalf("%q %v", body, err)
		}
	})
	t.Run("REQ-HTTP-6: body mode hashes method, path with query and bytes; jcs mode equates reordered JSON and falls back", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodPost, "/p?x=1", nil)
		if got, _ := fingerprint(r, []byte("abc"), (Options{}).resolve()); got != anyonce.HTTPFingerprint("POST", "/p?x=1", []byte("abc")) {
			t.Fatal(got)
		}
		jcs := (Options{Fingerprint: FingerprintJCS}).resolve()
		a, _ := fingerprint(r, []byte(`{"a":1,"b":[1,2]}`), jcs)
		b, _ := fingerprint(r, []byte(` { "b" : [1, 2], "a" : 1 } `), jcs)
		if a != b || a != anyonce.SHA256Hex([]byte("POST\n/p?x=1\n{\"a\":1,\"b\":[1,2]}")) {
			t.Fatalf("%s %s", a, b)
		}
		if got, _ := fingerprint(r, []byte("not json"), jcs); got != anyonce.HTTPFingerprint("POST", "/p?x=1", []byte("not json")) {
			t.Fatal(got)
		}
		custom := (Options{FingerprintFunc: func(r *http.Request, body []byte) (string, error) { return r.Header.Get("X-V") + ":" + string(body), nil }}).resolve()
		r.Header.Set("X-V", "2")
		if got, _ := fingerprint(r, []byte("abc"), custom); got != "2:abc" {
			t.Fatal(got)
		}
	})
}
```

`go/httpmw/context_test.go`:

```go
package httpmw

import (
	"context"
	"testing"
)

func TestContext(t *testing.T) {
	t.Run("REQ-HTTP-14: KeyFromContext and FenceFromContext read what the middleware stored and report absence", func(t *testing.T) {
		ctx := withInfo(context.Background(), "k", 3)
		if key, ok := KeyFromContext(ctx); !ok || key != "k" {
			t.Fatalf("%q %v", key, ok)
		}
		if fence, ok := FenceFromContext(ctx); !ok || fence != 3 {
			t.Fatalf("%d %v", fence, ok)
		}
		if _, ok := KeyFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
		if _, ok := FenceFromContext(context.Background()); ok {
			t.Fatal("expected absent")
		}
	})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./httpmw/`
Expected: build failure (package does not exist).

- [ ] **Step 3: Implement doc.go, options.go, problems.go**

`go/httpmw/doc.go`:

```go
// Package httpmw is the anyonce HTTP door for net/http (requirements 4.4, REQ-HTTP-18): New(store, Options).Handler(next)
// wraps a handler so that requests carrying an Idempotency-Key execute at most once per scope and key, with
// completed results replayed, in-flight duplicates answered 409, and payload mismatches answered 422.
package httpmw
```

`go/httpmw/options.go`:

```go
package httpmw

import (
	"net/http"
	"strings"

	"github.com/sns45/anyonce/go/anyonce"
)

// FingerprintMode selects the D9 fingerprint: body hashes method, path with query and the raw bytes; jcs hashes the
// RFC 8785 form of a JSON body instead of the bytes and falls back to body when the payload is not JSON.
type FingerprintMode string

const (
	FingerprintBody FingerprintMode = "body"
	FingerprintJCS  FingerprintMode = "jcs"
)

const (
	DefaultHeaderName      = "Idempotency-Key"
	DefaultMaxRequestBytes = 1 << 20
	DefaultProblemBaseURI  = "https://in8.sh/anyonce/problems/"
)

// DefaultMethods are the methods the layer applies to (REQ-HTTP-1).
var DefaultMethods = []string{http.MethodPost, http.MethodPatch}

// DefaultStoreHeaders is the REQ-HTTP-8 allowlist. Set-Cookie is never stored whatever the allowlist says.
var DefaultStoreHeaders = []string{"Content-Type", "Content-Language", "Location", "ETag", "Link"}

// Options configures the middleware. Zero values take the documented defaults.
type Options struct {
	// Methods the layer applies to; others pass through (REQ-HTTP-1). Default POST and PATCH.
	Methods []string
	// HeaderName is matched case-insensitively (REQ-HTTP-2). Default Idempotency-Key.
	HeaderName string
	// Required makes a missing header a 400 missing-key; otherwise the request passes through (REQ-HTTP-3).
	Required bool
	// KeySyntax is D7: lenient (default) or strict.
	KeySyntax anyonce.Syntax
	// Scope replaces the default scope of METHOD plus path (REQ-HTTP-5). The middleware wraps the mux, so no
	// route pattern is known here; pass one from your router if you want pattern-level scopes.
	Scope func(*http.Request) string
	// Principal is appended to the scope after a hash; an empty string means none (REQ-HTTP-5).
	Principal func(*http.Request) string
	// RequirePrincipal makes an empty principal a 500 missing-principal (Q18). New panics when it is set without Principal.
	RequirePrincipal bool
	// Fingerprint mode (D9). Default body. FingerprintFunc overrides both modes.
	Fingerprint     FingerprintMode
	FingerprintFunc func(*http.Request, []byte) (string, error)
	// MaxRequestBytes bounds the body the layer reads; larger bodies are 413 (REQ-HTTP-6). Default 1 MiB.
	MaxRequestBytes int64
	// StoreHeaders is the response header allowlist (REQ-HTTP-8).
	StoreHeaders []string
	// Policy is the engine policy (lease, TTL, cap, StoreResult, OnStoreError, Clock, Hooks). Zero values take
	// anyonce.DefaultPolicy values.
	Policy anyonce.Policy
	// ProblemBaseURI is D11. DocsURL is the Link target on a 400 missing-key; default ProblemBaseURI plus missing-key.
	ProblemBaseURI string
	DocsURL        string
	// OnError renders a problem differently (REQ-HTTP-13). Status and code must not change.
	OnError func(w http.ResponseWriter, r *http.Request, p Problem)
	// Skip opts a request out (REQ-HTTP-15).
	Skip func(*http.Request) bool
}

type resolved struct {
	Options
	methods      map[string]bool
	storeHeaders map[string]bool
}

func (o Options) resolve() resolved {
	r := resolved{Options: o, methods: map[string]bool{}, storeHeaders: map[string]bool{}}
	methods := o.Methods
	if len(methods) == 0 {
		methods = DefaultMethods
	}
	for _, m := range methods {
		r.methods[strings.ToUpper(m)] = true
	}
	headers := o.StoreHeaders
	if headers == nil {
		headers = DefaultStoreHeaders
	}
	for _, h := range headers {
		r.storeHeaders[http.CanonicalHeaderKey(h)] = true
	}
	if r.HeaderName == "" {
		r.HeaderName = DefaultHeaderName
	}
	if r.KeySyntax == "" {
		r.KeySyntax = anyonce.SyntaxLenient
	}
	if r.Fingerprint == "" {
		r.Fingerprint = FingerprintBody
	}
	if r.MaxRequestBytes <= 0 {
		r.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if r.ProblemBaseURI == "" {
		r.ProblemBaseURI = DefaultProblemBaseURI
	}
	if r.DocsURL == "" {
		r.DocsURL = r.ProblemBaseURI + string(CodeMissingKey)
	}
	return r
}
```

`go/httpmw/problems.go`:

```go
package httpmw

import (
	"encoding/json"
	"net/http"
)

// Code is a D11 problem code. CodeMissingPrincipal is the Q18 addition.
type Code string

const (
	CodeMissingKey          Code = "missing-key"
	CodeInvalidKey          Code = "invalid-key"
	CodeConflict            Code = "conflict"
	CodeFingerprintMismatch Code = "fingerprint-mismatch"
	CodePayloadTooLarge     Code = "payload-too-large"
	CodeStoreUnavailable    Code = "store-unavailable"
	CodeMissingPrincipal    Code = "missing-principal"
)

var problemStatus = map[Code]int{
	CodeMissingKey:          http.StatusBadRequest,
	CodeInvalidKey:          http.StatusBadRequest,
	CodeConflict:            http.StatusConflict,
	CodeFingerprintMismatch: http.StatusUnprocessableEntity,
	CodePayloadTooLarge:     http.StatusRequestEntityTooLarge,
	CodeStoreUnavailable:    http.StatusServiceUnavailable,
	CodeMissingPrincipal:    http.StatusInternalServerError,
}

var problemTitle = map[Code]string{
	CodeMissingKey:          "The Idempotency-Key header is required for this request",
	CodeInvalidKey:          "The Idempotency-Key header value is not a valid key",
	CodeConflict:            "A request with this Idempotency-Key is still in progress",
	CodeFingerprintMismatch: "This Idempotency-Key was already used with a different request payload",
	CodePayloadTooLarge:     "The request body exceeds the size this idempotent endpoint accepts",
	CodeStoreUnavailable:    "The idempotency store is unavailable",
	CodeMissingPrincipal:    "The idempotency scope requires a principal and none was found",
}

// Problem is an RFC 9457 problem details document with the anyonce code member (D10).
type Problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
	Code   Code   `json:"code"`
}

// NewProblem builds the problem for a code. detail may be empty and never carries the key value.
func NewProblem(code Code, baseURI, detail string) Problem {
	return Problem{Type: baseURI + string(code), Title: problemTitle[code], Status: problemStatus[code], Detail: detail, Code: code}
}

// WriteProblem writes p as application/problem+json. extra headers (Link, Retry-After) are set before the status.
func WriteProblem(w http.ResponseWriter, p Problem, extra http.Header) {
	h := w.Header()
	for name, values := range extra {
		h[http.CanonicalHeaderKey(name)] = values
	}
	h.Set("Content-Type", "application/problem+json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}
```

- [ ] **Step 4: Implement request.go and context.go**

`go/httpmw/request.go`:

```go
package httpmw

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
)

type keyStatus int

const (
	keyMissing keyStatus = iota
	keyInvalid
	keyOK
)

var errTooLarge = errors.New("httpmw: request body exceeds MaxRequestBytes")

// lookupKey is REQ-HTTP-2: case-insensitive lookup; a repeated field is invalid; the reason never carries the value.
func lookupKey(h http.Header, name string, syntax anyonce.Syntax) (string, keyStatus, string) {
	values := h.Values(name)
	if len(values) == 0 {
		return "", keyMissing, ""
	}
	if len(values) > 1 {
		return "", keyInvalid, "the " + name + " header field is repeated"
	}
	key, err := anyonce.ParseKey(values[0], syntax)
	if err != nil {
		return "", keyInvalid, err.Error()
	}
	return key, keyOK, ""
}

// requestPath is D9: path plus query.
func requestPath(r *http.Request) string { return r.URL.RequestURI() }

// defaultScope is D8 without a route pattern.
func defaultScope(r *http.Request) string { return r.Method + " " + r.URL.Path }

func resolveScope(r *http.Request, o resolved) (string, bool) {
	scope := defaultScope(r)
	if o.Scope != nil {
		scope = o.Scope(r)
	}
	if o.Principal == nil {
		return scope, true
	}
	principal := o.Principal(r)
	if principal == "" {
		if o.RequirePrincipal {
			return "", false
		}
		return scope, true
	}
	return scope + "#" + principal, true
}

// readBody reads at most max bytes plus one, then re-supplies the bytes to the handler (REQ-HTTP-6).
func readBody(r *http.Request, max int64) ([]byte, error) {
	if r.ContentLength > max {
		return nil, errTooLarge
	}
	if r.Body == nil || r.Body == http.NoBody {
		return []byte{}, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("httpmw: read body: %w", err)
	}
	_ = r.Body.Close()
	if int64(len(body)) > max {
		return nil, errTooLarge
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}

// fingerprint is D9 and REQ-HTTP-6.
func fingerprint(r *http.Request, body []byte, o resolved) (string, error) {
	if o.FingerprintFunc != nil {
		return o.FingerprintFunc(r, body)
	}
	if o.Fingerprint == FingerprintJCS {
		var value any
		if err := json.Unmarshal(body, &value); err == nil {
			if canonical, err := anyonce.Canonicalize(value); err == nil {
				return anyonce.SHA256Hex([]byte(r.Method + "\n" + requestPath(r) + "\n" + string(canonical))), nil
			}
		}
	}
	return anyonce.HTTPFingerprint(r.Method, requestPath(r), body), nil
}
```

`go/httpmw/context.go`:

```go
package httpmw

import "context"

type ctxKey struct{}

type info struct {
	key   string
	fence int64
}

func withInfo(ctx context.Context, key string, fence int64) context.Context {
	return context.WithValue(ctx, ctxKey{}, info{key: key, fence: fence})
}

// KeyFromContext returns the idempotency key the handler runs under (REQ-HTTP-14).
func KeyFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(info)
	return v.key, ok
}

// FenceFromContext returns the fence of the claim the handler runs under (REQ-HTTP-14).
func FenceFromContext(ctx context.Context) (int64, bool) {
	v, ok := ctx.Value(ctxKey{}).(info)
	return v.fence, ok
}
```

- [ ] **Step 5: Run the tests, vet, lint**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./httpmw/`, `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS, clean, 0 issues. If golangci-lint flags the `max` parameter name as shadowing the builtin, rename it to `limit`.

- [ ] **Step 6: Commit**

```bash
git add go/httpmw
git commit -m "feat(go): REQ-HTTP-1..6 httpmw options, problem details, request helpers and context accessors"
```

---

### Task 10: Go response capture, the middleware and the streaming proof (REQ-HTTP-7..12, REQ-HTTP-18, REQ-CORE-1 fence)

**Files:**
- Create: `go/httpmw/writer.go`, `go/httpmw/middleware.go`, `go/httpmw/writer_test.go`, `go/httpmw/middleware_test.go`
- Modify: `go/anyonce/engine.go` (`run(ctx, fence)`), `go/anyonce/engine_test.go` (the `run` helper and one new subtest)

**Interfaces:**
- Consumes: Task 9; `anyonce.Execute`, `anyonce.Result`, `anyonce.Record`, `anyonce.StoredResult`.
- Produces: `Middleware`, `New(store, opts) *Middleware`, `(*Middleware).Handler(next) http.Handler`. Tasks 11 and 12 consume them.

- [ ] **Step 1: Engine change, test first**

In `go/anyonce/engine_test.go` the helper that builds `run` closures must accept the new signature `func(ctx context.Context, fence int64) (anyonce.StoredResult, error)`; update it and every inline `run` literal. Add to `TestExecute`:

```go
	t.Run("REQ-CORE-1: run receives the fence of the acquired claim and 0 under fail-open", func(t *testing.T) {
		var fences []int64
		record := func(_ context.Context, fence int64) (anyonce.StoredResult, error) {
			fences = append(fences, fence)
			return okResult, nil
		}
		if _, err := anyonce.Execute(ctx, &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 7}}, op, record, anyonce.DefaultPolicy()); err != nil {
			t.Fatal(err)
		}
		open := anyonce.DefaultPolicy()
		open.OnStoreError = anyonce.FailOpen
		if _, err := anyonce.Execute(ctx, &fakeStore{beginErr: errors.New("down")}, op, record, open); err != nil {
			t.Fatal(err)
		}
		if len(fences) != 2 || fences[0] != 7 || fences[1] != 0 {
			t.Fatalf("fences %v", fences)
		}
	})
```

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./anyonce/`
Expected: compile error (signature).

In `go/anyonce/engine.go` change `Execute`'s parameter to `run func(ctx context.Context, fence int64) (StoredResult, error)`, document that fence is 0 without a claim, and pass `0` on the fail-open path and `outcome.Fence` on the acquired path.

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./anyonce/` and `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`
Expected: PASS; 100 percent.

- [ ] **Step 2: Write the failing middleware tests**

`go/httpmw/writer_test.go`:

```go
package httpmw

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCaptureWriter(t *testing.T) {
	t.Run("REQ-HTTP-7: passes writes through and buffers at most the cap plus one byte", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := &captureWriter{ResponseWriter: rec, limit: 5}
		w.Header().Set("Content-Type", "text/plain")
		for _, part := range []string{"aaaa", "bbbb", "cccc"} {
			if _, err := w.Write([]byte(part)); err != nil {
				t.Fatal(err)
			}
		}
		if rec.Body.String() != "aaaabbbbcccc" || rec.Code != 200 {
			t.Fatalf("%d %q", rec.Code, rec.Body.String())
		}
		if !w.overCap || w.buf.Len() != 6 {
			t.Fatalf("overCap %v buffered %d", w.overCap, w.buf.Len())
		}
		res := w.result(map[string]bool{"Content-Type": true})
		if res.Kind != "http" || res.Status != 200 || len(res.Body) != 6 || len(res.Headers) != 1 || res.Headers[0] != [2]string{"Content-Type", "text/plain"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-8: result keeps allowlisted headers, repeats values, and never Set-Cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := &captureWriter{ResponseWriter: rec, limit: 10}
		w.Header().Add("Link", "<a>")
		w.Header().Add("Link", "<b>")
		w.Header().Set("Set-Cookie", "a=1")
		w.Header().Set("X-Other", "1")
		w.WriteHeader(201)
		res := w.result(map[string]bool{"Link": true, "Set-Cookie": true})
		if res.Status != 201 || len(res.Headers) != 2 || res.Headers[0] != [2]string{"Link", "<a>"} || res.Headers[1] != [2]string{"Link", "<b>"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-18: Flush reaches the underlying writer and Unwrap exposes it for http.ResponseController", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := &captureWriter{ResponseWriter: rec, limit: 10}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Fatal(err)
		}
		if !rec.Flushed {
			t.Fatal("not flushed")
		}
	})
}
```

`go/httpmw/middleware_test.go`:

```go
package httpmw_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

type counting struct {
	calls  atomic.Int64
	status int
	header map[string]string
}

func (c *counting) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n := c.calls.Add(1)
	body, _ := io.ReadAll(r.Body)
	for k, v := range c.header {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "text/plain")
	key, _ := httpmw.KeyFromContext(r.Context())
	fence, _ := httpmw.FenceFromContext(r.Context())
	w.WriteHeader(c.status)
	_, _ = io.WriteString(w, "r"+string(rune('0'+n))+":"+string(body)+":"+key+":"+string(rune('0'+fence)))
}

func post(h http.Handler, path, key, body string, extra map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func problemCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("content type %q", ct)
	}
	var p struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return p.Code
}

type failingStore struct{}

func (failingStore) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{}, errors.New("down")
}
func (failingStore) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}
func (failingStore) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}
func (failingStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, errors.New("down")
}
func (failingStore) Purge(context.Context, time.Time) (int, error) { return 0, errors.New("down") }

func TestMiddleware(t *testing.T) {
	t.Run("REQ-HTTP-18: the first request runs, the duplicate replays with Idempotency-Replayed, the handler sees key and fence", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(c)
		first := post(h, "/p", "k", "b", nil)
		if first.Code != 201 || first.Body.String() != "r1:b:k:1" {
			t.Fatalf("%d %q", first.Code, first.Body.String())
		}
		replay := post(h, "/p", "k", "b", nil)
		if replay.Code != 201 || replay.Body.String() != "r1:b:k:1" || replay.Header().Get("Idempotency-Replayed") != "true" || replay.Header().Get("Content-Type") != "text/plain" {
			t.Fatalf("%d %q %v", replay.Code, replay.Body.String(), replay.Header())
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-1: GET passes through and a configured method is covered", func(t *testing.T) {
		c := &counting{status: 200}
		h := httpmw.New(memory.New(), httpmw.Options{Methods: []string{"PUT"}}).Handler(c)
		for range 2 {
			req := httptest.NewRequest(http.MethodGet, "/p", nil)
			req.Header.Set("Idempotency-Key", "k")
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		post(h, "/p", "k", "b", nil)
		post(h, "/p", "k", "b", nil)
		if c.calls.Load() != 4 {
			t.Fatal(c.calls.Load())
		}
		for range 2 {
			req := httptest.NewRequest(http.MethodPut, "/p", strings.NewReader("b"))
			req.Header.Set("Idempotency-Key", "k")
			h.ServeHTTP(httptest.NewRecorder(), req)
		}
		if c.calls.Load() != 5 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-3: a missing key passes through by default and is 400 missing-key with a Link when required", func(t *testing.T) {
		c := &counting{status: 201}
		if rec := post(httpmw.New(memory.New(), httpmw.Options{}).Handler(c), "/p", "", "b", nil); rec.Code != 201 {
			t.Fatal(rec.Code)
		}
		rec := post(httpmw.New(memory.New(), httpmw.Options{Required: true, DocsURL: "https://d.test/keys"}).Handler(c), "/p", "", "b", nil)
		if rec.Code != 400 || problemCode(t, rec) != "missing-key" || rec.Header().Get("Link") != "<https://d.test/keys>; rel=\"describedby\"" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-2: a repeated header is 400 invalid-key", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(&counting{status: 201})
		req := httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("b"))
		req.Header.Add("Idempotency-Key", "one")
		req.Header.Add("Idempotency-Key", "two")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 400 || problemCode(t, rec) != "invalid-key" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-5: principals isolate keys and a required missing principal is 500 missing-principal", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{Principal: func(r *http.Request) string { return r.Header.Get("X-Tenant") }, RequirePrincipal: true}).Handler(c)
		post(h, "/p", "k", "b", map[string]string{"X-Tenant": "a"})
		post(h, "/p", "k", "b", map[string]string{"X-Tenant": "b"})
		if c.calls.Load() != 2 {
			t.Fatal(c.calls.Load())
		}
		if rec := post(h, "/p", "k", "b", nil); rec.Code != 500 || problemCode(t, rec) != "missing-principal" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-5: New panics when RequirePrincipal is set without Principal", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		httpmw.New(memory.New(), httpmw.Options{RequirePrincipal: true})
	})
	t.Run("REQ-HTTP-6: a body over MaxRequestBytes is 413 and jcs mode equates reordered JSON", func(t *testing.T) {
		c := &counting{status: 201}
		if rec := post(httpmw.New(memory.New(), httpmw.Options{MaxRequestBytes: 4}).Handler(c), "/p", "k", "abcde", nil); rec.Code != 413 || problemCode(t, rec) != "payload-too-large" {
			t.Fatal(rec.Code)
		}
		h := httpmw.New(memory.New(), httpmw.Options{Fingerprint: httpmw.FingerprintJCS}).Handler(c)
		post(h, "/p", "k", `{"a":1,"b":2}`, nil)
		if rec := post(h, "/p", "k", `{"b":2,"a":1}`, nil); rec.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatal("expected replay")
		}
		if c.calls.Load() != 1 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-8: Set-Cookie is never stored and a stored Location replays", func(t *testing.T) {
		store := memory.New()
		c := &counting{status: 202, header: map[string]string{"Set-Cookie": "a=1", "Location": "/orders/1"}}
		h := httpmw.New(store, httpmw.Options{StoreHeaders: []string{"Set-Cookie", "Location"}}).Handler(c)
		post(h, "/p", "k", "b", nil)
		rec := post(h, "/p", "k", "b", nil)
		if rec.Code != 202 || rec.Header().Get("Location") != "/orders/1" || rec.Header().Get("Set-Cookie") != "" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
	})
	t.Run("REQ-HTTP-9: a result over MaxResultBytes replays with an empty body and Idempotency-Replay omitted", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{Policy: anyonce.Policy{MaxResultBytes: 1}}).Handler(&counting{status: 201})
		post(h, "/p", "k", "b", nil)
		rec := post(h, "/p", "k", "b", nil)
		if rec.Code != 201 || rec.Header().Get("Idempotency-Replay") != "omitted" || rec.Body.Len() != 0 {
			t.Fatalf("%d %v %q", rec.Code, rec.Header(), rec.Body.String())
		}
	})
	t.Run("REQ-HTTP-10: an in-flight duplicate is 409 conflict with Retry-After from the lease", func(t *testing.T) {
		var nowMs atomic.Int64
		nowMs.Store(1_000_000)
		gate := make(chan struct{})
		acquired := make(chan struct{}, 1)
		policy := anyonce.Policy{Lease: 30 * time.Second, Clock: func() time.Time { return time.UnixMilli(nowMs.Load()) }, Hooks: anyonce.Hooks{OnAcquired: func(anyonce.Operation) { acquired <- struct{}{} }}}
		h := httpmw.New(memory.New(), httpmw.Options{Policy: policy}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			<-gate
			_, _ = io.WriteString(w, "done")
		}))
		done := make(chan *httptest.ResponseRecorder, 1)
		go func() { done <- post(h, "/p", "k", "b", nil) }()
		<-acquired
		nowMs.Add(4500)
		dup := post(h, "/p", "k", "b", nil)
		if dup.Code != 409 || dup.Header().Get("Retry-After") != "26" || problemCode(t, dup) != "conflict" {
			t.Fatalf("%d %v", dup.Code, dup.Header())
		}
		close(gate)
		if first := <-done; first.Body.String() != "done" {
			t.Fatal(first.Body.String())
		}
	})
	t.Run("REQ-HTTP-11: a different body under the same key is 422 fingerprint-mismatch", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(&counting{status: 201})
		post(h, "/p", "k", "one", nil)
		if rec := post(h, "/p", "k", "two", nil); rec.Code != 422 || problemCode(t, rec) != "fingerprint-mismatch" {
			t.Fatal(rec.Code)
		}
	})
	t.Run("REQ-HTTP-12: fail-closed is 503 store-unavailable with Retry-After 1; fail-open runs and marks Idempotency-Degraded", func(t *testing.T) {
		c := &counting{status: 201}
		rec := post(httpmw.New(failingStore{}, httpmw.Options{}).Handler(c), "/p", "k", "b", nil)
		if rec.Code != 503 || rec.Header().Get("Retry-After") != "1" || problemCode(t, rec) != "store-unavailable" || c.calls.Load() != 0 {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		open := post(httpmw.New(failingStore{}, httpmw.Options{Policy: anyonce.Policy{OnStoreError: anyonce.FailOpen}}).Handler(c), "/p", "k", "b", nil)
		if open.Code != 201 || open.Header().Get("Idempotency-Degraded") != "true" || c.calls.Load() != 1 {
			t.Fatalf("%d %v", open.Code, open.Header())
		}
	})
	t.Run("REQ-HTTP-13: OnError renders every problem", func(t *testing.T) {
		h := httpmw.New(memory.New(), httpmw.Options{Required: true, OnError: func(w http.ResponseWriter, _ *http.Request, p httpmw.Problem) {
			w.WriteHeader(p.Status)
			_, _ = io.WriteString(w, "custom:"+string(p.Code))
		}}).Handler(&counting{status: 201})
		if rec := post(h, "/p", "", "b", nil); rec.Code != 400 || rec.Body.String() != "custom:missing-key" {
			t.Fatalf("%d %q", rec.Code, rec.Body.String())
		}
	})
	t.Run("REQ-HTTP-15: Skip opts a request out", func(t *testing.T) {
		c := &counting{status: 201}
		h := httpmw.New(memory.New(), httpmw.Options{Skip: func(r *http.Request) bool { return r.URL.Path == "/reset" }}).Handler(c)
		post(h, "/reset", "k", "b", nil)
		post(h, "/reset", "k", "b", nil)
		if c.calls.Load() != 2 {
			t.Fatal(c.calls.Load())
		}
	})
	t.Run("REQ-HTTP-7: a 5xx is not stored so the retry executes again", func(t *testing.T) {
		c := &counting{status: 500}
		h := httpmw.New(memory.New(), httpmw.Options{}).Handler(c)
		post(h, "/p", "k", "b", nil)
		if rec := post(h, "/p", "k", "b", nil); rec.Header().Get("Idempotency-Replayed") != "" || c.calls.Load() != 2 {
			t.Fatal("expected a second execution")
		}
	})
}

func TestStreaming(t *testing.T) {
	t.Run("REQ-HTTP-7: the client reads the first chunk before the handler finishes and EOF only after the record is complete", func(t *testing.T) {
		store := memory.New()
		gate := make(chan struct{})
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, "first")
			if err := http.NewResponseController(w).Flush(); err != nil {
				panic(err)
			}
			<-gate
			_, _ = io.WriteString(w, "second")
		}))
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/stream", strings.NewReader("b"))
		req.Header.Set("Idempotency-Key", "k1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		r := bufio.NewReader(res.Body)
		first := make([]byte, 5)
		if _, err := io.ReadFull(r, first); err != nil || string(first) != "first" {
			t.Fatalf("%q %v", first, err)
		}
		rec, _ := store.Get(context.Background(), "POST /stream", "k1", time.Now())
		if rec == nil || rec.State != anyonce.StateInFlight {
			t.Fatalf("record %+v", rec)
		}
		close(gate)
		rest, err := io.ReadAll(r)
		if err != nil || string(rest) != "second" {
			t.Fatalf("%q %v", rest, err)
		}
		rec, _ = store.Get(context.Background(), "POST /stream", "k1", time.Now())
		if rec == nil || rec.State != anyonce.StateCompleted || string(rec.Result.Body) != "firstsecond" {
			t.Fatalf("record %+v", rec)
		}
	})
	t.Run("REQ-HTTP-18: a hijacked connection passes through and the claim is abandoned", func(t *testing.T) {
		store := memory.New()
		h := httpmw.New(store, httpmw.Options{}).Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				panic(err)
			}
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nhijacked")
			_ = conn.Close()
		}))
		srv := httptest.NewServer(h)
		defer srv.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/h", strings.NewReader("b"))
		req.Header.Set("Idempotency-Key", "k2")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if string(body) != "hijacked" {
			t.Fatal(string(body))
		}
		if rec, _ := store.Get(context.Background(), "POST /h", "k2", time.Now()); rec != nil {
			t.Fatalf("record should be abandoned, got %+v", rec)
		}
	})
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./httpmw/`
Expected: build failure (`captureWriter`, `New`, `Handler` undefined).

- [ ] **Step 4: Implement writer.go**

```go
package httpmw

import (
	"bufio"
	"bytes"
	"net"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
)

// captureWriter streams every write to the client while buffering a copy up to limit plus one byte (REQ-HTTP-7).
// It forwards Flush, Hijack (which disables idempotency for the request) and Unwrap for http.ResponseController.
type captureWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	buf         bytes.Buffer
	limit       int
	overCap     bool
	hijacked    bool
}

func (w *captureWriter) WriteHeader(code int) {
	if w.wroteHeader {
		return
	}
	w.status = code
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *captureWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if !w.overCap {
		room := w.limit + 1 - w.buf.Len()
		if len(p) >= room {
			w.buf.Write(p[:room])
			w.overCap = true
		} else {
			w.buf.Write(p)
		}
	}
	return w.ResponseWriter.Write(p)
}

func (w *captureWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		if !w.wroteHeader {
			w.WriteHeader(http.StatusOK)
		}
		f.Flush()
	}
}

func (w *captureWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	w.hijacked = true
	return h.Hijack()
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *captureWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// result builds the StoredResult after the handler returned: allowlisted headers in canonical form, every value of a
// repeated header, never Set-Cookie, and the buffered body (over the cap by one byte when the response was larger).
func (w *captureWriter) result(allow map[string]bool) anyonce.StoredResult {
	status := w.status
	if !w.wroteHeader {
		status = http.StatusOK
	}
	res := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: status, Headers: [][2]string{}}
	for _, name := range sortedKeys(w.Header()) {
		if name == "Set-Cookie" || !allow[name] {
			continue
		}
		for _, value := range w.Header()[name] {
			res.Headers = append(res.Headers, [2]string{name, value})
		}
	}
	res.Body = append([]byte(nil), w.buf.Bytes()...)
	return res
}
```

Add a small `sortedKeys(h http.Header) []string` helper (uses `sort.Strings`) at the bottom of the file so the header order is deterministic.

- [ ] **Step 5: Implement middleware.go**

```go
package httpmw

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

var errHijacked = errors.New("httpmw: connection hijacked")

// Middleware is the HTTP door for net/http (REQ-HTTP-18).
type Middleware struct {
	store anyonce.Store
	opts  resolved
}

// New builds the middleware. It panics when Options.RequirePrincipal is set without Options.Principal, the
// startup-time half of REQ-HTTP-5.
func New(store anyonce.Store, opts Options) *Middleware {
	if opts.RequirePrincipal && opts.Principal == nil {
		panic("httpmw: Options.RequirePrincipal is true but Options.Principal is nil")
	}
	return &Middleware{store: store, opts: opts.resolve()}
}

func (m *Middleware) fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	p := NewProblem(code, m.opts.ProblemBaseURI, detail)
	if m.opts.OnError != nil {
		m.opts.OnError(w, r, p)
		return
	}
	WriteProblem(w, p, extra)
}

func retryAfter(leaseUntil time.Time, policy anyonce.Policy) string {
	now := time.Now()
	if policy.Clock != nil {
		now = policy.Clock()
	}
	seconds := int64(math.Ceil(leaseUntil.Sub(now).Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}

// writeReplay is REQ-HTTP-9 and D12.
func writeReplay(w http.ResponseWriter, rec *anyonce.Record) {
	h := w.Header()
	status := http.StatusOK
	var body []byte
	if rec.Result != nil {
		if rec.Result.Status != 0 {
			status = rec.Result.Status
		}
		for _, kv := range rec.Result.Headers {
			h.Add(kv[0], kv[1])
		}
		if !rec.ResultOmitted {
			body = rec.Result.Body
		}
	}
	h.Set("Idempotency-Replayed", "true")
	if rec.ResultOmitted {
		h.Set("Idempotency-Replay", "omitted")
	}
	if len(body) > 0 {
		h.Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Handler wraps next (REQ-HTTP-18).
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.opts.methods[r.Method] || (m.opts.Skip != nil && m.opts.Skip(r)) {
			next.ServeHTTP(w, r)
			return
		}
		key, status, reason := lookupKey(r.Header, m.opts.HeaderName, m.opts.KeySyntax)
		switch status {
		case keyMissing:
			if !m.opts.Required {
				next.ServeHTTP(w, r)
				return
			}
			m.fail(w, r, CodeMissingKey, "", http.Header{"Link": {"<" + m.opts.DocsURL + ">; rel=\"describedby\""}})
			return
		case keyInvalid:
			m.fail(w, r, CodeInvalidKey, reason, nil)
			return
		case keyOK:
		}
		scope, ok := resolveScope(r, m.opts)
		if !ok {
			m.fail(w, r, CodeMissingPrincipal, "", nil)
			return
		}
		body, err := readBody(r, m.opts.MaxRequestBytes)
		if errors.Is(err, errTooLarge) {
			m.fail(w, r, CodePayloadTooLarge, "", nil)
			return
		}
		if err != nil {
			http.Error(w, "httpmw: could not read the request body", http.StatusBadRequest)
			return
		}
		fp, err := fingerprint(r, body, m.opts)
		if err != nil {
			http.Error(w, "httpmw: fingerprint failed", http.StatusInternalServerError)
			return
		}
		op := anyonce.Operation{Scope: scope, Key: key, Fingerprint: fp}

		// A store failure before the handler runs (fail-open) must show on the response (REQ-HTTP-12), so the
		// hook flips a flag that run reads before the handler writes anything.
		var degraded atomic.Bool
		policy := m.opts.Policy
		userHook := policy.Hooks.OnStoreError
		policy.Hooks.OnStoreError = func(op anyonce.Operation, err error) {
			degraded.Store(true)
			if userHook != nil {
				userHook(op, err)
			}
		}
		limit := policy.MaxResultBytes
		if limit <= 0 {
			limit = anyonce.DefaultPolicy().MaxResultBytes
		}
		cw := &captureWriter{ResponseWriter: w, limit: limit}

		res, err := anyonce.Execute(r.Context(), m.store, op, func(ctx context.Context, fence int64) (anyonce.StoredResult, error) {
			if degraded.Load() {
				w.Header().Set("Idempotency-Degraded", "true")
			}
			next.ServeHTTP(cw, r.WithContext(withInfo(ctx, key, fence)))
			if cw.hijacked {
				return anyonce.StoredResult{}, errHijacked
			}
			return cw.result(m.opts.storeHeaders), nil
		}, policy)
		if err != nil {
			switch {
			case errors.Is(err, errHijacked):
			case res.Kind == anyonce.ResultStoreError:
				m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
			case !cw.wroteHeader:
				http.Error(w, "httpmw: idempotency failed", http.StatusInternalServerError)
			}
			return
		}
		switch res.Kind {
		case anyonce.ResultExecuted:
		case anyonce.ResultReplayed:
			writeReplay(w, res.Record)
		case anyonce.ResultConflict:
			m.fail(w, r, CodeConflict, "", http.Header{"Retry-After": {retryAfter(res.LeaseUntil, policy)}})
		case anyonce.ResultMismatch:
			m.fail(w, r, CodeFingerprintMismatch, "", nil)
		case anyonce.ResultStoreError:
			m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		}
	})
}
```

- [ ] **Step 6: Run the tests, vet, lint, coverage**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`, `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= sh -c 'cd go && golangci-lint run'`, `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`
Expected: PASS, clean, 0 issues, 100 percent. If golangci-lint's `exhaustive` or `gocritic` rules flag the empty `case` arms, add `// handled above` comments or restructure with explicit `return` statements; do not disable the linter.

- [ ] **Step 7: Commit**

```bash
git add go/anyonce go/httpmw
git commit -m "feat(go): REQ-HTTP-18 httpmw with streaming capture, replay, problems and hijack passthrough; run receives the fence"
```

---

### Task 11: Go conformance runner (REQ-CONF-6) and every vector green through `httpmw`

**Files:**
- Create: `go/conformance/doc.go`, `go/conformance/vector.go`, `go/conformance/load.go`, `go/conformance/expect.go`, `go/conformance/run.go`, `go/conformance/report.go`, `go/conformance/testing.go`, `go/conformance/load_test.go`, `go/conformance/expect_test.go`, `go/conformance/run_test.go`, `go/conformance/report_test.go`, `go/conformance/testing_test.go`, `go/httpmw/conformance_test.go`

**Interfaces:**
- Produces: `Vector`, `Step`, `StepRequest`, `StepExpect`, `HeaderExpectation`, `BodyEquals`, `LoadVectors(dir)`, `DefaultVectorsDir()`, `Options`, `Summary`, `VectorResult`, `StepOutcome`, `RunVectors(ctx, baseURL, vectors, opts)`, `Format(summary, format, target)`, `Run(t, target, opts)`. Task 12 and P3, P5 consume them.

- [ ] **Step 1: Write the failing tests**

`go/conformance/load_test.go`:

```go
package conformance

import "testing"

func TestLoad(t *testing.T) {
	t.Run("REQ-CONF-6: loads every core and profile vector sorted by id with requires and concurrency parsed", func(t *testing.T) {
		vectors, err := LoadVectors(DefaultVectorsDir())
		if err != nil {
			t.Fatal(err)
		}
		if len(vectors) != 20 {
			t.Fatalf("got %d vectors", len(vectors))
		}
		for i := 1; i < len(vectors); i++ {
			if vectors[i-1].ID >= vectors[i].ID {
				t.Fatalf("not sorted at %d: %s %s", i, vectors[i-1].ID, vectors[i].ID)
			}
		}
		byID := map[string]Vector{}
		for _, v := range vectors {
			byID[v.ID] = v
		}
		if exp := byID["core/expiry-executes-again"]; len(exp.Requires) != 1 || exp.Requires[0] != "short-ttl" || exp.Steps[1].DelayMs != 2500 {
			t.Fatalf("%+v", exp)
		}
		if c := byID["core/concurrent-409"]; len(c.Steps[1].ConcurrentWith) != 1 || c.Steps[1].ConcurrentWith[0] != "original" || *c.Steps[1].Expect.HandlerInvocations != 1 {
			t.Fatalf("%+v", c)
		}
		retry := byID["core/retry-replays"].Steps[1].Expect
		if retry.BodyEquals == nil || retry.BodyEquals.SameAs != "first" {
			t.Fatalf("%+v", retry)
		}
		ra := byID["profile/retry-after-on-409"].Steps[1].Expect.Headers["Retry-After"]
		if ra.Regex != "^[1-9][0-9]*$" || ra.Exact != nil {
			t.Fatalf("%+v", ra)
		}
		absent := byID["profile/5xx-not-stored"].Steps[1].Expect.Headers["Idempotency-Replayed"]
		if !absent.Absent {
			t.Fatalf("%+v", absent)
		}
		if got := byID["core/get-ignored"].Steps[0].Expect.BodyJSON["count"]; got != float64(0) {
			t.Fatalf("%v", got)
		}
	})
}
```

`go/conformance/expect_test.go`:

```go
package conformance

import (
	"net/http"
	"testing"
)

func str(s string) *string { return &s }
func num(n int) *int       { return &n }

func TestEvaluate(t *testing.T) {
	obs := observed{status: 201, header: http.Header{"Content-Type": {"text/plain"}, "Idempotency-Replayed": {"true"}}, body: []byte("hello")}
	t.Run("REQ-CONF-6: an exact match yields no failures", func(t *testing.T) {
		exp := StepExpect{Status: 201, Headers: map[string]HeaderExpectation{"content-type": {Exact: str("text/plain")}, "Idempotency-Replayed": {Present: true}, "Retry-After": {Absent: true}}, BodyEquals: &BodyEquals{Exact: str("hello")}, BodyBytes: num(5)}
		if got := evaluate(exp, obs, evalContext{}); len(got) != 0 {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CONF-6: failure messages mirror the TypeScript runner", func(t *testing.T) {
		one := 1
		exp := StepExpect{Status: 200, Headers: map[string]HeaderExpectation{"Retry-After": {Regex: "^[1-9]"}, "Idempotency-Replayed": {Absent: true}, "X-Missing": {Exact: str("v")}}, BodyEquals: &BodyEquals{SameAs: "first"}, BodyBytes: num(3), HandlerInvocations: &one}
		got := evaluate(exp, obs, evalContext{prior: map[string][]byte{"first": []byte("other")}, invocations: num(2)})
		want := map[string]bool{
			"status: expected 200, got 201":                                                         true,
			"header Retry-After: expected /^[1-9]/, got absent":                                      true,
			"header Idempotency-Replayed: expected absent, got \"true\"":                             true,
			"header X-Missing: expected \"v\", got absent":                                           true,
			"body: expected same bytes as step first (5 bytes), got 5 bytes that differ":             true,
			"body: expected 3 bytes, got 5":                                                          true,
			"handlerInvocations: expected 1, got 2":                                                  true,
		}
		if len(got) != len(want) {
			t.Fatalf("%v", got)
		}
		for _, g := range got {
			if !want[g] {
				t.Fatalf("unexpected %q in %v", g, got)
			}
		}
		if got := evaluate(StepExpect{Status: 201, HandlerInvocations: &one}, obs, evalContext{}); len(got) != 1 || got[0] != "handlerInvocations: counter unavailable" {
			t.Fatal(got)
		}
	})
	t.Run("REQ-CONF-6: bodyJson compares members of a JSON object", func(t *testing.T) {
		json := observed{status: 200, header: http.Header{}, body: []byte(`{"count":1,"code":"x"}`)}
		if got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"count": float64(1), "code": "x"}}, json, evalContext{}); len(got) != 0 {
			t.Fatal(got)
		}
		if got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"count": float64(0)}}, json, evalContext{}); len(got) != 1 || got[0] != "body.count: expected 0, got 1" {
			t.Fatal(got)
		}
		if got := evaluate(StepExpect{Status: 200, BodyJSON: map[string]any{"a": float64(1)}}, obs, evalContext{}); len(got) != 1 || got[0] != "body: expected JSON object, got unparseable body" {
			t.Fatal(got)
		}
	})
}
```

`go/conformance/run_test.go`:

```go
package conformance

import (
	"context"
	"net/http/httptest"
	"sort"
	"testing"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

var barePass = []string{"core/expiry-executes-again", "core/get-ignored", "core/post-executes-once", "core/two-keys-execute-twice", "profile/5xx-not-stored"}

func TestRunVectors(t *testing.T) {
	t.Run("REQ-CONF-6: against the bare fixture only the execution-only vectors pass and nothing errors", func(t *testing.T) {
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		vectors, err := LoadVectors(DefaultVectorsDir())
		if err != nil {
			t.Fatal(err)
		}
		summary, err := RunVectors(context.Background(), srv.URL, vectors, Options{Capabilities: []string{"short-ttl"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Results) != 20 || summary.Errored != 0 || summary.NotApplicable != 0 {
			t.Fatalf("%+v", summary)
		}
		var passed []string
		for _, r := range summary.Results {
			if r.Status == "pass" {
				passed = append(passed, r.ID)
			}
		}
		sort.Strings(passed)
		if len(passed) != len(barePass) {
			t.Fatalf("passed %v", passed)
		}
		for i := range passed {
			if passed[i] != barePass[i] {
				t.Fatalf("passed %v", passed)
			}
		}
	})
	t.Run("REQ-CONF-6: a vector with an undeclared capability is not-applicable and tiers and only narrow the run", func(t *testing.T) {
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		vectors, _ := LoadVectors(DefaultVectorsDir())
		summary, err := RunVectors(context.Background(), srv.URL, vectors, Options{Tiers: []string{"core"}, Only: []string{"core/expiry-executes-again", "core/post-executes-once", "profile/replayed-header"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Results) != 2 || summary.NotApplicable != 1 || summary.Passed != 1 {
			t.Fatalf("%+v", summary)
		}
	})
}
```

`go/conformance/report_test.go`:

```go
package conformance

import (
	"encoding/json"
	"strings"
	"testing"
)

func sample() Summary {
	return Summary{Results: []VectorResult{
		{ID: "core/post-executes-once", Tier: "core", Status: "pass", Steps: []StepOutcome{{StepID: "first", Failures: []string{}}}},
		{ID: "core/retry-replays", Tier: "core", Status: "fail", Steps: []StepOutcome{{StepID: "first", Failures: []string{}}, {StepID: "retry", Failures: []string{"status: expected 201, got 409", "body: expected \"<a&b>\""}}}},
		{ID: "core/expiry-executes-again", Tier: "core", Status: "not-applicable", Steps: []StepOutcome{}, Error: "requires short-ttl"},
		{ID: "profile/replayed-header", Tier: "profile", Status: "error", Steps: []StepOutcome{}, Error: "reset returned 500"},
	}, Passed: 1, Failed: 1, NotApplicable: 1, Errored: 1}
}

func TestFormat(t *testing.T) {
	t.Run("REQ-CONF-6: json carries the summary with the TypeScript field names and the target", func(t *testing.T) {
		out, err := Format(sample(), "json", "http://x")
		if err != nil {
			t.Fatal(err)
		}
		var parsed map[string]any
		if err := json.Unmarshal(out, &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed["target"] != "http://x" || parsed["notApplicable"] != float64(1) || parsed["results"].([]any)[1].(map[string]any)["steps"].([]any)[1].(map[string]any)["stepId"] != "retry" {
			t.Fatalf("%v", parsed)
		}
	})
	t.Run("REQ-CONF-6: markdown has the summary line and one row per vector", func(t *testing.T) {
		out, _ := Format(sample(), "markdown", "http://x")
		md := string(out)
		for _, want := range []string{"# anyonce conformance report", "Target: http://x", "1 passed, 1 failed, 1 not applicable, 1 errored", "| Vector | Tier | Status | Details |", "| core/post-executes-once | core | pass |  |", "| core/retry-replays | core | fail | retry: status: expected 201, got 409; retry: body: expected \"<a&b>\" |", "| core/expiry-executes-again | core | not-applicable | requires short-ttl |"} {
			if !strings.Contains(md, want) {
				t.Fatalf("missing %q in\n%s", want, md)
			}
		}
	})
	t.Run("REQ-CONF-6: junit has one testcase per vector with escaped messages", func(t *testing.T) {
		out, _ := Format(sample(), "junit", "")
		xml := string(out)
		for _, want := range []string{`<testsuite name="anyonce-conformance" tests="4" failures="1" errors="1" skipped="1">`, `<testcase classname="core" name="core/post-executes-once"/>`, `<failure message="retry: status: expected 201, got 409; retry: body: expected &quot;&lt;a&amp;b&gt;&quot;"/>`, `<skipped message="requires short-ttl"/>`, `<error message="reset returned 500"/>`} {
			if !strings.Contains(xml, want) {
				t.Fatalf("missing %q in\n%s", want, xml)
			}
		}
		if _, err := Format(sample(), "yaml", ""); err == nil {
			t.Fatal("expected an error for an unknown format")
		}
	})
}
```

`go/conformance/testing_test.go`:

```go
package conformance_test

import (
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
)

func TestRun(t *testing.T) {
	t.Run("REQ-CONF-6: Run accepts an http.Handler and a base URL string and reports per vector subtests", func(t *testing.T) {
		summary := conformance.Run(t, fixture.New().Handler(), conformance.Options{Only: []string{"core/post-executes-once"}})
		if summary.Passed != 1 {
			t.Fatalf("%+v", summary)
		}
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		if s := conformance.Run(t, srv.URL, conformance.Options{Only: []string{"core/two-keys-execute-twice"}}); s.Passed != 1 {
			t.Fatalf("%+v", s)
		}
	})
}
```

`go/httpmw/conformance_test.go`:

```go
package httpmw_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

func TestConformance(t *testing.T) {
	t.Run("REQ-HTTP-18: every core and profile vector passes through httpmw with the memory store", func(t *testing.T) {
		f := fixture.New()
		mw := httpmw.New(memory.New(), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d: %+v", summary.Passed, len(summary.Results), summary.Results)
		}
	})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./conformance/ ./httpmw/`
Expected: build failure.

- [ ] **Step 3: Implement vector.go and load.go**

`go/conformance/doc.go`:

```go
// Package conformance runs the anyonce conformance vectors (conformance/vectors) against an http.Handler or a base
// URL (REQ-CONF-6). It knows nothing about stores (D18).
package conformance
```

`go/conformance/vector.go`:

```go
package conformance

import (
	"encoding/json"
	"fmt"
)

// HeaderExpectation is a string, {present: true}, {absent: true} or {regex}.
type HeaderExpectation struct {
	Exact   *string
	Present bool
	Absent  bool
	Regex   string
}

func (h *HeaderExpectation) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		h.Exact = &s
		return nil
	}
	var obj struct {
		Present bool   `json:"present"`
		Absent  bool   `json:"absent"`
		Regex   string `json:"regex"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return fmt.Errorf("header expectation: %w", err)
	}
	h.Present, h.Absent, h.Regex = obj.Present, obj.Absent, obj.Regex
	return nil
}

// BodyEquals is a string or {sameAs: stepId}.
type BodyEquals struct {
	Exact  *string
	SameAs string
}

func (e *BodyEquals) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		e.Exact = &s
		return nil
	}
	var obj struct {
		SameAs string `json:"sameAs"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return fmt.Errorf("bodyEquals: %w", err)
	}
	e.SameAs = obj.SameAs
	return nil
}

type StepRequest struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
}

type StepExpect struct {
	Status             int                          `json:"status"`
	Headers            map[string]HeaderExpectation `json:"headers"`
	BodyEquals         *BodyEquals                  `json:"bodyEquals"`
	BodyJSON           map[string]any               `json:"bodyJson"`
	BodyBytes          *int                         `json:"bodyBytes"`
	HandlerInvocations *int                         `json:"handlerInvocations"`
}

type Step struct {
	ID             string      `json:"id"`
	DelayMs        int         `json:"delayMs"`
	ConcurrentWith []string    `json:"concurrentWith"`
	Request        StepRequest `json:"request"`
	Expect         StepExpect  `json:"expect"`
}

// Vector mirrors conformance/schema.json (REQ-CONF-1).
type Vector struct {
	ID          string   `json:"id"`
	Tier        string   `json:"tier"`
	Title       string   `json:"title"`
	DraftRef    string   `json:"draftRef"`
	Description string   `json:"description"`
	Requires    []string `json:"requires"`
	Fixture     string   `json:"fixture"`
	Steps       []Step   `json:"steps"`
}
```

`go/conformance/load.go`:

```go
package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// DefaultVectorsDir is conformance/vectors at the repository root, resolved from this file's location. Callers
// outside the repository pass Options.VectorsDir.
func DefaultVectorsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "conformance", "vectors")
}

// LoadVectors reads every core and profile vector under dir, sorted by id.
func LoadVectors(dir string) ([]Vector, error) {
	var vectors []Vector
	for _, tier := range []string{"core", "profile"} {
		entries, err := os.ReadDir(filepath.Join(dir, tier))
		if err != nil {
			return nil, fmt.Errorf("conformance: read %s: %w", tier, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, tier, entry.Name()))
			if err != nil {
				return nil, fmt.Errorf("conformance: read %s: %w", entry.Name(), err)
			}
			var v Vector
			if err := json.Unmarshal(data, &v); err != nil {
				return nil, fmt.Errorf("conformance: parse %s: %w", entry.Name(), err)
			}
			vectors = append(vectors, v)
		}
	}
	sort.Slice(vectors, func(i, j int) bool { return vectors[i].ID < vectors[j].ID })
	return vectors, nil
}
```

- [ ] **Step 4: Implement expect.go**

```go
package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
)

type observed struct {
	status int
	header http.Header
	body   []byte
}

type evalContext struct {
	prior       map[string][]byte
	invocations *int
}

func jsonText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

func checkHeader(name string, exp HeaderExpectation, h http.Header) string {
	actual, present := h[http.CanonicalHeaderKey(name)]
	value := ""
	if present {
		value = actual[0]
	}
	switch {
	case exp.Exact != nil:
		if !present {
			return fmt.Sprintf("header %s: expected %q, got absent", name, *exp.Exact)
		}
		if value != *exp.Exact {
			return fmt.Sprintf("header %s: expected %q, got %q", name, *exp.Exact, value)
		}
	case exp.Present:
		if !present {
			return fmt.Sprintf("header %s: expected present, got absent", name)
		}
	case exp.Absent:
		if present {
			return fmt.Sprintf("header %s: expected absent, got %q", name, value)
		}
	case exp.Regex != "":
		re, err := regexp.Compile(exp.Regex)
		if err != nil {
			return fmt.Sprintf("header %s: invalid regex /%s/", name, exp.Regex)
		}
		if !present {
			return fmt.Sprintf("header %s: expected /%s/, got absent", name, exp.Regex)
		}
		if !re.MatchString(value) {
			return fmt.Sprintf("header %s: expected /%s/, got %q", name, exp.Regex, value)
		}
	}
	return ""
}

// evaluate mirrors packages/conformance/src/expect.ts message for message.
func evaluate(exp StepExpect, obs observed, ctx evalContext) []string {
	failures := []string{}
	if obs.status != exp.Status {
		failures = append(failures, fmt.Sprintf("status: expected %d, got %d", exp.Status, obs.status))
	}
	names := make([]string, 0, len(exp.Headers))
	for name := range exp.Headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if f := checkHeader(name, exp.Headers[name], obs.header); f != "" {
			failures = append(failures, f)
		}
	}
	if exp.BodyEquals != nil {
		switch {
		case exp.BodyEquals.Exact != nil:
			if string(obs.body) != *exp.BodyEquals.Exact {
				failures = append(failures, fmt.Sprintf("body: expected %q, got %q", *exp.BodyEquals.Exact, string(obs.body)))
			}
		default:
			prior, ok := ctx.prior[exp.BodyEquals.SameAs]
			if !ok {
				failures = append(failures, fmt.Sprintf("body: sameAs references unknown step %s", exp.BodyEquals.SameAs))
			} else if !bytes.Equal(prior, obs.body) {
				failures = append(failures, fmt.Sprintf("body: expected same bytes as step %s (%d bytes), got %d bytes that differ", exp.BodyEquals.SameAs, len(prior), len(obs.body)))
			}
		}
	}
	if exp.BodyJSON != nil {
		var parsed any
		if err := json.Unmarshal(obs.body, &parsed); err != nil {
			failures = append(failures, "body: expected JSON object, got unparseable body")
		} else if object, ok := parsed.(map[string]any); !ok {
			failures = append(failures, "body: expected JSON object, got non-object")
		} else {
			keys := make([]string, 0, len(exp.BodyJSON))
			for k := range exp.BodyJSON {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if jsonText(object[k]) != jsonText(exp.BodyJSON[k]) {
					failures = append(failures, fmt.Sprintf("body.%s: expected %s, got %s", k, jsonText(exp.BodyJSON[k]), jsonText(object[k])))
				}
			}
		}
	}
	if exp.BodyBytes != nil && len(obs.body) != *exp.BodyBytes {
		failures = append(failures, fmt.Sprintf("body: expected %d bytes, got %d", *exp.BodyBytes, len(obs.body)))
	}
	if exp.HandlerInvocations != nil {
		switch {
		case ctx.invocations == nil:
			failures = append(failures, "handlerInvocations: counter unavailable")
		case *ctx.invocations != *exp.HandlerInvocations:
			failures = append(failures, fmt.Sprintf("handlerInvocations: expected %d, got %d", *exp.HandlerInvocations, *ctx.invocations))
		}
	}
	return failures
}
```

- [ ] **Step 5: Implement run.go**

```go
package conformance

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Options select vectors and describe the target.
type Options struct {
	Tiers        []string
	Capabilities []string
	Only         []string
	ResetPath    string
	CounterPath  string
	VectorsDir   string
	Client       *http.Client
}

type StepOutcome struct {
	StepID   string   `json:"stepId"`
	Failures []string `json:"failures"`
}

type VectorResult struct {
	ID     string        `json:"id"`
	Tier   string        `json:"tier"`
	Status string        `json:"status"`
	Steps  []StepOutcome `json:"steps"`
	Error  string        `json:"error,omitempty"`
}

type Summary struct {
	Results       []VectorResult `json:"results"`
	Passed        int            `json:"passed"`
	Failed        int            `json:"failed"`
	NotApplicable int            `json:"notApplicable"`
	Errored       int            `json:"errored"`
}

type sendResult struct {
	obs observed
	err error
}

type runner struct {
	client      *http.Client
	baseURL     string
	resetPath   string
	counterPath string
}

func (r *runner) send(ctx context.Context, req StepRequest) (observed, error) {
	var body io.Reader
	if req.Body != nil {
		body = strings.NewReader(*req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, r.baseURL+req.Path, body)
	if err != nil {
		return observed{}, fmt.Errorf("build request: %w", err)
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	res, err := r.client.Do(httpReq)
	if err != nil {
		return observed{}, fmt.Errorf("send %s %s: %w", req.Method, req.Path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return observed{}, fmt.Errorf("read %s %s: %w", req.Method, req.Path, err)
	}
	return observed{status: res.StatusCode, header: res.Header, body: data}, nil
}

func (r *runner) counter(ctx context.Context) *int {
	obs, err := r.send(ctx, StepRequest{Method: http.MethodGet, Path: r.counterPath})
	if err != nil || obs.status != http.StatusOK {
		return nil
	}
	var parsed struct {
		Count *int `json:"count"`
	}
	if json.Unmarshal(obs.body, &parsed) != nil {
		return nil
	}
	return parsed.Count
}

type pendingStep struct {
	step Step
	ch   chan sendResult
}

func (r *runner) start(ctx context.Context, step Step) pendingStep {
	ch := make(chan sendResult, 1)
	go func() {
		obs, err := r.send(ctx, step.Request)
		ch <- sendResult{obs: obs, err: err}
	}()
	return pendingStep{step: step, ch: ch}
}

// runVector follows the README ordering rules: deferred steps are sent and left pending; a step with
// concurrentWith is sent while they are pending and the group is checked together with one counter read.
func (r *runner) runVector(ctx context.Context, v Vector) VectorResult {
	result := VectorResult{ID: v.ID, Tier: v.Tier, Steps: []StepOutcome{}}
	fail := func(err error) VectorResult {
		result.Status = "error"
		result.Error = err.Error()
		return result
	}
	reset, err := r.send(ctx, StepRequest{Method: http.MethodPost, Path: r.resetPath})
	if err != nil {
		return fail(err)
	}
	if reset.status < 200 || reset.status >= 300 {
		return fail(fmt.Errorf("reset returned %d", reset.status))
	}
	deferred := map[string]bool{}
	for _, step := range v.Steps {
		for _, id := range step.ConcurrentWith {
			deferred[id] = true
		}
	}
	prior := map[string][]byte{}
	pending := map[string]pendingStep{}
	pendingOrder := []string{}

	evaluateGroup := func(group []pendingStep) error {
		results := make([]sendResult, len(group))
		for i, p := range group {
			results[i] = <-p.ch
			if results[i].err != nil {
				return results[i].err
			}
		}
		var invocations *int
		for _, p := range group {
			if p.step.Expect.HandlerInvocations != nil {
				invocations = r.counter(ctx)
				break
			}
		}
		for i, p := range group {
			ctxEval := evalContext{prior: prior, invocations: invocations}
			result.Steps = append(result.Steps, StepOutcome{StepID: p.step.ID, Failures: evaluate(p.step.Expect, results[i].obs, ctxEval)})
			prior[p.step.ID] = results[i].obs.body
		}
		return nil
	}
	settlePending := func() error {
		if len(pending) == 0 {
			return nil
		}
		group := make([]pendingStep, 0, len(pending))
		for _, id := range pendingOrder {
			group = append(group, pending[id])
		}
		pending = map[string]pendingStep{}
		pendingOrder = nil
		return evaluateGroup(group)
	}

	for _, step := range v.Steps {
		if len(step.ConcurrentWith) == 0 {
			if err := settlePending(); err != nil {
				return fail(err)
			}
		}
		if step.DelayMs > 0 {
			select {
			case <-time.After(time.Duration(step.DelayMs) * time.Millisecond):
			case <-ctx.Done():
				return fail(ctx.Err())
			}
		}
		started := r.start(ctx, step)
		if deferred[step.ID] {
			pending[step.ID] = started
			pendingOrder = append(pendingOrder, step.ID)
			continue
		}
		if len(step.ConcurrentWith) > 0 {
			group := make([]pendingStep, 0, len(step.ConcurrentWith)+1)
			for _, id := range step.ConcurrentWith {
				p, ok := pending[id]
				if !ok {
					return fail(fmt.Errorf("step %s: concurrentWith references %s, which is not pending", step.ID, id))
				}
				group = append(group, p)
				delete(pending, id)
			}
			pendingOrder = pendingOrder[:0]
			for id := range pending {
				pendingOrder = append(pendingOrder, id)
			}
			group = append(group, started)
			if err := evaluateGroup(group); err != nil {
				return fail(err)
			}
			continue
		}
		if err := evaluateGroup([]pendingStep{started}); err != nil {
			return fail(err)
		}
	}
	if err := settlePending(); err != nil {
		return fail(err)
	}
	result.Status = "pass"
	for _, s := range result.Steps {
		if len(s.Failures) > 0 {
			result.Status = "fail"
		}
	}
	return result
}

// RunVectors runs the selected vectors sequentially against baseURL (REQ-CONF-6).
func RunVectors(ctx context.Context, baseURL string, vectors []Vector, opts Options) (Summary, error) {
	r := &runner{client: opts.Client, baseURL: strings.TrimSuffix(baseURL, "/"), resetPath: opts.ResetPath, counterPath: opts.CounterPath}
	if r.client == nil {
		r.client = &http.Client{Timeout: 30 * time.Second}
	}
	if r.resetPath == "" {
		r.resetPath = "/reset"
	}
	if r.counterPath == "" {
		r.counterPath = "/counter"
	}
	tiers := map[string]bool{}
	for _, t := range opts.Tiers {
		tiers[t] = true
	}
	only := map[string]bool{}
	for _, id := range opts.Only {
		only[id] = true
	}
	capabilities := map[string]bool{}
	for _, c := range opts.Capabilities {
		capabilities[c] = true
	}
	var summary Summary
	summary.Results = []VectorResult{}
	for _, v := range vectors {
		if len(tiers) > 0 && !tiers[v.Tier] {
			continue
		}
		if len(only) > 0 && !only[v.ID] {
			continue
		}
		var missing []string
		for _, c := range v.Requires {
			if !capabilities[c] {
				missing = append(missing, c)
			}
		}
		var result VectorResult
		if len(missing) > 0 {
			result = VectorResult{ID: v.ID, Tier: v.Tier, Status: "not-applicable", Steps: []StepOutcome{}, Error: "requires " + strings.Join(missing, ", ")}
		} else {
			result = r.runVector(ctx, v)
		}
		summary.Results = append(summary.Results, result)
		switch result.Status {
		case "pass":
			summary.Passed++
		case "fail":
			summary.Failed++
		case "not-applicable":
			summary.NotApplicable++
		default:
			summary.Errored++
		}
	}
	return summary, ctx.Err()
}
```

- [ ] **Step 6: Implement report.go and testing.go**

`go/conformance/report.go`:

```go
package conformance

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func details(r VectorResult) string {
	if r.Status == "not-applicable" || r.Status == "error" {
		return r.Error
	}
	var out []string
	for _, s := range r.Steps {
		for _, f := range s.Failures {
			out = append(out, s.StepID+": "+f)
		}
	}
	return strings.Join(out, "; ")
}

var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;")

// Format renders a summary as json, markdown or junit with the same shapes as the TypeScript runner (REQ-CONF-6).
func Format(s Summary, format, target string) ([]byte, error) {
	switch format {
	case "json":
		type report struct {
			Target      string `json:"target,omitempty"`
			GeneratedAt string `json:"generatedAt"`
			Summary
		}
		return json.MarshalIndent(report{Target: target, GeneratedAt: time.Now().UTC().Format(time.RFC3339), Summary: s}, "", "  ")
	case "markdown":
		var b strings.Builder
		b.WriteString("# anyonce conformance report\n\n")
		if target != "" {
			fmt.Fprintf(&b, "Target: %s\n\n", target)
		}
		fmt.Fprintf(&b, "%d passed, %d failed, %d not applicable, %d errored\n\n", s.Passed, s.Failed, s.NotApplicable, s.Errored)
		b.WriteString("| Vector | Tier | Status | Details |\n|---|---|---|---|\n")
		for _, r := range s.Results {
			fmt.Fprintf(&b, "| %s | %s | %s | %s |\n", r.ID, r.Tier, r.Status, strings.ReplaceAll(details(r), "|", "\\|"))
		}
		return []byte(b.String()), nil
	case "junit":
		var b strings.Builder
		b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
		fmt.Fprintf(&b, "<testsuite name=\"anyonce-conformance\" tests=\"%d\" failures=\"%d\" errors=\"%d\" skipped=\"%d\">\n", len(s.Results), s.Failed, s.Errored, s.NotApplicable)
		for _, r := range s.Results {
			open := fmt.Sprintf("<testcase classname=\"%s\" name=\"%s\"", r.Tier, xmlEscaper.Replace(r.ID))
			message := xmlEscaper.Replace(details(r))
			switch r.Status {
			case "pass":
				fmt.Fprintf(&b, "  %s/>\n", open)
			case "fail":
				fmt.Fprintf(&b, "  %s><failure message=\"%s\"/></testcase>\n", open, message)
			case "not-applicable":
				fmt.Fprintf(&b, "  %s><skipped message=\"%s\"/></testcase>\n", open, message)
			default:
				fmt.Fprintf(&b, "  %s><error message=\"%s\"/></testcase>\n", open, message)
			}
		}
		b.WriteString("</testsuite>\n")
		return []byte(b.String()), nil
	default:
		return nil, fmt.Errorf("conformance: unknown report format %q", format)
	}
}
```

`go/conformance/testing.go`:

```go
package conformance

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Run drives the suite from a test (REQ-CONF-6). target is an http.Handler (served by httptest for the run) or a
// base URL string. Each vector becomes a subtest; not-applicable vectors are skipped, failures and errors fail.
func Run(t *testing.T, target any, opts Options) Summary {
	t.Helper()
	var baseURL string
	switch v := target.(type) {
	case http.Handler:
		srv := httptest.NewServer(v)
		t.Cleanup(srv.Close)
		baseURL = srv.URL
	case string:
		baseURL = v
	default:
		t.Fatalf("conformance.Run: target must be an http.Handler or a base URL string, got %T", target)
	}
	dir := opts.VectorsDir
	if dir == "" {
		dir = DefaultVectorsDir()
	}
	vectors, err := LoadVectors(dir)
	if err != nil {
		t.Fatal(err)
	}
	summary, err := RunVectors(context.Background(), baseURL, vectors, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range summary.Results {
		t.Run(r.ID, func(t *testing.T) {
			switch r.Status {
			case "pass":
			case "not-applicable":
				t.Skip(r.Error)
			default:
				t.Errorf("%s: %s", r.Status, strings.TrimSpace(details(r)))
			}
		})
	}
	return summary
}
```

- [ ] **Step 7: Run the tests, vet, lint**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`, `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS (the httpmw conformance subtest lists 20 passing vectors), clean, 0 issues. `go test ./httpmw/` takes about ten seconds because of the timed vectors.

- [ ] **Step 8: Commit**

```bash
git add go/conformance go/httpmw/conformance_test.go
git commit -m "feat(go): REQ-CONF-6 conformance runner with json, markdown and junit reports; REQ-HTTP-18 every vector green through httpmw"
```

---

### Task 12: URL mode end to end, fixture flags, docs and the final gate wiring (REQ-CONF-7, REQ-HTTP-18)

**Files:**
- Modify: `go/cmd/fixture/main.go` (`-idempotent`, `-ttl-ms`), `packages/conformance/test/cli-go.test.ts` (new), `CLAUDE.md` (commands), `conformance/README.md` (fixture flags), root `package.json` (already `--phase p2`)

- [ ] **Step 1: Write the failing test**

`packages/conformance/test/cli-go.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const goDir = join(import.meta.dir, '../../../go');
const cli = join(import.meta.dir, '../src/cli.ts');
const hasGo = Bun.which('go') !== null;

let proc: ReturnType<typeof Bun.spawn> | undefined;
let baseUrl = '';
let tempDir = '';

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

describe.skipIf(!hasGo)('CLI against the Go fixture behind httpmw', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyonce-fixture-'));
    const bin = join(tempDir, 'fixture');
    const build = Bun.spawnSync(['go', 'build', '-o', bin, './cmd/fixture'], { cwd: goDir, stderr: 'pipe' });
    if (build.exitCode !== 0) throw new Error(`go build failed: ${build.stderr.toString()}`);
    proc = Bun.spawn([bin, '-addr', '127.0.0.1:0', '-idempotent', '-ttl-ms', '2000'], { stdout: 'pipe', stderr: 'inherit' });
    baseUrl = await readAddress(proc.stdout as ReadableStream<Uint8Array>);
  }, 120_000);

  afterAll(() => {
    proc?.kill();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('REQ-CONF-7: the URL-mode CLI passes every vector against Go httpmw over the wire', async () => {
    const run = Bun.spawn(['bun', 'run', cli, '--url', baseUrl, '--capability', 'short-ttl', '--ttl-ms', '2000', '--report', 'json'], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(run.stdout).text();
    const code = await run.exited;
    const parsed = JSON.parse(stdout) as { passed: number; results: Array<{ id: string; status: string }> };
    expect(parsed.results.filter((r) => r.status !== 'pass').map((r) => `${r.id}: ${r.status}`)).toEqual([]);
    expect(parsed.passed).toBe(20);
    expect(code).toBe(0);
  }, 60_000);
});

if (!hasGo) {
  test.skip('REQ-CONF-7: skipped because go is not on PATH', () => {});
}
```

(`go` on PATH is the cached 1.25.3 toolchain locally, which builds the module fine because go.mod pins 1.26 and the toolchain directive downloads what it needs; if the build fails locally with a toolchain error, run the test with `PATH=/opt/homebrew/bin:$PATH`. CI's `go` job and `ts` job both set up Go with `actions/setup-go`.)

- [ ] **Step 2: Extend the fixture command**

`go/cmd/fixture/main.go`:

```go
// Command fixture serves the conformance fixture, bare by default or behind httpmw with -idempotent.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address, port 0 picks a free port")
	idempotent := flag.Bool("idempotent", false, "mount httpmw with the memory store in front of the fixture routes")
	ttlMs := flag.Int("ttl-ms", 2000, "record TTL in milliseconds when -idempotent is set")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}
	fmt.Printf("listening on http://%s\n", ln.Addr().String())

	f := fixture.New()
	var handler http.Handler = f.Handler()
	if *idempotent {
		mw := httpmw.New(memory.New(), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: time.Duration(*ttlMs) * time.Millisecond}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		handler = mux
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
```

- [ ] **Step 3: Run the test**

Run: `bun test packages/conformance/test/cli-go.test.ts`
Expected: PASS (20 of 20 over the wire).

- [ ] **Step 4: Docs**

`conformance/README.md`, "Fixture contract" paragraph: after the sentence about reference apps, add: "`go run ./cmd/fixture -idempotent -ttl-ms 2000` serves the Go fixture behind `httpmw` with the memory store, which is what the P2 URL-mode test drives."

`CLAUDE.md`, Commands section: change the `bun run conformance -- --url <base>` mention to read `bun run conformance -- --url <base> [--tier core] [--report junit]` and add `bun run test:node`, `bun run test:deno` and the note that `bun run test:workers`, `test:node` and `test:deno` need `bun run build` first. In the Layout block, `packages/core/src/http/` already names the subpath.

- [ ] **Step 5: REQ coverage and the whole suite**

Run: `bun run test:reqs`
Expected: every id in the P2 scope covered (REQ-HTTP-1..18, REQ-CONF-1..7, plus the P0 and P1 ids). If an id is missing, add the id to the test that proves it rather than a new empty test.

Run: `bun run test 2>&1 | tee /tmp/p2.log`, `scripts/no-skips.sh /tmp/p2.log`
Expected: PASS, no skips (the Go-dependent tests run because `go` is on PATH).

- [ ] **Step 6: Commit**

```bash
git add go/cmd/fixture/main.go packages/conformance/test/cli-go.test.ts conformance/README.md CLAUDE.md
git commit -m "test(conformance): REQ-CONF-7 URL mode against Go httpmw over the wire; fixture -idempotent flag; docs"
```

---

## Phase gate (CHECKLIST.md, "Every phase" and "P2 HTTP adapter")

Run after Task 12 with `verification-before-completion`, paste the raw output into the PR:

1. `GOROOT= scripts/doctor.sh`
2. `bun run lint`, `bun run typecheck`, `bun run build`, `bun run test 2>&1 | tee /tmp/p2.log`, `scripts/no-skips.sh /tmp/p2.log`, `bun run test:reqs` (phase p2)
3. `bun run test:coverage` (engine.ts, key.ts, sfstring.ts at 100 percent), `bun run size` (core root under 8192, `@anyonce/core/http` under 16384)
4. Runtime matrix after `bun run build`: `bun run test:workers` (workerd), `bun run test:node` (Node 22), `bun run test:deno` (Deno 2.7); Bun is the default runner
5. Go: `GOROOT= /opt/homebrew/bin/go build -C go ./...`, `vet`, `test -race -count=1 ./...` (includes the httpmw and Go runner conformance runs), `GOROOT= sh -c 'cd go && golangci-lint run'`, `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`
6. TS runner 100 percent core and profile against Hono plus memory (`packages/hono/test/conformance.test.ts`) and withIdempotency plus memory (`packages/core/test/http/conformance.test.ts`); Go runner 100 percent against httpmw plus memory (`go/httpmw/conformance_test.go`); URL mode both ways (`cli-go.test.ts`, `lambda-harness.test.ts`)
7. Streaming proof tests: `packages/core/test/http/streaming.test.ts`, `packages/hono/test/middleware.test.ts` (REQ-HTTP-7), `go/httpmw/middleware_test.go` `TestStreaming`
8. `docs/problems.md` lists every code with an example body (Task 1)
9. `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing
10. `rg -n "console\.(log|info|warn|error)\(.*key" packages go` returns nothing
11. Changeset present: `.changeset/p2-http.md`
12. `docs/superpowers/questions.md` reviewed: Q18 has a recommended resolution and is raised at the checkpoint
13. Node compat smoke: `node -e "require('@anyonce/core/http'); require('@anyonce/hono'); require('@anyonce/conformance/runtime')"` after build

PR body: REQ ids covered are REQ-HTTP-1 through REQ-HTTP-18 and REQ-CONF-5 through REQ-CONF-7 (plus REQ-DOC-4, REQ-REL-4, REQ-REL-5 and NFR-4 evidence). Squash merge to `main`. P4a (queue door) may start in parallel with this phase's review; P3, P4b and P5 start after the merge.
