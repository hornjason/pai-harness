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
| COMP-2 | Test run discipline | Full suite ≤ the rate `lib/test-suite-lock.ts` enforces (4 per worker per 30 min as of 2026-10-10), targeted unlimited | Agent doesn't over-run tests |
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
- [x] SC-469: extractPromptContent concatenates all user messages — not just first — to detect AGENTS.md injection in workflow relay transcripts
- [x] SC-470: scripts/test-brief.ts contains [--prompt, promptFile, replayPrompt]
- [x] SC-471: test-brief --prompt runs COMP-level grading alongside directive grading and compares against baseline (behavioral)

SCs for #588 (config-driven grading) and #589 (remediation pass) will be added when those issues are built. See design decisions D-8 through D-12 and the Remediation Flow section above for the design.

## The blocking-grade check trusted the summary it was given (#195)

#188 made a compliance grade able to stop a run. Two independent background
security reviews then found the same defect inside that fix, three times over:
**the decision depended on free text an LLM authored, and "I could not measure
it" was indistinguishable from "there was nothing to find."**

| Finding | What it looked like |
|---|---|
| Empty reads as clean, and the prompt instructed it | `ship.js` told the grader "If no transcripts found, return `{"grades": []}`". The shape check was `!Array.isArray(grades)` — and `[]` IS an array, so a grading step that found no transcripts produced the same verdict as a run with perfect compliance. |
| The model is in the data path | The deterministic work is `scripts/grade-deterministic.ts`, but what reached the decision was the agent's SUMMARY of that script's output, cross-checked against nothing. |
| Parser/validator differential | `String(entry).split(':')[0]` read an id out of prose the agent wrote. `"TDD_SEQUENCE_VIOLATED: no green phase"` matched; `"Marcus violated TDD_SEQUENCE_VIOLATED"` did not, and nothing noticed. #144's shape, one domain over. |

### What is trusted from the model, bounded rather than removed

Per #69 the Workflow sandbox has no filesystem and no exec, so everything
reaches `ship.js` through an agent. That constraint is not contested here
(AC-4). Three things are therefore trusted and stated so a reader knows the
boundary: that the agent ran the command it was told to, that
`rawGradeOutput` is that command's stdout, and that it did not edit the stdout
to agree with a summary it also wrote.

The third is bounded by making **disagreement the refusing direction**. A
model that wants to hide a violation must now alter two fields consistently
rather than omit one, and the omission — the cheap failure, and the one a
confused grader produces by accident — refuses.

One input does NOT cross the agent boundary: `SPAWNED_ROLES`, recorded in
`timedAgent` because that is the single door every agent call goes through.
The run knows which agents it started, so "the grades array is empty" stops
being indistinguishable from "the run was clean" without asking a model
anything.

### Unmeasured, disagreement and violation are three refusals, not one

They are checked in that order and named separately. Conflating them produces
a refusal that cannot say whether the run lied about a number, whether its
grader disagreed with itself, or whether nobody looked.

`skipGrade` is untouched (AC-3): an authorised opt-out that still logs that no
blocking-grade check ran. `BLOCKING_GRADE_VIOLATIONS` is untouched (AC-5) —
which violations block is #188's settled decision, and this issue is only
about whether the check can see them.

### A cross-check that refused a correct run

The first version of the disagreement check used `raw.includes(id)`, and
`NOT_TDD_SEQUENCE_VIOLATED_EITHER` contains `TDD_SEQUENCE_VIOLATED`. #188's
own declared-set case uses that exact string to prove the blocking set is a
list and not a prefix match, and it went red. A gate that refuses correct runs
gets switched off, which is how a gate dies — so the comparison is a whole
token, with a paired case proving the id inside ordinary prose still trips it.

- [x] SC-764: workflows/ship.js contains [unmeasuredGradeViolations, no grade for] — a run refuses when the grades omit a role it spawned, when the grades array is empty, or when `rawGradeOutput` is absent, because a measurement that did not happen is not one that passed
- [x] SC-765: workflows/ship.js contains [violationIds] and the grade schema requires it — the blocking decision reads a structured id array; the prose prefix stays as a second reading so a violation survives either representation, but it is no longer the only one
- [x] SC-766: workflows/ship.js contains [gradeSummaryDisagreements] — the agent returns the grading script's own stdout and a summary that omits a blocking id the script printed refuses, because the summary is not the authority over the thing it summarises
- [x] SC-767: workflows/ship.js must NOT contain [If no transcripts found] — the prompt stops instructing the agent to report emptiness as a successful result. Worded for `content-not-contains` rather than the issue's `not contains`, which no matcher owns; the bracket payload also carries no comma or `]`, since items are comma-split and the regex ends at the first bracket — `return` on its own would match everywhere in the file and the clause would assert nothing
- [x] SC-768: test/blocking-grades-trust.test.ts contains [ship.js actually records the roles it spawns] — the AGENT-TIMING block is executed and `SPAWNED_ROLES` read back from it, because every other case injects that set and stays green when the production wiring is removed

### What was broken to prove it (SC-764..768)

