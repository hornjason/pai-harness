---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration
testable: true
compliance: permissive
---

# Config-Driven Testing

## Problem Statement

Two parallel test systems exist: the conformity engine (config-driven, auto-discovers SCs from specs) and hand-wired phase test files (2,657 lines of manual assertions). When you add an SC to a spec, the conformity engine picks it up automatically — but ~50% of SCs don't match any pattern and fall through. Those get hand-wired in phase files, creating a maintenance burden where adding an SC means editing both a spec and a test file.

The goal: editing a spec is the only action needed. Zero fallthrough. No hand-wired test assertions for SC verification.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | Expand matchPattern() matcher library to cover 100% of SC patterns | Current 13 matchers leave ~50% unmatched. New matchers cheaper than maintaining hand-wired tests |
| D-2 | Phase-0 becomes thin: run scaffold → call conformity engine on output | 949 lines of hand-wired assertions replaced by engine call. Custom tail ≤50 lines for fixture-specific checks |
| D-3 | Source-code checks (phase 2/3/5) get a new matcher domain | "Does harness source contain X" is a valid conformity check, just a different target than scaffold output |
| D-4 | Fixture staleness is a test failure, not a silent gap | SCs referencing files the golden fixture doesn't produce = red test. No silent coverage gaps |
| D-5 | matchPattern() fallthrough is a test failure in strict mode | Unmatched SCs in testable specs with strict compliance = FAIL, forcing matcher expansion |

## Target State

1. Every SC in every `testable: true` spec auto-generates a test via the conformity engine
2. Phase test files are thin consumers (≤100 lines each) — setup + engine call + small custom tail
3. Adding an SC = editing the spec. No test file edits. No config file edits. matchPattern() handles it
4. Golden fixture has a staleness check — SCs that reference files/patterns the fixture doesn't cover are red
5. New matcher types cover the patterns phase tests were hand-checking

## New Matchers Required

| Matcher | Pattern | Covers |
|---|---|---|
| regex-match | `X matches /pattern/` | Phase 2/3 keyword checks in source files |
| source-contains | `harness {file} contains [keywords]` | Phase 2/3/5 source code presence checks |
| json-has-field | `{file}.json has field {name}` | Phase 0 JSON structure checks |
| scaffold-produces | `scaffold output {file} exists` | Phase 0 integration — check scaffold output, not static project |
| frontmatter-field | `{file} frontmatter has {field} = {value}` | Phase 5 agent file checks |
| file-line-range | `{file} is between [N] and [M] lines` | Line count range checks beyond simple threshold |

## Success Criteria

- [ ] SC-331: matchPattern() returns non-null for 100% of SCs in testable strict specs — zero fallthrough
- [ ] SC-332: Phase-0 test file is ≤100 lines — setup + runScaffoldConformity() on output + custom tail
- [ ] SC-333: Phase-2 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-334: Phase-3 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-335: Phase-5 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-336: regex-match matcher exists in matchPattern() and handles `/pattern/` syntax
- [ ] SC-337: source-contains matcher exists in matchPattern() for harness source file checks
- [ ] SC-338: json-has-field matcher exists in matchPattern() for JSON structure assertions
- [ ] SC-339: scaffold-produces matcher exists — runs scaffold on fixture, checks output file
- [ ] SC-340: frontmatter-field matcher exists in matchPattern() for YAML frontmatter checks
- [ ] SC-341: Golden fixture staleness check — SCs referencing files not in fixture output = FAIL
- [ ] SC-342: Adding a new SC to a testable spec and running `bun test` produces a test without editing any test file
- [ ] SC-343: Phase-1.5 tests remain as conformity engine unit tests — not migrated

## Implementation

### Phase A: Matcher Expansion
1. Audit all unmatched SCs — categorize what pattern each needs
2. Implement new matchers (SC-336 through SC-340) in matchPattern()
3. Verify: unmatched count drops to zero (SC-331)

### Phase B: Phase-0 Migration
1. Refactor phase-0 to: copy fixture → run scaffold → call runScaffoldConformity(outputDir)
2. Move fixture-specific assertions (≤50 lines) into a custom tail
3. Verify: phase-0 ≤100 lines (SC-332), all existing tests still pass

### Phase C: Phase 2/3/5 Migration
1. Implement source-contains and regex-match matchers
2. Refactor phase-2/3/5 to thin consumers calling conformity engine on harness source
3. Verify: each file ≤100 lines (SC-333, SC-334, SC-335)

### Phase D: Staleness + Verification
1. Add fixture staleness check (SC-341)
2. End-to-end verification: add a test SC, run suite, confirm auto-test (SC-342)

## Cautions

- Phase-0 is an integration test (scaffold → check output), not just a static check. The migration must preserve the "run scaffold first" step — don't lose integration coverage
- Some SCs describe behavioral ordering ("X happens BEFORE Y") that may not fit any matcher. These need explicit design — either a new matcher type or documented exceptions
- The golden fixture must stay in sync with SC additions. The staleness check (SC-341) is the safety net but shouldn't be the only mechanism
- Phase-1.5 tests the engine itself — migrating it into the engine it tests would be circular
