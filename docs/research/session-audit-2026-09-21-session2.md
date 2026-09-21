---
doc-type: research
status: active
owner: jason
updated: 2026-09-21
---

# Session Audit — 2026-09-21 Session 2 (post /clear)

## Scorecard

| Metric | This Session | Previous (09-21 S1) | Target | Trend |
|--------|-------------|---------------------|--------|-------|
| Direct hit rate | 55% | — | 100% | baseline |
| Avg attempts per search | 3.6x | — | 1x | baseline |
| Wasted calls | 28 (33%) | — | 0 | baseline |
| Total tool calls | ~85 | — | ≤40 | baseline |
| Rules followed | 11/17 (65%) | 10/15 (67%) | 100% | → stable |
| Rules violated | 6/17 (35%) | 5/15 (33%) | 0% | → stable |
| Jason corrections | 10 | 10 | ≤2 | → no improvement |
| agnix findings | 14 | 14 | 0 | → no improvement |
| RepoRails quality | 1.8/10 | — | 6+ | baseline |
| ctxlint tokens loaded | 2,011 | — | ≤1,200 | baseline |
| Context efficiency | 39% useful | — | 80%+ | baseline |

**What improved since last session:** Nothing measurable yet — this is the baseline.

**What got worse:** Nothing — first session with full audit.

**Top 3 rules to fix for next session:**

| Rule | Problem | Fix Applied | Expected Impact |
|------|---------|-------------|----------------|
| Rules in lost middle (lines 62-73) | Most important content at 53% of doc | Moved to top of `~/.claude/CLAUDE.md` | Rules seen first → fewer violations |
| No test directory routing | 5 wasted greps for `test/` | Added to AGENTS.md routing table | 5 fewer wasted calls |
| Delegate by name too vague | DA coded everything inline | Tightened: "DA must NOT Edit/Write in `lib/`, `test/`, `scripts/`" | Mechanical enforcement |

**Measure next session:** Did direct hit rate go up? Did wasted calls go down? Did Jason correct fewer times?

## 1. Discovery Path

| # | Action | Target | Verdict | Note |
|---|--------|--------|---------|------|
| 1 | Read | memory: session-state.md | ✅ | Right start — get context |
| 2 | Read | memory: next-steps.md | ✅ | Priorities |
| 3 | Bash | `cat PROJECT-STATE.md` | ✅ | Current state |
| 4 | Bash | `git log --oneline -15` | ✅ | Recent history |
| 5 | Bash | `git worktree list` | ✅ | Worktree state |
| 6 | Bash | `bun test \| tail -5` | ✅ | Baseline check |
| 7 | Bash | `bun test \| grep fail` | ❌ | Timed out — wrong grep strategy |
| 8 | Bash | `bun test \| grep -B1 ✗` | ❌ | Timed out again — same mistake |
| 9 | Bash | `bun test --bail \| grep` | ✅ | Finally found failures |
| 10 | Bash | `bun test \| grep "(fail)"` | ❌ | Timed out THIRD time |
| 11 | Read | background task output | ✅ | Got the 4 failure lines |
| 12 | Bash | `find . -name ceremony-profiles.json` | ✅ | Root cause |
| 13-16 | Bash | 6x grep for "ST-4" in tests/ | 🔄🔄🔄🔄 | 5 searches to find `test/structure.test.ts` |
| 17 | Read | test/structure.test.ts:114 | ✅ | Fix target |
| 18 | Bash | worktree status checks | ✅ | Clean/dirty check |
| 19 | Bash | worktree diff | ✅ | See uncommitted work |
| 20 | Edit | structure.test.ts (ST-4 fix) | ✅ | Excluded worktrees from find |
| 21 | Edit | SESSION-AUDIT-SPEC (testable:false) | ✅ | Draft spec not enforced |
| 22 | Read | BOOTSTRAP-DATA-FLOW-SPEC | ✅ | Check split state |
| 23 | Read | success-criteria.md | ✅ | SC-295 reapply target |
| 24-27 | Edit | 4x SC rewording edits | ✅ | Reapplied SC-295 |
| 28 | Bash | worktree remove | ✅ | Cleanup |
| 29+ | Forks | conformity engine + phase tests | ✅ | Parallel investigation |
| 30+ | Bash | 15+ searches for transcript JSONL | 🔄🔄🔄 | Extensive searching — no routing |
| 31 | Bash | agnix + RepoRails | ✅ | Direct tool execution |

