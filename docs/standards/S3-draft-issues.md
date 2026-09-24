# S3: issue drafts for draft-ietf-httpapi-idempotency-key-header

This is an unsent draft held in the anyonce repository. Nothing has been filed, opened, posted or commented on `github.com/ietf-wg-httpapi/idempotency`, on `httpapi@ietf.org` or anywhere else, and none of these issues will be opened unless and until the anyonce author decides to open them.

This file carries one issue draft per entry of [`conformance/DRAFT-GAPS.md`](../../conformance/DRAFT-GAPS.md), G1 to G17, for requirements 0.4 S3. Each draft names the same draft sections as its gap entry, quotes the draft only where the gap entry already quotes it (each quotation is verbatim from `draft-ietf-httpapi-idempotency-key-header-07`, see [`docs/reference/draft-07.txt`](../reference/draft-07.txt)), summarises the evidence from the P5 cross-implementation run, and carries the gap entry's proposed draft text byte for byte in a `text` block under "Proposed text". `test/standards.test.ts` holds the two files together, so an edit to a proposed passage in `DRAFT-GAPS.md` fails the build until the matching issue draft is updated.

## How these would be filed

Q85 decided the order. Seventeen issues opened at once against an expired draft would read as a dump rather than as feedback from running code, so the drafts go out in two waves.

- Wave 1, six gaps in five issues: G4 (replay indication), G5 (Retry-After on 409), G6 and G7 together as one issue on the "success or an error" sentence, G8 (sf-string syntax), and G16 (obsolete references, editorial). These are the four candidates requirements 0.4 names, plus the one change nobody should have to argue about.
- Wave 2, the remaining eleven: G1, G2, G3, G9, G10, G11, G12, G13, G14, G15 and G17. Opened only after the WG has answered wave 1 or the S2 thread, and trimmed to whatever that answer suggests is still wanted.

Once an issue exists on the draft repository, the matching `DRAFT-GAPS.md` entry's `Status:` line becomes `issue filed <url>`.

Every issue body would end with the same short paragraph, kept here once rather than seventeen times:

> This came out of implementing the draft twice (TypeScript and Go, in anyonce) and writing an executable conformance suite for it: 11 core and 9 profile vectors, run against both anyonce implementations and three independent ones (hono-idempotency 0.9.1, idempo v1.0.0, fiber v3.5.0). The suite, the committed results and the full gap list are at https://github.com/sns45/anyonce/tree/main/conformance, the report at https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md, and this point is gap G<n> in https://github.com/sns45/anyonce/blob/main/conformance/DRAFT-GAPS.md. The proposed text is a starting point for discussion, not a demand; if the WG settles on different wording or a different answer, the vectors will follow the draft.

The evidence below is from that run. Third parties are graded on the core tier only; the profile results quoted for them are information about what they do, never a judgement that they are wrong.

## G1: error response media type

Wave: 2
Issue title: Error responses: recommend application/problem+json (RFC 9457) for the 400, 409 and 422 cases
Draft section: section-2.7

### Problem

Section 2.7 asks for a 400 whose body links to documentation, shows an RFC 7807 problem document as an example and a Link header as an alternative, but never says which media type the body uses:

> SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation

A client that wants to parse the error body in a uniform way across resources has nothing to rely on.

### Evidence from running code

hono-idempotency 0.9.1 already sends `application/problem+json` for both its 400 and its 422. idempo v1.0.0 sends it on the 422 but answers a missing key with a 201 and `text/plain`. fiber v3.5.0 sends `text/plain` and never reaches an error status. anyonce uses RFC 9457 problem details everywhere. The vectors grade this as a profile expectation only, so no implementation is marked failing on it.

### Proposed text

```text
Error responses for the 400, 409 and 422 cases SHOULD use the application/problem+json media type [RFC9457]. A Link header with rel="describedby" MAY be sent in addition.
```

## G2: keys on safe methods

Wave: 2
Issue title: What does a resource do with an Idempotency-Key on GET and the other idempotent methods?
Draft section: section-1

### Problem

Section 1 motivates the header by the difference between idempotent and non-idempotent methods:

> An HTTP request method is considered idempotent if the intended effect on the server of multiple identical requests with that method is the same as the effect for a single such request. Per [RFC9110], the methods OPTIONS, HEAD, GET, PUT and DELETE are idempotent while methods POST and PATCH are not.

