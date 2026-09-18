package webhookmw_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

type countingStore struct {
	anyonce.Store
	mu     sync.Mutex
	begins []anyonce.Operation
}

func newCountingStore() *countingStore { return &countingStore{Store: memory.New()} }

func (c *countingStore) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	c.mu.Lock()
	c.begins = append(c.begins, op)
	c.mu.Unlock()
	return c.Store.Begin(ctx, op, opts)
}

func (c *countingStore) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.begins)
}

func delivery(id, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/hooks/stripe", strings.NewReader(body))
	if id != "" {
		r.Header.Set("webhook-id", id)
	}
	r.Header.Set("Content-Type", "application/json")
	return r
}

func handled() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("handled"))
	})
}

func TestGate(t *testing.T) {
	t.Run("REQ-WH-2: a receiver with neither Verify nor VerifiedMarker answers 500 configuration-error and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		var messages []string
		mw := webhookmw.New(store, webhookmw.Options{
			Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) },
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); got != "application/problem+json" {
			t.Fatalf("content type = %q", got)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeConfigurationError || p.Status != 500 {
			t.Fatalf("problem = %+v", p)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
		if len(messages) != 1 {
			t.Fatalf("logged %d times, want 1", len(messages))
		}
		if strings.Contains(messages[0], "msg_1") {
			t.Fatalf("the log line carries request data: %q", messages[0])
		}
	})

	t.Run("REQ-WH-2: the configuration error logs once however many requests arrive", func(t *testing.T) {
		store := newCountingStore()
		var messages []string
		mw := webhookmw.New(store, webhookmw.Options{
			Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) },
		})
		h := mw.Handler(handled())
		for i := range 3 {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, delivery(fmt.Sprintf("msg_%d", i), `{"a":1}`))
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("request %d: status = %d, want 500", i, rec.Code)
			}
		}
		if len(messages) != 1 {
			t.Fatalf("logged %d times, want 1", len(messages))
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-2: the configuration check runs before the method filter, so a GET is 500 too", func(t *testing.T) {
		store := newCountingStore()
		var messages []string
		mw := webhookmw.New(store, webhookmw.Options{
			Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) },
		})
		rec := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/hooks/stripe", nil)
		mw.Handler(handled()).ServeHTTP(rec, r)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if rec.Body.String() == "handled" {
			t.Fatal("the handler ran for a receiver that can never verify anything")
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-2: a Verify that returns false answers 401 signature-invalid and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return false, nil },
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeSignatureInvalid {
			t.Fatalf("code = %q", p.Code)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-2: Verify sees the raw body bytes and the request", func(t *testing.T) {
		store := newCountingStore()
		const payload = `{"nested":{"b":[1,2,3]},"unicode":"café"}`
		var seenBody []byte
		var seenMethod, seenPath, seenID string
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: func(r *http.Request, body []byte) (bool, error) {
				seenBody = body
				seenMethod = r.Method
				seenPath = r.URL.Path
				seenID = r.Header.Get("webhook-id")
				return true, nil
			},
		})
		echo := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			read, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("the handler could not read the body: %v", err)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(read)
		})
		rec := httptest.NewRecorder()
		mw.Handler(echo).ServeHTTP(rec, delivery("msg_1", payload))
		if string(seenBody) != payload {
			t.Fatalf("Verify saw body %q, want %q", seenBody, payload)
		}
		if seenMethod != http.MethodPost || seenPath != "/hooks/stripe" || seenID != "msg_1" {
			t.Fatalf("Verify saw %s %s with id %q", seenMethod, seenPath, seenID)
		}
		// The gate reads the body to hand it to Verify, so it has to put the bytes back for the handler.
		if rec.Body.String() != payload {
			t.Fatalf("the handler read %q, want %q", rec.Body.String(), payload)
		}
	})

	t.Run("REQ-WH-2: a Verify that returns an error is 500 configuration-error and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) {
				return false, fmt.Errorf("the key service is down")
			},
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeConfigurationError || p.Status != 500 {
			t.Fatalf("problem = %+v", p)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-2: a VerifiedMarker that was never set answers 401 and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{VerifiedMarker: "stripe"})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeSignatureInvalid {
			t.Fatalf("code = %q", p.Code)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-2: a marker set by an upstream verifier passes the gate", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{VerifiedMarker: "stripe"})
		upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := webhookmw.MarkVerified(r.Context(), "stripe")
			mw.Handler(handled()).ServeHTTP(w, r.WithContext(ctx))
		})
		rec := httptest.NewRecorder()
		upstream.ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if rec.Body.String() != "handled" {
			t.Fatalf("body = %q, want handled", rec.Body.String())
		}

		// A different marker name is not the one that was set.
		other := webhookmw.New(store, webhookmw.Options{VerifiedMarker: "github"})
		rec = httptest.NewRecorder()
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := webhookmw.MarkVerified(r.Context(), "stripe")
			other.Handler(handled()).ServeHTTP(w, r.WithContext(ctx))
		}).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status for the wrong marker = %d, want 401", rec.Code)
		}
	})

	t.Run("REQ-WH-2: an oversized body is 413 before verification and never calls Begin", func(t *testing.T) {
		store := newCountingStore()
		verified := false
		mw := webhookmw.New(store, webhookmw.Options{
			MaxRequestBytes: 8,
			Verify: func(*http.Request, []byte) (bool, error) {
				verified = true
				return true, nil
			},
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", strings.Repeat("x", 64)))
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodePayloadTooLarge {
			t.Fatalf("code = %q", p.Code)
		}
		if verified {
			t.Fatal("Verify ran for a body the gate had already rejected")
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})
}

func TestMarkers(t *testing.T) {
	t.Run("REQ-WH-2: IsVerified reports false for a context no verifier touched", func(t *testing.T) {
		if webhookmw.IsVerified(context.Background(), "stripe") {
			t.Fatal("an untouched context claims to be verified")
		}
	})

	t.Run("REQ-WH-2: MarkVerified keeps the markers already on the context", func(t *testing.T) {
		ctx := webhookmw.MarkVerified(context.Background(), "stripe")
		derived := webhookmw.MarkVerified(ctx, "github")
		for _, marker := range []string{"stripe", "github"} {
			if !webhookmw.IsVerified(derived, marker) {
				t.Fatalf("the derived context lost the %q marker", marker)
			}
		}
		// Marking a derived context never reaches back into the parent.
		if webhookmw.IsVerified(ctx, "github") {
			t.Fatal("the parent context gained a marker set on a child")
		}
	})
}
