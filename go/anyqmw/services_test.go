package anyqmw_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/sns45/anyonce/go/anyonce"
	"github.com/sns45/anyonce/go/anyqmw"
	"github.com/sns45/anyonce/go/internal/servicetest"
	store "github.com/sns45/anyonce/go/store/memory"
	"github.com/sns45/anyq/go/core"
	"github.com/sns45/anyq/go/kafka"
	"github.com/sns45/anyq/go/sqs"
)

// REQ-Q-6 and REQ-Q-8 against two real brokers: SQS through the ElasticMQ container and Kafka through the
// Redpanda container. Both suites prove the same four cases, so the cases are written once here and each
// broker contributes only its own setup and the identity source that survives its park (Q40). The harness they
// run on lives in harness_test.go, shared with the memory suite.
//
// The pair is what REQ-Q-8 asks for: SQS has native delayed redelivery, so its park is the real thing, while
// Kafka has none, so its park downgrades to an in-process wait plus a re-invocation of the same delivery, and
// the downgrade must not reach the inner handler before the lease the first claim holds has expired.

const (
	elasticMQAddr     = "127.0.0.1:9324"
	elasticMQEndpoint = "http://" + elasticMQAddr
	redpandaAddr      = "127.0.0.1:9092"
)

// elasticMQ calls one SQS API on the local container over its AWS JSON protocol. The container accepts
// unsigned requests, so net/http is enough and this module does not take on the AWS SQS client just to create
// and drop a queue.
func elasticMQ(target string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("encode %s: %w", target, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, elasticMQEndpoint+"/", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build %s: %w", target, err)
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.0")
	req.Header.Set("X-Amz-Target", "AmazonSQS."+target)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send %s: %w", target, err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return fmt.Errorf("read %s: %w", target, err)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d: %s", target, res.StatusCode, raw)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode %s: %w", target, err)
	}
	return nil
}

// opened is what a suite's setup hands back: a connected producer and consumer on a queue or topic of this
// run's own, the dead letters the consumer's probe intercepts, and the scope the door derives from the
// adapter's own metadata.
type opened struct {
	producer core.Producer
	consumer consumer
	dead     *deadLetters
	scope    string
}

// broker is one service-backed adapter under test.
type broker struct {
	// name is the adapter's name, used in the REQ-Q-6 case name.
	name string
	// parkName is the whole REQ-Q-8 park case name, because what park means differs between the two.
	parkName string
	// open builds a fresh queue or topic and connects a producer and a consumer probe to it.
	open func(t *testing.T, label string, strategy core.Strategy) opened
	// parkKey is the identity source that survives a park on this adapter (Q40). SQS republishes the body
	// alone and loses the message attributes, so only the body fingerprint follows a parked message; Kafka
	// re-invokes the same delivery in process, so its headers are still there.
	parkKey anyqmw.KeySource
	// parkIsNative says which of anyq's two park paths this adapter takes: a native park republishes the
	// message and the broker delivers it again with an id of its own, while the downgrade sleeps and
	// re-invokes the handler on the delivery it already has. casePark asserts whichever one applies.
	parkIsNative bool
}

// parkDeliveries is how many deliveries one parked message costs: two for a native park, because the message
// goes through the broker a second time, and one for the downgrade, which never leaves the first delivery.
func (b broker) parkDeliveries() int {
	if b.parkIsNative {
		return 2
	}
	return 1
}

// sqsProbe widens the SQS consumer so a test can see the dead letters it routes. Bind re-points the embedded
// BaseConsumer's hook dispatch at the probe, which the adapter's constructor pointed at itself.
type sqsProbe struct {
	*sqs.Consumer
	dead *deadLetters
}

// DeadLetterMessage records the routing and then lets the adapter perform it.
func (p *sqsProbe) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	p.dead.add(msg.ID(), reason)
	return p.Consumer.DeadLetterMessage(ctx, msg, reason)
}

// kafkaProbe is sqsProbe for the Kafka consumer.
type kafkaProbe struct {
	*kafka.Consumer
	dead *deadLetters
}

// DeadLetterMessage records the routing and then lets the adapter perform it.
func (p *kafkaProbe) DeadLetterMessage(ctx context.Context, msg core.Message, reason string) error {
	p.dead.add(msg.ID(), reason)
	return p.Consumer.DeadLetterMessage(ctx, msg, reason)
}

