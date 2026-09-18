package webhookmw_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyonce/go/webhookmw"
)

// failingStore refuses every call, so a receiver built on it takes the D13 store error path on Begin.
type failingStore struct{}

func (failingStore) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{}, errors.New("down")
}

func (failingStore) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}

func (failingStore) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return "", errors.New("down")
}

func (failingStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, errors.New("down")
}

func (failingStore) Purge(context.Context, time.Time) (int, error) { return 0, errors.New("down") }

// TestReplayAndHooks covers what the engine decides for a delivery that got past key resolution: replay, the
// in-flight conflict, the mismatch and its security hook, and the claim a handler runs under. The key, the scope
// and the fingerprint that feed it are in middleware_test.go.
func TestReplayAndHooks(t *testing.T) {
	t.Run("REQ-WH-3: a redelivery replays the stored response with Idempotency-Replayed true and runs the handler once", func(t *testing.T) {
		var runs atomic.Int64
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: alwaysVerify})
		h := mw.Handler(countingHandler(&runs))

		first := httptest.NewRecorder()
		h.ServeHTTP(first, delivery("msg_1", `{"a":1}`))
		if first.Code != http.StatusOK || first.Body.String() != "handled" {
			t.Fatalf("first: status = %d, body = %q", first.Code, first.Body.String())
		}
		if first.Header().Get("Idempotency-Replayed") != "" {
			t.Fatal("the first delivery claims to be a replay")
		}

		second := httptest.NewRecorder()
		h.ServeHTTP(second, delivery("msg_1", `{"a":1}`))
		if second.Code != http.StatusOK {
			t.Fatalf("second: status = %d, want 200", second.Code)
		}
		if second.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatalf("second: headers = %v", second.Header())
		}
		if second.Body.String() != "handled" {
			t.Fatalf("second: body = %q, want handled", second.Body.String())
		}
		// REQ-HTTP-8: the allowlisted response header survives the round trip through the store.
		if got := second.Header().Get("Content-Type"); got != "text/plain" {
			t.Fatalf("second: content type = %q", got)
		}
		if runs.Load() != 1 {
			t.Fatalf("the handler ran %d times, want 1", runs.Load())
		}
	})

	t.Run("REQ-WH-3: a stored 4xx replays as the stored 4xx, because D6 stores every status below 500", func(t *testing.T) {
		var runs atomic.Int64
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: alwaysVerify})
		h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			runs.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte("rejected"))
		}))

		first := httptest.NewRecorder()
		h.ServeHTTP(first, delivery("msg_1", `{"a":1}`))
		if first.Code != http.StatusBadRequest {
			t.Fatalf("first: status = %d, want 400", first.Code)
		}

		second := httptest.NewRecorder()
		h.ServeHTTP(second, delivery("msg_1", `{"a":1}`))
		if second.Code != http.StatusBadRequest {
			t.Fatalf("second: status = %d, want the stored 400", second.Code)
		}
		if second.Header().Get("Idempotency-Replayed") != "true" {
			t.Fatalf("second: headers = %v", second.Header())
		}
		if second.Body.String() != "rejected" {
			t.Fatalf("second: body = %q, want rejected", second.Body.String())
		}
		if runs.Load() != 1 {
			t.Fatalf("the handler ran %d times, want 1", runs.Load())
		}
	})

	t.Run("REQ-WH-4: a redelivery while the first is in flight is 409 with Retry-After at least 1", func(t *testing.T) {
		started := make(chan struct{})
		release := make(chan struct{})
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify: func(*http.Request, []byte) (bool, error) { return true, nil },
			Policy: anyonce.Policy{Lease: 30 * time.Second},
		})
		handler := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			close(started)
			<-release
			w.WriteHeader(http.StatusOK)
		}))

		var wg sync.WaitGroup
		wg.Add(1)
		firstRec := httptest.NewRecorder()
		go func() {
			defer wg.Done()
			handler.ServeHTTP(firstRec, delivery("msg_inflight", `{"a":1}`))
		}()

		<-started
		secondRec := httptest.NewRecorder()
		handler.ServeHTTP(secondRec, delivery("msg_inflight", `{"a":1}`))
		if secondRec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want 409", secondRec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(secondRec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeConflict {
			t.Fatalf("code = %q", p.Code)
		}
		if p.Title != "A delivery with this webhook-id is still in progress" {
			t.Fatalf("title = %q", p.Title)
		}
		seconds, err := strconv.Atoi(secondRec.Header().Get("Retry-After"))
		if err != nil || seconds < 1 {
			t.Fatalf("Retry-After = %q (%v)", secondRec.Header().Get("Retry-After"), err)
		}

		close(release)
		wg.Wait()
		if firstRec.Code != http.StatusOK {
			t.Fatalf("first status = %d, want 200", firstRec.Code)
		}
	})

	t.Run("REQ-WH-5: the same id with a different body is 422 and fires OnSuspicious with the stored record", func(t *testing.T) {
		var runs atomic.Int64
		var seen *anyonce.Record
		var seenPath string
		var calls int
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify: alwaysVerify,
			OnSuspicious: func(r *http.Request, rec *anyonce.Record) {
				calls++
				seen = rec
				seenPath = r.URL.Path
			},
		})
		h := mw.Handler(countingHandler(&runs))

		h.ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, delivery("msg_1", `{"a":2}`))

		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeFingerprintMismatch {
			t.Fatalf("code = %q", p.Code)
		}
		if p.Title != "This webhook-id was already delivered with a different payload" {
			t.Fatalf("title = %q", p.Title)
		}
		if calls != 1 {
			t.Fatalf("OnSuspicious fired %d times, want 1", calls)
		}
		if seen == nil {
			t.Fatal("OnSuspicious got no record")
		}
		if seen.Key != "msg_1" || seen.Fingerprint != anyonce.SHA256Hex([]byte(`{"a":1}`)) {
			t.Fatalf("record = %+v, want the stored first delivery", seen)
		}
		if seenPath != "/hooks/stripe" {
			t.Fatalf("OnSuspicious saw path %q", seenPath)
		}
		// The mismatched delivery never reaches the handler, and the stored record is not overwritten.
		if runs.Load() != 1 {
			t.Fatalf("the handler ran %d times, want 1", runs.Load())
		}
	})

	t.Run("REQ-WH-5: an OnSuspicious hook that panics does not change the 422", func(t *testing.T) {
		mw := webhookmw.New(memory.New(), webhookmw.Options{
			Verify:       alwaysVerify,
			OnSuspicious: func(*http.Request, *anyonce.Record) { panic("hook") },
		})
		h := mw.Handler(handled())
		h.ServeHTTP(httptest.NewRecorder(), delivery("msg_1", `{"a":1}`))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, delivery("msg_1", `{"a":2}`))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeFingerprintMismatch {
			t.Fatalf("code = %q", p.Code)
		}
	})

	t.Run("REQ-WH-7: the handler reads the key and the fence from the request context", func(t *testing.T) {
		var gotKey string
		var gotFence int64
		var keyOK, fenceOK bool
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: alwaysVerify})
		h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotKey, keyOK = webhookmw.KeyFromContext(r.Context())
			gotFence, fenceOK = webhookmw.FenceFromContext(r.Context())
			w.WriteHeader(http.StatusOK)
		}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, delivery("msg_1", `{"a":1}`))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !keyOK || gotKey != "msg_1" {
			t.Fatalf("key = %q (ok %v), want msg_1", gotKey, keyOK)
		}
		if !fenceOK || gotFence < 1 {
			t.Fatalf("fence = %d (ok %v), want at least 1", gotFence, fenceOK)
		}
	})

	t.Run("REQ-WH-7: a panicking handler re-panics at the receiver boundary and abandons the claim so a redelivery runs", func(t *testing.T) {
		var runs atomic.Int64
		mw := webhookmw.New(memory.New(), webhookmw.Options{Verify: alwaysVerify})
		h := mw.Handler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if runs.Add(1) == 1 {
				panic("boom")
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("handled"))
		}))

		// The panic is recovered inside the engine's run callback so the claim is abandoned, then replayed
		// here, at the receiver's own boundary, so net/http's recovery still applies.
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			h.ServeHTTP(httptest.NewRecorder(), delivery("msg_panic", `{"a":1}`))
		}()
		if recovered != "boom" {
			t.Fatalf("recovered = %v, want boom", recovered)
		}

		// Abandoned, not held and not completed: the redelivery acquires the same key again and runs, rather
		// than answering 409 for a claim nobody holds or replaying a result that was never stored.
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, delivery("msg_panic", `{"a":1}`))
		if rec.Code != http.StatusOK || rec.Body.String() != "handled" {
			t.Fatalf("redelivery: status = %d, body = %q, want 200 and handled", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Idempotency-Replayed") != "" {
			t.Fatal("the redelivery replayed a result the panicking handler never stored")
		}
		if runs.Load() != 2 {
			t.Fatalf("the handler ran %d times, want 2", runs.Load())
		}
	})

	t.Run("REQ-WH-7: a store that fails at Begin under fail-open runs the handler and marks Idempotency-Degraded", func(t *testing.T) {
		// D13 and REQ-HTTP-12 on this door. Fail-closed is the default and is covered by the 503 below, so
		// this is the arm nothing reached: the receiver's own copy of the degraded flag and the header it
		// sets before the handler writes anything.
		var runs atomic.Int64
		open := webhookmw.New(failingStore{}, webhookmw.Options{
			Verify: alwaysVerify,
			Policy: anyonce.Policy{OnStoreError: anyonce.FailOpen},
		}).Handler(countingHandler(&runs))
		rec := httptest.NewRecorder()
		open.ServeHTTP(rec, delivery("msg_degraded", `{"a":1}`))
		if rec.Code != http.StatusOK || rec.Body.String() != "handled" {
			t.Fatalf("status = %d, body = %q, want 200 and handled", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Idempotency-Degraded"); got != "true" {
			t.Fatalf("Idempotency-Degraded = %q, want true", got)
		}
		if runs.Load() != 1 {
			t.Fatalf("the handler ran %d times, want 1", runs.Load())
		}

		// The same store fail-closed is 503 store-unavailable with Retry-After 1 and never runs the handler.
		var closedRuns atomic.Int64
		closed := webhookmw.New(failingStore{}, webhookmw.Options{Verify: alwaysVerify}).
			Handler(countingHandler(&closedRuns))
		rec = httptest.NewRecorder()
		closed.ServeHTTP(rec, delivery("msg_degraded", `{"a":1}`))
		if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "1" {
			t.Fatalf("status = %d, Retry-After = %q, want 503 and 1", rec.Code, rec.Header().Get("Retry-After"))
		}
		var p webhookmw.Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if p.Code != webhookmw.CodeStoreUnavailable {
			t.Fatalf("code = %q, want store-unavailable", p.Code)
		}
		if closedRuns.Load() != 0 {
			t.Fatalf("the handler ran %d times under fail-closed, want 0", closedRuns.Load())
		}
	})
}
