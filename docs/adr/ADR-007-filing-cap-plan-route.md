---
doc-type: adr
status: accepted
created: 2026-10-29
updated: 2026-10-29
---

# ADR-007 — the filing cap gets a second route: a plan merged on main

## Status

Accepted, 2026-10-29. Jason's call, after the cap refused a filing he had
asked for twice in one session.

## The problem, measured

`FILINGS_PER_RUN` is 1 per checkout per 24 hours and is deliberately not
configurable. It is a good cap and the number is defended from two
independent readings — Cloudflare's 1.2 findings per review over 131,246
reviews, and this machine's 0.23 filings per run per day across 284
worktrees.

Both readings measure the same population: **a review finding filed
mid-change**. Two things follow that the cap was never asked about.

**1. Decomposition is the other population, and the cap forbids it rather
than slowing it down.** Step 4 of ADR-003 turns one spec criterion into the
right number of issues. Producing several issues in one run is not an
overrun, it is the operation. A cap of 1 does not make that slower; it makes
it impossible, so the tool either cannot exist or exists by not asking.

**2. The cap is enforced on one channel and the tools use the other.** The
gate adjudicates a `gh issue create` clause parsed out of a Bash command.
`createIssue` in `lib/github.ts` calls `client.rest.issues.create` and
consults nothing; `workflows/ship.js` already mints sub-issues through it.
So every tool we own creates issues unmetered, and the only metered path is a
person typing a command. The cap was binding hardest on the route that had a
human in it.

## The decision

Two changes. This ADR ships the first; the second is listed below as planned
work.

**Do not raise the number.** The gate's own record is that a cap nobody can
defend is a cap someone raises, and raising it fixes neither problem above.

**Add a second route, and make it a count rather than a bar.** A filing is
exempt from the per-run allowance when its title appears **verbatim** in a
markdown table column headed `Outcome`, in a file under `docs/adr/`, **on
`origin/main`**. `lib/filing-plan.ts` is the whole of it.

A bar would not work and the gate knows why: on 2026-10-24 three of three
filings cleared the bar *"it makes a green check lie"*, each on an
individually sound argument. This is not a judgement an agent can satisfy by
arguing. It has to get a plan merged first — and that merged plan is the
human reading the cap stands in for. The plan file is the reservation, in the
same sense `specs/sc-reservations.json` is.

### What it does not do

- It does not waive any other refusal. A planned filing that duplicates an
  open issue is still `DUPLICATE`; one that names no SUCCESS.md claim is
  still `NO_CLAIM`. Scoped to the cap, asserted by `FG-182`.
- It does not exempt `UNMEASURED_CAP`. An unreadable ledger means the
  exemption cannot be *recorded*, and an exemption nobody can audit is the
  thing the ledger exists to prevent. `FG-183`.
- It does not read the working tree. An uncommitted plan beside a filing is
  not a reviewed plan, and from inside a worktree a stale tree and a missing
  file look identical.
- It does not let the filer nominate its own plan. There is no `--plan`
  flag; the directory is fixed in the module.

### Which claim this moves

**Claim 4 — "could not measure" never reads as "nothing wrong."** Every
failure path denies the exemption rather than granting it, and the `plannedBy`
column is written on every row and not only the exempted ones, so *how much
of what we file was planned* has a denominator.

## Issues this plan authorises

These are the titles the route above makes filable. Each is work Jason asked
for in the session of 2026-10-29; the table is here so that creating them is
a reviewed act rather than a judgement made at filing time.

| Criterion | Outcome | Files | Milestone | Blocked by |
|---|---|---|---|---|
| Claim 4 | Route createIssue through the filing gate so the tool path is metered too | lib/github.ts, scripts/github-op.ts, test/github-create-gated.test.ts | — | — |
| Claim 4 | Step 4: turn one spec criterion into the right number of issues | lib/issue-decomposition.ts, scripts/plan-issues.ts, lib/cli-commands.ts, test/issue-decomposition.test.ts | — | — |
| Claim 4 | board-mirror spells "no criterion" instead of leaving the cell empty | lib/board-mirror.ts, scripts/board-mirror.ts, test/board-mirror.test.ts | — | — |
| Claim 4 | board-mirror reads every spec, not one | lib/board-mirror.ts, scripts/board-mirror.ts, test/board-mirror.test.ts | — | — |
| Claim 4 | Step 8: promote a review finding into a spec criterion | scripts/plan-spec.ts, lib/issue-repair.ts, test/plan-spec.test.ts | — | — |
| Claim 4 | Triage the 22 issues that serve no criterion into promote, maintenance or close | docs/adr/ADR-008-unaligned-issue-triage.md | — | — |

## The second change, not shipped here

`createIssue` must be adjudicated. Until it is, a tool can still create issues
without passing the gate, and the route above only governs the channel that
was already governed. It is the first row of the table and it is deliberately
a separate change: this one adds a route, that one closes a hole, and putting
them in one diff makes neither reviewable.

**It has a precondition, and the precondition is the first half of that
change.** The exemption is currently re-applied at three independent
consumers of the same fact — the per-clause spend counter, the pre-read
verdict, and the reservation stage — and the third was found only after the
first two were already written. `FG-185` pins all three today, but a test can
assert that three known sites agree; it cannot assert that a fourth, not yet
written, will. `createIssue` is that fourth site. So before routing it:
collapse the three into one function that answers *may this clause file*,
folding the plan reading in, and make every consumer call it. One binding to
mutate, which is the whole of `.claude/rules/checks-must-be-able-to-fail.md`
on two deciders that agree. Raised by the AI review of the PR that added
this, as an advisory finding.

## Consequences

- A plan has to be merged before the issues it names can be filed. That is
  one round-trip, and it is the point.
- The population of planned-versus-unplanned filings becomes readable from
  the ledger's `plannedBy` column.
- A plan file is now load-bearing. A careless edit to an `Outcome` column in
  `docs/adr/` changes what is filable, which is why the column name is stated
  once, in `TITLE_COLUMN`.
