---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain
testable: true
compliance: strict
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
| run-gate.ts | <400 | — | Yes (SC-379) |
| gate-executor.ts | ~600 | — | Yes (SC-388) |
| orchestrator.ts | 569 | 950 | Partially (HARNESS-STANDARD.md) |
| ship-orchestrator.ts | 363 | 379 | Partially (HARNESS-SKILL-CHAIN.md) |
| brief-assembler.ts | 338 | 429 | No |
| schema.ts | 362 | 197 | No |
| witness.ts | 220 | — | No |
| self-heal.ts | 121 | 511 | No |
| error-classifier.ts | 89 | 249 | No |
| preload.ts | 77 | — | No |

## Success Criteria

- [ ] SC-373: Every gate source file has a typed input/output interface exported (behavioral)
- [ ] SC-374: Pass/fail criteria for each gate documented as SCs in this spec (behavioral)
- [ ] SC-375: Gate chain order documented — which gates feed into which (behavioral)
- [x] SC-376: gates/run-gate.ts is under [400] lines
- [ ] SC-377: Gate contracts testable by conformity engine (behavioral)
- [ ] SC-378: No gate passes implicit state — all data flows through typed interfaces (behavioral)

## Per-Gate Pass/Fail Criteria

### SC-379: run-gate pass/fail criteria
- **Input:** `RunGateInput` — gate name, slug, issue number
- **Output:** `ParseTestOutput` (alias for `GateResult[]`)
- **PASS:** All AC evidence commands succeed, all AC verdicts are PASS or SKIP, zero FAIL results
- **FAIL:** Any AC evidence command fails, any AC verdict is FAIL, or any gate check returns FAIL

### SC-388: gate-executor pass/fail criteria
- **Input:** `GateExecutorInput` — gate name, slug, issue number, workDir, stateFilePath
- **Output:** `GateExecutorResult` — resultVal, passes, fails, warns, results, attempt, exitCode
- **PASS:** All gate checks pass, all AC verdicts are PASS or SKIP, exitCode is 0
- **FAIL:** Any gate check fails, any AC verdict is FAIL, or exitCode is non-zero

### SC-380: orchestrator pass/fail criteria
- **Input:** `WriteGateResultInput` — state file path, gate name, pass/fail/warn counts, results array
- **Output:** `GateResult` — check name, result (PASS/FAIL/WARN), detail string
- **PASS:** `fails === 0` and no non-OUTCOME ACs have FAIL verdicts
- **FAIL:** `fails > 0` or any non-OUTCOME AC has FAIL verdict

### SC-381: ship-orchestrator pass/fail criteria
- **Input:** `ShipGateInput` — slug, gate name
- **Output:** `AdvanceResult` — phase, gateResult, failures, iteration, circuitBreaker
- **PASS:** Gate executor completes without error and gate result in state is PASS
- **FAIL:** Gate executor throws or gate result in state is FAIL; circuit breaks after MAX_ITERATIONS

### SC-382: brief-assembler pass/fail criteria
- **Input:** `AssembleBriefInput` — slug, workDir, projectRoot
- **Output:** `AssembleResult` — briefPath, acCount, contextFileCount, validated
- **PASS:** workflow-state.json exists, brief file written, `validated === true` (all required sections present)
- **FAIL:** workflow-state.json missing (throws), or required sections missing (`validated === false`)

### SC-383: schema pass/fail criteria
- **Input:** `SchemaValidateInput` — raw state object to validate
- **Output:** `SchemaValidateResult` — valid boolean, issues array
- **PASS:** Zod parse succeeds with zero issues — no behavioral language, no garbage statements, no weak thresholds
- **FAIL:** Zod parse fails — behavioral pattern detected, garbage statement, weak threshold, or missing required fields

### SC-384: witness pass/fail criteria
- **Input:** `WriteWitnessInput` — slug, gate, result, testOutput, issue, projectRoot
- **Output:** `VerifyWitnessResult` — valid boolean, record, error
- **PASS (write):** Witness file written with valid HMAC signature
- **PASS (verify):** HMAC recomputed matches stored HMAC, all required fields present
- **FAIL:** HMAC mismatch, missing fields, or witness file not found

### SC-385: self-heal pass/fail criteria
- **Input:** `HealInput` — gate, slug, issue, projectRoot, workDir, maxAttempts, dryRun
- **Output:** `HealResult` — result (PASS/FAIL), attempts, failures, circuitBroken
- **PASS:** Gate execution result is PASS within maxAttempts
- **FAIL:** Gate result is FAIL; circuit breaks when `attempt >= maxAttempts`

### SC-386: error-classifier pass/fail criteria
- **Input:** `ClassifyInput` — failures array
- **Output:** `ClassifyResult` (alias for `Classification`) — category, regressionTarget, retryable, failures
- **PASS:** N/A (always produces a classification). Empty failures array returns NON_RETRYABLE
- **FAIL:** N/A — classification is deterministic, never fails; consumer decides action based on category

### SC-387: preload pass/fail criteria
- **Input:** `RecordTestInput` — test name, passed boolean
- **Output:** `TestRecordResult` — testName, result string
- **PASS:** Test result recorded to gate-results.jsonl and recurring failures logged
- **FAIL:** N/A — recording is best-effort; missing state dir silently skips

### SC-388: gate-executor pass/fail criteria
- **Input:** `GateExecutorInput` — gate name, slug, issue number, workDir, stateFilePath, projectRoot, issueRepo
- **Output:** `GateExecutorResult` — passes, fails, warns, results array, testOutput
- **PASS:** All delegated gate functions complete without error, aggregated fails === 0
- **FAIL:** Any delegated function reports failures; consumer (run-gate.ts) aggregates and writes gate result

## Gate Chain Order (SC-375)

The gate chain flows as a typed pipeline. Each gate's output feeds the next gate's input through workflow-state.json:

```
ship-orchestrator.advancePhase(slug)
  -> GOAL -> DISCOVERY (direct advance, no gate)
  -> DISCOVERY -> SCOPE (direct advance, no gate)
  -> SCOPE -> run-gate(scope) -> orchestrator.writeGateResult -> BUILD
  -> BUILD -> run-gate(verify) -> orchestrator.writeGateResult -> SHIP
  -> SHIP -> run-gate(ship) -> orchestrator.writeGateResult -> DONE
```

### Chain connections

1. `ship-orchestrator` -> `run-gate`: advancePhase delegates to runGate which calls the gate executor
2. `run-gate` -> `schema`: validates workflow-state.json against WorkflowStateSchema before gate checks
3. `run-gate` -> `orchestrator`: calls writeGateResult to persist pass/fail and advance phase
4. `run-gate` -> `witness`: calls writeWitness after gate execution to create tamper-evident record
5. `run-gate` -> `brief-assembler`: scope gate validates brief exists and is well-formed
6. `self-heal` -> `run-gate`: re-executes gate up to maxAttempts on failure
7. `orchestrator` -> `error-classifier`: failure results feed into classifyFailures for regression targeting
8. `preload` -> `orchestrator`: test results captured by preload feed into gate result evaluation

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
