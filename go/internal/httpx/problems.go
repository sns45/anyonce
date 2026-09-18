package httpx

import (
	"encoding/json"
	"net/http"
)

// DefaultProblemBaseURI is the D11 base URI every problem type is built under (REQ-HTTP-13).
const DefaultProblemBaseURI = "https://in8.sh/anyonce/problems/"

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

// ProblemStatus returns the D11 status for code. The status is fixed by D11 and is not overridable.
func ProblemStatus(code Code) int { return problemStatus[code] }

// ProblemTitle returns the default D11 title for code, the string a Q23 override replaces.
func ProblemTitle(code Code) string { return problemTitle[code] }

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
	return NewProblemWithTitle(code, baseURI, detail, "")
}

// NewProblemWithTitle builds the problem for a code with a Q23 title override. An empty title keeps the D11
// default. The status and the code member are fixed by D11 and are never overridable.
func NewProblemWithTitle(code Code, baseURI, detail, title string) Problem {
	if title == "" {
		title = problemTitle[code]
	}
	return Problem{Type: baseURI + string(code), Title: title, Status: problemStatus[code], Detail: detail, Code: code}
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

// ProblemWriter renders the problems of one door: the D11 base URI it builds types under, the Q23 title
// overrides and the optional hook that renders a problem in the caller's own shape.
type ProblemWriter struct {
	// BaseURI is the D11 problem base URI every problem type is built under.
	BaseURI string
	// Titles overrides the title of individual codes (Q23). A nil map keeps the D11 defaults.
	Titles map[Code]string
	// OnError renders the problem instead of the built in writer (REQ-HTTP-13). Status and code must not change.
	OnError func(http.ResponseWriter, *http.Request, Problem)
}

// Fail writes the problem for code, honouring an OnError override and the Q23 title overrides. Extra headers and
// Cache-Control are set on the response writer before OnError runs, so an override inherits them (REQ-HTTP-13).
func (pw ProblemWriter) Fail(w http.ResponseWriter, r *http.Request, code Code, detail string, extra http.Header) {
	p := NewProblemWithTitle(code, pw.BaseURI, detail, pw.Titles[code])
	if pw.OnError != nil {
		h := w.Header()
		for name, values := range extra {
			h[http.CanonicalHeaderKey(name)] = values
		}
		h.Set("Cache-Control", "no-store")
		pw.OnError(w, r, p)
		return
	}
	WriteProblem(w, p, extra)
}