That is motivation, not a rule. Nothing in the draft says whether a key that arrives on a GET is honoured, stored and replayed, or ignored. Client libraries commonly attach the header to every request, so the question comes up in practice.

### Evidence from running code

idempo v1.0.0 stores the first GET and replays it, so a second GET with the same key does not see a POST that ran in between (`core/get-ignored`: `get-after: body.count: expected 1, got 0`). hono-idempotency 0.9.1 and fiber v3.5.0 ignore the key on GET, as anyonce does. The vector sits in the core tier on the strength of section 1's framing, which is arguable; an answer from the WG would settle whether it belongs there.

### Proposed text

```text
A resource SHOULD ignore the Idempotency-Key header on requests whose method is idempotent by definition (Section 9.2.2 of [RFC9110]).
```

## G3: empty key

Wave: 2
Issue title: Is an empty String a valid idempotency key?
Draft section: section-2.1

### Problem

Section 2.1 says the value MUST be a String. An empty String is syntactically valid, and nothing in the draft says whether it identifies a request. A client bug that sends `Idempotency-Key: ""` silently shares one key across every request that makes the same mistake.

### Evidence from running code

All three third parties accept the empty quoted key and run the handler (`profile/empty-key-rejected`: `status: expected 400, got 201` against each). anyonce rejects it with 400. Since everyone else accepts it, this one is a question for the WG rather than a correction to anyone.

### Proposed text

```text
An empty string MUST NOT be used as an idempotency key; a resource SHOULD reject it with 400.
```

## G4: no indication that a response is a replay

Wave: 1
Issue title: Define a response header that marks a replayed response (Idempotency-Replayed)
Draft section: section-2.6

### Problem

Section 2.6 tells a resource to replay the stored result:

> The request was retried after the original request completed. The resource SHOULD respond with the result of the previously completed operation, success or an error.

It names no way for a client to tell that response apart from a fresh execution, so a client cannot log, meter or alarm on its own retries.

### Evidence from running code

Two of the three independent implementations in the run, hono-idempotency 0.9.1 and idempo v1.0.0, already send `Idempotency-Replayed: true` on a replay, and so does anyonce. fiber v3.5.0 sends no such field (`profile/replayed-header`: `header Idempotency-Replayed: expected "true", got absent`). Implementers have converged on the same unspecified field name on their own, which is the argument for writing it down and registering it.

### Proposed text

```text
A resource that responds with the result of a previously completed operation SHOULD indicate that it has done so by including the Idempotency-Replayed HTTP response header field. Idempotency-Replayed is an Item Structured Header [RFC9651] whose value MUST be the Token "true". A resource MUST NOT include this field in a response to a first time request. The Idempotency-Replayed field name should be added to the "Hypertext Transfer Protocol (HTTP) Field Name Registry".
```

## G5: a 409 says nothing about when to come back

Wave: 1
Issue title: 409 while the original request is in progress: recommend Retry-After
Draft section: section-2.7, section-2.6

### Problem

Section 2.7 defines the 409 and then tells the client to retry without correction:

> If the request is retried, while the original request is still being processed, the resource SHOULD reply with an HTTP 409 status code with body containing problem description.

> Clients MUST correct the requests (with the exception of 409 where no correction is required) before performing a retry operation, or the resource MUST fail the request and return one of the above errors.

The client is told to send the same request again and is given nothing to time that retry with, so it either polls or guesses.

### Evidence from running code

hono-idempotency 0.9.1 already sends `Retry-After` on its 409, as anyonce does (whole seconds from the remaining lease, minimum 1). idempo v1.0.0 returns the 409 without it (`profile/retry-after-on-409`: `header Retry-After: expected /^[1-9][0-9]*$/, got absent`). fiber v3.5.0 does not return a 409 at all: the duplicate waits for the original and is answered 200. The proposal uses the delay-seconds form because the value is the remainder of a lease, which needs no agreement between client and server clocks.

### Proposed text

```text
A resource that replies with an HTTP 409 status code under this section SHOULD include a Retry-After header field (Section 10.2.3 of [RFC9110]) whose value is a number of seconds, the delay-seconds form of that field, after which the original request is expected to have completed. A client that receives such a field SHOULD NOT retry the request before that time has elapsed. The request is retried unchanged, since no correction is required for this case.
```

