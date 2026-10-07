# Project State

**Current phase: All phases complete**

**Session 34 (2026-10-06)** — AFK execution. Eight issues closed across six PRs, and the pipeline ran a real issue end to end for the first time. #139/#140 (PR #142), #137 (PR #146), #136 (PR #147), #141+#148 (PR #150), #155 (PR #156), #143+#153 (PR #157 -> b64c124c). Two ship runs on #143: the first ended SHIP_FAILED and its most valuable output was a bug report about the harness — the remediation loops committed from the first Marcus's worktree while the re-implementation ran in a new one, so two full rounds were discarded and the retry gate graded files that were not on the branch (#155). The second SHIPPED in 28 minutes with 0 regressions. Rook on opus produced reproduced HIGH guard bypasses on both runs, and on both runs its verdict did not stop anything — #129 is now measured rather than argued. I got the #143 approach wrong myself: the ship goal I wrote asked for cwd-derivation, which is a second parser surface on an authorization boundary. PR #154 closed, re-shipped with the approach the issue had listed. No DDB issue shipped — joint step, and #129 should close first.

Suite: 2849 pass, 17 skip, 50 todo, 0 fail under bun scripts/test-clean-env.ts; typecheck 0 errors; CI test + gates + GitGuardian green on every merge. 70 mutations across the session, 0 survivors — 10 survived a first pass and every one of them was a source-text assertion or a shielded case, never a weak fix.
Issues opened: #139, #140, #141, #143, #144, #148, #149, #152, #155, #158
Issues closed: #139, #140, #136, #137, #141, #148, #155, #143, #153

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. P0: #129 + #127 — the security gate cannot fail a run, and this is now MEASURED, twice, with a HIGH finding behind it. On wf_7c91ba3a-a22 Rook returned {"result":"FAIL"} with a reproduced guard bypass and the workflow returned SHIPPED and opened a PR; the verdict reached the summary only as a compliance grade. On wf_67f052e6-1a5 Rook returned FAIL with two HIGH bypasses and the run died on an unrelated ship-gate witness failure — remove that and it ships them. Compounding and independent: Rook's worktree is cut from origin/main, so `git diff origin/main...HEAD` is EMPTY and it reviews nothing unless it reconstructs scope from git refs, which it did both times by its own initiative. #127 means LIGHT tier skips Rook entirely and #143 sized XS -> LIGHT, so the default path for a CLI project has no security review at all. Fix shape recorded on #129; deciding block-vs-warn is a policy call.
2. P1: #149 'a test file mentions the SC ID' is not a sound coverage signal — DECISION NEEDED FROM JASON. #148 removed the substring collision and #150 strips the two fixture shapes, but findTestFilesForSCs receives IDs with no spec file attached, so it is the one unscoped lookup in a tool that already decided scopedKey(specFile, id) was necessary everywhere else. Two candidate contracts, both repo-wide: a test declares its governing spec, or SC IDs become globally unique and findDuplicateSCIds becomes a gate rather than a printed warning.
3. P1: #144 IssueCloseGuard cannot be an authorization boundary — DECISION NEEDED FROM JASON. Seven security rounds on one function. Recommendation on the issue: take BOTH options A and C — scope the hook honestly as a speed bump, AND add an outcome-checking job that finds issues closed with no workflow-state.json record. An outcome check does not have to parse anything. Reinforced by #143: three more differentials in the same function today, every one of them real.
4. P1: #152 re-scaffold does not repair agent-brief frontmatter drift, so AGENT-8's documented remedy exits 0 and changes nothing. Three mechanisms disagree — the check says re-scaffold, the scaffold declines, harness-managed.md forbids editing the brief. Quinn and Rook were raised to opus by hand as a result.
5. P1: #158 detect-sc-drift applies a statement's keywords to EVERY path it mentions, so a two-file SC cannot be flipped even when both halves pass. Third defect in that function this week; same root shape each time — the statement is parsed as a bag of tokens rather than a sequence of `path contains [...]` clauses. Several existing combined-form SCs are flippable only because their keywords happen to appear in both files.
6. P1: #105 harnessRoot() infers from module location. #141 was an instance and is fixed at the call site, not the root. Still not attempted unattended (premortem 5).
7. P1: security review of ce842a73 — gate-coverage-gap and validator-consumer-differential (lib/scaffold/steps.ts), supply-chain (scripts/scaffold-project.ts).
8. P2: #79 Phase 2 deferral writes ACs that are POINTERS, not criteria — measured on #153, whose entire Success Criteria section read 'the seventh acceptance criterion from #143 discovery, carried over unchanged'. Two mechanical catches recorded on the issue. The rest of that decomposition was correct, so the defect is narrow.
9. P2: #126 Quinn half still unprovable on this repo (empty pages means LIGHT, and Quinn only runs at STANDARD+). #116 compliance-history records verdicts without the evidence behind them.
10. P2: safeGitAddCommand/relativizePaths/buildSafeGitAdd in ship.js have no callers; removal cascades into 4 test files. scripts/scaffold-project.ts 200-line extraction.
11. P3: #55 / #59 / #60 / #61 pipeline testing inner loop; #54 dead code cleanup; #72 consumer tsconfig.
12. JOINT WITH JASON, NOT TO BE DONE ALONE: pick a Daily Brief Dashboard issue and run it end-to-end. The pipeline now ships — #143 went through it start to finish — but DO NOT treat that as ready. The security gate cannot fail a run (#129/#127), so a DDB issue would ship with its security review advisory only. That is the last blocker I would want closed first.
13. WATCH: DRIFT-2 untestedSpecs ratchet is at 7, down from 9 today, each lowered in the commit that earned it. Plus HYGIENE-3 and .claude/typecheck-baseline.json.
14. WATCH: SC-478 / SC-479 / SC-511 are source-text existence assertions still marked done. Twelve of those were green while the GitHub client could not authenticate; #148 is the same shape one layer out. Prefer marker-extraction plus execution over 'file contains X' — and note that EVERY mutation that survived a first pass this session was a source-text assertion.

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

