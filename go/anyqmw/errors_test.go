package anyqmw_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
)

func TestInFlightError(t *testing.T) {
	leaseUntil := time.Unix(1_700_000_030, 0)
	err := &anyqmw.InFlightError{LeaseUntil: leaseUntil, DelayMs: 4500}

	t.Run("REQ-Q-1: an in-flight error carries the lease and the delay and reaches its sentinel", func(t *testing.T) {
		if !errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatal("errors.Is did not reach ErrInFlight")
		}
		if errors.Is(err, anyqmw.ErrFingerprintMismatch) {
			t.Fatal("errors.Is reached the wrong sentinel")
		}
		var target *anyqmw.InFlightError
		if !errors.As(fmt.Errorf("wrapped: %w", err), &target) || target != err {
			t.Fatal("errors.As did not reach the concrete type through a wrapper")
		}
		if !target.LeaseUntil.Equal(leaseUntil) || target.DelayMs != 4500 {
			t.Fatalf("the error lost its lease data: %+v", target)
		}
	})

	t.Run("REQ-Q-1: an in-flight error is retryable and names no key, scope or payload", func(t *testing.T) {
		if !err.Retryable() {
			t.Fatal("an in-flight duplicate should be retryable")
		}
		message := err.Error()
		for _, secret := range []string{"m-1", "orders", "1700000030", "4500"} {
			if strings.Contains(message, secret) {
				t.Fatalf("the error message leaks %q: %s", secret, message)
			}
		}
	})

	t.Run("REQ-Q-8: an in-flight error records that a strategy translated it", func(t *testing.T) {
		fresh := &anyqmw.InFlightError{LeaseUntil: leaseUntil, DelayMs: 1}
		if fresh.Translated() {
			t.Fatal("a fresh error is already marked translated")
		}
		fresh.MarkTranslated()
		if !fresh.Translated() {
			t.Fatal("MarkTranslated did not stick")
		}
	})
}

func TestMismatchError(t *testing.T) {
	record := &anyonce.Record{Scope: "orders/workers", Key: "m-1", Fingerprint: "aa", State: anyonce.StateCompleted, Fence: 1}
	err := &anyqmw.MismatchError{Record: record}

	t.Run("REQ-Q-4: a mismatch error carries the record and reaches its sentinel", func(t *testing.T) {
		if !errors.Is(err, anyqmw.ErrFingerprintMismatch) {
			t.Fatal("errors.Is did not reach ErrFingerprintMismatch")
		}
		if errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatal("errors.Is reached the wrong sentinel")
		}
		var target *anyqmw.MismatchError
		if !errors.As(fmt.Errorf("wrapped: %w", err), &target) || target.Record != record {
			t.Fatal("errors.As did not reach the concrete type with its record")
		}
	})

	t.Run("REQ-Q-4: a mismatch error is not retryable and names no key, scope or fingerprint", func(t *testing.T) {
		if err.Retryable() {
			t.Fatal("a payload mismatch should not be retryable")
		}
		message := err.Error()
		for _, secret := range []string{"m-1", "orders", "aa"} {
			if strings.Contains(message, secret) {
				t.Fatalf("the error message leaks %q: %s", secret, message)
			}
		}
	})
}

func TestErrConfiguration(t *testing.T) {
	t.Run("REQ-Q-1: a configuration failure reaches ErrConfiguration through a wrapper", func(t *testing.T) {
		err := fmt.Errorf("%w: set Options.Scope", anyqmw.ErrConfiguration)
		if !errors.Is(err, anyqmw.ErrConfiguration) {
			t.Fatal("errors.Is did not reach ErrConfiguration")
		}
		if errors.Is(err, anyqmw.ErrInFlight) || errors.Is(err, anyqmw.ErrFingerprintMismatch) {
			t.Fatal("errors.Is reached the wrong sentinel")
		}
	})
}