## G6: what a 5xx original does to the key

Wave: 1
Grouping: one issue with G7
Issue title: Which results are replayed: "success or an error" against deployed practice for 5xx and 4xx
Draft section: section-2.6

### Problem

G6 and G7 are one sentence read two ways, so they would go out as a single issue whose body carries both proposed passages, this one first.

> The resource SHOULD respond with the result of the previously completed operation, success or an error.

Read literally, a 500 the resource produced is "an error" and is replayed for the life of the key. That pins a transient failure and takes away the one thing the header exists to make safe, the retry.

### Evidence from running code

hono-idempotency 0.9.1 and idempo v1.0.0 both release the key after a 5xx, so the retry executes again, which is what anyonce does. fiber v3.5.0 stores the 500 and replays it (`profile/5xx-not-stored`: `handlerInvocations: expected 2, got 1`). Two to one, not unanimous, so this is a question worth the WG's view rather than settled practice.

### Proposed text

```text
The result of a previously completed operation is the response the resource chose to return for that operation. A resource SHOULD NOT store, and SHOULD NOT replay, a response that reports a failure of the resource itself (a 5xx status code, Section 15.6 of [RFC9110]) or an operation it did not complete. A resource SHOULD instead release the idempotency key, so that a subsequent request presenting it is treated as a first time request (Section 2.6).
```

## G7: whether a 4xx original is replayed

Wave: 1
Grouping: one issue with G6
Issue title: Which results are replayed: "success or an error" against deployed practice for 5xx and 4xx
Draft section: section-2.6, section-2.7

### Problem

The other half of the same sentence. Section 2.7 adds:

> For other 4xx/5xx errors, such as 401, 403, 500, 502, 503, 504, 429, or any other HTTP error code that is not listed here, the client SHOULD act appropriately by following the resource's documentation.

That tells the client what to do with such a response and never says whether the resource stored it under the key.

### Evidence from running code

Against a 201, a 404 and a 500, the run measured three readings: hono-idempotency 0.9.1 stores the 201 alone (`profile/4xx-replayed`: `handlerInvocations: expected 1, got 2`), idempo v1.0.0 and anyonce store the 201 and the 404, and fiber v3.5.0 stores all three. No vector produces a 3xx, so the run says nothing about those.

### Proposed text

```text
A response with a 4xx status code that the resource produced for the request is a result of the operation for the purpose of this section. A resource SHOULD store it and SHOULD replay it in response to a duplicate request, since re-executing the operation would produce the same rejection.
```

## G8: sf-string syntax, and what a non-conforming value costs

Wave: 1
Issue title: Idempotency-Key syntax: quoted String versus bare Token, and what a resource does with an invalid value
Draft section: section-2.1

### Problem

> Idempotency-Key is an Item Structured Header [RFC8941]. Its value MUST be a String (Section 3.3.3 of [RFC8941]).

The MUST binds what a client sends. The draft does not say what a resource does with a field value that is not a valid String, nor whether the key is the String's value after parsing (so that `"k"` and `k` are one key) or the field value as received (so that they are two). Section 4.2 of RFC 9651 supplies a default, ignore the field, and wherever the header is not required that default runs the request with no idempotency at all while the client believes it is protected. The draft's own examples in sections 2.2 and 6 use the quoted form, so a resource that also accepts a bare Token has to decide whether the two denote the same key.

### Evidence from running code

hono-idempotency 0.9.1, idempo v1.0.0 and fiber v3.5.0 all accept the quoted form and deduplicate on it (`core/sf-string-quoted-key` passes against each). No vector sends the same key in both forms, so the run does not show whether any of them treats `"k"` and `k` as one key; anyonce accepts both by default and treats them as one, with a strict mode that rejects anything but a valid String with 400.

### Proposed text

```text
A resource MUST accept a field value that is a valid String and MUST use the value of that String, after parsing, as the idempotency key; the delimiting double quotes are not part of the key. A resource that receives a field value which is not a valid String SHOULD reply with an HTTP 400 status code, rather than ignoring the field as Section 4.2 of [RFC9651] would otherwise direct. A resource MAY additionally accept a field value that is a valid Token (Section 3.3.4 of [RFC9651]) and use it as the key, for compatibility with deployed implementations that predate this specification; a resource that does so MUST treat that Token and the String with the same characters as the same key.
```

