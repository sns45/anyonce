package anyonce

import "errors"

var (
	// ErrConflict marks an in-flight duplicate (adapters map it to 409).
	ErrConflict = errors.New("anyonce: operation in flight")
	// ErrMismatch marks a key reused with a different payload (422).
	ErrMismatch = errors.New("anyonce: fingerprint mismatch")
	// ErrStaleFence marks a complete or abandon from a superseded lease holder.
	ErrStaleFence = errors.New("anyonce: stale fence")
	// ErrStoreUnavailable wraps a store failure under fail-closed (503).
	ErrStoreUnavailable = errors.New("anyonce: store unavailable")
	// ErrInvalidKey wraps every key syntax or validation failure (400 invalid-key).
	ErrInvalidKey = errors.New("anyonce: invalid key")
)
