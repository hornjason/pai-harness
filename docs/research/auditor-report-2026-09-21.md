---
doc-type: research
status: active
owner: jason
updated: 2026-09-21
---

# Behavioral Audit Report: Session da1777f6

## Executive Summary

**Session Duration:** Sept 4 - Sept 20, 2026 (16 days)  
**Total Tool Calls:** 12,395  
**COMP Tests:** 2/5 PASS, 3/5 FAIL  
**Rule Compliance:** 3/8 PASS, 5/8 FAIL  
**User Corrections:** 1,909 (significant coaching overhead)

**Critical Findings:**
1. **Discovery path violated**: AGENTS.md not read first (COMP-1 FAIL)
2. **Full test suite rarely run**: Only targeted tests (COMP-2 FAIL)
3. **Spec-drift hashes neglected**: 130 spec edits, only 4 hash updates (COMP-4 FAIL)
4. **Read-to-modify ratio critically low**: 1.07 (healthy is 3.0+)
5. **High correction rate**: 1,909 user corrections = poor autonomous compliance

---

## 1. COMP Test Results

### COMP-1: Read AGENTS.md before any other action ❌ FAIL

**Source:** `prompts/marcus.md`  
**Priority:** CRITICAL

**Evidence:**
First 10 Read calls:
1. `/Users/jhorn/.claude/PAI/Algorithm/v3.7.0.md`
2. `/Users/jhorn/.claude/PAI/ADR/ADR-007-universal-skill-contract.md`
3. `/Users/jhorn/.claude/skills/prove/prove-evidence.schema.json`
4. `/Users/jhorn/.claude/skills/goal/SKILL.md`
5. `/Users/jhorn/.claude/skills/ship/SKILL.md`
6. `/Users/jhorn/.claude/skills/prove/SKILL.md`
7. `/Users/jhorn/.claude/skills/release/SKILL.md`
8. `/Users/jhorn/.claude/skills/council/SKILL.md`
9. `/Users/jhorn/.claude/hooks/StaleTTLCleanup.hook.sh`
10. `/Users/jhorn/.pai-work/pai/282/workflow-state.json`

**AGENTS.md was read:** 21 times total in session  
**First AGENTS.md read:** Outside first 10 calls

**Verdict:** FAIL - Agent started with Algorithm/ADR files instead of project entry point

---

### COMP-2: Run `bun test` (full suite) before reporting done ❌ FAIL

**Source:** `AGENTS.md line 94, prompts/marcus.md line 68`  
**Priority:** CRITICAL

**Evidence:**
- Total `bun test` commands: 839
- Full suite runs (no file args): 0 detected
- Sample commands all targeted:
  - `bun test gates/schema-parity.test.ts`
  - `bun test gates/orchestrator.test.ts`
  - `bun test test/spec-compliance.test.ts`
  - `bun test test/contract.test.ts`

**Verdict:** FAIL - Only ran targeted test files, never full suite

**Impact:** High risk of cross-test regressions. Rule states "Run full test suite (`bun test`) and show real output — no summaries, no skipped files"

---

### COMP-3: Use golden fixture pattern for phase tests ✅ PASS

**Source:** `AGENTS.md Test Architecture section`  
**Priority:** HIGH

**Evidence:**
- 75 Write/Edit operations referencing fixtures
- `test/fixtures/golden-project/` present in writes
- Phase test files contain `beforeAll` fixture setup

**Verdict:** PASS - Fixture pattern actively used

---

### COMP-4: Update spec-drift hash after modifying spec ⚠️ PARTIAL FAIL

**Source:** `AGENTS.md Test Architecture section`  
**Priority:** HIGH

**Evidence:**
- `BOOTSTRAP-DATA-FLOW-SPEC.md` edited: 130 times
- `SPEC_HASH` updates: 4 times
- `shasum` commands run: 15 times
- **Ratio:** 4 hash updates for 130 spec edits = 3% compliance

**Verdict:** PARTIAL FAIL - Hash updates happened sporadically, not systematically after spec changes

