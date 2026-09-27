---
doc-type: research
status: active
owner: jason
created: 2026-09-27
updated: 2026-09-27
governs: Agent Teams evaluation — experimental Claude Code feature for native multi-agent coordination
---

# Claude Code Agent Teams Evaluation

Deep evaluation of Claude Code's experimental Agent Teams feature for replacing manual council/parallel-agent coordination in RunGate.

## 1. Activation and Setup

### Environment Configuration

Enable Agent Teams by setting the environment variable:

```
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Setup steps:

1. **Set env var** -- Add `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to your shell profile or `.env` file. This activates the experimental Agent Teams runtime.
2. **Agent definitions** -- Existing `.claude/agents/*.md` files are used as teammate definitions. No separate teammate format is required.
3. **Team directory structure** -- Teams use `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` for inter-agent messaging.
4. **Display modes** -- Configure display via `--display` flag: `in-process` (default, shared terminal), `tmux` (separate panes), `iterm2` (separate tabs).
5. **Cache tuning** -- Set `subagentPromptCacheTtl: "1h"` in settings to extend prompt cache for teammates, reducing repeated tokenization cost.

### Settings Integration

In `.claude/settings.json`, no additional permission entries are needed beyond what agents already use. The environment variable is the sole activation gate. RunGate's current settings structure is compatible:

```json
{
  "permissions": {
    "allow": ["Bash(bun *)", "Bash(git *)", ...]
  }
}
```

Teammates inherit the permission set from the parent session.

## 2. Agent Definition Compatibility Analysis

### Current Agent Definition Fields

RunGate agents are defined in two places: `.claude/agents/{name}.md` (brief files) and `.claude/rungate.json` (role config). The compatibility analysis examines how these map to teammate definitions.

#### Marcus (Principal Engineer)

| Field | Current Value | Teammate Compatibility |
|-------|--------------|----------------------|
| `name` | marcus | Direct match -- used as teammate address |
| `description` | Principal engineer -- implements code changes with TDD | Maps to teammate description |
| `tools` | Bash, Read, Write, Edit | Teammates inherit parent tools; tool restriction requires runtime gating |
| `model` | sonnet | Teammate model selection supported |
| `tiers.reinforcement` | Testing Rules | No native equivalent -- must be injected via brief content |
| `tiers.mechanical` | Workflow | No native equivalent -- must be enforced by hooks |
| `isolation` | worktree | Teammates get independent context windows but share filesystem; worktree isolation must be managed externally |

#### Quinn (QA Engineer)

| Field | Current Value | Teammate Compatibility |
|-------|--------------|----------------------|
| `name` | quinn | Direct match |
| `description` | QA engineer -- tests as a brand-new user | Maps to teammate description |
| `tools` | Bash, Read, mcp__playwright__* | MCP tools available to teammates if server is connected |
| `model` | sonnet | Supported |
| `tiers.reinforcement` | Project Type Detection, CLI Testing Mode | No native equivalent |
| `isolation` | worktree | Same filesystem concern as Marcus |

#### Discovery (Read-only Analysis)

| Field | Current Value | Teammate Compatibility |
|-------|--------------|----------------------|
| `name` | discovery | Direct match |
| `description` | Discovery agent -- reads issue, sizes work | Maps to teammate description |
| `tools` | Bash, Read | Subset of available tools -- no write restriction mechanism |
| `model` | sonnet | Supported |
| `tiers.reinforcement` | Discovery Rules | No native equivalent |
| `isolation` | none (read-only) | Teammates always have write access; read-only enforcement is brief-level only |

### Compatibility Gaps

1. **Tool restriction** -- RunGate assigns specific tool subsets per role (e.g., Discovery gets only Bash+Read). Agent Teams teammates inherit all parent tools. Tool restriction must be enforced via brief instructions, not runtime gating.

2. **Reinforcement tiers** -- RunGate's `tiers.reinforcement` and `tiers.mechanical` provide structured rule injection at different prompt positions. Agent Teams has no equivalent mechanism; rules must be embedded in the brief markdown.

3. **Isolation model** -- RunGate uses `isolation: "worktree"` to give agents separate git working copies. Agent Teams provides separate context windows but shares the filesystem. Worktree creation/cleanup must be managed by the orchestrator or hooks.

