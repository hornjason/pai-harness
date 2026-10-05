# Project State

**Current phase: All phases complete**

**Session 30 (2026-10-05)** — The #67 full-suite guard merged yesterday was never actually guarding: registered only in rungate project settings, so it was inert for every session not rooted in the repo. Fixed scope and ownership unit, then swept a third defect variant — six conformity checks that computed a real result and asserted expect(true).toBe(true). Converting them turned Gates red; root cause was buildReferenceIndex recursing into 39 worktree copies, which is why the check could never fail locally and always failed in CI.

Suite: 2166 pass, 0 fail locally — but CI is 2033 pass, 29 fail (#71 unresolved; local and CI still disagree)
Issues opened: #73, #74, #76, #78, #80
Issues closed: #67, #80

Read this before anything else. Two things on main are green and one is not: Gates passes, the local suite passes, and CI does not — 2033 pass / 29 fail, unchanged all day (#71). Treat any "suite green" claim as local-only until that closes.

Pattern of the week, found five separate ways: checks that confirm code EXISTS rather than that it WORKS.
  - test/workflow-security-integration.test.ts asserted ship.js contained the broken require() — the test enforced the defect (#69)
  - SC-478 / SC-479 / SC-511 are source-text existence assertions, still marked done, satisfied by code with zero production callers
  - Six conformity checks computed a real result then asserted expect(true).toBe(true) (#80)
  - A matcher named test-passes generated SCs reading "bun test passes" that asserted nothing — removed
  - docs-routing.md reports 0 ADRs while ADR-001 is on main (#78)

The sharpest consequence: CLAUDE.md step 2 of the MANDATORY GATE told every agent to find the governing spec in a Specs table in AGENTS.md. That table does not exist — it lives in .claude/rules/specs-routing.md. Every agent in every session either skipped the step or invented a substitute. Fixed this session, and it is a plausible common cause of agents missing governing specs and ADRs.

Local and CI diverge for a structural reason worth remembering: lib/conformity.ts scanned .claude/worktrees/, which holds full repo copies (39 of them, 314 MB, #68). Every file looked referenced locally and nothing did in CI. When a file-scanning check disagrees with CI, ask what extra files the local tree has before reaching for "flaky".
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #71 CI and local disagree by 29 tests — CI is 2033 pass / 29 fail on ee48cc84 while local is green. Every suite-green claim, including todays two merges, was measured against a suite CI does not agree with. Clusters: SkillSequenceLogger (10), SkillCooccurrence (10), precompute-goal / parallel-ship / contract / context (6 each). All look like machine-local ~/.claude dependencies absent in CI. Until this lands no gate means anything.
2. P0: #65 / #76 Type check has never run — no tsconfig.json, 88 errors behind it. AGENTS.md documents bunx tsc --noEmit as THE type check and it cannot succeed. #72 covers generating one for consumers.
3. P1: #81 Parallel ship cannot commit — all 11 agents succeeded and the commit phase failed because the file list spans N worktrees but is rebased against only one. This is the autonomy blocker: the work happens and cannot land.
4. P1: #77 ship.js assumes agent worktrees live under projectRoot; Claude Code creates them under the workflow script repo.
5. P1: #73 DIR-L29 budget is a monotonic per-session counter that never decrements. With subagents sharing the parent id, one pipeline locks itself out after two suites. Needs a decision on what the budget means.
6. P1: #74 A full-suite slot leaks for a full TTL when a DIFFERENT PreToolUse hook blocks the command — PostToolUse never fires for a tool that never ran. Observed with COMP-7.
7. P2: #70 / #75 Scaffold config divergence — jhorn-5c owns. Phase 1 complete and unpushed, waiting on Jason.
8. P2: #68 Worktree cleanup has never removed a worktree — now 39 stale, 314 MB, and they caused the Gates regression this session by poisoning the conformity reference index. Second symptom raises priority.
9. P2: #78 docs-routing.md reports 0 ADRs while ADR-001 is on main — generated counts have no drift check.
10. P2: #79 Ship workflow Phase 2 deferral writes an issue body that contradicts the ACs it defers.
11. P3: #55 / #59 / #60 / #61 pipeline testing inner loop; #54 dead code cleanup; #72 consumer tsconfig.
12. CLOSE AS STALE: #66 (parallel dispatch is in main) and #69 (the remaining require( is comment text describing the old bug). Both verified fixed in origin/main.
13. WATCH: DRIFT-2 and HYGIENE-3 ratchet lists in .claude/conformity-allowlists.json. Both must shrink to empty. CONFIG-DIRECTORY-STRUCTURE-SPEC must leave the untested list before SC-478/479 are rewritten as behavioral assertions, or they are honest assertions nothing executes.
14. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done. They certify that code was authored, never that it was adopted.

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

**Session 2026-09-24 session 13:**
- Ship-and-heal dogfood: #585 shipped (HEALED), #591 shipped (HEALED)
- Grading pipeline shipped: transcript path fix, role filtering, remediation flow
- Violation categorization: quality vs process (SC-465-468)
- analyze-transcript.ts: file efficiency, deliverable ratio, test runs, context growth

