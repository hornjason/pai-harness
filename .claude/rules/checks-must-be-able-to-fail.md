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

Measured four times in two issues, all four in October 2026:

| Where | The pair | What the mutation showed |
|---|---|---|
| #415 | `validateFilePaths` and the path refusal | mutating either left the other refusing |
| #415 | the scaffolder's own pre-check and the config writer's refusal | the scaffolder refused an existing config twice; deleting its check was 0 red |
| #420 | `waveNeedsIntegration`, asked in the loop AND inside `integrateWave` | the fake recorded every call, so the real early return was never witnessed |
| #420 | the landed-branch comparison and the refusal re-check below it | **0 of 196.** The case fed `main`, which BOTH catch; the comparison could be deleted outright |
| #436 | `orphanedGitdir`'s `statSync` catch, its `isFile()`, and the `readFileSync` after them — THREE | **0 of 47.** A `.git` directory throws `EISDIR` and a missing one throws `ENOENT`, so the read already refused both; two of the three were deletable and nothing could say which |
| #445 | `preflightRefusal`'s own `versions.includes` and the new `registryServes` the postflight asks | caught in the draft, before the battery: both phases ask one question of one field, so a second copy would have survived any mutation of the first. Collapsed to one binding, and mutating it is now 14 red and 17 red in the two directions |

#436 is the first one caught by this section rather than recorded into it, and
it is worth saying what that cost: one predicted number, written down before
the battery ran. The row came back 0 where 1 was expected, and the collapse
took ten minutes. Nothing in the diff, the review, or the green suite would
have shown it.

### Before you believe a 0, prove the mutation changed behaviour (#485, #297)

Everything above tells you to read a 0 as a finding. There is a second thing
a 0 means, it looks identical, and the method has no way to tell you which
one you are looking at:

- **the mutation was applied and nothing caught it** — the finding, and
- **the mutation was never really applied** — no information at all.

Two instances on 2026-10-16, found independently in two sessions:

| Where | The 0 | What it actually was |
|---|---|---|
| #485 | narrowing `UNFILLED` back to uppercase-`TODO`-only was 0 red | the fixture written to isolate the widened word list was `"TODO — write the real claim…"`. The OLD regex matches that too, so the mutant and the original behave identically on every input the suite has. The 0 was reporting that nothing changed |
| #297 | deleting a required phrase from a spec's prose was 0 red | the search strips SC lines first, and the phrase survived inside the SC line demanding it. The document still answered the question with the thing the mutation removed |

Both read exactly like a collapsed pair. Neither was one.

**The check is one line and it is not optional: before recording a 0, name
an input on which the mutant and the original differ.** If you cannot, you
have not run a mutation — you have run the code twice. A fixture that the
pre-fix code also catches is the most common way this happens, because it is
the fixture you naturally reach for: you write the example that motivated the
fix, and the fix was motivated by something the old code already handled in
part.

The same arithmetic catches the inverse, a row that comes back too HIGH —
but a high row has two causes and they pull in opposite directions, so the
count alone does not tell you which you have. **Read which tests went red
before concluding anything.**

| #485 | "a second unguarded write was added" predicted 1, measured 4 | the mutant used `appendFileSync`, which that script does not import, so it died on a `ReferenceError` and every case that runs it went red. **A mutant that crashes is not a mutant** — it measures that the file still parses. Re-run with a global the file need not import: 1 |
| #307 | `censusOf stops recursing` predicted 1, measured 2 | the mutant was fine. The extra red was the real-repo control asserting `>5000` test declarations, and a flat walk gives 4811 — 39 of 309 test files are nested and carry 488 of the 5299. **The binding reached further than the prediction did**, and the second red was a real thing the mutation breaks |

The discriminator is the same instrument in both: are the extra reds
*about* the mutated behaviour?

- extra reds in cases unrelated to the mutation's subject, or every case
  touching the mutant file goes red → **the mutant is broken.**
- extra reds in cases that genuinely depend on the mutated behaviour → **the
  prediction was wrong and the check is better than you thought.** Record
  why; it is usually a fact about the codebase you did not know.

Getting this backwards is expensive in the direction that matters least
visibly: treating #307's second red as a broken mutant means hunting a bug
that does not exist, and leaves behind the lesson that a surprisingly
thorough check is a smell.

So a battery has three outcomes, not two. Matches prediction; misses low —
suspect a collapsed pair; misses high — read the extra reds before
concluding anything, because a crashing mutant and an unexpectedly
load-bearing binding both come back high and only one of them is a problem.

The fix is one of two things, and which one is a design question, not a style
question. Either **collapse them** — one decider, one binding to mutate — or
**keep both and give each an input only it can reach**. #420 took the second:
a commit landing on an ordinary feature branch is something only the
comparison refuses, and a commit reporting no branch at all is something only
the re-check can see. Each mutation is now 1 red, and the rows are different
rows.

What makes the second option honest is that the two inputs are written down as
separate cases with a comment saying which decider each one is for. Without
that, the next person to simplify the code deletes a line that has a test and
watches it stay green.

### Before you believe a 0, check the instrument (#60)

The section above gives a zero two causes: the mutation was applied and
nothing caught it, or the mutation was never really applied. Both are about
the code.

There is a third, and it is worse because it is silent and it is not about the
code at all: **the measurement stopped reporting.**

Measured on #60. A test forced an error by writing to a path containing a NUL
byte. The thrown message quotes the path, so the stderr line carried a real
NUL — and `grep` treats a file with a NUL in it as binary, printing
`Binary file matches` to a terminal and *nothing at all* through a pipe. The
battery's `grep -E "^ *[0-9]+ (pass|fail)"` returned empty. Four mutations in
a row measured as blank lines, with a green suite, a correct mutant, and no
error anywhere.

