// Package servicetest gates integration tests on a reachable service.
package servicetest

import (
	"net"
	"os"
	"testing"
	"time"
)

// Require skips the test when addr does not accept a TCP connection, unless ANYONCE_REQUIRE_SERVICES is set, in
// which case an unreachable service fails the test (CI's services job sets it).
func Require(t *testing.T, name, addr string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 1500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return
	}
	if os.Getenv("ANYONCE_REQUIRE_SERVICES") != "" {
		t.Fatalf("%s is required but %s is not reachable: %v", name, addr, err)
	}
	t.Skipf("%s not reachable on %s; run docker compose -f test/compose.yml up -d --wait", name, addr)
}
