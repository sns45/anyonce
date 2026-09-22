---
"@anyonce/conformance": patch
---

The package now ships the conformance vectors: the build copies `conformance/vectors` into the package and the tarball includes it, so `loadVectors()` and the `anyonce-conformance` CLI work from an installed package instead of failing with ENOENT on `conformance/vectors/core`. Inside the repository the loader falls back to `conformance/vectors` when the package has not been built.
