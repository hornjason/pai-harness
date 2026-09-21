---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Session behavioral audit — two feedback loops for instruction quality improvement
testable: false
compliance: permissive
---

# Session Behavioral Audit

## Problem

Instructions govern agent behavior at two levels: **repo docs** (AGENTS.md, briefs) for agents working autonomously, and **global rules** (~/.claude/CLAUDE.md, memory) for the DA working with Jason. Both need a feedback loop — audit behavior, measure efficiency, improve instructions, re-run, compare. Today this is manual and gets skipped.

## Two Feedback Loops

### Loop 1: Repo Navigability (Hill Climb)

Tests whether repo instruction files (AGENTS.md, agent briefs, specs) guide fresh agents to the right information efficiently.

```
1. Re-scaffold RunGate on itself
2. Spawn FRESH agent — same task, zero context, runs Phase 0 + Phase 1
3. Spawn AUDITOR agent — reads fresh agent's transcript, grades navigability
4. Run agnix + RepoRails on instruction files — grade quality
5. COMPARE metrics to previous run
6. IMPROVE instruction files based on findings
7. REPEAT — numbers must improve each iteration
```

**Data source:** Subagent transcript file (`/private/tmp/.../tasks/{agentId}.output`). This IS the full transcript — every tool call, every file read, every search. The auditor reads this file directly.

**Metrics tracked:**

| Metric | What It Measures | Target |
|--------|-----------------|--------|
| Direct hits | % of file reads that went straight to the right file | 100% |
| Discovery searches | grep/find calls to locate information | 0 |
| Total tool calls | Overall efficiency | ↓ each run |
| Bounces | Files read then abandoned (wrong file) | 0 |
| Wasted reads | Files read but never used in output | 0 |
| Tool calls to spec | How many calls to find the governing spec | 1 |
| Correct outcome | Did the agent produce the right result | YES |

**Proven progression (from prior sessions):**

| Metric | v1 (no docs) | v3 (docs+stale) | v4 (fixture) |
|--------|-------------|-----------------|--------------|
| Direct hits | 0% | 75% | 100% |
| Discovery searches | 15+ | 3 | 0 |
| Total tool calls | 51 | 39 | 24 |
| Bounces | 5+ | 0 | 0 |
| Wasted reads | 6+ | 2 | 0 |

### Loop 2: Collaboration Efficiency (Session Audit)

Tests whether global rules (~/.claude/CLAUDE.md), memory files, and project rules make the DA efficient when working with Jason.

```
1. Jason and DA work together (normal session)
2. At session end, spawn AUDITOR FORK — inherits full conversation context
3. Auditor grades: discovery path, rule compliance, corrections, efficiency
4. Run agnix + RepoRails on ALL instruction files (global + repo + agent briefs)
5. COMPARE to previous session audit
6. IMPROVE global CLAUDE.md / memory / routing based on findings
7. NEXT SESSION — tighter rules → better efficiency → audit again
```

**Data source:** Fork inherits conversation context. No transcript file parsing needed — the fork sees everything the DA did this session.

**What it grades:**

| Category | What | Evidence |
|----------|------|----------|
| Discovery path | Every Read/Bash call in order, was each efficient? | ✅ direct / ❌ wasted / 🔄 search |
| Rule compliance | Each rule from CLAUDE.md + AGENTS.md: followed? | YES/NO/PARTIAL with evidence |
| Delegation | Used project agents (marcus/quinn/rook) or generic? | Agent spawn types |
| Read-to-write ratio | Reading before writing (target: 3:1+) | Tool call counts |
| Corrections | Every time Jason redirected or corrected | Categorized by type |
| Information gaps | What was MISSING from rules that caused extra searching | Specific routing/rule proposals |

**Report output:** `docs/research/session-audit-{date}-{session}.md`

### Rule File Scope

| File | Scope | Loop |
|------|-------|------|
| `~/.claude/CLAUDE.md` | Global — every project, every session | Loop 2 |
| `{repo}/CLAUDE.md` | This repo only | Both |
| `{repo}/AGENTS.md` | This repo only, referenced via @AGENTS.md | Both |
| `.claude/agents/*.md` | Agent briefs — per-agent instructions | Loop 1 |
| Memory files | Cross-project | Loop 2 |

### Quality Tools

| Tool | What It Scores | When |
|------|---------------|------|
| agnix | Instruction file quality — 455 rules, SARIF output. Catches weak language, negative-only directives, lost-middle placement | After every audit |
| RepoRails (@reporails/cli) | Directive density, specificity, cross-file conflicts/repetitions. Scores 0-10 | After every audit |

Both tools run on ALL instruction files the agent reads — not just repo files. Global CLAUDE.md included.

## How the Auditor Works

