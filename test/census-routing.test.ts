/**
 * #990 — a spec EDIT and a spec TICK are the same path and different events.
 *
 * `.claude/rules/self-referential-tests.md` routed the first and not the
 * second. Ticking one criterion on PR #985 moved `splitUnmatchedChecked`'s
 * claimed half 72 -> 73; every targeted suite was green locally and CI went
 * red in `test/sc-binding-split.test.ts`, a file the change does not touch.
 *
 * ## What is a witness here and what is a control
 *
 * Say which, or the next reader counts seven.
 *
 *   WITNESS  "a tick routes to the three SC census tests" — red on the
 *            pre-#990 table, which has no `spec-tick` row.
 *   WITNESS  "the rule file's table is the router's table" — red the moment
 *            the two drift, which is the only thing keeping the prose true.
 *   CONTROL  "a spec edit that ticks nothing does NOT route to them" — green
 *            on the pre-#990 table too, because that table cannot route them
 *            at all. It is not evidence of the fix. It exists to stop the
 *            cheapest wrong *generalisation* — firing `spec-tick` on every
 *            `specs/` change — from reading as a pass.
 *   CONTROL  "every routed path exists on disk" — green before and after. It
 *            stops the table naming a test that was renamed away, which is
 *            the failure mode `test/rule-provenance.test.ts` exists for one
 *            directory over.
 *
 * ## The cheapest wrong fix, named
 *
 * Add the bash row to the rule file and stop. The symptom — "an agent who
 * reads the list still misses the census tests" — goes away for anybody who
 * reads the list, and the list is prose, so it rots at the next rename with
 * nothing to notice. Every case below drives the router, so none of them is
 * satisfied by an edit to the document alone; and the table-agreement case
 * turns the document into something that cannot silently disagree with code.
 *
 * SC ids in fixtures are in the 9000 range on purpose — a real id in a test
 * is credited as covered (`.claude/rules/claiming-sc-coverage.md`), so a test
 * about routing SC census checks would otherwise tick the criteria it names.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (12 tests). The named cases were predicted before the
 * battery ran, and the baseline row was read first — an instrument that has
 * stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 12 pass, 0 fail | **12 pass, 0 fail** | — |
 * | the `spec-tick` entry deleted — the genuinely pre-#990 table | the 7 named below | **7 of 12** | `{path: "specs/HARNESS-STANDARD.md", added: ["- [x] SC-9101: …"]}`: the original routes the three SC census files, the mutant routes only the spec-edit pair |
 * | `spec-tick.fires` widened to any `specs/*.md` change — the cheapest wrong generalisation | 3 | **3 of 12** | `{path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9103: …"]}`: the original routes two tests, the mutant routes five |
 * | the tick row deleted from the rule file's table, router untouched | 2 | **2 of 12** | the document itself: the rendered table no longer appears in it |
 * | the `---` header no longer skipped in `parseUnifiedDiff` | 1 | **1 of 12** | the seven-line diff in the last describe: `removed` gains `"-- a/specs/X.md"` |
 *
 * The first row's PREDICTION was written as a list of seven case names and
 * then mis-added to six in the same sentence. The seven measured are the
 * seven named; the arithmetic was wrong and the prediction was not. Recorded
 * rather than quietly corrected, because a row that matches after the number
 * is edited is not a row anybody can check.
 *
 * Row 2 is the one that makes the control case above a measurement. Row 3
 * is the instrument: without it the table could drift from the router with
 * everything else green, which is the state this issue is about.
 *
 * None of the four is left in the tree; all were run and reverted, and
 * `scripts/census-routing.ts` and
 * `.claude/rules/self-referential-tests.md` were confirmed byte-identical to
 * the measured source afterwards by sha256.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  CENSUS_TRIGGERS,
  allCensusTests,
  censusDirsRead,
  censusTestsFor,
  ownSpecTestPath,
  parseUnifiedDiff,
  testPopulationCensusSuites,
  type Change,
} from "../scripts/census-routing";
import { TRACKED_ID_PREFIXES } from "../lib/sc-ids";
import { LINE_CITATION } from "../lib/line-citation";
import { stripJsComments } from "../lib/strip-js-comments";

const REPO = join(import.meta.dir, "..");
const RULE = join(REPO, ".claude/rules/self-referential-tests.md");

/**
 * A routed test path as it is spelled in the rule file's section.
 *
 * ONE binding, read by the section comparison and by the derived-row cell
 * check, because two spellings of "what a test path looks like" are two
 * deciders and a mutation of either leaves the other holding the case up.
 *
 * The class admits `/`, and that is #1547's second flat-`test/` assumption.
 * Written `[\w.-]+` it cannot match `test/unit/ambiguous-anchor.test.ts` at
 * all, so routing a suite from a SUBDIRECTORY made the section comparison
 * red for a correct change: the path was in `allCensusTests()` and
 * unmatchable in the prose. The narrow form was not catching anything the
 * wide one misses — a path is a path at any depth.
 */
const ROUTED_TEST_PATH = /test\/[\w.\/-]+\.test\.tsx?/g;

// Four since #1161 added `ticked-sc-absent-symbol`, which refuses a tick
// naming a symbol the tree does not contain — an event only a spec edit can
// cause, in a file the spec edit does not touch. Written out rather than
// read from `CENSUS_TRIGGERS`, because a list derived from the thing it
// checks agrees with it by construction.
const SC_CENSUS = [
  "test/sc-binding-split.test.ts",
  "test/ticked-sc-cover.test.ts",
  "test/behavioral-sc-ratchet.test.ts",
  "test/ticked-sc-absent-symbol.test.ts",
];

// The two files #1306 measured as reddening on a new spec and routed by
// nothing. Written out rather than read from `CENSUS_TRIGGERS`, for the same
// reason `SC_CENSUS` is: a list derived from the thing it checks agrees with
// it by construction.
const NEW_SPEC_CENSUS = ["test/audit-specs.test.ts", "test/scanner.test.ts"];

const change = (p: Partial<Change> & { path: string }): Change => ({
  isNew: false,
  added: [],
  removed: [],
  // No census trigger reads `hunks`; `lib/text-dependents.ts` does (#1054).
  hunks: [],
  ...p,
});

describe("#990: a tick is routed, and an edit that is not a tick is not", () => {
  // WITNESS. The whole of #990.
  test("ticking a criterion routes to all three SC census tests", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["- [x] SC-9101: a thing is true"] }),
    ]);
    for (const t of SC_CENSUS) {
      expect(tests, `a tick did not route to ${t} — this is #985 again`).toContain(t);
    }
  });

  // The discrimination that makes the case above a measurement. A spec tick
  // also fires `spec-edit`, so `tests.length > 0` is green under a router
  // with no `spec-tick` row at all. Naming the three paths is what differs.
  test("a tick routes to MORE than the spec-edit pair", () => {
    const tick = censusTestsFor([
      change({ path: "specs/X.md", added: ["- [x] SC-9102: another thing"] }),
    ]);
    const edit = censusTestsFor([change({ path: "specs/X.md", added: ["some prose"] })]);
    expect(edit.tests.length, "the spec-edit row stopped firing").toBeGreaterThan(0);
    expect(
      tick.tests.length - edit.tests.length,
      "a tick and a prose edit route to the same set, so the tick row is doing nothing",
    ).toBe(SC_CENSUS.length);
  });

  // The SECOND namespace, and the row that would have caught #1298 leaving
  // this router behind. `CRC-A1`..`CRC-N5` are tracked criteria by
  // `TRACKED_ID_PREFIXES`, so ticking one moves `UNCLAIMED_RATCHET`,
  // `CLAIMED_UNBINDABLE` and the per-spec census exactly as ticking an `SC-`
  // does — and until the prefix here came out of `lib/sc-ids.ts`, a `CRC-`
  // tick routed the spec-edit pair and nothing else.
  //
  // Driven from `TRACKED_ID_PREFIXES` rather than over the literal string
  // "CRC", so a THIRD prefix added to that list is covered the day it lands
  // instead of reproducing this defect a second time. `SC` is skipped
  // because the two cases above already measure it; what this asserts is
  // that no member of the list is unrouted.
  //
  // The baseline is a prose edit to the SAME path, not to `specs/X.md`. #1442
  // added a row whose target is derived from the spec's own name, so a
  // baseline on a different spec varies two things at once — the tick AND
  // whether the spec has a suite named after it — and the delta would be 5
  // for `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` and 4 for a spec with no such
  // suite. Same path, differing only in the tick, is the pair discipline
  // `.claude/rules/checks-must-be-able-to-fail.md` asks for.
  test("every tracked prefix routes a tick, not only the first one", () => {
    const edit = censusTestsFor([
      change({ path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"] }),
    ]);
    for (const prefix of TRACKED_ID_PREFIXES) {
      const { tests } = censusTestsFor([
        change({
          path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md",
          added: [`- [x] ${prefix}-9104: a criterion in the ${prefix} namespace`],
        }),
      ]);
      for (const t of SC_CENSUS) {
        expect(tests, `a ${prefix}- tick did not route to ${t} — #990 in a second namespace`)
          .toContain(t);
      }
      // Same discrimination as the SC case: `spec-edit` fires on any specs/
      // line, so membership alone is green under a router with no tick row.
      expect(
        tests.length - edit.tests.length,
        `a ${prefix}- tick routes the same set as a prose edit`,
      ).toBe(SC_CENSUS.length);
    }
    expect(
      TRACKED_ID_PREFIXES.length,
      "the prefix list is empty, so the loop above asserted nothing",
    ).toBeGreaterThan(1);
  });

  // CONTROL against the cheapest wrong generalisation: fire on any specs/
  // change. That would make the witness above green while routing three
  // census suites on every spec edit in the repo.
  test("a spec edit that ticks nothing does not route to the SC census", () => {
    const { tests } = censusTestsFor([
      change({
        path: "specs/HARNESS-STANDARD.md",
        added: ["- [ ] SC-9103: a new, unticked criterion", "some prose"],
        removed: ["older prose"],
      }),
    ]);
    for (const t of SC_CENSUS) {
      expect(tests, `an unticked edit routed to ${t}`).not.toContain(t);
    }
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // An UNTICK lowers the same numbers. `sc-binding-split.test.ts` brackets
  // both of its counts with an equality, so a fall is red there even where
  // `ticked-sc-cover.test.ts`'s per-spec `<=` ratchet stays green — which is
  // the inverse #990 says it does not cover, and routing it is free.
  test("unticking a criterion routes to the same three", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/X.md", removed: ["- [x] SC-9104: withdrawn"] }),
    ]);
    for (const t of SC_CENSUS) expect(tests).toContain(t);
  });

  test("a change outside specs/ carrying a ticked line does not route the census", () => {
    // A docstring quoting a criterion is not a tick. The path is half the
    // trigger for exactly this reason.
    const { tests } = censusTestsFor([
      change({ path: "lib/thing.ts", added: ["// - [x] SC-9105: quoted in a comment"] }),
    ]);
    for (const t of SC_CENSUS) expect(tests).not.toContain(t);
  });
});