4. **Role-specific schemas** -- `ship.js` enforces structured output schemas per agent role (BUILD_RESULT_SCHEMA, GATE_RESULT_SCHEMA). Agent Teams does not enforce output schemas between teammates.

5. **Sequential ordering** -- `ship.js` enforces strict phase ordering (GOAL -> DISCOVERY -> SCOPE -> BUILD). Agent Teams uses a shared task list where teammates self-select work. Phase ordering requires explicit task dependencies.

## 3. TeammateIdle Hook Evaluation

### Hook Behavior

The `TeammateIdle` hook fires when a teammate has no active tasks and would otherwise go idle. This creates an enforcement point for re-verification before the teammate stops working.

**Exit code behavior:**
- Exit code 0: Allow teammate to go idle
- Exit code 2: Block idle, force teammate to continue (re-verification)
- Non-zero (other): Log error, allow idle

### Re-verification Enforcement Pattern

```
TeammateIdle fires → hook checks:
  1. Are all assigned ACs verified? (read workflow-state.json)
  2. Did the test suite pass? (check last test output)
  3. Are there uncommitted changes? (git status)
  If any check fails → exit 2 → teammate must address gaps
  If all pass → exit 0 → teammate can idle
```

### RunGate Integration Points

The TeammateIdle hook maps to RunGate's existing quality gate pattern in `TaskCompleted.hook.ts`:

- **Current pattern**: `runAllCompletionChecks()` blocks task completion via exit code 2
- **TeammateIdle equivalent**: Same checks, but fires before idle rather than before completion
- **Advantage**: Catches gaps earlier -- a teammate that finishes its assigned task but has failing tests gets blocked before going idle, not after attempting to mark done
- **Integration**: `lib/task-completion-checks.ts` can be reused directly; the hook is a thin wrapper calling the same library function

### Limitations

- TeammateIdle fires per-teammate, not per-team. A teammate can pass its own checks while the overall pipeline is broken.
- No mechanism to force a teammate to pick up a specific task -- it can only block idling, not direct work.

## 4. TaskCreated and TaskCompleted Hook Evaluation

### TaskCreated Hook

The `TaskCreated` hook fires when a new task is created in the shared task list.

**Quality gate pattern:**
- Exit code 0: Allow task creation
- Exit code 2: Block task creation (reject the task)

**Conformity integration:**
- Validate that created tasks reference valid SCs from the governing spec
- Reject tasks that would modify files outside the agent's file-claim manifest (PARALLEL-AGENT-COORDINATION-SPEC SC-412)
- Enforce naming conventions and required metadata (AC IDs, evidence methods)

**RunGate mapping:** This is a new enforcement point RunGate does not have today. Currently, task validation happens at discovery time inside `ship.js` via the DISCOVERY_SCHEMA. Moving it to a hook makes it agent-agnostic.

### TaskCompleted Hook

The `TaskCompleted` hook fires when a teammate marks a task as complete.

**Quality gate pattern (already implemented in RunGate):**
- Exit code 0: Allow completion
- Exit code 2: Block completion

**Current implementation** (`hooks/TaskCompleted.hook.ts`):
```
TaskCompleted fires → runAllCompletionChecks():
  - Test suite must pass (no new failures)
  - Warns on uncommitted changes
  - Runs conformity checks if rungate.json exists
  Block if checks fail (exit 2)
```

**Agent Teams enhancement:**
- In the current model, TaskCompleted fires once when the orchestrator agent finishes. With Agent Teams, it fires per-teammate per-task, giving finer-grained quality control.
- Each teammate's task completion is independently gated, preventing partial work from being marked done.
- The existing `lib/task-completion-checks.ts` module works without modification -- it checks project-level state (tests, git), not agent-specific state.

### Combined Pattern

```
TaskCreated: validate scope + file claims + AC references
  ↓
Teammate works on task
  ↓
TaskCompleted: run quality gates (tests, conformity, git status)
  ↓
TeammateIdle: re-verify before allowing idle
```

This three-hook chain provides mechanical enforcement at every lifecycle stage, replacing the programmatic checks in `ship.js` phases.

## 5. Messaging Model: SendMessage vs Orchestrator

### Current Orchestrator Pattern (ship.js)

The current `ship.js` workflow (1,325 lines) uses a centralized orchestrator pattern:

