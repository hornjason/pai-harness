---
doc-type: spec
status: active
owner: jason
created: 2026-09-20
updated: 2026-09-20
governs: CLI Commands for File Creation + 9 more
testable: true
---

## CLI Commands for File Creation

Agents create specs and ADRs via CLI — guarantees correct location, format, and frontmatter. Never copy templates manually.

| Command | What it creates | Where |
|---------|----------------|-------|
| `bunx rungate create-spec "title"` | Spec with frontmatter + section stubs | `specs/title-slug.md` |
| `bunx rungate create-adr "title"` | ADR with template + auto-incremented number | `docs/adr/ADR-NNN-title-slug.md` |
| `bunx rungate sync-tests .` | Test assertions from testable specs | `test/spec-compliance-auto.test.ts` |
| `bunx rungate extract-constraints .` | Constraint candidates from docs | Candidates for review |

## Gate-Time Conformity Enforcement

Conformity tests run at TWO points in the ship cycle — not just at the end.

```
SCOPE GATE (before work starts):
  → runs test/scaffold-conformity.test.ts
  → verifies repo is clean BEFORE agent starts coding
  → catches: stale state, broken refs, misplaced files from prior work
  → FAIL = blocked. Fix before proceeding.

VERIFY GATE (after work complete):
  → runs test/scaffold-conformity.test.ts AGAIN
  → catches anything the agent introduced:
    - new spec in wrong dir? FAIL
    - new .md at root? FAIL
    - frontmatter missing? FAIL
    - circular dep introduced? FAIL
  → FAIL = blocked. Fix before shipping.
```

Conformity suite runs in <500ms (pure file system checks, no network/LLM).

### Findings flow (detection → structured output → agent fix → re-verify)

```
bun test (in project)
  → conformity suites run (HYGIENE-1 through HYGIENE-10)
  → extract-constraints runs (signal phrases → candidates, staleness)
  → HYGIENE-REPORT writes .rungate/conformity-findings.json:
      { findings: [{ruleId, severity, file, message, fixCommand}],
        constraintCandidates: [{rule, source, hash, status}],
        staleness: [{file, daysSince, threshold, type}] }
  → Gate runner (run-gate.ts) reads .rungate/conformity-findings.json
  → Prints structured output with fix commands
  → Stores conformityFindings in workflow-state.json
  → Agent reads workflow-state.json → executes fixCommands → re-runs bun test
```

Agent discovery paths:
- **During ship gate:** workflow-state.json `conformityFindings` field (gate runner puts it there)
- **Running bun test directly:** HYGIENE-REPORT prints path + details to terminal
- **Reading project docs:** AGENTS.md Commands table → `cat .rungate/conformity-findings.json`

Nothing is lost to stdout. Constraint candidates persist in the JSON file until applied or rejected.

Structural violations are FAIL, not WARN:

| Check | Severity | Rationale |
|-------|----------|-----------|
| Misplaced spec/ADR/doc | FAIL | Wrong location = harness can't find it |
| Missing frontmatter | FAIL | No frontmatter = no test generation |
| Broken file references | FAIL | Broken ref = broken routing |
| Missing package.json required fields | FAIL | name, type:module, scripts.test, devDep required for harness |
| Secret patterns in staged files | FAIL | HYGIENE-12 — mechanical catch for 44% AI security flaw rate |
| Spec drift (hash mismatch) | FAIL | Tests don't match current spec = stale tests |
| AGENTS.md over 150 lines | WARN | May be legitimate for complex projects |
| Stale docs | WARN | Stale ≠ wrong, needs human judgment |
| Missing tsconfig.json strict:true | WARN | Recommended, not required |
| Unreviewed constraint candidates | WARN | 70% false positive rate — human review needed |

## Agent Brief Core Principles

Every agent brief (`.claude/agents/*.md`) includes a shared Core Principles block. These are non-negotiable rules derived from a year of learned failures (25+ correction entries, 50 tiered learned rules).