## G9: no maximum key length

Wave: 2
Issue title: Recommend a key length every resource accepts, and require a published maximum
Draft section: section-2.1, section-5

### Problem

Section 5 asks the resource to validate against a published specification:

> Always validate the key as per its published specification before processing any request.

Section 2.1 puts no limit on the String, so a client that talks to several resources has no length it can safely generate.

### Evidence from running code

At a 256 byte key the run saw three answers: idempo v1.0.0 rejects it with 400, hono-idempotency 0.9.1 and fiber v3.5.0 accept it and run the handler (`profile/key-too-long`: `status: expected 400, got 201`), and anyonce rejects anything over 255 bytes. Graded as profile only, since the draft sets no maximum.

### Proposed text

```text
A resource MUST accept an idempotency key of any length from 1 to 255 characters, and MUST NOT reject a key solely because of its length unless that length exceeds 255 characters. A resource that imposes a maximum key length MUST publish it as part of the specification required by Section 2.5.2 and SHOULD reply with an HTTP 400 status code to a request whose key exceeds it.
```

## G10: what the fingerprint has to cover

Wave: 2
Issue title: What must be compared before a key reuse is answered 422?
Draft section: section-2.4, section-2.7

### Problem

> If there is an attempt to reuse an idempotency key with a different request payload, the resource SHOULD reply with a HTTP 422 status code with body containing a link pointing to relevant documentation.

> An idempotency fingerprint MAY be used in conjunction with an idempotency key to determine the uniqueness of a request.

The 422 rule turns on "a different request payload" while section 2.4 leaves the comparison optional and its inputs open, so two conforming resources can disagree about whether the same pair of requests is a reuse at all.

### Evidence from running code

fiber v3.5.0 does not compare the payload, so a second request with the same key and a different body is answered 201 (`core/mismatch-422`: `changed: status: expected 422, got 201`). hono-idempotency 0.9.1 and idempo v1.0.0 compare the body and return 422. anyonce fingerprints the method, the path with query, and the body. The vectors vary only the body, so the run says nothing about what else anyone compares.

### Proposed text

```text
A resource that applies the rule in this section for an attempt to reuse an idempotency key with a different request payload MUST compare at least the request method, the request target and the request content, and MUST treat a difference in any of those as a different request payload. A resource MAY compare more than this. A resource MUST publish what it compares as part of the specification required by Section 2.5.2.
```

## G11: a rejected mismatch must not poison the key

Wave: 2
Issue title: A 422 for a mismatched reuse must leave the original result replayable
Draft section: section-2.7

### Problem

> Clients MUST correct the requests (with the exception of 409 where no correction is required) before performing a retry operation, or the resource MUST fail the request and return one of the above errors.

That tells the client what to do next and says nothing about what the 422 did to the stored record. A resource that overwrote or invalidated the original result on a mismatch would leave a client that retried once with a corrupted payload unable ever to recover it.

### Evidence from running code

No implementation in the run poisons the key: hono-idempotency 0.9.1, idempo v1.0.0 and anyonce all reject the mismatch and still replay the original afterwards (`core/mismatch-does-not-poison` passes). fiber v3.5.0 never rejects the mismatch (see G10), so the question does not arise for it. The rule looks uncontroversial and simply missing.

### Proposed text

```text
A resource that rejects a request under this section MUST NOT alter or discard the record of the previously completed operation. A subsequent request presenting the same idempotency key with the original request payload MUST be answered as a duplicate request under Section 2.6.
```

## G12: what happens to a request that arrives after expiry

Wave: 2
Issue title: A request presenting an expired key: first time request, and a discoverable expiry policy
Draft section: section-2.3

### Problem

> The resource MAY require time based idempotency keys to be able to purge or delete a key upon its expiry. The resource SHOULD define such expiration policy and publish it in the documentation.

That covers purging. Nothing says whether a request presenting an already expired key is executed as a first time request or refused as stale, and a policy published only as prose cannot be used by a client at runtime.

### Evidence from running code

hono-idempotency 0.9.1, idempo v1.0.0, fiber v3.5.0 and anyonce all execute the request again after expiry (`core/expiry-executes-again` passes against each, with a 2 second lifetime configured for the run). Every implementation chose the same unstated answer, which makes it cheap to write down. This issue carries two proposed passages.

