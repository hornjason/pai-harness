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
- [ ] CRC-B3: **Several agents look for bugs at the same time** (parallel generation).
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

- [ ] CRC-E1: Risk tiers are written down: low needs no human, medium one, high two.
- [ ] CRC-E2: **The change sets the tier, not the author** — a classifier reads the change.
- [ ] CRC-E3: A **second classifier** asks whether this change needs another person even when its tier says no.
- [ ] CRC-E4: Owner-listed sensitive paths and **any CI workflow file** always require a human.
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
- [ ] CRC-M11: Rounds-to-pass is tracked alongside recall.

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

Of the 56: **5 bound**, **8 where a mechanism exists that nothing in this
repository can observe**, **1 declared deviation**, **42 not done**.

An unticked box is one of the last three, and they are different facts. The
second is recorded here because an unticked box that nobody can ever tick
looks exactly like work nobody has started.

### A mechanism exists; this repository cannot observe it

Do not tick these, and do not count them as remaining work either.

| Criterion | What exists | Why no test here can read it |
|---|---|---|
| CRC-C1 | The security review runs as a local Claude Code plugin an agent invokes per session. | It is not repo CI. `.github/workflows/` contains no security pass, so no artefact in this tree records that one ran. |
| CRC-C2 | **The bug-review half holds.** `test` and `ai-review` are required contexts on `main` with `enforce_admins` on, so a blocking finding reds the check and the merge is refused. Read from the API on 2026-10-23. | Branch protection is GitHub state, not tree state. The security-review half does not hold at all — there is no security check to require, and `required_conversation_resolution` is `false`, so an open thread blocks nothing. |
| CRC-M2 | `REVIEW_OUTCOME_PLANTS` holds four findings whose outcome was established independently. | Expert confirmation is a human act, and those four grade the outcome sweep rather than an incident case set. |
| CRC-N3 | `REVIEW.md` asks for the class and not the line, and CRC-A6's check proves the reviewer read it. | Whether it complied is a property of a sampled model. No artefact records a finding the reviewer generalised. |
| CRC-H1, CRC-H3, CRC-H4, CRC-H5 | Statements about human judgement. | Nothing distinguishes them being honoured from them being ignored. |

### Not done — the remainder, with what is there instead

42 criteria, listed because the near-misses are the expensive ones: each has
something in the tree that resembles it and is not it.

