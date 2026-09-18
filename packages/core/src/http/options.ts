import {
  DEFAULT_MAX_RESULT_BYTES,
  defaultPolicy,
  type ExecuteHooks,
  type ExecutePolicy,
} from '../engine';
import type { KeySyntax } from '../key';
import type { Store, StoredResult } from '../types';
import { DEFAULT_PROBLEM_BASE_URI, type Problem } from './problems';

export type FingerprintMode = 'body' | 'jcs';
export type FingerprintFn = (req: Request, body: Uint8Array) => Promise<string> | string;

export const DEFAULT_METHODS = ['POST', 'PATCH'];
export const DEFAULT_HEADER_NAME = 'Idempotency-Key';
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
export const DEFAULT_STORED_HEADERS = [
  'Content-Type',
  'Content-Language',
  'Location',
  'ETag',
  'Link',
];

/** Options for withIdempotency and the framework bindings (requirements 4.4). */
export interface HttpIdempotencyOptions {
  store: Store;
  /** REQ-HTTP-1: methods the layer applies to; others pass through. Default POST and PATCH. */
  methods?: string[];
  /** REQ-HTTP-2: header name, matched case-insensitively. Default Idempotency-Key. */
  headerName?: string;
  /** REQ-HTTP-3: a missing header is 400 missing-key when true, pass-through when false. Default false. */
  required?: boolean;
  /** REQ-HTTP-4 and D7. Default lenient. */
  keySyntax?: KeySyntax;
  /** REQ-HTTP-5: replaces the default scope of METHOD plus route pattern or pathname. */
  scope?: (req: Request) => string;
  /** REQ-HTTP-5: appended to the scope after a hash. */
  principal?: (req: Request) => string | undefined;
  /** REQ-HTTP-5: a principal function that returns nothing yields 500 missing-principal. Default false. */
  requirePrincipal?: boolean;
  /** REQ-HTTP-6 and D9. Default body. */
  fingerprint?: FingerprintMode | FingerprintFn;
  /** REQ-HTTP-6: larger bodies are 413 payload-too-large. Default 1 MiB. */
  maxRequestBytes?: number;
  /** REQ-HTTP-8: response headers stored and replayed. Set-Cookie is never stored. */
  storeHeaders?: string[];
  leaseMs?: number;
  ttlMs?: number;
  /**
   * D12: larger results are stored in the omitted form. Default 1 MiB, and never more than the store's own
   * `maxResultBytes` when it declares one (Q20), so a store that cannot hold a result is never asked to.
   */
  maxResultBytes?: number;
  storeResult?: (result: StoredResult) => boolean;
  onStoreError?: 'fail-closed' | 'fail-open';
  clock?: () => number;
  hooks?: ExecuteHooks;
  hookErrors?: { count: number };
  /** D11. Default https://in8.sh/anyonce/problems/ */
  problemBaseUri?: string;
  /** REQ-HTTP-3: the Link target on a 400 missing-key. Default problemBaseUri plus missing-key. */
  docsUrl?: string;
  /** REQ-HTTP-13: render a problem differently. Status and code must not change. */
  onError?: (problem: Problem, req: Request) => Response | Promise<Response>;
  /** REQ-HTTP-15: per-request opt-out. */
  skip?: (req: Request) => boolean;
}

export interface ResolvedHttpOptions {
  store: Store;
  methods: Set<string>;
  headerName: string;
  required: boolean;
  keySyntax: KeySyntax;
  scope?: (req: Request) => string;
  principal?: (req: Request) => string | undefined;
  requirePrincipal: boolean;
  fingerprint: FingerprintMode | FingerprintFn;
  maxRequestBytes: number;
  storeHeaders: Set<string>;
  policy: ExecutePolicy;
  problemBaseUri: string;
  docsUrl: string;
  onError?: (problem: Problem, req: Request) => Response | Promise<Response>;
  skip?: (req: Request) => boolean;
}

export function resolveHttpOptions(options: HttpIdempotencyOptions): ResolvedHttpOptions {
  if (options.requirePrincipal === true && options.principal === undefined) {
    throw new TypeError('anyonce: requirePrincipal is true but no principal function was given');
  }
  const policyOverrides: Partial<ExecutePolicy> = {};
  if (options.leaseMs !== undefined) policyOverrides.leaseMs = options.leaseMs;
  if (options.ttlMs !== undefined) policyOverrides.ttlMs = options.ttlMs;
  // Q20: the policy cap never exceeds what the store says it can hold whole.
  policyOverrides.maxResultBytes = Math.min(
    options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    options.store.maxResultBytes ?? Number.POSITIVE_INFINITY,
  );
  if (options.storeResult !== undefined) policyOverrides.storeResult = options.storeResult;
  if (options.onStoreError !== undefined) policyOverrides.onStoreError = options.onStoreError;
  if (options.clock !== undefined) policyOverrides.clock = options.clock;
  if (options.hooks !== undefined) policyOverrides.hooks = options.hooks;
  if (options.hookErrors !== undefined) policyOverrides.hookErrors = options.hookErrors;
  const problemBaseUri = options.problemBaseUri ?? DEFAULT_PROBLEM_BASE_URI;
  const resolved: ResolvedHttpOptions = {
    store: options.store,
    methods: new Set((options.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase())),
    headerName: options.headerName ?? DEFAULT_HEADER_NAME,
    required: options.required ?? false,
    keySyntax: options.keySyntax ?? 'lenient',
    requirePrincipal: options.requirePrincipal ?? false,
    fingerprint: options.fingerprint ?? 'body',
    maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    storeHeaders: new Set(
      (options.storeHeaders ?? DEFAULT_STORED_HEADERS).map((h) => h.toLowerCase()),
    ),
    policy: defaultPolicy(policyOverrides),
    problemBaseUri,
    docsUrl: options.docsUrl ?? `${problemBaseUri}missing-key`,
  };
  if (options.scope !== undefined) resolved.scope = options.scope;
  if (options.principal !== undefined) resolved.principal = options.principal;
  if (options.onError !== undefined) resolved.onError = options.onError;
  if (options.skip !== undefined) resolved.skip = options.skip;
  return resolved;
}
