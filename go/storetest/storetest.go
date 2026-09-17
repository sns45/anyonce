// Package storetest is the shared store contract (requirements 4.2). Every anyonce store must pass Run.
package storetest

import (
	"bytes"
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

const (
	Lease          = 30 * time.Second
	TTL            = 24 * time.Hour
	MaxResultBytes = 1 << 20
)

// T0 is the fixed clock every test starts from; time never comes from the wall clock here.
var T0 = time.UnixMilli(1_700_000_000_000).UTC()

// Harness is what a store's test file hands to Run. PhysicallyRemove simulates a native TTL sweep deleting the
// row (stores without native TTL may leave it nil; Purge is used instead). Close releases resources.
type Harness struct {
	Store            anyonce.Store
	PhysicallyRemove func(ctx context.Context, scope, key string) error
	Close            func() error
	// MaxResultBytes is Q20: the largest body this backend stores whole. Zero means MaxResultBytes.
	MaxResultBytes int
	// NativePurge is Q21: the backend sweeps expired rows itself, purge returns 0, the suite drops the
	// removed-count assertion but still requires logical expiry on read.
	NativePurge bool
}

// Factory builds a fresh harness per test.
type Factory func(t *testing.T) Harness

var httpResult = anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 201, Headers: [][2]string{{"Content-Type", "text/plain"}}, Body: []byte{1, 2, 3, 255, 0, 7}}

func opts(now time.Time) anyonce.BeginOptions {
	return anyonce.BeginOptions{Lease: Lease, TTL: TTL, Now: now}
}

