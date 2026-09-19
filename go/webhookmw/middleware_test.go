package webhookmw_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

// alwaysVerify is the gate every test past gate_test.go passes, because the gate has its own tests there.
func alwaysVerify(*http.Request, []byte) (bool, error) { return true, nil }

// ops returns a copy of the operations the receiver handed to Begin, so a test can read the key, the scope and
// the fingerprint the door built without racing the receiver.
func (c *countingStore) ops() []anyonce.Operation {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]anyonce.Operation(nil), c.begins...)
}

// deliveryTo is delivery for a path other than the default one, which the scope and fingerprint tests need.
func deliveryTo(path, id, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if id != "" {
		r.Header.Set("webhook-id", id)
	}
	r.Header.Set("Content-Type", "application/json")
	return r
}

// countingHandler answers 200 with a fixed body and records how many times it ran.
func countingHandler(runs *atomic.Int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		runs.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("handled"))
	})
}

// TestReceiver covers what the receiver decides before the engine: where the delivery id comes from, what the
// scope is and what the fingerprint hashes. Replay, conflict, mismatch and the context values are in
// hooks_test.go.
func TestReceiver(t *testing.T) {
	t.Run("REQ-WH-1: the delivery id comes from the webhook-id header and becomes the store key", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusOK || rec.Body.String() != "handled" {
			t.Fatalf("status = %d, body = %q, want 200 and handled", rec.Code, rec.Body.String())
		}
		ops := store.ops()
		if len(ops) != 1 {
			t.Fatalf("Begin was called %d times, want 1", len(ops))
		}
		if ops[0].Key != "msg_1" {
			t.Fatalf("key = %q, want msg_1", ops[0].Key)
		}
	})

	t.Run("REQ-WH-1: a Key function reads the id out of the body and wins over the header", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{
			Verify: alwaysVerify,
			Key: func(_ *http.Request, body []byte) (string, bool) {
				var payload struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(body, &payload); err != nil || payload.ID == "" {
					return "", false
				}
				return payload.ID, true
			},
		})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("header_id", `{"id":"evt_from_body"}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		ops := store.ops()
		if len(ops) != 1 || ops[0].Key != "evt_from_body" {
			t.Fatalf("ops = %+v, want one Begin keyed evt_from_body", ops)
		}
	})

	t.Run("REQ-WH-1: a verified delivery with no id is 400 missing-key", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify})
		rec := httptest.NewRecorder()
		mw.Handler(handled()).ServeHTTP(rec, delivery("", `{"a":1}`))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeMissingKey {
			t.Fatalf("code = %q", p.Code)
		}
		if p.Title != "The webhook-id header is required for this request" {
			t.Fatalf("title = %q", p.Title)
		}
		if link := rec.Header().Get("Link"); !strings.Contains(link, "rel=\"describedby\"") {
			t.Fatalf("Link = %q", link)
		}
		// Q25: Required defaults to true on this door, so the handler never ran and nothing was stored.
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-1: an empty webhook-id header is treated as missing, the same as no header at all", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify})
		rec := httptest.NewRecorder()
		r := delivery("", `{"a":1}`)
		r.Header.Set("webhook-id", "")
		mw.Handler(handled()).ServeHTTP(rec, r)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		// Ruling 19: byte for byte what the TypeScript receiver answers, down to the Link header a
		// missing-key carries and an invalid-key does not.
		if p.Code != webhookmw.CodeMissingKey {
			t.Fatalf("code = %q, want missing-key", p.Code)
		}
		if link := rec.Header().Get("Link"); !strings.Contains(link, "rel=\"describedby\"") {
			t.Fatalf("Link = %q", link)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-1: an id longer than 255 bytes is 400 invalid-key", func(t *testing.T) {
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify})
		rec := httptest.NewRecorder()
		long := strings.Repeat("a", 256)
		mw.Handler(handled()).ServeHTTP(rec, delivery(long, `{"a":1}`))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeInvalidKey {
			t.Fatalf("code = %q", p.Code)
		}
		// NFR-2: the reason names the rule that was broken and never interpolates the id. Asserted exactly, so
		// a parser change that started quoting the value back would fail here rather than slip past a
		// substring check that this fixed message can never trip.
		if p.Detail != "anyonce: invalid key: key exceeds 255 bytes" {
			t.Fatalf("detail = %q", p.Detail)
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-1: the scope is the route pattern alone when no SourceID is configured", func(t *testing.T) {
		// The default route is the escaped path of the request.
		byPath := newCountingStore()
		webhookmw.New(byPath, webhookmw.Options{Verify: alwaysVerify}).
			Handler(handled()).ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		if ops := byPath.ops(); len(ops) != 1 || ops[0].Scope != "/hooks/stripe" {
			t.Fatalf("ops = %+v, want scope /hooks/stripe", ops)
		}
		// A configured RoutePattern replaces it, so two concrete paths under one route share a scope.
		byPattern := newCountingStore()
		webhookmw.New(byPattern, webhookmw.Options{Verify: alwaysVerify, RoutePattern: "/hooks/{provider}"}).
			Handler(handled()).ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		if ops := byPattern.ops(); len(ops) != 1 || ops[0].Scope != "/hooks/{provider}" {
			t.Fatalf("ops = %+v, want scope /hooks/{provider}", ops)
		}
	})

	t.Run("REQ-WH-1: a SourceID is appended to the route pattern after a slash", func(t *testing.T) {
		withSource := newCountingStore()
		sourced := delivery("msg_1", `{"a":1}`)
		sourced.Header.Set("webhook-source", "acct_1")
		webhookmw.New(withSource, webhookmw.Options{
			Verify:       alwaysVerify,
			RoutePattern: "/hooks/stripe",
			SourceID:     func(r *http.Request, _ []byte) string { return r.Header.Get("webhook-source") },
		}).Handler(handled()).ServeHTTP(httptest.NewRecorder(), sourced)
		if ops := withSource.ops(); len(ops) != 1 || ops[0].Scope != "/hooks/stripe/acct_1" {
			t.Fatalf("ops = %+v, want scope /hooks/stripe/acct_1", ops)
		}
		// Q24: a SourceID that yields nothing leaves the scope as the route alone, with no trailing slash.
		withoutSource := newCountingStore()
		webhookmw.New(withoutSource, webhookmw.Options{
			Verify:       alwaysVerify,
			RoutePattern: "/hooks/stripe",
			SourceID:     func(*http.Request, []byte) string { return "" },
		}).Handler(handled()).ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		if ops := withoutSource.ops(); len(ops) != 1 || ops[0].Scope != "/hooks/stripe" {
			t.Fatalf("ops = %+v, want scope /hooks/stripe", ops)
		}
	})

	t.Run("REQ-WH-1: a Scope function replaces the computed scope, so RoutePattern is never consulted", func(t *testing.T) {
		store := newCountingStore()
		webhookmw.New(store, webhookmw.Options{
			Verify:       alwaysVerify,
			RoutePattern: "/hooks/stripe",
			Scope:        func(*http.Request, []byte) string { return "tenant_7" },
		}).Handler(handled()).ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		if ops := store.ops(); len(ops) != 1 || ops[0].Scope != "tenant_7" {
			t.Fatalf("ops = %+v, want scope tenant_7", ops)
		}
	})

	t.Run("REQ-WH-1: a Scope function sees the request and the body bytes", func(t *testing.T) {
		store := newCountingStore()
		webhookmw.New(store, webhookmw.Options{
			Verify: alwaysVerify,
			Scope: func(r *http.Request, body []byte) string {
				var payload struct {
					Account string `json:"account"`
				}
				if err := json.Unmarshal(body, &payload); err != nil {
					t.Errorf("Scope could not read the body: %v", err)
				}
				return r.URL.EscapedPath() + "/" + payload.Account
			},
		}).Handler(handled()).ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"account":"acct_9"}`))
		if ops := store.ops(); len(ops) != 1 || ops[0].Scope != "/hooks/stripe/acct_9" {
			t.Fatalf("ops = %+v, want scope /hooks/stripe/acct_9", ops)
		}
	})

	t.Run("REQ-WH-1: New panics when Scope is set together with SourceID", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("New accepted both Scope and SourceID, so the sender identity would be discarded")
			}
		}()
		webhookmw.New(memory.New(), webhookmw.Options{
			Verify:   alwaysVerify,
			Scope:    func(*http.Request, []byte) string { return "tenant_7" },
			SourceID: func(*http.Request, []byte) string { return "acct_42" },
		})
	})

	t.Run("REQ-WH-1: the same id in two source scopes runs the handler twice", func(t *testing.T) {
		var runs atomic.Int64
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify:       alwaysVerify,
			RoutePattern: "/hooks/stripe",
			SourceID:     func(r *http.Request, _ []byte) string { return r.Header.Get("webhook-source") },
		})
		h := mw.Handler(countingHandler(&runs))
		for _, source := range []string{"acct_1", "acct_2"} {
			r := delivery("msg_shared", `{"a":1}`)
			r.Header.Set("webhook-source", source)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Code != http.StatusOK {
				t.Fatalf("source %s: status = %d, want 200", source, rec.Code)
			}
			if rec.Header().Get("Idempotency-Replayed") != "" {
				t.Fatalf("source %s: a different scope replayed", source)
			}
		}
		if runs.Load() != 2 {
			t.Fatalf("the handler ran %d times, want 2", runs.Load())
		}
	})

	t.Run("REQ-WH-1: the fingerprint is SHA-256 over the body bytes alone, so the same body on two paths matches", func(t *testing.T) {
		const body = `{"a":1}`
		var runs atomic.Int64
		store := newCountingStore()
		// One RoutePattern puts both paths in one scope; only the fingerprint could tell them apart, and D9
		// says it does not, because it hashes the body and never the method or the path.
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify, RoutePattern: "/hooks/stripe"})
		h := mw.Handler(countingHandler(&runs))

		first := httptest.NewRecorder()
		h.ServeHTTP(first, deliveryTo("/hooks/stripe/a", "msg_1", body))
		second := httptest.NewRecorder()
		h.ServeHTTP(second, deliveryTo("/hooks/stripe/b", "msg_1", body))

		if second.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", second.Code)
		}
		if second.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatalf("the second path did not replay: headers = %v", second.Header())
		}
		if runs.Load() != 1 {
			t.Fatalf("the handler ran %d times, want 1", runs.Load())
		}
		ops := store.ops()
		if len(ops) != 2 {
			t.Fatalf("Begin was called %d times, want 2", len(ops))
		}
		want := anyonce.SHA256Hex([]byte(body))
		for i, op := range ops {
			if op.Fingerprint != want {
				t.Fatalf("op %d fingerprint = %q, want %q", i, op.Fingerprint, want)
			}
		}
	})

	t.Run("REQ-WH-1: a GET passes through untouched because the receiver applies to POST only", func(t *testing.T) {
		var runs atomic.Int64
		store := newCountingStore()
		mw := webhookmw.New(store, webhookmw.Options{Verify: alwaysVerify})
		h := mw.Handler(countingHandler(&runs))
		for i := range 2 {
			r := httptest.NewRequest(http.MethodGet, "/hooks/stripe", nil)
			r.Header.Set("webhook-id", "msg_1")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Code != http.StatusOK || rec.Body.String() != "handled" {
				t.Fatalf("GET %d: status = %d, body = %q", i, rec.Code, rec.Body.String())
			}
			if rec.Header().Get("Idempotency-Replayed") != "" {
				t.Fatalf("GET %d replayed", i)
			}
		}
		if runs.Load() != 2 {
			t.Fatalf("the handler ran %d times, want 2", runs.Load())
		}
		if store.count() != 0 {
			t.Fatalf("Begin was called %d times", store.count())
		}
	})

	t.Run("REQ-WH-1: the handler receives the body unread", func(t *testing.T) {
		const payload = `{"nested":{"b":[1,2,3]},"unicode":"café"}`
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: alwaysVerify})
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
		if rec.Body.String() != payload {
			t.Fatalf("the handler read %q, want %q", rec.Body.String(), payload)
		}
	})
}
