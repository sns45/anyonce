package anyqmw_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	store "github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
)

// The adapter independent half of the REQ-Q-6 and REQ-Q-8 suites: the barriers they wait on, the record they
// keep of every delivery, the loop that drives one consumer's own catch block, and the assertions they share.
// memory_test.go and services_test.go supply only what differs per adapter.

// settleTimeout bounds every barrier wait. It is a guard against a hung broker, never a substitute for one.
const settleTimeout = 60 * time.Second

// quiet turns an adapter's logger off so a passing run prints nothing.
func quiet() *core.LogConfig { return &core.LogConfig{Enabled: false} }

// manualAck subscribes with auto-acknowledgement off, so nothing acknowledges a delivery the strategy has
// already disposed of. Where to start reading is an adapter config concern in Go, not a subscribe option, so
// the Kafka suite sets it on the consumer group instead.
func manualAck() *core.SubscribeOptions {
	off := false
	return &core.SubscribeOptions{AutoAck: &off}
}

// unique builds a queue, topic or key name no other run can collide with.
func unique(label string) string {
	return fmt.Sprintf("anyonce-%s-%d", label, time.Now().UnixNano())
}

// signal is a counting barrier: a test waits for a number of recorded events, never for a duration.
type signal struct{ ch chan struct{} }

func newSignal() *signal { return &signal{ch: make(chan struct{}, 256)} }

// hit records one event. It is called from the consumer's goroutine.
func (s *signal) hit() { s.ch <- struct{}{} }

// wait blocks until n events have arrived, failing the test rather than hanging when they do not.
func (s *signal) wait(t *testing.T, n int, what string) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-s.ch:
		case <-time.After(settleTimeout):
			t.Fatalf("timed out after %d of %d %s", i, n, what)
		}
	}
}

// state is what one run recorded, copied out once the consumer has stopped so no assertion races the loop.
type state struct {
	ids       []string
	errs      []error
	handled   []bool
	applyErrs []error
	ackErrs   []error
	reinvokes []string
	// reinvokeErrs holds what each failed re-invocation returned, in order. A re-invocation that succeeded
	// adds nothing here, so a downgrade that took n re-invocations to reach the handler leaves n-1 entries.
	reinvokeErrs []error
}

// driven records what the consumer did with each delivery: the broker id, the error the door returned, and
// what the consumer's strategy made of that error.
type driven struct {
	mu sync.Mutex
	st state
}

func (d *driven) delivered(id string) {
	d.mu.Lock()
	d.st.ids = append(d.st.ids, id)
	d.mu.Unlock()
}

func (d *driven) failed(err error) {
	d.mu.Lock()
	d.st.errs = append(d.st.errs, err)
	d.mu.Unlock()
}

func (d *driven) applied(handled bool, err error) {
	d.mu.Lock()
	d.st.handled = append(d.st.handled, handled)
	if err != nil {
		d.st.applyErrs = append(d.st.applyErrs, err)
	}
	d.mu.Unlock()
}

func (d *driven) ackFailed(err error) {
	d.mu.Lock()
	d.st.ackErrs = append(d.st.ackErrs, err)
	d.mu.Unlock()
}

// reinvoked records that the consumer re-ran the handler in process on a delivery it already had, which is
// the park downgrade and the in-process retry. A native park never reaches it.
func (d *driven) reinvoked(id string) {
	d.mu.Lock()
	d.st.reinvokes = append(d.st.reinvokes, id)
	d.mu.Unlock()
}

// reinvokeFailed records the error a re-invocation returned. The downgrade loops on it: anyq re-runs the
// strategy on that error, so a re-invocation that still meets the live claim parks and re-invokes again.
func (d *driven) reinvokeFailed(err error) {
	d.mu.Lock()
	d.st.reinvokeErrs = append(d.st.reinvokeErrs, err)
	d.mu.Unlock()
}

func (d *driven) snapshot() state {
	d.mu.Lock()
	defer d.mu.Unlock()
	return state{
		ids:          append([]string(nil), d.st.ids...),
		errs:         append([]error(nil), d.st.errs...),
		handled:      append([]bool(nil), d.st.handled...),
		applyErrs:    append([]error(nil), d.st.applyErrs...),
		ackErrs:      append([]error(nil), d.st.ackErrs...),
		reinvokes:    append([]string(nil), d.st.reinvokes...),
		reinvokeErrs: append([]error(nil), d.st.reinvokeErrs...),
	}
}

