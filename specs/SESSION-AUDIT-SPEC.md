---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Session behavioral audit — transcript analysis, rule compliance scoring, feedback loop generation
testable: true
compliance: permissive
---

# Session Behavioral Audit

## Problem

At session end, we need a mechanical audit of what the agent actually did — not what it claims it did. Today Jason has to ask for this every session and explain the process each time. It should be a single command that reads the transcript, scores behavior, and produces a report.

## What It Does

```
bun scripts/session-audit.ts [--session-id ID]

1. Find transcript JSONL
   └─ ~/.claude/projects/{project-dir}/{session-id}.jsonl
   └─ Default: current session ID from environment

2. Parse tool calls from transcript
   └─ Extract: Read, Edit, Write, Bash, Agent, Skill calls
   └─ Build timeline: what was called, in what order, on what files

3. Score against COMP tests (test/compliance-tests.json)
   └─ COMP-1: Read AGENTS.md in first 3 calls → PASS/FAIL
   └─ COMP-2: bun test before reporting done → PASS/FAIL
   └─ COMP-3: Golden fixture pattern used → PASS/FAIL
   └─ COMP-4: Spec-drift hash updated → PASS/FAIL
   └─ COMP-5: Governing spec found via routing → PASS/FAIL

4. Score against AGENTS.md rules
   └─ Parse rules from AGENTS.md Rules section
   └─ Check transcript evidence for each rule
   └─ Example: "Commit all changes before reporting done"
      → Check: any Bash("git commit") after last Edit/Write?

5. Score delegation matrix
   └─ Extract Agent spawns from transcript
   └─ Check: subagent_type matches project agents (marcus, quinn, rook, serena)
   └─ Flag: Engineer/general-purpose used when project agent should have been

6. Run agnix on instruction files touched this session
   └─ agnix {files} --format sarif
   └─ Count findings, severity, rules violated

7. Run RepoRails on instruction files touched this session
   └─ npx @reporails/cli check {files}
   └─ Score quality, count HIGH findings

8. Compute metrics
   └─ Read-to-write ratio (Read tool calls / Edit+Write tool calls)
   └─ Discovery efficiency (files read that were actually used vs wasted reads)
   └─ Corrections count (user messages containing "no", "don't", "wrong", "stop")
   └─ Agent delegation accuracy (project agents vs generic agents)

9. Generate report
   └─ Write to: docs/research/session-audit-{date}.md
   └─ Write machine-readable: .rungate/session-audit.json
```

## Output Format

```json
{
  "sessionId": "da1777f6-...",
  "date": "2026-09-21",
  "duration": "3h 15m",
  "toolCalls": {
    "read": 25, "edit": 20, "write": 6, "bash": 60, "agent": 11, "skill": 3
  },
  "compResults": {
    "COMP-1": { "verdict": "FAIL", "evidence": "First Read was memory file, not AGENTS.md" },
    "COMP-2": { "verdict": "PASS", "evidence": "bun test called 12 times, last before final commit" },
    "COMP-3": { "verdict": "PARTIAL", "evidence": "Used fixture but didn't add new fixture files" },
    "COMP-4": { "verdict": "PASS", "evidence": "shasum + SPEC_HASH edit found" },
    "COMP-5": { "verdict": "FAIL", "evidence": "Grepped for SCs instead of reading governing spec" }
  },
  "ruleCompliance": [
    { "rule": "Delegate by name", "verdict": "FAIL", "evidence": "236 Engineer, 0 marcus" },
    { "rule": "Fix all test failures", "verdict": "PASS", "evidence": "12→0 failures" }
  ],
  "delegation": {
    "projectAgents": { "marcus": 0, "quinn": 0, "rook": 0, "serena": 0 },
    "genericAgents": { "Engineer": 3, "fork": 5, "general-purpose": 0 },
    "verdict": "FAIL — project agents not used"
  },
  "metrics": {
    "readWriteRatio": 1.25,
    "correctionsFromUser": 10,
    "discoveryEfficiency": "83%",
    "wastedReads": 2
  },
  "agnix": { "totalFindings": 9, "high": 0, "filesScored": 3 },
  "reporails": { "totalFindings": 70, "high": 9, "qualityScore": 1.5 },
  "proposedRuleTightenings": [
    "DA touches NO files in lib/, scripts/ — Marcus in worktree only",
    "Session-end audit runs automatically, no prompting"
  ]
}
```

## Tools Used

| Tool | What It Does | When |
|------|-------------|------|
| Transcript JSONL parser | Extracts tool calls, builds timeline | Step 2 |
| compliance-tests.json | COMP-1 through COMP-5 definitions | Step 3 |
| AGENTS.md parser | Extracts rules from Rules section | Step 4 |
| agnix | Scores instruction file quality (455 rules, SARIF output) | Step 6 |
| RepoRails (@reporails/cli) | Scores directive density and specificity (97 rules) | Step 7 |

## Integration Points

- `lib/compliance.ts` — Layer 3 `runBehavioralCompliance()` wraps this for automated runs
- `scripts/compliance-loop.ts` — Hill climb loop calls this after each iteration
- `test/compliance-tests.json` — COMP test definitions (add new COMPs here)
- SESSION-LIFECYCLE-SPEC — `session-end.ts` calls this automatically

## Feedback Loop

```
Session happens
    ↓ session-audit.ts reads transcript
    ↓ COMP scores + rule compliance + delegation check
    ↓ agnix + RepoRails score instruction files
    ↓ Report generated with proposed rule tightenings
    ↓ Jason reviews report
    ↓ Rules tightened in AGENTS.md / CLAUDE.md / settings.json
    ↓ Next session: tighter rules → better behavior → audit again
```

## Success Criteria

- [ ] SC-321: session-audit.ts exists and parses transcript JSONL
- [ ] SC-322: COMP-1 through COMP-5 scored from transcript tool calls
- [ ] SC-323: AGENTS.md rules extracted and checked against transcript evidence
- [ ] SC-324: Delegation matrix scored — project agents vs generic agents
- [ ] SC-325: agnix runs on instruction files touched during session
- [ ] SC-326: RepoRails runs on instruction files touched during session
- [ ] SC-327: Read-to-write ratio computed from tool call counts
- [ ] SC-328: User corrections count extracted from transcript
- [ ] SC-329: Report written to docs/research/ and .rungate/
- [ ] SC-330: session-end.ts calls session-audit.ts automatically

## Blocked On

Architecture refactor — this adds a new script and tests that should flow through the conformity engine.
