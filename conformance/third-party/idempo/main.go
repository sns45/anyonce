// Command idempo mounts the anyonce conformance fixture contract
// (conformance/README.md) behind github.com/eben-vranken/idempo v1.0.0.
// Used only by conformance/third-party/compose.yml; this is not a workspace
// package. /reset is the only control endpoint and stays outside idempo's
// Handler.
package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/eben-vranken/idempo"
	"github.com/eben-vranken/idempo/inmem"
)

var count atomic.Int64

func fixtureMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /counter", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"count": int(count.Load())})
	})

	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}
		ct := r.Header.Get("Content-Type")
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(body)
	})

	mux.HandleFunc("POST /status/{code}", func(w http.ResponseWriter, r *http.Request) {
		code, err := strconv.Atoi(r.PathValue("code"))
		if err != nil || code < 200 || code > 599 {
			http.Error(w, "invalid status code", http.StatusBadRequest)
			return
		}
		count.Add(1)
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(code)
		_, _ = io.WriteString(w, "status:"+strconv.Itoa(code))
	})

	mux.HandleFunc("POST /slow", func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
		if err != nil || ms < 0 {
			ms = 0
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "slept:"+strconv.Itoa(ms))
	})

	mux.HandleFunc("POST /large", func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		n, err := strconv.Atoi(r.URL.Query().Get("bytes"))
		if err != nil || n < 0 {
			n = 0
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(n))
		_, _ = io.Copy(w, bytes.NewReader(bytes.Repeat([]byte{'x'}, n)))
	})

	return mux
}

func main() {
	store := inmem.New(2*time.Second, 2*time.Second)
	mw := idempo.New(store, idempo.Options{})

	inner := fixtureMux()

	outer := http.NewServeMux()
	outer.HandleFunc("POST /reset", func(w http.ResponseWriter, _ *http.Request) {
		count.Store(0)
		w.WriteHeader(http.StatusNoContent)
	})
	outer.Handle("/", mw.Handler(inner))

	log.Println("idempo fixture listening on :3000")
	if err := http.ListenAndServe(":3000", outer); err != nil {
		log.Fatal(err)
	}
}