### Proposed text

```text
A request presenting an idempotency key that has expired MUST be treated as a first time request (Section 2.6). A resource MUST NOT reject a request solely because the key it presents has expired.
```

```text
The expiration policy required by Section 2.5.2 SHOULD be discoverable by a client at runtime, for example as a field of the resource's API description, and not only as prose in its documentation, so that a client can determine when a retry will no longer be deduplicated.
```

## G13: the scope a key is unique within

Wave: 2
Issue title: Move key scoping (per operation, per client) from Security Considerations into section 2
Draft section: section-2.2, section-5

### Problem

> The idempotency key MUST be unique and MUST NOT be reused with another request with a different request payload.

> Uniqueness of the key MUST be defined by the resource owner and MUST be implemented by the clients of the resource.

The only text about scope is a best practice in section 5:

> On the resource, implement a unique composite key as the idempotent cache lookup key. For example, a composite key MAY be implemented by combining the idempotency key sent by the client with other client specific attributes known only to the resource.

Section 2 never says whether two operations, or two clients, may safely present the same key value.

### Evidence from running code

All three third parties and anyonce pass `core/two-keys-execute-twice`. No vector reuses a key across operations or clients, so the run gives no evidence on the scope question itself; this one is raised from the implementation side (anyonce requires an explicit scope, method plus route pattern by default, with an optional principal) rather than from a divergence.

### Proposed text

```text
Unless the resource publishes otherwise, an idempotency key is unique within the scope of a single operation, and a resource MUST NOT respond to a request for one operation with the stored result of another. A resource that serves more than one client MUST scope the key per client as well, so that a key presented by one client can never return the result of an operation performed for another. This requirement replaces the composite key best practice in Section 5.
```

## G14: how large a result a resource must store, and what it does past that

Wave: 2
Issue title: Results too large to store: what a duplicate request gets
Draft section: section-2.6

### Problem

> The resource SHOULD respond with the result of the previously completed operation, success or an error.

The draft never bounds what a resource must be able to keep, nor says what it does when the result is larger than it is willing to store.

### Evidence from running code

Against a result of 1 MiB plus one byte, the three third parties did three different things. hono-idempotency 0.9.1 and fiber v3.5.0 store and replay the whole body. idempo v1.0.0 does not store it and executes the handler again on the retry (`profile/omitted-body-replay`: `handlerInvocations: expected 1, got 2`), although it has a `MaxResponseBytes` option, so the bound exists and only its consequence is unspecified. anyonce executes once and replays the status and headers with an empty body and `Idempotency-Replay: omitted`. The second field is proposed in the same shape as G4's; a parameter on `Idempotency-Replayed` would be a tighter design and the WG may well prefer it.

### Proposed text

```text
A resource MAY bound the size of the result it stores and MUST publish that bound as part of the specification required by Section 2.5.2. A resource that completed an operation but did not store its result because the result exceeded that bound MUST NOT execute the operation again in response to a duplicate request. It SHOULD reply with the status code and the header fields of the original response, omit the content, and indicate the omission by including the Idempotency-Replay HTTP response header field. Idempotency-Replay is an Item Structured Header [RFC9651] whose value MUST be a Token; this specification defines the Token "omitted", meaning that the content of the original response was not retained. A response carrying Idempotency-Replay MUST also carry Idempotency-Replayed. The Idempotency-Replay field name should be added to the "Hypertext Transfer Protocol (HTTP) Field Name Registry".
```

## G15: no stable, machine-readable error code

Wave: 2
Issue title: A stable machine-readable code member in the problem details error responses
Draft section: section-2.7

### Problem

> Following examples shows an error response describing the problem using [RFC7807].

The examples that follow carry only `type`, `title` and `detail`. `type` is a URI each resource chooses and `title` is prose, so a client that talks to two resources has no stable token to branch on.

### Evidence from running code

hono-idempotency 0.9.1 carries a code member on both of its errors, spelled `MISSING_KEY` and `FINGERPRINT_MISMATCH`; anyonce carries one spelled `missing-key` and `fingerprint-mismatch`. idempo v1.0.0 has no code member on its 422 and fiber v3.5.0 sends no JSON error body. Implementers want this member and are already inventing incompatible spellings of it.

### Proposed text

