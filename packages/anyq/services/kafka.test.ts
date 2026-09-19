// kafkajs reads both of these when it builds a client, so they are set before any consumer connects.
process.env.KAFKAJS_LOG_LEVEL = 'nothing';
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

import { afterAll, afterEach, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { ApplyStrategyResult, IMessage } from '@anyq/core';
import { KafkaConsumer, KafkaProducer } from '@anyq/kafka';
import { InFlightError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { idempotent } from '../src/idempotent';
import { idempotencyStrategy } from '../src/strategy';
import { deliveries, drive, record } from './harness';
import { describeService } from './services';

/**
 * REQ-Q-6 and REQ-Q-8 against a real Kafka consumer group on the Redpanda container at 127.0.0.1:9092.
 *
 * Kafka has no delayed redelivery, so `supportsNativeDelay` is false and a park decision downgrades to an
 * in-process wait followed by a re-invocation of the same delivery. `allowParkDowngrade` opts into that, and
 * the park case here is the downgrade proof REQ-Q-8 asks for: the wrapped handler is not called before the
 * lease the first claim holds has run out.
 *
 * A Kafka message id is `topic-partition-offset`, which the door could key on, but a producer that retries a
 * publish writes a second offset. These tests key on the producer supplied header, which is what
 * `docs/queue-ids.md` recommends for this adapter.
 */

const PORT = 9092;
const BROKERS = [`127.0.0.1:${PORT}`];

/**
 * A lifecycle hook has its own timeout and does not inherit the one a test declares, and the default is short
 * enough that a client connect or a consumer group leave on a loaded CI runner runs past it. Every hook in
 * this file is given the same budget as the tests.
 */
const HOOK_TIMEOUT_MS = 60_000;

/**
 * kafkajs schedules its pending request check with a negative delay whenever nothing is throttled, and a
 * runtime reports that as a TimeoutNegativeWarning on stderr. It comes from inside the published @anyq/kafka
 * bundle and nothing about correctness turns on it, but it is noise in the test output.
 *
 * A `process.on('warning')` listener suppressed it on one bun version and not on another, because whether a
 * listener replaces the default printer is up to the runtime. A negative delay is defined to mean zero, so
 * clamping it here removes the warning at its source instead of trying to intercept the report of it, which
 * works whatever the runtime does with warnings. The original is restored when this file is done.
 */
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof nativeSetTimeout>) => {
  const [handler, delay, ...rest] = args;
  return nativeSetTimeout(handler, typeof delay === 'number' && delay < 0 ? 0 : delay, ...rest);
}) as typeof globalThis.setTimeout;
afterAll(() => {
  globalThis.setTimeout = nativeSetTimeout;
}, HOOK_TIMEOUT_MS);

/** applyStrategy and deadLetterMessage are protected on BaseConsumer; this widens what a test drives. */
class Probe<T> extends KafkaConsumer<T> {
  readonly deadLetters: Array<{ id: string; reason: string }> = [];

  runStrategy(
    message: IMessage<T>,
    error: Error,
    reinvoke?: () => Promise<void>,
  ): Promise<ApplyStrategyResult> {
    return this.applyStrategy(message, error, reinvoke);
  }

  protected override async deadLetterMessage(message: IMessage<T>, reason: string): Promise<void> {
    this.deadLetters.push({ id: message.id, reason });
    await super.deadLetterMessage(message, reason);
  }
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
}, HOOK_TIMEOUT_MS);

