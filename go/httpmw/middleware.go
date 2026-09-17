package httpmw

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
)

var errHijacked = errors.New("httpmw: connection hijacked")

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Handler re-panics (REQ-HTTP-18).
var errPanicked = errors.New("httpmw: handler panicked")

// Middleware is the HTTP door for net/http (REQ-HTTP-18).
type Middleware struct {
	store anyonce.Store
	opts  resolved
}

// New builds the middleware. It panics when Options.RequirePrincipal is set without Options.Principal, the
// startup-time half of REQ-HTTP-5.
func New(store anyonce.Store, opts Options) *Middleware {
	if opts.RequirePrincipal && opts.Principal == nil {
		panic("httpmw: Options.RequirePrincipal is true but Options.Principal is nil")
	}
	m := &Middleware{store: store, opts: opts.resolve()}
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
	p := NewProblem(code, m.opts.ProblemBaseURI, detail)
	if m.opts.OnError != nil {
		h := w.Header()
		for name, values := range extra {
			h[http.CanonicalHeaderKey(name)] = values
		}
		h.Set("Cache-Control", "no-store")
		m.opts.OnError(w, r, p)
		return
	}
	WriteProblem(w, p, extra)
}

func retryAfter(leaseUntil time.Time, policy anyonce.Policy) string {
	now := time.Now()
	if policy.Clock != nil {
		now = policy.Clock()
	}
	seconds := int64(math.Ceil(leaseUntil.Sub(now).Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	return strconv.FormatInt(seconds, 10)
}

// writeReplay is REQ-HTTP-9 and D12. A nil rec (which the store contract should never produce for a replayed
// result, but callers should not have to trust that) is treated as an empty 200 with the replay header.
func writeReplay(w http.ResponseWriter, rec *anyonce.Record) {
	h := w.Header()
	status := http.StatusOK
	var body []byte
	var omitted bool
	if rec != nil {
		omitted = rec.ResultOmitted
		if rec.Result != nil {
			if rec.Result.Status != 0 {
				status = rec.Result.Status
			}
			for _, kv := range rec.Result.Headers {
				h.Add(kv[0], kv[1])
			}
			if !rec.ResultOmitted {
				body = rec.Result.Body
			}
		}
	}
	h.Set("Idempotency-Replayed", "true")
	if omitted {
		h.Set("Idempotency-Replay", "omitted")
	}
	if len(body) > 0 {
		h.Set("Content-Length", strconv.Itoa(len(body)))
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Handler wraps next (REQ-HTTP-18).
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.opts.methods[r.Method] || (m.opts.Skip != nil && m.opts.Skip(r)) {
			next.ServeHTTP(w, r)
			return
		}
		key, status, reason := lookupKey(r.Header, m.opts.HeaderName, m.opts.KeySyntax)
		switch status {
		case keyMissing:
			if !m.opts.Required {
				next.ServeHTTP(w, r)
				return
			}
			m.fail(w, r, CodeMissingKey, "", http.Header{"Link": {"<" + m.opts.DocsURL + ">; rel=\"describedby\""}})
			return
		case keyInvalid:
			m.fail(w, r, CodeInvalidKey, reason, nil)
			return
		case keyOK:
			// handled below
		}
		scope, ok := resolveScope(r, m.opts)
		if !ok {
			m.fail(w, r, CodeMissingPrincipal, "", nil)
			return
		}
		body, err := readBody(r, m.opts.MaxRequestBytes)
		if errors.Is(err, errTooLarge) {
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
		cw := &captureWriter{ResponseWriter: w, limit: limit}

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
			next.ServeHTTP(cw, r.WithContext(withInfo(ctx, key, fence)))
			if cw.hijacked {
				return anyonce.StoredResult{}, errHijacked
			}
			return cw.result(m.opts.storeHeaders), nil
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
			case !cw.wroteHeader:
				http.Error(w, "httpmw: idempotency failed", http.StatusInternalServerError)
			}
			return
		}
		switch res.Kind {
		case anyonce.ResultExecuted:
			// The handler already wrote the response through cw.
		case anyonce.ResultReplayed:
			writeReplay(w, res.Record)
		case anyonce.ResultConflict:
			m.fail(w, r, CodeConflict, "", http.Header{"Retry-After": {retryAfter(res.LeaseUntil, policy)}})
		case anyonce.ResultMismatch:
			m.fail(w, r, CodeFingerprintMismatch, "", nil)
		case anyonce.ResultStoreError:
			m.fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		}
	})
}