```text
An error response defined by this section SHOULD be a problem details document [RFC9457] carrying a "code" member whose value is a string naming the condition. This specification defines three such values: "missing-key" for a request that omits the field on an operation requiring it, "fingerprint-mismatch" for a reuse of a key with a different request payload, and "conflict" for a request retried while the original is still being processed. The "type" member remains at the resource's discretion.
```

## G16: four of the eight normative references are obsolete

Wave: 1
Issue title: Editorial: update the obsolete normative references (RFC 8941, RFC 7807, RFC 4122, RFC 7231)
Draft section: section-1.1, section-2.1, section-2.2, section-2.7, section-7.1

### Problem

Section 7.1 lists eight normative references, and four have been obsoleted since they were cited: RFC 9651 obsoleted RFC 8941 (September 2024), RFC 9457 obsoleted RFC 7807 (July 2023), RFC 9562 obsoleted RFC 4122 (May 2024), and RFC 9110 obsoleted RFC 7231 (June 2022). For example:

> Idempotency-Key is an Item Structured Header [RFC8941]. Its value MUST be a String (Section 3.3.3 of [RFC8941]).

The draft also already cites [RFC9110] in sections 1 and 2.7 while section 1.1 still defines "resource" by [RFC7231], and the IMF-fixdate rule section 1.1 includes by reference is used nowhere in the document.

### Evidence from running code

None needed: no vector grades which revision an implementation cites. Nothing here changes an implementation. The String type and its section number are unchanged between RFC 8941 and RFC 9651, and version 4 UUIDs are unchanged between RFC 4122 and RFC 9562. anyonce's parser implements RFC 9651 and its error bodies RFC 9457.

### Proposed text

```text
In Section 1.1, delete the clause that includes the IMF-fixdate rule by reference, since no rule in this document uses it, and repoint the definition that follows so that it reads: The term "resource" is to be interpreted as defined in Section 3.1 of [RFC9110], that is identified by an URI. In Section 2.1, replace both citations of [RFC8941] with [RFC9651], so that the text reads: Idempotency-Key is an Item Structured Header [RFC9651]. Its value MUST be a String (Section 3.3.3 of [RFC9651]). In Section 2.2, replace both citations of [RFC4122] with [RFC9562]. In Section 2.7, replace [RFC7807] with [RFC9457]. In Section 7.1, delete the [RFC7231] entry, which no remaining citation needs, and replace the other three with: [RFC9562] Davis, K., Peabody, B., and P. Leach, "Universally Unique IDentifiers (UUIDs)", RFC 9562, DOI 10.17487/RFC9562, May 2024; [RFC9457] Nottingham, M., Wilde, E., and S. Dalal, "Problem Details for HTTP APIs", RFC 9457, DOI 10.17487/RFC9457, July 2023; and [RFC9651] Nottingham, M. and P-H. Kamp, "Structured Field Values for HTTP", RFC 9651, DOI 10.17487/RFC9651, September 2024.
```

## G17: whether a resource may require the header at all

Wave: 2
Issue title: Say explicitly that a resource may require the header, and how that is published
Draft section: section-2.7, section-2.5.1

### Problem

> If the Idempotency-Key request header is missing for a documented idempotent operation requiring this header, the resource SHOULD reply with an HTTP 400 status code with body containing a link pointing to relevant documentation.

> Clients MAY choose to send an Idempotency-Key field with any valid value to indicate the user's intent is to only perform this action once. Without a priori knowledge, a general client cannot assume the server will respect this request.

The 400 rule presupposes an operation "requiring this header", and no part of the draft grants a resource that right or says how the requirement is advertised.

### Evidence from running code

hono-idempotency 0.9.1 has a `required` option and passes `core/key-missing-required`, as does anyonce. idempo v1.0.0 and fiber v3.5.0 have no such option at all, so they answer 201 and run the handler (`missing: status: expected 400, got 201`). Two of the three independent implementations cannot express the case section 2.7 is written around, which suggests the permission is worth saying out loud.

### Proposed text

```text
A resource MAY require the Idempotency-Key field on an operation. A resource that does so MUST identify the operations concerned in the specification required by Section 2.5.2, and SHOULD reply with an HTTP 400 status code to a request for such an operation that omits the field. A resource that does not require the field MUST still honour it when it is present on a request whose method is not idempotent by definition (Section 9.2.2 of [RFC9110]).
```