Over `test/blocking-grades-trust.test.ts` + `test/blocking-grades.test.ts`
(44 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `unmeasuredGradeViolations` returns `[]` | 6 of 44 |
| the unmeasured check never consulted by the decision | 6 |
| `gradeSummaryDisagreements` returns `[]` | 2 |
| `rawGradeOutput` no longer required | 2 |
| the cross-check back to a substring match | 2 |
| `timedAgent` stops recording the role | 2 — and **0 of 40** before SC-768 was added |
| the empty-grades case removed | 1 — and **0 of 40** before a fixture with grades `[]` AND a present raw output existed |
| the role-coverage check removed | 1 |
| `violationIds` no longer required of a grade | 1 |
| the blocking read back to prose only | 1 |
| the prompt tells the agent emptiness is a result again | 1 |

The two zero rows are the same shape and worth naming. Each was a branch whose
refusal was already produced by a neighbouring branch on every fixture that
existed, so removing it changed nothing observable — a guard that is correct,
load-bearing in production, and unmeasured.

**Not done here:** AC-6 moved to #197 (Phase 2) by the issue's own rescope.

### Phase 2: the opt-out is traced to the caller, not injected (#197)

#197's last criterion asks that `skipGrade` be exercised **end to end** after
the Phase 1 refusals land, and shown to still ship with its "no blocking-grade
check ran" line intact. The existing case set `SKIP_GRADE: true` into the
block's scope and asserted the outcome, which proves the decision honours the
flag and proves nothing about where the flag comes from.

One line of `workflows/ship.js` carries the caller's argument to that
decision, and it is the line that matters most in the wrong direction: a
default flipped to `true` there switches off every refusal Phase 1 added, on
every run, with the whole block still present and the entire test file still
green. So the real line is extracted and evaluated against planted arguments,
then its output is fed into the real decision block — the skill's argument,
through ship.js's own binding, into ship.js's own refusal.

- [x] SC-773: test/blocking-grades-trust.test.ts contains [the binding feeds the block it is read by] — `skipGrade` is traced from the caller's argument through ship.js's real binding into its real decision block, because injecting the constant proves the block honours a flag without proving any caller can set it

**The limit, stated rather than counted as met.** This is the real source of
both links, executed. It is not a live pipeline run with real agents — #69
bars a workflow from loading `ship.js` as a module, and a grading run costs
four agents to re-observe a decision already driven here from its own source.
SC-653 is met at the binding-and-block level; a pipeline-level exercise of
`skipGrade` remains unperformed.

### What was broken to prove it (SC-773)

Over `test/blocking-grades-trust.test.ts` + `test/blocking-grades.test.ts`
(47 tests). None left in the tree.

| Mutation | Red |
|---|---|
| the binding reads `parsedArgs.skipGrading`, a key no caller sends | 3 of 47 |
| grading off by default (`const SKIP_GRADE = true`) | 2 of 47 |
| the caller's flag ignored, grading always on (`= false`) | 2 of 47 |
| the binding split across two lines | aborts the file — 24 of 47 cases do not run |
| a second binding added elsewhere in the file | aborts the file |

The last two rows are the property, not a side effect. The first attempt put
the extractor inside its `describe`, and splitting the binding across two
lines **deleted** four tests rather than failing them: the suite reported 43
pass, 0 fail. A mutation harness that silently no-ops when its target moves is
exactly the decorative check `.claude/rules/checks-must-be-able-to-fail.md`
exists to prevent, so the extractor moved to module scope beside the file's
other two slicers, where a miss takes the whole file down loudly.

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

## #116 — the history recorded verdicts and threw away the evidence

`scripts/persist-compliance.ts` built each history entry from the grade file
like this:

```ts
for (const r of g.rules || []) {
  if (r.id) scores[r.id] = r.verdict || "N/A";
}
```

A grade record carries `{ id, rule, verdict, evidence, category }`. The
history kept the first two and dropped the rest:

```
grade:   { id: "DIR-L29", verdict: "VIOLATED",
           rule: "Run the full suite at most TWICE…",
           evidence: "5 bun test runs (expected 1-2)", category: "quality" }
history: { "DIR-L29": "VIOLATED" }
```

The second is an **unsourced verdict**. It cannot be re-checked, the rule text
it refers to is unrecoverable once the rule is edited, and a trend built from
it cannot explain itself — which is tier F by the standard this repo applies
to ACs.

It had not bitten because the writer was never running: #69's Grade-phase tail
executed in a sandbox with no `require` and failed inside a `catch`. All four
entries on disk when #116 was filed were synthetic fixtures, so this was the
cheapest the schema would ever be to change.

### Two shapes, one reader

`COMPLIANCE_HISTORY_SCHEMA = 2`. A v2 entry carries `rules` — the whole record
per graded rule — and **not** `scores`. Two copies of one fact in a record can
disagree and nothing would notice which was right, so `entryVerdicts()` is the
single reader that derives the flat map from whichever shape it is given.

The version is **stamped rather than inferred from the shape.** "It has
`rules`, so it is v2" conflates *written after the change* with *written after
the change and carrying something*, and those are the two states a reader most
needs to tell apart: a role graded on nothing produces a v2 entry with an
empty `rules`.

`lib/compliance-backfill.ts` was lossy in exactly the same way, from the same
files, and is fixed with it — the three fields had been on disk the whole time.

One thing this buys beyond auditability: `TrendLine.rule` now prefers the
rule text the entry recorded over the hardcoded `COMP_RULES` map, which goes
stale the moment a rule is edited. The map stays as the fallback for v1
entries, because a reader that only used recorded text would label every
pre-#116 trend line with a bare id.

- [x] SC-1475: test/compliance-history-evidence.test.ts contains [the round trip keeps all three] — rule, evidence and category survive a write/read through the history for every graded rule and not only the violated ones
- [x] SC-1476: lib/compliance-report.ts contains [COMPLIANCE_HISTORY_SCHEMA] — each entry records its shape so records written before and after the change are distinguishable without guessing from their contents
- [x] SC-1477: lib/compliance-report.ts contains [entryVerdicts] — one reader handles the old flat map and the new records so the four v1 lines already on disk still trend
- [x] SC-1478: test/compliance-history-evidence.test.ts contains [the LIVE writer carries all three from grade file to history file] — persistCompliance itself is run over a grade file and the three fields are read back out of the history file rather than out of a fixture this test wrote

### What was broken to prove it

Measured over `test/compliance-history-evidence.test.ts` +
`test/unit/persist-compliance.test.ts` + `test/unit/compliance-backfill.test.ts` +
`test/compliance-report.test.ts` (78 tests):

| Mutation | Red |
|---|---|
| the writer drops `rule`/`evidence`/`category` again | 1 of 78 — **was 0** |
| `entryVerdicts` stops reading v2 `rules` | 7 of 78 |
| `entryVerdicts` stops reading v1 `scores` | 5 of 78 — the four lines on disk |
| the schema stamp removed from the writer | 3 of 78 |
| `historySchema` defaults to 2 instead of 1 | 1 of 78 |
| the trend ignores recorded rule text | 1 of 78 |
| `recordedRuleText` loses its v1 fallback | 1 of 78 |
| the backfill keeps writing a flat map | 2 of 78 |

**The first row was a zero**, and it is the headline defect: deleting the
three fields from the live writer's entry builder changed nothing. The suite
checked hand-built fixtures and the verdict map, and the one assertion aimed
at the writer was a grep for the old `scores[r.id] =` line — which a writer
that kept `rules` but dropped their contents still satisfies. Closed by
running `persistCompliance` itself over a grade file carrying #116's own
`DIR-L29` record and reading the three fields back out of the history file.
A round trip that does not start where the real data starts is a round trip
of its own fixtures.

### What this does NOT fix

- **The four synthetic entries are left alone.** They read as v1 and trend
  correctly; rewriting them would destroy the only real v1 data the
  compatibility reader is exercised against.
- **Nothing reads `evidence` yet beyond the round trip.** `evidenceFor()`
  exists so a verdict can be re-checked; wiring it into the report's output is
  a separate change.

## #597 — a Layer 1 report that could not say it had measured nothing

`lib/tool-probe.ts` has known the difference between **absent**, **errored**
and **available** since #626. `runTemplateCompliance` read `.available` off
each probe at the door and kept nothing else, so everything downstream was
back to one boolean:

```ts
const agnixAvailable = probeExternalTool("agnix", ["--version"]).available;
// …
toolsAvailable: { agnix: agnixAvailable, reporails: reporailsAvailable },
overallQuality: qualityScores.length > 0 ? average(qualityScores) : null,
```

CI installs neither tool. A report produced with agnix missing is
byte-indistinguishable from one produced with agnix installed and silent, and
with one tool out the quality score is an **average over whichever tool
answered** — a tidy number printed for a surface nobody scored. That is
*Silent Default Substitution* in `.claude/rules/config-access.md`, in the
place it does the most damage: `0`, `{}`, `null` and a plausible mean are all
indistinguishable from success. `UNMEASURED` is not.

### The contract

- **The report keeps the whole `ToolProbe` per tool** — outcome, exit code and
  `reason` — in `toolProbes`. `toolsAvailable` stays exactly as it was and is
  derived from them, so no existing caller changes.
- **Any tool that is not `available` makes the reading UNMEASURED**, and the
  reading **names every such tool and its own reason**. An operator cannot act
  on "a tool was unavailable": installing something fixes `absent` and does
  nothing for `errored`, and the two arrive by different routes.
- **The quality score is withheld under an UNMEASURED reading**, not averaged
  over the tools that did answer. `overallQualityOf` is the one binding that
  decides, so there is one thing to mutate.
- **`reading.reading === "UNMEASURED"` is the only discriminator.** A second
  `qualityWithheld` boolean beside it would be a decider that always agrees,
  and two deciders that agree are behaviourally one.
- **Probes are injected through one exported seam**, `probeComplianceTools`.
  `probeExternalTool` is called from nowhere else in the module. A caller
  forces a tool absent or errored without mutating `PATH`; an omitted tool is
  still probed for real, so the seam cannot silently drop one.
- **`available` is derived from `outcome` by `toolProbe` in
  `lib/tool-probe.ts`**, which every return in that module now goes through —
  an injected reading cannot claim to be available while reporting that it was
  absent.
- **Layer 2 says when its comparison did not happen.** A degradation check
  that both sides had no number for was previously an `if` that quietly did
  not fire.

- [x] SC-2077: lib/compliance.ts contains [toolProbes, ComplianceReading] — the report keeps the full probe per tool, outcome and reason, and `toolsAvailable` remains a derived boolean projection so existing callers are unchanged
- [x] SC-2078: lib/compliance.ts contains [UNMEASURED, complianceReading] — when any probed tool is not available the report carries an UNMEASURED reading naming every such tool and its reason, and an errored tool is not reported as an absent one
- [x] SC-2079: lib/compliance.ts contains [overallQualityOf] — the quality score is withheld under an UNMEASURED reading rather than averaged over the tools that did answer, through one binding
- [x] SC-2080: lib/compliance.ts contains [probeComplianceTools] — one exported seam accepts injected probe results per tool, so a caller forces a tool absent or errored without mutating PATH, and an omitted tool is still probed

### What was broken to prove it

Measured over `test/compliance-unmeasured.test.ts` (15 tests). Baseline before
any mutation: **15 pass, 0 fail.**

| Mutation | Predicted | Red |
|---|---|---|
| `overallQualityOf` loses its `UNMEASURED` early return | 1 | **1 of 15** |
| `complianceReading` treats every probe as available | 6 | **6 of 15** |
| `probeComplianceTools` ignores the injected probes | 8 | **8 of 15** |

Before believing those, the input on which mutant and original differ, named
and run rather than assumed:

- **row 1** — two file scores of 8 and 6 under an UNMEASURED reading. The
  original returns `null`; the mutant returns `7`.
- **row 2** — a probe pair `{agnix: absent, reporails: available}`. The
  original reads UNMEASURED naming agnix; the mutant reads MEASURED naming
  nothing.
- **row 3** — an injected probe whose `reason` is the sentinel
  `PLANTED-agnix-errored`. The original carries it onto the report; the mutant
  reports whatever this machine's `PATH` happens to say.

**Row 1 is the one worth reading twice.** The three end-to-end cases that
assert the score is withheld stay **green** under it, because they run over an
empty surface: with no files there is nothing to average, so the mutant and the
original agree on every input those cases have. They are measuring the reading,
not the withholding. The only witness to the withholding is the unit case over
`overallQualityOf` with file scores in hand — which is
`.claude/rules/checks-must-be-able-to-fail.md`'s "a battery whose fixtures all
meet a precondition measures nothing past it", and it is why that case exists
rather than being folded into the four states.

The cheapest wrong fix for "the score must be withheld" is `overallQuality =
null` always. The four end-to-end cases survive it; the unit case does not.

None of the three mutations is left in the tree; all were run and reverted, and
`lib/compliance.ts` was confirmed byte-identical afterwards.

### What this does NOT fix

- **UNMEASURED is reported, not enforced.** Nothing refuses a run on it yet.
  Whether a Layer 1 scan that measured nothing should fail the gate is a
  consumer's decision and needs the switch read exactly, per
  `.claude/rules/config-access.md`.
- **A report does not state its coverage.** 36 of 426 files scanned and 426 of
  426 are still the same PASS to a reader, which is #492's generalisation and a
  separate change.

## #624 — the hill-climb loop wrote a brief nobody had chosen to write

`applyHillClimb` composed a reinforcement bullet and then wrote the tracked
agent brief at the bottom of the same loop, as a side effect of having
composed it. Nobody had chosen that destination: measured on `main` at
`26565f89`, no brief in this repository has ever carried a committed
`REINFORCED (auto)` line, and `git status` reported exactly one — uncommitted,
in `.claude/agents/discovery.md`. So every rule the loop has ever produced was
either discarded by the next `git checkout` or left dirtying a tree that some
later run had to work around.

The inserted bullet was also malformed. The prefix opened with `\n` and closed
with nothing, so the bullet butted straight against the heading that followed
it:

```markdown
- **REINFORCED (auto):** NEVER read a file with cat…
## Context (READ THIS FIRST)
```

A list item immediately followed by an ATX heading is not a reliably parsed
construct, and these files are read by agents as context — so the rule the
loop had just decided an agent keeps breaking was delivered in the shape most
likely to be swallowed.

### The destination contract

- **Composing and writing are two things.** `applyHillClimb` builds the
  reinforced content and hands it to `writeReinforcedBrief`, which is the only
  site in the module that writes a brief. The write is no longer a consequence
  of the composition having happened.
- **Every write names its destination**, and the name is one of
  `HILL_CLIMB_DESTINATIONS` — `COMMIT`, `UNTRACKED` or `DISCARD`. `COMMIT`
  writes the tracked brief in place for a human to review; `UNTRACKED` writes
  the reinforced copy to `untrackedBriefPath`, outside the brief's own
  directory, so a proposal survives without dirtying the tree; `DISCARD`
  composes, reports, and writes nothing.
- **The result says what happened.** `applyHillClimb` returns a
  `HillClimbWrite` carrying the destination and the path actually written, and
  `null` when nothing was. A caller that printed "brief updated" without
  reading it would be guessing — which is what the loop did for its whole
  life.
- **The applied line carries the destination**, so an operator reading the log
  can tell where the rule went without re-deriving it.
- **One default binding.** `DEFAULT_HILL_CLIMB_DESTINATION` is `COMMIT`, which
  is exactly what every existing caller already got, so this change routes the
  write without moving it. **Which destination the shipped loop should default
  to is AC-2 and is deliberately not decided here**: flipping it has to move
  `scripts/persist-compliance.ts`'s re-grade step with it, because re-grading
  a brief that was not written measures the old one and reports the number as
  if it were new. *#648 decided it — see "#648 — the shipped loop chooses its
  destination" below. `DEFAULT_HILL_CLIMB_DESTINATION` is unchanged and is now
  what its name says: the answer for a caller that does not have one.*

### The separator rule

- **An inserted block is separated from a following ATX heading by a blank
  line.** `insertReinforcement` decides it, from the text that follows the
  insertion point, and that is the only place it is decided.
- **The prefix literal is spelled once.** `REINFORCEMENT_PREFIX` replaces the
  three sites at `:511`, `:515` and `:519` that each built the same string, so
  a formatting change cannot be half-applied.
- **The separator is not a newline inside the prefix.** That is the cheapest
  repair for the reported symptom and it is the wrong one: it moves the rule's
  text off its own bullet and leaves the heading exactly where it was.

- [x] SC-2081: lib/compliance-report.ts contains [HILL_CLIMB_DESTINATIONS, writeReinforcedBrief] — every reinforcement write goes through one exported binding that names the destination COMMIT, UNTRACKED or DISCARD, so the brief is no longer written as a side effect of composing the text, and the result carries the destination and the path actually written
- [x] SC-2082: lib/compliance-report.ts contains [DEFAULT_HILL_CLIMB_DESTINATION] — the destination is one defaulted binding a caller overrides per run, so there is one thing to change and one thing to mutate
- [x] SC-2083: lib/compliance-report.ts contains [REINFORCEMENT_PREFIX, insertReinforcement] — the prefix literal appears exactly once and an inserted block is separated from a following ATX heading by a blank line, asserted by reading the two lines around the heading rather than searching the whole document

### What was broken to prove it (SC-2083)

Measured over `test/hill-climb-markdown.test.ts` (5 tests). Baseline before
any mutation: **5 pass, 0 fail.**

| Mutation | Predicted | Red |
|---|---|---|
| `insertReinforcement` restored to the pre-#624 splice — `slice(0, idx) + "\n" + prefix + text + slice(idx)` | 4 | **4 of 5** |
| the same, plus the cheapest wrong fix: a trailing newline appended to `REINFORCEMENT_PREFIX` | 4 | **4 of 5** |

Before believing either, the input on which mutant and original differ, named
and run rather than assumed — the `## Never Do` fixture followed by
`## Context (READ THIS FIRST)`:

- **row 1** — the original renders the bullet, a blank line, then the heading.
  The mutant renders the bullet and then the heading on the next line, so the
  line directly above the heading is the reinforcement bullet.
- **row 2** — the mutant renders a bare prefix on one line and the rule's text
  on the next, so the line directly above the heading is
  `NEVER read a file with cat, head, or tail via Bash — use Read with
  offset/limit.` and the line above that is the prefix with nothing on it. The
  measured failure is that assertion, not a string comparison against the
  mutated prefix.

**Row 2 is the row the case exists for.** Appending a newline to the prefix is
a one-character repair in the one place the prefix is spelled, it is what
somebody reaches for when the complaint is "there is no blank line before the
heading", and it does not separate the block from the heading at all. The case
survives it because it asserts BOTH lines around the heading: the line above
the heading must be blank, and the line above THAT must carry the prefix and
the reinforcement text together. A case asserting only the blank line would go
green on a brief whose reinforcement had been split in half.

Neither mutation is left in the tree; both were run and reverted, and
`lib/compliance-report.ts` was confirmed byte-identical afterwards.

### What this does NOT fix

*Both of these were fixed by #648; the section is kept because the mutation
record below is measured against the tree they describe.*

- **The shipped default still writes the tracked brief.** AC-2 chooses the
  destination the loop runs with and is a separate change; this one makes the
  choice expressible and names what it currently is.
- **The re-grade step reads the brief, not the destination.**
  `scripts/persist-compliance.ts` re-runs `test-brief.ts` after a
  reinforcement to confirm the patched brief scores better. Under any
  destination other than `COMMIT` that re-grade measures the unpatched brief
  and reports the result as if it were the patched one — *Silent Default
  Substitution* in `.claude/rules/config-access.md`, and it has to move in the
  same change that flips the default.

## #648 — the shipped loop chooses its destination, and the re-grade follows it

#624 Phase 1 left two things joined: `scripts/persist-compliance.ts` passed no
destination, so the shipped behaviour was whatever
`DEFAULT_HILL_CLIMB_DESTINATION` happened to say, and it discarded the `write`
it got back, so the re-grade re-derived its target from role config
(`scripts/test-brief.ts`, `roleConfig[role]?.brief`). Those two agreed only
while the destination was `COMMIT`. Flip one without the other and the loop
re-grades a file the run did not write.

### The destination, argued rather than inherited

The argument is recorded in full on #648. The three readings it turns on, each
re-derived against the post-#715 tree rather than copied from the issue's own
first comment, which is superseded:

- **`COMMIT` is excluded by the committed-or-reverted property, not by
  durability.** `lib/compliance-report.ts` documents it as "write the tracked
  brief in place, for a human to review and commit" and nothing downstream
  commits. Measured live on run `wf_9ab25fd1-6e5`: a reinforcement landed in
  `.claude/agents/discovery.md` as an uncommitted modification in the shared
  primary checkout and the run reported `DONE`. Making it satisfy the property
  means committing from a compliance script onto a ref other runs share, which
  is #267/#136; reverting instead is `DISCARD` with a dirty window in the
  middle. This holds even after a re-scaffold adds `## Project Constraints` —
  durability does not make an uncommitted write safe in a shared checkout.
- **`DISCARD` is excluded by what it does to the measurement.** `write.path` is
  `null`, so the re-grade must refuse and the loop can never score its own
  reinforcement. Detect-and-report, permanently unmeasured, by construction.
- **`UNTRACKED` is chosen, and the thing that changed its reading is the other
  half of this issue.** #655's first assessment — "a sidecar read by nobody" —
  was true while the re-grade re-derived its target. Binding the re-grade to
  `write.path` makes the proposal a file that IS read, by the re-grade, which
  now scores the patched directives instead of the unpatched ones.

A mined rule still reaches a brief only by a human moving it into
`## Project Constraints`, which #715 made the one region a re-scaffold carries
forward. No brief in this repository carries that heading yet — 0 of 7, and no
template emits one — so a `COMMIT` write today still lands in a generated
section the next scaffold rewrites. The hand-off is the honest state of the
loop; `COMMIT` dressed it up as landed and left the tree dirty instead.

### The contract

- **The destination is passed, not inherited.**
  `SHIPPED_HILL_CLIMB_DESTINATION` in `scripts/persist-compliance.ts` is what
  the loop gives `applyHillClimb`. `DEFAULT_HILL_CLIMB_DESTINATION` is
  unchanged and keeps its own job: the answer for a caller with no opinion.
- **The proposal goes in the run's own work directory**, via
  `hillClimbProposalDir(workDir)` — not `defaultUntrackedDir()`, which is
  `~/.rungate/hill-climb` keyed on the brief's basename and therefore shared
  by every concurrent run grading the same role.
- **The re-grade reads `write.path`.** `RegradeRequest.briefPath` is `string`,
  never `string | null`, because a destination that wrote nothing is refused
  before a request is built. `scripts/test-brief.ts` takes `--brief=PATH` for
  this; without it the re-grade cannot be pointed anywhere but the role's
  tracked brief.
- **A destination that wrote nothing refuses rather than re-grading**, with a
  named line, before the transcript lookup — so the refusal does not depend on
  a run happening to have transcripts, and `0` is not left standing in for it.
- **The re-grade is the second exported seam.** A case observes which path it
  was handed and whether it ran at all; the real function shells out to
  `test-brief.ts`, and a test that let it do so would be asserting that `bun`
  exists.

### What was broken to prove it

Measured over `test/hill-climb-tracked-brief.test.ts`,
`test/unit/hill-climb-receipt.test.ts`, `test/compliance-report.test.ts` and
`test/hill-climb-destination.test.ts` — 55 tests. Every count was predicted
before the row ran, and **the baseline row was read before any mutation row**:
an instrument that has stopped reporting takes the baseline down with it, and
that is the row nobody checks.

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 55 pass, 0 fail | **55 pass, 0 fail** |
| `writeReinforcedBrief` ignores its destination and always writes the tracked brief | 9 | **9 of 55** |
| the genuinely pre-#648 call site — no destination passed, no refusal, re-grade re-derived from role config | 4 | **4 of 55** |
| the refusal replaced by a fallback to the tracked brief | 1 | **1 of 55** |
| the re-grade bound back to `briefPath`, refusal kept | 1 | **1 of 55** |
| `SHIPPED_HILL_CLIMB_DESTINATION` set back to `COMMIT` | 4 | **4 of 55** |
| the cheapest wrong fix — `SHIPPED_HILL_CLIMB_DESTINATION` set to `DISCARD` | 3 | **3 of 55** |

Before believing any of those, the input on which mutant and original differ,
named and run rather than assumed:

- **row 1** — `writeReinforcedBrief(brief, "PATCHED", {destination: "DISCARD"})`
  over a brief reading `ORIGINAL`. The original returns `{destination:
  "DISCARD", path: null}` and leaves the brief at `ORIGINAL`; the mutant
  returns the brief's own path and the brief reads `PATCHED`. Printed and
  compared before the row was counted.
- **rows 2, 5, 6** — the three-consecutive-fail fixture for `COMP-13` against a
  tracked `marcus.md`. The original writes `<workDir>/hill-climb/marcus.md` and
  leaves `git status --porcelain` empty; the pre-#648 and `COMMIT` mutants
  modify the tracked brief and hand that path to the re-grade; the `DISCARD`
  mutant writes nothing and the re-grade is refused.
- **rows 3 and 4** — the same fixture with `DISCARD` forced through the
  `applyHillClimb` seam. The original records no re-grade; both mutants hand
  the re-grade the role's unpatched tracked brief.

**Row 1 came back 8 the first time it was run, where 9 was predicted, and the
missing red is a finding rather than noise.** *"every destination the binding
names is handled by the writer"* asserted `write.destination` — the name the
caller passed, echoed back — and the file at `write.path`, with
`if (write.path === null) continue`. Under a writer that ignores its
destination every iteration echoes the right name, `path` is never null so the
`continue` never fires, and the content check reads the file the mutant wrongly
wrote. The distinguishing property of a destination is WHERE, and the case
never asserted one: #530's shape, the artefact agreeing with whatever you put
in it. It now writes down the expected path per destination and asserts
`DISCARD` wrote nothing anywhere, and the row is 9.

**The cheapest wrong fix, named: default to `DISCARD` so nothing is ever
written.** It makes the dirty-tree symptom go away permanently and makes any
`git status` assertion trivially true. The cases do NOT survive it — row 6 is
3 red — because the scratch-checkout case asserts a non-empty `applied` and a
written file BEFORE it reads git state, and the re-grade case asserts the
re-grade ran. Both were written in that order for this reason.

Two existing cases had to move with the behaviour, and both are consequences
rather than accommodations. `test/unit/hill-climb-receipt.test.ts`'s
`REINFORCEMENT_ALREADY_PRESENT` fixture derived its already-present brief by
running the loop twice; under the shipped destination the second run reads the
same unpatched file and composes the same rule again, so the state is now
reached the way production reaches it — the run's own proposal is copied over
the brief, which is the human hand-off, performed. The eight `applyHillClimb`
call sites in `test/compliance-report.test.ts` now name their destination and
assert `write`, so none of them depends on what the shipped loop chose.

None of the six mutations is left in the tree; all were run and reverted, and
`lib/compliance-report.ts` and `scripts/persist-compliance.ts` were confirmed
byte-identical to the measured source afterwards by `shasum -a 256 -c`.

**Success criteria for this section need ids allocating.** They are deliberately
not hand-written: ids chosen against one tree cannot see another session's
unmerged branches, and four collisions in one day is the measured cost. The
cases carry descriptive names instead.

## #646 — the hill-climb skip was a sentence, so the decision was readable and not usable

`applyHillClimb` decides exactly three things about an action it declines to
apply — the rule is past the tier-1 threshold and wants a promotion, the
reinforcement is already in the brief, or the brief has no section to splice
it into — and it reported all three as English in one `skipped: string[]`:

```
COMP-7: TIER 3 PROMOTION needed — Deploy BashToolGuard hook
COMP-7: reinforcement already present in brief
COMP-9: no suitable section found in brief
```

A caller that wanted the tier it was being told to promote to had to recover
it from the middle of a sentence. That is the same defect as the unsourced
verdict at the top of this spec: the decision was legible to a human reading
stderr and not available to anything else, so nothing downstream of
`scripts/persist-compliance.ts` could act on a promotion recommendation
without a regex.

### The outcome model

- **One discriminated union, `HillClimbSkipOutcome`, with a `kind` covering
  the three states and nothing else.** `TIER_PROMOTION`,
  `REINFORCEMENT_PRESENT`, `NO_SECTION`. An applied action is not a state in
  it: `applied` already says so, and a fourth `kind` nobody switches on would
  be a second answer to a question already answered.
- **The promotion case carries `tier` and `promotion` as FIELDS.** That is the
  whole point of the change — a caller reads `outcome.tier`, not
  `/TIER (\d)/`.
- **`promotion` is `string | undefined`, not optional.** An action at tier 2
  or 3 may carry no promotion, and the sentence rendered that as the word
  `undefined`. Preserving the byte means the outcome has to be able to hold
  the state, so the key is always present and its absence is a value.
- **`applyHillClimb` returns `skipOutcomes` alongside `skipped`, and `skipped`
  is DERIVED from it** — `skipOutcomes.map(hillClimbSkipSentence)`, one
  expression, at the single return. The typed answer and the human-readable
  one cannot disagree, because there is only one of them.
- **`hillClimbSkipSentence` is the only producer of those sentences.** One
  exported binding, spelled once, with no copy anywhere else under `lib/` or
  `scripts/` — a second producer would hold a case up through any mutation of
  the first (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape).
- **The strings are unchanged, byte for byte.** `scripts/persist-compliance.ts`
  prints them as `HILL-CLIMB skipped: …`; the three above are recovered from
  run transcripts under `~/.claude/projects` and `~/.rungate` and are asserted
  verbatim, so no current reader of that stderr changes behaviour.

### The cheapest wrong fix, and whether the cases survive it

**Named: parse the tier back out of the sentence at the call site.** It is
what somebody reaches for when the complaint is "I cannot get the tier" — a
one-line regex in `scripts/persist-compliance.ts`, no change to this module,
and the symptom goes away. The three state cases do **not** survive it: they
read `result.skipOutcomes[0].kind` and `.tier` off the returned value, and
under that repair `skipOutcomes` does not exist. They stay red, which is what
makes them witnesses rather than decoration.

The second wrong fix is cheaper still and arrives later: **a new skip state
gets its sentence written at the branch instead of in the binding.** SC-2093
is the only thing that catches it, and it is why the case counts the sentence
literals across the module rather than only asserting that the binding exists.

### What was broken to make each new case fail (SC-2092, SC-2093, SC-2094)

Measured over `test/compliance-report.test.ts` (30 tests). Baseline before any
mutation: **30 pass, 0 fail.** Every count was predicted before the row ran.

| Mutation | Predicted | Red |
|---|---|---|
| the pre-#646 shape: the three sentences pushed straight into `skipped`, `skipOutcomes` never populated | 4 | **4 of 30** — the three state cases and SC-2093 |
| the `TIER_PROMOTION` outcome keeps its `kind` and drops `tier` and `promotion` | 2 | **2 of 30** — SC-2092's promotion case and SC-2094 |
| `hillClimbSkipSentence` collapsed to one sentence for all three kinds | 3 | **3 of 30** — SC-2094, SC-2093, and the pre-existing "skips if reinforcement already present" case |
| a second producer of the already-present sentence added beside the binding | 1 | **1 of 30** — SC-2093, and only that one |
| the `sectionIdx === -1` refusal rewritten so it can never fire | 2 | **2 of 30** — SC-2092's no-section case and SC-2094 |

Before believing any of those, the input on which mutant and original differ,
named and run rather than assumed:

- **row 1** — a brief with `## Efficiency Rules` and a tier-3 `COMP-7` action.
  The original returns `skipOutcomes: [{kind: "TIER_PROMOTION", tier: 3, …}]`;
  the mutant returns `skipOutcomes: []` and the identical `skipped` string, so
  the row measures the typed half and nothing else.
- **row 2** — the same action. The original's sentence is
  `COMP-7: TIER 3 PROMOTION needed — Deploy BashToolGuard hook`; the mutant's
  is `COMP-7: TIER undefined PROMOTION needed — undefined`, which is why the
  byte-identity case is red beside the field case.
- **row 3** — any skipped action: the original returns the state's own
  sentence, the mutant returns `COMP-7: skipped` for all three.
- **row 4** — no input at all, and that is the point. The mutant is
  behaviourally identical to the original on every input; SC-2093 is a
  source-text case because the defect it guards against is a source-text
  defect, and a behavioural case cannot see it.
- **row 5** — a brief carrying none of `## Efficiency Rules`,
  `## Testing Rules` or `## Never Do`. The original skips with `NO_SECTION`
  and leaves the file untouched; the mutant splices the bullet at
  `content.indexOf("\n## ", 0)` and writes the brief.

None of the five mutations is left in the tree; all were run and reverted, and
`lib/compliance-report.ts` was confirmed byte-identical afterwards.

- [x] SC-2092: lib/compliance-report.ts contains [HillClimbSkipOutcome, skipOutcomes] — applyHillClimb returns a typed outcome per declined action with a kind discriminant covering TIER_PROMOTION, REINFORCEMENT_PRESENT and NO_SECTION, and the promotion case carries tier and promotion as fields a caller reads rather than substrings of a sentence
- [x] SC-2093: lib/compliance-report.ts contains [hillClimbSkipSentence] — the human-readable skip sentence is derived from the typed outcome in exactly one exported binding, spelled once in the module and copied nowhere else under lib/ or scripts/, so no second producer can survive a mutation of the first
- [x] SC-2094: test/compliance-report.test.ts contains [TIER 3 PROMOTION needed] — the skipped strings are byte-identical to the three sentences recovered from the run transcripts, so no current reader of the HILL-CLIMB skipped stderr changes behaviour

### The consumer reads the decision; it does not re-derive it (SC-2095)

The receipt above was built in one pass and the typed outcome in another, and
the two passes disagreed about the interface. `scripts/persist-compliance.ts`
classified each skip by matching the sentence `applyHillClimb` had just
composed — `/TIER \d+ PROMOTION needed/` and two more rows like it — so the
producer's typed answer was computed, rendered, and then thrown away in
favour of re-reading the English.

That is the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`
exactly: **two deciders that agree.** `applyHillClimb` already knew which of
the three a skip was, the table re-derived the same answer, and no
behavioural case over the five receipt states could tell them apart —
measured below, the three prose rows reproduce every state the typed map
produces. It was also a second position spelling the sentences, which is what
SC-2093 refuses.

- **One map, `SKIP_OUTCOME_STATE`, from `HillClimbSkipOutcome["kind"]` to
  `HillClimbState`.** A total `Record`, not a lookup with a fallback: a kind
  added upstream and not mapped is a type error at the build rather than an
  `UNCLASSIFIED_SKIP` at the end of a ship run.
- **`classifySkip` takes the outcome.** It accepts a bare string too, and
  answers `null` for one — because a string is a reported line that arrived
  with no outcome beside it and therefore carries no decision to read. It is
  not a classifier that gave up; there was nothing to classify.
- **`UNCLASSIFIED_SKIP` stays reachable and stays meaningful.** The loop
  iterates `skipped` and pairs index-wise with `skipOutcomes`, so a
  `skipped.push` upstream that bypasses `skipOutcomes` is reported as
  unclassified and raises the reading to UNMEASURED, instead of being guessed
  at from its wording or dropped.
- **`skipCompId` is gone.** The COMP came out of the sentence with a regex;
  it is now `outcome.compId`.

The witness is a NEGATIVE one, and it has to be: with the table gone, the
rendered sentence classifies as nothing at all. Any prose matcher put back
turns that red, because a sentence matcher matches its own sentence.

**The cheapest wrong fix, named: put the table back "just for the tier".**
The five state cases survive it — all five are green on the mutant, which is
the whole point of the shape — so the case that refuses it is the one that
hands `classifySkip` the sentence and expects `null`.

Measured over `test/unit/hill-climb-receipt.test.ts` (12 tests). Every count
predicted before the row ran.

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 12 pass, 0 fail | **12 pass, 0 fail** |
| the prose table restored and the call site handed the sentence — the defect verbatim | 3 | **3 of 12** — the three AC-9 cases, and SC-2093 in `test/compliance-report.test.ts` goes red beside them. The five state cases stay GREEN |
| `classifySkip` short-circuited to `return null` | 5 | **5 of 12** — the three skip states and two AC-9 cases; `NO_ACTIONS_DETECTED` and `GRADER_ACCURACY_DROP` are raised before any skip and stay green |
| the call site handed `s` instead of `outcome ?? s`, classifier unchanged | 3 | **3 of 12** — the three skip states only, which is what makes the call site a separate witness from the classifier |

Before believing any of those, the input on which mutant and original differ,
named and run rather than assumed: the outcome
`{kind: "TIER_PROMOTION", compId: "COMP-13", tier: 3, promotion: "Deploy BashToolGuard hook"}`
and the sentence it renders to. The original answers
`TIER_PROMOTION_RECOMMENDED` for the outcome and `null` for the sentence; the
restored table answers `null` for the outcome — it stringifies to no matching
prose — and `TIER_PROMOTION_RECOMMENDED` for the sentence. The two are exact
mirrors, which is why the sentence case is the one that cannot be satisfied
by the wrong fix.

None of the three mutations is left in the tree; all were run and reverted,
and `scripts/persist-compliance.ts` was confirmed byte-identical afterwards.

- [x] SC-2095: scripts/persist-compliance.ts contains [SKIP_OUTCOME_STATE, skipOutcomes] — the receipt state for a skip is read off applyHillClimb's typed outcome through one total map and no sentence-matching table decides it a second time, so UNCLASSIFIED_SKIP is reachable only for a reported line that genuinely arrived with no outcome beside it

### The Phase 1 receipt checks can go red — baseline and four rows (#657)

The record above is #646 measured by the wave that shipped it. This table is
the **Phase 2** obligation: a battery re-run against the tree as it stands,
so a reader can tell whether those checks still work rather than whether
they once did.

Run over `test/unit/hill-climb-receipt.test.ts` +
`test/unit/persist-compliance.test.ts`:

```bash
bun test test/unit/hill-climb-receipt.test.ts test/unit/persist-compliance.test.ts
```

**The baseline row was read before any mutation row**, because an instrument
that has stopped reporting takes the baseline down with it and that is the
one row nobody mutates anything to produce. It is also the agreement check
on the earlier record: 32 pass is the number `.claude/rules/config-access.md`
wrote down, so the two measurements are of the same thing.

Every count was predicted before the battery ran.

| Row | Predicted | Measured |
|---|---|---|
| **baseline** — unmutated | 32 pass, 0 fail | **32 pass, 0 fail** |
| **collapse to a bare count** — `hillClimb` dropped from the returned receipt, the genuine pre-#646 shape | 8 | **8 of 32** |
| **cheapest wrong fix, applied** — the inserter appends at the end of the brief when no heading matches | 2 | **2 of 32** |
| `reading` hardcoded to `"MEASURED"` | 3 | **3 of 32** |
| every skip occurrence dropped | 3 | **3 of 32** |

All four matched. Both sources were confirmed byte-identical afterwards by
checksum, and neither mutation is left in the tree.

**The collapse row is the one the issue asks for by name.** A receipt
carrying only `hillClimbApplied: 0` is what a clean run and a run whose every
action was skipped both produced before #646, and the eight reds are the five
state cases plus the three that compare two runs. It is the row that says the
distinction is load-bearing rather than decorative.

**The cheapest wrong fix was applied, not merely named.** It is the 5pm
repair for "the reinforcement was never written": stop refusing when no
heading matches and append at the end of the file. It works — the text lands,
`hillClimbApplied` goes to 1 — and the rule ends up under whatever section
happens to be last, which in every brief this repo generates is the
`Reference` table.

The cases do **not** survive it, which is the answer you want: the two reds
are *"NO_SUITABLE_SECTION: a brief with no insertion point is UNMEASURED, not
clean"* and *"a run whose every action was skipped differs from a run with no
actions"*. They assert the STATE the run reported, so a fallback that applies
has to report `applied` and the cases go red rather than green. Whether that
fallback is the right behaviour is a separate question from whether the run
is allowed to stay silent about it — and the point of the row is that the
cases force that question to be asked out loud instead of answered by a
symptom disappearing.

### What this does NOT fix

- **The receipt names a tier promotion; nothing yet makes one.**
  `scripts/persist-compliance.ts` reads `skipOutcomes` — it is the sole
  consumer, and `classifySkip` renames the producer's `kind` rather than
  matching its sentence — so a tier-2 or tier-3 recommendation now reaches
  the operator as `TIER_PROMOTION_RECOMMENDED` on the receipt instead of only
  as stderr. Deploying the hook or the prompt change the promotion asks for
  is still manual, and that is a separate change.
- **An applied action has no outcome of its own.** `applied` is still a
  `string[]` carrying the consecutive-fail count and the destination inside a
  sentence, which is the same defect one state over.

## #645 — the zero-reinforcement baseline, measured rather than estimated

The hill-climb loop has never produced a reinforcement. This section is the
record of what it did instead, so the empty reinforcement history is not read
later as a quiet period rather than a broken instrument. #645 asks for the
measured replay and not an estimate, so **every number below is printed with
the command that produced it**, and the commands were re-run on the date in
the heading. A count with no command is not reproducible and the store under
it moves — which is the first thing this measurement found.

### The store moved, and the issue's own figure is already stale

#645 says "the 361-entry history".

```bash
wc -l ~/.rungate/compliance-history.jsonl        # → 377   (2026-10-19)
```

377, not 361. Nothing is wrong with the issue; the store grew between filing
and fixing. It is recorded because the replay below is only meaningful
against a stated denominator, and a later reader comparing 377 to a
remembered 361 would be comparing two different stores.

Roles in it: `marcus` 167, `discovery` 104, `rook` 103, `quinn` 3.

### The replay

Walk the history in timestamp order, treat each entry as the run's `current`
with everything before it as `history`, and call the real
`generateComplianceReport` then the real `detectHillClimbNeeds` — which is
what `scripts/persist-compliance.ts` does on a live run.

| Reading | Count |
|---|---|
| history entries | **377** |
| runs that would detect at least one action | **137** |
| actions detected in total | **193** (marcus 136, discovery 56, quinn 1) |
| …that resolve to an insertion point | **57** (discovery/COMP-7 ×50, discovery/COMP-6 ×6, marcus/COMP-2 ×1) |
| …that hit `NO_SECTION` | **136** |
| longest consecutive-fail streak ever reached | marcus **6**, discovery **6**, quinn **3**, rook **1** |

### Zero reinforcements have ever been committed

```bash
git log --all --oneline -S "REINFORCED (auto)" -- .claude/agents/ | wc -l   # → 0
grep -rl "REINFORCED (auto)" .claude/agents/ | wc -l                        # → 0
```

**With the controls, because an empty search over a store proves nothing
without one** (`.claude/rules/checks-must-be-able-to-fail.md`):

```bash
git log --all --oneline -S "## Never Do" -- .claude/agents/ | wc -l   # → 8
git log --all --oneline -- .claude/agents/ | wc -l                    # → 60
```

60 commits have touched the briefs and the search finds other strings in
them, so the zero is a reading and not an instrument that stopped reporting.

### Prior output is unrecoverable, and the hits that look like it are not it

```bash
grep -rl "REINFORCED (auto)" ~/.rungate | wc -l                  # → 22
find ~/.rungate -name "*.md" -path "*agents*" | wc -l            # → 0
```

22 files is a populated result and **none of it is evidence**. They are
`compliance-grade.json`, `suite-output.txt`, `workflow-state.json`,
`parent-body.md` and the history itself — grading data and logs that NAME the
prefix, not briefs that used it. No brief copy survives in any run directory.
This is the inverse trap #646 recorded: a store answering yes because it
archives the thing you asked about.

### The two causes #645 names do not survive the measurement

Both were checked. Recorded here because the point of this section is that the
record is measured, and transcribing a hypothesis that the measurement
contradicts would be the gap it exists to prevent.

**"An N/A grade resets the consecutive counter so the threshold is never
reached" — the mechanism is real, the consequence is not.** `countConsecutiveFails`
does break on anything that is not `IGNORED` or `VIOLATED`, N/A included
(`lib/compliance-report.ts:424`). But the threshold is reached, **137 times**,
and streaks run to 6 against a threshold of 3. The one role it fully
suppresses is `rook`, which never exceeds 1.

**"No brief carries the sections the inserter looks for" — two of seven do,
and did before the fix landed.** `marcus.md` carries `## Testing Rules` and
`discovery.md` carries `## Never Do`, both as of `f88d4bdd^`, the commit
before #624 Phase 1.

**What is actually true is sharper, and it is a selector bug rather than a
missing section.** `lib/compliance-report.ts:672` reaches `## Testing Rules`
**only for COMP-2**:

```ts
const sectionIdx =
  action.compId === "COMP-2" && testingIdx !== -1 ? testingIdx
  : efficiencyIdx !== -1 ? efficiencyIdx
  : neverIdx;
```

`marcus.md` carries *only* `## Testing Rules`. So for marcus every action
except COMP-2's falls through to `efficiencyIdx` (−1) and then `neverIdx`
(−1) and lands on `NO_SECTION` — **136 of the 193**, which is every marcus
action but one.

**And a third cause neither of the two names: 57 actions DID resolve a
section and nothing was ever committed.** The loss for those is downstream of
the insertion point, which is what #624 Phase 1 fixed — the loop wrote to a
destination nobody had chosen and the return value was believed over the
working tree.

- [x] SC-2116: specs/INSTRUCTION-COMPLIANCE-SPEC.md contains [the zero-reinforcement baseline, measured rather than estimated] — the replay is run over the real history with each count printed beside the command that produced it, the empty searches carry controls, and the two hypothesised causes are reported as measured rather than transcribed

### What this section does not claim

It does not claim the loop is fixed. It claims that before #624 Phase 1 the
loop detected 193 actions, resolved 57 of them to an insertion point, and
committed none — and that the three gaps are a selector that reaches one
heading for one COMP, a counter that an N/A resets, and a write whose result
was never observed. Only the third was Phase 1's subject.

## #704 — the selector reached one heading for one COMP, and now maps every id

The first of #645's three gaps, closed. `applyHillClimb` resolved its
destination with a nested conditional written inline:

```ts
const sectionIdx =
  action.compId === "COMP-2" && testingIdx !== -1 ? testingIdx
  : efficiencyIdx !== -1 ? efficiencyIdx
  : neverIdx;
```

Read as a mapping, that is one id reaching `## Testing Rules` and twelve
reaching only the other two. `marcus.md` carries `## Testing Rules` and
neither of the others, and marcus is the role that produces most of the
traffic — so every COMP except COMP-2 was refused by a brief that was
holding an insertion point the whole time, and the refusal said *"no
suitable section found in brief"*, which sends whoever reads it to edit a
file that is fine.

What replaces it is `resolveHillClimbSection` in `lib/compliance-report.ts`
— one exported binding with one call site, a total `COMP_PRIMARY_SECTION`
table over every id the grader can emit, and a fallback order DERIVED from
`HILL_CLIMB_SECTIONS` rather than written out per row. Three answers:
`RESOLVED`, `NO_SECTION` (the brief carries none of the headings, #646's
state unchanged), and `UNMAPPED_COMP` — a new state, because an id nobody
classified and a brief with no headings have opposite remedies and the run
has to say which. It reaches the receipt as
`COMP_HAS_NO_SECTION_MAPPING`, declared in `HILL_CLIMB_STATES`, in
`UNMEASURED_HILL_CLIMB_STATES`, and in both of `workflows/ship.js`'s
positions.

### How this composes with #655, which landed first

#655 added a FOURTH heading, `## Project Constraints`, and made it outrank
the other three — because `## Efficiency Rules`, `## Testing Rules` and
`## Never Do` are generated from `templates/agent-briefs/`, so a
reinforcement written into one of them is destroyed by the next
`bunx rungate scaffold .`, while the project-owned region is carried
forward verbatim. That ordering is a statement about DURABILITY and this
issue's table is a statement about TOPICALITY, and they are not in
competition: `hillClimbSectionPreference` returns
`[## Project Constraints, <the COMP's primary>, …the rest]`, so a rule goes
to the surface that survives whenever one exists and to the section it is
about otherwise. Both halves are asserted, and the pair for the first
varies only whether the region is present.

Two consequences worth stating rather than leaving to be discovered:

- **`HILL_CLIMB_DURABLE_SECTION` is read from `BRIEF_CONSTRAINTS_SECTION`,
  never spelled in `lib/compliance-report.ts`.** A literal copy is a second
  position naming the heading the preserver anchors on, and the two stop
  agreeing the day it is reworded (#621). A case asserts the string is
  absent from this module's source.
- **No brief in this tree carries the region yet** — #655 made it a
  preference and deliberately not a creation, which is #648's decision. So
  the replay below is unchanged by #655, and `NO_SECTION` is still
  reachable, which is what makes SC-2303 witnessable at all.

### The re-measurement, with the command beside every count

```bash
wc -l ~/.rungate/compliance-history.jsonl                  # → 382   (2026-10-19)
grep -c '"role"' ~/.rungate/compliance-history.jsonl       # → 382   (the control)
bun scripts/replay-hill-climb-history.ts
```

The control first: a store with 382 lines and 382 role-bearing records is a
store that was read. 382 and not #645's 377 — it grew in the days between,
which is the reason a count travels with its command.

`scripts/replay-hill-climb-history.ts` is the command, and it is in the tree
rather than in a transcript so a later reader can re-run it. It walks the
history in order, grades each entry against the ones before it through the
real `generateComplianceReport` and `detectHillClimbNeeds`, applies the same
grader-accuracy gate `scripts/persist-compliance.ts` applies, and drives the
real `applyHillClimb` at `DISCARD`.

| Reading | Pre-#704 | Post-#704 |
|---|---|---|
| history entries | 382 | 382 |
| runs that detect at least one action | 137 | 137 |
| actions detected | 193 (marcus 136, discovery 56, quinn 1) | 193 |
| **the selector asked about every one — `RESOLVED`** | **57** | **192** |
| **the selector asked about every one — `NO_SECTION`** | **136** | **1** |
| the live path: applied | 12 | **63** |
| the live path: `NO_SECTION` | 52 | **1** |
| the live path: `TIER_PROMOTION` | 129 | 129 |

The pre-#704 column was taken on this tree with the old conditional
restored inside `resolveHillClimbSection`, then reverted and the source
confirmed byte-identical by checksum.

**#645's `136` and `57` reproduce exactly, and they are not counts of what
the live loop did.** The tier-promotion branch runs BEFORE the section is
resolved, so 129 of the 193 never reach the selector at all; the
selector-only reading answers *"what would the selector say if asked"* and
the live reading answers *"what did the run do"*. Both are real, they differ
by 84, and #645's table printed the first under a heading that reads like
the second. That is why the script prints both.

The one action still refused after the fix is quinn's, and `quinn.md`
carries none of the three headings — so the live store witnesses SC-2303
rather than only the fixtures.

### Success criteria

- [x] SC-2300: one exported binding maps a COMP id to a destination heading and it has exactly one call site, so there is a single thing to mutate
- [x] SC-2301: every COMP id the grader can emit has a declared preference covering every heading, durable region first (#655), read off `lib/transcript-checker.ts` and `.claude/rungate/compliance.json` rather than typed into the test
- [x] SC-2302: a brief carrying any ONE of the headings accepts a reinforcement for every COMP id, and `## Project Constraints` outranks the COMP's own primary when both are present, measured over the real `applyHillClimb` and not a copy
- [x] SC-2303: a brief carrying NONE of the headings still reports `NO_SUITABLE_SECTION`, applies nothing, and leaves the brief on disk byte-identical
- [x] SC-2304: a COMP id with no declared heading is refused by name as `UNMAPPED_COMP` and reaches the receipt as its own UNMEASURED state, never as a brief with no heading
- [x] SC-2305: the reinforcement is inserted INSIDE the resolved section — asserted by position relative to the next heading, not by the string being present somewhere

All six are covered by `test/hill-climb-section-selector.test.ts` and
`test/unit/zero-reinforcement-baseline.test.ts`, and the command is
`bun test test/hill-climb-section-selector.test.ts
test/unit/zero-reinforcement-baseline.test.ts`, which reports 24 pass / 0
fail.

**The selector file sits at the top level of `test/` deliberately, and the
first draft of it did not.** `findTestFilesForSCs` in
`scripts/sync-sc-status.ts` enumerates with `readdirSync(TEST_DIR)` and no
recursion, so a criterion whose only test lives under `test/unit/` can never
earn a credit — it is ticked, unmatchable and unclaimed, which is exactly the
population `UNCLAIMED_RATCHET` in `test/sc-binding-split.test.ts` refuses a
rise in, and the per-spec one in `test/ticked-sc-cover.test.ts` refuses by
name. Six hand-ticked criteria under `test/unit/` took the first of those
from 153 to 159 and added `INSTRUCTION-COMPLIANCE-SPEC.md: 18 ticked criteria
have no cover of any kind, 12 allowed` to the second. Hand-ticking is the
move that buys green here and banks nothing, so the file moved instead and
the six are credited by the real scanner. SC-2116 above is still ticked by
hand for the original reason; it is inside the banked number and this issue
does not move it.

`CLAIMED_UNBINDABLE` in `test/sc-binding-split.test.ts` goes 66 → 72 in the
same commit, which is the honest consequence: these six ARE claimed by a
test and the matcher registry has no vocabulary for *"one binding, one call
site"* or *"the brief on disk is byte-identical"*. That number is tracked in
both directions rather than ratcheted, so banking it is an edit somebody
makes on purpose.

**These ids have been allocated three times, and #507 is why.** The first
block collided with #715's SC-2131 in `specs/AGENT-BRIEF-TEMPLATE-SPEC.md`;
the second, SC-2167..SC-2172, collided with the SC-2167/SC-2168 that #724
minted in `specs/GATE-CONTRACTS-SPEC.md` while repairing a collision of its
own. Both times the floor was re-derived by running the real
`allocateScNumber` against the tree rather than reading the highest id in
this file — which is the narrower reading that agrees right up until a peer
allocates on a branch you have not fetched.

### The mutation record

Measured over `test/hill-climb-section-selector.test.ts` +
`test/unit/zero-reinforcement-baseline.test.ts` +
`test/persist-receipt-relay.test.ts` (60 tests). Every count was predicted
before the battery ran, and **the baseline row was read before any mutation
row** — an instrument that has stopped reporting takes the baseline down
with it, and that is the row nobody checks.

**This table has been measured three times and the one below is the third.**
A row measured on a tree nobody can check out is a claim rather than a count
(`.claude/rules/parallel-sessions.md`), and the first two trees no longer
exist. The first was taken over 58 tests before #711/#714/#715/#716 landed;
the second after the rebase onto them, where #655's composition added the two
cases that make 60; the third after the rebase onto #724's repair of main and
after the test file moved from `test/unit/` to the top level of `test/`.

**No row moved between the second and the third**, and the reason is worth
stating rather than leaving as a coincidence: #724 touched
`.claude/rules/checks-must-be-able-to-fail.md`, `lib/doc-routing.ts`,
`specs/GATE-CONTRACTS-SPEC.md` and four test files, none of which is a
subject of this battery, and the move changed the test file's path, its
import depth and the SC ids in its titles — not one assertion. The
prediction for the third run was therefore "every row reproduces the second
table exactly", written down before the baseline was read, and all ten did.
What the re-run buys is not a new number; it is that the ten numbers now
describe a tree somebody can check out.

| Row | Predicted | Measured | The input on which mutant and original differ |
|---|---|---|---|
| **baseline** — unmutated | 60 pass, 0 fail | **60 pass, 0 fail** | — |
| the genuinely pre-#704 selector — the four-way conditional, as #715 left it | 4 | **4 of 60** | COMP-7 over a brief whose only heading is `## Testing Rules`: the original returns `{RESOLVED, "## Testing Rules", 10}`, the mutant returns `NO_SECTION`. The brief carrying the region reads identically in both, which is the evidence #715's arm is untouched by this issue |
| `resolveHillClimbSection` short-circuited to `NO_SECTION` for every input | 12 | **11 of 60** | COMP-2 over the Testing-Rules brief: `RESOLVED` on the original, `NO_SECTION` on the mutant |
| `COMP_PRIMARY_SECTION` truncated to its single `COMP-2` row | 13 | **13 of 60** | COMP-7 over a brief carrying all three generated headings: the original is `{RESOLVED, "## Never Do"}`, the mutant is `UNMAPPED_COMP` |
| the fallback dropped — the preference stops at `[durable, primary]` | 3 | **4 of 60** | COMP-7 over the Testing-Rules-only brief: `{RESOLVED, "## Testing Rules"}` against `NO_SECTION`. Its PREFERRED heading is absent and the original falls back; the mutant does not |
| `headingIndex` reverted to a bare `indexOf` | 1 | **1 of 60** | a brief with `## Efficiency Rules` and `### Never Do`: the original resolves `## Efficiency Rules` at 10, the mutant resolves `## Never Do` at 32 — the last eleven characters of the sub-heading |
| the durable region demoted out of first place (#655 inverted) | 1 | **1 of 60** | a brief carrying all three generated headings AND `## Project Constraints`: the original resolves the region for every COMP, the mutant resolves each COMP's own primary |
| `UNMAPPED_COMP` removed from `SKIP_OUTCOME_STATE` | 1 | **1 of 60** | the outcome for COMP-9001: `classifySkip` returns `"COMP_HAS_NO_SECTION_MAPPING"` on the original and `undefined` on the mutant, which lands the refusal in `unclassified` |
| `COMP_HAS_NO_SECTION_MAPPING` dropped from ship.js's relay schema | 12 | **12 of 60** | a real receipt: the original's `persistReceiptRelayViolations` is `[]`, the mutant names `hillClimb.states.COMP_HAS_NO_SECTION_MAPPING` |
| the same state dropped from `PERSIST_SIGNATURE_STATES` | 4 | **4 of 60** | any receipt: ship.js's recomputation folds seven counts and the script's folds eight, so the two signatures disagree |
| **the cheapest wrong fix** — append at the end of the brief when no heading matches | 8 | **8 of 60** | a brief carrying none of the headings: the original returns `applied: [], kinds: ["NO_SECTION"]` and leaves the file byte-identical; the mutant returns `applied: ["COMP-7: added reinforcement (4 consecutive fails) → COMMIT"]`, `kinds: []`, and rewrites the brief |

#### What the rebase moved, and why

Every row that moved is explained by a case being added or by #715's arm
existing, and none of them is a row that stopped witnessing:

- **The relay-schema row went 9 → 12 and the signature row 2 → 4** between
  the two measurements only because the first table's predictions were low
  there; the measured numbers are identical on both trees.
- **The short-circuit row came back LOW, 11 against a predicted 12.** The
  two cases added for #655 are not symmetric: *"the durable region outranks
  every COMP's own preference"* drives the resolver and goes red, while
  *"the durable heading is read from its owner, never spelled here"* is a
  claim about this module's SOURCE TEXT and cannot see a runtime
  short-circuit. Correctly green, and the prediction simply counted both.
- **The fallback row came back HIGH, 4 against a predicted 3.** The extra
  is SC-2301's *"each one has a declared preference covering every
  heading"*, which the revision dropped by accident; it is squarely about
  the mutation, since the mutant's preference no longer covers every
  heading.

#### A broken mutant, recorded rather than filed as a high row

The relay-schema row's FIRST attempt came back **27 of 60** against a
predicted 12. Per the arithmetic in
`.claude/rules/checks-must-be-able-to-fail.md`, a high row has two causes
and the count alone does not say which, so the failing names were read
before anything was concluded — and they were *every* case that loads the
receipt block, including the four `#663 AC-4` reading cases that have
nothing to do with a declared state.

The mutation had deleted the trailing comma from the line above instead of
the declaration itself, leaving two object properties with no separator.
`loadReceiptBlock` could not parse `ship.js`, so the file aborted. **A
mutant that crashes is not a mutant** — it measures that the source still
parses (#485). Re-run with a mutation that removes the declaration and
leaves valid syntax: 12, matching the prediction. The row above is the
second reading; the first is recorded here because the two are
indistinguishable by count.

**Three rows carry extra reds that ARE the real kind, and they are the same
three as before the rebase.** No mutant crashes in the final table — 47 to
59 cases pass in every one of them, and every red is about the mutated
subject.

- The truncated-table row's extras are #646's own relay fixtures — *"the
  fixtures really reach the skip-state fields"* and *"a run whose only
  action had nowhere to go says so by name"*. Both drive the real
  `persistCompliance` to produce a `NO_SUITABLE_SECTION` receipt, and with
  only COMP-2 classified that state becomes unreachable. The fact it
  records: #646's receipt fixtures depend on the COMP→section mapping, one
  module away, and nothing before this said so.
- The relay-schema row's extras are two #663 type-walk cases and this
  issue's own `ship.js`-declares-it case. All three assert the real source
  is clean before asserting a mutant is not, so one real-source removal
  reds every case carrying that half — the same arithmetic #646 recorded
  for its own 6 row.
- The signature row's extras are three #663 parity cases, for the same
  reason in the other position.

**Does the shipped set survive the cheapest wrong fix? Yes, NON-vacuously,
and 8 of 60 is the measurement rather than the argument.** Three of the
eight are SC-2303's pair and the zero-reinforcement refusal case, and they
survive because they assert the STATE the run reported and whether the
brief on disk changed — not whether the reinforcement text appears
somewhere, which the wrong fix also satisfies. The other five are #646's
relay fixtures again, and they are the sharper evidence: the wrong fix
makes `NO_SUITABLE_SECTION` permanently unreachable, so the receipt
machinery built to report it stops being able to.

None of the ten mutations is left in the tree; all were run and reverted,
and `lib/compliance-report.ts`, `scripts/persist-compliance.ts`,
`workflows/ship.js` and `test/hill-climb-section-selector.test.ts`
were confirmed byte-identical to the measured source after every row by
`shasum -a 256 -c`, with the baseline re-read at 60 pass / 0 fail after the
last revert.

### What this section does not claim

It does not claim the loop now commits reinforcements. The second of #645's
three gaps is untouched — 129 of the 193 are stopped by the tier-promotion
branch before the selector is reached, and whether a tier-2 recommendation
should also leave a brief bullet is a separate decision. The third gap,
the 57 that resolved and were never committed, is #624's and is explicitly
out of scope here.
