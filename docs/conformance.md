# Conformance

The conformance suite is a set of executable JSON vectors for `draft-ietf-httpapi-idempotency-key-header` plus runners in TypeScript and Go that drive any HTTP target through them. It knows nothing about stores or languages: it sends requests and checks responses (D18). This page is the guide; the reference, including the full vector format and the fixture routes, is [`conformance/README.md`](../conformance/README.md). Requirements are in [requirements.md](../requirements.md) section 4.7.

## Run it against anything

Every target, in any language, mounts the fixture routes behind its idempotency layer (see [Fixture contract](#fixture-contract)) and is then pointed at by one of four runners.

### The CLI (any implementation, any language)

```sh
bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown
bunx @anyonce/conformance --url http://localhost:3000 --capability short-ttl --ttl-ms 2000 --report junit --out report.xml
```

Flags: `--url` (required), `--tier core|profile` (repeatable, default both), `--only <id>` (repeatable), `--capability short-ttl`, `--ttl-ms <n>`, `--report json|markdown|junit` (default markdown), `--out <file>`. Exit code 0 when every applicable vector passed, 1 when any failed or errored, 2 on a usage error. This is the REQ-CONF-7 runner and the one used for every third-party row in the report.

### The Go CLI, `go/cmd/conformance`

```sh
GOROOT= go run -C go ./cmd/conformance -url http://localhost:3000 -tier core -report markdown
GOROOT= go run -C go ./cmd/conformance -url http://localhost:3000 -only core/header-name-case-insensitive -report json
```

The flags mirror the TypeScript CLI one for one, with a single dash. Use it for one vector: `core/header-name-case-insensitive`. The TypeScript runner cannot put a non-lowercase header name on the wire, because the Fetch `Headers` class lowercases every name it stores, so from the TypeScript CLI that vector passes without proving anything. The Go runner sets the header map directly and can send any spelling, so it is the only runner that grades that vector for real (Q52). For every other vector either CLI gives the same answer, and the TypeScript CLI is the reference.

### In process, TypeScript

```ts
import { runConformance } from '@anyonce/conformance';

const { summary, report } = await runConformance({
  target: app.fetch, // any (req: Request) => Promise<Response>, or { baseUrl: 'http://localhost:3000' }
  tiers: ['core', 'profile'],
  capabilities: ['short-ttl'],
  report: 'markdown',
});
```

It runs inside `bun test` or vitest, needs no network for a fetch handler target, and runs concurrency steps with a barrier so both requests are in flight before either handler resolves (REQ-CONF-5).

### In process, Go

```go
conformance.Run(t, handler, conformance.Options{Capabilities: []string{"short-ttl"}})
```

`handler` is an `http.Handler` (served on an `httptest.Server` for the run) or a base URL string. `conformance.RunVectors` and `conformance.Format` are the library forms for use outside `testing.T` (REQ-CONF-6).

## Fixture contract

The target must serve `POST /echo`, `POST /status/{code}`, `POST /slow?ms=N`, `POST /large?bytes=N` and `GET /counter` behind its idempotency layer, and `POST /reset` outside it. Every POST fixture bumps one process wide counter that `GET /counter` reports, which is how the vectors count handler executions. The exact behavior of each route, and the two reference fixture apps (`conformance/fixtures/hono` and `go/cmd/fixture`), are specified in [`conformance/README.md`](../conformance/README.md#fixture-contract-req-conf-2). Do not restate them in your own docs; link there.

## The `short-ttl` capability

One core vector, `core/expiry-executes-again`, needs the key to expire during the run. It declares `requires: ["short-ttl"]`, which means the target's record TTL must be at most 2000 ms. Declare the capability (`--capability short-ttl` and `--ttl-ms <n>` on either CLI, `capabilities: ['short-ttl']` in process, `Capabilities: []string{"short-ttl"}` in Go) only when the target is actually configured that way; the CLIs check `--ttl-ms` against the limit. Without the capability the vector is reported as not applicable: it counts as neither a pass nor a fail. Every third-party row in the report was configured with a 2 s TTL so this vector is graded rather than skipped, and each row's notes say how.

## Reading `REPORT.md`

[`conformance/REPORT.md`](../conformance/REPORT.md) is generated from the committed run summaries under `conformance/results/`, never hand edited. How to read it:

- **Tiers.** `core` is what the draft states (MUST and SHOULD, header syntax, 400, 409, 422, replay, single execution); every core vector cites its draft section in `draftRef`. `profile` is anyonce's own choices where the draft is silent (`Idempotency-Replayed`, `Retry-After` on 409, 4xx replayed, 5xx not stored, the omitted body replay, the problem `code` member and media type, the empty key and 255 byte rules). Per D17 a third party is graded on `core` only. Its profile count is printed with `(info)` beside it and is never a pass or fail judgement.
- **N/A.** The count of vectors that were not applicable to that row, which in practice means `short-ttl` was not declared. Zero everywhere in the current report.
- **Failing core vectors.** Each failure links to an unsent issue draft under `conformance/issues/` (Q50).
- **Targets.** One section per row: the runner, the fixture, the pinned image and package versions for third parties, and notes on every setting that departs from the library's defaults (for example Fiber's header name and key validator, Q53).
- **Runner per vector.** The per-vector tables for third parties have a Runner column: `ts` for the TypeScript CLI, `go` for `go/cmd/conformance`. `core/header-name-case-insensitive` is always `go` (Q52). The Targets section names the runner mode per row: `ts-in-process`, `ts-url`, `workerd-url` (a `wrangler dev --local` Worker) or `go-url`.

Two gates keep the file honest. `bun run test` renders the report from the committed results and compares it with the committed file, with no containers. The `services` CI job re-collects every row against live targets and compares both the results and the render. With both compose files up, `bun run report -- --update` regenerates the results and the report locally; see the README's [Cross-implementation report](../conformance/README.md#cross-implementation-report) section for the commands.

## Adding a vector

1. Decide the tier by D17. If the draft states the behavior, it is `core` and must carry a `draftRef` naming the draft section (for example `section-2.7`). If it is an anyonce choice the draft leaves open, it is `profile`, and it also needs an entry in [`conformance/DRAFT-GAPS.md`](../conformance/DRAFT-GAPS.md) with the proposed draft text. A core vector must never encode a profile choice, even temporarily (Q14).
2. Write `conformance/vectors/<tier>/<name>.json` against [`conformance/schema.json`](../conformance/schema.json) (JSON Schema 2020-12). The `id` is `<tier>/<name>`. Only core vectors may use `requires`.
3. Register the id in `CORE_IDS` or `PROFILE_IDS` in [`packages/conformance/test/catalog.ts`](../packages/conformance/test/catalog.ts), and in `BARE_PASS_IDS` there if it passes against a fixture with no idempotency layer.
4. Validate: `bun run vectors:validate`, then `bun test packages/conformance` and the Go runner's tests (`GOROOT= go test -C go ./conformance/...`). Both runners load the vectors from `conformance/vectors/` at run time, so neither needs a code change for a new vector.
5. Regenerate the golden report, because every row's counts change: bring up `test/compose.yml` and `conformance/third-party/compose.yml`, run `bun run report -- --update`, and commit `conformance/results/` and `conformance/REPORT.md` with the vector. A new third-party failure also needs an issue draft under `conformance/issues/`.
