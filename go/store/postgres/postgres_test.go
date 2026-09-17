package postgres_test

import (
	"context"
	"database/sql"
	"net/http"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/internal/servicetest"
	"github.com/sns45/anyonce/go/store/postgres"
	"github.com/sns45/anyonce/go/storetest"
)

const dsn = "postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable"

func TestPostgresStore(t *testing.T) {
	servicetest.Require(t, "postgres", "127.0.0.1:15432")
	ctx := context.Background()

	store, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}

	storetest.Run(t, "postgres", func(*testing.T) storetest.Harness {
		return storetest.Harness{Store: store, PhysicallyRemove: store.PhysicallyRemove}
	})

	t.Run("REQ-ST-PG-1: EnsureSchema is idempotent and creates the expires_at index", func(t *testing.T) {
		db, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		if err := postgres.EnsureSchema(ctx, db); err != nil {
			t.Fatalf("first ensure schema: %v", err)
		}
		if err := postgres.EnsureSchema(ctx, db); err != nil {
			t.Fatalf("second ensure schema: %v", err)
		}
		rows, err := db.QueryContext(ctx, "SELECT indexname FROM pg_indexes WHERE tablename = 'anyonce_records' AND indexname = 'anyonce_records_expires_at'")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		if !rows.Next() {
			t.Fatal("expires_at index not found in pg_indexes")
		}
	})

	t.Run("REQ-ST-PG-1: every core and profile vector passes through httpmw with the Postgres store", func(t *testing.T) {
		f := fixture.New()
		mw := httpmw.New(store, httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
		if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
			t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
		}
	})
}
