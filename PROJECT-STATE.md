# Project State

**Current phase: All phases complete**

**Session 34 (2026-10-06)** — #139 and #140 shipped (PR #142 -> ebda1b2f). The GitHub client read GITHUB_TOKEN alone and nothing sets it on this machine, so every Octokit call threw at construction and the TypeScript half of the GitHub architecture had never run. The spec's own D-3 justified the single name with a premise that is false. The consequence that mattered is #140: IssueCloseGuard wrapped its block() in a catch {}, so a failed label read was treated as permission to close — proved by running the same close one environment variable apart. Twelve existence-style SCs were green throughout. Five security rounds on the guard's parser, five real differentials; the fifth is filed as #144 rather than patched, because a regex over a command string cannot be an authorization boundary. #136 and #137 remain the blockers and were not started; #137's root cause is now established as an unimplemented spec decision (D-7). No DDB issue shipped — that step is joint.

Suite: 2663 pass, 0 fail; typecheck 0 diagnostics; CI test + gates + GitGuardian green on ebda1b2f; 39 mutations, 0 survivors (5 survived first pass, all fixed by better tests)
Issues opened: #139, #140, #141, #143, #144
Issues closed: #139, #140

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #137 record-env-and-pr and finalize call mcp__github__* tools that workflow subagents cannot reach, so a run opens no PR and leaves no trace on the tracker. ROOT CAUSE NOW ESTABLISHED: spec decision D-7 (GITHUB-API-MIGRATION-SPEC) already mandates an Octokit fallback when MCP is unavailable, and it was never implemented. No SC covers it, which is why Phase 4 reported green without it. lib/github.ts already has createPR/updatePR/listPRs/addComment. The spec's own constraint says the fallback MUST live at the orchestrator level and NOT inline in agent prompts, so the shape is a script shelled out the way collect-worktree-files.ts is — which also preserves SC-501, since the MCP names must stay in ship.js.
2. P0: #136 ship workflow merges and pushes straight to main, no PR and no pre-merge CI (ship.js:1838-1848, bare `git push`). Worse than filed: the merge runs in the VERIFY phase while PR creation runs later in SHIP (ship.js:2010-2040), so even with #137 fixed the PR would be opened for a branch already on main. ship.js:2047 tells the user 'The PR is open for Jason to review' — a documented false premise. Coupled to #137: this fix needs a working PR path, so do #137 first.
3. P0: #141 scripts/sync-spec-tests.ts reads $HARNESS_ROOT/PAI/Specs and writes to ~/.claude/test/, while lib/paths.ts harnessRoot() resolves to this checkout. Both directories exist, so nothing errors and nothing is generated. NO SC ADDED TO specs/ HAS EVER PRODUCED A TEST. 'SCs without tests are wishes' is defeated mechanically, not by anyone forgetting. gate-executor.ts:393 runs this on every gate.
4. P1: #144 IssueCloseGuard cannot be an authorization boundary — DECISION NEEDED FROM JASON. Five security rounds in one day on one function, each finding a real parser differential, each fixed, each followed by another. A PreToolUse regex over a command string is defeated by gh api -X PATCH, shell aliases, wrapper scripts, and curl, none of which it can see. Options in the issue; recommendation is C — keep the hook as fast feedback and add an outcome-checking job (find issues closed with no workflow-state.json record) as the control actually relied on. The fifth round's findings were NOT individually triaged; I filed the architectural limit instead, per Three Strikes.
5. P1: #143 the guard's fallback repo is the literal 'hornjason/pai-config' — a different repository. A close that names no repo is vetted against whatever issue holds that number over there.
6. P1: #129 rook's FAIL verdict logs a warning and does not block the merge; #127 the no-UI override forces LIGHT tier, which skips rook entirely for every CLI project. Together: the security gate cannot fail a run.
7. P1: #105 harnessRoot() infers from module location. Now has measured harm rather than a suspicion — #141 is an instance of it. Still not attempted unattended: making it strict could wedge a run with nobody watching (premortem 5).
8. P1: security review of ce842a73 — gate-coverage-gap and validator-consumer-differential (lib/scaffold/steps.ts), supply-chain (scripts/scaffold-project.ts).
9. P2: #126 Quinn half still unprovable on this repo (empty pages means LIGHT, and Quinn only runs at STANDARD+). #116 compliance-history records verdicts without rule text, evidence or category.
10. P2: safeGitAddCommand/relativizePaths/buildSafeGitAdd in ship.js have no callers; removal cascades into 4 test files. scripts/scaffold-project.ts 200-line cap is being satisfied by collapsing imports.
11. P3: #55 / #59 / #60 / #61 pipeline testing inner loop; #54 dead code cleanup; #72 consumer tsconfig.
12. WATCH: DRIFT-2 and HYGIENE-3 ratchet lists in .claude/conformity-allowlists.json, plus .claude/typecheck-baseline.json. All three must shrink. A baseline that never moves is a permanent exemption with extra steps.
13. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done — and #139 is now the proof of what that costs. Every SC in GITHUB-API-MIGRATION-SPEC Phases 1-4 asserts a NAME APPEARS IN A FILE. All twelve were green while the client could not authenticate at all.

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

