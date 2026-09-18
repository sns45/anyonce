---
'@anyonce/core': minor
'@anyonce/webhooks': minor
---

Add the webhook door. `@anyonce/webhooks` ships `webhookReceiver`, which runs strictly after signature
verification, keys on the Standard Webhooks `webhook-id` header or a body derived id, replays a stored response
with `Idempotency-Replayed: true`, answers 409 with `Retry-After` while a delivery is in flight and 422 with an
`onSuspicious` hook when the same id arrives with a different body, plus `standardWebhooksVerify(secret)`.
`@anyonce/core/http` gains two problem codes, `configuration-error` and `signature-invalid`, per code title
overrides, and two optional `RunContext` fields so a door can supply the key and the body it already read.
