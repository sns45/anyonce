> Unsent draft. Nothing here has been posted. Posting waits on the owner's go and on the in8.sh deploy of the case study (which itself follows the 0.1.0 release, Q80).

# Reddit drafts for anyonce

Claims source: the case study `content/anyonce/ARTICLE.md` in https://github.com/sns45/in8-home/pull/1, to be served at https://in8.sh/work/anyonce. Every number and claim below appears in that article. Re-read each subreddit's sidebar rules on the day of posting (self-promotion ratio, flair, whether project posts belong in a weekly thread) and adjust or skip the post if they have changed.

Links: no post body carries a link; the case study link goes in the author's first comment, with the tracked URL below. The repository link is untagged. Post one subreddit per day at most, never the same text twice.

- Tracked URL (first comment): `https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch`
- Repository: `https://github.com/sns45/anyonce`

Guardrails for every post and every reply in the thread: the 0.1.0 packages are published on npm with provenance and the Go module is tagged `go/v0.1.0` (say "on npm" and "go/v0.1.0", never "publishes with 0.1.0"); no standards action has been sent (say "drafted"); the atomic claim point is only ever stated in its narrowed form (both languages, byte identical statements, parity test), and quayside is named as the TypeScript project that already makes the one language guarantee; no stars, downloads or adoption claims.

---

## r/programming (technical craft)

**Title**

anyonce: one idempotency state machine behind HTTP, queue and webhook consumers, plus executable conformance vectors for the IETF Idempotency-Key draft

**Body**

Every way work reaches a backend delivers at least once: a client retries after losing the answer, a broker redelivers when a visibility timeout expires, a webhook sender posts again after a slow response. The usual fix is a lookup table keyed on the id, and it has a window: when the second copy arrives before the first has written its claim, both read "absent" and both run. The IETF `Idempotency-Key` header draft (draft 07, expired 18 April 2026, no 08) describes the HTTP side, but as of September 2026 no conformance vectors for it existed anywhere, so "implements the draft" meant whatever each author read into it.

anyonce claims each key in one conditional write per store, behind three doors (HTTP `Idempotency-Key`, anyq queue consumers, Standard Webhooks receivers) in TypeScript and Go. The SQL statements, Lua scripts and DynamoDB expressions exist once per language and a parity test compares them byte for byte; every store in both languages runs the same race of 50 concurrent claims, exactly one acquired, 20 iterations. The conformance suite is 20 JSON vectors (11 for what the draft requires, 9 for anyonce's own choices), and it only speaks HTTP, so it grades anything: hono-idempotency 0.9.1 passes 11 of 11 core vectors, idempo v1.0.0 passes 9, Fiber v3.5.0 passes 7. One of idempo's two misses is that it stores and replays a keyed GET, and that vector rests on a reading my own draft issue (gap G2) calls arguable and possibly mis-tiered. The trade I am least sure of: a 5xx releases the key instead of being replayed, which the draft's "success or an error" sentence does not obviously allow, and a handler that wrote to a database before returning 500 will run again on retry.

**First comment**

Author here. I also wrote anyq (the queue library the consumer door plugs into) and anyhook (an outbound webhook sender), and kept solving the same duplicate problem once per door, with rules that disagreed.

Two details that did not fit above. A claim holds the key for a lease, and every takeover of an expired lease increments a fence token, so a slow worker that finishes after a takeover has its write refused and every replay returns the takeover's result; no janitor is needed to free a stuck claim. And the run against three other implementations surfaced 17 places where the draft is silent, ambiguous or out of date, each written up with proposed text (for example, hono-idempotency and idempo both send the same unregistered `Idempotency-Replayed` header, and four of the draft's eight normative references are obsolete).

Case study with the landscape table, the diagrams and the honest scope: https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch

Repository: https://github.com/sns45/anyonce

It is 0.1.0, published on npm with provenance and as a tagged Go module. Question for anyone who runs this in production: do you replay a 500 to a retried request, or release the key? The three implementations I measured split three ways against a 201, a 404 and a 500.

---

## r/golang (language specific)

**Title**

anyonce: idempotency middleware for net/http, anyq consumers and Standard Webhooks receivers, in Go and TypeScript with one store contract

**Body**

Retries, redeliveries and webhook resends all mean the same handler can see the same work twice. In Go the existing options are one door each: idempo v1.0.0 for HTTP, Fiber's middleware (which uses `X-Idempotency-Key` and has no 422 on a changed payload), and Watermill's deduplicator on the consumer side. anyonce puts one state machine behind all three doors: `httpmw` wraps an `http.Handler`, `anyqmw` wraps an anyq consumer, and `webhookmw` verifies the Standard Webhooks signature and only then claims the `webhook-id`.

```go
mw := httpmw.New(postgres.New(db), httpmw.Options{Required: true})
log.Fatal(http.ListenAndServe(":8080", mw.Handler(routes())))
```

The part I would like Go eyes on is the store side. `begin` is one conditional write per store (Postgres, Redis, DynamoDB and memory among the five Go stores), and the SQL statements, Lua scripts and DynamoDB expressions are Go constants that a parity test compares byte for byte with the TypeScript copies. Every store runs the shared contract suite, including a race of 50 concurrent begins with exactly one acquired, and CI runs the Go suites with the race detector.

**First comment**

Author here. The module installs with `go get github.com/sns45/anyonce/go@v0.1.0`; it also runs from a clone, and `go run -C go ./cmd/fixture -idempotent -store memory` starts the reference fixture the conformance runner grades.

