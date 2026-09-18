# anyonce conformance suite

Executable vectors for `draft-ietf-httpapi-idempotency-key-header-07` (`docs/reference/draft-07.txt`). Any implementation in any language can run them: mount the fixture endpoints behind your idempotency layer and point the runner at the URL.

## Tiers

- `core`: behavior the draft states (MUST and SHOULD, header syntax, 400, 409, 422, replay of a completed result, single handler execution). Third-party implementations are graded on this tier only. Every core vector cites the draft section in `draftRef`.
- `profile`: anyonce's documented choices where the draft is silent (`Idempotency-Replayed`, `Retry-After` on 409, 4xx replayed, 5xx not stored, omitted-body replay above 1 MiB, the problem `code` member, the problem media type, the empty key rule, the 255-byte key limit). See `DRAFT-GAPS.md` for the proposed draft text behind each.

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

Reference apps with no idempotency layer: `fixtures/hono` (`bun run --filter @anyonce/fixture-hono start`) and `go/cmd/fixture` (`go run ./cmd/fixture`). Both print the listening address. `go run ./cmd/fixture -idempotent -ttl-ms 2000` serves the Go fixture behind `httpmw` with the memory store, which is what the P2 URL-mode test drives.

## Vector format (REQ-CONF-1)

`schema.json` (JSON Schema 2020-12) is the contract. A vector is `{ id, tier, title, draftRef?, description, requires?, fixture, steps }`; a step is `{ id, delayMs?, concurrentWith?, request: { method, path, headers?, body? }, expect: { status, headers?, bodyEquals?, bodyJson?, bodyBytes?, handlerInvocations? } }`.

Execution rules:

- The runner sends `POST /reset` before every vector.
- Steps run in order. A step named in a later step's `concurrentWith` is sent and left pending. A step with `concurrentWith` waits `delayMs`, is sent while those are pending, and the whole group is then awaited and checked together with one `GET /counter` read.
- `handlerInvocations` compares against `GET /counter` after the step (or its group) settles.
- `bodyEquals: { sameAs }` compares bytes with an earlier step's body.

## Capabilities

`requires: ["short-ttl"]` marks a vector that needs a TTL of at most 2000 ms on the target. Pass `capabilities: ['short-ttl']` (or `--capability short-ttl` on the CLI in P2) only when your target is configured that way. Otherwise the vector is reported as `not-applicable` and does not count as a pass or a fail.

One vector depends on the runner rather than the target: `core/header-name-case-insensitive` spells the field name in lowercase, and the TypeScript runner cannot vary that spelling because the `Headers` class lowercases every name it is given, so the vector only discriminates when it is run from the Go runner, and a CLI run is not a substitute for that.

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

## Adding a vector

1. Create `vectors/<tier>/<name>.json`; the `id` must be `<tier>/<name>`.
2. Core vectors must cite a `draftRef`; profile vectors must not use `requires`.
3. Add the id to `CORE_IDS` or `PROFILE_IDS` in `packages/conformance/test/catalog.ts`, and to `BARE_PASS_IDS` there if it passes without an idempotency layer.
4. Run `bun run vectors:validate` and `bun test packages/conformance`.

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
