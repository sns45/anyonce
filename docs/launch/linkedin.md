> Unsent draft. Nothing here has been posted. Posting waits on the owner's go and on the in8.sh deploy of the case study (which itself follows the 0.1.0 release, Q80).

# LinkedIn draft for anyonce

Claims source: the case study `content/anyonce/ARTICLE.md` in https://github.com/sns45/in8-home/pull/1, to be served at https://in8.sh/work/anyonce. Attach the poster generated from `image-prompt.md` (see `media-guide.md`). Post text starts below the rule.

---

Your phone loses the answer to "place order" and taps retry.

Your queue decides the consumer took too long and redelivers.

Your payment provider thinks your webhook was slow and sends it again.

Three doors. One order. Three duplicates. 🫠

Every way work reaches a backend delivers at least once. Nothing is lost, anything may arrive twice.

The usual fix is a table: look up the id, then write it.

That leaves a window. The second copy arrives before the first has written its claim, both read "absent", both run. Congratulations, you shipped the customer two lamps.

So I built anyonce: one idempotency core behind all three doors, in TypeScript and Go.

Think of a coat check. The same ticket twice gets the same coat twice. Two people with the same number at the same moment: one gets the coat, the other waits. Your number with a different coat description: "that is not your coat."

That is the whole state machine.
✅ A retry of a finished request gets the stored answer, and the handler does not run again.
⏳ A duplicate that arrives while the first is still running gets 409 with Retry-After.
🚫 The same key with a different payload gets 422.

HTTP with the Idempotency-Key header, anyq queue consumers, Standard Webhooks receivers. Same rules at every door.

Every key is claimed in one atomic write per store. The SQL, the Lua scripts and the DynamoDB expressions are byte identical between the TypeScript and Go implementations, and a parity test fails the build if they drift. Every store, in both languages, has to survive the same race: 50 concurrent claims, exactly one winner.

And here is the part I am proudest of.

The IETF has a draft for the Idempotency-Key header. It expired in April with no successor, and as of September 2026 there were no conformance vectors for it anywhere. "Implements the draft" meant whatever each author read into it.

So anyonce ships 20 executable vectors that only speak HTTP, and I pointed them at three other implementations:
hono-idempotency 0.9.1: 11 of 11 core vectors
idempo v1.0.0: 9 (one miss, replaying a keyed GET, rests on a vector my own draft issue calls arguable and possibly mis-tiered)
Fiber v3.5.0: 7

The same run found 17 places where the draft is silent, ambiguous or out of date. Each one is written up with proposed text. The working group pull request, the mailing list summary and the issues are drafted, not sent yet.

Honest scope, because it matters: this is 0.1.0 pre release. The guarantee is at most one handler run per key while its record is alive, not exactly once side effects. Nothing has been load tested in production.

The npm packages and the Go module publish with the 0.1.0 release. Today it runs from a clone:

git clone https://github.com/sns45/anyonce
bun install && bun run build && bun run test

Once 0.1.0 is out:
bun add @anyonce/core @anyonce/hono
go get github.com/sns45/anyonce/go@v0.1.0

The full case study, with the landscape table, the trade offs and the diagrams:
https://in8.sh/work/anyonce?utm_source=linkedin&utm_medium=social&utm_campaign=anyonce-launch

Code: https://github.com/sns45/anyonce

<!-- [CROSSLINK: reddit] Add the r/programming thread here only if it has an active discussion; otherwise delete this line. -->

The same ticket should always get the same coat.
Even when the coat check is three different buildings.

If you run idempotency in production: do you replay a 500 to a retry, or release the key and let it run again? I chose release, and I would like to hear the case against it.

<!-- cc line left for the owner. Suggestion: people who build on anyq or anyhook, or who maintain Hono and Standard Webhooks tooling. Do not tag the draft's editors or the maintainers of the three graded projects before the S2 mail and the per project issues are sent. -->

#OpenSource #TypeScript #Golang #Idempotency #DistributedSystems #Serverless #BackendEngineering #Webhooks #IETF #APIDesign

---

Attachment note: attach the neo brutalist poster (`03-poster.png`, generated from `image-prompt.md`) as the post image, not inline.
