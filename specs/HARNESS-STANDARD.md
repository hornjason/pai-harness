---
doc-type: reference
status: active
owner: jason
updated: 2026-10-14
testable: true
compliance: strict
created: 2026-09-20
governs: Harness workflow — the GOAL → DISCOVERY → EXECUTION → VERIFICATION loop and how skills chain
---

# PAI Agentic Harness Standard
# Version 1.0 | 2026-06-19

Every issue follows the same loop. No improvisation. Each step invokes a skill or is handled by hooks. The standard defines WHAT is invoked, WHEN, and WHAT artifact each step produces.

**Governing principle:** Determinism through architecture, not models. Every step is a skill invocation or a mechanical check — never "remember to do X."

**AFK autonomy rule:** Once the harness plan receives Jason's approval, execute autonomously with **zero `AskUserQuestion` interruptions**. The DA makes all judgment calls — approach selection, cleanup scope, agent routing, ordering. The only acceptable interruptions are: (1) a circuit breaker firing, (2) a destructive action on shared state (force push, production deploy, data deletion), (3) the final completion report. "Which option do you prefer?" mid-execution is a harness violation — the DA was hired to make those calls.

**Relationship to other docs:**
- **Algorithm v3.7.0** — orchestrates work selection and ISC decomposition. The Algorithm invokes the FULL harness starting at GOAL (not just ship). The Algorithm selects WHICH issue to work; the harness defines HOW to work it.
- **Ship SKILL.md** — implements EXECUTION and VERIFICATION. This standard wraps ship with the surrounding steps (GOAL, DISCOVERY, RESEARCH, ITERATION, FEEDBACK).
- **ADR-039** — defines convergence loop architecture. This standard operationalizes it.

---

## The Loop

```
GOAL → DISCOVERY → RESEARCH → PLANNING → EXECUTION → VERIFICATION → ITERATION → FEEDBACK
  ▲                                                                       │
  └───────────────────────── (loop back on failure) ──────────────────────┘
```

```mermaid
flowchart TD
    GOAL["0. GOAL<br/>Skill: goal<br/>Capture · decompose · garbage-test<br/>GitHub issue + checkpoint"] --> DISCOVERY

    DISCOVERY["1. DISCOVERY<br/>Built into Ship SCOPE<br/>Read: PRINCIPLES · ARCHITECTURE · PROJECT-STATE<br/>Read: checkpoint · FAILURES/<br/>Post structured comment to issue"] --> RESEARCH

    RESEARCH{"2. RESEARCH<br/>Unknowns?"}
    RESEARCH -->|Yes| RESEARCH_STEP["2a. RESOLVE<br/>Context7 MCP first (10s)<br/>Then Skill: Research<br/>Max 1 cycle per issue<br/>Findings posted to issue"]
    RESEARCH -->|No| PLANNING
    RESEARCH_STEP --> PLANNING

    PLANNING["3. PLANNING<br/>XS/S: ACs → post to issue<br/>M: Skill: grill-with-docs → ACs<br/>L: grill → to-prd → council → to-issues<br/>Marcus brief from ~/.claude/PAI/BRIEF-TEMPLATES.md"]
    PLANNING --> EXECUTION

    EXECUTION["4. EXECUTION<br/>Skill: ship BUILD step<br/>├ Route: local · remote · container<br/>├ Skill: tdd (red-green-refactor)<br/>├ Marcus builds (worktree or direct)<br/>├ Skill: simplify · fallow · architecture check<br/>└ Deploy: project CLAUDE.md command"]

    BASELINE_CHECK{"Step 0:<br/>Baseline drift >20%?"}
    EXECUTION --> BASELINE_CHECK
    BASELINE_CHECK -->|"YES — drift detected"| GOAL_AUDIT
    BASELINE_CHECK -->|"NO — baselines valid"| VERIFICATION

    VERIFICATION["5. VERIFICATION<br/>Default-FAIL — evidence required<br/>├ Every AC checked with evidence<br/>├ Full test suite (unit + integration)<br/>├ Quinn UI (if .tsx changed)<br/>├ Rook security (always — blocks on FAIL)<br/>├ Consumer contract (if consumer changed)<br/>├ Goal statement check<br/>└ Docs cascade check"]
    VERIFICATION --> RESULT

    RESULT{"All gates<br/>pass?"}
    RESULT -->|Yes| FEEDBACK
    RESULT -->|No| STUCK

    STUCK{"6. ITERATION<br/>Stuck detection"}
    STUCK -->|"Same error 3x"| GOAL_AUDIT
    STUCK -->|"Making progress"| DISCOVERY
    STUCK -->|"Budget exhausted"| STOP["STOP<br/>Checkpoint + notify"]

    GOAL_AUDIT{"Goal Audit<br/>Baseline valid?"}
    GOAL_AUDIT -->|"T1: Drift >20%<br/>T2: Entity missing<br/>T3: Research contradicts"| GOAL_RESPONSE
    GOAL_AUDIT -->|"Baselines valid"| CIRCUIT["CIRCUIT BREAK"]

    GOAL_RESPONSE{"Size-gated<br/>response"}
    GOAL_RESPONSE -->|"XS/S"| STOP
    GOAL_RESPONSE -->|"M: DA amends ACs"| DISCOVERY
    GOAL_RESPONSE -->|"L: Council reviews GOAL"| COUNCIL_GOAL["Skill: council<br/>Goal-Level Review<br/>Revise · Investigate · Abort"]
    COUNCIL_GOAL --> DISCOVERY

    CIRCUIT --> DECIDE
    DECIDE{"Decision tree"}
    DECIDE -->|"Framework issue"| CTX7["Context7 → retry"]
    DECIDE -->|"Need info"| SPAWN_RESEARCH["Skill: Research<br/>→ new issue if unresolved"]
    DECIDE -->|"1-2 attempts failed"| ESCALATE["Escalate to specialist<br/>Marcus · Quinn · Rook"]
    DECIDE -->|"Structural replan"| COUNCIL["Skill: council<br/>4 agents · 3 rounds<br/>before new direction"]

    CTX7 --> DISCOVERY
    SPAWN_RESEARCH --> DISCOVERY
    ESCALATE --> DISCOVERY
    COUNCIL --> DISCOVERY

    FEEDBACK["7. FEEDBACK<br/>├ Signal capture → ratings.jsonl<br/>├ Correction capture → memories<br/>├ Checkpoint marked complete<br/>├ Docs cascade verified<br/>├ Close issue with evidence<br/>└ Follow-ups logged to backlog"]
    FEEDBACK --> NIGHTLY

    NIGHTLY["NIGHTLY (automatic)<br/>MemoryLoop.sh @ 23:30<br/>├ RuleTracker → rule-stats.json<br/>├ LearningReview → propose rules<br/>├ GraphBuilder → knowledge graph<br/>└ RecallEvaluator → recall@5"]
    NIGHTLY --> WEEKLY

    WEEKLY["WEEKLY (DA runs)<br/>optimize-rules workflow<br/>├ Mine signals · adversarial verify<br/>├ AskUserQuestion checkboxes<br/>└ Apply approved changes"]
    WEEKLY -.->|"System learns"| DISCOVERY

    style GOAL fill:#e1f5fe
    style FEEDBACK fill:#c8e6c9
    style VERIFICATION fill:#e8f5e9
    style NIGHTLY fill:#f3e5f5
    style WEEKLY fill:#f3e5f5
    style STOP fill:#ffcdd2
    style BASELINE_CHECK fill:#e8f5e9
    style GOAL_AUDIT fill:#fff3e0
    style COUNCIL_GOAL fill:#fff3e0
    style COUNCIL fill:#fff3e0
```

---

## 0. GOAL — `Skill("goal")`

**Purpose:** Capture the goal, decompose into measurable criteria, persist to GitHub issue.

**Three entry modes:**

| Mode | Trigger | Goal skill behavior |
|---|---|---|
| **Goal, no issues** | Jason states a goal in natural language | Read project PRINCIPLES.md pre-flight questions to inform decomposition → Decompose → garbage-test each criterion → `gh issue create` |
| **Goal, issues exist** | Jason states a goal + related issues already open | `gh issue list` → map existing issues against goal → create only gap issues |
| **Issue, no goal** | Jason points at a specific issue number | Read issue → validate ACs meet garbage test → enrich if needed |

**Outputs (MANDATORY — skill does not exit without these):**
- GitHub issue with standardized body:
  ```
  ## Goal
  [Jason's words, verbatim]

  ## Success Criteria
  - [ ] SC-1: [measurable, garbage-tested]
  - [ ] SC-2: [measurable, garbage-tested]

  ## Scope Boundary
  - In: [explicit]
  - Out: [explicit]

  ## Circuit Breakers
  - Per-issue: [N iterations max]
  - Per-goal: [token/cost ceiling or "all issues closed/deferred"]

  ## Baseline Values
  - SC-1 baseline: [the quantity or entity this SC measures against] Source: [where this number comes from]
  - SC-2 baseline: [same]
  These values are the Goal Audit comparison targets. Every AC with a numeric threshold
  must state its denominator and source. M/L mandatory, XS/S optional.

  ## Related Issues
  - #N — [status] — [how it relates]
  ```
- Checkpoint written to `$RUNGATE_WORK_DIR/{slug}/CHECKPOINT.md`

**Quality bar:** Every success criterion passes the garbage test ("Could garbage data pass this?"). If yes, tighten until no. Every AC with a numeric threshold must state its denominator ("download 80% of N items where N = [source]").

**Handoff to DISCOVERY:** GitHub issue number + checkpoint path.

---

## 1. DISCOVERY — Built into Ship SCOPE

**Purpose:** Load all context needed to size and plan the work.

**Process (mechanical — same every time):**
1. Read project docs in order: PRINCIPLES.md → ARCHITECTURE.md → PROJECT-STATE.md
2. Read the GitHub issue + any linked specs/ADRs
3. Read checkpoint if resuming (`$RUNGATE_WORK_DIR/{slug}/CHECKPOINT.md`)
4. Read `MEMORY/LEARNING/FAILURES/` for prior patterns matching this domain
5. Check `gh issue list` for related open issues

**Output:** Structured GitHub issue comment posted via `gh issue comment` with:
- Answer to each quality-bar question below
- File path + line number citation for every fact
- Last-modified timestamp for every doc read
This artifact is durable — it survives context compaction and session boundaries.

**Quality bar — must answer ALL of these from docs (not memory):**
- What exists now? What needs to change? What constraints apply?
- For scraper/infrastructure work: Where does this run? What auth? What prerequisites? Where does output go?
- For UI work: Which component? What data feeds it? What consumers read it?
- If ANY answer is "I don't know" and it's not in the docs → that's a **doc gap**. Log as issue via `gh issue create` immediately. Then either fix the doc gap first or proceed with RESEARCH to find the answer.

**Critical rule:** Every fact used in PLANNING and EXECUTION must trace to a doc read during DISCOVERY — never to DA memory. If the DA "knows" something but can't point to the file and line where it's documented, it's not verified. Read the doc or flag the gap.

**Handoff to RESEARCH:** List of unknowns (if any). If no unknowns, skip to PLANNING.

**Reference:** → Ship SKILL.md "Project docs gate" for the reading order.

---

## 2. RESEARCH — Conditional

**Purpose:** Resolve unknowns before planning. Prevent spiraling.

**Gate (mechanical checks — no judgment):**
- `grep -r "api_name\|library_name" src/` returns 0 hits → external API/library not in codebase → YES
- DISCOVERY quality bar has an unanswered question → YES
- Framework/library error encountered during prior iteration → YES
- If ALL checks return NO → skip to PLANNING

**Process (strict order — Context7 first, always):**
1. **Context7 MCP** (`resolve-library-id` → `query-docs`) — 10 seconds max. Try this FIRST for any framework/library question.
2. **Only if Context7 doesn't answer** → `Skill("Research")` with specific question.
3. **Max 1 research cycle per issue.** If research doesn't resolve it, the finding becomes "we need more info" — log as a new issue, move on.

**Output:** Findings posted to GitHub issue via `gh issue comment`.

**Quality bar:** Every unknown from DISCOVERY is either resolved or logged as a separate issue. No unknowns carry forward silently.

**Handoff to PLANNING:** Resolved findings. Unresolved unknowns become new issues.

**Anti-pattern:** 2+ hours of research without resolution. If this happens, STOP — create an issue for the unknown and move to the next actionable item.

**Reference:** → Research SKILL.md for deep research workflows. Context7 MCP for framework docs.

---

## 3. PLANNING — Size-dependent skill chain

**Purpose:** Right-size the ceremony. Small work ships fast. Large work gets stress-tested.

**Size routing (determined by Ship SCOPE):**

| Size | Ceremony | Skills invoked |
|---|---|---|
| **XS/S** | Write ACs → post to issue → go to EXECUTION | None — Ship SCOPE handles inline |
| **M** | Decompose into XS/S sub-issues, stress-test approach | `Skill("grill-with-docs")` → `Skill("to-issues")` → 2-4 XS/S sub-issues → each ships through proven pipeline |
| **L** | Full planning pipeline | `Skill("grill-with-docs")` → `Skill("to-prd")` → `Skill("council")` (debate the PRD) → `Skill("to-issues")` → each sub-issue re-enters at GOAL |

**Decomposition gate (mechanical — enforced by ship.js after Discovery):**

If Discovery returns >6 ACs, the issue MUST be decomposed before implementation:
1. Read the governing spec's phase headers (`### Phase N`)
2. Group ACs by spec phase (≤6 per group)
3. Create sub-issues — one per phase, each referencing the parent issue and spec section
4. Rescope the parent issue to Phase 1 only
5. Continue shipping Phase 1; subsequent phases ship as separate `/ship N` runs

This is not a judgment call. If AC count > 6, decomposition is mandatory and automatic.

- [x] SC-503: workflows/ship.js contains [DECOMPOSE_REQUIRED, sub-issue, acs.length, MAX_ACS_PER_ISSUE = 6] — the token was `ac.length`, which the file has never contained; the limit is a named constant, so asserting the bare literal `6` would have passed on any stray 6 in a 1000-line file

**Output:**
- ACs posted to GitHub issue via `gh issue comment` (BEFORE execution starts)
- Marcus brief prepared (from ~/.claude/PAI/BRIEF-TEMPLATES.md)
- For L: sub-issues created, each with own ACs

**Quality bar:** Every AC has a declared evidence type (code presence, grep absence, screenshot, API response, test pass). Every AC passes the garbage test.

**Handoff to EXECUTION:** GitHub issue with ACs + Marcus brief.

**Reference:** → ~/.claude/skills/ship/SKILL.md for AC templates, evidence types, issue templates, garbage test table. → ~/.claude/PAI/BRIEF-TEMPLATES.md for Marcus brief format.

---

## 4. EXECUTION — `Skill("ship")` BUILD step

**Purpose:** Build the thing. TDD. Deploy.

**Process (Ship BUILD — same every time):**

**Step 0: Execution target routing (from DISCOVERY):**
Check DISCOVERY's answer to "Where does this run?":
- **Local** (laptop, this machine) → proceed to step 1 below (Marcus builds locally)
- **Remote host** (Mac Mini, server, external container) → route through `Skill("infrastructure-and-devops")`:
  1. Read project CLAUDE.md for the remote host (e.g., "SalesHub scraper runs ONLY on the Mac Mini container")
  2. Read `reference_mac_mini_ssh` memory (or equivalent) for SSH credentials — `jasonhorn@mini.local`
  3. SSH to remote host → sync code (`git pull origin main`) → rebuild container → execute the task
  4. Verify results remotely before returning to VERIFICATION
  5. DA never types raw SSH commands — always through the infrastructure skill or a standard pattern
- **Container-only** → read project CLAUDE.md for container deploy command (e.g., `make rebuild`)

**Step 1 (local builds only):**
1. `Skill("tdd")` — red-green-refactor, vertical slices (exempt: config-only, pure doc, JSON, UI copy)
2. Marcus builds — isolation mode is a mechanical check, not memory:
   - Project root under `~/.claude/`? → `isolation: "worktree"`
   - Project root elsewhere? → direct (no worktree)
3. Architecture check (M+ only) — `Skill("improve-codebase-architecture")`
4. `Skill("simplify")` — 3-agent code review on changed files
5. `npx fallow` — static analysis on changed files (unused code, circular deps, duplication, complexity). Zero-token, ~10 sec. Runs for all sizes.
5. For M/L iterative work: Marcus works on a feature branch per ADR-039 ("main branch untouched until full convergence"). XS/S may commit to main directly.
6. DA merges to main + deploy — read project CLAUDE.md for deploy command. Do not assume any specific deploy command.
7. Rollback protocol: every iteration produces one squashed commit on feature branch. Rollback = `git revert`, not `git reset`. Main branch untouched until full convergence (ADR-039 gate 5).

**The workflow never writes to the default branch (#136).** Step 6 above says the
DA merges, and ADR-039 says main is untouched until convergence. `workflows/ship.js`
was doing neither: a `merge-and-push` step in the VERIFY phase merged the work
branch into whatever branch `PROJECT_ROOT` happened to be on and ran a bare
`git push`. One run finished `SHIPPED` with its code on `main` as a direct,
non-merge commit — no pull request, no pre-merge CI. The push failed first, so the
ref actually written (`HEAD:main`) was chosen by an agent recovering from an error.

Ship pushes the work to its own branch and opens a PR. CI gates the merge there,
which is what the ship gate already assumed — `branch-merged` reads "at ship gate:
check code is pushed, not merged", with the merge verified at prove. A project that
wants direct-to-main needs an explicit, off-by-default setting; it must not be the
only path.

- [x] SC-539: workflows/ship.js not contains [git merge ${worktreeBranch}, label: 'merge-and-push'] — the auto-merge is removed, not relocated
- [x] SC-540: test/ship-never-writes-main.test.ts contains [pushCommands, every push names an explicit ref, no push names main or master] — the "every occurrence satisfies X" shape has no matcher, so the criterion names the test that evaluates it rather than restating the rule in prose nothing can check
- [x] SC-541: workflows/ship.js contains [REFUSING: on $branch, SKIPPED MERGE: checkout is on $branch] — the commit step and the prior-branch merge both refuse the default branch
- [x] SC-542: workflows/ship.js contains [const shipBranch = branchToReuse, --head ${shipBranch}] — the PR head is derived from the run, not read back out of a checkout
- [x] SC-543: lib/workflow-security.ts contains [isSafeBranchName, SAFE_BRANCH] and workflows/ship.js contains [isSafeBranchName(shipBranch)] — a branch name reaching a shell is validated, and both copies are executed against the same inputs

### A remediation round's work reaches the branch (#155)

`commitDir` is fixed by the FIRST implement pass. The verify and ship
remediation loops call `runImplement()` again — a new agent in a new worktree
— and then commit from `commitDir`, which still points at the old one. Nothing
is staged, `git commit` has nothing to commit, and the step reports the HEAD
that was already there, because its schema asked only for a string.

Measured on `wf_67f052e6-1a5` (shipping #143): three Marcus passes, 25 agents,
67 minutes, 1.19M subagent tokens, and the SHA never moved off `d6a0c358`. Both
remediation worktrees were still on disk afterwards, sitting at `origin/main`
with the work uncommitted. Rook met the same fact from the other side and filed
it as a SCOPE finding — the diff it was given was empty.

The lost work is the visible half. The dangerous half is that the retry gate
was handed the NEW worktree as its `cwd`, so it graded files that are not on
the branch and cannot be fetched. That run only avoided recording a PASS for an
unreachable tree because the remediation also failed.

Collecting into the directory that owns the branch, rather than rebasing the
new worktree onto it, is deliberate: the remediation worktree is cut from
`origin/main` and does not contain the round before it, so a replay would
conflict with the work it re-derived.

- [x] SC-555: workflows/ship.js contains [collectAgentWork, COLLECT-AGENT-WORK-START] and not contains [reimpl.buildResult?.worktreePath] — one collection implementation, and no gate is pointed at a directory whose contents are not on the branch
- [x] SC-556: workflows/ship.js contains [collect-verify-regression, collect-ship-regression] — both remediation loops collect before they commit, which is the half that was missing
- [x] SC-557: workflows/ship.js contains [parentSha, reCommit.commitSha === reCommit.parentSha] — a recommit that committed nothing is a result the workflow sees, not a string it accepts
- [x] SC-558: test/ship-remediation-commits.test.ts contains [remediationBlocks, there are exactly two of them] — the sweeps are bounded by a positive control, so a slicer that stops matching fails loudly instead of passing vacuously

Collecting into `commitDir` rather than `PROJECT_ROOT` changed where the step
can write. `PROJECT_ROOT` comes from the workflow's arguments; `commitDir` can
be a path an **agent** reported as its worktree. The first commit of #155
interpolated it raw, which is two hazards in one line — a destination outside
the repository, and `$(...)` executing. `workflows/ship.js:377` is the record
of that exact pairing shipping once before and being caught by review.

Allowlist and quoting are independent layers and neither is sufficient:
quoting a path to another project still commits another project's files, and
an allowlist that forgets to quote still executes a substitution.

- [x] SC-559: workflows/ship.js contains [collectDestination, COLLECT-DESTINATION-START] and not contains [cd ${dest}] — a destination is allowlisted and quoted, never sanitised into something that looks acceptable
- [x] SC-560: test/ship-collect-destination.test.ts contains [loadCollectDestination, new Function, shellQuote(dest)] — the validator is executed rather than grepped, because "ship.js contains collectDestination" stays true after the body is reduced to `return dir`

The collection above was wired into both loops and still discarded the work,
because what it was handed was `undefined`. `runImplement()` built
`agentResults` only on its decomposed sub-issue path; the single-Marcus path —
which is the one EVERY remediation round runs — returned a `buildResult`
without it. `results || []` then defaulted to an empty list, found no worktree
to move from, and returned `{ok: true, collected: 0}` without spawning
anything. `staged` was false, so the caller fell back to staging `commitDir`,
and `commitDir` is the first pass's worktree, where the new work is not.

Measured twice on `wf_14bb327b-5d2`: both recommit steps reported
`RUNGATE_NO_CHANGES` against an unmoved HEAD, and the best of that run's three
implementations was thrown away — recovered by hand from its worktree.

`{ok: true, collected: 0}` was serving two different situations: "there was
nothing to collect" and "I was never told what to collect". Only the first is
a success, and the second was the one actually happening. The fix is at the
source — one return shape from both of `runImplement`'s paths — and the
refusal is the other half of it, because a shape fix alone leaves the next
caller free to make the same omission silently.

"ship.js contains collectAgentWork" stayed true for the whole time the
collector was being handed `undefined`, so the criteria below are carried by a
suite that EXECUTES the collector and `runImplement` with injected
dependencies, in the manner of SC-560.

- [x] SC-571: workflows/ship.js contains [agentResults: [{, One shape for both of runImplement's paths] — runImplement's single-agent success pairs its own worktree with its own filesChanged, so a remediation round hands the collector the same shape the decomposed path does
- [x] SC-572: workflows/ship.js contains [!Array.isArray(results), a caller that cannot say what to collect is a failure] — the collector refuses a caller that did not say what to collect, while an empty list stays an ordinary success, so the two situations stop sharing one answer
- [x] SC-573: test/ship-remediation-commits.test.ts contains [loadCollectAgentWork, loadRunImplement, new Function] — the collector and runImplement are extracted and run, because a source-text assertion is exactly what failed to notice this for the length of #155

### The commit step reports its state write (#166)

The same run that found the collector defect was refused by the ship gate for
an unrelated one: `buildCommit` and `agents.marcus` were absent from
`workflow-state.json`. They were written by step 3 of a three-step commit
prompt — a `bun -e` one-liner — while the schema the agent answered with asked
only for `{branch, commitSha, pushed}`. So an agent could commit, push, answer
correctly and never run step 3, and the workflow read that as a fully
successful commit.

Intermittent rather than broken: `wf_7c91ba3a-a22` and `wf_14bb327b-5d2` both
have the fields, `wf_b5f65252-24f` does not. The run then spent a BUILD
remediation round and two ship gates failing on something no amount of
re-implementing could fix, because the missing thing was never in the code.

An instruction an agent can skip without the reply changing is not a step. The
same shape as SC-557 one phase earlier, and it was not looked for here.

The one-liner carried a second defect. `s.agents = {marcus, quinn}` is an
assignment, safe only because it ran before rook. Since SC-569, `agents.rook`
is the record of whether the security review ran, so anything re-running that
write after the Verify phase erases it and the run reaches the PR step with no
security record at all.

- [x] SC-574: scripts/record-build-commit.ts contains [REFUSE_EXIT, buildMarcusRecord] — the state write is a script with a receipt and one refusal exit code, so every argument that is not the shape it must be is refused rather than sanitised
- [x] SC-575: workflows/ship.js contains [stateRecorded, COMMIT-STATE-GUARD-START] and not contains [s.agents = {marcus] — the reply must say the write happened, the run stops at the commit step when it does not, and the agents map is merged rather than replaced
- [x] SC-576: test/record-build-commit.test.ts contains [loadGuard, an existing agents.rook survives] — the guard is extracted and executed, and the merge is proven against a state that already carries a security verdict

What was broken to prove these fail — run, counted, reverted:

| mutation | result |
|---|---|
| the guard always returns null | 2 fail |
| the call-site TEXT removed — `const stateRefusal = commitStateRefusal(commitResult)` deleted | 1 fail |
| the guard defined but not wired into the run — marked region wrapped in `if (false)`, wrapper outside the markers | **0 fail (52 pass)** before #201; **1 fail** after, re-measured 2026-10-14 for #204 |
| the recorder replaces `agents` instead of spreading it | 2 fail |
| `stateRecorded` dropped from the step's `required` list | 1 fail |
| `REFUSE_EXIT = 0` in the real source | the harness refuses to build its mutant and the file aborts |

Rows two and three were one row until #201, recorded as "the guard defined but
not wired into the run | 1 fail". That credited the test with more than it
had. Re-measured on 2026-10-08, the two halves come apart:

- Deleting the call-site text does cost 1 fail, because the test asserted on
  that exact string.
- Making the guard unreachable while leaving every character of it in place —
  wrap the `COMMIT-STATE-GUARD` region in `if (false)`, with the wrapper
  OUTSIDE the marker comments so `loadGuard`'s slice stays byte-identical —
  cost **nothing**. 52 pass, 0 fail, with the declaration never binding and
  the call below it reaching for a name that was never created. Wrapping a
  region does not change the characters inside it, so neither the `toContain`
  nor the `toMatch` noticed.

Same measurement on the two sibling suites, same day: the `BLOCKING-GRADES`
region wrapped that way left test/blocking-grades.test.ts at 19 pass / 0 fail,
and `SECURITY-DECISION` left test/security-verdict-blocks.test.ts at 113 pass
/ 0 fail — a dead compliance gate and a dead security gate, both green.

#201 closed all three with `assertMarkedBlockReachable` from
`lib/reachability.ts`, which reads the block's chain of enclosing AST nodes
rather than its text and refuses anything outside `PERMITTED_ENCLOSING`. Each
of the three suites now asserts its marked region's chain is `["Program"]`,
and record-build-commit.test.ts additionally asserts the call site's chain is
`["Program", "VariableDeclaration"]`, so both halves of "wired into the run"
are read off the parse. Re-run with the same three mutations: 1 fail each,
reverted, `git status` clean.

The first version of SC-575's test asserted only that `ship.js` contained the
string `COMMIT_STATE_NOT_RECORDED`, and reducing the branch to `if (false)`
left all 21 tests green. The mutation survived its first pass, as every
source-text assertion in this repo has.

A second trap was hit and is now a property of the test rather than a note:
the mutant must live beside the real script, because this one imports
`../gates/orchestrator`. From a temp directory that import does not resolve,
bun exits non-zero, and every mutant run reads as "the refusal was rejected on
the merits" — a mutation harness that proves nothing while reporting success.

### The last text assertion in the wiring test (#204, 2026-10-14)

#201 added the reachability read and left one assertion behind:

```ts
expect(shipSource).toMatch(/if \(stateRefusal\) \{[\s\S]{0,400}terminalFailure\('COMMIT_FAILED'/);
```

A regex over the source is exactly what the mutation that matters leaves
alone. Wrapping a region in `if (false)` does not change one character inside
it, so this stayed true of a file whose guard could not run — the same
property that made the whole row above read `0 fail (52 pass)`. It is now
read off the parse: the branch consuming the refusal must be a direct
statement of the module body, and the `COMMIT_FAILED` that ends it must be
inside that branch and inside a `return`.

`indexOf` is still used, as an **anchor** rather than an assertion. Each
anchor is checked for uniqueness before its range is handed to
`enclosingChain`, so the range is the one the author meant; every claim about
position comes from the tree. `COMMIT_FAILED` appears four times in
`workflows/ship.js`, which is why the anchor names this refusal
specifically — a check that merely found the string somewhere in the file
would be satisfied by three other branches.

- [x] SC-1459: test/record-build-commit.test.ts contains [assertMarkedBlockReachable, COMMIT-STATE-GUARD] — the third defeatable suite reads its marked region's position off the parse, and the call site's consumption of the refusal is read the same way rather than matched as text
- [x] SC-1460: test/record-build-commit.test.ts contains [the limit of the reachability claim is written down and not implied] — a conditional `return` above a marked block leaves it reachable and an unconditional one does not, both executed, so the residual gap is a pair of assertions rather than a sentence

| Mutation | Red |
|---|---|
| the marked region wrapped in `if (false)`, wrapper outside the markers | **1 of 53** — 52 pass / 0 fail before #201 |
| the branch that reads the refusal moved inside another `if` | 1 of 53 |
| the refusal branch logs instead of ending the run | 1 of 53 |
| the guard always returns null | 2 of 53 |

None is left in the tree; all were run and reverted with `git status` clean.

### What reachability still cannot catch, stated rather than implied

`assertMarkedBlockReachable` reads the PARSE. A chain of `["Program"]` means
the block is unconditional in the tree, and `precedingTerminator` additionally
rejects a block sitting after an unconditional `return` in the same statement
list. Neither can see a `return` that is conditional in the source and taken
on every real input: `if (alwaysTrue) return` above the block parses as
conditional and is dead in practice.

That residual is why the executed `loadGuard` tests are not redundant with the
reachability one. Three different claims:

| Claim | Proven by | Not proven |
|---|---|---|
| the logic refuses for the right reason | `loadGuard` + the `new Function` mutants | that anything calls it |
| the region is positioned to run | `assertMarkedBlockReachable` | that control reaches it |
| the run reaches it | a real pipeline run | — nothing in this file |

The third is measured by shipping, not by this suite. Written down here
because an unstated gap reads as coverage, which is the defect this entire
section exists about.

**On the SC numbers.** #204's body proposed SC-695 and SC-696. Both are in
use in `specs/CONFIG-DRIVEN-TESTING-SPEC.md`, allocated to the compound-clause
matcher. That is the second collision in two issues — #202 proposed
SC-660..663, all four of which are in use in this file — and both were
allocated in an issue body before #392 made `nextSCNumber` read the whole
corpus. Issues written before that change carry numbers that were never
reserved; take the next free id rather than the one the issue names.

### The commit recorder records measurements, it does not invent them (#173)

SC-574 fixed the write and left two of its values unexamined. The script does
not only record a commit: it also writes `agents.quinn` and the whole of
`environments.local`, and two of those values were constants.

`environments.local.tests` was the literal string `PASS`, written by a script
that runs no tests. The `tests-pass` check in `gates/workflow.test.ts` reads
exactly that field, and it distinguishes three states — PASS, SKIP, and not
set, which it reports. The constant turned the third into the first. Quinn's
verdict arrived from `ship.js` as the ceremony tier in disguise: PASS whenever
the tier was not LIGHT. That is PASS whenever Quinn was *supposed* to run,
including every path where the agent returned something unusable.

Both were written by assignment, so they replaced rather than merged — the
same defect SC-575 fixed one level up in `agents`, left in place one level
down. Latent while the only call site ran before Quinn and before the Verify
phase; #169 adds two that run after both, which is when a measured FAIL starts
being overwritten by a constant PASS in the artefact the ship gate reads.

The rule the fix encodes: a step may record what it measured. A FAIL already
in the file is a measurement, and a step that measured nothing does not get to
change its mind.

- [x] SC-587: scripts/record-build-commit.ts contains [#173-NO-TESTS-VERDICT] and not contains [tests: "PASS"] — the recorder writes no test verdict at all, because it runs no tests, and absent is a state `tests-pass` reports while PASS is one it believes
- [x] SC-588: scripts/record-build-commit.ts contains [PRESERVED_VERDICTS, buildLocalEnvironment] — the old token embedded a comma inside the bracket list, and the matcher splits on commas, so it searched for the fragment `...record(state.environments` which no source line contains. `environments.local` and each agent's own record are merged rather than replaced, and a verdict already recorded as FAIL is never overwritten by the commit step
- [x] SC-589: workflows/ship.js contains [QUINN-VERDICT-START, quinnVerdictFor(quinnLocalRan, quinnLocalResult)] and not contains [--quinn ${shellQuote(discovery.ceremonyTier] — the verdict handed to the recorder is the one Quinn returned, a reply that is not a verdict is FAIL rather than PASS, and the chooser is a marked function the test executes
- [x] SC-590: test/record-build-commit.test.ts contains [quinn FAIL survives, tests verdict is not invented, makeMutant] — both overwrites are named cases, and each runs against a mutant that re-introduces the overwrite, so neither assertion can hold because the script wrote nothing

What was broken to prove these fail — each run over
`test/record-build-commit.test.ts` and `test/spec-compliance.test.ts`
(83 pass, 0 fail unmutated), counted, reverted:

| mutation | result |
|---|---|
| the hardcoded test verdict put back in the recorder | 3 fail |
| `PRESERVED_VERDICTS` emptied | 2 fail |
| `environments.local` assigned instead of spread | 3 fail |
| `quinnVerdictFor` treats an unusable reply as a pass | 1 fail |
| the commit step passes the tier ternary again | 2 fail |

Two of those mutations are not described here, they are performed on every
run: `makeMutant` builds the `tests: "PASS"` and empty-`PRESERVED_VERDICTS`
copies inside the tests that assert against them, and each test asserts the
mutant *does* overwrite. A preservation test is otherwise satisfied by a
script that writes nothing at all.

The reverse of the SC-575 trap also applies and cost a run here: the doc
comment explaining the removed ternary contained the ternary, so the assertion
that `ship.js` no longer has it failed against the comment describing why.
Prose about a banned literal is the literal.

**Output:** Code committed, tests passing, deployed to test environment.

**Quality bar:** Read project CLAUDE.md for test commands. Tests pass with 0 failures. Code deployed and reachable.

**Handoff to VERIFICATION:** List of changed files + deploy confirmation.

**Reference:** → Ship SKILL.md BUILD step. → ~/.claude/PAI/BRIEF-TEMPLATES.md for Marcus brief.

---

## 5. VERIFICATION — Ship VERIFY step + agents

**Purpose:** Prove every AC is met with evidence. Default-FAIL — nothing passes without proof.

**Process (mechanical — same every time):**
0. **Baseline validity check.** For each SC with a Baseline Value, compare against the latest execution observation from structured findings on the issue. If drift exceeds 20%, SKIP AC evaluation and route to ITERATION Goal Audit gate. This prevents false PASS on wrong premises.
0.5. **Issue re-read (inherited drift check).** After receiving agent output and before writing the completion report, re-read the GitHub issue body via `gh issue view NUM`. Compare agent output against the original AC text and thresholds on the issue — not conversation memory or the brief's paraphrase. Inherited drift accumulates when the DA evaluates against a stale mental model of the ACs instead of the canonical source. This step costs 5 seconds and prevents false PASS from drift.
1. Every AC-N checked against evidence (→ ~/.claude/skills/ship/SKILL.md evidence types)
2. Full test suite: `bun test` (all tests in test/ directory)
3. Tests pass on test env — read project CLAUDE.md for test port (e.g., 7776 for DailyBriefDashboard). Do not assume port.
4. If UI change (any `.tsx` file modified) → spawn Quinn with Playwright MCP tools (browser_navigate, browser_snapshot, browser_take_screenshot)
5. Always → spawn Rook (security scan on the files git says changed). Not conditional on size and not conditional on having a UI: a CLI that shells out is the higher-risk surface, not the lower one. Gating this on ceremony tier meant rook was spawned 0 times across 3,555 workflow agents (#126, #127). Rook's scope is established from git before it is spawned, and an empty scope blocks the run — a PASS over zero files is an absent review, not a clean one (#129).
6. If consumer change (read project PRINCIPLES.md consumer list; if any changed file is in consumer list → mandatory) → Consumer 4-layer verification (→ ~/.claude/skills/ship/SKILL.md)
7. Goal statement check (→ `project_application_mission.md`)
8. Docs cascade check (→ Ship SKILL.md DURABILITY matrix)

**Output:** PASS/FAIL per AC with evidence. Completion report (→ ~/.claude/skills/ship/SKILL.md template).

**Quality bar:** ALL ACs have evidence. ALL tests pass (zero tolerance). Quinn PASS if UI. Rook PASS, always — a FAIL, an absent review, or a review whose scope could not be established all block the run and no PR is opened.

**Handoff to ITERATION:** PASS → close issue, go to FEEDBACK. FAIL → enter ITERATION.

**Reference:** → Ship SKILL.md VERIFY step. → ~/.claude/skills/ship/SKILL.md completion report template. → ~/.claude/PAI/Testing/QUINN-STANDARD.md for Quinn protocol.

### The security review can fail the run (#129)

Rook's verdict was computed, logged and graded, and read by nothing that could
stop anything. The merge decision consulted only `verifyResult`.

Measured twice on live runs before this was written. On `wf_7c91ba3a-a22` rook
returned `{"result":"FAIL"}` carrying a reproduced HIGH guard bypass; the
workflow returned `SHIPPED` and opened a PR. The verdict reached the run
summary only as a compliance grade — which measures whether rook followed its
brief, not what it found. On `wf_67f052e6-1a5` rook returned FAIL with two
HIGHs and the run stopped on an unrelated ship-gate failure; remove that and it
ships them. A third run, the one that produced this change, did it again.

A second and independent cause sat underneath. `roles.json` gives rook
`"isolation": "worktree"`, and that worktree is cut from `origin/main`, so
`git diff --name-only origin/main...HEAD` inside it is **empty**. Both runs
said so in rook's own words, and both found anything at all only because rook
reconstructed a scope on its own initiative. "Found no problems in nothing" and
"found no problems" serialise identically, so an empty scope was a PASS.

So the scope is established from git by a separate step before the reviewer is
spawned, pinned to a validated commit SHA, and an empty or unresolvable scope
exits non-zero. The verdict combines that exit code with rook's answer and
fails closed on both — a scope that could not be established cannot be mistaken
for a scope that was clean.

There is no warn-only mode and no config switch to disable the block. A gate
with an off switch is this defect one indirection out. Blocking is cheap to
reverse in practice: the work stays on `origin/<shipBranch>`, nothing is
discarded, and the run can be re-driven once the finding is addressed.

- [x] SC-566: workflows/ship.js contains [SECURITY-DECISION-START, securityVerdict.verdict !== 'PASS'] — the verdict is read at the point that decides whether the run proceeds, and anything that is not a positive PASS stops it before the PR step
- [x] SC-567: workflows/ship.js contains [rookReviewSha(commitResult.commitSha), The review scope has already been established from git] — the reviewer is pinned to a commit the workflow validated, instead of diffing the HEAD of whatever worktree it was handed
- [x] SC-568: scripts/rook-review-scope.ts contains [REFUSE_EXIT, an empty diff] — the scope comes from git in a step that exits non-zero on an empty or unresolvable scope, so emptiness is not something the agent being reviewed gets to report
- [x] SC-569: scripts/record-security-verdict.ts contains [buildRookRecord, failureList] — the run artefact records whether security ran and what it said, built from a findings file rather than from text interpolated into a command
- [x] SC-570: test/harness-standard-security.test.ts contains [carriesSizeCondition, dropNegatedConditions, the matcher still catches a real size condition] — this section's security step is asserted to carry no size qualifier, by a matcher with a positive control, so widening the negation stripper cannot make it pass vacuously

What was broken to prove these fail — run, counted, reverted:

| mutation | result |
|---|---|
| the empty-scope branch stops throwing (`if (false)`) | 3 fail |
| the fail-closed initialiser flipped to `verdict: 'PASS'` | 1 fail |
| the decision branch neutralised (`if (false)`) | 3 fail |
| `REFUSE_EXIT = 0` in the real source | the suite refuses to build its mutant and the file aborts |

The last row is the guard on the guard. Every negative scope case runs twice —
the real script and a copy with `REFUSE_EXIT` set to `0` — and asserts the real
one refuses while the copy does not. Zeroing the real constant leaves nothing
to mutate, so rather than passing quietly the harness fails loudly. Two
properties make that work and both are asserted rather than assumed:
`REFUSE_EXIT` is assigned exactly once, and the script has no relative imports,
so the mutant can run from a temp directory instead of dying on module
resolution and reading as a refusal on the merits.

### A verdict names a commit, and the commit moves (#169)

#129 gave the review a real scope and made its verdict block the run. It left
the verdict pinned to a commit the branch no longer ends at, and nothing
compared the two.

Field evidence from the #164 run: `agents.rook.testedSha` was `3fe336f1` while
the branch tip was `ef998b73`, and all four reviewed files had been rewritten
between them — 236 insertions, 254 deletions. The review ran, the verdict was
read, the verdict was PASS, and it was a PASS about code the pull request did
not contain. The #129 defect one commit out.

**A verdict is usable only while the branch tip still matches `testedSha`.**
`reviewSha` is captured once, from the commit step, before any remediation
round can move the branch, so no variable in this file notices the move.
Beside the decision that reads the verdict, `ship.js` now re-reads the commit
the branch ends at and compares it with `agents.rook.testedSha` from
`workflow-state.json`, through an inlined copy of `reviewIsCurrent`. Both
values are read at the point of comparison rather than carried: #169, #155 and
#166 are all one shape, a value captured early and consumed later as though it
still described the run.

A review that is not current returns `SHIP_FAILED` with a reason prefixed
`SECURITY_REVIEW_STALE`, on the return path the FAIL verdict already uses and
ahead of the PR step. The comparison fails closed — a missing SHA, a malformed
SHA and two different SHAs are one answer, because none of them is evidence
that what was read is what will ship. It tolerates abbreviation, because the
commit step reports `rev-parse --short` while the scope script resolves a full
SHA, and a check that refuses every run is switched off rather than obeyed.

**The check runs twice, once per remediation loop.** The first comparison sits
inside `SECURITY-DECISION-START/END`, which is reached after the review and
before the PR step, and it covers the Verify regression loop: that loop commits
upstream of the decision, and the head is re-read from git afterwards. The Ship
regression loop commits at `recommit-ship`, *after* the decision block, so for
one release it was uncovered — a Ship-round remediation moved the branch past
the reviewed commit exactly as #164 did, and nothing looked again.

`STALE-REFUSAL-START/END` is the second comparison, immediately after
`recommit-ship` and before the ship gate is retried. It reads the tip the round
just pushed — `reCommit.commitSha`, already validated one statement earlier by
`commitStateRefusal` — against the same `testedSha`, through the same inlined
`reviewIsCurrent`, and refuses the same way. Neither check is a warning. It is
the half that matters most: a remediation round exists because something
failed, which makes it where the risky code goes.

Both the refusal and its positive control are named cases in
`test/security-verdict-blocks.test.ts`, extracted from `ship.js` by marker and
executed rather than grepped for, because a block that refuses every Ship round
is switched off rather than obeyed and reads identical to a correct one in a
source-text assertion.

- [x] SC-583: workflows/ship.js contains [testedSha, HEAD, stale] — the security record is compared against the commit the run is about to open a PR for, rather than trusted because it exists
- [x] SC-584: workflows/ship.js contains [SECURITY_REVIEW_STALE] and not contains [securityVerdict.verdict === 'PASS' ? ] — a mismatch is a named refusal on the same path as every other security failure, not a warning in the log
- [x] SC-585: lib/security-verdict.ts contains [reviewIsCurrent] — the comparison lives beside `rookGateVerdict`, so the inlined copy in ship.js and the library are driven over one input matrix by `test/security-verdict-blocks.test.ts`, as #129 established
- [x] SC-586: workflows/ship.js contains [recommit, buildCommit] — `buildCommit` names the commit the PR is opened from, because a stale `buildCommit` is the same defect in the field the ship gate already reads
- [x] SC-603: workflows/ship.js contains [STALE-REFUSAL-START, reviewIsCurrent(testedSha] — the Ship regression round's new tip is compared against the reviewed commit after `recommit-ship`, not only before it, so the loop that exists because something failed is the one that is checked
- [x] SC-604: workflows/ship.js contains [shipRoundCurrency.current, shipFailed('Ship', shipRoundReason] — the Ship-round mismatch returns SHIP_FAILED on the path the Verify-side mismatch already uses, and no branch in the file turns a currency verdict into a log line the run continues past
- [x] SC-605: test/security-verdict-blocks.test.ts contains [the ship round moves the branch past the review, a ship round that changes nothing still ships] — the refusal and its positive control are both named cases over the block extracted from ship.js, so a check that refuses every Ship round fails this file

SC-598 — both remediation recommits handing the recorder `quinnLocalVerdict`
while the Ship round runs after `quinn-container` — was closed by `bd0b91b9`,
which gave the Ship recommit `quinnShipVerdict(quinnContainerRan, …)`; the
chooser is executed by `test/record-build-commit.test.ts`. It is listed here
because this section previously recorded it as open.

Also stated rather than implied: the two SHAs reach this file through an agent,
because the sandbox cannot exec or read files (#69). What that buys is a fixed
pair of commands run by a step with no stake in the verdict, not a
cryptographic boundary. The defect being fixed is systematic, not adversarial.

A spec that ticks a criterion the source does not meet is worse than one that
admits the gap. The run that produced this change did exactly that — `35f12943`
marked three SCs `[x]` whose literals were absent — and the security gate
refused it. See `.claude/rules/checks-must-be-able-to-fail.md` and #178.

---

### Re-review after a remediation round (#171)

#169 shipped the detection half and left the decision open: having found that
the branch moved past the reviewed commit, the run stopped. **The decision is
re-review**, and it is recorded here because the prediction #169 made has since
been measured.

Field evidence from run `wf_6fbfa028-14e` on #239: 87.7 minutes, 1,287,510
subagent tokens across 22 agents, and nothing merged. Rook returned PASS with
no findings, and the run died because the verify gate's self-heal loop
committed `00f21e21` — 7 files, 992 insertions, `workflows/ship.js` among them
— after the review had been pinned to `c5ebc2a4`. The self-heal loop is not a
rare path: it fires whenever the first verify attempt leaves anything to fix.
A refusal there makes the common path the failing one, and a run has to be
lucky to reach a pull request at all.

So the loop is: detect the move, review the new tip, and carry on if it passes.
`REREVIEW-LOOP-START/END` in `ship.js` holds it, immediately after the verdict
refusal and before the pull request step, and `reReviewDecision` in
`lib/security-verdict.ts` is the one function that decides what happens next.
It answers with exactly one of three words, and they are three words rather
than two because the three outcomes are three different states of the world:

- `CURRENT` — the review describes the commit the branch ends at. Nothing runs.
- `RE_REVIEW` — the tip moved and a round remains. Rook reads the diff between
  the commit the last review read and the new tip, with the reviewed commit
  passed as `--base` and the remediation commit as `--sha`. Narrowing it is
  deliberate: the finding that matters is in the code the remediation round
  wrote, and that round exists because something had already failed.
- `SECURITY_REREVIEW_EXHAUSTED` — the rounds ran out of attempts. The run ends
  holding code nobody reviewed, which is the exact thing the #129 gate exists
  to stop, so it refuses under its own name and is written into
  `workflow-state.json` as its own verdict with the round count beside it.

**Exhaustion is not a pass and it is not a finding.** `agents.rook` records it
as `verdict: "EXHAUSTED"` carrying `refusal` and `rounds` and deliberately no
`failures` list, because a findings list is how "the review found something" is
written down. Zod rejects an exhausted record that carries findings, an
exhausted record missing either field, and the refusal recorded against any
other verdict — that last one being the fail-open the pairing closes, since a
run could otherwise record the refusal honestly while parking the verdict where
every reader checking for a pass walks straight past it.

**The #169 detection half is preserved, not relaxed.** A run that never spends
a round — an unreadable budget, or a pair of values that are not both commits —
refuses as `SECURITY_REVIEW_STALE` exactly as before, and the second comparison
after `recommit-ship` is untouched. Re-review is what the run does when it CAN;
refusing is still what it does when it cannot. The cap is `MAX_SECURITY_REREVIEWS`,
set to the same number as `MAX_REGRESSIONS`, because that is how many
remediation rounds can produce new code in the first place.

- [x] SC-621: workflows/ship.js contains [REREVIEW-LOOP-START, reReviewDecision, MAX_SECURITY_REREVIEWS] — the loop is one marked, reachable region that spawns a fresh review of the new tip and is bounded by a cap declared once, rather than a second refusal under a new name
- [x] SC-622: specs/HARNESS-STANDARD.md contains [ran out of attempts, remediation round] — the decision and the measurement behind it are written down here, so the next reader finds the reasoning rather than re-deriving it from a loop
- [x] SC-623: gates/schema.ts contains [SECURITY_REREVIEW_EXHAUSTED, RookAgentSchema] — the third outcome is a schema member with its own refusal and round count, so an exhausted cycle cannot round-trip through the artefact as either of its neighbours
- [x] SC-624: test/security-verdict-blocks.test.ts contains [could not build the mutant, with the re-review removed the run still reached the PR step] — the spawn is removed from a copy of the source every run, the run is watched refusing rather than shipping, and a renamed spawn aborts the file instead of passing it

What was broken to prove it, run and counted rather than asserted, is recorded
beside SC-621..SC-624 in the mutation table in
`.claude/rules/checks-must-be-able-to-fail.md`.

---

### A run's timing measures calls, not files (#227)

The grade step reports wall-clock time per agent. It used to derive that number
by running `stat` on each `agent-*.jsonl` transcript and subtracting the file's
creation time from its modification time.

That is the FILE's lifetime, not the CALL's, and the two come apart in every
direction: a transcript flushed once at the end reads as zero seconds, one the
runtime touches afterwards reads as longer than the call, and two call sites
that share a transcript are not separable at all. Nothing downstream could tell
any of those apart from a real duration. Every `TIMING: x = Ns` line a ship run
has printed was that number.

**The artifact.** `$RUNGATE_WORK_DIR/{slug}/agent-timings.jsonl`, one JSON line
per bracket event (`{label, event, at}`), written by `scripts/record-agent-timings.ts`.
The grade step reads it with `report --artifact … --json` instead of statting
anything.

**Who writes it.** The agent being timed. `workflows/ship.js` runs in the
Workflow sandbox, which has no filesystem and no `Date.now()` — both would break
resume — so the workflow can neither read a clock nor write a file. The only
participant that can do both is the agent it spawns, which has Bash. ship.js
therefore appends a timing instruction to every prompt and routes all 39 agent
call sites through one wrapper, `timedAgent`, so no spawn can forget.

**The label is the join key, read at runtime.** Two call sites take their label
from their caller (`preserveRefusedWork`, `collectAgentWork`), so a per-site
literal would have left exactly those two untimed. `timedAgent` reads
`opts.label`.

**Order inside the prompt.** The brief read step comes first; the timing
instruction is appended last. An agent whose first instruction is bookkeeping is
an agent whose identity was displaced by it. Asserted by index comparison on the
composed string in `test/briefed-agent-model.test.ts`, not by two greps — "both
substrings present" is true in either order.

**It is lossy, and says so.** An agent that dies, is skipped, or ignores the
instruction leaves a start with no end. That is reported as `unterminated`,
never dropped: a dropped start is indistinguishable from a call that never
happened, which is the same class of defect the stat-based version had, only
quieter. `unterminated` defaults to true and is cleared only by an observed end.

- [x] SC-607: workflows/ship.js contains [AGENT-TIMING-START, TIMING_ARTIFACT, await timedAgent(] — every spawn goes through the one wrapper that brackets it
- [x] SC-608: workflows/ship.js must NOT contain [stat -f, stat -c, modified - created] — no prompt derives a duration from a file timestamp any more
- [x] SC-609: scripts/record-agent-timings.ts contains [unterminated: true, TIMING_USAGE_EXIT] — the reader fails closed on an unclosed bracket and routes every usage refusal through one exit-code constant
- [x] SC-610: test/agent-timings.test.ts contains [the only raw agent() call is the one inside the timing wrapper] — AC-1 is enforced by parsing ship.js rather than grepping it, so converting one call site of thirty-nine does not pass

#### Waiting is not working (#239)

The bracket above measures wall clock, and wall clock cannot tell a slow agent
from a blocked one. On run `wf_18abb197-f03` sub-agent 235002 spent ~22 of its
~30 minutes in `sleep 580` loops waiting out a full-suite rate budget its two
siblings had already spent; the artifact reported one number for that call and
it read as Marcus taking half an hour to think.

So a third event kind, `queued`, carries an interval the call spent waiting on
a shared limit. It is one record with its own duration rather than a second
bracket, because an agent only learns how long it waited once the wait is over
— a `queued-start` would be the one event it could never write on time. The
summarizer folds those into the open bracket for the same label and reports
`queuedSeconds` beside `workSeconds`, with the wall clock left alone.

Two fail-opens are closed by name. A `queued` record whose duration is missing
or unreadable is MALFORMED, never a zero wait: reading it as zero would make
the one record that exists to say "this call waited" report that it did not.
And `workSeconds` is not clamped — a wait longer than its own bracket means
the agent mis-measured, and a clamp to zero would dress that contradiction up
as an ordinary fast call.

- [x] SC-628: scripts/record-agent-timings.ts contains [queuedSeconds, workSeconds, "start" | "end" | "queued"] — a wait is a third event kind, and the part of a call that was work is reported apart from the wall clock it sits inside
- [x] SC-629: workflows/ship.js contains [--waited-ms, queuedSeconds] — the agent is told how to record a wait, and the grade schema declares the field, so the measurement is not stripped at the tool boundary one step before anybody reads it
- [x] SC-630: test/agent-timings-queued.test.ts contains [a queued record with no duration is malformed, not a zero wait, a wait longer than its own bracket is reported, not clamped away] — both fail-opens are asserted, not just the happy path

What was broken to prove it, run and counted rather than asserted, over
`test/agent-timings-queued.test.ts` + `test/agent-timings.test.ts`
(44 tests):

| Mutation | Red |
|---|---|
| `parseRecord` stops validating `waitedMs` | 1 |
| a wait attaches to the newest entry rather than its own label's | 1 |
| `workSeconds` set to the wall clock | 5 |

None is left in the tree; all were run and reverted. The middle one is worth
recording because it SURVIVED the first attempt: the pairing fixture wrote
the wait immediately after its own bracket's start, where "the newest entry"
and "the newest entry for this label" are the same entry, so the assertion
held vacuously. The fixture now writes A's wait after B's start. The
mutation found that, and nothing else would have.

### A run's final status says what was proved, and no more (#222)

**Nothing in this harness merges.** #136 removed the auto-merge outright, and
the ship gate's `branch-merged` check reads "at ship gate: check code is pushed,
not merged". A finished ship run has pushed its work to its own branch and
opened a PR; CI gates the merge there, and a human merges it. The strongest
claim any status `workflows/ship.js` returns can make is therefore *the gates
passed, the branch is pushed, a PR is open* — never *this is on main*.

`workflows/ship.js` ended with

```js
status: proveVerdict === 'PROVEN' ? 'SHIPPED_AND_PROVEN'
      : proveVerdict === 'SKIP'   ? 'SHIPPED'
      : 'SHIP_PASSED_PROVE_FAILED'
```

Two defects in one line. `SKIP` means prove did not run — nothing was proved —
and it produced the only unqualified success word in the system. And that word
was a strict PREFIX of `SHIPPED_AND_PROVEN`, which matters because every reader
of a ship status in this repo is a substring match:
`["DONE","SHIPPED","PROVEN"].includes(...)` in `lib/promote-outputs.ts`,
`toContain("SHIPPED")` beside `not.toContain("SHIPPED_WITH")` in
`test/ship-and-heal.test.ts`. A status that is a prefix of another is a status
that gets read as the other one. The same collision sat between `SHIPPED` and
`ALREADY_SHIPPED`, the prior-work short circuit's genuinely-complete status:
two words differing by a prefix, one meaning done and one meaning not-done-yet.

**The vocabulary.** Every status `ship.js` returns is pairwise non-prefix, and
the bare `SHIPPED` is gone.

| Prove verdict | Status | Means |
|---|---|---|
| `PROVEN` | `SHIPPED_AND_PROVEN` | gates passed, PR open, and prove demonstrated the fix |
| `SKIP` | `SHIPPED_UNPROVEN` | gates passed, PR open, prove did not run — nothing proved it |
| `UNPROVEN` | `SHIP_PASSED_PROVE_FAILED` | gates passed, PR open, prove ran and did not pass |
| anything else | `SHIPPED_UNPROVEN` | unrecognised is unmeasured, which is not clean |
| (prior-work short circuit) | `ALREADY_SHIPPED` | every AC was already MET; this run built nothing |

"Measured and did not pass" and "never measured" are different claims and keep
different words. `SKIP` is the common case on this repo — LIGHT ceremony with no
UI ACs skips prove entirely — so it is the one that most needed to stop reading
as an unqualified success.

**The check executes the map.** `test/ship-status-vocabulary.test.ts` extracts
the `PROVE-STATUS` block by marker and runs it, because every mutation that has
survived a first pass in this repo has been a source-text assertion —
"ship.js contains `SHIPPED_UNPROVEN`" stays true after the map is reduced to a
single constant. What was broken to prove it fails, run and counted: pointing
`SKIP` at `'SHIPPED'` turns 7 tests red, pointing `PROVEN` at the SKIP status
turns 5 red, and pointing the unrecognised-verdict fallback at
`'SHIPPED_AND_PROVEN'` turns 3 red. None is left in the tree; all three were run
and reverted. Two of them are also built as mutants inside the test file, from
the real block, on every run.

- [x] SC-611: workflows/ship.js contains [PROVE-STATUS-START, SHIPPED_UNPROVEN, const terminalStatus = shipStatusFor(proveVerdict, suiteReading)] — the verdict-to-status map is one named block the return calls, and a skipped prove reports an unproven status. The second argument arrived with #224: the status is capped by the suite reading as well as the prove verdict, so a passing prove cannot outrank a failing suite. The SC named the one-argument call and caught the signature change the moment it landed, which is the binding working — the code was right and this text was stale. #252 named the BINDING rather than the return site: the status is needed before the return, because the draft-readiness decision reads it, and test/ship-status-vocabulary.test.ts traces the returned value through that one binding instead of requiring it to be the call verbatim
- [x] SC-612: workflows/ship.js must NOT contain ['SHIPPED'] — the bare unqualified status literal is gone from the file, so no status it returns is a strict prefix of another
- [x] SC-613: test/ship-status-vocabulary.test.ts contains [vocabularyViolations, loadStatusFor, is a strict prefix of] — the property runs the extracted block over every verdict input rather than grepping ship.js for the words
- [x] SC-614: test/ship-status-vocabulary.test.ts contains [a mutant map where PROVEN returns the SKIP status is caught, could not build the mutant] — the break lives in the test and is re-checked every run, and a renamed map aborts the file instead of passing it

### The suite reading reaches the verdict, and the connection is proven able to break (#224)

Run `wf_7ac5f614-d21` returned `regressions: 0` on a branch whose suite ran
`3984 pass / 1 fail`. The failing test was #149's guard catching a real
regression, by name, with the file. Detection was never the gap — the signal
existed and did not reach the verdict.

`gates/workflow.test.ts`'s `tests-pass` check held the reading-to-refusal
conversion inline, spread over an `if/else if` chain, and treated an absent
`environments.local.tests` the same way the rest of the run did: as nothing to
say rather than as nothing measured. That conversion is now one exported
function, `suiteVerdictViolations`, with one body. One site is the requirement,
not a tidiness preference: a second refusal path for the same fact would
survive the mutation below and make the proof vacuous, so
`test/suite-binding-mutation.test.ts` asserts the signature appears exactly
once and aborts the file when it does not.

The fixture is run, not described. `test/suite-binding-mutation.test.ts` plants
a project containing one deliberately failing test, executes it, counts the
failure with `extractTestFailureCount` — the parser the harness itself uses —
and feeds the resulting verdict to the real check via
`bun test gates/workflow.test.ts -t tests-pass`. The verdict the gate sees is
therefore a measurement of a run, not a string the test chose. The same fixture
with the failing test repaired is the positive control, without which a check
that refuses everything would satisfy the red case.

**What was broken to prove it, run and counted rather than asserted.** Both
mutations were performed on the real source, measured over
`test/suite-binding-mutation.test.ts` + `test/gate-vacuous-checks.test.ts`
(20 tests), and reverted; neither is left in the tree.

| Mutation on `gates/workflow.test.ts` | Red | What goes red |
|---|---|---|
| `suiteVerdictViolations` short-circuited to `return []` | 3 of 20 | both fixture refusals (measured `FAIL`, and nothing measured at all) plus the mutant case, whose real-source half stops refusing |
| `suiteVerdictViolations` renamed to `suiteVerdictRefusal` | 4 of 20 | every case that builds a mutant, each throwing `could not build the mutant: the binding signature appears 0 times` — the harness aborts instead of mutating nothing |

The second row is the one that matters most. A mutation harness that silently
no-ops when its target moves is the decorative check
`.claude/rules/checks-must-be-able-to-fail.md` exists to rule out, and renaming
the function is the cheapest way for that to happen by accident. The mutant
also runs from a temp directory with its relative imports rewritten to absolute
ones, because a mutant that dies on module resolution exits non-zero and reads
as a refusal it never made.

- [x] SC-615: gates/workflow.test.ts contains [export function suiteVerdictViolations, An unmeasured suite is not a passing suite] — the suite reading is converted to a refusal at one site, and an absent reading refuses instead of passing
- [x] SC-616: test/suite-binding-mutation.test.ts contains [the deliberately failing test, extractTestFailureCount, tests-pass] — the fixture's failure is executed and counted by the harness's own parser before it reaches the check, rather than being a verdict string the test picked
- [x] SC-617: test/suite-binding-mutation.test.ts contains [could not build the mutant, the mutant ships the exact fixture the real source refuses] — the removal of the binding is performed on a copy of the source every run, and a renamed or duplicated binding aborts the file instead of passing it

### The evidence pre-validation reading reaches the verdict too (#235)

`lib/evidence-prevalidator.ts` dry-runs every AC evidence command at SCOPE and
classifies each one `ok` / `broken` / `empty` / `skipped`. It was already
correct and it was already finding things. The entire result went to
`console.error` inside a fire-and-forget `.then()` in `gates/gate-executor.ts`
and nowhere else — not to the state file, not to any gate. A run could be told
in its own log that an AC's evidence command exits non-zero and ship anyway.
The same shape as #224: detection was never the gap.

The conversion from reading to refusal is now one exported function,
`prevalidationViolations` in `gates/workflow.test.ts`, read by the
`evidence-prevalidation` check. One site is the requirement, not a tidiness
preference, for the same reason it is for `suiteVerdictViolations`: a second
refusal path for the same fact would survive the mutation below and make the
proof vacuous, so `test/suite-binding-mutation.test.ts` asserts this signature
appears exactly once and aborts when it does not.

Three readings refuse, and the difference between them is the point:

| Reading | Outcome |
|---|---|
| `{ verdict: "FAIL", broken: ["AC-2"] }` | refuses, naming `AC-2` — the refusal says what to fix |
| absent, or `{ verdict: "UNMEASURED" }` | refuses — an unmeasured pre-validation is not a clean one |
| `{ verdict: "PASS", broken: ["AC-2"] }` | refuses — a PASS carrying broken ids is a contradiction, not a pass |

The only early return is a run where no AC carries an evidence command, which
is the case the pre-validator itself classifies `skipped`: there is no command
that can be broken. That is a real early return, like `tsc-pass`'s missing
`tsconfig.json`, not a fail-open.

The fixture is dry-run, not described. `test/suite-binding-mutation.test.ts`
plants one AC whose command cannot succeed and one whose command can, runs both
through the real `prevalidateEvidence`, and derives the verdict and the broken
id list from what it classified — so the reading the gate sees is a measurement
of commands that were executed. Neither command is one the pre-validator
auto-fixes, so the broken one earns its classification rather than being
repaired first. The repaired fixture is the positive control.

**What was broken to prove it, run and counted rather than asserted.** All
three mutations were performed on the real source, measured over
`test/suite-binding-mutation.test.ts` + `test/gate-vacuous-checks.test.ts`
(29 tests), and reverted; none is left in the tree.

| Mutation | Red | What goes red |
|---|---|---|
| `prevalidateEvidence` short-circuited to `return []` in lib/evidence-prevalidator.ts | 3 of 29 | every case that dry-runs the fixture — the broken command stops being measured, so the fixture reports `PASS` and the refusal cases have nothing to refuse |
| `prevalidationViolations` short-circuited to `return []` | 4 of 29 | the measured `FAIL`, the absent reading, the explicit `UNMEASURED` reading, and the real-source half of the mutant case |
| `prevalidationViolations` renamed to `prevalidationRefusal` | 3 of 29 | every case that builds a mutant, each throwing `could not build the mutant: the binding signature appears 0 times` — the harness aborts instead of mutating nothing |

The first row is the one the sub-issue asked for and the one that is easiest to
get wrong: a refusal test fed a hand-written `"FAIL"` string stays green when
the pre-validator stops validating, which would make the whole check a test of
JSON parsing. It goes red here because the fixture's verdict is derived from a
command that really ran.

Every assertion goes through an observed `ran === 1` first. A `-t` filter that
matches nothing leaves bun reporting zero failures, which is indistinguishable
from the check passing and is also what a mutant that failed to resolve its
imports looks like.

- [x] SC-618: gates/workflow.test.ts contains [export function prevalidationViolations, An unmeasured pre-validation is not a clean one] — the pre-validation reading is converted to a refusal at one site, and an absent reading refuses instead of passing
- [x] SC-619: test/suite-binding-mutation.test.ts contains [prevalidateEvidence, broken evidence commands on AC-2] — the fixture's broken evidence command is dry-run by the real pre-validator before the verdict reaches the gate, and the refusal names the AC id rather than only reporting a count
- [x] SC-620: test/suite-binding-mutation.test.ts contains [the mutation harness throws when the pre-validation binding is renamed, PREVALIDATION_SIGNATURE] — the removal of this binding is performed on a copy of the source every run, and a renamed or duplicated binding aborts the file instead of passing it

### The Verify fan-out leaves a trace, or the gate refuses (#126)

Two checks in `gates/workflow.test.ts` were supposed to notice when the
adversarial verification and the evidence validator had not run:

```js
const ev = sf("gates.verify.evidenceValidator");
if (!ev) {
  console.warn("WARN: gates.verify.evidenceValidator not populated — B2 agent may not have run");
  return;                                   // <- PASSES
}
```

**A test that returns early passes.** The only input either one could fail on
was a slot that had been written and written wrong, so the failure mode they
existed for — the agent never running — was the single case they were
structurally incapable of catching. Both names said so out loud: "when
populated".

The producer reached not-populated four ways, three of them silent: the
`fails === 0` guard (a verify gate with any failure skipped both agents and
then reported their absence, which reads as the cause when it is the
consequence), `RUNGATE_SKIP_AGENTS`, a LIGHT tier, and a missing prompt file.
So the fan-out could be absent in full and the gate said PASS — which makes
every compliance number ever recorded for Verify a number for a stage that may
not have run.

**The check reads at the SHIP gate, not at verify, and the contract fixtures
are what found that.** `gate-executor` runs the gate suite (`runGateTests`)
and only THEN spawns the fan-out and persists its slots — so at the verify
gate the slot cannot yet exist, and a check refusing its absence refuses every
first attempt. That is the original circularity with the sign flipped: the
gate failing on the fan-out's absence is what skips the fan-out. Verify cannot
verify its own not-yet-produced output. Ship can, and refusing there still
blocks the PR, which is the only thing the refusal needed to do.

Absence is now a refusal and a deliberate skip is a recorded one. Both halves
are load-bearing: refusing on every absence would brick LIGHT runs, and a fix
that brings its own outage is how the next fail-open gets argued for. A skip
with no readable reason refuses too, because that would be the cheapest way to
make the whole check green again.

- [x] SC-638: gates/workflow.test.ts contains [export function verifyFanoutViolations, the agent left no trace] — one binding turns "no record" into a refusal for both slots, and a LIGHT tier and a reasoned skip are the only absences that pass. The token is `the agent left no trace` rather than the sentence's ending, because the refusal text is split across a string concatenation and `an absence is not an approval` appears nowhere in the file — the same trap SC-523 records
- [x] SC-639: gates/gate-executor.ts contains [export function fanoutSkipReason, skipped: fanoutSkip] — every path that does not run the fan-out records why, including the two that previously returned in silence
- [x] SC-640: test/verify-fanout-recording.test.ts contains [a verify run finished with an unexplained empty fan-out, the gate refused a skip it had just written] — the producing side is measured by running the real gate executor and reading what it wrote, not by asserting on source
- [x] SC-641: test/gate-vacuous-checks.test.ts contains [the case that used to warn and pass, a recorded skip with NO reason is red] — every case is paired red/green, and the escape hatch has its own loophole closed

What was broken to prove it, run and counted rather than asserted:

| Mutation | Red |
|---|---|
| `verifyFanoutViolations` short-circuited to `return []` | 5 of 42 |
| the producer stops recording its skip (`{skipped: reason}` deleted) | 3 of 30 |
| `verifyFanoutViolations` renamed | every mutant-building case throws `could not build the mutant` |
| the check moved back to `isVerifyPlus` | 3 of 14 in test/contract.test.ts — the circularity, reintroduced |

**One mutation was deliberately not run, and that is itself the finding.**
Making `fanoutSkipReason` return `null` unconditionally means the fan-out is
never skipped — so the mutant SPAWNS REAL AGENTS. The first attempt at it
killed the shell. A mutation whose failure mode is "an unattended test run
starts billing agents" is one to describe rather than execute, and the
property it would have checked is covered from the other side: `null` is the
only value that reaches the spawn, and every non-null branch is driven
directly in `test/verify-fanout-recording.test.ts`.

**The producer mutation is recorded because it SURVIVED the first pass.** With
only the consumer tested — the gate check refusing an absent slot — deleting
both `{ skipped: reason }` assignments left 42 of 42 green. That is #235's
lesson arriving a second time: *mutate both ends of the binding, not just the
reader.* A refusal nothing can satisfy is as broken as one nothing can
trigger, and a reader-only proof sees neither.

### A refusal reports the whole run, and leaves no mergeable PR (#252)

Run `wf_e105dd33-220` on #216 ended with one sentence — the security review
had gone stale — and that sentence reads as "the work was fine, a commit
landed late, re-run it". The same run had already recorded a FAILED verify
gate with two fan-out slots never written, a FAILED ship gate on three checks,
and a red typecheck. All of it was in `workflow-state.json`. **The run knew and
the summary did not say.**

The mechanism was that `reason` was whatever the last phase to refuse passed
up, which makes the ordering the hazard rather than an incidental detail: the
later a failure happens the more it hides, and staleness happens nearly last
and sounds the most innocuous of the list. So refusals are collected into a
ledger as they happen, ranked by SEVERITY rather than by time, and the reason
the run stopped is entered into that ledger as one refusal among the rest
instead of standing in for them. The immediate reason is still reported, on
`immediateReason` — the difference between the two fields is the fix.

Fourteen hand-built refusal returns became one `shipFailed` helper. Three of
the fourteen carried no reason at all.

The same run also left **PR #250 open, not draft, and `mergeable: MERGEABLE`**,
carrying the code that destroyed a consumer's CI. The fix is not a cleanup step
— a cleanup step is another thing that has to run, on the path where things by
definition stopped running. The PR is opened as a DRAFT and marked ready only
at the terminal, so the default, including the default when a run dies or is
killed, is the state the run actually earned. `SHIPPED_UNPROVEN` is above the
readiness line on purpose: for a LIGHT-ceremony issue with no UI criteria,
prove is skipped by design and the verify gate has already run every evidence
command.

- [x] SC-631: workflows/ship.js contains [FAILURE-LEDGER-START, function shipFailed(, REFUSAL_SEVERITY] — refusals are collected and ranked at one site, and the status literal appears exactly once in the file so no refusal path can report a single reason
- [x] SC-632: test/ship-failure-report.test.ts contains [the run that shipped this bug names both failed gates, a gate that failed and then healed to PASS is not reported as failed] — the ledger is EXECUTED over the real run's recorded failures, and a healed gate is not reported, because a report with false entries in it is a report nobody reads twice
- [x] SC-633: workflows/ship.js contains [PR-READINESS-START, SHIP_STATUS_READY_THRESHOLD, github-op.ts pr-ready] — the PR is opened as a draft and undrafted only at the terminal, and the readiness decision is its own named block rather than a condition inside the undraft step
- [x] SC-634: test/ship-pr-draft.test.ts contains [pr-ready runs before the ship gate, every terminal status the run can report is ranked by this decision, an unrankable threshold] — position is asserted, not just presence, and both fail-open directions are ruled out: an unranked status and an unrankable threshold each leave the draft alone
- [x] SC-635: lib/github.ts contains [convertPullRequestToDraft, it cannot be converted to a draft] — an upsert that is asked for a draft converts an already-ready PR back, because protecting the first run on a branch and nothing after it is no protection in a workflow that re-enters its own phases
- [x] SC-636: workflows/ship.js contains [function observedDraft(, is NOT a draft] — the recorded draft state is what the PR step reported, three-valued so "nobody looked" is distinguishable from "it is mergeable", and the dangerous combination is logged at the moment it becomes true
- [x] SC-637: scripts/github-op.ts contains [draft was requested but PR #, and this run has no way to gate it] — a draft that was asked for and not granted exits non-zero, because GitHub does not always honour the field and an absent protection is indistinguishable from one that was never requested

Two constraints this mechanism does NOT remove, recorded rather than papered
over:

- **The run learns its PR's state from an agent's transcription, not from the
  API.** `workflows/ship.js` runs in a sandbox with no module loading (#69), so
  every field it knows about the PR — `prNumber` as much as `prDraft` — is
  what a language model reported after reading command output. `github-op.ts`
  refusing non-zero on an ungranted draft is the mitigation that does not
  depend on the transcription being faithful: the step fails, and a failed
  step is the one thing the schema makes hard to misreport.
- **The PR step is unreachable when a container is configured** (#254, filed
  from the same review). `pr-upsert` appears once in the file, inside the
  `else` arm of `if (containerConfig)`, so a consumer with a container gets no
  PR and therefore no draft lifecycle at all. `prReadiness` reports `NO_PR`,
  which is accurate, so this criterion holds — but a whole branch of the
  workflow has no PR at all, and that is its own defect rather than part of
  this one. DailyBriefDashboard is not affected: its `.claude/rungate.json`
  carries no `container` key, checked rather than assumed.

**The first version of the draft fix was wrong, and the way it was wrong is
the point.** `upsertPR` passed `draft` only to the create path, with a comment
justifying it: "a PR a human already marked ready is theirs." That reasoning
does not survive contact with how this harness runs. A re-ship pushes new
commits to the SAME branch, so run A undrafts #N, run B updates it and then
refuses, and #N is mergeable carrying run B's unproven code — and whatever the
human approved is not what is on the branch any more. Re-runs are not the
exception here: #155, #164, #169 and #171 all exist because this workflow
re-enters its own phases.

The second half is worse and smaller. `shipFailed` recorded
`pr: { draft: true }` on the reasoning that the undraft step had not run. That
is **a claim about a state it never looked at**, false exactly when it matters,
in the artefact a reader consults to find out whether the refusal left anything
behind. It is now three-valued and observed: `false` is the dangerous reading
and has to be distinguishable from "the step did not say", which a boolean
cannot do.

Found by security review of the PR, before merge, not by the tests written for
it.

| Mutation | Red |
|---|---|
| `upsertPR` stops converting an already-ready PR back to draft | 2 |
| `observedDraft` returns `true` instead of reading the step's report | 2 |
| the convert fires unconditionally, even on an already-draft PR | 1 |
| the ungranted-draft refusal removed, so an unhonoured `draft` passes quietly | 1 |

Measured over `test/ship-failure-report.test.ts` + `test/ship-pr-draft.test.ts`
+ `test/github-op.test.ts` + `test/github-client.test.ts` (132 tests); none
left in the tree.

The third one is recorded for a second reason: **the first attempt at it
reported green because the `perl` substitution silently matched nothing.** A
mutation harness that no-ops when its target moves is indistinguishable from a
mutation the code survived, which is this rule's own subject turned on the
tooling used to check it. Re-run with a substitution that throws when the
target is absent, it is 1 red.

What was broken to prove it, run and counted rather than asserted, over
`test/ship-failure-report.test.ts` + `test/ship-pr-draft.test.ts` +
`test/blocking-grades.test.ts` + `test/security-verdict-blocks.test.ts` +
`test/github-op.test.ts` (302 tests):

| Mutation | Red |
|---|---|
| the summary becomes an echo of the immediate reason — the defect, reintroduced | 3 |
| `--draft` dropped from the `pr-upsert` command, so a refusal leaves a mergeable PR | 1 |
| `recordGateRefusal` short-circuited to `return []` — the ledger is never written | 10 |
| `shipFailed` stops entering the immediate reason into the ledger | 4 |

None is left in the tree; all were run and reverted. Three more mutations run
inside the test files on every pass, built from the real source: dropping the
readiness threshold, pointing it at a name the strength scale does not carry,
and ranking by recency instead of severity. Each builder throws if its
substitution changed nothing, so a rename aborts the file rather than passing
it.

Two things the first attempt got wrong, recorded because neither was caught by
reading:

- The sliced decision blocks in `test/security-verdict-blocks.test.ts` and
  `test/blocking-grades.test.ts` no longer build their refusal by hand. A stub
  `shipFailed` in those sandboxes would have made every refusal assertion in
  both files a test of the stub, so ship.js's real helper is sliced in beside
  the block under test and the ledger is fresh per execution.
- The new test file used the bare token `SC-1` in a describe name, which
  `findTestFilesForSCs` reads as a coverage claim — #149, reintroduced within
  the hour, and caught by its own guard. The criteria are referred to by
  number in prose instead.

---

### Scope cannot defer the criterion that proves the work (#251)

Run `wf_e105dd33-220` on #216 was handed **seven** success criteria and went on
to implement, verify, commit, security-review and open a PR against **six**.
Nothing refused and nothing warned. The seventh was the only one measured
against a real consumer:

> A throwaway worktree of DailyBriefDashboard re-scaffolds with its
> `[self-hosted, mac-mini-live]` runner label and all four extra gates intact

The other six passed honestly, against fixtures the same change produced.
Running the seventh by hand afterwards showed the delivered code destroying
`concurrency`, `cancel-in-progress`, `paths-ignore`, the top-level
`workflow_dispatch` trigger and the consumer's header comments — while
reporting a *preserving* `REPLACED (+0 lines, preserved …)` with `0 refused`.
So the cost is not one missing row in a report: the run's entire green result
was about the half of the problem the fixtures covered, and no gate could tell
the difference.

**It was not a silent drop, and filing it as one was wrong.**
`MAX_ACS_PER_ISSUE = 6` triggered a decomposition and AC-7/8/9 went to
sub-issue #249, which #216 references four times. The mechanism worked. What
it got wrong is **which** criteria it kept. The decompose prompt said "If no
phases exist, split sequentially" and the fallback on an unmatchable result was
`originalAcs.slice(0, MAX_ACS_PER_ISSUE)`. Both positional — and an acceptance
criterion is written LAST, because it is the one that says "and then the whole
thing works". Position-based splitting therefore defers the falsifying
criterion **by construction, every time**, and leaves the shipping phase
measuring only the parts it already believed.

Note the asymmetry this closes. A stale security review stops a run cold, an
unmeasured suite is not a passing suite, an absent pre-validation reading
refuses. An absent acceptance criterion was silent.

- [x] SC-642: workflows/ship.js contains [AC-COVERAGE-START, not a criterion that passed] — one binding turns (success criteria, ACs, deferrals) into a list of refusal strings; every criterion maps to an AC this run will measure, or to a deferral carrying a reason somebody wrote
- [x] SC-643: workflows/ship.js contains [would not be measured by this run, discoveryRefusal = shipFailed] — an uncovered run refuses before the implement phase, and the refusal QUOTES each uncovered criterion rather than counting them
- [x] SC-644: workflows/ship.js contains [function prioritiseAcs(acs, first.concat(rest)] — a STABLE partition that keeps what could falsify the work, not what came first; with no acceptance criterion present the input order is returned unchanged, so runs that were already fine are not quietly reshuffled
- [x] SC-645: gates/schema.ts contains [acCoverage: z.object({] — the coverage decision reaches workflow-state.json through the schema, so a reader of a finished run can tell "six ACs because the issue had six criteria" from "six ACs because one was dropped"
- [x] SC-646: test/ac-coverage.test.ts contains [could not build the mutant] — the AC-COVERAGE block is extracted by marker and EXECUTED, and a rename aborts the file rather than passing it

A deferral with no reason does **not** cover a criterion. That is the cheapest
way to make an uncovered run green again, and it leaves a reader exactly as
uninformed as silence did.

What was broken to prove it, run and counted rather than asserted, over
`test/ac-coverage.test.ts` (33 tests):

| Mutation | Red |
|---|---|
| `prioritiseAcs` reverted to the positional `acs.slice(0, limit)` — the defect, reintroduced | 5 |
| `coverageViolations` short-circuited to `return []` | 12 |
| `coverageViolations` renamed | aborts — 0 pass, 1 error, every case gone |

None is left in the tree; all were run and reverted. Three more are built from
the real source inside the file on every pass: coverage crediting every
criterion, a reasonless deferral accepted, and a refusal that reports a count
instead of the text.

**What this does NOT prove, stated rather than left to be discovered.** The
binding is executed; the WIRING is asserted by reading ship.js's source. A
mutation that changes `if (coverageGaps.length > 0)` to `if (false)` leaves
every source-text assertion satisfied and is not caught. Closing that needs the
negative-control run — a planted uncovered issue driven through `Skill("ship")`
— which is the next item and not this one.

---

### The coverage check could not read what Discovery writes (#258)

The negative control earned its cost on its first run.

`wf_0dd46ae5-495`, the first end-to-end pipeline run after #251 merged,
**refused at Discovery** on #254 — naming all three success criteria as
uncovered while Discovery had produced five acceptance criteria that cover
them. The machinery worked. The answer was wrong, and in the fail-CLOSED
direction: `main` could not ship any issue whose criteria were not
`SC-N`-numbered, which is most of them.

Two defects, and the second is the one worth keeping:

1. **An unidentifiable criterion could never be covered.** Both guards read
   `if (id && covered.has(id))`, so a criterion line carrying no `SC-N` fell
   straight through to the violation with no way for any AC to answer it.
   #254's three criteria are bare checkbox lines, as most issues' are.
2. **`ac.specElement` names the governing SPEC's section, not the issue's
   criteria.** On that run two of the five ACs carried the identical
   `specElement` — "A refusal reports the whole run, and leaves no mergeable
   PR (#252)" — which a criterion reference cannot meaningfully do. Reading it
   as an attribution was the error, and it was mine: **the fixture was written
   before reading what Discovery emits.**

`test/ac-coverage.test.ts` passed throughout, because its fixture set
`specElement: 'SC-1'` — a shape production does not produce. It even had a
case named "an SC line with no id is still matched by its text", which passed
**zero ACs** and so only ever asserted the uncovered direction. The fail
direction was tested and the pass direction was not, which is this rule's own
subject reached from the side that refuses good work rather than passing bad.

**#251's own PR said the wiring was asserted by reading source rather than
executed, and named that as the gap. This is the defect the gap was hiding.**

The fix separates the two meanings. `coversCriteria` is a new, REQUIRED field
naming the issue criteria an AC answers; `specElement` keeps naming the
governing spec's section; an AC normally carries both with different values.
Criteria get positional `C-N` ids at Discovery time, so an issue that numbers
its own and one that does not are the same problem.

- [x] SC-650: workflows/ship.js contains [function criterionIds(successCriteria)] — every success criterion gets an id an AC can cite, assigned positionally when the issue does not number its own, because an id nobody can cite is the same as no id
- [x] SC-651: workflows/ship.js contains [function acCoversIds(ac)] — attribution is read from coversCriteria, and specElement can only ever add coverage for an id the criteria actually carry, never invent one
- [x] SC-652: workflows/ship.js contains [coversCriteria: { type: 'array'] — the Discovery schema REQUIRES it, so the structured-output layer makes the model produce it; an optional attribution field is an attribution nobody records, and then every run refuses
- [x] SC-653: workflows/ship.js contains [EVERY criterion above must appear] — the prompt states that the run refuses, names the two fields apart, and says there is no way past it
- [x] SC-654: test/ac-coverage.test.ts contains [wf_0dd46ae5-495] — the regression fixture is READ FROM DISK, copied verbatim out of the failing run's journal. A fixture written from imagination can only re-test what its author already believed, which is exactly how the first version shipped

The fixture file carries a `_provenance` block saying what must not be tidied:
the duplicate `specElement`, the missing ids on the criteria, and the prose
criterion text are each load-bearing, and a test asserts all three are still
there — someone "fixing" the fixture into the shape that was broken would
otherwise restore the blindness.

What was broken to prove it, run and counted rather than asserted, over
`test/ac-coverage.test.ts` (43 tests):

| Mutation | Red |
|---|---|
| every criterion treated as covered — the fail-open | 16 |
| `coversCriteria` ignored, falling back to `specElement` — #258 reintroduced | 7 |
| the positional `alias` removed — the unconditional refusal reintroduced | 1 |
| `coversCriteria` made optional in the Discovery schema | 1 |
| the prompt softened from "the run REFUSES" to "should generally cover" | 1 |

| the `specElement` fallback restored — the parser differential, below | 1 |

None is left in the tree; all were run and reverted.

**Security review caught the fix reopening the hole it had just closed.**
`acCoversIds` also scanned `specElement` "for issues whose criteria genuinely
are SC-numbered", with a comment claiming it could only add coverage for an id
the criteria already carry and never invent one. The comment was false.

Spec section titles in this repo routinely contain SC numbers — one is in
#258's own fixture: `SC-633 PR-READINESS block and the draft lifecycle`.
Measured rather than argued: an AC with `coversCriteria: []`, covering
nothing, was credited with `SC-633`, and a criterion numbered SC-633 came back
fully covered by an AC that answers it in no way at all. A parser differential
straight through the control this issue had just installed — and a claim about
a state it never looked at, written into a comment while fixing that exact
defect class. `coversCriteria` and nothing else now.

**Two mutations that measured nothing, recorded because they looked like
mutations.**

- Removing the positional id from `criterionIds`'s `id` field turned **0**
  red. `alias` carries that load, so the substitution changed no behaviour.
- A "only ids this issue defines can be credited" filter was added after the
  security review and then **removed**: its mutation also turned 0 red,
  because an unknown token in the covered set is never consulted. It read
  well and could not change an outcome. A guard that cannot change an outcome
  is not defence in depth, it is a line that makes a reader believe a check
  exists, so the property is held by a test case and a comment instead.

A mutation with a zero count is either a gap in the tests or a target that was
never load-bearing, and the two are indistinguishable without looking.

The backtick trap also recurred: backticks around `coversCriteria` inside the
Discovery prompt closed ship.js's template literal. `test/security-verdict-blocks.test.ts`
caught it by failing to parse the file — the reachability checks are the only
thing in the suite that reads ship.js as JavaScript rather than as text.

---

### The full-suite rate is 4, and it is stated once (2026-10-10; the number superseded 2026-10-13, the reasoning not)

DIR-L29's budget moved from 2 full suites per worker per 30 minutes to 4.
Two was measured against a session that ran the suite as a gate and then got
on with it; what a long autonomous run actually does is gate, fix, re-measure,
fix again. At 2 the third refusal landed mid-run and the work either stalled
or proceeded on an unmeasured tree — which is the failure the budget exists to
prevent, arrived at from the other side.

This is a RATE, not a concurrency limit. `DEFAULT_CAPACITY` still holds the
machine to 2 suites at once, and that is the number the 2026-10-05 reboot was
about (5,360 MB and 33 processes per suite). Raising the rate lets one worker
come back sooner; it does not let two more start together.

- [x] SC-647: lib/transcript-checker.ts contains [DEFAULT_MAX_RUNS_PER_WORKER] — COMP-2 grades against the POLICY constant rather than restating the number or resolving it through the environment. Two failure directions, both real: a grader still saying "2" after the guard moved to 4 marks a compliant run as IGNORED, so the run that reads worst is the one that obeyed; and a grader resolving through the environment lets a run that spent eight suites be graded against a threshold of eight
- [x] SC-648: lib/test-suite-lock.ts contains [RUNGATE_MAX_FULL_SUITE_RUNS, Math.min(parsed] — the environment may LOWER the rate and cannot raise it, and no value of it can turn the guard off: every input that is not a clearly valid integer falls back to the default, since NaN would refuse everything and Infinity would disable the cap
- [x] SC-649: lib/test-suite-lock.ts contains [DEFAULT_MAX_RUNS_PER_WORKER, MAX_TRACKED_RUNS] — the rate is clamped to what the counter file retains; a budget larger than that is a budget that silently resets mid-window

Everything in `test/test-suite-lock.test.ts` that asserts "the third run is
refused" now PINS `maxRunsPerSession: 2` instead of inheriting the default.
That sentence is only true at 2, and an inherited default would have turned
every one of those cases green-by-accident the moment the number moved. The
cost of pinning is that nothing then exercises the value production runs at,
so the default is driven separately through the real gate with no option and
no environment.

**Security review of d6cc5acf found two real defects in the first version of
this change, and both were mine.** Recorded because the shape is the same
shape twice: a limit that the thing being limited can reach.

- **Self-grading bypass.** COMP-2 called `resolveMaxRuns()`, which reads the
  environment. A run that spent eight full suites could be graded against a
  threshold of eight. The grader now reads the POLICY constant: a run does not
  get to move the line it is measured by.
- **Control bypass.** The environment could set any rate up to
  `MAX_TRACKED_RUNS`, so the guard that exists to stop a machine-killing suite
  read its own limit from a place the guarded work can influence. Reaching the
  hook's environment is not trivial — hooks inherit the Claude Code process's
  env, so an inline `VAR=8 bun test` sets it for the suite and not for the
  guard — but "hard to reach from one direction" is not the property a control
  needs, and a shell profile, a launch script or an exported parent all reach
  it. The override is now ONE-WAY: it may lower the rate and cannot raise it.
  Tightening is always safe and never needs permission, so the loosening
  direction had no reason to exist.

The self-reference trap caught the fix for the first one. The comment
explaining that COMP-2 must not call the resolver wrote the forbidden call
form out verbatim, which is itself enough to satisfy a check that greps for
its absence. The comment names the resolver in prose only.

What was broken to prove it, run and counted rather than asserted, over
`test/test-suite-lock.test.ts` (138 tests):

| Mutation | Red |
|---|---|
| the default set back to 2 | 15 |
| the default raised to 99, above `MAX_TRACKED_RUNS` | 15 |
| the environment clamp raised from the policy to `MAX_TRACKED_RUNS` — the control bypass, reintroduced | 1 |
| COMP-2 pointed back at the environment-aware resolver — the self-grading bypass, reintroduced | 1 |

None is left in the tree; all were run and reverted.

---

### Raising the rate to 8 nearly made a security test stop measuring (2026-10-13)

The rate moved from 4 to 8 at Jason's direction, on the argument the section
above already makes and the one below reinforces: the rate and the concurrency
cap are different things, and in a single session with nothing overlapping,
`DEFAULT_CAPACITY` is the one doing the protecting. Four was reached three
times in one afternoon of backlog work, once mid-reconciliation — the stall the
budget exists to prevent, arriving from the other side, exactly as the
2026-10-10 note predicts.

**The number was the easy part. Setting it to 8 would have silently retired the
control-bypass fix.** `MAX_TRACKED_RUNS` was also 8, and the environment clamp
is `Math.min(parsed, DEFAULT_MAX_RUNS_PER_WORKER)` while the option clamp is
`Math.min(option, MAX_TRACKED_RUNS)`. At equality those are the same function.
No input distinguishes them, so the one-way property — the whole finding of the
d6cc5acf security review — becomes unobservable: the code still says it, and
nothing can tell whether it is true. That is this repo's defect class exactly,
reached not by writing a bad check but by moving a constant underneath a good
one.

Measured rather than argued. With the clamp retargeted at `MAX_TRACKED_RUNS`
(the bypass reintroduced verbatim) and retention held at 8, the test named
after that finding — "the environment CANNOT raise it — the control-bypass
finding" — **passes**. The only reds are the new invariant below and an
unrelated option case. Retention is therefore 12, and the headroom is
load-bearing rather than generous; it costs a slice length inside a file
already bounded by `MAX_COUNTER_BYTES`.

- [x] SC-801: test/test-suite-lock.test.ts contains [the rate reached retention — the one-way env clamp is no longer measurable by any input] — the rate is asserted STRICTLY less than retention, not `<=`. The weaker form is satisfied at equality, which is the state in which the clamp cannot be measured, so the invariant that permits the hazard is the one that has to be ruled out
- [x] SC-802: test/test-suite-lock.test.ts contains [the policy value is what it is for stated reasons] — exactly ONE test pins the rate's value, and it pins the two relationships that make the value safe beside it. Every other case derives from the constant, which is why one pin is enough and also why it must exist: eighteen tests re-asserting the same literal went red for a deliberate policy change, and a number re-stated in eighteen places is a number nobody can move on purpose
- [x] SC-803: test/test-suite-lock.test.ts contains [the raise was a rate change; concurrency must not move with it] — `DEFAULT_CAPACITY` is asserted unchanged in the same test that pins the rate, because the two are routinely confused and this raise was approved on the distinction between them

The eighteen red tests are the finding, not the inconvenience. Every one was
re-asserting `4` rather than a behaviour, so the suite could say the rate had
not moved and could not say whether the rate still worked. The cases now drive
`DEFAULT_MAX_RUNS_PER_WORKER` runs and ask whether the next one is refused. The
same stale-literal bug was in the test fixtures: `test/test-suite-budget.test.ts`
set `capacity: 8` to keep the concurrency cap out of budget questions, a number
sized against a per-worker rate of 4. At 8 the loops filled the slots and two
budget tests failed with a concurrency refusal. It is now derived from both
budgets.

What was broken to prove it, run and counted rather than asserted, over
`test/test-suite-lock.test.ts` + `test/test-suite-budget.test.ts` (154 tests):

| Mutation | Red |
|---|---|
| the environment clamp retargeted at `MAX_TRACKED_RUNS` — the control bypass, reintroduced | 1 |
| the same mutation with retention back at 8 | 1, and **not the clamp's own test** — it passes. The reds are SC-801's invariant and the option case |
| the rate lowered back to 4 | 1 — the single pin, which is the point of there being one |
| `DEFAULT_CAPACITY` raised from 2 to 4 alongside the rate | 17 |
| `MAX_TRACKED_RUNS` dropped to 6, below the rate | 10 |

None is left in the tree; all were run and reverted.

---

### The evidence base and the installable artifact were different software (#366)

Every mutation count, gate measurement and standing verdict in `SUCCESS.md`
was taken against the working tree at `main`. What a consumer can install is
`rungate@0.2.1`. The tree has said `0.2.2` since 2026-09-19 — 697 commits
back — and there is no release workflow to close the gap (#364).

It bites hardest at the file's weakest row. The consumer survey of 2026-10-08
returned *not ready*, measuring code no consumer can obtain, which makes the
one deliberate attempt to assess claim 5 unattributable to any shippable
version. The claim-5 row argues that *"a path nothing has executed is not a
path anyone understands"*; the distribution path was in exactly that category
and was not counted as one. And because `SUCCESS.md` is the measure for
filing issues, reviewing PRs and running audits, a standing table that
silently describes unpublished code hands that gap to every decision routed
through it.

**Two numbers, not one, and the issue said why.** It named the vacuous form —
*"an assertion that merely finds a version string in the file"* — and the
mutation that has to turn it red: *"bumping `package.json` without publishing
must turn it red."* Checking only the recorded published version against the
registry stays green through a bump, because a bump moves neither of those
two values. So the line records the tree version and the published version,
and each is compared to its own source of truth.

- [x] SC-822: SUCCESS.md contains [Distribution standing] — the file states which software its numbers describe, in a declaring position rather than in prose. Every measurement in it was taken against the tree; none of it describes what a consumer can install
- [x] SC-823: lib/distribution-standing.ts contains [distributionViolations] — ONE exported function turns the three readings into violations, so there is one binding to mutate. A second comparison of the same facts would survive any mutation of this one
- [x] SC-824: test/distribution-standing.test.ts contains [registry returned] — the npm registry is REACHED, from the endpoint `bun add` resolves against, and an unreachable one THROWS. A read that fell back to the recorded value would make the file agree with itself whenever the network was down

#### What was broken to prove it (SC-822..824)

Run and counted over `test/distribution-standing.test.ts` (12 tests):

| Mutation | Red |
|---|---|
| `distributionViolations` always returns `[]` | 4 of 12 |
| the tree-version comparison removed — **the bump the issue named** | 2 of 12 |
| the published-version comparison removed | 2 of 12 |
| `publishedVersion` falls back to a constant instead of throwing | 1 of 12 |
| `STANDING_LINE` loosened to any version pair in prose — the vacuous form | 4 of 12 |
| the absent-standing branch returns `[]` rather than a finding | 1 of 12 |
| the standing line deleted from `SUCCESS.md` | 4 of 12 |

None is left in the tree; all were run and reverted.

**Deliberately not done.** The issue's second step — re-run the consumer
survey against the *installed* package — is blocked on #364, since there is
nothing newer to install. This change makes the gap visible and keeps it
visible; it does not close it, and publishing is an outward-facing action
with its own authorization.

---

### A release pipeline has a quiet way of doing nothing (#364)

`rungate` has been published twice, ever: `0.2.0` and `0.2.1`. There was no
publish step in `.github/workflows/` at all, and `main` is **741 commits**
past the published artifact. Every mutation count and gate measurement in
`SUCCESS.md` describes software a consumer cannot obtain, which is what #366
made the file say and what this makes fixable.

**The guard is the deliverable here; the publish step is the easy part.** The
issue named the way this ships broken, and it is the shape
`.claude/rules/checks-must-be-able-to-fail.md` opens with:

> A publish job that exits 0 because npm rejected a duplicate version is
> exactly the "could not measure reads as nothing wrong" shape, and it is the
> most likely way this fix ships broken.

A release pipeline can do nothing in at least four ways that all leave a green
job and a real tag: a duplicate version npm rejects, a step skipped by an
`if:` that stopped matching, a failure swallowed by `continue-on-error`, or a
registry that could not be reached. Nothing downstream distinguishes "we
shipped 0.2.3" from "we tagged 0.2.3 and shipped nothing".

#### Two readings, before and after — neither sufficient alone

- **Preflight** — the tree's version must NOT be on the registry. This makes a
  duplicate publish a red run rather than a no-op.
- **Postflight** — after the publish step, the registry's `latest` must BE the
  tree's version. This makes a *skipped* publish a red run.

Preflight alone passes a pipeline whose publish step never ran. Postflight
alone passes a pipeline that republished nothing because the version was
already there from last month. It is the same "two numbers, not one" argument
SC-822..824 makes about the record, applied to the act.

The preflight reads the **packument**, not `/latest`: a dist-tag moves on and
leaves earlier versions installable behind it, so `latest` cannot answer "has
`0.2.1` ever shipped". `distributionViolations` asks a different question and
is right to use `/latest`.

#### The workflow file is checked as evidence, not trusted as intent

A guard the pipeline never calls is the decorative check this repo keeps
finding, so `release.yml` is itself asserted: both phases are invoked, the
preflight precedes the publish and the postflight follows it, the suite runs
before the artifact ships, no step carries `continue-on-error`, the publish
step is not behind a condition, provenance is requested and permitted, and
the guard is not pointed at a registry nobody installs from.

`release.yml` is **caller-owned**. `createCiWorkflows` regenerates `ci.yml`
and `gates.yml` by name, so a re-scaffold carries this file forward untouched
— and a test asserts the scaffold has not started writing it, because the day
it does, the release pipeline disappears with it.

#### The tag is attacker-shaped text

Git permits quotes and semicolons in a tag name, so `${{ github.ref_name }}`
inside a `run:` script is the workflow injection GitHub's own guidance opens
with. The tag arrives through `env:` and the guard reads it from the
environment. The test asserts the general property rather than the one line:
every `${{ github.* }}` in the file must be an `env:` assignment.

#### Four of these checks shipped red, all for the same reason

The header comment says *"do not add `continue-on-error`"* and *"do not guard
`npm publish` behind a condition"* — and the detectors found their own
documentation and reported the thing it warns against. A comment is not a
step, so the checks now read the workflow's executable content.

That is a detector whose view of the input deliberately shrinks, which this
repo is right to be wary of, so the stripping is asserted in **both**
directions: a `continue-on-error` in a real step is still seen, and one in a
comment is not. Without that pair the fix would be indistinguishable from
buying green with blindness.

- [x] SC-828: lib/release-preflight.ts contains [preflightRefusal] — ONE exported function decides whether a release may be cut, so there is one binding to mutate. A duplicate version is refused BEFORE anything irreversible, rather than left for npm to reject into a green job
- [x] SC-829: SUPERSEDED by SC-1647/SC-1648 (#445) — was "lib/release-preflight.ts contains [postflightRefusal]: a skipped, swallowed or silently-failed publish leaves `latest` where it was, and only a reading taken AFTER the publish step can tell". The half is still there and still cannot be satisfied by doing nothing. What was wrong is the clause after the colon: `latest` is a dist-tag, not the fact, so the criterion asked the guard to answer "did the publish take effect" by reading a pointer. It did, and it was wrong on both of the two releases this project has ever cut
- [x] SC-830: scripts/release-guard.ts contains [export const REFUSE_EXIT] — every refusal travels through one exit code, declared once, so the test can build a mutant copy with it zeroed and run every negative case twice
- [x] SC-831: .github/workflows/release.yml contains [--phase postflight] — the pipeline actually calls the guard. A decision correct in lib/ that the workflow never consults is the decorative check this repo keeps finding
- [x] SC-832: test/release-guard.test.ts contains [the comment stripper keeps steps and drops prose] — the workflow checks read executable content, and the boundary is asserted in both directions rather than trusted

### The enforcement ADR-001 specified and nobody built (#309, 2026-10-14)

ADR-001 decided the single-loader policy on **2026-10-05**. It named the
enforcement explicitly — a conformity check that **fails** the suite, not a
lint rule and not convention — and explained why convention would not work,
citing the 24 violations that had accumulated after the same policy was
stated in prose on 2026-10-02.

`runConfigAccessValidation` was never built.

| | ADR-001 (2026-10-05) | measured 2026-10-11 |
|---|---|---|
| direct `rungate.json` access | ~24 sites | ~89 across 25 files |
| `runConfigAccessValidation` | proposed | never built |

The count roughly tripled in six days, with the policy written down the whole
time. That is what makes *"a rule nothing executes is not a rule"* a number
rather than a slogan, and it makes ADR-001 an instance of the defect class it
describes.

**Two checks, not one.** ADR-001 proposed one, and the survey shows it would
have caught only part: eleven sites are prompt text inside `workflows/*.js`,
which a TypeScript-source scan does not look at. A check that would have let
`ship.js:1637` through is not sufficient.

**Measured on this branch, not quoted from the ADR.** The ADR's ~89 counted
comments; prose that *discusses* the config is not an access, and counting it
buries the real sites until the ratchet becomes a number nobody reads. The
stripping is `stripJsComments` — offset-preserving, with its own suite —
rather than a line rule invented here. Measured:

| | files | sites |
|---|---|---|
| CHECK-1, TypeScript sources (`lib/ gates/ scripts/ hooks/ generators/`) | 17 | 47 |
| CHECK-2, `workflows/*.js` including prompt bodies | 3 | 14 |

The ratchet is **data**, in `.claude/config-access-ratchet.json`, not a
constant. `lib/conformity.ts` travels into every scaffolded project and
rungate's numbers have no business there; a consumer with no ratchet file
gets zero tolerance, which is right for a tree that never had the defect.
It refuses **both ways**, and a file absent from it is allowed nothing — the
migration window is exactly when the next reader is most likely to be
written.

**The self-reference trap, handled rather than allowlisted.** This file is in
the scanned set and now contains the literals it searches for. The pattern is
assembled from fragments that never appear adjacent in the source, and the
three real violations the file carried were migrated to the loader in the
same change — so "zero against its own file" is a fact, not an exemption. An
allowlist naming the exempt files becomes evidence those files are
referenced, and this repo has hit that three times.

One of those three migrations was a live defect in its own right: `rungate
config has required fields` read the monolith directly, so on a project using
the directory layout `existsSync` was false, the test returned, and a config
missing `project` or `repo` passed **by never being looked at**.

- [x] SC-1427: lib/conformity.ts contains [export function configAccessViolations] — one exported collector turns a scan into refusals so the mutation harness has a single site and the ratchet refuses over its number and under it because an entry that stopped being a violation is one nobody removes
- [x] SC-1428: test/config-access-conformity.test.ts contains [zero files scanned is a refusal] — a scan that read nothing refuses instead of reporting clean because a check that silently scans zero files is indistinguishable from compliance
- [x] SC-1429: lib/conformity.ts contains [export function scanPromptConfigAccess] — workflow prompt bodies are scanned as well as TypeScript sources because eleven sites live inside template literals handed to agents and a source-only scan is blind to every one of them
- [x] SC-1430: test/config-access-conformity.test.ts contains [lib/conformity.ts reports zero against itself] — the file hosting the check is in the scanned set so its patterns are assembled from fragments that never appear adjacent and its own three reads were migrated rather than allowlisted
- [x] SC-1431: test/config-access-conformity.test.ts contains [both checks are registered by the GENERATOR - not hand-added] — the conformity suite is harness-managed so the registration lives in the generator or the check silently stops running in every consumer project at the next re-scaffold

#### What was broken to prove it (SC-1427..1431)

ADR-002 D4's five mutations, run by hand on the branch and counted over
`test/scaffold-conformity.test.ts` + `test/config-access-conformity.test.ts`
(553 tests):

| Mutation | Red |
|---|---|
| `join(root, ".claude", "rungate.json")` added to a clean file not on the ratchet | 2 of 553 |
| `read ${PROJECT_ROOT}/.claude/rungate.json` added to a prompt in `ship.js` | 2 of 553 |
| the violation collector short-circuited to `return []` | 5 of 553 |
| `lib/config-loader.ts` removed from the allowlist | 2 of 553 |
| the scanner pointed at a directory that does not exist | 3 of 553 |

**The third scored ZERO against the conformity suite alone, and that is why
`test/config-access-conformity.test.ts` exists.** The tree sits AT its
ratchet, so the real collector returns `[]` too — on a green tree a
short-circuited check and a satisfied one are the same answer. Every refusal
case now drives a PLANTED scan. ADR-002 D4 says the fourth and fifth matter
most; measured, the third was the one with no teeth.

**And the mutation harness misfired twice, both times in my own tooling.**
Once because a replacement targeted the `.ts` quoting style and silently did
not apply; once because zsh does not word-split an unquoted variable, so
`bun test $FILES` passed one bogus path and bun reported "Tests need .test in
the filename" — which the harness printed as an empty result rather than a
count. Both now assert that the text changed, or that a count was produced,
before reporting. A mutation harness that silently no-ops when its target
moves is the decorative check this whole rule is about.

### A worktree in the wrong repository (#218, 2026-10-14)

Run `wf_5e3ed885-98c`, `projectRoot: …/rungate`, `repo: hornjason/pai-harness`:

| spawn | worktree | repo |
|---|---|---|
| Marcus #1 | `…/rungate/.claude/worktrees/wf_5e3ed885-98c-9` | pai-harness |
| Marcus #2 (remediation) | `…/DailyBriefDashboard/.claude/worktrees/wf_5e3ed885-98c-12` | **asaCommandCenter** |

The operator had changed directory mid-run — a normal thing to do during a
long run — and `isolation: "worktree"` is resolved by the agent runtime
against the session's cwd rather than the workflow's `projectRoot`. The agent
refused and named the reason, which is the only thing that kept this a near
miss rather than rungate's changes being committed into a consumer repository.

**The harness did nothing with that refusal.** The Verify BUILD-regression
branch read `if (reimpl.success) { … }` with no `else`: no log line, no
status, and the run advanced to rook-scope and rook. A remediation that
performed no work was indistinguishable from one that was never attempted.
That is the more serious half, and it is the shape
`.claude/rules/checks-must-be-able-to-fail.md` names — not silence, but a run
that goes on as though the step had succeeded.

**The fix cannot be another way of deriving the path.**
`workflows/ship.js` has pinned `opts.cwd = PROJECT_ROOT` for every isolated
spawn since 2026-09-23 (`804b9a43`), three weeks BEFORE this run. The pin did
not hold. A path-prefix check answers "is this under the directory I
expected", which is the question whose answer already drifted. So the guard
reads the checkout's `origin` remote and compares slugs — a fact about the
checkout, against the identity the run was handed. A path that merely looks
right cannot satisfy it.

Four no-answer states, kept apart rather than collapsed into "not a match":

| state | why it is its own refusal |
|---|---|
| mismatch | the incident. Names both slugs and the path |
| unreported | the agent was asked for a remote and did not answer |
| unreadable | a remote that is not `owner/name` — a bare name, a typo |
| no expected repo | the RUN does not know its own repo, so everything would pass |

The last is the fail-open that would matter most: returning "match" when
there is nothing to compare makes the guard silently inert for exactly the
misconfigured run most likely to need it.

Slug parsing takes **exactly** two path segments, lowercased. Lowercased
because GitHub slugs are case-insensitive and a case-sensitive compare would
refuse the run that is doing the right thing — a refusal aimed at the run
behaving correctly is the worst kind.

**Exactly two rather than the last two, and the commit security review is
why.** The first draft took the tail so a self-hosted group prefix would
still resolve. That is a parser differential:
`https://github.com/evil/repo/owner/name` is a path git reads as the
repository `evil/repo/owner/name`, and a tail-taking parser reads it as
`owner/name` and reports a MATCH. The string being compared arrives in an
agent reply, so a parser that can be talked into agreeing is the whole guard.
The cost is that a self-hosted layout with a group prefix returns null and
lands in the `unreadable` refusal — loud and naming the string, which is the
direction a check should be wrong in.

**A refusal must not log the credential it is quoting.** Also from the
security review. A CI checkout's origin is
`https://x-access-token:TOKEN@host/owner/name`, the `unreadable` refusal
quotes what it could not parse, and refusals are logged — into a run log that
gets read, pasted into an issue, and kept. `redactRemote` blanks the
credential and leaves everything the refusal exists to show. The control arm
matters as much as the redaction: a redactor that mangled every URL would
satisfy the token cases and make every refusal unreadable, so a remote with
no credential must come back byte-identical.

**Three more from the PUSH review, all real, all in the same class.** A
credential leak and a guard bypass are what this issue is about, so they were
fixed here rather than filed:

| finding | why it was right |
|---|---|
| incomplete sanitisation | redacting only the authority misses `?access_token=` and a bare key-shaped string. These reach the redactor *because* they could not be parsed, so they are exactly the strings not in the well-formed shape the first rule assumes. Three rules now: userinfo, credential-ish query parameters, and a narrow key shape — narrow because the control arm still has to hold |
| authorization bypass | `worktreeIdentityViolations` skips a row with no `worktreePath`, which is correct for a survey and a bypass at a collection boundary: there every row WILL be committed from, so "no path" is a row claiming files with no checkable origin, and omitting one field switched the guard off. `requirePath` is opted into by the caller that is about to act |
| sensitive data in logs | the terminal payload carries `agentResults`, which now carries `worktreeRepo`. That object becomes the run's result — printed, stored, pasted into an issue — so the remote is redacted there too. `readWorktreeRemote` likewise redacts git's own stderr, which quotes the URL back at you |

ship.js cannot spawn a subprocess (#69), so the remote arrives in the agent's
reply beside the `pwd` it is a property of — the same channel, and absent is
a refusal rather than a pass. `readWorktreeRemote` is the in-process reader
for every caller that *can* run git, and it is executed against real
`git init` fixtures rather than stubs.

- [x] SC-1441: lib/worktree-repo.ts contains [export function repoSlug] — a remote URL becomes owner/name or nothing across the scp https and credential-bearing forms with the LAST two segments taken so a group prefix or an embedded token is never read as the owner
- [x] SC-1442: test/worktree-repo.test.ts contains [wf_5e3ed885-98c replayed - the other project's worktree is refused] — the incident is driven through both copies of the decision and the refusal names the worktree the repo it belongs to and the repo the run targets because an operator who has to open the transcript has lost the incident
- [x] SC-1443: lib/worktree-repo.ts contains [export function worktreeIdentityViolations] — a row with no worktree path is skipped because a non-isolated spawn has none while a row WITH a path and no remote is refused so "never asked" and "asked and did not answer" stay different states
- [x] SC-1444: test/worktree-repo.test.ts contains [a checkout with no origin is an error] — the reader runs against real git init fixtures including a directory that is not a checkout at all because a reader asserted only against stubs is a reader nobody has watched read anything
- [x] SC-1445: test/worktree-repo.test.ts contains [the same spawn resolves to the same root from two different cwds] — the cwd-independence property is executed by running the real briefedAgent block from two working directories rather than argued from the presence of the pin
- [x] SC-1446: workflows/ship.js contains [VERIFY BUILD regression produced no work] — a remediation round that implemented nothing ends the run and carries the agent's own findings because the branch it replaces had no else at all and spent a security review and a container rebuild discovering that
- [x] SC-1447: test/worktree-repo.test.ts contains [a remote with no credential is left exactly as it was] — the refusal quotes the remote it could not parse and refusals are logged so the authority's credential is blanked first while an ordinary URL comes back byte-identical because a redactor that mangled every URL would make every refusal unreadable
- [x] SC-1448: workflows/ship.js contains [COLLECT REFUSED] — the check runs again where both implement paths have converged and every worktree the run will commit from is known because the per-spawn checks live inside the two implement functions and a third path added later would be committed from without passing either

#### What was broken to prove it (SC-1441..1448)

Run and counted over `test/worktree-repo.test.ts` (90 tests). Every mutation
that touches the decision was applied to BOTH copies, since changing one
alone is caught by the parity matrix for the wrong reason. None is left in
the tree:

| Mutation | Red |
|---|---|
| `worktreeIdentity` short-circuited to `match` | 23 of 90 |
| the no-expected-repo branch disabled — the widest fail-open | 2 of 90 |
| an unreported remote treated as a match | 4 of 90 |
| the slug comparison made case-sensitive | 8 of 90 |
| the slug taking the LAST two segments instead of exactly two | 8 of 90 |
| the refusal quoting the remote unredacted | 2 of 90 |
| redaction narrowed back to the authority alone | 3 of 90 |
| the redactor blanking every URL rather than the credential | 7 of 90 |
| the reader returning git's stderr unredacted | 1 of 90 |
| `requirePath` ignored inside the collector | 3 of 90 |
| the collection boundary dropping `requirePath` | 1 of 90 |
| the terminal payload carrying the remote unredacted | 1 of 90 |
| the mismatch refusal stops naming either slug | 5 of 90 |
| `opts.cwd = PROJECT_ROOT` deleted from ship.js | 4 of 90 |
| the call site in `runImplement` short-circuited | 1 of 90 |
| the collection boundary's collector short-circuited to `[]` | 6 of 90 |
| the collection boundary refusing every run — the opposite failure | 2 of 90 |
| the Verify regression `else` removed — the defect verbatim | 1 of 90 |

**One zero, and it was mine.** `drop-collect-boundary` first scored **0 of
74**. SC-1448 was declared with source-text assertions only, and the
mutation deleted the log line those assertions did not read while the
refusal itself went unobserved — a criterion certifying a guard nobody had
watched run. The block now carries `COLLECT-IDENTITY` markers, is extracted
and EXECUTED against planted agent results, and is asserted reachable at
`Program` level so a wrapper outside the markers cannot switch it off
(#266's lesson, applied one PR later). With the collector short-circuited
the mutation scores 6.

The single-red rows are one apiece because each is a single named wiring
property; a mutation that turned several red would mean the rows were not
independent.

**What this does NOT fix, stated plainly.**

The agent runtime still resolves isolation against the session cwd — rungate
cannot change that from inside a workflow. What changes is that a run which
lands in the wrong repository now stops, names both repositories, and
preserves its worktrees, instead of refusing silently and proceeding to ship.

**And the reading inside the ship path is self-reported.** ship.js has no
subprocess (#69), so the remote it compares is the one the agent said it
read. An agent that is wrong about where it is, or that reports the repo
from its brief rather than from `git`, passes. The incident this fixes had
exactly the shape the self-report catches — the agent noticed and said so —
but a guard whose input the subject supplies is weaker than one that looks
for itself.

`readWorktreeRemote` is the unforgeable half and **nothing in the ship path
calls it**, because nothing in the ship path can. The place that can is a
gate, which runs as a real subprocess with the worktree on disk. That is
filed as **#414** rather than built here: it needs a gate contract and a
schema field, which is a different change from this one.

### No PR at all when a container is configured (#254/#266, 2026-10-14)

`workflows/ship.js` had exactly one `pr-upsert` call site and it lived inside
the ELSE arm of `if (containerConfig)`, batched with that arm's
`environments.prod` write. A consumer that configures a container took the
other arm, `prStep` stayed null, no PR was ever opened, and the run went on to
report a shipped status over a pushed branch nobody could review. #252's whole
draft lifecycle — `--draft`, `pr-ready`, `prReadiness` — is unreachable from
that arm, so the defect also silently disabled the fix that exists to stop an
unearned PR looking mergeable. DailyBriefDashboard's hard "7776 before 7777"
rule REQUIRES container config, so this was not a latent path: it was the path
the next consumer was going to take.

Phase 1 hoisted the step to one call site below the conditional and proved the
placement by brace-matching. Phase 2 (#266) adds the guard for the shape
brace-matching **cannot** see.

**Placement and reachability are different questions, and the first does not
imply the second.** `prPlacementViolations` asks whether the call site sits
outside both arms of one conditional. A wrapper placed anywhere else — `if
(false) {` above the marker pair, `}` below it — leaves the call site outside
those arms, leaves the extracted bytes byte-identical, and leaves the step
unreachable. Measured on 2026-10-08 against three other marked blocks:
BLOCKING-GRADES 19 pass / 0 fail, SECURITY-DECISION 113 pass / 0 fail,
COMMIT-STATE-GUARD 52 pass / 0 fail. Three suites, 184 tests, nothing red.
`assertMarkedBlockReachable` reads the block's position in the parsed program
instead, and REACH-3 asserts BOTH halves over one input: the text check goes
green on the mutant and the reachability check refuses it.

**#266 asked for two hand-maintained marker lists and got one.** Its AC-6 was
`grep -c '"PR-UPSERT-CALL"' test/reachability-refusals.test.ts == 2` — the
name present in the positive-control list and in the regression list, "not
just one of them". Two lists have a failure mode one does not: a block added
to the first and forgotten in the second is half-covered and reads as covered.
The lists are now one `REAL_BLOCKS` constant both groups iterate, and the
property AC-6 was buying is asserted directly — the shared-list loop appears
exactly twice, with the needle assembled from fragments so the assertion's own
source line is not one of its matches.

**AC-8's evidence command passed before any of this work was done.** It asked
for `grep -cE 'SC-66[4-8]' specs/HARNESS-STANDARD.md >= 5`, and SC-664..668
were allocated to `collectTarget` and `acDiscoveryViolations` between #266
being filed and being worked. The command returned 5 against a spec with no
#254 section in it at all — a check that passed because of what it never
looked at, in an acceptance criterion, which is the one place that is supposed
to catch them. The criterion's intent is recorded here under fresh numbers.

- [x] SC-1436: test/ship-pr-on-every-path.test.ts contains [PR-EVERY-PATH-1: the real ship.js places it on a path every run reaches] — the call site is found by brace-matching two offset-preserving views of the source rather than grepped because "ship.js contains pr-upsert" stays true for the broken arrangement and for a comment that merely mentions it
- [x] SC-1437: test/ship-pr-on-every-path.test.ts contains [MUTANT-1: the step moved back inside the else arm is refused] — the arrangement #254 was filed about is rebuilt and run through the same checker in the same test as the real source so the refusal is paired with an acceptance over one input and a renamed step aborts the build instead of reading as caught
- [x] SC-1438: test/ship-pr-on-every-path.test.ts contains [ENV-3: neither arm opens a PR] — both arms keep their own environments write because the ship gate refuses on missing environments fields and the two arms record different things so hoisting the PR step must not take the env write with it
- [x] SC-1439: test/ship-pr-on-every-path.test.ts contains [REACH-2: its enclosing chain is exactly Program] — the block's position is read off the parsed program rather than its text because a wrapper outside the marker comments leaves the extracted bytes identical and every text-based check green while the step never runs
- [x] SC-1440: test/reachability-refusals.test.ts contains [both groups are driven by the same list] — the positive control and the measured regression iterate one constant so a block covered by the accept case and not by the refusal case is impossible rather than merely unlikely

#### What was broken to prove it (SC-1436..1440)

Run and counted over `test/ship-pr-on-every-path.test.ts` +
`test/reachability-refusals.test.ts` (80 tests). None is left in the tree; all
were applied and reverted:

| Mutation | Red |
|---|---|
| the PR step wrapped in `if (false)` outside the markers — the defect #266 names | 4 of 80 |
| the same wrapper in a truthy form (`if (globalThis.nope)`) | 4 of 80 |
| the step relocated into an uncalled `async function` | 4 of 80 |
| the `PR-UPSERT-CALL-START` marker deleted | 4 red, and 15 tests never registered |
| the `PR-UPSERT-CALL-END` marker deleted | 4 red, and 15 tests never registered |
| `PR-UPSERT-CALL` dropped from `REAL_BLOCKS` | 1 of 80 |
| the positive-control group given its own hard-coded list again | 1 of 80 |

The two marker deletions are reported with their missing registrations rather
than as a bare count: `wrapOutsideMarkers` throws while the `describe` body is
being evaluated, so the regression group never registers. That is the loud
failure the rule asks for — a harness whose target moved must abort, not
quietly run zero assertions — but it means the red count alone understates it.

**The mutation harness destroyed its own subject once, and it was mine.** The
revert step ran `git checkout -- <files>` over work that was not yet
committed, so the first measured count was followed by the markers and the
shared list vanishing. Re-applied, and the remaining six mutations were run
against a WIP commit. The rule's standing advice — commit a checkpoint before
mutating — is there for this.

### A prohibition became a work plan (#306, 2026-10-14)

#274 attempt 4 (`wf_b3714a40-bb7`). The goal said, under a heading in
capitals, "ALSO DO NOT FIX, ALREADY FILED: #295 … leave it there". The
`to-issues` decomposer emitted a sub-issue whose `filesToModify` was
`gates/schema.ts`, `lib/evidence-prevalidator.ts`, `gates/SCHEMA-GUIDE.md` —
the three files you would touch to fix #295, and nothing to do with #274. The
agent did what its file list permitted: it wrote the test slot it was given,
asserting the field is absent and commenting *"That absence is #295"*, and it
also added the field. One sub-issue documented the defect and removed it, and
the run refused on its own contradiction.

The attribution is the plan's. The collection guard (#178, SC-413) refuses
any file no sub-issue claimed and did not refuse these, so they were in the
plan. An agent handed `gates/schema.ts` has been told, by the strongest
signal the system sends, that the file is in scope.

**#306's own diagnosis was wrong in a way that would have shipped the defect
as its remedy.** The issue proposes a deny-list because "the goal already
names them". It does not: the prohibition names an ISSUE and three code
symbols — `prevalidationViolations`, `reading.broken`, `acs[].status` — and
no path. The paths came from `discovery.filesToModify`, which `ship.js` hands
the decomposer verbatim as "Files to modify". A deny-list built on that
premise returns `[]` for the exact run that motivated it, and passes.

So the guard has two outputs. `deniedFiles` is enforced;
`unresolvedProhibitions` is the prohibitions that named an issue and no file,
which cannot be enforced and are logged. "Nothing was denied" and "nothing
could be denied" are the same empty list, and only the first is a clean run.

Enforced at two points, because they fail differently:
`discovery.filesToModify` is filtered before the decomposer is prompted,
which is where #274's contamination entered, and the decomposer's own
sub-issues are checked after, because a decomposer can name a file discovery
never listed.

- [x] SC-1423: test/scope-denylist.test.ts contains [#274's real goal denies nothing - and says so] — a prohibition naming an issue and no file is reported as unenforceable rather than returning an empty deny-list that reads as a clean run because those two are the same empty list and only one of them is fine
- [x] SC-1424: lib/scope-denylist.ts contains [export function prohibitions] — the marked region is the paragraph so a bolded lead-in still covers the sentences under it and a marker near the top does not put the whole goal out of bounds
- [x] SC-1425: lib/scope-denylist.ts contains [export function denylistViolations] — a plan claiming a denied file is refused by name and the in-scope sub-issue in the same plan keeps every file it asked for so the refusal cannot be satisfied by emitting nothing
- [x] SC-1426: test/scope-denylist.test.ts contains [SC-1426: ship.js's inlined copy and the library agree] — the workflow cannot import so the decision exists twice and both copies are run over one shared matrix because an extracted function that never matched its inlined copy is how computeACHash drifted

#### What was broken to prove it (SC-1423..1426)

Run and counted over `test/scope-denylist.test.ts` (43 tests). Each mutation
was applied to BOTH copies, since changing one alone is caught by the parity
matrix for the wrong reason:

| Mutation | Red |
|---|---|
| `deniedFiles` short-circuited to `return []` | 6 of 43 |
| `unresolvedProhibitions` short-circuited to `return []` | 2 of 43 — the unenforceable case stops being distinguishable from a clean goal |
| the path detector's separator made required again | 1 of 43 |
| the extension list widened to any `.[a-z]+` | 4 of 43 — `reading.broken` and `acs[].status` start reading as files |
| the paragraph bound removed, so one marker covers the whole goal | 4 of 43 |
| basename matching removed from `matchesDenied` | 1 of 43 |
| `ship.js` stops checking the decomposer's output (`planViolations = []`) | 1 of 43 |
| `normalisePath` short-circuited to `return String(p)` | 1 of 50 |
| the `..` segment never collapsing | 1 of 50 |
| `scopeContradiction` short-circuited to `return null` | 1 of 50 |
| the empty-entry guard in `matchesDenied` removed | 1 of 50 |

(The last four are over 50 tests; the first seven over 43, before the
security-review cases below were added.)

**A zero, and it was the guard's rather than the suite's.** The separator
mutation first scored **0 of 35**. The code said the `/` was what separated
`gates/schema.ts` from `reading.broken`, and the three negative cases written
to defend that claim were all excluded by the EXTENSION instead — they never
reached the separator. Chasing the zero showed the rule was not merely
unproven but wrong: requiring `/` silently missed every root-level file a
goal might name, so "do not touch `package.json`" parsed to nothing. The
detector now accepts a bare filename, `matchesDenied` gives it basename
semantics while a full path still matches only itself, and both directions
are cases.

**Two more zeros, from the commit security review's fixes, and both were
mine.** `matchesDenied`'s empty-entry guard scored 0: with `denied === ""`
the basename arm already answers false, so the four cases written for it
never reached the guard at all. The input that does is `matchesDenied("",
"")` — without the guard both sides normalise to `""` and match. And the
`..` mutation scored 0 on its first run because the **mutation harness**
failed to apply to the `.ts` file (single-vs-double quotes) and reported a
result anyway, which is the silently-no-opping mutation harness
`.claude/rules/checks-must-be-able-to-fail.md` warns about, met in my own
tooling. Re-applied with an assertion that the text changed: 1 red.

None of the eleven mutations is left in the tree.

#### What the commit security review found (#306)

Three findings, all on `lib/scope-denylist.ts`, all the same hazard from
different angles: a guard whose entire value is a string comparison is only
as good as its normalisation and only as safe as its direction.

- **guard-bypass-path-normalization.** `./gates/schema.ts`, `gates//schema.ts`,
  `gates/./schema.ts` and `gates/sub/../schema.ts` are four spellings of one
  file that `===` read as four. Three walked past the deny-list.
  `normalisePath` now collapses them, and a leading `..` is deliberately kept
  because there is nothing above the root to collapse into.
- **untrusted-input-control-manipulation.** Goal text comes from an issue
  body and nothing validates it. What limits the damage is DIRECTION: a
  deny-list only ever narrows what an agent may write, so a hostile goal can
  deny progress but cannot grant access. Recorded rather than fixed, because
  it is the safe direction and a refusal here would be worse.
- **fail-open-detection.** The unsafe half of the above is silence. A goal
  that denies every planned file leaves an empty `filesToModify`, and an
  empty plan is indistinguishable from a run with nothing to do — work
  refused, reported as work completed. `scopeContradiction` says so.

A second review, on the committed change, found three more. The one that
mattered is **incomplete-guard-field-mismatch, and it was a complete
bypass**: `filesToModify` is not the only field carrying paths. Every AC's
`contextFiles` is interpolated into the to-issues prompt, and `acContextFiles`
reads those same entries off disk into the implementer's context excerpts. So
a denied file was struck off the file list and then re-advertised to the
planner and handed to the agent — which is also what made the prompt's OUT OF
BOUNDS paragraph **decorative-control**, the review's other finding. Both are
fixed by filtering `contextFiles` in the same block, on both shapes the field
takes (a bare string and `{path, reason}`), and the position of the strip
relative to the two readers is asserted rather than assumed. Mutation:
disabling the `contextFiles` filter turns 1 of 52 red.

A third review, on the pushed commits, found the one that mattered most:
**guard-not-reapplied-on-rediscovery**. The verify gate calls
`runDiscovery('Verify gate found ACs were wrong: …')`, which replaces
`filesToModify` and `acs` wholesale. The deny-list was applied once after the
first discovery, so it held for one pass and **silently lapsed on the
second** — and the re-run is the path a FAILING run takes, which is the worst
one to leave open. The application moved inside `runDiscovery` as
`applyScopeDenylist`, declared once, so every discovery is filtered. The list
is still computed separately for the prompt, which is pure and cannot drift.

| Mutation | Red |
|---|---|
| `applyScopeDenylist` never called | 2 of 53 |
| the call moved back outside `runDiscovery` | 1 of 53 — the exact defect the review found, reintroduced verbatim |

A fourth review found the one that made all the others moot: **the guard was
reading a field that does not exist.**

`applyScopeDenylist` read `disc.issueGoal`. `DISCOVERY_SCHEMA` has no
`issueGoal` key — the field is on `goalData`, a different object — so
`deniedFiles('')` returned `[]` on every run and **nothing was ever denied.**
A completely dead control, shipped as the fix for a class of dead controls,
and the mistake was copied from `ship.js`'s own pre-existing line
`Parent issue #${ISSUE}: ${discovery.issueGoal || 'see ACs below'}`, which
had the same bug and had been silently falling back to 'see ACs below' for
its whole life. Both are fixed.

The test for it is asserted against the **schema**, not by grepping for the
right spelling, because the wrong spelling is also a valid-looking string: it
reads `DISCOVERY_SCHEMA`'s text, asserts `issueGoal` is absent from it, and
asserts nothing in the file reads `discovery.issueGoal`.

Two more from the same round, both real:

- **The guard ran after the data was persisted.** `writeACs` serialises
  `discovery.acs` into `workflow-state.json`, which is the copy every gate
  reads. Applying the filter at the end of `runDiscovery` cleaned the
  in-memory object and left the persisted one carrying denied
  `contextFiles`. Moved ahead of the write.
- **The contradiction warned instead of refusing.** Every planned file being
  out of scope means the goal is unshippable as written, and carrying on
  produces an empty implementation that reads downstream as a run with
  nothing to do. It now returns `false` through `runDiscovery`'s existing
  refusal channel.

| Mutation | Red |
|---|---|
| the goal text read off `discovery` again | 3 of 56 |
| the contradiction downgraded back to a warning | 1 of 56 |
| the filter moved back after `writeACs` | 1 of 56 |

**Four review rounds on one change, each finding a real reachable bypass of
the previous fix, and the last one finding the guard had never run at all.**
That is the finding worth keeping. Three properties separate the version that
works from the four that did not, and none of them is about the deny-list
logic, which was correct throughout:

1. It reads from the object that carries the data, proven against the schema
   rather than by eye.
2. It is applied at **one choke point** — inside `runDiscovery`, before the
   state is written — rather than at each site that reads.
3. Its failure mode is a refusal, not a log line.

A guard assembled field-by-field from the one example that motivated it keeps
missing the next field. The field list was never the problem.

A fifth round re-reported `dead-security-control / wrong-source-field`, which
on inspection was the reviewer reading the diff that fixes and documents it
rather than a new instance. Checked rather than assumed: every `discovery.x`
read in `ship.js` was reconciled against `DISCOVERY_SCHEMA`'s declared keys
and none is undeclared. That reconciliation is now a test rather than a
one-off command, because it is the general form of the defect and the next
instance will have a different field name — `issueGoal` was one. Mutation:
reintroducing a read of an undeclared field turns 2 of 57 red.

### The release job went red over a release that worked (#407, 2026-10-14)

`v0.3.0` published cleanly — `dist-tags.latest` is `0.3.0`, `npm install
rungate@0.3.0` pulls `bin/ lib/ prompts/ scripts/` — and the job still failed:

```
✓ Publish
X Postflight — the registry actually serves this version
RELEASE REFUSED: the registry's latest is 0.2.1, not the 0.3.0 this run was
cutting — the publish step did not take effect
```

The postflight read `registry.npmjs.org/rungate` about a second after `npm
publish` returned. That packument is CDN-fronted and eventually consistent, so
a read that close to the write can legitimately still serve the previous
`latest`. The publish was fine; the check was wrong.

**This is the inverse of the rule this file keeps citing, and it costs the
same thing.** `.claude/rules/checks-must-be-able-to-fail.md` is about checks
that cannot fail. A check that cannot reliably PASS gets the message wrong in
the other direction, and a red job over a green release is precisely how a
gate teaches the next reader that its red means nothing. Third instance of the
shape: #397's pre-push hook, #364's un-releasable minor bump, now this.

**The bound is the fix, not the retry.** Polling until green would be the
original defect wearing the fix's clothes. `awaitRegistryServes` reads at most
`POSTFLIGHT_ATTEMPTS` times with `POSTFLIGHT_DELAY_MS` between, a publish that
never lands still refuses, and the refusal says how long it waited — otherwise
"it refused" and "it did not wait long enough" read identically in a log and
the first thing anyone does is raise the number blind.

One sub-decision worth stating because it is a fail-open in miniature: a read
that throws with attempts remaining is retried, and the FINAL one rethrows.
`registryState` throws rather than returning an empty state precisely so that
"could not measure" cannot read as "nothing wrong"; swallowing the last throw
in the poll would put that straight back.

- [x] SC-1419: test/release-guard.test.ts contains [the workflow passes neither test knob - so the release waits for real] — the attempt count and delay are bounded defaults that clear the observed lag and still fit in a watched job and the workflow overrides neither so no release can shorten its own window to nothing
- [x] SC-1420: lib/release-preflight.ts contains [export async function awaitRegistryServes] — the postflight re-reads the registry when it serves a stale latest instead of refusing on the first read and it reports how many reads it took so a slow propagation is visible rather than inferred
- [x] SC-1421: test/release-guard.test.ts contains [a publish that never lands is still refused once attempts run out] — the poll is bounded so a publish that genuinely did not happen still refuses and the refusal names the elapsed wait because otherwise a refusal and an impatient read are indistinguishable in the log
- [x] SC-1422: test/release-guard.test.ts contains [a transient read error is retried - and the last one is not swallowed] — the retry is driven against an injected fetch and an injected sleep so the exhaustion branch runs on every suite without spending its wall clock and a registry that was never reachable throws rather than returning a verdict

#### What was broken to prove it (SC-1419..1422)

Run and counted over `test/release-guard.test.ts` (49 tests):

| Mutation | Red |
|---|---|
| the poll collapsed back to a single read (`const attempts = 1`) | 5 of 49 — the #407 scenario itself, both exhaustion cases, the transient-error retry, and the zero-attempt guard |
| the exhausted poll returning `refusal: null` | 4 of 49 — a publish that never landed waved straight through, which is this fix becoming the defect it replaced |
| the final read error swallowed instead of rethrown | 1 of 49 — a registry that was never reachable starts reporting a verdict |
| the zero-attempt guard disabled | 1 of 49 — a loop that runs no iterations returns no refusal, so a check that never ran reads as one that passed |

A fifth mutation was attempted first and is recorded because it is the trap
this whole section is about: `refusal: null ?? <message>` is a no-op, and it
scored **0 of 49**. A zero is a finding, and this one was mine, not the
suite's — the mutation never changed the behaviour. It was rewritten to
replace the message outright, which is the 4 above. None of the four is left
in the tree; all were run and reverted.

> **Superseded by #445.** `POSTFLIGHT_ATTEMPTS` no longer exists; the window
> is one constant, `POSTFLIGHT_BUDGET_MS`. The sentence this section defends
> — *the refusal says how long it waited* — survives, but the refusal itself
> does not: exhausting the budget now produces UNMEASURED. The reason is the
> next section, and it is that this section's fix was a bigger number rather
> than a different mechanism.

### A guard that stated a cause it had not established (#445)

`v0.4.0` published successfully on 2026-10-15 and the release job went red:

```
✓ Publish
X Postflight — the registry actually serves this version
RELEASE REFUSED: the registry's latest is 0.3.0, not the 0.4.0 this run was
cutting — the publish step did not take effect — read 10 times over 27s,
which is long enough that this is not the registry catching up
```

`npm view rungate dist-tags` returned `{"latest":"0.4.0"}` from the same
endpoint minutes later. **Both successful releases this project has ever cut
are recorded in GitHub Actions as failures** — #407 for `v0.3.0`, this for
`v0.4.0`, one day apart.

**The timeout is the smaller half.** #407 widened the read from one attempt
to ten over 27 seconds, and the propagation took longer than the new guess. A
second instance of the same failure one day later is evidence the approach
does not converge, not that the number needs raising again.

**The larger half is the last clause.** *which is long enough that this is not
the registry catching up* — the guard cannot know that. It read a stale value;
"the publish did not take effect" and "the packument has not propagated" are
indistinguishable from where it stands, and it picked one and reported it as a
finding. `.claude/rules/config-access.md` already names the right vocabulary:
a reading that could not be obtained is UNMEASURED, and `0`, `{}`, `null` and
`SKIP` are all indistinguishable from success while UNMEASURED is not. The
damage is #397's shape — a confident wrong diagnosis sends the next reader to
the wrong file, and the time after that, nobody believes the guard at all.

#### Three decisions, each of which could have gone the other way

**`versions`, not `dist-tags.latest`.** They are different facts and #364
conflated them. A version in `versions` has been published — `npm install
rungate@0.4.0` resolves — whatever `latest` points at, because a dist-tag is a
pointer that moves on its own schedule and can be aimed anywhere. So a landed
publish whose tag has not caught up is now a PASS that says so out loud, where
before it was a refusal naming a failed publish. This is the arm SC-829 had
backwards for its whole life.

**One predicate, consulted by both phases.** `registryServes` is the whole of
the question, and `preflightRefusal` asks it in the opposite direction rather
than keeping its own `versions.includes`. A second copy would have been the
fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`: two deciders
agreeing about the same input are behaviourally one guard, and mutating either
leaves the other holding the case up. The first draft of this fix had exactly
that, and the mutation table below is why it does not now.

**An unconfirmed publish still fails the job, with a different exit code.**
This is the decision SC-6 asked to be recorded, and it is a trade with a loser.
Against failing: two of two successful releases are recorded as failures and
that is the state this issue exists about. For failing: the postflight is the
only half of #364's design that cannot be satisfied by doing nothing, a release
is irreversible, and GitHub Actions gives a `run:` step no neutral outcome —
the only way not to fail is `continue-on-error`, which `test/release-guard.test.ts`
forbids outright because it turns the file back into a job that reports a
release it never made. So the job still goes red. What changes is that
`UNMEASURED_EXIT` (2) and `REFUSE_EXIT` (1) are different codes with different
prefixes — `RELEASE UNCONFIRMED` against `RELEASE REFUSED` — so "we know this
went wrong" and "we could not tell" stop being the same artefact, and the
message names `npm view rungate@<version> version` as the one thing to run
instead of leaving a reader to re-read the log.

- [x] SC-1647: test/release-guard.test.ts contains [a reading that does not carry the version is UNMEASURED and not a finding] — a stale read names both explanations and chooses neither rather than reporting that the publish did not take effect which is a cause the guard has not established and cannot establish from one reading
- [x] SC-1648: lib/release-preflight.ts contains [export function registryServes] — one predicate decides whether the registry holds the version and both phases consult it so a version present with a lagging dist-tag is a published release rather than a failed publish and there is one binding to mutate
- [x] SC-1649: test/release-guard.test.ts contains [nothing the guard can say claims the wait was long enough] — the sentence that was wrong on both releases is pinned absent from the source as well as from every message the guard can produce because a message assertion only covers the branches a test happens to drive
- [x] SC-1650: lib/release-preflight.ts contains [export const POSTFLIGHT_BUDGET_MS] — the whole poll window is one exported constant so widening it is one visible edit and the cadence cannot move it and the exhaustion case is driven on every suite run so widening cannot quietly disable the check
- [x] SC-1651: lib/release-preflight.ts contains [export function confirmCommand] — an unconfirmed publish names the one command that settles what the guard could not and says the publish may well have succeeded so the reader acts on the registry rather than on the job's colour
- [x] SC-1652: scripts/release-guard.ts contains [export const UNMEASURED_EXIT] — an unconfirmed publish stops the job through a different exit code than an established refusal so the two states are distinguishable to anything downstream and both are mutated by the harness so neither can pass for the other's reason

#### What was broken to prove it (SC-1647..1652)

Run and counted over `test/release-guard.test.ts` (57 tests):

| Mutation | Red |
|---|---|
| `registryServes` always `false` | 14 of 57 — both preflight duplicate cases, every postflight published case, and both script phases |
| `registryServes` always `true` | 17 of 57 — the other direction: preflight stops refusing duplicates AND every unconfirmed case starts passing |
| `postflightVerdict` short-circuited to `{published: true}` | 15 of 57 |
| the `note` arm removed, so a lagging dist-tag says nothing | 3 of 57 |
| the second explanation dropped from the unmeasured text | 2 of 57 — the guard goes back to naming one cause |
| `postflightAttempts` short-circuited to `1` | 6 of 57 — the poll collapses to a single read and the window constant stops being a window |
| the final read error swallowed instead of rethrown | 1 of 57 — a registry that was never reachable starts reporting a verdict |
| the non-negative budget arm dropped | 1 of 57 — a negative budget buys zero reads and falls out of the loop having measured nothing |
| `UNMEASURED_EXIT` set equal to `REFUSE_EXIT` | 6 of 57 |

None is left in the tree; all were run and reverted.

**Two predictions were wrong, both high, and both are recorded because the
discipline is to predict every row before running.**

`registryServes` always `false` was predicted at 13 and measured 14. The row
missed was *a refusal and an unconfirmed reading do not share an exit code*,
whose first half drives the PREflight — a test written for SC-6 that also
depends on the SC-1648 binding, which is the point of having one binding.

`UNMEASURED_EXIT` equal to `REFUSE_EXIT` was predicted at 3 and measured 6.
The three missed rows are every other test that calls `mutantScript()`: the
builder now cannot find `export const UNMEASURED_EXIT = 2;` and aborts with
`could not build the mutant`, which is the harness refusing rather than
no-opping. That is the property `.claude/rules/checks-must-be-able-to-fail.md`
asks for, met from a direction I had not counted.

Neither is the fourth shape. That signature is a row LOWER than predicted,
and a row higher means the binding reaches further than the prediction did.

### A rule the tooling actively undid (#450)

`project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md` are DA-owned (#296),
and the project says so in `CLAUDE.md` and in `.claude/rules/key-files.md`. The
generated `.git/hooks/pre-commit` ran `update-project-state.ts` and staged its
output **on every commit in every worktree**:

```sh
if [ -f "project-state.json" ]; then
  bun node_modules/rungate/scripts/update-project-state.ts --skip-tests 2>/dev/null || true
  git add PROJECT-STATE.md project-state.json 2>/dev/null || true
fi
```

So the rule was written down twice and the tooling mechanically did the
opposite. This is a worse shape than the one
`.claude/rules/checks-must-be-able-to-fail.md` is usually about: **an agent
that obeyed the rule perfectly still shipped the violation**, because the
staging happened after it had decided not to touch the file. A rule nothing
executes is inert; a rule something actively undoes is a trap. Observed while
committing #399 from a worktree — reverting the file and `--amend`ing rewrote
and re-staged it, so there was no way to comply short of `--no-verify`.

**The signal is the two git dirs, not a path heuristic.** The hook cannot tell
whether it is the DA. It can tell whether it is in a linked worktree:
`--git-dir` points at `.git/worktrees/<name>` there while `--git-common-dir`
points at the shared `.git`, and in the primary checkout the two are the same
answer. Both arms are driven by EXECUTING the generated hook against a real
`git worktree add`, not by reading its source — #397's post-mortem is that a
source-text assertion cannot notice the script's behaviour is impossible.

**The redeploy half, which the issue did not ask for and the fix is worthless
without.** `createGitHooks` wrote pre-commit only `if (!existsSync(preCommit))`,
so every checkout that already had one would keep the version that does the
forbidden thing — including this repo, where #450 was observed. The fix would
have reached nobody. The pre-push hook had this exact bug and #85 fixed it the
same way, so pre-commit now carries `PRE_COMMIT_MANAGED_MARKER` and overwrites
its own managed hook while leaving a hand-written one alone.

- [x] SC-1653: test/unit/git-hooks-generator.test.ts contains [stages none of the DA-owned state files from a linked worktree] — the generated hook writes and stages none of the three DA-owned files when --git-dir and --git-common-dir disagree and the case runs the hook against a real linked worktree rather than asserting on its text
- [x] SC-1654: test/unit/git-hooks-generator.test.ts contains [still stages them in the primary checkout] — the positive control sits in the same file as the suppression because a guard with no positive control is indistinguishable from one that never fires and a worktree test that over-matched would disable the update everywhere while staying green
- [x] SC-1655: test/unit/git-hooks-generator.test.ts contains [the skip is announced rather than silent] — the hook says it skipped and why and what to do instead and the primary checkout stays quiet so the message does not become noise that stops meaning anything
- [x] SC-1656: lib/scaffold/steps.ts contains [export const PRE_COMMIT_MANAGED_MARKER] — an existing managed pre-commit is overwritten so a fix to the hook reaches a checkout that already has one and a hand-written hook is preserved and reported instead

#### What was broken to prove it (SC-1653..1656)

Run and counted over `test/unit/git-hooks-generator.test.ts` (20 tests):

| Mutation | Red |
|---|---|
| the worktree check removed, so the update is unconditional again | 2 of 20 — the suppression and its announcement; the positive control is untouched, which is what makes it a control |
| the comparison inverted | 3 of 20 — both arms swap, which is the only mutation that moves the positive control |
| the skip stops announcing itself (`echo` → `:`) | 1 of 20 |
| a managed hook is never overwritten | 1 of 20 — the fix stops reaching any checkout that already has a hook |
| the managed-marker check dropped, so any hook is overwritten | 1 of 20 — someone's hand-written hook is destroyed |
| the primary branch stops staging `PROJECT-STATE.md` | 1 of 20 |

All six predicted correctly before running; none is left in the tree.

**A seventh scored 0 and the code changed because of it.** The first draft
resolved both git dirs through a `cd`-then-`pwd -P` round trip before
comparing, on the theory that one could come back relative and the other
absolute. Dropping the normalisation was **0 of 20** — both arms behave
identically without it, executed against a real primary checkout and a real
linked worktree. An unmeasured guard is indistinguishable from an absent one,
so it was removed rather than kept and explained. git hooks run from the
toplevel and both calls share a cwd; there was never a case that needed it.

**And the battery corrected a test, which is the other thing a zero is for.**
The redeploy case originally asserted `toContain('project-state: SKIPPED')`
on the rewritten file. Two mutations above — making the skip branch
unreachable, and replacing its `echo` with `:` — leave that phrase sitting in
the source, so the assertion was a source-text proxy that could not fail for
its own reason. It now compares the written hook BYTE FOR BYTE against a
freshly generated one, with a positive control that the fresh copy differs
from the stale one, and the behaviour is left to the cases that execute it.

### A criterion forbidding a call, ticked over that call (#395)

`gates/workflow.test.ts` read an issue's labels by shelling out to the
GitHub CLI. `GITHUB-API-MIGRATION-SPEC.md`'s SC-502 forbids exactly that,
and SC-502 was ticked over it for the criterion's whole life.

Two things kept it there, and both are shapes this file already names.

**The call spans a line break.** The exec is on one line and the command on
the next, so every search for the pattern — including the one in #327 that
classified SC-502 "satisfied, needs a test" — found nothing. A text
assertion cannot see across a newline. That is "a detector narrower than
what it detects", and it is the second time this month the same blindness
has cost a wrong classification.

**It was tagged `(behavioral)`.** A mechanical absence check wearing a
behavioural tag is exempt from every mechanical check in the repo, so
nothing ran it while its tick read as proof that something had. The
instance-level version of #328. The tag is removed here because the
criterion is mechanically checkable and always was.

Beyond the tick, the call interpolated the issue number and repo slug —
both out of workflow state — into a **shell command string**, and needed
`gh` installed and authenticated in whatever tree the gate ran in, which
for a gate is usually CI or a worktree. `getIssueLabels` takes them as
arguments. Writing the test turned up that `parseOwnerRepo` *validates* the
slug rather than merely passing it along, so a malformed one is refused
before it reaches the API — stronger than the issue asked for.

The decision moved out with the transport. `proveLabelViolation` is a
predicate over a list of names, because entangling it with a subprocess is
what made it untestable: nothing could exercise the rule without a network
and a `gh` binary, so nothing did.

**One thing deliberately NOT changed.** The gate still skips when the label
read fails, so an unreachable GitHub passes rather than refusing — a
fail-open, and the shape this whole rule is about. #395 is the transport,
and swapping a subprocess for Octokit must not also change which runs the
ship pipeline blocks. Filed as #405 rather than folded in.

- [x] SC-1416: lib/github.ts contains [export async function getIssueLabels] — an issue's label names are read through Octokit with the issue number and repo slug as arguments so neither is ever interpolated into a command string and the read can be driven against a stub
- [x] SC-1417: lib/prove-label-gate.ts contains [export function proveLabelViolation] — the close gate's label rule is one predicate over a list of names rather than four lines entangled with the subprocess that fetched them because a decision tangled with its transport is a decision nobody tests
- [x] SC-1418: test/prove-label-gate.test.ts contains [a blocked issue - end to end from the API payload] — the read and the decision are exercised together against a stubbed client rather than asserted by source text because a source-text search is precisely what could not see the call this removes

#### What was broken to prove it (SC-1416..1418)

Run and counted over `test/prove-label-gate.test.ts` +
`test/ticked-sc-cover.test.ts` (25 tests):

| Mutation | Red |
|---|---|
| the GitHub-CLI call reinstated in `gates/workflow.test.ts`, exec on one line and the command on the next | 1 of 25 — the shape that defeated every earlier grep, caught now because `GH_SPAWN`'s `\s*\(\s*` crosses the newline |
| `proveLabelViolation` short-circuited to `return null` | 3 of 25 — the refusal case, the substring boundary, and the end-to-end blocked issue |
| `getIssueLabels` returning `[]` for every payload | 6 of 25 — and the end-to-end case is among them, which is why it exists: an empty list is indistinguishable from a clean issue, so the predicate alone stays green |
| the exact match relaxed to `labels.some(l => l.includes(name))` | 1 of 25 — `needs-proven` read as both set and satisfied at once |

None is left in the tree; all four were run and reverted, and the file is back
to 25 pass.

### The first release attempt could not have succeeded (#364, 2026-10-14)

The guard worked. The suite in front of it did not, and the two together
made every minor and major bump **un-releasable** — which nothing noticed,
because the only version ever tried was a patch.

`addPaiHarnessDevDep` pins a consumer to `^<major>.<minor>.0` of the
harness, read from `package.json`. `test/scaffold-installable.test.ts` then
really runs `bun install` in a temp dir to prove the scaffold emits a
resolvable range rather than the `file:` path of #362. Both are correct in
isolation. Composed, the install case asserts that the TREE's version is
already on npm — and the release workflow runs the suite BEFORE the publish
step, with no `continue-on-error` and no conditional, deliberately, because
SC-831 and SC-832 assert there is no bypass.

So the check could not pass until the step it gated had already run.
Measured directly, on the registry:

| Tree version | Range emitted | Resolves |
|---|---|---|
| `0.2.2` | `^0.2.0` | yes — `0.2.1` satisfies it |
| `0.2.9` | `^0.2.0` | yes |
| `0.3.0` | `^0.3.0` | **no — nothing published in that range** |
| `1.0.0` | `^1.0.0` | **no** |

`0.2.2` would have published, by accident: zeroing the patch happens to land
on an already-published floor as long as the minor never moves. The tree had
carried `0.2.2` since 2026-09-19, so the defect was invisible for 719
commits and surfaced only when the version was corrected to `0.3.0` — a
minor, because 86 of the 90 `lib/` files in the tarball are new since
`0.2.1` and 613 exported symbols were added, which is not a patch.

This is the inverse of the rule this repo is organised around, and the same
shape as #397: **a check that cannot pass does the damage a check that
cannot fail does**, because the message is wrong either way. It is also a
phase error rather than a logic error — the ordering class #261 and #273 are
instances of — so the fix is to split it by phase rather than to weaken it.

The resolvability half now runs against a version that IS published, so it
keeps catching the `file:` regression it was written for. Whether the tree's
own range will resolve once shipped is a pure question with a pure answer: a
caret floored at a version's own minor is satisfied by that version.

- [x] SC-1412: lib/release-preflight.ts contains [export function satisfiesCaret] — one exported predicate answers whether a version satisfies a caret range and the 0.x rule lives only there because below 1.0.0 a caret is pinned to the minor rather than the major
- [x] SC-1413: test/scaffold-installable.test.ts contains [the range the scaffold emits is satisfied by the version that emits it] — the tree's own installability is proven without a registry so a release is never gated on the publish it is gating
- [x] SC-1414: lib/scaffold/steps.ts contains [export function addPaiHarnessDevDep] — the dependency range accepts an explicit version so the cases that really install can be driven over a published one while still going through the writer that produced the `file:` bug

#### What was broken to prove it (SC-1412..1414)

Run and counted over `test/scaffold-installable.test.ts` +
`test/release-guard.test.ts` (50 tests), not asserted. **Two of the four
scored zero on the first pass and both are closed rather than explained
away** — including the one the function's own docblock calls the whole point,
which is the self-reference this area keeps producing.

| Mutation | Red |
|---|---|
| `satisfiesCaret` short-circuited to `return true` | 3 of 50 |
| the 0.x upper bound replaced by `return vMaj === rMaj` | **0 → 1 of 50.** Every case compared versions differing in the MAJOR or below the floor, and the lower-bound check answers all of those before the 0.x branch is reached. The readings diverge only for a version at or above the floor whose minor has moved with a major of zero — `^0.3.0` against `0.4.0` — and nothing produced that pair |
| the caret pinned to the minor for ALL majors | 1 of 50 — the other side of the same branch, so "fix" it by pinning everything and `^1.2.0` stops admitting `1.5.0` |
| the lower-bound check deleted | **0 → 1 of 50.** Same cause from the other end: every case differed in the major or the minor, so the upper bound caught them alone. A version sharing the floor's minor and sitting below its patch — `^0.3.5` against `0.3.0` — is the only shape that isolates it |

None is left in the tree; all were run and reverted.

#### And then the release failed anyway, for a third instance of the class

With the above merged, `v0.3.0` was tagged and the job **failed at `bun test`
with two refusals** — and both guards were right.

This workflow checks out a TAG. A tag checkout is shallow and carries no
branches, so `origin/main` does not exist in it. Two checks measure against
that ref — the conformity allowlist ratchet (#302) and the project-state
currency check — and both refuse an unreadable base rather than reading it
as clean:

> the allowlist growth check could not read its base (`git show
> origin/main:.claude/conformity-allowlists.json` exited 128). This is
> UNMEASURED, not PASS: without a base, growth is invisible and the ratchet
> is decorative.

That is the rule working. The release stopped rather than shipping on a
ratchet that had measured nothing — the outcome #302 was written for,
arriving in the one pipeline nobody had run it in.

`ci.yml` has fetched that ref since it was written. `release.yml` never did,
because it was authored against the publish question and not against the
suite it runs. **Two pipelines, one property, and only one of them knew** —
the same divergence #400 records between the two path validators, and the
reason "the published artifact is tested before it ships" was not the
guarantee it read as: the suite could not complete in that environment at
all.

The release's fetch deliberately does NOT carry CI's `|| echo WARN`. A PR
that cannot reach main should report UNMEASURED and carry on; a release is
irreversible, so "could not measure" has to stop the pipeline where it
happened rather than three steps later as a test failure that reads like a
code defect.

- [x] SC-1415: test/release-guard.test.ts contains [nothing fetches origin/main so the ratchets cannot read their base] — the release workflow fetches the comparison base before the suite runs and does so without a fallback because the one pipeline that cannot be undone is the one that must not tolerate an unmeasured ratchet

What was broken to prove it, over `test/release-guard.test.ts` (36 tests):

| Mutation | Red |
|---|---|
| the fetch step deleted | 2 of 36 |
| the fetch moved after `bun test` | 1 of 36 — presence alone is not the property; order is |
| CI's `\|\| echo WARN` appended to it | 1 of 36 — copying the other pipeline's line verbatim is the likeliest regression, and it reintroduces a fail-open into the one place that cannot have one |

None of the three is left in the tree; all were run and reverted.

#### What was broken to prove it (SC-828..832)

Run and counted over `test/release-guard.test.ts` (34 tests):

| Mutation | Red |
|---|---|
| the comment stripper drops everything | 7 of 34 |
| `preflightRefusal` always allows | 6 of 34 |
| `REFUSE_EXIT` zeroed in the real source | 6 of 34 |
| the exit constant renamed | 5 of 34 — every mutant-building case throws "could not build the mutant" |
| the comment stripper stops stripping — **the original false positive, restored** | 5 of 34 |
| `postflightRefusal` always allows | 4 of 34 |
| the duplicate-version check removed — **the no-op the issue named** | 4 of 34 |
| postflight stops comparing `latest` to the tree version | 3 of 34 |
| `registryState` reads only dist-tags, not the version list | 3 of 34 |
| the tag comparison removed | 1 of 34 |
| the semver shape check removed | 1 of 34 |
| postflight accepts a registry with no `latest` | 1 of 34 |
| `registryState` reports an empty registry instead of throwing | 1 of 34 |
| the script stops refusing on a registry error | 1 of 34 |
| the script stops calling `preflightRefusal` | 1 of 34 |
| the script stops calling `postflightRefusal` | 1 of 34 |
| WORKFLOW: `continue-on-error` added to the publish step | 1 of 34 |
| WORKFLOW: the publish step put behind `if: false` | 1 of 34 |
| WORKFLOW: the postflight step deleted | 1 of 34 |
| WORKFLOW: the preflight step deleted | 1 of 34 |
| WORKFLOW: the suite moved after the publish | 1 of 34 |
| WORKFLOW: the tag interpolated straight into the run script | 1 of 34 |
| WORKFLOW: the guard pointed at another registry | 1 of 34 |
| WORKFLOW: provenance dropped | 1 of 34 |
| WORKFLOW: the `id-token` permission dropped | 1 of 34 |
| WORKFLOW: the tag trigger loosened to every push to main | 1 of 34 |
| WORKFLOW: `setup-bun` unpinned back to a movable tag | 1 of 34 |
| WORKFLOW: `checkout` unpinned back to a movable tag | 1 of 34 |
| the scaffold starts writing `release.yml` | 1 of 34 |

**Twenty-nine mutations, no zeros.** That is worth stating because the two
preceding issues each produced one: #365's depth bound and #370's SCOPE list.
Nothing here is a branch no input can distinguish.

The sixteen 1s are not weak rows — each is a distinct way for the pipeline to
report a release it did not make, and one case is exactly the right number of
cases to be watching for it. The rows that matter most are the two stripper
mutations: dropping everything turns 7 red, and *not* stripping turns 5 red.
A detector that shrinks its own view has to be pinned from both sides or it
is indistinguishable from blindness.

None is left in the tree; all were run and reverted.

#### Pinned actions, because this job holds the credentials (security review)

The commit security review found the publish job using `oven-sh/setup-bun@v2`
— a third-party action referenced by a **movable tag** in a job carrying
`NPM_TOKEN` and `id-token: write`. The tag is the action publisher's to
repoint at any time, so that is a path to both the token and to provenance
signing. The finding was correct and is fixed here rather than filed.

Scoping the token to the publish step is **not** a mitigation: an earlier step
runs in the same workspace and can poison what the later one executes. Every
`uses:` is now a 40-character commit SHA with the human-readable version in a
trailing comment, and a test asserts the property rather than the three lines,
so a fourth action cannot arrive unpinned.

`ci.yml` and `gates.yml` are also unpinned. They are a **different** case —
no secrets, and both are harness-generated, so the fix is a generator change
affecting every consumer. Filed separately rather than absorbed here.

#### What this does NOT do

**No release has been cut.** This builds the pipeline and the guard; running
it is an outward-facing, irreversible action that needs Jason's authorization
and an `NPM_TOKEN` secret that does not exist yet. Until a tag is pushed, npm
still serves `0.2.1` and `SUCCESS.md`'s distribution standing is still
accurate in saying so.

So #364's three suggested fixes land as: (1) done, (2) **not done — needs
authorization**, (3) done by #366. The issue should stay open on step 2.

---

### Stop predicting the command; read the outcome (#144)

`IssueCloseGuard` is a `PreToolUse` hook that receives the TEXT of a Bash
command and must decide whether that command will close a protected issue.
**Five consecutive security-review rounds on 2026-10-06** each found a real
differential between what it believes and what the shell plus `gh` actually
do. Each was fixed. Each fix was followed by another round.

To be correct it would have to reimplement shell word-splitting, quoting,
expansion and aliasing, plus `gh`'s own flag parser and its config. The class
is "every way to close a GitHub issue from a shell", and that is not
enumerable from a regex over a string: `gh api -X PATCH repos/o/n/issues/23
-f state=closed` mentions neither word the hook looks for, and neither does a
wrapper script, an alias, `xargs`, curl, or the web UI.

**Jason's decision, 2026-10-08: Option C.** The hook stays as fast feedback
and *stops being a security control*. The control moves to an outcome check,
because the outcome is enumerable and the command string is not.

#### The reclassification is the important half

As long as the hook is *described* as a boundary, every security review is
correct to keep finding bypasses, and each round is cheap to generate and
expensive to answer. Writing the scope into the source is what ends that loop
— not another round of pattern tightening. The hook's docblock now says it is
a speed bump and not an authorization boundary, names the forms it will never
catch, and points here. **AC-5 makes that falsifiable: a new review round
opened against the parser means the reclassification did not take, and *that*
is the defect rather than the bypass.**

Fitting it in cost real estate. SC-371 caps a hook at 150 lines and counts
prose, so the historical narratives for #143 and #140 were compressed to
their operative warnings and their detail left here, where the rest of this
history already lives. Nothing was deleted that a reader needs at the call
site.

#### What counts as a record, and why it is not workflow-state.json

The issue says "closed with no `workflow-state.json` record". That file is
the right idea in the wrong place: it lives under `~/.rungate/{slug}/run/`,
is never committed, and is invisible to the scheduled CI job doing the
checking. A control that can only run on one laptop is the same fail-open as
#140.

So the record is the pipeline's own outcome, which the API does hold.
GraphQL's `ClosedEvent.closer` resolves to the Commit or the PullRequest
responsible, and to `null` when GitHub has nothing to attribute the close to
— which is every hand-typed close, whatever tool typed it. One query, no
per-issue timeline call, and a binary discriminator that does not care how
the close was phrased.

**A `## Completion Report` comment was considered and rejected on evidence.**
`hooks/lib/comment-template.ts` already defines that template, so it looked
like the natural record. Checked against thirteen shipped issues — #296,
#307, #224, #235, #239, #194, #252, #273 and the five below — **not one
carries such a comment.** The template validates the format of a comment
nobody posts. Building the control on it would have been a check that could
not fail.

#### The ratchet, and the number it banks

Run read-only against this repo on 2026-10-13 with no epoch, the audit
reported **19 of the last 100 closed issues**. Spot-checking #344, #343,
#152, #274 and #141 found no merge commit, no closing PR and no Completion
Report on any of them, so these are **true positives, not a broken
detector** — nothing in this repo has ever written a durable record of a
hand-typed close, which is #144's point restated as a measurement.

Flagging all nineteen on day one is the behaviour AC-4 warns about: a check
that arrives with a backlog nobody asked for gets switched off. So
`AUDIT_EPOCH` is `2026-10-13`, the number is banked here rather than applied
to the tracker, and the control ratchets forward. With the epoch in force the
live run is **0 of 100** — and the same run before the epoch was 19, which is
what makes the zero a reading rather than a silence.

Lowering the epoch is how someone audits history on purpose. Raising it is
how someone hides a finding, so it is a constant in version control and not a
flag with a default. An absent or unparseable close date is **not** treated as
old, because a malformed reading would otherwise be the cheapest way past the
audit.

#### Label, do not reopen (AC-3)

The action is to apply `closed-without-ship` and report; `--reopen` exists but
is off, and even when on is scoped to the issues the hook itself protects.
Three reasons:

1. The audit is new and its false-positive rate is unmeasured. A control that
   overrules people before it has earned trust gets switched off.
2. A label is queryable, so the control's own hit rate is measurable over
   time. Reopening changes the state that makes the finding findable.
3. Reopening does not restore the gate. It restores the issue. What is
   actually wanted is a human looking.

`closed-by-hand` (the exemption) and `closed-without-ship` (the finding) are
deliberately different words. Collapsing them would let the audit silence
itself on its second run — apply the mark, then read its own mark as an
exemption.

The script is **read-only by default**; `--apply` is required to write
anything. But `--apply` does not govern whether the run is RED: findings exit
non-zero either way, because the scheduled job runs read-only and letting
that exit 0 would leave it green in exactly the case it exists for. That was
the first version of this file, and the test caught it.

#### What this deliberately does not catch

A close attributable to the *wrong* commit. On 2026-10-08 a commit body
reading "not yet fixed: #178" auto-closed #178; that close has a `commit_id`,
so this audit passes it. Attribution is not authorization, and pretending
otherwise would be a detector wider than what it detects. That is #178's own
defect; this control is about closes with no attribution at all.

#### These SCs were renumbered

The issue specifies SC-610..613. All four ids were already taken in this file
by unrelated criteria when it was written on 2026-10-08, so the content is
kept verbatim and the ids are SC-833..836.

- [x] SC-833: lib/issue-closure-audit.ts contains [closedWithoutRecord] — ONE exported function lists issues closed with no record, reading the *outcome* from the API rather than predicting it from a command string. A second comparison of the same facts elsewhere would survive any mutation of this one
- [x] SC-834: lib/issue-closure-audit.ts contains [AUDIT_EPOCH] — the ratchet's start date is a constant in version control, so a finding cannot be hidden by forgetting a flag, and an unparseable close date is not treated as old
- [x] SC-835: hooks/IssueCloseGuard.hook.ts contains [not an authorization boundary, speed bump] — the hook's own source states its scope, so the next review grades it as fast feedback and stops generating bypass rounds (#144 AC-5)
- [x] SC-836: test/audit-issue-closures.test.ts contains [a close the hook cannot see is caught by the audit, a close the pipeline made is left alone] — the audit executed against both shapes, with the positive control proving it does not simply flag everything

#### What was broken to prove it (SC-833..836)

Run and counted over `test/audit-issue-closures.test.ts` (34 tests):

| Mutation | Red |
|---|---|
| `closedWithoutRecord` returns nothing — the audit finds no closes | 9 of 34 |
| `REFUSE_EXIT` zeroed in the real source | 5 of 34 |
| `closedWithoutRecord` flags EVERY closed issue — **the AC-1 failure** | 4 of 34 |
| the exit constant renamed | 4 of 34 — every mutant-building case throws "could not build the mutant" |
| the `not_planned` exemption removed | 3 of 34 |
| `toClosedIssue` stops reading the PullRequest closer | 3 of 34 |
| the `closed-by-hand` exemption removed | 2 of 34 |
| the epoch cutoff removed — day one reports nineteen | 2 of 34 |
| the empty report prints nothing | 2 of 34 |
| `toClosedIssue` stops lowercasing `stateReason` | 2 of 34 |
| the already-reported guard removed — the audit re-flags its own findings | 1 of 34 |
| an unparseable close date treated as old — **the cheapest bypass** | 1 of 34 |
| `EXEMPT_LABEL` and `FINDING_LABEL` collapsed into one word | 1 of 34 |
| `shouldReopen` ignores the flag and always reopens | 1 of 34 |
| `shouldReopen` reopens every finding, not just protected ones | 1 of 34 |
| `toClosedIssue` stops reading the Commit closer | 1 of 34 |
| `toClosedIssue` stops reading `closedAt` | 1 of 34 |
| findings no longer make the run red | 1 of 34 |
| the script writes labels without `--apply` | 1 of 34 |
| the fixture read stops refusing on error | 1 of 34 |
| WORKFLOW: the schedule removed | 1 of 34 |
| WORKFLOW: `issues: write` dropped | 1 of 34 |
| WORKFLOW: the job renamed away from `audit-issue-closures` | 1 of 34 |
| WORKFLOW: the run line stops invoking the script | 1 of 34 |
| WORKFLOW: `setup-bun` unpinned | 1 of 34 |
| WORKFLOW: the input interpolated into the run script | 1 of 34 |
| HOOK: the reclassification deleted | 1 of 34 |

**The job-name row scored 0 on the first attempt, and the detector was at
fault.** `toContain("audit-issue-closures")` was satisfied by the script's
own path on the `run:` line, so renaming the job changed nothing. It is now
anchored to the job key — a declaring position, the same principle
`.claude/rules/claiming-sc-coverage.md` applies to SC claims — and the run
line is asserted separately, which split one weak row into two real ones.

That is the third 0-that-was-the-mutation's-fault in two days, and all three
were the same mistake: **asserting a string rather than a position.** Worth
naming as a pattern rather than three coincidences.

Twenty-seven mutations, no survivors. None is left in the tree; all were run
and reverted.

---

### The rate was per worker, and nothing was per run (2026-10-12, #194)

The guard above exists, is registered, and could not bite. Across four
measured ship runs Marcus ran the full suite **7, 11, 13 and 12+** times for
one issue each — against a cap no single worker ever reached.

Two of the reasons pull in opposite directions, which is why neither is simply
a bug:

- **Per-worker is correct for fan-out.** #239 keyed the rate on the worker
  because three disjoint sub-agents sharing a session id serialised on the
  window; one slept in 580-second increments for twenty minutes while its
  siblings were already finished. Reverting that recreates #239 exactly, and
  the issue's AC-4 says so.
- **Per-worker is the wrong unit for one issue.** A run is Marcus, plus heal
  iterations, plus Quinn, each with its own worker identity. "At most four"
  became "at most four, several times over".

So the fix is a SECOND bound, not a different one. `DEFAULT_MAX_RUNS_PER_WORKER`
still protects against thrash and still lets a fan-out run in parallel;
`DEFAULT_MAX_RUNS_PER_PIPELINE` bounds what one ship run can spend in total.
They answer different questions.

**The run ceiling has no window, on purpose.** The four measured runs lasted
30, 32, 34 and 41 minutes against a 30-minute window, so that window reset
mid-run every time and could not bound a run by construction. The run id
bounds this one instead. `RUN_COUNTER_MAX_AGE_MS` is garbage collection for an
abandoned id, not a rate window, and it is twelve hours — far longer than any
run observed.

**The run id comes from the path, because that is what a hook can see.** Hooks
inherit the Claude Code process environment rather than the workflow's, which
is the same fact that makes `RUNGATE_MAX_FULL_SUITE_RUNS` hard to reach from
one direction. Agent worktrees are `.claude/worktrees/<runId>-<n>`, so the
trailing index comes off and every agent in a run agrees. Outside a worktree
it is null and only the per-worker rate applies — the DA is not part of a
fan-out, and inventing an id for it would put every session that never ships
anything into one shared ceiling.

**The fail-open stays; the silence does not.** A broken guard must never block
the suite it guards, and that is still true. But a guard whose broken state
and whose satisfied state look identical cannot be known to have ever fired,
which is this rule's opening sentence. `GUARD-FAILURE-VISIBLE` goes to
`systemMessage` rather than stderr, because stderr from a hook that exits 0 is
only visible under `--debug` — the same silence with extra steps.

**One of the issue's premises was already fixed.** It reported
`lib/test-suite-lock.ts:467` as "corrupt returns a FULL budget". That reader
now fails CLOSED and says so. The run counter was written to make the same
choice rather than inherit the old one, and SC-752 asserts it in both
directions — corrupt refuses, well-formed is read — because a fail-closed that
never opens is the same defect with the sign flipped.

- [x] SC-759: lib/test-suite-lock.ts contains [DEFAULT_MAX_RUNS_PER_PIPELINE, deriveRunId] — a ship run has a total full-suite budget shared by every agent in it, because a per-worker rate counts how often one agent re-measures and not what shipping one issue cost
- [x] SC-760: lib/test-suite-lock.ts contains [RUN_COUNTER_MAX_AGE_MS, no window] — the run ceiling is bounded by the run id rather than by elapsed time, because every measured run outlasted the window meant to bound it
- [x] SC-761: hooks/TestSuiteGuard.hook.ts contains [GUARD-FAILURE-VISIBLE] — a guard that cannot evaluate says so in the transcript and still allows the run; it may fail open, but not invisibly
- [x] SC-762: test/test-suite-budget.test.ts contains [a corrupt run counter spends the budget rather than granting it, a well-formed counter is read] — the fail-closed choice is executed in both directions, because a reader that rejects everything is a fail-closed that never opens
- [x] SC-763: test/test-suite-budget.test.ts contains [the hook actually passes the run id] — the hook is driven as a subprocess against a ceiling spent through the library, because every library-level case stays green when the one call site that makes the fix real stops passing the id

What was broken to prove it, run and counted rather than asserted, over
`test/test-suite-budget.test.ts` + `test/test-suite-lock.test.ts` (153 tests):

| Mutation | Red |
|---|---|
| `pipelineBudgetView` never refuses | 6 |
| the run ceiling never consulted by the gate | 6 |
| the run counter never written | 5 |
| `deriveRunId` keeps the trailing agent index, so each agent is its own run | 3 |
| the run refusal stops naming the run | 3 |
| `deriveRunId` invents an id outside a worktree | 1 |
| the run budget given the per-worker window | 1 |
| a corrupt run counter grants a full budget | 2 |
| the hook back to a silent catch | 1 |
| the hook stops passing the run id | 1 — and **0 of 152** before SC-763 was added, with every other case still green |

That last row is the point of SC-763 and the reason it exists: ten library
cases all passed while the fix was disconnected at its only real call site.

None is left in the tree; all were run and reverted.

**Not yet measured:** the issue's AC-2 asks for a ship run after this change
reporting Marcus's full-suite count at or below the ceiling. That needs a real
run and is not satisfied here; the next pipeline run provides it.

---

### "Test as CI sees it" saw half of it (#168)

`scripts/test-clean-env.ts` ends CLAUDE.md's MANDATORY GATE and is listed in
`AGENTS.md` as "Test as CI sees it". On 2026-10-07 it reported **2998 pass /
0 fail** on a tree where CI reported **2 fail**, and both failures were real.

It strips the developer's *environment* — `HOME`, `gh` credentials, git
identity — which was #71's defect and is still worth doing. It then ran in the
developer's *checkout*: a full clone with every ref and all of history. CI
runs `actions/checkout@v4`, which fetches one commit onto a detached HEAD with
no local branches. Any test whose behaviour depends on a ref or on history was
unmodelled, and `test/prior-branch.test.ts` was exactly that — it counts
`main..<ref>`, which resolves on a developer's clone and does not resolve in
CI, so #164's correct `commitCount: null` met two assertions still demanding a
number.

A check that passed because of what it never looked at, in the tool the gate
leans on. Every run since #71 was trusted for a property it did not have.

#### The model is read from the workflow, and that is the load-bearing part

The obvious implementation is `git clone --depth 1`, detach, delete `main`.
That was the first draft, and it was **already wrong**: #347 added a
`git fetch --depth=200 origin main` step to the `test` job, so `origin/main`
does exist by the time the suite runs. The hardcoded model reported two
failures CI does not have — `test/project-state-currency.test.ts` and
`test/allowlist-growth.test.ts`, both of which read `origin/main` — and a
model wrong in that direction costs exactly what a model wrong in the other
one does.

So `lib/ci-checkout.ts` parses `.github/workflows/ci.yml`: the checkout
step's `fetch-depth` (defaulting to 1, as the action documents), and every
`git fetch` the job runs afterwards, replayed in order. When CI changes, the
model follows. When the parse cannot find what it expects it returns a reason
and the caller refuses, because a guessed checkout is the defect being
modelled.

#### Every refusal is a refusal

With the decision written inline in the script, replacing it with "warn and
run in the working tree anyway" scored **0 red**. That is the worst outcome
this change could produce: a caller who asked for the strict check, was told
it could not be built, and got the unmodelled run reported as the strict one.
The decision moved into `prepareCiCheckout`, the script does nothing but
translate `ok: false` into one shared exit code, and there is deliberately no
fall-back parameter — a caller who wants the working tree asks for it up
front with `--no-ci-checkout`, where the choice is visible.

- [x] SC-580: scripts/test-clean-env.ts contains [fetch-depth, shallow, git] — the git checkout is part of what "as CI sees it" means, not only the environment variables, and the depth comes from the workflow rather than from an assumption that was already stale
- [x] SC-581: test/test-clean-env.test.ts contains [--depth 1, detach, no local main] — a planted ref-dependent test is shown to fail inside the modelled checkout while a planted control passes, because a harness that broke every run would satisfy the first assertion alone
- [x] SC-582: scripts/test-clean-env.ts contains [CI checkout, what this does NOT model] — the six remaining gaps are named in the file and printed on every run, because the claim being replaced failed by being unqualified
- [x] SC-777: lib/ci-checkout.ts contains [isSafeRefspec] — a refspec read out of a workflow is checked against an allowlist before it becomes a `git fetch` argument, because `--upload-pack=<cmd>` makes git execute that command and an argv array does nothing about a value that is itself an option

#### A refspec that is secretly a git option (#168, review of the first commit)

A security review of the first commit found it, and it is the kind this
codebase has not had much of: not a fail-open, an **argument injection**.

The refspec is read out of a workflow file and pushed into an argv. Using an
argv array rather than a shell string stops shell metacharacters and does
nothing at all about a value that is itself an option — and `git fetch`
accepts options anywhere on its command line, including `--upload-pack=<cmd>`,
which makes git **execute that command**.

The reach is wider than the file being parsed suggests. rungate scaffolds
other projects, so this parses workflow files it does not own: a repo whose
CI contains `git fetch origin '--upload-pack=...'` would be cloning arbitrary
execution into whoever ran the harness against it.

An allowlist rather than a denylist of leading dashes — the characters a real
refspec needs are a small closed set, and enumerating what is forbidden is how
the next option syntax gets through. Checked at the parse boundary and again
in the plan builder, because the builder is exported and a caller can hand it
a model the parser never saw.

| Mutation | Red |
|---|---|
| `isSafeRefspec` rejects everything | 4 of 22 |
| `isSafeRefspec` accepts everything | 2 of 22 |
| the parser stops validating | 1 of 22 |
| the plan builder stops validating | 1 of 22 |
| the allowlist becomes a leading-dash denylist | 1 of 22 |

The first row is the control working. An allowlist tight enough to reject
every real refspec would satisfy the hostile case and break every consumer
project, so the ordinary forms — wildcards, slashes, hyphens, underscores —
are asserted accepted in the same test.

#### What was broken to prove it (SC-580..582)

Over `test/test-clean-env.test.ts` (19 tests). None left in the tree.

| Mutation | Red |
|---|---|
| the local-branch deletion step dropped from the plan | 4 of 19 |
| the clone is no longer shallow | 2 of 19 |
| a missing `fetch-depth` read as full history instead of 1 | 2 of 19 |
| a missing job defaulted instead of refused | 2 of 19 |
| the checkout left attached to `main` | 1 of 19 |
| the final local-branch assertion removed | 1 of 19 |
| the workflow's fetch steps never replayed | 1 of 19 |
| `fetch-depth` scanned across the whole job rather than the one step | 1 of 19 |
| a missing checkout step defaulted instead of refused | 1 of 19 |
| the `UNMODELLED` list emptied | 1 of 19 |
| the script ignores the model and runs in the working tree | 1 of 19 |
| `--no-ci-checkout` silently modelled anyway | 1 of 19 |
| `prepareCiCheckout` falls back instead of refusing | 1 of 19 — and **0 of 13** while that decision lived inline in the script |
| an unreadable working tree treated as a clean one | 1 of 19 |
| an unparseable workflow silently defaults | 1 of 19 |
| the script stops routing refusals through the shared exit constant | 1 of 19 |

The thirteenth row is why the refactor happened rather than a comment being
added. Thirteen tests covered the library and the script's behaviour, and the
one decision that could silently undo the entire issue was reachable without
any of them noticing.

### A crash where a refusal belonged (project-state renderer)

Found by hand-editing `project-state.json` to archive a session and writing
`summary` where the renderer wanted `items`. `scripts/update-project-state.ts`
declares `interface Session { date: string; items: string[] }`, and that
interface is erased at runtime: the file is `JSON.parse`d into it and nothing
checks. The result was

    TypeError: undefined is not an object (evaluating 'session.items.forEach')
      at render (scripts/update-project-state.ts:134:15)

and nothing else. No path into the document, no index, no statement of what
should have been there. The renderer runs from a pre-commit hook, so that
trace reaches a committer who has not opened the script and has no reason to.

This is the mirror of the class the rest of this spec is about. A fail-open
reports success it did not earn; this reported a failure nobody could act on.
Both end with a reader who cannot tell what happened, and the second is the
one that teaches people to re-run the command and hope.

Every problem is reported at once, each naming its path into the document.
Stopping at the first turns one bad edit into four round-trips, which is how
a validator becomes something people route around.

- [x] SC-778: lib/project-state-shape.ts contains [projectStateViolations] — the shape is checked before the renderer reads it and every violation is named with its path into the document, because an erased TypeScript interface checks nothing at runtime and a stack trace from a pre-commit hook is not a message
- [x] SC-779: test/project-state-shape.test.ts contains [writes no markdown at all] — the script is copied, pointed at a bad document and run, because asserting the validator is consulted BEFORE the write does not assert that the refusal prevents one

#### What was broken to prove it (SC-778..779)

Over `test/project-state-shape.test.ts` (12 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `projectStateViolations` returns `[]` | 6 of 12 |
| the script stops consulting the validator | 2 of 12 |
| the refusal exit constant set to 0 | 2 of 12 |
| the `items` check removed | 2 of 12 |
| the refusal stops short-circuiting the write | 1 of 12 — and **0 of 9** while the wiring test only checked ordering |
| the validator stops at the first violation | 1 of 12 |
| the missing-key check removed | 1 of 12 |
| a non-object document indexed into anyway | 1 of 12 |
| the `"summary" instead` hint dropped from the message | 1 of 12 |
| the invalid-JSON refusal removed | 1 of 12 |
| a second bare `process.exit(1)` added | 1 of 12 |

The fifth row is the one that changed the test. "The check is consulted
before the write" and "the check prevents the write" are different claims,
and only the first was being made: with the refusal branch made unreachable,
the validator still ran first, still found the problem, and the script wrote
anyway. The script is now copied to a temp directory, pointed at a bad
document, executed, and the **absence of the output file** is the assertion.

#### Two more the review found in the fix (#354)

**A validator that stopped at the container.** It checked that `phases[i].scs`
is an array and nothing about its elements, leaving `sc.id.toUpperCase()` and
`sc.done` to crash on `[null]` or `[{}]` — the same unreadable TypeError the
module replaces, one level deeper. A validator that stops at the container
moves the crash rather than removing it. The elements are checked now, and so
is `session`, which the renderer dereferences four fields deep behind a guard
that only tests for presence.

**"Not found, skipping" for two different facts.** A project with no
`project-state.json` and a project that *lost* one exited 0 with the same
line. For a consumer repo that does not use the feature that is right; for
this one, where a pre-commit hook renders the artifact every commit and
`AGENTS.md` tells the next session to read it first, it meant the hook
quietly stopped maintaining a file people are instructed to trust — and said
"skipping" while doing it. The tell is in the output: `PROJECT-STATE.md`
present with its source gone is an artifact that has outlived the thing that
writes it. Same distinction the spec-compliance probe draws between "no suite
here" and "half a suite", and reached the same way.

| Mutation | Red |
|---|---|
| `missingStateVerdict` always refuses | 4 of 17 |
| an orphaned `PROJECT-STATE.md` is skipped again | 2 of 17 |
| the SC elements go unchecked again | 1 of 17 |
| `sc.done` and `sc.what` unchecked, only `sc.id` | 1 of 17 |
| the `session` block removed | 1 of 17 |
| the script ignores the missing-source verdict | 1 of 17 — **0 of 15** before the script-level case |
| the `priorities` element check removed | 1 of 17 — **0 of 15** before it had a case at all |

The last two rows are the same lesson twice in one sitting: a library the
script does not consult, and a branch no test exercises, are both green and
both worth nothing.

#### What a green run here still does not promise

Six things, listed as `UNMODELLED` in `lib/ci-checkout.ts` and printed on
every run: the runner OS (CI is ubuntu-latest), a fresh `bun install`
(node_modules is linked), the pinned bun version, the pull-request merge
commit `actions/checkout` builds, network and API availability, and files git
ignores. Naming them is the difference between a model and a promise, and the
promise is what failed.

---

### A check that could not PASS (2026-10-10)

`.claude/rules/checks-must-be-able-to-fail.md` is about a check that passes
because of what it never looked at. #261 is the same root with the sign
flipped, and it cost two heal rounds on a run whose ACs were all green.

The evidence pre-validation reading had exactly one writer, the SCOPE gate.
`workflows/ship.js` skips the scope gate outright when Discovery sizes a run
LIGHT (`skipScope = discovery.ceremonyTier === 'LIGHT'`). Its reader,
`evidence-prevalidation` in `gates/workflow.test.ts`, is guarded by
`isVerifyPlus()` and runs regardless. An absent reading is a refusal — which
#235 got right, for the right reason: "the writer never ran" and "the writer
ran and measured nothing" are the same failure. Composed, every LIGHT-tier run
failed verify unconditionally, and no change to the code being shipped could
have healed it. Run `wf_ed24496e-e49` reached VERIFY with six of six ACs PASS
and spent its heal budget on the gate's own plumbing.

Neither half is wrong on its own. Both halves were tested. Nothing tested the
composition, because no test ever ran a verify gate on a run that had not had a
scope gate — the fixture everyone reaches for carries `gates.scope` without
thinking about it, and a fixture that always has the producer's output cannot
notice that the producer is unreachable.

**The producer now runs wherever the consumer checks, and only when the reading
is absent.** A STANDARD run still measures exactly once; re-measuring at verify
would overwrite a scope-time verdict with a post-Marcus one, which is not what
the scope refusal was about. An UNMEASURED reading is PRESENT and is not
re-taken: a recorded failure to measure is a recorded failure, and retrying it
would turn #235's refusal into a retry loop.

- [x] SC-655: gates/gate-executor.ts contains [export async function ensurePrevalidationPersisted] — the reading exists wherever the gate checks for it, taken only when absent, and the write is one statement after the await for the reason `runScopePreflightsAndPersist` already gives: `runGateTests` spawns bun against workflow-state.json as it stands on disk
- [x] SC-656: gates/gate-executor.ts contains [export async function stampEvidencePrevalidation] — one function measures-validates-stamps for both gates, because the second copy of that block would be a second source of truth for a field whose entire purpose is to be the single reading
- [x] SC-657: test/evidence-prevalidation-at-verify.test.ts contains [the reading is on disk BEFORE the gate suite is spawned] — ordering is asserted end-to-end and without reading the source: the reading present in the final file proves the producer ran, and the ABSENCE of its refusal from the failures the spawned suite reported proves it ran first
- [x] SC-658: test/evidence-prevalidation-at-verify.test.ts contains [MIN_GATE_CHECKS] — every case first proves the gate suite executed, because a runner that dies before `runGateTests` leaves exactly the state the unfixed code leaves, and that case turns green on the fix for no reason connected to it
- [x] SC-659: test/evidence-prevalidation-at-verify.test.ts contains [a broken evidence command on a LIGHT run still refuses, not a retry] — measuring at verify buys nothing if the measurement cannot come back FAIL, and nothing if a recorded UNMEASURED is quietly re-rolled into a PASS

What was broken to prove it, run and counted rather than asserted, over
`test/evidence-prevalidation-at-verify.test.ts` (5 tests):

| Mutation | Red |
|---|---|
| the verify-gate producer removed — the bug, reintroduced verbatim | 3 of 5 |
| the producer moved to AFTER `runGateTests` | 1 of 5 — and the "reading exists" case stays GREEN, which is the whole reason the ordering assertion is separate from the presence one |
| the measure-once guard removed | 2 of 5 — a STANDARD run re-measures and an UNMEASURED reading is silently re-rolled |
| the measurement replaced with a hard-coded PASS | 1 of 5 — the rubber-stamp, which is this defect with the sign flipped back again |
| the gate runner pointed at a path that does not exist | 5 of 5, every one of them through the `MIN_GATE_CHECKS` guard with its own message rather than the subject's |

None is left in the tree; all were run and reverted.

#### The fix for it shipped two more of the same (2026-10-10, #264)

The first real run after #261 merged — `wf_c71f950f-c88` on #254 — refused at
verify on a reading my fix had taken. Recorded in full because the lesson is
not the bug, it is that a fix for "a check the branch cannot satisfy" produced
two more instances of exactly that, and only a live run found them.

From the run's own state file: four verify attempts over thirteen minutes, all
six ACs carrying `verdict: PASS`, every attempt judged against one reading
stamped `checkedAt: 2026-10-11T00:29:03.380Z`. Status `SHIP_FAILED`.

**D1, the directory.** `stampEvidencePrevalidation` dry-ran the AC commands
with `state.projectRoot`. The evidence COLLECTOR, forty lines earlier in the
same file, uses `process.env.EVIDENCE_CWD || state.projectRoot ||
process.cwd()` — and `workflows/ship.js` sets `EVIDENCE_CWD` exactly when the
gate's cwd differs from the project root, which is the worktree isolation
`marcus` always runs with. So the pre-validator declared three commands broken
because the branch's new test file does not exist in the main repo, while the
same commands report 18 pass in the worktree. The line predates #261 — I moved
it unchanged — but #261 is what made it reachable, because a LIGHT run never
took the reading at verify before.

**D2, the freeze.** The measure-once guard read "if a reading exists, keep it".
Right for a scope reading, wrong for a verify one: attempts 2, 3 and 4 were
judged against attempt 1's measurement, so no heal round could clear it. That
is #261's own shape — a refusal the branch has no way to satisfy — reintroduced
by #261's fix.

Neither is fatal alone. D1 costs one attempt and heals; D2 is invisible when
the first reading is right. **A fixture where projectRoot and the evidence cwd
are the same directory passes whichever one the code reads**, which is why the
original tests were green over D1, and it is the generalisable lesson: when two
code paths read the same fact from different places, a fixture that collapses
them cannot see the divergence.

- [x] SC-660: gates/gate-executor.ts contains [process.env.EVIDENCE_CWD || state.projectRoot] — the dry run looks where the evidence will be collected; a pre-validator reading a different directory than the collector calls the branch's own new files missing, and reports it as the branch's defect
- [x] SC-661: gates/schema.ts contains [PREVALIDATION_SOURCES, takenAt] — the reading records WHICH gate took it, because "a reading exists" cannot separate the two cases that want opposite treatment on the next attempt; optional, so a reading written before the field still validates and keeps the behaviour it had
- [x] SC-662: gates/gate-executor.ts contains [takenAt === "verify"] — a scope reading is preserved and a verify reading is re-taken, because the premise of a second attempt is that the branch moved. The expression moved into `shouldRetakePrevalidation` in #280 when ship became a third source; the claim is unchanged and `test/unit/prevalidation-at-ship.test.ts` now executes both directions of it
- [x] SC-663: test/evidence-prevalidation-at-verify.test.ts contains [pretend-worktree, healing-worktree] — the two directories are DIFFERENT in the fixture and the file the command needs is in only one of them; the heal case runs the real gate twice and changes nothing but the world the command looks at

What was broken to prove it, run and counted rather than asserted, over
`test/evidence-prevalidation-at-verify.test.ts` (9 tests):

| Mutation | Red |
|---|---|
| the `EVIDENCE_CWD` read dropped — D1, reintroduced verbatim | 2 of 9 |
| the unconditional early return restored — D2, reintroduced verbatim | 1 of 9 |
| the measure-once guard removed entirely | 3 of 9 — a scope reading is re-taken, and both #261 preservation cases go with it, which is the fail direction the fix must not buy its way into |

None is left in the tree; all were run and reverted.

#### Two of this workflow's own rules in contradiction (2026-10-10, #267)

The third refusal-the-branch-cannot-satisfy found in one day, and the only one
of the three that predates today's work.

When a run's implementation spans more than one worktree — which is what a
remediation round produces — the collect path assembled everything into
`PROJECT_ROOT` and set `commitDir` to it. The commit step, run in `commitDir`,
refuses `main`:

    case "$branch" in main|master) echo "REFUSING: ..."; exit 1;; esac

The project root is on `main`. That is its resting state and where the DA sits
while a run executes. So the collector wrote the work to the one directory the
committer is forbidden to commit from. Run `wf_19f7def7-1bf` produced a
complete implementation of #254 and committed none of it.

The guard is not the defect and is unchanged. #136 is why it exists. The
destination was wrong: it chose a directory by path with no regard for what
was checked out there. The collection now prefers the IMPLEMENTATION worktree,
which is already on the run's branch and is where `commitDir` points for every
single-worktree run — so the collect path stops being the one that behaves
differently.

**The leak was worse than the refusal.** On refusal the collected work was left
STAGED, on `main`, in the primary working tree: 907 lines of unreviewed agent
output one `git commit` away from the default branch, with nothing announcing
it. A refusal is supposed to leave nothing mergeable (#252), and that left
something one command from it. With the destination fixed the project root is
never written when worktrees exist; an uncontained run still works there by
design, and the branch guard then applies to it on its merits.

- [x] SC-664: workflows/ship.js contains [COLLECT-TARGET-START, function collectTarget(worktrees] — the destination is decided rather than assumed, in a marked block that can be extracted and EXECUTED, because a path constant cannot be tested and this one was wrong for the whole life of the collect path
- [x] SC-665: workflows/ship.js contains [collectTarget(distinctWorktrees, marcusWorktreePath)] — computed BEFORE the collection and used for both the destination and `commitDir`, so staging in one directory and committing from another is not expressible
- [x] SC-666: workflows/ship.js contains [const d = collectDestination(p, projectRoot, harnessRoot)] — every candidate goes through the existing allowlist; the chooser must not become a way around it, since these paths originate in agent replies (#155) and a destination is interpolated into a `git add`
- [x] SC-667: test/ship-collect-target.test.ts contains [ship never commits to the default branch] — the branch guard is asserted intact by the same suite that fixes the thing it refused, because a version of this change that deleted the guard would pass every other case in the file

What was broken to prove it, run and counted rather than asserted, over
`test/ship-collect-target.test.ts` + `test/collect-claim-enforcement.test.ts` +
`test/ship-collect-destination.test.ts` (69 tests):

| Mutation | Red |
|---|---|
| the destination set back to `PROJECT_ROOT` — the defect, reintroduced verbatim | 1 of 69 |
| the implementation worktree no longer preferred, so the first entry wins by order | 2 of 69 — right by accident on the common case, which is why order is not the rule |
| `collectDestination` bypassed inside the chooser | 4 of 69 |
| the branch guard deleted — the fix buying its green by weakening what refused | 1 of 69 |

None is left in the tree; all were run and reverted, and `workflows/ship.js`
was diffed byte-for-byte against a copy taken before the first mutation.

#### A rule that was right and four phases late (2026-10-10, #269)

Fourth instance in one day, and the one that is not a refusal the branch
cannot satisfy — it is a refusal that arrives after everything it could have
saved.

Run `wf_3335abda-d71` wrote six ACs, one carrying `threshold: >= 1`. It then
skipped the scope gate (LIGHT), briefed Marcus, implemented the whole change,
ran the suite, committed `cf33b6e5`, pushed — and only then:

    record-build-commit: Workflow state validation failed:
    acs.5.threshold: AC-6: threshold too weak (>= 1) — effectively always passes

`gates/schema.ts:96` is right. A `>= 1` threshold passes on any non-zero
result, which is this file's whole subject wearing an acceptance criterion.
What was wrong is that `writeWorkflowState` is the only thing that validates,
and on a LIGHT run the first validating write is the COMMIT RECORDER. Every
phase in between was spent on a criterion nobody could fail.

The rule is now also applied at the end of Discovery, beside #251's coverage
refusal, for the same reason that one is there.

**This is a duplicated rule, which is normally the wrong answer.** ship.js
runs in a sandbox with no module loading (#69), so `ACSchema` cannot be
imported and there is no honest way to share the implementation. What makes
the copy admissible is the #224 pattern: a table of ACs is run through BOTH
the inlined function and the real `ACSchema`, and a disagreement in **either**
direction fails. A copy that refuses too little and a copy that refuses too
much are equally caught — the second is the one a one-directional parity test
would miss, and it is the one that would start refusing valid runs.

- [x] SC-668: workflows/ship.js contains [AC-VALIDATION-START, function acDiscoveryViolations(acs)] — the rules the state schema applies are checked at the phase that can still act on them, in a marked block that is extracted and EXECUTED rather than matched
- [x] SC-669: workflows/ship.js contains [acDiscoveryViolations(discovery.acs)] — called before setup, before the scope gate and before any brief, because a rule enforced after the implementation is a rule that costs the implementation
- [x] SC-670: test/discovery-ac-validation.test.ts contains [ACSchema.safeParse(ac).success] — every case runs through the real schema as well as the copy, and the assertion compares the two verdicts, so neither may drift in either direction
- [x] SC-671: test/discovery-ac-validation.test.ts contains [no case in the matrix exercises the schema rule] — the matrix is itself checked for coverage of every rule the schema can raise, because a parity table that quietly misses a rule proves parity on the rules it has and silence on the rest
- [x] SC-672: workflows/ship.js contains [THRESHOLD RULE] — the prompt states the rule rather than only enforcing it; refusing a model for something it was never told is a round spent teaching it what the prompt could have said for free

What was broken to prove it, run and counted rather than asserted, over
`test/discovery-ac-validation.test.ts` (21 tests):

| Mutation | Red |
|---|---|
| the violations list replaced with `[]` at the call site — computed and never looked at | 1 of 21 |
| the weak-threshold branch short-circuited to `if (false)` — the copy drifts LOOSER | 4 of 21 |
| the copy's minimum word count lowered from the schema's 5 to 3 | 1 of 21 |
| the copy's threshold rule widened to `<= 2` — the copy drifts STRICTER, and starts refusing runs the schema accepts | 1 of 21 |

None is left in the tree; all were run and reverted, and `workflows/ship.js`
was diffed byte-for-byte against a copy taken before the first mutation. The
last row is why the parity assertion compares verdicts in both directions
rather than asserting "the copy refuses what the schema refuses".

**Security review of 41edf8e5 found three defects in the first version, all
three real, and all three the same classes this file is about.** Recorded
because the first version had already passed CI, the full suite and a
mutation table.

- **Fail-open default.** `acDiscoveryViolations` opened with
  `if (!Array.isArray(acs)) return []`. `acs` is REQUIRED by
  `DISCOVERY_SCHEMA`, so a non-list is a defect and not a run with nothing to
  check — and returning no violations for the one input the function cannot
  interpret is the exact shape of the bug it exists to catch. #251 had learned
  this about the success criteria eight hours earlier, in a function thirty
  lines further down the same file, and I wrote it again anyway.
- **Validator differential.** The copy implemented the five interesting
  heuristics and none of the dull base-shape rules, so an AC with an operator
  outside the enum passed Discovery and was still refused by the state schema
  at the commit recorder. That is #269 surviving its own fix for a narrower
  set of inputs. The copy now checks the operator enum, the evidence-method
  enum, the type enum, the id type and a threshold with no value, and the
  matrix carries a case for each.
- **Control misfire.** The refusal text said "so this run could not record its
  own commit". `runDiscovery` is also called from the verify-regression path,
  where the commit already exists, so the sentence is true on the first pass
  and false on the second. A refusal that misstates the run's state sends the
  next reader after the wrong thing, which is most of what #261 and #267 cost
  in wall-clock.

Widening the copy then made the matrix fail twice more, in the useful
direction: the copy refused an empty `id` and a missing `evidence` where
`ACSchema` accepts both. Both were corrected toward the schema, because a
copy STRICTER than the thing it stands in for refuses runs that are fine and
nothing downstream ever contradicts it. The second of those also killed a
"deliberate divergence" section written on a wrong premise —
`EvidenceSchema` is `.nullable().optional()`, so there was no divergence to
document — and that block is now a test that fires if the premise ever
becomes true.

#### The pattern across all four

Four defects in one day, all the same shape at a different level: **a check
whose phase has nothing to do with the phase that can act on it.**

| # | The check | Where it ran | Where it could be acted on |
|---|---|---|---|
| #261 | evidence pre-validation | written at scope, read at verify — and LIGHT skips scope | the verify gate |
| #264 | the same reading | taken in the main repo, frozen after one attempt | the worktree, every attempt |
| #267 | the commit branch guard | the project root, which the collector chose | a run branch |
| #269 | the AC schema rules | the commit recorder | Discovery |

Three of the four were found by running the pipeline, not by reading it, and
none by a unit test. Two of them were introduced by the fix for the one above.
That is the argument for the negative control being a standing line item: this
class is invisible to every test that does not execute the phase ordering,
because each half is correct and only the composition is not.

Filed rather than fixed here, because it is a different defect in a different
function: `prevalidationViolations` names the broken ACs out of
`reading.broken`, and no writer produces that key —
`measureEvidencePrevalidation` returns per-AC results under `acs`, and
`EvidencePrevalidationSchema` requires a FAIL to carry at least one
`acs[].status === "broken"`. The refusal is still a refusal, so it fails
closed; but it always says "no broken AC ids were recorded", which is true of
the key and false of the reading, and a refusal the heal loop cannot act on is
part of how #261 cost two rounds.

### An ordering check that was reading the comments (#273)

Six phase-ordering assertions in `test/spec-compliance.test.ts` — PO-1 through
PO-6, the checks that say the harness still runs Implement before Validate and
opens the PR before the ship gate — located their anchors with `indexOf` over
the RAW text of `workflows/ship.js`. **Five of the eight strings they searched
for occur only inside comments.** `PHASE 5: VALIDATE` is a banner. `create-pr`
is a note about a step, three lines above the step. Three of the six therefore
compared one comment to another and said nothing about code at all.

Surfaced by run `wf_61a6af0d-053` on #254, which went red on two of them and
was right to.

Measured rather than argued, and measured from both sides:

| The suite | The source | Result |
|---|---|---|
| the old anchors | the PR step deleted, its `create-pr` comment left in place | **6 pass, 0 fail** against a harness with zero `pr-upsert` call sites |
| the new anchors | the same mutant | 2 red — PO-3 and PO-4 |

This is the third shape `.claude/rules/checks-must-be-able-to-fail.md` names —
a detector narrower than what it detects — met from an angle the rule had not
recorded: the detector was not narrow, it was pointed at the wrong text
entirely. Prose cannot execute, so a check anchored to prose is satisfied by
a file that does nothing.

**The fix has two halves, and the second is the one that keeps.** The anchors
become executable tokens — `phase('Validate')`, `label: 'quinn-container'`,
the `pr-upsert` command the PR step actually runs, `log('Running ship gate')` —
and every search runs over `SHIP_CODE`, a comment-blanked copy produced by
`lib/strip-js-comments.ts`. The stripper replaces comment characters with
spaces instead of deleting them, so offsets survive: an index into `SHIP_CODE`
is the same index into `SHIP_JS`, the ordering comparisons mean exactly what
they did minus the prose, and `stripped.slice(i, i + a.length) === a` becomes
an exact answer to "is the anchor at offset `i` code?" — which is what the
anchor audit below is built on.

#### What was broken to prove it, run and counted rather than asserted

Over `test/ship-phase-ordering-mutation.test.ts`, which builds each mutant as a
temp harness root of symlinks with one real file in it — the mutated
`workflows/ship.js` — and spawns the six real checks against it. Re-measure
with `PO_MUTATION_COUNTS=1 bun test test/ship-phase-ordering-mutation.test.ts`.

| Mutation | Red |
|---|---|
| CONTROL — an unmutated copy, the negative control every row below subtracts from | 0 of 6 |
| PR-STEP-DELETED — the `pr-upsert` step removed, its `create-pr` comment left behind | 2 of 6 — PO-3, PO-4 |
| BANNER-REWORD — every `// PHASE n:` banner reworded and moved to the top of the file, in reverse order | 0 of 6 |
| MOVE-1 — `phase('Validate')` relocated past `phase('Commit')` | 1 of 6 — PO-1 |
| MOVE-2 — `phase('Commit')` relocated past `phase('Verify')` | 1 of 6 — PO-2 |
| MOVE-3 — `label: 'quinn-container'` relocated past the `pr-upsert` command | 1 of 6 — PO-3 |
| MOVE-4 — the `pr-upsert` command relocated past `log('Running ship gate')` | 1 of 6 — PO-4 |
| MOVE-5 — `log('Running ship gate')` relocated past `phase('Prove')` | 1 of 6 — PO-5 |
| MOVE-6 — `phase('Implement')` relocated past `phase('Validate')` | 1 of 6 — PO-6 |

None is left in the tree; all were run and reverted, and the six MOVE cases are
re-performed on every run rather than recorded here and trusted.

The right-hand column names ids, not counts, and the cases assert the ids. That
is deliberate and it is the fourth property below: `red >= 2` and
`red >= 1` were the original assertions, and both are satisfied by a mutant
that stopped parsing — the same number arrives from a cause that says nothing
about whether the check reads the code it claims to read.

Four properties make the harness worth the spawns, and all four are asserted
rather than left as conventions:

- **BANNER-REWORD is not decoration.** A mutation that only proves red is half
  a proof. Six checks that go red when a comment is reworded are measuring the
  comment, which is the defect, so the green row is the one that says the fix
  actually landed.
- **Each MOVE relocates code, not a line.** The two executable anchors exchange
  positions in place — no backtick, brace or line moves — so a check that goes
  red went red about ORDER and not about a mutant that stopped parsing. The
  harness re-strips the mutant and asserts both anchors survive in code and the
  order is inverted before it spawns anything.
- **`ran` is checked before `red`.** A `-t` filter matching nothing leaves bun
  reporting zero failures, which is indistinguishable from six passes and is
  also what a suite that failed to load looks like.
- **WHICH orderings refused, not how many.** `poIds` turns a run's failure
  lines into the set of `PO-n` ids, and every mutation case compares that set
  exactly: PR-STEP-DELETED must produce `["PO-3", "PO-4"]` — the only two
  orderings whose subject is the PR step — and each MOVE exactly its own. A
  failure line carrying no `PO-n` id, which is what a load error or a thrown
  `beforeAll` looks like, surfaces in the set rather than being dropped.

#### Every remaining anchor, classified

Fixing six anchors is not the same as knowing what the others are doing. Every
`indexOf`, `lastIndexOf` and `sliceBetween` anchor still used in
`test/spec-compliance.test.ts` is below. The table is EXECUTED by AUDIT-2 and
AUDIT-3 in `test/ship-phase-ordering-mutation.test.ts`: each row's
classification is re-derived from the file it names, and any anchor the suite
uses that is missing from the table fails AUDIT-3. Line numbers are as of this
commit and are recorded for the reader, not asserted.

Eight anchors are still comment-anchored, and all eight are deliberate: they
are `sliceBetween` section markers, where the banner comment IS the section
boundary being named. `HEAL_JS.indexOf("GRADE")` is the one that is not — it
lands on a comment at `workflows/ship-and-heal.js:132` while the ordering it
asserts is about code, which is #273's defect still live in a neighbouring
test. It is recorded here rather than fixed, because the fix is a different
test's contract.

| Anchor | Searched against | Resolves at | code / comment |
|---|---|---|---|
| `phase('Implement')` | `SHIP_CODE` | workflows/ship.js:1897 | code |
| `phase('Validate')` | `SHIP_CODE` | workflows/ship.js:2227 | code |
| `phase('Commit')` | `SHIP_CODE` | workflows/ship.js:2374 | code |
| `phase('Verify')` | `SHIP_CODE` | workflows/ship.js:3036 | code |
| `label: 'quinn-container'` | `SHIP_CODE` | workflows/ship.js:3584 | code |
| `pr-upsert` | `SHIP_CODE` | workflows/ship.js:4357 | code |
| `log('Running ship gate')` | `SHIP_CODE` | workflows/ship.js:4406 | code |
| `phase('Prove')` | `SHIP_CODE` | workflows/ship.js:4544 | code |
| `label: 'grade'` | `SHIP_JS` | workflows/ship.js:4107 | code |
| `phase('Ship')` | `SHIP_JS` | workflows/ship.js:4310 | code |
| `GRADE` | `HEAL_JS` | workflows/ship-and-heal.js:132 | comment |
| `'SHIPPED'` | `HEAL_JS` | workflows/ship-and-heal.js:255 | code |
| `label: 'remediate'` | `HEAL_JS` | workflows/ship-and-heal.js:377 | code |
| `` await agent(` `` | `HEAL_JS` | workflows/ship-and-heal.js:67 | code |
| `PHASE 5: VALIDATE` | `SHIP_JS` | workflows/ship.js:2224 | comment |
| `PHASE 6: COMMIT` | `SHIP_JS` | workflows/ship.js:2371 | comment |
| `PHASE 7: VERIFY` | `SHIP_JS` | workflows/ship.js:3033 | comment |
| `PHASE 8: SHIP` | `SHIP_JS` | workflows/ship.js:4307 | comment |
| `PHASE 9: PROVE` | `SHIP_JS` | workflows/ship.js:4541 | comment |
| `Telemetry` | `SHIP_JS` | workflows/ship.js:4565 | comment |
| `ALREADY_SHIPPED` | `SHIP_JS` | workflows/ship.js:1716 | code |
| `Prior work:` | `SHIP_JS` | workflows/ship.js:1730 | code |
| `You are performing DISCOVERY` | `SHIP_JS` | workflows/ship.js:1359 | code |
| `DISCOVERY_SCHEMA` | `SHIP_JS` | workflows/ship.js:31 | code |
| `async function runGateWithHeal` | `SHIP_JS` | workflows/ship.js:1148 | code |
| `PHASE 1: GOAL` | `SHIP_JS` | workflows/ship.js:1199 | comment |
| `export const meta` | `SHIP_JS` | workflows/ship.js:1 | code |
| `// ── Structured` | `SHIP_JS` | workflows/ship.js:18 | comment |

A table that nothing can disagree with is the thing this whole section is
about, so it was broken too, run and counted over
`test/ship-phase-ordering-mutation.test.ts` + `test/strip-js-comments.test.ts`
(26 tests):

| Mutation | Red |
|---|---|
| the `pr-upsert` row's verdict flipped from `code` to `comment` | 1 — AUDIT-2 |
| the `phase('Prove')` row deleted from the table | 1 — AUDIT-3 |
| `stripJsComments` short-circuited to `return src` | 11 — nine stripper cases, plus AUDIT-2 and AUDIT-4 |
| `poIds` short-circuited to `return []` | 7 — PR-STEP-DELETED and all six MOVE cases, which is the whole set that names ids rather than counting them |

None is left in the tree; all were run and reverted. The last row is the one
worth reading twice: with the stripper dead the six ordering checks go GREEN
again, because they fall back to searching raw text — which is the defect
#273 is about, reintroduced, and caught by the audit rather than by them.

### A phase that reported PASS for never having run (#276)

`workflows/ship.js` declared `let scopeResult = { result: 'PASS' }`, ran the
scope gate only when `skipScope` was false, and then reported
`scopeResult?.result || 'SKIPPED'` at two sites — the operator log and the
DRY_RUN payload. **The initialiser IS the did-not-run value**, so over the
four reachable states the two words came out swapped:

| State | Reported | Should be |
|---|---|---|
| the gate never ran (LIGHT tier) | PASS | SKIPPED |
| the gate ran and passed | PASS | PASS |
| the gate ran and failed | FAIL | FAIL |
| the gate ran and reported nothing | SKIPPED | FAIL |

Two consequences, and the second is the worse one. #274 records that
`pages:{}` forces every rungate self-run to LIGHT, so **every LIGHT run in
this repo's history printed `Scope: PASS` without a scope gate ever running** —
the artefact asserting a gate had passed is the only evidence anyone has that
it ran. And the single state that genuinely deserved suspicion, a gate that
answered with nothing, was the only one reported as skipped: an absent verdict
read as a non-event rather than as a failure, which is the inverse of what
#235 settled for an absent reading.

This is #173's shape, and #173's fix is 430 lines further down the same file:
a separate OBSERVED `ran` boolean rather than a value inferred from the tier,
a reply that is not one of the recognised verdicts read as FAIL, and the logic
in a marked block so a test EXECUTES it. `SKIPPED` is now reserved for the one
fact only `scopeRan` can state, and the refusal reads the computed verdict, so
the absent-result state reaches `SCOPE_FAILED` instead of falling through.

- [x] SC-673: workflows/ship.js contains [SCOPE-VERDICT-START, function scopeVerdictFor(ran, result)] — the chooser is a marked block rather than an inline ternary, so the four reachable states are extracted and RUN; every source-text assertion in this repo has survived its first mutation
- [x] SC-674: workflows/ship.js contains [let scopeRan = false] — the did-not-run fact is observed where the gate runs, not inferred from the ceremony tier or from whatever value is sitting in the result slot, which is what made the old initialiser reportable
- [x] SC-675: workflows/ship.js contains [let scopeResult = null] — the result starts as no verdict at all; a run that skipped the gate must not be carrying something a reader could mistake for a measurement
- [x] SC-676: workflows/ship.js contains [if (scopeVerdict === 'FAIL') return await terminalFailure('SCOPE_FAILED'] — one refusal, reading the computed verdict, above the operator log, so a gate that answered with nothing stops the run rather than being logged as skipped. The refusal now goes through the preserving funnel (#232); the claim is unchanged and the token follows the call
- [x] SC-677: test/ship-scope-verdict.test.ts contains [parts.sort((a, b) => a.index - b.index)] — ship.js's own statements are executed IN SOURCE ORDER, because a fixed assembly order runs the refusal first wherever the file puts it, and that mutation was run and came back green before the sort existed
- [x] SC-678: test/ship-scope-verdict.test.ts contains [the enumeration reads code, not prose about code] — every `let xResult = { result: 'PASS' }` in ship.js must be paired with an observed `let xRan = false`, and the probe is line-anchored: an unanchored one counted the docblock explaining why the initialiser is gone

What was broken to prove it, run and counted rather than asserted, over
`test/ship-scope-verdict.test.ts` (25 tests):

| Mutation | Red |
|---|---|
| the PASS initialiser restored, alone | 5 of 25 — the skipped run starts carrying a verdict again, and every mutant-building case throws `could not build the mutant` because its target is already in the tree |
| the whole pre-#276 shape restored (initialiser + both reporting sites) | 8 of 25 — the defect itself: `Scope: PASS` for a gate nobody ran, at both reporting sites |
| the observed-ran boolean dropped at the call site (`scopeVerdictFor(true, …)`) | 11 of 25 |
| the chooser falls back to the result slot when it did not run | 1 of 25 — the row that exists so the `ran` argument is load-bearing rather than decorative |
| an unrecognised reply read as a pass | 3 of 25 — including the absent-result state, which stops reaching the refusal |
| the marker renamed | 16 of 25 — every extraction aborts rather than passing quietly |
| the refusal never fires (`if (false)`) | 11 of 25 |
| a second operator log added above the refusal | 10 of 25 — two log sites is ambiguity about which one is checked, and that is a refusal |
| the refusal moved below the operator log | 2 of 25 — the ordering case, which is the one the sort in SC-677 exists for |

None is left in the tree; all were run and reverted, and `workflows/ship.js`
was compared byte-for-byte against a copy taken before the first mutation.
Two rows are worth reading twice. The first is the #129 outcome: restoring the
initialiser leaves the mutation harness nothing to mutate, so it throws instead
of going quietly green. The last is a check that could not fail, found and
fixed while writing this one — the runner originally assembled the extracted
statements in a fixed order, so moving the refusal below the log changed
nothing it could see.

### A prior branch described by one number that could not distinguish anything (#185)

`detectPriorBranch` nominated a ref and reported `commitCount`. Three facts the
resume decision needs were not in the answer, and each absence has its own
failure:

| Fact | What the old answer said | What it cost |
|---|---|---|
| how far behind the base it is | nothing | a candidate 64 ahead and 4 behind read exactly like one on the base's tip |
| whether the work already landed | `commitCount: 1` | a squash-merged branch reopened, because the graph still lists its commit |
| whether the ref is work at all | nominated it | `rungate-preserved/*` and `worktree-*` carry the issue number and are written LAST, so they win the recency tie-break against the real branch |

The second is the one that is specific to this repo. A squash merge leaves the
branch an ancestor of nothing while its content sits on main, so `rev-list
main..ref` reports every commit it ever had. The commit graph cannot see the
merge; the TREE can, because a squash commit reproduces the branch tip's tree
exactly. Detection is therefore "does the tree this branch produced appear
anywhere in the base's history", which stays true after main moves on, and
deliberately not `git cherry` — patch-id comparison answers a different
question and is linear in the branch length rather than the base's.

`behindCount` follows `commitCount`'s rule from #164 rather than inventing a
second one: a number is a claim, and when no base resolves there is no claim,
so the value is `null`. `0` would say "this branch is current". `isBehind` is
false for an unmeasured branch for the same reason — no measurement is not
evidence of staleness — and `mergedIntoBase` fails closed in the opposite
direction, because "I could not check" becoming "it already landed" discards
work.

- [x] SC-679: lib/prior-branch.ts contains [behindCount: number | null, isBehind: boolean] — currency is on the record the decision reads, not recomputed by each caller; `null` for an unanswerable count matches commitCount's existing rule, so the two numbers cannot disagree about what "unknown" looks like
- [x] SC-680: lib/prior-branch.ts contains [function divergenceFromBase, --left-right] — both sides come from ONE `rev-list`, so ahead and behind can never be measured against different bases, and a call that cannot run returns `null` for both rather than a pair of zeroes nobody took
- [x] SC-681: lib/prior-branch.ts contains [function mergedIntoBase, merge-tree --write-tree] — "already merged" is measured by merging into the base in memory and asking whether the result is the base's own tree, which is true however the work landed. That covers the squash merge this repository actually uses, where no commit on either side shares a patch-id with the other, and it keeps holding after the base moves on because the MERGE adding nothing is what is read, never the two trees happening to be equal. Three-valued on purpose: an unusable ref prints no tree and returns `null`, so "could not check" never arrives as "already landed", which is the direction that discards work
- [x] SC-682: lib/prior-branch.ts contains [isHarnessScratchRef, rungate-preserved/] — one exported predicate holds every namespace that carries an issue number without being resumable work, so adding the rescue namespace is a line rather than a second `startsWith` somewhere else, and the predicate is exported so its coverage is testable directly rather than only through detection
- [x] SC-683: test/prior-branch-currency.test.ts contains [the two candidates no longer read identically] — the stale and the current branch are measured in the SAME fixture against the SAME base, and the defect is asserted directly: equal `commitCount`, different `behindCount`
- [x] SC-684: test/prior-branch-merged-detection.test.ts contains [a squash-merged branch is reported as merged, commitCount).toBe(2)] — the fixture proves its own premise in the same assertion block, because a "squash" fixture git treats as an ancestor would pass for a reason unrelated to squashing. `commitCount` staying 2 while `isMerged` is true IS the premise: the commit graph still sees two unmerged commits, so only the tree-level reading can be what answered
- [x] SC-685: test/prior-branch-merged-detection.test.ts contains [no git cherry call is reachable from detection, merge-tree] — the prose claim about patch ids is a test rather than a paragraph a later rewrite can quietly contradict, and it is asserted in both directions: `cherry` absent AND `merge-tree` present, so deleting the detection outright cannot satisfy it
- [x] SC-687: test/prior-branch-merged-detection.test.ts contains [an unusable ref is unmeasured, not merged, a usable ref still gets a real answer] — `mergedIntoBase` has two ways to answer "I don't know" and only the first was reachable by a test, so the fail-closed promise in its docblock could not be falsified: changing the `TREE_OID` guard to `return true` left 0 of 44 red. The uncovered path is the one that matters, because `merge-tree` exits 1 for an unusable ref exactly as it does for a real conflict, so the error arrives looking like an answer. The premise case is part of the criterion: a usable ref must still return a real boolean, or "null for everything" would satisfy the refusal half on its own
- [x] SC-686: test/prior-branch-preservation-exclusion.test.ts contains [the real branch is still nominated even though every scratch ref is newer, an ordinary issue branch is not scratch] — the excluded refs are deliberately the NEWEST in the fixture, so a filter that does nothing loses the nomination to them; a positive-control branch for the same issue is still nominated, so a filter narrowed to everything cannot buy green either

What was broken to prove it, run and counted rather than asserted, over
`test/prior-branch-currency.test.ts` + `test/prior-branch-merged-detection.test.ts`
+ `test/prior-branch-preservation-exclusion.test.ts` + `test/prior-branch.test.ts`
+ `test/prior-branch-remotes.test.ts` (47 tests):

| Mutation | Red |
|---|---|
| the behind side hardwired to `0` | 2 of 44 — the stale branch reads as current, and the two-candidates case stops distinguishing them |
| `mergedIntoBase` short-circuited to `return false` | 3 of 47 — the merge-commit case, the squash case, and the usable-ref premise guard. Re-measured after the implementation changed from an ancestor-plus-tree-in-history pair to one `merge-tree`; the earlier table recorded 2 of 44 against `isContainedInBase`, which no longer exists |
| `mergedIntoBase`'s `TREE_OID` guard changed to `return true` | **0 of 44 before this was caught, 2 of 47 after.** The docblock promised fail-closed and nothing could falsify it: the only "unmeasured" test removed the BASE, so it returned `null` from the function's first line and never reached the guard. `merge-tree --write-tree main <unusable-ref>` exits 1 — the same code a real conflict exits with, which is why 1 is deliberately allowed through — and prints no tree, so without the guard an empty line is compared against the base's tree and "could not check" becomes "already landed". That direction discards work. The new block in test/prior-branch-merged-detection.test.ts reaches it, and carries a usable-ref premise case so "null for everything" cannot pass it |
| `rungate-preserved/` dropped from the exclusion list | 3 of 44 — the rescue ref wins the recency tie-break and is nominated for both issues |
| `isBehind` hardwired to `false` | 1 of 44 — the flag has to be derived from the count rather than decorating it |
| an unanswerable divergence reported as `{ ahead: 0, behind: 0 }` | 2 of 44 — the new null case AND #164's pre-existing one, which is how the rewrite is shown not to have dropped the older rule |
| a `git cherry` invocation added back to the detector | 1 of 44 — the source check, which is otherwise a sentence nobody re-reads |

None is left in the tree; all were run and reverted, and `lib/prior-branch.ts`
was compared byte-for-byte against a copy taken before the first mutation. The
sixth row is the one worth reading twice: #164 settled that an unanswerable
count is `null`, and this change replaced the `rev-list` call that rule was
written against. The mutation shows the older test still guards it, so the
rewrite inherited the rule rather than restating it.

### The ceremony tier had a downgrade and no floor (#215)

`discovery.ceremonyTier` is chosen by the discovery LLM from issue SIZE alone,
and the only code that adjusted it afterwards was a one-way DOWNGRADE:
`if (!hasUI && tier !== 'LIGHT') tier = 'LIGHT'`. `hasUI === true` never raised
anything. So a project that DECLARES pages, whose issue the discovery agent
happened to size XS, ran LIGHT — which switches off the scope gate, Quinn
local, Quinn verify, container verify and prove — and the run still reported
DONE. DailyBriefDashboard declares 18 pages and would have had all 18 untested.

The fix is the downgrade's symmetric partner, and it RAISES only. Config beats
judgement on purpose: `pages` is a fact the consumer declared, size is an
opinion an LLM formed from an issue title. A project already at THOROUGH keeps
it, a genuine `pages:{}` project is still downgraded to LIGHT by the existing
clamp, and a tier outside the enum is raised rather than trusted — "the ranking
cannot place this value" must not arrive as "it is high enough already".

`workflows/ship.js` is a workflow script rather than an importable module, so a
source-text assertion would prove only that the text exists. The floor is
therefore a marked block that `test/ship-ceremony-tier-floor.test.ts` EXTRACTS
and RUNS, and ship.js's own tier statements — the `hasUI` computation, the
existing downgrade, the floor call and the raise — are extracted and executed
together in SOURCE ORDER, so the downgrade overwriting the floor would be
visible. Position is asserted separately by `assertMarkedBlockReachable`,
because the 2026-10-08 mutation leaves every one of those extractions
byte-identical over a block that never runs.

- [x] SC-688: workflows/ship.js contains [CEREMONY-TIER-FLOOR-START, function ceremonyTierFloor(tier, hasUI)] — the floor is a marked block rather than an inline ternary, so the whole (tier, hasUI) table is extracted and RUN; ship.js cannot be imported, and every source-text assertion in this repo has survived its first mutation
- [x] SC-689: workflows/ship.js contains [const flooredTier = ceremonyTierFloor(discovery.ceremonyTier, hasUI)] — the chooser is APPLIED to the tier the phases read, at one site, below the downgrade; a floor that is computed and never assigned is the shape this whole section exists to catch
- [x] SC-690: workflows/ship.js contains [if (!hasUI && discovery.ceremonyTier !== 'LIGHT')] — the existing CLI downgrade survives the change, because replacing a broken one-way clamp with a guard that forces STANDARD unconditionally is the same defect pointing the other way
- [x] SC-691: test/ship-ceremony-tier-floor.test.ts contains [parts.sort((a, b) => a.index - b.index)] — ship.js's own tier statements are executed IN SOURCE ORDER, inheriting SC-677's rule: a fixed assembly order would apply the floor before the downgrade wherever the file put them, and the downgrade overwriting the floor is exactly the regression this has to be able to see
- [x] SC-692: test/ship-ceremony-tier-floor.test.ts contains [the real source is accepted and the if (false) mutant is REFUSED] — both halves, in one test: the unmutated file resolves to `["Program"]` and the wrapped copy raises `ReachabilityRefusal`, so a refusal that fired for every input could not buy green
- [x] SC-693: test/ship-ceremony-tier-floor.test.ts contains [the wrapper is outside the markers: the marked bytes are untouched] — the slice the execution tests read is asserted byte-identical between the real source and the mutant, which is the reason reachability is checked at all rather than a second way of saying the block exists

What was broken to prove it, run and counted rather than asserted, over
`test/ship-ceremony-tier-floor.test.ts` (31 tests) and, for the first row,
`test/reachability-refusals.test.ts` as well (88 tests together):

| Mutation | Red |
|---|---|
| the whole `CEREMONY-TIER-FLOOR` region wrapped in `if (false)`, with the wrapper OUTSIDE the marker comments | 4 of 88 — 2 of 31 in the new file alone. The mutation that defeated BLOCKING-GRADES, SECURITY-DECISION and COMMIT-STATE-GUARD on 2026-10-08, run here verbatim. Every extraction and every executed row stayed GREEN: only the two reachability assertions and the two positive controls in `test/reachability-refusals.test.ts` could say the block was dead |
| the floor's comparison short-circuited to `return tier` | 6 of 31 — the raised row in both tables, the operator log, and all three cases that build the in-test no-raise mutant, which now throws `could not build the mutant` because its target is already in the tree |
| the raise removed, leaving `flooredTier` computed and never assigned | 10 of 31 — every extraction aborts with `could not locate the tier raise`, rather than passing quietly over a floor nothing applies |

None is left in the tree; all were run and reverted, and `workflows/ship.js`
was compared byte-for-byte against a copy taken before the first mutation. The
first row is the one worth reading twice, and it is why the block is marked at
all: the mutation changes nothing a text match or an execution of the extracted
slice can see, so without the reachability assertion this section would have
shipped 31 green tests over a floor that never ran.

---

## 6. ITERATION — Convergence + stuck detection

**Purpose:** Decide what to do when verification fails. Replan, don't just retry.

**Doc hygiene at every iteration boundary (MANDATORY):** Before looping back to DISCOVERY, run `Skill("doc-hygiene")` to verify ARCHITECTURE.md, PROJECT-STATE.md, PRINCIPLES.md, and any relevant ADRs reflect what was learned or changed in the iteration just completed. This is not deferred to FEEDBACK — operational discoveries (e.g., which data directory holds live auth, which env vars are required) rot fastest and must be captured while fresh. If doc-hygiene finds nothing to update, it exits immediately (<5s). The cost of running it is near-zero; the cost of skipping it is a repeat investigation next session.

**Deterministic compaction (Extended+ effort):** At every phase transition (DISCOVERY->RESEARCH, RESEARCH->PLANNING, PLANNING->EXECUTION, etc.), run `/compact` if the current effort tier is Extended or higher. This is deterministic — not triggered by a context % threshold. Phase transitions are natural compaction points because the prior phase's tool output is no longer needed verbatim.

**Stuck detection (mechanical checks — run every iteration):**

| Signal | Detection | Action |
|---|---|---|
| Same error 3x | Hash stderr output; trip when any hash appears 3 times | CIRCUIT BREAK |
| Same tool call 3x | Hash tool name + canonicalized args; trip on 3 matches | CIRCUIT BREAK |
| Iteration limit hit | Count iterations per issue; compare to circuit breaker in GOAL | CIRCUIT BREAK |
| Wall clock exceeded | Compare current time to start timestamp in checkpoint | CIRCUIT BREAK |
| Making progress | At least 1 new AC passed since last iteration | Continue — loop back to DISCOVERY |

**Stuck detection storage:** State persists in `$RUNGATE_WORK_DIR/{slug}/stuck-detection.json`:
```json
{
  "iteration_count": 0,
  "start_timestamp": "ISO-8601",
  "stderr_hashes": ["hash1", "hash1", "hash2"],
  "tool_call_hashes": ["hash1", "hash2"],
  "acs_passed_per_iteration": [0, 1, 1],
  "goal_audit_events": [],
  "goal_audit_count": 0,
  "baseline_values": { "SC-1": "54 downloadable items", "SC-2": "80% coverage" }
}
```
Updated at each iteration boundary. Read at each iteration start. Survives context compaction.

**Goal Audit gate (fires after stuck detection, before circuit-break decision tree):**

Three mechanical triggers — any one fires the gate:
- **T1: Numeric baseline drift** — a structured FINDING on the issue shows an SC baseline differs from the measured value by more than 20%
- **T2: Entity/method non-existence** — a structured FINDING reports an entity, API, or method referenced in an SC does not exist or fails reproducibly (not transiently)
- **T3: Research contradiction** — a RESEARCH finding posted after GOAL creation contradicts a scope boundary in the issue body

Detection runs for ALL sizes (cost: under 10 seconds of grep against issue comments for `FINDING:` patterns).

Response is size-gated:
- **XS/S:** STOP. Notify DA: "SC-N baseline incorrect: assumed [X], measured [Y]. Source: [FINDING comment URL]." DA decides next step.
- **M:** DA amends ACs on the GitHub issue (strikethrough old values, add new, document rationale via `gh issue comment`). Reset `stderr_hashes` and `tool_call_hashes` in stuck-detection.json. Re-enter at DISCOVERY.
- **L:** Mandatory council review of the GOAL (not the approach) using Goal-Level Review brief template (→ ~/.claude/PAI/BRIEF-TEMPLATES.md). Council decides: revise ACs, investigate assumption, or abort.

**Meta-circuit-breaker:** Max 2 goal amendments per issue. Third trigger = STOP unconditionally + notify Jason. This counts council-revised goals — the council is not exempt. `goal_audit_count` tracks this.

When Goal Audit amends ACs: reset `stderr_hashes` and `tool_call_hashes` (old errors were against wrong criteria). Preserve `iteration_count` (total budget tracking). Add event to `goal_audit_events` array:
```json
{ "iteration": 3, "sc_id": "SC-1", "assumed": "54", "measured": "97", "category": "baseline_drift", "outcome": "amended", "timestamp": "ISO-8601" }
```

**Distinguishing goal invalidity from method unreliability:** If the measured value contradicts the assumed value (54 items is actually 97), it is **baseline drift** — Goal Audit handles it. If the measured value is an error (4xx, timeout, exception), it is **infrastructure** — existing circuit-break path handles it. Do not conflate these.

**ADR-039 convergence-mode gates (M/L iterative work):**
- Immutable plugin registry — DISCOVERY audit functions locked at loop start; no dynamic registration mid-loop
- Git revert rollback — every iteration produces one squashed commit on feature branch; rollback = `git revert`; main untouched until convergence
- Numeric baseline corrections (changing the count an SC measures against, without changing goal intent) are NOT scope changes and do not require council vote. The DA amends via `gh issue comment` with rationale. Only intent-level changes (what we are trying to achieve, not just the numbers) require council.

**On CIRCUIT BREAK — decision tree (in order):**

```
0. Goal assumptions still valid?
   └─ NO (Goal Audit triggered) → size-gated response above
   └─ YES → continue to step 1

1. Framework/library issue?
   └─ YES → Context7 MCP first (10 sec), then retry
   
2. Need more information?
   └─ YES → Skill("Research") → findings to issue → replan

3. Found new sub-problems during execution?
   └─ YES → Create sub-issues via gh issue create
           → If parent has `Parent: #NNN` in body, post `CHILD-ADDED: #NEW — [title]` on umbrella
           → Work those via GOAL entry
           → Return to parent issue when sub-issues close
           → Umbrella closes via close-gate.sh decomposed path (D1-D4) when all children ship

4. 1-2 attempts failed on same approach?
   └─ YES → Escalate to specialist (→ CLAUDE.md Delegation Matrix for who handles what; → ~/.claude/PAI/BRIEF-TEMPLATES.md for brief format)

5. Per-goal budget exhausted?
   └─ YES → STOP
           → Write convergence report to GitHub issue
           → Write checkpoint to $RUNGATE_WORK_DIR/{slug}/CHECKPOINT.md
           → Notify Jason with: what shipped, what didn't, why, options
```

**Dynamic replanning (on every loop-back):**
- Re-read the GitHub issue (may have new comments/findings)
- Re-read findings from failed iteration
- Adjust approach based on what was learned
- If structured findings from VERIFICATION contradict the ACs themselves (not just the approach), fire the Goal Audit gate before replanning. If no structured findings were posted despite AC failures, DURABILITY gate blocks (durability-gate.sh check #2).
- Do NOT just retry the same thing

**Council gate (on structural replans):**
When a circuit break leads to a fundamentally different approach (not just a retry), run `Skill("council")` — 4 agents, 3 rounds — before committing to the new direction. This prevents the DA from picking a bad approach alone and catches drift before it compounds. Council is mandatory when:
- The replan changes the file scope (touching different files than the original plan)
- The replan changes the architectural approach (different data flow, different module ownership)
- 2+ circuit breaks have fired on the same issue (pattern of failed approaches)

**Output:** Either: issue closed (all ACs pass) OR checkpoint + convergence report.

**Quality bar:** Never retry without replanning. Never loop more than N iterations without hitting a circuit breaker. Never silently give up.

**Handoff:** PASS → FEEDBACK. BUDGET HIT → checkpoint + notify Jason.

**Reference:** → ADR-039 for convergence loop architecture, gap-list schema, convergence report template.

---

## 7. FEEDBACK — Automatic (hooks + DA actions)

**Purpose:** Make the system smarter for next time. Every closed issue feeds the learning loop.

**Process (fires on every issue close):**
1. Signal capture → ratings.jsonl (SentimentScorer hook, automatic)
2. Correction capture → if Jason corrected during session, feedback memory written
3. Update checkpoint → `$RUNGATE_WORK_DIR/{slug}/CHECKPOINT.md` marked complete
4. Doc cascade → `Skill("doc-hygiene")` — verifies ARCHITECTURE.md, PROJECT-STATE.md, PRINCIPLES.md, CONTEXT.md, ADRs all reflect what shipped. Not optional — stale docs cause the same failures as stale code. Falls back to Ship DURABILITY matrix if skill unavailable.
5. Close GitHub issue with evidence summary via `gh issue close`
6. BACKLOG.md → any follow-ups discovered during work get logged

**Nightly (automatic — MemoryLoop.sh at 23:30):**
- RuleTracker → correlates rules with session outcomes
- LearningReview → promotes recurring failures to CLAUDE.md rules
- GraphBuilder → rebuilds knowledge graph from memories
- RecallEvaluator → tests graph retrieval quality
- SkillOptimizer → monthly hill-climbing on skill text

**Output:** System learns. Next session starts smarter.

**Reference:** → MEMORY-LOOP.md for full nightly pipeline. → SELFLEARNING.md for the four-tier pipeline.

---

## Circuit Breaker Defaults

| Scope | Default | Override |
|---|---|---|
| Per-issue iterations | 5 | Set in GOAL issue body |
| Per-issue wall clock | 90 minutes | Set in GOAL issue body |
| Per-goal cost | $20 | Set in GOAL issue body |
| Per-goal token ceiling | 5M tokens | Set in GOAL issue body |
| Stuck detection | 3 identical errors or tool calls | Not configurable |
| Per-issue goal amendments | 2 | Not configurable |

---

## Artifact Flow

Every step produces an artifact. The next step consumes it. No step relies on conversation memory.

```
GOAL        → GitHub issue (system of record)
DISCOVERY   → Structured GitHub issue comment with file:line citations for every constraint answer
RESEARCH    → Findings comment on GitHub issue
PLANNING    → ACs + brief comment on GitHub issue
EXECUTION   → Committed code + deploy confirmation
VERIFICATION → Evidence per AC (completion report on issue)
ITERATION   → Updated issue comments + new sub-issues (if any)
FEEDBACK    → ratings.jsonl + memories + docs + closed issue
```

---

## Skills Invoked Per Step

| Step | Skill | When |
|---|---|---|
| GOAL | `Skill("goal")` | Always — first step |
| DISCOVERY | (built into Ship SCOPE) | Always |
| RESEARCH | `Skill("Research")` / Context7 MCP | Only when unknowns exist |
| PLANNING | `Skill("grill-with-docs")` | M+ size |
| PLANNING | `Skill("to-prd")` → `Skill("to-issues")` | L size |
| EXECUTION | `Skill("ship")` → `Skill("tdd")` → `Skill("simplify")` → `npx fallow` | Always |
| VERIFICATION | verify workflow + Quinn + Rook | Always — Rook every cycle, Quinn when there is a UI |
| ITERATION | (built into this standard) | When verification fails |
| FEEDBACK | `Skill("doc-hygiene")` | Always — docs must match what shipped |
| FEEDBACK | (automatic — hooks) | Always |

## `success: true` was serving two answers, and only one is a success (#181)

`runImplement` accepted `{success: true, filesChanged: []}` and the run
proceeded to commit. The only thing that read the field was a log line:

```js
log(`IMPLEMENT SUCCESS — ${(buildResult.filesChanged || []).length} files changed`)
```

It printed `0` and carried on.

Measured on `wf_17267830-401`. Marcus returned `filesChanged: []` with
`testOutput: "No tests run — … No code was changed."` — a clear explanation
that reached nothing. **An unrelated guard stopped the run:**
`COMMIT_STATE_NOT_RECORDED` (#166) fired only because the worktree had
gone. With the worktree intact, the commit step would have produced
`RUNGATE_NO_CHANGES` and the run would have travelled further on an empty
implementation.

"The agent implemented the issue and changed nothing" is not a state this
pipeline has. Every issue it ships is a code change, and the three ways an
empty list happens are all failures worth naming: the agent substituted a
different task, or decided the work was already done without the run having
checked, or errored and reported success anyway.

Same shape as #162's `{ok: true, collected: 0}` serving both "nothing to
collect" and "never told what to collect", and #166's effect the schema does
not mention.

- [x] SC-853: workflows/ship.js contains [IMPLEMENT-RESULT-START] — a marked guard treats an empty `filesChanged` from a SUCCESSFUL implement as a failure and stops the run. It says nothing about an already-failed result, which the caller's own branch refuses with its own findings — reporting that twice under a different reason misattributes the failure
- [x] SC-854: workflows/ship.js contains [reported success and changed no files — ${said}] — the refusal NAMES what the agent said it did. On the measured run `testOutput` explained the whole thing and none of it reached the run's result
- [x] SC-855: test/implement-empty-result.test.ts contains [the decomposed path ACTS on the refusal] — the guard is extracted by marker and EXECUTED, through the real `runDecomposedShip` block, with a positive control

### The decomposed path is the same defect, hidden by a union

`runDecomposedShip` merges per-sub-issue results into `allFilesChanged`, a
flattened set. One sub-issue that changed nothing is invisible the moment
the lists are merged — `alpha`'s one file makes the union non-empty and the
merged result looks healthy. So the guard runs **per sub-issue, before the
flatMap**, and the test asserts that ordering rather than merely asserting
the call exists.

### What was broken to prove it (SC-853..855)

Run and counted over `test/implement-empty-result.test.ts` +
`test/decomposed-ship-dispatch.test.ts` (22 tests):

| Mutation | Red |
|---|---|
| `runImplement` stops consulting the guard — the defect, verbatim | 1 of 22 |
| the decomposed path stops consulting it | 2 of 22 |
| the guard never refuses | 7 of 22 |
| a malformed `filesChanged` is assumed full rather than empty | 1 of 22 |
| the reason stops travelling with the failure (AC-2 undone) | 4 of 22 |
| the already-failed early return removed — a real failure misattributed | 1 of 22 |
| the label stops identifying which agent | 1 of 22 |
| the decomposed path reports the refusal and ships anyway | 1 of 22, and **0** before the case below was written |

**The last row is the finding.** SC-855's first draft GREPPED the decomposed
block for `implementRefusal(` and checked it appeared before the union.
Flipping the refusing branch's `ok: false` to `ok: true` left that green:
the guard still ran, in the right place, and its answer was discarded. A
guard whose result is computed and dropped is the same defect one layer up,
and it is exactly the shape of the bug being fixed — a value produced,
narrated, and not acted on. The test now runs the real block and asserts
the batch fails.

**A second finding came out of writing that test rather than out of a
mutation.** The fake agent keyed its empty response off `label.endsWith("-2")`,
because the dispatch reads `marcus-sub-${subIssue.number}`. The labels the
run actually produces are `marcus-sub-181001` and `marcus-sub-181002` —
synthesised from the issue number and an index, not from the sub-issue. So
both arms returned the same thing and the fixture tested nothing. Measured
by printing the labels, then keyed on the prompt instead.

**`test/decomposed-ship-dispatch.test.ts` injects the REAL guard**, sliced
from its own markers, rather than a stub. The block has a free reference to
it now, and a stub there would let the two blocks disagree about what an
empty implement result means with nothing able to notice.

None of the eight mutations is left in the tree; all were run and reverted,
and the counts were re-measured after the executed case was added so they
come from one tree.

## An AC's evidence must be able to satisfy its own threshold (#217)

The discovery agent writes the statement, the threshold and the evidence
command in one pass, and nothing then checks the three against each other.
Measured on `wf_5e3ed885-98c`, in a single AC, two independent ways:

```
grep -n 'SC-\w+' lib/conformity.ts | grep 'x]'       threshold: >= 1
```

`+` is an ordinary character in a BASIC regular expression, so the pattern
reads "SC-, one word character, a plus sign" and selects nothing in any
file. With `grep -E` it returns lines 199 and 318. The same AC also carried
`contains 'checked: boolean'` against a field legitimately declared
`checked?: boolean` at `lib/conformity.ts:269` — satisfied by the code,
unmatchable by the grep.

### This is the house defect, inverted

`.claude/rules/checks-must-be-able-to-fail.md` is about **a check that
passed because of what it never looked at.** This is **a check that failed
because of what it could never match.** In both, the verdict is independent
of the code under test — and that, not the direction, is the defect. A check
must be able to fail *and* able to pass.

### Refuse rather than repair

`workflows/ship.js` already repaired one shape of this, in silence:

```
Fixed ${ac.id} threshold: grep -c returns count, changed 'contains' → '>= 1'
```

A silently repaired AC is a changed acceptance criterion that nobody
reviewed — the harness deciding what the run is allowed to be judged on. The
repair is gone. The generalisation lives in one predicate and the run is
refused instead, at the scope gate, before Marcus is spawned.

The same edit narrowed P1-4's evidence-type upgrade: it rewrites a
`contains` threshold only on the branch that actually appends `| wc -l`.
Its `grep -c` branch leaves the command untouched, so rewriting that
threshold was the same unreviewed edit wearing the upgrade's hat, and it
made the measured AC unreachable by the refuser.

### Unsatisfied is the normal state of an AC; unsatisfiable is the defect

The refuser does not consult the dry-run's output, and must not. Before the
work is done, `grep -c newThing src/` returning 0 against a `>= 1` threshold
is what a CORRECT acceptance criterion looks like. Every refusal has to hold
for all possible code, which is a hard bar and is why there are three:

| Shape | Why the verdict is a constant |
|---|---|
| a quantifier a BRE reads as a literal | `\w+`, `[0-9]+`, `)?` — selects nothing in any file |
| a count compared as text | `grep -c` emits a number; `contains` can never hold over it |
| a count of counts | `grep -c … \| wc -l` prints one line per file whatever the matches were |

The first is positional, not a ban on the characters. `grep 'checked?: boolean'`
and `grep 'function foo('` are correct BREs whose author meant those
characters literally, and refusing them would break far more runs than it
saves. Only a `+` or `?` directly after a class or a group is refused.

`null` from the predicate means "not provably unsatisfiable", not "verified
satisfiable". The weaker claim is the honest one, and it is the direction
this is allowed to be wrong in: missing a bad AC costs one failed run that a
human reads, while a false refusal blocks a correct run and nobody trusts
the refuser again.

- [x] SC-856: lib/evidence-satisfiability.ts contains [LITERAL_QUANTIFIER, is a literal character rather than a quantifier] — a `+` or `?` directly after a character class or a group in a non-`-E` grep is refused as a literal, and a `+` or `?` anywhere else is NOT, because an author who wrote `checked?: boolean` meant it
- [x] SC-857: lib/evidence-satisfiability.ts contains [emitsCount, threshold can never hold over] — a command whose producing stage is `grep -c` or `wc -l` emits a number, so a text operator over it is incoherent regardless of the code, and the same command with a numeric operator is accepted
- [x] SC-858: lib/evidence-satisfiability.ts contains [countOfCountsRefusal, already prints a count] — `grep -c … | wc -l` is refused even with a numeric threshold, because its answer is a constant; a plain `grep … | wc -l` is the correct idiom and is accepted
- [x] SC-859: lib/evidence-prevalidator.ts contains [The evidence cannot satisfy its own threshold] — the refusal is consulted BEFORE the dry-run and classified `broken`, so it moves the verdict the scope gate refuses on. `empty` would not: it is a warning, and it is the same reading a correct AC produces before the work is done

### What was broken to prove it (SC-856..859)

Run and counted over `test/evidence-satisfiability.test.ts` +
`test/unit/evidence-prevalidation-gate.test.ts` (39 tests):

| Mutation | Red |
|---|---|
| `breRefusal` short-circuited to `null` | 5 of 39 |
| `thresholdRefusal` short-circuited to `null` | 2 of 39 |
| `countOfCountsRefusal` short-circuited to `null` | 3 of 39 |
| `LITERAL_QUANTIFIER` widened to a bare ban on `+` and `?` | 1 of 39 |
| `emitsCount` stops looking past a trailing `tr` | 1 of 39 |
| `readGrep` stops honouring `-e`, so a dash-leading pattern reads as a flag | 1 of 39, and **0** before the case below was written |
| the pre-validator stops consulting the refuser | 2 of 39 |
| the refusal is judged on the written command, not the repaired one | 1 of 39 |
| ship.js's silent repair restored | 1 of 39 |
| the P1-4 `grep -c` branch rewrites a threshold it did not earn | 1 of 39 |

**Row four is the one worth reading.** It restores the rule this fix was
first drafted with — refuse any `+` or `?` in a non-`-E` grep — and the test
that catches it is a NEGATIVE control, not a positive one. A detector
widened until it cannot miss is the mirror of one narrowed until it cannot
see, and #217's own reproduction, `checked?: boolean`, is among the patterns
the wider rule would have refused.

**Row six is the finding.** Deleting `-e` handling scored zero, because for
an ordinary pattern `-e` changes nothing — the pattern is the next token
either way. The branch is only load-bearing for a pattern that BEGINS with a
dash, which is the entire reason `grep -e` exists. Without a case that
distinguishes them, the branch could have been deleted and every other
assertion would have stayed green. The distinguishing case is now in the
file, in both directions.

**Row eight is why the refusal is judged on the repaired command.** The
bun-test-pipe auto-fix rewrites `bun test … | grep -c pass` to the direct
form, which deletes the `grep -c` and makes a `contains` threshold coherent.
Refusing the written form would refuse a command the pre-validator was about
to repair — found by #235's own fixture going red, not by a mutation.

**Rows seven and eight are also why the wiring is executed rather than
grepped.** Both commands in those cases run CLEANLY — `grep -c 'export'
package.json | wc -l` prints `1` and exits 0 — so a dry-run reports `ok` and
nothing downstream has a reason to look again. The third wiring case stays
green under row seven by design: it is the positive control.

None of the ten mutations is left in the tree; all were run and reverted,
and the counts were re-measured after the `-e` case was added so they come
from one tree.

## Every gate measures its own tree (#280)

`gates/gate-executor.ts` had `if (gate === "verify")` and nothing for ship,
so the ship gate consumed whatever evidence-pre-validation block the verify
gate had left behind.

Measured on run `wf_ea3e428f-64f`: re-running the pre-validator against
`projectRoot` reported 5 of 6 ACs broken; the persisted block said one, was
stamped `takenAt: "verify"`, and carried a `checkedAt` an hour old. The ship
gate filed a description of a tree it was not gating.

**Nothing was let through**, and that is the point worth being precise
about. The gate still refused, via `all-gates-pass` and the witness check,
and it named the real cause. What it got wrong was recording a **stale
artefact as current** — which is exactly what `takenAt` was added in #264 to
make impossible to misread.

Third instance in one family: #261 (producer in a phase the consumer does
not share), #264 (reading taken in the wrong directory and never re-taken on
heal), #280 (reading not re-taken at the next phase). Each fix moved the
boundary one phase and stopped, so the policy is now one predicate rather
than a condition inlined per call site.

### What survives, decided rather than inherited (SC-5)

| Gate | What survives | Why |
|---|---|---|
| verify | a `scope` reading | It measured the run's starting conditions; re-measuring those after Marcus has run answers a different question (#264) |
| verify | nothing else | The premise of another verify attempt is that the branch moved |
| ship | **nothing** | Between verify and ship the run commits, pushes, and may move the branch |

The old condition, `takenAt !== "verify"`, would have carried a *scope*
reading all the way to ship. Defensible one phase later, indefensible three:
on the measured run the implementation never reached `projectRoot` at all.
Re-measuring is a dry-run of commands that already ran once; that cost sits
far below a ship gate recording an hour-old reading as its own.

### The consumer enforces it too

`prevalidationViolations` refuses a reading at ship whose `takenAt` is
anything but `ship`, so a producer that stops re-measuring turns the gate
RED rather than quietly going stale again. #280 was not caught by a check —
it was caught by a human reading a timestamp.

Scoped to ship deliberately. There is no general "an earlier phase is stale"
rule available: a `scope` reading surviving to verify is correct, and
inventing the general rule restores #261 and turns every LIGHT run red.

- [x] SC-860: gates/gate-executor.ts contains [export async function prevalidationForGate] — the gate→reading mapping is ONE executed function, not a branch per gate inside a dispatch that spawns bun. With the branch inline, deleting it scored zero red across 52 tests
- [x] SC-861: gates/gate-executor.ts contains [export function shouldRetakePrevalidation, nothing survives] — the retake policy is one predicate with one binding to mutate, and it preserves a scope reading at verify while preserving nothing at ship
- [x] SC-862: gates/workflow.test.ts contains [not at ship — the ship gate must measure its own tree] — the consumer refuses a reading taken before its own phase, so a producer that stops re-measuring goes red instead of stale
- [x] SC-863: test/unit/prevalidation-at-ship.test.ts contains [every source is documented and every documented source exists] — PREVALIDATION_SOURCES and the guide's `takenAt` row are checked against each other in both directions, which the field-name parity test cannot do: `takenAt` is one field whatever its values are

### What was broken to prove it (SC-860..863)

Run and counted over `test/unit/prevalidation-at-ship.test.ts` +
`test/unit/evidence-prevalidation-gate.test.ts` +
`test/prevalidation-broken-ids.test.ts` (57 tests):

| Mutation | Red |
|---|---|
| the ship gate stops taking a reading — the defect, verbatim | 1 of 57, and **0** before the mapping became a function |
| `runGate` stops consulting the mapping | 1 of 57 |
| `runGate` passes a literal instead of the live gate | 1 of 57 |
| the mapping fires for every gate, putting scope's write out of order | 1 of 57 |
| `shouldRetakePrevalidation` stops re-taking at ship | 2 of 57 |
| `shouldRetakePrevalidation` re-takes unconditionally — #264 undone | 2 of 57 |
| `stampEvidencePrevalidation` becomes a no-op | 7 of 57 |
| the reading stops recording which gate took it | 4 of 57 |
| the consumer stops checking `takenAt` at ship | 2 of 57 |
| the consumer checks `takenAt` at every phase — #261 restored | 4 of 57 |
| the consumer's phase check swallows the refusals beneath it | 1 of 57 |
| the gate's check site stops passing the phase | 1 of 57, and **0** before that case was written |
| `ship` dropped from `PREVALIDATION_SOURCES` | 2 of 57 |
| the guide's `takenAt` row left at the old two values | 1 of 57 |

**Two zeros, and they are the same finding twice.** The first draft called
`ensurePrevalidationPersisted(state, sf, "ship")` directly and
`prevalidationViolations(reading, "SHIP")` directly, so both the gate
dispatch and the gate's check site were invisible. A per-gate `if` inside a
300-line function that spawns bun cannot be executed by a unit test, and a
phase-aware refusal whose caller never tells it the phase is a refusal that
can never fire. The first was fixed by extracting the mapping into a
function and running it; the second by asserting the single call site, which
is the weaker link and is held beside the executed cases rather than
instead of them.

**Row six is the control that keeps this fix from undoing the last one.**
A predicate that re-takes unconditionally everywhere passes every ship case
above and silently restores #264's bug at verify.

None of the fourteen mutations is left in the tree; all were run and
reverted, and the counts were re-measured after both zero-closing cases were
added so they come from one tree.

## A stale FAIL gets a review that reads the flagged code (#244)

Split out of #171. The verdict refusal sat 49 lines ABOVE the currency
check, so #171's re-review handled exactly one of the two stale cases:

| verdict | stale | what happened |
|---|---|---|
| PASS | yes | re-reviewed the new tip — what #171 added |
| PASS | no | shipped |
| FAIL | no | refused, correctly (#129) |
| **FAIL** | **yes** | **refused on findings about code no longer there** |

The stale-FAIL cell is not the rare one. A FAIL is a reason to remediate,
and the verify gate's self-heal loop is what produces the commit that makes
the review stale — so the case most likely to need a re-review was the one
case that could not get one. On run `wf_edc73e78-275` rook's two findings
were both real about `82c4c6a1` and both resolved in `f2487030`, and the run
refused anyway.

### The first attempt was a fail-open, and the shape of it is the point

`46034035`, reverted by `44ac641d`, flagged within minutes as
`fail-open-security-gate`. A re-review is DIFF-SCOPED: it reads
`reviewedCommit..tip`. That is right for a stale PASS — the base was read
and found clean, so only what came after needs reading. It is wrong for a
stale FAIL:

1. Rook FAILs commit `A` on a finding in `A`.
2. A remediation commits `B`, touching something else.
3. The verdict is stale, so it enters the re-review loop.
4. Rook reads `A..B`, sees nothing wrong, returns PASS.
5. The verdict is overwritten wholesale. The run ships. The finding is
   erased.

`base..tip` does not contain the code the finding was about. So the two
stale cases need different re-review MODES, and a stale FAIL gets a **full
review of the tip**.

### Two guards, in different places, on purpose

`reReviewBaseFor` returns null for anything not readable as a PASS, so the
loop never pins a FAIL's re-review to the flagged commit. `resolveReReview`
then refuses to let a non-full review clear a FAIL even if it is handed one.
The second is unreachable through the first, and it is there anyway: the two
decisions are made in different places, and a security clearing is not
somewhere to rely on an invariant holding one call site away.

Both fail closed **toward reading more**. An unreadable held verdict gets
the full review; the cost of being wrong that way is one extra review of a
whole tip.

### The #129 refusal is not conditioned on currency

That was the second finding against `46034035`: a run whose currency cannot
be established would skip an immediate refusal. #244 MOVES the refusal below
the re-review loop rather than adding a currency term to it. What is judged
is still "is the verdict in hand a PASS". The unreadable-currency case still
arrives there holding a FAIL, because `reReviewDecision` returns exhaustion
for an unreadable currency and the loop breaks without spending a round.

### The clearing is recorded, never a wholesale overwrite

A cleared FAIL carries `cleared: { priorVerdict, priorFailures, priorSha,
clearedBySha, clearedByRound, scope }`. Without it a reader of the run
cannot tell a branch that was never flagged from one whose findings were
erased by a review that never read them — which is what the revert was
about.

- [x] SC-864: lib/security-verdict.ts contains [export function reReviewBaseFor, does not contain the code the finding was about] — a stale PASS is re-reviewed against the commit that was read and found clean; a stale FAIL gets a FULL review of the tip, and so does any verdict not positively readable as a PASS
- [x] SC-865: lib/security-verdict.ts contains [export function resolveReReview, a diff against the flagged commit does not contain the flagged code] — a diff-scoped pass may never clear a FAIL, checked at a second site that the first one already makes unreachable, and a full pass that cannot name the commit it read clears nothing either
- [x] SC-866: lib/security-verdict.ts contains [export interface ClearedFindings, clearedBySha] — a cleared FAIL records which findings were resolved, about which commit, by which review and in which round, so a verdict is never overwritten wholesale
- [x] SC-867: workflows/ship.js contains [SECURITY-REFUSAL-START, SECURITY_FINDINGS_OUTLIVED_REREVIEW] — the refusal moved below the loop rather than gaining a currency term, and exhaustion holding findings refuses under a different name from exhaustion holding a clean review

### What was broken to prove it (SC-864..867)

Run and counted over `test/security-verdict-blocks.test.ts` +
`test/stale-fail-rereview.test.ts` + `test/record-security-verdict.test.ts` +
`test/harness-standard-security.test.ts` (558 tests):

| Mutation | Red |
|---|---|
| the stale-FAIL path falls through to a ship — the refusal removed | 6 of 558 |
| the refusal is conditioned on currency — `46034035`'s second finding | 1 of 558 |
| the stale-FAIL path takes the DIFF-scoped loop — `46034035` verbatim | 10 of 558 |
| …and the second guard removed with it | 49 of 558 |
| `reReviewBaseFor` pins a FAIL to the flagged commit | 9 of 558 |
| `resolveReReview` assigns the re-review wholesale | 75 of 558 |
| a full pass with no reviewed commit clears anyway | 1 of 558, and **0** before the parity case below |
| the refusal name stops distinguishing findings from a clean exhaustion | 17 of 558 |
| an unreadable held verdict is read as a PASS | 84 of 558 |
| the loop stops re-reviewing a FAIL at all — #244 undone | 4 of 558 |
| library: `reReviewScope` always diff | 10 of 558 |
| library: the diff-scoped clearing guard removed | 51 of 558 |
| library: a re-review FAIL is read as a pass | 56 of 558 |
| library: a full pass with no reviewed commit clears anyway | 2 of 558 |
| library: `heldIsPass` reads anything not FAIL as a pass | 85 of 558 |

Rows one and three are the two the issue asked for by name. Row one makes
the stale-FAIL path fall through to a ship and the run must refuse; row
three gives it the diff-scoped loop and the run must STILL refuse, because
the second guard catches what the first one no longer prevents.

**The library/ship.js pairs are why the parity matrix exists.** Before it,
two mutations of the INLINED copies scored ZERO: the new tests drove the
library, and the end-to-end cases exercised only the paths a happy
re-review takes. A security clearing with two implementations and a test
for one of them is the house defect with a second address. The matrix drives
both copies over one input set — and found a real divergence on its first
run, in the refusal text for a re-review that returned nothing.

**Row seven is the finding inside the finding.** The matrix always supplied
a fallback commit, so the branch that fires when NEITHER the re-review nor
the caller names one was unreachable through it: a parity matrix comparing
two copies on inputs that never reach the code being compared. The library
scored 1 and ship.js scored 0 on the same mutation, which is the signature.

None of the fifteen is left in the tree; all were run and reverted, and the
counts were re-measured after the parity case was added so they come from
one tree.

## Prior work is found by what it says, not by what it is called (#223)

Issue #209 was shipped TWICE:

| run | branch | result |
|---|---|---|
| `wf_5e3ed885-98c` | `worktree-wf_5e3ed885-98c-9` | SHIP_FAILED, PR #219 |
| `wf_7ac5f614-d21` | `worktree-wf_7ac5f614-d21-9` | SHIPPED, PR #221 |

`git merge-base --is-ancestor 96fde39f origin/worktree-wf_7ac5f614-d21-9` →
NO. Run 2 did not contain run 1's work at all. It branched from `main` and
re-implemented from scratch: 45 minutes, 20 agents, 911k tokens, and two
divergent open PRs for one issue, where merging either silently discards the
other's work.

### The cause is narrower than "nothing checks"

Both detectors existed. Three things were wrong, and all three had to be
fixed for either to have helped.

1. **`detectExistingPR` had no caller.** Grepping the tree found it imported
   only by its own test. A detector nothing calls is indistinguishable from
   one that never matches.
2. **Both looked for the issue number in a BRANCH NAME**, and the harness's
   own branches are called `worktree-wf_5e3ed885-98c-9`. The number appears
   in nothing but the PR body — `Fixes #209`, which ship.js writes — and the
   commit subject, `fix(#209): …`, which ship.js also writes. Neither was
   read.
3. **`detectExistingPR` matched the PR's OWN number** — `issuePattern.test(
   String(pr.number))` — so PR #209 was the prior work for issue #209
   whatever it was about. A false-positive generator sitting where a detector
   was supposed to be, on the one path where a false positive stops a correct
   run from ever starting.

It also read only the ten most recent open PRs, and swallowed every API error
as "no existing PR" — the fail-open shape
`.claude/rules/checks-must-be-able-to-fail.md` names: "none found" and "could
not look" were the same value.

### What the refusal must NOT do

An unmerged prior branch on its own is not a reason to stop. That is RESUME,
and it already works: ship.js merges the prior ref into the worktree and
pushes back onto the same branch. Refusing there would break the only thing
that makes a second run cheap, which is a worse failure than the duplicate.

So the condition is narrower: **an open PR exists for this issue that this
run is not standing on.** When the prior branch picked up IS the PR's head,
this run is that PR's next commit and there is nothing to collide with.

### Widening a match must not readmit what was excluded

`detectPriorBranch` now matches a ref whose tip subject references the issue.
`isHarnessScratchRef` still excludes `worktree-`, `run/` and
`rungate-preserved/` refs (#185) — those name work a run REFUSED to collect,
and the branch this repo carries for issue 254 says "NOT reviewed, do not
merge" in its own tip message. Reading subjects widens which REAL branches
are found; the scratch exclusion is asserted separately so the widening
cannot quietly undo it.

- [x] SC-868: lib/prior-branch.ts contains [export function issueReference] — one binding decides whether a text references an issue, bounded on digits rather than on a `#` so it matches a PR body, a commit subject and a branch name alike, and total over the `null` body GitHub returns for an empty PR
- [x] SC-869: lib/prior-branch.ts contains [refs(pr?.title) || refs(pr?.body)] — an open PR is matched by what it SAYS, never by its own number; an API failure returns unreadable rather than null, so "no PR" and "could not look" stop being the same answer
- [x] SC-870: lib/prior-branch.ts contains [refs(c.branch) || refs(c.subject)] — a prior branch is found by its tip commit subject as well as its name, and harness scratch refs stay excluded either way
- [x] SC-871: workflows/ship.js contains [PRIOR-WORK-REFUSAL-START, PRIOR_WORK_OPEN_PR] — a run refuses before IMPLEMENT when the issue has an open PR this run is not standing on, and resuming that PR's own branch is not refused
- [x] SC-872: workflows/ship.js contains [function lookupTargets, function normalizeExistingPr] — the issue number and repo slug are validated before they are interpolated into the lookup command, and only a positive outcome of "none" is read as "no open PR"

### The step added to close a fail-open rebuilt it one layer up

Security review of `93ff36a8` raised five findings; three were real and two
of those were introduced by the fix itself.

**The reply schema had every field optional**, so an agent that reported `{}`
reported "no open PR" — the exact value-collapse the step exists to close,
arriving by a new route one layer above the library. The schema now requires
an `outcome` of `none`/`found`/`unreadable`, and `normalizeExistingPr` reads
everything that is not a positive `none` — or a `found` carrying an actual
number — as unreadable, which refuses. A schema can require the
discriminator; it cannot require that `prNumber` accompanies `found`, so the
normaliser does.

**The lookup command interpolates two args into three nesting levels** — a
double-quoted shell string wrapping TypeScript wrapping a single-quoted
literal — and `ISSUE`/`ISSUE_REPO` come straight off `parsedArgs`. The number
is also what `issueReference` builds a RegExp from, so a `".*"` arriving
there matches every PR in the repo and the run collides with whichever came
back first. `lookupTargets` checks both and reports that it could not look,
rather than repairing them into a different question. `issueReference`
THROWS on a number that is not one: a predicate that silently matches
nothing reads exactly like an issue with no prior work.

**`priorWorkRefusal` read a malformed PR record as "no PR".** `null` is how
"no open PR" is said; a record with no number is a broken reading, and the
direction to be wrong in on this path is toward refusing.

| Mutation | Red |
|---|---|
| `issueReference` stops validating its number | 2 of 67 |
| …and returns a never-matching predicate instead of throwing | 2 of 67 |
| the library reads a malformed PR record as "no PR" again | 5 of 67 |
| ship.js stops validating the issue number | 1 of 67 |
| ship.js stops validating the repo slug | 1 of 67 |
| ship.js reads `Number(issue)` directly — `null` becomes issue 0 | 1 of 67 |
| an empty reply means "no open PR" again — the fail-open rebuilt | 1 of 67 |
| anything not "found" means "no open PR" | 1 of 67 |
| "found" with no PR number falls through as no PR | 1 of 67 |
| a rejected input is skipped rather than refused | 1 of 67 |
| the `outcome` discriminator stops being required | 1 of 67 |

None is left in the tree; all were run and reverted.

### What was broken to prove it (SC-868..871)

Run and counted over `test/prior-work-detection.test.ts` +
`test/prior-branch.test.ts` (55 tests):

| Mutation | Red |
|---|---|
| `detectExistingPR` reads only the head ref again | 2 of 55 |
| the PR's own number is matched again | 1 of 55 |
| the lookup fails open again — `catch { return null }` | 2 of 55 |
| `detectPriorBranch` stops reading commit subjects | 2 of 55 |
| the scratch-ref exclusion removed — #185 undone by the widening | 1 of 55 |
| the subject taken as `rest[0]` instead of rejoined | 1 of 55 |
| the library refusal never fires | 10 of 55 |
| ship.js logs the refusal instead of returning — the issue's own mutation | 1 of 55 |
| ship.js's inlined copy drops the resume short-circuit | 1 of 55 (parity) |
| ship.js stops looking for an existing PR | 1 of 55, and **0** before the assertion below |
| the refusal is fed `null` instead of the lookup | 1 of 55 |

**The last two rows are the finding inside the finding.** The first draft
asserted that the text `detectExistingPR` appeared in ship.js before the
refusal. Replacing the agent call with `= null` left the name sitting inside
the now-dead template literal, so the assertion stayed green over a run that
had stopped looking — a detector narrower than what it detects, in the test
for a detector narrower than what it detects. The assertion now pins the
ASSIGNMENT (`const existingPrResult = await timedAgent(\`…detectExistingPR`)
and the argument the refusal is handed.

None of the eleven is left in the tree; all were run and reverted.

## A run's artefacts are attributable to it (#288)

`WORK_DIR` is `~/.rungate/<slug>/` and the slug is repo + issue number, so
every run of one issue writes into one directory. Nothing cleared it and
nothing stamped it. After a failed run the directory holds a complete,
plausible, WRONG set of artefacts — `rook-findings.json`, `rook-scope.json`,
`worktree-groups.json`, `marcus-brief.md`, `canaries.json` — and a reader
has nothing to tell them apart by.

Measured: `~/.rungate/pai-harness-254/workflow-state.json` was read while a
fresh #254 run was in flight. It showed `phase: VERIFY`, 6 ACs and a
populated findings file. The run was actually at `setup`, three agents in.
Everything read was the previous night's failed run, and a healthy run was
cancelled on that misreading.

Within a run this was already thought about: ship.js suffixes a re-review's
findings file `-r<N>` precisely so "a second review cannot read the first
one's findings file and report them as its own". The reasoning stopped at the
run boundary. Round 0 of today's run and round 0 of last night's are the same
path.

### No new write sites

`workflows/ship.js` has 45 return points. A design requiring an
`endRun()` stamp at each would be wrong by the time the 46th was added, and
the exits that matter most — refusals — are the ones most likely to miss it.
So disposition is DERIVED from what the harness already writes: the marker,
the run id in the state file, the state's own `updatedTs` heartbeat, and the
ship gate's verdict. Nothing asks ship.js to remember anything.

The order the reader applies them in matters, and each step is the question
the one before leaves open:

| Reading | Status |
|---|---|
| no marker | `NO_MARKER` — said as such, not as a verdict about a run |
| marker unparseable | `UNREADABLE` — said, not repaired |
| state names a different run, or names none | `MIXED` — the misreading itself, caught |
| ship gate has a verdict | `COMPLETED`, carrying it |
| heartbeat inside the window | `RUNNING` |
| otherwise, or unparseable | `ABANDONED` |

`COMPLETED` is about whether the run reached its end, not whether it liked
what it found — a FAIL counts, or every refusal would file as abandoned and
hide the ones that really were. An unparseable heartbeat is `ABANDONED`
rather than defaulting to `now`, which would report every corrupt directory
as a live run.

### Archived, never deleted

`beginRun` moves the previous run's artefacts to
`previous-run-<their runId>/`. `scripts/preserve-worktree-work.ts` exists
because output a run refused to collect is still output, sometimes the only
copy; trading a misattribution bug for a data-loss bug is not a fix. The
archive is named for the run that WROTE the files, so the directory reads as
a history. Existing archives are left alone — sweeping them into each other
would nest a tenth run's directory nine deep and bury the first.

### priorWork was passed and silently dropped

`ship.js` passed it to `initWorkflow`; `InitWorkflowInput` did not declare
it; nothing wrote it, and nothing read `state.priorWork` — all ten
references were to the in-memory `discovery.priorWork`. There was no type
error because the call is assembled into a `bun -e` template string and
evaluated at runtime, so TypeScript never saw the excess property. Silence is
the only reason it survived, and it is why #185 and #223 each had to
reconstruct prior-branch detection from scratch to investigate it.

`undefined` and `null` stay distinct: absent means nobody looked, `null`
means detection ran and found none.

### Adopted is not earned

A run that inherited six passing ACs and a run that implemented six passing
ACs produced the same artefact. `acProvenance` labels every AC in the prior
work's list — `{source: "adopted", branch}` or `{source: "this-run"}` —
because an absent entry is what an AC nobody classified looks like. This is
the reading `acCoverage` was added for in #251, missing on the neighbouring
field.

- [x] SC-873: gates/run-attribution.ts contains [export function newRunId] — a run id that cannot collide with the run before it, which is the pair a timestamp reports as one: a failed run and its immediate re-run
- [x] SC-874: gates/run-attribution.ts contains [export function beginRun, ARCHIVE_PREFIX] — claiming a work directory stamps it and moves everything that is not this run's into an archive named for the run that wrote it, so no artefact is readable in place without attribution
- [x] SC-875: gates/run-attribution.ts contains [export function runDisposition] — a reader is told NO_MARKER, UNREADABLE, MIXED, RUNNING, ABANDONED or COMPLETED from signals the harness already writes, and a state file disagreeing with the marker is reported rather than resolved
- [x] SC-876: gates/orchestrator.ts contains ["priorWork" in opts, acProvenance] — priorWork is declared and persisted so it cannot be dropped again without a type error, an explicit null survives as the measurement it is, and every AC says whether this run earned it or adopted it from a named branch

### What was broken to prove it (SC-873..876)

Run and counted over `test/run-attribution.test.ts` +
`test/state-contract.test.ts` (42 tests):

| Mutation | Red |
|---|---|
| the run id becomes a timestamp — collides on a re-run | 3 of 42 |
| `beginRun` stops sweeping — the dead run's artefacts stay in place | 7 of 42 |
| the sweep DELETES instead of archiving | 1 of 42 |
| the archive is named for the run doing the archiving | 3 of 42 |
| existing archives are swept into the new one | 1 of 42 |
| an unreadable marker is trusted, so its artefacts stay | 1 of 42 |
| a state file from another run is read as ours | 2 of 42 |
| a state file with NO run id is assumed to be ours | 1 of 42 |
| an unparseable heartbeat defaults to `now` | 1 of 42 |
| a cold heartbeat still reads as running | 1 of 42 |
| a FAIL ship verdict is filed as abandoned | 1 of 42 |
| no marker is reported as a verdict about a run | 1 of 42 |
| an adopted AC stops naming its branch | 1 of 42 |
| an unmet AC is left unlabelled instead of `this-run` | 1 of 42 |
| `initWorkflow` drops `priorWork` again — #288 undone | 5 of 42 |
| an explicit `null` `priorWork` is dropped as falsy | 1 of 42 |
| `initWorkflow` stops stamping the directory | 3 of 42 |
| the state file stops carrying the run id | 3 of 42 |
| ship.js stops passing `priorWork` to `initWorkflow` | 1 of 42 |

None of the nineteen is left in the tree; all were run and reverted.

### The sweep is a rename, so a traversal MOVES a file

Security review of `2559c8fa` found the one thing nineteen mutations had
not: `runId` is read out of a JSON file sitting in the directory whose
contents this module's entire premise is that it cannot trust, and then
joined into a path. A `runId` of `../../../etc` would have had
`beginRun` rename the previous run's artefacts out of the work directory
— a sweep is `renameSync`, so a traversal there does not read a file, it
moves one.

`isRunId` is the one shape check. A malformed id read from disk lands on
the same `null` an unparseable marker does, which is already the path that
mints a fresh name and archives anyway. A malformed id SUPPLIED by a caller
throws at `beginRun` rather than at the join, because it becomes this
directory's name in the next run's archive and the gap between accepting it
and using it is a whole run.

- [x] SC-877: gates/run-attribution.ts contains [export function isRunId, RUN_ID_SHAPE] — a run id becomes a directory name, so one shape check gates it at every boundary it crosses: minted, read from the marker on disk, or supplied by a caller

| Mutation | Red |
|---|---|
| the run-id shape admits a path separator | 4 of 47 |
| `readRunMarker` stops validating the id it read | 2 of 47 |
| a supplied runId is accepted unchecked | 1 of 47 |

None is left in the tree; all were run and reverted.

## No exit path discards an uncommitted worktree (#232)

#228 routed every COLLECT refusal through `preserveRefusedWork`. That was
correct, and it was scoped to the symptom that had been observed.

Measured: run `wf_89689f50-2e4` on #227 returned `IMPLEMENT_FAILED`, not a
collect refusal. Both worktrees were left entirely uncommitted at `73c056ab`
— 13 files in one, 3 in the other. Both agents had reported `success: true`,
with five mutation proofs between them and a green suite, and the work
included the complete instrumentation that became PR #231.
`preserveRefusedWork` never ran, because the run never reached a collect
refusal. Both were recovered by hand.

### "Add preservation to IMPLEMENT_FAILED too" is the wrong fix

That is the same mistake a third time. The property wanted is not "these
particular exits preserve" but **no exit path discards an uncommitted
worktree** — and only the second is testable as a class. `IMPLEMENT_FAILED`
is simply the exit that fired that day; nothing structurally prevented the
next one from being added without preservation, which is exactly how it came
to exist.

So there are two funnels and no third way out: `shipFailed` for SHIP_FAILED,
which carries the refusal ledger, and `terminalFailure` for every other
terminal status. Both preserve. `test/preserve-every-exit.test.ts`
ENUMERATES the terminal statuses out of ship.js and requires each to come
from one of them, so a status added later is named by a failing test rather
than by the next person to lose a day's work.

Only `ARGS_ERROR` is exempt, and the exemption is measured rather than
asserted: the test checks that every ARGS_ERROR site sits before the first
`await timedAgent(` in the file, so no worktree can exist yet.

### The registry sits where every agent reply passes

Recording a worktree at each site that builds a `buildResult` would be the
instance fix again — four sites today, and the fifth is the one that strands
the work. Every agent call goes through `timedAgent`, so `noteWorktrees`
runs there, on both its paths. It walks the reply rather than reading two
known fields, depth-bounded and cycle-safe, because it runs on every reply
in the run and a throw or a hang there is inherited by the whole workflow.

### Merged into LOCAL main is not safe to delete

`cleanupWorktrees` removed any worktree whose branch was an ancestor of
`main`. A branch merged into a main that was never pushed exists in exactly
one place on earth, and this function runs unattended from a SessionStart
hook. #228 and #232 are both about work that was correct and became
unreachable; removing a worktree whose commits are not on origin is the same
loss with a tidier name.

A repo with no `origin` returns 0 rather than the branch's whole length —
there is nowhere the work could have been pushed to, and answering literally
would stop cleanup dead in every local-only checkout, which is the
regression that gets a safety check reverted.

- [x] SC-878: workflows/ship.js contains [async function terminalFailure] — every terminal failure status is produced by shipFailed or terminalFailure, both of which preserve, enumerated out of the source so a status added later without one fails a named test rather than stranding the work
- [x] SC-879: workflows/ship.js contains [function noteWorktrees] — worktrees are recorded inside timedAgent, the one place every agent reply passes, by walking the reply depth-bounded and cycle-safe rather than reading the fields that happen to carry one today
- [x] SC-880: lib/worktree-cleanup.ts contains [export function unpushedKeepReason] — cleanup keeps any worktree whose branch holds commits no origin ref contains, and keeps one whose origin status could not be determined, while a repo with no origin still cleans up

### What was broken to prove it (SC-878..880)

Run and counted over `test/preserve-every-exit.test.ts` +
`test/unit/worktree-cleanup-merge.test.ts` (34 tests):

| Mutation | Red |
|---|---|
| preservation removed from ONE exit — IMPLEMENT_FAILED, the measured one | 1 of 34 |
| a NEW terminal status added without the funnel | 1 of 34 |
| `terminalFailure` stops preserving | 1 of 34 |
| `shipFailed` stops preserving | 1 of 34 |
| `timedAgent`'s labelled path stops recording | 1 of 34 |
| `timedAgent`'s unlabelled path stops recording | 1 of 34 |
| `timedAgent` returns something other than the reply | 1 of 34 |
| `noteWorktrees` reads only the top level | 2 of 34 |
| `noteWorktrees` stops excluding the project root | 1 of 34 |
| the depth bound removed | 1 of 34 |
| `preserveSeenWorktrees` passes an empty list | 1 of 34 |
| cleanup stops checking whether the work is on origin | 1 of 34 |
| an unanswerable origin check is read as "all pushed" | 1 of 34 |
| an unanswerable check removes the worktree anyway | 1 of 34 |
| the keep-reason is never consulted | 1 of 34 |
| a repo with no origin keeps everything instead of cleaning up | 4 of 34 |

Row one is the one the issue asks for by name.

**Four of these scored ZERO on the first pass, and all four for the same
reason: the test asserted on SOURCE TEXT where it needed to execute.**

- `timedAgent` was checked for containing `noteWorktrees(`. Deleting the
  labelled path's call left the unlabelled path's, so the text was still
  there. A text check cannot tell two call sites apart; the test now runs
  both paths against a stub agent.
- `preserveSeenWorktrees` was never executed at all, so "it passes an empty
  list" changed nothing observable.
- the cycle guard scored zero because the DEPTH BOUND is what makes the walk
  terminate — the guard is belt-and-braces over it. The bound is now what is
  asserted, which is the thing that is actually load-bearing.
- the unanswerable-origin arm needed git to fail between the branch read and
  the rev-list: real, but not stageable from a fixture. It moved into
  `unpushedKeepReason`, one exported binding the test drives directly.

None of the sixteen is left in the tree; all were run and reverted.

## #229 — one path, one key, and the segment that could never be a symlink

`claimKey` is the audit's reading of a path; `collect-worktree-files.ts`
resolves the same path with `realpathSync`. Wherever those two readings can
differ, a worktree can report a spelling the audit scores as uncontested and
the collector lands on a file somebody else claimed. That is #178's clobber
reached through normalisation, and it is the reason `claimKey` normalises at
all.

The normalisation was three anchored regexes — a LEADING `./`, duplicate
slashes, a trailing slash — and the anchor is the bug. `a/./b.ts` is a mid-path
`.`, which `^(?:\.\/)+` can never reach, so it survived as a key distinct from
`a/b.ts`, passed `escapesWorktree` untouched, and reproduced exactly:

> Two worktrees. A claims `a/b.ts`. B claims **and** reports `a/./b.ts`, so the
> claim check waves B through on the merits. The audit sees two uncontested
> files and raises nothing. Collection resolves `a/./b.ts` to `a/b.ts` and
> writes B's copy over A's claimed file.

Three regexes approximating one rule is also why the gap was invisible: each
was correct about its own spelling and none of them was the property. The rule
they were approximating is **drop every empty and `.` segment**, and it is now
one pass over `split('/')`.

### `..` is still refused rather than collapsed, and that is not an oversight

A segment that is exactly `.` can never be a symlink, so `a/./b` and `a/b` name
the same file on every filesystem and textual collapse cannot disagree with
`realpathSync`. `..` has no such guarantee: where a component is a symlink,
`a/../b` collapses textually to `b` while the collector resolves it somewhere
else entirely. Collapsing it would reintroduce the exact differential this
issue exists to close, in a form that is harder to notice because the key now
looks canonical. So `..` is left intact for `escapesWorktree` to reject.

**SC-1 as written in #229 asks for collapse and is therefore unmet by design.**
The recommended amendment — "maps to one key *or is refused*" — is Jason's call
and has not been made; it is not being applied silently here.

Ordering is load-bearing and the test pins it: `a/./../b` must normalise to
`a/../b` and stay refused. A rewrite that resolved `a/.` to `a` and then paired
`..` against it would hand back `b` and the refusal would never fire.

- [x] SC-881: workflows/ship.js contains [const segments = s.split('/').filter(seg => seg !== '' && seg !== '.')] — every equivalent spelling of a path maps to one claim key by dropping empty and dot segments in a single pass over the whole path rather than at the front of it, while absoluteness and traversal segments both survive for escapesWorktree to refuse

### What was broken to prove it (SC-881)

Run and counted over `test/collect-claim-enforcement.test.ts` +
`test/collect-claim-ownership.test.ts` +
`test/ship-remediation-commits.test.ts` (99 tests):

| Mutation | Red |
|---|---|
| the non-collapsing `claimKey` restored — the pre-#229 regex chain | 4 of 99 |
| the `.` collapse removed, empty-segment collapse kept | 6 of 99 |
| `..` starts being collapsed too | 5 of 99 |
| absoluteness lost — the leading `/` dropped | 6 of 99 |

Row one is the one the issue asks for by name, and the reproduction test is
among the four it turns red. No mutation scored zero.

Row two is larger than row one, which reads backwards until you check what each
removes: the pre-#229 chain still stripped a leading `./`, while "drop empty
segments only" stops stripping it anywhere, so it breaks the older cases too.

Rows three and four are the pair that makes the rewrite safe rather than merely
tidier. Both refusals in `escapesWorktree` read segments, the same thing the
collapse now reads, so each is driven directly — `escapesWorktree` is exported
from the sliced block alongside `claimKey`, because "the key still looks
absolute" and "the boundary still refuses it" are different claims and only the
second one matters.

None of the four is left in the tree; all were run and reverted.

## #392 — the SC id namespace is global, and nothing read it that way

`sync-sc-status` ticked `SC-388` in `SCAFFOLD-DECOMPOSITION-SPEC.md` —
`.claude/rungate.json has field keyFiles`, which is false — on the strength of
a comment in `test/gate-root-threading.test.ts` reading
`SC-388 (GATE-CONTRACTS-SPEC.md)`. The claim named its spec in as many words.
The matcher threw that away, because SC-388 looked unambiguous: exactly one
spec declares a *checkbox* for it.

Two independent defects produced that, and only fixing both closes it.

### The registry could not see half the namespace

`buildScRegistry` parsed `- [ ] SC-N:` lines and nothing else.
`GATE-CONTRACTS-SPEC.md` declares ten per-gate subsections as `### SC-N:`
headings, so ten ids read as unique while two specs declared each one. A
heading tracks nothing, but it OWNS the number just as firmly, and ambiguity
has to be computed over the namespace as it is rather than over the part of it
that happens to be tickable.

The registry now carries two maps, because "may this be ticked" and "does this
id name one criterion" are different questions and having one map is what
conflated them. `byId` keeps its exact prior meaning — checkbox declarations,
the flipper's view and `crossSpecCollisions`'s — and `declaredById` is every
form. `ambiguityOf` reads the second; nothing else moved.

### The allocator was per-file in a global namespace

`nextSCNumber` read ONE spec's content and returned its maximum plus one. In a
namespace `lib/sc-ids.ts` documents as global and
`test/spec-sc-ids-unique.test.ts` enforces as global, that is not an allocator
but a collision generator — and it generated all ten.
`GATE-CONTRACTS-SPEC.md` counted up to 378 in its own file and took 379..388
for its subsections; `CONFIG-DRIVEN-TESTING-SPEC.md` independently counted up
to 378 in *its* own file and took 379 next. Both were locally correct and
neither could see the other.

The registry is now passed in, so a number owned by a heading is as taken as a
tracked one. The one-argument form is unchanged for callers with no registry to
hand; silently changing that answer would be a different bug.

### The existing ten are counted, not renumbered

Widening `crossSpecCollisions` itself would turn
`test/spec-sc-ids-unique.test.ts`'s real-tree assertion red over ten ids, and
the remedy it prescribes — "renumber the later claimant" — is a spec-content
call about which side moves. **That decision is not taken here and needs
Jason's ruling**, along with a second thing found while measuring:
`GATE-CONTRACTS-SPEC.md` declares `### SC-388: gate-executor pass/fail
criteria` **twice**, at lines 61 and 143, with contradicting input contracts.

So the tracked-criterion guard stays at zero and `crossFormCollisions` ships as
a counted ratchet at ten with the ids named. Qualification already stops the
known ten doing harm; the ratchet stops an eleventh arriving unnoticed.

### The self-reference trap, caught for the fourth time

The first draft of `test/sc-id-namespace.test.ts` titled a case
`"gate-root-threading.test.ts no longer credits SCAFFOLD-DECOMPOSITION's
SC-388"`. A qualified title claim is exactly what credits a multi-spec id, so
that title ticked the criterion the file exists to stop being ticked — and the
suite caught it, failing with the file's own name in the credit list. The id
now lives only in comments and string literals here, neither of which is a
declaring position for an ambiguous id.

- [x] SC-882: lib/sc-ids.ts contains [scHeadingDeclarationPattern] — a `### SC-N:` heading declares an id as firmly as a checklist line does and enters the registry as one, anchored on the id opening the heading so a heading that merely mentions a criterion stays prose
- [x] SC-883: lib/sc-ids.ts contains [reg.declaredById.get(id)] — ambiguity is computed over every declaration form rather than over the tickable ones alone, so an id two specs declare requires a qualifier whichever forms they used
- [x] SC-884: test/sc-id-namespace.test.ts contains [a claim naming one spec ticked a criterion in another] — the reported false credit is driven end to end through the real matcher and paired with the same fixture renumbered apart so the refusal is distinguished from a matcher that credits nothing
- [x] SC-885: lib/sc-ids.ts contains [export function crossFormCollisions] — cross-form collisions are reported by their own exported function and the tree holds none so a new one fails a named test while a planted pair proves the detector still reads
- [x] SC-886: lib/create-sc.ts contains [reg?.declaredById.keys()] — an SC number is allocated above every id any spec declares in any form rather than above the maximum in one file which is what produced every one of the ten collisions
- [x] SC-887: test/sc-id-namespace.test.ts contains [the spec whose heading caused the ambiguity is unnamed] — an uncredited mention reports the spec whose declaration made it ambiguous because naming only the checkbox holder sends the developer to qualify against the one spec that was never the problem

### What was broken to prove it (SC-882..887)

Run and counted over `test/sc-id-namespace.test.ts` +
`test/spec-sc-ids-unique.test.ts` + `test/sc-claim-forms.test.ts` +
`test/sync-sc-status.test.ts` + `test/create-sc.test.ts` (120 tests):

| Mutation | Red |
|---|---|
| headings stop being parsed as declarations | 8 of 120 |
| `ambiguityOf` reads the checkbox map again — the fix, reverted | 2 of 120 |
| a heading becomes tickable — recorded into `byId` too | 3 of 120 |
| the heading pattern stops anchoring on the id, so prose headings count | 1 of 120 |
| `crossFormCollisions` short-circuited to `[]` | 2 of 120 |
| the per-file declarer dedup removed, so a spec collides with itself | 2 of 120 |
| `nextSCNumber` ignores the registry again — per-file allocation | 4 of 120 |
| `unqualifiedClaims` names only the checkbox holders | 1 of 120 |

Row two is the headline: reverting the one-word fix in place turns the
reported instance red.

**The last row scored ZERO on the first pass**, and the reason is worth
recording because it is not the usual one. Every case asserted that an
ambiguous id stops being CREDITED; none asserted that the developer is told
why. The reason string is the only route from "my claim was ignored" to
"qualify it", and naming only the checkbox holder is worse than naming
nothing — it reads "declared by SCAFFOLD-DECOMPOSITION-SPEC.md, name the spec
in a title", so the developer names the one spec that was never the problem
and the message repeats itself. SC-887 is that case; the mutation now scores 1.

Two of the eight also found pre-existing fixtures that had stopped being what
they claimed:

- `test/sc-claim-forms.test.ts` built a registry as an object literal
  (`{ byId: new Map(...) }`). The moment the shape grew a field the fixture
  stopped being a registry, and the positive control — the one case that
  stops "refuse everything" reading as the rule working — threw. It now calls
  `buildScRegistry`.
- `test/create-sc.test.ts` asserted the CLI appends `SC-101` after a fixture's
  `SC-100`. That hardcoded the per-file allocation this issue is about, and
  101 is taken by a live spec. It now asserts the properties — an id was
  allocated, it is above the file's own, and the real namespace does not
  already own it.

None of the eight is left in the tree; all were run and reverted.

### Two things the implementation found, both the same shape as the bug

**A heading must not reach the conformity engine.** The first version widened
`parseScDeclarations` to return both forms, which looked like the obvious
place — it is #330's single owner for what a declaration is. But
`lib/conformity.ts:339` returns that function verbatim as `extractSCs`, and
the conformity engine runs an assertion against every declaration it is
handed. Ten `### SC-N: ... pass/fail criteria` section titles became criteria
the gate tried to satisfy, and this file's own #330 case — "extractSCs and the
registry agree on what a declaration is" — caught it by naming all ten. A
heading owns a NUMBER; it does not state a checkable claim. Two questions, two
parsers, and only the registry reads the second.

**The reporter did not agree with the crediter.** `findTestFilesForSCs` has
always credited a file that cites an id in one place and declares it in
another. `unqualifiedClaims` did not: the first non-title mention won, so a
correctly qualified `describe` title was reported as unqualified because a
comment two lines above it named the same id — and the same comment BELOW the
title reported nothing. Site order decided the answer. The qualified set is
now settled across the whole file before anything is reported, which is what
let `test/agent-brief-template.test.ts` keep its SC-386 claim after naming its
spec.

Neither was in the issue. Both are the defect class the repo keeps finding:
a reading narrower than the question being asked.

- [x] SC-888: lib/sc-ids.ts contains [export function parseScHeadingDeclarations] — heading declarations are parsed by their own function and reach the registry alone so `extractSCs` keeps returning only tracked criteria and the conformity engine never asserts against a section title
- [x] SC-889: scripts/sync-sc-status.ts contains [const qualified = new Set(] — an id this file claims properly somewhere is not reported as unqualified elsewhere in it so the report agrees with the crediter instead of depending on which mention comes first
- [x] SC-890: test/sc-id-namespace.test.ts contains [function unexpectedCensusIds] — the census of ambiguous mentions names its ids through one comparison both the real tree and a planted swap drive because a length cannot say which id arrived or why

### What was broken to prove it (SC-888..890)

Run and counted over `test/sc-id-namespace.test.ts` +
`test/sc-claim-forms.test.ts` + `test/sync-sc-status.test.ts` +
`test/create-sc.test.ts` + `test/spec-sc-ids-unique.test.ts` +
`test/agent-brief-template.test.ts` (164 tests; the #392 cases were merged
into the file that already owned SC-787..791, which is the same subject):

| Mutation | Red |
|---|---|
| headings returned from `parseScDeclarations` again — the first draft | 4 of 164 |
| `parseScHeadingDeclarations` short-circuited to `[]` | 10 of 164 |
| a heading reported as `checked: true` | 2 of 164 |
| the qualified-set pre-pass removed from `unqualifiedClaims` | 1 of 164 |
| the census compares lengths rather than ids | 1 of 164 |

**The last row scored ZERO twice before it scored one**, and the reason is a
shape worth naming. The comparison was inline in the real-tree case, and on
today's data a length check and an id check agree exactly — the census is as
long as it is allowed to be, so the two readings only diverge when one id
leaves as another arrives. Adding a planted swap case did not help, because
the planted case had its own inline comparison and the mutation could not
reach it. Only extracting `unexpectedCensusIds` as one binding both call
sites drive made the mutation measurable. **An assertion that cannot be made
to fail on the data it runs against is not yet a check**, and a second
assertion of the same property somewhere else does not fix that — it has to
be the same binding.

None of the five is left in the tree; all were run and reverted.

### Both open questions, now answered

#392 left two decisions open because they were spec-content calls rather than
parts of a credit bug. Both are resolved, and the second turned out not to be
a question of preference at all.

- **Who renumbers: the heading side.** `GATE-CONTRACTS-SPEC.md`'s ten
  subsection headings moved to `SC-1400..SC-1409`; the four specs tracking
  those numbers as checkboxes did not move. The heading side is untracked, so
  no tick anywhere changed state, and it had exactly one external reference
  (`test/gate-root-threading.test.ts`) against the checkbox side's many.
  `crossFormCollisions` is now banked at zero.

  The block is 1400 rather than the 896 that "next free number" suggests, and
  the reason is worth recording because it is the same defect one layer out:
  `SC-899` through `SC-902`, `SC-910` through `SC-912` and a run up to
  `SC-1301` are already spelled inside test files as planted fixtures, several
  of them as `- [ ] SC-900: AGENTS.md exists` — a checkbox declaration in a
  string literal. Allocating a spec into that range would have made live
  criteria out of numbers the suite uses as scratch, which is precisely the
  collision this issue closed, recreated by the fix for it. `nextSCNumber`
  reads the spec registry and cannot see those, so it would have proposed 896
  and been wrong. Filed separately — fixture ids belong in the 9900 range the
  rest of the suite uses.

- **The duplicate was not a merge artefact and not a choice.**
  `GATE-CONTRACTS-SPEC.md` declared `### SC-388: gate-executor pass/fail
  criteria` twice with contradicting input contracts. Checked against
  `gates/gate-executor.ts` rather than reasoned about: `GateExecutorInput` is
  `gate`, `slug`, `issue`, `workDir`, `stateFilePath`, `harnessRoot` and
  nothing more, and `GateExecutorResult` carries `resultVal`/`attempt`/
  `exitCode` and no `testOutput`. The first block states exactly that. The
  second names two inputs the executor reads off `state` instead of receiving
  and an output field that does not exist, and `executeGate` is the only entry
  point, so there was no second function for it to be describing. It is a
  pre-#190 contract the `harnessRoot` work superseded, and it was removed
  rather than renumbered.

  A spec that contradicts itself is the documentation form of
  `.claude/rules/checks-must-be-able-to-fail.md`: either block could be cited
  as the contract, so citing the spec proved nothing, and the half that was
  wrong had been wrong since #190 without anything being able to notice.

### The renumbering made a safe mention dangerous (SC-1410, SC-1411)

Worth stating because it is the opposite of the direction this work usually
runs in. While `SC-388` was ambiguous, a bare comment mention of it credited
nothing — qualification was required, so prose about the collision was safe
by accident. Renumbering made the number unambiguous, which means a mention
in a declaring position now credits `SCAFFOLD-DECOMPOSITION-SPEC.md`'s
criterion for real, and that criterion is false: `.claude/rungate.json` has
no `keyFiles` field. The fix removed one hazard and created a smaller one.

So the prose convention is now a test rather than a note, and it is pointed at
the file most likely to break it — the one whose subject is that number.

- [x] SC-1410: test/sc-id-namespace.test.ts contains [a declaring mention credits an unticked criterion whose fact is false] — every test file is scanned for the renumbered-away id in a title or a credited comment form so prose about the collision cannot tick the live criterion that kept the number
- [x] SC-1411: test/sc-id-namespace.test.ts contains [function duplicateHeadingIds] — no spec heads two subsections with one id because a duplicate heading is still a declaration and the pair that produced this renumbering stated contradicting contracts under the same number for four months

## #327 — a tick is a claim that something was proven

#149 replaced "a test file mentions the id" with "a test file DECLARES the
id", and eight criteria lost their only coverage claim without losing their
tick. That PR deliberately left them ticked — `CHECKED_SC_BASELINE` exists to
stop a suite being made green by unchecking, and doing it silently is the same
defect from the other side — and deferred the ruling. This is the ruling.

Each of the eight was checked against the tree rather than against the
judgement that produced the tick. **Five were false and are unticked:** SC-9
(`TestSchema` has neither `test.rebuild` nor `test.stop`), SC-200 (there is no
generate-score loop anywhere), SC-201 (there is no review queue anywhere),
SC-93 (not falsifiable as written — "global dependencies" is undefined and the
tree holds both the benign `~/.rungate` state directory and a real
`$HOME/.claude/.gate-salt` read), and SC-502. Three stand: SC-123's conformity
assertion passes, SC-202 is implemented and driven and merely needed its claim
written in a declaring position, and SC-501 is explicitly superseded.

The full classification table, with what was found for each, is in
`specs/bootstrap-data-flow/success-criteria.md`.

### SC-502 was classified satisfied off a grep, and the grep was wrong

"No `execSync.*gh` or `Bun.spawnSync.*gh` in lib/, hooks/, gates/" is a
mechanical absence check wearing a `(behavioral)` tag, and the tag exempted it
from every check — #328's complaint, met as an instance. A line-oriented
search found nothing, so it was classified *satisfied, needs a test*.

Writing the test found the violation on the first run.
`gates/workflow.test.ts:1570` calls ``execSync(`gh issue view ...`)`` with
`execSync(` on one line and the command on the **next**, which is exactly what
a line-oriented search cannot see. The criterion had been ticked over a live
violation for its whole life.

That is this issue's own defect class caught inside the fix for it, and it is
the third time in two PRs that an assertion about source TEXT has been wrong
where executing the thing was right. SC-502 is unticked, the violation is
banked by name so a second one fails, and removing it is filed as #395 —
migrating a `gh` call is the GitHub-API-migration class, not the false-tick
class.

### The eight were the visible edge

Measured while classifying them: **748 ticked criteria, 161 with no cover of
any kind** — no declaring claim, no passing conformity assertion, no
behavioural exemption, no supersession. 125 of them in
`bootstrap-data-flow/success-criteria.md`, the rest spread over six specs.

SC-5 asks for a test asserting that count is zero. It cannot be zero today
without writing 157 tests or withdrawing 157 ticks, and a guard written to
pass over a backlog it cannot see is the defect this issue is about. So it
ships as a per-spec ratchet at the measured numbers, ratcheting **both** ways:
a spec over its number fails, and a spec *under* it fails too, because an
entry that has stopped being a violation is an entry nobody will ever remove.

### Supersession is cover, and that is a decision

`GITHUB-API-MIGRATION-SPEC.md` ticks SC-499, SC-500 and SC-501 with lines
opening `SUPERSEDED by ...`, recording what each criterion used to say and why
it was wrong. Demanding a test for a criterion that explicitly no longer
applies would push the spec to delete its own history, so `isSuperseded` is a
recognised cover state — anchored at the start of the statement, because a
criterion *about* supersession is still a criterion.

- [x] SC-891: lib/sc-cover.ts contains [export function uncoveredTickedScs] — one binding decides what cover is so a mutation of it is measurable rather than absorbed by a second implementation of the same question
- [x] SC-892: lib/sc-cover.ts contains [export function ratchetViolations] — the backlog of uncovered ticked criteria is banked per spec and ratchets both ways so neither a new one nor a resolved one can pass unnoticed
- [x] SC-893: lib/sc-cover.ts contains [export function isSuperseded] — a tick whose statement opens SUPERSEDED is a pointer rather than a proof and is anchored at the start so a criterion merely discussing supersession is not exempted
- [x] SC-894: test/ticked-sc-cover.test.ts contains [const KNOWN_GH_SUBPROCESS] — the one live gh subprocess is named rather than tolerated so a second one fails while the first is outstanding
- [x] SC-895: test/ticked-sc-cover.test.ts contains [the walk found files but read nothing out of them] — the absence scan asserts it read a substantial corpus before concluding that it found nothing because an empty corpus and a clean one are the same answer

### What was broken to prove it (SC-891..895)

Run and counted over `test/ticked-sc-cover.test.ts` +
`test/conformity-sc-binding.test.ts` + `test/rule-provenance.test.ts`
(48 tests):

| Mutation | Red |
|---|---|
| `uncoveredTickedScs` short-circuited to `[]` | 4 of 48 |
| `ratchetViolations` short-circuited to `[]` | 3 of 48 |
| the under-bank arm removed, so it ratchets one way only | 1 of 48 |
| a matcher that FAILS is read as cover | 2 of 48 |
| `isSuperseded` stops anchoring, so a mention exempts | 1 of 48 |
| the gh scan reads nothing — empty corpus | 2 of 48 |
| `GH_SPAWN` loses its word boundary | 1 of 48 |

**The last row scored ZERO first**, and the reason is the positive controls
were the wrong ones. They were `ghost`, `git push` and `high-throughput`, and
none of the three ever reaches the boundary: each fails on the character
AFTER `gh`, so the pattern rejects them with or without `\b`. The leading
boundary only decides a command ENDING in `gh` before a space or the closing
quote — `dough `, `sigh"`, `plough ` — which the controls now cover. A
positive control that cannot distinguish the two readings is not a control,
it is a third copy of the negative case.

None of the seven is left in the tree; all were run and reverted.

`CHECKED_SC_BASELINE` is 261 and the tree carries 743 ticked criteria after
the five withdrawals, so the floor is not reached and nothing needed
lowering. Recorded rather than adjusted, because a baseline silently left
alone is indistinguishable from one nobody checked.

## #210 / #202 — the goal extractor had no model of the document it read

`scripts/precompute-goal.ts` replaces two ceremony agents with two regexes
over the raw markdown of a GitHub issue. Both were wrong the same way, and
the cause is one sentence: **it matched lines.** A line inside a fenced code
block, a line under a "Scope" heading, and a line the harness itself wrote
into the issue are all just lines.

Three measured readings, not two. The third was found by this change.

| Reading | What the agent was briefed with |
|---|---|
| #210, shipping #209 | one AC: `` SC-N: `workflows/ship.js` executes [MARKER-NAME] `` — an illustration inside a fence showing the SYNTAX of a proposed SC, placeholders end to end |
| #202, run `wf_831f1294-088` | 414 characters of rescope banner as the goal, none of which describe the defect |
| **this change**, `test/fixtures/github/issue-48.json` | the goal `Parent: #47` — eleven characters of cross-reference |

The third is the worst of the three and had no issue number. Sub-issue bodies
open with `Parent: #N`, the old regex took the first paragraph, so **every
decomposed run in this repo's history briefed its agent with a cross-
reference as the problem statement.** #202's banner fires only on a rescope;
this fires on every sub-issue. It was invisible because an eleven-character
goal is still a string, and the fixture that would have caught it was in the
tree the whole time being asserted on for other things.

### Why a module, and why controls on every case

It was twenty lines at module top level in the script, reachable from no
test, which is why both filed defects were found by a human reading pipeline
output rather than by the suite. `lib/issue-extraction.ts` takes a string and
returns a value; every case below is a fixture.

Each positive case has a negative control beside it, because the cheap fix
for all three readings is to delete more:

- strip every code block → the real criterion outside the fence is lost
- discard every leading blockquote → the goal of any issue whose author opens
  with a quote is lost
- treat any line starting with `Spec: ` as front matter → a one-line prose
  paragraph that opens with the word is lost
- call everything a placeholder → every real issue refuses

All four controls are in the file, and three of the twelve mutations below
are the control arms themselves.

- [x] SC-1454: test/issue-extraction.test.ts contains [a line inside a code fence is not a criterion] — the #210 reading is not extracted while a real criterion outside the fence in the same body is, which a stripper that blanked everything would fail
- [x] SC-1455: test/issue-extraction.test.ts contains [criteria come from the Success Criteria section and nowhere else] — a checklist under another heading is not promoted, the section ends at the next heading of the same level, and an issue with no such section returns an empty list rather than refusing
- [x] SC-1456: test/issue-extraction.test.ts contains [an acceptance list made of placeholders refuses] — a list that is entirely template notation refuses, a real criterion beside a placeholder is kept, and the predicate is shown to separate notation from prose
- [x] SC-1457: test/issue-extraction.test.ts contains [the rescope banner is not the goal and a blockquote the author wrote is kept] — both executed, the second being the positive control so a parser that strips every blockquote cannot pass
- [x] SC-1458: test/issue-extraction.test.ts contains [a goal that is only metadata refuses instead of returning the title] — a short goal and a missing goal are not the same state and neither is a goal, and the refusal routes through one exit constant that is not the usage exit

### What was broken to prove it

Run and counted over `test/issue-extraction.test.ts` +
`test/precompute-goal.test.ts` (26 tests, 0 red). None is left in the tree.

| Mutation | Red |
|---|---|
| code fences are not stripped | 1 |
| criteria are taken from the whole body again | 4 |
| the section runs to the end of the document | 3 |
| a list of placeholders is returned instead of refused | 1 |
| `isPlaceholder` calls everything a placeholder — control arm | 12 |
| every leading blockquote is discarded — control arm | 1 |
| the harness banner is kept as the goal | 2 |
| front matter is not stepped over so `Parent: #N` is the goal again | 5 |
| any line starting with a marker is front matter — control arm | 1 |
| a too-short goal is returned rather than refused | 1 |
| `GOAL_REFUSE_EXIT` zeroed | 1 |
| the script stops acting on the criteria refusal | 1 |

**The control arm for the front matter scored ZERO on the first run and the
zero was closed, not explained.** Removing the length limit changed nothing,
because the only control that existed was a two-line paragraph whose SECOND
line carries no marker — the every-line rule saved it, and the limit was a
guard nothing tested. A one-line paragraph opening with `Spec: ` is the only
shape where the length is what decides, and it is a shape an author writes.
That case now exists and the mutation scores 1.

### The emitter and the parser are held together

A marker list the producer has drifted away from is worse than no list: the
banner comes back as the goal and nothing says so. `HARNESS_BANNER_MARKERS`
and `HARNESS_PREAMBLE_MARKERS` are exported, and the test asserts every one
of them still appears in `workflows/ship.js`'s decompose prompt. The prompt
was also tightened to name the strings as load-bearing rather than
describing them — it previously said "list the sub-issue numbers", which an
agent satisfied with wording the parser had never seen.

### What this does NOT fix

- **#79 is still open and adjacent.** This is about what the split destroys
  in the parent; #79 is about what the split carries over.
- **The criteria reading is still line-based inside the section.** A real
  markdown parse was considered and rejected for the same reason ADR-002
  rejected an AST config check: a dependency for a case that is not the
  realistic failure mode. Code fences and section scoping cover all three
  measured readings; the limit is stated here rather than left implicit.

## #189 — the decomposer was asked for an order and had nowhere to write it

`workflows/ship.js`'s decompose prompt ended with one orphan line:

> Return sub-issues in dependency order (foundations first).

`M_DECOMPOSITION_SCHEMA` had `title`, `acs`, `filesToModify` and `size`. It had
no field for an order, and `runDecomposedShip` dispatched every sub-issue in a
single `parallel(...)` call. The instruction was followed, the answer was
produced, and nothing read it — **#166's shape exactly: an instruction an agent
can follow perfectly without its output changing anything.**

### What that cost, measured

Run `wf_92dbb346-949` (#105) decomposed into four sub-issues whose
`filesToModify` were genuinely disjoint, which is all ship.js validated. The
dependency was not in the files. It was in the API:

| worktree | signature | behaviour |
|---|---|---|
| `-5` | `harnessRootFor(root: string)` | resolves the root the caller names |
| `-8` | `harnessRootFor(dir: string)` | walks up looking for `HARNESS.md` |

Two functions, one name, one file, opposite contracts. Both defensible, both
carefully commented, neither author able to see the other. Eight agents, 77
minutes, four worktrees of good work that could not be combined.

### File-disjointness is the wrong test, and it is also still needed

Overlap detects **merge** collisions. It cannot detect a **semantic**
dependency, and two sub-issues can hold disjoint files and still be ordered
whenever one creates something the other consumes — a function, an exported
type, a config key one writes and the other reads, a test helper, a CLI flag.
The overlap check at `ship.js:1028` stays (AC-3). Neither check substitutes for
the other and a run needs both.

### The positive control is the whole design

A scheduler that put one sub-issue in every wave would satisfy every ordering
case for free and destroy the only reason decomposition exists. So the
all-independent case — *one* wave containing everything — is asserted twice:
on the plan, and on the dispatcher's measured spawn order. It is the control
that stops the ordering cases from being satisfied by a serialiser.

### The direction this is allowed to be wrong in

Toward **refusing**, never toward running anyway. A cycle, a `dependsOn`
naming a sub-issue that is not in the list, a self-dependency, and two
sub-issues sharing a title all refuse with an empty plan. Falling back to
parallel on a dependency the scheduler could not read is the fail-open shape
`.claude/rules/checks-must-be-able-to-fail.md` opens with, and here it would
reproduce `wf_92dbb346-949` exactly while reporting that it had ordered the
work.

- [x] SC-1461: test/decomposition-waves.test.ts contains [a dependent sub-issue waits for its foundation, dependsOn produces topological waves] — executed against both copies, with the wave boundary carrying one line per barrier naming what it waited for (AC-5)
- [x] SC-1462: test/decomposition-waves.test.ts contains [independent sub-issues still run in parallel, no dependsOn means ONE wave containing everything, independent sub-issues still overlap in the dispatcher itself] — the positive control, asserted on the plan and on the dispatcher's measured spawn order so a scheduler that serialises everything cannot pass
- [x] SC-1463: test/decomposition-waves.test.ts contains [a dependency cycle is refused, a cycle refuses the dispatch and spawns no agent at all] — a cycle refuses loudly with an empty plan rather than deadlocking or falling back to parallel (AC-4)
- [x] SC-1464: test/decomposition-waves.test.ts contains [the inline copy and the library agree, assertMarkedBlockReachable] — a twelve-case matrix run through both copies, with a case asserting the matrix is not all refusals, and the inline block's position read off the parse rather than matched as text
- [x] SC-1465: workflows/ship.js contains [WAVE-DISPATCH-START, dependsOn:] — the schema has a field for the answer and the prompt names that field, so the ordering instruction has somewhere to land

### What was broken to prove it

Measured over `test/decomposition-waves.test.ts` +
`test/decomposed-ship-dispatch.test.ts` (48 tests), each mutation applied to
one anchor checked to appear exactly once, run, and reverted:

| Mutation | Red |
|---|---|
| the library ignores `dependsOn` — everything lands in one wave | 9 of 48 |
| the **inline** copy ignores `dependsOn`, library untouched | 13 of 48 — the parity matrix is what catches the extra four |
| the library serialises everything — one sub-issue per wave | 6 of 48 — the positive control, and the reason it exists |
| the cycle branch returns one flat wave instead of refusing | 4 of 48 |
| the dispatcher `await`s each wave member in turn | 3 of 48 — a plan-level control cannot see this one |
| the dispatcher stops gating wave N+1 on wave N's success | 1 of 48 |
| the dispatcher ignores `plan.refusal` and dispatches anyway | 1 of 48 |

One mutation is recorded separately because it does not produce a count.
Replacing the cycle refusal's condition with `if (false)` — so no branch ever
fires and `done` never grows — makes `bun test` **never terminate**; the run
was killed at 600 seconds. That is AC-4's "rather than deadlocking", observed
rather than argued: the refusal is not decoration on top of a scheduler that
would otherwise cope, it is the only thing standing between a cyclic
`dependsOn` and a hung run.

## #420 — the ordering half shipped; wave N's output was still invisible

#189 made wave N+1 wait for wave N to SUCCEED. It did not make wave N's code
READABLE, so a consumer sub-issue still wrote against an API it had only been
told about in prose — `wf_92dbb346-949`'s two `harnessRootFor`s with opposite
contracts, with only the cheaper variant prevented.

**Why the other half was left out, and why that was right at the time.**
Worktrees are spawned with `isolation: 'worktree'` against `PROJECT_ROOT` and
the harness takes no base parameter, so the only lever on where a wave-2
worktree starts is **where `PROJECT_ROOT`'s HEAD points when the harness
creates it**. Making wave 1 visible therefore means committing mid-run, and
mid-run committing is #267/#136 — on 2026-10-11 it left 907 lines of
unreviewed agent output staged on `main`.

So the difference between the defect and the fix is the ref, and the ref is
established and named before anything spawns:

| | |
|---|---|
| **Run ref** | `rungate/run-<issue>`, created only when the plan has a barrier. A single wave hands its output to nobody, and establishing a ref for it would move an operator's checkout off their branch to no purpose. |
| **On a default branch** | The checkout is switched onto the run ref rather than refused. The end-of-run commit step ALREADY requires a non-default branch, so a run that starts on `main` was always going to die after burning every agent. |
| **Detached HEAD** | Refuses, with its own message. "There is no branch" and "the branch is main" are different facts and a caller that cannot tell them apart cannot say which to fix. |
| **Rejected output** | Never integrated. A failed wave commits nothing, not even the siblings that succeeded — the next wave is not starting, so the only thing a commit would achieve is putting half a wave on the ref. |
| **Last wave** | Not integrated. It is handed to the end-of-run collect, which is where it already went. |

### The guard that predicted this change

`COLLECT-IDENTITY` describes itself as "the last statement before anything is
staged" and warns that "a THIRD path added later — or a result that reached
`agentResults` by any other route — would be committed from without passing
either of them."

The wave commit is that third path: it stages while that block is still
waiting for the decomposition to return. Its own ordering assertion (SC-1448)
went red the moment the first `collectAgentWork` moved above it, which was
correct of it. The answer is not to relax the ordering but to ask the SAME
binding at the new staging boundary — `worktreeIdentityViolations(…,
{ requirePath: true })`, before the collector, not after it — and to state
the ordering per staging point, so a fourth one cannot be added without
either passing the guard or turning the assertion red.

- [x] SC-1560: test/wave-integration.test.ts contains [a default branch and a detached HEAD refuse, and say different things] — three refusals and a two-branch positive control, so a decider that refused everything could not pass
- [x] SC-1561: test/wave-integration.test.ts contains [only a wave with a successor is integrated] — the predicate is a pure function with one binding, and the single-wave case is the one that must not move an operator's checkout
- [x] SC-1562: test/wave-integration.test.ts contains [wave 1's file is in wave 2's checkout, and absent without the commit] — executed over a real repository with real worktrees, and the CONTROL is taken BEFORE the commit, so the positive case cannot be satisfied by a file that was in the base all along
- [x] SC-1563: test/wave-integration.test.ts contains [a wave with no accepted output is not collected or committed] — rejected work never reaches the ref every later wave is built from (AC-4)
- [x] SC-1564: test/wave-integration.test.ts contains [a wave with a successor is collected and committed, and not pushed] — the shell guard against the default branch is in the prompt, there is no `git push`, and the ref stays local until the end-of-run commit step
- [x] SC-1565: test/wave-integration.test.ts contains [a commit that lands on another ref is a failure, not a success] — the branch is re-read from the reply and compared to the ref the run established, because an answer that disagrees is the interesting case (#218). Three cases, one per decider: an ordinary feature branch, which only the comparison can catch; a default branch, which only the refusal can; and a reply with no branch at all, which only the refusal can reach
- [x] SC-1566: test/wave-integration.test.ts contains [a collect that moved nothing does not produce an empty commit] — an empty commit would make the next wave's base indistinguishable from this one's
- [x] SC-1567: test/wave-integration.test.ts contains [each wave but the last is integrated, with only its accepted output] — asserted on the recorded integration calls, so a loop that integrated everything or nothing fails
- [x] SC-1568: test/wave-integration.test.ts contains [a failed wave integrates nothing, and so does a single wave] — carries the positive control in the same test: both independent sub-issues must still be SPAWNED before either returns, so a design that serialised everything to get visibility cannot pass (AC-5)
- [x] SC-1569: test/wave-integration.test.ts contains [a wave that cannot be integrated fails the run rather than dispatching on] — the consumer never starts, because it would have branched from a checkout without the foundation, which is the whole defect
- [x] SC-1570: test/wave-integration.test.ts contains [a checkout the run may not commit onto refuses before anything spawns] — the refusal text comes from the real decider and the spawn list is asserted EMPTY, which is AC-3 over the dispatch path rather than over the happy case
- [x] SC-1571: test/wave-integration.test.ts contains [a wave carrying a foreign worktree is not staged at all] — the identity guard is asked at the new staging boundary, and asked BEFORE the collector: nothing is collected and nothing is committed

### What was broken to prove it (SC-1560..1571)

Measured over `test/wave-integration.test.ts`, `test/decomposition-waves.test.ts`,
`test/decomposed-ship-dispatch.test.ts`, `test/implement-empty-result.test.ts`,
`test/implement-brief-precedence.test.ts` and `test/worktree-repo.test.ts` —
198 tests, baseline 0 red. None of the thirteen is left in the tree; all were
run and reverted.

| Mutation | Red |
|---|---|
| `waveNeedsIntegration` returns `false` — #420 reintroduced verbatim | 3 of 198 — the predicate, the recorded integration calls, and the failure the consumer's missing foundation produces |
| `waveNeedsIntegration` returns `true`, so the last wave is integrated too | 3 of 198 — the predicate, and both the two-wave and single-wave dispatch cases |
| `runRefRefusal` returns `null` for every branch | 3 of 198 — the decider, the no-branch commit case, and the pre-dispatch refusal |
| the detached-HEAD branch of `runRefRefusal` deleted | 2 of 198 — an empty branch name is not in `DEFAULT_BRANCHES`, so it falls through to `null` and a commit with no branch is accepted |
| the dispatcher stops establishing a run ref | 1 of 198 — nothing refuses a checkout the run may not commit onto, and the sub-issues spawn |
| the wave staging point stops refusing a foreign worktree | 1 of 198 — the behavioural case; the source-order assertion still passes, because the call is still there, which is why the behavioural case exists |
| `{ requirePath: true }` dropped from the wave staging point | 1 of 198 — only the per-staging-point source assertion, which is what it is for: a row with no path is silently skipped and no behaviour changes |
| the wave commit is not compared against the run ref | 1 of 198 — and **0 of 196 before SC-1565's feature-branch case was added.** Written with `main`, the case was held red by the `runRefRefusal` re-check two lines below, not by the comparison: two deciders agreeing, so no behavioural test could witness which was load-bearing |
| the landed ref is not re-asked whether it may carry a commit | 1 of 198 — the inverse of the row above. The only input the comparison cannot reach is a reply with no branch at all, and that case exists so this line is not one no test can turn red |
| a collect that moved nothing commits anyway | 1 of 198 — an empty commit would make the next wave's base indistinguishable from this one's |
| a failed wave is integrated anyway | 1 of 198 — rejected output reaches the ref every later wave is built from (AC-4) |
| a failed integration no longer fails the wave | 1 of 198 — the consumer dispatches from a checkout without the foundation, which is the whole defect |
| the wave commit prompt gains a `git push` | 1 of 198 — the ref is local until the end-of-run commit step |

The eighth row is the finding this battery existed to produce, and it is the
same shape as both of #415's: **two deciders that agree are behaviourally one,
so no behavioural test can witness the duplication, and a mutation of one
leaves the other unreachable.** Predicting each count before running is what
surfaced it — a 1 where two were expected is a finding exactly as a 0 is.

### What this does NOT fix, stated rather than implied

**AC-2's second clause is not delivered.** The issue asks that a dependent
sub-issue "does not start until sub-issue 1's `lib/paths.ts` is collected and
**visible in its worktree**". Waves gate on wave N's *success*; they do not
make wave N's output visible to wave N+1.

The reason is structural. Worktrees branch from `PROJECT_ROOT`'s HEAD at spawn
(`opts.cwd = PROJECT_ROOT`, `isolation: 'worktree'`), and no run branch exists
before implement — it is created at the record-build-commit step. Making wave
N's files visible to wave N+1 would mean committing mid-run to whatever branch
`PROJECT_ROOT` is on, which is `main`. That is the #267/#136 defect class
precisely, and it once left 907 lines of unreviewed agent output staged on
`main`.

So collection stays one step at the end. What the ordering half buys on its
own is still most of the value: sub-issue 4 is briefed after sub-issue 1 has
*succeeded*, so a run that was going to produce two incompatible
`harnessRootFor()`s now fails the foundation first and never briefs the
consumer. What it does not buy is the consumer being able to *read* the
foundation's code. Filed as a follow-up rather than left as a silent gap.

## #180 — the brief lost to text it never saw

The Workflow runtime prepends the relayed user request to every subagent
prompt and introduces it like this:

> `[user request]` The harness relays, verbatim and indented below, the user
> request that triggered this workflow run. **This relayed request is the only
> user voice in this task**; …

rungate does not write that sentence and cannot remove it. On
`wf_17267830-401`, which shipped #178, the relayed text was a status question
typed in the parent session in the same turn the run was launched — *"What do
we still need to do to get the pipeline to ship?"* — and Marcus returned:

```json
{"success": true, "filesChanged": [], "testOutput":
 "No tests run — the relayed user request was a status/priority question, not an
  implementation task, and the harness framing states the user request wins over
  the computed task. No code was changed."}
```

**The agent was not confused.** It followed the precedence the framing gave
it, and the framing was wrong for this run. `marcus-brief.md` for the same run
was correct and complete: 63 lines, five ACs, eight files to read, a canary.
It carried the issue's acceptance criteria, the governing spec, the file list
and the verify commands, and it lost to text it never saw.

### Why this is the harness's problem

Not launching a run in the same turn as an unrelated message avoids it, which
makes it a timing rule a human has to remember — the kind of control this repo
keeps filing issues about. The deeper problem is the precedence itself. For an
implement agent the brief *is* the task; the parent session is not the issue
tracker, and the relayed text is not guaranteed to be about this run at all.

### What changes, and what deliberately does not

The relay is **not** removed (AC-3). "Focus on the API half first" should
still reach the agent, and a notice telling an agent to ignore whatever the
user typed would satisfy every precedence case here while destroying the only
reason the channel exists — so the test asserts the notice says *narrow or
prioritise* and asserts it does **not** say *ignore*.

Two things change:

- **Precedence.** `briefPrecedenceNotice` is appended to every briefed
  prompt, as the **last** thing before the task. Last because the relay is
  prepended above everything this file writes, so the counterweight has to be
  the nearest instruction to the work rather than another line near the top.
  It goes on every briefed role rather than a list of implement roles: a
  hardcoded role name in harness code is its own defect, and the claim is true
  of every computed brief.
- **Reportability.** `BUILD_RESULT_SCHEMA` gains `taskSource`
  (`brief` | `relayed-request` | `both`), **required**. This is #166 applied
  to which instruction was obeyed — on `wf_17267830-401` the substitution was
  visible only because the agent chose to narrate it in `testOutput`. Absent
  is a refusal, not a pass, which is the same decision `worktreeRepo` made in
  #218: a field the run accepts as missing is a field that stops being
  written. `both` passes, because narrowing a brief is the supported case.

- [x] SC-1472: lib/brief-precedence.ts contains [the brief is the task] — every briefed prompt states the brief's Task and Acceptance Criteria are authoritative and a relayed request narrows them rather than replacing them
- [x] SC-1473: workflows/ship.js contains [taskSource] — the implement reply reports which instruction it worked from and the schema requires it so a substitution is a value rather than prose nobody parses
- [x] SC-1474: test/implement-brief-precedence.test.ts contains [a relayed request does not replace the brief, the brief alone still works] — driven over the extracted prompt builder with a positive control so a prompt that ignores every input cannot pass

### Two mutation zeros, and what they were

The first battery scored **0** on both of the act-on-it mutations: making
`runImplement` and the decomposed path compute the refusal and discard it
(`if (false && sourceRefusal)`) changed nothing. A guard that is called and
whose answer is thrown away is precisely the defect
`.claude/rules/checks-must-be-able-to-fail.md` is about, committed by the test
written for it — the call-site assertion was a `match()` count, and a count
still counts a call whose result goes nowhere.

Closed differently on each path, because the two paths are not equally
reachable:

- **The decomposed path is executed.** `runDecomposedShip` is extractable by
  marker, so the test runs it with one sub-issue reporting
  `taskSource: "relayed-request"` and asserts the batch fails and names it,
  with the all-`brief` batch beside it as the control.
- **`runImplement` is not extractable today** — it closes over a large part
  of the module and no test runs it. Its branch is anchored as exact text,
  checked unique, and its `return` is located with `enclosingChain`, which is
  the #204 pattern. That is weaker than execution and is recorded here as
  weaker rather than described as equivalent.

### What was broken to prove it

Measured over `test/implement-brief-precedence.test.ts` +
`test/implement-empty-result.test.ts` + `test/decomposition-waves.test.ts`
(82 tests), after the two zeros were closed:

| Mutation | Red |
|---|---|
| the notice is never appended to the prompt | 2 of 82 |
| the notice drops the brief's own path | 2 of 82 |
| absent `taskSource` is accepted | 2 of 82 |
| `relayed-request` is accepted | 2 of 82 |
| the refusal refuses everything except `brief` | 2 of 82 — the AC-3 control |
| the inline copy diverges from the library | 3 of 82 |
| `runImplement` computes the refusal and discards it | 1 of 82 — **was 0** |
| the decomposed path stops acting on it | 1 of 82 — **was 0** |
| `taskSource` dropped from the schema's `required` | 1 of 82 |

### What this does NOT fix

- **The relay still arrives first and still calls itself the only user
  voice.** This is a counterweight written by the consumer of a framing it
  does not own, not a fix to the framing.
- **`taskSource` is self-reported.** An agent that worked from the relay and
  says `brief` is not caught, and cannot be from inside this harness. What it
  buys is that the honest case is now machine-readable instead of depending
  on an agent choosing to narrate it.
- **Only the implement reply carries the field.** Quinn and Rook get the
  notice and have no equivalent slot; their schemas are a separate change.

## #79 — the Phase 2 issue's prose and the ACs it carried were written independently

When discovery produces more than `MAX_ACS_PER_ISSUE` ACs, the decompose step
groups them and opens a sub-issue per group after the first. It returns a
STRUCTURED list — `{number, phase, acIds}` — and separately writes each
sub-issue's BODY as prose. Nothing compared the two.

On #70 they disagreed completely:

| | what it said |
|---|---|
| the structured list | AC-7 a greenfield scaffold writes a `roles.json` with at least three agent role entries that survive a read-back; AC-8 hook registrations in `hooks.json` drive consumer hook deployment; AC-9 the existing scaffold and scanner tests still pass |
| #75's body | "Deferred scope — stale `.claude/rungate.json` customization path cleanup"; AC-7 `harness-managed.md` points at the new path; AC-8 generated workflow headers stop carrying the stale path; AC-9 no generated artifact references the old path |

The body's three are a restatement of **AC-5**, which was already in Phase 1.
Both halves are internally plausible — the ids line up, the spec cited is
real, the line numbers are real. A human or an agent picking up #75 reads the
prose, not the structured list, so the deferral would have re-fixed Phase 1's
work and closed the parent while `lib/scaffold/steps.ts:826` and
`scripts/scaffold-rungate-config.ts:97` went on writing an empty `roles.json`
and `hooks.json` for every greenfield consumer — the defect that opened #70.

**Scope loss here is silent and looks complete.** The sub-issue exists, is
linked to its parent, and has well-formed ACs. Nothing is visibly missing,
which is why the fix is a comparison rather than a better prompt.

### Why the id check alone would not have caught it

#75's body lists AC-7, AC-8 and AC-9. Every id is right. The statements are
what diverged, so the statement comparison is the load-bearing half and the
id check exists only for the case where a body carries one fewer. That
asymmetry is asserted — `test/phase2-decomposition.test.ts` runs #75's real
body through the comparison and states, as its own test, that an
id-only check passes it.

### Why the reference copy cannot come from the agent

The comparison's two sides must have different authors. The harness writes
`phase2-acs.json` from its own validated discovery output, via a `bun -e`
command the agent runs verbatim with the payload shell-quoted by
`shellSingleQuote`; the agent writes `phase2-grouping.json`, because the
grouping is the judgement it was asked for. Merging them into one file the
agent writes would put the reference side through the model, and a model
that reworded both the body and the thing the body is compared against would
pass any comparison.

The prompt also now LISTS the ACs. It previously listed none, so the agent
wrote each body by reconstructing the scope from memory, which is how #75's
body came to describe Phase 1's work.

### Two refusals, because they fail separately

`decompositionRefusal` reads the structure alone and runs inside
`runDiscovery` before anything downstream sees the split.
`phase2BodyViolations` reads a body against the ACs it is supposed to carry
and runs from `scripts/verify-phase2-bodies.ts`, which fetches each
sub-issue back **from GitHub** rather than trusting what the agent reported
writing. A grouping can be sound and the body still describe something else
(#70's case); a body can quote its ACs perfectly while the grouping has
dropped one. Both are refusals, never repairs: a decomposition the harness
quietly fixes is an acceptance criterion nobody reviewed (#217).

- [x] SC-1484: lib/phase2-decomposition.ts contains [decompositionRefusal] — the split is refused when an AC is in Phase 1 AND deferred (#79 AC-3) when it is in neither when two groups claim it or when an id nothing produced appears. Every problem is reported rather than the first
- [x] SC-1485: lib/phase2-decomposition.ts contains [phase2BodyViolations] — a body is compared to its ACs statement by statement after whitespace collapsing. #75's real body is the fixture and the test states that an id-only check passes it
- [x] SC-1486: scripts/verify-phase2-bodies.ts contains [readSplitPlan] — the comparison's reference side is written by the harness and the grouping by the agent so the two sides have different authors. The issue is read back from GitHub and an unreadable one is a violation not a pass
- [x] SC-1487: workflows/ship.js contains [PHASE2-DECOMPOSITION-START] — the inline copy is held to the library on a shared matrix and the prompt both lists the ACs verbatim and runs the verifier
- [x] SC-1488: test/phase2-decomposition.test.ts contains [REFUSE_EXIT] — the script's refusal is routed through ONE exported exit-code constant and every negative case runs twice: the real script which must refuse and a mutant with the constant zeroed which must not

### What was broken to prove it

Counted over `test/phase2-decomposition.test.ts` (48 tests). None of the
mutations is left in the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `decompositionRefusal` short-circuited to `return []` | 15 of 48 |
| the Phase-1-AND-deferred branch removed (#79 AC-3) | 3 of 48 |
| the neither-kept-nor-deferred branch removed | 4 of 48 |
| `phase2BodyViolations` checks ids only, not statements | 4 of 48 — the #75 fixture, both directions of the diff, and the paraphrase case |
| the comparison reads the whole body, not just the Success Criteria section | 1 of 48 |
| `normalise` lowercases and strips punctuation | 9 of 48 — a looser comparison buys green with blindness, which is why it is mutated toward leniency rather than strictness |
| `shellSingleQuote` stops escaping the apostrophe | 3 of 48 |
| an unreadable issue treated as clean | 1 of 48 |
| `readSplitPlan` takes the ACs from the grouping file too | 1 of 48 — the reference side back through the model |
| ship.js's inline refusal nested under a dead condition | 1 of 48 |
| ship.js's inline copy drifts from the library (`specElement` ignored) | 1 of 48 |
| the prompt stops listing the ACs | 1 of 48 |
| the prompt stops running the verifier | 1 of 48 |

**One mutation zero, found and closed.** `if (false) ` in front of ship.js's
`discoveryRefusal = shipFailed(` scored **0**: the test grepped the 1200
characters after the call site for that string and for `return false`, and
the mutation leaves BOTH in place. A detector narrower than what it detects —
the second shape in `.claude/rules/checks-must-be-able-to-fail.md`. The
decision is read off the parse now (#204): `enclosingChain` must put the
assignment and the `return` at the guard's own conditional depth, so nesting
either under another condition changes the chain. Re-measured: 1 of 48.

## #405 — the prove-label gate passed when it could not read the labels

```ts
let labels: string[];
try {
  labels = await getIssueLabels(createGitHubClient(), issueRepo, Number(issueNumber));
} catch {
  return;   // an unreachable GitHub is a PASS
}
```

Shape one in `.claude/rules/checks-must-be-able-to-fail.md`. A missing token,
a rate limit, a network blip and a typo'd repo slug all landed in that one
`catch`, and the check that exists to stop an unproven issue from closing
could not fail for the most common reason it would ever be unable to answer.
**"No blocking label" and "could not find out" were the same outcome.**

#395 left it deliberately: that issue swapped a `gh` subprocess for Octokit,
and making the gate refuse is a behaviour change to the ship pipeline with
its own blast radius.

### The token-less question, decided

#405 left it open — *"whether a token-less local run should refuse or skip. A
gate that refuses every local invocation is a gate people will comment out."*
Three outcomes rather than two, decided on what the environment can answer:

| token | read | verdict |
|---|---|---|
| absent | n/a | `UNMEASURED` — the environment was never able to answer |
| present | threw | `REFUSE` — something that should have worked did not |
| present | ok | `ALLOW` / `REFUSE` by `proveLabelViolation` |

A token-less run does not refuse, because every local `bun test gates/` would
block and the gate would be deleted within a week. It does not silently pass
either: the verdict is `UNMEASURED` and carries its reason, which is the
distinction `.claude/rules/config-access.md` draws — `SKIP` is
indistinguishable from success and `UNMEASURED` is not.

That is safe where it matters because of where the gate runs, checked rather
than assumed:

- `isShipPlus()` (`gates/workflow.test.ts:229`) is true only when workflow
  state says `SHIP` or `DONE`. The gate is reached from
  `gates/gate-executor.ts`, which spawns `bun test gates/` in the ship
  pipeline's own process environment, where a token is present.
- CI runs the file too — `ci.yml` runs a bare `bun test` — and has no token.
  It never reaches this code: a CI checkout has no workflow state, so
  `isShipPlus()` is false and the test returns first. The `gates` job does
  not run this file at all, only the conformity suite and the secret scan.

So the authenticated-and-still-failing case is the one real invocations hit,
and it is the one that now blocks.

- [x] SC-1489: lib/prove-label-gate.ts contains [proveLabelGateVerdict] — an authenticated read that fails REFUSES and names the read failure as the reason. "No blocking label" and "could not find out" produce different text so a blocked ship can be debugged
- [x] SC-1490: test/prove-label-gate.test.ts contains [throwingClient] — the failure branch is EXERCISED by a client whose read rejects rather than argued about and the token-less case is asserted to be UNMEASURED rather than ALLOW
- [x] SC-1491: test/prove-label-gate.test.ts contains [TEST_WORK_DIR] — the gate check is SPAWNED over planted state in both environments. The token-less run emits its UNMEASURED report and does not block; the same unreadable issue with a token present refuses

### The contract test the fix turned red, and why that was the fix working

`test/contract.test.ts` runs the ship gate over a synthetic project whose
`issueRepo` is `test/repo`. That repo does not exist, so the label read 404s,
and before #405 the 404 was swallowed — **the fixture did not satisfy
prove-label, it was merely unreadable by it.** The same sentence is already
written into that fixture about `code-pushed` (#174), where it was a bare
directory and `git rev-list @{upstream}..HEAD` failed and the failure read as
nothing-to-report. Two checks, one fixture, the same defect twice.

With the fail-open gone the contract answers differently depending on the
machine: green in CI, which has no token and so reports `UNMEASURED` and
returns, and red locally, where a token is present and the 404 is a refusal.
A contract whose verdict depends on who runs it is worse than either verdict,
so the DIFFERENCE is removed rather than the failure — the contract clears
`GITHUB_TOKEN` and `GH_TOKEN` for the gate subprocess, which is the
environment CI already gives it, and both agree.

#### The seam that was written first, and why it was deleted

The first attempt added `RUNGATE_PROVE_LABEL_FIXTURE`, an env var planting the
label list so the contract could exercise the check instead of skipping it,
defended by the claim that it supplied the input and never the verdict. **That
claim was false.** `RUNGATE_PROVE_LABEL_FIXTURE='["needs-prove","proven"]'`
allows a close on an issue carrying only `needs-prove`: the planting is judged
honestly and the thing judged is a lie. A seam that overrides an enforcement
input is a bypass however carefully its own contents are validated, and it
reached production code in `lib/`, not just the fixture.

What makes the deletion free is that the seam was buying nothing. The check's
decision is driven directly by 20 tests in `test/prove-label-gate.test.ts`,
and the wiring — the half #405 was actually about — is now **spawned** over
planted state the way #224 spawns the suite-verdict check:
`bun test gates/workflow.test.ts -t prove-label-enforcement` against a
`TEST_WORK_DIR` holding a `SHIP`-phase state, run twice, once with no token
and once with a bad one. The token-less run must emit
`PROVE_LABEL_UNMEASURED` and must not fail; the authenticated run must refuse.
That pair is strictly more than the seam proved, and nothing in `lib/` knows
a test exists.

Two details the spawn needs, both from #224. A `-t` filter that matches
nothing leaves bun reporting zero of everything, which is indistinguishable
from the check passing — so both cases assert `ran === 1` before reading any
verdict. And the report assertions are line-anchored: a failing bun test
echoes the source around the failure, the `console.error` that prints
`PROVE_LABEL_UNMEASURED` is inside that listing, and a bare `toContain` would
match the code that prints the line rather than the line.

### What was broken to prove it

Measured over `test/prove-label-gate.test.ts` (22 tests). None of the eleven
is left in the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| the authenticated read failure allows instead of refusing — the #405 fail-open, restored in the decider | 3 of 22 |
| an unreadable label set is treated as no labels | 7 of 22 |
| the token-less case refuses too, so every local `bun test gates/` blocks | 4 of 22 |
| the token-less case ALLOWS — `UNMEASURED` collapsed into clean | 3 of 22 |
| the two refusal texts become the same string | 2 of 22 |
| the detail is dropped from the refusal | 1 of 22 |
| the gate goes back to `catch { return }` | 3 of 22 |
| the gate stops printing the report and just returns — `SKIP`, not `UNMEASURED` | 1 of 22 |
| the gate reads `process.env.GITHUB_TOKEN` directly instead of `resolveGitHubToken` | 1 of 22 |
| the gate check is renamed, so the source guards read an empty slice | 2 of 22 |
| the gate check returns before the labels are read — the whole check switched off | 2 of 22 |

The seventh row scored **zero** on the first battery, and the reason is this
file's own subject. The guard was
`.not.toMatch(/catch\s*\{[^}]*\breturn;\s*\}/)` and the real source reads
`catch (e) {`, so the pattern could not match the code it was written
against — a detector narrower than what it detects, which is shape two in
`.claude/rules/checks-must-be-able-to-fail.md`. A negative text match is the
easiest place in a tree to write one, because it is green both when the defect
is absent and when the detector is blind, and nothing distinguishes those two
readings. The fix is to assert what the code must CONTAIN — the line handing
the read failure to `proveLabelGateVerdict` — which `catch { return }` cannot
be reintroduced without deleting, and which turns red rather than blind if the
source is reformatted.

The ninth row exists for the same reason one layer up. Both source-text guards
read a slice of `gates/workflow.test.ts`, and a slice whose start index is
`-1` is an empty string that satisfies every negative assertion in the file.
`gateCheckBody()` is the one bounded reader and it throws on either bound, so
renaming the check it looks for aborts both guards instead of passing them.

## #433 — the prior-branch matcher read digits inside generated run ids

`test/prior-branch.test.ts` passed locally and failed in CI on a PR touching
neither `lib/prior-branch.ts` nor anything it imports. Two causes.

**The matcher.** `issueReference` bounded on decimal digits —
`(^|[^\d])N([^\d]|$)` — which correctly stops `55` matching `550` and does
nothing about the branches this repo generates by the hundred. In
`worktree-wf_55baa4aa-a00-9` the `55` is preceded by `_` and followed by
`b`: both non-digits, so it matched, and `detectPriorBranch` reported a
stranger's abandoned fan-out worktree as issue 55's prior work. There were
149 such branches when this was found.

The bound is now `\b` — which is what "word-boundary matching", the name
these tests have always carried, actually means. A hand-rolled
`[0-9a-fA-F_]` class was written first and **a mutation widening it to all
letters scored ZERO**: no fixture could tell the two apart, because every
real form separates the number with punctuation. The zero was the finding.
The narrow class was buying nothing over the broad one, and `\b` is the
broad one already — it treats `_` and every letter as a word character, so
it rejects `worktree-wf_55baa4aa-a00-9` and `550-matcher-registry` and
accepts `209-deep-modules`, `fix/55`, `Closes #209` and `fix(#209):`. The
simpler expression is also the correct one.

**The test.** It asked the LIVE repository which branches exist and asserted
on whichever one won, so its verdict was a property of the week rather than
of the code. Two checkouts with different branch sets gave different
answers, and an unrelated PR went red. The bound is now pinned statelessly;
what remains against the real repo is the one property that holds for any
branch set — whatever `detectPriorBranch` returns, `issueReference` agrees
it refers to the issue asked for.

**A residual limit, pinned rather than papered over.** A fan-out branch ends
in `-<n>`, the fan-out index, which is a bare decimal number in exactly the
position a real reference occupies. Nothing about neighbouring characters
can tell `worktree-wf_be8d195f-0be-16` from `fix/16`, and a rule that tried
would reject real branches. The fix belongs in which candidates
`detectPriorBranch` considers, not in what counts as a reference. It bites
only issue numbers below the fan-out width, and a test asserts the
limitation so the next reader finds it stated.

- [x] SC-1499: lib/prior-branch.ts contains [word-boundary matching] — the reference bound is a word boundary so a generated run id is not read as an issue number
- [x] SC-1500: test/prior-branch-reference.test.ts contains [issueReference] — every accepted and rejected form is stated as a fixture rather than discovered from the live repository, and the residual fan-out-index limit is asserted rather than described

### What was broken to prove it

Measured over `test/prior-branch.test.ts` + `test/prior-branch-reference.test.ts`
(29 tests). Neither mutation is left in the tree.

| Mutation | Red |
|---|---|
| the bound restored to `[^\d]` — the #433 defect | 2 of 34 |
| the bound dropped entirely, so any substring matches | 5 of 34 |
| only the left `\b` kept | 2 of 34 |
| only the right `\b` kept | 2 of 34 |

A fifth was run and is recorded because it scored **zero**: widening the
first draft's `[0-9a-fA-F_]` class to `[0-9a-zA-Z_]` changed nothing any
fixture could see. That is not a weak suite — it is two expressions that
agree on every input this matcher receives, and the response was to take the
simpler one rather than to invent a fixture justifying the complicated one.
## #429 / #430 — the harness pushed to main, from a feature branch, during a test run

Four `wip:` commits reached `origin/main` on 2026-10-15 from a session that
was on `fix/405-prove-label-refusal` and never ran `git push`. GitHub's
activity log records three `push ref=refs/heads/main` events whose timestamps
match no commit — they match **gate and contract test runs**.

Two independent causes. Either alone is sufficient; fixing one leaves the
other live.

### #429 — the upstream of a new branch is main

`git checkout -b <name> origin/main` sets `branch.<name>.merge` to
`refs/heads/main`, not to a ref of the branch's own name. That is git's
default behaviour, not a misconfiguration, and it is how every branch in this
repo gets started. Reproduced in the test rather than asserted:

```
$ git checkout -b probe origin/main
$ git config --get branch.probe.merge
refs/heads/main
```

`lib/verified-push.ts` pushed `HEAD:${branch.<b>.merge}` with nothing
comparing that ref to the branch. So the ship gate's auto-push sent a feature
branch's HEAD to `main` and recorded a verified success — which it was, to
the wrong ref. **31 branches** in this repo tracked a ref other than their
own, 14 of them `main`.

The new `ref-mismatch` outcome refuses rather than retargeting. A branch
whose upstream names a different ref may be deliberate — this repo has
`fix/remove-hardcoded-quinn-rules-from-ship` tracking `refs/heads/ship-1344` —
and guessing which the operator meant is the silent repair
`.claude/rules/checks-must-be-able-to-fail.md` warns about. The refusal costs
one manual `git push -u`, and `leftWorkLocal` already says the work may be
local. `scripts/repair-branch-upstreams.ts` unsets the 31.

### #430 — a fixture `issueRepo` pushed the real tree

`gates/orchestrator.ts` guards the auto-push with `if (issueRepo && issue > 0)`
and pushes `process.cwd()`. `test/contract.test.ts` runs the ship gate with
`issueRepo: "test/repo"` and `issue: 9998` — both truthy — from inside the
real rungate checkout. The guard passed, the push ran, and the repository it
reached was the one that must not be touched. **Running the test suite pushed
to origin.**

The `process.cwd()` choice stays and its reasoning is unchanged: letting a
state file pick the repository a `git push` runs against is a privileged
operation taking its target from data. What was missing is the other half —
when the state is a fixture, `process.cwd()` is precisely the wrong tree, so
the two facts are now compared instead of assumed to agree.

`originSlug` reads `config --get remote.origin.url`, not
`remote get-url origin`: the latter applies `url.<base>.insteadOf` rewrites,
which are a local transport alias and not a statement about which project
this is. A developer mirroring GitHub internally has not changed what they
are shipping, and reading the rewritten value would refuse their every push.

- [x] SC-1492: lib/verified-push.ts contains [ref-mismatch] — a push whose target ref is not the branch's own name is refused and the remote is not written. The refusal names the branch and the ref it would have written
- [x] SC-1493: test/verified-push-ref-mismatch.test.ts contains [origin/main] — the upstream inheritance is produced by a real `git checkout -b <name> origin/main` against a real remote and asserted as the premise, not hand-written into a config
- [x] SC-1494: lib/verified-push.ts contains [OUTCOMES_LEAVING_WORK_LOCAL] — every new outcome joins the local-work set in the same commit that adds it. A kind nobody listed would default to "fine"
- [x] SC-1495: lib/verified-push.ts contains [repo-mismatch] — a push is refused when the caller's expected repository is not the one the working tree's origin names. An unreadable origin refuses too
- [x] SC-1496: gates/orchestrator.ts contains [expectRepo] — the gate tells verifiedPush which repository it believes it is shipping, so a fixture issueRepo cannot push a real checkout
- [x] SC-1497: test/gate-push-repo-mismatch.test.ts contains [insteadOf] — the matching-repo control uses an origin that parses as a slug and resolves locally, so "the check allowed it" is distinguishable from "the check could not parse the URL"

### Two holes the background security review found in the first fix

Both were in the repo check, both are now tested, and neither was found by
me.

**The guard read a different value than the action used.** `originSlug`
read `config --get remote.origin.url` — the configured url — on the
reasoning that `url.<base>.insteadOf` rewrites are a local transport alias
and not a statement about which project you are shipping. The reasoning is
fine and the conclusion was wrong: `git push` resolves rewrites, so a
rewrite pointing `https://github.com/owner/name` at some other repository
would satisfy the check and then write that other repository. A guard that
approves one destination and permits a push to another is not a guard.
`originIdentity` now requires the configured and effective urls to be the
same parseable slug, and a rewrite in play is a refusal.

That property is also why the matching-repo control had to be split in two.
A fixture origin can PARSE (an https url, unreachable) or RESOLVE (a local
bare path, unparseable), never both — the first draft used `insteadOf` to
get both, which is precisely the rewrite now refused. The control was
demonstrating the hole.

**A blank expectation disabled the check.** The opt-in was
`expectRepo !== undefined && expectRepo.trim() !== ""`, so `""` skipped the
comparison and restored the unconditional push — malformed input disabling
the guard, the shape `.claude/rules/checks-must-be-able-to-fail.md` names
first. Asking the question is the caller's decision; once asked, an
unanswerable version of it is a refusal.

**A known limit, stated rather than papered over:** the host is not
compared. `issueRepo` is `owner/name` and carries no host, so
`https://example.invalid/owner/name` and `https://github.com/owner/name`
are the same slug here. Hardcoding `github.com` would bind the harness to
one forge for a check about repository identity. A test pins the limit so
it cannot be assumed away.

- [x] SC-1498: test/gate-push-repo-mismatch.test.ts contains [insteadOf] — a rewrite that redirects the push is refused rather than approved, a blank expectation refuses rather than skipping, and the host limit is asserted rather than described

### What was broken to prove it

The headline evidence is not a mutation but the order of work: both test
files were written and run **before** the fix, and
`verifiedPush does not move the remote's main` failed — the bare remote's
`main` really was rewritten from a feature branch. 6 of 13 red before the
fix, 0 after.

One defect was caught by a control rather than by a mutation, and it is worth
recording because the positive cases did not notice it. The first draft of
the repo check called `repoMatches(actual, expectRepo)` where `actual` is
already a slug; `repoMatches` parses its first argument as a URL, so every
comparison returned false. Every refusal test passed — for a reason that had
nothing to do with the repositories differing — and only
`a matching repo still pushes` went red. A refusal suite with no control is
indistinguishable from a function that refuses everything.

The two security findings were mutation-checked after the fact, over
`test/gate-push-repo-mismatch.test.ts` (18 tests):

| Mutation | Red |
|---|---|
| the push-url check dropped — the gate/action field mismatch, restored | 1 of 18 |
| `&& expectRepo.trim() !== ""` restored — a blank expectation skips the check | 1 of 18 |
| the repo check removed entirely | 4 of 18 |


## #431 — 149 worktrees, none removable, and the totals did not sum

`StaleTTLCleanup` reported `0 removed, 144 kept` at every session start.
`git worktree list` showed **149**, the oldest 13.7 days old. Measured: 72
with uncommitted changes, 71 clean but unmerged, 1 clean and merged, 4
detached, 1 whose directory was gone.

### Unmerged was the wrong question

The 71 were kept by `unmerged → keep`, which reads as prudence and asks
about the wrong thing. **`git worktree remove` deletes a checkout, not a
branch.** The ref survives, its commits survive, `git checkout` brings it
all back. What can be lost is work that exists in exactly one place:
uncommitted changes, and commits that never reached origin.

So the real property is "is every commit here also somewhere else" — and
the old code asked it SECOND, in `unpushedKeepReason`, after an arm that
returned first. The stronger check was dead code for every branch that
needed it. Asking it first both **protects more** (a branch merged into a
main that was never pushed was removable before) and **permits more** (a
fully-pushed fan-out branch is just a stale directory).

`merged` stays load-bearing in exactly one case: a repo with no `origin`,
where "somewhere else" has no meaning. Without that arm the change would
delete unmerged local-only work — `unpushedCommitCount` returns `0` for a
remote-less repo, so it would have looked exactly like a pushed branch.
`OriginState` makes the two distinguishable, which `number | null` could
not.

### A lock is a claim, and the sweeper could not see one

`git worktree lock` is git's own durable claim, and `worktree remove`
refuses a locked tree regardless. Reading it turns "something owns this"
into a KEPT with a reason rather than a failed removal in `errors`.

The first implementation compared git's reported path against a `join()`ed
one. git reports paths resolved; on macOS the temp directory is under a
`/var` → `/private/var` symlink, so the comparison never matched and the
check was **inert on the platform it was written on**. Both sides now go
through `realpathSync`.

### The totals now reconcile

Entries skipped for age `continue`d without being recorded, so
`removed + kept` did not equal the number of worktrees — 144 against 149,
and the gap was invisible because nothing was supposed to add up. There is
now a `skipped` bucket, all four are printed, and a test asserts the sum
equals the entries examined.

- [x] SC-1501: lib/worktree-cleanup.ts contains [removalKeepReason] — one decider answers merged and unpushed together so the weaker proxy cannot short-circuit the stronger property. A repo with no origin falls back to merged
- [x] SC-1502: lib/worktree-cleanup.ts contains [lockKeepReason] — a locked worktree is kept with its reason and an unreadable lock listing keeps everything. Paths are compared resolved on both sides
- [x] SC-1503: lib/worktree-cleanup.ts contains [skipped] — removed + kept + skipped + errors equals the number of entries examined, asserted by a test and printed in the summary

### What was broken to prove it

Measured over `test/worktree-cleanup-orphans.test.ts`,
`test/worktree-cleanup.test.ts` and `test/unit/worktree-cleanup-merge.test.ts`
(35 tests). None is left in the tree.

| Mutation | Red |
|---|---|
| the removal decider short-circuits to removable | 7 of 35 |
| the no-origin arm ignores `merged`, so local-only work is deleted | 5 of 35 |
| the lock check never keeps anything | 3 of 35 |
| the dirty-tree check removed | 2 of 35 |
| locks compared on raw paths again — inert on macOS | 2 of 35 |
| unpushed commits no longer keep the worktree | 1 of 35 |
| an unanswerable origin is treated as clean | 1 of 35 |
| an unreadable lock listing is treated as no locks | 1 of 35 |
| the cleanup stops consulting the lock decider | 1 of 35 |
| skipped entries vanish from the totals again | 1 of 35 |

Three of those were **zero** on the first battery, and all three were the
lock check. The tests drove `lockedWorktreePaths` directly and nothing drove
the branch in `cleanupWorktrees` that consumes it — so removing the check,
reverting the realpath comparison, and collapsing `null` into "no locks"
were all invisible. The fix is this file's own established pattern:
`lockKeepReason` is one exported binding, like `unpushedKeepReason` before
it, whose `null` arm no fixture can stage; and one end-to-end case runs the
real sweeper over a real locked worktree, because a decider being right is
not the same as the sweeper asking it. That last distinction is the tenth
row, measured separately.

## #397 — the pre-push hook could not pass, and named the wrong cause

The generated `.git/hooks/pre-push` compared `$TOPLEVEL/bun.lock` with
`$tmp/bun.lock`, where `$tmp` is a checkout of the commit being pushed. A
gitignored lockfile is not in a checkout. So the fast-path comparison could
never be taken in such a consumer, every push fell through to
`bun install --frozen-lockfile` with no lockfile to freeze against, and the
hook printed `ERROR: Conformity tests failed against the commits being
pushed` over a conformity suite sitting at 43 pass, 0 fail. Found on agentgrit
on 2026-10-14. For a consumer with a relative `file:`/`link:` dependency it
then failed a second, independent way, because a relative path does not
resolve from `/tmp`.

`.claude/rules/checks-must-be-able-to-fail.md` is about guards that cannot
fail. This is the inverse — a guard that cannot pass — and the damage has the
same shape, because the message is wrong in both directions. A developer told
"conformity failed" goes and reads a green suite, concludes the hook is
broken, and starts pushing with `--no-verify`. That is how a gate stops
existing without anyone deciding to remove it.

Two structural causes, and the second is the one worth keeping:

1. **The hook was a template literal in the middle of a 2,400-line
   generator.** Nothing could run it, so every test it had asserted its
   *source text*. Those tests were all green. A source-text assertion cannot
   notice that the script's behaviour is impossible. The script is now
   `lib/scaffold/pre-push-hook.ts` — one binding, one exported exit-code
   constant — and `test/pre-push-hook.test.ts` drives it against planted
   repositories, asserting only what the hook prints and exits, because that
   is all a developer ever sees.

2. **It had two outcomes where the facts have three.** "Conformity failed" and
   "conformity could not be run" shared one `status` variable and one message.
   They are now separate, and the discriminator is measured rather than
   assumed: a missing file, an unresolvable import and a red assertion all
   exit non-zero, so the hook reads bun's own summary — a counted `N error`
   line means the suite did not load, counted `N pass`/`N fail` with a
   non-zero exit means it ran and failed, and no counted tests at all means
   nothing was measured even when the exit code is 0.

UNMEASURED **blocks**, and that is a recorded decision rather than an accident
of control flow. A pre-push gate that waves a commit through when it could not
check is the fail-open this repo keeps finding —
`.claude/rules/config-access.md`: `0`, `{}`, `null` and `SKIP` are all
indistinguishable from success, and `UNMEASURED` is not. What makes blocking
tolerable is that the message says which of the two happened, names the cause,
and names `--no-verify` itself.

- [x] SC-1504: A consumer whose `bun.lock` is gitignored can push when its conformity tests pass, driven against a planted fixture repo rather than asserted from the hook's source text
- [x] SC-1505: A genuine conformity failure is still refused, with the conformity message, and a positive control proves the refusal is removable
- [x] SC-1506: A suite that could not run — missing file, unresolvable import, no tests declared, or dependencies that could not be installed — is reported as UNMEASURED and is distinguishable in the hook's output from a conformity FAIL
- [x] SC-1507: That UNMEASURED blocks the push is asserted, and the message names both the cause and the escape hatch
- [x] SC-1508: The properties #85 and #68 bought — checking the pushed commit rather than the working tree, skipping the all-zero deletion sha, and leaving no worktree behind on either outcome — are executed, not described
- [x] SC-1509: `createGitHooks` writes exactly `prePushHookScript()`, and the generator holds no second copy of the body

### What was broken to prove it

Run and counted over `test/pre-push-hook.test.ts`,
`test/unit/pre-push-pushed-sha.test.ts` and
`test/unit/generated-shell-syntax.test.ts` (29 tests). None is left in the
tree; all were run and reverted.

| Mutation | Red |
|---|---|
| the refusal constant zeroed | 9 of 29 |
| the counted-tests arm always true — a missing suite reads as a red one | 5 of 29 |
| UNMEASURED collapsed into the conformity message | 5 of 29 |
| the absent-lockfile arm made unreachable (the #397 bug, restored) | 3 of 29 |
| the error-count arm removed — an unloadable suite reads as a red one | 2 of 29 |
| a refusal inlined around the constant | 2 of 29 |
| the install failure no longer counts as unmeasured | 2 of 29 |
| the worktree cleanup moved behind the refusal | 2 of 29 |
| the generator keeps its own copy of the body | 2 of 29 |
| the zero-sha guard dropped | 1 of 29 |

Two rows were **zero** on the first battery, and both were the test's fault
rather than the hook's.

**The refusal constant scored 0.** Every behavioural assertion read
`expect(code).toBe(PRE_PUSH_REFUSE_EXIT)`, so setting the constant to `0`
zeroed the script's refusal and the expected value in the same edit and
nothing moved. A test parameterised by the thing it is checking cannot check
it — the vacuous-assertion shape from
`.claude/rules/checks-must-be-able-to-fail.md`, reached by a route that looks
like good hygiene. The behaviour is now pinned to the literal `1` and the
constant is asserted once, separately; the same mutation now scores 9.

**Emptying the install-failure reason scored 0,** because the test asserted
the bucket (`did NOT run the conformity suite`) and not the cause. Being told
a push was not measured, without being told that the install is why, is most
of the original bug again. The reason string is now asserted.

Two further rows printed `NOT APPLIED` and were not real refusals: the battery
counted anchors with `grep -c`, which counts matching *lines*, so a multi-line
anchor occurring once was reported as 32 and as 3. A mutation harness that
mis-reports its own reach is exactly the decorative check this rule is about,
and it is recorded here because the fix — count occurrences, not lines — is
not obvious from output that reads like a moved anchor.

## #398 — audit reported 0 changes on a tree `--fix` rewrote in 28 places

`rungate scaffold <path>` without `--fix` printed
`Mode: audit (pass --fix to apply changes)` and
`Total: 0 created, 0 replaced, 0 skipped, 0 refused`, and then `--fix` on the
same tree wrote 28 paths — 16 on agentgrit, where it was found. It was not a
conservative preview. It was a report with nothing in it.

The cause was structural rather than a missing branch. **Audit was four
`existsSync` checks and fix was twenty-five write steps: two bodies of code
sharing nothing.** Two implementations of the same question can only agree by
someone keeping them in step by hand, and nobody was — three of the four
audit branches turned out to be unreachable as well as wrong, because their
only callers had always passed fix mode.

`--fix` is the DESTRUCTIVE mode. #370 is `--fix` truncating
`.claude/rules/checks-must-be-able-to-fail.md` from 262 lines to 65 — the
rule three specs cite by path. Audit is the one thing between a consumer and
that, and it reported clean no matter what was about to happen. **A preview
that under-reports is worse than no preview, because it converts "I checked
first" into false confidence.**

### So audit does not predict what fix would do. It does it, somewhere else.

Clone the tree, run the REAL steps against the clone, report what they say,
throw the clone away. The modes then agree by construction rather than by
maintenance, and a step added later cannot forget its audit branch because
there is no audit branch to forget. On APFS `cp -Rc` is a copy-on-write
clone, measured at 0.2s for this repo, so the cost is bounded by metadata
rather than by tree size.

Two steps are not rehearsed, and both are named in `STEPS_NOT_REHEARSED` with
the reason attached, because an exclusion without a stated reason is
indistinguishable from an oversight: `deployHooksToConsumers` writes to
absolute paths in OTHER repositories, and `postScaffoldCommit` creates a
commit in a clone whose `.git` may point back at the real one.

**The reported verb changed, deliberately.** Audit used to say
`GAP: CODE-MAP.md missing — run with --fix to generate`; it now says
`UPDATED: CODE-MAP.md`, because that is what the step did. The GAP vocabulary
cannot sit on top of rehearsal — a translation from write verbs back to GAP
is a second vocabulary maintained by hand beside the first, which is the
shape this issue removes, and `writtenPath()`'s negative control requires
that GAP name no path, so an audit emitting GAP could never be compared
against what `--fix` wrote. The "run with --fix" half is printed once per run
by `rehearsalNotice()` instead of once per file.

- [x] SC-1510: Every path `--fix` writes is named by audit, and every path audit names is one `--fix` writes — compared between audit's report and a content-hash filesystem snapshot, not between the two reports
- [x] SC-1511: The fixture drifts as well as lacks, so a mode reporting only creations cannot pass
- [x] SC-1512: One exported binding decides what counts as a written path, and every write verb the scaffold emits is read from the sources rather than listed in the test
- [x] SC-1513: A symlink whose target resolves outside the CLONE refuses the rehearsal, with the reproduction that writing through one reaches the original, and a relative-link positive control
- [x] SC-1514: An incomplete copy refuses rather than previewing less, measured through the same `missingTopLevel` the production path calls
- [x] SC-1515: Cleanup removes the mkdtemp it created and nothing above it, with the parent recorded at creation rather than derived by walking up
- [x] SC-1516: Pruning an excluded path never deletes through a symlinked ancestor, and never removes an ancestor that is not itself excluded
- [x] SC-1517: A symlink that cannot be resolved — dangling, or in a directory that cannot be read — counts as escaping, with a dangling-inside-the-tree positive control
- [x] SC-1518: A rehearsal that cannot be set up refuses the run, exiting non-zero and writing nothing, rather than falling back to the previous guesswork
- [x] SC-1519: The two steps a rehearsal must not run do not run, with a `--fix` positive control proving the fixture configures them

### What was broken to prove it

Run and counted over `test/scaffold-rehearsal-safety.test.ts`,
`test/scaffold-audit-agreement.test.ts` and
`test/unit/scaffold-project.test.ts` (73 tests). None is left in the tree; all
were run and reverted.

| Mutation | Red |
|---|---|
| `escapingSymlinks` short-circuited to `return []` | 7 |
| `writtenPath` returns the whole line instead of the path | 7 |
| the escaping-symlink refusal dropped | 5 |
| the #398 bug restored — audit runs no write steps at all | 5 |
| pruning follows a symlinked ancestor again (plain recursive `rmSync`) | 1 |
| pruning unlinks an ancestor link instead of leaving it | 1 |
| a dangling link reads as inside (a `realpathSync` throw treated as safe) | 1 |
| an unreadable directory skipped instead of reported | 1 |
| `missingTopLevel` forgives any top-level name appearing in an exclude | 1 |
| `discardRehearsal` removes the clone but leaks the mkdtemp (#437) | 1 |
| audit rehearses `deployHooksToConsumers` | 1 |
| `WRITE_VERBS` loses the three verbs this issue found missing | 1 |
| audit falls back to `--fix` on the real tree when the clone refuses | 1 |
| the completeness check at its call site dropped | **0 — see below** |
| `attemptCopy` stops clearing the destination first | **0 — see below** |

**Five rows were zero on the first battery.** Four were the tests' fault and
are now closed; the counts above are after the repair.

- **The symlinked-`.claude` case asserted `toThrow(/audit did NOT run/)`,**
  which both readings satisfy — unlinking `.claude` also refuses, via the
  completeness check. The assertion could not tell "the escape was caught"
  from "pruning destroyed the tree", so it is now pinned to the refusal's
  own text.
- **SC-1514 re-implemented the completeness comparison inside the test,**
  `readdirSync(tree)` against `readdirSync(clone)` by hand. It asserted that
  two `readdirSync` calls disagree, which they did, while the production
  comparison went entirely unexercised. The comparison is now exported as
  `missingTopLevel` and the test drives that.
- **Nothing ran the CLI against a tree whose clone refuses,** so the one
  branch standing between a refused preview and `--fix` on the consumer's
  real repository was untested. Replacing `process.exit(1)` with a fall-back
  to the write steps scored 0. SC-1518 is that case.
- **`STEPS_NOT_REHEARSED` naming a step is not evidence the guard fires.**
  Removing `if (!rehearsing)` scored 0 until SC-1519 existed. A decider being
  right is not the same as the caller asking it — the same distinction #395
  measured as its tenth row.

**The two remaining zeros are recorded rather than closed, and the reason is
the same for both: their call sites are unreachable from a working `cp`.**

- The completeness check only fires when `cp` exits 0 having copied less than
  the tree. Nothing in the suite can produce that, so what is proved is the
  comparison (`missingTopLevel`, 1 red) and not its wiring. It is kept as
  defence-in-depth against a silently-truncating copy, and the gap is named
  here rather than hidden behind a passing row.
- `attemptCopy`'s unconditional clear is unobservable because the destination
  is always a fresh `mkdtemp`. It became unconditional precisely for that
  reason: the first draft cleared only in the `cp -Rc` fallback, and since
  `cp -Rc` succeeds on every machine the tests run on, no test could ever
  reach the second branch. **The ordering was removed rather than tested** —
  one shared helper, no sequence to get wrong — which is the better answer
  when a guard cannot be exercised, but it does leave a line whose removal
  nothing catches.

`UNMEASURED is not SKIP` applies to a mutation battery as much as to a config
read: a row quietly dropped from the table because it scored 0 is a table
that cannot report its own reach.

## #436 — a checkout git has no registration for, reported as an error forever

The #431 sweep worked: 41 worktrees removed, 737 MB reclaimed. It left one
entry it could never act on.

```
Failed to check git status for wf_db8e9fce-bed-15: fatal: not a git repository:
  /Users/jhorn/Projects/rungate/.git/worktrees/wf_db8e9fce-bed-15
```

`.claude/worktrees/wf_db8e9fce-bed-15` is a 6.2 MB checkout whose `.git` file
reads `gitdir: …/.git/worktrees/wf_db8e9fce-bed-15`, and that admin directory
does not exist. `git worktree prune` removed the registration and left the
files behind, so git does not know it is a worktree and `git worktree remove`
cannot touch it.

Pushing it to `errors` was the correct conservative behaviour **and** it was
permanent. The same line on every SessionStart, which nothing can resolve, is
indistinguishable from a log line.

### The test is the gitdir, not the status failure

A linked worktree's `.git` is a file naming an admin directory. When that
directory is gone, every git command run inside the checkout fails with "not
a git repository", and nothing else produces that state. Classifying on the
*failure* instead would swallow every other reason git might refuse — so
`orphanedGitdir` asks the narrow question and three things are deliberately
not orphans: no `.git` at all (never a worktree), a `.git` **directory** (a
whole repository someone put there), and a gitdir that exists.

The first two are decided by **one** binding, and that was not the first
draft. The draft asked the same question three times — a `statSync` whose
catch meant "no `.git`", an `isFile()` meaning "a real repository", and the
`readFileSync` that follows them. Deleting `isFile()` measured **0 of 47**
red, because a `.git` directory makes the read throw `EISDIR` and a missing
one makes it throw `ENOENT`, so the read already returned null for both. Two
of the three deciders could be deleted and no test could tell which. That is
the fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`, and it was
found the only way it can be: by predicting the count before running and
noticing a row come back lower than predicted. Both `SC-1598` cases now land
on the surviving binding — 3 red where there had been 0.

### Removal is off by default, and that is the decision

This function's governing asymmetry, already written into its merge check, is
that treating "not merged" as unsafe costs disk while treating "merged" as
safe can delete work. An orphan is the case where the question **cannot be
asked**: the admin directory is gone, so `git status` cannot run, and nothing
can establish whether the checkout holds work that exists nowhere else.

Removing it automatically would be a recursive delete of content the function
has explicitly failed to classify, run unprompted at SessionStart. So the
automatic pass reports and `hooks/StaleTTLCleanup.hook.ts` does not opt in;
an operator who has looked passes `removeOrphans: true`.

When it does remove, the path is the one the function built from
`join(worktreesDir, entry)` — **never** the gitdir read out of the `.git`
file. That is content, and content must not steer a recursive delete.

- [x] SC-1597: test/worktree-cleanup-orphan-gitdir.test.ts contains [a checkout git has no registration for is ORPHANED] — driven against a planted fixture, and the missing gitdir is named so a reader knows what went missing
- [x] SC-1598: test/worktree-cleanup-orphan-gitdir.test.ts contains [a directory with no .git at all is NOT an orphan] — and nor is a `.git` directory: the predicate gates a recursive delete, so it must be narrow
- [x] SC-1599: test/worktree-cleanup-orphan-gitdir.test.ts contains [a gitdir that EXISTS is not an orphan, however broken git is] — the positive control, plus a `.git` file in a shape git does not write, which is not guessed at
- [x] SC-1600: test/worktree-cleanup-orphan-gitdir.test.ts contains [an orphan lands in its own bucket and NOT in errors] — the defect stated as an assertion
- [x] SC-1601: test/worktree-cleanup-orphan-gitdir.test.ts contains [reporting is the default — the checkout is still there] — the recorded decision, asserted rather than left in a docblock
- [x] SC-1602: test/worktree-cleanup-orphan-gitdir.test.ts contains [removal reaches only what is under the worktrees directory] — a `.git` naming somewhere else entirely leaves that somewhere untouched, with a bystander file asserted intact
- [x] SC-1603: test/worktree-cleanup-orphan-gitdir.test.ts contains [the buckets still sum, with five of them] — #431's property re-asserted, because a new bucket left out of the total is that defect again

### What was broken to prove it (SC-1597..1603)

Run over `test/worktree-cleanup-orphan-gitdir.test.ts`,
`test/worktree-cleanup.test.ts`, `test/worktree-cleanup-orphans.test.ts` and
`test/unit/worktree-cleanup-merge.test.ts` — 47 tests, baseline 0 fail. Every
count was predicted before the battery ran; the two rows where the prediction
missed are called out, because a row lower than predicted is a finding and a
row higher is a reasoning error worth recording.

| Mutation | Red |
|---|---|
| `orphanedGitdir` returns null always — #436's defect verbatim | 6 of 47 — predicted 5; the relative-gitdir case asserts both halves and I had only counted one |
| it returns the resolved gitdir always, so everything is an orphan | 9 of 47 — reaches #68's and SC-1503's fixtures too, which is what a shared classifier means |
| the read's catch returns the path instead of refusing | 3 of 47 — **predicted 9.** The over-prediction was mine: #68's and SC-1503's fixtures carry readable `.git` files, so they never reach the catch |
| the read's catch removed entirely, so it throws out of the function | 3 of 47 — the same three; refusing and exploding are not distinguishable to a caller that only reads buckets, so both SC-1598 cases assert the bucket |
| ~~the `isFile()` check dropped~~ | **0 of 47 — the finding.** Three deciders agreeing; collapsed to one, and the two rows above are that one being mutated |
| the existence test inverted (`existsSync ? resolved : null`) | 14 of 47 — every live worktree in every fixture becomes an orphan |
| a relative gitdir left unresolved against the checkout | 1 of 47 |
| `removeOrphans` ignored and orphans always removed | 1 of 47 — SC-1601, the recorded decision, is the only thing standing between an unclassifiable checkout and an unprompted recursive delete |
| `removeOrphans` ignored and orphans never removed | 2 of 47 |
| the delete follows the gitdir read out of the `.git` file | 2 of 47 — the orphan survives and the bystander directory does too, which is SC-1602 from both sides |
| an orphan pushed to `errors` instead of `orphaned` | 2 of 47 — the defect reintroduced, caught by the bucket and by the sum |
| the summary line drops the orphan count | 1 of 47 |

None is left in the tree; all were run and reverted, and the collapse that
row five prompted is in `lib/worktree-cleanup.ts`.

## Test scratch directories are created in a hook, and swept when they are not (#437)

Jason found 34 hidden directories in the repo root. `.tree-under-test-scratch-*`
accounted for 23 of them. All but one were **0 bytes** — gitignored, so nothing
was ever at risk of being committed; this is litter, not corruption.

Five suites built their fixtures with `mkdtempSync(join(REPO_ROOT, "<prefix>"))`
at **module scope**. Every one of them also had correct `afterAll` cleanup, and
that is the point rather than an irony: the directory appears when bun *imports*
the file, which is before any lifecycle hook can run and before any hook is
guaranteed to run at all. A suite interrupted, killed, or throwing during
collection leaves one behind, empty. 0 bytes is the fingerprint. This repo kills
suites often — the DIR-L29 guard, Ctrl-C, one jetsam kill — so the leak rate was
not theoretical.

The directories are deliberately inside the repo root rather than `/tmp`:
`tree-under-test` scans the repo tree and `sc-drift` needs repo-relative paths.
Relocating them was never available as a fix.

### One parse, two readings

`lib/scratch-roots.ts` owns the question "what does a scratch root look like",
and two callers ask it differently:

| Caller | Asks | Because |
|---|---|---|
| `test/scratch-paths-unique.test.ts` | which roots are at a FIXED path | a fixed path under the shared checkout is a shared mutable resource (#323 SC-6) |
| `lib/scratch-cleanup.ts` | which PREFIXES the unique roots use | a sweeper needs to know what it may delete |

Two copies of that parse would be two deciders that agree — see
`.claude/rules/checks-must-be-able-to-fail.md` — and worse than usual here,
because the second one's output is a **deletion allowlist**. A copy that
quietly stopped seeing a prefix would not go red; it would stop sweeping, and
a sweeper that sweeps nothing is indistinguishable from nothing having leaked.

The prefix list is **derived, never written down**. A hand-maintained list is a
second place to forget, and forgetting there means a new suite's leak
accumulates silently — which is this defect again, one level up.

`test/scratch-paths-unique.test.ts` is excluded from the derivation, and that
exclusion is itself asserted. It carries `mkdtempSync(join(ROOT, ".x-"))` as a
string LITERAL, because that is the only way to prove its detector still fires.
Deriving from it would put a test fixture into a deletion allowlist — the
self-reference trap with a recursive delete on the end of it.

### What the sweeper will not touch

Every path removed is one the sweeper built from `join(repoRoot, entry)` where
`entry` came from reading that same directory. No absolute path from any other
source can reach the `rmSync` — #436 established that content must never steer
a recursive delete, and a prefix list is content.

An entry must start with a derived prefix **and carry a suffix after it**. A
bare prefix with nothing appended is refused: that is a directory someone made
deliberately with the same name, and the sweeper cannot tell the difference, so
it declines.

Age is the other guard, and it is not belt-and-braces. This runs at
SessionStart while another session may be three minutes into a suite whose
scratch directory is live. The directory is anonymous and holds no lock, so the
suite that created it cannot defend it — age is the only signal available, the
threshold is one hour, and the direction to be wrong in is leaving litter.

### Success Criteria

- [x] SC-1604: test/scratch-cleanup.test.ts contains [the prefix list is derived from the suites, never listed] — a prefix a suite plants is found and one nobody plants is not
- [x] SC-1605: test/scratch-cleanup.test.ts contains [the real tree's prefixes are all found, and the fixture file's are not] — a derived list can come back empty, and an empty deletion allowlist sweeps nothing, which looks exactly like nothing having leaked
- [x] SC-1606: test/scratch-cleanup.test.ts contains [the two readings of a scratch root come from one parse] — including the assignment form, which #437's own fix introduced
- [x] SC-1607: test/scratch-cleanup.test.ts contains [a leaked directory goes and an unrelated one stays] — driven against planted fixtures in a throwaway root
- [x] SC-1608: test/scratch-cleanup.test.ts contains [a prefix is a deletion allowlist and is refused as one] — five near misses, plus the empty-allowlist case which must sweep nothing
- [x] SC-1609: test/scratch-cleanup.test.ts contains [a scratch directory young enough to be in use is kept] — with the file case and the dry run alongside it
- [x] SC-1610: test/scratch-cleanup.test.ts contains [no suite in test/ creates a filesystem path at module scope] — asserted on the source AND by importing the five repaired suites for real
- [x] SC-1611: test/scratch-cleanup.test.ts contains [the sweep runs where worktree cleanup already runs] — a cleaner nobody invokes is a function, not a cleaner
- [x] SC-1612: test/scratch-cleanup.test.ts contains [a short derived prefix cannot reach .claude or .github] — BUG-437-A: the allowlist is derived from file content, so the entry must match the full name mkdtempSync writes, not merely start with a prefix

### What was broken to prove it (SC-1604..1611)

Run over `test/scratch-cleanup.test.ts` and `test/scratch-paths-unique.test.ts`
— 24 tests, baseline 0 fail. Every count predicted before the battery ran.

| Mutation | Red |
|---|---|
| `scratchPrefixes` derives nothing, so the allowlist is always empty | 5 of 24 — the fail-safe direction, and the reason SC-1605 measures the real tree: an empty allowlist sweeps nothing, which reads as nothing having leaked |
| `isScratchEntry` accepts everything | 6 of 24 |
| BUG-437-A verbatim — back to "starts with a prefix and is longer" | 3 of 24 |
| the opening anchor dropped, so a prefix becomes a substring | 1 of 24 — measured standalone twice; inside the batched runner this row reported a truncated `1 of 7`, so the number here is the standalone one |
| the closing anchor dropped, so anything may follow the suffix | 2 of 24 |
| the suffix relaxed from exactly six characters to one-or-more | 3 of 24 |
| the prefix no longer escaped before it reaches a `RegExp` | 1 of 24 — an unescaped `.` is "any character" |
| the age guard removed | 1 of 24 — a scratch directory 30 seconds old is swept out from under a live suite |
| the age comparison inverted, so only live scratch is swept | 3 of 24 |
| `dryRun` ignored, so a report deletes | 1 of 24 |
| the fixture file no longer excluded from the derivation | 1 of 24 — `.x-`, a literal written to prove a detector fires, enters a deletion allowlist |
| the parse back to `const`-only, blind to the assignment form | 2 of 24 — #437's own fix writes `let S = ""` plus a later assignment, so this is the hole the fix would have opened |
| `moduleScopeCreations` finds nothing | 1 of 24 |
| `sc-drift.test.ts` creates its scratch at module scope again — the defect verbatim | 2 of 24 — the source position AND the executed import |
| the SessionStart hook stops calling the sweeper | 1 of 24 |
| the hook's scope gate removed | 1 of 24 |
| the module-scope detector stops stripping comments | 1 of 24 — it then reports this file's own docblock, the self-reference trap again |

None of the seventeen is left in the tree; all were run and reverted.

### BUG-437-A — the allowlist was the hole, not the paths

Security review of the first push said the delete was content-steered. It was
right, and running it confirmed the exact case: `isScratchEntry(".claude",
[".c"])` returned **true**. The prefix list is derived from `test/*.ts`, so a
future suite writing `mkdtempSync(join(REPO_ROOT, ".c"))` — a plausible typo,
never mind anything hostile — would have armed a SessionStart hook to delete
`.claude/` recursively.

The paths were never the hole; the sweeper builds those itself. The
**allowlist** was, and an allowlist derived from file content steers a
recursive delete just as surely as a path would. The predicate now matches the
full name `mkdtempSync` writes — a prefix followed by exactly six characters
from `[A-Za-z0-9]`, measured over 200 calls rather than read off the
documentation.

### Three gaps the predictions found

Each is a row that came back lower than predicted, and each was a case the
tests did not contain rather than a defect in the code:

1. The near-miss list had the prefix *minus its trailing separator* where the
   case that matters is the prefix *exactly* — so `entry.length > p.length` was
   guarded only by a unit test.
2. The list had near misses of the PREFIX and none of the SUFFIX, so relaxing
   "exactly six characters" to "one or more" went half-unnoticed.
3. `startsWith(p)` beside a slice at `p.length` measured **0 of 24** when
   relaxed to `includes` — two deciders that agree, provably identical on every
   input, with the delete still on the end of them. Collapsed into one anchored
   match. The anchors are now separately mutable and separately caught.

## contextDocs reports what it did with every entry (#439)

Reported from a consumer project's session as "a dead config key". It is
not dead — `gates/brief-assembler.ts` consumes it — and what was wrong is
worse than inert, because the key looked like it worked. Three defects stacked
in one twenty-line region, and a fourth surfaced while fixing them.

| # | Defect | The rule it broke |
|---|---|---|
| 1 | every entry starting with `/` or containing `..` was filtered out silently | *Silent Default Substitution* — an empty list and a list whose entries were all refused were the same value |
| 2 | the config was read straight from `.claude/rungate.json` | *Never read only the monolith* — a project on the directory layout got nothing regardless of the filter |
| 3 | `catch { return null }` around the read | *Never `catch {}` around a config read* — a trailing comma became "no docs" |
| 4 | the schema declared `contextDocs` as an OBJECT while the consumer and its own tests used the array form | invisible until (2) was fixed, because the consumer parsed the file itself and never reached the validator |

### The decision about paths outside the project root

They are **allowed, and the brief says so.**

The old filter's instinct was right — an unvalidated path from config into an
agent brief is worth thinking about — but the thing it was protecting is not
what it looked like. A brief NAMES files; it does not read them. The config is
written by the operator whose session the agent runs in, so a path they
declared is not an escalation: they could have put the file in the repo, or
pointed the agent at it in a sentence.

What is worth protecting is a reader's ability to SEE that a brief reaches
outside the repository. So an external doc is included and labelled `external
to this project`, a missing one is included and labelled rather than dropped,
and an unusable one is named with its reason. Nothing declared disappears
without a line saying what happened to it.

The inside/outside test is `relative()`, not `startsWith()`:
`/x/project-backup` starts with `/x/project` and is a different directory, so
a prefix comparison would label it internal — wrong in the dangerous
direction.

### One decider, and why the schema stops short of the entries

`contextDocs` entries are typed `unknown` in `lib/rungate-schema.ts`, which is
the only place in that schema where that is true. `lib/context-docs.ts` is the
single decider for what a declared doc becomes, and it reports per entry:
`docs/x.md: not a string` names the offender, where a schema throw would
refuse the whole brief and name only the key.

Validating entries in the schema as well would be a second decider agreeing
with the first — and the first would then be **unreachable in production**,
its "not a string" arm unable to fire, with no test able to tell. That is the
fourth shape in `.claude/rules/checks-must-be-able-to-fail.md`, caught before
it shipped because the strict schema threw on a fixture the classifier was
written to report on.

### Success Criteria

- [x] SC-1613: test/context-docs.test.ts contains [contextDocs is read through the one loader] — a project on the DIRECTORY layout gets its docs, with the fixture asserting no monolith exists
- [x] SC-1614: test/context-docs.test.ts contains [malformed config throws; absent config does not] — asserted as two cases, because the point is that they stop being one outcome
- [x] SC-1615: test/context-docs.test.ts contains [a rejected entry is reported, not dropped] — naming the path and the reason, and the two briefs compared directly
- [x] SC-1616: test/context-docs.test.ts contains [a path outside the project root is a recorded decision] — included and labelled, with the prefix-versus-relative boundary asserted
- [x] SC-1617: test/context-docs.test.ts contains [each arm of the classifier, with a positive control] — every arm plus a valid relative path that still reaches the brief
- [x] SC-1618: test/context-docs.test.ts contains [a declared doc that is not on disk is INCLUDED and labelled] — the built-ins above it already say "(if exists)"
- [x] SC-1619: test/context-docs.test.ts contains [both authored shapes survive the schema] — the array form and the object form
- [x] SC-1620: test/context-docs.test.ts contains [a traversing path reaches the brief, labelled external] — the `..` case the old filter dropped
- [x] SC-1621: test/context-docs.test.ts contains [a declared path cannot write lines of its own into the brief] — BUG-439-A, and the same predicate guards the AC contextFiles that had no filtering at all

### What was broken to prove it (SC-1613..1620)

Run over `test/context-docs.test.ts`, `gates/brief-assembler.test.ts` and
`test/config-access-conformity.test.ts` — 57 tests, baseline 0 fail. Every
count predicted before the battery ran.

| Mutation | Red |
|---|---|
| the not-a-string arm removed | 3 of 57 |
| the empty arm removed | 2 of 57 |
| `external` hardcoded false | 3 of 57 |
| `relative()` replaced by a prefix comparison | 1 of 57 — `/x/project-backup` would read as internal |
| `missing` hardcoded false | 1 of 57 |
| `contextDocNotes` returns nothing | 5 of 57 |
| `contextDocNotes` reports when there is nothing to report | 4 of 57 — **was 1.** See below |
| `contextDocLines` drops external docs — the old filter, from the other side | 2 of 57 |
| the assembler reads the monolith directly again — defect (2) verbatim | 10 of 57 — including the CONFIG-1 ratchet, which refuses a file that has no entry; measured standalone at 1 |
| the loader call wrapped in a `catch` — defect (3) verbatim | 1 of 57 |
| the schema back to object-only — defect (4) verbatim | 10 of 57 |
| the schema validates entries too | 2 of 57 — a second decider for what a doc may be, which would make the classifier's own arm unreachable |
| a non-list `contextDocs` falls through instead of being named | 1 of 57 |
| BUG-439-A: `hasBriefUnsafeChars` accepts everything | 3 of 57 |
| the unsafe class narrowed to a bare newline | 1 of 57 — `\r`, `NUL`, `ESC` and `U+2028` are all line terminators or display controls that `\n`-shaped thinking misses |
| `buildFilesSection` stops guarding the AC `contextFiles` | 1 of 57 |

None of the sixteen is left in the tree; all were run and reverted.

### BUG-439-A — a path can write lines of its own into a brief

Security review of the first push raised two things about this change.

The first was that removing the `/` and `..` filter is a control regression.
It is a control removal, and it is the decision recorded above — but the
premise that it was a path control does not survive checking: the AC
`contextFiles`, rendered twenty lines further down the same file, were
**never filtered at all**. Absolute, traversing, anything. The old
`contextDocs` filter covered one of two doors into the same document.

The second was real and is fixed here. A brief is an agent instruction and a
path is rendered into it inline, so an entry containing a newline writes
whatever follows as its own line — in a document whose whole purpose is to be
obeyed. The old filter did not stop this either: a relative path with no
leading `/` and no `..` passes it and can still contain `\n`. This is not a
control #439 removed; it is one neither version had.

`hasBriefUnsafeChars` is the one predicate, and it guards BOTH doors.
`U+2028` and `U+2029` are in its class because they are line terminators that
`\n`-shaped thinking misses.

The assertion is per LINE, not per substring. The report quotes the offender
— it has to, to be actionable — and a JSON-escaped `\n` on one blockquote
line is not a heading. What must never happen is a line of the brief
*starting* with text the config supplied.

**The row that came back low.** `contextDocNotes` opened with
`if (verdicts.length === 0) return []`, and that was a second decider
agreeing with the guard below it: an empty list has no rejected, missing or
external entries either, so both returned `[]` on exactly the same inputs.
Mutating the guard below measured **1 against a predicted 4** because the
early return was quietly holding three cases up. Collapsed to one; the row is
now 4.

## #440 — the constraint extractor read four flat directories

`collectScanTargets` was four `readdirSync` loops and no recursion: `*.md`,
`docs/*.md` (skipping `archive`), `docs/adr/*.md`, `specs/*.md`. The list was
written once and never revisited.

Measured on a consumer project: 84 files scanned, **28 missed**, and every one
of the 28 sat in a directory that project's own
`.claude/rules/docs-routing.md` names as a documentation location —
`docs/specs/` (17), `reference/` (5), `docs/designs/` (3), `docs/agents/` (3).

`docs/specs/` is the headline. Specs are the densest source of hard
constraints in a repo, and the extractor read `specs/` (2 files) while
skipping `docs/specs/` (17). Same word, different directory, silently dropped.

Why the existing tests did not catch it: the one scope test was "scans
arbitrary root-level .md files beyond hardcoded list" — root-level BREADTH
only. Nothing asserted that any subdirectory was reached. A detector narrower
than what it detects, with a test narrower still.

`lib/doc-scan-targets.ts` owns the decision now and derives it from the
project's own routing table, so the scan tracks each project's layout instead
of a list someone has to remember to update. Scaffold already writes that
file, so every scaffolded project has one.

### Three decisions, recorded

**The routing table ADDS to the default set; it does not replace it.** This
repo's own table names `docs/adr/` and `docs/research/` but not `docs/`, so a
routing-only scan would have dropped every top-level `docs/*.md` the old flat
code read — fixing a 28-file miss by causing a different one. The defaults are
a floor. `source` reports whether routing contributed anything, which is a
different question from whether the file exists: a table naming nothing leaves
the defaults doing all the work, and reporting `routing` there would claim a
derivation that did not happen.

**Only the READ table is a documentation table.** `docs-routing.md` has two,
and the second — "Where to Create Things" — names `src/` and `test/`. Reading
both pulled 36 files out of `test/fixtures/`, a scaffolded fixture project
whose documents are props; extracting constraints from them attributes a
synthetic project's rules to the real one, which is the same error as
descending into a worktree. The cut is by heading rather than by column
position, because a parser tied to a column layout reads half a table when the
layout changes, and a heading is what actually separates the two meanings.

**A routed directory that is not on disk is UNMEASURED, not skipped.** The
routing table is a claim the project made about itself, and a claim that does
not hold is a finding. A *default* directory a project simply lacks never made
that claim and is not reported — otherwise the signal means nothing.

Measured on this repo after the change: 31 files before, 92 after, **0 lost**,
0 from `test/fixtures/`.

### BUG-440-A — a symlink was a way out of the project

Found by security review of the first implementation, and it is part of the
fix rather than something the fix found: the old scan was flat, so
`docs/elsewhere -> /somewhere` was never descended into. Recursion is what
made it reachable. `extract-constraints` turns every `.md` sentence it reaches
into a candidate constraint written to `AGENTS.md`, so one symlink in a cloned
repo would copy markdown from anywhere the process can read into this
project's rules.

The lexical guards — `startsWith("/")`, `includes("..")` — cannot see a
symlink. Every candidate path now resolves through `realpathSync` and must be
contained in the resolved project root.

Containment, not a symlink ban: a link within the repo is ordinary, and
refusing it outright would be a narrower detector than the thing being
detected. What containment alone does not fix is that an internal link makes
one file reachable under two names, which reads as two independent sources
agreeing — so the de-duplication set is keyed on the RESOLVED path, which
makes it stop symlink loops and alias double-reads with one binding. Reported
paths are re-anchored on the caller's spelling of the root, so the output is
the canonical name regardless of which name `readdirSync` returned first.

Refusals are recorded in `plan.refused` rather than dropped, for the reason
`unmeasured` exists: a symlinked documentation root that silently contributes
nothing is indistinguishable from one that was read and happened to be empty.

- [x] SC-1622: test/doc-scan-targets.test.ts contains [scan targets come from the project's routing table] — a directory named by no hardcoded list is reached, the routing table adds to the defaults rather than replacing them, and only the READ table is treated as a documentation table
- [x] SC-1623: test/doc-scan-targets.test.ts contains [recursion reaches a nested directory nobody named] — `docs/specs/`, `reference/`, `docs/designs/` and `docs/agents/` are each reached, and a directory nobody named is reached beneath one that was
- [x] SC-1624: test/doc-scan-targets.test.ts contains [the exclusions are one list, and each is proved] — a file is planted under every name in `SCAN_EXCLUDE_DIRS` and none is scanned, and recursion is bounded above as well as below
- [x] SC-1625: test/doc-scan-targets.test.ts contains [a project with no routing table is told so] — the fallback is exactly the old hardcoded set and the result names it rather than leaving the reader to assume
- [x] SC-1626: test/doc-scan-targets.test.ts contains [a routed directory that does not exist is UNMEASURED] — drift between the table and the tree is a finding, and a default directory a project simply lacks is not
- [x] SC-1627: test/doc-scan-targets.test.ts contains [the extractor carries the plan, so a count is interpretable] — a candidate count is uninterpretable without what was scanned and what could not be
- [x] SC-1628: test/doc-scan-targets.test.ts contains [the same file reached by two routed roots is read once] — counted twice it reads as two independent sources agreeing
- [x] SC-1629: test/doc-scan-targets.test.ts contains [the old flat behaviour cannot come back unnoticed] — the regression stated as the exact file list a four-directory flat scan would return
- [x] SC-1630: test/doc-scan-targets.test.ts contains [a symlink is not a way out of the project] — BUG-440-A — a symlinked directory, a symlinked file, and a symlinked routed root are each refused and named
- [x] SC-1631: test/doc-scan-targets.test.ts contains [a symlink loop terminates] — de-duplication keyed on the resolved path, so a loop ends and a file reachable under two names is collected once

- [x] SC-1632: test/doc-scan-targets.test.ts contains [an excluded name is excluded as a ROOT, not only as an entry] — the exclusion list covers the directories a routing table declares, not only the entries found while walking them
- [x] SC-1633: test/doc-scan-targets.test.ts contains [the number of declared roots is bounded] — breadth is capped as depth already was, and a truncated scan says so

### Found by security review of the pushed commit

Three findings, all confirmed against the code and all in the same class as
the issue, so they are fixed here rather than filed.

**The exclusion list was applied to entries and never to roots.** A routing
table naming `node_modules/` or `worktrees/` was walked outright — the exact
case the list exists to stop, reached by the one path the list did not cover.
A guard that covers every door but one is a guard with a door.

**Breadth was unbounded.** `MAX_SCAN_DEPTH` capped how deep a repo-content-
driven walk could go and nothing capped how wide. `MAX_SCAN_ROOTS` is 20;
this repo declares six, and a truncated scan appends the count to `reason`
rather than quietly covering less than it claims.

**The validated value was not the value used.** `containedReal` resolved the
path and the walk then recursed on the unresolved one. The mutation measured
**0 of 27** and that is the honest result: using `real` closes a window
rather than changing behaviour, so no test covers it and none is claimed to.

- [x] SC-1634: test/doc-scan-targets.test.ts contains [a symlink cannot smuggle an excluded directory back in] — the exclusion is keyed on the resolved path, and the total file count is bounded as well as the root count

### A second review round, and the one that was a real hole

**The exclusion was keyed on the entry NAME.** Measured before the fix:
`docs/vendor -> node_modules` produced `node_modules/pkg/README.md`. The
guard saw the label `vendor`. That is the second shape in
`.claude/rules/checks-must-be-able-to-fail.md` exactly — a detector narrower
than what it detects, because the view it had of the input could silently
shrink to whatever a symlink was called. `excludedByPath` is now the one
decider, keyed on the resolved path, used by both the walk and the root
declaration, so there is one binding to mutate.

**The bound was on the wrong thing.** A cap on roots is not a cap on work:
twenty roots times six levels of unbounded fanout is still unbounded.
`MAX_SCAN_FILES` is 2000 and a truncated scan says so; this repo's own scan
collects 92.

- [x] SC-1635: test/doc-scan-targets.test.ts contains [the exclusion is case-insensitive, because the filesystem may be] — and the file cap stops the walk rather than only the collecting

### A third review round — two of three held

**The exclusion was defeated by changing a letter.** Measured before the
fix: `docs/vendor -> NODE_MODULES` produced `NODE_MODULES/pkg/README.md`.
On macOS and Windows that is the same directory the list already names.
The comparison is now case-insensitive **always**, not "when the filesystem
is" — the direction this is allowed to be wrong in is toward not scanning,
because a directory genuinely named `Archive` being excluded costs one
visible entry in `refused` and the other direction is a silent bypass of
the whole list.

**The cap was on the wrong accumulator.** `MAX_SCAN_FILES` stopped the push
and not the walk, so the output was bounded while the traversal and the
`seen` set kept growing. The cap now returns from `walkMarkdown`, and
`walked` is on the plan so that is checkable rather than asserted in prose.

**The third did not hold.** A claimed exclusion regression from replacing
the entry-name check was probed directly — `docs/sub/node_modules/pkg/X.md`
and `docs/.git/Y.md` are both refused. Reported here because a finding
checked and found not to apply is worth the same sentence as one that does.

### What was broken to prove it (SC-1622..1635)

Run over `test/doc-scan-targets.test.ts`, baseline 0 fail. Every count
predicted before the battery ran. The first sixteen were measured over 24
tests; the review fixes added three, and the three rows re-measured at 27
reproduce exactly.

| Mutation | Red |
|---|---|
| `routedDirectories` returns `[]` | 10 of 24 |
| the trailing-slash filter dropped, so any backticked token is a directory | 1 of 24 |
| `walkMarkdown` stops recursing — the defect verbatim | 4 of 24 |
| `MAX_SCAN_DEPTH` raised to 99 | 1 of 24 — **was 0.** See below |
| `SCAN_EXCLUDE_DIRS` emptied | 2 of 24 |
| the flat root scan removed | 1 of 24 |
| `planDocScan` ignores routing and always uses the defaults | 8 of 24 — predicted 10; see below |
| `unmeasured` never populated | 2 of 24 |
| `unmeasured` populated for absent DEFAULT roots too | 2 of 24 |
| the two-table section cut removed | 2 of 24 |
| BUG-440-A: containment dropped, any resolvable path accepted | 3 of 24 |
| BUG-440-A: the resolved-path `seen` set removed | 3 of 24 — the loop case and both alias cases |
| BUG-440-A: the walk records the traversal path instead of the canonical one | 1 of 24 |
| BUG-440-A: the walk's refusal never recorded | 2 of 24 |
| BUG-440-A: the routed root's refusal never recorded | 1 of 24 |
| BUG-440-A: a routed root that leaves the project is walked rather than skipped | 1 of 24 |

| the root-level exclusion removed | 1 of 27 |
| `MAX_SCAN_ROOTS` raised to 9999 | 1 of 27 |
| the truncation reported silently | 1 of 27 |
| the walk uses the traversal path instead of the validated one | **0 of 27** — hardening, not behaviour; see above |
| `walkMarkdown` stops recursing, re-measured | 4 of 27 — reproduces |
| containment dropped, re-measured | 3 of 27 — reproduces |

| `excludedByPath` always false | 4 of 29 |
| the exclusion keyed on the entry NAME again — the hole verbatim | 1 of 29 |
| `MAX_SCAN_FILES` raised to 999999 | 1 of 29 |
| the file truncation reported silently | 1 of 29 |
| `walkMarkdown` stops recursing, re-measured at 29 | 4 of 29 — reproduces |
| containment dropped, re-measured at 29 | 3 of 29 — reproduces |

| the exclusion keyed on exact bytes again — the hole verbatim | 1 of 30 |
| the cap stops the push but not the walk | 1 of 30 |
| `excludedByPath` always false, re-measured at 30 | 5 of 30 |
| `walkMarkdown` stops recursing, re-measured at 30 | 5 of 30 — predicted 4; the cap test never trips without recursion |
| containment dropped, re-measured at 30 | 3 of 30 — reproduces |

None of the thirty-three is left in the tree; all were run and reverted.

**The row that came back zero.** The bounded-recursion test built its fixture
as `MAX_SCAN_DEPTH + 3` levels deep. Raising the constant raised the fixture
with it, so the assertion could never catch a raised bound — an assertion that
holds vacuously, the third shape in
`.claude/rules/checks-must-be-able-to-fail.md`, arriving through a test that
derives its input from the thing under test. The fixture is now a literal 12
and the constant has a ceiling as well as a floor. The row is now 1.

**Two prediction errors worth recording, both mine.** `planDocScan` ignoring
routing measured 8 where 10 was predicted: the two missing rows are the
parser's own unit tests, which the planner cannot reach. That makes the
planner's routing branch a strict subset of the parser's — it has no row of
its own — which is the correct shape here, because delegating to one decider
is what the file is for. Separately, two rows were predicted as 2 and measured
as 1 because several failing assertions sat in one test; a battery counts
tests, not assertions.

**Two refusal sites, and each has an input only it reaches.** The walk refuses
entries that resolve outside, and `planDocScan` refuses a declared root that
does. They are not two deciders agreeing on safety — the walk is the safety
decider, and a routed root pointing outside yields nothing even with the root
check removed. The root check exists so the report can distinguish "the
project does not have this directory" from "the project points this somewhere
I will not follow", and the mutation rows confirm the split: removing the root
refusal leaves the walk cases green, and removing the walk refusal leaves the
root case green.

## SUCCESS.md is seeded, and an unfilled seed is refused (#485)

`CLAUDE.md` opens its rules with "SUCCESS.md is the measure" and no generator,
template or scaffold step ever wrote one. rungate's was hand-written once in
`22aa5b20` and nothing reproduced it for anyone else, so a consumer scaffolded
a project, read the generated `AGENTS.md`, and never learned the file was
supposed to exist.

The half that makes this more than a nicety is the refusal. **A generator
alone makes it worse**: a project that ran `create-success` and stopped would
have a `SUCCESS.md` that every "does it exist" check waves through, and three
TODO claims that read as deliberate at a glance. So the seed is `create-only`,
the template's placeholders are marked with a token no prose contains, and
`SUCCESS-1` refuses while any survive. The intended direction is that a
project which runs the generator and stops is **louder** than one that never
ran it: an unfilled template FAILS, an absent file is UNMEASURED.

- [x] SC-1706: lib/success-doc.ts contains [successViolations] — ONE exported function decides whether a SUCCESS.md is real, so there is one binding to mutate. The scaffold's WARN and the conformity suite's refusal read the same binding; a second "is it filled in?" predicate would be two deciders agreeing, which no behavioural test can tell apart
- [x] SC-1707: test/success-doc.test.ts contains [absence is RECORDED, never silent] — the CALL SITE is driven, not just the decider. Deleting the `if (verdict.unmeasured)` block from `runSuccessDocValidation` leaves `violations` empty, so the assertion below it passes and the check goes green over a project with no SUCCESS.md at all
- [x] SC-1708: test/success-doc.test.ts contains [ONE edit to the seed turns it into a refusal] — the case a naive file-exists check misses. #485 asks for the untouched seed to be refused; it reports UNMEASURED and records a finding instead, because a pristine seed carries exactly as much information as no file at all, and the scaffold now plants it whether the project asked or not. The refusal is aimed one state on, at a document somebody STARTED and abandoned, which is the one that reads as considered and is not
- [x] SC-1709: test/success-doc.test.ts contains [rungate's OWN SUCCESS.md passes the check it ships] — the only real instance of this document predates the validator by four months and is written in a different syntax. A validator whose single real-world example fails it is not strict, it is miscalibrated
- [x] SC-1710: lib/scaffold/steps.ts contains [seedSuccessDoc] — seeded under BOTH profiles via `safeWrite`, the single `create-only` writer, so a project's own claims are never regenerated over; and the WARN is derived from the real checker rather than a second copy

### What was broken to prove it (SC-1706..1710)

Run over `test/success-doc.test.ts`, 20 tests, baseline 0 fail. Every count
predicted before the battery ran, and **every one matched**.

| Mutation | Red | Predicted |
|---|---|---|
| `successViolations` short-circuited to a clean verdict | 10 | 10 |
| the call site: `if (verdict.unmeasured)` block deleted from `runSuccessDocValidation` | 1 | 1 |
| the placeholder refusal removed | 1 | 1 |
| `CLAIM_FORMS` narrowed to the heading form, dropping rungate's own | 3 | 3 |
| the `howItFails === null` refusal removed | 2 | 2 |
| `expect(violations).toEqual([])` dropped from the call site, `addFinding` kept | 2 | 2 |

None is left in the tree; all were run and reverted.

**The call-site row is the one the battery was built for, and it is 1 on
purpose.** #476's review found that its test helper reimplemented the
composition, so deleting the consumer block from the real function was **0 red
over 9,652 tests** — the guard counted call sites while the mutation removed
the caller. Here the conformity cases are spawned under `bun test` against
planted roots, and exactly one case asks what the check WROTE rather than
whether it failed. Delete that case and the row returns to 0.

**Two defects found by writing the tests rather than by the battery**, both
the same mistake this section is about:

- The first falsifiability pattern admitted `**How to measure it:**` beside
  `**How it fails:**`. The fixture for "a claim with no How it fails" deleted
  the fails line and the claim was still considered falsifiable, because the
  measurement line matched — a claim could satisfy the rule while saying only
  how to look. The fixture failing is what surfaced it; one that deleted both
  lines would have passed and hidden it.
- The first parser recognised only `### Claim N — ...`, so rungate's own
  `SUCCESS.md` reported "defines no claims". Both the numbered form and the
  heading form now parse, which widens the syntax and not what passes — the
  refusals are placeholders, unfalsifiable claims and a standing table that
  disagrees with the claims, and a document can satisfy either syntax and
  still fail all three.
## A dry run that reports what its evidence is worth (#59 SC-4, SC-5)

`DRY_RUN` stops `workflows/ship.js` after scope and returns a payload. Before
this, the payload held sizing, the ceremony tier, the AC list, prior work and
the scope verdict — and said nothing about whether any of those ACs could be
satisfied. `lib/evidence-prevalidator.ts` had already run every AC's evidence
command against the tree (#235, SC-618..620) and the scope gate had already
stamped the result onto `workflow-state.json`. The answer existed and never
reached the report. A caller doing a dry run to find out whether an issue was
shippable had to open the state file to find out.

### The draft derived PASS from the scope verdict, and that was wrong

The first `dryRunEvidenceQuality` took `scopeVerdict === 'PASS'` as proof that
the pre-validation reading was clean. The reasoning was that
`prevalidationViolations` refuses an absent reading, an `UNMEASURED` one, a
`FAIL`, any verdict that is not `PASS`, and a `PASS` carrying broken ids — so a
scope gate that passed could not be concealing a bad one. Every clause of that
is true **of the function** and false **of the gate**:

```ts
test("evidence-prevalidation: AC evidence commands pre-validated before ship", () => {
  if (!isVerifyPlus()) return;          // ["VERIFY", "SHIP", "DONE"]
```

At SCOPE the check returns before it asserts anything. The reading is taken
there — `stampEvidencePrevalidation(state, "scope")`, gate-executor.ts:1087 —
and refused on two phases later. A scope PASS therefore carries no information
about the evidence commands at all, and the draft would have reported `PASS`
for a run whose every AC was unwinnable. That is the defect class in
`.claude/rules/checks-must-be-able-to-fail.md`, written into the one function
whose docstring claimed to have ruled it out, and caught only by going to read
`isVerifyPlus` rather than trusting the refusal list.

It is pinned as a fact about `gates/workflow.test.ts` rather than left as a
comment. If the scope gate ever does start refusing on the reading, SC-1724
goes red and whoever makes that change has to decide deliberately whether the
report may derive anything from the verdict.

### So the reading is carried, not inferred

`workflows/ship.js` has no filesystem (#69), so the channel is the gate agent,
which already reads `workflow-state.json` at step 2 of `runGateWithHeal`. The
same channel `BUILD_RESULT_SCHEMA.worktreePath` uses, for the same reason:
`GATE_RESULT_SCHEMA` gains an optional `evidencePrevalidation: {verdict,
brokenAcs}`, and the gate prompt asks for it by name with an explicit
instruction not to infer the verdict from whether the gate passed.

Absent reads as `UNMEASURED` with a reason, never as `PASS`. `0`, `{}` and
silence are indistinguishable from success and `UNMEASURED` is not — the
Silent Default Substitution anti-pattern in `.claude/rules/config-access.md`.

The one branch shared with `prevalidationViolations` is that a `PASS` carrying
broken ids is a contradiction. Two deciders agreeing is the fourth shape in
`.claude/rules/checks-must-be-able-to-fail.md`, so the split is written down:
that one REFUSES a run at VERIFY, this one LABELS a report at SCOPE, they read
different inputs at different phases, and neither can cover the other's case.

### The refusal gets the report too

`if (scopeVerdict === 'FAIL') return await terminalFailure('SCOPE_FAILED', …)`
sits ABOVE the `if (DRY_RUN)` block. A dry run whose scope gate fails never
reaches its own report, so the reading is attached to the `SCOPE_FAILED`
detail as well. A report only the passing path receives is a report nobody in
trouble ever reads.

### Mutations, predicted before running and measured after

Over `test/dry-run-evidence-quality.test.ts` + `test/ship-scope-verdict.test.ts`
(35 tests).

| Mutation | Predicted | Measured |
|---|---|---|
| `dryRunEvidenceQuality` returns `{status:'PASS', blockers: []}` for everything | 4 | |
| the absent-reading branch returns `PASS` instead of `UNMEASURED` — the draft's bug | 2 | |
| the `PASS`-with-broken-ids contradiction branch deleted | 1 | |
| `evidencePrevalidation` dropped from `GATE_RESULT_SCHEMA` | 1 | |
| `evidenceQuality` dropped from the `SCOPE_FAILED` detail | 1 | |
| `acCount` hard-wired to `2` | 1 | |

### Success criteria

- [x] SC-1721: test/dry-run-evidence-quality.test.ts contains [no reading means UNMEASURED - and a scope PASS does not upgrade it] — eight shapes of silence are each asserted UNMEASURED with a reason, and a real PASS reading still reports PASS so "always UNMEASURED" does not satisfy the row
- [x] SC-1722: test/dry-run-evidence-quality.test.ts contains [a FAIL reading names the broken ACs - and says so when it cannot] — a FAIL with no ids is still a FAIL carrying a blocker saying it cannot name what to fix, because an empty blocker list reads identically to a clean run
- [x] SC-1723: test/dry-run-evidence-quality.test.ts contains [a PASS carrying broken ACs is a contradiction - not a pass] — and the branch it shares with `prevalidationViolations` is asserted in both files, with the reason the pair is not one decider written down
- [x] SC-1724: test/dry-run-evidence-quality.test.ts contains [a scope PASS entails nothing about the evidence - the gate does not check it there] — the reading is stamped at scope and refused on at VERIFY+, so the draft's derivation was unsound; this turns red if that ever changes
- [x] SC-1725: test/dry-run-evidence-quality.test.ts contains [a gate refusal naming the pre-validation outranks the reading it carries] — and an unrelated scope failure is not a blocker of the evidence
- [x] SC-1726: test/dry-run-evidence-quality.test.ts contains [the dry-run payload carries sizing - AC count - evidence quality and blockers] — ship.js's own `if (DRY_RUN)` block is executed over a planted run, and the AC count is re-measured against a one-AC discovery so a hard-wired literal fails
- [x] SC-1727: test/dry-run-evidence-quality.test.ts contains [the reading is attached to the refusal a blocked dry run actually takes] — the `SCOPE_FAILED` return precedes the `DRY_RUN` block, which is asserted by index rather than assumed
- [x] SC-1728: test/dry-run-evidence-quality.test.ts contains [the gate result schema declares the field the reading crosses on] — `GATE_RESULT_SCHEMA` is evaluated rather than grepped, and the prompt must ask for the reading rather than for an opinion
- [x] SC-1729: test/dry-run-evidence-quality.test.ts contains [nothing before the dry-run return creates a branch or comments on the issue] — #59 SC-5, enumerated over the executed prefix with a planted positive control
- [x] SC-1730: test/dry-run-evidence-quality.test.ts contains [each marker appears exactly once and the block runs on every run] — and a duplicated marker is refused rather than silently sliced
