---
doc-type: reference
status: active
owner: jason
updated: 2026-09-14
---

# workflow-state.json Schema Guide

Read this BEFORE writing ACs or workflow-state.json. The scope gate validates every field.

## AC Required Fields

Every AC must have all of these:

| Field | Type | Constraints |
|---|---|---|
| `id` | string | `AC-1`, `AC-2`, `AC-A1` (A-prefix for anti-criteria) |
| `type` | enum | `CODE` or `OUTCOME` only |
| `statement` | string | Min 5 words. No garbage (see below) |
| `threshold` | object | `{ op, value, unit }` — see Threshold Rules |
| `evidenceMethod` | object | `{ type, command }` — see Evidence Types |

Optional: `specElement` (string), `contextFiles` (array), `verdict`, `evidence`.

## Threshold Rules

```
value: string | number    ← NEVER boolean (true/false will fail Zod validation)
op:    "==" | ">=" | "<=" | ">" | "<" | "!=" | "contains" | "exists"
unit:  string (optional)
```

**Common mistake:** `{ "op": "exists", "value": true }` — FAILS. Use `"value": "true"` (string).

**Weak threshold:** `{ "op": ">=", "value": 1 }` — FAILS. Threshold `>= 1` effectively always passes.

## Evidence Method Types

Valid `type` values (case-sensitive): `GREP_CHECK`, `FILE_EXISTS`, `CURL_CHECK`, `BUN_TEST`, `SCREENSHOT`, `PLAYWRIGHT`, `COMMAND`, `MANUAL`, `grep`, `command`, `api`, `screenshot`, `manual`

## Statement Constraints

**Garbage patterns (auto-rejected):**
- "file exists", "it works", "code is correct/good/done"
- "tests pass", "changes are made/applied/done", "no errors"

**Behavioral language (auto-rejected):**
- "DA should", "remember to", "make sure", "don't forget"

## Ceremony Tier Requirements

| Requirement | LIGHT (XS) | STANDARD (S/M) | THOROUGH (L) |
|---|---|---|---|
| `sourceSpecs[]` | not required | **REQUIRED** | **REQUIRED** |
| `governingSpec` | not required | **REQUIRED** | **REQUIRED** |
| `specElement` on ACs | not required | at least 1 AC per specElement | at least 1 AC per specElement |
| spec-prohibited checks | skipped | **ACTIVE** | **ACTIVE** |
| hardcoded value checks | skipped | **ACTIVE** | **ACTIVE** |

### sourceSpecs format
```json
{ "path": ".github/workflows/issue-triage.md", "citedInDiscovery": true,
  "specElements": ["frontmatter schema pattern", "add-comment config"] }
```
Paths must be relative to projectRoot (not `~/`). The gate resolves: `join(projectRoot, path)`.

### governingSpec format
```json
{ "path": "/Users/jhorn/.claude/PAI/specs/CI-ENFORCEMENT-SPEC.md",
  "detectedFrom": "ship-workflow-discovery" }
```
Path must be absolute (starts with `/`) or relative to projectRoot. `~` is NOT expanded.

## Changelog Actor Values

Valid `actor` enum (lowercase only): `da`, `marcus`, `quinn`, `rook`, `gate-runner`

## Common Scope Gate Failures

| Check name | What it validates | Fix |
|---|---|---|
| `workflow-state.json validates` | Zod schema parse | Fix threshold value types, actor casing, enum values |
| `governing spec exists and is readable` | sourceSpecs[0].path resolves to a file | Use absolute path or path relative to projectRoot |
| `sourceSpecs-required` | STANDARD+ has sourceSpecs[] | Add sourceSpecs with referenced pattern files |
| `discovery-evidence` | sourceSpecs have `citedInDiscovery: true` | Set the flag on each sourceSpec |
| `spec-elements-in-acs` | ACs reference declared specElements | Add `specElement` field to ACs matching sourceSpec elements |
| `no 'DA should'` | No behavioral delegation in AC statements | Rewrite as measurable assertions |
| `no hardcoded paths` | No `/usr/`, `/opt/`, `/home/`, `/tmp/` in statements | Use relative descriptions, not absolute paths |

## Correct vs Incorrect AC

```json
// CORRECT
{
  "id": "AC-1", "type": "CODE",
  "statement": "sc-verification.md exists with pull_request trigger in frontmatter",
  "threshold": { "op": "contains", "value": "pull_request", "unit": "trigger" },
  "evidenceMethod": { "type": "grep", "command": "grep 'pull_request' .github/workflows/sc-verification.md" },
  "specElement": "gh-aw workflow frontmatter schema pattern"
}

// INCORRECT — 4 problems
{
  "id": "AC-1", "type": "CODE",
  "statement": "file exists",                          // garbage pattern, < 5 words
  "threshold": { "op": "exists", "value": true },      // boolean value, needs "true" string
  "evidenceMethod": { "type": "check" },                // invalid type, use "command"
  "specElement": "something"                            // doesn't match any sourceSpec specElement
}
```

## Writing workflow-state.json

Use **writeWorkflowState()** via `bun -e`, not the Write tool or Bash `cat >` / `echo >`:

```
bun -e "import {writeWorkflowState} from './gates/orchestrator.ts'; import {readFileSync} from 'fs'; const s = JSON.parse(readFileSync('WORK_DIR/workflow-state.json','utf8')); /* apply fix */; writeWorkflowState('WORK_DIR/workflow-state.json', s);"
```

This validates via Zod at write time with enum-specific error formatting. Invalid values produce immediate feedback (e.g., `acs.0.threshold.op: expected one of [==, >=, ...], got "equals"`) instead of opaque gate failures later.
