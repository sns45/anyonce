package httpmw

import (
	"net/http"
	"strings"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// FingerprintMode selects the D9 fingerprint: body hashes method, path with query and the raw bytes; jcs hashes the
// RFC 8785 form of a JSON body instead of the bytes and falls back to body when the payload is not JSON.
type FingerprintMode string

// FingerprintBody and FingerprintJCS are the two D9 fingerprint modes.
const (
	FingerprintBody FingerprintMode = "body"
	FingerprintJCS  FingerprintMode = "jcs"
)

// DefaultHeaderName, DefaultMaxRequestBytes and DefaultProblemBaseURI are the Options defaults (REQ-HTTP-2,
// REQ-HTTP-6, REQ-HTTP-13). The last two are shared with the other doors and live in internal/httpx.
const (
	DefaultHeaderName      = "Idempotency-Key"
	DefaultMaxRequestBytes = httpx.DefaultMaxRequestBytes
	DefaultProblemBaseURI  = httpx.DefaultProblemBaseURI
)

// DefaultMethods are the methods the layer applies to (REQ-HTTP-1).
var DefaultMethods = []string{http.MethodPost, http.MethodPatch}

// DefaultStoreHeaders is the REQ-HTTP-8 allowlist. Set-Cookie is never stored whatever the allowlist says.
var DefaultStoreHeaders = []string{"Content-Type", "Content-Language", "Location", "ETag", "Link"}

// Options configures the middleware. Zero values take the documented defaults.
type Options struct {
	// Methods the layer applies to; others pass through (REQ-HTTP-1). Default POST and PATCH.
	Methods []string
	// HeaderName is matched case-insensitively (REQ-HTTP-2). Default Idempotency-Key.
	HeaderName string
	// Required makes a missing header a 400 missing-key; otherwise the request passes through (REQ-HTTP-3).
	Required bool
	// KeySyntax is D7: lenient (default) or strict.
	KeySyntax anyonce.Syntax
	// Scope replaces the default scope of METHOD plus path, where the path is the escaped form (REQ-HTTP-5). The
	// middleware wraps the mux, so no route pattern is known here; pass one from your router if you want
	// pattern-level scopes.
	Scope func(*http.Request) string
	// Principal is appended to the scope after a hash; an empty string means none (REQ-HTTP-5).
	Principal func(*http.Request) string
	// RequirePrincipal makes an empty principal a 500 missing-principal (Q18). New panics when it is set without Principal.
	RequirePrincipal bool
	// Fingerprint mode (D9). Default body. FingerprintFunc overrides both modes.
	Fingerprint     FingerprintMode
	FingerprintFunc func(*http.Request, []byte) (string, error)
	// MaxRequestBytes bounds the body the layer reads; larger bodies are 413 (REQ-HTTP-6). Default 1 MiB.
	MaxRequestBytes int64
	// StoreHeaders is the response header allowlist (REQ-HTTP-8).
	StoreHeaders []string
	// Policy is the engine policy (lease, TTL, cap, StoreResult, OnStoreError, Clock, Hooks). Zero values take
	// anyonce.DefaultPolicy values.
	Policy anyonce.Policy
	// ProblemBaseURI is D11. DocsURL is the Link target on a 400 missing-key; default ProblemBaseURI plus missing-key.
	ProblemBaseURI string
	DocsURL        string
	// OnError renders a problem differently (REQ-HTTP-13). Status and code must not change.
	OnError func(w http.ResponseWriter, r *http.Request, p Problem)
	// Skip opts a request out (REQ-HTTP-15).
	Skip func(*http.Request) bool
}

// resolved is Options with every default applied and lookup sets precomputed.
type resolved struct {
	Options
	methods      map[string]bool
	storeHeaders map[string]bool
}

// resolve applies the documented defaults and builds the methods and storeHeaders lookup sets.
func (o Options) resolve() resolved {
	r := resolved{Options: o, methods: map[string]bool{}, storeHeaders: map[string]bool{}}
	methods := o.Methods
	if len(methods) == 0 {
		methods = DefaultMethods
	}
	for _, m := range methods {
		r.methods[strings.ToUpper(m)] = true
	}
	headers := o.StoreHeaders
	if headers == nil {
		headers = DefaultStoreHeaders
	}
	for _, h := range headers {
		r.storeHeaders[http.CanonicalHeaderKey(h)] = true
	}
	if r.HeaderName == "" {
		r.HeaderName = DefaultHeaderName
	}
	if r.KeySyntax == "" {
		r.KeySyntax = anyonce.SyntaxLenient
	}
	if r.Fingerprint == "" {
		r.Fingerprint = FingerprintBody
	}
	if r.MaxRequestBytes <= 0 {
		r.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if r.ProblemBaseURI == "" {
		r.ProblemBaseURI = DefaultProblemBaseURI
	}
	if r.DocsURL == "" {
		r.DocsURL = r.ProblemBaseURI + string(CodeMissingKey)
	}
	return r
}
