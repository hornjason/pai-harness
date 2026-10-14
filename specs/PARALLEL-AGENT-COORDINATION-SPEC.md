---
doc-type: spec
status: draft
owner: jason
created: 2026-09-22
updated: 2026-10-14
governs: Parallel agent coordination — file-claim manifests and module-boundary decomposition to prevent merge conflicts in multi-agent AFK work
testable: true
compliance: strict
---

# Parallel Agent Coordination

## Problem Statement

When multiple agents work in parallel on independent issues, they may modify the same files — producing merge conflicts that waste agent work or silently break code. Session 2026-09-22 demonstrated this: Streams A (#560) and B (#559) both modified `ship.js` and `prove.js` independently. The merge succeeded because the designs converged, but divergent changes would have discarded one agent's work entirely.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | File-claim manifest: agents declare target files before starting | Catches overlap at schedule time, not merge time. Cheap pre-flight vs expensive rework |
| D-2 | Module-boundary decomposition: wave planning must check file overlap | Prevention > detection. If two issues touch the same file, they serialize, not parallelize |
| D-3 | Claim granularity is file-level, not line-level | Line-level is fragile (refactors shift lines). File-level is conservative but safe |
| D-4 | Overlap = serialize, not block | Both issues still ship — just not in the same wave. No work is lost |

## Target State

Before launching a wave of parallel agents, a pre-flight check:
1. Each issue's target files are predicted (from spec `governs`, CODE-MAP, or explicit declaration)
2. File sets are compared pairwise across all issues in the wave
3. Overlapping issues are moved to the next wave (serialized)
4. Agents receive their file-claim manifest — they WARN if they touch unclaimed files

Post-wave, an integration check verifies no unclaimed file modifications slipped through.

## Success Criteria

- SC-410: Wave planner predicts target files per issue before agent launch
- SC-411: Pairwise file overlap check runs before wave launch — overlapping issues serialize
- SC-412: Agents receive file-claim manifest in their prompt
- SC-413: Post-wave integration check detects unclaimed file modifications
- SC-414: Module-boundary decomposition rules documented — issue authors check file overlap at creation time
- SC-415: Wave planner uses CODE-MAP.md module boundaries for file prediction when no explicit claim exists

## Implementation Status

| SC | State | Where |
|---|---|---|
| SC-410 | Not started | — |
| SC-411 | Partial — holds within a single issue's sub-issue decomposition, not yet across a wave of issues | `workflows/ship.js` `runDecomposedShip()`; `test/decomposed-ship-dispatch.test.ts` |
| SC-412 | Partial — sub-issue agents receive an explicit "modify ONLY these" file list | `workflows/ship.js` `runDecomposedShip()` |
| SC-413 | Done — the claim travels back with each agent's result and the collection is refused when a worktree reports a file it did not claim, and the six refusals it can emit are pairwise distinguishable | `workflows/ship.js` `auditWorktreeClaims()` (COLLECT-CLAIM block), `collectAgentWork()`; `test/collect-claim-enforcement.test.ts`, `test/collect-claim-ownership.test.ts`, `test/claim-refusal-kinds.test.ts` |
| SC-414 | Not started | — |
| SC-415 | Not started | — |

Issue #66 fixed the disjoint-dispatch path: `runDecomposedShip()` computed the D-2
overlap check and then serialized both branches anyway, while logging that it had
dispatched in parallel. Disjoint sub-issues now run concurrently, and a failing
sub-issue reports its completed siblings rather than discarding them (D-4).

Issue #178 closed SC-413. On run wf_2b3ff032-a4b three of four worktrees modified
`workflows/ship.js`; the claims were correct and disjoint, so SC-411 had nothing to
catch, and SC-412's manifest reached the agents as prose that nothing afterwards
compared the replies against. `claimedFiles` now travels back beside each agent's
`filesChanged`, `auditWorktreeClaims()` refuses any worktree reporting a path it did
not claim — naming the worktree, the path and the claimant — and the groups handed to
the collector are pruned to claimed files, so a contested file can only ever be
written from its claimant's worktree. A missing claim means no claim was issued (the
single-agent and remediation paths) and is unconstrained, except that it still cannot
take a file another worktree claimed.

