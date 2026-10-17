---
doc-type: spec
status: draft
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Gate contracts — what gates exist, their inputs/outputs, pass/fail criteria, and how they chain
testable: true
compliance: strict
---

# Gate Contracts

## Problem Statement

The `gates/` directory has 7,456 lines across 22 files (11 source, 11 test). Three modules are substantial: `run-gate.ts` (936 lines), `orchestrator.ts` (569 lines), `ship-orchestrator.ts` (363 lines). HARNESS-GATES.md defines gate concepts but doesn't specify the code contracts — what each gate function takes as input, what it returns, what constitutes pass/fail, and how gates chain together.

Without contracts, gate behavior is defined by implementation, not spec. Changes to one gate can silently break the chain. Test coverage exists (orchestrator.test.ts at 950 lines, workflow.test.ts at 1,053 lines) but tests verify current behavior, not specified behavior.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | Every gate has a typed contract: input interface, output interface, pass/fail criteria | Contracts make gate behavior verifiable independent of implementation |
| D-2 | Gate contracts defined in this spec, not just in code | Spec-driven contracts mean the conformity engine can validate them |
| D-3 | Gate chaining is explicit — output of gate N is input to gate N+1 | No implicit state passing. Chain is a typed pipeline |
| D-4 | run-gate.ts (936 lines) reviewed for decomposition | Same pattern as scaffold — may be an orchestrator doing too much |

## Current State

| Gate | Lines | Test Lines | Contract Defined? |
|------|-------|-----------|------------------|
| run-gate.ts | <400 | — | Yes (SC-1400) |
| gate-executor.ts | ~600 | — | Yes (SC-1401) |
| orchestrator.ts | 569 | 950 | Partially (HARNESS-STANDARD.md) |
| ship-orchestrator.ts | 363 | 379 | Partially (HARNESS-SKILL-CHAIN.md) |
| brief-assembler.ts | 338 | 429 | No |
| schema.ts | 362 | 197 | No |
| witness.ts | 220 | — | No |
| self-heal.ts | 121 | 511 | No |
| error-classifier.ts | 89 | 249 | No |
| preload.ts | 77 | — | No |

## Success Criteria

- [x] SC-373: Every gate source file has a typed input/output interface exported (behavioral)
- [x] SC-374: Pass/fail criteria for each gate documented as SCs in this spec (behavioral)
- [x] SC-375: Gate chain order documented — which gates feed into which (behavioral)
- [x] SC-376: gates/run-gate.ts is under [400] lines
- [x] SC-377: Gate contracts testable by conformity engine (behavioral)
- [x] SC-378: No gate passes implicit state — all data flows through typed interfaces (behavioral)

## Per-Gate Pass/Fail Criteria

### SC-1400: run-gate pass/fail criteria
- **Input:** `RunGateInput` — gate name, slug, issue number
- **Output:** `ParseTestOutput` (alias for `GateResult[]`)
- **PASS:** All AC evidence commands succeed, all AC verdicts are PASS or SKIP, zero FAIL results
- **FAIL:** Any AC evidence command fails, any AC verdict is FAIL, or any gate check returns FAIL

### SC-1401: gate-executor pass/fail criteria
- **Input:** `GateExecutorInput` — gate name, slug, issue number, workDir, stateFilePath, harnessRoot
- **Output:** `GateExecutorResult` — resultVal, passes, fails, warns, results, attempt, exitCode
- **PASS:** All gate checks pass, all AC verdicts are PASS or SKIP, exitCode is 0
- **FAIL:** Any gate check fails, any AC verdict is FAIL, or exitCode is non-zero

