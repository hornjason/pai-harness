---
doc-type: reference
status: active
owner: jason
updated: 2026-10-08
---

# What we are building, and how we will know it worked

This file exists because nothing else in the repo said it. `PROJECT-STATE.md` is a
session log, `HARNESS.md` is a reference, and the specs each govern one mechanism.
None of them states the target, so every agent — and every sweep looking for
defects — has been pattern-matching against "is this code good" instead of
measuring against "does this get us there."

Read this before deciding whether a finding matters.

## The thing

A ship harness someone else can point at their own repository, from a GitHub
issue to a merged PR, **and trust the result without re-measuring it by hand.**

The product is not the automation. Automation that ships the wrong thing quickly
is worse than no automation, because the report is believed. The product is the
**trustworthiness of the report**.

## Done, for the harness

Five claims. Each is falsifiable, and the check is named. A claim with no check
is not on this list.

1. **Every gate can fail, and has been observed failing.**
   Check: for each gate, a test that breaks the guarded thing and watches the
   gate go red — see `.claude/rules/checks-must-be-able-to-fail.md`. Source-text
   assertions do not count; the marked block is extracted and executed, and a
   mutant with the refusal removed must ship where the real one refuses.

2. **Every number a run reports describes the committed tree.**
   Check: no figure in a run summary may originate before the final source
   change it describes. `TDD_SEQUENCE_VIOLATED` is exactly this claim failing,
   and it now blocks (#188).

3. **A bad ship is stopped, not described.**
   Check: for each verdict the harness computes — security, compliance grade,
   review currency, commit receipt — something reads it and can return
   `SHIP_FAILED`. A verdict that only reaches a log line or a trend file does
   not satisfy this.

4. **"Could not measure" never reads as "nothing wrong."**
   Check: for each guard, the absent / empty / corrupt / errored input is a
   distinct, tested outcome from the clean one. Fail-open is permitted where
   it is the right call, but it must be **loud** — invisible fail-open is the
   defect, a recorded one is a tradeoff.

5. **The harness works on a repo that is not this one.**
   Check: a full run with `projectRoot !== harnessRoot`, on the monolith config
   layout, at a non-LIGHT ceremony tier. Until that has happened, every claim
   about consumer support is untested.

## Done, for a consumer

This is the acceptance test for the first Daily Brief Dashboard run. It is
narrower than "the run passes" on purpose — a run that *fails honestly* passes
this list; a run that *succeeds dishonestly* fails it.

- The harness reads DDB's `.claude/rungate.json` (legacy monolith) and gets the
  same answers `loadRungateConfig` would give for the directory layout. A reader
  that understands only one layout is a defect, not a limitation.
- Non-LIGHT tier is taken because `pages` is non-empty, Quinn actually executes,
  and Quinn's verdict is recorded from what Quinn returned — not from the tier.
- A preflight that cannot reach the remote runner refuses or records its own
  failure. It does not produce an empty result that later reads as satisfied.
- The run does not leave DDB in a state DDB's own rules forbid. DDB mandates
  build → test container 7776 → playwright → production 7777; the harness either
  honours that sequence or stops before the step that would skip it.
- Every gate the run reports as PASS was actually executed against DDB's tree.
  A gate that is structurally unable to fail on a consumer is reported as
  unexecuted, not as passed.

## What is not success

Each of these has happened in this repo and was mistaken for progress.

- **A green suite.** The suite has been green while a gate had never once run in
  CI, while a test compared two empty arrays, and while a documented typecheck
  had no `tsconfig.json` to read.
- **A passing gate.** `tsc-pass` was two early returns and an empty tail (#176).
- **A merged PR.** PR #187 merged, reported `regressions: 0`, and went red in CI,
  because the count predated the final edit.
- **An agent reporting it complied.** Marcus has exceeded the full-suite cap on
  every measured run while the rule text asking otherwise got longer each time.
  Compliance is measured from transcripts, never self-reported (#194).
- **A spec marked done.** SC-478, SC-479 and SC-511 are source-text existence
  assertions still ticked. A criterion satisfiable by a comment is a wish.

## Where we actually stand

Measured, with dates. Update this section at the same time as `PROJECT-STATE.md`.

| Claim | Standing (2026-10-08) |
|---|---|
| 1 — gates can fail | Partial. Security gate proven (#129), blocking grades proven (#188). `tsc-pass`, `local-api-validated`, `local-ui-validated` cannot fail (#176). `TestSuiteGuard` cannot fire (#194). |
| 2 — numbers describe the tree | Partial. `TDD_SEQUENCE_VIOLATED` now blocks. Review currency closed post-commit (#169). `test-clean-env.ts` still models the environment, not the CI checkout (#168). |
| 3 — bad ships are stopped | Partial. Security and compliance verdicts now refuse. Not yet audited for every computed verdict. |
| 4 — absence ≠ clean | **No.** `grade-deterministic.ts` writes `{grades:[]}` and exits 0 on no transcripts; the ship.js prompt instructs the same shape (#195, open). |
| 5 — works on another repo | **No, and never attempted.** Every run in this repo's history is rungate shipping rungate. |
| consumer list | Unmeasured. All five items await the first DDB run. |

Last full suite: 3248 pass / 0 fail under `bun scripts/test-clean-env.ts`
(2026-10-08). That figure is the floor, not the claim — see "What is not success".

## How to use this file

- **Filing an issue:** say which numbered claim it moves. An issue that moves
  none of them is cleanup, and should say so rather than borrowing urgency.
- **Reviewing a PR:** the bar is the claim it cites, not tidiness.
- **Running a sweep or an audit:** pass this file's claims in as the measure.
  A finding that cannot be tied to one of them is a style note.
- **Deciding we are done:** claims 1–5 green and the consumer list measured on a
  real run. Not before, and not by assertion.
