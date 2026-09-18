import type { IdempotencyRecord } from '@anyonce/core';
import {
  type FetchLikeHandler,
  type HttpIdempotencyOptions,
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
  extends Omit<HttpIdempotencyOptions, 'headerName' | 'problemTitles'> {
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

const CONFIGURATION_MESSAGE =
  'anyonce: webhookReceiver was built with neither verify nor verifiedMarker, so no delivery can be accepted (REQ-WH-2)';

function webhookTitles(idHeader: string, overrides?: ProblemTitles): ProblemTitles {
  return {
    'missing-key': `The ${idHeader} header is required for this request`,
    'invalid-key': `The ${idHeader} header value is not a valid key`,
    conflict: `A delivery with this ${idHeader} is still in progress`,
    'fingerprint-mismatch': `This ${idHeader} was already delivered with a different payload`,
    'configuration-error':
      'This webhook endpoint runs no signature verification and cannot accept a delivery',
    'signature-invalid': 'The webhook signature could not be verified',
    ...overrides,
  };
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
    problemTitles: titles,
  };
  const resolved: ResolvedHttpOptions = resolveHttpOptions(base);
  let logged = false;

  return <Rest extends unknown[]>(handler: FetchLikeHandler<Rest>) => {
    return async (req: Request, ...rest: Rest): Promise<Response> => {
      const fail = async (code: ProblemCode): Promise<Response> => {
        const p = problem(code, resolved.problemBaseUri, undefined, titles[code]);
        if (resolved.onError !== undefined) return resolved.onError(p, req);
        return problemResponse(p);
      };

      // D16: the configuration check is first, so a receiver that can never verify anything never runs a handler.
      if (options.verify === undefined && options.verifiedMarker === undefined) {
        if (!logged) {
          logged = true;
          log(CONFIGURATION_MESSAGE);
        }
        return fail('configuration-error');
      }
      if (!resolved.methods.has(req.method)) return handler(req, ...rest);

      const read = await readBody(req, resolved.maxRequestBytes);
      if (!read.ok) return fail('payload-too-large');

      const verified =
        options.verify !== undefined
          ? (await options.verify(req, read.body)) === true
          : isVerified(req, options.verifiedMarker as string);
      if (!verified) return fail('signature-invalid');

      return runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), resolved, {
        body: read.body,
      });
    };
  };
}
