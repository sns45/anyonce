# Third-party fixture containers

Three small fixture apps, one per third-party idempotency implementation, each mounting the
`conformance/README.md` fixture contract behind that implementation's own middleware or store.
They exist so `bunx @anyonce/conformance` and `go/cmd/conformance` can run the same vectors
against someone else's code, for the P5 cross-implementation report (`conformance/REPORT.md`).

None of these three directories is a Bun workspace package. They are built only inside their
containers, from their own committed lockfiles (`package-lock.json`, `go.sum`), and are never
installed into the root `bun.lock`.

The rule that governs every fixture here, stated once: a fixture never works around the
implementation under test. No retries, no key rewriting, no status translation, no per-vector
special casing. If the vectors show the implementation behaving one way, the fixture reports
that behavior; it does not paper over it.

## hono-idempotency

Package `hono-idempotency` 0.9.1, run with `hono` 4.13.8, `hono-problem-details` 0.11.0 and
`@hono/node-server` 2.1.1, on `node:22.23.2-alpine`.

The fixture registers `POST /reset` before mounting the middleware, so the control endpoint
stays outside the idempotency layer as the fixture contract requires. The middleware is
configured with `memoryStore({ ttl: 2000, sweepInterval: 500 })` so the row can declare the
`short-ttl` capability, `headerName: 'Idempotency-Key'` (already the library default; named here
for clarity), `required: true` so a missing key is rejected, `methods: ['POST', 'PUT', 'PATCH',
'DELETE']` so `GET /counter` is never subject to the layer, and `dangerouslyAllowGlobalKeys: true`
because this fixture intentionally has no per-route scoping to defeat: every vector's key space is
shared across the whole app on purpose, as the fixture contract lists a single flat set of routes.

## idempo

Module `github.com/eben-vranken/idempo` v1.0.0, on `golang:1.26.8-alpine3.24`.

The fixture builds `inmem.New(2*time.Second, 2*time.Second)` (the in-memory store lives at
`github.com/eben-vranken/idempo/inmem`, with no `store/` path segment) and wraps the contract
handlers in `idempo.New(store, idempo.Options{})`, taking every option at its default. `POST
/reset` is served by an outer `http.ServeMux` route that never passes through `mw.Handler`, again
keeping the control endpoint outside the layer.

## fiber

Package `github.com/gofiber/fiber/v3/middleware/idempotency` at fiber v3.5.0, on
`golang:1.26.8-alpine3.24`.

Two of the middleware's defaults are overridden, and both overrides are findings against the
draft, not fixture workarounds, per Q53 in `docs/superpowers/questions.md`:

- The default `KeyHeader` is `X-Idempotency-Key`, not `Idempotency-Key`, the field name the draft
  defines. The fixture sets `KeyHeader: "Idempotency-Key"` so the middleware is even reachable by
  the vectors, which all target the draft's header name. Left on its default, every vector would
  simply never find a key.
- The default `KeyHeaderValidate` rejects any key that is not exactly 36 characters, returning a
  bare `error` that Fiber's default error handler turns into an HTTP 500. The vectors use keys of
  varied length and shape by design (that is what several of them test), so on the default
  validator every one of them would 500 before the middleware's idempotency logic ever runs, and
  the run would measure the fixture's rejection path instead of the middleware. The fixture
  installs `KeyHeaderValidate: func(string) error { return nil }`, a permissive validator that
  accepts every key and adds no check the vectors' target does not already need.

Both defaults are reported as findings in the Fiber issue drafts under `conformance/issues/`
instead of being silently hidden: the non-draft header name is a draft-conformance gap, and the
500-in-place-of-400 is an error-handling gap against draft section 2.7, which asks for 400 on an
invalid key.

## Running one by hand

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait --build hono-idempotency
bun run conformance -- --url http://127.0.0.1:13001 --tier core --report markdown
```

Substitute `idempo` (port 13002) or `fiber` (port 13003) for the other two rows. Bring everything
up at once with `docker compose -f conformance/third-party/compose.yml up -d --wait --build` and
tear it down with `docker compose -f conformance/third-party/compose.yml down -v`.

Health checks poll `GET /counter` over `http://127.0.0.1:3000`, never `localhost`: the alpine
images resolve `localhost` to `::1` first, the apps bind IPv4 only, and busybox `wget` does not
fall back to IPv4 on its own, so a `localhost` health check reports unhealthy against a working
app.

## Adding a fourth implementation

Add a directory here with its own `Dockerfile` and pinned lockfile, mount the fixture contract
behind the new implementation with its options at their documented defaults except where the
contract forces an override (and say why, as above), add a service to `compose.yml` with the next
free host port in the 1300x range, and add a row to `scripts/report/rows.ts` (P5 Task 4).
