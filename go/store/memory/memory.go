// Package memory is the in-process store (REQ-CORE-6) for tests and single-instance deployments.
package memory

import (
	"context"
	"sync"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Store keeps records in a map guarded by one mutex, so Begin is one atomic claim (D4).
type Store struct {
	mu      sync.Mutex
	records map[string]*anyonce.Record
}

// New returns an empty store.
func New() *Store { return &Store{records: make(map[string]*anyonce.Record)} }

func mapKey(scope, key string) string { return scope + "\x00" + key }

// Len returns the number of stored records, expired or not.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

// Begin applies the 3.2 precedence: TTL expiry (absent), then fingerprint, then lease; fence continues from a
// stale row (Q8).
func (s *Store) Begin(ctx context.Context, op anyonce.Operation, opts anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	if err := ctx.Err(); err != nil {
		return anyonce.BeginOutcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	k := mapKey(op.Scope, op.Key)
	existing := s.records[k]
	now := opts.Now
	if existing != nil && existing.ExpiresAt.After(now) {
		if existing.Fingerprint != op.Fingerprint {
			rec := existing.Clone()
			return anyonce.BeginOutcome{Kind: anyonce.BeginMismatch, Record: &rec}, nil
		}
		if existing.State == anyonce.StateCompleted {
			rec := existing.Clone()
			return anyonce.BeginOutcome{Kind: anyonce.BeginCompleted, Record: &rec}, nil
		}
		if existing.LeaseUntil.After(now) {
			return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight, LeaseUntil: existing.LeaseUntil}, nil
		}
	}
	var fence int64 = 1
	if existing != nil {
		fence = existing.Fence + 1
	}
	s.records[k] = &anyonce.Record{
		Scope: op.Scope, Key: op.Key, Fingerprint: op.Fingerprint, State: anyonce.StateInFlight, Fence: fence,
		LeaseUntil: now.Add(opts.Lease), CreatedAt: now, ExpiresAt: now.Add(opts.TTL),
	}
	return anyonce.BeginOutcome{Kind: anyonce.BeginAcquired, Fence: fence}, nil
}

// Complete stores the result (or the omitted form) when the fence matches.
func (s *Store) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.records[mapKey(op.Scope, op.Key)]
	if existing == nil || !existing.ExpiresAt.After(now) {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence != fence {
		return anyonce.CompleteStaleFence, nil
	}
	if existing.State == anyonce.StateCompleted {
		return anyonce.CompleteOK, nil
	}
	stored := result.Clone()
	if result.Omitted {
		stored.Body = nil
		existing.ResultOmitted = true
	}
	existing.State = anyonce.StateCompleted
	existing.Result = &stored
	return anyonce.CompleteOK, nil
}

// Abandon deletes an in-flight record when the fence matches.
func (s *Store) Abandon(ctx context.Context, op anyonce.Operation, fence int64) (anyonce.CompleteStatus, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	k := mapKey(op.Scope, op.Key)
	existing := s.records[k]
	if existing == nil || existing.State != anyonce.StateInFlight {
		return anyonce.CompleteNotFound, nil
	}
	if existing.Fence != fence {
		return anyonce.CompleteStaleFence, nil
	}
	delete(s.records, k)
	return anyonce.CompleteOK, nil
}

// Get returns a copy of a live record, or nil.
func (s *Store) Get(ctx context.Context, scope, key string, now time.Time) (*anyonce.Record, error) { //nolint:nilnil // nil record means absent
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing := s.records[mapKey(scope, key)]
	if existing == nil || !existing.ExpiresAt.After(now) {
		return nil, nil
	}
	rec := existing.Clone()
	return &rec, nil
}

// Purge deletes expired records and returns how many.
func (s *Store) Purge(ctx context.Context, now time.Time) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for k, rec := range s.records {
		if !rec.ExpiresAt.After(now) {
			delete(s.records, k)
			removed++
		}
	}
	return removed, nil
}

// PhysicallyRemove is a test helper simulating a native TTL sweep, so the next Begin restarts the fence at 1.
func (s *Store) PhysicallyRemove(ctx context.Context, scope, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, mapKey(scope, key))
	return nil
}
