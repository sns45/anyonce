package anyqmw_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	"github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
)

func message(id string, body []byte, headers core.MessageHeaders) core.Message {
	return core.NewMessage(core.MessageParams{
		ID:              id,
		Body:            body,
		Headers:         headers,
		Timestamp:       time.Unix(0, 0),
		DeliveryAttempt: 1,
		Metadata:        core.ProviderMetadata{Provider: core.DriverMemory, Memory: &core.MemoryMetadata{QueueName: "orders"}},
	})
}

func TestWrap(t *testing.T) {
	t.Run("REQ-Q-2: the first delivery runs the handler and the duplicate does not", func(t *testing.T) {
		store := memory.New()
		var runs int
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			runs++
			return nil
		}, anyqmw.Options{Store: store})
		body := []byte(`{"a":1}`)
		if err := handler(context.Background(), message("m-1", body, nil)); err != nil {
			t.Fatalf("first delivery: %v", err)
		}
		if err := handler(context.Background(), message("m-1", body, nil)); err != nil {
			t.Fatalf("duplicate: %v", err)
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
	})

	t.Run("REQ-Q-5: the stored record is the outcome only, with no payload bytes", func(t *testing.T) {
		store := memory.New()
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{"secret":"do-not-store-me"}`), nil)); err != nil {
			t.Fatal(err)
		}
		record, err := store.Get(context.Background(), "orders", "m-1", time.Now())
		if err != nil || record == nil {
			t.Fatalf("get: %v, record %v", err, record)
		}
		if record.State != anyonce.StateCompleted {
			t.Fatalf("record state is %q, want completed", record.State)
		}
		if record.Result == nil || record.Result.Kind != anyonce.KindMessage || record.Result.Outcome != anyonce.OutcomeOK {
			t.Fatalf("stored result is %+v", record.Result)
		}
		if len(record.Result.Body) != 0 || record.Result.Status != 0 || len(record.Result.Headers) != 0 || record.Result.Error != nil {
			t.Fatalf("stored result carries payload data: %+v", record.Result)
		}
		if record.ResultOmitted {
			t.Fatal("an outcome-only result was marked omitted")
		}
	})

	t.Run("REQ-Q-2: an in-flight duplicate returns an InFlightError carrying the lease remainder", func(t *testing.T) {
		store := memory.New()
		now := time.Unix(1_700_000_000, 0)
		op := anyonce.Operation{Scope: "orders", Key: "m-1", Fingerprint: anyonce.SHA256Hex([]byte(`{"a":1}`))}
		if _, err := store.Begin(context.Background(), op, anyonce.BeginOptions{Lease: 5 * time.Second, TTL: time.Minute, Now: now}); err != nil {
			t.Fatal(err)
		}
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{
			Store:  store,
			Policy: anyonce.Policy{Lease: 5 * time.Second, Clock: func() time.Time { return now }},
		})
		err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil))
		if !errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatalf("want ErrInFlight, got %v", err)
		}
		var inFlight *anyqmw.InFlightError
		if !errors.As(err, &inFlight) {
			t.Fatalf("want *InFlightError, got %T", err)
		}
		if inFlight.DelayMs != 5000 {
			t.Fatalf("DelayMs is %d, want 5000", inFlight.DelayMs)
		}
		if !inFlight.LeaseUntil.Equal(now.Add(5 * time.Second)) {
			t.Fatalf("LeaseUntil is %v, want %v", inFlight.LeaseUntil, now.Add(5*time.Second))
		}
	})

	t.Run("REQ-Q-2: OnInFlight ack returns without running the handler and without an error", func(t *testing.T) {
		store := memory.New()
		now := time.Unix(1_700_000_000, 0)
		op := anyonce.Operation{Scope: "orders", Key: "m-1", Fingerprint: anyonce.SHA256Hex([]byte(`{"a":1}`))}
		if _, err := store.Begin(context.Background(), op, anyonce.BeginOptions{Lease: 5 * time.Second, TTL: time.Minute, Now: now}); err != nil {
			t.Fatal(err)
		}
		var runs int
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			runs++
			return nil
		}, anyqmw.Options{
			Store:      store,
			OnInFlight: anyqmw.InFlightAck,
			Policy:     anyonce.Policy{Lease: 5 * time.Second, Clock: func() time.Time { return now }},
		})
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); err != nil {
			t.Fatalf("want nil under InFlightAck, got %v", err)
		}
		if runs != 0 {
			t.Fatalf("handler ran %d times, want 0", runs)
		}
	})

	t.Run("REQ-Q-4: the same identity with a different payload returns a MismatchError", func(t *testing.T) {
		store := memory.New()
		var runs int
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			runs++
			return nil
		}, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); err != nil {
			t.Fatalf("first delivery: %v", err)
		}
		err := handler(context.Background(), message("m-1", []byte(`{"a":2}`), nil))
		if !errors.Is(err, anyqmw.ErrFingerprintMismatch) {
			t.Fatalf("want ErrFingerprintMismatch, got %v", err)
		}
		var mismatch *anyqmw.MismatchError
		if !errors.As(err, &mismatch) {
			t.Fatalf("want *MismatchError, got %T", err)
		}
		if mismatch.Record == nil || mismatch.Record.Key != "m-1" {
			t.Fatalf("mismatch record is %+v", mismatch.Record)
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
	})

	t.Run("REQ-Q-3: a handler error abandons the claim and is returned unchanged", func(t *testing.T) {
		store := memory.New()
		boom := errors.New("handler exploded")
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return boom }, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{}`), nil)); !errors.Is(err, boom) {
			t.Fatalf("want the handler error, got %v", err)
		}
		record, err := store.Get(context.Background(), "orders", "m-1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned: %+v", record)
		}
	})

	t.Run("REQ-Q-3: after an abandoned claim the next delivery runs the handler again", func(t *testing.T) {
		store := memory.New()
		attempts := 0
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			attempts++
			if attempts == 1 {
				return errors.New("transient")
			}
			return nil
		}, anyqmw.Options{Store: store})
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); err == nil {
			t.Fatal("want the transient error on the first delivery")
		}
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); err != nil {
			t.Fatalf("second delivery: %v", err)
		}
		if attempts != 2 {
			t.Fatalf("handler ran %d times, want 2", attempts)
		}
	})

	t.Run("REQ-Q-7: a cancelled context abandons the claim", func(t *testing.T) {
		store := memory.New()
		ctx, cancel := context.WithCancel(context.Background())
		handler := anyqmw.Wrap(func(ctx context.Context, _ core.Message) error {
			cancel()
			return ctx.Err()
		}, anyqmw.Options{Store: store})
		if err := handler(ctx, message("m-1", []byte(`{}`), nil)); !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
		record, err := store.Get(context.Background(), "orders", "m-1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned after cancellation: %+v", record)
		}
	})

	t.Run("REQ-Q-7: a handler that swallows a cancellation still abandons the claim", func(t *testing.T) {
		store := memory.New()
		ctx, cancel := context.WithCancel(context.Background())
		handler := anyqmw.Wrap(func(ctx context.Context, _ core.Message) error {
			cancel()
			// The handler reports success while its context is already cancelled, which is the case the
			// engine cannot see on its own: without the wrapper's guard a completed record would be stored
			// for work anyq is about to redeliver.
			return nil
		}, anyqmw.Options{Store: store})
		if err := handler(ctx, message("m-1", []byte(`{}`), nil)); !errors.Is(err, context.Canceled) {
			t.Fatalf("want context.Canceled, got %v", err)
		}
		record, err := store.Get(context.Background(), "orders", "m-1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("a swallowed cancellation left a record behind: %+v", record)
		}
	})

	t.Run("REQ-Q-7: a panicking handler abandons the claim and the panic still propagates", func(t *testing.T) {
		store := memory.New()
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { panic("boom") }, anyqmw.Options{Store: store})
		func() {
			defer func() {
				if recover() == nil {
					t.Error("panic did not propagate")
				}
			}()
			_ = handler(context.Background(), message("m-1", []byte(`{}`), nil))
		}()
		record, err := store.Get(context.Background(), "orders", "m-1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if record != nil {
			t.Fatalf("claim was not abandoned after the panic: %+v", record)
		}
	})

	t.Run("REQ-Q-2: a store failure under fail-closed reaches the caller so anyq retries the message", func(t *testing.T) {
		down := errors.New("store down")
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			t.Error("the handler ran while the store was down")
			return nil
		}, anyqmw.Options{Store: failingStore{err: down}})
		err := handler(context.Background(), message("m-1", []byte(`{}`), nil))
		if !errors.Is(err, down) {
			t.Fatalf("want the store error, got %v", err)
		}
		if !errors.Is(err, anyonce.ErrStoreUnavailable) {
			t.Fatalf("want ErrStoreUnavailable, got %v", err)
		}
	})

	t.Run("REQ-Q-8: an untranslated in-flight error warns once on the next delivery", func(t *testing.T) {
		store := memory.New()
		now := time.Unix(1_700_000_000, 0)
		op := anyonce.Operation{Scope: "orders", Key: "m-1", Fingerprint: anyonce.SHA256Hex([]byte(`{"a":1}`))}
		if _, err := store.Begin(context.Background(), op, anyonce.BeginOptions{Lease: 5 * time.Second, TTL: time.Minute, Now: now}); err != nil {
			t.Fatal(err)
		}
		var warnings []string
		handler := anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{
			Store:  store,
			Warn:   func(message string) { warnings = append(warnings, message) },
			Policy: anyonce.Policy{Lease: 5 * time.Second, Clock: func() time.Time { return now }},
		})
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); !errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatalf("want ErrInFlight, got %v", err)
		}
		if len(warnings) != 0 {
			t.Fatalf("warned before the next delivery: %v", warnings)
		}
		if err := handler(context.Background(), message("m-2", []byte(`{"a":1}`), nil)); err != nil {
			t.Fatalf("second delivery: %v", err)
		}
		if len(warnings) != 1 {
			t.Fatalf("want exactly one warning, got %v", warnings)
		}
		if err := handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil)); !errors.Is(err, anyqmw.ErrInFlight) {
			t.Fatalf("want ErrInFlight, got %v", err)
		}
		if err := handler(context.Background(), message("m-3", []byte(`{"a":1}`), nil)); err != nil {
			t.Fatalf("fourth delivery: %v", err)
		}
		if len(warnings) != 1 {
			t.Fatalf("the warning repeated: %v", warnings)
		}
	})

	t.Run("REQ-Q-1: Wrap panics when the one required option is missing", func(t *testing.T) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				t.Fatal("Wrap accepted a nil Store")
			}
			if got, want := recovered, "anyqmw: Options.Store is nil"; got != want {
				t.Fatalf("panic value is %v, want %q", got, want)
			}
		}()
		anyqmw.Wrap(func(context.Context, core.Message) error { return nil }, anyqmw.Options{})
	})

	t.Run("REQ-Q-1: an identity the wrapper cannot derive is a configuration error", func(t *testing.T) {
		store := memory.New()
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			t.Error("the handler ran without a usable identity")
			return nil
		}, anyqmw.Options{Store: store, Key: anyqmw.KeySourceHeader})
		err := handler(context.Background(), message("m-1", []byte(`{}`), nil))
		if !errors.Is(err, anyqmw.ErrConfiguration) {
			t.Fatalf("want ErrConfiguration, got %v", err)
		}
	})

	t.Run("REQ-Q-2: fifty concurrent deliveries of one message run the handler once", func(t *testing.T) {
		const deliveries = 50
		store := memory.New()
		var mu sync.Mutex
		runs := 0
		// entered has room for every delivery, so a broken door that let a second delivery into the handler
		// reports that instead of blocking on the send and hanging the test.
		entered := make(chan struct{}, deliveries)
		release := make(chan struct{})
		// Warn is silenced because the conflicting deliveries overlap, so one of them legitimately reports an
		// untranslated in-flight error and the default Warn would log during the test.
		handler := anyqmw.Wrap(func(context.Context, core.Message) error {
			mu.Lock()
			runs++
			mu.Unlock()
			entered <- struct{}{}
			<-release
			return nil
		}, anyqmw.Options{Store: store, Warn: func(string) {}})
		start := make(chan struct{})
		finished := make(chan struct{}, deliveries)
		var wg sync.WaitGroup
		errs := make([]error, deliveries)
		for i := range errs {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				errs[i] = handler(context.Background(), message("m-1", []byte(`{"a":1}`), nil))
				finished <- struct{}{}
			}(i)
		}
		close(start)
		// The winner parks inside the handler until every other delivery has been answered, so the conflict
		// count is deterministic without a sleep anywhere in the test. Every other delivery is answered
		// either by returning (finished) or, if the door is broken, by entering the handler too; counting
		// both means a broken door fails on the assertions below instead of hanging on this drain.
		<-entered
		for answered := 0; answered < deliveries-1; answered++ {
			select {
			case <-finished:
			case <-entered:
			}
		}
		close(release)
		wg.Wait()
		conflicts := 0
		for _, err := range errs {
			if errors.Is(err, anyqmw.ErrInFlight) {
				conflicts++
			}
		}
		if runs != 1 {
			t.Fatalf("handler ran %d times, want 1", runs)
		}
		if conflicts != deliveries-1 {
			t.Fatalf("%d deliveries saw the in-flight claim, want %d", conflicts, deliveries-1)
		}
	})
}

// failingStore is a Store whose Begin always fails, so the fail-closed path is exercised without a broker.
type failingStore struct {
	anyonce.Store
	err error
}

func (s failingStore) Begin(context.Context, anyonce.Operation, anyonce.BeginOptions) (anyonce.BeginOutcome, error) {
	return anyonce.BeginOutcome{}, s.err
}
