package anyonce_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

type call struct {
	method string
	fence  int64
	result anyonce.StoredResult
	opts   anyonce.BeginOptions
}

type fakeStore struct {
	begin       anyonce.BeginOutcome
	beginErr    error
	complete    anyonce.CompleteStatus
	completeErr error
	abandonErr  error
	calls       []call
}

func (f *fakeStore) Begin(ctx context.Context, _ anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	if err := ctx.Err(); err != nil {
		return anyonce.BeginOutcome{}, err
	}
	f.calls = append(f.calls, call{method: "begin", opts: opts})
	if f.beginErr != nil {
		return anyonce.BeginOutcome{}, f.beginErr
	}
	if f.begin.Kind == "" {
		return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 1}, nil
	}
	return f.begin, nil
}
func (f *fakeStore) Complete(ctx context.Context, _ anyonce.Operation, fence int64, result anyonce.StoredResult, _ time.Time) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f.calls = append(f.calls, call{method: "complete", fence: fence, result: result})
	if f.completeErr != nil {
		return "", f.completeErr
	}
	if f.complete == "" {
		return anyonce.CompleteOK, nil
	}
	return f.complete, nil
}
func (f *fakeStore) Abandon(ctx context.Context, _ anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	f.calls = append(f.calls, call{method: "abandon", fence: fence})
	if f.abandonErr != nil {
		return "", f.abandonErr
	}
	return anyonce.CompleteOK, nil
}
func (f *fakeStore) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, nil
}
func (f *fakeStore) Purge(context.Context, time.Time) (int, error) { return 0, nil }
func (f *fakeStore) named(method string) []call {
	var out []call
	for _, c := range f.calls {
		if c.method == method {
			out = append(out, c)
		}
	}
	return out
}

var (
	op       = anyonce.Operation{Scope: "POST /x", Key: "k", Fingerprint: "f"}
	okResult = anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"Content-Type", "text/plain"}}, Body: []byte{1, 2, 3}}
	record   = anyonce.Record{Scope: "POST /x", Key: "k", Fingerprint: "f", State: anyonce.StateCompleted, Fence: 1}
	fixedNow = time.UnixMilli(123).UTC()
)

func fullHooks(log *[]string) anyonce.Hooks {
	push := func(s string) { *log = append(*log, s) }
	return anyonce.Hooks{
		OnAcquired:   func(anyonce.Operation) { push("acquired") },
		OnReplayed:   func(anyonce.Operation, *anyonce.Record) { push("replayed") },
		OnConflict:   func(anyonce.Operation, time.Time) { push("conflict") },
		OnMismatch:   func(anyonce.Operation, *anyonce.Record) { push("mismatch") },
		OnStoreError: func(anyonce.Operation, error) { push("store_error") },
	}
}

func policy(mut func(*anyonce.Policy)) anyonce.Policy {
	p := anyonce.DefaultPolicy()
	p.Clock = func() time.Time { return fixedNow }
	if mut != nil {
		mut(&p)
	}
	return p
}

func run(result anyonce.StoredResult, err error, runs *int) func(context.Context) (anyonce.StoredResult, error) {
	return func(context.Context) (anyonce.StoredResult, error) {
		*runs++
		return result, err
	}
}

