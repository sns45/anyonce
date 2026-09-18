# P4b Webhook Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the third door in both languages: `@anyonce/webhooks` and Go `webhookmw`, the Standard Webhooks receiver that runs strictly after signature verification, keys on `webhook-id`, replays the stored response, answers 409 with Retry-After while a delivery is in flight and 422 plus an `onSuspicious` hook when the same id arrives with a different body, plus `standardWebhooksVerify(secret)` and Go `standardwebhooks.Verify` proven against the anyhook signer and the Standard Webhooks published vectors.

**Architecture:** The webhook door is the HTTP door with three things swapped: what runs before the store (signature verification, D16), where the key comes from (`webhook-id` or a body derived id, REQ-WH-1), and what the scope is (`${routePattern}/${sourceId}`, D8). Everything after that is the P2 bridge unchanged, so the receiver calls `runIdempotent` in TypeScript and reuses the `httpmw` helpers in Go. Two additive holes are opened in the bridge for it: `RunContext` gains a caller supplied key lookup and body, and the Go helpers the door needs move from `go/httpmw` into `go/internal/httpx` with no behaviour change. The verification helper is a separate concern from the receiver and ships as its own module in both languages, so a deployment that already verifies upstream never pays for it.

**Tech Stack:** Bun 1.2.21 (`bun test`, workspaces), TypeScript 5 strict, tsup, Biome 2, Hono 4 (dev only, for the conformance fixture), `@anyhook/signing` 0.2.2 (dev only), Go 1.26 minimum (local toolchain `/opt/homebrew/bin/go`, currently 1.27.1), standard library only in the published module, `github.com/sns45/anyhook/go v0.2.1` in a nested test only module, golangci-lint 2.13.2.

**Spec:** `requirements.md` sections 2 (D6, D8, D9, D10, D11, D12, D13, D16, D21), 3 (types and engine), 4.6 (REQ-WH-1..7), 4.4 (REQ-HTTP-13 for the problem catalogue), 4.7 (REQ-CONF-5, REQ-CONF-6 for running the suite through the receiver), 4.8 (REQ-DOC-4); `docs/superpowers/questions.md` Q11, Q15, Q16, Q17, Q18, Q19 and the new Q23 to Q28 written at the head of this phase; `docs/superpowers/specs/2026-09-anyonce-design.md` items A4, B8, C1; `docs/reference/anyhook-signing.md` (the wire format and the golden vectors); `CHECKLIST.md` sections "Every phase" and "P4b webhook door".

## Global Constraints

