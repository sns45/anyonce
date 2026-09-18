import type { IdempotencyRecord } from '@anyonce/core';

/** Stable discriminators so a second copy of this package in one dependency tree still translates (see isInFlightError). */
export type QueueErrorCode = 'in-flight' | 'fingerprint-mismatch' | 'fingerprint' | 'configuration';

/**
 * Base for every error the queue door throws. `retryable` is a plain property so anyq's isRetryableError
 * predicate reads it without this package extending AnyQError, which would make @anyq/core a runtime dependency.
 */
export class AnyonceQueueError extends Error {
  readonly code: QueueErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: QueueErrorCode, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** D15: a duplicate arrived while the first claim is still in flight. The companion strategy parks for delayMs. */
export class InFlightError extends AnyonceQueueError {
  readonly leaseUntil: number;
  readonly delayMs: number;
  /** Set by idempotencyStrategy when it turns this error into a park decision (REQ-Q-8). */
  translated = false;

  constructor(leaseUntil: number, delayMs: number) {
    super('anyonce: a duplicate of this message is already being processed', 'in-flight', true);
    this.name = 'InFlightError';
    this.leaseUntil = leaseUntil;
    this.delayMs = delayMs;
  }
}

/** D15: the same identity arrived with a different payload. The companion strategy dead-letters it. */
export class FingerprintMismatchError extends AnyonceQueueError {
  readonly record: IdempotencyRecord;

  constructor(record: IdempotencyRecord) {
    super(
      'anyonce: this message identity was seen with a different payload',
      'fingerprint-mismatch',
      false,
    );
    this.name = 'FingerprintMismatchError';
    this.record = record;
  }
}

/** Q3: the body could not be canonicalized, so no fingerprint exists. Never a silent fallback. */
export class FingerprintError extends AnyonceQueueError {
  constructor(cause: unknown) {
    super(
      'anyonce: the message body cannot be canonicalized for a fingerprint',
      'fingerprint',
      false,
    );
    this.name = 'FingerprintError';
    this.cause = cause;
  }
}

/** Q42: the wrapper cannot derive something it needs and the caller must supply it. */
export class QueueConfigurationError extends AnyonceQueueError {
  constructor(message: string) {
    super(message, 'configuration', false);
    this.name = 'QueueConfigurationError';
  }
}

function hasCode(value: unknown, code: QueueErrorCode): boolean {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === code;
}

/** True for an InFlightError from this copy of the package or from another one. */
export function isInFlightError(value: unknown): value is InFlightError {
  return value instanceof InFlightError || hasCode(value, 'in-flight');
}

/** True for a FingerprintMismatchError from this copy of the package or from another one. */
export function isFingerprintMismatchError(value: unknown): value is FingerprintMismatchError {
  return value instanceof FingerprintMismatchError || hasCode(value, 'fingerprint-mismatch');
}
