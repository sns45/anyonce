package anyonce

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// StoreErrorMode is D13: fail-closed (default) or fail-open.
type StoreErrorMode string

const (
	FailClosed StoreErrorMode = "fail-closed"
	FailOpen   StoreErrorMode = "fail-open"
)

// Hooks are observability callbacks. A panicking hook is recovered and counted; it never reaches the engine.
type Hooks struct {
	OnAcquired   func(op Operation)
	OnReplayed   func(op Operation, record *Record)
	OnConflict   func(op Operation, leaseUntil time.Time)
	OnMismatch   func(op Operation, record *Record)
	OnStoreError func(op Operation, err error)
}

// Policy mirrors the TypeScript ExecutePolicy (requirements 3.3). Zero values take the defaults: a Lease, TTL or
// MaxResultBytes of zero or less becomes the DefaultPolicy value, a nil StoreResult becomes DefaultStoreResult, and an
// empty OnStoreError becomes FailClosed (D13).
// Execute normalizes its own copy, so the caller's Policy value is never modified.
type Policy struct {
	Lease          time.Duration
	TTL            time.Duration
	MaxResultBytes int
	StoreResult    func(StoredResult) bool
	OnStoreError   StoreErrorMode
	Clock          func() time.Time
	Hooks          Hooks
	HookErrors     *atomic.Int64
}

// ResultKind mirrors the TypeScript ExecuteResult union tag.
type ResultKind string

const (
	ResultExecuted   ResultKind = "executed"
	ResultReplayed   ResultKind = "replayed"
	ResultConflict   ResultKind = "conflict"
	ResultMismatch   ResultKind = "mismatch"
	ResultStoreError ResultKind = "store_error"
)

// Result is what Execute returns. Kind says which fields are meaningful: Result and Stored for executed, Record for
// replayed and mismatch, LeaseUntil for conflict, Err for store_error.
type Result struct {
	Kind       ResultKind
	Result     StoredResult
	Stored     bool
	Record     *Record
	LeaseUntil time.Time
	Err        error
}

// DefaultStoreResult is D6: store message outcomes and HTTP results below 500. A zero Status counts as 500.
func DefaultStoreResult(r StoredResult) bool {
	if r.Kind == KindMessage {
		return true
	}
	status := r.Status
	if status == 0 {
		status = 500
	}
	return status < 500
}

// DefaultPolicy returns the 3.3 defaults: 30 s lease, 24 h TTL, 1 MiB cap, fail-closed.
func DefaultPolicy() Policy {
	return Policy{Lease: 30 * time.Second, TTL: 24 * time.Hour, MaxResultBytes: 1 << 20, StoreResult: DefaultStoreResult, OnStoreError: FailClosed}
}

// ResultSize is the body length (Q17).
func ResultSize(r StoredResult) int { return len(r.Body) }

// OmitBody returns the D12 omitted form: status and headers kept, body dropped.
func OmitBody(r StoredResult) StoredResult {
	return StoredResult{Kind: r.Kind, Status: r.Status, Headers: r.Headers, Omitted: true}
}

func (p Policy) now() time.Time {
	if p.Clock != nil {
		return p.Clock()
	}
	return time.Now()
}

func (p Policy) safely(fn func()) {
	defer func() {
		if recovered := recover(); recovered != nil && p.HookErrors != nil {
			p.HookErrors.Add(1)
		}
	}()
	fn()
}

func (p Policy) storeError(op Operation, err error) {
	if p.Hooks.OnStoreError != nil {
		p.safely(func() { p.Hooks.OnStoreError(op, err) })
	}
}

func abandonQuietly(ctx context.Context, store Store, op Operation, fence int64, policy Policy) {
	if _, err := store.Abandon(ctx, op, fence); err != nil {
		policy.storeError(op, err)
	}
}

// Execute is the one state machine (requirements 3.3). It runs the handler at most once per acquired claim,
// replays completed results, and reports conflicts and mismatches through Result.Kind. Error contract (Q16):
// (Result, nil) for executed, replayed, conflict and mismatch; (Result{Kind: ResultStoreError}, err wrapping
// ErrStoreUnavailable) for a fail-closed store failure at begin; (Result{}, err wrapping the handler's error)
// when run fails, after abandoning the claim.
func Execute(ctx context.Context, store Store, op Operation, run func(ctx context.Context) (StoredResult, error), policy Policy) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	defaults := DefaultPolicy()
	if policy.Lease <= 0 {
		policy.Lease = defaults.Lease
	}
	if policy.TTL <= 0 {
		policy.TTL = defaults.TTL
	}
	if policy.MaxResultBytes <= 0 {
		policy.MaxResultBytes = defaults.MaxResultBytes
	}
	if policy.StoreResult == nil {
		policy.StoreResult = defaults.StoreResult
	}
	if policy.OnStoreError == "" {
		policy.OnStoreError = defaults.OnStoreError
	}
	// Bookkeeping must outlive the caller's context. A client disconnect is the canonical retry trigger, and a
	// record left in flight because Complete or Abandon was refused would block that retry until the lease expires.
	bookkeeping := context.WithoutCancel(ctx)
	outcome, err := store.Begin(ctx, op, BeginOptions{Lease: policy.Lease, TTL: policy.TTL, Now: policy.now()})
	if err != nil {
		policy.storeError(op, err)
		if policy.OnStoreError == FailClosed {
			wrapped := fmt.Errorf("%w: begin: %w", ErrStoreUnavailable, err)
			return Result{Kind: ResultStoreError, Err: wrapped}, wrapped
		}
		result, runErr := run(ctx)
		if runErr != nil {
			return Result{}, fmt.Errorf("anyonce: handler failed: %w", runErr)
		}
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}

	switch outcome.Kind {
	case BeginCompleted:
		if policy.Hooks.OnReplayed != nil {
			policy.safely(func() { policy.Hooks.OnReplayed(op, outcome.Record) })
		}
		return Result{Kind: ResultReplayed, Record: outcome.Record}, nil
	case BeginInFlight:
		if policy.Hooks.OnConflict != nil {
			policy.safely(func() { policy.Hooks.OnConflict(op, outcome.LeaseUntil) })
		}
		return Result{Kind: ResultConflict, LeaseUntil: outcome.LeaseUntil}, nil
	case BeginMismatch:
		if policy.Hooks.OnMismatch != nil {
			policy.safely(func() { policy.Hooks.OnMismatch(op, outcome.Record) })
		}
		return Result{Kind: ResultMismatch, Record: outcome.Record}, nil
	}

	if policy.Hooks.OnAcquired != nil {
		policy.safely(func() { policy.Hooks.OnAcquired(op) })
	}
	result, runErr := run(ctx)
	if runErr != nil {
		abandonQuietly(bookkeeping, store, op, outcome.Fence, policy)
		return Result{}, fmt.Errorf("anyonce: handler failed: %w", runErr)
	}
	if !policy.StoreResult(result) {
		abandonQuietly(bookkeeping, store, op, outcome.Fence, policy)
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}
	payload := result
	if ResultSize(result) > policy.MaxResultBytes {
		payload = OmitBody(result)
	}
	status, err := store.Complete(bookkeeping, op, outcome.Fence, payload, policy.now())
	if err != nil {
		policy.storeError(op, err)
		return Result{Kind: ResultExecuted, Result: result, Stored: false}, nil
	}
	return Result{Kind: ResultExecuted, Result: result, Stored: status == CompleteOK}, nil
}