- Prose in docs, comments, commit messages, changeset text, YAML and shell: no em or en dashes (U+2013, U+2014). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing.
- Test names start with the REQ id they prove: `REQ-WH-2: a receiver with neither verify nor verifiedMarker answers 500 configuration-error`. Go subtests use `t.Run("REQ-WH-2: ...", ...)`. The id must be the start of a quoted string followed by a colon, because that is what `scripts/reqs.ts` matches.
- `@anyonce/webhooks`: Web APIs only (`Request`, `Response`, `Headers`, `crypto.subtle`, `TextEncoder`, `atob`); no `node:` import anywhere under `packages/webhooks/src`; zero `dependencies`; `@anyonce/core` is a peer dependency (D21); the source imports only from `@anyonce/core` and `@anyonce/core/http`, and a test in `packages/webhooks/test/package.test.ts` proves it, mirroring `packages/hono/test/package.test.ts`.
- `@anyonce/core` keeps zero `dependencies`, the root entry never imports `./http`, the root bundle stays under 8192 bytes and the `http` subpath under 16384 bytes minified plus gzip (`bun run size`).
- TypeScript: `strict`, `exactOptionalPropertyTypes` (build objects conditionally, never assign `undefined` to an optional property), `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any` outside test fakes.
- Problem details (D10, D11, REQ-HTTP-13, Q23): every error is `application/problem+json` with members `type`, `title`, `status`, `code` and optional `detail`; `type` is `${problemBaseUri}${code}`. The catalogue after this phase is `missing-key` (400), `invalid-key` (400), `conflict` (409), `fingerprint-mismatch` (422), `payload-too-large` (413), `store-unavailable` (503), `missing-principal` (500), `configuration-error` (500), `signature-invalid` (401). A 409 carries `Retry-After` of `ceil(leaseRemainingMs / 1000)` with a minimum of 1.
- Webhook scope (D8, Q24): `${routePattern}/${sourceId}` when a `sourceId` function yields a non-empty value, `${routePattern}` alone when it does not. `routePattern` defaults to the request pathname in TypeScript and `r.URL.EscapedPath()` in Go.
- Webhook fingerprint (D9): SHA-256 over the body bytes alone, not the HTTP form. TypeScript `sha256Hex(body)`, Go `anyonce.SHA256Hex(body)`.
- Webhook key validation (Q25): the id goes through the lenient parser (1 to 255 bytes, printable ASCII, surrounding quotes stripped); a failure is 400 `invalid-key`. `required` defaults to true on this door, so a verified delivery with no id is 400 `missing-key`.
- Verification gate (D16, REQ-WH-2): the configuration check runs before anything else on every request; verification runs before the key is read and before `store.begin`; neither an unverified request nor a misconfigured receiver ever reaches the store. A test asserts the store recorded zero `begin` calls in both cases.
- Logging (Q26, NFR-2): `@anyonce/webhooks` and `go/webhookmw` log exactly once per receiver instance and only for the configuration error, through `logger?: (message: string) => void` defaulting to `console.error` (Go `Logf func(format string, args ...any)` defaulting to `log.Printf`). The message is a fixed string with no request data, no header value and no key, so the CI key-log gate (`rg -n 'console\.(log|info|warn|error)\(.*key' packages go`) stays green. Nothing else in either package logs. `@anyonce/core`, `@anyonce/hono` and `go/httpmw` still never log.
- Standard Webhooks wire format (REQ-WH-6, `docs/reference/anyhook-signing.md`): headers `webhook-id`, `webhook-timestamp`, `webhook-signature` matched case-insensitively; signed content `${id}.${timestamp}.${payload}` where `payload` is the exact raw body; HMAC-SHA256; secret is an optional `whsec_` prefix plus standard base64; each signature entry is `v1,` plus standard base64 of the 32 byte MAC, entries space joined; tolerance 300 seconds on the absolute difference; comparison is constant time on the decoded bytes; any one matching entry passes. Failure order: missing any of the three headers, timestamp not a finite number, timestamp outside tolerance, no matching entry.
- Go: standard library only in `go/internal/httpx`, `go/webhookmw` and `go/standardwebhooks`; no cgo; errors wrapped with `%w`; doc comments on every exported identifier; `context.Context` threaded through; `go vet`, `go test -race`, `golangci-lint run` clean. Run Go as `GOROOT= /opt/homebrew/bin/go <verb> -C go ./...`; golangci-lint as `GOROOT= sh -c 'cd go && golangci-lint run'`; the engine coverage gate as `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh` (it must stay at 100 percent; this phase does not touch `go/anyonce/engine.go`).
- The Go internal extraction (Task 3) changes no `httpmw` behaviour. The `httpmw` integration, streaming and conformance tests are the safety net and are not edited in that task; only the helper unit tests move, keeping their `REQ-HTTP-*` names verbatim.
- Never log a full key; `redactKey` is the only form a key may take in any message. Problem `detail` strings never include the key or the id value.
- Never write a `\uXXXX` escape inside a tool parameter; the editing tools decode it into the raw character. Use `\x` escapes or named escapes.
- Shared files (`package.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `test/ci.test.ts`, `bun.lock`) get the smallest additive edit that works, because P4a is editing the same files in another worktree.
- Conventional commits: `feat(core): ...`, `feat(webhooks): ...`, `feat(go): ...`, `refactor(go): ...`, `test(...)`, `docs(...)`. Commit after every task. Git only as plain single commands from the worktree root (no `cd`, no `&&` between git commands, no `-C`).
- Changeset `.changeset/p4b-webhooks.md` (Task 14): `@anyonce/core: minor`, `@anyonce/webhooks: minor`.

## Decisions taken in this plan (not spec changes)

- **The receiver is a factory, not a wrapper.** REQ-WH-1 shows `webhookReceiver({ ... })` with a single options object and REQ-WH-7 shows Go `New(store, Options).Handler(next)`. TypeScript follows the literal shape: `webhookReceiver(options)` returns a function that takes the handler, so the call reads `webhookReceiver(opts)(app.fetch)` and mirrors Go one for one.
- **`verifiedMarker` is a per request marker, not a header.** A fetch handler has no context object, and reading the marker from a request header would let anything that can reach the receiver claim to be verified. `@anyonce/webhooks` exports `markVerified(req, marker)` and keeps the markers in a module level `WeakMap<Request, Set<string>>`; an upstream verifier calls it on the same `Request` object it passes down. Go uses `context.Context`: `webhookmw.MarkVerified(ctx, marker)` stores the marker and the middleware reads it with `ctx.Value`. Q26 covers the logging half of REQ-WH-2, this is the marker half.
- **The bridge gains two optional `RunContext` fields, not a second entry point.** `keyLookup?: KeyLookup` replaces the header lookup with one the caller already did, reusing all three branches of the existing union (so `required`, the `Link` header on `missing-key` and the `invalid-key` detail all keep working). `body?: Uint8Array` hands over bytes the caller already read, so a door that must see the body before the store reads it once. Both default to today's behaviour when absent, and the existing `withIdempotency` and Hono paths pass neither.
- **Problem titles are overridable per code.** The D11 titles name the `Idempotency-Key` header, which is the wrong header to name to a webhook sender. `problemTitles?: Partial<Record<ProblemCode, string>>` (Go `Options.ProblemTitles map[Code]string`) overrides the title and nothing else; the status and the `code` member are fixed by D11 and are not overridable. The webhook receiver fills it from its own `idHeader`.
- **The receiver renders its two pre-store problems itself.** `configuration-error` and `signature-invalid` happen before `runIdempotent` is called, so the receiver builds them with `problem()` and `problemResponse()` and honours `onError`. They carry no extra protocol headers, so the bridge's `withProtocolHeaders` merge is not needed and is not duplicated.
- **Go helper extraction, not helper export.** `go/internal/httpx` is a new internal package under the module root, so both `go/httpmw` and `go/webhookmw` can import it and nothing outside `github.com/sns45/anyonce/go` can. `httpmw` keeps its public surface by aliasing: `type Problem = httpx.Problem`, `type Code = httpx.Code`, `const CodeConflict = httpx.CodeConflict`, and `KeyFromContext`/`FenceFromContext` delegate. Aliases to an internal type are usable by external callers because they never name the internal import path. `httpmw.Options`, `resolved`, `resolveScope` and `fingerprint` stay in `httpmw`: the webhook door computes its scope and fingerprint differently and does not need them.
- **The Go interop test lives in a nested module.** `go/webhookmw/interop/go.mod` requires `github.com/sns45/anyhook/go v0.2.1`. `go build ./...` and `go test ./...` in `go/` do not descend into a nested module, so the published module keeps the dependency set CLAUDE.md names. The existing `go` CI job gains one step that runs the nested module's tests. Q27.
- **The conformance suite runs through the receiver with `idHeader: 'Idempotency-Key'`.** The vectors were written for the HTTP door's header name and carry no signatures, so the harness sets `idHeader` to the vector header, `verify` to a function returning true, `required: true` and `skip` for `POST /reset`, exactly as `packages/core/test/http/conformance.test.ts` already does for `withIdempotency`. Go mounts `POST /reset` outside the middleware instead, as `go/httpmw/conformance_test.go` already does. Q28.
- **A4 stands:** REQ-WH-3's parenthetical "always 2xx by construction" is an explanatory slip. Behaviour follows D6, so a stored 4xx replays as 4xx, and a test proves it. The docs say "2xx in practice because receivers respond 2xx".
- **`storeResult` is not special cased.** D6's default (store status below 500) is what the webhook door wants: a receiver that answers 500 should see the delivery again on the next retry.

## File Structure

```
docs/superpowers/questions.md                   Q23 to Q28 (already written at the head of the phase)
packages/core/src/http/problems.ts              two new codes, ProblemTitles, problem() takes an optional title
packages/core/src/http/options.ts               problemTitles on HttpIdempotencyOptions and ResolvedHttpOptions
packages/core/src/http/run.ts                   RunContext.keyLookup, RunContext.body, fail() uses problemTitles
packages/core/src/http/index.ts                 re-export ProblemTitles
packages/core/test/http/problems.test.ts        the new codes and the title override
packages/core/test/http/run.test.ts             the two new RunContext fields
docs/problems.md                                configuration-error and signature-invalid rows and example bodies

go/internal/httpx/problems.go                   Code, Problem, NewProblem, WriteProblem, ProblemStatus, ProblemTitle, ProblemWriter
go/internal/httpx/request.go                    KeyStatus, LookupKey, RequestPath, DefaultScope, ErrTooLarge, ReadBody
go/internal/httpx/writer.go                     CaptureWriter, NewCaptureWriter, Result, SortedKeys
go/internal/httpx/replay.go                     WriteReplay, RetryAfter
go/internal/httpx/context.go                    WithInfo, KeyFromContext, FenceFromContext
go/internal/httpx/*_test.go                     the moved helper unit tests, REQ-HTTP ids unchanged
go/httpmw/problems.go                           aliases to httpx, ProblemTitles wiring
go/httpmw/request.go                            keeps resolveScope and fingerprint, delegates the rest
go/httpmw/middleware.go                         uses httpx.CaptureWriter, httpx.WriteReplay, httpx.RetryAfter
go/httpmw/context.go                            delegates to httpx
go/httpmw/options.go                            Options.ProblemTitles

packages/webhooks/package.json                  @anyonce/webhooks, peer @anyonce/core, dev @anyhook/signing
packages/webhooks/tsconfig.json                 extends ../../tsconfig.base.json
packages/webhooks/src/marker.ts                 markVerified, isVerified
packages/webhooks/src/receiver.ts               webhookReceiver, WebhookReceiverOptions, DEFAULT_ID_HEADER
packages/webhooks/src/verify.ts                 standardWebhooksVerify, StandardWebhooksOptions
packages/webhooks/src/index.ts                  public surface
packages/webhooks/test/gate.test.ts             REQ-WH-2
packages/webhooks/test/receiver.test.ts         REQ-WH-1, REQ-WH-3, REQ-WH-4, REQ-WH-5
packages/webhooks/test/verify.test.ts           REQ-WH-6 vectors
packages/webhooks/test/interop.test.ts          REQ-WH-6 anyhook round trip
packages/webhooks/test/conformance.test.ts      REQ-WH-1 suite through the receiver
packages/webhooks/test/package.test.ts          import direction and peers

go/standardwebhooks/standardwebhooks.go         Verifier, New, Verify, ParseSecret, ErrVerification
go/standardwebhooks/standardwebhooks_test.go    REQ-WH-6 vectors
go/webhookmw/options.go                         Options, resolved, withDefaults
go/webhookmw/middleware.go                      Middleware, New, Handler, MarkVerified
go/webhookmw/gate_test.go                       REQ-WH-2
go/webhookmw/middleware_test.go                 REQ-WH-1, 3, 4, 5, 7
go/webhookmw/conformance_test.go                REQ-WH-7 suite through webhookmw
go/webhookmw/interop/go.mod                     nested test only module
go/webhookmw/interop/interop_test.go            REQ-WH-6 anyhook round trip

conformance/README.md                           which vectors apply to the webhook door and why
CLAUDE.md                                       layout line for go/internal/httpx and go/standardwebhooks
package.json                                    test script gains packages/webhooks, test:reqs phase p4b
.github/workflows/ci.yml                        node-compat requires @anyonce/webhooks, go job runs the interop module
test/ci.test.ts                                 the two additive assertions above
.changeset/p4b-webhooks.md
```

---

### Task 1: the D11 catalogue gains `configuration-error` and `signature-invalid`, and titles become overridable (REQ-WH-2, REQ-HTTP-13, REQ-DOC-4, Q23)

**Files:**
- Modify: `packages/core/src/http/problems.ts`, `packages/core/src/http/options.ts`, `packages/core/src/http/run.ts`, `packages/core/src/http/index.ts`, `packages/core/test/http/problems.test.ts`, `docs/problems.md`

**Interfaces:**
- Produces: `ProblemCode` widened with `'configuration-error' | 'signature-invalid'`; `export type ProblemTitles = Partial<Record<ProblemCode, string>>`; `problem(code: ProblemCode, baseUri: string, detail?: string, title?: string): Problem`; `HttpIdempotencyOptions.problemTitles?: ProblemTitles` and `ResolvedHttpOptions.problemTitles?: ProblemTitles`. Consumed by Tasks 5, 6 and 9.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/http/problems.test.ts` and update the existing `toEqual` map in the same file (the existing test `REQ-HTTP-13: every code maps to its D11 status` asserts the whole record, so it must gain the two entries):

```ts
  test('REQ-WH-2: configuration-error is a 500 and signature-invalid is a 401', () => {
    expect(PROBLEM_STATUS['configuration-error']).toBe(500);
    expect(PROBLEM_STATUS['signature-invalid']).toBe(401);
    expect(problem('configuration-error', DEFAULT_PROBLEM_BASE_URI).type).toBe(
      'https://in8.sh/anyonce/problems/configuration-error',
    );
    expect(problem('signature-invalid', DEFAULT_PROBLEM_BASE_URI).code).toBe('signature-invalid');
  });

  test('REQ-WH-2: a title override replaces the title and leaves the status and the code alone', () => {
    const p = problem('conflict', DEFAULT_PROBLEM_BASE_URI, undefined, 'A delivery with this webhook-id is still in progress');
    expect(p.title).toBe('A delivery with this webhook-id is still in progress');
    expect(p.status).toBe(409);
    expect(p.code).toBe('conflict');
    expect(p.type).toBe('https://in8.sh/anyonce/problems/conflict');
  });
```

And in `packages/core/test/http/run.test.ts` add a test that the bridge uses the override (import `MemoryStore` from `../../src/memory` and `resolveHttpOptions`, `runIdempotent` from the http subpath the way the file already does):

```ts
  test('REQ-WH-2: problemTitles reaches the problem the bridge renders', async () => {
    const options = resolveHttpOptions({
      store: new MemoryStore(),
      required: true,
      problemTitles: { 'missing-key': 'The webhook-id header is required for this request' },
    });
    const res = await runIdempotent(
      new Request('https://example.test/hook', { method: 'POST', body: 'x' }),
      async () => new Response('never'),
      options,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string; code: string };
    expect(body.title).toBe('The webhook-id header is required for this request');
    expect(body.code).toBe('missing-key');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/problems.test.ts packages/core/test/http/run.test.ts`
Expected: FAIL, `PROBLEM_STATUS['configuration-error']` is `undefined` and `problemTitles` is not a known option.

- [ ] **Step 3: Widen the catalogue**

In `packages/core/src/http/problems.ts`:

```ts
/** D11 problem codes. missing-principal is the Q18 addition for REQ-HTTP-5; the last two are the Q23 additions for the webhook door. */
export type ProblemCode =
  | 'missing-key'
  | 'invalid-key'
  | 'conflict'
  | 'fingerprint-mismatch'
  | 'payload-too-large'
  | 'store-unavailable'
  | 'missing-principal'
  | 'configuration-error'
  | 'signature-invalid';

/** Q23: a per code title override. The status and the code member are fixed by D11 and are not overridable. */
export type ProblemTitles = Partial<Record<ProblemCode, string>>;
```

Add to `PROBLEM_STATUS`:

```ts
  'configuration-error': 500,
  'signature-invalid': 401,
```

Add to `PROBLEM_TITLE`:

```ts
  'configuration-error': 'This endpoint is not configured correctly and cannot accept the request',
  'signature-invalid': 'The request signature could not be verified',
```

Widen `problem`:

```ts
export function problem(
  code: ProblemCode,
  baseUri: string,
  detail?: string,
  title?: string,
): Problem {
  const out: Problem = {
    type: `${baseUri}${code}`,
    title: title ?? PROBLEM_TITLE[code],
    status: PROBLEM_STATUS[code],
    code,
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}
```

- [ ] **Step 4: Thread `problemTitles` through the options and the bridge**

In `packages/core/src/http/options.ts` import `ProblemTitles` alongside `Problem`, add to `HttpIdempotencyOptions`:

```ts
  /** Q23: overrides the title of one or more problem codes, for a door whose key is not an Idempotency-Key. */
  problemTitles?: ProblemTitles;
```

add `problemTitles?: ProblemTitles;` to `ResolvedHttpOptions`, and inside `resolveHttpOptions`, next to the other conditional assignments:

```ts
  if (options.problemTitles !== undefined) resolved.problemTitles = options.problemTitles;
```

In `packages/core/src/http/run.ts`, the only change is inside `fail`:

```ts
    const p = problem(code, options.problemBaseUri, detail, options.problemTitles?.[code]);
```

In `packages/core/src/http/index.ts` add `ProblemTitles` to the type re-export list from `./problems`.

- [ ] **Step 5: Document the two codes**

In `docs/problems.md`, add two rows to the table after `missing-principal`:

```markdown
| `configuration-error` | 500 | The webhook receiver was built with neither a `verify` callback nor a `verifiedMarker`, so it can never establish that a delivery is genuine (REQ-WH-2, D16) | none |
| `signature-invalid` | 401 | The webhook signature did not verify, or the upstream verified marker was absent (D16) | none |
```

and two example bodies in the "Example bodies" section:

```markdown
`configuration-error`

```json
{
  "type": "https://in8.sh/anyonce/problems/configuration-error",
  "title": "This endpoint is not configured correctly and cannot accept the request",
  "status": 500,
  "code": "configuration-error"
}
```

`signature-invalid`

```json
{
  "type": "https://in8.sh/anyonce/problems/signature-invalid",
  "title": "The webhook signature could not be verified",
  "status": 401,
  "code": "signature-invalid"
}
```
```

Add a sentence under the table: "A receiver may override any title with `problemTitles` so it names the header its senders actually send; the status and the `code` member never change."

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/core` then `bun run size`
Expected: PASS, and the `http` subpath stays under 16384 bytes.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/http packages/core/test/http docs/problems.md
git commit -m "feat(core): REQ-WH-2 add configuration-error and signature-invalid to the D11 catalogue and make titles overridable"
```

---

### Task 2: `RunContext` accepts a caller supplied key lookup and body (REQ-WH-1, Q11)

**Files:**
- Modify: `packages/core/src/http/run.ts`, `packages/core/test/http/run.test.ts`

**Interfaces:**
- Consumes: `KeyLookup` from `packages/core/src/http/request.ts`.
- Produces: `RunContext { routeScope?: string; keyLookup?: KeyLookup; body?: Uint8Array }`. Consumed by Task 6 and Task 9.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/http/run.test.ts`:

```ts
describe('RunContext injection', () => {
  test('REQ-WH-1: a caller supplied key lookup replaces the header lookup', async () => {
    const store = new MemoryStore();
    const options = resolveHttpOptions({ store, required: true });
    const req = new Request('https://example.test/hook', { method: 'POST', body: 'payload' });
    const res = await runIdempotent(req, async () => new Response('ran', { status: 200 }), options, {
      keyLookup: { kind: 'ok', key: 'msg_injected' },
    });
    expect(res.status).toBe(200);
    const record = await store.get({ scope: 'POST /hook', key: 'msg_injected' }, Date.now());
    expect(record?.state).toBe('completed');
  });

  test('REQ-WH-1: an invalid caller supplied key lookup is 400 invalid-key with its reason', async () => {
    const options = resolveHttpOptions({ store: new MemoryStore() });
    const res = await runIdempotent(
      new Request('https://example.test/hook', { method: 'POST', body: 'payload' }),
      async () => new Response('never'),
      options,
      { keyLookup: { kind: 'invalid', reason: 'key exceeds 255 bytes' } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('invalid-key');
    expect(body.detail).toBe('key exceeds 255 bytes');
  });

  test('REQ-WH-1: a missing caller supplied key lookup follows the required flag', async () => {
    const options = resolveHttpOptions({ store: new MemoryStore(), required: true });
    const res = await runIdempotent(
      new Request('https://example.test/hook', { method: 'POST', body: 'payload' }),
      async () => new Response('never'),
      options,
      { keyLookup: { kind: 'missing' } },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('missing-key');
    expect(res.headers.get('Link')).toBe('<https://in8.sh/anyonce/problems/missing-key>; rel="describedby"');
  });

  test('REQ-WH-1: caller supplied body bytes are used for the fingerprint and the request body is left unread', async () => {
    const store = new MemoryStore();
    const options = resolveHttpOptions({ store });
    const seen: string[] = [];
    const req = new Request('https://example.test/hook', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-injected-body' },
      body: 'on the wire',
    });
    const res = await runIdempotent(
      req,
      async (r) => {
        seen.push(await r.text());
        return new Response('ok');
      },
      options,
      { body: new TextEncoder().encode('injected') },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(['on the wire']);
    const record = await store.get({ scope: 'POST /hook', key: 'k-injected-body' }, Date.now());
    expect(record?.fingerprint).toBe(
      await httpFingerprint('POST', '/hook', new TextEncoder().encode('injected')),
    );
  });
});
```

Import `httpFingerprint` from `../../src/fingerprint` at the top of the file if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/http/run.test.ts`
Expected: FAIL, `keyLookup` and `body` are not known properties of `RunContext`.

- [ ] **Step 3: Widen `RunContext` and use it**

In `packages/core/src/http/run.ts`, import the `KeyLookup` type alongside the functions already imported from `./request`, and:

```ts
export interface RunContext {
  /** A router's scope (METHOD plus pattern); used when the options carry no scope function. */
  routeScope?: string;
  /**
   * REQ-WH-1: a key the caller already resolved, for a door whose key does not come from one header read (the
   * webhook door reads webhook-id or derives an id from the body). All three branches behave as if the bridge
   * had read the header itself, so required, the Link header and the invalid-key detail are unchanged.
   */
  keyLookup?: KeyLookup;
  /**
   * Body bytes the caller already read. A door that must see the body before the store (signature verification,
   * a body derived id) reads it once and hands the bytes over instead of making the bridge clone and read again.
   */
  body?: Uint8Array;
}
```

Replace the lookup line:

```ts
  const lookup = ctx.keyLookup ?? lookupKey(req.headers, options.headerName, options.keySyntax);
```

Replace the body read:

```ts
  const body =
    ctx.body !== undefined
      ? ({ ok: true, body: ctx.body } as const)
      : await readBody(req, options.maxRequestBytes);
  if (!body.ok) return fail('payload-too-large');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core` then `bun run build` then `bun run typecheck` then `bun run size`
Expected: PASS, clean, budgets green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/http/run.ts packages/core/test/http/run.test.ts
git commit -m "feat(core): REQ-WH-1 RunContext accepts a caller supplied key lookup and body"
```

**Branch and PR for Tasks 1 and 2:** branch `p4b-http-bridge`, PR to `p4b-webhooks` titled `P4b: HTTP bridge hooks for the webhook door`, body says `Part of #13`, lists REQ-WH-1 and REQ-WH-2, and pastes the output of `bun run lint`, `bun run build`, `bun run test`, `bun run size`.

---

### Task 3: extract the shared Go HTTP helpers into `go/internal/httpx` with no behaviour change (REQ-HTTP-13, REQ-HTTP-18)

**Files:**
- Create: `go/internal/httpx/doc.go`, `go/internal/httpx/problems.go`, `go/internal/httpx/request.go`, `go/internal/httpx/writer.go`, `go/internal/httpx/replay.go`, `go/internal/httpx/context.go`, `go/internal/httpx/problems_test.go`, `go/internal/httpx/request_test.go`, `go/internal/httpx/writer_test.go`, `go/internal/httpx/context_test.go`
- Modify: `go/httpmw/problems.go`, `go/httpmw/request.go`, `go/httpmw/writer.go` (delete), `go/httpmw/middleware.go`, `go/httpmw/context.go`, `go/httpmw/problems_test.go`, `go/httpmw/request_test.go`, `go/httpmw/writer_test.go`, `go/httpmw/context_test.go`

**Interfaces:**
- Produces, all under `github.com/sns45/anyonce/go/internal/httpx`:
```go
type Code string
const ( CodeMissingKey, CodeInvalidKey, CodeConflict, CodeFingerprintMismatch,
        CodePayloadTooLarge, CodeStoreUnavailable, CodeMissingPrincipal Code = ... )
type Problem struct { Type, Title string; Status int; Detail string; Code Code }
func ProblemStatus(code Code) int
func ProblemTitle(code Code) string
func NewProblem(code Code, baseURI, detail string) Problem
func NewProblemWithTitle(code Code, baseURI, detail, title string) Problem
func WriteProblem(w http.ResponseWriter, p Problem, extra http.Header)
type ProblemWriter struct { BaseURI string; Titles map[Code]string; OnError func(http.ResponseWriter, *http.Request, Problem) }
func (pw ProblemWriter) Fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header)

type KeyStatus int
const ( KeyMissing KeyStatus = iota; KeyInvalid; KeyOK )
func LookupKey(h http.Header, name string, syntax anyonce.Syntax) (string, KeyStatus, string)
func RequestPath(r *http.Request) string
func DefaultScope(r *http.Request) string
var ErrTooLarge = errors.New("httpx: request body exceeds the configured limit")
func ReadBody(r *http.Request, limit int64) ([]byte, error)

type CaptureWriter struct { ... }
func NewCaptureWriter(w http.ResponseWriter, limit int) *CaptureWriter
func (c *CaptureWriter) WroteHeader() bool
func (c *CaptureWriter) Hijacked() bool
func (c *CaptureWriter) Result(allow map[string]bool) anyonce.StoredResult
func WriteReplay(w http.ResponseWriter, rec *anyonce.Record)
func RetryAfter(leaseUntil time.Time, policy anyonce.Policy) string

func WithInfo(ctx context.Context, key string, fence int64) context.Context
func KeyFromContext(ctx context.Context) (string, bool)
func FenceFromContext(ctx context.Context) (int64, bool)
```
- Consumed by Tasks 4, 11 and 12.

- [ ] **Step 1: Move the helper files and their tests**

Create the `httpx` files by moving the bodies of `go/httpmw/problems.go` (everything except `Options` wiring), `go/httpmw/request.go` (`keyStatus`, `keyMissing`, `keyInvalid`, `keyOK`, `errTooLarge`, `lookupKey`, `requestPath`, `defaultScope`, `readBody`), `go/httpmw/writer.go` (all of it) and `go/httpmw/context.go` (all of it) into package `httpx`, exporting each moved identifier. `retryAfter` and `writeReplay` move out of `go/httpmw/middleware.go` into `go/internal/httpx/replay.go` as `RetryAfter` and `WriteReplay`. Every exported identifier gets a doc comment. `go/internal/httpx/doc.go` says:

```go
// Package httpx holds the pieces both HTTP shaped doors need: the RFC 9457 problem catalogue, key lookup,
// bounded body reads, response capture, replay and the per request context values. It is internal to
// github.com/sns45/anyonce/go, so httpmw and webhookmw share one implementation and no one else depends on it.
package httpx
```

`captureWriter` becomes `CaptureWriter` with a constructor, because its fields are unexported and callers outside the package cannot build it:

```go
// NewCaptureWriter wraps w and buffers up to limit bytes of the body for the store (D12).
func NewCaptureWriter(w http.ResponseWriter, limit int) *CaptureWriter {
	return &CaptureWriter{ResponseWriter: w, limit: limit}
}

// WroteHeader reports whether the handler has written a status line yet.
func (c *CaptureWriter) WroteHeader() bool { return c.wroteHeader }

// Hijacked reports whether the handler took the connection, which disables idempotency (REQ-HTTP-18).
func (c *CaptureWriter) Hijacked() bool { return c.hijacked }
```

`ProblemWriter.Fail` is the `(*Middleware).fail` body with the middleware's fields passed in:

```go
// Fail writes the problem for code, honouring an OnError override and the Q23 title overrides. Extra headers and
// Cache-Control are set on the response writer before OnError runs, so an override inherits them (REQ-HTTP-13).
func (pw ProblemWriter) Fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	p := NewProblemWithTitle(code, pw.BaseURI, detail, pw.Titles[code])
	if pw.OnError != nil {
		h := w.Header()
		for name, values := range extra {
			h[http.CanonicalHeaderKey(name)] = values
		}
		h.Set("Cache-Control", "no-store")
		pw.OnError(w, r, p)
		return
	}
	WriteProblem(w, p, extra)
}
```

This body is the current `(*Middleware).fail` verbatim except for the title lookup, including the header assignment form (`h[http.CanonicalHeaderKey(name)] = values`, a replace, not an `Add`). Do not change it: the extraction must preserve `httpmw` behaviour byte for byte.

Also move `DefaultProblemBaseURI` and `DefaultMaxRequestBytes` from `go/httpmw/options.go` into `httpx` and leave aliases behind in `httpmw`, because the webhook door needs the same defaults and must not import `httpmw`. `DefaultHeaderName`, `DefaultMethods` and `DefaultStoreHeaders` stay in `httpmw`: they are HTTP door policy, not shared machinery.

Move the helper unit tests: `go/httpmw/problems_test.go`, `request_test.go`, `writer_test.go` and `context_test.go` move to `go/internal/httpx/` in package `httpx_test`, with their `REQ-HTTP-*` subtest names unchanged and their calls updated to the exported names. Any assertion in those files that reaches into `httpmw.Options` or `resolved` stays behind in `httpmw` instead of moving.

- [ ] **Step 2: Rewire `httpmw` onto `httpx`**

`go/httpmw/problems.go` becomes aliases only:

```go
package httpmw

import "github.com/sns45/anyonce/go/internal/httpx"

// Code is a stable problem code (D11).
type Code = httpx.Code

// Problem is an RFC 9457 problem details document with the anyonce code member (D10).
type Problem = httpx.Problem

// The D11 problem codes.
const (
	CodeMissingKey          = httpx.CodeMissingKey
	CodeInvalidKey          = httpx.CodeInvalidKey
	CodeConflict            = httpx.CodeConflict
	CodeFingerprintMismatch = httpx.CodeFingerprintMismatch
	CodePayloadTooLarge     = httpx.CodePayloadTooLarge
	CodeStoreUnavailable    = httpx.CodeStoreUnavailable
	CodeMissingPrincipal    = httpx.CodeMissingPrincipal
)

// NewProblem builds the problem document for code under baseURI.
func NewProblem(code Code, baseURI, detail string) Problem { return httpx.NewProblem(code, baseURI, detail) }

// WriteProblem serialises p as application/problem+json with the extra headers set, not appended.
func WriteProblem(w http.ResponseWriter, p Problem, extra http.Header) { httpx.WriteProblem(w, p, extra) }
```

`go/httpmw/context.go` keeps only:

```go
// KeyFromContext returns the idempotency key the layer claimed for this request (REQ-HTTP-14).
func KeyFromContext(ctx context.Context) (string, bool) { return httpx.KeyFromContext(ctx) }

// FenceFromContext returns the fence token of the claim this request runs under (REQ-HTTP-14).
func FenceFromContext(ctx context.Context) (int64, bool) { return httpx.FenceFromContext(ctx) }
```

`go/httpmw/request.go` keeps `resolveScope` and `fingerprint` and calls `httpx.RequestPath`, `httpx.DefaultScope`, `httpx.ReadBody`, `httpx.LookupKey`. `go/httpmw/writer.go` is deleted. `go/httpmw/middleware.go` swaps `&captureWriter{ResponseWriter: w, limit: limit}` for `httpx.NewCaptureWriter(w, limit)`, `cw.wroteHeader` for `cw.WroteHeader()`, `cw.hijacked` for `cw.Hijacked()`, `cw.result(...)` for `cw.Result(...)`, `writeReplay` for `httpx.WriteReplay`, `retryAfter` for `httpx.RetryAfter`, and `(*Middleware).fail` becomes a thin call into a `httpx.ProblemWriter` built once in `New`.

- [ ] **Step 3: Run the safety net**

Run: `GOROOT= /opt/homebrew/bin/go build -C go ./...` then `GOROOT= /opt/homebrew/bin/go vet -C go ./...` then `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`
Expected: PASS. `go/httpmw/middleware_test.go`, `go/httpmw/options_test.go`, the streaming test and `go/httpmw/conformance_test.go` are not edited in this task; if any of them fails, the extraction changed behaviour and must be corrected rather than the test.

- [ ] **Step 4: Lint**

Run: `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: clean. Every exported identifier in `httpx` needs a doc comment starting with its name.

- [ ] **Step 5: Commit**

```bash
git add go/internal go/httpmw
git commit -m "refactor(go): move the shared HTTP door helpers into go/internal/httpx with no behaviour change"
```

---

### Task 4: the Go catalogue gains the two codes and per code title overrides (REQ-WH-2, Q23)

**Files:**
- Modify: `go/internal/httpx/problems.go`, `go/internal/httpx/problems_test.go`, `go/httpmw/problems.go`, `go/httpmw/options.go`, `go/httpmw/middleware.go`, `go/httpmw/options_test.go`

**Interfaces:**
- Produces: `httpx.CodeConfigurationError`, `httpx.CodeSignatureInvalid`, `httpx.ProblemWriter.Titles map[Code]string`, `httpmw.Options.ProblemTitles map[Code]string`. Consumed by Tasks 11 and 12.

- [ ] **Step 1: Write the failing tests**

In `go/internal/httpx/problems_test.go` extend the existing status table test to cover nine codes and add:

```go
	t.Run("REQ-WH-2: configuration-error is a 500 and signature-invalid is a 401", func(t *testing.T) {
		if got := httpx.ProblemStatus(httpx.CodeConfigurationError); got != 500 {
			t.Fatalf("configuration-error status = %d, want 500", got)
		}
		if got := httpx.ProblemStatus(httpx.CodeSignatureInvalid); got != 401 {
			t.Fatalf("signature-invalid status = %d, want 401", got)
		}
		p := httpx.NewProblem(httpx.CodeConfigurationError, httpx.DefaultProblemBaseURI, "")
		if p.Type != "https://in8.sh/anyonce/problems/configuration-error" {
			t.Fatalf("type = %q", p.Type)
		}
	})

	t.Run("REQ-WH-2: a title override replaces the title and leaves the status and the code alone", func(t *testing.T) {
		p := httpx.NewProblemWithTitle(httpx.CodeConflict, httpx.DefaultProblemBaseURI, "", "A delivery with this webhook-id is still in progress")
		if p.Title != "A delivery with this webhook-id is still in progress" || p.Status != 409 || p.Code != httpx.CodeConflict {
			t.Fatalf("problem = %+v", p)
		}
	})
```

In `go/httpmw/options_test.go`:

```go
	t.Run("REQ-WH-2: ProblemTitles reaches the problem the middleware renders", func(t *testing.T) {
		mw := httpmw.New(memory.New(), httpmw.Options{
			Required:      true,
			ProblemTitles: map[httpmw.Code]string{httpmw.CodeMissingKey: "The webhook-id header is required for this request"},
		})
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/hook", strings.NewReader("x"))
		mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })).ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var p httpmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Title != "The webhook-id header is required for this request" || p.Code != httpmw.CodeMissingKey {
			t.Fatalf("problem = %+v", p)
		}
	})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./internal/httpx/... ./httpmw/...`
Expected: FAIL, the constants and the option do not exist.

- [ ] **Step 3: Implement**

In `go/internal/httpx/problems.go` add the two consts, their status and title map entries (titles matching the TypeScript strings exactly), `NewProblemWithTitle`, and `ProblemStatus`/`ProblemTitle` accessors over the unexported maps. In `go/httpmw/problems.go` add the two alias consts. In `go/httpmw/options.go`:

```go
	// ProblemTitles overrides the title of one or more problem codes (Q23). The status and the code member are
	// fixed by D11 and are not overridable. A nil map keeps the defaults.
	ProblemTitles map[Code]string