func TestExecute(t *testing.T) {
	ctx := context.Background()

	t.Run("REQ-CORE-1: acquired runs the handler once, completes with the result, and reports stored", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 7}}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultExecuted || !res.Stored || runs != 1 {
			t.Fatalf("%+v %v runs %d", res, err, runs)
		}
		if b := s.named("begin"); len(b) != 1 || b[0].opts.Lease != 30*time.Second || b[0].opts.TTL != 24*time.Hour || !b[0].opts.Now.Equal(fixedNow) {
			t.Fatalf("begin opts %+v", b)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].fence != 7 || c[0].result.Status != 200 {
			t.Fatalf("complete %+v", c)
		}
		if len(s.named("abandon")) != 0 || len(log) != 1 || log[0] != "acquired" {
			t.Fatalf("abandon/log %v", log)
		}
	})

	t.Run("REQ-CORE-1: completed replays without running the handler", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultReplayed || res.Record != &rec || runs != 0 || len(log) != 1 || log[0] != "replayed" {
			t.Fatalf("%+v %v runs %d log %v", res, err, runs, log)
		}
	})

	t.Run("REQ-CORE-1: in_flight yields conflict with the lease deadline", func(t *testing.T) {
		until := fixedNow.Add(time.Second)
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: until}}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultConflict || !res.LeaseUntil.Equal(until) || len(log) != 1 || log[0] != "conflict" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: mismatch yields mismatch with the record", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultMismatch || res.Record != &rec || len(log) != 1 || log[0] != "mismatch" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: a begin failure under fail-closed returns store_error wrapping ErrStoreUnavailable without running (Q16)", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		var log []string
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if !errors.Is(err, anyonce.ErrStoreUnavailable) || res.Kind != anyonce.ResultStoreError || runs != 0 || len(log) != 1 || log[0] != "store_error" {
			t.Fatalf("%+v %v runs %d log %v", res, err, runs, log)
		}
	})

	t.Run("REQ-CORE-1: a begin failure under fail-open runs the handler and reports stored false", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.OnStoreError = anyonce.FailOpen }))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(s.named("complete")) != 0 {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: a failing handler under fail-open returns the wrapped error with no claim to abandon", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		boom := errors.New("handler failed")
		res, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{}, boom, new(int)), policy(func(p *anyonce.Policy) { p.OnStoreError = anyonce.FailOpen }))
		if !errors.Is(err, boom) || res.Kind != "" || len(s.named("abandon")) != 0 || len(s.named("complete")) != 0 {
			t.Fatalf("%+v %v %+v", res, err, s.calls)
		}
	})

	t.Run("REQ-CORE-1: a failing handler abandons the record and returns the wrapped error", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 3}}
		boom := errors.New("handler failed")
		_, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{}, boom, new(int)), policy(nil))
		if !errors.Is(err, boom) || len(s.named("abandon")) != 1 || s.named("abandon")[0].fence != 3 || len(s.named("complete")) != 0 {
			t.Fatalf("%v %+v", err, s.calls)
		}
	})

	t.Run("REQ-CORE-1: when abandon also fails the handler error still wins and OnStoreError fires", func(t *testing.T) {
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 3}, abandonErr: errors.New("abandon down")}
		var log []string
		boom := errors.New("handler failed")
		_, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{}, boom, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if !errors.Is(err, boom) || len(log) != 2 || log[1] != "store_error" {
			t.Fatalf("%v %v", err, log)
		}
	})

	t.Run("REQ-CORE-1: a result the policy refuses to store is abandoned and reported stored false", func(t *testing.T) {
		s := &fakeStore{}
		res, err := anyonce.Execute(ctx, s, op, run(anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 503}, nil, new(int)), policy(nil))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(s.named("abandon")) != 1 || len(s.named("complete")) != 0 {
			t.Fatalf("%+v %v %+v", res, err, s.calls)
		}
	})

	t.Run("REQ-CORE-1: a body over MaxResultBytes completes with the omitted form, status and headers intact", func(t *testing.T) {
		s := &fakeStore{}
		big := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Headers: [][2]string{{"ETag", `"x"`}}, Body: make([]byte, 11)}
		res, err := anyonce.Execute(ctx, s, op, run(big, nil, new(int)), policy(func(p *anyonce.Policy) { p.MaxResultBytes = 10 }))
		c := s.named("complete")
		if err != nil || !res.Stored || len(c) != 1 || !c[0].result.Omitted || c[0].result.Body != nil || c[0].result.Status != 200 || len(c[0].result.Headers) != 1 {
			t.Fatalf("%+v %v %+v", res, err, c)
		}
	})

	t.Run("REQ-CORE-1: a body of exactly MaxResultBytes is stored in full", func(t *testing.T) {
		s := &fakeStore{}
		exact := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200, Body: make([]byte, 10)}
		if _, err := anyonce.Execute(ctx, s, op, run(exact, nil, new(int)), policy(func(p *anyonce.Policy) { p.MaxResultBytes = 10 })); err != nil {
			t.Fatal(err)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].result.Omitted || len(c[0].result.Body) != 10 {
			t.Fatalf("%+v", c)
		}
	})

	t.Run("REQ-CORE-1: a complete failure reports stored false and fires OnStoreError (Q15)", func(t *testing.T) {
		s := &fakeStore{completeErr: errors.New("complete down")}
		var log []string
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) { p.Hooks = fullHooks(&log) }))
		if err != nil || res.Kind != anyonce.ResultExecuted || res.Stored || len(log) != 2 || log[1] != "store_error" {
			t.Fatalf("%+v %v %v", res, err, log)
		}
	})

	t.Run("REQ-CORE-1: a stale fence at complete reports stored false", func(t *testing.T) {
		s := &fakeStore{complete: anyonce.CompleteStaleFence}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(nil))
		if err != nil || res.Stored {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: hooks that panic are recovered and counted", func(t *testing.T) {
		s := &fakeStore{}
		var count atomic.Int64
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) {
			p.Hooks = anyonce.Hooks{OnAcquired: func(anyonce.Operation) { panic("hook") }}
			p.HookErrors = &count
		}))
		if err != nil || res.Kind != anyonce.ResultExecuted || count.Load() != 1 {
			t.Fatalf("%+v %v count %d", res, err, count.Load())
		}
	})

	t.Run("REQ-CORE-1: hooks that panic without a counter are still recovered", func(t *testing.T) {
		rec := record
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}}
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), policy(func(p *anyonce.Policy) {
			p.Hooks = anyonce.Hooks{OnReplayed: func(anyonce.Operation, *anyonce.Record) { panic("hook") }}
		}))
		if err != nil || res.Kind != anyonce.ResultReplayed {
			t.Fatalf("%+v %v", res, err)
		}
	})

	t.Run("REQ-CORE-1: without a clock the engine uses time.Now and without hooks it is silent", func(t *testing.T) {
		s := &fakeStore{}
		before := time.Now()
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, new(int)), anyonce.DefaultPolicy())
		after := time.Now()
		now := s.named("begin")[0].opts.Now
		if err != nil || res.Kind != anyonce.ResultExecuted || now.Before(before) || now.After(after) {
			t.Fatalf("%+v %v %v", res, err, now)
		}
	})

	t.Run("REQ-CORE-8: a cancelled context short-circuits before begin", func(t *testing.T) {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		s := &fakeStore{}
		runs := 0
		_, err := anyonce.Execute(cancelled, s, op, run(okResult, nil, &runs), policy(nil))
		if !errors.Is(err, context.Canceled) || runs != 0 || len(s.calls) != 0 {
			t.Fatalf("%v runs %d calls %d", err, runs, len(s.calls))
		}
	})

	t.Run("REQ-CORE-8: a context cancelled during run still completes the record", func(t *testing.T) {
		cancellable, cancel := context.WithCancel(ctx)
		defer cancel()
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 4}}
		runs := 0
		handler := func(context.Context) (anyonce.StoredResult, error) {
			runs++
			cancel()
			return okResult, nil
		}
		res, err := anyonce.Execute(cancellable, s, op, handler, policy(nil))
		if err != nil || res.Kind != anyonce.ResultExecuted || !res.Stored || runs != 1 {
			t.Fatalf("%+v %v runs %d", res, err, runs)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].fence != 4 {
			t.Fatalf("complete %+v", c)
		}
	})

	t.Run("REQ-CORE-8: a context cancelled during run still abandons after a handler error", func(t *testing.T) {
		cancellable, cancel := context.WithCancel(ctx)
		defer cancel()
		s := &fakeStore{begin: anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: 5}}
		handler := func(runCtx context.Context) (anyonce.StoredResult, error) {
			cancel()
			return anyonce.StoredResult{}, runCtx.Err()
		}
		_, err := anyonce.Execute(cancellable, s, op, handler, policy(nil))
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err %v", err)
		}
		if a := s.named("abandon"); len(a) != 1 || a[0].fence != 5 {
			t.Fatalf("abandon %+v", a)
		}
	})

	t.Run("REQ-CORE-1: a zero-value Policy takes the defaults and stays idempotent", func(t *testing.T) {
		s := &fakeStore{}
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), anyonce.Policy{})
		if err != nil || res.Kind != anyonce.ResultExecuted || !res.Stored || runs != 1 {
			t.Fatalf("%+v %v runs %d", res, err, runs)
		}
		defaults := anyonce.DefaultPolicy()
		if b := s.named("begin"); len(b) != 1 || b[0].opts.Lease != defaults.Lease || b[0].opts.TTL != defaults.TTL {
			t.Fatalf("begin opts %+v", b)
		}
		if c := s.named("complete"); len(c) != 1 || c[0].result.Omitted {
			t.Fatalf("complete %+v", c)
		}
	})

	t.Run("REQ-CORE-1: a zero-value Policy fails closed on a begin failure (D13 default)", func(t *testing.T) {
		s := &fakeStore{beginErr: errors.New("down")}
		runs := 0
		res, err := anyonce.Execute(ctx, s, op, run(okResult, nil, &runs), anyonce.Policy{})
		if !errors.Is(err, anyonce.ErrStoreUnavailable) || res.Kind != anyonce.ResultStoreError || runs != 0 {
			t.Fatalf("%+v %v runs %d", res, err, runs)
		}
	})
}