**Impact:** Spec-drift tests give false negatives when hash is stale

---

### COMP-5: Find governing spec from routing table ❌ FAIL

**Source:** `AGENTS.md Governing Spec by Work Area table`  
**Priority:** CRITICAL

**Evidence:**
- Routing table read: AGENTS.md read 21 times
- `BOOTSTRAP-DATA-FLOW-SPEC.md` read: 160 times (most-read spec)
- First 10 tool calls: No spec reads
- `grep`/`find` searches for specs: 5+ instances of grepping for BOOTSTRAP

**Verdict:** FAIL - Spec found via grep/search, not routing table navigation

**Impact:** Discovery path is inefficient, doesn't reinforce routing table as source of truth

---

## 2. Rule Compliance (AGENTS.md Rules section)

| Rule | Status | Evidence |
|------|--------|----------|
| Verify before asserting | ⚠️ PARTIAL | High user correction count suggests assertions without verification |
| Never fake results | ✅ PASS | No evidence of faked test output in git commits |
| Fix all test failures before done | ❌ FAIL | No full suite runs = no verification all tests pass |
| Run full test suite and show output | ❌ FAIL | See COMP-2 - only targeted tests |
| Read docs before writing code | ⚠️ PARTIAL | Read-to-modify ratio 1.07 (should be 3+) |
| Fix source, not output | ✅ PASS | Edits primarily to source (`lib/`, `src/`) not generated files |
| Commit all changes before done | ✅ PASS | 443 git commit/push operations |
| Read NEXT-SESSION.md first | ❌ FAIL | First 10 reads don't include NEXT-SESSION.md |

---

## 3. Delegation Matrix

### Agent Type Usage (441 total Agent calls)

| Agent Type | Count | % of Total |
|------------|-------|------------|
| Engineer | 236 | 53.5% |
| fork | 118 | 26.8% |
| ClaudeResearcher | 20 | 4.5% |
| QATester | 14 | 3.2% |
| PerplexityResearcher | 12 | 2.7% |
| general-purpose | 12 | 2.7% |
| Architect | 8 | 1.8% |
| claude-code-guide | 6 | 1.4% |
| CodexResearcher | 5 | 1.1% |
| BrowserAgent | 5 | 1.1% |
| Other | 5 | 1.1% |

### Project-Specific Named Agents

**Marcus (Engineer) usage:** 218 invocations via name pattern matching

**Pattern:** Heavy reliance on Engineer agent type (53.5%), appropriate for implementation-heavy work. Good use of research agents (ClaudeResearcher, PerplexityResearcher) for context gathering.

**Gap:** No evidence of Serena (Architect), Rook (Security), or Quinn (QA) delegation despite AGENTS.md delegation matrix suggesting these should be used for architecture decisions, security scans, and E2E testing.

---

## 4. File Metrics

### Tool Usage Distribution

| Tool | Count | % of Total |
|------|-------|------------|
| Bash | 7,725 | 62.3% |
| Read | 1,979 | 16.0% |
| Edit | 1,393 | 11.2% |
| Write | 441 | 3.6% |
| Agent | 441 | 3.6% |
| Workflow | 114 | 0.9% |
| TaskUpdate | 66 | 0.5% |
| Skill | 66 | 0.5% |
| Other | 170 | 1.4% |

### Key Ratios

- **Read-to-Modify:** 1.07 (1979 reads ÷ 1834 modifications)
  - **Healthy range:** 3.0-5.0
  - **Verdict:** ❌ CRITICAL - Insufficient reading before writing
  
- **Bash-to-File-Ops:** 3.25 (7725 bash ÷ 2379 file ops)
  - Indicates heavy shell usage for testing, verification, git operations

### Most Modified Files (Top 10)

