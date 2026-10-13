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
