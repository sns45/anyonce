package httpmw

import (
	"bufio"
	"bytes"
	"net"
	"net/http"
	"sort"
	"strings"

	"github.com/sns45/anyonce/go/anyonce"
)

// captureWriter streams every write to the client while buffering a copy up to limit plus one byte (REQ-HTTP-7).
// It forwards Flush, Hijack (which disables idempotency for the request) and Unwrap for http.ResponseController.
type captureWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	snapshot    http.Header
	buf         bytes.Buffer
	limit       int
	overCap     bool
	hijacked    bool
}

func (w *captureWriter) WriteHeader(code int) {
	// An informational 1xx (RFC 9110 section 15.2) is not the response: it goes out on the wire and the final
	// status is still to come, so it is never recorded and never freezes the header snapshot (REQ-HTTP-7).
	if code >= 100 && code < 200 {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	if w.wroteHeader {
		return
	}
	w.status = code
	w.wroteHeader = true
	// Headers are frozen the moment they go out on the wire; anything the handler sets afterward must not
	// leak into the stored result (REQ-HTTP-8).
	w.snapshot = w.Header().Clone()
	w.ResponseWriter.WriteHeader(code)
}

func (w *captureWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if !w.overCap {
		room := w.limit + 1 - w.buf.Len()
		if len(p) >= room {
			w.buf.Write(p[:room])
			w.overCap = true
		} else {
			w.buf.Write(p)
		}
	}
	return w.ResponseWriter.Write(p)
}

// Flush forwards to the underlying writer's Flush, or, when it is not an http.Flusher directly, through
// http.ResponseController so a writer that only supports flushing that way still streams (REQ-HTTP-18). A
// writer that supports neither leaves Flush a silent no-op, matching http.ErrNotSupported.
func (w *captureWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
		return
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *captureWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	w.hijacked = true
	return h.Hijack()
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *captureWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// result builds the StoredResult after the handler returned: allowlisted headers with lowercase names so a record
// looks the same in both languages, every value of a repeated header, never Set-Cookie, and the buffered body (over
// the cap by one byte when the response was larger).
func (w *captureWriter) result(allow map[string]bool) anyonce.StoredResult {
	status := w.status
	header := w.snapshot
	if !w.wroteHeader {
		status = http.StatusOK
		header = w.Header()
	}
	res := anyonce.StoredResult{Kind: anyonce.KindHTTP, Status: status, Headers: [][2]string{}}
	for _, name := range sortedKeys(header) {
		if name == "Set-Cookie" || !allow[name] {
			continue
		}
		lower := strings.ToLower(name)
		for _, value := range header[name] {
			res.Headers = append(res.Headers, [2]string{lower, value})
		}
	}
	res.Body = append([]byte(nil), w.buf.Bytes()...)
	return res
}

// sortedKeys returns h's header names in sorted order so result's output is deterministic.
func sortedKeys(h http.Header) []string {
	keys := make([]string, 0, len(h))
	for name := range h {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}
