# Project State

**Current phase: All phases complete**

**Session 31 (2026-10-05)** — #71 closed: CI and local disagreed by 28 tests because 24 of them asked the developer's machine a question a fresh runner cannot answer. Built scripts/test-clean-env.ts, which runs the suite with HOME pointed at an empty directory and GitHub credentials stripped — that one lever reproduced CI's verdict locally and produced the fix list instead of my triage guessing it. Suite now 2196 pass / 0 fail under clean environment. #65/#76 closed alongside it, because they had to be: ci.yml runs bunx tsc --noEmit AFTER bun test, so it had never executed once, and making tests pass would have un-hidden a step that prints help and exits 1.

Suite: 2196 pass, 0 fail under clean env (scripts/test-clean-env.ts); typecheck ratchet at 88
Issues opened: #82, #83, #84, #85
Issues closed: #71, #65, #76, #78 (pending CI confirmation on merge)

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #84 git identity — confirm nothing re-adds the local user override. Source is unproven; the regression test (test/unit/git-identity-isolation.test.ts) asserts the state AND bans untargeted `git config user.*`, but neither proves what wrote it originally.
2. P1: #81 Parallel ship cannot commit — all 11 agents succeeded and the commit phase failed because the file list spans N worktrees but is rebased against only one. Still the autonomy blocker: the work happens and cannot land.
3. P1: #85 pre-push against a clean checkout. Needs a decision: symlink node_modules (fast, but tests the pushed commit against the working tree's deps) vs bun install in the worktree (correct, slow enough that people bypass the hook).
4. P1: #77 ship.js assumes agent worktrees live under projectRoot; Claude Code creates them under the workflow script repo.
5. P1: #73 DIR-L29 budget is a monotonic per-session counter that never decrements. #82 fixed the DETECTION half; the semantics half is open. With subagents sharing the parent id, one pipeline still locks itself out after two suites.
6. P1: #74 A full-suite slot leaks for a full TTL when a DIFFERENT PreToolUse hook blocks the command — PostToolUse never fires for a tool that never ran. Observed with COMP-7.
7. P2: #65 drive the typecheck ratchet down from 88. 54 of those clear on a bun-types upgrade — try that first, it is one line for 61% of the debt. The remaining 34 are real.
8. P2: #83 port the two removed test files to the PAI repo, where the code they test lives.
9. P2: the vacuous-pass cluster found while sweeping for #71 — tests that report green in CI while asserting nothing: test/structure.test.ts ST-2/ST-2b/ST-3 (assert files are ABSENT from ~/.claude, trivially true in CI), gates/e2e-smoke.test.ts:208-231 (early-return and a bare catch{}), test/schema-canary.test.ts:14 (early-returns when another repo is missing). Same defect class as #80.
10. P2: #68 Worktree cleanup has never removed a worktree — 39 stale, 314 MB, and they caused the Gates regression by poisoning the conformity reference index.
11. P2: #70 / #75 Scaffold config divergence — jhorn-5c owns. Phase 1 complete and unpushed, waiting on Jason.
12. P2: #79 Ship workflow Phase 2 deferral writes an issue body that contradicts the ACs it defers.
13. P3: #55 / #59 / #60 / #61 pipeline testing inner loop; #54 dead code cleanup; #72 consumer tsconfig (now partly addressed — the generator no longer emits a typecheck step for consumers without one).
14. CLOSE AS STALE: #66 (parallel dispatch is in main) and #69 (the remaining require( is comment text describing the old bug). Both verified fixed in origin/main.
15. WATCH: DRIFT-2 and HYGIENE-3 ratchet lists in .claude/conformity-allowlists.json, plus the new .claude/typecheck-baseline.json. All three must shrink. A baseline that never moves is just a permanent exemption with extra steps.
16. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done. They certify that code was authored, never that it was adopted.

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

