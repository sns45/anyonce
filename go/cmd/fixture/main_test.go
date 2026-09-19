package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/internal/servicetest"
)

// runFullSuite wires store behind httpmw exactly as main does with -idempotent and runs every core and
// profile vector against it, failing the test unless all twenty pass.
func runFullSuite(t *testing.T, store anyonce.Store) {
	t.Helper()
	f := fixture.New()
	mw := httpmw.New(store, httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
	mux := http.NewServeMux()
	mux.Handle("POST /reset", f.Handler())
	mux.Handle("/", mw.Handler(f.Handler()))
	summary := conformance.Run(t, mux, conformance.Options{Capabilities: []string{"short-ttl"}})
	if summary.Passed != len(summary.Results) || len(summary.Results) != 20 {
		t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
	}
}

func TestNewStore(t *testing.T) {
	t.Run("REQ-CONF-8: -store memory serves the fixture behind httpmw", func(t *testing.T) {
		store, cleanup, err := newStore(context.Background(), "memory")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runFullSuite(t, store)
	})

	t.Run("REQ-CONF-8: an empty -store name also builds the memory store", func(t *testing.T) {
		store, cleanup, err := newStore(context.Background(), "")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runFullSuite(t, store)
	})

	t.Run("REQ-CONF-8: an unknown -store name is an error, never a silent fallback", func(t *testing.T) {
		_, _, err := newStore(context.Background(), "bogus")
		if err == nil {
			t.Fatal("expected an error for an unknown store name")
		}
	})

	t.Run("REQ-CONF-8: -store dynamodb builds a working store behind httpmw", func(t *testing.T) {
		servicetest.Require(t, "dynamodb", "127.0.0.1:18000")
		store, cleanup, err := newStore(context.Background(), "dynamodb")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runFullSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store redis builds a working store behind httpmw", func(t *testing.T) {
		servicetest.Require(t, "redis", "127.0.0.1:6379")
		store, cleanup, err := newStore(context.Background(), "redis")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runFullSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store postgres builds a working store behind httpmw", func(t *testing.T) {
		servicetest.Require(t, "postgres", "127.0.0.1:15432")
		store, cleanup, err := newStore(context.Background(), "postgres")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runFullSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store sqlite builds a working store behind httpmw and removes its temp file on cleanup", func(t *testing.T) {
		pattern := filepath.Join(os.TempDir(), "anyonce-fixture-*.db")
		before, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		store, cleanup, err := newStore(context.Background(), "sqlite")
		if err != nil {
			t.Fatal(err)
		}
		runFullSuite(t, store)

		during, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		if len(during) != len(before)+1 {
			t.Fatalf("expected exactly one new temp file, before %v during %v", before, during)
		}

		cleanup()

		after, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		if len(after) != len(before) {
			t.Fatalf("temp file not removed by cleanup: before %v after %v", before, after)
		}
	})
}
