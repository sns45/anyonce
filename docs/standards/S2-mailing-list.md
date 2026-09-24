# S2: running-code post to httpapi@ietf.org

This is an unsent draft held in the anyonce repository. Nothing has been posted to `httpapi@ietf.org`, sent to any person, or filed on any repository, and this text will only be sent if and when the anyonce author decides to send it.

It is the text for requirements 0.4 S2. The body is plain text for an IETF list: no markdown, no tables, lines wrapped near 72 characters, links spelled out. Every pass count in it is recomputed from `conformance/results/*.json` by `test/standards.test.ts`, so it cannot drift from `conformance/REPORT.md`. Send it after S1 is ready to open, so the reply can point at the PR, and before any S3 issue goes out.

Notes for the sender, not part of the mail:

- Send from the address that will stay subscribed to the list; IETF lists hold posts from non-subscribers for moderation.
- The per-implementation findings (`conformance/issues/`) are still unsent drafts. The mail says so on purpose; offer them to each project before anyone on the list reads them as a scorecard.
- If S1 has been opened by the time this goes, add its URL after the gap list link.

```text
To: httpapi@ietf.org
Subject: Running code for draft-ietf-httpapi-idempotency-key-header: two implementations and a conformance suite

Hello all,

draft-ietf-httpapi-idempotency-key-header-07 expired on 18 April 2026
and no -08 has been posted. I would like to offer some running code in
case it helps the WG decide what to do with it.

anyonce is an open source (Apache-2.0) implementation of the draft in
two languages, TypeScript and Go, sharing one state machine and one
store contract across HTTP handlers, queue consumers and webhook
receivers. While building it I wrote a language agnostic conformance
suite for the draft: JSON vectors plus a runner that talks HTTP to any
implementation. The suite separates what the draft requires from what
it leaves open:

  - 11 core vectors, for what -07 requires
  - 9 profile vectors, for behavior the draft does not settle (replay
    indication, Retry-After on 409, 5xx results, key length, result
    size, error codes)

Results from the committed run (third parties are graded on the core
tier only; their profile numbers are information, not a verdict):

  anyonce, TypeScript and Go, 11 runs across 7 stores: core 11/11, profile 9/9 on every run
  hono-idempotency 0.9.1 (TypeScript, Hono middleware): core 11/11
  idempo v1.0.0 (Go, net/http middleware): core 9/11
  fiber v3.5.0 (Go, middleware/idempotency): core 7/11

Report:  https://github.com/sns45/anyonce/blob/main/conformance/REPORT.md
Suite:   https://github.com/sns45/anyonce/tree/main/conformance

Anyone can run the vectors against their own build; nothing in the
runner depends on anyonce's code.

Writing vectors forced a choice wherever the draft is silent or reads
two ways. There are seventeen such points, each with the draft text
quoted, the choice made, what the three other implementations do, and
proposed text for a revision:

  https://github.com/sns45/anyonce/blob/main/conformance/DRAFT-GAPS.md

The ones that seem most worth the WG's time:

  - there is no way to tell a replayed response from a fresh one;
    two of the three independent implementations already send an
    unregistered Idempotency-Replayed: true
  - "success or an error" in 2.6 reads as "replay a 500 forever";
    two of three release the key on a 5xx instead, and the three
    disagree about 4xx
  - the String syntax in 2.1 says nothing about what a resource does
    with a value that is not a valid String, or whether "k" and k
    are one key
  - a 409 carries no hint of when to retry
  - four of the eight normative references have been obsoleted
    (RFC 8941, 7807, 4122, 7231)

Three questions for the WG:

  1. Is there interest in a -08? If so, I am glad to help with text.
  2. Would the editors take a PR adding anyonce to Section 4
     (Implementation Status) under RFC 7942, linking the suite and the
     report? I have one drafted and will open it if that is welcome.
  3. Which of the gaps are worth opening as issues on the draft
     repository? I would rather open the few the WG wants than all
     seventeen at once.

One note on the other implementations: the per-implementation findings
behind those numbers have not been filed on those projects yet. They
will be offered to their authors first, as a shared test asset rather
than a scorecard, and some of the failures are arguably the draft's
ambiguity rather than a bug on their side (the gap list says which).

Thanks,
Shantanu Sharma
https://github.com/sns45/anyonce
```