The tell is that the BASELINE is also wrong. A real zero has a believable
baseline beside it; an instrument failure takes the baseline down too, and it
is the one row nobody checks because nobody mutated anything to produce it.

So: **read your baseline row before you read any mutation row.** If the
baseline is empty, absent, or not the number you know the suite reports, you
are not measuring the code. And do not let a test put a NUL in the run's
output — a test that corrupts the output stream of the suite containing it
breaks every downstream reader, including CI log greps that have nothing to do
with it. A directory whose parent is a file throws `ENOTDIR` and forces the
same error in text.

### Search the slice, not the document (#297, #484, #60)

A claim scoped to one section of a string, asserted against the whole string,
is satisfied by a match anywhere in it. Three instances, all found by a
mutation row coming back LOWER than predicted and by nothing else:

| Where | The claim | What satisfied it instead |
|---|---|---|
| #297 | a phrase appears in a spec section's PROSE | the section's own SC line, which quotes the phrase it demands |
| #484 | a new violation case is caught | the live-tree case, which asserted the WHOLE violation list, so two questions were one assertion |
| #60 | the viewer prints a PHASES list containing `Goal` | the TIMELINE row `agent read-issue start [Goal]`, in the same rendered text |

Each read correctly in the diff, each had a test name describing what it meant
to do, each was green over code that had stopped doing it. The fix is the same
every time: cut the region the claim is about out of the string first, assert
on the cut, and assert that the cut is non-empty — because a slice that fails
to find its own section is an empty string, and an empty string contains
nothing, which is indistinguishable from a clean result.

### A battery whose fixtures all meet a precondition measures nothing past it (#492, #59)

Every fixture in a battery is built to exercise the feature. That is what
makes a battery feel thorough, and it is also what makes it blind in one
specific direction: if the feature only runs when some precondition holds,
every fixture holds it, and **the branch where it does not hold is outside
the battery's reach entirely.** Not under-tested — unreachable.

This is not the "prove the mutation changed behaviour" case above, and it is
why this is a section rather than a sentence appended to that one. There, the
mutant and the original behave identically on the inputs you have, and the
tell is a number. Here **there is no suspicious number to read.** #492's
battery over `unmeasuredScanReason` was five mutations measuring 1, 1, 1, 1
and 4, every count predicted before the run and every one matched — a model
battery by every diagnostic already in this file, measuring nothing about the
branch one line above itself.

Two instances, found within hours of each other and from opposite directions.
Neither was found by its own author: #492's was found by sec-485, varying the
one precondition two other reviewers had held fixed, and measured by sec-500
afterwards.

| Where | What every fixture held fixed | What was on the other side |
|---|---|---|
| #492 | every waiver fixture had **no** scanned files, because that is the precondition a waiver needs | a *mixed* layout, where `scripts/` makes `filesScanned` non-zero while 390 files in `src/` are never read. CONFIG-1 reports **PASS having scanned 36 of 426**, and the empty-scan refusal cannot fire. Every hardening anyone had done lived downstream of `filesScanned === 0` |
| #59 | the refusal enumeration was read off `prevalidationViolations`, which refuses an absent, `UNMEASURED`, `FAIL` or self-contradicting reading | the function sits behind `if (!isVerifyPlus()) return`, and `isVerifyPlus` is `["VERIFY","SHIP","DONE"]`. The reading is stamped at SCOPE and refused two phases later, so every clause was true of the function and none of it was true at the phase being reasoned about |

**The #59 row has no count beside it on purpose.** It was caught by reading
`isVerifyPlus` before shipping, not by a battery, and a file whose subject is
not trusting unmeasured claims should not carry one wearing a number. It is
recorded because the route is one this file does not otherwise teach: every
other worked example here is a mutation battery, and this one is *reading
upward from a function to its call site*. Both routes work and neither finds
the other's instance.

What makes #59 worth the space is that nothing in the DATA was wrong. The
reading really is taken at SCOPE — `stampEvidencePrevalidation(state,
"scope")` — so every artefact a reader checks says the system knows the
answer at that phase. It does. It just does not refuse on it until VERIFY.
Not catchable by looking at the state file, because the state file is
correct and sitting on the wrong side of the line.

The distinguishing input, since the point of a row is to be reproducible: a
state at `phase: "SCOPE"` carrying `evidencePrevalidation: {verdict: "FAIL",
acs: [{id: "AC-2", status: "broken"}]}` passes the scope gate; the identical
state at `phase: "VERIFY"` refuses. One field, opposite verdicts.

#492's is the sharper one because its exposure window is **one byte**,
measured on `git archive` exports under `/tmp` rather than argued:

| Fixture | `bytesScanned` | Verdict |
|---|---|---|
| `src/` only, 61 files, one holding a live config read | 0 | FAIL — *"the scan read NO files"* |
| + `scripts/empty.ts`, **0 bytes** | 0 | FAIL — *"1 files were walked and none had any content"* |
| + `scripts/x.ts`, **1 byte** (a newline) | 1 | **0 findings** |
| + comment-only `gates/g.ts`, 11 bytes | 11 | **0 findings** |
| + clean `lib/build.ts`, 20 bytes | 20 | **0 findings** |

No FAIL, no WARN, no UNMEASURED, nothing in the report at all — strictly
worse than every case the batteries did cover, because those at least record
something. The zero-byte row is the one that makes "one byte" exact: the last
guard is a byte count, and a single character walks past it.

**And there is a second-order trap in that table worth naming on its own.**
The refusal states its condition as *"the scan read NO files"* — which one
byte makes false. So the refusal is **satisfiable by something other than
fixing the problem**: adding an empty file to a scanned directory silences
it, and the project is no more scanned than it was. When you word a refusal,
word it after the property you care about, not after the cheapest proxy you
had to hand, because a proxy is a thing people can satisfy directly.

