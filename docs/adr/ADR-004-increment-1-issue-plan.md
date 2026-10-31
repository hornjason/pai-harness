---
doc-type: adr
status: accepted
created: 2026-10-29
updated: 2026-10-29
owner: jason
governs: the issues that close the convergence spec's forward coverage gap — what each one is for, which criteria it serves, which files it may touch, and what must land first
---

# ADR-004 Increment 1: the issues that close the forward gap

## Status

**Accepted on 2026-10-31.** The plan it describes is live on the tracker:
#1162, #1167, #1266 and #1425 are all open and carry the scope this ADR
assigns them. An issue plan is implemented by its issues existing, and they
do.

**Status:** Accepted 2026-10-31 — the four issues it plans are open on the tracker
**Deciders:** Jason (owner, authorised creation), Rayford (DA)

## This is a one-off record, not a step in the pipeline

**The board is the plan.** `docs/adr/ADR-003-spec-to-tracker-mapping.md` is the
standing architecture; this file is not a second copy of it and nothing in the
spec→tracker flow reads it. It exists for one reason, stated below: the filing
cap needs the unit of work fixed in a reviewable artefact *before* anything is
created, and a batch of eighteen has nowhere else to be fixed. Once the issues
exist, the tracker carries every fact this file carries, and this becomes a
record of what was reserved on 2026-10-29 rather than a document anyone works
from.

It was numbered ADR-003 when it was written, colliding with the mapping ADR.
Renumbered to 004, which is the only thing that changed.

## What this file is, and why it exists before the issues do

Step 3 of `docs/adr/ADR-003-spec-to-tracker-mapping.md` is the open gap: a
criterion's coverage comes from an issue body naming it, and most of them are
named by nothing. Measured on 2026-10-29 with

```bash
bun bin/rungate.ts plan-spec specs/CODE-REVIEW-CONVERGENCE-SPEC.md \
  --repo hornjason/rungate --prefix Convergence --project-root .
```

of the 44 criteria the placement table puts in a phase, **8 are named by an
open issue and 36 are not**, and Phases 3, 4 and 6 have zero coverage between
them.

**This file is the reservation, and that is the point of writing it first.**
`lib/issue-filing-gate.ts` caps filing at one per checkout per 24 hours, and
the cap exists because *a gate whose unit the filer chooses is not a gate* — an
agent that decides for itself how much to file has no cap at all. A committed
plan moves the unit out of the filer's hands: the issues below are data, fixed
in a reviewable artefact before anything is created, and anything not in this
file is not covered by it.

## The rule applied first: edit before you file

Three of the 36 criteria are already the subject of an open issue that simply
does not name them. Those are **body edits, not new issues** — rule 7 of
`AGENTS.md` watches issues opened against issues closed, and a swarm once ran
that ratio at three to one. An issue that already describes the work is
coverage; it is missing one line, not missing entirely.

| Issue | Criteria to add | Why it already serves them |
|---|---|---|
| #1167 | CRC-B1, CRC-A4 | Its two numbered sections are *"it cannot see the repo's own rules"* and *"it cannot see what the change is for"*. CRC-B1 is the reviewer reading the diff against the whole repo **and the PR's stated intent**; CRC-A4 is flagging code that breaks a `CLAUDE.md` convention. Both are that issue's subject. |
| #1162 | CRC-B8 | Its title is *"findings are discarded four ways"*. CRC-B8 is **every finding is answered** — never silently dropped. Same defect, stated from the spec's side. |
| #1266 | CRC-M15 | CRC-M15 names `lib/distribution-standing.ts` explicitly and says the staleness check must read contents rather than a version string. #1266 is about what evidence that tolerance is gated on. |

## The eighteen new issues

Grouping is judgement and `rungate plan-spec` deliberately refuses to do it
(ADR-003, *Cardinality*): a criterion usually needs several issues and an issue
usually serves several criteria, and one issue per criterion is a named
anti-pattern that would push the opened-against-closed ratio past 1. The
constraint that bounds it is structural — **a milestone is single-valued, so
every issue below serves criteria from exactly one phase.**

Each row states the files it may touch, because rule 2 of `AGENTS.md` says an
issue that cannot name them is not ready, and rule 3 caps it under ten.

### Phase 0 — three settings, no engineering (milestone #3)

