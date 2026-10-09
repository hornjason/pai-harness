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
- **A guard with a passing mutant test.** Measured 2026-10-08: wrapping the
  `BLOCKING-GRADES` block (#188) in `if (false)` — wrapper *outside* the markers,
  so the extracted slice is byte-identical — leaves `test/blocking-grades.test.ts`
  at 19 pass / 0 fail. The same mutation on `SECURITY-DECISION` (#129) leaves
  113 pass / 0 fail. Marker extraction proves the extracted text refuses
  correctly. It does not prove the block is reached. See #200.
- **An agent reporting it complied.** Marcus has exceeded the full-suite cap on
  every measured run while the rule text asking otherwise got longer each time.
  Compliance is measured from transcripts, never self-reported (#194).
- **A spec marked done.** Measured 2026-10-08: **no success criterion in this
  repo can fail the conformity suite.** `lib/conformity.ts:289` collects only
  `- [ ] SC-N`, so the 467 checked SCs generate no test; the 107 unchecked ones
  get a body that is `try { assertion(root) } catch { }` with no `expect`
  (`:901-907`). The only test in the block that can go red checks SC *syntax*.
  Promotion is one-way (`scripts/update-project-state.ts:150`), so an SC is
  asserted at most once, on the run that flips it. **The SC count is a tally of
  checkboxes, not evidence**, and no number derived from it belongs in an
  argument.

## Where we actually stand

Measured, with dates. Update this section at the same time as `PROJECT-STATE.md`.

| Claim | Standing (2026-10-08) |
|---|---|
| 1 — gates can fail | Partial. Security gate proven (#129), blocking grades proven (#188). `tsc-pass`, `local-api-validated`, `local-ui-validated` cannot fail (#176). `TestSuiteGuard` cannot fire (#194). |
| 2 — numbers describe the tree | Partial. `TDD_SEQUENCE_VIOLATED` now blocks. Review currency closed post-commit (#169). `test-clean-env.ts` still models the environment, not the CI checkout (#168). |
| 3 — bad ships are stopped | Partial. Security and compliance verdicts now refuse. Not yet audited for every computed verdict. |
| 4 — absence ≠ clean | **No.** `grade-deterministic.ts` writes `{grades:[]}` and exits 0 on no transcripts; the ship.js prompt instructs the same shape (#195, open). |
| 5 — works on another repo | **No, and never attempted.** Every run in this repo's history is rungate shipping rungate. The `~/.rungate/ddb-*` directories are rungate runs under a stale slug, not DDB runs. |
| consumer list | **Surveyed 2026-10-08, and it fails.** Twelve blocking defects found by adversarial audit without running anything. See below. |

Last full suite: 3248 pass / 0 fail under `bun scripts/test-clean-env.ts`
(2026-10-08). That figure is the floor, not the claim — see "What is not success".

### The consumer survey, 2026-10-08

Two adversarial sweeps audited the specs and the never-exercised consumer path
against the claims above. The verdict was **not ready**, and the reasoning is
worth keeping because it is specific:

> On DDB it would execute roughly 2.5% of the test suite, build no container,
> grade no container, discard the only measurement it makes against the
> committed tree, and then open a PR whose body states "Unit tests: PASS."

The worst of it, measured rather than inferred:

- DDB's `dev.testCmd` is `bun test src/**/*.test.ts` — **12 of 491 test files**,
  excluding the conformity test rungate itself scaffolded into DDB and every
  playwright spec DDB's own mandatory gate depends on.
- The container path keys off a `container` config key that **no schema defines,
  no generator emits, and DDB does not have** — so the harness composes its own
  `SKIP: no container` for rebuild, smoke and Quinn, and its ship gate accepts
  all three. DDB's `prod.rebuild` is set and never read.
- Nothing makes DDB non-LIGHT. The tier is only ever *downgraded* in code
  (`ship.js:990`); the upgrade is the discovery agent's free choice. A LIGHT
  verdict skips Quinn, container verify, B1 and B2, and the run still reports
  DONE.
- `runB2EvidenceValidation` is the **only** code that measures the committed
  tree. Its verdicts are written in memory and then discarded by a re-read from
  disk at `gate-executor.ts:1445`.

**Run 1 is an instrument, not a ship.** Low-stakes issue, PR not merged, every
reported number re-measured by hand once. If run 1 reports PASS and the numbers
cannot be independently reproduced, the conclusion is that the harness is still
lying — not that it worked.

## How to use this file

- **Filing an issue:** say which numbered claim it moves. An issue that moves
  none of them is cleanup, and should say so rather than borrowing urgency.
- **Reviewing a PR:** the bar is the claim it cites, not tidiness.
- **Running a sweep or an audit:** pass this file's claims in as the measure.
  A finding that cannot be tied to one of them is a style note.
- **Deciding we are done:** claims 1–5 green and the consumer list measured on a
  real run. Not before, and not by assertion.
