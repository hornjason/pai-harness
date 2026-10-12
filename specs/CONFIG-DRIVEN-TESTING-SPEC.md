---
doc-type: spec
status: active
owner: jason
created: 2026-09-21
updated: 2026-09-21
governs: Test architecture — config-driven testing, matcher expansion, zero SC fallthrough, phase test migration
testable: true
compliance: strict
---

# Config-Driven Testing

## Problem Statement

Two parallel test systems exist: the conformity engine (config-driven, auto-discovers SCs from specs) and hand-wired phase test files (2,657 lines of manual assertions). When you add an SC to a spec, the conformity engine picks it up automatically — but many SCs don't match any pattern and fall through. Those get hand-wired in phase files, creating a maintenance burden where adding an SC means editing both a spec and a test file.

The goal: for static file verification SCs, editing a spec is the only action needed. Zero fallthrough for static checks. Behavioral SCs (runtime actions, session behavior) route to the transcript auditor instead.

## Design Decisions

| Decision | What | Rationale |
|---|---|---|
| D-1 | Expand matchPattern() matcher library to cover all static file verification SCs | Current 13 matchers leave many static SCs unmatched. New matchers cheaper than maintaining hand-wired tests |
| D-2 | Phase-0 stays integration-heavy (~200 lines), phases 2/3/5 become thin consumers | Phase-0 has circular dependency (validates config format). Phases 2/3/5 are simpler single-concern checks |
| D-3 | Source-code checks (phase 2/3/5) get a source-contains matcher | "Does harness source contain X" is a valid conformity check, just a different target than scaffold output |
| D-4 | Fixture staleness is a test failure, not a silent gap | SCs referencing files the golden fixture doesn't produce = red test. No silent coverage gaps |
| D-5 | matchPattern() fallthrough is a test failure in strict mode (deferred) | Requires behavioral SCs to be classified and excluded first. Enable after D-6 lands |
| D-6 | Behavioral SCs route to transcript auditor, not file matchers | Runtime behavior ("session-end checks for X") verified by SESSION-AUDIT-SPEC tooling, not matchPattern(). Rewrite hook-wiring SCs as static checks where the artifact exists |
| D-7 | Matcher registry config is single source of truth for all patterns | One config drives matchPattern(), SPEC-TEMPLATE, create-spec, audit tools, and consumer extensions. No manual sync between code and documentation |
| D-8 | SCs are structured data, not freeform prose | Agents are the primary spec authors. A CLI tool (`rungate create-sc`) accepts pattern + params and generates the SC text. The tool carries the knowledge — agents don't need pattern docs in context. Guaranteed matchable by construction |
| D-9 | `rungate audit-specs --fix` migrates legacy SCs | Existing specs (RunGate and consumers) have freeform SCs written before enforcement. The audit tool classifies each SC, proposes a matchable rewrite, and applies it in-place. Human confirms ambiguous cases |
| D-10 | Permissive → strict is a per-spec gate, not a global switch | Each spec flips to `compliance: strict` only after audit-specs reports 100% matched. Prevents partial migration from breaking the suite |

## Target State

1. Every static file verification SC in `testable: true` specs auto-generates a test via the conformity engine
2. Phase-2/3/5 test files are thin consumers (≤100 lines each). Phase-0 is ~200 lines (integration nature). Phase-1 migrated proportionally
3. Adding a static SC = editing the spec. No test file edits. matchPattern() handles it
4. Behavioral SCs are classified and routed to SESSION-AUDIT-SPEC transcript auditor
5. Golden fixture has a staleness check — SCs referencing files the fixture doesn't cover are red
6. Hook-wiring SCs rewritten as static checks where the artifact exists (e.g., "hook file contains [script-name]")
7. SCs are created via `rungate create-sc` CLI — agents pick a pattern + params, tool generates matchable SC text. No freeform prose
8. Legacy specs migrated via `rungate audit-specs --fix` — all existing SCs converted to matchable patterns or tagged behavioral
9. All testable specs at `compliance: strict` — zero unmatched SCs anywhere

## New Matchers Required

| Matcher | Pattern | Covers |
|---|---|---|
| regex-match | `X matches /pattern/` | Phase 2/3 keyword checks in source files |
| source-contains | `harness {file} contains [keywords]` | Phase 2/3/5 source code presence checks |
| json-has-field | `{file}.json has field {name}` | Phase 0 JSON structure checks |
| scaffold-produces | `scaffold output {file} exists` | Phase 0 integration — check scaffold output, not static project |
| frontmatter-field | `{file} frontmatter has {field} = {value}` | Phase 5 agent file checks |
| file-line-range | `{file} is between [N] and [M] lines` | Line count range checks beyond simple threshold |