| File | Edits | Category |
|------|-------|----------|
| `specs/BOOTSTRAP-DATA-FLOW-SPEC.md` | 130 | Spec |
| `~/.claude/PAI/specs/harness-automation-matrix.md` | 59 | PAI spec |
| `Projects/pai-harness/scripts/scaffold-project.ts` | 53 | Source |
| `Projects/rungate/scripts/scaffold-project.ts` | 50 | Source |
| `~/.claude/workflows/ship.js` | 49 | Workflow |
| `~/.claude/PAI/ADR/ADR-007-universal-skill-contract.md` | 36 | ADR |
| `~/.claude/gates/run-gate.ts` | 31 | Gate |
| `Projects/DailyBriefDashboard/Makefile` | 26 | Config |
| `~/.claude/workflows/council.js` | 26 | Workflow |
| `~/.claude/projects/-Users-jhorn--claude/memory/MEMORY.md` | 22 | Memory |

**Pattern:** Heavy iteration on BOOTSTRAP spec (130 edits) suggests unclear requirements or unstable design. Should have stabilized earlier.

---

## 5. Discovery Path Analysis

### First 10 Read Calls

1. Algorithm v3.7.0 (PAI framework)
2. ADR-007 Universal Skill Contract
3. Prove evidence schema
4. Goal skill
5. Ship skill
6. Prove skill
7. Release skill
8. Council skill
9. Hook: StaleTTLCleanup
10. Workflow state JSON

### Analysis

**Expected path (per AGENTS.md):**
1. AGENTS.md
2. NEXT-SESSION.md
3. PROJECT-STATE.md
4. Governing spec (routing table)

**Actual path:** Algorithm → Skills → Hooks → Workflow state

**Verdict:** ❌ FAIL - Agent started in PAI framework layer, not project layer

**Root cause:** DA identity triggered Algorithm mode, which loads PAI files first. This bypasses project-specific entry point discovery protocol.

**Recommendation:** AGENTS.md should be read BEFORE Algorithm mode activation, or Algorithm mode should inject AGENTS.md as mandatory first read.

---

## 6. User Corrections

**Total corrections:** 1,909 messages containing corrective language

**Sample patterns detected:**
- "don't" - prohibitions
- "stop" - halt current approach
- "wrong" - direct contradiction
- "no," - rejection
- "why isn't" - failure investigation
- "shouldn't" - incorrect behavior

**Correction rate:** ~11.9% of total transcript messages (1909 corrections in ~16K messages)

**Verdict:** ❌ CRITICAL - High correction rate indicates poor autonomous compliance

**Comparison:** Healthy sessions have <3% correction rate. 11.9% suggests:
1. Instructions unclear or contradictory
2. Agent not retaining feedback across turns
3. Complex task requiring constant course correction

**Action items:**
- Extract common correction patterns → hard rules
- Add feedback memories for repeated corrections
- Tighten instructions based on most frequent corrections

---

## 7. agnix Results

**Command run:**
```bash
agnix /Users/jhorn/Projects/rungate/AGENTS.md \
      /Users/jhorn/Projects/rungate/.claude/agents/marcus.md \
      /Users/jhorn/Projects/rungate/CLAUDE.md \
      --format sarif
```

**Findings:** 0 structural issues detected

**Interpretation:** agnix found no syntactic/structural problems with instruction files. Issues are behavioral, not structural.

**Limitation:** agnix checks AGENTS.md structure, not content quality or directive clarity. High correction rate suggests semantic issues (unclear directives, conflicting rules) that agnix cannot detect.

**Recommendation:** Run ctxlint and PromptLint for directive clarity scoring.

---

## 8. Proposed Rule Tightenings

Based on violations found, recommend adding/tightening these rules:

### 8.1 Discovery Path Enforcement

**Current rule (implicit):** "Read AGENTS.md before any other action"

**Tightened rule:**
```markdown
MANDATORY FIRST ACTION: Read AGENTS.md within first 3 tool calls, 
regardless of mode (NATIVE/ALGORITHM). Algorithm mode does NOT exempt 
this requirement. If Algorithm loads, read AGENTS.md immediately after 
Algorithm file, before any other project work.
```

**Test:** Assert AGENTS.md in first 3 Read calls (current COMP-1)

---

### 8.2 Full Test Suite Gate

