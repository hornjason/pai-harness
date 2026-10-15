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

- [ ] SC-1479: lib/typescript-project.ts contains [tsconfigVerdict] — ONE predicate answers "does this project need a tsconfig.json". It returns a reason rather than a boolean, because a check that skips has to be able to say what it skipped over
- [ ] SC-1480: lib/conformity.ts contains [tsconfigVerdict] — TSC-1 fails for a project with TypeScript source and no tsconfig and records a WARN finding for a project with neither. Both arms are EXECUTED under a spawned `bun test`: a direct call cannot tell a conditional check from one whose assertion never ran
- [ ] SC-1481: lib/typescript-project.ts contains [typecheckDecision] — one ladder produces the CI step the AGENTS.md row and `dev.typeCheck`. A project's own `scripts.typecheck` wins which is the only branch a consumer can reach; `dev.typeCheck` is null rather than a command the verify gate can only fail
- [ ] SC-1482: scripts/typecheck.ts contains [node_modules] — the ratchet spawns the pinned compiler and REFUSES when it is absent rather than falling back to whatever the registry resolves
- [ ] SC-1483: test/typescript-project.test.ts contains [SOURCE_DIR_DECIDERS] — the singleton is MECHANICAL. It scans lib/ for a second definition of the predicate or the directory list and proves the scan sees a planted one rather than passing over an empty result

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
