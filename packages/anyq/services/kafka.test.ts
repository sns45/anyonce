// kafkajs reads both of these when it builds a client, so they are set before any consumer connects.
process.env.KAFKAJS_LOG_LEVEL = 'nothing';
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

import { afterAll, afterEach, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { ApplyStrategyResult, IMessage, MessageHandler } from '@anyq/core';
import { KafkaConsumer, KafkaProducer } from '@anyq/kafka';
import { InFlightError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { idempotent } from '../src/idempotent';
import { idempotencyStrategy } from '../src/strategy';
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
 * kafkajs schedules its pending request check with a negative delay whenever nothing is throttled, and the
 * runtime reports that as a TimeoutNegativeWarning. It comes from inside the published @anyq/kafka bundle, so
 * this drops that one warning and still prints anything else, rather than silencing the process wholesale.
 */
function onWarning(warning: Error): void {
  if (warning.name === 'TimeoutNegativeWarning') return;
  console.warn(`${warning.name}: ${warning.message}`);
}
process.on('warning', onWarning);
afterAll(() => {
  process.off('warning', onWarning);
});

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

/** Counts deliveries and hands out a promise per count, so no test waits on a duration. */
function deliveries() {
  let hits = 0;
  const waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    hit(): void {
      hits += 1;
      for (const waiter of waiters) if (hits >= waiter.at) waiter.resolve();
    },
    reaches(at: number): Promise<void> {
      return new Promise<void>((resolve) => {
        if (hits >= at) resolve();
        else waiters.push({ at, resolve });
      });
    },
  };
}

interface Driven {
  ids: string[];
  errors: Error[];
  results: ApplyStrategyResult[];
}

function record(): Driven {
  return { ids: [], errors: [], results: [] };
}

/**
 * The shape of every anyq consumer's catch block: run the handler, and on a throw hand the error to the
 * strategy with a re-invocation of the same handler. Driving it here keeps the ApplyStrategyResult, which the
 * adapter's own loop discards.
 */
function drive<T>(
  probe: Probe<T>,
  wrapped: MessageHandler<T>,
  seen: Driven,
  settled: { hit(): void },
): MessageHandler<T> {
  return async (message: IMessage<T>): Promise<void> => {
    seen.ids.push(message.id);
    let disposed = false;
    try {
      await wrapped(message);
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      seen.errors.push(error);
      const result = await probe.runStrategy(message, error, () => wrapped(message));
      seen.results.push(result);
      disposed = result.handled;
    }
    // anyq acknowledges only a delivery the handler completed. Once the strategy has handled the failure it has
    // already decided the message's fate, so acknowledging here too would be a second call for one delivery.
    if (!disposed) await message.ack();
    settled.hit();
  };
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

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

/** The producer connects first and its publish auto-creates the topic, so the consumer never subscribes to a
 * topic that does not exist yet. The consumer then reads the partition from the beginning. */
async function open<T>(probe: Probe<T>, producer: KafkaProducer<T>): Promise<void> {
  await producer.connect();
  cleanup.push(async () => {
    await probe.disconnect();
    await producer.disconnect();
  });
}

await describeService('anyq kafka consumer', PORT, () => {
  test('REQ-Q-6: a kafka consumer runs a wrapped handler once for a duplicate the producer re-sent', async () => {
    const topic = topicFor('once');
    const { probe, producer } = build<{ orderId: string }>(topic, {});
    await open(probe, producer);

    const body = { orderId: 'a-1' };
    const key = `kafka-${topic}`;
    const headers = { 'idempotency-key': key };
    await producer.publish(body, { key: 'anyonce', headers });
    await producer.publish(body, { key: 'anyonce', headers });

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
    await probe.connect();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });
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
    await open(probe, producer);

    const body = { orderId: 'b-1' };
    const key = `kafka-${topic}`;
    await producer.publish(body, { key: 'anyonce', headers: { 'idempotency-key': key } });

    const store = new MemoryStore();
    const claimedAt = Date.now();
    const leaseMs = 300;
    const leaseUntil = claimedAt + leaseMs;
    const claim = await store.begin(
      { scope: topic, key, fingerprint: await messageFingerprint(body) },
      { leaseMs, ttlMs: 60_000, now: claimedAt },
    );
    expect(claim.outcome).toBe('acquired');

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
    await probe.connect();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });
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
    await open(probe, producer);

    const headers = { 'idempotency-key': `kafka-${topic}` };
    await producer.publish({ orderId: 'c-1', total: 1 }, { key: 'anyonce', headers });

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
    await probe.connect();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });
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
    await open(probe, producer);

    const body = { orderId: 'd-1' };
    const key = `kafka-${topic}`;
    await producer.publish(body, { key: 'anyonce', headers: { 'idempotency-key': key } });

    const store = new MemoryStore();
    const claim = await store.begin(
      { scope: topic, key, fingerprint: await messageFingerprint(body) },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.connect();
    await probe.subscribe(drive(probe, wrapped, seen, settled), {
      autoAck: false,
      fromBeginning: true,
    });
    await settled.reaches(1);

    expect(ran).toBe(0);
    expect(seen.results).toEqual([{ handled: false }]);
    const error = seen.errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).translated).toBe(false);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);
});