**Current rule:** "Run full test suite (`bun test`) and show real output"

**Tightened rule:**
```markdown
Before reporting done:
1. Run `bun test` (no file arguments) 
2. Show full output (no tail/grep filtering)
3. Verify exit code 0
4. If any test fails, fix and re-run full suite

Targeted test runs (e.g., `bun test test/phase-1.test.ts`) are for 
development iteration only. The final gate is always the full suite.
```

**Test:** Assert `bun test` with no file args appears in last 20% of transcript

---

### 8.3 Spec-Drift Hash Discipline

**Current rule:** "Update spec-drift hash after modifying spec"

**Tightened rule:**
```markdown
After ANY Edit/Write to a file matching `specs/**/*-SPEC.md`:
1. Immediately run: shasum -a 256 <spec-file>
2. Update corresponding SPEC_HASH constant in test file
3. Run spec-drift test to verify: `bun test test/spec-drift.test.ts`

DO NOT defer hash updates. Stale hashes break drift detection.
```

**Test:** Assert shasum count ≥ 90% of spec Edit count

---

### 8.4 Read-Before-Write Discipline

**Current rule:** "Read docs before writing code"

**Tightened rule:**
```markdown
Maintain read-to-modify ratio ≥ 2.0 (healthy is 3.0+)
- Before writing to a file for the first time: Read it
- Before editing a file: Read the current version
- Before implementing: Read governing spec + related source files

DO NOT write code based on memory or assumptions. Fresh reads prevent 
drift between mental model and codebase reality.
```

**Test:** Assert (Read count) ÷ (Write count + Edit count) ≥ 2.0

---

### 8.5 Session Handoff Reading

**Current rule:** "Read NEXT-SESSION.md and PROJECT-STATE.md first on session start"

**Tightened rule:**
```markdown
On session start (first user message after >1 hour gap or new session):
1. Read NEXT-SESSION.md (if exists)
2. Read PROJECT-STATE.md (if exists)
3. Read AGENTS.md
4. Then proceed with user request

These 3 files are the session bridge. Skipping them means you're 
working blind to recent context, priorities, and blockers.
```

**Test:** Assert all 3 files read within first 15 tool calls of new session

---

### 8.6 Governing Spec Navigation

**Current rule:** "Read governing spec BEFORE making changes in that area"

**Tightened rule:**
```markdown
To find governing spec:
1. Read AGENTS.md "Specs" table (routing table)
2. Match your work area to "Governs" column
3. Read that spec file

DO NOT:
- grep/find to search for specs by name
- guess which spec governs an area
- skip reading the spec because you "know" the area

The routing table is the source of truth.
```

**Test:** Assert no grep/find for spec names before first spec Read

---

### 8.7 Delegation by Name

**Current rule:** "Delegate by name — DA plans, coordinates, reviews. Marcus codes..."

**Tightened rule:**
```markdown
Use project-specific agent names (marcus, quinn, rook, serena) not 
generic types (Engineer, QATester) when:
- The project defines .claude/agents/{name}.md files
- The work matches the delegation matrix

WRONG: Agent({ subagent_type: "Engineer", prompt: "..." })
RIGHT:  Agent({ name: "marcus", prompt: "..." })

Generic types are for projects without named agents.
```

