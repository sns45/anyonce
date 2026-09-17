package fixture_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

func do(t *testing.T, h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func counter(t *testing.T, h http.Handler) int {
	t.Helper()
	rec := do(t, h, http.MethodGet, "/counter", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("counter status = %d", rec.Code)
	}
	var out struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("counter body: %v", err)
	}
	return out.Count
}

func TestFixture(t *testing.T) {
	t.Run("REQ-CONF-2: POST /echo returns 201 with body and content type echoed and counts", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/echo", "hello", map[string]string{"Content-Type": "text/plain"})
		if rec.Code != http.StatusCreated || rec.Body.String() != "hello" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
		if ct := rec.Header().Get("Content-Type"); ct != "text/plain" {
			t.Fatalf("content type = %q", ct)
		}
		if n := counter(t, h); n != 1 {
			t.Fatalf("counter = %d, want 1", n)
		}
	})

	t.Run("REQ-CONF-2: POST /status/{code} returns that status with body status:{code} and counts", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/status/404", "s", nil)
		if rec.Code != 404 || rec.Body.String() != "status:404" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
		if rec500 := do(t, h, http.MethodPost, "/status/500", "s", nil); rec500.Code != 500 {
			t.Fatalf("got %d", rec500.Code)
		}
		if n := counter(t, h); n != 2 {
			t.Fatalf("counter = %d, want 2", n)
		}
	})

	t.Run("REQ-CONF-2: POST /status with a non-status code returns 400 and does not count", func(t *testing.T) {
		h := fixture.New().Handler()
		if rec := do(t, h, http.MethodPost, "/status/abc", "s", nil); rec.Code != http.StatusBadRequest {
			t.Fatalf("got %d", rec.Code)
		}
		if n := counter(t, h); n != 0 {
			t.Fatalf("counter = %d, want 0", n)
		}
	})

	t.Run("REQ-CONF-2: POST /slow?ms=N waits at least N ms then returns slept:N", func(t *testing.T) {
		h := fixture.New().Handler()
		start := time.Now()
		rec := do(t, h, http.MethodPost, "/slow?ms=120", "s", nil)
		if elapsed := time.Since(start); elapsed < 115*time.Millisecond {
			t.Fatalf("elapsed %v", elapsed)
		}
		if rec.Code != 200 || rec.Body.String() != "slept:120" {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
	})

	t.Run("REQ-CONF-2: POST /large?bytes=N returns exactly N bytes", func(t *testing.T) {
		h := fixture.New().Handler()
		rec := do(t, h, http.MethodPost, "/large?bytes=70000", "l", nil)
		body, _ := io.ReadAll(rec.Body)
		if rec.Code != 200 || len(body) != 70000 {
			t.Fatalf("got %d with %d bytes", rec.Code, len(body))
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
			t.Fatalf("content type = %q", ct)
		}
	})

	t.Run("REQ-CONF-2: POST /reset clears the counter and GET /counter reports it", func(t *testing.T) {
		h := fixture.New().Handler()
		do(t, h, http.MethodPost, "/echo", "a", nil)
		do(t, h, http.MethodPost, "/slow?ms=0", "a", nil)
		do(t, h, http.MethodPost, "/large?bytes=1", "a", nil)
		if n := counter(t, h); n != 3 {
			t.Fatalf("counter = %d, want 3", n)
		}
		if rec := do(t, h, http.MethodPost, "/reset", "", nil); rec.Code != http.StatusNoContent {
			t.Fatalf("reset = %d", rec.Code)
		}
		if n := counter(t, h); n != 0 {
			t.Fatalf("counter = %d, want 0", n)
		}
	})

	t.Run("REQ-CONF-2: the fixture has no idempotency layer, a repeated key executes again", func(t *testing.T) {
		h := fixture.New().Handler()
		hdr := map[string]string{"Idempotency-Key": "k"}
		do(t, h, http.MethodPost, "/echo", "a", hdr)
		second := do(t, h, http.MethodPost, "/echo", "a", hdr)
		if second.Header().Get("Idempotency-Replayed") != "" {
			t.Fatal("unexpected replay header")
		}
		if n := counter(t, h); n != 2 {
			t.Fatalf("counter = %d, want 2", n)
		}
	})
}
