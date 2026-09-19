package httpmw

import (
	"encoding/json"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/internal/httpx"
)

// resolveScope applies REQ-HTTP-5: the default scope or the Scope override, with the principal appended after a
// hash. When RequirePrincipal is set and the principal is empty, it reports false.
func resolveScope(r *http.Request, o resolved) (string, bool) {
	scope := httpx.DefaultScope(r)
	if o.Scope != nil {
		scope = o.Scope(r)
	}
	if o.Principal == nil {
		return scope, true
	}
	principal := o.Principal(r)
	if principal == "" {
		if o.RequirePrincipal {
			return "", false
		}
		return scope, true
	}
	return scope + "#" + principal, true
}

// fingerprint is D9 and REQ-HTTP-6.
func fingerprint(r *http.Request, body []byte, o resolved) (string, error) {
	if o.FingerprintFunc != nil {
		return o.FingerprintFunc(r, body)
	}
	if o.Fingerprint == FingerprintJCS {
		var value any
		if err := json.Unmarshal(body, &value); err == nil {
			if canonical, err := anyonce.Canonicalize(value); err == nil {
				return anyonce.SHA256Hex([]byte(r.Method + "\n" + httpx.RequestPath(r) + "\n" + string(canonical))), nil
			}
		}
	}
	return anyonce.HTTPFingerprint(r.Method, httpx.RequestPath(r), body), nil
}
