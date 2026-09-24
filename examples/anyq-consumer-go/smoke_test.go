package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	memstore "github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

// settleTimeout bounds every barrier wait. It guards against a hung consumer and is never what a test waits on.
const settleTimeout = 30 * time.Second

// signal is a counting barrier: a test waits for a number of events, never for a duration.
type signal struct{ ch chan struct{} }

func newSignal() *signal { return &signal{ch: make(chan struct{}, 64)} }

func (s *signal) hit() { s.ch <- struct{}{} }

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

// completing signals once a claim is completed, which is when a delivery's handler has finished for good.
type completing struct {
	anyonce.Store
	completed *signal
}

func (c completing) Complete(ctx context.Context, op anyonce.Operation, fence int64, result anyonce.StoredResult, now time.Time) (anyonce.CompleteStatus, error) {
	status, err := c.Store.Complete(ctx, op, fence, result, now)
	c.completed.hit()
	return status, err
}

// run records what the example's consumer did: every error the wrapped handler returned, in order.
type run struct {
	mu   sync.Mutex
	errs []error
}

func (r *run) failed(err error) {
	r.mu.Lock()
	r.errs = append(r.errs, err)
	r.mu.Unlock()
}

func (r *run) errors() []error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]error(nil), r.errs...)
}

// startConsumer connects the example's consumer and runs its subscribe loop until the test ends. The handler
// is the one newConsumer returned, observed on the way out so the test can see the door's errors.
func startConsumer(t *testing.T, cfg config) *run {
	t.Helper()
	consumer, handler := newConsumer(cfg)
	if err := consumer.Connect(context.Background()); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
	seen := &run{}
	observed := func(ctx context.Context, msg core.Message) error {
		err := handler(ctx, msg)
		if err != nil {
			seen.failed(err)
		}
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- consumer.Subscribe(ctx, observed, nil) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Errorf("the subscribe loop returned %v", err)
			}
		case <-time.After(settleTimeout):
			t.Error("the subscribe loop did not stop")
		}
		_ = consumer.Disconnect(context.Background())
	})
	return seen
}

func producerFor(t *testing.T, queueName string) *memory.Producer {
	t.Helper()
	producer := memory.NewProducer(memory.Config{
		BaseQueueConfig: core.BaseQueueConfig{Driver: core.DriverMemory, Logging: &core.LogConfig{Enabled: false}},
		QueueName:       queueName,
	})
	if err := producer.Connect(context.Background()); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	t.Cleanup(func() {
		_ = producer.Disconnect(context.Background())
		memory.UnregisterQueue(queueName)
	})
	return producer
}

func publish(t *testing.T, producer *memory.Producer, body []byte, key string) {
	t.Helper()
	headers := core.MessageHeaders{keyHeader: []byte(key)}
	if _, err := producer.Publish(context.Background(), body, &core.PublishOptions{Headers: headers}); err != nil {
		t.Fatalf("publish: %v", err)
	}
}

func unique(label string) string { return fmt.Sprintf("orders-%s-%d", label, time.Now().UnixNano()) }

// handled records the orders the example's handler ran for, with when it ran.
type handled struct {
	mu     sync.Mutex
	orders []order
	times  []time.Time
}

func (h *handled) onOrder(_ context.Context, o order) error {
	h.mu.Lock()
	h.orders = append(h.orders, o)
	h.times = append(h.times, time.Now())
	h.mu.Unlock()
	return nil
}

func (h *handled) snapshot() ([]order, []time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]order(nil), h.orders...), append([]time.Time(nil), h.times...)
}