**P0-1 · Neither Phase 0 setting is configured: an approval survives a new
commit, and a false positive has no clearing step**
Serves CRC-C3, CRC-E8. Files: `.github/`, `docs/`.
CRC-E8 is a branch-protection setting — dismiss stale approvals — and
`reference/pai-harness-branch-protection.md` records `strict: false` with no
review requirement at all. CRC-C3 is the documented step for clearing a false
positive by closing the thread with a reason. Both are settings and prose;
neither is engineering, which is what the phase is named for.

### Phase 1 — stop the repeats (milestone #4)

**P1-1 · A finding names one site when the defect has siblings: nothing asks
the reviewer for the class**
Serves CRC-N3. Files: `lib/scaffold/ai-review-step.ts`, `prompts/`.
Blocked by: nothing.

### Phase 2 — stop the false findings (milestone #5)

**P2-1 · A fixed defect can be re-raised from text that only describes it**
Serves CRC-N6. Files: `lib/ai-review-findings.ts`, `lib/ai-review-rounds.ts`.
The carry-forward key is file plus text plus summary, so a docblock quoting
the code that was removed, or prose narrating what the bug used to be, reads
as the bug still being present. This is the shape #1601 found from the other
direction — anchors by line number — so it is a sibling of that issue, not a
duplicate of it.

### Phase 3 — what the reviewer is told (milestone #6)

**P3-1 · `REVIEW.md` exists and states none of the four things the criterion
asks of it**
Serves CRC-A7. Files: `REVIEW.md`, `templates/`, `lib/scaffold/`.
CRC-A5 and CRC-A6 are ticked — the file exists and is owned. A7 is about its
CONTENTS: a nit cap, paths to skip, file-and-line evidence rather than a guess
from a name, and a summary that starts with a count and says plainly when
there is nothing to fix.

**P3-2 · On a bug fix the reviewer is never told to look for the root cause**
Serves CRC-B2. Files: `lib/scaffold/ai-review-step.ts`, `prompts/`.

**P3-3 · Review depth has no config key and no reader**
Serves CRC-B9. Files: `lib/config-loader.ts`, `lib/config-readers.ts`,
`lib/scaffold/ai-review-step.ts`, `.claude/rungate/config.json`.
Quick / Standard / Deep is named in the spec and nowhere in the tree. **Write
the reader in the same change as the key** — `feedback-a-flag-with-no-reader`
is a live instance here: `voiceEnabled` has no reader and two hooks speak
anyway.

### Phase 4 — findings get answered, and repeats get fixed at the source (milestone #7)

**P4-1 · Nothing hands an agent something runnable, and no fresh-context
review happens before the PR opens**
Serves CRC-A1, CRC-A2. Files: `.claude/rules/`, `workflows/`, `prompts/`.

**P4-2 · A repeat finding has nowhere to go except another finding**
Serves CRC-A3, CRC-A8. Files: `CLAUDE.md`, `.claude/rules/`, `lib/`.
CRC-A8 is *fix at the source* — when the reviewer keeps flagging the same
thing the repair belongs in a skill, a lint rule or an instruction file.
CRC-A3 is the shape of `CLAUDE.md` that makes that possible. They are one
piece of work: there is no point routing repairs into a file with no contract.

### Phase 5 — the instruments (milestone #8)

**P5-1 · There is no incident case set**
Serves CRC-M1, CRC-M2, CRC-M3. Files: `evals/`, `docs/`.
Past incident-causing PRs with their fix-forwards and reverts, each one
confirmed by somebody who knows the code, and a standing rule that every new
incident adds a case. **CRC-M2 needs a person and cannot be closed by an
agent alone** — that is a genuine `Blocked — needs a second person`, and the
issue must say so rather than looking available.

**P5-2 · A change to the reviewer is never rescored, and no eval runs daily**
Serves CRC-M4, CRC-M5. Files: `evals/`, `.github/workflows/`.
Blocked by: P5-1. There is nothing to rescore against until the case set
exists.

**P5-3 · Noise and harm are both unmeasured**
Serves CRC-M6, CRC-M10. Files: `lib/`, `scripts/`, `evals/`.
CRC-M6 is four buckets of what a person did with a comment — fixed it, said it
was wrong, said it was intentional, decided it did not matter. CRC-M10 is the
revert and incident rate, which is the guardrail that says whether human time
was moved rather than saved.

**P5-4 · The clean-PR control exists and is bound to nothing**
Serves CRC-M7. Files: `evals/ai-review-control/`, `test/`.
The criterion already says `(exists, evals/ai-review-control/)`. What it does
not have is a reader: no gate, no CI job and no score. #1533 and #1528 are
about that control's precision arm and sit in Phase 2, so they cannot carry a
Phase 5 criterion — a milestone is single-valued.

