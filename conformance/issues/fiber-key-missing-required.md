This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/gofiber/fiber` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

Title: middleware/idempotency has no way to require the key header, so a request without one executes normally

Repository: https://github.com/gofiber/fiber (package `middleware/idempotency`)

Version: fiber v3.5.0 (`github.com/gofiber/fiber/v3@v3.5.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/key-missing-required`. It asserts that a POST to a route documented as requiring the header, sent with no `Idempotency-Key` at all, is answered 400 and that the handler does not run.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, section 2.7 (Error Handling). The normative sentence, quoted verbatim:

> If the Idempotency-Key request header is missing for a documented idempotent operation requiring this header, the resource SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation.

The draft is cited here because `middleware/idempotency/idempotency.go` cites it itself, in the file's opening comment:

```go
// Inspired by https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-02
```

Observed: the request goes to the handler, which runs, and the response is a normal 201.

```
$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Content-Type: text/plain' --data-binary 'no key'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:21 GMT
Content-Type: text/plain
Content-Length: 6

no key

$ curl -s -i http://127.0.0.1:13003/counter
HTTP/1.1 200 OK
Date: Sat, 19 Sep 2026 06:56:21 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 11

{"count":1}
```

That is exactly what the shipped source says it will do. `New` returns a handler whose second statement is:

```go
// Don't execute middleware if the idempotency key is empty
if c.Get(cfg.KeyHeader) == "" {
    return c.Next()
}
```

and `Config` offers `Lock`, `Storage`, `Next`, `KeyHeaderValidate`, `KeyHeader`, `KeepResponseHeaders`, `Lifetime` and `DisableValueRedaction`, none of which can express "this route requires a key". `Next` can only skip the middleware, never reject. So there is no misbehaving code path here; the option does not exist.

Expected: for a route the resource documents as requiring the header, the draft asks for 400 and no execution. The vector therefore asserts `status: 400` and `handlerInvocations: 0`, and nothing about the body shape, which is graded in the `profile` tier only and not applied to third party implementations.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13003 --only core/key-missing-required --capability short-ttl --ttl-ms 2000 --report markdown
# | core/key-missing-required | core | fail | missing: status: expected 400, got 201; missing: handlerInvocations: expected 0, got 1 |

# and by hand:
curl -s -o /dev/null -X POST http://127.0.0.1:13003/reset
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Content-Type: text/plain' --data-binary 'no key'
curl -s -i http://127.0.0.1:13003/counter
```

Fixture: `conformance/third-party/fiber/`. It mounts the anyonce fixture contract (`conformance/README.md`) behind `idempotency.New(...)`, with `POST /reset` registered before the middleware so the one control endpoint sits outside the layer. Three options are set, and two of them depart from Fiber's own defaults:

- `Lifetime: 2 * time.Second`, so the row can declare the suite's `short-ttl` capability. A value, not a behavior change.
- `KeyHeader: "Idempotency-Key"`. The default is `X-Idempotency-Key`, which is not the field name the draft defines. On the default the middleware never sees the vectors' key at all.
- `KeyHeaderValidate: func(string) error { return nil }`. The default rejects any key that is not exactly 36 characters by returning a bare `error`, and `fiber.DefaultErrorHandler` renders a non `*fiber.Error` as 500, not the 400 section 2.7 asks for.

Both departures are themselves findings and are reported rather than papered over. Observed against an untouched `idempotency.New()` with every option at its default, in the same container and the same Fiber build:

```
--- sent Idempotency-Key: k-mismatch-1 (the field the draft defines) ---
HTTP/1.1 201 Created
...
--- sent X-Idempotency-Key: k-mismatch-1 (Fiber's default field, 12 chars) ---
HTTP/1.1 500 Internal Server Error
Content-Type: text/plain; charset=utf-8

invalid idempotency key: invalid length: 12 != 36
```

So on stock defaults the draft's header is ignored entirely, and Fiber's own header with a non UUID key yields a 500. Note this makes the present report a little academic on the defaults: with `KeyHeader` at `X-Idempotency-Key`, `Idempotency-Key` is always "missing" as far as the middleware is concerned, so every request looks like this one.

Suggested fix: three separate, independently useful changes, in the order we would rank them.

First, default `KeyHeader` to `Idempotency-Key`. That is the field name the draft the file cites defines, and it is what every client library that follows the draft will send. This is a breaking change for anyone relying on the current default, so it probably belongs in a v4 with a release note, but the current default means a standards compliant client and stock Fiber never meet.

Second, make `KeyHeaderValidate` failures a 400. Returning `fiber.NewError(fiber.StatusBadRequest, ...)` instead of the bare error would do it, and it is a one line change with no config surface; a 500 tells a client to retry and a 400 tells it to fix the key, which is the difference that matters to a caller.

Third, and the actual subject of this report, add a `Required bool` (or `RequireKey bool`) to `Config` so a caller can ask for 400 instead of pass through when the header is absent. It has to default to false or it breaks every existing mount, so the honest framing is a new opt in plus a documentation line saying that resources which advertise the header as required should set it. The code is a branch next to the existing empty key check.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. If a vector looks wrong to you, that is genuinely useful feedback and we would rather fix the vector than be right about it.
