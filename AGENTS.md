---
doc-type: reference
status: active
owner: jason
updated: 2026-10-28
---

# rungate

## Project Identity

Ship harness — conformity tests, scaffold, and agent briefs for AI-first development
**Tech:** Bun, TypeScript, ESM
- **Repo:** https://github.com/hornjason/pai-harness

## Hard Constraints

### How we work — seven rules, Jason's call, 2026-10-28

1. **A spec says what must be true; it is never the to-do list.** Specs still
   carry checkboxes. Nobody works from them — work comes off the tracker.
2. **Work is an issue, and the issue names the files it will change.** Cannot
   name them → not ready → split it before starting, not during review.
3. **Under ten files per issue.** Google's own published distribution: ~90%
   of their changes touch fewer than ten files, median 24 lines. What
   predicts a failed change is how many separate files it spreads across.
4. **Ordering is data, not prose.** Use GitHub's `blocked by`. "Not adoptable
   before X" in a sentence is unreadable by every tool we own. *What's next*
   is then everything unblocked.
5. **At the third review round, stop repairing and re-scope.** Not an
   automatic close — say what a fourth round would fix that the third did
   not, and if that is a different problem it is a second issue. Rounds are
   a rejection signal, not progress: across 40,214 PRs each extra reviewer
   comment *lowered* merge odds 2.8% on agent-authored changes and *raised*
   them 2.7% on human ones (Yoshioka et al., MSR '26, arXiv:2601.18749;
   review activity explains ~5% of the outcome). **We are above three
   today, and three is the target rather than the norm** — O1 in
   `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` reads 4.50 rounds per change and
   that spec marks it untrustworthy twice: the cohort spans two mechanism
   changes, and #1592 records the counter counting run ATTEMPTS where the
   sentence says ROUNDS.
6. **The proof is a test, not a tick.** `proved-by:` names what ran, and a
   tick with it blank fails the build.
7. **A review finding is a PR comment by default** — an issue only when it is
   out of that PR's scope *and* somebody will act on it. Watch issues opened
   against issues closed: above 1 the backlog diverges however fast the work
   goes. A swarm once ran at three-to-one.

## Rules

- Verify before asserting — try it first, report what actually happened
- Never fake results or hide failures — if it fails, report it honestly
- Fix all test failures before reporting done — a green suite is the minimum bar
- Run full test suite (`bun test`) and show real output — no summaries, no skipped files
- Fix the source, not the output — fix generator, not generated files
- Commit all changes before reporting done — uncommitted work is lost work
- Read PROJECT-STATE.md first on session start — it's the session bridge

## Commands

| Action | Command |
|--------|---------|
| Test | `bun test` |
| Type check | `bun run typecheck` |
| Test as CI sees it | `bun scripts/test-clean-env.ts` |
| Conformity | `bun test test/scaffold-conformity.test.ts` |
| Create spec | `bun bin/rungate.ts create-spec "title"` |
| Create SC | `bun bin/rungate.ts create-sc --pattern <name> --params '<json>'` |
| Re-scaffold | `bun bin/rungate.ts scaffold .` |
| Convert spec | `bun scripts/convert-spec.ts <file> [--dry-run] [--title "..."] [--governs "..."]` |


## Workflow
- **Repo:** https://github.com/hornjason/pai-harness
- **Test:** `bun test`
