---
name: Council
description: Multi-round parallel debate with progressive transcript passing for architecture decisions and tradeoff analysis.
version: 1.1.0
doc-type: reference
status: active
owner: jason
updated: 2026-09-06
contract:
  input: "Topic string + optional context + optional governingSpec"
  gateIn: "None — /council is standalone"
  gateOut: "Synthesis with convergencePoints, recommendation, specAlignment, enforcementClassification"
  artifact: "council-synthesis.json at ~/.rungate/{slug}/"
  outputSchema: "schemas/council-synthesis.schema.json"
  telemetry: "harness-telemetry.jsonl with skill=council"
  errorRecovery:
    timeout_seconds: 600
    failure_mode: WARN
    cleanup_action: "None — council is read-only"
    resumable: false
---

# Council

Multi-round parallel debate with progressive transcript passing. Produces convergence-tested synthesis for architecture decisions, tradeoff analysis, and design reviews.

## Interface

```
/council "topic"                           — debate with research (default)
/council "topic" --noResearch              — debate without codebase/external research
/council "topic" --governingSpec PATH      — force-read a governing spec before debate
/council on 306                            — debate issue #306 with research
```

**Research is ON by default.** Phase 0 runs parallel codebase + external research agents before the debate. Use `--noResearch` only for pure opinion/tradeoff debates with no codebase context needed.

