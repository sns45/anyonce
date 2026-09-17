// Package httpmw is the anyonce HTTP door for net/http (requirements 4.4, REQ-HTTP-18): New(store, Options).Handler(next)
// wraps a handler so that requests carrying an Idempotency-Key execute at most once per scope and key, with
// completed results replayed, in-flight duplicates answered 409, and payload mismatches answered 422.
package httpmw
