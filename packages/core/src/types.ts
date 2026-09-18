/** An idempotent operation identity: scope isolates tenants and routes, key comes from the client, fingerprint hashes the payload. */
export interface Operation {
  scope: string;
  key: string;
  fingerprint: string;
}

export type RecordState = 'in_flight' | 'completed';
export type ResultKind = 'http' | 'message';

export interface StoredResult {
  kind: ResultKind;
  status?: number;
  headers?: [string, string][];
  body?: Uint8Array;
  outcome?: 'ok' | 'error';
  error?: { name: string; message: string };
}

/** The form `complete` receives when the body exceeded maxResultBytes (Q7): status and headers survive, the body does not. */
export interface OmittedResult {
  omitted: true;
  kind: ResultKind;
  status?: number;
  headers?: [string, string][];
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  state: RecordState;
  fence: number;
  leaseUntil: number;
  createdAt: number;
  expiresAt: number;
  result?: StoredResult;
  resultOmitted?: boolean;
}

export type BeginOutcome =
  | { outcome: 'acquired'; fence: number }
  | { outcome: 'in_flight'; leaseUntil: number }
  | { outcome: 'completed'; record: IdempotencyRecord }
  | { outcome: 'mismatch'; record: IdempotencyRecord };

export interface BeginOptions {
  leaseMs: number;
  ttlMs: number;
  now: number;
}

export type CompleteStatus = 'ok' | 'stale_fence' | 'not_found';

/**
 * The claim store (requirements 4.2). Implementations must hold to the following contract.
 *
 * begin is one atomic operation: read and write happen together, never as a get followed by a separate lock.
 *
 * Precedence inside begin is TTL expiry first, then fingerprint, then state and lease. A row is live only while
 * expiresAt is greater than now; a row whose expiresAt is less than or equal to now counts as absent, so it can
 * never produce a mismatch or a conflict. A present row whose fingerprint differs from the operation yields
 * mismatch whatever its state or lease. A matching row in the completed state yields completed with its stored
 * result, whatever its leaseUntil. Only for a matching in_flight row does the lease decide: a live lease yields
 * in_flight, an expired one is taken over.
 *
 * A lease is live while leaseUntil is greater than now, so leaseUntil equal to now is already expired.
 *
 * The fence continues from the row while the row is physically present: a takeover writes old.fence plus 1, and
 * that holds across TTL expiry too, because an expired row is logically absent but physically still there. The
 * fence restarts at 1 only after the row is really gone, whether by purge, abandon, or a backend's own sweep.
 *
 * now is always the caller's injected clock reading, never the store's wall time. Every expiry, lease and
 * timestamp decision uses the now that was passed in, which is what makes the contract suite deterministic.
 */
export interface Store {
  begin(op: Operation, opts: BeginOptions): Promise<BeginOutcome>;
  complete(
    op: Operation,
    fence: number,
    result: StoredResult | OmittedResult,
    now: number,
  ): Promise<CompleteStatus>;
  abandon(op: Operation, fence: number): Promise<CompleteStatus>;
  get(op: Pick<Operation, 'scope' | 'key'>, now: number): Promise<IdempotencyRecord | null>;
  purge(now: number): Promise<number>;
  /**
   * Q20: the largest body this backend stores whole, when the backend has a limit of its own (a DynamoDB item
   * is capped at 400 KB). An adapter caps its own maxResultBytes policy at this value, so a result too large
   * for the backend is stored in the omitted form (status and headers replay, the body does not) instead of
   * reaching the store and failing there. Left undefined, the backend imposes no limit of its own.
   */
  readonly maxResultBytes?: number;
  close?(): Promise<void>;
}

export function isOmitted(result: StoredResult | OmittedResult): result is OmittedResult {
  return 'omitted' in result && result.omitted === true;
}