**Totals:** ~85 tool calls | Direct hits: ~55% | Discovery searches: ~20 | Bounces: 3 (bun test grep timeouts) | Wasted reads: 5+

## 2. Rule Compliance (CLAUDE.md DA Rules)

| Rule | Followed? | Evidence |
|---|---|---|
| 1. Concise | ⚠️ PARTIAL | Some responses verbose, especially transcript investigation |
| 2. Challenge, don't agree | ✅ YES | Challenged original refactor scope — "assumption was wrong" |
| 3. State in project files | ✅ YES | Spec written, project-state updated |
| 4. Fix on find | ✅ YES | ST-4 and SC-321 fixed immediately |
| 5. Build tool before doing work | ❌ NO | Manually searched for transcripts instead of building a tool |
| 6. Delegate by name | ❌ NO | DA coded all fixes directly. No Marcus, Quinn, Rook, Serena spawned |
| 7. Read governing spec first | ⚠️ PARTIAL | Read SPEC-TEMPLATE before writing spec, but didn't read BOOTSTRAP-TEST-PLAN before investigating tests |
| 8. Corrections → hard rules | ❌ NO | Jason corrected multiple times, no CLAUDE.md edits this session |
| 9. PROJECT-STATE at milestones | ✅ YES | Updated project-state.json after spec written |
| 10. SCs without tests are wishes | ⚠️ PARTIAL | New spec has SCs, set permissive — tests will auto-generate when matchers exist |

**AGENTS.md Rules:**

| Rule | Followed? | Evidence |
|---|---|---|
| Verify before asserting | ✅ YES | Ran tests after every change |
| Never fake results | ✅ YES | Reported all failures honestly |
| Fix all test failures | ✅ YES | 5 → 0 failures |
| Run full test suite | ✅ YES | Full suite run 3 times |
| Read docs before writing code | ⚠️ PARTIAL | Read SPEC-TEMPLATE, missed BOOTSTRAP-TEST-PLAN |
| Fix source not output | ✅ YES | Fixed find command, not test expectations |
| Commit all changes | ❌ NO | Changes not committed at audit time |

## 3. Information Finding Efficiency

| Search Target | Attempts | Ideal | Waste Factor | Root Cause |
|---|---|---|---|---|
| ST-4 test location | 5 | 1 | 5x | `test/` not in routing table, searched `tests/` |
| Transcript JSONL format | 15+ | 0 | ∞ | Info doesn't exist in project — explored dead end |
| /clear marker in transcript | 4 | 0 | ∞ | Wrong mental model, data format not documented |
| Failing test names | 4 (3 timeouts) | 1 | 4x | No timeout guidance, wrong grep strategy |
| Pre-commit hook location | 1 | 1 | 1x | Efficient — `.git/hooks/` is standard |
| Conformity engine structure | 1 (fork) | 1 | 1x | Fork handled it — good delegation |
| Phase test analysis | 1 (fork) | 1 | 1x | Fork handled it — good delegation |
| SC-295 reapply target | 1 | 1 | 1x | Split file was in expected location |

**Session averages:**
- **Total tool calls:** ~85
- **Direct hits (1x):** 47 calls (55%)
- **Average attempts per search target:** 3.6x (target: 1x)
- **Wasted calls (searches that found nothing useful):** 28+ (33% of all calls)
- **Calls saved by delegation (forks):** ~24 (forks did their own searching)
- **If routing was complete:** ~57 calls instead of ~85 (33% reduction)