The same trap takes assertions, not just refusals, and there the tell is a
mutation row that misses LOW. #532's real-run case asserted that the gate's
JUnit reading reported more than fifty tests *filtered out*. Making the reader
treat a filtered-out test as one that RAN — the mutation the case exists to
catch — leaves that number untouched at 279 and simply adds all 279 names to
the list, so the row was 2 where 3 was predicted. A count is the proxy; which
names are in the list is the property. It now asserts that every name the
reading returns matches the gate's own `--test-name-pattern`, and is 3.
**When a case asserts a number about a collection, ask whether the defect
changes the number or only the membership.**

**So name the precondition, then go and build the one fixture that does not
meet it.** In #492's case that is a project with files in both a scanned and
an unscanned directory; in #59's it is reading the gate at the phase it
actually runs rather than reading the function. The fixture you have to
construct deliberately is the one that would never occur to you, because
every natural example is an example *of the feature*.

The reporting fix generalises too: **a scan that reports a verdict should
report its own coverage** — how many files it read of how many it could see.
`36/426` and `426/426` are the same PASS today, and no reader can tell them
apart from the output.

### On the fifth shape: a case that goes green under the wrong fix (#492, #518)

The other four are properties of a check as it stands. This one is a property
of the check's relationship to a repair that does not exist yet, and that is
why none of the four catch it: it is not vacuous — it fails today, for a true
reason; it is not a narrow detector — it sees exactly what it is pointed at;
it is not fail-open and it is not a pair.

It is also not #500's *"fixture that reached the assertion without the
feature"*, which is the nearest neighbour. That one is a bypass path **that
exists now**. This is a bypass a future fix creates.

So the question this file asks — *can this check fail?* — is answered **yes,
truthfully**, and never asks *under which future*.

Two instances, same afternoon, both measured:

| Where | The case | The cheap repair | What happens |
|---|---|---|---|
| #492 | "a one-byte scanned file must not go silent", added to guard against widening the `bytesScanned === 0` guard | widen it to `bytesScanned < 10` | the **new** case goes green; the existing 21-byte case stays red. The case written to block that fix is the case that fix satisfies |
| #518 | "a dot-file and a dot-directory are declined under different classes" | skip non-directory dot entries instead of classifying them | the lookup returns `undefined` for the deleted entry, the two classes duly "differ", and the case **passes over the exact regression it exists to catch** |

#518 is the sharper one, because `undefined !== "dot-file"` is true and that
is the whole defect: a comparison where one side has been deleted reads as a
distinction. The fix is one assertion — **establish presence before
comparing.**

#492 is the more alarming one, because the asymmetry runs the wrong way. The
case somebody *added* to reinforce the guard was weaker than the case already
there, and nothing but the counterfactual says so.

**The test, and it is one line: name the wrong fix, and say whether the case
survives it.**

That is the same discipline as this file's existing demand — *say in the
commit what you broke to make it fail* — pointed the other way in time. The
existing sentence asks what you broke today. This asks what someone will
plausibly do tomorrow, and whether you would notice.

**Name the CHEAPEST repair, not the correct one.** That is what makes the
shape findable rather than merely nameable. Both instances above are the
hurried fix: widen the threshold, delete the entry. "What is the right fix
here" is a question that produces a right fix; "what would someone do at
5pm to make this symptom go away" is the question that produces these, and
both of today's were caught by somebody asking it out loud. Neither was
caught by reading the code, including by the person who wrote the case.

Found by sec-485, after it bit the same session twice in one afternoon in two
unrelated issues. Recorded here rather than written by its finder: a reviewer
editing the rubric they review against is the self-reference trap in
governance form, and this file has caught that shape in prose four times
already.

### "This cannot be checked" is a claim, and it is checkable (#199, #479)

The cheapest way to ship a check that cannot fail is to not ship it, having
written down a good reason. The reason is usually true, and the trap is that
it is true of the cases you measured.

`.claude/rungate/hooks.json` declared sixteen hooks enabled; five had never
fired. #199's test file concluded that no repo test could honestly assert
registration — `~/.claude/settings.json` is machine state, reading it passes on
one laptop and fails in CI, and `HOOK-ARCHITECTURE-SPEC.md` SC-518 *requires*
machine-wide hooks to live there. Every sentence of that is correct. It is
also derived entirely from the eleven hooks that WERE registered, all of them
in user settings, and then applied to all sixteen. The five all act on the
current project, project `.claude/settings.json` is committed, and for those
five "is it registered" was an ordinary repo fact the whole time. The issue
closed; four weeks later the same five were still inert.

So when you are about to write "this cannot be tested", say which cases you
measured to conclude it, and check whether the ones you are excusing are among
them. The sentence costs a line. Here it was the difference between a check
and a paragraph explaining why there is no check.

The usable form of the answer is almost never all-or-nothing. Split the
population by what the repo can see, enforce the half it owns, and make the
other half report UNMEASURED on every run — `0`, `{}`, `null` and `SKIP` are
indistinguishable from success, and so is silence.

### A guard that answered the right question in the wrong syntax (#484)

The clearest instance this repo has produced, because the fix and the blind
spot shipped in the same commit.

#446 found four published modules importing a script `files[]` omitted, fixed
`files[]`, and added `test/package-closure.test.ts`: *every relative IMPORT in
a published file must resolve to another published file.* Correct, and
`0.4.1` was cut on the strength of it, with `SUCCESS.md` recording that the
distribution had been checked against the artifact rather than the tree.

`lib/conformity.ts` does not import its matcher registry. It reads it:

```ts
join(dirname(fileURLToPath(import.meta.url)), "..", "config", "matcher-registry.json")
```

