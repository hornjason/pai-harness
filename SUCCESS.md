---
doc-type: reference
status: active
owner: jason
updated: 2026-10-08
---

# What we are building, and how we will know it worked

This file exists because nothing else in the repo said it. `PROJECT-STATE.md` is a
session log, `HARNESS.md` is a reference, and the specs each govern one mechanism.
None of them states the target, so every agent — and every sweep looking for
defects — has been pattern-matching against "is this code good" instead of
measuring against "does this get us there."

Read this before deciding whether a finding matters.

## The thing

A ship harness someone else can point at their own repository, from a GitHub
issue to a merged PR, **and trust the result without re-measuring it by hand.**

The product is not the automation. Automation that ships the wrong thing quickly
is worse than no automation, because the report is believed. The product is the
**trustworthiness of the report**.

## Done, for the harness

Five claims. Each is falsifiable, and the check is named. A claim with no check
is not on this list.

1. **Every gate can fail, and has been observed failing.**
   Check: for each gate, a test that breaks the guarded thing and watches the
   gate go red — see `.claude/rules/checks-must-be-able-to-fail.md`. Source-text
   assertions do not count; the marked block is extracted and executed, and a
   mutant with the refusal removed must ship where the real one refuses.

2. **Every number a run reports describes the committed tree.**
   Check: no figure in a run summary may originate before the final source
   change it describes. `TDD_SEQUENCE_VIOLATED` is exactly this claim failing,
   and it now blocks (#188).

3. **A bad ship is stopped, not described.**
   Check: for each verdict the harness computes — security, compliance grade,
   review currency, commit receipt — something reads it and can return
   `SHIP_FAILED`. A verdict that only reaches a log line or a trend file does
   not satisfy this.

4. **"Could not measure" never reads as "nothing wrong."**
   Check: for each guard, the absent / empty / corrupt / errored input is a
   distinct, tested outcome from the clean one. Fail-open is permitted where
   it is the right call, but it must be **loud** — invisible fail-open is the
   defect, a recorded one is a tradeoff.

5. **The harness works on a repo that is not this one.**
   Check: a full run with `projectRoot !== harnessRoot`, on the monolith config
   layout, at a non-LIGHT ceremony tier. Until that has happened, every claim
   about consumer support is untested.

6. **A repo the harness manages carries its own non-inferable constraints.**
   Check: every consumer receives the harness baseline, **and** a mined tier
   derived from that repo's own history and evidence. Falsified three ways —
   a consumer whose rule set is entirely baseline, a baseline rule citing
   evidence from a different repo, or an agent change that contradicts a
   recorded prior decision in that repo. Governed by
   `specs/RULE-LIFECYCLE-AND-CONTEXT-BUDGET-SPEC.md`.

## Done, for a consumer

This is the acceptance test for the first Daily Brief Dashboard run. It is
narrower than "the run passes" on purpose — a run that *fails honestly* passes
this list; a run that *succeeds dishonestly* fails it.

- The harness reads DDB's `.claude/rungate.json` (legacy monolith) and gets the
  same answers `loadRungateConfig` would give for the directory layout. A reader
  that understands only one layout is a defect, not a limitation.
- Non-LIGHT tier is taken because `pages` is non-empty, Quinn actually executes,
  and Quinn's verdict is recorded from what Quinn returned — not from the tier.
- A preflight that cannot reach the remote runner refuses or records its own
  failure. It does not produce an empty result that later reads as satisfied.
- The run does not leave DDB in a state DDB's own rules forbid. DDB mandates
  build → test container 7776 → playwright → production 7777; the harness either
  honours that sequence or stops before the step that would skip it.
- Every gate the run reports as PASS was actually executed against DDB's tree.
  A gate that is structurally unable to fail on a consumer is reported as
  unexecuted, not as passed.

## What is not success

Each of these has happened in this repo and was mistaken for progress.

- **A green suite.** The suite has been green while a gate had never once run in
  CI, while a test compared two empty arrays, and while a documented typecheck
  had no `tsconfig.json` to read.
- **A passing gate.** `tsc-pass` was two early returns and an empty tail (#176).
- **A merged PR.** PR #187 merged, reported `regressions: 0`, and went red in CI,
  because the count predated the final edit.
- **A guard with a passing mutant test.** Measured 2026-10-08: wrapping the
  `BLOCKING-GRADES` block (#188) in `if (false)` — wrapper *outside* the markers,
  so the extracted slice is byte-identical — leaves `test/blocking-grades.test.ts`
  at 19 pass / 0 fail. Same mutation on `SECURITY-DECISION` (#129): 113 pass /
  0 fail. On `COMMIT-STATE-GUARD` (#166): 52 pass / 0 fail. Marker extraction
  proves the extracted text refuses correctly. It does not prove the block is
  reached.
  **Fixed 2026-10-09** by #200 (`64e5ac1a`) and #201 (`43dd9997`).
  `lib/reachability.ts` reads the marked region's AST ancestor chain instead of
  its text, and all three suites now call it. Same mutation, re-measured on the
  merged tree:

  | suite | before | after |
  |---|---|---|
  | `test/blocking-grades.test.ts` | 19 pass, 0 fail | 19 pass, **1 fail** |
  | `test/security-verdict-blocks.test.ts` | 113 pass, 0 fail | 113 pass, **1 fail** |
  | `test/record-build-commit.test.ts` | 52 pass, 0 fail | 51 pass, **1 fail** |

  The third went 52 → 51+1 because the old check — a test literally named *"the
  guard is wired into the run, not merely defined"*, whose assertions matched
  call-site **text** — was replaced rather than supplemented.

  Residual gap, stated because the fix does not cover it: this is a **parse-time**
  property. A block the parser says is unconditionally reached can still never
  execute — an earlier `return` that fires on every real input, an `await` that
  never settles, a config-gated early exit. The `new Function` mutant tests
  remain and prove the complementary property.
- **An agent reporting it complied.** Marcus has exceeded the full-suite cap on
  every measured run while the rule text asking otherwise got longer each time.
  Compliance is measured from transcripts, never self-reported (#194).
- **A spec marked done.** Measured 2026-10-08: **no success criterion in this
  repo could fail the conformity suite.** `lib/conformity.ts:289` collected only
  `- [ ] SC-N`, so the 467 checked SCs generated no test; the 107 unchecked ones
  got a body that was `try { assertion(root) } catch { }` with no `expect`
  (`:901-907`). The only test in the block that could go red checked SC *syntax*.
  **The SC count was a tally of checkboxes, not evidence.**
  **Fixed 2026-10-09 by #209** (`c60a7b00`): the pattern is now
  `/^- \[([ xX])\] (SC-\w+):…/gm`, a checked SC generates a bare
  `entry.assertion(root)` with no surrounding catch, and an unchecked SC emits
  `test.todo` instead of a swallowed pass. Measured on the merged tree:
  **4030 pass / 0 fail / 4201 tests**, against 3236 / 3303 before — +794
  passing, +898 collected. The first thing binding caught was `SC-297`/`SC-303`
  asserting on `.git/hooks/pre-commit`, which git never tracks: green on a
  developer machine, red in CI, and never about this repository at all.
  **Still only 55% of the corpus.** The engine does not recurse into `specs/`
  subdirectories, so the 254 SCs in `specs/bootstrap-data-flow/` — 45% of 564 —
  are collected by nothing (#225). Quote SC numbers against 564 and say which
  half you measured, or do not quote them.
- **Correct code nobody can install — closed 2026-10-14, and the lesson is
  not.** For 719 commits every number in this file was measured against the
  working tree while what a consumer could `bun add -d` was `rungate@0.2.1`
  from 2026-09-19. **The evidence base and the installable artifact were
  different software.** `v0.3.0` was published on 2026-10-14 and they now
  match. What remains true is why this sat here so long: nothing measured the
  distribution path, so nothing reported it broken. Claim 5's own row argues
  that *"a path nothing has executed is not a path anyone understands"* — the
  distribution path was in exactly that category and was not counted as one
  until #366. The consumer survey below still describes the tree as surveyed
  before publication; re-running it against the installed package is
  outstanding, and the row is not upgraded on the strength of a version
  number matching.

## Where we actually stand

Measured, with dates. Update this section at the same time as `PROJECT-STATE.md`.

**Which software these numbers describe.** The row below is enforced rather
than narrated: `test/distribution-standing.test.ts` reads both versions from
this line, compares the first to `package.json` and the second to the npm
registry, and goes red when either drifts. Bumping `package.json` without
updating this line turns it red, which is what makes a release a two-commit
operation rather than a tag somebody remembers to annotate.

- **Distribution standing (2026-10-17)** — tree `0.5.0`, published `rungate@0.5.0`.

**The release pipeline reported a success for the first time.** `v0.3.0`,
`v0.4.0` and `v0.4.1` all published correctly and all three ended in a red
job, because the postflight asked the slow question and only the slow
question. #472 shipped in this release and the run proves it: `Publish`
succeeded, the postflight read the receipt npm writes synchronously, and the
job went green without waiting on the packument to propagate. Three releases
of "the guard is working as intended and the budget is a guess" is now a
guard that measures the thing it can measure.

Verified against the artifact rather than the tag: `npm pack rungate@0.5.0`
carries `config/` (9 files, including `matcher-registry.json`) and
`templates/` (8 files). Those are the paths #484 found missing, and they are
the ones a consumer's first `bunx rungate scaffold .` needs.

**Why this release is `0.5.0` and not `0.4.2`.** It was planned as a patch and
the plan was wrong, on this file's own stated test: *observable behaviour
changes, not fixes*. Four of the 36 commits past `v0.4.1` meet it.

#449 adds `--profile=minimal`, a new CLI flag and a new published module
(`lib/scaffold/profiles.ts`) — the public surface grew. #485 makes `SUCCESS-1`
refuse a file that is still the seed template, where it previously passed.
#469/#490 makes a suite run that measured nothing a refusal, where it
previously read as a clean tree. #42 makes re-scaffold auto-fix, which changes
what an existing consumer's re-scaffold does to their files without them
asking for anything new.

The second and third are the same shape as #405 and #397, which this file
cites as the reason `0.4.0` was a minor. A patch number on a release that adds
a flag and turns two passes into refusals is a false statement to anyone
reading the version to decide whether to upgrade.

**What `0.4.1` could not do, measured on a real consumer rather than argued.**
`#484` is the reason this release is not optional. Published `0.4.1` carries
`lib/conformity.ts`, which reads its matcher registry by building a path from
its own module directory rather than importing it — so `files[]` omitting
`config/` was invisible to `test/package-closure.test.ts`, which only knew
about imports. Run against the one external consumer that exists, `bunx
rungate scaffold .` on installed `0.4.1` dies:

```
ENOENT: no such file or directory, open
  '<consumer>/node_modules/rungate/config/matcher-registry.json'
    at loadBuiltInRegistry (node_modules/rungate/lib/conformity.ts:496)
```

So claim 5's first measurement against an installable artifact — recorded
above for `0.4.1` and correct as far as it went — covered importing
`lib/conformity`, not using it. `0.4.2` was never a question of nice-to-have;
`0.4.1` cannot scaffold a consumer at all, and `0.5.0` is the first release
that can.

**The gap is closed, and for the first time the artifact was checked rather
than the number.** `v0.4.1` was cut on 2026-10-16 and the registry serves it.
`bun add rungate@0.4.1` into an empty directory carries all four scripts
`files[]` used to omit, and `import("./node_modules/rungate/lib/conformity.ts")`
resolves and returns 50 exports — the import that threw on `0.3.0` and
`0.4.0`. `bunx rungate@0.4.1 --help` prints the command list. That is claim
5's first measurement taken against something a consumer can install.

**The postflight refused a release that had succeeded — the third time, and
this run says why.** `npm publish` printed `+ rungate@0.4.1`, signed
provenance into the sigstore transparency log, and then printed npm's own
explanation: *"Your package is being processed and may take a few minutes to
become available."* The postflight read the packument 25 times over 120s and
gave up at 12:43:10 UTC; the registry served `0.4.1` at 12:43:58 UTC. It
missed by 48 seconds. #445's fix is working exactly as intended — the refusal
now reads `RELEASE UNCONFIRMED: UNMEASURED` and names the command that
settles it instead of asserting a cause it cannot establish — so what is left
is not a wording problem but a budget guessed against someone else's
asynchronous pipeline, when that pipeline announces itself in the publish
step's own output. Filed as #472.

**Why `0.4.1` is a patch.** Both commits past `v0.4.0` are fixes with no
observable interface change. #446 added four already-existing `scripts/`
paths to `files[]`; #445 removed a cause the postflight could not establish
from its own refusal text. Nothing was added to or removed from the public
surface, so a patch is what this is.

**What the guard still cannot see, and #446 is the proof.** Version standing
says the registry serves the same number the tree carries. It says nothing
about whether the artifact that number names can be imported. Published
`0.3.0` and `0.4.0` both shipped a `lib/conformity.ts` whose top-level import
of `../scripts/split-spec` resolved against nothing, because `files[]`
enumerates `scripts/` one path at a time and omitted it — along with
`sync-sc-status`, `audit-transcript` and `detect-sc-drift`. Four published
modules were unimportable, through two releases, with this line green.

So "tree and registry agree" was true and the distribution was still broken.
`test/package-closure.test.ts` adds the missing half: every relative import in
a published file must resolve to another published file. `0.4.1` is the first
release that carries both the fix and the check — until it lands, the newest
installable rungate is still the broken one.

**Why 0.4.0 is a minor and not a patch.** Three of the 29 commits past
`v0.3.0` are observable behaviour changes, not fixes. #429/#430 changed
`verifiedPush`'s signature and added `ref-mismatch` and `repo-mismatch` to
`PushOutcome`, so an exhaustive `switch` on `.kind` no longer compiles. #405
made the prove-label gate refuse where it previously passed. #397 made the
generated pre-push hook block on `UNMEASURED`, where it previously only
blocked on a conformity `FAIL`.

**The gap was closed on 2026-10-14, for the first time since 2026-09-19.**
`v0.3.0` was cut that day and `npm install rungate@0.3.0` serves `bin/ lib/
prompts/ scripts/`.

Two things that does NOT yet license. The consumer-list row still records a
survey of the *tree*, run before any of this was published; re-running it
against the installed package is the work, and nothing here substitutes for
it. And "the versions match" is not "the tarball works" — what was verified
is that it installs and carries the expected directories, not that a consumer
can scaffold with it.

Worth recording because it is the same defect class the rest of this file is
about: **the release job that cut this version went red.** The publish
succeeded and the postflight refused it, because it read the registry about a
second after `npm publish` returned and npm's packument had not propagated. A
check that cannot reliably pass gets the message wrong exactly as badly as one
that cannot fail. Fixed in #407.

**And it happened again on 0.4.0 (2026-10-15), which means #407 did not fix
it — it widened it.** The postflight now reads the registry 10 times over 27
seconds, and still refused:

```
RELEASE REFUSED: the registry's latest is 0.3.0, not the 0.4.0 this run was
cutting — the publish step did not take effect — read 10 times over 27s,
which is long enough that this is not the registry catching up
```

It was the registry catching up. `npm view rungate dist-tags` returned
`{"latest":"0.4.0"}` a few minutes later, from the same endpoint. So the
guard refused a release that had succeeded, and the clause it refused with —
*"long enough that this is not the registry catching up"* — is an assertion
the guard has no way to support. A retry budget is a guess about someone
else's infrastructure, and stating a guess as a finding is how a reader comes
to distrust a correct refusal later. Filed as #445.

**#445 is fixed, and the fix is not a longer wait.** Two changes, neither of
them a number. The postflight reads the registry's published-VERSIONS list
rather than `dist-tags.latest`, so a landed publish whose tag has not caught
up is a pass that says so — that case had been a refusal naming a failed
publish for the whole of SC-829's life, and SC-829 is now superseded over it.
And when the version is genuinely not visible inside the budget, the step
exits 2 with `RELEASE UNCONFIRMED` instead of 1 with `RELEASE REFUSED`: it
names both explanations, chooses neither, says the publish may well have
succeeded, and names `npm view rungate@<version> version` as the one command
that settles it. The job still goes red, and that is a trade recorded in
`specs/HARNESS-STANDARD.md` rather than assumed — a release is irreversible
and a `run:` step has no neutral outcome, so the only alternative is
`continue-on-error`, which the suite forbids outright. What is gone is the
guard asserting a cause it had not established.

**Why `0.3.0` and not `0.2.2` (2026-10-14).** The tree carried `0.2.2` from
2026-09-19 and the first release attempt tagged it, which was wrong and was
cancelled before it reached the registry. `0.2.2` is a PATCH, and a patch
claims backward-compatible bug fixes. Measured against the commit that
published `0.2.1`: **719 commits, 160 published-surface files changed,
+35,328/−1,815, 86 of the 90 `lib/` files in the tarball are new, and 613
exported symbols were added.** Three exports appear removed in the diff and
none actually is — `runSpecDrift`, `runDocHygiene` and `harnessRoot` all moved
file and are still exported — so the change is purely additive. Under the 0.x
convention that is a minor bump, and calling it a patch would have understated
the release by roughly its entire contents.

| Claim | Standing (2026-10-11) |
|---|---|
| 1 — gates can fail | Partial, improving. Security gate proven (#129), blocking grades proven (#188), a *disabled* guard caught by the suite that owns it (#200 + #201), and as of #209 **a success criterion can fail** — it immediately caught two SCs asserting on untracked local state. Still open: only 55% of SCs are collected at all (#225, 254 invisible); `content-contains` discards everything after the first bracket list (#220); nothing reconciles the matcher registry with its handlers (#212); `tsc-pass`, `local-api-validated`, `local-ui-validated` cannot fail (#176); `TestSuiteGuard` cannot fire (#194); five hooks never fire (#199). Gained one as of #235: evidence pre-validation — the module whose own docblock says it catches the cause of 70% of pipeline failures — was wired as an **unawaited promise logging to `console.error`**, with nothing reading it and a `.catch` that swallowed a throw into a 100-character warning. It now persists a verdict the gate refuses on, and the mutation returning `[]` from `prevalidateEvidence` turns 5 red. The same change found the contract test's own STANDARD fixture citing evidence commands (`grep fix src/test.ts` in `/tmp/test`) that have never been runnable — a gate test green because nothing executed what it declared. **The mirror defect, 2026-10-10 (#261, fixed):** the same pre-validation reading had exactly one writer, the scope gate, and ship.js skips the scope gate outright on a LIGHT ceremony tier — while its reader runs at `isVerifyPlus()` and refuses on an absent reading. Composed, *every LIGHT-tier run failed verify unconditionally, and no change to the code being shipped could heal it*; run `wf_ed24496e-e49` reached VERIFY with six of six ACs PASS and spent two heal rounds against the gate's own plumbing. Both halves were tested; nothing tested the composition, because no fixture had ever run a verify gate on a run that had not had a scope gate. This row is about checks that cannot fail; a check that cannot **pass** is the same root — a check whose phase did not imply its producer's phase — and it costs a run everything rather than nothing. **Three more instances of that same root on 2026-10-11, two of them introduced by the fix for the one above (#264, #269, both fixed), and the class itself finally measured (#273, open):** six phase-ordering checks in `test/spec-compliance.test.ts` assert on **comments**. Five of their eight anchor strings occur only inside comments, and PO-1, PO-2 and PO-6 compare one comment to another, so they say nothing about code at all. Gutting the PR step out of `workflows/ship.js` entirely — zero `pr-upsert` call sites — while leaving the comment on `:4338` in place leaves **all six green**. That is #254's own bug reproduced in the tree with the two checks that exist to order PR creation reporting pass. The row above is about a check whose phase did not imply its producer's phase; this is the simpler and older failure, a detector whose input is prose. **#273 is now fixed (eba80415) and the fix is verified on main by the mutation that defined it:** gutting the PR step out of `workflows/ship.js` while leaving its comment at `:4338` in place gave 6 pass / 0 fail before, and gives 4 pass / 2 fail after. The converse also holds — rewording three phase banner comments with no code change leaves all six green, which is the false red that refused run `wf_61a6af0d-053` and had blocked #254 through four attempts. |
| 2 — numbers describe the tree | Partial, materially better. `TDD_SEQUENCE_VIOLATED` now blocks. Review currency closed post-commit (#169), and as of #224 **the suite count is bound to the commit it was measured against**: a recorder writes the SHA from the tree rather than an agent typing one, a count whose SHA does not match the branch tip is a `SHIP_FAILED` refusal raised before the PR step, and a count with no SHA reads `UNMEASURED` rather than zero. **That refusal had never fired, and this row claimed it had (2026-10-16, #530, fixed).** The recorder wrote the SHA to `suiteMeasurement.measuredSha`; the probe that feeds the comparison asked an agent for `environments.local.testsSha`, a field nothing has ever written and the schema does not declare. So `suiteCurrency` returned `UNRECORDED` on every run that has ever happened and the staleness refusal was unreachable — #224 shipped a recorder and a refusal and never connected them. The same issue found the same disconnect one field over: `environments.local.tests`, which three gates refuse without, was only ever written by a clause inside a heal prompt that runs when a gate fails, so on a normal run no step wrote it at all. Both now have a producer, and a prompt naming a state path the schema does not declare is a test failure. ship.js's inlined copy of that rule is held to the library by a 28-row matrix run over both, with two mutations of the extracted block checked on every test run — the first binding in this repo whose duplicate cannot drift silently. `test-clean-env.ts` still models the environment, not the CI checkout (#168) — reproduced live on PR #219, green locally and 11 failures in CI. Prior-work detection measures ACs against `main` rather than the issue's branch, so a re-run re-implements and opens a second PR (#223). |
| 3 — bad ships are stopped | **Weaker than previously recorded, and the inverse now also fails.** Security and compliance verdicts refuse, and the stale-review gate correctly blocked a run on 2026-10-09. The two worst instances are now closed: a run returned `SHIPPED` with `regressions: 0` on a branch with a failing test that an existing guard raised (#224, fixed — the count is bound to its commit and a stale one refuses), and `SHIPPED` was returned without merging anything while a *skipped* prove step mapped to the only unqualified success status in the system (#222, fixed — `SHIPPED_UNPROVEN` and `SHIP_PASSED_PROVE_FAILED` now exist and an unmeasured suite caps the status). Measured 2026-10-09, the mirror defect: **three consecutive runs where the verdict and the artifact disagreed** — #209 run 1 returned `SHIP_FAILED` having produced the branch that merged, run 2 returned `SHIPPED` for a red branch, and #227's run returned `IMPLEMENT_FAILED` over correct work. A harness that is a poor witness to itself in both directions fails this claim twice. #228 landed preservation on the collect-refusal path so a refusal no longer destroys the work it refuses; #232 is open because that covers one exit and not the class. The fourth instance of the inverse, 2026-10-10: `TDD_SEQUENCE_VIOLATED` — the very gate this row cites as proof the claim works — **refused a 77-minute, 1.64M-token run over correct, already-committed work** (#240, fixed). An agent that ran the suite nine times after writing source was graded as having run none, because a second test file reset the state machine and erased the pending green phase; separately `gates/` and `workflows/` were not classified as source, so the harness could not grade TDD on the harness. A blocking gate is only as good as its ability to be *wrong* visibly, and this one named a role rather than an agent, so the accusation was unattributable across four `marcus` grades. Two closed on 2026-10-10 by running the pipeline against itself rather than reasoning about it: #258 — #251's brand-new coverage refusal, three hours old, fired on a run whose five ACs *did* cover all three criteria, because the check read a field Discovery does not write for that purpose; and #261 above. Both were found by a real run and neither by a unit test, which is the standing argument for the negative control being a line item rather than a nicety. **Fifth instance of the inverse, 2026-10-11 (#267, fixed):** on a run whose implementation spanned more than one worktree, the collector assembled everything into `PROJECT_ROOT` and set `commitDir` to it — and the project root sits on `main`, which the commit step's own guard refuses by design (#136). Run `wf_19f7def7-1bf` produced a complete, correct implementation and could not commit a line of it, and no change to the shipped code could have altered that. Worse than the refusal: it left **907 lines of unreviewed agent output staged on `main`** in the repository a human works in, where any later `git commit` would have taken it. A refusal that leaves the work it refused staged on the default branch is the inverse of this claim twice over. **Sixth instance, same day (#279, fixed):** `scripts/collect-worktree-files.ts` dropped 926 lines of correct, tested work and **exited 0** — the agent annotated every path it reported (`"lib/strip-js-comments.ts (NEW, 178 lines)"`), the collector joined the whole string onto the worktree path so all five missed, and the guard written to catch precisely this tested `groups.length`, the number of *worktrees*, rather than the number of files resolved. Its own comment reads *"Silence here would commit nothing and call it a success."* One worktree was supplied, so it passed. The work survives only because #228's preservation path held, which is the one half of this claim currently working as designed. Both halves are now fixed and were mutated apart: guard removed with the parsing fix intact, 3 of 9 red; parsing removed with the guard intact, 1 of 9 — and that second number is the result, because with the guard in place the remaining cases refuse loudly instead of passing. |
| 4 — absence ≠ clean | **No for grades, yes for timing as of #227.** `grade-deterministic.ts` still writes `{grades:[]}` and exits 0 on no transcripts; the ship.js prompt instructs the same shape (#195, open). Timing is now the counter-example to copy: before #227 four of 31 call sites were measured and the rest were invisible, and the `stat`-based reader was `2>/dev/null`-chained so a filesystem with no birth time reported `"timing": []` silently. An agent with no record now reports `unmeasured`, never zero seconds, and the mutation returning `durationSeconds: 0` for the unmeasured branch turns four tests red. |
| 5 — works on another repo | **No, never attempted, and as of 2026-10-11 measurably worse than "untried" (#274, open).** Every run in this repo's history is rungate shipping rungate. The `~/.rungate/ddb-*` directories are rungate runs under a stale slug, not DDB runs. The new part is *why that matters more than it sounds*: `workflows/ship.js:1705` rewrites the ceremony tier to `LIGHT` whenever `pages` is empty, and rungate's own config sets `"pages": {}`. So **every self-run this repo has ever made was forced to LIGHT**, which skips the scope gate (`:1796`), Quinn local (`:2283`), Quinn verify (`:3593`), prove (`:4549`) and the remote pre-flight (`:1239`). DailyBriefDashboard configures 18 pages, so its first run enters all five for the first time. Every green suite and every mutation count in this file is evidence about one ceremony path out of three. The Phase C chain is also now measured rather than assumed: DDB's hard "7776 before 7777" rule requires `container` config, which flips `:4337` to the arm that opens no PR (#254), which is blocked by #273 above. #254's claim that it is "not biting DailyBriefDashboard" is true only because DDB is currently out of compliance with its own promotion sequence. **Chain update, later the same day:** #273 and #276 are merged (`eba80415`, `d0d10478`) and #254 is still not shippable, for a new reason that is itself evidence for this row. `detectPriorBranch` nominates `run/254-wf19f7def7-rescue` — a #228 preservation branch whose own tip message reads *"NOT reviewed, do not merge"*, 8 commits behind main — and `ship.js:2931` makes the nomination the push target with no currency check, so the push is a non-fast-forward by ancestry (#185). Two safety mechanisms that do not know about each other compose into a blocker. That is the fifth distinct blocker on #254 across five attempts, and every one was found by attempting a run rather than by reading the code, which is the argument this row exists to make: a path nothing has executed is not a path anyone understands. **#185 and #254 both landed later the same day (`e313187f`, `333a199e`), on #254's sixth attempt.** The container path now opens a PR — proven by reintroducing the defect rather than trusting the suite's own mutant: overwriting `workflows/ship.js` with main's pre-fix copy turns the new suite 10 of 14 red. What remains between here and a DDB run is the tier floor (#215, in flight): `pages` is still read only as a reason to *lower* the tier and never to raise it, so the five subsystems above stay unexercised on this repo whatever else is fixed. The sixth blocker is worth recording because it was not a defect at all — `TDD_SEQUENCE_VIOLATED` refused a correct, verify-passing, security-clean implementation, and reading the transcript showed the refusal was *accurate* (source at step 17, test at step 36). It was redone test-first rather than merged by hand. A blocking grade that gets walked around when it is inconvenient is not a blocking grade, and this row is about whether the harness can be trusted somewhere other than here. **2026-10-14 (#214, merged):** the row's own argument applied one layer down, in config. Nine production reads named `.claude/rungate.json` and nothing else, so a consumer who followed the migration this repo documents got `{}` from all of them — no custom matchers, no roles for deterministic grading, no pre-flight SSH checks, no conformity run at task completion, and a worktree named `project` — silently, with no error and no warning in any of the five. Same shape as #310's tier control: **following the documented migration switched the features off.** They are now behind `lib/config-loader.ts` and asserted against both layouts over the same authored values, which is the only form of this assertion that cannot be satisfied by a reader that handles one layout. This is a decrement, not a close: `scanConfigAccess` reports 38 direct reads still live across 10 files (#307), and the number is banked in `.claude/config-access-ratchet.json` where it refuses in both directions. **2026-10-15 (#87, merged):** the same argument in the scaffold. Five sites answered "is this a TypeScript project" and disagreed, so a consumer with no hand-written TypeScript got no tsconfig from the generator that decided it needed none, and then a HARD `TSC-1` failure in its generated conformity suite over that same absent file — a check that could only fail, which is this row's subject from the other side. The fourth site wrote `bunx tsc --noEmit` into every consumer's `dev.typeCheck`, which `gates/gate-executor.ts` RUNS and which without a tsconfig prints 147 lines of help and exits 1, so the verify gate reported `Type check FAIL` at every consumer the rest of the scaffold had already excused. None of it could be noticed here, because rungate IS a TypeScript project — the three contradicting branches are all unreachable from the only repo this harness has ever run against. One decider now, and `typescript` is pinned exactly because `bunx tsc` was silently resolving the 7.0.2 Go port against a baseline that fails in both directions. |
| 6 — repos carry their own constraints | **No, and all three falsifiers are currently true (2026-10-16, #544/#545). Worse as of 2026-10-17 (#568): the pipeline is not merely unfinished, its output has a half-life.** `94384b93` on DailyBriefDashboard — *"apply 24 verified Hard Constraints from doc extraction"* — wrote them between the `AUTO-EXTRACTED` markers, human-verified. `a1b1a9f0`, a scaffold run, then removed the whole section: 82 insertions, 125 deletions, 37 constraint lines gone, including `ci` tests target 7777 only, `@destructive` tests on 7776 only, Supportable permanently disabled, and the `make rebuild` deploy rule. `problem-statement.md:22` names that section as **the only user-owned content that survives regeneration**, so the single thing the spec guarantees is the thing that was deleted — exit 0, `git status` showing `M` not `D`, which is #370's signature on a different file. The agent that deleted `force: true` from `context-orchestrator.ts` on 2026-10-16 was reading the AGENTS.md this bug had already emptied. SC-13 and SC-22 are both marked `[x]` and both assume the section survives, so every constraint SC downstream of the guarantee is currently unfalsifiable.** Measured on DailyBriefDashboard: constraint extraction produces **1,010 candidates, 0 promoted**, and scaffold never runs it at all — the only caller is conformity HYGIENE-6 with `apply: false`. A grep of DDB's `.claude/rules/` for its own hard constraints — `7776`, `7777`, `make rebuild`, `Supportable`, `scraper`, `Gemini`, `account-team` — returns **nothing**, while its `CLAUDE.md` carries 48 constraint-shaped lines in 261 and contributes 40 of the candidates nothing lands. Second falsifier: DDB's `checks-must-be-able-to-fail.md` is harness-**generated** (`generated-sha: 760e110af6d1d700`) and opens *"the single most common defect in this codebase's own tooling"* over five incidents from rungate's workflow sandbox — a prompt-immutability gate, a `require()` guard, a module-loading budget counter — none of which exist in a Bun dashboard. The baseline template has another repo's mined data baked into it. Third falsifier, measured the same day: an agent deleted `force: true` from DDB's `src/lib/context-orchestrator.ts`, a flag #1245 set deliberately for guaranteed-fresh signals, and recorded in its commit message that the call site had "opted out of the cooldown." Nothing in the repo contradicted it; a human caught it. The claim exists because that is this file's thesis failing in the field — an agent without a repo's own constraints produces work that must be re-measured by hand, which is the definition of an untrustworthy report. Also recorded: the four rungate rules files that provenance (#370) preserves as hand-edited were all written by ship-pipeline runs (#479, #445, #436, #360, #214, #342, #296, #88), so the "preserved" category is not a human tier — it is unmanaged mined content that accumulated by accident. |
| consumer list | **Surveyed 2026-10-08, and it fails — against software no consumer can obtain (#366).** Twelve blocking defects found by adversarial audit without running anything. See below. The survey measured the working tree at `main`; the published artifact was and is `rungate@0.2.1`, so the verdict is unattributable to any installable version. Re-running it against the installed package is blocked on #364 and is explicitly not done here. |

Last full suite measured on `origin/main` at `7ef0c533` (2026-10-17):
**11733 pass, 0 fail**, 13 skip, 474 todo, across 338 files — 12220 tests run.
Quote the pass count, not the run count; they differ by 487. That figure is the
floor, not the claim — see "What is not success". Read it together with claim 5
above: it is still a LIGHT-path number, and silence on the other two.

The mutation table below and the two paragraphs around it are the record for
`eba80415` (2026-10-11): **5077 pass, 0 fail**, 13 skip, 154 todo across 203
files. They are left as written because they are the evidence for the merges
they describe; they are not a statement about the current tree.

Against `f5a5d957` on 2026-10-10 (4339 / 4506 / 187): **+703 passing**, from
#261, #264, #267, #269 and #279 — five instances of one defect shape, a check
whose phase or whose subject has nothing to do with the thing it reports on. Mutations re-run by
hand on each branch before merge:

| mutation | effect, observed |
|---|---|
| the pre-validation producer removed | 3 of 5 red in `test/unit/evidence-prevalidation-gate.test.ts` |
| the producer moved after `runGateTests` | 1 of 5 — the presence case stays green, which is why the others exist |
| a bogus gate-runner path | 5 of 5, every one via the `MIN_GATE_CHECKS` guard rather than the assertion |
| `EVIDENCE_CWD` dropped from the producer | 2 of 9 red in `test/evidence-prevalidation-at-verify.test.ts` |
| the re-measure guard removed entirely | 3 of 9 — the heal path stops re-taking the reading |
| collect destination forced to `PROJECT_ROOT` | 1 of 69 — the `COMMIT_FAILED` that cost run `wf_19f7def7-1bf` everything |
| the `collectDestination` allowlist bypassed | 4 of 69 — traversal and unallowlisted paths reach `git add` |
| the `main`/`master` branch guard deleted | 1 of 69 — #136 reopened, caught rather than assumed |
| the AC-validation call site neutered | 1 of 21 in `test/discovery-ac-validation.test.ts` |
| the weak-threshold rule loosened | 4 of 21 — including the `>= 1` from run `wf_3335abda-d71` verbatim |
| the inlined copy made *stricter* than `ACSchema` | 1 of 21 — the direction a one-way parity test misses |
| the collect guard removed, annotation fix intact | 3 of 9 — a run that resolved zero files exits 0 again |
| annotation stripping removed, collect guard intact | 1 of 9 — the rest now refuse loudly, which is the point |
| `grepNoMatchIsResult` forced false | 3 of 8 — a zero-count AC reads broken exactly when the work succeeds |
| the grep last-stage restriction dropped | 1 of 8 — any command could buy amnesty by mentioning grep |
| the PR step gutted, its comment left in place | 2 of 6 on main after #273 — **0 of 6 before it**, which is the whole issue |

Earlier rows, retained because they are still the worked examples the rules
point at (measured against `c60a7b00`, +309 from #228, #227, #222, #224, #235
and #240 — claim audit and refusal preservation, agent timing, ship status
vocabulary, suite-to-commit binding, evidence pre-validation, and the TDD
check). Every one was merged only after the mutation its PR claimed was re-run
by hand on the branch and observed going red:

| mutation | effect, observed |
|---|---|
| `SINGLE_WORKTREE_EXEMPT = false` | `test/collect-claim-enforcement.test.ts` 36 pass → 31 pass / 5 fail |
| one `timedAgent(` reverted to `agent(` | `test/agent-timings.test.ts` 27 pass → 26 pass / 1 fail |
| `suiteVerdictViolations` → `return []` | 3 red across `test/suite-binding-mutation.test.ts` + `test/gate-vacuous-checks.test.ts` |
| `prevalidateEvidence` → `return []` | 5 red across `test/contract.test.ts` + `test/unit/evidence-prevalidation-gate.test.ts` |
| restore the unconditional `state = "wrote_test"` | 2 red in `test/tdd-checker.test.ts` |
| drop `gates/` from `SOURCE_DIRS` | 2 red in `test/tdd-checker.test.ts` |
| name the role only in a blocking refusal | 1 red in `test/blocking-grades.test.ts` |

A PR's own account of its mutation is the thing most worth re-running, not
least worth it — and on #234 the re-read caught a cited line that did not say
what the comment claimed, in a PR that was otherwise correct.

**A local green is not a CI green.** On 2026-10-09 `bun scripts/test-clean-env.ts`
reported 0 fail on a branch CI then failed with 11. The figure above is a local
`bun test`, and CI agreed with it on PR #236 — but agreeing once is not the same
as being able to disagree. Until #168 is closed, any locally measured figure is a
necessary condition and never a sufficient one.

### The consumer survey, 2026-10-08

Two adversarial sweeps audited the specs and the never-exercised consumer path
against the claims above. The verdict was **not ready**, and the reasoning is
worth keeping because it is specific:

> On DDB it would execute roughly 2.5% of the test suite, build no container,
> grade no container, discard the only measurement it makes against the
> committed tree, and then open a PR whose body states "Unit tests: PASS."

The worst of it, measured rather than inferred:

- DDB's `dev.testCmd` is `bun test src/**/*.test.ts` — **12 of 491 test files**,
  excluding the conformity test rungate itself scaffolded into DDB and every
  playwright spec DDB's own mandatory gate depends on.
- The container path keys off a `container` config key that **no schema defines,
  no generator emits, and DDB does not have** — so the harness composes its own
  `SKIP: no container` for rebuild, smoke and Quinn, and its ship gate accepts
  all three. DDB's `prod.rebuild` is set and never read.
- Nothing makes DDB non-LIGHT. The tier is only ever *downgraded* in code
  (`ship.js:990`); the upgrade is the discovery agent's free choice. A LIGHT
  verdict skips Quinn, container verify, B1 and B2, and the run still reports
  DONE.
- `runB2EvidenceValidation` is the **only** code that measures the committed
  tree. Its verdicts are written in memory and then discarded by a re-read from
  disk at `gate-executor.ts:1445`.

**Run 1 is an instrument, not a ship.** Low-stakes issue, PR not merged, every
reported number re-measured by hand once. If run 1 reports PASS and the numbers
cannot be independently reproduced, the conclusion is that the harness is still
lying — not that it worked.

## How to use this file

- **Filing an issue:** say which numbered claim it moves. An issue that moves
  none of them is cleanup, and should say so rather than borrowing urgency.
- **Reviewing a PR:** the bar is the claim it cites, not tidiness.
- **Running a sweep or an audit:** pass this file's claims in as the measure.
  A finding that cannot be tied to one of them is a style note.
- **Deciding we are done:** claims 1–5 green and the consumer list measured on a
  real run. Not before, and not by assertion.
