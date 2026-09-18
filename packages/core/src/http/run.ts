import { type ExecuteHooks, type ExecutePolicy, execute } from '../engine';
import type { Operation } from '../types';
import { type Capture, captureResponse, replayResponse } from './capture';
import type { ResolvedHttpOptions } from './options';
import { type ProblemCode, problem, problemResponse } from './problems';
import { type KeyLookup, lookupKey, readBody, requestFingerprint, resolveScope } from './request';

/** REQ-HTTP-14: what a handler can learn about the claim it runs under. */
export interface IdempotencyInfo {
  key: string;
  fence: number;
}

const infoByRequest = new WeakMap<Request, IdempotencyInfo>();

/** REQ-HTTP-14 for withIdempotency: undefined when the request ran outside the layer. */
export function idempotencyOf(req: Request): IdempotencyInfo | undefined {
  return infoByRequest.get(req);
}

export type IdempotentRun = (req: Request, info: IdempotencyInfo | undefined) => Promise<Response>;

export interface RunContext {
  /** A router's scope (METHOD plus pattern); used when the options carry no scope function. */
  routeScope?: string;
  /**
   * REQ-WH-1: a key the caller already resolved, for a door whose key does not come from one header read (the
   * webhook door reads webhook-id or derives an id from the body). All three branches behave as if the bridge
   * had read the header itself, so required, the Link header and the invalid-key detail are unchanged.
   */
  keyLookup?: KeyLookup;
  /**
   * Body bytes the caller already read. A door that must see the body before the store (signature verification,
   * a body derived id) reads it once and hands the bytes over instead of making the bridge clone and read again.
   */
  body?: Uint8Array;
}

function retryAfterSeconds(leaseUntil: number, now: number): string {
  return String(Math.max(1, Math.ceil((leaseUntil - now) / 1000)));
}

/**
 * REQ-HTTP-13 follow-up: merges the protocol headers the bridge would otherwise have set onto an onError
 * response, without overriding any the handler already set itself. Response headers may be immutable, so a
 * missing header is applied to a copy built from the original body and init.
 */
function withProtocolHeaders(res: Response, headers: [string, string][]): Response {
  const missing = headers.filter(([name]) => !res.headers.has(name));
  if (missing.length === 0) return res;
  if (res.bodyUsed) return res;
  let copy: Response;
  try {
    copy = new Response(res.body, res);
  } catch {
    return res;
  }
  for (const [name, value] of missing) copy.headers.set(name, value);
  return copy;
}

/**
 * The transport bridge (requirements 4.4). Every framework binding calls this with the raw Request and a run
 * callback that invokes the downstream handler. Returns the response to send, streaming when the handler streams.
 */
export async function runIdempotent(
  req: Request,
  run: IdempotentRun,
  options: ResolvedHttpOptions,
  ctx: RunContext = {},
): Promise<Response> {
  // RFC 9110 method names are case sensitive and the Fetch spec does not normalize every spelling, so the wire
  // method is compared as it arrived. The configured set is uppercased because that is configuration, not wire.
  if (!options.methods.has(req.method)) return run(req, undefined);
  if (options.skip?.(req) === true) return run(req, undefined);

  const fail = async (
    code: ProblemCode,
    detail?: string,
    headers: [string, string][] = [],
  ): Promise<Response> => {
    const p = problem(code, options.problemBaseUri, detail, options.problemTitles?.[code]);
    if (options.onError !== undefined) {
      const res = await options.onError(p, req);
      return withProtocolHeaders(res, [...headers, ['Cache-Control', 'no-store']]);
    }
    return problemResponse(p, headers);
  };

  const lookup = ctx.keyLookup ?? lookupKey(req.headers, options.headerName, options.keySyntax);
  if (lookup.kind === 'missing') {
    if (!options.required) return run(req, undefined);
    return fail('missing-key', undefined, [['Link', `<${options.docsUrl}>; rel="describedby"`]]);
  }
  if (lookup.kind === 'invalid') return fail('invalid-key', lookup.reason);

  const scope = resolveScope(req, options, ctx.routeScope);
  if (!scope.ok) return fail('missing-principal');

  const body =
    ctx.body !== undefined
      ? ({ ok: true, body: ctx.body } as const)
      : await readBody(req, options.maxRequestBytes);
  if (!body.ok) return fail('payload-too-large');
  const fingerprint = await requestFingerprint(req, body.body, options.fingerprint);
  const op: Operation = { scope: scope.scope, key: lookup.key, fingerprint };

  let degraded = false;
  const userHooks: ExecuteHooks = options.policy.hooks ?? {};
  const policy: ExecutePolicy = {
    ...options.policy,
    hooks: {
      ...userHooks,
      onStoreError(o, error) {
        degraded = true;
        userHooks.onStoreError?.(o, error);
      },
    },
  };
  const now = (): number => (policy.clock ?? Date.now)();

  let capture: Capture | undefined;
  let resolveClient!: (res: Response) => void;
  const client = new Promise<Response>((resolve) => {
    resolveClient = resolve;
  });

  const outcome = execute(
    options.store,
    op,
    async (fence) => {
      const info: IdempotencyInfo = { key: op.key, fence };
      infoByRequest.set(req, info);
      const res = await run(req, info);
      capture = captureResponse(
        res,
        options.storeHeaders,
        policy.maxResultBytes,
        degraded ? [['Idempotency-Degraded', 'true']] : [],
      );
      if (capture.streaming) resolveClient(capture.response);
      return capture.stored;
    },
    policy,
  );

  const settled: Promise<Response> = outcome.then(
    async (result) => {
      switch (result.kind) {
        case 'executed': {
          if (capture === undefined) {
            throw new Error('anyonce: executed without a captured response');
          }
          capture.close();
          resolveClient(capture.response);
          return capture.response;
        }
        case 'replayed':
          return replayResponse(result.record);
        case 'conflict':
          return fail('conflict', undefined, [
            ['Retry-After', retryAfterSeconds(result.leaseUntil, now())],
          ]);
        case 'mismatch':
          return fail('fingerprint-mismatch');
        case 'store_error':
          return fail('store-unavailable', undefined, [['Retry-After', '1']]);
      }
    },
    (error: unknown) => {
      if (capture !== undefined) {
        capture.fail(error);
        return capture.response;
      }
      throw error;
    },
  );

  return Promise.race([client, settled]);
}
