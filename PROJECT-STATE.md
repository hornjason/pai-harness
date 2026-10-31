# Project State

**Current phase: Engine — a spec becomes a readable board, with nothing hand-run (ADR-009) — IN PROGRESS**

**Session 69 (2026-10-31)** — THE STAGE DEFINITIONS WERE NEVER WRITTEN DOWN, AND THAT MADE A STAGE AUDIT SCORE THE WRONG LIST.

#1685 merged (4dcb9ff3) carrying ADR-009, the board identifiers in .claude/rungate/config.json under `board`, AGENTS.md rule 8, and SC-2615..2624. All four verified present on main.

Then Jason asked whether Stage A was done, and the honest answer took a transcript dig to find. The seven items that DEFINE Stage A — A1..A7 — were agreed with him in conversation on 2026-10-30 and written to no file at all; they existed only inside a 387 MB session log. Lacking them, the audit scored against ADR-009's Consequences section, a different and easier list, and reported 5 of 6. Measured against the real list the reading is 3 of 7: A2, A4 and A6 are done, A3 is partial, and A1 (SUCCESS.md claim, PR #1688), A5 (no criterion states the acceptance test) and A7 (ADR-001..006 all still `proposed`) are not. Jason's recall that we had defined them was correct and my first search for them was too narrow — the fourth time that pairing has happened.

THE FIX IS NOT A BETTER SEARCH. Priority 2 of this file is now the stage ladder itself, A1..A7 with tick state plus the B-F one-liners, because this is the file read at the start of every session and an ADR is read only when the reasoning is in question. AGENTS.md rule 9 makes it standing: an agreement is not real until it is in project-state.json, written before the turn ends. The B-F sub-items are deliberately NOT drafted here — Stage A's own rule is that documents get reviewed by Jason, and inventing his list is the mistake this entry exists to stop.

Rule 9 cost 530 bytes the instruction surface did not have: the peak sat at 100% of budget on .claude/agents/aditi.md. The rule was cut to a three-line pointer with the evidence held once, here, which leaves 236 bytes free against a 230-byte floor. The next rule added to AGENTS.md goes red until a worked record moves into reference/.

