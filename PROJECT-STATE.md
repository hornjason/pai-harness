# Project State

**Current phase: All phases complete**

**Session 67 (2026-10-29)** — THE SPEC-TO-BOARD PIPELINE GOT TWO MORE TOOLS, ITS FIRST HONEST AUDIT, AND A CORRECTION ABOUT WHO WRITES THIS FILE.

#1647 and #1648 merged, putting plan-spec, board-mirror, the issue template and ADR-003/004 on main. plan-deps and plan-issues --repair are built and in #1669; the repair has ALREADY been applied to live state, taking phase issues naming no criterion from 11 to 0.

THE BOARD AUDIT FOUND THE COLUMN LYING IN THE DIRECTION THAT HIDES A GAP. board-mirror declares NAMES_NONE as the text for an issue naming no criterion and sets it to the empty string, so measured-and-none is byte-identical to never-visited. The mirror itself is healthy — 0 stale, 0 disagreeing across 65 open issues — which is why the 28 blanks read as a coverage gap rather than as the defect they are.

THE UNALIGNED BACKLOG HAS NO ORDERING SIGNAL OF ANY KIND: 22 issues, zero dependency edges in both directions, Priority set on 0 of 65 board items, Size on 0 of 65. And they are not safely swarmable — 11 of the 22 share a file with another, four of them lib/bash-write-guard.ts.

ONE OF 26 SPECS HAS A PHASE PLACEMENT TABLE, which is why only convergence is orderable. A criterion id does not carry order; the placement table does.

TWO PIPELINE STEPS HAVE NO TOOL AT ALL: turning a criterion into the right NUMBER of issues, and turning a reviewer finding into a criterion in a spec. The pipeline runs one way and findings arrive from the other end, so the 22 unordered issues ARE the unmanaged return path.

AND THE CORRECTION THAT MATTERS MOST: I spent this session telling Jason that project-state.json was his to write. It is not. DA-owned means the Digital Assistant owns it — me — and #296 (2026-10-11) says so in its own commit message: PROJECT-STATE.md is DA-owned, stop instructing AGENTS to write it. The prohibition names a PLACE I may not write from, a worktree, and I resolved it into a PERSON. The cost was four hours of red main and three blocked pull requests, in a file I could have fixed at any point.

