---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain
testable: true
compliance: permissive
---

# Gate Contracts

## Problem Statement

The `gates/` directory has 7,456 lines across 22 files (11 source, 11 test). Three modules are substantial: `run-gate.ts` (936 lines), `orchestrator.ts` (569 lines), `ship-orchestrator.ts` (363 lines). HARNESS-GATES.md defines gate concepts but doesn't specify the code contracts — what each gate function takes as input, what it returns, what constitutes pass/fail, and how gates chain together.

Without contracts, gate behavior is defined by implementation, not spec. Changes to one gate can silently break the chain. Test coverage exists (orchestrator.test.ts at 950 lines, workflow.test.ts at 1,053 lines) but tests verify current behavior, not specified behavior.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Every gate has a typed contract: input interface, output interface, pass/fail criteria | Contracts make gate behavior verifiable independent of implementation |
| D-2 | Gate contracts defined in this spec, not just in code | Spec-driven contracts mean the conformity engine can validate them |
| D-3 | Gate chaining is explicit — output of gate N is input to gate N+1 | No implicit state passing. Chain is a typed pipeline |
| D-4 | run-gate.ts (936 lines) reviewed for decomposition | Same pattern as scaffold — may be an orchestrator doing too much |

## Current State

| Gate | Lines | Test Lines | Contract Defined? |
|------|-------|-----------|------------------|
| run-gate.ts | 936 | — | No |
| orchestrator.ts | 569 | 950 | Partially (HARNESS-STANDARD.md) |
| ship-orchestrator.ts | 363 | 379 | Partially (HARNESS-SKILL-CHAIN.md) |
| brief-assembler.ts | 338 | 429 | No |
| schema.ts | 362 | 197 | No |
| witness.ts | 220 | — | No |
| self-heal.ts | 121 | 511 | No |
| error-classifier.ts | 89 | 249 | No |
| preload.ts | 77 | — | No |

## Success Criteria

- [ ] SC-373: Every gate source file has a typed input/output interface exported
- [ ] SC-374: Pass/fail criteria for each gate documented as SCs in this spec
- [ ] SC-375: Gate chain order documented — which gates feed into which
- [ ] SC-376: gates/run-gate.ts is under [400] lines
- [ ] SC-377: Gate contracts testable by conformity engine (interface exports verifiable)
- [ ] SC-378: No gate passes implicit state — all data flows through typed interfaces

## Implementation

### Phase 1: Contract audit
1. Read each gate file, extract the implicit contract (what goes in, what comes out)
2. Document contracts as interfaces in this spec
3. Identify gates with no clear contract boundary

### Phase 2: Interface extraction
1. Add typed interfaces to each gate file
2. Ensure gate chain is explicitly typed (output of N = input of N+1)
3. Add SC for each gate's pass/fail criteria

### Phase 3: run-gate.ts decomposition
1. Separate CLI argument parsing from gate logic
2. Extract orchestration into its own module
3. Target: under 400 lines

## Cautions

- Gates are the enforcement backbone — don't break the chain during contract extraction
- Some gates may have intentionally loose contracts (self-heal accepts anything) — document that as a design choice, not a gap
- Test files for gates are large (orchestrator.test.ts at 950 lines) — they may benefit from the same thin consumer migration we just did, but that's a separate task
