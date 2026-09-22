# anyq-consumer-go

An [anyq](https://github.com/sns45/anyq) consumer in Go whose handler runs at most once per order. Two pieces
are wired together and both are required: `anyqmw.Wrap(handler, anyqmw.Options{Store: store, Key:
anyqmw.KeySourceHeader})` wraps the handler, and `Strategy: anyqmw.Strategy(nil)` goes on the consumer config.
The strategy is not optional, because anyq reaches its park and dead-letter primitives only through a strategy
decision: the wrapped handler returns an in-flight duplicate or a payload mismatch as a typed error, and
without the strategy that error falls through to anyq's plain retry path instead of parking for the rest of
the lease or going to the dead-letter queue. The key source is `KeySourceHeader` because an anyq park
re-enqueues the message with a fresh message id on this adapter, so the id would not follow the parked copy
(see [docs/queue-ids.md](../../docs/queue-ids.md)). Producers should set an `idempotency-key` header on every
message: it is the recommended default for any broker whose message id changes on redelivery or on a producer
retry, and a producer retry always publishes a second message with a second id.

## What it shows

- [`consumer.go`](./consumer.go): `newConsumer(config{queueName, store})` returns an anyq memory consumer
  configured with `anyqmw.Strategy(nil)` and the handler wrapped by `anyqmw.Wrap`. The smoke test drives
  this same function.
- [`main.go`](./main.go): connects the consumer, runs `Subscribe` with that handler, and publishes the same
  order twice under one key.
- A completed order that arrives again (a redelivery, or a producer retry under the same `idempotency-key`)
  is acknowledged without running the handler.
- An order whose first claim is still running is parked for the lease remainder and handled once the lease
  has gone, never before.
- The memory store (`store/memory`) keeps the example self contained. A consumer group with more than one
  instance needs a shared store; see [docs/stores.md](../../docs/stores.md).

```go
consumer := memory.NewConsumer(memory.Config{
	BaseQueueConfig: core.BaseQueueConfig{
		Driver: core.DriverMemory,
		// Required: turns the door's typed errors into a park or a dead letter.
		Strategy: anyqmw.Strategy(nil),
	},
	QueueName: "orders",
})
handler := anyqmw.Wrap(func(ctx context.Context, msg core.Message) error {
	// Runs once per idempotency-key header.
	return nil
}, anyqmw.Options{Store: memstore.New(), Key: anyqmw.KeySourceHeader})

if err := consumer.Connect(ctx); err != nil {
	log.Fatal(err)
}
log.Fatal(consumer.Subscribe(ctx, handler, nil))
```

The producer side sets the header:

```go
headers := core.MessageHeaders{"idempotency-key": []byte("order-o-1")}
_, err := producer.Publish(ctx, body, &core.PublishOptions{Headers: headers})
```

## Run it locally

No compose service is needed; the memory adapter is in process. From this directory:

```sh
go run .
```

It prints:

```text
handled order o-1
the second delivery replayed; the handler ran once
```

(each line prefixed with the standard `log` timestamp).

## Smoke test

[`smoke_test.go`](./smoke_test.go) drives `newConsumer` with a real anyq memory producer: an order sent twice
under one key runs the handler once, and an order that meets another consumer's live claim parks (the
strategy marks the `*anyqmw.InFlightError` translated) and runs once, after the lease expires. Both wait on
barriers, never on a duration. From this directory:

```sh
go vet ./...
go test -race -count=1 ./...
```

On another broker, swap `github.com/sns45/anyq/go/memory` for its adapter and keep both pieces; which key
source survives a park on each broker is in [docs/queue-ids.md](../../docs/queue-ids.md).
