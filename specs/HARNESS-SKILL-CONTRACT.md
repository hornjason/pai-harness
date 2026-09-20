---
doc-type: spec
status: active
owner: jason
created: 2026-09-03
updated: 2026-09-03
testable: true
governs: TODO
---

# Harness Skill Contract

Every harness-compatible skill must implement this contract in its SKILL.md YAML frontmatter.

## Required Fields

### 1. input
What the skill reads. Issue number, workflow-state.json, observation text, etc.

### 2. gateIn
Preconditions — what must be true before this skill can run. Expressed as verifiable checks.

### 3. gateOut
Postconditions — what must be true when this skill completes. The next skill in the chain checks these.

### 4. artifact
What this skill produces. File path, GitHub comment, state update. Must be a file that survives session boundaries.

### 5. telemetry
Which telemetry file this skill writes to and what fields it logs. All skills write to harness-telemetry.jsonl with a skill field.

### 6. errorRecovery
How the skill handles failures:
- timeout_seconds: max execution time
- failure_mode: BLOCK (stop chain) or WARN (continue with note)
- cleanup_action: what to clean up on failure
- resumable: can the skill be re-run to pick up where it left off?

## YAML Frontmatter Format

```yaml
---
name: SkillName
description: One-line description
version: 1.0.0
contract:
  input: "what it reads"
  gateIn: "preconditions"
  gateOut: "postconditions"
  artifact: "what it produces"
  telemetry: "harness-telemetry.jsonl with skill=name"
  errorRecovery:
    timeout_seconds: 600
    failure_mode: BLOCK
    cleanup_action: "cleanup command"
    resumable: true
---
```

## Chain Handoffs

Each skill's gateOut must satisfy the next skill's gateIn:

```
/goal gateOut: "GitHub issue exists with ACs + beforeState"
  -> /ship gateIn: "Issue exists with ACs"

/ship gateOut: "verify-gate PASS, code on main, mergeCommitSha set"
  -> /prove gateIn: "Code merged to main (mergeCommitSha exists)"

/prove gateOut: "prove-evidence.json with verdict"
  -> /release gateIn: "main is clean"
```

## Validation

Run `bash scripts/harness-skill-check.sh skills/{name}/SKILL.md` to validate any skill.

## Adding a New Skill

1. Create `skills/{name}/SKILL.md` with YAML frontmatter including all 6 contract fields
2. Run `bash scripts/harness-skill-check.sh skills/{name}/SKILL.md` — must PASS
3. Add to chain documentation if it participates in the harness chain
4. Call `/doc-hygiene` to register in project index

## Current Skills

| Skill | Contract? | Chain position |
|-------|-----------|---------------|
| /goal | Yes | Start |
| /ship | Yes | After /goal |
| /prove | Yes | After /ship |
| /release | Yes | After /prove (end) |
| /council | Yes | Lateral (any point) |