- **CRC-A1** `missingEvidenceViolations` requires a runnable command per AC and `gates/workflow.test.ts` enforces it — but only inside a harness ship run, and `ship.mode` is `direct`. Dormant on the lane this project ships on.
- **CRC-A2** Nothing makes a fresh-context subagent review the diff before the PR opens. The generated pre-push hook runs conformity tests, not a review.
- **CRC-A3** `scripts/check-instruction-surface.ts` holds `CLAUDE.md` under a byte budget. Nothing checks it states stack, conventions, goals and non-goals.
- **CRC-A4** The second half holds — `REVIEW.md` names "a line that was true of a previous revision and is now false" as a defect class. The first does not: nothing tells the reviewer to flag code breaking a `CLAUDE.md` convention.
- **CRC-A7** Three of four clauses hold in `REVIEW.md`: a cap of three non-blocking findings, a "Do not flag" path list, and file-and-line evidence. The fourth does not — nothing requires a summary opening with a count, and a CLEAN reading prints no summary at all.
- **CRC-A8** No path routes a repeated finding into a skill, a lint rule or an instruction file. `lib/rule-promotion.ts` promotes from compliance failures, not from review findings.
- **CRC-B1** The prompt says to read the whole branch. It never hands the reviewer the pull request's stated intent.
- **CRC-B2** The prompt says nothing about root cause on a bug fix.
- **CRC-B3** One reviewer agent per round.
- **CRC-B4** `lib/finding-jury.ts` has the group size, the quorum, per-verifier votes and a disagreement flag. `arbitrate`, the only path that reads them, has no caller outside `lib/`, `test/` and `scripts/arbitrate-finding.ts`. Nothing deployed takes a vote.
- **CRC-B6** `compareReviewOutcomes` and `evals/ai-review-control/variance-capture.ts` exist. No filter has been A/B tested before being kept, and the variance control reads zero by construction — see below.
- **CRC-B7** `SEVERITY_RANK` tags Important / Nit / Pre-existing. The deployed annotation renders findings in payload order, under the reviewer's own severity words, with no pre-existing tag.
- **CRC-B8** Half. A duplicate or a dropped-category filing is refused at the chokepoint; ALLOW is still the default for a novel finding, and nothing requires any finding to be answered.
- **CRC-B9** No per-repo review depth. `ceremonyTier` LIGHT / STANDARD / THOROUGH is the harness gate ceremony, a different axis.
- **CRC-C3** The reviewer is told not to post comments and `required_conversation_resolution` is `false`. There is no thread to close with a reason.
- **CRC-E1, CRC-E2, CRC-E3, CRC-E5, CRC-E7, CRC-E9** No risk tiers exist anywhere in the tree.
- **CRC-E4** The thing that looks like this is its inverse. The action refuses to review a pull request whose `.github/workflows/ai-review.yml` differs from the default branch's — one file, not any CI workflow file — and the documented escape, the `ai-review-override` label, **waives the check** rather than routing to a person. Branch protection requires zero approvals, so there is no human state to route to.
- **CRC-E6** Branch protection declares no required reviews, so no approval counts toward anything and the criterion is vacuous rather than satisfied.
- **CRC-E8** No required reviews means no stale-review dismissal, and `strict` is `false`, so a branch need not even be up to date. `gh pr merge --match-head-commit` is a convention agents follow by hand; nothing enforces it.
- **CRC-F1** There is no merge queue. `gh api …/rulesets` returns `[]` and branch protection declares none. `.github/workflows/ai-review.yml` carries a `merge_group:` trigger, and on that event the job annotates UNMEASURED and passes, saying in its own text that the per-head review is the measurement. The trigger is readiness for a queue, not the criterion.
- **CRC-F2** Several `vars.*` switches gate behaviour. None stages by audience.
- **CRC-F3** No one-step rollback, and none exercised.
- **CRC-F4** No incident review asks which layer should have caught it.
- **CRC-F5** No circuit breaker. The source admits this as a gap on their side too.
- **CRC-M1** One subject directory, holding an authored plant and two clean variants. Not a case set drawn from past incident-causing pull requests.
- **CRC-M3** Nothing adds a case when an incident happens.
- **CRC-M4** Nothing rescores the whole set when the reviewer's prompt, tools or model change.
- **CRC-M5** No schedule runs the eval. The only crons in the tree are `.github/workflows/issue-audit.yml` daily and `.github/workflows/action-pins.yml` weekly.
- **CRC-M6** One bucket of four is derived from evidence. The other three report UNMEASURED unless hand-declared, and `noiseRate` is `null`.
- **CRC-M7** The control exists and counts `FIRED` on clean subjects. The criterion's own number — findings that *would have led to a harmful change* — is declared UNMEASURED by the control's README, because a finding carries no remedy anything can apply. A tripwire in `test/review-negative-control.test.ts` reds the day the contract grows one.
- **CRC-M8** Stated **and enforced** is the claim. What is stated here is the opposite order, deliberately, and nothing enforces either — see the deviation added below.
- **CRC-M9** Nothing tracks approvals per pull request, human comments, or time waiting on a person.
- **CRC-M10** Nothing tracks revert or incident rates.
- **CRC-M11** The round number is computed per run and retained nowhere. Nothing tracks rounds-to-pass beside recall.
- **CRC-N4** `suppressRepeats`, `carryForward` and `noRepeatsInstruction` are defined and tested, and have no caller outside their own file. The prompt states the opposite in so many words: nothing carries its findings forward.
- **CRC-N5** Nothing runs review agents nightly over existing code.
- **CRC-H2** Risky code requires a human. There is no `CODEOWNERS` and no required approval, so nothing does.

