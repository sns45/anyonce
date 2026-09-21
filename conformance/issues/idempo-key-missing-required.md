This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/eben-vranken/idempo` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

Title: No way to require the Idempotency-Key header, so a missing key silently executes the handler

Repository: https://github.com/eben-vranken/idempo

Version: v1.0.0 (`github.com/eben-vranken/idempo@v1.0.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/key-missing-required`. It asserts that a POST to a route documented as requiring the header, sent with no `Idempotency-Key` at all, is answered 400 and that the handler does not run.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, section 2.7 (Error Handling). The normative sentence, quoted verbatim:

> If the Idempotency-Key request header is missing for a documented idempotent operation requiring this header, the resource SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation.

Observed: the request is passed straight to the handler, which runs, and the response is a normal 201. The counter confirms one execution.

```
$ curl -s -i -X POST http://127.0.0.1:13002/echo -H 'Content-Type: text/plain' --data-binary 'no key'
HTTP/1.1 201 Created
Content-Type: text/plain
Date: Sat, 19 Sep 2026 06:56:05 GMT
Content-Length: 6

no key

$ curl -s -i http://127.0.0.1:13002/counter
HTTP/1.1 200 OK
Content-Type: application/json
Date: Sat, 19 Sep 2026 06:56:05 GMT
Content-Length: 12

{"count":1}
```

This matches the shipped source. In `idempo.go`, `Handler` opens with:

```go
idemKey := r.Header.Get("Idempotency-Key")

if len(idemKey) == 0 {
    next.ServeHTTP(w, r)
    return
}
```

and `Options` carries `MaxBodyBytes`, `MaxResponseBytes`, `PersistentTimeout` and `Logger`, with no field that would let a caller ask for the header to be required. So this is not a bug in a code path; it is the absence of a knob.

Expected: for a route the resource documents as requiring the header, the draft asks for 400 and no execution. The vector therefore asserts `status: 400` and `handlerInvocations: 0`. It does not assert anything about the response body shape; that is graded in the `profile` tier only, and third party implementations are not graded on it.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13002 --only core/key-missing-required --capability short-ttl --ttl-ms 2000 --report markdown
# | core/key-missing-required | core | fail | missing: status: expected 400, got 201; missing: handlerInvocations: expected 0, got 1 |

# and by hand:
curl -s -o /dev/null -X POST http://127.0.0.1:13002/reset
curl -s -i -X POST http://127.0.0.1:13002/echo -H 'Content-Type: text/plain' --data-binary 'no key'
curl -s -i http://127.0.0.1:13002/counter
```

Fixture: `conformance/third-party/idempo/`. It is a small `net/http` app that mounts the anyonce fixture contract (`conformance/README.md`) behind `idempo.New(store, idempo.Options{})` with `inmem.New(2*time.Second, 2*time.Second)` as the store. Every `Options` field is left at its default; nothing is overridden, and the only route outside the middleware is the `POST /reset` counter control, which the contract requires to sit outside the layer. No retry, key rewriting or status translation happens anywhere in the fixture.

Suggested fix: add an option, something like `Required bool` or `RequireKey bool` on `Options`, that makes `Handler` answer 400 instead of calling `next` when the header is absent. idempo already has everything else it needs for that response: `writeProblem` renders RFC 9457 problem details with a documentation `type` URI, which is exactly the shape section 2.7 shows, so the new branch is a few lines next to the existing `len(idemKey) > maxKeyLen` branch. The harder part is not the code but the default: flipping today's pass through behavior to a rejection would break every existing caller that mounts the middleware broadly and sends keys on only some routes, so the option almost certainly has to default to false, and the honest fix is to add the option and document that resources which advertise the header as required should set it. A per route form (a `Next`-style predicate, or leaving the middleware mounted only on routes that require a key) would also work and may fit the library better. Either way it is a small addition rather than a redesign. For what it is worth, `hono-idempotency` solves this with a `required: true` flag and passes this vector with it set.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. If a vector looks wrong to you, that is genuinely useful feedback and we would rather fix the vector than be right about it.
