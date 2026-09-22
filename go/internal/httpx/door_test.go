package httpx_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
	"github.com/sns45/anyonce/go/store/memory"
)

// cappedStore is a memory store that declares a size limit of its own (Q20).
type cappedStore struct {
	*memory.Store
	limit int
}

func (c cappedStore) MaxResultBytes() int { return c.limit }

// downStore fails every call, so Begin reports a store error.
type downStore struct{}

var errDown = errors.New("down")

func (downStore) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{}, errDown
}
func (downStore) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return "", errDown
}
func (downStore) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return "", errDown
}
func (downStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, errDown
}
func (downStore) Purge(context.Context, time.Time) (int, error) { return 0, errDown }

func door(store anyonce.Store) httpx.Door {
	return httpx.Door{
		Name:         "testdoor",
		Store:        store,
		StoreHeaders: httpx.HeaderSet(nil, []string{"Content-Type"}),
		Problems:     httpx.ProblemWriter{BaseURI: httpx.DefaultProblemBaseURI},
	}
}

func op(fingerprint string) anyonce.Operation {
	return anyonce.Operation{Scope: "POST /p", Key: "k", Fingerprint: fingerprint}
}

func serve(d httpx.Door, o anyonce.Operation, next http.Handler) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	d.Execute(rec, httptest.NewRequest(http.MethodPost, "/p", nil), next, o)
	return rec
}

func created(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(body))
	})
}

