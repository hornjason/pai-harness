---
doc-type: spec
testable: true
compliance: strict
governs: Automated code review convergence — the mechanisms from Anthropic's "Solving code review" that RunGate adopts, what each one must do, and how we know whether it works. This is the alignment reference for all finding-arbiter, jury, review-depth and approval work.
status: active
owner: jason
created: 2026-10-22
source: https://claude.dev/blog/solving-code-review-at-anthropic/
updated: 2026-10-26
---

# Code Review Convergence

## Why this document exists

The finding-arbiter work was dispatched from a blog post and then run from memory.
There was no written reference, so there was nothing to drift *from* and nothing that
could say we had. Two symptoms, both measured on 2026-10-22:

- **Two PRs (#1280, #1282) implemented #1261 simultaneously**, in different files, to
  different ideas of "done". Neither was wrong; nothing defined the target.
- A mechanism nobody asked for (a PR-collision check) was added to the arbiter's scope
  by the lead mid-flight. It may well be a good idea. It is not in the source.

This spec is the target. **Anything not in here is drift until it is added here.**

## The reframe this is all downstream of

> Code review does two jobs: find issues before they ship, and build shared context.
> "Did a human read the code?" is **an imprecise proxy** for "what could go wrong with
> this change, and which check — automated or human — is the right one to catch it?"

Objective, stated in the source and adopted verbatim as ours:

> **The minimum amount of human review time that doesn't raise reverts or incidents.**

And the cost rule that stops us gaming it:

> Human time covers both sides of review's cost: the time people spend reviewing, and
> the time they spend fixing what bad code breaks. Cutting the first doesn't help if the
> time just shows up in the second.

## THE FINDING WE HAVE MOST VIOLATED

> **Every finding has to be answered. You either fix it or resolve the thread with a
> reason.**

Anthropic has no review backlog **because findings never become backlog**. A finding is
an inline comment that blocks merge until it is dispositioned. There is no filing step.

**We invented the filing step, and it is the systematic defect.** Measured on this repo:
359 issues filed *and* closed in seven days, median lifetime 3.1 hours, open flat at ~30.
That is a dispatch queue wearing a tracker's clothes. 45% of filings that name a file were
made while a PR was already open touching that exact file.

Every criterion below is subordinate to this one. A mechanism that makes filing smarter
without making *not filing* the default has missed the point.

## Success criteria

Criteria are grouped by the source's own layers. Each states the mechanism, not the
implementation.

### Layer 1 — before the PR

- [ ] CRC-A1: The agent is given something runnable and must show the output, not assert completion.
- [ ] CRC-A2: A fresh-context subagent reviews the diff before the PR opens.
- [ ] CRC-A3: `CLAUDE.md` is short, states stack/conventions/goals/non-goals, and points elsewhere for detail.
- [ ] CRC-A4: The reviewer flags code breaking a `CLAUDE.md` convention, AND changes that make a line in it out of date.
- [x] CRC-A5: `REVIEW.md` exists per owned area, written by code owners. (shipped, #1167)
- [x] CRC-A6: A check reports whether the reviewer actually followed `REVIEW.md`. (shipped, #1233/#1246)
- [ ] CRC-A7: `REVIEW.md` caps the nits, lists paths to skip, demands file-and-line evidence rather than a guess from a name, and requires a summary that starts with a count and says plainly when there is nothing to fix.
- [ ] CRC-A8: **Fix at the source.** When the reviewer keeps flagging the same thing, the repair goes into the skill, a lint rule, or an instruction file — not into another finding.

### Layer 2 — AI review on every PR

- [ ] CRC-B1: The reviewer reads the diff against the whole repo **and the PR's stated intent**.
- [ ] CRC-B2: On a bug fix, the reviewer looks for the root cause.
- [ ] CRC-B3: **Several agents look for bugs at the same time** (parallel generation). **Not an unqualified good here, and the qualification is CRC-B4's, pointed the other way.** The reviewer is a *sampled* instrument, so N generators are N draws and they raise recall and the false-positive rate together. Measured on run `39962683401`: two attempts on merge commit `99d50fc`, both at round 5, with the tree, the head, the prompt and the model all held fixed, returned **BLOCKED then CLEAN** — and the blocking finding was false, claiming a routing row that was present at the reviewed head. So the disagreement a second draw buys has already been observed arriving in the costly direction. Under the source's priority that trade is worth taking; under ours it is not, because CRC-M8 is inverted here by declared decision and a false block costs a remedy commit, a CI round, a review round and an agent's whole context. **Parallel generation without CRC-B4's quorum behind it is therefore strictly worse than one generator** — it is N chances to block on a false positive with nothing filtering them — so this criterion is not adoptable before CRC-B4, and adopting it first would be measurable harm rather than partial progress.
- [ ] CRC-B4: **A separate group of agents votes on each finding**, and it is surfaced only if enough agree it is real. The ledger records **every verifier's individual vote** and **whether the verifiers disagreed**, both as first-class fields written at decision time. Without them every threshold except the one actually used is permanently UNMEASURED, and re-running to recover the votes re-samples the thing being measured. **A reading the mechanism produces whether or not it works does not satisfy this criterion.** Measured: the deployed filing path takes no votes at all — a regex over the title and set arithmetic over symptom keys, with no clock, model or network — so a variance control over it reports a single distinct outcome set, zero variance, by construction, and the reading that looks most like success is the signature of the failure mode. **Nor does a reading that varies for a reason other than the mechanism under test** — name the mechanism the reading is of, not only the number it produced. Where the flattering reading is available by construction, the criterion names what would distinguish it from the real thing, or declares itself UNMEASURED.
- [x] CRC-B5: Findings that are only **style, diagnostics or cleanup** are dropped.
- [ ] CRC-B6: The filters are **A/B tested** against real PRs before being kept, **with variance bounded**. The reviewer is a sampled instrument, so two verdicts on the same code are two draws; an A/B that does not account for that is comparing noise.
- [x] CRC-B7: Surviving findings are **sorted by severity** and tagged **Important / Nit / Pre-existing**, so a pre-existing bug does not read as the author's fault. (shipped, #1587)
- [ ] CRC-B8: **Every finding is answered** — fixed, or resolved with a stated reason. A finding is never silently dropped and never becomes a tracker item by default.
- [ ] CRC-B9: Review depth is configurable per repo as **Quick / Standard / Deep**.

### Layer 3 — security review

- [ ] CRC-C1: Security review is a separate automated pass.
- [ ] CRC-C2: A PR cannot merge while any bug-review or security-review finding is open.
- [ ] CRC-C3: A false positive clears by closing the thread with a short reason.
- [x] CRC-C4: A finding clears on its own if a later commit fixes it.

### Layer 5 — human approval scaled by risk

- [x] CRC-E1: Risk tiers are written down: low needs no human, medium one, high two. (shipped, #1437)
- [x] CRC-E2: **The change sets the tier, not the author** — a classifier reads the change. (shipped, #1437)
- [ ] CRC-E3: A **second classifier** asks whether this change needs another person even when its tier says no.
- [x] CRC-E4: Owner-listed sensitive paths and **any CI workflow file** always require a human. (shipped, #1437)
- [ ] CRC-E5: Only trusted authors get the lighter paths.
- [ ] CRC-E6: **An agent's approval never counts as a person's.**
- [ ] CRC-E7: Whoever prompted the change counts as one of the required reviewers.
- [ ] CRC-E8: **An approval covers one specific commit**; new commits the system cannot vouch for dismiss it.
- [ ] CRC-E9: Tiers **start strict and loosen with evidence**.

### Layer 6/7 — merge, release, detection

- [ ] CRC-F1: A merge queue re-runs every check against main with the change applied.
- [ ] CRC-F2: New behaviour ships behind a flag, internal users first.
- [ ] CRC-F3: One-step rollback exists and is exercised.
- [ ] CRC-F4: Incident reviews ask **which layer should have caught it**.
- [ ] CRC-F5: Circuit breakers tighten approval when revert/incident rates move. *(the source names this as an admitted gap on their side; we adopt it as a target, not a copy)*

### Measurement — how we know any of this works

- [ ] CRC-M1: **Incidents are an eval.** Past incident-causing PRs, with fix-forwards and reverts, form a case set.
- [ ] CRC-M2: Each case is **expert-confirmed** — a human who knows the code confirms the bug and where it lived.
- [ ] CRC-M3: **Every new incident adds a case.**
- [ ] CRC-M4: Any change to the reviewer's prompts, tools or model is **rescored against the whole set**.
- [ ] CRC-M5: The eval runs **daily**; a change that raises the score is kept, one that does not is dropped.
- [ ] CRC-M6: **Noise is measured by what people do with the comments**, in four buckets: fixed it / said it was wrong / said it was intentional / decided it didn't matter.
- [ ] CRC-M7: A **clean-PR control** counts how often the reviewer reports something that would have led to a harmful change. (exists, `evals/ai-review-control/`)
- [ ] CRC-M8: Priority order is stated and enforced: **catching real bugs first, cutting review rounds second.**
- [ ] CRC-M9: Human-time metrics tracked — approvals per PR (median and p95), human comments, time waiting on a person.
- [ ] CRC-M10: **Revert and incident rates are the guardrail.** If they rise, human time was moved, not saved.
- [x] CRC-M11: Rounds-to-pass is tracked alongside recall. (shipped, #1441/#1448)

### Convergence — the non-convergent review failure

The source's measured failure: one PR ran **more than fifty rounds overnight**; git blame
showed **~59%** of what the reviewer kept flagging was code present at its first pass.

- [x] CRC-N1: **A round cap.** After three rounds the reviewer asks the author to step back and reconsider the approach. (shipped, #1168)
- [ ] CRC-N2: **Diff-only re-review** after the first few passes.
- [ ] CRC-N3: **Flag the class of bug**, so the author fixes every instance rather than one line.
- [ ] CRC-N4: **No repeats** of findings already posted.
- [ ] CRC-N5: Review agents run **nightly over existing code**.

Their result, which is our target: pass-after-one-round 65% → 78%; five-or-more rounds
8.9% → 1.5%; mean reviews to pass 2.08 → 1.32.

### Where we actually stand, measured

The first reading CRC-M11 was able to take, over the 45 most recent pull
requests on 2026-10-23 — 44 measured, 1 refused for carrying no ledger:

| | their before | their after | **us** |
|---|---|---|---|
| passed after one round | 65% | 78% | **39.4%** |
| five or more rounds | 8.9% | 1.5% | **20.5%** |
| mean rounds to pass | 2.08 | 1.32 | **2.64** |

**We are worse than the state they were improving from, on all three.** That
is the number this spec exists to move, and it is the argument for ranking
criteria by rounds-to-pass rather than by how interesting they are to build.

Two things the shape of it says, beyond the headline. The tail is the problem
rather than the median: 20.5% at five rounds or more is over twice their
starting figure while the mean is only a quarter above it, so a minority of
pull requests is absorbing the loop. And eleven of the 44 have not passed at
all, at up to ten rounds spent — excluded from the mean by definition, which
is why this table is reported beside them rather than alone.

The mean is `2.64` and not `1.32` partly for reasons nothing in the review
model controls: #1449 is a harness defect that raises a blocking finding on
**every** pull request editing `.claude/` or `CLAUDE.md`, which in this
repository is how conventions ship. A false finding is a whole round. Re-take
this reading after it lands; a baseline measured across a known artefact is a
baseline that will appear to improve for the wrong reason.

#### The re-take, 2026-10-24 — the baseline has NOT moved

#1449 and #1452 landed at 2026-10-23T21:46Z. Re-read over the 45 most recent
pull requests, **45 measured, 0 unmeasured**, and no ledger truncated, so no
round fell off the front of a window:

| | their before | their after | us, 2026-10-23 | **us, 2026-10-24** |
|---|---|---|---|---|
| passed after one round | 65% | 78% | 39.4% | **44.2%** |
| five or more rounds | 8.9% | 1.5% | 20.5% | **20.0%** |
| mean rounds to pass | 2.08 | 1.32 | 2.64 | **2.65** |

The tail did not collapse. Phases 1 and 2 keep their ordering, and the
argument for it is inherited rather than remade.

##### The split that says the opposite, and why it is wrong

Splitting that population at the moment the fix landed looks decisive, and
reporting it would have been a mistake:

| | pre-fix (31) | post-fix (14) |
|---|---|---|
| passed after one round | 30.0% | **76.9%** |
| five or more rounds | 25.8% | **7.1%** |
| mean rounds to pass | 3.07 | **1.69** |

76.9% against a target of 78% reads as the thing this document said would
invalidate its own plan. **It is an artefact of cohort age.** Rounds
accumulate over a pull request's life, and the two cohorts are not the same
age: pre-fix spans 4.5–9.2h old, post-fix 0.5–4.1h. A younger cohort shows
fewer rounds whether or not anything improved.

Counting rounds inside a fixed window from each pull request's **own**
creation, and including only pull requests that have actually reached that
age, so both cohorts are read at the same point in their own lives:

| window | pre n | pre mean | post n | post mean |
|---|---|---|---|---|
| 1h | 31 | 0.81 | 12 | **1.75** |
| 2h | 31 | 0.84 | 9 | **1.67** |
| 3h | 31 | 1.13 | 5 | 1.00 |
| 4h | 31 | 1.35 | 1 | 1.00 |

At matched age the improvement is **absent**, and at the two windows with a
usable `n` the post-fix cohort is accumulating rounds slightly faster. Read
that direction as noise rather than as harm: `n` is 12 and 9, and the cohorts
differ in what work they carry as well as in when they started. What the rows
will not support is the headline the naive split offers.

The 3h and 4h rows are reported because they exist and are read as nothing:
at `n` of 5 and 1 they are a sample size, not a measurement.

**The lesson is the one this document keeps relearning.** A reading taken
four hours after a fix lands is a reading about the four hours, and *"the
fix has landed"* is not the same precondition as *"the population has turned
over"*. The re-take instruction below asked for the first and meant the
second. Re-take again when the post-fix cohort has reached the age of the
pre-fix one — that is a question about elapsed time, not about what else
ships.

#### 41% of our rounds are rounds in which no review happened

The ledger distinguishes a round that was **read and found nothing**
(`findings: []`) from one that was **NOT MEASURED** (`findings: null` — the
payload was absent or unparseable), and its own comment says they are
different facts. `readLedger` normalises the pair into a `measured` boolean.
Nothing had ever aggregated it. Over the same 45 pull requests, 117 rounds:

| | rounds | share |
|---|---|---|
| a review happened | 69 | 59.0% |
| **UNMEASURED** | **48** | **41.0%** |

18 of 45 pull requests are hit at least once, and **six were never measured
in their entire lives** — at 6, 6, 5, 5, 3 and 1 rounds each.

That matters because **CRC-M11 counts rounds and the 1.32 target counts
reviews**, and those have been the same quantity only by assumption. Scoring
the same 43 passed pull requests both ways:

| | all rounds | measured only | target | their *before* |
|---|---|---|---|---|
| mean to pass | **2.65** | **1.58** | 1.32 | 2.08 |
| passed after one | 44.2% | 62.8% | 78% | 65% |
| five or more | 20.0% | 4.4% | 1.5% | 8.9% |

**So "we are worse than the state they were improving from, on all three" is
an artefact of the unit.** On review rounds we are better than their before
on two of the three — 1.58 against 2.08, 4.4% against 8.9% — and a shade
under it on the third. The sentence above this one stays unedited because it
is true of the number it describes; what is corrected is which number
answers the question.

Both figures are real and they measure different things. **2.65 is the cost
to a developer** — every unmeasured round is still a red required check, a
re-run and a wait. **1.58 is the review convergence** this document's
mechanisms can move. Conflating them points the whole plan at the smaller
half of its own problem.

##### The 48 split cleanly, and the split names the two fixes

| | PRs | rounds | what it is |
|---|---|---|---|
| diff touches `.github/workflows/` | 5 | 25 | **structural decline** — the action refuses to review a workflow against a copy differing from the default branch |
| diff touches no workflow | 13 | 23 | **the no-payload tax** (#1478) — the reviewer runs to completion, exits `success`, writes nothing |

All five workflow-editing pull requests are in the never-measured six, at
100% of their rounds each. That is not a tax, it is a category of change
this repository cannot review at all, absorbing 25 rounds to produce zero
readings.

The other 23 are #1478, and it is not a size or complexity effect: three
observations now span a 9,000-line file, a 250-line four-file diff and a
**single prose-only markdown file**, all exiting `subtype: success`,
`is_error: false`, at 33, 53 and 32 turns against a cap of 80.

**The ordering consequence, stated plainly.** The largest single lever on
2.65 is not any CRC-B or CRC-E criterion. It is the 41% of rounds that
produced no review, and neither half of it is a review-quality problem.
Phases 1 and 2 keep their internal order — the measured-round tail did not
collapse — but nothing in them competes with fixing an instrument that is
silent two rounds in five.

##### How this was measured, and the near-miss that nearly published

`readLedger` and its `measured` flag, not a hand parse. The first attempt
used a hand-rolled `indexOf("```json")` and **silently returned zero rounds
for 17 of 43 pull requests**, under-counting the population by 44 rounds
while reporting a confident 53.4%. It was caught only because its mean
(1.67) disagreed with `summariseRoundsToPass` (2.65) on the same input.

That is this repository's fourth shape — a second decider for a question
that already had one — and it failed open to an empty list that reads as
data. **The ALL-rounds column above reconciles exactly with
`bun evals/ai-review-control/run.ts rounds` on the same file: 2.65, 44.2%,
20.0%.** That agreement is the only reason the measured-only column is
reportable, and a reading of this kind should not be published without it.

### What stays human

- [ ] CRC-H1: Direction, taste and scope — whether to build it at all.
- [ ] CRC-H2: Risky code — billing, auto-updater, CI workflows.
- [ ] CRC-H3: Architecture that sets a pattern others copy.
- [ ] CRC-H4: Reading the evidence. **"If you can't say what the checks would miss, ask for a real review rather than a quick approval."**
- [ ] CRC-H5: Owning the outcome — a person is accountable for every change that ships, whoever typed it.

## What an unticked box means here

Audited criterion by criterion on 2026-10-23, when **0 of 56 were ticked and
0 carried a claiming test**. A spec nothing is bound to cannot drift, because
there is nothing for it to drift from; the number below is what replaces that.

Of the 56: **10 bound**, **8 where a mechanism exists that nothing in this
repository can observe**, **4 that cannot be meaningful in this deployment**,
**2 blocked on an owner decision**, **1 contested**, **2 declared
deviations**, **29 not done**.

Re-counted on 2026-10-23 after #1437 bound CRC-E1, CRC-E2 and CRC-E4, and
again after #1448 bound CRC-M11; re-counted on 2026-10-24 after #1587 bound
CRC-B7, which moved one criterion out of *not done* and no other category. The audit above was taken the same day, at 0
bound; the four moved by engineering, and none of the other four categories
changed, which is the point of keeping them separate.

Re-counted again on 2026-10-24 (#1469): CRC-F1 moved out of *blocked on an
owner decision* into a sixth state, **contested**, which did not exist
before and is not a refinement of the fifth. Nothing was ticked and nothing
was built; one criterion was re-described, because the description it had
was false in a way that cost a repo-wide outage.

An unticked box is one of the last six, and they are six different facts.
Five of them are recorded here because an unticked box nobody can ever tick,
one waiting on a person, one the repository itself argues both sides of, and
one nobody has started all look identical, and only the last is work.

The split is load-bearing rather than tidy: 47 unticked boxes read as 47
pieces of engineering. Seventeen of them are not engineering at all.

### A mechanism exists; this repository cannot observe it

Do not tick these, and do not count them as remaining work either.

| Criterion | What exists | Why no test here can read it |
|---|---|---|
| CRC-C1 | The security review runs as a local Claude Code plugin an agent invokes per session. | It is not repo CI. `.github/workflows/` contains no security pass, so no artefact in this tree records that one ran. |
| CRC-C2 | **The bug-review half holds.** `test` and `ai-review` are required contexts on `main` with `enforce_admins` on, so a blocking finding reds the check and the merge is refused. Read from the API on 2026-10-23. | Branch protection is GitHub state, not tree state. The security-review half does not hold at all — there is no security check to require. **`required_conversation_resolution` is `true`** (read 2026-10-25; this cell said `false` until then), so an open thread DOES block. **The producer has since landed** (2026-10-26): the generated workflow's step `Post this round's findings onto the diff` runs `ai-review-threads`, and #1614 carries four `github-actions`-authored review threads. The security-review half still does not hold, for its own reason — there is no security check to require — so the verdict is unchanged, but it no longer rests on the absent-producer claim. |
| CRC-M2 | `REVIEW_OUTCOME_PLANTS` holds four findings whose outcome was established independently. | Expert confirmation is a human act, and those four grade the outcome sweep rather than an incident case set. |
| CRC-N3 | `REVIEW.md` asks for the class and not the line, and CRC-A6's check proves the reviewer read it. | Whether it complied is a property of a sampled model. No artefact records a finding the reviewer generalised. |
| CRC-H1, CRC-H3, CRC-H4, CRC-H5 | Statements about human judgement. | Nothing distinguishes them being honoured from them being ignored. |
| CRC-N2 | **Adopted in #1600, and it moved here out of *Deliberately not adopted*.** The generated `ai-review-carry` step writes `review_scope=diff` from round 3 when the carry reading is complete, the prompt states both words, and the carried list is declared outside the scope so a prior finding whose file the diff does not touch is still raised. **Adoption was conditional on #1601 and the condition was met in the same change, not waived:** narrowing is only safe while the carry does not silently drop a finding, and until 2026-10-24 it did — the anchor was a line number. `review_scope=diff` is now reachable only when the carry read is complete AND the ledger records no truncation AND the prior rounds are `1..r-1` with no hole; every other reading answers `full`. | **The scope is a WORD, and whether the reviewer confines its reads to it is a BEHAVIOUR.** #1533 measured the reviewer reading whole files rather than the diff. A narrowed round leaves no artefact distinguishing *the reviewer confined its reads* from *the reviewer was asked to and did not* — the step records the request; the reviewer's reads are recorded nowhere. See *Measured non-obvious facts* below. |

### Cannot be meaningful in this deployment

Four criteria that would measure a constant here. They are not debt, and
leaving them in the remainder overstated it — but each says what would make
it meaningful again, because three of the four turn on headcount and the
fourth turns on a setting, and both can change.

| Criterion | Why it is a constant here | What would make it meaningful |
|---|---|---|
| CRC-M9 — human-time metrics | Approvals per pull request is **0 by configuration**, not by behaviour: branch protection declares no `required_pull_request_reviews`. Median and p95 of a constant are the constant. | Requiring any human approval at all. This is a setting, not headcount — see the blocked row below. |
| CRC-E5 — only trusted authors get the lighter paths | One human, one account. Every author is the trusted author, so the partition has one side. | A second author. |
| CRC-E7 — whoever prompted the change counts as a reviewer | The prompter and the only possible reviewer are the same person, so the rule either waives review entirely or does nothing. | A second person. |
| CRC-F2 — new behaviour ships to internal users first | There is one user, and this repository's only consumer of its own scaffold is itself. "Internal first" and "everyone" name the same set. | A second consumer, or an external one. |

### Blocked on an owner decision, not on engineering

Two criteria are satisfiable by **repository configuration** and cost no
engineering. They are listed apart because "nobody has built it" and
"somebody has to decide" are different debts, and the second does not get
smaller by working on it.

Both are also unobservable from inside this tree for the same reason CRC-C2
is — they are GitHub state, not tree state. Binding either of them needs a
check that reads the API, which is a design decision in its own right.

| Criterion | The setting | What it closes |
|---|---|---|
| CRC-C3 — a false positive clears by closing the thread with a reason | `required_conversation_resolution`, **`true` since 2026-10-23** — this row read `currently false` until 2026-10-25 and was stale, while Phase 0 below recorded the setting as applied. | The native mechanism for "a finding blocks merge until it is dispositioned", which is also half of CRC-B8. **It is in force and, since 2026-10-26, it has something to act on:** the generated workflow's `ai-review-threads` step opens a review thread per finding, and #1614 carries four. This cell read "nothing to act on" until then. What is still missing is not a setting and no longer a producer — it is a **reading**: no pull request has yet been observed blocked by an unresolved thread with every other required context green, so the setting's effect is inferred rather than measured. |
| CRC-E8 — an approval covers one specific commit | `required_pull_request_reviews` with `dismiss_stale_reviews`. | Nothing today: with no required reviews there is no approval to carry or dismiss. `gh pr merge --match-head-commit` is a convention agents follow by hand. |

### Contested — this repository gives two opposite instructions

A sixth state, added by #1469, and it is not a shade of the one above.
*Blocked on an owner decision* means nobody has answered yet. **Contested
means the repository has answered twice, in opposite directions, and both
answers are current and deliberate.** An unticked box reads as "not done" in
both cases, and the difference is what an agent does next: a blocked item
waits, and a contested item must not be actioned from either document alone.

That distinction is not bookkeeping. On 2026-10-23 this criterion was read
out of the Phase 0 list above as a setting costing no engineering, and
applied. `PROTECT-1` in `test/scaffold-conformity.test.ts` runs inside the
managed **pre-push hook** and reads the live GitHub API, so it is not a
function of anybody's diff: every session in every worktree was refused the
moment the setting changed, with no commit anywhere to revert. Reverted
about four minutes later; the reading was re-run at 1 pass, 0 fail.

| Criterion | What this spec says | What the tree says | Standing |
|---|---|---|---|
| CRC-F1 — a merge queue re-runs every check against main | Phase 0 names `strict: true` as the cheaper half of a merge queue, costing minutes and no engineering. | `PROTECT-1` (`lib/branch-protection.ts`) **fails on `strict: true`** for a user-owned account, because it serialises every swarm's pull requests — measured at ~2.5 min per PR, 18 open PRs all `BEHIND` and none broken — and merge queues are unavailable on a user-owned repo. | **PROTECT-1 wins.** It is executed on every push by every session; this spec is prose. A rule nothing executes is not a rule, and this one has already been followed into an outage. |

**PROTECT-1 refuses the obvious reverse too, and #1469 removed the reason.**
It declines to *recommend* `strict: false` while any required context does
not run on `push:` to the default branch, because push-CI is then the only
thing catching the semantic conflict — two changes green alone and broken
together. Measured 2026-10-24: `test` and `ai-review` are the required
contexts, and `readPushCi` reported `missing: ["ai-review"]`. #1469 gave the
generated `.github/workflows/ai-review.yml` a `push: branches:` trigger and the same reading
now returns `missing: []`, so the precondition is satisfied and the decision
is unblocked in both directions.

**What that trigger does NOT do, stated here because the tempting reading is
the wrong one.** `ai-review` on a push reviews nothing: the review action
throws `Unsupported event type: push` before it reads anything, exactly as
it does on `merge_group`, so the job annotates UNMEASURED and passes. The
semantic-conflict net PROTECT-1's argument rests on is `test`, which has run
on push since the first scaffold. What changed is that a required context
now REPORTS on push; nothing about main is more reviewed than it was.

So CRC-F1's honest reading is: the *hole* it names is real — with
`strict: false` an armed pull request can merge green against a base it
never ran against — and the remedy it names is one this repository's own
conformity suite refuses. Ticking it would certify a setting the tree
rejects; counting it as remaining engineering would be false too, because
there is nothing to build. The decision is the owner's and the owner now has
both readings. `test/ai-review-push-trigger.test.ts` holds the trigger.

### Deliberately not adopted

| Criterion | Reason in full |
|---|---|
| CRC-M8 — bugs first, rounds second | The deviations table below. The order is inverted here on purpose; the *enforcement* half is unbuilt either way. |

**CRC-N2 left this bucket on 2026-10-24 (#1600).** Its deviation row has been
retired from the table below, because the condition that row named — *"an
adjudicator re-emits unresolved findings"* — fired: the carry step on run
`40137812549` reported `2 finding(s) from earlier rounds are unanswered at
this commit`, a resolved value and not a configuration.

**That evidence was necessary and it was not sufficient, and #1601 is the
reason this paragraph is longer than the sentence above.** Run `40137812549`
proves the carry step emits a number. It does not prove the number is right,
and on 2026-10-24 it was not: the carry compared the recorded anchor against
the recorded LINE NUMBER, so an edit anywhere above a finding re-pointed the
anchor and the finding was classified resolved. Measured live on PR #1597,
where a `high` that was never fixed vanished from rounds 6 and 7 — see
*Measured non-obvious facts* below. **Narrowing the reviewer's scope on top of
that carry would have removed the second chance that was masking it**: under
`scope=full` the reviewer re-reads the branch and can re-find a defect the
carry dropped, and under `scope=diff` a dropped finding in an untouched file
is seen by nothing at all. **That second chance has since been measured and
it is small — 33 drops across the corpus, 2 raised again, 1 of those a clean
instance** (see *Measured non-obvious facts*). The ordering was right and the
quantity behind it is one finding rather than a category, which is worth
knowing before anyone cites this paragraph as though the cost were large. So the condition for adopting CRC-N2 is not *the
carry emits findings* but *the carry does not silently drop them*, and the
first was being read as the second. **#1600 therefore ships the content-
addressed anchor first and the narrowing on top of it**, in that order, and
the row below records both.

The criterion is **adopted and still unticked**, and the reason is unchanged
and independent of #1601: what has been built is a scope WORD, and whether
the reviewer confines its reads to it is UNMEASURED.

**The deviations table is not this bucket, and the difference matters.** It
carries a third row, CRC-B8, whose own text says *"This is the defect, not a
deviation."* A criterion listed there under protest is not a decision to
deviate, so CRC-B8 counts with the remainder below and these two do not.

### Not done — the remainder, with what is there instead

34 criteria, listed because the near-misses are the expensive ones: each has
something in the tree that resembles it and is not it.

- **CRC-A1** `missingEvidenceViolations` requires a runnable command per AC and `gates/workflow.test.ts` enforces it — but only inside a harness ship run, and `ship.mode` is `direct`. Dormant on the lane this project ships on.
- **CRC-A2** Nothing makes a fresh-context subagent review the diff before the PR opens. The generated pre-push hook runs conformity tests, not a review.
- **CRC-A3** `scripts/check-instruction-surface.ts` holds `CLAUDE.md` under a byte budget. Nothing checks it states stack, conventions, goals and non-goals.
- **CRC-A4** **Both halves are now instructed, and the instruction has a subject to be measured against — but no reading, so the box stays open.** The second half always held: `REVIEW.md` names "a line that was true of a previous revision and is now false" as a defect class. #1507 adds the first as its own row — *it does what `CLAUDE.md` or an always-loaded `.claude/rules/*.md` says not to do* — with the instruction the row needs to be actionable, which is to quote the sentence being held against the code and name the file it is in. A convention break nobody can quote is an opinion, and the row says so. **The objection to adding it was checked again rather than inherited** (#1507): `CLAUDE.md` is in `AI_REVIEW_UNTRUSTED_PATHS`, and in the generated workflow the step `Restore untrusted paths from the pull request base` precedes `Run the AI review`, `git rm`-ing each name and taking the base's copy — so a branch cannot legalise its own change by editing the conventions it is measured against. `.claude` is in the same set, which is what extends the clause to the rule files. **Why it is still not ticked**: *flags* is behaviour, and the subject has not been run against the live reviewer. `evals/ai-review-control/subjects/worktree-state-write/` is the plant — a compacted copy of the decision half of `lib/project-state-root.ts` whose new arm lets a linked worktree run the project-state generator, which `CLAUDE.md` forbids (#296), beside a `clean` variant byte-identical outside that arm. Its premise is proved in `test/review-negative-control.test.ts` — the convention is read out of `CLAUDE.md` rather than quoted in the manifest, the permission gap is exactly the linked-worktree row, and the two candidates are asserted to agree line for line everywhere else — and that is a property of the SUBJECT, not of the reviewer. **Promotion condition**: N readings of that directory's planted case, scored through the `score` command of `evals/ai-review-control/run.ts`, with N and the full outcome set stated, because the reviewer is a sampled instrument (#1290, CRC-B3) and one `DETECTED` is one draw. Ticking on the plant's existence is ticking on a mechanism, which is what `CRC-A6` exists to avoid. **Until #1511 that condition was not merely unmet but unreachable**, and this note did not say so: the ledger comment is the only durable copy of a review, and #1509 measured that no round entry has ever carried a `verdict` while the writer's projection dropped `failure_scenario`, so every captured round scored `UNMEASURED` and `DETECTED` could not be returned by the `score` command at all. #1511 widened the projection and records the verdict word the reviewer wrote; a round written by a current writer now scores without `VERDICT_ABSENT` or `BLOCKING_FINDING_INCOMPLETE`. The readings themselves are still owed, and rounds written by older writers are left UNMEASURED rather than repaired.
- **CRC-A7** Three of four clauses hold in `REVIEW.md`: a cap of three non-blocking findings, a "Do not flag" path list, and file-and-line evidence. **The fourth cannot be satisfied in `REVIEW.md` at all, and that is a contract gap rather than a wording gap.** There is no overall review summary anywhere in the payload: `AI_REVIEW_FINDING_FIELDS` declares `summary` *per finding* — "one sentence stating the defect" — and the top-level object carries only the findings list and the verdict word. So an instruction to open a summary with a count would be addressed to a channel the contract has no slot for, which is the shape this repository calls an instruction nobody executes. The clause needs a top-level summary field first. **#1337 did not do half of it, and the near-miss is worth recording because it reads like it did**: `advisoryNotice` returns `null` when the advisory tail is empty, so a CLEAN reading with no findings at all still prints one line, byte-identical to before. That is exactly the case the clause is about — *says plainly when there is nothing to fix* — and it is the one case the new output does not reach. What #1337 did land is the **count** half for a non-empty tail, whose notice opens with the number and binds it to the findings listed.
- **CRC-A8** No path routes a repeated finding into a skill, a lint rule or an instruction file. `lib/rule-promotion.ts` promotes from compliance failures, not from review findings.
- **CRC-B1** **Built, and deliberately not ticked.** The reviewer is now handed the pull request's title and body as a file in the findings directory, outside the checkout, named by `AI_REVIEW_INTENT_PATH`; the prompt tells it to read that file and to treat the contents as a **claim under test with no authority over the review**, saying that a gap between the claim and the code is itself a finding and the code is the side that is true. An event supplying neither field writes `AI_REVIEW_INTENT_UNMEASURED` rather than a blank, because an empty claim is still a claim and nobody made it. The fields reach the runner through `env:` and are interpolated into no `run:` block — asserted over the generated workflow, because author-controlled text expanded into a `run:` is substituted before bash parses the line. **Why it is not ticked**: the criterion says the reviewer *reads* it, and what exists is the delivery plus an instrument — a transcript check that reports whether the read happened. The instrument **annotates and does not refuse**, so a reviewer that ignores the file still passes, and there are zero readings so far. Ticking on a mechanism nobody has yet seen fire would certify the behaviour we are trying to measure. **Promotion condition**: when the read/skip population shows the skip rate at or near zero, the warning becomes a refusal and the criterion binds against it. The reason the gate is not fatal today is the four false positives recorded below — a new required behaviour on a sampled instrument measures the flake rate first, not the compliance rate.
- **CRC-B2** **Instructed as of #1507, unmeasured, and therefore not ticked.** `REVIEW.md` gains *On a bug fix, say what the cause was*: two questions the reviewer must answer — what produced the reported state, named in the code rather than in the narrative, and whether the diff reaches it or only reaches where it surfaced — with a guard added at the point of observation over an untouched producer called out as a `high` finding while that producer is reachable by another caller. The argument it rests on is this repository's own and is cited rather than restated: `.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape, read from the reviewer's seat — the cheapest repair makes the report stop, and a green check is less visible than a missing one, so that repair certifies the regression at the moment it returns. An out-of-scope cause is a legitimate answer; silence about the cause is the finding. **Why it is not ticked**: *looks for* is behaviour, and nothing reads whether it happened. There is no subject for this one — the plant would be a pull request whose diff treats a symptom, which is a different shape from the single-file subjects `evals/ai-review-control/` stages today, and `CRC-M1` is the entry that carries the case-set gap. Until a reading exists this is an instruction with no compliance reading, which is what `CRC-A6` names.
- **CRC-B3** One reviewer agent per round. **Not adoptable before CRC-B4, and the criterion now says why**: N generators over a sampled instrument are N draws, and run `39962683401` is a same-tree pair that disagreed BLOCKED/CLEAN with a false positive on the blocking side. Without a quorum to filter them, parallel generation multiplies exactly that. Ordering, not absence of effort.
- **CRC-B4** **Half, and the half that is missing is the one the criterion is named for.** Before #1476 this read "nothing deployed takes a vote", and that was accurate: `lib/finding-jury.ts` held the group size, the quorum, per-verifier votes and a disagreement flag, and `arbitrate` — the only path reading them — had no caller outside `lib/`, `test/` and `scripts/arbitrate-finding.ts`. #1476 adds `lib/ai-review-jury.ts`, which the deployed adjudicator wrapper injects: it is handed only the findings that would otherwise **BLOCK**, reads a ballot directory with one file per verifier, and writes **every verifier's individual vote, the agreement count and the disagreement flag** to the finding ledger at decision time, with a `null` reading and a named refusal for a group that could not be convened. **A finding the group votes down still blocks.** The vote is recorded and subtracts nothing — `JG-6b` asserts the adjudicator's exit code and first line are byte-identical with and without a ballot — so the clause *"surfaced only if enough agree it is real"* is **not satisfied**, and it is not satisfied by choice rather than by omission. Two prerequisites, both structural and neither a wording change: **(1) real independence.** `AI_REVIEW_DENY_RULES` denies `Task` and `AI_REVIEW_ALLOWED_TOOLS` is `[Read, Grep, Glob, Write]`, so one review-action invocation cannot convene three verifiers — a ballot it wrote is a quorum of one wearing `VERIFIER_GROUP_SIZE` names, which is this criterion's own named counterfeit arriving by a different route than the constant `agree`. It needs `VERIFIER_GROUP_SIZE` separate action invocations, each with its **own** writable directory; the single findings directory will not do, because widening `AI_REVIEW_WORKSPACE_WRITE_DENY` is documented at the constant as the cheapest wrong fix. **(2) a base-ref read.** The review runs on the head checkout, so a ballot able to demote a finding is a gate whose input the branch under review can write. Until both land, a quorum that subtracts is a worse instrument than no quorum. What the ledger rows buy meanwhile is the population CRC-B6 needs: votes recorded against real findings, under the real severity split, with the demotion switched off — so the A/B is computable later without re-running the sample.
- **CRC-B6** `compareReviewOutcomes` and `evals/ai-review-control/variance-capture.ts` exist. No filter has been A/B tested before being kept, and the variance control reads zero by construction — see below.
- **CRC-B8** Half, and a different half since #1337. The advisory tail is no longer discarded — `advisoryNotice` names every counted non-blocking finding, with a key, in an annotation that says each is UNANSWERED. What is still missing is the requirement: nothing obliges anyone to answer one, so "fixed, or resolved with a stated reason" remains a request. A duplicate or a dropped-category filing is refused at the chokepoint; ALLOW is still the default for a novel finding.
- **CRC-B9** No per-repo review depth. `ceremonyTier` LIGHT / STANDARD / THOROUGH is the harness gate ceremony, a different axis.
- **CRC-E3, CRC-E9** `lib/risk-tier.ts` now exists, so these two have something to second-guess and something to loosen — which is why they were sequenced after #1437 rather than built with it. `E3` needs a second classifier that can raise a LOW the first one is content with; `E9` needs a recorded outcome per tier to loosen against, and the ledger does not carry a tier yet. `LOW_MAX_FILES` and `LOW_MAX_LINES` are therefore declared strict and not evidence-based, and that is stated at the constants rather than left to be discovered.
- **CRC-E6** Branch protection declares no required reviews, so no approval counts toward anything and the criterion is vacuous rather than satisfied.
- **CRC-F3** No one-step rollback, and none exercised.
- **CRC-F4** No incident review asks which layer should have caught it.
- **CRC-F5** No circuit breaker. The source admits this as a gap on their side too.
- **CRC-M1** Two subject directories since #1507, holding two authored plants of different kinds — a behavioural defect and a convention break — and three clean variants. Still not a case set drawn from past incident-causing pull requests, and every subject is a single file, so a criterion whose defect is a property of a whole pull request (`CRC-B2`'s symptom-only fix) has no shape to be staged in.
- **CRC-M3** Nothing adds a case when an incident happens.
- **CRC-M4** Nothing rescores the whole set when the reviewer's prompt, tools or model change.
- **CRC-M5** No schedule runs the eval. The only crons in the tree are `.github/workflows/issue-audit.yml` daily and `.github/workflows/action-pins.yml` weekly.
- **CRC-M6** One bucket of four is derived from evidence. The other three report UNMEASURED unless hand-declared, and `noiseRate` is `null`.
- **CRC-M7** The control exists and counts `FIRED` on clean subjects. The criterion's own number — findings that *would have led to a harmful change* — is declared UNMEASURED by the control's README, because a finding carries no remedy anything can apply. A tripwire in `test/review-negative-control.test.ts` reds the day the contract grows one.
- **CRC-M10** Nothing tracks revert or incident rates.
- **CRC-N4** **Half of it shipped in #1381 and the half the criterion is named for did not.** The walker exists: the generated `ai-review-carry` step reads the ledger, searches each prior finding's file for the recorded anchor TEXT at this commit (#1601 — it compared the text at the recorded LINE NUMBER until 2026-10-24, and an edit anywhere above a finding dropped it as resolved), and hands the reviewer the unresolved set under one of three readings that may not collapse — `AI_REVIEW_CARRY_READ`, `AI_REVIEW_CARRY_ABSENT`, `AI_REVIEW_CARRY_UNMEASURED`. It restates `readLedger → priorFindings → carryForward` in bash and is bound to the library over one matrix by `test/ai-review-carry-forward.test.ts`, because `lib/scaffold/ai-review-step.ts` may not import: the step is deliberately import-free so that the 27 suites copying it into a temp directory can build mutants that load. What remained was **suppression**, and #1586 built it: `lib/ai-review-suppression.ts` turns the carry step's state file and a ledger snapshot into the prior key set, and `scripts/ai-review-findings.ts` hands the adjudicator a gate over it. Three things keep this criterion unticked. **It is dormant** — the generated job runs `bunx rungate@<pinned>`, so this reaches CI only when the pin moves, and a tick is read as *running*. **It is advisory-only by declared deviation** — a blocking repeat is re-reported and still blocks; see the deviations table. **The key symmetry is new** — before #1586 the adjudicator formed `n:<line>` keys and the ledger held `t:<text>` keys, so a dedupe built on it would have matched nothing while reporting cleanly; `lineTextFor` reads the checkout and `test/ai-review-suppression.test.ts` AS-5 is the control that holds it.
- **CRC-N5** Nothing runs review agents nightly over existing code.
- **CRC-H2** Risky code requires a human. There is no `CODEOWNERS` and no required approval, so nothing does.

### Shipped since this audit was taken

A criterion the audit counted as remaining and that no longer is. Kept as a
section rather than deleted: the analysis is the record of what the item cost
and why the shape it shipped in is the right one, and the six states above are
states of an UNTICKED box, so a ticked one belongs in none of them.

- **CRC-B7** — **shipped in #1587**, and the analysis below is kept as the record of what it cost rather than as a statement about the tree. What changed: `Severity` and `SEVERITY_RANK` are now declared in `lib/scaffold/ai-review-step.ts`, the contract module the deployed reader already imports and the only one the mutation batteries can carry, and `lib/finding-jury.ts` re-exports them — **one declaration, no third vocabulary**. `AI_REVIEW_SEVERITIES` was NOT merged into it, because the two must disagree for both to be right: a `critical` naming a file the pull request does not touch blocks under the severity table (magnitude is a property of the defect) and tags `Pre-existing` under this one (attribution is a property of the diff), and folding them would require the reviewer to write `Pre-existing` itself when it is deliberately never given the file list. `findingPathScope` is the single binding both the demotion and the tag read, `tagOrder` is the single comparator, and the tag is applied to the advisory tail as well as the blocking set — the demotion never looked at an `info`, and an `info` about code on `main` is misattributed exactly as badly as a `critical` is. Three clauses, and they have three different costs — reading it as one item is what made it look cheap. **Sorting** is now possible and was not before #1337: there is a rendered tail to put in an order, and `advisoryNotice` and `renderCountedFindings` both emit in payload order, which is whatever order the model wrote. **The vocabulary** does not exist in the deployed path: `SEVERITY_RANK` tags Important / Nit / Pre-existing in `lib/finding-jury.ts`, which the CI path never calls — its callers are `scripts/arbitrate-finding.ts`, `lib/issue-filing-gate.ts`, `lib/finding-arbiter.ts` and `lib/ai-review-jury.ts`; this list read `lib/failure-intake.ts` and `hooks/VerifyPhaseLock.hook.ts` until #1587 measured it, and NEITHER of those imports the module, directly or transitively (found by this repository's own reviewer on #1590) — while the deployed table, `AI_REVIEW_SEVERITIES`, declares `critical`, `high`, `medium`, `low` and `info`. **Pre-existing** is not decidable there at all: `severityOf` decides it from the pull request's changed files and the findings step has no changed-path list to scope against. **The prerequisite is #1204/#1354, not #1337**, because that is the change carrying the changed-path list into this module; until it lands the criterion cannot be ticked on the first two clauses alone. A weaker route to the third exists and is worth knowing before anyone plumbs the diff: `advisoryKey` (named `findingKey` before #1398) identifies a finding by file and summary rather than by line, so the same observation has one identity across rounds and *first seen on round 1* becomes decidable from the accumulated ledger with no diff at all. That is a different and smaller claim than `severityOf`'s — first-seen-round, not present-before-the-pull-request — and it should be labelled as the one it is rather than sold as `Pre-existing`. **One trap for whoever sorts**: `renderFinding` prints `finding <index>`, and the blocking annotation and the advisory notice now share that numbering, so a sort must reorder the display and keep the payload index in the label. A case in `test/ai-review-advisory-findings.test.ts` asserts the tail is indexed against the whole payload and reds on renumbering.

## The order to build the remainder in

Written 2026-10-23 because the work had been running without one, and
criteria were being picked by whichever looked tractable. That produces the
failure this section exists to stop: an agent spends a session discovering
that the criterion it chose is blocked behind one nobody has scheduled, and
writes the discovery down instead of the code.

**The backlog is 30, not 47.** Of the unticked boxes, 8 are mechanisms this
tree cannot observe, 4 cannot be meaningful in this deployment, 2 are
declared deviations, and 3 are repository settings. Only the remainder is
engineering, and the four categories above are not a smaller version of it —
they are a different kind of fact, and the tables above say which is which.

Phases are ordered by **effect on rounds-to-pass**, which the table in *Where
we actually stand, measured* says is 2.64 against the source's 1.32. Within a
phase the criteria are independent and may be built in parallel. Across
phases they are not: each phase names what the next one needs.

### Phase 0 — three settings, no engineering

**CRC-C3 is APPLIED as of 2026-10-23.** `required_conversation_resolution` is
`true` on `main`, set through a full `PUT` that preserved the two required
contexts, `enforce_admins`, and every other field unchanged. It stays
**unticked** because the setting is GitHub state and no check in this tree
reads it — which is the distinction the table above exists to keep, and the
reason "applied" and "bound" are recorded separately.

**CRC-E8 does not belong in this phase and is moved to the table above it.**
With one account and `enforce_admins: true`, requiring an approving review
deadlocks the repository: the only possible approver is the author, so
nothing merges at all, including every agent's pull request. That is the
same "needs a second person" constraint CRC-E5 and CRC-E7 carry, and it is a
hard stop rather than a cost. It was listed here in the plan's first draft
and that was wrong.

So Phase 0 is **one setting applied, one CONTESTED, one withdrawn**:

CRC-F1 (`strict: true`), CRC-C3 (`required_conversation_resolution`), CRC-E8
(`required_pull_request_reviews` with `dismiss_stale_reviews`). Minutes, by
the owner. They are first because two further criteria — CRC-E6 and CRC-M9 —
are **vacuous rather than unbuilt** until they land: there is no approval to
count, so nothing can be built that counts one.

**DO NOT ACT ON CRC-F1 FROM THIS LIST. Read its row in *Contested* above
first (#1469).** `PROTECT-1` in `test/scaffold-conformity.test.ts` fails on
`strict: true` by design, it runs inside the managed pre-push hook, and it
reads the live GitHub API rather than the diff — so setting it refuses every
session's push in every worktree, repo-wide, with no commit anywhere to
revert. That is not a prediction: it happened on 2026-10-23, read out of
this paragraph in its previous form, and was reverted about four minutes
later. The paragraph said "minutes, by the owner" and it was right about the
duration and wrong about everything else.

The cost argument below is the one this plan originally made, and it stands
as a cost argument. It is not the binding objection; the binding objection
is a check in this tree that refuses the setting outright.

**If the setting is flipped anyway, the trigger is a number, not a judgement
call: open pull requests ≤ 2, with no agent mid-push.** Under `strict`,
every merge stales every other open pull request, and the repair is
`gh pr update-branch`, which **force-rewrites the contributor's branch** —
including one an agent is pushing to. On 2026-10-23 this repository merged
eleven pull requests with four sessions running; flipping it in that state
converts each merge into five forced rewrites. The hole it closes is real
(an armed PR merging green against a base it never ran against) and it is
not urgent enough to pay that. If it is ever flipped, watch rounds-to-pass:
if `strict` costs more rounds than the stale-base hole does, that is
measurable and the criterion should say so.

**The other direction is now open, which is what #1469 changed.** PROTECT-1
also refused to *recommend* `strict: false` while a required context was
absent from `push:` to the default branch. `ai-review` was that context;
it now carries the trigger, `readPushCi` reports nothing missing, and the
`strict: false` recommendation is available for the first time. The trigger
is not itself a review of main — see the Contested row.

### Phase 1 — stop the repeats

**The tail is the problem, not the median.** 20.5% of pull requests take five
rounds or more, against their 8.9% before; the mean is only a quarter above
theirs. A minority of PRs is absorbing the loop, and a finding re-posted
every round is, arithmetically, an extra round.

| | Depends on |
|---|---|
| **CRC-N4** — no repeats | **a release.** #1586 gave the dedupe its production caller — `lib/ai-review-suppression.ts`, bound in `scripts/ai-review-findings.ts` — so the machinery is no longer uncalled in the source. It is still uncalled in CI: the generated job runs `bunx rungate@<pinned>`, so `lib/` and `scripts/` changes are dormant until the pin moves. The checkbox stays unticked until then, because a tick is read as *running* and the merge does not earn it. |
| **CRC-B7** — Pre-existing tagging | *(cleared, #1587)* #1204 closed, #1354 merged and 0.8.3 shipped, so the changed-file list reaches the adjudicator |
| **CRC-N2** — diff-only re-review | *(no longer a deviation, #1600)* **an observation, not a merge and not a release.** The decision is in the generated `.github/workflows/ai-review.yml` rather than in `lib/`, so unlike CRC-N4 it is live the moment the workflow lands — no pin has to move. **The same sentence is why #1601's anchor fix is not on this list**: it is a change to the same generated bash, so it lands with the narrowing rather than after it, and the ordering concern — narrowing on top of a carry that drops findings — does not survive the merge. The library halves in `lib/ai-review-rounds.ts` ARE dormant until the pin moves; they are the binding the generated step is held to, not the decider CI runs. What this criterion is waiting for is the reading in *Measured non-obvious facts* below: a real narrowed round on which the reviewer's reads can be shown to have been confined. Until then the scope is a request, and the checkbox stays unticked because a tick is read as *working*. |

CRC-N4 is the single highest-value item in this document and it is not a
design problem. Its own entry says the gap is structural: the only non-test
file naming the module mentions it in prose.

### Phase 2 — stop the false findings

The other half of the tail. A false blocking finding costs a remedy commit, a
CI round and a review round, and run `39962683401` is the measured instance —
a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the
blocking side.

| | Depends on |
|---|---|
| **CRC-B4** — verifier quorum | the *recording* half is deployed (#1476): per-verifier votes and the disagreement flag reach the ledger for every blocking finding. The *deciding* half depends on `VERIFIER_GROUP_SIZE` separate review-action invocations with per-verifier writable directories, and on reading the base ref rather than the head checkout |
| **CRC-B6** — A/B the filters | CRC-B4's recorded votes — which now accumulate — and a variance control that does not read zero by construction |
| **CRC-B3** — parallel generation | CRC-B4, strictly. Without a quorum, N generators are N chances to block falsely, which is **worse than one** |

### Phase 3 — what the reviewer is told

> **Reordered for one objective.** For the swarm track declared below, Phase 4
> runs before this phase. The reason and its limits are in *The swarm track*;
> for the rounds-to-pass objective this phase stays third.

Cheap, mostly prompt and `REVIEW.md` text, and independent of Phases 1 and 2.
Sequenced third rather than first because a reviewer given more context and
no falsification step produces more confident false premises — so Phase 2
earns the right to do this one.

CRC-A4 (flag a `CLAUDE.md` convention break — the obvious objection does not
apply, see its entry), CRC-B2 (root cause on a bug fix), CRC-B9 (per-repo
Quick/Standard/Deep), CRC-A7 (the summary clause).

**#1507 did the text half of CRC-A4 and CRC-B2 and ticked neither.** Both
clauses are in `REVIEW.md` and CRC-A4 now has a planted subject to be
measured against. What is missing in both cases is a reading of the live
reviewer, and what remains of this phase is CRC-B9 and CRC-A7, which need the
file this phase's other two did not: see each entry for why.

### Phase 4 — findings get answered, and repeats get fixed at the source

> **Reordered for one objective.** For the swarm track declared below this
> phase runs before Phase 3, and only **CRC-B8** of it is the swarm's need —
> CRC-A2 is unrelated. See *The swarm track*.

CRC-B8 (every finding answered — CRC-C3 from Phase 0 is half of it), CRC-A8
(a repeated finding becomes a rule or a lint, not another finding), CRC-A2
(a fresh-context review before the PR opens), CRC-A1, CRC-A3.

### Phase 5 — the instruments

CRC-M6 (four outcome buckets; one of four is evidence-derived today),
CRC-M10 (revert and incident rates), CRC-M1/M3/M4/M5 (an incident case set
and a daily rescore), CRC-M7 (a finding carries no remedy, so the control's
own number is UNMEASURED), CRC-E3 and CRC-E9 (a second classifier, and a
ledger that carries a tier to loosen against).

### Phase 6 — release and detection

CRC-F3, CRC-F4, CRC-F5, CRC-N5, CRC-H2. Last because none of them moves
rounds-to-pass, and CRC-F5 is a gap the source admits on its own side.

### Exit conditions — what must be OBSERVED before the next phase starts

Added 2026-10-26. The phases above order the work and say what each one needs
from the last. They do not say when one is **done**, and without that the
honest reading of progress is a checkbox count — which is the wrong
instrument twice over.

**A tick means a criterion is bound, not that the phase moved the number.**
`scripts/sync-sc-status.ts` ticks a box when a test names the id, and
`.claude/rules/claiming-sc-coverage.md` is deliberate about that being a
declaration of intent. So a phase can reach 100% ticked while rounds-to-pass
sits where it was: every mechanism present, bound, and not yet making a
difference to the thing this document exists to move.

So each phase below exits on an **observation taken on a real pull request**,
not on a count and not on a unit test. One per phase, falsifiable, and
stated so a reader can be wrong about it — which is the lesson *The thing
that would make this plan wrong* records below, where a precondition that
read "the fix has merged" was checkable and was the wrong thing to check.

**Every row below states a negative control**, because the first draft of
this table did not and an audit found six rows satisfiable by something that
never happened. Each row therefore names the state that must NOT read as a
pass. A row without one is the defect this section exists to prevent,
arriving inside the section.

| Phase | Exits when this is observed | The state that must NOT read as a pass |
|---|---|---|
| **0** settings | Every OTHER required context is green — `test` and `ai-review` both `SUCCESS` — and the pull request is still held, then goes mergeable when **only** the thread is resolved | `BLOCKED` while any other required check is failing or pending. That reading is **overdetermined** and attributes nothing. See the swarm track below, where this spec made exactly that error |
| **1** stop the repeats | Round two posts **at least one NEW thread** for a different finding, **and zero** for the finding already threaded on round one | round two posting **nothing at all** — which an absent payload, a fork's read-only token or CRC-N2's narrowing all produce. Zero threads is not a deduplication, and without the new thread there is no proof the poster was even live |
| **1** (the number) | On **measured rounds only**: five-or-more below **4.4%** and mean-to-pass below **1.58** | using the ALL-rounds figures (20.0%, 2.65). Those are dominated by the 41% of rounds that produce no review, which Phase 1 does not touch — the spec says conflating the units "points the whole plan at the smaller half of its own problem" |
| **2** stop the false findings | A finding **known to be false** is voted down and **no thread is opened for it** | a zero thread-count produced by anything other than the vote. **Today that is the only thing it can be** — see the ordering defect below |
| **3** what the reviewer is told | **N readings** of the planted subject, N and the full outcome set both stated | a single `DETECTED`. CRC-A4's own promotion condition forbids it: the reviewer is sampled, one reading is one draw. The first draft of this row asked for one reading and contradicted that rule, which is in the document twice and was still worth re-deriving |
| **4** findings get answered | A pull request that **had at least one open thread**, all of them resolved, no resolving actor a person, then mergeable | a pull request with **no threads at all**. It satisfies every clause vacuously and is precisely the always-empty population this spec was written about |
| **5** instruments | Each of CRC-M6's four buckets non-zero, each traced to a **human-authored** disposition | a bucket incremented by `lib/signal-phrases.ts` matching agent boilerplate. "by design" in a generated comment is not a disposition |
| **6** release and detection | — none of these moves rounds-to-pass; they exit on their own criteria | |

#### Work in flight

Which pull requests are serving this spec right now, and which criteria each
one is pointed at. **This is the cross-reference in the spec→code direction**:
open the spec, read this table, and you have the open branches. The reverse
direction is the PR body, which must name the criteria it serves.

**No branch column.** A branch name is deleted when the pull request merges,
so a column of them is a column of citations that rot on the one event this
table is meant to survive. The number is the durable identifier and it
resolves to the branch in one click.

**Naming a criterion here is not ticking it.** A row says what a branch is
aimed at, which is a statement of intent and nothing more — the box is ticked
by `scripts/sync-sc-status.ts` when a test claims the id, and a phase is
called done only in *Readings taken* below, on an observation. Three different
claims, deliberately kept in three places, and the reason is in that section.

| PR | Phase / increment | Criteria it is pointed at | State |
|---|---|---|---|
| #1614 | prerequisite — the reviewer has to run on a pull request at all before any phase can be read off one | CRC-F2, CRC-N1 | open; carries `ai-review-override`, so it merges by hand |
| #1617 | records Phase 0's exit, and this table | CRC-C2, CRC-C3, CRC-B8 | open |
| — | Increment 1 — the suppression gate and carry-forward read the review-thread endpoint and GraphQL `isResolved`, and the ledger comment goes | CRC-N4, CRC-B5 | not started; **Phase 1 depends on it** |
| — | Increment 2 — a verifier invocation writes a ballot, three invocations with per-verifier directories | CRC-B4, CRC-B3 | blocked on the ordering defect below |

**A row with no pull request is work this spec says is next and nobody has
claimed.** That is the state worth seeing, and it is the one a tracker of
merged work cannot show: `bun bin/rungate.ts audit-specs` reports 46 of this
spec's 56 criteria unmatched and has no way to say which of them anybody is
moving. Every row here, with or without a number, names criteria from the list
below, and `test/code-review-convergence-spec.test.ts` fails on an id this
spec does not declare — so a row cannot point at a criterion that does not
exist, which is the cheapest way for a traceability table to go quietly wrong.

**When a pull request merges, its row moves to *Readings taken* or is
deleted.** A merged branch sitting here is the same defect as a stale
citation: it reads as current work and is not.

#### Readings taken

*Exit conditions* says what to observe and *Work in flight* says who is going
to observe it. This table says what WAS observed, and it is the only place a
phase may be called done.

**Why it is a second table and not a column.** `bun bin/rungate.ts
audit-specs` already reports this spec's criteria — 10 ticked of 56 at the
time of writing — and `scripts/sync-sc-status.ts` maintains that automatically.
It is a real tracker and it is not this one: it reports whether a criterion is
**bound by a test**, and a phase exit is an **observation on a live pull
request** that no unit test can name. Both are needed and conflating them is
the error the section above this one exists to prevent.

An `EXITED` row must carry a pull request, the head it was read at, the
criteria the reading feeds, and the observation.
`test/code-review-convergence-spec.test.ts` enforces all four: a row claiming
`EXITED` without them fails the suite, which is what stops this table becoming
a place to assert progress. The criteria column is the **PR→spec** direction
of the cross-reference — given a merged branch, which part of this document it
moved.

| Phase | Verdict | PR | Head | Criteria evidenced | What was observed |
|---|---|---|---|---|---|
| **0** | EXITED 2026-10-26 | #1616 | `7ea82e5075e958ba6739d1f428c0dc195da2812c` | CRC-C2, CRC-C3, CRC-B8, CRC-N4 | Both required contexts SUCCESS — the required set is exactly `test` and `ai-review` (`gh api …/branches/main/protection/required_status_checks`), and all nine check-runs at that head were `success` — with `mergeable: MERGEABLE` and `mergeStateStatus: BLOCKED` on two unresolved review threads. Resolving only those two threads — same head, no push, no re-run — flipped it to `CLEAN`. The block is therefore attributable to the threads and to nothing else. A second draw was recorded by #1617 on #1614 at `471a5b507e3d7d15bf4cd8de760d855b3652f7f6` and is **WITHDRAWN as a draw**, because its two halves cannot both be true. It said all check-runs were `success` and that resolving the one thread moved `BLOCKED` to `UNSTABLE` — but `UNSTABLE` is produced by a non-successful status or check, so an all-`success` head has nothing left to produce it. Re-reading at that SHA today confirms ten check-runs, all `success`, and the classic status endpoint empty, which reconciles nothing: #1614 merged at `5449750b`, so the post-resolution half cannot be re-taken at all. Whoever recorded it is not available to say which half was mistyped, and a reading nobody can reproduce is UNMEASURED, not weak. It is kept here named rather than deleted so the next reader does not re-derive the contradiction. **A second draw that CAN be reproduced was taken on #1622** at `023145d7b7992e2cfbc3f1463305d6ef014ef4aa` on 2026-10-27 at 01:58Z: ten check-runs all `success`, `MERGEABLE`, one unresolved thread, `BLOCKED` — and `CLEAN` on resolving that one thread, same head, no push and no re-run. One thread rather than two, and both halves minutes apart on one SHA, which makes it the cleanest of the set. *The swarm track, and the reorder it asks for* carries the full reading |
| **1** | PENDING | — | — | — | — |
| **2** | UNMEASURED — unreachable, see below | — | — | — | — |
| **3** | PENDING | — | — | — | — |
| **4** | PENDING | — | — | — | — |
| **5** | PENDING | — | — | — | — |
| **6** | PENDING | — | — | — | — |

**Four criteria named, none of them ticked, and that is the point.** CRC-C2
(*a pull request cannot merge while a finding is open*), CRC-C3 (*a false
positive clears by closing the thread with a reason*) and CRC-B8 (*every
finding gets answered*) were each exercised twice on 2026-10-26 and a third
time on #1622 on 2026-10-27, whose round 5 finding was stale rather than wrong
about the code and cleared by closing the thread with that reason — and three
is three draws, not a population. CRC-N4's reading is the 13-threads-for-3-findings
count below. Ticking any of them on this evidence is the error CRC-A4's own
promotion condition exists to prevent, so the column records what the reading
feeds and the boxes stay open.

**What Phase 0's reading cost, and why it was nearly missed.** It was taken on
a pull request opened for something else, and the first attempt at this same
claim was wrong in the way this document keeps being wrong: the swarm track
originally cited #1614 as the evidence, and #1614's `BLOCKED` was
**overdetermined** — `ai-review` was `FAILURE` there at the same time, so the
threads were not shown to be doing any of the blocking. Two pull requests, the
same status word, and only one of them says anything.

**A second reading worth more than the first, recorded here because nothing
else would hold it.** #1616 accumulated **13 review threads carrying 3
distinct findings** — a stale frontmatter date (×5), a dangling self-reference
to a superseded draft (×3), and a stale threshold in the pull request body
(×2 across two rounds), plus carried repeats. The reviewer re-raised the same
findings across four rounds while the surrounding text moved, so the line
numbers changed and the carry-forward could not tell they were the same
finding. **That is CRC-N4 measured on the pull request that defines CRC-N4's
exit condition**, and it is the strongest evidence in this document for doing
Phase 1 before anything else.

**Phase 2 cannot currently be satisfied, and that is a finding about the
pipeline rather than about this table.** In the generated workflow the step
`Post this round's findings onto the diff` runs `ai-review-threads`, and the
adjudicator that consults the ballot runs `ai-review-findings` in a **later**
step. The threads are already posted by the time any vote is read, and
CRC-B4's own entry records that a voted-down finding still blocks. So a
quorum, as currently ordered, can never prevent a thread. **Phase 2 has a
prerequisite nobody had written down: the vote must be read before the post,
or the posting step must read the ballot itself.** Until that lands, the
Phase 2 row is unreachable and should be reported UNMEASURED rather than
pending.

**Phase 1's second half is the one that will be skipped.** Counting threads
on one pull request is cheap and will be done; re-taking CRC-M11 costs a
population and will not be, unless it is written here as a gate. The
mechanism being present is not the claim this phase makes. The claim is that
the tail moved.

Two things make that re-take valid, and both have already gone wrong once in
this document. **Control the age** — the 2026-10-24 reading records a naive
cohort comparison reporting a 47-point improvement that vanished entirely
when both cohorts were read at the same age. And **reconcile the parse**: the
reading counts only if it agrees with
`bun evals/ai-review-control/run.ts rounds` on the same file, because the
first attempt at this measurement used a second hand-rolled parser, silently
returned zero rounds for 17 of 43 pull requests, and was caught only by that
disagreement.

**None of these phases is the largest lever, and the table must not be read
as claiming otherwise.** This spec already measures that the biggest single
contributor to 2.65 is the 41% of rounds producing no review at all —
the structural decline on workflow-editing diffs, and the no-payload tax of
#1478. Neither is a review-quality problem and neither is in Phases 1–5.

### The swarm track, and the reorder it asks for

Declared 2026-10-26, as a decision with a reason rather than a reordering
nobody can see — this document exists because work was being "picked by
whichever looked tractable".

The phases above are ordered by **effect on rounds-to-pass**. That is the
right order for this repository's review loop and it is not the order for a
second objective the owner has stated: **running many agents against a
product backlog with no human in the per-pull-request loop.**

Swarm-readiness needs **three** of the phases, and they are necessary
together:

- **Phase 2**, because findings must be mostly right. CRC-B3 already states
  that N generators without a quorum are *strictly worse than one* — N
  chances to block falsely. At a swarm's width that is not a slower loop, it
  is a stalled one.
- **Phase 4**, specifically **CRC-B8**, because findings must get **answered
  without a person**. Phase 4 carries more than CRC-B8 and the rest is not
  the swarm's need — CRC-A2, a fresh-context review before the pull request
  opens, is unrelated to whether a thread gets answered. Name B8, not the
  phase.
- **Phase 1**, because an answer has to *stick*. This is the one the first
  draft of this section omitted, and the omission was load-bearing. CRC-N4
  is "a finding re-posted every round": under
  `required_conversation_resolution` a repeat opens a **new** thread, so an
  agent that resolves every thread on round *n* faces a fresh unresolved one
  on round *n+1* and the merge re-blocks on each push. Resolution that does
  not stick is the same stall this section attributes to CRC-B8's absence,
  arriving by a different route.

Twenty agents, twenty pull requests, three threads each, and nobody to
resolve them is sixty blocked merges — the gate working perfectly and the
swarm delivering nothing.

**That scenario was argued rather than measured when this paragraph was
written. The control has since been run, and this paragraph went on saying
otherwise — committed at 2026-10-26T18:45:42Z by #1616, contradicted by the
readings table at 2026-10-26T19:21:41Z by #1617, thirty-six minutes later in
the same file.**

What it used to say was that no unconfounded instance existed, citing #1614,
whose `BLOCKED` was overdetermined because `ai-review` was `FAILURE` there at
the same time. That was true of #1614 and it is not true of the population:
*Readings taken* above records Phase 0 EXITED on 2026-10-26 at #1616 head
`7ea82e50`, where resolving two threads and nothing else — no push, no
re-run — moved `BLOCKED` to `CLEAN`.

The same row records a second draw on #1614 at `471a5b50` and that draw is
now **WITHDRAWN**: its two halves cannot both be true, and #1614 has merged,
so the post-resolution half cannot be re-taken. The row above says why. It
is named here rather than quietly dropped because a withdrawn reading that
disappears is indistinguishable from one that was never taken.

**A second draw that can be reproduced, which is why this paragraph is being
edited rather than deleted.** Read **2026-10-26 at 23:16Z** on **#1619**, head
`3a4eb10e`, before any resolution:

| Reading | Value |
|---|---|
| required contexts | `test,ai-review` — `gh api repos/hornjason/pai-harness/branches/main/protection/required_status_checks` |
| both | `success` — `gh api repos/hornjason/pai-harness/commits/3a4eb10e2d0675f00711a0b1397d5d5adfd601f9/check-runs` |
| mergeable / mergeStateStatus | `MERGEABLE` / `BLOCKED` |
| review threads | 15, exactly **1 unresolved** |

One check was red — `review`, the local plugin's advisory job — and it is
**not** in the required set, which is the fact that makes the reading
unconfounded and is why the contexts are read from the API beside it rather
than remembered. #1619 was read before any thread was resolved, so it shows
`BLOCKED` attributable to one thread and shows nothing about what resolving
it would do — half a draw, and recorded as a half.

**A third reading, and the cleanest of the set, was taken on #1622 itself.**
Read **2026-10-27 at 01:58Z** on head
`023145d7b7992e2cfbc3f1463305d6ef014ef4aa`, four minutes before that pull
request merged at `f0a9d973`:

| Reading | Before | After |
|---|---|---|
| required contexts (`test`, `ai-review`) | both `success` | unchanged |
| all ten check-runs | all `success` | unchanged |
| `mergeable` | `MERGEABLE` | `MERGEABLE` |
| unresolved review threads | **1** | **0** |
| `mergeStateStatus` | **`BLOCKED`** | **`CLEAN`** |

**Same head. No push, no re-run, no check re-evaluated.** Resolving one
thread and nothing else moved `BLOCKED` to `CLEAN` with every other context
already green, so the block is attributable to the thread and to nothing
else. It is the cleanest draw because the preceding round created the
thread and the preceding fix cleared it: both halves were read minutes
apart, by one observer, on one SHA, with one thread in play rather than two.

It was recorded on #1622 as a comment and deliberately NOT written into this
file by that pull request — five rounds, four of them correcting prose about
readings, and a sixth reading added there would have been one more instance
in place of the mechanism round 4 asked for. This paragraph is the
follow-up it was held for.

So the population is **two complete draws and one half**: #1616 and #1622
both read `BLOCKED` with every required context green and both flipped to
`CLEAN` on resolution alone, and #1619 was read before any resolution. This
paragraph claimed three draws in an earlier round, the count did not survive
reading them, and it is now back to three readings by a different route —
two that were taken rather than three that were asserted. Two is still two
draws. The boxes above stay open.

**The defect worth keeping is that no elapsed time was required.** The first
draft of this correction said the two halves disagreed "for two days", a
duration nobody measured and the document's own dates refute: both statements
carry 2026-10-26, and `git log -S` on the two strings puts their commits
thirty-six minutes apart. The reviewer caught it on this very pull request,
which is the point — a prose claim about the file contradicting itself was
itself a prose claim nothing checked. Two consecutive pull requests, both
green, both reviewed, wrote opposite answers to one observable into one file
inside the same hour. It is the same shape the CRC-B8 bullet under *Measured
non-obvious facts about our own instruments* records about
`required_conversation_resolution` being written `false` there and `true`
under *Phase 0 — three settings, no engineering*. Twice now, and the costly
time is when the stale half is the one arguing that a whole track's premise
is unmeasured.

**Phase 4 therefore moves ahead of Phase 3 for this objective**, but the
reason is narrower than "Phase 3 unblocks nothing". Phase 3 is prompt and
`REVIEW.md` text, and by its own rationale a reviewer given more context
and no falsification step produces *more confident false premises* — so
Phase 3 moves the false-positive rate too, in the costly direction. It is
sequenced after Phase 2 for that reason and that argument is unchanged.
What Phase 3 cannot do is clear an open thread, and clearing threads is the
swarm's binding constraint.

**What this reorder does NOT do** is relax the precision requirement. Note
that CRC-M8's stated order — real bugs first, rounds second — is **inverted
in this repository by declared decision**; see *Known deviations*, where
`MISSED` and `FIRED` are weighted equally because nobody absorbs the noise.
Under that inversion a swarm that ships faster by answering findings wrongly
is not a faster swarm, it is a louder one.

**What would falsify the swarm track** — named differently from *The thing
that would make this plan wrong* below on purpose, because two adjacent
sections with near-identical titles is a navigation hazard and this document
already carries a forward reference to that one: if Phase 2 lands and
`FIRED` on `evals/ai-review-control`'s clean subjects does not fall, then the
quorum is filtering nothing, a swarm is not unblocked by it, and this track is
ordered against a premise that did not hold. Say so and stop, rather than
proceeding to Phase 4 because it is next on a list.

That control is the only false-positive instrument this repository owns, and
it is a weaker one than the sentence above makes it sound: **CRC-M7 declares
the criterion's own number UNMEASURED**, because a finding carries no remedy
anything can apply. So two things have to be true before the reading means
anything. **Take the `FIRED` count BEFORE the quorum lands**, on the same
subject set — a post-quorum number alone is uninterpretable. And **state N**:
the reviewer is a sampled instrument (CRC-B3), so one clean subject scoring
`FIRED` zero times is one draw, not a rate.

**And Phase 2 is necessary only while findings BLOCK.** `ai-review` is a
required context on `main`, which is what makes a false finding expensive
enough to need a quorum — but `AI_REVIEW_OVERRIDE_LABEL`
(`ai-review-override`) is the documented escape, and a swarm running with
that label has advisory findings and no need of Phase 2 at all. That is a
real alternative route to the same objective and it is named here so nobody
takes it silently: it buys throughput by switching the gate off, which
abandons CRC-M8 rather than satisfying it. If anyone proposes it, the thing
to argue about is whether the findings were worth having, not whether the
swarm is faster without them.

A per-attempt rate near 25% has been read elsewhere on this machine and is
**not** this spec's instrument — it is a different repository's population,
recorded in a decision outside this tree. Do not use it as the baseline. It
is named here only so that a reader who meets it does not mistake it for a
number this document measured.

### The thing that would make this plan wrong

Re-take the CRC-M11 reading after #1449 and #1452 land. The 2.64 was measured
across a harness defect that raised a blocking finding on **every** pull
request editing `.claude/` or `CLAUDE.md`, which in this repository is how
conventions ship. If the tail collapses on its own, Phases 1 and 2 are
ordered against a baseline that no longer exists, and the ordering argument
has to be made again rather than inherited.

**Taken, 2026-10-24: it did not collapse** — 2.65 mean, 20.0% at five rounds
or more, against 2.64 and 20.5%. The ordering is inherited. Full reading, and
the age-controlled split that refuses the much better number the naive one
offers, under *Where we actually stand, measured*.

**And the instruction above is now a worked example of its own failure
mode.** It says *"after #1449 and #1452 land"*, which is a question about a
merge, and it meant *"after the population they affect has turned over"*,
which is a question about elapsed time. Read literally it was satisfiable
four hours after the fix, on a cohort 0.5–4.1h old measured against one
4.5–9.2h old — and that comparison reports a 47-point improvement in
one-round pass that disappears entirely when the two are read at the same
age. **State a precondition a reader can be wrong about.** "The fix has
merged" is checkable and was the wrong thing to check.

## Known deviations, declared

A deviation is legitimate when it is written here with its reason. An undeclared one is drift.

| Deviation | Reason | Revisit when |
|---|---|---|
| **CRC-M8 inverted — precision is ranked above recall.** | Found undeclared by the 2026-10-23 audit, and argued at length in `evals/ai-review-control/README.md`: the source's order is right when a human absorbs the noise, and nobody absorbs it here. A false blocking finding costs a remedy commit, a CI round, a review round and an agent's whole context, so `MISSED` and `FIRED` are reported as failures of equal weight. | A human is reading the findings again, or the cost of a false block falls. |
| **CRC-B8 inverted — we file issues instead of blocking threads.** | Historical accident, not a decision. **This is the defect, not a deviation.** | #1261. Highest priority in the spec. Partially addressed: the advisory tail is now surfaced rather than discarded (below), which is the precondition for answering it. Filing is still the default. |
| **Findings routed to an open PR touching the same file.** Not in the source. | Measured: 45% of filings that name a file had an open PR on it. Addresses CRC-B8 in our tracker-shaped world. | Once CRC-B8 holds, this may become unnecessary. |
| **A correctly-carried ADVISORY that the reviewer re-reports is suppressed, and no exemption is made for it.** An exemption was specified while the carry was DROPPING findings (#1601), when a suppressed advisory appeared nowhere at all. With the anchor content-addressed the premise is gone, and the question was re-asked rather than inherited. | **What a reader loses is the advisory's TEXT in this round's annotations, and nothing else.** Three things are unaffected, each read from source rather than assumed. **It is in the record:** the job order is `ai-review-carry` → the reviewer → `ai-review-persist`, *which upserts this round into the ledger comment*, → `ai-review-run`, which invokes the adjudicator — so persistence happens BEFORE suppression and the re-reported advisory is in the ledger for that round whether or not the report shows it. **It was reported in full once**, on the round it was first raised, where nothing suppressed it. **Its absence is announced**: the carry step emits `ai-review carry-forward: ${carried_count} finding(s) from earlier rounds are unanswered at this commit` on every round. **The one real cost, stated so nobody re-derives it:** that annotation is a COUNT and not a list, so a reader who wants to know WHICH advisory is outstanding opens the ledger comment. That is an indirection, not a lost record. **So: nothing a human sees today is lost, and the exemption is not needed.** This row exists so the next person does not re-derive the question from the #1601-era specification of it. | The carry annotation stops reporting a count, or an advisory becomes something a merge decision reads. Either makes the indirection a gap rather than a click. |
| **CRC-N4 suppression applies to ADVISORY findings only. A blocking finding is re-reported on every round, at any key.** The criterion as written at CRC-N4 above asks for *"no repeats of findings already posted"*, without qualification, and the audit line at **CRC-N4** in *What the criteria say we have not built* names the remaining work as *"until the adjudicator drops a finding matching an earlier round's key"*. It does not drop one that blocks. | **Two of our own artefacts disagree, and the newer one is right.** `buildReviewPrompt` in `lib/scaffold/ai-review-step.ts` tells the reviewer: *"CHECK EACH CARRIED FINDING AGAINST THE CODE AND RE-REPORT THE ONES THAT ARE STILL TRUE, at the severity each deserves. … A carried finding you silently leave out is a finding that has stopped being reported, and that is how a live defect reaches a green check."* So on every round after the first, a live unresolved finding is **supposed** to be in the payload and is key-identical to the ledger's. Subtracting it is not de-duplication; it is deleting the only signal the gate has. **Measured on the real functions before the code was written** — a round-1 blocking finding, re-reported on round 2 exactly as instructed, through `priorFindings` → `suppressRepeats` with the ledger's keys: `kept: 0`, `severity of what survives: []`, therefore `blocked: false` and the outcome `CLEAN`. That is a green required check over a defect an earlier round blocked on, which is SUCCESS.md claim 4 failing inside this repository's own merge gate. The exemption is **structural** rather than a rule the gate is trusted to follow: `findingMustAlwaysBeReported` in `lib/scaffold/ai-review-findings.ts` filters before `AiReviewSuppressionGate` is handed anything, so no answer the gate can give drops a blocking finding, and an UNRECOGNISED severity is protected too (`severityBlocks` answers `null`, which is not `false`). `test/ai-review-suppression.test.ts` AS-2 is the measurement executed, with a mutant that removes the exemption and turns the verdict from a refusal into a green check. | Blocking findings stop being carried into the payload — i.e. the carry step hands the reviewer a resolved/unresolved verdict the adjudicator can trust, so a re-emission is distinguishable from an unanswered repeat. Not before, and not by widening the predicate. |

## Measured non-obvious facts about our own instruments

Recorded because each one invalidates a naive reading of the criteria above.

- **A metric that exists is not a metric that reports, and CRC-M11 sat in that gap for two days.** `lib/rounds-to-pass.ts` shipped in #1441 and printed `measured 1, unmeasured 39` against the live tracker: every refusal was `ROUNDS_TRUNCATION_UNKNOWN`, because `readLedger` called every legacy bare-array ledger unknowable while the #1405 WRITER already derived the opposite for the same input — a list that grows by one per round and is only cut at the cap was never cut if it is shorter than the cap. Same fact, two modules, two answers, and the metric consumed the readers. #1448 taught the reader the derivation and the reading became `measured 44, unmeasured 1`. **The lesson is the shape, not the bug:** a criterion asking for a number must be checked by running it, because a file-exists matcher would have ticked this while the command refused 39 of 40 rows. It is why CRC-M11 is banked in `CLAIMED_UNBINDABLE` rather than given a pattern.

- **`ai-review` is a sampled instrument, not an enumerated one.** `lib/scaffold/ai-review-step.ts` reviewed CLEAN on #1262 and BLOCKED on #1274 about an hour later, both at `scope=full`, with the flagged construct byte-identical across the two heads (content hash equal; whole-file hash differing as the control). **A green review means this run did not find this thing.** Any criterion scored by comparing reviewer verdicts across runs is reading a sample.
- **A second mechanism produces the same error direction, and it is a different axis from a same-tree repeat.** The #1262/#1274 pair above and the #1334 pair in `CRC-B3` both hold the tree fixed. This one does not: on #1337, run `39972693180` (head `fb295a47`, created 14:47:51Z) returned `findings: []` and run `39973400503` (head `3d3c5b62`, created 14:52:46Z) returned one `high` naming `lib/scaffold/steps.ts`. **`git diff` between the two heads is 18 insertions in one test file and nothing else**, and the subject the finding names is the identical blob `57cb319f` at both — the whole-file object hash, which is the stronger form of the content-hash control used above. Both runs were created before #1340 merged at 15:00:18Z, so the base is held too. So the instrument flipped on a change that cannot have caused the flip, and the direction was the costly one again: four observations now, all false positives. **The third draw is not a fourth instance and must not be counted as one** — run `39975917885` (head `0bf21bcc`, created 15:10:01Z) returned `[]`, but it was created after #1340 merged, so its merge ref carries a base the first two never reviewed. It is an uncontrolled sample, not a reversal.
- **A ledger timestamp is not the tree that was reviewed.** The near-miss above is worth more than the instance. The ledger rows for those runs read 14:53:08Z and 15:01:15Z, and the second is after #1340 merged — which reads as the second round having reviewed it, and it did not. **The ledger step runs late in the job; the merge ref is fixed at run creation.** `at` is when the step wrote, `createdAt` is what was reviewed, and only the second answers the question. The ledger's own timestamps are the field a reader reaches for first and the wrong one for this.
- **CRC-E4 was satisfied by its own inverse before #1437, and the inverse looked like compliance.** `ai-review` refuses any pull request whose `.github/workflows/ai-review.yml` differs from the default branch's — one file, not any CI workflow file — and the documented escape, the `ai-review-override` label, **waives the check** rather than routing to a person. Measured at 19:15Z on 2026-10-23, with 15 pull requests open: **five edit that file and so can never go green** (a change to the reviewer cannot pass the reviewer), and **five more were red only because `main` had moved it underneath them** — `gh pr update-branch` cleared those five, and #1358 merged twenty minutes later having been red for four hours for a reason it did not cause. A check that cannot pass, plus a label that waives it, records nothing about whether anybody read the diff. `ALWAYS_HIGH_PREFIXES` in `lib/risk-tier.ts` is a floor no configuration can lower, but branch protection still requires zero approvals, so what the tier produces today is a **reading** rather than an enforced gate — CRC-E6 and CRC-E8 remain blocked on that setting, and the reading is what a consumer with required reviews would hand to it.
- **CRC-M6's four buckets are not all measurable here yet.** Three of the four — wrong / intentional / didn't matter — report `UNMEASURED` rather than 0, because closing comments follow no parseable convention. `noiseRate` is `null`, not `0`.
- **There is nothing deployed for a quorum to vary, so its variance control reads zero by construction.** The live filing path is `hooks/VerifyPhaseLock.hook.ts` → `filingGate` → `adjudicateFiling`, which runs a category regex over the title and set arithmetic over symptom keys and nothing else — no clock, no randomness, no network, no model. `arbitrate`, the five-stage path that takes votes, has exactly one caller outside `lib/` and `test/`: `scripts/arbitrate-finding.ts`. So twenty runs of the single adjudicator report one distinct outcome set, and **a quorum would introduce variance here rather than reduce it**. Calling the quorum "the variance control" inverts which way the causation runs.
- **Two of the residues do not close by running the measurement more times.** A withheld candidate leaves no downstream trace — never filed, never commented on, never fixed — so the outcome graph it would have to be read from is one it never entered; and a finding nobody acted on leaves no trace from the other side either. Raising the run count does not help, because there is no artefact to read at any count.
- **A ratchet whose two sides are checked by different instruments, one of which is never run, reports the unchecked side as passing.** `test/closing-keywords.test.ts` asserts the keyword-derived close set against the live `project-state.json` on every suite run. The declared set is only checked against real issue states under `--issue-states github`, which `test/state-record-closes-mutation.test.ts` describes as the live path and deliberately never exercises — the suite drives that code against planted fixture files instead. So a record can declare an issue closed that is open, and nothing in CI says so. Measured 2026-10-23 while repairing the session record: an intermediate draft declared three issues closed, of which one is still open at the time of writing and two were open when the reading was taken and closed later the same day. The record on `main` no longer declares them, which is the repair and not a reason the gap is closed.
- **The dedupe corpus is untrusted.** This repo is public, so any open issue — including one opened by a stranger — is an input that can suppress a legitimate finding.
- **Until this entry was written, a non-blocking finding was discarded by the reader, not merely unreported.** `AI_REVIEW_SEVERITIES` declares `medium`, `low` and `info` advisory; `readAiReviewFindings` counted them and `aiReviewRefusal` printed only the blocking subset, so a CLEAN payload carrying seven `medium` findings produced **byte-identical output** to one carrying none. The payload lives under `$RUNNER_TEMP`, nothing uploads it, and it dies with the runner — so the finding was unrecoverable the moment the job ended, which is why the drop is invisible in any count taken afterwards. `advisoryNotice` now emits the tail as a `::notice` carrying each finding's file, line, summary and a line-independent key, and `test/ai-review-advisory-findings.test.ts` holds it. **The size of the population this was losing is UNMEASURED and cannot be recovered**: the only readings that would show it were in the payloads that died. It becomes measurable from the first run after this ships.
- **The waiver cannot waive a finding, and did not.** `ai-review-override` is consulted only on routes where **no findings payload exists** — the structural refusal and the action-did-not-complete routes. A payload that adjudicates to BLOCKED exits non-zero without the label being read, and a payload present alongside the label is its own UNMEASURED refusal. So "a finding was waived past merge" is not a hole in this pipeline, and a gate built over it would have guarded nothing. Recorded because it is the first thing a reader looking for CRC-B8's merge hole reaches for.
- **GitHub's own implementation of CRC-B8 is ON, and this bullet said the opposite until 2026-10-25.** Read from the API on 2026-10-25: `required_conversation_resolution: true`, alongside `enforce_admins: true`, `strict: false`, and no required reviews. The bullet previously read `false` and concluded that the native mechanism was *"available and unused"* and that CRC-B8 *"cannot be closed by code alone"*. **Correcting the boolean does not leave that inference standing, so it is withdrawn rather than reworded:** the mechanism is not unused, it is in force, and the thing CRC-B8 then lacked was not a setting but a *producer*. **That half closed on 2026-10-26** — the generated workflow's `ai-review-threads` step opens a thread per finding and #1614 carries four — so what CRC-B8 lacks now is neither setting nor producer but a **reading**, and the distinction matters because a block observed while another required check is also failing is overdetermined and attributes nothing. The half this document can hold code to is therefore the one above it, and it is the half that matters more than it did when this read `false`. **What is worth more than either fact: the document already contradicted itself.** Phase 0 records *"CRC-C3 is APPLIED as of 2026-10-23"* with the same field read `true`, under *Phase 0 — three settings, no engineering*, and the two sat in one file disagreeing because nothing compares two prose statements of one API field — `.claude/rules/checks-must-be-able-to-fail.md`'s *"when a guard enforces a property, ask what other syntax expresses the same property"*, with the guard missing entirely. The audit entries for CRC-C2, CRC-C3 and CRC-E8 each read a different consequence off the same protection document and are deliberately not repeated here; that they are not repeated is now load-bearing rather than tidy.
- **A required check reported CLEAN over a live blocker for two rounds, because the carry anchored on a LINE NUMBER (#1601).** This is Claim 4 failing inside this repository's own merge gate, with a named instance. On PR #1597 round 5 blocked on a `high` in `lib/issue-filing-gate.ts`, at what was then line 1827 (run `40139615405`, head `89b6cc61` — the number is quoted as the anchor the ledger recorded, not as a position in today's tree, which is the whole subject of this entry); rounds 6 and 7 both reported `CLEAN` and `0 finding(s) from earlier rounds are unanswered`, and the defect was never fixed — the agent working the PR said so in its own report. Unrelated edits had shifted the file, so line 1827 held a comment instead of the recorded code, the comparison failed, and the finding was classified **resolved**. **The drop is permanent, not a one-round blip:** the ledger keeps the original anchor for ever, so once the text at that line stops matching it never starts again. The failure direction is what makes it bite — the carry rule's three branches were deliberately built to fail TOWARD carrying (a null anchor carries, an unreadable anchor carries), and a **successfully read wrong line** is indistinguishable from a genuinely fixed one. **The single fail-open branch is the one ordinary editing produces on every push.** The fix is content-addressing: count the lines equal to the recorded text, carry on one or more, resolve only on zero, and leave an empty recorded anchor on the line path because #1406 established that is a real reading of a genuinely blank line. **The general shape, which is the part worth carrying:** when a check compares a stored observation against the present, ask what the identity of the observation is. A line number is a COORDINATE, and a coordinate is only stable while nothing above it moves.
- **The "second chance" a full-scope round gives a dropped finding is real, and it is taken once in thirty-three (#1600, #1601).** The argument for fixing #1601 before narrowing was that under `scope=full` the reviewer re-reads the branch and can re-find a defect the carry dropped, while under `scope=diff` a dropped finding in an untouched file is read by nothing. That sentence was shipped unquantified, which makes it unfalsifiable, so it was measured. **Method:** all 828 pull requests walked, 147 parseable ledgers, 193 findings carrying both a non-empty recorded anchor text and a numeric line; for each of the **272** (finding, later round) pairs the blob was fetched at that round's own head sha and the PRE-#1601 rule replayed against it. A drop is a pair where the recorded line no longer holds the recorded text **and** the text is still somewhere in the file — the content rule carries it, the line rule resolves it. Every round in the corpus is full-scope, because narrowing has never shipped; the population is therefore exactly the one the claim is about. **Result: 33 distinct defects were dropped at least once. 2 were raised again by a later round. 31 were never seen again.** Reading the two rather than reporting the count is what makes the answer one: **#1435** is clean — a `medium` raised at round 1, dropped by the anchor at round 2, absent through rounds 2–4, raised again at round 5 — and **#1597**'s is an `info` remark whose anchor is the function signature `export async function filingGate(`, raised at rounds 6, 7, 9 and 10, which is better read as a recurring remark on a declaration than as a re-find. **So the second chance is real and rare: about 3%.** The consequence runs the way that was not expected: narrowing on top of the BROKEN carry would have cost roughly one recovered finding in thirty-three drops, and narrowing on top of the FIXED carry costs nothing through this mechanism, because the drop does not happen. The ordering was still right; the reason it was right is one finding, not a category. **Two controls, because a zero here would have been indistinguishable from a pruned commit:** 272 pairs measured, **0** unmeasured, **0** blob fetches failed. The first pass reported 51 unmeasured and 31 drops, because the head-sha map was built from the findings rather than from the ledger entries, so a round that recorded no finding had no sha and was skipped; rebuilt from the entries, all 333 (pull request, round) pairs carry a sha and the drop count moves to 33. **What this does NOT measure**, said here rather than left as an omission: it is about re-finding a finding the carry once held. It says nothing about the reviewer's recall on code it has never flagged, and conflating the two would make the number mean more than it does.
- **A completeness check that asks whether what is present PARSES cannot see what is absent (#1600, found in review).** The same shape as the entry above, one level up, and it was caught before it shipped rather than after. CRC-N2's narrowing gate asked `unmeasuredRounds == 0` — the count of recorded rounds whose findings list could not be read. A **truncated** ledger's earlier rounds are not unreadable, they are gone: every entry still present parses perfectly, the count reads `0`, and the scope narrows over history the gate cannot see. Nor does a hole need truncation — rounds 1, 2 and 5 recorded before a snapshot at 6 is a gap that both readings call clean. Re-measured 2026-10-25 by walking **all 828 pull requests** and replaying the decision per round against the ledger as the carry step would have read it at that round: **147** carry a parseable ledger, **333** distinct rounds, **115** at or past the floor. Among those 115 the truncation gate refuses **46** and the round-number gap refuses **15** (#1420 has no round 2, #1391 no round 1). Both gates refuse something real rather than being adoption on paper.

  **The first reading of this bullet was wrong and is corrected rather than quietly replaced.** It said *"of 197 rounds at or past the floor … 100 still narrow"*. **100 was the remainder after these two gates only** — it never had the PRE-EXISTING blind-spot gate applied, and that gate refuses **96 of the 115**. The real figure is **12 rounds, 3.6% of all 333**, and it is in `AI_REVIEW_DIFF_SCOPE_FROM_ROUND`'s docblock with the full subtraction. The error is the shape this whole document is about: I measured the increment my own change contributed and reported the remainder as the total, which reads as a number about the system and was a number about my diff.

  **ONE ROW HERE IS ONE DISTINCT ROUND NUMBER OF ONE PULL REQUEST** — not a ledger entry, and not a round of a pull request that happens to qualify elsewhere. The unit is stated because the retracted reading used a different one and said so nowhere, which is the only reason two numbers in this document could disagree without either looking wrong. **The 197's unit was identified by reproducing it, not by guessing at it.** Classify each pull request ONCE as truncated / gapped / neither, then count ALL of its rounds under that class — rounds 1 and 2 included, which never narrow — and the corpus returns **215 / 85 / 15 / 115** today against the retracted **197 / 83 / 14 / 100**, the gap being four pull requests of drift. The correct unit returns **116 / 46 / 11 / 59** on the same corpus, which cannot be rounded into the retracted figures by any amount of drift. So the row was *"a round belonging to a PR that reached the floor"*, and the arithmetic should have stopped me a day earlier: 197 at-floor rounds cannot sit inside the 161 distinct rounds the bullet below reports. **The corpus moves under this measurement** — the same walk returned 147/333/115 and, some hours later, 148/335/116 — so every figure here is dated and the ratio rather than the count is the durable part.

  **A second measurement is recorded because it nearly shipped a gate that refused everything:** `truncated` holds a COUNT, not a boolean — every #1405-era ledger in the corpus reads the number `0` and none has ever read `false` — and a first draft testing `typeof === "boolean"` refused all 197 rounds while looking exactly like a strict gate.
- **CRC-N2 ships a scope WORD, and whether the reviewer obeys it is UNMEASURED (#1600).** The criterion is adopted — `reviewScopeForRound` in `lib/ai-review-rounds.ts` and `review_scope_for_round()` in the generated `ai-review-carry` step both answer `diff` from round 3 when the carry reading is complete — and the checkbox is deliberately **not** ticked, because what has been built is a value written to a file the reviewer prompt is told to read. **#1533 measured the reviewer reading whole files rather than the diff.** Nothing in this change measures it again, so a narrowed round produces no artefact distinguishing "the reviewer confined its reads" from "the reviewer was asked to and did not": the step records the request, and the reviewer's reads are not recorded anywhere. That reading becomes available from the first real round-3 run after this merges, and until somebody takes it the honest state is UNMEASURED — **a tick would read as *the reviewer reads less now*, which is not a thing anybody has observed.** This is SUCCESS.md claim 4 applied to our own adoption: *could not measure* must never read as *nothing wrong*.
- **The round-3 floor is measured, not chosen, and the cohort is right-censored.** Over the 90 open-or-merged pull requests carrying a parseable `rungate:ai-review-ledger:v1` comment on 2026-10-24: **161 distinct rounds**, distributed round 1 **90 (55.9%)**, round 2 **37 (23.0%)**, round 3 **19 (11.8%)**, round 4 **9 (5.6%)**, round 5 **6 (3.7%)**. Narrowing from round 3 therefore touches **21.1%** of rounds and leaves rounds 1 and 2 — **78.9%** — reading the whole branch; a floor of 2 would be 44.1% and would narrow the *first* re-review, and a floor of 4 would be 9.3%, which is adoption on paper. **The internal control is that round 1's count equals the PR count equals 90** — every ledger has a first round, so a reading in which they diverged would be a parser fault rather than a distribution. **A ledger entry is not a round:** a re-run appends another entry at the same round number, so the 202 raw entries over the same corpus inflate the rounds by 1.25× (#1592). The cohort is right-censored — an open PR that will reach round 4 is counted today at 3 — which moves the ≥3 share **up**, so the floor is conservative in the direction that matters.

  **21.1% is the FLOOR's reach and must not be read as CRC-N2's reach.** It is gate 1 alone. Re-measured 2026-10-25 over all 828 pull requests — 147 with a parseable ledger, 333 distinct rounds — **115 rounds (34.5%) are at or past the floor and 12 (3.6%) narrow under every gate as built**; with #1592 fixed, 20 (6.0%). The shares in the table above move with the larger corpus and the floor does not. Both numbers belong wherever either is quoted: a reader given only the first reads a change that touches a fifth to a third of all rounds, and the change touches **one in twenty-eight**.
- **CRC-N2 cannot lower `AI_REVIEW_MAX_TURNS`, and a post-narrowing re-derivation would be reading the wrong population (#1257).** The budget was set to 80 across the shift to `scope=full`, so narrowing invites re-deriving it downward. Re-derived from the ledger's `turns` key over the same 90 PRs: of 202 entries, **57 predate #1380** (which added the key) and **34 record `turns: null`**, leaving **111 readings** — min **20**, mean **40.75**, p50 **39**, p90 **53**, p95 **59**, p99 **70**, max **75**. **80 stays**, 6.7% above the observed maximum. The reason it cannot move is in the per-round split: round 1 **n=60, max 66**; round 2 **n=20, max 70**; round 3 **n=10, max 66**; round 4 **n=12, max 53**; round 5 **n=9, max 75**. **Rounds 1 and 2 are never narrowed and are 80 of the 111 readings**, so the budget is governed by exactly the population this change does not touch. Every reading is also from the `scope=full` era — #1380 postdates #1243 — so there is no narrowed round in the corpus at all, and a lower number derived after narrowing would describe the 21% while binding the 79%. `num_turns` is not clamped at the cap, so 75 is a real reading and not a ceiling artefact.
