> Unsent draft. Nothing on this schedule has been posted. Posting waits on the owner's go and on the in8.sh deploy of the case study (which itself follows the 0.1.0 release, Q80).

# Posting schedule for anyonce

Preconditions, in order, before Day 1: the 0.1.0 release is published (Q64, Q80); the in8-home PR is merged and deployed, and https://in8.sh/work/anyonce answers; the "publishes with the release" sentences in `reddit.md` and `linkedin.md` are updated to match what actually shipped; the owner says go. Only Reddit and LinkedIn were generated for this launch.

Spread over three days so no subreddit sees a second post from the same account on the same day.

## Day 1 (Tuesday or Thursday)

- [ ] 8:30 AM EST: LinkedIn (`linkedin.md`, with the poster)
- [ ] 10:30 AM EST: Reddit r/programming (`reddit.md`, first comment immediately after)

## Day 2

- [ ] 10:00 AM EST: Reddit r/golang
- [ ] 1:00 PM EST: Reddit r/typescript

## Day 3

- [ ] 10:00 AM EST: Reddit r/serverless
- [ ] 1:00 PM EST: Reddit r/CloudFlare

## Cross linking checklist

After Day 1:
- [ ] Record the LinkedIn and r/programming URLs in `metadata.json`
- [ ] If the r/programming thread has an active discussion, replace the `CROSSLINK: reddit` comment in the LinkedIn post with it; otherwise delete that line

After Day 2 and Day 3:
- [ ] Record each thread URL in `metadata.json`
- [ ] In a later subreddit's first comment, link an earlier thread only if it has a real discussion, phrased as "also discussed on r/programming"; never link LinkedIn from Reddit

## Cross link rules for these two platforms

| When posting to | Link to |
|---|---|
| Reddit | Case study (tracked, in the first comment) and the repository; an earlier Reddit thread in the first comment only if it is active |
| LinkedIn | Case study (tracked) and the repository; the r/programming thread if active |

## Social proof updates

Only state what is true and checkable at the time of the edit. No star, download or adoption numbers unless the case study states them first (G8).
