# P4a Queue Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the queue door in both languages: `@anyonce/anyq` (the `idempotent(handler, options)` wrapper plus the companion `idempotencyStrategy(inner?)`), Go `anyqmw` (`Wrap` plus `Strategy`), and `docs/queue-ids.md`, with the outcomes of D15 proven against three real anyq adapters per language.

**Architecture:** The engine from P1 stays the only state machine. The queue door is a thin bridge: it derives an `Operation` from an anyq message (scope from provider metadata, key from the message id, a header or the body hash, fingerprint from the body per D9 and Q3), calls `execute`, and turns the outcome into the one thing an anyq handler can express, namely returning or throwing. anyq's dead-letter and delay primitives are not reachable from a handler (Q2), so the wrapper throws typed errors and the companion strategy, configured on the consumer, translates them into `park` and `deadLetter` decisions. Nothing in the queue door talks to a store directly and nothing in it touches HTTP code.

**Tech Stack:** Bun 1.2.21 local (CI Bun latest 1.4.x), TypeScript 5 strict, tsup (ESM + CJS + d.ts), Biome 2, `@anyq/core` 0.5.0 and the `@anyq/memory`, `@anyq/redis-streams`, `@anyq/sqs`, `@anyq/kafka` adapters 0.5.0, Go 1.26 minimum with `github.com/sns45/anyq/go v0.5.0`, golangci-lint 2.13.2, Docker services from `test/compose.yml` (Redis 6379, ElasticMQ 9324, Redpanda 9092).

**Spec:** `requirements.md` sections 2 (D6, D8, D9, D13, D14, D15, D21), 3 (the engine contract), 4.5 (REQ-Q-1..8), 4.8 (REQ-DOC-9), 4.9 (REQ-REL-4), 5 (NFR-2); `docs/reference/anyq-interfaces.md`; `docs/superpowers/questions.md` Q2, Q3, Q4, Q12 and the new Q40 to Q43 (Task 1); `docs/superpowers/specs/2026-09-anyonce-design.md` item B9; `CHECKLIST.md` sections "Every phase" and "P4a queue door".

## Global Constraints

