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
| SC-410 | Partial — the plan's union is compared against `discovery.filesToModify` before the first agent spawns, and a discovered file no sub-issue claims **refuses the parallel plan and falls back to single-agent implement** (#751, option 1 of the three the issue named). Chosen over auto-claiming, which hands work to an agent whose brief never mentions it and whose claim audit then passes while the allocation is wrong, and over warn-and-proceed, which is the status quo that spent 2h06m and 2.03M tokens on asaCommandCenter#1585 before SC-413 refused at Commit. An absent or empty discovery list is UNMEASURED and refuses too. Still partial: this is per-issue decomposition, not the cross-issue wave planner the criterion describes | `lib/plan-coverage.ts`; `workflows/ship.js` PLAN-COVERAGE block; `test/plan-coverage.test.ts` |
| SC-411 | Partial — holds within a single issue's sub-issue decomposition, not yet across a wave of issues | `workflows/ship.js` `runDecomposedShip()`; `test/decomposed-ship-dispatch.test.ts` |
| SC-412 | Partial — sub-issue agents receive an explicit "modify ONLY these" file list | `workflows/ship.js` `runDecomposedShip()` |
| SC-413 | Done — the claim travels back with each agent's result and the collection is refused when a worktree reports a file it did not claim, and the six refusals it can emit are pairwise distinguishable. Both staging paths pair the claim through one binding (#627) | `workflows/ship.js` `auditWorktreeClaims()` (COLLECT-CLAIM block), `claimedWorktreeRow()` (CLAIM-PAIRING block), `collectAgentWork()`; `test/collect-claim-enforcement.test.ts`, `test/collect-claim-ownership.test.ts`, `test/claim-refusal-kinds.test.ts`, `test/wave-claim-propagation.test.ts` |
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

## One staging path paired the claim and the other stripped it (#627, 2026-10-18)

#420 gave a decomposed run a SECOND place that stages agent output: the mid-run
wave commit, so wave N+1's worktrees branch from a checkout containing wave N.
Both it and the end-of-run collect go through `collectAgentWork`, and therefore
through `auditWorktreeClaims`. They did not hand it the same rows.

The audit compares what an agent REPORTED against what the plan CLAIMED, and
the claim is not on the `buildResult` — the agent was never asked to report it
back. It lives on the other half of the settled row, `subIssue.filesToModify`,
and only the pairing on the way back makes SC-412's prose manifest checkable.
The end-of-run path wrote that pairing out inline, twice. `integrateWave` wrote

    accepted.map(r => r && r.buildResult)

which drops `subIssue` on the floor. Every row then reached the audit with no
`claimedFiles`; a wave has more than one participating worktree by definition,
so `SINGLE_WORKTREE_EXEMPT` does not apply, and the fallthrough #296 removed is
gone. The audit's answer is *"no worktree claimed that file"* — for every file
in every worktree. **Every decomposition with a dependency barrier failed
collection, regardless of the work**, with correct and disjoint claims.

Three things this had to get right:

- **One binding, not two agreeing sites.** `claimedWorktreeRow` is declared
  once, in the CLAIM-PAIRING block, and both staging paths call it. Two sites
  that agree are behaviourally one decider
  (`.claude/rules/checks-must-be-able-to-fail.md`, the fourth shape): a
  mutation of either leaves the other holding every case up, and a third
  staging path added later gets written from whichever copy its author read —
  which is exactly how the wave path came to carry a strip instead.
- **The assertion is the CLAIM, not the verdict.** A refused collection can be
  made to succeed without propagating anything, by widening the audit until an
  absent claim permits everything. So every case reads the row list
  `collectAgentWork` was actually handed, and the battery below builds that
  cheap repair and watches the cases stay red under it (the fifth shape, named
  in advance rather than discovered).
- **The fixture is this run's own.** It mints a worktree tree under the OS temp
  directory and names no path from the run that found the bug. A fixture keyed
  on another run's filenames stops witnessing the moment those files move, and
  what is under test is the shape of the handover, not any file in it.