```

and carry it into the `ProblemWriter` that `New` builds.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./...` then `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add go/internal/httpx go/httpmw
git commit -m "feat(go): REQ-WH-2 add configuration-error and signature-invalid and per code title overrides"
```

**Branch and PR for Tasks 3 and 4:** branch `p4b-go-httpx`, PR to `p4b-webhooks` titled `P4b: share the Go HTTP door helpers through go/internal/httpx`, body says `Part of #13`, lists REQ-HTTP-13, REQ-HTTP-18 and REQ-WH-2, and pastes the Go gate output.

---

### Task 5: `@anyonce/webhooks` scaffold and the verification gate, with no happy path (REQ-WH-2, D16, Q26)

This task exists on its own so that the gate test precedes the happy path in git history, which is the first CHECKLIST P4b item. It must be merged as its own squash commit before Task 6's.

**Files:**
- Create: `packages/webhooks/package.json`, `packages/webhooks/tsconfig.json`, `packages/webhooks/src/marker.ts`, `packages/webhooks/src/receiver.ts`, `packages/webhooks/src/index.ts`, `packages/webhooks/test/gate.test.ts`
- Modify: `package.json` (root `devDependencies` and the `test` script)

**Interfaces:**
- Consumes: `problem`, `problemResponse`, `readBody`, `resolveHttpOptions`, `ProblemCode`, `ProblemTitles`, `HttpIdempotencyOptions`, `FetchLikeHandler` from `@anyonce/core/http`.
- Produces:
```ts
export const DEFAULT_ID_HEADER = 'webhook-id';
export function markVerified(req: Request, marker: string): void;
export function isVerified(req: Request, marker: string): boolean;
export interface WebhookReceiverOptions { /* see Step 3 */ }
export function webhookReceiver(
  options: WebhookReceiverOptions,
): <Rest extends unknown[]>(handler: FetchLikeHandler<Rest>) => (req: Request, ...rest: Rest) => Promise<Response>;
```
Consumed by Tasks 6, 7, 8 and 9.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/webhooks/package.json` (copy the `@anyonce/hono` shape; no `dependencies`):

```json
{
  "name": "@anyonce/webhooks",
  "version": "0.0.0",
  "description": "Standard Webhooks receiver for anyonce: idempotent webhook delivery after signature verification",
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
    "@anyonce/core": "workspace:*"
  },
  "devDependencies": {
    "@anyonce/core": "workspace:*"
  }
}
```

`packages/webhooks/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Root `package.json`: add `"@anyonce/webhooks": "workspace:*"` to `devDependencies` and append ` packages/webhooks` to the `test` script's path list (it must not be a substring of any `packages/stores/services/*.test.ts` path, and `packages/webhooks` is not).

- [ ] **Step 2: Write the failing gate tests**

`packages/webhooks/test/gate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { Operation, Store } from '@anyonce/core';
import { markVerified, webhookReceiver } from '../src/index';

function countingStore(): { store: Store; begins: Operation[] } {
  const inner = new MemoryStore();
  const begins: Operation[] = [];
  const store: Store = {
    begin(op, opts) {
      begins.push(op);
      return inner.begin(op, opts);
    },
    complete: (op, fence, result, now) => inner.complete(op, fence, result, now),
    abandon: (op, fence) => inner.abandon(op, fence),
    get: (op, now) => inner.get(op, now),
    purge: (now) => inner.purge(now),
  };
  return { store, begins };
}

function delivery(body = '{"a":1}', headers: Record<string, string> = { 'webhook-id': 'msg_1' }): Request {
  return new Request('https://example.test/hooks/stripe', { method: 'POST', headers, body });
}

describe('verification gate', () => {
  test('REQ-WH-2: a receiver with neither verify nor verifiedMarker answers 500 configuration-error and never calls begin', async () => {
    const { store, begins } = countingStore();
    const messages: string[] = [];
    const handler = webhookReceiver({ store, logger: (m) => messages.push(m) })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('configuration-error');
    expect(body.status).toBe(500);
    expect(begins).toEqual([]);
    expect(messages).toHaveLength(1);
  });

  test('REQ-WH-2: the configuration error logs once however many requests arrive', async () => {
    const { store } = countingStore();
    const messages: string[] = [];
    const handler = webhookReceiver({ store, logger: (m) => messages.push(m) })(
      async () => new Response('handled'),
    );
    await handler(delivery());
    await handler(delivery());
    await handler(delivery());
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('msg_1');
  });

  test('REQ-WH-2: a verify callback that returns false answers 401 signature-invalid and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verify: () => false })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe('signature-invalid');
    expect(begins).toEqual([]);
  });

  test('REQ-WH-2: verify sees the raw body bytes and the request', async () => {
    const { store } = countingStore();
    const seen: string[] = [];
    const handler = webhookReceiver({
      store,
      verify: (req, body) => {
        seen.push(`${new URL(req.url).pathname}:${new TextDecoder().decode(body)}`);
        return false;
      },
    })(async () => new Response('handled'));
    await handler(delivery('{"b":2}'));
    expect(seen).toEqual(['/hooks/stripe:{"b":2}']);
  });

  test('REQ-WH-2: a verifiedMarker that was never set answers 401 and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verifiedMarker: 'gateway' })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery());
    expect(res.status).toBe(401);
    expect(begins).toEqual([]);
  });

  test('REQ-WH-2: a marker set by an upstream verifier passes the gate', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verifiedMarker: 'gateway' })(
      async () => new Response('handled', { status: 202 }),
    );
    const req = delivery();
    markVerified(req, 'gateway');
    const res = await handler(req);
    expect(res.status).toBe(202);
    expect(begins).toHaveLength(1);
  });

  test('REQ-WH-2: an oversized body is 413 before verification and never calls begin', async () => {
    const { store, begins } = countingStore();
    const handler = webhookReceiver({ store, verify: () => false, maxRequestBytes: 8 })(
      async () => new Response('handled'),
    );
    const res = await handler(delivery('x'.repeat(64)));
    expect(res.status).toBe(413);
    expect((await res.json() as { code: string }).code).toBe('payload-too-large');
    expect(begins).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/webhooks`