```
Orchestrator (DA) calls agent() sequentially:
  agent("read issue...") → goalData
  briefedAgent("run discovery...", {role: 'discovery'}) → discoveryData
  briefedAgent("implement...", {role: 'marcus'}) → buildResult
  briefedAgent("validate...", {role: 'quinn'}) → quinnResult
```

**Characteristics:**
- **Central control**: Orchestrator holds all state, decides what runs next
- **Sequential by default**: Each agent call blocks until completion
- **Data passing via return values**: `goalData` feeds into discovery prompt, discovery feeds into marcus prompt
- **Self-heal loops**: Orchestrator retries failed gates with heal context
- **Schema enforcement**: Each agent call has a JSON schema for structured output
- **Context injection**: `briefedAgent()` loads role briefs, reinforcement rules, and file excerpts into the prompt

### Agent Teams SendMessage Pattern

With Agent Teams, agents communicate directly via `SendMessage({to: "marcus", message: "..."})`:

```
Teammates share a task list:
  Task 1: "Read issue #582" → assigned to discovery
  Task 2: "Implement AC-1 through AC-4" → assigned to marcus
  Task 3: "Validate marcus's changes" → assigned to quinn

Direct messaging for coordination:
  discovery → SendMessage({to: "marcus", message: "ACs ready, files: [...]"})
  marcus → SendMessage({to: "quinn", message: "Implementation done, branch: 582-..."})
  quinn → SendMessage({to: "marcus", message: "Test failures in X, fix needed"})
```

### Orchestrator Comparison: Tradeoffs

| Dimension | ship.js Orchestrator | Agent Teams SendMessage |
|-----------|---------------------|------------------------|
| **Control flow** | Centralized, explicit phase ordering | Decentralized, task-list driven |
| **State management** | Single context window holds all state | Distributed across teammate contexts |
| **Error handling** | Programmatic retry loops with classification | Each teammate handles own errors; no central heal loop |
| **Data passing** | Return values + schema validation | Free-text messages between teammates |
| **Parallelism** | Manual (batched agent() calls) | Native (teammates work concurrently) |
| **Debuggability** | Single transcript, clear sequence | Multiple transcripts, harder to trace causality |
| **Lines of code** | 1,325 lines of orchestration logic | Near-zero orchestration code; logic lives in briefs |
| **Flexibility** | Rigid phase order, well-tested | Flexible but requires discipline in briefs |
| **Schema enforcement** | Built-in via agent() schema param | No native inter-teammate schema validation |
| **Phase gating** | Gates run between phases programmatically | Gates must be triggered by hooks or teammate initiative |

### Recommendation

The orchestrator pattern provides stronger guarantees for RunGate's quality-gated pipeline. Agent Teams messaging is better suited for exploratory or collaborative work (council debates, architecture discussions) where strict ordering is less important. A hybrid approach is optimal: use the orchestrator for the critical path (GOAL -> SHIP), use Agent Teams for parallelizable sub-tasks within a phase (e.g., multiple agents implementing independent ACs simultaneously).

## 6. Cost Analysis

### Current Pipeline Baseline

From PROJECT-STATE.md pipeline results:

| Run | Agents | Duration | Compliance |
|-----|--------|----------|------------|
| #593 | 24 agents | 30m | 28% |
| #581 | 17 agents | 18m | 80% |
| #580 | 17 agents | 15.5m | 80% |

Current cost model: agents are spawned sequentially by the orchestrator. Each agent() call creates a new context window, but only one is active at a time (except for batched calls). Token cost scales linearly with agent count.

### Agent Teams Token Cost Impact

Agent Teams uses a 3-5x token cost multiplier compared to sequential orchestration:

**Why 3-5x:**
1. **Independent context windows** -- Each teammate maintains its own full context window. In the orchestrator model, a single DA context carries forward state. With teams, each teammate loads its own brief, project context, and file contents independently.
2. **Message overhead** -- SendMessage content is tokenized in both sender and receiver contexts (double-counted).
3. **Idle context cost** -- Teammates waiting for dependencies still hold open context windows, consuming prompt cache tokens.
4. **Redundant file reads** -- Without the orchestrator's context injection (`briefedAgent` with `contextExcerpts`), each teammate reads the same files independently.

