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
  if it were new.

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
