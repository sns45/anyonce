package anyqmw

import (
	"context"
	"errors"

	"github.com/sns45/anyq/go/core"
)

// StrategyName is the companion strategy's stable name. It is not one of anyq's park-free names, so a consumer
// on an adapter without native delay applies its park-downgrade policy to it (set AllowParkDowngrade there).
const StrategyName = "anyonce-idempotency"

// Strategy is REQ-Q-8 and Q2: anyq's dead-letter and delay primitives are consumer hooks reachable only through
// a decision, so Wrap returns typed errors and this strategy translates them. An in-flight duplicate parks for
// the lease remainder, a payload mismatch dead-letters with reason fingerprint-mismatch, and everything else
// goes to inner, which defaults to anyq's reference RetryThenDeadLetter when nil.
func Strategy(inner core.Strategy) core.Strategy {
	delegate := inner
	if delegate == nil {
		delegate = core.RetryThenDeadLetter(nil)
	}
	return core.Custom(StrategyName, func(ctx context.Context, sc core.StrategyContext) (core.Decision, error) {
		var inFlight *InFlightError
		if errors.As(sc.Err, &inFlight) {
			inFlight.MarkTranslated()
			return core.Park(inFlight.DelayMs), nil
		}
		if errors.Is(sc.Err, ErrFingerprintMismatch) {
			return core.DeadLetter("fingerprint-mismatch"), nil
		}
		return delegate.Decide(ctx, sc)
	})
}