`config/` was not in `files[]`. Neither was `templates/`, nor
`specs/SPEC-TEMPLATE.md`. Seven call sites, three directories, and a
documented CLI command — `bunx rungate create-sc --list` — that ENOENTs for
every consumer, through the release cut to fix exactly this.

**What makes it worth a row here is how it stayed invisible.** On the first
external consumer the suite reported **21 pass, 0 fail** over a library that
could not load its own registry — because all 40 of that project's success
criteria were unmatched, so nothing ever called `resolveMatcher`. The suite
was green for a reason unrelated to the code being correct, and the reward for
making the spec more testable would have been an ENOENT crash with nothing
connecting the two events.

Two more things fell out of the battery, both from predicted counts that
missed:

- Three `files[]` rows came back **2 red where 1 was predicted**. The live-tree
  import case asserted the WHOLE violation list, so it and the new read case
  were one assertion wearing two names — the fourth shape, found by the
  arithmetic rather than by reading. Split by question, each is 1.
- The comment-stripping row came back **3 where 4 was predicted**, and the
  missing one is the live tree. The scanner's own docstring quotes the broken
  expression, and scanning raw source reports that quote as a call — which is
  how the bug was found. Once `config/` shipped, the quoted path resolved to a
  published file and the live tree stopped being able to witness it. Three
  synthetic cases are now the only thing holding that line, which is the
  argument against deleting them as redundant.

The general form: **when a guard enforces a property, ask what other syntax
expresses the same property.** An import and a `readFileSync(join(...))` are
one question asked two ways, and a check that knows only one of them reads
exactly like a check that is satisfied.

### The artifact everyone reaches for as ground truth, which always agrees (#530)

The fourth shape says two deciders that agree are behaviourally one. There is
a version where **the second decider is a file**, and a file has no behaviour
to mutate, so nothing in this document's method finds it.

`workflows/ship.js`'s review-currency probe asked an agent to read
`environments.local.testsSha` out of `workflow-state.json`. Nothing has ever
written that field: it is not a key `EnvironmentLocalSchema` declares, and it
appeared in exactly one place in the tree — that prompt. The recorder has
written the SHA to `suiteMeasurement.measuredSha` since #224. So
`suiteCurrency` returned UNRECORDED on every run that has ever happened, and
the `SUITE_MEASUREMENT_STALE` refusal twenty lines below it has never once
been able to fire. #224 shipped a recorder and a refusal and never connected
them.

**The instrument you reach for cannot see it.** The obvious way to check
whether a field exists is to write a state through the real writer and read
it back. `writeWorkflowState` calls
`WorkflowStateSchema.passthrough().parse(state)` and then writes the
**original** object — so an undeclared key validates, persists, and reads
back exactly like a declared one. Measured: a state carrying both
`environments.local.testsSha` and `suiteMeasurement.measuredSha` round-trips
with both intact. The file confirms any field you ask it about.

So the check is against the **contract**, not the artifact: walk the Zod
shape and refuse any prompt that sends an agent to a path the schema does not
declare. The schema is the statement about what has a producer; the JSON is
the statement about what someone happened to write.

Two generalisations, and the second is the reusable one:

- A consumer reads a name, a producer writes a different name, and nothing
  compares the two. #484 is that with a filesystem in the middle; this is
  that with a schema in the middle. Same question, two syntaxes, a checker
  that knew one — which is the section directly above, arriving again within
  the week.
- **When an artifact is your evidence, ask what it would say if the thing
  were absent.** A permissive store — `passthrough()`, a schemaless JSON
  blob, a key-value cache, a log you grep — answers yes to every question of
  the form "is this here", because you put it there. That is not a witness.
  It is the question restated.

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

### The fixture has to be measured on the producing side too (#235)

`prevalidationViolations` in the same file is the second worked example, and it
adds one property the first did not need to state.

The pre-validator `lib/evidence-prevalidator.ts` was already finding broken AC
evidence commands and printing them to `console.error` from a fire-and-forget
`.then()`. Nothing read the print. Wiring the reading into a refusal is the
easy half; the trap is that a refusal test fed a hand-written
`{ verdict: "FAIL", broken: ["AC-2"] }` stays green when the pre-validator
itself stops validating. It would be a test of JSON parsing wearing a gate's
clothes. So the fixture plants one AC whose command cannot succeed and one
whose command can, runs both through the real `prevalidateEvidence`, and
derives the verdict from what it classified.

**Mutate both ends of the binding, not just the reader.** The producing
function is a third mutation, and it is the one the sub-issue asked for by
name, because it is the one a reader-only proof cannot catch.

What was broken to prove it, run and counted rather than asserted, over
`test/suite-binding-mutation.test.ts` + `test/gate-vacuous-checks.test.ts`
(29 tests):

| Mutation | Red |
|---|---|
| `prevalidateEvidence` short-circuited to `return []` | 3 of 29 — the fixture measures `PASS`, so the refusal cases have nothing to refuse |
| `prevalidationViolations` short-circuited to `return []` | 4 of 29 — measured `FAIL`, absent reading, explicit `UNMEASURED`, and the mutant case's real-source half |
| `prevalidationViolations` renamed to `prevalidationRefusal` | 3 of 29 — every mutant-building case throws `could not build the mutant: the binding signature appears 0 times` |

None of the three is left in the tree; all were run and reverted, and the
counts are recorded in specs/HARNESS-STANDARD.md beside SC-618..620.

Two more things this example pins down, both of which are fail-opens the first
example never had to rule out:

- **Unmeasured is not clean.** An absent reading and an explicit `UNMEASURED`
  verdict refuse with the same text a `FAIL` does, and both are asserted
  separately — "the writer never ran" and "the writer ran and measured
  nothing" fail the same way for the same reason.
