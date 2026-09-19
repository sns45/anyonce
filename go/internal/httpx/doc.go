// Package httpx holds the pieces both HTTP shaped doors need: the RFC 9457 problem catalogue, key lookup,
// bounded body reads, response capture, replay and the per request context values. It is internal to
// github.com/sns45/anyonce/go, so httpmw and webhookmw share one implementation and no one else depends on it.
package httpx
