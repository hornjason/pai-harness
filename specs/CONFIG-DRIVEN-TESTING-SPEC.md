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
- [x] SC-549: lib/sc-ids.ts contains [isTemplateSpec, SPEC-TEMPLATE] — the template placeholder is never a candidate for flipping, and never a registry id either (#330 moved the predicate here so both readers share it)
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

### Four regexes for one notation (#330, #352, #358)

An SC id is the join key binding a spec line to the test that proves it. Four
files decided independently what one looks like:

| file | function | pattern |
|---|---|---|
| `lib/conformity.ts` | `extractSCs` | `SC-\w+` |
| `scripts/sync-sc-status.ts` | `coverageClaimIds` | `SC-\d+(?!\d)` |
| `scripts/sync-sc-status.ts` | `findUncheckedSCs` | `SC-\d+` |
| `test/spec-sc-ids-unique.test.ts` | `DECLARATION` | `SC-\d+` |

#330 named the divergence as the root cause and found two of the four. The
consequences, measured before the change:

- **251** registry ids were credited to at least one test file, over **282**
  `(file, id, spec)` credits — more credits than ids because the flipper
  ticked a bare id in *every* spec declaring it.
- **7** of those ids were credited only by prose about a different issue's
  criteria: every single digit is a real entry in
  `specs/bootstrap-data-flow/success-criteria.md`, and the harness numbers an
  issue's own criteria from 1.
- **6** anti-criteria (`SC-A1`..`SC-A6`) were invisible to the lookup.
- **4** ids were declared by more than one spec. `test/spec-sc-ids-unique.test.ts`
  checks each spec against itself, so two specs each declaring `SC-2` once are
  each internally consistent and nothing looked across them.

After: **244** ids, **263** credits, 0 false single-digit credits, 0 false
gains. Lost: `SC-1`..`SC-7`, all of them citations. Gained: none.

#### The notation, stated rather than assumed

`SC-<n>` is **global** — one spec owns the number. `SC-A<n>` is an
**anti-criterion** and **per-spec by design**: `specs/SPEC-TEMPLATE.md` ships
`- [ ] SC-A1: [anti-criterion — must NOT happen]`, so every spec numbers its
own from A1 and three specs declaring `SC-A1` is the notation working, not a
collision. They are disambiguated by requiring the spec's name beside the
mention, never by renumbering.

An issue's own criteria are **not SC ids**. Written as `SC-n` they are
indistinguishable from registry references, and that is the whole of #352 and
#358. Write them as "criterion N of #NNN".

#### Two corrections to #330's premises, measured

- #330 held up `test/ceremony-overrides.test.ts`'s `SC-A1`..`SC-A5` as
  "genuine coverage that the detector cannot see". **No spec declares those
  criteria** — they are an issue's own, and crediting them would have ticked
  DOC-HYGIENE's and GITHUB-API-MIGRATION's real anti-criteria with a passing
  test about ceremony profile loading. The harm #330 feared was right; which
  side was genuine was not.
- Widening the pattern is made safe by the **registry**, not by the regex.
  `SC-guard`, `SC-to` and `SC-NNN` are never declared by a spec, so they can
  never be credited however wide the scan gets. A regex narrow enough to
  exclude prose is also narrow enough to exclude `SC-A1`.

#### Why a qualified comment is still not a claim

The first version accepted any mention with the spec's name nearby and gained
two credits it should not have. `test/behavioral-sc-ratchet.test.ts` opens
with prose naming `SC-A1`, `SC-A2` and `GITHUB-API-MIGRATION-SPEC.md` in one
sentence — describing this very bug. Every ingredient of a qualified claim,
and a citation.

A window says *which* criterion a mention means; it cannot say *whether* the
mention is a claim. So an ambiguous id must be claimed from a
`describe`/`test`/`it` title **and** name its spec. The cost is six
anti-criteria staying uncredited until someone writes such a title —
under-crediting, the direction this is allowed to fail in.

- [x] SC-787: lib/sc-ids.ts contains [SC_ID_SOURCE] — every reader builds its pattern from one definition, because four files each deciding what an id looks like is how an anti-criterion became a declaration to one reader and invisible to three
- [x] SC-788: lib/sc-ids.ts contains [crossSpecCollisions] — a global id declared by two specs is refused, because the per-file guard sees two internally consistent specs and the flipper ticks both checkboxes
- [x] SC-789: scripts/sync-sc-status.ts contains [ScCredit] — a credit names the spec as well as the id, because `unchecked.filter(u => u.id === scId)` ticked the id wherever it appeared and only the narrow regex was hiding it
- [x] SC-790: lib/sc-ids.ts contains [requiresQualification] — an id a bare mention cannot identify is credited only from a titled, spec-naming claim, because the registry declares every single-digit id and issues number their own criteria from 1
- [x] SC-791: test/sc-id-namespace.test.ts contains [a qualified COMMENT is a citation, not a claim] — the citation case is asserted alongside the claim case, because the first version of the rule credited prose describing the bug it fixes

### What was broken to prove it (SC-787..791)

Over `test/sc-id-namespace.test.ts`, `test/sync-sc-status-matching.test.ts`,
`test/spec-sc-ids-unique.test.ts`, `test/sc-coverage-claims.test.ts` and
`test/sync-sc-status.test.ts` (88 tests). None left in the tree.

| Mutation | Red |
|---|---|
| `findTestFilesForSCs` returns nothing | 9 of 88 |
| nothing requires qualification | 7 of 88 |
| anti-criteria stop being per-spec | 5 of 88 |
| single-digit ids stop being issue-shaped | 5 of 88 |
| every id reads as qualified | 5 of 88 |
| the id pattern narrows back to `SC-\d+` | 4 of 88 |
| the template's placeholders enter the registry | 4 of 88 |
| anti-criteria counted as collisions | 2 of 88 |
| the containing directory stops qualifying | 2 of 88 |
| claim sites stop recording their position | 2 of 88 |
| cross-spec collisions report nothing | 1 of 88 |
| the qualifier window spans the whole file | 1 of 88 |
| a qualified comment counts as a claim again | 1 of 88 |
| unqualified mentions stop being reported | 1 of 88 |
| `extractSCs` goes back to its own regex | 1 of 88 |
| the duplicate-credit guard removed | 1 of 88 — and **0 of 87** before the case below it was written |

The last row is the mutation that earned a test. Removing the dedup changed
nothing any assertion could see, and a duplicate credit is not cosmetic: the
run prints `${credits.length} SCs` and the per-spec report counts entries
rather than distinct criteria.

Two mutations are recorded as **unusable rather than as results**. Renaming
`findTestFilesForSCs` drops the suite from 88 tests to 56 — the importing
files fail to load, so 32 cases are *deleted* rather than failed, and "2 red"
measures nothing. Short-circuiting the body instead is the row above. The
general lesson is the one `.claude/rules/checks-must-be-able-to-fail.md`
already records for mutation harnesses: a mutation that stops the target
resolving is not a mutation.

---

### A comment is where coverage is declared AND where it is discussed (#360)

#149 credits a test file with covering `SC-N` when the file mentions the id in
a comment, and the position is right: prose is where a project declares
intent. What the position cannot do is tell these apart —

```ts
// covers SC-640                                     ← a claim
// SC-640 was the criterion the collision broke      ← a citation
```

— and the two it missed in the wild were both a file about coverage
attribution certifying the criterion it was discussing.

**Measured before designing, and the measurement chose the design.** Of 220
comment-position credits: 67 carried a coverage verb, 34 a label, 40 a
line-leading id, and 79 nothing a scanner could see. A systematic sample of 16
of the 79, read in full, split 11 claims to 5 citations — and not subtly.
*Every* citation sat mid-sentence inside running prose; *every* claim sat in a
structural position, in forms the first three rules missed (`#178 / SC-413:`,
`SPEC-REF: … (SC-369)`, `… turns it red (SC-4).`).

So the rule is NOT a new `covers:` marker. A new marker means migrating ~70
files to re-state what they already say. The rule is: **a declaration occupies
a structural position; a bare id inside a running sentence is a citation.**
`lib/sc-claim-forms.ts` owns the five forms, and
`.claude/rules/claiming-sc-coverage.md` states them where an author reads them
before writing the comment rather than after.

- [x] SC-804: lib/sc-claim-forms.ts contains [commentClaimForm] — ONE exported predicate decides what a comment claims, so there is one binding to mutate; a second decider would survive any mutation of the first and the guard would go green for the wrong reason
- [x] SC-805: test/sc-claim-forms.test.ts contains [a citation is not credited] — the citation cases are REAL, lifted from the tree, each one a credit this change took away. A synthetic citation proves only that the regex rejects what it was written to reject
- [x] SC-806: scripts/sync-sc-status.ts contains [form: ClaimForm | null] — the scanner REPORTS the form and the credit rule decides. Filtering inside the scanner re-created the silent drop #358 had just fixed, one layer down, and turned its test red
- [x] SC-807: lib/strip-js-comments.ts contains [commentMask, enclosingComment] — the enclosing comment is recovered from the offset-preserving stripper, not re-lexed, so the census cannot disagree with the thing it measures

**The before/after, by the same script both times**
(`scripts/census-comment-claims.ts`, committed for exactly that reason):

| | before | after |
|---|---|---|
| credits (file, spec, id) | 266 | 255 |
| criteria with at least one credit | 247 | 245 |

(259 and 249 once this change's own four criteria are declared and credited by
`test/sc-claim-forms.test.ts`. The 255/245 column is the comparable one — the
same registry, measured either side of the rule.)

Thirteen credits lost, every one enumerated and classified by hand rather than
sampled — eleven citations, and two genuine claims **migrated in the same
commit** so the net loss is only the citations. One criterion *gained*
coverage: `SC-359` had been written `SC-358/359`, so only the first id carried
a prefix and nothing had ever credited the second.

Three criteria drop to zero file-credits — SC-300, SC-301, SC-478 — and the
honest reading is the opposite of "revealed as untested". All three are
conformity-pattern criteria (`contains [...]`, `under [200] lines`), checked
against `matchPattern` rather than assumed: each generates a mechanical test
from its own statement. The comment credit was decorative noise on top of real
coverage, which is its own argument for this change.

**Two near-misses, both caught by reading the diff of lost credits rather than
by the rule:**

- The first `attribution` rule credited any parenthetical, including
  `("see SC-621")` — inside a comment whose next clause reads "Counting
  citations would make". A rule that credits the sentence explaining why
  citations must not be credited. Narrowed to parentheticals holding only ids.
- The first fix for line-leading citations was an allowlist of what may follow
  a heading. It rejected ` * SC-722 of GATE-CONTRACTS-SPEC.md.` and
  ` * #173 — SC-587, SC-588, SC-589, SC-590.` and took **30** criteria to zero
  coverage in one step — 44 lost credits against the loose rule's 13. Replaced
  with a small closed stop-list of copulas, which is the one place a stop-list
  beats an allowlist: the set of words that turn a heading into a sentence is
  closed, the set of ways to write a heading is not, and a missing stop-word
  costs one bounded false credit while a missing heading form costs every
  credit written that way.

### What was broken to prove it (SC-804..807)

Run and counted over `test/sc-claim-forms.test.ts` + `test/sc-id-namespace.test.ts`
+ `test/spec-sc-ids-unique.test.ts` + `test/ac-coverage.test.ts` (134 tests):

| Mutation | Red |
|---|---|
| `commentClaimForm` returns `"covers"` for everything — every citation credited again | 25 of 134 |
| `commentClaimForm` returns `null` for everything — every comment credit gone | 20 of 134 |
| `commentMask` stops bridging whitespace — the truncated-comment bug | 4 of 134 |
| the scanner DROPS formless sites instead of reporting them — #358's silent drop, re-created | 2 of 134 |
| `SENTENCE_TAIL` emptied — a line-leading citation is a heading again | 2 of 134 |
| `attribution` widened back to any parenthetical | 1 of 134 |
| the credit rule stops reading `form` — **the whole of #360 reverted in place** | 1 of 134, and **0 of 131** before the case below it was written |

**That last row is the finding, not a footnote.** Deleting one line from
`findTestFilesForSCs` switches this entire change off, and the suite stayed
green: 131 tests asserted what `commentClaimForm` ANSWERS and not one asserted
that anything ASKS it. A predicate nobody consults is the decorative check
`.claude/rules/checks-must-be-able-to-fail.md` exists for, and it is worse
than usual here — the suite would have certified a rule that had been turned
off. `#360 SC-806: the credit rule is the thing that consults the form` drives
`findTestFilesForSCs` over a planted fixture directory, with a positive
control, because a mutation refusing EVERYTHING also satisfies a
citation-earns-nothing case on its own.

Plus the end-to-end pair criterion 6 asks for, run against the real tree
rather than a fixture, from a baseline of 259 credits:

| Reintroduced verbatim | Credits |
|---|---|
| the citation `// is the same defect as SC-91/SC-92`, rewritten as `// covers SC-91, SC-92` | 261 — the two credits come back |
| the claim `Covers SC-358, SC-359`, reverted to `verifies … per SCAFFOLD-DECOMPOSITION-SPEC SC-358/359` | 257 — both credits go |

None is left in the tree; all were run and reverted.

## A test killed by the runner is not a measurement of the code (2026-10-13)

`test/unit/scaffold-project.test.ts` has 31 cases that spawn a real
`bun scripts/scaffold-project.ts`, and a `--fix` run on a project with no
CODE-MAP.md spawns a **second** bun process to generate one. Measured here:
1.42s for the scaffold, 1.04s of it the nested generator — 73% of the
operation is a second cold bun start.

Not one of the 31 declared a timeout, so all of them ran under bun's 5000ms
default, while `runScaffold` itself passed `timeout: 15000` to `execSync`.
**The per-test budget was a third of what the helper declared the operation
might need.** The runner therefore killed the test while the helper was still
willing to wait, and on 2026-10-13 it did: `reports what it created and what
it skipped` died at 5007ms on CI while its near-identical neighbour passed in
834ms. The report read "this test timed out after 5000ms" and carried none of
the scaffold's output, because the `catch` never ran. An earlier run on `main`
lost `SC-525 > --type code (default) behavior is unchanged` the same way at
30s.

A verdict that turns on how busy the runner was is decoupled from the code
under test — the same defect as a check that cannot fail, pointed the other
way, and it costs the diagnostic output on the way through. One budget is
declared, the test budget is derived from it, and the ordering between them is
asserted rather than commented.

- [x] SC-816: test/unit/scaffold-project.test.ts contains [setDefaultTimeout(TEST_TIMEOUT_MS)] — the budget is APPLIED, not merely declared. Two correctly-ordered constants that nothing reads are inert, and the file would keep running on the 5s default with a passing ordering test to say otherwise
- [x] SC-817: test/unit/scaffold-project.test.ts contains [the per-test timeout strictly exceeds] — the ordering is a check, not a convention. Inverting it silently restores the regime where every spawning case can be killed before its own helper is allowed to fail

### What was broken to prove it (SC-816..817)

Run and counted over `test/unit/scaffold-project.test.ts` (38 tests):

| Mutation | Red |
|---|---|
| `TEST_TIMEOUT_MS` derived as `SCAFFOLD_TIMEOUT_MS - 5_000` — still above bun's default, so every real case passes | 1 of 38 |
| the `setDefaultTimeout` call deleted — both constants intact, nothing applying them | 1 of 38 |

**The second row did not work the first time, and that is the entry worth
keeping.** The draft asserted `toContain("setDefaultTimeout(TEST_TIMEOUT_MS)")`.
Deleting the real call left the file green at 38 pass — the only surviving
occurrence of the token was the string literal inside the assertion, matching
itself. The same self-reference trap
`.claude/rules/claiming-sc-coverage.md` is about, met from the other side.
Anchoring to a top-level statement (`/^setDefaultTimeout\(TEST_TIMEOUT_MS\);$/m`)
makes the assertion's own indented, quoted line unmatchable.

Neither mutation is left in the tree; both were run and reverted.

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

## #399 — test fixtures spell SC ids inside the live namespace

`nextSCNumber` reads the spec registry — `declaredById` over `specs/` — and
cannot see a fixture. So it proposes a number that looks free, is free as far
as every guard in the repo is concerned, and collides with a string literal
the suite depends on. Found while renumbering GATE-CONTRACTS-SPEC.md's
headings (#392 follow-up): the next free number was 896, and allocating the
ten-heading block at 896..905 would have been wrong, because four of those
numbers were already in use as planted fixtures. The renumbering went to
1400..1409 to step over the whole occupied run.

**The collision this was filed to prevent had already happened.**
`test/stale-issue-scanner.test.ts` plants `SC-379` and `SC-380` as fixture
ids; this spec declares both at lines 77-78 as real tracked criteria. Two
different things wear the same id, and nothing in the tree reports it.

Several strays were spelled in a declaring form. `test/sync-sc-status.test.ts`
contained literally `- [ ] SC-900: AGENTS.md exists` — a checkbox
declaration, in a string literal, inside a test file. If a spec had ever
declared SC-900 that fixture would have become a claim on a real criterion,
which is the shape #392 closed arriving from the other direction.

### Why this is the same class and not a tidy-up

`.claude/rules/checks-must-be-able-to-fail.md` names it: a detector narrower
than what it detects. Every guard in this area — `crossSpecCollisions`,
`crossFormCollisions`, `nextSCNumber`, `requiresQualification` — reasons over
`specs/` only. They are all correct about the question they ask and all blind
to half the namespace, and nothing reported that the blindness existed.

### Why the floor is 9000 and not 9900

The issue proposed 9900, following `test/sc-claim-forms.test.ts`. Measured on
the tree, the convention that already exists is **9000+**: 209 fixture
mentions sit at 9001..9902 across eight files, against 24 strays below. A
floor at 9900 would have declared 209 settled fixture ids to be violations
and required migrating them for no benefit. The floor goes where the repo
converged, which is also the only choice that makes the stray count a measure
of the problem rather than of the rule.

- [x] SC-1520: One exported predicate decides what is reserved for fixtures, and both the allocator and the stray guard consult it rather than comparing against the number
- [x] SC-1521: `nextSCNumber` never returns a number any source file spells, driven over the real tree rather than a planted pair, while the reserved range itself does not drag the allocation up and the one-argument answer is unchanged
- [x] SC-1522: No fixture id sits below the floor, with the scanner's reach asserted so the count cannot be zero because nothing was read, and a declared criterion cited in a test proven not to be a stray
- [x] SC-1523: The scanner reads every directory it claims to, so a silently skipped source tree cannot report a clean namespace
- [x] SC-1525: `scripts/create-sc.ts` passes the source half to the allocator, driven as a subprocess against the real CLI — a decider being right is not the same as the caller asking it
- [x] SC-1524: No spec declares a criterion at or above the floor, so the range fixtures are told is safe actually is — the allocator treats a spec declaration as authoritative at any number, and this is what makes that safe

### What was broken to prove it (SC-1520..1525)

Run and counted over `test/sc-fixture-namespace.test.ts`,
`test/sc-id-namespace.test.ts`, `test/create-sc.test.ts` and
`test/sync-sc-status-matching.test.ts` (87 tests). None is left in the tree;
all were run and reverted.

| Mutation | Red |
|---|---|
| `isFixtureScId` always says no | 6 |
| `isFixtureScId` always says yes | 6 |
| the floor moves to 9900, as the issue originally proposed | 3 |
| the allocator stops reading the source half (the #399 bug, restored) | 2 |
| the allocator counts reserved-range fixtures as taken | 2 |
| a fixture planted back below the floor at an UNDECLARED number | 2 |
| the CLI stops passing the source half | 1 |
| the stray scan short-circuited to an empty map | 1 |
| the scanner skips `gates/` silently | 1 |
| the trailing-digit boundary dropped from the scan regex | **0 — no-op, see below** |
| a fixture planted back at a number a spec DECLARES | **0 — known limitation, see below** |

Five rows were zero on the first battery and four were the tests' fault:

- **The dir-coverage case derived its expected set from `SC_SOURCE_DIRS`,**
  so dropping `gates` from the list dropped it from the test too. A test
  parameterised by the thing it checks cannot check it — #397 paid for this
  exact lesson once already, and it recurred within a day. The expected set
  is now a literal, with the list asserted against it separately.
- **The stray guard asserted `size === 0`,** which an empty map satisfies.
  It now runs the real `strayFixtureIds` over a planted tree.
- **Nothing exercised the CLI's call site,** so removing the allocator's
  third argument there scored 0 — SC-1509's distinction again, a decider
  being right is not the same as the caller asking it. The case now plants a
  fixture above every declared number so the two answers differ, and drives
  the real CLI as a subprocess.
- **The prefix pair was not a prefix pair.** `FLOOR+141` and `FLOOR+14` are
  9141 and 9014, which share no prefix, so the boundary case proved nothing.

The two remaining zeros are different from each other and neither is a test
defect:

- **The trailing-digit lookahead is a no-op.** `/SC-(\d+)/` is greedy, so
  `\d+` already consumes every digit and `(?!\d)` cannot change an answer.
  Measured directly rather than assumed. It is kept because it matches
  `scMentionPattern`'s house form and states the intent, but it guards
  nothing and the table says so rather than carrying a row that looks proven.
- **A fixture reusing an id a spec already declares is out of reach,** and
  that is a deliberate boundary. Catching it by POSITION — "in a comment it
  is a citation, in code it is a fixture" — was implemented and measured at
  **338 violations on this tree**, because `test("SC-1504: …")` is a test
  TITLE, a claim form `.claude/rules/claiming-sc-coverage.md` lists as valid
  and settled. A planted fixture string containing `test("SC-91: …")` is
  textually identical to a real title, so no position rule separates them.
  Widening would swap a guard that misses two cases for one that misreports
  three hundred, in the direction this repo has already chosen against.

Both already-landed collisions were found by hand and are recorded here
rather than left implicit: `SC-379`/`SC-380`
(`test/stale-issue-scanner.test.ts` against this spec's lines 77-78) and
`SC-91`/`SC-92`/`SC-93` (`test/sync-sc-status-matching.test.ts` against
`specs/bootstrap-data-flow/success-criteria.md`). The second sat under a
comment reading "with IDs this repo does not use so the file does not claim
them" — true when written, false by the time it mattered, and nothing could
notice. Those three are moved; the two in `stale-issue-scanner` are left for
the follow-up that closes the detector gap, because moving them without a
guard just resets the clock.

## #441 — the unmatched ratchet measured the matcher's vocabulary

`UNMATCHED_CHECKED_RATCHET` in `test/conformity-sc-binding.test.ts` counted
checked SCs whose statement binds to no entry in
`config/matcher-registry.json`, and its docblock read that number as debt:
*"SCs are marked done, carry no assertion the engine can build, and are
therefore wishes by this project's own rule."*

That reading was right at 54. It stopped being right once the repo started
writing criteria about REFUSALS. The registry's whole vocabulary —
`file-exists`, `dir-exists`, `content-contains`, `content-not-contains`,
`count-threshold`, `json-field-equals`, `section-exists`, `regex-match`,
`source-contains`, `frontmatter-field`, `command-output` — is claims about
the **state of the tree**. No state of a tree expresses *"X refuses, and says
which of two things happened"*, and a refusal is what most of this project's
recent criteria are about, because `.claude/rules/checks-must-be-able-to-fail.md`
pushes everyone to write them.

So 239 → 242 → 252 → 258 across #397, #398 and #399. Every rise was for
criteria covered by executed tests, and the only route down was to rewrite
them as weaker claims about file contents — lowering the number by making the
spec say less. The number was measuring the matcher's vocabulary and being
read as the project's honesty.

### The split, measured

| | count |
|---|---|
| unmatched, and **no test file declares it** | 154 |
| unmatched, and **a test file does** | 100 |
| `SUPERSEDED` ticks, excluded from both | 3 |

The first is the wish the old docblock meant. The second is the vocabulary
gap, and it does not fail the suite.

### The thing this nearly became: a second decider

Before any of it was written, the unclaimed half was measured against the
census `uncoveredTickedScs` already produces, which
`test/ticked-sc-cover.test.ts` ratchets **per spec, both directions, naming
the ids**. **154 of 155 were the same criteria.**

Banking the unclaimed count as a new global ratchet would therefore have been
two guards answering one question about one input — the fourth shape in
`.claude/rules/checks-must-be-able-to-fail.md` — and a mutation of either
would have left the other holding every case up. Both would have read as
covered and one of them would have been dead.

So the per-spec ratchet stays the one place a new untested criterion is
refused, and this split asserts its RELATIONSHIP to that census rather than
re-deciding it: no unclaimed criterion may be outside the census, and the
census residue must be exactly the two `testable: no` criteria that
`collectTestableSpecs` skips and `readSpecs` does not. The two numbers cannot
drift apart without a test going red.

The one criterion that was outside the census turned out to be
`GITHUB-API-MIGRATION-SPEC.md::SC-499`, a `SUPERSEDED` tick — the census
drops those and the first draft of the split did not. A tick that points at
its replacement is not a criterion anybody owes a test for, and that
disagreement was arrived at by accident, which is exactly what the
relationship assertion exists to catch.

### The decision: a refusal-shaped matcher, and why not yet

The only honest route that lowers 100 is a matcher shape the registry does
not have. Recorded here with a worked example so the next person evaluates a
design rather than rediscovering the gap.

Take SC-1506, from #397:

> A suite that could not run — missing file, unresolvable import, no tests
> declared, or dependencies that could not be installed — is reported as
> UNMEASURED and is distinguishable in the hook's output from a conformity
> FAIL

A `refuses` matcher would need three parameters no existing shape carries: a
command to run, a planted input that should provoke the refusal, and the
distinguishing text. Something like:

```json
{
  "pattern": "is reported as (?<state>[A-Z]+) and is distinguishable",
  "kind": "refuses",
  "command": "bun hooks/PrePush.hook.ts",
  "provoke": "fixtures/suite-that-cannot-run",
  "expect": { "exitNonZero": true, "says": "UNMEASURED" }
}
```

**Not built, and the reason is a cost this spec already paid once.** Every
existing matcher is a pure read of the tree: it cannot fail for an
environmental reason, so a red assertion means the criterion is false. A
`refuses` matcher SPAWNS, and a spawn fails when a dependency is missing, a
port is taken, or CI is slower than a timeout. The engine runs every checked
matchable SC on every suite run — 150+ of them — so one flaky spawn shape
makes the whole conformity run untrustworthy, and the first response to a
flaky gate is to loosen it, which is how a check that cannot fail gets built.

The precondition is a fixture harness with the properties
`test/suite-binding-mutation.test.ts` already demonstrates: the spawn is
observed to have run (`ran === 1`), a mutant of the refusal is spawned the
same way over the same planted input, and a failure to load is distinguished
from a refusal. Until a matcher can assert all three, 100 is the right number
to report and the wrong number to ratchet.

- [x] SC-1636: test/sc-binding-split.test.ts contains [unmatched checked SCs are split by whether a test claims them] — each row carries the spec and statement, so a rise names what to act on
- [x] SC-1637: test/sc-binding-split.test.ts contains [the unclaimed count is the ratchet and may only fall] — a ticked criterion with no test raises it and fails the suite
- [x] SC-1638: test/sc-binding-split.test.ts contains [the claimed-but-unbindable count is tracked, not refused] — bounded in both directions so a move is noticed and banked, never silent
- [x] SC-1639: test/sc-binding-split.test.ts contains [the split does not become a second decider] — every unclaimed criterion is one the per-spec census already governs, and the residue is named
- [x] SC-1640: test/sc-binding-split.test.ts contains [both halves are proved against a planted spec and test] — one planted criterion, one difference, asserted in both directions

### What was broken to prove it (SC-1636..1640)

Run over `test/sc-binding-split.test.ts` — 12 tests, baseline 0 fail. Every
count predicted before the battery ran.

| Mutation | Red |
|---|---|
| every unmatched SC lands in `unclaimed` | 7 of 12 |
| every unmatched SC lands in `claimed` | 5 of 12 |
| the `SUPERSEDED` skip removed | 5 of 12 |
| `claimedScKeys` returns nothing — the credit rule, upstream | 6 of 12 |
| `unclaimedCensusResidue` reports no difference either way | 1 of 12 |
| `UNCLAIMED_RATCHET` raised to 9999 | 1 of 12 |
| `CLAIMED_UNBINDABLE` raised to 9999 | 1 of 12 |
| the split reads unchecked SCs too | 4 of 12 |

None of the eight is left in the tree; all were run and reverted.

**The rows that differed, and they are all one mistake.** Four came back
exactly +1 and one exactly −1 against prediction, and the cause is the same
in every case: the predictions were written against the test list as it stood
before the headroom test was added, and that test goes red whenever the
unclaimed count moves at all. The −1 is its mirror — raising
`UNCLAIMED_RATCHET` to 9999 was predicted to turn the ratchet red too, but a
`<=` ratchet cannot notice its own constant rising, which is precisely why
the headroom test exists. No code defect in any of the five; one systematic
prediction error, recorded rather than quietly re-fitted.

**The row that was genuinely informative.** Breaking the CLASSIFIER measures
7 and breaking the CREDIT RULE upstream measures 6, and the extra row is the
residue test. Under the upstream mutation both populations move together —
the census is computed from the same empty claimed set — so the difference
between them stays empty and the residue test passes. Under the classifier
mutation only one population moves and the residue test catches it. The two
mutations are therefore distinguishable, which is the "give each decider an
input only it can reach" property the fourth-shape section asks for, arrived
at by construction rather than by design.

**Why the residue is asserted in both directions.** A single
"the difference is empty" assertion cannot tell *no difference* from *a
differ that returns nothing*: mutation 5 makes `unclaimedCensusResidue`
report `[]` for both lists and the subset test passes vacuously. The
`onlyCensus` assertion, which names the two `testable: no` criteria exactly,
is the one that catches it — 1 of 12, and that 1 is the whole reason the
second direction is written out.

## A criterion ticked because somebody wrote down its name (#574)

`scripts/sync-sc-status.ts` credits a criterion when a test file names it in
a declaring position, and a `test()` title is one — correctly; it is this
project's oldest coverage convention and the one position that never needed
a rule. `test.todo("SC-N: …")` is also a title, and a todo is the one test
guaranteed never to fail.

Measured on main at `469ef084`:

```
64  SC ids named inside a .todo( in test/ or gates/
53  of those with no other declaring mention anywhere
37  of those 53 ticked [x] in a spec
19  more about to flip on the next run of the sync
```

The 19 are another session's in-flight design spec. Its test file says so,
four lines from the top — *"The spec's 19 behavioural criteria are NOT
covered here"* — and then lists each one honestly as a todo. The author
wrote down what was not done, and the sync read the list as nineteen
completed criteria.

**The incentive was backwards in the same way #510's was.** A session that
records its unfinished criteria as todos scores better than one that leaves
them unmentioned.

### The sentence that proved its own negation

Two of the nineteen were credited by something else, and it is worth its
own paragraph because it is the sharpest version of this area's recurring
trap:

```
 * The spec's 19 behavioural criteria (SC-1930..SC-1948) are NOT covered here.
```

`(SC-1930..SC-1948)` is a parenthetical holding nothing but ids, which
`commentClaimForm` credits as an *attribution* — so the comment saying the
criteria are not covered was the evidence that they were, and it ticked
both endpoints.

A range is not an attribution. An attribution names THE criterion a
statement is about; a range names a group, which is how prose refers to a
set it is discussing. And the scanner can only see ids that are literally
written, so a range of nineteen credits its two endpoints and silently not
the seventeen between them: **a form that credits 2 of the 19 ids it names
is not measuring anything.**

Measured before narrowing, because narrowing a detector is the change most
likely to buy green with blindness: of 32 attribution credits in the tree,
30 are plain and 2 are ranges, and the 2 are these. A range at the START of
a line is still a claim, by the `line` form, which is where
`SC-561..SC-564 (SPEC.md)` is credited and is unchanged.

### Not crediting is not enough — it has to be said

`0`, `{}`, `null` and "not in the list" are all indistinguishable from
success. So a criterion whose only declaring position is a title that never
runs is reported by name, with its file, on every sync run. An id that also
has a running test is NOT reported: the question is whether anything can
measure the criterion, not whether a todo exists, and a list that names
every todo beside a passing test is ignored within a week.

### A tick can rest on something other than a test file

40 ticks were removed. **Two came back on the next run**, through the
conformity engine, which matches an SC statement mechanically and is a
second, legitimate credit path. That is why the live-tree ratchet asserts
"every tick is backed by SOME measurement" rather than "every tick is
backed by a test file" — the narrower property would have made the honest
answer look like a regression. Net 38.

### Success Criteria

- [x] SC-1955: test/sc-todo-credit.test.ts contains [a todo title declares intent, a test title declares coverage] — the same id, file and words with one modifier of difference, and the running title as the positive control
- [x] SC-1956: test/sc-todo-credit.test.ts contains [the modifiers that never run are refused and the ones that run are not] — `.todo`, `.skip`, `.skipIf`, `.todoIf` against `.only`, `.each`, `.failing`, `.concurrent`, and "not a title call" kept as a third answer
- [x] SC-1957: test/sc-todo-credit.test.ts contains [a todo is credited to nothing and reported by name] — the report is non-empty, and no id in it is also credited by a test claim
- [x] SC-1958: test/sc-todo-credit.test.ts contains [a range in a parenthetical is prose about a group, not an attribution] — the sentence from the tree verbatim, with the two attribution forms that must NOT move asserted beside it
- [x] SC-1959: test/sc-todo-credit.test.ts contains [no ticked criterion in this repo rests on a test that never runs] — the live tree, through the conformity engine, so a tick backed by a mechanical match is not reported as a regression
