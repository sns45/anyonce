package httpmw

import (
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// Middleware is the HTTP door for net/http (REQ-HTTP-18).
type Middleware struct {
	opts resolved
	door httpx.Door
}

// New builds the middleware. It panics when Options.RequirePrincipal is set without Options.Principal, the
// startup-time half of REQ-HTTP-5.
func New(store anyonce.Store, opts Options) *Middleware {
	if opts.RequirePrincipal && opts.Principal == nil {
		panic("httpmw: Options.RequirePrincipal is true but Options.Principal is nil")
	}
	m := &Middleware{opts: opts.resolve()}
	// Q20: the policy cap never exceeds what the store says it can hold whole.
	m.opts.Policy.MaxResultBytes = httpx.CapResultBytes(store, m.opts.Policy.MaxResultBytes)
	m.door = httpx.Door{
		Name:         "httpmw",
		Store:        store,
		Policy:       m.opts.Policy,
		StoreHeaders: m.opts.storeHeaders,
		Problems:     httpx.ProblemWriter{BaseURI: m.opts.ProblemBaseURI, Titles: m.opts.ProblemTitles, OnError: m.opts.OnError},
	}
	return m
}

// fail renders a problem. When OnError is set, the extra headers and Cache-Control: no-store are applied to
// w.Header() first, so the hook can override them but cannot lose them (REQ-HTTP-13), matching the ruling the
// TypeScript bridge follows under a custom controller.
func (m *Middleware) fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	m.door.Problems.Fail(w, r, code, detail, extra)
}

// Handler wraps next (REQ-HTTP-18).
func (m *Middleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.opts.methods[r.Method] || (m.opts.Skip != nil && m.opts.Skip(r)) {
			next.ServeHTTP(w, r)
			return
		}
		key, status, reason := httpx.LookupKey(r.Header, m.opts.HeaderName, m.opts.KeySyntax)
		if m.door.KeyRejected(w, r, next, status, reason, m.opts.Required, m.opts.DocsURL) {
			return
		}
		scope, ok := resolveScope(r, m.opts)
		if !ok {
			m.fail(w, r, CodeMissingPrincipal, "", nil)
			return
		}
		body, ok := m.door.ReadBody(w, r, m.opts.MaxRequestBytes)
		if !ok {
			return
		}
		fp, err := fingerprint(r, body, m.opts)
		if err != nil {
			http.Error(w, "httpmw: fingerprint failed", http.StatusInternalServerError)
			return
		}
		m.door.Execute(w, r, next, anyonce.Operation{Scope: scope, Key: key, Fingerprint: fp})
	})
}
