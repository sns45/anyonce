# Draft gaps

This file records every place where `conformance/vectors/` had to choose a behavior that `draft-ietf-httpapi-idempotency-key-header-07` leaves open, the anyonce choice, and proposed draft text. It is the input for the S3 issues (requirements 0.4). The gap list itself is filled in during P0 (vectors) and P5 (third-party runs).

## Editor's copy delta

Compared on 2026-09-16: the published `-07` text (`docs/reference/draft-07.txt`, dated 15 October 2025) against the editor's copy `draft-ietf-httpapi-idempotency-key-header.md` on `main` of `github.com/ietf-wg-httpapi/idempotency` (commit `dab060c`, 26 February 2025, message "draft 06").

Result: the normative text is identical. Sections 1 through 6 (Introduction, header field, Syntax, Uniqueness, Validity and Expiry, Fingerprint, Responsibilities, Enforcement, Error Handling, IANA, Implementation Status, Security Considerations, Examples) match sentence for sentence, including the RFC 7807 problem examples and the same implementer list.

Non-normative differences:

| Item | Editor's copy (`main`) | Published `-07` |
|---|---|---|
| Change log heading | "Changes from Draft-05" with three bullets | "Appendix A. Changes from Draft-06" with an empty body |
| Date and expiry | none (kramdown source) | 15 October 2025, expires 18 April 2026 |
| Source commit for -07 | none; no commit on any branch is later than February 2025 | published from outside the repo |

Other branches (`david-benjamin-proposal` 2023, `jayadeba-patch-1` 2022, `mnot-patch-1` 2024) predate `-06` and contain no text that reached `-07`.

Observations that feed S3:

- Both texts cite RFC 8941 for Structured Fields. RFC 9651 obsoleted RFC 8941 in September 2024. anyonce implements sf-string per RFC 9651, which is identical for the String type. Proposed draft text: update the reference to RFC 9651.
- Neither text names a replay indication header, a `Retry-After` on 409, or what to do with a 5xx original. These become gap entries once the vectors exist.
- requirements.md section 0.2 says the editor's copy was "last touched November 2025". The repository shows February 2025. Filed as Q1 in `docs/superpowers/questions.md` so the case study cites the right date.

## Gap entries

Format for each entry:

```
### G<n>: <title>
Draft section: <ref>
What the draft says: <quote or "silent">
anyonce choice: <behavior>, vector(s): <ids>
Proposed draft text: <text>
Status: open | issue filed <url>
```

### G1: error response media type
Draft section: section-2.7
What the draft says: "SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation"; RFC 7807 shown as an example, a Link header shown as an alternative. No media type is required.
anyonce choice: all errors are RFC 9457 problem details with application/problem+json and a stable code member (D10, D11); vectors core/key-missing-required, core/mismatch-422, core/concurrent-409, profile/problem-code-member. See Q14 on whether the core tier should assert it.
Proposed draft text: "Error responses for the 400, 409 and 422 cases SHOULD use the application/problem+json media type [RFC9457]. A Link header with rel="describedby" MAY be sent in addition."
Status: open

### G2: keys on safe methods
Draft section: section-1
What the draft says: the header makes non-idempotent methods such as POST or PATCH fault-tolerant; silent on a key sent with GET.
anyonce choice: a key on GET is ignored, the request executes and is never stored or replayed (REQ-HTTP-1); vector core/get-ignored.
Proposed draft text: "A resource SHOULD ignore the Idempotency-Key header on requests whose method is idempotent by definition (Section 9.2.2 of [RFC9110])."
Status: open
