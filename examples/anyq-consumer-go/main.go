// Command anyq-consumer-go is an anyq consumer whose handler runs at most once per idempotency-key header,
// with anyqmw.Wrap and anyqmw.Strategy wired together. See README.md.
package main

import (
	"context"
	"errors"
	"log"

	"github.com/sns45/anyonce/go/anyonce"
	memstore "github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/memory"
)

func main() {
	if err := demo(context.Background()); err != nil {
		log.Fatal(err)
	}
}

// demo publishes the same order twice under one idempotency-key, the way a producer retry does, and returns once
// the second delivery has replayed.
func demo(ctx context.Context) error {
	const queueName = "orders"
	replayed := make(chan struct{}, 1)
	// The memory store keeps this example self contained; production uses a shared store (docs/stores.md).
	consumer, handler := newConsumer(config{
		queueName: queueName,
		store:     memstore.New(),
		policy: anyonce.Policy{Hooks: anyonce.Hooks{
			OnReplayed: func(anyonce.Operation, *anyonce.Record) {
				select {
				case replayed <- struct{}{}:
				default:
				}
			},
		}},
		quiet: true,
	})
	if err := consumer.Connect(ctx); err != nil {
		return err
	}
	defer func() { _ = consumer.Disconnect(context.Background()) }()
	producer := memory.NewProducer(memory.Config{
		BaseQueueConfig: core.BaseQueueConfig{Driver: core.DriverMemory, Logging: &core.LogConfig{Enabled: false}},
		QueueName:       queueName,
	})
	if err := producer.Connect(ctx); err != nil {
		return err
	}
	defer func() { _ = producer.Disconnect(context.Background()) }()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- consumer.Subscribe(ctx, handler, nil) }()

	body := []byte(`{"orderId":"o-1","total":42}`)
	headers := core.MessageHeaders{keyHeader: []byte("order-o-1")}
	for range 2 {
		// The second publish is a producer retry: anyq gives it a second message id.
		if _, err := producer.Publish(ctx, body, &core.PublishOptions{Headers: headers}); err != nil {
			return err
		}
	}
	select {
	case <-replayed:
	case err := <-done:
		return err
	}
	log.Print("the second delivery replayed; the handler ran once")
	cancel()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}