**Session 2026-10-05 session 32b:**
- #85 CLOSED (PR #97) — pre-push ran conformity in the WORKING TREE, not the commits being pushed. That is how the HYGIENE-3 regression reached main. Now checks out each pushed sha into a detached worktree. The node_modules question #85 left open is answered by comparing lockfiles: symlink when they match (4.9s fast path), bun install --frozen-lockfile when they do not. Cleanup is unconditional so a failed push cannot leak a worktree.
- #74 CLOSED (PR #98) — a slot leaked for the full 420s TTL when a LATER PreToolUse hook blocked the command. Reconcile on acquire using ONLY the zero case: if no bun test is running anywhere, every slot is provably false. Deliberately does not attribute processes to sessions, which #67 established is unreliable. Keeps slots when ps is unreadable; 25s grace covers acquire-before-spawn; TTL remains the backstop.
- #89 CLOSED (PR #99, #100) — the #69 guard stripped template literals with a regex and discarded 60% of ship.js, including buildSafeGitAdd and validateFilePaths, the two helpers #69 is about. Replaced with a tokenizer (37% discarded, all visible). Hardened twice under review: regex literals now collapse to a valid placeholder so the output stays parseable, and the parse check is the independent witness that nothing was eaten.
- #66 CLOSED — already implemented and tested (test/decomposed-ship-dispatch.test.ts, 7 pass). Closes as DONE, not stale.
- #69 IS NOT STALE — the tokenizer immediately exposed nine live top-level require() calls at ship.js:1784-1869. Unlike the original at module scope which killed the run, all nine sit inside try/catch, so require-is-not-defined is swallowed as a WARN and the run reports success. Compliance persistence, compliance history, hill-climb brief patching and transcript re-grading have therefore never run.
- Had #66 and #69 on one list to close as stale. #66 was closeable (done, not stale); #69 is a live defect. Checking before closing was the difference.

**Session 2026-10-05 session 32:**
- #81 CLOSED (PR #93) — the parallel-ship autonomy blocker. ship.js flattened all N agents filesChanged and kept only the LAST worktreePath, so the other N-1 agents paths stayed absolute and buildSafeGitAdd correctly rejected them. Run wf_5e32e9d4-dd2 lost 11 agents, 612k tokens, 37 minutes. lib/worktree-collect.ts keeps the file-to-worktree pairing; scripts/collect-worktree-files.ts bridges the #69 sandbox.
- #81 security: six rounds of review. The one that mattered — every path check validated src against group.worktreePath and NOTHING validated group.worktreePath, which is agent-reported. worktreePath=/ made every file on the machine inside the worktree; dest stayed in the repo, so the payload was reading any file on disk INTO the repo, then committed and pushed to a public remote. Demonstrated: copied [tmp/secret.txt] containing TOPSECRET. Four prior rounds of symlink hardening missed it because each asked whether the path was inside the root and none asked whose root it was.
- #81 also fixed: hard links defeated every symlink check (lstat sees a regular file, path genuinely inside, only nlink gives it away); mkdirSync ran BEFORE the containment check so a refusal still created dirs outside the root; the agent reply was parsed into git add, putting an LLM inside a path boundary — the script now stages what it validated, in one process.
- #91 CLOSED (PR #94) — docs-routing counts were shallow, not stale. reference/ advertised (0 files) while holding 19, three of them specs. The auditor diagnosed it as drift; it never drifts, it is recomputed every scaffold and was correct-by-construction. Fixing lib/scanner.ts changed NO output: lib/scaffold/steps.ts:334-378 is a second complete copy of scanDocRouting and is the one that runs. Tests passed against the copy nobody calls.
- #92 CLOSED (PR #95) — prompt-immutability used ls -lO, a BSD flag, on ubuntu-latest CI where GNU ls exits 2; the result.ok guard then skipped the body. Every green CI run in this repo history passed it without evaluating a file. Simultaneously failed in every fresh worktree, because chflags is metadata git does not track. Its remedy, gates/lock-prompts.sh, does not exist and nothing in the repo calls chflags. Replaced with a committed checksum baseline — the git-diff fix was rejected because in CI the working tree IS HEAD, so it could never fail there either.
- Self-inflicted and caught: the worktree allow-list I merged in #93 derived from PROJECT_ROOT, which is the assumption #77 documents as wrong. Agent worktrees live under harnessRoot; they diverge exactly when shipping from a dedicated worktree, the case parallel collection exists for. Would have turned #81 from cannot-commit into refuses-to-commit. Reproduced and fixed with variadic bases.
- FILED: #90 (scaffold migrates projects onto .claude/rungate/ but 4 of 6 readers only understand the monolith — gate-executor, brief-assembler, ship-orchestrator, scanner; this repo has BOTH layouts so the stale monolith masks it), #91, #92.
- Durable: .claude/agents/auditor.md — post-completion reviewer that grades the repo guidance rather than the agent, via a mechanical sweep of all rules. First run on 4ec1196e produced #90, #91, #92. Two of its three diagnoses were wrong on cause while right on symptom; verify before acting on them.