describe("#990: the rule file's block is the router's table", () => {
  /**
   * Rendered from the triggers, so the document has no independent copy to
   * drift. This is the answer to "what keeps the prose correct when the
   * census set changes": nothing in the document is maintained by hand.
   */
  function expectedBlock(): string {
    const rows = CENSUS_TRIGGERS.map(
      t =>
        `| ${t.event} | ${t.derivedTarget ?? t.tests.map(p => `\`${p}\``).join(" ")} |`,
    );
    return ["| what you did | what to run |", "|---|---|", ...rows].join("\n");
  }

  test("the table in the rule file is byte-identical to the rendered one", () => {
    const doc = readFileSync(RULE, "utf-8");
    expect(
      doc.includes(expectedBlock()),
      "the routing table in .claude/rules/self-referential-tests.md no longer matches " +
        "CENSUS_TRIGGERS in scripts/census-routing.ts. The router is the source of truth; " +
        `replace the table with exactly:\n\n${expectedBlock()}\n`,
    ).toBe(true);
  });

  test("the rule file names no census test the router cannot route", () => {
    // The other direction. Without it the document may carry an extra row
    // below the rendered block and still contain it.
    const doc = readFileSync(RULE, "utf-8");
    const at = doc.indexOf("## What to run before you push");
    expect(at, "the section heading moved; this search read nothing").toBeGreaterThan(-1);
    // Cut to the NEXT heading, not to the end of the document. The sections
    // below this one name census tests for other reasons, and a search over
    // the whole file is satisfied by any of them — `.claude/rules/
    // checks-must-be-able-to-fail.md`, "search the slice, not the document".
    const rest = doc.slice(at + 1);
    const end = rest.indexOf("\n## ");
    const section = end === -1 ? rest : rest.slice(0, end);
    const named = [...new Set(section.match(ROUTED_TEST_PATH) ?? [])].sort();
    expect(named.length, "the section names no test at all").toBeGreaterThan(0);
    expect(named, "a test is named in the section that no trigger routes to").toEqual(
      [...allCensusTests()].sort(),
    );
  });

  // CONTROL. A table naming a renamed-away file is a table that sends the
  // next agent to a `bun test` that silently matches nothing.
  test("every routed test exists on disk", () => {
    const missing = allCensusTests().filter(t => !existsSync(join(REPO, t)));
    expect(missing, "a routed census test does not exist").toEqual([]);
  });

  // #1442. A derived row has no fixed path list, so its cell is prose, and
  // prose in this section is read by the case above as a routed test the
  // moment it spells one. That is an accident of the regex today; this binds
  // it. A derived cell that names a concrete path would have to be in
  // `allCensusTests()` too, and a derived row's membership is a property of
  // the tree rather than of the table — which is the whole reason it is
  // derived.
  test("a derived row's table cell spells no concrete test path", () => {
    const derived = CENSUS_TRIGGERS.filter(t => t.derivedTarget !== undefined);
    expect(derived.length, "no row derives its targets, so this asserted nothing").toBeGreaterThan(
      0,
    );
    for (const t of derived) {
      expect(
        t.derivedTarget!.match(ROUTED_TEST_PATH) ?? [],
        `the ${t.id} row's table cell spells a concrete test path, which the rule file's ` +
          "section comparison would then read as a routed test",
      ).toEqual([]);
    }
  });

  test("the router routes the SC census, which it is the point of", () => {
    // Non-vacuity for the two cases above: they compare sets, and two empty
    // sets are equal.
    for (const t of SC_CENSUS) expect(allCensusTests()).toContain(t);
  });
});

describe("#1306: adding a spec is a third event, with its own blast radius", () => {
  /**
   * #990 split `specs/` into an edit and a tick. It is three events, not two:
   * ADDING a spec reddens census files that neither of the other two can.
   *
   * Measured on this tree rather than grepped. A probe spec was planted in
   * `specs/`, the 143 test files whose source names `specs` were run against
   * it, and the baseline was read first — 6802 pass, 0 fail, 143 files. With
   * the probe present, six files went red, of which `sc-fixture-namespace`
   * was the probe's own fault (its id sat in the reserved fixture range above
   * nine thousand; re-cut below that floor, where a real allocation lands, it
   * is green — and that is the input on which the two probes differ). The id
   * is spelled in words here deliberately: writing the digits would plant a
   * live-namespace fixture id in a test file, which `SC-1522` refuses, and
   * this docstring did exactly that on its first push. The five that fire on
   * an ordinary new spec:
   *
   *   test/scaffold-conformity.test.ts   DRIFT-2, HYGIENE-2/3/4   routed: new-file
   *   test/agents-md-spec-listing.test.ts SC-1891                 routed: spec-edit
   *   test/audit-specs.test.ts           SC-398 compliance:strict routed: NOTHING
   *   test/scanner.test.ts               #91 docs-routing count   routed: NOTHING
   *   test/spec-drift.test.ts            DRIFT-2                  routed: NOTHING
   *
   * `spec-drift.test.ts` is deliberately NOT routed. Its whole body is
   * `runSpecDrift(ROOT)` — the same binding `scaffold-conformity.test.ts`
   * runs DRIFT-2 through, and that file is already routed by `new-file`. Two
   * deciders that agree are behaviourally one, and a row naming both spends
   * instruction surface to run the same check twice.
   *
   * So the row routes two files and costs 1.3s, against a 36-file list the
   * issue sized by grep. The denominator matters less than the direction: a
   * router that names everything is ignored, and an ignored router is the
   * state before #990.
   *
   * ## What was broken to prove it, run and counted
   *
   * Over this file (15 tests). Every count AND membership was predicted
   * before the battery ran, and the baseline row was read first.
   *
   * | Row | Predicted | Measured | The input on which mutant and original differ |
   * |---|---|---|---|
   * | **baseline** — unmutated | 15 pass, 0 fail | **15 pass, 0 fail** | — |
   * | the `new-spec` row deleted — the genuinely pre-#1306 router | 3: W1, T1, T2 | **3 of 15**, the three named | `{path: "specs/NEW-THING-SPEC.md", isNew: true}`: the original routes `audit-specs` and `scanner`, the mutant routes neither |
   * | wrong fix #1, router only: the two appended to `spec-edit` | 3: C2, T1, T2 | **2 of 15**: C2, T1 | a prose edit to an existing spec: the original routes neither file, the mutant routes both |
   * | wrong fix #2, router only: the two appended to `new-file` | 3: C3, T1, T2 | **2 of 15**: C3, T1 | a new `lib/unrelated.ts`: same |
   * | wrong fix #1 applied FAITHFULLY — router AND rendered table | not predicted | **1 of 15**: C2 | the prose edit above |
   * | wrong fix #2 applied FAITHFULLY — router AND rendered table | not predicted | **1 of 15**: C3 | the new `lib/` file above |
   *
   * **Rows 3 and 4 came back LOW, and the reason is a fact about T2 worth
   * recording rather than a collapsed pair.** T2 compares the SET of test
   * names in the rule file's section to `allCensusTests()`. Moving a test
   * from one row to another leaves that set identical, so T2 cannot see row
   * placement at all — by design, since what it exists to catch is a test
   * named in the prose that no row routes. Only T1, which is byte-for-byte,
   * sees which row a test sits on. The prediction assumed two table cases
   * where there is one.
   *
   * **Rows 5 and 6 are the ones that matter, and they are why rows 3 and 4
   * are not the real measurement.** T1 goes red the instant the router
   * changes, so nobody can apply either wrong fix and leave it: the 5pm
   * repair regenerates the table in the same breath, and then T1 and T2 are
   * both green. What is left is one case — the control written against that
   * exact fix — and it is red. Both controls survive their wrong fix
   * NON-vacuously, which is the only grade of survival that is protection.
   */
  const newSpec = () =>
    censusTestsFor([change({ path: "specs/NEW-THING-SPEC.md", isNew: true, added: ["# New"] })]);

  // WITNESS. Red on the pre-#1306 router, which routes neither.
  test("adding a specs/ file routes the census tests a new spec reddens", () => {
    const { tests } = newSpec();
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `adding a spec did not route to ${t} — this is #1298 again`).toContain(t);
    }
  });

  // CONTROL against the cheapest wrong fix: append the two to `spec-edit`.
  // That is one line, it makes the witness above green, and it routes them on
  // every prose edit to every spec forever. Measured: a prose edit to
  // `specs/CODE-REVIEW-CONVERGENCE-SPEC.md` reddens neither file.
  test("a prose edit to an existing spec does not route them", () => {
    const { tests } = censusTestsFor([
      change({ path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"] }),
    ]);
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `a prose edit routed to ${t}, which it cannot redden`).not.toContain(t);
    }
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // CONTROL against the second-cheapest wrong fix: append the two to
  // `new-file`, which already fires on this diff. Also one line, also makes
  // the witness green, and routes a spec census on every new `lib/` file.
  test("a new file outside specs/ does not route them", () => {
    const { tests } = censusTestsFor([
      change({ path: "lib/unrelated.ts", isNew: true, added: ["export const a = 1;"] }),
    ]);
    for (const t of NEW_SPEC_CENSUS) {
      expect(tests, `a new lib/ file routed to ${t}`).not.toContain(t);
    }
    expect(tests, "the new-file row stopped firing").toContain(
      "test/scaffold-conformity.test.ts",
    );
  });
});

describe("#990: the diff parser does not invent a tick", () => {
  test("a `--- a/path` header is not read as a removed line", () => {
    // `--- a/specs/X.md` starts with `-`. Counted as a removal, every diff
    // touching a spec would look like an untick — the router would fire on
    // every spec edit and the control case above would be the only thing
    // between that and a silently useless table.
    const diff = [
      "diff --git a/specs/X.md b/specs/X.md",
      "index 1111111..2222222 100644",
      "--- a/specs/X.md",
      "+++ b/specs/X.md",
      "@@ -1 +1 @@",
      "-older prose",
      "+newer prose",
    ].join("\n");
    const [c] = parseUnifiedDiff(diff);
    expect(c.path).toBe("specs/X.md");
    expect(c.removed).toEqual(["older prose"]);
    expect(c.added).toEqual(["newer prose"]);
    expect(censusTestsFor([c]).tests).not.toContain("test/sc-binding-split.test.ts");
  });

  test("a new file is read as new, and a modified one is not", () => {
    const diff = [
      "diff --git a/test/new-thing.test.ts b/test/new-thing.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/new-thing.test.ts",
      "@@ -0,0 +1 @@",
      '+test("x", () => {});',
      "diff --git a/lib/old.ts b/lib/old.ts",
      "--- a/lib/old.ts",
      "+++ b/lib/old.ts",
      "@@ -1 +1 @@",
      "+const a = 1;",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.map(c => [c.path, c.isNew])).toEqual([
      ["test/new-thing.test.ts", true],
      ["lib/old.ts", false],
    ]);
    const { tests } = censusTestsFor(parsed);
    expect(tests).toContain("test/sc-id-namespace.test.ts");
    expect(tests).toContain("test/package-closure.test.ts");
  });

  test("each fired row carries the paths that fired it", () => {
    // A router that says what to run and not why is a list again.
    const { fired } = censusTestsFor([
      change({ path: "specs/A.md", added: ["- [x] SC-9106: a"] }),
      change({ path: "lib/b.ts", added: ["const b = 1;"] }),
    ]);
    const tick = fired.find(f => f.trigger.id === "spec-tick");
    expect(tick?.because).toEqual(["specs/A.md"]);
  });
});

/**
 * #1368: a generated workflow is routed to the suites that READ it.
 *
 * `lib/scaffold/**` already routed to the ownership family — which files the
 * scaffold owns, which gates exist, which hooks are traceable. Nothing routed
 * to the suites that read the committed `.github/workflows/*.yml` and assert
 * properties of its TEXT.
 *
 * Paid for on PR #1351. Shard 3 went red on `AC-2 (#1116)` in
 * `test/ai-review-runner-shell-parity.test.ts` — two new `rf=$(...)`
 * assignments were #1110's shape — after every suite the router named, and
 * the four `ai-review-*` suites a person would think to name, came back
 * green locally. The guard is unreachable from the diff by any route an
 * agent would take: not the source file's own suite, not the ownership
 * family, and its name shares no string with anything in the diff.
 */
