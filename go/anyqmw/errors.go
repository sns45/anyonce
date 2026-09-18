package anyqmw

import (
	"errors"
	"sync/atomic"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

// Sentinels every caller and strategy matches with errors.Is.
var (
	// ErrInFlight marks a duplicate whose original claim is still in flight (D15).
	ErrInFlight = errors.New("anyqmw: a duplicate of this message is already being processed")
	// ErrFingerprintMismatch marks an identity that was seen with a different payload (D15).
	ErrFingerprintMismatch = errors.New("anyqmw: this message identity was seen with a different payload")
	// ErrConfiguration marks something the wrapper cannot derive and the caller must supply (Q42).
	ErrConfiguration = errors.New("anyqmw: configuration")
)

// InFlightError carries what the companion Strategy needs to park the duplicate for the lease remainder.
type InFlightError struct {
	// LeaseUntil is when the live claim's lease expires.
	LeaseUntil time.Time
	// DelayMs is the lease remainder in milliseconds, never below 1.
	DelayMs int

	translated atomic.Bool
}

// Error reports the failure. It never contains a key, a scope or a payload (NFR-2).
func (e *InFlightError) Error() string { return ErrInFlight.Error() }

// Unwrap exposes the sentinel to errors.Is.
func (e *InFlightError) Unwrap() error { return ErrInFlight }

// Retryable reports that redelivery is the right response, so a caller that classifies errors retries rather
// than drops.
func (e *InFlightError) Retryable() bool { return true }

// MarkTranslated records that a strategy turned this error into a decision (REQ-Q-8).
func (e *InFlightError) MarkTranslated() { e.translated.Store(true) }

// Translated reports whether a strategy translated this error.
func (e *InFlightError) Translated() bool { return e.translated.Load() }

// MismatchError carries the stored record whose fingerprint did not match.
type MismatchError struct {
	// Record is the record already held for this identity.
	Record *anyonce.Record
}

// Error reports the failure without naming the key or the payload (NFR-2).
func (e *MismatchError) Error() string { return ErrFingerprintMismatch.Error() }

// Unwrap exposes the sentinel to errors.Is.
func (e *MismatchError) Unwrap() error { return ErrFingerprintMismatch }

// Retryable reports that redelivery cannot help, so a strategy should dead-letter rather than retry.
func (e *MismatchError) Retryable() bool { return false }