// Run registers one subtest per contract requirement against the factory's store.
func Run(t *testing.T, name string, factory Factory) {
	t.Helper()
	uniq := time.Now().UnixNano()
	op := func(tag, fingerprint string) anyonce.Operation {
		return anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:%s", name, uniq, tag), Key: "key-" + tag, Fingerprint: fingerprint}
	}
	ctx := context.Background()
	with := func(fn func(t *testing.T, s anyonce.Store, h Harness)) func(t *testing.T) {
		return func(t *testing.T) {
			h := factory(t)
			if h.Close != nil {
				t.Cleanup(func() { _ = h.Close() })
			}
			fn(t, h.Store, h)
		}
	}
	mustBegin := func(t *testing.T, s anyonce.Store, o anyonce.Operation, now time.Time) anyonce.BeginOutcome {
		t.Helper()
		out, err := s.Begin(ctx, o, opts(now))
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		return out
	}
	expectAcquired := func(t *testing.T, out anyonce.BeginOutcome, fence int64) {
		t.Helper()
		if out.Kind != anyonce.BeginAcquired || out.Fence != fence {
			t.Fatalf("want acquired fence %d, got %+v", fence, out)
		}
	}

	t.Run("REQ-STORE-1: begin on an absent record returns acquired with fence 1", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		expectAcquired(t, mustBegin(t, s, op("s1", "fp-a"), T0), 1)
	}))

	t.Run("REQ-STORE-2: a second begin with the same fingerprint while the lease is live returns in_flight with the same leaseUntil", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s2", "fp-a")
		mustBegin(t, s, o, T0)
		second := mustBegin(t, s, o, T0.Add(time.Second))
		if second.Kind != anyonce.BeginInFlight || !second.LeaseUntil.Equal(T0.Add(Lease)) {
			t.Fatalf("got %+v", second)
		}
		if third := mustBegin(t, s, o, T0.Add(Lease-time.Millisecond)); third.Kind != anyonce.BeginInFlight {
			t.Fatalf("got %+v", third)
		}
	}))

	t.Run("REQ-STORE-3: begin with a different fingerprint returns mismatch while in_flight", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s3a", "fp-a"), T0)
		out := mustBegin(t, s, op("s3a", "fp-b"), T0.Add(10*time.Millisecond))
		if out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.Fingerprint != "fp-a" || out.Record.State != anyonce.StateInFlight {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-3: begin with a different fingerprint returns mismatch when completed", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s3b", "fp-a")
		mustBegin(t, s, o, T0)
		if _, err := s.Complete(ctx, o, 1, httpResult, T0.Add(5*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		out := mustBegin(t, s, op("s3b", "fp-b"), T0.Add(10*time.Millisecond))
		if out.Kind != anyonce.BeginMismatch || out.Record == nil || out.Record.State != anyonce.StateCompleted {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-3: a lease-expired record with a different fingerprint still yields mismatch", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s3c", "fp-a"), T0)
		if out := mustBegin(t, s, op("s3c", "fp-b"), T0.Add(Lease+time.Millisecond)); out.Kind != anyonce.BeginMismatch {
			t.Fatalf("got %+v", out)
		}
	}))

	t.Run("REQ-STORE-4: complete then begin returns completed with the stored result byte-exact", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4", "fp-a")
		mustBegin(t, s, o, T0)
		if st, err := s.Complete(ctx, o, 1, httpResult, T0.Add(5*time.Millisecond)); err != nil || st != anyonce.CompleteOK {
			t.Fatalf("complete: %v %v", st, err)
		}
		out := mustBegin(t, s, o, T0.Add(10*time.Millisecond))
		rec := out.Record
		if out.Kind != anyonce.BeginCompleted || rec == nil || rec.State != anyonce.StateCompleted || rec.Fence != 1 || rec.Result == nil {
			t.Fatalf("got %+v", out)
		}
		if rec.Result.Kind != anyonce.KindHTTP || rec.Result.Status != 201 || len(rec.Result.Headers) != 1 || rec.Result.Headers[0] != [2]string{"Content-Type", "text/plain"} {
			t.Fatalf("result %+v", rec.Result)
		}
		if !bytes.Equal(rec.Result.Body, httpResult.Body) || rec.ResultOmitted {
			t.Fatalf("body %v omitted %v", rec.Result.Body, rec.ResultOmitted)
		}
	}))

	t.Run("REQ-STORE-4: complete on an absent record returns not_found and completing twice with the same fence is ok", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4b", "fp-a")
		if st, _ := s.Complete(ctx, o, 1, httpResult, T0); st != anyonce.CompleteNotFound {
			t.Fatalf("got %v", st)
		}
		mustBegin(t, s, o, T0)
		for i := 0; i < 2; i++ {
			if st, _ := s.Complete(ctx, o, 1, httpResult, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
				t.Fatalf("got %v", st)
			}
		}
	}))

	t.Run("REQ-STORE-4: a message result with outcome error and two headers round trips", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4c", "fp-a")
		message := anyonce.StoredResult{
			Kind:    anyonce.KindMessage,
			Outcome: anyonce.OutcomeError,
			Error:   &anyonce.MessageError{Name: "HandlerError", Message: "boom"},
			Headers: [][2]string{{"set-cookie", "a=1"}, {"set-cookie", "b=2"}},
			Body:    []byte{9, 8, 7},
		}
		mustBegin(t, s, o, T0)
		if st, err := s.Complete(ctx, o, 1, message, T0.Add(time.Millisecond)); err != nil || st != anyonce.CompleteOK {
			t.Fatalf("complete: %v %v", st, err)
		}
		out := mustBegin(t, s, o, T0.Add(2*time.Millisecond))
		if out.Kind != anyonce.BeginCompleted || out.Record == nil || out.Record.Result == nil {
			t.Fatalf("got %+v", out)
		}
		stored := out.Record.Result
		if stored.Kind != anyonce.KindMessage || stored.Outcome != anyonce.OutcomeError {
			t.Fatalf("kind %v outcome %v", stored.Kind, stored.Outcome)
		}
		if stored.Error == nil || stored.Error.Name != "HandlerError" || stored.Error.Message != "boom" {
			t.Fatalf("error %+v", stored.Error)
		}
		if len(stored.Headers) != 2 || stored.Headers[0] != [2]string{"set-cookie", "a=1"} || stored.Headers[1] != [2]string{"set-cookie", "b=2"} {
			t.Fatalf("headers %+v", stored.Headers)
		}
		if !bytes.Equal(stored.Body, message.Body) {
			t.Fatalf("body %v", stored.Body)
		}
	}))

	t.Run("REQ-STORE-4: an empty body and an empty header list round trip as empty, not absent", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s4d", "fp-a")
		mustBegin(t, s, o, T0)
		empty := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 204, Headers: [][2]string{}, Body: []byte{}}
		if st, err := s.Complete(ctx, o, 1, empty, T0.Add(time.Millisecond)); err != nil || st != anyonce.CompleteOK {
			t.Fatalf("complete: %v %v", st, err)
		}
		out := mustBegin(t, s, o, T0.Add(2*time.Millisecond))
		if out.Kind != anyonce.BeginCompleted || out.Record == nil || out.Record.Result == nil {
			t.Fatalf("got %+v", out)
		}
		stored := out.Record.Result
		if stored.Headers == nil || len(stored.Headers) != 0 {
			t.Fatalf("an empty header list came back as %#v, want an empty non-nil slice", stored.Headers)
		}
		if stored.Body == nil || len(stored.Body) != 0 {
			t.Fatalf("an empty body came back as %#v, want an empty non-nil slice", stored.Body)
		}
	}))

	t.Run("REQ-STORE-5: lease takeover yields fence 2 and a complete with fence 1 is stale and leaves the record unchanged", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s5", "fp-a")
		expectAcquired(t, mustBegin(t, s, o, T0), 1)
		expectAcquired(t, mustBegin(t, s, o, T0.Add(Lease)), 2)
		if st, _ := s.Complete(ctx, o, 1, httpResult, T0.Add(Lease+time.Millisecond)); st != anyonce.CompleteStaleFence {
			t.Fatalf("got %v", st)
		}
		rec, err := s.Get(ctx, o.Scope, o.Key, T0.Add(Lease+2*time.Millisecond))
		if err != nil || rec == nil || rec.State != anyonce.StateInFlight || rec.Fence != 2 || rec.Result != nil || !rec.LeaseUntil.Equal(T0.Add(2*Lease)) {
			t.Fatalf("got %+v %v", rec, err)
		}
	}))

	t.Run("REQ-STORE-6: abandon removes the in-flight record and begin afterwards acquires again", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s6", "fp-a")
		mustBegin(t, s, o, T0)
		if st, _ := s.Abandon(ctx, o, 2); st != anyonce.CompleteStaleFence {
			t.Fatalf("got %v", st)
		}
		if st, _ := s.Abandon(ctx, o, 1); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		if rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(time.Millisecond)); rec != nil {
			t.Fatalf("got %+v", rec)
		}
		if st, _ := s.Abandon(ctx, o, 1); st != anyonce.CompleteNotFound {
			t.Fatalf("got %v", st)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(2*time.Millisecond)), 1)
	}))

	t.Run("REQ-STORE-7: after expiresAt begin acquires with the fence continued from the stale row", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s7a", "fp-a")
		mustBegin(t, s, o, T0)
		if _, err := s.Complete(ctx, o, 1, httpResult, T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		if rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(TTL)); rec != nil {
			t.Fatalf("expired record visible: %+v", rec)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(TTL)), 2)
		rec, _ := s.Get(ctx, o.Scope, o.Key, T0.Add(TTL+time.Millisecond))
		if rec == nil || rec.State != anyonce.StateInFlight || !rec.ExpiresAt.Equal(T0.Add(2*TTL)) {
			t.Fatalf("got %+v", rec)
		}
	}))

	t.Run("REQ-STORE-7: a ttl-expired row with a different fingerprint yields acquired", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		mustBegin(t, s, op("s7b", "fp-a"), T0)
		expectAcquired(t, mustBegin(t, s, op("s7b", "fp-b"), T0.Add(TTL)), 2)
	}))

	t.Run("REQ-STORE-7: purge returns the number of expired records removed, or 0 when the backend expires rows natively", with(func(t *testing.T, s anyonce.Store, h Harness) {
		mustBegin(t, s, op("s7c", "fp-a"), T0)
		mustBegin(t, s, op("s7d", "fp-a"), T0.Add(time.Second))
		removed, err := s.Purge(ctx, T0.Add(TTL+500*time.Millisecond))
		switch {
		case err != nil:
			t.Fatalf("purge: %v", err)
		case h.NativePurge && removed != 0:
			t.Fatalf("a native-purge store must report 0 removed, got %d", removed)
		case !h.NativePurge && removed < 1:
			t.Fatalf("removed %d", removed)
		}
		if rec, _ := s.Get(ctx, op("s7c", "fp-a").Scope, "key-s7c", T0.Add(TTL+500*time.Millisecond)); rec != nil {
			t.Fatal("s7c still visible")
		}
		if rec, _ := s.Get(ctx, op("s7d", "fp-a").Scope, "key-s7d", T0.Add(TTL+500*time.Millisecond)); rec == nil || rec.State != anyonce.StateInFlight {
			t.Fatalf("s7d %+v", rec)
		}
	}))

	t.Run("REQ-STORE-7: a physically removed row restarts the fence at 1", with(func(t *testing.T, s anyonce.Store, h Harness) {
		o := op("s7e", "fp-a")
		mustBegin(t, s, o, T0)
		mustBegin(t, s, o, T0.Add(Lease))
		if h.PhysicallyRemove != nil {
			if err := h.PhysicallyRemove(ctx, o.Scope, o.Key); err != nil {
				t.Fatal(err)
			}
		} else if _, err := s.Purge(ctx, T0.Add(TTL+Lease)); err != nil {
			t.Fatal(err)
		}
		expectAcquired(t, mustBegin(t, s, o, T0.Add(TTL+Lease)), 1)
	}))

	t.Run("REQ-STORE-8: 50 concurrent begins yield exactly one acquired and 49 in_flight, 20 iterations", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		for iteration := 0; iteration < 20; iteration++ {
			o := op(fmt.Sprintf("s8-%d", iteration), "fp-a")
			gate := make(chan struct{})
			outcomes := make([]anyonce.BeginOutcome, 50)
			errs := make([]error, 50)
			var wg sync.WaitGroup
			for i := 0; i < 50; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-gate
					outcomes[i], errs[i] = s.Begin(ctx, o, opts(T0))
				}(i)
			}
			close(gate)
			wg.Wait()
			acquired, inFlight := 0, 0
			for i := range outcomes {
				if errs[i] != nil {
					t.Fatalf("iteration %d: %v", iteration, errs[i])
				}
				switch outcomes[i].Kind {
				case anyonce.BeginAcquired:
					acquired++
				case anyonce.BeginInFlight:
					inFlight++
				}
			}
			if acquired != 1 || inFlight != 49 {
				t.Fatalf("iteration %d: acquired %d in_flight %d", iteration, acquired, inFlight)
			}
		}
	}))

	t.Run("REQ-STORE-9: the same key under two scopes yields two independent records", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		a := anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:s9-a", name, uniq), Key: "shared-key", Fingerprint: "fp-a"}
		b := anyonce.Operation{Scope: fmt.Sprintf("suite:%s:%d:s9-b", name, uniq), Key: "shared-key", Fingerprint: "fp-a"}
		expectAcquired(t, mustBegin(t, s, a, T0), 1)
		expectAcquired(t, mustBegin(t, s, b, T0), 1)
		if _, err := s.Complete(ctx, a, 1, httpResult, T0.Add(time.Millisecond)); err != nil {
			t.Fatal(err)
		}
		if out := mustBegin(t, s, b, T0.Add(2*time.Millisecond)); out.Kind != anyonce.BeginInFlight {
			t.Fatalf("b %+v", out)
		}
		if out := mustBegin(t, s, a, T0.Add(2*time.Millisecond)); out.Kind != anyonce.BeginCompleted {
			t.Fatalf("a %+v", out)
		}
	}))

	t.Run("REQ-STORE-10: the omitted form completes with resultOmitted, no body, and status and headers intact", with(func(t *testing.T, s anyonce.Store, _ Harness) {
		o := op("s10", "fp-a")
		mustBegin(t, s, o, T0)
		omitted := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"Content-Type", "application/octet-stream"}}, Omitted: true}
		if st, _ := s.Complete(ctx, o, 1, omitted, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		rec := mustBegin(t, s, o, T0.Add(2*time.Millisecond)).Record
		if rec == nil || !rec.ResultOmitted || rec.Result == nil || rec.Result.Body != nil || rec.Result.Status != 200 || len(rec.Result.Headers) != 1 {
			t.Fatalf("got %+v", rec)
		}
	}))

	t.Run("REQ-STORE-11: a body of exactly maxResultBytes round trips byte-exact", with(func(t *testing.T, s anyonce.Store, h Harness) {
		limit := h.MaxResultBytes
		if limit == 0 {
			limit = MaxResultBytes
		}
		o := op("s11", "fp-a")
		body := make([]byte, limit)
		for i := range body {
			body[i] = byte((i*31 + 7) & 0xff)
		}
		mustBegin(t, s, o, T0)
		if st, _ := s.Complete(ctx, o, 1, anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: body}, T0.Add(time.Millisecond)); st != anyonce.CompleteOK {
			t.Fatalf("got %v", st)
		}
		rec := mustBegin(t, s, o, T0.Add(2*time.Millisecond)).Record
		if rec == nil || rec.Result == nil || len(rec.Result.Body) != limit || !bytes.Equal(rec.Result.Body, body) {
			t.Fatalf("a %d byte body did not round trip", limit)
		}
	}))
}
