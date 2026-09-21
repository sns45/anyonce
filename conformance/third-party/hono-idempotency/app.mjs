// The anyonce conformance fixture contract (conformance/README.md) mounted
// behind hono-idempotency 0.9.1. Used only by conformance/third-party/compose.yml;
// this is not a workspace package.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { idempotency } from 'hono-idempotency';
import { memoryStore } from 'hono-idempotency/stores/memory';

const state = { count: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const app = new Hono();

// Control endpoint: mounted OUTSIDE the idempotency layer.
app.post('/reset', (c) => {
  state.count = 0;
  return c.body(null, 204);
});

app.use(
  '*',
  idempotency({
    store: memoryStore({ ttl: 2000, sweepInterval: 500 }),
    headerName: 'Idempotency-Key',
    required: true,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    dangerouslyAllowGlobalKeys: true,
  }),
);

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
  return c.text(`status:${code}`, code);
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

serve({ fetch: app.fetch, port: 3000, hostname: '0.0.0.0' });
