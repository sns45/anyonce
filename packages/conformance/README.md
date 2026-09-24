# @anyonce/conformance

The conformance runner, CLI (`anyonce-conformance`) and vectors for
`draft-ietf-httpapi-idempotency-key-header`, split into a `core` tier (what the draft requires) and a
`profile` tier (anyonce's own choices). The runner only speaks HTTP, so it grades any implementation in
any language.

## Install

```sh
bun add -d @anyonce/conformance
npm i -D @anyonce/conformance
```

No peer dependencies.

## Usage

```sh
bunx @anyonce/conformance --url http://localhost:3000 --tier core
```

Or run it from code:

```ts
import { runConformance } from '@anyonce/conformance';

const { summary, report } = await runConformance({
  target: { baseUrl: 'http://localhost:3000' },
  report: 'markdown',
});
console.log(report);
if (summary.failed > 0 || summary.errored > 0) process.exitCode = 1;
```

`@anyonce/conformance/runtime` is the same runner without the vector loader and the CLI, for runtimes
without `node:fs` such as workerd; pass the vectors in directly.

## Links

- [Repository](https://github.com/sns45/anyonce)
- [docs/conformance.md](https://github.com/sns45/anyonce/blob/main/docs/conformance.md): running the suite against anything, reading the report, adding a vector.
- [conformance/REPORT.md](https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md): the cross-implementation report.

## Licence

Apache-2.0
