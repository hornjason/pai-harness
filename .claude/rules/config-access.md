---
description: Every rungate config read goes through lib/config-loader.ts — both layouts, and a corrupt config is never a missing one
doc-type: reference
status: active
owner: jason
updated: 2026-10-19
---

## Config access — one loader

All rungate config reads go through `lib/config-loader.ts`. Never construct a
path to `.claude/rungate.json` or `.claude/rungate/*` anywhere else.

| You want | Call | On absent config |
|---|---|---|
| config, and you cannot run without it | `loadRungateConfig(root)` | throws |
| config, and running unscaffolded is normal | `tryLoadRungateConfig(root)` | `null` |
| to *report* which case you hit | `resolveConfig(root)` | `{ status: "absent" }` |
| just the roles / slug / remote hosts | `lib/config-readers.ts` | `{}` / `null` / `{}` |

All three throw on malformed JSON. **A corrupt config is never a missing
config** — that distinction is the whole point, and conflating them is how #70
stayed silent for a month.

`workflows/*.js` cannot import (#69). It complies across a subprocess
boundary: `scripts/resolve-config.ts` writes the resolved config into the
run's work directory and every prompt reads that file. Never `cat` the
project's config from a prompt.

## Never do

- **Never `catch {}` around a config read.** It converts corruption into
  absence. `lib/scanner.ts:427` is the live instance: it is the one production
  caller of the throwing loader and it catches the throw, so the site counted
  as migrated while behaving exactly as it did before.
- **Never read only `.claude/rungate.json`.** Both layouts are supported
  indefinitely — consumers in the wild are on both. A monolith-only read means
  a consumer who followed the documented migration silently gets nothing, and
  that has already switched off the ceremony tier control (#310), custom
  matchers (#212/#90), role grading, pre-flight checks and the
  task-completion conformity run (#214).
- **Never substitute a built-in default for absent config without recording
  that you did so.** Anti-pattern: *Silent Default Substitution*. A present
  config with empty contents must be loud. `0`, `{}`, `null` and `SKIP` are
  all indistinguishable from success; `UNMEASURED` is not.

## An absent credential is UNMEASURED, not a silent pass

*Silent Default Substitution* again, in the place it does the most damage: a
generated CI job that cannot authenticate. A tree with no credential has not
**passed** an AI review — it has not **had** one, and those are different
states. Only one of them is reportable, so say which.

The rule for `lib/scaffold/ai-review-step.ts` and anything shaped like it:

- **Resolve the mode inside `run:`, never in an `if:` expression.** `secrets`
  is not available in `if:` at all — `${{ secrets.X != '' }}` fails workflow
  validation — and `vars` is, which makes a `vars` condition the tempting fix
  and the worse one: a step skipped by `if:` reports **skipped**, and a
  skipped required check can be treated as satisfied. That is a green
  required check for a review that never ran.
- **Emit a warning annotation naming the state UNMEASURED.** Exiting zero
  with no output is the silent default. `GCP_SA_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are the credentials the
  step resolves a mode from, and the annotation names all three, because a
  warning that does not say what was missing is a warning nobody can act on.
- **Let the consumer decide whether UNMEASURED is fatal, and read the switch
  exactly.** `vars.RUNGATE_REQUIRE_AI_REVIEW` turns the refusal on when it is
  the string `true` and at no other value — not `TRUE`, not `1`, not a
  prefix. A loose reading of a variable that turns a gate on is a gate that
  turns itself on by accident, and the honest default for a tree that has
  never configured a credential is an annotation, not a red pipeline on the
  first scaffold.
- **Route the non-zero exit through one exported constant.** One site to
  mutate, so a test can prove the refusal is what the case observed. A later
  branch that inlines its own literal bypasses the mutation and the case goes
  green having witnessed nothing —
  `.claude/rules/checks-must-be-able-to-fail.md`.

## Worked instance: the Layer 1 compliance report (#597)

The credential case above is a scan that could not authenticate. This is the
same shape with the tool itself missing, and it lives in the tree rather than
in a generated CI job, so it is the one to read if you are about to write
anything that summarises external tools.

`lib/compliance.ts` scores the instruction surface with agnix and RepoRails.
`lib/tool-probe.ts` has told it `absent`, `errored` or `available` since #626
— and `runTemplateCompliance` read `.available` off each probe at the door and
kept nothing else. Two consequences, both *Silent Default Substitution*:

- A report produced with agnix missing is **byte-indistinguishable** from one
  produced with agnix installed and silent. CI installed neither tool at the
  time, which is how #597 was re-run red to green on an identical SHA with
  nothing in the artefact saying why. **It installs both now, pinned**, and
  the two statements were allowed to contradict each other in this tree for
  three weeks — #755 is the issue that noticed. Measured 2026-10-19:
  `.claude/rungate/config.json` declares both `agnix` and `@reporails/cli`
  under `ci.globalTools`, each at an exact version, and
  `.github/workflows/ci.yml:35` is the single `npm install -g` line generated
  from it, inside the sharded `test` job. The versions are deliberately not
  quoted here — the config is the one declaring position and
  `test/ci-global-tools.test.ts` refuses a second one, prose included. So
  `at least one external tool is available` passing in CI is not a probe
  reporting availability it does not have.
- `overallQuality` was the mean of whatever came back. With one tool out that
  is **an average over the files the other tool happened to reach**, and it
  prints as an ordinary number beside an ordinary PASS. A number is
  indistinguishable from success.

What it does now, and the parts worth copying:

- **Keep the whole reading, derive the boolean.** `toolProbes` carries the
  full `ToolProbe` per tool; `toolsAvailable` is a projection of it, so every
  caller that only wanted "can I run this" is unchanged and nothing had to be
  migrated to buy the honesty.
- **Name every tool and its own reason.** "A tool was unavailable" is not
  actionable: installing something fixes `absent` and does nothing for
  `errored`. The reading lists each failing tool, its outcome and the probe's
  own line.
- **Withhold the derived number; do not average what is left.**
  `overallQualityOf` returns `null` under an UNMEASURED reading. One binding,
  so there is one thing to mutate.
- **One discriminator, not two.** `reading.reading === "UNMEASURED"` is the
  whole answer. A `qualityWithheld` boolean beside it would always agree with
  it, and two deciders that agree are behaviourally one.
- **`available` is derived from `outcome` in one place** — `toolProbe()` in
  `lib/tool-probe.ts`, which every return in that module goes through. A
  reading cannot say `{ outcome: "absent", available: true }`.
- **One injection seam, exported.** `probeComplianceTools` is the only caller
  of `probeExternalTool` in the module, and it takes a reading per tool so a
  test can force a tool absent or errored without mutating `PATH`. An omitted
  tool is still probed, so the seam cannot quietly drop one.
- **Say when a comparison did not happen.** Layer 2's degradation check
  compares two quality scores. With both withheld the `if` simply did not
  fire — a check that was skipped reading exactly like a check that passed.

`test/compliance-unmeasured.test.ts` covers the four states. The thing it
teaches that the list above does not: its end-to-end cases run over an empty
surface, so they witness the **reading** and not the **withholding** — delete
the withholding and all four stay green (measured: 1 of 15 red, and it is the
unit case). The only witness is the unit case over `overallQualityOf` with
file scores in hand. If you copy this pattern, copy that case with it.

## Worked instance: the hill-climb that had nowhere to write (#646)

The two above are a scan that could not authenticate and a tool that was not
installed. This is the same shape with **nothing external missing at all** —
every input was present, the code ran to completion, and the thing it was
asked to do still did not happen.

`scripts/persist-compliance.ts` ends a role five different ways without
applying a reinforcement: no COMP reached the consecutive-fail threshold, the
grader-accuracy gate dropped the action, the action needs a tier promotion a
text patch cannot make, the reinforcement was already in the brief, or **the
brief contained none of the three headings the inserter writes under**. Each
one was a `logger()` line and a `continue`, and the receipt said
`hillClimbApplied: 0` for all five — which is the number a role with nothing
wrong with it produces. Measured, before the change: a run whose every
detected action was skipped and a run in which nothing was detected returned
**byte-identical receipts**.

The last of the five is the one that is not a pass in any reading. The
reinforcement was composed, the brief was read, and the text was dropped
because `indexOf` found no `## Efficiency Rules`, `## Testing Rules` or
`## Never Do`. Nobody knows what that patch would have scored, so it is
`UNMEASURED`, and the receipt now says so by name.

What it does, and the parts worth copying:

- **One list per state, always present.** `states` is a
  `Record<HillClimbState, HillClimbOccurrence[]>` built by
  `emptyHillClimbStates()`, so an empty list is a reading rather than a key
  nobody wrote. A count alone would not have been enough: *which* state was
  reached is the actionable part, and "0 applied" was already being printed.
- **Keep the producing code's own sentence.** An occurrence carries
  `{role, compId, detail}` where `detail` is the line `applyHillClimb`
  emitted. The receipt reports a decision; it does not re-derive one.
- **Do not recompute the classification, and that includes re-reading the
  sentence.** `classifySkip` renames `applyHillClimb`'s own
  `HillClimbSkipOutcome["kind"]` through one total `Record`. The first wave
  of this change matched the rendered prose with a three-row regex table
  instead, which is two deciders for one question — they always agreed, and
  **all five state cases are green on that version**, measured. Only a case
  that hands `classifySkip` a real sentence and expects `null` can see it
  (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). A total
  `Record` also turns a newly added `kind` into a build error rather than an
  `UNCLASSIFIED_SKIP` at the end of a ship run.
- **An answer nothing decided raises the reading.** A string arriving with no
  outcome beside it — a `skipped.push` upstream that bypasses `skipOutcomes`
  — carries no decision to read, so it must not read as nothing having
  happened: it lands in `unclassified` and makes the receipt `UNMEASURED`
  with `UNCLASSIFIED_SKIP` named in the reasons.
- **One discriminator.** `reading === "UNMEASURED"` is the whole answer, and
  `reading` and `unmeasuredReasons` are both projections of the same lists
  computed in `hillClimbReceipt` and nowhere else, so they cannot disagree.

`test/unit/hill-climb-receipt.test.ts` drives the real `persistCompliance`
once per state and reads the **returned receipt** — not the logger. Reading
the logger would assert that a sentence was printed, which is exactly what
the defective version already did. Its AC-B3 case is the one to copy: it
asserts the pre-#646 fields of the two runs are EQUAL, and then that the two
receipts as wholes are NOT, so the thing it witnesses is the distinction and
not merely the presence of a new field.

What was broken to prove it, run and counted over
`test/unit/hill-climb-receipt.test.ts` + `test/unit/persist-compliance.test.ts`
(32 tests), every count predicted before the battery ran. **Re-measured
against the shipped tree**, not carried over: an earlier wave recorded these
rows over 29 tests and a classifier built from regexes, and a row measured on
a tree nobody can check out is a claim rather than a count
(`.claude/rules/parallel-sessions.md`).

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 32 pass, 0 fail | **32 pass, 0 fail** | — |
| the `NO_ACTIONS_DETECTED` accumulator removed | 1 | **1 of 32** | a clean grade with no history: original lists the role, mutant lists nothing |
| the `GRADER_ACCURACY_DROP` accumulator removed | 1 | **1 of 32** | history `[N/A,N/A,N/A,IGNORED,VIOLATED]` + a `VIOLATED` current run: original records `3/4 recent verdicts are N/A`, mutant records nothing |
| the `TIER_PROMOTION` row deleted from `SKIP_OUTCOME_STATE` | 3 | **3 of 32** | five consecutive `IGNORED` on a COMP with a tier-2 promotion |
| the `REINFORCEMENT_PRESENT` row deleted | 2 | **2 of 32** | a brief already carrying the reinforcement, written by a prior real run |
| the `NO_SECTION` row deleted | 2 | **2 of 32** | a brief with none of the three headings: original names the state, mutant reports `UNCLASSIFIED_SKIP` |
| every skip occurrence dropped — pre-#646 behaviour for those three | 3 | **3 of 32** | the three inputs above. AC-B3 stays GREEN, because the no-actions side still carries its own state: that case witnesses the distinction, not the skip lists |
| `reading` hardcoded to `"MEASURED"` | 3 | **3 of 32** | the no-section input |
| `hillClimb` dropped from the returned receipt — the genuine pre-#646 shape | 8 | **8 of 32** | every state input, and AC-B3's two runs, which become byte-identical |

The three map rows are higher than the earlier wave's 1 for a reason worth
stating rather than filing as noise: every one of them also turns the AC-9
case *"every outcome kind applyHillClimb can return maps to a state"* red,
and the `TIER_PROMOTION` row additionally turns *"the decision classifies;
the sentence it renders to does not"* red. Those cases did not exist when the
classifier read prose, and they are squarely about the mutated behaviour —
the check is better than it was, not noisier.

The two unit cases over `hillClimbReceipt` stay green in the last row, which
is why they are not the witnesses — the witnesses are the seven cases that go
through `persistCompliance`. None of the mutations is left in the tree; all
were run and reverted, and `scripts/persist-compliance.ts` was confirmed
byte-identical to the measured source afterwards.

**The cheapest wrong fix, named: make the inserter fall back to appending at
the end of the brief when no heading matches.** The symptom disappears — the
reinforcement is written, `hillClimbApplied` goes to 1 — and a rule lands at
the bottom of a brief under whatever section happens to be last, which is the
`Reference` table in every brief this repo generates. The cases here survive
it: they assert the STATE the run reported, and a fallback that applies would
have to report `applied`, so the no-section case goes red rather than green.
Deciding whether that fallback is the right behaviour is a separate question
from whether the run is allowed to stay silent about it.

## Enforced by

`runConfigAccessValidation` (CONFIG-1, TypeScript sources) and
`runPromptConfigAccessValidation` (CONFIG-2, workflow prompt text) in
`lib/conformity.ts`. They **fail** the suite; they do not warn — warnings are
how 61 sites accumulated with the policy written down twice.

Both are known-violations ratchets reading `.claude/config-access-ratchet.json`,
and they refuse in **both** directions: over its number fails, under its number
fails, and a file absent from the ratchet is allowed nothing. So a new reader
fails the suite even while the total is above zero, and clearing a file means
deleting its entry in the same commit.

Neither check can see a bare `catch` around a config read. That one is on you,
and on `test/config-access-adoption.test.ts`, which asserts malformed throws.

## Why this file exists

ADR-001 (2026-10-05) specified this rule and the check that enforces it. The
rule was never written and the check was never built, so six days later the
violation count had tripled. ADR-002 (2026-10-11) specified both again. The
check shipped in #309; this file shipped in #214, two ADRs after it was first
asked for.

That is the argument for writing it down somewhere that loads, rather than in
a document nobody reads: *a rule nothing executes is not a rule*, and a rule
in an ADR is a rule nothing executes.
