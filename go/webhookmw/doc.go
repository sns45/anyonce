// Package webhookmw is the anyonce inbound webhook door for net/http (requirements 4.6, REQ-WH-7):
// New(store, Options).Handler(next) wraps a receiver so that a delivery is processed at most once per scope and
// delivery id. Per D16 the signature check runs first, so an unverified delivery never reaches the store and an
// attacker cannot poison the dedupe table with forged ids to suppress real deliveries.
package webhookmw
