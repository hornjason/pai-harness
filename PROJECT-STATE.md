# Project State

**Current phase: All phases complete**

**Session 43 (2026-10-14)** — Three merges, and the defect class found itself twice inside its own fix. #393 (47896439) closed #229 — claimKey normalised with three ANCHORED regexes, so a mid-path `.` survived as a key distinct from the same file's other spelling: worktree A claims `a/b.ts`, B claims and reports `a/./b.ts`, the audit scores both uncontested and the collector resolves B onto A's file. One rule over segments replaced the three. `..` is still REFUSED rather than collapsed, because a `.` segment can never be a symlink and a `..` segment can, so collapsing it would reintroduce the exact textual-vs-realpath differential the issue exists to close. SC-1 as written is therefore unmet BY DESIGN and the amendment needs a ruling — now deferred three times rather than taken silently. #394 (a491fcf8) closed #392, filed during #229 when sync-sc-status ticked SC-388 in SCAFFOLD-DECOMPOSITION-SPEC.md — a criterion that is false — on the strength of a comment saying GATE-CONTRACTS-SPEC.md in as many words. Two defects: the registry read only checkbox declarations, so ten `### SC-N:` headings were invisible and ten ids read as unique while two specs declared each; and nextSCNumber allocated from ONE spec's content, which in a global namespace is not an allocator but the collision generator that produced all ten. #396 (a94fe897) closed #327 — the eight ticks #149 left unproven. Five were false and are unticked; behind them, 748 ticked criteria with 161 having no cover of any kind, now banked per spec and ratcheting both ways. TWICE the class appeared inside the fix: #392's first draft returned headings from parseScDeclarations, which IS extractSCs, so ten section titles became criteria the conformity engine tried to satisfy; and #327 classified SC-502 satisfied off a grep that could not see `execSync(` with its command on the next line — gates/workflow.test.ts:1570 shells out to gh and the tick had covered it for its whole life (filed #395). Four mutations scored zero and each was closed rather than explained away; one could not be made to fail at all until the comparison was extracted as ONE binding both call sites drive, which is the sharpest version of the rule: a second assertion of the same property elsewhere does not make a mutation measurable. Suite 8138 → 8269, 0 fail, every delta reconciled by arithmetic — including correcting the conformity rate, which is 1 test per SC run in five places rather than 5 in one.