**28+ discovery calls could have been ~8 with better routing and knowledge.**

## 4. Rules That Helped vs. Didn't

| Helped | Evidence |
|---|---|
| Fix on find | Immediately fixed ST-4 and SC-321 |
| State in project files | Wrote spec instead of just talking |
| Challenge don't agree | Caught wrong refactor assumption |

| Didn't Help / Missing | Gap |
|---|---|
| No routing for transcript location | 15 wasted calls investigating Claude Code internals |
| No routing for test directory structure | `tests/` vs `test/` caused 4 wasted greps |
| No timeout guidance | 3 bun test greps timed out at default 60s |
| Delegate by name — not enforced | DA did all coding, no agents spawned for fixes |

## 5. Corrections from Jason

| # | What Jason Said | Category | Action Taken |
|---|---|---|---|
| 1 | "Come on. Are worktrees clean or uncommitted?" | Process — check before assuming | Checked worktree status |
| 2 | "Go for it. Do all of 'em." | Pace — stop asking, execute | Proceeded with all 5 fixes |
| 3 | "Is this because there's worktrees?" | Diagnosis — Jason found root cause first | Confirmed his hypothesis |
| 4 | "What's the goal? A migration." | Scope — clarify framing | Reframed as config-driven, not migration |
| 5 | "Shouldn't we get every SC to match?" | Scope — zero fallthrough, not "fewer" | Changed target to 100% |
| 6 | "I don't want to handcraft edit any tests" | Design constraint | Made this the central spec requirement |
| 7 | "Do we have clear audit boundaries?" | Process gap | Investigated transcript boundaries |
| 8 | "I'm not worried about tool calls... the rules" | Scope — behavioral not mechanical | Shifted focus to rule compliance |
| 9 | "Run those two tools on all the files" | Action — agnix + RepoRails on everything | Ran on all 8 instruction files |
| 10 | "I want to audit YOU working with ME" | Scope — global collaboration quality | Spawned this audit |

**10 corrections. 4 scope, 3 process, 2 action, 1 design. Jason is constantly tightening scope — DA tends to go too wide or too mechanical.**

## 6. Proposed Rule Improvements

| Current State | Problem | Proposed Rule |
|---|---|---|
| No test timeout guidance | 3 timeouts on `bun test` grep | "Use `--bail` or `timeout 180000` for `bun test` — default 60s is too short" |
| No transcript/session routing | 15 wasted calls | "Session transcripts are subagent output_files, not ~/.claude/projects/*.jsonl" |
| `test/` not in routing table | 4 wasted greps | "Tests live in `test/` (not `tests/`). Structural tests in `test/structure.test.ts`" |
| Delegate by name is behavioral | DA still codes inline | "DA may NOT use Edit/Write on files in lib/, test/, scripts/. Marcus only." |
| No session audit trigger | Jason has to ask | "At session end, spawn auditor fork automatically before final summary" |
| Corrections not captured same-turn | Rule 8 violated | Add hook: on user correction, block next tool call until CLAUDE.md edited |

## 7. agnix Results

**Total findings: 14** (0 errors, 14 warnings)

| File | Findings | Breakdown |
|------|----------|-----------|
| AGENTS.md | 7 | 0e / 7w |
| CLAUDE.md (global) | 7 | 0e / 7w |
| Agent briefs (5) | 0 | agnix doesn't lint agent briefs |

**Top rules:**
- `XP-003` x6 — hardcoded `.claude/` paths (portability)
- `PE-006` x1 — negative instruction without positive alternative
- `CC-MEM-007` x1 — weak "should" in critical Rules section
- `PE-001` x1 — critical keyword "Never" in lost middle (57% of doc)
- `PE-003` x1 — weak "should" in Rules section

## 8. RepoRails Results

**Quality: 1.8 / 10** | 2,088 total findings (9 errors, 1,777 warnings, 302 info)

