---
doc-type: spec
status: draft
owner: jason
created: 2026-10-02
updated: 2026-10-02
governs: Doc-hygiene architecture — spec discovery via governs-field, mechanical drift detection, signal-based enforcement
testable: true
compliance: strict
---

# Doc Hygiene Architecture

## Context

Doc-hygiene currently stamps frontmatter (HYGIENE-1 through HYGIENE-10 in `lib/conformity.ts`) but does NOT verify specs match implementation or detect spec drift. `Skill("doc-hygiene")` is referenced at two mandatory positions in HARNESS-STANDARD.md (ITERATION line 326, FEEDBACK line 444) and required by close-gate (HARNESS-GATES.md:110), but no skill implementation exists. Every ship cycle has been non-compliant.

Council session (2026-10-02) produced 12 decisions across 3 rounds with architect, engineer, and security members. This spec codifies those decisions.

## Design Decisions (from Council)

| # | Decision | Rationale |
|---|----------|-----------|
| DEC-001 | Fix logSignal() silent-drop bug at lib/gate-enforcement.ts:221 | existsSync guard silently discards signals when file doesn't exist. appendFileSync creates the file if absent |
| DEC-002 | governs-field in spec frontmatter is the primary discovery mechanism | Persistent read-time source. Not workflow-state.json (session-scoped write-time data) |
| DEC-003 | lib/spec-registry.ts as shared module from day one | Three consumers already parse governs-field independently — centralize the contract |
| DEC-004 | lib/doc-hygiene.ts for content-alignment, extract drift-detection at 300 lines | One module until complexity demands extraction |
| DEC-005 | New checks start as WARN per Decision #9 (spec-policies.json) | Promote to FAIL only after >80% precision over 10+ cycles |
| DEC-006 | No LLM-based semantic comparison (Layer 3) | Layers 0-2 are deterministic, fast, tamper-resistant. Unanimous rejection |
| DEC-007 | Route doc-hygiene signal through GateEnforcement.hook.ts | Pragmatic — close-gate infrastructure doesn't exist yet |
| DEC-008 | Minimal rungate.json config: specDirs only (default ['specs']) | Extend only when second consumer proves the need |
| DEC-009 | #299 spec-alignment is SUBSET of doc-hygiene | Same detection engine, different enforcement boundaries |
| DEC-010 | Skill('doc-hygiene') as thin facade with 5-second fast-exit | git diff since last signal — skip if no governed files changed |
| DEC-011 | Replace manual SPEC_HASHES with auto-generated drift-hashes.json | Deferred to Phase 1 |
| DEC-012 | WARN-to-FAIL promotion must be mechanical | Log findings to signals.jsonl, compliance report surfaces candidates |

## Detection Layers

| Layer | What | Speed | How |
|-------|------|-------|-----|
| L0 | Dead-reference lint | Sub-second | governs: targets resolve to real files |
| L1 | Term/decision-ID extraction | Seconds | D-NNN IDs in ACs exist in governing spec |
| L2 | Hash-based change tracking | Seconds | drift-hashes.json manifest, updated via CLI |
| L3 | LLM semantic comparison | N/A | **Rejected** — non-deterministic, costly, injection surface |

## Success Criteria

### Phase 0 — Enforcement infrastructure (#24)

- [ ] SC-504: lib/gate-enforcement.ts not contains [existsSync(signalsFile)]
- [ ] SC-505: lib/spec-registry.ts exports [getGoverningSpecs, getGovernedFiles, getUngoverned]
- [x] SC-506: lib/spec-registry.ts contains [governs, frontmatter, specs/, invertedIndex]
- [x] SC-507: test/spec-registry.test.ts contains [getGoverningSpecs, getGovernedFiles, getUngoverned, mock]
- [x] SC-508: hooks/GateEnforcement.hook.ts contains [doc-hygiene, signals, signal]
- [ ] SC-509: lib/doc-hygiene.ts exports [runContentAlignment, checkDocHygiene]

### Phase 1 — Content alignment checks (follow-up)

- [ ] SC-510: lib/doc-hygiene.ts contains [CONTENT-1, governs, resolve, existsSync]
- [ ] SC-511: lib/doc-hygiene.ts contains [CONTENT-2, hash, drift, manifest]
- [ ] SC-512: .claude/rungate/compliance.json contains [docHygiene, specDirs]
- [ ] SC-513: test/doc-hygiene.test.ts contains [CONTENT-1, CONTENT-2, WARN, governs]

### Phase 2 — Integration + promotion tracking (follow-up)

- [ ] SC-514: lib/doc-hygiene.ts contains [git, diff, changed, skip]
- [ ] SC-515: lib/compliance-report.ts contains [promotion, precision, WARN, FAIL, 80]

## Constraints

- All new content-alignment checks MUST start as WARN, not FAIL (spec-policies.json Decision #9)
- Skill('doc-hygiene') MUST exit in <5 seconds on cache hit (no governed files changed)
- governs-field is the ONLY spec discovery mechanism — do not add alternative discovery paths
- No LLM-based detection (DEC-006) — all checks must be deterministic
- Signal logging MUST include check-id, file, and finding-type metadata for promotion tracking

## Anti-Criteria

- [ ] SC-A1: No LLM/AI model calls in lib/doc-hygiene.ts or lib/spec-registry.ts
- [ ] SC-A2: No FAIL-level content checks without 10+ cycle precision data
