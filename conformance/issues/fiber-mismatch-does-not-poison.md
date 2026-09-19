This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/gofiber/fiber` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

This report is a companion to `fiber-mismatch-422.md` and has the same single root cause. It is written separately only because the suite keeps one file per vector. If you read the other one, the new information here is in the Observed section: the property this vector was built to protect actually holds on Fiber, and that is worth recording.

Title: A key reused with a different body is not rejected, so the recovery step this vector measures cannot be exercised

Repository: https://github.com/gofiber/fiber (package `middleware/idempotency`)

Version: fiber v3.5.0 (`github.com/gofiber/fiber/v3@v3.5.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/mismatch-does-not-poison`. Three steps: a first POST with `payload-a` gets 201, a second POST reusing the key with `payload-b` is expected to be rejected 422, and a third POST with the original `payload-a` must still replay the original response with the handler never having run a second time. It exists to catch an implementation that reacts to a rejected mismatch by evicting, overwriting or locking the original record, so the client's corrected retry then executes twice or returns the wrong thing.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, section 2.7 (Error Handling) for the rejection, quoted verbatim:

> If there is an attempt to reuse an idempotency key with a different request payload, the resource SHOULD reply with a HTTP 422 status code with body containing a link pointing to relevant documentation. [...]

and section 2.6 (Idempotency Enforcement) for what the corrected retry must still get, quoted verbatim:

> The request was retried after the original request completed. The resource SHOULD respond with the result of the previously completed operation, success or an error. [...]

Observed: step two returns 201 with the first request's body rather than 422, which is the single failure the runner reports. Step three passes: the corrected retry replays the original response byte for byte and the counter is still 1, so nothing was poisoned.

```
$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:39 GMT
Content-Type: text/plain
Content-Length: 9

payload-a

$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-b'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:39 GMT
Content-Type: text/plain
Content-Length: 9

payload-a

$ curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
HTTP/1.1 201 Created
Date: Sat, 19 Sep 2026 06:56:39 GMT
Content-Type: text/plain
Content-Length: 9

payload-a

$ curl -s -i http://127.0.0.1:13003/counter
HTTP/1.1 200 OK
Date: Sat, 19 Sep 2026 06:56:39 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 11

{"count":1}
```

Say plainly what that means. The record survived intact across all three requests, which is the good half of this result and is not an accident: `middleware/idempotency` writes to `cfg.Storage` exactly once, on the first miss, and every later hit is a pure read, so there is no code path that could corrupt an existing entry. The only reason the vector is red is the missing rejection in step two, which is the subject of `fiber-mismatch-422.md`. The failure detail the runner prints says so directly: `changed: status: expected 422, got 201`, with no complaint about step three.

Expected: 422 on step two, then a byte identical replay of step one on step three with `handlerInvocations: 1`. Fiber satisfies the second half today. Fixing the 422 is what would make the whole vector pass, and the useful thing this report adds is that the fix would not have to protect anything: the "does not poison" behavior is already there and would come along for free.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13003 --only core/mismatch-does-not-poison --capability short-ttl --ttl-ms 2000 --report markdown
# | core/mismatch-does-not-poison | core | fail | changed: status: expected 422, got 201 |

# and by hand. Lifetime is 2 s in the fixture, so send the three POSTs in quick succession:
curl -s -o /dev/null -X POST http://127.0.0.1:13003/reset
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-b'
curl -s -i -X POST http://127.0.0.1:13003/echo -H 'Idempotency-Key: k-poison-1' -H 'Content-Type: text/plain' --data-binary 'payload-a'
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

Neither override touches storage or replay, so neither can account for what this vector sees.

Suggested fix: nothing separate from `fiber-mismatch-422.md`. Implement the payload comparison described there and this vector turns green on its own, because the record durability half is already correct. If the comparison does get implemented, the one thing worth writing a test for is exactly what this vector checks: that rejecting a mismatch is a read only decision which leaves the stored entry, and its lifetime, untouched, so a client that follows the draft's advice and corrects its request still receives the original result. It would be easy to implement the 422 as part of a write path and accidentally refresh or evict the entry, and this is the vector that would catch it.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. If a vector looks wrong to you, that is genuinely useful feedback and we would rather fix the vector than be right about it.