**Session 2026-10-05 session 31:**
- #71 root-caused to 6 causes, all 28 failures reconciled: $HOME/.pai hooks (10), live gh API (6), git identity/default branch in fixtures (7), stale $HOME/.claude/.gate-salt path (1), $HOME/Projects/rungate checkout path in contract fixtures (3), 5s timeout on tests doing two scaffolds (1)
- The lever, not the patches: 24 of 28 were one defect — the test reads developer machine state. scripts/test-clean-env.ts makes that mechanically detectable instead of discovered-in-CI. Proved it before planning against it: 0 fail with real HOME, 11 fail with an empty one
- #82 found and fixed mid-task: TestSuiteGuard counted line-continued targeted runs as full-suite. splitTopLevel split on every \n without honouring a trailing backslash, so `bun test \` stranded its paths and failed closed. It burned the DIR-L29 budget on cheap runs and then locked this session out of the suite while working on #71
- #83: test/unit/skill-{sequence-logger,cooccurrence}.test.ts removed. They test SkillSequenceLogger.hook.ts (~/.pai/hooks) and SkillCooccurrence.ts (~/.claude/PAI/Tools) — grep finds zero references to either in rungate. The migration manifest confirmed it: both were migrated INTO rungate from ~/.claude and brought their $HOME dependency with them. Not skipped — a skipIf here is a test that reports green while verifying nothing
- #84 HIGH: rungate's own .git/config had user.name=Test / user.email=test@test.com. Local beats global, so every commit on main — all of yesterday's and today's merges — is authored as 'Test', not Jason. Override removed; history NOT rewritten (those commits are pushed). Source unproven; all 13 evals/*/scaffold.sh wrote identity with no cwd and no -C, now guarded
- #85: pre-push tests the working tree, not the pushed commit — the direct cause of the Gates regression on 2026-10-05. Clean-worktree version needs a node_modules decision, so it is filed, not half-built. Meanwhile the hook stopped piping stderr to /dev/null (it discarded the only output explaining the failure) and the generator stopped refusing to update an existing hook, which had frozen it forever
- #65/#76: tsconfig.json added — the documented type check had never checked anything. 88 errors, of which 54 are ONE upstream defect: bun-types 1.4.2 types test.todo as requiring a function while Bun accepts a bare label. 34 are ours. scripts/typecheck.ts ratchets both directions (fails on increase AND on un-banked progress), verified in all three states
- Consumer safety: the ci.yml generator emitted `bunx tsc --noEmit` unconditionally, so every scaffolded consumer without a tsconfig got a CI step that could only fail, over a file rungate never created for them. Now conditional on tsconfig.json, and on scripts/typecheck.ts for the ratchet form
- Order-dependency fixed: gates/.gate-salt is gitignored and was created as a side effect of generateHmac, so 8 adversarial tests passed only when orchestrator.test.ts happened to run first — readdir order, not alphabetical on ext4. Extracted ensureGateSalt() to lib/paths.ts; deliberately NOT used by witness.ts, where a missing salt must fail rather than mint a new one
- #78 closed as a side effect: re-scaffolding corrected docs-routing.md from '0 ADRs' to 1
- Caught and unwound: postScaffoldCommit swept my staged `git rm` deletions into a commit titled 'scaffold: regenerate harness files'. Same hijacking as session 29. Soft-reset before push