## Success Criteria

- [ ] SC-331: matchPattern() returns non-null for all static SCs in testable strict specs (behavioral)
- [x] SC-332: test/phase-0.test.ts contains [runScaffoldConformity]
- [x] SC-333: test/phase-2.test.ts is under [100] lines
- [x] SC-334: test/phase-3.test.ts is under [100] lines
- [x] SC-335: test/phase-5.test.ts is under [100] lines
- [x] SC-336: harness lib/conformity.ts contains [regex-match]
- [x] SC-337: harness lib/conformity.ts contains [source-contains]
- [x] SC-338: harness lib/conformity.ts contains [json-has-field]
- [x] SC-339: harness lib/conformity.ts contains [scaffold-produces]
- [x] SC-340: harness lib/conformity.ts contains [frontmatter-field]
- [x] SC-341: Golden fixture staleness check — SCs referencing files not in fixture output = FAIL
- [x] SC-342: Adding a new static SC to a testable spec and running `bun test` produces a test without editing any test file
- [x] SC-343: Phase-1.5 tests remain as conformity engine unit tests (behavioral)
- [x] SC-344: test/phase-1.test.ts is under [200] lines
- [ ] SC-345: Every SC in testable specs classified as static or behavioral (behavioral)
- [ ] SC-346: Behavioral SCs have verification: behavioral tag and route to SESSION-AUDIT-SPEC (behavioral)
- [ ] SC-347: Hook-wiring SCs rewritten as static checks where artifact exists (behavioral)
- [x] SC-379: config/matcher-registry.json exists
- [x] SC-380: lib/conformity.ts contains [loadRegistry, matcherHandlers]
- [x] SC-381: SPEC-TEMPLATE pattern reference auto-generated from matcher config (behavioral)
- [x] SC-382: create-spec.ts validates every SC against matchPattern() at write time — unmatched SCs block save with suggested rewrite
- [x] SC-383: `rungate audit-specs` reads all specs, classifies every SC as matched/unmatched/behavioral, and auto-rewrites unmatched SCs to matchable patterns
- [x] SC-384: Consumers can extend matcher config with custom matchers for their domain (behavioral)
- [x] SC-393: `rungate audit-specs --fix` rewrites unmatched SCs in-place to matchable patterns — flags ambiguous cases for human review
- [x] SC-394: lib/scaffold/steps.ts contains [auditSpecs] — SCAFFOLD-DECOMPOSITION-SPEC moved the step bodies out of the 200-line entry point; the SC still named the entry point
- [x] SC-395: Consumers running create-spec get SC validation identical to RunGate's own (behavioral)
- [x] SC-396: `rungate create-sc` CLI accepts `--pattern` and `--params` — generates SC text from structured input, no freeform prose
- [x] SC-397: `rungate create-sc --list` shows all available patterns with syntax and examples from matcher registry config
- [x] SC-398: All RunGate specs at compliance: strict — zero unmatched SCs (behavioral)
- [x] SC-399: AGENTS.md Commands table includes `rungate create-sc` — one-line instruction, no pattern docs needed in agent context

### The generator read a different repository (#141)

`scripts/sync-spec-tests.ts` computed its own harness root —
`process.env.HARNESS_ROOT || ~/.claude` — and looked for specs in `PAI/Specs`.
Nothing exports `HARNESS_ROOT`, so the default applied and it read
`~/.claude/PAI/Specs` and wrote `~/.claude/test/`, while `lib/paths.ts`
`harnessRoot()` resolved to this checkout. Both directories exist, so it read a
real spec tree and wrote a real test file on every gate, and reported success.

One correction to how this was first described: fixing the path does NOT make
success criteria generate tests, because this generator never did that. It
extracts four hardcoded claim shapes — `` `make x` ``, `**GATE:**`, ports, and
Quinn plus a verb. SC-to-test is `scripts/sync-sc-status.ts`, which reads
`specs/` correctly and always has. What was lost was the claim extraction, on
18 testable specs.

