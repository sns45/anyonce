// Package anyqmw is the anyonce queue door for anyq (requirements 4.5, REQ-Q-7): Wrap(handler, Options) returns a
// core.Handler that runs the handler at most once per identity while the record is alive. The identity is the
// broker message id by default, or a header, the body fingerprint or a function of the message (REQ-Q-1), and the
// scope comes from the adapter's own metadata (Q42). Outcomes are D15 (REQ-Q-2): a completed duplicate returns nil
// without running the handler, an in-flight duplicate returns an *InFlightError unless Options.OnInFlight is
// InFlightAck, and the same identity with a different payload returns a *MismatchError (REQ-Q-4). A handler error,
// a panic or a cancelled context abandons the claim and propagates, so anyq's own retry and dead-letter policy
// applies unchanged (REQ-Q-3, REQ-Q-7). The stored record is the message outcome only, never the payload
// (REQ-Q-5).
//
// Strategy turns those two typed errors into anyq decisions, park and dead-letter (REQ-Q-8), and is exercised
// against the memory, SQS and Kafka adapters (REQ-Q-6). Without it the typed error reaches anyq's legacy path
// and Wrap warns once through Options.Warn.
//
// Which key source to choose per broker, and what each one survives, belongs in docs/queue-ids.md (REQ-DOC-9).
package anyqmw
