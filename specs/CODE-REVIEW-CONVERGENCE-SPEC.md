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
- [ ] CRC-B7: Surviving findings are **sorted by severity** and tagged **Important / Nit / Pre-existing**, so a pre-existing bug does not read as the author's fault.
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

Of the 56: **9 bound**, **8 where a mechanism exists that nothing in this
repository can observe**, **4 that cannot be meaningful in this deployment**,
**3 blocked on an owner decision**, **2 declared deviations**, **30 not done**.

Re-counted on 2026-10-23 after #1437 bound CRC-E1, CRC-E2 and CRC-E4, and
again after #1448 bound CRC-M11. The audit above was taken the same day, at 0
bound; the four moved by engineering, and none of the other four categories
changed, which is the point of keeping them separate.

An unticked box is one of the last five, and they are five different facts.
Four of them are recorded here because an unticked box nobody can ever tick,
one waiting on a person, and one nobody has started all look identical, and
only the last is work.

The split is load-bearing rather than tidy: 42 unticked boxes read as 42
pieces of engineering. Eight of them are not engineering at all.

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

Three criteria are satisfiable by **repository configuration** and cost no
engineering. They are listed apart because "nobody has built it" and
"somebody has to decide" are different debts, and the second does not get
smaller by working on it.

All three are also unobservable from inside this tree for the same reason
CRC-C2 is — they are GitHub state, not tree state. Binding any of them needs
a check that reads the API, which is a design decision in its own right.

