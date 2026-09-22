# Benchmarks

`http-overhead.ts` measures NFR-1: how much `withIdempotency` (`@anyonce/core/http`) adds over a bare
fetch-shaped handler when the store is `MemoryStore` (`@anyonce/core`).

## Method

Everything runs in one process, one runtime, as sequential awaits, timed with `performance.now()` around
each call, including the read of the response body. A trivial handler reads the request body and returns
a fixed 201. Three paths are measured against the same handler:

- bare: the handler called directly, no adapter.
- first execution: the handler wrapped in `withIdempotency`, called with a fresh `Idempotency-Key` on
  every call, so every call is a first begin.
- replay: the handler wrapped in `withIdempotency`, called with one fixed key after a priming call, so
  every measured call replays the stored result.

The response body is read on every timed call, bare included, and not just for a fair comparison: the
wrapped response streams pull driven (`packages/core/src/http/capture.ts`), so the idempotency record
settles, moving out of `in_flight`, only once its body has been read. A call that skips this leaves the
record `in_flight` until its lease expires, so the next call under that key gets a 409 conflict instead of
a replay. An earlier version of this harness had exactly that bug. `measure()` also checks every wrapped response
against the path it was meant to take (a first execution comes back 201 with no `Idempotency-Replayed`
header, a replay comes back 201 with `Idempotency-Replayed: true`) and throws on a mismatch, so a
regression here fails the benchmark instead of silently timing the wrong thing.

Overhead is the wrapped path's p50 minus the bare path's p50, for each of the two wrapped paths. Every
call gets a fresh `Request` built from a fresh body; a consumed `Request` is never reused. See
[docs/superpowers/questions.md Q63](../docs/superpowers/questions.md) for why the measurement is shaped
this way, and NFR-1 in [requirements.md](../requirements.md) for the 2 ms p50 bound.

## Running it

```sh
bun run bench
```

This runs 20000 iterations per path after a 2000 iteration warmup, then rewrites the table between the
`<!-- bench:start -->` and `<!-- bench:end -->` markers in the root [README.md](../README.md). The
committed numbers are from the last time this was run; `benchmarks/http-overhead.test.ts` asserts they
are still under the NFR-1 bound and also runs a smaller, faster measurement of its own (2000 iterations,
200 warmup) so CI proves the bound on every run, not just the numbers committed here.