**Per-agent context window estimates:**

| Agent | Current (orchestrator) | Teams (independent) |
|-------|----------------------|---------------------|
| Discovery | ~15K tokens (brief + issue + specs) | ~40K tokens (full context load) |
| Marcus | ~20K tokens (brief + ACs + context excerpts) | ~50K tokens (full context + file reads) |
| Quinn | ~10K tokens (brief + ACs + test output) | ~30K tokens (full context load) |
| Gate runner | ~5K tokens (gate script + state) | ~20K tokens (full context) |

**Pipeline cost projection:**

- Current 17-agent run: ~200K total tokens (sequential, shared context)
- Teams equivalent: ~600K-1M total tokens (parallel, independent contexts)
- At Sonnet pricing ($3/M input, $15/M output): current ~$1-2/run, teams ~$3-10/run

**Mitigation strategies:**
- `subagentPromptCacheTtl: "1h"` reduces re-tokenization for stable prompts
- Context injection via task descriptions (not file reads) reduces redundant I/O
- Fewer teammates (consolidation) has multiplicative cost savings with teams

## 7. Agent-Agnostic Architecture

<!-- BOUNDARY: agent-agnostic architecture section -->

### Generic Concepts vs Claude-Specific Implementation

RunGate's core architecture must remain agent-agnostic. The concepts that Agent Teams enables are generic coordination patterns; Claude Code is one implementation.

| Generic Concept | Claude-Specific Implementation | Agent-Agnostic Interface |
|----------------|-------------------------------|------------------------|
| Post-run grading | SubagentStop hook | `onAgentComplete(agentId, transcript): GradeResult` |
| Rule survival | PostCompact hook | `onContextLoss(): RuleSet` |
| Quality gate before done | TaskCompleted hook (exit code 2) | `beforeComplete(agentId): { allow: boolean, blockers: string[] }` |
| Inter-agent messaging | SendMessage({to, message}) | `sendMessage(from, to, payload): void` |
| Parallel coordination | Agent Teams shared task list | `taskList.assign(taskId, agentId): void` |
| Team composition | `.claude/agents/*.md` + env var | `team.addAgent(config: AgentConfig): void` |
| Idle detection | TeammateIdle hook | `onAgentIdle(agentId): IdleAction` |
| Task validation | TaskCreated hook | `beforeTaskCreate(task): { allow: boolean }` |

### Boundary Markers