One pattern worth arguing about: a lease plus a fence token instead of a lock. A crashed worker's lease expires and the next request takes the key over with the fence incremented; a worker that was only slow completes afterwards with a stale fence and its write is refused.

Repository: https://github.com/sns45/anyonce
Case study: https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch

Is a fenced lease the approach you would reach for here, or would you rather have the middleware hold a store level lock for the handler's lifetime?

---

## r/typescript (language specific)

**Title**

anyonce: Hono middleware and withIdempotency for the IETF Idempotency-Key draft, sharing one engine with anyq consumers and Standard Webhooks receivers

**Body**

In TypeScript the idempotency libraries I found are HTTP first: hono-idempotency 0.9.1 (Hono only, passes all 11 core conformance vectors), idempot-js (draft 07), and quayside 1.4.0, which is the closest thing to what I wanted: a transport agnostic core with HTTP adapters and queue recipes, and five stores that pass one storage contract suite with an atomic create if absent claim and a 50 way race. anyonce adds the other doors as first class adapters (an anyq consumer middleware plus its strategy, and a Standard Webhooks receiver that verifies before it claims) and a Go implementation behind the same store contract.

```ts
import { MemoryStore } from '@anyonce/core';
import { idempotency } from '@anyonce/hono';
import { Hono } from 'hono';

const app = new Hono();
app.use('/orders', idempotency({ store: new MemoryStore() }));
```

A retry of a completed request gets the stored answer with `Idempotency-Replayed: true`; a concurrent duplicate gets `409` with `Retry-After` set to the seconds left on the lease; the same key with a different body gets `422 fingerprint-mismatch`. Every error is an RFC 9457 problem with a stable `code`. For structured queue messages the default fingerprint is RFC 8785 canonical JSON.

**First comment**

Author here. Install with `bun add @anyonce/core @anyonce/hono hono`. It also runs from a clone with `bun install && bun run build && bun run test`.

Where I think it differs from quayside: the claim statement for each shared store is byte identical between the TypeScript and Go implementations, enforced by a parity test, and the same race runs against every backend in both languages. If you only need TypeScript over HTTP, quayside and hono-idempotency are both worth a look, and the case study's table says where each one stops.

Repository: https://github.com/sns45/anyonce
Case study: https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch

How do you type the replayed response in your handlers today: do you care that it came from the store, or should the middleware hide that completely?

---

## r/CloudFlare (web and platform)

**Title**

Idempotency on Workers without KV: why anyonce claims keys with one atomic write and ships no KV store

**Body**

A Hono app on Workers takes `POST /orders`, the mobile client times out and retries with the same `Idempotency-Key` while the first request is still running. With a store that is eventually consistent across locations, two Workers can both read "absent" and both write, and the order is created twice. hono-idempotency's own author documents that its KV store is not atomic across edge locations. anyonce claims every key with one conditional write in a store that can do that atomically, and there is no Cloudflare KV store, by design.

The Hono middleware answers a completed duplicate from the store, a concurrent one with `409` and `Retry-After`, and a changed payload under the same key with `422`. The store contract suite runs under workerd in CI. One Workers specific caveat, stated in the case study: a client that disconnects mid response can leave the record in flight until the lease expires, and a retry after that runs the handler again. A `waitUntil` hook is on the list after the 0.1.0 release.

**First comment**

Author here. The case study has the full trade off and the landscape: https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch

Repository: https://github.com/sns45/anyonce (0.1.0, published on npm and as a tagged Go module).

For those running idempotency on Workers today: which store do you claim keys in, and have you hit the double write window with KV in practice?

---

## r/serverless (platform and infra)

**Title**

anyonce: one idempotency layer for HTTP, queue consumers and webhook receivers, in TypeScript and Go, with a conformance suite for the IETF draft

**Body**

In a serverless system the same work arrives through several doors, and each one delivers at least once: a function URL behind a retrying client, a queue consumer whose visibility timeout expired, a webhook receiver that answered too slowly. Powertools for AWS Lambda's idempotency utility is the nearest prior art on the consumer side and covers any Lambda event source, but it is Lambda only, has no Go, no draft header semantics and no conformance suite. anyonce applies one state machine and one store contract to HTTP, anyq consumers and Standard Webhooks receivers, in TypeScript and Go.

Operationally: a claim is one conditional write (a DynamoDB condition expression, one SQL statement, one Redis Lua script), so there is no read then write window. A crashed worker's lease expires and the next attempt takes over without a janitor. A 5xx releases the key so the retry can run. DynamoDB's 400 KB item limit caps a stored result there at 300 KiB. The in process overhead measured with the memory store is 0.008 ms p50 on a first execution against a 2 ms budget, on one machine, not a production load test.

**First comment**

Author here. Scope, stated plainly: the guarantee is at most one handler execution per key while the record is alive (24 hours by default), not exactly once side effects, and nothing has been load tested in production or run against live cloud accounts. CI runs the store suites against DynamoDB Local, Redis 7 and Postgres 16.

Case study: https://in8.sh/work/anyonce?utm_source=reddit&utm_medium=comment&utm_campaign=anyonce-launch
Repository: https://github.com/sns45/anyonce (0.1.0, published on npm and as a tagged Go module)

How long do you keep idempotency records in your functions, and has a TTL shorter than your retry window ever bitten you?
