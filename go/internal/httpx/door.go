package httpx

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/sns45/anyonce/go/anyonce"
)

// errHijacked marks a handler that took the connection, which disables idempotency for the request.
var errHijacked = errors.New("httpx: connection hijacked")

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Execute re-panics (REQ-HTTP-18, REQ-WH-7).
var errPanicked = errors.New("httpx: handler panicked")

// CapResultBytes is Q20: the policy cap (the engine default when it is zero or less), lowered to what the store
// declares it can hold whole when the store implements anyonce.ResultCapper with a positive limit.
func CapResultBytes(store anyonce.Store, limit int) int {
	if limit <= 0 {
		limit = anyonce.DefaultPolicy().MaxResultBytes
	}
	if capper, ok := store.(anyonce.ResultCapper); ok {
		if declared := capper.MaxResultBytes(); declared > 0 && declared < limit {
			limit = declared
		}
	}
	return limit
}

// MethodSet is the REQ-HTTP-1 lookup set: the configured methods uppercased, or defaults when none are given.
func MethodSet(methods, defaults []string) map[string]bool {
	if len(methods) == 0 {
		methods = defaults
	}
	set := make(map[string]bool, len(methods))
	for _, m := range methods {
		set[strings.ToUpper(m)] = true
	}
	return set
}

// HeaderSet is the REQ-HTTP-8 allowlist as canonical header names. Only a nil list takes defaults, so an
// explicit empty list stores no header at all.
func HeaderSet(headers, defaults []string) map[string]bool {
	if headers == nil {
		headers = defaults
	}
	set := make(map[string]bool, len(headers))
	for _, h := range headers {
		set[http.CanonicalHeaderKey(h)] = true
	}
	return set
}

// Door is the part of an HTTP shaped door that does not depend on where its key, scope and fingerprint come
// from: the store, the resolved policy, the stored header allowlist and the problem writer. Each door resolves
// its own operation and then hands it to Execute.
type Door struct {
	// Name prefixes the plain text bodies of the few failures that are not problem documents.
	Name string
	// Store is the idempotency store the engine runs against.
	Store anyonce.Store
	// Policy is the engine policy, with MaxResultBytes already capped by CapResultBytes.
	Policy anyonce.Policy
	// StoreHeaders is the allowlist the captured response is stored under (REQ-HTTP-8).
	StoreHeaders map[string]bool
	// Problems renders every problem document the door answers with.
	Problems ProblemWriter
	// OnMismatch, when set, fires with the stored record before the 422 is rendered (REQ-WH-5).
	OnMismatch func(r *http.Request, rec *anyonce.Record)
}

// KeyRejected settles every key status but KeyOK (REQ-HTTP-3): a missing key passes through to next unless
// required, when it is a 400 missing-key carrying a Link to docsURL; an invalid key is a 400 invalid-key with
// reason as the detail. It reports whether the request is finished, so the caller continues only on false.
func (d Door) KeyRejected(w http.ResponseWriter, r *http.Request, next http.Handler, status KeyStatus, reason string, required bool, docsURL string) bool {
	switch status {
	case KeyMissing:
		if !required {
			next.ServeHTTP(w, r)
			return true
		}
		d.Problems.Fail(w, r, CodeMissingKey, "", http.Header{"Link": {"<" + docsURL + ">; rel=\"describedby\""}})
		return true
	case KeyInvalid:
		d.Problems.Fail(w, r, CodeInvalidKey, reason, nil)
		return true
	case KeyOK:
	}
	return false
}

// ReadBody reads the bounded request body (REQ-HTTP-6). A body over limit is answered with a 413
// payload-too-large and any other read failure with a plain 400; either way it reports false and the request is
// finished.
func (d Door) ReadBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := ReadBody(r, limit)
	if errors.Is(err, ErrTooLarge) {
		d.Problems.Fail(w, r, CodePayloadTooLarge, "", nil)
		return nil, false
	}
	if err != nil {
		http.Error(w, d.Name+": could not read the request body", http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

// Execute runs op through the engine and writes the outcome: the handler's own response on a first run, the
// stored one on a replay (REQ-HTTP-9), and a problem for a conflict (REQ-HTTP-10), a mismatch (REQ-HTTP-11) or
// a fail-closed store error (REQ-HTTP-12). A fail-open store error marks the response Idempotency-Degraded. A
// handler panic abandons the claim and is then re-raised, so net/http's own recovery still applies, and a
// handler that hijacks the connection is left alone (REQ-HTTP-18).
func (d Door) Execute(w http.ResponseWriter, r *http.Request, next http.Handler, op anyonce.Operation) {
	// A store failure before the handler runs (fail-open) must show on the response (REQ-HTTP-12), so the hook
	// flips a flag that run reads before the handler writes anything.
	var degraded atomic.Bool
	policy := d.Policy
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
	cw := NewCaptureWriter(w, limit)

	// A handler panic is recovered here, inside run, so the engine sees a failing handler and abandons the claim
	// exactly as it does for a returned error; the panic value is replayed after the engine returns.
	var panicValue any
	res, err := anyonce.Execute(r.Context(), d.Store, op, func(ctx context.Context, fence int64) (result anyonce.StoredResult, runErr error) {
		defer func() {
			if p := recover(); p != nil {
				panicValue = p
				runErr = errPanicked
			}
		}()
		if degraded.Load() {
			w.Header().Set("Idempotency-Degraded", "true")
		}
		next.ServeHTTP(cw, r.WithContext(WithInfo(ctx, op.Key, fence)))
		if cw.Hijacked() {
			return anyonce.StoredResult{}, errHijacked
		}
		return cw.Result(d.StoreHeaders), nil
	}, policy)
	if panicValue != nil {
		panic(panicValue)
	}
	if err != nil {
		switch {
		case errors.Is(err, errHijacked):
			// The handler took over the connection; nothing left to write.
		case res.Kind == anyonce.ResultStoreError:
			d.Problems.Fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
		case !cw.WroteHeader():
			http.Error(w, d.Name+": idempotency failed", http.StatusInternalServerError)
		}
		return
	}
	switch res.Kind {
	case anyonce.ResultExecuted:
		// The handler already wrote the response through cw.
	case anyonce.ResultReplayed:
		WriteReplay(w, res.Record)
	case anyonce.ResultConflict:
		d.Problems.Fail(w, r, CodeConflict, "", http.Header{"Retry-After": {RetryAfter(res.LeaseUntil, policy)}})
	case anyonce.ResultMismatch:
		if d.OnMismatch != nil {
			d.OnMismatch(r, res.Record)
		}
		d.Problems.Fail(w, r, CodeFingerprintMismatch, "", nil)
	case anyonce.ResultStoreError:
		d.Problems.Fail(w, r, CodeStoreUnavailable, "", http.Header{"Retry-After": {"1"}})
	}
}