// inner records what the handler the door protects actually did: one timestamp per call, so a park case can
// order a call against a lease instead of measuring a duration.
type inner struct {
	mu    sync.Mutex
	times []time.Time
	ran   *signal
}

func newInner() *inner { return &inner{ran: newSignal()} }

// handler is the inner handler itself. It never fails, so every error a suite records came from the door.
func (i *inner) handler() core.Handler {
	return func(context.Context, core.Message) error {
		i.mu.Lock()
		i.times = append(i.times, time.Now())
		i.mu.Unlock()
		i.ran.hit()
		return nil
	}
}

// calls returns when the inner handler ran, in order.
func (i *inner) calls() []time.Time {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]time.Time(nil), i.times...)
}

// consumer is the slice of an anyq consumer these suites drive. ApplyStrategy is exported in Go, so a test
// reaches the consumer's configured strategy without a probe; a probe is still needed to see dead letters.
type consumer interface {
	Connect(ctx context.Context) error
	Disconnect(ctx context.Context) error
	Subscribe(ctx context.Context, handler core.Handler, opts *core.SubscribeOptions) error
	ApplyStrategy(ctx context.Context, msg core.Message, handlerErr error, reinvoke func() error) (bool, error)
}

// drive is the shape of every anyq consumer's own catch block: run the wrapped handler and, on an error, hand
// it to the consumer's strategy along with a re-invocation of the same handler. Driving it here keeps the
// handled flag, which the adapters' own loops discard.
func drive(c consumer, wrapped core.Handler, seen *driven, settled *signal) core.Handler {
	return driveWith(c, wrapped, seen, settled, nil)
}

// driveWith is drive with control over how a delivery the handler completed is finished. requeue names the
// deliveries that are nacked back onto the broker instead of acknowledged, which is how the redelivery case
// gets the same message twice; a nil requeue acknowledges every one.
func driveWith(c consumer, wrapped core.Handler, seen *driven, settled *signal, requeue func(delivery int) bool) core.Handler {
	var mu sync.Mutex
	delivery := 0
	return func(ctx context.Context, msg core.Message) error {
		mu.Lock()
		delivery++
		nth := delivery
		mu.Unlock()
		seen.delivered(msg.ID())

		if err := wrapped(ctx, msg); err != nil {
			seen.failed(err)
			reinvoke := func() error {
				seen.reinvoked(msg.ID())
				reErr := wrapped(ctx, msg)
				if reErr != nil {
					seen.reinvokeFailed(reErr)
				}
				return reErr
			}
			handled, applyErr := c.ApplyStrategy(ctx, msg, err, reinvoke)
			seen.applied(handled, applyErr)
			// Once the strategy has handled the failure it has already decided the message's fate, so
			// finishing it here too would be a second disposition for one delivery.
			if handled {
				settled.hit()
				return nil
			}
		}
		if requeue != nil && requeue(nth) {
			if err := msg.Nack(ctx, true); err != nil {
				seen.ackFailed(err)
			}
		} else if err := msg.Ack(ctx); err != nil {
			seen.ackFailed(err)
		}
		settled.hit()
		return nil
	}
}

// runner owns the goroutine an anyq Subscribe call blocks in, so every suite starts and stops a consumer the
// same way and no test reads what a running loop is still writing.
type runner struct {
	cancel  context.CancelFunc
	done    chan error
	seen    *driven
	stopped bool
	final   state
}

// start connects nothing: the caller connects the consumer, because each adapter's Connect takes different
// setup. start only owns the subscription.
func start(t *testing.T, c consumer, handler core.Handler, seen *driven) *runner {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Subscribe(ctx, handler, manualAck()) }()
	r := &runner{cancel: cancel, done: done, seen: seen}
	t.Cleanup(func() { r.stop(t) })
	return r
}

