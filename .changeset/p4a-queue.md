---
'@anyonce/anyq': minor
---

Add the queue door: idempotent(handler, options) wraps an anyq consumer handler so it runs at most once per
message identity, and idempotencyStrategy(inner) translates the door's typed errors into anyq park and
dead-letter decisions. docs/queue-ids.md records message id stability per adapter.
