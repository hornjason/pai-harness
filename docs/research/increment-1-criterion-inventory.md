---
doc-type: research
status: active
owner: jason
updated: 2026-10-28
governs: Increment 1 of the code-review convergence work — which criteria have been started, by which pull request, against which issue
---

# Increment 1 — what has actually been built, criterion by criterion

**Generated. Do not hand-edit** — `bun scripts/criterion-inventory.ts --snapshot <dir> --markdown`.
That script's header states the commands that take a snapshot.

Every criterion in `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`, with the issues and the pull
requests that name it. This is the baseline for a board: one row is one card, and the state
is the column it starts in.

## The headline

10 of 61 are ticked, and 2 of those are ticked against a waiver rather than a
proof. 15 more have a test naming them and no tick. The remaining 36 divide into
work that touched code, work that exists only as writing, and work nobody has started — and
before this inventory all of them looked identical, because a checkbox has two states.

## How the state was derived

Mechanical, from the spec and the tracker only. No judgement is recorded here.

| State | Rule |
|---|---|
| DONE | ticked, **and** carrying a `proved-by:` naming what ran |
| WAIVED | ticked, with a complete, signed, unexpired waiver |
| BOUND | not ticked, and a file in `test/` names the id |
| TOUCHED | not ticked, no test names it, and a merged pull request that changed code names it |
| DOCUMENT ONLY | not ticked, and every pull request naming it changed only prose |
| NOT STARTED | not ticked, and nothing in the tracker or `test/` names the id |

A pull request counts as *changing code* when it touched any of `lib/`, `test/`, `scripts/`, `gates/`, `hooks/`, `bin/`, `workflows/`, `config/`, `evals/`, `prompts/`, `.github/`. Pull requests marked `*` changed prose only.

A tick alone never reaches DONE, and an expired or misplaced waiver never reaches WAIVED —
both fall through onto whatever other evidence exists, and the script names them.

## What this cannot tell you

Every column is a word-boundary name match, so a pull request naming an id may have *touched*
the criterion rather than satisfied it, and a test naming an id may be citing it in a comment
rather than claiming it. TOUCHED means *somebody has been here*, never *this is nearly done*.

**The state cannot say how far along something is.** A criterion is a checkbox: done, or not
done. Splitting a broad criterion into narrow ones that can each be proved is a change to the
spec, and it is the main thing this inventory argues for.

Taken 2026-10-28 over 777 issues and 866 pull requests.
Every merged pull request named below has a changed-file reading, so the split between TOUCHED and DOCUMENT ONLY is complete rather than a lower bound.
**Open issues are bold.** Long criteria are cut to their first sentence.

## Ticked, with nothing holding the tick up

None. Every ticked criterion carries either a `proved-by:` naming what ran or a
complete, signed, unexpired waiver.

## DONE — ticked, and it names what proved it — 8 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-A5** | `REVIEW.md` exists per owned area, written by code owners. … | test | `test/ai-review-conventions.test.ts (AC-C10) — 371 pass, 0 fail, 2026-10-28` | — | #1640 #1340 |
| **CRC-A6** | A check reports whether the reviewer actually followed `REVIEW.md`. … | test | `test/ai-review-conventions.test.ts (AC-C1..AC-C9b) — 371 pass, 0 fail, 2026-10-28` | #1509 #1507 | #1640 #1373* #1360 #1340 |
| **CRC-B5** | Findings that are only **style, diagnostics or cleanup** are dropped. | test | `test/issue-filing-gate.test.ts (WIRING + the DROPPED_CATEGORY rows) — 371 pass, 0 fail, 2026-10-28` | — | #1640 #1638* #1366 #1340 |
| **CRC-C4** | A finding clears on its own if a later commit fixes it. | test | `test/ai-review-workflow.test.ts (AC-3b) — 371 pass, 0 fail, 2026-10-28` | — | #1640 #1639 #1638* #1340 |
| **CRC-E1** | Risk tiers are written down: low needs no human, medium one, high two. … | test | `test/risk-tier.test.ts "CRC-E1: the tiers are written down — low none, medium one, high two" — 371 pass, 0 fail, 2026-10-28` | #1442 #1437 | #1640 #1439 #1340 |
| **CRC-E2** | **The change sets the tier, not the author** — a classifier reads the change. … | test | `test/risk-tier.test.ts "CRC-E2: the CHANGE sets the tier, not the author" — 371 pass, 0 fail, 2026-10-28` | #1437 | #1640 #1439 |
| **CRC-E4** | Owner-listed sensitive paths and **any CI workflow file** always require a human. … | test | `test/risk-tier.test.ts "CRC-E4: any CI workflow file, and any owner path, always needs a human" — 371 pass, 0 fail, 2026-10-28` | #1437 | #1640 #1505 #1439 #1340 |
| **CRC-N1** | **A round cap.** After three rounds the reviewer asks the author to step back and reconsider the approach. … | test | `test/ai-review-rounds-step.test.ts (AC-S1..AC-S5) — 371 pass, 0 fail, 2026-10-28` | — | #1640 #1627 #1619 #1614 (+1) |

