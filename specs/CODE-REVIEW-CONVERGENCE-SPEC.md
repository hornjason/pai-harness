---
doc-type: spec
testable: true
compliance: strict
governs: Automated code review convergence — the mechanisms from Anthropic's "Solving code review" that RunGate adopts, what each one must do, and how we know whether it works. This is the alignment reference for all finding-arbiter, jury, review-depth and approval work.
status: active
owner: jason
created: 2026-10-22
source: https://claude.dev/blog/solving-code-review-at-anthropic/
updated: 2026-10-23
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
| CRC-C2 | **The bug-review half holds.** `test` and `ai-review` are required contexts on `main` with `enforce_admins` on, so a blocking finding reds the check and the merge is refused. Read from the API on 2026-10-23. | Branch protection is GitHub state, not tree state. The security-review half does not hold at all — there is no security check to require, and `required_conversation_resolution` is `false`, so an open thread blocks nothing. |
| CRC-M2 | `REVIEW_OUTCOME_PLANTS` holds four findings whose outcome was established independently. | Expert confirmation is a human act, and those four grade the outcome sweep rather than an incident case set. |
| CRC-N3 | `REVIEW.md` asks for the class and not the line, and CRC-A6's check proves the reviewer read it. | Whether it complied is a property of a sampled model. No artefact records a finding the reviewer generalised. |
| CRC-H1, CRC-H3, CRC-H4, CRC-H5 | Statements about human judgement. | Nothing distinguishes them being honoured from them being ignored. |

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
| CRC-C3 — a false positive clears by closing the thread with a reason | `required_conversation_resolution`, currently `false`. | The native mechanism for "a finding blocks merge until it is dispositioned", which is also half of CRC-B8. |
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
| CRC-N2 — diff-only re-review | The deviations table below. Retirable once `carryForward` has a production caller; not before, and not by assertion. |
| CRC-M8 — bugs first, rounds second | The deviations table below. The order is inverted here on purpose; the *enforcement* half is unbuilt either way. |

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
- **CRC-N4** **Half of it shipped in #1381 and the half the criterion is named for did not.** The walker exists: the generated `ai-review-carry` step reads the ledger, compares each prior finding's recorded anchor against the cited line at this commit, and hands the reviewer the unresolved set under one of three readings that may not collapse — `AI_REVIEW_CARRY_READ`, `AI_REVIEW_CARRY_ABSENT`, `AI_REVIEW_CARRY_UNMEASURED`. It restates `readLedger → priorFindings → carryForward` in bash and is bound to the library over one matrix by `test/ai-review-carry-forward.test.ts`, because `lib/scaffold/ai-review-step.ts` may not import: the step is deliberately import-free so that the 27 suites copying it into a temp directory can build mutants that load. What remains is **suppression**. `suppressRepeats` still has no caller, so a repeat is now *marked* — the reviewer is asked for `carried_from_round` on a re-emission — rather than *dropped*, and nothing reads that member. Until the adjudicator drops a finding matching an earlier round's key, a finding already posted can still be posted again, which is what this criterion says.
- **CRC-N5** Nothing runs review agents nightly over existing code.
- **CRC-H2** Risky code requires a human. There is no `CODEOWNERS` and no required approval, so nothing does.

### Shipped since this audit was taken

A criterion the audit counted as remaining and that no longer is. Kept as a
section rather than deleted: the analysis is the record of what the item cost
and why the shape it shipped in is the right one, and the six states above are
states of an UNTICKED box, so a ticked one belongs in none of them.

