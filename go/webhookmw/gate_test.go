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
		if p.Title != "The webhook endpoint could not establish that this delivery is genuine" {
			t.Fatalf("title = %q", p.Title)
		}
		if p.Detail != "no verify callback or verifiedMarker is configured" {
			t.Fatalf("detail = %q", p.Detail)
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
		var messages []string
		mw := webhookmw.New(store, webhookmw.Options{
			Logf: func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) },
			Verify: func(*http.Request, []byte) (bool, error) {
				return false, fmt.Errorf("the key service is down, key msg_1")
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
		if p.Detail != "the verify callback failed" {
			t.Fatalf("detail = %q", p.Detail)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
		// Ruling 12: the malfunction is not silent, and ruling 12 again: the line carries neither the
		// verifier's own error text nor anything from the request.
		if len(messages) != 1 {
			t.Fatalf("logged %d times, want 1", len(messages))
		}
		for _, leak := range []string{"msg_1", "key service"} {
			if strings.Contains(messages[0], leak) {
				t.Fatalf("the log line carries %q: %q", leak, messages[0])
			}
		}
	})

	t.Run("REQ-WH-2: the two configuration-error causes log independently and carry different details", func(t *testing.T) {
		detailFor := func(t *testing.T, opts webhookmw.Options) (string, []string) {
			t.Helper()
			var messages []string
			opts.Logf = func(format string, args ...any) { messages = append(messages, fmt.Sprintf(format, args...)) }
			mw := webhookmw.New(newCountingStore(), opts)
			h := mw.Handler(handled())
			var p webhookmw.Problem
			for range 3 {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
				if rec.Code != http.StatusInternalServerError {
					t.Fatalf("status = %d, want 500", rec.Code)
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
					t.Fatal(err)
				}
			}
			return p.Detail, messages
		}

		unconfiguredDetail, unconfiguredMessages := detailFor(t, webhookmw.Options{})
		failedDetail, failedMessages := detailFor(t, webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return false, fmt.Errorf("down") },
		})
		if unconfiguredDetail == failedDetail {
			t.Fatalf("both causes report the same detail %q", unconfiguredDetail)
		}
		// Each cause has its own latch, so neither can suppress the other, and each still logs exactly once.
		if len(unconfiguredMessages) != 1 || len(failedMessages) != 1 {
			t.Fatalf("logged %d and %d times, want 1 each", len(unconfiguredMessages), len(failedMessages))
		}
		if unconfiguredMessages[0] == failedMessages[0] {
			t.Fatalf("both causes log the same line %q", unconfiguredMessages[0])
		}
	})

	t.Run("REQ-WH-2: a configured receiver passes a non-POST straight to next without verifying", func(t *testing.T) {
		store := newCountingStore()
		verifyRan := false
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) {
				verifyRan = true
				return false, nil
			},
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/hooks/stripe", nil))
		// This is the one path that reaches next without verification. It is intended, it mirrors the HTTP
		// door's method filter, and it is safe only because a method the receiver does not claim is never
		// deduplicated either: nothing about it reaches the store.
		if rec.Code != http.StatusOK || rec.Body.String() != "handled" {
			t.Fatalf("status = %d, body = %q, want 200 and handled", rec.Code, rec.Body.String())
		}
		if verifyRan {
			t.Fatal("Verify ran for a method the receiver does not apply to")
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
		matched := newCountingStore()
		mw := webhookmw.New(matched, webhookmw.Options{VerifiedMarker: "stripe"})
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
		// One, now that key resolution has landed: a delivery that passes the gate is deduplicated, so the
		// verified request reaches the store exactly once.
		if matched.count() != 1 {
			t.Fatalf("Begin was called %d times", matched.count())
		}

		// A different marker name is not the one that was set, and it gets its own store so the two halves
		// cannot borrow each other's count.
		mismatched := newCountingStore()
		other := webhookmw.New(mismatched, webhookmw.Options{VerifiedMarker: "github"})
		rec = httptest.NewRecorder()
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := webhookmw.MarkVerified(r.Context(), "stripe")
			other.Handler(handled()).ServeHTTP(w, r.WithContext(ctx))
		}).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status for the wrong marker = %d, want 401", rec.Code)
		}
		if mismatched.count() != 0 {
			t.Fatalf("Begin was called %d times", mismatched.count())
		}
	})

	t.Run("REQ-WH-2: a 401 carries the RFC 9110 WWW-Authenticate challenge and no other problem does", func(t *testing.T) {
		// Ruling 20: RFC 9110 section 15.5.2 makes at least one challenge a MUST on a 401, and
		// signature-invalid is the only problem this door answers with one.
		unauthorized := httptest.NewRecorder()
		webhookmw.New(newCountingStore(), webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return false, nil },
		}).Handler(handled()).ServeHTTP(unauthorized, delivery("msg_1", `{"a":1}`))
		if unauthorized.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", unauthorized.Code)
		}
		if got := unauthorized.Header().Get("WWW-Authenticate"); got != "Signature" {
			t.Fatalf("WWW-Authenticate = %q, want Signature", got)
		}

		// A 500 configuration-error, a 413 payload-too-large and a 400 missing-key are not 401s and carry
		// no challenge.
		unconfigured := httptest.NewRecorder()
		webhookmw.New(newCountingStore(), webhookmw.Options{Logf: func(string, ...any) {}}).
			Handler(handled()).ServeHTTP(unconfigured, delivery("msg_1", `{"a":1}`))
		tooLarge := httptest.NewRecorder()
		webhookmw.New(newCountingStore(), webhookmw.Options{MaxRequestBytes: 8, Verify: func(*http.Request, []byte) (bool, error) { return true, nil }}).
			Handler(handled()).ServeHTTP(tooLarge, delivery("msg_1", strings.Repeat("x", 64)))
		missingID := httptest.NewRecorder()
		webhookmw.New(newCountingStore(), webhookmw.Options{Verify: func(*http.Request, []byte) (bool, error) { return true, nil }}).
			Handler(handled()).ServeHTTP(missingID, delivery("", `{"a":1}`))
		for _, tc := range []struct {
			name string
			want int
			rec  *httptest.ResponseRecorder
		}{
			{"configuration-error", http.StatusInternalServerError, unconfigured},
			{"payload-too-large", http.StatusRequestEntityTooLarge, tooLarge},
			{"missing-key", http.StatusBadRequest, missingID},
		} {
			if tc.rec.Code != tc.want {
				t.Fatalf("%s: status = %d, want %d", tc.name, tc.rec.Code, tc.want)
			}
			if got := tc.rec.Header().Get("WWW-Authenticate"); got != "" {
				t.Fatalf("%s: WWW-Authenticate = %q, want none", tc.name, got)
			}
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
