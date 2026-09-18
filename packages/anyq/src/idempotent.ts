import {
  defaultPolicy,
  type ExecutePolicy,
  execute,
  type Operation,
  type StoredResult,
} from '@anyonce/core';
import type { IMessage, MessageHandler } from '@anyq/core';
import { FingerprintMismatchError, InFlightError } from './errors';
import {
  type IdempotentOptions,
  type ResolvedOptions,
  resolveKey,
  resolveOptions,
  resolveScope,
} from './options';

/** Q2: the wrapper cannot see the consumer config, so it checks the previous delivery's error on the next one. */
const UNTRANSLATED_WARNING =
  'anyonce: an in-flight duplicate was reported to anyq but no strategy translated it. ' +
  'Configure idempotencyStrategy() on the consumer so duplicates park instead of taking the legacy retry path.';

/** D15: the only result a queue operation ever stores (REQ-Q-5, Q43). */
const OK_RESULT: StoredResult = { kind: 'message', outcome: 'ok' };

function policyFor<T>(options: ResolvedOptions<T>): ExecutePolicy {
  const overrides: Partial<ExecutePolicy> = { clock: options.clock };
  if (options.leaseMs !== undefined) overrides.leaseMs = options.leaseMs;
  if (options.ttlMs !== undefined) overrides.ttlMs = options.ttlMs;
  if (options.onStoreError !== undefined) overrides.onStoreError = options.onStoreError;
  if (options.hooks !== undefined) overrides.hooks = options.hooks;
  return defaultPolicy(overrides);
}

/**
 * REQ-Q-1: wraps an anyq MessageHandler so the handler runs at most once per identity while the record is alive.
 * Outcomes are D15: a completed duplicate returns without running the handler (anyq acks it under autoAck), an
 * in-flight duplicate throws InFlightError for the companion strategy to park, a payload mismatch throws
 * FingerprintMismatchError for the companion strategy to dead-letter, and a handler exception abandons the claim
 * and rethrows so anyq's own retry policy applies unchanged (REQ-Q-3).
 */
export function idempotent<T = unknown>(
  handler: MessageHandler<T>,
  options: IdempotentOptions<T>,
): MessageHandler<T> {
  const resolved = resolveOptions(options);
  const policy = policyFor(resolved);
  let pending: InFlightError | undefined;
  let warned = false;

  return async (message: IMessage<T>): Promise<void> => {
    const previous = pending;
    pending = undefined;
    if (previous !== undefined && !previous.translated && !warned) {
      warned = true;
      resolved.logger.warn(UNTRANSLATED_WARNING);
    }

    const op: Operation = {
      scope: resolveScope(message, resolved),
      key: await resolveKey(message, resolved),
      fingerprint: await resolved.fingerprint(message),
    };

    const outcome = await execute(
      resolved.store,
      op,
      async () => {
        await handler(message);
        return OK_RESULT;
      },
      policy,
    );

    switch (outcome.kind) {
      case 'executed':
      case 'replayed':
        return;
      case 'conflict': {
        if (resolved.onInFlight === 'ack') return;
        const delayMs = Math.max(1, outcome.leaseUntil - resolved.clock());
        const error = new InFlightError(outcome.leaseUntil, delayMs);
        pending = error;
        throw error;
      }
      case 'mismatch':
        throw new FingerprintMismatchError(outcome.record);
      default:
        throw outcome.error;
    }
  };
}