## Known deviations, declared

A deviation is legitimate when it is written here with its reason. An undeclared one is drift.

| Deviation | Reason | Revisit when |
|---|---|---|
| **CRC-M8 inverted — precision is ranked above recall.** | Found undeclared by the 2026-10-23 audit, and argued at length in `evals/ai-review-control/README.md`: the source's order is right when a human absorbs the noise, and nobody absorbs it here. A false blocking finding costs a remedy commit, a CI round, a review round and an agent's whole context, so `MISSED` and `FIRED` are reported as failures of equal weight. | A human is reading the findings again, or the cost of a false block falls. |
| **CRC-N2 diff-only re-review NOT adopted.** Scope stays `full`. | The generated step argues scope must stay full until an adjudicator re-emits unresolved prior findings; dropping to diff-only first would lose them silently. | An adjudicator re-emits unresolved findings. |
| **CRC-B8 inverted — we file issues instead of blocking threads.** | Historical accident, not a decision. **This is the defect, not a deviation.** | #1261. Highest priority in the spec. |
| **Findings routed to an open PR touching the same file.** Not in the source. | Measured: 45% of filings that name a file had an open PR on it. Addresses CRC-B8 in our tracker-shaped world. | Once CRC-B8 holds, this may become unnecessary. |

## Measured non-obvious facts about our own instruments

Recorded because each one invalidates a naive reading of the criteria above.

- **`ai-review` is a sampled instrument, not an enumerated one.** `lib/scaffold/ai-review-step.ts` reviewed CLEAN on #1262 and BLOCKED on #1274 about an hour later, both at `scope=full`, with the flagged construct byte-identical across the two heads (content hash equal; whole-file hash differing as the control). **A green review means this run did not find this thing.** Any criterion scored by comparing reviewer verdicts across runs is reading a sample.
- **CRC-M6's four buckets are not all measurable here yet.** Three of the four — wrong / intentional / didn't matter — report `UNMEASURED` rather than 0, because closing comments follow no parseable convention. `noiseRate` is `null`, not `0`.
- **There is nothing deployed for a quorum to vary, so its variance control reads zero by construction.** The live filing path is `hooks/VerifyPhaseLock.hook.ts` → `filingGate` → `adjudicateFiling`, which runs a category regex over the title and set arithmetic over symptom keys and nothing else — no clock, no randomness, no network, no model. `arbitrate`, the five-stage path that takes votes, has exactly one caller outside `lib/` and `test/`: `scripts/arbitrate-finding.ts`. So twenty runs of the single adjudicator report one distinct outcome set, and **a quorum would introduce variance here rather than reduce it**. Calling the quorum "the variance control" inverts which way the causation runs.
- **Two of the residues do not close by running the measurement more times.** A withheld candidate leaves no downstream trace — never filed, never commented on, never fixed — so the outcome graph it would have to be read from is one it never entered; and a finding nobody acted on leaves no trace from the other side either. Raising the run count does not help, because there is no artefact to read at any count.
- **A ratchet whose two sides are checked by different instruments, one of which is never run, reports the unchecked side as passing.** `test/closing-keywords.test.ts` asserts the keyword-derived close set against the live `project-state.json` on every suite run. The declared set is only checked against real issue states under `--issue-states github`, which `test/state-record-closes-mutation.test.ts` describes as the live path and deliberately never exercises — the suite drives that code against planted fixture files instead. So a record can declare an issue closed that is open, and nothing in CI says so. Measured 2026-10-23 while repairing the session record: an intermediate draft declared three issues closed, of which one is still open at the time of writing and two were open when the reading was taken and closed later the same day. The record on `main` no longer declares them, which is the repair and not a reason the gap is closed.
- **The dedupe corpus is untrusted.** This repo is public, so any open issue — including one opened by a stranger — is an input that can suppress a legitimate finding.
