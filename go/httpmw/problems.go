package httpmw

import (
	"net/http"

	"github.com/sns45/anyonce/go/internal/httpx"
)

// Code is a D11 problem code. CodeMissingPrincipal is the Q18 addition.
type Code = httpx.Code

// Problem is an RFC 9457 problem details document with the anyonce code member (D10).
type Problem = httpx.Problem

// The D11 problem codes.
const (
	CodeMissingKey          = httpx.CodeMissingKey
	CodeInvalidKey          = httpx.CodeInvalidKey
	CodeConflict            = httpx.CodeConflict
	CodeFingerprintMismatch = httpx.CodeFingerprintMismatch
	CodePayloadTooLarge     = httpx.CodePayloadTooLarge
	CodeStoreUnavailable    = httpx.CodeStoreUnavailable
	CodeMissingPrincipal    = httpx.CodeMissingPrincipal
	CodeConfigurationError  = httpx.CodeConfigurationError
	CodeSignatureInvalid    = httpx.CodeSignatureInvalid
)

// NewProblem builds the problem for a code. detail may be empty and never carries the key value.
func NewProblem(code Code, baseURI, detail string) Problem {
	return httpx.NewProblem(code, baseURI, detail)
}

// WriteProblem writes p as application/problem+json. extra headers (Link, Retry-After) are set before the status.
func WriteProblem(w http.ResponseWriter, p Problem, extra http.Header) {
	httpx.WriteProblem(w, p, extra)
}