### Universal block (in EVERY agent brief, ~8 lines)

```
## Core Principles
- Verify before asserting — try it, then report what happened
- Never report PASS with known gaps — list every gap
- Read AGENTS.md FIRST — project identity, constraints, commands
- Run `bun test` after every change — conformity is mechanical
- Null in config means skip — never guess values
- Research before guessing — use available tools (see Research and Escalation below)
```

### Role-specific rules (added per agent)

| Agent | Key rules from learned failures |
|-------|-------------------------------|
| Marcus | Read governing spec BEFORE coding. Modify ONLY files in brief. Commit after every green cycle. Never duplicate components — add props. Schema validation at boundaries (Zod). Every new module gets a drift test. |
| Quinn | Test full workflow (trigger → result → USE result). Compare against visual spec if referenced. Test edge cases after golden path. Verify fix commit deployed before testing. Open every rendered URL. |
| Rook | Check git diff for .env, credentials, tokens, API keys. Scan pattern siblings (shared-import files). |
| Serena | Read existing ADRs before proposing new ones. Every structural decision gets a spec. |

## Coding Principles (shipped with harness as `prompts/coding-principles.md`)

AI agents produce 10-50x more boundary violations per session than human engineers (Ousterhout observation, confirmed by SWE-bench analysis). These principles are EXPLAINED in the template — agents need rationale, not just rules. Context7 MCP provides current library docs to supplement stale training data.

### Deep modules over shallow wrappers

Modules should provide powerful functionality behind simple interfaces. A module with a 5-method interface that handles 15 edge cases internally is better than a module with a 15-method interface that pushes edge cases to callers. AI agents default to creating pass-through wrappers — the brief must explicitly say "absorb complexity, don't redistribute it."

**Gate signal:** If a new module has more exported functions than internal functions, it's likely shallow. WARN if exports > 5 for a single module file.

### Boundary validation with Zod

Validate at system boundaries (user input, API responses, config files, external data) using Zod schemas. Internal function calls between trusted modules do NOT need runtime validation — TypeScript types handle that. The boundary is where untrusted data enters the system.

**Template explains:** "Boundary = where data crosses a trust line. HTTP request body: boundary. Function arg from your own module: not boundary. Config file read from disk: boundary. Object passed between your functions: not boundary."

### Exhaustive matching (assertNever)

Every switch/case on a union type must have a default branch that calls `assertNever(x)` — a function that accepts `never` and throws. This catches unhandled variants at compile time when new variants are added. Without it, new enum values silently fall through.

```typescript
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}
```

### Immutability by default

Use `readonly` arrays and objects. Use `as const` for literal types. Mutate only when performance requires it and document why. AI agents frequently introduce mutation bugs because they copy patterns without understanding ownership semantics.

### Branded types for domain values

IDs, slugs, paths, and other stringly-typed values should use branded types to prevent accidental interchange:

```typescript
type IssueId = number & { readonly __brand: "IssueId" };
type SlugId = string & { readonly __brand: "SlugId" };
```

### Error handling: fail loud at boundaries, propagate inside

At boundaries: catch, log, return structured error. Inside modules: let errors propagate — don't catch-and-rethrow with less information. Never swallow errors silently. Never use empty catch blocks.

### One export per concern

Each file exports one primary thing. Utility files with 10+ exports are a code smell. If a file has unrelated exports, split it. The test for "related": could you rename the file to describe all exports in 3 words?

### Context loading architecture (D-23)

Anthropic's Claude Code architecture confirms the routing table approach:

1. **CLAUDE.md** — always loaded for every non-fork subagent automatically. Project rules, conventions, bridge to AGENTS.md
2. **AGENTS.md** — loaded via CLAUDE.md bridge. Routing table telling agents WHERE to find methodology docs
3. **Skills** — loaded on demand. Methodology files (coding principles, testing strategy, RCA protocol). Can be preloaded per agent type via frontmatter `skills` field
4. **Agent definition frontmatter** — `skills: [skill-name]` preloads specific skills for specific agent types
5. **Brief/task message** — task-specific instructions + pointers to skills/docs. Stays small (~35 lines L3)