const GENERATED_WORKFLOW_CENSUS = [
  "test/ai-review-runner-shell-parity.test.ts",
  "test/action-pin-parity.test.ts",
  "test/scaffold-permissions-merge.test.ts",
  // #1401. Both caught a real defect in #1387, both on shard 4, and both
  // survived a targeted run of the three above. Same shape as #1351: a
  // guard the diff gives an agent no route to.
  "test/ai-review-wif.test.ts",
  "test/no-fixed-window-slices.test.ts",
];

/**
 * #1387's diff, verbatim, as the exemplar that motivated #1401.
 *
 * `git show --name-only --format='' 1de742aa` — the merge of #1387, the
 * change on which both new members caught something. Written out rather
 * than read from git, because a fixture that re-reads the commit tests
 * whatever that commit is today, and the point is the shape of the diff
 * that was in front of CI.
 */
const PR_1387_PATHS = [
  ".github/workflows/ai-review.yml",
  "lib/scaffold/ai-review-step.ts",
  "specs/CODE-REVIEW-CONVERGENCE-SPEC.md",
  "test/ai-review-rounds-step.test.ts",
];

describe("#1368: a generated workflow routes to the suites that read it", () => {
  test("PR #1351's own diff routes the guard that caught it", () => {
    const { tests } = censusTestsFor([
      change({ path: "lib/scaffold/ai-review-step.ts" }),
      change({ path: ".github/workflows/ai-review.yml" }),
    ]);
    for (const t of GENERATED_WORKFLOW_CENSUS) {
      expect(tests, `#1351's diff did not route to ${t} — this is #1368 again`).toContain(t);
    }
  });

  test("a change confined to .github/workflows/ routes something at all", () => {
    // Before this row, a diff touching only a generated workflow fired NO
    // row: the router printed nothing, which an agent reads as "nothing else
    // has an opinion about this change" rather than as "the router has no
    // rule for it". Those are the two states this whole file is about.
    const { tests } = censusTestsFor([change({ path: ".github/workflows/ai-review.yml" })]);
    expect(tests, "a generated-workflow change still routes nothing").not.toEqual([]);
    for (const t of GENERATED_WORKFLOW_CENSUS) expect(tests).toContain(t);
  });

  test("a scaffold edit routes MORE than the ownership trio", () => {
    // The discrimination, and the reason membership alone is not enough:
    // `lib/scaffold/**` fires `gates-hooks-scaffold` too, so a case asserting
    // only that SOME tests routed is green under a router with no row here.
    // `hooks/` fires that row and nothing else, so the delta is this row.
    const scaffold = censusTestsFor([change({ path: "lib/scaffold/ai-review-step.ts" })]);
    const hooks = censusTestsFor([change({ path: "hooks/Example.hook.ts" })]);
    expect(hooks.tests.length, "the gates-hooks-scaffold row stopped firing").toBeGreaterThan(0);
    expect(
      scaffold.tests.length - hooks.tests.length,
      "a scaffold edit and a hooks edit route the same set, so this row is doing nothing",
    ).toBe(GENERATED_WORKFLOW_CENSUS.length);
  });

  test("an ordinary source edit is NOT routed here", () => {
    // The negative control. A row that fires on everything routes the whole
    // suite for every diff, which is the same as having no router — and it
    // would make all three cases above pass for the wrong reason.
    const { tests } = censusTestsFor([change({ path: "lib/ai-review-rounds.ts" })]);
    for (const t of GENERATED_WORKFLOW_CENSUS) {
      expect(tests, `${t} is routed by an edit touching no generated workflow`).not.toContain(t);
    }
  });

  // #1401's own acceptance: run the amended row against the exemplar that
  // motivated it. A row justified by "it would have caught #1387" that does
  // not select those suites for #1387's actual paths is still the wrong row,
  // and nothing above would say so — the cases there use a two-path fixture
  // written to fire it.
  test("#1387's real four paths select both suites that caught it", () => {
    const { tests, fired } = censusTestsFor(PR_1387_PATHS.map(path => change({ path })));
    expect(tests, "#1387's diff does not route the WIF guard that caught it").toContain(
      "test/ai-review-wif.test.ts",
    );
    expect(tests, "#1387's diff does not route the fixed-window guard that caught it").toContain(
      "test/no-fixed-window-slices.test.ts",
    );
    // Not vacuous on the row: two of those four paths fire other rows, so a
    // table with no generated-workflow row at all still returns a non-empty
    // set for this diff. Name the row that has to be among the fired ones.
    expect(
      fired.map(f => f.trigger.id),
      "the generated-workflow row did not fire on the diff it was written for",
    ).toContain("generated-workflow");
  });

  // The spec file and the rounds-step suite in #1387's diff are the half
  // that fire OTHER rows. Without this, the case above could be green on a
  // router whose generated-workflow row matched every path.
  test("the two non-generated paths in #1387 do NOT fire this row", () => {
    const { fired } = censusTestsFor(
      ["specs/CODE-REVIEW-CONVERGENCE-SPEC.md", "test/ai-review-rounds-step.test.ts"].map(path =>
        change({ path }),
      ),
    );
    expect(fired.map(f => f.trigger.id)).not.toContain("generated-workflow");
  });
});

/**
 * #1442: a `specs/` edit routes the suite named after that spec.
 *
 * #990 split `specs/` into an edit and a tick; #1306 added the add. All three
 * route the SAME fixed set, and none of them routes the spec's OWN suite —
 * the file whose entire subject is that one document.
 *
 * Measured twice, four days apart, by the same session on two branches:
 * #1439 ticked `CRC-E4` and #1450 ticked `CRC-M11` in
 * `specs/CODE-REVIEW-CONVERGENCE-SPEC.md`, each left the criterion in the
 * not-done bucket, each ran the six suites the router printed, each was green
 * locally, and each went red in CI on `test/code-review-convergence-spec.test.ts`
 * — *"criteria in TWO buckets: the states are meant to be exclusive"*. Two CI
 * rounds for a defect a one-second local run catches, on the spec whose own
 * ranking function is rounds-to-pass.
 *
 * ## The convention, and what was deliberately NOT adopted
 *
 * `specs/<NAME>.md` routes to `test/<lowercase NAME>.test.ts` when that file
 * exists. One pair resolves on this tree, and it is the pair that cost the
 * two rounds.
 *
 * The obvious widening — also accept the name with a trailing `-spec`
 * removed — was measured and rejected. It adds four candidates:
 * `test/gate-contracts.test.ts`, `test/instruction-compliance.test.ts` and
 * `test/scaffold-decomposition.test.ts` contain their spec's filename zero
 * times and read no spec document at all (they test `gates/`, `lib/compliance`
 * and `scripts/scaffold-project.ts`), so an edit to the spec cannot redden
 * any of them; `test/agent-brief-template.test.ts` names its spec once, in a
 * `describe` title. Routing four suites that a spec edit cannot redden is the
 * "router that names more than it has to" the #1306 row above already argues
 * against, and an ignored router is the state #990 is about.
 *
 * A spec with no suite named after it routes to NOTHING, and the row does not
 * fire at all — absent, not empty. A row that fired with an empty target
 * would read exactly like a spec whose suite was renamed away.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (35 tests). Every count AND membership was predicted before
 * the battery ran, and the baseline row was read first — an instrument that
 * has stopped reporting takes the baseline down with it, and `bun` writes its
 * summary to stderr, so a reader parsing stdout alone reports nothing at all.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 35 pass, 0 fail | **35 pass, 0 fail** | — |
 * | the `spec-own-test` entry deleted, router only | 6: W1, W2, D1, F1, T3, and the byte-identity case | **6 of 35**, the six named | the CRC prose edit below |
 * | the same, applied FAITHFULLY — the rendered table reverted too | 5: W1, W2, D1, F1, T3 | **5 of 35**, the five named | `{path: "specs/CODE-REVIEW-CONVERGENCE-SPEC.md", added: ["some prose"]}`: the original routes `agents-md-spec-listing`, `spec-requirements` AND `code-review-convergence-spec`, the mutant routes the first two |
 * | the `doc` row's detector respelled back to `/[\w./-]+\.tsx?:\d+/` | 3: B1, B2, B4 | **3 of 35**, the three named | `{path: "PROJECT-STATE.md", removed: ["- the pin is read at \`workflows/ship.js:1705\`"]}` — #1466's own removed line: the original routes the ratchet pair, the mutant routes **nothing at all** |
 * | the empty-derivation filter dropped, so a derived row fires with no target | 1: C2 | **1 of 35**, the one named | `{path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9108: not yet"]}`: the original omits the row from `fired`, the mutant lists it carrying zero tests |
 * | **the cheapest wrong fix**, applied faithfully: the derived row deleted, `test/code-review-convergence-spec.test.ts` appended to `spec-edit` as a literal, table regenerated | 5: W2, D1, C2, F1, T3 | **5 of 35**, the five named | the HARNESS-STANDARD edit above: the original routes two tests, the mutant routes three, one of which is a suite about a document the diff does not touch |
 *
 * **W1 is GREEN under the wrong fix**, which is why it is not the whole
 * proof. A literal row satisfies "a spec edit routes that suite" exactly, and
 * what it cannot satisfy is D1 — the delta between a spec that has a suite
 * named after it and one that does not — or C2, or the two cases that are
 * about the derivation existing at all. Every one of C1..C3 survives the
 * wrong fixes non-vacuously, which is the only grade of survival that is
 * protection.
 *
 * Case labels, since four of the eight are controls and the next reader
 * should not count eight witnesses:
 *
 *   W1  "a prose edit to a spec routes the suite named after it"
 *   W2  "ticking a criterion routes the spec's own suite too"
 *   D1  "a spec WITH an own suite routes exactly one more test …"
 *   F1  "a spec whose suite does not exist today is routed the moment it does"
 *   T3  "a derived row's table cell spells no concrete test path"
 *   C1  "a change outside specs/ does not route a spec's own suite"
 *   C2  "a spec with no suite named after it routes nothing, and the row does not fire"
 *   C3  "a suite named after the spec's STEM is not routed when it never reads the spec"
 *   B1  "a doc LOSING a .js line citation routes the ratchet"
 *   B2  "a doc gaining a .json line citation routes the ratchet"
 *   B4  "the router and the ratchet agree about every sample, both directions"
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `scripts/census-routing.ts` and
 * `.claude/rules/self-referential-tests.md` were confirmed byte-identical to
 * the measured source afterwards by sha256.
 */
