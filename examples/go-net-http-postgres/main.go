// Command go-net-http-postgres is a net/http service whose POST routes run at most once per Idempotency-Key,
// with the records in Postgres. See README.md.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"
)

// defaultDSN is the Postgres from the repository's test/compose.yml.
const defaultDSN = "postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable"

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultDSN
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	store, err := openStore(context.Background(), dsn)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: addr, Handler: newHandler(store), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("listening on http://%s", addr)
	log.Fatal(srv.ListenAndServe())
}