Expected: FAIL, `../src/index` does not exist.

- [ ] **Step 4: Implement the marker registry**

`packages/webhooks/src/marker.ts`:

```ts
/**
 * D16: the verified marker an upstream verifier sets. It lives in a WeakMap keyed by the Request object rather
 * than in a header, because a header can be forged by anything that reaches the receiver and the whole point of
 * the gate is that a forged delivery never claims to be verified. A fetch handler has no context object, so the
 * Request itself is the context.
 */
const markers = new WeakMap<Request, Set<string>>();

/** Records that this request has been verified under the named marker. Call it on the Request the receiver sees. */
export function markVerified(req: Request, marker: string): void {
  const set = markers.get(req);
  if (set === undefined) markers.set(req, new Set([marker]));
  else set.add(marker);
}

/** Reports whether markVerified was called for this request and marker. */
export function isVerified(req: Request, marker: string): boolean {
  return markers.get(req)?.has(marker) === true;
}
```

- [ ] **Step 5: Implement the receiver skeleton and the gate**

`packages/webhooks/src/receiver.ts` (the key resolution, the scope and the hooks arrive in Task 6; this task ends at `runIdempotent` with the defaults):

```ts
import type { IdempotencyRecord } from '@anyonce/core';
import {
  type FetchLikeHandler,
  type HttpIdempotencyOptions,
  type ProblemCode,
  type ProblemTitles,
  type ResolvedHttpOptions,
  problem,
  problemResponse,
  readBody,
  resolveHttpOptions,
  runIdempotent,
} from '@anyonce/core/http';
import { isVerified } from './marker';

/** REQ-WH-1: the Standard Webhooks id header. */
export const DEFAULT_ID_HEADER = 'webhook-id';

export interface WebhookReceiverOptions
  extends Omit<HttpIdempotencyOptions, 'headerName' | 'problemTitles'> {
  /** REQ-WH-1: the header the delivery id arrives in. Default webhook-id. */
  idHeader?: string;
  /** REQ-WH-1: a body derived id (Stripe event.id, a GitHub delivery header). Wins over idHeader. */
  key?: (req: Request, body: Uint8Array) => string | undefined;
  /** D16: runs before the store. A false result is 401 signature-invalid. */
  verify?: (req: Request, body: Uint8Array) => boolean | Promise<boolean>;
  /** D16: the name of a marker an upstream verifier set with markVerified. */
  verifiedMarker?: string;
  /** REQ-WH-5: fires when the same id arrives with a different body. Never throws into the receiver. */
  onSuspicious?: (req: Request, record: IdempotencyRecord) => void;
  /** D8: the route half of the scope. Default is the request pathname. */
  routePattern?: string | ((req: Request) => string);
  /** D8 and Q24: the verified sender identity. When it yields nothing the scope is the route alone. */
  sourceId?: (req: Request, body: Uint8Array) => string | undefined;
  /** Q23: overrides on top of the webhook defaults, which name idHeader. */
  problemTitles?: ProblemTitles;
  /** Q26: where the one configuration-error message goes. Default console.error. */
  logger?: (message: string) => void;
}

const CONFIGURATION_MESSAGE =
  'anyonce: webhookReceiver was built with neither verify nor verifiedMarker, so no delivery can be accepted (REQ-WH-2)';

function webhookTitles(idHeader: string, overrides?: ProblemTitles): ProblemTitles {
  return {
    'missing-key': `The ${idHeader} header is required for this request`,
    'invalid-key': `The ${idHeader} header value is not a valid key`,
    conflict: `A delivery with this ${idHeader} is still in progress`,
    'fingerprint-mismatch': `This ${idHeader} was already delivered with a different payload`,
    'configuration-error': 'This webhook endpoint runs no signature verification and cannot accept a delivery',
    'signature-invalid': 'The webhook signature could not be verified',
    ...overrides,
  };
}

export function webhookReceiver(options: WebhookReceiverOptions) {
  const idHeader = options.idHeader ?? DEFAULT_ID_HEADER;
  const titles = webhookTitles(idHeader, options.problemTitles);
  const log = options.logger ?? ((message: string): void => console.error(message));
  const base: HttpIdempotencyOptions = {
    ...options,
    headerName: idHeader,
    required: options.required ?? true,
    methods: options.methods ?? ['POST'],
    problemTitles: titles,
  };
  const resolved: ResolvedHttpOptions = resolveHttpOptions(base);
  let logged = false;

  return <Rest extends unknown[]>(handler: FetchLikeHandler<Rest>) => {
    return async (req: Request, ...rest: Rest): Promise<Response> => {
      const fail = async (code: ProblemCode): Promise<Response> => {
        const p = problem(code, resolved.problemBaseUri, undefined, titles[code]);
        if (resolved.onError !== undefined) return resolved.onError(p, req);
        return problemResponse(p);
      };

      // D16: the configuration check is first, so a receiver that can never verify anything never runs a handler.
      if (options.verify === undefined && options.verifiedMarker === undefined) {
        if (!logged) {
          logged = true;
          log(CONFIGURATION_MESSAGE);
        }
        return fail('configuration-error');
      }
      if (!resolved.methods.has(req.method)) return handler(req, ...rest);

      const read = await readBody(req, resolved.maxRequestBytes);
      if (!read.ok) return fail('payload-too-large');

      const verified =
        options.verify !== undefined
          ? (await options.verify(req, read.body)) === true
          : isVerified(req, options.verifiedMarker as string);
      if (!verified) return fail('signature-invalid');

      return runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), resolved, {
        body: read.body,
      });
    };
  };
}
```

`packages/webhooks/src/index.ts`:

```ts
export { isVerified, markVerified } from './marker';
export type { WebhookReceiverOptions } from './receiver';
export { DEFAULT_ID_HEADER, webhookReceiver } from './receiver';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun install` then `bun test packages/webhooks`
Expected: PASS, seven tests.

- [ ] **Step 7: Commit**

```bash
git add packages/webhooks package.json bun.lock
git commit -m "feat(webhooks): REQ-WH-2 the verification gate, before the key and before the store"
```

**Branch and PR:** branch `p4b-webhooks-gate`, PR to `p4b-webhooks` titled `P4b: the webhook verification gate`, body says `Part of #13` and `The gate lands before the happy path, per the first CHECKLIST P4b item`, lists REQ-WH-2, and pastes `bun run lint`, `bun run build`, `bun test packages/webhooks`.

---

### Task 6: the receiver's key, scope, fingerprint, replay, conflict and mismatch (REQ-WH-1, REQ-WH-3, REQ-WH-4, REQ-WH-5, Q24, Q25)

**Files:**
- Modify: `packages/webhooks/src/receiver.ts`
- Create: `packages/webhooks/test/receiver.test.ts`

**Interfaces:**
- Consumes: `RunContext.keyLookup` and `RunContext.body` from Task 2, `parseKey` and `sha256Hex` from `@anyonce/core`.
- Produces: no new exported names; the behaviour Tasks 8 and 9 assert.

- [ ] **Step 1: Write the failing tests**

`packages/webhooks/test/receiver.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { IdempotencyRecord } from '@anyonce/core';
import { webhookReceiver } from '../src/index';

const store = (): MemoryStore => new MemoryStore();

function delivery(
  id: string | undefined,
  body: string,
  path = '/hooks/stripe',
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (id !== undefined) headers['webhook-id'] = id;
  return new Request(`https://example.test${path}`, { method: 'POST', headers, body });
}

