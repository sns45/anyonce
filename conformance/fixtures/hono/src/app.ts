import { Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export interface FixtureState {
  count: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reference fixture for the conformance suite (requirements REQ-CONF-2). With no layer it has no idempotency at all.
 * A layer is mounted after /reset (the control endpoint stays outside it) and before every fixture route.
 */
export function createFixtureApp(
  state: FixtureState = { count: 0 },
  layer?: MiddlewareHandler,
): Hono {
  const app = new Hono();

  app.post('/reset', (c) => {
    state.count = 0;
    return c.body(null, 204);
  });

  if (layer !== undefined) app.use(layer);

  app.get('/counter', (c) => c.json({ count: state.count }));

  app.post('/echo', async (c) => {
    state.count += 1;
    const body = await c.req.arrayBuffer();
    return c.body(body, 201, {
      'Content-Type': c.req.header('content-type') ?? 'application/octet-stream',
    });
  });

  app.post('/status/:code', (c) => {
    const code = Number(c.req.param('code'));
    if (!Number.isInteger(code) || code < 200 || code > 599) {
      return c.text('invalid status code', 400);
    }
    state.count += 1;
    return c.text(`status:${code}`, code as ContentfulStatusCode);
  });

  app.post('/slow', async (c) => {
    state.count += 1;
    const ms = Number(c.req.query('ms') ?? '0');
    await sleep(Number.isFinite(ms) && ms > 0 ? ms : 0);
    return c.text(`slept:${ms}`, 200);
  });

  app.post('/large', (c) => {
    state.count += 1;
    const bytes = Number(c.req.query('bytes') ?? '0');
    const size = Number.isInteger(bytes) && bytes >= 0 ? bytes : 0;
    return c.body(new Uint8Array(size).fill(0x78), 200, {
      'Content-Type': 'application/octet-stream',
    });
  });

  return app;
}