describe("#1442: a specs/ edit routes the suite named after that spec", () => {
  const CRC_SPEC = "specs/CODE-REVIEW-CONVERGENCE-SPEC.md";
  const CRC_TEST = "test/code-review-convergence-spec.test.ts";

  // Non-vacuity for every case below. Written as literals rather than read
  // from `ownSpecTestPath`, because a pair derived from the thing it checks
  // agrees with it by construction.
  test("the live pair this row exists for is still on disk", () => {
    expect(existsSync(join(REPO, CRC_SPEC)), `${CRC_SPEC} was renamed`).toBe(true);
    expect(existsSync(join(REPO, CRC_TEST)), `${CRC_TEST} was renamed`).toBe(true);
    expect(ownSpecTestPath(CRC_SPEC), "the convention stopped resolving the live pair").toBe(
      CRC_TEST,
    );
  });

  // W1. WITNESS — red on the pre-#1442 router, which routes the fixed pair
  // and nothing else for this diff.
  test("a prose edit to a spec routes the suite named after it", () => {
    const { tests } = censusTestsFor([change({ path: CRC_SPEC, added: ["some prose"] })]);
    expect(tests, `a spec edit did not route to ${CRC_TEST} — this is #1439 again`).toContain(
      CRC_TEST,
    );
  });

  // W2. WITNESS — #1439's and #1450's own event, a tick, which is the diff
  // that was in front of CI both times.
  test("ticking a criterion routes the spec's own suite too", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: CRC_SPEC, added: ["- [x] CRC-9107: a criterion that is also still in a bucket"] }),
    ]);
    expect(tests, `#1450's diff did not route to ${CRC_TEST}`).toContain(CRC_TEST);
    expect(
      fired.map(f => f.trigger.id),
      "the own-test row did not fire on the diff it was written for",
    ).toContain("spec-own-test");
  });

  // D1. The discrimination that makes W1 a measurement. A spec edit fires
  // `spec-edit` whatever else is true, so `tests.length > 0` is green on the
  // pre-#1442 router. Both halves are a prose edit to a spec; they differ in
  // exactly one thing, which is whether a suite is named after it.
  test("a spec WITH an own suite routes exactly one more test than a spec without", () => {
    const withOwn = censusTestsFor([change({ path: CRC_SPEC, added: ["some prose"] })]);
    const without = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["some prose"] }),
    ]);
    expect(without.tests.length, "the spec-edit row stopped firing").toBeGreaterThan(0);
    expect(
      withOwn.tests.length - without.tests.length,
      "the two specs route the same set, so the own-test row is doing nothing",
    ).toBe(1);
  });

  // C1. CONTROL. A diff touching no spec must not route it. Without this a
  // row that fires on everything passes W1 and D1 is the only thing between
  // that and routing the CRC suite on every diff in the repo.
  test("a change outside specs/ does not route a spec's own suite", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "lib/code-review-convergence-spec.ts", added: ["export const a = 1;"] }),
    ]);
    expect(tests, `${CRC_TEST} is routed by a change touching no spec`).not.toContain(CRC_TEST);
    expect(fired.map(f => f.trigger.id)).not.toContain("spec-own-test");
  });

  // C2. CONTROL against the cheapest wrong fix: append CRC_TEST to the
  // `spec-edit` row as a literal. One line, W1 and W2 both go green, and the
  // CRC suite then runs on every edit to every spec forever — and silently
  // routes nothing the day that file is renamed.
  //
  // It also asserts the row is ABSENT rather than firing empty: a spec with
  // no suite named after it must not appear in `fired` at all.
  test("a spec with no suite named after it routes nothing, and the row does not fire", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "specs/HARNESS-STANDARD.md", added: ["- [ ] SC-9108: not yet"] }),
    ]);
    expect(
      existsSync(join(REPO, "test/harness-standard.test.ts")),
      "a suite named after HARNESS-STANDARD.md now exists; this control needs a different spec",
    ).toBe(false);
    expect(tests, "an unrelated spec edit routed the CRC suite").not.toContain(CRC_TEST);
    expect(
      fired.map(f => f.trigger.id),
      "the own-test row fired for a spec with no own test — empty, not absent",
    ).not.toContain("spec-own-test");
    expect(tests, "the spec-edit row stopped firing").toContain("test/spec-requirements.test.ts");
  });

  // C3. CONTROL against the second wrong fix: accept the name with a trailing
  // `-spec` stripped. `test/gate-contracts.test.ts` reads `gates/` and never
  // opens `specs/GATE-CONTRACTS-SPEC.md`, so an edit to that spec cannot
  // redden it. Measured, not assumed — the case reads the file.
  test("a suite named after the spec's STEM is not routed when it never reads the spec", () => {
    const stemTest = "test/gate-contracts.test.ts";
    const spec = "specs/GATE-CONTRACTS-SPEC.md";
    expect(existsSync(join(REPO, stemTest)), `${stemTest} was renamed`).toBe(true);
    expect(
      readFileSync(join(REPO, stemTest), "utf-8").includes("GATE-CONTRACTS-SPEC.md"),
      `${stemTest} now names its spec, so the measurement behind this control has moved`,
    ).toBe(false);
    const { tests } = censusTestsFor([change({ path: spec, added: ["some prose"] })]);
    expect(tests, `${stemTest} was routed by an edit to a spec it never reads`).not.toContain(
      stemTest,
    );
  });

  // The target is DERIVED, not a list. A spec that gains a suite tomorrow is
  // routed the day it lands, and this is the only case that can say so —
  // every other one is satisfied by a literal pair written into the table.
  test("a spec whose suite does not exist today is routed the moment it does", () => {
    const spec = "specs/HARNESS-STANDARD.md";
    const future = ownSpecTestPath(spec);
    expect(
      existsSync(join(REPO, future)),
      "this case needs a pair that does NOT resolve on the live tree",
    ).toBe(false);
    const { tests } = censusTestsFor([change({ path: spec, added: ["some prose"] })], p =>
      p === future ? true : existsSync(join(REPO, p)),
    );
    expect(tests, "the row reads a fixed list, not the tree").toContain(future);
  });
});

/**
 * #1442, second population: the `doc` row's citation detector was a second
 * spelling of the ratchet's.
 *
 * `.claude/line-citation-ratchet.json` banks a count per document and
 * `test/line-citation-ratchet.test.ts` refuses a banked document that yields
 * none. The binding that decides what a citation IS is `LINE_CITATION` in
 * `lib/line-citation.ts`, and it matches `.ts`, `.js` and `.json`. This
 * router respelled it as `\.tsx?:\d+` — narrower on two extensions and wider
 * on a third.
 *
 * Measured, not inferred. PR #1466 rewrote `PROJECT-STATE.md`'s priorities
 * block and removed exactly two citations:
 *
 *   $ git show 577a078a -- PROJECT-STATE.md | grep '^-' | grep -oE '…'
 *     ship.js:2931
 *     workflows/ship.js:1705
 *
 * Both `.js`. The router saw neither, printed only the `touched specs/` row,
 * and CI went red on shard 1 with `NoLineCitationsError: PROJECT-STATE.md is
 * banked in the citation ratchet as carrying line citations and the census
 * found none`. One full CI round on a documentation-only change.
 *
 * The fix is the one `TRACKED_ID_PREFIX_SOURCE` already applies one row up:
 * import the binding instead of respelling it. A reader that respells is a
 * reader that decides again.
 */
describe("#1442: the doc row asks the ratchet's own binding what a citation is", () => {
  const RATCHET = "test/line-citation-ratchet.test.ts";
  const routes = (line: string, side: "added" | "removed" = "added") =>
    censusTestsFor([
      change({
        path: "PROJECT-STATE.md",
        added: side === "added" ? [line] : [],
        removed: side === "removed" ? [line] : [],
      }),
    ]).tests.includes(RATCHET);

  // WITNESS. #1466's own removed line, verbatim in shape.
  test("a doc LOSING a .js line citation routes the ratchet", () => {
    expect(
      routes("- the pin is read at `workflows/ship.js:1705`", "removed"),
      "a removed .js citation did not route the ratchet — this is #1466 again",
    ).toBe(true);
  });

  test("a doc gaining a .json line citation routes the ratchet", () => {
    expect(routes("see `config/check-registry.json:12`")).toBe(true);
  });

  // CONTROL. A row that fires on every markdown line would make both
  // witnesses green while routing the ratchet for every doc edit in the repo
  // — which is the `doc` row's `isNew` half doing all the work and the
  // citation half doing none.
  test("a doc edit carrying no citation does not route the ratchet", () => {
    expect(routes("a sentence about workflows/ship.js with no line number")).toBe(false);
    expect(routes("released in 1.2:3, which is a version and not a citation")).toBe(false);
  });

  // The agreement itself, in both directions. A second spelling can be
  // narrower OR wider: `.tsx:9` is matched by the old regex and by no
  // citation the ratchet counts, so a doc gaining one routed a suite that
  // could not see it.
  test("the router and the ratchet agree about every sample, both directions", () => {
    const samples = [
      "the reader is at `lib/line-citation.ts:54`",
      "the pin is at workflows/ship.js:1705",
      "the row is at config/check-registry.json:12",
      "the component is at app/Thing.tsx:9",
      "released in 1.2:3",
      "a bare lib/line-citation.ts with no line",
      "ship.js:2931 opens the line",
    ];
    const ratchet = new RegExp(LINE_CITATION.source);
    let matched = 0;
    for (const s of samples) {
      const expected = ratchet.test(s);
      if (expected) matched++;
      expect(
        routes(s),
        `the router and lib/line-citation.ts disagree about "${s}" — the router has a ` +
          "second spelling of what a citation is",
      ).toBe(expected);
    }
    expect(matched, "no sample matched, so the loop compared two constant falses").toBeGreaterThan(
      0,
    );
    expect(
      samples.length - matched,
      "every sample matched, so the loop never exercised the negative direction",
    ).toBeGreaterThan(0);
  });
});

