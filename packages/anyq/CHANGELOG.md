# @anyonce/anyq

## 0.1.0

### Minor Changes

- 13d911b: Add the queue door: idempotent(handler, options) wraps an anyq consumer handler so it runs at most once per
  message identity, and idempotencyStrategy(inner) translates the door's typed errors into anyq park and
  dead-letter decisions. docs/queue-ids.md records message id stability per adapter.

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
