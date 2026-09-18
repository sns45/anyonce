package httpx

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/sns45/anyonce/go/anyonce"
)

// DefaultMaxRequestBytes is the default bound on the request body a door reads (REQ-HTTP-6).
const DefaultMaxRequestBytes = 1 << 20

// KeyStatus is the outcome of LookupKey.
type KeyStatus int

// The three outcomes of LookupKey.
const (
	KeyMissing KeyStatus = iota
	KeyInvalid
	KeyOK
)

// ErrTooLarge marks a request body over the configured limit (REQ-HTTP-6).
var ErrTooLarge = errors.New("httpx: request body exceeds the configured limit")

// LookupKey is REQ-HTTP-2: case-insensitive lookup; a repeated field is invalid; the reason never carries the value.
func LookupKey(h http.Header, name string, syntax anyonce.Syntax) (string, KeyStatus, string) {
	values := h.Values(name)
	if len(values) == 0 {
		return "", KeyMissing, ""
	}
	if len(values) > 1 {
		return "", KeyInvalid, "the " + name + " header field is repeated"
	}
	key, err := anyonce.ParseKey(values[0], syntax)
	if err != nil {
		return "", KeyInvalid, err.Error()
	}
	return key, KeyOK, ""
}

// RequestPath is D9: path plus query.
func RequestPath(r *http.Request) string { return r.URL.RequestURI() }

// DefaultScope is D8 without a route pattern. The path is the escaped form, so a percent encoded segment scopes
// identically in both languages (REQ-HTTP-5).
func DefaultScope(r *http.Request) string { return r.Method + " " + r.URL.EscapedPath() }

// ReadBody reads at most limit bytes plus one, then re-supplies the bytes to the handler (REQ-HTTP-6).
func ReadBody(r *http.Request, limit int64) ([]byte, error) {
	if r.ContentLength > limit {
		return nil, ErrTooLarge
	}
	if r.Body == nil || r.Body == http.NoBody {
		return []byte{}, nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("httpx: read body: %w", err)
	}
	_ = r.Body.Close()
	if int64(len(body)) > limit {
		return nil, ErrTooLarge
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}