/**
 * #1515: a DA-owned session-state write routed to nothing.
 *
 * `project-state.json`, `PROJECT-STATE.md` and `SUCCESS.md` are the three
 * files with the NARROWEST set of people who may edit them — they are
 * DA-owned (#296) and an agent in a worktree is forbidden to write them — and
 * `CENSUS_TRIGGERS` keyed on file kinds had no row any of them matched.
 * `new-file` needs `isNew`; `doc` needs `isNew` or a line citation, and a
 * session summary has neither; `rule-doc` is scoped to `CLAUDE.md`,
 * `AGENTS.md` and `.claude/rules/`; and `project-state.json` is not markdown,
 * so it matched nothing at all.
 *
 * ## Measured, on the real diff, before the row existed
 *
 * Commit `9a174688` is a session-state write touching `project-state.json`
 * and `PROJECT-STATE.md` and nothing else. Reproduced in a throwaway worktree
 * checked out at it:
 *
 *   $ bun scripts/census-routing.ts --base 9a174688^
 *   census-routing: no census test is reachable from this change
 *
 *   $ bun test test/closing-keywords.test.ts
 *   (fail) #590: the live project-state.json, read by the real comparison
 *          > the live record is read, and the reading is not empty
 *   error: no closing keyword at all was found in the live summary
 *   63 pass, 1 fail
 *
 * The same suite is green at `009562dc`, the merged version of that write
 * with the summary's closing keyword restored. So the content of
 * `project-state.json` is the input that moves it, the router answered
 * "nothing", and `no census test is reachable` and UNMEASURED were the same
 * output — which is the `0`/`{}`/`null` reading this project refuses
 * everywhere else.
 *
 * ## Why the set is PASTED, and the three derivations that failed
 *
 * `.claude/rules/checks-must-be-able-to-fail.md` asks for the instrument's
 * range, so here are all three attempts, measured on this tree:
 *
 *   - **every test file naming one of the three paths**: 68 files, including
 *     seven transcript fixtures, `test/agents-md-refs.test.ts` and
 *     `test/scaffold-ownership.test.ts`. Routing 68 is routing everything,
 *     and an ignored router is the state #990 is about.
 *   - **the issue's own hand list of nine**: wrong in three places, each
 *     checked rather than assumed. `test/distribution-currency.test.ts`
 *     names the three paths ZERO times and so does `lib/distribution-currency.ts`
 *     — it drives a mkdtemp fixture and the registry, and a trio edit cannot
 *     redden it. `test/project-state-derivation.test.ts` scans the tree with
 *     `projectStateDerivation(REPO_ROOT)` and asserts a verdict about
 *     `scripts/`, not about the trio's content.
 *     `test/project-state-suite-isolation.test.ts` reads the live trio and
 *     asserts it is BYTE-IDENTICAL before and after a run — content-invariant
 *     by construction. All three are excluded.
 *   - **a test file resolving a trio path against its repo-root constant**:
 *     returns exactly the seven below on this tree. It is used as the
 *     one-directional guard `membership` below, and NOT as the router's
 *     mechanism, because it agrees by SPELLING: `suite-isolation` escapes it
 *     only because its paths come from a `DA_OWNED` array rather than a
 *     string literal. A detector that excludes the right file for the wrong
 *     reason is `.claude/rules/checks-must-be-able-to-fail.md`'s second
 *     shape, and promoting it to the router would be a derivation that is
 *     right by luck.
 *
 * So the row is FIXED, like `generated-workflow` and for the same reason, and
 * a fixed row buys back the rename control: `every routed test exists on
 * disk` goes red the day one of the seven is renamed away, where a derived
 * row would silently stop routing it.
 *
 * ## The cheapest wrong fix, named
 *
 * Widening the `doc` row to fire on any markdown edit. It makes the symptom
 * vanish for two of the three files and routes every `README`, `docs/` and
 * council-note edit to `line-citation-ratchet` + `agents-md-refs` — the wrong
 * two suites — while STILL never routing `project-state.json`, which is not
 * markdown and is where the failing test reads from. W1 below survives it by
 * asserting the JSON path specifically, and C1 asserts the widening itself
 * did not happen.
 *
 * ## What was broken to prove it, run and counted
 *
 * Over this file (43 tests). Every count AND membership was predicted before
 * the battery ran, and the baseline row was read first — an instrument that
 * has stopped reporting takes the baseline down with it.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 43 pass, 0 fail | **43 pass, 0 fail** | — |
 * | the `state-write` row deleted AND the table reverted — the genuinely pre-#1515 state | 5: W1, W2, W3, C4, N1 | **5 of 43**, the five named | `{path: "project-state.json"}`: the original routes seven suites, the mutant routes nothing and prints `no census test is reachable` |
 * | **the cheapest wrong fix** applied faithfully: `doc` widened to any markdown, `state-write` deleted, table regenerated | 6: W1, W2, W3, C1, C4, N1 | **8 of 43**: the six named, plus two | `{path: "docs/research/a-note.md", added: ["some prose"]}`: the original routes nothing, the mutant routes the citation pair |
 * | the row's `fires` loosened from an exact path to `endsWith` | 1: C3 | **1 of 43**, the one named | `{path: "test/fixtures/project-state.json"}`: the original does not fire, the mutant routes all seven |
 * | `test/distribution-currency.test.ts` pasted into the row — the issue's own hand list — table regenerated | 1: C4 | **1 of 43**, the one named | the row's `tests` read as source: the original's seven all read a trio path from the repo root, the mutant's eighth reads none |
 * | the table row deleted from the rule file, router untouched | 2: T1, T2 | **2 of 43**, the two named | the document itself: the rendered block no longer appears in it |
 *
 * **Row 3 came back HIGH, and the two extra are recorded rather than
 * quietly folded into the prediction.** They are
 * `test/census-routing.test.ts`'s own pre-existing #1442 cases — *"a doc
 * edit carrying no citation does not route the ratchet"* and *"the router
 * and the ratchet agree about every sample, both directions"* — which
 * already guard the `doc` row's citation detector from exactly this
 * widening. The prediction was written as though C1 were the only case
 * watching that row; it is the third. The battery was right and the
 * arithmetic was not.
 *
 * Rows 3 and 5 are the ones that matter. Row 3 is the named wrong fix, and
 * C1 is red under it NON-vacuously — the only grade of survival that is
 * protection. Row 5 is the membership guard catching the precise mistake
 * this issue's own acceptance list makes.
 *
 * None of the five mutations is left in the tree; all were run and reverted,
 * and `scripts/census-routing.ts`,
 * `.claude/rules/self-referential-tests.md` and this file were confirmed
 * byte-identical to the committed source afterwards by sha256.
 *
 * Case labels, since four of the eight are controls and the next reader
 * should not count eight witnesses:
 *
 *   W1  "a diff touching only project-state.json routes closing-keywords"
 *   W2  "the real three-file state write routes every suite that reads one"
 *   W3  "each of the three files fires the row on its own"
 *   C1  "an ordinary markdown edit is not routed by the doc row or this one"
 *   C2  "a change touching none of the three does not route the state census"
 *   C3  "a nested file whose basename matches is not the live record"
 *   C4  "every suite this row routes reads a live state file from the repo root"
 *   N1  "the row's targets are in the census set and on disk"
 *   T1  "the table in the rule file is byte-identical to the rendered one"
 *   T2  "the rule file names no census test the router cannot route"
 */
describe("#1515: a DA-owned session-state write routes the suites that read it", () => {
  const STATE_TRIO = ["project-state.json", "PROJECT-STATE.md", "SUCCESS.md"];

  // Written out rather than read from `CENSUS_TRIGGERS`, for the reason
  // `SC_CENSUS` and `NEW_SPEC_CENSUS` above are: a list derived from the
  // thing it checks agrees with it by construction.
  const STATE_CENSUS = [
    "test/closing-keywords.test.ts",
    "test/project-state-currency.test.ts",
    "test/project-state-shape.test.ts",
    "test/update-project-state.test.ts",
    "test/success-doc.test.ts",
    "test/distribution-standing.test.ts",
    "test/rule-lifecycle-spec.test.ts",
  ];

  // W1. WITNESS, and the issue's literal acceptance: the JSON half. This is
  // the one the markdown-widening wrong fix cannot satisfy, because
  // `project-state.json` is not markdown.
  test("a diff touching only project-state.json routes closing-keywords", () => {
    const { tests } = censusTestsFor([
      change({ path: "project-state.json", added: ['      "summary": "a session"'] }),
    ]);
    expect(
      tests,
      "a project-state.json edit did not route test/closing-keywords.test.ts — this is " +
        "#1515 again, and #590 is red on exactly that diff",
    ).toContain("test/closing-keywords.test.ts");
  });

  // W2. The whole trio, which is the shape of a real session-state write.
  test("the real three-file state write routes every suite that reads one", () => {
    const { tests, fired } = censusTestsFor(
      STATE_TRIO.map(path => change({ path, added: ["a session summary line"] })),
    );
    for (const t of STATE_CENSUS) {
      expect(tests, `the state trio did not route to ${t}`).toContain(t);
    }
    expect(
      fired.map(f => f.trigger.id),
      "the state-write row did not fire on the diff it was written for",
    ).toContain("state-write");
  });

  // W3. Each file alone fires the row. `9a174688` touched two of the three,
  // and a row that needed all three would have been silent on it.
  test("each of the three files fires the row on its own", () => {
    for (const path of STATE_TRIO) {
      const { fired } = censusTestsFor([change({ path, added: ["x"] })]);
      expect(
        fired.map(f => f.trigger.id),
        `${path} alone did not fire the state-write row`,
      ).toContain("state-write");
    }
  });

  // C1. CONTROL against the named cheapest wrong fix. Widening `doc` to any
  // markdown makes W2 go green for two of the three paths while routing the
  // citation pair on every doc edit in the repo. Measured: an ordinary
  // markdown edit carrying no citation routes nothing.
  test("an ordinary markdown edit is not routed by the doc row or this one", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "docs/research/a-note.md", added: ["some prose about the thing"] }),
    ]);
    expect(
      tests,
      "an ordinary markdown edit routed the citation ratchet — the doc row was widened " +
        "to any markdown, which is #1515's named cheapest wrong fix",
    ).not.toContain("test/line-citation-ratchet.test.ts");
    expect(fired.map(f => f.trigger.id)).not.toContain("state-write");
    for (const t of STATE_CENSUS) {
      expect(tests, `an ordinary markdown edit routed ${t}`).not.toContain(t);
    }
  });

  // C2. CONTROL against a row that fires on everything, which would make
  // every witness above green while routing seven suites on every diff.
  test("a change touching none of the three does not route the state census", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "lib/project-state-shape.ts", added: ["export const a = 1;"] }),
    ]);
    expect(fired.map(f => f.trigger.id)).not.toContain("state-write");
    for (const t of STATE_CENSUS) {
      expect(tests, `${t} is routed by a change touching no DA-owned state file`).not.toContain(t);
    }
  });

  // C3. CONTROL against a path that merely CONTAINS a trio name. A consumer
  // project's fixture at `test/fixtures/project-state.json` is not the live
  // record, and a row matching on substring would route seven suites for it.
  test("a nested file whose basename matches is not the live record", () => {
    for (const path of [
      "test/fixtures/project-state.json",
      "reference/PROJECT-STATE.md",
      "docs/SUCCESS.md",
    ]) {
      const { fired } = censusTestsFor([change({ path, added: ["x"] })]);
      expect(
        fired.map(f => f.trigger.id),
        `${path} fired the state-write row, but it is not the repo-root record`,
      ).not.toContain("state-write");
    }
  });

  // C4. The membership guard, and the reason the pasted list cannot quietly
  // rot into one that routes suites a state write cannot reach. Every suite
  // this row names must resolve a trio path against its own repo-root
  // constant — which is what makes the live file an INPUT to it rather than a
  // string it mentions.
  //
  // ONE-DIRECTIONAL on purpose. The reverse — every file matching this
  // detector must be routed — is NOT asserted, because the detector agrees
  // with the list by spelling: `test/project-state-suite-isolation.test.ts`
  // reads the live trio through a `DA_OWNED` array and must stay OUT of the
  // row, since it asserts those files are byte-identical before and after a
  // run and no content edit can move it. Asserting the reverse would redden
  // the day somebody inlines those literals, and the remedy it would demand —
  // route a content-invariant suite — is the wrong one.
  test("every suite this row routes reads a live state file from the repo root", () => {
    const row = CENSUS_TRIGGERS.find(t => t.id === "state-write");
    expect(row, "the state-write row is gone, so this asserted nothing").toBeDefined();
    const reads = new RegExp(
      `(join|resolve)\\([A-Z_]*(ROOT|REPO)[A-Z_]*, *"(${STATE_TRIO.map(f =>
        f.replace(/\./g, "\\."),
      ).join("|")})"\\)`,
    );
    const notReaders = row!.tests.filter(t => !reads.test(readFileSync(join(REPO, t), "utf-8")));
    expect(
      notReaders,
      "this row routes a suite that never reads project-state.json, PROJECT-STATE.md or " +
        "SUCCESS.md from the repo root, so a state write cannot redden it — " +
        "test/distribution-currency.test.ts names the three paths zero times and was " +
        "excluded for exactly this reason",
    ).toEqual([]);
    expect(
      row!.tests.length,
      "the row routes nothing, so the filter above compared two empty lists",
    ).toBeGreaterThan(0);
  });

  // Non-vacuity for W1/W2: two empty sets are equal, and a `toContain` over a
  // list nobody populated is the assertion that holds vacuously.
  test("the row's targets are in the census set and on disk", () => {
    for (const t of STATE_CENSUS) {
      expect(allCensusTests(), `${t} is not routed by any row`).toContain(t);
      expect(existsSync(join(REPO, t)), `${t} does not exist`).toBe(true);
    }
  });
});

