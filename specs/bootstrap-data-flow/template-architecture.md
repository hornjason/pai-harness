---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: Template Architecture + 5 more
testable: true
---

## Template Architecture

Templates are three-layered. Each layer adds specificity. The brief-assembler merges all three.

### Layer 1: Harness-generic (ships with rungate)

Universal templates that work for any project:
- RCA protocol (4 phases)
- AC format (Given/When/Then + oracle)
- Evidence hierarchy (S through F)
- Quinn decision tree
- Blast radius checklist
- Regression prevention checklist
- Read-before-write protocol
- Prevention-oriented fix template (guard, type narrow, pattern audit)
- Coding principles (deep modules, boundary validation, Zod at boundaries, assertNever, branded types)
- Testing strategy (PBT, contract tests, tautological trap, boundary testing, test evidence per AC type)
- Escalation decision tree (research tools, when to stop iterating)

These never reference specific files, ports, routes, or technologies.

### Layer 1 knowledge problem: training data goes stale

Saying "use deep modules" in a brief doesn't teach the agent what deep modules ARE. Models are trained on data up to a cutoff — principles published after that cutoff aren't in their weights. The harness solves this in three ways:

1. **Inline the principle, not just the name.** The `coding-principles.md` template doesn't say "use deep modules." It says:
   ```
   DEEP MODULES: A module should do a lot of work behind a simple interface.
   - A function with 3 parameters that handles 15 edge cases internally = deep
   - 15 small functions each handling 1 case, requiring the caller to orchestrate = shallow
   - When adding functionality: extend an existing deep module rather than adding a new shallow one
   - Test: can a caller use this module without understanding its internals? If no, the interface is too complex.
   ```
   The principle is EXPLAINED, not referenced. The agent has the content, not a pointer.

2. **Context7 MCP for current library docs.** When an agent needs framework-specific guidance (Hono routing patterns, Zod schema design, Bun test runners), Context7 fetches CURRENT documentation — not the model's training data. This is why Context7 is declared in the research tools section: it's the escape hatch from stale training data.

