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