Templates are condensed reference cards (~20-30 lines each), not full spec sections. Agent reads the card, follows the steps. Full rationale lives in the spec. Context budget: heaviest agent (Marcus bug-fix) uses ~314 lines / 3.1% of 200k context window. Full 5-agent cycle uses 11.1%.

## Testing Strategy (shipped with harness as `prompts/testing-strategy.md`)

AI-generated tests have 91% line coverage but only 34% mutation score — they test the implementation, not the behavior. The testing pyramid INVERTS for AI code: property-based > contract > integration > unit.

### Testing pyramid for AI-authored code

Traditional pyramid (unit > integration > e2e) assumes humans write focused units. AI agents write sprawling functions that pass unit tests trivially. The effective pyramid:

1. **Property-based testing (PBT)** — highest value. Define invariants ("output is always sorted", "length never negative", "round-trip encode/decode is identity"). Anthropic's own research found 984 bugs across 100 packages using PBT. 56% were true bugs.
2. **Contract tests** — verify module boundaries. Consumer-driven: the consumer defines what it expects, the provider proves it delivers. Catches the integration seam where AI agents create the most bugs.
3. **Integration tests** — test real data flow through real dependencies. No mocks for databases, APIs, file systems unless the real thing is genuinely unavailable. Mocked tests pass; prod breaks.
4. **Unit tests** — lowest priority for AI code. Still valuable for pure functions with complex logic. But an AI agent writing unit tests for its own code is the tautological testing trap — testing WHAT it built, not WHETHER what it built is correct.

### Tautological testing trap

AI writes implementation → AI writes test for that implementation → test passes → but the test only verifies the code does what the code does, not what the SPEC says. The test is a tautology.

**Mitigation:** Writer and verifier must be separate agents (SC-66). Marcus writes code + tests. Quinn verifies behavior. Gate checks that test assertions reference AC thresholds, not implementation details.

### Consumer-driven contract tests

When module A depends on module B: A defines a contract ("I expect B.get(id) to return `{name: string, active: boolean}`"). B's test suite includes A's contract as a test case. If B changes its return type, A's contract test fails BEFORE the integration breaks.

**Gate signal:** If a module has >3 importers and no contract test, WARN.

### Mutation testing as quality signal

Coverage % measures lines executed, not behavior verified. Mutation testing modifies code (change `>` to `>=`, remove a line, swap a constant) and checks if tests catch the mutation. Kill rate = test quality.

**Harness integration:** Future work (see Evaluated Concerns). Current minimum viable: test count comparison at verify gate. Mutation testing adds ~10min per run — evaluate when CI pipeline is mature.

### Boundary testing (horizontal and vertical)

- **Horizontal:** test at module boundaries — the interface between modules. What happens when module A passes unexpected data to module B?
- **Vertical:** test at layer boundaries — HTTP → service → database. What happens when the database returns unexpected data?

AI agents test the happy path vertically (request → response works). They skip horizontal boundaries (what if the service returns null? what if the type is wrong?).

**Template instruction:** "After every golden path test, write one boundary test: null input, empty array, type mismatch, concurrent access."

### Test evidence requirements per AC type

| AC Type | Minimum test evidence | Why |
|---------|----------------------|-----|
| CODE | Bun test output showing pass + assertion count | Mechanical proof |
| UI | Quinn journey PASS + screenshot on FAIL | Functional + visual |
| BUG-FIX | Regression test (fails without fix, passes with) + negative control | Proves fix, not coincidence |
| OUTCOME | Live execution output showing expected state | Can't unit-test outcomes |
| ANTI | Grep/test proving the anti-pattern is absent | Absence proof |

