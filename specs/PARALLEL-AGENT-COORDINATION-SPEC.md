---
doc-type: spec
status: draft
owner: jason
created: 2026-09-22
updated: 2026-10-18
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
| SC-413 | Done — the claim travels back with each agent's result on BOTH staging paths (the end-of-run collection and the between-waves one), paired to its result by the single `claimedWork()` binding, the collection is refused when a worktree reports a file it did not claim, and the six refusals it can emit are pairwise distinguishable | `workflows/ship.js` `claimedWork()`, `auditWorktreeClaims()` (COLLECT-CLAIM block), `collectAgentWork()`; `test/collect-claim-enforcement.test.ts`, `test/collect-claim-ownership.test.ts`, `test/claim-refusal-kinds.test.ts`, `test/wave-claim-propagation.test.ts` |
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

## Two validators answered "is this path safe" and agreed only on traversal (#400, 2026-10-15)

Found while verifying SC-3 of #229 before ticking it. SC-3 is satisfied as
written — it asks about *traversal* rejection, and on traversal the two
agreed. The rest of the divergence is this section.

`workflows/ship.js` carried two answers to one question, in two phases:

| | shape | input | checked |
|---|---|---|---|
| `validateFilePaths` | regex set | the raw reported string | STAGING, by `buildSafeGitAdd` |
| `escapesWorktree` | segment walk | a `claimKey`-normalised key | COLLECTION, by `auditWorktreeClaims` |

So the audit accepted a reported path carrying a shell metacharacter, a null
byte, or 500+ characters, reported the run clean, and staging refused it
afterwards — late, in a different phase, with a different message. Nobody was
misled while staging still refused; the cost is that the audit's verdict could
not be relied on, and the next caller to trust it instead of re-validating
inherits the hole. A guard that refuses less than the thing downstream of it
is a guard whose pass means less than it reads.

There is now one table, `CONTRIBUTABLE_PATH_RULES`, and one decider,
`pathRefusal`, in the SECURITY-HELPERS block — the half mirrored by
`lib/workflow-security.ts`, so the mirror keeps covering it. `escapesWorktree`
is gone: it was a second copy of two of that table's rules, and a second copy
survives any mutation of the first.

Three things this had to get right, and the first is the one a naive version
gets wrong:

- **Parity alone is vacuous once the predicate is shared.** With both phases
  calling one decider, removing a rule makes them permissive *together* and a
  pure parity assertion stays green. So every corpus row carries a LITERAL
  expected verdict, written out by hand and derived from nothing, and is
  asserted three times: staging against the literal, the audit against the
  literal, and the two against each other. That is the "red in both
  directions" SC-1535 asks for. It is also #397's and #399's lesson a third
  time — a test parameterised by the thing it checks cannot check it.
- **The corpus is compared on KEYS, not on raw reports.** `claimKey` strips
  the worktree prefix before the audit looks, so `/tmp/wt-a/lib/a.ts` is
  absolute to staging and relative to the audit. That divergence is correct
  and by design (`relativizePaths` exists for it), and comparing those two
  would fail for a reason this is not about. Every row asserts
  `claimKey(wt, p) === p` first, so a row that normalises is caught as a
  corpus bug rather than discovered as a confusing failure.
- **The refusal says which rule, and whether the path is even outside.**
  "not inside its own worktree" is a wrong sentence to print about
  `lib/a;rm.ts`, and an operator who reads it goes looking for a path that is
  not there. The table's second column is `boundary`, and the two refusals it
  selects are a seventh and distinct kind in `test/claim-refusal-kinds.test.ts`.

The two traversal rules are deliberately both present and deliberately
separate. `p.split('/').includes('..')` is the real boundary question; the
regex `/\.\.($|[/\\])/` also matches a segment merely ENDING in `..`
(`lib/foo..`), a legal filename that staging has always refused. Folding it
into the boundary rule would label a legal file an escape; dropping it would
make the audit permit something staging rejects, which is the whole defect.

- [x] SC-1530: test/claim-path-safety-parity.test.ts contains [the corpus is canonical, so the two phases see one string] — every row asserts claimKey leaves it alone, because the audit checks a normalised key and staging checks the raw string and a row that normalises would compare two different strings
- [x] SC-1531: test/claim-path-safety-parity.test.ts contains [staging and the audit refuse the same paths] — one corpus, three assertions per row, two of them against a hand-written literal so a shared predicate that stopped refusing cannot satisfy the parity by making both sides permissive together
- [x] SC-1532: test/claim-path-safety-parity.test.ts contains [a refused path is told which rule refused it] — the refusal names the rule and distinguishes outside-the-worktree from inside-and-unstageable, asserted in both directions so neither sentence can be printed about the other's paths
- [x] SC-1533: test/claim-path-safety-parity.test.ts contains [one predicate, reached by both phases] — the table and the decider are each declared exactly once and the collection block is read for a call into the security block, because a second copy would survive any mutation of the first and the parity would go green for the wrong reason
- [x] SC-1534: test/claim-refusal-kinds.test.ts contains [unsafe but inside the worktree] — the new refusal is a seventh row in the kinds table, so it inherits the pairwise distinctness, containment and discriminator checks #300 built rather than being asserted on its own
- [x] SC-1535: test/workflow-security-integration.test.ts contains [pathRefusal parity] — the inlined decider is driven against the library's over the same corpus, because ship.js cannot import (#69) and a drift in the copy is now a drift in what the audit permits, not only in what staging refuses

### What was broken to prove it (SC-1530..1535)

Run and counted over `test/claim-path-safety-parity.test.ts`,
`test/claim-refusal-kinds.test.ts`, `test/collect-claim-enforcement.test.ts`,
`test/collect-claim-ownership.test.ts`, `test/ship-remediation-commits.test.ts`
and `test/workflow-security-integration.test.ts` (290 tests). None is left in
the tree; all were applied and reverted, and every mutation asserted its
target appeared exactly once before writing.

