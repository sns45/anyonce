/**
 * REQ-CONF-8: the workerd target behind the anyonce-ts-durable-objects and anyonce-ts-d1 rows.
 *
 * Durable Objects and D1 exist only inside workerd, and the vitest workers pool that proves them in
 * packages/stores/workers/*.test.ts has no filesystem, so a run summary cannot be written out from inside it.
 * This worker serves the same wiring over HTTP instead, so scripts/report/collect.ts can drive it with the
 * ordinary URL runner from a Bun process. The store is picked by the ANYONCE_STORE variable, which the
 * collector sets per row, so one config serves both rows.
 */
import type { Store } from '@anyonce/core';
import { withIdempotency } from '@anyonce/core/http';
import { createFixtureApp } from '@anyonce/fixture-hono';
import { D1Store, ensureSchema } from '@anyonce/stores/d1';
import { DurableObjectsStore, type IdempotencyObject } from '@anyonce/stores/durable-objects';

export { IdempotencyObject } from '@anyonce/stores/durable-objects';

/**
 * N9: the same TTL scripts/report/rows.ts declares as CAPABILITY_TTL_MS, so the short-ttl capability the
 * runner grades is the one the target is actually configured with. Stated as a literal because wrangler
 * bundles this module for workerd and it must not reach into scripts/.
 */
const TTL_MS = 2000;

interface Env {
  /** "durable-objects" or "d1", set by the collector through wrangler's --var. */
  ANYONCE_STORE?: string;
  IDEMPOTENCY: DurableObjectNamespace<IdempotencyObject>;
  DB: D1Database;
}

function buildStore(env: Env): Store {
  const name = env.ANYONCE_STORE ?? 'durable-objects';
  switch (name) {
    case 'durable-objects':
      return new DurableObjectsStore({ namespace: env.IDEMPOTENCY });
    case 'd1':
      return new D1Store({ db: env.DB });
    default:
      throw new Error(`unknown ANYONCE_STORE "${name}", expected "durable-objects" or "d1"`);
  }
}

/** Built once per isolate rather than per request, so the store is not reconstructed on every call. */
let handler: ((req: Request) => Promise<Response>) | undefined;

/**
 * D1 needs no migration command here: the store applies its own schema on the first request and every later
 * request awaits the same memoized promise.
 */
let schemaReady: Promise<void> | undefined;

function ready(env: Env): Promise<void> {
  if (env.ANYONCE_STORE !== 'd1') return Promise.resolve();
  schemaReady ??= ensureSchema(env.DB);
  return schemaReady;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ready(env);
    handler ??= withIdempotency(createFixtureApp().fetch, {
      store: buildStore(env),
      required: true,
      ttlMs: TTL_MS,
      skip: (req) => new URL(req.url).pathname === '/reset',
    });
    return handler(request);
  },
};