- **A `PASS` carrying broken ids is a contradiction, not a pass.** Without that
  branch a writer could record the broken list faithfully and still be waved
  through, which is the fail-open that survives every test written only
  against the happy path.

### A detector that cannot tell prose from a prompt (#235, follow-up)

The singleton check in `test/spec-compliance.test.ts` — "exactly one
pre-validation implementation exists" — shipped red, and the reason is the
third shape this rule names: **a detector narrower than what it detects**,
inverted. Its PROMPT probe admitted `dry-?run(?:ning|s)?`, and the inflected
forms are the ones prose uses to *describe* a check rather than to perform one.
`gates/schema.ts:223` says "The scope gate dry-runs every AC's evidence command
before Marcus runs" — one sentence of documentation, in the schema module, was
enough to report a second pre-validation implementation and turn two tests red.
The probe's own comment claimed it could tell "a prompt that performs the check
from a comment that points at where it lives". It could not.

The fix is to narrow `RUN_INSTRUCTION` to the bare imperative, which is the only
form an agent instruction takes. Narrowing a detector is the change most likely
to buy green with blindness, so the boundary is now a test rather than a comment:
the imperative must be read as an implementation, the descriptive sentence must
not, and the verbatim prompt #235 deleted must still be caught.

A second test shipped red for an unrelated reason worth naming: it asserted
`prevalidateEvidence(state.acs` appeared in `gates/gate-executor.ts`, but the
gate calls `measureEvidencePrevalidation`, the wrapper that turns a throw into a
recorded UNMEASURED. The assertion had been written against an earlier design
and never followed it. A source-text assertion cannot notice that it has stopped
describing the code, so the chain is now asserted in two links — the call site
is grepped for `await measureEvidencePrevalidation(state.acs`, and the wrapper's
delegation to the owner is **executed**, over one command that cannot succeed and
one that can.

What was broken to prove it, run and counted rather than asserted, over
`test/spec-compliance.test.ts` (55 tests):

| Mutation | Red |
|---|---|
| `RUN_INSTRUCTION` restored to `dry-?run(?:ning\|s)?` | 3 of 55 — the singleton, its reintroduction case, and the prose/imperative boundary |
| `measureEvidencePrevalidation` stops delegating (returns `ok` for every AC) | 1 of 55 — the grep half still passes, which is why the executed half exists |
| the `await` dropped from the gate's call site | 1 of 55 — the orphaned promise that is the whole of #235, reintroduced verbatim |

None is left in the tree; all were run and reverted. The three mutations
recorded above for SC-618..620 were also re-run against this tree and reproduce
their counts exactly — 3, 4 and 3 red of 29.

### A fixture that reached the assertion without the feature (#500)

The third shape, and the cheapest version of it to write by accident: a test
whose fixture satisfies the assertion through a path that does not go through
the thing under test.

#500 replaced a waiver predicate with `projectSourceEvidence`, a tree walk
that deliberately **follows symlinked directories** — `readdirSync(withFileTypes)`
reports a symlink as not-a-directory, so a `statSync` is the only thing that
makes `packages/core` behind `lib/impl` visible, and a predicate that cannot
see it waives a monorepo full of code. The test said so by name: *"F6: a
symlinked source directory is followed, and a cycle terminates."* It planted
`packages/core/reader.ts`, symlinked `lib-impl` at it, and asserted
`projectSourceEvidence(root).found`.

`packages/core/reader.ts` is inside the root. The walk reaches it by ordinary
recursion, without ever traversing the symlink, so the assertion was true
before the symlink existed and stayed true after the feature was deleted. The
cycle half had the same defect from the other direction: its fixture's
`a/x.ts` is found on the first pass, so `found` is true whether or not
`realpathSync` ever terminates anything.

Measured by sec-500 during the security review of PR #500, on `git archive`
copies under `/tmp`; the repo was never modified. There is no SC for this
one, and rather than invent one so a number has somewhere to sit — which is
`.claude/rules/claiming-sc-coverage.md`'s trap from the other direction — the
counts live here and nowhere else.

| Mutation | Red | Predicted |
|---|---|---|
| the whole symlinked-directory branch replaced by `continue` — symlinks never followed | **0 of 29** | 1 |
| the same mutation after a target reachable only through the link was added | **1 of 45** | 1 |

The row came back 0 where 1 was expected, which is the signature the
fourth-shape section describes, arriving in the third shape. Nothing in the
diff showed it: the fixture builds a symlink, the test is named after
symlinks, and the assertion is about symlinks. Only the count disagreed.

**The general form: a fixture must not be able to satisfy the assertion by a
route that bypasses the feature.** For a symlink test that means the target
is reachable ONLY through the link — put it outside the walked tree, or
delete the real path after linking. For a cache test, the backing store has
to be unreadable on the second call. For a fallback, the primary has to
actually be gone. The question to ask of any fixture is not "does this
exercise the feature" but **"what would this test report if the feature were
deleted"** — and the only honest way to answer it is to delete the feature
and look.

It recurs. Three more instances in the same two issues, all found by the
count rather than by reading:

- a determinism test that built the same tree twice and compared the two
  lists. Removing the sort entirely was 0 red, because two trees built by the
  same code in the same order give the same `readdir` order. It asserted
  reproducibility on one machine, which was never in doubt; the property is
  an ORDER, so the order is what has to be asserted.
- a `--force`-through-a-symlink test asserting the exclusive write flag with
  a file-level `toContain('{ flag: "wx" }')`. Moving the literal into a
  comment and leaving the write bare passed both halves.
- a refusal asserting `toContain("symlink")` against a message that says
  "symlink" twice. Deleting the clause that names it as a cause left the
  sentence explaining the policy, and the row was 0.

#### …and a fixture can lose its witness to an input it does not control (#507)

