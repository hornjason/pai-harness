---
description: Worked instances behind `.claude/rules/self-referential-tests.md` — the three checks this very file tripped while being written, moved out of the always-loaded surface (#1009)
doc-type: reference
status: active
owner: jason
updated: 2026-10-22
---

# Self-referential tests — the worked instances

The rule is in `.claude/rules/self-referential-tests.md` and loads on every
turn. This write-up is the evidence behind it, kept verbatim and read when
somebody wants the demonstration rather than the list. It moved here because
the always-loaded surface was 36 bytes under its budget and the rule needed a
new row (#1001).

## Adding an import, not a file — what cost PR #1024 three CI shards (#1024)

Moved out of the rule by #1346, same promise as #1009 and #544: the words are
unchanged, only the address is. The Tier 1 row already states the remedy —
teach the copier to carry the dependency, or keep the file import-free.

The last row cost PR #1024 three CI shards and is worse than it looks. Those
batteries build a mutant by writing **one file** into a scratch directory, so a
relative specifier added to the original resolves to nothing there and the
mutant **fails to load**. Every case comparing real against mutant goes red —
and the reds read as behavioural differences. Turn one around and it is the
UNMEASURED shape: had a comparison been written so that a non-loading mutant
resembled a *refusing* one, the whole battery would have gone **green while
witnessing nothing**. This table previously warned about adding a *file*;
nobody was warned about adding an *import*.

## The selector, and the two routers that are complements (#1004)

Moved out of the rule by #1346. The operational half stays there: the selector
runs only inside a ship run, so the census table is still what you run by hand.

**A ship run no longer depends on you reading this** (#1004).
`scripts/select-affected-tests.ts` selects by import graph, and a census test
imports none of the things that move it — measured with
`specs/HARNESS-STANDARD.md` as the only changed file, that selector reached
`ticked-sc-cover` as a sweep and missed the other two outright, while
reporting MEASURED, so nothing fell back. It now unions `censusTestsFor` into
its SELECTED result, and its artefact records `graphTests` and `censusTests`
separately so the two halves stay tellable apart. The routers are still
complements — one routes by what the diff DID, the other by what it IMPORTS —
and this table is still what you run by hand, because the selector runs only
inside a ship run.

## This file tripped one of its own checks on the first run

Worth leaving in, because it is the cheapest possible demonstration that the
list above is not theoretical.

The draft closed by citing a rules file named for exemption-list
self-reference. No such file exists — the idea does, in `harness-managed.md`
and in the no-exemption-list rows above, but not under that name.
`test/rule-provenance.test.ts` caught it immediately: *"every
`.claude/rules/*.md` the repo routes to exists"*. One file added, zero code
touched, and a test in a file nobody had opened went red.

**Then the obvious repair failed too, for a reason worth knowing.** Rewriting
the paragraph to explain that the path does not exist left the path *in the
prose*, and the scanner counted it again — a checker that greps for a filename
cannot tell a citation from a sentence about a citation. Same shape as
`claiming-sc-coverage.md`'s central problem, met from the other side. The only
fix is not to write the literal path at all, which is why the name is spelled
out in words above.

The check is good: it names the citing file and the missing path, which is
more than most of Tier 1 does.

**Then CI caught a third one, and this is the one that matters.** The draft
cited ten `file.ts:NNN` line positions, so `#541`'s citation ratchet refused
it — *"`.claude/rules/self-referential-tests.md` is not in
`.claude/line-citation-ratchet.json` and carries 10 line citations. A document
absent from the ratchet is allowed none."*

Two things to take from it. First, **I did not run the test this very file
tells you to run**: "added or edited a doc → `test/line-citation-ratchet.test.ts`"
is a row above, written before the push, and the local run skipped it. Writing
the rule is not the same as following it, which is the argument for the census
block in the swarm brief rather than a document.

Second, **the right fix was not to bank an entry in the ratchet.** The ratchet
exists because line numbers rot, and a rule file is read months after it is
written. Every citation here now names a stable symbol — `SCANNED_FILES` in
`test/consumer-no-rebuild-delegation.test.ts` — instead of a line that will be
wrong by the time someone needs it. The cheap fix was one JSON entry; the
correct one made the document better and the ratchet entry unnecessary.

And the failure message is genuinely good — it names the file, the count, the
ratchet, and the policy. It belongs with `SC-1466` as a model, not with Tier 1.

## Moved out of the always-loaded rule by #1520

These blocks left `.claude/rules/self-referential-tests.md` verbatim when the
instruction surface reached 37 bytes of headroom. The rule routes to each of
them. Nothing was rewritten and nothing was deleted — same reasoning as #1009.

## Why a merged removal reddens a branch that is behind (DRIFT-3, moved by #1520)

One consequence worth knowing, and the direction is the opposite of the
obvious one: DRIFT-3 computes `allowlistAdditions(origin/main, yours)` and
refuses entries **yours has that main lacks**. So somebody else's merged
*addition* cannot redden a branch that is behind — your copy is the smaller
one — but somebody else's merged *removal* can, because an entry main has
dropped and your branch still carries reads as one you added. Rebase before
you debug.

## What the mutant-load row cost PR #1024 (moved by #1520)

The last row cost PR #1024 three CI shards, and turned around it is the
UNMEASURED shape rather than a noisy one: a battery whose mutant fails to
load can go **green while witnessing nothing**. Why, in full:
`reference/self-referential-tests-worked-instances.md`, *adding an import*.

## The #990 tick — why the router reads the diff and not the file list (moved by #1520)

It reads the diff, not the file list, and that is the whole of #990: **an edit
to a spec and a tick inside one are the same path and different events.** A
criterion went `- [ ]` to `- [x]`, every targeted suite was green locally, and
CI went red in a census file the change does not touch and the list here did
not name. A router that sees only `git diff --name-only` cannot tell those two
apart, so this one carries the added and removed lines.

## What the router does not do, and the selector that complements it (#1004, moved by #1520)

Bounded and cheap. The point is not to run everything; it is that the file you
changed is never the only file with an opinion about your change.

**What this does not do: enforce.** It prints a command, and an agent who
reads neither the rule nor the script is unaffected by both. The mechanical
version is a check that refuses a diff whose census tests were not in the same
run's measured set, and that needs a notion of "what this session ran" which
does not exist here.

**A ship run no longer depends on you reading this** (#1004):
`scripts/select-affected-tests.ts` unions `censusTestsFor` into its SELECTED
result. It runs only inside a ship run, so this table is still what you run
by hand. What it missed before, and why the two routers are complements:
`reference/self-referential-tests-worked-instances.md`, *the selector*.

## Why `remedyMessage` has no default fix and a derived pointer (#813, moved by #1520)

Two things about it are deliberate. The `fix` has no default, because a
default would let a check look as though it had a remedy when it had none.
And the pointer to this file is DERIVED — emitted only when this file exists
under the project root — because `lib/conformity.ts` is published and this
document has no template copy, so a hardcoded path would send every consumer
to something they do not have.

Every Tier 1 check above now carries one, and `test/check-remedy.test.ts`
holds the population: delete a remedy and that test goes red naming the check
that lost it. Adding a Tier 1 check means adding its row there too.

Before #813 none of them did, and the number is worth keeping: two references
to this file from the whole executable tree, both prose inside a docblock,
against 321 for `checks-must-be-able-to-fail`. A document the stuck agent
cannot reach from the thing that stopped them is not reaching anyone.

## This file tripped three of its own checks while it was being written (moved by #1520)

The demonstration is kept verbatim in
`reference/self-referential-tests-worked-instances.md`: a routed-to rules file
that did not exist, the repair that left the path in the prose and was counted
again, and ten `file.ts:NNN` citations that the ratchet refused. The third is
the one that matters, and the short version is the row in Tier 2 above:
**cite a stable symbol, never a line number** — the cheap fix was one JSON
entry, the correct one made the ratchet entry unnecessary.

## The 2026-10-19 swarm measurement, as the rule stated it (moved by #1520)

Measured 2026-10-19: three of eight PRs from one swarm were red, all three like
this, none a flake. Every fixer ran its targeted suite, saw green, and pushed.

## Is the router's list complete? The question neither decider was asked (#1547)

Three agents in one day ran exactly what `bun scripts/census-routing.ts`
printed and still shipped red. The router's own test compares `CENSUS_TRIGGERS`
to the rendered table in `.claude/rules/self-referential-tests.md` in both
directions — and **both directions are about agreement between two
documents**. A census suite absent from both leaves them in perfect agreement.
Two deciders answering the same question, which is
`.claude/rules/checks-must-be-able-to-fail.md`'s fourth shape.

The two reported instances arrive from opposite sides:

- **A census test nobody routes *to*.** `test/scratch-cleanup.test.ts` is a
  census over the test population. On #1286 (PR #1537) an added test file
  reddened it on `test-shard (3)` after a clean targeted run.
- **A path class nobody routes *from*.** On #1540 (PR #1546) the string
  `config/` appeared zero times in the router. A new `config/` file picked up
  `scaffold-conformity` and `package-closure` incidentally through `new-file`;
  an **edit** to an existing one fired nothing at all.

### How a census-style suite is identified

`censusDirsRead` in `scripts/census-routing.ts` is the one binding. A suite is
a census when it **enumerates a directory resolved from its own repo-root
binding** — `readdirSync(join(REPO, "test"))`. A set of files is the input no
import edge expresses and no diff contains, which is precisely why
`scripts/select-affected-tests.ts` cannot reach these suites and why this
router exists. Reading a single *named* file from the root is deliberately not
enough: most of `test/` does that, and the population would be the directory.

Two readings cost a measurement each and are worth stating, because both make
the instrument go **quiet** rather than loud:

- A `[^,)]+` capture of the enumeration's argument truncates
  `readdirSync(join(REPO, "test"))` to `join(REPO`, which resolves to nothing.
  It drops every suite that does not spell its directory inline — including
  `test/sc-id-namespace.test.ts`, which is already routed, so the completeness
  case stays green having witnessed nothing. The argument is read by balancing
  brackets instead.
- Source quoted *inside a string literal* is text, not code. This file's own
  test carries the detector's fixtures as single-quoted strings, and without a
  string mask the detector put `test/census-routing.test.ts` into the
  population it derives. That is the self-reference trap in its first
  string-shaped spelling here; every prior instance arrived through a comment.
  The mask also skips regex literals, because `/["']/` in
  `test/scaffold-generators.test.ts` otherwise opens a string that never
  closes and silently hides every enumeration below it.

### The sweep, and why the second direction is routed rather than derived

Over the 610 suites under `test/`, `censusDirsRead` yields **43 (suite,
directory) pairs across 14 directories**. Requiring that a change in `D` route
every suite enumerating `D` leaves **42 of the 43 unrouted**, and satisfying it
means firing census suites on substantially every diff to `lib/`, `scripts/`,
`test/` and `workflows/` — the "router that names more than it has to" that the
`new-spec` and `spec-own-test` rows are each explicitly scoped to avoid. The
crude form fails the same way: of those 14 directories, an ordinary edit fires
any row in only **4**.

**Both figures replace a first reading that was wrong, and the way it was
wrong is the point.** It reported *"37 of 44 unrouted"* for this property,
having actually counted suites absent from `allCensusTests()` — membership in
ANY row, not "a change in `D` routes `S`". Two different questions, one
number, and the prose asserted the stricter one. The same scan was top-level
only, so it never saw `test/`'s subdirectories. A figure carried between two
properties looks exactly like a figure that was measured for the one it is
quoted against.

So the check is scoped to the population held against a row that **names an
event** — `new-test-file`, for adding a file to `test/` — and the second
direction is routed explicitly as the `config-registry` row. Saying which is
the point: *"we routed the one path we noticed"* is how the first omission
happened.

### What the sweep found, suite by suite

**Eight** suites census the `test/` population at the top level and **one**
more sits below it. A **trivial** probe file reddens none of them, which is
why the measurement needs a realistic member; each top-level row below was run
against a 0-fail baseline of all eight (173 pass, 0 fail), and the ninth
against its own (15 pass, 0 fail).

| Suite | Probe that reddens it | Verdict |
|---|---|---|
| `scratch-cleanup` | a file binding an inline-rooted `mkdtempSync` | **routed** — #1286's own event |
| `consumer-no-rebuild-delegation` | a file named `test/consumer-*.test.ts` | **routed** — found by this sweep |
| `ai-review-runner-shell-parity` | `test/ai-review-*.test.ts` handing a script to bash | **routed** — found by this sweep |
| `unit/ambiguous-anchor` | a file passing a COMPUTED anchor to `structuralCut` over a doc bound to `workflows/ship.js` | **routed** — found by the AI review on PR #1556 |
| `sc-id-namespace` | — | already routed |
| `scratch-paths-unique` | — | already routed |
| `ai-review-surface-census` | none | monotone: refuses a title that went MISSING, and a lower bound on surface size |
| `sc-coverage-claims` | none | monotone: its tree scan is the vacuity guard `total > 150` |
| `scaffold-generators` | none | monotone: its tree scan asserts `at least 3 test files reference ProjectScan` |

The three exclusions share one structural reason rather than three opinions:
their assertion over the population is a **lower bound**, so an addition moves
it the safe way and only a deletion can refuse. That is a property of the
assertion, readable in the source, not a measurement that ages — and
`MONOTONE_OVER_TEST_POPULATION` reports an entry whose suite has left the
population rather than leaving it exempt.

Two omissions were reported; the sweep found **two more**, and the AI review
on PR #1556 found a **fourth** — so four in total, plus the `config/` row as a
fifth hole closed from the other direction.

### The walk's depth — the defect's own shape, turned on the check (#1556)

The first cut of `testPopulationCensusSuites` read only the top level of
`test/` with a non-recursive `readdirSync`. `test/` has subdirectories —
`fixtures`, `helpers`, `types`, `unit` — holding **70 of the 610** `.test.ts`
files, and every one of them was invisible to the population. The
completeness case went **green having witnessed nothing** for all of them,
which is the same failure mode as the `[^,)]+` truncation above arriving
through depth rather than parsing.

The prediction before measuring was that **zero** subdirectory suites would
satisfy the predicate. That was **wrong**: `test/unit/ambiguous-anchor.test.ts`
scans `test/` recursively for `structuralCut` call sites, and the Tier 2 row
*"a computed (non-literal) anchor cutting `ship.js` — no exemption list by
design"* is that suite. A gap with a live member is a different finding from
a gap with none, and this one had a member.

The routing side was never blind: `new-test-file`'s `fires` is
`/^test\/.*\.test\.tsx?$/` and `.*` crosses a slash, so the router would have
run such a suite all along. Only the derivation could not see it — which is
precisely why nothing reported the gap, and why **the pair of mutations is the
evidence and a single red row is not**: with the recursive walk, a census
suite planted at `test/unit/zz-planted-census.test.ts` makes the completeness
case red and names it; with the walk reverted to a flat `readdirSync`, the
case is green and the planted file's name appears nowhere in the run.

One more flat-`test/` assumption fell out of it. The rule file's section
comparison matched routed paths with `/test\/[\w.-]+\.test\.tsx?/`, which
cannot match `test/unit/ambiguous-anchor.test.ts` at all — so routing a suite
from a subdirectory made that case red for a correct change. The class now
admits `/` and lives in one binding, `ROUTED_TEST_PATH`, read by both the
section comparison and the derived-row cell check.

### Two deciders, in the check written to explain two deciders (#1556)

The first cut masked string literals with a hand-rolled scanner, because the
fixtures in the test file are quoted source and reading them as code puts the
file into its own population. That mask was wrong twice, and **both times in
the direction that makes the instrument go quiet**:

1. It read `/["']/` as a string opener, so the `"` inside the PATTERN opened a
   string that never closed and swallowed every enumeration below it. It
   dropped `scaffold-generators` and `ai-review-surface-census`; the
   stale-exclusion guard reported it.
2. Repaired with a single-previous-**character** regex heuristic, it then read
   `return /["']/` as division — the previous character is `n` — and
   reintroduced the same swallow behind a keyword. The AI review on PR #1556
   found this one.

The docblock defending that heuristic argued the error was safe: *"treating a
regex as division leaves its quotes live and can only ADD files to the
population"*. **That is false, and the falseness is the lesson.** It holds
only for a pattern whose quotes are balanced. `["']` carries one of each, so
the miscount opens a string and REMOVES files. A safety argument that is true
of the example in front of you and false in general is worse than no argument,
because it stops the next reader checking.

The fix was not a wider local heuristic. `lib/strip-js-comments.ts` already
decides regex-versus-division keyword-aware, with `REGEX_ALLOWED_AFTER_WORD`
put there by #905 for this exact defect, and `censusDirsRead` was **already
importing that module** — just calling it without `blankLiterals`. So the
repair deletes the local mask entirely and takes two views of the same
offsets from the one binding: literals blanked for deciding where code IS,
literals intact for reading what a `join(…)` NAMES. A second heuristic that
agrees with the first today is the fourth shape in
`.claude/rules/checks-must-be-able-to-fail.md`, and this one had been written
into the block arguing against it.

Applying *"check whether the same blindness is anywhere else"* to the fix
rather than to the original code found a second site immediately:
`repoRootIdents` was still reading the literal-bearing view, and
`import.meta.dir` is a code token that survives inside a quoted fixture — so
a string could manufacture a repo root. Measured at `[""]` before the change,
from a file that enumerates nothing but a string.

**Both defects were latent on this tree.** The population is 9 suites before
and after, with the same members, and no suite in `test/` carries a regex
literal after a keyword ahead of its census read. Unlike the recursion defect
this is a gap with **no** current member, and the two are worth different
words.

The battery's own row is the part worth keeping. Round 3 predicted 4 failures
for dropping `blankLiterals` and measured 3: the structural case asserted
`src.includes("blankLiterals")` over the **raw** file, and the docblock above
the call contains that word, so deleting the call left the check green. A
structural assertion satisfied by a comment saying the thing was done is
#1322's shape — found here only because a prediction was written down and
came back wrong.

### Three rounds, three sites, one rule (#1556)

The review found the same defect three times in three places: a site
**scanning** the literal-bearing view when it wanted the masked one.
`stringMask` first, then `repoRootIdents`, then `firstArgument` — which
counted brackets over the view with literals intact, so a bracket inside a
string counted as structure, the depth never returned to zero at the
statement's end, and the slice became garbage. Measured:
`join(REPO, "weird(dir")` resolved to nothing, while `"weird)dir"` happened
to resolve correctly. That asymmetry is the tell — the count was unreliable
rather than strict.

Fixing each site as it was reported leaves the next one for the next review.
So the property is asserted instead:

> inside `censusDirsRead`, `src` is READ FROM and never SCANNED.

Every match, count and traversal goes over the blanked view; `src` appears
only in its declaration and in `.slice(…)`, the one operation that needs the
literals intact.

**The battery row that proves why a behavioural suite could not have done
this** is the one whose prediction was wrong. Making the enumeration loop
scan `src` was predicted to redden three cases and reddened **one** — the
structural assertion, alone. The other two sites were still masked, so no
quoted fixture could bind a root and no fixture's brackets could balance;
two correct sites covered behaviourally for a third that had regressed.
That is the two-deciders shape read from the other end, and it is the whole
argument for a structural rule over three remembered ones.

### The config row's membership, measured

Against a 0-fail baseline of the eleven suites naming `config/` (276 pass):

- `config/check-registry.json` with one check entry removed → `test/check-registry.test.ts`,
  3 cases of *"#339: every named check resolves, in both directions"*.
- `config/matcher-registry.json` with its last element spliced off →
  `test/matcher-registry-parity.test.ts`, 1 case, and nothing else.

`test/matcher-registry.test.ts` is green on that edit and is **not** in the
row. An earlier mutation that `delete`d an array index reported four files and
was discarded: it leaves a `null` hole, so it measured a corrupt registry
rather than a moved agreement. `config/prove-evidence.schema.json` — the file
that prompted the report — has **no live reader in the tree at all**, so an
edit to it reddens nothing today; the routing hole was real and that
particular agreement is still unguarded by any test.
