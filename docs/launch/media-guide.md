> Unsent draft. No media has been captured or published. Posting anything captured from this guide waits on the owner's go and on the in8.sh deploy of the case study (which itself follows the 0.1.0 release, Q80).

# Media capture guide for anyonce

## Setup (do this before capturing anything)

- Terminal: 120 columns x 35 rows (`printf '\e[8;35;120t'`), font 16pt or larger, dark theme to match the case study diagrams.
- Browser: window at 1400x900.
- Poster: portrait 1024x1536, as specified in `image-prompt.md`.
- Work from a clean clone of https://github.com/sns45/anyonce so every command shown works today without the 0.1.0 packages.

## Required assets

| # | Filename | What to capture | Used by |
|---|---|---|---|
| 01 | 01-hero.png | Terminal after `bun run conformance -- --url http://127.0.0.1:8787 --capability short-ttl --ttl-ms 2000` against the Go fixture (`go run -C go ./cmd/fixture -idempotent -store memory -addr 127.0.0.1:8787`): the summary line `20 passed, 0 failed, 0 not applicable, 0 errored` with the first rows of the table visible | Reddit, LinkedIn |
| 02 | 02-demo.gif | 15 to 25 seconds: the three `curl -si -X POST .../echo -H 'Idempotency-Key: order-1'` calls from the case study's "See it run" section (fixture restarted with `-ttl-ms 600000`), pausing on `201 Created`, then `Idempotency-Replayed: true`, then `422` with the problem body | Reddit (r/programming, r/typescript, r/golang first comment) |
| 03 | 03-poster.png | Generate from `image-prompt.md`; reject any output that adds words not in the prompt | LinkedIn attachment |
| 04 | 04-install.png | Terminal showing `bun install && bun run build && bun run test` finishing with `0 fail` from a clean clone (not `bun add`, since the packages are not published yet) | Reddit first comments |
| 05 | 05-conformance.png | The case study's Figure 7 (one runner, four implementations) exported from the in8-home PR branch at 1200px wide | r/programming, LinkedIn (second image if the post allows it) |
| 06 | 06-atomic-claim.png | The case study's Figure 5 (two round trips against one conditional write) exported at 1200px wide | r/golang, r/CloudFlare, r/serverless |

## After capturing

Drop the files into `.promotions/2026-09-24/images/` (not committed; `.promotions/` stays out of git) and run `/promote --process-images` to strip EXIF metadata, rename to the sequence above and validate dimensions. Check every captured frame for secrets, tokens, local paths with a username, and full idempotency keys beyond the demo's `order-1`.