Suite: 8269 pass, 0 fail, 13 skip, 474 todo — typecheck 0 errors
Issues opened: 392,395
Issues closed: 229,392,327

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0 CRITICAL PATH TO PHASE C (measured 2026-10-11, see #274) — the order below is forced by dependencies, not preference. Every rungate self-run is rewritten to LIGHT by workflows/ship.js:1705 because the repo's own config sets pages:{}, so the scope gate, Quinn local, Quinn verify, prove and the remote pre-flight have NEVER executed here. DailyBriefDashboard configures 18 pages and enters all five on its first run.
2. P0.1: #273 — DONE, merged eba80415 (PR #284). Six phase-ordering checks in test/spec-compliance.test.ts asserted on COMMENTS. Verified on main by the mutation that defined it: gutting the PR step out of ship.js while leaving its comment at :4338 gave 6 pass / 0 fail before and gives 4 pass / 2 fail after. The converse also holds — rewording three phase banner comments with no code change leaves all six green, which is the false red that had refused #254 four times.
3. P0.2: #276 — DONE, merged d0d10478 (PR #286). A skipped scope gate reported PASS and an unreported one reported SKIPPED. scopeVerdictFor(ran, result) is now a marked block, executed over all four reachable states: never executed -> SKIPPED, ran+PASS -> PASS, ran+FAIL -> FAIL, ran and reported nothing -> FAIL. That last row is stricter than the issue asked for and is the fail-closed direction. SC-673..678. Mutations: PASS initialiser restored alone 5 of 25 red; whole pre-fix shape 8 of 25; refusal moved below the operator log 2 of 25. SC-677 exists only because a mutation came back green — a fixed assembly order ran the refusal first wherever the file put it, so the ordering assertion passed vacuously until the extracted statements were sorted by source index.
4. P0.3: #185 — DONE, merged e313187f (PR #290). Prior-branch detection nominated branches behind main because commitCount only counts forward, and ship.js:2931 made any nomination the push target with no currency check and no testsPass guard. For #254 it nominated run/254-wf19f7def7-rescue, a #228 preservation branch whose tip message reads 'NOT reviewed, do not merge', 8 behind main, whose remote ref was not an ancestor of main — a guaranteed non-fast-forward. Now: divergenceFromBase takes both sides from one rev-list --left-right; mergedIntoBase answers via git merge-tree --write-tree (an in-memory merge that adds nothing) rather than git cherry, whose patch-ids a squash defeats; isHarnessScratchRef excludes every harness namespace; and priorBranchCurrency refuses an UNMEASURED nomination as well as a stale one. Verified on merged main: detection for 254 returns null.
5. P0.4: #254 — DONE, merged 333a199e (PR #291), on the sixth attempt. Exactly one github-op.ts pr-upsert call site, below the container conditional; both arms reduced to label: 'record-env'. Proven by reintroducing the defect rather than trusting the suite's own mutant: overwriting workflows/ship.js with main's pre-fix copy turns the new suite 10 of 14 red, and restoring it returns 14 pass / 0 fail. This unblocks the container path DDB's 7776-before-7777 rule requires. Five earlier attempts, five different blockers, every one found by attempting a run rather than reading the code — including a TDD_SEQUENCE_VIOLATED refusal that was CORRECT (source at step 17, test at step 36) and so was redone test-first rather than merged by hand.
6. P0.5: #215 DONE, merged 5ccff31a. #274 STILL OPEN after three attempts and is NOT blocked on its own difficulty — all three runs produced correct work and lost it at Commit to the collection claim guard. Attempt 1 I stopped myself: the issue's own site map is wrong, listing remote pre-flight as one of five tier-gated subsystems when it sits ~450 lines BEFORE ceremonyTier is first read, so no tier change can make it run; container verify is the real fifth. Attempts 2 and 3 died on unclaimed files — project-state.json, then .claude/conformity-allowlists.json and gates/workflow.test.ts. 4,855 lines preserved across eight worktree-* branches, all intact. Attempt 4 (wf_b3714a40-bb7) points at those branches rather than re-deriving.
7. P0.6: #296 DONE, merged 312b420b + c870f520, and it was the real blocker under #274. The claim guard refused correctly every time; the fault was that claims come from the decomposition plan (ship.js, claimedFiles: r.subIssue?.filesToModify), written BEFORE the work exists, so no plan can claim a shared registry the repo's own pre-push hook demands every contributor touch. Two ownership classes now sit AHEAD of the single-worktree exemption: CO_OWNED (collectable when one worktree wrote it, refused when two did) and DA_OWNED (never writable from a worktree). Measured rather than asserted: restoring the claimant===null fallthrough turns 8 of 64 red, and widening CO_OWNED_FILES by two arbitrary files turns 3 of 64 red — so the exemption set's own membership is pinned. CLAUDE.md and key-files.md stopped telling agents to write PROJECT-STATE.md, which is what killed attempt 2: the more obedient the agent, the likelier the run died.
8. P0.6: THEN add DDB container config (rebuildCommand 'make build && make test-down && make test-up', hosts ['localhost'], port 7776) and run one DDB issue. Not before — and never a config that hands `make rebuild` to an agent; DDB's CLAUDE.md forbids it and the Makefile has a worktree guard.
9. NEEDS JASON: rotate GH_TOKEN. A value was printed into a session transcript by an echo. Never committed (GitGuardian green on every merge) but rotation is recommended. Outstanding since 2026-10-10.
10. NEEDS JASON — JOINT, NOT TO BE DONE ALONE: pick a DailyBriefDashboard issue and run it end to end. The blockers originally named here are closed (#129, #127, #162). The current ones are the P0 chain above, and the honest statement of readiness is that no run against this repo has ever exercised the ceremony path a DDB run takes (#274).
11. P1: #174 — code-pushed inspects projectRoot, never the issue branch. Cost one full run already
12. P1: #168 — test-clean-env.ts gives a false green; it models the environment, not the CI checkout
13. P1: #149 'a test file mentions the SC ID' is not a sound coverage signal — DECISION NEEDED FROM JASON. #148 removed the substring collision and #150 strips the two fixture shapes, but findTestFilesForSCs receives IDs with no spec file attached, so it is the one unscoped lookup in a tool that already decided scopedKey(specFile, id) was necessary everywhere else. Two candidate contracts, both repo-wide: a test declares its governing spec, or SC IDs become globally unique and findDuplicateSCIds becomes a gate rather than a printed warning.
14. P1: #144 IssueCloseGuard cannot be an authorization boundary — DECISION NEEDED FROM JASON. Seven security rounds on one function. Recommendation on the issue: take BOTH options A and C — scope the hook honestly as a speed bump, AND add an outcome-checking job that finds issues closed with no workflow-state.json record. An outcome check does not have to parse anything.
15. P1: #158 detect-sc-drift applies a statement's keywords to EVERY path it mentions, so a two-file SC cannot be flipped even when both halves pass. Third defect in that function this week, and the SAME SHAPE bit again on 2026-10-07 in test/harness-standard-security.test.ts, which banned the words 'size' and 'conditional' near any mention of rook and so read the sentence 'Not conditional on size' as the violation. A statement parsed as a bag of tokens rather than a sequence of clauses. Fixed in that one test with a negation stripper and a positive control; the detector itself is still wrong.
16. P1: #152 re-scaffold does not repair agent-brief frontmatter drift, so AGENT-8's documented remedy exits 0 and changes nothing. Three mechanisms disagree — the check says re-scaffold, the scaffold declines, harness-managed.md forbids editing the brief.
17. P1: security review of ce842a73 — gate-coverage-gap and validator-consumer-differential (lib/scaffold/steps.ts), supply-chain (scripts/scaffold-project.ts).
18. P2: #79 Phase 2 deferral — NARROWED on 2026-10-07 and no longer 'deferral writes pointers'. #160 is the counter-example: real criteria, a pre-empted cheat ('running the script is the evidence'), and a load-bearing dependency note. The defect is (a) the carry-over is POSITIONAL — whatever sorts past the 6-AC cap — and (b) when what sorts last is a GATE on the parent's work (typecheck 0, suite 0 fail) there is nothing to restate, which is how #153 closed empty. Second mechanical catch: a deferred criterion that is a gate on the parent should block the split, not produce an issue.
19. P2: safeGitAddCommand/relativizePaths/buildSafeGitAdd in ship.js have no callers; removal cascades into 4 test files. scripts/scaffold-project.ts 200-line extraction.
20. WATCH: DRIFT-2 untestedSpecs ratchet is at 7. Plus HYGIENE-3 and .claude/typecheck-baseline.json. detect-sc-drift reports 12 drifted / 9 stale, of which SC-503 (ship.js, [ac.length]) pre-dates today and is not a regression.
21. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done. EVERY mutation that survived a first pass on 2026-10-06 was a source-text assertion. Prefer marker-extraction plus execution — test/security-verdict-blocks.test.ts and test/ship-collect-destination.test.ts are the worked examples, and test/rook-review-scope.test.ts is the worked example for a script whose job is to exit non-zero.
22. P3: #59 / #60 / #61 pipeline testing inner loop (re-scope #59 and #60 against what #235 and #227 already delivered); #87 consumer typecheck; #42 / #44 / #46 scaffold and CI gates. Previously filed under #55 and #54, both closed.

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

**Session 2026-10-14 session 42 (Four merges, one defect class and its mirror: a check whose verdict does not depend on the code under test. #3…):**
- Four merges, one defect class and its mirror: a check whose verdict does not depend on the code under test. #386 (c814f2b0) closed #217 — an acceptance criterion whose evidence can never satisfy its own threshold is now REFUSED rather than silently repaired, because a repaired AC is a changed acceptance criterion nobody reviewed. Three refusal shapes: a quantifier a BRE reads as a literal, a count compared as text, and a count of counts. #387 (0c08616e) closed #280 — evidence pre-validation is retaken at ship instead of inherited from verify, with one function deciding which gates take it. #388 (0c0c9fe2) closed #244 — a stale security FAIL could not be re-reviewed, so runs refused on findings about code the branch had moved past; the fix is scoped (a stale PASS re-reviews by diff, a stale FAIL gets a FULL review) and a 273-case parity matrix between ship.js's inlined copy and the library found a real divergence on its first run. #389 (e72fcf46) closed #223 — issue #209 was shipped TWICE (45 minutes, 20 agents, 911k tokens, two divergent PRs) because prior-work detection looked for the issue number in BRANCH NAMES and the harness names its own branches worktree-wf_…; detectExistingPR had no caller at all, matched a PR's own number against the issue, read 10 PRs, and swallowed every API error as 'no existing PR'. Security review of that commit then found the fix had REBUILT the fail-open one layer up — an optional reply schema meant an agent reporting {} reported 'no open PR' — plus two args reaching a shell through three nesting levels. Both fixed in 654d81a7 before merge. Twice in two days the same lesson at a new address: the thing added to close a value-collapse is the most likely place for the next one.

**Session 2026-10-13 session 41 (Eight merges across two days, one defect class throughout: a check that passed because of what it never looked at, and i…):**
- Eight merges across two days, one defect class throughout: a check that passed because of what it never looked at, and its mirror — a failure nobody could act on. #347 (87db58c9) closed #277/#343/#344. #348 (f180fe05) #287 COMP-4 required both a shasum and a hash edit. #349 (751522e4) #194 the run ceiling was per-worker only; the hook never passed a runId. #350 (07a95956) #195 the blocking-grade check believed the agent's summary. #351 (90a5ea13) #197 the scope gate printed SPEC DRIFT with an empty failure list for every fixture project; a review of the fix found three more fail-opens inside it. #353 (659216c3) #168 test-clean-env.ts stripped the environment and ran in the developer's checkout, so it reported clean on a tree CI failed; the CI checkout is now parsed from ci.yml and modelled, and a review found an argument injection in the refspec path. #355 (4acfb349) #354 the project-state renderer crashed with a raw TypeError where a refusal belonged. #346 the prove gate recorded liveness UNMEASURED and nothing read it — a control replaced by an unread field is still removed. Filed #352 (SC id collisions) and #354. Recorded a second sighting on #323. Twice in one session the same lesson: 'the check runs before the write' is not 'the check prevents the write'.

**Session 2026-10-12 session 39 (the harness hardcodes one consumer and the guards that should have caught it could not fail):**
- Four merges, one defect class: the harness hardcodes one consumer and the guards that should have caught it could not fail. #213 (adab597c) verified-push — a push that left work local now records WHY, with an outcome type per reason. #315 (PR #340) code-committed was keyed to `codeCommittedPaths`, a config key nothing authors, so the check confirming shipped work is committed had never run; evidence-target-valid was deleted rather than fixed because it had no assertion at all. #299 (d078026e) the DocHygiene hook rebuilt frontmatter from four required keys and discarded the rest, deleting the `description:` field that rules are surfaced by — one file per edit, nothing red. #304 (8fd4465d) the dev-server liveness probe curled a hardcoded /api/admin/health; the issue named one site, the grep it asked for found five. MID-SESSION POLICY CHANGE at Jason's direction: stop filing follow-ups for defects uncovered while fixing a defect — fix them in place, same PR. Measured driver: 202 issues opened vs 147 closed over 14 days, 88 of the 202 self-filed. #343/#344 were filed under the old policy and then fixed under the new one, landing with #277 in PR #347 (87db58c9).

