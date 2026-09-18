package anyqmw_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	store "github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

// REQ-Q-6 and REQ-Q-8 against the in-process anyq adapter. The memory consumer has native delayed redelivery,
// so the park case here is the end to end native park: anyq re-enqueues the message after the delay and the
// door's second claim succeeds once the lease has gone. Q40: that re-enqueue mints a fresh message id, which
// is why every door in this file keys on a header. The harness these cases run on is in harness_test.go.

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