- [x] SC-544: scripts/sync-spec-tests.ts contains [resolveSyncPaths, harnessRoot, "specs"]
- [x] SC-545: scripts/sync-spec-tests.ts contains [import.meta.main] — importing it for its path helpers must not rewrite a test file
- [x] SC-546: test/sync-spec-tests-paths.test.ts contains [a file with no cases explains why, and one with cases reads its own tree] — a generated file carrying cases must resolve paths at run time instead of baking in whoever last ran it, and one carrying none must say so; the assertion moved off the generated file itself when #343 emptied it, because an SC demanding an import that a correctly-empty file has no reason to hold is a ratchet nobody can satisfy
- [x] SC-547: test/sync-spec-tests-paths.test.ts contains [resolveSyncPaths, HARNESS_ROOT]
- [x] SC-551: test/sync-spec-tests-paths.test.ts contains [running it as a script, sentinel, spawnSync] — the root the script picks for ITSELF is proven by running it, because every assertion that passes a root in cannot see the default that caused #141

### An SC ID was matched as a substring (#148)

`findTestFilesForSCs` asked `content.includes(id)`. `"SC-1"` is a substring of
`SC-144`, so eighteen test files were credited as covering `SC-1` and not one
of them mentioned it. One passing run of any of the eighteen ticked `SC-1`
wherever it was unchecked: `specs/SPEC-TEMPLATE.md:190`, the literal
placeholder `- [ ] SC-1: [first criterion]`, and a real unimplemented
bootstrap criterion. A ticked template means every spec generated from it
inherits a criterion that is done before anyone writes it.

The mistake conceals itself. Once an SC reads `[x]` it leaves
`findUncheckedSCs` and is never evaluated again, so nothing re-examines it.

`findDuplicateSCIds` already skipped the template; the scan the flipper reads
from did not. The intent existed and was applied in one place out of two.

- [x] SC-548: scripts/sync-sc-status.ts contains [scMentionPattern] and not contains [content.includes(id)] — an SC ID matches as a whole token, so a longer ID's test cannot certify a shorter one
- [x] SC-549: scripts/sync-sc-status.ts contains [isTemplateSpec, SPEC-TEMPLATE] — the template placeholder is never a candidate for flipping
- [x] SC-550: test/sync-sc-status-matching.test.ts contains [SHORTEST_ID, SPEC-TEMPLATE, first criterion] — the substring collision and the template exclusion are each pinned by a case that fails without the fix

### Fixture data was read as a coverage claim (#149, partial)

Fixing the substring match was not enough to stop the harm, which is why this
landed with #148 rather than after it. Seven test files of the *spec tooling*
carried `- [ ] SC-1: …` or `id: "SC-1"` as input data, and `test/spec-compliance.test.ts`
used `SC-1`..`SC-5` as local sequence numbers for a spec
(`HARNESS-SKILL-CHAIN.md`) that has no success criteria at all. Between them
they certified a real unimplemented bootstrap criterion — and four others —
as done.

Two shapes are now stripped before the lookup: a spec checkbox line, and an
`id: "SC-N"` record. Nothing else. A mention in a test title or a header
comment is still a claim, because that is this project's existing convention
for declaring coverage.

What did NOT land, and is still #149: the convention itself. "A test file
mentions the ID" is not a sound coverage signal, and `findTestFilesForSCs`
receives IDs without spec files, so it cannot apply the `scopedKey` discipline
every other part of this tool uses. Making a test declare which spec it covers
is a contract change and needs review, not an unattended patch.

