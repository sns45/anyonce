This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/gofiber/fiber` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

Title: A duplicate arriving while the original is in flight blocks until the original finishes and then replays it, instead of returning 409

Repository: https://github.com/gofiber/fiber (package `middleware/idempotency`)

Version: fiber v3.5.0 (`github.com/gofiber/fiber/v3@v3.5.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/concurrent-409`. A POST holds the handler for 1500 ms; a second POST with the same key is sent 300 ms later while the first is still running. The vector asserts that the second is answered 409 and that the handler runs exactly once.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, section 2.6 (Idempotency Enforcement), the "Concurrent Request" case, quoted verbatim:

> The request was retried before the original request completed. The resource SHOULD respond with a resource conflict error. See Error Scenarios for details.

and section 2.7 (Error Handling), which says what that error is:

> If the request is retried, while the original request is still being processed, the resource SHOULD reply with an HTTP 409 status code with body containing problem description.

The draft is cited here because `middleware/idempotency/idempotency.go` cites it itself, in the file's opening comment:

```go
// Inspired by https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-02
```

Observed: the duplicate does not fail and does not run the handler a second time. It blocks for the remainder of the original's work and then returns the original's response, 200 with the original body. Measured, it waited 1.193 s, which is the 1500 ms handler minus the 300 ms head start.

```
$ curl -s -o /dev/null -X POST 'http://127.0.0.1:13003/slow?ms=1500' -H 'Idempotency-Key: k-concurrent-1' -H 'Content-Type: text/plain' --data-binary 'slow' &
$ sleep 0.3
$ curl -s -i -X POST 'http://127.0.0.1:13003/slow?ms=1500' -H 'Idempotency-Key: k-concurrent-1' -H 'Content-Type: text/plain' --data-binary 'slow'
HTTP/1.1 200 OK
Date: Sat, 19 Sep 2026 06:56:49 GMT
Content-Type: text/plain
Content-Length: 10

slept:1500

$ curl -s -i http://127.0.0.1:13003/counter
HTTP/1.1 200 OK
Date: Sat, 19 Sep 2026 06:56:49 GMT
Content-Type: application/json; charset=utf-8
Content-Length: 11

{"count":1}
```

and the same pair timed:

```
$ curl -s -o /dev/null -w 'status=%{http_code} time_total=%{time_total}s\n' -X POST 'http://127.0.0.1:13003/slow?ms=1500' -H 'Idempotency-Key: k-timing-1' -H 'Content-Type: text/plain' --data-binary 'slow'
status=200 time_total=1.193264s
```

The source explains it exactly. `New`'s handler takes `cfg.Lock.Lock(key)`, checks storage a second time under the lock, and only then calls `c.Next()`. The duplicate therefore parks in `Lock`, and when the original releases it the second storage check hits and `maybeWriteCachedResponse` writes the stored result. The at most once property, which is the part that actually protects the caller's side effects, holds: the counter is 1.

Expected: the vector asserts `status: 409` with `handlerInvocations: 1`. The handler count is already right; only the status differs.

We want to be fair about this one, because Fiber's choice is defensible and in many deployments it is the nicer behavior. A client that retried on a timeout gets the answer it wanted rather than an error it has to interpret, with no extra round trip. That is a real benefit and it is why some deployed implementations do the same. But there are costs that a 409 does not have, and they are the reason the draft picks the other side. The duplicate holds a connection and a goroutine for the full remaining duration of the original, so a slow handler plus an aggressive retry policy multiplies in flight requests instead of shedding them. The caller gets no signal that its retry was premature, and no `Retry-After` style hint about when to come back. And if the original exceeds the client's own timeout, the client times out on the duplicate too and retries again, which is the failure mode the 409 exists to break.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13003 --only core/concurrent-409 --capability short-ttl --ttl-ms 2000 --report markdown
# | core/concurrent-409 | core | fail | duplicate: status: expected 409, got 200 |

# and by hand:
curl -s -o /dev/null -X POST http://127.0.0.1:13003/reset
curl -s -o /dev/null -X POST 'http://127.0.0.1:13003/slow?ms=1500' -H 'Idempotency-Key: k-concurrent-1' -H 'Content-Type: text/plain' --data-binary 'slow' &
sleep 0.3
curl -s -i -X POST 'http://127.0.0.1:13003/slow?ms=1500' -H 'Idempotency-Key: k-concurrent-1' -H 'Content-Type: text/plain' --data-binary 'slow'
wait
curl -s -i http://127.0.0.1:13003/counter
```

Fixture: `conformance/third-party/fiber/`. It mounts the anyonce fixture contract (`conformance/README.md`) behind `idempotency.New(...)`, with `POST /reset` registered before the middleware so the one control endpoint sits outside the layer. `POST /slow?ms=N` is the contract's own endpoint: it sleeps N ms and returns `slept:N`. Three options are set, and two of them depart from Fiber's own defaults:

- `Lifetime: 2 * time.Second`, so the row can declare the suite's `short-ttl` capability. A value, not a behavior change, and comfortably longer than the 1500 ms this vector needs.
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

`Lock` and `Storage` are both left at their defaults (`NewMemoryLock()` and the internal memory storage), so what this vector sees is the middleware's own concurrency behavior and not something the fixture arranged.

Suggested fix: this is smaller than it might look, because the `Locker` interface already has the shape needed. Adding a `TryLock(key string) (bool, error)` to `Locker`, or a `ConflictOnConcurrent bool` on `Config` that makes the handler attempt a non blocking acquire and answer `fiber.NewError(fiber.StatusConflict, ...)` when it cannot get the lock, would give callers the draft's behavior without taking today's away. `NewMemoryLock` is backed by per key mutexes and could grow a non blocking path straightforwardly; a distributed `Locker` implementation would need its own, which is the part that makes this an interface change rather than a pure addition, so a default method or a type assertion for an optional `TryLocker` is probably the kinder migration.

We would not argue for changing the default. Blocking is a legitimate profile choice and switching it would surprise existing users. What would help most is an option plus a sentence in the package docs saying that a concurrent duplicate waits rather than conflicting, so that someone reading the draft citation in the file header knows which of the two enforcement cases the middleware implements. If you do add the 409, `Retry-After` on it is worth considering: the draft does not mention one, which is a gap we have written up separately, but it is what makes the status actionable for a client.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. If a vector looks wrong to you, that is genuinely useful feedback and we would rather fix the vector than be right about it.
