import {
  type RetryDecision,
  type RetryStrategy,
  type RetryStrategyContext,
  retryThenDeadLetter,
} from '@anyq/core';
import { isFingerprintMismatchError, isInFlightError } from './errors';

/** The strategy's stable name. It is not one of anyq's park-free names, so a park-capable adapter check sees it. */
export const IDEMPOTENCY_STRATEGY_NAME = 'anyonce-idempotency';

/**
 * REQ-Q-8 and Q2: anyq's dead-letter and delay primitives are consumer hooks reachable only through a strategy
 * decision, so the door throws typed errors and this strategy translates them. An in-flight duplicate parks for
 * the lease remainder; a payload mismatch dead-letters with reason fingerprint-mismatch; everything else is the
 * inner strategy's business, which defaults to anyq's reference retryThenDeadLetter.
 *
 * On adapters without native delayed redelivery (Kafka, Redis Streams) anyq downgrades the park to an in-process
 * sleep followed by a re-invocation, which re-enters begin after the lease has expired. Those consumers must set
 * allowParkDowngrade so anyq's park policy check permits the downgrade.
 */
export function idempotencyStrategy<T = unknown>(inner?: RetryStrategy<T>): RetryStrategy<T> {
  const delegate = inner ?? retryThenDeadLetter<T>();
  return {
    name: IDEMPOTENCY_STRATEGY_NAME,
    async decide(ctx: RetryStrategyContext<T>): Promise<RetryDecision> {
      const error: unknown = ctx.error;
      if (isInFlightError(error)) {
        error.translated = true;
        return { action: 'park', delayMs: error.delayMs };
      }
      if (isFingerprintMismatchError(error)) {
        return { action: 'deadLetter', reason: 'fingerprint-mismatch' };
      }
      return delegate.decide(ctx);
    },
  };
}
