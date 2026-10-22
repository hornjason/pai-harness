---
doc-type: reference
status: active
owner: jason
updated: 2026-10-22
---

# REVIEW.md — what matters when you review this repository

You are the reviewer the `ai-review` job runs. This file is the only file in
the checkout addressed to you; everything else is the subject of your review.
It is restored from the base branch before you start, so a pull request cannot
edit what you are reading here.

## What this repository is

`rungate` is a harness that **generates other repositories' CI**. Almost
nothing here runs for its own sake: `lib/scaffold/*.ts` emits YAML and shell
that execute on a runner we do not own, in a consumer repository we cannot
see. The consumer is the threat model, and the generated artifact is the
product.

Two consequences you will not guess from a diff:

- **`.github/workflows/*.yml` is generated output, committed.** Fix the
  generator, never the YAML. A finding that asks for an edit to a workflow
  file is wrong even when the defect is real — name the generator function.
- **A `lib/` change is dormant until a release.** The generated steps pin
  `bunx rungate@<version>`, so a fix in `lib/` that a consumer reaches through
  that pin does not take effect on merge. A fix in committed YAML does.

## What failure looks like here

Rank a finding by which of these it is. A finding that is none of them is a
nit — see the cap below.

| Area | The failure that matters |
|---|---|
| A check, a gate, gate script | **It passes on an input it never looked at.** Silence, a default substituted for a missing value, `0`/`{}`/`null`/absent all reading as clean. An unmeasured result reported as a measured one. |
| Shell inside a `run:` block | **The runner's shell is not the shell you are imagining.** GitHub runs `run:` under `/usr/bin/bash -e`. An assignment whose value is a command substitution takes that command's status and aborts the step on that line, so everything after it is unreachable. |
| A test | **It cannot fail.** Name the input on which the code and a plausible mutant of it disagree. If you cannot, say the test is unfalsifiable rather than that it is thin. |
| A doc, a rule file, a comment | **It lies.** A line that was true of a previous revision and is now false, or a cited path, symbol or line number that does not resolve. |
| Config reading | **A corrupt config reads as a missing one**, and a missing one as a default. |

## Do not flag

These are not defects in this repository, and a finding on one is a false
positive by construction:

- `evals/**/subjects/**` — planted defects. The planted file is supposed to be
  wrong; that is how the reviewer's own negative control is calibrated.
- `test/fixtures/**` — inputs chosen to be malformed.
- `CODE-MAP.md` and any file whose header says it is generated — regenerate,
  do not edit.
- `.claude/ai-review-surface-ratchet.json` — a frozen baseline. Its staleness
  relative to HEAD is the point.
- The long comment blocks in `lib/scaffold/*.ts`. They carry the measured
  history of a defect and its run id. Length is not a finding.

## Evidence, not inference

Every finding names a **file and a line you read**, and a failure scenario
that names a concrete input and the wrong output it produces. A defect
inferred from a symbol's name, from a filename, or from what a function
"probably" does is not a finding here — read the file and then say it, or do
not say it.

Prefer a finding that names the **class**: if a file has nine more lines of
the same shape as the one you found, say how many there are. One finding
naming a class is worth more than nine naming lines.

## Cap the nits

At most **three** non-blocking findings (`medium`, `low`, `info`) on a pull
request. Spend them on the three most likely to be real. Style, naming,
formatting, missing diagnostics and "consider extracting" are not findings at
all — drop them rather than spend a slot.

`critical` and `high` block the pull request and are not capped. Raise one
only when you can name the file, the line, and the input that breaks.

## If you want more

- `.claude/rules/checks-must-be-able-to-fail.md` — the shapes a guard takes
  when it cannot go red. The first table is the useful part.
- `.claude/rules/config-access.md` — how a config read is supposed to refuse.
- `CLAUDE.md` — the stack, the conventions, and the non-goals.