func TestREQ_DOC_7_AnyqConsumerGoRunsTheHandlerOnceForARedeliveredMessage(t *testing.T) {
	queueName := unique("once")
	producer := producerFor(t, queueName)
	claims := memstore.New()
	completed := newSignal()
	replayed := newSignal()
	h := &handled{}
	startConsumer(t, config{
		queueName: queueName,
		store:     completing{Store: claims, completed: completed},
		onOrder:   h.onOrder,
		policy: anyonce.Policy{Hooks: anyonce.Hooks{
			OnReplayed: func(anyonce.Operation, *anyonce.Record) { replayed.hit() },
		}},
		quiet: true,
	})

	body := []byte(`{"orderId":"o-1","total":42}`)
	key := "order-" + queueName
	publish(t, producer, body, key)
	completed.wait(t, 1, "completed claims")
	// The same order again under the same key: what a redelivery or a producer retry looks like to the
	// consumer. anyq mints a fresh message id for it, so only the header ties the two together.
	publish(t, producer, body, key)
	replayed.wait(t, 1, "replays")

	orders, _ := h.snapshot()
	if len(orders) != 1 || orders[0] != (order{OrderID: "o-1", Total: 42}) {
		t.Fatalf("the handler ran for %+v, want o-1 once", orders)
	}
	record, err := claims.Get(context.Background(), queueName, key, time.Now())
	if err != nil || record == nil || record.State != anyonce.StateCompleted {
		t.Fatalf("get: %v, record %+v, want a completed record", err, record)
	}
}

func TestREQ_Q_8_AnyqConsumerGoWiresWrapAndStrategyTogether(t *testing.T) {
	queueName := unique("park")
	producer := producerFor(t, queueName)
	claims := memstore.New()

	// Another consumer holds a live claim on this order when the delivery arrives.
	body := []byte(`{"orderId":"o-2","total":7}`)
	key := "order-" + queueName
	lease := 300 * time.Millisecond
	claimedAt := time.Now()
	op := anyonce.Operation{Scope: queueName, Key: key, Fingerprint: anyonce.SHA256Hex(body)}
	outcome, err := claims.Begin(context.Background(), op, anyonce.BeginOptions{Lease: lease, TTL: time.Hour, Now: claimedAt})
	if err != nil || outcome.Kind != anyonce.BeginAcquired {
		t.Fatalf("pre-claim: %v, outcome %q", err, outcome.Kind)
	}
	leaseUntil := claimedAt.Add(lease)

	completed := newSignal()
	h := &handled{}
	conflicted := 0
	var mu sync.Mutex
	seen := startConsumer(t, config{
		queueName: queueName,
		store:     completing{Store: claims, completed: completed},
		onOrder:   h.onOrder,
		policy: anyonce.Policy{Hooks: anyonce.Hooks{
			OnConflict: func(anyonce.Operation, time.Time) {
				mu.Lock()
				conflicted++
				mu.Unlock()
			},
		}},
		quiet: true,
	})

	publish(t, producer, body, key)
	// The claim completing is the end of the park: anyq re-enqueued the message after the delay and the door's
	// second claim found the lease gone.
	completed.wait(t, 1, "completed claims")

	// The park delay is whole milliseconds, so a redelivery can land just before the lease and park once more.
	// What matters is the handler: it ran once, and not before the lease expired.
	errs := seen.errors()
	mu.Lock()
	gotConflicts := conflicted
	mu.Unlock()
	if gotConflicts < 1 || len(errs) != gotConflicts {
		t.Fatalf("saw %d conflicts and door errors %v, want at least one conflict and one error each", gotConflicts, errs)
	}
	for _, err := range errs {
		var inFlight *anyqmw.InFlightError
		if !errors.As(err, &inFlight) {
			t.Fatalf("the door returned %v, want an *InFlightError", err)
		}
		// The strategy marks every in-flight error it turns into a park; without it the flag stays false.
		if !inFlight.Translated() {
			t.Fatal("the in-flight error was not translated, so no strategy parked it")
		}
	}
	orders, times := h.snapshot()
	if len(orders) != 1 {
		t.Fatalf("the handler ran %d times, want 1", len(orders))
	}
	if times[0].Before(leaseUntil) {
		t.Fatal("the handler ran before the claim's lease expired")
	}
}