The three above are fixtures that were never witnesses. This one was, and
stopped being one while nobody touched it — which is worse, because the
thing that changed is not in the diff, not in the repository, and not
anything the author could have read.

`test/sc-fixture-namespace.test.ts` plants an SC id in a scratch source file
and asserts the CLI allocates exactly one above it. `nextSCNumber` is
`max(ids) + 1`, so the case witnesses the feature only while **the planted
id is the maximum** — step over the probe and the answer moves. The probe
was computed as "this tree's spec registry answer, plus seven", which was
above everything on the day it was written.

Then #503 widened the allocator to read sibling worktrees and every branch
ref, and a peer session allocated nineteen criteria on an unmerged branch.
The probe landed inside that block. The CLI correctly allocated past the
whole block, the case went red, and the red was the harmless half: there is
a one-id window — probe lands exactly on the namespace maximum — where
`probe + 1` is the right answer for both the real allocator and one that
never read the probe file at all, and the case goes green having witnessed
nothing.

**What makes it a shape rather than an anecdote: the margin was set by
something outside the fixture.** Another session, in another worktree, at an
unknown time. No count catches this, because on the day you run the battery
the margin is whatever it is and every row is correct; and the author cannot
read their way to it either, because the input does not exist yet.

So when a fixture needs to clear a maximum, **compute it from the same
reading the code under test uses** — not from a narrower one that happened
to agree. The narrower reading is the tempting one precisely because it is
the cheap local call, and it agrees right up until it does not.

#### …and a pair that varies two things at once measures neither (#585)

The sections above are about one fixture. This is about two, and the trap is
that a *pair* is the instrument people reach for when they want to isolate a
dimension — so a pair that silently varies a second dimension reads as the
isolation it is not.

`scripts/validate-workflow.ts` matched a usage with
`^\s+([A-Z_][A-Z_0-9]*)\s*=\s`. That is blind in two independent ways: it
sees only WRITES, and only INDENTED ones. A fixture pair meant to show that
column zero is now detected has to hold the write/read dimension fixed, and
it has to be impossible for the two halves to differ in anything else. Two
hand-written string literals are not impossible to diverge; they are two
literals, and the next edit touches one of them.

`test/validate-workflow-tdz.test.ts` writes ONE source string and derives
the other from it by removing the leading whitespace of the usage line, then
asserts the derivation: same line count, exactly one differing line, and the
two differing lines equal after `trimStart()`. The pair cannot carry a second
difference, because the second half is not written down.

The usage in it is a READ, and that is the fifth shape above applied in
advance rather than discovered afterwards:

- **The cheapest wrong fix** for "a column-zero usage is missed" is one
  character: widen `^\s+` to `^\s*` in the old assignment-only regex. It is
  the 5pm repair, it makes the reported symptom go away, and it leaves the
  detector blind to the read that actually crashed ship.js.
- **Does the pair survive it? Yes — with a read.** The old regex never
  matched a read at any column, so both halves stay red under `^\s*` and the
  case keeps pointing at the real gap. **An assignment pair would NOT
  survive it**: both halves go green on a detector that is still blind to the
  crashing shape, which is a case certifying the regression it was written to
  block.

Measured over `test/validate-workflow-tdz.test.ts` alone (5 tests), on a
`git archive` export of `0195e668` — the branch's widened detector — under
`/tmp`, with the validator confirmed byte-identical afterwards. The counts
are from that tree and not from the sub-issue's own worktree, whose base is
one commit short of the widened detector; there, the file does not pass or
fail quietly but ABORTS in `beforeAll` with *"the usage-reporting anchor
appears 0 times"*, which is the loud-abort property the mutant builder exists
for.

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 5 pass, 0 fail | **5 pass, 0 fail** |
| the `^\s+` leading-whitespace requirement restored in `scripts/validate-workflow.ts` | 1 red | **1 of 5** — *"the same usage at column zero is refused"*, and only that one |
| the test's own column-sensitive mutant builder neutered (`writeFileSync(COLUMN_MUTANT, source)`) | 1 red | **1 of 5** — the mutant-evidence case, which is what stops that case passing over a mutation that was never applied |

Before believing the second row, the input on which mutant and original
differ, named and run rather than assumed: a two-line file
`console.log(EXEMPT_FLAG)\nconst EXEMPT_FLAG = true`. The real script prints
`✗ TDZ: 'EXEMPT_FLAG' read at line 1 but declared at line 2` and exits 1; the
mutant prints `✓ TDZ check: no temporal dead zone issues` and exits 0.

The indented half staying GREEN in that row is the half that makes it a
measurement of the column. A mutation that turned both halves red would mean
the mutant had stopped working, not that the pair isolates indentation —
which is why the in-tree case asserts the mutant still refuses the indented
fixture before it asserts anything about the column-zero one. Neither
mutation is left in the tree; both were run and reverted.

### When the guard is a spawn, not a comparison (#171)

#169's refusal was correct and incomplete: it stopped a run whose branch had
moved past the reviewed commit, and nothing looked at the new tip. #171 makes
the run re-review instead, which means the thing that must be able to fail is
no longer a comparison but a SPAWN — and a spawn is the easiest thing in a
workflow to prove present and never prove load-bearing. "The decision block
called a function" is satisfied by a function that does nothing.

So the binding is the one call that re-reviews, declared as a literal in
`test/security-verdict-blocks.test.ts` (`REREVIEW_SPAWN`) and removed from a
copy of `workflows/ship.js`'s decision block. The assertion is not merely "the
mutant goes red" but something narrower: **the mutant must REFUSE.** A mutation
that made the run ship anyway would mean the fall-through never depended on the
review at all, which is this whole file's subject.

What was broken to prove it, run and counted rather than asserted:

