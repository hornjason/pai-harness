---
name: Goal
description: Mandatory first step of the harness loop — decomposes goals into measurable GitHub issues with garbage-tested ACs.
version: 1.0.0
doc-type: reference
status: active
owner: jason
updated: 2026-09-06
contract:
  input: "Observation, screenshot, verbal description, email, or link from user"
  gateIn: "None — /goal is the chain entry point"
  gateOut: "GitHub issue exists with measurable ACs + beforeState captured"
  artifact: "GitHub issue + workflow-state.json with issueGoal, ACs, beforeState"
  outputSchema: "schemas/goal-record.schema.json"
  telemetry: "harness-telemetry.jsonl with skill=goal"
  errorRecovery:
    timeout_seconds: 300
    failure_mode: BLOCK
    cleanup_action: "Close draft issue if created"
    resumable: true
---

# Goal

The mandatory first step of the PAI agentic harness loop. Every implementation task starts here — no exceptions.

Read `PAI/HARNESS-STANDARD.md` for how this skill fits into the full loop.

## Trigger conditions

- When: `/goal`, "I want to...", "we need to...", "fix this...", any new implementation request
- Standalone: yes — always the first skill in the chain
- Chain position: start (entry point)
- Skip when: issue already exists with ACs (use Mode 3 to validate)

## Workflow

See Three Entry Modes below for the full workflow per mode.

## Three Entry Modes

The DA determines which mode applies, then follows that mode's process.

### Mode 1: Goal, No Issues

**Trigger:** Jason states a goal in natural language and no GitHub issues exist for it yet.

**What happens:**
1. The DA reads project PRINCIPLES.md pre-flight questions (if the project has one) — these inform goal decomposition
2. The goal is decomposed into measurable success criteria (SC-1, SC-2, ...)
3. **Garbage test on every SC:** Each SC is tested: "Could garbage data pass this?" If yes, the SC is tightened until the answer is no
4. Scope boundary is defined (what's in, what's out)
5. Circuit breaker defaults are set (or Jason is consulted if non-default needed):
   - Per-issue: 5 iterations max
   - Per-goal: $20 cost ceiling, 5M token ceiling
6. A GitHub issue is created via `gh issue create` using the template below
7. A checkpoint is written to `$PAI_WORK_DIR/{slug}/CHECKPOINT.md`

### Mode 2: Goal, Issues Exist

**Trigger:** Jason states a goal and related GitHub issues already exist.

**What happens:**
1. Existing issues are searched: `gh issue list --repo hornjason/pai-config --state open --search "[keywords]"` (also checks hornjason/asaCommandCenter)
2. Each related issue is read — existing scope is understood
3. Existing issues are mapped against the goal — which success criteria do they cover?
4. Gaps are identified — which criteria have no issue yet?
5. Only gap issues are created using the template below
6. **Umbrella trigger (mechanical):** If 2+ issues (existing + newly created) map to this goal, an umbrella issue is auto-created:
   - The `decomposed` label is added to the umbrella
   - The goal issue template below is used with an additional `## Children` section:
     ```
     ## Children
     - [ ] #N — [title]
     - [ ] #M — [title]
     
     max-children: 8
     ```
   - `Parent: #UMBRELLA` is added to each child issue body at creation time
   - The umbrella's SCs are the aggregate goal; children have decomposed ACs
   - close-gate.sh handles rollup validation (D1: child-refs, D2: children-closed + shipped label, D3: no-orphans, D4: max-children WARN)
   - If only 1 issue maps to the goal, umbrella creation is skipped — single-issue flow unchanged
7. A checkpoint is written

### Mode 3: Issue, No Goal

**Trigger:** Jason points at a specific issue number ("ship issue #33").

**What happens:**
1. The issue is read: `gh issue view [number] --repo [repo]`
2. ACs are validated against the garbage test — if any AC could be passed by garbage, the DA tightens it
3. Standardized structure is checked — if missing sections (Goal, Success Criteria, Scope Boundary, Circuit Breakers), they are added via `gh issue comment`
4. Related issues are checked: `gh issue list --search "[keywords]"`
5. **Governing Spec Detection:** The skill detects if the issue references a governing spec:
   - The issue body is grepped for `ADR-`, `Governing spec:`, `spec/`, or spec file paths
   - If found: the spec is read, the path is extracted, and it is added to GoalRecord as `governingSpec.path` with `detectedFrom: "issue-body"`
   - If not found: `governingSpec` is omitted from GoalRecord (optional field)
   - When governingSpec is present: each SC traces to a spec claim (or notes "no spec claim — new behavior")
6. A checkpoint is written

## Goal Type Classification

Before creating output, the goal type is classified using this deterministic decision tree:

```
Is this a structural/architectural decision?
  YES → Is there an existing ADR for this area?
    YES → type: github-issue (implement against existing ADR)
    NO → type: adr (create ADR first, then issues)
  NO → Is this a multi-issue initiative (L-sized)?
    YES → Is there a clear scope + user value?
      YES → type: prd (create PRD, then decompose to issues)
      NO → type: research-brief (research first, then PRD)
    NO → Is this investigative/exploratory?
      YES → type: research-brief
      NO → type: github-issue (default)
```

### Output Types

