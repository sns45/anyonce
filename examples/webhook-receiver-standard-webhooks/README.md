# webhook-receiver-standard-webhooks

A webhook endpoint that follows [Standard Webhooks](https://www.standardwebhooks.com/). Senders retry
deliveries, so the same event often arrives more than once; `webhookReceiver` from `@anyonce/webhooks`
verifies each delivery's signature first and then runs the handler at most once per `webhook-id`. A
redelivery gets the first answer back.

## What it shows

- `webhookReceiver({ store, verify: standardWebhooksVerify(secret) })` wrapped around a plain fetch
  handler, in [`src/index.ts`](./src/index.ts).
- Verification runs before the store: an unsigned or forged delivery is `401` with
  `WWW-Authenticate: Signature` and never creates a record, so nobody can burn a delivery id they did not
  sign.
- The path is checked before the receiver, so a delivery to a path the service does not serve is `404`
  and claims no record.
- The memory store (`MemoryStore` from `@anyonce/core`) keeps the example self contained. A receiver with
  more than one instance needs a shared store; see [docs/stores.md](../../docs/stores.md).

```ts
import { MemoryStore } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '@anyonce/webhooks';

const receive = webhookReceiver({
  store: new MemoryStore(),
  verify: standardWebhooksVerify(process.env.WEBHOOK_SECRET ?? ''),
});

export const fetch = receive(async (req) => {
  const event = (await req.json()) as { type: string };
  // Runs once per webhook-id, after the signature checked out.
  return Response.json({ received: true });
});
```

A Standard Webhooks delivery carries three headers. The receiver keys on `webhook-id`; the signature covers
the id, the timestamp and the body:

```http
POST /webhooks HTTP/1.1
Content-Type: application/json
webhook-id: msg_2KWPBgLlAfxdpx2AI54pPJ85f4W
webhook-timestamp: 1790108049
webhook-signature: v1,uxh+FW34Bzfb3Mv2k0TSe+HJVzJDE1An047de6prb4M=

{"type":"invoice.paid"}
```

`webhook-signature` is `v1,` followed by the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`,
keyed with the secret (`whsec_` plus base64). Timestamps more than five minutes from now are rejected.

## Run it locally

No compose service is needed. From the repository root:

```sh
bun install
bun run build
cd examples/webhook-receiver-standard-webhooks
export WEBHOOK_SECRET="whsec_$(openssl rand -base64 24)"
bun run start
```

It listens on `http://127.0.0.1:3000/webhooks` (or `PORT`).

## Try it

In a second shell with the same `WEBHOOK_SECRET`, sign a delivery with the example's signer
([`src/sign.ts`](./src/sign.ts)), then send it twice, the way a sender retries:

```sh
BODY='{"type":"invoice.paid"}'
bun run --silent sign msg_1 "$BODY" > headers.txt
curl -i http://127.0.0.1:3000/webhooks -H @headers.txt -H 'Content-Type: application/json' -d "$BODY"
curl -i http://127.0.0.1:3000/webhooks -H @headers.txt -H 'Content-Type: application/json' -d "$BODY"
```

The first response is `200 {"received":true}` and the server logs the event once. The second is the same
`200` with `Idempotency-Replayed: true`, and nothing new is logged. Send the body without the headers file
and the answer is `401` with `WWW-Authenticate: Signature`. Sign a different body under `msg_1` and the
answer is `422` with the `fingerprint-mismatch` problem.

## Smoke test

[`test/smoke.test.ts`](./test/smoke.test.ts) signs deliveries with
[`@anyhook/signing`](https://www.npmjs.com/package/@anyhook/signing), an independent Standard Webhooks
sender, and checks both halves: a signed delivery runs once and its redelivery replays, and an unsigned or
wrongly signed delivery is `401` before the store is touched. From the repository root:

```sh
bun run test:examples
```
