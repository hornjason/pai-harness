---
doc-type: spec
status: active
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration
testable: true
compliance: permissive
---

# Config-Driven Testing

## Problem Statement

Two parallel test systems exist: the conformity engine (config-driven, auto-discovers SCs from specs) and hand-wired phase test files (2,657 lines of manual assertions). When you add an SC to a spec, the conformity engine picks it up automatically — but many SCs don't match any pattern and fall through. Those get hand-wired in phase files, creating a maintenance burden where adding an SC means editing both a spec and a test file.

The goal: for static file verification SCs, editing a spec is the only action needed. Zero fallthrough for static checks. Behavioral SCs (runtime actions, session behavior) route to the transcript auditor instead.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | Expand matchPattern() matcher library to cover all static file verification SCs | Current 13 matchers leave many static SCs unmatched. New matchers cheaper than maintaining hand-wired tests |
| D-2 | Phase-0 stays integration-heavy (~200 lines), phases 2/3/5 become thin consumers | Phase-0 has circular dependency (validates config format). Phases 2/3/5 are simpler single-concern checks |
| D-3 | Source-code checks (phase 2/3/5) get a source-contains matcher | "Does harness source contain X" is a valid conformity check, just a different target than scaffold output |
| D-4 | Fixture staleness is a test failure, not a silent gap | SCs referencing files the golden fixture doesn't produce = red test. No silent coverage gaps |
| D-5 | matchPattern() fallthrough is a test failure in strict mode (deferred) | Requires behavioral SCs to be classified and excluded first. Enable after D-6 lands |
| D-6 | Behavioral SCs route to transcript auditor, not file matchers | Runtime behavior ("session-end checks for X") verified by SESSION-AUDIT-SPEC tooling, not matchPattern(). Rewrite hook-wiring SCs as static checks where the artifact exists |

## Target State

1. Every static file verification SC in `testable: true` specs auto-generates a test via the conformity engine
2. Phase-2/3/5 test files are thin consumers (≤100 lines each). Phase-0 is ~200 lines (integration nature). Phase-1 migrated proportionally
3. Adding a static SC = editing the spec. No test file edits. matchPattern() handles it
4. Behavioral SCs are classified and routed to SESSION-AUDIT-SPEC transcript auditor
5. Golden fixture has a staleness check — SCs referencing files the fixture doesn't cover are red
6. Hook-wiring SCs rewritten as static checks where the artifact exists (e.g., "hook file contains [script-name]")

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

- [ ] SC-331: matchPattern() returns non-null for all static file verification SCs in testable strict specs
- [ ] SC-332: Phase-0 test file uses runScaffoldConformity() for auto-matched SCs + integration tail for cross-project checks
- [ ] SC-333: Phase-2 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-334: Phase-3 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-335: Phase-5 test file is ≤100 lines — setup + conformity engine call
- [ ] SC-336: regex-match matcher exists in matchPattern() and handles `/pattern/` syntax
- [ ] SC-337: source-contains matcher exists in matchPattern() for harness source file checks
- [ ] SC-338: json-has-field matcher exists in matchPattern() for JSON structure assertions
- [ ] SC-339: scaffold-produces matcher exists — runs scaffold on fixture, checks output file
- [ ] SC-340: frontmatter-field matcher exists in matchPattern() for YAML frontmatter checks
- [ ] SC-341: Golden fixture staleness check — SCs referencing files not in fixture output = FAIL
- [ ] SC-342: Adding a new static SC to a testable spec and running `bun test` produces a test without editing any test file
- [ ] SC-343: Phase-1.5 tests remain as conformity engine unit tests — not migrated
- [ ] SC-344: Phase-1 test file is ≤200 lines — setup + conformity engine call
- [ ] SC-345: Every SC in testable specs classified as static or behavioral
- [ ] SC-346: Behavioral SCs have `verification: behavioral` tag and route to SESSION-AUDIT-SPEC
- [ ] SC-347: Hook-wiring SCs rewritten as static checks where artifact exists

## Implementation

### Phase A: SC Classification
1. Classify every SC in testable specs as `static` (file artifact) or `behavioral` (runtime action)
2. Rewrite hook-wiring SCs as static checks where the artifact exists (SC-347)
3. Tag genuinely behavioral SCs with `verification: behavioral` (SC-345, SC-346)
4. Verify: every SC has a classification, no ambiguous cases

### Phase B: Matcher Expansion
1. Audit all unmatched static SCs — categorize what pattern each needs
2. Implement new matchers (SC-336 through SC-340) in matchPattern()
3. Verify: unmatched count drops to zero for static SCs (SC-331)

### Phase C: Phase 2/3/5/1 Migration
1. Implement source-contains and regex-match matchers
2. Refactor phase-2/3/5 to thin consumers calling conformity engine on harness source
3. Migrate phase-1 similarly
4. Verify: phase-2/3/5 ≤100 lines (SC-333, SC-334, SC-335), phase-1 ≤200 lines (SC-344)

### Phase D: Phase-0 Migration
1. Refactor phase-0 to: copy fixture → run scaffold → call runScaffoldConformity(outputDir)
2. Keep integration-specific assertions in a custom tail (~50 lines)
3. Verify: phase-0 ≤200 lines (SC-332), all existing tests still pass

### Phase E: Staleness + Verification
1. Add fixture staleness check (SC-341)
2. End-to-end verification: add a test SC, run suite, confirm auto-test (SC-342)
3. Enable D-5 (strict mode) after behavioral SCs are excluded

## Cautions

- Phase-0 is an integration test (scaffold → check output) with a cross-project boundary — it validates harness specs against scaffold output. The conformity engine tests within a project, not across projects. Phase-0 stays at ~840 lines (down from 949) with conformity delegation for in-project SCs + manual tests for cross-project verification
- Behavioral SCs describe runtime actions, not file artifacts. They route to SESSION-AUDIT-SPEC transcript auditor, not matchPattern(). Don't force behavioral checks into file matchers
- Hook-wiring SCs often look behavioral but are actually static (check hook file contents). Rewrite these before classifying as behavioral
- The golden fixture must stay in sync with SC additions. The staleness check (SC-341) is the safety net
- Phase-1.5 tests the engine itself — migrating it into the engine it tests would be circular
- Phase-1 (683 lines) was missing from original spec — now included in Phase C

## Council Review

Reviewed 2026-09-21 by Architect, Engineer, Skeptic (3 rounds). See `docs/council/2026-09-21-config-driven-testing-council.md` for full synthesis. Key findings:
- Category error: static file verification ≠ behavioral runtime validation (resolved by D-6)
- "Zero fallthrough" reframed to static SCs only
- Sequencing reversed: phase-2/3/5 first, phase-0 last
- Phase-0 circular dependency acknowledged
- Strict mode (D-5) deferred until behavioral classification complete
