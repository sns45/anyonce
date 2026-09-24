# go-net-http-postgres

A plain `net/http` service in Go. Its routes know nothing about idempotency: `httpmw` wraps the whole mux,
and the records live in Postgres (`store/postgres`), so a retried `POST` with the same `Idempotency-Key`
gets the stored response instead of creating a second order.

## What it shows

- [`app.go`](./app.go): `openStore` opens a `database/sql` pool on the pgx driver, applies the schema with
  `postgres.EnsureSchema` (safe on every start) and returns `postgres.New(db)`; `newHandler(store)` is the mux
  behind the middleware.
- [`main.go`](./main.go): reads `DATABASE_URL`, calls `openStore`, serves `newHandler(store)`, and closes
  the pool on the way out.

```go
db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
if err != nil {
	log.Fatal(err)
}
defer db.Close()
if err := postgres.EnsureSchema(ctx, db); err != nil {
	log.Fatal(err)
}
store := postgres.New(db)

mw := httpmw.New(store, httpmw.Options{Required: true})
log.Fatal(http.ListenAndServe("127.0.0.1:8080", mw.Handler(routes())))
```

`Required: true` makes a `POST` without the header a `400 missing-key` rather than an unprotected write.
The zero `Policy` keeps the defaults (24 hour TTL). The module is nested and uses a `replace` directive onto
[`../../go`](../../go), so it builds against this repository's code; outside the repository, drop the
`replace` and require a released `github.com/sns45/anyonce/go`.

## Run it locally

Postgres from the repository's compose file listens on `127.0.0.1:15432`. From the repository root:

```sh
docker compose -f test/compose.yml up -d --wait postgres
cd examples/go-net-http-postgres
DATABASE_URL='postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable' go run .
```

`DATABASE_URL` defaults to that compose DSN and `ADDR` to `127.0.0.1:8080`.

## Try it

POST the same order twice with one key:

```sh
curl -i -X POST http://127.0.0.1:8080/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' \
  -d '{"item":"book"}'
curl -i -X POST http://127.0.0.1:8080/orders \
  -H 'Idempotency-Key: order-1' -H 'Content-Type: application/json' \
  -d '{"item":"book"}'
```

The first response is `201` with a new order id. The second is the same `201` with the same id and
`Idempotency-Replayed: true`: the handler did not run again. The same key with a different body
(`{"item":"lamp"}`) is `422` with the `fingerprint-mismatch` problem. A body that is not JSON is `400`. The record lives in Postgres, so the same
key keeps replaying across a restart of the service until the TTL ends.

## Smoke test

[`smoke_test.go`](./smoke_test.go) runs the scenario above against `newHandler(store)`, then the Go
conformance runner's core and profile tiers against the conformance fixture routes behind the same
`httpmw` configuration on Postgres. With Postgres down it skips, unless `ANYONCE_REQUIRE_SERVICES=1` (as in
CI), which turns the skip into a failure:

```sh
go vet ./...
ANYONCE_REQUIRE_SERVICES=1 go test -race -count=1 ./...
```