Still open: nothing coordinates *across* issues or across concurrent human-driven
sessions. That is issue #23.

## A refusal an operator cannot classify (#300, 2026-10-14)

#296 gave `auditWorktreeClaims` three ownership answers and each of them got
its own sentence. Nothing checked that the sentences stay different, and the
sentence is the entire interface. A run dies, the DA reads one line, and what
it does next depends on which kind it was: merge two edits of a shared
registry, write a DA-owned file itself, or send the agent back for exceeding
its scope. Three refusals that read alike cost the same ~75 minutes whichever
one it actually was.

Three properties the test had to get right, and the first two are the ones a
naive version gets wrong:

- **Distinctness is on the SHAPE, not the string.** Every refusal interpolates
  the worktree and the path, so two kinds reported against different files
  differ as strings no matter how identical the wording is. Comparing them raw
  certifies a guard that says `wf_a reported X, which it did not claim` for all
  three. The substituted values are blanked and the comparison runs on what is
  left.
- **Pairwise, and containment as well as equality.** Three `toContain` checks
  that each pass against one generic string is the vacuous assertion
  `.claude/rules/checks-must-be-able-to-fail.md` names. Equality is also not
  the only collapse: if one shape is a substring of another, every `toContain`
  written against the shorter one passes for both.
- **The table is tied to the source.** A per-kind loop only makes a new kind
  impossible to add silently if something counts. Two readings, because either
  alone has a hole — a new push site with a reworded message leaves the
  template count unchanged, and a new arm of an existing ternary leaves the
  push-site count unchanged.

The table grew from the three kinds #300 names to the **six** the block can
actually emit: boundary escape, DA-owned, co-owned conflict, multiple
claimants, and the two arms of out-of-scope unclaimed. Covering what the guard
emits rather than what the issue remembered is the point of counting; the
three named kinds are still asserted by name so the growth cannot drop one.

The out-of-scope wording is pinned by #296 and is asserted verbatim here, so a
later distinctness fix cannot buy green by rewording the message another
criterion holds fixed.

- [x] SC-1432: test/claim-refusal-kinds.test.ts contains [the table covers every refusal the block can emit] — the row count is tied to two readings of the source so a kind added with a reworded message and a kind added as a new ternary arm both fail rather than going uncovered
- [x] SC-1433: test/claim-refusal-kinds.test.ts contains [no two kinds share a message shape] — distinctness is compared pairwise with the worktree and the path blanked out because every refusal interpolates both and two kinds against different files differ as strings however identical the wording
- [x] SC-1434: test/claim-refusal-kinds.test.ts contains [each kind's discriminator appears in exactly one kind's message] — the property an operator uses is that one grepped phrase identifies one kind and a per-kind toContain can never see a token that matches two
- [x] SC-1435: test/claim-refusal-kinds.test.ts contains [could not build the mutant: the co-owned template appears] — the collapse the criterion forbids is performed on a copy of the block and observed so a distinctness check that reads something else is caught and a template that moves aborts instead of no-opping

### What was broken to prove it (SC-1432..1435)

Run and counted over `test/claim-refusal-kinds.test.ts` (21 tests). None is
left in the tree; all were applied and reverted, and every mutation asserted
its target appeared exactly once before writing:

| Mutation | Red |
|---|---|
| the co-owned message replaced by the generic unclaimed one — the defect SC-5 names | 10 of 21 |
| the DA-owned message replaced by the generic unclaimed one | 5 of 21 |
| every refusal rewritten to the one generic sentence | 15 of 21 |
| the co-owned refusal stops naming the worktrees that wrote it | 5 of 21 |
| the pinned out-of-scope wording reworded | 3 of 21 |
| the DA-owned refusal keeps its class but loses its remedy | 1 of 21 |
| a seventh refusal template added with no row in the table | 1 of 21 |

The last two are one apiece by design and are reported rather than hidden:
each is a single named property, and a mutation that turned several tests red
would mean the table's rows were not independent.