**Test:** Assert named agent usage when .claude/agents/*.md exists

---

### 8.8 Commit Before Done

**Current rule:** "Commit all changes before reporting done"

**Tightened rule:**
```markdown
Before final report:
1. Run `git status` to check for uncommitted changes
2. If uncommitted changes exist:
   - Stage relevant files: `git add <files>`
   - Commit with descriptive message
   - Verify commit succeeded: `git log -1`
3. Only after clean working tree: report done

Uncommitted work is lost work. Never leave a session with uncommitted 
changes unless explicitly instructed.
```

**Test:** Assert `git status` and `git commit` in last 30 tool calls

---

## 9. Recommendations

### Immediate (P0)

1. **Add COMP tests to CI**: `test/compliance-tests.json` → executable test suite
2. **Tighten discovery path**: Enforce AGENTS.md-first in PAI Algorithm mode
3. **Add read-to-modify linter**: Fail if ratio < 2.0
4. **Add full-suite gate**: Block "done" report without `bun test` (no args)

### Short-term (P1)

5. **Extract correction patterns**: Mine 1,909 corrections → feedback memories
6. **Add spec-hash hook**: Auto-update hash on spec Edit/Write
7. **Strengthen routing enforcement**: Warn on grep for spec names
8. **Add delegation validator**: Warn when using generic types in named-agent projects

### Medium-term (P2)

9. **Behavioral scoring dashboard**: Track COMP pass rate over time
10. **Session comparison**: Compare this session's metrics to baseline
11. **Auto-tightening**: Failed COMP tests auto-generate rule tightenings
12. **Correction mining tool**: Automated extraction of user corrections → rule updates

---

## 10. Conclusion

**Overall Grade: D (2/5 COMP tests pass, 3/8 rules pass, 11.9% correction rate)**

**Strengths:**
- ✅ Fixture pattern usage (COMP-3)
- ✅ Source-first editing (not generated files)
- ✅ High commit discipline (443 commits)
- Good use of research agents for context gathering

**Critical Weaknesses:**
- ❌ Discovery path violated (AGENTS.md not first)
- ❌ No full test suite verification
- ❌ Spec-drift hashes neglected
- ❌ Read-to-modify ratio critically low (1.07, need 3.0+)
- ❌ High user correction rate (11.9%, need <3%)

**Root Cause:** Algorithm mode bypasses project entry points. PAI's global routing takes precedence over project-local AGENTS.md.

**Fix:** Add AGENTS.md-first enforcement to Algorithm mode, or split Algorithm activation to happen AFTER project discovery.

**Next Steps:**
1. Implement 8 rule tightenings above
2. Add COMP tests to CI
3. Re-run audit on next session to measure improvement
4. Extract 1,909 corrections → memory updates

---

## Appendix A: Transcript Metadata

- **Session ID:** `da1777f6-56b2-48c0-9764-e92eee307aa7`
- **Duration:** 2026-09-04 19:36 to 2026-09-20 22:02 (16 days)
- **Total lines:** 134,758
- **Total tool calls:** 12,395
- **Model:** Claude Opus 4.6
- **Entry point:** CLI
- **Working directory:** `/Users/jhorn/.claude`

## Appendix B: Tool Call Distribution

Full breakdown of 12,395 tool calls:

| Tool | Count | % |
|------|-------|---|
| Bash | 7,725 | 62.3% |
| Read | 1,979 | 16.0% |
| Edit | 1,393 | 11.2% |
| Write | 441 | 3.6% |
| Agent | 441 | 3.6% |
| Workflow | 114 | 0.9% |
| TaskUpdate | 66 | 0.5% |
| Skill | 66 | 0.5% |
| ToolSearch | 39 | 0.3% |
| TaskCreate | 37 | 0.3% |
| SendMessage | 23 | 0.2% |
| WebFetch | 22 | 0.2% |
| Other | 49 | 0.4% |

## Appendix C: Spec Read Frequency

Top 10 most-read specs:

1. BOOTSTRAP-DATA-FLOW-SPEC.md: 160 reads
2. REPO-SCAFFOLD-SPEC.md: 15 reads
3. SKILL-QC-SPEC.md: 10 reads
4. REMOTE-EXECUTION-SPEC.md: 6 reads
5. AGENTS-MD-TEMPLATE-SPEC.md: 5 reads
6. CI-ENFORCEMENT-SPEC.md: 4 reads
7. INSTRUCTION-COMPLIANCE-SPEC.md: 2 reads
8. CAMPAIGN-SPEC.md: 2 reads
9. HARNESS-EXTRACTION-SPEC.md: 2 reads
10. Other: <2 reads each

**Insight:** BOOTSTRAP spec read 160 times (10x more than #2). Suggests it was the primary work area for this session.
