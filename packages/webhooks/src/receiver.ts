import { type IdempotencyRecord, parseKey, sha256Hex } from '@anyonce/core';
import {
  type FetchLikeHandler,
  type HttpIdempotencyOptions,
  type KeyLookup,
  type ProblemCode,
  type ProblemTitles,
  problem,
  problemResponse,
  type ResolvedHttpOptions,
  readBody,
  resolveHttpOptions,
  runIdempotent,
} from '@anyonce/core/http';
import { isVerified } from './marker';

/** REQ-WH-1: the Standard Webhooks id header. */
export const DEFAULT_ID_HEADER = 'webhook-id';

export interface WebhookReceiverOptions
  extends Omit<
    HttpIdempotencyOptions,
    'headerName' | 'problemTitles' | 'scope' | 'principal' | 'keySyntax'
  > {
  /** REQ-WH-1: the header the delivery id arrives in. Default webhook-id. */
  idHeader?: string;
  /** REQ-WH-1: a body derived id (Stripe event.id, a GitHub delivery header). Wins over idHeader. */
  key?: (req: Request, body: Uint8Array) => string | undefined;
  /** D16: runs before the store. A false result is 401 signature-invalid. */
  verify?: (req: Request, body: Uint8Array) => boolean | Promise<boolean>;
  /** D16: the name of a marker an upstream verifier set with markVerified. */
  verifiedMarker?: string;
  /** REQ-WH-5: fires when the same id arrives with a different body. Never throws into the receiver. */
  onSuspicious?: (req: Request, record: IdempotencyRecord) => void;
  /** D8: the route half of the scope. Default is the request pathname. */
  routePattern?: string | ((req: Request) => string);
  /** D8 and Q24: the verified sender identity. When it yields nothing the scope is the route alone. */
  sourceId?: (req: Request, body: Uint8Array) => string | undefined;
  /** Q23: overrides on top of the webhook defaults, which name idHeader. */
  problemTitles?: ProblemTitles;
  /** Q26: where the one configuration-error message goes. Default console.error. */
  logger?: (message: string) => void;
}

/**
 * Q26 and ruling 12: the two lines the receiver ever logs, one per cause of a 500 configuration-error. Both
 * are fixed strings: no request data, no header value, no delivery id and, for the second, no part of the
 * verifier's own thrown error, because that error commonly quotes the header or the key it choked on (NFR-2).
 * Each cause has its own latch, so neither can suppress the other's one line.
 */
const CONFIGURATION_MESSAGE =
  'anyonce: webhookReceiver was built with neither verify nor verifiedMarker, so no delivery can be accepted (REQ-WH-2)';
const VERIFIER_FAILED_MESSAGE =
  'anyonce: the webhook verify callback failed, so no delivery can be accepted (REQ-WH-2)';

/**
 * Ruling 13: the RFC 9457 detail member is what tells the two causes of a 500 configuration-error apart. They
 * share one code because they are one class of failure. Both strings are byte identical to the Go twin's.
 */
const DETAIL_UNCONFIGURED = 'no verify callback or verifiedMarker is configured';
const DETAIL_VERIFIER_FAILED = 'the verify callback failed';

function webhookTitles(idHeader: string, overrides?: ProblemTitles): ProblemTitles {
  return {
    'missing-key': `The ${idHeader} header is required for this request`,
    'invalid-key': `The ${idHeader} header value is not a valid key`,
    conflict: `A delivery with this ${idHeader} is still in progress`,
    'fingerprint-mismatch': `This ${idHeader} was already delivered with a different payload`,
    // One title for both causes of a 500, because it has to be honest whether the receiver runs no
    // verification at all or a working verifier merely failed. The detail member says which (ruling 13).
    'configuration-error': 'The webhook endpoint could not establish that this delivery is genuine',
    'signature-invalid': 'The webhook signature could not be verified',
    ...overrides,
  };
}

/** REQ-WH-1 and Q25: the id becomes the store key, so it is length and charset checked, never sf-string parsed. */
function resolveKey(
  req: Request,
  body: Uint8Array,
  idHeader: string,
  key?: (req: Request, body: Uint8Array) => string | undefined,
): KeyLookup {
  const raw = key !== undefined ? key(req, body) : (req.headers.get(idHeader) ?? undefined);
  if (raw === undefined || raw === '') return { kind: 'missing' };
  const parsed = parseKey(raw, 'lenient');
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  return { kind: 'ok', key: parsed.key };
}

