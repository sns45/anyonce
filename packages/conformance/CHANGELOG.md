# @anyonce/conformance

## 0.1.0

### Minor Changes

- 1a2eb6c: Initial conformance runner: vector schema, 11 core and 7 profile vectors, in-process and URL targets, reference fixtures.
- 0c3fa90: HTTP door: the @anyonce/core/http subpath with withIdempotency, problem details, streaming capture and replay; the @anyonce/hono middleware; conformance report formats, runConformance and the anyonce-conformance CLI.
- 4e45b23: D1 store for @anyonce/stores (`@anyonce/stores/d1`): `D1Store`, `D1StoreOptions`, `ensureSchema` and `MIGRATION_SQL`, sharing the SQLite dialect begin statement with the Durable Objects store. The runtime entry of `@anyonce/conformance` gains `runConformance` for callers, such as workerd tests, that supply `vectors` explicitly instead of loading them from disk.

### Patch Changes

- bc7f476: The package now ships the conformance vectors: the build copies `conformance/vectors` into the package and the tarball includes it, so `loadVectors()` and the `anyonce-conformance` CLI work from an installed package instead of failing with ENOENT on `conformance/vectors/core`. Inside the repository the loader falls back to `conformance/vectors` when the package has not been built.
- bc7f476: Peers on `@anyonce/core` use a caret range. Every package declares its `repository` (this repository and its own directory) and ships the Apache-2.0 LICENSE in its tarball.
- 4ca1f2b: Each package ships a README.
