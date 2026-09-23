---
doc-type: spec
status: active
owner: rungate
created: 2026-09-23
updated: 2026-09-23
governs: Scaffold output verification — ensures scaffold produces correct files and content
testable: true
compliance: strict
---

# Scaffold Verification Spec

Auto-verified by conformity engine. Each SC uses a matchable pattern so `runScaffoldConformity()` auto-generates the test.

## Success Criteria

### Core scaffold files

- [x] SC-S00: scaffold output verification is active
- [ ] SC-S01: CLAUDE.md exists
- [ ] SC-S02: AGENTS.md exists
- [ ] SC-S03: CODE-MAP.md exists
- [ ] SC-S04: src/index.ts exists
- [ ] SC-S05: test/scaffold-conformity.test.ts exists
- [ ] SC-S06: .github/copilot-instructions.md exists
- [ ] SC-S07: specs/SPEC-TEMPLATE.md exists

### CLAUDE.md content

- [ ] SC-S08: CLAUDE.md contains [@AGENTS.md]

### AGENTS.md structure

- [ ] SC-S09: AGENTS.md has section [Project Identity]
- [ ] SC-S10: AGENTS.md has section [Rules]
- [ ] SC-S11: AGENTS.md has section [Key Files]
- [ ] SC-S12: AGENTS.md has section [Specs]
- [ ] SC-S13: AGENTS.md has section [Tests]
- [ ] SC-S14: AGENTS.md has section [Commands]
- [ ] SC-S15: AGENTS.md has section [Harness-Managed Files]
- [ ] SC-S16: AGENTS.md has section [Environment]
- [ ] SC-S17: AGENTS.md is under [150] lines
- [ ] SC-S18: AGENTS.md must NOT contain [(empty), (none yet, import {, export default]
- [ ] SC-S19: AGENTS.md contains [bun test, create-spec, Check findings, conformity-findings.json]
- [ ] SC-S20: AGENTS.md matches /TypeScript|\.ts/i

### CI workflows

- [ ] SC-S21: .github/workflows/ci.yml contains [Managed by rungate, bun test, tsc --noEmit]
- [ ] SC-S22: .github/workflows/gates.yml contains [Managed by rungate, scaffold-conformity, Secret scan]
- [ ] SC-S23: .github/copilot-instructions.md contains [AGENTS.md]

### Spec and ADR templates

- [ ] SC-S24: specs/SPEC-TEMPLATE.md contains [doc-type: spec, testable:]
- [ ] SC-S25: docs/adr/ADR-001-framework.md frontmatter has doc-type = adr

### .gitignore security

- [ ] SC-S26: .gitignore contains [node_modules, .env, .rungate, *.pem, *.key, credentials.json, service-account]

### Agent brief structure

- [ ] SC-S27: .claude/agents/marcus.md contains [## Core Principles, ## Always Do, ## Never Do, ## Ask First, Verify before asserting]
- [ ] SC-S28: .claude/agents/marcus.md contains [coding-principles, testing-strategy]
- [ ] SC-S29: .claude/agents/marcus.md matches /tools:/m
- [ ] SC-S30: .claude/agents/marcus.md matches /AC|acceptance|threshold|verification command/i
- [ ] SC-S31: .claude/agents/marcus.md frontmatter has name = marcus
- [ ] SC-S32: .claude/agents/quinn.md contains [## Core Principles, ## Always Do, ## Never Do, journey]
- [ ] SC-S33: .claude/agents/rook.md contains [## Core Principles, ## Always Do, ## Never Do]
- [ ] SC-S34: .claude/agents/serena.md contains [## Core Principles, ## Always Do, ## Never Do]
- [ ] SC-S35: .claude/agents/aditi.md contains [## Core Principles, ## Always Do, ## Never Do]

### Scaffold conformity test

- [ ] SC-S36: test/scaffold-conformity.test.ts contains [runSpecDiscovery, runScaffoldConformity, runDocHygiene, runAgentFileValidation, runFallowCheck]

### Required directories

- [ ] SC-S37: src/ directory exists
- [ ] SC-S38: test/ directory exists
- [ ] SC-S39: docs/ directory exists
- [ ] SC-S40: docs/adr/ directory exists
- [ ] SC-S41: specs/ directory exists
- [ ] SC-S42: scripts/ directory exists
- [ ] SC-S43: .claude/ directory exists
- [ ] SC-S44: .claude/agents/ directory exists
- [ ] SC-S45: .github/ directory exists
- [ ] SC-S46: .github/workflows/ directory exists

### Package and config

- [ ] SC-S47: package.json has field name
- [ ] SC-S48: package.json type field equals [module]
- [ ] SC-S49: package.json has field scripts.test
- [ ] SC-S50: package.json has field devDependencies.rungate

### CODE-MAP

- [ ] SC-S51: CODE-MAP.md contains [scanned-at-sha:]

### AGENTS.md rules quality

- [ ] SC-S52: AGENTS.md contains [Fix all, before reporting done]
- [ ] SC-S53: AGENTS.md contains [Bun, TypeScript]
