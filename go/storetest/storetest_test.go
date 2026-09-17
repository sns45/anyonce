package storetest_test

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/storetest"
)

// broken never acquires, violating REQ-STORE-1 on purpose.
type broken struct{}

func (broken) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{Kind: anyonce.BeginInFlight}, nil
}
func (broken) Complete(context.Context, anyonce.Operation, int64, anyonce.StoredResult, time.Time) (anyonce.CompleteStatus, error) {
	return anyonce.CompleteNotFound, nil
}
func (broken) Abandon(context.Context, anyonce.Operation, int64) (anyonce.CompleteStatus, error) {
	return anyonce.CompleteNotFound, nil
}
func (broken) Get(context.Context, string, string, time.Time) (*anyonce.Record, error) {
	return nil, nil
}
func (broken) Purge(context.Context, time.Time) (int, error) { return 0, nil }

// TestBrokenProbe only runs inside the subprocess spawned below; it is expected to fail.
func TestBrokenProbe(t *testing.T) {
	if os.Getenv("STORETEST_PROBE") != "1" {
		t.Skip("probe runs in a subprocess")
	}
	storetest.Run(t, "broken", func(*testing.T) storetest.Harness { return storetest.Harness{Store: broken{}} })
}

func TestRunFailsABrokenStore(t *testing.T) {
	t.Run("REQ-STORE-1: the suite fails a store that never acquires", func(t *testing.T) {
		cmd := exec.Command(os.Args[0], "-test.run", "^TestBrokenProbe$", "-test.v")
		cmd.Env = append(os.Environ(), "STORETEST_PROBE=1")
		out, err := cmd.CombinedOutput()
		if err == nil {
			t.Fatalf("expected the probe to fail; output:\n%s", out)
		}
		if !strings.Contains(string(out), "REQ-STORE-1") {
			t.Fatalf("probe output does not mention REQ-STORE-1:\n%s", out)
		}
	})
}
