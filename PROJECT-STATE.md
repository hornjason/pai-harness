# Project State

**Current phase: All phases complete**

**Session 65 (2026-10-27)** — THE REQUIRED GATE HAD NO PRODUCER, AND THE REASON WAS NOT THE ONE WE FILED.

required_conversation_resolution is enforced on the consumer and reads review THREADS. Measured across every merged pull request there: zero threads, ever. So the protection was a required gate over a population that is always empty — green by construction, the vacuous-assertion shape sitting in branch protection.

#1612 was filed blaming a missing `pull-requests: write`. That was WRONG, both halves. lib/scaffold/steps.ts has granted it unconditionally since #1168 and rungate's own workflow carries all four permissions; the consumer carried two because it is 378 commits behind on the re-scaffold channel. The real gap: the grant exists for the LEDGER, which posts to issues/{n}/comments, and a review thread comes from pulls/{n}/comments — an endpoint nothing in lib/, scripts/ or bin/ called. Reading the generator instead of the consumer's file is what found it; the correction is on the issue.

#1613 merged (0b623381) builds the producer: reviewThreadRequests decides which findings become comments, postReviewThreads names what happened when they were sent, and a generated step runs the new ai-review-threads command between the reviewer and the adjudicator — the one slot that needs no `if:`, which lib/conformity.ts forbids on this job. Closes #1612.

THREE RESULTS WORTH CARRYING FORWARD, each a near-miss rather than a success:

1. The mutation battery found a vacuous assertion in its own test. Zeroing AI_REVIEW_THREADS_REFUSAL reddened NOTHING, because the refusal cases asserted toBe(AI_REVIEW_THREADS_REFUSAL) — comparing the constant the mutant edits to itself, so both sides moved together and 9 of 9 stayed green over a refusal that had stopped happening. Readable only by RUNNING the battery. Fixed with .not.toBe(0) beside it.

2. normaliseRepoPath lowercases, by design, because its job is to make two spellings of one path compare equal. The REST API matches the diff byte-for-byte and answers 422 on a case difference. It is the readability PREDICATE here and never the emitted value; the two requirements fit in one function only if you never notice they differ.

3. The generated YAML reaches consumers on merge and the npm release happens later from a tag, so the live workflow asks a published package for a subcommand it does not have. bin/rungate.ts answers with exit 1 and the literal `unknown command "<name>"`, which is the one signal separating 'the release has not landed' from 'the producer is broken'. Verified against the real published 0.8.6. Without that branch, merging #1613 would have reddened every pull request in every consumer until a release shipped.

AND THE DIRECTION MAY BE WRONG, which is the honest end of the session. .github/workflows/claude-review.yml already has Claude post a native GitHub review with inline threads via the GitHub MCP tools, and it ran green four times on 2026-10-19. Its header records why it is still workflow_dispatch: the fork guard reads inputs.pr. If Claude posts its own review, rungate does not need to post anything, and an unresolved thread — resolved by a HUMAN — is a better gate than a severity table the reviewer fills in itself. Jason chose that direction; #1613's producer stays in place, reporting UNMEASURED and exiting 0, until the promoted trial has run on real pull requests.

THE TRIAL RAN, AND THE DIRECTION ABOVE WAS RIGHT. #1614 promoted claude-review to every pull request. Everything after this point is that reviewer being used in anger, and the session's result is that it kept being correct about work I had already called finished.

CRC-N4 GOT ITS MEASUREMENT FROM THE SPEC THAT DEFINES CRC-N4'S EXIT CONDITION. #1616 gave every convergence phase a PR-observable exit condition and drew 11 reviewer threads in the process - for 3 distinct findings. A frontmatter date raised five times, a dangling self-reference to a superseded draft three times, a stale threshold in the PR body twice, plus one already-fixed carry. The reviewer re-raised the same findings across four rounds while the line numbers moved under them, so carry-forward could not tell they were the same finding. That is the strongest evidence yet for doing Increment 1 first and it was produced by the spec arguing with itself.

