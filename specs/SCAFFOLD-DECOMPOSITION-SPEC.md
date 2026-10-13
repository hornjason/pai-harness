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