- Prose in docs, comments, commit messages, changeset text, YAML and shell: no em or en dashes (U+2013, U+2014). Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing.
- Test names start with the REQ id they prove: `REQ-Q-2: a completed duplicate returns without running the handler`. Go subtests use `t.Run("REQ-Q-2: ...", ...)`.
- `@anyonce/anyq` has zero `dependencies`. `@anyonce/core` and `@anyq/core` are peer dependencies (D21); the adapter packages (`@anyq/memory`, `@anyq/redis-streams`, `@anyq/sqs`, `@anyq/kafka`) and `@aws-sdk/client-sqs` are dev dependencies only, used by tests.
- TypeScript: `strict`, `exactOptionalPropertyTypes` (build objects conditionally, never assign `undefined` to an optional property), `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, no `any` outside test fakes. `@anyonce/anyq` may import what `@anyq/core` needs; it must not import from `@anyonce/core/http`.
- The engine's `run` callback receives the fence: `execute(store, op, run, policy)` where `run: (fence: number) => Promise<StoredResult>`; Go `anyonce.Execute(ctx, store, op, func(ctx context.Context, fence int64) (anyonce.StoredResult, error), policy)`.
- Stored result for a queue operation is exactly `{ kind: 'message', outcome: 'ok' }`: no `body`, no `status`, no `headers` (D15, REQ-Q-5). A handler error abandons the claim and rethrows (REQ-Q-3), so nothing is stored for a failure.
- Never log a full key. `redactKey` from `@anyonce/core` is the only form a key may take in any message (NFR-2). No warning text in this package contains a key value or the word key inside a `console.*` call, so the key-log gate `rg -n 'console\.(log|info|warn|error)\(.*key' packages go` stays empty.
- Go: standard library plus `github.com/sns45/anyq/go` only in `go/anyqmw`; no cgo; errors wrapped with `%w`; sentinels compared with `errors.Is`; doc comments on every exported identifier; `go vet`, `go test -race`, `golangci-lint run` clean. Run Go as `GOROOT= /opt/homebrew/bin/go <verb> -C go ./...`; golangci-lint as `GOROOT= sh -c 'cd go && golangci-lint run'`; the engine coverage gate as `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh` (still 100 percent; this phase does not touch `engine.go`).
- Service-backed suites skip with a clear message when the service is down and fail under `ANYONCE_REQUIRE_SERVICES=1`: TypeScript uses the existing pattern in `packages/stores/services`, Go uses `go/internal/servicetest.Require`. They live outside the root `bun run test` filter and run only under `bun run test:services`.
- No test sleeps to make an assertion pass. Where a lease must expire, the lease is short and the assertion is an ordering assertion on recorded timestamps, never a duration. Concurrency uses a start gate and `Promise.all` (TypeScript) or `sync.WaitGroup` plus a channel gate (Go).
- Conventional commits: `feat(anyq): ...`, `feat(go): ...`, `test(anyq): ...`, `docs(...)`. Commit after every task. Git only as plain single commands from the worktree root (no `cd`, no `&&` between git commands, no `-C`).
- Never write a `\uXXXX` escape inside a tool parameter; the editing tools decode it into the raw character. Use `\x` escapes or named escapes.
- Shared files are touched additively so the parallel P4b branch rebases cleanly: root `package.json` (three script lines), `.github/workflows/ci.yml` (one step argument), `test/ci.test.ts` (one array literal), `CLAUDE.md` (two lines), `go/go.mod`, `bun.lock`.
- Changeset `.changeset/p4a-queue.md` (Task 9): `@anyonce/anyq: minor`.

## Decisions taken in this plan (not spec changes)

- **Strategies are imported from the `@anyq/core` root.** `docs/reference/anyq-interfaces.md` cites `@anyq/core/strategies`; the published 0.5.0 `exports` map has no such subpath and re-exports every strategy factory from `.`. Import `retryThenDeadLetter` and the strategy types from `@anyq/core`.
- **`@anyq/core` is ESM only, and a static import is fine.** Verified locally on Node 22.17: `require()` of the built `@anyq/core` ESM entry resolves (Node's require(esm) is unflagged from 22.12). `@anyonce/anyq` therefore ships ESM and CJS like every other package and the node-compat CI job requires its CJS entry.
- **Key source is an explicit option with three named modes.** `key?: 'id' | 'header' | 'body' | ((message) => string | Promise<string>)`, default `'id'` (REQ-Q-1: anyq always populates `message.id`). `'header'` reads `keyHeader` (default `idempotency-key`) case-insensitively and decodes byte values with `TextDecoder`. `'body'` is the D9 fingerprint of the body, which is the only key source that survives an anyq park (Q40).
- **Scope is derived from provider metadata, and a provider that cannot supply one is a configuration error.** `memory` uses `metadata.memory.queueName`, `redis-streams` uses `stream` and `consumerGroup`, `sqs` uses `queueUrl`, `kafka` uses `topic`, `pgmq` uses `queueName`, `nats` uses `stream`, `google-pubsub` uses `subscription`, `cloudflare-queues` uses `queueName`. `rabbitmq` and `azure-servicebus` carry no queue name on the message, so the default throws `QueueConfigurationError` and the caller passes `scope`. An explicit `consumerGroup` option is appended as `${queue}/${group}` when the metadata has no group of its own (D8).
- **D15's `{ outcome: 'error' }` arm is not produced.** REQ-Q-3 abandons the claim and rethrows on a handler error, so the engine never reaches `complete` for a failure. Storing failures would replay a permanent error for the whole TTL and take the message out of anyq's retry and dead-letter policy, which REQ-Q-3 exists to preserve. The arm stays in `StoredResult` from P1. Recorded as Q43.
- **Untranslated in-flight detection is one delivery late.** The wrapper cannot see the consumer's config, so it marks each `InFlightError` it throws and checks that mark at the start of the next delivery: if the previous in-flight error was never translated by a strategy, it warns once (Q2's "if it can detect"). The README states the requirement in its first paragraph either way.
- **The typed errors expose both `instanceof` and a structural `code`.** `isInFlightError` and `isFingerprintMismatchError` check `instanceof` first and fall back to `code`, so two copies of the package in one dependency tree still translate. `retryable` is a plain property so anyq's `isRetryableError` predicate reads it without `@anyonce/anyq` extending `AnyQError`.
- **Go's park policy default is fail loud.** `core.BaseQueueConfig.AllowParkDowngrade` defaults to false in Go and to true in TypeScript. The companion strategy's name is not in anyq's `neverParkStrategies` list, so a Go consumer on Kafka or Redis must set `AllowParkDowngrade: true`. The tests set it and `docs/queue-ids.md` says so.
- **Go's warning uses the standard library.** `Options.Warn func(string)` defaults to a `log.Printf` call in `anyqmw` only. Nothing else in the module logs.
- **REQ-Q-6's three adapters per language.** TypeScript: `@anyq/memory` (no container), `@anyq/redis-streams` (Redis 6379), `@anyq/sqs` (ElasticMQ 9324), `@anyq/kafka` (Redpanda 9092), so four, one more than the requirement asks. Go: `memory`, `sqs`, `kafka`, and `redis` where the Go adapter's consumer group semantics allow it.

## File Structure

```
packages/anyq/package.json                 @anyonce/anyq, peers @anyonce/core and @anyq/core, adapter dev deps
packages/anyq/tsconfig.json                extends tsconfig.base.json, same shape as packages/hono/tsconfig.json
packages/anyq/src/errors.ts                AnyonceQueueError, InFlightError, FingerprintMismatchError, FingerprintError, QueueConfigurationError, isInFlightError, isFingerprintMismatchError
packages/anyq/src/fingerprint.ts           messageFingerprint (D9 and Q3, total over string, bytes, JSON)
packages/anyq/src/options.ts               IdempotentOptions, ResolvedOptions, resolveOptions, headerValue, resolveKey, defaultScope, resolveScope
packages/anyq/src/idempotent.ts            idempotent(handler, options)
packages/anyq/src/strategy.ts              IDEMPOTENCY_STRATEGY_NAME, idempotencyStrategy(inner?)
packages/anyq/src/index.ts                 public surface
packages/anyq/test/fake.ts                 fakeMessage() builder over the real IMessage shape (test helper, not shipped)
packages/anyq/test/errors.test.ts          typed errors and predicates
packages/anyq/test/fingerprint.test.ts     REQ-Q-1 fingerprint totality
packages/anyq/test/options.test.ts         REQ-Q-1 key and scope resolution
packages/anyq/test/idempotent.test.ts      REQ-Q-2, REQ-Q-3, REQ-Q-4, REQ-Q-5
packages/anyq/test/strategy.test.ts        REQ-Q-8 decisions and delegation
packages/anyq/test/memory-adapter.test.ts  REQ-Q-6 and REQ-Q-8 against a real @anyq/memory consumer
packages/anyq/test/package.test.ts         zero dependencies, import direction, built output has no @anyonce/core/http import
packages/anyq/test/queue-ids.test.ts       REQ-DOC-9 docs/queue-ids.md shape
packages/anyq/services/redis-streams.test.ts  REQ-Q-6 and REQ-Q-8 against Redis Streams
packages/anyq/services/sqs.test.ts            REQ-Q-6 and REQ-Q-8 against ElasticMQ
packages/anyq/services/kafka.test.ts          REQ-Q-6 and REQ-Q-8 against Redpanda
go/anyqmw/doc.go                           package doc
go/anyqmw/errors.go                        ErrInFlight, ErrFingerprintMismatch, InFlightError, MismatchError, ConfigError
go/anyqmw/options.go                       Options, withDefaults, DefaultKeyHeader, key and scope resolution
go/anyqmw/middleware.go                    Wrap(handler core.Handler, opts Options) core.Handler
go/anyqmw/strategy.go                      Strategy(inner core.Strategy) core.Strategy
go/anyqmw/errors_test.go, options_test.go, middleware_test.go, strategy_test.go, memory_test.go
go/anyqmw/services_test.go                 REQ-Q-6 SQS and Kafka behind servicetest.Require
go/go.mod                                  github.com/sns45/anyq/go v0.5.0
docs/queue-ids.md                          REQ-DOC-9
docs/superpowers/questions.md              Q40, Q41, Q42, Q43
docs/reference/anyq-interfaces.md          one correction note (the SQS park row)
requirements.md                            4.5 and 4.8 wording per Q40 to Q43
CLAUDE.md                                  layout and dependency lines
package.json                               test, test:services and test:reqs script lines
test/ci.test.ts                            service-suite scan covers packages/anyq/services
.github/workflows/ci.yml                   go service step gains ./anyqmw/...
.changeset/p4a-queue.md
```

---
### Task 1: Record Q40 to Q43 and amend the spec files

**Files:**
- Modify: `docs/superpowers/questions.md` (append four entries), `requirements.md` (4.5 REQ-Q-1 note, 4.8 REQ-DOC-9 wording), `docs/reference/anyq-interfaces.md` (one correction note), `CLAUDE.md` (layout and dependency lines)
- Test: none (documentation only)

**Interfaces:**
- Produces: the wording every later task cites. No code.

The design walk against the published anyq 0.5.0 (npm `@anyq/*` 0.5.0, Go module `github.com/sns45/anyq/go v0.5.0`) surfaced four items. Each is filed with decision `pending` and work proceeds on the recommendation, exactly as Q15 to Q22 were.

- [ ] **Step 1: Append Q40 to `docs/superpowers/questions.md`**

```markdown
## Q40: anyq's park is not identity preserving on the two adapters that support it natively

D15 maps an in-flight duplicate to a park for the lease remainder, and Q2 makes that a `{ action: 'park', delayMs }` decision returned by the companion strategy. Reading the published adapters shows what park actually does:

- `@anyq/memory` `parkMessage` acks the original and re-enqueues `body`, `key` and `headers` after `delayMs` through `MemoryQueue.enqueue`, which mints a fresh message id. The id changes; the headers survive.
- `@anyq/sqs` `parkMessage` acks the original and sends a new `SendMessage` with `DelaySeconds`, carrying `MessageBody` only. Both the `MessageId` and the message attributes change. `docs/reference/anyq-interfaces.md` records this hook as a "ChangeMessageVisibility style delay", which the published 0.5.0 does not do.

So the key that REQ-Q-1 defaults to, the message id, does not survive the very park that D15 asks for, and on SQS neither does a producer supplied header. The parked copy would take a fresh claim and run the handler while the original claim holder is still running, which is the duplicate execution the door exists to prevent.

Recommended resolution: keep D15's mapping and make the key source explicit and adapter aware. `idempotent` takes `key?: 'id' | 'header' | 'body' | ((message) => string)`, default `'id'` as REQ-Q-1 says. `docs/queue-ids.md` gains a "survives an anyq park" column: the memory adapter keeps headers so `'header'` is park stable there, and on SQS only `'body'` (the D9 fingerprint of the payload) is park stable. The README, both examples and the SQS tests use a park stable key source, and one test in each language pins the loss with the id source so the gap is executable rather than prose. `docs/reference/anyq-interfaces.md` gains a dated correction note for the SQS row; the rest of that file stays verbatim.

**Decision: pending.** P4a proceeds on the recommendation.
```

- [ ] **Step 2: Append Q41**

```markdown
## Q41: REQ-DOC-9 says nine anyq adapters; anyq 0.5.0 publishes eleven

The npm scope holds `@anyq/core` plus eleven adapters: memory, redis-streams, rabbitmq, sqs, sns, google-pubsub, kafka, nats, azure-servicebus, cloudflare-queues, pgmq. `@anyq/sns` ships a producer only (no `consumer.d.ts`), so ten have a consumer. The Go module has nine consumer packages: it has no cloudflare-queues, which is a Workers only runtime.

Recommended resolution: read REQ-DOC-9's "all nine" as "every anyq consumer adapter" and give `docs/queue-ids.md` ten rows, one per TypeScript consumer adapter, with a Go column that marks cloudflare-queues as TypeScript only and a closing note that `@anyq/sns` is a producer and has no row. Amend requirements 4.8 REQ-DOC-9 to say "one row per anyq consumer adapter" instead of "all nine".

**Decision: pending.** P4a proceeds on the recommendation.
```

- [ ] **Step 3: Append Q42**

```markdown
## Q42: D8's queue scope is not derivable from a message on every adapter

D8 fixes the queue scope at `${queueName}/${consumerGroup}`. The wrapped handler receives a message, not the consumer, so the scope has to come from `metadata`. Reading `ProviderMetadata` in both languages: redis-streams carries both the stream and the consumer group; memory, sqs, kafka, pgmq, nats, google-pubsub and cloudflare-queues carry a queue, topic, stream or subscription name but no group; rabbitmq carries an exchange and a routing key but no queue name; azure-servicebus carries neither.

Recommended resolution: `scope?: string | ((message) => string)` with a default that derives the queue half from provider metadata and appends a group only when one is known, either from the metadata (redis-streams) or from an explicit `consumerGroup` option. A provider with no derivable queue name (rabbitmq, azure-servicebus) throws a typed `QueueConfigurationError` at the first message naming the option to set, rather than silently sharing one scope across queues. `docs/queue-ids.md` records the derived scope per adapter. D8 is unchanged: the option produces exactly `${queueName}/${consumerGroup}` whenever both halves exist.

**Decision: pending.** P4a proceeds on the recommendation.
```

- [ ] **Step 4: Append Q43**

```markdown
## Q43: D15's stored error arm is unreachable under REQ-Q-3

D15 says the stored result for a queue operation is `{ outcome: 'ok' } | { outcome: 'error', name, message }`. REQ-Q-3 says a handler exception abandons the record and rethrows so anyq's retry and dead-letter policy apply unchanged. The engine only calls `complete` after `run` returns, so an abandoned claim stores nothing and the error arm is never written.

Recommended resolution: the queue door stores only `{ kind: 'message', outcome: 'ok' }` and REQ-Q-5's test asserts exactly that record shape. The error arm stays in the `StoredResult` type from P1 for a future opt in. It is deliberately not made reachable now: replaying a stored failure for the whole 24 hour TTL takes the message out of anyq's retry and dead-letter policy, which is the behaviour REQ-Q-3 exists to preserve. If dedupe of permanent failures is wanted later it belongs behind an explicit option with its own REQ id.

**Decision: pending.** P4a proceeds on the recommendation.
```

- [ ] **Step 5: Amend `requirements.md`**

In 4.5 REQ-Q-1, after "Redelivery id stability per adapter is documented in `docs/queue-ids.md`.", add: "The key source is an explicit option (`'id'`, `'header'`, `'body'` or a function) because an anyq park does not preserve the message id on every adapter (Q40)."

In 4.8 REQ-DOC-9, replace "one row per anyq adapter (all nine)" with "one row per anyq consumer adapter" and leave the rest of the sentence intact (Q41).

- [ ] **Step 6: Add the correction note to `docs/reference/anyq-interfaces.md`**

Append at the end of the file:

```markdown
## 4. Corrections found against the published packages (2026-09-18)

The sections above were transcribed from the anyq source at `b49d41f`. Two rows do not match the published 0.5.0 artifacts and are corrected here rather than edited above, so the transcription stays verbatim:

- TypeScript adapter table, `sqs` `parkMessage`: the published `@anyq/sqs` 0.5.0 does not change visibility. It acks the received message and publishes a new one with `SendMessage` and `DelaySeconds`, carrying `MessageBody` only, so the parked copy has a new `MessageId` and no message attributes. `@anyq/memory` `parkMessage` likewise re-enqueues and mints a fresh id, keeping `key` and `headers`. See `docs/superpowers/questions.md` Q40.
- Built-in strategies are re-exported from the `@anyq/core` root. The published `exports` map has no `./strategies` subpath.
```

- [ ] **Step 7: Amend `CLAUDE.md`**

In the layout block, add after the `packages/webhooks` line:

```
packages/anyq             @anyonce/anyq        anyq consumer middleware and the companion idempotency strategy
```

and add `docs/queue-ids.md` to the `docs/` line's file list. In "Code rules", extend the Go dependency sentence to read: "Go: standard library first; the only third-party deps are the store clients, `modernc.org/sqlite` and `github.com/sns45/anyq/go` (used by `anyqmw` and its tests)."

- [ ] **Step 8: Run the dash gate and commit**

Run: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .`
Expected: no output.

```bash
git add docs/superpowers/questions.md requirements.md docs/reference/anyq-interfaces.md CLAUDE.md
git commit -m "docs(spec): record Q40 to Q43 and amend REQ-DOC-9 for the published anyq adapters"
```

---

### Task 2: `@anyonce/anyq` scaffold, typed errors, message fingerprint (REQ-Q-1)

**Files:**
- Create: `packages/anyq/package.json`, `packages/anyq/tsconfig.json`, `packages/anyq/src/errors.ts`, `packages/anyq/src/fingerprint.ts`, `packages/anyq/src/index.ts`, `packages/anyq/test/errors.test.ts`, `packages/anyq/test/fingerprint.test.ts`, `packages/anyq/test/package.test.ts`
- Modify: `package.json` (root `test` script filter)

**Interfaces:**
- Produces: `AnyonceQueueError`, `InFlightError`, `FingerprintMismatchError`, `FingerprintError`, `QueueConfigurationError`, `isInFlightError(err)`, `isFingerprintMismatchError(err)`, `messageFingerprint(body: unknown): Promise<string>`. Tasks 3, 4, 5 and 6 consume all of them.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/anyq/package.json`:

```json
{
  "name": "@anyonce/anyq",
  "version": "0.0.0",
  "description": "anyq consumer middleware for anyonce idempotency",
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
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts --clean",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@anyonce/core": "workspace:*",
    "@anyq/core": ">=0.5.0 <1"
  },
  "devDependencies": {
    "@anyonce/core": "workspace:*",
    "@anyq/core": "0.5.0",
    "@anyq/kafka": "0.5.0",
    "@anyq/memory": "0.5.0",
    "@anyq/redis-streams": "0.5.0",
    "@anyq/sqs": "0.5.0",
    "@aws-sdk/client-sqs": "^3.700.0"
  }
}
```

`packages/anyq/tsconfig.json` is a copy of `packages/hono/tsconfig.json` with the same `extends` and `include` values; read that file and mirror it exactly.

- [ ] **Step 2: Add the package to the root test filter**

In root `package.json`, the `test` script becomes:

```
"test": "bun test packages/core packages/hono packages/anyq/test packages/conformance conformance/ scripts test/ci.test.ts packages/stores/test",
```

The filter is `packages/anyq/test`, not `packages/anyq`, so the service-backed suites in `packages/anyq/services` stay out of the default run (`test/ci.test.ts` enforces this in Task 6).

- [ ] **Step 3: Install and write the failing tests**

Run: `bun install`

`packages/anyq/test/errors.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  AnyonceQueueError,
  FingerprintMismatchError,
  InFlightError,
  isFingerprintMismatchError,
  isInFlightError,
  QueueConfigurationError,
} from '../src/errors';

describe('typed queue errors', () => {
  test('REQ-Q-1: an in-flight error carries the lease, the delay and a retryable flag', () => {
    const err = new InFlightError(1_700_000_030_000, 4_500);
    expect(err).toBeInstanceOf(AnyonceQueueError);
    expect(err.name).toBe('InFlightError');
    expect(err.code).toBe('in-flight');
    expect(err.retryable).toBe(true);
    expect(err.leaseUntil).toBe(1_700_000_030_000);
    expect(err.delayMs).toBe(4_500);
    expect(err.translated).toBe(false);
    expect(err.message).not.toContain('1_700_000_030_000');
  });

  test('REQ-Q-1: a mismatch error carries the record and is not retryable', () => {
    const record = {
      scope: 'orders/workers',
      key: 'm-1',
      fingerprint: 'aa',
      state: 'completed' as const,
      fence: 1,
      leaseUntil: 0,
      createdAt: 0,
      expiresAt: 1,
    };
    const err = new FingerprintMismatchError(record);
    expect(err.name).toBe('FingerprintMismatchError');
    expect(err.code).toBe('fingerprint-mismatch');
    expect(err.retryable).toBe(false);
    expect(err.record).toBe(record);
    expect(err.message).not.toContain('m-1');
  });

  test('REQ-Q-1: the predicates match a foreign copy of the error by code', () => {
    const foreign = Object.assign(new Error('other copy'), {
      code: 'in-flight',
      retryable: true,
      delayMs: 10,
    });
    expect(isInFlightError(foreign)).toBe(true);
    expect(isFingerprintMismatchError(foreign)).toBe(false);
    expect(isInFlightError(new QueueConfigurationError('no scope'))).toBe(false);
    expect(isFingerprintMismatchError(Object.assign(new Error('x'), { code: 'fingerprint-mismatch' }))).toBe(true);
    expect(isInFlightError('not an error')).toBe(false);
  });
});
```

`packages/anyq/test/fingerprint.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { jcsFingerprint, sha256Hex } from '@anyonce/core';
import { FingerprintError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';

const encoder = new TextEncoder();

describe('message fingerprint', () => {
  test('REQ-Q-1: a string body hashes its UTF-8 bytes', async () => {
    await expect(messageFingerprint('hello')).resolves.toBe(
      await sha256Hex(encoder.encode('hello')),
    );
  });

  test('REQ-Q-1: byte bodies hash the bytes directly', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const expected = await sha256Hex(bytes);
    await expect(messageFingerprint(bytes)).resolves.toBe(expected);
    await expect(messageFingerprint(bytes.buffer)).resolves.toBe(expected);
    await expect(messageFingerprint(new DataView(bytes.buffer))).resolves.toBe(expected);
  });

  test('REQ-Q-1: an object body hashes its RFC 8785 form, so key order does not matter', async () => {
    const a = await messageFingerprint({ b: 2, a: 1 });
    const b = await messageFingerprint({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe(await jcsFingerprint({ a: 1, b: 2 }));
  });

  test('REQ-Q-1: a body JCS cannot serialize throws FingerprintError, never a silent fallback', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(messageFingerprint(cyclic)).rejects.toBeInstanceOf(FingerprintError);
    await expect(messageFingerprint(10n)).rejects.toBeInstanceOf(FingerprintError);
  });
});
```

`packages/anyq/test/package.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
) as Record<string, Record<string, string> | undefined>;

describe('package shape', () => {
  test('REQ-Q-1: the package ships zero runtime dependencies and takes anyq and core as peers', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(['@anyonce/core', '@anyq/core']);
  });

  test('REQ-Q-1: no source file imports the HTTP subpath or a node builtin', () => {
    const glob = new Bun.Glob('*.ts');
    const files = [...glob.scanSync({ cwd: join(import.meta.dir, '../src'), absolute: true })];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('@anyonce/core/http');
      expect(source).not.toMatch(/from '(node:|fs|path)/);
    }
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test packages/anyq/test`
Expected: FAIL, the modules under `src/` do not exist.

- [ ] **Step 5: Implement `src/errors.ts`**

```ts
import type { IdempotencyRecord } from '@anyonce/core';

/** Stable discriminators so a second copy of this package in one dependency tree still translates (see isInFlightError). */
export type QueueErrorCode =
  | 'in-flight'
  | 'fingerprint-mismatch'
  | 'fingerprint'
  | 'configuration';