### Loop 1 (fresh agent auditor)
```
Agent({
  subagent_type: "general-purpose",  // fresh, no context
  prompt: "Read the transcript at {output_file}. For each tool call, classify as
           direct-hit / search / bounce / wasted. Count metrics. Produce report."
})
```

### Loop 2 (session auditor)
```
Agent({
  subagent_type: "fork",  // inherits full conversation context
  prompt: "Audit THIS session. List every Read/Bash call, grade each for efficiency.
           Check every rule from CLAUDE.md and AGENTS.md. List corrections from Jason.
           Propose rule improvements. Save report."
})
```

## Report Format

Every session audit produces one report with these sections in this order. No extras.

### 1. Scorecard (comparison surface)

| Metric | This Session | Previous | Target | Trend |
|--------|-------------|----------|--------|-------|
| Direct hit rate | % | % | 100% | ↑↓→ |
| Avg attempts per search | Nx | Nx | 1x | ↑↓→ |
| Wasted calls | N (%) | N (%) | 0 | ↑↓→ |
| Total tool calls | N | N | ≤40 | ↑↓→ |
| Rules followed | N/N (%) | N/N (%) | 100% | ↑↓→ |
| Jason corrections | N | N | ≤2 | ↑↓→ |
| agnix findings | N | N | 0 | ↑↓→ |
| RepoRails quality | N/10 | N/10 | 6+ | ↑↓→ |
| ctxlint tokens loaded | N | N | ≤1,200 | ↑↓→ |
| Context efficiency | % useful | % useful | 80%+ | ↑↓→ |

"Previous" column pulls from the most recent prior audit in `docs/research/session-audit-*.md`.

### 2. Rule compliance (every rule, graded)

For EACH rule in global CLAUDE.md + repo AGENTS.md:

| Rule | Followed? | Evidence | If violated: why the wording failed |

### 3. What worked → keep. What didn't → reword.

| Rule | Wording | Worked? | If no: proposed rewording |

This is the decision table. No new rules — only tighten existing ones.

### 4. Tool results (agnix + RepoRails + ctxlint)

Run on ALL instruction files the DA loaded this session:
- `~/.claude/CLAUDE.md` (global)
- `{repo}/CLAUDE.md` + `{repo}/AGENTS.md` (repo)
- Any agent briefs loaded by subagents

Show: total findings, per-file score, top 3 rules hit, cross-file conflicts.

### 5. Corrections from Jason

| # | What Jason said | Category | Rule that should have prevented it |

Categories: scope, process, action, design. Map each correction to a rule — if no rule exists, that's a gap.

### 6. Context efficiency

For each auto-loaded file, per-rule classification: USED / VIOLATED / IRRELEVANT / WASTED / REDUNDANT.

Summary: lines loaded, % useful, % dead weight. Compare to previous.

### 7. Fixes applied this session

| Rule | Before wording | After wording | Expected impact on scorecard |

### Prior research inputs

The auditor MUST read these before producing the report:
- Most recent `docs/research/session-audit-*.md` — for "Previous" column
- `docs/research/context-management.md` — sigmoid collapse at 16+ rules (ETH Zurich)
- `specs/INSTRUCTION-COMPLIANCE-SPEC.md` — COMP test definitions, compliance layers
- `test/compliance-tests.json` — COMP-1 through COMP-5 pass conditions

## Success Criteria

- [ ] SC-321: Session auditor fork produces navigability metrics (direct hits, searches, bounces, wasted reads)
- [ ] SC-344: Auditor scopes to current session only — not entire conversation history
- [ ] SC-322: AGENTS.md rules extracted and checked against session evidence
- [ ] SC-323: Global CLAUDE.md rules checked against session evidence
- [ ] SC-324: Delegation matrix scored — project agents vs generic agents
- [ ] SC-325: agnix runs on all instruction files (global + repo + agent briefs)
- [ ] SC-326: RepoRails runs on all instruction files
- [ ] SC-327: Read-to-write ratio computed
- [ ] SC-328: User corrections counted and categorized
- [ ] SC-329: Report written to docs/research/
- [ ] SC-330: Metrics compared to previous session audit — trend tracked
- [ ] SC-347: Hill climb loop runs: fresh agent → auditor → compare → improve → re-run
- [ ] SC-348: Collaboration audit runs: fork auditor → agnix + RepoRails → compare → improve

## Cautions

- The fork-based auditor (Loop 2) only sees the main conversation thread. It cannot see what happened inside subagents. For subagent behavior, use Loop 1's transcript-reading approach.
- Context compression may lose early-session details in long sessions. Run the audit before context gets compressed — don't wait until the very end of a marathon session.
- agnix and RepoRails may rate-limit or timeout. Run them outside the fork if needed.
- The auditor is grading instruction quality, not agent intelligence. A "FAIL" means the rules need tightening, not that the agent is broken.
