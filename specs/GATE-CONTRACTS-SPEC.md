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
| run-gate.ts | <400 | — | Yes (SC-379) |
| gate-executor.ts | ~600 | — | Yes (SC-388) |
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

### SC-379: run-gate pass/fail criteria
- **Input:** `RunGateInput` — gate name, slug, issue number
- **Output:** `ParseTestOutput` (alias for `GateResult[]`)
- **PASS:** All AC evidence commands succeed, all AC verdicts are PASS or SKIP, zero FAIL results
- **FAIL:** Any AC evidence command fails, any AC verdict is FAIL, or any gate check returns FAIL

### SC-388: gate-executor pass/fail criteria
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

### SC-380: orchestrator pass/fail criteria
- **Input:** `WriteGateResultInput` — state file path, gate name, pass/fail/warn counts, results array
- **Output:** `GateResult` — check name, result (PASS/FAIL/WARN), detail string
- **PASS:** `fails === 0` and no non-OUTCOME ACs have FAIL verdicts
- **FAIL:** `fails > 0` or any non-OUTCOME AC has FAIL verdict

### SC-381: ship-orchestrator pass/fail criteria
- **Input:** `ShipGateInput` — slug, gate name
- **Output:** `AdvanceResult` — phase, gateResult, failures, iteration, circuitBreaker
- **PASS:** Gate executor completes without error and gate result in state is PASS
- **FAIL:** Gate executor throws or gate result in state is FAIL; circuit breaks after MAX_ITERATIONS

### SC-382: brief-assembler pass/fail criteria
- **Input:** `AssembleBriefInput` — slug, workDir, projectRoot
- **Output:** `AssembleResult` — briefPath, acCount, contextFileCount, validated
- **PASS:** workflow-state.json exists, brief file written, `validated === true` (all required sections present)
- **FAIL:** workflow-state.json missing (throws), or required sections missing (`validated === false`)

### SC-383: schema pass/fail criteria
- **Input:** `SchemaValidateInput` — raw state object to validate
- **Output:** `SchemaValidateResult` — valid boolean, issues array
- **PASS:** Zod parse succeeds with zero issues — no behavioral language, no garbage statements, no weak thresholds
- **FAIL:** Zod parse fails — behavioral pattern detected, garbage statement, weak threshold, or missing required fields

### SC-384: witness pass/fail criteria
- **Input:** `WriteWitnessInput` — slug, gate, result, testOutput, issue, projectRoot
- **Output:** `VerifyWitnessResult` — valid boolean, record, error
- **PASS (write):** Witness file written with valid HMAC signature
- **PASS (verify):** HMAC recomputed matches stored HMAC, all required fields present
- **FAIL:** HMAC mismatch, missing fields, or witness file not found

### SC-385: self-heal pass/fail criteria
- **Input:** `HealInput` — gate, slug, issue, projectRoot, workDir, maxAttempts, dryRun
- **Output:** `HealResult` — result (PASS/FAIL), attempts, failures, circuitBroken
- **PASS:** Gate execution result is PASS within maxAttempts
- **FAIL:** Gate result is FAIL; circuit breaks when `attempt >= maxAttempts`

### SC-386: error-classifier pass/fail criteria
- **Input:** `ClassifyInput` — failures array
- **Output:** `ClassifyResult` (alias for `Classification`) — category, regressionTarget, retryable, failures
- **PASS:** N/A (always produces a classification). Empty failures array returns NON_RETRYABLE
- **FAIL:** N/A — classification is deterministic, never fails; consumer decides action based on category

### SC-387: preload pass/fail criteria
- **Input:** `RecordTestInput` — test name, passed boolean
- **Output:** `TestRecordResult` — testName, result string
- **PASS:** Test result recorded to gate-results.jsonl and recurring failures logged
- **FAIL:** N/A — recording is best-effort; missing state dir silently skips

### SC-388: gate-executor pass/fail criteria
- **Input:** `GateExecutorInput` — gate name, slug, issue number, workDir, stateFilePath, harnessRoot, projectRoot, issueRepo
- **Output:** `GateExecutorResult` — passes, fails, warns, results array, testOutput
- **PASS:** All delegated gate functions complete without error, aggregated fails === 0
- **FAIL:** Any delegated function reports failures; consumer (run-gate.ts) aggregates and writes gate result

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
| `lib/scaffold/steps.ts` | `existsSync(makefile) ? "make rebuild"` | Inferred from a Makefile EXISTING, not from the target existing. A project with a Makefile and no `rebuild` target got a `prod.rebuild` that cannot run. `scripts/scaffold-rungate-config.ts:66` already checked the target; the two are now consistent. |
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

- [x] SC-751: test/project-state-currency.test.ts contains [every PR landed since the last recorded session is accounted for] — commits on `main` carrying a PR number are compared against the newest session entry and the uncovered ones are named, because the only thing standing between PROJECT-STATE.md and being false was somebody remembering
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
| `project-state.json`'s latest `session.date` rolled back to 2026-09-01 | 2 of 6 in `test/project-state-currency.test.ts` — the uncovered PRs, and the markdown no longer naming the date it was rendered from |
| the git probe pointed at `origin/no-such-ref` | 1 of 6 — the readability case alone, which is the point: the currency comparison returns early and stays silent rather than reporting clean |
| the renderer's honest message replaced with `"ran."` | 1 of 6 |
| the probe restricted to merge commits again | 1 of 6 — and **0 of 5** before SC-754 was added, which is the only reason the blindness was found |
| the squash subject form dropped from the parser | 1 of 6 |
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
