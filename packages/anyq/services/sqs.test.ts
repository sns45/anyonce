import { afterEach, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { ApplyStrategyResult, IMessage, MessageHandler, RetryDecision } from '@anyq/core';
import { SQSConsumer, SQSProducer } from '@anyq/sqs';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { InFlightError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { idempotent } from '../src/idempotent';
import { idempotencyStrategy } from '../src/strategy';
import { describeService } from './services';

/**
 * REQ-Q-6 and REQ-Q-8 against a real SQS consumer talking to the ElasticMQ container on 127.0.0.1:9324.
 *
 * Q40: an anyq park on SQS re-publishes the body and drops both the message id and the message attributes, so
 * `key: 'body'` is the park stable key source here. Q44: the published @anyq/sqs 0.5.0 park path fails against
 * ElasticMQ 1.6.12, so this suite never drives a park to completion. It asserts every outcome that does not
 * involve park, plus the companion strategy's decision for an in-flight error, which is the park decision
 * itself. The end to end park proofs live in the memory suite (native park) and the Kafka suite (downgrade).
 */

const PORT = 9324;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const CONNECTION = {
  region: 'us-east-1',
  endpoint: ENDPOINT,
  accessKeyId: 'anyonce',
  secretAccessKey: 'anyonce',
} as const;

/** applyStrategy and deadLetterMessage are protected on BaseConsumer; this widens what a test drives. */
class Probe<T> extends SQSConsumer<T> {
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
    // already decided the message's fate, and on SQS a second DeleteMessage for one receipt handle is an error.
    if (!disposed) await message.ack();
    settled.hit();
  };
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

async function makeQueue(label: string): Promise<string> {
  const admin = new SQSClient({
    region: CONNECTION.region,
    endpoint: CONNECTION.endpoint,
    credentials: {
      accessKeyId: CONNECTION.accessKeyId,
      secretAccessKey: CONNECTION.secretAccessKey,
    },
  });
  const name = `anyonce-sqs-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await admin.send(new CreateQueueCommand({ QueueName: name }));
  const queueUrl = created.QueueUrl;
  if (queueUrl === undefined) throw new Error('ElasticMQ returned no queue url');
  cleanup.push(async () => {
    await admin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    admin.destroy();
  });
  return queueUrl;
}

function build<T>(
  queueUrl: string,
  extra: { strategy?: ReturnType<typeof idempotencyStrategy> },
): { probe: Probe<T>; producer: SQSProducer<T> } {
  const probe = new Probe<T>({
    driver: 'sqs',
    sqs: CONNECTION,
    queueUrl,
    consumer: { waitTimeSeconds: 1, pollingInterval: 200, visibilityTimeout: 30 },
    logging: { enabled: false },
    ...extra,
  });
  const producer = new SQSProducer<T>({
    driver: 'sqs',
    sqs: CONNECTION,
    queueUrl,
    logging: { enabled: false },
  });
  return { probe, producer };
}

async function open<T>(probe: Probe<T>, producer: SQSProducer<T>): Promise<void> {
  await producer.connect();
  await probe.connect();
  cleanup.push(async () => {
    await probe.disconnect();
    await producer.disconnect();
  });
}

await describeService('anyq sqs consumer', PORT, () => {
  test('REQ-Q-6: an sqs consumer runs a wrapped handler once for a duplicate the producer re-sent', async () => {
    const queueUrl = await makeQueue('once');
    const { probe, producer } = build<{ orderId: string }>(queueUrl, {});
    await open(probe, producer);

    const store = new MemoryStore();
    const body = { orderId: 'a-1' };
    let ran = 0;
    // Q40: only 'body' survives an anyq park on SQS, and it is also what deduplicates a re-sent publish,
    // which mints a fresh MessageId and so cannot be followed by the id key source.
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'body' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await producer.publish(body);
    await producer.publish(body);
    await settled.reaches(2);

    expect(ran).toBe(1);
    expect(seen.errors).toEqual([]);
    expect(seen.ids[0]).not.toBe(seen.ids[1]);

    // The scope was derived from the message metadata, never passed in.
    const stored = await store.get(
      { scope: queueUrl, key: await messageFingerprint(body) },
      Date.now(),
    );
    expect(stored?.state).toBe('completed');
    expect(stored?.result).toEqual({ kind: 'message', outcome: 'ok' });
    expect(stored?.result?.body).toBeUndefined();
  }, 60_000);

  test('REQ-Q-8: an in-flight duplicate on sqs throws InFlightError and the strategy decides to park for the lease remainder', async () => {
    const queueUrl = await makeQueue('park');
    const { probe, producer } = build<{ orderId: string }>(queueUrl, {});
    await open(probe, producer);

    const store = new MemoryStore();
    const body = { orderId: 'b-1' };
    const fingerprint = await messageFingerprint(body);
    const claim = await store.begin(
      { scope: queueUrl, key: fingerprint, fingerprint },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'body' },
    );
    // Q44: applyStrategy would call the adapter's own parkMessage, which the bundled AWS SDK cannot complete
    // against ElasticMQ. The decision itself is what REQ-Q-8 asks this suite for, so it is taken directly.
    const strategy = idempotencyStrategy();
    const decisions: RetryDecision[] = [];
    const errors: Error[] = [];
    const settled = deliveries();
    await probe.subscribe(
      async (message) => {
        try {
          await wrapped(message);
        } catch (thrown) {
          const error = thrown instanceof Error ? thrown : new Error(String(thrown));
          errors.push(error);
          decisions.push(await strategy.decide({ message, error, attempt: 1, maxAttempts: 4 }));
        }
        await message.ack();
        settled.hit();
      },
      { autoAck: false },
    );

    await producer.publish(body);
    await settled.reaches(1);

    expect(ran).toBe(0);
    const error = errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    const inFlight = error as InFlightError;
    expect(decisions).toEqual([{ action: 'park', delayMs: inFlight.delayMs }]);
    expect(inFlight.translated).toBe(true);
  }, 60_000);

  test('REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch', async () => {
    const queueUrl = await makeQueue('mismatch');
    const { probe, producer } = build<{ orderId: string; total: number }>(queueUrl, {
      strategy: idempotencyStrategy(),
    });
    await open(probe, producer);

    const store = new MemoryStore();
    let ran = 0;
    // A mismatch needs a key that is not the payload itself, so this case uses the producer supplied header.
    const wrapped = idempotent<{ orderId: string; total: number }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    const headers = { 'idempotency-key': `sqs-${Date.now()}` };
    await producer.publish({ orderId: 'c-1', total: 1 }, { headers });
    await settled.reaches(1);
    await producer.publish({ orderId: 'c-1', total: 2 }, { headers });
    await settled.reaches(2);

    expect(ran).toBe(1);
    expect(seen.results).toEqual([{ handled: true }]);
    expect(probe.deadLetters).toEqual([
      { id: String(seen.ids[1]), reason: 'fingerprint-mismatch' },
    ]);
  }, 60_000);

  test('REQ-Q-8: with no strategy the typed error reaches anyq legacy handling untranslated', async () => {
    const queueUrl = await makeQueue('untranslated');
    const { probe, producer } = build<{ orderId: string }>(queueUrl, {});
    await open(probe, producer);

    const store = new MemoryStore();
    const body = { orderId: 'd-1' };
    const fingerprint = await messageFingerprint(body);
    const claim = await store.begin(
      { scope: queueUrl, key: fingerprint, fingerprint },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'body' },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await producer.publish(body);
    await settled.reaches(1);

    expect(ran).toBe(0);
    expect(seen.results).toEqual([{ handled: false }]);
    const error = seen.errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).translated).toBe(false);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);
});