/**
 * Base for every error the queue door throws. `retryable` is a plain property so anyq's isRetryableError
 * predicate reads it without this package extending AnyQError, which would make @anyq/core a runtime dependency.
 */
export class AnyonceQueueError extends Error {
  readonly code: QueueErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: QueueErrorCode, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** D15: a duplicate arrived while the first claim is still in flight. The companion strategy parks for delayMs. */
export class InFlightError extends AnyonceQueueError {
  readonly leaseUntil: number;
  readonly delayMs: number;
  /** Set by idempotencyStrategy when it turns this error into a park decision (REQ-Q-8). */
  translated = false;

  constructor(leaseUntil: number, delayMs: number) {
    super('anyonce: a duplicate of this message is already being processed', 'in-flight', true);
    this.name = 'InFlightError';
    this.leaseUntil = leaseUntil;
    this.delayMs = delayMs;
  }
}

/** D15: the same identity arrived with a different payload. The companion strategy dead-letters it. */
export class FingerprintMismatchError extends AnyonceQueueError {
  readonly record: IdempotencyRecord;
  /** Set by idempotencyStrategy when it turns this error into a dead-letter decision (REQ-Q-8). */
  translated = false;

  constructor(record: IdempotencyRecord) {
    super(
      'anyonce: this message identity was seen with a different payload',
      'fingerprint-mismatch',
      false,
    );
    this.name = 'FingerprintMismatchError';
    this.record = record;
  }
}

/** Q3: the body could not be canonicalized, so no fingerprint exists. Never a silent fallback. */
export class FingerprintError extends AnyonceQueueError {
  constructor(cause: unknown) {
    super('anyonce: the message body cannot be canonicalized for a fingerprint', 'fingerprint', false);
    this.name = 'FingerprintError';
    this.cause = cause;
  }
}

/** Q42: the wrapper cannot derive something it needs and the caller must supply it. */
export class QueueConfigurationError extends AnyonceQueueError {
  constructor(message: string) {
    super(message, 'configuration', false);
    this.name = 'QueueConfigurationError';
  }
}

function hasCode(value: unknown, code: QueueErrorCode): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { code?: unknown }).code === code
  );
}

/** True for an InFlightError from this copy of the package or from another one. */
export function isInFlightError(value: unknown): value is InFlightError {
  return value instanceof InFlightError || hasCode(value, 'in-flight');
}

/** True for a FingerprintMismatchError from this copy of the package or from another one. */
export function isFingerprintMismatchError(value: unknown): value is FingerprintMismatchError {
  return value instanceof FingerprintMismatchError || hasCode(value, 'fingerprint-mismatch');
}
```

- [ ] **Step 6: Implement `src/fingerprint.ts`**

```ts
import { jcsFingerprint, sha256Hex } from '@anyonce/core';
import { FingerprintError } from './errors';

const encoder = new TextEncoder();

/**
 * D9 as amended by Q3: the TypeScript queue fingerprint is total. A string hashes its UTF-8 bytes, a byte body
 * hashes the bytes, and anything else hashes its RFC 8785 canonical form. A body JCS cannot serialize throws
 * FingerprintError. `message.raw` is never used, because that would make the fingerprint provider dependent.
 */
