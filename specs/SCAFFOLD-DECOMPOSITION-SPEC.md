---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Scaffold decomposition — extracting scan, generation, and validation from the 1,844-line scaffold-project.ts into focused modules
testable: true
compliance: strict
---

# Scaffold Decomposition

## Problem Statement

`scripts/scaffold-project.ts` is 1,844 lines doing four distinct jobs: project scanning (reads package.json, specs, code structure), template filling (generates AGENTS.md, agent briefs, CODE-MAP.md), file writing (creates/updates output files), and validation (checks references, runs lint). When you need to change how scanning works, you're editing the same file as template logic. When a scan bug breaks generation, the blast radius is the entire scaffold.

The AGENT-BRIEF-TEMPLATE-SPEC (SC-348–SC-357) addresses one piece — extracting template strings into files. This spec covers the remaining decomposition: separating scan, generation, and validation into independent modules.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Extract project scanner into `lib/scanner.ts` | Scan logic (read package.json, find specs, detect tech stack) is reusable. Other tools need scan data without running the full scaffold |
| D-2 | Extract file generators into `lib/generators/` | Each output file (AGENTS.md, CODE-MAP.md, agent briefs) gets its own generator. Generators take scan data in, produce file content out |
| D-3 | Scaffold becomes orchestrator only | scaffold-project.ts calls scanner → generators → writers. Under 200 lines. Deep modules do the work |
| D-4 | Validation extracted into `lib/validators/` | Reference checking, lint integration, finding report — these are reusable outside scaffold |
| D-5 | Scan data passed as typed interface, not globals | Scanner returns a `ProjectScan` object. Generators consume it. No shared mutable state |

## Current State

```
scaffold-project.ts (1,844 lines)
├── Project scanning (~400 lines) — reads package.json, specs, code structure
├── AGENTS.md generation (~300 lines) — template filling, section assembly
├── Agent brief generation (~200 lines) — per-agent templates, prompt routing
├── CODE-MAP.md generation (~200 lines) — module scanning, health checks
├── File writing (~150 lines) — mkdir, writeFile, action tracking
├── Validation (~200 lines) — reference checking, lint integration
└── Misc helpers (~394 lines) — type definitions, utilities
```

## Target State

```
scripts/scaffold-project.ts (~150 lines) — orchestrator only
lib/scanner.ts (~300 lines) — project scanning, returns ProjectScan
lib/generators/
  agents-md.ts (~200 lines) — AGENTS.md generation
  agent-briefs.ts (~150 lines) — reads templates, fills variables
  code-map.ts (~200 lines) — CODE-MAP.md generation
lib/validators/
  reference-check.ts (~100 lines) — broken link detection
  lint-integration.ts (~100 lines) — agnix, RepoRails
```

## Success Criteria

- [x] SC-358: lib/scanner.ts exists
- [x] SC-359: Scanner detects tech stack, specs, consumers, source directories (behavioral)
- [x] SC-360: lib/generators/agents-md.ts exists
- [x] SC-361: lib/generators/agent-briefs.ts exists
- [x] SC-362: lib/generators/code-map.ts exists
- [x] SC-363: scripts/scaffold-project.ts is under [200] lines
- [x] SC-364: Re-scaffold produces identical output before and after decomposition (behavioral)
- [x] SC-365: Scanner is importable by other scripts without pulling in generation logic (behavioral)
- [x] SC-366: Each generator is independently testable with mock ProjectScan data (behavioral)
- [x] SC-387: config/universal-rules.yaml exists
- [ ] SC-388: .claude/rungate.json has field keyFiles
- [ ] SC-389: .claude/rungate.json has field agentConfig
- [ ] SC-390: Consumer can add project-specific rules via config (behavioral)

## Implementation

### Phase 1: Extract scanner
1. Define `ProjectScan` interface
2. Extract scan logic into `lib/scanner.ts`
3. Scaffold imports scanner, passes data to existing inline generators
4. Verify: identical output

### Phase 2: Extract generators
1. Extract AGENTS.md generation into `lib/generators/agents-md.ts`
2. Extract agent brief generation into `lib/generators/agent-briefs.ts` (connects to AGENT-BRIEF-TEMPLATE-SPEC)
3. Extract CODE-MAP.md into `lib/generators/code-map.ts`
4. Verify: identical output

### Phase 3: Extract validation
1. Extract reference checking into `lib/validators/`
2. Scaffold becomes orchestrator — under 200 lines
3. Verify: identical output, all tests green

## Cautions

- SC-364 is the critical gate: output must be IDENTICAL before and after. Diff the generated files
- Don't change behavior during decomposition — this is a pure refactor
- AGENT-BRIEF-TEMPLATE-SPEC (SC-348–SC-357) should land first — it externalizes templates, simplifying the agent-briefs generator extraction

---

### The scaffold wrote a dependency only one machine could resolve (#362)

`addPaiHarnessDevDep` ended with:

```ts
const harnessRelative = require("path").relative(root, dirname(dirname(__dirname)));
pkg.devDependencies["rungate"] = `file:${harnessRelative}`;
```

Every scaffolded project got a path to a sibling directory on whichever
machine ran the scaffold, and that path was then pinned into the consumer's
`bun.lock`. On CI, or on any second machine, it does not exist and
`bun install` exits 1. **A consumer cannot install its dependencies on a
clean clone** — a failure at step zero, before any gate or tier question can
be asked, and the cause of DailyBriefDashboard's CI failing on every run
from 2026-10-03.

`--no-optional` does not help, and that is worth recording because it was the
attempted fix (DDB `d009d9f1`): `--frozen-lockfile` resolves the `file:`
entries pinned in the lock whether or not they are optional.

**The floor is the harness's MINOR, not its exact patch**, and the
distinction is the whole design. A caret on the current version — `^0.2.2`
from a tree at 0.2.2 — cannot resolve until that version is published, and
this repo runs ahead of npm: 0.2.1 was the newest published version while
the tree said 0.2.2, and #364 is about there being no release workflow at
all. A consumer scaffolded in that window would get an unresolvable
dependency, which is the same defect wearing a semver range instead of a
path. `^0.2.0` is satisfied by every published 0.2.x, so it resolves to the
newest available today and picks up the next release with no re-scaffold.

- [x] SC-813: lib/scaffold/steps.ts contains [harnessDevDepRange] — one function decides the range, and it can never return a path. The fallback for an unreadable version is a narrower range, not `*` and not `file:`: `*` would let a consumer install a major they were never scaffolded against
- [x] SC-814: test/scaffold-installable.test.ts contains [no sibling harness] — `bun install` is RUN, in `os.tmpdir()`, which shares no ancestor with this checkout, so no relative `file:` path can reach the harness by any route. The issue named the decorative version by name: a fixture that can still resolve the harness proves nothing
- [x] SC-815: test/scaffold-installable.test.ts contains [--frozen-lockfile] — the CI invocation is run as a SECOND install over the lock the first one wrote, which reproduces CI's conditions rather than approximating them. That is the command that fails over a pinned `file:` entry even with `--no-optional`

### What was broken to prove it (SC-813..815)

Run and counted over `test/scaffold-installable.test.ts` +
`test/scaffold-determinism.test.ts` (18 tests):

| Mutation | Red |
|---|---|
| the `file:` dependency restored verbatim — the original defect | 4 of 18 |
| the range becomes the exact current patch (`^0.2.2`, unpublished) | 3 of 18 |
| the unparseable-version fallback becomes `*` | 1 of 18 |

The middle row is the one that proves the install cases are real. An
exact-patch caret is still a semver range and still not a path, so every
shape assertion stays green — the three reds are the two `bun install` cases
and the floor case, which means those installs genuinely resolve against the
registry rather than against anything on this machine.

None is left in the tree; all were run and reverted.

**Not done here, and the issue says so itself:** the range resolves to 0.2.1
today, which predates the `bin` added in #363. A consumer installing from
npm therefore gets a working dependency and a `rungate` command that is one
release behind. Publishing is an outward-facing action with its own
authorization, and #364 — no release workflow, npm on 0.2.1 against a repo
735 commits in — is where that belongs. This change is what makes a publish
worth doing; it does not perform one.

### The re-scaffold command destroyed the rule it was told to preserve (#370)

`bun bin/rungate.ts scaffold . --fix`, on a clean checkout of this repo, with
nothing else in the tree:

```
 .claude/rules/checks-must-be-able-to-fail.md | 197 ---------------------
 .claude/rules/docs-routing.md                |   2 +-
 .claude/rules/key-files.md                   |   6 +-
```

The loop was eight unconditional `writeFileSync` calls reporting `GENERATED:`
each. `checks-must-be-able-to-fail.md` went from 262 lines to 65 — the
generator's canonical opening survives and every worked example and mutation
table the repo added after it does not. Three specs cite that file by path.
`key-files.md` lost the `#296` annotation added *after* run
`wf_0b15a933-b2b` lost four worktrees and 2,565 lines of validated work.

Exit 0, and `git status` reported `M`, not `D`, so it did not even read as a
deletion. The damage sat in a working tree through a full green `bun test`.

