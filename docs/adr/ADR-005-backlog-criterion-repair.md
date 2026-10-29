---
doc-type: adr
status: proposed
owner: jason
created: 2026-10-29
updated: 2026-10-29
---

# ADR-005: Repairing the convergence backlog's criterion links

## The problem, measured 2026-10-29

**11 of the 39 open convergence issues name no criterion.** They sit in a
phase milestone and are invisible to `criterion-inventory`, to `plan-spec`'s
coverage report and to `board-mirror`'s Criteria column — all three read the
criterion id as literal text in the issue body, so an issue that names none
is work nothing can trace back to the spec.

Two readings bound the problem, and they are the reason this is a repair
rather than a rewrite:

- **Every numbered phase is already fully covered.** All 44 phase criteria
  are named by at least one open issue. None of these 11 is filling a gap.
- **The 14 criteria with no issue are all non-phase** — 5 `Done`, 4
  `Blocked — needs a second person`, 1 `Not adopted — deliberate`, 4 `Not
  observable here`. Zero sit in a numbered phase. They correctly have no
  issue, and creating one for any of them would state a plan that is a lie.

So each of the 11 is exactly one of two things, and which one is judgement:

| | What it is | Repair |
|---|---|---|
| **(a)** a second issue decomposing a criterion another issue also names — legitimate, `CRC-B4` already works this way | add the criterion ids to the body |
| **(b)** a reviewer finding or machinery milestoned by mistake | remove it from the milestone — **never close it** |

## Why (b) is a demotion and not a close

Closing destroys the measurement in the body — #1290 carries three dated
`ai-review` runs over byte-identical code, #1533 carries the two `FIRED`
readings of the clean arm. It also moves **both** sides of the opened-against-
closed ratio rule 7 asks us to watch, which is the number that told us a swarm
once ran at three to one. Dropping the milestone is one command, reversible,
and loses nothing.

## The classification

`confidence` is mine and the point of this file is that you can overrule it.
`HIGH` means the issue body states the criterion's own subject matter in its
own words; `MEDIUM` means the subject is adjacent and the link is an argument.

| Issue | Phase | Repair | Criteria | Confidence | Why |
|---|---|---|---|---|---|
| #1168 | 1 | (a) | `CRC-N2` | HIGH | Its subject is re-review scoping — it cites `REVIEW_SCOPE_DIFF`/`REVIEW_SCOPE_FULL` and the round cap. CRC-N2 **is** diff-only re-review after the first few passes. |
| #1365 | 1 | (a) | `CRC-N4` | HIGH | The constants it says are unjustified are `DUPLICATE_CONTAINMENT_RATIO` and `DUPLICATE_MIN_SHARED_QUANTITIES` — the dedupe, which is CRC-N4's mechanism. |
| #1186 | 2 | (a) | `CRC-B3`, `CRC-B4` | MEDIUM | BLOCK over 0 of N on ~30% of runs is the sampled-instrument property CRC-B3 is qualified by, and CRC-B4's quorum is the filter that would subtract it. |
| #1290 | 2 | (a) | `CRC-B3`, `CRC-B4` | HIGH | Three runs over byte-identical code returning CLEAN/BLOCKED/CLEAN is CRC-B3's premise stated as a measurement. |
| #1357 | 2 | (a) | `CRC-B4` | MEDIUM | A blocking finding citing a line absent at the reviewed SHA is a false finding; CRC-B4's quorum is the mechanism that surfaces a finding only if enough agree it is real. |
| #1528 | 2 | (a) | `CRC-B6` | MEDIUM | `scoreReading` cannot tell a fixed plant from a reintroduced one, so the control CRC-B6 requires cannot bound variance. |
| #1533 | 2 | (a) | `CRC-B6` | HIGH | Explicitly about the control's precision arm being unmeasurable — CRC-B6 is *A/B tested with variance bounded*. |
| #1395 | 5 | **(b)** | — | MEDIUM | Tree drift in the ledger step is a sequencing defect in the job. It makes a reading untrustworthy but matches no CRC-M criterion's subject. **Demote unless you see the link I do not.** |
| #1455 | 5 | (a) | `CRC-M12` | MEDIUM | A decline on every open PR is an unreadable round, and CRC-M12 is the criterion that an unreadable round must name its mode. |
| #1643 | 5 | **(b)** | — | HIGH | A judgement naming a nonexistent criterion or issue is census machinery. It serves the traceability tooling, not a convergence criterion. |
| #1226 | 6 | (a) | `CRC-M15` | HIGH | Two checks disagreeing about *tree at N, registry at N−1* is exactly CRC-M15 — the staleness check reads contents, not a version string. |

**9 repairs of kind (a), 2 of kind (b).**

## What happens after this file is approved

1. `plan-issues --repair docs/adr/ADR-005-backlog-criterion-repair.md --write`
   rewrites each (a) issue's body into the template's shape, adding a
   `## Criteria this serves` section, and drops the milestone on each (b).
   Idempotent: a body already carrying the right ids is left untouched.
2. `plan-deps --write` re-derives every edge from the **milestone**, so the
   body edits above cannot corrupt an edge, and a demoted issue loses its
   edges because it has no phase, not because anything deleted them.
3. `board-mirror --ready --write` refreshes the Criteria column and Ready.
4. Nothing here ticks a criterion. `DONE` stays computed by
   `criterion-inventory` from a test naming the id plus a merged PR, and
   `audit-spec-evidence` fails the build on a tick that names no proof.

## What this does not fix

The reading stays **NAMES, not SERVES**. After this repair every convergence
issue will claim a criterion, and nothing will check that the issues claiming
a criterion are *sufficient* to make it true. 42 of the 47 covered criteria
sit at exactly one issue and we cannot tell a whole job from a tenth of one.
That is the next gap, and it is not this one.