**Claude-specific (adapter layer):**
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` environment variable
- `.claude/agents/*.md` file format and YAML frontmatter
- `~/.claude/teams/{team-name}/inboxes/` directory structure
- Hook exit code conventions (0=allow, 2=block)
- `subagentPromptCacheTtl` setting
- Display modes (in-process, tmux, iterm2)

**Agent-agnostic (RunGate core):**
- Spec compliance checking (SCs, conformity engine)
- Gate definitions (scope, verify, ship) and their pass/fail criteria
- Workflow state machine (GOAL -> DISCOVERY -> SCOPE -> BUILD -> VERIFY -> SHIP)
- File-claim manifests (PARALLEL-AGENT-COORDINATION-SPEC)
- Quality gate checks (`lib/task-completion-checks.ts`)
- Evidence collection and AC verification
- Brief content (roles, rules, context) -- format-agnostic

## 8. Adapter Design: Generic RunGate Coordination Model

<!-- BOUNDARY: adapter design section -->

### Generic Interface

RunGate should define a coordination model that abstracts over the execution engine. The current `ship.js` orchestrator is one adapter; Agent Teams would be another.

```typescript
// Generic coordination interface
interface CoordinationAdapter {
  // Lifecycle
  initialize(config: TeamConfig): Promise<void>
  shutdown(): Promise<void>

  // Agent management
  spawnAgent(role: string, brief: AgentBrief): Promise<AgentHandle>
  sendTask(agentId: string, task: TaskDefinition): Promise<TaskResult>
  waitForAgent(agentId: string): Promise<AgentResult>

  // Communication
  sendMessage(from: string, to: string, payload: unknown): Promise<void>
  onMessage(agentId: string, handler: MessageHandler): void

  // Quality gates
  runGate(gate: GateName, context: GateContext): Promise<GateResult>

  // Observation
  onAgentComplete(handler: (agentId: string, result: AgentResult) => void): void
  onAgentIdle(handler: (agentId: string) => IdleAction): void
}

interface AgentBrief {
  name: string
  description: string
  tools: string[]
  model: string
  reinforcementRules: string[]
  contextFiles: string[]
  isolation: 'none' | 'worktree' | 'container'
}

interface TaskDefinition {
  id: string
  acs: AcceptanceCriterion[]
  fileClaims: string[]  // from PARALLEL-AGENT-COORDINATION-SPEC
  contextExcerpts: ContextExcerpt[]
  schema?: JsonSchema  // structured output enforcement
}
```

### Adapter Implementations

**Adapter 1: Workflow Orchestrator (current)**

The existing `ship.js` pattern wrapped as a `CoordinationAdapter`:
- `spawnAgent()` maps to `briefedAgent()` with worktree isolation
- `sendTask()` maps to sequential `agent()` calls with schema enforcement
- `runGate()` maps to `runGateWithHeal()` with error classification
- `sendMessage()` is a no-op (orchestrator passes data via return values)
- `onAgentComplete()` maps to the grade/finalize phase
- Phase ordering enforced by orchestrator control flow

**Adapter 2: Agent Teams**

Claude Code Agent Teams wrapped as a `CoordinationAdapter`:
- `spawnAgent()` creates a teammate from `.claude/agents/{role}.md`
- `sendTask()` creates a task in the shared task list
- `runGate()` delegates to gate runner teammate or hook
- `sendMessage()` maps to `SendMessage({to, message})`
- `onAgentComplete()` maps to `SubagentStop` / `TaskCompleted` hooks
- `onAgentIdle()` maps to `TeammateIdle` hook
- Phase ordering enforced by task dependencies, not central control

### Migration Path

1. **Phase 1 (now)**: Keep `ship.js` orchestrator as primary adapter. Agent Teams is experimental.
2. **Phase 2 (when stable)**: Extract `CoordinationAdapter` interface from `ship.js`. Implement Agent Teams adapter for parallel sub-tasks within phases.
3. **Phase 3 (mature)**: Full Agent Teams adapter for the entire pipeline. Orchestrator becomes fallback for environments without Agent Teams support.

### Why Not Switch Now

1. **Experimental status** -- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` signals the feature is not production-ready
2. **Cost multiplier** -- 3-5x cost multiplier is significant for a pipeline that runs frequently
3. **Schema enforcement gap** -- No inter-teammate schema validation means structured handoffs between phases lose type safety
4. **Debugging difficulty** -- Multiple transcripts per run makes root-cause analysis harder (already a pain point at 17 agents)
5. **Proven orchestrator** -- Current pipeline has 100% first-attempt pass rate post-optimization; switching introduces regression risk

## 9. Findings Summary

| Finding | Impact | Recommendation |
|---------|--------|----------------|
| Agent definitions are compatible with teammate definitions | Low friction adoption | No format changes needed |
| Tool restriction gap | Medium risk -- teammates can use tools outside their role | Enforce via brief instructions + TaskCreated hook validation |
| TeammateIdle enables pre-idle verification | High value -- catches gaps earlier | Implement as thin wrapper around existing `task-completion-checks.ts` |
| TaskCreated/TaskCompleted provide per-task quality gates | High value -- finer-grained than current model | Wire into existing gate infrastructure |
| SendMessage lacks schema enforcement | High risk for structured pipelines | Keep orchestrator for critical path, teams for parallel sub-tasks |
| 3-5x token cost multiplier | High cost impact | Mitigate with cache TTL and context injection |
| Agent-agnostic interface is feasible | Architecture alignment | Define CoordinationAdapter, implement both adapters |

## References

- [Claude Code Feature Audit (2026-09-24)](2026-09-24-claude-code-feature-audit.md) -- Initial Tier 2 classification of Agent Teams
- [PARALLEL-AGENT-COORDINATION-SPEC](../../specs/PARALLEL-AGENT-COORDINATION-SPEC.md) -- File-claim manifests and wave planning
- [ship.js workflow](../../workflows/ship.js) -- Current 1,325-line orchestrator implementation
- [TaskCompleted.hook.ts](../../hooks/TaskCompleted.hook.ts) -- Existing quality gate hook pattern
