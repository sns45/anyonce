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
Third parties that diverge: <what the P5 run showed, naming the implementation and the vector, or "none">
Status: open | issue filed <url>
```

### G1: error response media type
Draft section: section-2.7
What the draft says: "SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation"; RFC 7807 shown as an example, a Link header shown as an alternative. No media type is required.
anyonce choice: all errors are RFC 9457 problem details with application/problem+json and a stable code member (D10, D11); vectors profile/problem-content-type, profile/problem-code-member. Q14 decided that the core vectors assert status only, so the media type is a profile expectation and no third party is graded on it.
Proposed draft text: "Error responses for the 400, 409 and 422 cases SHOULD use the application/problem+json media type [RFC9457]. A Link header with rel="describedby" MAY be sent in addition."
Third parties that diverge: hono-idempotency 0.9.1 sends application/problem+json for both the 400 and the 422 and passes profile/problem-content-type. idempo v1.0.0 sends it on the 422 but answers a missing key with a 201 and text/plain (`header Content-Type: expected /^application/problem\+json/, got "text/plain"`). fiber v3.5.0 sends text/plain and never reaches an error status at all. No third party is graded on this, per Q14.
Status: open

### G2: keys on safe methods
Draft section: section-1
What the draft says: the header makes non-idempotent methods such as POST or PATCH fault-tolerant; silent on a key sent with GET.
anyonce choice: a key on GET is ignored, the request executes and is never stored or replayed (REQ-HTTP-1); vector core/get-ignored.
Proposed draft text: "A resource SHOULD ignore the Idempotency-Key header on requests whose method is idempotent by definition (Section 9.2.2 of [RFC9110])."
Third parties that diverge: idempo v1.0.0 replays the earlier GET, so the second GET does not see the POST that ran between them (core/get-ignored fails with `get-after: body.count: expected 1, got 0`). hono-idempotency 0.9.1 and fiber v3.5.0 both ignore the key on GET and pass. `conformance/issues/idempo-get-ignored.md` concedes that section 1 is motivation rather than a rule and that the vector may be mis-tiered; this entry is the reason it is worth asking the WG rather than the implementer.
Status: open

### G3: empty key
Draft section: section-2.1
What the draft says: the value MUST be a String; an empty String is syntactically valid and nothing says whether it identifies a request.
anyonce choice: an empty quoted key is rejected with 400 invalid-key and the handler does not run (D7); vector profile/empty-key-rejected.
Proposed draft text: "An empty string MUST NOT be used as an idempotency key; a resource SHOULD reject it with 400."
Third parties that diverge: all three. hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0 each accept the empty quoted key and run the handler (profile/empty-key-rejected fails with `status: expected 400, got 201` against every one of them). An empty key is a key everywhere except in anyonce.
Status: open

### G4: no indication that a response is a replay
Draft section: section-2.6
What the draft says: "The request was retried after the original request completed. The resource SHOULD respond with the result of the previously completed operation, success or an error." The draft names no way for a client to tell that response apart from a fresh execution, so a client cannot log, meter or alarm on its own retries. A true silence, not a reading of anything the draft says.
anyonce choice: a replayed response carries `Idempotency-Replayed: true` and a first execution never carries the field (D10); vectors profile/replayed-header, profile/4xx-replayed, profile/omitted-body-replay.
Proposed draft text: "A resource that responds with the result of a previously completed operation SHOULD indicate that it has done so by including the Idempotency-Replayed HTTP response header field. Idempotency-Replayed is an Item Structured Header [RFC9651] whose value MUST be the Token "true". A resource MUST NOT include this field in a response to a first time request. The Idempotency-Replayed field name should be added to the "Hypertext Transfer Protocol (HTTP) Field Name Registry"."
Third parties that diverge: fiber v3.5.0 sends no such field, so profile/replayed-header, profile/4xx-replayed and profile/omitted-body-replay each fail against it with `header Idempotency-Replayed: expected "true", got absent`. hono-idempotency 0.9.1 and idempo v1.0.0 both already send `Idempotency-Replayed: true` and pass profile/replayed-header. Two of the three implementations in the run invented the same unspecified field name, which is the argument for registering it.
Status: open

### G5: a 409 says nothing about when to come back
Draft section: section-2.7, section-2.6
What the draft says: "If the request is retried, while the original request is still being processed, the resource SHOULD reply with an HTTP 409 status code with body containing problem description." and "Clients MUST correct the requests (with the exception of 409 where no correction is required) before performing a retry operation, or the resource MUST fail the request and return one of the above errors." So the client is told to retry the same request and is given nothing to time that retry with. A true silence: the 409 rule exists, the timing hint is absent.
anyonce choice: the 409 carries `Retry-After` in whole seconds, derived from the remaining lease, minimum 1 (D10); vectors core/concurrent-409, profile/retry-after-on-409.
Proposed draft text: "A resource that replies with an HTTP 409 status code under this section SHOULD include a Retry-After header field (Section 10.2.3 of [RFC9110]) indicating the time after which the original request is expected to have completed. A client that receives such a field SHOULD NOT retry the request before that time. The request is retried unchanged, since no correction is required for this case."
Third parties that diverge: idempo v1.0.0 replies 409 but sends no such field (profile/retry-after-on-409 fails with `header Retry-After: expected /^[1-9][0-9]*$/, got absent`). fiber v3.5.0 never replies 409 at all: the duplicate blocks until the original finishes and is then answered 200 (core/concurrent-409 fails with `duplicate: status: expected 409, got 200`), see `conformance/issues/fiber-concurrent-409.md`, which points at this entry for the Retry-After point. hono-idempotency 0.9.1 sends it and passes. One of the two implementations that do return the 409 has already invented the hint.
Status: open

### G6: what a 5xx original does to the key
Draft section: section-2.6
What the draft says: "The resource SHOULD respond with the result of the previously completed operation, success or an error." Read literally, a 500 the resource produced is "an error" and is therefore replayed for the life of the key, which pins a transient failure and removes the one thing the header exists to make safe, the retry. This is a contested reading, not a silence: the text is there and anyonce reads it narrowly.
anyonce choice: a result with a status below 500 is stored and replayed; on a 5xx or a thrown error the record is abandoned so that the next request with the same key executes again (D6); vector profile/5xx-not-stored.
Proposed draft text: "The result of a previously completed operation is the response the resource chose to return for that operation. A resource SHOULD NOT store, and SHOULD NOT replay, a response that reports a failure of the resource itself (a 5xx status code, Section 15.6 of [RFC9110]) or an operation it did not complete. A resource SHOULD instead release the idempotency key, so that a subsequent request presenting it is treated as a first time request (Section 2.6)."
Third parties that diverge: fiber v3.5.0 stores the 500 and replays it, so profile/5xx-not-stored fails against it with `handlerInvocations: expected 2, got 1`. hono-idempotency 0.9.1 and idempo v1.0.0 both release the key and pass. The survey is two to one, not unanimous, so this has to be argued rather than asserted as settled practice.
Status: open

### G7: whether a 4xx original is replayed
Draft section: section-2.6, section-2.7
What the draft says: the same sentence as G6, "The resource SHOULD respond with the result of the previously completed operation, success or an error.", plus "For other 4xx/5xx errors, such as 401, 403, 500, 502, 503, 504, 429, or any other HTTP error code that is not listed here, the client SHOULD act appropriately by following the resource's documentation." That tells the client what to do with such a response and never says whether the resource stored it under the key. A contested reading, the other half of G6: anyonce keeps 4xx on the replay side of the line it draws at 500.
anyonce choice: a 4xx the handler produced is a result like any other, stored and replayed, so a retry gets the same 404 without a second execution (D6); vector profile/4xx-replayed.
Proposed draft text: "A response with a 4xx status code that the resource produced for the request is a result of the operation for the purpose of this section. A resource SHOULD store it and SHOULD replay it in response to a duplicate request, since re-executing the operation would produce the same rejection."
Third parties that diverge: hono-idempotency 0.9.1 does not store a 404: the retry executes the handler a second time (profile/4xx-replayed fails with `handlerInvocations: expected 1, got 2`). idempo v1.0.0 replays it and passes. fiber v3.5.0 also replays it and fails the vector only on the missing `Idempotency-Replayed` header from G4. Taken with G6 that is three readings of one sentence in three implementations: hono-idempotency stores 2xx and 3xx only, idempo and anyonce store below 500, fiber stores everything.
Status: open

### G8: sf-string syntax, and what a non-conforming value costs
Draft section: section-2.1
What the draft says: "Idempotency-Key is an Item Structured Header [RFC8941]. Its value MUST be a String (Section 3.3.3 of [RFC8941])." Part contested reading and part silence. The MUST binds the value a client sends, and the draft never says what a resource does with a field value that is not a valid String, names no status code for that case, and does not say whether the key is the String's value after parsing, so that `"k"` and `k` are one key, or the field value as received, so that they are two.
anyonce choice: the default `lenient` accepts either a bare token or a quoted sf-string and uses the parsed value, so `"k"` and `k` denote the same key; `strict` requires a valid sf-string and rejects anything else with 400 invalid-key (D7). The vector core/sf-string-quoted-key sends the quoted form for both the original and the retry, so it is graded in core while staying neutral between the two readings.
Proposed draft text: "A resource MUST accept a field value that is a valid String and MUST use the value of that String, after parsing, as the idempotency key; the delimiting double quotes are not part of the key. A resource that receives a field value which is not a valid String SHOULD reply with an HTTP 400 status code. A resource MAY additionally accept a field value that is a valid Token (Section 3.3.4 of [RFC9651]) and use it as the key, for compatibility with deployed implementations that predate this specification; a resource that does so MUST treat that Token and the String with the same characters as the same key."
Third parties that diverge: none. hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0 all accept the quoted form and deduplicate on it, and core/sf-string-quoted-key passes against every one of them. No vector sends the same key in both the quoted and the bare form, so the run says nothing about whether any of them treats `"k"` and `k` as one key; that is the part of this gap the suite deliberately does not grade.
Status: open

### G9: no maximum key length
Draft section: section-2.1, section-5
What the draft says: silent. Section 5 asks the resource to "Always validate the key as per its published specification before processing any request.", which presumes a published bound without naming one a client can count on, and section 2.1 puts no limit on the String. A true silence.
anyonce choice: a key is 1 to 255 bytes of printable ASCII and a longer one is 400 invalid-key with the handler not run (D7); vector profile/key-too-long, whose key is 256 bytes. Q9 moved this vector out of core precisely because the draft sets no maximum, so no third party is graded on it.
Proposed draft text: "A resource MUST accept an idempotency key whose length is at least 255 characters. A resource that imposes a maximum key length MUST publish it as part of the specification required by Section 2.5.2 and SHOULD reply with an HTTP 400 status code to a request whose key exceeds it."
Third parties that diverge: idempo v1.0.0 rejects the 256 byte key with 400 and fails profile/key-too-long only on the anyonce `code` member (`body.code: expected "invalid-key", got undefined`). hono-idempotency 0.9.1 and fiber v3.5.0 both accept it and run the handler (`status: expected 400, got 201`). Three implementations, three different answers at the same input, and a client that has to work against all three has no length it can safely generate.
Status: open

### G10: what the fingerprint has to cover
Draft section: section-2.4, section-2.7
What the draft says: "An idempotency fingerprint MAY be used in conjunction with an idempotency key to determine the uniqueness of a request. Such a fingerprint is generated from request payload data by the resource. An idempotency fingerprint generation algorithm MAY use one of the following or similar approaches to create a fingerprint." and, in section 2.7, "If there is an attempt to reuse an idempotency key with a different request payload, the resource SHOULD reply with a HTTP 422 status code with body containing a link pointing to relevant documentation." The 422 rule turns on "a different request payload" while section 2.4 leaves the comparison optional and its inputs open, so two conforming resources can disagree about whether the same pair of requests is a reuse at all. A silence about the minimum, inside a rule that does exist.
anyonce choice: SHA-256 over the method, the path including the query string, and the body bytes; a reuse with a different fingerprint is 422 and the handler does not run again (D9, D10); vector core/mismatch-422.
Proposed draft text: "A resource that enforces Section 2.2 MUST compare at least the request method, the request target and the request content, and MUST treat a difference in any of those as a different request payload. A resource MAY compare more than this. A resource MUST publish what it compares as part of the specification required by Section 2.5.2."
Third parties that diverge: fiber v3.5.0 does not compare the payload at all, so a second request with the same key and a different body is answered 201 rather than 422 (core/mismatch-422 and core/mismatch-does-not-poison both fail with `changed: status: expected 422, got 201`), see `conformance/issues/fiber-mismatch-422.md`. hono-idempotency 0.9.1 and idempo v1.0.0 both pass core/mismatch-422. The vectors hold the method and the path fixed and vary only the body, so the run shows that two of three compare the body and shows nothing about what else any of them compares.
Status: open

### G11: a rejected mismatch must not poison the key
Draft section: section-2.7
What the draft says: "Clients MUST correct the requests (with the exception of 409 where no correction is required) before performing a retry operation, or the resource MUST fail the request and return one of the above errors." It tells the client what to do next and says nothing about what the 422 did to the stored record, so nothing in the draft stops a resource from overwriting, invalidating or locking the original result when it rejects a mismatched reuse. A true silence, and the one with the worst failure mode: a client that retried once with a corrupted payload would lose the original result forever.
anyonce choice: a 422 is a pure rejection. The stored record is untouched and a later retry with the original payload still replays the original result without executing again (D6, D10); vector core/mismatch-does-not-poison.
Proposed draft text: "A resource that rejects a request under this section MUST NOT alter or discard the record of the previously completed operation. A subsequent request presenting the same idempotency key with the original request payload MUST be answered as a duplicate request under Section 2.6."
Third parties that diverge: none on the point itself. hono-idempotency 0.9.1 and idempo v1.0.0 both reject the mismatch and leave the original replayable, and both pass core/mismatch-does-not-poison. fiber v3.5.0 fails the vector at its `changed` step (`status: expected 422, got 201`, the G10 divergence) while its final `corrected` step passes, so it never rejects and the question does not arise for it. No implementation in the run poisons the key, which is the argument that this rule is uncontroversial and simply missing.
Status: open

### G12: what happens to a request that arrives after expiry
Draft section: section-2.3
What the draft says: "The resource MAY require time based idempotency keys to be able to purge or delete a key upon its expiry. The resource SHOULD define such expiration policy and publish it in the documentation." That is about the resource purging keys. Nothing says what the resource does with a request presenting a key that has already expired: execute it as a first time request, or refuse it as stale. A true silence.
anyonce choice: an expired record is absent to `begin`, so the same key with the same payload executes again as a first time request; the TTL default is 24 hours and expiry is enforced both on read and by a physical purge (D14); vector core/expiry-executes-again.
Proposed draft text: "A request presenting an idempotency key that has expired MUST be treated as a first time request (Section 2.6). A resource MUST NOT reject a request solely because the key it presents has expired." and, for the policy itself: "The expiration policy required by Section 2.5.2 SHOULD be discoverable by a client at runtime, for example as a field of the resource's API description, and not only as prose in its documentation, so that a client can determine when a retry will no longer be deduplicated."
Third parties that diverge: none. hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0 were each configured with a 2 second lifetime for the run (see the Targets notes in `conformance/REPORT.md`), and all three execute the handler again after it, passing core/expiry-executes-again. Every implementation in the run chose the same unstated answer, which makes this one cheap to write down.
Status: open

### G13: the scope a key is unique within
Draft section: section-2.2, section-5
What the draft says: "The idempotency key MUST be unique and MUST NOT be reused with another request with a different request payload." and "Uniqueness of the key MUST be defined by the resource owner and MUST be implemented by the clients of the resource." The only text about scope is a best practice in Security Considerations: "On the resource, implement a unique composite key as the idempotent cache lookup key. For example, a composite key MAY be implemented by combining the idempotency key sent by the client with other client specific attributes known only to the resource." Section 2 never says whether two different operations, or two different clients, may safely present the same key value. A silence in the normative text, with the right answer sitting in a non-normative section.
anyonce choice: a scope is required by the core and is never implicit. The HTTP default is `${method} ${routePattern}`, with a `principal` hook appending the tenant or user (D8); vector core/two-keys-execute-twice, which settles the direction the draft does cover (two keys, one payload, two executions) and is written entirely inside one scope, because the draft gives no basis on which to grade a cross-scope reuse.
Proposed draft text: "Unless the resource publishes otherwise, an idempotency key is unique within the scope of a single operation, and a resource MUST NOT respond to a request for one operation with the stored result of another. A resource that serves more than one client MUST scope the key per client as well, so that a key presented by one client can never return the result of an operation performed for another. This requirement replaces the composite key best practice in Section 5."
Third parties that diverge: none. hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0 all pass core/two-keys-execute-twice. No vector reuses one key across two operations or two clients, so the run gives no evidence on the scope question itself; the note in `conformance/REPORT.md` that hono-idempotency's `methods` and `dangerouslyAllowGlobalKeys` settings are inert for this fixture records exactly that limit.
Status: open

### G14: how large a result a resource must store, and what it does past that
Draft section: section-2.6
What the draft says: silent. The Retry case asks the resource to respond with "the result of the previously completed operation, success or an error." and never bounds what a resource must be able to keep, nor says what it does when the result is larger than it is willing to store. A true silence, and the one the run shows the most disagreement on.
anyonce choice: a result is stored up to `maxResultBytes`, 1 MiB by default, measured over the body only (Q17). A larger result is streamed to the original caller untouched and the record completes with `resultOmitted: true`, so the replay carries the original status and headers, an empty body, `Idempotency-Replayed: true` and `Idempotency-Replay: omitted`, and the handler still runs exactly once (D12); vector profile/omitted-body-replay.
Proposed draft text: "A resource MAY bound the size of the result it stores and MUST publish that bound as part of the specification required by Section 2.5.2. A resource that has not stored the result of a completed operation MUST NOT execute the operation again in response to a duplicate request. It SHOULD reply with the status code and the header fields of the original response, omit the content, and indicate the omission with the Idempotency-Replay header field with the value "omitted"."
Third parties that diverge: all three, in three different ways, against a result of 1 MiB plus one byte. hono-idempotency 0.9.1 and fiber v3.5.0 store and replay the whole body (`body: expected 0 bytes, got 1048577`, with the handler still at one invocation). idempo v1.0.0 neither replays nor signals anything: the retry executes the handler a second time (`handlerInvocations: expected 1, got 2`), which is the outcome the proposed text forbids, and `conformance/issues/idempo-key-missing-required.md` records that its `Options` does carry a `MaxResponseBytes`, so the bound exists there and only its consequence is unspecified. None of the three sends `Idempotency-Replay`.
Status: open

### G15: no stable, machine-readable error code
Draft section: section-2.7
What the draft says: "Following examples shows an error response describing the problem using [RFC7807]." The three examples that follow carry only the members `type`, `title` and `detail`. `type` is a documentation URI each resource chooses for itself and `title` is prose, so a client that talks to two resources has no stable token to branch on and ends up matching on status codes or on English. A true silence: nothing in the draft gestures at such a token.
anyonce choice: every error body is an RFC 9457 problem document with a stable `code` member, one of `missing-key`, `invalid-key`, `conflict`, `fingerprint-mismatch`, `payload-too-large`, `store-unavailable`, and `type` is `${problemBaseUri}${code}` (D10, D11); vector profile/problem-code-member, with G1 for the media type that carries it.
Proposed draft text: "An error response defined by this section SHOULD be a problem details document [RFC9457] carrying a "code" member whose value is a string naming the condition. This specification defines three such values: "missing-key" for a request that omits the field on an operation requiring it, "fingerprint-mismatch" for a reuse of a key with a different request payload, and "conflict" for a request retried while the original is still being processed. The "type" member remains at the resource's discretion."
Third parties that diverge: hono-idempotency 0.9.1 carries a code member on both errors and spells the values in upper snake case (`body.code: expected "missing-key", got "MISSING_KEY"` and `body.code: expected "fingerprint-mismatch", got "FINGERPRINT_MISMATCH"`), which is the strongest evidence in the run that implementers want this member and will invent incompatible spellings of it. idempo v1.0.0 has no code member on its 422 (`body.code: expected "fingerprint-mismatch", got undefined`). fiber v3.5.0 sends no JSON error body at all. The disagreement here is about spelling, not about whether the member is wanted.
Status: open

### G16: two normative references are obsolete
Draft section: section-2.1, section-2.7, section-7.1
What the draft says: "Idempotency-Key is an Item Structured Header [RFC8941]. Its value MUST be a String (Section 3.3.3 of [RFC8941])." with the reference entry "Nottingham, M. and P. Kamp, "Structured Field Values for HTTP", RFC 8941, DOI 10.17487/RFC8941, February 2021", and "Following examples shows an error response describing the problem using [RFC7807]." RFC 9651 obsoleted RFC 8941 in September 2024 and RFC 9457 obsoleted RFC 7807 in July 2023. Neither a silence nor a contested reading: an editorial defect, listed here because the vectors had to pick which document to implement against and because S3 should carry it alongside the behavioral points. The editor's copy delta above records the RFC 8941 half; this entry is its numbered form.
anyonce choice: the sf-string parser implements RFC 9651, whose String type is unchanged from RFC 8941, and every error body is RFC 9457 (D7, D10, D11); vectors core/sf-string-quoted-key, profile/problem-content-type.
Proposed draft text: "In Section 2.1, replace both citations of [RFC8941] with [RFC9651], so that the text reads: Idempotency-Key is an Item Structured Header [RFC9651]. Its value MUST be a String (Section 3.3.3 of [RFC9651]). In Section 2.7, replace [RFC7807] with [RFC9457]. In Section 7.1, replace the two reference entries with: [RFC9651] Nottingham, M. and P-H. Kamp, "Structured Field Values for HTTP", RFC 9651, DOI 10.17487/RFC9651, September 2024 and [RFC9457] Nottingham, M., Wilde, E., and S. Dalal, "Problem Details for HTTP APIs", RFC 9457, DOI 10.17487/RFC9457, July 2023. The String type and its section number are unchanged between RFC 8941 and RFC 9651, so no implementation has to change."
Third parties that diverge: none. No vector grades which revision an implementation cites, so the run has nothing to say here.
Status: open

### G17: whether a resource may require the header at all
Draft section: section-2.7, section-2.5.1
What the draft says: "If the Idempotency-Key request header is missing for a documented idempotent operation requiring this header, the resource SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation." against "Clients MAY choose to send an Idempotency-Key field with any valid value to indicate the user's intent is to only perform this action once. Without a priori knowledge, a general client cannot assume the server will respect this request." The 400 rule presupposes an operation "requiring this header" and no part of the draft ever grants a resource that right or says how the requirement is advertised. A contested reading rather than a silence: the permission is implied by the error handling rule, and core/key-missing-required is graded on that implication.
anyonce choice: `required` is an option whose default is per adapter; where a route requires the header and it is absent, the answer is 400 missing-key and the handler does not run (D10, D11); vector core/key-missing-required, whose fixture documents its POST routes as requiring the header.
Proposed draft text: "A resource MAY require the Idempotency-Key field on an operation. A resource that does so MUST identify the operations concerned in the specification required by Section 2.5.2, and SHOULD reply with an HTTP 400 status code to a request for such an operation that omits the field. A resource that does not require the field MUST still honour it when it is present."
Third parties that diverge: idempo v1.0.0 and fiber v3.5.0 both answer 201 and run the handler (core/key-missing-required fails against each with `missing: status: expected 400, got 201; missing: handlerInvocations: expected 0, got 1`), and in both cases the option does not exist: `conformance/issues/idempo-key-missing-required.md` and `conformance/issues/fiber-key-missing-required.md` walk the shipped source and the option structs and show there is nothing to set. hono-idempotency 0.9.1 has `required: true`, which the fixture sets, and passes. Two of the three implementations in the run cannot express the one case section 2.7 is written around, which is the argument for saying the permission out loud.
Status: open

## Vectors that required no choice

Three vectors are named nowhere above, because nothing about them was open. Each is settled by a sentence of the draft, or by HTTP itself. They are listed so that the coverage check over every vector id has a truthful home for them rather than a manufactured gap.

- core/post-executes-once. Section 2.6, the first bullet: "First time request (idempotency key and fingerprint has not been seen)", answered by "The resource SHOULD process the request normally and respond with an appropriate response and status code." One request, one execution, nothing to choose.
- core/retry-replays. Section 2.6, the Retry case: "The request was retried after the original request completed. The resource SHOULD respond with the result of the previously completed operation, success or an error." The vector replays a 201, which is a success under every reading of that sentence, so it stays clear of G6 and G7.
- core/header-name-case-insensitive. The draft does not restate it, but it registers a field name in section 3.1, "The Idempotency-Key field name should be added to the "Hypertext Transfer Protocol (HTTP) Field Name Registry".", and field names are case-insensitive under Section 5.1 of [RFC9110]. A resource that matched the name case-sensitively would not be implementing an HTTP field at all, so there is no gap to file.

All three pass against hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0.

## Vector index

Every vector under `conformance/vectors/` and the entry that carries it. Eleven core, nine profile.

| Vector | Entries |
|---|---|
| core/concurrent-409 | G5 |
| core/expiry-executes-again | G12 |
| core/get-ignored | G2 |
| core/header-name-case-insensitive | Vectors that required no choice |
| core/key-missing-required | G17 |
| core/mismatch-422 | G10 |
| core/mismatch-does-not-poison | G11 |
| core/post-executes-once | Vectors that required no choice |
| core/retry-replays | Vectors that required no choice |
| core/sf-string-quoted-key | G8, G16 |
| core/two-keys-execute-twice | G13 |
| profile/4xx-replayed | G7, G4 |
| profile/5xx-not-stored | G6 |
| profile/empty-key-rejected | G3 |
| profile/key-too-long | G9 |
| profile/omitted-body-replay | G14, G4 |
| profile/problem-code-member | G15, G1 |
| profile/problem-content-type | G1, G16 |
| profile/replayed-header | G4 |
| profile/retry-after-on-409 | G5 |
