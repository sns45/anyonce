# @anyonce/webhooks

Standard Webhooks receiver for anyonce: `webhookReceiver` verifies the
[Standard Webhooks](https://www.standardwebhooks.com/) signature first and only then claims the
`webhook-id`, so an unsigned or forged delivery never touches the store, and a sender's retry gets the
first answer back.

## Install

```sh
bun add @anyonce/webhooks @anyonce/core
npm i @anyonce/webhooks @anyonce/core
```

Peer dependency: `@anyonce/core`.

## Usage

```ts
import { MemoryStore } from '@anyonce/core';
import { standardWebhooksVerify, webhookReceiver } from '@anyonce/webhooks';

const receive = webhookReceiver({
  store: new MemoryStore(),
  verify: standardWebhooksVerify(process.env.WEBHOOK_SECRET ?? ''),
});

export const fetch = receive(async (req) => {
  const event = (await req.json()) as { type: string };
  console.log('handled', event.type); // runs once per webhook-id
  return Response.json({ received: true });
});
```

A redelivery of the same event gets the same response back, with `Idempotency-Replayed: true`, and the
handler does not run again. An unsigned or wrongly signed delivery is `401` with `WWW-Authenticate:
Signature` before any record is created. `MemoryStore` is for one process; swap in a shared store from
`@anyonce/stores` for anything else.

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/security.md](https://github.com/sns45/anyonce/blob/main/docs/security.md): key entropy, scope and principal, log redaction.
- [docs/stores.md](https://github.com/sns45/anyonce/blob/main/docs/stores.md): the store guarantees matrix.

## Licence

Apache-2.0
