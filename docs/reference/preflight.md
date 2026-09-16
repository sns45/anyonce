# Preflight evidence (Step 0)

Run on 2026-09-16 from an empty `/Users/shantanu/dev/anyonce` directory, before any scaffolding.

## Name availability (D1)

All three checks returned not-found, so the `anyonce` name, the `@anyonce` npm scope, and the `sns45/anyonce` GitHub repo are free. No fallback to `anyonce-dev` is needed.

```
$ npm view anyonce
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/anyonce - Not found
npm error 404  'anyonce@*' is not in this registry.

$ npm view @anyonce/core
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@anyonce%2fcore - Not found
npm error 404  '@anyonce/core@*' is not in this registry.

$ gh repo view sns45/anyonce
GraphQL: Could not resolve to a Repository with the name 'sns45/anyonce'. (repository)
```

`gh auth status` confirmed the active account is `sns45`, so the repo check ran with the right identity.

## Normative reference

`docs/reference/draft-07.txt` was fetched from `https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.txt`.

| Property | Value |
|---|---|
| Lines | 728 |
| SHA-256 | `956a446923d6b6cd0ab72b0dbc552937c5b0fcf443da6b47c055d17dcdfa542f` |
| Draft date | 15 October 2025 |
| Expires | 18 April 2026 |
| Em or en dashes in file | 0 |

The editor's copy at `github.com/ietf-wg-httpapi/idempotency` was cloned read-only to `/tmp/ietf-idempotency` and compared section by section. The delta is recorded in `conformance/DRAFT-GAPS.md` under "Editor's copy delta".

## Sibling projects

| Repo | Clone path | HEAD | Latest tags | Published |
|---|---|---|---|---|
| `sns45/anyq` | `/tmp/anyq` | `b49d41f` 2026-09-07 "Release 0.5.0: pgmq (Postgres) adapter" | `v0.5.0`, `go/v0.5.0` | `@anyq/core` 0.5.0, `@anyq/memory` 0.5.0, `@anyq/sqs` 0.5.0, `@anyq/kafka` 0.5.0, `@anyq/redis-streams` 0.5.0 |
| `sns45/anyhook` | `/tmp/anyhook` | `dfd5022` 2026-09-04 "bump @anyhook/* to 0.2.2" | `v0.2.2`, `go/v0.2.1` | `@anyhook/core` 0.2.2, `@anyhook/signing` 0.2.2 |

Interfaces recorded in `docs/reference/anyq-interfaces.md` and `docs/reference/anyhook-signing.md`.

## Local toolchain

| Tool | Version | Note |
|---|---|---|
| bun | 1.2.21 | |
| go | 1.25.3 darwin/arm64 | anyq pins `go 1.25.3`, anyhook pins `go 1.24` |
| node | 22.17.0 | for the Node compat matrix (REQ-REL-4) |
| docker | 28.3.2 | |
| gh | present, authenticated as `sns45` | |
| rg | present | |
| golangci-lint | not installed | must be installed before the first Go gate (`brew install golangci-lint`), noted in `docs/superpowers/questions.md` |