describe('webhook receiver', () => {
  test('REQ-WH-1: the delivery id comes from the webhook-id header and becomes the store key', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('handled', { status: 200 });
    });
    const res = await handler(delivery('msg_2ab', '{"a":1}'));
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
    const record = await s.get({ scope: '/hooks/stripe', key: 'msg_2ab' }, Date.now());
    expect(record?.state).toBe('completed');
  });

  test('REQ-WH-1: a key function reads the id out of the body and wins over the header', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      key: (_req, body) => (JSON.parse(new TextDecoder().decode(body)) as { id: string }).id,
    })(async () => new Response('handled'));
    await handler(delivery('msg_header', '{"id":"evt_body"}'));
    expect(await s.get({ scope: '/hooks/stripe', key: 'evt_body' }, Date.now())).not.toBeNull();
    expect(await s.get({ scope: '/hooks/stripe', key: 'msg_header' }, Date.now())).toBeNull();
  });

  test('REQ-WH-1: a verified delivery with no id is 400 missing-key', async () => {
    const handler = webhookReceiver({ store: store(), verify: () => true })(
      async () => new Response('never'),
    );
    const res = await handler(delivery(undefined, '{"a":1}'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; title: string };
    expect(body.code).toBe('missing-key');
    expect(body.title).toBe('The webhook-id header is required for this request');
  });

  test('REQ-WH-1: an id longer than 255 bytes is 400 invalid-key', async () => {
    const handler = webhookReceiver({ store: store(), verify: () => true })(
      async () => new Response('never'),
    );
    const res = await handler(delivery('m'.repeat(256), '{"a":1}'));
    expect(res.status).toBe(400);
    expect((await res.json() as { code: string }).code).toBe('invalid-key');
  });

  test('REQ-WH-1: the scope is the route pattern alone when no sourceId is configured', async () => {
    const s = store();
    const handler = webhookReceiver({ store: s, verify: () => true, routePattern: '/hooks/:provider' })(
      async () => new Response('handled'),
    );
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: '/hooks/:provider', key: 'msg_scope' }, Date.now())).not.toBeNull();
  });

  test('REQ-WH-1: a sourceId is appended to the route pattern after a slash', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      routePattern: '/hooks/:provider',
      sourceId: () => 'acct_42',
    })(async () => new Response('handled'));
    await handler(delivery('msg_scope', '{"a":1}'));
    expect(await s.get({ scope: '/hooks/:provider/acct_42', key: 'msg_scope' }, Date.now())).not.toBeNull();
  });

  test('REQ-WH-1: the same id in two source scopes runs the handler twice', async () => {
    const s = store();
    let runs = 0;
    const make = (source: string) =>
      webhookReceiver({ store: s, verify: () => true, sourceId: () => source })(async () => {
        runs += 1;
        return new Response('handled');
      });
    await make('acct_1')(delivery('msg_shared', '{"a":1}'));
    await make('acct_2')(delivery('msg_shared', '{"a":1}'));
    expect(runs).toBe(2);
  });

  test('REQ-WH-1: the fingerprint is SHA-256 over the body bytes alone, so the same body on two paths matches', async () => {
    const s = store();
    const handler = webhookReceiver({ store: s, verify: () => true, routePattern: '/hooks' })(
      async () => new Response('handled'),
    );
    await handler(delivery('msg_fp', '{"a":1}', '/hooks/one'));
    const first = await s.get({ scope: '/hooks', key: 'msg_fp' }, Date.now());
    const second = await handler(delivery('msg_fp', '{"a":1}', '/hooks/two'));
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(first?.fingerprint).toBe(
      (await s.get({ scope: '/hooks', key: 'msg_fp' }, Date.now()))?.fingerprint,
    );
  });

  test('REQ-WH-3: a redelivery replays the stored response with Idempotency-Replayed true and runs the handler once', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('{"ok":true}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    });
    const first = await handler(delivery('msg_replay', '{"a":1}'));
    const second = await handler(delivery('msg_replay', '{"a":1}'));
    expect(first.status).toBe(202);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();
    expect(second.status).toBe(202);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.text()).toBe('{"ok":true}');
    expect(runs).toBe(1);
  });

  test('REQ-WH-3: a stored 4xx replays as the stored 4xx, because D6 stores every status below 500', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('rejected', { status: 422 });
    });
    await handler(delivery('msg_4xx', '{"a":1}'));
    const second = await handler(delivery('msg_4xx', '{"a":1}'));
    expect(second.status).toBe(422);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(runs).toBe(1);
  });

  test('REQ-WH-4: a redelivery while the first is in flight is 409 with Retry-After at least 1', async () => {
    const s = store();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = webhookReceiver({ store: s, verify: () => true, leaseMs: 30_000 })(async () => {
      await gate;
      return new Response('handled');
    });
    const first = handler(delivery('msg_inflight', '{"a":1}'));
    const second = await handler(delivery('msg_inflight', '{"a":1}'));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; title: string };
    expect(body.code).toBe('conflict');
    expect(body.title).toBe('A delivery with this webhook-id is still in progress');
    expect(Number(second.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    release();
    expect((await first).status).toBe(200);
  });

  test('REQ-WH-5: the same id with a different body is 422 and fires onSuspicious with the stored record', async () => {
    const s = store();
    const suspicious: Array<{ path: string; record: IdempotencyRecord }> = [];
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      onSuspicious: (req, record) => {
        suspicious.push({ path: new URL(req.url).pathname, record });
      },
    })(async () => new Response('handled'));
    await handler(delivery('msg_mismatch', '{"amount":10}'));
    const second = await handler(delivery('msg_mismatch', '{"amount":9000}'));
    expect(second.status).toBe(422);
    const body = (await second.json()) as { code: string; title: string };
    expect(body.code).toBe('fingerprint-mismatch');
    expect(body.title).toBe('This webhook-id was already delivered with a different payload');
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]?.path).toBe('/hooks/stripe');
    expect(suspicious[0]?.record.key).toBe('msg_mismatch');
    expect(suspicious[0]?.record.state).toBe('completed');
  });

  test('REQ-WH-5: an onSuspicious hook that throws does not change the 422', async () => {
    const s = store();
    const handler = webhookReceiver({
      store: s,
      verify: () => true,
      onSuspicious: () => {
        throw new Error('hook exploded');
      },
    })(async () => new Response('handled'));
    await handler(delivery('msg_throwing', '{"a":1}'));
    const second = await handler(delivery('msg_throwing', '{"a":2}'));
    expect(second.status).toBe(422);
  });

  test('REQ-WH-1: a GET passes through untouched because the receiver applies to POST only', async () => {
    const s = store();
    let runs = 0;
    const handler = webhookReceiver({ store: s, verify: () => true })(async () => {
      runs += 1;
      return new Response('handled');
    });
    const res = await handler(new Request('https://example.test/hooks/stripe', { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
    expect(res.headers.get('Idempotency-Replayed')).toBeNull();
  });

  test('REQ-WH-1: the handler receives the body unread', async () => {
    const s = store();
    const seen: string[] = [];
    const handler = webhookReceiver({ store: s, verify: () => true })(async (req) => {
      seen.push(await req.text());
      return new Response('handled');
    });
    await handler(delivery('msg_body', '{"payload":"intact"}'));
    expect(seen).toEqual(['{"payload":"intact"}']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/webhooks/test/receiver.test.ts`
Expected: FAIL, the scope is still the HTTP default `POST /hooks/stripe` and no key function, sourceId or onSuspicious is wired.

- [ ] **Step 3: Implement the key, the scope, the fingerprint and the hook**

In `packages/webhooks/src/receiver.ts` the two import lines become (`parseKey` and `sha256Hex` live on the root entry, `KeyLookup` on the http subpath):

```ts
import { type IdempotencyRecord, parseKey, sha256Hex } from '@anyonce/core';
import {
  type FetchLikeHandler,
  type HttpIdempotencyOptions,
  type KeyLookup,
  type ProblemCode,
  type ProblemTitles,
  type ResolvedHttpOptions,
  problem,
  problemResponse,
  readBody,
  resolveHttpOptions,
  runIdempotent,
} from '@anyonce/core/http';
```

Add the base option overrides where `base` is built:

```ts
  const base: HttpIdempotencyOptions = {
    ...options,
    headerName: idHeader,
    required: options.required ?? true,
    methods: options.methods ?? ['POST'],
    // D9: the webhook fingerprint is the body bytes alone, so the same delivery on two paths still matches.
    fingerprint: options.fingerprint ?? ((_req, body) => sha256Hex(body)),
    problemTitles: titles,
  };
```

Add the two helpers above `webhookReceiver`:

```ts
/** REQ-WH-1 and Q25: the id becomes the store key, so it is length and charset checked, never sf-string parsed. */
function resolveKey(
  req: Request,
  body: Uint8Array,
  idHeader: string,
  key?: (req: Request, body: Uint8Array) => string | undefined,
): KeyLookup {
  const raw = key !== undefined ? key(req, body) : (req.headers.get(idHeader) ?? undefined);
  if (raw === undefined || raw === '') return { kind: 'missing' };
  const parsed = parseKey(raw, 'lenient');
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  return { kind: 'ok', key: parsed.key };
}

/** D8 and Q24: `${routePattern}/${sourceId}`, or the route alone when no sender identity is available. */
function webhookScope(
  req: Request,
  body: Uint8Array,
  routePattern: string | ((req: Request) => string) | undefined,
  sourceId: ((req: Request, body: Uint8Array) => string | undefined) | undefined,
): string {
  const route =
    routePattern === undefined
      ? new URL(req.url).pathname
      : typeof routePattern === 'string'
        ? routePattern
        : routePattern(req);
  const source = sourceId?.(req, body);
  return source === undefined || source === '' ? route : `${route}/${source}`;
}
```

Replace the final `runIdempotent` call in the returned handler with:

```ts
      const keyLookup = resolveKey(req, read.body, idHeader, options.key);
      const routeScope = webhookScope(req, read.body, options.routePattern, options.sourceId);

      // REQ-WH-5: the hook wants the request, and the engine's onMismatch only carries the operation, so the
      // policy is rebuilt per request with the request closed over. Hooks never throw into the engine.
      const perRequest: ResolvedHttpOptions = {
        ...resolved,
        policy: {
          ...resolved.policy,
          hooks: {
            ...resolved.policy.hooks,
            onMismatch(op, record) {
              resolved.policy.hooks?.onMismatch?.(op, record);
              options.onSuspicious?.(req, record);
            },
          },
        },
      };

      return runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), perRequest, {
        routeScope,
        keyLookup,
        body: read.body,
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/webhooks` then `bun run lint` then `bun run build` then `bun run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webhooks
git commit -m "feat(webhooks): REQ-WH-1 REQ-WH-3 REQ-WH-4 REQ-WH-5 the receiver key, scope, replay, conflict and mismatch"
```

**Branch and PR:** branch `p4b-webhooks-receiver`, PR to `p4b-webhooks` titled `P4b: the webhook receiver`, body says `Part of #13`, lists REQ-WH-1, REQ-WH-3, REQ-WH-4, REQ-WH-5, and pastes the gate output.

---

### Task 7: `standardWebhooksVerify(secret)` (REQ-WH-6)

**Files:**
- Create: `packages/webhooks/src/verify.ts`, `packages/webhooks/test/verify.test.ts`
- Modify: `packages/webhooks/src/index.ts`

**Interfaces:**
- Produces:
```ts
export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 300;
export interface StandardWebhooksOptions { toleranceSeconds?: number; clock?: () => number }
export function standardWebhooksVerify(
  secret: string | string[],
  options?: StandardWebhooksOptions,
): (req: Request, body: Uint8Array) => Promise<boolean>;
```
Consumed by Task 8 and by the P6 example.

- [ ] **Step 1: Write the failing tests**

`packages/webhooks/test/verify.test.ts`. The three golden rows are copied verbatim from `docs/reference/anyhook-signing.md`:

```ts
import { describe, expect, test } from 'bun:test';
import { standardWebhooksVerify } from '../src/index';

const encoder = new TextEncoder();

const SECRET_A = 'whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB';
const SECRET_B = 'whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB';

interface Vector {
  name: string;
  secrets: string[];
  id: string;
  payload: string;
  timestamp: number;
  signature: string;
}

const VECTORS: Vector[] = [
  {
    name: 'single_secret',
    secrets: [SECRET_A],
    id: 'msg_1',
    payload: '{"a":1}',
    timestamp: 1700000000,
    signature: 'v1,g9EIBBIwm31AQEkP7q60DV8jDWYbrjV7TTZJL+PIcMo=',
  },
  {
    name: 'rotation_two_secrets',
    secrets: [SECRET_A, SECRET_B],
    id: 'msg_2',
    payload: '{"nested":{"b":[1,2,3]},"unicode":"café"}',
    timestamp: 1700000001,
    signature:
      'v1,Quo14+anAi2BEdvq/rAJ6acir9k1eo5oapk44aRYF6Y= v1,DA4ZWdZKEG9r6wHFCDZPQA+nmyvCvC6qn44us/GbmOw=',
  },
  {
    name: 'empty_object_payload',
    secrets: [SECRET_A],
    id: 'msg_3',
    payload: '{}',
    timestamp: 0,
    signature: 'v1,rPUBbAcJfBgq5bbh2lc3N+SdRs/ySWgI2QxJlbKwSBU=',
  },
];

function signed(v: Vector, overrides: Record<string, string> = {}): Request {
  return new Request('https://example.test/hooks', {
    method: 'POST',
    headers: {
      'webhook-id': v.id,
      'webhook-timestamp': String(v.timestamp),
      'webhook-signature': v.signature,
      ...overrides,
    },
    body: v.payload,
  });
}

describe('standardWebhooksVerify', () => {
  for (const v of VECTORS) {
    test(`REQ-WH-6: the ${v.name} anyhook golden vector verifies`, async () => {
      const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
      expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
    });
  }

  test('REQ-WH-6: a rotation signature verifies against either secret', async () => {
    const v = VECTORS[1] as Vector;
    for (const secret of v.secrets) {
      const verify = standardWebhooksVerify(secret, { clock: () => v.timestamp * 1000 });
      expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
    }
  });

  test('REQ-WH-6: a receiver holding two secrets verifies a payload signed with either', async () => {
    const v = VECTORS[1] as Vector;
    const verify = standardWebhooksVerify(v.secrets, { clock: () => v.timestamp * 1000 });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a secret without the whsec_ prefix is the same key', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', {
      clock: () => v.timestamp * 1000,
    });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a changed body fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(await verify(signed(v), encoder.encode('{"a":2}'))).toBe(false);
  });

  test('REQ-WH-6: a changed id fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(await verify(signed(v, { 'webhook-id': 'msg_other' }), encoder.encode(v.payload))).toBe(false);
  });

  test('REQ-WH-6: each of the three headers is required', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
      const req = signed(v);
      req.headers.delete(name);
      expect(await verify(req, encoder.encode(v.payload))).toBe(false);
    }
  });

  test('REQ-WH-6: the headers are matched case-insensitively', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    const req = new Request('https://example.test/hooks', {
      method: 'POST',
      headers: {
        'Webhook-Id': v.id,
        'Webhook-Timestamp': String(v.timestamp),
        'Webhook-Signature': v.signature,
      },
      body: v.payload,
    });
    expect(await verify(req, encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a timestamp that is not a finite number fails', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(
      await verify(signed(v, { 'webhook-timestamp': 'yesterday' }), encoder.encode(v.payload)),
    ).toBe(false);
  });

  test('REQ-WH-6: a timestamp outside the 300 second tolerance fails on either side', async () => {
    const v = VECTORS[0] as Vector;
    const late = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp + 301) * 1000,
    });
    const early = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp - 301) * 1000,
    });
    expect(await late(signed(v), encoder.encode(v.payload))).toBe(false);
    expect(await early(signed(v), encoder.encode(v.payload))).toBe(false);
  });

  test('REQ-WH-6: a timestamp at the tolerance edge still verifies', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, {
      clock: () => (v.timestamp + 300) * 1000,
    });
    expect(await verify(signed(v), encoder.encode(v.payload))).toBe(true);
  });

  test('REQ-WH-6: a fractional timestamp is accepted and truncated, matching anyhook', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(
      await verify(signed(v, { 'webhook-timestamp': `${v.timestamp}.75` }), encoder.encode(v.payload)),
    ).toBe(true);
  });

  test('REQ-WH-6: an entry with an unknown version prefix is ignored and the rest still decide', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(
      await verify(signed(v, { 'webhook-signature': `v2,abc ${v.signature}` }), encoder.encode(v.payload)),
    ).toBe(true);
    expect(await verify(signed(v, { 'webhook-signature': 'v2,abc' }), encoder.encode(v.payload))).toBe(
      false,
    );
  });

  test('REQ-WH-6: a signature entry that is not base64 fails instead of throwing', async () => {
    const v = VECTORS[0] as Vector;
    const verify = standardWebhooksVerify(v.secrets[0] as string, { clock: () => v.timestamp * 1000 });
    expect(await verify(signed(v, { 'webhook-signature': 'v1,!!!not base64!!!' }), encoder.encode(v.payload))).toBe(
      false,
    );
  });

  test('REQ-WH-6: a secret whose base64 does not decode throws at construction, not per request', () => {
    expect(() => standardWebhooksVerify('whsec_!!!')).toThrow();
  });
});
```

The `café` payload is a literal UTF-8 string in the file, which is what the anyhook golden row signed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/webhooks/test/verify.test.ts`
Expected: FAIL, `standardWebhooksVerify` is not exported.

- [ ] **Step 3: Implement**

`packages/webhooks/src/verify.ts`:

```ts
/**
 * REQ-WH-6: the Standard Webhooks signature check, Web APIs only. The wire format is recorded in
 * docs/reference/anyhook-signing.md and this implementation is byte compatible with the anyhook signer, which
 * itself round trips against the reference standardwebhooks package.
 */

/** The optional prefix on a Standard Webhooks secret. */
export const SECRET_PREFIX = 'whsec_';

/** The tolerance the specification names, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StandardWebhooksOptions {
  /** Absolute difference between now and the header timestamp, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Epoch milliseconds, for tests. Default Date.now. */
  clock?: () => number;
}

const encoder = new TextEncoder();

function base64ToBytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** Strips the whsec_ prefix and decodes the standard base64 remainder. Throws on a secret that cannot decode. */
export function parseSecret(secret: string): Uint8Array {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const bytes = base64ToBytes(raw);
  if (bytes === undefined) throw new TypeError('anyonce: the webhook secret is not valid base64');
  return bytes;
}

/** Constant time byte comparison: every byte is read whatever the first difference is. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function standardWebhooksVerify(
  secret: string | string[],
  options: StandardWebhooksOptions = {},
): (req: Request, body: Uint8Array) => Promise<boolean> {
  const secrets = (Array.isArray(secret) ? secret : [secret]).map(parseSecret);
  if (secrets.length === 0) throw new TypeError('anyonce: standardWebhooksVerify needs at least one secret');
  const tolerance = (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  const clock = options.clock ?? Date.now;
  const keys = secrets.map((raw) =>
    crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  );

  return async (req, body) => {
    const id = req.headers.get('webhook-id');
    const timestamp = req.headers.get('webhook-timestamp');
    const signature = req.headers.get('webhook-signature');
    if (id === null || timestamp === null || signature === null) return false;

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return false;
    if (Math.abs(clock() - Math.trunc(seconds) * 1000) > tolerance) return false;

    const presented: Uint8Array[] = [];
    for (const entry of signature.split(' ')) {
      if (!entry.startsWith('v1,')) continue;
      const bytes = base64ToBytes(entry.slice(3));
      if (bytes !== undefined) presented.push(bytes);
    }
    if (presented.length === 0) return false;

    const prefix = encoder.encode(`${id}.${Math.trunc(seconds)}.`);
    const content = new Uint8Array(prefix.byteLength + body.byteLength);
    content.set(prefix, 0);
    content.set(body, prefix.byteLength);

    let matched = false;
    for (const keyPromise of keys) {
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await keyPromise, content as BufferSource));
      for (const candidate of presented) if (equalBytes(mac, candidate)) matched = true;
    }
    return matched;
  };
}
```

The double loop runs to completion rather than returning early, so the time the check takes does not depend on which entry matched.

Add to `packages/webhooks/src/index.ts`:

```ts
export type { StandardWebhooksOptions } from './verify';
export { DEFAULT_TOLERANCE_SECONDS, parseSecret, SECRET_PREFIX, standardWebhooksVerify } from './verify';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/webhooks` then `bun run lint`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webhooks
git commit -m "feat(webhooks): REQ-WH-6 standardWebhooksVerify against the anyhook golden vectors"
```

---

### Task 8: the anyhook interop round trip in TypeScript (REQ-WH-6, Q27)

**Files:**
- Create: `packages/webhooks/test/interop.test.ts`
- Modify: `packages/webhooks/package.json` (devDependency `@anyhook/signing`), `bun.lock`

**Interfaces:**
- Consumes: `Signer` and `generateSecret` from `@anyhook/signing` 0.2.2; `webhookReceiver` and `standardWebhooksVerify` from Tasks 5, 6 and 7.

- [ ] **Step 1: Add the devDependency**

Run: `bun add -d @anyhook/signing@0.2.2 --cwd packages/webhooks`
It is a devDependency, so `@anyonce/webhooks` still ships with zero `dependencies` and D21 is unaffected.

- [ ] **Step 2: Write the failing test**

`packages/webhooks/test/interop.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { generateSecret, Signer } from '@anyhook/signing';
import { MemoryStore } from '@anyonce/core';
import type { IdempotencyRecord } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '../src/index';

function deliver(secret: string, id: string, payload: string): Request {
  const headers = new Signer(secret).headers(id, payload);
  return new Request('https://example.test/hooks/anyhook', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: payload,
  });
}

describe('anyhook interop', () => {
  test('REQ-WH-6: a delivery signed by anyhook is accepted, and the redelivery replays', async () => {
    const secret = generateSecret();
    const store = new MemoryStore();
    let runs = 0;
    const handler = webhookReceiver({ store, verify: standardWebhooksVerify(secret) })(async () => {
      runs += 1;
      return new Response('{"received":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const first = await handler(deliver(secret, 'msg_interop_1', '{"event":"payment.succeeded"}'));
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();

    const second = await handler(deliver(secret, 'msg_interop_1', '{"event":"payment.succeeded"}'));
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await second.text()).toBe('{"received":true}');
    expect(runs).toBe(1);
  });

  test('REQ-WH-6: a delivery signed with a different secret is 401 and never runs the handler', async () => {
    const store = new MemoryStore();
    let runs = 0;
    const handler = webhookReceiver({ store, verify: standardWebhooksVerify(generateSecret()) })(
      async () => {
        runs += 1;
        return new Response('handled');
      },
    );
    const res = await handler(deliver(generateSecret(), 'msg_interop_2', '{"a":1}'));
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe('signature-invalid');
    expect(runs).toBe(0);
  });

  test('REQ-WH-6: a rotation signature from anyhook verifies against either secret the receiver holds', async () => {
    const older = generateSecret();
    const newer = generateSecret();
    const payload = '{"event":"rotated"}';
    const headers = new Signer([older, newer]).headers('msg_interop_3', payload);
    const req = new Request('https://example.test/hooks/anyhook', {
      method: 'POST',
      headers,
      body: payload,
    });
    const verify = standardWebhooksVerify(newer);
    expect(await verify(req, new TextEncoder().encode(payload))).toBe(true);
  });

  test('REQ-WH-5: a tampered body under a signed id that already landed is 422 and fires onSuspicious', async () => {
    const secret = generateSecret();
    const store = new MemoryStore();
    const suspicious: IdempotencyRecord[] = [];
    const handler = webhookReceiver({
      store,
      verify: standardWebhooksVerify(secret),
      onSuspicious: (_req, record) => {
        suspicious.push(record);
      },
    })(async () => new Response('handled'));

    await handler(deliver(secret, 'msg_interop_4', '{"amount":10}'));
    const tampered = await handler(deliver(secret, 'msg_interop_4', '{"amount":9000}'));
    expect(tampered.status).toBe(422);
    expect((await tampered.json() as { code: string }).code).toBe('fingerprint-mismatch');
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]?.key).toBe('msg_interop_4');
  });
});
```

The tampered delivery is signed correctly over its own body, so it passes verification and is caught by the fingerprint, which is exactly the attack REQ-WH-5 is about: a sender that reuses an id for different content.

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `bun test packages/webhooks/test/interop.test.ts`
Expected: it fails first only if the implementation is wrong; the point of the task is that it passes with no production change. If it fails, the bug is in `standardWebhooksVerify` and that is fixed, not the test.

- [ ] **Step 4: Run the whole suite**

Run: `bun test packages/webhooks` then `bun run lint` then `bun run build` then `bun run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add packages/webhooks bun.lock
git commit -m "test(webhooks): REQ-WH-6 sign with anyhook, receive with anyonce"
```

**Branch and PR for Tasks 7 and 8:** branch `p4b-standard-webhooks-ts`, PR to `p4b-webhooks` titled `P4b: standardWebhooksVerify and the anyhook interop test`, body says `Part of #13`, lists REQ-WH-5 and REQ-WH-6, and pastes the gate output plus the vector table from `docs/reference/anyhook-signing.md`.

---

### Task 9: the conformance suite through the receiver, package hygiene, and the CI wiring (REQ-WH-1, REQ-CONF-5, Q28)

**Files:**
- Create: `packages/webhooks/test/conformance.test.ts`, `packages/webhooks/test/package.test.ts`
- Modify: `packages/webhooks/package.json` (devDependencies `@anyonce/conformance`, `@anyonce/fixture-hono`, `hono`), `.github/workflows/ci.yml`, `test/ci.test.ts`, `conformance/README.md`

**Interfaces:**
- Consumes: `runConformance` from `@anyonce/conformance`, `createFixtureApp` from `@anyonce/fixture-hono`, `CORE_IDS` and `PROFILE_IDS` from `conformance/test/catalog`.

- [ ] **Step 1: Add the dev dependencies**

Run: `bun add -d @anyonce/conformance@workspace:* @anyonce/fixture-hono@workspace:* hono --cwd packages/webhooks`

- [ ] **Step 2: Write the failing conformance test**

`packages/webhooks/test/conformance.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { runConformance } from '@anyonce/conformance';
import { MemoryStore } from '@anyonce/core';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { CORE_IDS, PROFILE_IDS } from '../../../conformance/test/catalog';
import { webhookReceiver } from '../src/index';

describe('webhook receiver conformance', () => {
  test('REQ-WH-1: every core and profile vector passes through the receiver with the memory store', async () => {
    const app = createFixtureApp();
    // Q28: the vectors carry the HTTP door's header and no signature, so the id header is pointed at the vector
    // header and verification is a constant true. The gate itself is proven by packages/webhooks/test/gate.test.ts.
    // POST /reset is the runner's control path and is skipped, exactly as the withIdempotency harness does.
    const handler = webhookReceiver({
      store: new MemoryStore(),
      idHeader: 'Idempotency-Key',
      verify: () => true,
      required: true,
      ttlMs: 2000,
      // The vectors assert the HTTP door's fingerprint, which includes the method and the path, so the harness
      // asks for it explicitly rather than the body only default (D9 gives the webhook door the body form).
      fingerprint: 'body',
      routePattern: (req) => `${req.method} ${new URL(req.url).pathname}`,
      skip: (req) => new URL(req.url).pathname === '/reset',
    })(app.fetch);

    const { summary, report } = await runConformance({
      target: handler,
      capabilities: ['short-ttl'],
      report: 'markdown',
    });
    const notPassing = summary.results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.id}: ${r.status}`);
    expect(notPassing, report).toEqual([]);
    expect(summary.results).toHaveLength(CORE_IDS.length + PROFILE_IDS.length);
  }, 60_000);
});
```

If a vector does not pass, it is not made to pass by weakening the receiver. Instead, add its id to an `INAPPLICABLE` array in this test with a one line reason, filter it out of the expectation, and add the same id and reason to the table in Step 5. That is the Q28 contract.

- [ ] **Step 3: Write the package hygiene test**

`packages/webhooks/test/package.test.ts`, mirroring `packages/hono/test/package.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = join(import.meta.dir, '..');

describe('package hygiene', () => {
  test('REQ-WH-1: @anyonce/core is a peer and there are no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ '@anyonce/core': 'workspace:*' });
    expect(pkg.sideEffects).toBe(false);
  });

  test('REQ-WH-1: the source imports only from @anyonce/core and @anyonce/core/http and never from node:', () => {
    for (const file of readdirSync(join(pkgDir, 'src'))) {
      const source = readFileSync(join(pkgDir, 'src', file), 'utf8');
      const specifiers = [...source.matchAll(/from\s*['"]([^'"]+)['"]/g)]
        .map((m) => m[1])
        .filter((specifier): specifier is string => specifier !== undefined);
      for (const specifier of specifiers) {
        if (specifier.startsWith('./')) continue;
        expect(['@anyonce/core', '@anyonce/core/http']).toContain(specifier);
      }
      expect(source).not.toMatch(/node:/);
    }
  });
});
```

- [ ] **Step 4: Wire the built package into the Node compatibility job**

In `.github/workflows/ci.yml`, the `node-compat` job's `require` step gains `require('@anyonce/webhooks');` at the end of its existing list. In `test/ci.test.ts`, the assertion that lists the five CJS entries gains `'@anyonce/webhooks'` as a sixth. Change nothing else in either file: the job name list in `test/ci.test.ts` is asserted exactly and must not grow in this task.

- [ ] **Step 5: Record the applicability table**

In `conformance/README.md`, add a section:

```markdown
## Running the suite through the webhook door

`@anyonce/webhooks` and `go/webhookmw` are HTTP doors, so the same vectors apply to them. The vectors were
written for the `Idempotency-Key` door and carry no webhook signatures, so the harness points `idHeader` at the
vector header, verifies with a constant true (the verification gate has its own tests), and skips the runner's
control path. See `packages/webhooks/test/conformance.test.ts` and `go/webhookmw/conformance_test.go`.

| Vector | Applies to the webhook door | Why |
|---|---|---|
| every `core` vector | yes | the receiver changes only where the key comes from, what the scope is and what runs before the store |
| every `profile` vector | yes | the same, and the profile behaviours are the bridge's, not the door's |

No vector is currently inapplicable. A vector that stops passing is listed here with its reason, never made to
pass by weakening the receiver.
```

If Step 2 found an inapplicable vector, replace the two summary rows with one row per vector.

- [ ] **Step 6: Run everything**

Run: `bun install` then `bun run build` then `bun test packages/webhooks test/ci.test.ts` then `bun run lint` then `bun run typecheck`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add packages/webhooks conformance/README.md .github/workflows/ci.yml test/ci.test.ts bun.lock
git commit -m "test(webhooks): REQ-WH-1 every conformance vector passes through the receiver"
```

**Branch and PR:** branch `p4b-webhooks-conformance`, PR to `p4b-webhooks` titled `P4b: the conformance suite through the webhook receiver`, body says `Part of #13`, lists REQ-WH-1 and REQ-CONF-5, and pastes the markdown report summary line plus the gate output.

---

### Task 10: Go `standardwebhooks` (REQ-WH-6, REQ-WH-7)

**Files:**
- Create: `go/standardwebhooks/standardwebhooks.go`, `go/standardwebhooks/standardwebhooks_test.go`

**Interfaces:**
- Produces:
```go
// Package standardwebhooks verifies Standard Webhooks signatures.
const SecretPrefix = "whsec_"
const DefaultTolerance = 300 * time.Second
var ErrVerification = errors.New("standardwebhooks: the signature did not verify")
func ParseSecret(secret string) ([]byte, error)
type Verifier struct { /* unexported */ }
func New(secrets ...string) (*Verifier, error)
func (v *Verifier) WithTolerance(d time.Duration) *Verifier
func (v *Verifier) WithClock(now func() time.Time) *Verifier
func (v *Verifier) Verify(h http.Header, body []byte) error
func (v *Verifier) VerifyFunc() func(*http.Request, []byte) (bool, error)
```
Consumed by Task 12 and by the P6 example.

- [ ] **Step 1: Write the failing tests**

`go/standardwebhooks/standardwebhooks_test.go` in package `standardwebhooks_test`, table driven over the same three golden rows from `docs/reference/anyhook-signing.md`, with subtests named:

- `REQ-WH-6: the single_secret anyhook golden vector verifies`
- `REQ-WH-6: the rotation_two_secrets anyhook golden vector verifies`
- `REQ-WH-6: the empty_object_payload anyhook golden vector verifies`
- `REQ-WH-6: a rotation signature verifies against either secret`
- `REQ-WH-6: a receiver holding two secrets verifies a payload signed with either`
- `REQ-WH-6: a secret without the whsec_ prefix is the same key`
- `REQ-WH-6: a changed body fails`
- `REQ-WH-6: a changed id fails`
- `REQ-WH-6: each of the three headers is required`
- `REQ-WH-6: the headers are matched case-insensitively`
- `REQ-WH-6: a timestamp that is not a finite number fails`
- `REQ-WH-6: a timestamp outside the 300 second tolerance fails on either side`
- `REQ-WH-6: a timestamp at the tolerance edge still verifies`
- `REQ-WH-6: a fractional timestamp is accepted and truncated, matching anyhook`
- `REQ-WH-6: an entry with an unknown version prefix is ignored and the rest still decide`
- `REQ-WH-6: a secret whose base64 does not decode is an error from New`

Each subtest builds an `http.Header` with `Set` (so the canonical casing is exercised) and a raw body `[]byte`, constructs the verifier with `New(secret).WithClock(func() time.Time { return time.Unix(row.Timestamp, 0) })`, and asserts `errors.Is(err, ErrVerification)` on the failure cases. The golden table is a package level `var vectors = []struct{ Name string; Secrets []string; ID, Payload string; Timestamp int64; Signature string }` with the three rows copied verbatim, including the `café` payload as a literal UTF-8 string.

The table and the first two subtests in full; the rest follow the same shape:

```go
package standardwebhooks_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/standardwebhooks"
)

type vector struct {
	Name      string
	Secrets   []string
	ID        string
	Payload   string
	Timestamp int64
	Signature string
}

const (
	secretA = "whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
	secretB = "whsec_AgIBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"
)

// Copied verbatim from docs/reference/anyhook-signing.md, which was read from the anyhook source at dfd5022.
var vectors = []vector{
	{
		Name:      "single_secret",
		Secrets:   []string{secretA},
		ID:        "msg_1",
		Payload:   `{"a":1}`,
		Timestamp: 1700000000,
		Signature: "v1,g9EIBBIwm31AQEkP7q60DV8jDWYbrjV7TTZJL+PIcMo=",
	},
	{
		Name:      "rotation_two_secrets",
		Secrets:   []string{secretA, secretB},
		ID:        "msg_2",
		Payload:   `{"nested":{"b":[1,2,3]},"unicode":"café"}`,
		Timestamp: 1700000001,
		Signature: "v1,Quo14+anAi2BEdvq/rAJ6acir9k1eo5oapk44aRYF6Y= v1,DA4ZWdZKEG9r6wHFCDZPQA+nmyvCvC6qn44us/GbmOw=",
	},
	{
		Name:      "empty_object_payload",
		Secrets:   []string{secretA},
		ID:        "msg_3",
		Payload:   `{}`,
		Timestamp: 0,
		Signature: "v1,rPUBbAcJfBgq5bbh2lc3N+SdRs/ySWgI2QxJlbKwSBU=",
	},
}

func headers(v vector, overrides map[string]string) http.Header {
	h := http.Header{}
	h.Set("webhook-id", v.ID)
	h.Set("webhook-timestamp", strconv.FormatInt(v.Timestamp, 10))
	h.Set("webhook-signature", v.Signature)
	for name, value := range overrides {
		h.Set(name, value)
	}
	return h
}

func verifierFor(t *testing.T, v vector, secret string) *standardwebhooks.Verifier {
	t.Helper()
	ver, err := standardwebhooks.New(secret)
	if err != nil {
		t.Fatal(err)
	}
	return ver.WithClock(func() time.Time { return time.Unix(v.Timestamp, 0) })
}

func TestVerify(t *testing.T) {
	for _, v := range vectors {
		t.Run("REQ-WH-6: the "+v.Name+" anyhook golden vector verifies", func(t *testing.T) {
			ver := verifierFor(t, v, v.Secrets[0])
			if err := ver.Verify(headers(v, nil), []byte(v.Payload)); err != nil {
				t.Fatalf("verify: %v", err)
			}
		})
	}

	t.Run("REQ-WH-6: a changed body fails", func(t *testing.T) {
		v := vectors[0]
		ver := verifierFor(t, v, v.Secrets[0])
		err := ver.Verify(headers(v, nil), []byte(`{"a":2}`))
		if !errors.Is(err, standardwebhooks.ErrVerification) {
			t.Fatalf("err = %v, want ErrVerification", err)
		}
	})
}
```

The `café` payload is a literal UTF-8 string in the file, which is what the anyhook golden row signed. `strconv` joins the import list.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./standardwebhooks/...`
Expected: FAIL, the package does not exist.

- [ ] **Step 3: Implement**

```go
// Package standardwebhooks implements the Standard Webhooks signature check (REQ-WH-6). The wire format is
// recorded in docs/reference/anyhook-signing.md: the signed content is "<id>.<timestamp>.<payload>", the MAC is
// HMAC-SHA256, each signature entry is "v1," plus standard base64 of the MAC, entries are space joined, and the
// timestamp must be within the tolerance. It depends only on the standard library.
package standardwebhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// SecretPrefix is the optional prefix on a Standard Webhooks secret.
const SecretPrefix = "whsec_"

// DefaultTolerance is the timestamp skew the specification allows.
const DefaultTolerance = 300 * time.Second

// ErrVerification is returned by Verify for every failure mode, so a caller cannot tell them apart from the error.
var ErrVerification = errors.New("standardwebhooks: the signature did not verify")

// ParseSecret strips the whsec_ prefix and decodes the standard base64 remainder.
func ParseSecret(secret string) ([]byte, error) {
	raw := strings.TrimPrefix(secret, SecretPrefix)
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("standardwebhooks: the secret is not valid base64: %w", err)
	}
	return key, nil
}

// Verifier holds one or more secrets, so a rotation is a matter of listing both.
type Verifier struct {
	keys      [][]byte
	tolerance time.Duration
	now       func() time.Time
}

// New builds a verifier over one or more secrets. It fails when a secret does not decode.
func New(secrets ...string) (*Verifier, error) {
	if len(secrets) == 0 {
		return nil, errors.New("standardwebhooks: at least one secret is required")
	}
	keys := make([][]byte, 0, len(secrets))
	for _, s := range secrets {
		key, err := ParseSecret(s)
		if err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return &Verifier{keys: keys, tolerance: DefaultTolerance, now: time.Now}, nil
}

// WithTolerance returns a copy that accepts a different timestamp skew.
func (v *Verifier) WithTolerance(d time.Duration) *Verifier {
	out := *v
	out.tolerance = d
	return &out
}

// WithClock returns a copy that reads the current time from now, for tests.
func (v *Verifier) WithClock(now func() time.Time) *Verifier {
	out := *v
	out.now = now
	return &out
}

// Verify checks the three headers against body. Every failure returns an error wrapping ErrVerification.
func (v *Verifier) Verify(h http.Header, body []byte) error {
	id := h.Get("webhook-id")
	ts := h.Get("webhook-timestamp")
	sig := h.Get("webhook-signature")
	if id == "" || ts == "" || sig == "" {
		return fmt.Errorf("%w: a required header is missing", ErrVerification)
	}
	seconds, err := strconv.ParseFloat(ts, 64)
	if err != nil || math.IsInf(seconds, 0) || math.IsNaN(seconds) {
		return fmt.Errorf("%w: the timestamp is not a number", ErrVerification)
	}
	stamp := time.Unix(int64(seconds), 0)
	if delta := v.now().Sub(stamp); delta > v.tolerance || delta < -v.tolerance {
		return fmt.Errorf("%w: the timestamp is outside the tolerance", ErrVerification)
	}

	content := make([]byte, 0, len(id)+len(ts)+len(body)+2)
	content = append(content, id...)
	content = append(content, '.')
	content = append(content, strconv.FormatInt(int64(seconds), 10)...)
	content = append(content, '.')
	content = append(content, body...)

	matched := false
	for _, key := range v.keys {
		mac := hmac.New(sha256.New, key)
		mac.Write(content)
		want := mac.Sum(nil)
		for _, entry := range strings.Split(sig, " ") {
			candidate, ok := strings.CutPrefix(entry, "v1,")
			if !ok {
				continue
			}
			got, err := base64.StdEncoding.DecodeString(candidate)
			if err != nil {
				continue
			}
			if hmac.Equal(want, got) {
				matched = true
			}
		}
	}
	if !matched {
		return fmt.Errorf("%w: no signature entry matched", ErrVerification)
	}
	return nil
}

// VerifyFunc adapts the verifier to webhookmw.Options.Verify.
func (v *Verifier) VerifyFunc() func(*http.Request, []byte) (bool, error) {
	return func(r *http.Request, body []byte) (bool, error) {
		if err := v.Verify(r.Header, body); err != nil {
			if errors.Is(err, ErrVerification) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}
}
```

The loops run to completion rather than breaking on the first match, which keeps the work independent of which entry matched, and `hmac.Equal` is the constant time comparison.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./standardwebhooks/...` then `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add go/standardwebhooks
git commit -m "feat(go): REQ-WH-6 standardwebhooks.Verify against the anyhook golden vectors"
```

---

### Task 11: Go `webhookmw` verification gate, with no happy path (REQ-WH-2, REQ-WH-7, D16, Q26)

Like Task 5, this task exists on its own so the gate test precedes the happy path in git history. It must be merged as its own squash commit before Task 12's.

**Files:**
- Create: `go/webhookmw/doc.go`, `go/webhookmw/options.go`, `go/webhookmw/middleware.go`, `go/webhookmw/gate_test.go`

**Interfaces:**
- Consumes: everything from `go/internal/httpx` listed in Task 3, plus `httpx.CodeConfigurationError` and `httpx.CodeSignatureInvalid` from Task 4.
- Produces:
```go
type Code = httpx.Code
type Problem = httpx.Problem
const DefaultIDHeader = "webhook-id"
type Options struct { /* see Step 2 */ }
type Middleware struct { /* unexported */ }
func New(store anyonce.Store, opts Options) *Middleware
func (m *Middleware) Handler(next http.Handler) http.Handler
func MarkVerified(ctx context.Context, marker string) context.Context
func IsVerified(ctx context.Context, marker string) bool
```
Consumed by Tasks 12 and 13.

- [ ] **Step 1: Write the failing gate tests**

`go/webhookmw/gate_test.go` in package `webhookmw_test`, with a `countingStore` wrapper around `memory.New()` that records every `Begin` call, and subtests named:

- `REQ-WH-2: a receiver with neither Verify nor VerifiedMarker answers 500 configuration-error and never calls Begin`
- `REQ-WH-2: the configuration error logs once however many requests arrive`
- `REQ-WH-2: a Verify that returns false answers 401 signature-invalid and never calls Begin`
- `REQ-WH-2: Verify sees the raw body bytes and the request`
- `REQ-WH-2: a Verify that returns an error is 500 configuration-error and never calls Begin`
- `REQ-WH-2: a VerifiedMarker that was never set answers 401 and never calls Begin`
- `REQ-WH-2: a marker set by an upstream verifier passes the gate`
- `REQ-WH-2: an oversized body is 413 before verification and never calls Begin`

The logging assertion injects `Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) }` so nothing reaches stderr, and asserts the message does not contain the id.

The counting store and the first two subtests in full; the rest follow the same shape:

```go
package webhookmw_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

type countingStore struct {
	anyonce.Store
	mu     sync.Mutex
	begins []anyonce.Operation
}

func newCountingStore() *countingStore { return &countingStore{Store: memory.New()} }

func (c *countingStore) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	c.mu.Lock()
	c.begins = append(c.begins, op)
	c.mu.Unlock()
	return c.Store.Begin(ctx, op, opts)
}