**Session 2026-10-06 session 34:**
- #139 + #140 SHIPPED (PR #142, squashed to ebda1b2f). lib/github.ts authenticated from GITHUB_TOKEN alone and NOTHING on this machine sets it — `gh auth status` reports the account is authenticated via GH_TOKEN. Every Octokit call in the repo therefore threw at construction, which means the TypeScript half of the two-layer GitHub architecture has never once run here. D-3 of GITHUB-API-MIGRATION-SPEC justified the single name with 'Already set by `gh` CLI auth'. That is false — gh reads GH_TOKEN and exports nothing. A design decision rested on an unchecked premise, and no SC in the spec could catch it because every one of them asserts that a name appears in a file. D-3 is corrected in place; Phase 5 (SC-519..528) is the first set of criteria in that spec that can fail.
- The consequence that mattered: hooks/IssueCloseGuard.hook.ts had block() inside a try whose catch was empty, so failing to READ an issue's labels was indistinguishable from reading them and finding none. Measured on the same close of the same p1-labelled issue, one environment variable apart: without a token, a WARNING and exit 0; with one, decision=block. The guard had been decorative for as long as GITHUB_TOKEN was unset. Confirmed afterwards in the real environment — it read #23's labels and blocked.
- Call-site survey of the throw, since the fix changes behaviour everywhere: the prove gate fails loudly and lib/branch-cleanup.ts refuses to delete (both correct, both fail closed); gates/orchestrator.ts:352 drops the shipped label into .catch(() => {}); lib/prior-branch.ts silently stops reusing branches. I first read branch-cleanup as a delete-on-API-error path and was WRONG — it checks prCheck.error at both sites (114-120, 200-205). Corrected in channel and in the PR body rather than left to stand.
- FIVE security rounds on one parse function, every round finding a real differential between the guard and what the gh binary actually does. Checked against the binary instead of reasoning about it: the LAST --repo wins, -R is a real alias, GH_REPO is honoured. Round 3's bypass paired the FIRST issue number with the LAST repo. Round 4's was the detector requiring digits straight after `close`, so `gh issue close --repo a/b 23` matched nothing and the guard stepped aside entirely — a miss, not a wrong answer. An over-matching detector costs a refusal; an under-matching one is silent, so detection is now deliberately loose and the number is read afterwards, refusing when several numbers are candidates. Round 5 was not attempted: filed as #144, because the class is unwinnable from a regex over a command string and five rounds is well past Three Strikes.
- CI caught a real bug in my own security fix. I had restricted GITHUB_API_URL to loopback; GitHub Actions sets GITHUB_API_URL=https://api.github.com on every run, so the whole suite failed in CI while passing locally where the variable is unset. Per 'remove the difference, not the failures' the fix went in the CODE, not the tests: an exact-hostname allowlist of {api.github.com, github.com, loopback}. api.github.com.evil.com and a loopback name in the userinfo are both still refused.
- 39 mutations across the branch, 0 survivors — but FIVE of them survived first time, and each survivor exposed a vacuous test of mine. The empty-token case did not exercise the trim at all ('' is falsy, so it threw on the truthiness check either way); the multi-close count was shielded by the separator check; every command-substitution case was shielded by the literal-slug check; and the comment-template rules had NO coverage whatsoever — mutations neutering the entire validator ran green against 26 existing guard tests. 'Shielded mutation' is the name for this: the mutation survives because a DIFFERENT defence catches the test case, so the test proves nothing about the line it appears to cover.
- SC-371 (150-line hook cap) fired on the result. Fixed the way HOOK-ARCHITECTURE-SPEC asks — commentTemplateViolation() extracted to hooks/lib/comment-template.ts, hook down to 124 lines — not by raising the cap. That extraction is what exposed the untested rules above.
- I also asserted behaviour that did not exist, twice, and corrected the TEST rather than bending the code: prose containing '## AC-1' IS refused (the field rules use an unanchored includes, unlike the anchored AC rule), and a close whose --comment quotes another close is ONE invocation, so my 'ambiguous' expectation was a false positive.
- The fixed guard then blocked my own tooling about four times — any Bash command whose text contains gh/issue/close in order, including commit messages ABOUT the fix. Workaround is git commit -F from a file. Noted because it is the practical cost side of #144's decision.
- Three Explore probes reported #114/#115/#118/#120 as unfixed, quoting line numbers from before the fixes. All four were already merged; only their #105 material was live. Peer and subagent reports are evidence, not fact — verified against the file before acting.
- Filed #139, #140, #141, #143, #144. Evidence added to #105. Merged PR #142. Suite 2663 pass / 0 fail, typecheck 0 errors, CI test + gates + GitGuardian green.
- NOT done, and the reason: #136 and #137 are still the consumer-readiness blockers and neither was started. #144 needs Jason's decision before more work goes into the guard. A DDB issue has NOT been shipped — that was reserved as a joint step.