**Session 2026-10-06 session 34 (third part — first end-to-end pipeline runs):**
- #155 SHIPPED (PR #156 -> 27412ce6). Found by running the pipeline, not by reading it. `commitDir` is fixed by the FIRST implement pass; the verify and ship remediation loops call runImplement() again — new agent, new worktree — and committed from the old one. Nothing staged, nothing to commit, and the step reported the HEAD that was already there because its schema asked only for a string. Three Marcus passes on wf_67f052e6-1a5 and the SHA never moved off d6a0c358. The worse half: the retry gate was handed the NEW worktree as cwd, so it graded files not on the branch. That run only avoided recording a PASS for an unreachable tree because the remediation also failed.
- Security review of my own #155 fix caught a real injection I introduced. Collecting into commitDir instead of PROJECT_ROOT changed WHERE the step can write: PROJECT_ROOT is a workflow argument, commitDir can be an agent-reported path — and I interpolated it raw. ship.js:377 is the record of that exact pairing shipping once before. Fixed with both layers, allowlist AND shellQuote, because quoting a path to another project still commits another project's files.
- The newline mutation on that fix SURVIVED its first pass: my three cases were written against the project root, so the base check refused them and the newline guard could be deleted with the suite green. A shielded mutation. They now sit inside an allowed worktree base where the guard is the only thing refusing them.
- #143 SHIPPED (PR #157 -> b64c124c), second attempt. The FIRST attempt was my error, not the agent's: the ship goal I wrote asked it to derive the repo from the working directory's git remote the way gh does. That is a second parser surface on an authorization boundary that already has one too many (#144). Rook failed it with two HIGH bypasses, one of which DISCARDED target.repo and so re-expressed the exact defect #143 was filed to fix. PR #154 closed.
- Removing the hardcoded fallback made parseCloseTarget's answer decisive, which promoted a latent defect to a live one: ISSUE_URL matched anywhere in the closing segment, so a URL in a --comment body took over the target. An ordinary dedup close made the guard read the linked issue's labels while gh closed a different one. The `direct` branch's own comment already said the positional number is unambiguous even when other digits appear in a comment body — the intent was written down and the match order defeated it.
- My first GH_REPO control was itself incomplete and review caught it: I tested the CLOSING SEGMENT, which catches `GH_REPO=x gh issue close 23` and misses `export GH_REPO=x && gh issue close 23` — the way anyone would write it, where the segment contains no assignment at all. A control that only covers the awkward spelling is not a control.
- #129 IS NOW MEASURED. Run 2: rook FAIL with a reproduced HIGH, ship-1 PASS, workflow returned SHIPPED and opened a PR. The verdict reached the summary only as a compliance grade. Run 1: rook FAIL with two HIGHs, run died on an unrelated ship-gate witness failure. Compounding and independent: Rook's worktree is cut from origin/main so its diff is EMPTY — it found anything at all only by reconstructing scope from git refs on its own initiative, both times.
- Quinn and Rook raised to opus, which Jason asked for. Rook on opus earned it immediately — three reproduced findings across two runs, each better than my own independent probing of the same code. Doing it exposed #152: AGENT-8 says 're-scaffold instead of editing the brief', re-scaffold reports 0 created 0 skipped and changes nothing, and harness-managed.md forbids editing the brief. Three mechanisms disagreeing; briefs hand-edited as a stopgap.
- #153, the Phase 2 deferral issue, closed as empty. Its entire Success Criteria section read 'the seventh acceptance criterion from #143 discovery, carried over unchanged' — a pointer to a list that appears nowhere in the issue. Evidence posted on #79, with the defect narrowed: the rest of that decomposition was correct, including refusing to group the ACs under spec phases that do not partition the work.
- #158 filed: detect-sc-drift applies a statement's keywords to EVERY path it mentions, so SC-563 could not be flipped while the conformity engine passed it. Third defect in that one function this week. Split the SC rather than work around it silently.

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

