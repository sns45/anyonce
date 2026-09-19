This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/eben-vranken/idempo` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

Read this one as a question rather than a bug report. The draft is silent on what a key means on a safe method, so idempo is not failing to do something the draft tells it to do. What follows is an observation with a consequence, and a note about where anyonce's own choice is recorded as a draft gap rather than as a rule.

Title: An Idempotency-Key on a GET is stored and replayed, so a retried GET can return a stale body

Repository: https://github.com/eben-vranken/idempo

Version: v1.0.0 (`github.com/eben-vranken/idempo@v1.0.0`), running on the `golang:1.26.8-alpine3.24` base image.

Vector: `core/get-ignored`. It asserts that a key on a GET is ignored: two GETs of the same resource with the same key both execute, and the second returns the resource's current state rather than a replay of the first.

Draft section: `draft-ietf-httpapi-idempotency-key-header-07`, section 1 (Introduction). The sentence the vector rests on, quoted verbatim:

> An HTTP request method is considered idempotent if the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request. Per [RFC9110], the methods OPTIONS, HEAD, GET, PUT and DELETE are idempotent while methods POST and PATCH are not.

Note carefully what that is and is not. It is an observation about which methods are already idempotent, offered as motivation for the header. It is not a MUST, a SHOULD or a MAY about what a resource does when a key arrives on GET. On that exact question the draft says nothing at all, in section 1 or anywhere else, and anyonce records the silence as gap G2 in `conformance/DRAFT-GAPS.md` along with proposed text for a future revision.

Observed: the second GET with the same key does not execute. It returns the first GET's stored body, with `Idempotency-Replayed: true`, while a keyless GET taken immediately afterwards shows the true, different value.

```
$ curl -s -i http://127.0.0.1:13002/counter -H 'Idempotency-Key: k-get-1'
HTTP/1.1 200 OK
Content-Type: application/json
Date: Sat, 19 Sep 2026 06:56:13 GMT
Content-Length: 12

{"count":0}

$ curl -s -i -X POST http://127.0.0.1:13002/echo -H 'Idempotency-Key: k-get-2' -H 'Content-Type: text/plain' --data-binary 'x'
HTTP/1.1 201 Created
Content-Type: text/plain
Date: Sat, 19 Sep 2026 06:56:13 GMT
Content-Length: 1

x

$ curl -s -i http://127.0.0.1:13002/counter -H 'Idempotency-Key: k-get-1'
HTTP/1.1 200 OK
Content-Type: application/json
Idempotency-Replayed: true
Date: Sat, 19 Sep 2026 06:56:13 GMT
Content-Length: 12

{"count":0}

$ curl -s -i http://127.0.0.1:13002/counter
HTTP/1.1 200 OK
Content-Type: application/json
Date: Sat, 19 Sep 2026 06:56:13 GMT
Content-Length: 12

{"count":1}
```

The `Idempotency-Replayed: true` on the third response is the part worth looking at: it is idempo saying, correctly and explicitly, that the GET was served from the record rather than from the handler. The shipped source agrees. `Handler` never inspects `r.Method` to decide whether to engage, and the fingerprint it computes is `sha256(r.Method + "\n" + r.URL.Path + "\n" + body)`, so a GET with a key takes the same claim, store and replay path a POST does.

Expected: the vector asserts that after a POST has changed the resource, a second GET carrying the key used by an earlier GET reflects the change (`bodyJson: { count: 1 }`). That is anyonce's behavior and it is what the vector encodes, but it is a profile choice dressed in the draft's motivation, not a rule the draft states. The vector currently sits in the `core` tier on the strength of section 1's framing, which is arguable, and this report is the kind of evidence that would justify moving it or narrowing it.

Reproduction:

```sh
docker compose -f conformance/third-party/compose.yml up -d --wait

bun run conformance -- --url http://127.0.0.1:13002 --only core/get-ignored --capability short-ttl --ttl-ms 2000 --report markdown
# | core/get-ignored | core | fail | get-after: body.count: expected 1, got 0 |

# and by hand. The store TTL is 2000 ms, so run the four in quick succession:
curl -s -o /dev/null -X POST http://127.0.0.1:13002/reset
curl -s -i http://127.0.0.1:13002/counter -H 'Idempotency-Key: k-get-1'
curl -s -i -X POST http://127.0.0.1:13002/echo -H 'Idempotency-Key: k-get-2' -H 'Content-Type: text/plain' --data-binary 'x'
curl -s -i http://127.0.0.1:13002/counter -H 'Idempotency-Key: k-get-1'
curl -s -i http://127.0.0.1:13002/counter
```

Fixture: `conformance/third-party/idempo/`. It is a small `net/http` app that mounts the anyonce fixture contract (`conformance/README.md`) behind `idempo.New(store, idempo.Options{})` with `inmem.New(2*time.Second, 2*time.Second)` as the store. Every `Options` field is left at its default; nothing is overridden. `GET /counter` is deliberately mounted behind the middleware, because that is what makes this question askable at all; only `POST /reset` sits outside, as the contract requires of the one control endpoint. The two second TTL is the only thing configured away from a production value, and it exists so the expiry vector can be graded.

Suggested fix: the choice we would suggest, and the one anyonce makes, is to skip the middleware entirely for methods that RFC 9110 already defines as idempotent, or at minimum to store nothing for them. A key on a GET usually means a client library attaching the header uniformly to every request rather than a caller asking for replay, and with a long lived store the current behavior turns that into a cache with no cache headers, no validators and no way for the client to ask for a fresh read. If you would rather keep it, an opt in (`Methods []string`, or a `Next func(*http.Request) bool` predicate in the style Fiber uses) would let a caller choose, and it is a genuinely small change: one early return in `Handler` next to the existing empty key check. We would understand a decision to keep the current behavior and document it, since the draft does not settle the question; if you do, the useful thing for us to know is your reasoning, because it would go into the gap entry and into the draft text we plan to propose.

The vectors are meant as a shared asset rather than a scorecard, and anyone can run them against their own build with no anyonce dependency: `bunx @anyonce/conformance --url http://localhost:3000 --tier core --report markdown`. This vector in particular is one we would happily rewrite or retier if the discussion lands somewhere other than where we guessed.