**Session 2026-10-06 session 33:**
- #65: the whole repo is at ZERO typecheck diagnostics, down from 88. Every fix is at the type level — no @ts-ignore, no @ts-expect-error, no `as any`. Baseline banked at 0 in the same commit, so nothing can regress silently. (Three parallel agents each banked an intermediate value — 76, 63, 39 — in their own worktrees; those are partial counts from before the trees were combined, and 0 is the measured total.)
- Two were dead code the types had already proved unreachable, not type noise: scripts/audit-specs.ts:330 had `closest ? closest.rewrite : REVIEW` INSIDE an `if (!closest)` branch, so the rewrite arm could never run and every unmatched SC got the REVIEW marker regardless; lib/conformity.ts:1931 read `c.files` off a fallow circular-dependency entry whose declared shape has `path` and `chain` and never had `files`.
- One was a real gap, not a cast: scripts/validate-scorer.ts built TranscriptData without promptContent. Several criteria in evaluateCriteria() decide injected-vs-read off that field, so the scorer being validated was scoring those criteria against text that was never there. Now extracts the user turns from the transcript, matching scripts/grade-deterministic.ts.
- lib/post-fix-verify.ts used a top-level-in-function `require('child_process')`, which typed spawnSync's result as any and silently made the whole return value unchecked. Replaced with a real import — same #69 require defect class, caught by types this time rather than at runtime.
- Three identical `.filter(Boolean)` sites (lib/scanner.ts, lib/scaffold/steps.ts, scripts/generate-code-map.ts) — the same copied scanDirs body #91 found duplicated. Fixed in all three; the duplication itself is still open.
- NOT reached: a zero baseline. 76 diagnostics remain, all in test/ (74) and gates/ (2), and 53 of those are the bun-types test.todo defect that needs a package.json bump. Neither test/, gates/ nor package.json was in scope for this change, so the ratchet is banked at the true number rather than a claimed zero.

**Session 2026-10-05 session 32b:**
- #85 CLOSED (PR #97) — pre-push ran conformity in the WORKING TREE, not the commits being pushed. That is how the HYGIENE-3 regression reached main. Now checks out each pushed sha into a detached worktree. The node_modules question #85 left open is answered by comparing lockfiles: symlink when they match (4.9s fast path), bun install --frozen-lockfile when they do not. Cleanup is unconditional so a failed push cannot leak a worktree.
- #74 CLOSED (PR #98) — a slot leaked for the full 420s TTL when a LATER PreToolUse hook blocked the command. Reconcile on acquire using ONLY the zero case: if no bun test is running anywhere, every slot is provably false. Deliberately does not attribute processes to sessions, which #67 established is unreliable. Keeps slots when ps is unreadable; 25s grace covers acquire-before-spawn; TTL remains the backstop.
- #89 CLOSED (PR #99, #100) — the #69 guard stripped template literals with a regex and discarded 60% of ship.js, including buildSafeGitAdd and validateFilePaths, the two helpers #69 is about. Replaced with a tokenizer (37% discarded, all visible). Hardened twice under review: regex literals now collapse to a valid placeholder so the output stays parseable, and the parse check is the independent witness that nothing was eaten.
- #66 CLOSED — already implemented and tested (test/decomposed-ship-dispatch.test.ts, 7 pass). Closes as DONE, not stale.
- #69 IS NOT STALE — the tokenizer immediately exposed nine live top-level require() calls at ship.js:1784-1869. Unlike the original at module scope which killed the run, all nine sit inside try/catch, so require-is-not-defined is swallowed as a WARN and the run reports success. Compliance persistence, compliance history, hill-climb brief patching and transcript re-grading have therefore never run.
- Had #66 and #69 on one list to close as stale. #66 was closeable (done, not stale); #69 is a live defect. Checking before closing was the difference.

