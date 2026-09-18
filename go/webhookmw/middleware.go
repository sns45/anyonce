package webhookmw

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// errHijacked marks a handler that took the connection, which disables idempotency for the delivery.
var errHijacked = errors.New("webhookmw: connection hijacked")

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Handler re-panics (REQ-WH-7).
var errPanicked = errors.New("webhookmw: handler panicked")

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

// The RFC 9110 section 15.5.2 challenge on the one problem this door answers with a 401 (ruling 20, Q29). The
// scheme token is Signature because the credential being challenged is a Standard Webhooks signature. It
// carries no parameters: a realm would name nothing a sender could act on. The header name is the canonical
// form net/http stores, so it goes into an http.Header literal without a second canonicalization.
const (
	signatureChallengeHeader = "Www-Authenticate"
	signatureChallenge       = "Signature"
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
// configuration. It panics when Options.Scope is set together with Options.SourceID, matching httpmw.New's
// panic on RequirePrincipal without Principal: Scope replaces the computed scope whole, so a receiver given
// both would silently drop the sender identity and share one dedupe namespace between senders (ruling 18).
func New(store anyonce.Store, opts Options) *Middleware {
	if opts.Scope != nil && opts.SourceID != nil {
		panic("webhookmw: Options.Scope replaces the computed scope entirely, so Options.SourceID would never be read")
	}
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

// lookupID resolves the delivery id: the Key function when given, otherwise the IDHeader. Q25: the id becomes the
// store key, so it is length and charset checked with the lenient parser and never sf-string parsed.
func lookupID(r *http.Request, body []byte, o resolved) (string, httpx.KeyStatus, string) {
	if o.Key != nil {
		raw, ok := o.Key(r, body)
		if !ok || raw == "" {
			return "", httpx.KeyMissing, ""
		}
		parsed, err := anyonce.ParseKey(raw, anyonce.SyntaxLenient)
		if err != nil {
			return "", httpx.KeyInvalid, err.Error()
		}
		return parsed, httpx.KeyOK, ""
	}
	// Ruling 19: a header that is present but empty is a missing id, not an invalid one, which is what the
	// TypeScript receiver answers. httpx.LookupKey would hand "" to ParseKey and call it 400 invalid-key, so
	// the empty case is settled here; the HTTP door's own behaviour is deliberately left alone.
	if values := r.Header.Values(o.IDHeader); len(values) == 1 && values[0] == "" {
		return "", httpx.KeyMissing, ""
	}
	return httpx.LookupKey(r.Header, o.IDHeader, anyonce.SyntaxLenient)
}

// scope is D8 and Q24: the route pattern, plus a slash and the sender identity when SourceID yields one. Ruling
// 18: an explicit Options.Scope replaces the whole of that, which is why New refuses to be given both.
func (m *Middleware) scope(r *http.Request, body []byte) string {
	if m.opts.Scope != nil {
		return m.opts.Scope(r, body)
	}
	route := m.opts.RoutePattern
	if route == "" {
		route = r.URL.EscapedPath()
	}
	if m.opts.SourceID == nil {
		return route
	}
	source := m.opts.SourceID(r, body)
	if source == "" {
		return route
	}
	return route + "/" + source
}

// fingerprint is D9: SHA-256 over the body bytes alone for this door, so the same delivery replayed against a
// second path still matches. Options.Fingerprint overrides it.
func (m *Middleware) fingerprint(r *http.Request, body []byte) (string, error) {
	if m.opts.Fingerprint != nil {
		return m.opts.Fingerprint(r, body)
	}
	return anyonce.SHA256Hex(body), nil
}

// onSuspicious fires REQ-WH-5's hook. A hook never reaches the caller, matching the engine's rule for its own
// hooks, so a panicking hook cannot turn a 422 into a dropped connection.
func (m *Middleware) onSuspicious(r *http.Request, rec *anyonce.Record) {
	if m.opts.OnSuspicious == nil {
		return
	}
	defer func() { _ = recover() }()
	m.opts.OnSuspicious(r, rec)
}

// Handler wraps next (REQ-WH-7). The order here is load bearing (D16): the configuration check runs on every
// request before the method filter, then the bounded body read, then verification, and only a verified delivery
// goes any further. Nothing before that point touches the store, so an unverified delivery can never poison the
// dedupe table with a forged id and suppress a real one.
//
// Past the gate the receiver is the HTTP door with a webhook shaped key, scope and fingerprint: the id is
// resolved (Q25), the scope is the route plus the sender (D8 and Q24), the body is fingerprinted (D9), and the
// engine decides between running the handler, replaying (REQ-WH-3), reporting a delivery still in flight
// (REQ-WH-4) and reporting the same id with a different body (REQ-WH-5).
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
			// Ruling 20 and Q29: RFC 9110 section 15.5.2 makes a challenge a MUST on a 401. The header is
			// built per response rather than shared, so nothing can alias the value slice the writer stores.
			m.fail(w, r, CodeSignatureInvalid, "", http.Header{signatureChallengeHeader: {signatureChallenge}})
			return
		}

		key, status, reason := lookupID(r, body, m.opts)
		switch status {
		case httpx.KeyMissing:
			if !m.opts.required {
				next.ServeHTTP(w, r)
				return
			}
			m.fail(w, r, CodeMissingKey, "", http.Header{"Link": {"<" + m.opts.DocsURL + ">; rel=\"describedby\""}})
			return
		case httpx.KeyInvalid:
			m.fail(w, r, CodeInvalidKey, reason, nil)
			return
		case httpx.KeyOK:
			// handled below
		}
		fp, err := m.fingerprint(r, body)
		if err != nil {
			http.Error(w, "webhookmw: fingerprint failed", http.StatusInternalServerError)
			return
		}
		op := anyonce.Operation{Scope: m.scope(r, body), Key: key, Fingerprint: fp}

		// A store failure before the handler runs (fail-open) must show on the response, so the hook flips a
		// flag that run reads before the handler writes anything.
		var degraded atomic.Bool
		policy := m.opts.Policy
		userHook := policy.Hooks.OnStoreError
		policy.Hooks.OnStoreError = func(op anyonce.Operation, err error) {
			degraded.Store(true)
			if userHook != nil {
				userHook(op, err)
			}
		}
		limit := policy.MaxResultBytes
		if limit <= 0 {
			limit = anyonce.DefaultPolicy().MaxResultBytes
		}
		cw := httpx.NewCaptureWriter(w, limit)

		// A handler panic is recovered here, inside run, so the engine sees a failing handler and abandons the
		// claim exactly as it does for a returned error; the panic value is replayed after Execute returns so
		// net/http's own recovery still applies (REQ-WH-7).
		var panicValue any
		res, err := anyonce.Execute(r.Context(), m.store, op, func(ctx context.Context, fence int64) (result anyonce.StoredResult, runErr error) {
			defer func() {
				if p := recover(); p != nil {
					panicValue = p
					runErr = errPanicked
				}
			}()
			if degraded.Load() {
				w.Header().Set("Idempotency-Degraded", "true")
			}
			next.ServeHTTP(cw, r.WithContext(httpx.WithInfo(ctx, key, fence)))
			if cw.Hijacked() {
				return anyonce.StoredResult{}, errHijacked
			}
			return cw.Result(m.opts.storeHeaders), nil
		}, policy)
		if panicValue != nil {
			panic(panicValue)
		}
		if err != nil {
			switch {
			case errors.Is(err, errHijacked):
				// The handler took over the connection; nothing left to write.
			case res.Kind == anyonce.ResultStoreError:
				m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
			case !cw.WroteHeader():
				http.Error(w, "webhookmw: idempotency failed", http.StatusInternalServerError)
			}
			return
		}
		switch res.Kind {
		case anyonce.ResultExecuted:
			// The handler already wrote the response through cw.
		case anyonce.ResultReplayed:
			httpx.WriteReplay(w, res.Record)
		case anyonce.ResultConflict:
			m.fail(w, r, CodeConflict, "", http.Header{"Retry-After": {httpx.RetryAfter(res.LeaseUntil, policy)}})
		case anyonce.ResultMismatch:
			// REQ-WH-5: the security signal fires before the problem is rendered, and it fires whatever a user
			// supplied Policy.Hooks.OnMismatch did, because the engine recovers that hook's panics itself and
			// returns ResultMismatch regardless. Ruling 16: the one property this ordering costs is that the
			// record here may already have been seen by that user hook, since in Go it runs first, inside the
			// engine, whereas the TypeScript receiver calls onSuspicious ahead of it. Neither order lets one
			// hook suppress the other; only the TypeScript order guarantees untouched stored state.
			m.onSuspicious(r, res.Record)
			m.fail(w, r, CodeFingerprintMismatch, "", nil)
		case anyonce.ResultStoreError:
			m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		}
	})
}
