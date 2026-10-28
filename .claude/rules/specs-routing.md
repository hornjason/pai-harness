---
description: Read the governing spec BEFORE making changes in spec-governed areas
paths:
  - "specs/**"
  - "lib/**"
  - "gates/**"
  - "hooks/**"
  - "scripts/**"
generated-sha: 27a71202820e54d4
---

Read the governing spec BEFORE making changes in that area.

| Spec | Governs | Testable |
|------|---------|----------|
| AGENT-BRIEF-TEMPLATE-SPEC.md | Agent brief templates — externalized markdown templates with variable substitution, not hardcoded TypeScript strings | true |
| AGENTS-MD-TEMPLATE-SPEC.md | AGENTS.md template structure — what's baked in, what's scanned, how to update | true |
| BOOTSTRAP-DATA-FLOW-SPEC.md | STATES NO CRITERIA — Redirect stub — this spec was split into specs/bootstrap-data-flow/; it governs nothing itself and exists to point reade | false |
| BOOTSTRAP-TEST-PLAN.md | Test strategy for BOOTSTRAP-DATA-FLOW-SPEC.md — verification approach, phased implementation, golden fixture, content as | true |
| CODE-REVIEW-CONVERGENCE-SPEC.md | Automated code review convergence — the mechanisms from Anthropic's "Solving code review" that RunGate adopts, what each | true |
| CONFIG-DIRECTORY-STRUCTURE-SPEC.md | rungate config architecture — directory-based config replacing monolithic rungate.json, self-describing compliance polic | true |
| CONFIG-DRIVEN-TESTING-SPEC.md | Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration | true |
| DA-COMPLIANCE-SPEC.md | DA compliance evaluation — role-specific grading criteria for DA, Marcus, and Quinn agents with scoring dashboard | false |
| DOC-HYGIENE-ARCHITECTURE-SPEC.md | Doc-hygiene architecture — spec discovery via governs-field, mechanical drift detection, signal-based enforcement | true |
| GATE-CONTRACTS-SPEC.md | Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain | true |
| GITHUB-API-MIGRATION-SPEC.md | GitHub API access — two-layer architecture replacing gh CLI with MCP (agent prompts) and Octokit (TypeScript infrastruct | true |
| HARNESS-GATES.md | Gate definitions — what checks run at each harness gate and their pass/fail criteria | true |
| HARNESS-SKILL-CHAIN.md | STATES NO CRITERIA — Skill chaining — how goal → ship → prove → close sequences connect and pass state | true |
| HARNESS-SKILL-CONTRACT.md | STATES NO CRITERIA — Skill interface contracts — inputs, outputs, artifacts, and handoff protocols between skills | true |
| HARNESS-STANDARD.md | Harness workflow — the GOAL → DISCOVERY → EXECUTION → VERIFICATION loop and how skills chain | true |
| HOOK-ARCHITECTURE-SPEC.md | Hook architecture — hooks as thin triggers delegating to lib/ modules, not deep logic in hook files | true |
| INSTRUCTION-COMPLIANCE-SPEC.md | Instruction compliance testing — grading, behavioral verification, and hill climbing template files | true |
| PARALLEL-AGENT-COORDINATION-SPEC.md | Parallel agent coordination — file-claim manifests and module-boundary decomposition to prevent merge conflicts in multi | true |
| PROJECT-STATE.md | Project state management — how project-state.json drives PROJECT-STATE.md generation and session handoff | true |
| RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md | Agent rule lifecycle — baseline vs mined tiers, path-scoped loading, concurrent-load budget, automatic promotion and ret | true |
| SCAFFOLD-DECOMPOSITION-SPEC.md | Scaffold decomposition — extracting scan, generation, and validation from the 1,844-line scaffold-project.ts into focuse | true |
| SESSION-AUDIT-SPEC.md | Session behavioral audit — two feedback loops for instruction quality improvement | false |
| SESSION-LIFECYCLE-SPEC.md | Session start and end rituals — cold-start context loading, session-end state capture, handoff brief generation | true |
| SPEC-AUTHORING-SPEC.md | Spec authoring — the frame a new spec is born with, and the rule that a ticked criterion must name what proved it | true |
| harness-automation-matrix.md | STATES NO CRITERIA — Automation strategy — bash scripts vs hooks vs workflows for harness enforcement | true |
| bootstrap-data-flow/ (6 specs) | Bootstrap data flow — scan order, data sources, consumer requirements, re-run behavior | true |
