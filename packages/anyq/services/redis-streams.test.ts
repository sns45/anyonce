import { afterEach, expect, test } from 'bun:test';
import { MemoryStore } from '@anyonce/core';
import type { ApplyStrategyResult, IMessage } from '@anyq/core';
import { RedisStreamsConsumer, RedisStreamsProducer } from '@anyq/redis-streams';
import { InFlightError } from '../src/errors';
import { messageFingerprint } from '../src/fingerprint';
import { idempotent } from '../src/idempotent';
import { idempotencyStrategy } from '../src/strategy';
import { deliveries, drive, record } from './harness';
import { describeService } from './services';

/**
 * REQ-Q-6 and REQ-Q-8 against a real Redis Streams consumer group on 127.0.0.1:6379.
 *
 * This is the suite that proves the derived scope path against real provider metadata: nothing passes `scope`,
 * so `${stream}/${group}` comes out of `message.metadata.redisStreams` plus the `consumerGroup` option.
 * The adapter has no native delayed redelivery, so a park decision downgrades to an in-process retry, which
 * `allowParkDowngrade` opts into. A stream entry id is stable across redelivery, so `key: 'id'` is safe here.
 */

const HOST = '127.0.0.1';
const PORT = 6379;

/** applyStrategy and deadLetterMessage are protected on BaseConsumer; this widens what a test drives. */
class Probe<T> extends RedisStreamsConsumer<T> {
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

function names(label: string): { stream: string; group: string } {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { stream: `anyonce-rs-${label}-${suffix}`, group: 'anyonce-group' };
}

let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

function build<T>(
  stream: string,
  group: string,
  extra: { strategy?: ReturnType<typeof idempotencyStrategy> },
): { probe: Probe<T>; producer: RedisStreamsProducer<T> } {
  const redis = { host: HOST, port: PORT };
  const probe = new Probe<T>({
    driver: 'redis-streams',
    streamName: stream,
    consumerGroup: { groupName: group, consumerName: 'anyonce-consumer' },
    redis,
    blockTimeout: 100,
    claimTimeout: 1,
    minIdleTime: 100,
    allowParkDowngrade: true,
    logging: { enabled: false },
    ...extra,
  });
  const producer = new RedisStreamsProducer<T>({
    driver: 'redis-streams',
    streamName: stream,
    redis,
    logging: { enabled: false },
  });
  return { probe, producer };
}

async function open<T>(
  probe: Probe<T>,
  producer: RedisStreamsProducer<T>,
  stream: string,
): Promise<void> {
  await producer.connect();
  await probe.connect();
  cleanup.push(async () => {
    await probe.getClient()?.del(stream);
    await probe.disconnect();
    await producer.disconnect();
  });
}

await describeService('anyq redis-streams consumer', PORT, () => {
  test('REQ-Q-6: a redis-streams consumer runs a wrapped handler once when the same entry is redelivered', async () => {
    const { stream, group } = names('once');
    const { probe, producer } = build<{ orderId: string }>(stream, group, {});
    await open(probe, producer, stream);

    const store = new MemoryStore();
    const body = { orderId: 'a-1' };
    let ran = 0;
    // key 'id' is the stream entry id, which XAUTOCLAIM preserves across a redelivery.
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'id', consumerGroup: group },
    );
    const seen = record();
    const settled = deliveries();
    // The first delivery is deliberately left unacknowledged, so it stays pending and the consumer's own
    // XAUTOCLAIM path redelivers the very same entry. From the second on the entry is acknowledged.
    await probe.subscribe(
      drive(probe, wrapped, seen, settled, (delivery) => delivery > 1),
      {
        autoAck: false,
      },
    );

    const entryId = await producer.publish(body);
    await settled.reaches(2);

    expect(seen.ids[0]).toBe(entryId);
    expect(seen.ids[1]).toBe(entryId);
    expect(ran).toBe(1);
    expect(seen.errors).toEqual([]);

    // Q42: no scope was passed. The stream half came out of message.metadata.redisStreams and the group half
    // out of the consumerGroup option, which is what D8's ${queueName}/${consumerGroup} asks for.
    const stored = await store.get({ scope: `${stream}/${group}`, key: entryId }, Date.now());
    expect(stored?.state).toBe('completed');
    expect(stored?.result).toEqual({ kind: 'message', outcome: 'ok' });
  }, 60_000);

  test('REQ-Q-8: with the strategy configured, an in-flight duplicate downgrades to a park and the handler waits for the lease', async () => {
    const { stream, group } = names('park');
    const { probe, producer } = build<{ orderId: string }>(stream, group, {
      strategy: idempotencyStrategy(),
    });
    await open(probe, producer, stream);

    const store = new MemoryStore();
    const body = { orderId: 'b-1' };
    const entryId = await producer.publish(body);
    const claimedAt = Date.now();
    const leaseMs = 300;
    const leaseUntil = claimedAt + leaseMs;
    const claim = await store.begin(
      { scope: `${stream}/${group}`, key: entryId, fingerprint: await messageFingerprint(body) },
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
      { store, key: 'id', consumerGroup: group },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await settled.reaches(1);

    expect(seen.errors[0]).toBeInstanceOf(InFlightError);
    expect(seen.results[0]).toEqual({ handled: true });
    expect(ran).toBe(1);
    expect(firstCallAt).toBeGreaterThanOrEqual(leaseUntil);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);

  test('REQ-Q-8: with the strategy configured, a payload mismatch dead-letters with reason fingerprint-mismatch', async () => {
    const { stream, group } = names('mismatch');
    const { probe, producer } = build<{ orderId: string; total: number }>(stream, group, {
      strategy: idempotencyStrategy(),
    });
    await open(probe, producer, stream);

    const store = new MemoryStore();
    let ran = 0;
    // Two entries carrying one producer supplied key: the second body is not the one the first claim recorded.
    const wrapped = idempotent<{ orderId: string; total: number }>(
      async () => {
        ran += 1;
      },
      { store, key: 'header', keyHeader: 'idempotency-key', consumerGroup: group },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    const headers = { 'idempotency-key': `rs-${stream}` };
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
    const { stream, group } = names('untranslated');
    const { probe, producer } = build<{ orderId: string }>(stream, group, {});
    await open(probe, producer, stream);

    const store = new MemoryStore();
    const body = { orderId: 'd-1' };
    const entryId = await producer.publish(body);
    const claim = await store.begin(
      { scope: `${stream}/${group}`, key: entryId, fingerprint: await messageFingerprint(body) },
      { leaseMs: 60_000, ttlMs: 60_000, now: Date.now() },
    );
    expect(claim.outcome).toBe('acquired');

    let ran = 0;
    const wrapped = idempotent<{ orderId: string }>(
      async () => {
        ran += 1;
      },
      { store, key: 'id', consumerGroup: group },
    );
    const seen = record();
    const settled = deliveries();
    await probe.subscribe(drive(probe, wrapped, seen, settled), { autoAck: false });

    await settled.reaches(1);

    expect(ran).toBe(0);
    expect(seen.results).toEqual([{ handled: false }]);
    const error = seen.errors[0];
    expect(error).toBeInstanceOf(InFlightError);
    expect((error as InFlightError).translated).toBe(false);
    expect(probe.deadLetters).toEqual([]);
  }, 60_000);
});