/** D8 and Q24: `${routePattern}/${sourceId}`, or the route alone when no sender identity is available. */
function webhookScope(
  req: Request,
  body: Uint8Array,
  routePattern: string | ((req: Request) => string) | undefined,
  sourceId: ((req: Request, body: Uint8Array) => string | undefined) | undefined,
): string {
  const route =
    routePattern === undefined
      ? new URL(req.url).pathname
      : typeof routePattern === 'string'
        ? routePattern
        : routePattern(req);
  const source = sourceId?.(req, body);
  return source === undefined || source === '' ? route : `${route}/${source}`;
}

export function webhookReceiver(options: WebhookReceiverOptions) {
  const idHeader = options.idHeader ?? DEFAULT_ID_HEADER;
  const titles = webhookTitles(idHeader, options.problemTitles);
  const log = options.logger ?? ((message: string): void => console.error(message));
  const base: HttpIdempotencyOptions = {
    ...options,
    headerName: idHeader,
    required: options.required ?? true,
    methods: options.methods ?? ['POST'],
    // D9: the webhook fingerprint is the body bytes alone, so the same delivery on two paths still matches.
    fingerprint: options.fingerprint ?? ((_req, body) => sha256Hex(body)),
    problemTitles: titles,
  };
  const resolved: ResolvedHttpOptions = resolveHttpOptions(base);
  const verifiedMarker = options.verifiedMarker;
  // Ruling 12: one latch per cause, never a shared one, so neither cause can swallow the other's line.
  let loggedUnconfigured = false;
  let loggedVerifierFailed = false;

  return <Rest extends unknown[]>(handler: FetchLikeHandler<Rest>) => {
    return async (req: Request, ...rest: Rest): Promise<Response> => {
      const fail = async (code: ProblemCode, detail?: string): Promise<Response> => {
        const p = problem(code, resolved.problemBaseUri, detail, titles[code]);
        if (resolved.onError !== undefined) return resolved.onError(p, req);
        return problemResponse(p);
      };

      // D16: the configuration check is first, so a receiver that can never verify anything never runs a handler.
      if (options.verify === undefined && options.verifiedMarker === undefined) {
        if (!loggedUnconfigured) {
          loggedUnconfigured = true;
          log(CONFIGURATION_MESSAGE);
        }
        return fail('configuration-error', DETAIL_UNCONFIGURED);
      }
      if (!resolved.methods.has(req.method)) return handler(req, ...rest);

      const read = await readBody(req, resolved.maxRequestBytes);
      if (!read.ok) return fail('payload-too-large');

      // Carried finding 1: a verify callback that throws is a broken verifier, not a rejected delivery, so it
      // is 500 configuration-error (symmetric with the Go side's Options.Verify returning an error) and never
      // reaches runIdempotent. Ruling 12: it also must not be silent, so it gets its own one time line. The
      // thrown error itself is deliberately discarded rather than logged, since it can carry a key.
      let verified: boolean;
      try {
        verified =
          options.verify !== undefined
            ? (await options.verify(req, read.body)) === true
            : verifiedMarker !== undefined && isVerified(req, verifiedMarker);
      } catch {
        if (!loggedVerifierFailed) {
          loggedVerifierFailed = true;
          log(VERIFIER_FAILED_MESSAGE);
        }
        return fail('configuration-error', DETAIL_VERIFIER_FAILED);
      }
      if (!verified) return fail('signature-invalid');

      const keyLookup = resolveKey(req, read.body, idHeader, options.key);
      const routeScope = webhookScope(req, read.body, options.routePattern, options.sourceId);

      // REQ-WH-5: onSuspicious wants the request, and the engine's onMismatch only carries the operation, so
      // the policy is rebuilt per request with the request closed over. Rebuilding costs three allocations
      // per delivery, so it only happens when there is an onSuspicious hook to wire; otherwise resolved is
      // used unchanged. The two calls each get their own try/catch, so a throwing user onMismatch can never
      // suppress the security relevant onSuspicious call, or the reverse.
      const runOptions: ResolvedHttpOptions =
        options.onSuspicious === undefined
          ? resolved
          : {
              ...resolved,
              policy: {
                ...resolved.policy,
                hooks: {
                  ...resolved.policy.hooks,
                  onMismatch(op, record) {
                    try {
                      options.onSuspicious?.(req, record);
                    } catch {
                      // onSuspicious never throws into the receiver; the engine's own safely() would catch
                      // this too, but a dedicated catch here keeps it from suppressing the call below.
                    }
                    try {
                      resolved.policy.hooks?.onMismatch?.(op, record);
                    } catch {
                      // Same rule for a user supplied onMismatch: it never suppresses onSuspicious above.
                    }
                  },
                },
              },
            };

      return runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), runOptions, {
        routeScope,
        keyLookup,
        body: read.body,
      });
    };
  };
}
