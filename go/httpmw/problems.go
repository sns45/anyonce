package httpmw

import (
	"encoding/json"
	"net/http"
)

// Code is a D11 problem code. CodeMissingPrincipal is the Q18 addition.
type Code string

// The D11 problem codes.
const (
	CodeMissingKey          Code = "missing-key"
	CodeInvalidKey          Code = "invalid-key"
	CodeConflict            Code = "conflict"
	CodeFingerprintMismatch Code = "fingerprint-mismatch"
	CodePayloadTooLarge     Code = "payload-too-large"
	CodeStoreUnavailable    Code = "store-unavailable"
	CodeMissingPrincipal    Code = "missing-principal"
)

var problemStatus = map[Code]int{
	CodeMissingKey:          http.StatusBadRequest,
	CodeInvalidKey:          http.StatusBadRequest,
	CodeConflict:            http.StatusConflict,
	CodeFingerprintMismatch: http.StatusUnprocessableEntity,
	CodePayloadTooLarge:     http.StatusRequestEntityTooLarge,
	CodeStoreUnavailable:    http.StatusServiceUnavailable,
	CodeMissingPrincipal:    http.StatusInternalServerError,
}

var problemTitle = map[Code]string{
	CodeMissingKey:          "The Idempotency-Key header is required for this request",
	CodeInvalidKey:          "The Idempotency-Key header value is not a valid key",
	CodeConflict:            "A request with this Idempotency-Key is still in progress",
	CodeFingerprintMismatch: "This Idempotency-Key was already used with a different request payload",
	CodePayloadTooLarge:     "The request body exceeds the size this idempotent endpoint accepts",
	CodeStoreUnavailable:    "The idempotency store is unavailable",
	CodeMissingPrincipal:    "The idempotency scope requires a principal and none was found",
}

// Problem is an RFC 9457 problem details document with the anyonce code member (D10).
type Problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
	Code   Code   `json:"code"`
}

// NewProblem builds the problem for a code. detail may be empty and never carries the key value.
func NewProblem(code Code, baseURI, detail string) Problem {
	return Problem{Type: baseURI + string(code), Title: problemTitle[code], Status: problemStatus[code], Detail: detail, Code: code}
}

// WriteProblem writes p as application/problem+json. extra headers (Link, Retry-After) are set before the status.
func WriteProblem(w http.ResponseWriter, p Problem, extra http.Header) {
	h := w.Header()
	for name, values := range extra {
		h[http.CanonicalHeaderKey(name)] = values
	}
	h.Set("Content-Type", "application/problem+json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}
