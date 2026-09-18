package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sns45/anyonce/go/internal/httpx"
)

func TestCaptureWriter(t *testing.T) {
	t.Run("REQ-HTTP-7: passes writes through and buffers at most the cap plus one byte", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := httpx.NewCaptureWriter(rec, 5)
		w.Header().Set("Content-Type", "text/plain")
		for _, part := range []string{"aaaa", "bbbb", "cccc"} {
			if _, err := w.Write([]byte(part)); err != nil {
				t.Fatal(err)
			}
		}
		if rec.Body.String() != "aaaabbbbcccc" || rec.Code != 200 {
			t.Fatalf("%d %q", rec.Code, rec.Body.String())
		}
		// The buffer stops one byte over the cap, which is how the engine tells a capped result from an exact fit.
		res := w.Result(map[string]bool{"Content-Type": true})
		if res.Kind != "http" || res.Status != 200 || len(res.Body) != 6 || len(res.Headers) != 1 || res.Headers[0] != [2]string{"content-type", "text/plain"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-8: result keeps allowlisted headers, repeats values, and never Set-Cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := httpx.NewCaptureWriter(rec, 10)
		w.Header().Add("Link", "<a>")
		w.Header().Add("Link", "<b>")
		w.Header().Set("Set-Cookie", "a=1")
		w.Header().Set("X-Other", "1")
		w.WriteHeader(201)
		res := w.Result(map[string]bool{"Link": true, "Set-Cookie": true})
		if res.Status != 201 || len(res.Headers) != 2 || res.Headers[0] != [2]string{"link", "<a>"} || res.Headers[1] != [2]string{"link", "<b>"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-8: a header set after WriteHeader is not in the stored result", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := httpx.NewCaptureWriter(rec, 10)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(200)
		w.Header().Set("X-Late", "nope")
		res := w.Result(map[string]bool{"Content-Type": true, "X-Late": true})
		if len(res.Headers) != 1 || res.Headers[0] != [2]string{"content-type", "text/plain"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-7: a 103 Early Hints write passes through and the final status is the one captured", func(t *testing.T) {
		rec := &multiStatusWriter{ResponseRecorder: httptest.NewRecorder()}
		w := httpx.NewCaptureWriter(rec, 10)
		w.Header().Set("Link", "</s.css>; rel=preload")
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusCreated)
		if _, err := w.Write([]byte("ok")); err != nil {
			t.Fatal(err)
		}
		if len(rec.codes) != 2 || rec.codes[0] != http.StatusEarlyHints || rec.codes[len(rec.codes)-1] != http.StatusCreated {
			t.Fatalf("codes %v", rec.codes)
		}
		if rec.Code != http.StatusCreated || rec.Body.String() != "ok" {
			t.Fatalf("%d %q", rec.Code, rec.Body.String())
		}
		res := w.Result(map[string]bool{"Content-Type": true})
		if res.Status != http.StatusCreated || len(res.Headers) != 1 || res.Headers[0] != [2]string{"content-type", "text/plain"} {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("REQ-HTTP-18: Flush reaches the underlying writer and Unwrap exposes it for http.ResponseController", func(t *testing.T) {
		rec := httptest.NewRecorder()
		w := httpx.NewCaptureWriter(rec, 10)
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Fatal(err)
		}
		if !rec.Flushed {
			t.Fatal("not flushed")
		}
	})
	t.Run("REQ-HTTP-18: Flush falls back to http.ResponseController and ignores an unsupported base writer", func(t *testing.T) {
		base := &headerOnlyWriter{}
		w := httpx.NewCaptureWriter(base, 10)
		w.Flush()
		if base.status != http.StatusOK {
			t.Fatalf("status %d", base.status)
		}
	})
	t.Run("REQ-HTTP-18: WroteHeader and Hijacked report what the handler did", func(t *testing.T) {
		w := httpx.NewCaptureWriter(httptest.NewRecorder(), 10)
		if w.WroteHeader() || w.Hijacked() {
			t.Fatal("nothing has been written yet")
		}
		w.WriteHeader(204)
		if !w.WroteHeader() {
			t.Fatal("expected WroteHeader after WriteHeader")
		}
		if _, _, err := w.Hijack(); err != http.ErrNotSupported {
			t.Fatalf("hijack error %v", err)
		}
		if w.Hijacked() {
			t.Fatal("a refused hijack must not disable idempotency")
		}
	})
}

// headerOnlyWriter is an http.ResponseWriter that implements neither http.Flusher nor http.Hijacker, used to
// exercise CaptureWriter's http.ResponseController fallback.
type headerOnlyWriter struct {
	header http.Header
	status int
}

func (w *headerOnlyWriter) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}
func (w *headerOnlyWriter) Write(p []byte) (int, error) { return len(p), nil }
func (w *headerOnlyWriter) WriteHeader(code int)        { w.status = code }

// multiStatusWriter records every WriteHeader call. httptest.ResponseRecorder keeps only the first, which cannot
// show an informational 1xx followed by the real status.
type multiStatusWriter struct {
	*httptest.ResponseRecorder
	codes []int
}

func (w *multiStatusWriter) WriteHeader(code int) {
	w.codes = append(w.codes, code)
	// A ResponseRecorder cannot model an informational response: it would latch Code at 103 and then refuse the
	// body, so only the final status is handed to it, which is what a real writer records too.
	if code >= 100 && code < 200 {
		return
	}
	w.ResponseRecorder.WriteHeader(code)
}
