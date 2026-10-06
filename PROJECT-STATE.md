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

**Session 2026-10-05 session 30:**
- #67-A the guard was never guarding. TestSuiteGuard/TestSuiteRelease were registered only in rungate .claude/settings.json. Project settings load from the directory a session STARTED in, so the cap was inert for any session rooted elsewhere, including sessions working on rungate via an added working directory. Moved to ~/.claude/settings.json and REMOVED from project scope — the two are not de-duplicated, so dual registration fires the hook twice and takes two slots per suite.
- Subagent Bash calls reach PreToolUse with the PARENT session id. Proven: the budget counter file an allowed run writes is named with the session transcript id. So hook session_id and transcript sessionId are the same identifier, closing the inference gap in jhorn-8e 292/292 measurement.
- #67-B a slot is one RUNNING SUITE, not one session. Keying on session refused Quinn behind Marcus and surfaced as a test failure rather than a lock collision. Each live suite takes its own slot; release frees exactly one.
- #80 six conformity checks could not fail — computed a result, console.warn, then expect(true).toBe(true). DRIFT-2 is the enforcement of SCs-without-tests-are-wishes and found TEN testable specs with no referencing test, over half the testable surface.
- HYGIENE-4 was reading AGENTS.md for a specs table that lives in .claude/rules/specs-routing.md. Same stale pointer was in CLAUDE.md step 2 of the MANDATORY GATE — every agent in every session was told to find the governing spec in a table that does not exist. Fixed.
- REGRESSION AND ROOT CAUSE: converting HYGIENE-3 turned Gates red on main. buildReferenceIndex recursed into .claude/worktrees/ — 39 full repo copies — so every file looked referenced and nothing was ever an orphan locally, while a clean CI checkout saw three. skipDirs only filtered top-level entries, never the recursive walk. A real failure was seen, not reproduced in isolation, and wrongly dismissed as flake.
- Consumer-facing bug caught by security review: the ratchet allowlist was hardcoded in lib/conformity.ts and lib/scaffold/steps.ts generates a consumer test calling the same functions, so every consumer inherited rungate backlog and could fail its own build over entries in a file it cannot edit. Allowlists now live in <root>/.claude/conformity-allowlists.json, advisory when absent.
- A list that invalidates itself: the allowlist named the files it exempted and the reference index read it, so listing made them non-orphans, which fired the delist assertion, and delisting made them orphans again. Allowlist is now excluded from the index.
- Verified consumer-side by jhorn-5c: agentgrit went 37/1/3 to 40 pass / 1 skip / 0 fail.

**Session 2026-10-05 session 29:**
- COMP-7 BashToolGuard fired in EVERY Claude Code session on the machine — it is registered user-level so it reaches worktree subagents (#45 root cause). Scoped to harnessed projects via a .claude/rungate.json OR .claude/rungate/ marker walk-up. Worktree-only scoping was rejected: ship.js quinn-local and marcus-fix run with isolation undefined, outside any worktree
- Five distinct COMP-7 false positives fixed: non-harness sessions, stdin filters (bun test piped to tail), permissions.deny globs, heredoc bodies scanned as commands, and newlines not treated as segment separators
- Detection extracted to lib/bash-file-read.ts and shared by the hook AND lib/transcript-checker.ts — the grader had used a looser rule than the hook, so it could flag what the hook allowed
- #57 SHIPPED via pipeline (16 agents, 0 regressions). Verified before spawning that SC-1..4 and SC-6 were already done and only SC-5 remained; passed that into goalData so Discovery scoped to the real work
- ship.js staging failed OPEN — safeGitAddCommand fell back to a bare git add on rejection, broadening a detection into staging the whole worktree. Now returns null and all 3 call sites abort with SHIP_FAILED
- acHash was computed inline twice in gates/orchestrator.ts. Both now delegate to computeACHash. The Phase 1 lib helper SORTS and the production code did not, so the extracted function computed a different hash than its source — it had never been wired up, so nothing caught it
- pre-commit secret scan rejected every git commit --amend: empty staged list meant xargs ran grep with no operands, grep read stdin and exited 0. Rewritten to scan the staged diff, which also fixes paths with spaces, error masking, and reading the working tree instead of the staged blob
- Generated CI secret scan had NEVER scanned anything — it used git diff --cached, and CI has no staged index. Possibly one of the 5 DDB #1450 failures
- Allowlist escape closed: the credential exclusion matched anywhere on the line, so a trailing placeholder comment laundered a real secret. grep -o now anchors the exclusion to the value
- postScaffoldCommit did a blanket add and swept unrelated in-progress work into a commit titled 'scaffold: initialize rungate harness' — it hijacked this session's work three times. Now stages only the paths the run reported writing
- A backtick in a comment inside a JS template literal broke scaffold-project.ts and failed 36 tests at once. Added sh -n syntax guards over all generated shell
- #63 fixed rather than deferred: scaffold stripped AGENTS.md frontmatter and the convert-spec row on every re-scaffold. Generator now carries frontmatter forward, refreshing only the updated field
- Model routing: discovery and marcus moved from sonnet to opus. No model IDs are pinned anywhere in the harness — every role uses an alias, so agents were already on Claude 5
- Jason directive: always fix regressions and issues found while working — never defer, never excuse as pre-existing. Saved as a memory
- Jason directive: make routine git/repo-hygiene decisions autonomously — prove safety, act, report. Saved as a memory
- instruction-compliance.test.ts timed out: 257s scan against a 240s beforeAll budget. runTemplateCompliance spawned one npx @reporails/cli per file serially over 32 files, each paying an ~8s cold npx resolve. Now 8-way concurrent — 257.1s to 51.5s
- COMP-7 false positive #6, hit while writing a commit message: `cat > file <<EOF` was blocked as a file read. It is a WRITE. hasFileOperand now parses redirections; input redirection (`cat < file`) stays blocked because that really does read a file
- bunx tsc --noEmit is in the AGENTS.md Commands table but there is no tsconfig.json — tsc printed its help text and exited 0. The documented type check has NEVER checked anything. Running it properly reports 98 errors
- gates/run-gate.ts always exited 0: executeGate is async and was not awaited, so process.exit(undefined) exits 0 and the executor was killed mid-flight. ship-orchestrator runs it through execFileSync, which only throws on non-zero — so every gate invoked that way reported success regardless of outcome
- StaleTTLCleanup hook: cleanupStaleBranches unawaited, so br.deleted.length threw into the surrounding catch and the hook reported nothing wrong. Branch cleanup had never run. Also logged r.message, which is not a field on GapResult
- buildAgentMeta was declared TWICE in lib/create-brief.ts with different parameter shapes. The second won, so the scaffold call site passing harness.roles looked up roles.roles and always got an empty map. Every consumer project's role config was silently discarded in favor of DEFAULT_AGENT_META
- Corrected: today's discovery/marcus opus move appeared to work, but the briefs took it from DEFAULT_AGENT_META, not from rungate.json. Right outcome, wrong mechanism — the config path was dead

