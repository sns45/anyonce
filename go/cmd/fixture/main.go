// Command fixture serves the conformance fixture with no idempotency layer.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/sns45/anyonce/go/conformance/fixture"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address, port 0 picks a free port")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}
	fmt.Printf("listening on http://%s\n", ln.Addr().String())

	srv := &http.Server{Handler: fixture.New().Handler()}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