/**
 * #1547: the question neither decider is asked is "is this list complete?"
 *
 * Every case above this one is about a row that exists. The two cases in
 * *"the rule file's block is the router's table"* compare `CENSUS_TRIGGERS`
 * to the rendered prose in both directions — and both directions are about
 * AGREEMENT BETWEEN TWO DOCUMENTS. A census suite absent from both leaves
 * them in perfect agreement and the suite green. Two deciders answering the
 * same question, which is `.claude/rules/checks-must-be-able-to-fail.md`'s
 * fourth shape, and it cost three agents one CI round each in a single day:
 *
 *   #1286 / PR #1537  added a test file, ran everything the router printed,
 *                     shipped a red `test-shard (3)` — `scratch-cleanup`.
 *   #1540 / PR #1546  changed `config/prove-evidence.schema.json`; the router
 *                     named no row for it at all, and the second consumer was
 *                     found by grepping.
 *
 * ## How a census-style suite is identified, and why that shape
 *
 * `censusDirsRead` derives it: a suite ENUMERATES a directory resolved from
 * its own repo-root binding. A set of files is the one input no import edge
 * expresses and no diff contains, which is exactly why
 * `scripts/select-affected-tests.ts` cannot reach these and this router
 * exists. Reading a single NAMED file from the root is deliberately not
 * enough — most of `test/` does that, and a router that names everything is
 * one nobody runs.
 *
 * ## What this check is scoped to, and the numbers behind the scoping
 *
 * The population is the suites that enumerate `test/`, held against the row
 * that declares itself the router for adding a file there. Completeness is
 * only well defined against a row that names an event.
 *
 * The general form — *every path class a census suite reads is named by some
 * row* — was derived and REJECTED on measurement, not assumed away. Over the
 * 610 suites under `test/`, `censusDirsRead` yields **43 (suite, directory)
 * pairs across 14 directories**, and requiring a change in D to route every
 * suite that enumerates D leaves **42 of the 43 unrouted**. Satisfying it
 * means firing census suites on substantially every diff to `lib/`,
 * `scripts/`, `test/` and `workflows/` — the "router that names more than it
 * has to" the `new-spec` and `spec-own-test` rows above are each explicitly
 * scoped to avoid. The crude form fails the same way: of those 14
 * directories, an ordinary edit fires any row in only **4**.
 *
 * Both figures were RE-MEASURED after the recursion fix, and the first
 * reading of them was wrong in a way worth recording. It reported "37 of 44
 * unrouted" for this property, but what it had actually counted was suites
 * absent from `allCensusTests()` — membership in ANY row, not "a change in D
 * routes S". Two different questions, one number, and the prose claimed the
 * stricter one. The scan was also top-level only, so it never saw `test/`'s
 * subdirectories at all.
 *
 * So the second direction is routed EXPLICITLY — the `config-registry` row —
 * and this is the sentence saying so, because "we routed the one path we
 * noticed" is how the first omission happened. Both numbers and the full
 * sweep are in `reference/self-referential-tests-worked-instances.md`.
 *
 * ## What was broken to prove it, run and counted
 *
 * Baseline read first, before the predicate existed: `bun test
 * test/census-routing.test.ts` was **43 pass, 0 fail**.
 *
 * The battery was run TWICE: once on the first cut, and again after the AI
 * review on PR #1556 found that `testPopulationCensusSuites` read only the
 * top level of `test/`. Both rounds are kept. The first round's wrong
 * predictions are left standing — a row that matches once the number has
 * been edited is not a row anybody can check.
 *
 * ### Round 1, on the first cut (52 cases)
 *
 * | Row | Predicted | Measured |
 * |---|---|---|
 * | **baseline** | 52 pass, 0 fail | **52 pass, 0 fail** |
 * | the three suites removed from `new-test-file`, table reverted | 2: W1, W3 | **2 of 52**, the two named |
 * | a census-style suite PLANTED at the top level | 1: W1 | **1 of 52**, the one named |
 * | the `config-registry` row deleted, table reverted | 3: W4, T1, T2 | **1 of 52**: W4 |
 * | the argument reader replaced by `[^,)]+` | 2: D1, W1 | **3 of 52**: W2, X1, D1 |
 * | the monotone exclusions emptied | 3 | **1 of 52**: W1 |
 *
 * **Three of those five predictions were wrong.** The config row came back
 * LOW for the reason #1306's rows 3 and 4 did, one table over: the mutation
 * reverts the rendered table in the same breath, so T1 and T2 agree again
 * and only the behavioural case is left. The exclusions row came back LOW
 * because X1 is satisfied by an EMPTY list — it guards an exclusion that
 * stopped applying, not the decision to have none.
 *
 * The truncating-reader row came back HIGH, and that one is the lesson. It
 * does not make W1 red at all: it SHRINKS the population until the survivors
 * happen to be routed, so the completeness case goes green having witnessed
 * nothing. What reports it is W2 and X1 — the MEMBERSHIP cases. This
 * instrument fails by going quiet, and a verdict case cannot catch a quiet
 * instrument.
 *
 * ### Round 2, after the recursion fix (54 cases)
 *
 * Every count AND membership below was predicted before the battery ran, and
 * the baseline row was read first.
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 54 pass, 0 fail | **54 pass, 0 fail** | — |
 * | the four suites removed from `new-test-file`, table reverted — the genuinely pre-#1547 router | 2: W1, W3 | **2 of 54**, the two named | `{path: "test/x.test.ts", isNew: true}`: the original routes six suites, the mutant routes two |
 * | a census suite PLANTED at `test/zz-planted-census.test.ts` | 1: W1 | **1 of 54**: W1, **naming the planted file** | the planted file: the population is 8 suites, the mutant's 9, and the ninth is in no row |
 * | a census suite PLANTED at `test/unit/zz-planted-census.test.ts` | 1: W1 | **1 of 54**: W1, **naming the planted file** | the same file one directory down |
 * | the SAME planted subdirectory file, with the walk reverted to a flat `readdirSync` | 2: W2, D2, and W1 does NOT name it | **2 of 54**: W2, D2, and the planted file appears nowhere in the output | the planted file: the recursive walk derives it, the flat one cannot see it at all |
 * | the `config-registry` row deleted, table reverted | 1: W4 | **1 of 54**: W4 | `{path: "config/check-registry.json"}`: the original routes two suites, the mutant nothing |
 * | the argument reader replaced by `[^,)]+` | 4: W2, D2, X1, D1 | **4 of 54**, the four named | `test/sc-id-namespace.test.ts`'s own source: the original reads `test`, the mutant reads `join(REPO` |
 * | the monotone exclusions emptied | 1: W1 | **1 of 54**: W1 | the live tree: three suites whose tree scan is a lower bound are demanded of a row that cannot move them |
 * | the walk reverted to a flat `readdirSync`, nothing planted | 2: W2, D2 | **2 of 54**, the two named | `test/unit/ambiguous-anchor.test.ts`: the recursive walk derives it, the flat one does not |
 *
 * **Nine of nine held this round, counts and membership.**
 *
 * ### Round 3, after the AI review on PR #1556 found the keyword regex (57 cases)
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 57 pass, 0 fail | **57 pass, 0 fail** | — |
 * | `repoRootIdents(code)` reverted to `repoRootIdents(src)` | 1: D5 | **1 of 57**: D5 | a root bound only inside a string literal: the original reads no root, the mutant reads one and derives `[""]` |
 * | `blankLiterals` dropped from the code view | 4: W1, C1, D4, D5 | **3 of 57** first, **4 of 57** after D4 was repaired | this test file's own quoted fixtures: the original reads them as text, the mutant as code |
 * | the walk reverted to a flat `readdirSync`, nothing planted | 2: W2, D2 | **2 of 57**, the two named | unchanged from round 2 — the recursion evidence survives the refactor |
 *
 * **Three of four held. The wrong one is the useful one.** Row 3 was
 * predicted at 4 and measured 3: D4 asserted `src.includes("blankLiterals")`
 * over the RAW file, and the docblock above the call contains that word, so
 * deleting the call left the check green. A structural assertion satisfied
 * by a comment saying the thing was done is #1322's shape, inside the very
 * block that argues for one decider. D4 now reads the comment-stripped
 * source and matches the CALL, with a control asserting nothing before the
 * function satisfies it; re-measured, the row is 4 as predicted.
 *
 * Both defects this round were LATENT on this tree: the population is 9
 * suites before and after, with the same members. The keyword case has no
 * current member — no suite in `test/` carries a regex literal after a
 * keyword ahead of its census read — so unlike round 2 this is "a gap with
 * no member", and saying which it is was the distinction round 2 turned on.
 *
 * ### Round 4, after the review found the THIRD site reading the wrong view (58 cases)
 *
 * | Row | Predicted | Measured | The input on which mutant and original differ |
 * |---|---|---|---|
 * | **baseline** — unmutated | 58 pass, 0 fail | **58 pass, 0 fail** | — |
 * | `repoRootIdents(code)` reverted to `(src)` | 2: D4, D5 | **2 of 58**, the two named | a root bound only inside a string literal |
 * | `firstArgument(code, src,` reverted to `(src, src,` | 2: D4, D6 | **2 of 58**, the two named | `join(REPO, "weird(dir")`: the masked count resolves it, the literal-bearing count desyncs |
 * | the enumeration loop scans `src` instead of `code` | 3: D4, C1, W1 | **1 of 58**: D4 only | this file's quoted fixtures |
 *
 * **Three of four held. Row 4 was wrong, and why it was wrong is the whole
 * case for the structural rule.** C1 and W1 stayed green because the OTHER
 * two sites were still masked: with `repoRootIdents` reading the blanked
 * view no quoted fixture can bind a root, and with `firstArgument` counting
 * over it the brackets inside a fixture string are blank, so the argument
 * never balances and nothing resolves. Two correct sites cover behaviourally
 * for a third that has regressed.
 *
 * That is the `two deciders` shape read from the other end, and it is why
 * `src` being read-only inside `censusDirsRead` is now ASSERTED rather than
 * remembered. Three rounds of review found the same defect in three
 * different places; a behavioural suite could only ever have caught the last
 * one standing.
 *
 * **Rows 4 and 5 are the pair, and only the pair is evidence.** The same
 * planted file sits at `test/unit/zz-planted-census.test.ts` in both. With
 * the recursive walk the completeness case is RED and names it; with the
 * flat walk the completeness case is GREEN and the file's name appears
 * nowhere in the run. A single red row would not have separated the
 * recursion from anything else that might have reddened it.
 *
 * Row 3 is the one the issue asks for by name and the only one that measures
 * the DERIVATION rather than a row: a hand-maintained list of census suites
 * is green under it, because the planted file is in nobody's list.
 *
 * None of the mutations is left in the tree; all were run and reverted, and
 * the three files were confirmed byte-identical to the measured source
 * afterwards.
 *
 * Case labels, since four of the nine are controls:
 *
 *   W1  "every suite that censuses the test population is routed by the row …"
 *   W2  "the suites this issue reported are each in the derived population"
 *   W3  "adding a test file routes the suite that caught #1286"
 *   W4  "an edit to a config/ registry routes the suites that read it"
 *   D1  "a directory bound to an identifier is read, not only an inline join"
 *   D2  "the population reaches suites in subdirectories of test/"
 *   X1  "every monotone exclusion is still in the population"
 *   C1  "a fixture-driven suite is not in the population"
 *   C2  "a change outside config/ does not route the registry suites"
 *   C3  "the walk admits no fixture project's own test files"
 */
