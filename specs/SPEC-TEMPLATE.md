---
doc-type: spec
status: draft
owner: [name]
created: [YYYY-MM-DD]
updated: [YYYY-MM-DD]
governs: [intent — "I want to..." language, e.g. "Fix scaffold output, change what files get generated". This drives the AGENTS.md routing table. Write once, be specific.]
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

Each SC must be parseable by the conformity test generator (`lib/conformity.ts` → `matchPattern()`). SCs that don't match a pattern generate a warning but don't fail tests.

### Recognized Patterns

Use these exact patterns for auto-testable SCs:

#### File Existence
```
- [ ] SC-N: {filename} exists
- [ ] SC-N: {filename} exists at root
- [ ] SC-N: {filename} exists, ≤{N} lines
```

**Examples:**
- `AGENTS.md exists`
- `.claude/rungate.json exists at root, ≤100 lines`
- `package.json exists`

**Notes:** Don't use absolute paths (`~/` or `/`) — matcher skips them.

#### Directory Existence
```
- [ ] SC-N: {dirname}/ directory exists
- [ ] SC-N: {dirname}/ directory exists with ≥{N} {things}
```

**Examples:**
- `specs/ directory exists`
- `test/ directory exists with ≥3 files`
- `tests/ directory exists with ≥1 test`

**Notes:** Matcher knows aliases (`test/` ⟺ `tests/`, `reference/` ⟺ `ref/`, `docs/archive/`).

#### Frontmatter Validation
```
- [ ] SC-N: All specs have {field} frontmatter
- [ ] SC-N: All specs have `testable: true/false` frontmatter
```

**Examples:**
- `All specs have testable frontmatter`
- `All specs have updated field in frontmatter`

**Notes:** Must include "all specs have" + "frontmatter" keywords.

#### Path Resolution
```
- [ ] SC-N: All paths referenced in {file} resolve to existing files
```

**Examples:**
- `All paths referenced in AGENTS.md resolve to existing files`
- `All paths referenced in README.md resolve`

**Notes:** Checks markdown links `[text](path)`. Skips URLs and anchors.

#### Root Cleanliness
```
- [ ] SC-N: Root is clean (content: ≤{N} items)
- [ ] SC-N: Root is clean (code: ≤{N} items)
```

**Examples:**
- `Root is clean (content: ≤10 items)`
- `Root is clean (code: ≤30 items)`

**Notes:** Auto-detects content vs code projects. Default limits: content=10, code=30. Ignores dotfiles and `node_modules`.

#### Pointer Verification
```
- [ ] SC-N: {file} exists with pointer to {target}
```

**Examples:**
- `AGENTS.md exists with pointer to specs/`
- `README.md exists with pointer to HARNESS.md`

**Notes:** Checks file exists AND contains the target string.

#### Test Pass
```
- [ ] SC-N: bun test passes
- [ ] SC-N: `bun test {file}` passes
```

**Examples:**
- `bun test passes`
- `bun test test/conformity.test.ts passes`

**Notes:** Always passes (assumes test suite verifies this separately).

#### Canary Pattern
```
- [ ] SC-N: {description} canary test exists
```

**Examples:**
- `Schema canary test exists`
- `Conformity canary exists`

**Notes:** Verifies at least one test file in `test/` or `tests/` with "conformity" or "canary" in filename.

### Anti-Criteria

Anti-criteria (things that must NOT happen) use `SC-AN:` prefix:

```
- [ ] SC-A1: [thing that must NOT happen]
```

**Examples:**
- `SC-A1: No spec files at root (must be in specs/)`
- `SC-A2: No generated files committed to git`
- `SC-A3: No hardcoded credentials in source`

**Notes:** Anti-criteria must include negative language (`not`, `never`, `no`, `absence`, `must not`).

#### Content Contains
```
- [ ] SC-N: {file} contains [{keyword1}, {keyword2}]
```

**Examples:**
- `AGENTS.md contains [## Rules, ## Key Files]`
- `lib/conformity.ts contains [matchPattern, runScaffoldConformity]`

#### Content Not Contains
```
- [ ] SC-N: {file} must NOT contain [{keyword1}, {keyword2}]
- [ ] SC-N: {file} has no [{keyword1}]
```

#### Count Threshold
```
- [ ] SC-N: {file} is under [{N}] lines
- [ ] SC-N: {file} at most [{N}] words
```

#### Section Exists
```
- [ ] SC-N: {file} has section [{SectionName}]
```

#### Regex Match
```
- [ ] SC-N: {file} matches /{pattern}/{flags}
```

**Examples:**
- `AGENTS.md matches /^## Rules$/m`

#### JSON Field
```
- [ ] SC-N: {file} {field} field equals [{value}]
- [ ] SC-N: {file}.json has field {name}
```

**Examples:**
- `package.json name field equals [rungate]`
- `rungate.json has field consumers`

#### Frontmatter Field
```
- [ ] SC-N: {file} frontmatter has {field} = {value}
- [ ] SC-N: {file} frontmatter has {field}
```

**Examples:**
- `specs/MY-SPEC.md frontmatter has testable = true`

#### File Line Range
```
- [ ] SC-N: {file} is between [{N}] and [{M}] lines
```

#### Behavioral (transcript auditor)
```
- [ ] SC-N: {description} (behavioral)
```

**Notes:** SCs tagged `(behavioral)` are excluded from conformity engine matching. They route to the SESSION-AUDIT-SPEC transcript auditor for runtime verification.

### Writing Effective SCs

**DO:**
- Use exact pattern syntax from above
- Be specific about filenames and paths
- Use measurable criteria (line counts, file counts)
- Start with simplest patterns first

**DON'T:**
- Use vague language ("should", "might", "consider")
- Mix multiple criteria in one SC (split them)
- Use absolute paths (`~/`, `/Users/`) — use relative paths
- Write SCs that require human judgment

**Pattern not available?** Complex criteria need custom test code in phase test files (see `test/phase-*.test.ts`).

---

- [ ] SC-1: [first criterion]
- [x] SC-2: [second criterion]
- [ ] SC-A1: [anti-criterion — must NOT happen]

## Implementation

[Steps to implement. Optional — can reference issues instead.]

## Cautions

[Things that could go wrong. What to verify before/after.]