func TestPolicyHelpers(t *testing.T) {
	t.Run("REQ-CORE-1: DefaultPolicy carries the 3.3 defaults", func(t *testing.T) {
		p := anyonce.DefaultPolicy()
		if p.Lease != 30*time.Second || p.TTL != 24*time.Hour || p.MaxResultBytes != 1<<20 || p.OnStoreError != anyonce.FailClosed || p.StoreResult == nil {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("REQ-CORE-1: DefaultStoreResult stores messages and http below 500 only (D6)", func(t *testing.T) {
		cases := []struct {
			in   anyonce.StoredResult
			want bool
		}{
			{anyonce.StoredResult{Kind: anyonce.KindMessage, Outcome: anyonce.OutcomeError}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 200}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 404}, true},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: 500}, false},
			{anyonce.StoredResult{Kind: anyonce.KindHTTP}, false},
		}
		for _, tc := range cases {
			if got := anyonce.DefaultStoreResult(tc.in); got != tc.want {
				t.Fatalf("%+v: got %v", tc.in, got)
			}
		}
	})
	t.Run("REQ-CORE-1: ResultSize counts body bytes and OmitBody drops the body (Q17)", func(t *testing.T) {
		if anyonce.ResultSize(okResult) != 3 || anyonce.ResultSize(anyonce.StoredResult{}) != 0 {
			t.Fatal("size")
		}
		o := anyonce.OmitBody(okResult)
		if !o.Omitted || o.Body != nil || o.Status != 200 || len(o.Headers) != 1 || o.Kind != anyonce.KindHTTP {
			t.Fatalf("%+v", o)
		}
	})
}