describe("#1547: the routed set is complete over the census of the test population", () => {
  /**
   * Suites that enumerate `test/` and CANNOT be reddened by adding a file to
   * it, with the reason per suite — the finding this issue asks for stated
   * rather than suppressed.
   *
   * All three share one structural reason rather than three opinions: their
   * assertion over the population is a LOWER BOUND, so a new file moves it in
   * the safe direction and only a DELETION can refuse. That is a property of
   * the assertion, checkable by reading it, not a measurement that ages.
   */
  const MONOTONE_OVER_TEST_POPULATION: Record<string, string> = {
    "test/ai-review-surface-census.test.ts":
      "its two tree cases are `titles present at the base commit and absent now` and `the " +
      "surface is strictly larger than it was` — both refuse a REMOVAL. A new file only adds " +
      "titles and only raises the count, so no addition can redden it.",
    "test/sc-coverage-claims.test.ts":
      "its scan of test/ is the vacuity guard `total coverage claims > 150`, a lower bound. " +
      "The input that reddens this suite is a criterion id mentioned without a claim form, " +
      "which is a property of the id and not of the population.",
    "test/scaffold-generators.test.ts":
      "its scan of test/ asserts `at least 3 test files reference ProjectScan`, a lower " +
      "bound. Adding a file can only raise that count; the suite's subject is the generator " +
      "module, and the scan is a coverage floor over it.",
  };

  /** Repo-relative paths the `new-test-file` row routes for a new test file. */
  const routedByNewTestFile = () =>
    censusTestsFor(
      [change({ path: "test/zz-a-newly-added-suite.test.ts", isNew: true, added: ["x"] })],
      p => existsSync(join(REPO, p)),
    ).tests;

  // W1. THE WITNESS, and the whole issue. Red before the fix naming
  // `scratch-cleanup`, `consumer-no-rebuild-delegation` and
  // `ai-review-runner-shell-parity` — the first reported, the other two found
  // by sweeping the derived population.
  test("every suite that censuses the test population is routed by the row for adding one", () => {
    const population = testPopulationCensusSuites(REPO);
    const routed = routedByNewTestFile();
    const unrouted = population.filter(
      p => !routed.includes(p) && !(p in MONOTONE_OVER_TEST_POPULATION),
    );
    expect(
      unrouted,
      "these suites read the test/ population from the tree, so adding a test file can " +
        "redden them, and no CENSUS_TRIGGERS row routes them for that event — which is " +
        "#1286 exactly. Either add the suite to the `new-test-file` row in " +
        "scripts/census-routing.ts (and regenerate the table in " +
        ".claude/rules/self-referential-tests.md), or — if adding a file cannot redden it — " +
        "add it to MONOTONE_OVER_TEST_POPULATION here with the assertion that makes it " +
        `monotone:\n${unrouted.join("\n")}`,
    ).toEqual([]);
  });

  // Non-vacuity for W1, which compares two lists and is satisfied by an empty
  // population. The derivation silently returning nothing is the failure mode
  // a derived list has and a hand list does not.
  test("the derived population is real, and larger than the exclusions", () => {
    const population = testPopulationCensusSuites(REPO);
    expect(
      population.length,
      "no suite in test/ was derived as censusing the test population — censusDirsRead has " +
        "stopped reading, and W1 above is comparing two empty lists",
    ).toBeGreaterThan(Object.keys(MONOTONE_OVER_TEST_POPULATION).length);
    expect(
      routedByNewTestFile().length,
      "the new-test-file row routes nothing, so W1 is vacuous from the other side",
    ).toBeGreaterThan(0);
  });

  // W2. The suites this issue, its comment and the AI review name, asserted
  // to be IN the derived population. Without this, a predicate that happens
  // to exclude them makes W1 green while the reported defect stands — which
  // is exactly how the non-recursive walk below hid one of them.
  test("the suites this issue reported are each in the derived population", () => {
    const population = testPopulationCensusSuites(REPO);
    for (const t of [
      "test/scratch-cleanup.test.ts",
      "test/consumer-no-rebuild-delegation.test.ts",
      "test/ai-review-runner-shell-parity.test.ts",
      "test/unit/ambiguous-anchor.test.ts",
    ]) {
      expect(
        population,
        `${t} reads the test/ population from the tree and the derived predicate does not ` +
          "see it, so this check cannot catch the defect it was written for",
      ).toContain(t);
    }
  });

  // D2. The walk's depth, which the first cut of this check got wrong.
  //
  // `testPopulationCensusSuites` read only the top level of `test/`, so every
  // suite under `test/unit/` was invisible to the population and the
  // completeness case went GREEN HAVING WITNESSED NOTHING for all of them.
  // The same shape as the `[^,)]+` truncation D1 guards — the population
  // silently shrinks until the survivors happen to be routed — arriving
  // through depth instead of parsing.
  //
  // Measured on this tree before the fix: 540 `.test.ts` at the top level and
  // 70 below it, of which exactly ONE satisfies the predicate. The prediction
  // was zero and is recorded wrong: a gap with a live member is a different
  // finding from a gap with none, and this one has a member.
  //
  // The ROUTING side was never blind — `new-test-file`'s `fires` is
  // `/^test\/.*\.test\.tsx?$/` and `.*` crosses a slash — so only the
  // derivation needed fixing. That asymmetry is why the defect was invisible:
  // the router would have run the suite, and the check that is supposed to
  // notice the suite was missing could not see it to ask.
  test("the population reaches suites in subdirectories of test/", () => {
    const population = testPopulationCensusSuites(REPO);
    const nested = population.filter(p => p.slice("test/".length).includes("/"));
    expect(
      nested,
      "no suite below the top level of test/ is in the population. test/unit/ holds 67 " +
        "suites and test/unit/ambiguous-anchor.test.ts scans test/ recursively for " +
        "structuralCut call sites, so the walk in testPopulationCensusSuites has stopped " +
        "descending and every census suite under a subdirectory is unseen",
    ).not.toEqual([]);
    expect(
      nested,
      "the live member this case was written for is no longer derived",
    ).toContain("test/unit/ambiguous-anchor.test.ts");
  });

  // C3. CONTROL on the widening a recursive walk buys. `test/fixtures/` holds
  // whole fixture PROJECTS, three of which carry their own `*.test.ts` under
  // a nested `test/` directory. Those were never candidates: they are input
  // data for a scaffold fixture, not suites this repository runs, and a
  // population that admits one would demand the router name it.
  //
  // Asserted as MEMBERSHIP, not as a total. A count is satisfied by any
  // substitution that preserves it, and the whole point of the recursion is
  // that the population grew.
  test("the walk admits no fixture project's own test files", () => {
    const population = testPopulationCensusSuites(REPO);
    const fixtures = population.filter(p => p.startsWith("test/fixtures/"));
    expect(
      fixtures,
      "a fixture project's own suite reached the population. These live under " +
        "test/fixtures/<project>/test/ and are data, not suites this repository runs, so " +
        "the router must not be asked to name them",
      ).toEqual([]);
    // Non-vacuity: those files really are on disk and really are `.test.ts`,
    // so the empty list above is a refusal and not a walk that found nothing.
    expect(
      existsSync(join(REPO, "test/fixtures/golden-project/test/index.test.ts")),
      "the fixture suite this control is about was moved, so it guards nothing",
    ).toBe(true);
  });

  // W3. The event, end to end, at the router's own interface — the thing an
  // agent running `bun scripts/census-routing.ts` actually gets.
  test("adding a test file routes the suite that caught #1286", () => {
    const routed = routedByNewTestFile();
    expect(
      routed,
      "adding a test file does not route test/scratch-cleanup.test.ts — this is #1286 " +
        "again, and PR #1537 shipped a red shard on exactly this diff",
    ).toContain("test/scratch-cleanup.test.ts");
    expect(
      routed,
      "adding a test file does not route test/consumer-no-rebuild-delegation.test.ts, " +
        "whose SCANNED_FILES list refuses any consumer-* file on disk that it lacks",
    ).toContain("test/consumer-no-rebuild-delegation.test.ts");
  });

  // X1. The stale-carve-out guard, the same discipline
  // `CARVED_IDENT_DIVERGENCES` applies in test/scratch-cleanup.test.ts: an
  // exclusion nobody needs is a hole nobody can see.
  test("every monotone exclusion is still in the population, and says why", () => {
    const population = testPopulationCensusSuites(REPO);
    const stale = Object.keys(MONOTONE_OVER_TEST_POPULATION).filter(
      f => !population.includes(f),
    );
    expect(
      stale,
      "this suite no longer censuses the test population, so its exclusion exempts nothing " +
        `and must be deleted rather than left standing:\n${stale.join("\n")}`,
    ).toEqual([]);
    for (const [f, why] of Object.entries(MONOTONE_OVER_TEST_POPULATION)) {
      expect(existsSync(join(REPO, f)), `${f} was renamed away`).toBe(true);
      // The WARN_TIER_CHECKS bar. A reason short enough to be a label is a
      // reason nobody had to establish.
      expect(why.length, `the exclusion reason for ${f} is too short to be one`).toBeGreaterThan(
        80,
      );
    }
  });

  // D1. The instrument's control, and the mutation that would have made this
  // whole check green while witnessing nothing. `readdirSync(join(REPO,
  // "test"))` read with a `[^,)]+` argument capture truncates to `join(REPO`
  // and resolves to nothing — which drops every suite that does not spell its
  // directory inline, including two of the three this issue is about.
  test("a directory bound to an identifier is read, not only an inline join", () => {
    const inline = 'const REPO = join(import.meta.dir, "..");\nreaddirSync(join(REPO, "test"));\n';
    const bound =
      'const REPO = join(import.meta.dir, "..");\nconst TEST_DIR = join(REPO, "test");\n' +
      "readdirSync(TEST_DIR);\n";
    expect(censusDirsRead(inline), "an inline join is not resolved").toContain("test");
    expect(censusDirsRead(bound), "a directory bound to an identifier is not resolved").toContain(
      "test",
    );
    // The repo root itself, reached through a navigation literal, is the root
    // and not a directory named `..`.
    expect(
      censusDirsRead('const R = join(import.meta.dir, "..");\nreaddirSync(R);\n'),
      "a navigation literal was read as a directory name",
    ).toEqual([""]);
  });

  // D3. The regex-vs-division heuristic, and the second decider this check
  // had no business owning. Found by the AI review on PR #1556.
  //
  // A `/` after a keyword — `return /["']/.test(c)` — opens a regex, and a
  // heuristic that looks only at the single previous CHARACTER sees `n` and
  // calls it division. The quotes inside the pattern then go live, the `"`
  // opens a string that runs to the next `"` anywhere below, and every
  // enumeration in between is read as quoted text. The suite drops out of the
  // population and W1 cannot flag what it cannot see.
  //
  // The first cut's docblock argued this direction was SAFE — "treating a
  // regex as division leaves its quotes live and can only ADD files to the
  // population". That is recorded wrong here rather than deleted: it holds
  // only for a pattern with balanced quotes. `["']` carries one of each, so
  // the miscount REMOVES files, which is the silent direction.
  //
  // `lib/strip-js-comments.ts` already decides this, keyword-aware, and is
  // already imported by `censusDirsRead` — #905 is the issue that put the
  // keyword set there. So the fix is not a wider local heuristic; it is
  // having one decider instead of two, which is the shape this whole block
  // is about.
  test("a regex literal after a keyword does not swallow the census below it", () => {
    const fixture =
      'function isQuoteChar(c) { return /["\']/.test(c); }\n' +
      'const REPO = join(import.meta.dir, "..");\n' +
      'readdirSync(join(REPO, "test"));\n';
    expect(
      censusDirsRead(fixture),
      "a regex after `return` was read as division, so its quote opened a string " +
        "that swallowed the enumeration below it",
    ).toContain("test");

    // Every keyword the shared decider accepts, derived from its own source
    // rather than hand-listed — a list written here is a second decider in
    // exactly the way this case exists to refuse, and it goes stale silently
    // when the set below it grows.
    const lib = readFileSync(join(REPO, "lib", "strip-js-comments.ts"), "utf-8");
    const set = lib.match(/REGEX_ALLOWED_AFTER_WORD = new Set\(\[([\s\S]*?)\]\)/);
    expect(set, "the shared keyword set could not be read, so this case tests nothing").not.toBe(
      null,
    );
    const keywords = [...(set![1] ?? "").matchAll(/"([a-z]+)"/g)].map(m => m[1]!);
    expect(keywords.length, "no keywords were read out of the shared set").toBeGreaterThan(10);
    const missed = keywords.filter(
      k =>
        !censusDirsRead(
          `const x = ${k} /["']/.test(c);\n` +
            'const REPO = join(import.meta.dir, "..");\n' +
            'readdirSync(join(REPO, "test"));\n',
        ).includes("test"),
    );
    expect(missed, "a regex after these keywords was misread as division").toEqual([]);

    // CONTROL, and the reason the heuristic exists at all: a real division
    // must NOT be read as a regex. `a / b` followed by an enumeration still
    // resolves, and a lone `/` does not consume the rest of the file.
    expect(
      censusDirsRead(
        'const ratio = width / height;\nconst REPO = join(import.meta.dir, "..");\n' +
          'readdirSync(join(REPO, "test"));\n',
      ),
      "a division was read as a regex literal and consumed the enumeration",
    ).toContain("test");
  });

  // D4. ONE DECIDER. D3 above is behavioural and a local heuristic wide
  // enough to pass it would satisfy every case in this file — two deciders
  // that agree, which no behavioural test can tell apart
  // (`.claude/rules/checks-must-be-able-to-fail.md`, fourth shape). So this
  // asserts the structural property instead: the router owns no
  // regex-vs-division rule of its own.
  // Read with COMMENTS STRIPPED, and that is the whole of what round 3 of
  // the battery taught. The first cut asserted `src.includes("blankLiterals")`
  // over the raw file, and the docblock above the call says the word — so
  // deleting the call left the assertion green. A check satisfied by a
  // comment saying the thing was done is #1322's shape, and the prediction
  // for that battery row was 4 fails against a measured 3. Recorded wrong
  // rather than edited; the missing row is what found this.
  test("the router carries no second regex-vs-division heuristic", () => {
    const raw = readFileSync(join(REPO, "scripts", "census-routing.ts"), "utf-8");
    const src = stripJsComments(raw);
    expect(
      /stripJsComments\(\s*source\s*,\s*\{\s*blankLiterals:\s*true\s*\}\s*\)/.test(src),
      "censusDirsRead no longer masks literals through lib/strip-js-comments.ts",
    ).toBe(true);
    // The control on the line above: it must be the CALL that satisfies it,
    // not the prose about the call.
    expect(
      /stripJsComments\(\s*source\s*,\s*\{\s*blankLiterals:\s*true\s*\}\s*\)/.test(
        raw.slice(0, raw.indexOf("export function censusDirsRead")),
      ),
      "the assertion above is being satisfied by text before the function",
    ).toBe(false);
    const local = ["REGEX_MAY_FOLLOW", "function stringMask"].filter(s => src.includes(s));
    expect(
      local,
      "a local literal/regex heuristic is back in scripts/census-routing.ts — " +
        "lib/strip-js-comments.ts is the one decider, and a second one that agrees " +
        "with it today survives any mutation of it",
    ).toEqual([]);

    // THE RULE THAT WOULD HAVE CAUGHT ALL THREE. Three separate rounds of
    // review found the same defect — a site SCANNING the literal-bearing
    // view when it wanted the masked one — in three different places
    // (`stringMask`, `repoRootIdents`, `firstArgument`). Fixing each one
    // individually leaves the fourth to be found by a fourth review, so the
    // property is asserted instead of remembered:
    //
    //   inside `censusDirsRead`, `src` is READ FROM and never SCANNED.
    //
    // Every match, count and traversal goes over `code`; `src` appears only
    // in its own declaration and in `.slice(…)`, which is the one operation
    // that needs the literals intact.
    const body = src.slice(
      src.indexOf("export function censusDirsRead"),
      src.indexOf("\n}", src.indexOf("export function censusDirsRead")),
    );
    expect(body.length, "the function body could not be located, so this asserts nothing").
      toBeGreaterThan(200);
    const scanned = [...body.matchAll(/\bsrc\b\s*(\.\w+|\))?/g)]
      .map(m => m[0].trim())
      .filter(use => use !== "src.slice" && use !== "src");
    expect(
      scanned,
      "`src` is being scanned rather than sliced inside censusDirsRead — the " +
        "literal-bearing view counts a bracket or a quote inside a string as code, " +
        "which is the defect three separate review rounds found in three places",
    ).toEqual([]);
    expect(
      /firstArgument\(\s*code\s*,\s*src\s*,/.test(body),
      "firstArgument is no longer counting over the masked view",
    ).toBe(true);
  });

  // D5. The same blindness, at the one site the D3 fix did not cover —
  // found by applying the round-2 instruction ("check whether the same
  // blindness is anywhere else") to the round-3 fix rather than to the
  // original code.
  //
  // `censusDirsRead` resolves which identifiers name the repo root through
  // `repoRootIdents`, and that was still reading the view with literals
  // INTACT. `import.meta.dir` is a code token, so it survives inside a
  // quoted fixture, and a root could be manufactured out of string contents
  // alone. Measured before the fix: the source below returned `[""]` — a
  // census over the repository root asserted by a file that enumerates a
  // string.
  //
  // That is the ADDING direction, which is the loud one: it would have put
  // a file into the population, W1 would have demanded the router name it,
  // and somebody would have gone looking. Worth fixing anyway — a predicate
  // that is wrong in the safe direction is still wrong, and C1 is the only
  // thing standing between this shape and the population.
  test("a repo root bound only inside a string literal is not a root", () => {
    const fixture =
      `const FIXTURE = 'const ROOT = join(import.meta.dir, "..");';\n` + "readdirSync(FIXTURE);\n";
    // The fixture's own premise, asserted rather than assumed: it really
    // does carry a root binding inside a literal and an enumeration outside
    // one. A fixture that lost either through escaping would pass by
    // testing nothing.
    expect(/'[^']*import\.meta\.dir/.test(fixture), "the fixture lost its quoted root").toBe(true);
    expect(/\nreaddirSync\(/.test(fixture), "the fixture lost its enumeration").toBe(true);
    expect(
      censusDirsRead(fixture),
      "an identifier was read as the repo root because a STRING mentioned " +
        "import.meta.dir, so quoted text manufactured a census",
    ).toEqual([]);
  });

  // D6. The third site reading the wrong view, found by the AI review on
  // PR #1556 after D3 and D5 fixed the other two.
  //
  // `firstArgument` balances brackets to find where the enumeration's first
  // argument ends. It was counting them over the literal-bearing view, so a
  // bracket inside a STRING counts as structure: the depth never returns to
  // zero at the statement's real end, the scan runs on into later source,
  // and the slice is garbage that `joinedDir` cannot match. The call then
  // resolves to nothing and the suite is invisible to W1 — the same quiet
  // false negative as the `[^,)]+` truncation D1 guards, arriving through
  // bracket counting instead.
  //
  // Measured before the fix, and the asymmetry is the tell that the scan was
  // unreliable rather than merely strict: `"weird(dir"` gave `[]` while
  // `"weird)dir"` happened to give the right answer.
  //
  // SCOPE, measured rather than assumed: the desync costs the ONE call, not
  // the file. Each match is scanned from its own opening bracket, so a
  // bracket literal above a real census read does not hide it — the last
  // assertion holds that, because "the whole file goes dark" and "one call
  // goes dark" are different defects and only one of them is this.
  test("a bracket inside a string literal is not counted as structure", () => {
    const census = (seg: string) =>
      censusDirsRead(`const REPO = join(import.meta.dir, "..");\nreaddirSync(join(REPO, "${seg}"));\n`);
    expect(census("test"), "the balanced control stopped resolving").toEqual(["test"]);
    expect(
      census("weird(dir"),
      "an unmatched ( inside a path segment desynced the bracket scan, so a " +
        "genuine enumeration resolved to nothing",
    ).toEqual(["weird(dir"]);
    expect(census("weird)dir"), "an unmatched ) inside a path segment").toEqual(["weird)dir"]);
    expect(census("a[b"), "an unmatched [ inside a path segment").toEqual(["a[b"]);
    expect(census("a{b"), "an unmatched { inside a path segment").toEqual(["a{b"]);
    // The blast radius, asserted: a poisoned call above a real one.
    expect(
      censusDirsRead(
        'const REPO = join(import.meta.dir, "..");\n' +
          'readdirSync(join(REPO, "weird(dir"));\nreaddirSync(join(REPO, "test"));\n',
      ),
      "a bracket literal in one call hid a census read below it",
    ).toContain("test");
  });

  // C1. CONTROL. Without it the predicate could return every file in test/,
  // W1 would demand the router name all of them, and the remedy would be the
  // "router that names everything" this table is built to avoid.
  test("a fixture-driven suite is not in the population", () => {
    const fixture =
      'const root = mkdtempSync(join(tmpdir(), "rg-"));\nreaddirSync(join(root, "test"));\n';
    expect(
      censusDirsRead(fixture),
      "a scan of a mkdtemp fixture was read as a census over the repository",
    ).toEqual([]);
    // And the live tree: most of test/ reads a named file from the root and
    // is NOT a census. A population equal to the directory is a predicate
    // that decided nothing.
    const all = readFileSync(join(REPO, "test", "census-routing.test.ts"), "utf-8");
    expect(
      censusDirsRead(all),
      "this file reads one named document and enumerates nothing, so it is not a census",
    ).toEqual([]);
  });

  // W4. The second direction, routed explicitly. Both targets were MEASURED
  // rather than grepped: `config/check-registry.json` with one entry removed
  // reddens `check-registry` (3 cases, "#339: every named check resolves"),
  // and `config/matcher-registry.json` with its last element spliced off
  // reddens `matcher-registry-parity` and nothing else. An earlier mutation
  // that `delete`d an array index reported four files and was discarded — it
  // left a `null` hole, so it measured a corrupt registry rather than a
  // moved agreement.
  test("an edit to a config/ registry routes the suites that read it", () => {
    const { tests, fired } = censusTestsFor([
      change({ path: "config/check-registry.json", added: ['    "zz-check": {}'] }),
    ]);
    for (const t of ["test/check-registry.test.ts", "test/matcher-registry-parity.test.ts"]) {
      expect(
        tests,
        `an edit to config/ did not route ${t} — this is #1540's comment again, where the ` +
          "router named no row at all for a config/ schema edit",
      ).toContain(t);
    }
    expect(
      fired.map(f => f.trigger.id),
      "the config-registry row did not fire on the diff it was written for",
    ).toContain("config-registry");
    // The EDIT is the case. A newly added config/ file already picked up
    // `scaffold-conformity` and `package-closure` incidentally through
    // `new-file`, and neither is about registry agreement — so a row scoped
    // to `isNew` would leave the reported defect exactly where it was.
    expect(
      censusTestsFor([change({ path: "config/spec-policies.json", added: ["x"] })]).fired.map(
        f => f.trigger.id,
      ),
      "the row only fires on a new file, which is not the case this issue reports",
    ).toContain("config-registry");
  });

  // C2. CONTROL against a row that fires on everything, and against the
  // substring reading: `lib/config-loader.ts` is not `config/`.
  test("a change outside config/ does not route the registry suites", () => {
    for (const path of ["lib/config-loader.ts", "test/config-single-layout.test.ts"]) {
      const { tests, fired } = censusTestsFor([change({ path, added: ["export const a = 1;"] })]);
      expect(
        fired.map(f => f.trigger.id),
        `${path} fired the config-registry row, but it is not in config/`,
      ).not.toContain("config-registry");
      expect(tests, `${path} routed the registry census`).not.toContain(
        "test/check-registry.test.ts",
      );
    }
  });
});