**P5-5 · Risk tiers never loosen, and no second classifier asks for a person**
Serves CRC-E3, CRC-E9. Files: `lib/risk-tier.ts`, `test/risk-tier.test.ts`.
CRC-E1, E2 and E4 are ticked against `test/risk-tier.test.ts`, so the tier
mechanism is real; these two are the parts that were not built.

**P5-6 · An unreadable round says neither its mode nor whether the reviewer
read anything, and carries no version**
Serves CRC-M12, CRC-M13, CRC-M14. Files: `lib/review-execution-reading.ts`,
`scripts/read-review-execution.ts`, `lib/scaffold/ai-review-step.ts`.
**Blocked by: Jason reviewing the Increment-1 plan.** This is the one piece of
work that is not to start before he has read it, and the issue must carry that
as a dependency rather than a sentence, or nothing can see it.
Two live readings to use rather than re-derive: #1637's advisory lane reported
`tool calls: 13 … reviews added: 0 — NO_REVIEW_POSTED`, and #1639's reported
`Argument list too long` with `tool calls: UNREADABLE`. The ADVISORY lane can
say both because `lib/review-execution-reading.ts` is wired into it; the
REQUIRED reviewer can say neither. That is the whole case, already observed.

### Phase 6 — release and detection (milestone #9)

**P6-1 · Security review is not a separate required pass, and an open finding
does not block merge**
Serves CRC-C1, CRC-C2. Files: `.github/workflows/`, `lib/scaffold/`.
Read `feedback-the-security-review-is-a-local-plugin` first: the security
review here is a local plugin, not repository CI, and measuring the wrong one
has already cost a round.

**P6-2 · No flag, no exercised rollback, no circuit breaker**
Serves CRC-F2, CRC-F3, CRC-F5. Files: `lib/`, `.github/workflows/`, `docs/`.
CRC-F5 is marked in the spec as an admitted gap on the source's own side,
adopted as a target rather than a copy; the issue should not read as though
somebody else has solved it.

**P6-3 · An incident review never asks which layer should have caught it, and
the risky paths are not named**
Serves CRC-F4, CRC-H2. Files: `docs/`, `.claude/rules/`.
CRC-H2's risky code here is billing, the auto-updater and CI workflows — of
those, CI workflows are the one this repository actually has.

**P6-4 · Review agents never run over existing code**
Serves CRC-N5. Files: `.github/workflows/`, `lib/scaffold/`.
A nightly sweep over code that is already merged, as opposed to a review of a
diff.

## What this plan does to the ratio, stated plainly

The seven-day baseline, taken 2026-10-29:

```bash
gh issue list --repo hornjason/rungate --state all    --limit 1000 --json createdAt -q '[.[]|select(.createdAt>="2026-10-22")]|length'  # 267 opened
gh issue list --repo hornjason/rungate --state closed --limit 1000 --json closedAt  -q '[.[]|select(.closedAt >="2026-10-22")]|length'  # 237 closed
gh issue list --repo hornjason/rungate --state open   --limit 200  --json number    -q 'length'                                         #  46 open
```

**1.13 opened per closed over the week, before these eighteen.** Adding them
takes the week to 285 against 237, or 1.20. Both are above 1 and the backlog
diverges on either.

(The first draft of this paragraph said *"three closed earlier today — #1425,
#1559 and #1565"*. All three are open: they were triaged as *appearing* fixed
and that reading was withdrawn, because every one of them was a mention in a
docblock rather than a fix. Exactly one issue has closed since 2026-10-28,
#1548. The number is now the output of the commands above rather than a
recollection.)

Eighteen against one is the honest framing, and it is
defensible exactly once, because these are not review findings: they are
the already-agreed contents of a spec being made visible on the tracker, and
the alternative is a board that cannot say what is left. It is not a
precedent, and the next measurement of the ratio should exclude them by name.

## What is deliberately not here

- **Any issue for a criterion the table does not place in a phase.** Seventeen
  criteria sit under `Done`, `Blocked`, `Not adopted — deliberate` or `Not
  observable here`, and filing against those would turn a state into a queue.
- **The backward direction.** 35 of the 46 open issues name no criterion, and
  most of them are reviewer findings that legitimately serve none. Nothing
  here closes that, and nothing here should be read as closing it.
