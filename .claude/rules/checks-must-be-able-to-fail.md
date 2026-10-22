---
description: A check is only worth what it fails on — prove a guard can go red before trusting it green
doc-type: reference
status: active
owner: jason
updated: 2026-10-16
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
what it never looked at.** All five are in
`reference/check-failure-worked-instances.md`, *Why*. Every one was green, and
every one was green for a reason that had nothing to do with the code being
correct.

## What makes this hard to notice

A failing check announces itself. A check that cannot fail looks exactly like a
check that is satisfied — and it looks *better* over time, because it never
flakes and never blocks anyone. The quieter it is, the more it is trusted.

Five shapes to watch for. The first three are taken from the list above. The
fourth is the one that list could not contain, because it is invisible to
exactly the kind of after-the-fact reading that produced the list. The fifth
is invisible to the question this whole file asks — *can this check fail?* —
because the honest answer is yes, today.

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
- **Two deciders that agree.** Two guards answering the same question about the
  same input are behaviourally ONE guard, so no behavioural test can tell them
  apart — and a mutation of either leaves the other holding the case up. Both
  read as covered; one of them is dead and nobody can see which.
- **A case that goes green under the WRONG fix.** It fails today, for a true
  reason, against exactly what it is pointed at. It also stops failing under
  the cheapest repair somebody reaches for — so it certifies the regression
  it was written to block, at the moment that regression arrives.

### On the fourth shape

It is the only one of the four you cannot find by reading. Both deciders are
real code, both are called, both are correct, and the test that exercises them
passes for a true reason — just not for the reason it claims. **A mutation
battery is the only thing that surfaces it**, and only if you predict each
count before running: the signature is a row that comes back lower than you
expected, not a row that comes back zero.

Measured six times across #415, #420, #436 and #445, with the pair and the
count for each: `reference/check-failure-worked-instances.md`, *On the fourth
shape*.

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

Two properties make that work and both must be asserted by the test, not left
as conventions: the constant appears **exactly once** in the source, so no
refusal can bypass the mutation by inlining `process.exit(1)`; and the script
has **no relative imports**, so the mutant runs from a temp directory instead
of dying on module resolution — a non-zero exit that reads as the mutation
having been rejected on the merits.

`scripts/rook-review-scope.ts` and `test/rook-review-scope.test.ts` are the
worked example (#129); what was broken to prove it, and the counts, are in
`reference/check-failure-worked-instances.md`.

## For a gate check, where the guard is itself a test

A gate check has no exit code of its own to route through a constant, so the
single site is **one exported function that turns the reading into a list of
violations**, and the mutant is a copy of the whole suite file with that
function short-circuited to `return []`. The copy is spawned —
`bun test <mutant> -t <check name>` — and the real suite is spawned the same
way against the same planted state. Real red, mutant green, one input.

Four things make that work, all asserted by the test rather than left as
conventions: the fixture is **executed, not described**, and its failure
counted with the parser the harness itself uses; the check is **observed
running** (`ran === 1` before any assertion, because a `-t` that matches
nothing and a mutant that failed to load both report zero failures); the
binding signature appears **exactly once**, or the file aborts; and the mutant
has **no relative imports left**, or it dies on module resolution and reads as
a refusal.

`gates/workflow.test.ts`'s `suiteVerdictViolations` and
`test/suite-binding-mutation.test.ts` are the worked example (#224); what was
broken to prove it, and the counts, are in
`reference/check-failure-worked-instances.md`.

## The worked instances live next door

Every measurement this file used to carry inline — the batteries, the mutation
tables, the named wrong fixes, the counts — is in
`reference/check-failure-worked-instances.md`, in the same order and the same
words. They were moved, not deleted (#1009): they are the only evidence several
of this repository's checks were ever proved able to fail, and deleting them is
the cheapest wrong fix for a file that is too long.

Read them when you are writing the check, not before. They are a record of
measurements already taken; what you need on every turn is above this line.
