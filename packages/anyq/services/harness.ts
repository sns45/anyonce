import type { ApplyStrategyResult, IMessage, MessageHandler } from '@anyq/core';

/**
 * The pieces every adapter suite drives a real anyq consumer with. The four Probe classes stay in their own
 * files because they extend four different consumers, but everything below is adapter independent.
 */

/** Counts deliveries and hands out a promise per count, so no test waits on a duration. */
export interface Deliveries {
  hit(): void;
  reaches(at: number): Promise<void>;
}

export function deliveries(): Deliveries {
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

/** What a suite records about the deliveries it saw. */
export interface Driven {
  ids: string[];
  errors: Error[];
  results: ApplyStrategyResult[];
}

export function record(): Driven {
  return { ids: [], errors: [], results: [] };
}

/** The one method drive needs from a suite's Probe, which widens BaseConsumer's protected applyStrategy. */
export interface StrategyProbe<T> {
  runStrategy(
    message: IMessage<T>,
    error: Error,
    reinvoke?: () => Promise<void>,
  ): Promise<ApplyStrategyResult>;
}

const ALWAYS = (): boolean => true;

/**
 * The shape of every anyq consumer's catch block: run the handler, and on a throw hand the error to the
 * strategy with a re-invocation of the same handler. Driving it here keeps the ApplyStrategyResult, which the
 * adapter's own loop discards.
 *
 * `ack` decides whether a delivery the handler completed is acknowledged, and defaults to acknowledging every
 * one. The Redis Streams redelivery case passes a predicate so the first delivery stays pending and the
 * adapter's own XAUTOCLAIM path can redeliver the same entry.
 */
export function drive<T>(
  probe: StrategyProbe<T>,
  wrapped: MessageHandler<T>,
  seen: Driven,
  settled: Deliveries,
  ack: (delivery: number) => boolean = ALWAYS,
): MessageHandler<T> {
  return async (message: IMessage<T>): Promise<void> => {
    seen.ids.push(message.id);
    const delivery = seen.ids.length;
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
    // already decided the message's fate, so acknowledging here too would be a second call for one delivery,
    // which on SQS means a second DeleteMessage against a spent receipt handle.
    if (!disposed && ack(delivery)) await message.ack();
    settled.hit();
  };
}