Suite: No full local suite — other sessions hold worktrees and .claude/rules/parallel-sessions.md forbids a concurrent full run. Targeted via the set scripts/census-routing.ts derived per diff: 63 pass 0 fail on test/plan-deps.test.ts + test/plan-issues.test.ts, and 1,592 pass 0 fail across the census-routed set for the #1669 diff. Typecheck 0, matching baseline. Nine mutations run across two commits, nine matching their predicted membership; one row read 0 on its first pass and was reported as a hole rather than a pass, the case added, and the mutant re-run to watch it go red.
Issues opened: 1650,1651,1652,1653,1654,1655,1656,1657,1658,1659,1660,1661,1662,1663,1664,1665,1666,1667,1668
Issues closed: 1548,1440,1404

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. SCOPE LOCK (2026-10-23): all work is locked to specs/CODE-REVIEW-CONVERGENCE-SPEC.md. The build order is the section 'The order to build the remainder in' in that spec (landed via PR #1466). Do not pick criteria opportunistically — that is what produced three sessions in a row that ended in an analysis comment instead of code.
2. THE NUMBER THIS MOVES. Measured 2026-10-23 over the 44 most recent PRs that carried a ledger: passed-after-one-round 39.4% (blog before 65%, after 78%); five-or-more-rounds 20.5% (8.9% / 1.5%); mean rounds-to-pass 2.64 (2.08 / 1.32). We are WORSE than the state the source improved from, on all three. The tail is the damage, not the median — 20.5% is over twice their starting figure while the mean is only a quarter above it.
3. THE BACKLOG IS 30, NOT 47. Of the unticked criteria: 8 are mechanisms this tree cannot observe, 4 cannot be meaningful in this deployment (one human, one consumer), 2 are declared deviations, 3 are repository settings. Only 30 are engineering. The spec carried that split across four tables and nobody had summed them.
4. PHASE 0 — BLOCKED ON THE OWNER, NOT ON ENGINEERING. Three branch-protection settings, no code: CRC-F1 (strict:true), CRC-C3 (required_conversation_resolution), CRC-E8 (required_pull_request_reviews with dismiss_stale_reviews). First because CRC-E6 and CRC-M9 are VACUOUS rather than unbuilt until they land — there is no approval to count, so nothing can be built that counts one. Read CRC-F1's caveat before flipping it: a merge queue serialises merges, and on merge_group the review annotates UNMEASURED and passes, so 'every check' would be half true; strict:true is the cheaper half and closes the same hole.
5. PHASE 1 — STOP THE REPEATS. CRC-N4 (no repeats) depends on nothing and is the single highest-value item in the document: lib/ai-review-rounds.ts exports readLedger, priorFindings, carryForward, suppressRepeats, noRepeatsInstruction, atCapInstruction and reviewScopeForRound with ZERO production callers between the seven — every caller is a test. It is wiring, not design. A finding re-posted every round is arithmetically an extra round. Then CRC-B7 (needs the changed-file list reaching the adjudicator, then a release) and CRC-N2 (depends on N4; it is a declared deviation only until carryForward has a production caller).
6. PHASE 2 — STOP THE FALSE FINDINGS. CRC-B4 (verifier quorum) depends on nothing: lib/finding-jury.ts holds group size, quorum, per-verifier votes and a disagreement flag, and nothing deployed takes a vote. Then CRC-B6 (A/B the filters, variance bounded) and CRC-B3 (parallel generation) — B3 STRICTLY after B4, because without a quorum N generators are N chances to block falsely, which is worse than one. Run 39962683401 is the measured instance: a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the blocking side.
7. PHASES 3-6, in order and lower value. P3 what the reviewer is told (CRC-A4, B2, B9, A7) — sequenced after P2 on purpose, because context without a falsification step produces more confident false premises. P4 findings get answered (CRC-B8, A8, A2, A1, A3). P5 the instruments (CRC-M6, M10, M1, M3, M4, M5, M7, E3, E9). P6 release and detection (CRC-F3, F4, F5, N5, H2) — last because none of them moves rounds-to-pass.
8. WHAT WOULD FALSIFY THE PHASE ORDER. Re-take the CRC-M11 reading now #1449 and #1452 have landed. The 2.64 was measured across a harness defect that raised a blocking finding on EVERY pull request editing .claude/ or CLAUDE.md, which in this repository is how conventions ship. If the tail collapses on its own, Phases 1 and 2 are ordered against a baseline that no longer exists and the argument has to be made again rather than inherited.
9. RELEASE: DO NOT CUT ONE YET. npm serves rungate@0.8.2, published 2026-10-23T14:04:13Z; v0.8.2 was tagged 13:44:28Z; main has taken ~78 commits since. The ONLY dormant surface is lib/scaffold/ai-review-findings.ts and what it imports, because `bunx rungate@0.8.2 ai-review-findings` is the single pinned call in CI — everything else reaches CI live, either through `bun test` from the checkout or through committed generated YAML. So CRC-B7 (#1435) is dormant and CRC-B1 (#1387) is LIVE. A release now still activates nothing: main() takes the changed-file list as argv[1] and the generated step passes one argument, so CRC-B7 published is still inert. Correct order is #1356 first, then a release, then re-measure. See the comment on #1226.

## ⬜ Code Review Convergence (CRC) — the active plan (NOT STARTED)

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

## ⬜ AES Quality Gate + Pipeline Optimization (NOT STARTED)

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

**Session 2026-10-27 session 65:**
- THE REQUIRED GATE HAD NO PRODUCER, AND THE REASON WAS NOT THE ONE WE FILED.

required_conversation_resolution is enforced on the consumer and reads review THREADS. Measured across every merged pull request there: zero threads, ever. So the protection was a required gate over a population that is always empty — green by construction, the vacuous-assertion shape sitting in branch protection.

#1612 was filed blaming a missing `pull-requests: write`. That was WRONG, both halves. lib/scaffold/steps.ts has granted it unconditionally since #1168 and rungate's own workflow carries all four permissions; the consumer carried two because it is 378 commits behind on the re-scaffold channel. The real gap: the grant exists for the LEDGER, which posts to issues/{n}/comments, and a review thread comes from pulls/{n}/comments — an endpoint nothing in lib/, scripts/ or bin/ called. Reading the generator instead of the consumer's file is what found it; the correction is on the issue.

#1613 merged (0b623381) builds the producer: reviewThreadRequests decides which findings become comments, postReviewThreads names what happened when they were sent, and a generated step runs the new ai-review-threads command between the reviewer and the adjudicator — the one slot that needs no `if:`, which lib/conformity.ts forbids on this job. Closes #1612.

THREE RESULTS WORTH CARRYING FORWARD, each a near-miss rather than a success:

1. The mutation battery found a vacuous assertion in its own test. Zeroing AI_REVIEW_THREADS_REFUSAL reddened NOTHING, because the refusal cases asserted toBe(AI_REVIEW_THREADS_REFUSAL) — comparing the constant the mutant edits to itself, so both sides moved together and 9 of 9 stayed green over a refusal that had stopped happening. Readable only by RUNNING the battery. Fixed with .not.toBe(0) beside it.

2. normaliseRepoPath lowercases, by design, because its job is to make two spellings of one path compare equal. The REST API matches the diff byte-for-byte and answers 422 on a case difference. It is the readability PREDICATE here and never the emitted value; the two requirements fit in one function only if you never notice they differ.

3. The generated YAML reaches consumers on merge and the npm release happens later from a tag, so the live workflow asks a published package for a subcommand it does not have. bin/rungate.ts answers with exit 1 and the literal `unknown command "<name>"`, which is the one signal separating 'the release has not landed' from 'the producer is broken'. Verified against the real published 0.8.6. Without that branch, merging #1613 would have reddened every pull request in every consumer until a release shipped.

AND THE DIRECTION MAY BE WRONG, which is the honest end of the session. .github/workflows/claude-review.yml already has Claude post a native GitHub review with inline threads via the GitHub MCP tools, and it ran green four times on 2026-10-19. Its header records why it is still workflow_dispatch: the fork guard reads inputs.pr. If Claude posts its own review, rungate does not need to post anything, and an unresolved thread — resolved by a HUMAN — is a better gate than a severity table the reviewer fills in itself. Jason chose that direction; #1613's producer stays in place, reporting UNMEASURED and exiting 0, until the promoted trial has run on real pull requests.

THE TRIAL RAN, AND THE DIRECTION ABOVE WAS RIGHT. #1614 promoted claude-review to every pull request. Everything after this point is that reviewer being used in anger, and the session's result is that it kept being correct about work I had already called finished.

CRC-N4 GOT ITS MEASUREMENT FROM THE SPEC THAT DEFINES CRC-N4'S EXIT CONDITION. #1616 gave every convergence phase a PR-observable exit condition and drew 11 reviewer threads in the process - for 3 distinct findings. A frontmatter date raised five times, a dangling self-reference to a superseded draft three times, a stale threshold in the PR body twice, plus one already-fixed carry. The reviewer re-raised the same findings across four rounds while the line numbers moved under them, so carry-forward could not tell they were the same finding. That is the strongest evidence yet for doing Increment 1 first and it was produced by the spec arguing with itself.

PHASE 0 WAS THEN MEASURED TWICE AND ONLY ONE READING IS WORTH ANYTHING. #1617 recorded the exit reading; #1622 found the swarm track's claim that the control had never been run was false and recorded a complete draw; #1625 recorded a second. What is NOT claimed: #1625's own BLOCKED-to-CLEAN transition is confounded - the thread resolved and ai-review flipped on a re-run in the same window - so it is not a third draw and the spec does not call it one. A draw in that document is a BLOCKED-to-CLEAN observation and nothing else, which is a reservation the spec now states rather than implies.

INCREMENT 1 SHIPPED HALF AND THE OTHER HALF CANNOT BE REVIEWED. #1618 made a posted thread carry the key it was raised under; #1620 made carry-forward decide from review threads instead of line text. #1621 (the suppression gate) and #1623 (its carry-forward half) both edit ai-review.yml, which means the AI review of the pull request that changes the AI review is red by construction. That is not a failure to fix - it is the one case the gate cannot adjudicate about itself - and clearing it needs a label only Jason applies. Applying it myself would be self-grading. #1621 and #1623 are open and waiting on exactly that. #1619 IS BLOCKED FOR A DIFFERENT REASON and was wrongly grouped with them here: it edits no workflow, it carries no label, and it sits on one deliberately-unresolved review thread plus a red `review` check. What it needs from Jason is a choice between three options, not a label - override and merge, push another round answering the thread, or close it and re-cut. Grouping it under the self-review problem was an inference from `all three are open` and nothing else.

PHASE 2 IS UNMEASURED, NOT PENDING. In .github/workflows/ai-review.yml the step `id: ai-review-threads` posts the threads BEFORE the step that calls `bunx rungate ai-review-findings` reads the ballot, so a quorum cannot suppress a thread it has already published. Cited by step id and command rather than by line number, because the file is generated and over 4,700 lines long: an earlier measurement of this same ordering carried line numbers, and by the time they were written down here they pointed at two unrelated comment blocks. The review of #1626 caught that, which is the lesson of .claude/rules/self-referential-tests.md arriving in the same session that built a check for it. Until that ordering is fixed, any Phase 2 reading describes a mechanism that was never in the path. Saying 'pending' would imply the measurement is merely owed; it is not takeable.

AND #1624 COST SIX REVIEW ROUNDS WHERE EVERY FINDING WAS MINE. #1624 IS OPEN AND NOTHING IN THIS PARAGRAPH IS IN THE TREE - it is a proposal under review, described here because the review rounds are the session's result, not because the module exists. DOC-DIST, as proposed, would refuse a document that states in prose how far away one of its own parts is. The deciding measurement was 19 distance claims in the tree of which 17 are legitimate facts about OTHER files, so a blanket ban would have bought seventeen false positives for two real ones - the signal is the deictic referent, not the distance. What the rounds found is the part worth keeping: round 3 widened the match window and reintroduced the exact false-positive class the module had been narrowed to avoid, round 4 was spent undoing it, round 5 found the block markers looser than CommonMark in the other direction. Two consecutive widenings, two shipped defects, each found by the reviewer and not by me. The branch now declares its limits as asserted test rows that go red if somebody widens the rule, instead of widening a third time.

THE LAST ROUND IS THE ONE THAT GENERALISES. Re-admitting 'a' and 'an' to the quantity vocabulary changes the violation count across all 205 tracked markdown files by zero. So round 3's removal of them was decided by a sentence somebody constructed in a review comment, not by anything in this repository, and the instruction reading ('Add a line above this heading') and the claim reading ('A note sits a line above this heading') are the same bytes to this detector. No setting of that switch is correct. An enumerated vocabulary is a closed list over an open language, and the honest response is to name the limit and assert it, which is what the two limits that branch already declares do.

HOUSEKEEPING THAT WAS NOT HOUSEKEEPING: this file being stale turned test-shard 1 red on every pull request opened after #1625 merged, which is the guard doing exactly its job - it was written because eight commits and four merges once went by with the state file reporting success.

WHAT IS LANDED AND WHAT IS NOT, because this file is the first thing the next session reads. Every number above except #1612 is a PULL REQUEST, not an issue - #1612 is the only issue this session opened and closed, which is why issues_created and issues_closed still read [1612] beside prose naming a dozen other numbers. Each checked against the API and against origin/main's first-parent log rather than filled in to complete a range. MERGED: #1613 (findings posted as threads), #1614 (claude-review on every pull request), #1615 (the 0.8.7 release), #1616 (exit conditions), #1617 (Phase 0's exit reading), #1618 (a thread carries its key), #1620 (carry-forward from threads), #1622 (the swarm track correction), #1625 (the second draw). STILL OPEN: #1619 (the #1614 round economics and the prior art that beats our plan), #1621 (the suppression gate), #1623 (its carry-forward half) - those two blocked on a label only Jason applies - and #1624 (DOC-DIST). #1619 is blocked on an unresolved thread and a red check, not on the label. DOC-DIST IS NOT IN THE TREE. It lives on #1624 and nothing in lib/, test/ or specs/ on main mentions it, so do not build on it or skip re-implementing it on the strength of the paragraph above - read #1624 first. Those corrections came from the review of #1626, which is this session's own mechanism catching this file describing in-flight work as landed state. FIVE rounds, and the claim first written here - that every finding was distinct rather than re-raised - was FALSE and the reviewer caught it. Rounds 2 and 3 are the same underlying defect: round 2 said DOC-DIST was not in the tree by APPENDING a disclaimer after a paragraph left in the present tense, so the document asserted both, and round 3 raised it again. A bolt-on is not a fix, and the second raise is a repeat.

But it is a repeat with a DIFFERENT CAUSE than the one CRC-N4 is about, and the distinction is the reading worth banking. #1616's eleven threads were one finding the system could not recognise it had already raised. This was one finding the system raised correctly, twice, because the first fix did not remove the defect. Carry-forward cannot help with the second kind, and counting them together would inflate exactly the number Increment 1 is supposed to move. So: of five rounds here, four distinct findings and one re-raise caused by an incomplete fix of mine.

AND THE GUARD FOR THE LINE-NUMBER DEFECT ALREADY EXISTS AND DID NOT FIRE. .claude/line-citation-ratchet.json tracks PROJECT-STATE.md at broken: 0, and its own banked note predicts this exact event - `a session whose summary cites a line number puts it straight back`. The stale citation was in PROJECT-STATE.md at 596e0f60 and the ratchet suite passed anyway, because it counts the `path:NNN` form and the prose spelled it `L3323`. A detector narrower than what it detects, in the guard written for this defect, found only because a reviewer read the prose. Not fixed here - widening the extractor needs its own corpus reading for false positives - but recorded so the next attempt starts from the measurement rather than from the assumption that nothing was watching.

**Session 2026-10-25 session 64:**
- NOTHING THIS PROJECT SHIPPED IN THE PRECEDING FIVE DAYS WAS RUNNING. That is the session's result, and it was found by accident while trying to measure something else.

Five PRs merged (#1597, #1602, #1603, #1604, #1605), and #1597 closes #1595. Two open and blocked on this file: #1606, #1607. #1600 and #1601 stay OPEN — #1602 carries their work and neither is finished.

THE LIVE HOOKS WERE 32 COMMITS BEHIND. `RUNGATE_HOOKS_DIR` resolved to a hand-maintained tree pinned at `2729ce62` containing zero occurrences of `COMMENT_INSTEAD` or `FILINGS_PER_RUN`. So #1597, #1603 and #1604 were merged, closed, green, and dormant. The control that makes this a measurement rather than a grep: the refusal vocabulary that tree CAN emit — DUPLICATE, NO_CLAIM, DROPPED_CATEGORY, NO_QUORUM, UNMEASURED — is exactly the set present in all 261 ledger rows, which rules out `the mechanism fired and was not recorded`. This is session 58's lesson recurring at 32 commits instead of 14, and `lib/hook-tree-currency.ts` had already written it up: *a hook that is absent and a hook that is fourteen commits old produce the same observation*.

THE GUARD FOR IT EXISTED AND HAD NEVER RUN. `hooks/HookCurrency.hook.ts` is registered in this repo's committed `.claude/settings.json` at project scope — and project-scoped hooks are gated behind workspace trust, so it was green, registered and inert, exactly as #1578 found TopLevelCdGuard to be. Registering it at user scope made it fire on the first session and it immediately returned three findings nobody was looking for. Four more hooks are still in that state: AgentBriefGuard, BunTestPathGuard, SpecSCGuard, WorkflowStateGuard.

AND `${CLAUDE_PROJECT_DIR}` DOES NOT FOLLOW A WORKTREE — it stays at the project root where the session started. So every project-scoped registration was executing the PRIMARY CHECKOUT's copy, and the primary checkout was at `bc56a7c2`, 393 commits behind, with three files uncommitted for five days. Its `.git/hooks/pre-commit` was stale enough that the secret scanner was missing 5 of the 13 expressions `lib/secret-patterns.ts` declares — jwt and the tier2/tier3 patterns — so every commit made from that checkout for five days went unscanned for them. The uncommitted work (+361 lines, no deletions, `lib/config-readers.ts` grown 86 to 182 and a 252-line test with no equivalent on main) was preserved as `rescue/main-checkout-wip-20261025` BEFORE the fast-forward, and still needs a real rebase before any of it is proposed.

THE SUCCESS CRITERION WAS MEASURING THE WRONG THING, AND THAT IS THE MOST REUSABLE FINDING. The filing cap REFUSES AND INSTRUCTS — it tells the agent to post a comment; it does not post it. So issues-created-per-day falls identically whether the agent complies or drops the finding on the floor, and the failure reads slightly BETTER because the issue is never created. A metric blind to its own bad outcome is not a criterion. #1607 replaces it: compliance per refusal, with `rate` typed `number | null` so a denominator of zero cannot render as a rate of zero, and `compliedUpperBound` rather than `complied` because the ledger records no attempting agent. Today's reading is 9 observable, all of them DUPLICATE, upper bound 2; for OVER_CAP and COMMENT_INSTEAD the denominator is zero and the rate is null. The instrument's own first reading was its own defect — `duplicateOf` holds decimal STRINGS and the parser accepted only numbers, returning the honest-looking 0 the module exists to refuse.

THE BELT NUMBER IS 14%, NOT 52%. Issues created fell 125 to 60 across the window, but PRs created fell 128 to 71 over the same days — the drop is throughput, not the gate. Issues per PR went 0.98 to 0.83 to 0.85, matched independently by the ledger's own 10.4% net suppression. Two further cautions on any figure taken from `~/.rungate/finding-ledger.jsonl`: 41% of its 261 rows are TEST FIXTURES written by the suite to a real user-level path outside any repo, and `overridden` cannot distinguish an agent correcting a wrong refusal from an agent evading a right one — both are DROP to ALLOW with a changed hash. An earlier claim of `8 walk-arounds, 2 by hash-shopping` was RETRACTED after reading the duplicate targets: both verdicts were false positives (#1520 against #1506, #1455 against #1046 — not the same findings), so zero of the three non-label cases are evasions and roughly 2-3 of 10 DUPLICATE verdicts are wrong.

THE FILING GATE'S BYPASS, FOUND BY EXECUTION TWICE. #1605 made COMMENT_INSTEAD unwaivable; the push security review then found that COMMENT_INSTEAD is adjudicated LAST, after NO_CLAIM, so an undeclared AND claimless filing is refused NO_CLAIM, the label waives that, and the unwaivable member is never consulted. Confirmed by running the real hook process against the PR's own head — `Allowed by --label arbiter-override, over a NO_CLAIM refusal`, disposition ISSUE, overridden true — then closed by reading `exemption` off the ATTEMPT instead of keying on whichever refusal fired first, and re-confirmed as `decision: block` on the merged tree. FG-178 was red against the unchanged head before the fix. The repo already held a passing test certifying the bypass: FG-88's old title was, verbatim, *the override label posts a claimless filing, and is counted*.

THREE REPAIRS IN ONE NIGHT EACH LEFT A SIBLING, BECAUSE EACH NAMED A SITE. The waivable tail, then three map-discriminating rows of which one was fixed and two were found by the reviewer, then the NO_CLAIM reason string. #1606 stops repairing sites and asserts the property: FG-179 drives four refusals through the real adjudicator and asserts no reason spells the override token — through the adjudicator rather than a source grep, and the argument for that is an instance from this session, where a grep of main for the advertising string returned 0 while a probe had printed it ten minutes earlier, because the string is assembled across a concatenation.

CRC-N2 AND THE CARRY ANCHOR LANDED AS #1602. The carry is now content-addressed, and the diff-only narrowing is adopted with its checkbox deliberately unticked, because what shipped is a scope WORD and whether the reviewer obeys it is UNMEASURED. Its reach was re-measured per round against the ledger as the carry would have read it at that round: 12 rounds of 333, 3.6%, not the 21% a final-ledger reading suggested. The second chance a full-scope round gives a dropped finding was quantified for the first time — 33 distinct defects dropped, 2 raised again, about 3%.

ALSO CORRECTED: CRC-N4's dedupe is in the CI pin as of the 0.8.5 publish, so the spec's `dormant until the pin moves` is false at three sites — though a cwd of `${RUNNER_TEMP}` means every line lookup fails and the key spaces cannot intersect, so it is live and inert, fail-safe. And the spec's organizing premise — *Anthropic has no review backlog because findings never become backlog; there is no filing step* — is NOT in the source blog post, which never uses the words backlog, tracker or ticket. An adversarial fidelity audit found 1 invented of 56 criteria, 6 dropped (Layer 4 entirely), 5 mis-stated, and all 5 numbers exact.

STILL OPEN AND NOT THIS SESSION'S TO DECIDE: whether rungate's consumer hooks move to PLUGIN delivery. Writing registrations into a consumer's `.claude/settings.local.json` is not a documented mechanism for shipping hooks, and project-scoped hooks are trust-gated there too — so on install today a consumer either grants trust or gets hooks that are silently inert, which is this session's own failure shipped to someone else's machine.