export async function messageFingerprint(body: unknown): Promise<string> {
  if (typeof body === 'string') return sha256Hex(encoder.encode(body));
  if (body instanceof ArrayBuffer) return sha256Hex(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return sha256Hex(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  try {
    return await jcsFingerprint(body);
  } catch (cause) {
    throw new FingerprintError(cause);
  }
}
```

- [ ] **Step 7: Implement `src/index.ts` (partial, extended in Tasks 3 to 5)**

```ts
export type { QueueErrorCode } from './errors';
export {
  AnyonceQueueError,
  FingerprintError,
  FingerprintMismatchError,
  InFlightError,
  isFingerprintMismatchError,
  isInFlightError,
  QueueConfigurationError,
} from './errors';
export { messageFingerprint } from './fingerprint';
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun run build` then `bun test packages/anyq/test`
Expected: PASS, 8 tests.

- [ ] **Step 9: Lint, typecheck and commit**

Run: `bun run lint` and `bun run typecheck`
Expected: clean.

```bash
git add packages/anyq package.json bun.lock
git commit -m "feat(anyq): scaffold @anyonce/anyq with typed errors and the total message fingerprint"
```

---

### Task 3: Key and scope resolution (REQ-Q-1)

**Files:**
- Create: `packages/anyq/src/options.ts`, `packages/anyq/test/fake.ts`, `packages/anyq/test/options.test.ts`
- Modify: `packages/anyq/src/index.ts`

**Interfaces:**
- Consumes: `messageFingerprint`, `QueueConfigurationError` from Task 2.
- Produces: `IdempotentOptions<T>`, `ResolvedOptions<T>`, `resolveOptions(options)`, `resolveKey(message, resolved)`, `resolveScope(message, resolved)`, `DEFAULT_KEY_HEADER`. Task 4 consumes all of them; `fakeMessage` is the test builder Tasks 4 and 5 reuse.

- [ ] **Step 1: Write the test message builder**

`packages/anyq/test/fake.ts`:

```ts
import type { IMessage, MessageHeaders, ProviderMetadata } from '@anyq/core';

export interface FakeMessageInit<T> {
  id?: string;
  body: T;
  headers?: MessageHeaders;
  metadata?: ProviderMetadata;
  deliveryAttempt?: number;
}

/** A real IMessage shape with recording ack and nack, so the wrapper under test is exercised as anyq calls it. */
export function fakeMessage<T>(init: FakeMessageInit<T>): IMessage<T> & {
  acks: number;
  nacks: Array<boolean | undefined>;
} {
  const message = {
    id: init.id ?? 'msg-1',
    body: init.body,
    headers: init.headers ?? {},
    timestamp: new Date(0),
    deliveryAttempt: init.deliveryAttempt ?? 1,
    metadata: init.metadata ?? { provider: 'memory', memory: { queueName: 'orders' } },
    raw: undefined,
    acks: 0,
    nacks: [] as Array<boolean | undefined>,
    async ack(): Promise<void> {
      message.acks += 1;
    },
    async nack(requeue?: boolean): Promise<void> {
      message.nacks.push(requeue);
    },
  };
  return message as unknown as IMessage<T> & { acks: number; nacks: Array<boolean | undefined> };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/anyq/test/options.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { QueueConfigurationError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { resolveKey, resolveOptions, resolveScope } from '../src/options';
import { fakeMessage } from './fake';

const base = { store: new MemoryStore() };

describe('key resolution', () => {
  test('REQ-Q-1: the default key is the broker message id', async () => {
    const resolved = resolveOptions(base);
    const message = fakeMessage({ id: 'sqs-42', body: { a: 1 } });
    await expect(resolveKey(message, resolved)).resolves.toBe('sqs-42');
  });

  test('REQ-Q-1: the header source reads idempotency-key case insensitively and decodes byte values', async () => {
    const resolved = resolveOptions({ ...base, key: 'header' });
    const text = fakeMessage({ body: {}, headers: { 'Idempotency-Key': 'from-producer' } });
    await expect(resolveKey(text, resolved)).resolves.toBe('from-producer');
    const bytes = fakeMessage({
      body: {},
      headers: { 'idempotency-key': new TextEncoder().encode('from-bytes') as unknown as string },
    });
    await expect(resolveKey(bytes, resolved)).resolves.toBe('from-bytes');
  });

  test('REQ-Q-1: a missing header under the header source is a configuration error', async () => {
    const resolved = resolveOptions({ ...base, key: 'header' });
    await expect(resolveKey(fakeMessage({ body: {} }), resolved)).rejects.toBeInstanceOf(
      QueueConfigurationError,
    );
  });

  test('REQ-Q-1: the body source is the fingerprint, so it survives a re-published message', async () => {
    const resolved = resolveOptions({ ...base, key: 'body' });
    const first = fakeMessage({ id: 'id-1', body: { a: 1 } });
    const second = fakeMessage({ id: 'id-2', body: { a: 1 } });
    const key = await resolveKey(first, resolved);
    expect(key).toBe(await messageFingerprint({ a: 1 }));
    expect(await resolveKey(second, resolved)).toBe(key);
  });

  test('REQ-Q-1: a custom key function wins and its result is validated', async () => {
    const resolved = resolveOptions({ ...base, key: (m) => `order-${String(m.id)}` });
    await expect(resolveKey(fakeMessage({ id: '7', body: {} }), resolved)).resolves.toBe('order-7');
    const tooLong = resolveOptions({ ...base, key: () => 'x'.repeat(256) });
    await expect(resolveKey(fakeMessage({ body: {} }), tooLong)).rejects.toBeInstanceOf(
      QueueConfigurationError,
    );
  });
});

describe('scope resolution', () => {
  test('REQ-Q-1: redis-streams derives queue and consumer group from the metadata', () => {
    const message = fakeMessage({
      body: {},
      metadata: {
        provider: 'redis-streams',
        redisStreams: {
          stream: 'orders',
          entryId: '1-0',
          consumerGroup: 'workers',
          consumer: 'c1',
        },
      },
    });
    expect(resolveScope(message, resolveOptions(base))).toBe('orders/workers');
  });

  test('REQ-Q-1: an adapter without a group uses the queue name, and consumerGroup appends to it', () => {
    const message = fakeMessage({
      body: {},
      metadata: { provider: 'kafka', kafka: { topic: 'orders', partition: 0, offset: '9', highWatermark: '10' } },
    });
    expect(resolveScope(message, resolveOptions(base))).toBe('orders');
    expect(resolveScope(message, resolveOptions({ ...base, consumerGroup: 'billing' }))).toBe(
      'orders/billing',
    );
  });

  test('REQ-Q-1: an adapter that names no queue on the message demands an explicit scope', () => {
    const message = fakeMessage({
      body: {},
      metadata: {
        provider: 'rabbitmq',
        rabbitmq: { exchange: 'x', routingKey: 'r', consumerTag: 't', deliveryTag: 1, redelivered: false },
      },
    });
    expect(() => resolveScope(message, resolveOptions(base))).toThrow(QueueConfigurationError);
    expect(resolveScope(message, resolveOptions({ ...base, scope: 'orders/workers' }))).toBe(
      'orders/workers',
    );
    expect(resolveScope(message, resolveOptions({ ...base, scope: (m) => `q/${m.metadata.provider}` }))).toBe(
      'q/rabbitmq',
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/anyq/test/options.test.ts`
Expected: FAIL, `../src/options` does not exist.

- [ ] **Step 4: Implement `src/options.ts`**

```ts
import { type Store, validateKey } from '@anyonce/core';
import type { IMessage, MessageHeaders, ProviderMetadata } from '@anyq/core';
import { QueueConfigurationError } from './errors';
import { messageFingerprint } from './fingerprint';

/** REQ-Q-1 key sources. Q40: only 'body' survives an anyq park on every adapter. */
export type KeySource = 'id' | 'header' | 'body';

/** The header a producer sets when the broker id is not stable (REQ-DOC-1, Q4). */
export const DEFAULT_KEY_HEADER = 'idempotency-key';

export interface IdempotentOptions<T = unknown> {
  store: Store;
  key?: KeySource | ((message: IMessage<T>) => string | Promise<string>);
  keyHeader?: string;
  scope?: string | ((message: IMessage<T>) => string);
  consumerGroup?: string;
  fingerprint?: (message: IMessage<T>) => string | Promise<string>;
  leaseMs?: number;
  ttlMs?: number;
  /** D15: 'retry' throws InFlightError for the strategy to park; 'ack' treats the duplicate as handled. */
  onInFlight?: 'retry' | 'ack';
  clock?: () => number;
  logger?: { warn(message: string): void };
}

export interface ResolvedOptions<T = unknown> {
  store: Store;
  key: KeySource | ((message: IMessage<T>) => string | Promise<string>);
  keyHeader: string;
  scope: string | ((message: IMessage<T>) => string) | undefined;
  consumerGroup: string | undefined;
  fingerprint: (message: IMessage<T>) => string | Promise<string>;
  leaseMs: number | undefined;
  ttlMs: number | undefined;
  onInFlight: 'retry' | 'ack';
  clock: () => number;
  logger: { warn(message: string): void };
}

const defaultLogger = {
  warn(message: string): void {
    console.warn(message);
  },
};

export function resolveOptions<T = unknown>(options: IdempotentOptions<T>): ResolvedOptions<T> {
  return {
    store: options.store,
    key: options.key ?? 'id',
    keyHeader: options.keyHeader ?? DEFAULT_KEY_HEADER,
    scope: options.scope,
    consumerGroup: options.consumerGroup,
    fingerprint: options.fingerprint ?? ((message) => messageFingerprint(message.body)),
    leaseMs: options.leaseMs,
    ttlMs: options.ttlMs,
    onInFlight: options.onInFlight ?? 'retry',
    clock: options.clock ?? Date.now,
    logger: options.logger ?? defaultLogger,
  };
}

/** Header values may be bytes on brokers with binary headers, so decode before comparing (anyq MessageHeaders). */
export function headerValue(headers: MessageHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [field, value] of Object.entries(headers)) {
    if (field.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array);
  }
  return undefined;
}

export async function resolveKey<T>(
  message: IMessage<T>,
  options: ResolvedOptions<T>,
): Promise<string> {
  const source = options.key;
  let key: string;
  if (typeof source === 'function') key = await source(message);
  else if (source === 'id') key = message.id;
  else if (source === 'body') key = await messageFingerprint(message.body);
  else {
    const found = headerValue(message.headers, options.keyHeader);
    if (found === undefined) {
      throw new QueueConfigurationError(
        `anyonce: key source "header" found no ${options.keyHeader} header on this message`,
      );
    }
    key = found;
  }
  const validation = validateKey(key);
  if (!validation.ok) {
    throw new QueueConfigurationError(`anyonce: the resolved identity is not usable: ${validation.reason}`);
  }
  return key;
}

/** Q42: the queue half of D8's scope, per provider, from what the message actually carries. */
function queueName(metadata: ProviderMetadata): { queue?: string; group?: string } {
  switch (metadata.provider) {
    case 'memory':
      return { queue: metadata.memory?.queueName };
    case 'redis-streams':
      return {
        queue: metadata.redisStreams?.stream,
        group: metadata.redisStreams?.consumerGroup,
      };
    case 'sqs':
      return { queue: metadata.sqs?.queueUrl };
    case 'kafka':
      return { queue: metadata.kafka?.topic };
    case 'pgmq':
      return { queue: metadata.pgmq?.queueName };
    case 'nats':
      return { queue: metadata.nats?.stream };
    case 'google-pubsub':
      return { queue: metadata.googlePubsub?.subscription };
    case 'cloudflare-queues':
      return { queue: metadata.cloudflareQueues?.queueName };
    default:
      return {};
  }
}

export function resolveScope<T>(message: IMessage<T>, options: ResolvedOptions<T>): string {
  const override = options.scope;
  if (typeof override === 'string') return override;
  if (typeof override === 'function') return override(message);
  const { queue, group } = queueName(message.metadata);
  if (queue === undefined || queue === '') {
    throw new QueueConfigurationError(
      `anyonce: the ${message.metadata.provider} adapter does not name its queue on the message; pass scope`,
    );
  }
  const resolvedGroup = options.consumerGroup ?? group;
  return resolvedGroup === undefined || resolvedGroup === ''
    ? queue
    : `${queue}/${resolvedGroup}`;
}
```

Check the exact shape `validateKey` returns before writing the error branch: read `packages/core/src/key.ts` and match its `KeyValidation` fields (the plan assumes `{ ok, reason }`; if the field is named differently, use the real name).

- [ ] **Step 5: Extend `src/index.ts`**

Add:

```ts
export type { IdempotentOptions, KeySource, ResolvedOptions } from './options';
export { DEFAULT_KEY_HEADER } from './options';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/anyq/test`
Expected: PASS, 16 tests.

- [ ] **Step 7: Lint, typecheck and commit**

```bash
git add packages/anyq
git commit -m "feat(anyq): REQ-Q-1 key sources and provider derived scopes"
```

---
### Task 4: `idempotent(handler, options)` and the D15 outcomes (REQ-Q-2, REQ-Q-3, REQ-Q-4, REQ-Q-5)

**Files:**
- Create: `packages/anyq/src/idempotent.ts`, `packages/anyq/test/idempotent.test.ts`
- Modify: `packages/anyq/src/index.ts`

**Interfaces:**
- Consumes: `resolveOptions`, `resolveKey`, `resolveScope`, `ResolvedOptions` from Task 3; the error classes from Task 2; `execute`, `defaultPolicy`, `MemoryStore` from `@anyonce/core`.
- Produces: `idempotent<T>(handler: MessageHandler<T>, options: IdempotentOptions<T>): MessageHandler<T>` and the internal `markUntranslated` state Task 5's warning test observes.

- [ ] **Step 1: Write the failing tests**

`packages/anyq/test/idempotent.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import { FingerprintMismatchError, InFlightError } from '../src/errors';
import { idempotent } from '../src/idempotent';
import { fakeMessage } from './fake';

const OP = { scope: 'orders', key: 'msg-1' };

describe('idempotent handler', () => {
  test('REQ-Q-2: the first delivery runs the handler and the duplicate does not', async () => {
    const store = new MemoryStore();
    const seen: unknown[] = [];
    const handler = idempotent<{ a: number }>(
      async (message) => {
        seen.push(message.body);
      },
      { store },
    );
    const message = fakeMessage({ id: 'msg-1', body: { a: 1 } });
    await handler(message);
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(seen).toEqual([{ a: 1 }]);
  });

  test('REQ-Q-5: the stored record is the outcome only, with no payload bytes', async () => {
    const store = new MemoryStore();
    const handler = idempotent(async () => {}, { store });
    await handler(fakeMessage({ id: 'msg-1', body: { secret: 'do-not-store-me' } }));
    const record = await store.get(OP, Date.now());
    expect(record?.state).toBe('completed');
    expect(record?.result).toEqual({ kind: 'message', outcome: 'ok' });
    expect(record?.result?.body).toBeUndefined();
    expect(record?.resultOmitted).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('do-not-store-me');
  });

  test('REQ-Q-2: an in-flight duplicate throws InFlightError with the lease remainder as the delay', async () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    const handler = idempotent(async () => {}, { store, leaseMs: 5_000, clock: () => now });
    const claimed = await store.begin(
      { ...OP, fingerprint: await fingerprintOf({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    expect(claimed.outcome).toBe('acquired');
    const error = await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).leaseUntil).toBe(now + 5_000);
    expect((error as InFlightError).delayMs).toBe(5_000);
  });

  test('REQ-Q-2: onInFlight ack returns without running the handler and without throwing', async () => {
    const store = new MemoryStore();
    const now = 1_700_000_000_000;
    let ran = 0;
    const handler = idempotent(
      async () => {
        ran += 1;
      },
      { store, leaseMs: 5_000, clock: () => now, onInFlight: 'ack' },
    );
    await store.begin(
      { ...OP, fingerprint: await fingerprintOf({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(ran).toBe(0);
  });

  test('REQ-Q-4: the same identity with a different payload throws FingerprintMismatchError', async () => {
    const store = new MemoryStore();
    let ran = 0;
    const handler = idempotent(
      async () => {
        ran += 1;
      },
      { store },
    );
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    const error = await handler(fakeMessage({ id: 'msg-1', body: { a: 2 } })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FingerprintMismatchError);
    expect((error as FingerprintMismatchError).record.key).toBe('msg-1');
    expect(ran).toBe(1);
  });

  test('REQ-Q-3: a handler exception abandons the claim and rethrows the original error', async () => {
    const store = new MemoryStore();
    const boom = new Error('handler exploded');
    const handler = idempotent(async () => {
      throw boom;
    }, { store });
    await expect(handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }))).rejects.toBe(boom);
    expect(await store.get(OP, Date.now())).toBeNull();
  });

  test('REQ-Q-3: after an abandoned claim the next delivery runs the handler again', async () => {
    const store = new MemoryStore();
    let attempts = 0;
    const handler = idempotent(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    }, { store });
    await expect(handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }))).rejects.toThrow('transient');
    await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    expect(attempts).toBe(2);
  });

  test('REQ-Q-2: two concurrent deliveries of one message run the handler once, the other conflicts', async () => {
    const store = new MemoryStore();
    let running = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = idempotent(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
    }, { store });
    const first = handler(fakeMessage({ id: 'msg-1', body: { a: 1 } }));
    const second = handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch((e: unknown) => e);
    const conflict = await second;
    release?.();
    await first;
    expect(conflict).toBeInstanceOf(InFlightError);
    expect(peak).toBe(1);
  });

  test('REQ-Q-2: a store failure under fail-closed reaches anyq so the message is retried', async () => {
    const failing = {
      ...new MemoryStore(),
      begin: async () => {
        throw new Error('store down');
      },
    } as unknown as MemoryStore;
    const handler = idempotent(async () => {}, { store: failing });
    await expect(handler(fakeMessage({ id: 'msg-1', body: {} }))).rejects.toThrow('store down');
  });
});

async function fingerprintOf(body: unknown): Promise<string> {
  const { messageFingerprint } = await import('../src/fingerprint');
  return messageFingerprint(body);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/anyq/test/idempotent.test.ts`
Expected: FAIL, `../src/idempotent` does not exist.

- [ ] **Step 3: Implement `src/idempotent.ts`**

```ts
import {
  defaultPolicy,
  type ExecutePolicy,
  execute,
  type Operation,
  type StoredResult,
} from '@anyonce/core';
import type { IMessage, MessageHandler } from '@anyq/core';
import { FingerprintMismatchError, InFlightError } from './errors';
import {
  type IdempotentOptions,
  type ResolvedOptions,
  resolveKey,
  resolveOptions,
  resolveScope,
} from './options';

/** Q2: the wrapper cannot see the consumer config, so it checks the previous delivery's error on the next one. */
const UNTRANSLATED_WARNING =
  'anyonce: an in-flight duplicate was reported to anyq but no strategy translated it. ' +
  'Configure idempotencyStrategy() on the consumer so duplicates park instead of taking the legacy retry path.';

/** D15: the only result a queue operation ever stores (REQ-Q-5, Q43). */
const OK_RESULT: StoredResult = { kind: 'message', outcome: 'ok' };

function policyFor<T>(options: ResolvedOptions<T>): ExecutePolicy {
  const overrides: Partial<ExecutePolicy> = { clock: options.clock };
  if (options.leaseMs !== undefined) overrides.leaseMs = options.leaseMs;
  if (options.ttlMs !== undefined) overrides.ttlMs = options.ttlMs;
  return defaultPolicy(overrides);
}

/**
 * REQ-Q-1: wraps an anyq MessageHandler so the handler runs at most once per identity while the record is alive.
 * Outcomes are D15: a completed duplicate returns without running the handler (anyq acks it under autoAck), an
 * in-flight duplicate throws InFlightError for the companion strategy to park, a payload mismatch throws
 * FingerprintMismatchError for the companion strategy to dead-letter, and a handler exception abandons the claim
 * and rethrows so anyq's own retry policy applies unchanged (REQ-Q-3).
 */
export function idempotent<T = unknown>(
  handler: MessageHandler<T>,
  options: IdempotentOptions<T>,
): MessageHandler<T> {
  const resolved = resolveOptions(options);
  const policy = policyFor(resolved);
  let pending: InFlightError | undefined;
  let warned = false;

  return async (message: IMessage<T>): Promise<void> => {
    const previous = pending;
    pending = undefined;
    if (previous !== undefined && !previous.translated && !warned) {
      warned = true;
      resolved.logger.warn(UNTRANSLATED_WARNING);
    }

    const op: Operation = {
      scope: resolveScope(message, resolved),
      key: await resolveKey(message, resolved),
      fingerprint: await resolved.fingerprint(message),
    };

    const outcome = await execute(resolved.store, op, async () => {
      await handler(message);
      return OK_RESULT;
    }, policy);

    switch (outcome.kind) {
      case 'executed':
      case 'replayed':
        return;
      case 'conflict': {
        if (resolved.onInFlight === 'ack') return;
        const delayMs = Math.max(1, outcome.leaseUntil - resolved.clock());
        const error = new InFlightError(outcome.leaseUntil, delayMs);
        pending = error;
        throw error;
      }
      case 'mismatch':
        throw new FingerprintMismatchError(outcome.record);
      default:
        throw outcome.error;
    }
  };
}
```

- [ ] **Step 4: Extend `src/index.ts`**

Add `export { idempotent } from './idempotent';`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/anyq/test`
Expected: PASS, 25 tests.

- [ ] **Step 6: Lint, typecheck and commit**

```bash
git add packages/anyq
git commit -m "feat(anyq): REQ-Q-2 to REQ-Q-5 the D15 outcomes on top of the engine"
```

---

### Task 5: The companion strategy (REQ-Q-8)

**Files:**
- Create: `packages/anyq/src/strategy.ts`, `packages/anyq/test/strategy.test.ts`
- Modify: `packages/anyq/src/index.ts`

**Interfaces:**
- Consumes: `isInFlightError`, `isFingerprintMismatchError` from Task 2; `idempotent` from Task 4.
- Produces: `IDEMPOTENCY_STRATEGY_NAME`, `idempotencyStrategy<T>(inner?: RetryStrategy<T>): RetryStrategy<T>`. Task 6 configures it on real consumers.

- [ ] **Step 1: Write the failing tests**

`packages/anyq/test/strategy.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { RetryStrategy, RetryStrategyContext } from '@anyq/core';
import { FingerprintMismatchError, InFlightError } from '../src/errors';
import { idempotent } from '../src/idempotent';
import { IDEMPOTENCY_STRATEGY_NAME, idempotencyStrategy } from '../src/strategy';
import { fakeMessage } from './fake';

function context(error: Error): RetryStrategyContext {
  return { message: fakeMessage({ body: {} }), error, attempt: 1, maxAttempts: 4 };
}

describe('idempotencyStrategy', () => {
  test('REQ-Q-8: an in-flight error becomes a park for the lease remainder', async () => {
    const strategy = idempotencyStrategy();
    const error = new InFlightError(1_700_000_005_000, 4_200);
    await expect(strategy.decide(context(error))).resolves.toEqual({ action: 'park', delayMs: 4_200 });
    expect(error.translated).toBe(true);
  });

  test('REQ-Q-8: a mismatch becomes a dead-letter with reason fingerprint-mismatch', async () => {
    const strategy = idempotencyStrategy();
    const error = new FingerprintMismatchError({
      scope: 'orders',
      key: 'msg-1',
      fingerprint: 'aa',
      state: 'completed',
      fence: 1,
      leaseUntil: 0,
      createdAt: 0,
      expiresAt: 1,
    });
    await expect(strategy.decide(context(error))).resolves.toEqual({
      action: 'deadLetter',
      reason: 'fingerprint-mismatch',
    });
    expect(error.translated).toBe(true);
  });

  test('REQ-Q-8: every other error is delegated to the inner strategy', async () => {
    const seen: Error[] = [];
    const inner: RetryStrategy = {
      name: 'test-inner',
      decide(ctx) {
        seen.push(ctx.error);
        return { action: 'requeue' };
      },
    };
    const strategy = idempotencyStrategy(inner);
    const other = new Error('downstream timeout');
    await expect(strategy.decide(context(other))).resolves.toEqual({ action: 'requeue' });
    expect(seen).toEqual([other]);
    expect(strategy.name).toBe(IDEMPOTENCY_STRATEGY_NAME);
  });

  test('REQ-Q-8: the default inner strategy is retryThenDeadLetter', async () => {
    const strategy = idempotencyStrategy();
    const decision = await strategy.decide({
      message: fakeMessage({ body: {} }),
      error: new Error('downstream timeout'),
      attempt: 9,
      maxAttempts: 4,
    });
    expect(decision).toEqual({ action: 'deadLetter', reason: 'max attempts exceeded' });
  });

  test('REQ-Q-8: with no strategy the typed error reaches anyq untranslated and the door warns once', async () => {
    const store = new MemoryStore();
    const warnings: string[] = [];
    const now = 1_700_000_000_000;
    const handler = idempotent(async () => {}, {
      store,
      leaseMs: 5_000,
      clock: () => now,
      logger: { warn: (message) => warnings.push(message) },
    });
    const { messageFingerprint } = await import('../src/fingerprint');
    await store.begin(
      { scope: 'orders', key: 'msg-1', fingerprint: await messageFingerprint({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    for (let i = 0; i < 3; i++) {
      await handler(fakeMessage({ id: 'msg-1', body: { a: 1 } })).catch(() => {});
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('idempotencyStrategy');
  });

  test('REQ-Q-8: a translated in-flight error does not produce the warning', async () => {
    const store = new MemoryStore();
    const warnings: string[] = [];
    const now = 1_700_000_000_000;
    const strategy = idempotencyStrategy();
    const handler = idempotent(async () => {}, {
      store,
      leaseMs: 5_000,
      clock: () => now,
      logger: { warn: (message) => warnings.push(message) },
    });
    const { messageFingerprint } = await import('../src/fingerprint');
    await store.begin(
      { scope: 'orders', key: 'msg-1', fingerprint: await messageFingerprint({ a: 1 }) },
      { leaseMs: 5_000, ttlMs: 60_000, now },
    );
    for (let i = 0; i < 3; i++) {
      const message = fakeMessage({ id: 'msg-1', body: { a: 1 } });
      const error = await handler(message).catch((e: unknown) => e as Error);
      await strategy.decide({ message, error, attempt: 1, maxAttempts: 4 });
    }
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/anyq/test/strategy.test.ts`
Expected: FAIL, `../src/strategy` does not exist.

- [ ] **Step 3: Implement `src/strategy.ts`**

```ts
import {
  retryThenDeadLetter,
  type RetryDecision,
  type RetryStrategy,
  type RetryStrategyContext,
} from '@anyq/core';
import { isFingerprintMismatchError, isInFlightError } from './errors';

/** The strategy's stable name. It is not one of anyq's park-free names, so a park-capable adapter check sees it. */
export const IDEMPOTENCY_STRATEGY_NAME = 'anyonce-idempotency';

/**
 * REQ-Q-8 and Q2: anyq's dead-letter and delay primitives are consumer hooks reachable only through a strategy
 * decision, so the door throws typed errors and this strategy translates them. An in-flight duplicate parks for
 * the lease remainder; a payload mismatch dead-letters with reason fingerprint-mismatch; everything else is the
 * inner strategy's business, which defaults to anyq's reference retryThenDeadLetter.
 *
 * On adapters without native delayed redelivery (Kafka, Redis Streams) anyq downgrades the park to an in-process
 * sleep followed by a re-invocation, which re-enters begin after the lease has expired. Those consumers must set
 * allowParkDowngrade so anyq's park policy check permits the downgrade.
 */
export function idempotencyStrategy<T = unknown>(inner?: RetryStrategy<T>): RetryStrategy<T> {
  const delegate = inner ?? retryThenDeadLetter<T>();
  return {
    name: IDEMPOTENCY_STRATEGY_NAME,
    decide(ctx: RetryStrategyContext<T>): RetryDecision | Promise<RetryDecision> {
      const error: unknown = ctx.error;
      if (isInFlightError(error)) {
        error.translated = true;
        return { action: 'park', delayMs: error.delayMs };
      }
      if (isFingerprintMismatchError(error)) {
        error.translated = true;
        return { action: 'deadLetter', reason: 'fingerprint-mismatch' };
      }
      return delegate.decide(ctx);
    },
  };
}
```

- [ ] **Step 4: Extend `src/index.ts`**

Add `export { IDEMPOTENCY_STRATEGY_NAME, idempotencyStrategy } from './strategy';`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run build` then `bun test packages/anyq/test`
Expected: PASS, 31 tests. If the fourth test's expected reason differs, read `retryThenDeadLetter` in `node_modules/@anyq/core/dist/strategies/built-ins.js` and use the real string.

- [ ] **Step 6: Lint, typecheck and commit**

```bash
git add packages/anyq
git commit -m "feat(anyq): REQ-Q-8 companion strategy mapping in-flight to park and mismatch to dead-letter"
```

---

### Task 6: The four TypeScript adapters (REQ-Q-6, REQ-Q-8)

**Files:**
- Create: `packages/anyq/test/memory-adapter.test.ts`, `packages/anyq/services/redis-streams.test.ts`, `packages/anyq/services/sqs.test.ts`, `packages/anyq/services/kafka.test.ts`
- Modify: `package.json` (`test:services`), `test/ci.test.ts` (service directory scan)

**Interfaces:**
- Consumes: `idempotent`, `idempotencyStrategy` from Tasks 4 and 5.
- Produces: no source; the evidence for the P4a gate's first three lines.

Read `packages/stores/services/redis.test.ts` first: it is the house pattern for a service-backed suite (reachability probe, clear skip message, `ANYONCE_REQUIRE_SERVICES`). Mirror its helper exactly rather than inventing another one.

A consumer's `applyStrategy` is `protected`, so each suite drives it through a one-line subclass that widens it:

```ts
class Probe<T> extends MemoryConsumer<T> {
  runStrategy(message: IMessage<T>, error: Error, reinvoke?: () => Promise<void>) {
    return this.applyStrategy(message, error, reinvoke);
  }
  deadLetters: Array<{ id: string; reason: string }> = [];
  protected override async deadLetterMessage(message: IMessage<T>, reason: string): Promise<void> {
    this.deadLetters.push({ id: message.id, reason });
    await super.deadLetterMessage(message, reason);
  }
}
```

- [ ] **Step 1: Write the memory adapter suite**

`packages/anyq/test/memory-adapter.test.ts` proves the three REQ-Q-8 acceptance cases on an adapter with native park, plus the Q40 finding. Tests, in order:

```ts
test('REQ-Q-6: a memory consumer runs a wrapped handler once for a redelivered message', ...)
```
Publish one message, subscribe with `idempotent(handler, { store, key: 'header', keyHeader: 'idempotency-key' })` and a producer supplied header, publish a second message with the same header and a byte-identical body, assert the inner handler ran once and both messages left the queue.

```ts
test('REQ-Q-8: with the strategy configured, an in-flight duplicate parks and the handler waits for the lease', ...)
```
Pre-claim the identity directly on the store with a 300 ms lease and a clock of `Date.now`, record `leaseUntil`, deliver the message through a `Probe` consumer configured with `strategy: idempotencyStrategy()`, and drive `runStrategy(message, thrownError, reinvoke)` where `reinvoke` re-runs the wrapped handler. Assert: the recorded time of the inner handler's first call is greater than or equal to `leaseUntil`, and the inner handler ran exactly once. The assertion is an ordering assertion on two recorded timestamps, never a duration.

```ts
test('REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch', ...)
```
Complete an identity, deliver the same identity with a different body, pass the thrown error to `runStrategy`, assert `probe.deadLetters` is `[{ id, reason: 'fingerprint-mismatch' }]` and `handled` is `true`.

```ts
test('REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated', ...)
```
Same setup with `strategy` unset; assert `runStrategy` returns `{ handled: false }` and that the error the consumer would see is the `InFlightError` with `translated === false`.

```ts
test('REQ-Q-1: an anyq park re-enqueues with a fresh message id, which the id key source cannot follow (Q40)', ...)
```
Park a real message through the consumer's park hook, read the redelivered message, assert its `id` differs from the original and its `headers` still carry `idempotency-key`. This test is the executable form of Q40 and the reason `docs/queue-ids.md` recommends a header or body key on this adapter.

- [ ] **Step 2: Write the three service suites**

Each of `packages/anyq/services/redis-streams.test.ts`, `sqs.test.ts` and `kafka.test.ts` covers the same four cases with the adapter's own transport:

- Redis Streams (`127.0.0.1:6379`, `@anyq/redis-streams`): create a unique stream and group per run, publish, consume. Scope comes from the metadata (`stream/consumerGroup`), so no `scope` option is needed; this suite is the one that proves the derived-scope path against real metadata. `allowParkDowngrade: true` and `key: 'id'` (Redis entry ids are stable across redelivery).
- SQS (`http://127.0.0.1:9324`, `@anyq/sqs`, queue created per run with `@aws-sdk/client-sqs` `CreateQueueCommand` and static dummy credentials): `key: 'body'`, because an anyq park on SQS re-publishes the body and drops both the id and the attributes (Q40). Pass `scope` explicitly if the queue URL is unwieldy; otherwise the derived `queueUrl` scope is fine and should be asserted once.
- Kafka (`127.0.0.1:9092`, `@anyq/kafka`): a unique topic per run (Redpanda's dev-container profile auto-creates topics; if the adapter's client refuses, create the topic through the adapter's admin client before subscribing). `allowParkDowngrade: true` because Kafka has no native delay, and the park case asserts the downgrade path: the inner handler's first call is at or after `leaseUntil`.

Each file starts with the reachability probe from `packages/stores/services/redis.test.ts` so it skips with a clear message locally and fails under `ANYONCE_REQUIRE_SERVICES=1`.

- [ ] **Step 3: Wire the suites into the service scripts**

Root `package.json`:

```
"test:services": "bun test test/compose.test.ts packages/stores/services packages/anyq/services",
```

`test/ci.test.ts`, in the test named `REQ-REL-4: no root test filter matches a service-backed suite, which only test:services may run`, replace the single `serviceDir` constant with a loop over both directories:

```ts
const serviceDirs = ['packages/stores/services', 'packages/anyq/services'];
const suites = serviceDirs.flatMap((serviceDir) =>
  readdirSync(join(import.meta.dir, '..', serviceDir))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `${serviceDir}/${name}`),
);
```

Leave the rest of that test as it is.

- [ ] **Step 4: Run everything**

Run: `docker compose -f test/compose.yml up -d --wait`
Run: `bun run build`
Run: `bun test packages/anyq/test`
Run: `bun run test:services`
Expected: all green, no skips while the containers are up.

Then prove the skip path: `docker compose -f test/compose.yml stop redpanda` and run `bun test packages/anyq/services/kafka.test.ts`; expected: a clear skip message, not a failure. Restart it afterwards.

- [ ] **Step 5: Commit**

```bash
git add packages/anyq package.json test/ci.test.ts
git commit -m "test(anyq): REQ-Q-6 memory, Redis Streams, SQS and Kafka consumers through the door"
```

---
### Task 7: Go `anyqmw` (REQ-Q-1 to REQ-Q-5, REQ-Q-7)

**Files:**
- Create: `go/anyqmw/doc.go`, `go/anyqmw/errors.go`, `go/anyqmw/options.go`, `go/anyqmw/middleware.go`, `go/anyqmw/errors_test.go`, `go/anyqmw/options_test.go`, `go/anyqmw/middleware_test.go`
- Modify: `go/go.mod`, `go/go.sum`

**Interfaces:**
- Consumes: `anyonce.Execute`, `anyonce.Operation`, `anyonce.StoredResult`, `anyonce.SHA256Hex` from `github.com/sns45/anyonce/go/anyonce`; `github.com/sns45/anyonce/go/store/memory` in tests; `core.Handler`, `core.Message`, `core.ProviderMetadata` from `github.com/sns45/anyq/go/core`.
- Produces: `ErrInFlight`, `ErrFingerprintMismatch`, `ErrConfiguration`, `*InFlightError`, `*MismatchError`, `Options`, `DefaultKeyHeader`, `Wrap(handler core.Handler, opts Options) core.Handler`. Task 8 consumes all of them.

Read `go/httpmw/middleware.go` before writing this task: the panic recovery shape (recover inside `run` so the engine abandons, re-panic after `Execute` returns) and the `Options` doc comment style are copied from there, not reinvented.

- [ ] **Step 1: Add the dependency**

Run: `GOROOT= /opt/homebrew/bin/go get -C go github.com/sns45/anyq/go@v0.5.0`
Run: `GOROOT= /opt/homebrew/bin/go mod tidy -C go`
Expected: `go.mod` gains `github.com/sns45/anyq/go v0.5.0`. Module graph pruning keeps the Pub/Sub, Azure, NATS and RabbitMQ clients out because no package here imports those adapters.

- [ ] **Step 2: Write the failing tests**

`go/anyqmw/middleware_test.go` (the file the other two test files support). Every subtest name starts with its REQ id:

```go
package anyqmw_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
)

func message(id string, body []byte, headers core.MessageHeaders) core.Message {
	return core.NewMessage(core.MessageParams{
		ID:              id,
		Body:            body,
		Headers:         headers,
		Timestamp:       time.Unix(0, 0),
		DeliveryAttempt: 1,
		Metadata:        core.ProviderMetadata{Provider: core.DriverMemory, Memory: &core.MemoryMetadata{QueueName: "orders"}},
	})
}

func TestWrap(t *testing.T) {
	t.Run("REQ-Q-2: the first delivery runs the handler and the duplicate does not", func(t *testing.T) {
		store := memory.New()
		var runs int
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			runs++
			return nil
		}, anyqmw.Options{Store: store})
		body := []byte(`{"a":1}`)
		if err := handler(context.Background(), message("m-1", body, nil)); err != nil {
			t.Fatalf("first delivery: %v", err)
		}
		if err := handler(context.Background(), message("m-1", body, nil)); err != nil {
			t.Fatalf("duplicate: %v", err)
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
	})

	t.Run("REQ-Q-5: the stored record is the outcome only, with no payload bytes", func(t *testing.T) {
		store := memory.New()
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{"secret":"do-not-store-me"}`), nil)); err != nil {
			t.Fatal(err)
		}
		record, err := store.Get(context.Background(), anyonce.Operation{Scope: "orders", Key: "m-1"}, time.Now())
		if err != nil || record == nil {
			t.Fatalf("get: %v, record %v", err, record)
		}
		if record.Result == nil || record.Result.Kind != anyonce.KindMessage || record.Result.Outcome != anyonce.OutcomeOK {
			t.Fatalf("stored result is %+v", record.Result)
		}
		if len(record.Result.Body) != 0 || record.Result.Status != 0 || record.Result.Error != nil {
			t.Fatalf("stored result carries payload data: %+v", record.Result)
		}
	})

	t.Run("REQ-Q-2: an in-flight duplicate returns an InFlightError carrying the lease remainder", func(t *testing.T) {
		store := memory.New()
		now := time.Unix(1_700_000_000, 0)
		op := anyonce.Operation{Scope: "orders", Key: "m-1", Fingerprint: anyonce.SHA256Hex([]byte(`{"a":1}`))}
		if _, err := store.Begin(context.Background(), op, anyonce.BeginOptions{Lease: 5 * time.Second, TTL: time.Minute, Now: now}); err != nil {
			t.Fatal(err)
		}
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{
			Store:  store,
			Policy: anyonce.Policy{Lease: 5 * time.Second, Clock: func() time.Time { return now }},
		})
		err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil))
		if !errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatalf("want ErrInFlight, got %v", err)
		}
		var inFlight *anyqmw.InFlightError
		if !errors.As(err, &inFlight) {
			t.Fatalf("want *InFlightError, got %T", err)
		}
		if inFlight.DelayMs != 5000 {
			t.Fatalf("DelayMs is %d, want 5000", inFlight.DelayMs)
		}
	})

	t.Run("REQ-Q-4: the same identity with a different payload returns a MismatchError", func(t *testing.T) { /* mirror the TypeScript case */ })

	t.Run("REQ-Q-3: a handler error abandons the claim and is returned unchanged", func(t *testing.T) {
		store := memory.New()
		boom := errors.New("handler exploded")
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return boom }, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{}`), nil)); !errors.Is(err, boom) {
			t.Fatalf("want the handler error, got %v", err)
		}
		record, err := store.Get(context.Background(), anyonce.Operation{Scope: "orders", Key: "m-1"}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned: %+v", record)
		}
	})

	t.Run("REQ-Q-7: a cancelled context abandons the claim", func(t *testing.T) {
		store := memory.New()
		ctx, cancel := context.WithCancel(context.Background())
		handler := anyqmw.Wrap(func(ctx context.Context, _ core.Message) error {
			cancel()
			return ctx.Err()
		}, anyqmw.Options{Store: store})
		if err := handler(ctx, message("m-1", []byte(`{}`), nil)); !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
		record, err := store.Get(context.Background(), anyonce.Operation{Scope: "orders", Key: "m-1"}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned after cancellation: %+v", record)
		}
	})

	t.Run("REQ-Q-7: a panicking handler abandons the claim and the panic still propagates", func(t *testing.T) {
		store := memory.New()
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { panic("boom") }, anyqmw.Options{Store: store})
		func() {
			defer func() {
				if recover() == nil {
					t.Error("panic did not propagate")
				}
			}()
			_ = handler(context.Background(), message("m-1", []byte(`{}`), nil))
		}()
		record, err := store.Get(context.Background(), anyonce.Operation{Scope: "orders", Key: "m-1"}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned after the panic: %+v", record)
		}
	})

	t.Run("REQ-Q-2: fifty concurrent deliveries of one message run the handler once", func(t *testing.T) {
		store := memory.New()
		var mu sync.Mutex
		runs := 0
		release := make(chan struct{})
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			mu.Lock()
			runs++
			mu.Unlock()
			<-release
			return nil
		}, anyqmw.Options{Store: store})
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make([]error, 50)
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				errs[i] = handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil))
			}(i)
		}
		close(start)
		time.Sleep(0)
		close(release)
		wg.Wait()
		conflicts := 0
		for _, err := range errs {
			if errors.Is(err, anyqmw.ErrInFlight) {
				conflicts++
			}
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
		if conflicts == 0 {
			t.Fatal("no delivery saw the in-flight claim")
		}
	})
}
```

Fill the REQ-Q-4 subtest with the same structure as the TypeScript mismatch test: complete an identity, deliver the same id with a different body, assert `errors.Is(err, anyqmw.ErrFingerprintMismatch)` and that `errors.As` yields a `*MismatchError` whose `Record.Key` is `m-1`.

`go/anyqmw/options_test.go` mirrors the TypeScript `options.test.ts` cases with REQ-Q-1 names: the default key is `msg.ID()`; `KeyHeader` reads the header case insensitively; `KeyBody` is `anyonce.SHA256Hex(msg.Body())`; a missing header is `ErrConfiguration`; the redis-streams metadata derives `stream/group`; kafka derives the topic and `ConsumerGroup` appends to it; rabbitmq returns `ErrConfiguration` until `Scope` is set.

`go/anyqmw/errors_test.go` asserts `errors.Is` reaches both sentinels through the concrete types, that `(*InFlightError).Error()` contains no key value, and that `Retryable()` is true for in flight and false for mismatch.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `GOROOT= /opt/homebrew/bin/go test -C go ./anyqmw/...`
Expected: FAIL, the package does not compile.

- [ ] **Step 4: Implement `go/anyqmw/errors.go`**

```go
package anyqmw

import (
	"errors"
	"sync/atomic"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Sentinels every caller and strategy matches with errors.Is.
var (
	// ErrInFlight marks a duplicate whose original claim is still in flight (D15).
	ErrInFlight = errors.New("anyqmw: a duplicate of this message is already being processed")
	// ErrFingerprintMismatch marks an identity that was seen with a different payload (D15).
	ErrFingerprintMismatch = errors.New("anyqmw: this message identity was seen with a different payload")
	// ErrConfiguration marks something the wrapper cannot derive and the caller must supply (Q42).
	ErrConfiguration = errors.New("anyqmw: configuration")
)

// InFlightError carries what the companion Strategy needs to park the duplicate for the lease remainder.
type InFlightError struct {
	// LeaseUntil is when the live claim's lease expires.
	LeaseUntil time.Time
	// DelayMs is the lease remainder in milliseconds, never below 1.
	DelayMs int

	translated atomic.Bool
}

// Error reports the failure. It never contains a key, a scope or a payload (NFR-2).
func (e *InFlightError) Error() string { return ErrInFlight.Error() }

// Unwrap exposes the sentinel to errors.Is.
func (e *InFlightError) Unwrap() error { return ErrInFlight }

// Retryable reports that redelivery is the right response, so anyq's default predicate retries rather than drops.
func (e *InFlightError) Retryable() bool { return true }

// MarkTranslated records that a strategy turned this error into a decision (REQ-Q-8).
func (e *InFlightError) MarkTranslated() { e.translated.Store(true) }

// Translated reports whether a strategy translated this error.
func (e *InFlightError) Translated() bool { return e.translated.Load() }

// MismatchError carries the stored record whose fingerprint did not match.
type MismatchError struct {
	// Record is the record already held for this identity.
	Record *anyonce.Record
}

// Error reports the failure without naming the key or the payload (NFR-2).
func (e *MismatchError) Error() string { return ErrFingerprintMismatch.Error() }

// Unwrap exposes the sentinel to errors.Is.
func (e *MismatchError) Unwrap() error { return ErrFingerprintMismatch }

// Retryable reports that redelivery cannot help, so a strategy should dead-letter rather than retry.
func (e *MismatchError) Retryable() bool { return false }
```

- [ ] **Step 5: Implement `go/anyqmw/options.go`**

Mirror `go/httpmw/options.go` in shape. `Options` holds `Store anyonce.Store`, `Key KeySource`, `KeyFunc func(core.Message) (string, error)`, `KeyHeader string`, `Scope string`, `ScopeFunc func(core.Message) (string, error)`, `ConsumerGroup string`, `Fingerprint func(core.Message) (string, error)`, `OnInFlight InFlightMode`, `Policy anyonce.Policy` and `Warn func(string)`. Constants: `KeyID KeySource = "id"` (default), `KeyHeader`, `KeyBody`; `DefaultKeyHeader = "idempotency-key"`; `InFlightRetry InFlightMode = "retry"` (default) and `InFlightAck`. `withDefaults` fills the zero values; the default `Fingerprint` is `anyonce.SHA256Hex(msg.Body())` exactly as D9 says for Go; the default `Warn` is a single `log.Printf` (the only logging in the module). Key resolution validates with `anyonce.ValidateKey` and wraps a failure as `fmt.Errorf("%w: %s", ErrConfiguration, reason)`. Scope resolution switches on `msg.Metadata().Provider` with the same per-provider table as the TypeScript `queueName` function and returns `fmt.Errorf("%w: the %s adapter does not name its queue on the message; set Options.Scope", ErrConfiguration, provider)` for rabbitmq and azure-servicebus. Check the real name and signature of the Go key validator in `go/anyonce/key.go` before writing that branch.

- [ ] **Step 6: Implement `go/anyqmw/middleware.go`**

```go
package anyqmw

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyq/go/core"
)

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Wrap re-panics, the same shape httpmw uses (REQ-Q-7).
var errPanicked = errors.New("anyqmw: handler panicked")

const untranslatedWarning = "anyqmw: an in-flight duplicate was reported to anyq but no strategy translated it. " +
	"Configure anyqmw.Strategy on the consumer so duplicates park instead of taking the legacy retry path."

// Wrap returns a core.Handler with the same signature that runs handler at most once per identity while the
// record is alive (REQ-Q-1, REQ-Q-7). Outcomes are D15: a completed duplicate returns nil without running the
// handler, an in-flight duplicate returns an *InFlightError for the companion Strategy to park, a payload
// mismatch returns a *MismatchError for the companion Strategy to dead-letter, and a handler error or panic
// abandons the claim and propagates so anyq's own policy applies unchanged (REQ-Q-3).
func Wrap(handler core.Handler, opts Options) core.Handler {
	o := opts.withDefaults()
	var mu sync.Mutex
	var pending *InFlightError
	var warned bool

	return func(ctx context.Context, msg core.Message) error {
		mu.Lock()
		previous := pending
		pending = nil
		if previous != nil && !previous.Translated() && !warned {
			warned = true
			mu.Unlock()
			o.Warn(untranslatedWarning)
		} else {
			mu.Unlock()
		}

		op, err := o.operation(msg)
		if err != nil {
			return err
		}

		var panicValue any
		result, err := anyonce.Execute(ctx, o.Store, op, func(ctx context.Context, _ int64) (anyonce.StoredResult, error) {
			var handlerErr error
			func() {
				defer func() {
					if p := recover(); p != nil {
						panicValue = p
					}
				}()
				handlerErr = handler(ctx, msg)
			}()
			if panicValue != nil {
				return anyonce.StoredResult{}, errPanicked
			}
			if handlerErr != nil {
				return anyonce.StoredResult{}, handlerErr
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return anyonce.StoredResult{}, ctxErr
			}
			return anyonce.StoredResult{Kind: anyonce.KindMessage, Outcome: anyonce.OutcomeOK}, nil
		}, o.Policy)
		if panicValue != nil {
			panic(panicValue)
		}
		if err != nil {
			return err
		}

		switch result.Kind {
		case anyonce.ResultExecuted, anyonce.ResultReplayed:
			return nil
		case anyonce.ResultConflict:
			if o.OnInFlight == InFlightAck {
				return nil
			}
			delayMs := int(result.LeaseUntil.Sub(o.Policy.Clock()).Milliseconds())
			if delayMs < 1 {
				delayMs = 1
			}
			inFlight := &InFlightError{LeaseUntil: result.LeaseUntil, DelayMs: delayMs}
			mu.Lock()
			pending = inFlight
			mu.Unlock()
			return inFlight
		case anyonce.ResultMismatch:
			return &MismatchError{Record: result.Record}
		default:
			return fmt.Errorf("anyqmw: unexpected engine result %q", result.Kind)
		}
	}
}
```

`o.Policy.Clock()` needs a non-nil clock, so `withDefaults` sets `Policy.Clock` to `time.Now` when it is nil. `Execute` wraps the handler error as `anyonce: handler failed: %w`, so `errors.Is(err, boom)` still holds and the REQ-Q-3 test passes unchanged. Add `go/anyqmw/doc.go` with a package comment that names REQ-Q-1 to REQ-Q-8 and points at `docs/queue-ids.md`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `GOROOT= /opt/homebrew/bin/go build -C go ./...`
Run: `GOROOT= /opt/homebrew/bin/go vet -C go ./...`
Run: `GOROOT= /opt/homebrew/bin/go test -race -C go ./anyqmw/...`
Expected: PASS.

- [ ] **Step 8: Lint and commit**

Run: `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: clean.

```bash
git add go
git commit -m "feat(go): REQ-Q-1 to REQ-Q-7 anyqmw wraps an anyq handler on the anyonce engine"
```

---

### Task 8: Go companion strategy and the service-backed adapters (REQ-Q-6, REQ-Q-8)

**Files:**
- Create: `go/anyqmw/strategy.go`, `go/anyqmw/strategy_test.go`, `go/anyqmw/memory_test.go`, `go/anyqmw/services_test.go`
- Modify: `.github/workflows/ci.yml` (the services job's Go step)

**Interfaces:**
- Consumes: everything from Task 7; `core.Strategy`, `core.Decision`, `core.Park`, `core.DeadLetter`, `core.RetryThenDeadLetter`, `core.BaseConsumer` from `github.com/sns45/anyq/go/core`; `github.com/sns45/anyq/go/memory`, `/sqs`, `/kafka`; `go/internal/servicetest`.
- Produces: `Strategy(inner core.Strategy) core.Strategy`, `StrategyName`.

- [ ] **Step 1: Write the failing strategy test**

`go/anyqmw/strategy_test.go`:

```go
func TestStrategy(t *testing.T) {
	t.Run("REQ-Q-8: an in-flight error becomes a park for the lease remainder", func(t *testing.T) {
		inFlight := &anyqmw.InFlightError{LeaseUntil: time.Unix(1_700_000_005, 0), DelayMs: 4200}
		decision, err := anyqmw.Strategy(nil).Decide(context.Background(), core.StrategyContext{Err: inFlight, Attempt: 1, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if decision.Action != core.ActionPark || decision.DelayMs != 4200 {
			t.Fatalf("decision is %+v", decision)
		}
		if !inFlight.Translated() {
			t.Fatal("the strategy did not mark the error translated")
		}
	})

	t.Run("REQ-Q-8: a mismatch becomes a dead-letter with reason fingerprint-mismatch", func(t *testing.T) { /* mirror */ })

	t.Run("REQ-Q-8: every other error is delegated to the inner strategy", func(t *testing.T) { /* mirror, with core.Custom as inner */ })

	t.Run("REQ-Q-8: a nil inner strategy delegates to RetryThenDeadLetter", func(t *testing.T) { /* attempt above maxAttempts yields ActionDeadLetter */ })
}
```

- [ ] **Step 2: Implement `go/anyqmw/strategy.go`**

```go
package anyqmw

import (
	"context"
	"errors"

	"github.com/sns45/anyq/go/core"
)

// StrategyName is the companion strategy's stable name. It is not one of anyq's park-free names, so a consumer
// on an adapter without native delay applies its park-downgrade policy to it (set AllowParkDowngrade there).
const StrategyName = "anyonce-idempotency"

// Strategy is REQ-Q-8 and Q2: anyq's dead-letter and delay primitives are consumer hooks reachable only through
// a decision, so Wrap returns typed errors and this strategy translates them. An in-flight duplicate parks for
// the lease remainder, a payload mismatch dead-letters with reason fingerprint-mismatch, and everything else
// goes to inner, which defaults to anyq's reference RetryThenDeadLetter when nil.
func Strategy(inner core.Strategy) core.Strategy {
	delegate := inner
	if delegate == nil {
		delegate = core.RetryThenDeadLetter(nil)
	}
	return core.Custom(StrategyName, func(ctx context.Context, sc core.StrategyContext) (core.Decision, error) {
		var inFlight *InFlightError
		if errors.As(sc.Err, &inFlight) {
			inFlight.MarkTranslated()
			return core.Park(inFlight.DelayMs), nil
		}
		if errors.Is(sc.Err, ErrFingerprintMismatch) {
			return core.DeadLetter("fingerprint-mismatch"), nil
		}
		return delegate.Decide(ctx, sc)
	})
}
```

- [ ] **Step 3: Write the memory adapter test**

`go/anyqmw/memory_test.go` proves the three REQ-Q-8 acceptance cases against `github.com/sns45/anyq/go/memory`, which has native park. The consumer's `ApplyStrategy` is exported in Go, so a probe type embedding the adapter's consumer is not needed for the strategy call; a probe is still needed to capture dead letters. Cases and names:

- `REQ-Q-6: a memory consumer runs a wrapped handler once for a redelivered message`
- `REQ-Q-8: with the strategy configured, an in-flight duplicate parks and the handler waits for the lease` (pre-claim with a 300 ms lease, record `leaseUntil`, drive `ApplyStrategy` with the returned `*InFlightError` and a reinvoke that re-runs the wrapped handler, assert the recorded first-call time is at or after `leaseUntil` and the inner handler ran once)
- `REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch`
- `REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated` (`ApplyStrategy` returns `handled == false`)
- `REQ-Q-1: an anyq park re-enqueues with a fresh message id, which the id key source cannot follow (Q40)`

- [ ] **Step 4: Write the service-backed test**

`go/anyqmw/services_test.go` covers SQS through ElasticMQ (`127.0.0.1:9324`) and Kafka through Redpanda (`127.0.0.1:9092`), each guarded by `servicetest.Require(t, "elasticmq", "127.0.0.1:9324")` and `servicetest.Require(t, "redpanda", "127.0.0.1:9092")`. Each creates its own queue or topic per run, publishes, consumes through `anyqmw.Wrap`, and asserts the same four cases as the memory test. Kafka sets `AllowParkDowngrade: true` on the consumer config because Go defaults to fail loud, and its park case asserts the downgrade path: the inner handler's first call is at or after `leaseUntil`.

- [ ] **Step 5: Add the package to the CI services job**

`.github/workflows/ci.yml`, the `services` job's Go step:

```yaml
        run: go test -race -count=1 ./store/... ./anyqmw/...
```

`test/ci.test.ts` asserts that step with `includes('go test -race -count=1 ./store/...')`, so it keeps passing unchanged.

- [ ] **Step 6: Run everything**

Run: `docker compose -f test/compose.yml up -d --wait`
Run: `GOROOT= /opt/homebrew/bin/go test -race -C go ./anyqmw/...`
Run: `GOROOT= ANYONCE_REQUIRE_SERVICES=1 /opt/homebrew/bin/go test -race -count=1 -C go ./anyqmw/...`
Run: `GOROOT= /opt/homebrew/bin/go vet -C go ./...` and `GOROOT= sh -c 'cd go && golangci-lint run'`
Expected: PASS and clean. Then stop `redpanda` and rerun without `ANYONCE_REQUIRE_SERVICES` to prove the skip message, and restart it.

- [ ] **Step 7: Commit**

```bash
git add go .github/workflows/ci.yml
git commit -m "feat(go): REQ-Q-8 anyqmw.Strategy and REQ-Q-6 memory, SQS and Kafka consumers"
```

---

### Task 9: `docs/queue-ids.md`, README wiring, changeset, REQ coverage (REQ-DOC-9)

**Files:**
- Create: `docs/queue-ids.md`, `packages/anyq/test/queue-ids.test.ts`, `.changeset/p4a-queue.md`
- Modify: `package.json` (`test:reqs`), `README.md` if one exists at this point (skip the README step when it does not, and record that in the PR body)

**Interfaces:**
- Consumes: the verified behaviour from Tasks 6 and 8.
- Produces: the REQ-DOC-9 deliverable.

- [ ] **Step 1: Write the failing doc test**

`packages/anyq/test/queue-ids.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(import.meta.dir, '../../../docs/queue-ids.md'), 'utf8');
const rows = doc
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) => line.split('|').map((cell) => cell.trim()));

