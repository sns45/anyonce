# P7 Standards Drafts and Launch Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draft the three standards actions S1 to S3 of requirements 0.4 as files under `docs/standards/`, pinned by tests to `conformance/DRAFT-GAPS.md` and the committed P5 results, and prepare the five launch surfaces (in8.sh case study, homepage card, GitHub profile README, resume, Reddit and LinkedIn drafts) through the project-launch and promote skills, with every change to another repository on a branch and an open PR, nothing sent, merged, deployed or published.

**Architecture:** P7 adds no code to any package. The standards drafts are prose whose load-bearing parts (the proposed draft text of every gap, the draft sections cited, the pass counts quoted) are copied from the committed sources and asserted equal by `test/standards.test.ts`, so a later edit to `DRAFT-GAPS.md` or to the results cannot leave a stale draft behind. The case study is written first in `sns45/in8-home` and is the single claims source (project-launch G8); the card, the profile README entry, the resume entry and the promote drafts are checked against it. Other repositories are changed through a branch `anyonce-launch` and a PR each (Q81).

**Tech Stack:** Bun 1.4.2 (`bun test`), Biome 2, TypeScript 5 strict for the test file. in8-home: TanStack Start 1.168, React 19, bun. resume: Vue 3, Vite, bun. No new dependency anywhere.

**Spec:** `requirements.md` sections 0.2 (prior art), 0.3 (claim), 0.4 (S1 to S4), 6 (P7 row), 7 items 4 and 6; `CHECKLIST.md` "Every phase" and "P7 standards and launch"; `conformance/DRAFT-GAPS.md` (G1 to G17), `conformance/REPORT.md`, `conformance/results/`; `docs/superpowers/questions.md` Q1, Q14, Q51, Q62, Q64, Q68 and the new Q80 to Q86.

## Global Constraints

- No em or en dashes (U+2013, U+2014) in any file this phase writes in anyonce. Gate: `rg -n "[\x{2013}\x{2014}]" --glob '!node_modules' --glob '!*.lock' --glob '!docs/reference/**' .` returns nothing. In the other repositories the owner's two live exceptions hold and nothing else: resume `dates` strings use an en dash range separator, profile README entries use " \x{2014} " between the linked name and the description (project-launch targets.md). Never type a `\uXXXX` escape in a tool parameter.
- No external action. No WG PR, no issue on `ietf-wg-httpapi/idempotency`, no mail to `httpapi@ietf.org`, no filing of `conformance/issues/` or S3 drafts, no social post, no `bun run deploy` in in8-home or resume, no merge or push to `main` of any other repository, no npm publish, no tag, no GitHub release. PRs on Shantanu's own repositories (`sns45/in8-home`, `sns45/sns45`, `sns45/resume`) are opened and left open.
- Every standards and launch file says what it is: a draft that has not been sent. The 0.1.0 packages are described as publishing with the release (Q80), never as available.
- Tests are named after the 0.4 item they prove (`S1: ...`, Q86). `bun run test:reqs` gains `--phase p7` in the final task.
- Claims: the case study's "Why this is new" section states 0.3 items 1 and 2 verbatim and item 3 narrowed per Q82, and cites the 0.2 table with dates plus the rows Q82 adds. No other surface claims anything the article does not (G8).
- Git in anyonce from the worktree root as plain single commands. Conventional commits (`docs(standards): ...`, `test(standards): ...`, `docs(launch): ...`).

## Decisions taken in this plan (not spec changes)

- **S1 is a PR on the draft source only** (Q84): an Implementation Status entry in RFC 7942 shape, linking the suite and the report; the vectors are offered, not pushed into the IETF repository. The issue alternative is drafted in the same file.
- **S3 is one issue per gap, in two waves** (Q85). Each issue's "Proposed text" is the DRAFT-GAPS proposed text byte for byte, which the test enforces.
- **S2 quotes numbers from the committed results**, and the test recomputes them from `conformance/results/*.json` (pass counts per implementation), so the mail cannot drift from the report.
- **Claim 3 is narrowed** (Q82): quayside 1.4.0 already makes the single atomic write plus raced contract guarantee for TypeScript.
- **The README case study link becomes `https://in8.sh/work/anyonce`** (Q83); the site PR adds redirects for `/anyonce` and `/anyonce/problems/<code>`.
- **Promote output is kept under `docs/launch/`** rather than `.promotions/` (the P7 brief), with the four always-generated files alongside the Reddit and LinkedIn drafts.

## File Structure

