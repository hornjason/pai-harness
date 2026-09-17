---
doc-type: spec
status: draft
owner: [name]
created: [YYYY-MM-DD]
updated: [YYYY-MM-DD]
governs: [what this spec governs — one line]
testable: false
---

# [Spec Title]

## Problem Statement

[What gap, risk, or need this spec addresses. 2-3 sentences max.]

## Design Decisions

[Key decisions. Use a table for multiple:]

| Decision | What | Rationale |
|---|---|---|
| D-1 | [decision] | [why] |

## Target State

[What the system looks like when this spec is fully implemented.]

## Success Criteria

Each SC must be parseable by the conformity test generator. Use these patterns:

```
File existence:    - [ ] SC-N: {filename} exists at root, ≤{N} lines
Directory:         - [ ] SC-N: {dirname}/ directory exists with ≥{N} {things}
Frontmatter:       - [ ] SC-N: All specs have `testable: true/false` frontmatter
Path resolution:   - [ ] SC-N: All paths referenced in {file} resolve to existing files
Root cleanliness:  - [ ] SC-N: Root is clean (code: ≤{N} items)
Pointer:           - [ ] SC-N: {file} exists with pointer to {target}
Anti-criterion:    - [ ] SC-AN: {thing that must NOT happen}
```

- [ ] SC-1: [first criterion]
- [ ] SC-2: [second criterion]
- [ ] SC-A1: [anti-criterion — must NOT happen]

## Implementation

[Steps to implement. Optional — can reference issues instead.]

## Cautions

[Things that could go wrong. What to verify before/after.]