Suite: No full local suite — other sessions hold worktrees and .claude/rules/parallel-sessions.md forbids a concurrent full run. Census-routed for a diff touching project-state.json, PROJECT-STATE.md, AGENTS.md and a test: 358 tests across the twelve files scripts/census-routing.ts names for that diff, 345 pass 0 fail 12 todo after the repairs below. Three of the five initial failures were the instruction-surface budget, which AGENTS.md rule 9 pushed 530 bytes past a ceiling already at 100%; one was test/agents-md-refs.test.ts, whose one-path census is deliberately written to go red when AGENTS.md names a second file, and it did exactly that; one was project-state currency, which wanted a session entry for #1685.
Issues closed: #1685

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. THE GOAL (2026-10-30, supersedes the 2026-10-23 SCOPE LOCK below). A spec in git becomes a readable board with nothing hand-run: open the board and see every issue, its milestone, the criterion it serves and what blocks it, without opening an issue. One command reports the same thing so nothing depends on an agent reading. Decision record docs/adr/ADR-009-engine-goal-and-build-order.md. [ADR-009 LANDS WITH PR #1685 — until that merges it is on branch rg/codify-engine-goal and NOT on main. If it is absent, merging #1685 is the next action.]
2. THE STAGE LADDER — the definition of every stage, and where we are on it. A1-A7 were agreed with Jason in conversation on 2026-10-30 and were written to NO file: they existed only inside a 387 MB session transcript until 2026-10-31. That cost a Stage A audit, which scored against ADR-009's Consequences section instead and reported 5 of 6 when the real reading was 3 of 7. The one-line stage descriptions are ADR-009 section 5 'The build order — six stages'; the sub-items are HERE, because this is the file read every session and an ADR is read only when the reasoning is in question. One copy, not two. STAGE A, write it down — 3 of 7 on origin/main 2026-10-31: A1 [ ] the goal as a claim in SUCCESS.md (PR #1688, open) · A2 [x] the goal set in the fleet goal file ~/.claude/FLEET-STATE.md, now tracked in hornjason/pai-config · A3 [~] the spec declares itself the engine — specs/SPEC-TO-BOARD-PIPELINE-SPEC.md section 'Nothing in the engine is hand-run' defines it, but the `governs:` field describes the engine without naming it · A4 [x] criteria for the no-hand rule — SC-2618..2621, 0 ticked · A5 [ ] a criterion for the acceptance test, that the convergence spec ships through the engine untouched — this is prose in the spec body and NO criterion states it · A6 [x] no criterion satisfied by a symbol being present — SC-2622 · A7 [ ] the six Proposed ADRs resolved — ADR-001..006 are all still `proposed`; only 007, 008 and 009 are accepted. STAGES B-F carry their ADR-009 one-liner and NO agreed sub-items yet — drafting them is the first act of each stage and Jason reviews the draft, the same rule Stage A had: B build the engine's own board — the engine spec becomes milestones, issues and edges, a real backlog to work from; the conformance command's SKELETON is built here, not in D, or the loop has no terminal condition · C build the missing behaviour — the things the engine spec names that do not exist or are false · D remove the agent from the loop — one command, runnable by Jason, that says whether the board is right · E place the rest of the specs — the other specs get placement tables and reach the board · F ship the payload — specs/CODE-REVIEW-CONVERGENCE-SPEC.md goes through the engine untouched. A stage is finished when every one of its sub-items is ticked and an audit has been run against THIS list. Do not audit a stage against any other list.
3. BASELINES measured 2026-10-30 on origin/main at eae12e11, so a later reading can tell whether anything moved: 1 of 15 pipeline criteria proved by a test naming the id; 2 of 27 top-level specs carrying a Phase placement table; 71 open issues of which 46 name a criterion and 0 carry a blocked-by edge; 1131 of 1485 ticked criteria repo-wide satisfied by a symbol being present rather than a behaviour; 0 claims in SUCCESS.md naming the board, backlog or tracker; 0 repository locations recording the board node id before PR #1685.
4. THE DEFECT THIS EXISTS TO STOP. A criterion of the form `<file> contains [<symbol>]` is satisfied by a name being present. SC-2609 requires lib/board-mirror.ts to contain NAMES_NONE; it does, and its value is the empty string — satisfiable and false. That is how partial work reads as a finished plan. No criterion added under ADR-009 may be satisfied by a symbol existing. [ADR-009 LANDS WITH PR #1685 — until that merges it is on branch rg/codify-engine-goal and NOT on main. If it is absent, merging #1685 is the next action.]
5. LOOSE ENDS, both unmerged and invisible from GitHub: commit 9f12ffd6 in /Users/jhorn/Projects/rg-wt-m12-proposal is on no remote branch — 90 lines adding an increment-1 build plan to specs/CODE-REVIEW-CONVERGENCE-SPEC.md, containing a section headed the decision this needs from Jason; and specs/HELP-SPEC.md is untracked in /Users/jhorn/Projects/rg-wt-threads2 and not on main.
6. FLEET-STATE.md carried a goal set 2026-10-25 about making COMMENT_INSTEAD unwaivable, five days stale and about another subject, throughout the session that set this one. /goal reads that file. Re-point it before trusting any drift reading.
7. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] SCOPE LOCK (2026-10-23): all work is locked to specs/CODE-REVIEW-CONVERGENCE-SPEC.md. The build order is the section 'The order to build the remainder in' in that spec (landed via PR #1466). Do not pick criteria opportunistically — that is what produced three sessions in a row that ended in an analysis comment instead of code.
8. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE NUMBER THIS MOVES. Measured 2026-10-23 over the 44 most recent PRs that carried a ledger: passed-after-one-round 39.4% (blog before 65%, after 78%); five-or-more-rounds 20.5% (8.9% / 1.5%); mean rounds-to-pass 2.64 (2.08 / 1.32). We are WORSE than the state the source improved from, on all three. The tail is the damage, not the median — 20.5% is over twice their starting figure while the mean is only a quarter above it.
9. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] THE BACKLOG IS 30, NOT 47. Of the unticked criteria: 8 are mechanisms this tree cannot observe, 4 cannot be meaningful in this deployment (one human, one consumer), 2 are declared deviations, 3 are repository settings. Only 30 are engineering. The spec carried that split across four tables and nobody had summed them.
10. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 0 — BLOCKED ON THE OWNER, NOT ON ENGINEERING. Three branch-protection settings, no code: CRC-F1 (strict:true), CRC-C3 (required_conversation_resolution), CRC-E8 (required_pull_request_reviews with dismiss_stale_reviews). First because CRC-E6 and CRC-M9 are VACUOUS rather than unbuilt until they land — there is no approval to count, so nothing can be built that counts one. Read CRC-F1's caveat before flipping it: a merge queue serialises merges, and on merge_group the review annotates UNMEASURED and passes, so 'every check' would be half true; strict:true is the cheaper half and closes the same hole.
11. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 1 — STOP THE REPEATS. CRC-N4 (no repeats) depends on nothing and is the single highest-value item in the document: lib/ai-review-rounds.ts exports readLedger, priorFindings, carryForward, suppressRepeats, noRepeatsInstruction, atCapInstruction and reviewScopeForRound with ZERO production callers between the seven — every caller is a test. It is wiring, not design. A finding re-posted every round is arithmetically an extra round. Then CRC-B7 (needs the changed-file list reaching the adjudicator, then a release) and CRC-N2 (depends on N4; it is a declared deviation only until carryForward has a production caller).
12. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASE 2 — STOP THE FALSE FINDINGS. CRC-B4 (verifier quorum) depends on nothing: lib/finding-jury.ts holds group size, quorum, per-verifier votes and a disagreement flag, and nothing deployed takes a vote. Then CRC-B6 (A/B the filters, variance bounded) and CRC-B3 (parallel generation) — B3 STRICTLY after B4, because without a quorum N generators are N chances to block falsely, which is worse than one. Run 39962683401 is the measured instance: a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the blocking side.
13. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] PHASES 3-6, in order and lower value. P3 what the reviewer is told (CRC-A4, B2, B9, A7) — sequenced after P2 on purpose, because context without a falsification step produces more confident false premises. P4 findings get answered (CRC-B8, A8, A2, A1, A3). P5 the instruments (CRC-M6, M10, M1, M3, M4, M5, M7, E3, E9). P6 release and detection (CRC-F3, F4, F5, N5, H2) — last because none of them moves rounds-to-pass.
14. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] WHAT WOULD FALSIFY THE PHASE ORDER. Re-take the CRC-M11 reading now #1449 and #1452 have landed. The 2.64 was measured across a harness defect that raised a blocking finding on EVERY pull request editing .claude/ or CLAUDE.md, which in this repository is how conventions ship. If the tail collapses on its own, Phases 1 and 2 are ordered against a baseline that no longer exists and the argument has to be made again rather than inherited.
15. [SUPERSEDED — this is the 2026-10-23 convergence plan, kept for its ordering. The ACTIVE plan is the engine, items 1-6.] RELEASE: DO NOT CUT ONE YET. npm serves rungate@0.8.2, published 2026-10-23T14:04:13Z; v0.8.2 was tagged 13:44:28Z; main has taken ~78 commits since. The ONLY dormant surface is lib/scaffold/ai-review-findings.ts and what it imports, because `bunx rungate@0.8.2 ai-review-findings` is the single pinned call in CI — everything else reaches CI live, either through `bun test` from the checkout or through committed generated YAML. So CRC-B7 (#1435) is dormant and CRC-B1 (#1387) is LIVE. A release now still activates nothing: main() takes the changed-file list as argv[1] and the generated step passes one argument, so CRC-B7 published is still inert. Correct order is #1356 first, then a release, then re-measure. See the comment on #1226.

## 🔄 Engine — a spec becomes a readable board, with nothing hand-run (ADR-009) (IN PROGRESS)

## 🔄 Code Review Convergence (CRC) — the PAYLOAD, sequenced behind the engine (IN PROGRESS)

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality + Config-Driven Testing (A-H) (COMPLETE)

## ✅ Brief Compliance + Agent Brief Templates (COMPLETE)

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter |

## 🔄 AES Quality Gate + Pipeline Optimization (IN PROGRESS)

## ✅ Scaffold Decomposition (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ✅ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ✅ | SC-360 | AGENTS.md generator from ProjectScan |
| ✅ | SC-361 | Brief generator reads template files |
| ✅ | SC-362 | CODE-MAP generator from ProjectScan |
| ✅ | SC-363 | scaffold-project.ts under 200 lines |
| ✅ | SC-364 | Identical output before and after |
| ✅ | SC-365 | Scanner importable without generation |
| ✅ | SC-366 | Generators testable with mock data |

## ✅ Hook Architecture (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-367 | AgentBriefGuard under 50 lines |
| ✅ | SC-368 | lib/brief-validator.ts independently testable |
| ✅ | SC-369 | GateEnforcement under 100 lines |
| ✅ | SC-370 | Every hook traces to an SC |
| ✅ | SC-371 | No hook over 150 lines |
| ✅ | SC-372 | Hook logic in lib/ has unit tests |

## ✅ Gate Contracts (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-373 | Every gate has typed input/output |
| ✅ | SC-374 | Pass/fail criteria documented as SCs |
| ✅ | SC-375 | Gate chain order documented |
| ✅ | SC-376 | run-gate.ts under 400 lines |
| ✅ | SC-377 | Contracts testable by conformity engine |
| ✅ | SC-378 | No implicit state passing |

---

**Session 2026-10-31 session 69:**
- THE STAGE DEFINITIONS WERE NEVER WRITTEN DOWN, AND THAT MADE A STAGE AUDIT SCORE THE WRONG LIST.

#1685 merged (4dcb9ff3) carrying ADR-009, the board identifiers in .claude/rungate/config.json under `board`, AGENTS.md rule 8, and SC-2615..2624. All four verified present on main.

Then Jason asked whether Stage A was done, and the honest answer took a transcript dig to find. The seven items that DEFINE Stage A — A1..A7 — were agreed with him in conversation on 2026-10-30 and written to no file at all; they existed only inside a 387 MB session log. Lacking them, the audit scored against ADR-009's Consequences section, a different and easier list, and reported 5 of 6. Measured against the real list the reading is 3 of 7: A2, A4 and A6 are done, A3 is partial, and A1 (SUCCESS.md claim, PR #1688), A5 (no criterion states the acceptance test) and A7 (ADR-001..006 all still `proposed`) are not. Jason's recall that we had defined them was correct and my first search for them was too narrow — the fourth time that pairing has happened.

THE FIX IS NOT A BETTER SEARCH. Priority 2 of this file is now the stage ladder itself, A1..A7 with tick state plus the B-F one-liners, because this is the file read at the start of every session and an ADR is read only when the reasoning is in question. AGENTS.md rule 9 makes it standing: an agreement is not real until it is in project-state.json, written before the turn ends. The B-F sub-items are deliberately NOT drafted here — Stage A's own rule is that documents get reviewed by Jason, and inventing his list is the mistake this entry exists to stop.

Rule 9 cost 530 bytes the instruction surface did not have: the peak sat at 100% of budget on .claude/agents/aditi.md. The rule was cut to a three-line pointer with the evidence held once, here, which leaves 236 bytes free against a 230-byte floor. The next rule added to AGENTS.md goes red until a worked record moves into reference/.

**Session 2026-10-30 session 68:**
- THE PIPELINE WAS RUN AGAINST ITS OWN GOVERNING SPEC FOR THE FIRST TIME, AND IT FOUND THAT I HAD UNDER-COUNTED THE GAP BY A THIRD.

#1674 merged (10c53e1d) carrying ADR-008, the decomposition plan for SPEC-TO-BOARD-PIPELINE-SPEC.md. That spec merged the night before with 15 criteria and nothing naming 14 of them, which was the whole forward gap. Six issues now name six of them — #1675 SC-2602, #1676 SC-2610, #1677 SC-2613, #1678 SC-2612, #1680 SC-2606, #1681 SC-2611 — each in a Pipeline Phase milestone created by plan-spec, with one blocked-by edge: #1678's promotion tool creates issues, so it must not land before #1677 meters createIssue. criterion-inventory now reaches them: NOT STARTED fell from 14 of 15 to 10 of 15, and the ten remaining are criteria that are already true and need a binding rather than an issue.

IT WAS FOUR ISSUES UNTIL THE REVIEW CORRECTED TWO READINGS. SC-2606 and SC-2611 were recorded as already-present on the strength of `adjacent` in lib/spec-deps.ts and `coverage` in lib/spec-placement.ts. Each occurs exactly once, inside a prose comment, neither as a declared identifier. The reading was taken with grep and reported as if it were a symbol table. Both errors shrank the backlog, which is the direction nobody notices — a smaller plan and a smaller problem produce the same document — and uncorrected they would have left Phase 2 and Phase 4 looking finished. It matters beyond the count: `contains [adjacent]` is satisfied by a text match, so both criteria could be ticked by a conformity run while nothing of that name exists.

THE BOARD NOW ANSWERS THE QUESTION IT WAS BUILT FOR. board-mirror filtered its id set to one spec named on the command line, so every issue serving any of the other 25 specs rendered as an empty cell — 28 blank on 2026-10-29. It now sweeps specs/ recursively (#1679, open). Running it against the live board exposed two ways the cell goes WRONG once every spec is read, and a wrong cell is worse than a blank: #713 writes its own acceptance criteria as `- [ ] SC-1 —`, which is a declaration and not a reference, and #312's `SC-A1` is stated by three specs so it cannot be attributed. Both are now excluded. 62 of 91 board items carry their criteria; the 29 that do not are reviewer findings that legitimately serve none.

THE BACKWARD DIRECTION IS NOT CLOSED AND SHOULD NOT BE READ AS CLOSED. Tonight moved the forward direction only — every criterion reachable from the board. 24 open issues still name no criterion, almost all labelled follow-up or external-audit, and the tool that would turn those into criteria is SC-2612, which is #1678 and unbuilt.

ONE RECURRING DEFECT, NAMED BY THE REVIEWER AND ANSWERED STRUCTURALLY. Across #1672 and #1674 the same bug was repaired four times at four call sites: an incomplete read or result treated as complete. Pagination on openTitles, then independently on milestones, then a missing try/catch around the pre-flight reads, then --json ignored on every refusal. Both axes are now properties rather than point fixes — every `gh api` call in scripts/plan-issues.ts is asserted to paginate, and every refusal in decompose() is asserted to leave through one reporter. #1679 showed the same shape in miniature: escaping an id was unified one round, and the round after caught that the TERMINATOR was still duplicated, with `\b` matching SC-1 inside SC-1-draft.

#1679 MERGED (454bad56) AFTER TWELVE REVIEW ROUNDS, AND THE REVIEWER WAS RIGHT ON TEN OF THEM WHILE I WAS NOT READING THE LEDGER. board-mirror now reads every spec under specs/ instead of the one named on the command line, which is SC-2610 and closes #1676. The code is the small part. Rounds 1 through 11 kept naming two findings I never saw because they sat in the ai-review ledger comment rather than on the diff: GitHub refuses a review thread on a path outside the pull request, so three findings posted 0 of 3 and the job failed with a posting error that reads like an infrastructure fault. The findings were lib/cli-commands.ts spelling --spec as required in the command registry — telling every reader of rungate --help to do the exact thing SC-2610 exists to prevent — and scripts/plan-issues.ts PRINTING a follow-up command that combines --spec with --write, handing the reader the defect as advice. Both are siblings of my own change. A failing check whose message names a mechanism I cannot act on is a check I stopped reading, and the ledger is where the content was the whole time.

THE SAME DEFECT CLASS RAN FOUR TIMES ON ONE PULL REQUEST AND THE ANSWER WAS NEVER THE NEXT REPAIR. Escaping an id, then the terminator, then de-duplicating a spec's ids, then a third UNMEASURED branch leaking partial data after the first two were each patched alone. Every round I fixed the site the reviewer named and left its sibling, and no behavioural test could see the difference because N sites answering one question is behaviourally one site. What closed it was asserting the property ACROSS the sites: unmeasuredSweep() is now the only thing in lib/board-mirror.ts that can name the reading, with the test requiring zero UNMEASURED literals in specCriteriaIn's body, and the registry usage string must agree byte for byte with scripts/board-mirror.ts's USAGE with no bare --spec anywhere. Both were proved with behaviour-preserving mutants — a branch that inlines the reading, a sibling that reverts the string — which the behavioural cases cannot see at all. The rule already existed in .claude/rules/checks-must-be-able-to-fail.md under "two deciders that agree"; the cost of learning to reach for it first was ten rounds.

#1683 FILED RATHER THAN FIXED, WITH THE REACHABILITY MEASURED FIRST. declaresOwnCriterion suppresses a criterion id across an issue's whole body rather than per mention, so an issue that both serves a criterion and carries a checklist line shaped like it renders an empty cell. Probed against 400 issues and 1,768 criterion ids: 11 instances across 6 issues, ALL CLOSED, so 0 open board cells are wrong today. 11 in 400 is not hypothetical, which is why it is an issue rather than a note. Tonight's ratio is 7 issues opened against 1 closed.

**Session 2026-10-29 session 67:**
- THE SPEC-TO-BOARD PIPELINE GOT TWO MORE TOOLS AND ITS FIRST HONEST AUDIT, AND THIS FILE IS WHY MAIN WAS RED FOR FOUR HOURS.

#1648 merged (8bbfb366) and #1647 merged (c50da2d4), putting plan-spec, lib/spec-placement.ts, board-mirror, the spec-work issue template and ADR-003/ADR-004 on main. Both merges landed while the newest session entry here still read 2026-10-27, so project-state currency went red on main at 12:21Z and every branch cut from it inherited three failures. The guard was right and the cost was real: with strict:false every open pull request shows a red `test` that has nothing to do with it, and separating a genuine regression from the inherited three means fetching main's own run and diffing failure NAMES. Jason's call was to generate this entry at merge time rather than keep a hand-written step in the merge path.

TWO TOOLS BUILT, ONE ALREADY APPLIED TO LIVE STATE. plan-deps derives the phase order into `blocked by` edges and proved itself by re-deriving 194 of the 196 live ones; the 2 it does not derive are hand-authored WITHIN a phase (#1481 blocked by #1591, #1659 blocked by #1658), which is the one ordering a phase sequence cannot express, so it reports them and never deletes. plan-issues --repair consumes an approved table and applied ADR-005 on 2026-10-29: 9 issues annotated with the criteria they serve, 2 demoted out of phase milestones, 18 orphaned edges removed. Phase issues naming no criterion went 11 to 0. That is live tracker state, not a proposal.

THE BOARD CENSUS FOUND THE COLUMN LYING IN THE DIRECTION THAT HIDES A GAP. 65 open issues, 37 with a populated Criteria cell, 28 blank — and the mirror itself is healthy: 0 stale cells, 0 disagreements, 0 issues off the board. The blanks are two defects in board-mirror. lib/board-mirror.ts declares NAMES_NONE with a docblock calling it "the text used when an issue names no criterion at all" and sets it to the empty string, so an issue measured and found to serve nothing is byte-identical to a cell nothing ever visited, and the write path skips it because the computed text already equals the live one. That is Silent Default Substitution shipped inside the column built to remove exactly that ambiguity. Second: --spec takes one path, so four issues aligned to HOOK-ARCHITECTURE-SPEC and HARNESS-STANDARD render blank despite being correctly linked. An earlier count of six was WRONG — SC-9101/SC-9110 and AR-20/FG-45/FG-90/FG-99 are test-file block ids, not spec criteria.

THE UNALIGNED BACKLOG HAS NO ORDERING SIGNAL OF ANY KIND, measured rather than assumed. 22 open issues carry no criterion, and all 22 have zero dependency edges in BOTH directions — so the theory that they are downstream of spec work is false. Priority is set on 0 of 65 board items. Size on 0 of 65. They sit in Backlog, ages 0 to 18 days, and nothing in the system can say which to do first. 20 of the 22 are labelled follow-up or external-audit, which AGENTS.md rule 7 says should have been pull request comments by default.

AND THEY ARE NOT SAFELY SWARMABLE, which was the tempting conclusion. 11 of the 22 share at least one file with another issue; lib/bash-write-guard.ts is named by four (#1585, #1425, #1407, #1355). The edges we derive encode PHASE ORDER, not file overlap, so "no dependency edge" means unordered, not independent. Four more name no file at all, which rule 2 says means not ready.

ONE OF 26 SPECS HAS A PHASE PLACEMENT TABLE. That is the whole reason only convergence is orderable: a criterion id does not carry order, the placement table does. Reading every spec into the Criteria column is honest and buys visibility, and it schedules nothing. Jason's decision is to add placement tables where work is live, and to triage the 20 findings into criterion-or-close rather than inventing a maintenance lane nobody fills.

#1669 TOOK SIX REVIEW ROUNDS AND THE REVIEWER WAS RIGHT EVERY TIME. Three findings worth carrying forward. First, dependencyPlan refused on issues.length===0 and on phases.length===1, and four consecutive rounds each found a different input that walks between them — the last being phases.length===0, where issues exist so the first guard is skipped and there is no single phase so the second is skipped, and the command prints "the tracker already carries the phase order" about a board it never read. The reviewer also filed the process finding: a UNMEASURED check written for one specific empty-input shape, not the class of them, which a line-level patch keeps reintroducing variants of. That is AGENTS.md rule 5 arriving from the outside, and the repair was to re-scope rather than patch: degenerateReasons now states the property once — an order needs two phases — and enumerates every route to fewer than two, with a negative control naming the only input that must reach none of them.

Second, and this is the one to remember: the fail-open write status was fixed in plan-issues and left in plan-deps IN THE SAME PULL REQUEST. applyEdges catches each failure into a "FAILED" string and nothing read the array, so a run where every gh call failed printed "wrote": "yes" and exited 0. Naming a fix in one file is not sweeping for its shape in the others.

Third, the pull request title said plan-deps and the diff shipped a second live-mutating command that had ALREADY edited eleven issues. An approval scoped to "reproducible phase ordering" was being read as covering that. Fixed by rewriting the title and body, not the code — and it is the best finding of the six rounds, because nothing in CI could have caught it.

THE PIPELINE HAS A FORWARD DIRECTION AND NO RETURN PATH, which is the structural result of the session. spec to milestones to issues to edges to board all flows one way. Findings arrive from the other end, mid-flight, and have nowhere to land except the unordered tail — the 22 issues above ARE that return path, unmanaged. Two steps have no tool at all: turning a criterion into the right NUMBER of issues (decomposition), and turning a reviewer finding into a criterion in a spec. Everything else in the chain is a command. Those two are the backlog-to-zero blockers, not the tools that already exist.

ADR-005 is approved and applied. ADR-006 classifies the six Convergence Machinery issues — three serve CRC-C2 and sit outside the phase order entirely, three are correctly machinery — and is PROPOSED, acted on by nothing.

