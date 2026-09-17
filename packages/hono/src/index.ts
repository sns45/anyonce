import { type HttpIdempotencyOptions, resolveHttpOptions, runIdempotent } from '@anyonce/core/http';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

export type {
  FingerprintFn,
  FingerprintMode,
  HttpIdempotencyOptions,
  IdempotencyInfo,
  Problem,
  ProblemCode,
} from '@anyonce/core/http';
export { idempotencyOf, withIdempotency } from '@anyonce/core/http';

/** REQ-HTTP-14: variables the middleware sets for handlers. */
export interface IdempotencyVariables {
  idempotencyKey?: string;
  idempotencyFence?: number;
}

/** REQ-HTTP-16: use `new Hono<IdempotencyEnv>()` so `c.get` and `hc<AppType>` know the variables. */
export type IdempotencyEnv = { Variables: IdempotencyVariables };

/**
 * REQ-HTTP-16: Hono middleware over runIdempotent. The default scope is METHOD plus the matched route pattern
 * (D8), read from the last matched route so it names the endpoint rather than this middleware.
 * REQ-HTTP-5: when no route after this middleware matched (a 404), the pattern falls back to this middleware's
 * own registration and every unmatched path would share a scope; use the request path instead in that case.
 */
export function idempotency(options: HttpIdempotencyOptions): MiddlewareHandler<IdempotencyEnv> {
  const resolved = resolveHttpOptions(options);
  return async (c, next) => {
    const routeMatched = c.req.matchedRoutes.length - 1 > c.req.routeIndex;
    const pattern = routeMatched ? routePath(c, -1) : '';
    const routeScope = `${c.req.method} ${pattern || c.req.path}`;
    const response = await runIdempotent(
      c.req.raw,
      async (_req, info) => {
        if (info !== undefined) {
          c.set('idempotencyKey', info.key);
          c.set('idempotencyFence', info.fence);
        }
        await next();
        return c.res;
      },
      resolved,
      { routeScope },
    );
    c.res = undefined;
    c.res = response;
  };
}