PHASE 0 WAS THEN MEASURED TWICE AND ONLY ONE READING IS WORTH ANYTHING. #1617 recorded the exit reading; #1622 found the swarm track's claim that the control had never been run was false and recorded a complete draw; #1625 recorded a second. What is NOT claimed: #1625's own BLOCKED-to-CLEAN transition is confounded - the thread resolved and ai-review flipped on a re-run in the same window - so it is not a third draw and the spec does not call it one. A draw in that document is a BLOCKED-to-CLEAN observation and nothing else, which is a reservation the spec now states rather than implies.

INCREMENT 1 SHIPPED HALF AND THE OTHER HALF CANNOT BE REVIEWED. #1618 made a posted thread carry the key it was raised under; #1620 made carry-forward decide from review threads instead of line text. #1621 (the suppression gate) and #1623 (its carry-forward half) both edit ai-review.yml, which means the AI review of the pull request that changes the AI review is red by construction. That is not a failure to fix - it is the one case the gate cannot adjudicate about itself - and clearing it needs a label only Jason applies. Applying it myself would be self-grading. #1619, #1621 and #1623 are open and waiting on exactly that.

PHASE 2 IS UNMEASURED, NOT PENDING. ai-review-threads posts the threads BEFORE ai-review-findings reads the ballot - poster at L3323, adjudicator at L3587 - so a quorum cannot suppress a thread it has already published. Until that ordering is fixed, any Phase 2 reading describes a mechanism that was never in the path. Saying 'pending' would imply the measurement is merely owed; it is not takeable.

AND #1624 COST SIX REVIEW ROUNDS WHERE EVERY FINDING WAS MINE. DOC-DIST refuses a document that states in prose how far away one of its own parts is. The deciding measurement was 19 distance claims in the tree of which 17 are legitimate facts about OTHER files, so a blanket ban would have bought seventeen false positives for two real ones - the signal is the deictic referent, not the distance. What the rounds found is the part worth keeping: round 3 widened the match window and reintroduced the exact false-positive class the module had been narrowed to avoid, round 4 was spent undoing it, round 5 found the block markers looser than CommonMark in the other direction. Two consecutive widenings, two shipped defects, each found by the reviewer and not by me. The module now declares its limits as asserted test rows that go red if somebody widens the rule, instead of widening a third time.

THE LAST ROUND IS THE ONE THAT GENERALISES. Re-admitting 'a' and 'an' to the quantity vocabulary changes the violation count across all 205 tracked markdown files by zero. So round 3's removal of them was decided by a sentence somebody constructed in a review comment, not by anything in this repository, and the instruction reading ('Add a line above this heading') and the claim reading ('A note sits a line above this heading') are the same bytes to this detector. No setting of that switch is correct. An enumerated vocabulary is a closed list over an open language, and the honest response is to name the limit and assert it, which is what the two existing declared limits in that module already do.

HOUSEKEEPING THAT WAS NOT HOUSEKEEPING: this file being stale turned test-shard 1 red on every pull request opened after #1625 merged, which is the guard doing exactly its job - it was written because eight commits and four merges once went by with the state file reporting success.

Suite: No full local suite: other sessions were running suites and .claude/rules/parallel-sessions.md forbids a concurrent full run. Targeted instead — every test/ai-review-*.test.ts (1354 pass, 0 fail), the census set scripts/census-routing.ts derived for the diff (1682 pass, 0 fail), and typecheck at 0 errors matching baseline. The pre-push conformity gate ran 1419 tests on each push and passed.
Issues opened: 1612
Issues closed: 1612

Read this before anything else. The suite is green under a CLEAN ENVIRONMENT, which is a stronger claim than the one this file made yesterday — run `bun scripts/test-clean-env.ts`, not `bun test`, before believing any gate. Plain `bun test` passes on this machine for reasons that have nothing to do with the code.

Pattern of the week, now found seven ways: checks that confirm something EXISTS rather than that it WORKS. Yesterday's five, plus two more from #71 — a test that stat'd a .gate-salt path abandoned in an earlier refactor and passed only because a leftover file sat on the developer's disk, and a documented `bunx tsc --noEmit` that had never type-checked a single file because no tsconfig.json existed.

