package anyqmw

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyq/go/core"
)

// errPanicked marks a handler panic recovered inside the run callback so the engine abandons the claim before
// Wrap re-panics, the same shape httpmw uses (REQ-Q-7).
var errPanicked = errors.New("anyqmw: handler panicked")

const untranslatedWarning = "anyqmw: an in-flight duplicate was reported to anyq but no strategy translated it. " +
	"Configure anyqmw.Strategy on the consumer so duplicates park instead of taking the legacy retry path."

// Wrap returns a core.Handler with the same signature that runs handler at most once per identity while the
// record is alive (REQ-Q-1, REQ-Q-7). Outcomes are D15: a completed duplicate returns nil without running the
// handler, an in-flight duplicate returns an *InFlightError for the companion Strategy to park, a payload
// mismatch returns a *MismatchError for the companion Strategy to dead-letter, and a handler error or panic
// abandons the claim and propagates so anyq's own policy applies unchanged (REQ-Q-3).
//
// Wrap panics when Options.Store is nil, the startup-time half of the one required field: a nil store would
// otherwise fail on the first delivery with an unhelpful nil dereference.
func Wrap(handler core.Handler, opts Options) core.Handler {
	if opts.Store == nil {
		panic("anyqmw: Options.Store is nil")
	}
	o := opts.withDefaults()
	var mu sync.Mutex
	var pending *InFlightError
	var warned bool

	return func(ctx context.Context, msg core.Message) error {
		// Q2: the wrapper cannot see the consumer config, so it checks the previous delivery's error on the
		// next one. A strategy marks the error translated before the next delivery arrives.
		mu.Lock()
		previous := pending
		pending = nil
		if previous != nil && !previous.Translated() && !warned {
			warned = true
			mu.Unlock()
			o.Warn(untranslatedWarning)
		} else {
			mu.Unlock()
		}

		op, err := o.operation(msg)
		if err != nil {
			return err
		}

		var panicValue any
		result, err := anyonce.Execute(ctx, o.Store, op, func(ctx context.Context, _ int64) (anyonce.StoredResult, error) {
			// A handler panic is recovered here, inside run, so the engine sees a failing handler and
			// abandons the claim exactly as it does for a returned error; the panic value is replayed after
			// Execute returns so anyq's own recovery still applies (REQ-Q-7).
			var handlerErr error
			func() {
				defer func() {
					if p := recover(); p != nil {
						panicValue = p
					}
				}()
				handlerErr = handler(ctx, msg)
			}()
			if panicValue != nil {
				return anyonce.StoredResult{}, errPanicked
			}
			if handlerErr != nil {
				return anyonce.StoredResult{}, handlerErr
			}
			// A handler that swallowed a cancellation must not leave a completed record behind (REQ-Q-7).
			if ctxErr := ctx.Err(); ctxErr != nil {
				return anyonce.StoredResult{}, ctxErr
			}
			// D15: the only result a queue operation ever stores is the outcome (REQ-Q-5, Q43).
			return anyonce.StoredResult{Kind: anyonce.KindMessage, Outcome: anyonce.OutcomeOK}, nil
		}, o.Policy)
		if panicValue != nil {
			panic(panicValue)
		}
		if err != nil {
			return err
		}

		switch result.Kind {
		case anyonce.ResultExecuted, anyonce.ResultReplayed:
			return nil
		case anyonce.ResultConflict:
			if o.OnInFlight == InFlightAck {
				return nil
			}
			delayMs := int(result.LeaseUntil.Sub(o.Policy.Clock()).Milliseconds())
			if delayMs < 1 {
				delayMs = 1
			}
			inFlight := &InFlightError{LeaseUntil: result.LeaseUntil, DelayMs: delayMs}
			mu.Lock()
			pending = inFlight
			mu.Unlock()
			return inFlight
		case anyonce.ResultMismatch:
			return &MismatchError{Record: result.Record}
		default:
			return fmt.Errorf("anyqmw: unexpected engine result %q", result.Kind)
		}
	}
}
