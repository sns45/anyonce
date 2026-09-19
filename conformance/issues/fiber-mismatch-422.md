This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/gofiber/fiber` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

Title: A key reused with a different request body replays the first response instead of returning 422

Repository: https://github.com/gofiber/fiber (package `middleware/idempotency`)

Version: fiber v3.5.0 (`github.com/gofiber/fiber/v3@v3.5.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/mismatch-422`. It asserts that a second POST reusing a key with a different payload is answered 422 and that the handler is not run again.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, sections 2.2 and 2.7. Quoted verbatim, section 2.2 (Uniqueness of Idempotency Key):

> The idempotency key MUST be unique and MUST NOT be reused with another request with a different request payload.

and section 2.7 (Error Handling):

> If there is an attempt to reuse an idempotency key with a different request payload, the resource SHOULD reply with a HTTP 422 status code with body containing a link pointing to relevant documentation. The status code 422 is defined in Section 15.5.21 of [RFC9110].

Note where the obligation falls. The MUST NOT in 2.2 is on the client; the SHOULD in 2.7 is on the resource, and it is the resource side this vector measures. The draft is cited here because `middleware/idempotency/idempotency.go` cites it itself, in the file's opening comment:

```go
// Inspired by https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-02
```

Observed: the second request, whose body is `payload-b`, receives 201 with a body of `payload-a`. The counter stays at 1, so the handler was not run again, but the caller is handed a response that describes a request it did not make.

```
$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-mismatch-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:25 GMT
Content-Type: text/plain
Content-Length: 9

payload-a

$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-mismatch-1' -H 'Content-Type: text/plain' --data-binary 'payload-b'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:25 GMT
Content-Type: text/plain
Content-Length: 9

payload-a

$ curl -s -i http://127.0.0.1:13003/counter
HTTP/1.1 200 OK
Date: Sat, 19 Sep 2026 06:56:25 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 11

{"count":1}
```

This follows directly from the middleware's design, which is worth stating plainly because it is not a bug: `middleware/idempotency` is a response cache keyed on the key alone. It looks the key up in `cfg.Storage` and, on a hit, writes back the stored status, headers and body without ever consulting the current request. The stored `response` struct carries `StatusCode`, `Body` and `Headers` and nothing derived from the request, and no fingerprint, digest or checksum of the payload is computed anywhere in the package. There is no code that could notice the bodies differ.

Expected: the draft asks for 422 when a key is reused with a different payload, so the vector asserts `status: 422` on the second step with `handlerInvocations: 1`. The specific consequence the vector is guarding against is the one visible above: a caller that reuses a key by mistake, or a client library that generates keys per session rather than per request, silently receives another request's result and has no way to tell.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13003 --only core/mismatch-422 --capability short-ttl --ttl-ms 2000 --report markdown
# | core/mismatch-422 | core | fail | changed: status: expected 422, got 201 |

# and by hand. Lifetime is 2 s in the fixture, so send the two POSTs in quick succession:
curl -s -o /dev/null -X POST http://127.0.0.1:13003/reset
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-mismatch-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-mismatch-1' -H 'Content-Type: text/plain' --data-binary 'payload-b'
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

Neither override touches storage, locking or replay, so they cannot account for what this vector sees.

Suggested fix: this one is a design change rather than a patch, and we want to be straight about that. Detecting the mismatch means storing something derived from the request next to the response and comparing it on a hit, which means a new field on the msgp encoded `response` struct (a storage format change, so old entries need a version tag or a key prefix bump), reading and rewinding the request body before `c.Next()` rather than only touching the response afterwards, and a decision about what exactly goes into the fingerprint. That last one is the real cost: a generic middleware cannot know whether the method, the path, the query, the body, a subset of fields or the authenticated principal should be in scope, so it almost certainly needs a `Fingerprint func(fiber.Ctx) ([]byte, error)` config hook with a sensible default (method plus path plus body is what both anyonce and idempo use) and a documented answer for what happens when it returns an error.

If that is more than the middleware wants to take on, the smaller and still valuable version is documentation: say in the package doc that the middleware caches by key alone, does not detect payload reuse, and is therefore safe only when the caller guarantees one key per distinct request. That sentence would have saved us a run, and it would let users decide knowingly. It would also be worth reconsidering the draft citation in the file header, since a reader who follows that link will reasonably expect 422 to be implemented.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. If a vector looks wrong to you, that is genuinely useful feedback and we would rather fix the vector than be right about it.