// sqsBroker creates one ElasticMQ queue per case and drops it afterwards.
func sqsBroker() broker {
	return broker{
		name:         "sqs",
		parkName:     "REQ-Q-8: with the strategy configured, an in-flight duplicate parks natively and the handler waits for the lease",
		parkKey:      anyqmw.KeySourceBody,
		parkIsNative: true,
		open: func(t *testing.T, label string, strategy core.Strategy) opened {
			t.Helper()
			name := unique("sqs-" + label)
			var created struct{ QueueUrl string }
			if err := elasticMQ("CreateQueue", map[string]any{"QueueName": name}, &created); err != nil {
				t.Fatalf("create queue: %v", err)
			}
			cfg := sqs.Config{
				BaseQueueConfig: core.BaseQueueConfig{Driver: core.DriverSQS, Logging: quiet(), Strategy: strategy},
				SQS: sqs.ConnectionConfig{
					Region:          "us-east-1",
					Endpoint:        elasticMQEndpoint,
					AccessKeyID:     "anyonce",
					SecretAccessKey: "anyonce",
				},
				QueueURL: created.QueueUrl,
				// Short polls keep a cancelled subscription from lingering, and one message per receive
				// keeps the delivery order in these cases readable.
				Consumer: sqs.ConsumerOptions{MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 30, PollingInterval: 200},
			}
			producer := sqs.NewProducer(cfg)
			probe := &sqsProbe{Consumer: sqs.NewConsumer(cfg), dead: &deadLetters{}}
			probe.Bind(probe)
			connect(t, producer, probe)
			t.Cleanup(func() {
				disconnect(producer, probe)
				if err := elasticMQ("DeleteQueue", map[string]any{"QueueUrl": created.QueueUrl}, nil); err != nil {
					t.Errorf("delete queue: %v", err)
				}
			})
			return opened{producer: producer, consumer: probe, dead: probe.dead, scope: created.QueueUrl}
		},
	}
}

// kafkaBroker creates one Redpanda topic and one consumer group per case. Redpanda keeps the topic; nothing in
// anyq's Go kafka adapter deletes one, and the unique name means no run ever sees another run's records.
func kafkaBroker() broker {
	return broker{
		name:         "kafka",
		parkName:     "REQ-Q-8: with the strategy configured, an in-flight duplicate downgrades to a park and the handler waits for the lease",
		parkKey:      anyqmw.KeySourceHeader,
		parkIsNative: false,
		open: func(t *testing.T, label string, strategy core.Strategy) opened {
			t.Helper()
			topic := unique("kafka-" + label)
			cfg := kafka.Config{
				BaseQueueConfig: core.BaseQueueConfig{
					Driver:   core.DriverKafka,
					Logging:  quiet(),
					Strategy: strategy,
					// Go defaults this to false, which fails Connect loud: the companion strategy is not
					// one of anyq's park-free names and Kafka has no native delayed redelivery, so a park
					// here can only be the in-process downgrade. This suite is the proof it behaves.
					AllowParkDowngrade: true,
				},
				Brokers:  []string{redpandaAddr},
				Topic:    topic,
				ClientID: topic,
				// A batch of one flushed at once, so a publish is visible to the consumer straight away.
				Producer: &kafka.ProducerOptions{BatchSize: 1, BatchTimeoutMs: 10},
				ConsumerGroup: &kafka.ConsumerGroupOptions{
					GroupID:             topic + "-group",
					SessionTimeoutMs:    10_000,
					HeartbeatIntervalMs: 1_000,
					MaxWaitMs:           200,
					FromBeginning:       true,
				},
			}
			// The topic is created explicitly rather than left to auto-creation, so the group has something
			// to be assigned to before anything is published.
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := kafka.EnsureTopic(ctx, cfg); err != nil {
				t.Fatalf("create topic: %v", err)
			}
			producer := kafka.NewProducer(cfg)
			probe := &kafkaProbe{Consumer: kafka.NewConsumer(cfg), dead: &deadLetters{}}
			probe.Bind(probe)
			connect(t, producer, probe)
			t.Cleanup(func() { disconnect(producer, probe) })
			return opened{producer: producer, consumer: probe, dead: probe.dead, scope: topic}
		},
	}
}

