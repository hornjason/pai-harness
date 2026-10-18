---
description: Every rungate config read goes through lib/config-loader.ts — both layouts, and a corrupt config is never a missing one
doc-type: reference
status: active
owner: jason
updated: 2026-10-14
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
  produced with agnix installed and silent. CI installs neither tool, which is
  how #597 was re-run red to green on an identical SHA with nothing in the
  artefact saying why.
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