func (c *countingStore) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.begins)
}

func delivery(id, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/hooks/stripe", strings.NewReader(body))
	if id != "" {
		r.Header.Set("webhook-id", id)
	}
	r.Header.Set("Content-Type", "application/json")
	return r
}

func handled() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("handled"))
	})
}

func TestGate(t *testing.T) {
	t.Run("REQ-WH-2: a receiver with neither Verify nor VerifiedMarker answers 500 configuration-error and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		var messages []string
		mw := webhookmw.New(store, webhookmw.Options{
			Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) },
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/problem+json" {
			t.Fatalf("content type = %q", got)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeConfigurationError || p.Status != 500 {
			t.Fatalf("problem = %+v", p)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
		if len(messages) != 1 {
			t.Fatalf("logged %d times, want 1", len(messages))
		}
		if strings.Contains(messages[0], "msg_1") {
			t.Fatalf("the log line carries request data: %q", messages[0])
		}
	})

	t.Run("REQ-WH-2: a Verify that returns false answers 401 signature-invalid and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return false, nil },
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeSignatureInvalid {
			t.Fatalf("code = %q", p.Code)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})
}
```

`webhookmw.CodeConfigurationError` and `webhookmw.CodeSignatureInvalid` are alias consts over `httpx`, added alongside the seven `httpmw` ones in Step 2.

- [ ] **Step 2: Write the options and the gate**

`go/webhookmw/options.go`:

```go
// DefaultIDHeader is the Standard Webhooks delivery id header (REQ-WH-1).
const DefaultIDHeader = "webhook-id"

