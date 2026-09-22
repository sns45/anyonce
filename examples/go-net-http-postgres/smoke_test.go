package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
)

// testDSN is the Postgres from test/compose.yml.
const testDSN = "postgres://anyonce:anyonce@127.0.0.1:15432/anyonce?sslmode=disable"

// requirePostgres skips when Postgres is down, unless ANYONCE_REQUIRE_SERVICES is set (CI sets it), in which
// case it fails. It mirrors go/store/internal/servicetest, which this module cannot import.
func requirePostgres(t *testing.T) anyonce.Store {
	t.Helper()
	const addr = "127.0.0.1:15432"
	conn, err := net.DialTimeout("tcp", addr, 1500*time.Millisecond)
	if err != nil {
		if os.Getenv("ANYONCE_REQUIRE_SERVICES") != "" {
			t.Fatalf("postgres is required but %s is not reachable: %v", addr, err)
		}
		t.Skipf("postgres not reachable on %s; run docker compose -f test/compose.yml up -d --wait postgres", addr)
	}
	_ = conn.Close()
	store, err := openStore(context.Background(), testDSN)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func postOrder(t *testing.T, url, key, payload string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url+"/orders", strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, body
}

func TestREQ_DOC_7_GoNetHTTPPostgresReplaysACompletedPost(t *testing.T) {
	store := requirePostgres(t)
	srv := httptest.NewServer(newHandler(store))
	defer srv.Close()
	// The records outlive the test in Postgres, so each run uses a key of its own.
	key := fmt.Sprintf("order-readme-%d", time.Now().UnixNano())

	first, firstBody := postOrder(t, srv.URL, key, `{"item":"book"}`)
	if first.StatusCode != http.StatusCreated || first.Header.Get("Idempotency-Replayed") != "" {
		t.Fatalf("first: %d %q %s", first.StatusCode, first.Header.Get("Idempotency-Replayed"), firstBody)
	}
	var created order
	if err := json.Unmarshal(firstBody, &created); err != nil || created.Item != "book" || created.ID == "" {
		t.Fatalf("first body %s: %v", firstBody, err)
	}

	second, secondBody := postOrder(t, srv.URL, key, `{"item":"book"}`)
	if second.StatusCode != http.StatusCreated || second.Header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("second: %d %q", second.StatusCode, second.Header.Get("Idempotency-Replayed"))
	}
	if string(secondBody) != string(firstBody) {
		t.Fatalf("replay body %s, want %s", secondBody, firstBody)
	}

	changed, changedBody := postOrder(t, srv.URL, key, `{"item":"lamp"}`)
	if changed.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(changedBody), `"code":"fingerprint-mismatch"`) {
		t.Fatalf("changed: %d %s", changed.StatusCode, changedBody)
	}
}

func TestREQ_DOC_7_GoNetHTTPPostgresPassesConformance(t *testing.T) {
	store := requirePostgres(t)
	f := fixture.New()
	mux := http.NewServeMux()
	// POST /reset is the runner's control path and stays outside the middleware.
	mux.Handle("POST /reset", f.Handler())
	// The fixture routes behind the example's own middleware configuration. Only the TTL differs, so the
	// short-ttl vector can prove expiry inside the test's time budget.
	mux.Handle("/", httpmw.New(store, options(2*time.Second)).Handler(f.Handler()))
	summary := conformance.Run(t, mux, conformance.Options{
		Tiers:        []string{"core", "profile"},
		Capabilities: []string{"short-ttl"},
	})
	if summary.Passed != 20 || len(summary.Results) != 20 {
		t.Fatalf("passed %d of %d", summary.Passed, len(summary.Results))
	}
}
