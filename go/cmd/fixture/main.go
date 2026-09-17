// Command fixture serves the conformance fixture, bare by default or behind httpmw with -idempotent.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/conformance/fixture"
	"github.com/sns45/anyonce/go/httpmw"
	"github.com/sns45/anyonce/go/store/memory"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address, port 0 picks a free port")
	idempotent := flag.Bool("idempotent", false, "mount httpmw with the memory store in front of the fixture routes")
	ttlMs := flag.Int("ttl-ms", 2000, "record TTL in milliseconds when -idempotent is set")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}
	fmt.Printf("listening on http://%s\n", ln.Addr().String())

	f := fixture.New()
	handler := f.Handler()
	if *idempotent {
		mw := httpmw.New(memory.New(), httpmw.Options{Required: true, Policy: anyonce.Policy{TTL: time.Duration(*ttlMs) * time.Millisecond}})
		mux := http.NewServeMux()
		mux.Handle("POST /reset", f.Handler())
		mux.Handle("/", mw.Handler(f.Handler()))
		handler = mux
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