| Mutation | Red |
|---|---|
| `pathRefusal` refuses nothing | 68 of 290 |
| the audit asks its own narrower question again — #400 restored verbatim | 32 of 290 |
| the shell-metacharacter rule dropped | 28 of 290 |
| the absolute-path boundary rule dropped | 17 of 290 |
| the `..`-segment boundary rule dropped | 9 of 290 |
| the null-byte rule dropped | 7 of 290 |
| the 500-character rule dropped | 7 of 290 |
| the segment-ending-in-`..` rule dropped | 6 of 290 |
| the absolute rule stops being a boundary | 6 of 290 |
| the library mirror drops the shell-metacharacter rule | 6 of 290 |
| both audit refusals collapsed to the boundary sentence | 4 of 290 |
| the library mirror drops the 500-character rule | 2 of 290 |
| `validateFilePaths` in the library keeps its own rule chain | 1 of 290 |

Each rule-dropping row is red on **both** sides — the staging assertion and
the audit assertion for every corpus path that rule covered, plus the mirror
case. That is SC-1535's "both directions", and it is only measurable because
the expected verdicts are literals: had they been read from the predicate,
every one of those rows would be a zero.

The last row is the one worth reading. It is this issue's own defect, met
inside this issue's fix: the first draft added the table and the decider to
`lib/workflow-security.ts` and left `validateFilePaths` *there* still running
its original regex chain, so the file whose subject is "there was more than
one decider" shipped with two. No test could see it — the chain and the table
agreed on every corpus row, so the ship-versus-library parity stayed green.
It surfaced only because the mirror's 500-character mutation scored 1 where
the model predicted 2, and the gap was chased rather than written down. The
guard added for it is a source property, because a behavioural one cannot
exist: two deciders that agree are behaviourally one.

## SC-413's claim never reached the wave staging path (#627, 2026-10-18)

There are TWO places a decomposition stages agent output, and they were
written three months apart.

| | when | what it hands `collectAgentWork()` |
|---|---|---|
| end-of-run | after every wave, before the commit | `agentResults` — one row per completed sub-issue |
| between waves | `integrateWave()`, so wave N+1's worktrees contain wave N | one row per accepted result in the wave |

#178 closed SC-413 on the first of them. #420 added the second and handed it
the bare `buildResult`s, which carry `worktreePath`, `worktreeRepo` and
`filesChanged` and no claim at all. `auditWorktreeClaims()` reads a missing
`claimedFiles` as "no claim was issued", which is unconstrained only while
there is ONE participating worktree (#228). A wave worth parallelising has
two or more — so every file in it was claimed by nobody, every row was
refused, and the run died at the barrier with correct, non-overlapping work
loose in the worktrees it could no longer collect from.

The fix is **one binding, called by both paths**: `claimedWork()` in the
DECOMPOSED-SHIP block of `workflows/ship.js` pairs a sub-issue result's
`buildResult` with its own `subIssue.filesToModify` and returns the row shape
the collection boundary reads. The wave loop maps each accepted result
through it before calling `integrateWave()`, and both end-of-run branches —
the all-succeeded one and the partial-completion one — are
`completed.map(claimedWork)`.

**Do not add a second inline pairing.** That is what this issue is: two sites
building the same row are behaviourally one until they diverge, and nothing
can see the divergence until a wave dies of it. `test/wave-claim-propagation.test.ts`
asserts the binding is declared exactly once in `workflows/ship.js` and that
the inline expression appears nowhere — if a new staging path needs a claimed
row, call `claimedWork()` from it.

The fixture that proves it is a THREE sub-issue, two-wave decomposition
(`alpha` and `beta` in wave 1, `gamma` depending on both in wave 2) with
correct, disjoint claims. Two worktrees in wave 1 is the smallest shape in
which the claim is load-bearing: with one, `SINGLE_WORKTREE_EXEMPT` keeps
every file whether a claim travelled or not, and the case would reach its
assertion without the feature.

### What was broken to prove it

Run and counted over `test/wave-claim-propagation.test.ts`,
`test/wave-integration.test.ts`, `test/decomposed-ship-dispatch.test.ts`,
`test/collect-claim-enforcement.test.ts` and
`test/collect-claim-ownership.test.ts`. Baseline before any mutation:
**105 pass, 0 fail.** None is left in the tree; all were applied and
reverted, `workflows/ship.js` was confirmed byte-identical afterwards, and
the mutation the suite itself builds asserts its target appears exactly once
before writing.

| Mutation | Predicted | Red |
|---|---|---|
| the pairing line removed from `claimedWork()` — no claim on either path | 2 | **3 of 105** |
| the wave path reverted to `integrateWave(waveResults, …)` — the #420 defect verbatim | 2 | **2 of 105** |
| `claimedWork` renamed throughout | 3 | **3 of 105** |
| one end-of-run branch given back its inline pairing, the binding left in place | 2 | **2 of 105** |

The first row came back HIGH, and the extra red is about the mutated
behaviour rather than a broken mutant: "the inline pairing expression appears
nowhere" counts the `claimedFiles:` assignments and expects exactly ONE,
because zero means the binding has stopped pairing anything. The other three
rows are the three ways this defect can come back — the call site reverts,
the binding is renamed out from under a caller, or somebody adds a second
copy — and each is red in a different case.

The input on which mutant and original differ, named and run rather than
assumed: the two-wave fixture above. The original integrates wave 1 and the
run succeeds; every mutant that drops the claim refuses the wave with
*"`…/wt-alpha` reported lib/alpha.ts, which it did not claim — no worktree
claimed that file"*, and wave 2 never spawns.