## Research and Escalation

Agents must know they have research tools and WHEN to use them. The #1 failure pattern is an agent iterating 5 times on the wrong approach instead of stopping to research. The circuit breaker (3 iterations max) should trigger research, not just stop.

### Available research tools (declared in AGENTS.md and agent briefs)

| Tool | What it does | When to use |
|------|-------------|------------|
| Context7 MCP | Fetches current documentation for any library, framework, SDK, API | Unknown API behavior, version-specific syntax, framework patterns |
| WebSearch | Searches the web for current information | Error messages, unfamiliar patterns, "how does X work" |
| Council workflow | Multi-perspective debate with parallel agents | Architecture decisions, tradeoff analysis, design disagreements |
| Research skill | Parallel multi-source investigation | Complex unknowns, multi-faceted questions, API investigation |
| Explore agent | Fast read-only codebase search | "Where is X defined", "which files reference Y" |

### Escalation decision tree (embedded in every agent brief)

```
STUCK? (same error on iteration 2, or no progress after iteration 1)

1. Is it a library/framework question?
   → YES → Use Context7 MCP: query the library docs
   → Got answer? → Apply it
   → No answer? → WebSearch for the error/pattern

2. Is it a codebase question? (where is X, how does Y work here)
   → YES → Spawn Explore agent with specific search query
   → Found it? → Apply it
   → Not found? → The code may not exist yet — check with DA

3. Is it a design question? (should we do A or B)
   → YES → Escalate to DA — don't make architecture decisions alone
   → DA may invoke Council for multi-perspective analysis

4. Is it an unknown API or external system?
   → YES → Use Research skill for parallel investigation
   → Don't guess API behavior — verify it

5. Still stuck after research?
   → STOP. Report what you tried, what you found, and what's blocking.
   → Don't iterate further — the problem needs human input.
```

### Circuit breaker → research escalation

```
Iteration 1:   Normal implementation
Iteration 2:   If same error → MUST research before trying again
Iteration 3:   STOP — report what you tried, what you researched, what's blocking
```

Three iterations, not five. The research is clear: failure trajectories are 12-82% longer than successful ones (SWE-bench taxonomy study). CMU found 3-7 turns is optimal — more turns often degrades quality. Five iterations down a hole is four too many.

The research requirement at iteration 2 is mechanical — if the same error occurs twice, the gate checks that a research tool was invoked before iteration 3. Without research evidence, the agent is repeating the same mistake and must stop.

**Why 3 not 5:**
- If you haven't solved it in 2 attempts + research, you're missing something fundamental
- Each additional iteration increases vulnerability count 37.6% (IEEE-ISTAS 2025)
- Stopping early preserves context window for the DA to diagnose
- The DA can invoke council, research skill, or re-scope — options the agent doesn't have

### What goes in rungate.json

```json
{
  "research": {
    "context7": true,
    "webSearch": true,
    "council": true,
    "explore": true
  }
}
```

These flags tell the brief-assembler which research tools to include in agent briefs. If a tool isn't available (MCP server not configured), the flag is false and the brief omits it. Agents only see tools they can actually use.

### What goes in AGENTS.md

```markdown
## Research Tools

When stuck (2+ iterations without progress), use these before continuing:

| Need | Tool | Example |
|------|------|---------|
| Library docs | Context7 MCP | `resolve-library-id` → `query-docs` for Hono, Zod, etc. |
| Error diagnosis | WebSearch | Search exact error message |
| Architecture decision | Council | Escalate to DA for council debate |
| Find code | Explore agent | "Where is the auth middleware defined?" |
```

## AC Format Standard

Every acceptance criterion uses a structured format with an executable oracle. Prose descriptions are not ACs — they're wishes.

### AC ID scheme