- [x] SC-552: scripts/sync-sc-status.ts contains [coverageClaimIds] — a spec line embedded as test input is not a claim about the criterion it names
- [x] SC-553: test/spec-compliance.test.ts contains [CHAIN-1] and not contains [test("SC-] — a test file may not use SC numbering that belongs to no spec, because the flipper cannot tell a local label from a reference
- [x] SC-554: test/sync-sc-status-matching.test.ts contains [claimed by nothing] — the outcome is asserted, not just the mechanism: the real bootstrap criterion is credited to no test file

### A compound criterion asserted only its first clause (#220)

`content-contains` captures exactly one bracket list and `matchPattern` returns
on the first registry hit, so a criterion written as `FILE contains [a] and not
contains [b]` bound, asserted `[a]`, and discarded everything after it with no
signal — not reported unmatched, not warned about. The criterion reported
satisfied having checked half of what it says.

The sweep posted to the issue before the fix: of **267** ticked non-behavioral
criteria that bind a matcher, **39** carried unconsumed text and **21**
discarded a whole bracket-list assertion. Every one of the 21 bound
`content-contains`; no other matcher loses an assertion.

Three of the 21 were discarding something **false**, so they were ticked while
asserting an untruth. Two of those three turned out to be criteria that
overreached rather than code that was wrong: they forbade `execSync` in modules
that legitimately shell out to git, curl and the test runner, when what the
GitHub migration forbids is the `gh` CLI. Nobody found out for the same reason
the defect existed — the clause had never once been evaluated.

**The decision, stated rather than left implicit.** Compound statements are
**parsed into every clause, not refused.** Three reasons, in order of weight:

1. Refusing would turn 21 criteria malformed at once in exchange for asserting
   strictly less than parsing does.
2. The defect is **not about negation**. Two of the 21 carry a *positive*
   second clause naming a different file, and a rule written in terms of
   `not contains` would leave those exactly as unasserted as before.
3. A criterion's requirement ends where its explanation begins, so everything
   from the first ` — ` is rationale and never becomes a clause. Without that
   rule a rationale reading "the reader and the writer agree" parses as one.

Residue that survives parsing is split deliberately. A **leftover bracket list
is refused** and named, because it is an assertion that would be dropped; after
parsing, that count is zero. **Prose residue is not refused** — around eight
criteria state real requirements as prose (`and is under 3,000 tokens`), and
rewriting those into testable form is #211's work, not this one's. Refusing
them would make 39 criteria malformed to fix 21.

One asymmetry is deliberate and bounded: an **absence** clause on a `.ts`/`.js`
target is evaluated with comments stripped, because an absence claim is about
code — the guard that must not shell out to a CLI necessarily names that CLI in
its own docblock. Stripping can only turn a violation into a non-violation, so
it cannot make a passing criterion fail. Presence clauses still read raw text;
changing that could flip currently-green criteria to red and is out of scope
here.

- [x] SC-694: lib/conformity.ts contains [parseCompoundClauses, unconsumedAssertion] — the parse and the view-check are exported, so both can be mutated directly rather than inferred from a passing suite
- [x] SC-695: config/matcher-registry.json contains [content-contains-compound] — the compound matcher is a registry entry ordered ahead of content-contains, not a widening of it; content-contains keeps its original narrow regex
- [x] SC-696: test/compound-sc-clauses.test.ts contains [the corpus carries no silently discarded assertion] — the corpus sweep is a test, so a criterion written tomorrow that drops a clause fails the suite instead of being found by the next audit
- [x] SC-697: test/compound-sc-clauses.test.ts contains [the recovered clause is EXECUTED, not merely parsed] — a parse that nothing runs is the same vacuous shape this issue is about
- [x] SC-698: test/compound-sc-clauses.test.ts contains [a POSITIVE second clause on another file is recovered] — the third shape is pinned, so a later simplification to "negation only" fails rather than silently unasserting two criteria

### Nothing reconciled the registry with its handlers (#212)

`matchPattern` iterates the **registry** and looks each entry's handler up by
name, so the two sets must agree and nothing made them.
`test/matcher-registry.test.ts` validates the registry's internal shape — unique
names, compiling regexes, examples matching their own regex — and contains zero
references to the conformity engine. Its only count assertion is a floor pinned
to the current number, so adding a handler with no registry entry kept it green.
The sets were identical when measured, and held that way by luck.

The two drift directions fail differently, which is why one test is not enough:

- **A registry entry with no handler asserts nothing, silently.** The statement
  *matched* — the author's syntax was recognised — and `matchPattern` still
  returned `null`, which downstream is indistinguishable from "no pattern
  matched at all". That collapses *recognised but unimplemented* into
  *unrecognised*; SUCCESS.md claim 4 requires them distinct. Worse, the two
  tools disagree by design: `create-spec` validates with `isMatchablePattern`,
  which checks the regex and not the handler, so an author is told their
  criterion is valid and the engine then generates nothing for it.
- **A handler with no registry entry is unreachable.** `matchPattern` never
  iterates the handler map, so the handler is dead however well it is tested —
  the shape #200 was filed for.

`resolveMatcher` now returns which of the three happened, and `matchPattern` is
a thin wrapper over it that still answers `AssertionFn | null`, so no existing
caller changes. The engine reports an `unimplemented` criterion as a FAIL rather
than folding it into the unmatched ratchet: that population is zero and a parity
test keeps it there, so unlike the prose backlog it cannot turn specs red en
masse.

`loadRegistry`'s fallback to the built-ins on an unparseable consumer config is
correct — one consumer's broken file must not take the engine's own matchers
down with it — but it happened in silence, so every SC written against a custom
matcher read as unrecognised with nothing saying why. It now warns and still
falls back.

- [x] SC-699: lib/conformity.ts contains [matcherHandlerNames, resolveMatcher] — the handler set and the three-way outcome are exported, so parity is a comparison of two real sets rather than an inference from a passing suite
- [x] SC-700: test/matcher-registry-parity.test.ts contains [every registry entry has a handler, every handler has a registry entry] — both directions, each naming its offenders, because the two kinds of drift are different defects
- [x] SC-701: lib/conformity.ts contains [could not be read as JSON] — a consumer config that fails to parse says so instead of degrading to the built-ins unannounced
- [x] SC-702: test/matcher-registry-parity.test.ts contains [the exception list holds only ids that genuinely diverge] — the create-spec/engine agreement list ratchets both ways, so an entry that stops diverging must be delisted rather than left to accumulate
- [x] SC-703: lib/conformity.ts contains [planSCTests(metadata.scs, root)] — the engine resolves matchers against the consumer's project root, because `create-spec` validates WITH one and the runner passed none, so every consumer custom matcher was accepted at authoring time and invisible at verification time
- [x] SC-704: test/matcher-registry-parity.test.ts contains [the engine's refusal is executed, not just written] — the refusal branch is driven against a planted project rather than asserted, because it only runs when the population is non-empty and in this repo it never is
- [x] SC-705: lib/conformity.ts contains [allowBuiltInOverride] — the engine resolves against a registry a consumer may extend but not replace, so a project cannot shadow a built-in matcher with one that never matches and switch off the check verifying it
- [x] SC-706: test/matcher-registry-parity.test.ts contains [the subject under test cannot switch off the check verifying it] — the restriction is asserted from both sides: the shadowing entry is ignored AND a purely additive custom matcher still resolves, so the guard cannot be satisfied by disabling custom matchers wholesale
- [x] SC-707: lib/conformity.ts contains [message withheld] — a config parse failure reports the error's type and not its message, because a JSON parse error quotes the bytes around the fault and the file is the consumer's own

### The exemption ratchet only turned one way (#302)

`.claude/conformity-allowlists.json` calls itself "a RATCHET, not a mute:
adding an entry that is not a real current violation fails, and an entry that
stops being a violation must be removed or the build fails." Half of that was
enforced. **Staleness** was real — DRIFT-2 and the orphan check both refuse an
entry that no longer names a violation, and that half caught a live case
during #310, when a spec became referenced and its entry had to go.

**Growth was not enforced at all.** A new entry for a genuinely new violation
is not stale, so every check passed. An agent could introduce a conformity
violation and exempt it in the same commit — passing a gate by editing the
gate, which is the one move this harness exists to refuse.

Direction is the whole design. Removals always pass: an agent that fixes a
violation and delists it is the case the ratchet is FOR, and refusing it would
trade one outage for another. Only additions are reported. The comparison base
is `origin/main` rather than the merge base, which is safe in the direction
that matters — entries added on main that a branch does not carry read as
removals and pass, so a stale base cannot produce a false refusal.

It belongs in the conformity suite, not the collection guard: the guard sees
paths rather than contents, and would catch only growth arriving through agent
collection, missing a human commit, a heal round, or a single-worktree run
that bypasses collection entirely.

DRIFT-3 is advisory — and says so — when `origin/main` cannot be read, because
a consumer may legitimately not have it. rungate's own suite asserts the base
IS readable, because here an unreadable base is a fault rather than a setup.

- [x] SC-711: lib/conformity.ts contains [DRIFT-3: the exemption lists did not GROW] — growth is refused in the same suite as staleness, so every source is covered rather than only the one an agent happens to use
- [x] SC-712: test/allowlist-growth.test.ts contains [a REMOVED entry is not growth] — the legitimate direction is asserted alongside the refusal, because a growth check that also refuses removals would block the fix it exists to encourage
- [x] SC-713: test/allowlist-growth.test.ts contains [an unreadable base is reported as unreadable] — the UNMEASURED branch is driven against a ref that cannot exist, rather than left as a branch that never runs in a healthy checkout

## Implementation

### Phase A: SC Classification
1. Classify every SC in testable specs as `static` (file artifact) or `behavioral` (runtime action)
2. Rewrite hook-wiring SCs as static checks where the artifact exists (SC-347)
3. Tag genuinely behavioral SCs with `verification: behavioral` (SC-345, SC-346)
4. Verify: every SC has a classification, no ambiguous cases

### Phase B: Matcher Expansion
1. Audit all unmatched static SCs — categorize what pattern each needs
2. Implement new matchers (SC-336 through SC-340) in matchPattern()
3. Verify: unmatched count drops to zero for static SCs (SC-331)

### Phase C: Phase 2/3/5/1 Migration
1. Implement source-contains and regex-match matchers
2. Refactor phase-2/3/5 to thin consumers calling conformity engine on harness source
3. Migrate phase-1 similarly
4. Verify: phase-2/3/5 ≤100 lines (SC-333, SC-334, SC-335), phase-1 ≤200 lines (SC-344)

### Phase D: Phase-0 Migration
1. Refactor phase-0 to: copy fixture → run scaffold → call runScaffoldConformity(outputDir)
2. Keep integration-specific assertions in a custom tail (~50 lines)
3. Verify: phase-0 ≤200 lines (SC-332), all existing tests still pass

### Phase E: Staleness + Verification
1. Add fixture staleness check (SC-341)
2. End-to-end verification: add a test SC, run suite, confirm auto-test (SC-342)
3. Enable D-5 (strict mode) after behavioral SCs are excluded

### Phase F: Config-Driven Matcher Registry
1. Define matcher config format (SC-379) — JSON file listing all patterns with name, syntax, example, notes
2. Refactor matchPattern() to read from config (SC-380) — dispatch by config, not hardcoded branches
3. Auto-generate SPEC-TEMPLATE pattern reference from config (SC-381)
4. Wire create-spec.ts to validate SCs at write time (SC-382) — block save if unmatched
5. Build `rungate audit-specs` CLI command with `--fix` auto-rewrite (SC-383, SC-393)
6. Document consumer extension point for custom matchers (SC-384)

### Phase G: Structured SC Authoring (FOUNDATIONAL — before other specs ship)
1. Build `rungate create-sc` CLI — pattern + params input, SC text output (SC-396)
2. `--list` shows patterns from matcher registry (SC-397)
3. Wire into create-spec.ts — SC creation goes through create-sc, not freeform text (SC-382)
4. Add to AGENTS.md Commands table (SC-399)
5. Verify: agent creating a spec never writes raw SC text

### Phase H: Legacy Migration
1. Build `rungate audit-specs` — classify all SCs as matched/unmatched/behavioral (SC-383)
2. Add `--fix` mode — propose and apply matchable rewrites, flag ambiguous for review (SC-393)
3. Run `--fix` on all RunGate specs — convert remaining unmatched SCs
4. Wire scaffold to run audit-specs post-generation (SC-394)
5. Ensure consumers get identical tooling via `bunx rungate` (SC-395)
6. Flip each spec to `compliance: strict` as it reaches 100% matched (SC-398)
7. Verify: zero unmatched SCs in any testable RunGate spec

## Cautions

- Phase-0 is an integration test (scaffold → check output) with a cross-project boundary — it validates harness specs against scaffold output. The conformity engine tests within a project, not across projects. Phase-0 stays at ~840 lines (down from 949) with conformity delegation for in-project SCs + manual tests for cross-project verification
- Behavioral SCs describe runtime actions, not file artifacts. They route to SESSION-AUDIT-SPEC transcript auditor, not matchPattern(). Don't force behavioral checks into file matchers
- Hook-wiring SCs often look behavioral but are actually static (check hook file contents). Rewrite these before classifying as behavioral
- The golden fixture must stay in sync with SC additions. The staleness check (SC-341) is the safety net
- Phase-1.5 tests the engine itself — migrating it into the engine it tests would be circular
- Phase-1 (683 lines) was missing from original spec — now included in Phase C

## Council Review

Reviewed 2026-09-21 by Architect, Engineer, Skeptic (3 rounds). See `docs/council/2026-09-21-config-driven-testing-council.md` for full synthesis. Key findings:
- Category error: static file verification ≠ behavioral runtime validation (resolved by D-6)
- "Zero fallthrough" reframed to static SCs only
- Sequencing reversed: phase-2/3/5 first, phase-0 last
- Phase-0 circular dependency acknowledged
- Strict mode (D-5) deferred until behavioral classification complete
