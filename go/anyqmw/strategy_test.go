package anyqmw_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	"github.com/sns45/anyq/go/core"
)

func TestStrategy(t *testing.T) {
	t.Run("REQ-Q-8: an in-flight error becomes a park for the lease remainder", func(t *testing.T) {
		inFlight := &anyqmw.InFlightError{LeaseUntil: time.Unix(1_700_000_005, 0), DelayMs: 4200}
		decision, err := anyqmw.Strategy(nil).Decide(context.Background(), core.StrategyContext{Err: inFlight, Attempt: 1, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if decision.Action != core.ActionPark || decision.DelayMs != 4200 {
			t.Fatalf("decision is %+v", decision)
		}
		if !inFlight.Translated() {
			t.Fatal("the strategy did not mark the error translated")
		}
	})

	t.Run("REQ-Q-8: a mismatch becomes a dead-letter with reason fingerprint-mismatch", func(t *testing.T) {
		mismatch := &anyqmw.MismatchError{Record: &anyonce.Record{Scope: "orders", Key: "m-1"}}
		decision, err := anyqmw.Strategy(nil).Decide(context.Background(), core.StrategyContext{Err: mismatch, Attempt: 1, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if decision.Action != core.ActionDeadLetter || decision.Reason != "fingerprint-mismatch" {
			t.Fatalf("decision is %+v", decision)
		}
	})

	t.Run("REQ-Q-8: every other error is delegated to the inner strategy", func(t *testing.T) {
		boom := errors.New("the handler failed")
		var seen core.StrategyContext
		inner := core.Custom("test-inner", func(_ context.Context, sc core.StrategyContext) (core.Decision, error) {
			seen = sc
			return core.Requeue(), nil
		})
		strategy := anyqmw.Strategy(inner)
		if strategy.Name() != anyqmw.StrategyName {
			t.Fatalf("strategy name is %q, want %q", strategy.Name(), anyqmw.StrategyName)
		}
		decision, err := strategy.Decide(context.Background(), core.StrategyContext{Err: boom, Attempt: 2, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if decision.Action != core.ActionRequeue {
			t.Fatalf("decision is %+v", decision)
		}
		if !errors.Is(seen.Err, boom) || seen.Attempt != 2 || seen.MaxAttempts != 4 {
			t.Fatalf("the inner strategy saw %+v", seen)
		}
	})

	t.Run("REQ-Q-8: a nil inner strategy delegates to RetryThenDeadLetter", func(t *testing.T) {
		// A retryable anyq error is what RetryThenDeadLetter retries, so the attempt cap is the only thing
		// that can turn this into a dead letter. Below the cap it retries, at the cap it dead-letters.
		retryable := core.NewConnectionError("the broker is unreachable", nil)
		strategy := anyqmw.Strategy(nil)

		retry, err := strategy.Decide(context.Background(), core.StrategyContext{Err: retryable, Attempt: 1, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if retry.Action != core.ActionRetry {
			t.Fatalf("below the cap the decision is %+v", retry)
		}

		dead, err := strategy.Decide(context.Background(), core.StrategyContext{Err: retryable, Attempt: 4, MaxAttempts: 4})
		if err != nil {
			t.Fatal(err)
		}
		if dead.Action != core.ActionDeadLetter || dead.Reason != "max attempts exceeded" {
			t.Fatalf("at the cap the decision is %+v", dead)
		}
	})
}
