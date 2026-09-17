import type {
  BeginOutcome,
  CompleteStatus,
  IdempotencyRecord,
  OmittedResult,
  Operation,
  Store,
  StoredResult,
} from './types';

export interface ExecuteHooks {
  onAcquired?(op: Operation): void;
  onReplayed?(op: Operation, record: IdempotencyRecord): void;
  onConflict?(op: Operation, leaseUntil: number): void;
  onMismatch?(op: Operation, record: IdempotencyRecord): void;
  onStoreError?(op: Operation, error: unknown): void;
}

export interface ExecutePolicy {
  leaseMs: number;
  ttlMs: number;
  maxResultBytes: number;
  storeResult: (result: StoredResult) => boolean;
  onStoreError: 'fail-closed' | 'fail-open';
  clock?: () => number;
  hooks?: ExecuteHooks;
  /** Incremented every time a hook throws. Hooks never throw into the engine (3.3). */
  hookErrors?: { count: number };
}

export type ExecuteResult =
  | { kind: 'executed'; result: StoredResult; stored: boolean }
  | { kind: 'replayed'; record: IdempotencyRecord }
  | { kind: 'conflict'; leaseUntil: number }
  | { kind: 'mismatch'; record: IdempotencyRecord }
  | { kind: 'store_error'; error: unknown };

export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_TTL_MS = 86_400_000;
export const DEFAULT_MAX_RESULT_BYTES = 1_048_576;

/** D6: store message outcomes and HTTP results below 500. */
export function defaultStoreResult(result: StoredResult): boolean {
  return result.kind === 'message' || (result.status ?? 500) < 500;
}

export function defaultPolicy(overrides: Partial<ExecutePolicy> = {}): ExecutePolicy {
  return {
    leaseMs: DEFAULT_LEASE_MS,
    ttlMs: DEFAULT_TTL_MS,
    maxResultBytes: DEFAULT_MAX_RESULT_BYTES,
    storeResult: defaultStoreResult,
    onStoreError: 'fail-closed',
    ...overrides,
  };
}

/** Q17: the cap bounds stored bodies; headers are allowlisted and small. */
export function resultSize(result: StoredResult): number {
  return result.body?.byteLength ?? 0;
}

/** D12 and Q7: the omitted form keeps status and headers so a replay can reproduce them. */
export function omitBody(result: StoredResult): OmittedResult {
  const out: OmittedResult = { omitted: true, kind: result.kind };
  if (result.status !== undefined) out.status = result.status;
  if (result.headers !== undefined) out.headers = result.headers;
  return out;
}

type Safely = (fn: () => void) => void;

async function abandonQuietly(
  store: Store,
  op: Operation,
  fence: number,
  hooks: ExecuteHooks,
  safely: Safely,
): Promise<void> {
  try {
    await store.abandon(op, fence);
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
  }
}

/**
 * The one state machine (requirements 3.3). Runs the handler at most once per acquired claim, replays completed
 * results, reports conflicts and mismatches, and never lets a hook or a store failure change which of those it did.
 */
export async function execute(
  store: Store,
  op: Operation,
  /** Receives the fence of the acquired claim; 0 when running without a claim under fail-open. */
  run: (fence: number) => Promise<StoredResult>,
  policy: ExecutePolicy,
): Promise<ExecuteResult> {
  const now = (): number => (policy.clock ?? Date.now)();
  const hooks: ExecuteHooks = policy.hooks ?? {};
  const safely: Safely = (fn) => {
    try {
      fn();
    } catch {
      if (policy.hookErrors !== undefined) policy.hookErrors.count += 1;
    }
  };

  let outcome: BeginOutcome;
  try {
    outcome = await store.begin(op, { leaseMs: policy.leaseMs, ttlMs: policy.ttlMs, now: now() });
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
    if (policy.onStoreError === 'fail-closed') return { kind: 'store_error', error };
    return { kind: 'executed', result: await run(0), stored: false };
  }

  if (outcome.outcome === 'completed') {
    const { record } = outcome;
    safely(() => hooks.onReplayed?.(op, record));
    return { kind: 'replayed', record };
  }
  if (outcome.outcome === 'in_flight') {
    const { leaseUntil } = outcome;
    safely(() => hooks.onConflict?.(op, leaseUntil));
    return { kind: 'conflict', leaseUntil };
  }
  if (outcome.outcome === 'mismatch') {
    const { record } = outcome;
    safely(() => hooks.onMismatch?.(op, record));
    return { kind: 'mismatch', record };
  }

  const { fence } = outcome;
  safely(() => hooks.onAcquired?.(op));

  let result: StoredResult;
  try {
    result = await run(fence);
  } catch (error) {
    await abandonQuietly(store, op, fence, hooks, safely);
    throw error;
  }

  if (!policy.storeResult(result)) {
    await abandonQuietly(store, op, fence, hooks, safely);
    return { kind: 'executed', result, stored: false };
  }

  const payload = resultSize(result) > policy.maxResultBytes ? omitBody(result) : result;
  let status: CompleteStatus;
  try {
    status = await store.complete(op, fence, payload, now());
  } catch (error) {
    safely(() => hooks.onStoreError?.(op, error));
    return { kind: 'executed', result, stored: false };
  }
  return { kind: 'executed', result, stored: status === 'ok' };
}