function topicFor(label: string): string {
  return `anyonce-kafka-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function build<T>(
  topic: string,
  extra: { strategy?: ReturnType<typeof idempotencyStrategy> },
): { probe: Probe<T>; producer: KafkaProducer<T> } {
  const kafka = { brokers: BROKERS };
  const probe = new Probe<T>({
    driver: 'kafka',
    kafka: { ...kafka, clientId: `${topic}-consumer` },
    topic,
    consumerGroup: { groupId: `${topic}-group`, sessionTimeout: 10_000, heartbeatInterval: 1_000 },
    allowParkDowngrade: true,
    logging: { enabled: false },
    ...extra,
  });
  const producer = new KafkaProducer<T>({
    driver: 'kafka',
    kafka: { ...kafka, clientId: `${topic}-producer` },
    topic,
    logging: { enabled: false },
  });
  return { probe, producer };
}

/**
 * Both clients connect, and the topic is created explicitly through the consumer's own kafkajs client rather
 * than left to Redpanda's auto-create, so a test can subscribe and join its group before it publishes
 * anything. The park case depends on that: the short lease it takes must not have to outlive a JoinGroup.
 */
async function open<T>(probe: Probe<T>, producer: KafkaProducer<T>, topic: string): Promise<void> {
  await producer.connect();
  await probe.connect();
  cleanup.push(async () => {
    await probe.disconnect();
    await producer.disconnect();
  });
  const admin = probe.getKafka()?.admin();
  if (admin === undefined)
    throw new Error('the kafka consumer exposed no client to create the topic with');
  await admin.connect();
  try {
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * kafkajs joins the group asynchronously, after consumer.run() and so after subscribe() has returned. A test
 * whose timing must not include the join waits on the first GROUP_JOIN, which is the moment the consumer is
 * actually live on its partitions. The listener is registered before subscribe so a fast join is not missed.
 */
function joined<T>(probe: Probe<T>): Promise<void> {
  const consumer = probe.getConsumer();
  if (consumer === null) throw new Error('the kafka consumer is not connected');
  return new Promise<void>((resolve) => {
    const off = consumer.on(consumer.events.GROUP_JOIN, () => {
      off();
      resolve();
    });
  });
}

await describeService('anyq kafka consumer', PORT, () => {
  test('REQ-Q-6: a kafka consumer runs a wrapped handler once for a duplicate the producer re-sent', async () => {
    const topic = topicFor('once');
    const { probe, producer } = build<{ orderId: string }>(topic, {});
    await open(probe, producer, topic);

    const store = new MemoryStore();
    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });

    const body = { orderId: 'a-1' };
    const key = `kafka-${topic}`;
    const headers = { 'idempotency-key': key };
    await producer.publish(body, { key: 'anyonce', headers });
    await producer.publish(body, { key: 'anyonce', headers });
    await settled.reaches(2);

    expect(ran).toBe(1);
    expect(seen.errors).toEqual([]);
    expect(seen.ids[0]).not.toBe(seen.ids[1]);

    // The scope was derived from the message metadata, never passed in.
    const stored = await store.get({ scope: topic, key }, Date.now());
    expect(stored?.state).toBe('completed');
    expect(stored?.result).toEqual({ kind: 'message', outcome: 'ok' });
  }, 60_000);

  test('REQ-Q-8: with the strategy configured, an in-flight duplicate downgrades to a park and the handler waits for the lease', async () => {
    const topic = topicFor('park');
    const { probe, producer } = build<{ orderId: string }>(topic, {
      strategy: idempotencyStrategy(),
    });
    await open(probe, producer, topic);

    const body = { orderId: 'b-1' };
    const key = `kafka-${topic}`;
    const store = new MemoryStore();
    let ran = 0;
    let firstCallAt = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
        if (ran === 1) firstCallAt = Date.now();
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    const live = joined(probe);
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });
    await live;

    // The group is live and the topic is empty, so the lease window covers the delivery and nothing else.
    const claimedAt = Date.now();
    const leaseMs = 300;
    const leaseUntil = claimedAt + leaseMs;
    const claim = await store.begin(
      { scope: topic, key, fingerprint: await messageFingerprint(body) },
      { leaseMs, ttlMs: 60_000, now: claimedAt },
    );
    expect(claim.outcome).toBe('acquired');

    await producer.publish(body, { key: 'anyonce', headers: { 'idempotency-key': key } });
    await settled.reaches(1);

    expect(seen.errors[0]).toBeInstanceOf(InFlightError);
    expect(seen.results[0]).toEqual({ handled: true });
    expect(ran).toBe(1);
    expect(firstCallAt).toBeGreaterThanOrEqual(leaseUntil);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);

  test('REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch', async () => {
    const topic = topicFor('mismatch');
    const { probe, producer } = build<{ orderId: string; total: number }>(topic, {
      strategy: idempotencyStrategy(),
    });
    await open(probe, producer, topic);

    const store = new MemoryStore();
    let ran = 0;
    const wrapped = idempotent<{ orderId: string; total: number }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });

    const headers = { 'idempotency-key': `kafka-${topic}` };
    await producer.publish({ orderId: 'c-1', total: 1 }, { key: 'anyonce', headers });
    await settled.reaches(1);
    await producer.publish({ orderId: 'c-1', total: 2 }, { key: 'anyonce', headers });
    await settled.reaches(2);

    expect(ran).toBe(1);
    expect(seen.results).toEqual([{ handled: true }]);
    expect(probe.deadLetters).toEqual([
      { id: String(seen.ids[1]), reason: 'fingerprint-mismatch' },
    ]);
  }, 60_000);

  test('REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated', async () => {
    const topic = topicFor('untranslated');
    const { probe, producer } = build<{ orderId: string }>(topic, {});
    await open(probe, producer, topic);

    const body = { orderId: 'd-1' };
    const key = `kafka-${topic}`;
    const store = new MemoryStore();
    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });

    const claim = await store.begin(
      { scope: topic, key, fingerprint: await messageFingerprint(body) },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    await producer.publish(body, { key: 'anyonce', headers: { 'idempotency-key': key } });
    await settled.reaches(1);

    expect(ran).toBe(0);
    expect(seen.results).toEqual([{ handled: false }]);
    const error = seen.errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).translated).toBe(false);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);
});