func TestDoor(t *testing.T) {
	t.Run("REQ-HTTP-7: CapResultBytes keeps the policy cap unless the store declares a smaller one (Q20)", func(t *testing.T) {
		plain := memory.New()
		if got := httpx.CapResultBytes(plain, 0); got != anyonce.DefaultPolicy().MaxResultBytes {
			t.Fatalf("zero policy cap became %d, want the default", got)
		}
		if got := httpx.CapResultBytes(plain, 10); got != 10 {
			t.Fatalf("got %d, want 10", got)
		}
		if got := httpx.CapResultBytes(cappedStore{Store: plain, limit: 5}, 10); got != 5 {
			t.Fatalf("got %d, want the store's 5", got)
		}
		if got := httpx.CapResultBytes(cappedStore{Store: plain, limit: 50}, 10); got != 10 {
			t.Fatalf("got %d, want the policy's 10", got)
		}
		if got := httpx.CapResultBytes(cappedStore{Store: plain, limit: 0}, 10); got != 10 {
			t.Fatalf("got %d, a store declaring 0 must not cap", got)
		}
	})

	t.Run("REQ-HTTP-1: MethodSet uppercases the configured methods and falls back to the defaults when none are given", func(t *testing.T) {
		got := httpx.MethodSet([]string{"put"}, []string{http.MethodPost})
		if !got["PUT"] || got["POST"] || len(got) != 1 {
			t.Fatalf("methods %v", got)
		}
		if got := httpx.MethodSet(nil, []string{"post"}); !got["POST"] || len(got) != 1 {
			t.Fatalf("defaults %v", got)
		}
		if got := httpx.MethodSet([]string{}, []string{"POST"}); !got["POST"] {
			t.Fatalf("an empty list takes the defaults, got %v", got)
		}
	})

	t.Run("REQ-HTTP-8: HeaderSet canonicalizes names, takes the defaults only for a nil list, and an empty list stores none", func(t *testing.T) {
		if got := httpx.HeaderSet([]string{"x-trace"}, []string{"Content-Type"}); !got["X-Trace"] || got["Content-Type"] {
			t.Fatalf("headers %v", got)
		}
		if got := httpx.HeaderSet(nil, []string{"etag"}); !got["Etag"] {
			t.Fatalf("defaults %v", got)
		}
		if got := httpx.HeaderSet([]string{}, []string{"ETag"}); len(got) != 0 {
			t.Fatalf("an explicit empty allowlist must store no header, got %v", got)
		}
	})

	t.Run("REQ-HTTP-3: KeyRejected passes a missing key through unless required, and answers the rest with problems", func(t *testing.T) {
		d := door(memory.New())
		ran := 0
		next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { ran++ })
		r := httptest.NewRequest(http.MethodPost, "/p", nil)

		rec := httptest.NewRecorder()
		if !d.KeyRejected(rec, r, next, httpx.KeyMissing, "", false, "https://docs.test/") || ran != 1 {
			t.Fatalf("an optional missing key must pass through, ran %d", ran)
		}
		rec = httptest.NewRecorder()
		if !d.KeyRejected(rec, r, next, httpx.KeyMissing, "", true, "https://docs.test/") || ran != 1 {
			t.Fatal("a required missing key must be answered without running next")
		}
		if rec.Code != http.StatusBadRequest || rec.Header().Get("Link") != `<https://docs.test/>; rel="describedby"` {
			t.Fatalf("missing key answered %d with Link %q", rec.Code, rec.Header().Get("Link"))
		}
		rec = httptest.NewRecorder()
		if !d.KeyRejected(rec, r, next, httpx.KeyInvalid, "too long", true, "") || rec.Code != http.StatusBadRequest {
			t.Fatalf("an invalid key answered %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "invalid-key") || !strings.Contains(rec.Body.String(), "too long") {
			t.Fatalf("invalid key body %s", rec.Body.String())
		}
		if d.KeyRejected(httptest.NewRecorder(), r, next, httpx.KeyOK, "", true, "") {
			t.Fatal("a valid key must continue")
		}
	})

	t.Run("REQ-HTTP-6: ReadBody answers an oversized body with 413 and hands back the bytes otherwise", func(t *testing.T) {
		d := door(memory.New())
		rec := httptest.NewRecorder()
		if _, ok := d.ReadBody(rec, httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("abcdef")), 3); ok {
			t.Fatal("an oversized body must stop the request")
		}
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("oversized body answered %d", rec.Code)
		}
		body, ok := d.ReadBody(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/p", strings.NewReader("abc")), 3)
		if !ok || string(body) != "abc" {
			t.Fatalf("body %q ok %v", body, ok)
		}
	})

	t.Run("REQ-HTTP-9: Execute runs the handler once and replays the stored response for the duplicate", func(t *testing.T) {
		d := door(memory.New())
		runs := 0
		next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			runs++
			if key, ok := httpx.KeyFromContext(r.Context()); !ok || key != "k" {
				t.Errorf("the handler saw key %q %v", key, ok)
			}
			created("hello").ServeHTTP(w, r)
		})
		first := serve(d, op("f"), next)
		second := serve(d, op("f"), next)
		if runs != 1 || first.Code != http.StatusCreated || second.Code != http.StatusCreated {
			t.Fatalf("runs %d, codes %d %d", runs, first.Code, second.Code)
		}
		if second.Body.String() != "hello" || second.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatalf("replay %q with headers %v", second.Body.String(), second.Header())
		}
	})

	t.Run("REQ-HTTP-10: Execute answers an in-flight duplicate with 409 and Retry-After", func(t *testing.T) {
		store := memory.New()
		d := door(store)
		now := time.Now()
		if _, err := store.Begin(context.Background(), op("f"), anyonce.BeginOptions{Lease: time.Minute, TTL: time.Hour, Now: now}); err != nil {
			t.Fatal(err)
		}
		rec := serve(d, op("f"), created("x"))
		if rec.Code != http.StatusConflict || rec.Header().Get("Retry-After") == "" {
			t.Fatalf("in flight answered %d with Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
		}
	})

	t.Run("REQ-HTTP-11: Execute answers a mismatch with 422 after firing OnMismatch with the stored record", func(t *testing.T) {
		d := door(memory.New())
		var seen *anyonce.Record
		d.OnMismatch = func(_ *http.Request, rec *anyonce.Record) { seen = rec }
		serve(d, op("f1"), created("x"))
		rec := serve(d, op("f2"), created("x"))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("mismatch answered %d", rec.Code)
		}
		if seen == nil || seen.Fingerprint != "f1" {
			t.Fatalf("OnMismatch saw %+v, want the stored record", seen)
		}
	})

	t.Run("REQ-HTTP-12: Execute answers a fail-closed store error with 503 and marks a fail-open run degraded", func(t *testing.T) {
		d := door(downStore{})
		rec := serve(d, op("f"), created("x"))
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
			t.Fatalf("fail closed answered %d with Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
		}
		hooked := 0
		d.Policy = anyonce.Policy{OnStoreError: anyonce.FailOpen, Hooks: anyonce.Hooks{OnStoreError: func(anyonce.Operation, error) { hooked++ }}}
		rec = serve(d, op("f"), created("x"))
		if rec.Code != http.StatusCreated || rec.Header().Get("Idempotency-Degraded") != "true" {
			t.Fatalf("fail open answered %d with headers %v", rec.Code, rec.Header())
		}
		if hooked == 0 {
			t.Fatal("the caller's own OnStoreError hook was not chained")
		}
	})

	t.Run("REQ-HTTP-18: Execute re-panics a handler panic after the claim is abandoned, so a retry runs", func(t *testing.T) {
		d := door(memory.New())
		func() {
			defer func() {
				if p := recover(); p != "boom" {
					t.Fatalf("recovered %v, want the handler's own panic value", p)
				}
			}()
			serve(d, op("f"), http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }))
		}()
		if rec := serve(d, op("f"), created("after")); rec.Code != http.StatusCreated || rec.Body.String() != "after" {
			t.Fatalf("the retry answered %d %q, want the handler to run", rec.Code, rec.Body.String())
		}
	})

}
