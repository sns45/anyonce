> Unsent drafts. Nothing in this folder or in the pull requests below has been posted, sent, merged, deployed or published, and each step waits on the owner's go in the order below (Q89).

# Launch surfaces

The case study (`content/anyonce/ARTICLE.md` in the in8-home PR) is the single claims source for every other surface.

| Surface | Where it lives | State |
|---|---|---|
| in8.sh case study, homepage card, sitemap, llms.txt, redirects for `/anyonce` and `/anyonce/problems/<code>` (Q83) | https://github.com/sns45/in8-home/pull/1 | open, not merged, not deployed |
| GitHub profile README entry | https://github.com/sns45/sns45/pull/1 | open, not merged |
| Resume entry | https://github.com/sns45/resume/pull/1 | open, not merged; anyonce added as `atsOnly`, the designed variant is unchanged from main, which already measures two Letter pages in headless Chromium with columns 51px apart (Q87) |
| Reddit and LinkedIn posts | [reddit.md](reddit.md), [linkedin.md](linkedin.md), with [image-prompt.md](image-prompt.md), [media-guide.md](media-guide.md), [schedule.md](schedule.md), [metadata.json](metadata.json) | unsent drafts |
| Standards actions S1 to S3 | [docs/standards/](../standards/) | unsent drafts, pinned by `test/standards.test.ts` |

## What waits on the owner

In this order (Q89):

1. The 0.1.0 release: npm publish with provenance and the `go/v0.1.0` tag (Q64, Q80).
2. S4: the per project issues for hono-idempotency, idempo and Fiber, drafted in [conformance/issues/](../../conformance/issues/), offered to each graded project; and S2, the summary mail to `httpapi@ietf.org`. S1 and S2 promise that the findings go to the authors first, so nothing public that quotes a project's score comes before this step.
3. S1: the Implementation Status pull request to the working group repository (Q84).
4. S3: the draft issues, wave 1 (Q85).
5. The in8.sh deploy and the merges of the three pull requests above (Q81), with the resume curation choice (Q87). The case study, the profile README entry and the resume entry carry per project scores, so they wait on step 2 like the social posts do. Before the deploy, the article is re-pinned to the P7 merge commit on main (Q90).
6. The Reddit and LinkedIn posts, on the schedule in [schedule.md](schedule.md).
7. S3 wave 2, after the working group answers wave 1 or the S2 thread (Q85).