const CONSUMER_ADAPTERS = [
  'memory',
  'redis-streams',
  'rabbitmq',
  'sqs',
  'google-pubsub',
  'kafka',
  'nats',
  'azure-servicebus',
  'cloudflare-queues',
  'pgmq',
];

describe('docs/queue-ids.md', () => {
  test('REQ-DOC-9: one row per anyq consumer adapter', () => {
    expect(rows.map((row) => row[1]?.replaceAll('`', ''))).toEqual(CONSUMER_ADAPTERS);
  });

  test('REQ-DOC-9: the four adapters P4a tested are marked verified and the rest are marked unverified', () => {
    const verified = rows
      .filter((row) => row.some((cell) => cell.includes('verified') && !cell.includes('unverified')))
      .map((row) => row[1]?.replaceAll('`', ''));
    expect(verified.sort()).toEqual(['kafka', 'memory', 'redis-streams', 'sqs']);
    const unverified = rows.filter((row) => row.some((cell) => cell.includes('unverified')));
    expect(unverified.length).toBe(CONSUMER_ADAPTERS.length - 4);
  });

  test('REQ-DOC-9: the page recommends a producer supplied header where the id is not stable', () => {
    expect(doc).toContain('idempotency-key');
    expect(doc).toContain('producer retry');
    expect(doc).toContain('@anyq/sns');
  });
});
```

- [ ] **Step 2: Write `docs/queue-ids.md`**

The page has, in order: a one-paragraph statement of the problem (a consumer side id can only dedupe redeliveries of one published message; a producer retry publishes a second message with a second id and no consumer side id can dedupe that, so a producer supplied `idempotency-key` header is the recommended default); the table; a section per column explaining what the value means; a "what to set" section naming the recommended `key` and `scope` options per adapter; and a closing note that `@anyq/sns` is a producer only adapter with no consumer and therefore no row.

Table columns, one row per consumer adapter:

| column | meaning |
|---|---|
| Adapter | the `@anyq/*` package name and the Go package, or "TypeScript only" |
| Message id | how anyq builds `message.id` for that adapter, quoted from the adapter source |
| Stable across redelivery | yes or no, with the mechanism |
| Stable across producer retry | always no, with one sentence on why |
| Survives an anyq park | yes or no (Q40) |
| Derived scope | what `resolveScope` produces, or "set scope" |
| Recommended key source | `id`, `header` or `body` |
| Status | `verified in P4a` or `per anyq adapter docs, unverified` |

The four rows the phase tested carry `verified in P4a` and cite the test file that proves them. The values already established by the design walk, which the implementer must confirm against the installed package before writing them down:

- `memory`: id is a generated sequence id; stable across redelivery, lost on park (park re-enqueues), headers survive park; derived scope is the queue name; recommend `header`.
- `redis-streams`: id is the stream entry id; stable across redelivery; park downgrades to an in-process retry so the same delivery is reused and the id survives; derived scope is `stream/consumerGroup`; recommend `id`.
- `sqs`: id is `MessageId`; stable across redelivery through the visibility timeout; lost on park, and the park drops message attributes too, so no header survives either; derived scope is the queue URL; recommend `body`.
- `kafka`: id is `topic-partition-offset`; stable across redelivery because a redelivery re-reads the same offset; park downgrades in process so the id survives; derived scope is the topic; recommend `id`.
- The remaining six rows are filled from the adapter sources in `node_modules/@anyq/*/dist` and marked unverified.

- [ ] **Step 3: Write the changeset**

`.changeset/p4a-queue.md`:

```markdown
---
'@anyonce/anyq': minor
---