| Type | Output | When | Example |
|---|---|---|---|
| `github-issue` | GitHub issue with ACs | Default — most goals | "Fix subject duplication in batch emails" |
| `adr` | ADR document + GitHub issue for implementation | Structural/architectural decisions with no existing ADR | "How should skills communicate state?" |
| `prd` | PRD document + decomposed issues | L-sized initiatives with clear scope | "Build campaign UI with real-time preview" |
| `spec` | Spec document | Defining behavior for an existing system | "Document the skill chain handoff protocol" |
| `research-brief` | Research output document | Exploratory/investigative goals, unclear scope | "What multi-agent frameworks handle chain state?" |

### Routing Rules

- **`github-issue` (default):** Follows existing Mode 1/2/3 workflow. GoalRecord `artifactRef.type` = "github-issue".
- **`adr`:** The ADR is written to `PAI/ADR/ADR-NNN-{slug}.md` using ADR template. A GitHub issue is created for Phase 1 implementation. GoalRecord `artifactRef.type` = "adr", `artifactRef.locator` = ADR file path.
- **`prd`:** The PRD is created via `Skill("to-prd")`. Decomposition happens via `Skill("to-issues")`. GoalRecord `artifactRef.type` = "prd", `artifactRef.locator` = PRD issue number.
- **`spec`:** The spec is written to `PAI/specs/{name}.md`. GoalRecord `artifactRef.type` = "spec", `artifactRef.locator` = spec file path.
- **`research-brief`:** Research agent(s) are spawned. Output goes to `~/.pai-work/{slug}/research-output.json`. GoalRecord `artifactRef.type` = "research-brief", `artifactRef.locator` = output file path.

### Phase Note

Phase 3b defines the classification and routing rules. The actual implementation of non-issue output types (ADR writing, PRD creation, spec templates) is handled by existing skills (`to-prd`, `to-issues`) or future work. The decision tree ensures consistent classification from day one.

## GitHub Issue Template

Every issue produced by this skill uses this structure. Posted as issue body (Mode 1) or as a structured comment (Mode 3 enrichment):

```markdown
## Goal
[Jason's words, verbatim — or issue's original description]

## Success Criteria
- [ ] SC-1: [measurable, garbage-tested — specific numbers, not "exists" or "works"]
- [ ] SC-2: [measurable, garbage-tested]
- [ ] SC-A1: [anti-criterion — must NOT happen]

## Scope Boundary
- In: [explicit list of what this covers]
- Out: [explicit list of what this does NOT cover]

## Circuit Breakers
- Per-issue: 5 iterations max (override: [N])
- Per-goal: $20 cost ceiling (override: [$N])
- Per-goal: 5M token ceiling (override: [NM])

## Related Issues
- #N — [open/closed] — [how it relates to this goal]
```

## Quality Bar

The skill does not exit until ALL of the following are true. The gate enforces these mechanically:
- [ ] Every SC passes the garbage test
- [ ] Scope boundary has at least one "In" and one "Out" item
- [ ] Circuit breakers are set (defaults or overrides)
- [ ] Related issues searched and listed (even if none found — state "none found")
- [ ] GitHub issue created or enriched
- [ ] Checkpoint written to `$PAI_WORK_DIR/{slug}/CHECKPOINT.md`

## What This Skill Does NOT Do

- Does NOT size the work — sizing happens in Ship SCOPE (PLANNING step)
- Does NOT read project docs for context — that's DISCOVERY
- Does NOT write code or run tests — that's EXECUTION
- Does NOT decompose L-sized work into vertical slices — that's `Skill("to-issues")`

### Before-state capture

After the issue is created, the current state of the bug/feature area is captured in workflow-state.json:

- `beforeState.type`: text | screenshot | api | none
- `beforeState.path`: file path to captured evidence
- `beforeState.capturedAt`: ISO timestamp

For LIGHT tier, `type: "none"` is acceptable. /prove reads beforeState for before/after comparison.

**Test baseline (#483):** If project-harness.json has a `testCmd`, the DA runs it at goal time and captures pass/fail counts in `beforeState.testBaseline`:
```json
"testBaseline": {
  "command": "bun test --isolate test/unit/",
  "pass": 47,
  "fail": 7,
  "capturedAt": "2026-09-11T..."
}
```
Ship gate uses this to distinguish pre-existing failures from regressions — a test count INCREASE in fails is a regression; same or fewer fails is pre-existing. Gate comparison implementation tracked separately.

### Artifact Output

After the GitHub issue is created and before-state is captured, the GoalRecord artifact is written:

1. `~/.pai-work/{slug}/goal-record.json` is created with:
   ```json
   {
     "contractVersion": "1.0",
     "id": "issue-{N}",
     "goalStatement": "[issueGoal verbatim]",
     "successCriteria": [/* SCs from issue, each with id, assertion, evidenceType, threshold */],
     "scopeBoundary": {"in": [...], "out": [...]},
     "artifactRef": {"type": "github-issue", "locator": "owner/repo#N"}
   }
   ```
2. Validation runs via Zod schema — `writeWorkflowState()` in `gates/orchestrator.ts` validates at write time.
3. If validation fails, the error lists valid enum values — fix and re-write. The skill blocks handoff on invalid artifacts.

## Handoff

After this skill completes, the harness proceeds to DISCOVERY (built into Ship SCOPE):
- **Output:** GitHub issue number + checkpoint path
- **Next step:** Project docs are read (PRINCIPLES.md -> ARCHITECTURE.md -> PROJECT-STATE.md)

## Termination Criteria

This skill terminates when:
1. A GitHub issue exists with all template sections populated
2. All SCs pass the garbage test
3. Checkpoint is written
4. Control returns to the harness for DISCOVERY