// Options configures the webhook receiver. Store aside, every field has a working default.
type Options struct {
	// IDHeader is the header the delivery id arrives in. Default webhook-id.
	IDHeader string
	// Key derives the id from the body (a Stripe event.id, a GitHub delivery header). It wins over IDHeader.
	// The second result reports whether an id was found at all.
	Key func(r *http.Request, body []byte) (string, bool)
	// Verify runs before the store (D16). A false first result is 401 signature-invalid; a non nil error is a
	// 500 configuration-error, because a verifier that cannot decide must not be treated as a rejection.
	Verify func(r *http.Request, body []byte) (bool, error)
	// VerifiedMarker names a marker an upstream verifier put in the request context with MarkVerified.
	VerifiedMarker string
	// OnSuspicious fires when the same id arrives with a different body (REQ-WH-5).
	OnSuspicious func(r *http.Request, rec *anyonce.Record)
	// RoutePattern is the route half of the scope (D8). Default r.URL.EscapedPath().
	RoutePattern string
	// SourceID is the verified sender identity (Q24). An empty result leaves the scope as the route alone.
	SourceID func(r *http.Request, body []byte) string
	// Fingerprint overrides the D9 default of SHA-256 over the body bytes alone.
	Fingerprint func(r *http.Request, body []byte) (string, error)
	// Methods the receiver applies to. Default POST.
	Methods []string
	// Required makes a delivery with no id a 400 missing-key. Default true (Q25).
	Required *bool
	MaxRequestBytes int64
	StoreHeaders    []string
	Policy          anyonce.Policy
	ProblemBaseURI  string
	DocsURL         string
	ProblemTitles   map[Code]string
	// OnError renders a problem differently. The status and the code must not change.
	OnError func(w http.ResponseWriter, r *http.Request, p Problem)
	// Logf receives the one configuration-error message (Q26). Default log.Printf.
	Logf func(format string, args ...any)
}
```

`go/webhookmw/middleware.go` holds `MarkVerified`, `IsVerified` (a `ctxKey` struct keyed map of markers), `New` (which resolves the defaults, builds the `httpx.ProblemWriter` with the webhook titles built from `IDHeader`, and clamps `MaxResultBytes` against `anyonce.ResultCapper` the way `httpmw.New` does), and `Handler`, which in this task stops after verification and calls `next.ServeHTTP(w, r)` directly. The configuration check uses `sync.Once` for the log and an `atomic.Bool` is not needed because the check is pure.

- [ ] **Step 3: Run the tests**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./webhookmw/...` then `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS and clean.

- [ ] **Step 4: Commit**

```bash
git add go/webhookmw
git commit -m "feat(go): REQ-WH-2 the webhookmw verification gate, before the key and before the store"
```

**Branch and PR for Tasks 10 and 11:** branch `p4b-webhookmw-gate`, PR to `p4b-webhooks` titled `P4b: Go standardwebhooks and the webhookmw verification gate`, body says `Part of #13` and `The gate lands before the happy path, per the first CHECKLIST P4b item`, lists REQ-WH-2, REQ-WH-6, REQ-WH-7, and pastes the Go gate output.

---

### Task 12: Go `webhookmw` key, scope, fingerprint, replay, conflict and mismatch, plus conformance (REQ-WH-1, REQ-WH-3, REQ-WH-4, REQ-WH-5, REQ-WH-7, Q24, Q25, Q28)

**Files:**
- Modify: `go/webhookmw/middleware.go`
- Create: `go/webhookmw/middleware_test.go`, `go/webhookmw/conformance_test.go`

**Interfaces:**
- Consumes: `httpx.LookupKey`, `httpx.NewCaptureWriter`, `httpx.WriteReplay`, `httpx.RetryAfter`, `httpx.WithInfo`, `anyonce.Execute`, `anyonce.SHA256Hex`.

- [ ] **Step 1: Write the failing tests**

`go/webhookmw/middleware_test.go` in package `webhookmw_test`, subtests named:

- `REQ-WH-1: the delivery id comes from the webhook-id header and becomes the store key`
- `REQ-WH-1: a Key function reads the id out of the body and wins over the header`
- `REQ-WH-1: a verified delivery with no id is 400 missing-key`
- `REQ-WH-1: an id longer than 255 bytes is 400 invalid-key`
- `REQ-WH-1: the scope is the route pattern alone when no SourceID is configured`
- `REQ-WH-1: a SourceID is appended to the route pattern after a slash`
- `REQ-WH-1: the same id in two source scopes runs the handler twice`
- `REQ-WH-1: the fingerprint is SHA-256 over the body bytes alone, so the same body on two paths matches`
- `REQ-WH-1: a GET passes through untouched because the receiver applies to POST only`
- `REQ-WH-1: the handler receives the body unread`
- `REQ-WH-3: a redelivery replays the stored response with Idempotency-Replayed true and runs the handler once`
- `REQ-WH-3: a stored 4xx replays as the stored 4xx, because D6 stores every status below 500`
- `REQ-WH-4: a redelivery while the first is in flight is 409 with Retry-After at least 1`
- `REQ-WH-5: the same id with a different body is 422 and fires OnSuspicious with the stored record`
- `REQ-WH-5: an OnSuspicious hook that panics does not change the 422`
- `REQ-WH-7: the handler reads the key and the fence from the request context`

The in-flight test uses a `sync.WaitGroup` plus a channel gate, never a sleep: the handler signals it has started, the test sends the duplicate, asserts 409, then closes the release channel. `REQ-WH-5`'s panic case is guarded inside the hook invocation with `defer func() { _ = recover() }()`, mirroring the engine's rule that hooks never throw into the caller.

The in-flight test in full, because it is the one that must not be written with a sleep:

```go
	t.Run("REQ-WH-4: a redelivery while the first is in flight is 409 with Retry-After at least 1", func(t *testing.T) {
		started := make(chan struct{})
		release := make(chan struct{})
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return true, nil },
			Policy: anyonce.Policy{Lease: 30 * time.Second},
		})
		handler := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			close(started)
			<-release
			w.WriteHeader(http.StatusOK)
		}))

		var wg sync.WaitGroup
		wg.Add(1)
		firstRec := httptest.NewRecorder()
		go func() {
			defer wg.Done()
			handler.ServeHTTP(firstRec, delivery("msg_inflight", `{"a":1}`))
		}()

		<-started
		secondRec := httptest.NewRecorder()
		handler.ServeHTTP(secondRec, delivery("msg_inflight", `{"a":1}`))
		if secondRec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409", secondRec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(secondRec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeConflict {
			t.Fatalf("code = %q", p.Code)
		}
		if p.Title != "A delivery with this webhook-id is still in progress" {
			t.Fatalf("title = %q", p.Title)
		}
		seconds, err := strconv.Atoi(secondRec.Header().Get("Retry-After"))
		if err != nil || seconds < 1 {
			t.Fatalf("Retry-After = %q (%v)", secondRec.Header().Get("Retry-After"), err)
		}

		close(release)
		wg.Wait()
		if firstRec.Code != http.StatusOK {
			t.Fatalf("first status = %d, want 200", firstRec.Code)
		}
	})
```

`go/webhookmw/conformance_test.go`:

```go
func TestConformance(t *testing.T) {
	t.Run("REQ-WH-7: every core and profile vector passes through webhookmw with the memory store", func(t *testing.T) {
		f := fixture.New()
		required := true
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			// Q28: the vectors carry the HTTP door's header and no signature, and the gate has its own tests.
			IDHeader: "Idempotency-Key",
			Verify:   func(*http.Request, []byte) (bool, error) { return true, nil },
			Required: &required,
			// The vectors assert the HTTP door's fingerprint, so the harness asks for it explicitly.
			Fingerprint: func(r *http.Request, body []byte) (string, error) {
				return anyonce.HTTPFingerprint(r.Method, r.URL.RequestURI(), body), nil
			},
			RoutePattern: "",
			Policy:       anyonce.Policy{TTL: 2 * time.Second},
		})
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

`RoutePattern: ""` means the default, the escaped path. Go's `RoutePattern` is a fixed string, not a function, because a receiver is normally mounted on one route; the path only scope is enough for the vectors because every vector that dedupes uses POST, so no two vectors share a path with different methods. If a vector fails, record it in the `conformance/README.md` table from Task 9 Step 5 rather than weakening the receiver.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./webhookmw/...`
Expected: FAIL, `Handler` still calls `next` directly.