Add the queue door: idempotent(handler, options) wraps an anyq consumer handler so it runs at most once per
message identity, and idempotencyStrategy(inner) translates the door's typed errors into anyq park and
dead-letter decisions. docs/queue-ids.md records message id stability per adapter.
```

- [ ] **Step 4: Extend the REQ coverage gate**

Root `package.json`:

```
"test:reqs": "bun run scripts/reqs.ts --phase p3 && bun run scripts/reqs.ts --phase p4a",
```

The script takes one phase at a time and P4a's scope is P4a plus P1 plus P0, so running it twice keeps the P2 and P3 ids checked as well. The parallel P4b branch appends its own `&& ... --phase p4b` to the same line.

- [ ] **Step 5: Run the full gate**

Run: `bun run lint`, `bun run build`, `bun run typecheck`, `bun run test`, `bun run test:reqs`, `bun run test:services`
Expected: all green; `test:reqs` reports every `REQ-Q-1` to `REQ-Q-8` and `REQ-DOC-9` covered with no UNCOVERED and no UNKNOWN lines.

- [ ] **Step 6: Commit**

```bash
git add docs/queue-ids.md packages/anyq .changeset package.json
git commit -m "docs(queue): REQ-DOC-9 message id stability per anyq consumer adapter"
```

---

## Phase gate (CHECKLIST.md, "Every phase" plus "P4a queue door")

Run each command and paste the raw output into the integration PR body. An item without output is not done.

Every phase:

1. `scripts/doctor.sh`
2. `bun run lint`
3. `bun run build`
4. `bun run typecheck`
5. `bun run test`
6. `bun run test:reqs`
7. `GOROOT= /opt/homebrew/bin/go vet -C go ./...`
8. `GOROOT= /opt/homebrew/bin/go test -race -C go ./...`
9. `GOROOT= sh -c 'cd go && golangci-lint run'`
10. `GOROOT= GO=/opt/homebrew/bin/go scripts/go-engine-coverage.sh`
11. `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing
12. `rg -n 'console\.(log|info|warn|error)\(.*key' packages go` returns nothing
13. `.changeset/p4a-queue.md` present
14. `docs/superpowers/questions.md` reviewed; Q40 to Q43 each carry a recommended resolution

