# Project State

**Current phase: All phases complete**

**Session 34 (2026-10-06)** — AFK execution. Five issues closed across four PRs. #139/#140 (PR #142 -> ebda1b2f): lib/github.ts read GITHUB_TOKEN alone and nothing on this machine sets it, so every Octokit call threw at construction and IssueCloseGuard's empty catch turned a failed label read into permission to close. #137 (PR #146 -> 5afb2bb7): 17 call sites moved to scripts/github-op.ts. The filed premise was incomplete — it is not only that no role grants mcp__github__*, the configured server is deprecated on npm and does not connect, so granting a role would not have helped. The PR was opened by the code it adds. #136 (PR #147 -> 99329991): auto-merge to main removed, every push explicit, branch names validated. #141 + #148 (PR #150 -> 64b76f07): the spec generator had been reading ~/.claude/PAI/Specs and writing ~/.claude/test/ on every gate while reporting success, and the SC flipper matched IDs as substrings so SC-144's test ticked SC-1 — including the SPEC-TEMPLATE placeholder, which propagates to every spec generated from it. Two issues filed and left open deliberately: #144 (parser differential, needs a decision) and #149 (the coverage-signal contract, needs review). No DDB issue shipped — joint step.

Suite: 2793 pass, 17 skip, 50 todo, 0 fail under bun scripts/test-clean-env.ts; typecheck 0 errors; CI test + gates + GitGuardian green on every merge. 53 mutations across the session, 0 survivors — 8 survived a first pass and every one of them exposed a vacuous test of mine rather than a weak fix.
Issues opened: #139, #140, #141, #143, #144, #148, #149
Issues closed: #139, #140, #136, #137, #141, #148

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. P1: #149 'a test file mentions the SC ID' is not a sound coverage signal — DECISION NEEDED FROM JASON. #148 removed the substring collision and #150 strips the two fixture shapes, but findTestFilesForSCs still receives IDs with no spec file attached, so it is the one unscoped lookup in a tool that already decided scopedKey(specFile, id) was necessary everywhere else. Two candidate contracts, both repo-wide: a test declares its governing spec, or SC IDs become globally unique and findDuplicateSCIds becomes a gate rather than a printed warning (it also only examines UNCHECKED SCs, so a collision with an already-ticked SC in another spec is invisible to it). Not to be done unattended.
2. P1: #144 IssueCloseGuard cannot be an authorization boundary — DECISION NEEDED FROM JASON. Now seven security rounds on one function, each finding a real differential between the regex and the shell. Recommendation unchanged and now recorded on the issue: take BOTH of options A and C — scope the hook honestly as a speed bump, AND add an outcome-checking job that finds issues closed with no workflow-state.json record. A parser differential is unwinnable; an outcome check does not have to parse anything.
3. P1: #143 the guard's fallback repo is the literal 'hornjason/pai-config' — a different repository. A close that names no repo is vetted against whatever that repo happens to contain. Small, self-contained, and the shape is already proven: parseRepoSlug with no env fallback, ambiguous() when it cannot be read.
4. P1: #129 rook's FAIL verdict logs a warning and does not block the merge; #127 the no-UI override forces LIGHT tier, which skips rook entirely for every CLI project. Together the security gate cannot fail a run. Note the interaction with the #136 fix: ship no longer auto-merges, so a rook FAIL now leaves an unmerged branch — the blast radius shrank, but the gate still cannot say no.
5. P1: #105 harnessRoot() infers from module location. #141 was an instance of it and is now fixed at the call site, not at the root: sync-spec-tests.ts calls harnessRoot() instead of inventing its own default, but harnessRoot() itself still resolves to whichever checkout loaded the code. Still not attempted unattended (premortem 5).
6. P1: security review of ce842a73 — gate-coverage-gap and validator-consumer-differential (lib/scaffold/steps.ts), supply-chain (scripts/scaffold-project.ts).
7. P2: #126 Quinn half still unprovable on this repo (empty pages means LIGHT, and Quinn only runs at STANDARD+). #116 compliance-history records verdicts without the evidence behind them.
8. P2: safeGitAddCommand/relativizePaths/buildSafeGitAdd in ship.js have no callers; removal cascades into 4 test files. scripts/scaffold-project.ts 200-line extraction.
9. P3: #55 / #59 / #60 / #61 pipeline testing inner loop; #54 dead code cleanup; #72 consumer tsconfig.
10. JOINT WITH JASON, NOT TO BE DONE ALONE: pick a Daily Brief Dashboard issue and run it end-to-end through the pipeline. The three P0 blockers that made this impossible (#137, #136, #141) are all closed, so the path is now open — but choosing the issue was explicitly reserved as a joint step.
11. WATCH: DRIFT-2 and HYGIENE-3 ratchet lists in .claude/conformity-allowlists.json, plus .claude/typecheck-baseline.json. All three must shrink. A baseline nobody lowers is a number nobody can interpret.
12. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done. Every SC in GITHUB-API-MIGRATION-SPEC Phases 1-4 asserted that a NAME appears in a file, and all twelve were green while the client could not authenticate and the MCP tools did not exist. #148 is the same shape one layer further out: a criterion certified because an ID appeared in a file. Prefer marker-extraction plus execution over 'file contains X'.

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

**Session 2026-10-06 session 34 (continued):**
- #137 SHIPPED (PR #146 -> 5afb2bb7). The issue said no role grants mcp__github__*. True, and incomplete: the server .mcp.json configures, @modelcontextprotocol/server-github, is deprecated on npm and does not connect, so granting a role would not have fixed it. Scope was 17 sites, not two. D-9 added to GITHUB-API-MIGRATION-SPEC: a workflow step can only run Bash, so the Octokit layer is reached through scripts/github-op.ts — the same shape as collect-worktree-files.ts, which exists for the same sandbox reason (#69). Proof is not a grep: the PR was opened by the code it adds, and a second pr-upsert returned {"number":146,"action":"updated"} against the real API.
- Three security rounds on #137, all three findings real. An issue title is written by whoever files the issue and was being interpolated into a command line — replaced with --title-from-issue, which composes the title inside the process that sends it. The close guard matched `gh issue close` and not the harness's own new path — github-op.ts issue-update --state closed — which is a bypass, not a gap. And a repo slug could steer the request path: measured, --repo "../x" reached GET /x/issues/7, outside /repos/ entirely.
- #136 SHIPPED (PR #147 -> 99329991). The merge-and-push agent is deleted outright rather than guarded. Worse than filed: the merge ran in VERIFY while PR creation ran later in SHIP, so even with #137 fixed the PR would have been opened for a branch already on main, under a line of output that read 'The PR is open for Jason to review'.
- #141 + #148 SHIPPED (PR #150 -> 64b76f07). sync-spec-tests.ts computed its own root (HARNESS_ROOT || ~/.claude) and looked in PAI/Specs. Nothing exports HARNESS_ROOT, both directories exist, so it read a real spec tree and wrote a real test file on every gate and reported success. CORRECTION TO THE FILED PREMISE: fixing the path does not make SCs generate tests, because this generator never did that — it extracts four claim shapes. SC-to-test is sync-sc-status.ts, which always read specs/ correctly. What was lost was claim extraction across 18 specs.
- #148, found while making #141 verifiable: findTestFilesForSCs asked content.includes(id). "SC-1" is a substring of SC-144, so eighteen test files were credited with covering SC-1 and none mentioned it. Any one passing ticked SC-1 wherever unchecked — including specs/SPEC-TEMPLATE.md:190, the literal placeholder, which then propagates to every spec generated from the template. The mistake conceals itself: once an SC reads [x] it leaves findUncheckedSCs and is never examined again.
- The substring fix alone did NOT stop the harm, which is the part worth remembering. Nine files still credited SC-1, all fixture data — and test/spec-compliance.test.ts was using SC-1..SC-5 as local sequence numbers for HARNESS-SKILL-CHAIN.md, a spec with no success criteria at all, silently certifying five unrelated bootstrap criteria. Renamed CHAIN-1..5. The remaining contract problem is #149 and is explicitly NOT patched further: three string heuristics layered on an unsound signal is the same mistake one level out.
- Two defects in detect-sc-drift.ts fixed as a precondition: `contains [a, b]` was searched for as the single literal "a, b", so every multi-keyword SC was reported stale regardless of the file; and `not contains [...]` was read as a positive requirement, so SC-539 was reported stale FOR BEING SATISFIED. Both blocked the flipper, which refuses to flip a stale SC.
- Self-grading caught and reversed: SC-519..543 had been written as [x] by hand. All flipped to [ ] and re-verified by bun scripts/sync-sc-status.ts — 30 flipped by the engine. Strict mode then rejected SC-523 and SC-540 as having no pattern matcher (10 suite failures); both were reworded into matchable shapes rather than exempted.
- Two mutations survived their first pass on the #141 work and each produced a new test rather than a tweak: `import.meta.main` and the module-level root were asserted only as source text, so `if (true) main()` kept the string while still rewriting a tracked file on import. Both are now proven by running the script in a subprocess against a planted sentinel. Source-text assertions keep failing this way — SC-545 is the fourth example this session.
- DELIBERATELY NOT FIXED: two further parser differentials in hooks/lib/utils.ts (security rounds 6 and 7) recorded on #144 with line-continuation evidence instead of patched. Seven rounds on one function is the signal, per Three Strikes.

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

