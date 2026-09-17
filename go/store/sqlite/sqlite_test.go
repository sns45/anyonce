package sqlite_test

import (
	"context"
	"database/sql"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/sqlite"
	"github.com/sns45/anyonce/go/storetest"
)

func TestSQLiteStore(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "anyonce.db")

	store, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}

	storetest.Run(t, "sqlite", func(*testing.T) storetest.Harness {
		return storetest.Harness{Store: store, PhysicallyRemove: store.PhysicallyRemove}
	})

	t.Run("REQ-ST-SQLITE-1: EnsureSchema applies the migration and is idempotent", func(t *testing.T) {
		ensurePath := filepath.Join(t.TempDir(), "ensure.db")
		db, err := sql.Open("sqlite", ensurePath+"?_pragma=busy_timeout(5000)")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = db.Close() })
		if err := sqlite.EnsureSchema(ctx, db); err != nil {
			t.Fatalf("first ensure schema: %v", err)
		}
		if err := sqlite.EnsureSchema(ctx, db); err != nil {
			t.Fatalf("second ensure schema: %v", err)
		}
		var name string
		row := db.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'anyonce_records_expires_at'")
		if err := row.Scan(&name); err != nil {
			t.Fatalf("expires_at index not found in sqlite_master: %v", err)
		}
	})

	t.Run("REQ-ST-SQLITE-1: every core and profile vector passes through httpmw with the SQLite store", func(t *testing.T) {
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
