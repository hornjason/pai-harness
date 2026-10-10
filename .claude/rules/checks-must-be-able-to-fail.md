---
description: A check is only worth what it fails on — prove a guard can go red before trusting it green
---

## The rule

Before you trust a check, prove it fails. Break the thing it guards — by hand,
in a scratch edit you throw away — and watch it go red. If it stays green, you
do not have a check, you have a line in a report.

Do this for anything whose job is to catch a problem: a test, a gate, a lint
rule, a ratchet, a CI step.

## Why

This is the single most common defect in this codebase's own tooling. Not a
hypothetical — a count. On 2026-10-06, five of eight issues shipped in one day
were the same bug wearing different clothes: **a check that passed because of
what it never looked at.**

- A prompt-immutability gate ran `ls -lO` and grepped for a BSD flag. On Linux
  CI the command fails, nothing is appended to the violations list, and the
  check passes unconditionally. It had never once run in CI.
- A guard against top-level `require()` stripped template literals with a
  regex. Backticks inside comments and strings paired with unrelated ones and
  deleted 61% of the file, including the two functions the guard existed to
  protect. Two new violations were added and the suite reported 48 pass.
- A budget counter read `parseInt(raw) || 0`. One unparseable byte silently
  meant "zero spent", disabling the cap while every message still looked normal.
- Nine `require()` calls inside `try/catch` in an environment with no module
  loading. Every one threw, every throw was swallowed as a warning, and the run
  reported success with its measurement features switched off.
- A "generator determinism" test called a one-argument function with three
  arguments, compared two arrays that were always empty, and `expect([])
  .toEqual([])` passed no matter how non-deterministic the generator was.

Every one of those was green. Every one was green for a reason that had nothing
to do with the code being correct.

## What makes this hard to notice

A failing check announces itself. A check that cannot fail looks exactly like a
check that is satisfied — and it looks *better* over time, because it never
flakes and never blocks anyone. The quieter it is, the more it is trusted.

Three shapes to watch for, all taken from the list above:

- **Fail-open error handling.** A `catch` that returns "no problems found", or
  a parse failure that defaults to an empty violation list. Anything that can
  throw inside a fail-open guard is a guard bypass; the fail-open is not the
  bug, it is the amplifier.
- **A detector narrower than what it detects.** Text matching that a reformat,
  a line break or a different platform defeats. If the guard's view of the
  input can silently shrink, assert on the view itself.
- **Assertions that hold vacuously.** Comparing two empty collections, matching
  a pattern against text that was stripped out upstream, asserting a value the
  test itself just set.

## In practice

When you add or change a guard, say in the commit or PR **what you broke to
make it fail**. One line is enough: "removing the slice makes it compare the
run against itself, which this now catches." That sentence is cheap to write,
and it is the only evidence that separates a real check from a decorative one.

When a guard has to ship red — a known-violations ratchet — bank progress in
the same commit that earns it, and write down what the number means. A ratchet
nobody can interpret becomes a number nobody lowers.

## For a script whose job is to exit non-zero

A sentence in the PR is evidence a reader has to trust. When the guard is a
script, the break can live in the test instead, and then it is re-checked on
every run.

Route every refusal through **one exported exit-code constant**, declared on a
single line, and have the test build a mutant copy of the source with that
constant set to `0`. Each negative case then runs twice — the real script, and
the mutant — and asserts the real one refuses while the mutant does not. The
second assertion is the whole point: it is the removal of the non-zero exit,
performed and observed, so a case that later starts passing for an unrelated
reason stops being indistinguishable from a case that is genuinely caught.

`scripts/rook-review-scope.ts` and `test/rook-review-scope.test.ts` are the
worked example (#129). Two properties make it work, and both are asserted by
the test rather than left as conventions:

- The constant appears exactly once in the source, so no refusal can quietly
  bypass the mutation by inlining `process.exit(1)`.
- The script has no relative imports, so the mutant runs from a temp
  directory. Without that check a later `from "../lib/..."` would make every
  mutant die on module resolution — exiting non-zero, which reads as the
  mutation having been rejected on the merits.

What was broken to prove it, run and counted rather than asserted: making the
empty-scope branch stop throwing turns 3 tests red, and zeroing `REFUSE_EXIT`
in the real source leaves the harness nothing to mutate, so it throws
"could not build the mutant" and the whole file aborts instead of passing
quietly. That second outcome is the point — a mutation harness that silently
no-ops when its target moves is the decorative check this rule is about.
Neither mutation is left in the tree; both were run and reverted.

## For a gate check, where the guard is itself a test

A gate check has no exit code of its own to route through a constant, so the
single site is **one exported function that turns the reading into a list of
violations**, and the mutant is a copy of the whole suite file with that
function short-circuited to `return []`. The copy is spawned —
`bun test <mutant> -t <check name>` — and the real suite is spawned the same
way against the same planted state. Real red, mutant green, one input.

`gates/workflow.test.ts`'s `suiteVerdictViolations` and
`test/suite-binding-mutation.test.ts` are the worked example (#224). Four
things make it work, all asserted by the test rather than left as conventions:

- **The fixture is executed, not described.** A project carrying one
  deliberately failing test is run, and its failure counted with
  `extractTestFailureCount` — the parser the harness itself uses — before the
  resulting verdict is handed to the check. A hand-written `"FAIL"` proves the
  check can read a string; a measured one proves a failing suite reaches it.
- **The check is observed running.** A `-t` filter that matches nothing leaves
  bun reporting zero failures, which is indistinguishable from the check
  passing, and is also what a mutant that failed to resolve its imports looks
  like. Every assertion goes through `ran === 1` first, and the red case also
  asserts the refusal text, because a suite that failed to load is red too.
- **The signature appears exactly once.** A second refusal path for the same
  fact would survive the mutation and the mutant would go red for a reason
  that has nothing to do with the mutation working. Two copies abort the file.
- **The mutant has no relative imports left.** The copy runs from a temp
  directory with `./schema` and friends rewritten to absolute paths, and any
  specifier the rewriter could not see aborts the build rather than letting the
  mutant die on module resolution and read as a refusal.

What was broken to prove it, run and counted rather than asserted, over
`test/suite-binding-mutation.test.ts` + `test/gate-vacuous-checks.test.ts`
(20 tests): short-circuiting `suiteVerdictViolations` to `return []` turns 3
red — both fixture refusals and the real-source half of the mutant case — and
renaming it to `suiteVerdictRefusal` turns 4 red, every one of them throwing
`could not build the mutant: the binding signature appears 0 times`. Neither
mutation is left in the tree; both were run and reverted, and the counts are
recorded in specs/HARNESS-STANDARD.md beside SC-615..617.