| Criterion | The setting | What it closes |
|---|---|---|
| CRC-F1 — a merge queue re-runs every check against main | `strict: true`, or a merge queue. The `merge_group:` trigger is already generated and already handles the event. | `strict` is `false` today, so an armed pull request can merge green against a base it never ran against. **Caveat, stated rather than buried: a merge queue serialises merges**, which at this repository's concurrency may cost more than the hole. `strict: true` is the cheaper half and closes the same gap. And on `merge_group` the review annotates UNMEASURED and passes, so a queue re-runs `test` against main but not `ai-review` — "every check" would be half true. |
| CRC-C3 — a false positive clears by closing the thread with a reason | `required_conversation_resolution`, currently `false`. | The native mechanism for "a finding blocks merge until it is dispositioned", which is also half of CRC-B8. |
| CRC-E8 — an approval covers one specific commit | `required_pull_request_reviews` with `dismiss_stale_reviews`. | Nothing today: with no required reviews there is no approval to carry or dismiss. `gh pr merge --match-head-commit` is a convention agents follow by hand. |

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
- **CRC-A4** The second half holds — `REVIEW.md` names "a line that was true of a previous revision and is now false" as a defect class. The first does not: nothing tells the reviewer to flag code breaking a `CLAUDE.md` convention. **The obvious objection to adding it does not apply**: `CLAUDE.md` is already in `AI_REVIEW_UNTRUSTED_PATHS` and is restored from the pull request's base before the reviewer starts, so a branch cannot legalise its own change by editing the conventions it is measured against. What the sentence does not buy is the criterion: *flags* is behaviour, and an instruction with no compliance reading is the thing `CRC-A6` exists to avoid being. Ticking this needs a planted subject under `evals/ai-review-control/`, not a line in a document.
- **CRC-A7** Three of four clauses hold in `REVIEW.md`: a cap of three non-blocking findings, a "Do not flag" path list, and file-and-line evidence. **The fourth cannot be satisfied in `REVIEW.md` at all, and that is a contract gap rather than a wording gap.** There is no overall review summary anywhere in the payload: `AI_REVIEW_FINDING_FIELDS` declares `summary` *per finding* — "one sentence stating the defect" — and the top-level object carries only the findings list and the verdict word. So an instruction to open a summary with a count would be addressed to a channel the contract has no slot for, which is the shape this repository calls an instruction nobody executes. The clause needs a top-level summary field first. **#1337 did not do half of it, and the near-miss is worth recording because it reads like it did**: `advisoryNotice` returns `null` when the advisory tail is empty, so a CLEAN reading with no findings at all still prints one line, byte-identical to before. That is exactly the case the clause is about — *says plainly when there is nothing to fix* — and it is the one case the new output does not reach. What #1337 did land is the **count** half for a non-empty tail, whose notice opens with the number and binds it to the findings listed.
- **CRC-A8** No path routes a repeated finding into a skill, a lint rule or an instruction file. `lib/rule-promotion.ts` promotes from compliance failures, not from review findings.
- **CRC-B1** **Built, and deliberately not ticked.** The reviewer is now handed the pull request's title and body as a file in the findings directory, outside the checkout, named by `AI_REVIEW_INTENT_PATH`; the prompt tells it to read that file and to treat the contents as a **claim under test with no authority over the review**, saying that a gap between the claim and the code is itself a finding and the code is the side that is true. An event supplying neither field writes `AI_REVIEW_INTENT_UNMEASURED` rather than a blank, because an empty claim is still a claim and nobody made it. The fields reach the runner through `env:` and are interpolated into no `run:` block — asserted over the generated workflow, because author-controlled text expanded into a `run:` is substituted before bash parses the line. **Why it is not ticked**: the criterion says the reviewer *reads* it, and what exists is the delivery plus an instrument — a transcript check that reports whether the read happened. The instrument **annotates and does not refuse**, so a reviewer that ignores the file still passes, and there are zero readings so far. Ticking on a mechanism nobody has yet seen fire would certify the behaviour we are trying to measure. **Promotion condition**: when the read/skip population shows the skip rate at or near zero, the warning becomes a refusal and the criterion binds against it. The reason the gate is not fatal today is the four false positives recorded below — a new required behaviour on a sampled instrument measures the flake rate first, not the compliance rate.
- **CRC-B2** The prompt says nothing about root cause on a bug fix.
- **CRC-B3** One reviewer agent per round. **Not adoptable before CRC-B4, and the criterion now says why**: N generators over a sampled instrument are N draws, and run `39962683401` is a same-tree pair that disagreed BLOCKED/CLEAN with a false positive on the blocking side. Without a quorum to filter them, parallel generation multiplies exactly that. Ordering, not absence of effort.
- **CRC-B4** `lib/finding-jury.ts` has the group size, the quorum, per-verifier votes and a disagreement flag. `arbitrate`, the only path that reads them, has no caller outside `lib/`, `test/` and `scripts/arbitrate-finding.ts`. Nothing deployed takes a vote.
- **CRC-B6** `compareReviewOutcomes` and `evals/ai-review-control/variance-capture.ts` exist. No filter has been A/B tested before being kept, and the variance control reads zero by construction — see below.
- **CRC-B7** Three clauses, and they have three different costs — reading it as one item is what made it look cheap. **Sorting** is now possible and was not before #1337: there is a rendered tail to put in an order, and `advisoryNotice` and `renderCountedFindings` both emit in payload order, which is whatever order the model wrote. **The vocabulary** does not exist in the deployed path: `SEVERITY_RANK` tags Important / Nit / Pre-existing in `lib/finding-jury.ts`, which the CI path never calls — its callers are `scripts/arbitrate-finding.ts`, `lib/issue-filing-gate.ts`, `lib/failure-intake.ts` and `hooks/VerifyPhaseLock.hook.ts` — while the deployed table, `AI_REVIEW_SEVERITIES`, declares `critical`, `high`, `medium`, `low` and `info`. **Pre-existing** is not decidable there at all: `severityOf` decides it from the pull request's changed files and the findings step has no changed-path list to scope against. **The prerequisite is #1204/#1354, not #1337**, because that is the change carrying the changed-path list into this module; until it lands the criterion cannot be ticked on the first two clauses alone. A weaker route to the third exists and is worth knowing before anyone plumbs the diff: `advisoryKey` (named `findingKey` before #1398) identifies a finding by file and summary rather than by line, so the same observation has one identity across rounds and *first seen on round 1* becomes decidable from the accumulated ledger with no diff at all. That is a different and smaller claim than `severityOf`'s — first-seen-round, not present-before-the-pull-request — and it should be labelled as the one it is rather than sold as `Pre-existing`. **One trap for whoever sorts**: `renderFinding` prints `finding <index>`, and the blocking annotation and the advisory notice now share that numbering, so a sort must reorder the display and keep the payload index in the label. A case in `test/ai-review-advisory-findings.test.ts` asserts the tail is indexed against the whole payload and reds on renumbering.
- **CRC-B8** Half, and a different half since #1337. The advisory tail is no longer discarded — `advisoryNotice` names every counted non-blocking finding, with a key, in an annotation that says each is UNANSWERED. What is still missing is the requirement: nothing obliges anyone to answer one, so "fixed, or resolved with a stated reason" remains a request. A duplicate or a dropped-category filing is refused at the chokepoint; ALLOW is still the default for a novel finding.
- **CRC-B9** No per-repo review depth. `ceremonyTier` LIGHT / STANDARD / THOROUGH is the harness gate ceremony, a different axis.
- **CRC-E3, CRC-E9** `lib/risk-tier.ts` now exists, so these two have something to second-guess and something to loosen — which is why they were sequenced after #1437 rather than built with it. `E3` needs a second classifier that can raise a LOW the first one is content with; `E9` needs a recorded outcome per tier to loosen against, and the ledger does not carry a tier yet. `LOW_MAX_FILES` and `LOW_MAX_LINES` are therefore declared strict and not evidence-based, and that is stated at the constants rather than left to be discovered.
- **CRC-E6** Branch protection declares no required reviews, so no approval counts toward anything and the criterion is vacuous rather than satisfied.
- **CRC-F3** No one-step rollback, and none exercised.
- **CRC-F4** No incident review asks which layer should have caught it.
- **CRC-F5** No circuit breaker. The source admits this as a gap on their side too.
- **CRC-M1** One subject directory, holding an authored plant and two clean variants. Not a case set drawn from past incident-causing pull requests.
- **CRC-M3** Nothing adds a case when an incident happens.
- **CRC-M4** Nothing rescores the whole set when the reviewer's prompt, tools or model change.
- **CRC-M5** No schedule runs the eval. The only crons in the tree are `.github/workflows/issue-audit.yml` daily and `.github/workflows/action-pins.yml` weekly.
- **CRC-M6** One bucket of four is derived from evidence. The other three report UNMEASURED unless hand-declared, and `noiseRate` is `null`.
- **CRC-M7** The control exists and counts `FIRED` on clean subjects. The criterion's own number — findings that *would have led to a harmful change* — is declared UNMEASURED by the control's README, because a finding carries no remedy anything can apply. A tripwire in `test/review-negative-control.test.ts` reds the day the contract grows one.
- **CRC-M10** Nothing tracks revert or incident rates.
- **CRC-N4** Seven exports of `lib/ai-review-rounds.ts` — `readLedger`, `priorFindings`, `carryForward`, `suppressRepeats`, `noRepeatsInstruction`, `atCapInstruction`, `reviewScopeForRound` — have **zero production callers between them**; every caller is a test. The prompt states the opposite in so many words: nothing carries its findings forward. **This is structural, not an oversight, and that changes what the work is.** The only non-test file naming the module is `lib/scaffold/ai-review-step.ts`, where every mention is prose in a comment — it cannot import, because the step is deliberately import-free so that the suites copying it into a temp directory can build mutants that load. So the first production caller cannot arrive as an import; it has to arrive the way the adjudicator did, as a CLI command the generated bash invokes under a pinned version. **The data path is already complete** — #1319 shipped the ledger writer and #1351 the reader and the per-finding text anchor — so what is missing is the invocation and nothing else.
- **CRC-N5** Nothing runs review agents nightly over existing code.
- **CRC-H2** Risky code requires a human. There is no `CODEOWNERS` and no required approval, so nothing does.

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

