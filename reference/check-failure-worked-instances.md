---
description: Worked instances behind `.claude/rules/checks-must-be-able-to-fail.md` — batteries, mutation counts and named wrong fixes, moved out of the always-loaded surface (#1009)
doc-type: reference
status: active
owner: jason
updated: 2026-10-21
---

# Checks that could not fail — the worked instances

This is the record half of `.claude/rules/checks-must-be-able-to-fail.md`. The
rule stays in `.claude/rules/`, where every agent loads it on every turn. These
instances live here, where they are read when somebody is writing or repairing
a check.

The move was #1009 and nothing was rewritten: every section below is the text
that was in the rules file, in its original order, at its original heading
level. Two of these tables are byte-compared against `specs/HARNESS-STANDARD.md`
by `test/fixed-window-record.test.ts` and `test/battery-record-currency.test.ts`,
which now read this path. Reformatting one is red.

### On the fourth shape

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

### Before you believe an empty search over a store you did not write (#646, #657)

Everything above is about a battery you run. This is about **evidence you
gather by hand**, and it needs its own section because the two instruments
either side of it cannot reach it.

- *Before you believe a 0, check the instrument (#60)* is one section up, and
  its tell is **the baseline row**. A battery has a baseline; a grep does not,
  so the diagnostic it offers is unavailable the moment you are searching
  rather than mutating.
- *The artifact everyone reaches for as ground truth (#530)* is the mirror
  case: a permissive store answers **yes** to every question of the form "is
  this here", because you put it there. Positive result, and the direction of
  the error is toward believing something happened. **This one is negative** —
  zero hits — and the direction is toward believing nothing happened, which
  is the direction nobody investigates.

Three sessions in one night read an empty grep over an artifact store as
evidence that a subsystem had never fired. An absent instrument and an absent
problem produce byte-identical output: no hits, exit 1, nothing to look at.

**The check, in one line: before believing an empty search over a store you
did not write, name a string that must be PRESENT if the store has anything
in it at all, and go and find it.**

Phrased after the property deliberately, because the proxy version — "check
the path exists" — is satisfiable without answering the question. The path
below exists. It has fourteen directories in it. It contains none of the data.

#### The instance, with the command beside every number

Measured 2026-10-19 against `~/.claude/projects/-Users-jhorn`. Every count
here is the output of the command printed with it, re-run on the day this was
written. Earlier readings of the same searches returned smaller numbers
against a smaller store, which is the other reason a number travels with its
command: a count with no command is not reproducible and not datable.

```bash
# The search that read as "the subsystem never fired":
grep -rl "HILL-CLIMB skipped" "$STORE"/*/workflows/        # → 1
```

One hit. The conclusion drawn from it was that hill-climb skips essentially
never happen. Now the control — a string that cannot be absent from a
transcript store containing anything:

```bash
ls -d "$STORE"/*/workflows/                                # → 14 directories
grep -rl '"type":"assistant"' "$STORE"/*/workflows/        # → 0
```

**Zero assistant messages across fourteen directories of transcripts.** That
is impossible, and it is the whole finding: the search was pointed one level
too shallow. The transcripts live a directory deeper.

```bash
grep -rl '"type":"assistant"' "$STORE"/*/subagents/workflows/wf_*/   # → 4218
grep -rl "HILL-CLIMB skipped" "$STORE"/*/subagents/workflows/wf_*/   # → 62
grep -rl "compliance data written to workflow-state.json" \
     "$STORE"/*/subagents/workflows/wf_*/                            # → 56
```

62, not 1. The subsystem fires constantly.

Note what the control bought and what it did not. It did not find the right
path — a human did, afterwards. It established that **the reading was not a
reading**, which is the only thing that makes anyone go looking.

#### The inverse, in the same store: a populated result that is not evidence

Same section, because the two are one habit and splitting them lets a reader
adopt the half that is easier. A non-empty result is not automatically a
measurement either:

```bash
grep -rl "persist-compliance" "$STORE"/*/workflows/        # → 108
```

108 hits on the shallow path that had 0 assistant messages — so whatever
these are, they are not transcripts of the script running. They are workflow
summary JSON whose `script` field embeds the whole of `ship.js`, which
contains the string. **The store is quoting the subject back.**

```bash
grep -rl "persist-compliance" "$STORE"/*/workflows/ \
  | xargs grep -l "HILL-CLIMB skipped"                     # → 1
```

One of the 108 is evidence of execution. 107 are the code naming itself.

This is adjacent to #530 and not the same: there the store says yes because
**you** wrote the value; here it says yes because it archives the code that
mentions it. Same remedy either way — ask for a string only a RUN produces,
never one the subject contains.

#### What to do

1. Name a control string that must be present if the store holds anything.
2. Run it over the exact path you are about to conclude from.
3. If the control is zero, your reading is `UNMEASURED` — not "no problem".
4. Record the command beside the count. A number without its command cannot
   be re-run, and the store underneath it moves.

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

### The same blindness with the axes swapped: every row varied the detector (#1233, #1246)

The section above is about fixtures that all satisfy a precondition. This is
its mirror, and it earns a separate entry because the axis held fixed here is
the one nobody thinks to interrogate: **the input**. The rule file's seventh
shape is these two together.

#1233 shipped a check proving the AI reviewer had read `REVIEW.md` before it
concluded. The evidence was a grep over the action's execution transcript:

```
grep -qE '"file_path"[[:space:]]*:[[:space:]]*"([^"]*/)?REVIEW\.md"' "${AI_REVIEW_EXECUTION_FILE}"
```

A five-row battery ran over it before it merged. Every row matched its
predicted count and its predicted case names, including the cheapest wrong
fix at 3 red. By every diagnostic already in this file it was a model
battery.

What it could not see: a `Write` whose `file_path` ends in `REVIEW.md` emits
the same text in the transcript as a `Read` does, and `Write` was in the
reviewer's granted tools. So a reviewer that never read the conventions and
merely wrote the file passed — on a check whose whole purpose is to be
unsatisfiable without reading. The path was unanchored too, so a branch's own
`sub/REVIEW.md` credited a check about the base-restored root file.

**Every row mutated the matcher. Every row fed it a `Read`.** No count in
that table could have come back wrong about a `Write`, because no row
contained one. The battery varied the detector and held the input fixed, and
the defect was a property of the input.

It was found by a reader varying the tool, not by the battery — the #59 route
above, reading the mechanism rather than running it. Both halves were then
added as cases and **watched red before the repair**: 16 pass, 3 fail.

#### A mutation is a thing you spell

The repaired battery is eight rows over 22 cases, and the row the change
rests on — M3, *the shipped matcher restored* — was run twice, before and
after a rebase. It returned **6, then 5, against a prediction of 5**.

| Run | Red | Against a prediction of C1d, C1e, C9, C9b, C11 |
|---|---|---|
| first spelling | 6 | C1d, C1e, C9, C9b, C11, **C12** |
| second spelling | 5 | C1d, C1e, C9, C11, **C12** — C9b green |

Read as a bare number, the second run confirms the prediction exactly. It
does not: `C9b` was predicted and stayed green, `C12` was not predicted and
reddened. **The count agreed and the membership did not.**

The two runs differ because the two spellings are two experiments. The first
replaced the whole `conv_path`/`conv_a`/`conv_b` machinery with the shipped
one-liner, which deletes the very string C9b rewrites to build its own
mutant — so C9b reddened on *"the mutation did not apply"*, the failure mode
this file already warns about, and not on behaviour. The second kept the
variables and restored only the semantics, which is the better experiment: it
changes the behaviour under test and nothing else.

`C12`'s appearance in both is the cross-cutting case working rather than
noise. It is the only case whose subject is the anchor itself, so it reds on
any mutation that removes the anchor as well as on the one that unescapes it;
the prediction filed it under a single row and forgot that.

**So: a battery that reports counts without memberships cannot distinguish
"the guard behaved differently" from "the mutation did not apply."** Predict
the case list, and write down which spelling you ran.

**Not the sixth shape, though they arrive together.** *Green on the exit
code, witnessing the wrong mechanism* is a single case whose **signal** two
mechanisms can both produce. This is a battery whose rows never vary the
**input**. The remedies are different and neither substitutes: assert on a
channel only the intended mechanism can write, versus vary the input in at
least one row.

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

### When the symptom is a refusal, the cheapest wrong fix is to widen it (#627)

The fifth shape again, and this instance is worth its own row because of
where the wrong fix lives: **inside the guard that reported the problem.**

Wave integration handed `collectAgentWork` rows built from `buildResult`
alone. #178's claim is a sibling of the build result, not a field in it, so
every row arrived with `claimedFiles` undefined and SC-413 read a wave in
which nobody had claimed anything. Run `wf_9e60257d-7d3`: three worktrees,
correct non-overlapping claims, every reported file inside its own claim,
nine files refused as unclaimed, run dead at the barrier.

What an operator sees is a refusal naming files that were claimed. The
repair that makes it stop, in one word, is to let an absent claim through —
`claims.includes(key) : claimant === wt` becomes `: true`. It works. The
wave integrates, the run completes, and the claim is exactly as absent as it
was, with the #296 fail-open reinstated for every run in the process.

So the regression case asserts **where the claim went**, not whether anybody
complained about its absence. `claimReachedCollector` in
`test/wave-integration.test.ts` reads the rows handed to the real
`collectAgentWork` — recorded before it runs — and compares each worktree's
`claimedFiles` to its sub-issue's own claim. The wave's verdict is asserted
separately and deliberately never feeds that function: a case built on the
verdict is green under the wrong fix, which is the thing being avoided.

Three worktrees, not one and not two. With one,
`SINGLE_WORKTREE_EXEMPT` keeps every file whether a claim travelled or not,
so the case reaches its assertion without the feature; two is the floor at
which the claim is load-bearing, and three is the shape the run had. The
fixture builds its own worktree tree under `mkdtemp` and names no path that
exists in this repository — asserted, with `existsSync` over `REPO_ROOT`,
rather than promised — so it keeps witnessing after the run's nine files
move.

What was broken to prove it, run and counted rather than asserted, over
`test/wave-integration.test.ts` + `test/collect-claim-enforcement.test.ts`
(70 tests).

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 70 pass, 0 fail | **70 pass, 0 fail** |
| the claim-stripping mutant: the wave call site's pairing expression replaced by bare `waveResults`, so `integrateWave`'s own `.map(r => r.buildResult)` strips the claim | 3 | **3 of 70** |
| the cheapest wrong fix: the `Array.isArray` claim guard widened to let an absent claim through | 5 | **7 of 70** |
| the test's own `claimReachedCollector` short-circuited to `{reached: true}` | 2 | **2 of 70** |
| the genuinely pre-#627 `workflows/ship.js`, from this branch's merge-base | 3 | **3 of 70** |

Before believing any of those, the input on which mutant and original
differ, named and run rather than assumed: the three-worktree fixture
itself. On the pre-#627 source the AC-4 case fails with *"alpha arrived with
no claim at all (claimedFiles is undefined)"* — the run's defect, in the
test's own words — while on the live source the same case reads
`["fixture/alpha/reader.ts", "fixture/alpha/reader.probe.ts"]` off the row.
For the widened guard the input is the claim-less rows that path produces:
the real audit refuses all six, the widened one refuses none, both measured
in the case itself before the wave is driven.

**Row three came back HIGH, and the extra reds are the real kind.** The
prediction covered the five cases that reason about an absent claim
directly; the two extra are #228's preserve cases — *"every path on the
preserve command line is quoted"* and *"the preserve step is never pointed
at the project root"*. Both plant a worktree with no claim beside one that
claims the same file, and both reach the preserve step only because that
row is refused. Widen the guard and nothing is refused, so no preserve step
runs and there is no command line to inspect. Squarely about the mutated
behaviour, and not a crashing mutant: 63 cases still pass and every red is
claim-related. Per the arithmetic above that is "the prediction was wrong
and the check is better than you thought", and the fact it records is that
the claim guard is load-bearing for the preserve path too — the quoting
proof for a path that originates in an agent's reply depends on an absent
claim still being refused.

The last row is the one that is not a mutation at all: the pre-#627 source
is a real tree, and it is the only row that measures the case against the
defect rather than against a reconstruction of it. Its count matching the
reconstruction's is the evidence that the reconstruction is faithful.

None of the mutations is left in the tree; all were run and reverted, and
`test/wave-integration.test.ts` and `workflows/ship.js` were confirmed
byte-identical to the measured source afterwards. The counts are from a tree
carrying #627's staging change — `claimedWork` and the paired call site. On a
checkout without it the two mutant-building cases do not pass or fail
quietly: `mutate` finds the pairing expression zero times and throws *"could
not build the mutant"*, which is the loud-abort property the builder exists
for.

### When the check is a MATRIX, and some of its cells are controls (#652)

Two independent readings folded into one `if`. The wave-commit agent replies
`{committed, branch}`; `integrateWave` returned on `committed !== true`, and
the comparison that names the branch is the NEXT statement, so a refusal that
happened *because* of the branch returned the message that mentions no
branch.

Run `wf_9bb6f96d-200` died at `IMPLEMENT_FAILED` carrying *"the wave commit
did not report success"* while holding `branch: "main"` in the reply it had
just read. A peer session had run `git checkout -q main && git pull
--ff-only` in the shared `PROJECT_ROOT` after merging its own PR — confirmed
by that session, not inferred — and the commit prompt's own `main|master`
guard refused. **The guard was correct to refuse and is unchanged.** The
whole defect is in what was said about it, and in the fact that nothing
looked at the shared checkout between establishing the ref and committing
onto it twenty minutes later. The refuse-versus-re-establish choice that
follows from that is argued on #652 itself.

Two readings make four cells, and the test file drives all four plus two
controls. What this row is here for is the thing a matrix hides: **the cells
are not equally load-bearing, and a matrix that is green everywhere looks
identical whether its cells witness the fix or merely sit beside it.**

Measured over `test/wave-integration.test.ts` — 22 tests. Every count
predicted before the battery ran.

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — the intended implementation | 22 pass, 0 fail | **22 pass, 0 fail** | — |
| the genuinely pre-#652 `workflows/ship.js` | 6 | **6 of 22** — SC-2084, SC-2086, SC-2087, SC-2089, SC-2090, SC-2091 | `{committed:false, branch:"main"}`, the dead run's own reply: the original says *"…did not report success — it reported branch main, not the run ref `rungate/run-652`, so the shared checkout has been moved (#652)"*, the pre-#652 source says *"the wave commit did not report success"* |
| the `committed` arm returns the bare generic sentence again — the defect verbatim | 3 | **3 of 22** — SC-2084, SC-2086, SC-2087 | the same reply |
| the clause naming the ref dropped from the cell whose branch AGREES | 1 | **1 of 22** — SC-2087 | `{committed:false, branch:"rungate/run-652"}`: the original names the ref, the mutant falls back to the bare sentence and becomes indistinguishable from a reply that named no branch at all |
| the branch clause appended unconditionally, including where no branch was reported | 1 | **1 of 22** — SC-2088 | `{committed:false, branch:""}`: the original returns the bare sentence, the mutant returns *"…it reported branch , not the run ref `rungate/run-652`"* — an empty clause reading as a disagreement |
| "did not report success" prefixed to the committed-TRUE disagreement too | 1 | **1 of 22** — SC-2085 | `{committed:true, branch:"fix/someone-elses-work"}`: a commit happened, and the mutant says it did not |
| one composed message for every failing cell | 2 | **2 of 22** — SC-2084, SC-2085. **Was 1** | the same reply, plus the pair that varies only `committed`: `{committed:true, branch:"main"}` against `{committed:false, branch:"main"}` |
| the pre-wave re-read removed — #420's behaviour | 3 | **3 of 22** — SC-2089, SC-2090, SC-2091 | a two-wave plan whose SECOND checkout reading reports `main`: the original spawns `marcus-sub-420001` and nothing else and fails naming the branch, the mutant spawns `marcus-sub-420002` and reports success |
| the re-read taken and `runRef` not written back | 1 | **1 of 22** — SC-2091 | a three-wave plan whose second reading reports `rungate/run-420-reestablished`: the original drives wave 2's integration with that ref, the mutant with `rungate/run-420` |
| the drift observed and logged, and the wave spawns anyway | 1 | **1 of 22** — SC-2090 | the two-wave plan above |
| the re-read moved BELOW the wave's spawns | 2 | **2 of 22** — SC-2089, SC-2090 | the same plan: the original records its second reading at spawn clock 1, the mutant at clock 2 with wave 2 already dispatched. That is why SC-2089 asserts the ORDER and not the count |

**Provenance, because the two halves were measured differently.** Every row
except the second was first measured by the sub-issue that shipped the cases,
on a `git archive` export under `/tmp` carrying the test file plus the
intended `workflows/ship.js` change, which was not in the tree at the time. A
row measured on a tree nobody can check out is a claim rather than a count, so
this paragraph used to end *"re-run the rest against the tree once the
implementation lands."* The pre-#652 row was the exception: it was re-measured
against the shipped test file and the unmodified `workflows/ship.js`, and
reproduces at 6 of 22 naming the same six cases.

**#653 did, and all ten reproduce — same counts and the same named
criteria.** Nothing is carried over. `Predicted` above is therefore the
earlier measurement, written down before the re-run as the thing being
tested; the finding would have been a row that MOVED.

Two of the ten needed their mutation re-cut before they were faithful, and
that is recorded rather than quietly fixed, because a prose description of a
mutant is not a mutant:

- **the pre-#652 row** is the whole pre-#652 tree, which lacks the pre-wave
  re-read as well as the reordered arm. Mutating only `waveCommitFailure` is
  3 of 22, not 6 — the three dispatch criteria stay green, because nothing
  touched the thing they measure.
- **the composed-message row** must leave the `!landedOn` early return INSIDE
  the committed-false arm. Hoisted ahead of both arms it also intercepts
  `{committed: true, branch: ""}`, which SC-1565 owns, and the row reads 3
  with an extra red that is about the mutant rather than about the subject.

That correction reached `specs/HARNESS-STANDARD.md` in PR #794 and this file
in #795, which is five days apart and is the reason
`test/battery-record-currency.test.ts` exists: a measurement written down in
two places is corrected in one of them, and nothing was comparing the two.
#666's byte-identity check does compare these same two files — over a
different block, eleven screens up.

**The two cells the pre-#652 row does not name are the point of this
section.** SC-2085 (committed TRUE onto a foreign ref) and SC-2088 (no branch
reported at all) are **green on the defective source**. They are not
witnesses of the fix; they are controls against the wrong *composition* —
appending the generic sentence to every failure, and appending a branch
clause unconditionally. Both are repairs that can only arrive after the fix,
so there is no state of the code in which they go red for the original
defect. Five commit-reply cases, five greens once the fix lands, three of
them witnesses. Say which cells are witnesses and which are controls, or the
next reader counts five.

**The low row is the matrix's own trap.** SC-2084 asserted the three failing
cells produce three distinct sentences, as a `Set` of size 3. The three
replies name *different branches*, so the strings differ whatever sentence is
wrapped around them — the assertion was measuring the interpolated branch
name, not the cell, and "one composed message for every failing cell" came
back 1 where 2 was predicted. The fix is #585's pair discipline applied
inside a matrix: **vary exactly one reading.** `{committed:true,
branch:"main"}` against `{committed:false, branch:"main"}` reports the same
branch and differs only in the flag, so comparing those two is a measurement
of the flag. With that case added the row is 2.

**The cheapest wrong fix, named: delete or widen the commit prompt's `case
"$branch" in main|master) … exit 1`.** What an operator sees is that guard
refusing, so the 5pm repair is to stop refusing — and it works. The wave
commits, the run completes, and unreviewed agent output lands on the default
branch: #267/#136 verbatim, which on 2026-10-11 left 907 lines of it staged
on `main`.

Do the shipped cases survive it? Two different answers, and the difference
between them is the part worth copying:

- The five commit-reply cases survive it **vacuously**. The reply is
  injected, so no shell guard runs in any of them and widening or deleting it
  changes none of their verdicts. They do not certify the regression — but
  they do not catch it either. What catches it is SC-1564, which reads the
  prompt text and asserts `main|master` is in it. The halves are deliberately
  separate: a case that both read the prompt and judged the reply would be
  two questions in one assertion (#484), and would go green under half a
  repair.
- The three dispatch cases survive it **non-vacuously**. Their refusal is
  `runRefRefusal`'s, raised before wave 2's agents are spawned and before any
  commit is attempted, so a run with the prompt guard deleted still fails
  SC-2090 — the checkout is still on `main` and the dispatcher still has to
  say so.

So "survives the wrong fix" has two grades and only one of them is
protection. A vacuous survival is worth stating precisely because it names
the case that IS the protection; left unstated, it reads as coverage, and
deleting the guard would then be a change with eight green cases beside it.

### When the consumer is a SCHEMA, and the thing it drops is the fix (#646)

#621 above is two documents naming one string with nothing comparing them.
This is the same family with the consumer in an unusual position: **a
structured-output schema is not a description of the reply, it is a filter on
it.** Every field it does not declare is removed on the way back, silently,
and the caller then reads a reply that is missing exactly what it did not ask
for. There is no error, no warning and no shorter output — the object simply
arrives with fewer keys.

`scripts/persist-compliance.ts` was changed by #646 to say WHICH of five
outcomes each hill-climb reached, instead of printing `hillClimbApplied: 0`
for all five and for a clean run as well. The script does not reach the
operator: `workflows/ship.js` asks an agent to run it and return the receipt
under a declared schema, and that schema named six scalar fields. A receipt
carrying `hillClimb` would have been filtered back down to the pre-#646
shape, one hop before anyone read it, and the run would have logged the exact
line the issue exists to replace.

**The producing side cannot see this at all.** Every test over
`persistCompliance` passes — the function returns the field, and
`test/unit/hill-climb-receipt.test.ts` reads the returned receipt, which is
the right thing for it to read. The loss happens in a position neither end
owns, and the only way to see it is to compare the two.

So `test/persist-receipt-relay.test.ts` holds one exported binding,
`persistReceiptRelayViolations`, which walks the schema literal sliced out of
`workflows/ship.js`'s `PERSIST-RECEIPT` block and the field paths of receipts
the **real** `persistCompliance` produced, and names every carried path the
declaration would drop. Four properties, each because of a shape named
elsewhere in this file:

- **The receipts are produced, never typed.** Reading the `PersistResult`
  interface as text would assert that a type annotation exists — and a type
  is erased before anything runs, so a field the script stopped returning
  would still be in the interface. #530: ask the contract, not an artefact
  that agrees with whatever you put in it.
- **An unreadable position THROWS.** Zero declared properties against N
  carried fields is not agreement, and neither is an empty receipt set. Both
  refuse by name, because a comparison that could not be performed reads
  exactly like one that passed (#621).
- **A vacuity case stands beside the agreement case.** Receipts that never
  reached an occurrence would agree with a schema declaring none, so one case
  asserts the fixtures really carry all five state keys and the three
  occurrence fields under two different parents.
- **The declared schema is the schema the call is handed.** A perfect
  declaration beside a second literal at the call site is the same defect
  wearing a fix, so the call site is asserted to pass
  `schema: PERSIST_RECEIPT_SCHEMA` and the const is asserted to exist once.

**The cheapest wrong fix, named: declare `hillClimb: { type: 'object' }` and
stop there.** It is one line, the field stops being dropped outright, and
every sub-field under it still is — the operator gets `hillClimb: {}`, which
is `0` with more punctuation. The cases survive it NON-vacuously: the walk
compares paths, not top-level keys, so the eighteen paths beneath `hillClimb`
are still violations and "no field of any real receipt is dropped by the
relay" stays red until the states are declared by name.

What was broken to prove it, run and counted rather than asserted, over
`test/persist-receipt-relay.test.ts` (17 tests). Every count was predicted
before the battery ran, and **the baseline row was read before any mutation
row** — an instrument that has stopped reporting takes the baseline down with
it, and that is the row nobody checks.

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 17 pass, 0 fail | **17 pass, 0 fail** | — |
| `persistReceiptRelayViolations` short-circuited to `return []` | 8 | **8 of 17** | any of them: the binding stops refusing an unreadable source, an empty receipt set, and all six dropped-field mutants |
| the genuinely pre-#646 schema literal — six scalars, no `hillClimb` | 7 | **7 of 17** | the NO_SUITABLE_SECTION receipt: the original returns `[]`, the mutant returns **19** violations, from `hillClimb` down to `hillClimb.unclassified[].detail` |
| `NO_SUITABLE_SECTION` dropped from the schema declaration | 6 | **6 of 17** | the same receipt: the original returns `[]`, the mutant names `hillClimb.states.NO_SUITABLE_SECTION` and its three occurrence fields |
| the pre-#646 operator line — `hill-climb reinforcements=N` and nothing else | 4 | **4 of 17** | a clean grade against a brief with no insertion point: the original prints `not applied: NO_ACTIONS_DETECTED=1` for one and `not applied: NO_SUITABLE_SECTION=1` plus an `UNMEASURED hill-climb` line for the other, the mutant prints the same sentence for both |
| the state clause never appended to the line | 3 | **3 of 17** | the same pair, plus the unclassified receipt |
| the absent-`hillClimb` UNMEASURED branch removed | 1 | **1 of 17** | a receipt with `hillClimb` deleted — which is precisely what a relay that dropped it delivers: the original says `UNMEASURED hill-climb`, the mutant prints an ordinary clean line |

**The 6 row is 6 and not 1 on purpose, and it is worth saying why before
someone reads it as an over-broad case.** Each of the five per-state cases
asserts the real source agrees BEFORE it asserts the mutant disagrees — "the
real source is clean" and "the mutant is not" are one claim read in two
directions, and a case asserting only the second passes over a binding that
refuses everything. So a single real-source removal reds all five of them
plus the agreement case. The 8 row is the complement: short-circuiting the
binding leaves the real-source half green and reds only the halves that
need a refusal.

None of the six mutations is left in the tree; all were run and reverted, and
`workflows/ship.js` and `test/persist-receipt-relay.test.ts` were confirmed
byte-identical to the measured source afterwards by checksum.

**Provenance.** The table was measured by the wave that wrote the relay test,
whose worktree was never collected. The baseline and two rows — the binding
short-circuited, and the pre-#646 schema literal — were re-measured on the
shipped tree and reproduce exactly (17 pass / 0 fail, 8 of 17, 7 of 17). The
other three were not re-run; they are rows about `persistReceiptLines`, whose
source is byte-identical to the measured one.

### When the DERIVATION of a check is the thing being tested (#637, #626)

#626 shipped six parity categories drawn from a twelve-row table of defects
this harness had already paid for. Phase 1 proved the command RUNS — six
verdicts, coverage beside each, UNMEASURED where it could not compare. What
no amount of that establishes is that **category N catches the defect row N
was derived from**, and without it the six categories are a paraphrase of the
table rather than a test of it.

The shape this section adds is specific to that: a check derived from a known
defect, whose defect is now FIXED. Four of the six derivation issues are
merged, so the live tree cannot witness any of them, and the only honest case
is one that PLANTS the pre-fix condition. **The trap is reaching for the live
environment instead**, and category 4 is the sharp instance: #597 merged as
`41f2e640` and CI now installs a pinned `agnix` before `bun test`, so a case
probing the ambient environment for a missing `agnix` passes today for a
reason that has nothing to do with the check. Nothing in
`test/contract-parity-derivation.test.ts` reads an external tool whose
installation state can move under it.

**That sentence cost a red test, and the red was correct.** Its first draft
quoted the pinned `agnix` version, and `test/ci-global-tools.test.ts` refuses
a version string with more than one declaring position — which is #621 and
#622's rule, met by the document explaining it. The version lives in
`.claude/rungate/config.json`'s `ci.globalTools` and nowhere else, prose
included.

Each of the six is paired with a control varying exactly one thing — the
config's string, the CI pin, the quoting of one shell word, the routing of one
spawn, one name in a schema, one row in a table. A case that only shows the
category refusing is satisfied by a category that refuses everything.

#### The cheapest wrong fix, named before the repair was described

AC-8's words are *"the exported symbol is declared exactly once"*. When that
goes red because somebody added a second `contractParity`, **the 5pm repair is
to delete the word `export` from the duplicate.** One word. The scan stops
seeing it, the violation disappears, and the tree still holds two deciders
answering one question, each still called from inside its own module — which
is the fourth shape, reinstated by the fix for the fourth shape.

The three AC-8 decider cases survive that repair **vacuously**: no fixture of
theirs contains an unexported duplicate, so none of them changes verdict. They
neither certify the regression nor catch it, and left unstated that reads as
coverage. What catches it is one further case and one further line of
`parityBindingViolations`: the ENTRY-POINT name is counted whether or not it is
exported, while every other parity name stays exported-only, because a
module-local `const parity` is nobody's second decider. That case survives the
wrong fix **really** — row M7 below is the repair applied, and it is 1 red.

#### Predicted and measured, over 51 tests

`test/contract-parity-derivation.test.ts` + `test/contract-parity.test.ts`.
Every count was predicted before the battery ran, in
`/tmp/637-battery/predictions.md`, and **the baseline row was read before any
mutation row** — an instrument that has stopped reporting takes the baseline
down with it, and that is the row nobody mutates anything to produce.

**Re-measured in full against the tree rebased onto `5a4abdc8`**, not carried
over. Three rows are new (M14–M16) and one was re-run after it turned out not
to be a mutation at all; the other twelve were run again rather than copied,
because a row measured against a tree nobody can check out is a claim rather
than a count (`.claude/rules/parallel-sessions.md`).

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 51 pass, 0 fail | **51 pass, 0 fail** | — |
| M1 `parityBindingViolations` short-circuited to `return []` | 5 | **5 of 51** | the duplicate tree: the original names both files, the mutant returns `[]` |
| M2 `declarationsNaming` short-circuited to `return []` | 6 | **6 of 51** | `REPO_ROOT`: the original reads every parity and `preflight` declaration in the tree, the mutant none of either |
| M3 the `UNMEASURED_PARITY_SCAN` refusal removed | 2 | **2 of 51** | a tree with no `contractParity`: the original refuses, the mutant returns `[]` |
| M4 the `PREFLIGHT_NAMED_PARITY` clause removed | 2 | **2 of 51** | a tree declaring `export const preflightParity` beside a correct entry point |
| M5 the `DUPLICATE_PARITY_BINDING` clause removed | 3 | **3 of 51** | a tree declaring `contractParity` in `scripts/` and in `workflows/ship.js` |
| M6 `commandDisagreement` short-circuited to `return []` | 4 | **4 of 51** | the #621 tree — config `bun test --parallel --no-isolate`, the other two `bun test`: original 1 violation, mutant none |
| M7 **the cheapest wrong fix**: the duplicate check narrowed back to exported-only | 1 | **1 of 51** | a tree with one exported and one UNEXPORTED `contractParity` |
| M8 `transportIsFirstParty` → `return true` | 2 | **2 of 51** | a foreign root: original `0/3` with no sites, mutant compiles and runs the library transport |
| M9 `AVAILABILITY_QUERY` replaced with `/(?!)/g` | 2 | **2 of 51** | a file calling `spawnSync(tool, ["--version"])` directly |
| M10 `undeclaredReadViolations` short-circuited to `return []` | 2 | **2 of 51** | the #530 tree reading `sf("testsSha")` against a schema that never declared it |
| M11 the #624 unaccounted-writer violation loop removed | 1 | **1 of 51** | the #624 tree writing `.claude/agents/marcus.md` with nothing declaring it |
| M12 the #622 unpinned-version violation removed | 1 | **1 of 51** | a `ci.yml` saying `bun-version: "latest"` |
| M13 a second copy of `testCommandsNamedByCiWorkflow` added to `scripts/` | 1 | **1 of 51** | the grep over `lib`, `scripts`, `gates`, `workflows` |
| M14 **the rebase row**: the whole of #735 reverted inside the moved module — what `git checkout --ours` produces | 4 | **4 of 51** | a matrix `ci.yml`: original reads `bun test` from `test-shard`, mutant reads `echo aggregate` from the job that now runs nothing |
| M15 only #735's SECOND change reverted — the shard selector left on the string | 4 | **4 of 51** | a SINGLE-job `ci.yml` running `bun test --shard=2/4`: original `bun test`, mutant `bun test --shard=2/4`. M16 is green on this input |
| M16 only #735's FIRST change reverted — the suite job name hardcoded to `test` | 4 | **4 of 51** | a matrix `ci.yml` whose shard job runs plain `bun test`: original `bun test`, mutant `echo aggregate`. M15 is green on this input |

#### The row that was not a mutation, and how it was caught

M9's first form edited the leading alternative of `AVAILABILITY_QUERY` —
`/(?:Bun\.spawnSync|spawnSync|execFileSync|…` — to `zzBun\.spawnSync`, and
measured **0 red against a predicted 2**. The reflex reading of a zero row is
"the cases do not cover this", and it is wrong here: `spawnSync` is its own
alternative three characters later, so the regex still matched every input the
cases supply. **There is no input on which that mutant and the original behave
differently.** The code ran twice.

A row that misses LOW is the one to stop on, and the rule that caught this is
the one stated above rather than any count: *before recording a number, name
the input on which mutant and original differ*. Re-run as `/(?!)/g` — a regex
that matches nothing — the row is 2, as predicted. The alternation is why a
mutation to one branch of a disjunction is nearly always a weak mutation:
pick the whole binding, or pick the branch and say which other branch covers
for it.

**Fifteen of sixteen matched on the first reading, which this file says to
distrust** — and the sixteenth is the reason it says so. So the
precondition question was asked of the battery rather than of the code (#492):
every fixture here is a tree the category CAN read, so the branch where it
cannot is outside the battery's reach entirely. That branch is #626 AC-4's,
measured by `test/contract-parity.test.ts` and in scope above — which is why
the two files are counted together rather than the new one alone.

**The battery did find one thing, and it was M2.** *"AC-8: `contractParity` is
not spelled preflight anywhere the scan can see"* iterates the declarations and
asserts each name. With the scan short-circuited to `[]` the loop runs zero
times and the case stayed GREEN — an assertion that holds vacuously, in the
file whose subject is assertions that hold vacuously. The first measurement of
M2 was 5. It now asserts the list is non-empty first, and the row is 6.

#### The control that had to become a floor, and why a count is the wrong shape

The instrument check beside M2 asserts the scan can still see this
repository's `preflight` family. Its first draft asserted **exactly 7**, which
was true the day it was written and is not a property of anything this case
owns. Between that measurement and the rebase, #721 landed `actionPinParity`
and took the parity count from 12 to 13 — a file this case does not name, in
an issue it has nothing to do with.

The preflight count happened not to move, so the case did not go red; it was
one unrelated merge away from doing so, and the red would have accused the
wrong code. This is #507's shape in a control rather than in a fixture: **the
margin was set by something outside the case.** The assertion is now a floor,
because what a control has to establish is that the scan READ something, and
an equality establishes that plus a fact nobody is maintaining.

The general form, since this file already says the mirror of it for refusals:
**when you assert a number about a collection you do not own, ask whether your
claim is about the count or about non-emptiness.** It is almost always the
second, and the second is the one that survives other people's work.

#### A relocation is a copy until something holds it to the original

This change moves ~200 lines out of `scripts/contract-parity.ts` into
`lib/test-command-positions.ts`. While it sat open, #735 landed CI sharding
and edited the same lines in their old home: `suiteJobName` became the one
binding deciding which job runs the suite, and a trailing `--shard=N/M` became
something the reader strips rather than a different command.

**The resolution that looks obviously right is the one that reverts it.**
`git checkout --ours` on that hunk resolves the conflict cleanly, compiles,
typechecks, and leaves a module that is #735's code in its new location only
by coincidence — it is the PRE-#735 code, and nothing in the diff says so,
because the diff is a file deletion beside a file addition.

Three things are true of that resolution and worth separating, because only
the third is protection:

1. **Typecheck does not see it.** Both versions are well-typed.
2. **The pre-existing suite DOES see it, by luck.** M14 is 4 red, and three
   of those four are cases that read the repository's own `ci.yml` and would
   have gone green the moment `ci.shards` went back to 1. Catching a
   regression because an unrelated config value happens to be set is not
   coverage; it is a tree that currently disagrees.
3. **A planted fixture sees it on purpose.** The `AC-9/#735` cases write a
   matrix `ci.yml` of their own, assert the extracted command is `bun test`
   rather than `echo aggregate`, and assert the equality the strip exists to
   produce — `--shard=2/4` equal to no flag, `--parallel` **not** equal, a
   differing command before the flag **not** equal. The second half is the
   one that keeps the strip narrow; without it the case is satisfied by a
   reader that discards every flag.

The general rule for a move: **name the commits that touched the source
region while your branch was open, and port each one into the destination
rather than resolving the conflict.** Then prove each carried with a case the
destination owns. A relocation with no behavioural case over it is #484's
shape — two expressions of one property, with nothing comparing them.

#### Which cells are witnesses and which are controls

Say which, or the next reader counts twenty-eight.

- **Witnesses** — red on the pre-fix condition, green on the control: the six
  `AC-6/#NNN` defective cases (one per category), the AC-8 duplicate,
  preflight-naming and instrument cases, the wrong-fix case, the three AC-9
  position cases, and the two `AC-9/#735` shard cases.
- **Controls** — green on BOTH sides by construction, and not evidence of any
  fix: the six `AC-6/#NNN control` cases, *"this repository reports no
  unaccounted writer"*, and *"the category reports PASS on this tree"*. They
  exist to stop a category that refuses everything reading as a category that
  catches something, and there is no state of the code in which they go red
  for the original defect.
- **One case moved from the second list to the first, and the battery is what
  moved it.** *"The moved bindings behave identically to what the script used
  to hold"* was written as a control and described here as one. It is red in
  M14, M15 and M16 — it drives `testCommandAgreement` over the LIVE tree, and
  this repository's `ci.yml` has been sharded since `c664837a`, so the live
  tree stopped being a tree on which both readers agree. A control that
  acquires a witness is better than it was; a control still *described* as
  one after that is a sentence nobody re-measured, which is the whole subject
  of this file. The honest reading of its red is narrow, though: it witnesses
  the shard port **only while `ci.shards` is set**. Set it to 1 and the
  generated workflow is single-job again, the two readers agree exactly, and
  this case goes green with nothing else changing — #507's shape, the margin
  set from outside. That is why the two `AC-9/#735` cases plant their own
  matrix `ci.yml` instead of reading the repository's.
- **The #530 artifact case is neither, and is the point of its category**: it
  asserts the planted `workflow-state.json` DOES carry `testsSha` — so a
  reading taken off the artifact would say yes — while the schema-based
  reading refuses. Opposite answers over one tree, which is #530 entire.

#### Provenance

Measured twice. First on the `fix/637-derivation-cases` branch as originally
written, and then **re-measured in full after rebasing onto `71e3f413`** —
eleven commits later, including #721's new `action-pin-parity` category inside
the very file four of these rows mutate. All thirteen rows and the baseline
reproduce exactly. A row measured on a tree nobody can check out is a claim
rather than a count (`.claude/rules/parallel-sessions.md`), and a rebase
retires the tree a row was taken on just as surely as a new commit does.

`lib/parity-binding.ts`, `lib/test-command-positions.ts` and
`scripts/contract-parity.ts` were restored from a `cp` backup after every row
and confirmed **byte-identical by sha256**, never by `git checkout --`. None of
the thirteen mutations is left in the tree. The harness ABORTS a row whose
anchor appears zero or more than one times rather than measuring nothing —
which is the property that made the re-measurement worth running at all, since
#721 added 253 lines to the file holding six of the anchors.

One row is NOT a reconstruction and is worth more than the twelve that are:
category 1's defect has a real pre-fix tree, and `#626 AC-5` drives the same
binding over a `git archive` export of `0357c06c^`. M6 reds that case and the
planted #621 case together, which is the evidence that the reconstruction is
faithful. **The other five categories have no such tree** — their derivation
issues are fixed and their pre-fix states were never exported — so those five
rows measure the case against a reconstruction and not against the defect.

### Eleven windows converted, and the measurement that says which were about to fail (#664, #666)

Ten guards in `test/` — eleven counting the two-sided one — cut a FIXED
NUMBER OF CHARACTERS out of a source they were making a claim about. That
satisfies the letter of *search the slice, not the document* and misses the
point: the region a claim is about ends where the construct ends, and
`at + 6000` is a guess about how long the construct will stay that size.
The guess decays silently, and the day it fails it accuses the wrong code.
`test/worktree-repo.test.ts` SC-1446 is the instance — 548 characters of
headroom, spent by a prompt insertion two functions away for an unrelated
issue, with the case reporting that an `else` which is still there and
still terminal had gone.

#664 converted all eleven to `structuralCut`/`structuralCutAround` in
`lib/source-slice.ts`, whose API has no numeric-length parameter anywhere,
and `test/no-fixed-window-slices.test.ts` holds the population at zero with
no exemption list. **Converting them erases the evidence that said which
were about to fail**, so the measurement is recorded here and in
`specs/HARNESS-STANDARD.md`, byte for byte, with
`test/fixed-window-record.test.ts` comparing the two.

The thing worth carrying away from it is the second column. A window can
have comfortable headroom against every string its case asserts and still be
SHORTER than the construct it is cutting — and then the case has never
finished reading its own subject, which no count of its assertions can show.
Two of the eleven are in that state, and both were green.

Measured at `3a122903`. `workflows/ship.js` is unmodified by #664 and by
this record.

#### The eleven pre-conversion windows, measured

| # | site | anchor | window | farthest-needed | headroom | construct | covered |
|---|---|---|---|---|---|---|---|
| 1 | test/worktree-repo.test.ts:764 | `Verify CODE regression #${regressionCount}` | 6000 | 5452 | 548 | 5752 | yes |
| 2 | test/agent-timings.test.ts:344 | `async function collectAgentWork(` | 6000 | 4977 | 1023 | 6482 | NO |
| 3 | test/decomposition-waves.test.ts:269 | `const M_DECOMPOSITION_SCHEMA` | 2000 | 776 | 1224 | 980 | yes |
| 4 | test/ac-coverage.test.ts:313 | `coverageViolations(goalData.successCriteria` | 1400 | 224 | 1176 | 430 | yes |
| 5 | test/recorder-command-executed.test.ts:350 | `For tests-pass:` | 1200 | 554 | 646 | 1031 | yes |
| 6 | test/suite-measurement-parity.test.ts:304 | `For tests-pass:` | 1200 | 554 | 646 | 1031 | yes |
| 7 | test/slug-derivation.test.ts:109 | `const REPO =` | 800 | 129 | 671 | 347 | yes |
| 8 | test/ac-coverage.test.ts:485 | `coversCriteria: { type: 'array'` | 600 | 363 | 237 | 1905 | NO |
| 9 | test/issue-close-guard-target.test.ts:160 | `the command names no repository` | 400 | 137 | 263 | 140 | yes |
| 10 | test/ship-and-heal.test.ts:74 | `qualityViolations.length === 0 && processViolations.length === 0` | 200 | 99 | 101 | 177 | yes |
| 11 | test/agent-timings-queued.test.ts:292 | `TIMING: ${t.agent}` | 1500 | 125 | 1375 | 928 | yes |

Row 11 is the two-sided form `slice(at - 1_500, at + 1_500)`; `window` is
the reach on each side and `farthest-needed` is the nearer-side distance, so
the arithmetic reads the same as every other row. Row 2's window was also
used with a second anchor, `async function preserveRefusedWork(` —
farthest-needed 478, construct 2045, headroom 5522, covered. The binding
anchor is the one tabulated; a window is only as good as its worst caller.

#### Two rows were passing for the wrong reason, named

**No row has negative headroom in #666's first sense.** Every string these
eleven cases assert was inside its window on `3a122903`, which is why all
eleven were green. Recording that is the point — a zero that nobody measured
and a zero that somebody measured are the same number and opposite facts.

**Two rows have negative CONSTRUCT coverage, and those are the ones that
were never reading what their names claim:**

- **Row 2, `test/agent-timings.test.ts:344`, short by 482.**
  `collectAgentWork`'s body is 6,482 characters and the window read 6,000.
  The case is named *"AC-1: no agent invocation in ship.js escapes the
  timing bracket"* and it had never read the last 482 characters of one of
  the two functions it is about. Measured: those 482 characters contain
  **0** occurrences of `agent(` today, so the case was green for a true
  reason — and an untimed `await agent(` moved into the tail of that
  function would have been invisible to the guard whose entire subject is
  finding one.

- **Row 8, `test/ac-coverage.test.ts:485`, short by 1,305.** The `acs`
  schema object is 1,905 characters and the window read 600. The case is
  named *"Discovery is REQUIRED to produce the attribution, not merely
  asked"*, and the string it demands sits at +363 — inside. Of the object's
  **4** occurrences of `required`, **3** are in the 1,305 characters the
  window never reached, as are **2** of its **3** `coversCriteria`
  mentions. A `required` list later in that object omitting the field is
  exactly the regression this case exists to catch, and the case could not
  have seen it.

The nearest rows to the first kind of failure are 10 (101 of 200 spent), 8
(237), 9 (263) and 1 (548). Row 1 is the one #664 was filed over: a
2,119-character prompt insertion for an unrelated issue, two functions away,
spent all 548 and 1,469 more.

#### The whole-document mutation, predicted and measured

#664 AC-6: a mutation in which the shared helper returns the whole document
instead of the cut must turn every converted case red, which is only
possible if each converted case asserts the BOUNDEDNESS of its cut rather
than only a substring. `expect(cut).toContain(x)` is satisfied by the whole
file, so without that assertion the mutation is invisible.

Run over the ten converted files, on a copy of the post-conversion tree
under `/tmp` with `node_modules` symlinked. **The baseline row was read
before any mutation row**, because an instrument that has stopped reporting
takes the baseline down with it and nobody mutates anything to produce that
row.

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 290 pass, 0 fail | **290 pass, 0 fail** |
| `structuralCut` and `structuralCutAround` both short-circuited to `return doc` | 11 | **11** |

**Before believing the row, the input on which mutant and original differ,
named and run rather than assumed:** `structuralCut(shipSource, "const REPO
=", { balanced: "{" })` returns **347** characters on the real helper and
**409528** — the whole of `ship.js` — on the mutant. Printed and compared
before the row was counted.

**Read the composition, not just the number.** The measured 11 equals the
eleven converted sites, and it is NOT eleven named case failures:

| File | Under the mutation |
|---|---|
| test/ac-coverage.test.ts | 2 fail |
| test/decomposition-waves.test.ts | 2 fail |
| test/agent-timings.test.ts | 1 fail |
| test/recorder-command-executed.test.ts | 1 fail |
| test/slug-derivation.test.ts | 1 fail |
| test/issue-close-guard-target.test.ts | 1 fail |
| test/ship-and-heal.test.ts | 1 fail |
| test/agent-timings-queued.test.ts | 1 fail |
| test/suite-measurement-parity.test.ts | module-scope cut refuses — the whole `describe` dies |
| test/worktree-repo.test.ts | module-scope `new Function` over the whole file: `SyntaxError: Unexpected keyword 'export'` — 0 of its cases run |

So of the 290 baseline cases only **190** ran under the mutation: two files
abort at load, and the 179 that passed are 179 cases that never saw the
mutant. A reader who takes "179 pass" as reassurance is reading a file that
never opened. Both aborts are loud and neither is silent, which is the
behaviour a mutant builder is supposed to have — but they are the reason
this table exists instead of a single number.

#### The cheapest wrong fix, applied and measured

#664 AC-7 names it: **widen the 6000 to 9000 in `test/worktree-repo.test.ts`
and leave the other ten alone.** It is the 5pm repair — the symptom is one
case going red, and one digit makes it stop.

Applied, on a copy of the PRE-conversion tree at `3a122903` with
`test/no-fixed-window-slices.test.ts` added and nothing else changed. The
symptom has to exist before a repair can be measured against it, so the
decay was reproduced first: **3068** characters of unrelated comment text
inserted into `ship.js` immediately after the anchor line, inside the old
window, mimicking the 2,119-character prompt insertion that reddened SC-1446
on `cd27a54f`.

| Row | Measured |
|---|---|
| SC-1446, insertion present, window still 6000 | **0 pass, 1 fail** |
| SC-1446, insertion present, window widened to 9000 | **1 pass, 0 fail** |
| the zero-fixed-windows scan on that same tree | **3 pass, 1 fail** |
| windows the scan still reports there | **14** over **384** files |
| the same scan on the converted tree | **4 pass, 0 fail** — **0** windows over **385** files |

The wrong fix works, and it is wrong: SC-1446 goes green, the ten other
windows are untouched, and the sweep is still red. The 14 is itself worth
the row — it is three MORE than the eleven #664 found by hand
(`sc-claim-forms.test.ts:178`, `collect-claim-enforcement.test.ts:810`,
`strip-js-comments.test.ts:211`), which is the argument for a sweep over a
list of ten edits.

### When the second decider is a COMMENT, and it agrees with itself (#689)

#621 above is N documents naming one string with nothing comparing them. This
is the same family with the second decider in the cheapest possible position:
**a trailing comment**, which has no behaviour, is never executed, and is the
only thing a reader checks.

Two workflows pinned `anthropics/claude-code-action` to two different commits
and annotated both `# v1`:

| File | Pin | Comment | What it actually was |
|---|---|---|---|
| `.github/workflows/ai-review.yml` (#631, unmerged) | `5eb090f3` | `# v1` | v1 |
| `.github/workflows/claude-review.yml` | `f27be6b6` | `# v1` | v1 as of two releases earlier |

The comments agreed. The pins did not. Nothing compared either pair, and the
agreement a reader perceived was between two copies of the same assertion.

**The issue's own resolution step is worth a sentence, because it is a second
instance of this file's subject inside the report of the first.** #689 ran
`gh api repos/anthropics/claude-code-action/git/ref/tags/v1 --jq .object.sha`,
got `310805dc…`, and concluded that NEITHER pinned SHA was v1. `v1` is an
ANNOTATED tag: `refs/tags/v1` points at a tag OBJECT, and the commit is one
dereference further down — `git/tags/310805dc…` → `5eb090f3…`, which
`commits/v1` confirms. `310805dc` is not a commit and cannot be a `uses:` pin
at all. The measurement was taken with an instrument that answers a nearby
question, and it answered confidently. One of the two pins WAS v1.

The fix is `lib/claude-code-action.ts` — one declaration of the SHA and the
version — and `action-pin-parity` in `scripts/contract-parity.ts`, which
compares every `.github/workflows/*.yml` `uses:` line and every literal under
`lib/` and `scripts/` to it. The comment is compared too, so it is derived
from the same declaration as the pin rather than asserted beside it.

**The cheapest wrong fix, named: edit the two SHAs so they match, and move
on.** One character, the symptom goes away, and nothing compares them
tomorrow. The cases survive it NON-vacuously, and the reason is a design
choice rather than a happy accident: they never compare the workflows to EACH
OTHER. Every position is compared to the declaration, so the tree that repair
produces — two workflows agreeing perfectly, nothing saying what they should
agree with — reports UNMEASURED. `AC-4` plants exactly that tree.

What was broken to prove it, run and counted rather than asserted, over
`test/action-pin-parity.test.ts` (12 tests). Every count was predicted before
the battery ran, and **the baseline row was read before any mutation row.**

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 12 pass, 0 fail | **12 pass, 0 fail** | — |
| `actionPinViolations` short-circuited to `return []` | 5 | **5 of 12** | a tree declaring `5eb090f3` whose two workflows pin `5eb090f3` and `f27be6b6`: the original returns FAIL and one violation naming `claude-review.yml:4` and both SHAs, the mutant returns PASS and none |
| the `pins.length === 0` refusal removed from `actionPinParity` | 1 | **1 of 12** | a tree declaring the pin whose only workflow is a `ci.yml` naming the action nowhere: the original is UNMEASURED (`unresolved-source`), the mutant is **PASS** — zero pins read as perfect agreement |
| the `NoActionPinError` throw removed from `actionPinAgreement` | 1 | **1 of 12** | the same tree: the original throws, the mutant returns `{pins: 0, violations: []}` |
| **the cheapest wrong fix as a CHECK**: the declaration dropped, the pins compared to each other | 5 | **8 of 12** | a tree with no declaration whose two workflows both pin `5eb090f3`: the original is UNMEASURED (`absent-file`), the mutant is PASS |
| the genuinely pre-#689 `claude-review.yml` — `f27be6b6` restored | 3 | **3 of 12** | the live tree: the original reads `5eb090f3` off `claude-review.yml:122`, the pre-fix source reads `f27be6b6` and the category is FAIL |

**The 8 row came back HIGH, and the three extra reds are the real kind.** The
prediction covered the five cases that reason about the declaration directly.
The extra three are:

- `AC-1`'s live-tree case, which asserts `coverage.examined > 1`. With no
  declaration site pushed, the live tree examines one position instead of two
  — the coverage control doing exactly its job.
- both `AC-3` cases, which assert the violation text names
  `claude-review.yml` and `lib/scaffold/ai-review-step.ts`. A self-comparison
  can report THAT the pins disagree and cannot say WHERE, so its message
  carries SHAs and no positions.

All three are squarely about the mutated behaviour and the mutant is not
broken — four cases still pass and the file parses and runs. Per the
arithmetic above that is "the prediction was wrong and the check is better
than you thought", and the fact it records is that **naming the position in a
violation is load-bearing, not decoration**: three cases depend on it, and a
check that only reports a count would have satisfied the author's model of
itself.

**What this does NOT do, said here rather than left as an omission.** Nothing
fails when the pin goes stale. `v1` is a moving tag upstream, so
`CLAUDE_CODE_ACTION_RESOLVED_ON` dates the reading rather than certifying it;
a freshness check needs the network, and whether one belongs in the suite is
the decision #377 is open for. The guarantee here is narrower and exact: every
position in the tree follows one declaration, and a tree that follows nothing
says so.

None of the five mutations is left in the tree; all were run and reverted, and
`scripts/contract-parity.ts`, `.github/workflows/claude-review.yml`,
`lib/claude-code-action.ts` and `test/action-pin-parity.test.ts` were confirmed
byte-identical to the measured source afterwards by checksum.

---

The three sections below were moved out of the rule by #1069, for the same
reason #1009 moved everything above them and with the same promise: the words
are unchanged, only the address is. The rule keeps the recipe and names the
worked example; the evidence that the recipe was ever run is here.

### Why — five of eight issues in one day (2026-10-06)

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

### For a script whose job is to exit non-zero — the worked example (#129)

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

### For a gate check, where the guard is itself a test — the worked example (#224)

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

### On the sixth shape: green on the exit code, witnessing the wrong mechanism (#1236, #1259)

The generated `ai-review-rounds` step counts prior review rounds from a GitHub
Actions API response and refuses when it cannot read one. The refusal is an
`::error title=AI review rounds UNMEASURED::` annotation and a non-zero exit —
deliberately not a silent `round=1`, which is the *Silent Default
Substitution* anti-pattern in `.claude/rules/config-access.md`.

The case planted an unparseable body and asserted the step exits non-zero. It
was green on the first run, before the refusal had been written.

What produced the exit was this, with no `|| total=` on the end:

```bash
total=$(printf '%s' "${body}" | grep -oE '"total_count"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$')
```

Actions runs `run:` blocks as `bash -e`, and an assignment whose only word is a
failing `$(...)` aborts the shell at that line. On an unparseable body the
second `grep` matches nothing, exits 1, and the script dies **before** reaching
its own annotation.

| | status | stderr |
|---|---|---|
| intended refusal | 1 | the UNMEASURED annotation |
| what actually ran | 1 | empty |

Identical on the only channel the case observed. The exit code is produced by
`bash -e` and by the refusal alike, so no amount of re-reading the test finds
this: the test is correct about what it asserts, and what it asserts cannot
distinguish the two.

**How it was found:** by predicting the stderr before reading it. The step was
expected to name the three credentials in its annotation; the run showed
nothing at all. A prediction about a *second* channel is what separated them —
the same discipline the fourth shape needs, applied to output rather than to
counts.

**The fix, and the generalisation.** `|| total=` makes the empty reading
reachable, and the case now asserts the annotation text as well as the status.
That is the rule the shape reduces to: **assert something only the intended
mechanism can produce.** A status code is almost never that, and neither is
"threw" or "returned null" — each is reachable from a dozen places upstream.

Two more instances of the same shape were live in the same file and fixed in
the same change, both from `bash -e`: a `$(...)` in a conditional's subject,
and a comment whose text contained the literal the one-constant assertion
counted, which took the count from two to three and aborted the file for a
reason unrelated to any refusal.

#### The remedy, measured (#1259)

Two more AC-S3 cases in `test/ai-review-rounds-step.test.ts` asserted the
status and not the annotation. Both were reaching the real refusal — no hidden
defect — so this measures the *instrument*, not a bug: how much the two
assertions can tell apart.

The mutant removes every `echo "::error title=…"` from the generated script
and leaves the exits alone, which is precisely what a `bash -e` abort looks
like from outside. Run over both cases:

| case | real | mutant |
|---|---|---|
| `total_count` of 0 | status 1, annotation present | status 1, annotation **absent** |
| blank branch | status 1, annotation present | status 1, annotation **absent** |

The status column is identical on both sides. **The old assertion is green in
every cell of this table**; the stderr assertion is red in exactly the two
cells where the mechanism did not run. That is the whole shape in one
measurement, and it is why the remedy is not "assert more" but "assert on a
channel the wrong mechanism cannot write".

The mutation was run from a scratch file and deleted; nothing in the tree
carries it.

**Not the seventh shape, though they arrive together.** *The same blindness
with the axes swapped* is a battery whose rows never vary the **input**, so
it cannot be wrong about a population. This is a single case whose **signal**
two mechanisms can both produce, so it cannot be wrong about a mechanism. The
remedies are different and neither substitutes: assert on a channel only the
intended mechanism can write, versus vary the input in at least one row.

### Before you report one: a duration is not a mechanism (#1268)

Moved out of `.claude/rules/checks-must-be-able-to-fail.md` by #1346, for the
reason #1009 and #544 moved everything else here and with the same promise:
the words are unchanged, only the address is. The rule keeps the operational
half — read the `kind`, and do not re-file #1268 — and this is the evidence
behind it.

This file teaches you to hunt for checks that cannot fail, and **the hunt
needs evidence too**. On 2026-10-22 a case running 26,925ms against a 5,000ms
default was reported as a budget that *could not fire*, the mechanism given
as "a blocking `execFileSync` does not yield to bun's timer". Both halves
were false. It reached the tracker as #1268 because one agent inferred a
mechanism from a duration and the next relayed it without re-deriving it.

A case running far over a default has at least three explanations, and
telling them apart costs one command:

| explanation | the reading that shows it |
|---|---|
| no budget governs it | `perTestTimeoutDeclarations(src)` names it in no entry |
| a generous budget was declared on purpose | it returns `kind: "per-test"` for it |
| the budget fires but cannot interrupt | the run reports the case red anyway |

**Read the `kind`.** `perTestTimeoutDeclarations` reports `"per-test"`
separately from `"file-default"`, so a filter on `"file-default"` answering
"declares nothing" does **not** mean "no budget governs this case". The case
above closes its own body with `}, 240_000);` — a deliberate 240s budget, on
the line a reader looking for one would have landed on.

Measured while falsifying it, so nobody re-files it: bun 1.3.14 **does** kill
a blocking `execFileSync` at the budget — 506ms under `--timeout 500`, with
`stdio`, `encoding`, a child `timeout:` and `cwd` varied one at a time and
all six killed. The one thing not *interrupted* is a CPU-bound spin with no
syscall, and it is **still reported red** (`[3000.17ms]`, `this test timed
out after 500ms`). The budget fires; it cannot stop the work. That is
wall-clock cost, not a hole in the gate.

### When the reason nobody checked is a comment saying it was checked (#1322, #675)

Every other instance in this file is a check that could not fail. This one is
a check that was never written, because **the tree contained a sentence
asserting it existed** — in the place a reader goes to find out, written by
someone who was right at the time.

`bin/rungate.ts` rewrote `process.argv` and then `await import(script)`.
`import.meta.main` is false for a dynamically imported module, so a command
script guarding its CLI body on it loaded, executed nothing, and the
dispatcher exited 0. Three of ten commands were silent that way, including
`audit-specs`, whose entire job is reporting spec status.

`lib/cli-commands.ts`'s docblock said this could not happen:

> None of them guards on `import.meta.main` … Adding a guard to any of them
> would silently turn its subcommand into a no-op, so
> `test/cli-contract.test.ts` runs every command for real.

Both clauses were false when the defect was found, and the sentence is the
reason that went unnoticed for as long as it did. It does not merely fail to
catch the defect — **it names the defect precisely, argues it is impossible,
and cites the test that would have caught it.** An agent who wonders whether
the dispatcher reaches command bodies finds an answer, in the right file,
phrased as settled. Nobody runs the test, because the comment already
reported its result.

Three properties made it rot without anyone touching it:

| clause | true when written | what falsified it | who could have noticed |
|---|---|---|---|
| "none of them guards on `import.meta.main`" | yes | three scripts later acquired a guard | each author, who had no reason to read a docblock in a different file |
| "runs every command for real" | plausible | the test ran **one** — `create-sc --list` | nobody; the test was green |

Neither change was careless. Adding `import.meta.main` to a script is the
normal thing to do, and the test's own comment is *correct*: "a dispatcher
that imported the module and never reached its top-level code would also exit
0, and this is what tells the two apart." It is exactly right, about one
member of a population of ten. The battery varied the dispatcher and held the
**command** fixed while the defect sat on the command axis — the seventh
shape, with the comment supplying the false assurance that the held axis did
not matter.

**The second half is sharper than the first, and it is about where a fix gets
recorded.** #675 hit this mechanism, understood it, and wrote it down — in
`scripts/ai-review-findings.ts`'s docblock — then worked around it with an
unguarded wrapper for that one script. A correct local fix. It left the
dispatcher as it was, and it is why `ai-review-findings` is the one row that
still worked:

| command | via dispatcher | run directly | |
|---|---|---|---|
| `audit-specs` | 0B | 2092B | silent |
| `sync-spec-tests` | 0B | 1254B | silent |
| `extract-constraints` | 0B | 57B | silent |
| `ai-review-findings` | 270B | 270B | reached — #675's workaround |

That row is the damage. A population with one healthy member and a docblock
explaining why reads as a population with one *exception*. The knowledge was
in the tree, in a true comment, at the wrong scope — attached to the instance
rather than to the binding — and the shape it left behind actively argued
against generalising it.

**The fix is the generalisation: one binding, not three more wrappers.**
`runCommandScript` spawns the script with `process.execPath`, which makes it
the entry module. A guard becomes the normal thing for a script to have
rather than a trap, and **there is no per-command axis left to enumerate** —
once the dispatcher runs scripts as entry modules, every command is reached
by construction. That is why the new cases deliberately do *not* loop over
the ten commands: enumerating is what failed, two of the ten write when run
bare, and an enumeration would either dirty the tree or carry exclusions —
an excluded row being an unmeasured one.

What was broken to prove the cases fail, predicted before each run:

| mutation | predicted | measured |
|---|---|---|
| dispatcher back to `await import(script)` | 2 red | **2, exact set** |
| `r.status ?? 0` instead of `?? 1` | 1 red | **0 — a real defect in the test** |
| both, **plus** deleting the guard from `audit-specs.ts` | 1 red | **1, exact set** |

The `?? 0` row came back **lower** than predicted, which is the signature
worth recognising. "A script that cannot run is a failure" passed under the
mutation because a missing script makes *bun* exit non-zero — a real status
the `??` never sees — and a separate `if (r.signal)` branch made `?? 1`
unreachable by any input at all. An assertion holding for a reason that is
not the one claimed: the third shape, found only because a number came back
smaller than a prediction made in advance.

The third row is the one that justifies the design. Under the per-script
workaround — #675's approach, applied three more times — the end-to-end case
goes green and only the source-binding assertion stays red. **Fixing this
per-script would have looked correct**, which is precisely what happened the
first time.

One self-inflicted catch belongs here too, because it is this section's own
subject turned on itself: the source-binding assertion first went red against
**the comment I had just written quoting the old `await import(script)`
line**. It now reads through `stripJsComments`. A guard that cannot tell code
from a comment about code is reading authored text, not the program — and
authored text is the thing this entire section is a warning about.

**The rule this reduces to.** A comment asserting that a property is tested
is not evidence the property is tested; it is evidence that somebody once
believed it, and it suppresses the check by answering the question that would
have prompted one. Two things follow:

- **When you rely on a property, bind it, do not describe it.** If the
  sentence is worth writing, the assertion is worth writing, and then the
  sentence can cite the assertion instead of standing in for it.
- **Record a fix at the scope of the mechanism, not the instance.** #675's
  comment was true, useful, and in the wrong file. A workaround that leaves
  the shared binding broken converts a uniform defect into a defect with one
  documented exception, and the exception is what stops the next reader
  looking.