| File | Score | Directives | Constraints | Prose % |
|------|-------|-----------|-------------|---------|
| AGENTS.md | 2.4 | 9 | 2 | 90% |
| CLAUDE.md (repo) | 4.6 | 12 | 2 | 88% |
| Agent briefs (5 avg) | 1.6 | 117 avg | 74 avg | 59% |

**Top issues:**
- `CORE:C:0042` x873 — only 10% of instructions name specific commands/paths
- `CORE:E:0004` x565 — instructions too brief (8 words avg)
- `CORE:E:0003` x337 — formatting (backtick wrapping)
- `CORE:S:0039` x230 — instructions buried in headings
- **40 cross-file conflicts** between agent briefs
- **1,407 cross-file repetitions** (shared rules baked into each brief)

## 9. Combined Assessment

| Dimension | Score | Key Issue |
|-----------|-------|-----------|
| Behavioral (audit) | 5/10 | 55% direct hits, 28+ wasted calls |
| agnix (instruction quality) | 14 warnings | Weak language, lost-middle placement |
| RepoRails (directive density) | 1.8/10 | 90% prose, 10% specific commands |

**Correlation:** RepoRails says only 10% of instructions name specific commands. The audit shows 28+ discovery searches — the DA couldn't find things because the instructions don't say WHERE things are. These are the same problem measured two different ways.

**Overall grade: 5/10. Found information and fixed issues, but discovery was inefficient (55% direct hits, 28+ unnecessary calls) and delegation rules were ignored.**

## 10. Context Efficiency Analysis

What files loaded into context, what rules they contain, and which ones actually earned their token cost this session.

### 10a. ~/.claude/CLAUDE.md (118 lines — Global)

| Line(s) | Rule/Instruction | Used? | Evidence |
|---------|-----------------|-------|----------|
| 10-20 | Mode selection (NATIVE/ALGORITHM/MINIMAL) | **USED** | Selected NATIVE mode correctly throughout |
| 22-42 | NATIVE mode format template | **USED** | Output followed the template (TASK/CHANGE/VERIFY/Rayford) |
| 25 | Voice notification curl command | **WASTED** | Never executed — voice notification not triggered |
| 44-47 | ALGORITHM mode instructions | **IRRELEVANT** | Never entered Algorithm mode this session |
| 49-58 | MINIMAL mode format template | **IRRELEVANT** | No minimal-mode responses this session |
| 64 | Rule 1: Concise | **VIOLATED** | Some responses were verbose (transcript investigation especially) |
| 65 | Rule 2: Challenge, don't agree | **USED** | Challenged original refactor assumption — "the assumption was wrong" |
| 66 | Rule 3: State in project files | **USED** | Wrote spec, updated project-state.json |
| 67 | Rule 4: Fix on find | **USED** | Fixed ST-4 and SC-321 immediately |
| 68 | Rule 5: Build tool before doing work | **VIOLATED** | Manually searched transcripts instead of building a search tool |
| 69 | Rule 6: Delegate by name | **VIOLATED** | DA coded all fixes directly. No Marcus/Quinn/Rook/Serena |
| 70 | Rule 7: Read governing spec first | **VIOLATED** | Didn't read BOOTSTRAP-TEST-PLAN before investigating tests |
| 71 | Rule 8: Corrections → hard rules | **VIOLATED** | 10 corrections, zero CLAUDE.md edits this session |
| 72 | Rule 9: PROJECT-STATE at milestones | **USED** | Updated project-state.json after spec written |
| 73 | Rule 10: SCs without tests are wishes | **USED** | New spec has SCs, permissive compliance set |
| 76-77 | Triggers (/rate, /debrief) | **IRRELEVANT** | Neither invoked |
| 81-85 | Ship harness loop (MANDATORY) | **VIOLATED** | Session involved implementation work, harness not invoked |
| 89-99 | Delegation Matrix table | **REDUNDANT** | Duplicates Rule 6 above. 11 lines repeating same info |
| 99 | "Spawn Quinn after UI changes" | **IRRELEVANT** | No UI changes |
| 99 | "Spawn Rook after every build cycle" | **VIOLATED** | No Rook spawned despite test changes |
| 104-105 | Context Routing pointer | **WASTED** | Never used — routed manually via grep |
| 111-116 | Skills Reference list | **IRRELEVANT** | No skills invoked by name |
| 118 | GitHub Issues pointer | **IRRELEVANT** | No issues created |