| Mutation | Red |
|---|---|
| the re-review spawn short-circuited to `undefined` in the real source | 11 of 201 in `test/security-verdict-blocks.test.ts` — including the remediate-then-ship case, which then refuses rather than shipping |
| the spawn renamed | 13 of 200 — every mutant-building case throws `could not build the mutant: the re-review spawn appears 0 times` |
| `--base` dropped from ship.js's inlined `rookScopeCommand` | 2 of 200 — the re-review reads the whole branch again, and the parity matrix catches the divergence from the library |
| `--base` dropped from `lib/security-verdict.ts` instead | 2 of 200 — the same pair from the other side, which is what a parity matrix is for |
| exhaustion collapsed into the staleness refusal (`const spent = false`) | 4 of 200 — the two refusals stop being distinguishable and the artefact stops recording the round count |
| the loop stops writing the re-reviewed commit back to `testedSha` | 5 of 201 — the Ship-round check would then measure against a review two commits old, and the loop would re-spend its whole budget reviewing the same tip |
| the rook slot pointed back at the unrefined `AgentSchema` | 5 of 33 in `test/record-security-verdict.test.ts` — `refusal` and `rounds` are stripped, and a `PASS` carrying the refusal is accepted |
| `failureList`'s `EXHAUSTED` early return removed | 2 of 33 — an exhausted record starts carrying findings, so it reads as a review that found something |
| `rereviewCriteria` short-circuited to `return []` | 7 of 19 in `test/harness-standard-security.test.ts` — the count, both id comparisons, the numbering, and all four per-criterion cases |
| `SC-625` planted in the section with no registry entry | 2 of 19 — the count and the both-directions comparison; the per-criterion loop still passes, which is why the registry exists |
| the phrase naming spent attempts deleted from the spec prose | 2 of 19 — and only because the search removes SC lines first: the phrase survives inside the SC line that demands it, so a whole-section search would have gone green over a spec that no longer explained itself |

That last row is the self-reference trap, met from the other direction and
caught by the guard it describes: an SC line that names its own tokens is not
evidence for them. None of the eleven mutations is left in the tree; all were
run and reverted, and the two counted over 201 tests were re-measured after the
write-back case was added.

### When the fix is a VALUE and the proof has to be the subsystems (#274)

#215 added a tier floor and proved it resolves STANDARD for a project that
declares pages. That is a correct proof of the wrong claim. Nobody is harmed by
the string `"LIGHT"`; they are harmed because the scope gate, Quinn local,
container verify and prove do not run and the run still reports DONE. A suite
that only reads the resolved tier is asserting the value the test itself set up
the inputs to produce.

So #274 watches the subsystems EXECUTE, each through its own output —
`scopeRan`, the `quinn-local-1` agent label, the `container-rebuild`,
`env-check` and `quinn-container` labels, the container-declined arm's skip
log, and the prove workflow's `scriptPath`. Nothing in the suite reads
`ceremonyTier`, and that prohibition is COUNTED by a scanner rather than left
as a comment.

Three properties this example adds that the earlier ones did not need:

- **The fixture needs every input the subsystem needs, not just the one the
  issue is about.** Declaring `pages` floors the tier, and a fixture that
  stopped there would satisfy the tier claim while SILENTLY skipping container
  verify (which also needs `containerConfig`) and prove (which also needs
  `hasUIACs`). Three of five running looks exactly like five of five when the
  only thing asserted is that the ones you watched ran.
- **The run must start from the input that would skip.** Every block is handed
  the fixture's own LIGHT discovery, not a STANDARD the test typed in.
  Hardcoding it to `"STANDARD"` turns 1 of 27 red — and without that case the
  floor would be irrelevant to every observation in the file while all of them
  stayed green.
- **An observation of a subsystem running is only evidence if the same
  observation has been seen to go red when the subsystem is skipped.**

`test/consumer-tier-downgrade-mutation.test.ts` is the worked example for the
third. The pre-#215 defect is REBUILT — the `CEREMONY-TIER-FLOOR` block, the
floor call and the raise removed from a copy of `workflows/ship.js`, leaving
`hasUI` with nothing but its one-way downgrade — and a five-observation suite
is SPAWNED twice, with one argv, differing only in `SHIP_UNDER_TEST`. Four
properties make it work, all asserted by the test rather than left as
conventions:

- **Green and red are compared by NAME.** "1 of 5" is satisfied by any one of
  the five. Only `remote pre-flight runs` means what this claims, and it means
  it because the pre-flight is the one subsystem in the set that is NOT
  tier-gated — it runs ~450 lines before `ceremonyTier` is first read. It is
  the positive control: a suite that failed to resolve its imports leaves 0 of
  5, and a count alone cannot tell those apart.
- **`ran` is read before any verdict.** Both spawns assert five test cases came
  back from the junit report first. A suite that never loaded reports no
  failures, which is indistinguishable from a suite that passed.
- **The mutation is local.** All ten extracted ship.js sites are compared
  byte-for-byte between the real source and the mutant, so the four reds are
  caused by the tier the chain resolved and not by a mutant that damaged the
  blocks it is measured through.
- **Each removal site is located exactly once, and the builder throws when one
  moves.** A second copy of the downgrade would survive the removal and leave
  the mutant behaving like the real source.

One counting decision is part of the proof rather than a detail. `ship.js` has
five tier-gated CONDITIONS but four tier-gated STATEMENTS — container verify
and the container-declined arm are two arms of one `if`/`else if`. They are one
observation, which asserts both arms. Splitting them would report five reds for
one mutation applied to one branch point, and a mutation count that overstates
what it measured is the same defect as a check that cannot fail, pointing the
other way.

What was broken to prove it, run and counted rather than asserted, over the
five files #274 adds (113 tests):