// connect brings both ends up, failing the test if either refuses. A park-policy misconfiguration surfaces
// here, because that is where anyq checks it.
func connect(t *testing.T, producer core.Producer, c consumer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := producer.Connect(ctx); err != nil {
		t.Fatalf("producer connect: %v", err)
	}
	if err := c.Connect(ctx); err != nil {
		t.Fatalf("consumer connect: %v", err)
	}
}

// disconnect takes both ends down, consumer first, so nothing is still polling a queue about to be dropped.
func disconnect(producer core.Producer, c consumer) {
	ctx := context.Background()
	_ = c.Disconnect(ctx)
	_ = producer.Disconnect(ctx)
}

// door wraps the inner handler for one case. Every case keys on something the adapter carries on the message
// itself, never on a value the test passes in as the scope.
func door(claims *store.Store, in *inner, key anyqmw.KeySource) core.Handler {
	return anyqmw.Wrap(in.handler(), anyqmw.Options{Store: claims, Key: key})
}

// identity returns the key the door will derive for body under the given source, so a case can take the same
// claim in the store that the delivery will meet.
func identity(source anyqmw.KeySource, header string, body []byte) string {
	if source == anyqmw.KeySourceBody {
		return anyonce.SHA256Hex(body)
	}
	return header
}

// caseOnce is REQ-Q-6: a producer that sent the same work twice gets one run of the handler. Both publishes
// mint their own broker id, which is exactly the case the id key source cannot catch, so the door keys on the
// producer supplied header.
func caseOnce(t *testing.T, b broker) {
	env := b.open(t, "once", nil)
	claims := store.New()
	in := newInner()
	seen := &driven{}
	settled := newSignal()
	run := start(t, env.consumer, drive(env.consumer, door(claims, in, anyqmw.KeySourceHeader), seen, settled), seen)

	body := []byte(`{"orderId":"a-1"}`)
	key := unique(b.name + "-once-key")
	publish(t, env.producer, body, key)
	publish(t, env.producer, body, key)
	settled.wait(t, 2, "deliveries")
	st := run.stop(t)

	if runs := len(in.calls()); runs != 1 {
		t.Fatalf("the inner handler ran %d times, want 1", runs)
	}
	if len(st.errs) != 0 {
		t.Fatalf("the door reported %v, want no errors", st.errs)
	}
	if len(st.ids) != 2 || st.ids[0] == st.ids[1] {
		t.Fatalf("delivery ids are %v, want two different ones", st.ids)
	}
	// The scope was derived from the adapter's own metadata, never passed in.
	record, err := claims.Get(context.Background(), env.scope, key, time.Now())
	if err != nil || record == nil {
		t.Fatalf("get: %v, record %v", err, record)
	}
	if record.State != anyonce.StateCompleted || record.Result == nil || record.Result.Outcome != anyonce.OutcomeOK {
		t.Fatalf("the stored record is %+v", record)
	}
	if len(record.Result.Body) != 0 {
		t.Fatal("the stored record carries payload bytes")
	}
	wantNoDeadLetters(t, env.dead)
}

