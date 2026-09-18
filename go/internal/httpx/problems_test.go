package httpx_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/internal/httpx"
)

func TestProblems(t *testing.T) {
	t.Run("REQ-HTTP-13: every code maps to its D11 status", func(t *testing.T) {
		want := map[httpx.Code]int{httpx.CodeMissingKey: 400, httpx.CodeInvalidKey: 400, httpx.CodeConflict: 409, httpx.CodeFingerprintMismatch: 422, httpx.CodePayloadTooLarge: 413, httpx.CodeStoreUnavailable: 503, httpx.CodeMissingPrincipal: 500, httpx.CodeConfigurationError: 500, httpx.CodeSignatureInvalid: 401}
		for code, status := range want {
			if p := httpx.NewProblem(code, httpx.DefaultProblemBaseURI, ""); p.Status != status || p.Type != httpx.DefaultProblemBaseURI+string(code) || p.Code != code || p.Title == "" {
				t.Fatalf("%+v", p)
			}
		}
	})
	t.Run("REQ-HTTP-13: WriteProblem writes application/problem+json with the members and extra headers", func(t *testing.T) {
		rec := httptest.NewRecorder()
		httpx.WriteProblem(rec, httpx.NewProblem(httpx.CodeMissingKey, httpx.DefaultProblemBaseURI, ""), http.Header{"Link": {"<https://d.test>; rel=\"describedby\""}})
		if rec.Code != 400 || rec.Header().Get("Content-Type") != "application/problem+json" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Link") != "<https://d.test>; rel=\"describedby\"" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["code"] != "missing-key" || body["status"] != float64(400) || body["type"] != "https://in8.sh/anyonce/problems/missing-key" {
			t.Fatalf("%v", body)
		}
		if _, ok := body["detail"]; ok {
			t.Fatal("detail must be omitted when empty")
		}
	})
	t.Run("REQ-WH-2: configuration-error is a 500 and signature-invalid is a 401", func(t *testing.T) {
		if got := httpx.ProblemStatus(httpx.CodeConfigurationError); got != 500 {
			t.Fatalf("configuration-error status = %d, want 500", got)
		}
		if got := httpx.ProblemStatus(httpx.CodeSignatureInvalid); got != 401 {
			t.Fatalf("signature-invalid status = %d, want 401", got)
		}
		p := httpx.NewProblem(httpx.CodeConfigurationError, httpx.DefaultProblemBaseURI, "")
		if p.Type != "https://in8.sh/anyonce/problems/configuration-error" {
			t.Fatalf("type = %q", p.Type)
		}
	})

	t.Run("REQ-WH-2: the two new titles match the TypeScript catalogue byte for byte", func(t *testing.T) {
		if got := httpx.ProblemTitle(httpx.CodeConfigurationError); got != "This endpoint is not configured correctly and cannot accept the request" {
			t.Fatalf("configuration-error title = %q", got)
		}
		if got := httpx.ProblemTitle(httpx.CodeSignatureInvalid); got != "The request signature could not be verified" {
			t.Fatalf("signature-invalid title = %q", got)
		}
	})

	t.Run("REQ-WH-2: a title override replaces the title and leaves the status and the code alone", func(t *testing.T) {
		p := httpx.NewProblemWithTitle(httpx.CodeConflict, httpx.DefaultProblemBaseURI, "", "A delivery with this webhook-id is still in progress")
		if p.Title != "A delivery with this webhook-id is still in progress" || p.Status != 409 || p.Code != httpx.CodeConflict {
			t.Fatalf("problem = %+v", p)
		}
	})

	t.Run("REQ-HTTP-13: Fail hands the extra headers and Cache-Control to an OnError override, replacing not appending", func(t *testing.T) {
		rec := httptest.NewRecorder()
		rec.Header().Add("Retry-After", "stale")
		var got httpx.Problem
		pw := httpx.ProblemWriter{BaseURI: httpx.DefaultProblemBaseURI, OnError: func(w http.ResponseWriter, _ *http.Request, p httpx.Problem) {
			got = p
			w.WriteHeader(p.Status)
		}}
		pw.Fail(rec, httptest.NewRequest(http.MethodPost, "/p", nil), httpx.CodeConflict, "", http.Header{"Retry-After": {"3"}})
		if rec.Code != 409 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		if values := rec.Header().Values("Retry-After"); len(values) != 1 || values[0] != "3" {
			t.Fatalf("Retry-After %v, want the extra header to replace what was there", values)
		}
		if got.Code != httpx.CodeConflict || got.Title != httpx.ProblemTitle(httpx.CodeConflict) {
			t.Fatalf("%+v", got)
		}
	})
}