## WAIVED — ticked against a signed, unexpired excuse — 2 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-B7** | Surviving findings are **sorted by severity** and tagged **Important / Nit / Pre-existing**, so a pre-existing bug does not read as the author's fault. … | test | a waiver that still stands | **#1567** #1587 #1492 #1472 | #1641 #1640 #1598 #1596 (+7) |
| **CRC-M11** | Rounds-to-pass is tracked alongside recall. … | measurement | a waiver that still stands | **#1592** #1586 #1498 #1492 (+3 closed) | #1641 #1640 #1638* #1633 (+14) |

## BOUND — a test names it, and the box is not ticked — 15 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-A1** | The agent is given something runnable and must show the output, not assert completion. | run | `census-routing` `tracked-id-prefixes` `audit-specs-blindness` | — | #1335 #1322 #1298 |
| **CRC-A4** | The reviewer flags code breaking a `CLAUDE.md` convention, AND changes that make a line in it out of date. | test | `review-negative-control` | #1524 #1509 #1507 | #1523 #1516 #1512 #1508 (+1) |
| **CRC-B1** | The reviewer reads the diff against the whole repo **and the PR's stated intent**. | test | `ai-review-rounds-step` | — | #1387 #1373* |
| **CRC-B4** | **A separate group of agents votes on each finding**, and it is surfaced only if enough agree it is real. … | test | `finding-arbiter` `ai-review-jury-gate` | **#1591** **#1481** #1488 #1486 #1476 (+1 closed) | #1630* #1619 #1596 #1484* (+7) |
| **CRC-B8** | **Every finding is answered** — fixed, or resolved with a stated reason. … | test | `ai-review-findings` `ai-review-advisory-findings` `code-review-convergence-spec` | — | #1631* #1625* #1622* #1617 (+5) |
| **CRC-C2** | A PR cannot merge while any bug-review or security-review finding is open. | test | `code-review-convergence-spec` | — | #1631* #1625* #1617 #1360 (+1) |
| **CRC-C3** | A false positive clears by closing the thread with a short reason. | test | `ai-review-carry-forward` | #1469 | #1631* #1625* #1623 #1617 |
| **CRC-E3** | A **second classifier** asks whether this change needs another person even when its tier says no. | test | `code-review-convergence-spec` | #1437 | — |
| **CRC-E9** | Tiers **start strict and loosen with evidence**. | measurement | `code-review-convergence-spec` | #1437 | — |
| **CRC-F1** | A merge queue re-runs every check against main with the change applied. | test | `code-review-convergence-spec` | **#1503** #1469 | #1502 #1435 #1340 |
| **CRC-M12** | **An unreadable round names its mode.** `no_payload` (the action ran and wrote no findings file), `none_posted` (findings were written and none reached the pull request)  … | test | `spec-evidence` | — | #1638* #1637 |
| **CRC-N2** | **Diff-only re-review** after the first few passes. | test | `ai-review-rounds-step` `ai-review-rounds` `ai-review-diff-scope` | **#1601** **#1600** #1586 #1381 | #1629 #1619 #1602 |
| **CRC-N3** | **Flag the class of bug**, so the author fixes every instance rather than one line. | test | `issue-filing-gate` `code-review-convergence-spec` | #1595 | #1627 #1360 #1340 |
| **CRC-N4** | **No repeats** of findings already posted. | test | `ai-review-carry-forward` `ai-review-suppression` `code-review-convergence-spec` | **#1601** **#1600** **#1592** #1586 #1381 | #1634 #1630* #1626* #1625* (+10) |
| **CRC-N5** | Review agents run **nightly over existing code**. | run | `census-routing` `tracked-id-prefixes` | — | — |

