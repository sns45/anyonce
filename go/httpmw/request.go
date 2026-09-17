package httpmw

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
)

type keyStatus int

// The three outcomes of lookupKey.
const (
	keyMissing keyStatus = iota
	keyInvalid
	keyOK
)

// errTooLarge marks a request body over MaxRequestBytes (REQ-HTTP-6).
var errTooLarge = errors.New("httpmw: request body exceeds MaxRequestBytes")

// lookupKey is REQ-HTTP-2: case-insensitive lookup; a repeated field is invalid; the reason never carries the value.
func lookupKey(h http.Header, name string, syntax anyonce.Syntax) (string, keyStatus, string) {
	values := h.Values(name)
	if len(values) == 0 {
		return "", keyMissing, ""
	}
	if len(values) > 1 {
		return "", keyInvalid, "the " + name + " header field is repeated"
	}
	key, err := anyonce.ParseKey(values[0], syntax)
	if err != nil {
		return "", keyInvalid, err.Error()
	}
	return key, keyOK, ""
}

// requestPath is D9: path plus query.
func requestPath(r *http.Request) string { return r.URL.RequestURI() }

// defaultScope is D8 without a route pattern. The path is the escaped form, so a percent encoded segment scopes
// identically in both languages (REQ-HTTP-5).
func defaultScope(r *http.Request) string { return r.Method + " " + r.URL.EscapedPath() }

// resolveScope applies REQ-HTTP-5: the default scope or the Scope override, with the principal appended after a
// hash. When RequirePrincipal is set and the principal is empty, it reports false.
func resolveScope(r *http.Request, o resolved) (string, bool) {
	scope := defaultScope(r)
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

// readBody reads at most limit bytes plus one, then re-supplies the bytes to the handler (REQ-HTTP-6).
func readBody(r *http.Request, limit int64) ([]byte, error) {
	if r.ContentLength > limit {
		return nil, errTooLarge
	}
	if r.Body == nil || r.Body == http.NoBody {
		return []byte{}, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("httpmw: read body: %w", err)
	}
	_ = r.Body.Close()
	if int64(len(body)) > limit {
		return nil, errTooLarge
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
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
				return anyonce.SHA256Hex([]byte(r.Method + "\n" + requestPath(r) + "\n" + string(canonical))), nil
			}
		}
	}
	return anyonce.HTTPFingerprint(r.Method, requestPath(r), body), nil
}