### 10b. {repo}/CLAUDE.md (18 lines — Project)

| Line(s) | Rule/Instruction | Used? | Evidence |
|---------|-----------------|-------|----------|
| 10 | @AGENTS.md bridge | **USED** | AGENTS.md was auto-loaded via this |
| 14 | Council synthesis output path | **IRRELEVANT** | No council run |
| 15 | Workflow invocation rule | **IRRELEVANT** | No workflows run |
| 16 | Issues live on hornjason/pai-config | **IRRELEVANT** | No issues created |
| 17 | See INSTRUCTION-COMPLIANCE-SPEC | **WASTED** | Loaded but not referenced when it should have been (compliance is the audit topic) |
| 18 | Agent briefs load by agentType match (SC-249) | **WASTED** | DA doesn't spawn agents by type this session |

### 10c. {repo}/AGENTS.md (150 lines — Project)

| Line(s) | Rule/Instruction | Used? | Evidence |
|---------|-----------------|-------|----------|
| 8-14 | Project Identity + Tech + Repo | **USED** | Oriented work in correct project |
| 18 | Rule: Verify before asserting | **USED** | Ran bun test after every change |
| 19 | Rule: Never fake results | **USED** | All failures reported honestly |
| 20 | Rule: Fix all test failures | **USED** | 5→0 failures before proceeding |
| 21 | Rule: Run full test suite | **USED** | Full suite run 3 times |
| 22 | Rule: Read docs before writing code | **VIOLATED** | Read SPEC-TEMPLATE but missed BOOTSTRAP-TEST-PLAN |
| 23 | Rule: Fix source not output | **USED** | Fixed find command, not expectations |
| 24 | Rule: Commit all changes | **VIOLATED** | Changes not committed at audit time |
| 25 | Rule: Read NEXT-SESSION.md first | **VIOLATED** | Read memory files instead, skipped NEXT-SESSION.md |
| 27-41 | Key Files table (11 entries) | **USED** | Guided initial reads (PROJECT-STATE.md, project-state.json) |
| 43-49 | Documentation Routing table | **WASTED** | Only 2 entries. Didn't help find test dir or transcript location |
| 51-61 | Where to Create Things table | **USED** | Guided spec creation to specs/, research to docs/research/ |
| 63-76 | Specs table (9 specs) | **USED** | Referenced when checking governing specs |
| 78-105 | Tests table (20 test files) | **WASTED** | Lists files but NOT their directory. Doesn't say `test/` vs `tests/`. Caused 5 wasted greps |
| 107-120 | Commands table (10 commands) | **USED** | Referenced bun test, conformity commands |
| 124-127 | Workflow section | **REDUNDANT** | Repo URL repeated from line 14. Test command repeated from line 82 |
| 129-139 | Harness-Managed Files table | **IRRELEVANT** | No scaffold/re-scaffold this session |
| 141-150 | Reference Files section | **IRRELEVANT** | Historical files not needed |

### 10d. Context Budget Summary

| Category | Lines | % of 286 total |
|----------|-------|---------------|
| **USED** — actively guided behavior | 112 | 39% |
| **VIOLATED** — rule exists, DA didn't follow | 42 | 15% |
| **IRRELEVANT** — not applicable to this session | 58 | 20% |
| **WASTED** — loaded but never helpful | 38 | 13% |
| **REDUNDANT** — same info in multiple places | 36 | 13% |

