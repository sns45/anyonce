package anyqmw

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyq/go/core"
)

func msg(id string, body []byte, headers core.MessageHeaders, metadata core.ProviderMetadata) core.Message {
	return core.NewMessage(core.MessageParams{
		ID:              id,
		Body:            body,
		Headers:         headers,
		Timestamp:       time.Unix(0, 0),
		DeliveryAttempt: 1,
		Metadata:        metadata,
	})
}

func memoryMeta(queue string) core.ProviderMetadata {
	return core.ProviderMetadata{Provider: core.DriverMemory, Memory: &core.MemoryMetadata{QueueName: queue}}
}

func TestWithDefaults(t *testing.T) {
	t.Run("REQ-Q-1: the zero Options take the documented defaults", func(t *testing.T) {
		o := Options{}.withDefaults()
		if o.Key != KeyID {
			t.Fatalf("default key source is %q, want %q", o.Key, KeyID)
		}
		if o.KeyHeader != DefaultKeyHeader {
			t.Fatalf("default key header is %q, want %q", o.KeyHeader, DefaultKeyHeader)
		}
		if o.OnInFlight != InFlightRetry {
			t.Fatalf("default in-flight mode is %q, want %q", o.OnInFlight, InFlightRetry)
		}
		if o.Fingerprint == nil || o.Warn == nil || o.Policy.Clock == nil {
			t.Fatal("withDefaults left a callback nil")
		}
		body := []byte(`{"a":1}`)
		got, err := o.Fingerprint(msg("m-1", body, nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if want := anyonce.SHA256Hex(body); got != want {
			t.Fatalf("default fingerprint is %q, want %q", got, want)
		}
	})

	t.Run("REQ-Q-1: withDefaults keeps every value the caller set", func(t *testing.T) {
		o := Options{Key: KeyBody, KeyHeader: "x-key", OnInFlight: InFlightAck}.withDefaults()
		if o.Key != KeyBody || o.KeyHeader != "x-key" || o.OnInFlight != InFlightAck {
			t.Fatalf("withDefaults overwrote a caller value: %+v", o)
		}
	})
}

func TestResolveKey(t *testing.T) {
	t.Run("REQ-Q-1: the default key is the broker message id", func(t *testing.T) {
		key, err := Options{}.withDefaults().resolveKey(msg("sqs-42", []byte(`{"a":1}`), nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if key != "sqs-42" {
			t.Fatalf("key is %q, want sqs-42", key)
		}
	})

	t.Run("REQ-Q-1: the header source reads idempotency-key case insensitively", func(t *testing.T) {
		o := Options{Key: KeyHeader}.withDefaults()
		headers := core.MessageHeaders{"Idempotency-Key": []byte("from-producer")}
		key, err := o.resolveKey(msg("m-1", []byte(`{}`), headers, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if key != "from-producer" {
			t.Fatalf("key is %q, want from-producer", key)
		}
		custom := Options{Key: KeyHeader, KeyHeader: "X-Order-Key"}.withDefaults()
		key, err = custom.resolveKey(msg("m-1", []byte(`{}`), core.MessageHeaders{"x-order-key": []byte("from-header")}, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if key != "from-header" {
			t.Fatalf("key is %q, want from-header", key)
		}
	})

	t.Run("REQ-Q-1: a missing header under the header source is a configuration error", func(t *testing.T) {
		o := Options{Key: KeyHeader}.withDefaults()
		_, err := o.resolveKey(msg("m-1", []byte(`{}`), nil, memoryMeta("orders")))
		if !errors.Is(err, ErrConfiguration) {
			t.Fatalf("want ErrConfiguration, got %v", err)
		}
	})

	t.Run("REQ-Q-1: the body source is the fingerprint, so it survives a re-published message", func(t *testing.T) {
		o := Options{Key: KeyBody}.withDefaults()
		body := []byte(`{"a":1}`)
		first, err := o.resolveKey(msg("id-1", body, nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if want := anyonce.SHA256Hex(body); first != want {
			t.Fatalf("key is %q, want %q", first, want)
		}
		second, err := o.resolveKey(msg("id-2", body, nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if second != first {
			t.Fatalf("a re-published message resolved to %q, want %q", second, first)
		}
	})

	t.Run("REQ-Q-1: KeyFunc wins over the key source and its result is validated", func(t *testing.T) {
		o := Options{KeyFunc: func(m core.Message) (string, error) { return "order-" + m.ID(), nil }}.withDefaults()
		key, err := o.resolveKey(msg("7", []byte(`{}`), nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if key != "order-7" {
			t.Fatalf("key is %q, want order-7", key)
		}
		tooLong := strings.Repeat("x", 256)
		bad := Options{KeyFunc: func(core.Message) (string, error) { return tooLong, nil }}.withDefaults()
		_, err = bad.resolveKey(msg("m-1", []byte(`{}`), nil, memoryMeta("orders")))
		if !errors.Is(err, ErrConfiguration) {
			t.Fatalf("want ErrConfiguration, got %v", err)
		}
		if strings.Contains(err.Error(), tooLong) {
			t.Fatal("the error message repeated the key value")
		}
	})

	t.Run("REQ-Q-1: a KeyFunc failure is returned to the caller", func(t *testing.T) {
		boom := errors.New("no key on this message")
		o := Options{KeyFunc: func(core.Message) (string, error) { return "", boom }}.withDefaults()
		if _, err := o.resolveKey(msg("m-1", []byte(`{}`), nil, memoryMeta("orders"))); !errors.Is(err, boom) {
			t.Fatalf("want the KeyFunc error, got %v", err)
		}
	})
}

func TestResolveScope(t *testing.T) {
	t.Run("REQ-Q-1: every adapter that names its queue derives the scope from the metadata", func(t *testing.T) {
		cases := []struct {
			name     string
			metadata core.ProviderMetadata
			want     string
		}{
			{"memory", memoryMeta("orders"), "orders"},
			{
				"redis-streams",
				core.ProviderMetadata{Provider: core.DriverRedisStreams, RedisStreams: &core.RedisStreamsMetadata{Stream: "orders", EntryID: "1-0", ConsumerGroup: "workers", Consumer: "c1"}},
				"orders/workers",
			},
			{
				"sqs",
				core.ProviderMetadata{Provider: core.DriverSQS, SQS: &core.SQSMetadata{QueueURL: "https://sqs.example/orders"}},
				"https://sqs.example/orders",
			},
			{
				"kafka",
				core.ProviderMetadata{Provider: core.DriverKafka, Kafka: &core.KafkaMetadata{Topic: "orders", Partition: 0, Offset: "9", HighWatermark: "10"}},
				"orders",
			},
			{
				"pgmq",
				core.ProviderMetadata{Provider: core.DriverPgmq, Pgmq: &core.PgmqMetadata{QueueName: "orders", MsgID: "1"}},
				"orders",
			},
			{
				"nats",
				core.ProviderMetadata{Provider: core.DriverNATS, NATS: &core.NATSMetadata{Stream: "orders", Subject: "orders.created"}},
				"orders",
			},
			{
				"google-pubsub",
				core.ProviderMetadata{Provider: core.DriverGooglePubSub, GooglePubSub: &core.GooglePubSubMetadata{Subscription: "orders-sub", AckID: "a"}},
				"orders-sub",
			},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				scope, err := Options{}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, c.metadata))
				if err != nil {
					t.Fatal(err)
				}
				if scope != c.want {
					t.Fatalf("scope is %q, want %q", scope, c.want)
				}
			})
		}
	})

	t.Run("REQ-Q-1: an adapter without a group uses the queue name, and ConsumerGroup appends to it", func(t *testing.T) {
		kafka := core.ProviderMetadata{Provider: core.DriverKafka, Kafka: &core.KafkaMetadata{Topic: "orders", Offset: "9"}}
		grouped, err := Options{ConsumerGroup: "billing"}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, kafka))
		if err != nil {
			t.Fatal(err)
		}
		if grouped != "orders/billing" {
			t.Fatalf("scope is %q, want orders/billing", grouped)
		}
	})

	t.Run("REQ-Q-1: ConsumerGroup overrides the group the adapter reports", func(t *testing.T) {
		redis := core.ProviderMetadata{Provider: core.DriverRedisStreams, RedisStreams: &core.RedisStreamsMetadata{Stream: "orders", ConsumerGroup: "workers"}}
		scope, err := Options{ConsumerGroup: "billing"}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, redis))
		if err != nil {
			t.Fatal(err)
		}
		if scope != "orders/billing" {
			t.Fatalf("scope is %q, want orders/billing", scope)
		}
	})

	t.Run("REQ-Q-1: an adapter that names no queue on the message demands an explicit scope", func(t *testing.T) {
		for _, provider := range []core.QueueDriver{core.DriverRabbitMQ, core.DriverSNS, core.DriverAzureServiceBus} {
			metadata := core.ProviderMetadata{Provider: provider}
			_, err := Options{}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, metadata))
			if !errors.Is(err, ErrConfiguration) {
				t.Fatalf("%s: want ErrConfiguration, got %v", provider, err)
			}
			if !strings.Contains(err.Error(), "Options.Scope") {
				t.Fatalf("%s: the error does not name the option to set: %v", provider, err)
			}
			scope, err := Options{Scope: "orders/workers"}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, metadata))
			if err != nil {
				t.Fatal(err)
			}
			if scope != "orders/workers" {
				t.Fatalf("%s: scope is %q, want orders/workers", provider, scope)
			}
		}
	})

	t.Run("REQ-Q-1: ScopeFunc wins over the derived scope", func(t *testing.T) {
		o := Options{ScopeFunc: func(m core.Message) (string, error) { return "q/" + string(m.Metadata().Provider), nil }}.withDefaults()
		scope, err := o.resolveScope(msg("m-1", []byte(`{}`), nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		if scope != "q/memory" {
			t.Fatalf("scope is %q, want q/memory", scope)
		}
	})

	t.Run("REQ-Q-1: an adapter whose metadata struct is absent demands an explicit scope", func(t *testing.T) {
		_, err := Options{}.withDefaults().resolveScope(msg("m-1", []byte(`{}`), nil, core.ProviderMetadata{Provider: core.DriverMemory}))
		if !errors.Is(err, ErrConfiguration) {
			t.Fatalf("want ErrConfiguration, got %v", err)
		}
	})
}

func TestOperation(t *testing.T) {
	t.Run("REQ-Q-1: the operation is the derived scope, key and body fingerprint", func(t *testing.T) {
		body := []byte(`{"a":1}`)
		op, err := Options{}.withDefaults().operation(msg("m-1", body, nil, memoryMeta("orders")))
		if err != nil {
			t.Fatal(err)
		}
		want := anyonce.Operation{Scope: "orders", Key: "m-1", Fingerprint: anyonce.SHA256Hex(body)}
		if op != want {
			t.Fatalf("operation is %+v, want %+v", op, want)
		}
	})

	t.Run("REQ-Q-1: a Fingerprint failure is returned to the caller", func(t *testing.T) {
		boom := errors.New("cannot canonicalize")
		o := Options{Fingerprint: func(core.Message) (string, error) { return "", boom }}.withDefaults()
		if _, err := o.operation(msg("m-1", []byte(`{}`), nil, memoryMeta("orders"))); !errors.Is(err, boom) {
			t.Fatalf("want the Fingerprint error, got %v", err)
		}
	})
}