3. **Harness update cycle.** When new research emerges (like the findings from this session's 8 researchers), it gets written into Layer 1 templates. Every project gets the updated templates on next `bun install`. The harness is the distribution mechanism for current best practices.

**The flow:**
```
New research/principle discovered
  → Written into harness prompts/ template (Layer 1)
  → Harness version bumped
  → Projects run bun install → get new templates
  → Next ship cycle → brief-assembler generates briefs with updated content
  → Agent reads the actual principle, not just a name
```

This is why Layer 1 templates contain the full explanation, not links. An agent can't click a link to "A Philosophy of Software Design." But it CAN read a 10-line summary of the principle with specific do/don't examples embedded in its brief.

### Layer 2: Project-config (from rungate.json + CODE-MAP)

Project-specific values injected into templates:
- Test command (`bun test` vs `pytest` vs `go test`)
- Port numbers (from rungate.json environments)
- File paths (from CODE-MAP)
- Framework details (Hono, React, etc.)
- Page URLs (from rungate.json pages)
- Consumer modules (from rungate.json consumers)

### Layer 3: Issue-specific (generated per brief by brief-assembler)

Per-issue values:
- ACs for this specific issue
- Files this issue touches (from brief)
- Governing spec for this issue
- Quinn journey steps for this UI change
- RCA fields pre-populated from issue description

### Merge order

```
harness-generic (Layer 1)
  + project-config (Layer 2) → variables filled
  + issue-specific (Layer 3) → ACs, files, journeys added
  = Complete agent brief
```

### Per-agent template sections

| Agent | Layer 1 sections | Layer 2 additions | Layer 3 additions |
|-------|-----------------|-------------------|-------------------|
| Marcus | RCA protocol, AC format, blast radius, regression prevention, read-before-write, coding principles, testing strategy, prevention-oriented fix | test command, source dirs, consumers | ACs, files, governing spec |
| Quinn | Decision tree, journey schema, evidence capture, circuit breaker | ports, pages, viewport | Typed journey steps from UI ACs |
| Rook | Security checklist, OWASP patterns, secret detection | security baseline path | Changed files to scan |
| Serena | Architecture review, cross-boundary analysis, coding principles | ADR location, module map | Structural changes proposed |
| Aditi | Component spec format, a11y requirements | component paths, design system | UI components affected |

### Improvement flow

Template improvement in Layer 1 → every project gets it on next re-scaffold. No per-project configuration needed for fundamental best practices.

### Brief assembly order (SC-140, SC-145)

Research: "Lost in the Middle" (Stanford, TACL 2024) shows 30-50% accuracy drop for content in the middle of context vs start/end. Instruction Stacking Collapse (arXiv:2608.02639) shows compliance drops from 96.4% to 57.7% at 16 stacked rules.

The brief-assembler MUST order sections to put critical instructions at the positions models attend to most:

```
1. IDENTITY (role, constraints, output format)     ← START (highest attention)
2. CORE PRINCIPLES (universal 6-line block)         ← near start
3. METHODOLOGY (Layer 1 templates, 10 rules max)    ← middle (lowest attention — OK because gates enforce)
4. PROJECT CONTEXT (Layer 2, from rungate.json)      ← middle
5. ACs + VERIFICATION COMMANDS (Layer 3)             ← END (high attention, recency bias)
```

This exploits the U-shaped attention curve: models attend most to start and end, least to middle. Methodology in the middle is acceptable because gates mechanically enforce what the model might miss. ACs at the end get recency bias — the thing the agent works on most is what it sees last.

### Template format requirements (SC-141, SC-142)

Research on instruction format effectiveness:

1. **Positive framing > negative.** "Use `Result<T, E>` for error handling" beats "Don't throw exceptions." Cap negative instructions at 10 per brief. Past that, models confuse what NOT to do with what to do.

2. **Examples > descriptions.** One code snippet showing the pattern beats three paragraphs describing it. Every Layer 1 template must include at least one concrete code example per principle.

3. **One concept per bullet.** Multi-action instructions get merged or reinterpreted. Break into single-action items.

4. **Calm tone.** "CRITICAL!", "YOU MUST", "NEVER EVER" overtriggers newer models and produces WORSE results than direct instructions (Anthropic context engineering guide). Emphasize one line, not many.

5. **Three-tier rule authority (SC-146).** Every rule in an agent brief is categorized by action authority. This tells the agent what it can do autonomously vs what needs approval vs what is forbidden. Research: "never do" sections are the most frequently skipped and cause the most production failures — making them explicit and separate improves compliance.

   ```
   ## Always Do (autonomous — no approval needed)
   - Run `bun test` after every change
   - Read AGENTS.md before starting work
   - Verify before asserting

   ## Ask First (needs DA approval before proceeding)
   - Modifying files outside the brief's listed files
   - Adding new dependencies
   - Changing public interfaces

   ## Never Do (hard stops — gate FAIL if violated)
   - Self-attest evidence (tier F)
   - Skip ACs without rationale
   - Commit secrets or credentials
   ```

### Activation modes (SC-143)

Industry convergence on four activation modes (Cursor, Devin, Cline all implement these). Each template declares its mode:

| Mode | When loaded | Example |
|------|------------|---------|
| always-on | Every request, unconditionally | Core Principles block, AGENTS.md |
| file-pattern | When matching files in context | Security checklist when .env files touched |
| agent-decided | Agent reads description, decides relevance | RCA protocol (only for bug-fix issues) |
| manual | Only on explicit invocation | Full spec reference |

**Budget rule:** Always-on content under 200 words total. Every word costs on every request. File-pattern and agent-decided have no hard cap but 10 essential rules per template.

### Rule count caps (SC-138)

Hard data: models reliably satisfy ~3 concurrent constraints (Instruction Complexity Cliff research). At 16 stacked instructions, compliance drops 50%+ (arXiv:2608.02639). ETH Zurich: 10 essential rules outperform 200 generic ones.

**Per-template caps:**
- Universal Core Principles: 6 rules (always-on, every agent)
- Per-role rules in agent definition: 4-6 rules
- Layer 1 methodology template: 10 rules max
- Total rules an agent sees at brief time: ≤25

The 25-rule ceiling is a design target, not a gate FAIL. Gate WARNS if brief exceeds 25 distinct rules. The intent: force prioritization. If you can't fit a principle in 25 rules, the principle isn't essential — move it to a gate check instead.

### Rule lifecycle (SC-144)

Rules go stale. Production systems report compounding stale-rule problems: old patterns in code outnumber new ones, agents imitate what they find, deprecated patterns survive test suites, each copy creates another call site for future agents.

**Rule hygiene protocol:**
1. Every rule in AGENTS.md Hard Constraints gets a `<!-- since: YYYY-MM-DD -->` comment
2. Re-scaffold flags rules older than 90 days without revalidation: WARN "Rule '{name}' last validated {N} days ago — review or reconfirm"
3. "Second occurrence" principle: only add a rule after the same mistake happens twice. First occurrence = noise. Twice = pattern.
4. Quarterly audit (manual, not automated): was it used recently? Does it solve a real problem? Can it be simplified? Does it conflict with other rules?

### Mid-session compliance (15 tool-call cliff)

Research: past 15 tool calls, system prompt constraints lose influence from attention dilution. Ship cycles easily exceed 15 tool calls.

**Mitigation strategy (mechanical, not behavioral):**
1. Gates run AFTER the work, not during — they don't depend on the agent remembering rules mid-session
2. Gate checks are deterministic code, not LLM judgment — compliance is verified, not trusted
3. Brief structure puts ACs at the END (recency bias) — the verification commands are what the agent sees last
4. Circuit breaker at iteration 3 forces a reset — fresh context, rules re-read

This is why the entire harness architecture is gate-first: we EXPECT agents to drift past 15 tool calls. The gates catch drift mechanically. The brief optimizations (ordering, caps, positive framing) reduce drift but don't eliminate it.

## Spec Drift Enforcement

Spec content hashes are tracked. When a spec changes, tests written against it are stale.

### Mechanism

1. Each testable spec's content is hashed (SHA-256 of SC section)
2. Hash stored in `test/spec-compliance-auto.test.ts` as comment
3. At gate time (scope + verify), current spec hash compared to stored hash
4. **Mismatch = FAIL** — "spec changed since tests written, update tests"
5. `bunx rungate sync-tests .` regenerates tests from current spec → hash updates

### Why FAIL not WARN

WARN is behavioral — the agent sees it, notes it, proceeds anyway. FAIL is mechanical — gate blocks, work can't ship until tests match spec. This is D-18.

## Parallel Work Isolation

When multiple agents or sessions work on the same repo concurrently, four conflict types emerge. The harness handles each mechanically.

### Conflict types and solutions

| Conflict type | What breaks | Solution | Enforcement |
|---|---|---|---|
| Code overlap | Two agents modify same file | Git worktrees (file isolation) + file-set overlap detection | SC-46, SC-69 |
| Container sharing | Two agents rebuild/test simultaneously | Container lock in Makefile | SC-45, SC-47 |
| Port collision | Two dev servers on same port | Port/namespace allocation per worktree | SC-70 |
| Stale accumulation | Old worktrees, branches, slugs pile up | Slug lifecycle + worktree cleanup | SC-42, SC-43 |

### Git worktree integration

Each parallel issue gets its own worktree. The harness manages the lifecycle:

```
CREATION (at ship SCOPE):
  1. Branch created: git branch issue-{N}-{slug} main
  2. Worktree created: git worktree add .worktrees/issue-{N} issue-{N}-{slug}
  3. Slug directory: ~/.rungate/{slug}/ (shared — not in worktree)
  4. Agent spawned with cwd = worktree path

BRANCH NAMING:
  Pattern: issue-{number}-{slug}
  Examples: issue-1452-bootstrap-fix, issue-1453-quinn-journey
  Deterministic from issue number — no collisions

DURING WORK:
  - Agent works entirely within its worktree
  - bun test runs against worktree's copy (isolated)
  - All file paths in workflow-state.json are relative to worktree root
  - Container lock checked before any make rebuild / make prove-up

MERGE (after ship + prove PASS):
  1. PR created from worktree branch → main
  2. CI runs on PR branch
  3. Human review (or auto-merge for LIGHT tier if configured)
  4. Squash merge into main
  5. Rebase subsequent worktree branches against updated main:
     git -C .worktrees/issue-{next} rebase main

CLEANUP (after merge):
  1. Worktree removed: git worktree remove .worktrees/issue-{N}
  2. Branch deleted: git branch -d issue-{N}-{slug}
  3. Slug archived (existing lifecycle — SC-42)
  4. If no changes made, worktree auto-cleaned (Claude Code native behavior)
```

### File-set overlap detection (SC-69)

Before assigning concurrent issues to parallel agents:

```
1. Each issue's brief lists expected files to modify
2. Compare file sets across all active worktrees
3. DISJOINT → safe to parallelize
4. OVERLAP on shared files (utils, config, types) → WARN with list
5. OVERLAP on same module → BLOCK — serialize these issues

Detection runs at SCOPE gate when a new ship cycle starts while other cycles are active.
```

### Port/namespace isolation (SC-70)

Git worktrees isolate files but NOT runtime resources:

```
PORT ALLOCATION:
  - Each worktree gets a port offset from base: base + (issue_number % 100)
  - Dev server: DEV_UI_PORT = 5173 + offset
  - API server: DEV_API_PORT = 7778 + offset
  - Stored in worktree-local .env or passed via env var
  - rungate.json in worktree updated with allocated ports

CONTAINER ISOLATION:
  - Container lock prevents concurrent rebuilds (SC-45)
  - Queued issues wait for lock release (SC-47)
  - Alternative: separate container per worktree (heavier but fully isolated)

TEST ISOLATION:
  - Each worktree runs its own bun test (file-isolated by worktree)
  - Database tests: use test-scoped DB name or transaction rollback
  - Cache: each worktree gets its own cache namespace
```

### Sequential merge protocol (SC-72)

Parallel work creates parallel branches. Merging is ALWAYS sequential:

```
1. Merge PR for issue A → main
2. CI runs on updated main → PASS
3. Rebase issue B's branch against new main
4. Merge PR for issue B → main
5. CI runs on updated main → PASS
6. Continue for each remaining issue

NEVER merge two PRs simultaneously — the second merge
must see the first's changes to detect conflicts.
```

### Agent concurrency cap (SC-71)

- Maximum 5 concurrent agents per session (Google Research: diminishing returns beyond this)
- Coordination overhead scales quadratically: 10 agents = 45 potential conflict pairs
- The cap applies to parallel ship cycles, not to within-cycle agents (Marcus + Quinn + Rook can all run for one issue)

## Test Baseline and Pre-existing Failures

### Scope gate captures baseline

At scope gate (beginning of ship cycle), the test baseline is captured:

```json
"beforeState": {
  "testBaseline": {
    "total": 50,
    "pass": 47,
    "fail": 3,
    "failingTests": ["test-a", "test-b", "test-c"],
    "capturedAt": "2026-09-18T..."
  }
}
```

### Verify gate compares against baseline

```
fail count AFTER ≤ fail count BEFORE = PASS (no regressions)
fail count AFTER > fail count BEFORE = FAIL (regression introduced)
total count AFTER < total count BEFORE = FAIL (tests removed — possible gaming)
```

### Pre-existing failures are tracked, not ignored

When scope gate finds pre-existing test failures:

1. Each failing test not already tracked in an open issue → auto-filed:
   ```
   gh issue create --title "Pre-existing: {test name} failing"
     --label "p3-can-wait,pre-existing"
     --body "Found during ship cycle for #{currentIssue}. Not from current changes."
   ```
2. Pre-existing failures don't block current work
3. They exist in the backlog with the `pre-existing` label

### Fix-on-find enforcement

When an agent discovers any issue during a ship cycle:

| Can fix in <10 min, no design decision? | Fix it now — same session |
| Can't fix quickly? | `gh issue create` with `found-during-#{issue}` label |
| Neither? | WARN — must explicitly scope it out in `scopeOut` |

Verify gate checks: every found issue is either (a) fixed, (b) filed as issue, or (c) in scopeOut. Silently dropping it = **FAIL** — unaddressed gaps are not acceptable.

## Makefile Fallback Chain

Not every project has a Makefile. The scan tries sources in priority order:

| Field | Source 1 (Makefile) | Source 2 (package.json) | Source 3 (null) |
|-------|--------------------|-----------------------|-----------------|
| dev.start | `make dev-all` target | `scripts.dev` → `bun run dev` | null → skip dev server steps |
| dev.testCmd | `make test` target | `scripts.test` → `bun test` | `bun test` (safe default) |
| prod.rebuild | `make rebuild` target | `scripts.build` → `bun run build` | null → skip container steps entirely |
| prod.smokeTest | `make smoke` target | `scripts.smoke` | null → skip smoke tests |
| test.rebuild | `make test-rebuild` target | none | null → skip test container |
| test.start | `make prove-up` target | none | null → skip prove container |
| test.stop | `make prove-down` target | none | null → skip prove cleanup |

When a field is null, the workflow step that uses it is SKIPPED — no agent spawned, no command run. The workflow records `environments.{env}.{step} = "SKIP"` with `skipReason: "no config"`.

## Phase 1.5 — Knowledge Extraction (non-inferrable rules from docs)

Code scans produce structure. But projects accumulate organic knowledge in docs, ADRs, and specs that agents can't discover from code — intentional anti-patterns, deploy gotchas, disabled features, safety boundaries.

### Source Scan

Bootstrap scans these locations for non-inferrable rule candidates:

| Source | What to Look For |
|--------|-----------------|
| `docs/adr/*.md` | Decisions marked "accepted" — these are intentional choices |
| `docs/*.md` | Patterns: "intentional", "by design", "do not change", "never", "must not" |
| `specs/*.md` | Constraints section, anti-patterns section |
| `ARCHITECTURE.md` | "Looks like X but is actually Y", intentional coupling |
| `PRINCIPLES.md` | Hard rules, pre-flight checks |

### Extraction Rules

1. Grep all docs for signal phrases: `intentional|by design|do not|never|must not|anti-pattern|permanently disabled|looks like.*but`
2. Extract the sentence + surrounding context (3 lines)
3. Deduplicate against existing Hard Constraints in AGENTS.md (content match) and rejected-constraints.md (content-hash)
4. Present new candidates to the user for confirmation
5. Confirmed candidates → appended to AGENTS.md Hard Constraints section between AUTO-EXTRACTED markers
6. Rejected candidates → logged to `reference/rejected-constraints.md` with content-hash so they don't resurface

### Execution

- Separate command: `bunx rungate extract-constraints /path/to/project`
- NOT auto-run from scaffold (70% false positive rate — human review mandatory)
- On re-scaffold: HYGIENE-6 conformity check warns about unreviewed candidates
- `--dry-run` is the default. `--apply` writes confirmed candidates to AGENTS.md
- On first run: full scan of all docs → present all candidates
- On re-run: incremental scan (only docs modified since last scan) → present new candidates only
- Existing Hard Constraints are NEVER removed by re-scan — only added to

### Doc Lifecycle (archive stale, keep current)

During extraction, docs are also classified:

| Classification | Criteria | Action |
|---------------|----------|--------|
| ACTIVE | Git log shows commit within threshold (per-type below) | Keep in `docs/` |
| ARCHIVED | Git log older than threshold OR manually moved | Move to `reference/` |

**Per-doc-type staleness thresholds** (council decision — single 90d threshold flags 84% of DDB docs):

| Doc type | Path pattern | Threshold | Rationale |
|----------|-------------|-----------|-----------|
| ADR | `docs/adr/` | NEVER time-staled | Durable decisions — stale only by `status: superseded` |
| Spec | `specs/` | 90 days | Active governance docs should be current |
| Guide/runbook | `docs/` | 180 days | Operational docs change less frequently |

**Staleness signal:** Primary = `git log -1 --format=%ci` per file. Frontmatter `last-verified` is optional human override — if present and within threshold, file is ACTIVE regardless of git log. Frontmatter `updated` is NOT used (bulk-stamp dates prove unreliability).
