package httpmw

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProblems(t *testing.T) {
	t.Run("REQ-HTTP-13: every code maps to its D11 status", func(t *testing.T) {
		want := map[Code]int{CodeMissingKey: 400, CodeInvalidKey: 400, CodeConflict: 409, CodeFingerprintMismatch: 422, CodePayloadTooLarge: 413, CodeStoreUnavailable: 503, CodeMissingPrincipal: 500}
		for code, status := range want {
			if p := NewProblem(code, DefaultProblemBaseURI, ""); p.Status != status || p.Type != DefaultProblemBaseURI+string(code) || p.Code != code || p.Title == "" {
				t.Fatalf("%+v", p)
			}
		}
	})
	t.Run("REQ-HTTP-13: WriteProblem writes application/problem+json with the members and extra headers", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteProblem(rec, NewProblem(CodeMissingKey, DefaultProblemBaseURI, ""), http.Header{"Link": {"<https://d.test>; rel=\"describedby\""}})
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
}
