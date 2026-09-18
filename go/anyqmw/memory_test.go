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
	"github.com/sns45/anyq/go/memory"
)

// REQ-Q-6 and REQ-Q-8 against the in-process anyq adapter, plus the harness the service suites in
// services_test.go reuse. The memory consumer is the adapter in this matrix with a working native park, so the
// park case here is the end to end native park: anyq re-enqueues the message after the delay and the door's
// second claim succeeds once the lease has gone. Q40: that re-enqueue mints a fresh message id, which is why
// every door in this file keys on a header.

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

func (d *driven) snapshot() state {
	d.mu.Lock()
	defer d.mu.Unlock()
	return state{
		ids:       append([]string(nil), d.st.ids...),
		errs:      append([]error(nil), d.st.errs...),
		handled:   append([]bool(nil), d.st.handled...),
		applyErrs: append([]error(nil), d.st.applyErrs...),
		ackErrs:   append([]error(nil), d.st.ackErrs...),
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
			handled, applyErr := c.ApplyStrategy(ctx, msg, err, func() error { return wrapped(ctx, msg) })
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

// wantParked asserts the delivery that met the live claim produced an in-flight error, that the strategy
// translated it into a park, and that the inner handler's runs number wantRuns with the last of them at or
// after the claim's lease expiry. Ordering two recorded instants is the assertion; no duration is measured.
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

// memoryProbe widens the memory consumer so a test can see the dead letters it routes. Bind re-points the
// embedded BaseConsumer's hook dispatch at the probe, which the adapter's constructor pointed at itself.
type memoryProbe struct {
	*memory.Consumer
	dead *deadLetters
}

func newMemoryProbe(cfg memory.Config) *memoryProbe {
	probe := &memoryProbe{Consumer: memory.NewConsumer(cfg), dead: &deadLetters{}}
	probe.Bind(probe)
	return probe
}

// DeadLetterMessage records the routing and then lets the adapter perform it.
func (p *memoryProbe) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	p.dead.add(msg.ID(), reason)
	return p.Consumer.DeadLetterMessage(ctx, msg, reason)
}

// memoryPair builds a connected producer and probe on a queue of their own, and unregisters it afterwards.
func memoryPair(t *testing.T, queueName string, strategy core.Strategy) (*memory.Producer, *memoryProbe) {
	t.Helper()
	cfg := memory.Config{
		BaseQueueConfig: core.BaseQueueConfig{Driver: core.DriverMemory, Logging: quiet(), Strategy: strategy},
		QueueName:       queueName,
	}
	producer := memory.NewProducer(cfg)
	probe := newMemoryProbe(cfg)
	ctx := context.Background()
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	if err := probe.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	t.Cleanup(func() {
		_ = probe.Disconnect(context.Background())
		_ = producer.Disconnect(context.Background())
		memory.UnregisterQueue(queueName)
	})
	return producer, probe
}

// publish sends one message carrying the producer supplied identity header.
func publish(t *testing.T, producer core.Producer, body []byte, key string) {
	t.Helper()
	headers := core.MessageHeaders{anyqmw.DefaultKeyHeader: []byte(key)}
	if _, err := producer.Publish(context.Background(), body, &core.PublishOptions{Key: "anyonce", Headers: headers}); err != nil {
		t.Fatalf("publish: %v", err)
	}
}

func TestMemoryAdapter(t *testing.T) {
	t.Run("REQ-Q-6: a memory consumer runs a wrapped handler once for a redelivered message", func(t *testing.T) {
		queueName := unique("memory-once")
		producer, probe := memoryPair(t, queueName, nil)

		claims := store.New()
		in := newInner()
		wrapped := anyqmw.Wrap(in.handler(), anyqmw.Options{Store: claims, Key: anyqmw.KeySourceHeader})
		seen := &driven{}
		settled := newSignal()
		// The first delivery is nacked back onto the queue, so the second delivery is the same message and
		// not a second publish: broker redelivery, which is what the door has to survive.
		first := func(delivery int) bool { return delivery == 1 }
		run := start(t, probe, driveWith(probe, wrapped, seen, settled, first), seen)

		body := []byte(`{"orderId":"a-1"}`)
		key := unique("memory-once-key")
		publish(t, producer, body, key)
		settled.wait(t, 2, "deliveries")
		st := run.stop(t)

		if runs := len(in.calls()); runs != 1 {
			t.Fatalf("the inner handler ran %d times, want 1", runs)
		}
		if len(st.ids) != 2 || st.ids[0] != st.ids[1] {
			t.Fatalf("delivery ids are %v, want the same id twice", st.ids)
		}
		if len(st.errs) != 0 {
			t.Fatalf("the door reported %v, want no errors", st.errs)
		}
		// The scope was derived from the adapter's own metadata, never passed in.
		record, err := claims.Get(context.Background(), queueName, key, time.Now())
		if err != nil || record == nil {
			t.Fatalf("get: %v, record %v", err, record)
		}
		if record.State != anyonce.StateCompleted || record.Result == nil || record.Result.Outcome != anyonce.OutcomeOK {
			t.Fatalf("the stored record is %+v", record)
		}
		if len(record.Result.Body) != 0 {
			t.Fatal("the stored record carries payload bytes")
		}
	})

	t.Run("REQ-Q-8: with the strategy configured, an in-flight duplicate parks and the handler waits for the lease", func(t *testing.T) {
		queueName := unique("memory-park")
		producer, probe := memoryPair(t, queueName, anyqmw.Strategy(nil))

		claims := store.New()
		body := []byte(`{"orderId":"b-1"}`)
		key := unique("memory-park-key")
		leaseUntil := claim(t, claims, queueName, key, body, 300*time.Millisecond)

		in := newInner()
		wrapped := anyqmw.Wrap(in.handler(), anyqmw.Options{Store: claims, Key: anyqmw.KeySourceHeader})
		seen := &driven{}
		settled := newSignal()
		run := start(t, probe, drive(probe, wrapped, seen, settled), seen)

		publish(t, producer, body, key)
		// The handler running at all is the end of the park: anyq re-enqueued the message and the door's
		// second claim found the lease gone.
		in.ran.wait(t, 1, "inner handler calls")
		st := run.stop(t)

		wantParked(t, st, in, leaseUntil, 1)
		wantNoDeadLetters(t, probe.dead)
	})

	t.Run("REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch", func(t *testing.T) {
		queueName := unique("memory-mismatch")
		producer, probe := memoryPair(t, queueName, anyqmw.Strategy(nil))

		claims := store.New()
		in := newInner()
		wrapped := anyqmw.Wrap(in.handler(), anyqmw.Options{Store: claims, Key: anyqmw.KeySourceHeader})
		seen := &driven{}
		settled := newSignal()
		run := start(t, probe, drive(probe, wrapped, seen, settled), seen)

		key := unique("memory-mismatch-key")
		publish(t, producer, []byte(`{"orderId":"c-1","total":1}`), key)
		settled.wait(t, 1, "deliveries")
		publish(t, producer, []byte(`{"orderId":"c-1","total":2}`), key)
		settled.wait(t, 1, "deliveries")
		st := run.stop(t)

		if runs := len(in.calls()); runs != 1 {
			t.Fatalf("the inner handler ran %d times, want 1", runs)
		}
		if len(st.errs) != 1 || !errors.Is(st.errs[0], anyqmw.ErrFingerprintMismatch) {
			t.Fatalf("the door reported %v, want one fingerprint mismatch", st.errs)
		}
		if len(st.ids) != 2 {
			t.Fatalf("delivery ids are %v, want two", st.ids)
		}
		wantOneDeadLetter(t, probe.dead, st.ids[1], "fingerprint-mismatch")
	})

	t.Run("REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated", func(t *testing.T) {
		queueName := unique("memory-untranslated")
		producer, probe := memoryPair(t, queueName, nil)

		claims := store.New()
		body := []byte(`{"orderId":"d-1"}`)
		key := unique("memory-untranslated-key")
		claim(t, claims, queueName, key, body, time.Hour)

		in := newInner()
		wrapped := anyqmw.Wrap(in.handler(), anyqmw.Options{Store: claims, Key: anyqmw.KeySourceHeader})
		seen := &driven{}
		settled := newSignal()
		run := start(t, probe, drive(probe, wrapped, seen, settled), seen)

		publish(t, producer, body, key)
		settled.wait(t, 1, "deliveries")
		st := run.stop(t)

		if runs := len(in.calls()); runs != 0 {
			t.Fatalf("the inner handler ran %d times, want 0", runs)
		}
		if len(st.handled) != 1 || st.handled[0] {
			t.Fatalf("the consumer reported handled %v, want a single false", st.handled)
		}
		var inFlight *anyqmw.InFlightError
		if len(st.errs) != 1 || !errors.As(st.errs[0], &inFlight) {
			t.Fatalf("the door reported %v, want one *InFlightError", st.errs)
		}
		if inFlight.Translated() {
			t.Fatal("no strategy was configured, yet the error was marked translated")
		}
		wantNoDeadLetters(t, probe.dead)
	})

	t.Run("REQ-Q-1: an anyq park re-enqueues with a fresh message id, which the id key source cannot follow (Q40)", func(t *testing.T) {
		queueName := unique("memory-park-id")
		producer, probe := memoryPair(t, queueName, nil)

		var mu sync.Mutex
		var ids, bodies, keys []string
		settled := newSignal()
		seen := &driven{}
		handler := func(ctx context.Context, msg core.Message) error {
			mu.Lock()
			ids = append(ids, msg.ID())
			bodies = append(bodies, string(msg.Body()))
			header, _ := msg.Headers()[anyqmw.DefaultKeyHeader]
			keys = append(keys, string(header))
			nth := len(ids)
			mu.Unlock()
			if nth == 1 {
				// The park hook is the adapter's own; this case is about what it does to the identity.
				if err := probe.ParkMessage(ctx, msg, 20); err != nil {
					t.Errorf("park: %v", err)
				}
			} else if err := msg.Ack(ctx); err != nil {
				t.Errorf("ack: %v", err)
			}
			settled.hit()
			return nil
		}
		run := start(t, probe, handler, seen)

		key := unique("memory-park-id-key")
		publish(t, producer, []byte(`{"orderId":"e-1"}`), key)
		settled.wait(t, 2, "deliveries")
		run.stop(t)

		mu.Lock()
		defer mu.Unlock()
		if len(ids) != 2 {
			t.Fatalf("saw %d deliveries, want 2", len(ids))
		}
		if ids[0] == ids[1] {
			t.Fatalf("the parked message came back with the same id %q, so the id key source would still follow it", ids[0])
		}
		if bodies[0] != bodies[1] {
			t.Fatalf("the parked message came back with a different body: %q then %q", bodies[0], bodies[1])
		}
		if keys[1] != key {
			t.Fatalf("the parked message came back with identity header %q, want %q", keys[1], key)
		}
	})
}