So Phase 0 is **one setting applied, one waiting on a quiet queue, one
withdrawn**:

CRC-F1 (`strict: true`), CRC-C3 (`required_conversation_resolution`), CRC-E8
(`required_pull_request_reviews` with `dismiss_stale_reviews`). Minutes, by
the owner. They are first because two further criteria — CRC-E6 and CRC-M9 —
are **vacuous rather than unbuilt** until they land: there is no approval to
count, so nothing can be built that counts one.

Read CRC-F1's caveat before flipping it. A merge queue serialises merges, and
on `merge_group` the review annotates UNMEASURED and passes, so "every check"
would be half true. `strict: true` is the cheaper half and closes the same
hole.

**The trigger for `strict: true` is a number, not a judgement call: open
pull requests ≤ 2, with no agent mid-push.** Under `strict`, every merge
stales every other open pull request, and the repair is
`gh pr update-branch`, which **force-rewrites the contributor's branch** —
including one an agent is pushing to. On 2026-10-23 this repository merged
eleven pull requests with four sessions running; flipping it in that state
converts each merge into five forced rewrites. The hole it closes is real
(an armed PR merging green against a base it never ran against) and it is
not urgent enough to pay that. Flip it at the next quiet queue and then
watch rounds-to-pass: if `strict` costs more rounds than the stale-base hole
does, that is measurable and the criterion should say so.

### Phase 1 — stop the repeats

**The tail is the problem, not the median.** 20.5% of pull requests take five
rounds or more, against their 8.9% before; the mean is only a quarter above
theirs. A minority of PRs is absorbing the loop, and a finding re-posted
every round is, arithmetically, an extra round.

| | Depends on |
|---|---|
| **CRC-N4** — no repeats | nothing. `lib/ai-review-rounds.ts` exports seven functions with **zero production callers between them**. The machinery is built and uncalled. |
| **CRC-B7** — Pre-existing tagging | the changed-file list reaching the adjudicator, and then a release |
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
| **CRC-B4** — verifier quorum | nothing. `lib/finding-jury.ts` holds group size, quorum, per-verifier votes and a disagreement flag; nothing deployed takes a vote |
| **CRC-B6** — A/B the filters | CRC-B4, and a variance control that does not read zero by construction |
| **CRC-B3** — parallel generation | CRC-B4, strictly. Without a quorum, N generators are N chances to block falsely, which is **worse than one** |

### Phase 3 — what the reviewer is told

Cheap, mostly prompt and `REVIEW.md` text, and independent of Phases 1 and 2.
Sequenced third rather than first because a reviewer given more context and
no falsification step produces more confident false premises — so Phase 2
earns the right to do this one.

CRC-A4 (flag a `CLAUDE.md` convention break — the obvious objection does not
apply, see its entry), CRC-B2 (root cause on a bug fix), CRC-B9 (per-repo
Quick/Standard/Deep), CRC-A7 (the summary clause).

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