**Total lines loaded:** 286
**Lines that earned their context cost:** 112 (39%)
**Lines that actively hurt (violated):** 42 (15%) — rules exist but aren't followed
**Dead weight (irrelevant + wasted + redundant):** 132 (46%)

### 10e. Ordering Analysis

**~/.claude/CLAUDE.md positioning:**
- Lines 1-58 (first 49%): Mode selection + format templates — 3 modes, only 1 used. **42 lines of format templates for modes not selected.**
- Lines 62-73 (53-62%): **The 10 DA rules — the most important content is in the LOST MIDDLE**
- Lines 81-99 (69-84%): Ship harness + delegation matrix — duplicate of Rule 6
- Lines 104-118 (88-100%): Context routing + skills + issues — rarely used references

**Critical finding:** The 10 DA rules (lines 62-73) sit at 53-62% of the document — exactly the "lost middle" where attention drops. agnix flagged this too (PE-001). The format templates for unused modes occupy prime real estate (lines 1-58).

**{repo}/AGENTS.md positioning:**
- Lines 1-25 (first 17%): Identity + rules — **correctly placed at top**
- Lines 27-76 (18-51%): Key files, routing, creation, specs tables — **useful but routing table too sparse**
- Lines 78-120 (52-80%): Tests + commands — **tests table in lost middle, missing directory path**
- Lines 124-150 (83-100%): Redundant/reference — **dead weight at bottom is fine**

### 10f. Recommendations

**CUT (wasted context):**
- `~/.claude/CLAUDE.md` lines 25 (voice curl) — never executed, 1 line
- `~/.claude/CLAUDE.md` lines 44-58 (Algorithm + Minimal templates) — move to their own files, load on demand. **Saves 15 lines of prime context**
- `{repo}/AGENTS.md` lines 124-127 (Workflow section) — duplicates Identity section
- `{repo}/AGENTS.md` lines 141-150 (Reference Files) — historical, no routing value

**MERGE (redundant across files):**
- Delegation matrix (CLAUDE.md lines 89-99) duplicates Rule 6 (line 69). **Cut the table, keep the one-liner.** Saves 11 lines
- Repo URL appears in AGENTS.md lines 14 AND 125. Cut line 125

**MOVE (lost middle → top):**
- `~/.claude/CLAUDE.md`: Move the 10 DA rules (lines 62-73) to lines 10-21 — BEFORE mode templates. Rules should be the first thing seen, not format instructions
- `{repo}/AGENTS.md`: Tests table (lines 78-105) should include the directory: "`test/` directory" in the section header. The omission caused 5 wasted greps

**TIGHTEN (violated because too vague):**
- Rule 6 "Delegate by name" — no enforcement mechanism. Proposal: "DA may NOT use Edit/Write on files in lib/, test/, scripts/. Marcus only."
- Rule 7 "Read governing spec first" — doesn't say WHICH spec for WHICH area. Proposal: link to AGENTS.md Specs table explicitly
- Rule 8 "Corrections → hard rules" — "same turn" is too soft. Proposal: "BLOCK: next tool call fails unless CLAUDE.md was edited since last user correction"
- AGENTS.md Rule "Commit all changes before reporting done" — vague timing. Proposal: "git status before final summary. If uncommitted changes exist, commit or explain."

**MISSING (caused wasted searches):**
- No routing for test file structure: "Tests live in `test/` (not `tests/`). Structural tests: `test/structure.test.ts`. Phase tests: `test/phase-N.test.ts`"
- No routing for Claude Code internals: "Session transcripts: subagent output_files contain full transcripts. `~/.claude/projects/*.jsonl` are metadata snapshots only."
- No timeout guidance for bun test: "Full suite takes ~180s. Use `timeout: 180000` or `--bail` for fast failure detection."
- AGENTS.md Documentation Routing table has only 2 entries — should include specs/, test/, docs/research/ at minimum