- [ ] **Step 3: Implement the rest of `Handler`**

After the verification gate, the handler:

```go
		key, status, reason := lookupID(r, body, m.opts)
		switch status {
		case httpx.KeyMissing:
			if !m.opts.required {
				next.ServeHTTP(w, r)
				return
			}
			m.problems.Fail(w, r, httpx.CodeMissingKey, "", http.Header{
				"Link": {"<" + m.opts.DocsURL + ">; rel=\"describedby\""},
			})
			return
		case httpx.KeyInvalid:
			m.problems.Fail(w, r, httpx.CodeInvalidKey, reason, nil)
			return
		case httpx.KeyOK:
		}

		fp, err := m.fingerprint(r, body)
		if err != nil {
			http.Error(w, "webhookmw: fingerprint failed", http.StatusInternalServerError)
			return
		}
		op := anyonce.Operation{Scope: m.scope(r, body), Key: key, Fingerprint: fp}
```

then the same `anyonce.Execute` block `httpmw` runs, with `httpx.NewCaptureWriter`, the `panicValue` recovery, `httpx.WithInfo(ctx, key, fence)` on the downstream request, and the result switch:

```go
		switch res.Kind {
		case anyonce.ResultExecuted:
		case anyonce.ResultReplayed:
			httpx.WriteReplay(w, res.Record)
		case anyonce.ResultConflict:
			m.problems.Fail(w, r, httpx.CodeConflict, "", http.Header{
				"Retry-After": {httpx.RetryAfter(res.LeaseUntil, policy)},
			})
		case anyonce.ResultMismatch:
			m.onSuspicious(r, res.Record)
			m.problems.Fail(w, r, httpx.CodeFingerprintMismatch, "", nil)
		case anyonce.ResultStoreError:
			m.problems.Fail(w, r, httpx.CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		}
```

with the helpers:

```go
// lookupID resolves the delivery id: the Key function when given, otherwise the IDHeader. Q25: the id becomes the
// store key, so it is length and charset checked with the lenient parser and never sf-string parsed.
func lookupID(r *http.Request, body []byte, o resolved) (string, httpx.KeyStatus, string) {
	if o.Key != nil {
		raw, ok := o.Key(r, body)
		if !ok || raw == "" {
			return "", httpx.KeyMissing, ""
		}
		parsed, err := anyonce.ParseKey(raw, anyonce.SyntaxLenient)
		if err != nil {
			return "", httpx.KeyInvalid, err.Error()
		}
		return parsed, httpx.KeyOK, ""
	}
	return httpx.LookupKey(r.Header, o.IDHeader, anyonce.SyntaxLenient)
}

// scope is D8 and Q24: the route pattern, plus a slash and the sender identity when SourceID yields one.
func (m *Middleware) scope(r *http.Request, body []byte) string {
	route := m.opts.RoutePattern
	if route == "" {
		route = r.URL.EscapedPath()
	}
	if m.opts.SourceID == nil {
		return route
	}
	source := m.opts.SourceID(r, body)
	if source == "" {
		return route
	}
	return route + "/" + source
}

// fingerprint is D9: SHA-256 over the body bytes alone for this door.
func (m *Middleware) fingerprint(r *http.Request, body []byte) (string, error) {
	if m.opts.Fingerprint != nil {
		return m.opts.Fingerprint(r, body)
	}
	return anyonce.SHA256Hex(body), nil
}

// onSuspicious fires REQ-WH-5's hook. A hook never reaches the caller, matching the engine's rule for its own hooks.
func (m *Middleware) onSuspicious(r *http.Request, rec *anyonce.Record) {
	if m.opts.OnSuspicious == nil {
		return
	}
	defer func() { _ = recover() }()
	m.opts.OnSuspicious(r, rec)
}
```

`readBody` is already called by the gate, so the body bytes are in hand and `r.Body` was reset by `httpx.ReadBody`; nothing reads it twice.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `GOROOT= /opt/homebrew/bin/go test -C go -race ./...` then `GOROOT= sh -c 'cd go && golangci-lint run'` then `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`
Expected: PASS, clean, engine coverage still 100 percent.

- [ ] **Step 5: Commit**

```bash
git add go/webhookmw
git commit -m "feat(go): REQ-WH-1 REQ-WH-3 REQ-WH-4 REQ-WH-5 REQ-WH-7 the webhookmw receiver and its conformance run"
```

**Branch and PR:** branch `p4b-webhookmw`, PR to `p4b-webhooks` titled `P4b: the Go webhook receiver`, body says `Part of #13`, lists REQ-WH-1, REQ-WH-3, REQ-WH-4, REQ-WH-5, REQ-WH-7, and pastes the Go gate output.

---

### Task 13: the anyhook interop round trip in Go (REQ-WH-6, REQ-WH-7, Q27)

**Files:**
- Create: `go/webhookmw/interop/go.mod`, `go/webhookmw/interop/go.sum`, `go/webhookmw/interop/interop_test.go`
- Modify: `.github/workflows/ci.yml`, `test/ci.test.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `github.com/sns45/anyhook/go/signing` (`NewSigner`, `Headers`, `GenerateSecret`), `github.com/sns45/anyonce/go/webhookmw`, `github.com/sns45/anyonce/go/standardwebhooks`, `github.com/sns45/anyonce/go/store/memory`.

- [ ] **Step 1: Create the nested module**

```bash
GOROOT= /opt/homebrew/bin/go mod init -C go/webhookmw/interop github.com/sns45/anyonce/go/webhookmw/interop
GOROOT= /opt/homebrew/bin/go mod edit -C go/webhookmw/interop -require=github.com/sns45/anyhook/go@v0.2.1
GOROOT= /opt/homebrew/bin/go mod edit -C go/webhookmw/interop -require=github.com/sns45/anyonce/go@v0.0.0
GOROOT= /opt/homebrew/bin/go mod edit -C go/webhookmw/interop -replace=github.com/sns45/anyonce/go=../..
GOROOT= /opt/homebrew/bin/go mod tidy -C go/webhookmw/interop
```

The `replace` points at the working tree, so the interop test always runs against the code in this branch and never against a published tag. `go/webhookmw/interop/README.md` is not created; the reason for the nested module is a comment at the top of `interop_test.go`:

```go
// Package interop_test signs with anyhook and receives with anyonce (REQ-WH-6). It is a nested module with its own
// go.mod so that github.com/sns45/anyonce/go keeps the dependency set CLAUDE.md names: the standard library, the
// store clients and modernc.org/sqlite. anyonce imports nothing from anyhook at runtime; this is a test only edge.
package interop_test
```

- [ ] **Step 2: Write the test**

`go/webhookmw/interop/interop_test.go`, subtests named:

- `REQ-WH-6: a delivery signed by anyhook is accepted, and the redelivery replays`
- `REQ-WH-6: a delivery signed with a different secret is 401 and never runs the handler`
- `REQ-WH-6: a rotation signature from anyhook verifies against either secret the receiver holds`
- `REQ-WH-5: a tampered body under a signed id that already landed is 422 and fires OnSuspicious`

Each builds the headers with `signing.NewSigner(secret).Headers(id, payload, time.Now())`, copies them into an `httptest.NewRequest` body request, and drives `webhookmw.New(memory.New(), webhookmw.Options{Verify: verifier.VerifyFunc()}).Handler(handler)` through `httptest.NewRecorder`.

- [ ] **Step 3: Run the test**

Run: `GOROOT= /opt/homebrew/bin/go test -C go/webhookmw/interop -race ./...`
Expected: PASS.

Also confirm the nested module is invisible to the parent: `GOROOT= /opt/homebrew/bin/go list -C go -m all` must not list `github.com/sns45/anyhook/go`, and `go/go.mod` must be unchanged by this task.

- [ ] **Step 4: Wire it into CI**

In `.github/workflows/ci.yml`, the `go` job gains one step after the existing `go test -race ./...` step:

```yaml
      - name: anyhook interop (nested test only module)
        working-directory: go/webhookmw/interop
        run: go test -race ./...
```

In `test/ci.test.ts`, add one assertion to the existing go-job describe block:

```ts
  test('REQ-REL-4: the go job runs the nested anyhook interop module', () => {
    const steps = (ci.jobs.go.steps as Array<{ run?: string; 'working-directory'?: string }>);
    const step = steps.find((s) => s['working-directory'] === 'go/webhookmw/interop');
    expect(step?.run).toBe('go test -race ./...');
  });
```

In `CLAUDE.md`, the layout block's `go/` section gains two lines and the Go code rule gains a sentence:

```
  internal/httpx/         shared HTTP door helpers (problems, key lookup, capture, replay), internal to the module
  standardwebhooks/       Standard Webhooks signature verification
  webhookmw/interop/      nested test only module, signs with anyhook (not part of the published module)
```

and, in "Code rules", after the Go line: "The one exception to the dependency rule is `go/webhookmw/interop`, a nested test only module that requires `github.com/sns45/anyhook/go` for the REQ-WH-6 round trip; it is not part of `github.com/sns45/anyonce/go`."

- [ ] **Step 5: Run the gates**

Run: `bun test test/ci.test.ts` then `GOROOT= /opt/homebrew/bin/go build -C go ./...` then `GOROOT= /opt/homebrew/bin/go test -C go -race ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go/webhookmw/interop .github/workflows/ci.yml test/ci.test.ts CLAUDE.md
git commit -m "test(go): REQ-WH-6 sign with anyhook, receive with anyonce, in a nested test only module"
```

**Branch and PR:** branch `p4b-interop-go`, PR to `p4b-webhooks` titled `P4b: the Go anyhook interop test`, body says `Part of #13`, lists REQ-WH-6, and pastes the nested module test output plus `go list -m all` proving the parent module is unchanged.

---

### Task 14: docs, changeset, REQ coverage and the phase gate (REQ-DOC-4, REQ-REL-1, acceptance item 1)

**Files:**
- Create: `.changeset/p4b-webhooks.md`
- Modify: `package.json` (`test:reqs` phase), `CHECKLIST.md` (tick the P4b boxes), `docs/problems.md` (final read through), `conformance/README.md` (final read through)

- [ ] **Step 1: Write the changeset**

`.changeset/p4b-webhooks.md`:

```markdown
---
'@anyonce/core': minor
'@anyonce/webhooks': minor
---

Add the webhook door. `@anyonce/webhooks` ships `webhookReceiver`, which runs strictly after signature
verification, keys on the Standard Webhooks `webhook-id` header or a body derived id, replays a stored response
with `Idempotency-Replayed: true`, answers 409 with `Retry-After` while a delivery is in flight and 422 with an
`onSuspicious` hook when the same id arrives with a different body, plus `standardWebhooksVerify(secret)`.
`@anyonce/core/http` gains two problem codes, `configuration-error` and `signature-invalid`, per code title
overrides, and two optional `RunContext` fields so a door can supply the key and the body it already read.
```

- [ ] **Step 2: Move the REQ coverage check to this phase**

In the root `package.json`, change `"test:reqs": "bun run scripts/reqs.ts --phase p3"` to `--phase p4b`.

Run: `bun run test:reqs`
Expected: every id in the P4b scope (REQ-WH-1 to REQ-WH-7 plus the P0, P1 and P2 closure) is covered. If P4a has already moved the flag to `p4a`, leave whichever value is in the file and add a line to the integration PR body saying which phase the flag is set to and that the other phase's value is the one to keep on the second merge.

- [ ] **Step 3: Run the whole phase gate**

Run each and keep the raw output for the PR body:

```bash
scripts/doctor.sh
bun install
bun run lint
bun run build
bun run typecheck
bun run size
bun run test
bun run test:coverage
bun run test:reqs
bun run test:node
rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .
rg -n "console\.(log|info|warn|error)\(.*key" packages go
GOROOT= /opt/homebrew/bin/go build -C go ./...
GOROOT= /opt/homebrew/bin/go vet -C go ./...
GOROOT= /opt/homebrew/bin/go test -C go -race ./...
GOROOT= /opt/homebrew/bin/go test -C go/webhookmw/interop -race ./...
GOROOT= sh -c 'cd go && golangci-lint run'
GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh
```

The two `rg` commands must print nothing. `bun run test:workers` is run too, because `@anyonce/core/http` changed.

- [ ] **Step 4: Tick the CHECKLIST**

In `CHECKLIST.md`, tick the three P4b boxes. Do not tick any other phase's boxes.

- [ ] **Step 5: Commit**

```bash
git add .changeset package.json CHECKLIST.md docs conformance/README.md
git commit -m "docs: REQ-DOC-4 changeset, REQ coverage and the P4b phase gate"
```

**Branch and PR:** branch `p4b-docs`, PR to `p4b-webhooks` titled `P4b: changeset, REQ coverage and the phase gate`, body says `Part of #13` and pastes the whole gate output.

---

## Phase gate (CHECKLIST.md, "Every phase" and "P4b webhook door")

Every line below needs pasted raw output in the integration PR body. An item without output is not done.

**Every phase**

- [ ] `scripts/doctor.sh` passes
- [ ] `bun run lint` clean, `bun run build` clean, `bun run test` green, `bun run test:reqs` reports no uncovered REQ ids in the P4b scope
- [ ] `GOROOT= /opt/homebrew/bin/go vet -C go ./...`, `GOROOT= /opt/homebrew/bin/go test -C go -race ./...` and `GOROOT= sh -c 'cd go && golangci-lint run'` clean, plus `GOROOT= /opt/homebrew/bin/go test -C go/webhookmw/interop -race ./...`
- [ ] No em or en dashes: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing
- [ ] No full keys logged: `rg -n "console\.(log|info|warn|error)\(.*key" packages go` returns nothing
- [ ] Changeset present (`.changeset/p4b-webhooks.md`, `@anyonce/core` minor and `@anyonce/webhooks` minor)
- [ ] `docs/superpowers/questions.md` reviewed; Q23 to Q28 each carry a recommended resolution

**P4b webhook door**

- [ ] Webhook verification gate test precedes happy path in git history (REQ-WH-2): `git log --oneline p4b-webhooks` shows the gate commit before the receiver commit in both languages
- [ ] anyhook sign to anyonce receive interop test green in both languages; the three Standard Webhooks golden vectors green in both languages
- [ ] Mismatch fires `onSuspicious` (REQ-WH-5) in both languages
- [ ] The full conformance suite runs through both receivers with every vector accounted for, and `conformance/README.md` records the applicability table (Q28)

**Additional gates this phase carries**

- [ ] `bun run size`: the `@anyonce/core` root entry under 8192 bytes and the `http` subpath under 16384 bytes
- [ ] `bun run test:coverage`: the engine, the key validator and the sf-string parser still at 100 percent branch coverage
- [ ] `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`: still 100 percent
- [ ] `bun run test:workers` and `bun run test:node` green, because `@anyonce/core/http` changed
- [ ] `go list -C go -m all` does not list `github.com/sns45/anyhook/go`
