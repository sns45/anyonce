package webhookmw

import (
	"context"
	"errors"
	"net/http"
	"sync"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// The two lines the receiver ever logs, one per cause of a 500 configuration-error (Q26, ruling 12). Both are
// fixed strings: no request data, no header value, no delivery id and, for the second, no part of the
// verifier's own error, because that error can easily embed a header value or a key (NFR-2). Each has its own
// latch in Middleware, so neither cause can ever suppress the other's one line.
const (
	configurationMessage  = "anyonce: webhookmw was built with neither Verify nor VerifiedMarker, so no delivery can be accepted (REQ-WH-2)"
	verifierFailedMessage = "anyonce: the webhook verify callback failed, so no delivery can be accepted (REQ-WH-2)"
)

// The RFC 9457 detail member that tells the two causes of a 500 configuration-error apart (ruling 13). They are
// one code because they are one class of failure; detail is what distinguishes them. Neither carries request
// data, and both are byte identical to the TypeScript twin's.
const (
	detailUnconfigured   = "no verify callback or verifiedMarker is configured"
	detailVerifierFailed = "the verify callback failed"
)

// markerKey is the private context key the verified markers hang off.
type markerKey struct{}

// markerSet is the set of markers recorded on one request context.
type markerSet map[string]struct{}

// MarkVerified records that this request has been verified under the named marker (D16). The marker lives in the
// request context rather than in a header, because a header can be forged by anything that reaches the receiver
// and the whole point of the gate is that a forged delivery never claims to be verified. The returned context
// carries the markers already present, and the set is copied rather than mutated, so marking a derived context
// never reaches back into a parent another goroutine may be reading.
func MarkVerified(ctx context.Context, marker string) context.Context {
	existing, _ := ctx.Value(markerKey{}).(markerSet)
	next := make(markerSet, len(existing)+1)
	for m := range existing {
		next[m] = struct{}{}
	}
	next[marker] = struct{}{}
	return context.WithValue(ctx, markerKey{}, next)
}

// IsVerified reports whether MarkVerified was called on this context for this marker (D16).
func IsVerified(ctx context.Context, marker string) bool {
	set, ok := ctx.Value(markerKey{}).(markerSet)
	if !ok {
		return false
	}
	_, found := set[marker]
	return found
}

// Middleware is the inbound webhook door for net/http (REQ-WH-7).
type Middleware struct {
	store    anyonce.Store
	opts     resolved
	problems httpx.ProblemWriter
	// The two causes of a 500 configuration-error latch separately, so a receiver that has already reported
	// one cause still reports the other the first time it happens.
	logUnconfigured   sync.Once
	logVerifierFailed sync.Once
}

// New builds the receiver. Every Options field has a working default, so Options{Verify: ...} is a whole
// configuration.
func New(store anyonce.Store, opts Options) *Middleware {
	m := &Middleware{store: store, opts: opts.resolve()}
	m.problems = httpx.ProblemWriter{BaseURI: m.opts.ProblemBaseURI, Titles: m.opts.ProblemTitles, OnError: m.opts.OnError}
	// Q20: the policy cap never exceeds what the store says it can hold whole.
	limit := m.opts.Policy.MaxResultBytes
	if limit <= 0 {
		limit = anyonce.DefaultPolicy().MaxResultBytes
	}
	if capper, ok := store.(anyonce.ResultCapper); ok {
		if declared := capper.MaxResultBytes(); declared > 0 && declared < limit {
			limit = declared
		}
	}
	m.opts.Policy.MaxResultBytes = limit
	return m
}

// fail renders a problem, honouring an OnError override.
func (m *Middleware) fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	m.problems.Fail(w, r, code, detail, extra)
}

// configured is REQ-WH-2: a receiver with neither a Verify callback nor a marker name can never accept a
// delivery, so it accepts none.
func (m *Middleware) configured() bool {
	return m.opts.Verify != nil || m.opts.VerifiedMarker != ""
}

// verified runs the gate for one delivery. The second result is false when the verifier could not decide, which
// is a broken verifier rather than a rejected delivery and must never be answered with a 401. The verifier's
// error text is deliberately not carried out of here: it goes into neither the log line nor the problem detail,
// because a verifier error commonly quotes the header or the key it choked on (NFR-2). The caller signals the
// malfunction with a fixed message instead.
func (m *Middleware) verified(r *http.Request, body []byte) (ok bool, decided bool) {
	if m.opts.Verify != nil {
		result, err := m.opts.Verify(r, body)
		if err != nil {
			return false, false
		}
		return result, true
	}
	return IsVerified(r.Context(), m.opts.VerifiedMarker), true
}

// Handler wraps next (REQ-WH-7). The order here is load bearing (D16): the configuration check runs on every
// request before the method filter, then the bounded body read, then verification, and only a verified delivery
// goes any further. Nothing before that point touches the store, so an unverified delivery can never poison the
// dedupe table with a forged id and suppress a real one.
//
// This is the gate only. Key resolution, the scope, the fingerprint, replay, conflict, mismatch and
// OnSuspicious arrive in the next change; until then a verified delivery is passed straight to next.
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.configured() {
			// Q26: exactly one line per receiver instance, however many requests arrive.
			m.logUnconfigured.Do(func() { m.opts.Logf("%s", configurationMessage) })
			m.fail(w, r, CodeConfigurationError, detailUnconfigured, nil)
			return
		}
		if !m.opts.methods[r.Method] {
			next.ServeHTTP(w, r)
			return
		}
		body, err := httpx.ReadBody(r, m.opts.MaxRequestBytes)
		if errors.Is(err, httpx.ErrTooLarge) {
			m.fail(w, r, CodePayloadTooLarge, "", nil)
			return
		}
		if err != nil {
			http.Error(w, "webhookmw: could not read the request body", http.StatusBadRequest)
			return
		}
		ok, decided := m.verified(r, body)
		if !decided {
			// Ruling 12: a broken verifier must not produce a silent 500, so it gets its own one time line.
			m.logVerifierFailed.Do(func() { m.opts.Logf("%s", verifierFailedMessage) })
			m.fail(w, r, CodeConfigurationError, detailVerifierFailed, nil)
			return
		}
		if !ok {
			m.fail(w, r, CodeSignatureInvalid, "", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}