**Neither obvious answer works, and that is why this went unresolved.** It is
the other half of #208's question — *who owns a generated file after a human
edits it*:

| mode | behaviour | failure |
|---|---|---|
| plain `scaffold .` | writes nothing | a generator fix never reaches a tree that has the file — #363's AGENTS.md change could not be adopted at all |
| `scaffold . --fix` | writes everything | the above |

`key-files.md` is genuinely generated — its table comes from a scan — *and*
genuinely hand-annotated, so no list of owned filenames can be right either.

The mechanism is provenance carried by the file itself: the generator stamps
the sha of the body it wrote into the file's own frontmatter, so on the next
run the file answers the only question that matters — *has anyone touched
this since the harness wrote it?* — with no manifest that can desync from the
tree it describes.

| existing file | action |
|---|---|
| absent | create |
| body identical to what would be generated | update |
| carries a marker matching its own body | update |
| anything else | **preserve, and report** |

Row two is what makes adoption possible without a migration: a file the
harness wrote before provenance existed is byte-identical to the generator's
output, so the first run recognises and stamps it. Measured on this repo —
five of eight rules adopted on the first `--fix`, two preserved
(`checks-must-be-able-to-fail.md`, `key-files.md`), and `docs-routing.md`
accepted by hand because its divergence was real drift the generator had
right: `ADRs — architecture decisions (1 files)` against a `docs/adr/`
holding two.

Row four is the fallback rather than an enumerated case, and it is allowed to
be wrong in one direction only. Preserving a file the harness could have
regenerated costs a line in a report that names the remedy. The other
direction cost 197 lines nobody noticed were gone.

- [x] SC-818: lib/rule-provenance.ts contains [decideRuleWrite] — ONE exported predicate decides whether a generated rule file may be written, so there is one binding to mutate. A second decider would survive any mutation of the first and the guard would go green for a reason unrelated to it working
- [x] SC-819: lib/scaffold/steps.ts contains [PRESERVED: .claude/rules/] — a withheld write is REPORTED, never silently resolved. A run that quietly declined to write is indistinguishable from one that had nothing to do
- [x] SC-820: test/rule-provenance.test.ts contains [scaffold(dir)] — the preserve cases SPAWN the real scaffold over a file carrying hand-written content. Asserting that the scaffold "preserves files" without running it is the vacuous version the issue named by name
- [x] SC-821: test/rule-provenance.test.ts contains [a rule file the repo routes agents to is gone] — CI notices a rule file disappearing, which nothing did before: the #370 deletion survived a full green suite

### What was broken to prove it (SC-818..821)

Run and counted over `test/rule-provenance.test.ts` (17 tests):

| Mutation | Red |
|---|---|
| the write loop restored to unconditional `writeFileSync` — the original defect | 4 of 17 |
| `decideRuleWrite` always returns `preserve` — "never overwrite", #208's half | 9 of 17 |
| `stampProvenance` returns its input unchanged — markers never written | 8 of 17 |
| `ruleBody` stops stripping leading newlines after the frontmatter | 2 of 17 |
| the `identical to generator output` row removed — no bootstrap | 1 of 17 |
| the citation scan narrowed to `specs/` alone | 1 of 17, and **0 of 16** before the case below it was written |

**The last row is a finding, not a footnote.** `SCOPE` lists eight
directories and cutting it to `specs/` alone changed nothing any test
asserted: the vacuity guard needs five cited rules and three citers of
`checks-must-be-able-to-fail.md`, and `specs/` supplies both on its own. So
`lib/`, `scripts/`, `gates/`, `hooks/`, `workflows/`, `bin/` and the rules
directory were along for the ride, and a dangling citation added in source
would not have been checked. `the scan reaches source, not only specs`
asserts the citing directories by name, which is the same
"predicate nobody consults" shape #360 found one layer down.

Two more findings came out of writing the tests rather than out of the
mutations.

**The citation check reported two missing files, and both were the check's
fault.** `docs/adr/ADR-002` discusses a `config-access.md` rule that ADR-001
drafted, recording in a table that it was "**Never created.**" A document
accurately reporting a file's absence is not a dangling pointer, and flagging
it would make the only fix deleting the sentence. The other was `a.md`, a
literal inside a `post-scaffold-commit.test.ts` fixture. ADRs and test
fixtures are out of scope; specs, source and the rules themselves are in.
Walking `.claude/worktrees/` as well had inflated the counts to 126 and 130
citing files and the scan to twelve seconds.

Then the check caught **this spec**, which had quoted that ADR sentence in
full, path and all — the fourth self-reference trap of the day. The fix is to
name the file without its directory, not to widen the detector:
`.claude/rules/claiming-sc-coverage.md` makes the same call for the same
reason, and a detector narrowed to buy green is shape two of
`.claude/rules/checks-must-be-able-to-fail.md`.

**The sha covered one newline too many.** `stampProvenance` on content with
no frontmatter prepended a block followed by a blank line, so the body it
hashed and the body the next run read differed by a `\n`, and the very first
stamped file would have read as hand-edited one run later — the mechanism
silently degrading into "never overwrite", which is the failure mode this
design exists to avoid, reached by accident.

None of the six mutations is left in the tree; all were run and reverted.

**Deliberately not done:** `docs-routing.md` was accepted by deleting it and
re-running, which is the remedy the report names. There is no
`--accept-generated` flag, because a flag that resolves divergence is one
`--fix` away from being the behaviour that caused this.

#### This changes SC-364's contract, and says so rather than absorbing it

SC-364's `corrupted generated files are restored to byte-identical content`
listed three targets, one of them `.claude/rules/key-files.md`. **A corrupted
file and a hand-edited one are byte-identical to any check**, so "restore the
original bytes" and "never overwrite a human's edit" cannot both hold over
the same file. SC-364 shipped first and was right for the files it was
written about; it was also the behaviour that truncated
`checks-must-be-able-to-fail.md`.

The resolution is a split the repo already documents, not a new judgement:

| class | owner | on divergence |
|---|---|---|
| `AGENTS.md` | harness (SC-11, "always regenerates") | restored |
| `CODE-MAP.md` | harness (named in `harness-managed.md`) | restored |
| `.claude/rules/*.md` | shared — generated table, hand annotations | preserved and reported |

SC-364 keeps its anti-vacuity force over the first two: the corruption case
still demands the original bytes back from a generator that actually ran. The
rules class moves to `an edited rule file is preserved instead, and the run
says so`, asserted in the same file, because a deleted case with a comment
explaining its absence holds nothing. Restoring the unconditional
`writeFileSync` turns it red — 1 of 9 over
`test/scaffold-determinism.test.ts`, run and reverted.

Both failures the change produced were this one conflict. The second —
`a deleted generated file comes back identical` — was a cascade: the
corruption case left `CORRUPTED BY TEST` preserved on disk, and the next case
snapshotted it as the baseline.

## Ownership is data, not prose (#208)

`.claude/rules/harness-managed.md` said of five file classes: *"managed by
rungate and **regenerated on re-scaffold**. Do not edit them directly."* That
is an ownership claim, and a maintainer who believes it correctly declines to
hand-edit a brief and waits for a re-scaffold to deliver improvements.

**It was true for four of the five.** Measured on this tree:

| claimed file | what re-scaffold actually did |
|---|---|
| `.github/workflows/ci.yml` | regenerated, job-preserving — correct |
| `.github/workflows/gates.yml` | the same — correct |
| `.claude/agents/*.md` | rewritten every run — correct |
| `CODE-MAP.md` | rewritten, with a freshness skip — correct |
| `test/scaffold-conformity.test.ts` | **skipped forever** |

The last went through `safeWrite`, which returns early on `existsSync`.
Create-if-absent wearing the word "regenerated". The run reported
`SKIP: … (already exists)`, which is indistinguishable from "already current"
to anyone reading the log, and the claim converted a fixable staleness into a
permanent one.