The generalisable lesson from #71: when local and CI disagree, do not triage the failures one by one. Ask what the two environments differ by, remove it locally, and let the suite produce the list. My six-bucket hand triage was right about 28 of 28 failures but would have missed the eight tests that were passing on readdir order and the cluster that reports green while asserting nothing — the lever found those, the triage did not.
Suite: 25/25 SCs done.

**Next priorities:**
1. SCOPE LOCK (2026-10-23): all work is locked to specs/CODE-REVIEW-CONVERGENCE-SPEC.md. The build order is the section 'The order to build the remainder in' in that spec (landed via PR #1466). Do not pick criteria opportunistically — that is what produced three sessions in a row that ended in an analysis comment instead of code.
2. THE NUMBER THIS MOVES. Measured 2026-10-23 over the 44 most recent PRs that carried a ledger: passed-after-one-round 39.4% (blog before 65%, after 78%); five-or-more-rounds 20.5% (8.9% / 1.5%); mean rounds-to-pass 2.64 (2.08 / 1.32). We are WORSE than the state the source improved from, on all three. The tail is the damage, not the median — 20.5% is over twice their starting figure while the mean is only a quarter above it.
3. THE BACKLOG IS 30, NOT 47. Of the unticked criteria: 8 are mechanisms this tree cannot observe, 4 cannot be meaningful in this deployment (one human, one consumer), 2 are declared deviations, 3 are repository settings. Only 30 are engineering. The spec carried that split across four tables and nobody had summed them.
4. PHASE 0 — BLOCKED ON THE OWNER, NOT ON ENGINEERING. Three branch-protection settings, no code: CRC-F1 (strict:true), CRC-C3 (required_conversation_resolution), CRC-E8 (required_pull_request_reviews with dismiss_stale_reviews). First because CRC-E6 and CRC-M9 are VACUOUS rather than unbuilt until they land — there is no approval to count, so nothing can be built that counts one. Read CRC-F1's caveat before flipping it: a merge queue serialises merges, and on merge_group the review annotates UNMEASURED and passes, so 'every check' would be half true; strict:true is the cheaper half and closes the same hole.
5. PHASE 1 — STOP THE REPEATS. CRC-N4 (no repeats) depends on nothing and is the single highest-value item in the document: lib/ai-review-rounds.ts exports readLedger, priorFindings, carryForward, suppressRepeats, noRepeatsInstruction, atCapInstruction and reviewScopeForRound with ZERO production callers between the seven — every caller is a test. It is wiring, not design. A finding re-posted every round is arithmetically an extra round. Then CRC-B7 (needs the changed-file list reaching the adjudicator, then a release) and CRC-N2 (depends on N4; it is a declared deviation only until carryForward has a production caller).
6. PHASE 2 — STOP THE FALSE FINDINGS. CRC-B4 (verifier quorum) depends on nothing: lib/finding-jury.ts holds group size, quorum, per-verifier votes and a disagreement flag, and nothing deployed takes a vote. Then CRC-B6 (A/B the filters, variance bounded) and CRC-B3 (parallel generation) — B3 STRICTLY after B4, because without a quorum N generators are N chances to block falsely, which is worse than one. Run 39962683401 is the measured instance: a same-tree pair that disagreed BLOCKED/CLEAN with the false positive on the blocking side.
7. PHASES 3-6, in order and lower value. P3 what the reviewer is told (CRC-A4, B2, B9, A7) — sequenced after P2 on purpose, because context without a falsification step produces more confident false premises. P4 findings get answered (CRC-B8, A8, A2, A1, A3). P5 the instruments (CRC-M6, M10, M1, M3, M4, M5, M7, E3, E9). P6 release and detection (CRC-F3, F4, F5, N5, H2) — last because none of them moves rounds-to-pass.
8. WHAT WOULD FALSIFY THE PHASE ORDER. Re-take the CRC-M11 reading now #1449 and #1452 have landed. The 2.64 was measured across a harness defect that raised a blocking finding on EVERY pull request editing .claude/ or CLAUDE.md, which in this repository is how conventions ship. If the tail collapses on its own, Phases 1 and 2 are ordered against a baseline that no longer exists and the argument has to be made again rather than inherited.
9. RELEASE: DO NOT CUT ONE YET. npm serves rungate@0.8.2, published 2026-10-23T14:04:13Z; v0.8.2 was tagged 13:44:28Z; main has taken ~78 commits since. The ONLY dormant surface is lib/scaffold/ai-review-findings.ts and what it imports, because `bunx rungate@0.8.2 ai-review-findings` is the single pinned call in CI — everything else reaches CI live, either through `bun test` from the checkout or through committed generated YAML. So CRC-B7 (#1435) is dormant and CRC-B1 (#1387) is LIVE. A release now still activates nothing: main() takes the changed-file list as argv[1] and the generated step passes one argument, so CRC-B7 published is still inert. Correct order is #1356 first, then a release, then re-measure. See the comment on #1226.

## ⬜ Code Review Convergence (CRC) — the active plan (NOT STARTED)

## ✅ Phase 0+1 — Scaffold + Knowledge Extraction (COMPLETE)

## ✅ Phase 1.5 — Context Quality + Config-Driven Testing (A-H) (COMPLETE)

## ✅ Brief Compliance + Agent Brief Templates (COMPLETE)

## ✅ Instruction Compliance — Grading Pipeline (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-465 | Every directive has category (quality|process) |
| ✅ | SC-466 | Context/Always Do/Ask First → process |
| ✅ | SC-467 | All other sections → quality |
| ✅ | SC-468 | process_overrides frontmatter |

## ⬜ AES Quality Gate + Pipeline Optimization (NOT STARTED)

## ✅ Scaffold Decomposition (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-358 | lib/scanner.ts with ProjectScan interface |
| ✅ | SC-359 | Scanner detects tech, specs, consumers, dirs |
| ✅ | SC-360 | AGENTS.md generator from ProjectScan |
| ✅ | SC-361 | Brief generator reads template files |
| ✅ | SC-362 | CODE-MAP generator from ProjectScan |
| ✅ | SC-363 | scaffold-project.ts under 200 lines |
| ✅ | SC-364 | Identical output before and after |
| ✅ | SC-365 | Scanner importable without generation |
| ✅ | SC-366 | Generators testable with mock data |

## ✅ Hook Architecture (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-367 | AgentBriefGuard under 50 lines |
| ✅ | SC-368 | lib/brief-validator.ts independently testable |
| ✅ | SC-369 | GateEnforcement under 100 lines |
| ✅ | SC-370 | Every hook traces to an SC |
| ✅ | SC-371 | No hook over 150 lines |
| ✅ | SC-372 | Hook logic in lib/ has unit tests |

## ✅ Gate Contracts (COMPLETE)

| Status | SC | What |
|---|---|---|
| ✅ | SC-373 | Every gate has typed input/output |
| ✅ | SC-374 | Pass/fail criteria documented as SCs |
| ✅ | SC-375 | Gate chain order documented |
| ✅ | SC-376 | run-gate.ts under 400 lines |
| ✅ | SC-377 | Contracts testable by conformity engine |
| ✅ | SC-378 | No implicit state passing |

---

**Session 2026-10-25 session 64:**
- NOTHING THIS PROJECT SHIPPED IN THE PRECEDING FIVE DAYS WAS RUNNING. That is the session's result, and it was found by accident while trying to measure something else.

Five PRs merged (#1597, #1602, #1603, #1604, #1605), and #1597 closes #1595. Two open and blocked on this file: #1606, #1607. #1600 and #1601 stay OPEN — #1602 carries their work and neither is finished.

THE LIVE HOOKS WERE 32 COMMITS BEHIND. `RUNGATE_HOOKS_DIR` resolved to a hand-maintained tree pinned at `2729ce62` containing zero occurrences of `COMMENT_INSTEAD` or `FILINGS_PER_RUN`. So #1597, #1603 and #1604 were merged, closed, green, and dormant. The control that makes this a measurement rather than a grep: the refusal vocabulary that tree CAN emit — DUPLICATE, NO_CLAIM, DROPPED_CATEGORY, NO_QUORUM, UNMEASURED — is exactly the set present in all 261 ledger rows, which rules out `the mechanism fired and was not recorded`. This is session 58's lesson recurring at 32 commits instead of 14, and `lib/hook-tree-currency.ts` had already written it up: *a hook that is absent and a hook that is fourteen commits old produce the same observation*.

THE GUARD FOR IT EXISTED AND HAD NEVER RUN. `hooks/HookCurrency.hook.ts` is registered in this repo's committed `.claude/settings.json` at project scope — and project-scoped hooks are gated behind workspace trust, so it was green, registered and inert, exactly as #1578 found TopLevelCdGuard to be. Registering it at user scope made it fire on the first session and it immediately returned three findings nobody was looking for. Four more hooks are still in that state: AgentBriefGuard, BunTestPathGuard, SpecSCGuard, WorkflowStateGuard.

AND `${CLAUDE_PROJECT_DIR}` DOES NOT FOLLOW A WORKTREE — it stays at the project root where the session started. So every project-scoped registration was executing the PRIMARY CHECKOUT's copy, and the primary checkout was at `bc56a7c2`, 393 commits behind, with three files uncommitted for five days. Its `.git/hooks/pre-commit` was stale enough that the secret scanner was missing 5 of the 13 expressions `lib/secret-patterns.ts` declares — jwt and the tier2/tier3 patterns — so every commit made from that checkout for five days went unscanned for them. The uncommitted work (+361 lines, no deletions, `lib/config-readers.ts` grown 86 to 182 and a 252-line test with no equivalent on main) was preserved as `rescue/main-checkout-wip-20261025` BEFORE the fast-forward, and still needs a real rebase before any of it is proposed.

THE SUCCESS CRITERION WAS MEASURING THE WRONG THING, AND THAT IS THE MOST REUSABLE FINDING. The filing cap REFUSES AND INSTRUCTS — it tells the agent to post a comment; it does not post it. So issues-created-per-day falls identically whether the agent complies or drops the finding on the floor, and the failure reads slightly BETTER because the issue is never created. A metric blind to its own bad outcome is not a criterion. #1607 replaces it: compliance per refusal, with `rate` typed `number | null` so a denominator of zero cannot render as a rate of zero, and `compliedUpperBound` rather than `complied` because the ledger records no attempting agent. Today's reading is 9 observable, all of them DUPLICATE, upper bound 2; for OVER_CAP and COMMENT_INSTEAD the denominator is zero and the rate is null. The instrument's own first reading was its own defect — `duplicateOf` holds decimal STRINGS and the parser accepted only numbers, returning the honest-looking 0 the module exists to refuse.

THE BELT NUMBER IS 14%, NOT 52%. Issues created fell 125 to 60 across the window, but PRs created fell 128 to 71 over the same days — the drop is throughput, not the gate. Issues per PR went 0.98 to 0.83 to 0.85, matched independently by the ledger's own 10.4% net suppression. Two further cautions on any figure taken from `~/.rungate/finding-ledger.jsonl`: 41% of its 261 rows are TEST FIXTURES written by the suite to a real user-level path outside any repo, and `overridden` cannot distinguish an agent correcting a wrong refusal from an agent evading a right one — both are DROP to ALLOW with a changed hash. An earlier claim of `8 walk-arounds, 2 by hash-shopping` was RETRACTED after reading the duplicate targets: both verdicts were false positives (#1520 against #1506, #1455 against #1046 — not the same findings), so zero of the three non-label cases are evasions and roughly 2-3 of 10 DUPLICATE verdicts are wrong.

THE FILING GATE'S BYPASS, FOUND BY EXECUTION TWICE. #1605 made COMMENT_INSTEAD unwaivable; the push security review then found that COMMENT_INSTEAD is adjudicated LAST, after NO_CLAIM, so an undeclared AND claimless filing is refused NO_CLAIM, the label waives that, and the unwaivable member is never consulted. Confirmed by running the real hook process against the PR's own head — `Allowed by --label arbiter-override, over a NO_CLAIM refusal`, disposition ISSUE, overridden true — then closed by reading `exemption` off the ATTEMPT instead of keying on whichever refusal fired first, and re-confirmed as `decision: block` on the merged tree. FG-178 was red against the unchanged head before the fix. The repo already held a passing test certifying the bypass: FG-88's old title was, verbatim, *the override label posts a claimless filing, and is counted*.

THREE REPAIRS IN ONE NIGHT EACH LEFT A SIBLING, BECAUSE EACH NAMED A SITE. The waivable tail, then three map-discriminating rows of which one was fixed and two were found by the reviewer, then the NO_CLAIM reason string. #1606 stops repairing sites and asserts the property: FG-179 drives four refusals through the real adjudicator and asserts no reason spells the override token — through the adjudicator rather than a source grep, and the argument for that is an instance from this session, where a grep of main for the advertising string returned 0 while a probe had printed it ten minutes earlier, because the string is assembled across a concatenation.

CRC-N2 AND THE CARRY ANCHOR LANDED AS #1602. The carry is now content-addressed, and the diff-only narrowing is adopted with its checkbox deliberately unticked, because what shipped is a scope WORD and whether the reviewer obeys it is UNMEASURED. Its reach was re-measured per round against the ledger as the carry would have read it at that round: 12 rounds of 333, 3.6%, not the 21% a final-ledger reading suggested. The second chance a full-scope round gives a dropped finding was quantified for the first time — 33 distinct defects dropped, 2 raised again, about 3%.

ALSO CORRECTED: CRC-N4's dedupe is in the CI pin as of the 0.8.5 publish, so the spec's `dormant until the pin moves` is false at three sites — though a cwd of `${RUNNER_TEMP}` means every line lookup fails and the key spaces cannot intersect, so it is live and inert, fail-safe. And the spec's organizing premise — *Anthropic has no review backlog because findings never become backlog; there is no filing step* — is NOT in the source blog post, which never uses the words backlog, tracker or ticket. An adversarial fidelity audit found 1 invented of 56 criteria, 6 dropped (Layer 4 entirely), 5 mis-stated, and all 5 numbers exact.

STILL OPEN AND NOT THIS SESSION'S TO DECIDE: whether rungate's consumer hooks move to PLUGIN delivery. Writing registrations into a consumer's `.claude/settings.local.json` is not a documented mechanism for shipping hooks, and project-scoped hooks are trust-gated there too — so on install today a consumer either grants trust or gets hooks that are silently inert, which is this session's own failure shipped to someone else's machine.

**Session 2026-10-24 session 62:**
- 41% OF OUR REVIEW ROUNDS ARE ROUNDS IN WHICH NO REVIEW HAPPENED, and that is now measured, written into the spec, and discriminated automatically at the library level.

#1485 merged (fae946a6) carries the finding. 117 rounds across 45 PRs: 69 measured, 48 unmeasured (41.0%). 18 of 45 PRs are hit and 6 never measured at all. The same population read two ways gives mean rounds-to-pass 2.65 over all rounds against 1.58 over measured rounds only, one-round pass 44.2% against 62.8%, five-plus 20.0% against 4.4%. So 2.65 and CRC-M11's 1.32 target are DIFFERENT UNITS — 2.65 is what a developer pays and 1.32 is review convergence — and reporting one against the other is the error the spec now names. The decline/no-payload split we quote is an UPPER BOUND on each, not a reading.

#1487 merged (d5fa0ea1, closes #1486): lib/ai-review-unmeasured.ts decides which kind of unmeasured a round was — a structural decline (#1455), the no-payload tax (#1478), or a log it could not read — and refuses to collapse the third into either of the first two. scripts/record-ai-review-unmeasured.ts has written to production: #1354 took 8 rounds, 5 newly classified, no_payload 1 and declined 4; #1470 took 5 rounds, 5 classified, declined 5. The ledger field to read is `measured`, never `findings !== null`.

#1489 merged (f1fe27cf) re-landed three fixes that MISSED #1487's auto-merge, and the miss was mine. My brief told the agent to open a PR and enable auto-merge, which raced the agent's own next push: #1487 merged at 03:04:13Z on head 9b1ecf17 while d7088ba6 was still being written. A squash merge never moves the branch ref, so a later push exits 0 and orphans the commit and --force-with-lease cannot catch it. The brief now says the opposite — an agent reports its PR number and head SHA and stops, and the DA does the non-author read and the pinned merge. The three fixes: the ledger was being re-serialised with JSON.stringify(doc, null, 2) while buildPersistScript writes with jq -c, inflating a 12-round window against a 65,536-character comment limit (measured 1393 against 1011 characters on #1470); AC-U8 now asserts the fenced block contains no newline AND round-trips through JSON.parse; and test/evidence-portability.test.ts's #338 row got its refusal back, scoped to .archive, after both its original assertion and my suggested replacement were measured unsound on a runner.

THREE OF MY OWN READINGS WERE WRONG THIS SESSION AND ALL THREE ARE CORRECTED IN THE RECORD. (1) A hand-rolled ledger parser using indexOf("```json") from position 0 silently returned 0 rounds for 17 of 43 PRs; it was caught only because my mean of 1.67 disagreed with summariseRoundsToPass on the same input, which is the whole argument for keeping a second instrument. (2) I tested findings !== null on a parsed object whose parser normalises null to [], so every round read as measured and the unmeasured count came back 0 — an assertion that could not fail. (3) I attributed the 48 unmeasured rounds to whether a PR touched ai-review.yml, when #1455 had already measured that a PR which never touches that file declines identically the moment main's copy moves. Withdrawn in a979616c and in comments on #1485 and #1478.

THE MUTATION BATTERY FOUND ITS OWN BLIND SPOT, which is the one result here worth carrying forward. Ten rows, nine matching prediction; the row that did not was the decline marker mutated by one character, predicted 3 and observed 1. The fixture INTERPOLATED the constant, so mutating the constant moved the fixture with it — prediction and battery shared a blind spot, exactly the seventh shape in checks-must-be-able-to-fail.md, and only predicting the NUMBER rather than the direction could have surfaced it. Fixed by pasting a decline line verbatim out of run 40047304108's log; the row then reddens 2, still not the predicted 3, and that residual is unexplained rather than resolved. Also named and not fixed: NO_PAYLOAD's boundary is wider than its name, because an unparseable payload carries no skip line either and lands in the same bucket; separating them needs a second positive marker.

#1488 is filed and claimed: run the classifier automatically on workflow_run: completed. No step inside the ai-review job can read its own log — measured, `gh run view --job <id> --log` on a running job returns "still in progress" — so it has to be a second workflow. It is urgent for a reason that has nothing to do with priority: Actions logs expire, and every round whose log ages out loses its discriminator permanently. That is CRC-B4's argument about recording before acting, in the one form where re-running cannot recover the reading.
- Targeted only; the standing rule against bare full local runs held, and other sessions were running suites throughout. CI is the suite of record for all three merges: #1485, #1487 and #1489 each went green on all four shards. #1489's ai-review was verified a REAL review rather than inferred from its exit code — the full job log, not --log-failed, with the skip line absent across all 5,172 lines, AI_REVIEW_ACTION_OUTCOME: success, and the `ai-review findings outcome: CLEAN` annotation present. 6m53s, the longest run we have measured, and the duration was not what decided it.

**Session 2026-10-24 session 61:**
- Phase 2's head of the CRC build order shipped, and the CRC-M11 re-take says the plan's ordering survives.

#1480 merged (5dd93ef4, closes #1476): lib/ai-review-jury.ts is the FIRST deployed caller of the finding jury. arbitrate had one caller in the tree and it was hand-run; the spec's own entry said 'nothing deployed takes a vote'. Now every finding that would otherwise BLOCK gets a per-verifier ballot read, and every vote plus the agreement count plus the disagreement flag reaches the finding ledger at decision time. IT RECORDS AND DOES NOT SUBTRACT — a finding the group votes down still blocks — and that was my call, pre-authorised, with #1476 amended to say so rather than letting the PR look short against a brief written before any of it was known. Two structural prerequisites block the deciding half and both are now #1481: AI_REVIEW_DENY_RULES denies Task so one invocation cannot convene a group, and the verifier reads the head checkout so a demoting ballot is a gate the branch under review can write.

THE REVIEW CAUGHT WHAT MY OWN NON-AUTHOR READ MISSED. ai-review raised one blocking finding against readBallotDirectory: it merged a verifier file's whole votes array, so one file carrying VERIFIER_GROUP_SIZE votes satisfied the quorum and INCOMPLETE_GROUP never fired. That is CRC-B4's named counterfeit arriving through the file format, and it falsified the cardinality claim the whole recording-only design rests on. I had read that function, confirmed the merge loops over files, and signed it off — I verified the structure and not the quantity. Fixed by refusing, not truncating, with JG-4i as the positive control. My own finding on the same PR: main called the injected gate outside any try, so a throwing gate exits non-zero ABOVE the outcome marker the generated step greps for. Both were docblocks asserting properties the code lacked, in the PR that writes that pattern down. The agent then found a third itself — its own JG-6h draft was vacuous, because a CLEAN payload never reaches the gate — and rewrote it as a call count with a positive control.

THE CRC-M11 RE-TAKE, which the spec names as 'the thing that would make this plan wrong' (#1483). 45 PRs, 45 measured, 0 unmeasured, 0 ledgers truncated: 2.65 mean, 20.0% at five-plus rounds, 44.2% one-round pass, against 2.64 / 20.5% / 39.4%. The tail did NOT collapse, so Phases 1 and 2 keep their ordering. What is worth more than the headline is the split I nearly reported: cutting the same population at the moment #1449/#1452 landed gives 76.9% one-round pass post-fix against 30.0% pre — a 47-point move landing one point under the source's target, i.e. exactly the result that would have invalidated the plan. It is an artefact of cohort age. Pre-fix spans 4.5-9.2h old, post-fix 0.5-4.1h, and rounds accumulate with age. Counting rounds inside a fixed window from each PR's OWN creation and including only those that reached it, the improvement is absent: 0.81 vs 1.75 at 1h (n 31/12), 0.84 vs 1.67 at 2h (n 31/9). The re-take instruction is now a worked example of its own failure mode — it said 'after #1449 and #1452 land', a question about a merge, and meant 'after the population turned over', a question about elapsed time.

#1479 merged (4af34857, closes #1473) after a non-author read: the scratch-roots parse could not see join(import.meta.dir, ...) used inline, and the deletion-allowlist widening was justified by a measurement rather than an argument. Two findings came out of it as prose. #1482 is the one I filed: repoRootIdents classifies an mkdtemp'd directory as a repo root, inverting the claim in its own docblock. I first recommended the wrong fix value there — listing .y- in the prefix list — and a peer caught it; cleanupScratchDirs reads the repo root only, so that would have widened a recursive-delete allowlist over a name nothing plants there. Corrected on the issue rather than edited away. The membership rule has to be defined by the CONSUMER, not by the declaration, which is the same error as the original defect one level up.

#1478 gained its second observation and a control it never had: the same pull request produced a real 6m9s review at one commit and a no-payload run at the next, 90 lines apart, same branch, credential, workflow and prompt. subtype success, is_error false, 53/80 turns, $1.32. That rules out everything static and leaves the reviewer's own run-to-run behaviour, which makes it a sampled instrument failing to emit. It also means some unknown share of our 2.64 is instrument rather than disagreement — the same measurement problem #1380 raises from the other side.
- Targeted only; the standing rule against bare full local runs held. test/agents-md-spec-listing.test.ts + test/spec-requirements.test.ts (18 pass, 0 fail) and test/line-citation-ratchet.test.ts + test/instruction-surface-budget.test.ts (63 pass, 0 fail), derived from `bun scripts/census-routing.ts` rather than remembered. CI is the suite of record for both merges: #1479 and #1480 each went green on all four shards.

