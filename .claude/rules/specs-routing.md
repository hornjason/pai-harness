---
description: Read the governing spec BEFORE making changes in spec-governed areas
paths:
  - "specs/**"
  - "lib/**"
  - "gates/**"
  - "hooks/**"
  - "scripts/**"
---

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| SESSION-LIFECYCLE-SPEC.md | Session start and end rituals — cold-start context loading, session-end state capture, handoff brief generation | true |
| harness-automation-matrix.md | Automation strategy — bash scripts vs hooks vs workflows for harness enforcement | true |
| PROJECT-STATE.md | Project state management — how project-state.json drives PROJECT-STATE.md generation and session handoff | false |
| HARNESS-GATES.md | Gate definitions — what checks run at each harness gate and their pass/fail criteria | true |
| AGENTS-MD-TEMPLATE-SPEC.md | AGENTS.md template structure — what's baked in, what's scanned, how to update | true |
| CONFIG-DIRECTORY-STRUCTURE-SPEC.md | rungate config architecture — directory-based config replacing monolithic rungate.json, self-describing compliance polic | true |
| INSTRUCTION-COMPLIANCE-SPEC.md | Instruction compliance testing — grading, behavioral verification, and hill climbing template files | true |
| SESSION-AUDIT-SPEC.md | Session behavioral audit — two feedback loops for instruction quality improvement | false |
| DOC-HYGIENE-ARCHITECTURE-SPEC.md | Doc-hygiene architecture — spec discovery via governs-field, mechanical drift detection, signal-based enforcement | true |
| PARALLEL-AGENT-COORDINATION-SPEC.md | Parallel agent coordination — file-claim manifests and module-boundary decomposition to prevent merge conflicts in multi | true |
| CONFIG-DRIVEN-TESTING-SPEC.md | Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration | true |
| GITHUB-API-MIGRATION-SPEC.md | GitHub API access — two-layer architecture replacing gh CLI with MCP (agent prompts) and Octokit (TypeScript infrastruct | true |
| HARNESS-STANDARD.md | Harness workflow — the GOAL → DISCOVERY → EXECUTION → VERIFICATION loop and how skills chain | true |
| HARNESS-SKILL-CONTRACT.md | Skill interface contracts — inputs, outputs, artifacts, and handoff protocols between skills | true |
| BOOTSTRAP-TEST-PLAN.md | Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content as | true |
| GATE-CONTRACTS-SPEC.md | Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain | true |
| HOOK-ARCHITECTURE-SPEC.md | Hook architecture — hooks as thin triggers delegating to lib/ modules, not deep logic in hook files | true |
| AGENT-BRIEF-TEMPLATE-SPEC.md | Agent brief templates — externalized markdown templates with variable substitution, not hardcoded TypeScript strings | true |
| HARNESS-SKILL-CHAIN.md | Skill chaining — how goal → ship → prove → close sequences connect and pass state | true |
| SCAFFOLD-DECOMPOSITION-SPEC.md | Scaffold decomposition — extracting scan, generation, and validation from the 1,844-line scaffold-project.ts into focuse | true |
| BOOTSTRAP-DATA-FLOW-SPEC.md | Redirect stub — this spec was split into specs/bootstrap-data-flow/; it governs nothing itself and exists to point reade | false |
| DA-COMPLIANCE-SPEC.md | DA compliance evaluation — role-specific grading criteria for DA, Marcus, and Quinn agents with scoring dashboard | no |
| bootstrap-data-flow/ (6 specs) | Bootstrap data flow — scan order, data sources, consumer requirements, re-run behavior | yes |