## TOUCHED — a pull request that changed code names it; no test does — 19 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-A8** | **Fix at the source.** When the reviewer keeps flagging the same thing, the repair goes into the skill, a lint rule, or an instruction file — not into another finding. | test | — | — | #1627 |
| **CRC-B2** | On a bug fix, the reviewer looks for the root cause. | test | — | #1507 | #1508 |
| **CRC-B3** | **Several agents look for bugs at the same time** (parallel generation). … | measurement | — | **#1481** #1524 #1509 #1507 (+1 closed) | #1630* #1508 #1360 |
| **CRC-B6** | The filters are **A/B tested** against real PRs before being kept, **with variance bounded**. … | measurement | — | **#1591** **#1481** #1509 #1476 | #1630* #1516 #1480 #1298 |
| **CRC-C1** | Security review is a separate automated pass. | test | — | — | #1340 |
| **CRC-E6** | **An agent's approval never counts as a person's.** | test | — | #1437 | #1439 |
| **CRC-E8** | **An approval covers one specific commit**; new commits the system cannot vouch for dismiss it. | test | — | #1437 | #1340 |
| **CRC-F2** | New behaviour ships behind a flag, internal users first. | test | — | — | #1614 |
| **CRC-M1** | **Incidents are an eval.** Past incident-causing PRs, with fix-forwards and reverts, form a case set. | review | — | — | #1508 |
| **CRC-M2** | Each case is **expert-confirmed** — a human who knows the code confirms the bug and where it lived. | review | — | — | #1340 |
| **CRC-M7** | A **clean-PR control** counts how often the reviewer reports something that would have led to a harmful change. … | measurement | — | #1509 | #1616* #1516 #1340 |
| **CRC-M8** | Priority order is stated and enforced: **catching real bugs first, cutting review rounds second.** | measurement | — | #1476 | #1616* #1360 #1340 |
| **CRC-M9** | Human-time metrics tracked — approvals per PR (median and p95), human comments, time waiting on a person. | measurement | — | — | #1340 |
| **CRC-M15** | **The staleness check reads contents, not a version string.** `lib/distribution-standing.ts` makes **two** comparisons on **two different fields**, and neither reads an a … | test | — | — | #1637 |
| **CRC-N6** | **A fixed defect stays fixed.** A finding must not be re-raised from text that merely DESCRIBES it — a docblock quoting the code that was removed, or prose narrating what … | test | — | — | #1630* #1619 |
| **CRC-H1** | Direction, taste and scope — whether to build it at all. | review | — | — | #1340 |
| **CRC-H3** | Architecture that sets a pattern others copy. | review | — | — | #1340 |
| **CRC-H4** | Reading the evidence. … | review | — | — | #1340 |
| **CRC-H5** | Owning the outcome — a person is accountable for every change that ships, whoever typed it. | review | — | — | #1340 |

## DOCUMENT ONLY — the spec and the tracker discuss it; nothing has been built — 5 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-A7** | `REVIEW.md` caps the nits, lists paths to skip, demands file-and-line evidence rather than a guess from a name, and requires a summary that starts with a count and says p … | test | — | #1507 | #1466* #1373* |
| **CRC-B9** | Review depth is configurable per repo as **Quick / Standard / Deep**. | test | — | #1587 #1507 | — |
| **CRC-E5** | Only trusted authors get the lighter paths. | test | — | #1437 | — |
| **CRC-E7** | Whoever prompted the change counts as one of the required reviewers. | test | — | #1437 | — |
| **CRC-M6** | **Noise is measured by what people do with the comments**, in four buckets: fixed it / said it was wrong / said it was intentional / decided it didn't matter. | measurement | — | — | #1616* |

## NOT STARTED — nothing anywhere names it — 12 of 61

| Criterion | What it says | Needs | Test naming it | Issues | Merged PRs |
|---|---|---|---|---|---|
| **CRC-A2** | A fresh-context subagent reviews the diff before the PR opens. | run | — | — | — |
| **CRC-A3** | `CLAUDE.md` is short, states stack/conventions/goals/non-goals, and points elsewhere for detail. | test | — | — | — |
| **CRC-F3** | One-step rollback exists and is exercised. | test | — | — | — |
| **CRC-F4** | Incident reviews ask **which layer should have caught it**. | review | — | — | — |
| **CRC-F5** | Circuit breakers tighten approval when revert/incident rates move. … | measurement | — | — | — |
| **CRC-M3** | **Every new incident adds a case.** | review | — | — | — |
| **CRC-M4** | Any change to the reviewer's prompts, tools or model is **rescored against the whole set**. | test | — | — | — |
| **CRC-M5** | The eval runs **daily**; a change that raises the score is kept, one that does not is dropped. | run | — | — | — |
| **CRC-M10** | **Revert and incident rates are the guardrail.** If they rise, human time was moved, not saved. | measurement | — | — | — |
| **CRC-M13** | **Whether the reviewer READ anything is recorded, separately from whether it WROTE anything.** `lib/review-execution-reading.ts` already computes `toolCallsByName` and `N … | test | — | — | — |
| **CRC-M14** | **Every reading names the published version it was taken under.** CI pins `bunx rungate@<version>`, so a merged change to `lib/` is dormant until a release while a merged … | test | — | — | — |
| **CRC-H2** | Risky code — billing, auto-updater, CI workflows. | review | — | — | — |