- [x] SC-2058: test/wave-claim-propagation.test.ts contains [the claim reaches the collector through wave integration] — a two-wave plan driven through the real dispatch loop, the real `integrateWave` and the real `collectAgentWork`, asserting the row list the collector was handed carries the plan's claim; the premise that a barrier actually formed is asserted first, so a single-wave plan cannot satisfy it by never integrating
- [x] SC-2059: test/wave-claim-propagation.test.ts contains [one binding pairs a result with its claim, and both staging paths call it] — declared exactly once, called once from the RUN-REF slice and twice from the DECOMPOSED-SHIP slice, with the inline pairing and the strip both counted at zero over the source with comments removed, because this issue's own docblock quotes the expression it replaced
- [x] SC-2060: test/wave-claim-propagation.test.ts contains [three worktrees integrate through a wave rather than the end-of-run collect] — three worktrees with correct, non-overlapping claims, integrated mid-run rather than at the end, asserted on both the rows handed to the collector and the pruned candidates read back off the collect prompt; the paired control is a worktree that exceeds its claim in the same shape, which must still be refused
- [x] SC-2061: test/wave-claim-propagation.test.ts contains [the claim-stripping mutant turns the regression red] — the defect restored verbatim in a copy of ship.js, the suite re-spawned against it, and the reds compared BY NAME; the baseline row is read first, because an empty baseline is an instrument that stopped reporting rather than a clean tree
- [x] SC-2062: test/wave-claim-propagation.test.ts contains [the widened claim guard does not buy the regression green] — the cheapest wrong fix, named before it was built: the claim strip plus a `claimPermits` widened to let an absent claim through. The symptom goes away and the cases stay red, which is the only thing that stops this file certifying the regression it exists to block
- [x] SC-2063: test/wave-claim-propagation.test.ts contains [the fixture is built in a temp tree and names no run's files] — the run id is assembled from parts so the assertion is not itself the occurrence it forbids

### What was broken to prove it (SC-2058..2063)

Run and counted over `test/wave-claim-propagation.test.ts`. The three cases
that spawn the battery skip inside a mutant child, so every row below is out
of 7. None of the mutations is left in the tree; both were applied to copies
under the OS temp directory and `workflows/ship.js` was never modified.

**Baseline, read before any mutation row: 7 pass, 0 fail, 3 skip.**

| Mutation | Predicted | Red |
|---|---|---|
| `claimedWorktreeRow` removed from the wave path — `accepted.map(r => r && r.buildResult)` restored | 2 | **3 of 7** |
| the same, plus `claimPermits` widened to `!Array.isArray(claims) \|\| claims.includes(key)` — the cheapest wrong fix | 2 | **4 of 7** |

The input on which mutant and original differ, named before either count was
believed (#485): a three-worktree wave carrying correct, disjoint claims. The
original hands the collector rows carrying `claimedFiles` and the wave
integrates; the first mutant hands it rows that have none, the audit reports
every file in every worktree unclaimed, and the collection is refused.

**Both rows came back HIGH, and in both cases the extra red is the real kind.**

The first row's third red is SC-2059, the source assertion — the mutant
reinstates the text that case counts at zero. It is about the mutated
behaviour, the file still parses, and the other four cases pass, so this is not
a crashing mutant; it is the source check and the behavioural check turning red
on one change, which is what a binding asserted two ways looks like.

The second row's fourth red is the one worth reading, because it is the whole
argument for writing the cheap fix down. Widening `claimPermits` does silence
the refusal — the collection succeeds again — and the case it breaks is
*"a worktree that exceeds its claim in a wave is still refused"*. So the 5pm
repair for this issue is measurably a disabling of SC-413 for every decomposed
run, and the cost of reaching for it is one MORE red test, not a green suite.

## A refusal with two opposite causes and one sentence (#629, 2026-10-19)

#627 restored the claim to the wave path. What it did not change is what the
audit SAYS when the claim is absent anyway, and `claimant === null` has two
causes that call for opposite next actions:

- **No participant issued a claim at all.** The pairing dropped it — #627's
  defect, or the next one shaped like it. The agent may have been perfectly in
  scope; nothing was ever compared. **Fix the caller.**
- **Participants did issue claims and this file is in none of them.** The
  comparison happened and the agent lost it. **Send the agent back.**

`workflows/ship.js:4402` documented the distinction and
`if (!wt || !Array.isArray(r.claimedFiles)) continue` implemented half of it:
rows with no claim were skipped when building the ownership map, and nothing
downstream remembered that NOBODY had contributed to it. Both ended at *"no
worktree claimed that file"*. An operator reading that line after #627's
failure mode spent the investigation on the agent, and the agent was fine.

Three things this had to get right:

- **The pinned sentence is kept, and the split adds an arm.** #296 SC-3 pins
  *"no worktree claimed that file"* and `test/claim-refusal-kinds.test.ts`
  asserts it by exact equality, so rewording it to make a distinctness problem
  go away is the specific failure that pin exists to catch. That sentence is
  TRUE of the narrower case — worktrees did claim, and none claimed this file
  — so the new arm sits beside it rather than replacing it. The battery below
  measures what the alternative would have cost: the cheapest wrong fix
  rewords it and is 10 red, three of them for that reason alone.
- **An empty claim array is an issued claim.** `claimedFiles: []` is a plan
  that named no files — a planning problem, not a relay one — and reading it
  as "no claim issued" would send an operator upstream after a bug that is not
  there. `Array.isArray` is the same reading `claimPermits` takes one function
  down, so the two cannot disagree about what a claim is.
- **The pair varies exactly one thing.** Two hand-written fixtures can differ
  in something nobody noticed, and then the comparison measures that instead
  of the dimension it names (#585). The second fixture is the first with
  `claimedFiles` deleted, the derivation is asserted before anything is
  concluded from it, and `SINGLE_WORKTREE_EXEMPT` is asserted still to exempt a
  lone agent — because a new refusal arm reachable for one worktree is #228
  reintroduced.

- [x] SC-2114: test/claim-refusal-kinds.test.ts contains [the no-claim arm points upstream and the other does not] — the two absent-claim causes produce distinguishable refusals naming opposite next actions, driven through the real block, with the kind matrix carrying both as separate rows so a third arm cannot be added without one
- [x] SC-2115: test/claim-refusal-kinds.test.ts contains [the pair varies only the presence of claims] — the two fixtures are one fixture and its derivation, asserted equal in every other field first, so the refusal difference can only be explained by the dimension the criterion names

### What was broken to prove it (SC-2114..2115)

Run and counted over `test/claim-refusal-kinds.test.ts`. Every count was
predicted before the battery ran, and **the baseline row was read first** — an
instrument that has stopped reporting takes the baseline down with it, and
that is the row nobody mutates anything to produce.

**Baseline, unmutated: 35 pass, 0 fail.**

| Mutation | Predicted | Red |
|---|---|---|
| the split removed — both causes back under one sentence (genuinely pre-#629) | 7 | **7 of 35** |
| `noClaimsIssued` inverted | 4 | **6 of 35** |
| any participant counts as a claim issuer, so the new arm is unreachable | 6 | **6 of 35** |
| the cheapest wrong fix: one message, with both possibilities appended to it | 7 | **10 of 35** |

**Before believing any of them, the input on which mutant and original
differ** (#485), named and run rather than assumed: two participating
worktrees reporting `gates/workflow.test.ts`, in one fixture carrying
`claimedFiles` and in the other with that key deleted and nothing else
changed. The original answers *"not one of the 2 worktrees in this run issued
a claim at all … Fix the caller"* for the second and *"no worktree claimed
that file"* for the first; row 1's mutant answers the latter for both.

**Two rows came back HIGH and in both the extra reds are the real kind** — the
mutants parse, most cases pass, and every extra red is about the mutated
behaviour.

Row 2's two extras are the sharper ones. Inverting the flag swaps which
fixture gets which sentence, so *"the two out-of-scope arms stay the wording
#296 SC-3 pinned"* goes red — the pin is precisely what a swap breaks. The
other is #300's own `SC-1435` mutant case, which replaces the co-owned
template with the generic sentence and asserts the two shapes collapse. That
case **depends on the unclaimed fixture producing the generic sentence**, and
the inversion moves it. That is a fact about this file worth writing down: it
is a second, independent argument for adding an arm rather than rewording the
pinned one, and it was not visible from the diff.

Row 4's three extras are the pin again plus both halves of `SC-1435`, whose
`loadMutant` can no longer find the generic template in the source and
**aborts loudly** rather than no-opping — the property a mutant builder exists
to have.

**The cheapest wrong fix, named and applied: keep one message and append the
explanation of both possibilities to it** — *"no worktree claimed that file
(either no claim was issued in this run, in which case the pairing dropped it
(#627), or this file is outside every claim)"*. It is the 5pm repair: the
operator is told both things, no branch is added, one string changes.

**The cases do not survive it: 10 of 35 red.** It leaves the two causes
indistinguishable by grep — which is the property an operator actually uses,
one phrase identifying one kind — and it rewords a sentence another criterion
holds fixed. An operator still cannot tell from the line which investigation
to open; they are told that it might be either, which is what they already
knew.

None of the four mutations is left in the tree; all were applied to
`workflows/ship.js`, run, reverted, and the file confirmed byte-identical
afterwards by checksum.

## A guard that could not tell divergence from agreement (#892, 2026-10-21)

#629 made the refusal say WHY the claim was absent. It still says nothing about
the bytes, and the audit decides on the claim ledger alone — so two situations
that call for opposite actions are indistinguishable:

- **Two worktrees edited a file differently and one did not claim it.** Taking
  either copy discards the other's edits. **Refuse.**
- **Two worktrees produced the SAME BYTES.** There is nothing to lose and
  nothing to choose between. **Collect.**

Run `wf_161c4e96-f01` — agentgrit #250, 24 agents, ~35 minutes, 0 errors — was
the second case. Three preserved branches whose overlapping files were
byte-identical, one a strict superset of the other two; nine files refused as
unclaimed; `SHIP_FAILED`; no PR.

### The three readings, and the one position that takes them

`compareClaimedFileContent` in `lib/claim-content.ts` is the only thing in this
repository that compares the two copies, and it answers exactly three ways:

| Reading | What it means | What the caller does |
|---|---|---|
| `IDENTICAL` | both copies hash the same | collect — there is no divergence to catch |
| `DIFFERENT` | the digests differ | refuse, naming the divergence |
| `UNMEASURED` | a copy could not be read, or a reader answered without answering | refuse, naming the path and the reason |

`UNMEASURED` is a first-class answer rather than a falsy `IDENTICAL`. A
comparison nobody could take is not a comparison that passed, and `0`, `{}`,
`null` and silence are all indistinguishable from success
(`.claude/rules/config-access.md`).

### The single-claimant arm is the only caller

The reading is asked in ONE arm of `auditWorktreeClaims` — the one reached when
a single other worktree claims the file and the reporting worktree is not it.
Every other arm refuses exactly as before, byte-identical copies or not:

- **DA-owned** (`project-state.json`, `PROJECT-STATE.md`, `SUCCESS.md`) — a
  shared state document is contested whatever the bytes say today (#296).
- **Co-owned registry written by more than one worktree** — collection copies
  whole files, so agreeing on one version is not agreement on the merge.
- **Path refusal** — `pathRefusal` is asked by staging and by the audit before
  this is ever reached (#400); a third asker would reinstate the defect #400
  removed.
- **Two or more claimants** — a scheduling failure SC-411 should have caught.
- **No claim issued at all** — #627's relay defect. Fix the caller; the bytes
  say nothing about whether the pairing dropped the claim.

Widening the content reading to any of those is the cheapest wrong fix
available here, and it is wrong in the direction that costs the most: it turns
a refusal into a silent collection.

### The terminal-reachable caller, and both refusal sentences

`workflows/ship.js` cannot import (#69), so the arm reaches the reading across
a subprocess boundary through `scripts/compare-claim-content.ts`, exactly as
`scripts/collect-worktree-files.ts` and `scripts/rook-review-scope.ts` do. It
prints one JSON body on stdout — `reading`, `collectable`, the comparison, and
the refusal — and the sentence on stderr.

A refusal that says only *"that file was unclaimed"* is the sentence this issue
exists to replace, so neither of these is allowed to be that:

**DIFFERENT** — names the divergence FROM THE CLAIMING WORKTREE'S COPY, both
worktree paths and the file path:

> REFUSED src/f.ts: the reporting worktree's copy DIVERGES IN CONTENT from the
> claiming worktree's copy — /wt-a/src/f.ts and /wt-b/src/f.ts are not the same
> bytes. This is a real content divergence, not merely a file that went
> unclaimed: collecting one copy would discard the other worktree's edits. Open
> the diff between those two paths (#892).

**UNMEASURED** — names the exact path that could not be read and the reader's
own reason, per side, and says the path is not collectable:

> REFUSED src/f.ts: the content comparison is UNMEASURED — the claiming copy at
> /wt-empty/src/f.ts could not be read: ENOENT: no such file or directory, open
> '/wt-empty/src/f.ts'. An unreadable comparison is not an identical one, so
> src/f.ts is NOT reported as collectable (#892).

Both carry `collectable: false` in the JSON body, and the UNMEASURED path is
never reported as collectable anywhere in the emission.

- [ ] SC-2440: scripts/compare-claim-content.ts contains [the comparison is called once here and declared nowhere here] — the script calls the one binding from lib/claim-content.ts and declares no comparison of its own, so there is a single position in the tree that compares the bytes and a single thing to mutate
- [ ] SC-2441: scripts/compare-claim-content.ts contains [EXIT-CODE-CONSTANT] — every refusal exits through one exported exit-code constant, assigned on exactly one line, and the file's single process exit is handed that constant rather than a literal
- [ ] SC-2442: scripts/compare-claim-content.ts contains [DIVERGES IN CONTENT] — a DIFFERENT reading refuses naming the content divergence from the claiming worktree's copy, both worktree paths and the file path, and never only that the file was unclaimed
- [ ] SC-2443: scripts/compare-claim-content.ts contains [NOT reported as collectable] — an UNMEASURED reading refuses naming the exact path that could not be read and the reader's own reason, and that path is never reported collectable
- [ ] SC-2444: scripts/compare-claim-content.ts contains [the mutant (exit constant 0) does NOT refuse] — a mutant copy with the exit constant set to 0 is built and run beside the real script for BOTH refusal readings, asserting per reading that the real one refuses and the mutant does not
- [ ] SC-2445: The content reading is reached from the single-claimant arm of `auditWorktreeClaims` and from no other arm — DA-owned, co-owned, path-refusal, two-claimant and no-claim-issued each refuse unchanged even when the two copies are byte-identical

The ids stay UNTICKED deliberately. `scripts/sync-sc-status.ts` ticks a
criterion when a test file names it, and the proof for SC-2440..SC-2444 lives
in the script's own `--prove` mode rather than in `test/`: this sub-issue's
claim covers the script and this spec and nothing else, and a test file no
sub-issue claimed is refused at collection by SC-413. Ticking them from the
script would certify criteria that `test/` does not cover, which is
`.claude/rules/claiming-sc-coverage.md`'s trap from the other direction.
SC-2445 belongs to the sub-issue that writes the arm.

### What was broken to prove it (SC-2440..2444)

The battery is the script's own `--prove` mode, so it is re-run by anyone who
runs it rather than described here:

```bash
bun scripts/compare-claim-content.ts --prove     # 12 rows, exit 0
```

It builds a copy of the source with the exit constant set to `0`, rewrites the
relative import to an absolute path so the copy runs from a temp directory, and
runs real and mutant over the same two fixtures. Three properties make the rows
mean something:

- **The IDENTICAL control runs first.** Without it, "exited non-zero" is not
  evidence of a refusal — a script that cannot run exits non-zero for every
  input, and a mutant that died on module resolution reads as the mutation
  having been rejected on the merits.
- **The mutant must reach the SAME reading.** Its exit `0` is then the removed
  refusal and not a crash, a usage error or an unresolved import; the row
  asserts real and mutant differ ONLY in the exit code, with identical stdout.
- **The builder ABORTS when its anchor moves.** A second assignment, a refusal
  that bypasses the constant, or a surviving relative import throws rather than
  returning an unmutated copy — a harness that silently no-ops when its target
  moves is the decorative check this is against.

Every count was predicted before the battery ran, and **the baseline row was
read first**. Mutations were applied to `scripts/compare-claim-content.ts`,
run, and reverted; the file was confirmed byte-identical afterwards by sha256.

**Baseline, unmutated: 12 rows, 0 failed.**

| Mutation | Predicted | Failed rows |
|---|---|---|
| `refusalSentence` returns `null` for every reading | 6 | **6 of 12** |
| the cheapest wrong fix: DIFFERENT reuses the bare *"that file was not claimed"* sentence | 1 | **1 of 12** |
| `collectable` computed as `comparison !== null` | 2 | **2 of 12** |
| the UNMEASURED branch stops refusing | 3 | **3 of 12** |
| the single exit inlined as a literal, bypassing the constant | abort | **the proof ABORTS — 0 rows run, exit 1, "could not build the mutant"** |

**Before believing any of them, the input on which mutant and original
differ**, named and run rather than assumed:

- rows 1, 2 and 4 — the DIFFERENT fixture, two worktrees whose copies of
  `src/daemon/auto-reflection.ts` read `export const reflect = true;` and
  `export const reflect = false;`, and the UNMEASURED fixture, a claiming
  worktree holding no copy of that file at all. The original exits 1 carrying
  the sentences above; each mutant exits 0, or exits 1 carrying the bare
  unclaimed sentence.
- row 3 — the UNMEASURED fixture: the original reports `collectable: false`,
  the mutant reports `collectable: true` for a file nobody could read.
- row 5 — any input at all: the builder refuses to build, which is the point.

**The cheapest wrong fix, named: let `UNMEASURED` collect.** An unreadable copy
on a run that is otherwise fine looks like noise, and treating it as IDENTICAL
makes the symptom disappear. Row 4 is that repair applied, and it is 3 red: the
reading is the one state in which nobody knows what the bytes say, and a guard
that collects on it is a guard that collects on a read failure.