P4a:

15. `docker compose -f test/compose.yml up -d --wait` then `bun run test:services` green with no skips (`scripts/no-skips.sh`)
16. `GOROOT= ANYONCE_REQUIRE_SERVICES=1 /opt/homebrew/bin/go test -race -count=1 -C go ./anyqmw/...` green
17. The REQ-Q-5 assertions in both languages show a stored record with no payload bytes
18. Both languages have a REQ-Q-8 test with the strategy and a REQ-Q-8 test without it, and the park-downgrade test asserts the inner handler's first call is at or after `leaseUntil`
19. Both languages have a mismatch test that ends in a dead-letter with reason `fingerprint-mismatch`
20. `docs/queue-ids.md` covers every anyq consumer adapter, the four tested marked verified

## Self-review notes

- Spec coverage: REQ-Q-1 Tasks 2, 3, 7; REQ-Q-2 Tasks 4, 7; REQ-Q-3 Tasks 4, 7; REQ-Q-4 Tasks 4, 7; REQ-Q-5 Tasks 4, 7; REQ-Q-6 Tasks 6, 8; REQ-Q-7 Task 7; REQ-Q-8 Tasks 5, 6, 8; REQ-DOC-9 Task 9.
- Names used across tasks and kept identical: `messageFingerprint`, `resolveOptions`, `resolveKey`, `resolveScope`, `idempotent`, `idempotencyStrategy`, `IDEMPOTENCY_STRATEGY_NAME`, `isInFlightError`, `isFingerprintMismatchError`; Go `Wrap`, `Strategy`, `StrategyName`, `InFlightError`, `MismatchError`, `ErrInFlight`, `ErrFingerprintMismatch`, `ErrConfiguration`, `DefaultKeyHeader`.
- Two library details are verified at implementation time rather than assumed: the exact `KeyValidation` field names in `packages/core/src/key.ts` and `go/anyonce/key.go`, and the exact dead-letter reason string `retryThenDeadLetter` produces when attempts are exhausted.