**`harnessRoot` is part of the input contract, and it is required (#190).** The
gate executor does not resolve a root of its own. It receives one, already
resolved, and every subprocess it starts — `bun test gates/`,
`bun scripts/sync-spec-tests.ts`, and the B1/B2/B3 agents — runs with that
directory as `cwd`.

The reason is the failure it prevents: **a gate that resolves its own root can
run its subprocesses in a different tree than the run it is grading.** The
executor used to call `harnessRoot()` at seven separate `cwd:` sites, so the
tree it executed in was decided seven times over by the environment and by
wherever `lib/paths.ts` had been loaded from. `bun scripts/sync-spec-tests.ts`
WRITES, so the drift was not only observed in the wrong tree, it was created
there — and nothing errored, because both trees are real checkouts.

`gates/run-gate.ts` resolves the root once, in the exported `resolveRunRoot()`,
and threads it into the single `executeGate(...)` call. `HARNESS_ROOT` wins when
set; otherwise the root is the checkout `run-gate.ts` itself lives in — NOT the
main repository. `git rev-parse --git-common-dir` returns the main checkout from
inside a linked worktree, which is the opposite of what a gate needs: the files
a worktree run is grading are the worktree's. An empty root is refused by
`harnessRootFor` rather than replaced by a fallback.

Call sites that keep an implicit root are the ones about the project under test
rather than the harness: the type check, the dev-server liveness curl,
`git rev-parse HEAD` for prove evidence, and `writeGateResult` all use
`state.projectRoot`. Those are a different tree on purpose.

### SC-1402: orchestrator pass/fail criteria
- **Input:** `WriteGateResultInput` — state file path, gate name, pass/fail/warn counts, results array
- **Output:** `GateResult` — check name, result (PASS/FAIL/WARN), detail string
- **PASS:** `fails === 0` and no non-OUTCOME ACs have FAIL verdicts
- **FAIL:** `fails > 0` or any non-OUTCOME AC has FAIL verdict

### SC-1403: ship-orchestrator pass/fail criteria
- **Input:** `ShipGateInput` — slug, gate name
- **Output:** `AdvanceResult` — phase, gateResult, failures, iteration, circuitBreaker
- **PASS:** Gate executor completes without error and gate result in state is PASS
- **FAIL:** Gate executor throws or gate result in state is FAIL; circuit breaks after MAX_ITERATIONS

### SC-1404: brief-assembler pass/fail criteria
- **Input:** `AssembleBriefInput` — slug, workDir, projectRoot
- **Output:** `AssembleResult` — briefPath, acCount, contextFileCount, validated
- **PASS:** workflow-state.json exists, brief file written, `validated === true` (all required sections present)
- **FAIL:** workflow-state.json missing (throws), or required sections missing (`validated === false`)

### SC-1405: schema pass/fail criteria
- **Input:** `SchemaValidateInput` — raw state object to validate
- **Output:** `SchemaValidateResult` — valid boolean, issues array
- **PASS:** Zod parse succeeds with zero issues — no behavioral language, no garbage statements, no weak thresholds
- **FAIL:** Zod parse fails — behavioral pattern detected, garbage statement, weak threshold, or missing required fields

### SC-1406: witness pass/fail criteria
- **Input:** `WriteWitnessInput` — slug, gate, result, testOutput, issue, projectRoot
- **Output:** `VerifyWitnessResult` — valid boolean, record, error
- **PASS (write):** Witness file written with valid HMAC signature
- **PASS (verify):** HMAC recomputed matches stored HMAC, all required fields present
- **FAIL:** HMAC mismatch, missing fields, or witness file not found

### SC-1407: self-heal pass/fail criteria
- **Input:** `HealInput` — gate, slug, issue, projectRoot, workDir, maxAttempts, dryRun
- **Output:** `HealResult` — result (PASS/FAIL), attempts, failures, circuitBroken
- **PASS:** Gate execution result is PASS within maxAttempts
- **FAIL:** Gate result is FAIL; circuit breaks when `attempt >= maxAttempts`

### SC-1408: error-classifier pass/fail criteria
- **Input:** `ClassifyInput` — failures array
- **Output:** `ClassifyResult` (alias for `Classification`) — category, regressionTarget, retryable, failures
- **PASS:** N/A (always produces a classification). Empty failures array returns NON_RETRYABLE
- **FAIL:** N/A — classification is deterministic, never fails; consumer decides action based on category

### SC-1409: preload pass/fail criteria
- **Input:** `RecordTestInput` — test name, passed boolean
- **Output:** `TestRecordResult` — testName, result string
- **PASS:** Test result recorded to gate-results.jsonl and recurring failures logged
- **FAIL:** N/A — recording is best-effort; missing state dir silently skips

### The gate-executor contract was stated twice, and the two disagreed (#392)

This section used to carry a SECOND `### SC-388: gate-executor pass/fail
criteria` block, contradicting the one above it. Both claimed to describe
`executeGate`. Checked against `gates/gate-executor.ts` while renumbering:

| The removed block said | What the code has |
|---|---|
| Input also carries `projectRoot`, `issueRepo` | `GateExecutorInput` is `gate, slug, issue, workDir, stateFilePath, harnessRoot` and nothing else. Both names are read off `state` inside the executor, not passed in. |
| Output carries `testOutput`, and no `resultVal`/`attempt`/`exitCode` | `GateExecutorResult` is `resultVal, passes, fails, warns, results, attempt, exitCode`. There is no `testOutput` field. |

`executeGate` at `gates/gate-executor.ts@"export async function executeGate(input: GateExecutorInput)"` is the only entry point, so
there was no second function for the second block to be describing. It was a
pre-#190 design that the `harnessRoot` work superseded and nobody deleted —
and because a duplicate heading is still a heading, the registry read it as a
declaration and it was one of the ten collisions #392 is about.

Worth stating plainly: a spec that contradicts itself is the documentation
form of the defect `.claude/rules/checks-must-be-able-to-fail.md` describes.
Either block could be cited as the contract, so citing the spec proved
nothing, and the one that happened to be wrong had sat there since #190.

## Post-verdict steps must record their own outcome (#213)

`generateShipEvidence` runs from `runGate` only when the ship gate has already
recorded PASS. Everything it does happens after the verdict, so nothing
downstream re-reads it and a failure inside it is invisible by construction.

It ended with five statements wrapped in `try { … } catch {}`. Four distinct
ways for the auto-push to leave the commit on the local branch — a rejected
push, no upstream, a `rev-list` count that `parseInt` turned into `NaN`, and a
push that exited 0 against a remote that never received it — all produced the
same observable result as success: a run reporting PASS, a `ship-evidence.json`
naming a SHA, and that SHA only on this machine.

The `code-pushed` check in `gates/workflow.test.ts` does not cover this and is
not made redundant by it. That one runs *during* the gate and compares HEAD
against `@{upstream}`, a local remote-tracking ref that only fetch and push
update. This one runs *after* the verdict and asks the remote with
`ls-remote`, because "did the commit leave the machine" is a question a local
ref cannot answer.

The same shape, second instance: `readConformityFindings` caught both its read
and its parse and recorded nothing, so an unreadable findings file left
`state.conformityFindings` absent — byte-identical to a project that has no
findings at all, which is how every consumer's `if (state.conformityFindings)`
reads it.

Neither change makes the gate fail. The verdict was reached before these ran,
and a second place for a gate to fail would obscure the first. The rule is
that the outcome is **recorded and loud**, and that UNMEASURED never passes for
clean.

- [x] SC-714: lib/verified-push.ts contains [ls-remote] — a push the gate claims succeeded is confirmed by reading the remote back, because `git push` exiting 0 is a claim by git rather than a reading of the remote
- [x] SC-715: lib/verified-push.ts contains [no-upstream, unmeasured, not-attempted, rejected, unconfirmed] — each failure mode is its own recorded outcome, so the four paths the empty catch collapsed into silence are now distinguishable from each other as well as from success
- [x] SC-716: lib/verified-push.ts contains [parseInt] — an ahead-count that is not digits is UNMEASURED rather than zero, because the original compared `NaN > 0`, which is false, so an unreadable count skipped the push exactly as if there were nothing to push
- [x] SC-717: gates/orchestrator.ts contains [pushLeftWorkLocal] — the push outcome is written into ship-evidence.json, which is the artefact the run is judged by, rather than printed into a log nobody reads
- [x] SC-718: gates/gate-executor.ts contains [unreadableConformityMarker] — an unreadable findings file sets a distinct marker that a consumer can tell apart from an empty findings list
- [x] SC-719: test/gate-auto-push.test.ts contains [the shim did not intercept the push] — the remote read-back is proven able to fail by a `git` shim that exits 0 on push without doing anything, driven on every run rather than recorded once in a PR body
- [x] SC-720: lib/verified-push.ts contains [redactReadings] — git's output is stripped of credentials before any of it reaches a recorded outcome, because a failed HTTPS push quotes the remote URL and ship-evidence.json is durable
- [x] SC-721: gates/orchestrator.ts contains [verifiedPush(process.cwd()] — the push runs in the tree `gitSha()` measured rather than one named by workflow-state.json, so a privileged operation does not take its target from a data field and the artefact cannot contradict itself
- [x] SC-722: gates/orchestrator.ts contains [the auto-push threw] — an unexpected throw in post-verdict bookkeeping is recorded as UNMEASURED instead of crashing a run that has already passed, which is the one property the empty catch had and had to be kept

### What was broken to prove it (#213)

Run and counted over `test/gate-auto-push.test.ts`. None is left in the tree;
all were run and reverted. The first five were measured at 32 tests, the last
two at 38 after the redaction cases were added.

| Mutation | Red |
|---|---|
| the local/remote SHA comparison short-circuited (`if (false)`) | 3 of 32 — the unconfirmed cases and the real-remote mutation case start reporting `pushed` |
| the unreadable-remote branch short-circuited | 2 of 32 — a push whose `ls-remote` fails reads as confirmed |
| `parseInt` semantics restored for the ahead-count | 2 of 32 — an empty or garbled count silently becomes "nothing to push" again |
| the no-upstream branch short-circuited | 3 of 32 — including the real temp repo on a branch that has never been pushed |
| `readConformityFindings`'s catch emptied back out | 2 of 32 — the marker and the empty-vs-unreadable distinction both vanish |
| `redactReadings` bypassed in `classifyPush` | 2 of 38 — a hand-built reading carrying a PAT reaches the recorded outcome |
| the URL-userinfo rule deleted, leaving only the token rule | 2 of 38 — the two rules overlap on a PAT in a URL, so a non-token password is what separates them |
| the push target changed back to `state.projectRoot \|\| process.cwd()` | 1 of 42 |
| the call site's guard reverted to `catch {}` | 1 of 42 |

### Security review, addressed rather than argued with

Three findings on the first push of this change. All three are about the call
site or the trust boundary rather than the classifier, and all three are now
pinned by tests so a later edit has to move them deliberately.

- **The push took its tree from `state.projectRoot`.** That is a field in a
  state file choosing which repository a `git push` runs against, and the code
  being replaced did not do it. Reverted to `process.cwd()`, which is also the
  tree `gitSha()` measured for `mergeCommitSha` — a push from anywhere else
  would confirm a remote against a SHA the artefact never took.
- **`verifiedPush` takes an injectable `env` and resolves the `git` binary.**
  Kept: it is how the standing push-no-op mutation is performed, and the only
  production caller passes `process.env` plus one flag, which is no wider than
  the ambient environment already is. The call site's exact shape is now
  asserted, so a later caller funnelling a state-file value into `env` is
  caught rather than assumed away.
- **Fail-open.** The classifier is total and its unknown case is `unmeasured`,
  which `leftWorkLocal` counts as "work may be local" — there is no input for
  which it reports success without having read the remote. The real gap was
  adjacent: an unexpected throw would now crash post-verdict bookkeeping that
  the old empty catch could not. That is recorded as UNMEASURED instead.

## A check keyed to a config value nobody authors (#315)

`code-committed` read `harness?.codeCommittedPaths || []` and returned early
on an empty list. **Nothing authors that key** — measured on main, neither
rungate's `.claude/rungate/config.json`, nor its legacy
`.claude/rungate.json`, nor DailyBriefDashboard's names it. So the check whose
entire job is confirming the shipped work is committed hit the early return on
every run this repository has ever made.

Fourth instance of the class, after `dev.testCmd` vs `test.command` (#294),
`container` being undeclared in the schema (#307 SC-A1), and the two
`local-*-validated` checks in #176. Hence the registry rather than two edits:
the point is to make a fifth impossible to add unexplained.

### The scope decision, recorded (SC-E2)

**Optional with a derived default**, not required. Requiring it would refuse
at scaffold time for every consumer that has never heard of it — an outage for
a rule nobody opted into, the same reasoning `loadConformityAllowlists` and
#302's growth check already apply. And the default is not a guess: for a check
named "no uncommitted changes in project" the honest scope is the whole tree,
and a configured path list is a narrowing a consumer opts into, not the thing
that switches the check on.

Untracked files count, because `--porcelain` already honours `.gitignore` and
a source file that was never added is exactly the uncommitted work this check
exists to catch. An artefact that trips it belongs in `.gitignore`; that is
the right pressure rather than a reason to narrow the check.

### `evidence-target-valid` was removed, not fixed

It read the same unauthored key — and past that early return it computed an
`outside` list and discarded it under a comment saying outside refs are
common. It had no `expect` at all: a name in `config/ceremony-profiles.json`
and nothing else. Deleted from the suite **and** delisted from the two
profiles that named it, because leaving either half would have the contract
claim a measurement that does not happen. #338 tracks rebuilding it with a
threshold that has evidence behind it; #339 tracks the nine profile names
found to have no locatable implementation.

- [x] SC-723: gates/workflow.test.ts contains [codeCommittedViolations] — the refusal routes through one exported function, so short-circuiting it is a measurement rather than a claim in a PR body
- [x] SC-724: gates/workflow.test.ts contains [git status --porcelain] — an unset path list means the whole tree rather than no check, so absence is a derived default and never a silent pass
- [x] SC-725: test/gate-optional-config-keys.test.ts contains [no unexplained key is read] — every optional config key a gate check reads carries a recorded meaning for its absence, ratcheting both ways so a stale entry is refused as well as a new one
- [x] SC-726: test/gate-vacuous-checks.test.ts contains [uncommitted work is caught with NO codeCommittedPaths configured] — the check is executed against a planted git repo with real uncommitted work, because a unit test of the violations function stays green when the call site returns before reaching it
- [x] SC-727: gates/workflow.test.ts contains [execArgv] — a value read out of the consumer's own config reaches git and the container runtime in argv form, because the shell-string form interpolated it straight into a command
- [x] SC-728: test/gate-optional-config-keys.test.ts contains [every read of it is optional-chained] — the key scan's own assumption is asserted rather than assumed, because a read written without optional chaining, or against a differently-named binding, would be invisible to the registry guarding it

### What was broken to prove it (#315)

Run and counted over `test/gate-vacuous-checks.test.ts` plus
`test/gate-optional-config-keys.test.ts` (54 tests). Neither is left in the
tree; both were run and reverted.

| Mutation | Red |
|---|---|
| `if (paths.length === 0) return;` restored at the call site — SC-E4 verbatim | 2 of 54 — the driven fixture with uncommitted work, and the source-text guard against the early return coming back |
| `codeCommittedViolations` short-circuited to `return []` | 7 of 54 — every driven red case and every unit refusal |
| the shell-string form of the status command restored | 1 of 56 — a config path carrying `; touch <canary>` creates the canary |
| the unchained `harness.prod.containerName` read restored | 2 of 56 — the binding invariant the key scan rests on |
| a bracket-notation read (`harness?.["prod"]`) planted | 2 of 34 in the registry file |
| a differently-named binding (`const cfgAlias = loadProjectHarness()`) planted | 1 of 34 |

### Security review, second round

Two findings, both real and both now driven rather than argued with.

- **Command injection.** `codeCommittedPaths` and `prod.containerName` are
  read out of the consumer's own `.claude/rungate.json` and were interpolated
  into shell strings — `exec(\`git status --porcelain -- ${paths.join(" ")}\`)`
  and the container `inspect` command. Both moved to argv form, which removes
  the shell rather than sanitising for it. A driven test plants a path
  containing `; touch <canary>` and asserts the canary does not appear.
- **Detector differential.** The registry scanned for `harness?.<key>`, so a
  read written as `harness.<key>`, or against a differently-named binding,
  would have been invisible to the guard meant to catch it — shape two,
  pointed at the guard itself. The scan's assumptions are now assertions: the
  `loadProjectHarness()` result is bound to exactly one name, and every read
  off it is optional-chained. Finding that turned up a second const also
  called `harness`, parsed inline from the tree under test, whose four config
  keys the registry had never seen; it is renamed `treeHarness` and its keys
  are registered.

A third round found the same control still bypassable, which is the point of
running the review again rather than once. `harness?.["codeCommittedPaths"]`
satisfies both of the assertions added in round two — it IS optional-chained,
the binding IS named `harness` — and is invisible to a scan for dotted
identifiers. Bracket access and destructuring are now refused too, and all
five patterns are declared once and shared between the assertion that
enforces each and the planted control that proves it can match; two copies
would let the enforcing one be narrowed while the control kept passing
against the old pattern, which is the detector-differential shape
reintroduced inside the file that exists to catch it.

The round-three fail-open finding — `container-has-fix` passing on four
distinct unmeasurable states — is **#341**, deliberately not fixed here.
It is reachable rather than dead code, so making it refuse changes behaviour
on a live consumer, and that needs its blast radius measured first rather
than guessed at in an adjacent PR.

## A probe with a consumer's route baked into it (#304)

`checkDevServerLiveness` curled a literal `${apiBase}/api/admin/health`.
`apiBase` came from config; the path did not — it is one consumer's endpoint,
written into the harness. The probe only runs for a project that sets
`dev.apiBase` and has a server-dependent OUTCOME AC, and rungate sets no
`dev` key at all, so that one consumer is the only project that has ever
reached the line. It worked by coincidence.

The first consumer with a different health route is told its running server is
DOWN and to start it. A false FAIL naming the wrong cause is worse than no
check, because the stated remedy is to start something already running.

### One site named, five found

The issue described one. The grep it asked for found five, and that ratio is
the argument for point 1 of its own test plan — the cheap sweep is worth more
than the fix it was written to follow.

| Site | What it did | Fixed |
|---|---|---|
| `gates/gate-executor.ts` `checkDevServerLiveness` | the site #304 named; FAIL result | yes |
| `gates/gate-executor.ts` prove gate, dev | same route, behind `process.exit(1)` — the worst of the three, because the consequence is a hard refusal | yes |
| `gates/gate-executor.ts` prove gate, prod | same route against `prod.apiBase`, behind a warning — the least visible | yes |
| `workflows/prove.js` `ensure-dev-server` | named a route in an agent prompt | yes |
| `workflows/verify.js` smoke test | two DDB endpoints, alongside DDB's ports, container name and app path | **no** — #344 |

### No default path, and that is the decision this turns on

`dev.healthPath ?? "/health"` is the obvious shape and is wrong for the same
reason the hardcoded route was: a guessed path 404s on a healthy server,
`curl -sf` exits non-zero, and the probe reports DOWN. **Unconfigured has to
mean UNMEASURED** — a recorded WARN, never a FAIL. This is #185's
`mergedIntoBase` distinction in the direction that matters: reporting DOWN
looks fail-closed and is simply wrong, and it blocks a correct run.

`probeTarget` is one function so that decision is made once for all three
gate-executor sites. The alternative — three call sites each deciding what an
absent path means — is how the second and third copies came to exist.

### The guard that should have caught this never looked below the top level

`test/anti.test.ts` SC-A1 — "no project-specific references in workflows" —
has existed the whole time and is the check this bug should have tripped. Its
`findTsFiles` did not recurse. It read only the top level of `gates/`,
`lib/` and `scripts/`, so the three consumer references under `lib/scaffold/`
were invisible to it, and it reported clean. A guard passing because of what
it never looked at, inside the file whose entire job is refusing consumer
specifics.

Writing the consumer's name into a comment while fixing #304 is what turned
it red — which is the correct behaviour, and the comments were reworded
rather than the guard weakened. The walk is now recursive, the three known
references are an exact list that ratchets both ways, and a planted control
asserts the walk reaches `lib/scaffold/` at all, because the list assertion
would pass vacuously against a flat walk exactly as it did before.

SC-A1 still only matches the consumer's *name*. It would not have caught
`/api/admin/health`, which carries no name — that is what the route sweep in
`test/dev-liveness.test.ts` is for, and why both exist.

### `workflows/verify.js` is a counted ratchet, not an exemption

Its two route literals are held as an exact list in
`test/dev-liveness.test.ts`. A directory skipped by the sweep is a directory
nobody measures again; a count refuses growth AND goes red as an instruction
to delist when #344 lands. Ratchets move both ways (#310, #299).

- [x] SC-733: lib/dev-liveness.ts contains [probeTarget] — one function decides where to probe and what an absent path means, because three call sites deciding separately is how the second and third copies of the hardcoded route came to exist
- [x] SC-734: test/dev-liveness.test.ts contains [a different consumer's route is probed] — two fixture consumers with different health paths both produce a probe at their own URL, and the two URLs are asserted to differ so the test cannot be matching a constant
- [x] SC-735: test/dev-liveness.test.ts contains [unconfigured means UNMEASURED, never DOWN] — a consumer with no health path configured produces neither UP nor DOWN but an explicit unmeasured result, because "could not check" must never become "it is down"
- [x] SC-736: test/dev-liveness.test.ts contains [no API route path is written into] — the harness is swept for consumer route literals with comments stripped, because the single fix leaves the class open and the sweep is what found four of the five instances
- [x] SC-737: test/anti.test.ts contains [the walk reaches subdirectories] — SC-A1's file walk is recursive and proven to reach lib/scaffold/, because the flat version read only the top level and reported clean over three consumer references it never opened
- [x] SC-738: test/dev-liveness.test.ts contains [a base path is kept, not discarded] — the health path is appended to the base path rather than resolved against the origin, because resolution drops the prefix and probes a healthy server at the wrong place
- [x] SC-739: test/dev-liveness.test.ts contains [the recordable URL does not] — credentials a consumer puts in apiBase reach curl but never a printed line or a recorded detail, because detail lands in ship-evidence.json and gets attached to issues
- [x] SC-740: test/dev-liveness.test.ts contains [relaxing a refusal is recorded] — the prove gate carries both tiers' liveness readings into prove-input.json with DOWN and UNMEASURED distinct, because a refusal removed in favour of a stdout line is a fail-open
- [x] SC-741: test/dev-liveness.test.ts contains [a credential in the QUERY STRING is redacted] — every query value in a recorded URL is blanked rather than the ones whose key looks secret, because a key list needs updating for the next consumer's naming and nothing goes red when it does not
- [x] SC-742: test/dev-liveness.test.ts contains [the retracted claim is not still in the tree] — a source comment claiming the B3 reproducer reads the liveness field is refused while the prompt does not mention liveness, because the claim was written once without checking

### What was broken to prove it (#304)

Run and counted over `test/dev-liveness.test.ts` (25 tests). None is left in
the tree; all were run and reverted.

| Mutation | Red |
|---|---|
| `probeTarget`'s `!healthPath` branch returns `{kind:"probe", url: apiBase + "/health"}` — the default this spec argues against, written in | 2 of 25 |
| `livenessUrl`'s `url.origin !== base.origin` check removed | 1 of 25 |
| `livenessUrl`'s scheme allowlist removed | 2 of 25 |
| `ROUTE` restored to the quote-anchored form it was first written with | 2 of 25 — the planted control and the `workflows/` ratchet |
| the literal `/api/admin/health` replanted in `gates/gate-executor.ts` | 1 of 25 |
| `hasServerDependentOutcomeAC` short-circuited to `return true` | 3 of 25 |
| SC-A1's walk made flat again | 2 of 11 in `test/anti.test.ts` — the ratchet and the planted control |
| a new `lib/` file naming the consumer planted | 2 of 11 — the unexpected-reference list and the ratchet |
| `livenessUrl` resolves against the base instead of appending to its path | 1 of 35 |
| every `redactSecrets` call in `lib/dev-liveness.ts` replaced with identity | 3 of 35 |
| the prove gate's `liveness` array emptied in `prove-input.json` | 1 of 35 |
| `plan.url` printed instead of `plan.safeUrl` at the gate | 1 of 35 |
| `safeForRecord` loses its query rule, keeping only `redactSecrets` | 3 of 41 |
| the liveness write to the workflow state dropped | 1 of 41 |
| the retracted "B3 reproducer reads them" claim replanted | 1 of 41 — **0 of 41 before the guard was rewritten to read raw source** |

### Security review, addressed rather than argued with (#304)

Two findings, both real, both driven rather than reasoned about.

- **A base path was silently discarded.** `livenessUrl` resolved the health
  path against the base — `new URL("/health", "http://host/base/api")` yields
  `http://host/health`. A consumer whose API is mounted under a prefix would
  be probed at the wrong place and reported DOWN on a healthy server, which
  is **this issue's own bug, reintroduced by URL resolution semantics** inside
  the function written to remove it. It now appends to `base.pathname`, keeps
  the same-origin check, adds a prefix check, and refuses a `//`-prefixed
  path by name rather than relying on the origin comparison to catch it.

- **Credentials reached a durable artefact.** `apiBase` may legitimately carry
  userinfo, and the probe URL was printed and written into `detail`, which
  lands in `ship-evidence.json` and gets attached to issues. `ProbeTarget`
  now carries `url` and `safeUrl` as separate fields — curl gets the first,
  every print and every record gets the second — and the unmeasured `detail`
  strings that quote `apiBase` are redacted. `redactSecrets` is imported from
  `lib/verified-push.ts` rather than written again; a second copy is how two
  redactors drift and one of them stops covering a form.

A third point the review raised is a **refusal relaxation**, and it is the
one worth stating rather than silently accepting. The prove gate used to
`process.exit(1)` when `dev.apiBase` was set and the server did not answer.
No consumer sets `dev.healthPath` yet, so on merge every one of them stops
being refused there. Reporting DOWN instead would be wrong — that is the
whole issue — but letting the gap evaporate into a `console.warn` is a
fail-open. The readings for both tiers, including the ones that measured
nothing, now go onto the workflow state — the durable artefact later gates
read — as well as into `prove-input.json`. `DOWN` and `UNMEASURED` are
recorded as distinct states, because collapsing them is precisely what makes
an unmeasured gate look checked.

### Security review, second round

Two more, and the second is a correction to this spec.

- **Redaction covered one form and shipped the other.** `redactSecrets`
  handles userinfo and bare GitHub tokens; it does not touch a query string,
  and a health route is exactly where a consumer puts `?access_token=…`. Both
  the probe URL and the "these do not combine" detail carried it through.
  `safeForRecord` now blanks **every** query value — not the ones whose key
  looks secret, because a key list is a detector narrower than what it
  detects and nothing goes red when it falls behind a consumer's naming. The
  origin and path, which are what identify the probe, survive.

- **The record is written and nothing reads it.** No check refuses on the
  liveness reading, so the control the relaxation removed has not been
  replaced — "recorded but never consumed" is the #213 shape. Tracked as
  **#346**, with the correct refusal spelled out there: not "FAIL if
  UNMEASURED", which reinstates the false FAIL, but the contradiction — an
  OUTCOME AC claiming server-dependent evidence while liveness was never
  measured. Adding a new refusal to a live gate needs its blast radius
  measured, the same reasoning that deferred #341 out of #315.

**The retracted claim.** The first version of this section said the B3
reproducer reads the liveness field and `prove-evidence.json` carries it
forward. It does not — `gates/prompts/prove-reproducer.md` never mentions
liveness — and the sentence was written without checking. It is now asserted
instead of narrated: a test reads the prompt, and if the prompt does not
mention liveness it refuses any source comment claiming otherwise.

Getting that guard to work took two attempts, and the failure is worth
recording because it is this file's subject. Both the first version of it and
the `#346` reference check searched the **comment-stripped** source for a
sentence that can only ever appear in a comment. The `#346` one failed
visibly. The retracted-claim one passed — and replanting the false claim
verbatim scored **0 red**. A check that passed because of what it never
looked at, written twice in a row in the test file whose subject is that
defect, and caught only because the mutation was run rather than reasoned
about.

The fourth row is the one worth reading, and it is the reason the planted
control exists. The first version of the sweep required a quote on each side
of the route and so did not match `` `curl -sf ${apiBase}/api/admin/health` ``
— the literal it was written for, which is preceded by `}`. Restoring that
pattern leaves the absence claim green over every live instance; only the
planted control and the `workflows/` ratchet go red. A detector that cannot
see the instance it was built from is this repository's house defect,
reproduced inside the test written to end it, and caught only by the two
cases whose job is to prove the detector can match at all.

## The evidence chain had no mandatory link (#277)

`evidence-method-executed` opened with
`if (t !== "COMMAND" && t !== "command") return false`. `EVIDENCE_METHOD_TYPES`
has thirteen members; the check covered two. `threshold-crosscheck` opened with
`if (!ac.threshold || !ac.evidence) continue`, so the one state it had no
opinion about was an AC with no evidence — which is exactly the state an AC is
in when nobody recorded any. `EvidenceSchema` is `.nullable().optional()`, so
absent is schema-valid.

An AC declaring `BUN_TEST` and `threshold: >= 5`, with nothing ever run and
nothing ever recorded, passed both checks. So did `PLAYWRIGHT`, `SCREENSHOT`
and `GREP_CHECK`. **Eleven of thirteen types reached a verdict with nothing
behind them**, and the lower-case aliases widen the hole rather than closing
it: `grep` is a distinct enum member from `command`.

### Why a matrix and not an example

The defect was not that one type was handled wrongly. It was that twelve were
never considered, because the check was written for the one in front of
whoever wrote it. A single planted `BUN_TEST` case would be satisfied by a
check that handled `BUN_TEST` and nothing else — the same mistake with a
different constant. So the table is generated **from** the enum, every member
carries a declared verdict, and adding a member without declaring one turns it
red (SC-746). The expected verdicts are written down rather than computed,
because a map derived from the same predicate the code uses agrees with every
bug the code has.

### Two links, and each proven to be load-bearing

`missingEvidenceViolations` requires the evidence to EXIST;
`thresholdCrosscheckViolations` requires its value to clear the bar. Neither
is sufficient alone, and the test asserts the pairing directly: for an AC with
no evidence, crosscheck is silent **and** the existence check must speak. If
both are quiet, that is #277 reopened.

The three `continue` branches in crosscheck are now decisions rather than
gaps, each driven: no evidence (silent here, caught by the other link), a
non-numeric evidence shape such as a screenshot URL, and a non-numeric
operator — `contains` and `exists` are legitimate `THRESHOLD_OPS` members and
`parseFloat` on their value is meaningless, not lenient.

### The exemptions are chosen

Eleven types were exempt because a comparison missed them, which is
indistinguishable from a decision until somebody writes the decision down.
`EVIDENCE_EXEMPT_TYPES` names `MANUAL` and its lower-case alias with a reason
each, and a `SKIP` verdict exempts because it is a declaration rather than a
silence — `PENDING` does not, and that pair is asserted.

### Extracted to a library, for a reason worth recording

The functions live in `lib/evidence-required.ts`, not beside the checks that
call them. `gates/workflow.test.ts` only executes when a gate spawns it with
`TEST_WORK_DIR`; the first version of the test imported it to reach one
function and **registered sixteen of its gate checks in the ordinary suite**,
where `sf()` reads nothing and all sixteen passed vacuously. Sixteen checks
that could not fail, added by a test written to close a hole of exactly that
shape, and found by reading the junit per-classname output rather than the
pass count.

- [x] SC-743: lib/evidence-required.ts contains [missingEvidenceViolations] — an AC carrying a threshold and no recorded evidence is refused for every evidenceMethod.type, because the check covered two of thirteen and the other eleven reached a verdict with nothing behind them
- [x] SC-744: lib/evidence-required.ts contains [EVIDENCE_EXEMPT_TYPES] — every exemption is enumerated with a reason, because an exemption produced by a comparison falling through is indistinguishable from one somebody decided on
- [x] SC-745: test/gate-vacuous-checks.test.ts contains [evidence-method-executed reaches its refusal] — the check is driven against a planted state through the real gate, because a unit test of the violations function stays green when the call site returns before reaching it
- [x] SC-746: test/evidence-required.test.ts contains [the matrix covers the enum exactly] — the verdict table is generated from EVIDENCE_METHOD_TYPES and a member added without a row turns it red, because the table ossifying while the enum grows is how eleven types became exempt in the first place

### What was broken to prove it (#277)

Run and counted over `test/evidence-required.test.ts` plus
`test/gate-vacuous-checks.test.ts` (73 tests). None is left in the tree; all
were run and reverted.

| Mutation | Red |
|---|---|
| the check narrowed back to COMMAND only — SC-5 verbatim | 16 of 73 |
| `missingEvidenceViolations` short-circuited to `return []` | 24 of 73 |
| `thresholdCrosscheckViolations` short-circuited to `return []` | 8 of 73 |
| `hasRecordedEvidence` returns true, so an empty evidence object counts | 1 of 73 |
| `e.value != null` weakened to `Boolean(e.value)`, so a measured 0 reads as absent | 1 of 73 |
| `missingEvidenceViolations` renamed | 1 of 33 — and 40 tests never ran: the rename breaks the import, so the file aborts rather than refusing. Red for a different reason than a copied binding would be, which is why the single-binding assertion exists alongside it |
| `WEBHOOK` added to `EVIDENCE_METHOD_TYPES` with no matrix row | 4 of 42 |

The second row is the one that matters most. Short-circuiting the existence
check turns a quarter of the file red — including the case asserting that
crosscheck's silence on a missing-evidence AC is only safe because something
else speaks first.

## The rest of the hardcoding, fixed rather than filed (#343, #344)

#304's sweep found hardcoded **routes**. Looking for them turned up the same
defect in three other shapes, and all of them are fixed here rather than left
as issues — the policy changed mid-session: a defect uncovered while fixing a
defect is part of that defect's blast radius, and filing it just pays the
context cost twice.

| Site | Literal | What it did to another consumer |
|---|---|---|
| `lib/transcript-checker.ts` | `textLower.includes("make rebuild")` | The forbidden-command directive fell through to `N/A`, which `computeScore` drops from its denominator. The rule went unenforced, the score did not move, and nothing named the directive that had stopped being measured. |
| `lib/create-brief.ts`, `gates/brief-assembler.ts` | "Never run \`make rebuild\`" | One consumer's prohibition emitted into every consumer's agent brief. The agent obeys it; nobody finds out it was invented. |
| `lib/scaffold/steps.ts` | `existsSync(makefile) ? "make rebuild"` | Inferred from a Makefile EXISTING, not from the target existing. A project with a Makefile and no `rebuild` target got a `prod.rebuild` that cannot run. `scripts/scaffold-rungate-config.ts@"if (/^rebuild/m.test(mf)) rebuildCmd ="` already checked the target; the two are now consistent. |
| `workflows/verify.js`, `workflows/batch-ship.js` | ports, container name, app root, test dir, two routes | Three produce a loud false FAIL. The test directory produces a false **PASS** — `bun test --isolate test/unit/` against a project with no such directory runs zero tests and reports success with a count of nothing. |
| `gates/workflow.test.ts` | `if (port !== 7776)` | `quinn-container-port` warned that a consumer's correct port was wrong, naming a port they do not run. |

### A forbidden command is named by the directive, not by the harness

`forbiddenCommandsIn` reads the command out of the directive text — a
"never run X" rule already says what X is. The extractor is deliberately
narrow about what counts as a command: lower-case start, no slashes or dots,
so `` `.github/workflows/ci.yml` `` and `` `CODE-MAP.md` `` are paths and not
commands. The opposite failure is the worse one: reporting VIOLATED because
somebody ran a command containing the name of a file they were told not to
edit would make the check untrustworthy in the direction that matters.

### Unconfigured is SKIP, named, never PASS

Every reader in `workflows/verify.js` states what its absence means and emits
a `SKIP` carrying the missing key. The test-suite step additionally instructs
that a run matching zero tests is a FAIL — "the suite did not run" and "the
suite passed" were indistinguishable, and that is the one of the four that
was silently green rather than loudly red.

### The #304 ratchet moved the other way

`workflows/` held two route literals as an exact list, with a note saying it
would go red as an instruction to delist when #344 landed. It landed, it went
red, the list is now empty. A skipped directory would have stayed skipped
forever; a count had to be changed by someone reading why it was there.

- [x] SC-747: lib/transcript-checker.ts contains [forbiddenCommandsIn] — a NEVER directive's forbidden command is read from the directive rather than matched against a literal, because one consumer's command meant the rule fell through to N/A for everyone else and N/A is excluded from the compliance denominator
- [x] SC-748: test/transcript-checker.test.ts contains [a backticked PATH is not treated as a command] — the extractor refuses paths, because reporting VIOLATED for a file somebody was told not to edit is a worse failure than the hole it replaces
- [x] SC-749: workflows/verify.js contains [UNMEASURED, not PASS] — every mechanical check names the config key it could not find and skips, because a test command pointed at a directory that does not exist runs zero tests and reports success
- [x] SC-750: test/scaffold-make-targets.test.ts contains [a make target is inferred from the target] — the scaffold writes `make rebuild` only when the Makefile declares that target, because inferring it from the file's existence hands a project a command that fails with "No rule to make target"

### What was broken to prove it (#343, #344)

| Mutation | Red |
|---|---|
| `forbiddenCommandsIn` returns `[]` | 6 of 24 in `test/transcript-checker.test.ts` |
| `COMMANDISH` loosened to `/^.+$/`, so any backticked token counts | 2 of 24 |
| `make rebuild` replanted as a literal arm in the detector | 1 of 24 |
| `makeTarget` weakened back to `existsSync(makefile)` | 3 of 6 in `test/scaffold-make-targets.test.ts` |

### A guard that scored 0 red, and what it was actually doing

`forbiddenCommandsIn` shipped with an extra line in front of the regex:

```ts
if (token.includes("/") || token.includes(".")) continue;
```

Added for safety, to stop backticked paths being read as commands. Mutating
it away scored **0 red**, which is the only reason anyone looked at it.

`COMMANDISH` already rejects `.github/workflows/ci.yml` (leading dot),
`CODE-MAP.md` (upper case) and `project-state.json` (a dot in the first
word). The extra line had never once changed a path's verdict. What it *did*
change was `npm run deploy.prod` — a legitimate command with a dot in it,
silently dropped and therefore silently unenforced.

So the guard could only ever remove true positives. It is deleted, the
rejection it was supposedly doing is asserted against the regex that actually
does it, and the dotted command has a case of its own. A line that cannot
fail is not merely decorative here; this one was costing coverage.

## The status file that could not be wrong (#343, follow-up)

`PROJECT-STATE.md` is the first thing AGENTS.md tells a session to read, and
it is how a human finds out where the project is. Nothing made it go red when
it stopped being true.

The pre-commit hook runs `scripts/update-project-state.ts` on every commit,
and that script printed `✅ Updated PROJECT-STATE.md (25/25 SCs done)` every
time. It only **re-renders** the markdown from `project-state.json`; writing
session content is the DA's job. So across eight commits and four merges on
2026-10-12 it reported success eight times while the latest recorded session
stayed at 38, dated the day before.

Two separate fail-opens, and the second one is why the first went unnoticed:

- **The claim was unconditional.** A line that says "updated" after an
  unchanged re-render is the fail-open shape this repo keeps finding — green
  for a reason that has nothing to do with the thing being correct. It now
  diffs before and after and names which of the two files it actually
  rewrote, or says plainly that it re-renders and does not write session
  content.
- **The count could not move.** `25/25` is Phase 0+1, complete for weeks and
  unrelated to whatever is being committed. A number that cannot change is not
  a status; it is decoration that reads as one.

### Why this refuses rather than auto-writes

The narrative is the content worth having — which defects were the same class,
what the lesson was, what policy changed — and a machine cannot write it.
Noticing it is MISSING is pure mechanism: compare merge commits on `main`
against what the latest session entry accounts for. A generated placeholder
would satisfy the check and tell the reader nothing, which is strictly worse
than the staleness it replaced, so the test names the uncovered merges and
stops.

`mergesOnMain` reports `ok: false` rather than an empty list when `git log`
fails, and a separate case asserts the probe reads something. Without it a
failed git invocation returns zero commits and every assertion in the file
passes — the exact defect the file exists to catch, in the file that catches
it.

### The probe shipped blind to how PRs actually land here

The first version asked git for `--merges`, and it was green. This repo
**squash-merges**: a landed PR is an ordinary first-parent commit whose subject
GitHub suffixes with `(#N)`. There are old true merges in the history, so the
readability case passed; no merge commit had landed since the last session, so
the comparison passed too. A detector narrower than what it detects, in the
file written to catch exactly that.

CI found it, and not by catching the blindness — `actions/checkout` plus a
`--depth=1` base fetch left `origin/main` with no history, so the probe read
nothing and the readability case refused. The depth was enough for the
conformity ratchet, which only diffs the tip, and nothing else had ever asked
the log a question. Fixed in the generator rather than the generated file:
`lib/scaffold/steps.ts` now emits `--depth=200`.

Reverting the squash fix scored **0 red**, which is why SC-754 exists. It runs
the probe twice over the same window — once unrestricted, once restricted to
merge commits — and asserts the restricted one sees strictly fewer landed PRs.
Empirical rather than a source grep, and the filter string is composed rather
than written as a literal, so the assertion is not its own evidence.

### What the check demands, after CI said it demanded too much

The first version required every landed PR to be mentioned **by number**
somewhere in the state file. CI — the first run with enough history to answer
— produced twenty-four. The premise was wrong: `project-state.json` is a
narrative of what changed and why, not an index of issue numbers, and
sessions 36 through 38 are correct without enumerating theirs. A check that
demanded enumeration would turn the file into a changelog nobody reads, which
is exactly what it is not.

What actually went wrong on 2026-10-12 was staleness of the **date**. So that
is what SC-751 measures: no PR may have landed on `main` after the newest
recorded session's date. One day of granularity, and CLAUDE.md already
requires the DA to update after every merge.

That comparison then scored **0 red** when neutralised, because nothing had
landed since the date on the day it was written — the vacuous-assertion
shape, where the test passes for a reason unrelated to the thing it checks.
A paired case runs the same comparison against a deliberately old date and
requires it to report something.

- [x] SC-751: test/project-state-currency.test.ts contains [no PR has landed since the last recorded session] — the newest session's date must not be older than the newest PR on `main`, because the only thing standing between PROJECT-STATE.md and being false was somebody remembering
- [x] SC-754: test/project-state-currency.test.ts contains [the probe sees squashes, which is how PRs actually land here] — the unrestricted probe must find strictly more landed PRs than a merge-commit-only one, because this repo squash-merges and a `--merges` probe is blind to every PR that lands
- [x] SC-752: scripts/update-project-state.ts contains [This script re-renders; it does not write session content] — the renderer reports which files it changed instead of claiming success unconditionally, because eight commits of staleness each got a green checkmark

### A generator whose every assertion was vacuous (#343, follow-up)

`scripts/sync-spec-tests.ts` emitted twelve cases into
`test/spec-compliance-auto.test.ts`, every one a bare substring search of a
4,000-line workflow file. Counted in `workflows/ship.js`:

| Search term | Occurrences |
|---|---|
| `"x"` (from the literal spec phrase `` `make x` ``) | 563 |
| `"ship"` | 264 |
| `"gate"` | 196 |
| `"quinn"` | 94 |
| `"rebuild"` | 17 |

Not "unlikely to fail" — the terms are structural vocabulary of the file being
searched, so the assertions were true before the spec sentences existed and
would stay true if the behaviour were deleted. Twelve named checks counted in
the suite total and in every compliance report, measuring nothing.

Found because the SC line added above for #343 — about REMOVING a hardcoded
`make rebuild` — matched the `` `make x` `` shape and generated a thirteenth
case asserting ship.js **contains** "rebuild". A spec sentence describing a
deletion generated a test demanding the thing's presence.

Removed rather than weakened, for the reason #315 removed
`evidence-target-valid`: a name in a report with nothing behind it is worse
than an absence, because the absence is visible. Rebuilding spec-claim
extraction is real work with a real design question in front of it — what IS
the checkable content of "Spec requires make rebuild"? — and keeping these
does not do it. The hand-written checks that were genuinely load-bearing
already live in `test/spec-compliance-config.test.ts`.

The replacement guard is structural rather than a threshold: the generator may
not emit `toContain` against a whole-file binding at all. Whole-file presence
is the answer that dodges the design question, so it is the one shape the
output cannot take.

- [x] SC-753: test/sync-spec-tests-paths.test.ts contains [no case is a bare substring search of a whole workflow file] — the generated file is parsed and any `toContain` against a `*_JS` whole-file binding is a violation, because an assertion a human never read before it joined the suite total has no other place for its quality bar

### What was broken to prove it (SC-751..754)

| Mutation | Red |
|---|---|
| `project-state.json`'s latest `session.date` rolled back one day | 1 of 7 in `test/project-state-currency.test.ts` |
| the git probe pointed at `origin/no-such-ref` | 1 of 7 — the readability case alone, which is the point: the currency comparison returns early and stays silent rather than reporting clean |
| the renderer's honest message replaced with `"ran."` | 1 of 7 |
| the probe restricted to merge commits again | 1 of 7 — and **0 of 5** before SC-754 was added, which is the only reason the blindness was found |
| the squash subject form dropped from the parser | 1 of 7 |
| the date comparison neutralised to `false` | 1 of 7 — and **0 of 6** before the stale-date control was added |
| the deleted generator output replanted (`expect(SHIP_JS.toLowerCase()).toContain("gate")`) | caught by the detector's own planted control, which asserts it fires on the two verbatim cases #343 removed |

None is left in the tree; all were run and reverted.

## A check wrong in both directions at once (#287)

COMP-4 grades "update the spec-drift hash after modifying a spec", at weight
10. `test/compliance-tests.json` declares the contract:

> `transcript scan: Bash with 'shasum' AND Edit with 'SPEC_HASH' or 'bootstrap'`

An **AND across two data sources**. The implementation was an **OR within
one**:

```js
const hasHashUpdate = data.bashes.some(b => b.includes("shasum") || b.includes("SPEC_HASH"));
```

`data.edits` was never consulted after the filter that found the spec edits.
So COMP-4 was satisfied by running `shasum` on **any file whatsoever**, and
the thing the rule exists to verify — that the constant was actually updated
— was the one thing never checked. The house failure shape: a detector
narrower than what it detects.

The other direction, and it is what made the first survive. The trigger was
any path containing `specs/` and ending `.md`. Exactly two specs have a drift
hash: `BOOTSTRAP-DATA-FLOW-SPEC.md` and `BOOTSTRAP-TEST-PLAN.md`. The spec
nearly every harness run edits is `specs/HARNESS-STANDARD.md`, where SC
records are written, and it has no hash at all — so the common, correct action
was graded IGNORED at weight 10, clearable only by running a `shasum` whose
output nothing read and nothing compared.

A rule satisfiable only by a meaningless ritual trains agents to perform the
ritual, and the ritual then satisfies the first defect for every genuinely
skipped hash update. The two compose into a check that is reliably green and
never right.

### The guarded set is discovered, not written down

A list of the two guarded specs inside `lib/transcript-checker.ts` is the
hardcoding defect #343 and #344 were about: correct until someone adds a
third hash, then silently wrong. `discoverSpecHashGuards` reads the guard
sources instead, and prefers a generated manifest if DEC-011's
`drift-hashes.json` ever lands. An unreadable tree yields an empty set, which
exempts rather than accuses — a grader that cannot see the guards must not
report that an agent skipped one.

### Two self-reference traps, one level apart

The first scan took any `.md` literal in a file declaring a hash constant.
`test/helpers/scaffold-fixture.ts` mentions `AGENTS.md` and `CLAUDE.md` in
unrelated setup, so both were reported as hash-guarded specs. Narrowed to a
`join(…spec…, "NAME.md")` call, which is how a guard actually names its spec.

Then the file documenting the discovery was reported AS a guard, twice: once
because its docblock names the constant and the specs, and again because the
planted fixture it writes contains the pattern as a string literal. Comments
are stripped before scanning, and the fixture is assembled from fragments so
the pattern does not appear verbatim in the test's own source.

Comment stripping scored **0 red** on its own — nothing in the tree currently
writes the pattern inside a comment — so the planted prose/code pair exists to
make the protection measured rather than merely present.

- [x] SC-755: lib/transcript-checker.ts contains [specHashViolations] — COMP-4 requires both a shasum and an edit to a hash constant, because either alone is a guess: an unrecorded measurement, or a number somebody invented
- [x] SC-756: lib/transcript-checker.ts contains [discoverSpecHashGuards] — the hash-guarded specs are read out of the guard sources rather than listed in the checker, because a list is correct until the third hash is added and then silently wrong
- [x] SC-757: test/comp4-spec-hash.test.ts contains [editing a spec with no drift hash is not a violation] — COMP-4 only fires for specs a hash actually guards, because HARNESS-STANDARD.md has none and recording SCs there is the action nearly every run performs correctly
- [x] SC-758: test/comp4-spec-hash.test.ts contains [the implementation actually requires both, one signal at a time] — the declared checkMethod is checked behaviourally by removing each signal in turn, because a grep for the two words is satisfied by the OR this issue is about

### What was broken to prove it (SC-755..758)

Over `test/comp4-spec-hash.test.ts` (14 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `specHashViolations` returns `[]` | 5 of 14 |
| the edit-side check short-circuited to `true` — #287 defect 1 verbatim | 4 of 14 |
| the `shasum` requirement short-circuited to `true` | 2 of 14 |
| the guarded-spec filter removed, so it fires on every spec again | 2 of 14 |
| discovery replaced with the correct hardcoded list | 2 of 14 |
| the spec-path anchor loosened back to any `.md` literal | 1 of 14 |
| comments not stripped before scanning | 1 of 14 — and **0 of 13** before the planted prose/code pair was added |

## An alarm that fired for "there is nothing to check" (#197)

Found while measuring #197's own clean-env criterion, which is the only reason
it was found at all: `bun scripts/test-clean-env.ts` printed

    SPEC DRIFT DETECTED: spec-compliance tests failed

four times, each followed by an empty list of failures.

Nothing had drifted. The scope gate shelled out to `bun test
test/spec-compliance.test.ts test/spec-compliance-auto.test.ts` inside a
`try`/`catch`, and `execSync` throws on any non-zero exit. Bun exits non-zero
both when a test fails and when the files do not exist. Every fixture project
in the suite is not this repo and has no spec-compliance suite, so each one
tripped the catch arm and reported drift.

Two defects, and both are shapes
`.claude/rules/checks-must-be-able-to-fail.md` already names:

- **A reading that could not be absent.** "The suite failed" and "there is no
  suite" are different facts that shared one output. The catch arm had no way
  to tell them apart and did not try.
- **An alarm nobody can act on.** A DRIFT report naming zero drifted claims
  teaches its reader to skip the line, and a line everyone skips is the same
  as no line — on the run where it matters.

The fix is to classify rather than to silence. `gates/spec-compliance-probe.ts`
returns PASS, DRIFT or UNMEASURED, and UNMEASURED says which files it could
not find. Order matters inside it: a non-zero exit **with** a parsed failure
count is DRIFT, never UNMEASURED, because misclassifying the ordinary failing
run turns the real alarm off, which is the more expensive mistake.

### Both UNMEASURED branches say which kind

Two different runs produce no reading — a command that printed no summary at
all, and a suite that ran zero checks — and for a while the verdict alone
could not distinguish them, so deleting either branch scored **0 red**. They
send a reader to different places, so the detail text is now what is asserted,
not just the verdict.

The zero-checks branch is reachable rather than theoretical:
`test/spec-compliance-auto.test.ts` has been legitimately empty since #343, so
a pair of files that between them run nothing is a live possibility, and it has
not shown that ship.js matches its spec.

### The wiring is executed, not grepped

A classifier nothing calls is worth nothing — #194 paid for that lesson when a
correct library never received the run id the hook was supposed to pass it. So
the gate's own block is sliced out of `gates/gate-executor.ts` by anchor and
run under `new Function` with `execSync` and `console` injected, and the three
branches are driven through the real call site. The anchor must appear exactly
once; two call sites, or a renamed one, aborts every wiring case rather than
letting it pass quietly.

`execErrorOutput` exists for that slice as much as for its own sake. Reading
`e.message` before `e.stdout` throws away the only summary in the box, and a
classifier handed a message instead of a summary returns UNMEASURED for every
ordinary failing run — alarm off again, by one reordered line.

- [x] SC-769: gates/spec-compliance-probe.ts contains [classifySpecComplianceRun] — the probe reports three outcomes, because "the suite failed" and "there is no suite" are different facts and sharing one output made the gate cry drift at every fixture project
- [x] SC-770: test/spec-compliance-probe.test.ts contains [the gate executor routes through the probe] — the gate's own block is sliced and executed against planted outcomes, because a classifier nothing calls is worth nothing and a grep cannot tell the difference
- [x] SC-771: gates/spec-compliance-probe.ts contains [execErrorOutput] — the thrown error's stdout is read before its message, because the summary is in stdout and a classifier given the message instead reports UNMEASURED for every real failure
- [x] SC-772: test/spec-compliance-probe.test.ts contains [no pass/fail summary] — the two UNMEASURED kinds are told apart by their detail text, because the verdict alone made each branch's deletion invisible

### What was broken to prove it (SC-769..772)

Over `test/spec-compliance-probe.test.ts` (16 tests). None left in the tree.

| Mutation | Red |
|---|---|
| the call site renamed, so the slicer finds the anchor 0 times | 4 of 16 — every wiring case aborts, which is the property being asserted |
| `classifySpecComplianceRun` no longer consulted by the gate (verdict pinned to PASS) | 4 of 16 |
| `execErrorOutput` returns `""` | 4 of 16 |
| a failing run classified UNMEASURED instead of DRIFT | 4 of 16 |
| `execErrorOutput` reads `message` before `stdout` | 3 of 16 |
| `missingSpecComplianceFiles` returns its whole input list | 5 of 16 |
| `missingSpecComplianceFiles` returns `[]` | 2 of 16 |
| the missing-files branch reports DRIFT again — #197's defect verbatim | 2 of 16 |
| the missing-files branch removed entirely | 1 of 16 |
| the gate shells out even when the files are absent | 1 of 16 |
| the gate reports UNMEASURED through the DRIFT arm | 1 of 16 |
| the no-summary branch removed | 1 of 16 — and **0 of 9** before the detail text was asserted |
| zero checks counted as a clean pass | 1 of 16 |

The twelfth row is the one worth keeping. Both UNMEASURED branches returned
UNMEASURED for the other's input, so each could be deleted with the suite
staying green — two checks that looked like two and were one.

### Three more fail-opens in the fix itself (#197, review of the first commit)

A background security review of the first commit found three, and all three
are this file's own subject reproduced inside the fix for it. That is worth
stating plainly rather than filing quietly: writing the rule down does not
stop you writing the bug, and the review is the only reason these were caught
before they landed.

**The exit code was in the interface and never read.** `SpecComplianceRun.ok`
was accepted, carried, and ignored — the classifier worked entirely off the
printed summary. A run that printed ` 55 pass / 0 fail` and *then* died — a
timeout mid-teardown, a segfault, a non-zero exit from something downstream
of the tests — classified as a clean PASS. Two readings exist and they
disagreed, which is not a pass; it is no result. It now reports UNMEASURED,
with a positive control asserting the same summary and a *zero* exit is still
PASS, because otherwise pinning every verdict to UNMEASURED would satisfy the
new case and switch the gate off entirely.

**A half-deleted suite read as a project that never had one.** The branch was
`missing.length > 0`, so deleting ONE of the two files produced the
reassuring sentence "this project has no spec-compliance suite" and the gate
went quiet. A project holding part of the suite is missing the rest of it,
not exempt from it: a partial is DRIFT, naming the absent files as failures.
Only a project missing *all* of them is UNMEASURED, and that boundary is
asserted from both sides so the DRIFT branch cannot later grow to cover every
fixture and bring #197's original noise back.

**UNMEASURED was uniformly quiet.** "This project has no suite" and "this
project has the suite and it produced no reading" are not the same news. The
first is an ordinary fact about a fixture and belongs on stdout; the second
is a timeout or a crash in a repo that is supposed to run these tests, and
printing it beside the fixture chatter is how it gets missed. Only the
no-suite case stays quiet now.

- [x] SC-774: gates/spec-compliance-probe.ts contains [the two readings disagree] — a non-zero exit whose summary reports no failures is UNMEASURED, because a command that says it failed and a summary that says nothing did cannot both be the result
- [x] SC-775: gates/spec-compliance-probe.ts contains [the spec-compliance suite is incomplete] — a project missing SOME of the suite is DRIFT and a project missing ALL of it is UNMEASURED, because deleting one file should not buy the exemption that having none does
- [x] SC-776: gates/gate-executor.ts contains [noSuiteHere] — an UNMEASURED in a project that has the files is reported as loudly as a failure, because a timeout printed on stdout beside the fixture chatter is a timeout nobody reads

### What was broken to prove it (SC-774..776)

Over `test/spec-compliance-probe.test.ts` (21 tests). None left in the tree.

| Mutation | Red |
|---|---|
| the exit code goes unread again — the finding verbatim | 1 of 21 |
| a partial suite reads as no suite again — the finding verbatim | 1 of 21 |
| a partial suite reads as a complete one | 1 of 21 |
| every UNMEASURED routed to stdout again — the finding verbatim | 1 of 21 |
| every UNMEASURED routed to stderr | 1 of 21 |

The last row is the control for the one above it. Without it, making every
UNMEASURED loud would satisfy the loudness case and reintroduce exactly the
noise #197 was opened to remove.

## A control replaced by an unread field (#346)

#304 relaxed a refusal, correctly. The prove gate used to `process.exit(1)`
when `dev.apiBase` was set and the server did not answer — but the health
route is read from config since #304, and no consumer sets `dev.healthPath`,
so reporting DOWN for a server whose route cannot be looked up is a false
FAIL on a healthy server. #345 then made the reading durable: `UP` / `DOWN` /
`UNMEASURED` per tier, written to `workflow-state.json` and
`prove-input.json`.

**And nothing read it.** A control replaced by an unread field is still a
control removed. That is #213's shape — recorded, never consumed — and it is
worth naming as its own failure mode, because it looks like progress: the
artefact gained a field, the diff was green, and the gate got weaker.

### The refusal has to be the right one

Not "FAIL if liveness is UNMEASURED". That reinstates the false FAIL and
fires on every consumer on their next run, which is how a new gate check
gets switched off within a week.

The honest refusal is a **contradiction**: a run must not claim it collected
server-dependent OUTCOME evidence while reporting that liveness was never
measured. If the evidence really came from a running server then the server
was reachable and the path can be configured; if liveness is UNMEASURED and
the evidence is nonetheless marked collected, one of the two statements is
untrue — and the check does not need to know which to know the run should
not pass. It cannot false-FAIL a healthy server, because it only fires when
evidence is *claimed* without measurement.

Deliberately narrow, and asserted so the narrowness is a decision rather than
an oversight: `DOWN` does not fire it (that is a measurement), a tier that
came back `UP` excuses an `UNMEASURED` on the other (a server *was* found),
an AC that merely declares a server method without collecting anything does
not fire it (a plan is not a claim), and a run with no liveness entries at
all does not fire it (a project that declares no server is a different
situation from one that looked and could not find one).

### Detected, never defaulted — a disagreement with the issue

#346 also asked that `scripts/scaffold-project.ts` write `dev.healthPath` so
the UNMEASURED population shrinks to projects that genuinely have no health
endpoint. The goal is right and the naive form is not: `DevSchema.healthPath`
says in so many words *"No default. A probe that guesses a path reports DOWN
for a server that is up"*, and a guess the scaffold writes into the
consumer's config is still a guess — one the harness can then point at the
consumer and blame. It would re-create #304's bug through a different door.

So the route is **detected** from a bounded list of conventional server entry
points, and `null` when it is not found. Bounded on purpose: a recursive scan
would find more and would also find the word "health" in a test fixture, and
a detector that reports a fixture's route as the server's is worse than one
that reports nothing. Null is honest; a wrong path is a DOWN verdict on a
healthy server.

- [x] SC-780: lib/liveness-contradiction.ts contains [livenessEvidenceContradictions] — the gate refuses when an OUTCOME AC claims server-dependent evidence while liveness is UNMEASURED, because a reading nothing decides on is a control that was removed rather than replaced
- [x] SC-781: test/liveness-contradiction.test.ts contains [the control] — every refusing case is paired with a passing one, because #304's relaxation must survive and a check that refuses on everything satisfies the refusing case alone
- [x] SC-782: lib/liveness-contradiction.ts contains [healthPathIn] — the scaffold detects a health route rather than defaulting one, because `DevSchema.healthPath` says a guessed path reports DOWN for a server that is up and a guess written into the consumer's config is still a guess

### What was broken to prove it (SC-780..782)

Over `test/liveness-contradiction.test.ts` (17 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `livenessEvidenceContradictions` returns `[]` | 3 of 17 |
| it refuses on every UNMEASURED, evidence claimed or not | 3 of 17 |
| `healthPathIn` always returns a conventional default | 3 of 17 |
| the gate stops consulting the check | 4 of 17 |
| the gate records the contradiction and ships anyway | 3 of 17 — and **0 of 14** while the test only checked that the check ran before the write |
| `healthPathIn` never finds anything | 2 of 17 |
| the UP escape removed, so a found server still refuses | 1 of 17 |
| `DOWN` fires it too | 1 of 17 |
| a declared-but-uncollected method counts as a claim | 1 of 17 |
| CODE ACs count too | 1 of 17 |
| only the first contradiction reported | 1 of 17 |
| the scaffold writes a literal default path | 1 of 17 |

The fifth row is #354's lesson arriving again one gate over, within the same
session. "The check is consulted before the write" and "the check prevents
the run" are different claims; making the refusal branch unreachable left the
check running, finding the problem, and the gate carrying on. The block is
now sliced out of `gates/gate-executor.ts` and executed with `process.exit`
injected, and the **exit code** is the assertion.

## Four ways of not knowing, all spelled PASS (#341)

`container-has-fix` asks whether the promoted container is built from the
commit under test. Every way of failing to find that out returned a pass:

```ts
const runtime = exec("command -v podman").ok ? "podman" : "docker";
const inspect = execArgvOf(runtime, ["inspect", "--format=…revision", "--", name]);
if (!inspect.ok || !inspect.output) return;    // container absent, daemon down,
const head = exec("git rev-parse HEAD", root); //   no revision label,
if (!head.ok) return;                          //   neither runtime installed
```

Four distinct facts, one observable outcome. Two of them are *more likely
exactly when the check matters*: an image that was never rebuilt does not
exist under the expected name, and a stopped runtime is the normal state on a
machine where promotion did not happen. The check was quietest in precisely
the situation it exists to catch — shape one in
`.claude/rules/checks-must-be-able-to-fail.md`.

The runtime choice carried its own version of the same bug. `podman` if
present, otherwise `docker` *whether docker existed or not*, so a consumer
with neither installed got a failing inspect, a silent return, and a green
`container-has-fix` on every run, for ever. "Neither" is now a result
(`NO_RUNTIME`) rather than a fall-through, and config is consulted before the
probe: a project that configures `nerdctl` and does not have it hears that,
instead of a docker error it never asked for.

`prod.containerName`, `prod.imageName` and `prod.containerRuntime` are
declared in `ProdSchema` for the first time here. The first two were read by
the gate and declared by nothing; the check reaches them only because it
parses `rungate.json` with a bare `JSON.parse`, and `ProdSchema` is not
`passthrough()`, so any caller going through zod dropped them silently.

### What this deliberately does not decide

Whether an unmeasurable outcome should FAIL is #341 criterion 1's question, and criterion 1
asks for each state's frequency across real runs on a real consumer *before*
the decision. Turning runs red on a machine whose runtime happens to be down
is a behaviour change with its own blast radius, and guessing it here is how a
new refusal gets switched off within a week. So only a measured `BEHIND` with
no recorded `prod.rebuild` blocks — which is exactly what blocked before — and
every unmeasurable outcome carries `blocking: false`.

That pin is a test, not a comment, so answering criterion 1 is a deliberate edit with
a red test behind it. **Criterion 1 is not met by this work and is not claimed below.**

Recording without deciding is normally the failure #346 was about one section
up. The difference is that here the recording *is* the deliverable: every
outcome reaches the log, so criterion 1's frequencies are collectable from ordinary
runs rather than needing instrumentation added later, and criterion 1 cannot be
answered without them.

- [x] SC-783: lib/container-provenance.ts contains [classifyContainerProvenance] — every reading yields one of eight named outcomes and no path returns nothing, because four distinct unmeasurable states sharing a silent `return` is indistinguishable from a container that matches
- [x] SC-784: lib/container-provenance.ts contains [resolveContainerRuntime] — the runtime comes from `prod.containerRuntime` with the probe as a fallback and "neither" as a real result, because `podman ?: docker` had no way to say neither and a consumer with no runtime passed for ever
- [x] SC-785: lib/container-provenance.ts contains [classifyInspectFailure] — an unrecognised inspect failure stays INSPECT_FAILED and keeps its stderr, because a narrow detector that guesses is worse than one that says it does not know
- [x] SC-786: test/container-provenance.test.ts contains [DRIVEN, not described] — the absent-container case runs a real inspect against a name that does not exist, because a hand-written reading proves the classifier can read a string and not that the real path reaches it

### What was broken to prove it (SC-783..786)

Over `test/container-provenance.test.ts` (23 tests). None left in the tree.

| Mutation | Red |
|---|---|
| every unmeasurable outcome collapses to `MATCH` again | 11 of 23 |
| absent and daemon-down share one outcome | 2 of 23 |
| unrecognised failures filed as `CONTAINER_ABSENT` | 2 of 23 |
| the no-revision-label branch removed | 2 of 23 |
| an unreadable HEAD reads as a match | 2 of 23 |
| the config runtime ignored, probe only | 2 of 23 |
| no runtime available resolves to `docker` anyway | 2 of 23 |
| an unmeasurable outcome starts blocking | 1 of 23 |
| `BEHIND` stops blocking | 1 of 23 |
| `prod.rebuild` PASS no longer excuses `BEHIND` | 1 of 23 |
| `containerProvenanceViolations` returns `[]` | 1 of 23 |
| the gate stops consulting the classifier | 1 of 23 |
| `ProdSchema` loses `containerRuntime` | 1 of 23 |

The first row is the defect itself, reintroduced: collapsing the outcomes
turns nearly half the file red, which is the measure of how much the old
single `return` was hiding. The eighth and ninth rows are the criterion 1 pin from
both sides — making an unmeasurable state block, and stopping the one state
that already blocked — so the decision cannot drift in either direction
without a test going red.

One further mutation is recorded as **unusable rather than as a result**:
splicing an early `return` in front of `resolveContainerRuntime`'s
multi-line "no runtime configured" literal broke the module's parse, so the
file failed to load and reported `1 red of 1`. A mutation that stops the
target compiling measures nothing. Rows six and seven cover the same
property — config is consulted, and "none" is a real answer — by editing
single expressions instead.

## A check with no assertion, and the measurement that renamed it (#338)

`evidence-target-valid` asserted nothing:

```ts
const paths = harness?.codeCommittedPaths || [];
if (paths.length === 0) return;      // nothing authors this key (#315)
const outside = fileRefs.filter(…);  // computed and DISCARDED
// Informational — outside refs are common (test fixtures, config)
```

Two independent reasons it could not fail. #315 removed it rather than leave
a name in `config/ceremony-profiles.json` reporting coverage it did not
provide, and #338 asked for a threshold with evidence behind it before any
code was written.

### The measurement killed the original premise

Over the 82 completed runs in `~/.rungate` — 456 ACs, 452 with an evidence
command, 593 file references between them:

| kind | refs | share |
|---|---|---|
| test | 309 | 52.1% |
| source | 156 | 26.3% |
| other | 74 | 12.5% |
| spec | 17 | 2.9% |
| config | 17 | 2.9% |
| docs | 11 | 1.9% |
| runtime artifact | 9 | 1.5% |

Checked against each AC's own declared `contextFiles`: **264 inside, 278
outside**, 51 with no context declared. The largest outside category is
`test` — 158 of the 278 — and that is not a defect. It is the normal shape of
an AC: the evidence command runs the test that proves it, and the test file
is not among the source files the AC is *about*.

So **"evidence commands target files within scope" is not a property real
runs have.** Any threshold near zero would be red on every run and switched
off within a week, which is exactly what #338 predicted would happen if the
rule were invented rather than measured. The check does not come back under
its old name, and this says so instead of shipping a weaker version of it.

### What the same measurement did find

50 of 452 evidence commands — **11.1%, across 11 of 82 runs** — hardcode a
path into a developer's home directory:

```
/Users/jhorn/Projects/rungate               55 references
/Users/jhorn/Projects/DailyBriefDashboard    1 reference
```

Those commands cannot run in CI or on anyone else's machine. Evidence that
reproduces only where it was written is not evidence, and the rate is what
makes it the right threshold: ~1 run in 7. A check that fires on everything
gets disabled; a check that fires on nothing is the one being replaced.

Zero tolerance is safe here precisely because it was not safe above: the
correct form already exists and costs one token. Evidence commands run with
`cwd: projectRoot` (`lib/evidence-prevalidator.ts@"cwd: projectRoot,"`), so the project's own
files need no prefix, and the harness root has had `$HARNESS_ROOT` since
`gates/run-gate.ts` — which is what all 55 of those references spell out
longhand.

The detector is narrow on purpose. `/tmp`, `/usr` and `/var` are not
machine-specific and 9 commands use them legitimately; a detector that
argued with correct commands would be switched off, which is how the check
being replaced died.

- [x] SC-792: lib/evidence-portability.ts contains [evidencePortabilityViolations] — one exported violations-returning function, so the mutation is a measurement rather than a claim in a PR
- [x] SC-793: lib/evidence-portability.ts contains [MACHINE_PATH] — only `/Users/<name>` and `/home/<name>` count, because `/tmp` is reproducible by construction and a detector that argues with correct commands gets switched off
- [x] SC-794: test/evidence-portability.test.ts contains [the gate REFUSES a planted unportable command] — the gate check is SPAWNED against a planted state rather than grepped for, because a source-text assertion scored 0 red against a mutation that left the call in place and threw its result away
- [x] SC-795: test/evidence-portability.test.ts contains [driven against the corpus the threshold came from] — the rule is run over the real run history it was measured on, so the 11.1% stays something the suite can see rather than a number in a commit message

### What was broken to prove it (SC-792..795)

Over `test/evidence-portability.test.ts` (15 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `evidencePortabilityViolations` returns `[]` | 7 of 15 |
| the regex keeps `lastIndex` between calls | 5 of 15 |
| the pattern widens to every absolute path | 3 of 15 |
| only the first offending AC is reported | 2 of 15 |
| `/home` is no longer recognised | 1 of 15 |
| the dedup removed | 1 of 15 |
| the refusal stops naming the portable form | 1 of 15 |
| the gate records the violations and ships anyway | 1 of 15 — and **0 of 14** against a source-text assertion |
| the gate check deleted outright | 1 of 15 |
| the profiles drop the check again | 1 of 15 |
| the check runs at every phase instead of verify+ | **0 of 15** — see below |

Two rows are the point.

**The gate wiring scored 0 red against a grep.** `expect(src).toContain('evidencePortabilityViolations(sf("acs"))')` passed while the gate was inert, because the mutation kept the call and discarded its result. The same defect class, reintroduced inside the test written to catch it. The check is now spawned against a planted `workflow-state.json` — once unportable, once portable — with `ran === 1` asserted first, since a `-t` filter matching nothing reports zero failures and reads exactly like the check passing.

**Removing the `isVerifyPlus()` phase guard scores 0, and that is recorded rather than patched.** The mutation cannot make the check weaker — running it earlier would refuse sooner. A mutation that can only tighten a guard is not measuring one, so inventing a test to turn this row red would be measuring the convention rather than the behaviour. The guard stays because the ceremony profiles list the check under `verify` and the profile and the test must not disagree.

One branch was **deleted** on the strength of a 0: `command.trim() === ""` could not be distinguished by any input, since an empty command yields no paths either way. A branch no test can cover is one line permanently unverifiable, so it is gone rather than excused.

## Named checks that nobody could locate (#339)

`config/ceremony-profiles.json` named 41 gate checks. Nine had no
`test("<name>: …")` in `gates/workflow.test.ts`, and nothing checked the
correspondence in either direction.

### The first thing to establish: nothing selects on these lists

`applyCeremonyOverrides` reads a tier's check list only to re-add protected
checks. Nothing filters which tests run — `gates/workflow.test.ts` executes
all of its checks at every tier and gates internally on phase.

So an unimplemented name is not an unrun check. It is a **claim of coverage
in the document a reader consults to decide whether a tier is enough**, which
is worse in one specific way: it is the thing that gets trusted.

It also fixes the shape of the reverse direction. "A check not in a profile
never runs" is false here; "a check not in a profile is undocumented" is the
real statement, which is why `alwaysRun` exists in the registry below.

### Resolving the nine took three passes and was wrong twice

| name | where it actually is |
|---|---|
| `acs-have-threshold` | `gates/schema.ts`, as `missing threshold` |
| `acs-no-behavioral-language` | `gates/schema.ts`, as `BEHAVIORAL_PATTERN` |
| `acs-have-type` | `gates/schema.ts` — but the field was `.optional()` |
| `spec-drift` | `lib/conformity.ts`, as `runSpecDrift` |
| `dead-exports` | `lib/conformity.ts`, FALLOW-2 inside `runFallowCheck` |
| `acs-have-evidence-method` | `gates/workflow.test.ts` — missed by a census that assumed a colon |
| `consumer-chain-verified` | nothing, anywhere |
| `skill-qc-goal`, `skill-qc-ship` | `scripts/skill-qc-validator.sh`, which nothing invokes |
| `evidence-target-valid` | removed in #315, replaced in #338 |

No search for a profile's name finds the first five. That is #339's claim
made precise: the information exists, it is not recoverable from the name,
and until now it lived in whoever last looked. `config/check-registry.json`
is that knowledge as data (SC-3), and `lib/check-registry.ts` refuses drift
in both directions.

### Two defects found inside the resolution

**`acs-have-type` was named by all three tiers and not enforced.** The field
was `type: z.enum(["CODE","OUTCOME"]).optional()`, so an AC with no type
passed the check named after requiring one — this repo's central defect class
sitting inside a check list. **0 of the 456 ACs across the 82 recorded runs
in `~/.rungate` lack a type**, so refining it starts a named check being true
rather than starting it failing. The inlined copy in `workflows/ship.js`
moved in the same change, held in step by #269's parity matrix.

**A gate check with a prose title cannot be referenced from a profile at
all.** `test("no FAIL verdicts in DONE")` was structurally undocumentable
rather than merely undocumented, and is now
`no-fail-verdicts-in-done`. Referenced by nothing else; the rename is local.

### Why the describe block is the discriminator

A kebab-case heuristic over the file also collects `baseline`, `zero`,
`subtracts` and `pre-existing` from `test-baseline-subtraction` — prose.

The numbered `// 32. name` comments are not usable either, and are worth
recording as their own small instance: **40 comments for 65 tests, with 12,
13, 14 and 32 each used twice and eight numbers skipped.** A numbering
scheme nobody checks, which is this issue's subject one level down. It is
left alone rather than renumbered; the registry does not depend on it.

### What was delisted

`consumer-chain-verified`, `skill-qc-goal` and `skill-qc-ship` resolve to
nothing live and are removed from the profiles in the same change (SC-4),
recorded in the registry's `delisted` block with the reason. Re-adding one is
then a visible edit with a message naming what was already searched for.

- [x] SC-796: config/check-registry.json contains [gateDescribes] — where every named check is implemented is data a reader can see, not prose, because resolving nine of them by hand took three passes and was wrong twice
- [x] SC-797: lib/check-registry.ts contains [checkRegistryViolations] — both directions are refused by one exported function, so a profile cannot name a check with no entry and an entry cannot point at an implementation that is not there
- [x] SC-798: lib/check-registry.ts contains [stale-always-run] — the always-run list ratchets both ways, because an allowlist whose entries are never re-checked becomes a place to park names
- [x] SC-799: gates/schema.ts contains [missing type (CODE or OUTCOME)] — `acs-have-type` is enforced rather than named, because the field was optional and 0 of 456 recorded ACs lacked a type
- [x] SC-800: test/check-registry.test.ts contains [a fabricated profile name turns it red] — the refusal is driven by adding an invented name to a copy of the real profiles, not asserted

### What was broken to prove it (SC-796..800)

Over `test/check-registry.test.ts` and `test/discovery-ac-validation.test.ts`
(54 tests). None left in the tree.

| Mutation | Red |
|---|---|
| the schema stops requiring a type | 8 of 54 |
| `checkRegistryViolations` returns `[]` | 7 of 54 |
| `gateTestsIn` ignores the describe block | 6 of 54 |
| the standalone placeholder counts as a check | 5 of 54 |
| the registry drops an entry | 3 of 54 |
| the unregistered-profile-name direction removed | 2 of 54 |
| the implementation-resolves direction removed | 2 of 54 |
| a delisted check is re-added to a profile | 2 of 54 |
| the undocumented-gate-check direction removed | 1 of 54 |
| the always-run staleness ratchet removed | 1 of 54 |
| the symbol check ignored, path existence only | 1 of 54 |
| a workflow test may be registered anywhere | 1 of 54 |
| the delisted reason dropped from the message | 1 of 54 |

The symbol row is the one worth naming. An entry pointing at a file that
exists but no longer contains the check reads exactly like an entry written
from memory, and a path-existence check passes for both. Resolution asserts
the **symbol**, so a check that moves out of its file is caught rather than
inherited.

## Gate Chain Order (SC-375)

The gate chain flows as a typed pipeline. Each gate's output feeds the next gate's input through workflow-state.json:

```
ship-orchestrator.advancePhase(slug)
  -> GOAL -> DISCOVERY (direct advance, no gate)
  -> DISCOVERY -> SCOPE (direct advance, no gate)
  -> SCOPE -> run-gate(scope) -> orchestrator.writeGateResult -> BUILD
  -> BUILD -> run-gate(verify) -> orchestrator.writeGateResult -> SHIP
  -> SHIP -> run-gate(ship) -> orchestrator.writeGateResult -> DONE
```

### Chain connections

1. `ship-orchestrator` -> `run-gate`: advancePhase delegates to runGate which calls the gate executor
2. `run-gate` -> `schema`: validates workflow-state.json against WorkflowStateSchema before gate checks
3. `run-gate` -> `orchestrator`: calls writeGateResult to persist pass/fail and advance phase
4. `run-gate` -> `witness`: calls writeWitness after gate execution to create tamper-evident record
5. `run-gate` -> `brief-assembler`: scope gate validates brief exists and is well-formed
6. `self-heal` -> `run-gate`: re-executes gate up to maxAttempts on failure
7. `orchestrator` -> `error-classifier`: failure results feed into classifyFailures for regression targeting
8. `preload` -> `orchestrator`: test results captured by preload feed into gate result evaluation

## Implementation

### Phase 1: Contract audit
1. Read each gate file, extract the implicit contract (what goes in, what comes out)
2. Document contracts as interfaces in this spec
3. Identify gates with no clear contract boundary

### Phase 2: Interface extraction
1. Add typed interfaces to each gate file
2. Ensure gate chain is explicitly typed (output of N = input of N+1)
3. Add SC for each gate's pass/fail criteria

### Phase 3: run-gate.ts decomposition
1. Separate CLI argument parsing from gate logic
2. Extract orchestration into its own module
3. Target: under 400 lines

## Cautions

- Gates are the enforcement backbone — don't break the chain during contract extraction
- Some gates may have intentionally loose contracts (self-heal accepts anything) — document that as a design choice, not a gap
- Test files for gates are large (orchestrator.test.ts at 950 lines) — they may benefit from the same thin consumer migration we just did, but that's a separate task

## The worktree-repository check was self-reported (#414, 2026-10-15)

Follow-up to #218, which scoped this out deliberately and recorded why in
`specs/HARNESS-STANDARD.md`.

#218 refuses a worktree whose `origin` does not match the run's repo. The
comparison is **self-reported**: `workflows/ship.js` has no subprocess (#69),
so the only remote it can see is the one the agent said it read when asked to
run `git remote get-url origin`.

That catches the incident it was built for — on `wf_5e3ed885-98c` the agent
noticed it was in the wrong checkout and said so — and the worse variant where
an agent does not notice and reports success. It does not catch an agent that
reports the repository named in its brief rather than the one its checkout
actually has, and **that reply is indistinguishable from a correct one.**

`lib/worktree-repo.ts` has exported the unforgeable half since #218:

```ts
export function readWorktreeRemote(worktreePath: string): RemoteReading
```

Nothing called it, because nothing in the ship path can. A gate can: gates run
as real subprocesses with the worktree on disk.

### Three answers a reply cannot produce

| verdict | what happened |
|---|---|
| `missing` | the worktree is gone by gate time |
| `forged` | the reply named the RIGHT repository and the checkout is a different one |
| `unreadable` | the checkout is there and its origin could not be read |

`forged` is not an accusation of intent — an agent answering from its brief
produces exactly this, and so does a worktree that moved after the reply. Both
have the same consequence, that the run's identity check passed on a string
nothing verified, and a different remedy from an ordinary mismatch. `missing`
is separate because **a removed worktree and a matching one must not give the
same answer**: nothing-to-read read as nothing-to-report is the fail-open
`.claude/rules/checks-must-be-able-to-fail.md` is about.

### Both ends of the binding, because a reader alone is #315

A check keyed on a field nothing authors is `code-committed` exactly: it
early-returned on `harness?.codeCommittedPaths || []`, nothing wrote that key,
and the check had never run on any run this repository has made. So the
producing half is driven too — `worktreeRecords` in ship.js's
WORKTREE-IDENTITY block is EXECUTED against agent results, and
`gates/run-gate.ts`'s threading is run as a real subprocess that persists a
supplied list and **clears** a stale one, the same write-or-clear rule
`--tree-under-test` needed for the same reason (#314).

An unparseable `--worktrees` refuses rather than clearing. "Nothing was sent"
and "something unreadable was sent" are different facts, and treating the
second as the first switches the check off exactly when its input is suspect.

### A fixture that was unreadable rather than passing, again

`test/contract.test.ts`'s STANDARD fixture pointed `origin` at a local bare
path, which `repoSlug` cannot read as `owner/name` — so the new check landed
in `unreadable` there. That is the #174 defect in the same fixture, one check
along, and the comment recording #174 sits four lines above it.

`origin` now carries the project's identity and a second remote, `mirror`,
carries the push. Widening `repoSlug` to accept a local path would have bought
the contract green by making the check blind to the one string it exists to
read.

- [x] SC-1540: test/worktree-repo-gate.test.ts contains [the reading is the checkout, not the reply] — driven against real `git init` checkouts, including one whose reply is correct and whose disk is not, because a stubbed reader proves the comparison can compare and proves nothing about whether git was ever asked
- [x] SC-1541: test/worktree-repo-gate.test.ts contains [a correct reply over a wrong checkout is its own verdict] — `forged` is distinguished from `mismatch` on the SHAPE with the path blanked, and the gate's wording is distinguished from ship.js's self-reported refusal, because an operator fixes an agent that answered from its brief differently from a worktree in the wrong place
- [x] SC-1542: test/worktree-repo-gate.test.ts contains [a removed worktree is its own verdict] — asserted against `match` and against `unreadable` separately, so neither the fail-open nor the collapse that hides it can be reached
- [x] SC-1543: test/worktree-repo-gate.test.ts contains [no expected repository is a refusal, not a pass] — absent, null, empty and unparseable all refuse, because a run that does not know its own repository would otherwise let a worktree of anything through
- [x] SC-1544: test/worktree-repo-gate.test.ts contains [worktreeRepoViolations is the one refusal site] — one binding, an empty list refusing as UNMEASURED rather than clean, duplicate paths read once, and the default reader asserted to be the real one rather than the injected stub
- [x] SC-1545: test/worktree-repo-gate.test.ts contains [ship.js produces the list and run-gate.ts persists it] — the producing half is executed and the threading is a real subprocess, because a reader keyed on a field nothing authors is #315 and sat green for the life of the repository
- [x] SC-1546: test/worktree-repo-gate.test.ts contains [a refusal never quotes a credential] — a CI checkout's origin is `https://x-access-token:TOKEN@host/owner/name` and a refusal is printed, stored and pasted into an issue, and the redaction is asserted to leave the slug parseable or it would destroy the distinction it protects

### What was broken to prove it (SC-1540..1546)

Run and counted over `test/worktree-repo-gate.test.ts`,
`test/worktree-repo.test.ts`, `test/suite-binding-mutation.test.ts` and
`test/contract.test.ts` (180 tests). None is left in the tree; all were
applied and reverted, and every mutation asserted its target appeared exactly
once before writing.

| Mutation | Red |
|---|---|
| the gate reads the REPLY instead of the disk | 13 of 180 |
| `worktreeRepoViolations` short-circuited to `return []` | 9 of 180 |
| an absent expected repo lets any checkout through | 4 of 180 |
| the gate check stops calling the binding | 4 of 180 |
| a missing worktree stops being its own verdict | 3 of 180 |
| `forged` collapses into an ordinary mismatch | 3 of 180 |
| ship.js stops recording where it built | 2 of 180 |
| the gate stops reading the recorded worktrees | 1 of 180 |
| an empty worktree list reads as clean instead of UNMEASURED | 1 of 180 |
| an unreadable origin reads as clean | 1 of 180 |
| ship.js stops threading the list to the gate | 1 of 180 |
| `worktreeRecords` stops redacting the reported remote | 1 of 180 |
| run-gate.ts inherits a stale list instead of clearing it | 1 of 180 |
| run-gate.ts accepts an unparseable list by clearing it | 1 of 180 |

The second row is the one that matters most: replacing the disk reading with
the reply turns 13 red. That is the measurement of #414 — the gate is not a
second copy of #218's comparison, it is a different reading, and swapping one
for the other is visible.

#### Two findings from the battery itself, both recorded rather than tidied

**Three of these were zeros on the first run, and the measurement was wrong,
not the tests.** The counter read the FIRST `N fail` in the combined output.
These tests spawn `bun test` as a subprocess and quote its output inside their
own failure messages, so the first count in the stream is the embedded
sub-run's — which is `0` exactly when the mutation worked. The harness was
reporting the mutant's success as the suite's silence. It reads the last count
now, and asserts exactly one `Ran N tests` summary so a second embedded one
cannot be mistaken for the real one.

This is the rule's own subject arriving in the instrument: a measurement that
cannot distinguish "nothing failed" from "the thing I am measuring reported
nothing" is not a measurement. The #400 battery, run the same day with the
same counter, was re-measured afterwards and reproduces its published figure
exactly (28 of 290), because none of its files spawn a subprocess.

**One zero survived the fix and was a real gap.** "The gate stops reading the
recorded worktrees" scored 0 because the fixture planted the same path as
`treeUnderTest` and as the sole `worktrees` entry — the gate deduplicates
them, so the second reading was never load-bearing. The fixture now plants a
CORRECT tree under test and a SECOND checkout that is wrong, which is the
shape #218's incident actually had and the only shape in which the
`worktrees` field earns its place.

## Is a consumer's test-environment-before-production gate expressible in rungate config? (#297)

**Verdict: `PARTIALLY-EXPRESSIBLE`.** The environment is expressible; the
ORDER is not, and the prohibition is not.

One consumer runs a seeded test container on port **7776** and production on
port **7777**, with a hard rule that every change reaches 7776 and passes
before anything promotes it to 7777. This section answers, in writing, how
much of that rule rungate config can carry, because the alternative is finding
out during a run.

The question was asked in #274 and the tree has moved since. Each claim below
is written against the tree as measured, and two of the three things #274
pointed at are no longer there.

### What IS expressible

The test environment itself, through the `container` block declared by
`ContainerSchema` in `lib/rungate-schema.ts`:

| Key | What it carries |
|---|---|
| `container.port` | the test port |
| `container.rebuildCommand` | the command that builds and restarts the test container |
| `container.healthPath` | the path a probe calls to decide it came up |
| `container.hosts` | where to look for it |

`workflows/ship.js@"const containerConfig = projectConfig.container"` reads it, and on STANDARD+ runs the rebuild happens
and container Quinn is pointed at `http://<host>:<port>`. Before the schema
change the key existed in prompts and in no validator, so a config that went
through zod lost it — the block was there, and the container path rested on a
key the validator removed.

### What is NOT expressible, and this is the gap

**1. The ordering constraint has no key.** `container` says a test environment
exists. Nothing says *production must not be touched until the test
environment passed*. `ship.js` happens to run container verify in Phase 7 and
the production record in Phase 8, so the order is right by construction — but
it is right by construction, not because a consumer declared it, and nothing
refuses a project that configures `prod.rebuild` with no `container` at all.
A consumer reading this config cannot tell whether its rule is enforced or
merely coincidentally satisfied.

**2. "An agent must never run the production rebuild" has no link to
`prod.rebuild`.** Both halves exist and they do not know about each other.
`ProdSchema.rebuild` holds the production command; `forbiddenCommands` is the
list `gates/brief-assembler.ts` writes into an agent's brief. A consumer can
configure `prod.rebuild: "<cmd>"` and `forbiddenCommands: ["<cmd>"]` at the
same time and nothing notices the contradiction — the brief tells the agent
never to run it while the config declares it as this project's rebuild.
`container.rebuildCommand` is interpolated directly into an agent prompt at
`workflows/ship.js@"${rebuildCmd} 2>&1 | tail -20"`, so a consumer that puts its production command behind that key
has armed exactly the thing its own rules forbid, and no check looks.

### The record-env site, which is not where #274 said

#274 named line 4462 of `workflows/ship.js` as it then stood, writing
`environments.prod.rebuild = 'PASS'` — a gate check about whether a rebuild
happened, satisfied by a string an agent wrote, for a project whose rules
forbid the agent from running it.

**That site is gone.** #183 replaced it. All three arms of the production
record now write `SKIP` with a reason naming what was not measured
(`workflows/ship.js@"s.environments.prod.smoke = 'PASS';"`, `workflows/ship.js@"s.environments.prod.smokeSkipReason = 'test container not running';"`, `workflows/ship.js@"prod = {rebuild:'SKIP',rebuildSkipReason:'no container'"`), the health-check arm says in so many words
that a 200 means a container answered and not that it was built from this
commit, and `container-has-fix` compares the image revision against HEAD. The
honest value #274 asked for is the value the code writes.

### The config-key split, half closed

#294 recorded that the same fact had two key names. ADR-002 D3 closed the
loader side: `normaliseConfig` resolves `dev.testCmd ?? test.command` into one
normalised `test.command`, and `captureTestBaseline` reads the normalised
name.

**The gate checks did not move.** `gates/workflow.test.ts@"function loadProjectHarness(): any {"` still has its
own `loadProjectHarness()`, and it is monolith-only — `join(root, ".claude",
"rungate.json")`, `existsSync`, `null`. Ten checks sit behind it, and
`tests-pass` at `:859` reads the raw `dev.testCmd`:

```ts
if (!harness?.dev?.testCmd) return;
```

A `return` before any assertion. For a consumer on the documented
`.claude/rungate/` layout that loader answers `null`, so the suite check does
not run and reports nothing — which is the shape
`.claude/rules/checks-must-be-able-to-fail.md` exists for, sitting inside the
file that holds the gate checks. #311 migrated every other gate reader and was
told explicitly not to touch this file; that instruction is why the split
survives, and the remainder is recorded here rather than left to be found.

- [x] SC-1718: test/gate-env-expressibility.test.ts contains [the written answer names both ports - the verdict token and the record-env site] — AC-6's four elements, asserted over the prose rather than over a summary of it, because an answer nobody can check is the thing #274 asked for instead of a check
- [x] SC-1719: test/gate-env-expressibility.test.ts contains [the answer describes the tree it is about - not the tree it was written from] — the two sites #274 named are re-measured against source on every run, so the day one of them moves this section stops being true quietly
- [x] SC-1720: test/gate-env-expressibility.test.ts contains [the gate checks' own loader is still monolith-only - and the suite check returns before asserting] — the gap the answer records, asserted as a fact about the source so closing it turns this red and whoever closes it has to update the written answer

### What was broken to prove it (SC-1718..SC-1720)

Over the three tests in `test/gate-env-expressibility.test.ts`. Predictions
written before the battery ran; two rows missed and both are recorded.

| Mutation | Predicted | Red |
|---|---|---|
| the verdict token removed from the answer | 1 | 1 |
| a cited `ship.js:N` pointed at the wrong line | 1 | 1 |
| `environments.prod.rebuild = 'PASS'` reintroduced in ship.js | 1 | 1 |
| the gate checks' loader migrated off the hand-built monolith path | 1 | 1 |
| `monolith-only` removed from the answer's prose | 1 | **0**, then 1 |
| one `rebuildSkipReason` deleted from ship.js | 1 | 1 |
| the consumer named in the answer | 1 | 1 |
| the whole section deleted from the spec | 3 | 1 |

**The 0.** Deleting the phrase from the paragraph changed nothing, because
the section's own success criteria are inside the section, and an SC line
quotes the title of the test claiming it — so `SC-1720: … is still
monolith-only …` kept answering a search that was supposed to be reading the
prose. A spec could have stopped explaining itself while the test that reads
it stayed green, which is the self-reference trap in
`.claude/rules/checks-must-be-able-to-fail.md`. The extractor now strips SC
lines before searching, and the row is 1.

That trap has now caught this repo four times — #330, #352, #360, and here.
Three of those were found by a human reading carefully. This one was found by
a predicted number coming back wrong, which is the cheaper instrument.

**The 3 that was 1.** Deleting the section makes the extractor throw at module
load, so bun reports one failed FILE rather than three failed tests. The
prediction was wrong about the counting, not about the behaviour — nothing in
the file can pass without the section, which is what the row was for.

## Citing source by what it says, not by where it sits (#514)

This document cited seven source locations by line number. Three sat under
`test/gate-env-expressibility.test.ts` SC-1719, which checks them rather than
believing them; keeping that green cost three hand edits of five numbers
across two PRs, because every insertion into `workflows/ship.js` moves them.

The other four had no guard, and this is the measurement the issue predicted
and nobody had:

| cited | pointed at | should have been |
|---|---|---|
| `gate-executor.ts`, line 1725 | a `parseFloat` | 2109 |
| `evidence-prevalidator.ts`, line 208 | a comment | 245 |
| `scaffold-rungate-config.ts`, line 66 | an unrelated `existsSync` | 61 |
| `workflow.test.ts`, line 87 | `loadProjectHarness` | correct |

The table writes those in prose rather than in the live citation form: a
record of citations that were wrong, written in the form the ratchet below
enforces, would make the document refuse itself.

**Three of the four unguarded citations were already wrong**, each pointing at
a plausible-looking line in the right file. The three guarded ones were
correct. The only citations that stayed true are the ones something executed.

### The form

    `workflows/ship.js@"const containerConfig = projectConfig.container"`

`lib/source-anchor.ts` resolves it, and resolution is **total**: not-found and
found-twice are both refusals. The second one carries more weight than it
looks. Taking the first of several matches would make every ambiguous
citation resolve, and "resolves to a plausible line" is exactly what the line
numbers were doing for three citations in this file. An anchor under twelve
characters is refused too — unique today is one unrelated edit away from not
being, and a short anchor that stays unique is indistinguishable from one
that does not until it is too late.

A **historical** citation stays prose. "line 4462 of `ship.js` as it then
stood" names a line that no longer exists, which is the point of the
paragraph using it, and the resolver would rightly refuse it.

### What this does not cover

134 line citations remain in ten other documents — 48 in
`specs/HARNESS-STANDARD.md`, 45 and 22 in the two config-loader ADRs. The
ratchet below is scoped to this file on purpose: widening it would make it a
known-violations list rather than a rule, and each conversion should surface
its own wrong citations the way this one did rather than being buried in a
134-line diff. That population is a separate issue, with the counts recorded.

### Mutations, predicted before running and measured after

Over `test/source-anchor-citations.test.ts` and
`test/gate-env-expressibility.test.ts` (11 tests). Every anchor was checked
for uniqueness before being applied.

| Mutation | Predicted | Measured |
|---|---|---|
| a double match takes the first instead of refusing | 2 | **1** |
| a missing anchor resolves anyway | 2 | **1** |
| the short-anchor floor is removed | 1 | 1 |
| a multi-line anchor reports its first line | 1 | 1 |
| a missing file resolves anyway | 1 | 1 |
| the citation pattern stops matching | 4 | 4 |
| the pattern swallows a bare path in a code span | 3 | 3 |
| the spec goes back to a line number | 2 | 2 |
| a citation is edited so it no longer matches source | 1 | 1 |
| a citation is deleted outright | 1 | 1 |
| the absolute-path refusal is removed | 1 | 1 |
| the lexical containment check is removed | 1 | 1 |
| the symlink check is removed | 1 | 1 |
| a traversal refuses for absence instead of for leaving | 1 | 1 |

None is left in the tree; all were run and reverted.

The first two came back low for the same reason, and it is a fact about the
document rather than about the resolver: every anchor in this spec is present
and unique, so disabling the not-found and found-twice refusals changes
nothing about what the spec resolves to. Those refusals are proved by
SC-1816 and SC-1817, which ask them directly.

### The path guards, and the pair the battery found

The commit security review flagged path traversal: the path comes out of a
markdown document and `resolveCitation` reads whatever it names. No live
document does that — every citation here is written by someone with commit
access — but "the input happens to be trusted today" is not a property of a
library, and a spec is exactly the sort of file a consumer generates.

The first draft had four checks. **Two of them measured 0 red**, because a
`..`-segment spelling rule and the lexical containment check answer one
question: `resolve` normalises `..`, so either could be deleted with
nothing to say which. The draft's comment asserted they differed, on the
grounds that containment sees "a symlinked directory inside the tree". It
does not — `resolve` is purely lexical and cannot see a link at all.

Three remain, each with an input only it reaches:

| input | the only check that catches it |
|---|---|
| an absolute path | the leading-slash refusal — `join` CONCATENATES a leading slash rather than absorbing it, so the path stays inside the tree and containment has nothing to say |
| a `..` traversal | lexical containment |
| a symlink inside the tree whose target is outside | `realpathSync`, the only thing that follows it |

The absolute-path case is not an escape: `join(root, "/etc/passwd")` reads
`<root>/etc/passwd`. It is refused because a citation written absolute means
something other than what its author thinks it means, and a confident
citation to the wrong file is this entire issue.

The symlink fixture's target is reachable ONLY through the link, outside the
walked tree entirely. A fixture that can satisfy its assertion by another
route measures nothing about the feature (#500).

The last two rows were added after the battery's first pass. The count floor
on the resolving row had been set below the real number of citations, so
deleting one outright was 0 red — a floor under the true count is a floor
that cannot see a loss. Set to the measured 9, both rows are 1.

### Success criteria

- [x] SC-1815: test/source-anchor-citations.test.ts contains [an anchor that names one line resolves and reports where] — the position is reported rather than asserted, since a number here would be the thing this issue removed
- [x] SC-1816: test/source-anchor-citations.test.ts contains [an anchor the file no longer contains is a refusal] — a citation to text that is gone is a sharper signal than a line still matching a loose regex
- [x] SC-1817: test/source-anchor-citations.test.ts contains [an anchor matching twice is a refusal - not the first match] — an ambiguous anchor is how a stale citation lands somewhere believable
- [x] SC-1818: test/source-anchor-citations.test.ts contains [a short anchor is refused before it becomes ambiguous] — unique today is one unrelated edit away from not being
- [x] SC-1823: test/source-anchor-citations.test.ts contains [a citation cannot read outside the repository] — flagged by the commit security review: the path comes out of a document and this function reads whatever it names, and refused for leaving rather than for being absent
- [x] SC-1824: test/source-anchor-citations.test.ts contains [a symlink inside the tree pointing out of it is refused] — the input the lexical check cannot reach, with a target reachable only through the link
- [x] SC-1819: test/source-anchor-citations.test.ts contains [a missing file and a multi-line anchor both refuse] — reporting the first line of a spanning fragment is the near-enough that put three wrong numbers here
- [x] SC-1820: test/source-anchor-citations.test.ts contains [all of them resolve] — with the count floor at today's number, so a citation cannot be deleted without the row saying so
- [x] SC-1821: test/source-anchor-citations.test.ts contains [the line-number form is gone and does not come back] — converting seven is worth nothing if the eighth is written the old way next week
- [x] SC-1822: test/source-anchor-citations.test.ts contains [the citation form itself round-trips] — a form the parser cannot see is a citation nothing checks, which reads exactly like one that passes