// stop cancels the subscription, waits for the loop to return, and hands back everything the run recorded.
func (r *runner) stop(t *testing.T) state {
	t.Helper()
	if r.stopped {
		return r.final
	}
	r.stopped = true
	r.cancel()
	select {
	case err := <-r.done:
		if err != nil && !errors.Is(err, context.Canceled) {
			t.Errorf("the subscribe loop returned %v", err)
		}
	case <-time.After(settleTimeout):
		t.Fatal("the subscribe loop did not stop")
	}
	r.final = r.seen.snapshot()
	for _, err := range r.final.ackErrs {
		t.Errorf("a delivery could not be finished: %v", err)
	}
	for _, err := range r.final.applyErrs {
		t.Errorf("the strategy returned a fatal error: %v", err)
	}
	return r.final
}

// deadLetter is one call a consumer made to its dead-letter hook.
type deadLetter struct {
	id     string
	reason string
}

// deadLetters collects the dead-letter hook calls a probe intercepted.
type deadLetters struct {
	mu      sync.Mutex
	entries []deadLetter
}

func (d *deadLetters) add(id, reason string) {
	d.mu.Lock()
	d.entries = append(d.entries, deadLetter{id: id, reason: reason})
	d.mu.Unlock()
}

func (d *deadLetters) list() []deadLetter {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]deadLetter(nil), d.entries...)
}

// wantOneDeadLetter asserts the run routed exactly one message to the dead-letter hook, for the given id and
// reason.
func wantOneDeadLetter(t *testing.T, dead *deadLetters, id, reason string) {
	t.Helper()
	got := dead.list()
	if len(got) != 1 || got[0].id != id || got[0].reason != reason {
		t.Fatalf("dead letters are %+v, want one %s for the second delivery", got, reason)
	}
}

// wantNoDeadLetters asserts the run routed nothing to the dead-letter hook.
func wantNoDeadLetters(t *testing.T, dead *deadLetters) {
	t.Helper()
	if got := dead.list(); len(got) != 0 {
		t.Fatalf("dead letters are %+v, want none", got)
	}
}

// claim takes the identity in the store before the consumer sees the message, so the delivery meets a live
// claim and the door reports a conflict. It returns when that claim's lease expires.
func claim(t *testing.T, s *store.Store, scope, key string, body []byte, lease time.Duration) time.Time {
	t.Helper()
	now := time.Now()
	op := anyonce.Operation{Scope: scope, Key: key, Fingerprint: anyonce.SHA256Hex(body)}
	outcome, err := s.Begin(context.Background(), op, anyonce.BeginOptions{Lease: lease, TTL: time.Hour, Now: now})
	if err != nil {
		t.Fatalf("pre-claim: %v", err)
	}
	if outcome.Kind != anyonce.BeginAcquired {
		t.Fatalf("pre-claim outcome is %q, want acquired", outcome.Kind)
	}
	return now.Add(lease)
}

// wantParked asserts the delivery that met the live claim produced an in-flight error and that the strategy
// translated it into a park. The load-bearing part is the run count: the inner handler did not run on the
// delivery that met the claim, and ran exactly wantRuns times overall. The timestamp ordering below it is a
// consistency check on the store's own lease, not the proof, because leaseUntil is the same now.Add(lease)
// that was fed to the store. Nothing here measures a duration.
func wantParked(t *testing.T, st state, in *inner, leaseUntil time.Time, wantRuns int) {
	t.Helper()
	if len(st.errs) == 0 {
		t.Fatal("no delivery reported an error, so nothing met the live claim")
	}
	var inFlight *anyqmw.InFlightError
	if !errors.As(st.errs[0], &inFlight) {
		t.Fatalf("the first error is %v, want an *InFlightError", st.errs[0])
	}
	if !inFlight.Translated() {
		t.Fatal("the strategy did not mark the in-flight error translated")
	}
	if len(st.handled) == 0 || !st.handled[0] {
		t.Fatalf("the strategy reported handled %v, want true", st.handled)
	}
	times := in.calls()
	if len(times) != wantRuns {
		t.Fatalf("the inner handler ran %d times, want %d", len(times), wantRuns)
	}
	if times[wantRuns-1].Before(leaseUntil) {
		t.Fatal("the inner handler ran before the claim's lease expired")
	}
}
