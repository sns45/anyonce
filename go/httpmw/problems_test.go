package httpmw_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/httpmw"
)

// The catalogue itself is proved in internal/httpx. What is proved here is that httpmw's exported delegates
// still hand their arguments through in the right order, which a transposition would otherwise pass silently.
func TestProblems(t *testing.T) {
	t.Run("REQ-HTTP-13: NewProblem builds the D11 document under the base URI it is given", func(t *testing.T) {
		p := httpmw.NewProblem(httpmw.CodeMissingKey, httpmw.DefaultProblemBaseURI, "d")
		if p.Type != httpmw.DefaultProblemBaseURI+string(httpmw.CodeMissingKey) || p.Code != httpmw.CodeMissingKey {
			t.Fatalf("%+v", p)
		}
		if p.Status != 400 || p.Detail != "d" || p.Title != "The Idempotency-Key header is required for this request" {
			t.Fatalf("%+v", p)
		}
	})
	t.Run("REQ-HTTP-13: WriteProblem writes application/problem+json with the members and extra headers", func(t *testing.T) {
		rec := httptest.NewRecorder()
		httpmw.WriteProblem(rec, httpmw.NewProblem(httpmw.CodeConflict, "https://p.test/", ""), http.Header{"Retry-After": {"3"}})
		if rec.Code != 409 || rec.Header().Get("Content-Type") != "application/problem+json" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Retry-After") != "3" {
			t.Fatalf("%d %v", rec.Code, rec.Header())
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["code"] != "conflict" || body["status"] != float64(409) || body["type"] != "https://p.test/conflict" {
			t.Fatalf("%v", body)
		}
		if _, ok := body["detail"]; ok {
			t.Fatal("detail must be omitted when empty")
		}
	})
}