- IDs are per-issue: AC-1, AC-2, AC-3 within each issue
- Anti-criteria (must NOT happen) use: AC-A1, AC-A2
- IDs are stable — once assigned, never renumbered even if ACs are removed
- Each test must annotate which AC it covers: `// covers: AC-1`
- Gate checks: every AC has at least one test. Untested AC = WARN

### Required fields per AC

```
AC-NNN: [title]
  Given: [precondition with specific values — not "valid input" but "email=test@x.com"]
  When: [exact action — HTTP method + path, CLI command, or UI action]
  Then: [exact expected output with threshold — status code, value, element state]
  Verify: [executable command that returns pass/fail — the oracle]
  Not: [explicit exclusions — what this AC does NOT cover]
  Assumption: [what would break if this AC's protection is bypassed — powers mutation testing]
  Evidence-tier: [minimum S/A/B/C required for this AC type]
```

### Anti-criteria format (must NOT happen)

```
AC-A1: [title — negative assertion]
  Given: [precondition]
  When: [action that SHOULD NOT produce a result]
  Then: [expected ABSENCE — no output, no file, no element]
  Verify: [command that returns pass if the thing does NOT exist]
  Not: [what this anti-criterion doesn't cover]
```

Anti-criteria catch removal and deletion requirements. Agents have 71.7% deletion recall — they often retain code that should be removed. Explicit anti-criteria force verification of absence.

### Four-question checklist (every AC must answer all four)

1. **Trigger** — what action/input produces the behavior?
2. **Output** — what observable result confirms success?
3. **Verification** — what command proves it? (executable, not prose)
4. **Exclusions** — what is explicitly NOT in scope?

### Garbage test

Every AC is tested: "Could garbage data satisfy this criterion?" If yes, tighten until the answer is no. Examples:
- BAD: "Page loads successfully" → any 200 passes, even error pages
- GOOD: "GET /dashboard → 200, body contains heading 'Dashboard' + user menu shows 'jason@...'"
- BAD: "Handles errors gracefully" → unfalsifiable
- GOOD: "POST /api/login with wrong password → 401, body = `{error: 'invalid_credentials'}`"

### AC type classification

| AC Type | When | Evidence-tier minimum | Verification pattern |
|---------|------|----------------------|---------------------|
| CODE | Logic, data, API behavior | A (execution) | bun test, curl, CLI command |
| UI | Visual state, layout, interaction | B (behavioral) | browser_snapshot assertion |
| OUTCOME | End-to-end user flow | A (execution) | Full flow reproduction |
| BUG-FIX | Regression from reported issue | S (dual-arm) | Fails before fix, passes after |
| ANTI | Must NOT exist/happen | A (execution) | grep/test confirms absence |

### Examples per type

**CODE:**
```
AC-1: Login returns JWT on valid credentials
  Given: user exists with email="test@x.com", pass is "correct-pw"
  When: POST /api/auth/login with {email, pass}
  Then: 200, body contains JWT with exp > now + 3600
  Verify: curl -s -X POST localhost:${DEV_API}/api/auth/login -d '{"email":"test@x.com","pass":"correct-pw"}' | jq -e '.token'
  Not: No OAuth, no SSO, no MFA in this AC
  Assumption: If JWT validation is bypassed, auth is broken
  Evidence-tier: A
```

**UI:**
```
AC-2: Dashboard shows user name after login
  Given: user logged in as "jason@example.com"
  When: navigate to /dashboard
  Then: heading 'Dashboard' visible, user menu shows "jason@example.com"
  Verify: browser_snapshot() → assert heading 'Dashboard' + text 'jason@example.com'
  Not: No dashboard data accuracy in this AC — just presence
  Evidence-tier: B
```

**BUG-FIX:**
```
AC-3: EOL date shows 2027-09, not 2025-06
  Given: OCP Virt product in dashboard
  When: GET /api/dashboard
  Then: eolDate field = "2027-09"
  Verify: curl localhost:${DEV_API}/api/dashboard | jq -e '.products[] | select(.name=="OCP Virt") | .eolDate == "2027-09"'
  Not: Other product dates not in scope
  Assumption: If eol-dates.ts is reverted, this date returns to 2025-06
  Evidence-tier: S (must fail before fix, pass after, fail on revert)
```

