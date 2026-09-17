package conformance

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

var barePass = []string{"core/expiry-executes-again", "core/get-ignored", "core/post-executes-once", "core/two-keys-execute-twice", "profile/5xx-not-stored"}

func TestRunVectors(t *testing.T) {
	t.Run("REQ-CONF-6: against the bare fixture only the execution-only vectors pass and nothing errors", func(t *testing.T) {
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		vectors, err := LoadVectors(DefaultVectorsDir())
		if err != nil {
			t.Fatal(err)
		}
		summary, err := RunVectors(context.Background(), srv.URL, vectors, Options{Capabilities: []string{"short-ttl"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Results) != 20 || summary.Errored != 0 || summary.NotApplicable != 0 {
			t.Fatalf("%+v", summary)
		}
		var passed []string
		for _, r := range summary.Results {
			if r.Status == "pass" {
				passed = append(passed, r.ID)
			}
		}
		sort.Strings(passed)
		if len(passed) != len(barePass) {
			t.Fatalf("passed %v", passed)
		}
		for i := range passed {
			if passed[i] != barePass[i] {
				t.Fatalf("passed %v", passed)
			}
		}
	})
	t.Run("REQ-CONF-6: a vector with an undeclared capability is not-applicable and tiers and only narrow the run", func(t *testing.T) {
		srv := httptest.NewServer(fixture.New().Handler())
		defer srv.Close()
		vectors, _ := LoadVectors(DefaultVectorsDir())
		summary, err := RunVectors(context.Background(), srv.URL, vectors, Options{Tiers: []string{"core"}, Only: []string{"core/expiry-executes-again", "core/post-executes-once", "profile/replayed-header"}})
		if err != nil {
			t.Fatal(err)
		}
		if len(summary.Results) != 2 || summary.NotApplicable != 1 || summary.Passed != 1 {
			t.Fatalf("%+v", summary)
		}
	})
	t.Run("REQ-CONF-6: a request header name goes on the wire exactly as the vector spells it", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = ln.Close() }()
		lines := make(chan []string, 1)
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				lines <- nil
				return
			}
			defer func() { _ = conn.Close() }()
			var got []string
			br := bufio.NewReader(conn)
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					break
				}
				line = strings.TrimRight(line, "\r\n")
				if line == "" {
					break
				}
				got = append(got, line)
			}
			_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
			lines <- got
		}()
		r := &runner{client: &http.Client{}, baseURL: "http://" + ln.Addr().String()}
		step := StepRequest{Method: http.MethodPost, Path: "/echo", Headers: map[string]string{"idempotency-key": "k-wire"}}
		if _, err := r.send(context.Background(), step); err != nil {
			t.Fatal(err)
		}
		sent := <-lines
		found := false
		for _, line := range sent {
			if line == "idempotency-key: k-wire" {
				found = true
			}
		}
		if !found {
			t.Fatalf("request lines %v", sent)
		}
	})
	t.Run("REQ-CONF-6: pendingOrder keeps insertion order after a group consumes only some of the pending steps", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.HandleFunc("/reset", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
		mux.HandleFunc("/echo", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
		srv := httptest.NewServer(mux)
		defer srv.Close()

		// "b" and "c" declare concurrentWith purely to mark "a" and "b" deferred and to keep the pre-loop
		// settlePending check from firing on their own turn; being deferred targets themselves (referenced
		// by "c" and "consume"), they are queued into pending rather than consuming what they declare. Only
		// "consume" actually pulls one id ("c") out of pending, leaving "a" and "b" behind for the plain
		// step "final" to flush via pendingOrder (REQ-CONF-6).
		vector := Vector{
			ID:   "synthetic/pending-order",
			Tier: "core",
			Steps: []Step{
				{ID: "a", Request: StepRequest{Method: http.MethodGet, Path: "/echo"}, Expect: StepExpect{Status: 200}},
				{ID: "b", ConcurrentWith: []string{"a"}, Request: StepRequest{Method: http.MethodGet, Path: "/echo"}, Expect: StepExpect{Status: 200}},
				{ID: "c", ConcurrentWith: []string{"b"}, Request: StepRequest{Method: http.MethodGet, Path: "/echo"}, Expect: StepExpect{Status: 200}},
				{ID: "consume", ConcurrentWith: []string{"c"}, Request: StepRequest{Method: http.MethodGet, Path: "/echo"}, Expect: StepExpect{Status: 200}},
				{ID: "final", Request: StepRequest{Method: http.MethodGet, Path: "/echo"}, Expect: StepExpect{Status: 200}},
			},
		}
		want := []string{"c", "consume", "a", "b", "final"}
		r := &runner{client: srv.Client(), baseURL: srv.URL, resetPath: "/reset", counterPath: "/counter"}
		for i := 0; i < 20; i++ {
			result := r.runVector(context.Background(), vector)
			if result.Status != "pass" {
				t.Fatalf("run %d: %+v", i, result)
			}
			ids := make([]string, len(result.Steps))
			for j, s := range result.Steps {
				ids[j] = s.StepID
			}
			if len(ids) != len(want) {
				t.Fatalf("run %d: ids %v", i, ids)
			}
			for j := range want {
				if ids[j] != want[j] {
					t.Fatalf("run %d: ids %v, want %v", i, ids, want)
				}
			}
		}
	})
}
