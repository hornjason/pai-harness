---
doc-type: council
status: active
owner: jason
updated: 2026-09-20
---

# Council: SC-Driven Test Generation

## Verdict (Unanimous)

Extend matchPattern() in lib/conformity.ts — don't replace it. No LLM parsing, no YAML sidecars, no new system.

## Convergence Points

1. Architecture is correct and incomplete, not broken. Extend, don't replace.
2. Path traversal bug in conformity.ts:160 — fix FIRST with shared resolveAndContain() utility.
3. Silent WARN-pass is a defect — conformity.ts:318-322 emits expect(true).toBe(true) for unmatched SCs. Replace with strict/permissive mode.
4. 5 new matchers needed: content-contains (bracket-list), json-field-equals, content-not-contains, section-exists, count-threshold. Each under 20 lines.
5. Phase tests (3,700 lines) remain agent-written — BOOTSTRAP-TEST-PLAN TD-2 mandates content assertions. Not a deficiency, a design decision.
6. No LLM parsing, no YAML sidecars, no Gherkin, no generated .test.ts files — all rejected unanimously.
7. SPEC-TEMPLATE.md must update in lockstep with matchPattern() — same commit.
8. 60/40 split is the designed final state — 40% auto-generated structural, 60% agent-written content.

## SC Format Decision

Keep natural language. Enrich with bracket-list inline values where needed:
```
- [ ] SC-40: .gitignore contains [node_modules, .env, *.pem]
```
matchPattern extracts the bracket-list as assertion values. No format migration.

## Complex SCs

Agent-written tests, not machine-generated. The meta-sc-coverage test detects gaps and triggers agent work. This IS auto-generation — agents as the parser instead of regex.

## Implementation Phases

1. **Phase 0:** Security (resolveAndContain) + feedback (strict/permissive mode)
2. **Phase 1:** 5 new pattern matchers + enrich ~25 SC lines with bracket-list values
3. **Phase 2:** Convert sync-spec-tests.ts claims to SC lines, delete script
4. **Phase 3:** Inline annotation escape hatch for irreducible complex checks

## Deep-Module Result

Adding a new structural check = add one SC line to a spec. matchPattern picks it up at runtime. One edit, one place. No test file to touch.

## Key Code Changes

- lib/conformity.ts:160,268 — add resolveAndContain()
- lib/conformity.ts:318-322 — replace expect(true).toBe(true) with strict/permissive
- lib/conformity.ts:154 — add 5 new matchers
- specs/SPEC-TEMPLATE.md:31 — acknowledge 60/40 split
