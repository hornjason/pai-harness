---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Instruction compliance testing — grading, behavioral verification, and hill climbing template files
testable: true
compliance: strict
---

# Instruction Compliance Spec

## Problem Statement

RunGate ships template files (prompts/*.md, agent briefs, AGENTS.md scaffold) to consumer projects. These files contain instructions agents are supposed to follow. But we have no proof they work. Instructions can be vague, files can fail to load (wrong frontmatter, wrong agent name), and rules can be ignored. We need a loop that grades every instruction, proves it produces behavior, and iterates until it does — or escalates to mechanical enforcement.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Use external tools (agnix, RepoRails) for instruction quality scoring, not regex | SC-180/181 in bootstrap spec. Tools have 455+ rules and research-backed scoring. Regex reimplementation misses nuance and creates maintenance burden |
| D-2 | Compliance surface is exactly 4 file types | prompts/*.md, AGENTS.md, .claude/agents/*.md, CLAUDE.md — these are instruction files. Hooks, workflows, CODE-MAP are infrastructure |
| D-3 | Behavioral testing uses fresh agent + auditor, not self-grading | The agent being tested can't grade itself. Fresh agent has zero context. Auditor reads complete transcript mechanically. No cherry-picking |
| D-4 | Hill climb max 5 iterations then escalate to mechanical | Behavioral rules that don't work after 5 rewrites need hooks or gates, not more rewording |
| D-5 | Canary values prove file was read AND instruction was processed | A Read call in transcript only proves the file was opened. A canary phrase in the agent's output proves the content was processed |
| D-6 | RepoRails quality score is null on free tier — use finding counts | The tool works, findings are real, quality score requires paid tier. Finding count and HIGH count are the metrics |
| D-7 | All output is machine-readable JSON in .rungate/ | Every iteration writes to compliance-iterations.json. Scores, changes, evidence, test results — all structured for automated comparison |

## Context Loading Hierarchy

Understanding how files load is critical to this spec:

```
CLAUDE.md                          ← always loads (session start)
  └─ @AGENTS.md                   ← always loads (via @-include bridge)
      └─ .claude/agents/{name}.md ← ONLY loads when agentType matches filename
```

**Implication:** If ship.js spawns `agentType: 'Engineer'`, Claude Code looks for `.claude/agents/engineer.md` — which doesn't exist. The brief with all its instructions is never read. This was the root cause of COMP-1 failing for months.

**Fix (applied 2026-09-20):** All workflows now spawn `agentType: 'marcus'`, `'quinn'`, `'rook'` matching `.claude/agents/{name}.md`. All agent files have `name:` and `description:` in frontmatter.

## Tools

| Tool | Package | What It Scores | Speed |
|------|---------|----------------|-------|
| agnix | `agnix` (homebrew) | 455 rules — frontmatter, structural issues, contradictions, SARIF output | 0.1s for 31 files |
| RepoRails | `@reporails/cli` (npx) | 97 rules — directive density, specificity, instruction quality, vague wording | 4s for 31 files |
| agentsmd | `@daichunghy/agentsmd` (npx) | Dead paths, wiring, score 0-100 | Not used in compliance loop |
| ctxlint | `@yawlabs/ctxlint` (npx) | Token counts, enforcement gaps, SARIF | Not used in compliance loop |

Both agnix and RepoRails support batch mode — pass multiple files in one call.

## Three Layers

### Layer 1 — Template Quality (static, cheap, every bun test)

**What:** Run agnix + RepoRails on instruction files via `Bun.spawnSync`. Consume their JSON output.

**Implementation:** `lib/compliance.ts → runTemplateCompliance(root)`

**Output:** `.rungate/compliance-report.json`

**Metrics:**
- Finding count per file (agnix + RepoRails)
- HIGH count per file
- Tool suggestions for each finding

**Gate:** Template files with HIGH findings from agnix cannot ship. RepoRails findings are advisory (no gate) but tracked.

### Layer 2 — Generated Quality (after scaffold)

**What:** After scaffold generates files for a consumer project, score the generated files. Compare against template baseline.

**Implementation:** `lib/compliance.ts → runGeneratedCompliance(root, baseline)`

**Output:** `.rungate/compliance-generated.json`

**Gate:** Generated file score cannot drop more than 0.5 below template baseline. If it does, scaffold must regenerate.

### Layer 3 — Behavioral Compliance (expensive, during iteration and periodic)

**What:** Spawn a fresh agent with a standard task. Let it run to completion. Auditor reads the complete transcript and checks each instruction mechanically.

**Implementation:** `lib/compliance.ts → runBehavioralCompliance(root)` (to be built)

**Standard task:** Defined in `test/compliance-tests.json`:
```
"Add SC-235 to the project spec and implement a passing test"
```

**COMP tests checked against transcript:**

| Test | Instruction | Check Method | Pass Condition |
|------|-------------|--------------|----------------|
| COMP-1 | AGENTS.md context available | Read in first 5 calls OR content injected in prompt | Agent has project context |
| COMP-2 | Test run discipline | Full suite ≤ 2 runs, targeted unlimited | Agent doesn't over-run tests |
| COMP-3 | Use golden fixture pattern for test files | Test file written to test/ with .test. suffix | Agent follows test architecture |
| COMP-4 | Update spec-drift hash after modifying spec | Bash with `shasum` after spec edit | Agent updates hash |
| COMP-5 | Governing spec context available | Read spec before edit OR content injected in prompt | Agent has spec context |
| COMP-6 | No duplicate file reads | Each file read at most once | Agent is efficient with reads |
| COMP-7 | No cat/head via Bash | No `cat` or `head` commands in Bash calls | Agent uses Read tool |
| COMP-8 | PROJECT-STATE context for multi-file tasks | Read PROJECT-STATE or exempt for small tasks | Agent has project context when needed |
| COMP-9 | Tool calls ≤ 30 | Total tool calls under threshold | Agent is efficient |
| COMP-10 | Grep:Read ratio ≤ 2:1 | grep calls / Read calls ≤ 2 | Agent doesn't over-grep |
| COMP-11 | Coding principles available for core changes | Read prompts/ or content injected for lib/ changes | Agent has coding standards |
| COMP-12 | Grep before Read for non-key files | Files not in key-files list grepped before reading | Agent validates relevance first |
| COMP-13 | TDD sequence (test-first) | Write to test file before Write to source file | Agent follows TDD |

**Canary tests:** Plant a known phrase in the instruction file. If the agent's output contains the phrase, the file was read AND the instruction was processed. If not, either the file didn't load or the instruction was too weak.

**Output:** `.rungate/compliance-score.json` with per-instruction PASS/FAIL and transcript evidence.

## The Hill Climb Loop

This is the core iteration flow. Run on every template file RunGate ships.

```
┌─────────────────────────────────────────────────────┐
│ FOR each file in compliance surface (31 files):     │
│                                                     │
│ 1. BASELINE                                         │
│    Run agnix + RepoRails → score, findings, HIGHs   │
│    Record in compliance-iterations.json              │
│                                                     │
│ 2. FIX HIGH FINDINGS                                │
│    Read each HIGH finding's suggestion               │
│    Apply fix to instruction language                  │
│    Record: old text → new text, which suggestion     │
│                                                     │
│ 3. RE-SCORE                                         │
│    Run agnix + RepoRails again                       │
│    Compare: did HIGH count decrease?                 │
│    Record: before/after scores                       │
│                                                     │
│ 4. BEHAVIORAL TEST (agent briefs + AGENTS.md only)  │
│    Plant canary value in file                        │
│    Spawn fresh agent with standard task              │
│    Agent runs to completion (no interference)        │
│    Auditor reads full transcript:                    │
│      - Check COMP-1 through COMP-5                  │
│      - Check canary phrase appeared                  │
│    Record: PASS/FAIL per test + evidence             │
│                                                     │
│ 5. ANY FAIL?                                        │
│    YES → Trace root cause:                          │
│      - File not read? → fix frontmatter/agentType   │
│      - Instruction too vague? → apply 7 factors     │
│      - Wrong position? → move to top 20%            │
│    Go to step 2 (max 5 iterations)                  │
│    NO → Mark file as PASS, move to next             │
│                                                     │
│ 6. AFTER 5 ITERATIONS STILL FAILING?                │
│    Tag: ESCALATED-TO-MECHANICAL                     │
│    The instruction needs a hook or gate, not words   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 7 Compliance Factors (applied during rewrites)

When an instruction fails behavioral testing, rewrite it using these factors:

| Factor | What | Example |
|--------|------|---------|
| Specific | Names exact file, command, or tool | `Run \`bun test\`` not "run tests" |
| Strong modal | Uses must/always/never/MANDATORY | "You must" not "you should" |
| Positive | Tells agent what TO do | "Do Y" not just "don't do X" |
| Observable | Compliance is grep-able from transcript | "Run X" produces a Bash call you can find |
| Positioned | In top 20% of file | Critical rules at top, not buried |
| Short file | File under 120 lines | No "middle zone" agents skip |
| Temporal anchor | Has trigger: BEFORE/AFTER/FIRST | "BEFORE reporting done" not just "run tests" |

### Root Cause Tracing

When a COMP test fails, trace WHY before rewriting:

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Agent never reads the brief | Wrong agentType in workflow | Change to match .claude/agents/{name}.md |
| Agent reads brief but ignores instruction | Instruction too vague or buried | Rewrite with 7 factors, move to top |
| Agent reads AGENTS.md but not the spec | Routing table missing or broken | Fix governing spec table |
| Canary phrase not in output | File not loaded or content skipped | Check frontmatter name field + agentType |
| Agent searches/greps instead of direct read | Routing pointer missing | Add to AGENTS.md routing table |
| Agent runs single test file not full suite | Trigger wrong ("before committing" in worktrees) | Change to "BEFORE REPORTING DONE" |

## Output Files

All output is machine-readable JSON in `.rungate/`:

| File | Written By | Contains |
|------|-----------|----------|
| `compliance-report.json` | `runTemplateCompliance()` | Layer 1: per-file scores from agnix + RepoRails |
| `compliance-generated.json` | `runGeneratedCompliance()` | Layer 2: post-scaffold scores vs baseline |
| `compliance-score.json` | `runBehavioralCompliance()` | Layer 3: per-instruction PASS/FAIL + evidence |
| `compliance-iterations.json` | `scripts/compliance-loop.ts` | Full iteration log: every file, every change, every score, every test |
| `navigability-score.json` | Auditor | Agent navigation efficiency: directHitRate, canaryResults |
| `conformity-findings.json` | Conformity test suite | Structural findings with fix commands |
| `rule-health.json` | `rungate rule-health` | KEEP/RETIRE/FAILING/STALE per rule |

## Honesty Rules

- Report failures as failures. Don't mark PASS when a COMP test failed.
- Don't cherry-pick which rules to check. Check ALL rules mechanically.
- Don't rewrite instructions just to pass tool scores if the behavioral test already passes.
- If a score is ugly, report it ugly. 55% compliance is 55%, not "approximately 86%."
- After 5 iterations, escalate — don't keep rewriting hoping for a different result.

## Governing Research

All design decisions in this spec are backed by research in `docs/research/`:

| Research File | What It Governs |
|---|---|
| context-management.md | Context budgets, three-tier architecture, inferability, drift |
| quality-tools.md | Tool selection (agnix, RepoRails), three-layer architecture |
| constraint-filtering.md | Sigmoid collapse at 16 rules, code-specificity scoring |
| knowledge-mining.md | Temporal coupling, constraint extraction pipeline |
| competitive-analysis.md | Build-vs-wrap decisions, unique value proposition |

## Baseline Data (2026-09-20)

**Pre-fix baseline (before hill climb):**
- 31 files in compliance surface (24 prompts, 5 agent briefs, AGENTS.md, CLAUDE.md)
- 27 HIGH findings total (20 in prompts, 7 in AGENTS.md)
- Top recurring: CORE:C:0019 (missing prohibitions, 18/24 prompts)

**Post-iteration-1 (added "Never" sections to 20/24 prompts):**
- 8 HIGH findings total (1 prompt, 7 AGENTS.md)
- 19/20 prompt errors fixed (95% reduction)
- 1 prompt locked by macOS provenance (container-rebuild.md)
- AGENTS.md: 7 HIGH unchanged — needs structural sections (output format, directory layout, security, glossary)
- Warning count: 118 → 129 (added content creates format nitpicks — iteration 2 target)

**RepoRails tool notes:**
- Batch mode drops findings for small files — use per-file mode for accurate scoring
- Quality score requires paid tier — use finding counts as metric (D-6)
- beforeAll timeout: 240s (31 files × ~4s per RepoRails call)

## Scripts

| Script | What | Run |
|--------|------|-----|
| `scripts/compliance-loop.ts` | Baseline + iteration loop runner | `bun run scripts/compliance-loop.ts` |
| `lib/compliance.ts` | Compliance engine (Layers 1-3) | Imported by tests |
| `test/instruction-compliance.test.ts` | Layer 1 test suite | `bun test test/instruction-compliance.test.ts` |

## Success Criteria

- [x] SC-451: runTemplateCompliance uses agnix + RepoRails via Bun.spawnSync
- [x] SC-452: runGeneratedCompliance compares against baseline
- [x] SC-453: runBehavioralCompliance spawns fresh agent + auditor
- [x] SC-454: Hill climb loop with max 5 iterations
- [x] SC-455: 7 compliance factors applied during rewrites
- [x] SC-456: Compliance surface = 4 file types only
- [x] SC-457: Escalate to mechanical after 5 failed iterations
- [x] SC-458: Report to compliance-report.json
- [x] SC-459: Auditor after every agent
- [x] SC-460: Agent briefs load with matching agentType
- [x] SC-461: Five-layer measurement model
- [x] SC-286: resolveAndContain() utility validates all file paths in matchPattern — rejects [../, absolute paths, symlink escape]
- [x] SC-287: lib/conformity.ts contains [strict, permissive, WARN, FAIL]
- [x] SC-288: matchPattern supports content-contains — SC bracket-list values [x, y, z] become assertion targets
- [x] SC-289: matchPattern supports content-not-contains — SC with "must NOT" or "no" + bracket-list
- [x] SC-290: matchPattern supports count-threshold — SC with "under [N] lines" or "at most [N]" extracts number
- [x] SC-291: matchPattern supports json-field-equals — SC with "field X equals Y" checks JSON files
- [x] SC-292: matchPattern supports section-exists — SC with "has section [heading]" checks markdown
- [x] SC-293: specs/SPEC-TEMPLATE.md exists
- [x] SC-294: Every specs/ subdirectory name passes deriveDirectoryName() validation — hand-created directories FAIL
- [x] SC-295: ~35 structural SCs enriched with bracket-list values — auto-tested by matchPattern (behavioral)
- [x] SC-400: `rungate test-brief {role} "{task}"` CLI spawns agent in isolated worktree with standard task, audits transcript, reports directive compliance score (behavioral)
- [x] SC-401: lib/directive-extractor.ts exists
- [x] SC-402: Transcript compliance checker cross-references extracted directives against agent tool calls — FOLLOWED/IGNORED per directive (behavioral)
- [x] SC-403: lib/transcript-checker.ts contains [formatReport]
- [x] SC-404: Hill climb mode runs test-brief up to 5 iterations — tweaks brief between runs using 7 compliance factors, stops when target score reached
- [x] SC-405: All 6 agent briefs score ≥80% directive compliance on standard task before shipping through harness
- [x] SC-406: briefedAgent() parses brief Context section at prompt-build time and generates explicit numbered Read steps — no hardcoded file paths in workflow
- [x] SC-407: Ship workflow runs compliance pre-flight gate before IMPLEMENT — agent must score ≥80% on test-brief or workflow halts (behavioral)
- [x] SC-408: Standard tasks defined per role in config (behavioral)
- [x] SC-409: Behavioral canary test — prompt contains a unique practice rule, transcript output verified to reflect it (read ≠ followed) (behavioral)

## Violation Categorization & Remediation

### Design Decisions (continued)

| # | Decision | Rationale |
|---|----------|-----------|
| D-8 | Default category is 'quality' — override to 'process' | Quality-affecting is the safe default. Missing a quality violation is worse than over-remediating a process one |
| D-9 | Category derived from section header + per-item overrides | Zero template modification for 80% of cases. Frontmatter `process_overrides` for the 20% in mixed sections |
| D-10 | Remediation pass for quality violations on successful ships | Shipped code may work but not meet standards. Remediation applies the skipped practices retroactively |
| D-11 | Grade always, not just on failure | Previous design returned early on success, losing all grade data |
| D-12 | Compliance threshold configurable in rungate.json | Different projects have different quality bars |

### Section-to-Category Mapping

Validated via first-principles analysis across all 7 brief templates (20 unique section headers):

| Category | Sections |
|----------|----------|
| **process** (explicit) | Context, Always Do, Ask First |
| **quality** (everything else) | Workflow, Testing Rules, Coding Principles, What you scan, What you look for, CLI Testing Mode, UI Testing Mode, Discovery Rules, Discovery Workflow, Architecture principles, Design principles, What you do, Report, Project Type Detection, Rules, Never Do, Core Principles |

Mixed sections (Rules, Never Do, Core Principles) default to quality. Individual items can be demoted via `process_overrides` in brief frontmatter:

```yaml
process_overrides:
  - "Use cat via Bash"
  - "Read the same file twice"
  - "Run pwd or ls -la"
```

### Remediation Flow

```
Ship succeeds → Grade (always) →
  Quality violations?
    YES → Remediation pass:
      1. Fix brief (heal template for next time)
      2. Re-present code to agent with improved brief
      3. Agent applies skipped practices (write missing tests, verify spec)
      4. Grade remediation transcript
      5. Commit improvements, close issue
    NO → Process violations only?
      YES → Heal brief + test-brief --hill-climb, close issue
      NO → Clean ship, close issue
```

### Success Criteria (continued)

- [x] SC-465: lib/directive-extractor.ts contains [category, quality, process]
- [x] SC-466: lib/directive-extractor.ts contains [PROCESS_SECTIONS, context, always do, ask first]
- [x] SC-467: lib/directive-extractor.ts contains [sectionCategory, quality]
- [x] SC-468: lib/directive-extractor.ts contains [parseProcessOverrides, process_overrides]

SCs for #588 (config-driven grading) and #589 (remediation pass) will be added when those issues are built. See design decisions D-8 through D-12 and the Remediation Flow section above for the design.

## Baseline (2026-09-20)

31 files scanned. 15 HIGH findings across 6 files:
- AGENTS.md: 9 HIGH (19 agnix, 107 RepoRails)
- .claude/agents/quinn.md: 1 HIGH (5 agnix, 87 RepoRails)
- .claude/agents/marcus.md: 1 HIGH (5 agnix, 78 RepoRails)
- .claude/agents/serena.md: 1 HIGH (1 agnix, 74 RepoRails)
- .claude/agents/aditi.md: 1 HIGH (1 agnix, 90 RepoRails)
- .claude/agents/rook.md: 1 HIGH (1 agnix, 74 RepoRails)
- prompts/ac-adversary.md: 1 HIGH (1 agnix)
- 24 prompt files: 0 findings (content files, not instruction files)
