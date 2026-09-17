package anyonce

import (
	"context"
	"time"
)

// Operation identifies one idempotent execution: scope isolates tenants and routes, key comes from the client,
// fingerprint hashes the payload.
type Operation struct {
	Scope       string
	Key         string
	Fingerprint string
}

// State is the record state.
type State string

const (
	StateInFlight  State = "in_flight"
	StateCompleted State = "completed"
)

// Kind is the result kind.
type Kind string

const (
	KindHTTP    Kind = "http"
	KindMessage Kind = "message"
)

// Outcome is a message result outcome.
type Outcome string

const (
	OutcomeOK    Outcome = "ok"
	OutcomeError Outcome = "error"
)

// MessageError is the stored error of a message outcome.
type MessageError struct {
	Name    string
	Message string
}

// StoredResult mirrors the TypeScript StoredResult. Omitted marks the D12 form: the body was dropped because it
// exceeded the cap, while Status and Headers survive (Q7).
type StoredResult struct {
	Kind    Kind
	Status  int
	Headers [][2]string
	Body    []byte
	Outcome Outcome
	Error   *MessageError
	Omitted bool
}

// Clone returns a deep copy so callers cannot mutate store state through it.
func (r StoredResult) Clone() StoredResult {
	out := r
	if r.Headers != nil {
		out.Headers = make([][2]string, len(r.Headers))
		copy(out.Headers, r.Headers)
	}
	if r.Body != nil {
		// make plus copy, not append to a nil slice, which would turn an empty body into an absent one.
		out.Body = make([]byte, len(r.Body))
		copy(out.Body, r.Body)
	}
	if r.Error != nil {
		e := *r.Error
		out.Error = &e
	}
	return out
}

// Record is the stored idempotency record.
type Record struct {
	Scope         string
	Key           string
	Fingerprint   string
	State         State
	Fence         int64
	LeaseUntil    time.Time
	CreatedAt     time.Time
	ExpiresAt     time.Time
	Result        *StoredResult
	ResultOmitted bool
}

// Clone returns a deep copy.
func (r Record) Clone() Record {
	out := r
	if r.Result != nil {
		res := r.Result.Clone()
		out.Result = &res
	}
	return out
}

// BeginKind is the outcome of Begin.
type BeginKind string

const (
	BeginAcquired  BeginKind = "acquired"
	BeginInFlight  BeginKind = "in_flight"
	BeginCompleted BeginKind = "completed"
	BeginMismatch  BeginKind = "mismatch"
)

// BeginOutcome carries Fence for acquired, LeaseUntil for in_flight, and Record for completed and mismatch.
type BeginOutcome struct {
	Kind       BeginKind
	Fence      int64
	LeaseUntil time.Time
	Record     *Record
}

// BeginOptions are the lease, TTL and the caller's clock reading.
type BeginOptions struct {
	Lease time.Duration
	TTL   time.Duration
	Now   time.Time
}

// CompleteStatus is the result of Complete and Abandon.
type CompleteStatus string

const (
	CompleteOK         CompleteStatus = "ok"
	CompleteStaleFence CompleteStatus = "stale_fence"
	CompleteNotFound   CompleteStatus = "not_found"
)

// Store is the claim store (D3, D4, requirements 4.2). Implementations must hold to the following contract.
//
// Begin is one atomic operation: read and write happen together, never as a Get followed by a separate lock.
//
// Precedence inside Begin is TTL expiry first, then fingerprint, then state and lease. A row is live only while
// ExpiresAt is after now; a row whose ExpiresAt is equal to or before now counts as absent, so it can never
// produce a mismatch or a conflict. A present row whose fingerprint differs from the operation yields mismatch
// whatever its state or lease. A matching row in the completed state yields completed with its stored result,
// whatever its LeaseUntil. Only for a matching in_flight row does the lease decide: a live lease yields
// in_flight, an expired one is taken over.
//
// A lease is live while LeaseUntil is greater than now, so a LeaseUntil equal to now is already expired.
//
// The fence continues from the row while the row is physically present: a takeover writes old.Fence plus 1, and
// that holds across TTL expiry too, because an expired row is logically absent but physically still there. The
// fence restarts at 1 only after the row is really gone, whether by Purge, Abandon, or a backend's own sweep.
//
// now is always the caller's injected clock reading, never the store's wall time. Every expiry, lease and
// timestamp decision uses the now that was passed in, which is what makes the contract suite deterministic.
type Store interface {
	Begin(ctx context.Context, op Operation, opts BeginOptions) (BeginOutcome, error)
	Complete(ctx context.Context, op Operation, fence int64, result StoredResult, now time.Time) (CompleteStatus, error)
	Abandon(ctx context.Context, op Operation, fence int64) (CompleteStatus, error)
	Get(ctx context.Context, scope, key string, now time.Time) (*Record, error)
	Purge(ctx context.Context, now time.Time) (int, error)
}
