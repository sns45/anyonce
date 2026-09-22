import { MemoryStore, type Store } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '@anyonce/webhooks';

export interface WebhookEvent {
  type: string;
  data?: unknown;
}

export interface AppDeps {
  store: Store;
  /** The Standard Webhooks signing secret the sender shares, whsec_ prefixed base64. */
  secret: string;
  /** Called once per delivery id with the verified event. Default: logs the event type. */
  onEvent?: (event: WebhookEvent) => void;
}

/**
 * The receiver's fetch handler. Every delivery is verified first; an unsigned or forged one is 401 and never
 * reaches the store. A verified delivery runs once per webhook-id, and a redelivery replays the first answer.
 */
export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const onEvent =
    deps.onEvent ?? ((event: WebhookEvent) => console.log(`handled event ${event.type}`));
  const receive = webhookReceiver({
    store: deps.store,
    verify: standardWebhooksVerify(deps.secret),
  });
  const handle = receive(async (req) => {
    const event = (await req.json()) as WebhookEvent;
    onEvent(event);
    return Response.json({ received: true });
  });
  // The path is checked before the receiver, so a delivery to an unknown path never claims a record.
  return async (req) =>
    new URL(req.url).pathname === '/webhooks'
      ? handle(req)
      : new Response('not found', { status: 404 });
}

if (import.meta.main) {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret === undefined || secret === '') {
    console.error('set WEBHOOK_SECRET to a whsec_ secret; see README.md');
    process.exit(1);
  }
  // The memory store keeps this example self contained; production uses a shared store (docs/stores.md).
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    fetch: createApp({ store: new MemoryStore(), secret }),
  });
  console.log(`webhook receiver on ${server.url}webhooks`);
}
