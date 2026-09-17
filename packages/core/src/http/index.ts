import { type HttpIdempotencyOptions, resolveHttpOptions } from './options';
import { runIdempotent } from './run';

export type { Capture } from './capture';
export { captureResponse, replayResponse, storedHeaders } from './capture';
export type {
  FingerprintFn,
  FingerprintMode,
  HttpIdempotencyOptions,
  ResolvedHttpOptions,
} from './options';
export {
  DEFAULT_HEADER_NAME,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_METHODS,
  DEFAULT_STORED_HEADERS,
  resolveHttpOptions,
} from './options';
export type { Problem, ProblemCode } from './problems';
export {
  DEFAULT_PROBLEM_BASE_URI,
  PROBLEM_STATUS,
  PROBLEM_TITLE,
  problem,
  problemResponse,
} from './problems';
export type { BodyRead, KeyLookup, ScopeResult } from './request';
export {
  defaultScope,
  lookupKey,
  readBody,
  requestFingerprint,
  requestPath,
  resolveScope,
} from './request';
export type { IdempotencyInfo, IdempotentRun, RunContext } from './run';
export { idempotencyOf, runIdempotent } from './run';

export type FetchLikeHandler<Rest extends unknown[]> = (
  req: Request,
  ...rest: Rest
) => Response | Promise<Response>;

/**
 * REQ-HTTP-17: wraps any fetch-shaped handler (Workers, Bun.serve, Deno.serve, Lambda fetch shims). Extra
 * arguments such as env and ctx pass through untouched. The handler reads idempotencyOf(req) for REQ-HTTP-14.
 */
export function withIdempotency<Rest extends unknown[]>(
  handler: FetchLikeHandler<Rest>,
  options: HttpIdempotencyOptions,
): (req: Request, ...rest: Rest) => Promise<Response> {
  const resolved = resolveHttpOptions(options);
  return (req, ...rest) =>
    runIdempotent(req, (r) => Promise.resolve(handler(r, ...rest)), resolved);
}
