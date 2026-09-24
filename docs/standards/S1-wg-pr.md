# S1: Implementation Status PR for draft-ietf-httpapi-idempotency-key-header

This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/ietf-wg-httpapi/idempotency` or on any other repository, and this text will only be sent if and when the anyonce author decides to send it.

It is the text for requirements 0.4 S1, shaped by Q84: one pull request that touches only the draft source and adds an anyonce entry to Section 4 (Implementation Status) in the shape RFC 7942 Section 2 asks for, with the conformance vectors offered as a follow-up rather than pushed into the WG repository. The alternative issue text, for the case where the editors would rather not take a PR against an expired draft, is at the end.

## Target

- Repository: `github.com/ietf-wg-httpapi/idempotency`
- File: `draft-ietf-httpapi-idempotency-key-header.md` (the kramdown editor's copy)
- Base: `main` at commit `dab060c` (26 February 2025, "draft 06"). `draft-ietf-httpapi-idempotency-key-header-07` (15 October 2025, expired 18 April 2026) was published without a matching commit in the repository; its normative text and its Section 4 implementer list are identical to `dab060c`, as recorded under "Editor's copy delta" in `conformance/DRAFT-GAPS.md`. The change below therefore applies cleanly to the editor's copy and describes the -07 text.
- Location: Section 4 (`# Implementation Status`), after the Datatrans entry and before `## Implementing the Concept`. anyonce implements the header field itself rather than a different mechanism, so it belongs in Section 4 proper and not in 4.1.
- Branch name suggestion: `implementation-status-anyonce`

## PR title

Add anyonce to Implementation Status (TypeScript and Go, with a conformance suite)

## PR body

Hello, and thank you for the draft.

This PR adds one entry to Section 4 (Implementation Status), in the shape RFC 7942 Section 2 suggests, for anyonce: two open source implementations of the Idempotency-Key header field, one in TypeScript and one in Go, sharing one state machine and one store contract.

The part that may be useful to the WG beyond the listing is the conformance suite that came out of the work. It is language agnostic (JSON vectors plus a runner that talks HTTP to any implementation), and it separates what the draft requires (11 core vectors) from choices the draft leaves open (9 profile vectors). We ran it against both anyonce implementations across every supported store, and against three independent implementations. Third parties are graded on the core tier only:

- anyonce, TypeScript and Go, 11 runs across 7 stores: core 11/11, profile 9/9 on every run
- hono-idempotency 0.9.1 (TypeScript): core 11/11
- idempo v1.0.0 (Go): core 9/11
- fiber v3.5.0 (Go, `middleware/idempotency`): core 7/11

- Suite: https://github.com/sns45/anyonce/tree/main/conformance
- Cross-implementation report: https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md
- Places where the vectors had to pick a behavior the draft leaves open, with proposed text for each: https://github.com/sns45/anyonce/blob/main/conformance/DRAFT-GAPS.md

On the vectors themselves: they are Apache-2.0 and could live next to the draft if the chairs and editors would find that useful. We have not put them in this PR, because a directory of test material in the WG repository is a bigger question than an Implementation Status entry and would be an IETF contribution under the Note Well. If you would like them here, say so and a follow-up PR will add them under `conformance/` with a short README.

The entry says pre-release honestly: the 0.1.0 packages have not been published yet. The source, the suite and the report are public now. Happy to adjust the wording or the level of detail to match the other entries; the existing entries are much shorter, and a trimmed version (Organization, Description, Reference) is fine too.

## Text to add

```markdown
Organization: anyonce

- Implementation: anyonce, https://github.com/sns45/anyonce
- Description: One idempotency core applied to HTTP handlers, queue consumers and webhook receivers, in TypeScript (`@anyonce/core`, `@anyonce/hono`) and Go (`github.com/sns45/anyonce/go`), with the claim step a single atomic write on every supported store (memory, Cloudflare Durable Objects, Cloudflare D1, DynamoDB, Redis, Postgres, SQLite). Implements the `Idempotency-Key` request header field as an Item Structured Header String, the 400, 409 and 422 error cases as RFC 9457 problem details, and fingerprinting over method, target and content.
- Level of maturity: pre-release. Source available and tested in CI; the 0.1.0 packages are not yet published. The implementation ships a language agnostic conformance suite for this draft (11 core and 9 profile vectors) that has been used to grade three independent implementations.
- Coverage: every normative requirement of Section 2 that the suite grades, in both languages and on every store. Where the draft leaves a behavior open (replay indication, Retry-After on 409, 5xx results, key length, result size, error codes), the choices are documented and graded separately as a profile.
- Licensing: Apache-2.0.
- Implementation experience: seventeen points where the draft is silent or open to more than one reading are recorded with proposed text at https://github.com/sns45/anyonce/blob/main/conformance/DRAFT-GAPS.md. Results of the suite against anyonce and three other implementations: https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md
- Contact: Shantanu Sharma, https://github.com/sns45
- Information accurate as of: 24 September 2026
- Reference: https://github.com/sns45/anyonce/tree/main/conformance
```

## If the editors prefer an issue

Title: Implementation Status: anyonce (TypeScript and Go) and a conformance suite for the draft

Body:

Hello. anyonce is an open source implementation of this draft in TypeScript and Go, and while building it we wrote a language agnostic conformance suite for the draft: 11 core vectors for what the draft requires and 9 profile vectors for choices it leaves open. We ran it against both anyonce implementations and against three independent ones; third parties are graded on core only, and the results are hono-idempotency 0.9.1 core 11/11, idempo v1.0.0 core 9/11 and fiber v3.5.0 core 7/11, with anyonce core 11/11 and profile 9/9 on every store in both languages.

- Suite: https://github.com/sns45/anyonce/tree/main/conformance
- Report: https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md
- Gaps found while writing the vectors, each with proposed text: https://github.com/sns45/anyonce/blob/main/conformance/DRAFT-GAPS.md

If it is useful, we would be glad to see anyonce listed in Section 4 under RFC 7942; the entry we would suggest is below, and a PR is ready if you would rather take one. The vectors are Apache-2.0 and are offered to the WG as a shared asset, either linked from the draft or contributed to this repository, whichever the chairs prefer.

(The body then carries the same "Text to add" block as the PR.)
