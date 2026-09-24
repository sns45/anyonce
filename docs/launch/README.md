# Launch surfaces

Everything in this folder and in the pull requests below is a draft: nothing has been posted, sent, merged, deployed or published. The case study (`content/anyonce/ARTICLE.md` in the in8-home PR) is the single claims source for every other surface.

| Surface | Where it lives | State |
|---|---|---|
| in8.sh case study, homepage card, sitemap, llms.txt, redirects for `/anyonce` and `/anyonce/problems/<code>` (Q83) | https://github.com/sns45/in8-home/pull/1 | open, not merged, not deployed |
| GitHub profile README entry | https://github.com/sns45/sns45/pull/1 | open, not merged |
| Resume entry | https://github.com/sns45/resume/pull/1 | open, not merged; anyonce added as `atsOnly`, the designed variant is unchanged from main, which already measures two Letter pages in headless Chromium with columns 51px apart (Q87) |
| Reddit and LinkedIn posts | [reddit.md](reddit.md), [linkedin.md](linkedin.md), with [image-prompt.md](image-prompt.md), [media-guide.md](media-guide.md), [schedule.md](schedule.md), [metadata.json](metadata.json) | unsent drafts |
| Standards actions S1 to S3 | [docs/standards/](../standards/) | unsent drafts, pinned by `test/standards.test.ts` |

## What waits on the owner

1. The 0.1.0 release: npm publish with provenance and the `go/v0.1.0` tag (Q64, Q80).
2. The in8.sh deploy, after the release, so the pages never describe packages that are not published.
3. Merging the three pull requests above (Q81), and the resume curation choice (Q87).
4. S1: the Implementation Status pull request to the working group repository (Q84).
5. S2: the summary mail to `httpapi@ietf.org`.
6. S3: the draft issues, wave 1 first (Q85).
7. S4: the per project issues for the third party implementations graded in `conformance/REPORT.md`, drafted in [conformance/issues/](../../conformance/issues/).
8. The Reddit and LinkedIn posts, on the schedule in [schedule.md](schedule.md).
