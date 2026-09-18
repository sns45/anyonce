package httpmw

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

var errHijacked = errors.New("httpmw: connection hijacked")

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Handler re-panics (REQ-HTTP-18).
var errPanicked = errors.New("httpmw: handler panicked")

// Middleware is the HTTP door for net/http (REQ-HTTP-18).
type Middleware struct {
	store    anyonce.Store
	opts     resolved
	problems httpx.ProblemWriter
}

// New builds the middleware. It panics when Options.RequirePrincipal is set without Options.Principal, the
// startup-time half of REQ-HTTP-5.
func New(store anyonce.Store, opts Options) *Middleware {
	if opts.RequirePrincipal && opts.Principal == nil {
		panic("httpmw: Options.RequirePrincipal is true but Options.Principal is nil")
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

// fail renders a problem. When OnError is set, the extra headers and Cache-Control: no-store are applied to
// w.Header() first, so the hook can override them but cannot lose them (REQ-HTTP-13), matching the ruling the
// TypeScript bridge follows under a custom controller.
func (m *Middleware) fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	m.problems.Fail(w, r, code, detail, extra)
}

// Handler wraps next (REQ-HTTP-18).
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.opts.methods[r.Method] || (m.opts.Skip != nil && m.opts.Skip(r)) {
			next.ServeHTTP(w, r)
			return
		}
		key, status, reason := httpx.LookupKey(r.Header, m.opts.HeaderName, m.opts.KeySyntax)
		switch status {
		case httpx.KeyMissing:
			if !m.opts.Required {
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
		scope, ok := resolveScope(r, m.opts)
		if !ok {
			m.fail(w, r, CodeMissingPrincipal, "", nil)
			return
		}
		body, err := httpx.ReadBody(r, m.opts.MaxRequestBytes)
		if errors.Is(err, httpx.ErrTooLarge) {
			m.fail(w, r, CodePayloadTooLarge, "", nil)
			return
		}
		if err != nil {
			http.Error(w, "httpmw: could not read the request body", http.StatusBadRequest)
			return
		}
		fp, err := fingerprint(r, body, m.opts)
		if err != nil {
			http.Error(w, "httpmw: fingerprint failed", http.StatusInternalServerError)
			return
		}
		op := anyonce.Operation{Scope: scope, Key: key, Fingerprint: fp}

		// A store failure before the handler runs (fail-open) must show on the response (REQ-HTTP-12), so the
		// hook flips a flag that run reads before the handler writes anything.
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

		// A handler panic is recovered here, inside run, so the engine sees a failing handler and abandons
		// the claim exactly as it does for a returned error; the panic value is replayed after Execute
		// returns so net/http's own recovery (closing the connection or logging) still applies (REQ-HTTP-18).
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
				http.Error(w, "httpmw: idempotency failed", http.StatusInternalServerError)
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
			m.fail(w, r, CodeFingerprintMismatch, "", nil)
		case anyonce.ResultStoreError:
			m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		}
	})
}