**Governing spec (#309):** When `--governingSpec` is passed, the research agent reads that spec FIRST and extracts all design decisions. Council members must align with the spec or explicitly argue for amendment. Synthesis includes `specAlignment` field.

**Invocation:** Always use `scriptPath` to get the latest version:
```
Workflow({ scriptPath: "~/.claude/workflows/council.js", args: { topic, governingSpec, ... } })
```

## Trigger conditions

- When: `/council`, "run a council", "debate this", "get multiple perspectives"
- Standalone: yes — can run at any point in the harness chain
- Chain position: lateral (any point) — does not block or advance the main chain
- Skip when: single-option decisions, trivial config changes, already-decided ADRs

## Workflow

### Step 1 — Frame the question

**The DA frames the question as a PROBLEM, not a PLAN.** This is the single highest-leverage decision in the entire council process.

Bad: "Here are 7 issues. Is this right-sized?" → council can only say "fewer" or "more"
Good: "Bash gates still run despite migration declared complete. How should we fix this?" → council proposes solutions

**Briefing rules (mandatory):**

1. **Problem, not plan.** Give the council the failure/gap/decision. Do NOT give them your proposed solution. When you hand them a plan, they evaluate. When you hand them a problem, they think. If you already have a plan, describe the PROBLEM the plan is trying to solve, not the plan itself.

2. **Code-first, not authority-first.** Include in the brief: "Positions must cite specific file:line numbers from the codebase. Do not cite Fowler, Larson, Brooks, or industry patterns as primary evidence — reason from THIS code. External patterns may support a code-grounded argument but cannot replace one." Without this, council members pattern-match against authorities instead of reading the actual code.

3. **Include a premise-challenger.** One council member must be briefed: "Your job is to argue we should NOT do this at all. What's the case for the opposite direction? What's the simplest fix that avoids the proposed work entirely? What assumptions is everyone else making that might be wrong?" This role must be explicitly assigned — without it, all members optimize within the same frame.

4. **Constrain the output toward simplicity.** Add one of: "Your recommendation must result in fewer total lines of code than exist today" or "The simplest fix wins — justify every line you add" or "What can we DELETE instead of building?" Without a simplicity constraint, councils default to adding — more checks, more enforcement, more architecture.

5. **Ask one hard question about the code.** Not "should we port convergence.sh?" but "convergence.sh is 66 lines of state machine logic. Is this logic necessary? What breaks if we delete it entirely?" Force members to evaluate whether complexity should be ported or eliminated.

6. **No plan-shaped questions.** Questions like "Is 7 issues the right number?" or "Should #307 be a dependency?" presuppose the plan structure. Instead: "What is the minimum change that prevents this failure from recurring?"

**Anti-patterns in council briefs:**
- Giving 5+ questions (council optimizes for answering questions, not solving problems)
- Including your proposed issue structure (council evaluates it instead of proposing alternatives)
- Asking "should we use X?" (binary validation, not design thinking)
- Omitting file paths (council cites abstractions instead of code)

1. Extract the core PROBLEM from user input — not the user's proposed solution
2. Identify relevant context (issue, spec, prior decisions)
3. Set round count (default: 3 rounds)

### Step 2 — Spawn parallel debaters

1. Launch 3+ agents with distinct perspectives (e.g., pragmatist, purist, operator)
2. **One agent must be a premise-challenger** — briefed to argue against the assumed direction
3. Each agent receives: problem statement, file paths to read, role brief
4. Round 1: independent analysis (no cross-pollination)

### Step 3 — Progressive rounds

1. After each round, synthesize positions
2. Pass synthesis + all transcripts to next round
3. Agents respond to each other's arguments
4. Track convergence points and persistent disagreements

### Step 4 — Synthesize

1. Identify convergence points (all agents agree)
2. Identify persistent disagreements (with each side's strongest argument)
3. Generate recommendation with confidence level
4. Classify enforcement: behavioral rule, mechanical gate, or advisory

### Step 5 — Log telemetry

Append to harness-telemetry.jsonl:
```json
{"ts":"...","skill":"council","issue":0,"check":"synthesis","result":"COMPLETE","duration_ms":120000}
```

### Artifact Output

After synthesis is complete, the council produces a structured artifact:

1. The council workflow returns a synthesis object matching `council-synthesis.schema.json`
2. Key addition from ADR-007: the `decisions[]` array with structured tracking:
   ```json
   {
     "id": "D-001",
     "statement": "Use file presence for chain detection, not env vars",
     "target": {"type": "adr", "ref": "~/.claude/PAI/ADR/ADR-007-universal-skill-contract.md", "section": "Chain Detection"},
     "disposition": "ACCEPTED",
     "correlationTags": ["chain-detection", "file-presence"],
     "phase": "Phase 2b-B"
   }
   ```
3. Every convergence point and recommendation becomes a decision entry
4. Post-council, run `decision-reconcile.sh` against the target document to verify all decisions made it into the doc

### Decision Tracking

After any council session that produces decisions targeting a specific document:

1. Save synthesis as `~/.rungate/{slug}/council-synthesis.json`
2. Run: `bash ~/.claude/scripts/decision-reconcile.sh ~/.rungate/{slug}/council-synthesis.json --target <doc-path>`
3. If MISSING count > 0: patch the document before presenting results
4. Report: "N decisions, N captured, M dropped" — the count forces accountability

### Research Mode with Performance Data

When council is invoked with `--research` or for skill improvement decisions, performance profiles from AgentGrit feed into the council context:

1. Load all performance profiles from `~/agentgrit/data/profiles/*.json`
2. Format as evidence table for council members:
   ```
   Skill Performance Profiles (last 30 days):
   | Skill  | Execs | Hit Rate | Gap Rate | Iterations | Trend     |
   | prove  | 47    | 82%      | 18%      | 1.3        | improving |
   | ship   | 89    | 95%      | 5%       | 2.1        | stable    |
   ```
3. Council members receive profiles as part of their context — decisions are data-backed
4. If no profiles exist (AgentGrit not yet producing): council proceeds without, notes data gap

### Data-Driven Contract Updates

When council recommends a skill contract change:
1. The recommendation includes the performance data that motivated it
2. Example: "prove gapRate 18% on UI issues → add screenshot SC requirement to prove contract"
3. The change is tracked as a decision with `correlationTag: "performance-driven"`
4. Post-implementation: Learn phase captures new data → profiles update → next audit verifies improvement

## Error handling

- Timeout: 600 seconds total
- Per-agent timeout: 180 seconds
- On agent timeout: proceed with available responses
- On all agents timeout: return partial synthesis with WARN
- Not resumable — re-run produces fresh debate