| Mutation | Red |
|---|---|
| the unconditional `hasUI` downgrade restored | the mutation the file ships, measured rather than claimed: the spawned suite returns 1 pass / 4 fail of 5, the single green being `remote pre-flight runs` |
| the floor's comparison short-circuited to `return tier` in `workflows/ship.js` | 15 of 113 — and the pre-flight's own emission count stays GREEN while the "two runs resolved different tiers" case goes red, which is the asymmetry in one measurement |
| `buildRestoredDowngradeMutant` short-circuited to `return src` | 6 of 13 in that file |
| the downgrade site renamed to `!hasUIProject` in `workflows/ship.js` | the whole file ABORTS in `beforeAll` — 0 of 13 run |
| `FIXTURE_TIER` hardcoded to `"STANDARD"` in the helper | 1 of 27 — the premise case |
| `prevalidateEvidence` short-circuited to `return []` | 5 of 22 |
| `grepNoMatchIsResult` short-circuited to `return false` — #271 reverted | 5 of 22 |
| `rebuildExecutions` short-circuited to `return []` | 2 of 30 — only the positive controls, which is why they exist |
| `stripComments` short-circuited to `return source` | 1 of 30 |

None is left in the tree; all were run and reverted, and `workflows/ship.js`
and `lib/evidence-prevalidator.ts` were confirmed byte-identical afterwards.

### When the check is a comparison between documents (#621)

Three files in this tree name the project's test command. Nothing compared
them, and on the day #621 was filed they named two different things —
`AGENTS.md` and `.github/workflows/ci.yml` both said `bun test`, while
`.claude/rungate/config.json`'s `test.command`, the spelling the ship gate
actually measures with, said `bun test --parallel --no-isolate`. The
`--parallel` is what starved 122 I/O-bound tests past bun's per-test
timeout, so every ship run reported `SHIP_PASSED_SUITE_FAILED` over a tree
with zero real failures.

A check that reads N files and compares what it found has one characteristic
way to die, and it is the third shape: **finding nothing in every file is
perfect agreement.** Zero strings are trivially all equal, so a template edit
that moves a table row or renames a CI step converts the check into a
ceremony without changing a line of it. `test/test-command-agreement.test.ts`
answers that by making every extractor REFUSE when it finds no command, and
by letting the refusal out of `testCommandAgreement` rather than folding it
into an empty violation list.

What was broken to prove it, run and counted rather than asserted, over
`test/test-command-agreement.test.ts` (4 tests). Baseline before any
mutation: **4 pass, 0 fail.**

| Mutation | Predicted | Red |
|---|---|---|
| the distinct-command set truncated to one entry, so `violations` is always empty | 2 | **2 of 4** — `AC-8a` and the spawned counted case |
| the AGENTS.md extractor returns `[]` instead of refusing when the `\| Test \|` row is absent | 1 | **1 of 4** — `AC-4b` |
| the AGENTS.md extractor matches the whole document instead of the `## Commands` slice | 1 | **1 of 4** — `AC-4b` |
| the missing-file refusal removed from `testCommandAgreement` | 1 | **1 of 4** — `AC-4b` |
| the CI extractor stops excluding `bun install` and `bun run typecheck` | 3 | **4 of 4** |

Before believing any of those, the input on which mutant and original differ,
named and run rather than assumed:

- **row 1** — a tree whose config says `bun test --parallel` while the other
  two files say `bun test`. The original reports one violation naming all
  three positions; the mutant reports none.
- **rows 2 and 3** — an `AGENTS.md` carrying `## Commands` with no `Test` row
  and a `| Test | \`bun test\` |` row further down, outside the section. The
  original refuses; the mutant returns `bun test` it read from the wrong
  region. Row 3 is `.claude/rules/checks-must-be-able-to-fail.md`'s own
  "search the slice, not the document", and the fixture for it exists only
  because the slice is otherwise untestable — the real `AGENTS.md` has both
  a Commands row and a `**Test:**` line in its Workflow section, and they
  agree, so the live tree cannot witness it.
- **row 4** — an empty directory. The original throws `NoTestCommandError`;
  the mutant throws `ENOENT` from `readFileSync`, which no caller can tell
  from a genuine refusal.
- **row 5** — a `ci.yml` whose `test:` job runs `bun install` and
  `bun run typecheck` and nothing else. The original refuses; the mutant
  reports `bun install` as the project's test command.

**Row 5 came back HIGH, and the extra red is the real kind.** The prediction
covered the three cases that read the live tree; the fourth is `AC-4b`'s
"a CI job that runs only setup names nothing" fixture, which is red for a
reason squarely about the mutated behaviour — the exclusion set is what makes
that job name nothing, so removing it breaks the refusal and the reading at
once. Not a crashing mutant: the three live-tree reds are about the value the
extractor returns, and the file still parses and runs. Per the arithmetic
above, that is "the prediction was wrong and the check is better than you
thought", and the fact it records is that `NOT_THE_TEST_STEP` is load-bearing
in two directions, not one.

Two properties of the counted case are worth stating, because an in-process
assertion that `violations` is non-empty does **not** establish them:

- **The case is spawned, not described.** `violations.length === 1` proves the
  function can disagree. It does not prove the CASE fails — a case that
  computed a verdict and never asserted on it passes either way. So the
  agreement case is run in a subprocess against a planted copy of the three
  files, and the colours are counted.
- **The control runs too, and `ran` is read before any verdict.** An
  unmutated copy of the same three files is spawned first and must come back
  green. A `-t` filter that matches nothing leaves bun reporting zero
  failures, which is indistinguishable from the check passing and is also
  what a run that failed to resolve its imports looks like, so both spawns
  assert `ran === 1` before anything else.

None of the five mutations is left in the tree; all were run and reverted,
and the test file was confirmed byte-identical afterwards.