**ANTI:**
```
AC-A1: Legacy signals object no longer used
  Given: codebase after registry migration
  When: grep for signals.intelligence, signals.accountPlan, signals.cases
  Then: zero matches
  Verify: grep -rn "signals\.\(intelligence\|accountPlan\|cases\)" src/ | wc -l → 0
  Not: registrySignals usage is expected and correct
  Evidence-tier: A
```

### Where ACs live

1. **Canonical source:** GitHub issue body (structured in Success Criteria section)
2. **Parsed into:** workflow-state.json `acs[]` array at DISCOVERY phase
3. **Filled into:** per-agent brief templates by brief-assembler
4. **Verified by:** gate runner at ship gate (each AC has evidence + verdict)

The brief-assembler parses ACs from workflow-state.json, not from the issue body directly. The DA writes structured ACs during DISCOVERY and stores them in workflow-state.json. This is the canonical machine-readable format that all downstream steps read.

## Evidence Hierarchy

Evidence is scored by discriminating power — how well it distinguishes correct from incorrect implementation.

| Tier | Type | Example | Gate rule |
|------|------|---------|-----------|
| S | Dual-arm (fails before, passes after + negative control) | Reproduce bug → fix → verify pass → revert → verify fails again | Required for BUG-FIX ACs |
| A | Execution-based (test output, API response) | `bun test` output: "24 pass 0 fail" | Required for CODE ACs |
| B | Behavioral observation (a11y snapshot assertion) | browser_snapshot shows heading 'Dashboard' with correct values | Required for UI ACs |
| C | Static analysis (typecheck, lint, format) | `bunx tsc --noEmit` exits 0 | Supplementary — never sole evidence |
| D | Structural grep (string presence) | `grep -c "function validateInput" src/auth.ts` returns 1 | Max 25% of total evidence (existing ratio check) |
| F | Self-attestation ("I verified it works") | Agent prose without command output | Always FAIL — zero evidentiary value |

### Evidence-to-tier mapping

The gate classifies evidence by its `evidenceMethod.type` field in workflow-state.json:

| evidenceMethod.type | Tier | Notes |
|---------------------|------|-------|
| `BUN_TEST` | A | Execution-based test output |
| `curl`, `CLI`, `command` | A | Direct command execution |
| `browser_snapshot` | B | A11y tree assertion (requires typed assertion, not just snapshot) |
| `screenshot` | B only if assertion present | Without assertion → F (self-attestation) |
| `tsc`, `lint`, `format` | C | Static analysis — never sole evidence |
| `grep` | D | Structural presence check |
| `prose`, `manual`, none | F | Self-attestation — always FAIL |

For BUG-FIX ACs, tier S requires BOTH: `evidenceMethod.type` returns PASS AND `proofOfFix.negativeControl` exists and shows FAIL on revert.

### Gate enforcement

- Each AC's evidence is scored against its type's minimum tier (see AC type classification)
- OUTCOME ACs: tier A for new features, tier S for bug-fix outcomes
- Overall evidence portfolio: tier D evidence capped at 25% (existing `evidence-type-ratio` check)
- Tier C only: if ALL evidence for an AC is tier C (static analysis only) → FAIL "static analysis alone is insufficient"
- Self-attestation (tier F) in any AC = automatic FAIL regardless of other evidence
- Evidence without assertion = tier F (screenshot taken but nothing checked = self-attestation)

### Test deletion prevention

- Scope gate captures test count (pass + fail)
- Verify gate compares: `post_test_count ≥ pre_test_count`
- Test count DECREASE = FAIL with message "Tests removed — verify no gaming"
- This catches the documented anti-pattern of agents deleting failing tests
