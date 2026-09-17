# Claude Code execution prompt: anyonce

Copy of the execution prompt, kept in the repo so its phase order stays in sync with questions.md decisions.

Paste this as the first message in a fresh Claude Code session opened in an empty directory that contains `requirements.md`, `CLAUDE.md`, and `CHECKLIST.md`. Superpowers must be installed (`/plugin install superpowers@claude-plugins-official`, verify with `/help` that `/superpowers:brainstorm`, `/superpowers:write-plan`, `/superpowers:execute-plan` exist).

---

Use Superpowers for this entire project.

You are building **anyonce**, a transport-agnostic idempotency primitive (HTTP, queue consumer, webhook receiver) in TypeScript and Go, plus a language-agnostic conformance suite for `draft-ietf-httpapi-idempotency-key-header`. The authoritative spec is `requirements.md` in this directory. `CLAUDE.md` holds repo conventions. `CHECKLIST.md` is the per-phase verification gate.

## Ground rules

1. `requirements.md` is the design. Every architectural decision is already resolved in its section 2 (D1..D22). Do not reopen them. If you find a contradiction or an impossibility, write it to `docs/superpowers/questions.md` with your recommended resolution, proceed with the documented default, and tell me at the next checkpoint.
2. Every test name carries the REQ id it proves, for example `REQ-STORE-8: 50 concurrent begins yield one acquired`. Coverage of REQ ids is itself tested (requirements.md section 7 item 1).
3. Test-driven development on every behavior change. Red, green, refactor. No implementation file lands before its failing test.
4. Prose in docs, READMEs, comments and commit messages: no em or en dashes.
5. Direct tool execution: use `gh`, `bun`, `go`, `docker` yourself. Never ask me to paste output you can fetch.
6. Do not claim a phase is complete without fresh verification output (test run, lint, build) in the message. Use `verification-before-completion` before every handoff.

## Step 0: preflight (do this before any skill)

- Run `npm view anyonce` and `npm view @anyonce/core`; run `gh repo view sns45/anyonce`. All three must fail with not-found. If any succeeds, stop and report; do not scaffold.
- Fetch the current draft text: `curl -sL https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.txt` into `docs/reference/draft-07.txt` (committed, it is the normative reference for vector `draftRef` fields). Also clone `https://github.com/ietf-wg-httpapi/idempotency` read-only into `/tmp` and diff the editor's copy against -07; record any differences in `conformance/DRAFT-GAPS.md` under "Editor's copy delta".
- Read the real anyq consumer handler interfaces: `gh repo clone sns45/anyq /tmp/anyq` and inspect the TS core package and `go/` module. Record the exact handler, message, ack/nack/delay and dead-letter signatures in `docs/reference/anyq-interfaces.md`. The queue adapter in requirements 4.5 is written against these, not against the illustrative shapes.
- Read anyhook's signer (`gh repo clone sns45/anyhook /tmp/anyhook`) and record the Standard Webhooks signing routine you will interop-test against in `docs/reference/anyhook-signing.md`.
- Run `go version`; upgrade the local toolchain to the current stable from go.dev/dl before P1.

## Step 1: brainstorming (bounded)

Invoke the `brainstorming` skill with this framing: "The design is fixed by requirements.md. Your job is to walk it section by section and surface only (a) internal contradictions, (b) missing information you need to write a plan, (c) risks that change sequencing. Do not propose alternative architectures." Save the resulting design note to `docs/superpowers/specs/2026-09-anyonce-design.md`; it should be short and reference requirements.md rather than restate it.

## Step 2: worktree

Use `using-git-worktrees` to create the initial branch `p0-scaffold-and-vectors` from `main` after the initial commit that contains requirements.md, CLAUDE.md, CHECKLIST.md and the reference docs from Step 0.

## Step 3: plans, one per phase

Use `writing-plans` to produce `docs/superpowers/plans/p0-scaffold-and-vectors.md` covering only Phase P0 from requirements.md section 6. Tasks are 2 to 5 minutes each with exact file paths, the failing test to write first, and the verification command. When P0 ships, write the P1 plan, and so on. Never write all phase plans up front; each plan is written against the code that exists.

Phase order and parallelism:
- P0 → P1 → P2 sequential (the engine and HTTP door are the spine).
- P4a (queue door) after P1, in parallel with P2.
- After P2: P3 (stores), P4b (webhook door) and P5 (third-party conformance runs) in parallel via `dispatching-parallel-agents`, each in its own worktree.
- P6 and P7 after everything merges.

## Step 4: execute

Use `subagent-driven-development` for each plan (fresh sub-agent per task, two-stage review). Fall back to `executing-plans` only if sub-agents are unavailable. After each phase:
- run the CHECKLIST.md gate for that phase and paste the results;
- use `requesting-code-review` and address findings with `receiving-code-review`;
- use `finishing-a-development-branch` to open the PR to `main` (squash merge, PR body lists REQ ids covered).

## Step 5: debugging discipline

Any failing test or flaky container: `systematic-debugging`. Reproduce, read the full trace, state the root cause hypothesis, write the regression test, smallest fix. Concurrency tests (REQ-STORE-8) are the ones most likely to flake; a flake is a bug in the store's atomicity, not in the test. Do not add retries or sleeps to make them pass.

## Phase-specific instructions

**P0.** Vectors before code. Write every `core` and `profile` vector from requirements 4.7 first, validate against `conformance/schema.json` in CI, and build the two fixture apps (Hono, net/http) with no idempotency layer so the runner can be tested against a known non-conformant target (it must fail the right vectors). This is the project's outer TDD loop.

**P1.** The engine file gets 100% branch coverage. The store contract suite is exported as a library (`@anyonce/core/testing`, `anyonce/storetest`) before any real store exists; the memory store is its first consumer.

**P2.** The HTTP adapter must stream the original response to the client while buffering a copy; do not buffer-then-send. Prove it with a test that reads the first chunk before the handler finishes writing.

**P3.** Each store lands as its own PR with the contract suite green against a real container or emulator (D20). The D1 and Postgres `begin` statements must be single statements; paste the SQL in the PR body. The Redis scripts live in one file with tests for the EVALSHA fallback path.

**P4a.** Queue adapter: read `docs/reference/anyq-interfaces.md` first. The companion strategy (REQ-Q-8) ships with the adapter, and `docs/queue-ids.md` records redelivery id stability for all nine anyq adapters.

**P4b.** Webhook adapter: the verification gate test (REQ-WH-2) is written before the happy path.

**P5.** Run the URL-mode runner against `hono-idempotency`, `idempo`, and Fiber's middleware using their published examples in Docker. Generate `REPORT.md` with the `-update` flag pattern. Draft the S4 issues in `docs/standards/issues/` but do not open them; I open them.

**P6.** Docs and examples are tested (smoke tests in CI). Benchmarks publish numbers into README via a script, not by hand.

**P7.** Draft S1 (WG repo PR text), S2 (mailing list post), S3 (draft issues) in `docs/standards/`. Do not send. Then invoke the project-launch skill from `~/.claude/skills/project-launch/` to prepare the five launch surfaces.

## Checkpoints where you stop and wait for me

- After Step 1 (design note).
- After each phase's CHECKLIST gate passes and the PR is open.
- Before any external action: opening issues on third-party repos, WG PRs, mailing list posts, npm publish, GitHub release.

Start with Step 0 now and report the preflight results.
