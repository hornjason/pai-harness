---
doc-type: council
status: complete
owner: jason
updated: 2026-09-21
---

# Council: CONFIG-DRIVEN-TESTING-SPEC Architecture Review

**Council:** Architect (Serena), Engineer (Marcus), Skeptic (Rook)
**Rounds:** 3 (Positions → Responses → Synthesis)
**Input:** CONFIG-DRIVEN-TESTING-SPEC (SC-331–SC-343), fork audit of 49 unmatched SCs

## Areas of Convergence (all 3 agree)

1. **Category error is real** — static file verification ≠ behavioral runtime validation. matchPattern() verifies file state; ~22 SCs describe runtime actions (hook execution, session behavior, automation wiring). No file matcher can cover them.
2. **"Zero fallthrough" claim is false** — only ~14 of 49 unmatched SCs are addressable by the 6 proposed matchers. ~12 behavioral, ~10 automation, ~13 self-referential SCs are fundamentally unmatchable by file matchers.
3. **Migration sequencing is wrong** — phase-2/3/5 first (simpler, proves pattern), phase-0 last (integration test with circular dependency).
4. **Phase-0 circular dependency** — phase-0 validates the config format itself. You cannot config-drive the config validator.
5. **Spec needs dual-track verification** — static matchers + behavioral test runners are architecturally distinct domains requiring separate approaches.

## Remaining Disagreements

| Topic | Architect | Engineer | Skeptic |
|-------|-----------|----------|---------|
| Matcher registry timing | After proving reuse | First (foundation) | After proving pattern |
| ≤100 line limit | Wrong metric (use single responsibility) | Forcing function (keep as aspiration) | Vanity metric |
| behavioral:true flag | Honest taxonomy | Pragmatic necessity | Spec surrender |

## Verdicts per Design Decision

### D-1: Expand matchPattern() with 6 new matchers for 100% coverage → MODIFY

**Verdict: Add matchers for STATIC SCs only. Drop "100% coverage" and "zero fallthrough."**

The 6 proposed matchers are sound for the ~14 addressable unmatched SCs. But the spec's headline promise — "zero fallthrough" — is false. ~22 behavioral/automation SCs and ~13 self-referential SCs cannot be matched by file-content matchers. Reframe D-1 as: "expand matchers to cover all STATIC file verification SCs."

### D-2: Phase-0 → thin consumer ≤100 lines → MODIFY

**Verdict: Phase-0 stays thick (~200 lines). Migrate phase-2/3/5 first.**

Phase-0 is an integration test that runs scaffold and validates output. It has a circular dependency: it validates the config format the conformity engine uses. Making it a thin consumer loses integration coverage. Target: phase-0 ~200 lines (75% reduction from 949), with explicit behavioral/integration section. Phase-2/3/5 get thin consumer treatment first (they're simpler and prove the pattern).

### D-3: Source-code checks get source-contains matcher → KEEP (with caveat)

**Verdict: Acceptable starting point. Acknowledge it's string matching, not semantic analysis.**

source-contains is "grep in a test framework" — useful for checking keyword presence in source files but can't verify function call relationships, ordering, or runtime behavior. Adequate for phase-2/3/5 keyword checks. May need to evolve to AST-based analysis later, but not yet.

### D-4: Fixture staleness = test failure → KEEP

**Verdict: No objections. Silent gap → red test is universally agreed.**

This is the spec's least controversial decision. SCs that reference files the golden fixture doesn't produce should fail loudly, not silently pass.

### D-5: Fallthrough = FAIL in strict mode → REJECT as-is

**Verdict: Strict mode is DOA without a behavioral exemption mechanism.**

With ~22 SCs fundamentally unmatchable by file matchers, strict mode immediately breaks the suite. Three options surfaced:
1. **behavioral:true frontmatter flag** (Architect/Engineer) — exclude behavioral SCs from strict fallthrough
2. **Dual-track verification** (all three) — separate static and behavioral into different test runners
3. **Abandon strict mode** (Skeptic) — it's incoherent with 45% exemptions

Council consensus: D-5 requires either option 1 or 2 before it can be enabled. Do not ship strict mode without resolving behavioral SCs.

## Recommended Changes to Spec

1. **Reframe "zero fallthrough"** → "zero fallthrough for static file verification SCs"
2. **Add D-6: Dual-track verification** — static (matchers) + behavioral (test runners/observation). One spec, two execution engines
3. **Reverse sequencing** → phase-2/3/5 first, registry refactor, phase-0 last
4. **Add phase-1 (683 lines)** — missing from spec entirely
5. **Phase-0 target: ~200 lines** not ≤100 (circular dependency makes thin consumer inappropriate)
6. **Defer D-5 (strict mode)** until behavioral exemption mechanism exists
7. **Classify every SC** as `static` or `behavioral` before migration begins — this taxonomy drives what goes where

## Missing from Spec

- Phase-1 (683 lines) — not mentioned at all
- Behavioral SC verification approach — the spec has no answer for ~22 SCs
- Matcher registry architecture — matchPattern() is 430 lines with 13 matchers, adding 6 more creates a god function
- SC classification taxonomy — which SCs are static vs behavioral?
- Circular dependency acknowledgment — phase-0 validates the validator
