# @anyonce/webhooks

## 0.1.0

### Minor Changes

- a504191: Add the webhook door. `@anyonce/webhooks` ships `webhookReceiver`, which runs strictly after signature
  verification, keys on the Standard Webhooks `webhook-id` header or a body derived id, replays a stored response
  with `Idempotency-Replayed: true`, answers 409 with `Retry-After` while a delivery is in flight and 422 with an
  `onSuspicious` hook when the same id arrives with a different body, plus `standardWebhooksVerify(secret)`.
  `@anyonce/core/http` gains two problem codes, `configuration-error` and `signature-invalid`, per code title
  overrides, and two optional `RunContext` fields so a door can supply the key and the body it already read.
  `webhookReceiver` takes `scope?: (req, body) => string`, which replaces the computed scope entirely; supplying
  it together with `sourceId` is a construction-time `TypeError`, as an empty `verifiedMarker` is. A 401
  `signature-invalid` response carries `WWW-Authenticate: Signature` (RFC 9110 section 15.5.2). `@anyonce/core/http`
  also exports `withProtocolHeaders`, the merge that keeps a door's protocol headers on a custom `onError`
  response.

### Patch Changes

- bc7f476: Peers on `@anyonce/core` use a caret range. Every package declares its `repository` (this repository and its own directory) and ships the Apache-2.0 LICENSE in its tarball.
- 4ca1f2b: Each package ships a README.
- Updated dependencies [696d9d1]
- Updated dependencies [0c3fa90]
- Updated dependencies [4e45b23]
- Updated dependencies [4e45b23]
- Updated dependencies [4e45b23]
- Updated dependencies [a504191]
- Updated dependencies [bc7f476]
- Updated dependencies [4ca1f2b]
  - @anyonce/core@0.1.0