The issue's framing — *every* `safeWrite` file drifts — is right about the
mechanism and overcounts the damage. Of the five call sites only one is a file
the harness claims; two are files it does not claim, and two must NEVER be
rewritten: `project-state.json` and `PROJECT-STATE.md` are DA-owned (#296),
and run `wf_0b15a933-b2b` lost 2,565 lines of validated work to four worktrees
each writing their own copy. So the fix is not a tighter helper. **The defect
is that ownership was prose** — a table in a doc cannot be iterated, so
nothing could notice a row describing behaviour the code did not have.

- [x] SC-837: lib/scaffold/owned-files.ts contains [OWNED_FILES] — the declaration is DATA. The table in `.claude/rules/harness-managed.md` is generated from it and reconciled against it in both directions, so a row cannot exist without an entry and an entry cannot exist without a row
- [x] SC-838: lib/scaffold/steps.ts contains [regenerateOwned] — an owned file is written every run. `safeWrite` keeps the create-only files it was always correct for, and DELEGATES to this, so there is one writer
- [x] SC-839: lib/scaffold/owned-files.ts contains [regenerated output is byte-identical] — `0 changed` is a measurement. The old report was produced by not looking; this one is produced by looking and finding no difference, and the two are only indistinguishable in the summary line
- [x] SC-840: lib/scaffold/owned-files.ts contains [decideOwnedWrite] — ONE exported function decides what happens to one owned file, so there is one binding to mutate. The four strategies answer the same question differently and all route through it
- [x] SC-841: lib/generators/agents-md.ts contains [ownedFilesTable()] — the doc's Strategy column is generated. "Managed" was doing too much work as one word, and the column is the part that would have caught this
- [x] SC-842: lib/scaffold/steps.ts contains [isHarnessItself] — the generator knows when the project it is writing is the harness, because rungate's own conformity test was hand-adapted and the skip was the only thing preserving it. ONE predicate decides it, imported from `lib/generators/agents-md.ts` where SC-811 already named it: #208 shipped a second copy, and two deciders of the same fact survive any mutation of either

### The hand-edit policy, chosen rather than implicit (AC-5)

**Preserve and report.** #370 already answered this for `.claude/rules/*.md`
and chose the same, for the same reason: silently overwriting a human's work
is the opposite failure from silently skipping, and it is the worse one,
because the skipped file is still on disk and the overwritten one is gone. A
second answer here would mean the harness destroyed work in one directory and
refused to in another, with nothing stating which was which.

### What regenerating actually exposed

Making the file regenerate is one line. What it uncovered is the issue:

**rungate's own conformity test had always been hand-adapted.** It imported
`../lib/conformity`; the template emitted `rungate/lib/conformity`
unconditionally. A package cannot import itself by name without an `exports`
map. So regenerating without `isHarnessItself` would have replaced a working
self-hosted suite with one that cannot resolve its own import — the skip was
load-bearing, and nothing said so.

**The template passed an argument no entry point takes.** Every call was
`runDocHygiene(ROOT, findings)`. No conformity entry point has ever accepted a
findings array — they accumulate in a module-level collector that
`writeFindingsReport(root)` reads. It typechecked nowhere and did nothing
anywhere, and survived because the only tree that typechecks this file is
rungate's, whose copy was the hand-adapted one. Seven typecheck errors
appeared the moment the file regenerated.

**The template had dropped `runDirectoryValidation`.** rungate's copy ran it;
the generated one did not. Regenerating would have deleted a live check — the
same silent coverage loss as #208, pointed the other way. The generated suite
is now the union, which moved the file from 516 tests to 527.

### What was broken to prove it (SC-837..842)

Run and counted over `test/scaffold-ownership.test.ts` (29 tests):

| Mutation | Red |
|---|---|
| `regenerateOwned` reverted to create-if-absent — the original defect, verbatim | 8 of 29 |
| the `create-only` branch deleted from `decideOwnedWrite` — #296 undone | 2 of 29, and **0 of 22** before the fix below |
| `provenance` never preserves — a hand-edited rule is overwritten (#370 undone) | 3 of 29 |
| `bytesIdentical` always false — every run reports CHANGED, idempotence gone | 3 of 29 |
| the Strategy column dropped from `ownedFilesTable()` | 2 of 29 |
| the `test/scaffold-conformity.test.ts` row deleted from `OWNED_FILES` | 3 of 29 |
| `isHarnessItself` always false — rungate emits a self-import it cannot resolve | 3 of 29, and **0 of 23** before the case below was written |
| `ownedStrategy` stops matching the `*` class — `.claude/rules/*.md` loses provenance | 1 of 29 |
| the `PRESERVED` report dropped — a withheld write becomes silent | 1 of 29 |
| `runDirectoryValidation` removed from the template again | 2 of 29 |
| the import specifier hardcoded back to `rungate/lib/conformity` | 2 of 29 |

**Two rows are findings, not footnotes**, and both are the same shape.

`safeWrite` originally read the decision and then branched on
`action !== "create"`. That is equivalent to honouring the decision for every
input `create-only` can produce today — and exactly because it is equivalent,
it ABSORBED the second mutation: with the `create-only` branch gone, every
seeded file fell through to the regenerate path, and `safeWrite` reported
`UNCHANGED` and declined to write anyway. **Nothing went red.** The #296
protection was asserted in the declaration and enforced in a second place, so
mutating the declaration proved nothing. `safeWrite` now delegates to
`regenerateOwned`, and the DA-owned files are asserted behaviourally — driven
through `ownedStrategy` with no strategy argument, so the declaration is in
the path rather than bypassed by the test.

The seventh scored 0 for the plainer reason: the self-hosting detection was
the whole discovery of the fix and nothing asserted it. Six cases now do,
including the one that makes "regenerated" an honest word — the shipped
`test/scaffold-conformity.test.ts` must be byte-identical to
`generateConformityTest(ROOT)`. Without that reconciliation the generator can
emit anything and the file on disk stays whatever it was, which is the state
this issue found.

None of the eleven mutations is left in the tree; all were run and reverted,
and the eleven counts above were re-measured against the final 29-test file so
they come from one tree.

**Out of scope, filed rather than fixed:** `refreshAgentsMd`'s broken-link
check reads `` `bun test test/scaffold-conformity.test.ts` `` out of the
Commands table and reports the whole command string as a missing file. A
false positive in a different detector, pre-existing, and a different class
from ownership.

## One fact, one decider: "is this project the harness?" (#380)

#208's commit message argued — about `safeWrite` — that two deciders of the
same fact survive any mutation of either. **The change it shipped then did
exactly that**, adding a fourth inline answer to a question already answered
three times. Found immediately afterwards, and the copies had already
drifted, which is the concrete harm rather than the tidiness argument:

| site | unreadable `package.json` |
|---|---|
| `isHarnessItself` in `lib/generators/agents-md.ts` | caught — reads as a consumer |
| `generateAgentBriefsStep`'s `isSelf` | **threw**, killing the scaffold run |
| `lib/scanner.ts`'s `detectPromptPrefix` | caught |
| `lib/conformity.ts`'s PKG-3 exemption | caught |

Three of four agreed. Nothing could notice the fourth, because there was
nothing to compare it against.

Two further sites — brief-type detection and the devDep self-reference —
contain the comparison but ask a **different** question (`… || keywords
includes "harness"`, `… || devDependencies.rungate`). They keep their own
branch and borrow only the identity half. A consolidation that swallowed
them would be the opposite error.

### Why a leaf module rather than the owner it already had

`lib/generators/agents-md.ts` declared it first and SC-811 names it there.
It cannot stay: `lib/scanner.ts` needs the same answer, and SC-365 / AC-3
forbids the scanner from importing any generator — correctly, since the
scanner is the module other scripts pull in precisely because it drags
nothing behind it. So the implementation moves to a leaf importing nothing
but `fs` and `path`, and `agents-md.ts` re-exports it. A re-export is one
binding under two names, which is the opposite of two deciders, and the test
asserts the two names resolve to the same function object rather than
assuming it.

- [x] SC-843: lib/harness-identity.ts contains [isHarnessItself] — ONE predicate answers "is this project the harness", and it is a leaf so every caller can reach it, including the one SC-365 forbids from importing a generator
- [x] SC-844: test/harness-identity.test.ts contains [IDENTITY_COMPARISON] — the singleton is MECHANICAL, not a convention. It scans lib/ for the comparison in both the literal and the constant form, and proves the scan sees a planted site rather than passing over an empty result
- [x] SC-845: lib/scanner.ts contains [isHarnessItself] — the scanner shares the one answer without importing a generator, which is what the leaf exists for

### What was broken to prove it (SC-843..845)

Run and counted over `test/harness-identity.test.ts` (7 tests):

| Mutation | Red |
|---|---|
| the `try`/`catch` removed — the drift that made one copy throw | 1 of 7 |
| equality relaxed to `includes` — `rungate-plugin` becomes the harness | 2 of 7 |
| the predicate always answers "consumer" | 1 of 7 |
| a second decider planted back into `lib/scaffold/steps.ts` | 1 of 7 |
| the re-export dropped from `agents-md.ts` — SC-811's name stops resolving | the file ABORTS on import, which is the correct shape: 6 cases cannot run rather than quietly passing |
| the leaf grows a non-leaf import | 1 of 7 |
| `agents-md.ts` declares its own copy alongside the re-export | 1 of 7 |

**One mutation scored 0 and the guard it hit is gone rather than
documented.** The first draft had `if (!existsSync(pkgPath)) return false;`
in front of the `try`. Removing it changed no answer — a missing file throws
into the same `catch` — so it was a branch that could not change an answer,
and a branch like that reads to the next person as if it can.

**A second zero was caught before it could be recorded**, and it is the
sharper one. The owner compares against a `HARNESS_PACKAGE` constant rather
than the literal `"rungate"`. The first `IDENTITY_COMPARISON` knew only the
literal, so it found **zero** sites — and `toEqual([...])` against zero
passes exactly as happily as against one. The constant indirection would
have bought green by blindness in the one check written to prevent that. The
detector now reads both forms, and the positive control asserts both are
seen while the bare word is not.

None of the seven mutations is left in the tree; all were run and reverted,
and the counts were re-measured after the dead guard was removed so they
come from one tree.

## #87 — the generator decided the project needed no tsconfig and the suite failed it for not having one

Five sites answered "is this a TypeScript project, and what type-checks it?"
and they disagreed. The disagreement is not a tidiness complaint: a consumer
could not satisfy all five at once.

| site | asked | answered |
|---|---|---|
| `createTsconfig` | is there TypeScript source? | skip the tsconfig if not |
| `createCiWorkflows` | is there a tsconfig? | skip the CI step if not |
| `generateAgentsMd` | is there a tsconfig? | skip the doc row if not |
| `scanProject` → `dev.typeCheck` | nothing | `bunx tsc --noEmit`, always |
| `runTsconfigValidation` (TSC-1) | nothing | the tsconfig MUST exist |

So a consumer with no hand-written TypeScript got: no tsconfig, from the
generator that decided it did not need one; no CI step and no doc row, from
the two that agreed; **a hard TSC-1 failure in its generated conformity
suite**, over that same absent file; and a `dev.typeCheck` of `bunx tsc
--noEmit` written into its config, which `gates/gate-executor.ts` runs.
Without a tsconfig that command prints 147 lines of help text and exits 1, so
the verify gate reported `Type check FAIL` at every consumer the other sites
had agreed not to type-check. That last one is #65/#76 reintroduced in the one
place #65/#76 never looked, and it was the fourth site, not the first.

### The decision the issue asked for

> Either consumers are allowed to be non-TypeScript projects (then TSC-1 must
> become conditional or a warning), or they are not (then the scaffold should
> generate a tsconfig and TSC-1 is right). Pick one; today both are asserted.

**Consumers are allowed to be non-TypeScript projects.** Two generators had
already shipped that answer, and the alternative is worse on its own terms: a
tsconfig written into a project with no TypeScript in it has `include: []`,
which is tsc error TS18003 — a type check that reads as broken rather than as
"nothing to check".

TSC-1 therefore reads `tsconfigVerdict`, the predicate `createTsconfig`
already used, and the conditional arm **records** a WARN finding rather than
passing quietly. An unmeasured check and a satisfied check are the same shape
from the outside; `.claude/rules/config-access.md` names the silent form
*Silent Default Substitution* and this is the same defect with a different
subject.

### The ratchet branch no consumer could reach

`package.json` `files:` ships neither `scripts/typecheck.ts` nor
`tsconfig.json`, so `createCiWorkflows`'s `hasRatchet` branch was dead code
that read as a supported configuration, and a consumer with a tsconfig full of
pre-existing errors was handed `bunx tsc --noEmit` in a generated file carrying
a *do not edit* banner.

Shipping `scripts/typecheck.ts` would not have fixed it: its `ROOT` is
`join(import.meta.dir, "..")`, so from `node_modules/rungate/scripts/` it would
ratchet rungate's tree rather than the consumer's. The reachable branch is the
consumer's own `package.json` `scripts.typecheck`, which `typecheckDecision`
now checks first — one ladder, read by the CI step, the AGENTS.md row and
`dev.typeCheck` alike, where there were three ladders and a constant.

### The ratchet was pinned to nothing

`typescript` was absent from `package.json` and from `bun.lock`, so `bunx tsc`
fell through to the registry and resolved **TypeScript 7.0.2** — the Go port, a
major-version rewrite. A baseline is a snapshot of one compiler build's
diagnostics and the ratchet fails in BOTH directions, so any upstream release
that added or removed a diagnostic turned CI red with no code change.
`typescript` is now an **exact** pin (a caret re-opens the hole one patch
release at a time), `scripts/typecheck.ts` spawns the installed binary, and it
refuses rather than falling back to `bunx` when that binary is missing —
a fallback would silently restore the unpinned behaviour, and an unpinned run
that happens to report the baseline count is indistinguishable from a pinned
one that does. Measured: 0 errors under both 7.0.2 and the pinned 5.9.3, so the
baseline carries over unchanged.

- [x] SC-1479: lib/typescript-project.ts contains [tsconfigVerdict] — ONE predicate answers "does this project need a tsconfig.json". It returns a reason rather than a boolean, because a check that skips has to be able to say what it skipped over
- [x] SC-1480: lib/conformity.ts contains [tsconfigVerdict] — TSC-1 fails for a project with TypeScript source and no tsconfig and records a WARN finding for a project with neither. Both arms are EXECUTED under a spawned `bun test`: a direct call cannot tell a conditional check from one whose assertion never ran
- [x] SC-1481: lib/typescript-project.ts contains [typecheckDecision] — one ladder produces the CI step the AGENTS.md row and `dev.typeCheck`. A project's own `scripts.typecheck` wins which is the only branch a consumer can reach; `dev.typeCheck` is null rather than a command the verify gate can only fail
- [x] SC-1482: scripts/typecheck.ts contains [node_modules] — the ratchet spawns the pinned compiler and REFUSES when it is absent rather than falling back to whatever the registry resolves
- [x] SC-1483: test/typescript-project.test.ts contains [SOURCE_DIR_DECIDERS] — the singleton is MECHANICAL. It scans lib/ for a second definition of the predicate or the directory list and proves the scan sees a planted one rather than passing over an empty result

### What was broken to prove these can fail

Counted over `test/typescript-project.test.ts` (33 tests). None of the
mutations is left in the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `tsconfigVerdict`'s `applicable` forced to `false` | 4 of 33 — both verdict cases and both executed TSC-1 arms |
| TSC-1's skip stops calling `addFinding` | 1 of 33 — the silent pass, which is the arm with nothing else to observe |
| `typecheckDecision` loses the `scripts.typecheck` branch | 3 of 33 — the decision, the CI step and the AGENTS.md row |
| `typecheckDecision` returns `bunx tsc --noEmit` with no tsconfig (the old constant) | 5 of 33 — the decision, the CI comment, the absent doc row, `dev.typeCheck` and its read-back |
| the ratchet falls back to `bunx` instead of refusing | 1 of 33 — the executed copy, run from a directory with no `node_modules` |
| the `typescript` pin becomes `^5.9.3` | 2 of 33 — package.json and the lockfile |
| a second `containsTypeScript` planted in `lib/scaffold/steps.ts` | 2 of 33 — the singleton and the planted-copy control |
| `createCiWorkflows` keeps its own ladder | 1 of 33 |
| `generateAgentsMd` keeps its own ladder | 1 of 33 |
| `DevSchema.typeCheck` back to `z.string().optional()` | 1 of 33 — the loader refuses the value the generator writes |

**One mutation zero, found and closed.** Restoring the old `bunx tsc
--noEmit` constant scored **0** against `dev.typeCheck` at first. The test
asked `lib/scanner.ts`'s `scanProject`, which has no `dev` block at all, so
`?? null` was null whatever the generator did — a vacuous assertion of
exactly the shape `.claude/rules/checks-must-be-able-to-fail.md` lists third.
The field is written by `generateOrAuditProjectHarness`; the case now runs it
and reads the value back off disk, with a TypeScript-consumer control beside
it so "always null" cannot satisfy it. Re-measured: 5 of 33.

**And one defect the full suite found that this file had not.**
`DevSchema.typeCheck` was `z.string().optional()`, so the honest `null` threw
a `ZodError` out of `loadRungateConfig` and took four greenfield-scaffold
tests with it. A value the generator writes and the loader refuses is not a
value; `typeCheck` is now `.nullable().optional()` for the reason
`healthPath` already is, and the round trip through the loader is asserted
here rather than left to a neighbouring suite to discover.

## #426 — `scaffold --fix` silently truncated the criteria it could not parse

`bun bin/rungate.ts scaffold . --fix` is the documented way to take a harness
update. It rewrote `specs/HARNESS-GATES.md` on every run, and the rewrite lost
information:

```diff
-- [ ] SC-1469: workflows/ship.js not contains [s.environments.prod.rebuild = 'PASS'] — a container that answers a health check is recorded as SKIP with a reason rather than as a rebuild that happened
+- [ ] SC-1469: not contains [s.environments.prod.rebuild = 'PASS']
```

The file the criterion is about and the whole rationale clause, deleted,
deterministically, reported only as `1 replaced` under a summary naming
`ci.yml`.

### The proximate cause is a matcher that did not accept its own grammar

`content-not-contains` in `config/matcher-registry.json` accepted
`must NOT contain` and `has no` — but **not** the `not contains` form, which
is the form `content-contains-compound`'s own example writes
(`gates/orchestrator.ts contains [github] and not contains [gh issue]`). So
the single-clause form of the documented grammar was unmatchable.

That has a consequence larger than the truncation, and it is this repo's
central defect class: **SC-1469 generated no assertion.** An absence claim
about `workflows/ship.js` sat in a spec reading like a criterion, was counted
as an unmatched coverage gap, and was never executed. Widening the entry
turns it, and SC-539, into checks that run.

### Fixing only the matcher would have left the mechanism intact

Measured before the fix: **71 of 152 unchecked SC lines across `specs/`** were
classified unmatched, and every one of them is a candidate for the same
rewrite. So the rewriter itself is guarded, by one exported decision —
`decideRewrite` in `scripts/audit-specs.ts` — with three rules:

1. A statement already in the structured grammar — a target named up front and
   a bracketed payload — is **never** rewritten. A matcher gap is a matcher
   gap; it is not a licence to delete what the author wrote.
2. A rewrite that would drop the file the criterion names is **refused**.
   `findClosestPattern`'s last resort collapses anything containing a filename
   to `<file> exists`, which is an assertion that holds vacuously against a
   file that obviously exists.
3. A rewrite that survives both carries the em-dash rationale across.

`file-exists` remains the one live rewrite path, and deliberately: it writes
the statement it replaced into a `REVIEW` comment on the next line, so nothing
leaves the file. A fix that stopped rewriting altogether would satisfy every
"the line survived" case here, which is why each of them is paired with a case
asserting that an unstructured line IS still rewritten.

- [x] SC-1587: test/audit-specs-lossless.test.ts contains [--fix leaves a structured criterion byte-identical] — SC-1469's exact text, run through the real rewriter, beside a structured-but-still-unmatched line and an unstructured one that must still be rewritten
- [x] SC-1588: test/audit-specs-lossless.test.ts contains [running --fix twice is a fixed point] — the issue's own reproduction: a rewriter that is not idempotent is editing something it has already decided about
- [x] SC-1589: test/audit-specs-lossless.test.ts contains [the decision about one line, driven directly] — one exported binding, so there is exactly one thing to mutate
- [x] SC-1590: test/audit-specs-lossless.test.ts contains [a rewrite that would drop the file the criterion names is refused] — rather than written and reported
- [x] SC-1591: test/audit-specs-lossless.test.ts contains [a rewrite that survives carries the rationale across] — the prose after the em dash is the intent, and intent is what the claiming-sc-coverage rule exists to keep legible
- [x] SC-1592: test/audit-specs-lossless.test.ts contains [a statement with no close pattern is kept rather than invented]
- [x] SC-1593: test/audit-specs-lossless.test.ts contains [the absence form binds to a matcher, so the claim is executed] — five forms asserted matchable and prose asserted NOT, because a matcher widened until it matches everything is the same defect from the other side
- [x] SC-1594: test/audit-specs-lossless.test.ts contains [a rewrite is reported, naming the spec and the id] — and SC-1469 is asserted to be MATCHED now rather than merely unrewritten: "not rewritten" and "never considered" are different states
- [x] SC-1595: test/audit-specs-lossless.test.ts contains [the scaffold step names every rewritten criterion in its actions] — a spec line edited under a documented command and reported only as a count is the defect, not just the content lost
- [x] SC-1596: test/audit-specs-lossless.test.ts contains [the tree carries no line already damaged by this] — swept over every spec rather than the one the issue names, with a probe case proving the sweep can see a damaged line

### What was broken to prove it (SC-1587..1596)

Measured over `test/audit-specs-lossless.test.ts`, `test/audit-specs.test.ts`,
`test/scaffold-audit-agreement.test.ts` and `test/conformity-sc-binding.test.ts`
— 70 tests, baseline 0 red. None of the eleven is left in the tree; all were
run and reverted.

| Mutation | Red |
|---|---|
| nothing is already structured — #426 verbatim | 4 of 70 — the byte-identical case, both halves of the predicate, and the reported decision |
| everything is already structured, so `--fix` stops rewriting | 7 of 70 — every rewrite case, the predicate, and #556's own AC-8 idempotence test. This is the "fix by switching it off" that AC-4 names, and it is the most-caught mutation in the battery |
| a rewrite may drop the file the criterion names | 1 of 70 |
| the rationale is not carried across | 1 of 70 |
| every line is kept, so `--fix` is a no-op | 4 of 70 — including AC-8 again, from the other direction |
| the `kept` flag is never recorded | 1 of 70 — "deliberately left alone" and "rewritten to the same text" stop being distinguishable |
| the absence form goes back to being unmatchable | 2 of 70 — the five-form case, and SC-1469 falling back out of `matchedSCs` |
| the absence form widens until prose matches it | 9 of 70 — the positive control plus six pre-existing cases across the conformity binding and the audit's own classification. A matcher widened until it matches everything is the same defect from the other side, and the suite already knew it |
| the scaffold stops naming what it rewrote | 1 of 70 |
| the scaffold stops naming what it kept | 1 of 70 |
| the tree sweep reads nothing | 1 of 70 |

The last row is the one worth recording, because it was a defect in this
PR's own first draft, found by predicting the count before running. The sweep
asserted `damaged` was empty over every spec in the tree — and an empty list
is also what a walker reading nothing produces. The case that was supposed to
guard it only exercised the classifying regex, not the walk. A count control
on both the files found and the SC lines classified was added first; the
mutation above is that control, performed and observed. Without it the row
would read **0 of 70**, in the sweep written to prove a claim about the whole
tree — which is where it would have been least visible.

## #442 — external adoption was built and had never fired

`scanExternalSources` does `~` expansion, scanning, matching and
classified-target proposal with a confidence score, and
`scripts/convert-spec.ts` converts freeform docs into spec format. The
feature has never fired for any project, for four independent reasons. Each
alone is sufficient.

**1. `organizeProject` had exactly one caller, and it was a human.**
`scripts/organize-project.ts`, a CLI defaulting to `--dry-run`. Nothing in
scaffold, ship or any hook invoked it, so re-scaffolding a project — the
thing people expected to trigger adoption — could not.

**2. Scaffold wrote the allowlist empty, in two places,** and
`lib/organize.ts` guarded the whole external branch on its presence. A
feature that ships with an empty allowlist and nothing prompting anyone to
fill it is off by default forever.

**3. Both match modes keyed on the literal project DIRECTORY NAME.**
Measured by the reporting session against a real sibling document:

```
grep -ic "dailybriefdashboard"  ->  0
grep -ic "ddb"                  ->  2
```

This generalises. A document written in one project that refers to another
calls it by nickname, abbreviation, product name or repo slug — almost never
by the name of the directory it happens to be checked out into.

**4. Three fail-opens in one loop.** A declared path not on disk was
`continue`d, an unreadable file was `catch {}`ed into a non-match, and the
whole directory walk sat inside another bare `catch`. The issue named two;
the third was found while fixing them. A fourth defect was found the same
way: `source.path.replace("~", HOME)` replaces the FIRST `~` anywhere, so
`/srv/backup~old/docs` became `/srv/backup<HOME>old/docs`.

### Decisions, recorded

**Aliases are derived where the tree states them and declared where it does
not.** The directory name and the GitHub slug come from `basename` and
`.git/config`; `organize.aliases` is for what only a human knows. Reading
`.git/config` rather than spawning git is deliberate — this runs inside
scaffold, and a subprocess per scaffolded project buys nothing when the file
is right there.

**Matching is by WORD, not substring, and short aliases are refused.** The
aliases that make this feature work are short, and `ddb` as a substring
matches `oddball`. A three-letter abbreviation proposing adoption of every
document containing those letters is worse than the matcher that never
fired. `MIN_ALIAS_LENGTH` is 2 for the same reason #437 needed an exact
mkdtemp shape: a one-character alias matches most of a directory.

**One matcher, not two.** The two modes were two separate expressions on the
same question. `matchesAnyAlias` is the single binding, so there is one
thing to mutate and no second copy to drift.

**Scaffold runs it DRY, always.** Discovery stops requiring prior knowledge
that the feature exists; adoption stays something a person chooses. The step
writes nothing, which is also why it is safe during rehearsal.

**The empty list stays empty, and says so.** An external source is an
absolute path on one person's machine; a default would have scaffold propose
adopting documents out of directories the user never named, in every project
it touches. So the decision is to write nothing and report that the decision
was made — "nobody configured this" and "this ran and found nothing" are
different facts that used to produce the same output.

- [x] SC-1641: test/external-adoption.test.ts contains [a project is matched by the names its documents actually use] — aliases are consulted by both modes, and the repo name and slug are derived rather than typed
- [x] SC-1642: test/external-adoption.test.ts contains [a matcher that would propose everything is refused] — word boundaries, a minimum alias length, and a doc that matches nothing producing no proposal
- [x] SC-1643: test/external-adoption.test.ts contains [a declared path that is not on disk is UNMEASURED] — the report names the path, and `~` expands only when it leads
- [x] SC-1644: test/external-adoption.test.ts contains [a file that cannot be read is reported, not called a non-match] — measured once by permission and once by a dangling symlink, which no user can bypass
- [x] SC-1645: test/external-adoption.test.ts contains [scaffold reports proposals without applying them] — the step is invoked by the scaffold run, writes nothing, and surfaces unmeasured sources
- [x] SC-1646: test/external-adoption.test.ts contains [an empty externalSources list is a recorded decision] — the reason is stated, and a scan that ran and matched nothing names the aliases it tried
- [x] SC-1663: test/scaffold-relative-root.test.ts contains [a target with no directory separator resolves to the current directory] — `dirname`- not a slice whose negative end `substring` clamps to zero
- [x] SC-1664: test/scaffold-relative-root.test.ts contains [the scaffold is invoked with a relative root and completes] — the real CLI with the real argument- because the defect was never visible at the line- only in the argument
- [x] SC-1665: test/scaffold-relative-root.test.ts contains [the relative and absolute invocations produce byte-identical trees] — both runs over the SAME directory restored from a pristine copy- so there is no root string to normalise and no normaliser for a difference to hide behind
- [x] SC-1666: lib/scaffold/rehearsal.ts contains [Root SUBSTITUTED] — the audit names the input it replaced- because an unrehearsed input reported as rehearsed is `UNMEASURED is not SKIP` wearing a dry run's clothes

- [x] SC-1667: test/managed-workflow-key-order.test.ts contains [a consumer-only top-level key keeps its position relative to jobs] — the merge walks the CONSUMER's sections- so the order in the file is the order the consumer wrote
- [x] SC-1668: test/managed-workflow-key-order.test.ts contains [a comment above a relocated key travels with it] — the comment is the artefact the reader acts on- and one describing a block 460 lines away is a false deletion signal
- [x] SC-1669: lib/scaffold/managed-workflow.ts contains [export function topLevelKeyOrder] — ONE reader of a file's key order- so the movement check and the duplicate check cannot disagree about what a top-level key is
- [x] SC-1670: test/managed-workflow-key-order.test.ts contains [a key that changes position is reported by name and by where it went] — movement is a change of RANK among the keys both versions have- not of line number- so an inserted key does not report every key below it
- [x] SC-1671: test/managed-workflow-key-order.test.ts contains [the merge refuses rather than writing a workflow that cannot parse] — a top-level key declared twice is a workflow GitHub Actions rejects- and the realistic way one appears is the correction this issue is about

### A report that was accurate and still misled (#482)

The job-preserving merge carried a consumer's non-`jobs:` top-level keys
forward and appended them BELOW `jobs:`, while the comment introducing them
stayed where it was. YAML top-level keys are order-independent, so the file
meant what it meant, and `lostLines` was correct to stay quiet: **nothing was
lost.**

What moved was the evidence. On a real consumer a reader saw

```yaml
# When multiple pushes to main land quickly, cancel in-progress runs
jobs:
  test:
```

concluded the `concurrency:` block had been deleted, and restored it by hand.
The original was still there, 460 lines down. The committed result declared
`concurrency:` twice and stopped parsing — `Map keys must be unique at line
493` — so GitHub Actions rejected the workflow.

The harness lost nothing and produced a diff whose most natural reading is
that it lost something, and the correction broke the file. **That is worse
than the deletion would have been, because a deletion fails loudly.** The
report said `UPDATED`, 0 refusals, jobs preserved — every word true, every
word about the dimension that did not change.

`.claude/rules/checks-must-be-able-to-fail.md` is about checks that cannot
fail. This is the neighbour: a report that cannot be wrong and still cannot be
relied on, because "nothing was lost" and "everything is where you left it"
are different claims and only the first was being made.

**The fix is not a better report.** The merge now walks the CONSUMER's
sections rather than the generated ones, so the consumer's order is the order
and the comment never detaches. Movement is then not news — it is a bug in
the merge — so it REFUSES rather than warning. The asymmetry is the argument:
a consumer who hits an unenumerated edge case gets a named refusal and
`--force`, and a consumer who does not get one gets a file they will misread.
Measured against this repo's three real workflows, including `release.yml`,
whose `permissions:` sits between `on:` and `jobs:` and is exactly the shape
that used to move: zero movement in all three.

A second refusal covers the correction itself: a top-level key declared twice,
in the existing file or in the merged output, is a workflow that will not run,
and the next re-scaffold is the first thing that can say so.

What was broken to prove it, predicted before the battery and measured after,
over `test/managed-workflow-key-order.test.ts` (14 tests):

| Mutation | Predicted | Red |
|---|---|---|
| consumer-only keys pushed back to the end — the defect verbatim | 5 | 5 |
| `duplicateTopLevelKeys` short-circuited to `return []` | 3 | 3 |
| `movedTopLevelKeys` short-circuited to `return []` | 1 | 1 |
| movement compared by line index instead of rank | 1 | **2** |
| the movement refusal removed | 0 | **0** |
| the two above together — what the refusal is worth | 4 | 4 |

None is left in the tree; all were run and reverted.

Three rows need reading rather than counting.

**The line-index row came back 2, not 1** — higher than predicted, which is
not the fourth shape but is worth knowing why. The expected red was the
inserted-key case. The second was the real-workflows case: merging `ci.yml`
with a short stub replaces the harness's long managed banner, every
subsequent key's line number shifts, and a line-index comparison reports all
of them as moved. Rank reports none. The design is right for a reason that
only showed up on real files.

**Removing the movement refusal is 0 red on its own, and that is the honest
number.** With the merge correct, nothing moves, so deleting the tripwire
changes nothing — which by this repo's standard makes it indistinguishable
from decoration. The last row is what answers that: with the merge regressed,
the refusal is worth exactly one test. Its proof is the mutation, not a
fixture, and that is the only form available for a guard whose job is to
catch a future regression in the code beside it.

**One process note, because it cost real work.** The battery reverts with
`git checkout --`, and the first thing the loop does is revert. Uncommitted
edits in the mutated files are destroyed before the first mutation runs, and
every measured number then describes the committed tree rather than the one
being predicted for. That is how this battery's first run produced a
confident-looking 3-of-5 miss that meant nothing. Commit, then mutate.

### The argument no unit test chooses the way a user does (#481)

`bunx rungate scaffold . --fix` threw on every repo-root owned file. The same
command with an absolute root completed cleanly.

```ts
const dir = filePath.substring(0, filePath.lastIndexOf("/"));
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
```

`"project-state.json".lastIndexOf("/")` is -1; `substring` **clamps a negative
end to zero**, so the directory to create is `""`; `existsSync("")` is false,
so the guard admits it; `mkdirSync("")` throws ENOENT. The fix is `dirname`.

Three things about this are worth more than the one-line fix.

**The rehearsal could not have caught it, and said nothing about that.**
`scripts/scaffold-project.ts:97` hands the steps `rehearsal.dir`, which comes
from `mkdtemp` and is therefore always absolute. The audit takes the
absolute branch no matter what the operator typed, so it printed
`CREATED: project-state.json` for a write that threw seconds later under
`--fix`. That is not a bug in the rehearsal — a rehearsal has to run somewhere
else or it is not a rehearsal. It is something the notice has to SAY, and
SC-1666 makes it say it. Generalised: **anything the real invocation controls
and the rehearsal substitutes is invisible to the rehearsal by construction**,
and the form of the root argument is the obvious member of that set.

**The fixture needs a spec carrying an SC, and finding that out is half the
work.** `generateProjectState` SKIPs a project with no SCs — "SKIP:
PROJECT-STATE.md (no SCs found in specs)" — so a fixture without one never
reaches the write and the crash does not reproduce. The first version of the
test was green against a broken tree for exactly that reason.

**A prediction missed, and the miss was the fourth shape.** Replacing
`dirname(filePath)` with the constant `"."` was predicted to turn 5 of 7 red.
It turned 1. The scaffold never depends on that `mkdir`: every directory it
writes into has already been made by an earlier step, which is what
`CREATED: .claude/agents/` and `CREATED: .claude/rungate/` in its own output
are. The directory-making step and the write's own fallback are two deciders
answering one question, and no end-to-end case can tell them apart.

They are kept apart rather than collapsed — the fallback is one line and
protects a future caller that has no directory-making step — so the rule's
second option applies, and its condition with it: the input only the fallback
can reach is written down as a case with a comment saying which decider it is
for. Without that, the next person to simplify deletes a line that has a test
and watches it stay green.

What was broken to prove it, predicted before the battery and measured after,
over `test/scaffold-relative-root.test.ts` (7 tests):

| Mutation | Predicted | Red |
|---|---|---|
| `dirname` reverted to the clamping slice — the defect verbatim | 4 | 4 |
| `dirname` replaced by the constant `"."` | 5 | **1** |
| the `Root SUBSTITUTED` sentence removed from the notice | 1 | 1 |
| the notice names the clone on both sides of the substitution | 1 | 1 |
| the fixture loses its SC-bearing spec | 1 | 1 |

None is left in the tree; all were run and reverted. The last row is worth
reading: a fixture that loses its SC is caught by ONE test — "the repo-root
owned files are actually on disk afterwards" — and neither SC-1664 nor
SC-1665 notices. An exit code and a tree comparison are both satisfied by a
scaffold that correctly skipped the file that crashes.

### What was broken to prove it (SC-1641..1646)

Run over `test/external-adoption.test.ts` — 20 tests, baseline 0 fail. Every
count predicted before the battery ran.

| Mutation | Red |
|---|---|
| `matchesAnyAlias` back to substring — the `oddball` case | 1 of 20 |
| aliases back to the directory name only — defect 3, verbatim | 5 of 20 |
| the git remote never consulted | 1 of 20 |
| the minimum-length floor removed | 1 of 20 |
| a missing declared path is skipped again — fail-open 1 | 2 of 20 |
| an unreadable file is a non-match again — fail-open 2 | 2 of 20 |
| `expandHome` back to an unanchored replace | 1 of 20 |
| the scaffold step reports nothing for an empty list | 1 of 20 |
| the scaffold step proposes nothing | 1 of 20 |
| the step is exported and never invoked — defect 1, verbatim | 1 of 20 |
| the scaffold step APPLIES instead of proposing | 1 of 20 |
| the no-match line stops naming the aliases | 1 of 20 |

None of the twelve is left in the tree; all were run and reverted.

**Four rows differed, all of them prediction errors and three of them the
same one.** Counting ASSERTIONS rather than TESTS: several failing
expectations inside one `test()` are one red row, not three. That mistake
has now been made on #440, #441 and #442 in a row, so it is recorded here as
a standing note rather than a third footnote — **predict by test, not by
assertion**. The fourth was an over-count on the git-remote row, where only
one test asserts the derivation and the `remoteSlug` unit test exercises the
parser directly rather than its consultation.

**One row is worth reading as a measurement rather than a check.** Dropping
configured aliases measures 5, not 4, and the extra row is the "names which
aliases it tried" case — a scan that matched nothing stops being
diagnosable the moment the alias list is wrong, which is precisely the
failure mode that kept this feature dark for its whole life.

### The guard that caught this, and the two holes in it

Adding report verbs turned `SC-1512: every write verb the scaffold emits is
in WRITE_VERBS` red, which is the guard doing its job: `postScaffoldCommit`
stages by verb, so a verb in neither the write list nor the non-write list
is generated output nobody commits. `PROPOSED`, `UNMEASURED` and `OK` are
all absences of a write and were classified as such.

Then the planted-verb mutation came back **0 where 1 was predicted**, twice,
and the reason was not the mutation. The detector was
`/actions\.push\([`"']([A-Z]{3,12}): /g`, and it was narrower than what it
detects in two independent ways:

- `{3,12}` could not see a **two-letter** verb at all.
- requiring the quote IMMEDIATELY after `push(` could not see a
  **multi-line** push — which is how every long report line in this file is
  written, including the one this issue added. The suite went green over a
  verb in neither list for exactly that reason.

Widening it to `/actions\.push\(\s*[`"']([A-Z]{2,12}): /g` surfaced
**`PRESERVED`**, emitted from two sites in `lib/scaffold/steps.ts` since
long before this issue and in neither list the whole time. It announces a
file deliberately not overwritten, so it is a non-write and needs no
staging — but nothing could have told you that, because nothing could see
it.

| Mutation | Red |
|---|---|
| a multi-line push whose verb is in neither list | 1 of 17 |
| the same verb, detector back to quote-adjacent | **0 of 17** — the hole, measured |
| a two-letter verb in neither list | 1 of 17 |
| the same two-letter verb, detector back at `{3,12}` | **0 of 17** — the other hole |
| `PRESERVED` removed from the non-write list | 1 of 17 |

The two zeros are deliberate rows. They are the old detector, reinstated
over a planted verb, failing to notice — which is the only way to show that
widening it bought something rather than being tidying.

## #478 — the scaffold test's budget was raised once and outgrew the raise

`test/unit/scaffold-project.test.ts` spawns a real
`bun scripts/scaffold-project.ts` in 32 places. On 2026-10-13 one case died
at **5007ms** — bun's default, a third of what the helper itself declared the
operation may take. #454 set `SCAFFOLD_TIMEOUT_MS = 15_000`, asserted that
the test ceiling exceeds it, and recorded the reasoning in the file's header.

On 2026-10-16 the **same case, by name** died at **15007.04ms** — the new
budget, exactly — while a re-run of the same tree reported 0 fail and the
file passed 39/39 in isolation.

### Why not 30 seconds

Because that is the move that does not converge, and this repo has the
receipts: #445 guessed bigger rather than differently, and #407 widened a
window from 1 read to 10 and blew through it the next day. A constant
encodes one machine's speed on one afternoon. The runner's speed is the
variable, and a constant cannot see it.

**The budget is now a ratio to a calibration run taken on the machine the
suite is running on.** One scaffold is timed at module load — with `--fix`,
so the nested `bun` that generates CODE-MAP.md is included, which is 1.04s
of a 1.42s run — and every case gets `calibration × 10`. A loaded runner
makes the calibration slow too, so both numbers move together and the
verdict stops depending on how busy the box was.

`BUDGET_FLOOR_MS` is the one constant left and it is **not raised**: it is
still 15_000, now acting as a floor under the calibrated budget rather than
as the budget. Measured on this machine, calibration lands at 1210–1561ms, so
the budget comes out at 15000–15610ms and today's behaviour is unchanged.
That is the point — the mechanism changed and the number did not.

### An over-budget run did not observe anything

A case killed by its budget is not evidence the scaffold is broken. It is
the absence of evidence, and `0`, `SKIP`, `FAIL` and silence are
indistinguishable from each other while `UNMEASURED` is not.

`runScaffold` throws `ScaffoldUnmeasured` — a class, not a message prefix, so
an ordinary assertion failure mentioning a timeout still goes red — and the
file's own `test` wrapper converts exactly that into a recorded, named
UNMEASURED. The wrapper shadows the import rather than editing 39 call sites,
which keeps ONE binding deciding what a timeout means; a second copy would
survive any mutation of the first.

What stops that becoming a file that passes having measured nothing is the
coverage case declared last: it prints `measured N of M` with every
unmeasured case named, refuses when N is zero, and refuses when the census is
too small to be counting the file. One starved case on a busy runner is a
hiccup this file now survives and names; every case starved is an instrument
that stopped reporting.

The #454 ordering assertion — the test ceiling strictly exceeds the
scaffold's budget — survives verbatim. Only its derivation moved.

- [x] SC-1971: test/scaffold-budget.test.ts contains [a run killed by its budget is reported as unmeasured, with both numbers] — the starved path is reached with an injected 1ms budget, so it needs no contention to reproduce a condition that only appears under contention
- [x] SC-1972: test/scaffold-budget.test.ts contains [a run that finishes, and a run that fails on its merits, are both measured] — the two-sided positive control: a reading that called every non-success a timeout would satisfy the case above and silently convert every real scaffold failure into an UNMEASURED that passes
- [x] SC-1973: test/scaffold-budget.test.ts contains [the budget tracks the calibration, and never falls below the floor] — asserted as a function of its input over two calibrations, because a `scaffoldBudget` that ignored its argument and returned the floor is the old behaviour wearing the new mechanism's name
- [x] SC-1974: test/scaffold-budget.test.ts contains [the calibration measures a real scaffold, including its nested generator] — 73% of a scaffold is a second cold bun start, so a calibration that skipped `--fix` would time something no case does
- [x] SC-1975: test/scaffold-budget.test.ts contains [the census counts both outcomes and names the unmeasured ones] — by name and not by count, because a reader cannot act on "1 case was unmeasured"
- [x] SC-1976: test/scaffold-budget.test.ts contains [a calibration that was killed hands back the floor, not its ceiling times ten] — the branch is here because the DOCSTRING claimed it before the code did: multiplying a run killed at the ceiling computes a budget from the kill, and hands ten times the budget to exactly the machine that was already too slow
- [x] SC-1977: test/scaffold-budget.test.ts contains [the scaffold's two output streams are kept apart] — `execSync` gave callers stdout on the success path and `stderr || stdout` on the failure path, and merging them would let a `toContain` in any of 29 assertions be satisfied by a warning on stderr
- [x] SC-1978: test/unit/scaffold-project.test.ts contains [a deliberately starved case is recorded UNMEASURED instead of failing] — the wrapper's conversion branch exercised where it lives and failing in BOTH directions, because every other fixture in that file meets its budget and #492 is the shape where a battery measures nothing past a precondition they all satisfy

### What was broken to prove it (SC-1971..1978)

Run and counted over `test/scaffold-budget.test.ts` +
`test/unit/scaffold-project.test.ts` (49 tests, baseline 49 pass / 0 fail,
re-measured for every row after SC-1978 was added so the table has one
baseline). None is left in the tree; all were run and reverted.

| Mutation | Red | Predicted |
|---|---|---|
| `scaffoldBudget` ignores the calibration and returns the floor — the old behaviour, restored | 2 of 49 | 2 |
| `timedOut` hard-coded false — a killed run is never reported as one | 2 of 49 | 2 |
| `timedOut: !proc.success` — the cheap version, where any failed run is a timeout | 1 of 49 | 1 |
| `NOT observed` dropped from the UNMEASURED message | 1 of 49 | 1 |
| the census reports a count instead of naming the unmeasured case | 1 of 49 | 1 |
| the `test` wrapper stops converting `ScaffoldUnmeasured` | 1 of 49 | 1 |
| `runScaffold` stops raising on a killed run | 1 of 49 | 1 |

The last two rows are the reason SC-1978 exists. Measured before it was
added, both are **0** — not because the bindings are dead, but because every
fixture in that file meets its budget, so the branch they live on is
unreachable from the tree. That is #492's shape, and the response this file's
own rules prescribe is to build the one fixture that does not meet the
precondition rather than to record a zero.

#### The fix's own test file had the defect (#583, first CI run)

`test/scaffold-budget.test.ts` handed its spawns `budgetMs: 120_000` and left
the cases on bun's 5000ms default — the exact arrangement this issue exists
to remove, in the file written to remove it. Every local run passed, because
two scaffolds cost about 2.6s here. CI did not: **SC-1972 died at
5008.23ms.**

Worth a paragraph rather than a quiet correction, because of what it says
about the defect rather than about the mistake. A budget written as a
literal is wrong in a way its author cannot see from their own machine —
which is the whole argument for deriving one, made again by the person
making it. The file's budgets now come from `scaffoldTestTimeout`, so the
ordering SC-1973 asserts holds here by construction instead of by someone's
arithmetic.

One deliberate zero is kept and not fixed: deleting the sentence *"this is
the absence of a measurement, not a failing one"* from the UNMEASURED message
is **0 of 49**. The mutant and the original differ — on that substring — and
nothing asserts it, because it is explanatory prose beside three clauses that
are asserted (`UNMEASURED`, the budget, and `NOT observed`). Recorded rather
than padded: widening an assertion to cover prose would raise the number
without widening the question.

## #581 — the scaffold path fetched an undeclared tool from the npm registry

`scripts/generate-code-map.ts` spawned `npx fallow dead-code` with no check
that fallow was installed. It is an optional tool and **not a declared
dependency** — not in `package.json`, not in `node_modules/.bin`, not on
`PATH`, on a developer machine or on CI. So every invocation was a registry
fetch, on the **scaffold** path, once per consumer forever.

`lib/conformity.ts:2427` had already written the fix and the reason for it:

> When it is absent, `npx fallow` does a registry fetch on every invocation
> … Resolve it locally instead, with no network path.

and kept it to itself. One question, two answers, and the answer that
reaches consumers was the one that goes out to the network.

**That is the fourth shape with the copies behaving DIFFERENTLY, and no
mutation finds it.** `.claude/rules/checks-must-be-able-to-fail.md` describes
two deciders that AGREE, where a mutation of either leaves the other holding
the case up. Here they disagreed for four months: mutate the good copy and
the bad one carries on being bad, and every suite stays green because
nothing asserted the absence of a network call. The general form belongs
beside #484's: *when a guard enforces a property, ask what other syntax
expresses the same property* — and then ask **who else answers the same
question**, because a second answerer is not always a duplicate. Sometimes it
is the only one anybody runs.

### What it cost, measured rather than argued

PR #580 — three state files, no code — went red on `SC-1665`, whose
exclusion assertion demanded that **both** scaffold runs produced
`.fallow/cache.bin`. When the fetch fails it is produced by neither. Main
was green on identical code nine minutes earlier, which is what makes it a
flake rather than a finding, and a flake in a suite is a thing people learn
to re-run rather than read.

Reproduced deterministically with no repo change:

```
$ npm_config_registry=http://127.0.0.1:1/ bun test test/scaffold-relative-root.test.ts
error: .fallow/cache.bin is excluded but was not produced by both runs
 6 pass, 1 fail   [1045.80ms]
```

The timing confirms the mechanism: three green CI runs took 1543/2451/2045
ms for that case, the red one 1228 ms, and the offline repro 1046 ms —
because a failed `npx` returns long before a successful one.

### Three outcomes, not two

`runFallow()` returned `null` for "not installed", "the spawn failed", "the
output did not parse", and — through `fallow?.unusedFiles.length || "N/A"` —
"it ran and found zero". The CODE-MAP was byte-identical for all of them, so
a reader could not tell a project with no dead code from a project nobody
looked at. The map now carries a named `**UNMEASURED**` section and
UNMEASURED summary cells, with the two unavailable kinds carrying different
sentences because they have opposite fixes.

The exclusion in `SC-1665` is split the way this repo's rules ask: the half
it owns is asserted on every run (both-or-neither), and the half it does not
own reports UNMEASURED by name rather than failing over the npm registry.

- [x] SC-1979: test/code-map-fallow.test.ts contains [a project without fallow gets no npx invocation, and the proof is on disk] — `.fallow/` is created by fallow and nothing else, so its absence after a complete run is the observable fact that no fetch was attempted; asserting only the notice would pass over a generator that fetched, failed, and printed the right words
- [x] SC-1980: test/code-map-fallow.test.ts contains [the generated map says UNMEASURED rather than leaving the section out] — an omitted section and a section reporting nothing wrong are the same absence to a reader, and the reader of a CODE-MAP is an agent deciding whether this project has dead code
- [x] SC-1981: test/code-map-fallow.test.ts contains [not-installed and run-failed are different sentences] — a notice that said the same for both would send a reader to install a tool they already have, and the two have opposite fixes
- [x] SC-1982: test/code-map-fallow.test.ts contains [the conformity suite and the generator ask the same binding] — not "both answer the same today" but the SAME FUNCTION, because this pair spent four months disagreeing while every test passed
- [x] SC-1983: test/code-map-fallow.test.ts contains [no caller spawns fallow without resolving it first] — the source-level ratchet, and the only form that catches the NEXT caller; a test over the two files that exist today would not have caught this one either
- [x] SC-1984: test/code-map-fallow.test.ts contains [a tool's own words cannot write markdown into the document agents read] — the run-failed reason quotes what fallow printed and that string lands in CODE-MAP.md, which every agent is told to read; one line, an allowlist and a cap, with the positive control that an ordinary tool error survives intact

### What was broken to prove it (SC-1979..1984)

Run and counted over `test/code-map-fallow.test.ts` +
`test/scaffold-relative-root.test.ts` (12 tests, baseline 12 pass / 0 fail).
None is left in the tree; all were run and reverted.

| Mutation | Red | Predicted |
|---|---|---|
| the availability check removed — the bare `npx` restored | 3 of 12 | 3 |
| a summary cell back to `fallow?.unusedFiles.length \|\| "N/A"` | 1 of 12 | 1 |
| `lib/conformity.ts` declares its own copy instead of re-exporting | 1 of 12 | 1 |
| `SC-1665`'s exclusion back to demanding BOTH runs produced the file | 1 of 12 | 1 |
| `not-installed` stops saying no fetch was attempted | 2 of 12 | 2 |
| `safeToolDetail` returns its input unchanged | 1 of 13 | 1 |

The last row has a different denominator because it was measured after
SC-1984 was added; the five above it were measured over the 12 tests that
existed when they were run, and are not re-stated as 13 without being
re-run.

#### A finding the fix introduced, caught by the review of its own commit

The `run-failed` reason quotes what fallow printed, and that string is
written into `CODE-MAP.md` — the document `.claude/rules/key-files.md` tells
every agent to read to understand the codebase. fallow's error text can
quote the repo's own file names and contents, so the first version of this
fix piped untrusted output straight into a trusted document: `## Hard
Constraints` in a tool's stderr would have become a heading in the
consumer's code map.

`safeToolDetail` takes the first line, passes it through an **allowlist**,
and caps it. An allowlist rather than a denylist of markdown syntax,
because a denylist is a detector narrower than what it detects — and the
useful content of an ordinary tool error survives an allowlist intact,
which is the positive control in SC-1984. A run of disallowed characters
collapses to one `?` rather than one each, so a detail that was entirely
unprintable reads `(no printable detail)` instead of `????????`.

#### …and a second one, caught by CI: removing the fetch broke #478's floor

`SC-1974` asserts that the calibration measured a real scaffold rather than
nothing, and it asserted it as `expect(cal.elapsedMs).toBeGreaterThan(100)`.
That passed everywhere until this change, and then CI went red at **48ms**
— `cal.ok` true, exit 0, the scaffold genuinely complete.

The 100 was never a fact about scaffolds. It was a fact about scaffolds
**that fetch fallow from the npm registry**, which is what every scaffold
did when the number was written: CI's calibration had been reporting
1279ms, and 1231ms of that was the failing `npx`. Removing the fetch — the
entire point of #581 — moved the real measurement below the floor derived
from the fetch.

So a constant threshold about machine speed, written down **inside the
issue whose whole subject is constant thresholds about machine speed**, and
written by the author of that issue. #445 and #407 are in this repo's
history for the same move; #478's own docstring says *"a constant encodes
one machine's speed on one afternoon"*. It is recorded rather than quietly
corrected for the same reason the 5008.23ms failure above it is: a literal
is wrong in a way its author cannot see from their own machine, and that
blindness does not lift because the author happens to be writing about it.

**The cheapest repair is to lower the 100**, and
`.claude/rules/checks-must-be-able-to-fail.md`'s fifth shape is exactly
about what that buys: the case goes green while certifying a budget derived
from a run nobody has established is a scaffold. Any number low enough to
pass on a fast runner is also low enough to pass on a calibration that did
nothing.

The floor is now measured on the machine asking the question — a bare `bun
-e ""` spawn, taken in the case — because a scaffold is at minimum a bun
start, and a reading below one did not time a scaffold. A faster runner
moves both numbers together, which is the same argument that produced
`BUDGET_MULTIPLE` one issue earlier.