// casePark is REQ-Q-8's park: a delivery that meets a live claim must not reach the inner handler until that
// claim's lease has expired, whether the adapter parks natively or downgrades the park in process.
func casePark(t *testing.T, b broker) {
	env := b.open(t, "park", anyqmw.Strategy(nil))
	claims := store.New()
	in := newInner()
	seen := &driven{}
	settled := newSignal()
	run := start(t, env.consumer, drive(env.consumer, door(claims, in, b.parkKey), seen, settled), seen)

	// A warm-up delivery is the barrier: a consumer group joins asynchronously, and the lease taken below is
	// wall-clock, so the claim must not start until the consumer is provably live on its partitions.
	warmUp := []byte(`{"orderId":"warm-up"}`)
	publish(t, env.producer, warmUp, unique(b.name+"-park-warm-up"))
	in.ran.wait(t, 1, "the warm-up delivery")

	body := []byte(`{"orderId":"b-1"}`)
	header := unique(b.name + "-park-key")
	leaseUntil := claim(t, claims, env.scope, identity(b.parkKey, header, body), body, 300*time.Millisecond)
	publish(t, env.producer, body, header)
	// Waiting on the deliveries rather than on the handler call means the park is fully resolved before
	// anything is read back: a delivery is recorded only once its strategy has finished with it.
	settled.wait(t, 1+b.parkDeliveries(), "deliveries")
	st := run.stop(t)

	if len(st.ids) != 1+b.parkDeliveries() {
		t.Fatalf("the park cost %d deliveries after the warm-up, want %d", len(st.ids)-1, b.parkDeliveries())
	}
	wantParked(t, st, in, leaseUntil, 2)
	wantNoDeadLetters(t, env.dead)

	// Which park path ran, asserted on the identity of the redelivery rather than on its timing. Without
	// this, a park that silently failed would still pass everything above: anyq's SQS ParkMessage falls back
	// to nack(true) when SendMessage fails, logs it at Error, which these quiet consumers never print, and
	// returns nil, which ApplyStrategy would swallow anyway. That fallback costs the same two deliveries and
	// can satisfy the same ordering. It differs in exactly one visible way: a native park republishes the
	// message and the broker mints a fresh id for it, while a nack keeps the id it had.
	if b.parkIsNative {
		if st.ids[2] == st.ids[1] {
			t.Fatalf("the parked message came back with its original id %q, so the park did not republish it", st.ids[1])
		}
		if len(st.reinvokes) != 0 {
			t.Fatalf("a native park re-invoked the handler in process on %v, want no re-invocation", st.reinvokes)
		}
		return
	}
	// The mirror property: the downgrade never leaves the delivery it has, so the handler is re-invoked once
	// on that same id.
	if len(st.reinvokes) != 1 || st.reinvokes[0] != st.ids[1] {
		t.Fatalf("the downgrade re-invoked %v, want one re-invocation of %q", st.reinvokes, st.ids[1])
	}
}

// caseMismatch is REQ-Q-8's dead letter. The identity has to come from somewhere other than the payload for a
// mismatch to be possible at all, so this case always keys on the producer supplied header.
func caseMismatch(t *testing.T, b broker) {
	env := b.open(t, "mismatch", anyqmw.Strategy(nil))
	claims := store.New()
	in := newInner()
	seen := &driven{}
	settled := newSignal()
	run := start(t, env.consumer, drive(env.consumer, door(claims, in, anyqmw.KeySourceHeader), seen, settled), seen)

	key := unique(b.name + "-mismatch-key")
	publish(t, env.producer, []byte(`{"orderId":"c-1","total":1}`), key)
	settled.wait(t, 1, "deliveries")
	publish(t, env.producer, []byte(`{"orderId":"c-1","total":2}`), key)
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
	wantOneDeadLetter(t, env.dead, st.ids[1], "fingerprint-mismatch")
}

// caseUntranslated is REQ-Q-8's third case: with no strategy on the consumer nothing translates the typed
// error, so the consumer reports the failure unhandled and the error reaches anyq's legacy path still unmarked.
func caseUntranslated(t *testing.T, b broker) {
	env := b.open(t, "untranslated", nil)
	claims := store.New()
	body := []byte(`{"orderId":"d-1"}`)
	key := unique(b.name + "-untranslated-key")
	// An hour long lease, so nothing about this case depends on when the delivery arrives.
	claim(t, claims, env.scope, key, body, time.Hour)

	in := newInner()
	seen := &driven{}
	settled := newSignal()
	run := start(t, env.consumer, drive(env.consumer, door(claims, in, anyqmw.KeySourceHeader), seen, settled), seen)

	publish(t, env.producer, body, key)
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
	wantNoDeadLetters(t, env.dead)
}

// runSuite runs the four cases every adapter suite proves, in one order.
func runSuite(t *testing.T, b broker) {
	t.Helper()
	t.Run(fmt.Sprintf("REQ-Q-6: a %s consumer runs a wrapped handler once for a duplicate the producer re-sent", b.name), func(t *testing.T) {
		caseOnce(t, b)
	})
	t.Run(b.parkName, func(t *testing.T) { casePark(t, b) })
	t.Run("REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch", func(t *testing.T) {
		caseMismatch(t, b)
	})
	t.Run("REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated", func(t *testing.T) {
		caseUntranslated(t, b)
	})
}

func TestSQSAdapter(t *testing.T) {
	servicetest.Require(t, "elasticmq", elasticMQAddr)
	runSuite(t, sqsBroker())
}

func TestKafkaAdapter(t *testing.T) {
	servicetest.Require(t, "redpanda", redpandaAddr)
	runSuite(t, kafkaBroker())
}
