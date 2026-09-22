import type { Store } from '@anyonce/core';
import { type HttpIdempotencyOptions, type IdempotencyEnv, idempotency } from '@anyonce/hono';
import { DurableObjectsStore, IdempotencyObject } from '@anyonce/stores/durable-objects';
import { Hono } from 'hono';

// The Durable Object class must be exported from the Worker entry so the binding in wrangler.jsonc resolves.
export { IdempotencyObject };

export interface Env {
  IDEMPOTENCY: DurableObjectNamespace<IdempotencyObject>;
}

export interface AppDeps {
  store: Store;
  /** How long a completed result replays. Default 24 hours (the anyonce default). */
  ttlMs?: number;
}

/** The middleware configuration, shared by the app below and by the conformance run in the smoke test. */
export function idempotencyOptions(deps: AppDeps): HttpIdempotencyOptions {
  // required: a POST without Idempotency-Key is a 400 missing-key rather than an unprotected write.
  const options: HttpIdempotencyOptions = { store: deps.store, required: true };
  if (deps.ttlMs !== undefined) options.ttlMs = deps.ttlMs;
  return options;
}

/** Builds the Hono app and returns its fetch handler. */
export function createApp(deps: AppDeps): (req: Request) => Response | Promise<Response> {
  const app = new Hono<IdempotencyEnv>();
  app.use(idempotency(idempotencyOptions(deps)));

  app.post('/orders', async (c) => {
    const { item } = await c.req.json<{ item: string }>();
    // Runs once per key: a retry with the same key and body gets this exact response back, id included.
    return c.json({ id: crypto.randomUUID(), item, createdAt: new Date().toISOString() }, 201);
  });

  app.get('/health', (c) => c.text('ok'));

  return app.fetch;
}

let app: ((req: Request) => Response | Promise<Response>) | undefined;

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    // env is fixed for the life of the isolate, so the app and its store are built once.
    app ??= createApp({ store: new DurableObjectsStore({ namespace: env.IDEMPOTENCY }) });
    return app(req);
  },
} satisfies ExportedHandler<Env>;