- **CRC-B7** — **shipped in #1587**, and the analysis below is kept as the record of what it cost rather than as a statement about the tree. What changed: `Severity` and `SEVERITY_RANK` are now declared in `lib/scaffold/ai-review-step.ts`, the contract module the deployed reader already imports and the only one the mutation batteries can carry, and `lib/finding-jury.ts` re-exports them — **one declaration, no third vocabulary**. `AI_REVIEW_SEVERITIES` was NOT merged into it, because the two must disagree for both to be right: a `critical` naming a file the pull request does not touch blocks under the severity table (magnitude is a property of the defect) and tags `Pre-existing` under this one (attribution is a property of the diff), and folding them would require the reviewer to write `Pre-existing` itself when it is deliberately never given the file list. `findingPathScope` is the single binding both the demotion and the tag read, `tagOrder` is the single comparator, and the tag is applied to the advisory tail as well as the blocking set — the demotion never looked at an `info`, and an `info` about code on `main` is misattributed exactly as badly as a `critical` is. Three clauses, and they have three different costs — reading it as one item is what made it look cheap. **Sorting** is now possible and was not before #1337: there is a rendered tail to put in an order, and `advisoryNotice` and `renderCountedFindings` both emit in payload order, which is whatever order the model wrote. **The vocabulary** does not exist in the deployed path: `SEVERITY_RANK` tags Important / Nit / Pre-existing in `lib/finding-jury.ts`, which the CI path never calls — its callers are `scripts/arbitrate-finding.ts`, `lib/issue-filing-gate.ts`, `lib/failure-intake.ts` and `hooks/VerifyPhaseLock.hook.ts` — while the deployed table, `AI_REVIEW_SEVERITIES`, declares `critical`, `high`, `medium`, `low` and `info`. **Pre-existing** is not decidable there at all: `severityOf` decides it from the pull request's changed files and the findings step has no changed-path list to scope against. **The prerequisite is #1204/#1354, not #1337**, because that is the change carrying the changed-path list into this module; until it lands the criterion cannot be ticked on the first two clauses alone. A weaker route to the third exists and is worth knowing before anyone plumbs the diff: `advisoryKey` (named `findingKey` before #1398) identifies a finding by file and summary rather than by line, so the same observation has one identity across rounds and *first seen on round 1* becomes decidable from the accumulated ledger with no diff at all. That is a different and smaller claim than `severityOf`'s — first-seen-round, not present-before-the-pull-request — and it should be labelled as the one it is rather than sold as `Pre-existing`. **One trap for whoever sorts**: `renderFinding` prints `finding <index>`, and the blocking annotation and the advisory notice now share that numbering, so a sort must reorder the display and keep the payload index in the label. A case in `test/ai-review-advisory-findings.test.ts` asserts the tail is indexed against the whole payload and reds on renumbering.

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
| **CRC-N4** — no repeats | nothing. `lib/ai-review-rounds.ts` exports seven functions with **zero production callers between them**. The machinery is built and uncalled. |
| **CRC-B7** — Pre-existing tagging | *(cleared, #1587)* #1204 closed, #1354 merged and 0.8.3 shipped, so the changed-file list reaches the adjudicator |
| **CRC-N2** — diff-only re-review | CRC-N4. It is a declared deviation *only* until `carryForward` has a production caller |

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
| **CRC-N2 diff-only re-review NOT adopted.** Scope stays `full`. | The generated step argues scope must stay full until an adjudicator re-emits unresolved prior findings; dropping to diff-only first would lose them silently. | An adjudicator re-emits unresolved findings. |
| **CRC-B8 inverted — we file issues instead of blocking threads.** | Historical accident, not a decision. **This is the defect, not a deviation.** | #1261. Highest priority in the spec. Partially addressed: the advisory tail is now surfaced rather than discarded (below), which is the precondition for answering it. Filing is still the default. |
| **Findings routed to an open PR touching the same file.** Not in the source. | Measured: 45% of filings that name a file had an open PR on it. Addresses CRC-B8 in our tracker-shaped world. | Once CRC-B8 holds, this may become unnecessary. |

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
- **GitHub's own implementation of CRC-B8 is off on this repository.** `required_conversation_resolution` is `false` in `main`'s branch protection, so the native mechanism for "a finding blocks merge until the thread is dispositioned" is available and unused. **Turning it on is a repository setting, not a change any pull request can make** — which is why CRC-B8 cannot be closed by code alone, and the half this document can hold code to is the one above it. The audit entries for CRC-C2, CRC-C3 and CRC-E8 each read a different consequence off the same protection document and are deliberately not repeated here.
