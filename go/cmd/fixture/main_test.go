package main

import (
	"context"
	"net/http"
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/internal/servicetest"
)

// wiringVectors are the three vectors that prove -store really put a working store behind httpmw: a claim
// that runs the handler once, a replay of the stored result, and a fingerprint mismatch. Between them they
// exercise Begin, Complete and Get on the store under test.
//
// This is deliberately not the whole suite. Proving every vector against every store is the store packages'
// own job (go/store/*/...) and the URL-mode runner's (packages/conformance/test/cli-go.test.ts); repeating
// it here bought nothing and cost `go test -race ./...` three extra full suite runs, two of which sit in the
// vectors' own 2500 ms expiry and 1500 ms concurrency waits.
var wiringVectors = []string{
	"core/post-executes-once",
	"core/retry-replays",
	"core/mismatch-422",
}

// runWiringSuite wires store behind httpmw exactly as main does with -idempotent and runs wiringVectors
// against it, failing the test unless every one of them passes.
func runWiringSuite(t *testing.T, store anyonce.Store) {
	t.Helper()
	f := fixture.New()
	mw := httpmw.New(store, httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: 2 * time.Second}})
	mux := http.NewServeMux()
	mux.Handle("POST /reset", f.Handler())
	mux.Handle("/", mw.Handler(f.Handler()))
	summary := conformance.Run(t, mux, conformance.Options{Only: wiringVectors})
	if summary.Passed != len(wiringVectors) || len(summary.Results) != len(wiringVectors) {
		t.Fatalf("passed %d of %d results, want %d", summary.Passed, len(summary.Results), len(wiringVectors))
	}
}

func TestNewStore(t *testing.T) {
	t.Run("REQ-CONF-8: -store memory serves the fixture behind httpmw", func(t *testing.T) {
		store, cleanup, err := newStore(context.Background(), "memory")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runWiringSuite(t, store)
	})

	t.Run("REQ-CONF-8: an empty -store name also builds the memory store", func(t *testing.T) {
		store, cleanup, err := newStore(context.Background(), "")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runWiringSuite(t, store)
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
		runWiringSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store redis builds a working store behind httpmw", func(t *testing.T) {
		servicetest.Require(t, "redis", "127.0.0.1:6379")
		store, cleanup, err := newStore(context.Background(), "redis")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runWiringSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store postgres builds a working store behind httpmw", func(t *testing.T) {
		servicetest.Require(t, "postgres", "127.0.0.1:15432")
		store, cleanup, err := newStore(context.Background(), "postgres")
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		runWiringSuite(t, store)
	})

	t.Run("REQ-CONF-8: -store sqlite builds a working store behind httpmw and removes every temp file on cleanup", func(t *testing.T) {
		// os.CreateTemp("") resolves through os.TempDir(), which reads TMPDIR on every call, so pointing TMPDIR
		// at this test's own directory isolates the assertion from anything else writing to the shared temp
		// directory (packages/conformance/test/cli-go.test.ts creates "anyonce-fixture-*" entries there too).
		dir := t.TempDir()
		t.Setenv("TMPDIR", dir)
		// The glob covers the WAL sidecars as well as the database file. Matching only "*.db" would pass while
		// leaking "<name>.db-wal" and "<name>.db-shm", which is what journal_mode(WAL) actually writes.
		snapshot := func() []string {
			t.Helper()
			names, err := filepath.Glob(filepath.Join(dir, "*"))
			if err != nil {
				t.Fatal(err)
			}
			sort.Strings(names)
			return names
		}
		before := snapshot()
		if len(before) != 0 {
			t.Fatalf("the isolated temp directory is not empty: %v", before)
		}

		store, cleanup, err := newStore(context.Background(), "sqlite")
		if err != nil {
			t.Fatal(err)
		}
		runWiringSuite(t, store)

		during := snapshot()
		if len(during) == 0 {
			t.Fatal("expected the sqlite store to create at least one temp file")
		}

		cleanup()

		after := snapshot()
		if !slices.Equal(after, before) {
			t.Fatalf("temp files left behind by cleanup: %v (the store had created %v)", after, during)
		}
	})
}
