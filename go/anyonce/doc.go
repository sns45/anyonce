// Package anyonce is the core idempotency engine: one state machine (requirements 3.2) behind a Store whose
// Begin is a single atomic operation, plus key parsing, fingerprints and the memory store's contract.
package anyonce