```
docs/standards/S1-wg-pr.md          new: WG PR text (and issue alternative), unsent
docs/standards/S2-mailing-list.md   new: httpapi@ietf.org post, unsent
docs/standards/S3-draft-issues.md   new: G1..G17 issue drafts, two waves, unsent
test/standards.test.ts              new: pins the three drafts to DRAFT-GAPS.md and conformance/results
docs/launch/README.md               new: index of the launch surfaces, PR links, what is still gated
docs/launch/reddit.md, linkedin.md, image-prompt.md, media-guide.md, schedule.md, metadata.json   new: /promote output
README.md, test/readme.test.ts      case study link to /work/anyonce
conformance/DRAFT-GAPS.md           each Status line points at its S3 draft
package.json                        test script gains test/standards.test.ts; test:reqs gains --phase p7
CHECKLIST.md                        P7 items ticked with evidence pointers
docs/superpowers/questions.md       Q80 to Q86
other repositories (branch anyonce-launch, one PR each):
  sns45/in8-home   content/anyonce/ARTICLE.md, src/diagrams/anyonce/*.svg, src/data/content.ts,
                   public/sitemap.xml, public/llms.txt, redirects for /anyonce and /anyonce/problems/*
  sns45/sns45      README.md entry under Backend & infrastructure
  sns45/resume     src/components/Resume.vue PROJECTS entry
```

## Tasks

### Task 1: standards drafts S1 to S3 (branch `p7-standards`)

- [x] Write `test/standards.test.ts` first, failing: `S1: the WG PR draft exists, says it is unsent, targets draft-ietf-httpapi-idempotency-key-header-07 section 4 and RFC 7942, and links the suite and the report`; `S2: the mailing list draft quotes the pass counts that conformance/results records for every implementation`; `S3: every DRAFT-GAPS entry has an issue draft citing the same draft sections`; `S3: every issue draft's proposed text equals the DRAFT-GAPS proposed text byte for byte`; `S3: wave 1 is G4, G5, G6 with G7, G8 and G16 (Q85)`; `S1, S2, S3: no em or en dash and no claim that anything was sent`. Add the file to the root `test` script.
- [x] Write the three drafts until the test passes. Sources: `docs/reference/draft-07.txt` (section numbers and quotations), `conformance/DRAFT-GAPS.md`, `conformance/REPORT.md`, `conformance/issues/`.
- [x] Point each DRAFT-GAPS `Status: open` line at its S3 draft (`Status: open, issue drafted in docs/standards/S3-draft-issues.md#g<n>`), and make the test assert the anchor resolves.
- [x] Gates: `bun run lint`, `bun run test`, dash gate. PR to `p7-launch`, `Part of #49`.

### Task 2: case study and site, profile README, resume (other repositories)

- [x] project-launch Step 0 intake from this repository; Step 1 article `content/anyonce/ARTICLE.md` in in8-home from the four-file template in `docs/eb1a-template/`, gates G1 to G7, with the "Why this is new" section per Q82 and the landscape table carrying the 0.2 rows with dates plus quayside and Powertools; diagrams under `src/diagrams/anyonce/` in the dark palette.
- [x] Step 2 card in `src/data/content.ts`, `public/sitemap.xml`, `public/llms.txt`; the Q83 redirects.
- [ ] Step 3 profile README entry; Step 4 resume entry (one Letter page, columns within 20px, both variants; curation proposals go in the PR body, never applied silently). (Profile README done in sns45/sns45#1; the resume entry is sns45/resume#1 as `atsOnly`, and one Letter page with columns within 20px stays open on Q87.)
- [x] Step 5 G8 check across the three repositories. `bun run build` green in in8-home and resume.
- [x] Each repository: branch `anyonce-launch`, one commit, one PR against `main`, body with the diff summary, the caveats (manual print preview, Q80 publish wording, no deploy). Record the three URLs. Note: sns45/in8-home#1 and sns45/sns45#1 have more than one commit; squash each on merge.

### Task 3: launch drafts, README link, gates (branch `p7-launch-drafts`)

- [x] `test/readme.test.ts` first: the case study link is `https://in8.sh/work/anyonce`; then the README change.
- [x] `/promote --platforms reddit,linkedin` with `content/anyonce/ARTICLE.md` as the sole claims source; outputs copied to `docs/launch/`; reviewed against G8.
- [x] `docs/launch/README.md`: each surface, its PR or file, and what remains gated on the owner.
- [x] CHECKLIST P7 ticks; `test:reqs` gains `--phase p7`.
- [x] Gates below. PR to `p7-launch`, `Part of #49`.

## Phase gate

- `scripts/doctor.sh`
- `bun run lint`, `bun run build`, `bun run test`, `bun run test:reqs` (with `--phase p7`)
- Go: `GOROOT= /opt/homebrew/bin/go vet -C go ./...` and `go test -race` unchanged (no Go change in P7; run to prove it)
- dash gate and key log gate from CHECKLIST "Every phase"
- in8-home and resume: `bun run build` on the PR branch
- `gh pr list` on the three other repositories shows each PR open and unmerged; `git ls-remote` shows their `main` unchanged
- no changeset (no public API change)
